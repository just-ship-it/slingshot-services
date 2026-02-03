/**
 * Dynamic Levels Indicator
 *
 * Calculates common trading levels that algos respect:
 * - EMAs (9, 20, 50)
 * - VWAP with standard deviation bands
 * - Bollinger Bands
 *
 * Designed for real-time level tracking and bounce detection.
 */

export class DynamicLevels {
  constructor(params = {}) {
    this.params = {
      // EMA periods
      emaPeriods: [9, 20, 50, 100],

      // VWAP bands (standard deviations)
      vwapBands: [1, 2, 3],

      // Bollinger Bands
      bbPeriod: 20,
      bbStdDev: 2,

      ...params
    };

    // State for calculations
    this.emaValues = {};  // { period: value }
    this.vwapState = null;
    this.bbState = null;
    this.priceHistory = [];
  }

  /**
   * Update all indicators with new candle
   * @param {Object} candle - { open, high, low, close, volume, timestamp }
   * @param {boolean} isNewSession - Reset VWAP on new session
   * @returns {Object} All current levels
   */
  update(candle, isNewSession = false) {
    this.priceHistory.push(candle);

    // Keep history manageable
    const maxHistory = Math.max(this.params.bbPeriod, ...this.params.emaPeriods) + 10;
    if (this.priceHistory.length > maxHistory) {
      this.priceHistory.shift();
    }

    // Update EMAs
    for (const period of this.params.emaPeriods) {
      this.emaValues[period] = this.calculateEMA(period, candle.close);
    }

    // Update VWAP
    if (isNewSession) {
      this.resetVWAP();
    }
    this.updateVWAP(candle);

    // Update Bollinger Bands
    this.updateBollingerBands();

    return this.getLevels();
  }

  /**
   * Get all current levels
   * @returns {Object} All indicator levels
   */
  getLevels() {
    const levels = {
      ema: {},
      vwap: null,
      vwapUpper1: null,
      vwapLower1: null,
      vwapUpper2: null,
      vwapLower2: null,
      vwapUpper3: null,
      vwapLower3: null,
      bbUpper: null,
      bbMiddle: null,
      bbLower: null,
    };

    // EMAs
    for (const period of this.params.emaPeriods) {
      levels.ema[period] = this.emaValues[period] || null;
    }

    // VWAP and bands
    if (this.vwapState && this.vwapState.vwap) {
      levels.vwap = this.vwapState.vwap;
      const stdDev = this.vwapState.stdDev || 0;

      if (this.params.vwapBands.includes(1)) {
        levels.vwapUpper1 = this.vwapState.vwap + stdDev;
        levels.vwapLower1 = this.vwapState.vwap - stdDev;
      }
      if (this.params.vwapBands.includes(2)) {
        levels.vwapUpper2 = this.vwapState.vwap + (2 * stdDev);
        levels.vwapLower2 = this.vwapState.vwap - (2 * stdDev);
      }
      if (this.params.vwapBands.includes(3)) {
        levels.vwapUpper3 = this.vwapState.vwap + (3 * stdDev);
        levels.vwapLower3 = this.vwapState.vwap - (3 * stdDev);
      }
    }

    // Bollinger Bands
    if (this.bbState) {
      levels.bbUpper = this.bbState.upper;
      levels.bbMiddle = this.bbState.middle;
      levels.bbLower = this.bbState.lower;
    }

    return levels;
  }

  /**
   * Get all levels as a flat array for bounce detection
   * @returns {Array} [{ name, value, type }]
   */
  getLevelsArray() {
    const levels = this.getLevels();
    const result = [];

    // EMAs
    for (const [period, value] of Object.entries(levels.ema)) {
      if (value !== null) {
        result.push({ name: `EMA${period}`, value, type: 'ema' });
      }
    }

    // VWAP
    if (levels.vwap !== null) {
      result.push({ name: 'VWAP', value: levels.vwap, type: 'vwap' });
    }
    if (levels.vwapUpper1 !== null) {
      result.push({ name: 'VWAP+1σ', value: levels.vwapUpper1, type: 'vwap_band' });
    }
    if (levels.vwapLower1 !== null) {
      result.push({ name: 'VWAP-1σ', value: levels.vwapLower1, type: 'vwap_band' });
    }
    if (levels.vwapUpper2 !== null) {
      result.push({ name: 'VWAP+2σ', value: levels.vwapUpper2, type: 'vwap_band' });
    }
    if (levels.vwapLower2 !== null) {
      result.push({ name: 'VWAP-2σ', value: levels.vwapLower2, type: 'vwap_band' });
    }
    if (levels.vwapUpper3 !== null) {
      result.push({ name: 'VWAP+3σ', value: levels.vwapUpper3, type: 'vwap_band' });
    }
    if (levels.vwapLower3 !== null) {
      result.push({ name: 'VWAP-3σ', value: levels.vwapLower3, type: 'vwap_band' });
    }

    // Bollinger Bands
    if (levels.bbUpper !== null) {
      result.push({ name: 'BB_Upper', value: levels.bbUpper, type: 'bb' });
    }
    if (levels.bbMiddle !== null) {
      result.push({ name: 'BB_Middle', value: levels.bbMiddle, type: 'bb' });
    }
    if (levels.bbLower !== null) {
      result.push({ name: 'BB_Lower', value: levels.bbLower, type: 'bb' });
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════
  // EMA CALCULATION
  // ═══════════════════════════════════════════════════════

  calculateEMA(period, newPrice) {
    const prevEMA = this.emaValues[period];

    if (prevEMA === undefined || prevEMA === null) {
      // Initialize with SMA if we have enough history
      if (this.priceHistory.length >= period) {
        const slice = this.priceHistory.slice(-period);
        return slice.reduce((sum, c) => sum + c.close, 0) / period;
      }
      return newPrice; // Not enough data, use current price
    }

    const multiplier = 2 / (period + 1);
    return (newPrice - prevEMA) * multiplier + prevEMA;
  }

  // ═══════════════════════════════════════════════════════
  // VWAP CALCULATION
  // ═══════════════════════════════════════════════════════

  resetVWAP() {
    this.vwapState = {
      cumulativeTPV: 0,  // Cumulative (Typical Price * Volume)
      cumulativeVolume: 0,
      vwap: null,
      prices: [],  // For std dev calculation
      stdDev: 0
    };
  }

  updateVWAP(candle) {
    if (!this.vwapState) {
      this.resetVWAP();
    }

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;

    this.vwapState.cumulativeTPV += typicalPrice * candle.volume;
    this.vwapState.cumulativeVolume += candle.volume;
    this.vwapState.prices.push(typicalPrice);

    if (this.vwapState.cumulativeVolume > 0) {
      this.vwapState.vwap = this.vwapState.cumulativeTPV / this.vwapState.cumulativeVolume;

      // Calculate standard deviation for bands
      if (this.vwapState.prices.length > 1) {
        const mean = this.vwapState.vwap;
        const squaredDiffs = this.vwapState.prices.map(p => Math.pow(p - mean, 2));
        const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
        this.vwapState.stdDev = Math.sqrt(avgSquaredDiff);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // BOLLINGER BANDS CALCULATION
  // ═══════════════════════════════════════════════════════

  updateBollingerBands() {
    const period = this.params.bbPeriod;
    const stdDevMult = this.params.bbStdDev;

    if (this.priceHistory.length < period) {
      this.bbState = null;
      return;
    }

    const slice = this.priceHistory.slice(-period);
    const closes = slice.map(c => c.close);

    // SMA (middle band)
    const sma = closes.reduce((a, b) => a + b, 0) / period;

    // Standard deviation
    const squaredDiffs = closes.map(p => Math.pow(p - sma, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(variance);

    this.bbState = {
      upper: sma + (stdDevMult * stdDev),
      middle: sma,
      lower: sma - (stdDevMult * stdDev),
      stdDev: stdDev
    };
  }

  // ═══════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════

  reset() {
    this.emaValues = {};
    this.vwapState = null;
    this.bbState = null;
    this.priceHistory = [];
  }
}

export default DynamicLevels;
