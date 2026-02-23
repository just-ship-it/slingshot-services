#!/usr/bin/env node
/**
 * NQ Swing Point Opportunity Analysis
 *
 * Maps every N-bar swing point in NQ, measures max favorable excursion (MFE)
 * before invalidation, and reports distributions across lookback values.
 *
 * For each swing HIGH at price P:
 *   - Entry = open of next candle (short opportunity)
 *   - MFE = entry - lowest low seen
 *   - Invalidation = any candle high > P
 *
 * For each swing LOW at price P:
 *   - Entry = open of next candle (long opportunity)
 *   - MFE = highest high seen - entry
 *   - Invalidation = any candle low < P
 *
 * Usage:
 *   node scripts/nq-swing-opportunity.js [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const startDateStr = getArg('start', '2025-01-01');
const endDateStr = getArg('end', '2025-07-31');
const outputPath = getArg('output', 'nq-swing-opportunity-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

const LOOKBACKS = [3, 5, 8, 10];
const MFE_THRESHOLDS = [30, 50, 75, 100];
const MAX_STOP = 30; // Max acceptable risk (wick to close) in points

console.log('='.repeat(80));
console.log('NQ SWING POINT OPPORTUNITY ANALYSIS');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Lookbacks: ${LOOKBACKS.join(', ')}`);
console.log(`MFE thresholds: ${MFE_THRESHOLDS.join(', ')} pts`);
console.log(`Max stop (risk filter): ${MAX_STOP} pts`);
console.log();

// ============================================================================
// Data Loading
// ============================================================================

function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;
  const contractVolumes = new Map();
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    if (!contractVolumes.has(hourKey)) contractVolumes.set(hourKey, new Map());
    const hourData = contractVolumes.get(hourKey);
    hourData.set(candle.symbol, (hourData.get(candle.symbol) || 0) + (candle.volume || 0));
  });
  return candles.filter(candle => {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    const hourData = contractVolumes.get(hourKey);
    if (!hourData) return true;
    let primarySymbol = '', maxVolume = 0;
    for (const [symbol, volume] of hourData) {
      if (volume > maxVolume) { maxVolume = volume; primarySymbol = symbol; }
    }
    return candle.symbol === primarySymbol;
  });
}

async function loadOHLCVData() {
  const filePath = path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  console.log(`Loading NQ 1m OHLCV data...`);
  const candles = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    const symbol = parts[9]?.trim();
    if (symbol && symbol.includes('-')) continue; // filter calendar spreads
    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseInt(parts[8]);
    if (open === high && high === low && low === close) continue; // filter zero-range
    candles.push({ timestamp, open, high, low, close, volume, symbol });
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  const filtered = filterPrimaryContract(candles);
  console.log(`  Loaded ${filtered.length} candles (${candles.length} before primary contract filter)`);
  return filtered;
}

// ============================================================================
// Swing Detection
// ============================================================================

function findSwingHighs(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candle.high) { isSwing = false; break; }
    }
    if (isSwing) {
      swings.push({ price: candle.high, close: candle.close, timestamp: candle.timestamp, index: i });
    }
  }
  return swings;
}

function findSwingLows(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low <= candle.low) { isSwing = false; break; }
    }
    if (isSwing) {
      swings.push({ price: candle.low, close: candle.close, timestamp: candle.timestamp, index: i });
    }
  }
  return swings;
}

// ============================================================================
// Session Classification
// ============================================================================

function getSession(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const [hourStr, minStr] = estString.split(':');
  const hour = parseInt(hourStr);
  const min = parseInt(minStr);
  const timeDecimal = hour + min / 60;

  if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
  if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
  if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
  return 'afterhours';
}

// ============================================================================
// MFE Analysis
// ============================================================================

function analyzeSwingOpportunity(candles, swing, type) {
  const entryIndex = swing.index + 1;
  if (entryIndex >= candles.length) return null;

  const entryPrice = swing.close; // entry around close of the swing candle
  const swingPrice = swing.price;
  const risk = Math.abs(swingPrice - entryPrice); // wick to close = stop distance
  let mfe = 0;
  let barsToMFE = 0;
  let barsToInvalidation = null;
  let runningMFE = 0;

  for (let i = entryIndex; i < candles.length; i++) {
    const c = candles[i];
    const barsSinceEntry = i - entryIndex;

    if (type === 'high') {
      // Short opportunity: favorable = down
      const favorable = entryPrice - c.low;
      if (favorable > runningMFE) {
        runningMFE = favorable;
        barsToMFE = barsSinceEntry;
      }
      // Invalidation: price takes out the swing high
      if (c.high > swingPrice) {
        barsToInvalidation = barsSinceEntry;
        break;
      }
    } else {
      // Long opportunity: favorable = up
      const favorable = c.high - entryPrice;
      if (favorable > runningMFE) {
        runningMFE = favorable;
        barsToMFE = barsSinceEntry;
      }
      // Invalidation: price takes out the swing low
      if (c.low < swingPrice) {
        barsToInvalidation = barsSinceEntry;
        break;
      }
    }
  }

  mfe = runningMFE;

  return {
    type,
    swingPrice,
    entryPrice,
    risk,
    mfe,
    barsToMFE,
    barsToInvalidation, // null = never invalidated in data window
    session: getSession(swing.timestamp),
    timestamp: new Date(swing.timestamp).toISOString()
  };
}

// ============================================================================
// Statistics
// ============================================================================

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function computeStats(results) {
  const mfes = results.map(r => r.mfe);
  const risks = results.map(r => r.risk);
  const barsToMFEs = results.map(r => r.barsToMFE);
  const barsToInval = results.filter(r => r.barsToInvalidation !== null).map(r => r.barsToInvalidation);

  return {
    count: results.length,
    risk: {
      avg: risks.reduce((a, b) => a + b, 0) / risks.length || 0,
      median: percentile(risks, 50),
      p25: percentile(risks, 25),
      p75: percentile(risks, 75),
      max: Math.max(...risks, 0)
    },
    mfe: {
      avg: mfes.reduce((a, b) => a + b, 0) / mfes.length || 0,
      median: percentile(mfes, 50),
      p25: percentile(mfes, 25),
      p75: percentile(mfes, 75),
      p90: percentile(mfes, 90),
      max: Math.max(...mfes, 0)
    },
    barsToMFE: {
      avg: barsToMFEs.reduce((a, b) => a + b, 0) / barsToMFEs.length || 0,
      median: percentile(barsToMFEs, 50),
    },
    barsToInvalidation: {
      avg: barsToInval.length > 0 ? barsToInval.reduce((a, b) => a + b, 0) / barsToInval.length : null,
      median: barsToInval.length > 0 ? percentile(barsToInval, 50) : null,
      neverInvalidated: results.filter(r => r.barsToInvalidation === null).length
    },
    thresholds: {}
  };
}

function formatNum(n, decimals = 1) {
  if (n === null || n === undefined) return 'N/A';
  return n.toFixed(decimals);
}

function formatPct(n, decimals = 1) {
  if (n === null || n === undefined) return 'N/A';
  return (n * 100).toFixed(decimals) + '%';
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const candles = await loadOHLCVData();
  if (candles.length === 0) {
    console.error('No candles loaded. Check date range and data file.');
    process.exit(1);
  }

  const allResults = {};

  for (const lookback of LOOKBACKS) {
    console.log(`\nAnalyzing lookback = ${lookback} bars...`);

    const highs = findSwingHighs(candles, lookback);
    const lows = findSwingLows(candles, lookback);
    console.log(`  Found ${highs.length} swing highs, ${lows.length} swing lows`);

    // Apply risk filter: skip swings where wick-to-close > MAX_STOP
    const filteredHighs = highs.filter(s => Math.abs(s.price - s.close) <= MAX_STOP);
    const filteredLows = lows.filter(s => Math.abs(s.price - s.close) <= MAX_STOP);
    const highsDropped = highs.length - filteredHighs.length;
    const lowsDropped = lows.length - filteredLows.length;
    console.log(`  After risk filter (stop <= ${MAX_STOP}pts): ${filteredHighs.length} highs (-${highsDropped}), ${filteredLows.length} lows (-${lowsDropped})`);

    const results = [];

    for (const swing of filteredHighs) {
      const r = analyzeSwingOpportunity(candles, swing, 'high');
      if (r) results.push(r);
    }
    for (const swing of filteredLows) {
      const r = analyzeSwingOpportunity(candles, swing, 'low');
      if (r) results.push(r);
    }

    // Compute stats
    const highResults = results.filter(r => r.type === 'high');
    const lowResults = results.filter(r => r.type === 'low');

    const allStats = computeStats(results);
    const highStats = computeStats(highResults);
    const lowStats = computeStats(lowResults);

    // Threshold win rates
    for (const threshold of MFE_THRESHOLDS) {
      const allHit = results.filter(r => r.mfe >= threshold).length;
      const highHit = highResults.filter(r => r.mfe >= threshold).length;
      const lowHit = lowResults.filter(r => r.mfe >= threshold).length;

      allStats.thresholds[threshold] = { count: allHit, rate: allHit / results.length };
      highStats.thresholds[threshold] = { count: highHit, rate: highResults.length > 0 ? highHit / highResults.length : 0 };
      lowStats.thresholds[threshold] = { count: lowHit, rate: lowResults.length > 0 ? lowHit / lowResults.length : 0 };
    }

    // Session breakdown
    const sessions = ['rth', 'premarket', 'overnight', 'afterhours'];
    const sessionStats = {};
    for (const sess of sessions) {
      const sessResults = results.filter(r => r.session === sess);
      if (sessResults.length === 0) continue;
      const stats = computeStats(sessResults);
      for (const threshold of MFE_THRESHOLDS) {
        const hit = sessResults.filter(r => r.mfe >= threshold).length;
        stats.thresholds[threshold] = { count: hit, rate: hit / sessResults.length };
      }
      sessionStats[sess] = stats;
    }

    allResults[lookback] = {
      all: allStats,
      highs: highStats,
      lows: lowStats,
      sessions: sessionStats,
      rawResults: results
    };

    // Print summary for this lookback
    printLookbackSummary(lookback, allStats, highStats, lowStats, sessionStats);
  }

  // Print comparison table
  printComparisonTable(allResults);

  // Save results (without raw data for the comparison, but include raw for detailed analysis)
  const outputData = {};
  for (const lb of LOOKBACKS) {
    const { rawResults, ...stats } = allResults[lb];
    outputData[lb] = {
      ...stats,
      rawResults // include for further analysis
    };
  }
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\nDetailed results saved to ${outputPath}`);
}

// ============================================================================
// Output Formatting
// ============================================================================

function printLookbackSummary(lookback, allStats, highStats, lowStats, sessionStats) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`LOOKBACK = ${lookback} BARS`);
  console.log(`${'─'.repeat(80)}`);

  console.log(`\n  Total swings: ${allStats.count} (${highStats.count} highs / ${lowStats.count} lows)`);

  // Risk distribution (stop distance)
  console.log(`\n  Risk / Stop Distance (points — wick to close):`);
  console.log(`  ${''.padEnd(12)} ${'Avg'.padStart(8)} ${'Med'.padStart(8)} ${'P25'.padStart(8)} ${'P75'.padStart(8)} ${'Max'.padStart(8)}`);
  for (const [label, stats] of [['All', allStats], ['Highs (S)', highStats], ['Lows (L)', lowStats]]) {
    console.log(`  ${label.padEnd(12)} ${formatNum(stats.risk.avg).padStart(8)} ${formatNum(stats.risk.median).padStart(8)} ${formatNum(stats.risk.p25).padStart(8)} ${formatNum(stats.risk.p75).padStart(8)} ${formatNum(stats.risk.max).padStart(8)}`);
  }

  // MFE distribution
  console.log(`\n  MFE Distribution (points):`);
  console.log(`  ${''.padEnd(12)} ${'Avg'.padStart(8)} ${'Med'.padStart(8)} ${'P25'.padStart(8)} ${'P75'.padStart(8)} ${'P90'.padStart(8)} ${'Max'.padStart(8)}`);
  for (const [label, stats] of [['All', allStats], ['Highs (S)', highStats], ['Lows (L)', lowStats]]) {
    console.log(`  ${label.padEnd(12)} ${formatNum(stats.mfe.avg).padStart(8)} ${formatNum(stats.mfe.median).padStart(8)} ${formatNum(stats.mfe.p25).padStart(8)} ${formatNum(stats.mfe.p75).padStart(8)} ${formatNum(stats.mfe.p90).padStart(8)} ${formatNum(stats.mfe.max).padStart(8)}`);
  }

  // Threshold win rates
  console.log(`\n  Win Rates by MFE Threshold:`);
  const threshHeader = `  ${''.padEnd(12)} ` + MFE_THRESHOLDS.map(t => `${t}+pts`.padStart(12)).join('');
  console.log(threshHeader);
  for (const [label, stats] of [['All', allStats], ['Highs (S)', highStats], ['Lows (L)', lowStats]]) {
    const row = MFE_THRESHOLDS.map(t => {
      const th = stats.thresholds[t];
      return `${formatPct(th.rate)} (${th.count})`.padStart(12);
    }).join('');
    console.log(`  ${label.padEnd(12)} ${row}`);
  }

  // Timing
  console.log(`\n  Timing (bars):`);
  console.log(`  ${''.padEnd(12)} ${'MFE avg'.padStart(10)} ${'MFE med'.padStart(10)} ${'Inval avg'.padStart(10)} ${'Inval med'.padStart(10)} ${'Never inv'.padStart(10)}`);
  for (const [label, stats] of [['All', allStats], ['Highs (S)', highStats], ['Lows (L)', lowStats]]) {
    console.log(`  ${label.padEnd(12)} ${formatNum(stats.barsToMFE.avg).padStart(10)} ${formatNum(stats.barsToMFE.median).padStart(10)} ${formatNum(stats.barsToInvalidation.avg).padStart(10)} ${formatNum(stats.barsToInvalidation.median).padStart(10)} ${String(stats.barsToInvalidation.neverInvalidated).padStart(10)}`);
  }

  // Session breakdown
  if (Object.keys(sessionStats).length > 0) {
    console.log(`\n  Session Breakdown:`);
    console.log(`  ${'Session'.padEnd(14)} ${'Count'.padStart(7)} ${'MFE avg'.padStart(9)} ${'MFE med'.padStart(9)} ${'30+pts'.padStart(12)} ${'50+pts'.padStart(12)} ${'75+pts'.padStart(12)} ${'100+pts'.padStart(12)}`);
    for (const [sess, stats] of Object.entries(sessionStats)) {
      const threshCols = MFE_THRESHOLDS.map(t => {
        const th = stats.thresholds[t];
        return `${formatPct(th.rate)}`.padStart(12);
      }).join('');
      console.log(`  ${sess.padEnd(14)} ${String(stats.count).padStart(7)} ${formatNum(stats.mfe.avg).padStart(9)} ${formatNum(stats.mfe.median).padStart(9)} ${threshCols}`);
    }
  }
}

function printComparisonTable(allResults) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('COMPARISON ACROSS LOOKBACK VALUES');
  console.log(`${'='.repeat(80)}`);

  // Overview
  console.log(`\n  ${'Lookback'.padEnd(10)} ${'Swings'.padStart(8)} ${'Highs'.padStart(8)} ${'Lows'.padStart(8)} ${'MFE avg'.padStart(9)} ${'MFE med'.padStart(9)} ${'MFE p90'.padStart(9)} ${'Inval avg'.padStart(10)}`);
  console.log(`  ${'─'.repeat(72)}`);
  for (const lb of LOOKBACKS) {
    const s = allResults[lb].all;
    console.log(`  ${String(lb).padEnd(10)} ${String(s.count).padStart(8)} ${String(allResults[lb].highs.count).padStart(8)} ${String(allResults[lb].lows.count).padStart(8)} ${formatNum(s.mfe.avg).padStart(9)} ${formatNum(s.mfe.median).padStart(9)} ${formatNum(s.mfe.p90).padStart(9)} ${formatNum(s.barsToInvalidation.avg).padStart(10)}`);
  }

  // Threshold comparison
  console.log(`\n  Win rates at each threshold:`);
  const threshHeader = `  ${'Lookback'.padEnd(10)} ` + MFE_THRESHOLDS.map(t => `${t}+pts`.padStart(14)).join('');
  console.log(threshHeader);
  console.log(`  ${'─'.repeat(66)}`);
  for (const lb of LOOKBACKS) {
    const s = allResults[lb].all;
    const row = MFE_THRESHOLDS.map(t => {
      const th = s.thresholds[t];
      return `${formatPct(th.rate)} (${th.count})`.padStart(14);
    }).join('');
    console.log(`  ${String(lb).padEnd(10)} ${row}`);
  }

  // Long vs short comparison
  console.log(`\n  Long (swing lows) vs Short (swing highs) — MFE avg / 50+pts rate:`);
  console.log(`  ${'Lookback'.padEnd(10)} ${'Long MFE'.padStart(10)} ${'Long 50+'.padStart(10)} ${'Short MFE'.padStart(11)} ${'Short 50+'.padStart(11)}`);
  console.log(`  ${'─'.repeat(54)}`);
  for (const lb of LOOKBACKS) {
    const h = allResults[lb].highs;
    const l = allResults[lb].lows;
    console.log(`  ${String(lb).padEnd(10)} ${formatNum(l.mfe.avg).padStart(10)} ${formatPct(l.thresholds[50]?.rate).padStart(10)} ${formatNum(h.mfe.avg).padStart(11)} ${formatPct(h.thresholds[50]?.rate).padStart(11)}`);
  }

  // Best session per lookback
  console.log(`\n  Best session by 50+pts win rate:`);
  console.log(`  ${'Lookback'.padEnd(10)} ${'Best session'.padEnd(14)} ${'Rate'.padStart(8)} ${'Count'.padStart(8)}`);
  console.log(`  ${'─'.repeat(42)}`);
  for (const lb of LOOKBACKS) {
    const sessions = allResults[lb].sessions;
    let bestSess = '', bestRate = 0, bestCount = 0;
    for (const [sess, stats] of Object.entries(sessions)) {
      const th = stats.thresholds[50];
      if (th && th.rate > bestRate) {
        bestRate = th.rate;
        bestSess = sess;
        bestCount = th.count;
      }
    }
    console.log(`  ${String(lb).padEnd(10)} ${bestSess.padEnd(14)} ${formatPct(bestRate).padStart(8)} ${String(bestCount).padStart(8)}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
