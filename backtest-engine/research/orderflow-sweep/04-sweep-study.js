/**
 * Phase 2 — Liquidity-sweep event study WITH order-flow confirmation (the new ingredient
 * the OHLCV-only wick study lacked). Osler: stops cluster just beyond prior extremes /
 * round numbers; a sweep pierces them then often reverts (cascade exhausts) — OR it's a
 * real breakout. The tradable question: does ORDER FLOW at the pierce separate the two?
 *
 * Sweep-up candidate at second i (lookahead-safe):
 *   • A resistance level R set by PAST bars only — trailing-30m high over [i-1800, i-1],
 *     or the nearest round number above — that was intact at i-1 and is pierced now
 *     (H[i] >= R and H[i-1] < R). Per-level cooldown to avoid duplicate seconds.
 * Outcome (forward, intrabar high/low): FADE the sweep (short at R).
 *   • reversion WIN = price falls REV pts back below R before continuing CONT pts above R.
 *   • continuation LOSS = price extends CONT pts above R first.
 * Flow at pierce (known by end of pierce second): delta over last 10s into the level,
 * block print (maxSz), volume vs baseline. We bucket reversion-rate by these.
 *
 * LOOKAHEAD: level from PAST bars (excludes current), flow up to & incl pierce second,
 * outcome strictly forward. Sweep-down is the mirror.
 *
 * Usage: node research/orderflow-sweep/04-sweep-study.js --in data/features/nq_panel_1s_full.csv
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_panel_1s_full.csv');
const REV = +arg('rev', 8), CONT = +arg('cont', 6), HOLD = +arg('hold', 300);
const WIN = +arg('win', 1800);              // trailing-extreme lookback (30m)
const COOLDOWN = +arg('cooldown', 300);
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

console.log(`\n=== Sweep study (fade): rev +${REV} before cont -${CONT}, hold ${HOLD}s, trail ${WIN}s ===\n${inPath}\n`);

const ts = [], sym = [], H = [], L = [], C = [], delta = [], buy = [], sell = [], tr = [], mx = [];
{
  const rl = (await import('readline')).createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
  let ci = null;
  for await (const line of rl) {
    if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; }
    const f = line.split(',');
    ts.push(new Date(f[ci.ts]).getTime()); sym.push(f[ci.symbol]);
    H.push(+f[ci.high]); L.push(+f[ci.low]); C.push(+f[ci.close]);
    delta.push(+f[ci.delta]); buy.push(+f[ci.buyVol]); sell.push(+f[ci.sellVol]); tr.push(+f[ci.trades]); mx.push(+f[ci.maxSz]);
  }
}
const N = ts.length;
console.log(`${N.toLocaleString()} panel seconds\n`);

function back(i, w) { const j = i - w; if (j < 0) return -1; if (sym[j] !== sym[i]) return -1; if (ts[i] - ts[j] > (w + 5) * 1000) return -1; return j; }
// trailing extreme over [i-w, i-1] (EXCLUDES current bar so the level pre-existed the pierce)
function trailHiPrev(i, w) { const j = back(i, w); if (j < 0) return null; let m = -Infinity; for (let k = j; k <= i - 1; k++) if (H[k] > m) m = H[k]; return m; }
function trailLoPrev(i, w) { const j = back(i, w); if (j < 0) return null; let m = Infinity; for (let k = j; k <= i - 1; k++) if (L[k] < m) m = L[k]; return m; }
function sumB(arr, i, w) { const j = back(i, w); if (j < 0) return 0; let s = 0; for (let k = j + 1; k <= i; k++) s += arr[k]; return s; }

// fade outcome from pierce i at level R, dir: +1 = sweep-up (we SHORT), -1 = sweep-down (we LONG)
function fadeOutcome(i, R, dir) {
  const hm = HOLD * 1000;
  for (let j = i; j < N; j++) {
    if (sym[j] !== sym[i] || ts[j] - ts[i] > hm) return 'to';
    if (dir > 0) { // short fade: win if price drops REV below R; lose if continues CONT above R
      if (C[j] <= R - REV || L[j] <= R - REV) return 'rev';
      if (H[j] >= R + CONT) return 'cont';
    } else {
      if (C[j] >= R + REV || H[j] >= R + REV) return 'rev';
      if (L[j] <= R - CONT) return 'cont';
    }
  }
  return 'to';
}

const lastSweep = new Map(); // key -> ts (cooldown)
const events = []; // {ts, type, levelKind, dir, R, pierceDelta10, block5, volZ, out}

for (let i = WIN; i < N; i++) {
  // candidate levels intact at i-1, pierced at i
  const hiPrev = trailHiPrev(i, WIN), loPrev = trailLoPrev(i, WIN);
  const cands = [];
  if (hiPrev != null && H[i] >= hiPrev && H[i - 1] < hiPrev) cands.push({ R: hiPrev, dir: +1, kind: 'trailHi' });
  if (loPrev != null && L[i] <= loPrev && L[i - 1] > loPrev) cands.push({ R: loPrev, dir: -1, kind: 'trailLo' });
  // round-50 just above/below, pierced this bar
  const r50up = Math.ceil(C[i - 1] / 50) * 50, r50dn = Math.floor(C[i - 1] / 50) * 50;
  if (H[i] >= r50up && H[i - 1] < r50up) cands.push({ R: r50up, dir: +1, kind: 'round50' });
  if (L[i] <= r50dn && L[i - 1] > r50dn) cands.push({ R: r50dn, dir: -1, kind: 'round50' });

  for (const c of cands) {
    const key = `${c.kind}:${Math.round(c.R)}`;
    const last = lastSweep.get(key);
    if (last !== undefined && ts[i] - last < COOLDOWN * 1000) continue;
    lastSweep.set(key, ts[i]);
    // pierce flow (known by end of second i)
    const pierceDelta10 = sumB(delta, i, 10) * c.dir;        // >0 = aggression in the pierce direction
    let block5 = 0; for (let k = Math.max(0, i - 4); k <= i; k++) if (sym[k] === sym[i]) block5 = Math.max(block5, mx[k]);
    const vol60 = sumB(buy, i, 60) + sumB(sell, i, 60);
    const vol1800 = sumB(buy, i, 1800) + sumB(sell, i, 1800);
    const volZ = vol1800 > 0 ? vol60 / (vol1800 / 30) : 1;
    const out = fadeOutcome(i, c.R, c.dir);
    events.push({ ts: ts[i], kind: c.kind, dir: c.dir, pierceDelta10, block5, volZ, out });
  }
}
console.log(`Sweep events: ${events.length.toLocaleString()}\n`);

const mid = events.length ? events[Math.floor(events.length / 2)].ts : 0;
function rate(sub) { const r = sub.filter(e => e.out === 'rev').length, c = sub.filter(e => e.out === 'cont').length; const res = r + c; return { rev: r, cont: c, to: sub.length - res, pRev: res ? r / res : 0, n: sub.length }; }
function tt(sub) { const a = rate(sub), trn = rate(sub.filter(e => e.ts < mid)), te = rate(sub.filter(e => e.ts >= mid)); return { a, trn, te }; }
function show(title, sub) {
  if (sub.length < 20) { console.log(`${title}: n=${sub.length} (too few)`); return; }
  const { a, trn, te } = tt(sub);
  // expectancy of the FADE: win=+REV, loss=-CONT, timeout~0
  const exp = (a.rev * REV - a.cont * CONT) / a.n;
  console.log(`${title.padEnd(34)} n=${String(a.n).padStart(5)}  P(rev|resolved)=${(a.pRev*100).toFixed(1)}%  exp(fade)=${exp>=0?'+':''}${exp.toFixed(2)}pt  train→test ${(trn.pRev*100).toFixed(1)}%→${(te.pRev*100).toFixed(1)}%`);
}

console.log('--- baseline by level kind ---');
for (const k of ['trailHi', 'trailLo', 'round50']) show(`${k} (all)`, events.filter(e => e.kind === k));
console.log('\n--- conditioned on pierce ORDER FLOW (all level kinds) ---');
show('strong pierce delta (top tercile)', topTercile(events, 'pierceDelta10'));
show('weak/absent pierce delta (bot tercile)', botTercile(events, 'pierceDelta10'));
show('block print >=25 at pierce', events.filter(e => e.block5 >= 25));
show('block print >=50 at pierce', events.filter(e => e.block5 >= 50));
show('volume spike volZ>=3', events.filter(e => e.volZ >= 3));
show('low volume volZ<1', events.filter(e => e.volZ < 1));

function topTercile(arr, k) { const s = arr.map(e => e[k]).sort((a, b) => a - b); const t = s[Math.floor(s.length * 2 / 3)]; return arr.filter(e => e[k] >= t); }
function botTercile(arr, k) { const s = arr.map(e => e[k]).sort((a, b) => a - b); const t = s[Math.floor(s.length / 3)]; return arr.filter(e => e[k] <= t); }

console.log(`\nRead: if P(rev) is high & fade-exp positive for a level kind AND lifts further with a`);
console.log(`particular flow signature (and holds train→test), that's a tradable sweep-fade setup.`);
console.log(`If strong-pierce-delta sweeps CONTINUE (low P(rev)), that separates breakout from trap.\n`);
