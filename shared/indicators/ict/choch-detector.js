/**
 * Change of Character (CHoCH) Detector
 *
 * Detects the first swing break opposite to the current trend, signaling
 * a potential reversal. This is the ICT concept of "Change of Character".
 *
 * Bullish CHoCH: In a downtrend, the HIGH that created the most recent LOW gets broken upward
 * Bearish CHoCH: In an uptrend, the LOW that created the most recent HIGH gets broken downward
 */

export class CHoCHDetector {
  constructor(options = {}) {
    this.options = {
      swingLookback: options.swingLookback || 5,         // Bars on each side to confirm swing
      minSwingSize: options.minSwingSize || 10,          // Min points for valid swing
      breakConfirmation: options.breakConfirmation || 2,  // Points beyond swing for valid break
      maxSwingsToTrack: options.maxSwingsToTrack || 20,   // Max swings to keep in memory
      ...options
    };

    // State tracking
    this.swingHighs = [];
    this.swingLows = [];
    this.currentTrend = null;  // 'bullish' | 'bearish' | 'neutral'
    this.lastCHoCH = null;
    this.swingSequence = [];   // Ordered list of all swings for relationship tracking
  }

  /**
   * Reset detector state
   */
  reset() {
    this.swingHighs = [];
    this.swingLows = [];
    this.currentTrend = null;
    this.lastCHoCH = null;
    this.swingSequence = [];
  }

  /**
   * Identify swing highs and lows in candle data
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

      // Check for swing high - must be higher than all surrounding candles
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
        const swingHigh = {
          type: 'high',
          index: i,
          price: current.high,
          timestamp: current.timestamp,
          candle: current,
          creatingSwing: null  // Will be populated later
        };
        swings.highs.push(swingHigh);
      }

      if (isSwingLow) {
        const swingLow = {
          type: 'low',
          index: i,
          price: current.low,
          timestamp: current.timestamp,
          candle: current,
          creatingSwing: null  // Will be populated later
        };
        swings.lows.push(swingLow);
      }
    }

    return swings;
  }

  /**
   * Build swing sequence and establish relationships
   * For each swing, identify the "creating swing" - the opposite swing that preceded it
   * @param {Object} swings - { highs: [], lows: [] }
   * @returns {Object[]} Ordered sequence of all swings with relationships
   */
  buildSwingSequence(swings) {
    // Combine and sort by index
    const allSwings = [
      ...swings.highs.map(s => ({ ...s, swingType: 'high' })),
      ...swings.lows.map(s => ({ ...s, swingType: 'low' }))
    ].sort((a, b) => a.index - b.index);

    // Establish relationships - each swing is "created" by the previous opposite swing
    for (let i = 1; i < allSwings.length; i++) {
      const current = allSwings[i];

      // Find the most recent opposite swing
      for (let j = i - 1; j >= 0; j--) {
        if (allSwings[j].swingType !== current.swingType) {
          current.creatingSwing = allSwings[j];
          break;
        }
      }
    }

    return allSwings;
  }

  /**
   * Determine current trend from swing sequence
   * @param {Object[]} swingSequence - Ordered array of swings
   * @returns {string} 'bullish' | 'bearish' | 'neutral'
   */
  determineTrend(swingSequence) {
    if (swingSequence.length < 4) {
      return 'neutral';
    }

    // Get the last few swing highs and lows
    const recentHighs = swingSequence.filter(s => s.swingType === 'high').slice(-3);
    const recentLows = swingSequence.filter(s => s.swingType === 'low').slice(-3);

    if (recentHighs.length < 2 || recentLows.length < 2) {
      return 'neutral';
    }

    // Check for higher highs and higher lows (uptrend)
    let higherHighs = 0;
    let higherLows = 0;
    let lowerHighs = 0;
    let lowerLows = 0;

    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i].price > recentHighs[i - 1].price) {
        higherHighs++;
      } else if (recentHighs[i].price < recentHighs[i - 1].price) {
        lowerHighs++;
      }
    }

    for (let i = 1; i < recentLows.length; i++) {
      if (recentLows[i].price > recentLows[i - 1].price) {
        higherLows++;
      } else if (recentLows[i].price < recentLows[i - 1].price) {
        lowerLows++;
      }
    }

    // Uptrend: Higher highs AND higher lows
    if (higherHighs >= lowerHighs && higherLows > lowerLows) {
      return 'bullish';
    }

    // Downtrend: Lower highs AND lower lows
    if (lowerHighs >= higherHighs && lowerLows > higherLows) {
      return 'bearish';
    }

    return 'neutral';
  }

  /**
   * Main analysis method - detect CHoCH
   * @param {Object[]} candles - Historical candles array
   * @returns {Object|null} CHoCH event or null
   */
  analyze(candles) {
    if (!candles || candles.length < this.options.swingLookback * 2 + 3) {
      return null;
    }

    // Identify swings
    const swings = this.identifySwings(candles);

    // Build sequence with relationships
    const swingSequence = this.buildSwingSequence(swings);

    if (swingSequence.length < 4) {
      return null;
    }

    // Store for external access
    this.swingHighs = swings.highs;
    this.swingLows = swings.lows;
    this.swingSequence = swingSequence;

    // Determine current trend
    const trend = this.determineTrend(swingSequence);
    this.currentTrend = trend;

    const currentCandle = candles[candles.length - 1];
    const breakBuffer = this.options.breakConfirmation;

    // Look for CHoCH based on current trend
    if (trend === 'bearish') {
      // In downtrend, look for bullish CHoCH
      // The HIGH that created the most recent LOW gets broken upward
      const recentLows = swingSequence.filter(s => s.swingType === 'low').slice(-2);

      if (recentLows.length >= 1) {
        const lastLow = recentLows[recentLows.length - 1];
        const creatingHigh = lastLow.creatingSwing;

        if (creatingHigh && creatingHigh.swingType === 'high') {
          // Check if current candle breaks above this high
          if (currentCandle.close > creatingHigh.price + breakBuffer) {
            const choch = {
              type: 'bullish',
              level: creatingHigh.price,
              breakPrice: currentCandle.close,
              timestamp: currentCandle.timestamp,
              swingBroken: creatingHigh,
              trendBefore: 'bearish',
              strength: currentCandle.close - creatingHigh.price
            };
            this.lastCHoCH = choch;
            return choch;
          }
        }
      }
    } else if (trend === 'bullish') {
      // In uptrend, look for bearish CHoCH
      // The LOW that created the most recent HIGH gets broken downward
      const recentHighs = swingSequence.filter(s => s.swingType === 'high').slice(-2);

      if (recentHighs.length >= 1) {
        const lastHigh = recentHighs[recentHighs.length - 1];
        const creatingLow = lastHigh.creatingSwing;

        if (creatingLow && creatingLow.swingType === 'low') {
          // Check if current candle breaks below this low
          if (currentCandle.close < creatingLow.price - breakBuffer) {
            const choch = {
              type: 'bearish',
              level: creatingLow.price,
              breakPrice: currentCandle.close,
              timestamp: currentCandle.timestamp,
              swingBroken: creatingLow,
              trendBefore: 'bullish',
              strength: creatingLow.price - currentCandle.close
            };
            this.lastCHoCH = choch;
            return choch;
          }
        }
      }
    }

    return null;
  }

  /**
   * Get current state for external access
   * @returns {Object} Current detector state
   */
  getState() {
    return {
      trend: this.currentTrend,
      lastCHoCH: this.lastCHoCH,
      swingHighs: this.swingHighs,
      swingLows: this.swingLows,
      swingSequence: this.swingSequence
    };
  }

  /**
   * Get the swing high that would be broken for a bullish CHoCH
   * @returns {Object|null} Swing high to watch
   */
  getBullishCHoCHLevel() {
    if (this.currentTrend !== 'bearish') return null;

    const recentLows = this.swingSequence.filter(s => s.swingType === 'low').slice(-1);
    if (recentLows.length === 0) return null;

    const lastLow = recentLows[0];
    return lastLow.creatingSwing;
  }

  /**
   * Get the swing low that would be broken for a bearish CHoCH
   * @returns {Object|null} Swing low to watch
   */
  getBearishCHoCHLevel() {
    if (this.currentTrend !== 'bullish') return null;

    const recentHighs = this.swingSequence.filter(s => s.swingType === 'high').slice(-1);
    if (recentHighs.length === 0) return null;

    const lastHigh = recentHighs[0];
    return lastHigh.creatingSwing;
  }
}

export default CHoCHDetector;
