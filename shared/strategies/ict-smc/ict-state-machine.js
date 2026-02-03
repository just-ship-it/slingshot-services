/**
 * ICT State Machine
 *
 * Tracks the complete state of ICT analysis for signal generation.
 * Manages transitions through market phases and determines when
 * entry conditions are met.
 *
 * States:
 * - SCANNING: Looking for structure setup
 * - CHOCH_DETECTED: Change of character detected, waiting for confirmation
 * - MSS_CONFIRMED: Market structure shift confirmed, looking for entry zone
 * - AWAITING_ENTRY: Entry zone identified, waiting for LTF trigger
 * - COOLDOWN: Signal generated, in cooldown period
 */

export class ICTStateMachine {
  // State constants
  static STATES = {
    SCANNING: 'SCANNING',
    CHOCH_DETECTED: 'CHOCH_DETECTED',
    MSS_CONFIRMED: 'MSS_CONFIRMED',
    AWAITING_ENTRY: 'AWAITING_ENTRY',
    COOLDOWN: 'COOLDOWN'
  };

  constructor(options = {}) {
    this.options = {
      // Timing settings
      chochValidityMs: options.chochValidityMs || 4 * 60 * 60 * 1000,  // 4 hours
      mssValidityMs: options.mssValidityMs || 8 * 60 * 60 * 1000,      // 8 hours
      entryWindowMs: options.entryWindowMs || 2 * 60 * 60 * 1000,      // 2 hours
      cooldownMs: options.cooldownMs || 15 * 60 * 1000,                 // 15 minutes

      // Entry settings
      maxEntryDistance: options.maxEntryDistance || 50,
      requireOrderBlock: options.requireOrderBlock !== false,
      requireFVG: options.requireFVG !== false,

      ...options
    };

    // Initialize state
    this.state = {
      phase: ICTStateMachine.STATES.SCANNING,
      htfBias: null,           // 'bullish' | 'bearish' | null
      lastCHoCH: null,
      lastMSS: null,
      entryZone: null,         // Order Block or FVG for entry
      stopLevel: null,         // Structure-based stop
      targetLevel: null,       // Based on liquidity/structure
      lastSignalTime: 0,
      phaseEnteredAt: Date.now()
    };

    this.history = [];
  }

  /**
   * Reset state machine to initial state
   */
  reset() {
    this.state = {
      phase: ICTStateMachine.STATES.SCANNING,
      htfBias: null,
      lastCHoCH: null,
      lastMSS: null,
      entryZone: null,
      stopLevel: null,
      targetLevel: null,
      lastSignalTime: 0,
      phaseEnteredAt: Date.now()
    };
    this.history = [];
  }

  /**
   * Get current state
   * @returns {Object}
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Process new market data and transition state
   * @param {Object} structureAnalysis - Analysis from ICTStructureAnalyzer
   * @param {Object|null} ltfData - Lower timeframe data (candle, FVGs, etc.)
   * @param {number} currentTime - Current timestamp
   * @returns {Object} State transition result
   */
  process(structureAnalysis, ltfData = null, currentTime = Date.now()) {
    const previousPhase = this.state.phase;
    let result = { transitioned: false, signalReady: false };

    switch (this.state.phase) {
      case ICTStateMachine.STATES.SCANNING:
        result = this.handleScanning(structureAnalysis, currentTime);
        break;

      case ICTStateMachine.STATES.CHOCH_DETECTED:
        result = this.handleChochDetected(structureAnalysis, currentTime);
        break;

      case ICTStateMachine.STATES.MSS_CONFIRMED:
        result = this.handleMssConfirmed(structureAnalysis, ltfData, currentTime);
        break;

      case ICTStateMachine.STATES.AWAITING_ENTRY:
        result = this.handleAwaitingEntry(ltfData, currentTime);
        break;

      case ICTStateMachine.STATES.COOLDOWN:
        result = this.handleCooldown(currentTime);
        break;
    }

    // Record transition
    if (result.transitioned) {
      this.history.push({
        from: previousPhase,
        to: this.state.phase,
        timestamp: currentTime,
        reason: result.reason
      });
    }

    return result;
  }

  /**
   * Handle SCANNING state
   * Looking for CHoCH
   */
  handleScanning(structureAnalysis, currentTime) {
    // Look for CHoCH
    if (structureAnalysis.choch) {
      this.transitionTo(ICTStateMachine.STATES.CHOCH_DETECTED, currentTime);
      this.state.lastCHoCH = structureAnalysis.choch;
      this.state.htfBias = structureAnalysis.choch.type;

      return {
        transitioned: true,
        signalReady: false,
        reason: `CHoCH ${structureAnalysis.choch.type} detected at ${structureAnalysis.choch.level}`
      };
    }

    // Also check for MSS without CHoCH (trend continuation)
    if (structureAnalysis.mss && structureAnalysis.confidence > 60) {
      this.transitionTo(ICTStateMachine.STATES.MSS_CONFIRMED, currentTime);
      this.state.lastMSS = structureAnalysis.mss;
      this.state.htfBias = structureAnalysis.mss.direction;

      return {
        transitioned: true,
        signalReady: false,
        reason: `MSS ${structureAnalysis.mss.type} detected (continuation)`
      };
    }

    return { transitioned: false, signalReady: false };
  }

  /**
   * Handle CHOCH_DETECTED state
   * Waiting for MSS confirmation
   */
  handleChochDetected(structureAnalysis, currentTime) {
    // Check CHoCH validity timeout
    if (currentTime - this.state.phaseEnteredAt > this.options.chochValidityMs) {
      this.transitionTo(ICTStateMachine.STATES.SCANNING, currentTime);
      this.state.lastCHoCH = null;
      this.state.htfBias = null;

      return {
        transitioned: true,
        signalReady: false,
        reason: 'CHoCH expired without MSS confirmation'
      };
    }

    // Look for MSS confirmation
    if (structureAnalysis.mss) {
      // Verify MSS direction matches CHoCH
      const expectedDirection = this.state.lastCHoCH.type;
      if (structureAnalysis.mss.direction === expectedDirection) {
        this.transitionTo(ICTStateMachine.STATES.MSS_CONFIRMED, currentTime);
        this.state.lastMSS = structureAnalysis.mss;

        return {
          transitioned: true,
          signalReady: false,
          reason: `MSS confirmed CHoCH direction: ${expectedDirection}`
        };
      }
    }

    return { transitioned: false, signalReady: false };
  }

  /**
   * Handle MSS_CONFIRMED state
   * Looking for entry zone (Order Block or FVG)
   */
  handleMssConfirmed(structureAnalysis, ltfData, currentTime) {
    // Check MSS validity timeout
    if (currentTime - this.state.phaseEnteredAt > this.options.mssValidityMs) {
      this.transitionTo(ICTStateMachine.STATES.SCANNING, currentTime);
      this.clearStructure();

      return {
        transitioned: true,
        signalReady: false,
        reason: 'MSS expired without finding entry zone'
      };
    }

    // Look for entry zone
    const entryZone = this.findEntryZone(structureAnalysis, ltfData);

    if (entryZone) {
      this.transitionTo(ICTStateMachine.STATES.AWAITING_ENTRY, currentTime);
      this.state.entryZone = entryZone;
      this.state.stopLevel = structureAnalysis.structureLevel;
      this.state.targetLevel = this.calculateTarget(entryZone, structureAnalysis);

      return {
        transitioned: true,
        signalReady: false,
        reason: `Entry zone identified: ${entryZone.type} at ${entryZone.price || entryZone.low}`
      };
    }

    return { transitioned: false, signalReady: false };
  }

  /**
   * Handle AWAITING_ENTRY state
   * Waiting for LTF entry trigger
   */
  handleAwaitingEntry(ltfData, currentTime) {
    // Check entry window timeout
    if (currentTime - this.state.phaseEnteredAt > this.options.entryWindowMs) {
      this.transitionTo(ICTStateMachine.STATES.MSS_CONFIRMED, currentTime);
      this.state.entryZone = null;

      return {
        transitioned: true,
        signalReady: false,
        reason: 'Entry window expired'
      };
    }

    // Check if we have LTF data for entry
    if (ltfData && ltfData.candle) {
      const entryTriggered = this.checkEntryTrigger(ltfData);

      if (entryTriggered) {
        this.transitionTo(ICTStateMachine.STATES.COOLDOWN, currentTime);
        this.state.lastSignalTime = currentTime;

        return {
          transitioned: true,
          signalReady: true,
          reason: `Entry triggered: ${entryTriggered.trigger}`,
          entryDetails: entryTriggered
        };
      }
    }

    return { transitioned: false, signalReady: false };
  }

  /**
   * Handle COOLDOWN state
   */
  handleCooldown(currentTime) {
    if (currentTime - this.state.lastSignalTime > this.options.cooldownMs) {
      this.transitionTo(ICTStateMachine.STATES.SCANNING, currentTime);
      this.clearStructure();

      return {
        transitioned: true,
        signalReady: false,
        reason: 'Cooldown complete'
      };
    }

    return { transitioned: false, signalReady: false };
  }

  /**
   * Transition to a new state
   * @param {string} newPhase
   * @param {number} currentTime
   */
  transitionTo(newPhase, currentTime) {
    this.state.phase = newPhase;
    this.state.phaseEnteredAt = currentTime;
  }

  /**
   * Clear structure-related state
   */
  clearStructure() {
    this.state.lastCHoCH = null;
    this.state.lastMSS = null;
    this.state.htfBias = null;
    this.state.entryZone = null;
    this.state.stopLevel = null;
    this.state.targetLevel = null;
  }

  /**
   * Find entry zone from structure analysis
   * @param {Object} structureAnalysis
   * @param {Object|null} ltfData
   * @returns {Object|null}
   */
  findEntryZone(structureAnalysis, ltfData) {
    const bias = this.state.htfBias;

    // Look for Order Block first
    if (this.options.requireOrderBlock && structureAnalysis.orderBlocks.length > 0) {
      const relevantOBs = structureAnalysis.orderBlocks.filter(ob => {
        if (bias === 'bullish') {
          return ob.type === 'bullish' && !ob.mitigated;
        } else {
          return ob.type === 'bearish' && !ob.mitigated;
        }
      });

      if (relevantOBs.length > 0) {
        // Return the most recent unmitigated OB
        const ob = relevantOBs[relevantOBs.length - 1];
        return {
          type: 'order_block',
          orderBlock: ob,
          high: ob.high,
          low: ob.low,
          price: ob.midpoint
        };
      }
    }

    // Check for FVG in LTF data
    if (this.options.requireFVG && ltfData && ltfData.fvgs) {
      const relevantFVGs = ltfData.fvgs.filter(fvg => {
        if (bias === 'bullish') {
          return fvg.type === 'bullish_fvg' && !fvg.filled;
        } else {
          return fvg.type === 'bearish_fvg' && !fvg.filled;
        }
      });

      if (relevantFVGs.length > 0) {
        const fvg = relevantFVGs[relevantFVGs.length - 1];
        return {
          type: 'fvg',
          fvg: fvg,
          high: fvg.top,
          low: fvg.bottom,
          price: (fvg.top + fvg.bottom) / 2
        };
      }
    }

    return null;
  }

  /**
   * Check if LTF data triggers an entry
   * @param {Object} ltfData
   * @returns {Object|null}
   */
  checkEntryTrigger(ltfData) {
    if (!this.state.entryZone || !ltfData.candle) {
      return null;
    }

    const candle = ltfData.candle;
    const zone = this.state.entryZone;
    const bias = this.state.htfBias;

    // Check if price has reached the entry zone
    if (bias === 'bullish') {
      // For bullish, price should dip into the zone
      if (candle.low <= zone.high && candle.close > zone.low) {
        // Check for bullish rejection (wick rejection)
        const bodyLow = Math.min(candle.open, candle.close);
        const lowerWick = bodyLow - candle.low;
        const bodySize = Math.abs(candle.close - candle.open);

        if (lowerWick > bodySize * 0.5 && candle.close > candle.open) {
          return {
            trigger: 'bullish_rejection',
            entryPrice: candle.close,
            entryZone: zone
          };
        }

        // Or simply check if we're in the zone with bullish candle
        if (candle.close > candle.open) {
          return {
            trigger: 'zone_entry_bullish',
            entryPrice: candle.close,
            entryZone: zone
          };
        }
      }
    } else if (bias === 'bearish') {
      // For bearish, price should rally into the zone
      if (candle.high >= zone.low && candle.close < zone.high) {
        // Check for bearish rejection
        const bodyHigh = Math.max(candle.open, candle.close);
        const upperWick = candle.high - bodyHigh;
        const bodySize = Math.abs(candle.close - candle.open);

        if (upperWick > bodySize * 0.5 && candle.close < candle.open) {
          return {
            trigger: 'bearish_rejection',
            entryPrice: candle.close,
            entryZone: zone
          };
        }

        // Or simply check if we're in the zone with bearish candle
        if (candle.close < candle.open) {
          return {
            trigger: 'zone_entry_bearish',
            entryPrice: candle.close,
            entryZone: zone
          };
        }
      }
    }

    return null;
  }

  /**
   * Calculate target level based on structure
   * @param {Object} entryZone
   * @param {Object} structureAnalysis
   * @returns {Object|null}
   */
  calculateTarget(entryZone, structureAnalysis) {
    const bias = this.state.htfBias;

    if (bias === 'bullish') {
      // Target is the swing high or next liquidity level
      if (structureAnalysis.swingHigh) {
        return {
          type: 'swing_high',
          price: structureAnalysis.swingHigh.price,
          source: 'structure'
        };
      }
    } else if (bias === 'bearish') {
      // Target is the swing low or next liquidity level
      if (structureAnalysis.swingLow) {
        return {
          type: 'swing_low',
          price: structureAnalysis.swingLow.price,
          source: 'structure'
        };
      }
    }

    return null;
  }

  /**
   * Get signal conditions for external use
   * @returns {Object}
   */
  getSignalConditions() {
    return {
      canTakeLong: this.state.htfBias === 'bullish' &&
                   (this.state.phase === ICTStateMachine.STATES.AWAITING_ENTRY ||
                    this.state.phase === ICTStateMachine.STATES.MSS_CONFIRMED),
      canTakeShort: this.state.htfBias === 'bearish' &&
                    (this.state.phase === ICTStateMachine.STATES.AWAITING_ENTRY ||
                     this.state.phase === ICTStateMachine.STATES.MSS_CONFIRMED),
      entryZone: this.state.entryZone,
      stopLevel: this.state.stopLevel,
      targetLevel: this.state.targetLevel,
      phase: this.state.phase,
      htfBias: this.state.htfBias
    };
  }
}

export default ICTStateMachine;
