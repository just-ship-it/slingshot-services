/**
 * Book Imbalance Calculator
 *
 * Analyzes order book imbalance from MBP-1 data to gauge institutional buying/selling pressure.
 *
 * Key metrics:
 * - Size Imbalance: (bidSize - askSize) / (bidSize + askSize)
 *   Positive = more size on bid (bullish), Negative = more size on ask (bearish)
 *
 * - Count Imbalance: (bidCount - askCount) / (bidCount + askCount)
 *   Indicates distribution of orders vs concentrated size
 *
 * - Bid/Ask Ratio: bidSize / askSize
 *   > 1 = bullish pressure, < 1 = bearish pressure
 *
 * Theory: At GEX support levels, strong bid imbalance suggests institutional defense,
 * increasing probability of a bounce. Conversely, ask imbalance suggests weakness.
 */

export class BookImbalanceCalculator {
  constructor(options = {}) {
    this.options = {
      // Lookback for slope/trend calculation
      slopeLookback: options.slopeLookback || 5,
      // EMA period for smoothing
      emaPeriod: options.emaPeriod || 14,
      // Minimum imbalance to consider significant
      minImbalanceThreshold: options.minImbalanceThreshold || 0.1,
      // Minimum bid/ask ratio for bullish signal
      bullishRatioThreshold: options.bullishRatioThreshold || 1.2,
      // Maximum bid/ask ratio for bearish signal (inverse)
      bearishRatioThreshold: options.bearishRatioThreshold || 0.8,
      ...options
    };

    // History buffers
    this.sizeImbalanceHistory = [];
    this.countImbalanceHistory = [];
    this.ratioHistory = [];
    this.emaValue = null;

    // Pre-computed imbalance data (aligned to candle timestamps)
    this.imbalanceByTimestamp = new Map();
  }

  /**
   * Reset calculator state
   */
  reset() {
    this.sizeImbalanceHistory = [];
    this.countImbalanceHistory = [];
    this.ratioHistory = [];
    this.emaValue = null;
  }

  /**
   * Load pre-computed imbalance data from MBP loader
   * @param {Map<number, Object>} imbalanceMap - Map from MBPLoader.computeImbalanceForDateRange()
   */
  loadPrecomputedImbalance(imbalanceMap) {
    this.imbalanceByTimestamp = imbalanceMap;

    // Build history arrays from the map
    const sortedEntries = Array.from(imbalanceMap.entries())
      .sort((a, b) => a[0] - b[0]);

    this.sizeImbalanceHistory = sortedEntries.map(([_, data]) => data.sizeImbalance || 0);
    this.countImbalanceHistory = sortedEntries.map(([_, data]) => data.countImbalance || 0);
    this.ratioHistory = sortedEntries.map(([_, data]) => data.bidAskRatio || 1);
  }

  /**
   * Get imbalance data for a specific timestamp
   * @param {number} timestamp - Candle timestamp
   * @returns {Object|null} Imbalance data or null if not found
   */
  getImbalanceAtTime(timestamp) {
    return this.imbalanceByTimestamp.get(timestamp) || null;
  }

  /**
   * Process candle imbalance data (updates internal state)
   * @param {Object} imbalanceData - Imbalance data from getImbalanceAtTime
   */
  processCandle(imbalanceData) {
    if (!imbalanceData) return;

    this.sizeImbalanceHistory.push(imbalanceData.sizeImbalance || 0);
    this.countImbalanceHistory.push(imbalanceData.countImbalance || 0);
    this.ratioHistory.push(imbalanceData.bidAskRatio || 1);

    // Update EMA
    this.emaValue = this._calculateEMA(imbalanceData.sizeImbalance || 0);

    // Keep history bounded
    const maxHistory = Math.max(this.options.emaPeriod, this.options.slopeLookback) * 2;
    if (this.sizeImbalanceHistory.length > maxHistory) {
      this.sizeImbalanceHistory.shift();
      this.countImbalanceHistory.shift();
      this.ratioHistory.shift();
    }
  }

  /**
   * Get current size imbalance
   * @returns {number} Current size imbalance (-1 to 1)
   */
  getCurrentImbalance() {
    if (this.sizeImbalanceHistory.length === 0) return 0;
    return this.sizeImbalanceHistory[this.sizeImbalanceHistory.length - 1];
  }

  /**
   * Get current bid/ask ratio
   * @returns {number} Current ratio (> 1 = bullish)
   */
  getCurrentRatio() {
    if (this.ratioHistory.length === 0) return 1;
    return this.ratioHistory[this.ratioHistory.length - 1];
  }

  /**
   * Calculate imbalance slope over lookback period
   * @param {number} lookback - Number of periods (default: slopeLookback)
   * @returns {number|null} Slope or null if insufficient data
   */
  getSlope(lookback = null) {
    const periods = lookback || this.options.slopeLookback;

    if (this.sizeImbalanceHistory.length < periods) {
      return null;
    }

    const recent = this.sizeImbalanceHistory.slice(-periods);

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
   * Check if imbalance direction aligns with trade side
   * @param {string} side - 'buy' or 'sell'
   * @param {Object} options - Override options
   * @returns {boolean}
   */
  alignsWithDirection(side, options = {}) {
    const minThreshold = options.minThreshold ?? this.options.minImbalanceThreshold;
    const bullishRatio = options.bullishRatio ?? this.options.bullishRatioThreshold;
    const bearishRatio = options.bearishRatio ?? this.options.bearishRatioThreshold;

    const currentImbalance = this.getCurrentImbalance();
    const currentRatio = this.getCurrentRatio();

    if (side === 'buy') {
      // For longs, want positive imbalance (more bid size) or high ratio
      return currentImbalance > minThreshold || currentRatio > bullishRatio;
    } else {
      // For shorts, want negative imbalance (more ask size) or low ratio
      return currentImbalance < -minThreshold || currentRatio < bearishRatio;
    }
  }

  /**
   * Check for imbalance momentum (improving or deteriorating)
   * @param {string} side - 'buy' or 'sell'
   * @param {number} lookback - Periods to check
   * @returns {Object} { improving: boolean, slope: number }
   */
  checkMomentum(side, lookback = 5) {
    const slope = this.getSlope(lookback);

    if (slope === null) {
      return { improving: true, slope: 0 }; // Not enough data, allow trade
    }

    if (side === 'buy') {
      // For longs, improving means slope is positive (imbalance getting more bullish)
      return { improving: slope > 0, slope };
    } else {
      // For shorts, improving means slope is negative (imbalance getting more bearish)
      return { improving: slope < 0, slope };
    }
  }

  /**
   * Get imbalance strength classification
   * @returns {string} 'strong_bullish', 'bullish', 'neutral', 'bearish', 'strong_bearish'
   */
  getImbalanceStrength() {
    const imbalance = this.getCurrentImbalance();
    const ratio = this.getCurrentRatio();

    if (imbalance > 0.3 || ratio > 1.5) return 'strong_bullish';
    if (imbalance > 0.1 || ratio > 1.2) return 'bullish';
    if (imbalance < -0.3 || ratio < 0.67) return 'strong_bearish';
    if (imbalance < -0.1 || ratio < 0.8) return 'bearish';
    return 'neutral';
  }

  /**
   * Get current state summary
   * @returns {Object}
   */
  getState() {
    return {
      sizeImbalance: this.getCurrentImbalance(),
      countImbalance: this.countImbalanceHistory.length > 0
        ? this.countImbalanceHistory[this.countImbalanceHistory.length - 1]
        : 0,
      bidAskRatio: this.getCurrentRatio(),
      slope: this.getSlope(),
      ema: this.emaValue,
      strength: this.getImbalanceStrength(),
      historyLength: this.sizeImbalanceHistory.length
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
      if (this.sizeImbalanceHistory.length >= period) {
        const sum = this.sizeImbalanceHistory.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
      }
      return newValue;
    }

    return (newValue - this.emaValue) * multiplier + this.emaValue;
  }
}


/**
 * Book Imbalance Filter for strategy integration
 * Provides simple filter interface for checking book imbalance conditions
 */
export class BookImbalanceFilter {
  constructor(calculator, options = {}) {
    this.calculator = calculator;
    this.options = {
      // Require imbalance alignment with trade direction
      requireAlignment: options.requireAlignment !== false,
      minImbalanceThreshold: options.minImbalanceThreshold || 0.1,

      // Require improving momentum
      requireImproving: options.requireImproving || false,
      momentumLookback: options.momentumLookback || 5,

      // Minimum ratio thresholds
      bullishRatioThreshold: options.bullishRatioThreshold || 1.2,
      bearishRatioThreshold: options.bearishRatioThreshold || 0.8,

      // Block on strong contrary imbalance
      blockOnContraryStrength: options.blockOnContraryStrength || false,

      ...options
    };
  }

  /**
   * Check if all book imbalance conditions pass for a trade
   * @param {string} side - 'buy' or 'sell'
   * @param {Object} candle - Current candle (for timestamp lookup)
   * @returns {Object} {passes: boolean, reasons: string[], details: Object}
   */
  check(side, candle = null) {
    const reasons = [];
    const details = {};
    let passes = true;

    // Get imbalance data for this candle if provided
    if (candle) {
      const candleTime = typeof candle.timestamp === 'number'
        ? candle.timestamp
        : new Date(candle.timestamp).getTime();
      const imbalanceData = this.calculator.getImbalanceAtTime(candleTime);

      if (imbalanceData) {
        this.calculator.processCandle(imbalanceData);
      }
    }

    const state = this.calculator.getState();
    details.sizeImbalance = state.sizeImbalance;
    details.bidAskRatio = state.bidAskRatio;
    details.slope = state.slope;
    details.strength = state.strength;

    // Check alignment
    if (this.options.requireAlignment) {
      const aligns = this.calculator.alignsWithDirection(side, {
        minThreshold: this.options.minImbalanceThreshold,
        bullishRatio: this.options.bullishRatioThreshold,
        bearishRatio: this.options.bearishRatioThreshold
      });
      details.alignment = aligns;

      if (!aligns) {
        passes = false;
        reasons.push(`Book imbalance doesn't support ${side} (imbalance: ${state.sizeImbalance.toFixed(3)}, ratio: ${state.bidAskRatio.toFixed(2)})`);
      } else {
        reasons.push(`Book imbalance confirms ${side}`);
      }
    }

    // Check momentum
    if (this.options.requireImproving) {
      const momentum = this.calculator.checkMomentum(side, this.options.momentumLookback);
      details.momentum = momentum;

      if (!momentum.improving) {
        passes = false;
        reasons.push(`Book imbalance momentum deteriorating for ${side} (slope: ${momentum.slope.toFixed(4)})`);
      } else {
        reasons.push(`Book imbalance momentum improving`);
      }
    }

    // Block on strong contrary signal
    if (this.options.blockOnContraryStrength) {
      const strength = state.strength;

      if (side === 'buy' && (strength === 'strong_bearish' || strength === 'bearish')) {
        passes = false;
        reasons.push(`Strong bearish book imbalance - blocking long entry`);
      } else if (side === 'sell' && (strength === 'strong_bullish' || strength === 'bullish')) {
        passes = false;
        reasons.push(`Strong bullish book imbalance - blocking short entry`);
      }
    }

    return { passes, reasons, details };
  }
}

export default BookImbalanceCalculator;
