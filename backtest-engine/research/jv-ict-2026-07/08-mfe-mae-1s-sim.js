/**
 * JV-ICT MFE/MAE excursion study — honest 1s simulator.
 *
 * Consumes signal universes captured via the engine's --capture-signals mode
 * (real + seeded placebo universes) and runs ONE chronological streaming pass
 * over the continuous 1s OHLCV file. Every signal is an INDEPENDENT pending
 * limit order (no position gating, overlaps allowed):
 *
 *   - Placement: at the signal's 15m close time (captured `ts`).
 *   - Fill: first 1s bar with ts >= placement where low <= limit (BUY) or
 *     high >= limit (SELL); fill price = exact limit; fill ts = that bar.
 *   - Pre-fill cancels (replicating jv-ict shouldInvalidatePendingOrder,
 *     evaluated at each 15m close AFTER that period's fills):
 *       (a) 15m close beyond sweep extreme
 *       (b) 15m close beyond leg terminus
 *       (c) TTL: closeTs - placedCloseTs >= ttlMs (24 x 15m = 6h)
 *       (d) forced study cutoff: any still-pending order dies at 16:00 ET of
 *           its trading day (replaces the strategy's 15:30 session-end +
 *           day-rollover cancels for this study).
 *   - From fill instant: walk 1s bars strictly forward (never ts < fill_ts),
 *     tracking running MFE/MAE in points with timestamps. NO stop, NO target.
 *   - Forced flat: last 1s close at/before 16:00 ET of the signal's trading
 *     day (trading day = ET date, shifted to next date for ET hour >= 18).
 *     Signals emitted at/after their own cutoff (16:00-17:00 ET tail of the
 *     trading day) are cancelled immediately (`post_cutoff_emission`).
 *
 * Output: per-trade CSVs (real -> mfe-mae-universe.csv, placebo ->
 * mfe-mae-placebo.csv).
 *
 * Usage: node research/jv-ict-2026-07/08-mfe-mae-1s-sim.js
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIR = __dirname;
const S1_FILE = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s_continuous.csv');

// threshold grid for first-crossing timestamps (+X before -Y analysis)
const THRESH = [5, 10, 15, 20, 30, 50];

const UNIVERSES = [
  { id: 'real', file: 'signals-universe.json' },
  { id: 'p1', file: 'signals-placebo-s1.json' },
  { id: 'p2', file: 'signals-placebo-s2.json' },
  { id: 'p3', file: 'signals-placebo-s3.json' },
  { id: 'p4', file: 'signals-placebo-s4.json' },
  { id: 'p5', file: 'signals-placebo-s5.json' },
];

// ---------------- ET helpers ----------------
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});
function etParts(ms) {
  const p = {};
  for (const { type, value } of etFmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: +p.hour % 24, mi: +p.minute,
    dateKey: `${p.year}-${p.month}-${p.day}`,
  };
}
/** UTC ms of 16:00 ET on ET calendar date (y,mo,d). */
function cutoff1600(y, mo, d) {
  let guess = Date.UTC(y, mo - 1, d, 20, 0, 0); // 16:00 EDT
  const h = etParts(guess).h;
  if (h === 15) guess += 3600000;               // EST: 16:00 ET = 21:00 UTC
  else if (h === 17) guess -= 3600000;          // defensive
  return guess;
}

// ---------------- Load universes -> orders ----------------
const orders = [];
for (const u of UNIVERSES) {
  const data = JSON.parse(fs.readFileSync(path.join(DIR, u.file), 'utf8'));
  for (const s of data.signals) {
    const jc = s.metadata.jv_cancel;
    const et = etParts(s.ts);
    // trading day: ET date, next calendar date when ET hour >= 18
    let { y, mo, d } = et;
    if (et.h >= 18) {
      const nd = new Date(Date.UTC(y, mo - 1, d) + 86400000);
      y = nd.getUTCFullYear(); mo = nd.getUTCMonth() + 1; d = nd.getUTCDate();
    }
    const cutoff = cutoff1600(y, mo, d);
    const m = s.metadata;
    orders.push({
      universe: u.id,
      ts: s.ts,                       // placement = 15m close ms
      side: s.side,                   // 'buy' | 'sell'
      isBuy: s.side === 'buy',
      limit: s.entryPrice,
      extreme: jc.extreme,
      legTerminus: jc.legTerminus,
      ttlMs: jc.ttlMs,
      dir: jc.dir,                    // 'long' | 'short'
      cutoff,
      tradingDay: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      signalHourEt: et.h,
      // report metadata (real universe; placebo has synthesized subset)
      sweptLevel: m.swept_level ?? '',
      sweptLevelType: m.swept_level_type ?? '',
      mssTs: m.mss_close_ts ?? '',
      model: m.model ?? '',
      stopDistance: m.stop_distance ?? '',
      imbConfluence: m.imb_overlaps ? (m.imb_overlaps.length > 0) : '',
      obConfluence: m.ob_zone ? !!m.ob_zone.overlaps : '',
      stopLoss: s.stopLoss, takeProfit: s.takeProfit,
      // state
      status: 'pending', cancelReason: '',
      fillTs: null, mfe: 0, mae: 0, mfeTs: null, maeTs: null,
      exitTs: null, exitClose: null,
    });
  }
}
orders.sort((a, b) => a.ts - b.ts);
console.log(`Loaded ${orders.length} orders across ${UNIVERSES.length} universes`);

// Immediate cancel: emitted at/after its own cutoff (16:00-17:00 ET tail)
let postCutoff = 0;
for (const o of orders) {
  if (o.ts >= o.cutoff) { o.status = 'cancelled'; o.cancelReason = 'post_cutoff_emission'; postCutoff++; }
}
console.log(`post_cutoff_emission immediate cancels: ${postCutoff}`);

const maxCutoff = Math.max(...orders.map(o => o.cutoff));
const minTs = Math.min(...orders.map(o => o.ts));

// ---------------- Streaming 1s pass ----------------
const pending = [];   // active pending orders
const open = [];      // open trades
let nextIdx = 0;      // next order to activate
while (nextIdx < orders.length && orders[nextIdx].status === 'cancelled') nextIdx++;

let curPeriod = -1;   // floor(ts/900000) 15m period id
let lastClose = null; // last 1s close seen
let lastBarTs = null;
let lines = 0, t0 = Date.now();

function run15mCloseChecks(closeTs, closePrice) {
  for (let i = pending.length - 1; i >= 0; i--) {
    const o = pending[i];
    if (closeTs <= o.ts) continue; // first check at the NEXT 15m close after placement
    const isShort = o.dir === 'short';
    let reason = null;
    if (isShort ? closePrice > o.extreme : closePrice < o.extreme) reason = 'close_beyond_sweep_extreme';
    else if (isShort ? closePrice < o.legTerminus : closePrice > o.legTerminus) reason = 'close_beyond_leg_terminus';
    else if (closeTs - o.ts >= o.ttlMs) reason = 'order_ttl_expired';
    if (reason) {
      o.status = 'cancelled'; o.cancelReason = reason;
      pending.splice(i, 1);
    }
  }
}

function closeTradeAtCutoff(o) {
  // exit at last 1s close at/before cutoff (lastClose as of first bar >= cutoff)
  o.status = 'closed';
  o.exitTs = lastBarTs + 1000; // close instant of last bar before cutoff
  o.exitClose = lastClose;
}

const rl = readline.createInterface({
  input: fs.createReadStream(S1_FILE, { highWaterMark: 1 << 22 }),
  crlfDelay: Infinity,
});

let headerSkipped = false;
let done = false;

rl.on('line', (line) => {
  if (done) return;
  if (!headerSkipped) { headerSkipped = true; return; }
  lines++;
  // ts: "2021-01-17 23:00:00+00:00"
  const y = +line.slice(0, 4);
  if (y < 2021) return;
  const ms = Date.UTC(
    y, +line.slice(5, 7) - 1, +line.slice(8, 10),
    +line.slice(11, 13), +line.slice(14, 16), +line.slice(17, 19)
  );
  if (ms > maxCutoff && pending.length === 0 && open.length === 0) {
    done = true; rl.close(); return;
  }
  // fast skip: nothing active and nothing activates at/before this bar
  const nextActivation = nextIdx < orders.length ? orders[nextIdx].ts : Infinity;
  if (pending.length === 0 && open.length === 0 && ms < nextActivation && ms < minTs) return;

  // 15m boundary crossing -> run cancel checks for the just-closed period
  const period = Math.floor(ms / 900000);
  if (period !== curPeriod) {
    if (curPeriod >= 0 && pending.length > 0 && lastClose !== null) {
      run15mCloseChecks((curPeriod + 1) * 900000, lastClose);
    }
    curPeriod = period;
  }

  // activate orders whose placement ts has arrived
  while (nextIdx < orders.length && orders[nextIdx].ts <= ms) {
    const o = orders[nextIdx++];
    if (o.status === 'pending') pending.push(o);
  }

  // idle fast-path: nothing active -> skip OHLC parse (lastClose/lastBarTs kept
  // stale; they are only consumed while pending/open are non-empty, and any
  // activation bar is fully parsed before they are next read)
  if (pending.length === 0 && open.length === 0) return;

  const c1 = line.indexOf(',');
  const c2 = line.indexOf(',', c1 + 1);
  const c3 = line.indexOf(',', c2 + 1);
  const c4 = line.indexOf(',', c3 + 1);
  const c5 = line.indexOf(',', c4 + 1);
  const high = +line.slice(c2 + 1, c3);
  const low = +line.slice(c3 + 1, c4);
  const close = +line.slice(c4 + 1, c5);

  // cutoff: cancel pending / flat open trades whose cutoff has arrived
  for (let i = pending.length - 1; i >= 0; i--) {
    const o = pending[i];
    if (ms >= o.cutoff) {
      o.status = 'cancelled'; o.cancelReason = 'cutoff_1600_unfilled';
      pending.splice(i, 1);
    }
  }
  for (let i = open.length - 1; i >= 0; i--) {
    const o = open[i];
    if (ms >= o.cutoff) {
      closeTradeAtCutoff(o);
      open.splice(i, 1);
    }
  }

  // fills
  for (let i = pending.length - 1; i >= 0; i--) {
    const o = pending[i];
    if (o.isBuy ? low <= o.limit : high >= o.limit) {
      o.status = 'open'; o.fillTs = ms;
      o.mfe = 0; o.mae = 0; o.mfeTs = ms; o.maeTs = ms;
      o.tFav = [null, null, null, null, null, null]; // first cross of +5/10/15/20/30/50
      o.tAdv = [null, null, null, null, null, null]; // first cross of -5/10/15/20/30/50
      pending.splice(i, 1);
      open.push(o);
      // excursion tracking includes the fill bar (starts at the fill instant)
    }
  }

  // excursions
  for (const o of open) {
    const fav = o.isBuy ? high - o.limit : o.limit - low;
    const adv = o.isBuy ? o.limit - low : high - o.limit;
    if (fav > o.mfe) {
      o.mfe = fav; o.mfeTs = ms;
      for (let k = 0; k < 6; k++) if (o.tFav[k] === null && fav >= THRESH[k]) o.tFav[k] = ms;
    }
    if (adv > o.mae) {
      o.mae = adv; o.maeTs = ms;
      for (let k = 0; k < 6; k++) if (o.tAdv[k] === null && adv >= THRESH[k]) o.tAdv[k] = ms;
    }
  }

  lastClose = close;
  lastBarTs = ms;

  if (lines % 20000000 === 0) {
    console.log(`  ...${(lines / 1e6).toFixed(0)}M lines, ${line.slice(0, 19)}, pending=${pending.length} open=${open.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
});

rl.on('close', () => {
  // finalize: anything still open/pending at EOF (shouldn't happen)
  for (const o of open) closeTradeAtCutoff(o);
  for (const o of pending) { o.status = 'cancelled'; o.cancelReason = 'eof'; }

  const iso = (ms) => ms == null ? '' : new Date(ms).toISOString();
  const rows = { real: [], placebo: [] };
  const threshCols = THRESH.map(t => `s_to_fav_${t}`).concat(THRESH.map(t => `s_to_adv_${t}`)).join(',');
  const header = 'universe,signal_ts,trading_day,side,limit_price,filled,cancel_reason,fill_ts,mfe_pts,mfe_ts,mae_pts,mae_ts,close_1600_pnl_pts,minutes_held,mfe_before_mae,year,entry_hour_et,signal_hour_et,sweep_level,swept_level_type,mss_ts,model,stop_distance,imb_confluence,ob_confluence,stop_loss,take_profit,' + threshCols;
  rows.real.push(header); rows.placebo.push(header);

  let filled = 0, cancelled = 0;
  for (const o of orders) {
    const isFilled = o.status === 'closed';
    if (isFilled) filled++; else cancelled++;
    let pnl = '', held = '', mfeBefore = '', entryHour = o.signalHourEt;
    if (isFilled) {
      pnl = ((o.isBuy ? o.exitClose - o.limit : o.limit - o.exitClose)).toFixed(2);
      held = ((o.exitTs - o.fillTs) / 60000).toFixed(2);
      mfeBefore = (o.mae === 0) ? true : (o.mfe === 0 ? false : o.mfeTs <= o.maeTs);
      entryHour = etParts(o.fillTs).h;
    }
    const row = [
      o.universe, iso(o.ts), o.tradingDay, o.side, o.limit,
      isFilled, isFilled ? '' : o.cancelReason, iso(o.fillTs),
      isFilled ? o.mfe.toFixed(2) : '', isFilled ? iso(o.mfeTs) : '',
      isFilled ? o.mae.toFixed(2) : '', isFilled ? iso(o.maeTs) : '',
      pnl, held, mfeBefore, o.tradingDay.slice(0, 4), entryHour, o.signalHourEt,
      o.sweptLevel, o.sweptLevelType, o.mssTs, o.model, o.stopDistance,
      o.imbConfluence, o.obConfluence, o.stopLoss, o.takeProfit,
      ...(isFilled
        ? o.tFav.map(t => t === null ? '' : (t - o.fillTs) / 1000)
            .concat(o.tAdv.map(t => t === null ? '' : (t - o.fillTs) / 1000))
        : new Array(12).fill('')),
    ].join(',');
    (o.universe === 'real' ? rows.real : rows.placebo).push(row);
  }

  fs.writeFileSync(path.join(DIR, 'mfe-mae-universe.csv'), rows.real.join('\n') + '\n');
  fs.writeFileSync(path.join(DIR, 'mfe-mae-placebo.csv'), rows.placebo.join('\n') + '\n');
  console.log(`\nDone. ${lines.toLocaleString()} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`Orders: ${orders.length}, filled ${filled}, unfilled ${cancelled}`);
  console.log(`real -> mfe-mae-universe.csv (${rows.real.length - 1} rows)`);
  console.log(`placebo -> mfe-mae-placebo.csv (${rows.placebo.length - 1} rows)`);
});
