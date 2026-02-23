/**
 * Range Detector
 *
 * Tracks Average Daily Range (ADR) over a configurable lookback and
 * compares the current day's range to determine if price is in a
 * consolidation (range) state. Metadata-only initially — not used as
 * a filter unless explicitly enabled by the strategy.
 */

export class RangeDetector {
  constructor(params = {}) {
    this.adrLookback = params.adrLookback ?? 20;
    this.rangeThreshold = params.rangeThreshold ?? 0.5; // current range < 50% ADR = in range

    // Rolling daily ranges
    this.dailyRanges = []; // last N completed day ranges
    this.adr = null;

    // Current day tracking
    this.currentDay = null;
    this.dayHigh = -Infinity;
    this.dayLow = Infinity;
  }

  reset() {
    this.dailyRanges = [];
    this.adr = null;
    this.currentDay = null;
    this.dayHigh = -Infinity;
    this.dayLow = Infinity;
  }

  /**
   * Process a 1m candle to update range tracking
   * @param {Object} candle - { timestamp, open, high, low, close }
   * @param {string} dayKey - ET date key from LiquidityPoolTracker
   */
  processCandle(candle, dayKey) {
    if (dayKey !== this.currentDay) {
      // New day — finalize previous day's range
      if (this.currentDay !== null && this.dayHigh !== -Infinity) {
        const range = this.dayHigh - this.dayLow;
        this.dailyRanges.push(range);
        if (this.dailyRanges.length > this.adrLookback) {
          this.dailyRanges = this.dailyRanges.slice(-this.adrLookback);
        }
        this._recalcADR();
      }
      this.currentDay = dayKey;
      this.dayHigh = candle.high;
      this.dayLow = candle.low;
    } else {
      if (candle.high > this.dayHigh) this.dayHigh = candle.high;
      if (candle.low < this.dayLow) this.dayLow = candle.low;
    }
  }

  /**
   * Check if the current day's range is compressed (in range)
   * @returns {boolean}
   */
  isInRange() {
    if (this.adr === null || this.adr === 0) return false;
    const currentRange = this.dayHigh - this.dayLow;
    return currentRange < this.adr * this.rangeThreshold;
  }

  /**
   * Get range context metadata
   * @returns {{ adr: number|null, currentRange: number, pctOfADR: number|null, isInRange: boolean }}
   */
  getRangeContext() {
    const currentRange = this.dayHigh !== -Infinity ? this.dayHigh - this.dayLow : 0;
    return {
      adr: this.adr,
      currentRange,
      pctOfADR: this.adr ? currentRange / this.adr : null,
      isInRange: this.isInRange(),
    };
  }

  _recalcADR() {
    if (this.dailyRanges.length === 0) {
      this.adr = null;
      return;
    }
    const sum = this.dailyRanges.reduce((a, b) => a + b, 0);
    this.adr = sum / this.dailyRanges.length;
  }
}
