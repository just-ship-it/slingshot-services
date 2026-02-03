#!/usr/bin/env node
/**
 * Analyze correlation between trade outcomes and ATM Implied Volatility
 *
 * Question: Do trades perform differently in high vs low IV environments?
 */

import fs from 'fs';
import path from 'path';

// Load backtest results
const resultsPath = './results/gex-pullback-with-trailing.json';
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

// Load IV data
const ivPath = './data/iv/qqq/qqq_atm_iv_15m.csv';
const ivContent = fs.readFileSync(ivPath, 'utf8');
const ivLines = ivContent.split('\n');
const ivHeader = ivLines[0].split(',');

const tsIdx = ivHeader.indexOf('timestamp');
const ivIdx = ivHeader.indexOf('iv');
const spotIdx = ivHeader.indexOf('spot_price');

// Build IV lookup map (timestamp -> IV) and daily closing IV map
const ivMap = new Map();
const dailyCloseIV = new Map(); // date string -> last IV of the day

for (let i = 1; i < ivLines.length; i++) {
  const cols = ivLines[i].split(',');
  if (cols.length < ivIdx + 1) continue;
  const ts = new Date(cols[tsIdx]).getTime();
  const iv = parseFloat(cols[ivIdx]);
  if (!isNaN(ts) && !isNaN(iv)) {
    ivMap.set(ts, { iv, spotPrice: parseFloat(cols[spotIdx]) });

    // Track daily closing IV (last reading of each day)
    const dateStr = new Date(ts).toISOString().split('T')[0];
    dailyCloseIV.set(dateStr, iv);
  }
}

console.log(`Loaded ${ivMap.size} IV readings`);
console.log(`Daily closing IVs: ${dailyCloseIV.size} days`);
console.log(`IV data range: ${new Date([...ivMap.keys()][0]).toISOString().split('T')[0]} to ${new Date([...ivMap.keys()].pop()).toISOString().split('T')[0]}`);

// Find IV for a timestamp - use previous day's close for overnight trades
function getIVForTimestamp(timestamp) {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();

  // Market hours: 14:30-21:00 UTC (9:30am-4pm ET)
  const isMarketHours = hour >= 14 && hour < 21;

  if (isMarketHours) {
    // Try exact 15-minute interval match
    const intervalTs = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

    if (ivMap.has(intervalTs)) {
      return { iv: ivMap.get(intervalTs).iv, source: 'realtime' };
    }

    // Try adjacent intervals (up to 1 hour)
    for (let offset = 1; offset <= 4; offset++) {
      const before = intervalTs - offset * 15 * 60 * 1000;
      const after = intervalTs + offset * 15 * 60 * 1000;
      if (ivMap.has(before)) return { iv: ivMap.get(before).iv, source: 'realtime' };
      if (ivMap.has(after)) return { iv: ivMap.get(after).iv, source: 'realtime' };
    }
  }

  // Overnight/pre-market: use previous trading day's closing IV
  const dateStr = date.toISOString().split('T')[0];

  // If before market open, use previous day
  // If after market close, use current day's close
  let lookupDate = dateStr;
  if (hour < 14) {
    // Before market open - find previous trading day
    const prevDate = new Date(date);
    prevDate.setUTCDate(prevDate.getUTCDate() - 1);
    lookupDate = prevDate.toISOString().split('T')[0];

    // Skip weekends
    while (!dailyCloseIV.has(lookupDate) && prevDate > new Date('2025-01-01')) {
      prevDate.setUTCDate(prevDate.getUTCDate() - 1);
      lookupDate = prevDate.toISOString().split('T')[0];
    }
  }

  if (dailyCloseIV.has(lookupDate)) {
    return { iv: dailyCloseIV.get(lookupDate), source: 'prev_close' };
  }

  // Try a few more days back
  const searchDate = new Date(date);
  for (let i = 0; i < 5; i++) {
    searchDate.setUTCDate(searchDate.getUTCDate() - 1);
    const searchStr = searchDate.toISOString().split('T')[0];
    if (dailyCloseIV.has(searchStr)) {
      return { iv: dailyCloseIV.get(searchStr), source: 'prev_close' };
    }
  }

  return null;
}

// Get trades and match with IV
const trades = results.trades;
const tradesWithIV = [];
let noIVCount = 0;
let realtimeCount = 0;
let prevCloseCount = 0;

for (const trade of trades) {
  const entryTime = trade.entryTime || trade.timestamp;
  const ivResult = getIVForTimestamp(entryTime);

  if (ivResult !== null) {
    tradesWithIV.push({
      ...trade,
      iv: ivResult.iv,
      ivSource: ivResult.source,
      isWinner: trade.netPnL > 0,
      exitReason: trade.exitReason
    });
    if (ivResult.source === 'realtime') realtimeCount++;
    else prevCloseCount++;
  } else {
    noIVCount++;
  }
}

console.log(`\nMatched ${tradesWithIV.length} trades with IV data`);
console.log(`  - Realtime IV: ${realtimeCount} trades (during market hours)`);
console.log(`  - Prev close IV: ${prevCloseCount} trades (overnight/pre-market)`);
console.log(`${noIVCount} trades had no IV data (pre-2025)\n`);

if (tradesWithIV.length === 0) {
  console.log('No trades with IV data to analyze!');
  process.exit(0);
}

// ============================================================================
// Analysis by IV Buckets
// ============================================================================

console.log('='.repeat(80));
console.log('TRADE PERFORMANCE BY IV LEVEL');
console.log('='.repeat(80));

const ivBuckets = {
  'Very Low (10-15%)': { min: 0.10, max: 0.15, trades: [] },
  'Low (15-20%)': { min: 0.15, max: 0.20, trades: [] },
  'Normal (20-25%)': { min: 0.20, max: 0.25, trades: [] },
  'Elevated (25-30%)': { min: 0.25, max: 0.30, trades: [] },
  'High (30-40%)': { min: 0.30, max: 0.40, trades: [] },
  'Very High (40%+)': { min: 0.40, max: 1.0, trades: [] }
};

for (const trade of tradesWithIV) {
  for (const [bucket, config] of Object.entries(ivBuckets)) {
    if (trade.iv >= config.min && trade.iv < config.max) {
      config.trades.push(trade);
      break;
    }
  }
}

console.log('\n--- Performance by IV Bucket ---\n');
console.log(
  'IV Level'.padEnd(22) +
  'Trades'.padEnd(10) +
  'Win%'.padEnd(10) +
  'Net PnL'.padEnd(14) +
  'Avg PnL'.padEnd(12) +
  'Avg IV'
);
console.log('-'.repeat(80));

for (const [bucket, config] of Object.entries(ivBuckets)) {
  const trades = config.trades;
  if (trades.length === 0) continue;

  const winners = trades.filter(t => t.isWinner).length;
  const winRate = (winners / trades.length * 100).toFixed(1);
  const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
  const avgPnL = totalPnL / trades.length;
  const avgIV = trades.reduce((sum, t) => sum + t.iv, 0) / trades.length;

  console.log(
    bucket.padEnd(22) +
    `${trades.length}`.padEnd(10) +
    `${winRate}%`.padEnd(10) +
    `$${totalPnL.toLocaleString()}`.padEnd(14) +
    `$${avgPnL.toFixed(0)}`.padEnd(12) +
    `${(avgIV * 100).toFixed(1)}%`
  );
}

// ============================================================================
// Analysis by Exit Reason and IV
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('EXIT REASONS BY IV LEVEL');
console.log('='.repeat(80));

const exitReasons = [...new Set(tradesWithIV.map(t => t.exitReason))];

console.log('\n--- Exit Reason Distribution by IV ---\n');

for (const [bucket, config] of Object.entries(ivBuckets)) {
  const trades = config.trades;
  if (trades.length === 0) continue;

  console.log(`\n${bucket} (${trades.length} trades):`);

  for (const reason of exitReasons) {
    const count = trades.filter(t => t.exitReason === reason).length;
    const pct = (count / trades.length * 100).toFixed(0);
    const avgPnL = trades.filter(t => t.exitReason === reason)
      .reduce((sum, t) => sum + t.netPnL, 0) / (count || 1);

    if (count > 0) {
      console.log(`  ${reason.padEnd(20)} ${count} (${pct}%)  avg: $${avgPnL.toFixed(0)}`);
    }
  }
}

// ============================================================================
// Statistical Summary
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STATISTICAL SUMMARY');
console.log('='.repeat(80));

// Split into high vs low IV
const medianIV = tradesWithIV.map(t => t.iv).sort((a, b) => a - b)[Math.floor(tradesWithIV.length / 2)];
const lowIVTrades = tradesWithIV.filter(t => t.iv < medianIV);
const highIVTrades = tradesWithIV.filter(t => t.iv >= medianIV);

const lowIVWinRate = lowIVTrades.filter(t => t.isWinner).length / lowIVTrades.length * 100;
const highIVWinRate = highIVTrades.filter(t => t.isWinner).length / highIVTrades.length * 100;

const lowIVPnL = lowIVTrades.reduce((sum, t) => sum + t.netPnL, 0);
const highIVPnL = highIVTrades.reduce((sum, t) => sum + t.netPnL, 0);

const lowIVAvgPnL = lowIVPnL / lowIVTrades.length;
const highIVAvgPnL = highIVPnL / highIVTrades.length;

console.log(`
Median IV: ${(medianIV * 100).toFixed(1)}%

LOW IV Trades (IV < ${(medianIV * 100).toFixed(1)}%):
  Count: ${lowIVTrades.length}
  Win Rate: ${lowIVWinRate.toFixed(1)}%
  Total PnL: $${lowIVPnL.toLocaleString()}
  Avg PnL/Trade: $${lowIVAvgPnL.toFixed(0)}

HIGH IV Trades (IV >= ${(medianIV * 100).toFixed(1)}%):
  Count: ${highIVTrades.length}
  Win Rate: ${highIVWinRate.toFixed(1)}%
  Total PnL: $${highIVPnL.toLocaleString()}
  Avg PnL/Trade: $${highIVAvgPnL.toFixed(0)}

Difference:
  Win Rate: ${(highIVWinRate - lowIVWinRate).toFixed(1)}% (high vs low)
  Avg PnL: $${(highIVAvgPnL - lowIVAvgPnL).toFixed(0)} (high vs low)
`);

// ============================================================================
// IV vs PnL Correlation
// ============================================================================

// Calculate Pearson correlation between IV and PnL
const ivValues = tradesWithIV.map(t => t.iv);
const pnlValues = tradesWithIV.map(t => t.netPnL);

const n = ivValues.length;
const sumIV = ivValues.reduce((a, b) => a + b, 0);
const sumPnL = pnlValues.reduce((a, b) => a + b, 0);
const sumIVPnL = ivValues.reduce((sum, iv, i) => sum + iv * pnlValues[i], 0);
const sumIV2 = ivValues.reduce((sum, iv) => sum + iv * iv, 0);
const sumPnL2 = pnlValues.reduce((sum, pnl) => sum + pnl * pnl, 0);

const correlation = (n * sumIVPnL - sumIV * sumPnL) /
  Math.sqrt((n * sumIV2 - sumIV * sumIV) * (n * sumPnL2 - sumPnL * sumPnL));

console.log('='.repeat(80));
console.log('CORRELATION ANALYSIS');
console.log('='.repeat(80));

console.log(`
Pearson Correlation (IV vs PnL): ${correlation.toFixed(3)}

Interpretation:
  -1.0 to -0.5: Strong negative correlation (high IV = lower PnL)
  -0.5 to -0.2: Moderate negative correlation
  -0.2 to  0.2: Weak/no correlation
   0.2 to  0.5: Moderate positive correlation
   0.5 to  1.0: Strong positive correlation (high IV = higher PnL)
`);

// ============================================================================
// Trailing Stop Effectiveness by IV
// ============================================================================

console.log('='.repeat(80));
console.log('TRAILING STOP EFFECTIVENESS BY IV');
console.log('='.repeat(80));

const trailingStops = tradesWithIV.filter(t => t.exitReason === 'trailing_stop');
const takeProfits = tradesWithIV.filter(t => t.exitReason === 'take_profit');
const stopLosses = tradesWithIV.filter(t => t.exitReason === 'stop_loss');

if (trailingStops.length > 0) {
  const lowIVTrails = trailingStops.filter(t => t.iv < medianIV);
  const highIVTrails = trailingStops.filter(t => t.iv >= medianIV);

  console.log(`
Trailing Stop Exits: ${trailingStops.length}
  Low IV (< ${(medianIV * 100).toFixed(1)}%): ${lowIVTrails.length} exits, avg PnL $${(lowIVTrails.reduce((s, t) => s + t.netPnL, 0) / (lowIVTrails.length || 1)).toFixed(0)}
  High IV (>= ${(medianIV * 100).toFixed(1)}%): ${highIVTrails.length} exits, avg PnL $${(highIVTrails.reduce((s, t) => s + t.netPnL, 0) / (highIVTrails.length || 1)).toFixed(0)}

Take Profit Exits: ${takeProfits.length}
Stop Loss Exits: ${stopLosses.length}
`);
} else {
  console.log('\nNo trailing stop exits in this dataset.');
}

// Save analysis
const analysis = {
  summary: {
    totalTrades: tradesWithIV.length,
    tradesWithoutIV: noIVCount,
    medianIV,
    correlation,
    lowIV: { count: lowIVTrades.length, winRate: lowIVWinRate, totalPnL: lowIVPnL, avgPnL: lowIVAvgPnL },
    highIV: { count: highIVTrades.length, winRate: highIVWinRate, totalPnL: highIVPnL, avgPnL: highIVAvgPnL }
  },
  byBucket: Object.fromEntries(
    Object.entries(ivBuckets).map(([k, v]) => [k, {
      count: v.trades.length,
      winRate: v.trades.length > 0 ? v.trades.filter(t => t.isWinner).length / v.trades.length * 100 : 0,
      totalPnL: v.trades.reduce((s, t) => s + t.netPnL, 0),
      avgPnL: v.trades.length > 0 ? v.trades.reduce((s, t) => s + t.netPnL, 0) / v.trades.length : 0
    }])
  ),
  trades: tradesWithIV.map(t => ({
    id: t.id,
    entryTime: t.entryTime,
    exitReason: t.exitReason,
    iv: t.iv,
    netPnL: t.netPnL,
    side: t.side
  }))
};

fs.writeFileSync('./results/iv-correlation-analysis.json', JSON.stringify(analysis, null, 2));
console.log('\nAnalysis saved to ./results/iv-correlation-analysis.json');
