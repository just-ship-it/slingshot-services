/**
 * Trend Scalp Strategy
 *
 * Simple trend following with configurable filters:
 * - Uptrend: consecutive higher lows → go long
 * - Downtrend: consecutive lower highs → go short
 * - Multiple optional filters to improve entry quality
 * - Trail to lock profits once green
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class TrendScalpStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Trend detection
      lookback: 3,              // Consecutive candles for trend confirmation
      minTrendSize: 5,          // Minimum points the trend must have moved

      // Risk management
      maxRisk: 8,               // Max points to risk

      // Trailing stop - the core edge
      trailingTrigger: 2,       // Activate at 2 pts profit
      trailingOffset: 2,        // Trail 2 pts behind (breakeven lock)

      // Target
      targetPoints: 12,         // Take profit target

      // Signal management
      signalCooldownMs: 300000, // 5 min cooldown

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // ═══════════════════════════════════════════════════════
      // FILTERS - Enable one at a time for testing
      // ═══════════════════════════════════════════════════════

      // Filter 1: Momentum confirmation
      // Only enter if candle closed strong (in direction of trade)
      useMomentumFilter: false,
      momentumThreshold: 0.7,   // Close must be in top 70% of range (long) or bottom 30% (short)

      // Filter 2: Candle body size
      // Skip dojis/spinning tops - require real body
      useBodySizeFilter: false,
      minBodySize: 2,          // Minimum body size in points

      // Filter 3: Breakout confirmation
      // Close must break previous candle's high (long) or low (short)
      useBreakoutFilter: false,

      // Filter 4: Volume spike
      // Require above-average volume
      useVolumeFilter: false,
      volumeMultiplier: 1.2,   // Volume must be > 1.2x average
      volumeLookback: 10,      // Candles for average calculation

      // Filter 5: No inside bars
      // Skip if any lookback candles are inside bars
      useNoInsideBarFilter: false,

      // Filter 6: Session/time
      // Only trade during high-momentum hours
      useSessionFilter: false,
      allowedHoursEST: [[9.5, 11], [15, 16]], // 9:30-11:00 and 3:00-4:00 EST

      // Filter 7: Trend acceleration
      // Each candle must be bigger than previous
      useAccelerationFilter: false,

      // Filter 8: GEX proximity
      // Only trade near GEX levels
      useGexFilter: false,
      gexProximityPoints: 15,  // Within X points of GEX level
    };

    this.params = { ...this.defaultParams, ...params };
    this.recentVolumes = [];
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;
    const candles = options.historicalCandles || [];

    if (!isValidCandle(candle)) return null;

    const lookback = this.params.lookback;
    if (candles.length < lookback) return null;

    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    const recent = candles.slice(-lookback);

    // Core trend detection
    const isUptrend = this.checkHigherLows(recent);
    const isDowntrend = this.checkLowerHighs(recent);

    if (!isUptrend && !isDowntrend) return null;

    const side = isUptrend ? 'buy' : 'sell';
    const trendSize = isUptrend
      ? candle.close - recent[0].low
      : recent[0].high - candle.close;

    // Skip if trend too small
    if (trendSize < this.params.minTrendSize) {
      if (debug) console.log(`[TREND_SCALP] Trend too small: ${trendSize.toFixed(2)}pts`);
      return null;
    }

    // ═══════════════════════════════════════════════════════
    // APPLY FILTERS
    // ═══════════════════════════════════════════════════════

    // Filter 1: Momentum confirmation
    if (this.params.useMomentumFilter) {
      if (!this.checkMomentumFilter(candle, side)) {
        if (debug) console.log(`[TREND_SCALP] Failed momentum filter`);
        return null;
      }
    }

    // Filter 2: Body size
    if (this.params.useBodySizeFilter) {
      if (!this.checkBodySizeFilter(candle)) {
        if (debug) console.log(`[TREND_SCALP] Failed body size filter`);
        return null;
      }
    }

    // Filter 3: Breakout confirmation
    if (this.params.useBreakoutFilter) {
      if (!this.checkBreakoutFilter(candle, prevCandle, side)) {
        if (debug) console.log(`[TREND_SCALP] Failed breakout filter`);
        return null;
      }
    }

    // Filter 4: Volume spike
    if (this.params.useVolumeFilter) {
      this.updateVolumeTracking(candle);
      if (!this.checkVolumeFilter(candle)) {
        if (debug) console.log(`[TREND_SCALP] Failed volume filter`);
        return null;
      }
    }

    // Filter 5: No inside bars
    if (this.params.useNoInsideBarFilter) {
      if (!this.checkNoInsideBarFilter(recent)) {
        if (debug) console.log(`[TREND_SCALP] Failed no-inside-bar filter`);
        return null;
      }
    }

    // Filter 6: Session/time
    if (this.params.useSessionFilter) {
      if (!this.checkSessionFilter(candle.timestamp)) {
        if (debug) console.log(`[TREND_SCALP] Failed session filter`);
        return null;
      }
    }

    // Filter 7: Trend acceleration
    if (this.params.useAccelerationFilter) {
      if (!this.checkAccelerationFilter(recent, side)) {
        if (debug) console.log(`[TREND_SCALP] Failed acceleration filter`);
        return null;
      }
    }

    // Filter 8: GEX proximity
    if (this.params.useGexFilter) {
      if (!this.checkGexFilter(candle.close, side, marketData)) {
        if (debug) console.log(`[TREND_SCALP] Failed GEX filter`);
        return null;
      }
    }

    // ═══════════════════════════════════════════════════════
    // CALCULATE ENTRY AND STOP
    // ═══════════════════════════════════════════════════════

    const entryPrice = candle.close;
    const stopPrice = isUptrend
      ? Math.min(...recent.map(c => c.low))
      : Math.max(...recent.map(c => c.high));

    const risk = Math.abs(entryPrice - stopPrice);

    if (risk > this.params.maxRisk) {
      if (debug) console.log(`[TREND_SCALP] Risk ${risk.toFixed(2)} > maxRisk ${this.params.maxRisk}`);
      return null;
    }

    const targetPrice = isUptrend
      ? entryPrice + this.params.targetPoints
      : entryPrice - this.params.targetPoints;

    this.updateLastSignalTime(candle.timestamp);

    if (debug) {
      console.log(`[TREND_SCALP] ✅ ${side.toUpperCase()} @ ${entryPrice.toFixed(2)} | Stop: ${stopPrice.toFixed(2)} | Risk: ${risk.toFixed(2)}pts`);
    }

    return {
      strategy: 'TREND_SCALP',
      side,
      action: 'place_market',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),
      trailing_trigger: this.params.trailingTrigger,
      trailing_offset: this.params.trailingOffset,
      metadata: {
        trend: isUptrend ? 'uptrend' : 'downtrend',
        trend_size: roundTo(trendSize),
        risk_points: roundTo(risk),
        lookback: this.params.lookback,
        candle_time: new Date(candle.timestamp).toISOString(),
      }
    };
  }

  // ═══════════════════════════════════════════════════════
  // TREND DETECTION
  // ═══════════════════════════════════════════════════════

  checkHigherLows(candles) {
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].low <= candles[i - 1].low) return false;
    }
    return true;
  }

  checkLowerHighs(candles) {
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].high >= candles[i - 1].high) return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════
  // FILTER IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════

  // Filter 1: Momentum - candle closed in direction of trade
  checkMomentumFilter(candle, side) {
    const range = candle.high - candle.low;
    if (range === 0) return false;

    const closePosition = (candle.close - candle.low) / range;

    if (side === 'buy') {
      return closePosition >= this.params.momentumThreshold;
    } else {
      return closePosition <= (1 - this.params.momentumThreshold);
    }
  }

  // Filter 2: Body size - skip dojis
  checkBodySizeFilter(candle) {
    const bodySize = Math.abs(candle.close - candle.open);
    return bodySize >= this.params.minBodySize;
  }

  // Filter 3: Breakout - close breaks previous extreme
  checkBreakoutFilter(candle, prevCandle, side) {
    if (!prevCandle) return false;

    if (side === 'buy') {
      return candle.close > prevCandle.high;
    } else {
      return candle.close < prevCandle.low;
    }
  }

  // Filter 4: Volume spike
  checkVolumeFilter(candle) {
    if (this.recentVolumes.length < this.params.volumeLookback) return true;

    const avgVolume = this.recentVolumes.reduce((a, b) => a + b, 0) / this.recentVolumes.length;
    return candle.volume >= avgVolume * this.params.volumeMultiplier;
  }

  updateVolumeTracking(candle) {
    this.recentVolumes.push(candle.volume);
    if (this.recentVolumes.length > this.params.volumeLookback) {
      this.recentVolumes.shift();
    }
  }

  // Filter 5: No inside bars in lookback period
  checkNoInsideBarFilter(candles) {
    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];
      // Inside bar: current high < previous high AND current low > previous low
      if (curr.high < prev.high && curr.low > prev.low) {
        return false;
      }
    }
    return true;
  }

  // Filter 6: Session/time filter
  checkSessionFilter(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;

    // Check if time falls within any allowed window
    for (const [start, end] of this.params.allowedHoursEST) {
      if (timeDecimal >= start && timeDecimal < end) {
        return true;
      }
    }
    return false;
  }

  // Filter 7: Trend acceleration - each candle bigger than previous
  checkAccelerationFilter(candles, side) {
    for (let i = 1; i < candles.length; i++) {
      const currMove = side === 'buy'
        ? candles[i].close - candles[i].open
        : candles[i].open - candles[i].close;
      const prevMove = side === 'buy'
        ? candles[i-1].close - candles[i-1].open
        : candles[i-1].open - candles[i-1].close;

      // Current move should be at least as big as previous
      if (currMove < prevMove) return false;
    }
    return true;
  }

  // Filter 8: GEX proximity
  checkGexFilter(price, side, marketData) {
    const gexLevels = marketData?.gexLevels;
    if (!gexLevels) return true; // Pass if no GEX data

    const proximity = this.params.gexProximityPoints;

    if (side === 'buy') {
      // For longs, check proximity to support levels
      const support = gexLevels.support || [];
      for (const level of support) {
        if (level && Math.abs(price - level) <= proximity) {
          return true;
        }
      }
      return false;
    } else {
      // For shorts, check proximity to resistance levels
      const resistance = gexLevels.resistance || [];
      for (const level of resistance) {
        if (level && Math.abs(price - level) <= proximity) {
          return true;
        }
      }
      return false;
    }
  }

  reset() {
    super.reset();
    this.recentVolumes = [];
  }

  getName() {
    return 'TREND_SCALP';
  }

  getDescription() {
    return 'Trend scalper with configurable filters - higher lows = long, lower highs = short';
  }
}

export default TrendScalpStrategy;
