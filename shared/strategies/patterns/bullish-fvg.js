/**
 * Bullish Fair Value Gap (FVG) Pattern
 *
 * A 3-candle imbalance where there's a gap between candle 0's low
 * and candle 2's high (bullish displacement). Price tends to return
 * to fill these gaps.
 *
 * Detection: Gap between candle[2].high and candle[0].low
 * Entry: When price enters the gap from above
 * Bias: Bullish (long on gap fill)
 */

export const BullishFVGPattern = {
  name: 'bullish_fvg',
  displayName: 'Bullish FVG',
  side: 'long',
  candlesRequired: 3,
  entryType: 'limit', // Limit order at top of FVG zone for fill entry

  /**
   * Detect bullish FVG formation
   * This detects the CREATION of a bullish FVG
   * @param {Object} current - Current candle (newest, index 0)
   * @param {Object} previous - Previous candle (index 1)
   * @param {Object} context - Must contain { candles: [c0, c1, c2, ...] } or oldest candle
   * @returns {boolean} True if FVG just formed
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    // Need candle from 2 bars ago
    const oldest = context.oldest || (context.candles && context.candles[2]);
    if (!oldest) return false;

    // Bullish FVG: Gap between oldest high and current low
    // oldest.high < current.low creates the gap
    const gapTop = current.low;
    const gapBottom = oldest.high;
    const gapSize = gapTop - gapBottom;

    // Minimum gap size filter
    const minGapPoints = context.minGapPoints || 0.5;
    if (gapSize < minGapPoints) return false;

    // The middle candle should show strong displacement (large range)
    const middleRange = previous.high - previous.low;
    const middleBody = Math.abs(previous.close - previous.open);

    // Middle candle should be bullish for valid bullish FVG
    if (previous.close < previous.open) return false;

    return true;
  },

  /**
   * Check if price is entering an existing FVG zone
   * @param {Object} candle - Current candle
   * @param {Object} fvgZone - { top, bottom, timestamp }
   * @returns {boolean} True if price entering FVG
   */
  detectFill(candle, fvgZone) {
    if (!candle || !fvgZone) return false;

    // Price entering from above (coming down into bullish FVG)
    // High was above the gap, low dipped into the gap
    const enteredFromAbove = candle.high > fvgZone.top && candle.low <= fvgZone.top;

    return enteredFromAbove;
  },

  /**
   * Extract FVG zone details from the formation candles
   */
  getZone(current, previous, context = {}) {
    const oldest = context.oldest || (context.candles && context.candles[2]);
    if (!oldest) return null;

    const gapTop = current.low;
    const gapBottom = oldest.high;

    if (gapTop <= gapBottom) return null;

    return {
      type: 'bullish',
      top: gapTop,
      bottom: gapBottom,
      midpoint: (gapTop + gapBottom) / 2,
      size: gapTop - gapBottom,
      timestamp: current.timestamp,
      formationCandles: {
        c0: current,
        c1: previous,
        c2: oldest
      }
    };
  },

  /**
   * Get optimal entry price for this pattern
   * Entry at the TOP of the FVG zone - price fills down into the gap
   * This gives the best risk/reward as we enter at the edge of imbalance
   */
  getEntryPrice(current, previous, context = {}) {
    const zone = this.getZone(current, previous, context);
    if (zone) {
      // Entry at the top of the FVG zone (where price enters from above)
      return zone.top;
    }
    // Fallback to current low
    return current.low;
  },

  /**
   * Get stop loss price for this pattern
   * Stop below the FVG zone - if price breaks through, gap is invalidated
   */
  getStopPrice(current, previous, context = {}) {
    const zone = this.getZone(current, previous, context);
    if (zone) {
      const buffer = context.stopBuffer || 0.5;
      return zone.bottom - buffer;
    }
    const oldest = context.oldest || (context.candles && context.candles[2]);
    return oldest ? oldest.high - 0.5 : current.low - 1;
  },

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    const zone = this.getZone(current, previous, context);
    if (!zone) return 0;

    let strength = 0.5;

    // Larger gaps are stronger
    if (zone.size > 2) strength += 0.2;
    else if (zone.size > 1) strength += 0.1;

    // Volume confirmation on middle candle
    if (context.avgVolume && previous.volume > context.avgVolume * 1.5) {
      strength += 0.2;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.0,        // FVGs don't require volume confirmation
    sessions: ['rth', 'premarket'],
    avoidHours: [],
    useOrderFlow: false,
    minGapPoints: 0.5,            // Minimum gap size
    maxAgeCandles: 50             // Max candles old for valid FVG
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

export default BullishFVGPattern;
