// Squeeze Momentum Indicator
// Based on LazyBear's PineScript implementation
// Combines Bollinger Bands and Keltner Channels to detect volatility squeeze conditions

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

export class SqueezeMomentumIndicator {

  constructor(params = {}) {
    // Default parameters matching the PineScript version
    this.params = {
      bbLength: params.bbLength || 20,        // Bollinger Bands length
      bbMultFactor: params.bbMultFactor || 2.0,  // Bollinger Bands multiplier
      kcLength: params.kcLength || 20,        // Keltner Channels length
      kcMultFactor: params.kcMultFactor || 1.5,  // Keltner Channels multiplier
      useTrueRange: params.useTrueRange !== false, // Use True Range for KC (default true)
      ...params
    };
  }

  /**
   * Calculate Bollinger Bands
   * @param {object[]} candles - Array of candle objects with OHLC data
   * @returns {object} {upperBB, lowerBB, basis}
   */
  calculateBollingerBands(candles) {
    if (!TechnicalAnalysis.validateData(candles, this.params.bbLength)) {
      return null;
    }

    const closes = TechnicalAnalysis.getValues(candles, 'close');
    const basis = TechnicalAnalysis.sma(closes, this.params.bbLength);
    const stdev = TechnicalAnalysis.stdev(closes, this.params.bbLength);

    if (basis === null || stdev === null) {
      return null;
    }

    const dev = this.params.bbMultFactor * stdev;

    return {
      upperBB: basis + dev,
      lowerBB: basis - dev,
      basis: basis,
      stdev: stdev
    };
  }

  /**
   * Calculate Keltner Channels
   * @param {object[]} candles - Array of candle objects with OHLC data
   * @returns {object} {upperKC, lowerKC, ma}
   */
  calculateKeltnerChannels(candles) {
    if (!TechnicalAnalysis.validateData(candles, this.params.kcLength)) {
      return null;
    }

    const closes = TechnicalAnalysis.getValues(candles, 'close');
    const ma = TechnicalAnalysis.sma(closes, this.params.kcLength);

    if (ma === null) {
      return null;
    }

    let ranges;

    if (this.params.useTrueRange) {
      // Calculate True Range values
      ranges = [];
      for (let i = 1; i < candles.length; i++) {
        const tr = TechnicalAnalysis.trueRange(candles[i], candles[i-1]);
        if (tr !== null) {
          ranges.push(tr);
        }
      }
    } else {
      // Use simple high - low range
      ranges = candles.map(candle => candle.high - candle.low);
    }

    if (!TechnicalAnalysis.validateData(ranges, this.params.kcLength)) {
      return null;
    }

    const rangema = TechnicalAnalysis.sma(ranges, this.params.kcLength);

    if (rangema === null) {
      return null;
    }

    const offset = rangema * this.params.kcMultFactor;

    return {
      upperKC: ma + offset,
      lowerKC: ma - offset,
      ma: ma,
      rangema: rangema
    };
  }

  /**
   * Determine squeeze state
   * @param {object} bb - Bollinger Bands result
   * @param {object} kc - Keltner Channels result
   * @returns {object} {sqzOn, sqzOff, noSqz, state}
   */
  calculateSqueezeState(bb, kc) {
    if (!bb || !kc) {
      return null;
    }

    // Squeeze conditions from PineScript:
    // sqzOn  = (lowerBB > lowerKC) and (upperBB < upperKC)
    // sqzOff = (lowerBB < lowerKC) and (upperBB > upperKC)
    // noSqz  = (sqzOn == false) and (sqzOff == false)

    const sqzOn = (bb.lowerBB > kc.lowerKC) && (bb.upperBB < kc.upperKC);
    const sqzOff = (bb.lowerBB < kc.lowerKC) && (bb.upperBB > kc.upperKC);
    const noSqz = !sqzOn && !sqzOff;

    let state = 'none';
    if (sqzOn) state = 'squeeze_on';
    else if (sqzOff) state = 'squeeze_off';
    else if (noSqz) state = 'no_squeeze';

    return {
      sqzOn,
      sqzOff,
      noSqz,
      state
    };
  }

  /**
   * Calculate momentum value using linear regression - matches PineScript exactly
   * @param {object[]} candles - Array of candle objects
   * @param {number} previousMomentum - Previous momentum value (for color determination)
   * @returns {object} Momentum object with value, direction, and color
   */
  calculateMomentum(candles, previousMomentum = null) {
    // Need at least kcLength candles to calculate properly
    if (!TechnicalAnalysis.validateData(candles, this.params.kcLength)) {
      return null;
    }

    // PineScript implementation:
    // val = linreg(source - avg(avg(highest(high, lengthKC), lowest(low, lengthKC)), sma(close, lengthKC)), lengthKC, 0)
    // where source = close

    // Build source array for linear regression - exactly like PineScript
    const sourceValues = [];

    // We need enough data to calculate indicators over kcLength periods
    if (candles.length < this.params.kcLength) {
      return null;
    }

    // For each of the last kcLength periods, calculate the source value
    for (let i = this.params.kcLength - 1; i < candles.length; i++) {
      // Get the slice of data ending at position i for lookback calculations
      const slice = candles.slice(i + 1 - this.params.kcLength, i + 1);

      const closes = TechnicalAnalysis.getValues(slice, 'close');
      const highs = TechnicalAnalysis.getValues(slice, 'high');
      const lows = TechnicalAnalysis.getValues(slice, 'low');

      // Calculate: highest(high, lengthKC)
      const highestHigh = TechnicalAnalysis.highest(highs, this.params.kcLength);
      // Calculate: lowest(low, lengthKC)
      const lowestLow = TechnicalAnalysis.lowest(lows, this.params.kcLength);
      // Calculate: sma(close, lengthKC)
      const smaClose = TechnicalAnalysis.sma(closes, this.params.kcLength);

      if (highestHigh !== null && lowestLow !== null && smaClose !== null) {
        // source = close - avg(avg(highest(high, lengthKC), lowest(low, lengthKC)), sma(close, lengthKC))
        const currentClose = candles[i].close;
        const avg1 = TechnicalAnalysis.avg(highestHigh, lowestLow);
        const avg2 = TechnicalAnalysis.avg(avg1, smaClose);
        const sourceValue = currentClose - avg2;
        sourceValues.push(sourceValue);
      }
    }

    if (sourceValues.length < 2) {
      return null;
    }

    // Take only the last kcLength source values and apply linear regression
    const lastSourceValues = sourceValues.slice(-this.params.kcLength);
    const momentum = TechnicalAnalysis.linearRegression(lastSourceValues, lastSourceValues.length, 0);

    if (momentum === null) {
      return null;
    }

    // Determine direction and color (matches PineScript logic)
    let direction = 'neutral';
    let color = 'gray';

    if (momentum > 0) {
      direction = 'bullish';
      if (previousMomentum !== null && momentum > previousMomentum) {
        color = 'lime';  // Increasing bullish
      } else {
        color = 'green'; // Decreasing bullish
      }
    } else if (momentum < 0) {
      direction = 'bearish';
      if (previousMomentum !== null && momentum < previousMomentum) {
        color = 'red';    // Increasing bearish
      } else {
        color = 'maroon'; // Decreasing bearish
      }
    }

    return {
      value: momentum,
      direction: direction,
      color: color
    };
  }

  /**
   * Get momentum color based on current and previous values
   * @param {number} currentMomentum - Current momentum value
   * @param {number} previousMomentum - Previous momentum value
   * @returns {string} Color indicator ('lime', 'green', 'red', 'maroon')
   */
  getMomentumColor(currentMomentum, previousMomentum) {
    if (currentMomentum === null) return 'gray';

    if (currentMomentum > 0) {
      if (previousMomentum !== null && currentMomentum > previousMomentum) {
        return 'lime';  // Bullish increasing
      }
      return 'green';  // Bullish decreasing
    } else {
      if (previousMomentum !== null && currentMomentum < previousMomentum) {
        return 'red';    // Bearish decreasing
      }
      return 'maroon'; // Bearish increasing
    }
  }

  /**
   * Get squeeze indicator color
   * @param {object} squeezeState - Squeeze state object
   * @returns {string} Color indicator ('black', 'gray', 'blue')
   */
  getSqueezeColor(squeezeState) {
    if (!squeezeState) return 'gray';

    if (squeezeState.sqzOn) return 'black';   // Squeeze is on
    if (squeezeState.noSqz) return 'blue';    // No squeeze
    return 'gray';  // Squeeze off or transitional
  }

  /**
   * Calculate complete squeeze momentum indicator
   * @param {object[]} candles - Array of candle objects (must include previous candles for calculation)
   * @param {number} previousMomentum - Previous momentum value for color calculation
   * @returns {object} Complete squeeze momentum analysis
   */
  calculate(candles, previousMomentum = null) {
    if (!TechnicalAnalysis.validateData(candles, Math.max(this.params.bbLength, this.params.kcLength))) {
      return null;
    }

    const bb = this.calculateBollingerBands(candles);
    const kc = this.calculateKeltnerChannels(candles);
    const squeezeState = this.calculateSqueezeState(bb, kc);
    const momentum = this.calculateMomentum(candles);

    if (!bb || !kc || !squeezeState || momentum === null) {
      return null;
    }

    const momentumColor = this.getMomentumColor(momentum.value, previousMomentum);
    const squeezeColor = this.getSqueezeColor(squeezeState);

    return {
      timestamp: new Date().toISOString(),
      bollingerBands: bb,
      keltnerChannels: kc,
      squeeze: squeezeState,
      momentum: {
        value: momentum.value,
        color: momentumColor,
        isPositive: momentum.value > 0,
        isIncreasing: previousMomentum !== null ? momentum.value > previousMomentum : null
      },
      squeezeColor: squeezeColor,
      signals: {
        squeezeBreakout: squeezeState.sqzOff,  // Potential volatility expansion
        momentumShift: previousMomentum !== null &&
                      ((momentum.value > 0 && previousMomentum <= 0) || (momentum.value <= 0 && previousMomentum > 0)),
        bullishMomentum: momentum.value > 0 && (previousMomentum === null || momentum.value > previousMomentum),
        bearishMomentum: momentum.value < 0 && (previousMomentum === null || momentum.value < previousMomentum)
      }
    };
  }

  /**
   * Get indicator parameters
   * @returns {object} Current parameters
   */
  getParams() {
    return { ...this.params };
  }

  /**
   * Update indicator parameters
   * @param {object} newParams - New parameter values
   */
  updateParams(newParams) {
    this.params = { ...this.params, ...newParams };
  }
}

export default SqueezeMomentumIndicator;