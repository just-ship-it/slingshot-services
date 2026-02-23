#!/usr/bin/env node
/**
 * ES Order Flow Executive Summary
 *
 * Aggregates all analysis results:
 * - Ranks patterns by predictive power (win rate, avg move, sample size)
 * - Cross-pattern interactions
 * - Most actionable findings for strategy development
 * - Comparison: which patterns are strongest on ES
 *
 * Usage:
 *   node scripts/es-orderflow-executive-summary.js [options]
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const resultsDir = getArg('results-dir', 'results/es-orderflow');
const outputPath = getArg('output', 'results/es-orderflow/executive-summary.json');

console.log('='.repeat(80));
console.log('ES ORDER FLOW — EXECUTIVE SUMMARY');
console.log('='.repeat(80));
console.log();

// ============================================================================
// Load All Results
// ============================================================================

function loadJSON(filename) {
  const filePath = path.resolve(resultsDir, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`  [SKIP] ${filename} not found`);
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`  [OK] ${filename}`);
    return data;
  } catch (e) {
    console.log(`  [ERR] ${filename}: ${e.message}`);
    return null;
  }
}

console.log('Loading analysis results...');
const absorption = loadJSON('absorption-analysis-results.json');
const sweep = loadJSON('sweep-analysis-results.json');
const stopHunt = loadJSON('stop-hunt-results.json');
const momentumIgnition = loadJSON('momentum-ignition-results.json');
const vwapAlgo = loadJSON('vwap-algo-results.json');
const algoClustering = loadJSON('algo-clustering-results.json');
console.log();

// ============================================================================
// Pattern Ranking
// ============================================================================

function extractPatternMetrics(data, patternName) {
  const metrics = [];

  const extract = (group, subLabel) => {
    if (!group || !group.count) return;
    const label = `${patternName}:${subLabel}`;

    // Look for win rates at different windows
    for (const window of ['1m', '5m', '15m', '30m', '60m']) {
      const wr = group[window];
      if (!wr) continue;

      const winRate = wr.winRate
        ? parseFloat(wr.winRate)
        : wr.continuationRate
          ? parseFloat(wr.continuationRate)
          : null;

      if (winRate === null) continue;

      metrics.push({
        pattern: label,
        window,
        winRate,
        avgReturn: parseFloat(wr.avgReturn || 0),
        avgMagnitude: parseFloat(wr.avgMagnitude || 0),
        count: wr.count || group.count,
        // Compute z-score for statistical significance (vs 50% baseline)
        zScore: group.count >= 10
          ? (winRate / 100 - 0.5) / Math.sqrt(0.25 / (wr.count || group.count))
          : 0
      });
    }
  };

  if (!data) return metrics;

  // Overall
  if (data.overall) extract(data.overall, 'all');

  // By type/direction
  if (data.byType) {
    for (const [key, group] of Object.entries(data.byType)) {
      extract(group, key);
    }
  }
  if (data.byDirection) {
    for (const [key, group] of Object.entries(data.byDirection)) {
      extract(group, key);
    }
  }
  if (data.byHuntDirection) {
    for (const [key, group] of Object.entries(data.byHuntDirection)) {
      extract(group, key);
    }
  }

  // Level interactions
  if (data.atGexLevel) extract(data.atGexLevel, 'at_gex');
  if (data.notAtGexLevel) extract(data.notAtGexLevel, 'no_gex');
  if (data.atLTLevel) extract(data.atLTLevel, 'at_lt');
  if (data.atBothLevels) extract(data.atBothLevels, 'at_both');
  if (data.crossedGexLevel) extract(data.crossedGexLevel, 'crossed_gex');
  if (data.nearLevel) extract(data.nearLevel, 'near_level');
  if (data.farFromLevel) extract(data.farFromLevel, 'far_level');
  if (data.withReversal) extract(data.withReversal, 'with_reversal');
  if (data.withoutReversal) extract(data.withoutReversal, 'no_reversal');

  // By regime
  if (data.byRegime) {
    for (const [key, group] of Object.entries(data.byRegime)) {
      extract(group, `regime_${key}`);
    }
  }

  // By session
  if (data.bySession) {
    for (const [key, group] of Object.entries(data.bySession)) {
      extract(group, `session_${key}`);
    }
  }

  // By GEX level type
  if (data.byGexLevel) {
    for (const [key, group] of Object.entries(data.byGexLevel)) {
      extract(group, `gex_${key}`);
    }
  }
  if (data.byGexLevelCrossed) {
    for (const [key, group] of Object.entries(data.byGexLevelCrossed)) {
      extract(group, `crossed_${key}`);
    }
  }

  // By level type (stop hunts)
  if (data.byLevelType) {
    for (const [key, group] of Object.entries(data.byLevelType)) {
      extract(group, `level_${key}`);
    }
  }

  return metrics;
}

// Collect all pattern metrics
const allMetrics = [
  ...extractPatternMetrics(absorption, 'absorption'),
  ...extractPatternMetrics(sweep, 'sweep'),
  ...extractPatternMetrics(stopHunt, 'stop_hunt'),
  ...extractPatternMetrics(momentumIgnition, 'momentum_ignition'),
];

console.log(`Collected ${allMetrics.length} pattern metrics\n`);

// ============================================================================
// Rankings
// ============================================================================

// Filter to statistically meaningful results
const significant = allMetrics.filter(m => m.count >= 20 && Math.abs(m.zScore) > 1.5);

// Rank by win rate (highest first)
const byWinRate = [...significant].sort((a, b) => b.winRate - a.winRate);

// Rank by absolute return
const byReturn = [...significant].sort((a, b) => Math.abs(b.avgReturn) - Math.abs(a.avgReturn));

// Rank by z-score (most statistically significant)
const bySignificance = [...significant].sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

// ============================================================================
// Strategy Implications
// ============================================================================

function deriveImplications(metrics) {
  const implications = [];

  // Find best absorption patterns
  const absorptionMetrics = metrics.filter(m => m.pattern.startsWith('absorption:'));
  if (absorptionMetrics.length > 0) {
    const bestAbsorption = absorptionMetrics.sort((a, b) => b.winRate - a.winRate)[0];
    if (bestAbsorption && bestAbsorption.winRate > 55) {
      implications.push({
        type: 'absorption',
        finding: `Best absorption pattern: ${bestAbsorption.pattern} at ${bestAbsorption.window}`,
        winRate: bestAbsorption.winRate,
        avgReturn: bestAbsorption.avgReturn,
        count: bestAbsorption.count,
        actionable: bestAbsorption.winRate > 60 && bestAbsorption.count >= 50
      });
    }
  }

  // Find best sweep patterns
  const sweepMetrics = metrics.filter(m => m.pattern.startsWith('sweep:'));
  if (sweepMetrics.length > 0) {
    const bestSweep = sweepMetrics.sort((a, b) => b.winRate - a.winRate)[0];
    if (bestSweep && bestSweep.winRate > 55) {
      implications.push({
        type: 'sweep',
        finding: `Best sweep pattern: ${bestSweep.pattern} at ${bestSweep.window}`,
        winRate: bestSweep.winRate,
        avgReturn: bestSweep.avgReturn,
        count: bestSweep.count,
        actionable: bestSweep.winRate > 60 && bestSweep.count >= 50
      });
    }
  }

  // Stop hunt tradability
  const huntMetrics = metrics.filter(m => m.pattern.startsWith('stop_hunt:'));
  if (huntMetrics.length > 0) {
    const bestHunt = huntMetrics.sort((a, b) => b.winRate - a.winRate)[0];
    if (bestHunt && bestHunt.winRate > 55) {
      implications.push({
        type: 'stop_hunt',
        finding: `Best stop hunt pattern: ${bestHunt.pattern} at ${bestHunt.window}`,
        winRate: bestHunt.winRate,
        avgReturn: bestHunt.avgReturn,
        count: bestHunt.count,
        actionable: bestHunt.winRate > 60 && bestHunt.count >= 30
      });
    }
  }

  // Momentum ignition
  const miMetrics = metrics.filter(m => m.pattern.startsWith('momentum_ignition:'));
  if (miMetrics.length > 0) {
    const bestMI = miMetrics.sort((a, b) => b.winRate - a.winRate)[0];
    if (bestMI && bestMI.winRate > 55) {
      implications.push({
        type: 'momentum_ignition',
        finding: `Best MI pattern: ${bestMI.pattern} at ${bestMI.window}`,
        winRate: bestMI.winRate,
        avgReturn: bestMI.avgReturn,
        count: bestMI.count,
        actionable: bestMI.winRate > 60 && bestMI.count >= 30
      });
    }
  }

  // GEX level interaction
  const atGex = metrics.filter(m => m.pattern.includes(':at_gex'));
  const noGex = metrics.filter(m => m.pattern.includes(':no_gex'));
  if (atGex.length > 0 && noGex.length > 0) {
    const avgGexWR = atGex.reduce((s, m) => s + m.winRate, 0) / atGex.length;
    const avgNoGexWR = noGex.reduce((s, m) => s + m.winRate, 0) / noGex.length;
    implications.push({
      type: 'gex_interaction',
      finding: `GEX level proximity: ${avgGexWR.toFixed(1)}% win rate vs ${avgNoGexWR.toFixed(1)}% without`,
      delta: (avgGexWR - avgNoGexWR).toFixed(1) + '%',
      actionable: Math.abs(avgGexWR - avgNoGexWR) > 5
    });
  }

  // Session effect
  const rthMetrics = metrics.filter(m => m.pattern.includes('session_rth'));
  const overnightMetrics = metrics.filter(m => m.pattern.includes('session_overnight'));
  if (rthMetrics.length > 0 && overnightMetrics.length > 0) {
    const avgRthWR = rthMetrics.reduce((s, m) => s + m.winRate, 0) / rthMetrics.length;
    const avgOvernightWR = overnightMetrics.reduce((s, m) => s + m.winRate, 0) / overnightMetrics.length;
    implications.push({
      type: 'session_effect',
      finding: `RTH: ${avgRthWR.toFixed(1)}% avg win rate vs Overnight: ${avgOvernightWR.toFixed(1)}%`,
      actionable: Math.abs(avgRthWR - avgOvernightWR) > 5
    });
  }

  return implications;
}

const implications = deriveImplications(significant);

// ============================================================================
// Algo Clustering Summary
// ============================================================================

let algoSummary = null;
if (algoClustering) {
  algoSummary = {
    distribution: algoClustering.distribution,
    typeProfiles: {}
  };
  for (const [type, data] of Object.entries(algoClustering.byAlgoType || {})) {
    if (!data) continue;
    algoSummary.typeProfiles[type] = {
      count: data.count,
      pct: data.pct,
      avgVolume: data.avgVolume,
      avgTradeSize: data.avgTradeSize,
      avgImbalance: data.avgImbalance,
      forwardReturns: {}
    };
    for (const key of ['5m', '15m', '30m', '60m']) {
      if (data[key]) algoSummary.typeProfiles[type].forwardReturns[key] = data[key];
    }
  }
}

// ============================================================================
// VWAP Summary
// ============================================================================

let vwapSummary = null;
if (vwapAlgo) {
  vwapSummary = {
    totalDetections: vwapAlgo.metadata?.totalDetections || 0,
    overall: vwapAlgo.overall,
    highConfidence: vwapAlgo.highConfidence,
    biasEffect: {
      buyBiased: vwapAlgo.buyBiased,
      sellBiased: vwapAlgo.sellBiased,
      neutral: vwapAlgo.neutral
    }
  };
}

// ============================================================================
// Compile Summary
// ============================================================================

const summary = {
  generatedAt: new Date().toISOString(),
  dataRange: {
    absorption: absorption?.metadata || null,
    sweep: sweep?.metadata || null,
    stopHunt: stopHunt?.metadata || null,
    momentumIgnition: momentumIgnition?.metadata || null,
    vwapAlgo: vwapAlgo?.metadata || null,
    algoClustering: algoClustering?.metadata || null
  },

  eventCounts: {
    absorption: absorption?.metadata?.totalEvents || 0,
    sweep: sweep?.metadata?.totalEvents || 0,
    stopHunt: stopHunt?.metadata?.totalEvents || 0,
    momentumIgnition: momentumIgnition?.metadata?.totalEvents || 0,
    vwapDetections: vwapAlgo?.metadata?.totalDetections || 0,
    algoClassified: algoClustering?.metadata?.totalClassified || 0
  },

  // Top 20 patterns by win rate (statistically significant only)
  topByWinRate: byWinRate.slice(0, 20).map(m => ({
    pattern: m.pattern,
    window: m.window,
    winRate: m.winRate.toFixed(1) + '%',
    avgReturn: m.avgReturn.toFixed(2) + ' pts',
    count: m.count,
    zScore: m.zScore.toFixed(2)
  })),

  // Top 20 by statistical significance
  topBySignificance: bySignificance.slice(0, 20).map(m => ({
    pattern: m.pattern,
    window: m.window,
    winRate: m.winRate.toFixed(1) + '%',
    avgReturn: m.avgReturn.toFixed(2) + ' pts',
    count: m.count,
    zScore: m.zScore.toFixed(2)
  })),

  // Top 20 by average return magnitude
  topByReturn: byReturn.slice(0, 20).map(m => ({
    pattern: m.pattern,
    window: m.window,
    winRate: m.winRate.toFixed(1) + '%',
    avgReturn: m.avgReturn.toFixed(2) + ' pts',
    count: m.count,
    zScore: m.zScore.toFixed(2)
  })),

  // Strategy implications
  implications,
  actionableFindings: implications.filter(i => i.actionable),

  // Algorithm fingerprinting
  algoSummary,
  vwapSummary,

  // All significant patterns (for downstream processing)
  allSignificantPatterns: significant.length
};

// ============================================================================
// Print Summary
// ============================================================================

console.log('=== EXECUTIVE SUMMARY ===\n');

console.log('Event Counts:');
for (const [key, count] of Object.entries(summary.eventCounts)) {
  console.log(`  ${key}: ${count.toLocaleString()}`);
}
console.log();

console.log(`Significant patterns found: ${significant.length} (z > 1.5, n >= 20)`);
console.log();

console.log('Top 10 Patterns by Win Rate:');
for (const m of summary.topByWinRate.slice(0, 10)) {
  console.log(`  ${m.pattern} @ ${m.window}: ${m.winRate} win, ${m.avgReturn}, n=${m.count}, z=${m.zScore}`);
}
console.log();

console.log('Top 10 by Statistical Significance:');
for (const m of summary.topBySignificance.slice(0, 10)) {
  console.log(`  ${m.pattern} @ ${m.window}: ${m.winRate} win, ${m.avgReturn}, n=${m.count}, z=${m.zScore}`);
}
console.log();

if (implications.length > 0) {
  console.log('Strategy Implications:');
  for (const imp of implications) {
    const flag = imp.actionable ? '[ACTIONABLE]' : '[info]';
    console.log(`  ${flag} ${imp.type}: ${imp.finding}`);
  }
  console.log();
}

if (algoSummary) {
  console.log('Algorithm Distribution:');
  for (const [type, count] of Object.entries(algoSummary.distribution || {}).sort((a, b) => b[1] - a[1])) {
    const pct = algoSummary.typeProfiles[type]?.pct || '';
    console.log(`  ${type}: ${count} (${pct})`);
  }
  console.log();
}

if (vwapSummary) {
  console.log(`VWAP Algo Detections: ${vwapSummary.totalDetections}`);
  if (vwapSummary.highConfidence) {
    console.log(`  High confidence: ${vwapSummary.highConfidence.count}`);
  }
  console.log();
}

// Write output
const outDir = path.dirname(path.resolve(outputPath));
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.resolve(outputPath), JSON.stringify(summary, null, 2));
console.log(`Results written to ${outputPath}`);
