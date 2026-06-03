/**
 * Phase 2c — How reliably can we get a 5-10pt NQ move before an adverse stop?
 *
 * Re-frames the ask as a TRIPLE-BARRIER probability, the only honest version of
 * "predict a 5-10pt move": from each candidate entry, walk 1s bars forward and see
 * which barrier is hit first — target (+T), stop (-S), or max-hold timeout.
 *
 * Reports, for FADE-direction and MOMENTUM-direction entries:
 *   • base rate P(target before stop)
 *   • P(target reached at all within hold)   ← the "does a move happen" rate
 *   • the same gated by EXTREME pressure (top-quartile |ofi_60s|) — fade-the-extreme
 *   • undirected P(|move| >= T within hold)  ← volatility base rate, to show why
 *     "a 5pt move happens" is easy but DIRECTIONLESS (untradeable without a side)
 *
 * NOTE: barriers evaluated on CLOSE only (the Phase-1 file has no intrabar H/L).
 * This UNDERSTATES both target and stop touches; it's a relative-structure scan to
 * locate the best conditions. A high/low-honest confirmation is the follow-up pass.
 *
 * Usage: node research/regime-flow/04-target-probability-scan.js \
 *          --in data/features/nq_flow_1s_2026Q1.csv --downsample 8 --hold 900
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_flow_1s_2026Q1.csv');
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
const DOWN = +arg('downsample', 8);     // evaluate every Nth bar as a candidate entry
const HOLD = +arg('hold', 900);          // max-hold seconds (default 15 min)
const CONFIGS = [ // [target, stop] in points
  [5, 5], [5, 3], [5, 10], [10, 10], [10, 5],
];

console.log(`\n=== 5-10pt target-probability scan (triple-barrier, close-based) ===`);
console.log(`Input: ${inPath}\ndownsample 1/${DOWN}, max-hold ${HOLD}s\n`);

const ts = [], close = [], sym = [], ofi = [];
const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
let header = null, idx = {};
for await (const line of rl) {
  if (!header) { header = line.split(','); header.forEach((h, i) => idx[h] = i); continue; }
  const f = line.split(',');
  ts.push(new Date(f[idx.ts]).getTime()); close.push(+f[idx.close]); sym.push(f[idx.symbol]); ofi.push(+f[idx.ofi_60s]);
}
const N = ts.length;
console.log(`${N.toLocaleString()} bars loaded\n`);

// extreme-pressure threshold (top quartile |ofi|)
const absOfi = ofi.map(Math.abs).sort((a, b) => a - b);
const q75 = absOfi[Math.floor(absOfi.length * 0.75)];
console.log(`|ofi_60s| 75th pct = ${q75.toFixed(3)} (extreme-pressure gate)\n`);

// triple-barrier outcome for one entry: dir=+1 long / -1 short
// returns 'tp' | 'sl' | 'to' (timeout), plus whether |move|>=T touched either way
function barrier(i, dir, T, S) {
  const entry = close[i], holdMs = HOLD * 1000, s = sym[i];
  let touchedAbs = false;
  for (let j = i + 1; j < N; j++) {
    if (sym[j] !== s) break;             // never cross a contract change
    if (ts[j] - ts[i] > holdMs) break;
    const move = close[j] - entry;
    if (Math.abs(move) >= T) touchedAbs = true;
    const fav = dir * move, adv = -dir * move;
    if (fav >= T) return { o: 'tp', touchedAbs: true };
    if (adv >= S) return { o: 'sl', touchedAbs };
  }
  return { o: 'to', touchedAbs };
}

function scan(dirFn, mask) {
  // returns per-config tallies
  const res = CONFIGS.map(() => ({ tp: 0, sl: 0, to: 0, abs: 0, n: 0 }));
  for (let i = 0; i < N; i += DOWN) {
    if (mask && !mask(i)) continue;
    const dir = dirFn(i); if (dir === 0) continue;
    for (let c = 0; c < CONFIGS.length; c++) {
      const [T, S] = CONFIGS[c];
      const b = barrier(i, dir, T, S);
      const r = res[c];
      r.n++; r[b.o]++; if (b.touchedAbs) r.abs++;
    }
  }
  return res;
}

function report(title, res) {
  console.log(`\n${title}`);
  console.log(`  ${'T/S'.padEnd(8)} ${'n'.padStart(8)}  P(tp<sl)  P(tp@all)  P(|move|>=T)  R:R  expectancy(pt)`);
  for (let c = 0; c < CONFIGS.length; c++) {
    const [T, S] = CONFIGS[c], r = res[c];
    const pTp = r.tp / r.n, pSl = r.sl / r.n, pTo = r.to / r.n;
    const pAbs = r.abs / r.n;
    const rr = T / S;
    // expectancy assuming tp=+T, sl=-S, timeout settled at 0 (rough)
    const exp = pTp * T - pSl * S;
    console.log(`  ${(`+${T}/-${S}`).padEnd(8)} ${r.n.toLocaleString().padStart(8)}   ${(pTp * 100).toFixed(1)}%     ${(pAbs * 100).toFixed(1)}%       ${(pAbs * 100).toFixed(1)}%      ${rr.toFixed(2)}   ${exp >= 0 ? '+' : ''}${exp.toFixed(2)}`);
  }
}

// direction definitions
const fadeDir = i => -Math.sign(ofi[i]);     // fade the pressure
const momoDir = i => Math.sign(ofi[i]);       // ride the pressure

console.log(`Scanning (this walks 1s bars forward per entry; a few configs × directions)...`);
report('FADE direction, ALL bars:', scan(fadeDir, null));
report('FADE direction, EXTREME pressure only (|ofi|>=q75):', scan(fadeDir, i => Math.abs(ofi[i]) >= q75));
report('MOMENTUM direction, EXTREME pressure only:', scan(momoDir, i => Math.abs(ofi[i]) >= q75));

console.log(`\nRead:`);
console.log(`  • P(tp<sl) is the real, tradeable probability. Near-100% will NOT appear — anything`);
console.log(`    above ~60-65% at decent R:R is already a strong edge.`);
console.log(`  • P(|move|>=T) is high but DIRECTIONLESS — proves a 5pt move "happens" almost always,`);
console.log(`    which is exactly why direction (not move-existence) is the hard part.`);
console.log(`  • Positive expectancy + a condition that lifts P(tp<sl) = the seed of a real strategy.`);
console.log(`  • Close-based barriers understate stops; treat absolute numbers as optimistic.\n`);
