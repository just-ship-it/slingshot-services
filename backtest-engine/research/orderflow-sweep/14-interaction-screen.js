/**
 * Phase 3 — Non-obvious INTERACTION screen. Single features were null (03); combinations may
 * not be. For every pair of causal features, test the 4 extreme-quintile "corners" (A-hi&B-hi,
 * A-hi&B-lo, A-lo&B-hi, A-lo&B-lo) for tradable-event lift — but only believe a corner if it
 * lifts the event rate on TRAIN, holds on VALIDATE, and survives an untouched HOLDOUT.
 * Three-way time split (60/20/20). This is the wide net + hard gate against false positives.
 *
 * node --max-old-space-size=8192 research/orderflow-sweep/14-interaction-screen.js --in data/features/nq_panel_1s_full.csv --step 4
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_panel_1s_full.csv');
const TGT = +arg('tgt', 8), STP = +arg('stp', 3), HOLD = +arg('hold', 180), STEP = +arg('step', 4);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
console.log(`\n=== Interaction screen: pairs of features → P(+${TGT}/-${STP} in ${HOLD}s), train/val/holdout ===\n`);

let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap), D = new Float64Array(cap), B = new Float64Array(cap), S = new Float64Array(cap), TR = new Float64Array(cap), MX = new Float64Array(cap);
const SYM = [];
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); D = g(D); B = g(B); S = g(S); TR = g(TR); MX = g(MX); }
{ const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity }); let ci = null; for await (const line of rl) { if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; } if (n >= cap) grow(); const f = line.split(','); TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]); Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close]; D[n] = +f[ci.delta]; B[n] = +f[ci.buyVol]; S[n] = +f[ci.sellVol]; TR[n] = +f[ci.trades]; MX[n] = +f[ci.maxSz]; n++; } }
const N = n; console.log(`${N.toLocaleString()} rows`);
const seg = new Int32Array(N); { let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; seg[i] = s; } }
function pf(x) { const P = new Float64Array(N); let a = 0; for (let i = 0; i < N; i++) { a += x[i]; P[i] = a; } return P; }
const PD = pf(D), PB = pf(B), PS = pf(S), PTR = pf(TR);
function wsum(P, i, w) { const lo = i - w + 1; if (lo < seg[i]) return null; return P[i] - (lo > 0 ? P[lo - 1] : 0); }
function slide(src, w, isMax) { const out = new Float64Array(N).fill(NaN); const dq = new Int32Array(N); let h = 0, t = 0; for (let i = 0; i < N; i++) { if (i === 0 || seg[i] !== seg[i - 1]) h = t = 0; while (t > h && (isMax ? src[dq[t - 1]] <= src[i] : src[dq[t - 1]] >= src[i])) t--; dq[t++] = i; const lo = i - w + 1; while (h < t && (dq[h] < lo || dq[h] < seg[i])) h++; if (lo >= seg[i]) out[i] = src[dq[h]]; } return out; }
const HI300 = slide(Hh, 300, true), LO300 = slide(Ll, 300, false), HI900 = slide(Hh, 900, true), LO900 = slide(Ll, 900, false);

const FEATS = ['ret60', 'ret300', 'rangePos', 'distHi', 'distLo', 'd60', 'd300', 'buyRatio', 'intensZ', 'absorp', 'block', 'div'];
function feat(i) {
  if (i - 300 < seg[i]) return null;
  const c = Cc[i];
  const ret60 = i - 60 >= seg[i] ? c - Cc[i - 60] : NaN, ret300 = c - Cc[i - 300];
  const rangePos = (HI300[i] > LO300[i]) ? (c - LO300[i]) / (HI300[i] - LO300[i]) : NaN;
  const distHi = Number.isFinite(HI900[i]) ? HI900[i] - c : NaN, distLo = Number.isFinite(LO900[i]) ? c - LO900[i] : NaN;
  const d60 = wsum(PD, i, 60), d300 = wsum(PD, i, 300);
  const b60 = wsum(PB, i, 60), s60 = wsum(PS, i, 60); const buyRatio = (b60 != null && b60 + s60 > 0) ? b60 / (b60 + s60) : NaN;
  const tr60 = wsum(PTR, i, 60), tr1800 = wsum(PTR, i, 1800); const intensZ = (tr1800 && tr1800 > 0) ? tr60 / (tr1800 / 30) : NaN;
  const b15 = wsum(PB, i, 15), s15 = wsum(PS, i, 15); let rl = -Infinity, rh = Infinity; for (let k = Math.max(seg[i], i - 14); k <= i; k++) { if (Hh[k] > rl) rl = Hh[k]; if (Ll[k] < rh) rh = Ll[k]; } const absorp = (b15 != null) ? (b15 + s15) / ((rl - rh) + 0.25) : NaN;
  let block = 0; for (let k = Math.max(seg[i], i - 5); k <= i; k++) if (MX[k] > block) block = MX[k];
  const div = (Number.isFinite(ret60) && d60 != null) ? -Math.sign(ret60) * d60 : NaN;
  return [ret60, ret300, rangePos, distHi, distLo, d60 ?? NaN, d300 ?? NaN, buyRatio, intensZ, absorp, block, div];
}
function label(i) { const c = Cc[i], hm = HOLD * 1000; let lo = 0, sh = 0, ld = false, sd = false; for (let j = i + 1; j < N; j++) { if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) break; const up = Hh[j] - c, dn = c - Ll[j]; if (!ld) { const h = up >= TGT, s = dn >= STP; if (h && s) ld = true; else if (h) { lo = 1; ld = true; } else if (s) ld = true; } if (!sd) { const h = dn >= TGT, s = up >= STP; if (h && s) sd = true; else if (h) { sh = 1; sd = true; } else if (s) sd = true; } if (ld && sd) break; } return lo + 2 * sh; } // bit0=long,bit1=short

console.log('building eval matrix ...');
const F = FEATS.length; const X = []; const YL = [], YS = [], TST = [];
for (let i = 0; i < N; i += STEP) { const fv = feat(i); if (!fv) continue; const y = label(i); X.push(fv); YL.push(y & 1); YS.push((y >> 1) & 1); TST.push(TS[i]); }
const M = X.length; console.log(`eval points: ${M.toLocaleString()}`);
const t1 = TST[Math.floor(M * 0.6)], t2 = TST[Math.floor(M * 0.8)];
const split = ts => ts < t1 ? 0 : ts < t2 ? 1 : 2; // 0 train,1 val,2 holdout
// per-feature quintile thresholds from TRAIN only
const thr = [];
for (let k = 0; k < F; k++) { const v = []; for (let m = 0; m < M; m++) if (split(TST[m]) === 0 && Number.isFinite(X[m][k])) v.push(X[m][k]); v.sort((a, b) => a - b); thr.push([v[Math.floor(v.length * 0.2)], v[Math.floor(v.length * 0.8)]]); }
function baserate(Y, s) { let a = 0, c = 0; for (let m = 0; m < M; m++) if (split(TST[m]) === s) { a += Y[m]; c++; } return a / c; }
const baseL = [0, 1, 2].map(s => baserate(YL, s)), baseS = [0, 1, 2].map(s => baserate(YS, s));
console.log(`base LONG  train/val/hold: ${baseL.map(x=>(x*100).toFixed(1)).join(' / ')}%`);
console.log(`base SHORT train/val/hold: ${baseS.map(x=>(x*100).toFixed(1)).join(' / ')}%\n`);

// pairwise corner screen
function cornerRate(Y, ka, da, kb, db) { // da/db: +1 hi corner, -1 lo corner
  const r = [[0, 0], [0, 0], [0, 0]]; // [split][sum,count]
  for (let m = 0; m < M; m++) { const a = X[m][ka], b = X[m][kb]; if (!Number.isFinite(a) || !Number.isFinite(b)) continue; const ina = da > 0 ? a >= thr[ka][1] : a <= thr[ka][0]; if (!ina) continue; const inb = db > 0 ? b >= thr[kb][1] : b <= thr[kb][0]; if (!inb) continue; const s = split(TST[m]); r[s][0] += Y[m]; r[s][1]++; }
  return r;
}
const hits = [];
for (let ka = 0; ka < F; ka++) for (let kb = ka + 1; kb < F; kb++) for (const da of [1, -1]) for (const db of [1, -1]) {
  for (const [side, Y, base] of [['L', YL, baseL], ['S', YS, baseS]]) {
    const r = cornerRate(Y, ka, da, kb, db);
    if (r[0][1] < 300 || r[1][1] < 100 || r[2][1] < 100) continue;
    const pTr = r[0][0] / r[0][1], pVal = r[1][0] / r[1][1], pHold = r[2][0] / r[2][1];
    // require: train lift >1.3x base, same direction on val AND holdout, holdout lift >1.2x
    const liftTr = pTr / base[0], liftHold = pHold / base[2];
    if (liftTr > 1.3 && pVal > base[1] * 1.2 && liftHold > 1.2) hits.push({ side, ka, da, kb, db, pTr, pVal, pHold, liftHold, nHold: r[2][1] });
  }
}
hits.sort((a, b) => b.liftHold - a.liftHold);
console.log(`SURVIVING interactions (train>1.3x, val>1.2x, holdout>1.2x base):  ${hits.length}`);
for (const h of hits.slice(0, 25)) {
  console.log(`  ${h.side} ${FEATS[h.ka]}${h.da>0?'↑':'↓'} & ${FEATS[h.kb]}${h.db>0?'↑':'↓'}: train ${(h.pTr*100).toFixed(1)}% val ${(h.pVal*100).toFixed(1)}% HOLD ${(h.pHold*100).toFixed(1)}% (${h.liftHold.toFixed(2)}x, n=${h.nHold})`);
}
if (!hits.length) console.log('  (none survived the holdout — no real 2-way interaction edge)');
console.log(`\nRead: a corner that clears all three splits is a real, non-obvious combo edge. None = the`);
console.log(`pairwise interaction space is also efficient (for this +${TGT}/-${STP} target).\n`);
