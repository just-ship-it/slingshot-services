/**
 * Doji Pattern
 *
 * A candle with a very small body (open ≈ close), indicating indecision.
 * Can signal potential reversal when appearing after a trend.
 *
 * Entry: Direction depends on context (trend, level, next candle)
 * Bias: Neutral - indicates indecision
 */

export const DojiPattern = {
  name: 'doji',
  displayName: 'Doji',
  side: 'neutral', // Direction determined by context
  candlesRequired: 1,
  entryType: 'limit', // Limit order at doji extreme in trade direction

  /**
   * Get optimal entry price for this pattern
   * For dragonfly (bullish): enter near the low (wick area)
   * For gravestone (bearish): enter near the high (wick area)
   * For standard: enter at the extreme in trade direction
   */
  getEntryPrice(current, previous, context = {}) {
    const side = context.side || this.getDirection(current, previous, context);
    const buffer = 0.25;

    if (context.dojiType === 'dragonfly' || side === 'long') {
      // Entry near the low for long
      return current.low + buffer;
    } else if (context.dojiType === 'gravestone' || side === 'short') {
      // Entry near the high for short
      return current.high - buffer;
    }
    // Default to close
    return current.close;
  },

  /**
   * Get stop loss price for this pattern
   * Stop beyond the doji's wick in the opposing direction
   */
  getStopPrice(current, previous, context = {}) {
    const side = context.side || this.getDirection(current, previous, context);
    const buffer = context.stopBuffer || 0.5;

    if (side === 'long') {
      return current.low - buffer;
    } else {
      return current.high + buffer;
    }
  },

  /**
   * Detect doji pattern
   */
  detect(current, previous, context = {}) {
    if (!current) return false;

    const range = current.high - current.low;
    if (range === 0) return false;

    const body = Math.abs(current.close - current.open);
    const bodyRatio = body / range;

    // Body must be very small relative to range
    const maxBodyRatio = context.maxBodyRatio || 0.15;
    if (bodyRatio > maxBodyRatio) return false;

    // Determine doji type based on wick positions
    const upperWick = current.high - Math.max(current.open, current.close);
    const lowerWick = Math.min(current.open, current.close) - current.low;

    context.dojiType = this.classifyDoji(upperWick, lowerWick, range);
    context.bodyRatio = bodyRatio;

    return true;
  },

  /**
   * Classify the type of doji
   */
  classifyDoji(upperWick, lowerWick, range) {
    const upperRatio = upperWick / range;
    const lowerRatio = lowerWick / range;

    // Long-legged doji: both wicks significant
    if (upperRatio > 0.3 && lowerRatio > 0.3) {
      return 'long_legged';
    }

    // Dragonfly doji: long lower wick, little upper
    if (lowerRatio > 0.6 && upperRatio < 0.1) {
      return 'dragonfly'; // Bullish signal
    }

    // Gravestone doji: long upper wick, little lower
    if (upperRatio > 0.6 && lowerRatio < 0.1) {
      return 'gravestone'; // Bearish signal
    }

    // Standard doji
    return 'standard';
  },

  /**
   * Get trading direction based on doji type and context
   */
  getDirection(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return null;

    // Dragonfly doji = bullish
    if (context.dojiType === 'dragonfly') {
      return 'long';
    }

    // Gravestone doji = bearish
    if (context.dojiType === 'gravestone') {
      return 'short';
    }

    // Standard/long-legged: use trend context
    if (previous) {
      // After bearish candle, doji can be bullish reversal
      if (previous.close < previous.open) {
        return 'long';
      }
      // After bullish candle, doji can be bearish reversal
      return 'short';
    }

    return null;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.3; // Dojis are weak signals alone

    // Dragonfly/gravestone are stronger
    if (context.dojiType === 'dragonfly' || context.dojiType === 'gravestone') {
      strength += 0.2;
    }

    // Long-legged shows more indecision
    if (context.dojiType === 'long_legged') {
      strength += 0.1;
    }

    // At support/resistance adds strength
    if (context.nearSupport || context.nearResistance) {
      strength += 0.2;
    }

    // Volume can confirm
    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.1;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.0,
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    maxBodyRatio: 0.15,           // Body must be < 15% of range
    requireLevelContext: true,     // Prefer dojis at key levels
    waitForConfirmation: true      // Wait for next candle to confirm
  },

  exits: {
    targetPoints: 2.0,
    stopLossPoints: 2.0,
    trailingTrigger: 1.0,
    trailingOffset: 0.5,
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

export default DojiPattern;
