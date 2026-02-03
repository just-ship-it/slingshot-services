/**
 * Morning Star Pattern
 *
 * A 3-candle bullish reversal pattern:
 * 1. Large bearish candle
 * 2. Small body candle (star) gapping down
 * 3. Large bullish candle closing above midpoint of first
 *
 * Entry: Long at third candle close
 * Bias: Bullish reversal
 */

export const MorningStarPattern = {
  name: 'morning_star',
  displayName: 'Morning Star',
  side: 'long',
  candlesRequired: 3,
  entryType: 'limit', // Limit order for pullback to star candle

  /**
   * Get optimal entry price for this pattern
   * Entry on pullback to the star candle's high area
   * The star is the reversal point - entering there gives best R:R
   */
  getEntryPrice(current, previous, context = {}) {
    if (context.starCandle) {
      // Entry at star candle's high - the reversal zone
      return context.starCandle.high;
    }
    return previous.high;
  },

  /**
   * Get stop loss price for this pattern
   * Stop below the star candle's low (below the reversal point)
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    if (context.starCandle) {
      return context.starCandle.low - buffer;
    }
    return previous.low - buffer;
  },

  /**
   * Detect morning star pattern
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    const first = context.oldest || (context.candles && context.candles[2]);
    if (!first) return false;

    // First candle must be bearish with significant body
    if (first.close >= first.open) return false;
    const firstBody = first.open - first.close;
    const firstRange = first.high - first.low;
    if (firstBody / firstRange < 0.5) return false; // Need strong bearish candle

    // Second candle (star) must have small body
    const starBody = Math.abs(previous.close - previous.open);
    const starRange = previous.high - previous.low;
    const maxStarBodyRatio = context.maxStarBodyRatio || 0.3;
    if (starRange > 0 && starBody / starRange > maxStarBodyRatio) return false;

    // Star should gap down from first candle's close
    // In futures, we're lenient on gaps - just require star to be lower
    if (Math.max(previous.open, previous.close) >= first.close) {
      // Allow if star high is below first close (some gap)
      if (previous.high >= first.close) return false;
    }

    // Third candle must be bullish
    if (current.close <= current.open) return false;

    // Third candle should close above first candle's midpoint
    const firstMidpoint = (first.open + first.close) / 2;
    if (current.close < firstMidpoint) return false;

    // Third candle should gap up from star (or at least open higher)
    if (current.open <= Math.min(previous.open, previous.close)) return false;

    context.firstCandle = first;
    context.starCandle = previous;
    context.confirmCandle = current;
    context.reversal = current.close - first.close;

    return true;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.6; // Strong reversal pattern

    // Stronger if third candle closes near first candle's open
    const recoverRatio = (current.close - context.firstCandle.close) /
                          (context.firstCandle.open - context.firstCandle.close);
    if (recoverRatio > 1) strength += 0.2;
    else if (recoverRatio > 0.8) strength += 0.1;

    // Star being a doji adds strength
    const starBody = Math.abs(context.starCandle.close - context.starCandle.open);
    const starRange = context.starCandle.high - context.starCandle.low;
    if (starRange > 0 && starBody / starRange < 0.1) strength += 0.1;

    // Volume increasing on third candle
    if (context.firstCandle.volume && current.volume > context.firstCandle.volume) {
      strength += 0.1;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.0,
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    maxStarBodyRatio: 0.3
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

export default MorningStarPattern;
