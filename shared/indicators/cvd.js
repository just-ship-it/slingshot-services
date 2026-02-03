/**
 * Cumulative Volume Delta (CVD) Calculator
 *
 * Calculates true CVD using Databento trade data with side classification.
 * - Aggressive buys (hitting the ask) add to CVD
 * - Aggressive sells (hitting the bid) subtract from CVD
 *
 * CVD measures the net buying/selling pressure over time.
 */

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

export class CVDCalculator {
  constructor(options = {}) {
    this.options = {
      // Lookback for slope calculation
      slopeLookback: options.slopeLookback || 5,
      // EMA period for smoothing
      emaPeriod: options.emaPeriod || 14,
      // Divergence detection lookback
      divergenceLookback: options.divergenceLookback || 20,
      // Minimum slope magnitude to consider significant
      minSlopeThreshold: options.minSlopeThreshold || 0,
      ...options
    };

    // State
    this.cvdHistory = [];
    this.deltaHistory = [];
    this.emaValue = null;
    this.cumulativeDelta = 0;

    // Pre-computed CVD data (aligned to candle timestamps)
    this.cvdByTimestamp = new Map();
  }

  /**
   * Reset calculator state
   */
  reset() {
    this.cvdHistory = [];
    this.deltaHistory = [];
    this.emaValue = null;
    this.cumulativeDelta = 0;
  }

  /**
   * Load pre-computed CVD data from Databento loader
   * @param {Map<number, Object>} cvdMap - Map from DatabentoTradeLoader.computeCVDForCandles()
   */
  loadPrecomputedCVD(cvdMap) {
    this.cvdByTimestamp = cvdMap;

    // Build history arrays from the map
    const sortedEntries = Array.from(cvdMap.entries())
      .sort((a, b) => a[0] - b[0]);

    this.cvdHistory = sortedEntries.map(([_, data]) => data.cumulativeDelta);
    this.deltaHistory = sortedEntries.map(([_, data]) => data.delta);

    if (this.cvdHistory.length > 0) {
      this.cumulativeDelta = this.cvdHistory[this.cvdHistory.length - 1];
    }
  }

  /**
   * Process a single trade (for real-time use)
   * @param {Object} trade - Trade with {side: 'A'|'B', size: number}
   * @returns {Object} Current CVD state
   */
  processTrade(trade) {
    let delta = 0;

    if (trade.side === 'A') {
      // Ask aggressor = buyer
      delta = trade.size;
    } else if (trade.side === 'B') {
      // Bid aggressor = seller
      delta = -trade.size;
    }

    this.cumulativeDelta += delta;

    return {
      delta,
      cumulativeDelta: this.cumulativeDelta
    };
  }

  /**
   * Process aggregated candle CVD data
   * @param {Object} cvdData - {delta, cumulativeDelta, buyVolume, sellVolume}
   */
  processCandle(cvdData) {
    this.deltaHistory.push(cvdData.delta);
    this.cvdHistory.push(cvdData.cumulativeDelta);
    this.cumulativeDelta = cvdData.cumulativeDelta;

    // Update EMA
    this.emaValue = this._calculateEMA(cvdData.delta);

    // Keep history bounded
    const maxHistory = Math.max(this.options.emaPeriod, this.options.slopeLookback, this.options.divergenceLookback) * 2;
    if (this.cvdHistory.length > maxHistory) {
      this.cvdHistory.shift();
      this.deltaHistory.shift();
    }
  }

  /**
   * Get CVD data for a specific timestamp
   * @param {number} timestamp - Candle timestamp
   * @returns {Object|null} CVD data or null if not found
   */
  getCVDAtTime(timestamp) {
    return this.cvdByTimestamp.get(timestamp) || null;
  }

  /**
   * Get current CVD value
   * @returns {number}
   */
  getCVD() {
    return this.cumulativeDelta;
  }

  /**
   * Calculate CVD slope over lookback period
   * @param {number} lookback - Number of periods (default: slopeLookback)
   * @returns {number|null} Slope or null if insufficient data
   */
  getSlope(lookback = null) {
    const periods = lookback || this.options.slopeLookback;

    if (this.cvdHistory.length < periods) {
      return null;
    }

    const recent = this.cvdHistory.slice(-periods);

    // Linear regression slope
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

  /**
   * Check if CVD direction aligns with trade side
   * @param {string} side - 'buy' or 'sell'
   * @param {Object} options - {minSlope: number}
   * @returns {boolean}
   */
  alignsWithDirection(side, options = {}) {
    const minSlope = options.minSlope ?? this.options.minSlopeThreshold;
    const slope = this.getSlope();

    if (slope === null) {
      return true; // Not enough data, allow trade
    }

    if (side === 'buy') {
      return slope > minSlope;
    } else {
      return slope < -minSlope;
    }
  }

  /**
   * Detect divergence between price and CVD
   * @param {number[]} prices - Array of prices (highs for bearish div, lows for bullish div)
   * @param {number} lookback - Periods to analyze
   * @returns {Object} {hasDivergence: boolean, type: 'bullish'|'bearish'|null, strength: number}
   */
  detectDivergence(prices, lookback = null) {
    const periods = lookback || this.options.divergenceLookback;

    if (prices.length < periods || this.cvdHistory.length < periods) {
      return { hasDivergence: false, type: null, strength: 0 };
    }

    const recentPrices = prices.slice(-periods);
    const recentCVD = this.cvdHistory.slice(-periods);

    // Find highs and lows in both series
    const halfPeriod = Math.floor(periods / 2);

    // First half extremes
    const priceHigh1 = Math.max(...recentPrices.slice(0, halfPeriod));
    const priceLow1 = Math.min(...recentPrices.slice(0, halfPeriod));
    const cvdHigh1 = Math.max(...recentCVD.slice(0, halfPeriod));
    const cvdLow1 = Math.min(...recentCVD.slice(0, halfPeriod));

    // Second half extremes
    const priceHigh2 = Math.max(...recentPrices.slice(halfPeriod));
    const priceLow2 = Math.min(...recentPrices.slice(halfPeriod));
    const cvdHigh2 = Math.max(...recentCVD.slice(halfPeriod));
    const cvdLow2 = Math.min(...recentCVD.slice(halfPeriod));

    // Bearish divergence: Price higher high, CVD lower high
    if (priceHigh2 > priceHigh1 && cvdHigh2 < cvdHigh1) {
      const priceChange = (priceHigh2 - priceHigh1) / priceHigh1;
      const cvdChange = (cvdHigh2 - cvdHigh1) / Math.abs(cvdHigh1 || 1);
      const strength = Math.abs(priceChange - cvdChange);

      return {
        hasDivergence: true,
        type: 'bearish',
        strength,
        details: {
          priceHigh1, priceHigh2,
          cvdHigh1, cvdHigh2
        }
      };
    }

    // Bullish divergence: Price lower low, CVD higher low
    if (priceLow2 < priceLow1 && cvdLow2 > cvdLow1) {
      const priceChange = (priceLow2 - priceLow1) / priceLow1;
      const cvdChange = (cvdLow2 - cvdLow1) / Math.abs(cvdLow1 || 1);
      const strength = Math.abs(priceChange - cvdChange);

      return {
        hasDivergence: true,
        type: 'bullish',
        strength,
        details: {
          priceLow1, priceLow2,
          cvdLow1, cvdLow2
        }
      };
    }

    return { hasDivergence: false, type: null, strength: 0 };
  }

  /**
   * Check if CVD crossed zero line recently
   * @param {number} lookback - Periods to check
   * @returns {Object} {crossed: boolean, direction: 'up'|'down'|null, barsAgo: number}
   */
  checkZeroCross(lookback = 5) {
    if (this.cvdHistory.length < lookback + 1) {
      return { crossed: false, direction: null, barsAgo: null };
    }

    const recent = this.cvdHistory.slice(-lookback - 1);

    for (let i = recent.length - 1; i > 0; i--) {
      const current = recent[i];
      const previous = recent[i - 1];

      // Crossed from negative to positive (bullish)
      if (previous < 0 && current >= 0) {
        return {
          crossed: true,
          direction: 'up',
          barsAgo: recent.length - 1 - i
        };
      }

      // Crossed from positive to negative (bearish)
      if (previous > 0 && current <= 0) {
        return {
          crossed: true,
          direction: 'down',
          barsAgo: recent.length - 1 - i
        };
      }
    }

    return { crossed: false, direction: null, barsAgo: null };
  }

  /**
   * Get delta momentum (rate of change of CVD)
   * @param {number} lookback - Periods
   * @returns {number|null}
   */
  getMomentum(lookback = 5) {
    if (this.cvdHistory.length < lookback + 1) {
      return null;
    }

    const current = this.cvdHistory[this.cvdHistory.length - 1];
    const previous = this.cvdHistory[this.cvdHistory.length - 1 - lookback];

    return current - previous;
  }

  /**
   * Get current state summary
   * @returns {Object}
   */
  getState() {
    return {
      cumulativeDelta: this.cumulativeDelta,
      slope: this.getSlope(),
      ema: this.emaValue,
      momentum: this.getMomentum(),
      zeroCross: this.checkZeroCross(),
      historyLength: this.cvdHistory.length
    };
  }

  /**
   * Calculate EMA
   * @private
   */
  _calculateEMA(newValue) {
    const period = this.options.emaPeriod;
    const multiplier = 2 / (period + 1);

    if (this.emaValue === null) {
      if (this.deltaHistory.length >= period) {
        const sum = this.deltaHistory.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
      }
      return newValue;
    }

    return (newValue - this.emaValue) * multiplier + this.emaValue;
  }
}


/**
 * CVD Filter for strategy integration
 * Provides simple filter interface for checking CVD conditions
 */
export class CVDFilter {
  constructor(cvdCalculator, options = {}) {
    this.cvd = cvdCalculator;
    this.options = {
      // Require slope alignment
      requireSlopeAlignment: options.requireSlopeAlignment !== false,
      minSlope: options.minSlope || 0,

      // Block on divergence
      blockOnDivergence: options.blockOnDivergence || false,
      divergenceLookback: options.divergenceLookback || 20,

      // Zero cross filter
      requireRecentZeroCross: options.requireRecentZeroCross || false,
      zeroCrossLookback: options.zeroCrossLookback || 10,

      ...options
    };
  }

  /**
   * Check if all CVD conditions pass for a trade
   * @param {string} side - 'buy' or 'sell'
   * @param {number[]} prices - Recent price data (for divergence)
   * @returns {Object} {passes: boolean, reasons: string[], details: Object}
   */
  check(side, prices = []) {
    const reasons = [];
    const details = {};
    let passes = true;

    // Check slope alignment
    if (this.options.requireSlopeAlignment) {
      const aligns = this.cvd.alignsWithDirection(side, {
        minSlope: this.options.minSlope
      });
      details.slopeAlignment = aligns;
      details.slope = this.cvd.getSlope();

      if (!aligns) {
        passes = false;
        reasons.push(`CVD slope doesn't support ${side} (slope: ${details.slope?.toFixed(2)})`);
      } else {
        reasons.push(`CVD slope confirms ${side}`);
      }
    }

    // Check divergence
    if (this.options.blockOnDivergence && prices.length > 0) {
      const divergence = this.cvd.detectDivergence(prices, this.options.divergenceLookback);
      details.divergence = divergence;

      if (divergence.hasDivergence) {
        // Block if divergence contradicts trade direction
        if (side === 'buy' && divergence.type === 'bearish') {
          passes = false;
          reasons.push('Bearish CVD divergence detected - blocking long entry');
        } else if (side === 'sell' && divergence.type === 'bullish') {
          passes = false;
          reasons.push('Bullish CVD divergence detected - blocking short entry');
        } else {
          reasons.push(`${divergence.type} divergence supports ${side}`);
        }
      }
    }

    // Check zero cross
    if (this.options.requireRecentZeroCross) {
      const zeroCross = this.cvd.checkZeroCross(this.options.zeroCrossLookback);
      details.zeroCross = zeroCross;

      if (!zeroCross.crossed) {
        passes = false;
        reasons.push('No recent CVD zero-line cross');
      } else {
        // Check if cross direction matches trade direction
        if ((side === 'buy' && zeroCross.direction === 'up') ||
            (side === 'sell' && zeroCross.direction === 'down')) {
          reasons.push(`Recent CVD zero-cross ${zeroCross.direction} (${zeroCross.barsAgo} bars ago)`);
        } else {
          passes = false;
          reasons.push(`CVD zero-cross direction (${zeroCross.direction}) doesn't match ${side}`);
        }
      }
    }

    return { passes, reasons, details };
  }
}

export default CVDCalculator;
