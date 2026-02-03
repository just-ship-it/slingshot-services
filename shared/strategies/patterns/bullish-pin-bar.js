/**
 * Bullish Pin Bar Pattern
 *
 * A single candle with a long lower wick (shadow) and small body near the top.
 * Indicates buyers stepped in at lower prices, rejecting those levels.
 *
 * Entry: Long at candle close
 * Bias: Bullish reversal
 */

export const BullishPinBarPattern = {
  name: 'bullish_pin_bar',
  displayName: 'Bullish Pin Bar',
  side: 'long',
  candlesRequired: 1,
  entryType: 'limit', // Limit order near pin bar body low (rejection zone)

  /**
   * Get optimal entry price for this pattern
   * Entry at the body low - where rejection started
   */
  getEntryPrice(current, previous, context = {}) {
    const bodyLow = Math.min(current.open, current.close);
    return bodyLow;
  },

  /**
   * Get stop loss price for this pattern
   * Stop below the pin bar's wick low
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    return current.low - buffer;
  },

  /**
   * Detect bullish pin bar pattern
   * @param {Object} current - Current candle
   * @param {Object} previous - Previous candle (optional, for context)
   * @param {Object} context - Additional context
   * @returns {boolean} True if pattern detected
   */
  detect(current, previous, context = {}) {
    if (!current) return false;

    const range = current.high - current.low;
    if (range === 0) return false;

    const body = Math.abs(current.close - current.open);
    const lowerWick = Math.min(current.open, current.close) - current.low;
    const upperWick = current.high - Math.max(current.open, current.close);

    // Lower wick must be >= 2x body
    const minWickToBodyRatio = context.minWickToBodyRatio || 2.0;
    if (body > 0 && lowerWick / body < minWickToBodyRatio) return false;
    if (body === 0 && lowerWick < range * 0.5) return false; // Doji case

    // Body should be in upper third of range
    const bodyMidpoint = (current.open + current.close) / 2;
    const upperThird = current.high - (range / 3);
    if (bodyMidpoint < upperThird) return false;

    // Upper wick should be small (< 25% of range)
    const maxUpperWickRatio = context.maxUpperWickRatio || 0.25;
    if (upperWick / range > maxUpperWickRatio) return false;

    // Lower wick should be significant (>= 50% of range)
    const minLowerWickRatio = context.minLowerWickRatio || 0.5;
    if (lowerWick / range < minLowerWickRatio) return false;

    return true;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    const range = current.high - current.low;
    const body = Math.abs(current.close - current.open);
    const lowerWick = Math.min(current.open, current.close) - current.low;

    let strength = 0.5;

    // Longer wick = stronger
    const wickRatio = lowerWick / range;
    if (wickRatio > 0.7) strength += 0.2;
    else if (wickRatio > 0.6) strength += 0.1;

    // Bullish close (green candle) is stronger
    if (current.close > current.open) {
      strength += 0.1;
    }

    // Volume confirmation
    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.1;
    }

    // At support level
    if (context.nearSupport) {
      strength += 0.1;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.0,
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    minWickToBodyRatio: 2.0,
    maxUpperWickRatio: 0.25,
    minLowerWickRatio: 0.5
  },

  exits: {
    targetPoints: 2.5,
    stopLossPoints: 2.0,
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

export default BullishPinBarPattern;
