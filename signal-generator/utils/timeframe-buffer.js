// Timeframe Buffer - Manages candle history for multiple symbols and timeframes

export class TimeframeBuffer {
  constructor(maxCandles = 200) {
    this.maxCandles = maxCandles;
    // Map structure: "NQ_5m" -> [candle1, candle2, ...]
    this.buffers = new Map();
    this.stats = {
      totalCandles: 0,
      buffersCreated: 0,
      candlesDropped: 0
    };
  }

  /**
   * Add a completed candle to the appropriate buffer
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe (1m, 5m, etc.)
   * @param {Object} candle - Completed candle data
   */
  addCandle(symbol, timeframe, candle) {
    const key = `${symbol}_${timeframe}`;

    if (!this.buffers.has(key)) {
      this.buffers.set(key, []);
      this.stats.buffersCreated++;
    }

    const buffer = this.buffers.get(key);
    buffer.push(candle);
    this.stats.totalCandles++;

    // Maintain maximum buffer size
    if (buffer.length > this.maxCandles) {
      buffer.shift(); // Remove oldest candle
      this.stats.candlesDropped++;
    }
  }

  /**
   * Get candle history for a specific symbol and timeframe
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe
   * @param {number} count - Number of candles to retrieve (from most recent)
   * @returns {Array} - Array of candles (oldest to newest)
   */
  getHistory(symbol, timeframe, count = null) {
    const key = `${symbol}_${timeframe}`;
    const buffer = this.buffers.get(key) || [];

    if (count === null) {
      return [...buffer]; // Return all candles
    }

    return buffer.slice(-count);
  }

  /**
   * Get the most recent candle for a symbol/timeframe
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe
   * @returns {Object|null} - Most recent candle or null
   */
  getLatestCandle(symbol, timeframe) {
    const key = `${symbol}_${timeframe}`;
    const buffer = this.buffers.get(key);

    if (!buffer || buffer.length === 0) {
      return null;
    }

    return buffer[buffer.length - 1];
  }

  /**
   * Check if enough history exists for analysis
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe
   * @param {number} required - Number of candles required
   * @returns {boolean}
   */
  hasEnoughHistory(symbol, timeframe, required) {
    const key = `${symbol}_${timeframe}`;
    const buffer = this.buffers.get(key) || [];
    return buffer.length >= required;
  }

  /**
   * Clear history for a specific symbol/timeframe
   * @param {string} symbol - Trading symbol (optional)
   * @param {string} timeframe - Timeframe (optional)
   */
  clearHistory(symbol = null, timeframe = null) {
    if (!symbol && !timeframe) {
      // Clear all buffers
      this.buffers.clear();
      this.stats.buffersCreated = 0;
      this.stats.totalCandles = 0;
      this.stats.candlesDropped = 0;
    } else if (symbol && timeframe) {
      // Clear specific buffer
      const key = `${symbol}_${timeframe}`;
      this.buffers.delete(key);
    } else if (symbol) {
      // Clear all timeframes for a symbol
      for (const key of this.buffers.keys()) {
        if (key.startsWith(`${symbol}_`)) {
          this.buffers.delete(key);
        }
      }
    }
  }

  /**
   * Get buffer statistics for monitoring
   * @returns {Object}
   */
  getStats() {
    const bufferStats = {};
    for (const [key, buffer] of this.buffers.entries()) {
      bufferStats[key] = {
        candleCount: buffer.length,
        oldestCandle: buffer[0]?.timestamp,
        newestCandle: buffer[buffer.length - 1]?.timestamp
      };
    }

    return {
      ...this.stats,
      activeBuffers: this.buffers.size,
      maxCandlesPerBuffer: this.maxCandles,
      buffers: bufferStats
    };
  }

  /**
   * Calculate simple moving average from buffer
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe
   * @param {number} period - SMA period
   * @param {string} field - Price field to use (close, high, low, open)
   * @returns {number|null} - SMA value or null if insufficient data
   */
  calculateSMA(symbol, timeframe, period, field = 'close') {
    const history = this.getHistory(symbol, timeframe, period);

    if (history.length < period) {
      return null;
    }

    const sum = history.reduce((acc, candle) => acc + candle[field], 0);
    return sum / period;
  }

  /**
   * Get all symbols being tracked
   * @returns {Set} - Set of unique symbols
   */
  getTrackedSymbols() {
    const symbols = new Set();
    for (const key of this.buffers.keys()) {
      const [symbol] = key.split('_');
      symbols.add(symbol);
    }
    return symbols;
  }

  /**
   * Get all timeframes for a symbol
   * @param {string} symbol - Trading symbol
   * @returns {Array} - Array of timeframes
   */
  getSymbolTimeframes(symbol) {
    const timeframes = [];
    for (const key of this.buffers.keys()) {
      if (key.startsWith(`${symbol}_`)) {
        const [, timeframe] = key.split('_');
        timeframes.push(timeframe);
      }
    }
    return timeframes;
  }
}

export default TimeframeBuffer;