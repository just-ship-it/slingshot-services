/**
 * GEX-Touch Patterns — Phase 4: stretch-target evaluation.
 *
 * The Phase 1 v2 dataset now records `ladder_outcomes`: per-target win/loss
 * flags. This lets us see what happens to PnL / WR / PF if we trade with a
 * larger target without re-walking 1s.
 *
 * Usage:
 *   node research/gex-touch-patterns/04-stretch-targets.js \
 *     --in research/output/gex-touch-patterns-base-<TS>.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN = arg('in');
if (!IN) { console.error('Missing --in'); process.exit(1); }
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { triggers, config } = data;
console.log(`\n=== Phase 4: Stretch-target evaluation ===`);
console.log(`Triggers: ${triggers.length}`);

const LADDER = triggers[0]?.target_ladder || [20, 30, 40, 50, 60, 80, 100];
console.log(`Ladder: ${LADDER.join(', ')} pts\n`);

// For each (pattern, target) compute metrics
const patterns = [...new Set(triggers.map(t => t.pattern))].sort();
console.log(`patterns: ${patterns.join(', ')}\n`);

function metricsAt(arr, targetIdx, targetPts) {
  let w = 0, l = 0, other = 0;
  let winsPts = 0, lossPts = 0, sumPts = 0, sumStop = 0;
  for (const t of arr) {
    const o = t.ladder_outcomes?.[targetIdx];
    sumStop += t.stop_distance;
    if (o === 'win') { w++; sumPts += targetPts; winsPts += targetPts; }
    else if (o === 'loss') { l++; sumPts -= t.stop_distance; lossPts += t.stop_distance; }
    else other++;
  }
  const n = arr.length;
  const decided = w + l;
  const wr = decided ? w / decided : null;
  const pf = lossPts ? winsPts / lossPts : (winsPts ? Infinity : 0);
  const ev = n ? sumPts / n : 0;
  const avgStop = n ? sumStop / n : 0;
  return { n, w, l, other, decided, wr, pf, sumPts, ev, avgStop };
}

console.log('pattern    target  n      W   L   Other  WR     PF     EV     avgStop  pts    $');
for (const p of patterns) {
  const arr = triggers.filter(t => t.pattern === p);
  if (arr.length < 30) continue;
  for (let k = 0; k < LADDER.length; k++) {
    const m = metricsAt(arr, k, LADDER[k]);
    console.log(`${p.padEnd(8)} ${String(LADDER[k]).padStart(6)}  ${String(m.n).padStart(5)} ${String(m.w).padStart(4)} ${String(m.l).padStart(3)} ${String(m.other).padStart(6)} ${(m.wr != null ? (m.wr*100).toFixed(1)+'%' : '-').padStart(6)} ${(isFinite(m.pf) ? m.pf.toFixed(2) : '∞').padStart(6)} ${m.ev.toFixed(2).padStart(7)} ${m.avgStop.toFixed(1).padStart(8)} ${String(Math.round(m.sumPts)).padStart(6)} $${String(Math.round(m.sumPts * 20)).padStart(6)}`);
  }
  console.log();
}

// Per-pattern × level_type × target ladder (only show best target per cell)
console.log(`\n=== Best target per (pattern, level_type) cell (n>=30) ===`);
console.log('pattern  level_type  best_T  n     WR     PF     pts    $        $/trade');
for (const p of patterns) {
  const arr = triggers.filter(t => t.pattern === p);
  const byLT = new Map();
  for (const t of arr) {
    if (!byLT.has(t.level_type)) byLT.set(t.level_type, []);
    byLT.get(t.level_type).push(t);
  }
  for (const [lt, ts] of byLT.entries()) {
    if (ts.length < 30) continue;
    let bestT = null, bestPts = -Infinity;
    for (let k = 0; k < LADDER.length; k++) {
      const m = metricsAt(ts, k, LADDER[k]);
      if (m.sumPts > bestPts) {
        bestPts = m.sumPts;
        bestT = { target: LADDER[k], ...m };
      }
    }
    if (bestT && bestT.sumPts > 0) {
      const dollarsPerTrade = bestT.sumPts * 20 / Math.max(1, bestT.n);
      console.log(`${p.padEnd(7)} ${lt.padEnd(10)}  ${String(bestT.target).padStart(5)} ${String(bestT.n).padStart(5)} ${(bestT.wr*100).toFixed(1).padStart(5)}% ${bestT.pf.toFixed(2).padStart(6)} ${String(Math.round(bestT.sumPts)).padStart(6)} $${String(Math.round(bestT.sumPts*20)).padStart(6)} $${dollarsPerTrade.toFixed(0).padStart(4)}/tr`);
    }
  }
}
