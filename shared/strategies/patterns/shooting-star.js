/**
 * Shooting Star Pattern
 *
 * Classic bearish reversal candle appearing at highs. Similar to bearish pin bar
 * but specifically requires a bearish (red) close and appears after an uptrend.
 *
 * Entry: Short at candle close
 * Bias: Bearish reversal
 */

export const ShootingStarPattern = {
  name: 'shooting_star',
  displayName: 'Shooting Star',
  side: 'short',
  candlesRequired: 2,
  entryType: 'limit', // Limit order near shooting star high (rejection zone)

  /**
   * Get optimal entry price for this pattern
   * Entry near the top of the body - in the rejection zone
   */
  getEntryPrice(current, previous, context = {}) {
    // Entry at the body high (top of candle body, not wick)
    const bodyHigh = Math.max(current.open, current.close);
    return bodyHigh;
  },

  /**
   * Get stop loss price for this pattern
   * Stop above the shooting star's wick high
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    return current.high + buffer;
  },

  /**
   * Detect shooting star pattern
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
    if (body === 0) return false; // Shooting star needs a body

    // Lower wick should be small or none (< 10% of range)
    if (lowerWick / range > 0.1) return false;

    // Upper wick should be >= 60% of range
    if (upperWick / range < 0.6) return false;

    // Optional: Require bearish close (red candle)
    const requireBearishClose = context.requireBearishClose !== false;
    if (requireBearishClose && current.close > current.open) return false;

    // Optional: Require previous candle to be bullish (confirms uptrend)
    if (previous && context.requireUptrend !== false) {
      if (previous.close <= previous.open) return false;
    }

    return true;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    const range = current.high - current.low;
    const upperWick = current.high - Math.max(current.open, current.close);

    let strength = 0.6;

    const wickRatio = upperWick / range;
    if (wickRatio > 0.75) strength += 0.15;
    else if (wickRatio > 0.65) strength += 0.1;

    if (current.close < current.open) {
      strength += 0.1;
    }

    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.1;
    }

    if (context.nearResistance) {
      strength += 0.05;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.5,
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    minWickToBodyRatio: 2.0,
    requireBearishClose: true,
    requireUptrend: true
  },

  exits: {
    targetPoints: 2.5,
    stopLossPoints: 1.5,
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

export default ShootingStarPattern;
