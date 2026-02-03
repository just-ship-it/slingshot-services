/**
 * Inside Bar Pattern
 *
 * A candle whose entire range (high to low) is contained within the
 * previous candle's range. Indicates consolidation and a potential
 * breakout in either direction.
 *
 * Entry: On breakout of mother bar's range (direction determines side)
 * Bias: Neutral - depends on breakout direction
 */

export const InsideBarPattern = {
  name: 'inside_bar',
  displayName: 'Inside Bar',
  side: 'neutral', // Direction determined by breakout
  candlesRequired: 2,
  entryType: 'stop', // Stop order for breakout entry

  /**
   * Detect inside bar pattern
   * @param {Object} current - Current candle (potential inside bar)
   * @param {Object} previous - Previous candle (mother bar)
   * @param {Object} context - Additional context
   * @returns {boolean} True if pattern detected
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    // Current range must be entirely within previous range
    const isInside = current.high < previous.high && current.low > previous.low;

    if (!isInside) return false;

    // Optional: Require mother bar to be significant (not too small)
    const motherRange = previous.high - previous.low;
    const minMotherRange = context.minMotherRange || 1.0;
    if (motherRange < minMotherRange) return false;

    // Store mother bar levels for breakout detection
    context.motherHigh = previous.high;
    context.motherLow = previous.low;
    context.motherRange = motherRange;

    return true;
  },

  /**
   * Detect breakout of inside bar
   * @param {Object} candle - Current candle
   * @param {Object} insideBarContext - Context from detect() call
   * @returns {Object|null} { direction: 'long'|'short', breakoutPrice }
   */
  detectBreakout(candle, insideBarContext) {
    if (!candle || !insideBarContext) return null;

    const { motherHigh, motherLow } = insideBarContext;

    // Bullish breakout: close above mother high
    if (candle.close > motherHigh) {
      return {
        direction: 'long',
        breakoutPrice: motherHigh,
        breakoutStrength: (candle.close - motherHigh) / (motherHigh - motherLow)
      };
    }

    // Bearish breakout: close below mother low
    if (candle.close < motherLow) {
      return {
        direction: 'short',
        breakoutPrice: motherLow,
        breakoutStrength: (motherLow - candle.close) / (motherHigh - motherLow)
      };
    }

    return null;
  },

  /**
   * Get optimal entry price for this pattern
   * For inside bar, we use STOP orders:
   * - Long: Stop entry above mother bar high (breakout)
   * - Short: Stop entry below mother bar low (breakdown)
   * @param {Object} current - Inside bar candle
   * @param {Object} previous - Mother bar candle
   * @param {Object} context - Must contain determined side
   * @param {string} side - 'long' or 'short' (determined by strategy)
   */
  getEntryPrice(current, previous, context = {}) {
    const side = context.side || context.breakoutDirection;
    const buffer = 0.25;

    if (side === 'long') {
      // Stop buy above mother bar high
      return previous.high + buffer;
    } else if (side === 'short') {
      // Stop sell below mother bar low
      return previous.low - buffer;
    }
    // If no side determined, default to mother bar midpoint
    return (previous.high + previous.low) / 2;
  },

  /**
   * Get stop loss price for this pattern
   * Stop on opposite side of mother bar
   */
  getStopPrice(current, previous, context = {}) {
    const side = context.side || context.breakoutDirection;
    const buffer = context.stopBuffer || 0.5;

    if (side === 'long') {
      return previous.low - buffer;
    } else if (side === 'short') {
      return previous.high + buffer;
    }
    return side === 'long' ? previous.low - buffer : previous.high + buffer;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.4; // Base strength for inside bar

    // Tighter inside bar = stronger consolidation
    const insideRange = current.high - current.low;
    const motherRange = previous.high - previous.low;
    const compressionRatio = 1 - (insideRange / motherRange);

    if (compressionRatio > 0.6) strength += 0.2;
    else if (compressionRatio > 0.4) strength += 0.1;

    // Multiple inside bars increase strength
    if (context.consecutiveInsideBars && context.consecutiveInsideBars > 1) {
      strength += 0.1 * Math.min(context.consecutiveInsideBars - 1, 2);
    }

    // Volume contraction during inside bar is bullish for breakout
    if (context.avgVolume && current.volume < context.avgVolume * 0.7) {
      strength += 0.1;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 0.7,        // Lower volume during consolidation is normal
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    minMotherRange: 1.0,          // Mother bar minimum range
    waitForBreakout: true         // Wait for breakout before entry
  },

  exits: {
    targetPoints: 2.5,
    stopLossPoints: 2.0,          // Stop on opposite side of mother bar
    trailingTrigger: 1.5,
    trailingOffset: 0.75,
    maxHoldBars: 5
  },

  metrics: {
    count: 0,
    winRate2pt: 0,
    winRate3pt: 0,
    avgMFE: 0,
    avgMAE: 0,
    bestHour: null,
    bestDay: null
  }
};

export default InsideBarPattern;
