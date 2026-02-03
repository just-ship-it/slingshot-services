/**
 * Outside Bar Pattern
 *
 * A candle that completely engulfs the previous candle's range
 * (both high AND low exceed previous). Strong momentum/reversal signal.
 *
 * Entry: In direction of outside bar close
 * Bias: Direction of the outside bar's body
 */

export const OutsideBarPattern = {
  name: 'outside_bar',
  displayName: 'Outside Bar',
  side: 'neutral', // Direction determined by candle color
  candlesRequired: 2,
  entryType: 'limit', // Limit order for pullback entry

  /**
   * Get optimal entry price for this pattern
   * Entry on pullback - for long, enter at outside bar's midpoint or low
   * For short, enter at outside bar's midpoint or high
   */
  getEntryPrice(current, previous, context = {}) {
    const isBullish = current.close > current.open;
    const midpoint = (current.high + current.low) / 2;

    if (isBullish) {
      // For bullish outside bar, entry on pullback to body low area
      const bodyLow = Math.min(current.open, current.close);
      // Use the higher of midpoint and body low for better fill chance
      return Math.max(bodyLow, midpoint - (current.high - current.low) * 0.25);
    } else {
      // For bearish outside bar, entry on pullback to body high area
      const bodyHigh = Math.max(current.open, current.close);
      return Math.min(bodyHigh, midpoint + (current.high - current.low) * 0.25);
    }
  },

  /**
   * Get stop loss price for this pattern
   * Stop beyond outside bar's extreme
   */
  getStopPrice(current, previous, context = {}) {
    const isBullish = current.close > current.open;
    const buffer = context.stopBuffer || 0.5;

    if (isBullish) {
      return current.low - buffer;
    } else {
      return current.high + buffer;
    }
  },

  /**
   * Detect outside bar pattern
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    // Current must engulf previous range completely
    const isOutside = current.high > previous.high && current.low < previous.low;

    if (!isOutside) return false;

    // Calculate direction based on close vs open
    const isBullish = current.close > current.open;

    // Store context
    context.direction = isBullish ? 'long' : 'short';
    context.outsideRange = current.high - current.low;
    context.previousRange = previous.high - previous.low;
    context.expansionRatio = context.outsideRange / context.previousRange;

    return true;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.5;

    // Larger expansion = stronger signal
    if (context.expansionRatio > 2) strength += 0.2;
    else if (context.expansionRatio > 1.5) strength += 0.1;

    // Strong body (not doji-like)
    const body = Math.abs(current.close - current.open);
    const range = current.high - current.low;
    const bodyRatio = body / range;

    if (bodyRatio > 0.6) strength += 0.15;
    else if (bodyRatio > 0.4) strength += 0.1;

    // Volume confirmation
    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.1;
    }

    // Close near the extreme in direction of move
    const isBullish = current.close > current.open;
    if (isBullish) {
      const closeFromHigh = (current.high - current.close) / range;
      if (closeFromHigh < 0.1) strength += 0.05;
    } else {
      const closeFromLow = (current.close - current.low) / range;
      if (closeFromLow < 0.1) strength += 0.05;
    }

    return Math.min(1, strength);
  },

  /**
   * Get the trading direction for this pattern
   */
  getDirection(current) {
    if (!current) return null;
    return current.close > current.open ? 'long' : 'short';
  },

  filters: {
    volumeMultiplier: 1.5,        // Outside bars need volume
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    minExpansionRatio: 1.2        // Must be at least 20% bigger than previous
  },

  exits: {
    targetPoints: 3.0,            // Outside bars often lead to continuation
    stopLossPoints: 2.5,
    trailingTrigger: 2.0,
    trailingOffset: 1.0,
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

export default OutsideBarPattern;
