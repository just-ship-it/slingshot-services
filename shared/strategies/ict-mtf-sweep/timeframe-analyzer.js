/**
 * Timeframe Analyzer
 *
 * Per-timeframe incremental ICT analysis engine. One instance per active
 * timeframe. Follows the Silver Bullet's proven incremental pattern:
 * - Swing detection with configurable lookback
 * - Structure shift (combined CHoCH + MSS)
 * - FVG scanning (3-candle gap)
 * - Order Block detection (last opposite candle before impulse)
 *
 * All operations are O(1) per candle (incremental, not full-array rescan).
 */

export class TimeframeAnalyzer {
  constructor(params = {}) {
    this.timeframe = params.timeframe || '1m';
    this.swingLookback = params.swingLookback ?? 5;
    this.minFVGSize = params.minFVGSize ?? 3;
    this.minSwingSize = params.minSwingSize ?? 5;
    this.breakConfirmation = params.breakConfirmation ?? 2;
    this.maxBufferSize = params.maxBufferSize ?? 200;

    // Rolling candle buffer
    this.candles = [];

    // Confirmed swings
    this.swingHighs = []; // { price, timestamp, bufIdx }
    this.swingLows = [];

    // Active FVGs (unfilled)
    this.activeFVGs = [];
    this.maxFVGAge = params.maxFVGAge ?? 100; // candles

    // Active Order Blocks (unmitigated)
    this.activeOBs = [];
    this.maxOBAge = params.maxOBAge ?? 100;

    // Structure state
    this.trend = null;           // 'bullish' | 'bearish' | null
    this.lastStructureShift = null; // { type, level, timestamp, direction }

    // Level-based dedup for structure shifts (replaces trend lock)
    this.lastBullishBreak = null;
    this.lastBearishBreak = null;

    // Swing sequence with creatingSwing relationships
    this.swingSequence = []; // ordered [{type, price, timestamp, bufIdx, creatingSwing}]

    // Pending CHoCH awaiting MSS confirmation
    this.pendingCHoCH = null;

    // Filled + rejected FVGs for momentum continuation
    this.filledRejectedFVGs = [];

    // Tracking for incremental detection
    this.candleCount = 0;
    this.lastSwingScanIdx = -1;
  }

  reset() {
    this.candles = [];
    this.swingHighs = [];
    this.swingLows = [];
    this.activeFVGs = [];
    this.activeOBs = [];
    this.trend = null;
    this.lastStructureShift = null;
    this.lastBullishBreak = null;
    this.lastBearishBreak = null;
    this.swingSequence = [];
    this.pendingCHoCH = null;
    this.filledRejectedFVGs = [];
    this.candleCount = 0;
    this.lastSwingScanIdx = -1;
  }

  /**
   * Process a new completed candle for this timeframe.
   * Returns events detected on this candle.
   *
   * @param {Object} candle - { timestamp, open, high, low, close, volume }
   * @returns {Object} { newSwings, structureShift, newFVGs, newOBs, trend }
   */
  processCandle(candle) {
    this.candles.push(candle);
    this.candleCount++;

    // Trim buffer
    if (this.candles.length > this.maxBufferSize) {
      const trimCount = this.candles.length - this.maxBufferSize;
      this.candles = this.candles.slice(trimCount);
      // Adjust swing bufIdx references
      this.swingHighs = this.swingHighs
        .map(s => ({ ...s, bufIdx: s.bufIdx - trimCount }))
        .filter(s => s.bufIdx >= 0);
      this.swingLows = this.swingLows
        .map(s => ({ ...s, bufIdx: s.bufIdx - trimCount }))
        .filter(s => s.bufIdx >= 0);
      this.lastSwingScanIdx = Math.max(-1, this.lastSwingScanIdx - trimCount);
    }

    const result = {
      newSwings: [],
      structureShift: null,   // Confirmed shift (CHoCH+MSS or BOS)
      chochEvent: null,       // CHoCH-only (pending MSS)
      bosEvent: null,         // Break of structure (continuation)
      newFVGs: [],
      newOBs: [],
      filledRejections: [],   // FVGs that filled then rejected (momentum continuation)
      trend: this.trend,
    };

    // Need minimum candles for swing detection
    if (this.candles.length < this.swingLookback * 2 + 1) return result;

    // 1. Detect new swings and build creatingSwing relationships
    const newSwings = this._detectNewSwings();
    result.newSwings = newSwings;

    // 2. Check for CHoCH (reversal signal)
    const choch = this._detectCHoCH(candle);
    if (choch) {
      result.chochEvent = choch;
      // Displacement fallback: if break is 3x normal confirmation, immediate shift
      const breakStrength = Math.abs(candle.close - choch.level);
      if (breakStrength >= this.breakConfirmation * 3) {
        // Strong displacement = immediate CHoCH+MSS
        const shift = this._promoteCHoCHToShift(choch, candle);
        result.structureShift = shift;
        this.pendingCHoCH = null;
      }
    }

    // 3. Check for MSS confirmation of pending CHoCH
    if (!result.structureShift && this.pendingCHoCH) {
      const mss = this._detectMSS(candle, this.pendingCHoCH);
      if (mss) {
        result.structureShift = mss;
        this.pendingCHoCH = null;
      } else if (this._isCHoCHInvalidated(candle, this.pendingCHoCH)) {
        this.pendingCHoCH = null;
      }
    }

    // 4. Check for BOS (continuation breaks)
    const bos = this._detectBOS(candle);
    if (bos) {
      result.bosEvent = bos;
      // BOS also counts as a structure shift for setup advancement
      if (!result.structureShift) {
        result.structureShift = bos;
      }
    }

    // 5. Scan for new FVGs (last 3 candles)
    const newFVGs = this._scanFVG();
    result.newFVGs = newFVGs;

    // 6. Detect Order Blocks
    const newOBs = this._detectOB();
    result.newOBs = newOBs;

    // 7. Expire old FVGs and OBs; mark filled/mitigated; track rejections
    const rejections = this._expireAndFill(candle);
    result.filledRejections = rejections;

    result.trend = this.trend;
    return result;
  }

  // ── Swing Detection ─────────────────────────────────────────

  _detectNewSwings() {
    const buf = this.candles;
    const lb = this.swingLookback;
    const newSwings = [];

    // Only check the candle at position buf.length - 1 - lb
    // (the one that just got enough right-side bars for confirmation)
    const checkIdx = buf.length - 1 - lb;
    if (checkIdx < lb || checkIdx <= this.lastSwingScanIdx) return newSwings;

    this.lastSwingScanIdx = checkIdx;

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lb; j++) {
      if (buf[checkIdx - j].high >= buf[checkIdx].high || buf[checkIdx + j].high >= buf[checkIdx].high) isHigh = false;
      if (buf[checkIdx - j].low <= buf[checkIdx].low || buf[checkIdx + j].low <= buf[checkIdx].low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh && buf[checkIdx].high - buf[checkIdx].low >= this.minSwingSize * 0.5) {
      // Find creatingSwing: the most recent opposite (low) swing
      const creatingSwing = this._findCreatingSwing('high');
      const swing = {
        price: buf[checkIdx].high,
        timestamp: buf[checkIdx].timestamp,
        bufIdx: checkIdx,
        swingType: 'high',
        creatingSwing,
      };
      this.swingHighs.push(swing);
      this.swingSequence.push(swing);
      newSwings.push({ type: 'high', ...swing });
      // Keep bounded
      if (this.swingHighs.length > 50) this.swingHighs = this.swingHighs.slice(-50);
    }

    if (isLow && buf[checkIdx].high - buf[checkIdx].low >= this.minSwingSize * 0.5) {
      // Find creatingSwing: the most recent opposite (high) swing
      const creatingSwing = this._findCreatingSwing('low');
      const swing = {
        price: buf[checkIdx].low,
        timestamp: buf[checkIdx].timestamp,
        bufIdx: checkIdx,
        swingType: 'low',
        creatingSwing,
      };
      this.swingLows.push(swing);
      this.swingSequence.push(swing);
      newSwings.push({ type: 'low', ...swing });
      if (this.swingLows.length > 50) this.swingLows = this.swingLows.slice(-50);
    }

    // Trim swing sequence
    if (this.swingSequence.length > 100) {
      this.swingSequence = this.swingSequence.slice(-100);
    }

    return newSwings;
  }

  /**
   * Find the creating swing for a new swing of the given type.
   * A swing high is "created" by the most recent swing low, and vice versa.
   */
  _findCreatingSwing(newSwingType) {
    // Walk backward through swingSequence looking for the most recent opposite type
    for (let i = this.swingSequence.length - 1; i >= 0; i--) {
      if (this.swingSequence[i].swingType !== newSwingType) {
        return this.swingSequence[i];
      }
    }
    return null;
  }

  // ── Structure Shift Detection (CHoCH / MSS / BOS) ────────

  /**
   * Detect CHoCH: Break of the swing that CREATED the current structure leg.
   * Bullish CHoCH (in downtrend): close above the HIGH that created the most recent LOW
   * Bearish CHoCH (in uptrend): close below the LOW that created the most recent HIGH
   */
  _detectCHoCH(candle) {
    const bc = this.breakConfirmation;

    // Bullish CHoCH: break the high that created the last swing low
    if (this.trend === 'bearish' || this.trend === null) {
      if (this.swingLows.length > 0) {
        const lastLow = this.swingLows[this.swingLows.length - 1];
        const creatingHigh = lastLow.creatingSwing;
        if (creatingHigh && creatingHigh.swingType === 'high') {
          if (candle.close > creatingHigh.price + bc) {
            if (creatingHigh.price !== this.lastBullishBreak) {
              const choch = {
                type: 'bullish_choch',
                level: creatingHigh.price,
                timestamp: candle.timestamp,
                direction: 'bullish',
                causalSwing: lastLow.price,
                swingBroken: creatingHigh,
                impulseRange: this._calcImpulseRange(lastLow, creatingHigh, 'bullish'),
              };
              this.pendingCHoCH = choch;
              return choch;
            }
          }
        }
      }
    }

    // Bearish CHoCH: break the low that created the last swing high
    if (this.trend === 'bullish' || this.trend === null) {
      if (this.swingHighs.length > 0) {
        const lastHigh = this.swingHighs[this.swingHighs.length - 1];
        const creatingLow = lastHigh.creatingSwing;
        if (creatingLow && creatingLow.swingType === 'low') {
          if (candle.close < creatingLow.price - bc) {
            if (creatingLow.price !== this.lastBearishBreak) {
              const choch = {
                type: 'bearish_choch',
                level: creatingLow.price,
                timestamp: candle.timestamp,
                direction: 'bearish',
                causalSwing: lastHigh.price,
                swingBroken: creatingLow,
                impulseRange: this._calcImpulseRange(lastHigh, creatingLow, 'bearish'),
              };
              this.pendingCHoCH = choch;
              return choch;
            }
          }
        }
      }
    }

    // Fallback: simple structure shift when no creatingSwing data available
    return this._detectSimpleStructureShift(candle);
  }

  /**
   * Fallback simple structure shift for when creatingSwing relationships
   * aren't available (early candles). Same logic as the original _checkStructureShift.
   */
  _detectSimpleStructureShift(candle) {
    const bc = this.breakConfirmation;

    if (this.swingHighs.length > 0) {
      const sh = this.swingHighs[this.swingHighs.length - 1];
      if (candle.close > sh.price + bc) {
        if (this.trend !== 'bullish' || sh.price !== this.lastBullishBreak) {
          // Only fire if we have no creatingSwing data (handled by CHoCH above otherwise)
          if (sh.creatingSwing) return null;
          this.trend = 'bullish';
          this.lastBullishBreak = sh.price;
          const causalSwing = this.swingLows.length > 0
            ? this.swingLows[this.swingLows.length - 1].price
            : null;
          this.lastStructureShift = {
            type: 'bullish_shift',
            level: sh.price,
            timestamp: candle.timestamp,
            direction: 'bullish',
            causalSwing,
            impulseRange: causalSwing !== null
              ? { high: sh.price, low: causalSwing, range: sh.price - causalSwing }
              : null,
          };
          this.pendingCHoCH = this.lastStructureShift;
          return this.lastStructureShift;
        }
      }
    }

    if (this.swingLows.length > 0) {
      const sl = this.swingLows[this.swingLows.length - 1];
      if (candle.close < sl.price - bc) {
        if (this.trend !== 'bearish' || sl.price !== this.lastBearishBreak) {
          if (sl.creatingSwing) return null;
          this.trend = 'bearish';
          this.lastBearishBreak = sl.price;
          const causalSwing = this.swingHighs.length > 0
            ? this.swingHighs[this.swingHighs.length - 1].price
            : null;
          this.lastStructureShift = {
            type: 'bearish_shift',
            level: sl.price,
            timestamp: candle.timestamp,
            direction: 'bearish',
            causalSwing,
            impulseRange: causalSwing !== null
              ? { high: causalSwing, low: sl.price, range: causalSwing - sl.price }
              : null,
          };
          this.pendingCHoCH = this.lastStructureShift;
          return this.lastStructureShift;
        }
      }
    }

    return null;
  }

  /**
   * After CHoCH, close beyond the NEXT structural level confirms the shift (MSS).
   */
  _detectMSS(candle, pendingCHoCH) {
    const bc = this.breakConfirmation;

    if (pendingCHoCH.direction === 'bullish') {
      // MSS confirmed: candle closes above the CHoCH level convincingly
      // (We already broke the creating high for CHoCH; MSS = continuation close)
      if (candle.close > pendingCHoCH.level + bc) {
        this.trend = 'bullish';
        this.lastBullishBreak = pendingCHoCH.level;
        this.lastStructureShift = {
          type: 'bullish_shift',
          level: pendingCHoCH.level,
          timestamp: candle.timestamp,
          direction: 'bullish',
          causalSwing: pendingCHoCH.causalSwing,
          confirmsChoch: pendingCHoCH,
          impulseRange: pendingCHoCH.impulseRange,
        };
        return this.lastStructureShift;
      }
    } else {
      if (candle.close < pendingCHoCH.level - bc) {
        this.trend = 'bearish';
        this.lastBearishBreak = pendingCHoCH.level;
        this.lastStructureShift = {
          type: 'bearish_shift',
          level: pendingCHoCH.level,
          timestamp: candle.timestamp,
          direction: 'bearish',
          causalSwing: pendingCHoCH.causalSwing,
          confirmsChoch: pendingCHoCH,
          impulseRange: pendingCHoCH.impulseRange,
        };
        return this.lastStructureShift;
      }
    }

    return null;
  }

  /**
   * Promote a CHoCH directly to a confirmed shift (displacement fallback)
   */
  _promoteCHoCHToShift(choch, candle) {
    const shiftType = choch.direction === 'bullish' ? 'bullish_shift' : 'bearish_shift';
    if (choch.direction === 'bullish') {
      this.trend = 'bullish';
      this.lastBullishBreak = choch.level;
    } else {
      this.trend = 'bearish';
      this.lastBearishBreak = choch.level;
    }
    this.lastStructureShift = {
      type: shiftType,
      level: choch.level,
      timestamp: candle.timestamp,
      direction: choch.direction,
      causalSwing: choch.causalSwing,
      confirmsChoch: choch,
      impulseRange: choch.impulseRange,
    };
    return this.lastStructureShift;
  }

  /**
   * Invalidate pending CHoCH if price moves back past causal swing
   */
  _isCHoCHInvalidated(candle, pendingCHoCH) {
    if (pendingCHoCH.direction === 'bullish') {
      // Invalidated if price drops back below the causal swing low
      return pendingCHoCH.causalSwing !== null && candle.close < pendingCHoCH.causalSwing;
    } else {
      return pendingCHoCH.causalSwing !== null && candle.close > pendingCHoCH.causalSwing;
    }
  }

  /**
   * Detect Break of Structure (BOS) — continuation in existing trend.
   * Bullish BOS: in bullish trend, close above a new swing high (higher high)
   * Bearish BOS: in bearish trend, close below a new swing low (lower low)
   */
  _detectBOS(candle) {
    const bc = this.breakConfirmation;

    if (this.trend === 'bullish' && this.swingHighs.length > 0) {
      const sh = this.swingHighs[this.swingHighs.length - 1];
      if (candle.close > sh.price + bc && sh.price !== this.lastBullishBreak) {
        this.lastBullishBreak = sh.price;
        const causalSwing = this.swingLows.length > 0
          ? this.swingLows[this.swingLows.length - 1].price
          : null;
        const bos = {
          type: 'bullish_bos',
          level: sh.price,
          timestamp: candle.timestamp,
          direction: 'bullish',
          causalSwing,
          impulseRange: causalSwing !== null
            ? { high: sh.price, low: causalSwing, range: sh.price - causalSwing }
            : null,
        };
        this.lastStructureShift = bos;
        return bos;
      }
    }

    if (this.trend === 'bearish' && this.swingLows.length > 0) {
      const sl = this.swingLows[this.swingLows.length - 1];
      if (candle.close < sl.price - bc && sl.price !== this.lastBearishBreak) {
        this.lastBearishBreak = sl.price;
        const causalSwing = this.swingHighs.length > 0
          ? this.swingHighs[this.swingHighs.length - 1].price
          : null;
        const bos = {
          type: 'bearish_bos',
          level: sl.price,
          timestamp: candle.timestamp,
          direction: 'bearish',
          causalSwing,
          impulseRange: causalSwing !== null
            ? { high: causalSwing, low: sl.price, range: causalSwing - sl.price }
            : null,
        };
        this.lastStructureShift = bos;
        return bos;
      }
    }

    return null;
  }

  /**
   * Calculate impulse range from two swing points
   */
  _calcImpulseRange(swing1, swing2, direction) {
    const high = Math.max(swing1.price, swing2.price);
    const low = Math.min(swing1.price, swing2.price);
    return { high, low, range: high - low };
  }

  // ── FVG Scanning ──────────────────────────────────────────

  /**
   * Check the last 3 candles for a Fair Value Gap.
   * Bullish FVG: c0.high < c2.low (gap up)
   * Bearish FVG: c0.low > c2.high (gap down)
   */
  _scanFVG() {
    const buf = this.candles;
    if (buf.length < 3) return [];

    const newFVGs = [];
    const i = buf.length - 1;
    const c0 = buf[i - 2];
    const c1 = buf[i - 1]; // displacement candle
    const c2 = buf[i];

    // Bullish FVG: gap between c0.high and c2.low
    const bullGapBottom = c0.high;
    const bullGapTop = c2.low;
    if (bullGapTop - bullGapBottom >= this.minFVGSize && c1.close > c1.open) {
      const fvg = {
        type: 'bullish',
        top: bullGapTop,
        bottom: bullGapBottom,
        midpoint: (bullGapTop + bullGapBottom) / 2,
        size: bullGapTop - bullGapBottom,
        timestamp: c2.timestamp,
        candleAge: 0,
        filled: false,
      };
      this.activeFVGs.push(fvg);
      newFVGs.push(fvg);
    }

    // Bearish FVG: gap between c2.high and c0.low
    const bearGapTop = c0.low;
    const bearGapBottom = c2.high;
    if (bearGapTop - bearGapBottom >= this.minFVGSize && c1.close < c1.open) {
      const fvg = {
        type: 'bearish',
        top: bearGapTop,
        bottom: bearGapBottom,
        midpoint: (bearGapTop + bearGapBottom) / 2,
        size: bearGapTop - bearGapBottom,
        timestamp: c2.timestamp,
        candleAge: 0,
        filled: false,
      };
      this.activeFVGs.push(fvg);
      newFVGs.push(fvg);
    }

    return newFVGs;
  }

  // ── Order Block Detection ─────────────────────────────────

  /**
   * Detect Order Blocks using flexible impulse scanning.
   * Scans backward from the most recent candle(s) looking for consecutive
   * same-direction candles (the impulse), then identifies the last
   * opposite-direction candle before the impulse as the OB.
   *
   * Improvements over original:
   * - Allows 1-5 candle impulses (not just exactly 2)
   * - Allows one small embedded pullback candle (body < 30% of impulse)
   * - Tracks impulse metadata (size, candle count)
   */
  _detectOB() {
    const buf = this.candles;
    if (buf.length < 3) return [];

    const newOBs = [];
    const i = buf.length - 1;

    // Try to detect a bullish impulse ending at the current candle
    const bullishImpulse = this._scanImpulse(i, 'bullish');
    if (bullishImpulse) {
      // Find the last bearish candle before the impulse
      const obIdx = bullishImpulse.startIdx - 1;
      if (obIdx >= 0) {
        const obCandle = buf[obIdx];
        if (obCandle.close < obCandle.open) { // Must be bearish
          const ob = {
            type: 'bullish',
            high: obCandle.high,
            low: obCandle.low,
            midpoint: (obCandle.high + obCandle.low) / 2,
            timestamp: obCandle.timestamp,
            candleAge: 0,
            mitigated: false,
            impulseSize: bullishImpulse.totalMove,
            impulseCandleCount: bullishImpulse.candleCount,
          };
          this.activeOBs.push(ob);
          newOBs.push(ob);
        }
      }
    }

    // Try to detect a bearish impulse ending at the current candle
    const bearishImpulse = this._scanImpulse(i, 'bearish');
    if (bearishImpulse) {
      const obIdx = bearishImpulse.startIdx - 1;
      if (obIdx >= 0) {
        const obCandle = buf[obIdx];
        if (obCandle.close > obCandle.open) { // Must be bullish
          const ob = {
            type: 'bearish',
            high: obCandle.high,
            low: obCandle.low,
            midpoint: (obCandle.high + obCandle.low) / 2,
            timestamp: obCandle.timestamp,
            candleAge: 0,
            mitigated: false,
            impulseSize: bearishImpulse.totalMove,
            impulseCandleCount: bearishImpulse.candleCount,
          };
          this.activeOBs.push(ob);
          newOBs.push(ob);
        }
      }
    }

    return newOBs;
  }

  /**
   * Scan backward from endIdx looking for an impulse move.
   * Returns { startIdx, candleCount, totalMove } or null.
   */
  _scanImpulse(endIdx, direction) {
    const buf = this.candles;
    const maxCandles = 5;
    let totalMove = 0;
    let sameDirectionCount = 0;
    let embeddedPullbacks = 0;
    let startIdx = endIdx;

    for (let j = endIdx; j >= Math.max(0, endIdx - maxCandles + 1); j--) {
      const c = buf[j];
      const isSameDirection = direction === 'bullish'
        ? c.close > c.open
        : c.close < c.open;

      if (isSameDirection) {
        sameDirectionCount++;
        totalMove += Math.abs(c.close - c.open);
        startIdx = j;
      } else {
        // Allow one small embedded pullback (body < 30% of accumulated impulse)
        const bodySize = Math.abs(c.close - c.open);
        if (embeddedPullbacks === 0 && sameDirectionCount >= 1 && totalMove > 0 && bodySize < totalMove * 0.3) {
          embeddedPullbacks++;
          startIdx = j;
        } else {
          break;
        }
      }
    }

    if (sameDirectionCount >= 1 && totalMove >= this.minFVGSize) {
      return {
        startIdx,
        candleCount: endIdx - startIdx + 1,
        totalMove,
      };
    }
    return null;
  }

  // ── Expiry & Fill Tracking ────────────────────────────────

  _expireAndFill(candle) {
    const rejections = [];

    // Age all FVGs and OBs
    for (const fvg of this.activeFVGs) fvg.candleAge++;
    for (const ob of this.activeOBs) ob.candleAge++;

    // Mark filled FVGs and detect rejections (momentum continuation)
    for (const fvg of this.activeFVGs) {
      if (fvg.filled) continue;

      if (fvg.type === 'bullish' && candle.low <= fvg.bottom) {
        fvg.filled = true;
        // Rejection: price fills the bullish FVG but closes back above midpoint (bullish rejection)
        if (candle.close > fvg.midpoint) {
          const rejection = {
            ...fvg,
            rejectionCandle: candle,
            rejectionDirection: 'bullish',
            rejectionPrice: candle.high,
          };
          rejections.push(rejection);
          this.filledRejectedFVGs.push(rejection);
        }
      }
      if (fvg.type === 'bearish' && candle.high >= fvg.top) {
        fvg.filled = true;
        // Rejection: price fills the bearish FVG but closes back below midpoint (bearish rejection)
        if (candle.close < fvg.midpoint) {
          const rejection = {
            ...fvg,
            rejectionCandle: candle,
            rejectionDirection: 'bearish',
            rejectionPrice: candle.low,
          };
          rejections.push(rejection);
          this.filledRejectedFVGs.push(rejection);
        }
      }
    }

    // Mark mitigated OBs (price returned to the zone)
    for (const ob of this.activeOBs) {
      if (ob.mitigated) continue;
      if (ob.type === 'bullish' && candle.low <= ob.low) ob.mitigated = true;
      if (ob.type === 'bearish' && candle.high >= ob.high) ob.mitigated = true;
    }

    // Remove expired/filled
    this.activeFVGs = this.activeFVGs.filter(
      fvg => !fvg.filled && fvg.candleAge <= this.maxFVGAge
    );
    this.activeOBs = this.activeOBs.filter(
      ob => !ob.mitigated && ob.candleAge <= this.maxOBAge
    );

    // Keep rejected FVGs bounded
    if (this.filledRejectedFVGs.length > 20) {
      this.filledRejectedFVGs = this.filledRejectedFVGs.slice(-20);
    }

    return rejections;
  }

  /**
   * Get unfilled FVGs matching a direction
   */
  getActiveFVGs(direction) {
    const type = direction === 'bullish' ? 'bullish' : 'bearish';
    return this.activeFVGs.filter(fvg => fvg.type === type && !fvg.filled);
  }

  /**
   * Get unmitigated OBs matching a direction
   */
  getActiveOBs(direction) {
    const type = direction === 'bullish' ? 'bullish' : 'bearish';
    return this.activeOBs.filter(ob => ob.type === type && !ob.mitigated);
  }

  /**
   * Get recent filled+rejected FVGs matching a direction (for momentum continuation)
   */
  getFilledRejections(direction) {
    return this.filledRejectedFVGs.filter(r => r.rejectionDirection === direction);
  }

  /**
   * Consume (remove) a filled rejection after creating a momentum setup
   */
  consumeRejection(rejection) {
    this.filledRejectedFVGs = this.filledRejectedFVGs.filter(r => r !== rejection);
  }

  /**
   * Get the impulse range from the last structure shift
   */
  getImpulseRange() {
    return this.lastStructureShift?.impulseRange ?? null;
  }

  /**
   * Get recent swing highs/lows for liquidity pool tracking
   */
  getRecentSwings(count = 10) {
    return {
      highs: this.swingHighs.slice(-count),
      lows: this.swingLows.slice(-count),
    };
  }
}
