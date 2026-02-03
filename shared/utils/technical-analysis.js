// Technical Analysis Utilities for indicators
// Provides common mathematical functions used in trading indicators

export class TechnicalAnalysis {

  /**
   * Simple Moving Average
   * @param {number[]} values - Array of values (typically prices)
   * @param {number} period - Number of periods for the average
   * @returns {number} The simple moving average
   */
  static sma(values, period) {
    if (!values || values.length < period || period <= 0) {
      return null;
    }

    const slice = values.slice(-period);
    const sum = slice.reduce((acc, val) => acc + val, 0);
    return sum / period;
  }

  /**
   * Standard Deviation
   * @param {number[]} values - Array of values
   * @param {number} period - Number of periods
   * @returns {number} The standard deviation
   */
  static stdev(values, period) {
    if (!values || values.length < period || period <= 0) {
      return null;
    }

    const slice = values.slice(-period);
    const mean = this.sma(slice, period);

    if (mean === null) return null;

    const squaredDiffs = slice.map(val => Math.pow(val - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((acc, val) => acc + val, 0) / period;

    return Math.sqrt(avgSquaredDiff);
  }

  /**
   * True Range calculation
   * @param {object} current - Current candle with {high, low, close}
   * @param {object} previous - Previous candle with {close}
   * @returns {number} True range value
   */
  static trueRange(current, previous = null) {
    if (!current || typeof current.high === 'undefined' || typeof current.low === 'undefined') {
      return null;
    }

    const hl = current.high - current.low;

    if (!previous || typeof previous.close === 'undefined') {
      return hl;
    }

    const hc = Math.abs(current.high - previous.close);
    const lc = Math.abs(current.low - previous.close);

    return Math.max(hl, hc, lc);
  }

  /**
   * Average True Range (ATR)
   * @param {object[]} candles - Array of candles with {high, low, close}
   * @param {number} period - ATR period (typically 14)
   * @returns {number[]} Array of ATR values (one per candle)
   */
  static atr(candles, period) {
    if (!candles || candles.length < period || period <= 0) {
      return [];
    }

    const atrValues = [];
    let atr = 0;

    // Calculate initial ATR as simple average of first 'period' true ranges
    for (let i = 1; i < period; i++) {
      const tr = this.trueRange(candles[i], candles[i - 1]);
      atr += tr;
    }
    atr = atr / (period - 1);
    atrValues.push(atr);

    // Calculate smoothed ATR for remaining candles
    for (let i = period; i < candles.length; i++) {
      const tr = this.trueRange(candles[i], candles[i - 1]);
      atr = ((atr * (period - 1)) + tr) / period;
      atrValues.push(atr);
    }

    return atrValues;
  }

  /**
   * Linear Regression for given period
   * @param {number[]} xValues - Array of x-values OR y-values (if yValues not provided)
   * @param {number[]|number} yValues - Array of y-values OR period (if using single param mode)
   * @param {number} offset - Offset from current position (0 = current value) - only for single param mode
   * @returns {number|object} Linear regression value (single param) or {slope, intercept, r2} (two param)
   */
  static linearRegression(xValues, yValues = null, offset = 0) {
    // Two-parameter mode: linearRegression(xValues, yValues) -> returns {slope, intercept, r2}
    if (Array.isArray(yValues)) {
      if (!xValues || !yValues || xValues.length !== yValues.length || xValues.length < 2) {
        return { slope: null, intercept: null, r2: null };
      }

      const n = xValues.length;

      // Calculate sums
      const sumX = xValues.reduce((acc, x) => acc + x, 0);
      const sumY = yValues.reduce((acc, y) => acc + y, 0);
      const sumXY = xValues.reduce((acc, x, i) => acc + x * yValues[i], 0);
      const sumXX = xValues.reduce((acc, x) => acc + x * x, 0);
      const sumYY = yValues.reduce((acc, y) => acc + y * y, 0);

      // Calculate slope and intercept
      const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;

      // Calculate R² (coefficient of determination)
      const meanY = sumY / n;
      const ssTotal = sumYY - n * meanY * meanY;
      const ssResidual = yValues.reduce((acc, y, i) => {
        const predicted = slope * xValues[i] + intercept;
        return acc + Math.pow(y - predicted, 2);
      }, 0);
      const r2 = 1 - (ssResidual / ssTotal);

      return { slope, intercept, r2 };
    }

    // Single-parameter mode (legacy): linearRegression(values, period, offset) -> returns value
    const values = xValues;
    const period = yValues; // This is actually the period in single-param mode

    if (!values || values.length < period || period <= 1) {
      return null;
    }

    const slice = values.slice(-period);
    const n = slice.length;

    // Generate x-values (0, 1, 2, ..., n-1)
    const xVals = Array.from({length: n}, (_, i) => i);

    // Calculate linear regression coefficients using least squares
    const sumX = xVals.reduce((acc, x) => acc + x, 0);
    const sumY = slice.reduce((acc, y) => acc + y, 0);
    const sumXY = xVals.reduce((acc, x, i) => acc + x * slice[i], 0);
    const sumXX = xVals.reduce((acc, x) => acc + x * x, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // Calculate value at position (n-1-offset)
    const x = n - 1 - offset;
    return slope * x + intercept;
  }

  /**
   * Highest value over a given period
   * @param {number[]} values - Array of values
   * @param {number} period - Number of periods to look back
   * @returns {number} Highest value in the period
   */
  static highest(values, period) {
    if (!values || values.length < period || period <= 0) {
      return null;
    }

    const slice = values.slice(-period);
    return Math.max(...slice);
  }

  /**
   * Lowest value over a given period
   * @param {number[]} values - Array of values
   * @param {number} period - Number of periods to look back
   * @returns {number} Lowest value in the period
   */
  static lowest(values, period) {
    if (!values || values.length < period || period <= 0) {
      return null;
    }

    const slice = values.slice(-period);
    return Math.min(...slice);
  }

  /**
   * Average of two values (utility function)
   * @param {number} a - First value
   * @param {number} b - Second value
   * @returns {number} Average of the two values
   */
  static avg(a, b) {
    return (a + b) / 2;
  }

  /**
   * Get candle values array from candle objects
   * @param {object[]} candles - Array of candle objects
   * @param {string} field - Field to extract ('open', 'high', 'low', 'close', 'volume')
   * @returns {number[]} Array of values
   */
  static getValues(candles, field) {
    if (!candles || !Array.isArray(candles)) {
      return [];
    }

    return candles.map(candle => candle[field]).filter(val => typeof val === 'number');
  }

  /**
   * Validate that we have enough data for calculations
   * @param {any[]} data - Data array to validate
   * @param {number} requiredLength - Minimum required length
   * @returns {boolean} True if data is valid
   */
  static validateData(data, requiredLength) {
    return data && Array.isArray(data) && data.length >= requiredLength;
  }
}

export default TechnicalAnalysis;