#!/usr/bin/env node
/**
 * Event Studies - Phase 3
 *
 * Analyzes price behavior around specific events:
 * 3.1 Liquidity spike events
 * 3.2 GEX level touch events
 * 3.3 IV expansion events
 *
 * Input: unified_15m_2025_features.csv
 * Output: event_study_results.json, event_study_report.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_FILE = path.join(__dirname, 'output', 'unified_15m_2025_features.csv');
const OUTPUT_JSON = path.join(__dirname, 'output', 'event_study_results.json');
const OUTPUT_REPORT = path.join(__dirname, 'output', 'event_study_report.md');

// Event detection thresholds
const LIQUIDITY_SPIKE_STD = 2.0;  // 2 standard deviations
const GEX_TOUCH_THRESHOLD = 15;   // Points from level
const IV_EXPANSION_STD = 1.5;     // 1.5 standard deviations

// Forward windows to measure (in 15-min periods)
const FORWARD_WINDOWS = [1, 2, 4, 8, 16];  // 15m, 30m, 1h, 2h, 4h

class EventStudyAnalyzer {
  constructor() {
    this.data = [];
    this.results = {
      liquiditySpikes: {},
      gexLevelTouches: {},
      ivExpansions: {},
      metadata: {}
    };
  }

  async run() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Event Studies - Phase 3');
    console.log('═══════════════════════════════════════════════════════════════\n');

    await this.loadData();
    this.analyzeLiquiditySpikes();
    this.analyzeGexLevelTouches();
    this.analyzeIvExpansions();
    await this.exportResults();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Event Studies Complete!');
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
          console.log(`   ✅ Loaded ${this.data.length.toLocaleString()} records`);
          resolve();
        })
        .on('error', reject);
    });
  }

  // ===== LIQUIDITY SPIKE ANALYSIS =====

  analyzeLiquiditySpikes() {
    console.log('\n📊 Analyzing liquidity spike events...');

    // Calculate mean and std of liquidity max change
    const maxChanges = this.data
      .filter(r => r.liq_max_change !== null && !isNaN(r.liq_max_change))
      .map(r => r.liq_max_change);

    const mean = maxChanges.reduce((a, b) => a + b, 0) / maxChanges.length;
    const std = Math.sqrt(
      maxChanges.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / maxChanges.length
    );

    const threshold = mean + LIQUIDITY_SPIKE_STD * std;
    console.log(`   Spike threshold: ${threshold.toFixed(2)} (mean=${mean.toFixed(2)}, std=${std.toFixed(2)})`);

    // Find spike events
    const spikeEvents = [];
    for (let i = 0; i < this.data.length; i++) {
      const record = this.data[i];
      if (record.liq_max_change !== null && record.liq_max_change > threshold) {
        spikeEvents.push({
          index: i,
          timestamp: record.timestamp,
          maxChange: record.liq_max_change,
          sentiment: record.liq_sentiment,
          momentum: record.liq_momentum,
          close: record.close
        });
      }
    }

    console.log(`   Found ${spikeEvents.length} liquidity spike events`);

    // Analyze price behavior after spikes
    const results = this.analyzeEventOutcomes(spikeEvents, 'liquidity spike');

    // Segment by sentiment
    const bullishSpikes = spikeEvents.filter(e => e.sentiment === 'BULLISH');
    const bearishSpikes = spikeEvents.filter(e => e.sentiment === 'BEARISH');

    // Segment by momentum direction
    const upSpikes = spikeEvents.filter(e => e.momentum > 0);
    const downSpikes = spikeEvents.filter(e => e.momentum <= 0);

    this.results.liquiditySpikes = {
      threshold,
      totalEvents: spikeEvents.length,
      overall: results,
      bysentiment: {
        bullish: this.analyzeEventOutcomes(bullishSpikes, 'bullish spike'),
        bearish: this.analyzeEventOutcomes(bearishSpikes, 'bearish spike')
      },
      byMomentum: {
        up: this.analyzeEventOutcomes(upSpikes, 'up momentum spike'),
        down: this.analyzeEventOutcomes(downSpikes, 'down momentum spike')
      }
    };

    console.log(`   ✅ Liquidity spike analysis complete`);
  }

  // ===== GEX LEVEL TOUCH ANALYSIS =====

  analyzeGexLevelTouches() {
    console.log('\n📊 Analyzing GEX level touch events...');

    // Find support touches
    const supportTouches = [];
    const resistanceTouches = [];

    for (let i = 0; i < this.data.length; i++) {
      const record = this.data[i];
      if (record.close === null || record.is_rth !== 1) continue;

      // Check support 1 touch
      if (record.support_1 !== null) {
        const distToSupport = record.close - record.support_1;
        if (distToSupport >= 0 && distToSupport <= GEX_TOUCH_THRESHOLD) {
          supportTouches.push({
            index: i,
            timestamp: record.timestamp,
            close: record.close,
            level: record.support_1,
            distance: distToSupport,
            regime: record.gex_regime,
            iv: record.iv,
            sentiment: record.liq_sentiment
          });
        }
      }

      // Check resistance 1 touch
      if (record.resistance_1 !== null) {
        const distToResistance = record.resistance_1 - record.close;
        if (distToResistance >= 0 && distToResistance <= GEX_TOUCH_THRESHOLD) {
          resistanceTouches.push({
            index: i,
            timestamp: record.timestamp,
            close: record.close,
            level: record.resistance_1,
            distance: distToResistance,
            regime: record.gex_regime,
            iv: record.iv,
            sentiment: record.liq_sentiment
          });
        }
      }
    }

    console.log(`   Found ${supportTouches.length} support touches, ${resistanceTouches.length} resistance touches`);

    // Analyze outcomes
    const supportResults = this.analyzeEventOutcomes(supportTouches, 'support touch');
    const resistanceResults = this.analyzeEventOutcomes(resistanceTouches, 'resistance touch');

    // Compute bounce vs breakthrough rates
    const supportBounce = this.computeBounceRate(supportTouches, 'support');
    const resistanceBounce = this.computeBounceRate(resistanceTouches, 'resistance');

    // Segment by regime
    const positiveRegimeSupport = supportTouches.filter(e =>
      e.regime === 'positive' || e.regime === 'strong_positive'
    );
    const negativeRegimeSupport = supportTouches.filter(e =>
      e.regime === 'negative' || e.regime === 'strong_negative'
    );

    this.results.gexLevelTouches = {
      threshold: GEX_TOUCH_THRESHOLD,
      support: {
        totalEvents: supportTouches.length,
        outcomes: supportResults,
        bounceRate: supportBounce,
        byRegime: {
          positive: this.analyzeEventOutcomes(positiveRegimeSupport, 'positive regime support'),
          negative: this.analyzeEventOutcomes(negativeRegimeSupport, 'negative regime support')
        }
      },
      resistance: {
        totalEvents: resistanceTouches.length,
        outcomes: resistanceResults,
        bounceRate: resistanceBounce
      }
    };

    console.log(`   ✅ GEX level touch analysis complete`);
  }

  computeBounceRate(events, type) {
    if (events.length === 0) return { bounceRate: null, breakthroughRate: null };

    let bounces = 0;
    let breakthroughs = 0;

    for (const event of events) {
      // Look at price 4 periods later (1 hour)
      const futureIndex = event.index + 4;
      if (futureIndex >= this.data.length) continue;

      const futureRecord = this.data[futureIndex];
      if (futureRecord.close === null) continue;

      if (type === 'support') {
        // Bounce = price went up from support
        if (futureRecord.close > event.close) {
          bounces++;
        } else {
          breakthroughs++;
        }
      } else {
        // Bounce = price went down from resistance
        if (futureRecord.close < event.close) {
          bounces++;
        } else {
          breakthroughs++;
        }
      }
    }

    const total = bounces + breakthroughs;
    return {
      bounceRate: total > 0 ? bounces / total : null,
      breakthroughRate: total > 0 ? breakthroughs / total : null,
      bounces,
      breakthroughs,
      total
    };
  }

  // ===== IV EXPANSION ANALYSIS =====

  analyzeIvExpansions() {
    console.log('\n📊 Analyzing IV expansion events...');

    // Calculate IV change statistics
    const ivChanges = this.data
      .filter(r => r.iv_change_15m !== null && !isNaN(r.iv_change_15m))
      .map(r => r.iv_change_15m);

    const mean = ivChanges.reduce((a, b) => a + b, 0) / ivChanges.length;
    const std = Math.sqrt(
      ivChanges.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / ivChanges.length
    );

    const expansionThreshold = mean + IV_EXPANSION_STD * std;
    const contractionThreshold = mean - IV_EXPANSION_STD * std;

    console.log(`   Expansion threshold: ${expansionThreshold.toFixed(4)}`);
    console.log(`   Contraction threshold: ${contractionThreshold.toFixed(4)}`);

    // Find expansion/contraction events
    const expansions = [];
    const contractions = [];

    for (let i = 0; i < this.data.length; i++) {
      const record = this.data[i];
      if (record.iv_change_15m === null || record.is_rth !== 1) continue;

      if (record.iv_change_15m > expansionThreshold) {
        expansions.push({
          index: i,
          timestamp: record.timestamp,
          ivChange: record.iv_change_15m,
          iv: record.iv,
          regime: record.gex_regime,
          close: record.close
        });
      } else if (record.iv_change_15m < contractionThreshold) {
        contractions.push({
          index: i,
          timestamp: record.timestamp,
          ivChange: record.iv_change_15m,
          iv: record.iv,
          regime: record.gex_regime,
          close: record.close
        });
      }
    }

    console.log(`   Found ${expansions.length} IV expansions, ${contractions.length} IV contractions`);

    this.results.ivExpansions = {
      thresholds: { expansion: expansionThreshold, contraction: contractionThreshold },
      expansion: {
        totalEvents: expansions.length,
        outcomes: this.analyzeEventOutcomes(expansions, 'IV expansion')
      },
      contraction: {
        totalEvents: contractions.length,
        outcomes: this.analyzeEventOutcomes(contractions, 'IV contraction')
      }
    };

    console.log(`   ✅ IV expansion analysis complete`);
  }

  // ===== HELPER: Analyze event outcomes =====

  analyzeEventOutcomes(events, eventType) {
    if (events.length === 0) {
      return { message: 'No events found' };
    }

    const outcomes = {};

    for (const window of FORWARD_WINDOWS) {
      const returns = [];
      const ranges = [];
      const directions = { up: 0, down: 0 };

      for (const event of events) {
        const futureIndex = event.index + window;
        if (futureIndex >= this.data.length) continue;

        const currentClose = event.close || this.data[event.index].close;
        const futureRecord = this.data[futureIndex];

        if (currentClose === null || futureRecord.close === null) continue;

        const ret = (futureRecord.close - currentClose) / currentClose * 100;
        returns.push(ret);

        // Calculate max range over the window
        let maxHigh = currentClose;
        let minLow = currentClose;
        for (let j = event.index + 1; j <= futureIndex && j < this.data.length; j++) {
          if (this.data[j].high !== null) maxHigh = Math.max(maxHigh, this.data[j].high);
          if (this.data[j].low !== null) minLow = Math.min(minLow, this.data[j].low);
        }
        ranges.push(maxHigh - minLow);

        if (ret > 0) directions.up++;
        else directions.down++;
      }

      if (returns.length === 0) continue;

      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
      const stdReturn = Math.sqrt(
        returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
      );

      outcomes[`${window * 15}m`] = {
        n: returns.length,
        avgReturn: avgReturn,
        stdReturn: stdReturn,
        avgRange: avgRange,
        winRate: directions.up / (directions.up + directions.down),
        maxReturn: Math.max(...returns),
        minReturn: Math.min(...returns),
        // Max Favorable Excursion (MFE)
        avgMFE: this.computeAvgMFE(events, window),
        // Max Adverse Excursion (MAE)
        avgMAE: this.computeAvgMAE(events, window)
      };
    }

    return outcomes;
  }

  computeAvgMFE(events, window) {
    const mfes = [];

    for (const event of events) {
      const currentClose = event.close || this.data[event.index].close;
      if (currentClose === null) continue;

      let maxFavorable = 0;
      for (let j = event.index + 1; j <= event.index + window && j < this.data.length; j++) {
        if (this.data[j].high !== null) {
          const favorable = this.data[j].high - currentClose;
          maxFavorable = Math.max(maxFavorable, favorable);
        }
      }
      mfes.push(maxFavorable);
    }

    return mfes.length > 0 ? mfes.reduce((a, b) => a + b, 0) / mfes.length : null;
  }

  computeAvgMAE(events, window) {
    const maes = [];

    for (const event of events) {
      const currentClose = event.close || this.data[event.index].close;
      if (currentClose === null) continue;

      let maxAdverse = 0;
      for (let j = event.index + 1; j <= event.index + window && j < this.data.length; j++) {
        if (this.data[j].low !== null) {
          const adverse = currentClose - this.data[j].low;
          maxAdverse = Math.max(maxAdverse, adverse);
        }
      }
      maes.push(maxAdverse);
    }

    return maes.length > 0 ? maes.reduce((a, b) => a + b, 0) / maes.length : null;
  }

  // ===== EXPORT =====

  async exportResults() {
    console.log('\n💾 Exporting results...');

    this.results.metadata = {
      totalRecords: this.data.length,
      forwardWindows: FORWARD_WINDOWS.map(w => `${w * 15}m`),
      analysisDate: new Date().toISOString()
    };

    // Export JSON
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(this.results, null, 2));
    console.log(`   ✅ JSON results: ${OUTPUT_JSON}`);

    // Export report
    await this.exportReport();
  }

  async exportReport() {
    let report = `# Event Study Report

**Generated**: ${new Date().toISOString()}
**Total Records**: ${this.data.length.toLocaleString()}
**Forward Windows Analyzed**: ${FORWARD_WINDOWS.map(w => `${w * 15}m`).join(', ')}

---

## Executive Summary

This report analyzes price behavior following three types of market events:
1. **Liquidity Spikes**: Large changes in liquidity trigger levels
2. **GEX Level Touches**: Price approaching key gamma support/resistance levels
3. **IV Expansions**: Significant changes in implied volatility

---

## 1. Liquidity Spike Events

**Definition**: Liquidity level change > ${LIQUIDITY_SPIKE_STD} standard deviations from mean
**Threshold**: ${this.results.liquiditySpikes.threshold?.toFixed(2)} points
**Total Events**: ${this.results.liquiditySpikes.totalEvents}

### Overall Results

| Window | Avg Return | Std Dev | Win Rate | Avg Range | Avg MFE | Avg MAE |
|--------|-----------|---------|----------|-----------|---------|---------|
`;

    for (const [window, data] of Object.entries(this.results.liquiditySpikes.overall || {})) {
      if (typeof data !== 'object' || !data.avgReturn) continue;
      report += `| ${window} | ${data.avgReturn?.toFixed(4)}% | ${data.stdReturn?.toFixed(4)}% | ${(data.winRate * 100)?.toFixed(1)}% | ${data.avgRange?.toFixed(2)} | ${data.avgMFE?.toFixed(2)} | ${data.avgMAE?.toFixed(2)} |\n`;
    }

    report += `
### By Sentiment

**BULLISH Liquidity Sentiment** (${this.results.liquiditySpikes.byMomentum?.up?.['15m']?.n || 0} events):
`;

    if (this.results.liquiditySpikes.byMomentum?.up?.['60m']) {
      const data = this.results.liquiditySpikes.byMomentum.up['60m'];
      report += `- 1h Avg Return: ${data.avgReturn?.toFixed(4)}%, Win Rate: ${(data.winRate * 100)?.toFixed(1)}%\n`;
    }

    report += `
**BEARISH Liquidity Sentiment**:
`;

    if (this.results.liquiditySpikes.byMomentum?.down?.['60m']) {
      const data = this.results.liquiditySpikes.byMomentum.down['60m'];
      report += `- 1h Avg Return: ${data.avgReturn?.toFixed(4)}%, Win Rate: ${(data.winRate * 100)?.toFixed(1)}%\n`;
    }

    report += `
---

## 2. GEX Level Touch Events

**Definition**: Price within ${GEX_TOUCH_THRESHOLD} points of GEX Support 1 or Resistance 1

### Support Level Touches

**Total Events**: ${this.results.gexLevelTouches.support?.totalEvents || 0}
**Bounce Rate (1h)**: ${((this.results.gexLevelTouches.support?.bounceRate?.bounceRate || 0) * 100).toFixed(1)}%
**Breakthrough Rate**: ${((this.results.gexLevelTouches.support?.bounceRate?.breakthroughRate || 0) * 100).toFixed(1)}%

| Window | Avg Return | Win Rate | Avg MFE | Avg MAE |
|--------|-----------|----------|---------|---------|
`;

    for (const [window, data] of Object.entries(this.results.gexLevelTouches.support?.outcomes || {})) {
      if (typeof data !== 'object' || !data.avgReturn) continue;
      report += `| ${window} | ${data.avgReturn?.toFixed(4)}% | ${(data.winRate * 100)?.toFixed(1)}% | ${data.avgMFE?.toFixed(2)} | ${data.avgMAE?.toFixed(2)} |\n`;
    }

    report += `
#### By GEX Regime

**Positive GEX Regime** (${this.results.gexLevelTouches.support?.byRegime?.positive?.['60m']?.n || 0} events):
`;

    if (this.results.gexLevelTouches.support?.byRegime?.positive?.['60m']) {
      const data = this.results.gexLevelTouches.support.byRegime.positive['60m'];
      report += `- 1h Avg Return: ${data.avgReturn?.toFixed(4)}%, Win Rate: ${(data.winRate * 100)?.toFixed(1)}%\n`;
    }

    report += `
**Negative GEX Regime** (${this.results.gexLevelTouches.support?.byRegime?.negative?.['60m']?.n || 0} events):
`;

    if (this.results.gexLevelTouches.support?.byRegime?.negative?.['60m']) {
      const data = this.results.gexLevelTouches.support.byRegime.negative['60m'];
      report += `- 1h Avg Return: ${data.avgReturn?.toFixed(4)}%, Win Rate: ${(data.winRate * 100)?.toFixed(1)}%\n`;
    }

    report += `
### Resistance Level Touches

**Total Events**: ${this.results.gexLevelTouches.resistance?.totalEvents || 0}
**Bounce Rate (1h)**: ${((this.results.gexLevelTouches.resistance?.bounceRate?.bounceRate || 0) * 100).toFixed(1)}%

| Window | Avg Return | Win Rate | Avg MFE | Avg MAE |
|--------|-----------|----------|---------|---------|
`;

    for (const [window, data] of Object.entries(this.results.gexLevelTouches.resistance?.outcomes || {})) {
      if (typeof data !== 'object' || !data.avgReturn) continue;
      report += `| ${window} | ${data.avgReturn?.toFixed(4)}% | ${(data.winRate * 100)?.toFixed(1)}% | ${data.avgMFE?.toFixed(2)} | ${data.avgMAE?.toFixed(2)} |\n`;
    }

    report += `
---

## 3. IV Expansion Events

**IV Expansion Threshold**: ${this.results.ivExpansions.thresholds?.expansion?.toFixed(4)}
**IV Contraction Threshold**: ${this.results.ivExpansions.thresholds?.contraction?.toFixed(4)}

### IV Expansion (Volatility Spike)

**Total Events**: ${this.results.ivExpansions.expansion?.totalEvents || 0}

| Window | Avg Return | Std Dev | Win Rate | Avg Range |
|--------|-----------|---------|----------|-----------|
`;

    for (const [window, data] of Object.entries(this.results.ivExpansions.expansion?.outcomes || {})) {
      if (typeof data !== 'object' || !data.avgReturn) continue;
      report += `| ${window} | ${data.avgReturn?.toFixed(4)}% | ${data.stdReturn?.toFixed(4)}% | ${(data.winRate * 100)?.toFixed(1)}% | ${data.avgRange?.toFixed(2)} |\n`;
    }

    report += `
### IV Contraction (Volatility Crush)

**Total Events**: ${this.results.ivExpansions.contraction?.totalEvents || 0}

| Window | Avg Return | Std Dev | Win Rate | Avg Range |
|--------|-----------|---------|----------|-----------|
`;

    for (const [window, data] of Object.entries(this.results.ivExpansions.contraction?.outcomes || {})) {
      if (typeof data !== 'object' || !data.avgReturn) continue;
      report += `| ${window} | ${data.avgReturn?.toFixed(4)}% | ${data.stdReturn?.toFixed(4)}% | ${(data.winRate * 100)?.toFixed(1)}% | ${data.avgRange?.toFixed(2)} |\n`;
    }

    report += `
---

## Trading Implications

### Liquidity Spikes
- Large liquidity level movements signal increased volatility ahead
- Consider adjusting position sizing when liquidity spikes are detected

### GEX Level Touches
- Support touches in positive GEX environments have higher bounce rates
- Use GEX regime as a filter for level-based entries

### IV Events
- IV expansions typically precede directional moves
- IV contractions may signal mean reversion opportunities

---

## Methodology

- **Event Detection**: Events identified when metrics exceed threshold standard deviations
- **Forward Windows**: Price behavior measured at T+15m, T+30m, T+1h, T+2h, T+4h
- **MFE/MAE**: Maximum Favorable/Adverse Excursion measures best/worst price during window
- **Win Rate**: Percentage of events where price moved in favorable direction

---

*Report generated by event-studies.js*
`;

    fs.writeFileSync(OUTPUT_REPORT, report);
    console.log(`   ✅ Markdown report: ${OUTPUT_REPORT}`);
  }
}

// Run
const analyzer = new EventStudyAnalyzer();
analyzer.run().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
