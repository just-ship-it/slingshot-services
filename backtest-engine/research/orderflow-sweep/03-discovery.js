/**
 * Phase 2 — Unbiased, lookahead-safe discovery: which causal order-flow / price-action
 * features precede a TRADABLE move? Scales to the full 13M-row panel via streaming load +
 * O(N) feature precompute (prefix sums + sliding extrema with segment-aware resets).
 *
 * Tradable-move labels (forward, intrabar high/low, PATH-correct triple-barrier):
 *   LONG  = +TGT before -STP within HOLD ;  SHORT = -TGT before +STP within HOLD.
 *
 * LOOKAHEAD: features use only bars in the current contiguous segment ending at i
 * (segment breaks on contract change or >2s gap; a window is valid only if it fits
 * entirely inside the segment). Labels are strictly forward. Train=first 60% by time.
 *
 * Usage: node --max-old-space-size=8192 research/orderflow-sweep/03-discovery.js \
 *          --in data/features/nq_panel_1s_full.csv [--step 3]
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
const TGT = +arg('tgt', 8), STP = +arg('stp', 3), HOLD = +arg('hold', 180);
const STEP = +arg('step', 3);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

console.log(`\n=== Discovery: features preceding +${TGT}/-${STP} within ${HOLD}s (step ${STEP}) ===\n${inPath}\n`);

// --- stream-load into typed arrays ---
console.log('Loading panel ...');
let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap),
  D = new Float64Array(cap), B = new Float64Array(cap), S = new Float64Array(cap), TR = new Float64Array(cap), MX = new Float64Array(cap);
const SYM = []; // strings
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); D = g(D); B = g(B); S = g(S); TR = g(TR); MX = g(MX); }
{
  const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
  let ci = null;
  for await (const line of rl) {
    if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; }
    if (n >= cap) grow();
    const f = line.split(',');
    TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]);
    Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close];
    D[n] = +f[ci.delta]; B[n] = +f[ci.buyVol]; S[n] = +f[ci.sellVol]; TR[n] = +f[ci.trades]; MX[n] = +f[ci.maxSz];
    n++;
  }
}
const N = n;
console.log(`  ${N.toLocaleString()} rows\n`);

// --- segment starts (break on contract change or >2s gap) ---
const segStart = new Int32Array(N);
{ let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; segStart[i] = s; } }

// --- prefix sums (global; window sum via subtraction, validity from segStart) ---
function prefix(x) { const P = new Float64Array(N); let a = 0; for (let i = 0; i < N; i++) { a += x[i]; P[i] = a; } return P; }
const PD = prefix(D), PB = prefix(B), PS = prefix(S), PTR = prefix(TR);
function wsum(P, i, w) { const lo = i - w + 1; if (lo < segStart[i]) return null; return P[i] - (lo > 0 ? P[lo - 1] : 0); }

// --- sliding extrema (segment-aware deque, head-pointer) ---
function slide(src, w, isMax) {
  const out = new Float64Array(N).fill(NaN); const dq = new Int32Array(N); let head = 0, tail = 0;
  for (let i = 0; i < N; i++) {
    if (i === 0 || segStart[i] !== segStart[i - 1]) { head = tail = 0; }
    while (tail > head && (isMax ? src[dq[tail - 1]] <= src[i] : src[dq[tail - 1]] >= src[i])) tail--;
    dq[tail++] = i;
    const lo = i - w + 1;
    while (head < tail && (dq[head] < lo || dq[head] < segStart[i])) head++;
    if (lo >= segStart[i]) out[i] = src[dq[head]];
  }
  return out;
}
console.log('Precomputing sliding extrema ...');
const HI300 = slide(Hh, 300, true), LO300 = slide(Ll, 300, false), HI900 = slide(Hh, 900, true), LO900 = slide(Ll, 900, false);

// --- features at i (all causal) ---
const FEATS = ['ret15', 'ret60', 'ret300', 'rangePos300', 'distHigh900', 'distLow900', 'd15', 'd60', 'd300', 'buyRatio60', 'intensZ', 'absorp15', 'block5', 'div'];
function features(i) {
  if (i - 300 < segStart[i]) return null;
  const c = Cc[i];
  const r = (w) => (i - w >= segStart[i]) ? c - Cc[i - w] : NaN;
  const ret15 = r(15), ret60 = r(60), ret300 = r(300);
  const rangePos300 = (HI300[i] > LO300[i]) ? (c - LO300[i]) / (HI300[i] - LO300[i]) : NaN;
  const distHigh900 = Number.isFinite(HI900[i]) ? HI900[i] - c : NaN;
  const distLow900 = Number.isFinite(LO900[i]) ? c - LO900[i] : NaN;
  const d15 = wsum(PD, i, 15), d60 = wsum(PD, i, 60), d300 = wsum(PD, i, 300);
  const b60 = wsum(PB, i, 60), s60 = wsum(PS, i, 60);
  const buyRatio60 = (b60 != null && (b60 + s60) > 0) ? b60 / (b60 + s60) : NaN;
  const tr60 = wsum(PTR, i, 60), tr1800 = wsum(PTR, i, 1800);
  const intensZ = (tr1800 && tr1800 > 0) ? tr60 / (tr1800 / 30) : NaN;
  const b15 = wsum(PB, i, 15), s15 = wsum(PS, i, 15);
  const range15 = (i - 15 >= segStart[i]) ? (slideMaxQuick(i, 15, true) - slideMaxQuick(i, 15, false)) : NaN;
  const absorp15 = (b15 != null && Number.isFinite(range15)) ? (b15 + s15) / (range15 + 0.25) : NaN;
  let block5 = 0; for (let k = Math.max(segStart[i], i - 5); k <= i; k++) if (MX[k] > block5) block5 = MX[k];
  const div = (ret60 != null && Number.isFinite(ret60) && d60 != null) ? -Math.sign(ret60) * d60 : NaN;
  return { ret15, ret60, ret300, rangePos300, distHigh900, distLow900, d15: d15 ?? NaN, d60: d60 ?? NaN, d300: d300 ?? NaN, buyRatio60, intensZ, absorp15, block5, div };
}
// tiny local 15-window extreme (cheap, only 15 back)
function slideMaxQuick(i, w, isMax) { let m = isMax ? -Infinity : Infinity; for (let k = Math.max(segStart[i], i - w + 1); k <= i; k++) { if (isMax) { if (Hh[k] > m) m = Hh[k]; } else { if (Ll[k] < m) m = Ll[k]; } } return m; }

// --- PATH-correct triple-barrier label ---
function label(i) {
  const c = Cc[i], hm = HOLD * 1000; let lo = 0, sh = 0, ld = false, sd = false;
  for (let j = i + 1; j < N; j++) {
    if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) break;
    const up = Hh[j] - c, dn = c - Ll[j];
    if (!ld) { const hit = up >= TGT, stp = dn >= STP; if (hit && stp) ld = true; else if (hit) { lo = 1; ld = true; } else if (stp) ld = true; }
    if (!sd) { const hit = dn >= TGT, stp = up >= STP; if (hit && stp) sd = true; else if (hit) { sh = 1; sd = true; } else if (stp) sd = true; }
    if (ld && sd) break;
  }
  return [lo, sh];
}

// --- evaluate ---
console.log('Evaluating ...');
const evTs = [], evL = [], evS = [], evF = {}; for (const k of FEATS) evF[k] = [];
for (let i = 0; i < N; i += STEP) {
  const f = features(i); if (!f) continue;
  const [lo, sh] = label(i);
  evTs.push(TS[i]); evL.push(lo); evS.push(sh); for (const k of FEATS) evF[k].push(f[k]);
}
const M = evTs.length;
const mid = M ? evTs[Math.floor(M / 2)] : 0;
const baseL = evL.reduce((a, b) => a + b, 0) / M, baseS = evS.reduce((a, b) => a + b, 0) / M;
console.log(`\neval points: ${M.toLocaleString()}  base — LONG ${(baseL*100).toFixed(2)}%  SHORT ${(baseS*100).toFixed(2)}%\n`);

function scan(side) {
  const Y = side === 'long' ? evL : evS, base = side === 'long' ? baseL : baseS;
  console.log(`\n### ${side.toUpperCase()} — extreme-quintile P(event) TRAIN→TEST (base ${(base*100).toFixed(2)}%)`);
  const res = [];
  for (const k of FEATS) {
    const idx = []; const V = evF[k]; for (let i = 0; i < M; i++) if (Number.isFinite(V[i])) idx.push(i);
    idx.sort((a, b) => V[a] - V[b]); const m = idx.length; if (m < 100) continue;
    const lo = idx.slice(0, Math.floor(m / 5)), hi = idx.slice(Math.floor(4 * m / 5));
    const rate = (a) => { let tr = 0, trn = 0, te = 0, ntr = 0, nte = 0, s = 0; for (const ii of a) { s += Y[ii]; if (evTs[ii] < mid) { trn += Y[ii]; ntr++; } else { te += Y[ii]; nte++; } } return [s / a.length, ntr ? trn / ntr : 0, nte ? te / nte : 0]; };
    const [hiAll, hiTr, hiTe] = rate(hi), [loAll, loTr, loTe] = rate(lo);
    const pick = Math.abs(hiTr - base) >= Math.abs(loTr - base) ? { q: 'Hi', tr: hiTr, te: hiTe } : { q: 'Lo', tr: loTr, te: loTe };
    const stable = (pick.tr > base) === (pick.te > base);
    res.push({ k, ...pick, lift: pick.tr - base, stable });
  }
  res.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));
  for (const r of res) {
    const tag = r.stable && r.te > base * 1.25 ? '  <== TRADABLE?' : (!r.stable ? '   (unstable)' : '');
    console.log(`  ${r.k.padEnd(12)} ${r.q}: train ${(r.tr*100).toFixed(2)}% → test ${(r.te*100).toFixed(2)}%${tag}`);
  }
}
scan('long'); scan('short');
console.log(`\nTRADABLE? = extreme quintile lifts test event-rate >25% over base AND stable train→test.\n`);
