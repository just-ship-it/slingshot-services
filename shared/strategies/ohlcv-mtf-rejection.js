/**
 * OHLCV Multi-Timeframe Rejection / Reversal Detector v2 - Symmetric R:R
 *
 * Identifies key levels (swings, VWAP, session levels), then watches for
 * rejection patterns (pin bars) at those levels. Enters with fixed symmetric
 * stop:target when the rejection wick provides an aligned stop distance.
 *
 * Signal Logic:
 * - Identify swing highs/lows, VWAP, prior session H/L/C
 * - Detect rejection patterns at these levels:
 *   - Pin bar with body_ratio < 0.3
 *   - Rejection wick >= 3x body (stricter than v1)
 *   - Volume confirmation >= 1.3x average
 * - Entry on close of rejection bar
 * - Stop just beyond the rejection wick tip
 *
 * v2 Changes:
 * - Fixed symmetric stop:target (5/10/15 points configurable)
 * - Only takes trade when wick tip distance aligns with a fixed distance
 * - EMA trend filter for market structure confirmation
 * - Stricter rejection requirements (3x wick:body, 1.3x volume)
 * - No trailing stops (pure 1:1 R:R)
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class OHLCVMTFRejectionStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: true,
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Level identification
      swingLookback: 50,
      swingPivotBars: 5,

      // Rejection pattern detection (stricter than v1)
      wickToBodyRatio: 3.0,
      bodyRatioThreshold: 0.3,
      volumeMultiplier: 1.3,
      volumeLookback: 20,

      // Level proximity
      levelProximityPoints: 5,

      // VWAP and session levels
      useVWAP: true,
      useSessionLevels: true,

      // Symmetric R:R
      fixedDistances: [5, 10, 15],
      distanceTolerance: 2,

      // Market structure (EMA)
      emaPeriodShort: 8,
      emaPeriodLong: 21,
      requireTrendAlignment: false,

      // Exit (symmetric, no trailing)
      useTrailingStop: false,
      maxHoldBars: 30,

      // Directional filter: 'both', 'buy', 'sell'
      sideFilter: 'both',

      // Signal management
      signalCooldownMs: 5 * 60 * 1000,

      // Session filtering
      useSessionFilter: true,
      allowedSessions: ['rth'],
      noEntryFirstMinutes: 15,
      noEntryLastMinutes: 15,

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Stop buffer beyond wick
      stopBuffer: 0.25,

      forceCloseAtMarketClose: true,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Internal state
    this.candleHistory = [];
    this.rollingVolumes = [];
    this.swingHighs = [];
    this.swingLows = [];

    // EMA state
    this.emaShort = null;
    this.emaLong = null;
    this.emaWarmup = 0;

    // VWAP state
    this.vwapState = {
      cumulativeTPV: 0,
      cumulativeVolume: 0,
      currentVWAP: 0,
      lastDate: null
    };

    // Session level tracking
    this.sessionLevels = {
      prevHigh: null,
      prevLow: null,
      prevClose: null,
      currentHigh: -Infinity,
      currentLow: Infinity,
      currentOpen: null,
      lastSessionDate: null
    };
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    if (!isValidCandle(candle) || !isValidCandle(prevCandle)) {
      return null;
    }

    // Check cooldown
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(candle.timestamp)) {
      return null;
    }

    if (this.params.useSessionFilter && this.isNearSessionBoundary(candle.timestamp)) {
      return null;
    }

    // Update candle history
    this.candleHistory.push(candle);
    if (this.candleHistory.length > this.params.swingLookback * 3) {
      this.candleHistory.shift();
    }

    // Update rolling volume
    this.rollingVolumes.push(candle.volume || 0);
    if (this.rollingVolumes.length > this.params.volumeLookback) {
      this.rollingVolumes.shift();
    }

    // Update EMAs
    this.updateEMA(candle.close);

    // Update VWAP
    if (this.params.useVWAP) {
      this.updateVWAP(candle);
    }

    // Update session levels
    if (this.params.useSessionLevels) {
      this.updateSessionLevels(candle);
    }

    // Update swing points
    this.updateSwingPoints();

    if (this.candleHistory.length < this.params.swingPivotBars * 2 + 5) {
      return null;
    }

    const avgVolume = this.rollingVolumes.length >= this.params.volumeLookback
      ? this.rollingVolumes.reduce((a, b) => a + b, 0) / this.rollingVolumes.length
      : 0;

    if (avgVolume <= 0) return null;

    // Collect all HTF key levels
    const keyLevels = this.getKeyLevels();
    if (keyLevels.length === 0) return null;

    // Check for rejection pattern on current candle
    const range = candle.high - candle.low;
    if (range <= 0) return null;

    const body = Math.abs(candle.close - candle.open);
    const bodyRatio = body / range;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const volumeRatio = (candle.volume || 0) / avgVolume;

    const isSmallBody = bodyRatio < this.params.bodyRatioThreshold;
    const hasVolume = volumeRatio >= this.params.volumeMultiplier;

    if (!isSmallBody || !hasVolume) return null;

    // Check for bearish rejection (long upper wick at resistance)
    if (this.params.sideFilter !== 'both' && this.params.sideFilter !== 'sell') {
      // Skip bearish signals
    } else if (upperWick >= body * this.params.wickToBodyRatio && upperWick > lowerWick * 1.5) {
      const nearLevel = this.findNearestLevel(candle.high, keyLevels, this.params.levelProximityPoints);

      if (nearLevel) {
        const entryPrice = candle.close;
        const naturalStop = candle.high + this.params.stopBuffer;
        const naturalDist = naturalStop - entryPrice;

        // Find aligned fixed distance
        const alignedDist = this.findAlignedDistance(naturalDist);
        if (alignedDist === null) {
          if (debug) console.log(`[MTF_REJECTION] Bearish rejected: natural stop ${naturalDist.toFixed(1)}pts doesn't align`);
          return null;
        }

        // EMA trend filter
        if (this.params.requireTrendAlignment && this.getTrend() === 'bullish') {
          if (debug) console.log(`[MTF_REJECTION] Bearish rejected: bullish EMA trend`);
          return null;
        }

        this.updateLastSignalTime(candle.timestamp);

        const stopPrice = entryPrice + alignedDist;
        const targetPrice = entryPrice - alignedDist;

        if (debug) {
          console.log(`[MTF_REJECTION] SELL: wick reached ${nearLevel.type}=${roundTo(nearLevel.price)}, dist=${alignedDist}pt`);
        }

        return {
          strategy: 'OHLCV_MTF_REJECTION',
          side: 'sell',
          action: 'place_market',
          symbol: this.params.tradingSymbol,
          price: roundTo(entryPrice),
          stop_loss: roundTo(stopPrice),
          take_profit: roundTo(targetPrice),
          trailing_trigger: null,
          trailing_offset: null,
          quantity: this.params.defaultQuantity,
          maxHoldBars: this.params.maxHoldBars,
          timestamp: new Date(candle.timestamp).toISOString(),
          metadata: {
            detector: 'mtf_rejection',
            direction: 'bearish',
            level_type: nearLevel.type,
            level_price: roundTo(nearLevel.price),
            level_distance: roundTo(Math.abs(candle.high - nearLevel.price)),
            body_ratio: roundTo(bodyRatio),
            wick_to_body: roundTo(body > 0 ? upperWick / body : Infinity),
            volume_ratio: roundTo(volumeRatio),
            upper_wick: roundTo(upperWick),
            natural_stop_dist: roundTo(naturalDist),
            aligned_dist: alignedDist,
            risk_points: alignedDist,
            ema_trend: this.getTrend(),
            vwap: this.vwapState.currentVWAP ? roundTo(this.vwapState.currentVWAP) : null,
            entry_reason: `Bearish rejection at ${nearLevel.type}=${roundTo(nearLevel.price)}, ${alignedDist}pt symmetric R:R`
          }
        };
      }
    }

    // Check for bullish rejection (long lower wick at support)
    if (this.params.sideFilter !== 'both' && this.params.sideFilter !== 'buy') {
      // Skip bullish signals
    } else if (lowerWick >= body * this.params.wickToBodyRatio && lowerWick > upperWick * 1.5) {
      const nearLevel = this.findNearestLevel(candle.low, keyLevels, this.params.levelProximityPoints);

      if (nearLevel) {
        const entryPrice = candle.close;
        const naturalStop = candle.low - this.params.stopBuffer;
        const naturalDist = entryPrice - naturalStop;

        const alignedDist = this.findAlignedDistance(naturalDist);
        if (alignedDist === null) {
          if (debug) console.log(`[MTF_REJECTION] Bullish rejected: natural stop ${naturalDist.toFixed(1)}pts doesn't align`);
          return null;
        }

        if (this.params.requireTrendAlignment && this.getTrend() === 'bearish') {
          if (debug) console.log(`[MTF_REJECTION] Bullish rejected: bearish EMA trend`);
          return null;
        }

        this.updateLastSignalTime(candle.timestamp);

        const stopPrice = entryPrice - alignedDist;
        const targetPrice = entryPrice + alignedDist;

        if (debug) {
          console.log(`[MTF_REJECTION] BUY: wick reached ${nearLevel.type}=${roundTo(nearLevel.price)}, dist=${alignedDist}pt`);
        }

        return {
          strategy: 'OHLCV_MTF_REJECTION',
          side: 'buy',
          action: 'place_market',
          symbol: this.params.tradingSymbol,
          price: roundTo(entryPrice),
          stop_loss: roundTo(stopPrice),
          take_profit: roundTo(targetPrice),
          trailing_trigger: null,
          trailing_offset: null,
          quantity: this.params.defaultQuantity,
          maxHoldBars: this.params.maxHoldBars,
          timestamp: new Date(candle.timestamp).toISOString(),
          metadata: {
            detector: 'mtf_rejection',
            direction: 'bullish',
            level_type: nearLevel.type,
            level_price: roundTo(nearLevel.price),
            level_distance: roundTo(Math.abs(candle.low - nearLevel.price)),
            body_ratio: roundTo(bodyRatio),
            wick_to_body: roundTo(body > 0 ? lowerWick / body : Infinity),
            volume_ratio: roundTo(volumeRatio),
            lower_wick: roundTo(lowerWick),
            natural_stop_dist: roundTo(naturalDist),
            aligned_dist: alignedDist,
            risk_points: alignedDist,
            ema_trend: this.getTrend(),
            vwap: this.vwapState.currentVWAP ? roundTo(this.vwapState.currentVWAP) : null,
            entry_reason: `Bullish rejection at ${nearLevel.type}=${roundTo(nearLevel.price)}, ${alignedDist}pt symmetric R:R`
          }
        };
      }
    }

    return null;
  }

  findAlignedDistance(naturalDist) {
    const distances = this.params.fixedDistances;
    const tolerance = this.params.distanceTolerance;
    let bestDist = null;
    let bestDelta = Infinity;

    for (const d of distances) {
      const delta = Math.abs(naturalDist - d);
      if (delta <= tolerance && delta < bestDelta) {
        bestDist = d;
        bestDelta = delta;
      }
    }

    return bestDist;
  }

  updateEMA(price) {
    this.emaWarmup++;
    if (this.emaShort === null) {
      this.emaShort = price;
      this.emaLong = price;
    } else {
      const alphaShort = 2 / (this.params.emaPeriodShort + 1);
      const alphaLong = 2 / (this.params.emaPeriodLong + 1);
      this.emaShort = price * alphaShort + this.emaShort * (1 - alphaShort);
      this.emaLong = price * alphaLong + this.emaLong * (1 - alphaLong);
    }
  }

  getTrend() {
    if (this.emaWarmup < this.params.emaPeriodLong || this.emaShort === null || this.emaLong === null) return 'neutral';
    if (this.emaShort > this.emaLong) return 'bullish';
    if (this.emaShort < this.emaLong) return 'bearish';
    return 'neutral';
  }

  getKeyLevels() {
    const levels = [];

    for (const sh of this.swingHighs) {
      levels.push({ price: sh.price, type: 'swing_high' });
    }

    for (const sl of this.swingLows) {
      levels.push({ price: sl.price, type: 'swing_low' });
    }

    if (this.params.useVWAP && this.vwapState.currentVWAP > 0) {
      levels.push({ price: this.vwapState.currentVWAP, type: 'vwap' });
    }

    if (this.params.useSessionLevels) {
      if (this.sessionLevels.prevHigh != null) {
        levels.push({ price: this.sessionLevels.prevHigh, type: 'prev_session_high' });
      }
      if (this.sessionLevels.prevLow != null) {
        levels.push({ price: this.sessionLevels.prevLow, type: 'prev_session_low' });
      }
      if (this.sessionLevels.prevClose != null) {
        levels.push({ price: this.sessionLevels.prevClose, type: 'prev_session_close' });
      }
    }

    return levels;
  }

  findNearestLevel(price, levels, maxDistance) {
    let nearest = null;
    let minDist = Infinity;

    for (const level of levels) {
      const dist = Math.abs(price - level.price);
      if (dist <= maxDistance && dist < minDist) {
        nearest = level;
        minDist = dist;
      }
    }

    return nearest;
  }

  updateVWAP(candle) {
    const candleDate = this.getSessionDate(candle.timestamp);

    if (candleDate !== this.vwapState.lastDate) {
      this.vwapState.cumulativeTPV = 0;
      this.vwapState.cumulativeVolume = 0;
      this.vwapState.lastDate = candleDate;
    }

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const volume = candle.volume || 0;

    this.vwapState.cumulativeTPV += typicalPrice * volume;
    this.vwapState.cumulativeVolume += volume;

    if (this.vwapState.cumulativeVolume > 0) {
      this.vwapState.currentVWAP = this.vwapState.cumulativeTPV / this.vwapState.cumulativeVolume;
    }
  }

  updateSessionLevels(candle) {
    const candleDate = this.getSessionDate(candle.timestamp);

    if (candleDate !== this.sessionLevels.lastSessionDate) {
      if (this.sessionLevels.lastSessionDate !== null) {
        this.sessionLevels.prevHigh = this.sessionLevels.currentHigh;
        this.sessionLevels.prevLow = this.sessionLevels.currentLow;
        this.sessionLevels.prevClose = this.candleHistory.length > 1
          ? this.candleHistory[this.candleHistory.length - 2]?.close
          : null;
      }

      this.sessionLevels.currentHigh = candle.high;
      this.sessionLevels.currentLow = candle.low;
      this.sessionLevels.currentOpen = candle.open;
      this.sessionLevels.lastSessionDate = candleDate;
    } else {
      this.sessionLevels.currentHigh = Math.max(this.sessionLevels.currentHigh, candle.high);
      this.sessionLevels.currentLow = Math.min(this.sessionLevels.currentLow, candle.low);
    }
  }

  getSessionDate(timestamp) {
    const date = new Date(timestamp);
    const estDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = estDate.getHours();

    if (hour >= 18) {
      estDate.setDate(estDate.getDate() + 1);
    }
    return estDate.toISOString().split('T')[0];
  }

  updateSwingPoints() {
    const pivotBars = this.params.swingPivotBars;
    const history = this.candleHistory;

    if (history.length < pivotBars * 2 + 1) return;

    const pivotIndex = history.length - 1 - pivotBars;
    const pivotCandle = history[pivotIndex];

    let isSwingHigh = true;
    for (let j = pivotIndex - pivotBars; j <= pivotIndex + pivotBars; j++) {
      if (j === pivotIndex) continue;
      if (j < 0 || j >= history.length) { isSwingHigh = false; break; }
      if (history[j].high >= pivotCandle.high) {
        isSwingHigh = false;
        break;
      }
    }

    if (isSwingHigh) {
      this.swingHighs = this.swingHighs.filter(sh =>
        Math.abs(sh.price - pivotCandle.high) > 3
      );
      this.swingHighs.push({
        price: pivotCandle.high,
        timestamp: pivotCandle.timestamp
      });
      if (this.swingHighs.length > 15) this.swingHighs.shift();
    }

    let isSwingLow = true;
    for (let j = pivotIndex - pivotBars; j <= pivotIndex + pivotBars; j++) {
      if (j === pivotIndex) continue;
      if (j < 0 || j >= history.length) { isSwingLow = false; break; }
      if (history[j].low <= pivotCandle.low) {
        isSwingLow = false;
        break;
      }
    }

    if (isSwingLow) {
      this.swingLows = this.swingLows.filter(sl =>
        Math.abs(sl.price - pivotCandle.low) > 3
      );
      this.swingLows.push({
        price: pivotCandle.low,
        timestamp: pivotCandle.timestamp
      });
      if (this.swingLows.length > 15) this.swingLows.shift();
    }
  }

  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;

    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
    if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
    return 'afterhours';
  }

  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    return this.params.allowedSessions.includes(this.getSession(timestamp));
  }

  isNearSessionBoundary(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const hour = parseInt(hourStr);
    const minute = parseInt(minStr);

    if (hour === 9 && minute >= 30 && minute < 30 + this.params.noEntryFirstMinutes) return true;
    if (hour === 15 && minute >= 60 - this.params.noEntryLastMinutes) return true;

    return false;
  }

  reset() {
    super.reset();
    this.candleHistory = [];
    this.rollingVolumes = [];
    this.swingHighs = [];
    this.swingLows = [];
    this.emaShort = null;
    this.emaLong = null;
    this.emaWarmup = 0;
    this.vwapState = {
      cumulativeTPV: 0,
      cumulativeVolume: 0,
      currentVWAP: 0,
      lastDate: null
    };
    this.sessionLevels = {
      prevHigh: null,
      prevLow: null,
      prevClose: null,
      currentHigh: -Infinity,
      currentLow: Infinity,
      currentOpen: null,
      lastSessionDate: null
    };
  }

  getName() { return 'OHLCV_MTF_REJECTION'; }
  getDescription() { return 'OHLCV MTF Rejection Detector v2 - symmetric R:R with structure-aligned stops at key levels'; }
  getRequiredMarketData() { return []; }
}

export default OHLCVMTFRejectionStrategy;
