/**
 * RangeDetector
 *
 * Identifies ranging markets with clear support/resistance boundaries.
 * Validates ranges with:
 * - Minimum touches of both boundaries (>=2 each)
 * - Range width vs ATR comparison
 * - Volume profile confirmation at boundaries
 */

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

export class RangeDetector {
  constructor(params = {}) {
    this.params = {
      lookback: params.lookback || 50,                // Candles to analyze for range
      minTouches: params.minTouches || 2,             // Minimum touches per boundary
      touchProximity: params.touchProximity || 2,     // Points within boundary = "touch"
      maxRangeATRMultiplier: params.maxRangeATRMultiplier || 1.5, // Range width < ATR * multiplier
      atrPeriod: params.atrPeriod || 14,
      ...params
    };
  }

  /**
   * Detect if market is ranging
   *
   * @param {Array} candles - Historical candles
   * @param {Array} swings - Swing points from MarketStructureAnalyzer
   * @returns {Object} Range detection results
   */
  detectRange(candles, swings) {
    if (!candles || candles.length < this.params.lookback) {
      return this.getEmptyResult();
    }

    // Use recent candles
    const recentCandles = candles.slice(-this.params.lookback);

    // Calculate ATR for range width validation
    const atr = TechnicalAnalysis.atr(candles, this.params.atrPeriod);
    const currentATR = atr[atr.length - 1];

    // Find potential support/resistance from swing points
    const swingHighs = swings.filter(s => s.type === 'high').map(s => s.price);
    const swingLows = swings.filter(s => s.type === 'low').map(s => s.price);

    if (swingHighs.length === 0 || swingLows.length === 0) {
      return this.getEmptyResult();
    }

    // Identify boundaries
    const resistance = this.identifyBoundary(swingHighs, recentCandles, 'high');
    const support = this.identifyBoundary(swingLows, recentCandles, 'low');

    if (!resistance || !support) {
      return this.getEmptyResult();
    }

    // Calculate range width
    const rangeWidth = resistance - support;

    // Validate range
    const isValidRange = this.validateRange(
      resistance,
      support,
      rangeWidth,
      currentATR,
      recentCandles
    );

    // Calculate current position within range
    const currentPrice = recentCandles[recentCandles.length - 1].close;
    const rangePosition = (currentPrice - support) / rangeWidth; // 0 = support, 1 = resistance

    return {
      isRanging: isValidRange.valid,
      resistance,
      support,
      rangeWidth,
      rangeWidthATRMultiple: rangeWidth / currentATR,
      resistanceTouches: isValidRange.resistanceTouches,
      supportTouches: isValidRange.supportTouches,
      rangePosition, // 0-1 where 0.5 is midpoint
      confidence: isValidRange.confidence,
      currentPrice,
      atr: currentATR
    };
  }

  /**
   * Identify a boundary level from swing points
   *
   * @param {Array} swingPrices - Swing high or low prices
   * @param {Array} candles - Recent candles
   * @param {string} type - 'high' or 'low'
   * @returns {number} Boundary level
   */
  identifyBoundary(swingPrices, candles, type) {
    if (swingPrices.length === 0) return null;

    // For resistance, use highest recent swing high
    // For support, use lowest recent swing low
    if (type === 'high') {
      return Math.max(...swingPrices);
    } else {
      return Math.min(...swingPrices);
    }
  }

  /**
   * Validate range meets criteria
   *
   * @param {number} resistance - Resistance level
   * @param {number} support - Support level
   * @param {number} rangeWidth - Width of range
   * @param {number} atr - Current ATR
   * @param {Array} candles - Recent candles
   * @returns {Object} Validation results
   */
  validateRange(resistance, support, rangeWidth, atr, candles) {
    // Check 1: Range width vs ATR
    const atrMultiple = rangeWidth / atr;
    const isNarrowEnough = atrMultiple <= this.params.maxRangeATRMultiplier;

    // Check 2: Count boundary touches
    const resistanceTouches = this.countBoundaryTouches(
      resistance,
      candles,
      'high'
    );

    const supportTouches = this.countBoundaryTouches(
      support,
      candles,
      'low'
    );

    const hasEnoughTouches =
      resistanceTouches >= this.params.minTouches &&
      supportTouches >= this.params.minTouches;

    // Check 3: Price oscillating within range (not breaking out)
    const breakoutCount = this.countBreakouts(resistance, support, candles);
    const hasMinimalBreakouts = breakoutCount <= 1; // Allow 1 false breakout

    // Calculate confidence
    let confidence = 0;
    if (isNarrowEnough) confidence += 0.4;
    if (hasEnoughTouches) confidence += 0.4;
    if (hasMinimalBreakouts) confidence += 0.2;

    return {
      valid: isNarrowEnough && hasEnoughTouches && hasMinimalBreakouts,
      confidence,
      resistanceTouches,
      supportTouches,
      breakoutCount,
      atrMultiple
    };
  }

  /**
   * Count touches of a boundary level
   *
   * @param {number} level - Boundary level
   * @param {Array} candles - Recent candles
   * @param {string} type - 'high' or 'low'
   * @returns {number} Touch count
   */
  countBoundaryTouches(level, candles, type) {
    let touches = 0;

    for (const candle of candles) {
      const testPrice = type === 'high' ? candle.high : candle.low;
      const distance = Math.abs(testPrice - level);

      if (distance <= this.params.touchProximity) {
        touches++;
      }
    }

    return touches;
  }

  /**
   * Count breakout attempts (closes outside range)
   *
   * @param {number} resistance
   * @param {number} support
   * @param {Array} candles
   * @returns {number} Breakout count
   */
  countBreakouts(resistance, support, candles) {
    let breakouts = 0;

    for (const candle of candles) {
      if (candle.close > resistance || candle.close < support) {
        breakouts++;
      }
    }

    return breakouts;
  }

  /**
   * Detect if price is near a range boundary
   *
   * @param {Object} rangeData - Range detection results
   * @returns {Object} Boundary proximity
   */
  isNearBoundary(rangeData) {
    if (!rangeData.isRanging) {
      return {
        nearResistance: false,
        nearSupport: false,
        nearMidpoint: false
      };
    }

    const { rangePosition, currentPrice, resistance, support } = rangeData;

    // Near resistance if position > 0.85 or within proximity points
    const nearResistance =
      rangePosition > 0.85 ||
      Math.abs(currentPrice - resistance) <= this.params.touchProximity;

    // Near support if position < 0.15 or within proximity points
    const nearSupport =
      rangePosition < 0.15 ||
      Math.abs(currentPrice - support) <= this.params.touchProximity;

    // Near midpoint if position between 0.4 and 0.6
    const nearMidpoint = rangePosition >= 0.4 && rangePosition <= 0.6;

    return {
      nearResistance,
      nearSupport,
      nearMidpoint,
      rangePosition
    };
  }

  /**
   * Get empty result structure
   */
  getEmptyResult() {
    return {
      isRanging: false,
      resistance: null,
      support: null,
      rangeWidth: null,
      rangeWidthATRMultiple: null,
      resistanceTouches: 0,
      supportTouches: 0,
      rangePosition: null,
      confidence: 0,
      currentPrice: null,
      atr: null
    };
  }
}
