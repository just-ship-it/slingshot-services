/**
 * Three White Soldiers Pattern
 *
 * Three consecutive bullish candles, each closing higher than the previous
 * and opening within the previous candle's body. Strong bullish continuation.
 *
 * Entry: Long at third candle close
 * Bias: Bullish continuation
 */

export const ThreeWhiteSoldiersPattern = {
  name: 'three_white_soldiers',
  displayName: 'Three White Soldiers',
  side: 'long',
  candlesRequired: 3,
  entryType: 'limit', // Limit order for pullback to second soldier

  /**
   * Get optimal entry price for this pattern
   * Entry on pullback to the second soldier's close (support level)
   * This gives better entry than chasing at third candle close
   */
  getEntryPrice(current, previous, context = {}) {
    // Entry at second soldier's close - common pullback level
    if (context.secondSoldier) {
      return context.secondSoldier.close;
    }
    return previous.close;
  },

  /**
   * Get stop loss price for this pattern
   * Stop below the first soldier's low
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    if (context.firstSoldier) {
      return context.firstSoldier.low - buffer;
    }
    // Fallback
    const oldest = context.oldest || (context.candles && context.candles[2]);
    return (oldest?.low || current.low) - buffer;
  },

  /**
   * Detect three white soldiers pattern
   * @param {Object} current - Current candle (third soldier)
   * @param {Object} previous - Previous candle (second soldier)
   * @param {Object} context - Must contain { oldest } or { candles } for first soldier
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    const first = context.oldest || (context.candles && context.candles[2]);
    if (!first) return false;

    // All three must be bullish (green)
    if (first.close <= first.open) return false;
    if (previous.close <= previous.open) return false;
    if (current.close <= current.open) return false;

    // Each must close higher than the previous
    if (previous.close <= first.close) return false;
    if (current.close <= previous.close) return false;

    // Each should open within the previous candle's body
    if (previous.open < first.open || previous.open > first.close) return false;
    if (current.open < previous.open || current.open > previous.close) return false;

    // Optional: Bodies should be similar size (not one tiny candle)
    const body1 = first.close - first.open;
    const body2 = previous.close - previous.open;
    const body3 = current.close - current.open;

    const minBodyRatio = context.minBodyRatio || 0.5;
    const maxBodyRatio = 1 / minBodyRatio;

    if (body2 / body1 < minBodyRatio || body2 / body1 > maxBodyRatio) return false;
    if (body3 / body2 < minBodyRatio || body3 / body2 > maxBodyRatio) return false;

    // Store context
    context.firstSoldier = first;
    context.secondSoldier = previous;
    context.thirdSoldier = current;
    context.totalMove = current.close - first.open;

    return true;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.6; // Strong pattern

    // Larger total move = stronger
    if (context.totalMove > 5) strength += 0.2;
    else if (context.totalMove > 3) strength += 0.1;

    // Small upper wicks = stronger (buyers in control)
    const avgUpperWick = [
      context.firstSoldier.high - context.firstSoldier.close,
      context.secondSoldier.high - context.secondSoldier.close,
      context.thirdSoldier.high - context.thirdSoldier.close
    ].reduce((a, b) => a + b, 0) / 3;

    const avgRange = [
      context.firstSoldier.high - context.firstSoldier.low,
      context.secondSoldier.high - context.secondSoldier.low,
      context.thirdSoldier.high - context.thirdSoldier.low
    ].reduce((a, b) => a + b, 0) / 3;

    if (avgUpperWick / avgRange < 0.1) strength += 0.1;

    // Volume increasing across the three candles
    if (previous.volume > context.firstSoldier?.volume &&
        current.volume > previous.volume) {
      strength += 0.1;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.0,
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    minBodyRatio: 0.5             // Body size consistency
  },

  exits: {
    targetPoints: 3.0,            // Continuation patterns can run
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

export default ThreeWhiteSoldiersPattern;
