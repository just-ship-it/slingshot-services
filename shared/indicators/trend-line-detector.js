/**
 * TrendLineDetector
 *
 * Calculates trend lines using linear regression on swing points.
 * Tracks upper/lower trend lines (channels) and measures distance to lines.
 */

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

export class TrendLineDetector {
  constructor(params = {}) {
    this.params = {
      swingLookback: params.swingLookback || 5,           // Lookback for swing detection
      minSwingPoints: params.minSwingPoints || 3,         // Minimum swing points for trend line
      channelLookback: params.channelLookback || 20,      // Candles to use for channel calculation
      ...params
    };
  }

  /**
   * Detect trend lines from swing points
   *
   * @param {Array} candles - Historical candles
   * @param {Array} swings - Swing points from MarketStructureAnalyzer
   * @returns {Object} Trend line data
   */
  detectTrendLines(candles, swings) {
    if (!candles || candles.length < this.params.channelLookback) {
      return this.getEmptyResult();
    }

    // Separate swing highs and lows
    const swingHighs = swings.filter(s => s.type === 'high');
    const swingLows = swings.filter(s => s.type === 'low');

    // Calculate upper trend line (resistance) from swing highs
    const upperTrendLine = this.calculateTrendLine(
      swingHighs,
      candles,
      'high'
    );

    // Calculate lower trend line (support) from swing lows
    const lowerTrendLine = this.calculateTrendLine(
      swingLows,
      candles,
      'low'
    );

    // Calculate distance to trend lines
    const currentCandle = candles[candles.length - 1];
    const distanceToUpper = upperTrendLine.valid
      ? upperTrendLine.currentValue - currentCandle.close
      : null;

    const distanceToLower = lowerTrendLine.valid
      ? currentCandle.close - lowerTrendLine.currentValue
      : null;

    return {
      upperTrendLine,
      lowerTrendLine,
      distanceToUpper,
      distanceToLower,
      channelWidth: (upperTrendLine.valid && lowerTrendLine.valid)
        ? upperTrendLine.currentValue - lowerTrendLine.currentValue
        : null,
      isValid: upperTrendLine.valid || lowerTrendLine.valid
    };
  }

  /**
   * Calculate trend line using linear regression
   *
   * @param {Array} swingPoints - Swing highs or lows
   * @param {Array} candles - Historical candles
   * @param {string} type - 'high' or 'low'
   * @returns {Object} Trend line data
   */
  calculateTrendLine(swingPoints, candles, type) {
    // Need minimum swing points
    if (swingPoints.length < this.params.minSwingPoints) {
      return {
        valid: false,
        slope: null,
        intercept: null,
        currentValue: null,
        r2: null
      };
    }

    // Use recent swings within lookback period
    const recentSwings = swingPoints.slice(-this.params.minSwingPoints);

    // Extract x (index) and y (price) values
    const xValues = recentSwings.map(s => s.index);
    const yValues = recentSwings.map(s => s.price);

    // Calculate linear regression
    const regression = TechnicalAnalysis.linearRegression(xValues, yValues);

    // Calculate current trend line value
    const currentIndex = candles.length - 1;
    const currentValue = regression.slope * currentIndex + regression.intercept;

    // Validate trend line quality using R²
    const r2Threshold = 0.5; // Minimum correlation
    const isValid = regression.r2 >= r2Threshold;

    return {
      valid: isValid,
      slope: regression.slope,
      intercept: regression.intercept,
      currentValue: currentValue,
      r2: regression.r2,
      swingCount: recentSwings.length
    };
  }

  /**
   * Detect if price is near a trend line
   *
   * @param {number} price - Current price
   * @param {Object} trendLineData - Trend line data from detectTrendLines()
   * @param {number} proximityPoints - Distance threshold
   * @returns {Object} Proximity information
   */
  isNearTrendLine(price, trendLineData, proximityPoints = 3) {
    const results = {
      nearUpper: false,
      nearLower: false,
      distanceToUpper: trendLineData.distanceToUpper,
      distanceToLower: trendLineData.distanceToLower
    };

    if (trendLineData.upperTrendLine.valid) {
      results.nearUpper = Math.abs(trendLineData.distanceToUpper) <= proximityPoints;
    }

    if (trendLineData.lowerTrendLine.valid) {
      results.nearLower = Math.abs(trendLineData.distanceToLower) <= proximityPoints;
    }

    return results;
  }

  /**
   * Detect trend line breaks
   *
   * @param {Object} currentCandle - Current candle
   * @param {Object} trendLineData - Trend line data
   * @returns {Object} Break detection results
   */
  detectBreak(currentCandle, trendLineData) {
    const results = {
      upperBreak: false,
      lowerBreak: false,
      breakType: null
    };

    // Upper trend line break (price closes above resistance)
    if (trendLineData.upperTrendLine.valid) {
      if (currentCandle.close > trendLineData.upperTrendLine.currentValue) {
        results.upperBreak = true;
        results.breakType = 'bullish_breakout';
      }
    }

    // Lower trend line break (price closes below support)
    if (trendLineData.lowerTrendLine.valid) {
      if (currentCandle.close < trendLineData.lowerTrendLine.currentValue) {
        results.lowerBreak = true;
        results.breakType = 'bearish_breakdown';
      }
    }

    return results;
  }

  /**
   * Get empty result structure
   */
  getEmptyResult() {
    return {
      upperTrendLine: { valid: false, slope: null, intercept: null, currentValue: null, r2: null },
      lowerTrendLine: { valid: false, slope: null, intercept: null, currentValue: null, r2: null },
      distanceToUpper: null,
      distanceToLower: null,
      channelWidth: null,
      isValid: false
    };
  }
}
