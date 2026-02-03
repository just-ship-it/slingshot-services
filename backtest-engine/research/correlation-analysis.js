#!/usr/bin/env node
/**
 * Correlation Analysis - Phase 2.1
 *
 * Computes pairwise correlations between key variables:
 * - Pearson correlation (linear relationships)
 * - Spearman correlation (monotonic relationships)
 * - Statistical significance (p-values)
 *
 * Input: unified_15m_2025_features.csv
 * Output: correlation_results.json, correlation_matrix.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_FILE = path.join(__dirname, 'output', 'unified_15m_2025_features.csv');
const OUTPUT_JSON = path.join(__dirname, 'output', 'correlation_results.json');
const OUTPUT_CSV = path.join(__dirname, 'output', 'correlation_matrix.csv');
const OUTPUT_REPORT = path.join(__dirname, 'output', 'correlation_report.md');

// Key variables for correlation analysis
const CORRELATION_VARS = {
  // Price
  price: ['price_return_15m', 'price_return_1h', 'price_range_15m', 'price_volatility_1h'],
  // GEX
  gex: ['gex_dist_gamma_flip', 'gex_dist_support_1', 'gex_dist_resistance_1', 'gex_regime_encoded', 'total_gex'],
  // IV
  iv: ['iv', 'iv_skew', 'iv_change_15m', 'iv_percentile_all'],
  // Liquidity
  liquidity: ['liq_sentiment_encoded', 'liq_spacing_avg', 'liq_momentum', 'liq_max_change', 'liq_dist_nearest']
};

// Flatten for easy iteration
const ALL_VARS = [
  ...CORRELATION_VARS.price,
  ...CORRELATION_VARS.gex,
  ...CORRELATION_VARS.iv,
  ...CORRELATION_VARS.liquidity
];

class CorrelationAnalyzer {
  constructor() {
    this.data = [];
    this.rthData = [];  // Only RTH records with full data
    this.results = {
      pearson: {},
      spearman: {},
      keyFindings: [],
      metadata: {}
    };
  }

  async run() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Correlation Analysis - Phase 2.1');
    console.log('═══════════════════════════════════════════════════════════════\n');

    await this.loadData();
    this.computeCorrelations();
    this.identifyKeyFindings();
    await this.exportResults();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Correlation Analysis Complete!');
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
            if (isNaN(record[key])) record[key] = row[key];  // Keep string values
          }
          this.data.push(record);

          // Filter for RTH records with complete data
          if (record.is_rth === 1 && record.iv !== null && record.total_gex !== null) {
            this.rthData.push(record);
          }
        })
        .on('end', () => {
          console.log(`   ✅ Loaded ${this.data.length.toLocaleString()} total records`);
          console.log(`   RTH records with complete data: ${this.rthData.length.toLocaleString()}`);
          resolve();
        })
        .on('error', reject);
    });
  }

  computeCorrelations() {
    console.log('\n📊 Computing correlations...');

    // Use RTH data for correlations (where we have GEX and IV)
    const data = this.rthData;

    // Compute pairwise correlations
    for (let i = 0; i < ALL_VARS.length; i++) {
      for (let j = i; j < ALL_VARS.length; j++) {
        const var1 = ALL_VARS[i];
        const var2 = ALL_VARS[j];

        // Extract paired values (both non-null)
        const pairs = [];
        for (const record of data) {
          const v1 = record[var1];
          const v2 = record[var2];
          if (v1 !== null && v2 !== null && !isNaN(v1) && !isNaN(v2)) {
            pairs.push([v1, v2]);
          }
        }

        if (pairs.length < 30) continue;  // Need sufficient data

        const x = pairs.map(p => p[0]);
        const y = pairs.map(p => p[1]);

        // Pearson correlation
        const pearson = this.pearsonCorrelation(x, y);

        // Spearman correlation
        const spearman = this.spearmanCorrelation(x, y);

        // Store results
        const key = `${var1}__${var2}`;
        this.results.pearson[key] = {
          var1, var2,
          correlation: pearson.r,
          pValue: pearson.pValue,
          n: pairs.length
        };
        this.results.spearman[key] = {
          var1, var2,
          correlation: spearman.rho,
          pValue: spearman.pValue,
          n: pairs.length
        };
      }
    }

    console.log(`   ✅ Computed ${Object.keys(this.results.pearson).length} correlation pairs`);
  }

  pearsonCorrelation(x, y) {
    const n = x.length;
    if (n < 3) return { r: null, pValue: null };

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

    // t-statistic for significance
    const t = r * Math.sqrt((n - 2) / (1 - r * r));
    const pValue = this.tDistributionPValue(Math.abs(t), n - 2);

    return { r: isNaN(r) ? null : r, pValue };
  }

  spearmanCorrelation(x, y) {
    const n = x.length;
    if (n < 3) return { rho: null, pValue: null };

    // Rank the values
    const rankX = this.rank(x);
    const rankY = this.rank(y);

    // Compute Pearson on ranks
    const result = this.pearsonCorrelation(rankX, rankY);
    return { rho: result.r, pValue: result.pValue };
  }

  rank(arr) {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);

    let i = 0;
    while (i < sorted.length) {
      let j = i;
      // Find ties
      while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
      // Average rank for ties
      const avgRank = (i + j + 1) / 2;
      for (let k = i; k < j; k++) {
        ranks[sorted[k].i] = avgRank;
      }
      i = j;
    }

    return ranks;
  }

  tDistributionPValue(t, df) {
    // Approximation of two-tailed p-value from t-distribution
    // Using the incomplete beta function approximation
    if (df <= 0) return 1;

    const x = df / (df + t * t);
    // Simplified approximation
    const pValue = Math.exp(-0.5 * t * t) * Math.sqrt(2 / Math.PI) / Math.abs(t);
    return Math.min(1, Math.max(0, pValue * 2));  // Two-tailed
  }

  identifyKeyFindings() {
    console.log('\n🔍 Identifying key findings...');

    const findings = [];

    // Find strongest correlations (|r| > 0.3 and significant)
    for (const [key, result] of Object.entries(this.results.pearson)) {
      if (result.var1 === result.var2) continue;  // Skip self-correlations

      const absR = Math.abs(result.correlation);
      if (absR > 0.15 && result.pValue < 0.05) {
        findings.push({
          type: 'pearson',
          var1: result.var1,
          var2: result.var2,
          correlation: result.correlation,
          pValue: result.pValue,
          n: result.n,
          strength: absR > 0.5 ? 'strong' : absR > 0.3 ? 'moderate' : 'weak',
          direction: result.correlation > 0 ? 'positive' : 'negative'
        });
      }
    }

    // Sort by absolute correlation
    findings.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    this.results.keyFindings = findings.slice(0, 30);  // Top 30 findings
    this.results.metadata = {
      totalRecords: this.data.length,
      rthRecords: this.rthData.length,
      correlationPairs: Object.keys(this.results.pearson).length,
      significantFindings: findings.length,
      analysisDate: new Date().toISOString()
    };

    console.log(`   ✅ Found ${findings.length} significant correlations`);
  }

  async exportResults() {
    console.log('\n💾 Exporting results...');

    // Export JSON
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(this.results, null, 2));
    console.log(`   ✅ JSON results: ${OUTPUT_JSON}`);

    // Export correlation matrix CSV
    await this.exportCorrelationMatrix();

    // Export markdown report
    await this.exportReport();
  }

  async exportCorrelationMatrix() {
    // Build matrix
    const matrix = {};
    for (const v of ALL_VARS) {
      matrix[v] = {};
    }

    for (const [key, result] of Object.entries(this.results.pearson)) {
      matrix[result.var1][result.var2] = result.correlation;
      matrix[result.var2][result.var1] = result.correlation;
    }

    // Write CSV
    let csvContent = 'variable,' + ALL_VARS.join(',') + '\n';
    for (const v1 of ALL_VARS) {
      const row = [v1];
      for (const v2 of ALL_VARS) {
        const val = matrix[v1]?.[v2];
        row.push(val !== undefined ? val.toFixed(4) : '');
      }
      csvContent += row.join(',') + '\n';
    }

    fs.writeFileSync(OUTPUT_CSV, csvContent);
    console.log(`   ✅ Correlation matrix: ${OUTPUT_CSV}`);
  }

  async exportReport() {
    let report = `# Correlation Analysis Report

**Generated**: ${new Date().toISOString()}
**Analysis Period**: 2025-01-13 to 2025-12-24
**Total Records**: ${this.results.metadata.totalRecords.toLocaleString()}
**RTH Records (with GEX/IV)**: ${this.results.metadata.rthRecords.toLocaleString()}

---

## Executive Summary

Analyzed ${this.results.metadata.correlationPairs} variable pairs across price, GEX, IV, and liquidity data.
Found **${this.results.metadata.significantFindings} statistically significant correlations** (p < 0.05, |r| > 0.15).

---

## Top Correlation Findings

| Rank | Variable 1 | Variable 2 | Pearson r | Strength | Direction | p-value | n |
|------|------------|------------|-----------|----------|-----------|---------|---|
`;

    this.results.keyFindings.forEach((f, i) => {
      report += `| ${i + 1} | ${f.var1} | ${f.var2} | ${f.correlation.toFixed(4)} | ${f.strength} | ${f.direction} | ${f.pValue.toFixed(4)} | ${f.n} |\n`;
    });

    report += `
---

## Key Insights

### Price-GEX Relationships
`;

    const priceGexFindings = this.results.keyFindings.filter(f =>
      (CORRELATION_VARS.price.includes(f.var1) && CORRELATION_VARS.gex.includes(f.var2)) ||
      (CORRELATION_VARS.price.includes(f.var2) && CORRELATION_VARS.gex.includes(f.var1))
    );

    if (priceGexFindings.length > 0) {
      priceGexFindings.forEach(f => {
        report += `- **${f.var1}** vs **${f.var2}**: ${f.direction} ${f.strength} correlation (r=${f.correlation.toFixed(3)})\n`;
      });
    } else {
      report += `- No significant price-GEX correlations found\n`;
    }

    report += `
### Price-IV Relationships
`;

    const priceIvFindings = this.results.keyFindings.filter(f =>
      (CORRELATION_VARS.price.includes(f.var1) && CORRELATION_VARS.iv.includes(f.var2)) ||
      (CORRELATION_VARS.price.includes(f.var2) && CORRELATION_VARS.iv.includes(f.var1))
    );

    if (priceIvFindings.length > 0) {
      priceIvFindings.forEach(f => {
        report += `- **${f.var1}** vs **${f.var2}**: ${f.direction} ${f.strength} correlation (r=${f.correlation.toFixed(3)})\n`;
      });
    } else {
      report += `- No significant price-IV correlations found\n`;
    }

    report += `
### Price-Liquidity Relationships
`;

    const priceLiqFindings = this.results.keyFindings.filter(f =>
      (CORRELATION_VARS.price.includes(f.var1) && CORRELATION_VARS.liquidity.includes(f.var2)) ||
      (CORRELATION_VARS.price.includes(f.var2) && CORRELATION_VARS.liquidity.includes(f.var1))
    );

    if (priceLiqFindings.length > 0) {
      priceLiqFindings.forEach(f => {
        report += `- **${f.var1}** vs **${f.var2}**: ${f.direction} ${f.strength} correlation (r=${f.correlation.toFixed(3)})\n`;
      });
    } else {
      report += `- No significant price-liquidity correlations found\n`;
    }

    report += `
### GEX-IV Relationships
`;

    const gexIvFindings = this.results.keyFindings.filter(f =>
      (CORRELATION_VARS.gex.includes(f.var1) && CORRELATION_VARS.iv.includes(f.var2)) ||
      (CORRELATION_VARS.gex.includes(f.var2) && CORRELATION_VARS.iv.includes(f.var1))
    );

    if (gexIvFindings.length > 0) {
      gexIvFindings.forEach(f => {
        report += `- **${f.var1}** vs **${f.var2}**: ${f.direction} ${f.strength} correlation (r=${f.correlation.toFixed(3)})\n`;
      });
    } else {
      report += `- No significant GEX-IV correlations found\n`;
    }

    report += `
---

## Variables Analyzed

### Price Features
${CORRELATION_VARS.price.map(v => `- \`${v}\``).join('\n')}

### GEX Features
${CORRELATION_VARS.gex.map(v => `- \`${v}\``).join('\n')}

### IV Features
${CORRELATION_VARS.iv.map(v => `- \`${v}\``).join('\n')}

### Liquidity Features
${CORRELATION_VARS.liquidity.map(v => `- \`${v}\``).join('\n')}

---

## Methodology

- **Pearson Correlation**: Measures linear relationship between variables
- **Spearman Correlation**: Measures monotonic relationship (rank-based)
- **Significance Threshold**: p < 0.05
- **Minimum Correlation**: |r| > 0.15 for inclusion in findings
- **Data Filter**: RTH (Regular Trading Hours) records only, where all data sources are available

---

*Report generated by correlation-analysis.js*
`;

    fs.writeFileSync(OUTPUT_REPORT, report);
    console.log(`   ✅ Markdown report: ${OUTPUT_REPORT}`);
  }
}

// Run
const analyzer = new CorrelationAnalyzer();
analyzer.run().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
