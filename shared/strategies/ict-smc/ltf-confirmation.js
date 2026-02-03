/**
 * LTF Confirmation Module
 *
 * Provides confirmation logic for Order Block entries using 1-minute candles.
 * Instead of entering immediately when price touches an OB, this module watches
 * for confirmation patterns before triggering entry:
 *
 * 1. SWEEP + RECLAIM: Price sweeps below OB (for bullish) then closes back inside
 * 2. BULLISH PATTERN: Hammer, engulfing, or pin bar within the OB zone
 *
 * This approach reduces getting swept out by a few points before major reversals.
 */

export class LTFConfirmation {
  constructor(options = {}) {
    this.options = {
      timeoutCandles: options.timeoutCandles || 15,           // Max 1m candles to wait
      minWickToBodyRatio: options.minWickToBodyRatio || 2.0,  // For hammer detection
      stopBuffer: options.stopBuffer || 3,                     // Points below confirmation structure
      minBodySize: options.minBodySize || 1,                   // Min body size to avoid doji
      ...options
    };

    // Watching state
    this.watchedOB = null;
    this.watchedSide = null;         // 'buy' or 'sell'
    this.watchStartIndex = 0;
    this.prevCandle = null;          // For engulfing detection
  }

  /**
   * Start watching an OB for confirmation
   * @param {Object} orderBlock - The order block to watch
   * @param {string} side - 'buy' or 'sell'
   * @param {number} candleIndex - Current candle index
   */
  startWatching(orderBlock, side, candleIndex) {
    this.watchedOB = orderBlock;
    this.watchedSide = side;
    this.watchStartIndex = candleIndex;
    this.prevCandle = null;
  }

  /**
   * Check if currently watching an OB
   * @returns {boolean}
   */
  isWatching() {
    return this.watchedOB !== null;
  }

  /**
   * Get the currently watched OB
   * @returns {Object|null}
   */
  getWatchedOB() {
    return this.watchedOB;
  }

  /**
   * Reset watching state
   */
  reset() {
    this.watchedOB = null;
    this.watchedSide = null;
    this.watchStartIndex = 0;
    this.prevCandle = null;
  }

  /**
   * Check for confirmation on each 1m candle
   * @param {Object} candle - Current 1m candle
   * @param {number} candleIndex - Current candle index
   * @returns {Object} Confirmation result with status
   */
  checkConfirmation(candle, candleIndex) {
    if (!this.watchedOB) {
      return { status: 'not_watching' };
    }

    const candleCount = candleIndex - this.watchStartIndex;

    // Timeout check
    if (candleCount >= this.options.timeoutCandles) {
      const timedOutOB = this.watchedOB;
      this.reset();
      return {
        status: 'timeout',
        orderBlock: timedOutOB,
        candlesWatched: candleCount
      };
    }

    // Check for sweep + reclaim (high confidence)
    const sweep = this.detectSweep(candle, this.watchedOB);
    if (sweep) {
      const result = { ...sweep, orderBlock: this.watchedOB, side: this.watchedSide };
      this.reset();
      return result;
    }

    // Check for reversal pattern (moderate confidence)
    const pattern = this.detectReversalPattern(candle, this.watchedOB, this.prevCandle);
    if (pattern) {
      const result = { ...pattern, orderBlock: this.watchedOB, side: this.watchedSide };
      this.reset();
      return result;
    }

    // Store candle for next iteration (engulfing detection)
    this.prevCandle = candle;

    return {
      status: 'watching',
      orderBlock: this.watchedOB,
      candlesWatched: candleCount
    };
  }

  /**
   * Detect sweep + reclaim pattern
   * @param {Object} candle - Current candle
   * @param {Object} orderBlock - Order block being watched
   * @returns {Object|null} Confirmation result or null
   */
  detectSweep(candle, orderBlock) {
    if (orderBlock.type === 'bullish') {
      // Bullish OB sweep: wick below OB low, close back inside OB
      const sweptBelow = candle.low < orderBlock.low;
      const reclaimedInside = candle.close > orderBlock.low && candle.close <= orderBlock.high;

      if (sweptBelow && reclaimedInside) {
        return {
          status: 'confirmed',
          confirmationType: 'sweep_reclaim',
          confidence: 'high',
          entryPrice: candle.close,
          stopPrice: candle.low - this.options.stopBuffer,
          confirmationCandle: { ...candle }
        };
      }
    } else {
      // Bearish OB sweep: wick above OB high, close back inside OB
      const sweptAbove = candle.high > orderBlock.high;
      const reclaimedInside = candle.close < orderBlock.high && candle.close >= orderBlock.low;

      if (sweptAbove && reclaimedInside) {
        return {
          status: 'confirmed',
          confirmationType: 'sweep_reclaim',
          confidence: 'high',
          entryPrice: candle.close,
          stopPrice: candle.high + this.options.stopBuffer,
          confirmationCandle: { ...candle }
        };
      }
    }

    return null;
  }

  /**
   * Detect reversal patterns (hammer, engulfing)
   * @param {Object} candle - Current candle
   * @param {Object} orderBlock - Order block being watched
   * @param {Object|null} prevCandle - Previous candle for engulfing detection
   * @returns {Object|null} Confirmation result or null
   */
  detectReversalPattern(candle, orderBlock, prevCandle) {
    if (orderBlock.type === 'bullish') {
      return this.detectBullishPattern(candle, orderBlock, prevCandle);
    } else {
      return this.detectBearishPattern(candle, orderBlock, prevCandle);
    }
  }

  /**
   * Detect bullish reversal patterns (hammer, bullish engulfing)
   * @param {Object} candle - Current candle
   * @param {Object} orderBlock - Order block
   * @param {Object|null} prevCandle - Previous candle
   * @returns {Object|null}
   */
  detectBullishPattern(candle, orderBlock, prevCandle) {
    // Must be within or touching OB zone
    if (candle.low > orderBlock.high) return null;

    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);

    // Skip doji candles (no clear direction)
    if (body < this.options.minBodySize) return null;

    // Must be a bullish candle for bullish patterns
    const isBullishCandle = candle.close > candle.open;

    // Hammer: long lower wick, small upper wick, bullish close
    if (isBullishCandle &&
        lowerWick >= body * this.options.minWickToBodyRatio &&
        upperWick < body) {
      return {
        status: 'confirmed',
        confirmationType: 'hammer',
        confidence: 'moderate',
        entryPrice: candle.close,
        stopPrice: candle.low - this.options.stopBuffer,
        confirmationCandle: { ...candle }
      };
    }

    // Bullish Engulfing: current bullish candle engulfs previous bearish candle
    if (prevCandle && isBullishCandle) {
      const prevIsBearish = prevCandle.close < prevCandle.open;
      const engulfs = candle.open <= prevCandle.close && candle.close >= prevCandle.open;

      if (prevIsBearish && engulfs) {
        return {
          status: 'confirmed',
          confirmationType: 'engulfing',
          confidence: 'moderate',
          entryPrice: candle.close,
          stopPrice: Math.min(candle.low, prevCandle.low) - this.options.stopBuffer,
          confirmationCandle: { ...candle }
        };
      }
    }

    return null;
  }

  /**
   * Detect bearish reversal patterns (shooting star, bearish engulfing)
   * @param {Object} candle - Current candle
   * @param {Object} orderBlock - Order block
   * @param {Object|null} prevCandle - Previous candle
   * @returns {Object|null}
   */
  detectBearishPattern(candle, orderBlock, prevCandle) {
    // Must be within or touching OB zone
    if (candle.high < orderBlock.low) return null;

    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);

    // Skip doji candles (no clear direction)
    if (body < this.options.minBodySize) return null;

    // Must be a bearish candle for bearish patterns
    const isBearishCandle = candle.close < candle.open;

    // Shooting Star: long upper wick, small lower wick, bearish close
    if (isBearishCandle &&
        upperWick >= body * this.options.minWickToBodyRatio &&
        lowerWick < body) {
      return {
        status: 'confirmed',
        confirmationType: 'shooting_star',
        confidence: 'moderate',
        entryPrice: candle.close,
        stopPrice: candle.high + this.options.stopBuffer,
        confirmationCandle: { ...candle }
      };
    }

    // Bearish Engulfing: current bearish candle engulfs previous bullish candle
    if (prevCandle && isBearishCandle) {
      const prevIsBullish = prevCandle.close > prevCandle.open;
      const engulfs = candle.open >= prevCandle.close && candle.close <= prevCandle.open;

      if (prevIsBullish && engulfs) {
        return {
          status: 'confirmed',
          confirmationType: 'engulfing',
          confidence: 'moderate',
          entryPrice: candle.close,
          stopPrice: Math.max(candle.high, prevCandle.high) + this.options.stopBuffer,
          confirmationCandle: { ...candle }
        };
      }
    }

    return null;
  }
}

export default LTFConfirmation;
