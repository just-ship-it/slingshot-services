#!/usr/bin/env node
/**
 * IV Skew Correlation at Bar 40 — Do stagnant trades have weakened/flipped skew?
 *
 * For trades open 40+ bars with MFE < 50pts (the "stuck" trades), this script
 * checks whether the IV skew at bar 40 still supports the trade direction or
 * has flipped/weakened. If skew flips, the original thesis is gone and exiting
 * makes sense regardless of P&L.
 *
 * Signal thresholds (from iv-skew-gex.js):
 *   LONG entry:  skew < -0.01  (calls cheaper = bullish flow)
 *   SHORT entry: skew > +0.01  (puts expensive = bearish flow)
 *
 * Usage:
 *   node scripts/analyze-iv-skew-at-40bars.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { IVLoader } from '../src/data-loaders/iv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const TRADE_CSV = '/tmp/iv-skew-trades.csv';
const FORTY_BARS_MS = 40 * 60 * 1000;
const MFE_THRESHOLD = 50;

// Skew thresholds from the strategy
const NEG_SKEW_THRESHOLD = -0.01; // Long entry: skew < this
const POS_SKEW_THRESHOLD = +0.01; // Short entry: skew > this

// ═══════════════════════════════════════════════════════════════════════
// Load trades from CSV
// ═══════════════════════════════════════════════════════════════════════

function loadTrades(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');

  const idx = (col) => header.indexOf(col);

  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return {
      id: cols[idx('TradeID')],
      side: cols[idx('Side')],
      entryTime: cols[idx('EntryTime')],
      entryTimeMs: new Date(cols[idx('EntryTime')]).getTime(),
      exitTime: cols[idx('ExitTime')],
      entryPrice: parseFloat(cols[idx('EntryPrice')]),
      exitPrice: parseFloat(cols[idx('ExitPrice')]),
      exitReason: cols[idx('ExitReason')],
      mfePoints: parseFloat(cols[idx('MFEPoints')]),
      maePoints: parseFloat(cols[idx('MAEPoints')]),
      pointsPnl: parseFloat(cols[idx('PointsPnL')]),
      netPnl: parseFloat(cols[idx('NetPnL')]),
      duration: parseInt(cols[idx('Duration')]),
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Classify skew relative to trade direction
// ═══════════════════════════════════════════════════════════════════════

function classifySkew(skew, side) {
  if (side === 'long') {
    if (skew < NEG_SKEW_THRESHOLD) return 'supporting';   // Still bullish
    if (skew > POS_SKEW_THRESHOLD) return 'flipped';       // Now bearish
    return 'neutral';                                       // Dead zone
  } else {
    if (skew > POS_SKEW_THRESHOLD) return 'supporting';    // Still bearish
    if (skew < NEG_SKEW_THRESHOLD) return 'flipped';        // Now bullish
    return 'neutral';                                        // Dead zone
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('IV SKEW CORRELATION AT BAR 40 — Stagnant Trade Analysis');
console.log('═'.repeat(80));

// Load IV data
console.log('\nLoading IV data (1m resolution)...');
const ivLoader = new IVLoader(DATA_DIR, { resolution: '1m' });
await ivLoader.load(new Date('2025-01-13'), new Date('2026-01-23'));
console.log(`Loaded ${ivLoader.ivData.length} IV records\n`);

// Load trades
const allTrades = loadTrades(TRADE_CSV);
console.log(`Loaded ${allTrades.length} trades from CSV\n`);

// Filter: trades open 40+ bars with MFE < 50pts
const stuckTrades = allTrades.filter(t => t.duration >= FORTY_BARS_MS && t.mfePoints < MFE_THRESHOLD);
console.log(`Stuck trades (40+ bars, MFE < ${MFE_THRESHOLD}pts): ${stuckTrades.length}\n`);

// Also get the complement: trades open 40+ bars WITH MFE >= 50pts
const triggeredTrades = allTrades.filter(t => t.duration >= FORTY_BARS_MS && t.mfePoints >= MFE_THRESHOLD);

// ─── Analyze each stuck trade ────────────────────────────────────────

const results = { supporting: [], neutral: [], flipped: [] };
let noDataCount = 0;

for (const trade of stuckTrades) {
  const entryIV = ivLoader.getIVAtTime(trade.entryTimeMs);
  const bar40IV = ivLoader.getIVAtTime(trade.entryTimeMs + FORTY_BARS_MS);

  if (!entryIV || !bar40IV) {
    noDataCount++;
    continue;
  }

  const entrySkew = entryIV.skew;
  const bar40Skew = bar40IV.skew;
  const skewChange = bar40Skew - entrySkew;
  const classification = classifySkew(bar40Skew, trade.side);

  const record = {
    ...trade,
    entrySkew,
    bar40Skew,
    skewChange,
    classification,
    entryIV: entryIV.iv,
    bar40IV: bar40IV.iv,
    isWinner: trade.netPnl > 0,
  };

  results[classification].push(record);
}

if (noDataCount > 0) {
  console.log(`⚠️  ${noDataCount} trades skipped (no IV data at entry or bar 40)\n`);
}

// ─── Summary Table ──────────────────────────────────────────────────

console.log('─'.repeat(80));
console.log('SKEW STATE AT BAR 40 vs WIN/LOSS OUTCOME');
console.log('─'.repeat(80));
console.log('(Only trades open 40+ bars with MFE < 50pts)\n');

for (const [category, trades] of Object.entries(results)) {
  if (trades.length === 0) {
    console.log(`  ${category.toUpperCase()}: 0 trades\n`);
    continue;
  }

  const winners = trades.filter(t => t.isWinner);
  const losers = trades.filter(t => !t.isWinner);
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const avgPnl = totalPnl / trades.length;
  const avgSkewChange = trades.reduce((s, t) => s + t.skewChange, 0) / trades.length;
  const avgMFE = trades.reduce((s, t) => s + t.mfePoints, 0) / trades.length;

  console.log(`  ${category.toUpperCase()} (skew still ${category} at bar 40):`);
  console.log(`    Count:     ${trades.length} (${(trades.length / stuckTrades.length * 100).toFixed(0)}% of stuck trades)`);
  console.log(`    Winners:   ${winners.length} (${(winners.length / trades.length * 100).toFixed(1)}% WR)`);
  console.log(`    Losers:    ${losers.length}`);
  console.log(`    Total PnL: $${totalPnl.toFixed(0)}`);
  console.log(`    Avg PnL:   $${avgPnl.toFixed(0)}`);
  console.log(`    Avg MFE:   ${avgMFE.toFixed(1)}pts`);
  console.log(`    Avg skew change: ${avgSkewChange >= 0 ? '+' : ''}${(avgSkewChange * 100).toFixed(2)}%`);

  if (winners.length > 0) {
    const avgWinPnl = winners.reduce((s, t) => s + t.netPnl, 0) / winners.length;
    console.log(`    Avg win:   $${avgWinPnl.toFixed(0)}`);
  }
  if (losers.length > 0) {
    const avgLossPnl = losers.reduce((s, t) => s + t.netPnl, 0) / losers.length;
    console.log(`    Avg loss:  $${avgLossPnl.toFixed(0)}`);
  }
  console.log('');
}

// ─── Comparison: what does skew look like for SUCCESSFUL 40+ bar trades? ──

console.log('─'.repeat(80));
console.log('COMPARISON: Skew at bar 40 for SUCCESSFUL trades (MFE >= 50pts)');
console.log('─'.repeat(80));
console.log('');

const trigResults = { supporting: [], neutral: [], flipped: [] };
for (const trade of triggeredTrades) {
  const bar40IV = ivLoader.getIVAtTime(trade.entryTimeMs + FORTY_BARS_MS);
  if (!bar40IV) continue;
  const classification = classifySkew(bar40IV.skew, trade.side);
  trigResults[classification].push({ ...trade, isWinner: trade.netPnl > 0 });
}

for (const [category, trades] of Object.entries(trigResults)) {
  if (trades.length === 0) {
    console.log(`  ${category.toUpperCase()}: 0 trades`);
    continue;
  }
  const winners = trades.filter(t => t.isWinner);
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  console.log(`  ${category.toUpperCase()}: ${trades.length} trades | WR: ${(winners.length / trades.length * 100).toFixed(1)}% | Avg PnL: $${(totalPnl / trades.length).toFixed(0)}`);
}

// ─── Detailed skew change distribution ──────────────────────────────

console.log('\n' + '─'.repeat(80));
console.log('SKEW CHANGE DISTRIBUTION (entry → bar 40) for stuck trades');
console.log('─'.repeat(80));
console.log('');

// Group by skew change buckets
const allStuck = [...results.supporting, ...results.neutral, ...results.flipped];
const buckets = [
  { label: 'Strongly flipped (>+2%)', filter: t => {
    return (t.side === 'long' && t.skewChange > 0.02) || (t.side === 'short' && t.skewChange < -0.02);
  }},
  { label: 'Moderately flipped (+1-2%)', filter: t => {
    if (t.side === 'long') return t.skewChange > 0.01 && t.skewChange <= 0.02;
    return t.skewChange < -0.01 && t.skewChange >= -0.02;
  }},
  { label: 'Slightly weakened (0-1%)', filter: t => {
    if (t.side === 'long') return t.skewChange > 0 && t.skewChange <= 0.01;
    return t.skewChange < 0 && t.skewChange >= -0.01;
  }},
  { label: 'Strengthened (skew moved more in favor)', filter: t => {
    if (t.side === 'long') return t.skewChange <= 0; // More negative = more bullish
    return t.skewChange >= 0; // More positive = more bearish
  }},
];

for (const bucket of buckets) {
  const trades = allStuck.filter(bucket.filter);
  if (trades.length === 0) {
    console.log(`  ${bucket.label}: 0 trades`);
    continue;
  }
  const winners = trades.filter(t => t.isWinner);
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  console.log(`  ${bucket.label}: ${trades.length} trades | WR: ${(winners.length / trades.length * 100).toFixed(1)}% | Avg PnL: $${(totalPnl / trades.length).toFixed(0)} | Total: $${totalPnl.toFixed(0)}`);
}

// ─── Individual trade detail for flipped trades ─────────────────────

console.log('\n' + '─'.repeat(80));
console.log('DETAIL: Flipped skew trades (strongest signal for early exit)');
console.log('─'.repeat(80));
console.log('');

const flipped = results.flipped;
if (flipped.length > 0) {
  console.log(`${'ID'.padEnd(10)} ${'Side'.padEnd(6)} ${'EntrySkew'.padEnd(11)} ${'Bar40Skew'.padEnd(11)} ${'Change'.padEnd(10)} ${'MFE'.padEnd(8)} ${'PnL'.padEnd(10)} ${'Exit'.padEnd(15)} ${'W/L'}`);
  console.log('─'.repeat(95));
  for (const t of flipped.sort((a, b) => a.netPnl - b.netPnl)) {
    console.log(
      `${t.id.padEnd(10)} ${t.side.padEnd(6)} ${(t.entrySkew * 100).toFixed(2).padStart(7)}%   ${(t.bar40Skew * 100).toFixed(2).padStart(7)}%   ${(t.skewChange >= 0 ? '+' : '') + (t.skewChange * 100).toFixed(2).padStart(6)}%   ${t.mfePoints.toFixed(1).padStart(5)}   $${t.netPnl.toFixed(0).padStart(7)}   ${t.exitReason.padEnd(15)} ${t.isWinner ? 'W' : 'L'}`
    );
  }
} else {
  console.log('  No flipped skew trades found.');
}

// ─── Actionable summary ─────────────────────────────────────────────

console.log('\n' + '═'.repeat(80));
console.log('ACTIONABLE SUMMARY');
console.log('═'.repeat(80));
console.log('');

const totalStuck = allStuck.length;
const suppWR = results.supporting.length > 0
  ? (results.supporting.filter(t => t.isWinner).length / results.supporting.length * 100).toFixed(1)
  : 'N/A';
const neutWR = results.neutral.length > 0
  ? (results.neutral.filter(t => t.isWinner).length / results.neutral.length * 100).toFixed(1)
  : 'N/A';
const flipWR = results.flipped.length > 0
  ? (results.flipped.filter(t => t.isWinner).length / results.flipped.length * 100).toFixed(1)
  : 'N/A';

console.log(`At bar 40 with MFE < ${MFE_THRESHOLD}pts:`);
console.log(`  Skew still supporting entry: ${results.supporting.length} trades → ${suppWR}% WR`);
console.log(`  Skew neutral:                ${results.neutral.length} trades → ${neutWR}% WR`);
console.log(`  Skew flipped against entry:  ${results.flipped.length} trades → ${flipWR}% WR`);
console.log('');
console.log('If flipped skew has a significantly lower WR, we could add a conditional');
console.log('close_below rule: "at bar 40, if MFE < 50 AND skew has flipped, exit."');
