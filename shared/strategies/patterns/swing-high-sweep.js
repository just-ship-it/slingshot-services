/**
 * Swing High Sweep Pattern
 *
 * Price sweeps above a recent swing high (liquidity grab), then reverses
 * back below. This indicates stops were triggered and smart money is
 * distributing.
 *
 * Entry: Limit order at the swept swing high level (liquidity zone)
 * Bias: Bearish reversal after liquidity sweep
 */

export const SwingHighSweepPattern = {
  name: 'swing_high_sweep',
  displayName: 'Swing High Sweep',
  side: 'short',
  candlesRequired: 2,
  entryType: 'limit', // Limit order at swept level

  /**
   * Detect swing high sweep pattern
   * @param {Object} current - Current candle
   * @param {Object} previous - Previous candle
   * @param {Object} context - Must contain { swingHighs: [{price, timestamp}], ... }
   * @returns {boolean} True if pattern detected
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    const swingHighs = context.swingHighs || [];
    if (swingHighs.length === 0) return false;

    for (const swing of swingHighs) {
      // Current candle's high went above the swing
      if (current.high <= swing.price) continue;

      // But price closed back below the swing (reversal)
      if (current.close >= swing.price) continue;

      // Calculate rejection wick ratio
      const range = current.high - current.low;
      if (range === 0) continue;

      const upperWick = current.high - Math.max(current.open, current.close);
      const wickRatio = upperWick / range;

      const minWickRatio = context.minWickRatio || 0.3;
      if (wickRatio < minWickRatio) continue;

      // Store sweep details
      context.sweptLevel = swing.price;
      context.sweepDepth = current.high - swing.price;
      context.wickRatio = wickRatio;

      return true;
    }

    return false;
  },

  /**
   * Find swing highs in historical candles
   */
  findSwingHighs(candles, lookback = 3) {
    const swingHighs = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
      const candle = candles[i];
      let isSwingHigh = true;

      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].high >= candle.high) {
          isSwingHigh = false;
          break;
        }
      }

      if (isSwingHigh) {
        swingHighs.push({
          price: candle.high,
          timestamp: candle.timestamp,
          index: i
        });
      }
    }

    return swingHighs;
  },

  /**
   * Get optimal entry price for this pattern
   * Entry at the swept swing high level - the liquidity zone where stops were triggered
   */
  getEntryPrice(current, previous, context = {}) {
    if (context.sweptLevel) {
      // Short entry slightly below the swept level for better fill
      return context.sweptLevel - 0.25;
    }
    return current.high - 0.25;
  },

  /**
   * Get stop loss price for this pattern
   * Stop above the sweep high - if price goes higher, the setup failed
   */
  getStopPrice(current, previous, context = {}) {
    const sweepHigh = current.high;
    const buffer = context.stopBuffer || 0.5;
    return sweepHigh + buffer;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    let strength = 0.5;

    if (context.sweepDepth > 2) strength += 0.2;
    else if (context.sweepDepth > 1) strength += 0.1;

    if (context.wickRatio > 0.6) strength += 0.2;
    else if (context.wickRatio > 0.4) strength += 0.1;

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
    minWickRatio: 0.3,
    maxSweepBars: 2,
    swingLookback: 5
  },

  exits: {
    targetPoints: 3.0,
    stopLossPoints: 2.0,
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

export default SwingHighSweepPattern;
