/**
 * VWAP Bounce / Mean Reversion Strategy
 *
 * Trades pullbacks to VWAP (Volume Weighted Average Price) in trending
 * markets. VWAP acts as a dynamic support/resistance level that
 * institutional traders use for execution benchmarking.
 *
 * Sources: Steady Turtle Trading, futures.io, QuantVPS
 *
 * Rules:
 * - Compute session VWAP from RTH open (9:30 AM ET)
 * - LONG: Price above VWAP (uptrend), pulls back to VWAP,
 *   strong rejection candle (long lower wick) + optional RSI(2)<30
 * - SHORT: Price below VWAP (downtrend), rallies to VWAP,
 *   rejection candle (long upper wick) + optional RSI(2)>70
 * - Stop: Beyond the rejection candle extreme
 * - Target: Based on R:R ratio (default 2:1)
 *
 * Claimed results: PF 1.692 with RSI(2) filter, ~49% win rate
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class VWAPBounceStrategy extends BaseStrategy {
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
      // VWAP proximity: how close to VWAP price must be (points)
      vwapProximity: 8,

      // Trend confirmation: price must be N points above/below VWAP
      // in the lookback period to confirm trend direction
      trendLookback: 30,  // Candles to look back for trend
      minTrendDistance: 10,  // Avg distance from VWAP to confirm trend

      // Rejection candle detection
      // Wick ratio: wick must be X times the body
      minWickBodyRatio: 1.5,
      // Minimum candle range (avoid dojis with tiny range)
      minCandleRange: 3,

      // RSI filter (optional)
      useRSIFilter: true,
      rsiPeriod: 2,  // Very short RSI for oversold/overbought
      rsiBuyThreshold: 30,   // Long when RSI < 30
      rsiSellThreshold: 70,  // Short when RSI > 70

      // Risk management
      stopBeyondWick: 2,  // Points beyond rejection wick for stop
      maxStopPoints: 25,
      rewardRiskRatio: 2.0,

      // Direction
      allowLongs: true,
      allowShorts: true,

      // Session
      rthOnly: true,
      entryWindowStartHour: 10,   // After first 30 min
      entryWindowStartMinute: 0,
      entryWindowEndHour: 15,
      entryWindowEndMinute: 30,

      // Max trades per day
      maxTradesPerDay: 3,

      // Max hold
      maxHoldBars: 60,  // 1 hour

      // Signal management
      signalCooldownMs: 30 * 60 * 1000,  // 30 min

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // VWAP calculation state
    this.vwapCumulativeTPV = 0;  // cumulative (typical price * volume)
    this.vwapCumulativeVolume = 0;
    this.vwap = null;
    this.vwapSessionDate = null;

    // RSI state
    this.closes = [];
    this.rsi = null;

    // Price history for trend detection
    this.priceHistory = [];

    // Daily tracking
    this.currentTradingDate = null;
    this.tradesThisDay = 0;
  }

  getETTime(timestamp) {
    const date = new Date(typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime());
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const [datePart, timePart] = estString.split(', ');
    const [month, day, year] = datePart.split('/');
    const [hour, minute] = timePart.split(':');
    return {
      year: parseInt(year),
      month: parseInt(month),
      day: parseInt(day),
      hour: parseInt(hour),
      minute: parseInt(minute),
      dateKey: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    };
  }

  isInRTH(et) {
    const min = et.hour * 60 + et.minute;
    return min >= 570 && min < 960;
  }

  isInEntryWindow(et) {
    const min = et.hour * 60 + et.minute;
    const start = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const end = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return min >= start && min < end;
  }

  /**
   * Update VWAP calculation. Reset at start of each RTH session.
   */
  updateVWAP(candle, et) {
    // Reset VWAP at RTH open each day
    if (et.dateKey !== this.vwapSessionDate && et.hour === 9 && et.minute === 30) {
      this.vwapCumulativeTPV = 0;
      this.vwapCumulativeVolume = 0;
      this.vwapSessionDate = et.dateKey;
    }

    // Only compute during RTH
    if (!this.isInRTH(et) || et.dateKey !== this.vwapSessionDate) return;

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const volume = candle.volume || 1;

    this.vwapCumulativeTPV += typicalPrice * volume;
    this.vwapCumulativeVolume += volume;

    this.vwap = this.vwapCumulativeVolume > 0
      ? this.vwapCumulativeTPV / this.vwapCumulativeVolume
      : null;
  }

  /**
   * Compute RSI(2) or RSI(N)
   */
  updateRSI(close) {
    this.closes.push(close);
    const period = this.params.rsiPeriod;

    if (this.closes.length > period + 50) {
      this.closes = this.closes.slice(-period - 50);
    }

    if (this.closes.length < period + 1) {
      this.rsi = null;
      return;
    }

    let gains = 0;
    let losses = 0;
    const len = this.closes.length;

    for (let i = len - period; i < len; i++) {
      const change = this.closes[i] - this.closes[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) {
      this.rsi = 100;
    } else {
      const rs = avgGain / avgLoss;
      this.rsi = 100 - (100 / (1 + rs));
    }
  }

  /**
   * Check if there's a rejection candle pattern
   */
  isRejectionCandle(candle, direction) {
    const range = candle.high - candle.low;
    if (range < this.params.minCandleRange) return false;

    const bodySize = Math.abs(candle.close - candle.open);
    if (bodySize === 0) return false;

    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;

    if (direction === 'long') {
      // Bullish rejection: long lower wick, close near high
      return lowerWick / bodySize >= this.params.minWickBodyRatio && candle.close > candle.open;
    } else {
      // Bearish rejection: long upper wick, close near low
      return upperWick / bodySize >= this.params.minWickBodyRatio && candle.close < candle.open;
    }
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);

    // Reset daily state
    if (et.dateKey !== this.currentTradingDate) {
      this.currentTradingDate = et.dateKey;
      this.tradesThisDay = 0;
    }

    // Update VWAP
    this.updateVWAP(candle, et);

    // Update RSI
    this.updateRSI(candle.close);

    // Track price history
    this.priceHistory.push({ close: candle.close, vwap: this.vwap });
    if (this.priceHistory.length > this.params.trendLookback + 10) {
      this.priceHistory = this.priceHistory.slice(-this.params.trendLookback - 10);
    }

    // Skip if not ready or outside window
    if (!this.vwap) return null;
    if (this.params.rthOnly && !this.isInRTH(et)) return null;
    if (!this.isInEntryWindow(et)) return null;
    if (this.tradesThisDay >= this.params.maxTradesPerDay) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const price = candle.close;
    const distFromVWAP = price - this.vwap;
    const absDistFromVWAP = Math.abs(distFromVWAP);

    // Check VWAP proximity
    if (absDistFromVWAP > this.params.vwapProximity) return null;

    // Determine trend from price history
    const trend = this.getTrend();
    if (!trend) return null;

    // LONG: Uptrend + pullback to VWAP + rejection candle
    if (trend === 'bullish' && this.params.allowLongs) {
      if (this.isRejectionCandle(candle, 'long')) {
        // RSI filter
        if (this.params.useRSIFilter && (this.rsi === null || this.rsi > this.params.rsiBuyThreshold)) {
          return null;
        }

        return this.createVWAPSignal('long', candle, et);
      }
    }

    // SHORT: Downtrend + rally to VWAP + rejection candle
    if (trend === 'bearish' && this.params.allowShorts) {
      if (this.isRejectionCandle(candle, 'short')) {
        if (this.params.useRSIFilter && (this.rsi === null || this.rsi < this.params.rsiSellThreshold)) {
          return null;
        }

        return this.createVWAPSignal('short', candle, et);
      }
    }

    return null;
  }

  /**
   * Determine trend from recent price history relative to VWAP
   */
  getTrend() {
    const lookback = Math.min(this.params.trendLookback, this.priceHistory.length);
    if (lookback < 10) return null;

    let totalDist = 0;
    let count = 0;

    for (let i = this.priceHistory.length - lookback; i < this.priceHistory.length - 1; i++) {
      const entry = this.priceHistory[i];
      if (entry.vwap) {
        totalDist += entry.close - entry.vwap;
        count++;
      }
    }

    if (count === 0) return null;
    const avgDist = totalDist / count;

    if (avgDist > this.params.minTrendDistance) return 'bullish';
    if (avgDist < -this.params.minTrendDistance) return 'bearish';
    return null;
  }

  createVWAPSignal(side, candle, et) {
    const timestamp = this.toMs(candle.timestamp);
    const entryPrice = candle.close;

    let stopPrice, stopDistance;

    if (side === 'long') {
      stopPrice = candle.low - this.params.stopBeyondWick;
      stopDistance = entryPrice - stopPrice;
    } else {
      stopPrice = candle.high + this.params.stopBeyondWick;
      stopDistance = stopPrice - entryPrice;
    }

    if (stopDistance > this.params.maxStopPoints || stopDistance <= 0) return null;

    const targetDistance = stopDistance * this.params.rewardRiskRatio;
    const targetPrice = side === 'long'
      ? entryPrice + targetDistance
      : entryPrice - targetDistance;

    this.tradesThisDay++;
    this.updateLastSignalTime(timestamp);

    if (this.params.debug) {
      console.log(`[VWAP] ${et.dateKey} ${side.toUpperCase()}: entry=${entryPrice.toFixed(2)}, VWAP=${this.vwap.toFixed(2)}, RSI=${this.rsi?.toFixed(1)}, stop=${stopPrice.toFixed(2)}, target=${targetPrice.toFixed(2)}`);
    }

    return {
      strategy: 'VWAP_BOUNCE',
      side: side === 'long' ? 'buy' : 'sell',
      action: 'place_market',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      trailing_trigger: null,
      trailing_offset: null,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: new Date(timestamp).toISOString(),
      metadata: {
        strategy: 'VWAP_BOUNCE',
        direction: side,
        vwap: roundTo(this.vwap),
        dist_from_vwap: roundTo(candle.close - this.vwap),
        rsi: this.rsi ? roundTo(this.rsi) : null,
        stop_distance: roundTo(stopDistance),
        target_distance: roundTo(targetDistance),
        rr_ratio: this.params.rewardRiskRatio,
        trend: side === 'long' ? 'bullish' : 'bearish',
        rejection_lower_wick: roundTo(Math.min(candle.open, candle.close) - candle.low),
        rejection_upper_wick: roundTo(candle.high - Math.max(candle.open, candle.close)),
        trading_date: et.dateKey
      }
    };
  }

  reset() {
    super.reset();
    this.vwapCumulativeTPV = 0;
    this.vwapCumulativeVolume = 0;
    this.vwap = null;
    this.vwapSessionDate = null;
    this.closes = [];
    this.rsi = null;
    this.priceHistory = [];
    this.currentTradingDate = null;
    this.tradesThisDay = 0;
  }

  getName() { return 'VWAP_BOUNCE'; }
  getDescription() { return 'VWAP Bounce - mean reversion trades at VWAP in trending markets'; }
  getRequiredMarketData() { return []; }
}

export default VWAPBounceStrategy;
