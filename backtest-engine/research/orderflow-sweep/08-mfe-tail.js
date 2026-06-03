/**
 * Phase 2 — Are we clipping winners? Measure the favorable-excursion (MFE) distribution of
 * the validated block-defended round-50 sweep FADE, and compare exit policies. If reverting
 * sweeps have a fat tail (20-40pt cascade unwinds), a bigger target / trailing stop turns the
 * thin +1.5pt into something that matches the "5-10pt move" goal.
 *
 * Entry: lookahead-strict (block in [i-5,i-1]) round-50 sweep in RTH, resting limit OFF beyond
 * the level, real fill check. Stop = continuation STOP pts beyond the level. We let the trade
 * run to HOLD and record MFE + outcome under several exit policies. Lookahead-safe; OOS 60/40.
 *
 * node --max-old-space-size=8192 research/orderflow-sweep/08-mfe-tail.js --in data/features/nq_panel_1s_full.csv
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_panel_1s_full.csv');
const HOLD = +arg('hold', 900), WIN = +arg('win', 1800), COOLDOWN = +arg('cooldown', 300), SLIP = +arg('slip', 0.5);
const STOP = +arg('stop', 6), BLK = +arg('blk', 25), OFF = +arg('off', 2), FILLWIN = +arg('fillwin', 60);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
console.log(`\n=== MFE / exit-policy study: round50 block-fade, entry +${OFF} beyond, stop@level+${STOP}, hold ${HOLD}s ===\n`);

let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap), MX = new Float64Array(cap);
const SYM = [];
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); MX = g(MX); }
{ const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity }); let ci = null; for await (const line of rl) { if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; } if (n >= cap) grow(); const f = line.split(','); TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]); Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close]; MX[n] = +f[ci.maxSz]; n++; } }
const N = n; console.log(`${N.toLocaleString()} rows`);
const segStart = new Int32Array(N); { let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; segStart[i] = s; } }
const etHour = ms => { const d = new Date(ms); return (d.getUTCHours() + 24 - 5) % 24; };

// collect signals + fill, then walk the trade recording MFE + exit-policy outcomes
const trades = []; const lastSweep = new Map();
for (let i = WIN; i < N; i++) {
  const hr = etHour(TS[i]); if (hr < 9 || hr > 15) continue;
  const cands = [];
  const r50u = Math.ceil(Cc[i - 1] / 50) * 50, r50d = Math.floor(Cc[i - 1] / 50) * 50;
  if (Hh[i] >= r50u && Hh[i - 1] < r50u) cands.push({ R: r50u, dir: 1 });
  if (Ll[i] <= r50d && Ll[i - 1] > r50d) cands.push({ R: r50d, dir: -1 });
  for (const c of cands) {
    const key = Math.round(c.R); const last = lastSweep.get(key); if (last !== undefined && TS[i] - last < COOLDOWN * 1000) continue; lastSweep.set(key, TS[i]);
    let block5 = 0; for (let k = Math.max(segStart[i], i - 5); k <= i - 1; k++) if (MX[k] > block5) block5 = MX[k];
    if (block5 < BLK) continue;
    // fill: limit at R + dir*OFF, reached within FILLWIN
    const limit = c.R + c.dir * OFF, fw = FILLWIN * 1000; let fillJ = -1;
    for (let j = i; j < N; j++) { if (SYM[j] !== SYM[i] || TS[j] - TS[i] > fw) break; if (c.dir > 0) { if (Hh[j] >= limit) { fillJ = j; break; } if (Ll[j] <= c.R - STOP) break; } else { if (Ll[j] <= limit) { fillJ = j; break; } if (Hh[j] >= c.R + STOP) break; } }
    if (fillJ < 0) continue;
    // walk trade: fade dir = -c.dir. track MFE (favorable) and stop hit. exits computed after.
    let mfe = 0, stoppedAt = Infinity; const F = limit;
    const path = []; // favorable excursion per step until stop
    for (let j = fillJ; j < N; j++) {
      if (SYM[j] !== SYM[i] || TS[j] - TS[i] > HOLD * 1000) break;
      const fav = c.dir > 0 ? F - Ll[j] : Hh[j] - F;     // favorable (reversion) excursion
      const adv = c.dir > 0 ? Hh[j] - c.R : c.R - Ll[j];  // adverse = continuation beyond level
      if (fav > mfe) mfe = fav;
      path.push({ fav, adv });
      if (adv >= STOP) { stoppedAt = j; break; }           // stop hit
    }
    trades.push({ ts: TS[i], dir: c.dir, F, R: c.R, mfe, stopped: stoppedAt < Infinity, path });
  }
}
console.log(`filled trades: ${trades.length.toLocaleString()}\n`);
const mid = trades.length ? trades[Math.floor(trades.length / 2)].ts : 0;

// MFE distribution
const mfes = trades.map(t => t.mfe).sort((a, b) => a - b);
const q = p => mfes[Math.floor(p * (mfes.length - 1))];
console.log(`MFE (favorable reversion, pts):  p25=${q(.25).toFixed(1)}  p50=${q(.5).toFixed(1)}  p75=${q(.75).toFixed(1)}  p90=${q(.9).toFixed(1)}  p95=${q(.95).toFixed(1)}  max=${q(1).toFixed(1)}`);
console.log(`% of trades reaching favorable: >=6pt ${(100*mfes.filter(x=>x>=6).length/mfes.length).toFixed(0)}%  >=10 ${(100*mfes.filter(x=>x>=10).length/mfes.length).toFixed(0)}%  >=20 ${(100*mfes.filter(x=>x>=20).length/mfes.length).toFixed(0)}%  >=30 ${(100*mfes.filter(x=>x>=30).length/mfes.length).toFixed(0)}%\n`);

// exit policies: replay each trade's path
function policyPnl(t, kind, a, b) {
  // returns realized pts. stop loss = -(STOP+SLIP) (continuation). target/trail per policy.
  for (let k = 0; k < t.path.length; k++) {
    const { fav, adv } = t.path[k];
    if (kind === 'fixed') { if (fav >= a) return a; if (adv >= STOP) return -(STOP + SLIP); }
    else if (kind === 'trail') { // arm at a; once armed, exit if fav retraces b from peak
      // need running peak up to k
    }
  }
  // for trail handle separately below
  if (kind === 'fixed') return t.stopped ? -(STOP + SLIP) : 0; // timeout flat
  return null;
}
function trailPnl(t, arm, off) {
  let peak = 0, armed = false;
  for (const { fav, adv } of t.path) {
    if (adv >= STOP && !armed) return -(STOP + SLIP);      // stopped before arming
    if (fav > peak) peak = fav;
    if (!armed && fav >= arm) armed = true;
    if (armed && fav <= peak - off) return peak - off - SLIP; // trail exit (slip on market exit)
    if (armed && adv >= STOP) return -(STOP + SLIP);
  }
  return armed ? (t.path.length ? t.path[t.path.length - 1].fav : 0) : (t.stopped ? -(STOP + SLIP) : 0);
}
function summarize(label, fn) {
  let s = 0, te = 0, nte = 0; for (const t of trades) { const p = fn(t); s += p; if (t.ts >= mid) { te += p; nte++; } }
  console.log(`  ${label.padEnd(28)} exp/trade ${s/trades.length>=0?'+':''}${(s/trades.length).toFixed(2)}pt   OOS-test ${te/nte>=0?'+':''}${(te/nte).toFixed(2)}pt`);
}
console.log('exit policy (entry-filled trades, n=' + trades.length + '):');
for (const tg of [6, 10, 15, 20, 30]) summarize(`fixed target +${tg}`, t => { for (const { fav, adv } of t.path) { if (fav >= tg) return tg; if (adv >= STOP) return -(STOP + SLIP); } return 0; });
summarize('trail arm8 off6', t => trailPnl(t, 8, 6));
summarize('trail arm10 off8', t => trailPnl(t, 10, 8));
summarize('trail arm12 off10', t => trailPnl(t, 12, 10));
console.log(`\nRead: if MFE has a fat tail (p90/p95 >> 6) and a bigger target/trail lifts exp/trade well`);
console.log(`above the +1.5pt fixed-6, the winners were being clipped — bump the target/trail.\n`);
