#!/usr/bin/env node
/**
 * Time-Based Trailing Stop Optimization Analysis
 *
 * Deep dive into losers that were profitable (MFE >= 30) before stopping out.
 * Goal: Find optimal time-based trailing stop rules that protect profits without
 * clipping winners too early.
 *
 * Key insight: 64% of losers were up 30+ points before giving back 100+ points.
 *
 * Usage: node scripts/analyze-time-based-trailing.js [results-file]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

// ============================================================================
// Configuration
// ============================================================================

const resultsPath = process.argv[2] || 'results/iv_skew_gex_1m.json';
const dataDir = path.resolve(process.cwd(), 'data');

// ============================================================================
// Utility Functions
// ============================================================================

function printSeparator(title) {
  console.log('\n' + '═'.repeat(80));
  console.log(title);
  console.log('═'.repeat(80));
}

function printSubsection(title) {
  console.log('\n' + '─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

function calcStats(arr) {
  if (!arr || arr.length === 0) return { mean: NaN, std: NaN, min: NaN, max: NaN, median: NaN, count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  const std = Math.sqrt(variance);
  const median = arr.length % 2 === 0
    ? (sorted[arr.length / 2 - 1] + sorted[arr.length / 2]) / 2
    : sorted[Math.floor(arr.length / 2)];
  return { mean, std, min: sorted[0], max: sorted[sorted.length - 1], median, count: arr.length };
}

// ============================================================================
// OHLCV Loader with Primary Contract Filtering
// ============================================================================

function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;
  const contractVolumes = new Map();
  const result = [];

  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000));
    const symbol = candle.symbol;
    if (!contractVolumes.has(hourKey)) {
      contractVolumes.set(hourKey, new Map());
    }
    const hourData = contractVolumes.get(hourKey);
    const currentVol = hourData.get(symbol) || 0;
    hourData.set(symbol, currentVol + (candle.volume || 0));
  });

  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000));
    const hourData = contractVolumes.get(hourKey);
    if (!hourData) { result.push(candle); return; }

    let primarySymbol = '';
    let maxVolume = 0;
    for (const [symbol, volume] of hourData.entries()) {
      if (volume > maxVolume) { maxVolume = volume; primarySymbol = symbol; }
    }
    if (candle.symbol === primarySymbol) result.push(candle);
  });

  return result;
}

async function loadOHLCV(startDate, endDate) {
  const ohlcvPath = path.join(dataDir, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
  if (!fs.existsSync(ohlcvPath)) {
    console.warn(`OHLCV file not found: ${ohlcvPath}`);
    return new Map();
  }

  const rawCandles = [];
  return new Promise((resolve, reject) => {
    let headers = null;
    const stream = fs.createReadStream(ohlcvPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headers) { headers = line.split(','); return; }
      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);

      const timestamp = new Date(record.ts_event).getTime();
      const date = new Date(timestamp);
      if (date < startDate || date > endDate) return;
      if (record.symbol && record.symbol.includes('-')) return;

      rawCandles.push({
        timestamp, symbol: record.symbol,
        open: parseFloat(record.open), high: parseFloat(record.high),
        low: parseFloat(record.low), close: parseFloat(record.close),
        volume: parseInt(record.volume)
      });
    });

    rl.on('close', () => {
      const filteredCandles = filterPrimaryContract(rawCandles);
      const candles = new Map();
      filteredCandles.forEach(c => candles.set(c.timestamp, c));
      console.log(`Loaded ${candles.size} OHLCV candles`);
      resolve(candles);
    });
    rl.on('error', reject);
  });
}

// ============================================================================
// Trade Path Analysis - Get candle-by-candle P&L for each trade
// ============================================================================

function getTradeCandles(trade, candleMap) {
  const result = [];
  const sortedTimestamps = Array.from(candleMap.keys()).sort((a, b) => a - b);

  for (const ts of sortedTimestamps) {
    if (ts >= trade.entryTime && ts <= trade.exitTime) {
      result.push(candleMap.get(ts));
    }
    if (ts > trade.exitTime) break;
  }
  return result;
}

function calculateTradePath(trade, candleMap) {
  const candles = getTradeCandles(trade, candleMap);
  if (candles.length === 0) return null;

  const entryPrice = trade.actualEntry;
  const isLong = trade.side === 'long';
  const path = [];

  let runningMFE = 0;
  let runningMAE = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const barsInTrade = i + 1;
    const minutesInTrade = barsInTrade; // 1m candles

    // Calculate current P&L at this bar
    const unrealizedHigh = isLong
      ? candle.high - entryPrice
      : entryPrice - candle.low;
    const unrealizedLow = isLong
      ? candle.low - entryPrice
      : entryPrice - candle.high;
    const unrealizedClose = isLong
      ? candle.close - entryPrice
      : entryPrice - candle.close;

    // Update running MFE/MAE
    runningMFE = Math.max(runningMFE, unrealizedHigh);
    runningMAE = Math.max(runningMAE, -unrealizedLow);

    path.push({
      bar: barsInTrade,
      minutes: minutesInTrade,
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      unrealizedHigh,
      unrealizedLow,
      unrealizedClose,
      runningMFE,
      runningMAE
    });
  }

  return {
    trade,
    path,
    finalMFE: runningMFE,
    finalMAE: runningMAE,
    peakMFEBar: path.reduce((best, p) => p.runningMFE > best.runningMFE ? p : best, path[0]).bar,
    peakMAEBar: path.reduce((worst, p) => p.runningMAE > worst.runningMAE ? p : worst, path[0]).bar
  };
}

// ============================================================================
// Simulate Time-Based Trailing Stop
// ============================================================================

function simulateTimeBasedTrailingStop(tradePath, rules) {
  /**
   * Rules format:
   * [
   *   { afterBars: 10, ifMFE: 20, trailDistance: 15 },
   *   { afterBars: 20, ifMFE: 30, trailDistance: 10 },
   *   { afterBars: 30, ifMFE: 40, trailDistance: 5 },
   * ]
   *
   * Meaning: After 10 bars, if MFE >= 20, trail stop 15 pts behind peak
   */

  const { trade, path } = tradePath;
  const isLong = trade.side === 'long';
  const entryPrice = trade.actualEntry;
  const originalStop = trade.stopLoss;

  let currentStop = originalStop;
  let peakPrice = entryPrice;
  let exitBar = null;
  let exitPrice = null;
  let exitReason = null;

  for (const bar of path) {
    // Update peak price
    if (isLong) {
      peakPrice = Math.max(peakPrice, bar.high);
    } else {
      peakPrice = Math.min(peakPrice, bar.low);
    }

    // Check rules in order - apply the most aggressive applicable rule
    for (const rule of rules) {
      if (bar.bar >= rule.afterBars && bar.runningMFE >= rule.ifMFE) {
        const newStop = isLong
          ? peakPrice - rule.trailDistance
          : peakPrice + rule.trailDistance;

        // Only tighten, never loosen
        if (isLong && newStop > currentStop) {
          currentStop = newStop;
        } else if (!isLong && newStop < currentStop) {
          currentStop = newStop;
        }
      }
    }

    // Check if stop was hit this bar
    if (isLong && bar.low <= currentStop) {
      exitBar = bar.bar;
      exitPrice = currentStop;
      exitReason = 'time_trail_stop';
      break;
    } else if (!isLong && bar.high >= currentStop) {
      exitBar = bar.bar;
      exitPrice = currentStop;
      exitReason = 'time_trail_stop';
      break;
    }

    // Check if original target hit
    if (isLong && bar.high >= trade.takeProfit) {
      exitBar = bar.bar;
      exitPrice = trade.takeProfit;
      exitReason = 'take_profit';
      break;
    } else if (!isLong && bar.low <= trade.takeProfit) {
      exitBar = bar.bar;
      exitPrice = trade.takeProfit;
      exitReason = 'take_profit';
      break;
    }
  }

  // If no exit during path, use original exit
  if (!exitBar) {
    exitBar = path.length;
    exitPrice = trade.actualExit;
    exitReason = trade.exitReason;
  }

  const pnlPoints = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
  const pnlDollars = pnlPoints * 20; // NQ point value

  return {
    trade,
    originalPnL: trade.netPnL,
    newPnL: pnlDollars - 5, // minus commission
    exitBar,
    exitPrice,
    exitReason,
    improved: pnlDollars - 5 > trade.netPnL
  };
}

// ============================================================================
// Main Analysis
// ============================================================================

async function main() {
  printSeparator('TIME-BASED TRAILING STOP OPTIMIZATION');

  // Load trade results
  console.log(`\nLoading trade results from: ${resultsPath}`);
  const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));

  const trades = data.trades.filter(t => t.status === 'completed');
  const winners = trades.filter(t => t.netPnL > 0);
  const losers = trades.filter(t => t.netPnL < 0);

  console.log(`Loaded ${trades.length} trades: ${winners.length} winners, ${losers.length} losers`);

  // Get date range
  const timestamps = trades.map(t => t.entryTime);
  const startDate = new Date(Math.min(...timestamps));
  const endDate = new Date(Math.max(...timestamps));
  startDate.setDate(startDate.getDate() - 1);
  endDate.setDate(endDate.getDate() + 1);

  // Load OHLCV
  console.log('Loading OHLCV data...');
  const candleMap = await loadOHLCV(startDate, endDate);

  // Calculate trade paths for all trades
  printSeparator('1. ANALYZING TRADE PATHS');

  const tradePaths = [];
  let pathsFound = 0;

  for (const trade of trades) {
    const tradePath = calculateTradePath(trade, candleMap);
    if (tradePath && tradePath.path.length > 0) {
      tradePaths.push(tradePath);
      pathsFound++;
    }
  }

  console.log(`Calculated paths for ${pathsFound}/${trades.length} trades`);

  // Separate winners and losers with paths
  const winnerPaths = tradePaths.filter(tp => tp.trade.netPnL > 0);
  const loserPaths = tradePaths.filter(tp => tp.trade.netPnL < 0);

  // Find losers that were profitable
  const profitableLosers = loserPaths.filter(tp => tp.finalMFE >= 30);

  printSubsection('Losers That Were Profitable (MFE >= 30 pts)');
  console.log(`\nCount: ${profitableLosers.length} of ${loserPaths.length} losers (${(profitableLosers.length/loserPaths.length*100).toFixed(1)}%)`);

  // Analyze these trades in detail
  console.log(`\n${'Trade'.padEnd(10)} │ ${'Side'.padEnd(6)} │ ${'MFE'.padStart(6)} │ ${'MAE'.padStart(6)} │ ${'Peak Bar'.padStart(9)} │ ${'Final P&L'.padStart(10)} │ ${'Exit'.padEnd(15)}`);
  console.log('─'.repeat(80));

  profitableLosers.slice(0, 20).forEach(tp => {
    console.log(
      `${tp.trade.id.padEnd(10)} │ ` +
      `${tp.trade.side.padEnd(6)} │ ` +
      `${tp.finalMFE.toFixed(0).padStart(6)} │ ` +
      `${tp.finalMAE.toFixed(0).padStart(6)} │ ` +
      `${tp.peakMFEBar.toString().padStart(9)} │ ` +
      `$${tp.trade.netPnL.toFixed(0).padStart(9)} │ ` +
      `${tp.trade.exitReason.padEnd(15)}`
    );
  });

  if (profitableLosers.length > 20) {
    console.log(`... and ${profitableLosers.length - 20} more`);
  }

  // Statistics on profitable losers
  printSubsection('Statistics: Losers That Were Profitable');

  const plMFEs = profitableLosers.map(tp => tp.finalMFE);
  const plMAEs = profitableLosers.map(tp => tp.finalMAE);
  const plPeakBars = profitableLosers.map(tp => tp.peakMFEBar);
  const plDurations = profitableLosers.map(tp => tp.path.length);

  console.log(`\nMFE (peak profit before reversal):`);
  console.log(`  Mean: ${calcStats(plMFEs).mean.toFixed(1)} pts`);
  console.log(`  Median: ${calcStats(plMFEs).median.toFixed(1)} pts`);
  console.log(`  Max: ${calcStats(plMFEs).max.toFixed(1)} pts`);

  console.log(`\nBar when peak MFE occurred:`);
  console.log(`  Mean: ${calcStats(plPeakBars).mean.toFixed(1)} bars`);
  console.log(`  Median: ${calcStats(plPeakBars).median.toFixed(1)} bars`);
  console.log(`  Min: ${calcStats(plPeakBars).min} bars`);
  console.log(`  Max: ${calcStats(plPeakBars).max} bars`);

  console.log(`\nTotal trade duration:`);
  console.log(`  Mean: ${calcStats(plDurations).mean.toFixed(1)} bars`);
  console.log(`  Median: ${calcStats(plDurations).median.toFixed(1)} bars`);

  // Compare to winners
  printSubsection('Comparison: Winners vs Profitable Losers');

  const winMFEs = winnerPaths.map(tp => tp.finalMFE);
  const winPeakBars = winnerPaths.map(tp => tp.peakMFEBar);
  const winDurations = winnerPaths.map(tp => tp.path.length);

  console.log(`\n${'Metric'.padEnd(25)} │ ${'Winners'.padStart(12)} │ ${'Prof. Losers'.padStart(12)}`);
  console.log('─'.repeat(55));
  console.log(`${'Avg MFE (pts)'.padEnd(25)} │ ${calcStats(winMFEs).mean.toFixed(1).padStart(12)} │ ${calcStats(plMFEs).mean.toFixed(1).padStart(12)}`);
  console.log(`${'Avg Peak MFE Bar'.padEnd(25)} │ ${calcStats(winPeakBars).mean.toFixed(1).padStart(12)} │ ${calcStats(plPeakBars).mean.toFixed(1).padStart(12)}`);
  console.log(`${'Avg Duration (bars)'.padEnd(25)} │ ${calcStats(winDurations).mean.toFixed(1).padStart(12)} │ ${calcStats(plDurations).mean.toFixed(1).padStart(12)}`);

  // ============================================================================
  // SIMULATE DIFFERENT TRAILING STOP RULES
  // ============================================================================

  printSeparator('2. TRAILING STOP RULE SIMULATION');

  const rulesets = [
    {
      name: 'Conservative: 30 pts trail after 15 bars',
      rules: [
        { afterBars: 15, ifMFE: 20, trailDistance: 30 },
      ]
    },
    {
      name: 'Moderate: 25 pts trail after 15 bars, 20 after 25',
      rules: [
        { afterBars: 15, ifMFE: 20, trailDistance: 25 },
        { afterBars: 25, ifMFE: 30, trailDistance: 20 },
      ]
    },
    {
      name: 'Aggressive: 20 pts trail after 10 bars, 15 after 20',
      rules: [
        { afterBars: 10, ifMFE: 15, trailDistance: 20 },
        { afterBars: 20, ifMFE: 25, trailDistance: 15 },
      ]
    },
    {
      name: 'Time-decay: Progressively tighter',
      rules: [
        { afterBars: 10, ifMFE: 15, trailDistance: 35 },
        { afterBars: 20, ifMFE: 25, trailDistance: 25 },
        { afterBars: 30, ifMFE: 35, trailDistance: 15 },
        { afterBars: 40, ifMFE: 40, trailDistance: 10 },
      ]
    },
    {
      name: 'Breakeven after 15 bars if +20',
      rules: [
        { afterBars: 15, ifMFE: 20, trailDistance: 0 }, // trailDistance 0 = breakeven
      ]
    },
    {
      name: 'Lock 50% after 20 bars',
      rules: [
        { afterBars: 20, ifMFE: 30, trailDistance: 15 }, // 30 MFE - 15 trail = lock 15 pts
        { afterBars: 30, ifMFE: 40, trailDistance: 20 }, // 40 MFE - 20 trail = lock 20 pts
      ]
    },
    {
      name: 'Very Conservative: 40 pts trail after 25 bars',
      rules: [
        { afterBars: 25, ifMFE: 30, trailDistance: 40 },
      ]
    },
    {
      name: 'Protect 30 pts profit after 30 bars',
      rules: [
        { afterBars: 30, ifMFE: 40, trailDistance: 10 }, // Lock in 30 pts if was up 40+
      ]
    },
  ];

  console.log(`\nSimulating ${rulesets.length} trailing stop strategies...`);

  for (const ruleset of rulesets) {
    printSubsection(ruleset.name);

    let totalOriginalPnL = 0;
    let totalNewPnL = 0;
    let winnersImproved = 0;
    let winnersHurt = 0;
    let losersImproved = 0;
    let losersHurt = 0;
    let profitableLosersFixed = 0;

    const winnerResults = [];
    const loserResults = [];

    for (const tp of tradePaths) {
      const result = simulateTimeBasedTrailingStop(tp, ruleset.rules);
      totalOriginalPnL += result.originalPnL;
      totalNewPnL += result.newPnL;

      if (tp.trade.netPnL > 0) {
        winnerResults.push(result);
        if (result.newPnL > result.originalPnL) winnersImproved++;
        else if (result.newPnL < result.originalPnL) winnersHurt++;
      } else {
        loserResults.push(result);
        if (result.newPnL > result.originalPnL) {
          losersImproved++;
          if (tp.finalMFE >= 30) profitableLosersFixed++;
        }
        else if (result.newPnL < result.originalPnL) losersHurt++;
      }
    }

    const pnlDiff = totalNewPnL - totalOriginalPnL;

    console.log(`\nResults:`);
    console.log(`  Original P&L: $${totalOriginalPnL.toFixed(0)}`);
    console.log(`  New P&L:      $${totalNewPnL.toFixed(0)}`);
    console.log(`  Difference:   ${pnlDiff >= 0 ? '+' : ''}$${pnlDiff.toFixed(0)}`);
    console.log(`\nWinners: ${winnersImproved} improved, ${winnersHurt} hurt, ${winnerResults.length - winnersImproved - winnersHurt} unchanged`);
    console.log(`Losers:  ${losersImproved} improved, ${losersHurt} hurt, ${loserResults.length - losersImproved - losersHurt} unchanged`);
    console.log(`Profitable losers fixed: ${profitableLosersFixed}/${profitableLosers.length} (${(profitableLosersFixed/profitableLosers.length*100).toFixed(0)}%)`);
  }

  // ============================================================================
  // DETAILED ANALYSIS: When do profitable losers peak?
  // ============================================================================

  printSeparator('3. WHEN DO PROFITABLE LOSERS PEAK?');

  // Bucket by peak MFE bar
  const peakBuckets = [
    { name: '1-5 bars', min: 1, max: 5, count: 0, trades: [] },
    { name: '6-10 bars', min: 6, max: 10, count: 0, trades: [] },
    { name: '11-15 bars', min: 11, max: 15, count: 0, trades: [] },
    { name: '16-20 bars', min: 16, max: 20, count: 0, trades: [] },
    { name: '21-30 bars', min: 21, max: 30, count: 0, trades: [] },
    { name: '31-45 bars', min: 31, max: 45, count: 0, trades: [] },
    { name: '46-60 bars', min: 46, max: 60, count: 0, trades: [] },
  ];

  profitableLosers.forEach(tp => {
    for (const bucket of peakBuckets) {
      if (tp.peakMFEBar >= bucket.min && tp.peakMFEBar <= bucket.max) {
        bucket.count++;
        bucket.trades.push(tp);
        break;
      }
    }
  });

  console.log(`\n${'Peak Bar Range'.padEnd(15)} │ ${'Count'.padStart(6)} │ ${'% of Losers'.padStart(12)} │ ${'Avg MFE'.padStart(10)} │ ${'Avg Loss'.padStart(10)}`);
  console.log('─'.repeat(65));

  peakBuckets.forEach(bucket => {
    if (bucket.count === 0) return;
    const avgMFE = bucket.trades.reduce((s, t) => s + t.finalMFE, 0) / bucket.count;
    const avgLoss = bucket.trades.reduce((s, t) => s + t.trade.netPnL, 0) / bucket.count;
    console.log(
      `${bucket.name.padEnd(15)} │ ` +
      `${bucket.count.toString().padStart(6)} │ ` +
      `${(bucket.count/profitableLosers.length*100).toFixed(1).padStart(11)}% │ ` +
      `${avgMFE.toFixed(0).padStart(10)} │ ` +
      `$${avgLoss.toFixed(0).padStart(9)}`
    );
  });

  // ============================================================================
  // OPTIMAL RULE RECOMMENDATION
  // ============================================================================

  printSeparator('4. RECOMMENDED RULES');

  // Find the sweet spot
  const earlyPeakers = profitableLosers.filter(tp => tp.peakMFEBar <= 15);
  const midPeakers = profitableLosers.filter(tp => tp.peakMFEBar > 15 && tp.peakMFEBar <= 30);
  const latePeakers = profitableLosers.filter(tp => tp.peakMFEBar > 30);

  console.log(`\nProfitable loser distribution by peak timing:`);
  console.log(`  Early (1-15 bars):  ${earlyPeakers.length} (${(earlyPeakers.length/profitableLosers.length*100).toFixed(0)}%)`);
  console.log(`  Mid (16-30 bars):   ${midPeakers.length} (${(midPeakers.length/profitableLosers.length*100).toFixed(0)}%)`);
  console.log(`  Late (31-60 bars):  ${latePeakers.length} (${(latePeakers.length/profitableLosers.length*100).toFixed(0)}%)`);

  console.log(`\n${'='}'.repeat(60)}`);
  console.log(`RECOMMENDATION:`);
  console.log(`${'='}'.repeat(60)}`);
  console.log(`
Based on the analysis:

1. AFTER 15 BARS: If MFE >= 25 pts, trail stop 25 pts behind peak
   - Catches early peakers without being too aggressive
   - At 25 bars in, a trade up 25+ pts should not give it all back

2. AFTER 25 BARS: If MFE >= 35 pts, tighten trail to 15 pts
   - If trade has been open 25+ min and was up 35+, protect more
   - Still allows 15 pts of wiggle room

3. AFTER 35 BARS: If MFE >= 45 pts, tighten trail to 10 pts
   - Deep in trade, was highly profitable, lock it in
   - Only 10 pts of room to breathe

This progressive approach should:
- Protect the ${profitableLosers.length} losers that were up 30+ pts
- Minimize impact on winners (most hit target before 25 bars)
- Allow normal volatility early in trade
`);

  console.log('\nAnalysis complete.');
}

main().catch(console.error);
