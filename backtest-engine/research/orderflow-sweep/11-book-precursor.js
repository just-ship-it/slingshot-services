/**
 * Phase 3 — Order-BOOK precursor to explosions (the liquidity-vacuum telegraph).
 * Trade tape doesn't warn (09); theory says the book does: before a sweep, the side that
 * gets RUN thins out (resting liquidity pulled/absorbed → next order has big impact).
 *
 * Targeted, not brute-force: detect explosion onsets (09 logic) in a window, then stream only
 * that window's MBP-1 files, keeping top-of-book state ONLY in [onset-60s, onset] and a calm
 * baseline [onset-360s, onset-300s]. For each onset test whether the RUN-SIDE (ask for an
 * up-move, bid for a down-move) thins approaching the onset, vs the baseline and vs the
 * opposite side. Direction-relative + lookahead-safe (book state up to onset only).
 *
 * node --max-old-space-size=8192 research/orderflow-sweep/11-book-precursor.js \
 *   --panel data/features/nq_panel_1s_full.csv --wstart 2025-09-01 --wend 2025-12-28
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(ROOT, 'data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const PANEL = arg('panel', 'data/features/nq_panel_1s_full.csv');
const WSTART = arg('wstart', '2025-09-01'), WEND = arg('wend', '2025-12-28');
const THRESH = +arg('thresh', 15), W = +arg('w', 60), COIL = +arg('coil', 8), COOLDOWN = +arg('cooldown', 120);
const panelPath = path.isAbsolute(PANEL) ? PANEL : path.join(ROOT, PANEL);
const wsTs = new Date(WSTART).getTime(), weTs = new Date(WEND).getTime() + 864e5;
console.log(`\n=== Book precursor to explosions, window ${WSTART}→${WEND} ===\n`);

// ---- 1. load panel (full), detect onsets, keep those in window ----
let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap);
const SYM = [];
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); }
{ const rl = readline.createInterface({ input: fs.createReadStream(panelPath), crlfDelay: Infinity }); let ci = null; for await (const line of rl) { if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; } if (n >= cap) grow(); const f = line.split(','); TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]); Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close]; n++; } }
const N = n; console.log(`panel ${N.toLocaleString()} rows`);
const seg = new Int32Array(N); { let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; seg[i] = s; } }
function slide(src, w, isMax) { const out = new Float64Array(N).fill(NaN); const dq = new Int32Array(N); let h = 0, t = 0; for (let i = 0; i < N; i++) { if (i === 0 || seg[i] !== seg[i - 1]) h = t = 0; while (t > h && (isMax ? src[dq[t - 1]] <= src[i] : src[dq[t - 1]] >= src[i])) t--; dq[t++] = i; const lo = i - w + 1; while (h < t && (dq[h] < lo || dq[h] < seg[i])) h++; if (lo >= seg[i]) out[i] = src[dq[h]]; } return out; }
const HI30 = slide(Hh, 30, true), LO30 = slide(Ll, 30, false);
function explode(i) { const c = Cc[i], hm = W * 1000; for (let j = i + 1; j < N; j++) { if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) break; if (Hh[j] - c >= THRESH) return 1; if (c - Ll[j] >= THRESH) return -1; } return 0; }
const onsets = []; let last = -1e18;
for (let i = 31; i < N; i++) { if (i - 30 < seg[i]) continue; if (!(HI30[i] - LO30[i] < COIL)) continue; if (TS[i] - last < COOLDOWN * 1000) continue; const d = explode(i); if (!d) continue; last = TS[i]; if (TS[i] >= wsTs && TS[i] <= weTs) onsets.push({ ts: TS[i], dir: d, sym: SYM[i] }); }
console.log(`onsets in window: ${onsets.length.toLocaleString()}`);

// ---- 2. needed seconds + primary symbol map (from panel) ----
const need = new Map();   // secMs -> {kind:'on'|'base', onsetIdx}
function mark(secMs, kind, oi) { if (!need.has(secMs)) need.set(secMs, []); need.get(secMs).push({ kind, oi }); }
onsets.forEach((o, oi) => { for (let s = 60; s >= 0; s--) mark(o.ts - s * 1000, 'on', oi); for (let s = 360; s >= 300; s--) mark(o.ts - s * 1000, 'base', oi); });
const primarySym = new Map(); for (let i = 0; i < N; i++) { if (TS[i] >= wsTs - 400000 && TS[i] <= weTs) if (need.has(TS[i])) primarySym.set(TS[i], SYM[i]); }
console.log(`needed seconds: ${need.size.toLocaleString()}`);

// ---- 3. stream MBP-1 files for window, capture last top-of-book per needed second (primary) ----
const book = new Map();   // secMs -> {bsz,asz,bct,act}
const mbpDir = path.join(DATA, 'orderflow/nq/mbp-1');
const files = fs.readdirSync(mbpDir).filter(f => /glbx-mdp3-(\d{8})\.mbp-1\.csv/.test(f)).filter(f => { const d = f.match(/(\d{8})/)[1]; const iso = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`; const t = new Date(iso).getTime(); return t >= wsTs - 864e5 && t <= weTs; }).sort();
console.log(`MBP-1 files to scan: ${files.length}`);
let scanned = 0, t0 = Date.now();
for (const fn of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(mbpDir, fn)), crlfDelay: Infinity });
  let ci = null;
  for await (const line of rl) {
    if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; }
    const f = line.split(',');
    const ts = new Date(f[ci.ts_event]).getTime(); const secMs = Math.floor(ts / 1000) * 1000;
    if (!need.has(secMs)) continue;
    if (primarySym.get(secMs) !== f[ci.symbol]) continue;   // primary contract only
    const bsz = +f[ci.bid_sz_00], asz = +f[ci.ask_sz_00], bct = +f[ci.bid_ct_00], act = +f[ci.ask_ct_00];
    if (!Number.isFinite(bsz) || !Number.isFinite(asz)) continue;
    book.set(secMs, { bsz, asz, bct, act }); // last update in the second wins
  }
  scanned++; if (scanned % 20 === 0) console.log(`  ${scanned}/${files.length} files (${((Date.now()-t0)/1000).toFixed(0)}s), book secs ${book.size.toLocaleString()}`);
}
console.log(`captured book seconds: ${book.size.toLocaleString()}\n`);

// ---- 4. per-onset features: does the RUN side thin approaching onset? ----
function avgSide(o, fromS, toS, side) { // side: 'run'|'opp'|'tot' ; window [onset-fromS, onset-toS]
  let s = 0, m = 0;
  for (let sec = fromS; sec >= toS; sec--) { const b = book.get(o.ts - sec * 1000); if (!b) continue; const run = o.dir > 0 ? b.asz : b.bsz, opp = o.dir > 0 ? b.bsz : b.asz; s += side === 'run' ? run : side === 'opp' ? opp : (run + opp); m++; }
  return m ? s / m : NaN;
}
const rows = [];
for (const o of onsets) {
  const runFar = avgSide(o, 60, 41, 'run'), runNear = avgSide(o, 10, 0, 'run');
  const oppFar = avgSide(o, 60, 41, 'opp'), oppNear = avgSide(o, 10, 0, 'opp');
  const baseRun = avgSide(o, 360, 341, 'run'), baseRunNear = avgSide(o, 320, 300, 'run'); // baseline same-shape (calm)
  if (![runFar, runNear, oppFar, oppNear].every(Number.isFinite)) continue;
  rows.push({
    ts: o.ts,
    runThin: runNear / runFar,             // <1 = run side thinned toward onset
    oppThin: oppNear / oppFar,
    baseThin: Number.isFinite(baseRun) && Number.isFinite(baseRunNear) ? baseRunNear / baseRun : NaN,
    runVsOpp: runNear / oppNear,            // <1 = run side thinner than opp at onset
  });
}
console.log(`onsets with book coverage: ${rows.length.toLocaleString()}\n`);
function med(arr) { const a = arr.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; }
function mean(arr) { const a = arr.filter(Number.isFinite); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
console.log(`RUN-side thinning (near/far, <1 = thinned before move):`);
console.log(`  run side:    mean ${mean(rows.map(r=>r.runThin)).toFixed(3)}  median ${med(rows.map(r=>r.runThin)).toFixed(3)}`);
console.log(`  opp side:    mean ${mean(rows.map(r=>r.oppThin)).toFixed(3)}  median ${med(rows.map(r=>r.oppThin)).toFixed(3)}`);
console.log(`  BASELINE (calm, run side 5min prior): mean ${mean(rows.map(r=>r.baseThin)).toFixed(3)}  median ${med(rows.map(r=>r.baseThin)).toFixed(3)}`);
console.log(`  run-vs-opp size at onset (<1 = run side thinner): mean ${mean(rows.map(r=>r.runVsOpp)).toFixed(3)}  median ${med(rows.map(r=>r.runVsOpp)).toFixed(3)}`);
const thinFrac = rows.filter(r => r.runThin < 0.8).length / rows.length;
console.log(`  share of onsets with run-side thinned >20% pre-move: ${(100*thinFrac).toFixed(1)}%`);
console.log(`\nRead: if run-side thinning (mean<1) is clearly below the baseline thinning AND below opp-side,`);
console.log(`the book telegraphs the move via a directional liquidity vacuum → novel small-fish precursor.\n`);
