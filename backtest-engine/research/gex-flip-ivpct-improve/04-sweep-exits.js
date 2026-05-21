/**
 * Phase 4 — Cartesian exit sweep on the gfi gold trade walks.
 *
 * Single-strategy: one global exit policy. Stop locked at 60pt (small-account
 * hard constraint — max single-trade loss must stay ≤ $1,240).
 *
 * Sweeps (cartesian):
 *   - target:        [150, 180, 200, 220, 240, 260]
 *   - beTrig:        [off, 40, 50, 60, 70, 80, 100, 120, 140]
 *   - beOff:         [0, 5, 10, 20]
 *   - trail:         [off, (60,10), (80,15), (100,20), (120,20), (140,25)]
 *   - fib:           [off, (40,0.5), (40,0.618), (50,0.5), (60,0.5), (60,0.618), (80,0.618)]
 *   - maxhold:       [240, 360, 480, 600]
 *
 * Writes top-N (sorted by composite of PnL/Sharpe with DD<=$15k worstLoss<=$1240
 * constraint) to output/04-sweep-exits.csv.
 */

import fs from 'fs';
import { simulateAll, stats } from './02-sim-exits.js';

const WALK = process.argv[2] || './output/01-trades-walk.json';
const OUT = process.argv[3] || './output/04-sweep-exits.csv';
const walks = JSON.parse(fs.readFileSync(WALK, 'utf-8'));
console.log(`Loaded ${walks.length} trades`);

const STOP = 60;
const TARGETS = [150, 180, 200, 220, 240, 260];
const BE_TRIGS = [null, 40, 50, 60, 70, 80, 100, 120, 140];
const BE_OFFS = [0, 5, 10, 20];
const TRAILS = [
  [null, null],
  [60, 10],
  [80, 15],
  [100, 20],
  [120, 20],
  [140, 25],
];
const FIBS = [
  [null, null],
  [40, 0.5],
  [40, 0.618],
  [50, 0.5],
  [60, 0.5],
  [60, 0.618],
  [80, 0.618],
  [80, 0.5],
];
const MAX_HOLDS = [240, 360, 480, 600];

console.log(`\nTotal configs: ${TARGETS.length * BE_TRIGS.length * BE_OFFS.length * TRAILS.length * FIBS.length * MAX_HOLDS.length}`);

const rows = [];
let n = 0;
const t0 = Date.now();
for (const tgt of TARGETS) {
for (const beTrig of BE_TRIGS) {
for (const beOff of BE_OFFS) {
  // skip duplicate "no BE" configs
  if (beTrig == null && beOff !== 0) continue;
for (const [trT, trO] of TRAILS) {
for (const [fibAct, fibPct] of FIBS) {
for (const mh of MAX_HOLDS) {
  n++;
  const cfg = {
    target: tgt, stop: STOP, maxHoldMin: mh,
    beTrig, beOff,
    trTrig: trT, trOff: trO,
    fibActivationMFE: fibAct, fibRetracePct: fibPct,
  };
  const results = simulateAll(walks, cfg);
  const s = stats(results);
  rows.push({
    target: tgt,
    beTrig: beTrig ?? '-',
    beOff: beTrig != null ? beOff : '-',
    trTrig: trT ?? '-',
    trOff: trO ?? '-',
    fibAct: fibAct ?? '-',
    fibPct: fibPct ?? '-',
    maxHoldMin: mh,
    n: s.n, pnl: s.pnl, wr: s.wr, pf: s.pf, sharpe: s.sharpe,
    maxDD: s.maxDD, worstLoss: s.worstLoss,
    targetCt: s.exitReasons.target || 0,
    stopCt: s.exitReasons.stop || 0,
    beCt: s.exitReasons.be || 0,
    fibCt: s.exitReasons.fib || 0,
    trailCt: s.exitReasons.trail || 0,
    eodCt: s.exitReasons.eod || 0,
  });
  if (n % 500 === 0) {
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r  ${n} configs (${sec}s)...`);
  }
}}}}}}

const sec = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\nDone: ${rows.length} configs (${sec}s)`);

// Sort by PnL desc within the small-account constraint (worstLoss must be >= -$1,260)
const valid = rows.filter(r => r.worstLoss >= -1300);
console.log(`Valid (worstLoss>=-$1300): ${valid.length}`);

// Print top configs by several criteria
function top(rows, key, asc = false, label = '') {
  const sorted = rows.slice().sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
  console.log(`\n=== TOP 15 by ${label || key} ===`);
  console.log('  target be tr fib mh | n  PnL    WR%  PF    Sh    DD    worstL | T  S  B  Fb Tr E');
  for (const r of sorted.slice(0, 15)) {
    console.log(`  ${String(r.target).padStart(3)} ${String(r.beTrig).padStart(3)}/${String(r.beOff).padStart(2)} ${String(r.trTrig).padStart(3)}/${String(r.trOff).padStart(2)} ${String(r.fibAct).padStart(3)}/${String(r.fibPct).padStart(5)} ${r.maxHoldMin} | ${String(r.n).padStart(3)} ${r.pnl.toFixed(0).padStart(6)} ${r.wr.toFixed(0).padStart(3)} ${r.pf.toFixed(2).padStart(5)} ${r.sharpe.toFixed(2).padStart(5)} ${r.maxDD.toFixed(0).padStart(5)} ${r.worstLoss.toFixed(0).padStart(7)} | ${r.targetCt} ${r.stopCt} ${r.beCt} ${r.fibCt} ${r.trailCt} ${r.eodCt}`);
  }
}
top(valid, 'pnl', false, 'PnL (worstLoss OK)');
top(valid, 'pf', false, 'PF');
top(valid, 'sharpe', false, 'Sharpe');
top(valid, 'maxDD', true, 'MaxDD (asc)');
// Composite: PnL * PF / DD-bonus
for (const r of valid) {
  const ddBonus = 1 + Math.max(0, (12000 - r.maxDD) / 12000);
  r.composite = (r.pnl * Math.min(r.pf, 5) * ddBonus) / 1000;
}
top(valid, 'composite', false, 'Composite (PnL*PF*DDBonus)');

// CSV output
console.log(`\nWriting ${OUT}...`);
const header = 'target,beTrig,beOff,trTrig,trOff,fibAct,fibPct,maxHoldMin,n,pnl,wr,pf,sharpe,maxDD,worstLoss,targetCt,stopCt,beCt,fibCt,trailCt,eodCt';
const lines = [header];
for (const r of rows.sort((a, b) => b.pnl - a.pnl)) {
  lines.push([r.target, r.beTrig, r.beOff, r.trTrig, r.trOff, r.fibAct, r.fibPct, r.maxHoldMin,
    r.n, r.pnl.toFixed(0), r.wr.toFixed(2), r.pf.toFixed(3), r.sharpe.toFixed(3),
    r.maxDD.toFixed(0), r.worstLoss.toFixed(0),
    r.targetCt, r.stopCt, r.beCt, r.fibCt, r.trailCt, r.eodCt].join(','));
}
fs.writeFileSync(OUT, lines.join('\n'));
console.log(`Wrote ${lines.length} rows`);
