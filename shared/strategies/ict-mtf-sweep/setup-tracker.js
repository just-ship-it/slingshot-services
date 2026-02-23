/**
 * Setup Tracker
 *
 * Manages independent setup objects that progress through the ICT sequence:
 *   SWEEP → STRUCTURE_SHIFT → ENTRY_ZONE → ENTRY_PENDING → (entry ready)
 *
 * Each setup has a structure TF (where sweep + shift occur) and an entry TF
 * (where FVG/OB provides the entry). Setups expire after a configurable
 * number of candles in the structure TF.
 */

// Default expiry in structure-TF candles
const DEFAULT_EXPIRY = {
  '4h': 6,    // 24 hours
  '1h': 12,   // 12 hours
  '15m': 24,  // 6 hours
  '5m': 36,   // 3 hours
};

let nextId = 0;

export class SetupTracker {
  constructor(params = {}) {
    this.maxSetups = params.maxSetups ?? 10;
    this.expiryMultiplier = params.expiryMultiplier ?? 1.0;
    this.customExpiry = params.expiryCandles || {};
    this.debug = params.debug || false;

    // 1m confirmation params (opt-in via requireConfirmation)
    this.requireConfirmation = params.requireConfirmation ?? false;
    this.confirmationDeadline = params.confirmationDeadline ?? 5;
    this.zoneInvalidationBuffer = params.zoneInvalidationBuffer ?? 5;

    this.setups = new Map(); // id → setup
  }

  reset() {
    this.setups.clear();
    nextId = 0;
  }

  /**
   * Create a new setup at SWEEP phase
   */
  createSetup(sweepEvent, structureTF, liquidityPool) {
    // Enforce max setups
    if (this.setups.size >= this.maxSetups) {
      this._evictOldest();
    }

    const id = ++nextId;
    const setup = {
      id,
      phase: 'SWEEP',
      direction: sweepEvent.direction, // 'bullish' or 'bearish'
      structureTF,
      entryTF: null, // determined when entry zone is found

      // Sweep data
      sweepEvent: {
        level: liquidityPool.price,
        type: liquidityPool.type,
        direction: liquidityPool.direction, // 'above' or 'below' — needed by getOpposingPool()
        price: sweepEvent.sweepPrice,
        timestamp: sweepEvent.timestamp || Date.now(),
      },

      // Filled in later phases
      structureShift: null,
      entryZone: null,     // { type: 'fvg'|'ob', top, bottom, midpoint, timestamp }
      targetPool: null,
      stopLevel: null,
      riskReward: null,
      isKillzone: false,

      // Entry model
      entryModel: 'MW_PATTERN',

      // Tracking
      createdAt: sweepEvent.timestamp || Date.now(),
      candlesSinceSweep: 0,
      expiryCandles: this._getExpiry(structureTF),
    };

    this.setups.set(id, setup);

    if (this.debug) {
      console.log(`  [SETUP] #${id} CREATED: ${setup.direction} sweep of ${liquidityPool.type} @ ${liquidityPool.price.toFixed(2)} (${structureTF})`);
    }

    return setup;
  }

  /**
   * Create a new setup at STRUCTURE_SHIFT phase (skipping SWEEP).
   * Used by the STRUCTURE_RETRACE entry model.
   */
  createRetraceSetup(structureShift, structureTF) {
    // Enforce max setups
    if (this.setups.size >= this.maxSetups) {
      this._evictOldest();
    }

    const id = ++nextId;
    const setup = {
      id,
      phase: 'STRUCTURE_SHIFT',
      direction: structureShift.direction,
      structureTF,
      entryTF: null,

      // No sweep for retrace model
      sweepEvent: null,

      // Structure shift data (already happened)
      structureShift: {
        type: structureShift.type,
        level: structureShift.level,
        timestamp: structureShift.timestamp,
        causalSwing: structureShift.causalSwing ?? null,
        impulseRange: structureShift.impulseRange ?? null,
      },

      // Filled in later phases
      entryZone: null,
      targetPool: null,
      stopLevel: null,
      riskReward: null,
      isKillzone: false,

      // Entry model
      entryModel: 'STRUCTURE_RETRACE',

      // Tracking
      createdAt: structureShift.timestamp || Date.now(),
      candlesSinceSweep: 0,
      expiryCandles: this._getExpiry(structureTF),
    };

    this.setups.set(id, setup);

    if (this.debug) {
      console.log(`  [SETUP] #${id} CREATED (RETRACE): ${setup.direction} shift @ ${structureShift.level.toFixed(2)} (${structureTF})`);
    }

    return setup;
  }

  /**
   * Create a STRUCTURE_DIRECT setup — enters at ENTRY_ZONE immediately.
   * Used when a structure shift fires and matching FVGs/OBs already exist.
   */
  createDirectSetup(structureShift, structureTF, entryZone, sweepEvent = null) {
    if (this.setups.size >= this.maxSetups) {
      this._evictOldest();
    }

    const id = ++nextId;
    const setup = {
      id,
      phase: 'ENTRY_ZONE',
      direction: structureShift.direction,
      structureTF,
      entryTF: entryZone.entryTF || structureTF,

      sweepEvent: sweepEvent ? {
        level: sweepEvent.level,
        type: sweepEvent.type,
        direction: sweepEvent.direction,
        price: sweepEvent.price,
        timestamp: sweepEvent.timestamp || Date.now(),
      } : null,

      structureShift: {
        type: structureShift.type,
        level: structureShift.level,
        timestamp: structureShift.timestamp,
        causalSwing: structureShift.causalSwing ?? null,
        impulseRange: structureShift.impulseRange ?? null,
      },

      entryZone: {
        type: entryZone.type,
        top: entryZone.top,
        bottom: entryZone.bottom,
        midpoint: entryZone.midpoint,
        timestamp: entryZone.timestamp,
        entryTF: entryZone.entryTF || structureTF,
      },

      targetPool: null,
      stopLevel: null,
      riskReward: null,
      isKillzone: false,

      entryModel: 'STRUCTURE_DIRECT',

      createdAt: structureShift.timestamp || Date.now(),
      candlesSinceSweep: 0,
      expiryCandles: this._getExpiry(structureTF),
    };

    this.setups.set(id, setup);

    if (this.debug) {
      console.log(`  [SETUP] #${id} CREATED (DIRECT): ${setup.direction} ${entryZone.type} ${entryZone.bottom.toFixed(2)}-${entryZone.top.toFixed(2)} (${structureTF}→${setup.entryTF})`);
    }

    return setup;
  }

  /**
   * Create a MOMENTUM_CONTINUATION setup from a filled+rejected FVG.
   * Enters at ENTRY_ZONE with the rejection candle extreme as the entry trigger.
   */
  createMomentumSetup(rejection, structureTF) {
    if (this.setups.size >= this.maxSetups) {
      this._evictOldest();
    }

    const id = ++nextId;
    const direction = rejection.rejectionDirection;

    // Entry zone is the original FVG bounds
    const entryZoneTop = rejection.top;
    const entryZoneBottom = rejection.bottom;

    const setup = {
      id,
      phase: 'ENTRY_ZONE',
      direction,
      structureTF,
      entryTF: structureTF,

      sweepEvent: null,

      structureShift: null,

      entryZone: {
        type: 'fvg_rejection',
        top: entryZoneTop,
        bottom: entryZoneBottom,
        midpoint: (entryZoneTop + entryZoneBottom) / 2,
        timestamp: rejection.rejectionCandle.timestamp,
        entryTF: structureTF,
      },

      targetPool: null,
      stopLevel: null,
      riskReward: null,
      isKillzone: false,

      entryModel: 'MOMENTUM_CONTINUATION',

      createdAt: rejection.rejectionCandle.timestamp || Date.now(),
      candlesSinceSweep: 0,
      expiryCandles: this._getExpiry(structureTF),
    };

    this.setups.set(id, setup);

    if (this.debug) {
      console.log(`  [SETUP] #${id} CREATED (MOMENTUM): ${direction} FVG rejection @ ${rejection.rejectionPrice.toFixed(2)} (${structureTF})`);
    }

    return setup;
  }

  /**
   * Check if an entry zone overlaps with the fibonacci retracement zone (50%-79%)
   * of the impulse that created the structure shift.
   *
   * @param {{ top: number, bottom: number }} entryZone
   * @param {{ high: number, low: number, range: number }} impulseRange
   * @param {string} direction - 'bullish' or 'bearish'
   * @returns {{ fib50: number, fib79: number, inFibZone: boolean, impulseRange: object }}
   */
  checkFibZoneOverlap(entryZone, impulseRange, direction) {
    if (!impulseRange || !impulseRange.range || impulseRange.range <= 0) {
      return { fib50: null, fib79: null, inFibZone: false, impulseRange: null };
    }

    let fib50, fib79, fibTop, fibBottom;

    if (direction === 'bullish') {
      // Bullish: retrace DOWN from high
      fib50 = impulseRange.high - impulseRange.range * 0.5;
      fib79 = impulseRange.high - impulseRange.range * 0.79;
      fibTop = fib50;
      fibBottom = fib79;
    } else {
      // Bearish: retrace UP from low
      fib50 = impulseRange.low + impulseRange.range * 0.5;
      fib79 = impulseRange.low + impulseRange.range * 0.79;
      fibTop = fib79;
      fibBottom = fib50;
    }

    // Check overlap: entry zone intersects fib zone
    const inFibZone = entryZone.top >= fibBottom && entryZone.bottom <= fibTop;

    return { fib50, fib79, inFibZone, impulseRange };
  }

  /**
   * Advance a setup to STRUCTURE_SHIFT phase
   */
  advanceToStructureShift(setupId, shiftEvent) {
    const setup = this.setups.get(setupId);
    if (!setup || setup.phase !== 'SWEEP') return;

    // Validate direction matches
    if (shiftEvent.direction !== setup.direction) return;

    setup.phase = 'STRUCTURE_SHIFT';
    setup.structureShift = {
      type: shiftEvent.type,
      level: shiftEvent.level,
      timestamp: shiftEvent.timestamp,
      causalSwing: shiftEvent.causalSwing ?? null,
      impulseRange: shiftEvent.impulseRange ?? null,
    };

    if (this.debug) {
      console.log(`  [SETUP] #${setupId} → STRUCTURE_SHIFT: ${shiftEvent.type} @ ${shiftEvent.level.toFixed(2)}`);
    }
  }

  /**
   * Advance a setup to ENTRY_ZONE phase (FVG or OB found)
   */
  advanceToEntryZone(setupId, entryZoneData) {
    const setup = this.setups.get(setupId);
    if (!setup || setup.phase !== 'STRUCTURE_SHIFT') return;

    setup.phase = 'ENTRY_ZONE';
    setup.entryZone = {
      type: entryZoneData.type,    // 'fvg' or 'ob'
      top: entryZoneData.top,
      bottom: entryZoneData.bottom,
      midpoint: entryZoneData.midpoint,
      timestamp: entryZoneData.timestamp,
      entryTF: entryZoneData.entryTF || setup.structureTF,
    };
    setup.entryTF = entryZoneData.entryTF || setup.structureTF;

    if (this.debug) {
      console.log(`  [SETUP] #${setupId} → ENTRY_ZONE: ${entryZoneData.type} ${entryZoneData.bottom.toFixed(2)}-${entryZoneData.top.toFixed(2)} (${setup.entryTF})`);
    }
  }

  /**
   * Check all ENTRY_ZONE setups for price entering the zone
   * @param {Object} candle - Current 1m candle
   * @param {string} fvgEntryMode - 'ce' (consequent encroachment/midpoint) or 'edge'
   * @returns {Array} Entry-ready setups with entry prices
   */
  checkEntries(candle, fvgEntryMode = 'ce') {
    const ready = [];

    for (const [id, setup] of this.setups) {
      if (setup.phase !== 'ENTRY_ZONE') continue;
      if (!setup.entryZone) continue;

      const zone = setup.entryZone;
      let entryPrice = null;

      if (fvgEntryMode === 'ce') {
        // Consequent encroachment — enter at midpoint
        if (setup.direction === 'bullish') {
          // Price retracing DOWN into zone: candle touches midpoint
          if (candle.low <= zone.midpoint && candle.high >= zone.midpoint) {
            entryPrice = zone.midpoint;
          }
        } else {
          // Price retracing UP into zone: candle touches midpoint
          if (candle.high >= zone.midpoint && candle.low <= zone.midpoint) {
            entryPrice = zone.midpoint;
          }
        }
      } else {
        // Edge entry — enter at zone boundary
        if (setup.direction === 'bullish') {
          if (candle.low <= zone.top && candle.high >= zone.top) {
            entryPrice = zone.top;
          }
        } else {
          if (candle.high >= zone.bottom && candle.low <= zone.bottom) {
            entryPrice = zone.bottom;
          }
        }
      }

      if (entryPrice !== null) {
        ready.push({ ...setup, entryPrice });
      }
    }

    return ready;
  }

  /**
   * Check ENTRY_ZONE setups for 1m candle touching the zone (without setting entry price).
   * Returns setups where the candle range intersects the zone trigger level.
   * Used with requireConfirmation to create ENTRY_PENDING setups.
   *
   * @param {Object} candle - Current 1m candle
   * @param {string} fvgEntryMode - 'ce' (midpoint) or 'edge'
   * @returns {Array} Setups whose zone was touched
   */
  checkZoneTouches(candle, fvgEntryMode = 'ce') {
    const touched = [];

    for (const [id, setup] of this.setups) {
      if (setup.phase !== 'ENTRY_ZONE') continue;
      if (!setup.entryZone) continue;

      const zone = setup.entryZone;
      let triggerLevel;

      if (fvgEntryMode === 'ce') {
        triggerLevel = zone.midpoint;
      } else {
        triggerLevel = setup.direction === 'bullish' ? zone.top : zone.bottom;
      }

      // Check if candle range touches the trigger level
      if (candle.low <= triggerLevel && candle.high >= triggerLevel) {
        touched.push(setup);
      }
    }

    return touched;
  }

  /**
   * Transition a setup from ENTRY_ZONE to ENTRY_PENDING.
   * Initializes tracking state for 1m confirmation window.
   *
   * @param {number} setupId
   * @param {Object} triggerCandle - The 1m candle that first touched the zone
   */
  markEntryPending(setupId, triggerCandle) {
    const setup = this.setups.get(setupId);
    if (!setup || setup.phase !== 'ENTRY_ZONE') return;

    setup.phase = 'ENTRY_PENDING';
    setup.pendingEntry = {
      triggerTimestamp: triggerCandle.timestamp,
      confirmationDeadline: this.confirmationDeadline,
      candlesSinceTrigger: 0,
      closesInTradeDirection: 0,
    };

    if (this.debug) {
      console.log(`  [SETUP] #${setupId} → ENTRY_PENDING: awaiting 1m confirmation (deadline ${this.confirmationDeadline} candles)`);
    }
  }

  /**
   * Evaluate each ENTRY_PENDING setup against the current 1m candle.
   * Returns confirmed entries with entryPrice set.
   *
   * Confirmation criteria (any of):
   *   1. Rejection wick: candle enters zone, closes back in trade direction
   *   2. Consecutive closes: 2+ closes in trade direction at/beyond zone midpoint
   *
   * Invalidation: candle closes past zone boundary in wrong direction by > buffer
   * Timeout: revert to ENTRY_ZONE if deadline exceeded
   *
   * @param {Object} candle - Current 1m candle
   * @param {string} fvgEntryMode - 'ce' or 'edge'
   * @returns {Array} Confirmed setups with entryPrice
   */
  checkConfirmation(candle, fvgEntryMode = 'ce') {
    const confirmed = [];

    for (const [id, setup] of this.setups) {
      if (setup.phase !== 'ENTRY_PENDING') continue;
      if (!setup.pendingEntry || !setup.entryZone) continue;

      const pe = setup.pendingEntry;
      const zone = setup.entryZone;
      pe.candlesSinceTrigger++;

      const entryPrice = fvgEntryMode === 'ce'
        ? zone.midpoint
        : (setup.direction === 'bullish' ? zone.top : zone.bottom);

      // --- Invalidation check ---
      if (setup.direction === 'bullish') {
        // Zone failed if close drops below zone bottom by buffer
        if (candle.close < zone.bottom - this.zoneInvalidationBuffer) {
          if (this.debug) {
            console.log(`  [SETUP] #${id} INVALIDATED: close ${candle.close.toFixed(2)} < zone bottom ${zone.bottom.toFixed(2)} - ${this.zoneInvalidationBuffer}`);
          }
          this.setups.delete(id);
          continue;
        }
      } else {
        // Bearish: zone failed if close rises above zone top by buffer
        if (candle.close > zone.top + this.zoneInvalidationBuffer) {
          if (this.debug) {
            console.log(`  [SETUP] #${id} INVALIDATED: close ${candle.close.toFixed(2)} > zone top ${zone.top.toFixed(2)} + ${this.zoneInvalidationBuffer}`);
          }
          this.setups.delete(id);
          continue;
        }
      }

      // --- Confirmation check 1: Rejection wick ---
      if (setup.direction === 'bullish') {
        // Candle enters zone (low touches midpoint) and closes back above midpoint
        if (candle.low <= zone.midpoint && candle.close >= zone.midpoint) {
          if (this.debug) {
            console.log(`  [SETUP] #${id} CONFIRMED (rejection wick): low ${candle.low.toFixed(2)} ≤ midpoint ${zone.midpoint.toFixed(2)}, close ${candle.close.toFixed(2)} ≥ midpoint`);
          }
          setup.confirmationType = 'rejection_wick';
          confirmed.push({ ...setup, entryPrice });
          continue;
        }
      } else {
        // Bearish: candle enters zone (high touches midpoint) and closes back below midpoint
        if (candle.high >= zone.midpoint && candle.close <= zone.midpoint) {
          if (this.debug) {
            console.log(`  [SETUP] #${id} CONFIRMED (rejection wick): high ${candle.high.toFixed(2)} ≥ midpoint ${zone.midpoint.toFixed(2)}, close ${candle.close.toFixed(2)} ≤ midpoint`);
          }
          setup.confirmationType = 'rejection_wick';
          confirmed.push({ ...setup, entryPrice });
          continue;
        }
      }

      // --- Confirmation check 2: Consecutive closes in trade direction ---
      if (setup.direction === 'bullish') {
        if (candle.close >= zone.midpoint) {
          pe.closesInTradeDirection++;
        } else {
          pe.closesInTradeDirection = 0;
        }
      } else {
        if (candle.close <= zone.midpoint) {
          pe.closesInTradeDirection++;
        } else {
          pe.closesInTradeDirection = 0;
        }
      }

      if (pe.closesInTradeDirection >= 2) {
        if (this.debug) {
          console.log(`  [SETUP] #${id} CONFIRMED (consecutive closes): ${pe.closesInTradeDirection} closes in trade direction`);
        }
        setup.confirmationType = 'consecutive_closes';
        confirmed.push({ ...setup, entryPrice });
        continue;
      }

      // --- Timeout check ---
      if (pe.candlesSinceTrigger >= pe.confirmationDeadline) {
        if (this.debug) {
          console.log(`  [SETUP] #${id} TIMEOUT: no confirmation in ${pe.confirmationDeadline} candles, reverting to ENTRY_ZONE`);
        }
        setup.phase = 'ENTRY_ZONE';
        setup.pendingEntry = null;
      }
    }

    return confirmed;
  }

  /**
   * Increment candle counters for a specific structure TF
   * Called when a new candle completes on that TF
   */
  tickCandles(structureTF) {
    for (const [id, setup] of this.setups) {
      if (setup.structureTF === structureTF) {
        setup.candlesSinceSweep++;
      }
    }
  }

  /**
   * Invalidate ENTRY_ZONE setups where price has closed through the zone,
   * indicating the OB/FVG has been mitigated (institutional orders absorbed).
   * Per JV eBook Lesson 6: once price trades through a zone, those orders
   * have been filled and the zone is no longer valid.
   *
   * @param {Object} candle - Current 1m candle
   */
  checkZoneMitigation(candle) {
    for (const [id, setup] of this.setups) {
      if (setup.phase !== 'ENTRY_ZONE') continue;
      if (!setup.entryZone) continue;

      const zone = setup.entryZone;

      if (setup.direction === 'bearish') {
        // Bearish OB/FVG mitigated if price closes above zone top
        if (candle.close > zone.top + this.zoneInvalidationBuffer) {
          if (this.debug) {
            console.log(`  [SETUP] #${id} MITIGATED: close ${candle.close.toFixed(2)} > zone top ${zone.top.toFixed(2)} + ${this.zoneInvalidationBuffer} (bearish zone absorbed)`);
          }
          this.setups.delete(id);
        }
      } else {
        // Bullish OB/FVG mitigated if price closes below zone bottom
        if (candle.close < zone.bottom - this.zoneInvalidationBuffer) {
          if (this.debug) {
            console.log(`  [SETUP] #${id} MITIGATED: close ${candle.close.toFixed(2)} < zone bottom ${zone.bottom.toFixed(2)} - ${this.zoneInvalidationBuffer} (bullish zone absorbed)`);
          }
          this.setups.delete(id);
        }
      }
    }
  }

  /**
   * Expire setups that have exceeded their candle limit
   */
  expireOldSetups() {
    const expired = [];
    for (const [id, setup] of this.setups) {
      if (setup.candlesSinceSweep >= setup.expiryCandles) {
        expired.push(id);
        if (this.debug) {
          console.log(`  [SETUP] #${id} EXPIRED: ${setup.candlesSinceSweep} candles (max ${setup.expiryCandles})`);
        }
      }
    }
    for (const id of expired) {
      this.setups.delete(id);
    }
  }

  /**
   * Remove a specific setup (e.g., after signal generated)
   */
  removeSetup(setupId) {
    this.setups.delete(setupId);
  }

  /**
   * Get all setups in a given phase
   */
  getSetupsByPhase(phase) {
    const result = [];
    for (const [, setup] of this.setups) {
      if (setup.phase === phase) result.push(setup);
    }
    return result;
  }

  /**
   * Get all active setups
   */
  getAllSetups() {
    return Array.from(this.setups.values());
  }

  _getExpiry(tf) {
    const base = this.customExpiry[tf] ?? DEFAULT_EXPIRY[tf] ?? 24;
    return Math.round(base * this.expiryMultiplier);
  }

  _evictOldest() {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, setup] of this.setups) {
      if (setup.createdAt < oldestTime) {
        oldestTime = setup.createdAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) {
      this.setups.delete(oldestId);
    }
  }
}
