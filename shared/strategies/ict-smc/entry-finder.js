/**
 * ICT Entry Finder
 *
 * Scans lower timeframe (LTF) candles for precise entry conditions
 * when higher timeframe (HTF) structure conditions are met.
 *
 * Entry triggers:
 * - FVG fill: Price taps into a fair value gap
 * - Order Block retest: Price returns to an OB zone (with optional LTF confirmation)
 * - LTF CHoCH: Change of character on lower timeframe
 * - Fibonacci retest: Price reaches key fib level (50%, 62%, 70.5%, 79%)
 *
 * LTF Confirmation (when enabled):
 * Instead of entering immediately on OB touch, waits for:
 * - Sweep + reclaim: Price sweeps below OB then closes back inside
 * - Bullish pattern: Hammer, engulfing within OB zone
 */

import { ImbalanceDetector } from '../../strategies/imbalance-detector.js';
import { LTFConfirmation } from './ltf-confirmation.js';

export class ICTEntryFinder {
  constructor(options = {}) {
    this.options = {
      // Entry parameters
      maxEntryDistance: options.maxEntryDistance || 50,       // Max points from entry zone
      minRiskReward: options.minRiskReward || 1.5,            // Min R:R for valid entry

      // Entry triggers to use
      entryTriggers: options.entryTriggers || ['fvg_fill', 'ob_retest', 'choch_ltf', 'fib_retest'],

      // Fibonacci levels for entry
      fibEntryLevels: options.fibEntryLevels || [0.5, 0.618, 0.705, 0.786],
      fibProximityPoints: options.fibProximityPoints || 5,

      // FVG settings
      minFVGSize: options.minFVGSize || 5,
      maxFVGAge: options.maxFVGAge || 24,                     // Hours

      // Confirmation settings
      requireCandleConfirmation: options.requireCandleConfirmation !== false,

      // LTF Confirmation settings (for OB retest entries)
      ltfConfirmation: {
        enabled: options.ltfConfirmation?.enabled !== false,  // Default: enabled
        timeoutCandles: options.ltfConfirmation?.timeoutCandles || 15,
        minWickToBodyRatio: options.ltfConfirmation?.minWickToBodyRatio || 2.0,
        stopBuffer: options.ltfConfirmation?.stopBuffer || 3,
        ...(options.ltfConfirmation || {})
      },

      // Range context filter settings
      // Prevents countertrend entries at range extremes
      rangeFilterEnabled: options.rangeFilterEnabled === true,   // Default: disabled (must explicitly enable)
      rangeExclusionZone: options.rangeExclusionZone || 0.20,    // Don't short in bottom 20%, don't long in top 20%

      ...options
    };

    // Initialize FVG detector
    this.fvgDetector = new ImbalanceDetector({
      minGapSize: this.options.minFVGSize,
      maxGapAge: this.options.maxFVGAge
    });

    // Initialize LTF confirmation module
    this.ltfConfirmation = new LTFConfirmation(this.options.ltfConfirmation);

    // State
    this.ltfSwingHighs = [];
    this.ltfSwingLows = [];
  }

  /**
   * Find entry on LTF when HTF conditions are met
   * @param {Object[]} ltfCandles - Lower timeframe candles (e.g., 5m)
   * @param {Object} htfAnalysis - Analysis from 4H timeframe
   * @param {Object|null} pattern - Active M/W pattern if any
   * @returns {Object|null} Entry signal or null
   */
  findEntry(ltfCandles, htfAnalysis, pattern = null) {
    if (!ltfCandles || ltfCandles.length < 10) {
      return null;
    }

    if (!htfAnalysis || !htfAnalysis.bias || htfAnalysis.bias === 'neutral') {
      return null;
    }

    const currentCandle = ltfCandles[ltfCandles.length - 1];
    const prevCandle = ltfCandles[ltfCandles.length - 2];
    const currentTime = currentCandle.timestamp;

    // Detect LTF FVGs
    const fvgs = this.fvgDetector.detectFairValueGaps(ltfCandles, 50, currentTime);
    this.fvgDetector.updateFillStatus(fvgs, ltfCandles.slice(-20));

    // Detect LTF swing points
    this.updateLTFSwings(ltfCandles);

    // Check entry triggers based on HTF bias
    if (htfAnalysis.bias === 'bullish') {
      return this.findLongEntry(ltfCandles, htfAnalysis, fvgs, pattern, currentCandle, prevCandle);
    } else {
      return this.findShortEntry(ltfCandles, htfAnalysis, fvgs, pattern, currentCandle, prevCandle);
    }
  }

  /**
   * Find long entry
   * @param {Object[]} ltfCandles
   * @param {Object} htfAnalysis
   * @param {Object[]} fvgs
   * @param {Object|null} pattern
   * @param {Object} currentCandle
   * @param {Object} prevCandle
   * @returns {Object|null}
   */
  findLongEntry(ltfCandles, htfAnalysis, fvgs, pattern, currentCandle, prevCandle) {
    const triggers = this.options.entryTriggers;
    let entry = null;

    // 1. Check for Order Block retest
    if (triggers.includes('ob_retest') && htfAnalysis.orderBlocks) {
      entry = this.checkOBRetest(currentCandle, htfAnalysis.orderBlocks, 'bullish', {
        candlesSinceOB: ltfCandles  // Pass LTF candles for range context calculation
      });
      if (entry) {
        entry.trigger = 'ob_retest';
        entry.side = 'buy';

        // If status is 'watching', return immediately for strategy to handle
        if (entry.status === 'watching') {
          entry = this.enrichEntry(entry, htfAnalysis, pattern, currentCandle);
          return entry;
        }
      }
    }

    // 2. Check for FVG fill
    if (!entry && triggers.includes('fvg_fill')) {
      entry = this.checkFVGFill(currentCandle, fvgs, 'bullish');
      if (entry) {
        entry.trigger = 'fvg_fill';
        entry.side = 'buy';
        entry.status = 'entry';
      }
    }

    // 3. Check for Fibonacci retest
    if (!entry && triggers.includes('fib_retest') && htfAnalysis.swingHigh && htfAnalysis.swingLow) {
      entry = this.checkFibRetest(currentCandle, htfAnalysis.swingHigh.price,
                                   htfAnalysis.swingLow.price, 'bullish');
      if (entry) {
        entry.trigger = 'fib_retest';
        entry.side = 'buy';
        entry.status = 'entry';
      }
    }

    // 4. Check for LTF CHoCH
    if (!entry && triggers.includes('choch_ltf')) {
      entry = this.checkLTFCHoCH(ltfCandles, 'bullish');
      if (entry) {
        entry.trigger = 'choch_ltf';
        entry.side = 'buy';
        entry.status = 'entry';
      }
    }

    // Add HTF context to entry
    if (entry && entry.status === 'entry') {
      entry = this.enrichEntry(entry, htfAnalysis, pattern, currentCandle);

      // Validate entry
      if (!this.validateEntry(entry, htfAnalysis)) {
        return null;
      }
    }

    return entry;
  }

  /**
   * Find short entry
   * @param {Object[]} ltfCandles
   * @param {Object} htfAnalysis
   * @param {Object[]} fvgs
   * @param {Object|null} pattern
   * @param {Object} currentCandle
   * @param {Object} prevCandle
   * @returns {Object|null}
   */
  findShortEntry(ltfCandles, htfAnalysis, fvgs, pattern, currentCandle, prevCandle) {
    const triggers = this.options.entryTriggers;
    let entry = null;

    // 1. Check for Order Block retest
    if (triggers.includes('ob_retest') && htfAnalysis.orderBlocks) {
      entry = this.checkOBRetest(currentCandle, htfAnalysis.orderBlocks, 'bearish', {
        candlesSinceOB: ltfCandles  // Pass LTF candles for range context calculation
      });
      if (entry) {
        entry.trigger = 'ob_retest';
        entry.side = 'sell';

        // If status is 'watching', return immediately for strategy to handle
        if (entry.status === 'watching') {
          entry = this.enrichEntry(entry, htfAnalysis, pattern, currentCandle);
          return entry;
        }
      }
    }

    // 2. Check for FVG fill
    if (!entry && triggers.includes('fvg_fill')) {
      entry = this.checkFVGFill(currentCandle, fvgs, 'bearish');
      if (entry) {
        entry.trigger = 'fvg_fill';
        entry.side = 'sell';
        entry.status = 'entry';
      }
    }

    // 3. Check for Fibonacci retest
    if (!entry && triggers.includes('fib_retest') && htfAnalysis.swingHigh && htfAnalysis.swingLow) {
      entry = this.checkFibRetest(currentCandle, htfAnalysis.swingHigh.price,
                                   htfAnalysis.swingLow.price, 'bearish');
      if (entry) {
        entry.trigger = 'fib_retest';
        entry.side = 'sell';
        entry.status = 'entry';
      }
    }

    // 4. Check for LTF CHoCH
    if (!entry && triggers.includes('choch_ltf')) {
      entry = this.checkLTFCHoCH(ltfCandles, 'bearish');
      if (entry) {
        entry.trigger = 'choch_ltf';
        entry.side = 'sell';
        entry.status = 'entry';
      }
    }

    // Add HTF context to entry
    if (entry && entry.status === 'entry') {
      entry = this.enrichEntry(entry, htfAnalysis, pattern, currentCandle);

      // Validate entry
      if (!this.validateEntry(entry, htfAnalysis)) {
        return null;
      }
    }

    return entry;
  }

  /**
   * Check for Order Block retest
   * @param {Object} candle
   * @param {Object[]} orderBlocks
   * @param {string} type - 'bullish' | 'bearish'
   * @param {Object} options - Additional options
   * @param {boolean} options.useLTFConfirmation - Whether to use LTF confirmation (overrides default)
   * @param {Object[]} options.candlesSinceOB - Candles since OB formation for range context filter
   * @returns {Object|null}
   */
  checkOBRetest(candle, orderBlocks, type, options = {}) {
    const relevantOBs = orderBlocks.filter(ob => ob.type === type && !ob.mitigated);
    const candlesSinceOB = options.candlesSinceOB || null;
    // Minimum OB size - too small OBs are noise
    const minOBSize = this.options.minOBSize || 10;
    // Maximum OB size - too large OBs put stop inside zone
    const maxOBSize = this.options.maxOBSize || 50;
    // Stop buffer - ensure candle hasn't already violated stop zone
    const stopBuffer = this.options.obStopBuffer || 25;

    // Determine if LTF confirmation is enabled
    const useLTFConfirmation = options.useLTFConfirmation !== undefined
      ? options.useLTFConfirmation
      : this.options.ltfConfirmation?.enabled;

    for (const ob of relevantOBs) {
      const obSize = ob.high - ob.low;

      // Skip OBs that are too small or too large
      if (obSize < minOBSize || obSize > maxOBSize) {
        continue;
      }

      // Calculate OB midpoint (50% level) for entry
      const obMidpoint = ob.low + (ob.high - ob.low) * 0.5;

      // Check if price is in OB zone
      const inZone = type === 'bullish'
        ? candle.low <= ob.high && candle.high >= ob.low
        : candle.high >= ob.low && candle.low <= ob.high;

      if (!inZone) continue;

      if (type === 'bullish') {
        // For bullish OB, price should dip into the zone
        if (candle.low <= ob.high && candle.close > ob.low) {
          // Check range context filter - don't long at range highs
          const rangeCheck = this.checkRangeContext('buy', candle.close, ob, candlesSinceOB);
          if (!rangeCheck.passes) {
            continue; // Skip this OB due to range context
          }

          // If LTF confirmation enabled, return "watching" status instead of entry
          if (useLTFConfirmation) {
            return {
              status: 'watching',
              orderBlock: ob,
              entryType: 'ob_retest_ltf',
              side: 'buy',
              rangeContext: rangeCheck
            };
          }

          // Original behavior: immediate entry at OB midpoint with bullish candle confirmation
          if (this.isBullishCandle(candle)) {
            return {
              status: 'entry',
              price: obMidpoint,  // Enter at 50% of OB
              orderBlock: ob,
              entryType: 'ob_retest',
              rangeContext: rangeCheck
            };
          }
        }
      } else {
        // For bearish OB, price should rally into the zone
        if (candle.high >= ob.low && candle.close < ob.high) {
          // Check range context filter - don't short at range lows
          const rangeCheck = this.checkRangeContext('sell', candle.close, ob, candlesSinceOB);
          if (!rangeCheck.passes) {
            continue; // Skip this OB due to range context
          }

          // If LTF confirmation enabled, return "watching" status instead of entry
          if (useLTFConfirmation) {
            return {
              status: 'watching',
              orderBlock: ob,
              entryType: 'ob_retest_ltf',
              side: 'sell',
              rangeContext: rangeCheck
            };
          }

          // Original behavior: immediate entry at OB midpoint with bearish candle confirmation
          if (this.isBearishCandle(candle)) {
            return {
              status: 'entry',
              price: obMidpoint,  // Enter at 50% of OB
              orderBlock: ob,
              entryType: 'ob_retest',
              rangeContext: rangeCheck
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Get the LTF confirmation module (for external use by strategy)
   * @returns {LTFConfirmation}
   */
  getLTFConfirmation() {
    return this.ltfConfirmation;
  }

  /**
   * Check if currently watching an OB for LTF confirmation
   * @returns {boolean}
   */
  isWatchingOB() {
    return this.ltfConfirmation.isWatching();
  }

  /**
   * Start watching an OB for LTF confirmation
   * @param {Object} orderBlock
   * @param {string} side - 'buy' or 'sell'
   * @param {number} candleIndex
   */
  startWatchingOB(orderBlock, side, candleIndex) {
    this.ltfConfirmation.startWatching(orderBlock, side, candleIndex);
  }

  /**
   * Check for LTF confirmation on the watched OB
   * @param {Object} candle - Current 1m candle
   * @param {number} candleIndex
   * @returns {Object} Confirmation result
   */
  checkOBConfirmation(candle, candleIndex) {
    return this.ltfConfirmation.checkConfirmation(candle, candleIndex);
  }

  /**
   * Reset LTF confirmation watching state
   */
  resetOBWatch() {
    this.ltfConfirmation.reset();
  }

  /**
   * Check range context to prevent countertrend entries at range extremes
   * Don't short at range lows, don't long at range highs
   *
   * @param {string} side - 'buy' or 'sell'
   * @param {number} currentPrice - Current price
   * @param {Object} ob - The order block
   * @param {Object[]} allCandles - All available candles (will be filtered by OB timestamp)
   * @returns {Object} { passes: boolean, pricePosition: number, rangeHigh: number, rangeLow: number, reason: string|null }
   */
  checkRangeContext(side, currentPrice, ob, allCandles) {
    // If filter is disabled, always pass
    if (!this.options.rangeFilterEnabled) {
      return { passes: true, pricePosition: null, rangeHigh: null, rangeLow: null, reason: null };
    }

    // Need candles to calculate range
    if (!allCandles || allCandles.length === 0) {
      return { passes: true, pricePosition: null, rangeHigh: null, rangeLow: null, reason: 'no_candles' };
    }

    // Filter to only candles since OB formation
    const obTimestamp = ob.timestamp;
    const candlesSinceOB = allCandles.filter(c => c.timestamp > obTimestamp);

    // Need at least a few candles to establish meaningful range
    if (candlesSinceOB.length < 3) {
      return { passes: true, pricePosition: null, rangeHigh: null, rangeLow: null, reason: 'insufficient_candles' };
    }

    // Calculate range from candles since OB formed
    const rangeHigh = Math.max(...candlesSinceOB.map(c => c.high));
    const rangeLow = Math.min(...candlesSinceOB.map(c => c.low));
    const rangeSize = rangeHigh - rangeLow;

    // If range is too small, skip filter
    if (rangeSize < 5) {
      return { passes: true, pricePosition: null, rangeHigh, rangeLow, reason: 'range_too_small' };
    }

    // Calculate price position within range (0 = range low, 1 = range high)
    const pricePosition = (currentPrice - rangeLow) / rangeSize;
    const exclusion = this.options.rangeExclusionZone;

    // For shorts: reject if price is in bottom exclusion zone (countertrend at range low)
    if (side === 'sell' && pricePosition < exclusion) {
      return {
        passes: false,
        pricePosition,
        rangeHigh,
        rangeLow,
        reason: `short_at_range_low (position: ${(pricePosition * 100).toFixed(1)}%)`
      };
    }

    // For longs: reject if price is in top exclusion zone (countertrend at range high)
    if (side === 'buy' && pricePosition > (1 - exclusion)) {
      return {
        passes: false,
        pricePosition,
        rangeHigh,
        rangeLow,
        reason: `long_at_range_high (position: ${(pricePosition * 100).toFixed(1)}%)`
      };
    }

    return { passes: true, pricePosition, rangeHigh, rangeLow, reason: null };
  }

  /**
   * Check for FVG fill
   * @param {Object} candle
   * @param {Object[]} fvgs
   * @param {string} type - 'bullish' | 'bearish'
   * @returns {Object|null}
   */
  checkFVGFill(candle, fvgs, type) {
    // For bullish entry, we want bearish FVGs below price (price fills them going down)
    // For bearish entry, we want bullish FVGs above price (price fills them going up)
    const targetFVGType = type === 'bullish' ? 'bearish_fvg' : 'bullish_fvg';

    const relevantFVGs = fvgs.filter(fvg =>
      fvg.type === targetFVGType && !fvg.filled && fvg.fill_percentage < 0.8
    );

    // Maximum FVG size - larger FVGs mean entry is too far from zone boundary
    // With 30pt stops and 50% entry, FVG > 40pts puts stop inside the zone
    const maxFVGSize = this.options.maxFVGSize || 40;

    for (const fvg of relevantFVGs) {
      const fvgSize = fvg.top - fvg.bottom;

      // Skip FVGs that are too large - stop would be inside the zone
      if (fvgSize > maxFVGSize) {
        continue;
      }

      // Calculate FVG midpoint (50% level) for entry
      const fvgMidpoint = fvg.bottom + (fvg.top - fvg.bottom) * 0.5;

      if (type === 'bullish') {
        // Price should tap into bearish FVG from above
        // FVG midpoint must be BELOW current price for a valid BUY limit order
        // Also check that candle didn't already wick through the FVG bottom (stop zone)
        if (candle.low <= fvg.top && candle.close > fvg.bottom &&
            fvgMidpoint <= candle.close && candle.low > fvg.bottom - 10) {
          if (this.isBullishCandle(candle)) {
            return {
              price: fvgMidpoint,  // Enter at 50% of FVG
              fvg: fvg,
              entryType: 'fvg_fill'
            };
          }
        }
      } else {
        // Price should tap into bullish FVG from below
        // FVG midpoint must be ABOVE current price for a valid SELL limit order
        // Also check that candle didn't already wick through the FVG top (stop zone)
        if (candle.high >= fvg.bottom && candle.close < fvg.top &&
            fvgMidpoint >= candle.close && candle.high < fvg.top + 10) {
          if (this.isBearishCandle(candle)) {
            return {
              price: fvgMidpoint,  // Enter at 50% of FVG
              fvg: fvg,
              entryType: 'fvg_fill'
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Check for Fibonacci level retest
   * @param {Object} candle
   * @param {number} swingHigh
   * @param {number} swingLow
   * @param {string} type - 'bullish' | 'bearish'
   * @returns {Object|null}
   */
  checkFibRetest(candle, swingHigh, swingLow, type) {
    const range = swingHigh - swingLow;
    if (range < this.options.minFVGSize * 2) return null;

    for (const ratio of this.options.fibEntryLevels) {
      let fibLevel;

      if (type === 'bullish') {
        // For bullish, fib levels are measured from low to high
        // Entry at discount (below 50%)
        fibLevel = swingHigh - (range * ratio);

        // Check if price is at this fib level
        if (Math.abs(candle.low - fibLevel) <= this.options.fibProximityPoints) {
          if (this.isBullishCandle(candle)) {
            return {
              price: candle.close,
              fibLevel: ratio,
              fibPrice: fibLevel,
              entryType: 'fib_retest'
            };
          }
        }
      } else {
        // For bearish, entry at premium (above 50%)
        fibLevel = swingLow + (range * ratio);

        // Check if price is at this fib level
        if (Math.abs(candle.high - fibLevel) <= this.options.fibProximityPoints) {
          if (this.isBearishCandle(candle)) {
            return {
              price: candle.close,
              fibLevel: ratio,
              fibPrice: fibLevel,
              entryType: 'fib_retest'
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Check for LTF Change of Character
   * @param {Object[]} candles
   * @param {string} type - 'bullish' | 'bearish'
   * @returns {Object|null}
   */
  checkLTFCHoCH(candles, type) {
    if (candles.length < 10) return null;

    const currentCandle = candles[candles.length - 1];
    // Buffer to ensure candle range doesn't already violate stop zone
    const stopBuffer = this.options.chochStopBuffer || 25;

    if (type === 'bullish') {
      // Look for break above recent LTF swing high
      if (this.ltfSwingHighs.length > 0) {
        const recentHigh = this.ltfSwingHighs[this.ltfSwingHighs.length - 1];
        // Ensure candle low is not too far below entry (would violate stop zone)
        const candleRange = currentCandle.close - currentCandle.low;
        if (currentCandle.close > recentHigh.price &&
            this.isBullishCandle(currentCandle) &&
            candleRange < stopBuffer) {
          return {
            price: currentCandle.close,
            swingBroken: recentHigh,
            entryType: 'choch_ltf'
          };
        }
      }
    } else {
      // Look for break below recent LTF swing low
      if (this.ltfSwingLows.length > 0) {
        const recentLow = this.ltfSwingLows[this.ltfSwingLows.length - 1];
        // Ensure candle high is not too far above entry (would violate stop zone)
        const candleRange = currentCandle.high - currentCandle.close;
        if (currentCandle.close < recentLow.price &&
            this.isBearishCandle(currentCandle) &&
            candleRange < stopBuffer) {
          return {
            price: currentCandle.close,
            swingBroken: recentLow,
            entryType: 'choch_ltf'
          };
        }
      }
    }

    return null;
  }

  /**
   * Update LTF swing points
   * @param {Object[]} candles
   */
  updateLTFSwings(candles) {
    const lookback = 3; // Smaller lookback for LTF

    this.ltfSwingHighs = [];
    this.ltfSwingLows = [];

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
      }

      if (isSwingHigh) {
        this.ltfSwingHighs.push({
          index: i,
          price: current.high,
          timestamp: current.timestamp
        });
      }
      if (isSwingLow) {
        this.ltfSwingLows.push({
          index: i,
          price: current.low,
          timestamp: current.timestamp
        });
      }
    }

    // Keep only recent swings
    this.ltfSwingHighs = this.ltfSwingHighs.slice(-5);
    this.ltfSwingLows = this.ltfSwingLows.slice(-5);
  }

  /**
   * Enrich entry with HTF context
   * @param {Object} entry
   * @param {Object} htfAnalysis
   * @param {Object|null} pattern
   * @param {Object} currentCandle
   * @returns {Object}
   */
  enrichEntry(entry, htfAnalysis, pattern, currentCandle) {
    return {
      ...entry,
      timestamp: currentCandle.timestamp,
      htfBias: htfAnalysis.bias,
      htfConfidence: htfAnalysis.confidence,
      structureLevel: htfAnalysis.structureLevel,
      pattern: pattern ? {
        type: pattern.type,
        stage: pattern.stage,
        completionPct: pattern.completionPct
      } : null
    };
  }

  /**
   * Validate entry
   * @param {Object} entry
   * @param {Object} htfAnalysis
   * @returns {boolean}
   */
  validateEntry(entry, htfAnalysis) {
    // Check max entry distance
    if (htfAnalysis.structureLevel) {
      const stopDistance = Math.abs(entry.price - htfAnalysis.structureLevel.price);
      if (stopDistance > this.options.maxEntryDistance) {
        return false;
      }
    }

    // Check candle confirmation if required
    if (this.options.requireCandleConfirmation) {
      if (entry.side === 'buy' && !this.isBullishCandle({ close: entry.price, open: entry.price - 1 })) {
        // Skip - already checked in individual methods
      }
    }

    return true;
  }

  /**
   * Check if candle is bullish
   * @param {Object} candle
   * @returns {boolean}
   */
  isBullishCandle(candle) {
    return candle.close > candle.open;
  }

  /**
   * Check if candle is bearish
   * @param {Object} candle
   * @returns {boolean}
   */
  isBearishCandle(candle) {
    return candle.close < candle.open;
  }
}

export default ICTEntryFinder;
