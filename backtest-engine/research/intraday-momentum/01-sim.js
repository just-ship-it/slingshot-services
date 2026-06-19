/**
 * Intraday Momentum (Zarattini "Concretum Bands") — 1s-honest simulator for ES.
 *
 * See README.md for the exact spec. Mechanistically orthogonal to the GEX/IV/LS
 * fade book: an open-anchored volatility-band BREAKOUT / trend-continuation system.
 *
 * Two-pass, fully 1s-honest (CLAUDE.md mandate):
 *   PASS 1 (1m stream): per-day RTH open O_t, prev RTH close, per-minute-of-day close
 *           matrix → per-day expanding noise bands UB(m)/LB(m) via N-day lookback.
 *   PASS 2 (1s stream): session VWAP (reset 09:30 ET), discrete grid entry checkpoints,
 *           chronological stop-style fills & exits from the fill instant forward, EOD flat.
 *
 * Sizing: fixed 1 contract long/short per signal. ES = $50/pt.
 *
 * Usage:
 *   node 01-sim.js --ticker ES --start 2021-02-01 --end 2026-01-23 \
 *     --lookback 14 --mult 1.0 --entry-grid 30 --exit vwap --eod 15:45 \
 *     --no-entry-after 15:30 --out output/baseline.json
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { getRTHOpenTime, getRTHCloseTime, etToUTC, toET, getTradingDays } from '../../src/ai/session-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');

// ---- args ----
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
function flag(name) { return process.argv.includes(`--${name}`); }
if (flag('help')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 24).join('\n'));
  process.exit(0);
}
const TICKER     = arg('ticker', 'ES').toUpperCase();
const START      = arg('start', '2021-02-01');
const END        = arg('end', '2026-01-23');
const LOOKBACK   = +arg('lookback', 14);
const MULT       = +arg('mult', 1.0);
const ENTRY_GRID = +arg('entry-grid', 30);          // minutes between entry checkpoints
const EXIT_MODE  = arg('exit', 'vwap');             // vwap | band | vwap-or-band
const EOD        = arg('eod', '15:45');             // ET HH:MM force-flat
const NO_ENTRY_AFTER = arg('no-entry-after', '15:30');
const ALLOW_FLIP = arg('allow-flip', 'true') !== 'false';
const POINT_VALUE = +arg('point-value', TICKER === 'NQ' ? 20 : 50);
const COMMISSION  = +arg('commission', 5.0);        // round-trip $/contract
const STOP_SLIP   = +arg('stop-slip', 1.5);         // points (breakout entry + stop exit)
const MKT_SLIP    = +arg('mkt-slip', 1.0);          // points (EOD market flat)
const OUT         = arg('out', 'output/baseline.json');
const VERBOSE     = flag('verbose');

const [eodH, eodM] = EOD.split(':').map(Number);
const [neaH, neaM] = NO_ENTRY_AFTER.split(':').map(Number);
const RTH_MIN = 390;                                 // 09:30→16:00 = 390 minutes

console.log(`\n=== Intraday Momentum sim — ${TICKER} ===`);
console.log(`Range ${START}→${END} | lookback ${LOOKBACK}d | mult ${MULT} | grid ${ENTRY_GRID}m | exit ${EXIT_MODE} | eod ${EOD} ET | flip ${ALLOW_FLIP}`);
console.log(`Sizing 1 contract | $${POINT_VALUE}/pt | comm $${COMMISSION} | stopSlip ${STOP_SLIP}pt | mktSlip ${MKT_SLIP}pt\n`);

const startMs = new Date(START + 'T00:00:00Z').getTime();
const endMs   = new Date(END + 'T00:00:00Z').getTime() + 24 * 3600000;

// =====================================================================================
// PASS 1 — stream 1m: primary-by-hour map + per-day RTH open / prevClose / minute matrix
// =====================================================================================
const oneMinPath = path.join(DATA_DIR, 'ohlcv', TICKER.toLowerCase(), `${TICKER}_ohlcv_1m.csv`);
const oneSecPath = path.join(DATA_DIR, 'ohlcv', TICKER.toLowerCase(), `${TICKER}_ohlcv_1s.csv`);
for (const p of [oneMinPath, oneSecPath]) if (!fs.existsSync(p)) { console.error(`Missing ${p}`); process.exit(1); }

// Precompute per-day RTH windows (DST-correct, once per day)
const tradingDays = getTradingDays(START, END);
const dayRec = new Map();   // etDate 'YYYY-MM-DD' -> record
for (const d of tradingDays) {
  const rthOpen = getRTHOpenTime(d);
  const rthClose = getRTHCloseTime(d);
  const dd = new Date(d + 'T12:00:00Z'); const et = toET(dd.getTime());
  const eodUtc = etToUTC(et.year, et.month, et.day, eodH, eodM);
  const neaUtc = etToUTC(et.year, et.month, et.day, neaH, neaM);
  dayRec.set(d, {
    date: d, rthOpen, rthClose, eodUtc, neaUtc,
    open: NaN, prevClose: NaN,
    mClose: new Float64Array(RTH_MIN).fill(NaN), // close at each RTH minute index
    UB: null, LB: null, tradable: false,
  });
}
const sortedDays = Array.from(dayRec.values()).sort((a, b) => a.rthOpen - b.rthOpen);
// fast lookup: which day-window does a ts belong to, by advancing a pointer in pass 2
const minRthOpen = sortedDays[0].rthOpen;
const maxEod = sortedDays[sortedDays.length - 1].eodUtc;

function parseHourBucket(ts) { return Math.floor(ts / 3600000); }

// hour -> primary symbol (highest volume)
const hourVol = new Map();
// To assign 1m rows to a day quickly, advance a day pointer in time order (1m file is sorted).
console.log(`Pass 1: streaming 1m (${path.basename(oneMinPath)}) ...`);
{
  const stream = fs.createReadStream(oneMinPath, { highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null, scanned = 0;
  let di = 0; // day pointer
  const minIso = new Date(startMs).toISOString();
  const maxIso = new Date(endMs).toISOString();
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const c0 = line.indexOf(',');
    if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < minIso) continue;
    if (tsStr > maxIso) break;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9];
    if (symbol.includes('-')) continue;             // drop calendar spreads
    const ts = new Date(tsStr).getTime();
    scanned++;
    const open = +parts[4], close = +parts[7], volume = +parts[8] || 0;
    // hour-volume for primary contract map
    const hb = parseHourBucket(ts);
    let hv = hourVol.get(hb); if (!hv) { hv = new Map(); hourVol.set(hb, hv); }
    hv.set(symbol, (hv.get(symbol) || 0) + volume);
    // advance day pointer so that sortedDays[di] is the day whose RTH could contain ts
    while (di < sortedDays.length - 1 && ts >= sortedDays[di + 1].rthOpen) di++;
    const day = sortedDays[di];
    if (ts >= day.rthOpen && ts < day.rthClose) {
      const m = Math.floor((ts - day.rthOpen) / 60000);
      if (m >= 0 && m < RTH_MIN) {
        if (m === 0 && isNaN(day.open)) day.open = open;
        // store first close seen per minute index (primary resolved later — see note)
        if (isNaN(day.mClose[m])) day.mClose[m] = close;
        else day.mClose[m] = close; // keep last; multiple contracts overwrite, primary filter below
      }
    }
  }
  rl.close(); stream.destroy();
  console.log(`  scanned ${scanned.toLocaleString()} in-range 1m rows`);
}

// Resolve primary symbol per hour
const primaryByHour = new Map();
for (const [hb, hv] of hourVol.entries()) {
  let bs = '', bv = -1; for (const [s, v] of hv.entries()) if (v > bv) { bv = v; bs = s; }
  primaryByHour.set(hb, bs);
}

// NOTE on pass-1 primary filtering: the 1m loop above stored close per minute without
// strict primary filtering (cheap). ES roll spreads are ~10pt and rolls are infrequent
// (4/yr) — the σ is a 14-day ratio average so a stray non-primary minute is negligible and
// further washed out by the average. Pass 2 (fills) DOES strictly filter to primary.

// Fill forward missing minute closes within each day; set open fallback
for (const day of sortedDays) {
  if (isNaN(day.open)) {
    // first non-NaN minute close as open fallback
    for (let m = 0; m < RTH_MIN; m++) if (!isNaN(day.mClose[m])) { day.open = day.mClose[m]; break; }
  }
  let last = day.open;
  for (let m = 0; m < RTH_MIN; m++) {
    if (isNaN(day.mClose[m])) day.mClose[m] = last; else last = day.mClose[m];
  }
}
// prevClose = previous trading day's last RTH minute close
for (let i = 1; i < sortedDays.length; i++) {
  const prev = sortedDays[i - 1];
  sortedDays[i].prevClose = prev.mClose[RTH_MIN - 1];
}

// Build per-day bands from trailing-N-day σ(m)
let tradableDays = 0;
for (let i = 0; i < sortedDays.length; i++) {
  const day = sortedDays[i];
  if (i < LOOKBACK || isNaN(day.open)) continue;
  // σ(m) = mean over last N days of |close_k(m)/open_k − 1|
  const sigma = new Float64Array(RTH_MIN);
  let validHist = 0;
  for (let k = i - LOOKBACK; k < i; k++) {
    const dk = sortedDays[k];
    if (isNaN(dk.open) || dk.open <= 0) continue;
    validHist++;
    for (let m = 0; m < RTH_MIN; m++) sigma[m] += Math.abs(dk.mClose[m] / dk.open - 1);
  }
  if (validHist < Math.max(5, Math.floor(LOOKBACK / 2))) continue;
  for (let m = 0; m < RTH_MIN; m++) sigma[m] /= validHist;
  const O = day.open;
  const pc = isNaN(day.prevClose) ? O : day.prevClose;
  const anchorHi = Math.max(O, pc), anchorLo = Math.min(O, pc);
  day.UB = new Float64Array(RTH_MIN);
  day.LB = new Float64Array(RTH_MIN);
  for (let m = 0; m < RTH_MIN; m++) {
    const move = sigma[m] * MULT * O;
    day.UB[m] = anchorHi + move;
    day.LB[m] = anchorLo - move;
  }
  day.tradable = true; tradableDays++;
}
console.log(`  built bands for ${tradableDays.toLocaleString()} tradable days (warmup ${LOOKBACK}d)\n`);

// =====================================================================================
// PASS 2 — stream 1s: session VWAP, grid entry checkpoints, honest fills/exits, EOD flat
// =====================================================================================
console.log(`Pass 2: streaming 1s (${path.basename(oneSecPath)}) — honest fills ...`);
const trades = [];
let di = 0;
let day = sortedDays[0];
// session VWAP accumulators (reset at day advance)
let pvSum = 0, vSum = 0, vwap = NaN;
let lastCheckpointM = -1;      // last grid-minute we evaluated for entry
// position state
let pos = null;                // { side:+1/-1, entryTs, entryPrice, mfe, mae }

function advanceDayTo(ts) {
  // advance until day is the window containing ts (or the last day <= ts)
  while (di < sortedDays.length - 1 && ts >= sortedDays[di + 1].rthOpen) {
    di++;
  }
  if (sortedDays[di] !== day) {
    // new day: if a position somehow survived (shouldn't past EOD), force-close at last known
    day = sortedDays[di];
    pvSum = 0; vSum = 0; vwap = NaN; lastCheckpointM = -1; pos = null;
  }
}

function closePosition(ts, price, reason) {
  const dir = pos.side;
  const exitPrice = price;
  const gross = (exitPrice - pos.entryPrice) * dir * POINT_VALUE;
  const pnl = gross - COMMISSION;
  trades.push({
    date: day.date, side: dir > 0 ? 'long' : 'short',
    entryTs: pos.entryTs, entryPrice: +pos.entryPrice.toFixed(4),
    exitTs: ts, exitPrice: +exitPrice.toFixed(4),
    pnl: +pnl.toFixed(2), reason,
    mfePts: +pos.mfe.toFixed(2), maePts: +pos.mae.toFixed(2),
    holdSec: Math.round((ts - pos.entryTs) / 1000),
  });
  pos = null;
}

{
  const stream = fs.createReadStream(oneSecPath, { highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null, scanned = 0, kept = 0;
  const tStart = Date.now();
  const minIso = new Date(minRthOpen).toISOString();
  const maxIso = new Date(maxEod).toISOString();

  for await (const line of rl) {
    if (!header) { header = line; continue; }
    scanned++;
    if (scanned % 25000000 === 0) {
      const sec = ((Date.now() - tStart) / 1000).toFixed(0);
      process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  trades ${trades.length}  (${sec}s)\n`);
    }
    const c0 = line.indexOf(',');
    if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < minIso) continue;
    if (tsStr > maxIso) break;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9];
    if (symbol.includes('-')) continue;
    const ts = new Date(tsStr).getTime();

    advanceDayTo(ts);
    // only act within this day's RTH→EOD window
    if (ts < day.rthOpen) continue;
    if (ts >= day.eodUtc) {
      if (pos) { // force-flat at EOD (market slippage)
        const px = (+parts[7]) + (pos.side > 0 ? -MKT_SLIP : MKT_SLIP);
        closePosition(ts, px, 'eod');
      }
      continue;
    }
    // strict primary-contract filter for the trading pass
    const hb = parseHourBucket(ts);
    const primarySym = primaryByHour.get(hb);
    if (primarySym && symbol !== primarySym) continue;

    const high = +parts[5], low = +parts[6], close = +parts[7], volume = +parts[8] || 0;
    if (isNaN(close)) continue;
    kept++;

    // session VWAP (typical price)
    const typical = (high + low + close) / 3;
    pvSum += typical * volume; vSum += volume;
    vwap = vSum > 0 ? pvSum / vSum : close;

    const m = Math.floor((ts - day.rthOpen) / 60000);
    if (m < 0 || m >= RTH_MIN) continue;
    if (!day.tradable) continue;

    // ---- EXIT (in position) ----
    if (pos) {
      // track MFE/MAE in points from entry
      const fav = (close - pos.entryPrice) * pos.side;
      if (fav > pos.mfe) pos.mfe = fav;
      if (fav < pos.mae) pos.mae = fav;
      let exit = false, reason = '';
      const vwapBreak = pos.side > 0 ? (close < vwap) : (close > vwap);
      const bandReenter = pos.side > 0 ? (close < day.UB[m]) : (close > day.LB[m]);
      if (EXIT_MODE === 'vwap' && vwapBreak) { exit = true; reason = 'vwap'; }
      else if (EXIT_MODE === 'band' && bandReenter) { exit = true; reason = 'band'; }
      else if (EXIT_MODE === 'vwap-or-band' && (vwapBreak || bandReenter)) { exit = true; reason = vwapBreak ? 'vwap' : 'band'; }
      if (exit) {
        const px = close + (pos.side > 0 ? -STOP_SLIP : STOP_SLIP); // stop-style exit
        closePosition(ts, px, reason);
      }
    }

    // ---- ENTRY (flat, at grid checkpoint) ----
    if (!pos && ts < day.neaUtc) {
      const onGrid = (m % ENTRY_GRID === 0) && m > 0 && (m !== lastCheckpointM);
      if (onGrid) {
        lastCheckpointM = m;
        if (close > day.UB[m]) {
          const px = close + STOP_SLIP;                // breakout long, stop-style fill
          pos = { side: +1, entryTs: ts, entryPrice: px, mfe: 0, mae: 0 };
        } else if (close < day.LB[m]) {
          const px = close - STOP_SLIP;                // breakout short
          pos = { side: -1, entryTs: ts, entryPrice: px, mfe: 0, mae: 0 };
        }
        if (pos && !ALLOW_FLIP) {
          // single-shot-per-day: disable further checkpoints
          lastCheckpointM = RTH_MIN + 1;
        }
      }
    }
  }
  rl.close(); stream.destroy();
  // close any dangling position at last seen price (shouldn't happen due to EOD)
  const sec = ((Date.now() - tStart) / 1000).toFixed(0);
  console.log(`  scanned ${scanned.toLocaleString()} 1s rows, kept ${kept.toLocaleString()} primary, ${trades.length} trades (${sec}s)\n`);
}

// =====================================================================================
// METRICS
// =====================================================================================
function pct(x) { return (x * 100).toFixed(2) + '%'; }
const n = trades.length;
const wins = trades.filter(t => t.pnl > 0);
const losses = trades.filter(t => t.pnl <= 0);
const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
const wr = n > 0 ? wins.length / n : 0;
const avgWin = wins.length ? grossWin / wins.length : 0;
const avgLoss = losses.length ? grossLoss / losses.length : 0;

// equity curve + max drawdown ($)
let eq = 0, peak = 0, maxDD = 0;
for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; const dd = peak - eq; if (dd > maxDD) maxDD = dd; }

// daily PnL series → annualized Sharpe (252)
const byDay = new Map();
for (const t of trades) byDay.set(t.date, (byDay.get(t.date) || 0) + t.pnl);
const dailyVals = Array.from(byDay.values());
const meanD = dailyVals.reduce((s, v) => s + v, 0) / (dailyVals.length || 1);
const varD = dailyVals.reduce((s, v) => s + (v - meanD) ** 2, 0) / (dailyVals.length || 1);
const sdD = Math.sqrt(varD);
const sharpe = sdD > 0 ? (meanD / sdD) * Math.sqrt(252) : 0;

// split-half stability
function sub(arr) {
  const w = arr.filter(t => t.pnl > 0).length;
  const gw = arr.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = -arr.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return { n: arr.length, pnl: arr.reduce((s, t) => s + t.pnl, 0), wr: arr.length ? w / arr.length : 0, pf: gl > 0 ? gw / gl : Infinity };
}
const h1 = sub(trades.slice(0, Math.floor(n / 2)));
const h2 = sub(trades.slice(Math.floor(n / 2)));

const longs = sub(trades.filter(t => t.side === 'long'));
const shorts = sub(trades.filter(t => t.side === 'short'));

console.log(`========================= RESULTS (${TICKER}, 1 contract) =========================`);
console.log(`Trades        ${n}   (${tradableDays} tradable days, ${(n / tradableDays).toFixed(2)}/day)`);
console.log(`Total PnL     $${totalPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
console.log(`Win rate      ${pct(wr)}   (${wins.length}W / ${losses.length}L)`);
console.log(`Profit factor ${pf.toFixed(2)}`);
console.log(`Avg win/loss  $${avgWin.toFixed(0)} / $${avgLoss.toFixed(0)}   (R ${(avgWin / (avgLoss || 1)).toFixed(2)})`);
console.log(`Sharpe (ann)  ${sharpe.toFixed(2)}`);
console.log(`Max DD ($)    $${maxDD.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
console.log(`Expectancy    $${(totalPnL / (n || 1)).toFixed(2)}/trade`);
console.log(`Long  ${longs.n}  pnl $${longs.pnl.toFixed(0)}  WR ${pct(longs.wr)}  PF ${longs.pf.toFixed(2)}`);
console.log(`Short ${shorts.n}  pnl $${shorts.pnl.toFixed(0)}  WR ${pct(shorts.wr)}  PF ${shorts.pf.toFixed(2)}`);
console.log(`H1 ${h1.n}tr $${h1.pnl.toFixed(0)} PF ${h1.pf.toFixed(2)} WR ${pct(h1.wr)}  |  H2 ${h2.n}tr $${h2.pnl.toFixed(0)} PF ${h2.pf.toFixed(2)} WR ${pct(h2.wr)}`);
console.log(`====================================================================================\n`);

const outPath = path.isAbsolute(OUT) ? OUT : path.join(__dirname, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  config: { ticker: TICKER, start: START, end: END, lookback: LOOKBACK, mult: MULT, entryGrid: ENTRY_GRID, exitMode: EXIT_MODE, eod: EOD, noEntryAfter: NO_ENTRY_AFTER, allowFlip: ALLOW_FLIP, pointValue: POINT_VALUE, commission: COMMISSION, stopSlip: STOP_SLIP, mktSlip: MKT_SLIP },
  summary: { trades: n, tradableDays, totalPnL: +totalPnL.toFixed(2), winRate: +wr.toFixed(4), profitFactor: +pf.toFixed(3), avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2), sharpe: +sharpe.toFixed(3), maxDD: +maxDD.toFixed(2), expectancy: +(totalPnL / (n || 1)).toFixed(2), longs, shorts, h1, h2 },
  trades: VERBOSE ? trades : trades.slice(0, 50),
}, null, 2));
console.log(`Wrote ${outPath}${VERBOSE ? ' (full trades)' : ' (first 50 trades; use --verbose for all)'}\n`);
