/**
 * Phase 3 — Cross-asset lead-lag: does ES lead NQ (or vice versa) at the 1-5s scale?
 * Non-obvious / retail-invisible: requires watching two tapes simultaneously. Uses BACK-ADJUSTED
 * continuous 1s (pure price action, no level data → continuous is correct here).
 *
 * Tests:
 *  (1) Lagged cross-correlation of 1s returns: corr(ES ret @ t-k, NQ ret @ t) vs corr(NQ@t-k, ES@t)
 *      — who leads, at what lag.
 *  (2) TRADABLE lead-lag: when ES makes a sharp 3s move but NQ has NOT yet (NQ flat last 3s),
 *      does NQ catch up in the next CATCH seconds? Hit-rate + point expectancy, OOS holdout (last 1/3).
 *
 * LOOKAHEAD-safe: signal uses ES/NQ data <= t; outcome is NQ forward. Aligned strictly by second.
 * node --max-old-space-size=8192 research/orderflow-sweep/13-cross-asset-leadlag.js
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(ROOT, 'data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const START = arg('start', '2025-01-01'), END = arg('end', '2026-01-23');
const CATCH = +arg('catch', 5), ESMOVE = +arg('esmove', 4), NQFLAT = +arg('nqflat', 2);
const sD = START.slice(0, 10), eD = END.slice(0, 10);
console.log(`\n=== Cross-asset ES↔NQ lead-lag (1s continuous), ${START}→${END} ===\n`);

// load NQ continuous close into Map(secMs -> close)
function loadCloseMap(file) {
  return new Promise(async (res) => {
    const m = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity }); let ci = null;
    for await (const line of rl) {
      if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; }
      const dp = line.slice(0, 10); if (dp < sD) continue; if (dp > eD) break;
      const f = line.split(','); const ts = new Date(f[ci.ts_event]).getTime();
      m.set(Math.floor(ts / 1000) * 1000, +f[ci.close]);
    }
    res(m);
  });
}
console.log('loading NQ continuous ...');
const NQ = await loadCloseMap(path.join(DATA, 'ohlcv/nq/NQ_ohlcv_1s_continuous.csv'));
console.log(`  NQ secs ${NQ.size.toLocaleString()}`);
console.log('loading ES continuous ...');
const ES = await loadCloseMap(path.join(DATA, 'ohlcv/es/ES_ohlcv_1s_continuous.csv'));
console.log(`  ES secs ${ES.size.toLocaleString()}`);

// build aligned arrays on common seconds (sorted)
const secs = []; for (const k of NQ.keys()) if (ES.has(k)) secs.push(k); secs.sort((a, b) => a - b);
const M = secs.length; console.log(`aligned seconds: ${M.toLocaleString()}\n`);
const nq = new Float64Array(M), es = new Float64Array(M);
for (let i = 0; i < M; i++) { nq[i] = NQ.get(secs[i]); es[i] = ES.get(secs[i]); }
// contiguity: only use steps where consecutive seconds are 1s apart
function ret(arr, i) { return (i > 0 && secs[i] - secs[i - 1] <= 2000) ? arr[i] - arr[i - 1] : NaN; }
const nqR = new Float64Array(M).fill(NaN), esR = new Float64Array(M).fill(NaN);
for (let i = 1; i < M; i++) { nqR[i] = ret(nq, i); esR[i] = ret(es, i); }

// (1) lagged cross-correlation
function corrLag(aR, bR, k) { // corr(aR[t-k], bR[t])
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = Math.max(1, k); i < M; i++) { const a = aR[i - k], b = bR[i]; if (!Number.isFinite(a) || !Number.isFinite(b)) continue; n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
  if (n < 100) return NaN; const cov = sab / n - (sa / n) * (sb / n); const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2; return cov / Math.sqrt(va * vb);
}
console.log('(1) lagged cross-correlation of 1s returns (ES scaled ~NQ via corr, not beta):');
console.log('  lag k   corr(ES@t-k, NQ@t)   corr(NQ@t-k, ES@t)');
for (const k of [0, 1, 2, 3, 5, 10]) console.log(`   ${String(k).padStart(2)}      ${corrLag(esR, nqR, k).toFixed(4)}              ${corrLag(nqR, esR, k).toFixed(4)}`);

// (2) tradable lead-lag: ES sharp move @ t over last 3s, NQ flat last NQFLAT s → does NQ catch up?
function move(arr, i, k) { return (i - k >= 0 && secs[i] - secs[i - k] <= (k + 2) * 1000) ? arr[i] - arr[i - k] : NaN; }
const mid = secs[Math.floor(M * 2 / 3)]; // last 1/3 = holdout
let n = 0, win = 0, pnl = 0, hN = 0, hWin = 0, hPnl = 0;
for (let i = 10; i < M - CATCH; i++) {
  const esM = move(es, i, 3), nqM = move(nq, i, NQFLAT);
  if (!Number.isFinite(esM) || !Number.isFinite(nqM)) continue;
  if (Math.abs(esM) < ESMOVE) continue;          // ES moved sharply
  if (Math.abs(nqM) > 1.5) continue;             // NQ hasn't moved yet (lag)
  const dir = Math.sign(esM);
  // outcome: NQ follow over next CATCH sec, target +4 / stop -3 (small-fish catch-up)
  let p = 0; const e0 = nq[i];
  for (let j = i + 1; j <= i + CATCH && j < M; j++) { if (secs[j] - secs[i] > (CATCH + 2) * 1000) break; const up = nq[j] - e0; if (dir > 0) { if (up >= 4) { p = 4; break; } if (up <= -3) { p = -3; break; } } else { if (up <= -4) { p = 4; break; } if (up >= 3) { p = -3; break; } } }
  n++; if (p > 0) win++; pnl += p;
  if (secs[i] >= mid) { hN++; if (p > 0) hWin++; hPnl += p; }
}
console.log(`\n(2) tradable lead-lag (ES move>=${ESMOVE} in 3s & NQ flat → follow NQ, +4/-3 in ${CATCH}s):`);
console.log(`  ALL: n=${n.toLocaleString()}  WR ${(100*win/n).toFixed(1)}%  exp ${(pnl/n>=0?'+':'')}${(pnl/n).toFixed(2)}pt`);
console.log(`  HOLDOUT (last 1/3): n=${hN.toLocaleString()}  WR ${(100*hWin/hN).toFixed(1)}%  exp ${(hPnl/hN>=0?'+':'')}${(hPnl/hN).toFixed(2)}pt`);
console.log(`\nRead: asymmetric lag-corr (one column > other) = a leader. Positive holdout exp on the`);
console.log(`catch-up trade = a retail-invisible cross-asset edge. (HFT may eat it — the holdout tells truth.)\n`);
