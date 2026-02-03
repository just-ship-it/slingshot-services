/**
 * Fair Value Gap (FVG) Detection Module
 *
 * Detects market imbalances (Fair Value Gaps) in OHLC candlestick data.
 * Used to find high-probability entry points near liquidity levels.
 */

import { roundTo } from './strategy-utils.js';

export class ImbalanceDetector {
  constructor(params = {}) {
    this.params = {
      minGapSize: 5.0,          // Minimum gap size in points
      maxGapAge: 48,            // Hours before gap expires
      fillThreshold: 0.8,       // Consider gap filled if 80% retraced
      ...params
    };
  }

  /**
   * Detect Fair Value Gaps in OHLC candlestick data
   *
   * @param {Array} candles - Array of OHLC candle objects with timestamp, open, high, low, close
   * @param {number} lookback - Number of candles to scan (default: 100)
   * @param {number} currentTime - Current timestamp for age filtering
   * @returns {Array} Array of Fair Value Gap objects
   */
  detectFairValueGaps(candles, lookback = 100, currentTime = null) {
    if (candles.length < 3) {
      return [];
    }

    const gaps = [];
    const startIndex = Math.max(0, candles.length - lookback - 2);
    const endIndex = candles.length - 2; // Leave room for next candle

    for (let i = startIndex; i < endIndex; i++) {
      if (i < 1) continue; // Need previous candle

      const prevCandle = candles[i - 1];
      const currentCandle = candles[i];
      const nextCandle = candles[i + 1];

      // Detect Bullish Fair Value Gap
      // Condition: previous.high < next.low AND current candle is bullish
      if (currentCandle.close > currentCandle.open &&
          prevCandle.high < nextCandle.low) {

        const gapSize = nextCandle.low - prevCandle.high;

        if (gapSize >= this.params.minGapSize) {
          const gap = {
            type: 'bullish_fvg',
            top: roundTo(nextCandle.low, 0.25),
            bottom: roundTo(prevCandle.high, 0.25),
            size: roundTo(gapSize, 0.25),
            timestamp: currentCandle.timestamp,
            candle_index: i,
            age_hours: currentTime ? (currentTime - currentCandle.timestamp) / (1000 * 60 * 60) : 0,
            filled: false,
            fill_percentage: 0
          };

          gaps.push(gap);
        }
      }

      // Detect Bearish Fair Value Gap
      // Condition: previous.low > next.high AND current candle is bearish
      if (currentCandle.close < currentCandle.open &&
          prevCandle.low > nextCandle.high) {

        const gapSize = prevCandle.low - nextCandle.high;

        if (gapSize >= this.params.minGapSize) {
          const gap = {
            type: 'bearish_fvg',
            top: roundTo(prevCandle.low, 0.25),
            bottom: roundTo(nextCandle.high, 0.25),
            size: roundTo(gapSize, 0.25),
            timestamp: currentCandle.timestamp,
            candle_index: i,
            age_hours: currentTime ? (currentTime - currentCandle.timestamp) / (1000 * 60 * 60) : 0,
            filled: false,
            fill_percentage: 0
          };

          gaps.push(gap);
        }
      }
    }

    // Filter gaps by age and update fill status
    if (currentTime) {
      return gaps.filter(gap => {
        gap.age_hours = (currentTime - gap.timestamp) / (1000 * 60 * 60);
        return gap.age_hours <= this.params.maxGapAge;
      });
    }

    return gaps;
  }

  /**
   * Update fill status of existing gaps based on recent price action
   *
   * @param {Array} gaps - Array of FVG objects to update
   * @param {Array} recentCandles - Recent candle data to check fills
   * @returns {Array} Updated gaps array
   */
  updateFillStatus(gaps, recentCandles) {
    return gaps.map(gap => {
      let fillPercentage = 0;

      // Check if price has moved into the gap
      for (const candle of recentCandles) {
        if (candle.timestamp <= gap.timestamp) continue; // Skip candles before gap formation

        if (gap.type === 'bullish_fvg') {
          // For bullish gaps, check how much has been filled from top
          if (candle.low <= gap.top) {
            const fillDepth = Math.max(0, gap.top - Math.max(candle.low, gap.bottom));
            fillPercentage = Math.max(fillPercentage, fillDepth / gap.size);
          }
        } else if (gap.type === 'bearish_fvg') {
          // For bearish gaps, check how much has been filled from bottom
          if (candle.high >= gap.bottom) {
            const fillDepth = Math.max(0, Math.min(candle.high, gap.top) - gap.bottom);
            fillPercentage = Math.max(fillPercentage, fillDepth / gap.size);
          }
        }
      }

      return {
        ...gap,
        fill_percentage: roundTo(Math.min(fillPercentage, 1.0), 0.01),
        filled: fillPercentage >= this.params.fillThreshold
      };
    });
  }

  /**
   * Find active (unfilled) Fair Value Gaps relevant for current market position
   *
   * @param {Array} gaps - Array of all detected gaps
   * @param {number} currentPrice - Current market price
   * @param {boolean} isLong - True for long position, false for short
   * @returns {Array} Filtered array of relevant active gaps
   */
  findRelevantGaps(gaps, currentPrice, isLong) {
    return gaps.filter(gap => {
      // Skip filled gaps
      if (gap.filled || gap.fill_percentage > this.params.fillThreshold) {
        return false;
      }

      // For long positions, look for bearish gaps below current price
      if (isLong) {
        return gap.type === 'bearish_fvg' && gap.top < currentPrice;
      }

      // For short positions, look for bullish gaps above current price
      return gap.type === 'bullish_fvg' && gap.bottom > currentPrice;
    });
  }

  /**
   * Calculate distance from price level to Fair Value Gap
   *
   * @param {number} price - Price level to measure from
   * @param {Object} gap - FVG object
   * @returns {Object} Distance information
   */
  calculateGapDistance(price, gap) {
    let distanceToNearEdge, distanceToFarEdge, distanceToCenter;

    if (gap.type === 'bullish_fvg') {
      distanceToNearEdge = Math.abs(price - gap.bottom);
      distanceToFarEdge = Math.abs(price - gap.top);
      distanceToCenter = Math.abs(price - (gap.top + gap.bottom) / 2);
    } else {
      distanceToNearEdge = Math.abs(price - gap.top);
      distanceToFarEdge = Math.abs(price - gap.bottom);
      distanceToCenter = Math.abs(price - (gap.top + gap.bottom) / 2);
    }

    return {
      toNearEdge: roundTo(distanceToNearEdge, 0.25),
      toFarEdge: roundTo(distanceToFarEdge, 0.25),
      toCenter: roundTo(distanceToCenter, 0.25)
    };
  }

  /**
   * Get summary statistics of detected gaps
   *
   * @param {Array} gaps - Array of FVG objects
   * @returns {Object} Summary statistics
   */
  getGapStatistics(gaps) {
    if (gaps.length === 0) {
      return {
        total: 0,
        bullish: 0,
        bearish: 0,
        active: 0,
        filled: 0,
        avgSize: 0
      };
    }

    const bullishCount = gaps.filter(g => g.type === 'bullish_fvg').length;
    const bearishCount = gaps.filter(g => g.type === 'bearish_fvg').length;
    const activeCount = gaps.filter(g => !g.filled).length;
    const filledCount = gaps.filter(g => g.filled).length;
    const avgSize = gaps.reduce((sum, g) => sum + g.size, 0) / gaps.length;

    return {
      total: gaps.length,
      bullish: bullishCount,
      bearish: bearishCount,
      active: activeCount,
      filled: filledCount,
      avgSize: roundTo(avgSize, 0.25)
    };
  }
}

export default ImbalanceDetector;