/**
 * Phase 4d — Explore tighter stop (50pt). Max single loss = -$1,010 vs -$1,210.
 * Still within Drew's $1,240 cap. Maybe lowers DD?
 */
import fs from 'fs';
import { simulateAll, stats } from './02-sim-exits.js';

const walks = JSON.parse(fs.readFileSync('./output/01-trades-walk.json', 'utf-8'));

const TARGETS = [200, 220, 240, 260, 280, 300, 320];
const STOPS = [40, 50, 55, 60];
const BE_TRIGS = [null, 100, 120, 140, 160, 180];
const BE_OFFS = [5, 10];
const MAX_HOLDS = [480, 600];

const rows = [];
for (const tgt of TARGETS) {
for (const stp of STOPS) {
for (const beTrig of BE_TRIGS) {
for (const beOff of BE_OFFS) {
  if (beTrig == null && beOff !== 5) continue;
for (const mh of MAX_HOLDS) {
  const cfg = { target: tgt, stop: stp, maxHoldMin: mh, beTrig, beOff };
  const results = simulateAll(walks, cfg);
  const s = stats(results);
  rows.push({
    target: tgt, stop: stp, beTrig: beTrig ?? '-', beOff,
    maxHoldMin: mh,
    pnl: s.pnl, wr: s.wr, pf: s.pf, sharpe: s.sharpe, maxDD: s.maxDD, worstLoss: s.worstLoss,
    n: s.n,
  });
}}}}}

const valid = rows.filter(r => r.worstLoss >= -1300);
console.log(`Total: ${rows.length} valid: ${valid.length}`);

function top(rows, key, asc = false, label = '', limit = 20) {
  const sorted = rows.slice().sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
  console.log(`\n=== TOP ${limit} by ${label || key} ===`);
  console.log('  tgt stp be    mh  | PnL    WR%  PF    Sh    DD    worstL');
  for (const r of sorted.slice(0, limit)) {
    console.log(`  ${String(r.target).padStart(3)} ${String(r.stop).padStart(2)} ${String(r.beTrig).padStart(3)}/${String(r.beOff).padStart(2)} ${r.maxHoldMin} | ${r.pnl.toFixed(0).padStart(7)} ${r.wr.toFixed(0)} ${r.pf.toFixed(2).padStart(5)} ${r.sharpe.toFixed(2).padStart(5)} ${r.maxDD.toFixed(0).padStart(6)} ${r.worstLoss.toFixed(0).padStart(6)}`);
  }
}

top(valid, 'pnl', false, 'PnL', 20);
console.log('\n--- Only stop=40 / stop=50 / stop=55 ---');
top(valid.filter(r => r.stop < 60), 'sharpe', false, 'Sharpe (tighter stops)', 15);
top(valid.filter(r => r.stop < 60), 'pnl', false, 'PnL (tighter stops)', 15);
top(valid.filter(r => r.stop < 60), 'maxDD', true, 'DD (asc, tighter stops)', 10);
