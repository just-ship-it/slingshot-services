#!/usr/bin/env node

/**
 * Compare 1-minute vs 1-second resolution backtest results
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(__dirname, '..', 'results');

// Load both result files
const latest = JSON.parse(fs.readFileSync(path.join(resultsDir, 'gex-scalper-latest.json'), 'utf-8'));
const s1 = JSON.parse(fs.readFileSync(path.join(resultsDir, 'gex-scalper-1s.json'), 'utf-8'));

console.log('═'.repeat(70));
console.log('  RESOLUTION COMPARISON: 1-Minute vs 1-Second');
console.log('═'.repeat(70));
console.log();

// Performance comparison
console.log('┌─ PERFORMANCE SUMMARY ─────────────────────────────────────────────┐');
console.log('│ Metric                    │ 1-Minute     │ 1-Second     │ Delta   │');
console.log('├───────────────────────────┼──────────────┼──────────────┼─────────┤');

function fmt(val, decimals = 2) {
  if (val === undefined || val === null) return 'N/A';
  return typeof val === 'number' ? val.toFixed(decimals) : String(val);
}

const perf1m = latest.performance.basic;
const perf1s = s1.performance.basic;

const rows = [
  ['Total Trades', perf1m.totalTrades, perf1s.totalTrades, 0],
  ['Win Rate (%)', perf1m.winRate, perf1s.winRate, 2],
  ['Total P&L ($)', perf1m.totalPnL, perf1s.totalPnL, 0],
  ['Avg Win ($)', perf1m.averageWin, perf1s.averageWin, 2],
  ['Avg Loss ($)', perf1m.averageLoss, perf1s.averageLoss, 2],
  ['Profit Factor', perf1m.profitFactor, perf1s.profitFactor, 2],
  ['Max Drawdown (%)', perf1m.maxDrawdown, perf1s.maxDrawdown, 2],
  ['Sharpe Ratio', perf1m.sharpeRatio, perf1s.sharpeRatio, 2],
];

for (const [label, v1m, v1s, dec] of rows) {
  const diff = (v1s || 0) - (v1m || 0);
  const diffStr = (diff >= 0 ? '+' : '') + fmt(diff, dec);
  console.log(
    '│ ' + label.padEnd(25) + ' │ ' +
    fmt(v1m, dec).padStart(12) + ' │ ' +
    fmt(v1s, dec).padStart(12) + ' │ ' +
    diffStr.padStart(7) + ' │'
  );
}
console.log('└───────────────────────────┴──────────────┴──────────────┴─────────┘');
console.log();

// Exit reason breakdown
console.log('┌─ EXIT REASON BREAKDOWN ───────────────────────────────────────────┐');
console.log('│ Exit Reason        │ 1-Minute │ 1-Second │  Delta │    % Change  │');
console.log('├────────────────────┼──────────┼──────────┼────────┼──────────────┤');

const exitReasons = ['stop_loss', 'take_profit', 'trailing_stop', 'timeout'];
for (const reason of exitReasons) {
  const c1m = latest.trades.filter(t => t.exitReason === reason).length;
  const c1s = s1.trades.filter(t => t.exitReason === reason).length;
  const diff = c1s - c1m;
  const pctChange = c1m > 0 ? ((diff / c1m) * 100).toFixed(1) + '%' : 'N/A';
  console.log(
    '│ ' + reason.padEnd(18) + ' │ ' +
    c1m.toString().padStart(8) + ' │ ' +
    c1s.toString().padStart(8) + ' │ ' +
    (diff >= 0 ? '+' : '') + diff.toString().padStart(5) + ' │ ' +
    pctChange.padStart(12) + ' │'
  );
}
console.log('└────────────────────┴──────────┴──────────┴────────┴──────────────┘');
console.log();

// Match trades by entry time to find differences
console.log('═'.repeat(70));
console.log('  TRADE-BY-TRADE COMPARISON');
console.log('═'.repeat(70));
console.log();

// Create maps keyed by entry time
const trades1m = new Map();
for (const t of latest.trades) {
  trades1m.set(t.entryTime, t);
}

const trades1s = new Map();
for (const t of s1.trades) {
  trades1s.set(t.entryTime, t);
}

// Find matching, different, and unique trades
let matchingSameOutcome = 0;
let matchingDifferentOutcome = 0;
let only1m = 0;
let only1s = 0;

const differentOutcomes = [];
const outcomeChanges = {
  'trailing_stop -> stop_loss': 0,
  'trailing_stop -> take_profit': 0,
  'trailing_stop -> timeout': 0,
  'take_profit -> stop_loss': 0,
  'take_profit -> trailing_stop': 0,
  'stop_loss -> trailing_stop': 0,
  'stop_loss -> take_profit': 0,
  'timeout -> stop_loss': 0,
  'timeout -> trailing_stop': 0,
  'other': 0
};

for (const [entryTime, t1m] of trades1m) {
  const t1s = trades1s.get(entryTime);

  if (!t1s) {
    only1m++;
  } else if (t1m.exitReason === t1s.exitReason) {
    matchingSameOutcome++;
  } else {
    matchingDifferentOutcome++;
    const key = `${t1m.exitReason} -> ${t1s.exitReason}`;
    if (outcomeChanges.hasOwnProperty(key)) {
      outcomeChanges[key]++;
    } else {
      outcomeChanges['other']++;
    }
    differentOutcomes.push({ t1m, t1s });
  }
}

for (const [entryTime, t1s] of trades1s) {
  if (!trades1m.has(entryTime)) {
    only1s++;
  }
}

console.log('Trade Matching Summary:');
console.log(`  Same entry, same outcome:      ${matchingSameOutcome}`);
console.log(`  Same entry, different outcome: ${matchingDifferentOutcome}`);
console.log(`  Only in 1-minute results:      ${only1m}`);
console.log(`  Only in 1-second results:      ${only1s}`);
console.log();

console.log('Outcome Changes (1-minute -> 1-second):');
for (const [change, count] of Object.entries(outcomeChanges)) {
  if (count > 0) {
    console.log(`  ${change}: ${count}`);
  }
}
console.log();

// P&L impact of outcome changes
console.log('═'.repeat(70));
console.log('  P&L IMPACT ANALYSIS');
console.log('═'.repeat(70));
console.log();

let trailingToStopPnLDiff = 0;
let trailingToStopCount = 0;

for (const { t1m, t1s } of differentOutcomes) {
  if (t1m.exitReason === 'trailing_stop' && t1s.exitReason === 'stop_loss') {
    trailingToStopPnLDiff += (t1s.netPnL - t1m.netPnL);
    trailingToStopCount++;
  }
}

console.log('Trailing Stop -> Stop Loss conversions:');
console.log(`  Count: ${trailingToStopCount}`);
console.log(`  Total P&L difference: $${trailingToStopPnLDiff.toFixed(2)}`);
console.log(`  Avg P&L swing per trade: $${(trailingToStopPnLDiff / trailingToStopCount).toFixed(2)}`);
console.log();

// Look at trades where trailing stop was "valid" in 1m but became stop_loss in 1s
console.log('Sample of trailing_stop -> stop_loss trades:');
console.log('─'.repeat(70));
let sampleCount = 0;
for (const { t1m, t1s } of differentOutcomes) {
  if (t1m.exitReason === 'trailing_stop' && t1s.exitReason === 'stop_loss' && sampleCount < 5) {
    console.log(`Trade at ${new Date(t1m.entryTime).toISOString()}:`);
    console.log(`  Side: ${t1m.side} | Entry: ${t1m.actualEntry}`);
    console.log(`  1m: ${t1m.exitReason} -> P&L $${t1m.netPnL.toFixed(2)}`);
    console.log(`  1s: ${t1s.exitReason} -> P&L $${t1s.netPnL.toFixed(2)}`);
    console.log(`  Swing: $${(t1s.netPnL - t1m.netPnL).toFixed(2)}`);
    console.log();
    sampleCount++;
  }
}

// Analyze winning vs losing trades
console.log('═'.repeat(70));
console.log('  WIN/LOSS DISTRIBUTION');
console.log('═'.repeat(70));
console.log();

const wins1m = latest.trades.filter(t => t.netPnL > 0).length;
const losses1m = latest.trades.filter(t => t.netPnL <= 0).length;
const wins1s = s1.trades.filter(t => t.netPnL > 0).length;
const losses1s = s1.trades.filter(t => t.netPnL <= 0).length;

console.log('                1-Minute    1-Second    Change');
console.log(`Winning trades: ${wins1m.toString().padStart(8)}    ${wins1s.toString().padStart(8)}    ${(wins1s - wins1m >= 0 ? '+' : '')}${wins1s - wins1m}`);
console.log(`Losing trades:  ${losses1m.toString().padStart(8)}    ${losses1s.toString().padStart(8)}    ${(losses1s - losses1m >= 0 ? '+' : '')}${losses1s - losses1m}`);
console.log();

// Key insight
console.log('═'.repeat(70));
console.log('  KEY INSIGHT');
console.log('═'.repeat(70));
console.log();

const pnlOverstatement = perf1m.totalPnL - perf1s.totalPnL;
const overstatementPct = (pnlOverstatement / Math.abs(perf1s.totalPnL || 1)) * 100;

console.log(`The 1-minute resolution OVERSTATED P&L by $${pnlOverstatement.toFixed(2)}`);
console.log(`This is ${overstatementPct.toFixed(1)}% of the actual (1-second) P&L.`);
console.log();
console.log('Root cause: With a 3pt stop and 3pt trailing trigger, the 1-minute');
console.log('candle often spans BOTH levels. The simulator assumed the favorable');
console.log('outcome (trailing triggered), but 1-second data reveals the stop');
console.log('was actually hit first in most cases.');
console.log();
console.log('RECOMMENDATION: The 3/3/1 configuration was optimized against');
console.log('inaccurate 1-minute data. The parameter matrix test will identify');
console.log('which configurations actually perform well with accurate 1-second');
console.log('resolution.');
