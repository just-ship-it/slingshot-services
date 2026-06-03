/**
 * Phase 2b — Ride-fresh vs fade-exhausted (the change-point thesis test).
 *
 * Phase 2 showed inferred flow is CONTRARIAN unconditionally at 30-120s: strong
 * pressure reverts. But the vision is "detect a fresh push and ride it." Those two
 * are only compatible if the relationship is REGIME-CONDITIONAL:
 *     fresh momentum  → CONTINUES (ride)
 *     extended/old    → REVERTS  (fade)
 * That flip is exactly what a BOCPD change-point + HMM regime model would exploit.
 * If it doesn't exist, the strategy is a fade, not a ride — better to know now.
 *
 * Tests, using "continuation" = sign(signal_direction) * forward_return  (pts):
 *   A. By |run_len| (momentum age): do short runs continue and long runs revert?
 *   B. By acceleration: recent push (Δ10s*6) stronger than the 60s base = fresh.
 *   C. Across short horizons (3/5/10s) where ignition might persist before reverting.
 *
 * Usage: node research/regime-flow/03-conditional-ride-vs-fade.js --in data/features/nq_flow_1s_2026Q1.csv
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const IN = arg('in', 'data/features/nq_flow_1s_2026Q1.csv');
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
const TOL_MS = 5000;
const HORIZONS = [3, 5, 10, 30, 60];

console.log(`\n=== Ride-fresh vs fade-exhausted ===\nInput: ${inPath}\n`);

const ts = [], close = [], sym = [];
const runLen = [], d10 = [], d60 = [], ofi = [], ret5 = [], vpin = [];
const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
let header = null, idx = {};
for await (const line of rl) {
  if (!header) { header = line.split(','); header.forEach((h, i) => idx[h] = i); continue; }
  const f = line.split(',');
  ts.push(new Date(f[idx.ts]).getTime()); close.push(+f[idx.close]); sym.push(f[idx.symbol]);
  runLen.push(+f[idx.run_len]); d10.push(+f[idx.delta_10s]); d60.push(+f[idx.delta_60s]);
  ofi.push(+f[idx.ofi_60s]); ret5.push(+f[idx.ret_5s]); vpin.push(+f[idx.vpin_60s]);
}
const N = ts.length;
console.log(`${N.toLocaleString()} rows loaded\n`);

function buildForward(hSec) {
  const t = hSec * 1000, fwd = new Float64Array(N).fill(NaN);
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (j < i) j = i;
    const want = ts[i] + t;
    while (j < N && ts[j] < want) j++;
    if (j >= N) break;
    if (sym[j] === sym[i] && Math.abs(ts[j] - want) <= TOL_MS) fwd[i] = close[j] - close[i];
  }
  return fwd;
}
const fwds = {}; for (const h of HORIZONS) fwds[h] = buildForward(h);

// continuation stats for a subset (predicate over index i), direction = sign(dirFn(i))
function contStats(pred, dirFn) {
  const row = {};
  for (const h of HORIZONS) {
    let n = 0, sum = 0, win = 0;
    const fwd = fwds[h];
    for (let i = 0; i < N; i++) {
      if (!Number.isFinite(fwd[i]) || !pred(i)) continue;
      const dir = dirFn(i); if (dir === 0) continue;
      const cont = Math.sign(dir) * fwd[i];
      n++; sum += cont; if (cont > 0) win++;
    }
    row[h] = { n, mean: sum / n, win: win / n };
  }
  return row;
}
function printRow(label, row) {
  const cells = HORIZONS.map(h => {
    const r = row[h];
    const m = (r.mean >= 0 ? '+' : '') + r.mean.toFixed(3);
    return `${h}s:${m}pt/${(r.win * 100).toFixed(0)}%`;
  }).join('  ');
  console.log(`  ${label.padEnd(22)} ${cells}   (n≈${row[HORIZONS[0]].n.toLocaleString()})`);
}

console.log(`Metric = continuation: sign(direction) * forward_move. POSITIVE = rode the move; NEG = it reverted.`);
console.log(`Format per horizon: meanContinuation(pt) / continuation-win-rate%\n`);

// --- A. momentum age via |run_len|, direction = sign(run_len) ---
console.log(`A. By momentum AGE (|run_len|), direction = run direction:`);
const ageBuckets = [[1, 2], [3, 4], [5, 7], [8, 12], [13, 999]];
for (const [lo, hi] of ageBuckets) {
  printRow(`|run|=${lo}-${hi === 999 ? '+' : hi}`,
    contStats(i => { const a = Math.abs(runLen[i]); return a >= lo && a <= hi; }, i => runLen[i]));
}

// --- B. acceleration: recent push vs 60s base, direction = sign(d10) ---
console.log(`\nB. By ACCELERATION (Δ10s*6 vs Δ60s, same sign), direction = sign(Δ10s):`);
const accel = i => Math.sign(d10[i]) === Math.sign(d60[i]) && Math.abs(d10[i] * 6) > Math.abs(d60[i]) && Math.abs(d10[i]) > 5;
const decel = i => Math.sign(d10[i]) === Math.sign(d60[i]) && Math.abs(d10[i] * 6) <= Math.abs(d60[i]) && Math.abs(d60[i]) > 20;
printRow('ACCELERATING (fresh)', contStats(accel, i => d10[i]));
printRow('DECELERATING (old)', contStats(decel, i => d60[i]));

// --- C. fresh + toxic: accelerating AND high VPIN (informed ignition) ---
console.log(`\nC. Fresh push gated by toxicity (accelerating + high VPIN>0.6):`);
printRow('accel + VPIN>0.6', contStats(i => accel(i) && vpin[i] > 0.6, i => d10[i]));
printRow('accel + VPIN<0.4', contStats(i => accel(i) && vpin[i] < 0.4, i => d10[i]));

console.log(`\nRead:`);
console.log(`  • If short |run| / ACCELERATING rows show POSITIVE continuation at 3-10s but`);
console.log(`    long |run| / DECELERATING go NEGATIVE → the ride-fresh/fade-old flip is REAL.`);
console.log(`  • If everything is negative → it's a fade at every age; reframe to a fade strategy.`);
console.log(`  • Continuation-win% > ~52% at a horizon with mean > +0.4pt = scalpable ride.\n`);
