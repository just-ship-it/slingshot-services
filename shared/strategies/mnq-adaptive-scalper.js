/**
 * MNQ Adaptive Scalper Strategy — Live Implementation
 *
 * Ported from backtest engine v11e (Mode C — limit orders at structural levels).
 * Places ONE limit order at the best available level, cycling through opportunities.
 * Tradovate handles bracket exits (stop + target + trailing stop) natively.
 *
 * Level types (19 total, priority order):
 *   Round numbers (100pt, 50pt, 12.5pt) → PDH/PDL → ORB → IB → VWAP → PDC/PDM → ON-H/ON-L
 *
 * Backtest results (Jan 2024 – Sep 2025):
 *   PF=131.21, WR=99.7%, 434/434 traded days hitting $100+ target
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

// ============================================================
// TIMEZONE HELPERS
// ============================================================

function estOffset(d) {
  const m = d.getUTCMonth(), day = d.getUTCDate(), h = d.getUTCHours();
  let edt = m > 2 && m < 10;
  if (m === 2) {
    const f = new Date(Date.UTC(d.getUTCFullYear(), 2, 1)).getUTCDay();
    const sd = f === 0 ? 8 : 15 - f;
    if (day > sd || (day === sd && h >= 7)) edt = true;
  }
  if (m === 10) {
    const f = new Date(Date.UTC(d.getUTCFullYear(), 10, 1)).getUTCDay();
    const fs = f === 0 ? 1 : 8 - f;
    if (day < fs || (day === fs && h < 6)) edt = true;
  }
  return edt ? 4 : 5;
}

function toEST(d) {
  const o = estOffset(d);
  const ms = d.getTime() - o * 3600000;
  const e = new Date(ms);
  return {
    h: e.getUTCHours(),
    m: e.getUTCMinutes(),
    t: e.getUTCHours() + e.getUTCMinutes() / 60,
    d: e.toISOString().slice(0, 10),
    dow: e.getUTCDay(),
    ms
  };
}

function tradingDay(d) {
  const e = toEST(d);
  if (e.h >= 18) {
    const n = new Date(e.ms + 86400000);
    return n.toISOString().slice(0, 10);
  }
  return e.d;
}

function weekKey(d) {
  const td = tradingDay(d);
  const dt = new Date(td + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
  return dt.toISOString().slice(0, 10);
}

// ============================================================
// VWAP CALCULATOR
// ============================================================

function computeVWAP(candles) {
  let tp = 0, vol = 0;
  for (const c of candles) {
    tp += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? tp / vol : null;
}

// ============================================================
// CME HOLIDAY CALENDAR
// ============================================================

function getEaster(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

function getCMEHolidays(year) {
  const holidays = new Set();

  const nthDay = (y, m, dow, n) => {
    const d = new Date(Date.UTC(y, m, 1));
    let count = 0;
    while (count < n) {
      if (d.getUTCDay() === dow) count++;
      if (count < n) d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.toISOString().slice(0, 10);
  };

  const lastDay = (y, m, dow) => {
    const d = new Date(Date.UTC(y, m + 1, 0));
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  // New Year's Day
  holidays.add(`${year}-01-01`);
  // MLK Day — 3rd Monday of January
  holidays.add(nthDay(year, 0, 1, 3));
  // Presidents' Day — 3rd Monday of February
  holidays.add(nthDay(year, 1, 1, 3));
  // Good Friday
  const easter = getEaster(year);
  const gf = new Date(easter);
  gf.setUTCDate(gf.getUTCDate() - 2);
  holidays.add(gf.toISOString().slice(0, 10));
  // Memorial Day — last Monday of May
  holidays.add(lastDay(year, 4, 1));
  // Juneteenth — June 19 (observed)
  let jt = new Date(Date.UTC(year, 5, 19));
  if (jt.getUTCDay() === 0) jt.setUTCDate(20);
  if (jt.getUTCDay() === 6) jt.setUTCDate(18);
  holidays.add(jt.toISOString().slice(0, 10));
  // Independence Day — July 4 (observed)
  let id = new Date(Date.UTC(year, 6, 4));
  if (id.getUTCDay() === 0) id.setUTCDate(5);
  if (id.getUTCDay() === 6) id.setUTCDate(3);
  holidays.add(id.toISOString().slice(0, 10));
  // Day before July 4 if weekday
  if (id.getUTCDay() >= 1 && id.getUTCDay() <= 5) {
    const id3 = new Date(Date.UTC(year, 6, 3));
    if (id3.getUTCDay() >= 1 && id3.getUTCDay() <= 5) holidays.add(id3.toISOString().slice(0, 10));
  }
  // Labor Day — 1st Monday of September
  holidays.add(nthDay(year, 8, 1, 1));
  // Thanksgiving — 4th Thursday of November
  holidays.add(nthDay(year, 10, 4, 4));
  // Day after Thanksgiving
  const thx = new Date(nthDay(year, 10, 4, 4) + 'T00:00:00Z');
  thx.setUTCDate(thx.getUTCDate() + 1);
  holidays.add(thx.toISOString().slice(0, 10));
  // Christmas Eve if weekday
  const xev = new Date(Date.UTC(year, 11, 24));
  if (xev.getUTCDay() >= 1 && xev.getUTCDay() <= 5) holidays.add(xev.toISOString().slice(0, 10));
  // Christmas Day
  holidays.add(`${year}-12-25`);

  return holidays;
}

// Pre-build holiday set for current ± 1 year
const CME_HOLIDAYS = new Set();
const currentYear = new Date().getUTCFullYear();
for (let y = currentYear - 1; y <= currentYear + 1; y++) {
  for (const d of getCMEHolidays(y)) CME_HOLIDAYS.add(d);
}

// ============================================================
// STRATEGY CLASS
// ============================================================

export class MnqAdaptiveScalperStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { quoteSymbols: ['CME_MINI:NQ1!'], baseSymbol: 'NQ' },
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Exit parameters
      stopPoints: 10,        // 10pt stop (sprint/ultra-sprint mode)
      targetPoints: 50,      // 50pt profit target
      trailingTrigger: 3,    // Activate trailing at +3pts
      trailingOffset: 1,     // 1pt trail behind HWM

      // Risk management
      dailyLossLimit: -25,   // Points — halt trading for the day
      dailyTarget: 50,       // Points — halt trading for the day (target hit)
      weeklyMaxLossDays: 1,  // Halt for the week after N losing days

      // Entry parameters
      proximity: 3,          // Points from level to trigger signal
      maxDistance: 80,        // Max distance from level to place limit
      minDistance: 1,         // Min distance from level (avoid immediate fills)

      // Signal management
      signalCooldownMs: 60000,   // 60 seconds between signals
      orderTimeoutCandles: 3,    // Cancel unfilled orders after 3 candles

      // ORB/IB timing (in 1m RTH candle count)
      orbCandles: 15,        // 15 minutes = first 15 RTH candles (half ORB)
      ibCandles: 30,         // 30 minutes = first 30 RTH candles (half IB)

      // Last entry time (EST decimal) — 3:55 PM
      lastEntryTime: 15.917,

      // Symbol configuration
      tradingSymbol: 'MNQH6',
      defaultQuantity: 1,

      // Debug
      debug: true
    };

    this.params = { ...this.defaultParams, ...params };

    // === Historical data seeding flag ===
    this._historicalDataSeeded = false;

    // === Daily state (reset each trading day) ===
    this.rthCandles = [];
    this.overnightCandles = [];
    this.pdh = null;
    this.pdl = null;
    this.pdc = null;
    this.pdm = null;
    this.onH = null;
    this.onL = null;
    this.orbHigh = null;
    this.orbLow = null;
    this.orbComplete = false;
    this.ibHigh = null;
    this.ibLow = null;
    this.ibComplete = false;
    this.rthOpen = null;

    this.levelBroken = {};
    this.dayPnL = 0;
    this.dayTradeCount = 0;
    this.tradingHalted = false;
    this.dayTargetHit = false;

    // === Weekly state ===
    this.currentWeek = null;
    this.weekLossDays = 0;
    this.weekHalted = false;

    // === Tracking ===
    this.currentDay = null;
    this.prevRthCandles = [];
    this.candles = [];       // Rolling buffer for general use
    this.maxBuf = 250;
  }

  /**
   * Main evaluation entry point — called on each 1m candle close.
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = this.params.debug;

    if (!isValidCandle(candle)) return null;

    const ts = new Date(candle.timestamp);
    const e = toEST(ts);
    const td = tradingDay(ts);
    const wk = weekKey(ts);

    // === Week transition ===
    if (wk !== this.currentWeek) {
      this.currentWeek = wk;
      this.weekLossDays = 0;
      this.weekHalted = false;
      if (debug) console.log(`[MNQ_SCALPER] New week: ${wk}`);
    }

    // === Day transition ===
    if (td !== this.currentDay) {
      this._onNewDay(td, debug);
    }

    // === Update candle buffers ===
    this.candles.push(candle);
    if (this.candles.length > this.maxBuf) this.candles.shift();

    const rth = e.t >= 9.5 && e.t < 16;
    const overnight = e.t >= 18 || e.t < 9.5;

    if (rth) {
      this.rthCandles.push(candle);
      if (this.rthOpen === null) this.rthOpen = candle.open;

      // ORB calculation (first 15 RTH candles = first 15 minutes)
      if (!this.orbComplete && this.rthCandles.length <= this.params.orbCandles) {
        this.orbHigh = this.orbHigh === null ? candle.high : Math.max(this.orbHigh, candle.high);
        this.orbLow = this.orbLow === null ? candle.low : Math.min(this.orbLow, candle.low);
        if (this.rthCandles.length === this.params.orbCandles) {
          this.orbComplete = true;
          if (debug) console.log(`[MNQ_SCALPER] ORB complete: H=${roundTo(this.orbHigh)} L=${roundTo(this.orbLow)}`);
        }
      }

      // IB calculation (first 30 RTH candles = first 30 minutes)
      if (!this.ibComplete && this.rthCandles.length <= this.params.ibCandles) {
        this.ibHigh = this.ibHigh === null ? candle.high : Math.max(this.ibHigh, candle.high);
        this.ibLow = this.ibLow === null ? candle.low : Math.min(this.ibLow, candle.low);
        if (this.rthCandles.length === this.params.ibCandles) {
          this.ibComplete = true;
          if (debug) console.log(`[MNQ_SCALPER] IB complete: H=${roundTo(this.ibHigh)} L=${roundTo(this.ibLow)}`);
        }
      }
    } else if (overnight) {
      this.overnightCandles.push(candle);
    }

    // === Gates ===
    if (this.tradingHalted) {
      if (debug && this.dayTradeCount === 0) {
        // Only log once to avoid spam
      }
      return null;
    }
    if (this.weekHalted) return null;
    if (this.dayTargetHit) return null;

    // CME holiday
    if (CME_HOLIDAYS.has(td)) return null;

    // RTH only (9:30 AM – 3:55 PM ET)
    if (!rth) return null;
    if (e.t >= this.params.lastEntryTime) return null;

    // Weekend
    if (e.dow === 0 || e.dow === 6) return null;

    // Need some candle history
    if (this.candles.length < 30) return null;

    // Cooldown check
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) return null;

    // === Compute levels and find best ===
    const price = candle.close;
    const levels = this._computeLevels(price, e);

    if (levels.length === 0) return null;

    // Filter by proximity and broken status, then sort by priority
    const candidates = levels
      .filter(lvl => {
        const dist = Math.abs(price - lvl.price);
        if (dist < this.params.minDistance || dist > this.params.maxDistance) return false;
        if (this.levelBroken[lvl.category]) return false;

        // Side check: for longs, price should be above level; for shorts, below
        if (lvl.side === 'buy' && price <= lvl.price + this.params.minDistance) return false;
        if (lvl.side === 'sell' && price >= lvl.price - this.params.minDistance) return false;

        return true;
      })
      .sort((a, b) => {
        // Primary sort: proximity to price (within max distance)
        // Secondary sort: priority (lower = better)
        const distA = Math.abs(price - a.price);
        const distB = Math.abs(price - b.price);

        // Prefer levels within proximity threshold (close enough for limit order)
        const closeA = distA <= this.params.proximity;
        const closeB = distB <= this.params.proximity;

        if (closeA && !closeB) return -1;
        if (!closeA && closeB) return 1;

        // Among close levels, prefer higher priority
        if (closeA && closeB) return a.priority - b.priority;

        // Among far levels, prefer closer distance
        return distA - distB;
      });

    if (candidates.length === 0) {
      if (debug && this.rthCandles.length % 30 === 0) {
        console.log(`[MNQ_SCALPER] No candidates: ${levels.length} levels computed, price=${roundTo(price)}`);
      }
      return null;
    }

    const best = candidates[0];
    const distToBest = Math.abs(price - best.price);

    // Only signal if level is within proximity (close enough for a limit to fill soon)
    if (distToBest > this.params.proximity) {
      return null;
    }

    if (debug) {
      console.log(`[MNQ_SCALPER] SIGNAL: ${best.side.toUpperCase()} @ ${roundTo(best.price)} (${best.type}), ` +
        `dist=${roundTo(distToBest)}, dayPnL=${roundTo(this.dayPnL)}, trades=${this.dayTradeCount}`);
    }

    this.updateLastSignalTime(candle.timestamp);
    this.dayTradeCount++;

    return this._generateSignal(candle, best);
  }

  /**
   * Called by multi-strategy-engine when a position closes.
   * Tracks daily P&L and enforces loss limits.
   */
  onPositionClosed(closeData) {
    const { pnl, timestamp } = closeData;
    const debug = this.params.debug;

    this.dayPnL += pnl;

    if (debug) {
      console.log(`[MNQ_SCALPER] Position closed: P&L=${roundTo(pnl)}pts, dayPnL=${roundTo(this.dayPnL)}pts, trades=${this.dayTradeCount}`);
    }

    // Mark level as broken on real losses (> 1pt)
    if (pnl < -1 && closeData.metadata?.levelCategory) {
      this.levelBroken[closeData.metadata.levelCategory] = true;
      if (debug) console.log(`[MNQ_SCALPER] Level category broken: ${closeData.metadata.levelCategory}`);
    }

    // Daily loss limit
    if (this.dayPnL <= this.params.dailyLossLimit) {
      this.tradingHalted = true;
      if (debug) console.log(`[MNQ_SCALPER] DAILY LOSS LIMIT HIT: ${roundTo(this.dayPnL)}pts`);
    }

    // Daily target hit
    if (this.dayPnL >= this.params.dailyTarget) {
      this.dayTargetHit = true;
      if (debug) console.log(`[MNQ_SCALPER] DAILY TARGET HIT: ${roundTo(this.dayPnL)}pts`);
    }
  }

  // ============================================================
  // HISTORICAL DATA SEEDING (for mid-day restarts)
  // ============================================================

  /**
   * Seed strategy state from data-service candle history.
   * Fetches daily candles for PDH/PDL/PDC and 1m candles
   * for current-day ORB/IB/VWAP/ON levels.
   *
   * @param {string} dataServiceUrl - e.g. 'http://localhost:3019'
   */
  async seedHistoricalData(dataServiceUrl) {
    const debug = this.params.debug;
    if (debug) console.log('[MNQ_SCALPER] Seeding historical data from data-service...');

    // --- 1. Fetch daily candles for PDH/PDL/PDC ---
    try {
      const dailyData = await this._fetchWithRetry(
        `${dataServiceUrl}/candles/daily?symbol=NQ&count=5`,
        'daily candles'
      );
      const dailyCandles = dailyData?.candles || [];

      if (dailyCandles.length >= 2) {
        // TradingView daily candles use 6 PM ET session boundaries — last completed is prior day
        // Sort by timestamp ascending, take second-to-last (prior completed day)
        dailyCandles.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // The last candle may be "today" (forming), prior one is yesterday's completed daily
        const priorDay = dailyCandles[dailyCandles.length - 2];
        this.pdh = priorDay.high;
        this.pdl = priorDay.low;
        this.pdc = priorDay.close;
        this.pdm = (this.pdh + this.pdl) / 2;

        if (debug) {
          console.log(`[MNQ_SCALPER] Seeded PDH=${roundTo(this.pdh)} PDL=${roundTo(this.pdl)} ` +
            `PDC=${roundTo(this.pdc)} PDM=${roundTo(this.pdm)} from daily candles (${dailyCandles.length} bars)`);
        }
      } else if (debug) {
        console.log(`[MNQ_SCALPER] Insufficient daily candles for PDH/PDL (got ${dailyCandles.length})`);
      }
    } catch (err) {
      if (debug) console.log(`[MNQ_SCALPER] Failed to seed daily candles: ${err.message}`);
    }

    // --- 2. Fetch 1m candles for current-day state (ORB, IB, VWAP, ON levels) ---
    try {
      const minuteData = await this._fetchWithRetry(
        `${dataServiceUrl}/candles?symbol=NQ&count=500`,
        '1m candles'
      );
      const minuteCandles = minuteData?.candles || [];

      if (minuteCandles.length > 0) {
        // Sort ascending by timestamp
        minuteCandles.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Determine current trading day
        const now = new Date();
        const currentTD = tradingDay(now);

        // Set current day before processing
        if (!this.currentDay) {
          this.currentDay = currentTD;
          if (CME_HOLIDAYS.has(currentTD)) {
            this.tradingHalted = true;
          }
        }

        // Set the week
        const wk = weekKey(now);
        if (!this.currentWeek) {
          this.currentWeek = wk;
        }

        // Process each candle to rebuild RTH/overnight buffers
        let rthCount = 0, onCount = 0;
        for (const c of minuteCandles) {
          const ts = new Date(c.timestamp);
          const td = tradingDay(ts);

          // Only process candles from the current trading day
          if (td !== currentTD) continue;

          const e = toEST(ts);
          const rth = e.t >= 9.5 && e.t < 16;
          const overnight = e.t >= 18 || e.t < 9.5;

          // Add to rolling buffer
          this.candles.push(c);

          if (rth) {
            this.rthCandles.push(c);
            rthCount++;

            if (this.rthOpen === null) this.rthOpen = c.open;

            // ORB
            if (!this.orbComplete && this.rthCandles.length <= this.params.orbCandles) {
              this.orbHigh = this.orbHigh === null ? c.high : Math.max(this.orbHigh, c.high);
              this.orbLow = this.orbLow === null ? c.low : Math.min(this.orbLow, c.low);
              if (this.rthCandles.length === this.params.orbCandles) this.orbComplete = true;
            }

            // IB
            if (!this.ibComplete && this.rthCandles.length <= this.params.ibCandles) {
              this.ibHigh = this.ibHigh === null ? c.high : Math.max(this.ibHigh, c.high);
              this.ibLow = this.ibLow === null ? c.low : Math.min(this.ibLow, c.low);
              if (this.rthCandles.length === this.params.ibCandles) this.ibComplete = true;
            }
          } else if (overnight) {
            this.overnightCandles.push(c);
            onCount++;
          }
        }

        // Trim rolling buffer
        while (this.candles.length > this.maxBuf) this.candles.shift();

        // Compute ON-H/ON-L from overnight candles
        if (this.overnightCandles.length > 0) {
          this.onH = Math.max(...this.overnightCandles.map(c => c.high));
          this.onL = Math.min(...this.overnightCandles.map(c => c.low));
        }

        if (debug) {
          console.log(`[MNQ_SCALPER] Seeded from ${minuteCandles.length} 1m candles: ` +
            `${rthCount} RTH, ${onCount} ON candles for ${currentTD}`);
          if (this.orbComplete) console.log(`[MNQ_SCALPER]   ORB: H=${roundTo(this.orbHigh)} L=${roundTo(this.orbLow)}`);
          if (this.ibComplete) console.log(`[MNQ_SCALPER]   IB: H=${roundTo(this.ibHigh)} L=${roundTo(this.ibLow)}`);
          if (this.onH !== null) console.log(`[MNQ_SCALPER]   ON: H=${roundTo(this.onH)} L=${roundTo(this.onL)}`);
          if (this.rthCandles.length > 15) {
            const vw = computeVWAP(this.rthCandles);
            if (vw) console.log(`[MNQ_SCALPER]   VWAP: ${roundTo(vw)}`);
          }
        }
      } else if (debug) {
        console.log('[MNQ_SCALPER] No 1m candles available from data-service');
      }
    } catch (err) {
      if (debug) console.log(`[MNQ_SCALPER] Failed to seed 1m candles: ${err.message}`);
    }

    // If daily candles didn't provide PDH/PDL, derive from 1m history
    if (this.pdh === null) {
      try {
        const minuteData = await this._fetchWithRetry(
          `${dataServiceUrl}/candles?symbol=NQ&count=500`,
          '1m candles for PDH/PDL fallback'
        );
        const minuteCandles = minuteData?.candles || [];
        if (minuteCandles.length > 0) {
          this._derivePriorDayFromMinuteCandles(minuteCandles);
        }
      } catch (err) {
        if (debug) console.log(`[MNQ_SCALPER] PDH/PDL 1m fallback failed: ${err.message}`);
      }
    }

    this._historicalDataSeeded = true;
    this.seeded = true;
    if (debug) console.log('[MNQ_SCALPER] Historical data seeding complete');
  }

  /**
   * Fetch with retry (exponential backoff).
   * Data-service may still be loading history on startup.
   */
  async _fetchWithRetry(url, label, retries = 5, delayMs = 3000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (err) {
        if (attempt < retries) {
          const debug = this.params.debug;
          if (debug) console.log(`[MNQ_SCALPER] ${label} not ready (attempt ${attempt}/${retries}): ${err.message} — retrying in ${delayMs / 1000}s`);
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Whether historical data has been seeded (PDH/PDL/PDC from daily or 1m candles).
   * Used by multi-strategy-engine to gate evaluation until data is ready.
   */
  isSeeded() {
    return this._historicalDataSeeded;
  }

  /**
   * Derive PDH/PDL/PDC from 1m candle history when daily candles are unavailable.
   * Groups candles by trading day (6 PM ET cutoff), finds most recent completed
   * trading day's RTH candles, computes levels.
   */
  _derivePriorDayFromMinuteCandles(candles) {
    const debug = this.params.debug;
    if (!candles || candles.length === 0) return;

    // Sort ascending
    candles.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Group candles by trading day
    const dayBuckets = new Map();
    for (const c of candles) {
      const ts = new Date(c.timestamp);
      const td = tradingDay(ts);
      if (!dayBuckets.has(td)) dayBuckets.set(td, []);
      dayBuckets.get(td).push(c);
    }

    const now = new Date();
    const currentTD = tradingDay(now);
    const sortedDays = [...dayBuckets.keys()].sort();

    // Find the most recent completed trading day (not today)
    const priorDays = sortedDays.filter(d => d < currentTD);
    if (priorDays.length === 0) {
      if (debug) console.log('[MNQ_SCALPER] No prior trading day in 1m candle history for PDH/PDL fallback');
      return;
    }

    const priorDay = priorDays[priorDays.length - 1];
    const priorCandles = dayBuckets.get(priorDay);

    // Filter to RTH candles only (9:30-16:00 ET)
    const rthCandles = priorCandles.filter(c => {
      const e = toEST(new Date(c.timestamp));
      return e.t >= 9.5 && e.t < 16;
    });

    if (rthCandles.length > 0) {
      this.pdh = Math.max(...rthCandles.map(c => c.high));
      this.pdl = Math.min(...rthCandles.map(c => c.low));
      this.pdc = rthCandles[rthCandles.length - 1].close;
      this.pdm = (this.pdh + this.pdl) / 2;

      if (debug) {
        console.log(`[MNQ_SCALPER] PDH/PDL derived from ${rthCandles.length} RTH 1m candles (${priorDay}): ` +
          `PDH=${roundTo(this.pdh)} PDL=${roundTo(this.pdl)} PDC=${roundTo(this.pdc)} PDM=${roundTo(this.pdm)}`);
      }
    }

    // Also populate ON-H/ON-L from overnight candles of current day
    const todayCandles = dayBuckets.get(currentTD) || [];
    const onCandles = todayCandles.filter(c => {
      const e = toEST(new Date(c.timestamp));
      return e.t >= 18 || e.t < 9.5;
    });

    if (onCandles.length > 0 && this.onH === null) {
      this.onH = Math.max(...onCandles.map(c => c.high));
      this.onL = Math.min(...onCandles.map(c => c.low));
      if (debug) {
        console.log(`[MNQ_SCALPER] ON levels derived from ${onCandles.length} overnight 1m candles: ` +
          `ON-H=${roundTo(this.onH)} ON-L=${roundTo(this.onL)}`);
      }
    }
  }

  // ============================================================
  // LEVEL COMPUTATION
  // ============================================================

  /**
   * Compute all available levels with side and priority.
   * Returns array of { price, type, category, side, priority }
   */
  _computeLevels(price, est) {
    const levels = [];

    // --- Round number levels (priority 1) ---
    // Nearest 100-pt levels above and below
    const rn100Below = Math.floor(price / 100) * 100;
    const rn100Above = Math.ceil(price / 100) * 100;
    if (rn100Below !== rn100Above) {
      levels.push({ price: rn100Below, type: 'rn100', category: 'rnl', side: 'buy', priority: 1 });
      levels.push({ price: rn100Above, type: 'rn100', category: 'rns', side: 'sell', priority: 1 });
    }
    // One more level in each direction
    levels.push({ price: rn100Below - 100, type: 'rn100', category: 'rnl', side: 'buy', priority: 1 });
    levels.push({ price: rn100Above + 100, type: 'rn100', category: 'rns', side: 'sell', priority: 1 });

    // --- Half-round levels at 50-pt (priority 2) ---
    const rn50Below = Math.floor(price / 50) * 50;
    const rn50Above = Math.ceil(price / 50) * 50;
    // Only add if they're not already a 100-pt level
    if (rn50Below % 100 !== 0) {
      levels.push({ price: rn50Below, type: 'rn50', category: 'rnl2', side: 'buy', priority: 2 });
    }
    if (rn50Above % 100 !== 0 && rn50Above !== rn50Below) {
      levels.push({ price: rn50Above, type: 'rn50', category: 'rns2', side: 'sell', priority: 2 });
    }

    // --- 12.5-pt levels (priority 3) ---
    const rn125Below = Math.floor(price / 12.5) * 12.5;
    const rn125Above = Math.ceil(price / 12.5) * 12.5;
    // Only add if not already a 25-pt level
    if (rn125Below % 25 !== 0) {
      levels.push({ price: rn125Below, type: 'rn12.5', category: 'rnl3', side: 'buy', priority: 3 });
    }
    if (rn125Above % 25 !== 0 && rn125Above !== rn125Below) {
      levels.push({ price: rn125Above, type: 'rn12.5', category: 'rns3', side: 'sell', priority: 3 });
    }

    // --- PDH / PDL (priority 4) ---
    if (this.pdh !== null) {
      levels.push({ price: this.pdh, type: 'pdh', category: 'pdh', side: 'sell', priority: 4 });
    }
    if (this.pdl !== null) {
      levels.push({ price: this.pdl, type: 'pdl', category: 'pdl', side: 'buy', priority: 4 });
    }

    // --- ORB High / Low (priority 5, after ORB is complete) ---
    if (this.orbComplete && est.t >= 9.75) {
      if (this.orbHigh !== null) {
        levels.push({ price: this.orbHigh, type: 'orbH', category: 'orbh', side: 'sell', priority: 5 });
      }
      if (this.orbLow !== null) {
        levels.push({ price: this.orbLow, type: 'orbL', category: 'orb', side: 'buy', priority: 5 });
      }
    }

    // --- IB High / Low (priority 6, after IB is complete) ---
    if (this.ibComplete && est.t >= 10) {
      if (this.ibHigh !== null) {
        levels.push({ price: this.ibHigh, type: 'ibH', category: 'ibh', side: 'sell', priority: 6 });
      }
      if (this.ibLow !== null) {
        levels.push({ price: this.ibLow, type: 'ibL', category: 'ib', side: 'buy', priority: 6 });
      }
    }

    // --- VWAP (priority 7) ---
    if (this.rthCandles.length > 15) {
      const vw = computeVWAP(this.rthCandles);
      if (vw !== null) {
        const vwRounded = Math.round(vw * 4) / 4; // Round to NQ tick
        if (price > vw + this.params.proximity) {
          levels.push({ price: vwRounded, type: 'vwap', category: 'vwl', side: 'buy', priority: 7 });
        }
        if (price < vw - this.params.proximity) {
          levels.push({ price: vwRounded, type: 'vwap', category: 'vws', side: 'sell', priority: 7 });
        }
      }
    }

    // --- PDC / PDM (priority 8) ---
    if (this.pdc !== null) {
      levels.push({ price: this.pdc, type: 'pdc', category: 'pdc', side: 'buy', priority: 8 });
    }
    if (this.pdm !== null) {
      // PDM as support (buy) and resistance (sell)
      levels.push({ price: this.pdm, type: 'pdm', category: 'pdm', side: 'buy', priority: 8 });
      levels.push({ price: this.pdm, type: 'pdm', category: 'pdms', side: 'sell', priority: 8 });
    }

    // --- ON-H / ON-L (priority 9) ---
    if (this.onH !== null) {
      levels.push({ price: this.onH, type: 'onH', category: 'onh', side: 'sell', priority: 9 });
    }
    if (this.onL !== null) {
      levels.push({ price: this.onL, type: 'onL', category: 'onl', side: 'buy', priority: 9 });
    }

    // --- Developing Session Low/High (priority 9, after IB) ---
    if (this.ibComplete && this.rthCandles.length > 30) {
      const dsl = Math.min(...this.rthCandles.map(c => c.low));
      const dsh = Math.max(...this.rthCandles.map(c => c.high));
      if (dsl < price - this.params.proximity) {
        levels.push({ price: dsl, type: 'dsl', category: 'dsl', side: 'buy', priority: 9 });
      }
      if (dsh > price + this.params.proximity) {
        levels.push({ price: dsh, type: 'dsh', category: 'dsh', side: 'sell', priority: 9 });
      }
    }

    return levels;
  }

  // ============================================================
  // SIGNAL GENERATION
  // ============================================================

  _generateSignal(candle, level) {
    const entryPrice = level.price;
    const side = level.side;

    const stopLoss = side === 'buy'
      ? entryPrice - this.params.stopPoints
      : entryPrice + this.params.stopPoints;

    const takeProfit = side === 'buy'
      ? entryPrice + this.params.targetPoints
      : entryPrice - this.params.targetPoints;

    return {
      strategy: 'MNQ_ADAPTIVE_SCALPER',
      action: 'place_limit',
      side: side,
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopLoss),
      take_profit: roundTo(takeProfit),
      trailing_trigger: this.params.trailingTrigger,
      trailing_offset: this.params.trailingOffset,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),
      metadata: {
        levelType: level.type,
        levelCategory: level.category,
        levelPrice: roundTo(level.price),
        levelPriority: level.priority,
        dayPnL: roundTo(this.dayPnL),
        dayTradeCount: this.dayTradeCount,
        candle_time: new Date(candle.timestamp).toISOString(),
        entry_reason: `${level.type} ${side} @ ${roundTo(level.price)}`
      }
    };
  }

  // ============================================================
  // DAY MANAGEMENT
  // ============================================================

  _onNewDay(td, debug) {
    // Save prior day levels from RTH buffer
    if (this.rthCandles.length > 0) {
      this.pdh = Math.max(...this.rthCandles.map(c => c.high));
      this.pdl = Math.min(...this.rthCandles.map(c => c.low));
      this.pdc = this.rthCandles[this.rthCandles.length - 1].close;
      this.pdm = (this.pdh + this.pdl) / 2;
      this.prevRthCandles = [...this.rthCandles];

      if (debug) {
        console.log(`[MNQ_SCALPER] Prior day levels: PDH=${roundTo(this.pdh)} PDL=${roundTo(this.pdl)} ` +
          `PDC=${roundTo(this.pdc)} PDM=${roundTo(this.pdm)}`);
      }
    }

    // Save overnight levels
    if (this.overnightCandles.length > 0) {
      this.onH = Math.max(...this.overnightCandles.map(c => c.high));
      this.onL = Math.min(...this.overnightCandles.map(c => c.low));

      if (debug) {
        console.log(`[MNQ_SCALPER] Overnight levels: ON-H=${roundTo(this.onH)} ON-L=${roundTo(this.onL)}`);
      }
    }

    // Track weekly loss days from previous day
    if (this.currentDay && this.dayPnL < -0.5 && this.dayTradeCount > 0) {
      this.weekLossDays++;
      if (this.weekLossDays >= this.params.weeklyMaxLossDays + 1) {
        this.weekHalted = true;
        if (debug) console.log(`[MNQ_SCALPER] WEEKLY HALT: ${this.weekLossDays} losing days`);
      }
    }

    // Reset daily state
    this.currentDay = td;
    this.dayPnL = 0;
    this.dayTradeCount = 0;
    this.tradingHalted = CME_HOLIDAYS.has(td);
    this.dayTargetHit = false;
    this.rthCandles = [];
    this.overnightCandles = [];
    this.orbHigh = null;
    this.orbLow = null;
    this.orbComplete = false;
    this.ibHigh = null;
    this.ibLow = null;
    this.ibComplete = false;
    this.rthOpen = null;
    this.levelBroken = {};
    this.lastSignalTime = 0;

    if (debug) {
      console.log(`[MNQ_SCALPER] New trading day: ${td}` +
        (this.tradingHalted ? ' (CME HOLIDAY - no trading)' : ''));
    }
  }

  // ============================================================
  // OVERRIDES
  // ============================================================

  reset() {
    super.reset();
    this.rthCandles = [];
    this.overnightCandles = [];
    this.pdh = null;
    this.pdl = null;
    this.pdc = null;
    this.pdm = null;
    this.onH = null;
    this.onL = null;
    this.orbHigh = null;
    this.orbLow = null;
    this.orbComplete = false;
    this.ibHigh = null;
    this.ibLow = null;
    this.ibComplete = false;
    this.rthOpen = null;
    this.levelBroken = {};
    this.dayPnL = 0;
    this.dayTradeCount = 0;
    this.tradingHalted = false;
    this.dayTargetHit = false;
    this.currentWeek = null;
    this.weekLossDays = 0;
    this.weekHalted = false;
    this.currentDay = null;
    this.prevRthCandles = [];
    this.candles = [];
  }

  getName() {
    return 'MNQ_ADAPTIVE_SCALPER';
  }

  getDescription() {
    return 'MNQ Adaptive Scalper - limit orders at structural levels (round numbers, PDH/PDL, ORB, IB, VWAP)';
  }

  getRequiredMarketData() {
    return []; // Only needs candle data
  }
}

export default MnqAdaptiveScalperStrategy;
