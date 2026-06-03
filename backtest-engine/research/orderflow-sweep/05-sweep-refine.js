/**
 * Phase 2 — Refine the sweep edge. 04 found: aggression-driven sweeps CONTINUE (breakout),
 * passive / block-defended sweeps REVERT (trap). So we test BOTH sides per flow bucket:
 *   • FADE  (counter the sweep) for passive / block-defended sweeps
 *   • FOLLOW (go with the sweep) for strong-delta sweeps (the breakout)
 * across a target/stop grid, OOS-split, with combined filters. Goal: a tradable rule.
 *
 * Lookahead-safe (same as 04): level from PAST bars, flow up to pierce second, outcome forward.
 *
 * Usage: node --max-old-space-size=8192 research/orderflow-sweep/05-sweep-refine.js --in data/features/nq_panel_1s_full.csv
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_panel_1s_full.csv');
const HOLD = +arg('hold', 300), WIN = +arg('win', 1800), COOLDOWN = +arg('cooldown', 300), SLIP = +arg('slip', 0.5);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

console.log(`\n=== Sweep refine: fade vs follow by flow bucket (hold ${HOLD}s, slip ${SLIP}) ===\n`);

let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap), D = new Float64Array(cap), B = new Float64Array(cap), S = new Float64Array(cap), MX = new Float64Array(cap);
const SYM = [];
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); D = g(D); B = g(B); S = g(S); MX = g(MX); }
{
  const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity }); let ci = null;
  for await (const line of rl) { if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; } if (n >= cap) grow(); const f = line.split(','); TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]); Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close]; D[n] = +f[ci.delta]; B[n] = +f[ci.buyVol]; S[n] = +f[ci.sellVol]; MX[n] = +f[ci.maxSz]; n++; }
}
const N = n; console.log(`${N.toLocaleString()} rows`);
const segStart = new Int32Array(N); { let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; segStart[i] = s; } }
function pf(x) { const P = new Float64Array(N); let a = 0; for (let i = 0; i < N; i++) { a += x[i]; P[i] = a; } return P; }
const PD = pf(D), PB = pf(B), PS = pf(S);
function wsum(P, i, w) { const lo = i - w + 1; if (lo < segStart[i]) return null; return P[i] - (lo > 0 ? P[lo - 1] : 0); }
function slide(src, w, isMax) { const out = new Float64Array(N).fill(NaN); const dq = new Int32Array(N); let h = 0, t = 0; for (let i = 0; i < N; i++) { if (i === 0 || segStart[i] !== segStart[i - 1]) h = t = 0; while (t > h && (isMax ? src[dq[t - 1]] <= src[i] : src[dq[t - 1]] >= src[i])) t--; dq[t++] = i; const lo = i - w + 1; while (h < t && (dq[h] < lo || dq[h] < segStart[i])) h++; if (lo >= segStart[i]) out[i] = src[dq[h]]; } return out; }
// trailing extreme EXCLUDING current bar: shift by computing over [i-w, i-1] → use slide on prev index
const HIp = slide(Hh, WIN, true), LOp = slide(Ll, WIN, false);

// outcome walker: dir = sweep direction (+1 up). mode 'fade' (counter) or 'follow' (with).
function outcome(i, R, dir, T, Stop, mode) {
  const hm = HOLD * 1000; const d = mode === 'fade' ? -dir : dir; // trade direction
  for (let j = i; j < N; j++) {
    if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) return 'to';
    if (d < 0) { if (R - Ll[j] >= T) return 'win'; if (Hh[j] - R >= Stop) return 'loss'; }   // short
    else { if (Hh[j] - R >= T) return 'win'; if (R - Ll[j] >= Stop) return 'loss'; }          // long (R-relative)
  }
  return 'to';
}

// collect sweeps
const ev = [];
const lastSweep = new Map();
for (let i = WIN; i < N; i++) {
  const hiPrev = i - 1 >= segStart[i] ? HIp[i - 1] : NaN, loPrev = i - 1 >= segStart[i] ? LOp[i - 1] : NaN;
  const cands = [];
  if (Number.isFinite(hiPrev) && Hh[i] >= hiPrev && Hh[i - 1] < hiPrev) cands.push({ R: hiPrev, dir: 1, kind: 'trailHi' });
  if (Number.isFinite(loPrev) && Ll[i] <= loPrev && Ll[i - 1] > loPrev) cands.push({ R: loPrev, dir: -1, kind: 'trailLo' });
  const r50u = Math.ceil(Cc[i - 1] / 50) * 50, r50d = Math.floor(Cc[i - 1] / 50) * 50;
  if (Hh[i] >= r50u && Hh[i - 1] < r50u) cands.push({ R: r50u, dir: 1, kind: 'round50' });
  if (Ll[i] <= r50d && Ll[i - 1] > r50d) cands.push({ R: r50d, dir: -1, kind: 'round50' });
  for (const c of cands) {
    const key = `${c.kind}:${Math.round(c.R)}`; const last = lastSweep.get(key); if (last !== undefined && TS[i] - last < COOLDOWN * 1000) continue; lastSweep.set(key, TS[i]);
    const pd10 = (wsum(PD, i, 10) || 0) * c.dir;
    let block5 = 0; for (let k = Math.max(segStart[i], i - 4); k <= i; k++) if (MX[k] > block5) block5 = MX[k];
    const v60 = (wsum(PB, i, 60) || 0) + (wsum(PS, i, 60) || 0), v1800 = (wsum(PB, i, 1800) || 0) + (wsum(PS, i, 1800) || 0);
    const volZ = v1800 > 0 ? v60 / (v1800 / 30) : 1;
    ev.push({ i, ts: TS[i], R: c.R, dir: c.dir, kind: c.kind, pd10, block5, volZ });
  }
}
console.log(`sweep events: ${ev.length.toLocaleString()}\n`);
const mid = ev.length ? ev[Math.floor(ev.length / 2)].ts : 0;
// delta terciles
const pdSorted = ev.map(e => e.pd10).sort((a, b) => a - b); const pdLo = pdSorted[Math.floor(ev.length / 3)], pdHi = pdSorted[Math.floor(ev.length * 2 / 3)];
console.log(`pierceDelta10 terciles: weak<=${pdLo.toFixed(0)}  strong>=${pdHi.toFixed(0)}\n`);

const GRID = [[8, 6], [8, 4], [6, 4], [10, 6], [6, 6]]; // [target, stop]
function evalSet(sub, mode, T, Stop) {
  let win = 0, loss = 0, to = 0, pnl = 0, wTr = 0, nTr = 0, wTe = 0, nTe = 0;
  for (const e of sub) {
    const o = outcome(e.i, e.R, e.dir, T, Stop, mode);
    let p = 0; if (o === 'win') { win++; p = T; } else if (o === 'loss') { loss++; p = -(Stop + SLIP); } else to++;
    pnl += p;
    if (e.ts < mid) { nTr++; if (o === 'win') wTr++; } else { nTe++; if (o === 'win') wTe++; }
  }
  const res = win + loss; return { n: sub.length, wr: res ? win / res : 0, exp: pnl / sub.length, wrTr: nTr ? wTr / nTr : 0, wrTe: nTe ? wTe / nTe : 0 };
}
function report(title, sub, mode) {
  if (sub.length < 50) { console.log(`${title}: n=${sub.length} (few)`); return; }
  console.log(`\n${title}  (n=${sub.length}, mode=${mode})`);
  for (const [T, Stop] of GRID) { const r = evalSet(sub, mode, T, Stop); console.log(`   +${T}/-${Stop}: WR ${(r.wr*100).toFixed(1)}%  exp ${r.exp>=0?'+':''}${r.exp.toFixed(2)}pt  WRtrain→test ${(r.wrTr*100).toFixed(1)}→${(r.wrTe*100).toFixed(1)}`); }
}

const weak = ev.filter(e => e.pd10 <= pdLo), strong = ev.filter(e => e.pd10 >= pdHi);
const block = ev.filter(e => e.block5 >= 25), blockWeak = ev.filter(e => e.block5 >= 25 && e.pd10 <= pdLo);
report('FADE — all sweeps', ev, 'fade');
report('FADE — weak pierce delta', weak, 'fade');
report('FADE — block>=25', block, 'fade');
report('FADE — block>=25 AND weak delta', blockWeak, 'fade');
report('FOLLOW — strong pierce delta (breakout)', strong, 'follow');
report('FOLLOW — all sweeps', ev, 'follow');
console.log(`\nRead: pick the (subset,mode,T/S) with positive exp that HOLDS train→test and has usable n.\n`);
