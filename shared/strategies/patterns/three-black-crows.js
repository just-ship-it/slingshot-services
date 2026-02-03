/**
 * Three Black Crows Pattern
 *
 * Three consecutive bearish candles, each closing lower than the previous
 * and opening within the previous candle's body. Strong bearish continuation.
 *
 * Entry: Short at third candle close
 * Bias: Bearish continuation
 */

export const ThreeBlackCrowsPattern = {
  name: 'three_black_crows',
  displayName: 'Three Black Crows',
  side: 'short',
  candlesRequired: 3,
  entryType: 'limit', // Limit order for pullback to second crow

  /**
   * Get optimal entry price for this pattern
   * Entry on pullback to the second crow's close (resistance level)
   */
  getEntryPrice(current, previous, context = {}) {
    if (context.secondCrow) {
      return context.secondCrow.close;
    }
    return previous.close;
  },

  /**
   * Get stop loss price for this pattern
   * Stop above the first crow's high
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    if (context.firstCrow) {
      return context.firstCrow.high + buffer;
    }
    const oldest = context.oldest || (context.candles && context.candles[2]);
    return (oldest?.high || current.high) + buffer;
  },

  /**
   * Detect three black crows pattern
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    const first = context.oldest || (context.candles && context.candles[2]);
    if (!first) return false;

    // All three must be bearish (red)
    if (first.close >= first.open) return false;
    if (previous.close >= previous.open) return false;
    if (current.close >= current.open) return false;

    // Each must close lower than the previous
    if (previous.close >= first.close) return false;
    if (current.close >= previous.close) return false;

    // Each should open within the previous candle's body
    if (previous.open > first.open || previous.open < first.close) return false;
    if (current.open > previous.open || current.open < previous.close) return false;

    // Bodies should be similar size
    const body1 = first.open - first.close;
    const body2 = previous.open - previous.close;
    const body3 = current.open - current.close;

    const minBodyRatio = context.minBodyRatio || 0.5;
    const maxBodyRatio = 1 / minBodyRatio;

    if (body2 / body1 < minBodyRatio || body2 / body1 > maxBodyRatio) return false;
    if (body3 / body2 < minBodyRatio || body3 / body2 > maxBodyRatio) return false;

    context.firstCrow = first;
    context.secondCrow = previous;
    context.thirdCrow = current;
    context.totalMove = first.open - current.close;

    return true;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.6;

    if (context.totalMove > 5) strength += 0.2;
    else if (context.totalMove > 3) strength += 0.1;

    // Small lower wicks = stronger (sellers in control)
    const avgLowerWick = [
      context.firstCrow.close - context.firstCrow.low,
      context.secondCrow.close - context.secondCrow.low,
      context.thirdCrow.close - context.thirdCrow.low
    ].reduce((a, b) => a + b, 0) / 3;

    const avgRange = [
      context.firstCrow.high - context.firstCrow.low,
      context.secondCrow.high - context.secondCrow.low,
      context.thirdCrow.high - context.thirdCrow.low
    ].reduce((a, b) => a + b, 0) / 3;

    if (avgLowerWick / avgRange < 0.1) strength += 0.1;

    if (previous.volume > context.firstCrow?.volume &&
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
    minBodyRatio: 0.5
  },

  exits: {
    targetPoints: 3.0,
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

export default ThreeBlackCrowsPattern;
