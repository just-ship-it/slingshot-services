/**
 * Stale-GEX-level hypothesis: levels that were active EARLIER today but have
 * since shifted/disappeared may STILL act as support/resistance because
 * dealer positioning, retail memory, and order books retain the level.
 *
 * For each trading day:
 *   1. Collect every (level_type, price) pair that appears in any 15-min
 *      snapshot during the day. Tag each level's first_seen and last_active
 *      timestamps.
 *   2. A level is "current" at time T if it appears in the snap at or before T.
 *      It's "stale" at T if it was current at any earlier snap-time today but
 *      is NOT in the snap at T.
 *   3. For each minute of price action: check distance to (a) current level
 *      set, (b) stale level set. Mark touches accordingly.
 *
 * Then evaluate: do bounce/break outcomes at STALE levels match those at
 * CURRENT levels?
 */
import fs from 'fs';
import readline from 'readline';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const GEX_DIR = `${ROOT}/data/gex/nq-cbbo`;
const NQ_1M_PATH = `${ROOT}/data/ohlcv/nq/NQ_ohlcv_1m.csv`;

const START = '2025-01-13';
const END = '2026-01-28';
const TOUCH_DISTANCE = 10;
const STALE_MIN_AGE_MIN = 30;  // a level is "stale" only if it stopped being current >= 30min ago
const STALE_MAX_AGE_MIN = 240; // ignore very old levels (> 4hr stale)
const SNAP_LAG_MIN = 16;

// --- Load primary NQ 1m ---
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
console.log('Loading NQ 1m primary...');
const candles = await loadPrimaryNQ();
console.log(`Loaded ${candles.length.toLocaleString()} primary candles`);

// Group by date (ET)
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
console.log(`Dates: ${dates.length}`);

// --- For each date, build level history ---
function loadGexDay(dateStr) {
  const p = `${GEX_DIR}/nq_gex_${dateStr}.json`;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')).data || [];
}
function extractLevels(snap) {
  if (!snap) return [];
  const out = [];
  if (snap.call_wall != null) out.push({ type: 'call_wall', price: snap.call_wall });
  if (snap.put_wall != null) out.push({ type: 'put_wall', price: snap.put_wall });
  if (snap.gamma_flip != null) out.push({ type: 'gamma_flip', price: snap.gamma_flip });
  if (Array.isArray(snap.resistance)) snap.resistance.forEach((p, i) => p != null && out.push({ type: `R${i+1}`, price: p }));
  if (Array.isArray(snap.support)) snap.support.forEach((p, i) => p != null && out.push({ type: `S${i+1}`, price: p }));
  return out;
}

// Helper to determine if a level is "support" or "resistance" semantically
const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

// Build per-day level history
function buildLevelHistory(snaps) {
  // Returns: { snapTs: [levels at that snap], levelHistory: [{type, price, first_seen_ts, last_seen_ts}] }
  if (!snaps || snaps.length === 0) return null;
  const snapsParsed = snaps.map(s => ({ ts: Date.parse(s.timestamp), snap: s }));
  snapsParsed.sort((a, b) => a.ts - b.ts);
  const PRICE_TOL = 1.0;  // 2 prices within 1pt = "same level"
  // history: array of { price, type_initial, first_seen_ts, last_seen_ts, seen_snaps_count }
  // To track a level across snaps, match by price proximity (within PRICE_TOL pts) AND same type semantic class.
  const history = [];
  for (const { ts, snap } of snapsParsed) {
    const levels = extractLevels(snap);
    for (const lvl of levels) {
      const isSupp = SUPPORT_TYPES.has(lvl.type);
      const isRes = RESIST_TYPES.has(lvl.type);
      const isFlip = lvl.type === 'gamma_flip';
      // Find existing history entry within tolerance
      let matched = null;
      for (const h of history) {
        const sameClass = (isSupp && h.isSupp) || (isRes && h.isRes) || (isFlip && h.isFlip);
        if (sameClass && Math.abs(h.price - lvl.price) <= PRICE_TOL) { matched = h; break; }
      }
      if (matched) {
        matched.last_seen_ts = ts;
        matched.seen_snaps_count++;
      } else {
        history.push({
          price: lvl.price,
          type_initial: lvl.type,
          isSupp, isRes, isFlip,
          first_seen_ts: ts, last_seen_ts: ts,
          seen_snaps_count: 1,
        });
      }
    }
  }
  return { snapsParsed, history };
}

// --- Touch detection: current vs stale ---
let currentTouches = 0, staleTouches = 0;
const touchEvents = [];
let dayIdx = 0;
for (const dateStr of dates) {
  dayIdx++;
  const snaps = loadGexDay(dateStr);
  if (!snaps) continue;
  const ld = buildLevelHistory(snaps);
  if (!ld) continue;
  const dayCandles = byDate.get(dateStr);

  let prevClose = null;
  for (let i = 0; i < dayCandles.length; i++) {
    const { candle: c, et } = dayCandles[i];
    if (et.hours < 7 || (et.hours === 16 && et.minutes >= 40) || et.hours > 16) {
      prevClose = c.close; continue;
    }
    // Current snap (snap-lag-corrected)
    const snapTargetTs = c.ts - SNAP_LAG_MIN * 60_000;
    let currentSnap = null;
    for (const s of ld.snapsParsed) {
      if (s.ts > snapTargetTs) break;
      currentSnap = s;
    }
    if (!currentSnap) { prevClose = c.close; continue; }
    const currentLevels = extractLevels(currentSnap.snap);
    const currentPrices = new Set(currentLevels.map(l => l.price.toFixed(2)));

    // For each level in history that was first seen BEFORE current snapTs, classify:
    //   - "current" if it's in the current snapshot's levels
    //   - "stale" otherwise (it was active earlier but not in current snap)
    // Only count "stale" levels that haven't been seen in recent past either
    for (const h of ld.history) {
      if (h.first_seen_ts > snapTargetTs) continue;  // not yet existed
      // Distance from candle to level
      const dist = Math.min(Math.abs(c.low - h.price), Math.abs(c.high - h.price));
      const inside = c.low <= h.price && h.price <= c.high;
      if (!inside && dist > TOUCH_DISTANCE) continue;

      // Approach direction
      if (prevClose == null) continue;
      const approach = prevClose > h.price ? 'from_above' : prevClose < h.price ? 'from_below' : null;
      if (!approach) continue;

      // Is this level in current snap (matched by price tolerance)?
      let isCurrent = false;
      for (const l of currentLevels) {
        if (Math.abs(l.price - h.price) <= 1) { isCurrent = true; break; }
      }

      // For stale levels: it must have stopped being current at least STALE_MIN_AGE_MIN minutes ago
      // and not more than STALE_MAX_AGE_MIN ago
      if (!isCurrent) {
        const minutesSinceLastSeen = (c.ts - h.last_seen_ts) / 60_000;
        if (minutesSinceLastSeen < STALE_MIN_AGE_MIN) continue;
        if (minutesSinceLastSeen > STALE_MAX_AGE_MIN) continue;
      }

      const eventType = isCurrent ? 'current' : 'stale';
      if (isCurrent) currentTouches++; else staleTouches++;

      touchEvents.push({
        ts: c.ts, date: dateStr,
        level_price: h.price,
        level_type_initial: h.type_initial,
        approach,
        eventType,
        candle: c,
        first_seen: h.first_seen_ts,
        last_seen: h.last_seen_ts,
        minutes_stale: isCurrent ? 0 : (c.ts - h.last_seen_ts) / 60_000,
        seen_snaps: h.seen_snaps_count,
        et,
      });
    }
    prevClose = c.close;
  }
  if (dayIdx % 30 === 0) console.log(`  processed ${dayIdx}/${dates.length} days  current=${currentTouches.toLocaleString()} stale=${staleTouches.toLocaleString()}`);
}
console.log(`\nTotal current touches: ${currentTouches.toLocaleString()}`);
console.log(`Total stale touches:   ${staleTouches.toLocaleString()}`);
console.log(`Total events: ${touchEvents.length.toLocaleString()}`);

// --- Forward outcome via 1m closes (approximation; not fully 1s-honest, but fast) ---
const close1m = new Map();
for (const c of candles) close1m.set(c.ts, c.close);

function fwdOutcome(entryTs, entryPrice, dir, target, stop, holdMin) {
  for (let m = 1; m <= holdMin; m++) {
    const c = close1m.get(entryTs + (m - 1) * 60_000);
    if (c == null) continue;
    const fav = dir === 'long' ? c - entryPrice : entryPrice - c;
    const adv = dir === 'long' ? entryPrice - c : c - entryPrice;
    if (adv >= stop) return { outcome: 'loss', m, exit_price: entryPrice - (dir === 'long' ? stop : -stop) };
    if (fav >= target) return { outcome: 'win', m, exit_price: entryPrice + (dir === 'long' ? target : -target) };
  }
  return { outcome: 'timeout', m: holdMin };
}

// Score outcomes per event
for (const e of touchEvents) {
  // Treat support levels: bounce = long; resistance levels: bounce = short
  const h = { isSupp: SUPPORT_TYPES.has(e.level_type_initial), isRes: RESIST_TYPES.has(e.level_type_initial), isFlip: e.level_type_initial === 'gamma_flip' };
  let bounceDir;
  if (h.isSupp || (h.isFlip && e.approach === 'from_above')) bounceDir = 'long';
  else if (h.isRes || (h.isFlip && e.approach === 'from_below')) bounceDir = 'short';
  else continue;
  const entryTs = e.candle.ts + 60_000;
  const entryPrice = e.candle.close;
  // T10/S5/H15
  e.outcome10 = fwdOutcome(entryTs, entryPrice, bounceDir, 10, 5, 15);
  e.outcome15 = fwdOutcome(entryTs, entryPrice, bounceDir, 15, 8, 15);
  e.bounceDir = bounceDir;
}

function summarize(arr) {
  const w = arr.filter(e => e.outcome10?.outcome === 'win').length;
  const l = arr.filter(e => e.outcome10?.outcome === 'loss').length;
  const to = arr.filter(e => e.outcome10?.outcome === 'timeout').length;
  const wr = arr.length > 0 ? w / arr.length : 0;
  const ev = arr.length > 0 ? (w * 10 - l * 5) / arr.length : 0;
  return { n: arr.length, w, l, to, wr, ev };
}

console.log(`\n=== Comparison: current vs stale level touches ===`);
const cur = touchEvents.filter(e => e.eventType === 'current' && e.outcome10);
const stale = touchEvents.filter(e => e.eventType === 'stale' && e.outcome10);
const cb = summarize(cur);
const sb = summarize(stale);
console.log(`Current levels (all): n=${cb.n}  W=${cb.w} L=${cb.l} TO=${cb.to}  WR=${(cb.wr*100).toFixed(1)}%  EV=${cb.ev.toFixed(2)}`);
console.log(`Stale levels (all):   n=${sb.n}  W=${sb.w} L=${sb.l} TO=${sb.to}  WR=${(sb.wr*100).toFixed(1)}%  EV=${sb.ev.toFixed(2)}`);

// Break down by minutes stale
console.log(`\n=== Stale levels by age ===`);
for (const range of [[30,60],[60,90],[90,120],[120,180],[180,240]]) {
  const subset = stale.filter(e => e.minutes_stale >= range[0] && e.minutes_stale < range[1]);
  if (subset.length < 50) continue;
  const s = summarize(subset);
  console.log(`  Stale ${range[0]}-${range[1]}min: n=${s.n}  WR=${(s.wr*100).toFixed(1)}%  EV=${s.ev.toFixed(2)}`);
}

// Break down by level type
console.log(`\n=== Stale levels by initial type ===`);
const TYPES = ['put_wall','S1','S2','S3','S4','S5','call_wall','R1','R2','R3','R4','R5','gamma_flip'];
for (const t of TYPES) {
  const subset = stale.filter(e => e.level_type_initial === t);
  if (subset.length < 50) continue;
  const s = summarize(subset);
  console.log(`  Stale ${t.padEnd(10)}: n=${String(s.n).padStart(4)}  WR=${(s.wr*100).toFixed(1)}%  EV=${s.ev.toFixed(2)}`);
}

// Break down by approach (current vs stale)
console.log(`\n=== Current vs Stale by approach ===`);
for (const evType of ['current', 'stale']) {
  for (const approach of ['from_above', 'from_below']) {
    const subset = touchEvents.filter(e => e.eventType === evType && e.approach === approach && e.outcome10);
    if (subset.length < 50) continue;
    const s = summarize(subset);
    console.log(`  ${evType} ${approach}: n=${String(s.n).padStart(5)}  WR=${(s.wr*100).toFixed(1)}%  EV=${s.ev.toFixed(2)}`);
  }
}

// Seen_snaps_count: levels seen in more snaps = "stronger"?
console.log(`\n=== By how many snaps the level appeared in (stale only) ===`);
for (const range of [[1,3],[3,6],[6,12],[12,30]]) {
  const subset = stale.filter(e => e.seen_snaps >= range[0] && e.seen_snaps < range[1]);
  if (subset.length < 50) continue;
  const s = summarize(subset);
  console.log(`  seen_snaps ${range[0]}-${range[1]}: n=${s.n}  WR=${(s.wr*100).toFixed(1)}%  EV=${s.ev.toFixed(2)}`);
}

// Save
fs.writeFileSync(`${ROOT}/research/output/stale-levels-touches.json`, JSON.stringify({
  meta: { currentTouches, staleTouches, total: touchEvents.length, dates: dates.length },
  current_summary: cb, stale_summary: sb,
}, null, 2));
console.log(`\nSaved summary to stale-levels-touches.json`);
