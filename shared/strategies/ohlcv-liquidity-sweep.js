/**
 * OHLCV Liquidity Sweep Detector v2 - Symmetric R:R
 *
 * Identifies stop hunts where price breaches a swing point to grab liquidity,
 * then reverses. Enters with fixed symmetric stop:target when sweep wick
 * provides a naturally aligned stop distance.
 *
 * Signal Logic:
 * - Track swing highs/lows using configurable lookback
 * - Liquidity sweep occurs when:
 *   1. Price wick breaches a swing high/low
 *   2. Bar closes back inside the prior range
 *   3. Volume on sweep bar >= threshold x average
 * - Two entry modes: 'aggressive' (sweep bar close) or
 *   'confirmed' (next bar confirms reversal)
 *
 * v2 Changes:
 * - Fixed symmetric stop:target (5/10/15 points configurable)
 * - Only takes trade when sweep wick distance aligns with a fixed distance
 * - EMA trend filter for market structure confirmation
 * - Tighter requirements: deeper sweep, higher volume threshold
 * - No trailing stops (pure 1:1 R:R)
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class OHLCVLiquiditySweepStrategy extends BaseStrategy {
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
      // Swing detection
      swingLookback: 10,

      // Sweep detection
      volumeMultiplier: 1.5,
      volumeLookback: 20,
      minSweepDepth: 1.0,

      // Entry mode
      entryMode: 'confirmed',

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

      // Stop buffer beyond sweep wick
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
    this.pendingSweep = null;
    this.candleCount = 0;
    this.emaShort = null;
    this.emaLong = null;
    this.emaWarmup = 0;
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

    // Update state
    this.candleCount++;
    this.candleHistory.push(candle);
    if (this.candleHistory.length > this.params.swingLookback * 3 + 10) {
      this.candleHistory.shift();
    }

    this.rollingVolumes.push(candle.volume || 0);
    if (this.rollingVolumes.length > this.params.volumeLookback) {
      this.rollingVolumes.shift();
    }

    // Update EMAs
    this.updateEMA(candle.close);

    // Update swing points
    this.updateSwingPoints();

    const avgVolume = this.rollingVolumes.length >= this.params.volumeLookback
      ? this.rollingVolumes.reduce((a, b) => a + b, 0) / this.rollingVolumes.length
      : 0;

    // Check for confirmation of pending sweep
    if (this.pendingSweep) {
      const sweep = this.pendingSweep;

      if (sweep.direction === 'bullish') {
        if (candle.close > sweep.sweepBarClose) {
          this.pendingSweep = null;
          return this.generateSignal(sweep, candle, debug);
        }
      } else {
        if (candle.close < sweep.sweepBarClose) {
          this.pendingSweep = null;
          return this.generateSignal(sweep, candle, debug);
        }
      }

      this.pendingSweep = null;
    }

    if (avgVolume <= 0 || (this.swingHighs.length === 0 && this.swingLows.length === 0)) {
      return null;
    }

    const volumeRatio = (candle.volume || 0) / avgVolume;
    const hasVolume = volumeRatio >= this.params.volumeMultiplier;

    // Detect sweep of lows (bullish signal)
    for (const swing of this.swingLows) {
      const sweepDepth = swing.price - candle.low;

      if (sweepDepth >= this.params.minSweepDepth && candle.close > swing.price && hasVolume) {
        const sweepData = {
          direction: 'bullish',
          swingLevel: swing.price,
          sweepLow: candle.low,
          sweepHigh: candle.high,
          sweepBarClose: candle.close,
          sweepBarOpen: candle.open,
          sweepDepth,
          volumeRatio,
          sweepTimestamp: candle.timestamp
        };

        if (debug) {
          console.log(`[SWEEP] Bullish sweep detected: swing=${swing.price}, low=${candle.low}, depth=${sweepDepth.toFixed(2)}, vol=${volumeRatio.toFixed(2)}x`);
        }

        if (this.params.entryMode === 'aggressive') {
          return this.generateSignal(sweepData, candle, debug);
        } else {
          this.pendingSweep = sweepData;
          return null;
        }
      }
    }

    // Detect sweep of highs (bearish signal)
    for (const swing of this.swingHighs) {
      const sweepDepth = candle.high - swing.price;

      if (sweepDepth >= this.params.minSweepDepth && candle.close < swing.price && hasVolume) {
        const sweepData = {
          direction: 'bearish',
          swingLevel: swing.price,
          sweepLow: candle.low,
          sweepHigh: candle.high,
          sweepBarClose: candle.close,
          sweepBarOpen: candle.open,
          sweepDepth,
          volumeRatio,
          sweepTimestamp: candle.timestamp
        };

        if (debug) {
          console.log(`[SWEEP] Bearish sweep detected: swing=${swing.price}, high=${candle.high}, depth=${sweepDepth.toFixed(2)}, vol=${volumeRatio.toFixed(2)}x`);
        }

        if (this.params.entryMode === 'aggressive') {
          return this.generateSignal(sweepData, candle, debug);
        } else {
          this.pendingSweep = sweepData;
          return null;
        }
      }
    }

    return null;
  }

  generateSignal(sweepData, entryCandle, debug) {
    // Side filter
    const sideFilter = this.params.sideFilter;
    if (sideFilter !== 'both') {
      const signalSide = sweepData.direction === 'bullish' ? 'buy' : 'sell';
      if (signalSide !== sideFilter) {
        if (debug) console.log(`[SWEEP] Rejected by sideFilter: ${signalSide} not allowed (filter=${sideFilter})`);
        return null;
      }
    }

    if (sweepData.direction === 'bullish') {
      const entryPrice = entryCandle.close;
      const naturalStop = sweepData.sweepLow - this.params.stopBuffer;
      const naturalDist = entryPrice - naturalStop;

      // Find aligned fixed distance
      const alignedDist = this.findAlignedDistance(naturalDist);
      if (alignedDist === null) {
        if (debug) console.log(`[SWEEP] Bullish rejected: natural stop ${naturalDist.toFixed(1)}pts doesn't align with fixed distances`);
        return null;
      }

      // EMA trend filter
      if (this.params.requireTrendAlignment && this.getTrend() === 'bearish') {
        if (debug) console.log(`[SWEEP] Bullish rejected: bearish EMA trend`);
        return null;
      }

      this.updateLastSignalTime(entryCandle.timestamp);

      const stopPrice = entryPrice - alignedDist;
      const targetPrice = entryPrice + alignedDist;

      if (debug) {
        console.log(`[SWEEP] BUY signal: entry=${entryPrice}, stop=${stopPrice}, target=${targetPrice}, dist=${alignedDist}pt`);
      }

      return {
        strategy: 'OHLCV_LIQUIDITY_SWEEP',
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
        timestamp: new Date(entryCandle.timestamp).toISOString(),
        metadata: {
          detector: 'liquidity_sweep',
          direction: 'bullish',
          swing_level: roundTo(sweepData.swingLevel),
          sweep_low: roundTo(sweepData.sweepLow),
          sweep_depth: roundTo(sweepData.sweepDepth),
          volume_ratio: roundTo(sweepData.volumeRatio),
          natural_stop_dist: roundTo(entryPrice - (sweepData.sweepLow - this.params.stopBuffer)),
          aligned_dist: alignedDist,
          risk_points: alignedDist,
          ema_trend: this.getTrend(),
          entry_mode: this.params.entryMode,
          entry_reason: `Bullish liquidity sweep of ${roundTo(sweepData.swingLevel)}, ${alignedDist}pt symmetric R:R`
        }
      };
    } else {
      const entryPrice = entryCandle.close;
      const naturalStop = sweepData.sweepHigh + this.params.stopBuffer;
      const naturalDist = naturalStop - entryPrice;

      const alignedDist = this.findAlignedDistance(naturalDist);
      if (alignedDist === null) {
        if (debug) console.log(`[SWEEP] Bearish rejected: natural stop ${naturalDist.toFixed(1)}pts doesn't align with fixed distances`);
        return null;
      }

      if (this.params.requireTrendAlignment && this.getTrend() === 'bullish') {
        if (debug) console.log(`[SWEEP] Bearish rejected: bullish EMA trend`);
        return null;
      }

      this.updateLastSignalTime(entryCandle.timestamp);

      const stopPrice = entryPrice + alignedDist;
      const targetPrice = entryPrice - alignedDist;

      if (debug) {
        console.log(`[SWEEP] SELL signal: entry=${entryPrice}, stop=${stopPrice}, target=${targetPrice}, dist=${alignedDist}pt`);
      }

      return {
        strategy: 'OHLCV_LIQUIDITY_SWEEP',
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
        timestamp: new Date(entryCandle.timestamp).toISOString(),
        metadata: {
          detector: 'liquidity_sweep',
          direction: 'bearish',
          swing_level: roundTo(sweepData.swingLevel),
          sweep_high: roundTo(sweepData.sweepHigh),
          sweep_depth: roundTo(sweepData.sweepDepth),
          volume_ratio: roundTo(sweepData.volumeRatio),
          natural_stop_dist: roundTo((sweepData.sweepHigh + this.params.stopBuffer) - entryPrice),
          aligned_dist: alignedDist,
          risk_points: alignedDist,
          ema_trend: this.getTrend(),
          entry_mode: this.params.entryMode,
          entry_reason: `Bearish liquidity sweep of ${roundTo(sweepData.swingLevel)}, ${alignedDist}pt symmetric R:R`
        }
      };
    }
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

  updateSwingPoints() {
    const lookback = this.params.swingLookback;
    const history = this.candleHistory;

    if (history.length < lookback * 2 + 1) return;

    const pivotIndex = history.length - 1 - lookback;
    const pivotCandle = history[pivotIndex];

    let isSwingHigh = true;
    for (let j = pivotIndex - lookback; j <= pivotIndex + lookback; j++) {
      if (j === pivotIndex) continue;
      if (j < 0 || j >= history.length) { isSwingHigh = false; break; }
      if (history[j].high >= pivotCandle.high) {
        isSwingHigh = false;
        break;
      }
    }

    if (isSwingHigh) {
      this.swingHighs = this.swingHighs.filter(sh =>
        Math.abs(sh.price - pivotCandle.high) > 2
      );
      this.swingHighs.push({
        price: pivotCandle.high,
        timestamp: pivotCandle.timestamp
      });
      if (this.swingHighs.length > 10) this.swingHighs.shift();
    }

    let isSwingLow = true;
    for (let j = pivotIndex - lookback; j <= pivotIndex + lookback; j++) {
      if (j === pivotIndex) continue;
      if (j < 0 || j >= history.length) { isSwingLow = false; break; }
      if (history[j].low <= pivotCandle.low) {
        isSwingLow = false;
        break;
      }
    }

    if (isSwingLow) {
      this.swingLows = this.swingLows.filter(sl =>
        Math.abs(sl.price - pivotCandle.low) > 2
      );
      this.swingLows.push({
        price: pivotCandle.low,
        timestamp: pivotCandle.timestamp
      });
      if (this.swingLows.length > 10) this.swingLows.shift();
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
    this.pendingSweep = null;
    this.candleCount = 0;
    this.emaShort = null;
    this.emaLong = null;
    this.emaWarmup = 0;
  }

  getName() { return 'OHLCV_LIQUIDITY_SWEEP'; }
  getDescription() { return 'OHLCV Liquidity Sweep Detector v2 - symmetric R:R with structure-aligned stops'; }
  getRequiredMarketData() { return []; }
}

export default OHLCVLiquiditySweepStrategy;
