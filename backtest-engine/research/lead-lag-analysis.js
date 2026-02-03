#!/usr/bin/env node
/**
 * Lead-Lag Analysis - Phase 2.2
 *
 * Tests if indicators predict future price moves at various lags:
 * - IV changes → Price returns
 * - Liquidity level shifts → Price returns
 * - GEX regime → Price direction
 * - IV skew → Price direction
 *
 * Input: unified_15m_2025_features.csv
 * Output: lead_lag_results.json, lead_lag_report.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_FILE = path.join(__dirname, 'output', 'unified_15m_2025_features.csv');
const OUTPUT_JSON = path.join(__dirname, 'output', 'lead_lag_results.json');
const OUTPUT_REPORT = path.join(__dirname, 'output', 'lead_lag_report.md');

// Lags to test (in 15-min periods)
const LAGS = [1, 2, 4, 8, 16];  // 15m, 30m, 1h, 2h, 4h

// Predictors to test
const PREDICTORS = [
  'iv_change_15m',
  'iv_skew',
  'iv_percentile_all',
  'liq_momentum',
  'liq_max_change',
  'liq_sentiment_encoded',
  'gex_regime_encoded',
  'total_gex',
  'gex_dist_gamma_flip'
];

// Target variables
const TARGETS = [
  'price_return_15m',
  'price_range_15m',
  'price_volatility_1h'
];

class LeadLagAnalyzer {
  constructor() {
    this.data = [];
    this.results = {
      correlations: [],
      bestLags: {},
      metadata: {}
    };
  }

  async run() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Lead-Lag Analysis - Phase 2.2');
    console.log('═══════════════════════════════════════════════════════════════\n');

    await this.loadData();
    this.computeLeadLagCorrelations();
    this.identifyBestLags();
    await this.exportResults();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Lead-Lag Analysis Complete!');
    console.log('═══════════════════════════════════════════════════════════════');
  }

  async loadData() {
    console.log('📂 Loading featured dataset...');

    return new Promise((resolve, reject) => {
      fs.createReadStream(INPUT_FILE)
        .pipe(csv())
        .on('data', (row) => {
          const record = {};
          for (const key of Object.keys(row)) {
            const val = row[key];
            record[key] = val === '' || val === 'null' ? null : parseFloat(val);
            if (isNaN(record[key])) record[key] = row[key];
          }
          this.data.push(record);
        })
        .on('end', () => {
          // Filter to RTH with complete data
          this.data = this.data.filter(r =>
            r.is_rth === 1 && r.iv !== null && r.total_gex !== null
          );
          console.log(`   ✅ Loaded ${this.data.length.toLocaleString()} RTH records`);
          resolve();
        })
        .on('error', reject);
    });
  }

  computeLeadLagCorrelations() {
    console.log('\n📊 Computing lead-lag correlations...');

    for (const predictor of PREDICTORS) {
      for (const target of TARGETS) {
        for (const lag of LAGS) {
          const result = this.computeCorrelationAtLag(predictor, target, lag);
          if (result) {
            this.results.correlations.push(result);
          }
        }
      }
    }

    console.log(`   ✅ Computed ${this.results.correlations.length} lead-lag correlations`);
  }

  computeCorrelationAtLag(predictor, target, lag) {
    // Extract paired values where predictor at time T predicts target at T+lag
    const pairs = [];

    for (let i = 0; i < this.data.length - lag; i++) {
      const predValue = this.data[i][predictor];
      const targetValue = this.data[i + lag][target];

      if (predValue !== null && targetValue !== null &&
          !isNaN(predValue) && !isNaN(targetValue)) {
        pairs.push([predValue, targetValue]);
      }
    }

    if (pairs.length < 100) return null;

    const x = pairs.map(p => p[0]);
    const y = pairs.map(p => p[1]);

    // Compute Pearson correlation
    const corr = this.pearsonCorrelation(x, y);

    // Compute Information Coefficient (IC) - basically same as Pearson for continuous
    const ic = corr.r;

    // Compute hit rate for directional predictions (if both are signed)
    const hitRate = this.computeHitRate(x, y);

    return {
      predictor,
      target,
      lag,
      lagMinutes: lag * 15,
      correlation: corr.r,
      pValue: corr.pValue,
      ic,
      hitRate,
      n: pairs.length,
      significant: corr.pValue < 0.05 && Math.abs(corr.r) > 0.05
    };
  }

  pearsonCorrelation(x, y) {
    const n = x.length;
    if (n < 3) return { r: null, pValue: 1 };

    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      denomX += dx * dx;
      denomY += dy * dy;
    }

    const r = numerator / Math.sqrt(denomX * denomY);
    const t = r * Math.sqrt((n - 2) / (1 - r * r));
    const pValue = this.tDistributionPValue(Math.abs(t), n - 2);

    return { r: isNaN(r) ? null : r, pValue };
  }

  tDistributionPValue(t, df) {
    if (df <= 0) return 1;
    const pValue = Math.exp(-0.5 * t * t) * Math.sqrt(2 / Math.PI) / Math.abs(t);
    return Math.min(1, Math.max(0, pValue * 2));
  }

  computeHitRate(x, y) {
    // Compute hit rate: % of times sign of x matches sign of y
    let hits = 0;
    let total = 0;

    for (let i = 0; i < x.length; i++) {
      if (x[i] === 0 || y[i] === 0) continue;
      total++;
      if ((x[i] > 0 && y[i] > 0) || (x[i] < 0 && y[i] < 0)) {
        hits++;
      }
    }

    return total > 0 ? hits / total : null;
  }

  identifyBestLags() {
    console.log('\n🔍 Identifying optimal lags...');

    // Group by predictor-target pair
    const groups = {};

    for (const result of this.results.correlations) {
      const key = `${result.predictor}__${result.target}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(result);
    }

    // Find best lag for each pair
    for (const [key, results] of Object.entries(groups)) {
      // Find the lag with strongest significant correlation
      const significant = results.filter(r => r.significant);
      if (significant.length === 0) continue;

      const best = significant.reduce((a, b) =>
        Math.abs(b.correlation) > Math.abs(a.correlation) ? b : a
      );

      this.results.bestLags[key] = {
        predictor: best.predictor,
        target: best.target,
        bestLag: best.lag,
        bestLagMinutes: best.lagMinutes,
        correlation: best.correlation,
        pValue: best.pValue,
        hitRate: best.hitRate,
        allLags: results.map(r => ({
          lag: r.lag,
          correlation: r.correlation,
          significant: r.significant
        }))
      };
    }

    console.log(`   ✅ Found ${Object.keys(this.results.bestLags).length} predictor-target pairs with predictive power`);
  }

  async exportResults() {
    console.log('\n💾 Exporting results...');

    this.results.metadata = {
      totalRecords: this.data.length,
      lagsTestedMinutes: LAGS.map(l => l * 15),
      predictors: PREDICTORS,
      targets: TARGETS,
      analysisDate: new Date().toISOString()
    };

    // Export JSON
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(this.results, null, 2));
    console.log(`   ✅ JSON results: ${OUTPUT_JSON}`);

    // Export report
    await this.exportReport();
  }

  async exportReport() {
    let report = `# Lead-Lag Analysis Report

**Generated**: ${new Date().toISOString()}
**Records Analyzed**: ${this.data.length.toLocaleString()} (RTH only)
**Lags Tested**: ${LAGS.map(l => `${l * 15}m`).join(', ')}

---

## Executive Summary

Tested ${PREDICTORS.length} predictors against ${TARGETS.length} target variables at ${LAGS.length} different lags.
Found **${Object.keys(this.results.bestLags).length} predictor-target pairs** with statistically significant predictive relationships.

---

## Key Predictive Relationships

| Predictor | Target | Best Lag | Correlation | Hit Rate | Interpretation |
|-----------|--------|----------|-------------|----------|----------------|
`;

    // Sort by absolute correlation
    const sortedBest = Object.values(this.results.bestLags)
      .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    for (const result of sortedBest.slice(0, 20)) {
      const interp = this.interpretResult(result);
      report += `| ${result.predictor} | ${result.target} | ${result.bestLagMinutes}m | ${result.correlation.toFixed(4)} | ${result.hitRate ? (result.hitRate * 100).toFixed(1) + '%' : 'N/A'} | ${interp} |\n`;
    }

    report += `
---

## Detailed Findings

### IV as Predictor of Price Movement
`;

    const ivPredictors = sortedBest.filter(r => r.predictor.startsWith('iv_'));
    if (ivPredictors.length > 0) {
      for (const r of ivPredictors) {
        report += `
**${r.predictor} → ${r.target}**
- Best lag: ${r.bestLagMinutes} minutes
- Correlation: ${r.correlation.toFixed(4)}
- Interpretation: ${this.interpretResult(r)}
`;
      }
    } else {
      report += '\nNo significant IV → price relationships found.\n';
    }

    report += `
### Liquidity as Predictor of Price Movement
`;

    const liqPredictors = sortedBest.filter(r => r.predictor.startsWith('liq_'));
    if (liqPredictors.length > 0) {
      for (const r of liqPredictors) {
        report += `
**${r.predictor} → ${r.target}**
- Best lag: ${r.bestLagMinutes} minutes
- Correlation: ${r.correlation.toFixed(4)}
- Interpretation: ${this.interpretResult(r)}
`;
      }
    } else {
      report += '\nNo significant liquidity → price relationships found.\n';
    }

    report += `
### GEX as Predictor of Price Movement
`;

    const gexPredictors = sortedBest.filter(r =>
      r.predictor.startsWith('gex_') || r.predictor === 'total_gex'
    );
    if (gexPredictors.length > 0) {
      for (const r of gexPredictors) {
        report += `
**${r.predictor} → ${r.target}**
- Best lag: ${r.bestLagMinutes} minutes
- Correlation: ${r.correlation.toFixed(4)}
- Interpretation: ${this.interpretResult(r)}
`;
      }
    } else {
      report += '\nNo significant GEX → price relationships found.\n';
    }

    report += `
---

## Lag Profile Analysis

Shows how correlation changes across different lags for key predictors:

`;

    // Show lag profiles for top predictors
    for (const result of sortedBest.slice(0, 5)) {
      report += `### ${result.predictor} → ${result.target}\n\n`;
      report += '| Lag | Correlation | Significant |\n';
      report += '|-----|-------------|-------------|\n';

      for (const lagResult of result.allLags) {
        report += `| ${lagResult.lag * 15}m | ${lagResult.correlation?.toFixed(4) || 'N/A'} | ${lagResult.significant ? '✓' : ''} |\n`;
      }
      report += '\n';
    }

    report += `
---

## Trading Implications

Based on the lead-lag analysis:

`;

    // Generate trading implications
    const implications = this.generateImplications(sortedBest);
    for (const imp of implications) {
      report += `- ${imp}\n`;
    }

    report += `
---

## Methodology

- **Lead-Lag Correlation**: Pearson correlation between predictor at time T and target at time T+lag
- **Hit Rate**: Percentage of times the sign of the predictor matches the sign of the future target
- **Significance Threshold**: p < 0.05 and |r| > 0.05
- **Data**: RTH (Regular Trading Hours) records with complete GEX and IV data

---

*Report generated by lead-lag-analysis.js*
`;

    fs.writeFileSync(OUTPUT_REPORT, report);
    console.log(`   ✅ Markdown report: ${OUTPUT_REPORT}`);
  }

  interpretResult(result) {
    const direction = result.correlation > 0 ? 'positive' : 'negative';
    const strength = Math.abs(result.correlation) > 0.2 ? 'moderate' : 'weak';

    if (result.predictor.includes('iv') && result.target.includes('return')) {
      if (result.correlation > 0) {
        return `Higher IV change predicts higher returns ${result.bestLagMinutes}m later`;
      } else {
        return `Higher IV change predicts lower returns ${result.bestLagMinutes}m later`;
      }
    }

    if (result.predictor.includes('liq') && result.target.includes('return')) {
      if (result.correlation > 0) {
        return `Positive liquidity shift predicts positive returns`;
      } else {
        return `Positive liquidity shift predicts negative returns`;
      }
    }

    if (result.predictor.includes('gex') && result.target.includes('return')) {
      if (result.correlation > 0) {
        return `Positive GEX predicts upward price movement`;
      } else {
        return `Positive GEX predicts downward price movement (mean reversion)`;
      }
    }

    if (result.target.includes('volatility') || result.target.includes('range')) {
      if (result.correlation > 0) {
        return `Higher ${result.predictor.replace(/_/g, ' ')} predicts higher volatility`;
      } else {
        return `Higher ${result.predictor.replace(/_/g, ' ')} predicts lower volatility`;
      }
    }

    return `${strength} ${direction} predictive relationship`;
  }

  generateImplications(sortedBest) {
    const implications = [];

    // Check for IV predictors
    const ivReturn = sortedBest.find(r =>
      r.predictor.includes('iv') && r.target.includes('return_15m')
    );
    if (ivReturn) {
      if (ivReturn.correlation < 0) {
        implications.push(`**IV Expansion → Price Decline**: IV increases tend to precede price declines by ${ivReturn.bestLagMinutes} minutes. Consider this for timing short entries.`);
      } else {
        implications.push(`**IV Expansion → Price Rise**: IV increases tend to precede price rises by ${ivReturn.bestLagMinutes} minutes.`);
      }
    }

    // Check for liquidity predictors
    const liqReturn = sortedBest.find(r =>
      r.predictor === 'liq_sentiment_encoded' && r.target.includes('return')
    );
    if (liqReturn) {
      implications.push(`**Liquidity Sentiment**: BULLISH liquidity sentiment has a ${liqReturn.correlation > 0 ? 'positive' : 'negative'} predictive relationship with price returns at ${liqReturn.bestLagMinutes}m lag.`);
    }

    // Check for GEX predictors
    const gexReturn = sortedBest.find(r =>
      r.predictor === 'gex_regime_encoded' && r.target.includes('return')
    );
    if (gexReturn) {
      implications.push(`**GEX Regime**: ${gexReturn.correlation > 0 ? 'Positive GEX regimes favor bullish trades' : 'Positive GEX regimes may indicate mean reversion opportunities'}.`);
    }

    // Check for volatility predictors
    const volPredictor = sortedBest.find(r => r.target.includes('volatility'));
    if (volPredictor) {
      implications.push(`**Volatility Prediction**: ${volPredictor.predictor.replace(/_/g, ' ')} can predict future volatility with ${volPredictor.bestLagMinutes}m lead time.`);
    }

    if (implications.length === 0) {
      implications.push('No strong trading implications identified from lead-lag relationships.');
    }

    return implications;
  }
}

// Run
const analyzer = new LeadLagAnalyzer();
analyzer.run().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
