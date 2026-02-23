/**
 * OHLCV VPIN (Volume-Synchronized Probability of Informed Trading) v2 - Symmetric R:R
 *
 * Approximates toxic/informed flow to identify when smart money is active.
 * Uses Bulk Volume Classification (BVC) to estimate buy/sell volume from OHLCV data.
 *
 * v2 adds structure-based entry: only enters when price is near a swing level,
 * using the swing as the natural stop with fixed symmetric R:R.
 *
 * Signal Logic:
 * - Partition volume into fixed-size buckets
 * - Classify buy/sell via BVC sigmoid approximation
 * - VPIN = rolling average of |buyVol - sellVol| / totalBucketVol
 * - High VPIN + directional bias + near swing level = entry signal
 *
 * v2 Changes:
 * - Structure-based entry: requires price near a swing high/low
 * - Fixed symmetric stop:target (5/10/15 points configurable)
 * - Only takes trade when swing-based stop aligns with fixed distance
 * - EMA trend confirmation required to agree with VPIN bias
 * - No trailing stops (pure 1:1 R:R)
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class OHLCVVPINStrategy extends BaseStrategy {
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
      // VPIN calculation
      bucketSizeMultiplier: 1.0,
      vpinWindow: 50,
      vpinThresholdPercentile: 0.75,
      stddevPeriod: 20,

      // Directional bias requirements
      minDirectionalBias: 0.6,
      biasLookback: 10,

      // Swing detection for structure
      swingLookback: 8,
      swingProximityPoints: 5,

      // Symmetric R:R
      fixedDistances: [5, 10, 15],
      distanceTolerance: 2,

      // Market structure (EMA)
      emaPeriodShort: 8,
      emaPeriodLong: 21,
      requireTrendAlignment: true,

      // Exit (symmetric, no trailing)
      useTrailingStop: false,
      maxHoldBars: 30,

      // Signal management
      signalCooldownMs: 10 * 60 * 1000,

      // Session filtering
      useSessionFilter: true,
      allowedSessions: ['rth'],
      noEntryFirstMinutes: 15,
      noEntryLastMinutes: 15,

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Stop buffer beyond swing
      stopBuffer: 0.25,

      forceCloseAtMarketClose: true,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // VPIN computation state
    this.priceChanges = [];
    this.volumeHistory = [];
    this.currentBucket = { buyVol: 0, sellVol: 0, totalVol: 0 };
    this.bucketTarget = 0;
    this.completedBuckets = [];
    this.vpinHistory = [];
    this.currentVPIN = 0;
    this.currentBias = 0.5;
    this.barCount = 0;

    // Swing tracking for structure
    this.candleHistory = [];
    this.swingHighs = [];
    this.swingLows = [];

    // EMA state
    this.emaShort = null;
    this.emaLong = null;
    this.emaWarmup = 0;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    if (!isValidCandle(candle) || !isValidCandle(prevCandle)) {
      return null;
    }

    this.barCount++;

    // Update candle history for swing detection
    this.candleHistory.push(candle);
    if (this.candleHistory.length > this.params.swingLookback * 3 + 10) {
      this.candleHistory.shift();
    }

    // Update swing points
    this.updateSwingPoints();

    // Update EMAs
    this.updateEMA(candle.close);

    // Update price change history for stddev
    const priceChange = candle.close - candle.open;
    this.priceChanges.push(priceChange);
    if (this.priceChanges.length > this.params.stddevPeriod) {
      this.priceChanges.shift();
    }

    // Update volume history for bucket sizing
    this.volumeHistory.push(candle.volume || 0);
    if (this.volumeHistory.length > this.params.vpinWindow) {
      this.volumeHistory.shift();
    }

    // Calculate bucket target
    if (this.volumeHistory.length >= 10) {
      const avgVol = this.volumeHistory.reduce((a, b) => a + b, 0) / this.volumeHistory.length;
      this.bucketTarget = avgVol * this.params.bucketSizeMultiplier;
    }

    if (this.bucketTarget <= 0 || this.priceChanges.length < this.params.stddevPeriod) {
      return null;
    }

    // Classify volume using BVC
    const stddev = this.calculateStddev(this.priceChanges);
    const z = stddev > 0 ? priceChange / stddev : 0;
    const buyPct = this.sigmoid(z);
    const volume = candle.volume || 0;
    const buyVol = volume * buyPct;
    const sellVol = volume - buyVol;

    // Add to current bucket
    this.currentBucket.buyVol += buyVol;
    this.currentBucket.sellVol += sellVol;
    this.currentBucket.totalVol += volume;

    // Check if bucket is complete
    while (this.currentBucket.totalVol >= this.bucketTarget && this.bucketTarget > 0) {
      const overflow = this.currentBucket.totalVol - this.bucketTarget;
      const overflowRatio = overflow / volume || 0;

      const finalBuyVol = this.currentBucket.buyVol - (buyVol * overflowRatio);
      const finalSellVol = this.currentBucket.sellVol - (sellVol * overflowRatio);
      const finalTotalVol = this.bucketTarget;
      const imbalance = finalTotalVol > 0
        ? Math.abs(finalBuyVol - finalSellVol) / finalTotalVol
        : 0;

      this.completedBuckets.push({
        buyVol: finalBuyVol,
        sellVol: finalSellVol,
        totalVol: finalTotalVol,
        imbalance,
        buyPct: finalTotalVol > 0 ? finalBuyVol / finalTotalVol : 0.5
      });

      if (this.completedBuckets.length > this.params.vpinWindow + 20) {
        this.completedBuckets.shift();
      }

      this.currentBucket = {
        buyVol: buyVol * overflowRatio,
        sellVol: sellVol * overflowRatio,
        totalVol: overflow
      };
    }

    // Calculate VPIN
    if (this.completedBuckets.length < this.params.vpinWindow) {
      return null;
    }

    const recentBuckets = this.completedBuckets.slice(-this.params.vpinWindow);
    this.currentVPIN = recentBuckets.reduce((sum, b) => sum + b.imbalance, 0) / recentBuckets.length;

    this.vpinHistory.push(this.currentVPIN);
    if (this.vpinHistory.length > 500) {
      this.vpinHistory.shift();
    }

    // Calculate directional bias
    const biasBuckets = this.completedBuckets.slice(-this.params.biasLookback);
    const totalBuyVol = biasBuckets.reduce((s, b) => s + b.buyVol, 0);
    const totalVol = biasBuckets.reduce((s, b) => s + b.totalVol, 0);
    this.currentBias = totalVol > 0 ? totalBuyVol / totalVol : 0.5;

    // Check if VPIN is elevated
    const vpinPercentile = this.getPercentile(this.currentVPIN, this.vpinHistory);

    if (vpinPercentile < this.params.vpinThresholdPercentile) {
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

    // Determine direction from bias
    let side = null;
    if (this.currentBias >= this.params.minDirectionalBias) {
      side = 'buy';
    } else if (this.currentBias <= (1 - this.params.minDirectionalBias)) {
      side = 'sell';
    }

    if (!side) return null;

    // EMA trend filter
    if (this.params.requireTrendAlignment) {
      const trend = this.getTrend();
      if (side === 'buy' && trend === 'bearish') {
        if (debug) console.log(`[VPIN] Buy rejected: bearish EMA trend`);
        return null;
      }
      if (side === 'sell' && trend === 'bullish') {
        if (debug) console.log(`[VPIN] Sell rejected: bullish EMA trend`);
        return null;
      }
    }

    // Structure-based entry: find nearest swing level for stop placement
    const entryPrice = candle.close;
    let naturalStop = null;
    let structureLevel = null;
    let structureType = null;

    if (side === 'buy') {
      // Find nearest swing low below entry for stop
      let bestSwing = null;
      let bestDist = Infinity;
      for (const sl of this.swingLows) {
        if (sl.price < entryPrice) {
          const dist = entryPrice - sl.price;
          if (dist < bestDist) {
            bestDist = dist;
            bestSwing = sl;
          }
        }
      }
      if (bestSwing) {
        naturalStop = bestSwing.price - this.params.stopBuffer;
        structureLevel = bestSwing.price;
        structureType = 'swing_low';
      }
    } else {
      // Find nearest swing high above entry for stop
      let bestSwing = null;
      let bestDist = Infinity;
      for (const sh of this.swingHighs) {
        if (sh.price > entryPrice) {
          const dist = sh.price - entryPrice;
          if (dist < bestDist) {
            bestDist = dist;
            bestSwing = sh;
          }
        }
      }
      if (bestSwing) {
        naturalStop = bestSwing.price + this.params.stopBuffer;
        structureLevel = bestSwing.price;
        structureType = 'swing_high';
      }
    }

    if (naturalStop === null) {
      if (debug) console.log(`[VPIN] ${side} rejected: no swing structure for stop`);
      return null;
    }

    const naturalDist = Math.abs(entryPrice - naturalStop);

    // Find aligned fixed distance
    const alignedDist = this.findAlignedDistance(naturalDist);
    if (alignedDist === null) {
      if (debug) console.log(`[VPIN] ${side} rejected: natural stop ${naturalDist.toFixed(1)}pts doesn't align`);
      return null;
    }

    this.updateLastSignalTime(candle.timestamp);

    let stopPrice, targetPrice;
    if (side === 'buy') {
      stopPrice = entryPrice - alignedDist;
      targetPrice = entryPrice + alignedDist;
    } else {
      stopPrice = entryPrice + alignedDist;
      targetPrice = entryPrice - alignedDist;
    }

    if (debug) {
      console.log(`[VPIN] ${side.toUpperCase()} signal: VPIN=${this.currentVPIN.toFixed(4)}, bias=${this.currentBias.toFixed(3)}, dist=${alignedDist}pt`);
    }

    return {
      strategy: 'OHLCV_VPIN',
      side,
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
        detector: 'vpin',
        vpin: roundTo(this.currentVPIN, 4),
        vpin_percentile: roundTo(vpinPercentile, 4),
        directional_bias: roundTo(this.currentBias, 4),
        structure_level: roundTo(structureLevel),
        structure_type: structureType,
        natural_stop_dist: roundTo(naturalDist),
        aligned_dist: alignedDist,
        risk_points: alignedDist,
        ema_trend: this.getTrend(),
        entry_reason: `VPIN elevated (${(vpinPercentile * 100).toFixed(0)}th pctile), ${side} at ${structureType} ${roundTo(structureLevel)}, ${alignedDist}pt symmetric R:R`
      }
    };
  }

  getVPINState() {
    const vpinPercentile = this.vpinHistory.length > 0
      ? this.getPercentile(this.currentVPIN, this.vpinHistory)
      : 0;

    return {
      vpin: this.currentVPIN,
      percentile: vpinPercentile,
      isElevated: vpinPercentile >= this.params.vpinThresholdPercentile,
      bias: this.currentBias,
      biasDirection: this.currentBias >= 0.6 ? 'bullish' : this.currentBias <= 0.4 ? 'bearish' : 'neutral'
    };
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
      this.swingHighs = this.swingHighs.filter(sh => Math.abs(sh.price - pivotCandle.high) > 2);
      this.swingHighs.push({ price: pivotCandle.high, timestamp: pivotCandle.timestamp });
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
      this.swingLows = this.swingLows.filter(sl => Math.abs(sl.price - pivotCandle.low) > 2);
      this.swingLows.push({ price: pivotCandle.low, timestamp: pivotCandle.timestamp });
      if (this.swingLows.length > 10) this.swingLows.shift();
    }
  }

  sigmoid(z) {
    return 1 / (1 + Math.exp(-1.7 * z));
  }

  calculateStddev(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => (v - mean) ** 2);
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
  }

  getPercentile(value, history) {
    if (history.length === 0) return 0;
    const sorted = [...history].sort((a, b) => a - b);
    const index = sorted.findIndex(v => v >= value);
    if (index === -1) return 1;
    return index / sorted.length;
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
    this.priceChanges = [];
    this.volumeHistory = [];
    this.currentBucket = { buyVol: 0, sellVol: 0, totalVol: 0 };
    this.bucketTarget = 0;
    this.completedBuckets = [];
    this.vpinHistory = [];
    this.currentVPIN = 0;
    this.currentBias = 0.5;
    this.barCount = 0;
    this.candleHistory = [];
    this.swingHighs = [];
    this.swingLows = [];
    this.emaShort = null;
    this.emaLong = null;
    this.emaWarmup = 0;
  }

  getName() { return 'OHLCV_VPIN'; }
  getDescription() { return 'OHLCV VPIN Regime Detector v2 - structure-based entry with symmetric R:R'; }
  getRequiredMarketData() { return []; }
}

export default OHLCVVPINStrategy;
