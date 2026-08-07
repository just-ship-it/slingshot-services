/**
 * JV-ICT bracket-mode 1s simulator (Tasks 2+4 of the R:R geometry study).
 *
 * Same order lifecycle as 08-mfe-mae-1s-sim.js (placement at 15m close,
 * exact-limit fills on first touching 1s bar, engine-honest pre-fill cancels,
 * forced flat 16:00 ET) but instead of raw excursions each FILL runs a set of
 * independent exit SCHEMES evaluated per 1s bar from the fill instant:
 *
 *  Structural brackets (Task 2): stop = sweep extreme +/- buffer
 *  {4.0,4.5,5.0} pts, target = external-liquidity level (10-rr-levels.py).
 *  Management grid (Task 4): stop dist {20,25,30} x target dist
 *  {50,100,150,200} x lockTrigger {20,25,30}, lockOffset +2 (on first 1s
 *  touch of entry+trigger the stop ratchets to entry+2 favorable). Plus one
 *  structural variant: min(structural b45 stop dist, 30) / structural target
 *  / lock 25 / offset +2. And lockOffset-0 robustness on the primary
 *  stop25/tgt100 column via a small extra set {25,50/100/150/200,25,off0}.
 *
 *  Within-bar priority (conservative): current stop -> target -> lock
 *  trigger -> post-lock stop recheck on the SAME bar. Stop/lock/flat exits
 *  slip 0.5 pt adverse; target = exact limit. Gross pnl includes slip;
 *  commission (0.2 pt) applied downstream.
 *
 * Exit reasons: S=initial stop, L=locked stop (scratch), T=target, F=16:00 flat.
 * Output: bracket-results.csv (wide; one row per order, 3 cols per scheme).
 *
 * Usage: node research/jv-ict-2026-07/10-rr-bracket-1s-sim.js
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIR = __dirname;
const S1_FILE = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s_continuous.csv');
const SLIP = 0.5;

const UNIVERSES = [
  { id: 'real', file: 'signals-universe.json' },
  { id: 'p1', file: 'signals-placebo-s1.json' },
  { id: 'p2', file: 'signals-placebo-s2.json' },
  { id: 'p3', file: 'signals-placebo-s3.json' },
  { id: 'p4', file: 'signals-placebo-s4.json' },
  { id: 'p5', file: 'signals-placebo-s5.json' },
];

const LEVELS = JSON.parse(fs.readFileSync(path.join(DIR, 'rr-levels.json'), 'utf8'));

// ---------------- scheme catalog ----------------
// Structural brackets: absolute levels from rr-levels.json.
// Management grid: distances from entry.
const SCHEMES = [];
for (const b of [40, 45, 50]) SCHEMES.push({ id: `sb${b}`, kind: 'structural', buf: b });
for (const s of [20, 25, 30])
  for (const t of [50, 100, 150, 200])
    for (const L of [20, 25, 30])
      SCHEMES.push({ id: `g${s}_${t}_${L}`, kind: 'grid', stop: s, tgt: t, lock: L, lockOff: 2 });
// lockOffset 0 robustness (stop 25, lock 25 row)
for (const t of [50, 100, 150, 200])
  SCHEMES.push({ id: `z25_${t}_25`, kind: 'grid', stop: 25, tgt: t, lock: 25, lockOff: 0 });
// structural mgmt variant: min(b45 stop dist, 30), structural target, lock 25 (+2)
SCHEMES.push({ id: 'ms', kind: 'mstruct', lock: 25, lockOff: 2 });
console.log(`${SCHEMES.length} schemes per fill`);

// ---------------- ET helpers (as 08 sim) ----------------
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});
function etParts(ms) {
  const p = {};
  for (const { type, value } of etFmt.formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
function cutoff1600(y, mo, d) {
  let guess = Date.UTC(y, mo - 1, d, 20, 0, 0);
  const h = etParts(guess).h;
  if (h === 15) guess += 3600000;
  else if (h === 17) guess -= 3600000;
  return guess;
}

// ---------------- load universes -> orders ----------------
const orders = [];
for (const u of UNIVERSES) {
  const data = JSON.parse(fs.readFileSync(path.join(DIR, u.file), 'utf8'));
  const lv = LEVELS[u.id];
  for (const s of data.signals) {
    const jc = s.metadata.jv_cancel;
    const et = etParts(s.ts);
    let { y, mo, d } = et;
    if (et.h >= 18) {
      const nd = new Date(Date.UTC(y, mo - 1, d) + 86400000);
      y = nd.getUTCFullYear(); mo = nd.getUTCMonth() + 1; d = nd.getUTCDate();
    }
    const L = lv[String(s.ts)];
    if (!L) throw new Error(`no levels for ${u.id} ${s.ts}`);
    orders.push({
      universe: u.id, ts: s.ts, side: s.side, isBuy: s.side === 'buy',
      limit: s.entryPrice,
      extreme: jc.extreme, legTerminus: jc.legTerminus, ttlMs: jc.ttlMs,
      dir: jc.dir,
      cutoff: cutoff1600(y, mo, d),
      tradingDay: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      levels: L,
      status: 'pending', cancelReason: '', fillTs: null,
      schemes: null, live: 0,
    });
  }
}
orders.sort((a, b) => a.ts - b.ts);
console.log(`Loaded ${orders.length} orders`);

let postCutoff = 0;
for (const o of orders) {
  if (o.ts >= o.cutoff) { o.status = 'cancelled'; o.cancelReason = 'post_cutoff_emission'; postCutoff++; }
}
console.log(`post_cutoff_emission: ${postCutoff}`);

const maxCutoff = Math.max(...orders.map(o => o.cutoff));
const minTs = Math.min(...orders.map(o => o.ts));

function initSchemes(o) {
  const sgn = o.isBuy ? 1 : -1;
  const L = o.levels;
  const st = [];
  for (const sc of SCHEMES) {
    let stopLvl, tgtLvl, lockTrig = null, lockOff = 0;
    if (sc.kind === 'structural') {
      stopLvl = L[`stop${sc.buf}`]; tgtLvl = L.target;
    } else if (sc.kind === 'grid') {
      stopLvl = o.limit - sgn * sc.stop;
      tgtLvl = o.limit + sgn * sc.tgt;
      lockTrig = o.limit + sgn * sc.lock; lockOff = sc.lockOff;
    } else { // mstruct
      const sd = Math.min(sgn * (o.limit - L.stop45), 30); // structural b45 dist, capped
      stopLvl = o.limit - sgn * sd;
      tgtLvl = L.target;
      lockTrig = o.limit + sgn * sc.lock; lockOff = sc.lockOff;
    }
    st.push({ stop: stopLvl, tgt: tgtLvl, lockTrig, lockOff, locked: false,
              done: false, reason: '', pnl: 0, exitTs: null });
  }
  o.schemes = st;
  o.live = st.length;
}

function exitScheme(o, s, reason, price, ms) {
  s.done = true; s.reason = reason; s.exitTs = ms;
  s.pnl = o.isBuy ? price - o.limit : o.limit - price;
  o.live--;
}

// per-1s-bar scheme evaluation; returns true when all schemes done
function stepSchemes(o, high, low, ms) {
  const buy = o.isBuy;
  for (const s of o.schemes) {
    if (s.done) continue;
    // 1. current stop
    if (buy ? low <= s.stop : high >= s.stop) {
      exitScheme(o, s, s.locked ? 'L' : 'S', buy ? s.stop - SLIP : s.stop + SLIP, ms);
      continue;
    }
    // 2. target (exact limit)
    if (buy ? high >= s.tgt : low <= s.tgt) {
      exitScheme(o, s, 'T', s.tgt, ms);
      continue;
    }
    // 3. lock trigger -> ratchet stop, same-bar recheck (conservative)
    if (s.lockTrig !== null && !s.locked &&
        (buy ? high >= s.lockTrig : low <= s.lockTrig)) {
      s.locked = true;
      s.stop = buy ? o.limit + s.lockOff : o.limit - s.lockOff;
      s.lockTrig = null;
      if (buy ? low <= s.stop : high >= s.stop) {
        exitScheme(o, s, 'L', buy ? s.stop - SLIP : s.stop + SLIP, ms);
      }
    }
  }
  return o.live === 0;
}

function flatten(o, lastClose, lastBarTs) {
  for (const s of o.schemes) {
    if (s.done) continue;
    // market exit at last close, 0.5 slip adverse
    exitScheme(o, s, 'F', o.isBuy ? lastClose - SLIP : lastClose + SLIP, lastBarTs + 1000);
  }
  o.status = 'closed';
}

// ---------------- streaming pass ----------------
const pending = [];
const open = [];
let nextIdx = 0;
while (nextIdx < orders.length && orders[nextIdx].status === 'cancelled') nextIdx++;

let curPeriod = -1, lastClose = null, lastBarTs = null;
let lines = 0; const t0 = Date.now();

function run15mCloseChecks(closeTs, closePrice) {
  for (let i = pending.length - 1; i >= 0; i--) {
    const o = pending[i];
    if (closeTs <= o.ts) continue;
    const isShort = o.dir === 'short';
    let reason = null;
    if (isShort ? closePrice > o.extreme : closePrice < o.extreme) reason = 'close_beyond_sweep_extreme';
    else if (isShort ? closePrice < o.legTerminus : closePrice > o.legTerminus) reason = 'close_beyond_leg_terminus';
    else if (closeTs - o.ts >= o.ttlMs) reason = 'order_ttl_expired';
    if (reason) { o.status = 'cancelled'; o.cancelReason = reason; pending.splice(i, 1); }
  }
}

const rl = readline.createInterface({
  input: fs.createReadStream(S1_FILE, { highWaterMark: 1 << 22 }),
  crlfDelay: Infinity,
});

let headerSkipped = false, done = false;

rl.on('line', (line) => {
  if (done) return;
  if (!headerSkipped) { headerSkipped = true; return; }
  lines++;
  const y = +line.slice(0, 4);
  if (y < 2021) return;
  const ms = Date.UTC(
    y, +line.slice(5, 7) - 1, +line.slice(8, 10),
    +line.slice(11, 13), +line.slice(14, 16), +line.slice(17, 19)
  );
  if (ms > maxCutoff && pending.length === 0 && open.length === 0) {
    done = true; rl.close(); return;
  }
  const nextActivation = nextIdx < orders.length ? orders[nextIdx].ts : Infinity;
  if (pending.length === 0 && open.length === 0 && ms < nextActivation && ms < minTs) return;

  const period = Math.floor(ms / 900000);
  if (period !== curPeriod) {
    if (curPeriod >= 0 && pending.length > 0 && lastClose !== null) {
      run15mCloseChecks((curPeriod + 1) * 900000, lastClose);
    }
    curPeriod = period;
  }

  while (nextIdx < orders.length && orders[nextIdx].ts <= ms) {
    const o = orders[nextIdx++];
    if (o.status === 'pending') pending.push(o);
  }

  if (pending.length === 0 && open.length === 0) return;

  const c1 = line.indexOf(',');
  const c2 = line.indexOf(',', c1 + 1);
  const c3 = line.indexOf(',', c2 + 1);
  const c4 = line.indexOf(',', c3 + 1);
  const c5 = line.indexOf(',', c4 + 1);
  const high = +line.slice(c2 + 1, c3);
  const low = +line.slice(c3 + 1, c4);
  const close = +line.slice(c4 + 1, c5);

  // cutoffs
  for (let i = pending.length - 1; i >= 0; i--) {
    const o = pending[i];
    if (ms >= o.cutoff) {
      o.status = 'cancelled'; o.cancelReason = 'cutoff_1600_unfilled';
      pending.splice(i, 1);
    }
  }
  for (let i = open.length - 1; i >= 0; i--) {
    const o = open[i];
    if (ms >= o.cutoff) { flatten(o, lastClose, lastBarTs); open.splice(i, 1); }
  }

  // fills (fill bar participates in scheme evaluation)
  for (let i = pending.length - 1; i >= 0; i--) {
    const o = pending[i];
    if (o.isBuy ? low <= o.limit : high >= o.limit) {
      o.status = 'open'; o.fillTs = ms;
      initSchemes(o);
      pending.splice(i, 1);
      open.push(o);
    }
  }

  // scheme evaluation
  for (let i = open.length - 1; i >= 0; i--) {
    if (stepSchemes(open[i], high, low, ms)) {
      open[i].status = 'closed';
      open.splice(i, 1);
    }
  }

  lastClose = close;
  lastBarTs = ms;

  if (lines % 20000000 === 0) {
    console.log(`  ...${(lines / 1e6).toFixed(0)}M lines, ${line.slice(0, 19)}, pending=${pending.length} open=${open.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
});

rl.on('close', () => {
  for (const o of open) flatten(o, lastClose, lastBarTs);
  for (const o of pending) { o.status = 'cancelled'; o.cancelReason = 'eof'; }

  const iso = (ms) => ms == null ? '' : new Date(ms).toISOString();
  const schemeCols = SCHEMES.map(s => `${s.id}_r,${s.id}_p,${s.id}_x`).join(',');
  const header = `universe,signal_ts,trading_day,side,limit_price,filled,cancel_reason,fill_ts,target_level,tp_tag,stop45,rr45,rr40,rr50,${schemeCols}`;
  const out = [header];
  let filled = 0;
  for (const o of orders) {
    const isFilled = o.status === 'closed';
    if (isFilled) filled++;
    const L = o.levels;
    const base = [
      o.universe, iso(o.ts), o.tradingDay, o.side, o.limit,
      isFilled, isFilled ? '' : o.cancelReason, iso(o.fillTs),
      L.target, L.tag, L.stop45,
      L.rr45?.toFixed(4) ?? '', L.rr40?.toFixed(4) ?? '', L.rr50?.toFixed(4) ?? '',
    ];
    const sc = isFilled
      ? o.schemes.flatMap(s => [s.reason, s.pnl.toFixed(2), s.exitTs])
      : SCHEMES.flatMap(() => ['', '', '']);
    out.push(base.concat(sc).join(','));
  }
  fs.writeFileSync(path.join(DIR, 'bracket-results.csv'), out.join('\n') + '\n');
  console.log(`\nDone. ${lines.toLocaleString()} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`Orders ${orders.length}, filled ${filled}`);
  console.log('-> bracket-results.csv');
});
