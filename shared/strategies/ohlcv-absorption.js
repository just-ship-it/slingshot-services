/**
 * OHLCV Absorption Detector v2 - Symmetric R:R
 *
 * Identifies passive institutional orders absorbing aggressive flow,
 * then enters with fixed symmetric stop:target when structure aligns.
 *
 * Signal Logic:
 * - Detect candles with body_ratio < threshold AND volume >= N x average
 * - Require consecutive absorption bars in the same price zone (within 1 ATR)
 * - Bullish: repeated lower wicks (buying absorption near support)
 * - Bearish: repeated upper wicks (selling absorption near resistance)
 * - Enter on decisive breakaway candle (body_ratio > 0.6)
 *
 * v2 Changes:
 * - Fixed symmetric stop:target (5/10/15 points configurable)
 * - Only takes trade when natural stop aligns with a fixed distance
 * - EMA trend filter for market structure confirmation
 * - Tighter requirements: 3+ bars, 2x volume for higher selectivity
 * - No trailing stops (pure 1:1 R:R)
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class OHLCVAbsorptionStrategy extends BaseStrategy {
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
      // Absorption detection
      bodyRatioThreshold: 0.3,
      volumeMultiplier: 2.0,
      lookbackPeriod: 20,
      consecutiveBars: 3,
      zoneToleranceATRMultiplier: 0.75,
      atrPeriod: 14,

      // Breakaway confirmation
      breakawayBodyRatio: 0.6,

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

      // Stop buffer beyond structure
      stopBuffer: 0.25,

      // Force close at session end
      forceCloseAtMarketClose: true,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Internal state
    this.rollingVolumes = [];
    this.trueRanges = [];
    this.absorptionClusters = [];
    this.prevCandles = [];
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

    // Update rolling volume
    this.rollingVolumes.push(candle.volume || 0);
    if (this.rollingVolumes.length > this.params.lookbackPeriod) {
      this.rollingVolumes.shift();
    }

    // Update ATR
    this.updateATR(candle, prevCandle);

    // Update EMAs
    this.updateEMA(candle.close);

    // Store recent candles
    this.prevCandles.push(candle);
    if (this.prevCandles.length > 50) {
      this.prevCandles.shift();
    }

    const avgVolume = this.rollingVolumes.length >= this.params.lookbackPeriod
      ? this.rollingVolumes.reduce((a, b) => a + b, 0) / this.rollingVolumes.length
      : 0;

    if (avgVolume <= 0) return null;

    const currentATR = this.getCurrentATR();
    if (currentATR <= 0) return null;

    const range = candle.high - candle.low;
    if (range <= 0) return null;

    const bodySize = Math.abs(candle.close - candle.open);
    const bodyRatio = bodySize / range;
    const volumeRatio = (candle.volume || 0) / avgVolume;

    // Check if this candle is an absorption candle
    const isAbsorption = bodyRatio < this.params.bodyRatioThreshold &&
                         volumeRatio >= this.params.volumeMultiplier;

    if (isAbsorption) {
      const upperWick = candle.high - Math.max(candle.open, candle.close);
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      const midPrice = (candle.high + candle.low) / 2;

      let direction = null;
      if (lowerWick > upperWick * 1.5) {
        direction = 'bullish';
      } else if (upperWick > lowerWick * 1.5) {
        direction = 'bearish';
      }

      if (direction) {
        const zoneTolerance = currentATR * this.params.zoneToleranceATRMultiplier;
        let addedToCluster = false;

        for (const cluster of this.absorptionClusters) {
          if (cluster.direction === direction &&
              Math.abs(midPrice - cluster.zoneCenter) <= zoneTolerance) {
            cluster.bars.push({
              timestamp: candle.timestamp,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              open: candle.open,
              bodyRatio,
              volumeRatio
            });
            cluster.clusterHigh = Math.max(cluster.clusterHigh, candle.high);
            cluster.clusterLow = Math.min(cluster.clusterLow, candle.low);
            cluster.lastTimestamp = candle.timestamp;
            addedToCluster = true;
            break;
          }
        }

        if (!addedToCluster) {
          this.absorptionClusters.push({
            direction,
            zoneCenter: midPrice,
            clusterHigh: candle.high,
            clusterLow: candle.low,
            bars: [{
              timestamp: candle.timestamp,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              open: candle.open,
              bodyRatio,
              volumeRatio
            }],
            startTimestamp: candle.timestamp,
            lastTimestamp: candle.timestamp
          });
        }
      }
    }

    // Check for breakaway from any mature cluster
    const breakawayBodyRatio = range > 0 ? bodySize / range : 0;
    const isDecisiveCandle = breakawayBodyRatio > this.params.breakawayBodyRatio;

    if (isDecisiveCandle) {
      for (let i = this.absorptionClusters.length - 1; i >= 0; i--) {
        const cluster = this.absorptionClusters[i];

        if (cluster.bars.length < this.params.consecutiveBars) continue;

        const timeSinceLastAbsorption = this.toMs(candle.timestamp) - this.toMs(cluster.lastTimestamp);
        if (timeSinceLastAbsorption > 10 * 60 * 1000) {
          this.absorptionClusters.splice(i, 1);
          continue;
        }

        let signal = null;

        if (cluster.direction === 'bullish' && candle.close > candle.open) {
          if (candle.close > cluster.clusterHigh) {
            const entryPrice = candle.close;
            const naturalStop = cluster.clusterLow - this.params.stopBuffer;
            const naturalDist = entryPrice - naturalStop;

            // Find aligned fixed distance
            const alignedDist = this.findAlignedDistance(naturalDist);
            if (alignedDist === null) {
              if (debug) console.log(`[ABSORPTION] Bullish signal rejected: natural stop ${naturalDist.toFixed(1)}pts doesn't align with fixed distances`);
              continue;
            }

            // EMA trend filter
            if (this.params.requireTrendAlignment && this.getTrend() === 'bearish') {
              if (debug) console.log(`[ABSORPTION] Bullish signal rejected: bearish EMA trend`);
              continue;
            }

            const stopPrice = entryPrice - alignedDist;
            const targetPrice = entryPrice + alignedDist;

            signal = {
              strategy: 'OHLCV_ABSORPTION',
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
                detector: 'absorption',
                direction: 'bullish',
                cluster_bars: cluster.bars.length,
                cluster_high: roundTo(cluster.clusterHigh),
                cluster_low: roundTo(cluster.clusterLow),
                zone_center: roundTo(cluster.zoneCenter),
                avg_body_ratio: roundTo(cluster.bars.reduce((s, b) => s + b.bodyRatio, 0) / cluster.bars.length),
                avg_volume_ratio: roundTo(cluster.bars.reduce((s, b) => s + b.volumeRatio, 0) / cluster.bars.length),
                breakaway_body_ratio: roundTo(breakawayBodyRatio),
                natural_stop_dist: roundTo(naturalDist),
                aligned_dist: alignedDist,
                risk_points: alignedDist,
                ema_trend: this.getTrend(),
                ema_short: this.emaShort ? roundTo(this.emaShort) : null,
                ema_long: this.emaLong ? roundTo(this.emaLong) : null,
                atr: roundTo(currentATR),
                entry_reason: `Bullish absorption breakaway (${cluster.bars.length} bars), ${alignedDist}pt symmetric R:R`
              }
            };
          }
        } else if (cluster.direction === 'bearish' && candle.close < candle.open) {
          if (candle.close < cluster.clusterLow) {
            const entryPrice = candle.close;
            const naturalStop = cluster.clusterHigh + this.params.stopBuffer;
            const naturalDist = naturalStop - entryPrice;

            const alignedDist = this.findAlignedDistance(naturalDist);
            if (alignedDist === null) {
              if (debug) console.log(`[ABSORPTION] Bearish signal rejected: natural stop ${naturalDist.toFixed(1)}pts doesn't align with fixed distances`);
              continue;
            }

            if (this.params.requireTrendAlignment && this.getTrend() === 'bullish') {
              if (debug) console.log(`[ABSORPTION] Bearish signal rejected: bullish EMA trend`);
              continue;
            }

            const stopPrice = entryPrice + alignedDist;
            const targetPrice = entryPrice - alignedDist;

            signal = {
              strategy: 'OHLCV_ABSORPTION',
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
                detector: 'absorption',
                direction: 'bearish',
                cluster_bars: cluster.bars.length,
                cluster_high: roundTo(cluster.clusterHigh),
                cluster_low: roundTo(cluster.clusterLow),
                zone_center: roundTo(cluster.zoneCenter),
                avg_body_ratio: roundTo(cluster.bars.reduce((s, b) => s + b.bodyRatio, 0) / cluster.bars.length),
                avg_volume_ratio: roundTo(cluster.bars.reduce((s, b) => s + b.volumeRatio, 0) / cluster.bars.length),
                breakaway_body_ratio: roundTo(breakawayBodyRatio),
                natural_stop_dist: roundTo(naturalDist),
                aligned_dist: alignedDist,
                risk_points: alignedDist,
                ema_trend: this.getTrend(),
                ema_short: this.emaShort ? roundTo(this.emaShort) : null,
                ema_long: this.emaLong ? roundTo(this.emaLong) : null,
                atr: roundTo(currentATR),
                entry_reason: `Bearish absorption breakaway (${cluster.bars.length} bars), ${alignedDist}pt symmetric R:R`
              }
            };
          }
        }

        if (signal) {
          this.absorptionClusters.splice(i, 1);
          this.updateLastSignalTime(candle.timestamp);

          if (debug) {
            console.log(`[ABSORPTION] ${signal.side.toUpperCase()} signal: entry=${signal.price}, stop=${signal.stop_loss}, target=${signal.take_profit}, dist=${signal.metadata.aligned_dist}pt`);
          }
          return signal;
        }
      }
    }

    // Prune old clusters
    const currentMs = this.toMs(candle.timestamp);
    this.absorptionClusters = this.absorptionClusters.filter(cluster => {
      return (currentMs - this.toMs(cluster.lastTimestamp)) < 20 * 60 * 1000;
    });

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

  updateATR(candle, prevCandle) {
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevCandle.close),
      Math.abs(candle.low - prevCandle.close)
    );
    this.trueRanges.push(tr);
    if (this.trueRanges.length > this.params.atrPeriod) {
      this.trueRanges.shift();
    }
  }

  getCurrentATR() {
    if (this.trueRanges.length < this.params.atrPeriod) return 0;
    return this.trueRanges.reduce((a, b) => a + b, 0) / this.trueRanges.length;
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
    this.rollingVolumes = [];
    this.trueRanges = [];
    this.absorptionClusters = [];
    this.prevCandles = [];
    this.emaShort = null;
    this.emaLong = null;
    this.emaWarmup = 0;
  }

  getName() { return 'OHLCV_ABSORPTION'; }
  getDescription() { return 'OHLCV Absorption Detector v2 - symmetric R:R with structure-aligned stops'; }
  getRequiredMarketData() { return []; }
}

export default OHLCVAbsorptionStrategy;
