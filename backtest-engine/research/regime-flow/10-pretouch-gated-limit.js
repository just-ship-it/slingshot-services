/**
 * Phase 6b — Honest, tradeable version: rest a limit AT the level, gate on PRE-TOUCH
 * features only, fill on the wick (the good price). Drew's "better fill, cancel the
 * unfilled" idea, done right.
 *
 * Why: Phase 6 showed waiting for absorption then entering at the pulled-back price
 * wrecks R:R. But entering AT the level is real IF the order is resting before the wick.
 * The constraint: the decision to rest can use only info available BEFORE the touch
 * completes — so NOT absorption / penetration / touch-volume (those need the touch bar).
 * Usable pre-touch tells: level source (GEX/LT), ET hour, level-at-range-extreme,
 * prior-touch count, approach velocity, OFI pushing into the level.
 *
 * The o55 / o53 outcomes in the touches CSV were computed with entry AT the level, so
 * they already are the honest at-level-limit results — we just re-select on pre-touch
 * features and apply realistic PnL (win=+T limit exit; loss=-(S_break+slip); timeout=0).
 *
 * Usage: node research/regime-flow/10-pretouch-gated-limit.js --in data/features/nq_touches_2025Q4.csv --slip 0.5
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_touches_2025Q4.csv');
const SLIP = +arg('slip', 0.5);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

const lines = fs.readFileSync(inPath, 'utf8').trim().split('\n');
const ix = {}; lines[0].split(',').forEach((h, i) => ix[h] = i);
const rows = lines.slice(1).map(l => { const f = l.split(','); return {
  ts: new Date(f[ix.ts]).getTime(), src: f[ix.src], dir: +f[ix.dir],
  approach_vel: +f[ix.approach_vel], ofi_into: +f[ix.ofi_into], prior: +f[ix.prior_touches],
  at_extreme: +f[ix.at_extreme], hr: +f[ix.hour_et], o55: f[ix.o55], o53: f[ix.o53],
};}).sort((a, b) => a.ts - b.ts);
console.log(`\n=== Pre-touch-gated at-level limit (honest fill, slip ${SLIP}pt) ===\n${rows.length.toLocaleString()} touches\n`);

// realistic PnL per touch: rej -> +T, brk -> -(S+slip), to -> 0
function pnl(o, T, S) { return o === 'rej' ? T : (o === 'brk' ? -(S + SLIP) : 0); }
function summ(sub, col, T, S) {
  const n = sub.length; if (!n) return null;
  let rej = 0, brk = 0, to = 0, p = 0;
  for (const r of sub) { const o = r[col]; if (o === 'rej') rej++; else if (o === 'brk') brk++; else to++; p += pnl(o, T, S); }
  return { n, wr: rej / (rej + brk || 1), exp: p / n, total: p };
}

// PRE-TOUCH-ONLY filters (NO absorption/penetration/touch_vol)
const FILTERS = [
  ['all touches', () => true],
  ['GEX wall', r => r.src.startsWith('GEX')],
  ['RTH (ET 8-15)', r => r.hr >= 8 && r.hr <= 15],
  ['first touch (prior=0)', r => r.prior === 0],
  ['at range extreme', r => r.at_extreme === 1],
  ['fast approach (vel≥.25)', r => r.approach_vel >= 0.25],
  ['OFI-into≥0.2', r => r.ofi_into >= 0.2],
  ['GEX + RTH', r => r.src.startsWith('GEX') && r.hr >= 8 && r.hr <= 15],
  ['GEX + RTH + 1st-touch', r => r.src.startsWith('GEX') && r.hr >= 8 && r.hr <= 15 && r.prior === 0],
  ['RTH + 1st + extreme', r => r.hr >= 8 && r.hr <= 15 && r.prior === 0 && r.at_extreme === 1],
  ['RTH + 1st + fast-appr', r => r.hr >= 8 && r.hr <= 15 && r.prior === 0 && r.approach_vel >= 0.2],
];

function block(title, data) {
  console.log(`\n${title}`);
  console.log(`  ${'pre-touch filter'.padEnd(26)} ${'n'.padStart(5)}  WR(+5/-5) exp   WR(+5/-3) exp`);
  for (const [name, fn] of FILTERS) {
    const s = data.filter(fn);
    if (s.length < 25) { console.log(`  ${name.padEnd(26)} ${String(s.length).padStart(5)}  (too few)`); continue; }
    const a = summ(s, 'o55', 5, 5), b = summ(s, 'o53', 5, 3);
    console.log(`  ${name.padEnd(26)} ${String(s.length).padStart(5)}   ${(a.wr*100).toFixed(1)}% ${a.exp>=0?'+':''}${a.exp.toFixed(2)}   ${(b.wr*100).toFixed(1)}% ${b.exp>=0?'+':''}${b.exp.toFixed(2)}`);
  }
}
block('FULL SET:', rows);
const mid = Math.floor(rows.length / 2);
block(`TRAIN (first half):`, rows.slice(0, mid));
block(`TEST (second half):`, rows.slice(mid));

console.log(`\nRead: this is the HONEST at-level-limit edge using only pre-touch info to decide.`);
console.log(`Positive exp + train≈test on a filter with usable volume (≥1-2 trades/day) = real.`);
console.log(`If pre-touch alone is too weak, the absorption tell needs to drive a fast EXIT`);
console.log(`(bail when the big algo ISN'T defending) rather than the entry.\n`);
