#!/usr/bin/env node
/**
 * Test candidate filters on the existing 143 gex-flip-ivpct trades.
 *
 * Each filter is a predicate over the entry-time feature set. We compare:
 *   - kept count + dropped count
 *   - clean-rate (MAE <= threshold) of survivors vs original
 *   - WR / PF / total PnL / max consecutive drawdown of survivors at ORIGINAL stops
 *   - Same metrics if we then re-apply a tight 10/20 or 15/30 (stop/tgt) cap
 *
 * Important caveat: the "tight cap" analysis is bounds-only because MFE/MAE
 * doesn't tell us order of events. We compute both pessimistic (MAE first when
 * both hit) and optimistic (MFE first) bounds — and lean on the pessimistic
 * one for go/no-go.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.join(__dirname, 'enriched-trades.json');

const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const trades = raw.trades;

// === Candidate filters ===
const filters = {
  'baseline (no filter)': () => true,
  'drop ET 06-08':       e => !(e.hour >= 6 && e.hour <= 8),
  'drop ET 06 only':     e => e.hour !== 6,
  'drop Friday':         e => e.dow !== 'Fri',
  'drop ET06-08 + Fri':  e => !(e.hour >= 6 && e.hour <= 8) && e.dow !== 'Fri',
  'IV <= 22%':           e => e.iv == null || e.iv <= 0.22,
  'IV <= 24%':           e => e.iv == null || e.iv <= 0.24,
  'IV <= 22% + drop 06-08': e => (e.iv == null || e.iv <= 0.22) && !(e.hour >= 6 && e.hour <= 8),
  'putWallDist <= 300':  e => e.putWallDist == null || e.putWallDist <= 300,
  'putWallDist <= 500':  e => e.putWallDist == null || e.putWallDist <= 500,
  'callWallDist <= 300': e => e.callWallDist == null || e.callWallDist <= 300,
  'drop L3':             e => e.ruleId !== 'L3',
  'drop S1':             e => e.ruleId !== 'S1',
  'L1+S2 only':          e => e.ruleId === 'L1' || e.ruleId === 'S2',
  'drop L3 + S1':        e => e.ruleId !== 'L3' && e.ruleId !== 'S1',
  'composite A (06-08,Fri,IV24,!S1)': e =>
    !(e.hour >= 6 && e.hour <= 8) &&
    e.dow !== 'Fri' &&
    (e.iv == null || e.iv <= 0.24) &&
    e.ruleId !== 'S1',
  'composite B (06-08,Fri,IV22)': e =>
    !(e.hour >= 6 && e.hour <= 8) &&
    e.dow !== 'Fri' &&
    (e.iv == null || e.iv <= 0.22),
  'composite C (drop 06-08 + drop L3)': e =>
    !(e.hour >= 6 && e.hour <= 8) && e.ruleId !== 'L3',
};

const MAE_THRESHOLD = 10;
const POINT_VALUE = 20;  // NQ = $20/pt

function metrics(arr) {
  const total = arr.length;
  if (total === 0) return null;
  const wins = arr.filter(e => e.isWinner).length;
  const wr = wins / total;
  const cleanCount = arr.filter(e => e.mae <= MAE_THRESHOLD).length;
  const cleanRate = cleanCount / total;
  const totalPnL = arr.reduce((a, e) => a + e.pointsPnL * POINT_VALUE, 0);
  const grossProfit = arr.filter(e => e.pointsPnL > 0).reduce((a,e) => a + e.pointsPnL, 0);
  const grossLoss = -arr.filter(e => e.pointsPnL < 0).reduce((a,e) => a + e.pointsPnL, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

  // Running drawdown using these trades in chronological order
  const sorted = [...arr].sort((a, b) => a.timestamp - b.timestamp);
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of sorted) {
    equity += t.pointsPnL * POINT_VALUE;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return { total, wins, wr, cleanCount, cleanRate, totalPnL, pf, maxDD };
}

function tightBounds(arr, stop, tgt) {
  // Pessimistic: winner only if MFE >= tgt AND MAE < stop
  // Optimistic: winner if MFE >= tgt (ignore MAE)
  let pessW = 0, pessL = 0, optW = 0, optL = 0;
  for (const e of arr) {
    const mfe = e.mfe, mae = e.mae;
    if (mfe >= tgt && mae < stop) { pessW++; optW++; }
    else if (mae >= stop && mfe < tgt) { pessL++; optL++; }
    else if (mfe >= tgt && mae >= stop) { pessL++; optW++; }
    else { /* scratch: neither hit within window */ }
  }
  return {
    pessWR: (pessW + pessL) ? pessW / (pessW + pessL) : NaN,
    optWR:  (optW + optL)  ? optW  / (optW + optL)  : NaN,
    pessPnL: (pessW * tgt - pessL * stop) * POINT_VALUE,
    optPnL:  (optW  * tgt - optL  * stop) * POINT_VALUE,
    pessW, pessL, optW, optL,
  };
}

console.log(`\n=== Filter test (MAE threshold ${MAE_THRESHOLD}pt, ${POINT_VALUE}USD/pt) ===`);
console.log(`Source: ${raw.totalTrades} trades, ${raw.cleanCount} clean (${(100*raw.cleanCount/raw.totalTrades).toFixed(1)}%)\n`);

// Wide header
const hdr = ['filter', 'kept', 'drop%', 'cleanRate', 'WR', 'PnL($)', 'PF', 'MaxDD($)'];
console.log(hdr.map((s,i) => pad(s, [38, 6, 7, 11, 7, 11, 7, 11][i])).join(' '));
console.log('-'.repeat(95));

for (const [name, pred] of Object.entries(filters)) {
  const survivors = trades.filter(pred);
  const m = metrics(survivors);
  if (!m) continue;
  const dropPct = (100 * (trades.length - survivors.length) / trades.length).toFixed(1) + '%';
  console.log([
    pad(name, 38),
    pad(survivors.length, 6),
    pad(dropPct, 7),
    pad(pct(m.cleanRate), 11),
    pad(pct(m.wr), 7),
    pad('$' + Math.round(m.totalPnL).toLocaleString(), 11),
    pad(m.pf === Infinity ? '∞' : m.pf.toFixed(2), 7),
    pad('$' + Math.round(m.maxDD).toLocaleString(), 11),
  ].join(' '));
}

console.log('\n=== Tight-mode bounds for top filters at stop=10 / tgt=20 ===');
console.log('Pessimistic WR = trade is a winner only if MFE>=tgt AND MAE<stop');
console.log('Optimistic  WR = trade is a winner if MFE>=tgt (ignores stop)');
console.log('Truth lies between — but pessimistic is a hard floor.\n');

const tightCombos = [[10, 20], [10, 30], [15, 30], [20, 40]];
const focusFilters = [
  'baseline (no filter)',
  'drop ET 06-08',
  'drop ET 06-08 + Fri',
  'composite A (06-08,Fri,IV24,!S1)',
  'composite B (06-08,Fri,IV22)',
  'composite C (drop 06-08 + drop L3)',
];

for (const filterName of focusFilters) {
  if (!filters[filterName]) {
    // mismatched name from rename
    const matched = Object.keys(filters).find(k => k.startsWith(filterName.split(' ')[0]));
    if (!matched) continue;
  }
  const pred = filters[filterName] || filters[Object.keys(filters).find(k => k.startsWith(filterName.split(' ')[0]))];
  if (!pred) continue;
  const survivors = trades.filter(pred);
  console.log(`\n--- ${filterName} (n=${survivors.length}) ---`);
  for (const [stop, tgt] of tightCombos) {
    const b = tightBounds(survivors, stop, tgt);
    console.log(`  stop=${stop} tgt=${tgt}: pessWR=${pct(b.pessWR)} optWR=${pct(b.optWR)} pessPnL=$${Math.round(b.pessPnL).toLocaleString()} optPnL=$${Math.round(b.optPnL).toLocaleString()}`);
  }
}

function pct(v) { return isNaN(v) ? 'NaN' : (100 * v).toFixed(1) + '%'; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
