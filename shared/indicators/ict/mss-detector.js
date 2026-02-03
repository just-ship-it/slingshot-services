/**
 * Market Structure Shift (MSS) / Break of Structure (BOS) Detector
 *
 * Detects continuation structure breaks that confirm the new trend direction.
 * This comes AFTER a CHoCH (Change of Character) to confirm the trend shift.
 *
 * Bullish MSS/BOS: After bullish CHoCH, break above previous swing HIGH (confirms uptrend)
 * Bearish MSS/BOS: After bearish CHoCH, break below previous swing LOW (confirms downtrend)
 *
 * The difference between CHoCH and MSS:
 * - CHoCH: First break opposite to the trend (signals potential reversal)
 * - MSS/BOS: Continuation break in the new direction (confirms the reversal)
 */

export class MSSDetector {
  constructor(options = {}) {
    this.options = {
      breakBuffer: options.breakBuffer || 2,         // Points beyond level for valid break
      requireCandleClose: options.requireCandleClose !== false, // Require candle close beyond level
      swingLookback: options.swingLookback || 5,     // Bars to confirm swing
      minSwingSize: options.minSwingSize || 10,      // Min points for valid swing
      ...options
    };

    // State tracking
    this.lastMSS = null;
    this.currentBias = null;  // 'bullish' | 'bearish' | null
    this.mssHistory = [];
  }

  /**
   * Reset detector state
   */
  reset() {
    this.lastMSS = null;
    this.currentBias = null;
    this.mssHistory = [];
  }

  /**
   * Identify swing highs and lows (same logic as CHoCH detector)
   * @param {Object[]} candles - Array of candle objects
   * @returns {Object} { highs: [], lows: [] }
   */
  identifySwings(candles) {
    const swings = { highs: [], lows: [] };
    const lookback = this.options.swingLookback;

    if (candles.length < lookback * 2 + 1) {
      return swings;
    }

    for (let i = lookback; i < candles.length - lookback; i++) {
      const current = candles[i];
      let isSwingHigh = true;
      let isSwingLow = true;

      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high >= current.high || candles[i + j].high >= current.high) {
          isSwingHigh = false;
        }
        if (candles[i - j].low <= current.low || candles[i + j].low <= current.low) {
          isSwingLow = false;
        }
        if (!isSwingHigh && !isSwingLow) break;
      }

      if (isSwingHigh) {
        swings.highs.push({
          type: 'high',
          index: i,
          price: current.high,
          timestamp: current.timestamp,
          candle: current
        });
      }

      if (isSwingLow) {
        swings.lows.push({
          type: 'low',
          index: i,
          price: current.low,
          timestamp: current.timestamp,
          candle: current
        });
      }
    }

    return swings;
  }

  /**
   * Main analysis method - detect MSS/BOS
   * @param {Object[]} candles - Historical candles array
   * @param {Object|null} chochEvent - Prior CHoCH event (optional but recommended)
   * @returns {Object|null} MSS/BOS event or null
   */
  analyze(candles, chochEvent = null) {
    if (!candles || candles.length < this.options.swingLookback * 2 + 3) {
      return null;
    }

    const currentCandle = candles[candles.length - 1];
    const swings = this.identifySwings(candles);
    const breakBuffer = this.options.breakBuffer;

    // If we have a CHoCH event, look for MSS in the new direction
    if (chochEvent) {
      return this.detectMSSAfterCHoCH(candles, swings, chochEvent);
    }

    // Without CHoCH context, detect any structure break as potential BOS
    return this.detectBOS(candles, swings);
  }

  /**
   * Detect MSS after a CHoCH event
   * @param {Object[]} candles
   * @param {Object} swings
   * @param {Object} chochEvent
   * @returns {Object|null}
   */
  detectMSSAfterCHoCH(candles, swings, chochEvent) {
    const currentCandle = candles[candles.length - 1];
    const breakBuffer = this.options.breakBuffer;

    if (chochEvent.type === 'bullish') {
      // After bullish CHoCH, look for break above previous HIGH (confirms uptrend)
      // Find highs that formed AFTER the CHoCH
      const relevantHighs = swings.highs.filter(h =>
        h.timestamp > chochEvent.timestamp &&
        h.price > chochEvent.level
      );

      if (relevantHighs.length === 0) {
        // No new highs formed yet, look for break of the swing high before CHoCH
        const highsBeforeCHoCH = swings.highs.filter(h =>
          h.timestamp <= chochEvent.timestamp
        ).slice(-2);

        if (highsBeforeCHoCH.length > 0) {
          const highToBreak = highsBeforeCHoCH[highsBeforeCHoCH.length - 1];

          if (this.checkBreak(currentCandle, highToBreak.price, 'above', breakBuffer)) {
            const mss = {
              type: 'bullish_mss',
              level: highToBreak.price,
              breakPrice: currentCandle.close,
              timestamp: currentCandle.timestamp,
              swingBroken: highToBreak,
              confirmsChoch: chochEvent,
              direction: 'bullish'
            };
            this.lastMSS = mss;
            this.currentBias = 'bullish';
            this.mssHistory.push(mss);
            return mss;
          }
        }
      } else {
        // New highs have formed, break of most recent high confirms continuation
        const highToBreak = relevantHighs[relevantHighs.length - 1];

        if (this.checkBreak(currentCandle, highToBreak.price, 'above', breakBuffer)) {
          const mss = {
            type: 'bullish_bos',
            level: highToBreak.price,
            breakPrice: currentCandle.close,
            timestamp: currentCandle.timestamp,
            swingBroken: highToBreak,
            confirmsChoch: chochEvent,
            direction: 'bullish'
          };
          this.lastMSS = mss;
          this.currentBias = 'bullish';
          this.mssHistory.push(mss);
          return mss;
        }
      }
    } else if (chochEvent.type === 'bearish') {
      // After bearish CHoCH, look for break below previous LOW (confirms downtrend)
      const relevantLows = swings.lows.filter(l =>
        l.timestamp > chochEvent.timestamp &&
        l.price < chochEvent.level
      );

      if (relevantLows.length === 0) {
        // No new lows formed yet, look for break of the swing low before CHoCH
        const lowsBeforeCHoCH = swings.lows.filter(l =>
          l.timestamp <= chochEvent.timestamp
        ).slice(-2);

        if (lowsBeforeCHoCH.length > 0) {
          const lowToBreak = lowsBeforeCHoCH[lowsBeforeCHoCH.length - 1];

          if (this.checkBreak(currentCandle, lowToBreak.price, 'below', breakBuffer)) {
            const mss = {
              type: 'bearish_mss',
              level: lowToBreak.price,
              breakPrice: currentCandle.close,
              timestamp: currentCandle.timestamp,
              swingBroken: lowToBreak,
              confirmsChoch: chochEvent,
              direction: 'bearish'
            };
            this.lastMSS = mss;
            this.currentBias = 'bearish';
            this.mssHistory.push(mss);
            return mss;
          }
        }
      } else {
        // New lows have formed, break of most recent low confirms continuation
        const lowToBreak = relevantLows[relevantLows.length - 1];

        if (this.checkBreak(currentCandle, lowToBreak.price, 'below', breakBuffer)) {
          const mss = {
            type: 'bearish_bos',
            level: lowToBreak.price,
            breakPrice: currentCandle.close,
            timestamp: currentCandle.timestamp,
            swingBroken: lowToBreak,
            confirmsChoch: chochEvent,
            direction: 'bearish'
          };
          this.lastMSS = mss;
          this.currentBias = 'bearish';
          this.mssHistory.push(mss);
          return mss;
        }
      }
    }

    return null;
  }

  /**
   * Detect BOS without CHoCH context (continuation breaks)
   * @param {Object[]} candles
   * @param {Object} swings
   * @returns {Object|null}
   */
  detectBOS(candles, swings) {
    if (swings.highs.length < 2 && swings.lows.length < 2) {
      return null;
    }

    const currentCandle = candles[candles.length - 1];
    const breakBuffer = this.options.breakBuffer;

    // Check for bullish BOS (break of previous high)
    if (swings.highs.length >= 2) {
      const prevHigh = swings.highs[swings.highs.length - 2];
      const lastHigh = swings.highs[swings.highs.length - 1];

      // If making higher highs, this is a continuation break
      if (this.checkBreak(currentCandle, lastHigh.price, 'above', breakBuffer)) {
        const bos = {
          type: 'bullish_bos',
          level: lastHigh.price,
          breakPrice: currentCandle.close,
          timestamp: currentCandle.timestamp,
          swingBroken: lastHigh,
          confirmsChoch: null,
          direction: 'bullish',
          isHigherHigh: lastHigh.price > prevHigh.price
        };
        this.lastMSS = bos;
        this.currentBias = 'bullish';
        this.mssHistory.push(bos);
        return bos;
      }
    }

    // Check for bearish BOS (break of previous low)
    if (swings.lows.length >= 2) {
      const prevLow = swings.lows[swings.lows.length - 2];
      const lastLow = swings.lows[swings.lows.length - 1];

      if (this.checkBreak(currentCandle, lastLow.price, 'below', breakBuffer)) {
        const bos = {
          type: 'bearish_bos',
          level: lastLow.price,
          breakPrice: currentCandle.close,
          timestamp: currentCandle.timestamp,
          swingBroken: lastLow,
          confirmsChoch: null,
          direction: 'bearish',
          isLowerLow: lastLow.price < prevLow.price
        };
        this.lastMSS = bos;
        this.currentBias = 'bearish';
        this.mssHistory.push(bos);
        return bos;
      }
    }

    return null;
  }

  /**
   * Check if candle breaks a level
   * @param {Object} candle
   * @param {number} level
   * @param {string} direction - 'above' | 'below'
   * @param {number} buffer
   * @returns {boolean}
   */
  checkBreak(candle, level, direction, buffer) {
    if (this.options.requireCandleClose) {
      if (direction === 'above') {
        return candle.close > level + buffer;
      } else {
        return candle.close < level - buffer;
      }
    } else {
      // Just need price to reach the level
      if (direction === 'above') {
        return candle.high > level + buffer;
      } else {
        return candle.low < level - buffer;
      }
    }
  }

  /**
   * Get current state
   * @returns {Object}
   */
  getState() {
    return {
      currentBias: this.currentBias,
      lastMSS: this.lastMSS,
      mssHistory: this.mssHistory.slice(-10)  // Last 10 events
    };
  }

  /**
   * Check if we're in a confirmed bullish structure
   * @returns {boolean}
   */
  isBullish() {
    return this.currentBias === 'bullish';
  }

  /**
   * Check if we're in a confirmed bearish structure
   * @returns {boolean}
   */
  isBearish() {
    return this.currentBias === 'bearish';
  }
}

export default MSSDetector;
