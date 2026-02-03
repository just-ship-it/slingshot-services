// Volume Delta Proxy Indicator
// Calculates a proxy for volume delta using candle direction and volume
// This is a FREE approximation - true CVD requires tick-level trade data with side classification

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

export class VolumeDeltaProxy {

  constructor(params = {}) {
    this.params = {
      // EMA period for smoothing delta
      emaPeriod: params.emaPeriod || 14,
      // Lookback for slope calculation
      slopeLookback: params.slopeLookback || 5,
      // Use body ratio weighting (stronger signal when body is large relative to range)
      useBodyRatioWeighting: params.useBodyRatioWeighting !== false,
      ...params
    };

    // Rolling state for cumulative calculations
    this.cumulativeDelta = 0;
    this.deltaHistory = [];
    this.cumulativeHistory = [];
    this.emaValue = null;
  }

  /**
   * Reset the indicator state (call at session start)
   */
  reset() {
    this.cumulativeDelta = 0;
    this.deltaHistory = [];
    this.cumulativeHistory = [];
    this.emaValue = null;
  }

  /**
   * Calculate delta for a single candle
   * Positive = bullish (close > open), Negative = bearish (close < open)
   *
   * @param {object} candle - Candle with {open, high, low, close, volume}
   * @returns {number} Delta value for this candle
   */
  calculateCandleDelta(candle) {
    if (!candle || typeof candle.volume === 'undefined') {
      return 0;
    }

    const { open, high, low, close, volume } = candle;
    const range = high - low;

    if (range === 0 || volume === 0) {
      return 0;
    }

    // Basic direction: +1 for bullish, -1 for bearish, 0 for doji
    let direction = 0;
    if (close > open) {
      direction = 1;
    } else if (close < open) {
      direction = -1;
    }

    let delta = direction * volume;

    // Optional: Weight by body ratio (larger body = stronger signal)
    if (this.params.useBodyRatioWeighting) {
      const body = Math.abs(close - open);
      const bodyRatio = body / range; // 0 to 1
      // Apply sqrt to soften the effect (full doji still gets some weight)
      const weight = 0.3 + 0.7 * Math.sqrt(bodyRatio);
      delta *= weight;
    }

    return delta;
  }

  /**
   * Process a candle and update cumulative delta
   * Call this for each candle in sequence
   *
   * @param {object} candle - Candle with OHLCV data
   * @returns {object} {delta, cumulativeDelta, ema, slope}
   */
  processCandle(candle) {
    const delta = this.calculateCandleDelta(candle);

    this.cumulativeDelta += delta;
    this.deltaHistory.push(delta);
    this.cumulativeHistory.push(this.cumulativeDelta);

    // Keep history bounded
    const maxHistory = Math.max(this.params.emaPeriod, this.params.slopeLookback) * 2;
    if (this.deltaHistory.length > maxHistory) {
      this.deltaHistory.shift();
      this.cumulativeHistory.shift();
    }

    // Calculate EMA of delta
    this.emaValue = this._calculateEMA(delta);

    // Calculate slope of cumulative delta
    const slope = this._calculateSlope();

    return {
      delta,
      cumulativeDelta: this.cumulativeDelta,
      ema: this.emaValue,
      slope
    };
  }

  /**
   * Calculate delta values for an array of candles
   *
   * @param {object[]} candles - Array of candles
   * @returns {object[]} Array of {delta, cumulativeDelta, ema, slope} for each candle
   */
  calculateForCandles(candles) {
    this.reset();
    const results = [];

    for (const candle of candles) {
      results.push(this.processCandle(candle));
    }

    return results;
  }

  /**
   * Get current state
   * @returns {object} Current indicator values
   */
  getState() {
    return {
      cumulativeDelta: this.cumulativeDelta,
      ema: this.emaValue,
      slope: this._calculateSlope(),
      historyLength: this.deltaHistory.length
    };
  }

  /**
   * Check if delta direction aligns with trade side
   *
   * @param {string} side - 'buy' or 'sell'
   * @param {object} options - {useSlope: boolean, minSlope: number}
   * @returns {boolean} True if delta supports the trade direction
   */
  alignsWithDirection(side, options = {}) {
    const { useSlope = true, minSlope = 0 } = options;

    if (useSlope) {
      const slope = this._calculateSlope();
      if (slope === null) return true; // Not enough data, allow trade

      if (side === 'buy') {
        return slope > minSlope;
      } else {
        return slope < -minSlope;
      }
    } else {
      // Use EMA direction
      if (this.emaValue === null) return true;

      if (side === 'buy') {
        return this.emaValue > 0;
      } else {
        return this.emaValue < 0;
      }
    }
  }

  /**
   * Detect divergence between price and delta
   *
   * @param {number[]} prices - Recent price highs/lows
   * @param {number} lookback - Periods to check for divergence
   * @returns {object} {hasDivergence: boolean, type: 'bullish'|'bearish'|null}
   */
  detectDivergence(prices, lookback = 20) {
    if (prices.length < lookback || this.cumulativeHistory.length < lookback) {
      return { hasDivergence: false, type: null };
    }

    const recentPrices = prices.slice(-lookback);
    const recentCVD = this.cumulativeHistory.slice(-lookback);

    // Find swing points in both series
    const priceHigh1 = Math.max(...recentPrices.slice(0, Math.floor(lookback / 2)));
    const priceHigh2 = Math.max(...recentPrices.slice(Math.floor(lookback / 2)));
    const priceLow1 = Math.min(...recentPrices.slice(0, Math.floor(lookback / 2)));
    const priceLow2 = Math.min(...recentPrices.slice(Math.floor(lookback / 2)));

    const cvdHigh1 = Math.max(...recentCVD.slice(0, Math.floor(lookback / 2)));
    const cvdHigh2 = Math.max(...recentCVD.slice(Math.floor(lookback / 2)));
    const cvdLow1 = Math.min(...recentCVD.slice(0, Math.floor(lookback / 2)));
    const cvdLow2 = Math.min(...recentCVD.slice(Math.floor(lookback / 2)));

    // Bearish divergence: Price higher high, CVD lower high
    if (priceHigh2 > priceHigh1 && cvdHigh2 < cvdHigh1) {
      return { hasDivergence: true, type: 'bearish' };
    }

    // Bullish divergence: Price lower low, CVD higher low
    if (priceLow2 < priceLow1 && cvdLow2 > cvdLow1) {
      return { hasDivergence: true, type: 'bullish' };
    }

    return { hasDivergence: false, type: null };
  }

  /**
   * Calculate EMA using exponential smoothing
   * @private
   */
  _calculateEMA(newValue) {
    const period = this.params.emaPeriod;
    const multiplier = 2 / (period + 1);

    if (this.emaValue === null) {
      // Initialize with SMA if we have enough history
      if (this.deltaHistory.length >= period) {
        const sum = this.deltaHistory.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
      }
      return newValue;
    }

    return (newValue - this.emaValue) * multiplier + this.emaValue;
  }

  /**
   * Calculate slope of cumulative delta over lookback period
   * @private
   */
  _calculateSlope() {
    const lookback = this.params.slopeLookback;

    if (this.cumulativeHistory.length < lookback) {
      return null;
    }

    const recent = this.cumulativeHistory.slice(-lookback);

    // Simple linear regression slope
    const n = recent.length;
    const xMean = (n - 1) / 2;
    const yMean = recent.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (recent[i] - yMean);
      denominator += (i - xMean) * (i - xMean);
    }

    if (denominator === 0) return 0;

    return numerator / denominator;
  }
}

export default VolumeDeltaProxy;
