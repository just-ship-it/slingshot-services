/**
 * Momentum Divergence Detector
 *
 * Detects divergences between price action and momentum indicators (RSI, MACD)
 * Used to confirm potential reversals at GEX-LDPM confluence zones
 */

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

export class MomentumDivergenceDetector {
  constructor(params = {}) {
    this.params = {
      // RSI parameters
      rsiPeriod: params.rsiPeriod || 14,
      rsiOverbought: params.rsiOverbought || 70,
      rsiOversold: params.rsiOversold || 30,

      // MACD parameters
      macdFast: params.macdFast || 12,
      macdSlow: params.macdSlow || 26,
      macdSignal: params.macdSignal || 9,

      // Divergence detection
      lookbackPeriods: params.lookbackPeriods || 20,  // Candles to look back for divergence
      minSwingSize: params.minSwingSize || 10,        // Min points between price swings
      divergenceThreshold: params.divergenceThreshold || 0.01, // Min % difference for divergence

      // Confirmation requirements
      requireRSIDivergence: params.requireRSIDivergence !== false,
      requireMACDDivergence: params.requireMACDDivergence || false,
      requireBoth: params.requireBoth || false,  // Both RSI and MACD must show divergence

      ...params
    };

    // State for calculations
    this.rsiHistory = [];
    this.macdHistory = [];
    this.priceSwings = [];
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  calculateRSI(candles) {
    if (!candles || candles.length < this.params.rsiPeriod + 1) {
      return null;
    }

    const changes = [];
    for (let i = 1; i < candles.length; i++) {
      changes.push(candles[i].close - candles[i-1].close);
    }

    const gains = changes.map(c => c > 0 ? c : 0);
    const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);

    // Get recent values for calculation
    const recentGains = gains.slice(-this.params.rsiPeriod);
    const recentLosses = losses.slice(-this.params.rsiPeriod);

    const avgGain = recentGains.reduce((a, b) => a + b, 0) / this.params.rsiPeriod;
    const avgLoss = recentLosses.reduce((a, b) => a + b, 0) / this.params.rsiPeriod;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return rsi;
  }

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   */
  calculateMACD(candles) {
    if (!candles || candles.length < this.params.macdSlow) {
      return null;
    }

    const closes = TechnicalAnalysis.getValues(candles, 'close');

    // Calculate EMAs
    const emaFast = this.calculateEMA(closes, this.params.macdFast);
    const emaSlow = this.calculateEMA(closes, this.params.macdSlow);

    if (!emaFast || !emaSlow) return null;

    const macdLine = emaFast - emaSlow;

    // Calculate signal line (9-period EMA of MACD)
    // For simplicity, using SMA here - could enhance with proper EMA
    const macdHistory = this.macdHistory.slice(-this.params.macdSignal + 1);
    macdHistory.push(macdLine);

    const signalLine = macdHistory.length >= this.params.macdSignal ?
      macdHistory.reduce((a, b) => a + b, 0) / macdHistory.length : macdLine;

    const histogram = macdLine - signalLine;

    return {
      macdLine,
      signalLine,
      histogram
    };
  }

  /**
   * Calculate Exponential Moving Average
   */
  calculateEMA(values, period) {
    if (!values || values.length < period) return null;

    const multiplier = 2 / (period + 1);
    let ema = TechnicalAnalysis.sma(values.slice(0, period), period);

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Find price swings (local highs and lows)
   */
  findPriceSwings(candles, lookback) {
    const swings = [];
    const minSwingSize = this.params.minSwingSize;

    for (let i = lookback; i < candles.length - lookback; i++) {
      const candle = candles[i];
      let isSwingHigh = true;
      let isSwingLow = true;

      // Check if this is a swing high
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high >= candle.high || candles[i + j].high >= candle.high) {
          isSwingHigh = false;
          break;
        }
      }

      // Check if this is a swing low
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].low <= candle.low || candles[i + j].low <= candle.low) {
          isSwingLow = false;
          break;
        }
      }

      if (isSwingHigh) {
        swings.push({
          type: 'high',
          index: i,
          price: candle.high,
          timestamp: candle.timestamp
        });
      }

      if (isSwingLow) {
        swings.push({
          type: 'low',
          index: i,
          price: candle.low,
          timestamp: candle.timestamp
        });
      }
    }

    return swings;
  }

  /**
   * Detect divergence between price and momentum indicators
   *
   * @param {Array} candles - Array of candle data (at least lookbackPeriods + indicators period)
   * @param {string} direction - 'bullish' or 'bearish' divergence to detect
   * @returns {Object|null} Divergence signal or null
   */
  detectDivergence(candles, direction = 'both') {
    if (!candles || candles.length < this.params.lookbackPeriods + Math.max(this.params.rsiPeriod, this.params.macdSlow)) {
      return null;
    }

    // Find recent price swings
    const swings = this.findPriceSwings(candles, 3);
    if (swings.length < 2) return null;

    // Get the two most recent swings of the same type
    const recentLows = swings.filter(s => s.type === 'low').slice(-2);
    const recentHighs = swings.filter(s => s.type === 'high').slice(-2);

    let divergence = null;

    // Check for bullish divergence (price making lower lows, indicator making higher lows)
    if ((direction === 'bullish' || direction === 'both') && recentLows.length === 2) {
      const priceLowerLow = recentLows[1].price < recentLows[0].price;

      if (priceLowerLow) {
        // Calculate indicators at both swing points
        const rsi1 = this.calculateRSI(candles.slice(0, recentLows[0].index + 1));
        const rsi2 = this.calculateRSI(candles.slice(0, recentLows[1].index + 1));
        const macd1 = this.calculateMACD(candles.slice(0, recentLows[0].index + 1));
        const macd2 = this.calculateMACD(candles.slice(0, recentLows[1].index + 1));

        const rsiHigherLow = rsi1 && rsi2 && rsi2 > rsi1;
        const macdHigherLow = macd1 && macd2 && macd2.histogram > macd1.histogram;

        const hasRSIDivergence = this.params.requireRSIDivergence && rsiHigherLow;
        const hasMACDDivergence = this.params.requireMACDDivergence && macdHigherLow;

        if (this.params.requireBoth ? (hasRSIDivergence && hasMACDDivergence) : (hasRSIDivergence || hasMACDDivergence)) {
          divergence = {
            type: 'bullish',
            priceSwing1: recentLows[0],
            priceSwing2: recentLows[1],
            rsi: rsi2,
            macd: macd2,
            strength: this.calculateDivergenceStrength(recentLows[0].price, recentLows[1].price, rsi1, rsi2),
            indicators: {
              rsi: hasRSIDivergence,
              macd: hasMACDDivergence
            }
          };
        }
      }
    }

    // Check for bearish divergence (price making higher highs, indicator making lower highs)
    if (!divergence && (direction === 'bearish' || direction === 'both') && recentHighs.length === 2) {
      const priceHigherHigh = recentHighs[1].price > recentHighs[0].price;

      if (priceHigherHigh) {
        const rsi1 = this.calculateRSI(candles.slice(0, recentHighs[0].index + 1));
        const rsi2 = this.calculateRSI(candles.slice(0, recentHighs[1].index + 1));
        const macd1 = this.calculateMACD(candles.slice(0, recentHighs[0].index + 1));
        const macd2 = this.calculateMACD(candles.slice(0, recentHighs[1].index + 1));

        const rsiLowerHigh = rsi1 && rsi2 && rsi2 < rsi1;
        const macdLowerHigh = macd1 && macd2 && macd2.histogram < macd1.histogram;

        const hasRSIDivergence = this.params.requireRSIDivergence && rsiLowerHigh;
        const hasMACDDivergence = this.params.requireMACDDivergence && macdLowerHigh;

        if (this.params.requireBoth ? (hasRSIDivergence && hasMACDDivergence) : (hasRSIDivergence || hasMACDDivergence)) {
          divergence = {
            type: 'bearish',
            priceSwing1: recentHighs[0],
            priceSwing2: recentHighs[1],
            rsi: rsi2,
            macd: macd2,
            strength: this.calculateDivergenceStrength(recentHighs[0].price, recentHighs[1].price, rsi1, rsi2),
            indicators: {
              rsi: hasRSIDivergence,
              macd: hasMACDDivergence
            }
          };
        }
      }
    }

    return divergence;
  }

  /**
   * Calculate divergence strength (0-100)
   */
  calculateDivergenceStrength(price1, price2, indicator1, indicator2) {
    if (!indicator1 || !indicator2) return 50;

    const priceDiff = Math.abs((price2 - price1) / price1);
    const indicatorDiff = Math.abs((indicator2 - indicator1) / indicator1);

    // Stronger divergence = larger difference between price and indicator moves
    const divergenceRatio = indicatorDiff / (priceDiff + 0.001);

    // Scale to 0-100
    return Math.min(100, Math.max(0, divergenceRatio * 50));
  }

  /**
   * Quick check for potential reversal conditions
   */
  checkReversalConditions(candles) {
    const rsi = this.calculateRSI(candles);
    const macd = this.calculateMACD(candles);

    return {
      rsiOversold: rsi && rsi < this.params.rsiOversold,
      rsiOverbought: rsi && rsi > this.params.rsiOverbought,
      macdCrossover: macd && macd.histogram > 0 && this.macdHistory.length > 0 &&
                     this.macdHistory[this.macdHistory.length - 1] < 0,
      macdCrossunder: macd && macd.histogram < 0 && this.macdHistory.length > 0 &&
                      this.macdHistory[this.macdHistory.length - 1] > 0,
      rsi: rsi,
      macd: macd
    };
  }
}

export default MomentumDivergenceDetector;