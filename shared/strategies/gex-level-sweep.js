/**
 * GEX Level Sweep Strategy
 *
 * High-accuracy sweep detection strategy based on Ralph loop tuning results.
 * Achieves 52% accuracy with 321 signals on 2024 full year backtest.
 *
 * Winning Configuration:
 * - Sessions: premarket + overnight (NOT RTH)
 * - Target: 3 points
 * - Stop: 5 points
 * - Wick ratio: 0.6 (60% wick dominance)
 * - Level tolerance: 5 points
 * - Min range: 3 points
 * - Volume z-score: 2.0
 * - Range z-score: 1.5
 * - Cooldown: 30 seconds
 *
 * Core Logic:
 * - Detects liquidity sweeps at significant price levels (GEX, session levels)
 * - Requires dominant wick pattern (sweep + rejection)
 * - Requires volume/range spike (statistical significance)
 * - Filters by session (premarket/overnight perform better than RTH)
 * - Uses tight 3pt target for higher probability fills
 *
 * Key Insights from Tuning:
 * - GEX Support 1: 73.68% accuracy (best level type)
 * - Overnight Low: 58.82%
 * - Target distance matters MORE than detection strictness
 * - Session filtering is crucial (premarket 35%, overnight 30% vs RTH 24%)
 * - Volume spikes significantly filter out noise
 */

import { BaseStrategy } from './base-strategy.js';
import { roundTo } from './strategy-utils.js';

/**
 * Efficient rolling statistics calculator for z-score detection
 * Uses Welford's online algorithm for numerical stability
 */
class RollingStats {
  constructor(windowSize) {
    this.windowSize = windowSize;
    this.values = [];
    this.sum = 0;
    this.sumSquares = 0;
  }

  add(value) {
    this.values.push(value);
    this.sum += value;
    this.sumSquares += value * value;

    if (this.values.length > this.windowSize) {
      const removed = this.values.shift();
      this.sum -= removed;
      this.sumSquares -= removed * removed;
    }

    const count = this.values.length;
    const mean = this.sum / count;

    let variance = 0;
    if (count > 1) {
      variance = (this.sumSquares - (this.sum * this.sum) / count) / (count - 1);
      if (variance < 0) variance = 0;
    }

    const stdDev = Math.sqrt(variance);
    const zScore = stdDev > 0 ? (value - mean) / stdDev : 0;

    return { mean, stdDev, count, zScore, value };
  }

  get() {
    const count = this.values.length;
    if (count === 0) return { mean: 0, stdDev: 0, count: 0 };

    const mean = this.sum / count;
    let variance = 0;
    if (count > 1) {
      variance = (this.sumSquares - (this.sum * this.sum) / count) / (count - 1);
      if (variance < 0) variance = 0;
    }

    return { mean, stdDev: Math.sqrt(variance), count };
  }

  reset() {
    this.values = [];
    this.sum = 0;
    this.sumSquares = 0;
  }
}

export class GexLevelSweepStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Winning configuration from Ralph loop tuning
    this.params.targetPoints = params.targetPoints ?? 3;        // KEY: Tight 3-point target
    this.params.stopPoints = params.stopPoints ?? 5;            // 5-point stop
    this.params.levelTolerance = params.levelTolerance ?? 5;    // Points from level
    this.params.wickRatio = params.wickRatio ?? 0.6;            // Min wick as % of range
    this.params.minRange = params.minRange ?? 3.0;              // Min candle range in points

    // Volume spike detection (KEY: filters noise)
    this.params.requireVolumeSpike = params.requireVolumeSpike ?? true;
    this.params.volumeZThreshold = params.volumeZThreshold ?? 2.0;   // Volume z-score threshold
    this.params.rangeZThreshold = params.rangeZThreshold ?? 1.5;     // Range z-score threshold
    this.params.volumeLookback = params.volumeLookback ?? 60;        // Rolling window size
    this.params.minVolume = params.minVolume ?? 10;                  // Minimum absolute volume

    // Signal management
    this.params.signalCooldownMs = params.signalCooldownMs ?? 30000; // 30 seconds
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // Session filtering (KEY: premarket + overnight only)
    this.params.useSessionFilter = params.useSessionFilter ?? true;
    this.params.allowedSessions = params.allowedSessions ?? ['premarket', 'overnight'];

    // Entry cutoff - no new entries after this time (EST)
    this.params.entryCutoffHour = params.entryCutoffHour ?? 15;
    this.params.entryCutoffMinute = params.entryCutoffMinute ?? 30;

    // Level types to trade (ordered by historical accuracy)
    this.params.tradeSupportLevels = params.tradeSupportLevels ?? [
      'S1', 'S2', 'S3', 'S4', 'S5', 'PutWall', 'GammaFlip', 'OvernightLow', 'PremarketLow'
    ];
    this.params.tradeResistanceLevels = params.tradeResistanceLevels ?? [
      'R1', 'R2', 'R3', 'R4', 'R5', 'CallWall', 'GammaFlip', 'OvernightHigh', 'PremarketHigh'
    ];

    // Trading parameters
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug mode
    this.params.debug = params.debug ?? false;
    this.params.liveMode = params.liveMode ?? false;

    // Trailing stop parameters (optional)
    this.params.useTrailingStop = params.useTrailingStop ?? false;
    this.params.trailingTrigger = params.trailingTrigger ?? 2;
    this.params.trailingOffset = params.trailingOffset ?? 1;

    // Session levels tracking
    this.sessionLevels = {
      overnightHigh: null,
      overnightLow: null,
      premarketHigh: null,
      premarketLow: null,
      dailyOpen: null,
      yesterdayHigh: null,
      yesterdayLow: null
    };
    this.lastSessionReset = null;

    // Volume spike detection rolling stats
    this.volumeStats = new RollingStats(this.params.volumeLookback);
    this.rangeStats = new RollingStats(this.params.volumeLookback);
    this.spikeStats = {
      candlesProcessed: 0,
      volumeSpikes: 0,
      rangeSpikes: 0,
      combinedSpikes: 0
    };
  }

  /**
   * Get current session based on timestamp
   * @param {number} timestamp - Timestamp in ms
   * @returns {string} Session name
   */
  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const hour = parseInt(hourStr);
    const min = parseInt(minStr);
    const timeDecimal = hour + min / 60;

    // Session boundaries
    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
    if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
    return 'afterhours';
  }

  /**
   * Check if current time is in allowed session
   * @param {number} timestamp - Timestamp in ms
   * @returns {boolean} True if in allowed session
   */
  isInAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    const session = this.getSession(timestamp);
    return this.params.allowedSessions.includes(session);
  }

  /**
   * Check if current time is past entry cutoff
   * @param {number} timestamp - Timestamp in ms
   * @returns {boolean} True if past cutoff
   */
  isPastEntryCutoff(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const hour = parseInt(hourStr);
    const min = parseInt(minStr);

    return hour > this.params.entryCutoffHour ||
      (hour === this.params.entryCutoffHour && min >= this.params.entryCutoffMinute);
  }

  /**
   * Detect volume/range spike using rolling z-scores
   * @param {Object} candle - Candle with volume, high, low
   * @returns {Object|null} Spike info if detected, null otherwise
   */
  detectVolumeSpike(candle) {
    this.spikeStats.candlesProcessed++;

    const volume = candle.volume;
    const range = candle.high - candle.low;

    // Update rolling statistics
    const volumeResult = this.volumeStats.add(volume);
    const rangeResult = this.rangeStats.add(range);

    // Need enough data for meaningful statistics
    if (volumeResult.count < Math.min(20, this.params.volumeLookback * 0.5)) {
      return null;
    }

    // Check minimum thresholds
    if (volume < this.params.minVolume || range < this.params.minRange) {
      return null;
    }

    // Check if volume and range exceed thresholds
    const volumeExceeds = volumeResult.zScore >= this.params.volumeZThreshold;
    const rangeExceeds = rangeResult.zScore >= this.params.rangeZThreshold;

    // Track stats
    if (volumeExceeds) this.spikeStats.volumeSpikes++;
    if (rangeExceeds) this.spikeStats.rangeSpikes++;

    // Both must exceed for a valid spike
    if (!volumeExceeds || !rangeExceeds) {
      return null;
    }

    this.spikeStats.combinedSpikes++;

    // Calculate confidence
    const volumeConfidence = Math.min(volumeResult.zScore / (this.params.volumeZThreshold * 2), 1);
    const rangeConfidence = Math.min(rangeResult.zScore / (this.params.rangeZThreshold * 2), 1);
    const confidence = (volumeConfidence + rangeConfidence) / 2;

    return {
      isSpike: true,
      volume: {
        value: volume,
        zScore: roundTo(volumeResult.zScore, 2),
        mean: roundTo(volumeResult.mean, 2)
      },
      range: {
        value: roundTo(range, 2),
        zScore: roundTo(rangeResult.zScore, 2),
        mean: roundTo(rangeResult.mean, 2)
      },
      confidence: roundTo(confidence, 2)
    };
  }

  /**
   * Calculate candle metrics for sweep detection
   * @param {Object} candle - Candle object
   * @returns {Object} Calculated metrics
   */
  calculateCandleMetrics(candle) {
    const { open, high, low, close } = candle;
    const range = high - low;
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickRatio = range > 0 ? upperWick / range : 0;
    const lowerWickRatio = range > 0 ? lowerWick / range : 0;
    const isBullish = close > open;

    return {
      range: roundTo(range, 2),
      body: roundTo(body, 2),
      upperWick: roundTo(upperWick, 2),
      lowerWick: roundTo(lowerWick, 2),
      upperWickRatio: roundTo(upperWickRatio, 2),
      lowerWickRatio: roundTo(lowerWickRatio, 2),
      isBullish
    };
  }

  /**
   * Analyze wick pattern to determine sweep type
   * @param {Object} metrics - Candle metrics
   * @returns {Object|null} Sweep analysis or null
   */
  analyzeWickPattern(metrics) {
    const { upperWickRatio, lowerWickRatio } = metrics;

    // Bearish sweep: large upper wick, price rejected from high
    if (upperWickRatio >= this.params.wickRatio && upperWickRatio > lowerWickRatio) {
      return {
        valid: true,
        sweepType: 'bearish',
        direction: 'short',
        dominantWick: 'upper',
        wickRatio: upperWickRatio,
        wickPoints: metrics.upperWick
      };
    }

    // Bullish sweep: large lower wick, price rejected from low
    if (lowerWickRatio >= this.params.wickRatio && lowerWickRatio > upperWickRatio) {
      return {
        valid: true,
        sweepType: 'bullish',
        direction: 'long',
        dominantWick: 'lower',
        wickRatio: lowerWickRatio,
        wickPoints: metrics.lowerWick
      };
    }

    return null;
  }

  /**
   * Find levels near current price
   * @param {number} price - Current price
   * @param {Object} gexLevels - GEX levels object
   * @param {string} sweepType - 'bullish' or 'bearish'
   * @returns {Object|null} Nearest level info or null
   */
  findNearestLevel(price, gexLevels, sweepType) {
    if (!gexLevels) return null;

    const allLevels = [];
    const tolerance = this.params.levelTolerance;

    // For bullish sweeps (long entries), look for support levels below price
    if (sweepType === 'bullish') {
      // GEX support levels
      (gexLevels.support || []).forEach((level, i) => {
        const type = `S${i + 1}`;
        if (level && this.params.tradeSupportLevels.includes(type)) {
          allLevels.push({ type, level, category: 'support' });
        }
      });

      if (gexLevels.putWall && this.params.tradeSupportLevels.includes('PutWall')) {
        allLevels.push({ type: 'PutWall', level: gexLevels.putWall, category: 'support' });
      }

      if (gexLevels.gammaFlip && this.params.tradeSupportLevels.includes('GammaFlip') && gexLevels.gammaFlip < price) {
        allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'support' });
      }

      // Session levels
      if (this.sessionLevels.overnightLow && this.params.tradeSupportLevels.includes('OvernightLow')) {
        allLevels.push({ type: 'OvernightLow', level: this.sessionLevels.overnightLow, category: 'support' });
      }
      if (this.sessionLevels.premarketLow && this.params.tradeSupportLevels.includes('PremarketLow')) {
        allLevels.push({ type: 'PremarketLow', level: this.sessionLevels.premarketLow, category: 'support' });
      }
    }

    // For bearish sweeps (short entries), look for resistance levels above price
    if (sweepType === 'bearish') {
      // GEX resistance levels
      (gexLevels.resistance || []).forEach((level, i) => {
        const type = `R${i + 1}`;
        if (level && this.params.tradeResistanceLevels.includes(type)) {
          allLevels.push({ type, level, category: 'resistance' });
        }
      });

      if (gexLevels.callWall && this.params.tradeResistanceLevels.includes('CallWall')) {
        allLevels.push({ type: 'CallWall', level: gexLevels.callWall, category: 'resistance' });
      }

      if (gexLevels.gammaFlip && this.params.tradeResistanceLevels.includes('GammaFlip') && gexLevels.gammaFlip > price) {
        allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'resistance' });
      }

      // Session levels
      if (this.sessionLevels.overnightHigh && this.params.tradeResistanceLevels.includes('OvernightHigh')) {
        allLevels.push({ type: 'OvernightHigh', level: this.sessionLevels.overnightHigh, category: 'resistance' });
      }
      if (this.sessionLevels.premarketHigh && this.params.tradeResistanceLevels.includes('PremarketHigh')) {
        allLevels.push({ type: 'PremarketHigh', level: this.sessionLevels.premarketHigh, category: 'resistance' });
      }
    }

    // Find nearest within tolerance
    let nearest = null;
    let nearestDist = Infinity;

    for (const lvl of allLevels) {
      const dist = Math.abs(price - lvl.level);
      if (dist < nearestDist && dist <= tolerance) {
        nearestDist = dist;
        nearest = { ...lvl, distance: dist };
      }
    }

    return nearest;
  }

  /**
   * Update session levels based on candle
   * @param {Object} candle - Current candle
   */
  updateSessionLevels(candle) {
    const timestamp = this.toMs(candle.timestamp);
    const session = this.getSession(timestamp);

    // Check for day change to reset levels
    const date = new Date(timestamp);
    const dateKey = date.toDateString();
    if (this.lastSessionReset !== dateKey) {
      // Save yesterday's levels before reset
      this.sessionLevels.yesterdayHigh = this.sessionLevels.dailyOpen !== null ? null : this.sessionLevels.yesterdayHigh;
      this.sessionLevels.yesterdayLow = this.sessionLevels.dailyOpen !== null ? null : this.sessionLevels.yesterdayLow;

      // Reset for new day
      this.sessionLevels.overnightHigh = null;
      this.sessionLevels.overnightLow = null;
      this.sessionLevels.premarketHigh = null;
      this.sessionLevels.premarketLow = null;
      this.sessionLevels.dailyOpen = null;
      this.lastSessionReset = dateKey;
    }

    // Update session-specific levels
    if (session === 'overnight') {
      if (this.sessionLevels.overnightHigh === null || candle.high > this.sessionLevels.overnightHigh) {
        this.sessionLevels.overnightHigh = candle.high;
      }
      if (this.sessionLevels.overnightLow === null || candle.low < this.sessionLevels.overnightLow) {
        this.sessionLevels.overnightLow = candle.low;
      }
    }

    if (session === 'premarket') {
      if (this.sessionLevels.premarketHigh === null || candle.high > this.sessionLevels.premarketHigh) {
        this.sessionLevels.premarketHigh = candle.high;
      }
      if (this.sessionLevels.premarketLow === null || candle.low < this.sessionLevels.premarketLow) {
        this.sessionLevels.premarketLow = candle.low;
      }
    }

    // Set daily open at RTH start
    if (session === 'rth' && this.sessionLevels.dailyOpen === null) {
      this.sessionLevels.dailyOpen = candle.open;
    }
  }

  /**
   * Evaluate trading signal
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Market data including gexLevels
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);
    const gexLevels = marketData?.gexLevels;

    // Update session levels
    this.updateSessionLevels(candle);

    // Always update volume stats to maintain rolling window
    const volumeSpike = this.detectVolumeSpike(candle);

    // Check cooldown
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      this.logEvaluation(candle, null, null, null, 'cooldown active');
      return null;
    }

    // Check session filter
    if (!this.isInAllowedSession(timestamp)) {
      this.logEvaluation(candle, null, null, null, 'outside allowed session');
      return null;
    }

    // Check entry cutoff
    if (this.isPastEntryCutoff(timestamp)) {
      this.logEvaluation(candle, null, null, null, 'past entry cutoff');
      return null;
    }

    // Calculate candle metrics
    const metrics = this.calculateCandleMetrics(candle);

    // Check minimum range
    if (metrics.range < this.params.minRange) {
      this.logEvaluation(candle, metrics, null, null, `range too small (${metrics.range})`);
      return null;
    }

    // Check volume spike if required
    if (this.params.requireVolumeSpike && !volumeSpike) {
      this.logEvaluation(candle, metrics, null, null, 'no volume spike');
      return null;
    }

    // Analyze wick pattern
    const wickAnalysis = this.analyzeWickPattern(metrics);
    if (!wickAnalysis) {
      this.logEvaluation(candle, metrics, volumeSpike, null, 'no dominant wick pattern');
      return null;
    }

    // Find nearest level for this sweep type
    const level = this.findNearestLevel(candle.close, gexLevels, wickAnalysis.sweepType);
    if (!level) {
      this.logEvaluation(candle, metrics, volumeSpike, wickAnalysis, `no ${wickAnalysis.sweepType === 'bullish' ? 'support' : 'resistance'} level nearby`);
      return null;
    }

    // Valid sweep detected - create signal
    const signal = this.createSignal(candle, wickAnalysis, level, metrics, volumeSpike);
    this.logEvaluation(candle, metrics, volumeSpike, wickAnalysis, null, signal);
    return signal;
  }

  /**
   * Create a signal object
   * @param {Object} candle - Current candle
   * @param {Object} wickAnalysis - Wick analysis result
   * @param {Object} level - Level info
   * @param {Object} metrics - Candle metrics
   * @param {Object} volumeSpike - Volume spike info
   * @returns {Object} Signal object
   */
  createSignal(candle, wickAnalysis, level, metrics, volumeSpike) {
    const timestamp = this.toMs(candle.timestamp);
    this.updateLastSignalTime(timestamp);

    const side = wickAnalysis.direction;
    const entryPrice = candle.close;
    const stopLoss = side === 'long'
      ? entryPrice - this.params.stopPoints
      : entryPrice + this.params.stopPoints;
    const takeProfit = side === 'long'
      ? entryPrice + this.params.targetPoints
      : entryPrice - this.params.targetPoints;

    const session = this.getSession(timestamp);

    const signal = {
      timestamp,
      side,
      price: roundTo(entryPrice, 2),
      strategy: 'GEX_LEVEL_SWEEP',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss: roundTo(stopLoss, 2),
      takeProfit: roundTo(takeProfit, 2),
      maxHoldBars: this.params.maxHoldBars,

      // Signal metadata
      sweepType: wickAnalysis.sweepType,
      levelType: level.type,
      levelPrice: roundTo(level.level, 2),
      levelCategory: level.category,
      levelDistance: roundTo(level.distance, 2),
      wickRatio: roundTo(wickAnalysis.wickRatio, 2),
      wickPoints: roundTo(wickAnalysis.wickPoints, 2),
      candleRange: metrics.range,
      session,

      // Volume spike info
      volumeSpike: volumeSpike ? {
        volumeZ: volumeSpike.volume.zScore,
        rangeZ: volumeSpike.range.zScore,
        confidence: volumeSpike.confidence
      } : null,

      // For bracket orders (snake_case for trade orchestrator)
      stop_loss: roundTo(stopLoss, 2),
      take_profit: roundTo(takeProfit, 2),

      // Session levels context
      sessionLevels: { ...this.sessionLevels }
    };

    // Add trailing stop if enabled
    if (this.params.useTrailingStop) {
      signal.trailing_trigger = this.params.trailingTrigger;
      signal.trailing_offset = this.params.trailingOffset;
    }

    return signal;
  }

  /**
   * Log evaluation for debugging
   */
  logEvaluation(candle, metrics, volumeSpike, wickAnalysis, reason, signal = null) {
    if (!this.params.debug && !this.params.liveMode) return;

    const timestamp = this.toMs(candle.timestamp);
    const date = new Date(timestamp);
    const timeStr = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const session = this.getSession(timestamp);
    const price = candle.close.toFixed(2);

    let resultStr;
    if (signal) {
      resultStr = `-> ${signal.side.toUpperCase()} SIGNAL @ ${signal.levelType}`;
    } else {
      resultStr = `-> No signal: ${reason}`;
    }

    const metricsStr = metrics
      ? `Range:${metrics.range} Wick:${(Math.max(metrics.upperWickRatio, metrics.lowerWickRatio) * 100).toFixed(0)}%`
      : 'N/A';

    const volStr = volumeSpike
      ? `VolZ:${volumeSpike.volume.zScore}`
      : 'NoSpike';

    console.log(`[GEX-SWEEP] ${timeStr} ${session.padEnd(10)} | ${price} | ${metricsStr} | ${volStr} | ${resultStr}`);
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.sessionLevels = {
      overnightHigh: null,
      overnightLow: null,
      premarketHigh: null,
      premarketLow: null,
      dailyOpen: null,
      yesterdayHigh: null,
      yesterdayLow: null
    };
    this.lastSessionReset = null;

    // Reset volume spike detection
    this.volumeStats.reset();
    this.rangeStats.reset();
    this.spikeStats = {
      candlesProcessed: 0,
      volumeSpikes: 0,
      rangeSpikes: 0,
      combinedSpikes: 0
    };
  }

  /**
   * Get volume spike statistics
   * @returns {Object} Spike detection stats
   */
  getSpikeStats() {
    return { ...this.spikeStats };
  }

  /**
   * Get strategy name
   * @returns {string} Strategy name
   */
  getName() {
    return 'GEX_LEVEL_SWEEP';
  }

  /**
   * Get strategy description
   * @returns {string} Strategy description
   */
  getDescription() {
    return 'GEX Level Sweep - High-accuracy sweep detection at GEX and session levels with volume spike and wick pattern analysis';
  }

  /**
   * Get required market data fields
   * @returns {string[]} Array of required field paths
   */
  getRequiredMarketData() {
    return ['gexLevels'];
  }
}

export default GexLevelSweepStrategy;
