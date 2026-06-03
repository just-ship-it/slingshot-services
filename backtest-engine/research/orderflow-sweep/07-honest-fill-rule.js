/**
 * Phase 2 — HONEST better-fill on the core rule: fade a BLOCK-DEFENDED ROUND-50 sweep in RTH.
 * Rest a limit OFF points beyond the level; it fills ONLY if the sweep actually reaches it
 * (real fill check + adverse selection). Among fills, outcome from the fill price; stop is a
 * continuation STOP points beyond the level. Reports fill-rate, exp-per-fill, exp-per-signal
 * (unfilled = no trade), WR, OOS 60/40. This is the candidate tradable rule.
 *
 * node --max-old-space-size=8192 research/orderflow-sweep/07-honest-fill-rule.js --in data/features/nq_panel_1s_full.csv
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_panel_1s_full.csv');
const HOLD = +arg('hold', 300), WIN = +arg('win', 1800), COOLDOWN = +arg('cooldown', 300), SLIP = +arg('slip', 0.5);
const T = +arg('tgt', 6), STOP = +arg('stop', 6), BLK = +arg('blk', 25), FILLWIN = +arg('fillwin', 60);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
console.log(`\n=== Honest better-fill rule: round50 + RTH + block>=${BLK}, fade, tgt ${T}, stop@level+${STOP}, fillwin ${FILLWIN}s ===\n`);

let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap), MX = new Float64Array(cap);
const SYM = [];
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); MX = g(MX); }
{ const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity }); let ci = null; for await (const line of rl) { if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; } if (n >= cap) grow(); const f = line.split(','); TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]); Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close]; MX[n] = +f[ci.maxSz]; n++; } }
const N = n; console.log(`${N.toLocaleString()} rows`);
const segStart = new Int32Array(N); { let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; segStart[i] = s; } }
const etHour = ms => { const d = new Date(ms); return (d.getUTCHours() + 24 - 5) % 24; };

// simulate resting limit at R + dir*off (dir=+1 sweep-up→short). Fill if sweep reaches limit
// within FILLWIN. Then outcome from fill: win = move T in fade dir; loss = continuation STOP beyond R.
function sim(i, R, dir, off) {
  const limit = R + dir * off, hm = HOLD * 1000, fw = FILLWIN * 1000;
  let filled = false, fillJ = -1;
  for (let j = i; j < N; j++) {
    if (SYM[j] !== SYM[i] || TS[j] - TS[i] > fw) break;
    if (dir > 0) { if (Hh[j] >= limit) { filled = true; fillJ = j; break; } if (Ll[j] <= R - T) break; } // missed (reverted before fill)
    else { if (Ll[j] <= limit) { filled = true; fillJ = j; break; } if (Hh[j] >= R + T) break; }
  }
  if (!filled) return { filled: false };
  for (let j = fillJ; j < N; j++) {
    if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) return { filled: true, pnl: 0, win: false };
    if (dir > 0) { if (limit - Ll[j] >= T) return { filled: true, pnl: T, win: true }; if (Hh[j] - R >= STOP) return { filled: true, pnl: -((R + STOP) - limit) - SLIP, win: false }; }
    else { if (Hh[j] - limit >= T) return { filled: true, pnl: T, win: true }; if (R - Ll[j] >= STOP) return { filled: true, pnl: -(limit - (R - STOP)) - SLIP, win: false }; }
  }
  return { filled: true, pnl: 0, win: false };
}

// collect core-filter sweeps (round50 + RTH + block>=BLK)
const ev = []; const lastSweep = new Map();
for (let i = WIN; i < N; i++) {
  const hr = etHour(TS[i]); if (hr < 9 || hr > 15) continue;
  const cands = [];
  const r50u = Math.ceil(Cc[i - 1] / 50) * 50, r50d = Math.floor(Cc[i - 1] / 50) * 50;
  if (Hh[i] >= r50u && Hh[i - 1] < r50u) cands.push({ R: r50u, dir: 1 });
  if (Ll[i] <= r50d && Ll[i - 1] > r50d) cands.push({ R: r50d, dir: -1 });
  for (const c of cands) {
    const key = Math.round(c.R); const last = lastSweep.get(key); if (last !== undefined && TS[i] - last < COOLDOWN * 1000) continue; lastSweep.set(key, TS[i]);
    // block must print STRICTLY BEFORE the pierce second (no same-second lookahead): [i-5, i-1]
    let block5 = 0; for (let k = Math.max(segStart[i], i - 5); k <= i - 1; k++) if (MX[k] > block5) block5 = MX[k];
    if (block5 < BLK) continue;
    ev.push({ i, ts: TS[i], R: c.R, dir: c.dir });
  }
}
console.log(`core-filter signals: ${ev.length.toLocaleString()} (~${(ev.length/270).toFixed(1)}/day)\n`);
const mid = ev.length ? ev[Math.floor(ev.length / 2)].ts : 0;

function run(off) {
  let signals = ev.length, fills = 0, win = 0, pnlFill = 0, pnlSig = 0;
  let teSig = 0, tePnl = 0, teFills = 0, teWin = 0, trWin = 0, trFills = 0;
  for (const e of ev) {
    const r = sim(e.i, e.R, e.dir, off);
    const isTe = e.ts >= mid;
    if (r.filled) { fills++; pnlFill += r.pnl; pnlSig += r.pnl; if (r.win) win++; if (isTe) { teFills++; if (r.win) teWin++; tePnl += r.pnl; } else { trFills++; if (r.win) trWin++; } }
    if (isTe) teSig++;
  }
  return { off, fillRate: fills / signals, expFill: fills ? pnlFill / fills : 0, expSig: pnlSig / signals, wr: fills ? win / fills : 0,
    teExpSig: teSig ? tePnl / teSig : 0, trWR: trFills ? trWin / trFills : 0, teWR: teFills ? teWin / teFills : 0, fills };
}
console.log(`off  fill%   WR     exp/fill  exp/signal   WR train→test   exp/signal(test)`);
for (const off of [0, 1, 2, 3]) {
  const r = run(off);
  console.log(`  ${off}  ${(r.fillRate*100).toFixed(0).padStart(3)}%  ${(r.wr*100).toFixed(1)}%   ${r.expFill>=0?'+':''}${r.expFill.toFixed(2)}     ${r.expSig>=0?'+':''}${r.expSig.toFixed(2)}      ${(r.trWR*100).toFixed(1)}→${(r.teWR*100).toFixed(1)}        ${r.teExpSig>=0?'+':''}${r.teExpSig.toFixed(2)}  (fills ${r.fills})`);
}
console.log(`\nRead: exp/signal accounts for unfilled (no trade). Best off balances fill-rate vs better price.`);
console.log(`A positive exp/signal that HOLDS on test (last col) = the honest deployable edge.\n`);
