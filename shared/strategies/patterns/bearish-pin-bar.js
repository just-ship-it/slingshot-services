/**
 * Bearish Pin Bar Pattern
 *
 * A single candle with a long upper wick and small body near the bottom.
 * Indicates sellers stepped in at higher prices, rejecting those levels.
 *
 * Entry: Short at candle close
 * Bias: Bearish reversal
 */

export const BearishPinBarPattern = {
  name: 'bearish_pin_bar',
  displayName: 'Bearish Pin Bar',
  side: 'short',
  candlesRequired: 1,
  entryType: 'limit', // Limit order near pin bar body high (rejection zone)

  /**
   * Get optimal entry price for this pattern
   * Entry at the body high - where rejection started
   */
  getEntryPrice(current, previous, context = {}) {
    const bodyHigh = Math.max(current.open, current.close);
    return bodyHigh;
  },

  /**
   * Get stop loss price for this pattern
   * Stop above the pin bar's wick high
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    return current.high + buffer;
  },

  /**
   * Detect bearish pin bar pattern
   */
  detect(current, previous, context = {}) {
    if (!current) return false;

    const range = current.high - current.low;
    if (range === 0) return false;

    const body = Math.abs(current.close - current.open);
    const upperWick = current.high - Math.max(current.open, current.close);
    const lowerWick = Math.min(current.open, current.close) - current.low;

    // Upper wick must be >= 2x body
    const minWickToBodyRatio = context.minWickToBodyRatio || 2.0;
    if (body > 0 && upperWick / body < minWickToBodyRatio) return false;
    if (body === 0 && upperWick < range * 0.5) return false;

    // Body should be in lower third of range
    const bodyMidpoint = (current.open + current.close) / 2;
    const lowerThird = current.low + (range / 3);
    if (bodyMidpoint > lowerThird) return false;

    // Lower wick should be small (< 25% of range)
    const maxLowerWickRatio = context.maxLowerWickRatio || 0.25;
    if (lowerWick / range > maxLowerWickRatio) return false;

    // Upper wick should be significant (>= 50% of range)
    const minUpperWickRatio = context.minUpperWickRatio || 0.5;
    if (upperWick / range < minUpperWickRatio) return false;

    return true;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    const range = current.high - current.low;
    const upperWick = current.high - Math.max(current.open, current.close);

    let strength = 0.5;

    const wickRatio = upperWick / range;
    if (wickRatio > 0.7) strength += 0.2;
    else if (wickRatio > 0.6) strength += 0.1;

    // Bearish close (red candle) is stronger
    if (current.close < current.open) {
      strength += 0.1;
    }

    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.1;
    }

    if (context.nearResistance) {
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
    maxLowerWickRatio: 0.25,
    minUpperWickRatio: 0.5
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

export default BearishPinBarPattern;
