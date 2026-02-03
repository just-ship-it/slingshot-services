/**
 * Bearish Fair Value Gap (FVG) Pattern
 *
 * A 3-candle imbalance where there's a gap between candle 0's high
 * and candle 2's low (bearish displacement). Price tends to return
 * to fill these gaps.
 *
 * Detection: Gap between candle[0].high and candle[2].low
 * Entry: When price enters the gap from below
 * Bias: Bearish (short on gap fill)
 */

export const BearishFVGPattern = {
  name: 'bearish_fvg',
  displayName: 'Bearish FVG',
  side: 'short',
  candlesRequired: 3,
  entryType: 'limit', // Limit order at bottom of FVG zone for fill entry

  /**
   * Get optimal entry price for this pattern
   * Entry at the BOTTOM of the FVG zone - price fills up into the gap
   */
  getEntryPrice(current, previous, context = {}) {
    const zone = this.getZone(current, previous, context);
    if (zone) {
      // Entry at the bottom of the FVG zone (where price enters from below)
      return zone.bottom;
    }
    return current.high;
  },

  /**
   * Get stop loss price for this pattern
   * Stop above the FVG zone - if price breaks through, gap is invalidated
   */
  getStopPrice(current, previous, context = {}) {
    const zone = this.getZone(current, previous, context);
    if (zone) {
      const buffer = context.stopBuffer || 0.5;
      return zone.top + buffer;
    }
    const oldest = context.oldest || (context.candles && context.candles[2]);
    return oldest ? oldest.low + 0.5 : current.high + 1;
  },

  /**
   * Detect bearish FVG formation
   * @param {Object} current - Current candle (newest, index 0)
   * @param {Object} previous - Previous candle (index 1)
   * @param {Object} context - Must contain { candles: [c0, c1, c2, ...] } or oldest candle
   * @returns {boolean} True if FVG just formed
   */
  detect(current, previous, context = {}) {
    if (!current || !previous) return false;

    const oldest = context.oldest || (context.candles && context.candles[2]);
    if (!oldest) return false;

    // Bearish FVG: Gap between current high and oldest low
    // oldest.low > current.high creates the gap
    const gapTop = oldest.low;
    const gapBottom = current.high;
    const gapSize = gapTop - gapBottom;

    const minGapPoints = context.minGapPoints || 0.5;
    if (gapSize < minGapPoints) return false;

    // Middle candle should be bearish for valid bearish FVG
    if (previous.close > previous.open) return false;

    return true;
  },

  /**
   * Check if price is entering an existing FVG zone
   */
  detectFill(candle, fvgZone) {
    if (!candle || !fvgZone) return false;

    // Price entering from below (coming up into bearish FVG)
    const enteredFromBelow = candle.low < fvgZone.bottom && candle.high >= fvgZone.bottom;

    return enteredFromBelow;
  },

  /**
   * Extract FVG zone details
   */
  getZone(current, previous, context = {}) {
    const oldest = context.oldest || (context.candles && context.candles[2]);
    if (!oldest) return null;

    const gapTop = oldest.low;
    const gapBottom = current.high;

    if (gapTop <= gapBottom) return null;

    return {
      type: 'bearish',
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

  getStrength(current, previous, context = {}) {
    if (!this.detect(current, previous, context)) return 0;

    const zone = this.getZone(current, previous, context);
    if (!zone) return 0;

    let strength = 0.5;

    if (zone.size > 2) strength += 0.2;
    else if (zone.size > 1) strength += 0.1;

    if (context.avgVolume && previous.volume > context.avgVolume * 1.5) {
      strength += 0.2;
    }

    return Math.min(1, strength);
  },

  filters: {
    volumeMultiplier: 1.0,
    sessions: ['rth', 'premarket'],
    avoidHours: [],
    useOrderFlow: false,
    minGapPoints: 0.5,
    maxAgeCandles: 50
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

export default BearishFVGPattern;
