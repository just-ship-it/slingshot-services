/**
 * Phase 2 — Sharpen the BLOCK-DEFENDED SWEEP FADE (the seed from 05).
 * Setup: a sweep of a trailing-30m extreme or round-50, with a block print (>=BLK) at the
 * pierce, faded with target 6 / stop 6. We condition on level kind, ET hour (RTH?), volume
 * regime, and block threshold to find the sharpest OOS-stable cell, and sanity-test entry
 * fill sensitivity (enter at level R vs a tick above).
 *
 * Lookahead-safe; OOS 60/40 by time. node --max-old-space-size=8192.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname2, '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_panel_1s_full.csv');
const HOLD = +arg('hold', 300), WIN = +arg('win', 1800), COOLDOWN = +arg('cooldown', 300), SLIP = +arg('slip', 0.5);
const T = +arg('tgt', 6), STOP = +arg('stop', 6), BLK = +arg('blk', 25);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
console.log(`\n=== Block-fade refine: blk>=${BLK}, fade +${T}/-${STOP}, hold ${HOLD}s ===\n`);

let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap), D = new Float64Array(cap), B = new Float64Array(cap), S = new Float64Array(cap), MX = new Float64Array(cap);
const SYM = [];
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); D = g(D); B = g(B); S = g(S); MX = g(MX); }
{ const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity }); let ci = null; for await (const line of rl) { if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; } if (n >= cap) grow(); const f = line.split(','); TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]); Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close]; D[n] = +f[ci.delta]; B[n] = +f[ci.buyVol]; S[n] = +f[ci.sellVol]; MX[n] = +f[ci.maxSz]; n++; } }
const N = n; console.log(`${N.toLocaleString()} rows`);
const segStart = new Int32Array(N); { let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; segStart[i] = s; } }
function pf(x) { const P = new Float64Array(N); let a = 0; for (let i = 0; i < N; i++) { a += x[i]; P[i] = a; } return P; }
const PB = pf(B), PS = pf(S);
function wsum(P, i, w) { const lo = i - w + 1; if (lo < segStart[i]) return null; return P[i] - (lo > 0 ? P[lo - 1] : 0); }
function slide(src, w, isMax) { const out = new Float64Array(N).fill(NaN); const dq = new Int32Array(N); let h = 0, t = 0; for (let i = 0; i < N; i++) { if (i === 0 || segStart[i] !== segStart[i - 1]) h = t = 0; while (t > h && (isMax ? src[dq[t - 1]] <= src[i] : src[dq[t - 1]] >= src[i])) t--; dq[t++] = i; const lo = i - w + 1; while (h < t && (dq[h] < lo || dq[h] < segStart[i])) h++; if (lo >= segStart[i]) out[i] = src[dq[h]]; } return out; }
const HIp = slide(Hh, WIN, true), LOp = slide(Ll, WIN, false);
const etHour = ms => { const d = new Date(ms); return (d.getUTCHours() + 24 - 5) % 24; };

// fade outcome: dir = sweep dir (+1 up → we short). entryOff = points above R (up) we enter (better short fill).
function fade(i, R, dir, entryOff) {
  const entry = R + dir * entryOff; const hm = HOLD * 1000;
  for (let j = i; j < N; j++) {
    if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) return 'to';
    if (dir > 0) { if (entry - Ll[j] >= T) return 'win'; if (Hh[j] - R >= STOP) return 'loss'; }  // short from entry; stop above level R
    else { if (Hh[j] - entry >= T) return 'win'; if (R - Ll[j] >= STOP) return 'loss'; }            // long
  }
  return 'to';
}

const ev = []; const lastSweep = new Map();
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
    let block5 = 0; for (let k = Math.max(segStart[i], i - 4); k <= i; k++) if (MX[k] > block5) block5 = MX[k];
    if (block5 < BLK) continue; // BLOCK filter
    const v60 = (wsum(PB, i, 60) || 0) + (wsum(PS, i, 60) || 0), v1800 = (wsum(PB, i, 1800) || 0) + (wsum(PS, i, 1800) || 0);
    const volZ = v1800 > 0 ? v60 / (v1800 / 30) : 1;
    ev.push({ i, ts: TS[i], R: c.R, dir: c.dir, kind: c.kind, block5, volZ, hr: etHour(TS[i]) });
  }
}
console.log(`block sweep events: ${ev.length.toLocaleString()}\n`);
const mid = ev.length ? ev[Math.floor(ev.length / 2)].ts : 0;
function stat(sub, entryOff = 0) {
  if (sub.length < 40) return null;
  let win = 0, loss = 0, pnl = 0, wTr = 0, nTr = 0, wTe = 0, nTe = 0;
  for (const e of sub) { const o = fade(e.i, e.R, e.dir, entryOff); let p = 0; if (o === 'win') { win++; p = T; } else if (o === 'loss') { loss++; p = -(STOP + SLIP); } pnl += p; if (e.ts < mid) { nTr++; if (o === 'win') wTr++; } else { nTe++; if (o === 'win') wTe++; } }
  const res = win + loss; return { n: sub.length, wr: res ? win / res : 0, exp: pnl / sub.length, tr: nTr ? wTr / nTr : 0, te: nTe ? wTe / nTe : 0 };
}
function row(label, sub, entryOff = 0) { const r = stat(sub, entryOff); if (!r) { console.log(`  ${label.padEnd(34)} n=${sub.length} (few)`); return; } console.log(`  ${label.padEnd(34)} n=${String(r.n).padStart(5)}  WR ${(r.wr*100).toFixed(1)}%  exp ${r.exp>=0?'+':''}${r.exp.toFixed(2)}  WR tr→te ${(r.tr*100).toFixed(1)}→${(r.te*100).toFixed(1)}`); }

console.log('--- by level kind ---');
for (const k of ['trailHi', 'trailLo', 'round50']) row(k, ev.filter(e => e.kind === k));
console.log('--- by ET hour bucket ---');
row('RTH (ET 9-15)', ev.filter(e => e.hr >= 9 && e.hr <= 15));
row('overnight (ET 18-7)', ev.filter(e => e.hr >= 18 || e.hr <= 7));
console.log('--- by volume regime ---');
row('volZ < 1 (quiet)', ev.filter(e => e.volZ < 1));
row('volZ 1-3', ev.filter(e => e.volZ >= 1 && e.volZ < 3));
row('volZ >= 3 (spike)', ev.filter(e => e.volZ >= 3));
console.log('--- by block size ---');
row('block 25-49', ev.filter(e => e.block5 >= 25 && e.block5 < 50));
row('block >= 50', ev.filter(e => e.block5 >= 50));
row('block >= 100', ev.filter(e => e.block5 >= 100));
console.log('--- entry-fill sensitivity (all block events) ---');
row('entry at R', ev, 0);
row('entry 1pt better', ev, 1);
row('entry 2pt better', ev, 2);
console.log('--- stacked: round50 + RTH + block>=25 ---');
row('round50 & RTH', ev.filter(e => e.kind === 'round50' && e.hr >= 9 && e.hr <= 15));
row('trail & RTH', ev.filter(e => (e.kind === 'trailHi' || e.kind === 'trailLo') && e.hr >= 9 && e.hr <= 15));
console.log('\nRead: find the cell with positive exp, usable n, and WR that HOLDS train→test.\n');
