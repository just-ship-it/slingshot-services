/**
 * Swing Low Sweep Pattern
 *
 * Price sweeps below a recent swing low (liquidity grab), then reverses
 * back above. This indicates stops were triggered and smart money is
 * accumulating.
 *
 * Entry: Limit order at the swept swing low level (liquidity zone)
 * Bias: Bullish reversal after liquidity sweep
 */

export const SwingLowSweepPattern = {
  name: 'swing_low_sweep',
  displayName: 'Swing Low Sweep',
  side: 'long',
  candlesRequired: 2, // Need current + swing detection lookback
  entryType: 'limit', // Limit order at swept level

  /**
   * Detect swing low sweep pattern
   * @param {Object} current - Current candle
   * @param {Object} previous - Previous candle
   * @param {Object} context - Must contain { swingLows: [{price, timestamp}], ... }
   * @returns {boolean} True if pattern detected
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    const swingLows = context.swingLows || [];
    if (swingLows.length === 0) return false;

    // Check each swing low to see if we swept it
    for (const swing of swingLows) {
      // Current candle's low went below the swing
      if (current.low >= swing.price) continue;

      // But price closed back above the swing (reversal)
      if (current.close <= swing.price) continue;

      // Calculate rejection wick ratio
      const range = current.high - current.low;
      if (range === 0) continue;

      const lowerWick = Math.min(current.open, current.close) - current.low;
      const wickRatio = lowerWick / range;

      const minWickRatio = context.minWickRatio || 0.3;
      if (wickRatio < minWickRatio) continue;

      // Sweep duration check - current candle is the sweep
      // For more conservative: check if sweep lasted <= maxSweepBars
      const maxSweepBars = context.maxSweepBars || 2;

      // Store sweep details in context for signal generation
      context.sweptLevel = swing.price;
      context.sweepDepth = swing.price - current.low;
      context.wickRatio = wickRatio;

      return true;
    }

    return false;
  },

  /**
   * Find swing lows in historical candles
   * @param {Object[]} candles - Array of candles (oldest first)
   * @param {number} lookback - Bars to each side to confirm swing
   * @returns {Object[]} Array of swing lows { price, timestamp, index }
   */
  findSwingLows(candles, lookback = 3) {
    const swingLows = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
      const candle = candles[i];
      let isSwingLow = true;

      // Check that this low is lower than surrounding candles
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].low <= candle.low) {
          isSwingLow = false;
          break;
        }
      }

      if (isSwingLow) {
        swingLows.push({
          price: candle.low,
          timestamp: candle.timestamp,
          index: i
        });
      }
    }

    return swingLows;
  },

  /**
   * Get optimal entry price for this pattern
   * Entry at the swept swing low level - the liquidity zone where stops were triggered
   * @param {Object} current - Current candle
   * @param {Object} previous - Previous candle
   * @param {Object} context - Pattern context (must contain sweptLevel from detect())
   * @returns {number} Entry price
   */
  getEntryPrice(current, previous, context = {}) {
    // Entry at the swept swing low level
    // This is where liquidity was grabbed - optimal entry for the reversal
    if (context.sweptLevel) {
      // Add small buffer above the swept level (0.25 points) for better fill
      return context.sweptLevel + 0.25;
    }
    // Fallback to candle low if no swept level
    return current.low + 0.25;
  },

  /**
   * Get stop loss price for this pattern
   * Stop below the sweep low - if price goes lower, the setup failed
   */
  getStopPrice(current, previous, context = {}) {
    // Stop below the sweep depth
    const sweepLow = current.low;
    const buffer = context.stopBuffer || 0.5;
    return sweepLow - buffer;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.5;

    // Deeper sweep = stronger signal
    if (context.sweepDepth > 2) strength += 0.2;
    else if (context.sweepDepth > 1) strength += 0.1;

    // Larger rejection wick = stronger
    if (context.wickRatio > 0.6) strength += 0.2;
    else if (context.wickRatio > 0.4) strength += 0.1;

    // Volume confirmation
    if (context.avgVolume && current.volume > context.avgVolume * 1.5) {
      strength += 0.1;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.0,        // Sweeps work without volume confirmation
    sessions: ['rth'],
    avoidHours: [],
    useOrderFlow: false,
    minWickRatio: 0.3,            // Wick must be 30%+ of range
    maxSweepBars: 2,              // Sweep should be fast (1-2 candles)
    swingLookback: 5              // Bars each side to confirm swing
  },

  exits: {
    targetPoints: 3.0,            // Sweeps often lead to larger moves
    stopLossPoints: 2.0,          // Stop below sweep low
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

export default SwingLowSweepPattern;
