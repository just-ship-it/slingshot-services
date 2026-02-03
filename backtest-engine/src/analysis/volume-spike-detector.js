/**
 * Volume Spike Detector
 *
 * Detects statistically significant volume and range spikes
 * using rolling z-score calculations. Designed for high-accuracy
 * liquidity sweep detection.
 *
 * Features:
 * - Rolling window statistics with O(1) updates
 * - Separate volume and range tracking
 * - Configurable thresholds
 * - Session-aware resets
 */

/**
 * Efficient rolling statistics calculator
 * Uses Welford's online algorithm for numerical stability
 */
export class RollingStats {
  /**
   * @param {number} windowSize - Size of the rolling window
   */
  constructor(windowSize) {
    this.windowSize = windowSize;
    this.values = [];
    this.sum = 0;
    this.sumSquares = 0;
  }

  /**
   * Add a value and return current statistics
   * @param {number} value - Value to add
   * @returns {Object} { mean, stdDev, count, zScore }
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

    // Calculate variance with Bessel's correction for sample variance
    let variance = 0;
    if (count > 1) {
      variance = (this.sumSquares - (this.sum * this.sum) / count) / (count - 1);
      if (variance < 0) variance = 0; // Handle floating point errors
    }

    const stdDev = Math.sqrt(variance);
    const zScore = stdDev > 0 ? (value - mean) / stdDev : 0;

    return {
      mean,
      stdDev,
      count,
      zScore,
      value
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
   * Calculate z-score for a value without adding it
   * @param {number} value - Value to check
   * @returns {number} Z-score
   */
  zScore(value) {
    const stats = this.get();
    if (stats.stdDev === 0) return 0;
    return (value - stats.mean) / stats.stdDev;
  }

  /**
   * Get the percentile of a value in the distribution
   * @param {number} value - Value to check
   * @returns {number} Percentile (0-100)
   */
  percentile(value) {
    if (this.values.length === 0) return 50;

    const belowCount = this.values.filter(v => v < value).length;
    return (belowCount / this.values.length) * 100;
  }

  /**
   * Check if a value exceeds a z-score threshold
   * @param {number} value - Value to check
   * @param {number} threshold - Z-score threshold
   * @returns {boolean} True if exceeds threshold
   */
  exceedsThreshold(value, threshold) {
    return this.zScore(value) >= threshold;
  }

  /**
   * Reset the rolling window
   */
  reset() {
    this.values = [];
    this.sum = 0;
    this.sumSquares = 0;
  }

  /**
   * Get recent values
   * @param {number} count - Number of recent values to return
   * @returns {number[]} Recent values
   */
  getRecent(count = 10) {
    return this.values.slice(-count);
  }
}

/**
 * Volume Spike Detector
 *
 * Detects volume and range spikes that often accompany liquidity sweeps.
 * Uses separate rolling windows for volume and range to detect
 * statistically significant deviations.
 */
export class VolumeSpikeDetector {
  /**
   * @param {Object} config - Configuration options
   * @param {number} config.lookback - Rolling window size (default: 60 for 1s data, 20 for 1m)
   * @param {number} config.volumeThreshold - Volume z-score threshold (default: 2.0)
   * @param {number} config.rangeThreshold - Range z-score threshold (default: 1.5)
   * @param {number} config.minVolume - Minimum absolute volume to consider (default: 10)
   * @param {number} config.minRange - Minimum range in points (default: 2.0)
   */
  constructor(config = {}) {
    this.config = {
      lookback: config.lookback ?? 60,
      volumeThreshold: config.volumeThreshold ?? 2.0,
      rangeThreshold: config.rangeThreshold ?? 1.5,
      minVolume: config.minVolume ?? 10,
      minRange: config.minRange ?? 2.0
    };

    this.volumeStats = new RollingStats(this.config.lookback);
    this.rangeStats = new RollingStats(this.config.lookback);

    // Statistics
    this.stats = {
      candlesProcessed: 0,
      volumeSpikes: 0,
      rangeSpikes: 0,
      combinedSpikes: 0
    };
  }

  /**
   * Process a candle and detect spikes
   * @param {Object} candle - Candle with { volume, high, low }
   * @returns {Object|null} Spike info if detected, null otherwise
   */
  detect(candle) {
    this.stats.candlesProcessed++;

    const volume = candle.volume;
    const range = candle.high - candle.low;

    // Update rolling statistics
    const volumeResult = this.volumeStats.add(volume);
    const rangeResult = this.rangeStats.add(range);

    // Need enough data for meaningful statistics
    if (volumeResult.count < Math.min(20, this.config.lookback * 0.5)) {
      return null;
    }

    // Check minimum thresholds
    if (volume < this.config.minVolume || range < this.config.minRange) {
      return null;
    }

    // Check if volume exceeds threshold
    const volumeExceeds = volumeResult.zScore >= this.config.volumeThreshold;

    // Check if range exceeds threshold
    const rangeExceeds = rangeResult.zScore >= this.config.rangeThreshold;

    // Track stats
    if (volumeExceeds) this.stats.volumeSpikes++;
    if (rangeExceeds) this.stats.rangeSpikes++;

    // Both must exceed for a valid spike
    if (!volumeExceeds || !rangeExceeds) {
      return null;
    }

    this.stats.combinedSpikes++;

    // Calculate confidence based on how much thresholds are exceeded
    const volumeConfidence = Math.min(volumeResult.zScore / (this.config.volumeThreshold * 2), 1);
    const rangeConfidence = Math.min(rangeResult.zScore / (this.config.rangeThreshold * 2), 1);
    const confidence = (volumeConfidence + rangeConfidence) / 2;

    return {
      isSpike: true,
      volume: {
        value: volume,
        zScore: Math.round(volumeResult.zScore * 100) / 100,
        mean: Math.round(volumeResult.mean * 100) / 100,
        stdDev: Math.round(volumeResult.stdDev * 100) / 100,
        percentile: Math.round(this.volumeStats.percentile(volume) * 10) / 10
      },
      range: {
        value: Math.round(range * 100) / 100,
        zScore: Math.round(rangeResult.zScore * 100) / 100,
        mean: Math.round(rangeResult.mean * 100) / 100,
        stdDev: Math.round(rangeResult.stdDev * 100) / 100,
        percentile: Math.round(this.rangeStats.percentile(range) * 10) / 10
      },
      confidence: Math.round(confidence * 100) / 100,
      timestamp: candle.timestamp
    };
  }

  /**
   * Check if a candle would be a volume spike without updating state
   * @param {Object} candle - Candle to check
   * @returns {Object|null} Spike info if would be detected
   */
  peek(candle) {
    const volume = candle.volume;
    const range = candle.high - candle.low;

    if (volume < this.config.minVolume || range < this.config.minRange) {
      return null;
    }

    const volumeZ = this.volumeStats.zScore(volume);
    const rangeZ = this.rangeStats.zScore(range);

    if (volumeZ >= this.config.volumeThreshold && rangeZ >= this.config.rangeThreshold) {
      return {
        isSpike: true,
        volumeZScore: Math.round(volumeZ * 100) / 100,
        rangeZScore: Math.round(rangeZ * 100) / 100
      };
    }

    return null;
  }

  /**
   * Detect spike with custom thresholds
   * @param {Object} candle - Candle to check
   * @param {number} volumeThreshold - Custom volume z-score threshold
   * @param {number} rangeThreshold - Custom range z-score threshold
   * @returns {Object|null} Spike info if detected
   */
  detectWithThresholds(candle, volumeThreshold, rangeThreshold) {
    const volume = candle.volume;
    const range = candle.high - candle.low;

    // Update rolling statistics
    const volumeResult = this.volumeStats.add(volume);
    const rangeResult = this.rangeStats.add(range);

    if (volumeResult.count < 20) return null;
    if (volume < this.config.minVolume || range < this.config.minRange) return null;

    const volumeExceeds = volumeResult.zScore >= volumeThreshold;
    const rangeExceeds = rangeResult.zScore >= rangeThreshold;

    if (!volumeExceeds || !rangeExceeds) return null;

    return {
      isSpike: true,
      volume: {
        value: volume,
        zScore: Math.round(volumeResult.zScore * 100) / 100
      },
      range: {
        value: Math.round(range * 100) / 100,
        zScore: Math.round(rangeResult.zScore * 100) / 100
      }
    };
  }

  /**
   * Get the current state of the detector
   * @returns {Object} Current state
   */
  getState() {
    return {
      volumeStats: this.volumeStats.get(),
      rangeStats: this.rangeStats.get(),
      config: { ...this.config }
    };
  }

  /**
   * Reset the detector (call when switching days/sessions)
   */
  reset() {
    this.volumeStats.reset();
    this.rangeStats.reset();
  }

  /**
   * Get detection statistics
   * @returns {Object} Stats
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
      volumeSpikes: 0,
      rangeSpikes: 0,
      combinedSpikes: 0
    };
  }

  /**
   * Get configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Update configuration
   * @param {Object} newConfig - New configuration values
   */
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);

    // Rebuild rolling windows if lookback changed
    if (newConfig.lookback && newConfig.lookback !== this.volumeStats.windowSize) {
      this.volumeStats = new RollingStats(newConfig.lookback);
      this.rangeStats = new RollingStats(newConfig.lookback);
    }
  }
}

export default VolumeSpikeDetector;
