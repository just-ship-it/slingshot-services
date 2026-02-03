/**
 * M/W Pattern Detector
 *
 * Detects classic ICT M (Buy to Sell / Bearish) and W (Sell to Buy / Bullish)
 * reversal patterns.
 *
 * M Pattern (Bearish Reversal):
 * 1. Previous high (resistance level)
 * 2. Structure shifts bullish (liquidity sweep above high)
 * 3. New low creates shift up
 * 4. Structure shifts bearish (CHoCH down)
 * 5. New high creates shift down
 * 6. Entry at imbalance/OB retest
 * 7. Target: External low
 *
 * W Pattern (Bullish Reversal):
 * Opposite of M pattern
 */

export class MWPatternDetector {
  // Pattern stages
  static STAGES = {
    NONE: 0,
    KEY_LEVEL: 1,           // Key high/low identified
    LIQUIDITY_SWEEP: 2,     // Swept above/below key level
    FIRST_SHIFT: 3,         // First structure shift opposite
    CHOCH: 4,               // Change of character (reversal signal)
    SECOND_SHIFT: 5,        // Structure shifts in reversal direction
    AWAITING_RETEST: 6      // Pattern complete, waiting for entry retest
  };

  constructor(options = {}) {
    this.options = {
      patternTimeoutCandles: options.patternTimeoutCandles || 100,
      minPatternRange: options.minPatternRange || 25,           // Min range for valid pattern
      sweepMinPenetration: options.sweepMinPenetration || 2,    // Min points past level for sweep
      sweepMaxPenetration: options.sweepMaxPenetration || 30,   // Max points past level
      ...options
    };

    // Pattern tracking state
    this.mPatternState = this.createEmptyState('M');
    this.wPatternState = this.createEmptyState('W');
  }

  /**
   * Create empty pattern state
   * @param {string} type - 'M' | 'W'
   * @returns {Object}
   */
  createEmptyState(type) {
    return {
      type: type,
      stage: MWPatternDetector.STAGES.NONE,
      keyLevels: {},
      startCandle: null,
      startIndex: null,
      events: [],
      completionPct: 0
    };
  }

  /**
   * Reset pattern states
   */
  reset() {
    this.mPatternState = this.createEmptyState('M');
    this.wPatternState = this.createEmptyState('W');
  }

  /**
   * Main analysis method - detect both M and W patterns
   * @param {Object[]} candles - Candle array
   * @param {Object} structureAnalysis - From ICTStructureAnalyzer
   * @returns {Object|null} Best pattern found or null
   */
  analyze(candles, structureAnalysis) {
    if (!candles || candles.length < 20) {
      return null;
    }

    // Update both pattern detections
    this.detectMPattern(candles, structureAnalysis);
    this.detectWPattern(candles, structureAnalysis);

    // Return the pattern closest to completion
    if (this.mPatternState.completionPct > this.wPatternState.completionPct &&
        this.mPatternState.stage >= MWPatternDetector.STAGES.CHOCH) {
      return {
        ...this.mPatternState,
        signalType: 'M_PATTERN'
      };
    } else if (this.wPatternState.stage >= MWPatternDetector.STAGES.CHOCH) {
      return {
        ...this.wPatternState,
        signalType: 'W_PATTERN'
      };
    }

    return null;
  }

  /**
   * Detect M Pattern (Bearish Reversal)
   * @param {Object[]} candles
   * @param {Object} structureAnalysis
   */
  detectMPattern(candles, structureAnalysis) {
    const state = this.mPatternState;
    const currentCandle = candles[candles.length - 1];
    const swingHighs = structureAnalysis.choch ?
      structureAnalysis.choch.swingBroken ?
        [structureAnalysis.choch.swingBroken] : [] : [];

    // Check for timeout
    if (state.startIndex !== null &&
        candles.length - state.startIndex > this.options.patternTimeoutCandles) {
      this.mPatternState = this.createEmptyState('M');
      return;
    }

    switch (state.stage) {
      case MWPatternDetector.STAGES.NONE:
        // Look for key high (resistance level)
        if (structureAnalysis.swingHigh) {
          state.stage = MWPatternDetector.STAGES.KEY_LEVEL;
          state.keyLevels.keyHigh = structureAnalysis.swingHigh.price;
          state.keyLevels.keyHighCandle = structureAnalysis.swingHigh;
          state.startCandle = currentCandle;
          state.startIndex = candles.length - 1;
          state.events.push({
            stage: 'KEY_LEVEL',
            price: state.keyLevels.keyHigh,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 0.15;
        }
        break;

      case MWPatternDetector.STAGES.KEY_LEVEL:
        // Look for liquidity sweep (price goes above key high then reverses)
        if (currentCandle.high > state.keyLevels.keyHigh + this.options.sweepMinPenetration) {
          const penetration = currentCandle.high - state.keyLevels.keyHigh;
          if (penetration <= this.options.sweepMaxPenetration) {
            state.stage = MWPatternDetector.STAGES.LIQUIDITY_SWEEP;
            state.keyLevels.sweepHigh = currentCandle.high;
            state.events.push({
              stage: 'LIQUIDITY_SWEEP',
              price: currentCandle.high,
              timestamp: currentCandle.timestamp
            });
            state.completionPct = 0.30;
          }
        }
        break;

      case MWPatternDetector.STAGES.LIQUIDITY_SWEEP:
        // Look for bearish rejection (price closes back below the key high)
        if (currentCandle.close < state.keyLevels.keyHigh) {
          state.stage = MWPatternDetector.STAGES.FIRST_SHIFT;
          state.keyLevels.firstShiftCandle = currentCandle;
          state.events.push({
            stage: 'FIRST_SHIFT',
            price: currentCandle.close,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 0.45;
        }
        break;

      case MWPatternDetector.STAGES.FIRST_SHIFT:
        // Look for CHoCH (bearish change of character)
        if (structureAnalysis.choch && structureAnalysis.choch.type === 'bearish') {
          state.stage = MWPatternDetector.STAGES.CHOCH;
          state.keyLevels.choch = structureAnalysis.choch;
          state.events.push({
            stage: 'CHOCH',
            type: 'bearish',
            level: structureAnalysis.choch.level,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 0.60;
        }
        break;

      case MWPatternDetector.STAGES.CHOCH:
        // Look for MSS (bearish continuation)
        if (structureAnalysis.mss && structureAnalysis.mss.direction === 'bearish') {
          state.stage = MWPatternDetector.STAGES.SECOND_SHIFT;
          state.keyLevels.mss = structureAnalysis.mss;
          state.events.push({
            stage: 'SECOND_SHIFT',
            type: 'bearish_mss',
            level: structureAnalysis.mss.level,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 0.80;
        }
        break;

      case MWPatternDetector.STAGES.SECOND_SHIFT:
        // Look for retest zone (order block or FVG)
        const bearishOB = structureAnalysis.orderBlocks.find(ob =>
          ob.type === 'bearish' && !ob.mitigated
        );
        if (bearishOB) {
          state.stage = MWPatternDetector.STAGES.AWAITING_RETEST;
          state.keyLevels.entryZone = bearishOB;
          state.keyLevels.stopLevel = state.keyLevels.sweepHigh + 3; // Above sweep high
          state.events.push({
            stage: 'AWAITING_RETEST',
            entryZone: bearishOB,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 1.0;
        }
        break;
    }
  }

  /**
   * Detect W Pattern (Bullish Reversal)
   * @param {Object[]} candles
   * @param {Object} structureAnalysis
   */
  detectWPattern(candles, structureAnalysis) {
    const state = this.wPatternState;
    const currentCandle = candles[candles.length - 1];

    // Check for timeout
    if (state.startIndex !== null &&
        candles.length - state.startIndex > this.options.patternTimeoutCandles) {
      this.wPatternState = this.createEmptyState('W');
      return;
    }

    switch (state.stage) {
      case MWPatternDetector.STAGES.NONE:
        // Look for key low (support level)
        if (structureAnalysis.swingLow) {
          state.stage = MWPatternDetector.STAGES.KEY_LEVEL;
          state.keyLevels.keyLow = structureAnalysis.swingLow.price;
          state.keyLevels.keyLowCandle = structureAnalysis.swingLow;
          state.startCandle = currentCandle;
          state.startIndex = candles.length - 1;
          state.events.push({
            stage: 'KEY_LEVEL',
            price: state.keyLevels.keyLow,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 0.15;
        }
        break;

      case MWPatternDetector.STAGES.KEY_LEVEL:
        // Look for liquidity sweep (price goes below key low then reverses)
        if (currentCandle.low < state.keyLevels.keyLow - this.options.sweepMinPenetration) {
          const penetration = state.keyLevels.keyLow - currentCandle.low;
          if (penetration <= this.options.sweepMaxPenetration) {
            state.stage = MWPatternDetector.STAGES.LIQUIDITY_SWEEP;
            state.keyLevels.sweepLow = currentCandle.low;
            state.events.push({
              stage: 'LIQUIDITY_SWEEP',
              price: currentCandle.low,
              timestamp: currentCandle.timestamp
            });
            state.completionPct = 0.30;
          }
        }
        break;

      case MWPatternDetector.STAGES.LIQUIDITY_SWEEP:
        // Look for bullish rejection (price closes back above the key low)
        if (currentCandle.close > state.keyLevels.keyLow) {
          state.stage = MWPatternDetector.STAGES.FIRST_SHIFT;
          state.keyLevels.firstShiftCandle = currentCandle;
          state.events.push({
            stage: 'FIRST_SHIFT',
            price: currentCandle.close,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 0.45;
        }
        break;

      case MWPatternDetector.STAGES.FIRST_SHIFT:
        // Look for CHoCH (bullish change of character)
        if (structureAnalysis.choch && structureAnalysis.choch.type === 'bullish') {
          state.stage = MWPatternDetector.STAGES.CHOCH;
          state.keyLevels.choch = structureAnalysis.choch;
          state.events.push({
            stage: 'CHOCH',
            type: 'bullish',
            level: structureAnalysis.choch.level,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 0.60;
        }
        break;

      case MWPatternDetector.STAGES.CHOCH:
        // Look for MSS (bullish continuation)
        if (structureAnalysis.mss && structureAnalysis.mss.direction === 'bullish') {
          state.stage = MWPatternDetector.STAGES.SECOND_SHIFT;
          state.keyLevels.mss = structureAnalysis.mss;
          state.events.push({
            stage: 'SECOND_SHIFT',
            type: 'bullish_mss',
            level: structureAnalysis.mss.level,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 0.80;
        }
        break;

      case MWPatternDetector.STAGES.SECOND_SHIFT:
        // Look for retest zone (order block or FVG)
        const bullishOB = structureAnalysis.orderBlocks.find(ob =>
          ob.type === 'bullish' && !ob.mitigated
        );
        if (bullishOB) {
          state.stage = MWPatternDetector.STAGES.AWAITING_RETEST;
          state.keyLevels.entryZone = bullishOB;
          state.keyLevels.stopLevel = state.keyLevels.sweepLow - 3; // Below sweep low
          state.events.push({
            stage: 'AWAITING_RETEST',
            entryZone: bullishOB,
            timestamp: currentCandle.timestamp
          });
          state.completionPct = 1.0;
        }
        break;
    }
  }

  /**
   * Check if price has retested entry zone for pattern completion
   * @param {Object} candle - Current candle
   * @param {Object} pattern - Pattern state
   * @returns {Object|null} Entry signal or null
   */
  checkPatternEntry(candle, pattern) {
    if (!pattern || pattern.stage !== MWPatternDetector.STAGES.AWAITING_RETEST) {
      return null;
    }

    const entryZone = pattern.keyLevels.entryZone;
    if (!entryZone) return null;

    if (pattern.type === 'M') {
      // For M pattern (bearish), look for price rallying into the zone
      if (candle.high >= entryZone.low && candle.close < entryZone.high) {
        return {
          side: 'sell',
          entryPrice: candle.close,
          stopLoss: pattern.keyLevels.stopLevel,
          target: pattern.keyLevels.keyLow || candle.low - 50, // Target the key low
          pattern: pattern
        };
      }
    } else if (pattern.type === 'W') {
      // For W pattern (bullish), look for price dipping into the zone
      if (candle.low <= entryZone.high && candle.close > entryZone.low) {
        return {
          side: 'buy',
          entryPrice: candle.close,
          stopLoss: pattern.keyLevels.stopLevel,
          target: pattern.keyLevels.keyHigh || candle.high + 50, // Target the key high
          pattern: pattern
        };
      }
    }

    return null;
  }

  /**
   * Get current pattern states
   * @returns {Object}
   */
  getState() {
    return {
      mPattern: this.mPatternState,
      wPattern: this.wPatternState,
      activePatterType: this.getActivePatternType()
    };
  }

  /**
   * Get the type of the most advanced active pattern
   * @returns {string|null}
   */
  getActivePatternType() {
    if (this.mPatternState.stage > this.wPatternState.stage &&
        this.mPatternState.stage >= MWPatternDetector.STAGES.CHOCH) {
      return 'M';
    } else if (this.wPatternState.stage >= MWPatternDetector.STAGES.CHOCH) {
      return 'W';
    }
    return null;
  }
}

export default MWPatternDetector;
