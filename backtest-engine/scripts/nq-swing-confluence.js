#!/usr/bin/env node
/**
 * NQ Swing Point Confluence & Feature Analysis
 *
 * For each lookback-8 swing point (stop ≤ 30pts), computes ~31 features across
 * 6 categories (price action, volume, 1s micro-structure, GEX, LT, IV), then
 * reports which features best separate winners (MFE ≥ 30pts) from losers.
 *
 * Usage:
 *   node scripts/nq-swing-confluence.js [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 *                                        [--no-seconds] [--output path.json]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { SecondDataProvider } from '../src/data/csv-loader.js';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};
const hasFlag = (name) => args.includes(`--${name}`);

const startDateStr = getArg('start', '2025-01-01');
const endDateStr = getArg('end', '2025-07-31');
const outputPath = getArg('output', 'nq-swing-confluence-results.json');
const skipSeconds = hasFlag('no-seconds');
const MFE_THRESHOLD = 30;
const LOOKBACK = 8;
const MAX_STOP = 30;

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

console.log('='.repeat(80));
console.log('NQ SWING POINT CONFLUENCE & FEATURE ANALYSIS');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Lookback: ${LOOKBACK}, Max stop: ${MAX_STOP}pts, Win threshold: MFE ≥ ${MFE_THRESHOLD}pts`);
console.log(`1-second micro features: ${skipSeconds ? 'DISABLED' : 'enabled'}`);
console.log();

// ============================================================================
// Helpers
// ============================================================================

function formatNum(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return 'N/A';
  return n.toFixed(decimals);
}

function formatPct(n, decimals = 1) {
  if (n === null || n === undefined || isNaN(n)) return 'N/A';
  return (n * 100).toFixed(decimals) + '%';
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function median(arr) { return percentile(arr, 50); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

const round15m = ts => Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);

function getSession(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false
  });
  const [hourStr, minStr] = estString.split(':');
  const hour = parseInt(hourStr);
  const min = parseInt(minStr);
  const td = hour + min / 60;
  if (td >= 18 || td < 4) return 'overnight';
  if (td >= 4 && td < 9.5) return 'premarket';
  if (td >= 9.5 && td < 16) return 'rth';
  return 'afterhours';
}

/** Pre-compute day opens for O(1) lookup. Key = EST date string, value = open price. */
function buildDayOpenMap(candles) {
  const dayOpens = new Map(); // estDateStr -> open price
  for (const c of candles) {
    const estDate = new Date(c.timestamp).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    if (!dayOpens.has(estDate)) dayOpens.set(estDate, c.open);
  }
  return dayOpens;
}

let _dayOpenMap = null;
function getDaySessionOpen(candles, idx) {
  if (!_dayOpenMap) _dayOpenMap = buildDayOpenMap(candles);
  const estDate = new Date(candles[idx].timestamp).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  return _dayOpenMap.get(estDate) ?? candles[0].open;
}

// ============================================================================
// Data Loading
// ============================================================================

function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;
  const contractVolumes = new Map();
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    if (!contractVolumes.has(hourKey)) contractVolumes.set(hourKey, new Map());
    const hourData = contractVolumes.get(hourKey);
    hourData.set(candle.symbol, (hourData.get(candle.symbol) || 0) + (candle.volume || 0));
  });
  return candles.filter(candle => {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    const hourData = contractVolumes.get(hourKey);
    if (!hourData) return true;
    let primarySymbol = '', maxVolume = 0;
    for (const [symbol, volume] of hourData) {
      if (volume > maxVolume) { maxVolume = volume; primarySymbol = symbol; }
    }
    return candle.symbol === primarySymbol;
  });
}

async function loadOHLCVData() {
  const filePath = path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  console.log('Loading NQ 1m OHLCV data...');
  const candles = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    const symbol = parts[9]?.trim();
    if (symbol && symbol.includes('-')) continue;
    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseInt(parts[8]);
    if (open === high && high === low && low === close) continue;
    candles.push({ timestamp, open, high, low, close, volume, symbol });
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  const filtered = filterPrimaryContract(candles);
  console.log(`  Loaded ${filtered.length} candles (${candles.length} before primary contract filter)`);
  return filtered;
}

async function loadGEXData() {
  const gexDir = path.join(dataDir, 'gex/nq');
  console.log('Loading GEX intraday data...');
  const gexMap = new Map(); // 15min timestamp -> snapshot

  // Find all JSON files in date range
  const files = fs.readdirSync(gexDir).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  let loaded = 0;
  for (const file of files) {
    const dateStr = file.replace('nq_gex_', '').replace('.json', '');
    const fileDate = new Date(dateStr + 'T00:00:00Z');
    if (fileDate < new Date(startDateStr + 'T00:00:00Z') || fileDate > new Date(endDateStr + 'T23:59:59Z')) continue;

    const content = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf-8'));
    for (const snap of content.data) {
      const ts = new Date(snap.timestamp).getTime();
      const key = round15m(ts);
      gexMap.set(key, snap);
    }
    loaded++;
  }
  console.log(`  Loaded ${loaded} GEX files, ${gexMap.size} snapshots`);
  return gexMap;
}

async function loadLTData() {
  const filePath = path.join(dataDir, 'liquidity/nq/NQ_liquidity_levels.csv');
  console.log('Loading LT levels...');
  const ltMap = new Map(); // 15min timestamp -> { sentiment, levels: [5 levels] }
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 8) continue;
    const ts = parseInt(parts[1]);
    if (ts < startDate.getTime() || ts > endDate.getTime()) continue;
    const key = round15m(ts);
    ltMap.set(key, {
      sentiment: parts[2]?.trim(),
      levels: [parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5]),
               parseFloat(parts[6]), parseFloat(parts[7])]
    });
  }
  console.log(`  Loaded ${ltMap.size} LT snapshots`);
  return ltMap;
}

async function loadIVData() {
  const filePath = path.join(dataDir, 'iv/qqq/qqq_atm_iv_15m.csv');
  console.log('Loading ATM IV data...');
  const ivMap = new Map(); // 15min timestamp -> { iv, spot_price, call_iv, put_iv, dte }
  const allIVs = []; // for percentile calculation
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 7) continue;
    const ts = new Date(parts[0]).getTime();
    if (isNaN(ts)) continue;
    const iv = parseFloat(parts[1]);
    const key = round15m(ts);
    allIVs.push({ ts: key, iv });
    if (ts < startDate.getTime() || ts > endDate.getTime()) continue;
    ivMap.set(key, {
      iv,
      spot_price: parseFloat(parts[2]),
      call_iv: parseFloat(parts[4]),
      put_iv: parseFloat(parts[5]),
      dte: parseInt(parts[6])
    });
  }

  // Pre-compute 20-day rolling IV percentile for each snapshot in range
  // 20 trading days ≈ 20 * 26 snapshots (6.5h RTH * 4/hr) = ~520 snapshots lookback
  const LOOKBACK_SNAPS = 520;
  allIVs.sort((a, b) => a.ts - b.ts);
  const ivPercentiles = new Map();
  for (let i = 0; i < allIVs.length; i++) {
    const { ts, iv } = allIVs[i];
    if (!ivMap.has(ts)) continue;
    const windowStart = Math.max(0, i - LOOKBACK_SNAPS);
    const window = allIVs.slice(windowStart, i + 1).map(x => x.iv).sort((a, b) => a - b);
    const rank = window.filter(x => x <= iv).length;
    ivPercentiles.set(ts, rank / window.length);
  }

  // Pre-compute IV change (4 snapshots back = 1 hour)
  const ivChanges = new Map();
  for (let i = 4; i < allIVs.length; i++) {
    const { ts, iv } = allIVs[i];
    if (!ivMap.has(ts)) continue;
    ivChanges.set(ts, iv - allIVs[i - 4].iv);
  }

  console.log(`  Loaded ${ivMap.size} IV snapshots`);
  return { ivMap, ivPercentiles, ivChanges };
}

// ============================================================================
// Swing Detection (identical to nq-swing-opportunity.js)
// ============================================================================

function findSwingHighs(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candle.high) { isSwing = false; break; }
    }
    if (isSwing) swings.push({ price: candle.high, close: candle.close, open: candle.open,
      low: candle.low, high: candle.high, volume: candle.volume,
      timestamp: candle.timestamp, index: i });
  }
  return swings;
}

function findSwingLows(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low <= candle.low) { isSwing = false; break; }
    }
    if (isSwing) swings.push({ price: candle.low, close: candle.close, open: candle.open,
      low: candle.low, high: candle.high, volume: candle.volume,
      timestamp: candle.timestamp, index: i });
  }
  return swings;
}

// ============================================================================
// MFE Analysis (identical to nq-swing-opportunity.js)
// ============================================================================

function analyzeSwingOpportunity(candles, swing, type) {
  const entryIndex = swing.index + 1;
  if (entryIndex >= candles.length) return null;
  const entryPrice = swing.close;
  const swingPrice = swing.price;
  const risk = Math.abs(swingPrice - entryPrice);
  let mfe = 0, barsToMFE = 0, barsToInvalidation = null, runningMFE = 0;

  for (let i = entryIndex; i < candles.length; i++) {
    const c = candles[i];
    const barsSinceEntry = i - entryIndex;
    if (type === 'high') {
      const favorable = entryPrice - c.low;
      if (favorable > runningMFE) { runningMFE = favorable; barsToMFE = barsSinceEntry; }
      if (c.high > swingPrice) { barsToInvalidation = barsSinceEntry; break; }
    } else {
      const favorable = c.high - entryPrice;
      if (favorable > runningMFE) { runningMFE = favorable; barsToMFE = barsSinceEntry; }
      if (c.low < swingPrice) { barsToInvalidation = barsSinceEntry; break; }
    }
  }
  mfe = runningMFE;
  return { type, swingPrice, entryPrice, risk, mfe, barsToMFE, barsToInvalidation,
    session: getSession(swing.timestamp), timestamp: swing.timestamp, index: swing.index };
}

// ============================================================================
// Feature Extraction
// ============================================================================

function extractPriceFeatures(candles, swing, result) {
  const i = swing.index;
  const c = candles[i];
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);

  // Wick ratio: proportion of candle that is wick
  const wickRatio = range > 0 ? 1 - (body / range) : 0;
  // Body ratio: proportion of candle that is body
  const bodyRatio = range > 0 ? body / range : 0;

  // Preceding momentum (5 and 10 bar)
  const mom5 = i >= 5 ? candles[i].close - candles[i - 5].close : 0;
  const mom10 = i >= 10 ? candles[i].close - candles[i - 10].close : 0;

  // 20-bar ATR
  let atr20 = 0;
  if (i >= 20) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) {
      const tr = Math.max(
        candles[j].high - candles[j].low,
        Math.abs(candles[j].high - candles[j - 1].close),
        Math.abs(candles[j].low - candles[j - 1].close)
      );
      sum += tr;
    }
    atr20 = sum / 20;
  }

  // Distance from day open
  const dayOpen = getDaySessionOpen(candles, i);
  const distFromDayOpen = c.close - dayOpen;

  // Bars since last swing (approximated: look back for previous candle that had
  // higher high or lower low than its neighbors - simplified)
  let barsSinceLastSwing = null;
  // We'll set this later from the swing array context

  return {
    wick_ratio: wickRatio,
    body_size: body,
    candle_range: range,
    momentum_5bar: mom5,
    momentum_10bar: mom10,
    atr_20bar: atr20,
    body_ratio: bodyRatio,
    dist_from_day_open: distFromDayOpen,
    // bars_since_last_swing set externally
  };
}

function extractVolumeFeatures(candles, swing) {
  const i = swing.index;
  const c = candles[i];

  // 20-bar average volume
  let avgVol20 = 0;
  if (i >= 20) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += candles[j].volume;
    avgVol20 = sum / 20;
  }

  const rvol = avgVol20 > 0 ? c.volume / avgVol20 : 1;
  const volumeSpike = rvol > 2.0 ? 1 : 0;

  // 5-bar volume SMA slope
  let volTrend = 0;
  if (i >= 5) {
    const recent = (candles[i].volume + candles[i - 1].volume + candles[i - 2].volume) / 3;
    const prior = (candles[i - 3].volume + candles[i - 4].volume + candles[i - 5].volume) / 3;
    volTrend = prior > 0 ? (recent - prior) / prior : 0;
  }

  // Volume delta proxy: sign based on body direction, magnitude based on body/range
  const range = c.high - c.low;
  const bodyDir = c.close >= c.open ? 1 : -1;
  const bodyPct = range > 0 ? Math.abs(c.close - c.open) / range : 0.5;
  const volDeltaProxy = bodyDir * bodyPct * c.volume;

  // Max volume in 3-bar window around swing
  let maxVol3 = c.volume;
  if (i > 0) maxVol3 = Math.max(maxVol3, candles[i - 1].volume);
  if (i < candles.length - 1) maxVol3 = Math.max(maxVol3, candles[i + 1].volume);
  const maxVol3Ratio = avgVol20 > 0 ? maxVol3 / avgVol20 : 1;

  return {
    rvol: rvol,
    volume_spike: volumeSpike,
    volume_trend: volTrend,
    volume_delta_proxy: volDeltaProxy,
    max_vol_3bar_ratio: maxVol3Ratio,
  };
}

async function extractSecondFeatures(secondProvider, swing, type) {
  const minuteTs = Math.floor(swing.timestamp / 60000) * 60000;
  const seconds = await secondProvider.getSecondsForMinute(minuteTs);

  if (seconds.length === 0) {
    return {
      sweep_speed_sec: null,
      reversal_speed_sec: null,
      intrabar_range: null,
      volume_concentration_5s: null,
      tick_count_at_extreme: null,
      rejection_ratio_1s: null,
    };
  }

  // Find the extreme (high for swing high, low for swing low)
  let extremePrice, extremeIdx;
  if (type === 'high') {
    extremePrice = -Infinity;
    for (let j = 0; j < seconds.length; j++) {
      if (seconds[j].high > extremePrice) { extremePrice = seconds[j].high; extremeIdx = j; }
    }
  } else {
    extremePrice = Infinity;
    for (let j = 0; j < seconds.length; j++) {
      if (seconds[j].low < extremePrice) { extremePrice = seconds[j].low; extremeIdx = j; }
    }
  }

  // Sweep speed: seconds from minute open to extreme
  const sweepSpeed = extremeIdx; // each index = ~1 second

  // Reversal speed: seconds from extreme to last candle
  const reversalSpeed = seconds.length - 1 - extremeIdx;

  // Intra-bar range at 1s resolution
  let secHigh = -Infinity, secLow = Infinity;
  for (const s of seconds) {
    if (s.high > secHigh) secHigh = s.high;
    if (s.low < secLow) secLow = s.low;
  }
  const intrabarRange = secHigh - secLow;

  // Volume concentration: % of total volume in 5s window around extreme
  const totalVol = seconds.reduce((sum, s) => sum + s.volume, 0);
  let windowVol = 0;
  for (let j = Math.max(0, extremeIdx - 2); j <= Math.min(seconds.length - 1, extremeIdx + 2); j++) {
    windowVol += seconds[j].volume;
  }
  const volConcentration = totalVol > 0 ? windowVol / totalVol : 0;

  // Tick count at extreme: how many 1s candles touched within 1pt of extreme
  let tickCount = 0;
  for (const s of seconds) {
    if (type === 'high') {
      if (s.high >= extremePrice - 1) tickCount++;
    } else {
      if (s.low <= extremePrice + 1) tickCount++;
    }
  }

  // Rejection ratio at 1s: how far price moved away from extreme vs range
  const lastClose = seconds[seconds.length - 1].close;
  const firstOpen = seconds[0].open;
  const rejectionRatio = intrabarRange > 0
    ? Math.abs(extremePrice - lastClose) / intrabarRange
    : 0;

  return {
    sweep_speed_sec: sweepSpeed,
    reversal_speed_sec: reversalSpeed,
    intrabar_range: intrabarRange,
    volume_concentration_5s: volConcentration,
    tick_count_at_extreme: tickCount,
    rejection_ratio_1s: rejectionRatio,
  };
}

function extractGEXFeatures(gexMap, swing) {
  const key = round15m(swing.timestamp);
  // Search current and previous 15m slots (GEX may not update every 15m)
  let snap = null;
  for (let offset = 0; offset <= 4; offset++) {
    snap = gexMap.get(key - offset * 15 * 60 * 1000);
    if (snap) break;
  }

  if (!snap) {
    return {
      dist_to_nearest_gex_support: null,
      dist_to_nearest_gex_resistance: null,
      dist_to_gamma_flip: null,
      gex_regime: null,
      at_gex_level: null,
    };
  }

  const price = swing.price;
  const supports = (snap.support || []).filter(v => !isNaN(v) && v > 0);
  const resistances = (snap.resistance || []).filter(v => !isNaN(v) && v > 0);

  const distSupport = supports.length > 0
    ? Math.min(...supports.map(s => Math.abs(price - s)))
    : null;
  const distResistance = resistances.length > 0
    ? Math.min(...resistances.map(r => Math.abs(price - r)))
    : null;
  const distGammaFlip = snap.gamma_flip ? Math.abs(price - snap.gamma_flip) : null;

  const allLevels = [...supports, ...resistances];
  if (snap.gamma_flip) allLevels.push(snap.gamma_flip);
  if (snap.call_wall) allLevels.push(snap.call_wall);
  if (snap.put_wall) allLevels.push(snap.put_wall);
  const atGexLevel = allLevels.some(l => Math.abs(price - l) <= 15) ? 1 : 0;

  // Encode regime as number for analysis
  const regimeMap = { strong_negative: -2, negative: -1, neutral: 0, positive: 1, strong_positive: 2 };
  const regimeNum = regimeMap[snap.regime] ?? null;

  return {
    dist_to_nearest_gex_support: distSupport,
    dist_to_nearest_gex_resistance: distResistance,
    dist_to_gamma_flip: distGammaFlip,
    gex_regime: regimeNum,
    at_gex_level: atGexLevel,
  };
}

function extractLTFeatures(ltMap, swing) {
  const key = round15m(swing.timestamp);
  let snap = null;
  for (let offset = 0; offset <= 4; offset++) {
    snap = ltMap.get(key - offset * 15 * 60 * 1000);
    if (snap) break;
  }

  if (!snap) {
    return {
      dist_to_nearest_lt: null,
      lt_levels_within_30pts: null,
      lt_sentiment: null,
    };
  }

  const price = swing.price;
  const levels = snap.levels.filter(l => !isNaN(l) && l > 0);
  const distNearest = levels.length > 0
    ? Math.min(...levels.map(l => Math.abs(price - l)))
    : null;
  const levelsWithin30 = levels.filter(l => Math.abs(price - l) <= 30).length;
  const sentimentNum = snap.sentiment === 'BULLISH' ? 1 : snap.sentiment === 'BEARISH' ? -1 : 0;

  return {
    dist_to_nearest_lt: distNearest,
    lt_levels_within_30pts: levelsWithin30,
    lt_sentiment: sentimentNum,
  };
}

function extractIVFeatures(ivData, swing) {
  const { ivMap, ivPercentiles, ivChanges } = ivData;
  const key = round15m(swing.timestamp);
  // Search current and nearby slots
  let snap = null, foundKey = null;
  for (let offset = 0; offset <= 4; offset++) {
    const k = key - offset * 15 * 60 * 1000;
    if (ivMap.has(k)) { snap = ivMap.get(k); foundKey = k; break; }
  }

  if (!snap) {
    return {
      atm_iv: null,
      iv_percentile: null,
      iv_change_1h: null,
    };
  }

  return {
    atm_iv: snap.iv,
    iv_percentile: ivPercentiles.get(foundKey) ?? null,
    iv_change_1h: ivChanges.get(foundKey) ?? null,
  };
}

// ============================================================================
// Statistical Analysis
// ============================================================================

function analyzeFeatures(events) {
  // Get all feature names from first event that has features
  const featureNames = Object.keys(events[0].features);
  const results = [];

  for (const name of featureNames) {
    const vals = events.map(e => ({ val: e.features[name], winner: e.winner }))
      .filter(x => x.val !== null && x.val !== undefined && !isNaN(x.val));

    if (vals.length < 50) {
      results.push({ name, n: vals.length, skipped: true });
      continue;
    }

    const winners = vals.filter(x => x.winner);
    const losers = vals.filter(x => !x.winner);

    const winMean = mean(winners.map(x => x.val));
    const loseMean = mean(losers.map(x => x.val));
    const winMedian = median(winners.map(x => x.val));
    const loseMedian = median(losers.map(x => x.val));

    // Detect binary features (only 0/1 values)
    const uniqueVals = new Set(vals.map(x => x.val));
    const isBinary = uniqueVals.size === 2 && uniqueVals.has(0) && uniqueVals.has(1);

    let med, above, below, wrAbove, wrBelow, separation;

    if (isBinary) {
      // For binary features: split on value = 1 vs 0
      med = 0.5; // synthetic split point
      above = vals.filter(x => x.val === 1);
      below = vals.filter(x => x.val === 0);
      wrAbove = above.length > 0 ? above.filter(x => x.winner).length / above.length : 0;
      wrBelow = below.length > 0 ? below.filter(x => x.winner).length / below.length : 0;
      separation = Math.abs(wrAbove - wrBelow);
    } else {
      // Median split: compute win rate above vs below median
      med = median(vals.map(x => x.val));
      above = vals.filter(x => x.val >= med);
      below = vals.filter(x => x.val < med);
      wrAbove = above.length > 0 ? above.filter(x => x.winner).length / above.length : 0;
      wrBelow = below.length > 0 ? below.filter(x => x.winner).length / below.length : 0;
      separation = Math.abs(wrAbove - wrBelow);
    }

    // Quartile analysis
    const p25 = percentile(vals.map(x => x.val), 25);
    const p75 = percentile(vals.map(x => x.val), 75);
    const q1 = vals.filter(x => x.val <= p25);
    const q4 = vals.filter(x => x.val >= p75);
    const wrQ1 = q1.length > 0 ? q1.filter(x => x.winner).length / q1.length : 0;
    const wrQ4 = q4.length > 0 ? q4.filter(x => x.winner).length / q4.length : 0;

    results.push({
      name,
      n: vals.length,
      isBinary,
      nAbove: above.length,
      nBelow: below.length,
      winMean, loseMean,
      winMedian, loseMedian,
      medianSplit: med,
      wrAbove, wrBelow, separation,
      wrQ1, wrQ4,
      quartileSep: Math.abs(wrQ1 - wrQ4),
      bestSide: wrAbove > wrBelow ? 'above' : 'below',
      bestWR: Math.max(wrAbove, wrBelow),
    });
  }

  // Sort by separation power
  results.sort((a, b) => (b.separation || 0) - (a.separation || 0));
  return results;
}

function analyzeCombinations(events, featureResults) {
  // Take top 8 features by separation and test 2-way and 3-way combos
  const topFeatures = featureResults.filter(f => !f.skipped).slice(0, 8);
  const baseWR = events.filter(e => e.winner).length / events.length;
  const combos = [];

  // 2-way combinations
  for (let i = 0; i < topFeatures.length; i++) {
    for (let j = i + 1; j < topFeatures.length; j++) {
      const f1 = topFeatures[i];
      const f2 = topFeatures[j];
      const filtered = events.filter(e => {
        const v1 = e.features[f1.name];
        const v2 = e.features[f2.name];
        if (v1 === null || v1 === undefined || isNaN(v1)) return false;
        if (v2 === null || v2 === undefined || isNaN(v2)) return false;
        const pass1 = f1.bestSide === 'above' ? v1 >= f1.medianSplit : v1 < f1.medianSplit;
        const pass2 = f2.bestSide === 'above' ? v2 >= f2.medianSplit : v2 < f2.medianSplit;
        return pass1 && pass2;
      });
      if (filtered.length < 30) continue;
      const wr = filtered.filter(e => e.winner).length / filtered.length;
      combos.push({
        features: [f1.name, f2.name],
        count: filtered.length,
        winRate: wr,
        lift: wr - baseWR,
      });
    }
  }

  // 3-way combinations
  for (let i = 0; i < topFeatures.length; i++) {
    for (let j = i + 1; j < topFeatures.length; j++) {
      for (let k = j + 1; k < topFeatures.length; k++) {
        const feats = [topFeatures[i], topFeatures[j], topFeatures[k]];
        const filtered = events.filter(e => {
          return feats.every(f => {
            const v = e.features[f.name];
            if (v === null || v === undefined || isNaN(v)) return false;
            return f.bestSide === 'above' ? v >= f.medianSplit : v < f.medianSplit;
          });
        });
        if (filtered.length < 20) continue;
        const wr = filtered.filter(e => e.winner).length / filtered.length;
        combos.push({
          features: feats.map(f => f.name),
          count: filtered.length,
          winRate: wr,
          lift: wr - baseWR,
        });
      }
    }
  }

  combos.sort((a, b) => b.lift - a.lift);
  return combos;
}

// ============================================================================
// Output Formatting
// ============================================================================

function printFeatureRanking(featureResults, baseWR) {
  console.log('\n' + '='.repeat(120));
  console.log('FEATURE RANKING BY SEPARATION POWER');
  console.log('='.repeat(120));
  console.log(`Base win rate (MFE ≥ ${MFE_THRESHOLD}pts): ${formatPct(baseWR)}`);
  console.log();

  const header = [
    'Rank'.padEnd(5),
    'Feature'.padEnd(28),
    'N'.padStart(6),
    'Win Mean'.padStart(10),
    'Lose Mean'.padStart(10),
    'WR Hi(n)'.padStart(14),
    'WR Lo(n)'.padStart(14),
    'Separation'.padStart(11),
    'Best Q WR'.padStart(10),
  ].join(' ');
  console.log(header);
  console.log('─'.repeat(120));

  let rank = 0;
  for (const f of featureResults) {
    if (f.skipped) continue;
    rank++;
    const hiLabel = `${formatPct(f.wrAbove)}(${f.nAbove})`;
    const loLabel = `${formatPct(f.wrBelow)}(${f.nBelow})`;
    const row = [
      String(rank).padEnd(5),
      (f.name + (f.isBinary ? '*' : '')).padEnd(28),
      String(f.n).padStart(6),
      formatNum(f.winMean).padStart(10),
      formatNum(f.loseMean).padStart(10),
      hiLabel.padStart(14),
      loLabel.padStart(14),
      formatPct(f.separation).padStart(11),
      formatPct(Math.max(f.wrQ1, f.wrQ4)).padStart(10),
    ].join(' ');
    console.log(row);
  }
  console.log('\n  * = binary feature (0/1 split instead of median split)');
}

function printCombinations(combos, baseWR) {
  console.log('\n' + '='.repeat(120));
  console.log('TOP FEATURE COMBINATIONS');
  console.log('='.repeat(120));
  console.log(`Base win rate: ${formatPct(baseWR)}`);

  // 2-feature combos
  const twos = combos.filter(c => c.features.length === 2).slice(0, 15);
  if (twos.length > 0) {
    console.log('\n  TOP 2-FEATURE COMBINATIONS:');
    console.log('  ' + ['Rank'.padEnd(5), 'Features'.padEnd(60), 'Count'.padStart(6),
      'Win Rate'.padStart(9), 'Lift'.padStart(8)].join(' '));
    console.log('  ' + '─'.repeat(90));
    twos.forEach((c, i) => {
      console.log('  ' + [
        String(i + 1).padEnd(5),
        c.features.join(' + ').padEnd(60),
        String(c.count).padStart(6),
        formatPct(c.winRate).padStart(9),
        ('+' + formatPct(c.lift)).padStart(8),
      ].join(' '));
    });
  }

  // 3-feature combos
  const threes = combos.filter(c => c.features.length === 3).slice(0, 15);
  if (threes.length > 0) {
    console.log('\n  TOP 3-FEATURE COMBINATIONS:');
    console.log('  ' + ['Rank'.padEnd(5), 'Features'.padEnd(75), 'Count'.padStart(6),
      'Win Rate'.padStart(9), 'Lift'.padStart(8)].join(' '));
    console.log('  ' + '─'.repeat(105));
    threes.forEach((c, i) => {
      console.log('  ' + [
        String(i + 1).padEnd(5),
        c.features.join(' + ').padEnd(75),
        String(c.count).padStart(6),
        formatPct(c.winRate).padStart(9),
        ('+' + formatPct(c.lift)).padStart(8),
      ].join(' '));
    });
  }
}

function printDetailedFeatureBreakdown(featureResults) {
  console.log('\n' + '='.repeat(120));
  console.log('DETAILED FEATURE BREAKDOWN (Top 10)');
  console.log('='.repeat(120));

  const top10 = featureResults.filter(f => !f.skipped).slice(0, 10);
  for (const f of top10) {
    console.log(`\n  ${f.name}`);
    console.log(`  ${'─'.repeat(50)}`);
    console.log(`  Winners — mean: ${formatNum(f.winMean)}, median: ${formatNum(f.winMedian)}`);
    console.log(`  Losers  — mean: ${formatNum(f.loseMean)}, median: ${formatNum(f.loseMedian)}`);
    console.log(`  Median split at: ${formatNum(f.medianSplit)}`);
    console.log(`  WR above median: ${formatPct(f.wrAbove)} | WR below median: ${formatPct(f.wrBelow)}`);
    console.log(`  WR Q1 (bottom 25%): ${formatPct(f.wrQ1)} | WR Q4 (top 25%): ${formatPct(f.wrQ4)}`);
    console.log(`  Separation: ${formatPct(f.separation)} | Quartile sep: ${formatPct(f.quartileSep)}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const t0 = Date.now();

  // Phase 1: Load all data sources
  console.log('PHASE 1: Loading data sources...\n');
  const candles = await loadOHLCVData();
  if (candles.length === 0) { console.error('No candles loaded.'); process.exit(1); }

  let secondProvider = null;
  if (!skipSeconds) {
    const secondPath = path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1s.csv');
    secondProvider = new SecondDataProvider(secondPath);
    await secondProvider.initialize();
  }

  const gexMap = await loadGEXData();
  const ltMap = await loadLTData();
  const ivData = await loadIVData();

  console.log(`\nAll data loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Phase 2: Detect swing points
  console.log('PHASE 2: Detecting swing points...\n');
  const highs = findSwingHighs(candles, LOOKBACK);
  const lows = findSwingLows(candles, LOOKBACK);
  console.log(`  Found ${highs.length} swing highs, ${lows.length} swing lows`);

  const filteredHighs = highs.filter(s => Math.abs(s.price - s.close) <= MAX_STOP);
  const filteredLows = lows.filter(s => Math.abs(s.price - s.close) <= MAX_STOP);
  console.log(`  After risk filter: ${filteredHighs.length} highs, ${filteredLows.length} lows`);

  // Compute MFE for each swing
  const swingEvents = [];
  for (const swing of filteredHighs) {
    const r = analyzeSwingOpportunity(candles, swing, 'high');
    if (r) swingEvents.push({ swing, result: r, type: 'high' });
  }
  for (const swing of filteredLows) {
    const r = analyzeSwingOpportunity(candles, swing, 'low');
    if (r) swingEvents.push({ swing, result: r, type: 'low' });
  }

  // Sort by timestamp for bars_since_last_swing calculation
  swingEvents.sort((a, b) => a.swing.timestamp - b.swing.timestamp);

  const winners = swingEvents.filter(e => e.result.mfe >= MFE_THRESHOLD);
  const baseWR = winners.length / swingEvents.length;
  console.log(`  Total swings: ${swingEvents.length}, Winners (MFE ≥ ${MFE_THRESHOLD}): ${winners.length} (${formatPct(baseWR)})`);

  // Phase 3: Feature extraction
  console.log('\nPHASE 3: Extracting features...\n');
  let secondsProcessed = 0;
  let secondsMissing = 0;
  const progressInterval = Math.max(1, Math.floor(swingEvents.length / 20));

  for (let ei = 0; ei < swingEvents.length; ei++) {
    const e = swingEvents[ei];
    const { swing, result, type } = e;

    // Category 1: Price action
    const priceFeats = extractPriceFeatures(candles, swing, result);

    // Bars since last swing
    if (ei > 0) {
      priceFeats.bars_since_last_swing = swing.index - swingEvents[ei - 1].swing.index;
    } else {
      priceFeats.bars_since_last_swing = null;
    }

    // Category 2: Volume
    const volFeats = extractVolumeFeatures(candles, swing);

    // Category 3: 1-second micro-structure
    let secFeats;
    if (secondProvider) {
      secFeats = await extractSecondFeatures(secondProvider, swing, type);
      if (secFeats.sweep_speed_sec !== null) secondsProcessed++;
      else secondsMissing++;
    } else {
      secFeats = {
        sweep_speed_sec: null, reversal_speed_sec: null, intrabar_range: null,
        volume_concentration_5s: null, tick_count_at_extreme: null, rejection_ratio_1s: null,
      };
    }

    // Category 4: GEX
    const gexFeats = extractGEXFeatures(gexMap, swing);

    // Category 5: LT
    const ltFeats = extractLTFeatures(ltMap, swing);

    // Category 6: IV
    const ivFeats = extractIVFeatures(ivData, swing);

    // Combine all features
    e.features = { ...priceFeats, ...volFeats, ...secFeats, ...gexFeats, ...ltFeats, ...ivFeats };
    e.winner = result.mfe >= MFE_THRESHOLD;

    if ((ei + 1) % progressInterval === 0) {
      process.stdout.write(`  ${ei + 1}/${swingEvents.length} swings processed\r`);
    }
  }

  console.log(`  Feature extraction complete: ${swingEvents.length} swings`);
  if (secondProvider) {
    console.log(`  1s data: ${secondsProcessed} found, ${secondsMissing} missing`);
  }

  // Phase 4: Statistical analysis
  console.log('\nPHASE 4: Statistical analysis...\n');
  const featureResults = analyzeFeatures(swingEvents);
  const combos = analyzeCombinations(swingEvents, featureResults);

  // Phase 5: Output
  printFeatureRanking(featureResults, baseWR);
  printDetailedFeatureBreakdown(featureResults);
  printCombinations(combos, baseWR);

  // Summary
  console.log('\n' + '='.repeat(120));
  console.log('SUMMARY');
  console.log('='.repeat(120));
  console.log(`\nTotal swings analyzed: ${swingEvents.length}`);
  console.log(`Base win rate (MFE ≥ ${MFE_THRESHOLD}pts): ${formatPct(baseWR)}`);

  const bestSingle = featureResults.find(f => !f.skipped);
  if (bestSingle) {
    console.log(`\nBest single feature: ${bestSingle.name}`);
    console.log(`  Filter to ${bestSingle.bestSide} median → win rate: ${formatPct(bestSingle.bestWR)} (${formatPct(bestSingle.bestWR - baseWR, 1)} lift)`);
  }

  const best2 = combos.filter(c => c.features.length === 2)[0];
  if (best2) {
    console.log(`\nBest 2-feature combo: ${best2.features.join(' + ')}`);
    console.log(`  Win rate: ${formatPct(best2.winRate)} on ${best2.count} swings (+${formatPct(best2.lift)} lift)`);
  }

  const best3 = combos.filter(c => c.features.length === 3)[0];
  if (best3) {
    console.log(`\nBest 3-feature combo: ${best3.features.join(' + ')}`);
    console.log(`  Win rate: ${formatPct(best3.winRate)} on ${best3.count} swings (+${formatPct(best3.lift)} lift)`);
  }

  // Save results
  const outputData = {
    config: { startDate: startDateStr, endDate: endDateStr, lookback: LOOKBACK,
      maxStop: MAX_STOP, mfeThreshold: MFE_THRESHOLD },
    summary: { totalSwings: swingEvents.length, winners: winners.length, baseWinRate: baseWR },
    featureRanking: featureResults,
    topCombinations: combos.slice(0, 50),
    events: swingEvents.map(e => ({
      timestamp: new Date(e.swing.timestamp).toISOString(),
      type: e.type,
      swingPrice: e.result.swingPrice,
      entryPrice: e.result.entryPrice,
      mfe: e.result.mfe,
      winner: e.winner,
      session: e.result.session,
      features: e.features,
    })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
  console.log(`Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
