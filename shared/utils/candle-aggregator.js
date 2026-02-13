/**
 * Candle Aggregator
 *
 * Aggregates 1-minute candles into higher timeframes
 * Supports: 3m, 5m, 15m, 30m, 1h, 4h, 1d
 */

export class CandleAggregator {
  constructor() {
    // Timeframe mappings to minutes
    this.timeframes = {
      '1m': 1,
      '3m': 3,
      '5m': 5,
      '15m': 15,
      '30m': 30,
      '1h': 60,
      '4h': 240,
      '1d': 1440
    };

    // State for incremental aggregation (per timeframe)
    this.incrementalState = {};
  }

  /**
   * Initialize incremental aggregation state for a timeframe
   * @param {string} timeframe - Target timeframe
   * @param {string} stateKey - Optional key to allow multiple independent aggregations
   */
  initIncremental(timeframe, stateKey = 'default') {
    const key = `${stateKey}_${timeframe}`;
    this.incrementalState[key] = {
      timeframe,
      aggregatedCandles: [],
      currentPeriod: null,      // Current incomplete period being built
      currentPeriodStart: null, // Timestamp of current period start
      lastProcessedTimestamp: 0
    };
  }

  /**
   * Add a single candle incrementally to the aggregation
   * This is O(1) per candle instead of O(n)
   *
   * @param {Object} candle - New 1m candle to add
   * @param {string} timeframe - Target timeframe
   * @param {string} stateKey - Optional key for multiple independent aggregations
   * @returns {Object[]} Current aggregated candles array
   */
  addCandleIncremental(candle, timeframe, stateKey = 'default') {
    const key = `${stateKey}_${timeframe}`;

    // Auto-initialize if needed
    if (!this.incrementalState[key]) {
      this.initIncremental(timeframe, stateKey);
    }

    const state = this.incrementalState[key];

    // For 1m timeframe, just collect candles
    if (timeframe === '1m') {
      state.aggregatedCandles.push(candle);
      return state.aggregatedCandles;
    }

    const intervalMinutes = this.timeframes[timeframe];
    if (!intervalMinutes) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }

    const candleTime = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    const candlePeriodStart = this.getPeriodStart(candleTime, intervalMinutes);

    // First candle or new period?
    if (state.currentPeriodStart === null || candlePeriodStart !== state.currentPeriodStart) {
      // Finalize previous period if exists
      if (state.currentPeriod !== null) {
        state.aggregatedCandles.push(state.currentPeriod);
      }

      // Start new period
      state.currentPeriod = {
        timestamp: candlePeriodStart,
        symbol: candle.symbol,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
        candleCount: 1,
        periodStart: new Date(candlePeriodStart).toISOString()
      };
      state.currentPeriodStart = candlePeriodStart;
    } else {
      // Same period - update OHLCV
      state.currentPeriod.high = Math.max(state.currentPeriod.high, candle.high);
      state.currentPeriod.low = Math.min(state.currentPeriod.low, candle.low);
      state.currentPeriod.close = candle.close;
      state.currentPeriod.volume += candle.volume || 0;
      state.currentPeriod.candleCount++;
    }

    state.lastProcessedTimestamp = candleTime;

    // Return aggregated candles including the current incomplete period
    return [...state.aggregatedCandles, state.currentPeriod];
  }

  /**
   * Get current aggregated candles (including incomplete current period)
   * @param {string} timeframe - Target timeframe
   * @param {string} stateKey - Optional key
   * @returns {Object[]} Current aggregated candles
   */
  getIncrementalCandles(timeframe, stateKey = 'default') {
    const key = `${stateKey}_${timeframe}`;
    const state = this.incrementalState[key];

    if (!state) {
      return [];
    }

    if (state.currentPeriod) {
      return [...state.aggregatedCandles, state.currentPeriod];
    }
    return state.aggregatedCandles;
  }

  /**
   * Reset incremental aggregation state
   * @param {string} timeframe - Target timeframe
   * @param {string} stateKey - Optional key
   */
  resetIncremental(timeframe, stateKey = 'default') {
    const key = `${stateKey}_${timeframe}`;
    delete this.incrementalState[key];
  }

  /**
   * Aggregate 1-minute candles to specified timeframe
   *
   * @param {Object[]} candles - Array of 1-minute candles (sorted by timestamp)
   * @param {string} timeframe - Target timeframe (3m, 5m, 15m, 30m, 1h, 4h, 1d)
   * @param {Object} options - Optional settings
   * @param {boolean} options.silent - Suppress logging (default: false)
   * @returns {Object[]} Array of aggregated candles
   */
  aggregate(candles, timeframe, options = {}) {
    if (!candles || candles.length === 0) {
      return [];
    }

    if (timeframe === '1m') {
      return candles; // No aggregation needed
    }

    const intervalMinutes = this.timeframes[timeframe];
    if (!intervalMinutes) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }

    const aggregatedCandles = [];
    let currentGroup = [];
    let currentPeriodStart = this.getPeriodStart(candles[0].timestamp, intervalMinutes);

    for (const candle of candles) {
      const candlePeriodStart = this.getPeriodStart(candle.timestamp, intervalMinutes);

      // If we've moved to a new period, finalize the current group
      if (candlePeriodStart !== currentPeriodStart) {
        if (currentGroup.length > 0) {
          aggregatedCandles.push(this.aggregateGroup(currentGroup, currentPeriodStart));
        }

        // Start new group
        currentGroup = [candle];
        currentPeriodStart = candlePeriodStart;
      } else {
        // Add to current group
        currentGroup.push(candle);
      }
    }

    // Don't forget the last group
    if (currentGroup.length > 0) {
      aggregatedCandles.push(this.aggregateGroup(currentGroup, currentPeriodStart));
    }

    // Only log for batch operations (not incremental calls)
    if (!options.silent) {
      console.log(`📊 Aggregated ${candles.length} 1m candles to ${aggregatedCandles.length} ${timeframe} candles`);
    }
    return aggregatedCandles;
  }

  /**
   * Get the start timestamp of the period for a given timestamp
   *
   * @param {number} timestamp - Candle timestamp
   * @param {number} intervalMinutes - Interval in minutes
   * @returns {number} Period start timestamp
   */
  getPeriodStart(timestamp, intervalMinutes) {
    const date = new Date(timestamp);
    const minutes = date.getMinutes();
    const hours = date.getHours();

    // Calculate the period start based on interval
    let periodStartMinutes;

    if (intervalMinutes < 60) {
      // For sub-hourly intervals, align to interval boundaries within the hour
      periodStartMinutes = Math.floor(minutes / intervalMinutes) * intervalMinutes;
      date.setMinutes(periodStartMinutes, 0, 0);
    } else if (intervalMinutes === 60) {
      // For 1-hour intervals, align to hour start
      date.setMinutes(0, 0, 0);
    } else if (intervalMinutes === 240) {
      // For 4-hour intervals, align to 4-hour boundaries (0, 4, 8, 12, 16, 20)
      const periodStartHours = Math.floor(hours / 4) * 4;
      date.setHours(periodStartHours, 0, 0, 0);
    } else if (intervalMinutes === 1440) {
      // For daily intervals, align to day start
      date.setHours(0, 0, 0, 0);
    }

    return date.getTime();
  }

  /**
   * Aggregate a group of candles into a single candle
   *
   * @param {Object[]} candleGroup - Array of candles in the same period
   * @param {number} periodStart - Period start timestamp
   * @returns {Object} Aggregated candle
   */
  aggregateGroup(candleGroup, periodStart) {
    if (candleGroup.length === 0) {
      throw new Error('Cannot aggregate empty candle group');
    }

    if (candleGroup.length === 1) {
      // Single candle - just update timestamp to period start
      return {
        ...candleGroup[0],
        timestamp: periodStart
      };
    }

    // Sort candles by timestamp to ensure correct OHLC calculation
    const sortedCandles = candleGroup.sort((a, b) => a.timestamp - b.timestamp);

    const open = sortedCandles[0].open;
    const close = sortedCandles[sortedCandles.length - 1].close;
    const high = Math.max(...sortedCandles.map(c => c.high));
    const low = Math.min(...sortedCandles.map(c => c.low));
    const volume = sortedCandles.reduce((sum, c) => sum + c.volume, 0);

    // Use the symbol from the first candle (should be the same for all)
    const symbol = sortedCandles[0].symbol;

    return {
      timestamp: periodStart,
      symbol: symbol,
      open: open,
      high: high,
      low: low,
      close: close,
      volume: volume,
      // Add metadata about aggregation
      candleCount: candleGroup.length,
      periodStart: new Date(periodStart).toISOString(),
      originalTimespan: {
        start: sortedCandles[0].timestamp,
        end: sortedCandles[sortedCandles.length - 1].timestamp
      }
    };
  }

  /**
   * Validate timeframe format
   *
   * @param {string} timeframe - Timeframe to validate
   * @returns {boolean} True if valid
   */
  isValidTimeframe(timeframe) {
    return timeframe in this.timeframes;
  }

  /**
   * Get list of supported timeframes
   *
   * @returns {string[]} Array of supported timeframe strings
   */
  getSupportedTimeframes() {
    return Object.keys(this.timeframes);
  }

  /**
   * Get interval in minutes for a timeframe
   *
   * @param {string} timeframe - Timeframe string
   * @returns {number} Interval in minutes
   */
  getIntervalMinutes(timeframe) {
    return this.timeframes[timeframe];
  }

  /**
   * Calculate the number of expected periods in a date range
   *
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {string} timeframe - Timeframe
   * @returns {number} Expected number of periods
   */
  calculateExpectedPeriods(startDate, endDate, timeframe) {
    const intervalMinutes = this.timeframes[timeframe];
    if (!intervalMinutes) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }

    const totalMinutes = (endDate.getTime() - startDate.getTime()) / (1000 * 60);
    return Math.floor(totalMinutes / intervalMinutes);
  }

  /**
   * Find missing periods in aggregated data
   *
   * @param {Object[]} candles - Aggregated candles
   * @param {string} timeframe - Timeframe
   * @returns {number[]} Array of missing period timestamps
   */
  findMissingPeriods(candles, timeframe) {
    if (candles.length < 2) {
      return [];
    }

    const intervalMinutes = this.timeframes[timeframe];
    const intervalMs = intervalMinutes * 60 * 1000;
    const missingPeriods = [];

    for (let i = 1; i < candles.length; i++) {
      const expectedTimestamp = candles[i - 1].timestamp + intervalMs;

      if (candles[i].timestamp > expectedTimestamp) {
        // Found a gap - calculate all missing periods
        let missingTimestamp = expectedTimestamp;
        while (missingTimestamp < candles[i].timestamp) {
          missingPeriods.push(missingTimestamp);
          missingTimestamp += intervalMs;
        }
      }
    }

    return missingPeriods;
  }

  /**
   * Fill gaps in candle data with synthetic candles
   *
   * @param {Object[]} candles - Aggregated candles
   * @param {string} timeframe - Timeframe
   * @param {string} fillMethod - Fill method ('forward', 'interpolate', 'skip')
   * @returns {Object[]} Candles with gaps filled
   */
  fillGaps(candles, timeframe, fillMethod = 'forward') {
    if (candles.length < 2) {
      return candles;
    }

    const missingPeriods = this.findMissingPeriods(candles, timeframe);
    if (missingPeriods.length === 0) {
      return candles;
    }

    const filledCandles = [...candles];

    for (const missingTimestamp of missingPeriods) {
      let syntheticCandle;

      if (fillMethod === 'forward') {
        // Use previous candle's close as OHLC
        const prevCandle = this.findPreviousCandle(filledCandles, missingTimestamp);
        syntheticCandle = this.createSyntheticCandle(missingTimestamp, prevCandle.close, prevCandle.symbol);
      } else if (fillMethod === 'interpolate') {
        // Linear interpolation between surrounding candles
        const prevCandle = this.findPreviousCandle(filledCandles, missingTimestamp);
        const nextCandle = this.findNextCandle(filledCandles, missingTimestamp);
        const interpolatedPrice = this.interpolatePrice(prevCandle, nextCandle, missingTimestamp);
        syntheticCandle = this.createSyntheticCandle(missingTimestamp, interpolatedPrice, prevCandle.symbol);
      } else {
        // Skip - don't fill gaps
        continue;
      }

      filledCandles.push(syntheticCandle);
    }

    // Re-sort after adding synthetic candles
    filledCandles.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`📊 Filled ${missingPeriods.length} gaps using ${fillMethod} method`);
    return filledCandles;
  }

  /**
   * Find the previous candle before a given timestamp
   *
   * @param {Object[]} candles - Sorted candles array
   * @param {number} timestamp - Target timestamp
   * @returns {Object|null} Previous candle or null
   */
  findPreviousCandle(candles, timestamp) {
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].timestamp < timestamp) {
        return candles[i];
      }
    }
    return null;
  }

  /**
   * Find the next candle after a given timestamp
   *
   * @param {Object[]} candles - Sorted candles array
   * @param {number} timestamp - Target timestamp
   * @returns {Object|null} Next candle or null
   */
  findNextCandle(candles, timestamp) {
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].timestamp > timestamp) {
        return candles[i];
      }
    }
    return null;
  }

  /**
   * Interpolate price between two candles
   *
   * @param {Object} prevCandle - Previous candle
   * @param {Object} nextCandle - Next candle
   * @param {number} targetTimestamp - Target timestamp for interpolation
   * @returns {number} Interpolated price
   */
  interpolatePrice(prevCandle, nextCandle, targetTimestamp) {
    if (!prevCandle || !nextCandle) {
      return prevCandle ? prevCandle.close : nextCandle.close;
    }

    const timeDiff = nextCandle.timestamp - prevCandle.timestamp;
    const targetDiff = targetTimestamp - prevCandle.timestamp;
    const priceDiff = nextCandle.close - prevCandle.close;

    const ratio = targetDiff / timeDiff;
    return prevCandle.close + (priceDiff * ratio);
  }

  /**
   * Create a synthetic candle with OHLC all set to the same price
   *
   * @param {number} timestamp - Candle timestamp
   * @param {number} price - OHLC price
   * @param {string} symbol - Symbol
   * @returns {Object} Synthetic candle
   */
  createSyntheticCandle(timestamp, price, symbol) {
    return {
      timestamp: timestamp,
      symbol: symbol,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      synthetic: true // Mark as synthetic for identification
    };
  }
}