/**
 * Overnight Overextension Fade Research (v2)
 *
 * Core idea: Quantitatively measure how "stretched" overnight NQ is using
 * multiple independent overextension signals, then wait for a confirmed
 * rejection candle before fading. No arbitrary range — pure mean-reversion
 * scoring.
 *
 * Overextension components (each scored 0-1, summed into composite):
 *   1. VWAP z-score — |price - VWAP| / stddev (>1.5 = stretched)
 *   2. RSI(6) extreme — below 20 or above 80 on 1m closes
 *   3. Consecutive directional bars — 4+ bars same direction
 *   4. EMA20 deviation — distance from EMA20 in ATR multiples
 *   5. Momentum exhaustion — rate of change over last 10 bars decelerating
 *   6. LT confluence — LT level within N pts on the fade side
 *
 * Rejection confirmation (must occur within N bars of overextension):
 *   - 1m rejection: wick >= 1.5x body on extended side, close reverses
 *   - 3m rejection: aggregate 3 bars, same criteria (smoother)
 *   - Close reclaim: price closes back inside EMA or VWAP after excursion
 *
 * Targets: dynamic — VWAP, EMA20, or fixed pts. Stop: beyond rejection wick.
 *
 * Usage: cd backtest-engine && node research/overnight-range-fade.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));

// ============================================================================
// TIMEZONE
// ============================================================================
function isDST(ms) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m >= 3 && m <= 9) return true;
  if (m === 0 || m === 1 || m === 11) return false;
  if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ms >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); }
  if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ms < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); }
  return false;
}
function toEST(ts) { return ts + (isDST(ts) ? -4 : -5) * 3600000; }
function getESTHour(ts) { const d = new Date(toEST(ts)); return d.getUTCHours() + d.getUTCMinutes() / 60; }
function getESTDateStr(ts) { const d = new Date(toEST(ts)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
function getDayOfWeek(ds) { return new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' }); }

function isRollWeek(ts) {
  const d = new Date(toEST(ts));
  const month = d.getUTCMonth();
  if (month !== 2 && month !== 5 && month !== 8 && month !== 11) return false;
  const day = d.getUTCDate();
  return day >= 7 && day <= 15;
}

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  console.log('Loading data...');
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, { noContinuous: true });
  const { candles: raw } = await csvLoader.loadOHLCVData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  const candles = csvLoader.filterPrimaryContract(raw);
  const ltRecords = await csvLoader.loadLiquidityData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  console.log(`  ${candles.length} candles, ${ltRecords.length} LT records`);
  return { candles, ltRecords };
}

// ============================================================================
// SESSION BUILDER
// ============================================================================
function buildOvernightSessions(candles, ltRecords) {
  const ltByDate = {};
  for (const lt of ltRecords) {
    const d = getESTDateStr(lt.timestamp);
    if (!ltByDate[d]) ltByDate[d] = [];
    ltByDate[d].push(lt);
  }

  const candlesByDate = {};
  for (const c of candles) {
    const d = getESTDateStr(c.timestamp);
    if (!candlesByDate[d]) candlesByDate[d] = [];
    candlesByDate[d].push({ ...c, estHour: getESTHour(c.timestamp) });
  }

  const dates = Object.keys(candlesByDate).sort();
  const sessions = [];

  for (let di = 0; di < dates.length - 1; di++) {
    const today = dates[di], tomorrow = dates[di + 1];
    const dow = getDayOfWeek(today);
    if (['Friday', 'Saturday'].includes(dow)) continue;

    const tc = candlesByDate[today] || [], nc = candlesByDate[tomorrow] || [];
    const overnight = [
      ...tc.filter(c => c.estHour >= 18),
      ...nc.filter(c => c.estHour < 8)
    ].sort((a, b) => a.timestamp - b.timestamp);

    if (overnight.length < 60) continue;
    if (isRollWeek(overnight[0].timestamp)) continue;

    const ltOvernight = [
      ...(ltByDate[today] || []).filter(lt => getESTHour(lt.timestamp) >= 18),
      ...(ltByDate[tomorrow] || []).filter(lt => getESTHour(lt.timestamp) < 8)
    ].sort((a, b) => a.timestamp - b.timestamp);

    sessions.push({ date: today, dayOfWeek: dow, candles: overnight, ltSnapshots: ltOvernight });
  }

  console.log(`  ${sessions.length} overnight sessions\n`);
  return sessions;
}

// ============================================================================
// INDICATOR ENGINE — precompute all indicators for a session
// ============================================================================
function computeIndicators(candles) {
  const n = candles.length;
  const ind = {
    vwap: new Float64Array(n),
    vwapStd: new Float64Array(n),
    vwapZ: new Float64Array(n),
    ema20: new Float64Array(n),
    ema50: new Float64Array(n),
    atr14: new Float64Array(n),
    rsi6: new Float64Array(n),
    consecutiveDir: new Int8Array(n),    // + for up, - for down
    momentum10: new Float64Array(n),     // close[i] - close[i-10]
    momentumAccel: new Float64Array(n),  // momentum change (deceleration)
    emaDevATR: new Float64Array(n),      // |close - ema20| / ATR
  };

  // ── VWAP (session-reset at first candle) ──
  let cumTPV = 0, cumVol = 0, cumSqDev = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    cumTPV += tp * vol;
    cumVol += vol;
    const vwap = cumTPV / cumVol;
    const dev = tp - vwap;
    cumSqDev += dev * dev * vol;
    const std = Math.sqrt(cumSqDev / cumVol);
    ind.vwap[i] = vwap;
    ind.vwapStd[i] = std;
    ind.vwapZ[i] = std > 0.5 ? (c.close - vwap) / std : 0;
  }

  // ── EMAs ──
  const k20 = 2 / 21, k50 = 2 / 51;
  ind.ema20[0] = candles[0].close;
  ind.ema50[0] = candles[0].close;
  for (let i = 1; i < n; i++) {
    ind.ema20[i] = candles[i].close * k20 + ind.ema20[i - 1] * (1 - k20);
    ind.ema50[i] = candles[i].close * k50 + ind.ema50[i - 1] * (1 - k50);
  }

  // ── ATR(14) ──
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    ind.atr14[i] = i < 14
      ? (ind.atr14[i - 1] * (i - 1) + tr) / i
      : ind.atr14[i - 1] + (tr - ind.atr14[i - 1]) / 14;
  }

  // ── RSI(6) ──
  {
    const period = 6;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < n; i++) {
      const delta = candles[i].close - candles[i - 1].close;
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;
      if (i <= period) {
        avgGain += gain / period;
        avgLoss += loss / period;
        ind.rsi6[i] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        ind.rsi6[i] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
      }
    }
  }

  // ── Consecutive directional bars ──
  for (let i = 1; i < n; i++) {
    const dir = candles[i].close > candles[i - 1].close ? 1 : candles[i].close < candles[i - 1].close ? -1 : 0;
    if (dir === 0) {
      ind.consecutiveDir[i] = 0;
    } else if (Math.sign(ind.consecutiveDir[i - 1]) === dir) {
      ind.consecutiveDir[i] = ind.consecutiveDir[i - 1] + dir;
    } else {
      ind.consecutiveDir[i] = dir;
    }
  }

  // ── Momentum and deceleration ──
  for (let i = 10; i < n; i++) {
    ind.momentum10[i] = candles[i].close - candles[i - 10].close;
  }
  for (let i = 11; i < n; i++) {
    ind.momentumAccel[i] = ind.momentum10[i] - ind.momentum10[i - 1];
  }

  // ── EMA deviation in ATR multiples ──
  for (let i = 1; i < n; i++) {
    const atr = ind.atr14[i] || 1;
    ind.emaDevATR[i] = (candles[i].close - ind.ema20[i]) / atr;
  }

  return ind;
}

// ============================================================================
// OVEREXTENSION SCORER
// ============================================================================
// Returns { score: 0-6, direction: 'long'|'short'|null, components: {} }
// 'long' means overextended to the downside → fade long
// 'short' means overextended to the upside → fade short
function scoreOverextension(i, candles, ind, ltLookup, params) {
  const {
    vwapZThresh = 1.5,
    rsiLow = 25,
    rsiHigh = 75,
    consecutiveMin = 4,
    emaDevThresh = 1.5,
    ltProximity = 15,
  } = params;

  let bullScore = 0; // overextended DOWN → want to buy
  let bearScore = 0; // overextended UP → want to sell
  const components = {};

  // 1. VWAP z-score
  const z = ind.vwapZ[i];
  if (z < -vwapZThresh) {
    const s = Math.min(1, (Math.abs(z) - vwapZThresh) / vwapZThresh + 0.5);
    bullScore += s;
    components.vwapZ = -z;
  } else if (z > vwapZThresh) {
    const s = Math.min(1, (z - vwapZThresh) / vwapZThresh + 0.5);
    bearScore += s;
    components.vwapZ = z;
  }

  // 2. RSI(6) extreme
  const rsi = ind.rsi6[i];
  if (rsi < rsiLow) {
    const s = Math.min(1, (rsiLow - rsi) / 20 + 0.5);
    bullScore += s;
    components.rsi = rsi;
  } else if (rsi > rsiHigh) {
    const s = Math.min(1, (rsi - rsiHigh) / 20 + 0.5);
    bearScore += s;
    components.rsi = rsi;
  }

  // 3. Consecutive directional bars
  const consec = ind.consecutiveDir[i];
  if (consec <= -consecutiveMin) {
    const s = Math.min(1, (Math.abs(consec) - consecutiveMin + 1) / 3);
    bullScore += s;
    components.consec = consec;
  } else if (consec >= consecutiveMin) {
    const s = Math.min(1, (consec - consecutiveMin + 1) / 3);
    bearScore += s;
    components.consec = consec;
  }

  // 4. EMA20 deviation in ATR multiples
  const emaDev = ind.emaDevATR[i];
  if (emaDev < -emaDevThresh) {
    const s = Math.min(1, (Math.abs(emaDev) - emaDevThresh) / emaDevThresh + 0.3);
    bullScore += s;
    components.emaDev = emaDev;
  } else if (emaDev > emaDevThresh) {
    const s = Math.min(1, (emaDev - emaDevThresh) / emaDevThresh + 0.3);
    bearScore += s;
    components.emaDev = emaDev;
  }

  // 5. Momentum exhaustion (deceleration in the direction of the move)
  if (i >= 12) {
    const mom = ind.momentum10[i];
    const accel = ind.momentumAccel[i];
    // Overextended down but decelerating (accel positive while mom negative)
    if (mom < -5 && accel > 0) {
      const s = Math.min(1, accel / Math.abs(mom) * 3);
      bullScore += s;
      components.momExhaust = accel;
    }
    // Overextended up but decelerating (accel negative while mom positive)
    if (mom > 5 && accel < 0) {
      const s = Math.min(1, Math.abs(accel) / mom * 3);
      bearScore += s;
      components.momExhaust = accel;
    }
  }

  // 6. LT confluence — level on the fade side within proximity
  const lt = ltLookup[i];
  if (lt) {
    const levels = [lt.level_1, lt.level_2, lt.level_3, lt.level_4, lt.level_5].filter(l => l != null);
    const price = candles[i].close;
    // For bull fade (price extended down): LT level below/near price = support
    const supportLevels = levels.filter(l => l >= price - ltProximity && l <= price + ltProximity * 0.5);
    if (supportLevels.length > 0) {
      bullScore += Math.min(1, supportLevels.length * 0.5);
      components.ltSupport = supportLevels.length;
    }
    // For bear fade (price extended up): LT level above/near price = resistance
    const resistLevels = levels.filter(l => l <= price + ltProximity && l >= price - ltProximity * 0.5);
    if (resistLevels.length > 0) {
      bearScore += Math.min(1, resistLevels.length * 0.5);
      components.ltResist = resistLevels.length;
    }
  }

  const maxScore = Math.max(bullScore, bearScore);
  if (maxScore < 1.5) return { score: 0, direction: null, components };

  return {
    score: maxScore,
    direction: bullScore > bearScore ? 'long' : 'short',
    components,
  };
}

// ============================================================================
// REJECTION DETECTION
// ============================================================================

// Check for rejection on 1m candle at index i
function isRejection1m(i, candles, direction) {
  const c = candles[i];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range < 1) return false; // Need meaningful range

  if (direction === 'long') {
    // Bullish rejection: long lower wick, close > open
    const lowerWick = Math.min(c.open, c.close) - c.low;
    return lowerWick >= 1.5 * body && c.close > c.open && lowerWick >= range * 0.4;
  } else {
    // Bearish rejection: long upper wick, close < open
    const upperWick = c.high - Math.max(c.open, c.close);
    return upperWick >= 1.5 * body && c.close < c.open && upperWick >= range * 0.4;
  }
}

// Build 3m candle from candles[i-2..i] and check rejection
function isRejection3m(i, candles, direction) {
  if (i < 2) return false;
  const c0 = candles[i - 2], c1 = candles[i - 1], c2 = candles[i];
  const open = c0.open;
  const close = c2.close;
  const high = Math.max(c0.high, c1.high, c2.high);
  const low = Math.min(c0.low, c1.low, c2.low);
  const body = Math.abs(close - open);
  const range = high - low;
  if (range < 1.5) return false;

  if (direction === 'long') {
    const lowerWick = Math.min(open, close) - low;
    return lowerWick >= 1.5 * body && close > open && lowerWick >= range * 0.35;
  } else {
    const upperWick = high - Math.max(open, close);
    return upperWick >= 1.5 * body && close < open && upperWick >= range * 0.35;
  }
}

// Close reclaim: price was beyond EMA/VWAP but closed back inside
function isCloseReclaim(i, candles, ind, direction) {
  if (i < 1) return false;
  const prev = candles[i - 1], curr = candles[i];
  const ema = ind.ema20[i], prevEma = ind.ema20[i - 1];

  if (direction === 'long') {
    // Was below EMA, now closed above (reclaiming from below)
    return prev.close < prevEma && curr.close > ema;
  } else {
    // Was above EMA, now closed below (reclaiming from above)
    return prev.close > prevEma && curr.close < ema;
  }
}

// ============================================================================
// BUILD LT LOOKUP
// ============================================================================
function buildLTLookup(candles, ltSnapshots) {
  const lookup = {};
  if (!ltSnapshots || ltSnapshots.length === 0) return lookup;
  let ltIdx = 0;
  for (let i = 0; i < candles.length; i++) {
    while (ltIdx < ltSnapshots.length - 1 && ltSnapshots[ltIdx + 1].timestamp <= candles[i].timestamp) ltIdx++;
    if (ltSnapshots[ltIdx].timestamp <= candles[i].timestamp) lookup[i] = ltSnapshots[ltIdx];
  }
  return lookup;
}

// ============================================================================
// TRADE SIMULATOR
// ============================================================================
function simulateTrade(candles, ind, entryBar, side, params) {
  const { stopPts, targetMode, fixedTarget = 0, trailTrigger = 0, trailOffset = 0, exitHour = 0, maxBars = 600 } = params;
  const entry = candles[entryBar].close;
  const isLong = side === 'long';

  // Dynamic target: distance to VWAP or fixed
  let targetPts;
  if (targetMode === 'vwap') {
    const distToVwap = Math.abs(entry - ind.vwap[entryBar]);
    targetPts = Math.max(8, distToVwap * 0.7); // Capture 70% of the move back to VWAP
  } else if (targetMode === 'ema20') {
    const distToEma = Math.abs(entry - ind.ema20[entryBar]);
    targetPts = Math.max(8, distToEma * 0.7);
  } else {
    targetPts = fixedTarget;
  }

  let stop = isLong ? entry - stopPts : entry + stopPts;
  const target = targetPts > 0 ? (isLong ? entry + targetPts : entry - targetPts) : null;

  let mfe = 0, mae = 0;
  let trailActive = false;

  for (let j = entryBar + 1; j < candles.length && j < entryBar + maxBars; j++) {
    const c = candles[j];

    // Time exit
    if (exitHour > 0 && c.estHour >= exitHour && c.estHour < 18) {
      const pnl = isLong ? c.open - entry : entry - c.open;
      return { pnl, mfe, mae, exit: 'time', bars: j - entryBar, exitBar: j, targetPts };
    }

    // MFE/MAE
    const highPnl = isLong ? c.high - entry : entry - c.low;
    if (highPnl > mfe) mfe = highPnl;
    const adverse = isLong ? entry - c.low : c.high - entry;
    if (adverse > mae) mae = adverse;

    // Trailing stop
    if (trailTrigger > 0 && mfe >= trailTrigger) {
      trailActive = true;
      const hwm = isLong ? entry + mfe : entry - mfe;
      const newTrail = isLong ? hwm - trailOffset : hwm + trailOffset;
      if (isLong && newTrail > stop) stop = newTrail;
      if (!isLong && newTrail < stop) stop = newTrail;
    }

    // Check stop
    if (isLong && c.low <= stop) {
      const exitP = Math.max(stop, c.low);
      return { pnl: exitP - entry, mfe, mae, exit: trailActive ? 'trail' : 'stop', bars: j - entryBar, exitBar: j, targetPts };
    }
    if (!isLong && c.high >= stop) {
      const exitP = Math.min(stop, c.high);
      return { pnl: entry - exitP, mfe, mae, exit: trailActive ? 'trail' : 'stop', bars: j - entryBar, exitBar: j, targetPts };
    }

    // Check target
    if (target) {
      if (isLong && c.high >= target) return { pnl: targetPts, mfe, mae, exit: 'target', bars: j - entryBar, exitBar: j, targetPts };
      if (!isLong && c.low <= target) return { pnl: targetPts, mfe, mae, exit: 'target', bars: j - entryBar, exitBar: j, targetPts };
    }
  }

  const last = candles[Math.min(entryBar + maxBars - 1, candles.length - 1)];
  return { pnl: isLong ? last.close - entry : entry - last.close, mfe, mae, exit: 'end', bars: maxBars, exitBar: candles.length - 1, targetPts };
}

// ============================================================================
// STRATEGY RUNNER
// ============================================================================
function runStrategy(sessions, config) {
  const {
    // Overextension thresholds
    scoreThreshold = 2.5,
    vwapZThresh = 1.5,
    rsiLow = 25,
    rsiHigh = 75,
    consecutiveMin = 4,
    emaDevThresh = 1.5,
    ltProximity = 15,
    // Rejection type: '1m', '3m', 'reclaim', 'any'
    rejectionType = '1m',
    rejectionWindow = 5,  // bars after overextension to wait for rejection
    // Exit management
    stopPts = 15,
    targetMode = 'fixed', // 'fixed', 'vwap', 'ema20'
    fixedTarget = 15,
    trailTrigger = 0,
    trailOffset = 0,
    exitHour = 0,
    // Multi-trade
    maxTradesPerNight = 3,
    cooldownBars = 30,
    // Min bars into session before trading (skip initial noise)
    minSessionBars = 30,
  } = config;

  const allTrades = [];

  for (const session of sessions) {
    const { candles, ltSnapshots } = session;
    if (candles.length < minSessionBars + 30) continue;

    const ind = computeIndicators(candles);
    const ltLookup = buildLTLookup(candles, ltSnapshots);

    let tradesThisNight = 0;
    let lastExitBar = -1;
    let lastTradeBar = -cooldownBars;

    // State for pending rejection
    let pendingOverext = null; // { direction, score, bar, expiresAt }

    for (let i = minSessionBars; i < candles.length - 5; i++) {
      if (tradesThisNight >= maxTradesPerNight) break;
      if (i - lastTradeBar < cooldownBars) continue;
      if (i <= lastExitBar) continue;

      // Check for new overextension
      const ext = scoreOverextension(i, candles, ind, ltLookup, {
        vwapZThresh, rsiLow, rsiHigh, consecutiveMin, emaDevThresh, ltProximity,
      });

      if (ext.score >= scoreThreshold) {
        // New overextension detected — start watching for rejection
        if (!pendingOverext || ext.score > pendingOverext.score) {
          pendingOverext = { direction: ext.direction, score: ext.score, bar: i, expiresAt: i + rejectionWindow, components: ext.components };
        }
      }

      // Check for rejection if we have a pending overextension
      if (pendingOverext && i <= pendingOverext.expiresAt && i >= pendingOverext.bar) {
        const dir = pendingOverext.direction;
        let rejected = false;

        if (rejectionType === '1m') {
          rejected = isRejection1m(i, candles, dir);
        } else if (rejectionType === '3m') {
          rejected = isRejection3m(i, candles, dir);
        } else if (rejectionType === 'reclaim') {
          rejected = isCloseReclaim(i, candles, ind, dir);
        } else if (rejectionType === 'any') {
          rejected = isRejection1m(i, candles, dir) || isRejection3m(i, candles, dir) || isCloseReclaim(i, candles, ind, dir);
        }

        if (rejected) {
          // Enter trade
          const result = simulateTrade(candles, ind, i, dir, {
            stopPts, targetMode, fixedTarget, trailTrigger, trailOffset, exitHour, maxBars: 600,
          });

          allTrades.push({
            ...result,
            date: session.date,
            dayOfWeek: session.dayOfWeek,
            side: dir,
            entryHour: candles[i].estHour,
            entryPrice: candles[i].close,
            overextScore: pendingOverext.score,
            components: pendingOverext.components,
          });

          tradesThisNight++;
          lastTradeBar = i;
          lastExitBar = result.exitBar || (i + result.bars);
          pendingOverext = null;
        }
      }

      // Expire pending if past window
      if (pendingOverext && i > pendingOverext.expiresAt) {
        pendingOverext = null;
      }
    }
  }

  return allTrades;
}

// ============================================================================
// METRICS
// ============================================================================
function m(trades, label) {
  if (!trades.length) return null;
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0), avg = total / trades.length;
  const wr = w.length / trades.length * 100;
  const avgW = w.length ? w.reduce((s, t) => s + t.pnl, 0) / w.length : 0;
  const avgL = l.length ? l.reduce((s, t) => s + t.pnl, 0) / l.length : 0;
  const grossW = w.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(l.reduce((s, t) => s + t.pnl, 0));
  const pf = grossL > 0 ? grossW / grossL : Infinity;
  const std = Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pnl - avg, 2), 0) / trades.length);
  const sharpe = std > 0 ? avg / std : 0;
  const mfe = trades.reduce((s, t) => s + t.mfe, 0) / trades.length;
  const mae = trades.reduce((s, t) => s + t.mae, 0) / trades.length;
  let peak = 0, maxDD = 0, eq = 0;
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); }
  const exits = {}; for (const t of trades) exits[t.exit] = (exits[t.exit] || 0) + 1;
  const nightsWithTrades = new Set(trades.map(t => t.date)).size;
  const avgTargetPts = trades.reduce((s, t) => s + (t.targetPts || 0), 0) / trades.length;
  return { label, n: trades.length, wr, total, avg, avgW, avgL, pf, sharpe, std, mfe, mae, maxDD, eq, exits, nightsWithTrades, avgTargetPts };
}

const EX_ABBR = { stop: 's', target: 'T', trail: 'tr', time: 'ti', end: 'e' };
function row(r) {
  if (!r) return;
  const pfStr = r.pf >= 99 ? '  Inf' : r.pf.toFixed(2).padStart(6);
  const exStr = Object.entries(r.exits).map(([k, v]) => `${EX_ABBR[k] || k[0]}${v}`).join('/');
  console.log(`  ${r.label.padEnd(55)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)}% ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${pfStr} ${r.maxDD.toFixed(0).padStart(6)} ${r.mfe.toFixed(0).padStart(5)}/${r.mae.toFixed(0).padStart(2)} ${exStr.padStart(16)}`);
}

function printHeader() {
  console.log(`  ${'Config'.padEnd(55)} ${'N'.padStart(5)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'MFE/MAE'.padStart(7)} ${'Exits'.padStart(16)}`);
  console.log(`  ${'─'.repeat(55)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(16)}`);
}

function printDetailed(r, trades) {
  if (!r) { console.log('  No trades'); return; }
  console.log(`\n  ═══ ${r.label} ═══`);
  console.log(`  Trades: ${r.n} | WR: ${r.wr.toFixed(1)}% | PF: ${r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)} | Sharpe: ${r.sharpe.toFixed(3)}`);
  console.log(`  Total: ${r.total.toFixed(0)}pts | Avg: ${r.avg.toFixed(1)} | AvgWin: ${r.avgW.toFixed(1)} | AvgLoss: ${r.avgL.toFixed(1)}`);
  console.log(`  MFE: ${r.mfe.toFixed(1)} | MAE: ${r.mae.toFixed(1)} | MaxDD: ${r.maxDD.toFixed(0)} | Equity: ${r.eq.toFixed(0)}`);
  console.log(`  Nights: ${r.nightsWithTrades} | AvgDynTarget: ${r.avgTargetPts.toFixed(1)}pts`);
  console.log(`  Exits: ${Object.entries(r.exits).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  if (!trades || trades.length === 0) return;

  // Monthly
  console.log('\n  Monthly Breakdown:');
  console.log(`  ${'Month'.padEnd(10)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Total'.padStart(8)} ${'Avg'.padStart(7)} ${'AvgScore'.padStart(9)}`);
  console.log(`  ${'─'.repeat(10)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(9)}`);
  const byMonth = {};
  for (const t of trades) { const mo = t.date.substring(0, 7); if (!byMonth[mo]) byMonth[mo] = []; byMonth[mo].push(t); }
  for (const mo of Object.keys(byMonth).sort()) {
    const ts = byMonth[mo], n = ts.length;
    const wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    const avgScore = (ts.reduce((s, t) => s + (t.overextScore || 0), 0) / n).toFixed(1);
    console.log(`  ${mo.padEnd(10)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)} ${avgScore.padStart(9)}`);
  }

  // Day of week
  console.log('\n  Day-of-Week:');
  const byDow = {};
  for (const t of trades) { if (!byDow[t.dayOfWeek]) byDow[t.dayOfWeek] = []; byDow[t.dayOfWeek].push(t); }
  for (const dow of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
    const ts = byDow[dow]; if (!ts) continue;
    const n = ts.length, wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${dow.padEnd(12)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
  }

  // Overextension score buckets
  console.log('\n  By Overextension Score:');
  const scoreBuckets = {};
  for (const t of trades) {
    const bucket = Math.floor(t.overextScore * 2) / 2; // 0.5 increments
    const key = `${bucket.toFixed(1)}+`;
    if (!scoreBuckets[key]) scoreBuckets[key] = [];
    scoreBuckets[key].push(t);
  }
  for (const key of Object.keys(scoreBuckets).sort()) {
    const ts = scoreBuckets[key], n = ts.length;
    if (n < 5) continue;
    const wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const avg = (ts.reduce((s, t) => s + t.pnl, 0) / n).toFixed(1);
    console.log(`    Score ${key.padEnd(6)} ${String(n).padStart(4)} trades  WR: ${wr.padStart(5)}%  Avg: ${avg.padStart(6)}`);
  }

  // Hour of entry
  console.log('\n  By Entry Hour:');
  const hourBuckets = {};
  for (const t of trades) {
    let h = Math.floor(t.entryHour);
    const label = h < 10 ? `${h}:00` : `${h}:00`;
    if (!hourBuckets[label]) hourBuckets[label] = [];
    hourBuckets[label].push(t);
  }
  const sortedHours = Object.keys(hourBuckets).sort((a, b) => {
    const ha = parseInt(a), hb = parseInt(b);
    return (ha < 12 ? ha + 24 : ha) - (hb < 12 ? hb + 24 : hb);
  });
  for (const h of sortedHours) {
    const ts = hourBuckets[h], n = ts.length;
    if (n < 3) continue;
    const wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const avg = (ts.reduce((s, t) => s + t.pnl, 0) / n).toFixed(1);
    console.log(`    ${h.padEnd(7)} ${String(n).padStart(4)} trades  WR: ${wr.padStart(5)}%  Avg: ${avg.padStart(6)}`);
  }

  // Component frequency in winning vs losing trades
  console.log('\n  Component Frequency (winners vs losers):');
  const compNames = ['vwapZ', 'rsi', 'consec', 'emaDev', 'momExhaust', 'ltSupport', 'ltResist'];
  for (const comp of compNames) {
    const wWith = trades.filter(t => t.pnl > 0 && t.components && t.components[comp] !== undefined).length;
    const wTotal = trades.filter(t => t.pnl > 0).length || 1;
    const lWith = trades.filter(t => t.pnl <= 0 && t.components && t.components[comp] !== undefined).length;
    const lTotal = trades.filter(t => t.pnl <= 0).length || 1;
    if (wWith + lWith === 0) continue;
    console.log(`    ${comp.padEnd(14)} Winners: ${(wWith / wTotal * 100).toFixed(0).padStart(3)}% (${wWith}/${wTotal})  Losers: ${(lWith / lTotal * 100).toFixed(0).padStart(3)}% (${lWith}/${lTotal})`);
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT OVEREXTENSION FADE — v2');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { candles, ltRecords } = await loadData();
  const sessions = buildOvernightSessions(candles, ltRecords);

  const allResults = [];
  const collect = (config, label) => {
    const t = runStrategy(sessions, config);
    if (t.length >= 15) {
      const met = m(t, label);
      if (met) { allResults.push({ metrics: met, trades: t, config }); return met; }
    }
    return null;
  };

  // ════════════════════════════════════════════════════════════════════
  // 1. OVEREXTENSION SCORE THRESHOLD SWEEP
  //    (baseline: 1m rejection, fixed 20/20 stop/target)
  // ════════════════════════════════════════════════════════════════════
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  1. SCORE THRESHOLD SWEEP (1m rejection, 20/20)                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  printHeader();
  for (const thresh of [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]) {
    for (const rj of ['1m', '3m', 'any']) {
      const label = `score>=${thresh} rej=${rj} 20/20`;
      const met = collect({ scoreThreshold: thresh, rejectionType: rj, stopPts: 20, fixedTarget: 20 }, label);
      if (met) row(met);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 2. REJECTION TYPE COMPARISON
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  2. REJECTION TYPE COMPARISON (score>=2.5)                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  printHeader();
  for (const rj of ['1m', '3m', 'reclaim', 'any']) {
    for (const rjWin of [3, 5, 8, 12]) {
      const label = `rej=${rj.padEnd(7)} window=${rjWin} 20/20`;
      const met = collect({ scoreThreshold: 2.5, rejectionType: rj, rejectionWindow: rjWin, stopPts: 20, fixedTarget: 20 }, label);
      if (met) row(met);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 3. COMPONENT SENSITIVITY — which components matter most?
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  3. COMPONENT SENSITIVITY (tighten/loosen each component)            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  printHeader();

  // Tighter VWAP z threshold
  for (const vz of [1.0, 1.5, 2.0, 2.5]) {
    const label = `vwapZ>=${vz} (others default) rej=1m 20/20`;
    const met = collect({ scoreThreshold: 2.5, vwapZThresh: vz, rejectionType: '1m', stopPts: 20, fixedTarget: 20 }, label);
    if (met) row(met);
  }
  // RSI thresholds
  for (const [rl, rh] of [[15, 85], [20, 80], [25, 75], [30, 70]]) {
    const label = `rsi=${rl}/${rh} rej=1m 20/20`;
    const met = collect({ scoreThreshold: 2.5, rsiLow: rl, rsiHigh: rh, rejectionType: '1m', stopPts: 20, fixedTarget: 20 }, label);
    if (met) row(met);
  }
  // Consecutive bars
  for (const cm of [3, 4, 5, 6]) {
    const label = `consec>=${cm} rej=1m 20/20`;
    const met = collect({ scoreThreshold: 2.5, consecutiveMin: cm, rejectionType: '1m', stopPts: 20, fixedTarget: 20 }, label);
    if (met) row(met);
  }
  // EMA deviation threshold
  for (const ed of [1.0, 1.5, 2.0, 2.5]) {
    const label = `emaDev>=${ed}ATR rej=1m 20/20`;
    const met = collect({ scoreThreshold: 2.5, emaDevThresh: ed, rejectionType: '1m', stopPts: 20, fixedTarget: 20 }, label);
    if (met) row(met);
  }

  // ════════════════════════════════════════════════════════════════════
  // 4. STOP/TARGET SWEEP — including dynamic targets
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  4. STOP/TARGET SWEEP (fixed + dynamic)                              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  printHeader();

  for (const thresh of [2.5, 3.0, 3.5]) {
    for (const rj of ['1m', '3m']) {
      // Fixed targets
      for (const [sl, tp] of [[10, 15], [15, 15], [15, 20], [15, 25], [20, 20], [20, 25], [20, 30], [25, 25], [25, 30], [25, 35], [30, 30], [30, 40]]) {
        const label = `s>=${thresh} ${rj} ${sl}sl/${tp}tp`;
        const met = collect({ scoreThreshold: thresh, rejectionType: rj, stopPts: sl, fixedTarget: tp }, label);
        if (met) row(met);
      }
      // Dynamic: target = VWAP
      for (const sl of [15, 20, 25, 30]) {
        const label = `s>=${thresh} ${rj} ${sl}sl/vwap`;
        const met = collect({ scoreThreshold: thresh, rejectionType: rj, stopPts: sl, targetMode: 'vwap' }, label);
        if (met) row(met);
      }
      // Dynamic: target = EMA20
      for (const sl of [15, 20, 25, 30]) {
        const label = `s>=${thresh} ${rj} ${sl}sl/ema20`;
        const met = collect({ scoreThreshold: thresh, rejectionType: rj, stopPts: sl, targetMode: 'ema20' }, label);
        if (met) row(met);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 5. TRAILING STOP VARIANTS
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  5. TRAILING STOP (no fixed target, trail only)                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  printHeader();

  for (const thresh of [2.5, 3.0, 3.5]) {
    for (const sl of [20, 25, 30]) {
      for (const [tt, to] of [[10, 6], [12, 6], [12, 8], [15, 8], [15, 10], [20, 10], [20, 12], [25, 12]]) {
        const label = `s>=${thresh} 1m SL${sl} trail@${tt}/${to}`;
        const met = collect({ scoreThreshold: thresh, rejectionType: '1m', stopPts: sl, fixedTarget: 0, trailTrigger: tt, trailOffset: to }, label);
        if (met) row(met);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 6. COMBINED: FIXED TARGET + TRAILING
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  6. TARGET + TRAIL COMBO                                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  printHeader();

  for (const thresh of [2.5, 3.0, 3.5]) {
    for (const [sl, tp] of [[20, 25], [20, 30], [25, 30], [25, 35], [30, 40]]) {
      for (const [tt, to] of [[12, 6], [15, 8], [20, 10]]) {
        const label = `s>=${thresh} 1m ${sl}/${tp} +trail@${tt}/${to}`;
        const met = collect({ scoreThreshold: thresh, rejectionType: '1m', stopPts: sl, fixedTarget: tp, trailTrigger: tt, trailOffset: to }, label);
        if (met) row(met);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 7. MULTI-TRADE PER NIGHT
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  7. MULTI-TRADE PER NIGHT (best configs)                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  printHeader();

  for (const thresh of [2.5, 3.0]) {
    for (const maxT of [1, 2, 3, 5]) {
      for (const cool of [15, 30, 60]) {
        for (const [sl, tp] of [[20, 25], [25, 30]]) {
          const label = `s>=${thresh} 1m ${sl}/${tp} x${maxT} cd${cool}`;
          const met = collect({
            scoreThreshold: thresh, rejectionType: '1m',
            stopPts: sl, fixedTarget: tp,
            maxTradesPerNight: maxT, cooldownBars: cool,
          }, label);
          if (met) row(met);
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 8. TIME EXIT SWEEP
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  8. TIME EXIT VARIANTS                                               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  printHeader();

  for (const thresh of [2.5, 3.0]) {
    for (const [sl, tp] of [[20, 25], [25, 30]]) {
      for (const eh of [0, 2, 4, 6, 8]) {
        const ehLabel = eh === 0 ? 'none' : `${eh}AM`;
        const label = `s>=${thresh} 1m ${sl}/${tp} exit=${ehLabel}`;
        const met = collect({ scoreThreshold: thresh, rejectionType: '1m', stopPts: sl, fixedTarget: tp, exitHour: eh }, label);
        if (met) row(met);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // LEADERBOARDS
  // ════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(75));
  console.log('  LEADERBOARDS');
  console.log('═'.repeat(75));

  const all = allResults.map(r => r.metrics).filter(r => r.n >= 20);

  // Deduplicate: keep only best Sharpe for identical labels
  const seen = new Map();
  for (const r of all) {
    if (!seen.has(r.label) || r.sharpe > seen.get(r.label).sharpe) seen.set(r.label, r);
  }
  const deduped = Array.from(seen.values());

  deduped.sort((a, b) => b.sharpe - a.sharpe);
  console.log(`\n  TOP 30 BY SHARPE [${deduped.length} unique configs]`);
  printHeader();
  for (let i = 0; i < Math.min(30, deduped.length); i++) row(deduped[i]);

  deduped.sort((a, b) => b.total - a.total);
  console.log(`\n  TOP 20 BY TOTAL PNL`);
  printHeader();
  for (let i = 0; i < Math.min(20, deduped.length); i++) row(deduped[i]);

  deduped.sort((a, b) => b.avg - a.avg);
  console.log(`\n  TOP 20 BY AVG PNL/TRADE`);
  printHeader();
  for (let i = 0; i < Math.min(20, deduped.length); i++) row(deduped[i]);

  // ════════════════════════════════════════════════════════════════════
  // DETAILED ANALYSIS OF TOP 3
  // ════════════════════════════════════════════════════════════════════
  deduped.sort((a, b) => b.sharpe - a.sharpe);
  for (let rank = 0; rank < Math.min(3, deduped.length); rank++) {
    const best = deduped[rank];
    const bestEntry = allResults.find(r => r.metrics.label === best.label);
    if (bestEntry) {
      console.log(`\n${'─'.repeat(75)}`);
      console.log(`  RANK #${rank + 1} DETAILED ANALYSIS`);
      printDetailed(best, bestEntry.trades);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  SWEEP COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
