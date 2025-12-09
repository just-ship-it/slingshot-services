// Candle Aggregator - Converts 1-second OHLC data into higher timeframes

// Supported timeframes (in seconds)
export const TIMEFRAMES = {
  '1s': 1,
  '5s': 5,
  '15s': 15,
  '30s': 30,
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600
};

export class CandleAggregator {
  constructor() {
    // Track active (incomplete) candles for each symbol/timeframe
    // Key format: "NQ_5m"
    this.activeCandles = new Map();
  }

  /**
   * Process incoming 1-second tick and aggregate into higher timeframes
   * @param {string} symbol - Trading symbol
   * @param {Object} tickData - 1-second OHLC data
   * @param {string} timestamp - ISO timestamp
   * @returns {Array} - Array of completed candles for different timeframes
   */
  processTick(symbol, tickData, timestamp) {
    const completedCandles = [];
    const tickTime = new Date(timestamp).getTime();

    // Process each configured timeframe
    for (const [timeframeName, seconds] of Object.entries(TIMEFRAMES)) {
      if (seconds === 1) {
        // 1-second data passes through directly
        completedCandles.push({
          timeframe: '1s',
          symbol: tickData.symbol,
          baseSymbol: tickData.baseSymbol || symbol,
          open: tickData.open,
          high: tickData.high,
          low: tickData.low,
          close: tickData.close,
          volume: tickData.volume || 0,
          timestamp: timestamp,
          candleStartTime: timestamp,
          candleEndTime: timestamp
        });
      } else {
        // Aggregate into higher timeframe
        const candle = this.updateOrCreateCandle(
          symbol,
          timeframeName,
          seconds,
          tickData,
          tickTime,
          timestamp
        );

        if (candle && candle.completed) {
          completedCandles.push(candle);
        }
      }
    }

    return completedCandles;
  }

  /**
   * Update existing candle or create new one if period has rolled over
   * @private
   */
  updateOrCreateCandle(symbol, timeframeName, seconds, tickData, tickTime, timestamp) {
    const key = `${symbol}_${timeframeName}`;
    const periodMs = seconds * 1000;
    const candleStartTime = Math.floor(tickTime / periodMs) * periodMs;
    const candleEndTime = candleStartTime + periodMs;

    let activeCandle = this.activeCandles.get(key);

    // Check if we need to close the current candle and start a new one
    if (activeCandle && activeCandle.candleStartTime < candleStartTime) {
      // Current tick belongs to a new period, close the old candle
      const completedCandle = {
        ...activeCandle,
        completed: true,
        candleEndTime: new Date(activeCandle.candleEndTime).toISOString()
      };

      // Start new candle for current period
      this.activeCandles.set(key, {
        timeframe: timeframeName,
        symbol: tickData.symbol,
        baseSymbol: tickData.baseSymbol || symbol,
        open: tickData.open,
        high: tickData.high,
        low: tickData.low,
        close: tickData.close,
        volume: tickData.volume || 0,
        timestamp: timestamp,
        candleStartTime: candleStartTime,
        candleEndTime: candleEndTime,
        tickCount: 1
      });

      return completedCandle;
    }

    if (!activeCandle || activeCandle.candleStartTime !== candleStartTime) {
      // No active candle or it's for a different period, create new one
      this.activeCandles.set(key, {
        timeframe: timeframeName,
        symbol: tickData.symbol,
        baseSymbol: tickData.baseSymbol || symbol,
        open: tickData.open,
        high: tickData.high,
        low: tickData.low,
        close: tickData.close,
        volume: tickData.volume || 0,
        timestamp: timestamp,
        candleStartTime: candleStartTime,
        candleEndTime: candleEndTime,
        tickCount: 1
      });
      return null;
    }

    // Update existing candle
    activeCandle.high = Math.max(activeCandle.high, tickData.high);
    activeCandle.low = Math.min(activeCandle.low, tickData.low);
    activeCandle.close = tickData.close;
    activeCandle.volume = (activeCandle.volume || 0) + (tickData.volume || 0);
    activeCandle.timestamp = timestamp; // Update to latest tick time
    activeCandle.tickCount++;

    return null;
  }

  /**
   * Force close all active candles (useful for graceful shutdown)
   * @returns {Array} - Array of all active candles
   */
  closeAllCandles() {
    const closedCandles = [];

    for (const [key, candle] of this.activeCandles.entries()) {
      closedCandles.push({
        ...candle,
        completed: true,
        forceClosed: true,
        candleEndTime: new Date(candle.candleEndTime).toISOString()
      });
    }

    this.activeCandles.clear();
    return closedCandles;
  }

  /**
   * Get current state of active candles (for monitoring)
   * @returns {Object}
   */
  getActiveCandles() {
    const state = {};
    for (const [key, candle] of this.activeCandles.entries()) {
      state[key] = {
        ...candle,
        candleStartTime: new Date(candle.candleStartTime).toISOString(),
        candleEndTime: new Date(candle.candleEndTime).toISOString()
      };
    }
    return state;
  }

  /**
   * Reset aggregator state
   */
  reset() {
    this.activeCandles.clear();
  }
}

export default CandleAggregator;