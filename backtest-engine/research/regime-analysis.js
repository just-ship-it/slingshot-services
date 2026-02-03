#!/usr/bin/env node
/**
 * Regime Analysis - Phase 4
 *
 * Classifies market conditions into composite regimes and analyzes performance:
 * - IV Regime: High (>50th percentile) / Low
 * - GEX Regime: Positive / Negative
 * - Liquidity Regime: Bullish / Bearish
 *
 * Creates 8 composite states and measures returns, volatility, mean reversion
 *
 * Input: unified_15m_2025_features.csv
 * Output: regime_analysis_results.json, regime_analysis_report.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_FILE = path.join(__dirname, 'output', 'unified_15m_2025_features.csv');
const OUTPUT_JSON = path.join(__dirname, 'output', 'regime_analysis_results.json');
const OUTPUT_REPORT = path.join(__dirname, 'output', 'regime_analysis_report.md');

class RegimeAnalyzer {
  constructor() {
    this.data = [];
    this.results = {
      regimes: {},
      transitions: {},
      optimalStrategies: {},
      metadata: {}
    };
  }

  async run() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Regime Analysis - Phase 4');
    console.log('═══════════════════════════════════════════════════════════════\n');

    await this.loadData();
    this.classifyRegimes();
    this.analyzeRegimePerformance();
    this.analyzeRegimeTransitions();
    this.identifyOptimalStrategies();
    await this.exportResults();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Regime Analysis Complete!');
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
            r.is_rth === 1 && r.iv !== null && r.total_gex !== null && r.liq_sentiment !== null
          );
          console.log(`   ✅ Loaded ${this.data.length.toLocaleString()} complete RTH records`);
          resolve();
        })
        .on('error', reject);
    });
  }

  classifyRegimes() {
    console.log('\n📊 Classifying market regimes...');

    // Calculate IV median for high/low classification
    const ivValues = this.data.map(r => r.iv).sort((a, b) => a - b);
    const ivMedian = ivValues[Math.floor(ivValues.length / 2)];
    console.log(`   IV median: ${ivMedian.toFixed(4)}`);

    // Classify each record
    for (let i = 0; i < this.data.length; i++) {
      const record = this.data[i];

      // IV Regime
      const ivRegime = record.iv > ivMedian ? 'HIGH_IV' : 'LOW_IV';

      // GEX Regime (using encoded value: positive values = positive regime)
      const gexRegime = record.gex_regime_encoded > 0 ? 'POS_GEX' : 'NEG_GEX';

      // Liquidity Regime
      const liqRegime = record.liq_sentiment === 'BULLISH' ? 'BULL_LIQ' : 'BEAR_LIQ';

      // Composite regime
      record.composite_regime = `${ivRegime}|${gexRegime}|${liqRegime}`;
      record.iv_regime = ivRegime;
      record.gex_regime_binary = gexRegime;
      record.liq_regime = liqRegime;

      // Calculate forward returns for this record
      if (i < this.data.length - 4) {
        record.fwd_return_1h = (this.data[i + 4].close - record.close) / record.close * 100;
      }
      if (i < this.data.length - 16) {
        record.fwd_return_4h = (this.data[i + 16].close - record.close) / record.close * 100;
      }
    }

    // Count regime distribution
    const regimeCounts = {};
    for (const record of this.data) {
      const regime = record.composite_regime;
      regimeCounts[regime] = (regimeCounts[regime] || 0) + 1;
    }

    console.log('\n   Regime Distribution:');
    for (const [regime, count] of Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])) {
      const pct = (count / this.data.length * 100).toFixed(1);
      console.log(`   ${regime}: ${count} (${pct}%)`);
    }
  }

  analyzeRegimePerformance() {
    console.log('\n📈 Analyzing regime performance...');

    // Group records by regime
    const regimeGroups = {};
    for (const record of this.data) {
      const regime = record.composite_regime;
      if (!regimeGroups[regime]) regimeGroups[regime] = [];
      regimeGroups[regime].push(record);
    }

    // Analyze each regime
    for (const [regime, records] of Object.entries(regimeGroups)) {
      const returns15m = records.map(r => r.price_return_15m).filter(r => r !== null);
      const returns1h = records.map(r => r.fwd_return_1h).filter(r => r !== null);
      const returns4h = records.map(r => r.fwd_return_4h).filter(r => r !== null);
      const volatility = records.map(r => r.price_volatility_1h).filter(r => r !== null);
      const ranges = records.map(r => r.price_range_15m).filter(r => r !== null);

      // Calculate mean reversion metric (autocorrelation of returns)
      const autocorr = this.calculateAutocorrelation(returns15m);

      this.results.regimes[regime] = {
        count: records.length,
        frequency: records.length / this.data.length,
        returns: {
          '15m': this.calculateStats(returns15m),
          '1h': this.calculateStats(returns1h),
          '4h': this.calculateStats(returns4h)
        },
        volatility: this.calculateStats(volatility),
        range: this.calculateStats(ranges),
        autocorrelation: autocorr,
        meanReversionStrength: autocorr < 0 ? Math.abs(autocorr) : 0,
        trendStrength: autocorr > 0 ? autocorr : 0
      };
    }

    console.log(`   ✅ Analyzed ${Object.keys(this.results.regimes).length} regimes`);
  }

  calculateStats(values) {
    if (values.length === 0) return null;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const std = Math.sqrt(variance);

    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    const positive = values.filter(v => v > 0).length;
    const winRate = positive / values.length;

    // Sharpe-like ratio (mean / std)
    const sharpe = std > 0 ? mean / std : 0;

    return {
      mean,
      median,
      std,
      min: Math.min(...values),
      max: Math.max(...values),
      winRate,
      sharpe,
      n: values.length
    };
  }

  calculateAutocorrelation(values) {
    if (values.length < 10) return null;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    let numerator = 0;
    let denominator = 0;

    for (let i = 1; i < values.length; i++) {
      numerator += (values[i] - mean) * (values[i - 1] - mean);
    }

    for (let i = 0; i < values.length; i++) {
      denominator += Math.pow(values[i] - mean, 2);
    }

    return denominator > 0 ? numerator / denominator : 0;
  }

  analyzeRegimeTransitions() {
    console.log('\n🔄 Analyzing regime transitions...');

    const transitions = {};

    for (let i = 1; i < this.data.length; i++) {
      const prevRegime = this.data[i - 1].composite_regime;
      const currRegime = this.data[i].composite_regime;

      if (prevRegime !== currRegime) {
        const key = `${prevRegime} → ${currRegime}`;
        if (!transitions[key]) {
          transitions[key] = {
            count: 0,
            fwdReturns1h: []
          };
        }
        transitions[key].count++;

        if (this.data[i].fwd_return_1h !== null) {
          transitions[key].fwdReturns1h.push(this.data[i].fwd_return_1h);
        }
      }
    }

    // Calculate stats for each transition
    for (const [key, data] of Object.entries(transitions)) {
      if (data.fwdReturns1h.length > 0) {
        data.avgReturn1h = data.fwdReturns1h.reduce((a, b) => a + b, 0) / data.fwdReturns1h.length;
        data.winRate1h = data.fwdReturns1h.filter(r => r > 0).length / data.fwdReturns1h.length;
      }
      delete data.fwdReturns1h;  // Remove raw data
    }

    // Sort by count
    const sortedTransitions = Object.entries(transitions)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20);  // Top 20

    this.results.transitions = Object.fromEntries(sortedTransitions);
    console.log(`   ✅ Identified ${sortedTransitions.length} top regime transitions`);
  }

  identifyOptimalStrategies() {
    console.log('\n🎯 Identifying optimal strategies per regime...');

    for (const [regime, stats] of Object.entries(this.results.regimes)) {
      const strategy = {
        regime,
        recommendation: '',
        confidence: '',
        metrics: {}
      };

      const autocorr = stats.autocorrelation;
      const returns1h = stats.returns['1h'];
      const volatility = stats.volatility;

      // Determine strategy based on autocorrelation and returns
      if (autocorr !== null && autocorr < -0.1) {
        strategy.recommendation = 'MEAN_REVERSION';
        strategy.confidence = autocorr < -0.2 ? 'HIGH' : 'MEDIUM';
        strategy.metrics.meanReversionStrength = Math.abs(autocorr);
      } else if (autocorr !== null && autocorr > 0.1) {
        strategy.recommendation = 'TREND_FOLLOWING';
        strategy.confidence = autocorr > 0.2 ? 'HIGH' : 'MEDIUM';
        strategy.metrics.trendStrength = autocorr;
      } else {
        strategy.recommendation = 'NEUTRAL';
        strategy.confidence = 'LOW';
      }

      // Add directional bias
      if (returns1h && returns1h.mean > 0.02) {
        strategy.bias = 'BULLISH';
      } else if (returns1h && returns1h.mean < -0.02) {
        strategy.bias = 'BEARISH';
      } else {
        strategy.bias = 'NEUTRAL';
      }

      // Volatility assessment
      if (volatility && volatility.mean) {
        strategy.volatilityLevel = volatility.mean > 0.15 ? 'HIGH' : volatility.mean > 0.08 ? 'MEDIUM' : 'LOW';
      }

      // Win rate
      if (returns1h) {
        strategy.metrics.winRate1h = returns1h.winRate;
        strategy.metrics.avgReturn1h = returns1h.mean;
        strategy.metrics.sharpe1h = returns1h.sharpe;
      }

      this.results.optimalStrategies[regime] = strategy;
    }

    console.log(`   ✅ Generated strategy recommendations for ${Object.keys(this.results.optimalStrategies).length} regimes`);
  }

  async exportResults() {
    console.log('\n💾 Exporting results...');

    this.results.metadata = {
      totalRecords: this.data.length,
      regimeCount: Object.keys(this.results.regimes).length,
      analysisDate: new Date().toISOString()
    };

    // Export JSON
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(this.results, null, 2));
    console.log(`   ✅ JSON results: ${OUTPUT_JSON}`);

    // Export report
    await this.exportReport();
  }

  async exportReport() {
    let report = `# Regime Analysis Report

**Generated**: ${new Date().toISOString()}
**Records Analyzed**: ${this.data.length.toLocaleString()} (RTH with complete data)
**Composite Regimes**: ${Object.keys(this.results.regimes).length}

---

## Regime Classification

Markets are classified into 8 composite regimes based on three dimensions:
- **IV Regime**: HIGH_IV (>50th percentile) or LOW_IV
- **GEX Regime**: POS_GEX (positive gamma) or NEG_GEX (negative gamma)
- **Liquidity Regime**: BULL_LIQ (bullish sentiment) or BEAR_LIQ (bearish sentiment)

---

## Regime Performance Summary

| Regime | Freq | 1h Avg Return | 1h Win Rate | Volatility | Autocorr | Strategy |
|--------|------|--------------|-------------|------------|----------|----------|
`;

    // Sort regimes by frequency
    const sortedRegimes = Object.entries(this.results.regimes)
      .sort((a, b) => b[1].frequency - a[1].frequency);

    for (const [regime, stats] of sortedRegimes) {
      const strategy = this.results.optimalStrategies[regime];
      const returns1h = stats.returns['1h'];

      report += `| ${regime} | ${(stats.frequency * 100).toFixed(1)}% | ${returns1h?.mean?.toFixed(4) || 'N/A'}% | ${returns1h?.winRate ? (returns1h.winRate * 100).toFixed(1) + '%' : 'N/A'} | ${stats.volatility?.mean?.toFixed(4) || 'N/A'} | ${stats.autocorrelation?.toFixed(3) || 'N/A'} | ${strategy?.recommendation || 'N/A'} |\n`;
    }

    report += `
---

## Detailed Regime Analysis

`;

    for (const [regime, stats] of sortedRegimes) {
      const strategy = this.results.optimalStrategies[regime];
      const returns1h = stats.returns['1h'];
      const returns4h = stats.returns['4h'];

      report += `### ${regime}

**Frequency**: ${(stats.frequency * 100).toFixed(1)}% (${stats.count} observations)

**Returns**:
- 15m: Mean=${stats.returns['15m']?.mean?.toFixed(4) || 'N/A'}%, Win Rate=${stats.returns['15m']?.winRate ? (stats.returns['15m'].winRate * 100).toFixed(1) + '%' : 'N/A'}
- 1h: Mean=${returns1h?.mean?.toFixed(4) || 'N/A'}%, Win Rate=${returns1h?.winRate ? (returns1h.winRate * 100).toFixed(1) + '%' : 'N/A'}
- 4h: Mean=${returns4h?.mean?.toFixed(4) || 'N/A'}%, Win Rate=${returns4h?.winRate ? (returns4h.winRate * 100).toFixed(1) + '%' : 'N/A'}

**Volatility**: Mean=${stats.volatility?.mean?.toFixed(4) || 'N/A'}

**Market Dynamics**:
- Autocorrelation: ${stats.autocorrelation?.toFixed(3) || 'N/A'}
- Mean Reversion Strength: ${stats.meanReversionStrength?.toFixed(3) || 'N/A'}
- Trend Strength: ${stats.trendStrength?.toFixed(3) || 'N/A'}

**Recommended Strategy**: ${strategy?.recommendation || 'N/A'} (Confidence: ${strategy?.confidence || 'N/A'})
**Directional Bias**: ${strategy?.bias || 'N/A'}
**Volatility Level**: ${strategy?.volatilityLevel || 'N/A'}

---

`;
    }

    report += `
## Regime Transitions

Top regime transitions and their forward returns:

| Transition | Count | Avg 1h Return | Win Rate |
|------------|-------|---------------|----------|
`;

    for (const [transition, data] of Object.entries(this.results.transitions)) {
      report += `| ${transition} | ${data.count} | ${data.avgReturn1h?.toFixed(4) || 'N/A'}% | ${data.winRate1h ? (data.winRate1h * 100).toFixed(1) + '%' : 'N/A'} |\n`;
    }

    report += `
---

## Trading Implications

### Best Regimes for Long Trades
`;

    const longRegimes = sortedRegimes
      .filter(([_, s]) => s.returns['1h']?.mean > 0)
      .sort((a, b) => (b[1].returns['1h']?.mean || 0) - (a[1].returns['1h']?.mean || 0))
      .slice(0, 3);

    for (const [regime, stats] of longRegimes) {
      report += `- **${regime}**: ${stats.returns['1h']?.mean?.toFixed(4)}% avg return, ${(stats.returns['1h']?.winRate * 100).toFixed(1)}% win rate\n`;
    }

    report += `
### Best Regimes for Short Trades
`;

    const shortRegimes = sortedRegimes
      .filter(([_, s]) => s.returns['1h']?.mean < 0)
      .sort((a, b) => (a[1].returns['1h']?.mean || 0) - (b[1].returns['1h']?.mean || 0))
      .slice(0, 3);

    for (const [regime, stats] of shortRegimes) {
      report += `- **${regime}**: ${stats.returns['1h']?.mean?.toFixed(4)}% avg return, ${(100 - stats.returns['1h']?.winRate * 100).toFixed(1)}% short win rate\n`;
    }

    report += `
### Mean Reversion Opportunities
`;

    const meanRevRegimes = sortedRegimes
      .filter(([_, s]) => s.autocorrelation !== null && s.autocorrelation < -0.05)
      .sort((a, b) => a[1].autocorrelation - b[1].autocorrelation)
      .slice(0, 3);

    if (meanRevRegimes.length > 0) {
      for (const [regime, stats] of meanRevRegimes) {
        report += `- **${regime}**: Autocorr=${stats.autocorrelation.toFixed(3)} (strong mean reversion)\n`;
      }
    } else {
      report += `- No strong mean reversion regimes identified\n`;
    }

    report += `
### Trend Following Opportunities
`;

    const trendRegimes = sortedRegimes
      .filter(([_, s]) => s.autocorrelation !== null && s.autocorrelation > 0.05)
      .sort((a, b) => b[1].autocorrelation - a[1].autocorrelation)
      .slice(0, 3);

    if (trendRegimes.length > 0) {
      for (const [regime, stats] of trendRegimes) {
        report += `- **${regime}**: Autocorr=${stats.autocorrelation.toFixed(3)} (trending behavior)\n`;
      }
    } else {
      report += `- No strong trending regimes identified\n`;
    }

    report += `
---

## Methodology

- **Regime Classification**: Binary classification on IV (median split), GEX (positive/negative), Liquidity (bullish/bearish)
- **Autocorrelation**: Lag-1 autocorrelation of 15-minute returns; negative = mean reversion, positive = trending
- **Sharpe Ratio**: Mean return / Standard deviation (risk-adjusted performance)
- **Data**: RTH (Regular Trading Hours) records with complete data for all three regime dimensions

---

*Report generated by regime-analysis.js*
`;

    fs.writeFileSync(OUTPUT_REPORT, report);
    console.log(`   ✅ Markdown report: ${OUTPUT_REPORT}`);
  }
}

// Run
const analyzer = new RegimeAnalyzer();
analyzer.run().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
