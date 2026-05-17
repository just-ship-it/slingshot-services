/**
 * Phase 1 variant: builds touch event dataset with 1s-honest forward walks
 * starting at touch+120s (NOT touch+60s as the original).
 *
 * Includes BOTH current AND stale GEX levels per the user's hypothesis.
 *
 * Output JSON is structured the same as the original gex-touch-flow dataset
 * so all the analysis scripts work on it.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import csv from 'csv-parser';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const DATA_DIR = `${ROOT}/data`;
const OUT_DIR = `${ROOT}/research/output`;

const START = '2025-01-13';
const END = '2026-01-28';
const TOUCH_DISTANCE = 10;
const STALE_MIN_AGE_MIN = 30;
const STALE_MAX_AGE_MIN = 240;
const SNAP_LAG_MIN = 16;
const ENTRY_DELAY_SEC = 120;  // entry at touch_ts + 120s (after post1 minute closes)
const MAX_HOLD_MIN = 30;
const EOD_CUTOFF_ET = '16:40';
const TARGET_PTS = [5, 7, 8, 10, 12, 15, 18, 20, 22, 25];
const STOP_PTS = [3, 4, 5, 6, 7, 8, 10, 12, 15];

console.log(`Building touches+T120 dataset (1s-honest walks from touch+${ENTRY_DELAY_SEC}s)`);
console.log(`Range: ${START} → ${END}, includes stale levels ${STALE_MIN_AGE_MIN}-${STALE_MAX_AGE_MIN}min old\n`);

// Load primary NQ 1m
async function loadPrimaryNQ() {
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(`${DATA_DIR}/ohlcv/nq/NQ_ohlcv_1m.csv`).pipe(csv())
      .on('data', (row) => {
        if (row.symbol?.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts)) return;
        const dateStr = row.ts_event.slice(0, 10);
        if (dateStr < START || dateStr > END) return;
        const c = { timestamp: ts, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume || 0, symbol: row.symbol };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}
function filterPrimary(candles) {
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    hourVol.get(h).set(c.symbol, (hourVol.get(h).get(c.symbol) || 0) + (c.volume || 0));
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let best = '', bestV = -1;
    for (const [s, v] of m.entries()) if (v > bestV) { bestV = v; best = s; }
    primary.set(h, best);
  }
  return { filtered: candles.filter(c => c.symbol === primary.get(Math.floor(c.timestamp / 3600000))), primary };
}

console.log('Loading NQ 1m...');
const allCandles = await loadPrimaryNQ();
const { filtered: candles, primary: primaryByHour } = filterPrimary(allCandles);
console.log(`Primary candles: ${candles.length.toLocaleString()}`);

function toET(ts) {
  const d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hours: d.getHours(), minutes: d.getMinutes(), date: d.toISOString().slice(0, 10), dow: d.getDay() };
}

const byDate = new Map();
for (const c of candles) {
  const et = toET(c.timestamp);
  if (et.dow < 1 || et.dow > 5) continue;
  if (!byDate.has(et.date)) byDate.set(et.date, []);
  byDate.get(et.date).push({ candle: c, et });
}
const dates = [...byDate.keys()].sort();
console.log(`Trading dates: ${dates.length}`);

// GEX loaders
function loadGex(dateStr) {
  const p = `${DATA_DIR}/gex/nq-cbbo/nq_gex_${dateStr}.json`;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')).data || [];
}
function extractLevels(snap) {
  const out = [];
  if (snap.call_wall != null) out.push({ type: 'call_wall', price: snap.call_wall, gex: snap.call_wall_gex || 0 });
  if (snap.put_wall != null) out.push({ type: 'put_wall', price: snap.put_wall, gex: snap.put_wall_gex || 0 });
  if (snap.gamma_flip != null) out.push({ type: 'gamma_flip', price: snap.gamma_flip, gex: 0 });
  if (Array.isArray(snap.resistance)) snap.resistance.forEach((p, i) => p != null && out.push({ type: `R${i+1}`, price: p, gex: snap.resistance_gex?.[i] || 0 }));
  if (Array.isArray(snap.support)) snap.support.forEach((p, i) => p != null && out.push({ type: `S${i+1}`, price: p, gex: snap.support_gex?.[i] || 0 }));
  return out;
}
const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

function buildLevelHistory(snaps) {
  const sp = snaps.map(s => ({ ts: Date.parse(s.timestamp), snap: s })).sort((a, b) => a.ts - b.ts);
  const PRICE_TOL = 1.0;
  const history = [];
  for (const { ts, snap } of sp) {
    for (const lvl of extractLevels(snap)) {
      const isSupp = SUPPORT_TYPES.has(lvl.type);
      const isRes = RESIST_TYPES.has(lvl.type);
      const isFlip = lvl.type === 'gamma_flip';
      let matched = null;
      for (const h of history) {
        const sameClass = (isSupp && h.isSupp) || (isRes && h.isRes) || (isFlip && h.isFlip);
        if (sameClass && Math.abs(h.price - lvl.price) <= PRICE_TOL) { matched = h; break; }
      }
      if (matched) { matched.last_seen_ts = ts; matched.seen_snaps_count++; }
      else history.push({ price: lvl.price, type_initial: lvl.type, isSupp, isRes, isFlip, first_seen_ts: ts, last_seen_ts: ts, seen_snaps_count: 1 });
    }
  }
  return { snapsParsed: sp, history };
}

// OFI loader
console.log('Loading OFI...');
async function loadCSV(p, parser) {
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  const out = [];
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const parts = line.split(',');
    const r = parser(parts);
    if (r) out.push(r);
  }
  return out;
}
const ofiRows = await loadCSV(`${DATA_DIR}/orderflow/nq/trade-ofi-1m.csv`, p => {
  const ts = Date.parse(p[0]);
  if (isNaN(ts)) return null;
  return { ts, signedFlow: -Number(p[3]), totalVolume: +p[4] };  // netVolume sign-flipped
});
const ofiByTs = new Map(ofiRows.map(r => [r.ts, r]));
console.log(`OFI rows: ${ofiRows.length.toLocaleString()}`);

// Detect touches (current + stale)
console.log('\nDetecting touches...');
const touchesByDate = new Map();
let totalTouches = 0;
for (const dateStr of dates) {
  const snaps = loadGex(dateStr);
  if (!snaps) { touchesByDate.set(dateStr, { touches: [] }); continue; }
  const ld = buildLevelHistory(snaps);
  const dayCandles = byDate.get(dateStr);
  const dayTouches = [];
  let prevClose = null;
  for (const { candle: c, et } of dayCandles) {
    if (et.hours < 7 || (et.hours === 16 && et.minutes >= 40) || et.hours > 16) {
      prevClose = c.close; continue;
    }
    const snapTargetTs = c.timestamp - SNAP_LAG_MIN * 60_000;
    let currentSnap = null;
    for (const s of ld.snapsParsed) {
      if (s.ts > snapTargetTs) break;
      currentSnap = s;
    }
    if (!currentSnap) { prevClose = c.close; continue; }
    const currentLevels = extractLevels(currentSnap.snap);
    for (const h of ld.history) {
      if (h.first_seen_ts > snapTargetTs) continue;
      const dist = Math.min(Math.abs(c.low - h.price), Math.abs(c.high - h.price));
      const inside = c.low <= h.price && h.price <= c.high;
      if (!inside && dist > TOUCH_DISTANCE) continue;
      if (prevClose == null) continue;
      const approach = prevClose > h.price ? 'from_above' : prevClose < h.price ? 'from_below' : null;
      if (!approach) continue;

      let isCurrent = false;
      for (const l of currentLevels) {
        if (Math.abs(l.price - h.price) <= 1) { isCurrent = true; break; }
      }
      let minutes_stale = 0;
      if (!isCurrent) {
        minutes_stale = (c.timestamp - h.last_seen_ts) / 60_000;
        if (minutes_stale < STALE_MIN_AGE_MIN || minutes_stale > STALE_MAX_AGE_MIN) continue;
      }

      const minuteTs = Math.floor(c.timestamp / 60000) * 60000;
      const touchOFI = ofiByTs.get(minuteTs);
      const post1OFI = ofiByTs.get(minuteTs + 60_000);
      // We capture features here; outcome walked later from 1s data starting t+120s
      dayTouches.push({
        ts: c.timestamp,
        date: dateStr,
        time_et: `${String(et.hours).padStart(2,'0')}:${String(et.minutes).padStart(2,'0')}`,
        dow: et.dow,
        level_price: h.price,
        level_type_initial: h.type_initial,
        approach,
        eventType: isCurrent ? 'current' : 'stale',
        minutes_stale,
        seen_snaps: h.seen_snaps_count,
        signalContract: c.symbol,
        // OFI snapshots
        touch_ofi: touchOFI?.signedFlow ?? null,
        post1_ofi: post1OFI?.signedFlow ?? null,
        touch_vol: touchOFI?.totalVolume ?? null,
        post1_vol: post1OFI?.totalVolume ?? null,
        // touch bar features (1m)
        touch_open: c.open, touch_high: c.high, touch_low: c.low, touch_close: c.close, touch_volume: c.volume,
        prev_close: prevClose,
      });
      totalTouches++;
    }
    prevClose = c.close;
  }
  touchesByDate.set(dateStr, { touches: dayTouches });
}
console.log(`Total touches detected: ${totalTouches.toLocaleString()}`);

// 1s-honest walks starting at touch+120s
console.log(`\nStreaming 1s OHLCV, walking from touch+${ENTRY_DELAY_SEC}s for ${MAX_HOLD_MIN}min hold...`);
const onesPath = `${DATA_DIR}/ohlcv/nq/NQ_ohlcv_1s.csv`;

function bsearch(bars, ts) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (bars[m].ts < ts) lo = m + 1; else hi = m; }
  return lo;
}

function eodCutoffMs(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  let utcMs = Date.UTC(y, mo - 1, d, 16 + 5, 40);
  const et = toET(utcMs);
  if (et.hours !== 16 || et.minutes !== 40) utcMs = Date.UTC(y, mo - 1, d, 16 + 4, 40);
  return utcMs;
}

function walk(bars, signalContract, walkStartTs, entryPrice, direction, maxHoldTs, eodMs) {
  const stopTs = Math.min(maxHoldTs, eodMs);
  const startIdx = bsearch(bars, walkStartTs);
  const out = {
    direction, entry_price: entryPrice,
    mfe_pts: 0, mae_pts: 0,
    rolloverAt: null, finalTs: null,
    time_to_target_sec: {}, time_to_stop_sec: {},
    closes: {},
  };
  for (const p of TARGET_PTS) out.time_to_target_sec[p] = null;
  for (const p of STOP_PTS) out.time_to_stop_sec[p] = null;
  const HORIZONS = [1, 2, 3, 5, 10, 15, 30];
  for (const m of HORIZONS) out.closes[`close_${m}m`] = null;
  let lastBar = null;
  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    if (b.ts > stopTs) break;
    if (b.symbol !== signalContract) { out.rolloverAt = b.ts; break; }
    const sec = Math.max(0, Math.round((b.ts - walkStartTs) / 1000));
    const minE = sec / 60;
    let fav, adv;
    if (direction === 'long') { fav = b.high - entryPrice; adv = entryPrice - b.low; }
    else { fav = entryPrice - b.low; adv = b.high - entryPrice; }
    if (fav > out.mfe_pts) out.mfe_pts = fav;
    if (adv > out.mae_pts) out.mae_pts = adv;
    for (const p of TARGET_PTS) if (out.time_to_target_sec[p] == null && fav >= p) out.time_to_target_sec[p] = sec;
    for (const p of STOP_PTS) if (out.time_to_stop_sec[p] == null && adv >= p) out.time_to_stop_sec[p] = sec;
    for (const m of HORIZONS) {
      const k = `close_${m}m`;
      if (out.closes[k] == null && minE >= m) out.closes[k] = b.close;
    }
    lastBar = b;
  }
  out.finalTs = lastBar ? lastBar.ts : null;
  out.mfe_pts = +out.mfe_pts.toFixed(2);
  out.mae_pts = +out.mae_pts.toFixed(2);
  return out;
}

let curDate = null, curBars = [];
const enriched = [];

function processDay(dateStr, secondBars) {
  const dayInfo = touchesByDate.get(dateStr);
  if (!dayInfo || dayInfo.touches.length === 0 || secondBars.length === 0) return;
  const eodMs = eodCutoffMs(dateStr);
  for (const t of dayInfo.touches) {
    const walkStartTs = t.ts + ENTRY_DELAY_SEC * 1000;
    const sigContract = t.signalContract;
    // Entry price = open of first 1s bar at walkStartTs of same contract
    const startIdx = bsearch(secondBars, walkStartTs);
    let entryBar = null;
    for (let i = startIdx; i < secondBars.length; i++) {
      if (secondBars[i].symbol === sigContract) { entryBar = secondBars[i]; break; }
      if (secondBars[i].ts >= walkStartTs + 60_000) break;
    }
    if (!entryBar) continue;
    const entryPrice = entryBar.open;
    // Determine direction
    const h = { isSupp: SUPPORT_TYPES.has(t.level_type_initial), isRes: RESIST_TYPES.has(t.level_type_initial), isFlip: t.level_type_initial === 'gamma_flip' };
    let dir;
    if (h.isSupp || (h.isFlip && t.approach === 'from_above')) dir = 'long';
    else if (h.isRes || (h.isFlip && t.approach === 'from_below')) dir = 'short';
    else continue;

    const maxHoldTs = walkStartTs + MAX_HOLD_MIN * 60_000;
    const w = walk(secondBars, sigContract, walkStartTs, entryPrice, dir, maxHoldTs, eodMs);

    enriched.push({
      ts: t.ts, date: t.date, time_et: t.time_et, dow: t.dow,
      level_type_initial: t.level_type_initial, level_price: t.level_price, approach: t.approach,
      eventType: t.eventType, minutes_stale: t.minutes_stale, seen_snaps: t.seen_snaps,
      signalContract: t.signalContract,
      touch_ofi: t.touch_ofi, post1_ofi: t.post1_ofi,
      touch_vol: t.touch_vol, post1_vol: t.post1_vol,
      touch_open: t.touch_open, touch_high: t.touch_high, touch_low: t.touch_low, touch_close: t.touch_close, touch_volume: t.touch_volume,
      prev_close: t.prev_close,
      entry_price: +entryPrice.toFixed(2),
      walk_dir: dir,
      walk: {
        mfe_pts: w.mfe_pts, mae_pts: w.mae_pts,
        time_to_target_sec: w.time_to_target_sec,
        time_to_stop_sec: w.time_to_stop_sec,
        closes: w.closes,
        rolloverAt: w.rolloverAt,
      },
    });
  }
}

const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null, scanned = 0, kept = 0, processedDays = 0;
const scanStartIso = new Date(START).toISOString();
const scanEndIso = new Date(new Date(END).getTime() + 36 * 3600000).toISOString();
const tStart = Date.now();

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 20000000 === 0) console.log(`  scanned ${(scanned/1e6).toFixed(0)}M kept ${(kept/1e6).toFixed(1)}M days=${processedDays}/${dates.length} events=${enriched.length} (${((Date.now()-tStart)/1000).toFixed(0)}s)`);
  const c0 = line.indexOf(',');
  if (c0 < 0) continue;
  const tsStr = line.slice(0, c0);
  if (tsStr < scanStartIso) continue;
  if (tsStr > scanEndIso) break;
  const parts = line.split(',');
  if (parts.length < 10) continue;
  const symbol = parts[9];
  if (symbol.includes('-')) continue;
  const ts = new Date(tsStr).getTime();
  const hour = Math.floor(ts / 3600000);
  const psym = primaryByHour.get(hour);
  if (psym && symbol !== psym) continue;
  const et = toET(ts);
  const barDate = et.date;
  if (barDate !== curDate) {
    if (curDate != null && curBars.length > 0) { processDay(curDate, curBars); processedDays++; }
    curDate = barDate; curBars = [];
  }
  curBars.push({ ts, open: +parts[4], high: +parts[5], low: +parts[6], close: +parts[7], symbol });
  kept++;
}
if (curDate != null && curBars.length > 0) { processDay(curDate, curBars); processedDays++; }
rl.close(); stream.destroy();

console.log(`\n1s scan done: ${scanned.toLocaleString()} rows, ${kept.toLocaleString()} kept, ${enriched.length.toLocaleString()} touches walked`);
console.log(`Elapsed: ${((Date.now()-tStart)/1000).toFixed(0)}s`);

// Save
const outPath = `${OUT_DIR}/touches-t120-1s-honest.json`;
fs.writeFileSync(outPath, JSON.stringify({
  config: { START, END, TOUCH_DISTANCE, STALE_MIN_AGE_MIN, STALE_MAX_AGE_MIN, ENTRY_DELAY_SEC, MAX_HOLD_MIN, TARGET_PTS, STOP_PTS },
  touches: enriched,
}));
console.log(`Saved: ${outPath} (${(fs.statSync(outPath).size/1e6).toFixed(0)}MB)`);
