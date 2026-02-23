// Candle Buffer Management
// Manages rolling buffer of candles for technical indicator calculations

import { createLogger } from '../../../shared/index.js';
import { Candle } from '../models/candle.js';

const logger = createLogger('candle-buffer');

export class CandleBuffer {

  constructor(options = {}) {
    this.symbol = options.symbol || 'NQ';
    this.timeframe = options.timeframe || '15';
    this.maxSize = options.maxSize || 100; // Keep last 100 candles for indicators
    this.candles = [];
    this.lastCandleTime = null;

    // Track if we've received our first candle
    this.initialized = false;
  }

  /**
   * Add or update a candle in the buffer
   * @param {object} candleData - Raw candle data with OHLCV
   * @returns {boolean} True if this is a new closed candle
   */
  addCandle(candleData) {
    try {
      const candle = new Candle(candleData);

      // Validate candle data
      if (!this.isValidCandle(candle)) {
        logger.warn(`Invalid candle data received for ${this.symbol}:`, candleData);
        return false;
      }

      const candleTime = new Date(candle.timestamp).getTime();

      // Check if this is a new candle or update to existing
      if (this.candles.length > 0) {
        const lastCandle = this.candles[this.candles.length - 1];
        const lastCandleTime = new Date(lastCandle.timestamp).getTime();

        if (candleTime === lastCandleTime) {
          // Update existing candle (same timestamp)
          this.candles[this.candles.length - 1] = candle;
          logger.debug(`Updated existing candle for ${this.symbol} at ${candle.timestamp}`);
          return false; // Not a new closed candle
        } else if (candleTime > lastCandleTime) {
          // New candle - the previous one is now closed
          this.candles.push(candle);
          this.maintainBufferSize();

          const isNewClosedCandle = this.lastCandleTime !== null && lastCandleTime > this.lastCandleTime;
          this.lastCandleTime = lastCandleTime; // Update to the newly closed candle time

          if (!this.initialized) {
            this.initialized = true;
            logger.info(`Candle buffer initialized for ${this.symbol} with ${this.candles.length} candles`);
            return false; // Don't trigger on initialization
          }

          if (isNewClosedCandle) {
            logger.info(`New ${this.timeframe}-minute candle closed for ${this.symbol}: ${lastCandle.close} (${new Date(lastCandleTime).toISOString()})`);
            return true; // This is a new closed candle
          }
        } else {
          // Out-of-order candle — common after seedCandles() during low-volume
          // periods (e.g. Sunday) when TradingView resends the current forming bar
          logger.debug(`Skipping out-of-order candle for ${this.symbol}: ${candle.timestamp}`);
          return false;
        }
      } else {
        // First candle
        this.candles.push(candle);
        this.lastCandleTime = candleTime;
        this.initialized = true;
        logger.info(`First candle added to buffer for ${this.symbol}: ${candle.close}`);
        return false; // Don't trigger on first candle
      }

      return false;

    } catch (error) {
      logger.error(`Error adding candle to buffer for ${this.symbol}:`, error);
      return false;
    }
  }

  /**
   * Validate candle data
   * @param {Candle} candle - Candle object to validate
   * @returns {boolean} True if candle is valid
   */
  isValidCandle(candle) {
    return (
      candle &&
      typeof candle.open === 'number' &&
      typeof candle.high === 'number' &&
      typeof candle.low === 'number' &&
      typeof candle.close === 'number' &&
      candle.high >= candle.low &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close) &&
      candle.timestamp &&
      !isNaN(new Date(candle.timestamp).getTime())
    );
  }

  /**
   * Maintain buffer size by removing oldest candles
   */
  maintainBufferSize() {
    while (this.candles.length > this.maxSize) {
      const removed = this.candles.shift();
      logger.debug(`Removed oldest candle from buffer: ${removed.timestamp}`);
    }
  }

  /**
   * Get candles for indicator calculation
   * @param {number} count - Number of recent candles to return
   * @returns {Candle[]} Array of candle objects (deduplicated by timestamp)
   */
  getCandles(count = null) {
    // Deduplicate by timestamp (keep latest version of each timestamp)
    const uniqueMap = new Map();
    for (const candle of this.candles) {
      const ts = new Date(candle.timestamp).getTime();
      uniqueMap.set(ts, candle);
    }
    const unique = Array.from(uniqueMap.values());
    // Sort by timestamp to ensure proper order
    unique.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (count === null) {
      return unique;
    }

    if (count <= 0) {
      return [];
    }

    return unique.slice(-count);
  }

  /**
   * Get the most recent completed candle
   * @returns {Candle|null} Most recent completed candle
   */
  getLastClosedCandle() {
    // Return the second-to-last candle if we have at least 2 candles
    // (last candle might still be forming)
    if (this.candles.length >= 2) {
      return this.candles[this.candles.length - 2];
    }

    // If we only have one candle, return it
    if (this.candles.length === 1) {
      return this.candles[0];
    }

    return null;
  }

  /**
   * Get the current (potentially forming) candle
   * @returns {Candle|null} Current candle
   */
  getCurrentCandle() {
    if (this.candles.length === 0) {
      return null;
    }

    return this.candles[this.candles.length - 1];
  }

  /**
   * Check if we have enough data for calculations
   * @param {number} requiredCandles - Minimum number of candles needed
   * @returns {boolean} True if we have sufficient data
   */
  hasEnoughData(requiredCandles) {
    return this.candles.length >= requiredCandles;
  }

  /**
   * Get buffer statistics
   * @returns {object} Buffer statistics
   */
  getStats() {
    if (this.candles.length === 0) {
      return {
        symbol: this.symbol,
        timeframe: this.timeframe,
        count: 0,
        initialized: this.initialized,
        firstCandle: null,
        lastCandle: null,
        lastCandleTime: this.lastCandleTime
      };
    }

    const firstCandle = this.candles[0];
    const lastCandle = this.candles[this.candles.length - 1];

    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      count: this.candles.length,
      initialized: this.initialized,
      firstCandle: {
        timestamp: firstCandle.timestamp,
        close: firstCandle.close
      },
      lastCandle: {
        timestamp: lastCandle.timestamp,
        close: lastCandle.close
      },
      lastCandleTime: this.lastCandleTime,
      span: {
        start: firstCandle.timestamp,
        end: lastCandle.timestamp,
        durationHours: (new Date(lastCandle.timestamp) - new Date(firstCandle.timestamp)) / (1000 * 60 * 60)
      }
    };
  }

  /**
   * Bulk-load historical candles into the buffer.
   * Used to seed the buffer with TradingView history on startup.
   * Candles are sorted by timestamp and deduplicated.
   * @param {Array} candles - Array of candle data objects
   * @returns {number} Number of candles loaded
   */
  seedCandles(candles) {
    if (!candles || candles.length === 0) return 0;

    const validCandles = [];
    for (const candleData of candles) {
      const candle = new Candle(candleData);
      if (this.isValidCandle(candle)) {
        validCandles.push(candle);
      }
    }

    if (validCandles.length === 0) return 0;

    // Sort by timestamp
    validCandles.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Deduplicate by timestamp (keep latest)
    const uniqueMap = new Map();
    for (const candle of validCandles) {
      const ts = new Date(candle.timestamp).getTime();
      uniqueMap.set(ts, candle);
    }
    const deduped = Array.from(uniqueMap.values());
    deduped.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Replace buffer contents, respecting maxSize
    this.candles = deduped.slice(-this.maxSize);

    if (this.candles.length > 0) {
      const lastCandle = this.candles[this.candles.length - 1];
      this.lastCandleTime = new Date(lastCandle.timestamp).getTime();
      this.initialized = true;
    }

    logger.info(`Seeded ${this.candles.length} ${this.timeframe}m candles for ${this.symbol} (from ${deduped.length} unique)`);
    return this.candles.length;
  }

  /**
   * Clear the buffer
   */
  clear() {
    this.candles = [];
    this.lastCandleTime = null;
    this.initialized = false;
    logger.info(`Candle buffer cleared for ${this.symbol}`);
  }

  /**
   * Get buffer info for debugging
   * @returns {object} Debug information
   */
  getDebugInfo() {
    return {
      ...this.getStats(),
      maxSize: this.maxSize,
      recentCandles: this.candles.slice(-5).map(candle => ({
        timestamp: candle.timestamp,
        close: candle.close,
        volume: candle.volume
      }))
    };
  }
}

export default CandleBuffer;