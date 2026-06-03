/**
 * Phase 5 — Stack the big-algo tells into a wick-fade entry filter, measure the
 * achievable hit-rate, and time-split train/test to check it isn't overfit.
 *
 * Reads the compact touches CSV from Phase 4 (no 7.6GB re-read). Tells, in order of
 * separating power (Phase 4):
 *   absorption HIGH   (large order defending the level)   — strongest
 *   penetration LOW   (clean rejection wick, not a pierce)
 *   GEX wall          (vs LT)
 *   RTH hour          (ET 8-15)
 *   at range extreme  (level at the 1h high/low)
 *
 * Reports P(reject) + per-trade expectancy for progressively stacked filters, on the
 * full set then split by time (first half = train, second half = test).
 *
 * Usage: node research/regime-flow/08-stacked-filter.js --in data/features/nq_touches_2025Q4.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_touches_2025Q4.csv');
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

const lines = fs.readFileSync(inPath, 'utf8').trim().split('\n');
const hdr = lines[0].split(',');
const ix = {}; hdr.forEach((h, i) => ix[h] = i);
const rows = lines.slice(1).map(l => {
  const f = l.split(',');
  return {
    ts: new Date(f[ix.ts]).getTime(), src: f[ix.src], dir: +f[ix.dir],
    penetration: +f[ix.penetration], touch_vol_z: +f[ix.touch_vol_z], absorption: +f[ix.absorption],
    approach_vel: +f[ix.approach_vel], ofi_into: +f[ix.ofi_into], prior: +f[ix.prior_touches],
    at_extreme: +f[ix.at_extreme], hr: +f[ix.hour_et], o55: f[ix.o55], o53: f[ix.o53],
  };
});
rows.sort((a, b) => a.ts - b.ts);
console.log(`\n=== Stacked wick-fade filter ===\nLoaded ${rows.length.toLocaleString()} touches\n`);

// outcome stats for a subset under a target/stop column
function stats(sub, col, tgt, stop) {
  let rej = 0, brk = 0, to = 0;
  for (const r of sub) { const o = r[col]; if (o === 'rej') rej++; else if (o === 'brk') brk++; else to++; }
  const n = sub.length, resolved = rej + brk;
  const pRej = resolved ? rej / resolved : 0;       // P(reject | resolved)
  const exp = (rej * tgt - brk * stop) / n;         // per-trade expectancy, timeout=0
  return { n, pRej, exp, rej, brk, to };
}

const FILTERS = [
  ['(none) all touches', () => true],
  ['absorption≥40', r => r.absorption >= 40],
  ['+ penetration≤0.5', r => r.absorption >= 40 && r.penetration <= 0.5],
  ['+ GEX wall', r => r.absorption >= 40 && r.penetration <= 0.5 && r.src.startsWith('GEX')],
  ['+ RTH (ET 8-15)', r => r.absorption >= 40 && r.penetration <= 0.5 && r.src.startsWith('GEX') && r.hr >= 8 && r.hr <= 15],
  ['+ at range extreme', r => r.absorption >= 40 && r.penetration <= 0.5 && r.src.startsWith('GEX') && r.hr >= 8 && r.hr <= 15 && r.at_extreme === 1],
];

function block(title, sub) {
  console.log(`\n${title}`);
  console.log(`  ${'filter'.padEnd(24)} ${'n'.padStart(6)}  P(rej)|+5/-5  exp(pt)   P(rej)|+5/-3  exp(pt)`);
  for (const [name, fn] of FILTERS) {
    const s = sub.filter(fn);
    if (s.length < 20) { console.log(`  ${name.padEnd(24)} ${String(s.length).padStart(6)}  (too few)`); continue; }
    const a = stats(s, 'o55', 5, 5);
    const b = stats(s, 'o53', 5, 3);
    console.log(`  ${name.padEnd(24)} ${String(s.length).padStart(6)}    ${(a.pRej * 100).toFixed(1)}%     ${a.exp >= 0 ? '+' : ''}${a.exp.toFixed(2)}      ${(b.pRej * 100).toFixed(1)}%     ${b.exp >= 0 ? '+' : ''}${b.exp.toFixed(2)}`);
  }
}

block('FULL SET:', rows);
const mid = Math.floor(rows.length / 2);
block(`TRAIN (first half, →${new Date(rows[mid].ts).toISOString().slice(0, 10)}):`, rows.slice(0, mid));
block(`TEST (second half):`, rows.slice(mid));

console.log(`\nRead:`);
console.log(`  • P(rej)|+5/-5 climbing as filters stack = the tells are additive and real.`);
console.log(`  • TRAIN ≈ TEST on the final filter = not overfit; a stable wick-fade edge.`);
console.log(`  • exp(pt) is per-trade points after the win/loss geometry — compare to ~0.4pt cost.\n`);
