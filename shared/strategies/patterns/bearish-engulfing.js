/**
 * Bearish Engulfing Pattern
 *
 * A two-candle reversal pattern where a bearish (red) candle completely
 * engulfs the body of the previous bullish (green) candle.
 *
 * Entry: Short at candle close
 * Bias: Bearish reversal
 */

export const BearishEngulfingPattern = {
  name: 'bearish_engulfing',
  displayName: 'Bearish Engulfing',
  side: 'short',
  candlesRequired: 2,
  entryType: 'limit', // Limit order at engulfing candle high for pullback entry

  /**
   * Get optimal entry price for this pattern
   * Entry at the high of the engulfing candle - expecting a pullback to fill
   * the imbalance before continuation lower
   */
  getEntryPrice(current, previous, context = {}) {
    const entryBuffer = 0.25;
    return current.high - entryBuffer;
  },

  /**
   * Get stop loss price for this pattern
   * Stop above the engulfing candle's high
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    return current.high + buffer;
  },

  /**
   * Detect bearish engulfing pattern
   * @param {Object} current - Current candle
   * @param {Object} previous - Previous candle
   * @param {Object} context - Additional context
   * @returns {boolean} True if pattern detected
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    const currentBody = current.close - current.open;
    const prevBody = previous.close - previous.open;

    // Current must be bearish (red)
    if (currentBody >= 0) return false;

    // Previous must be bullish (green)
    if (prevBody <= 0) return false;

    // Current body must engulf previous body
    // Close below previous open AND open above previous close
    if (current.close >= previous.open) return false;
    if (current.open <= previous.close) return false;

    // Optional: Require minimum body size relative to range
    const currentRange = current.high - current.low;
    if (currentRange > 0) {
      const bodyRatio = Math.abs(currentBody) / currentRange;
      const minBodyRatio = context.minBodyRatio || 0.5;
      if (bodyRatio < minBodyRatio) return false;
    }

    return true;
  },

  /**
   * Calculate pattern strength (0-1)
   */
  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.5;

    const currentBody = Math.abs(current.close - current.open);
    const prevBody = Math.abs(previous.close - previous.open);
    if (prevBody > 0) {
      const bodyRatio = currentBody / prevBody;
      if (bodyRatio > 2) strength += 0.2;
      else if (bodyRatio > 1.5) strength += 0.1;
    }

    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.2;
    }

    if (context.nearResistance) {
      strength += 0.1;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.5,
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    minBodyRatio: 0.5,
    nearResistanceRequired: false
  },

  exits: {
    targetPoints: 2.5,
    stopLossPoints: 2.5,
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

export default BearishEngulfingPattern;
