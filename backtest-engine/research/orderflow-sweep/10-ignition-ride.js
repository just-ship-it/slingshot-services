/**
 * Phase 3 — Can a small fish RIDE the ignition? Honest forward test (incl. false positives).
 * Trigger at second t (lookahead-safe, past-only): a momentum+delta burst in the last K sec.
 * Enter WITH it at C[t], ride to +TGT before -STOP within HOLD. Measure over ALL firings
 * (not just real explosions) → real precision/expectancy. Cooldown dedupes. OOS 60/40.
 *
 * node --max-old-space-size=8192 research/orderflow-sweep/10-ignition-ride.js --in data/features/nq_panel_1s_full.csv
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_panel_1s_full.csv');
const K = +arg('k', 3), HOLD = +arg('hold', 120), COOLDOWN = +arg('cooldown', 60), SLIP = +arg('slip', 0.5);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
console.log(`\n=== Ignition ride (go WITH a ${K}s momentum+delta burst), honest incl false positives ===\n`);

let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap), D = new Float64Array(cap), MX = new Float64Array(cap);
const SYM = [];
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); D = g(D); MX = g(MX); }
{ const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity }); let ci = null; for await (const line of rl) { if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; } if (n >= cap) grow(); const f = line.split(','); TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]); Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close]; D[n] = +f[ci.delta]; MX[n] = +f[ci.maxSz]; n++; } }
const N = n; console.log(`${N.toLocaleString()} rows`);
const seg = new Int32Array(N); { let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; seg[i] = s; } }
const PD = (() => { const P = new Float64Array(N); let a = 0; for (let i = 0; i < N; i++) { a += D[i]; P[i] = a; } return P; })();
function wsum(P, i, w) { const lo = i - w + 1; if (lo < seg[i]) return null; return P[i] - (lo > 0 ? P[lo - 1] : 0); }
const etHour = ms => { const d = new Date(ms); return (d.getUTCHours() + 24 - 5) % 24; };

// ride outcome: enter C[i], dir, +TGT before -STOP within HOLD
function ride(i, dir, TGT, STOP) {
  const e = Cc[i], hm = HOLD * 1000;
  for (let j = i + 1; j < N; j++) {
    if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) { const mtm = dir > 0 ? Cc[j - 1] - e : e - Cc[j - 1]; return mtm; }
    if (dir > 0) { if (Hh[j] - e >= TGT) return TGT; if (e - Ll[j] >= STOP) return -(STOP + SLIP); }
    else { if (e - Ll[j] >= TGT) return TGT; if (Hh[j] - e >= STOP) return -(STOP + SLIP); }
  }
  return 0;
}

function runTrigger(Pthr, Dthr, TGT, STOP, rthOnly) {
  let lastFire = -1e18, nT = 0, win = 0, pnl = 0, teP = 0, teN = 0, trW = 0, trN = 0, teW = 0;
  let mid = TS[Math.floor(N / 2)];
  for (let i = K; i < N; i++) {
    if (i - K < seg[i]) continue;
    if (rthOnly) { const hr = etHour(TS[i]); if (hr < 9 || hr > 15) continue; }
    const pm = Cc[i] - Cc[i - K]; const dl = wsum(PD, i, K);
    if (dl == null) continue;
    if (Math.abs(pm) < Pthr || Math.abs(dl) < Dthr || Math.sign(pm) !== Math.sign(dl)) continue;
    if (TS[i] - lastFire < COOLDOWN * 1000) continue;
    lastFire = TS[i];
    const dir = Math.sign(pm);
    const p = ride(i, dir, TGT, STOP);
    nT++; if (p > 0) win++; pnl += p;
    if (TS[i] >= mid) { teP += p; teN++; if (p > 0) teW++; } else { trW += p > 0 ? 1 : 0; trN++; }
  }
  return { nT, wr: nT ? win / nT : 0, exp: nT ? pnl / nT : 0, teExp: teN ? teP / teN : 0, trWR: trN ? trW / trN : 0, teWR: teN ? teW / teN : 0 };
}

console.log(`trigger: |move ${K}s|>=P AND |delta ${K}s|>=D, same sign. ride +TGT/-STOP, hold ${HOLD}s (RTH).`);
console.log(`P/D/TGT/STOP        n     WR     exp/trade   WR tr→te   exp(test)`);
for (const [P, Dn, TGT, STOP] of [[3, 20, 10, 6], [3, 40, 10, 6], [5, 40, 12, 8], [5, 60, 15, 8], [4, 50, 10, 8], [6, 80, 15, 10]]) {
  const r = runTrigger(P, Dn, TGT, STOP, true);
  if (r.nT < 50) { console.log(`  ${P}/${Dn}/${TGT}/${STOP}: n=${r.nT} (few)`); continue; }
  console.log(`  ${P}/${Dn}/${TGT}/${STOP}`.padEnd(20) + ` ${String(r.nT).padStart(5)}  ${(r.wr*100).toFixed(1)}%  ${r.exp>=0?'+':''}${r.exp.toFixed(2)}pt     ${(r.trWR*100).toFixed(0)}→${(r.teWR*100).toFixed(0)}     ${r.teExp>=0?'+':''}${r.teExp.toFixed(2)}`);
}
console.log(`\nRead: positive exp/trade that HOLDS on test = ridable ignition. If all ~0/negative,`);
console.log(`HFT already eats the ignition and the trade tape gives no small-fish edge there.\n`);
