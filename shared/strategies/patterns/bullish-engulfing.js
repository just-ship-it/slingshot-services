/**
 * Bullish Engulfing Pattern
 *
 * A two-candle reversal pattern where a bullish (green) candle completely
 * engulfs the body of the previous bearish (red) candle.
 *
 * Entry: Long at candle close
 * Bias: Bullish reversal
 */

export const BullishEngulfingPattern = {
  name: 'bullish_engulfing',
  displayName: 'Bullish Engulfing',
  side: 'long',
  candlesRequired: 2,
  entryType: 'limit', // Limit order at engulfing candle low for pullback entry

  /**
   * Detect bullish engulfing pattern
   * @param {Object} current - Current candle
   * @param {Object} previous - Previous candle
   * @param {Object} context - Additional context (historical candles, volume, etc.)
   * @returns {boolean} True if pattern detected
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    const currentBody = current.close - current.open;
    const prevBody = previous.close - previous.open;

    // Current must be bullish (green)
    if (currentBody <= 0) return false;

    // Previous must be bearish (red)
    if (prevBody >= 0) return false;

    // Current body must engulf previous body
    // Close above previous open AND open below previous close
    if (current.close <= previous.open) return false;
    if (current.open >= previous.close) return false;

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
   * Get optimal entry price for this pattern
   * Entry at the low of the engulfing candle - expecting a pullback to fill
   * the imbalance before continuation higher
   */
  getEntryPrice(current, previous, context = {}) {
    // Entry at the engulfing candle's low + small buffer
    // This captures the "wick fill" that often happens after engulfing patterns
    const entryBuffer = 0.25;
    return current.low + entryBuffer;
  },

  /**
   * Get stop loss price for this pattern
   * Stop below the engulfing candle's low
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    return current.low - buffer;
  },

  /**
   * Calculate pattern strength (0-1)
   * @param {Object} current - Current candle
   * @param {Object} previous - Previous candle
   * @param {Object} context - Additional context
   * @returns {number} Pattern strength 0-1
   */
  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.5; // Base strength

    // Stronger if current body is larger relative to previous
    const currentBody = Math.abs(current.close - current.open);
    const prevBody = Math.abs(previous.close - previous.open);
    if (prevBody > 0) {
      const bodyRatio = currentBody / prevBody;
      if (bodyRatio > 2) strength += 0.2;
      else if (bodyRatio > 1.5) strength += 0.1;
    }

    // Stronger with volume confirmation
    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.2;
    }

    // Stronger at support levels
    if (context.nearSupport) {
      strength += 0.1;
    }

    return Math.min(1, strength);
  },

  // Pattern-specific filters (configured per-pattern after analysis)
  filters: {
    volumeMultiplier: 1.5,        // Require 1.5x volume for higher quality
    sessions: ['rth'],            // Default to RTH only
    avoidHours: [],               // Hours to avoid (UTC)
    useOrderFlow: false,          // No order flow filter by default
    minBodyRatio: 0.5,            // Body must be >= 50% of range
    nearSupportRequired: false    // Optionally require near support level
  },

  // Pattern-specific exit parameters
  exits: {
    targetPoints: 2.5,
    stopLossPoints: 2.5,
    trailingTrigger: 1.5,
    trailingOffset: 0.75,
    maxHoldBars: 5
  },

  // Metrics placeholder (populated by analysis)
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

export default BullishEngulfingPattern;
