/**
 * Test 3 (2026-07-23): JV live-management layer — scale-in + TP1/2/3 ladder.
 * Source: 6/19/24 video (TP1/TP2/TP3 at hourly lows), 7/10/26 journal ("I
 * always scaled in", "stopped break even"), Drew sizing directive: total
 * position 10 MNQ = 1 NQ; initial 5 MNQ + one 5 MNQ scale-in.
 *
 * Kernel: identical order lifecycle to 10-rr-bracket-1s-sim.js (placement at
 * 15m close, exact-limit fills on first touching 1s bar, engine-honest
 * pre-fill cancels on e1, forced flat 16:00 ET, stop/flat slip 0.5, targets
 * exact). Evaluated per 1s bar from fill instant. All 6 universes.
 *
 * PRE-REGISTERED SPEC (before running):
 *  e1 = signal limit, 5 MNQ (arms B/C) or 10 MNQ (arms A/D).
 *  e2 (arms B/C) = midpoint of e1 and structural stop45, 5 MNQ; active only
 *     while position open; cancelled on TP1 touch, stop, or flat.
 *  stop = structural stop45 (both tranches).
 *  TP ladder sorted by distance: near = min-dist of {leg terminus (signal
 *     takeProfit), external target (rr-levels)}, far = the other. Runner: EOD.
 *  Exit sizes: 10-lot -> 4 @TP1, 3 @TP2, 3 runner; 5-lot -> 2/2/1.
 *     Sizing snapshot at each TP touch; scale-in after TP1 impossible (e2
 *     cancelled at TP1).
 *  BE (arms A/B): on TP1 fill, stop for remainder -> avg entry price of
 *     filled tranches (cost basis), no offset, same-bar recheck (conservative).
 *  Within-bar priority: stop -> TP fills -> BE ratchet -> same-bar recheck.
 *  Arms: A=base10+BE, B=scale55+BE, C=scale55 noBE, D=base10 noBE.
 *
 * Success criteria (reconciliation question): does arm B on REAL entries
 * produce green-day rate ~>=65% with small median red? AND does the same
 * management on PLACEBO universes produce a materially different profile?
 * If real ~= placebo profile, management manufactures the JV daily-green
 * look on noise (supports hypothesis 1); any real-vs-placebo EV gap is the
 * only edge claim, judged vs the 5-seed placebo spread.
 *
 * Output: scalein-results.csv. Usage: node 13-scalein-1s-sim.js
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

const ARMS = [
  { id: 'A', scale: false, be: true },
  { id: 'B', scale: true, be: true },
  { id: 'C', scale: true, be: false },
  { id: 'D', scale: false, be: false },
];

// ---------------- ET helpers (as 08/10 sims) ----------------
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
const skipped = { geom: 0, tp: 0 };
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
    const sgn = s.side === 'buy' ? 1 : -1;
    const stop = L.stop45;
    const riskDist = sgn * (s.entryPrice - stop);
    if (!(riskDist > 0)) { skipped.geom++; continue; }
    const tpA = s.takeProfit, tpB = L.target;
    const dA = sgn * (tpA - s.entryPrice), dB = sgn * (tpB - s.entryPrice);
    // ladder sorted by distance; both must be favorable (guard: degenerate -> skip)
    if (!(dA > 0) || !(dB > 0)) { skipped.tp++; continue; }
    const [tp1, tp2] = dA <= dB ? [tpA, tpB] : [tpB, tpA];
    orders.push({
      universe: u.id, ts: s.ts, side: s.side, isBuy: s.side === 'buy',
      limit: s.entryPrice,
      e2limit: s.entryPrice - sgn * riskDist * 0.5,
      stop, tp1, tp2,
      extreme: jc.extreme, legTerminus: jc.legTerminus, ttlMs: jc.ttlMs,
      dir: jc.dir,
      cutoff: cutoff1600(y, mo, d),
      tradingDay: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      status: 'pending', cancelReason: '', fillTs: null,
      arms: null, live: 0,
    });
  }
}
orders.sort((a, b) => a.ts - b.ts);
console.log(`Loaded ${orders.length} orders (skipped: degenerate-stop=${skipped.geom}, degenerate-tp=${skipped.tp})`);

let postCutoff = 0;
for (const o of orders) {
  if (o.ts >= o.cutoff) { o.status = 'cancelled'; o.cancelReason = 'post_cutoff_emission'; postCutoff++; }
}
console.log(`post_cutoff_emission: ${postCutoff}`);

const maxCutoff = Math.max(...orders.map(o => o.cutoff));
const minTs = Math.min(...orders.map(o => o.ts));

function initArms(o, fillMs) {
  o.arms = ARMS.map(a => ({
    id: a.id, be: a.be,
    // entry legs: [size, price]; e1 fills now
    cash: -(a.scale ? 5 : 10) * o.limit * (o.isBuy ? 1 : -1), // signed cost basis cash
    size: a.scale ? 5 : 10,
    entered: a.scale ? 5 : 10,
    entryCost: (a.scale ? 5 : 10) * o.limit,
    e2: a.scale ? { limit: o.e2limit, size: 5, active: true } : null,
    stop: o.stop, tp1Done: false, tp2Done: false,
    done: false, exits: [], pnl: 0, exitTs: null, e2Filled: false,
  }));
  o.live = o.arms.length;
  o.fillTs = fillMs;
}

function armExit(o, a, size, price, reason, ms) {
  const sgn = o.isBuy ? 1 : -1;
  a.cash += size * price * sgn;
  a.size -= size;
  a.exits.push(`${reason}:${size}@${price.toFixed(2)}`);
  if (a.size === 0) {
    a.done = true;
    a.pnl = a.cash; // signed: for buy = proceeds - cost; for sell mirrored
    a.exitTs = ms;
    if (a.e2) a.e2.active = false;
    o.live--;
  }
}

function ladderSizes(entered) {
  return entered === 10 ? { t1: 4, t2: 3 } : { t1: 2, t2: 2 };
}

// per-1s-bar arm evaluation; returns true when all arms done
function stepArms(o, high, low, ms) {
  const buy = o.isBuy;
  const sgn = buy ? 1 : -1;
  for (const a of o.arms) {
    if (a.done) continue;
    // 0. e2 scale-in fill (before exits; fill bar participates)
    if (a.e2 && a.e2.active && !a.tp1Done &&
        (buy ? low <= a.e2.limit : high >= a.e2.limit)) {
      a.cash -= a.e2.size * a.e2.limit * sgn;
      a.size += a.e2.size;
      a.entered += a.e2.size;
      a.entryCost += a.e2.size * a.e2.limit;
      a.e2.active = false;
      a.e2Filled = true;
      a.exits.push(`E2:${a.e2.size}@${a.e2.limit.toFixed(2)}`);
    }
    // 1. stop (whole remaining position)
    if (buy ? low <= a.stop : high >= a.stop) {
      armExit(o, a, a.size, a.stop - sgn * SLIP, a.beSet ? 'L' : 'S', ms);
      continue;
    }
    // 2. TP1
    if (!a.tp1Done && (buy ? high >= o.tp1 : low <= o.tp1)) {
      a.tp1Done = true;
      if (a.e2) a.e2.active = false; // no adds after first take-profit
      const sz = Math.min(ladderSizes(a.entered).t1, a.size);
      armExit(o, a, sz, o.tp1, 'T1', ms);
      if (a.done) continue;
      if (a.be) {
        // stop -> avg entry (cost basis) of filled tranches
        a.stop = a.entryCost / a.entered;
        a.beSet = true;
        // same-bar conservative recheck
        if (buy ? low <= a.stop : high >= a.stop) {
          armExit(o, a, a.size, a.stop - sgn * SLIP, 'L', ms);
          continue;
        }
      }
    }
    if (a.done) continue;
    // 3. TP2
    if (a.tp1Done && !a.tp2Done && (buy ? high >= o.tp2 : low <= o.tp2)) {
      a.tp2Done = true;
      const sz = Math.min(ladderSizes(a.entered).t2, a.size);
      armExit(o, a, sz, o.tp2, 'T2', ms);
    }
  }
  return o.live === 0;
}

function flatten(o, lastClose, lastBarTs) {
  for (const a of o.arms) {
    if (a.done) continue;
    armExit(o, a, a.size, lastClose - (o.isBuy ? 1 : -1) * SLIP, 'F', lastBarTs + 1000);
  }
  o.status = 'closed';
}

// ---------------- streaming pass (identical to 10 sim) ----------------
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

  for (let i = pending.length - 1; i >= 0; i--) {
    const o = pending[i];
    if (o.isBuy ? low <= o.limit : high >= o.limit) {
      o.status = 'open';
      initArms(o, ms);
      pending.splice(i, 1);
      open.push(o);
    }
  }

  for (let i = open.length - 1; i >= 0; i--) {
    if (stepArms(open[i], high, low, ms)) {
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
  const armCols = ARMS.map(a => `${a.id}_pnl,${a.id}_e2,${a.id}_exits,${a.id}_xts`).join(',');
  const header = `universe,signal_ts,trading_day,side,limit_price,e2_limit,stop45,tp1,tp2,filled,cancel_reason,fill_ts,${armCols}`;
  const out = [header];
  let filled = 0;
  for (const o of orders) {
    const isFilled = o.status === 'closed';
    if (isFilled) filled++;
    const base = [
      o.universe, iso(o.ts), o.tradingDay, o.side, o.limit, o.e2limit.toFixed(2),
      o.stop, o.tp1, o.tp2,
      isFilled, isFilled ? '' : o.cancelReason, iso(o.fillTs),
    ];
    const ac = isFilled
      ? o.arms.flatMap(a => [a.pnl.toFixed(2), a.e2Filled ? 1 : 0, a.exits.join('|'), iso(a.exitTs)])
      : ARMS.flatMap(() => ['', '', '', '']);
    out.push(base.concat(ac).join(','));
  }
  fs.writeFileSync(path.join(DIR, 'scalein-results.csv'), out.join('\n') + '\n');
  console.log(`\nDone. ${lines.toLocaleString()} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`Orders ${orders.length}, filled ${filled}`);
  console.log('-> scalein-results.csv');
});
