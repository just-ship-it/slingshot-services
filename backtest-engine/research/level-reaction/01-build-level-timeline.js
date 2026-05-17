/**
 * Phase 1: Unified level timeline + touch EPISODE detector
 *
 * A TOUCH = a 1-min bar whose range intersects the level price (low <= level <= high).
 * This is how a human reads a chart: the bar's high or low (or body) hits the line.
 * No "within N points" — strict intersection only.
 *
 * For every 1m candle (raw + primary contract, calendar spreads dropped),
 * snapshot all active levels:
 *   - GEX: S1-S5, R1-R5, call_wall, put_wall, gamma_flip (cbbo, 16-min lookahead-corrected)
 *   - Structural: PDH, PDL (prior-day RTH H/L)
 *   - Hourly: PRH, PRL (prior completed hour's H/L)
 *   - Session: SH, SL (running RTH H/L), DO (RTH open), VWAP (running RTH session)
 *
 * A TOUCH EPISODE is a contiguous run of bars where the level is touched.
 * Episode ends after --exit-persistence-min bars where the level is NOT touched.
 *
 * Output: JSON of episodes with entry/exit timestamps, max penetration past the
 * level, approach side, regime context, and confluence (other levels touched
 * simultaneously).
 *
 * Usage:
 *   node research/level-reaction/01-build-level-timeline.js \
 *     --start 2025-01-13 --end 2026-01-23 --exit-persistence-min 5
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'research', 'output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const START = arg('start', '2025-01-13');
const END = arg('end', '2026-01-23');
const EXIT_PERSISTENCE_MIN = Number(arg('exit-persistence-min', 5));
const PRODUCT = arg('product', 'NQ').toUpperCase();
const GEX_DIR = arg('gex-dir', 'nq-cbbo');
const SNAP_LAG_MIN = Number(arg('snap-lag-min', 16));
const RTH_START_MIN = 9 * 60 + 30;
const RTH_END_MIN = 16 * 60;

console.log(`\n=== Level Timeline + Episode Detector: ${PRODUCT} ===`);
console.log(`Date range: ${START} -> ${END}`);
console.log(`Touch rule: strict (1m bar low <= level <= high) | Exit persistence: ${EXIT_PERSISTENCE_MIN} bars`);
console.log(`GEX dir: data/gex/${GEX_DIR} (lookahead lag: ${SNAP_LAG_MIN}min)\n`);

// --- Loaders (same pattern as gex-touch-reactions.js) ---
async function loadRawNQ(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  if (!fs.existsSync(filePath)) throw new Error(`OHLCV not found: ${filePath}`);
  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime() + 24 * 3600000;
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const c = {
          timestamp: ts,
          open: +row.open, high: +row.high, low: +row.low, close: +row.close,
          volume: +row.volume || 0, symbol: row.symbol,
        };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${candles.length.toLocaleString()} raw candles`);
  return candles;
}

function filterPrimaryContract(candles) {
  if (!candles.length) return candles;
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const out = [];
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    const m = hourVol.get(h);
    if (!m) { out.push(c); continue; }
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    if (c.symbol === bestSym) out.push(c);
  }
  return out;
}

function loadIntradayGEXCustom(dateStr) {
  const filename = `${PRODUCT.toLowerCase()}_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', GEX_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return content.data || [];
}

function snapshotAtOrBefore(snapshots, targetTs) {
  if (!snapshots || !snapshots.length) return null;
  let best = null;
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).getTime();
    if (ts <= targetTs && (!best || ts > new Date(best.timestamp).getTime())) best = s;
  }
  return best;
}

function extractGEXLevels(snap) {
  const levels = [];
  if (!snap) return levels;
  if (snap.call_wall != null) levels.push({ type: 'call_wall', price: snap.call_wall, gex: snap.call_wall_gex || 0, isResistance: true });
  if (snap.put_wall != null) levels.push({ type: 'put_wall', price: snap.put_wall, gex: snap.put_wall_gex || 0, isResistance: false });
  if (snap.gamma_flip != null) levels.push({ type: 'gamma_flip', price: snap.gamma_flip, gex: 0, isResistance: null });
  if (Array.isArray(snap.resistance)) {
    for (let i = 0; i < snap.resistance.length; i++) {
      levels.push({ type: `R${i + 1}`, price: snap.resistance[i], gex: snap.resistance_gex?.[i] || 0, isResistance: true });
    }
  }
  if (Array.isArray(snap.support)) {
    for (let i = 0; i < snap.support.length; i++) {
      levels.push({ type: `S${i + 1}`, price: snap.support[i], gex: snap.support_gex?.[i] || 0, isResistance: false });
    }
  }
  return levels;
}

function todBucket(min) {
  if (min < 570) return 'pre_rth';
  if (min < 600) return 'open_30';
  if (min < 720) return 'morning';
  if (min < 840) return 'lunch';
  if (min < 930) return 'afternoon';
  if (min < 960) return 'close_30';
  return 'post_rth';
}

// Strict touch: bar's range must intersect the level (wick or body)
function isTouch(candle, levelPrice) {
  return candle.low <= levelPrice && levelPrice <= candle.high;
}

function approachSide(prevCandle, levelPrice) {
  if (!prevCandle) return 'unknown';
  if (prevCandle.close > levelPrice) return 'from_above';
  if (prevCandle.close < levelPrice) return 'from_below';
  return 'at_level';
}

// Format ET timestamp string from raw etObj
function etStamp(et) {
  return `${et.date} ${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`;
}

// --- Core ---
async function run() {
  const all = await loadRawNQ(START, END);
  const candles = filterPrimaryContract(all);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles\n`);

  // Group candles by ET date for derived-level prep
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ ...c, et });
  }
  const dates = [...byDate.keys()].sort();

  // Prior-day RTH H/L per date (computed once)
  const dailyRTH = new Map();
  for (const date of dates) {
    let high = -Infinity, low = Infinity;
    for (const c of byDate.get(date)) {
      const m = c.et.timeInMinutes;
      if (m >= RTH_START_MIN && m < RTH_END_MIN) {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
      }
    }
    if (high > -Infinity) dailyRTH.set(date, { high, low });
  }

  const gexByDate = new Map();
  function getGEX(date) {
    if (gexByDate.has(date)) return gexByDate.get(date);
    const snaps = loadIntradayGEXCustom(date) || [];
    gexByDate.set(date, snaps);
    return snaps;
  }

  // Per-level episode state. Map<levelType, { state }>.
  // state = { active: bool, entryCandle, entryEt, entryPrice (level @ entry),
  //           entryApproach, entrySnap, entryConfluence,
  //           maxPenetration, bars, lastInZoneCandle, outStreak,
  //           highWaterMark, lowWaterMark, volumeSum }
  const levelState = new Map();
  const episodes = [];

  function openEpisode(levelKey, levelMeta, candle, et, approach, snap, confluence) {
    levelState.set(levelKey, {
      active: true,
      entryCandle: candle,
      entryEt: et,
      entryLevelPrice: levelMeta.price,
      entryApproach: approach,
      entrySnap: snap ? { regime: snap.regime, gammaImbalance: snap.gamma_imbalance, snapTs: snap.timestamp, nqSpot: snap.nq_spot } : null,
      entryConfluence: confluence,
      maxPenetration: 0,           // farthest price went past the level (signed by isResistance)
      barsInZone: 1,
      outStreak: 0,
      highWaterMark: candle.high,
      lowWaterMark: candle.low,
      volumeSum: candle.volume,
      lastInZoneCandle: candle,
      lastLevelPrice: levelMeta.price,
      isResistance: levelMeta.isResistance,
      gexAtEntry: levelMeta.gex ?? null,
    });
  }

  function closeEpisode(levelKey, levelType) {
    const s = levelState.get(levelKey);
    if (!s || !s.active) return;
    const ep = {
      levelType,
      // Entry
      entryTimestamp: s.entryCandle.timestamp,
      entryEtDate: s.entryEt.date,
      entryEtTime: `${String(s.entryEt.hour).padStart(2, '0')}:${String(s.entryEt.minute).padStart(2, '0')}`,
      entryEtMinute: s.entryEt.timeInMinutes,
      entryTod: todBucket(s.entryEt.timeInMinutes),
      entryDayOfWeek: s.entryEt.dayOfWeek,
      entrySymbol: s.entryCandle.symbol,
      entryCandle: { o: s.entryCandle.open, h: s.entryCandle.high, l: s.entryCandle.low, c: s.entryCandle.close, v: s.entryCandle.volume },
      entryLevelPrice: s.entryLevelPrice,
      entryApproach: s.entryApproach,
      isResistance: s.isResistance,
      gexAtEntry: s.gexAtEntry,
      regime: s.entrySnap?.regime ?? null,
      gammaImbalance: s.entrySnap?.gammaImbalance ?? null,
      nqSpotAtEntry: s.entrySnap?.nqSpot ?? null,
      snapTsAtEntry: s.entrySnap?.snapTs ?? null,
      confluenceAtEntry: s.entryConfluence,    // [{type, price}, ...] other levels touched at entry
      // During-episode
      maxPenetration: s.maxPenetration,
      barsInZone: s.barsInZone,
      highWaterMark: s.highWaterMark,
      lowWaterMark: s.lowWaterMark,
      volumeSum: s.volumeSum,
      // Exit (last bar in zone, before persistence-out window)
      exitTimestamp: s.lastInZoneCandle.timestamp,
      exitCandle: { o: s.lastInZoneCandle.open, h: s.lastInZoneCandle.high, l: s.lastInZoneCandle.low, c: s.lastInZoneCandle.close, v: s.lastInZoneCandle.volume },
      exitLevelPrice: s.lastLevelPrice,
      durationMin: Math.round((s.lastInZoneCandle.timestamp - s.entryCandle.timestamp) / 60000) + 1,
    };
    episodes.push(ep);
    levelState.delete(levelKey);
  }

  // Walk candles
  let prevDate = null;
  let pdh = null, pdl = null;
  let sh = null, sl = null;
  let doPrice = null;
  let vwapNum = 0, vwapDen = 0;
  let curHourBucket = null;
  let curHourHigh = -Infinity, curHourLow = Infinity;
  let prevHourHigh = null, prevHourLow = null;
  let prevCandle = null;
  const totalCandles = candles.length;
  let processed = 0;

  for (const c of candles) {
    processed++;
    if (processed % 50000 === 0) {
      process.stdout.write(`\r  walking candles: ${processed.toLocaleString()} / ${totalCandles.toLocaleString()}`);
    }
    const et = toET(c.timestamp);
    const inRTH = et.timeInMinutes >= RTH_START_MIN && et.timeInMinutes < RTH_END_MIN;

    if (prevDate !== et.date) {
      // Close all active episodes at day boundary (concept of "session" reset; same level on next day is a new episode)
      for (const key of [...levelState.keys()]) closeEpisode(key, key);
      const prior = dailyRTH.get(prevDate);
      pdh = prior?.high ?? null;
      pdl = prior?.low ?? null;
      sh = null; sl = null; doPrice = null;
      vwapNum = 0; vwapDen = 0;
      prevDate = et.date;
    }

    if (inRTH) {
      if (doPrice == null) doPrice = c.open;
      sh = sh == null ? c.high : Math.max(sh, c.high);
      sl = sl == null ? c.low : Math.min(sl, c.low);
      const tp = (c.high + c.low + c.close) / 3;
      vwapNum += tp * c.volume;
      vwapDen += c.volume;
    }
    const vwap = vwapDen > 0 ? vwapNum / vwapDen : null;

    const hourBucket = `${et.date}T${String(et.hour).padStart(2, '0')}`;
    if (curHourBucket !== hourBucket) {
      if (curHourBucket != null && curHourHigh > -Infinity) {
        prevHourHigh = curHourHigh;
        prevHourLow = curHourLow;
      }
      curHourBucket = hourBucket;
      curHourHigh = -Infinity;
      curHourLow = Infinity;
    }
    if (c.high > curHourHigh) curHourHigh = c.high;
    if (c.low < curHourLow) curHourLow = c.low;

    // Build level list for this bar
    const levels = [];
    if (pdh != null) levels.push({ type: 'PDH', price: pdh, isResistance: true });
    if (pdl != null) levels.push({ type: 'PDL', price: pdl, isResistance: false });
    if (prevHourHigh != null) levels.push({ type: 'PRH', price: prevHourHigh, isResistance: true });
    if (prevHourLow != null) levels.push({ type: 'PRL', price: prevHourLow, isResistance: false });
    if (sh != null) levels.push({ type: 'SH', price: sh, isResistance: true });
    if (sl != null) levels.push({ type: 'SL', price: sl, isResistance: false });
    if (doPrice != null) levels.push({ type: 'DO', price: doPrice, isResistance: null });
    if (vwap != null) levels.push({ type: 'VWAP', price: vwap, isResistance: null });

    const gexSnaps = getGEX(et.date);
    const targetSnapTs = c.timestamp - SNAP_LAG_MIN * 60000;
    const snap = snapshotAtOrBefore(gexSnaps, targetSnapTs);
    const gexLevels = extractGEXLevels(snap);
    for (const gl of gexLevels) levels.push(gl);

    // Strict touch test: bar's range must intersect the level
    const touched = new Map();
    for (const lv of levels) {
      if (isTouch(c, lv.price)) touched.set(lv.type, lv);
    }

    // Confluence list (for the entry snapshot of a new episode): all levels touched in this bar
    const confluenceList = [...touched.values()].map(lv => ({ type: lv.type, price: lv.price }));

    // For each level touched this bar: open or extend episode
    for (const [type, lv] of touched) {
      const existing = levelState.get(type);
      if (!existing) {
        // New episode
        openEpisode(type, lv, c, et, approachSide(prevCandle, lv.price), snap, confluenceList);
      } else {
        // Extend
        existing.barsInZone++;
        existing.outStreak = 0;
        // Penetration: how far has price gone PAST the level (signed by direction)
        // For a resistance: penetration = max(0, high - level)
        // For a support: penetration = max(0, level - low)
        // For unsided (gamma_flip, DO, VWAP): max abs cross either way
        let pen = 0;
        if (lv.isResistance === true) pen = Math.max(0, c.high - lv.price);
        else if (lv.isResistance === false) pen = Math.max(0, lv.price - c.low);
        else pen = Math.max(Math.max(0, c.high - lv.price), Math.max(0, lv.price - c.low));
        if (pen > existing.maxPenetration) existing.maxPenetration = pen;
        if (c.high > existing.highWaterMark) existing.highWaterMark = c.high;
        if (c.low < existing.lowWaterMark) existing.lowWaterMark = c.low;
        existing.volumeSum += c.volume;
        existing.lastInZoneCandle = c;
        existing.lastLevelPrice = lv.price;
      }
    }

    // For active episodes whose level is NOT touched this bar: increment outStreak
    for (const [type, s] of levelState) {
      if (touched.has(type)) continue;
      s.outStreak++;
      if (s.outStreak >= EXIT_PERSISTENCE_MIN) {
        closeEpisode(type, type);
      }
    }

    prevCandle = c;
  }
  // Close any still-open episodes at end of run
  for (const key of [...levelState.keys()]) closeEpisode(key, key);
  process.stdout.write(`\r  walking candles: ${totalCandles.toLocaleString()} / ${totalCandles.toLocaleString()}\n`);

  console.log(`\n${episodes.length.toLocaleString()} touch episodes captured`);

  const byLevelType = new Map();
  for (const e of episodes) {
    const k = e.levelType;
    byLevelType.set(k, (byLevelType.get(k) || 0) + 1);
  }
  console.log('\nEpisode counts by level type:');
  const sorted = [...byLevelType.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) console.log(`  ${k.padEnd(12)} ${v.toString().padStart(8)}`);

  // Duration distribution
  const durations = episodes.map(e => e.durationMin).sort((a, b) => a - b);
  const pct = (p) => durations[Math.floor(p * durations.length)];
  console.log('\nDuration (minutes in zone) distribution:');
  console.log(`  median=${pct(0.5)}  p75=${pct(0.75)}  p90=${pct(0.9)}  p99=${pct(0.99)}  max=${durations[durations.length-1]}`);

  // Penetration distribution
  const pens = episodes.map(e => e.maxPenetration).sort((a, b) => a - b);
  console.log(`\nMax penetration into level (pts) distribution:`);
  console.log(`  median=${pens[Math.floor(pens.length*0.5)].toFixed(1)}  p75=${pens[Math.floor(pens.length*0.75)].toFixed(1)}  p90=${pens[Math.floor(pens.length*0.9)].toFixed(1)}  p99=${pens[Math.floor(pens.length*0.99)].toFixed(1)}`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `level-reaction-episodes-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    config: { start: START, end: END, touchRule: 'strict_intersect', exitPersistenceMin: EXIT_PERSISTENCE_MIN, snapLagMin: SNAP_LAG_MIN, gexDir: GEX_DIR },
    summary: {
      totalCandles: candles.length,
      tradingDays: dates.length,
      totalEpisodes: episodes.length,
      byLevelType: Object.fromEntries(sorted),
    },
    episodes,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
