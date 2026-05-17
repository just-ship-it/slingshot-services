/**
 * Build 1s-honest walks with EXTENDED targets and longer holds, for the
 * structurally-validated touch subset (prior_touches >= 2).
 *
 * Designed to capture the big moves the user is talking about (50-200pt
 * after multi-test resistance breaks).
 *
 * Entry: t+60s (immediate after touch bar close — same as before)
 * Stop tiers: 8, 10, 12, 15, 20, 25 pts (structural)
 * Target tiers: 15, 20, 30, 40, 50, 75, 100, 150 pts (extended)
 * Hold: walk to 180 min max (eod cutoff applies)
 *
 * Only walks touches where prior_touches >= 1 (saves ~80% of events).
 */
import fs from 'fs';
import readline from 'readline';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const DATA_DIR = `${ROOT}/data`;

console.log('Loading touches with structural feature...');
const data = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-with-structural.json`));
const touches = data;
console.log(`Loaded ${touches.length.toLocaleString()} touches`);
const subset = touches.filter(t => t.prior_touches >= 1);
console.log(`Subset (prior_touches >= 1): ${subset.length.toLocaleString()}`);

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

function bsearch(bars, ts) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (bars[m].ts < ts) lo = m + 1; else hi = m; }
  return lo;
}

// Group subset by date for batched 1s processing
const subsetByDate = new Map();
for (const t of subset) {
  if (!subsetByDate.has(t.date)) subsetByDate.set(t.date, []);
  subsetByDate.get(t.date).push(t);
}

// We need primary-contract hour map
async function loadPrimary() {
  console.log('Loading primary-contract map...');
  const rl = readline.createInterface({ input: fs.createReadStream(`${DATA_DIR}/ohlcv/nq/NQ_ohlcv_1m.csv`), crlfDelay: Infinity });
  const hourVol = new Map();
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const parts = line.split(',');
    const symbol = parts[9];
    if (!symbol || symbol.includes('-')) continue;
    const ts = parts[0];
    const tsMs = Date.parse(ts);
    if (isNaN(tsMs)) continue;
    const vol = +parts[8] || 0;
    const hour = Math.floor(tsMs / 3600000);
    if (!hourVol.has(hour)) hourVol.set(hour, new Map());
    const m = hourVol.get(hour);
    m.set(symbol, (m.get(symbol) || 0) + vol);
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let best = '', bestV = -1;
    for (const [s, v] of m.entries()) if (v > bestV) { bestV = v; best = s; }
    primary.set(h, best);
  }
  return primary;
}
const primaryByHour = await loadPrimary();
console.log(`Primary hours: ${primaryByHour.size}`);

// signalContract: for each touch we need to know which contract was primary at the touch hour
for (const t of subset) {
  t.signalContract = primaryByHour.get(Math.floor(t.ts / 3600000));
}

// Stream 1s OHLCV, walk forward 180min for each touch
const TARGET_PTS = [10, 15, 20, 30, 40, 50, 75, 100, 150];
const STOP_PTS = [5, 8, 10, 12, 15, 20, 25, 30];
const MAX_HOLD_MIN = 180;
const EOD_CUTOFF_ET = '16:40';

function toET(ts) {
  const d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hours: d.getHours(), minutes: d.getMinutes(), date: d.toISOString().slice(0, 10) };
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
    direction, entry_price: entryPrice, mfe_pts: 0, mae_pts: 0,
    rolloverAt: null, finalTs: null,
    time_to_target_sec: {}, time_to_stop_sec: {},
    closes: {},
  };
  for (const p of TARGET_PTS) out.time_to_target_sec[p] = null;
  for (const p of STOP_PTS) out.time_to_stop_sec[p] = null;
  const HORIZONS = [5, 15, 30, 60, 90, 120];
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

// Set bounceDir
for (const t of subset) {
  const isS = SUPPORT_TYPES.has(t.level_type), isR = RESIST_TYPES.has(t.level_type), isF = t.level_type === 'gamma_flip';
  if (isS || (isF && t.approach === 'from_above')) t.bounceDir = 'long';
  else if (isR || (isF && t.approach === 'from_below')) t.bounceDir = 'short';
}

console.log('Streaming 1s OHLCV for extended walks...');
const onesPath = `${DATA_DIR}/ohlcv/nq/NQ_ohlcv_1s.csv`;
const scanStartIso = new Date('2025-01-13').toISOString();
const scanEndIso = new Date(new Date('2026-01-28').getTime() + 36 * 3600000).toISOString();

let curDate = null, curBars = [];

function processDay(dateStr, bars) {
  const dayTouches = subsetByDate.get(dateStr);
  if (!dayTouches || dayTouches.length === 0 || bars.length === 0) return;
  const eodMs = eodCutoffMs(dateStr);
  for (const t of dayTouches) {
    if (!t.bounceDir) continue;
    const walkStartTs = t.ts + 60_000;
    const startIdx = bsearch(bars, walkStartTs);
    let entryBar = null;
    for (let i = startIdx; i < bars.length; i++) {
      if (bars[i].symbol === t.signalContract) { entryBar = bars[i]; break; }
      if (bars[i].ts >= walkStartTs + 60_000) break;
    }
    if (!entryBar) continue;
    const entryPrice = entryBar.open;
    const maxHoldTs = walkStartTs + MAX_HOLD_MIN * 60_000;
    t.extendedWalk = walk(bars, t.signalContract, walkStartTs, entryPrice, t.bounceDir, maxHoldTs, eodMs);
    t.entry_price = +entryPrice.toFixed(2);
  }
}

const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null, scanned = 0, kept = 0, processedDays = 0;
const tStart = Date.now();

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 20000000 === 0) console.log(`  scanned ${(scanned/1e6).toFixed(0)}M kept ${(kept/1e6).toFixed(1)}M days=${processedDays}/272 (${((Date.now()-tStart)/1000).toFixed(0)}s)`);
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

const walked = subset.filter(t => t.extendedWalk).length;
console.log(`\nWalked ${walked} touches (${((Date.now()-tStart)/1000).toFixed(0)}s)`);

// Save (just the extended walks + identifiers)
const out = subset.filter(t => t.extendedWalk).map(t => ({
  touch_id: t.touch_id, ts: t.ts, date: t.date, time_et: t.time_et,
  level_type: t.level_type, level_price: t.level_price, approach: t.approach,
  prior_touches: t.prior_touches, max_prior_wick: t.max_prior_wick,
  bounceDir: t.bounceDir, entry_price: t.entry_price,
  walk: t.extendedWalk, features: t.features, s1: t.s1,
}));
fs.writeFileSync(`${ROOT}/research/output/touches-extended-walks.json`, JSON.stringify(out));
console.log(`Saved. Records: ${out.length}`);
