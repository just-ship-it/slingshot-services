// Volume-based Entry Filters
// Provides various volume analysis tools for filtering trade entries

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

/**
 * Volume Trend Filter
 * Checks if volume is trending up (increasing interest/conviction)
 */
export class VolumeTrendFilter {

  constructor(params = {}) {
    this.params = {
      // Period for volume SMA
      smaPeriod: params.smaPeriod || 5,
      // How many periods back to compare
      comparePeriods: params.comparePeriods || 3,
      // Minimum increase to consider "trending up"
      minIncreasePercent: params.minIncreasePercent || 0,
      ...params
    };
  }

  /**
   * Check if volume is trending up
   *
   * @param {object[]} candles - Array of candles with volume
   * @returns {object} {isTrendingUp: boolean, currentSMA: number, previousSMA: number, changePercent: number}
   */
  check(candles) {
    const requiredLength = this.params.smaPeriod + this.params.comparePeriods;

    if (!TechnicalAnalysis.validateData(candles, requiredLength)) {
      return {
        isTrendingUp: null,
        currentSMA: null,
        previousSMA: null,
        changePercent: null,
        reason: 'Insufficient data'
      };
    }

    const volumes = TechnicalAnalysis.getValues(candles, 'volume');

    // Current volume SMA
    const currentSMA = TechnicalAnalysis.sma(volumes, this.params.smaPeriod);

    // Previous volume SMA (comparePeriods back)
    const previousVolumes = volumes.slice(0, -this.params.comparePeriods);
    const previousSMA = TechnicalAnalysis.sma(previousVolumes, this.params.smaPeriod);

    if (currentSMA === null || previousSMA === null || previousSMA === 0) {
      return {
        isTrendingUp: null,
        currentSMA,
        previousSMA,
        changePercent: null,
        reason: 'Could not calculate SMAs'
      };
    }

    const changePercent = ((currentSMA - previousSMA) / previousSMA) * 100;
    const isTrendingUp = changePercent > this.params.minIncreasePercent;

    return {
      isTrendingUp,
      currentSMA,
      previousSMA,
      changePercent,
      reason: isTrendingUp ? 'Volume trending up' : 'Volume not trending up'
    };
  }

  /**
   * Static convenience method
   */
  static isVolumeTrendingUp(candles, lookback = 5) {
    const filter = new VolumeTrendFilter({ smaPeriod: lookback });
    const result = filter.check(candles);
    return result.isTrendingUp === true;
  }
}


/**
 * Volume Spike Detector
 * Detects when current volume is significantly above average
 */
export class VolumeSpikeDetector {

  constructor(params = {}) {
    this.params = {
      // Period for calculating average volume
      averagePeriod: params.averagePeriod || 20,
      // Threshold multiplier (1.5 = 50% above average)
      spikeThreshold: params.spikeThreshold || 1.5,
      // Optional: require spike on entry candle specifically
      requireEntrySpike: params.requireEntrySpike !== false,
      ...params
    };
  }

  /**
   * Check if current candle has a volume spike
   *
   * @param {object[]} candles - Array of candles with volume
   * @returns {object} {hasSpike: boolean, currentVolume: number, averageVolume: number, spikeRatio: number}
   */
  check(candles) {
    if (!TechnicalAnalysis.validateData(candles, this.params.averagePeriod + 1)) {
      return {
        hasSpike: null,
        currentVolume: null,
        averageVolume: null,
        spikeRatio: null,
        reason: 'Insufficient data'
      };
    }

    const volumes = TechnicalAnalysis.getValues(candles, 'volume');
    const currentVolume = volumes[volumes.length - 1];

    // Calculate average excluding current candle
    const previousVolumes = volumes.slice(0, -1);
    const averageVolume = TechnicalAnalysis.sma(previousVolumes, this.params.averagePeriod);

    if (averageVolume === null || averageVolume === 0) {
      return {
        hasSpike: null,
        currentVolume,
        averageVolume,
        spikeRatio: null,
        reason: 'Could not calculate average'
      };
    }

    const spikeRatio = currentVolume / averageVolume;
    const hasSpike = spikeRatio >= this.params.spikeThreshold;

    return {
      hasSpike,
      currentVolume,
      averageVolume,
      spikeRatio,
      reason: hasSpike
        ? `Volume spike detected (${spikeRatio.toFixed(2)}x average)`
        : `No spike (${spikeRatio.toFixed(2)}x average)`
    };
  }

  /**
   * Check volume over multiple recent candles
   *
   * @param {object[]} candles - Array of candles
   * @param {number} recentCount - Number of recent candles to check
   * @returns {object} Analysis of recent volume
   */
  checkRecent(candles, recentCount = 3) {
    if (!TechnicalAnalysis.validateData(candles, this.params.averagePeriod + recentCount)) {
      return {
        anySpike: null,
        spikesDetected: 0,
        maxSpikeRatio: null,
        reason: 'Insufficient data'
      };
    }

    const volumes = TechnicalAnalysis.getValues(candles, 'volume');
    const baselineVolumes = volumes.slice(0, -(recentCount));
    const averageVolume = TechnicalAnalysis.sma(baselineVolumes, this.params.averagePeriod);

    if (averageVolume === null || averageVolume === 0) {
      return {
        anySpike: null,
        spikesDetected: 0,
        maxSpikeRatio: null,
        reason: 'Could not calculate average'
      };
    }

    const recentVolumes = volumes.slice(-recentCount);
    let spikesDetected = 0;
    let maxSpikeRatio = 0;

    for (const vol of recentVolumes) {
      const ratio = vol / averageVolume;
      if (ratio >= this.params.spikeThreshold) {
        spikesDetected++;
      }
      maxSpikeRatio = Math.max(maxSpikeRatio, ratio);
    }

    return {
      anySpike: spikesDetected > 0,
      spikesDetected,
      maxSpikeRatio,
      averageVolume,
      reason: spikesDetected > 0
        ? `${spikesDetected} spike(s) in last ${recentCount} candles`
        : `No spikes in last ${recentCount} candles`
    };
  }

  /**
   * Static convenience method
   */
  static hasVolumeSpike(candles, threshold = 1.5, lookback = 20) {
    const detector = new VolumeSpikeDetector({
      averagePeriod: lookback,
      spikeThreshold: threshold
    });
    const result = detector.check(candles);
    return result.hasSpike === true;
  }
}


/**
 * Relative Volume Indicator
 * Calculates volume relative to historical averages
 */
export class RelativeVolume {

  constructor(params = {}) {
    this.params = {
      // Period for baseline calculation
      baselinePeriod: params.baselinePeriod || 20,
      ...params
    };
  }

  /**
   * Calculate relative volume (RVOL)
   * RVOL > 1 means above average, < 1 means below average
   *
   * @param {object[]} candles - Array of candles
   * @returns {object} {rvol: number, currentVolume: number, averageVolume: number}
   */
  calculate(candles) {
    if (!TechnicalAnalysis.validateData(candles, this.params.baselinePeriod + 1)) {
      return { rvol: null, currentVolume: null, averageVolume: null };
    }

    const volumes = TechnicalAnalysis.getValues(candles, 'volume');
    const currentVolume = volumes[volumes.length - 1];
    const averageVolume = TechnicalAnalysis.sma(volumes.slice(0, -1), this.params.baselinePeriod);

    if (averageVolume === null || averageVolume === 0) {
      return { rvol: null, currentVolume, averageVolume };
    }

    return {
      rvol: currentVolume / averageVolume,
      currentVolume,
      averageVolume
    };
  }

  /**
   * Calculate RVOL for each candle in array
   *
   * @param {object[]} candles - Array of candles
   * @returns {number[]} Array of RVOL values (null for insufficient data)
   */
  calculateSeries(candles) {
    const results = [];
    const volumes = TechnicalAnalysis.getValues(candles, 'volume');

    for (let i = 0; i < candles.length; i++) {
      if (i < this.params.baselinePeriod) {
        results.push(null);
        continue;
      }

      const previousVolumes = volumes.slice(i - this.params.baselinePeriod, i);
      const avg = previousVolumes.reduce((a, b) => a + b, 0) / this.params.baselinePeriod;

      if (avg === 0) {
        results.push(null);
      } else {
        results.push(volumes[i] / avg);
      }
    }

    return results;
  }
}


/**
 * Combined Volume Filter
 * Combines multiple volume conditions into a single filter
 */
export class CombinedVolumeFilter {

  constructor(params = {}) {
    this.params = {
      // Volume trend settings
      trendEnabled: params.trendEnabled !== false,
      trendPeriod: params.trendPeriod || 5,

      // Volume spike settings
      spikeEnabled: params.spikeEnabled !== false,
      spikeThreshold: params.spikeThreshold || 1.5,
      spikePeriod: params.spikePeriod || 20,

      // Minimum RVOL for entry
      minRvol: params.minRvol || 0.8,

      // Require all conditions or any
      requireAll: params.requireAll !== false,

      ...params
    };

    this.trendFilter = new VolumeTrendFilter({ smaPeriod: this.params.trendPeriod });
    this.spikeDetector = new VolumeSpikeDetector({
      averagePeriod: this.params.spikePeriod,
      spikeThreshold: this.params.spikeThreshold
    });
    this.relativeVolume = new RelativeVolume({ baselinePeriod: this.params.spikePeriod });
  }

  /**
   * Check all volume conditions
   *
   * @param {object[]} candles - Array of candles
   * @returns {object} Combined filter result
   */
  check(candles) {
    const results = {
      passes: false,
      trend: null,
      spike: null,
      rvol: null,
      conditions: []
    };

    // Check trend
    if (this.params.trendEnabled) {
      const trendResult = this.trendFilter.check(candles);
      results.trend = trendResult;
      if (trendResult.isTrendingUp === true) {
        results.conditions.push('trend_up');
      }
    }

    // Check spike
    if (this.params.spikeEnabled) {
      const spikeResult = this.spikeDetector.check(candles);
      results.spike = spikeResult;
      if (spikeResult.hasSpike === true) {
        results.conditions.push('volume_spike');
      }
    }

    // Check RVOL
    const rvolResult = this.relativeVolume.calculate(candles);
    results.rvol = rvolResult;
    if (rvolResult.rvol !== null && rvolResult.rvol >= this.params.minRvol) {
      results.conditions.push('rvol_ok');
    }

    // Determine pass/fail
    const enabledConditions = [];
    if (this.params.trendEnabled) enabledConditions.push('trend_up');
    if (this.params.spikeEnabled) enabledConditions.push('volume_spike');
    enabledConditions.push('rvol_ok');

    if (this.params.requireAll) {
      results.passes = results.conditions.length === enabledConditions.length;
    } else {
      results.passes = results.conditions.length > 0;
    }

    return results;
  }
}


export default {
  VolumeTrendFilter,
  VolumeSpikeDetector,
  RelativeVolume,
  CombinedVolumeFilter
};
