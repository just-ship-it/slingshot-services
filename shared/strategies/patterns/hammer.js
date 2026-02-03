/**
 * Hammer Pattern
 *
 * Classic bullish reversal candle appearing at lows. Similar to bullish pin bar
 * but specifically requires a bullish (green) close and appears after a downtrend.
 *
 * Entry: Long at candle close
 * Bias: Bullish reversal
 */

export const HammerPattern = {
  name: 'hammer',
  displayName: 'Hammer',
  side: 'long',
  candlesRequired: 2, // Need previous candle to confirm downtrend
  entryType: 'limit', // Limit order near hammer low (rejection zone)

  /**
   * Detect hammer pattern
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
    if (body === 0) return false; // Hammer needs a body (not a doji)

    // Upper wick should be small or none (< 10% of range)
    if (upperWick / range > 0.1) return false;

    // Lower wick should be >= 60% of range
    if (lowerWick / range < 0.6) return false;

    // Optional: Require bullish close (green candle)
    const requireBullishClose = context.requireBullishClose !== false;
    if (requireBullishClose && current.close < current.open) return false;

    // Optional: Require previous candle to be bearish (confirms downtrend)
    if (previous && context.requireDowntrend !== false) {
      if (previous.close >= previous.open) return false; // Previous should be red
    }

    return true;
  },

  /**
   * Get optimal entry price for this pattern
   * Entry near the bottom of the hammer's body - in the rejection zone
   * Not at the absolute low (too aggressive) but where the body starts
   */
  getEntryPrice(current, previous, context = {}) {
    // Entry at the body low (bottom of candle body, not wick)
    // This is where price showed rejection and started reversing
    const bodyLow = Math.min(current.open, current.close);
    return bodyLow;
  },

  /**
   * Get stop loss price for this pattern
   * Stop below the hammer's wick low - if broken, rejection failed
   */
  getStopPrice(current, previous, context = {}) {
    const buffer = context.stopBuffer || 0.5;
    return current.low - buffer;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    const range = current.high - current.low;
    const lowerWick = Math.min(current.open, current.close) - current.low;

    let strength = 0.6; // Hammers are strong patterns

    const wickRatio = lowerWick / range;
    if (wickRatio > 0.75) strength += 0.15;
    else if (wickRatio > 0.65) strength += 0.1;

    // Stronger if closes green
    if (current.close > current.open) {
      strength += 0.1;
    }

    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.1;
    }

    if (context.nearSupport) {
      strength += 0.05;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.5,        // Hammers work better with volume
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    minWickToBodyRatio: 2.0,
    requireBullishClose: true,
    requireDowntrend: true
  },

  exits: {
    targetPoints: 2.5,
    stopLossPoints: 1.5,          // Tight stop below hammer low
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

export default HammerPattern;
