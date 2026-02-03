/**
 * Liquidity Sweep Detector
 *
 * Detects liquidity sweep patterns in 1-second OHLCV data.
 * A liquidity sweep occurs when price spikes to sweep stop losses,
 * then reverses - indicated by high volume and large wicks.
 *
 * Bearish Sweep (SHORT opportunity): Large upper wick, price spiked up then reversed down
 * Bullish Sweep (LONG opportunity): Large lower wick, price spiked down then reversed up
 */

/**
 * Rolling statistics calculator for efficient streaming computation
 */
class RollingStats {
  constructor(windowSize) {
    this.windowSize = windowSize;
    this.values = [];
    this.sum = 0;
    this.sumSquares = 0;
  }

  /**
   * Add a value and return current mean and standard deviation
   * @param {number} value - Value to add
   * @returns {Object} { mean, stdDev, count }
   */
  add(value) {
    this.values.push(value);
    this.sum += value;
    this.sumSquares += value * value;

    // Remove oldest value if window exceeded
    if (this.values.length > this.windowSize) {
      const removed = this.values.shift();
      this.sum -= removed;
      this.sumSquares -= removed * removed;
    }

    const count = this.values.length;
    const mean = this.sum / count;

    // Welford's algorithm for numerical stability
    let variance = 0;
    if (count > 1) {
      variance = (this.sumSquares - (this.sum * this.sum) / count) / (count - 1);
      if (variance < 0) variance = 0; // Handle floating point errors
    }

    return {
      mean,
      stdDev: Math.sqrt(variance),
      count
    };
  }

  /**
   * Get current statistics without adding a value
   * @returns {Object} { mean, stdDev, count }
   */
  get() {
    const count = this.values.length;
    if (count === 0) return { mean: 0, stdDev: 0, count: 0 };

    const mean = this.sum / count;
    let variance = 0;
    if (count > 1) {
      variance = (this.sumSquares - (this.sum * this.sum) / count) / (count - 1);
      if (variance < 0) variance = 0;
    }

    return {
      mean,
      stdDev: Math.sqrt(variance),
      count
    };
  }

  /**
   * Reset the rolling window
   */
  reset() {
    this.values = [];
    this.sum = 0;
    this.sumSquares = 0;
  }
}

export class LiquiditySweepDetector {
  /**
   * Create a new detector with configurable thresholds
   *
   * @param {Object} config - Configuration options
   * @param {number} config.volumeStdDev - Volume must be X std devs above mean (default: 2.0)
   * @param {number} config.rangeStdDev - Range must be X std devs above mean (default: 1.5)
   * @param {number} config.wickRatio - Wick must be X% of total range (default: 0.6)
   * @param {number} config.lookback - Rolling window size in seconds (default: 60)
   * @param {number} config.minRange - Minimum candle range in points (default: 2.0)
   */
  constructor(config = {}) {
    this.volumeStdDevThreshold = config.volumeStdDev ?? 2.0;
    this.rangeStdDevThreshold = config.rangeStdDev ?? 1.5;
    this.wickRatioThreshold = config.wickRatio ?? 0.6;
    this.lookbackPeriod = config.lookback ?? 60;
    this.minRange = config.minRange ?? 2.0;

    // Rolling statistics trackers
    this.volumeStats = new RollingStats(this.lookbackPeriod);
    this.rangeStats = new RollingStats(this.lookbackPeriod);

    // Track detection stats
    this.stats = {
      candlesProcessed: 0,
      sweepsDetected: 0,
      bullishSweeps: 0,
      bearishSweeps: 0
    };
  }

  /**
   * Process a candle and detect if it's a liquidity sweep
   *
   * @param {Object} candle - Candle object with open, high, low, close, volume, timestamp, symbol
   * @returns {Object|null} Sweep detection result or null if no sweep detected
   */
  detectSweep(candle) {
    this.stats.candlesProcessed++;

    // Calculate candle metrics
    const range = candle.high - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const body = Math.abs(candle.close - candle.open);

    // Update rolling statistics and get current values
    const volumeStatsResult = this.volumeStats.add(candle.volume);
    const rangeStatsResult = this.rangeStats.add(range);

    // Need enough data for meaningful statistics
    if (volumeStatsResult.count < Math.min(30, this.lookbackPeriod)) {
      return null;
    }

    // Skip if range is too small (avoid noise)
    if (range < this.minRange) {
      return null;
    }

    // Calculate z-scores
    const volumeZScore = volumeStatsResult.stdDev > 0
      ? (candle.volume - volumeStatsResult.mean) / volumeStatsResult.stdDev
      : 0;

    const rangeZScore = rangeStatsResult.stdDev > 0
      ? (range - rangeStatsResult.mean) / rangeStatsResult.stdDev
      : 0;

    // Check if volume and range exceed thresholds
    const volumeExceeds = volumeZScore >= this.volumeStdDevThreshold;
    const rangeExceeds = rangeZScore >= this.rangeStdDevThreshold;

    if (!volumeExceeds || !rangeExceeds) {
      return null;
    }

    // Calculate wick ratios
    const upperWickRatio = range > 0 ? upperWick / range : 0;
    const lowerWickRatio = range > 0 ? lowerWick / range : 0;

    // Determine sweep type
    let sweepType = null;
    let wickRatio = 0;
    let dominantWick = 0;

    if (upperWickRatio >= this.wickRatioThreshold && upperWickRatio > lowerWickRatio) {
      // Bearish sweep: price spiked up (upper wick), reversed down
      sweepType = 'bearish';
      wickRatio = upperWickRatio;
      dominantWick = upperWick;
    } else if (lowerWickRatio >= this.wickRatioThreshold && lowerWickRatio > upperWickRatio) {
      // Bullish sweep: price spiked down (lower wick), reversed up
      sweepType = 'bullish';
      wickRatio = lowerWickRatio;
      dominantWick = lowerWick;
    }

    if (!sweepType) {
      return null;
    }

    // Calculate confidence score (0-1) based on how much thresholds are exceeded
    const volumeConfidence = Math.min(volumeZScore / (this.volumeStdDevThreshold * 2), 1);
    const rangeConfidence = Math.min(rangeZScore / (this.rangeStdDevThreshold * 2), 1);
    const wickConfidence = Math.min(wickRatio / (this.wickRatioThreshold + 0.2), 1);
    const confidence = (volumeConfidence + rangeConfidence + wickConfidence) / 3;

    // Update stats
    this.stats.sweepsDetected++;
    if (sweepType === 'bullish') {
      this.stats.bullishSweeps++;
    } else {
      this.stats.bearishSweeps++;
    }

    return {
      type: sweepType,
      timestamp: candle.timestamp,
      symbol: candle.symbol,
      entryPrice: candle.close,
      confidence: Math.round(confidence * 100) / 100,
      metrics: {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        range: Math.round(range * 100) / 100,
        upperWick: Math.round(upperWick * 100) / 100,
        lowerWick: Math.round(lowerWick * 100) / 100,
        body: Math.round(body * 100) / 100,
        wickRatio: Math.round(wickRatio * 100) / 100,
        volumeZScore: Math.round(volumeZScore * 100) / 100,
        rangeZScore: Math.round(rangeZScore * 100) / 100,
        volumeMean: Math.round(volumeStatsResult.mean * 100) / 100,
        volumeStdDev: Math.round(volumeStatsResult.stdDev * 100) / 100,
        rangeMean: Math.round(rangeStatsResult.mean * 100) / 100,
        rangeStdDev: Math.round(rangeStatsResult.stdDev * 100) / 100
      }
    };
  }

  /**
   * Reset the detector state (call when switching to a new day/period)
   */
  reset() {
    this.volumeStats.reset();
    this.rangeStats.reset();
  }

  /**
   * Get detection statistics
   * @returns {Object} Detection stats
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      candlesProcessed: 0,
      sweepsDetected: 0,
      bullishSweeps: 0,
      bearishSweeps: 0
    };
  }

  /**
   * Get configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      volumeStdDevThreshold: this.volumeStdDevThreshold,
      rangeStdDevThreshold: this.rangeStdDevThreshold,
      wickRatioThreshold: this.wickRatioThreshold,
      lookbackPeriod: this.lookbackPeriod,
      minRange: this.minRange
    };
  }
}
