/**
 * Combine STALE GEX levels with OFI confirmation.
 * If the post1 OFI > 50 + post1 close > level filter works on stale levels
 * as well as it does on current levels, we get ~3x the event count.
 */
import fs from 'fs';
import readline from 'readline';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const GEX_DIR = `${ROOT}/data/gex/nq-cbbo`;
const NQ_1M_PATH = `${ROOT}/data/ohlcv/nq/NQ_ohlcv_1m.csv`;

const START = '2025-01-13';
const END = '2026-01-28';
const TOUCH_DISTANCE = 10;
const STALE_MIN_AGE_MIN = 30;
const STALE_MAX_AGE_MIN = 240;
const SNAP_LAG_MIN = 16;

// Load NQ primary
async function loadPrimaryNQ() {
  const rl = readline.createInterface({ input: fs.createReadStream(NQ_1M_PATH), crlfDelay: Infinity });
  const hourVol = new Map();
  const rows = [];
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const parts = line.split(',');
    const symbol = parts[9];
    if (!symbol || symbol.includes('-')) continue;
    const ts = parts[0];
    const tsMs = Date.parse(ts);
    if (isNaN(tsMs)) continue;
    if (ts.slice(0, 10) < START || ts.slice(0, 10) > END) continue;
    const open = +parts[4], high = +parts[5], low = +parts[6], close = +parts[7];
    const volume = +parts[8] || 0;
    if (isNaN(open) || isNaN(close)) continue;
    const hour = Math.floor(tsMs / 3600000);
    if (!hourVol.has(hour)) hourVol.set(hour, new Map());
    const m = hourVol.get(hour);
    m.set(symbol, (m.get(symbol) || 0) + volume);
    rows.push({ ts: tsMs, open, high, low, close, volume, symbol });
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let best = '', bestV = -1;
    for (const [s, v] of m.entries()) if (v > bestV) { bestV = v; best = s; }
    primary.set(h, best);
  }
  return rows.filter(r => r.symbol === primary.get(Math.floor(r.ts / 3600000)));
}
console.log('Loading...');
const candles = await loadPrimaryNQ();
const close1m = new Map();
for (const c of candles) close1m.set(c.ts, c.close);

// Load OFI minute map
const ofiJoined = JSON.parse(fs.readFileSync(`${ROOT}/research/output/ofi-nq-joined.json`)).joined;
const ofiByTs = new Map();
for (const r of ofiJoined) {
  ofiByTs.set(r.ts, {
    signedFlow: -r.netVolume,
    totalVolume: r.totalVolume,
    close: r.close,
  });
}

function toET(ts) {
  const d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hours: d.getHours(), minutes: d.getMinutes(), date: d.toISOString().slice(0, 10), dow: d.getDay() };
}
const byDate = new Map();
for (const c of candles) {
  const et = toET(c.ts);
  if (!byDate.has(et.date)) byDate.set(et.date, []);
  byDate.get(et.date).push({ candle: c, et });
}
const dates = [...byDate.keys()].sort();

function loadGexDay(dateStr) {
  const p = `${GEX_DIR}/nq_gex_${dateStr}.json`;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')).data || [];
}
function extractLevels(snap) {
  const out = [];
  if (snap.call_wall != null) out.push({ type: 'call_wall', price: snap.call_wall });
  if (snap.put_wall != null) out.push({ type: 'put_wall', price: snap.put_wall });
  if (snap.gamma_flip != null) out.push({ type: 'gamma_flip', price: snap.gamma_flip });
  if (Array.isArray(snap.resistance)) snap.resistance.forEach((p, i) => p != null && out.push({ type: `R${i+1}`, price: p }));
  if (Array.isArray(snap.support)) snap.support.forEach((p, i) => p != null && out.push({ type: `S${i+1}`, price: p }));
  return out;
}

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

function buildLevelHistory(snaps) {
  const snapsParsed = snaps.map(s => ({ ts: Date.parse(s.timestamp), snap: s })).sort((a, b) => a.ts - b.ts);
  const PRICE_TOL = 1.0;
  const history = [];
  for (const { ts, snap } of snapsParsed) {
    const levels = extractLevels(snap);
    for (const lvl of levels) {
      const isSupp = SUPPORT_TYPES.has(lvl.type);
      const isRes = RESIST_TYPES.has(lvl.type);
      const isFlip = lvl.type === 'gamma_flip';
      let matched = null;
      for (const h of history) {
        const sameClass = (isSupp && h.isSupp) || (isRes && h.isRes) || (isFlip && h.isFlip);
        if (sameClass && Math.abs(h.price - lvl.price) <= PRICE_TOL) { matched = h; break; }
      }
      if (matched) { matched.last_seen_ts = ts; matched.seen_snaps_count++; }
      else history.push({
        price: lvl.price, type_initial: lvl.type, isSupp, isRes, isFlip,
        first_seen_ts: ts, last_seen_ts: ts, seen_snaps_count: 1,
      });
    }
  }
  return { snapsParsed, history };
}

// Detect touches across both current AND stale levels
const events = [];
let dayIdx = 0;
for (const dateStr of dates) {
  dayIdx++;
  const snaps = loadGexDay(dateStr);
  if (!snaps) continue;
  const ld = buildLevelHistory(snaps);
  const dayCandles = byDate.get(dateStr);
  let prevClose = null;
  for (const { candle: c, et } of dayCandles) {
    if (et.hours < 7 || (et.hours === 16 && et.minutes >= 40) || et.hours > 16) {
      prevClose = c.close; continue;
    }
    const snapTargetTs = c.ts - SNAP_LAG_MIN * 60_000;
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
      if (!isCurrent) {
        const minutesSinceLastSeen = (c.ts - h.last_seen_ts) / 60_000;
        if (minutesSinceLastSeen < STALE_MIN_AGE_MIN) continue;
        if (minutesSinceLastSeen > STALE_MAX_AGE_MIN) continue;
      }

      const minuteTs = Math.floor(c.ts / 60000) * 60000;
      const touchOFI = ofiByTs.get(minuteTs);
      const post1OFI = ofiByTs.get(minuteTs + 60_000);
      const post1Close = close1m.get(minuteTs + 60_000);

      events.push({
        ts: c.ts, date: dateStr, et,
        level_price: h.price, level_type_initial: h.type_initial,
        approach,
        eventType: isCurrent ? 'current' : 'stale',
        minutes_stale: isCurrent ? 0 : (c.ts - h.last_seen_ts) / 60_000,
        seen_snaps: h.seen_snaps_count,
        candle: c, prevClose,
        touch_ofi: touchOFI?.signedFlow,
        post1_ofi: post1OFI?.signedFlow,
        post1_close: post1Close,
        post1_above_level: post1Close != null && post1Close > h.price,
        post1_below_level: post1Close != null && post1Close < h.price,
      });
    }
    prevClose = c.close;
  }
  if (dayIdx % 50 === 0) console.log(`  ${dayIdx}/${dates.length}  events=${events.length.toLocaleString()}`);
}
console.log(`\nTotal events: ${events.length.toLocaleString()}`);

// Forward outcome: 1m-approximation walk from entry_ts = touch_ts + 120s (after post1 confirmation)
function fwdOutcome(entryTs, entryPrice, dir, target, stop, holdMin) {
  for (let m = 1; m <= holdMin; m++) {
    const c = close1m.get(entryTs + (m - 1) * 60_000);
    if (c == null) continue;
    const fav = dir === 'long' ? c - entryPrice : entryPrice - c;
    const adv = dir === 'long' ? entryPrice - c : c - entryPrice;
    if (adv >= stop) return 'loss';
    if (fav >= target) return 'win';
  }
  return 'timeout';
}

// For each event, compute outcome at delayed entry (touch_ts + 120s)
for (const e of events) {
  const h = { isSupp: SUPPORT_TYPES.has(e.level_type_initial), isRes: RESIST_TYPES.has(e.level_type_initial), isFlip: e.level_type_initial === 'gamma_flip' };
  let bounceDir;
  if (h.isSupp || (h.isFlip && e.approach === 'from_above')) bounceDir = 'long';
  else if (h.isRes || (h.isFlip && e.approach === 'from_below')) bounceDir = 'short';
  else continue;
  // Entry is 120s after touch_ts (after post1 minute closes)
  const entryTs = Math.floor(e.ts / 60000) * 60000 + 120_000;
  const entryPrice = e.post1_close;
  if (entryPrice == null) continue;
  e.bounceDir = bounceDir;
  e.outcome10 = fwdOutcome(entryTs, entryPrice, bounceDir, 10, 5, 14);  // 14min remaining
  e.outcome15 = fwdOutcome(entryTs, entryPrice, bounceDir, 15, 8, 14);
  e.outcome7 = fwdOutcome(entryTs, entryPrice, bounceDir, 7, 4, 14);
}

function summary(arr, outcomeField, target, stop) {
  const valid = arr.filter(e => e[outcomeField]);
  const w = valid.filter(e => e[outcomeField] === 'win').length;
  const l = valid.filter(e => e[outcomeField] === 'loss').length;
  const to = valid.filter(e => e[outcomeField] === 'timeout').length;
  const wr = valid.length > 0 ? w / valid.length : 0;
  const ev = valid.length > 0 ? (w * target - l * stop) / valid.length : 0;
  return { n: valid.length, w, l, to, wr, ev };
}

function p(label, arr) {
  if (arr.length < 50) return;
  const s10 = summary(arr, 'outcome10', 10, 5);
  const s15 = summary(arr, 'outcome15', 15, 8);
  const s7 = summary(arr, 'outcome7', 7, 4);
  console.log(`  ${label.padEnd(72)} n=${String(s10.n).padStart(5)}  T7/S4: ${(s7.wr*100).toFixed(1).padStart(5)}%  T10/S5: ${(s10.wr*100).toFixed(1).padStart(5)}% EV=${s10.ev.toFixed(2).padStart(6)}  T15/S8: ${(s15.wr*100).toFixed(1).padStart(5)}% EV=${s15.ev.toFixed(2).padStart(6)}`);
}

// Define the OFI confirmation predicate (works for both current and stale)
function isLongConfirm(e) {
  // Support level + approach from above + post1 OFI positive + post1 close > level
  const h = { isSupp: SUPPORT_TYPES.has(e.level_type_initial), isFlip: e.level_type_initial === 'gamma_flip' };
  if (!(h.isSupp || (h.isFlip && e.approach === 'from_above'))) return false;
  if (e.approach !== 'from_above') return false;
  if (e.post1_ofi == null || e.post1_ofi <= 0) return false;
  if (!e.post1_above_level) return false;
  return true;
}
function isShortConfirm(e) {
  const h = { isRes: RESIST_TYPES.has(e.level_type_initial), isFlip: e.level_type_initial === 'gamma_flip' };
  if (!(h.isRes || (h.isFlip && e.approach === 'from_below'))) return false;
  if (e.approach !== 'from_below') return false;
  if (e.post1_ofi == null || e.post1_ofi >= 0) return false;
  if (!e.post1_below_level) return false;
  return true;
}

console.log(`\n=== STALE LEVELS + OFI confirmation (LONG side) ===`);
console.log(`(post1 OFI > 0 + post1 close > level)\n`);
const allConfirmedLongs = events.filter(isLongConfirm);
const currentLongs = allConfirmedLongs.filter(e => e.eventType === 'current');
const staleLongs = allConfirmedLongs.filter(e => e.eventType === 'stale');
p('Current + long confirm', currentLongs);
p('Stale + long confirm', staleLongs);
p('Combined (current + stale) + long confirm', allConfirmedLongs);

console.log(`\n=== STALE LEVELS + OFI confirmation (SHORT side) ===`);
const allConfirmedShorts = events.filter(isShortConfirm);
const currentShorts = allConfirmedShorts.filter(e => e.eventType === 'current');
const staleShorts = allConfirmedShorts.filter(e => e.eventType === 'stale');
p('Current + short confirm', currentShorts);
p('Stale + short confirm', staleShorts);

console.log(`\n=== Tighter OFI threshold ===`);
p('Current LONG (OFI > 50)', currentLongs.filter(e => e.post1_ofi > 50));
p('Stale LONG (OFI > 50)', staleLongs.filter(e => e.post1_ofi > 50));
p('Combined LONG (OFI > 50)', allConfirmedLongs.filter(e => e.post1_ofi > 50));
p('Current LONG (OFI > 100)', currentLongs.filter(e => e.post1_ofi > 100));
p('Stale LONG (OFI > 100)', staleLongs.filter(e => e.post1_ofi > 100));
p('Combined LONG (OFI > 100)', allConfirmedLongs.filter(e => e.post1_ofi > 100));

console.log(`\n=== Stale long by level type ===`);
for (const t of ['put_wall','S1','S2','S3','S4','S5','gamma_flip']) {
  p(`Stale ${t} long`, staleLongs.filter(e => e.level_type_initial === t));
}

console.log(`\n=== Stale long by age ===`);
for (const range of [[30,60],[60,90],[90,120],[120,180],[180,240]]) {
  const subset = staleLongs.filter(e => e.minutes_stale >= range[0] && e.minutes_stale < range[1]);
  p(`Stale ${range[0]}-${range[1]}min long`, subset);
}

// Tally annualized projections
console.log(`\n=== Annualized projections ===`);
const yrFrac = (candles[candles.length-1].ts - candles[0].ts) / (365.25 * 86400_000);
const ratios = [
  ['Combined LONG (OFI>0)', allConfirmedLongs, 10, 5],
  ['Combined LONG (OFI>50)', allConfirmedLongs.filter(e => e.post1_ofi > 50), 10, 5],
  ['Combined LONG (OFI>100)', allConfirmedLongs.filter(e => e.post1_ofi > 100), 10, 5],
  ['Combined SHORT (OFI<-0)', allConfirmedShorts, 10, 5],
  ['Combined SHORT (OFI<-50)', allConfirmedShorts.filter(e => e.post1_ofi < -50), 10, 5],
];
for (const [name, arr, tgt, stp] of ratios) {
  const s = summary(arr, 'outcome10', tgt, stp);
  const trades_yr = s.n / yrFrac;
  const ev_per_trade = s.ev;
  const gross_yr = trades_yr * ev_per_trade * 20;
  console.log(`  ${name.padEnd(40)} n=${String(s.n).padStart(5)} (${(trades_yr).toFixed(0)}/yr) WR=${(s.wr*100).toFixed(1)}% EV=${ev_per_trade.toFixed(2)}pt  gross=$${gross_yr.toFixed(0)}/yr/1c`);
}

console.log(`\nDone.`);
