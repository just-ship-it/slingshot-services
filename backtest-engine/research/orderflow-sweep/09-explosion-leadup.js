/**
 * Phase 3 — Reverse-engineer the LEADUP to 1-3min outlier moves (the "lay-waste" sweeps).
 * Thesis (Drew): these big market/sweep orders may be telegraphed, but only a SMALL fish can
 * act on the precursor without disrupting it. So: (a) find explosion onsets, (b) check
 * CATCHABILITY (how much move is left after a 2s reaction lag), (c) reverse-engineer the
 * leadup — do precursor order-flow signatures precede them, and do they predict DIRECTION?
 *
 * Onset = first second where price travels >=THRESH (either dir) within W sec (path-correct
 * first-barrier), preceded by a QUIET coil (prior-30s range < COIL), deduped by cooldown.
 *
 * LOOKAHEAD: precursor features use ONLY bars <= onset (backward windows). The explosion label
 * is forward. Catchability/tradability measured from onset+LAG. RTH only. OOS 60/40 by time.
 *
 * node --max-old-space-size=8192 research/orderflow-sweep/09-explosion-leadup.js --in data/features/nq_panel_1s_full.csv --thresh 15
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_panel_1s_full.csv');
const THRESH = +arg('thresh', 15), W = +arg('w', 60), COIL = +arg('coil', 8), COOLDOWN = +arg('cooldown', 120), LAG = +arg('lag', 2);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
console.log(`\n=== Explosion leadup: >=${THRESH}pt within ${W}s after a <${COIL}pt coil (react lag ${LAG}s) ===\n`);

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
const HI30 = slide(Hh, 30, true), LO30 = slide(Ll, 30, false);
const etHour = ms => { const d = new Date(ms); return (d.getUTCHours() + 24 - 5) % 24; };

// forward first-barrier explosion from i: returns {dir, j (bar reaching THRESH), moveAtLag}
function explode(i) {
  const c = Cc[i], hm = W * 1000;
  for (let j = i + 1; j < N; j++) {
    if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) break;
    if (Hh[j] - c >= THRESH) return { dir: 1, j };
    if (c - Ll[j] >= THRESH) return { dir: -1, j };
  }
  return null;
}

// detect onsets (quiet coil → explosion), deduped
const onsets = []; let lastOnset = -1e18;
for (let i = 31; i < N; i++) {
  if (i - 30 < seg[i]) continue;
  const coil = HI30[i] - LO30[i];
  if (!(coil < COIL)) continue;               // must be quiet before
  if (TS[i] - lastOnset < COOLDOWN * 1000) continue;
  const e = explode(i);
  if (!e) continue;
  lastOnset = TS[i];
  onsets.push({ i, ts: TS[i], dir: e.dir, j: e.j, hr: etHour(TS[i]) });
}
console.log(`explosion onsets: ${onsets.length.toLocaleString()} (~${(onsets.length/270).toFixed(1)}/day)`);
const up = onsets.filter(o => o.dir > 0).length;
console.log(`direction: ${up} up / ${onsets.length - up} down`);

// hour-of-day clustering (news check) — ET hour
const byHr = {}; for (const o of onsets) byHr[o.hr] = (byHr[o.hr] || 0) + 1;
const topHrs = Object.entries(byHr).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, c]) => `${h}:00=${c}`).join('  ');
console.log(`top ET hours: ${topHrs}`);

// CATCHABILITY: of the THRESH move, how much remains after LAG seconds from onset?
let remPts = [], fastShare = 0;
for (const o of onsets) {
  const c = Cc[o.i];
  // price at onset+LAG
  let lagIdx = o.i; for (let j = o.i + 1; j < N; j++) { if (SYM[j] !== SYM[o.i] || TS[j] - TS[o.i] > LAG * 1000) break; lagIdx = j; }
  const pAtLag = Cc[lagIdx];
  const moveByLag = o.dir > 0 ? pAtLag - c : c - pAtLag;
  // remaining favorable from lag to the THRESH bar j (and a bit beyond, to W)
  let ext = 0; for (let j = lagIdx; j < N; j++) { if (SYM[j] !== SYM[o.i] || TS[j] - TS[o.i] > W * 1000) break; const fav = o.dir > 0 ? Hh[j] - pAtLag : pAtLag - Ll[j]; if (fav > ext) ext = fav; }
  remPts.push(ext);
  if (moveByLag >= THRESH * 0.7) fastShare++;   // most of the move already gone by lag
}
remPts.sort((a, b) => a - b);
const q = p => remPts[Math.floor(p * (remPts.length - 1))];
console.log(`\nCATCHABILITY (favorable pts STILL available ${LAG}s after onset): p25=${q(.25).toFixed(1)} p50=${q(.5).toFixed(1)} p75=${q(.75).toFixed(1)} p90=${q(.9).toFixed(1)}`);
console.log(`  share of onsets where >=70% of move already gone by ${LAG}s (uncatchable): ${(100*fastShare/onsets.length).toFixed(0)}%`);
console.log(`  share with >=8pt still available after lag: ${(100*remPts.filter(x=>x>=8).length/remPts.length).toFixed(0)}%   >=12pt: ${(100*remPts.filter(x=>x>=12).length/remPts.length).toFixed(0)}%`);

// LEADUP reverse study: precursor features at onset (<=i) vs random RTH baseline
function feats(i) {
  const d5 = wsum(PD, i, 5), d15 = wsum(PD, i, 15), d30 = wsum(PD, i, 30);
  const tr5 = wsum(PTR, i, 5), tr600 = wsum(PTR, i, 600);
  const intensZ = (tr600 && tr600 > 0) ? tr5 / (tr600 / 120) : null;
  const v5 = (wsum(PB, i, 5) || 0) + (wsum(PS, i, 5) || 0), v600 = (wsum(PB, i, 600) || 0) + (wsum(PS, i, 600) || 0);
  const volZ = v600 > 0 ? v5 / (v600 / 120) : null;
  let block5 = 0; for (let k = Math.max(seg[i], i - 5); k <= i; k++) if (MX[k] > block5) block5 = MX[k];
  return { d5: d5 ?? 0, d15: d15 ?? 0, d30: d30 ?? 0, intensZ, volZ, block5 };
}
// baseline: every 600th RTH second
const base = []; for (let i = 600; i < N; i += 600) { if (i - 30 < seg[i]) continue; const hr = etHour(TS[i]); if (hr < 9 || hr > 15) continue; base.push(i); }
function avg(arr, f) { let s = 0, m = 0; for (const x of arr) { const v = f(x); if (Number.isFinite(v)) { s += v; m++; } } return m ? s / m : NaN; }
const onIdx = onsets.map(o => o.i);
console.log(`\nLEADUP precursor at onset vs baseline (RTH):`);
console.log(`  feature        onset      baseline`);
for (const [k, f] of [['intensZ', i => feats(i).intensZ], ['volZ', i => feats(i).volZ], ['block5', i => feats(i).block5], ['|d5|', i => Math.abs(feats(i).d5)], ['|d15|', i => Math.abs(feats(i).d15)]]) {
  console.log(`  ${k.padEnd(12)} ${avg(onIdx, f).toFixed(2).padStart(8)}   ${avg(base, f).toFixed(2).padStart(8)}`);
}
// DIRECTIONAL precursor: does pre-onset delta sign match explosion direction?
let dirMatch5 = 0, dirMatch15 = 0, nz5 = 0, nz15 = 0;
for (const o of onsets) { const f = feats(o.i); if (f.d5 !== 0) { nz5++; if (Math.sign(f.d5) === o.dir) dirMatch5++; } if (f.d15 !== 0) { nz15++; if (Math.sign(f.d15) === o.dir) dirMatch15++; } }
console.log(`\nDIRECTIONAL precursor (does pre-onset delta point the way the move explodes?):`);
console.log(`  sign(delta last 5s)  == explosion dir: ${(100*dirMatch5/nz5).toFixed(1)}%  (n=${nz5})`);
console.log(`  sign(delta last 15s) == explosion dir: ${(100*dirMatch15/nz15).toFixed(1)}%  (n=${nz15})`);
console.log(`\nRead: tradable IF (a) catchable pts after lag are meaningful (p50>=8), AND (b) a precursor`);
console.log(`is elevated pre-onset AND (c) directional precursor >55% so we know WHICH way to ride.\n`);
