/**
 * ICT Multi-Timeframe Sweep Strategy
 *
 * Comprehensive JV ICT strategy that simultaneously tracks setups across
 * 5 timeframes (1m, 5m, 15m, 1h, 4h).
 *
 * Architecture:
 *   1m candle arrives via evaluateSignal()
 *     ├─ LiquidityPoolTracker: update PDH/PDL, session H/L, equal H/L
 *     ├─ CandleAggregator: feed to 5m/15m/1h/4h streams
 *     ├─ TimeframeAnalyzer[tf]: run ICT analysis on completed candles
 *     ├─ SetupTracker: create/advance/expire setups
 *     ├─ Entry check: price enters FVG/OB zone?
 *     ├─ Filters: killzone, direction, cooldown, daily limit
 *     └─ Signal: best setup → entry/stop/target → return
 *
 * Single position at a time (TradeSimulator enforces this).
 */

import { BaseStrategy } from '../base-strategy.js';
import { CandleAggregator } from '../../utils/candle-aggregator.js';
import { TimeframeAnalyzer } from './timeframe-analyzer.js';
import { LiquidityPoolTracker } from './liquidity-pool-tracker.js';
import { SetupTracker } from './setup-tracker.js';
import { SetupPrioritizer } from './setup-prioritizer.js';
import { KillzoneFilter } from './killzone-filter.js';
import { RangeDetector } from './range-detector.js';

// Timeframes to analyze (must be >= the input candle TF)
const ALL_TIMEFRAMES = ['5m', '15m', '1h', '4h'];

// Stop/target scaling by structure TF
const TF_DEFAULTS = {
  '4h': { maxStop: 80, defaultRR: 2.5, maxHoldBars: 960 },
  '1h': { maxStop: 40, defaultRR: 2.0, maxHoldBars: 240 },
  '15m': { maxStop: 25, defaultRR: 2.0, maxHoldBars: 120 },
  '5m': { maxStop: 15, defaultRR: 2.0, maxHoldBars: 60 },
};

export class ICTMTFSweepStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.params = {
      // Active timeframes
      activeTimeframes: ['5m', '15m', '1h', '4h'],

      // Sweep detection
      sweepMinWick: 3,
      sweepRequireClose: true,

      // Structure detection
      swingLookback: 5,
      minSwingSize: 5,
      breakConfirmation: 2,

      // FVG/OB
      minFVGSize: 1,
      fvgEntryMode: 'ce',  // 'ce' (midpoint) or 'edge'
      useOBEntry: true,

      // Risk management
      stopBuffer: 3,
      defaultRR: 2.0,
      maxStopPoints: 50,
      minRR: 1.0,

      // Trade management
      maxTradesPerDay: 999,
      maxHoldBars: 240,
      signalCooldownMs: 0,

      // Filtering
      requireKillzone: false,
      requireTFAlignment: true,
      tfAlignmentMode: 'any_htf',   // 'any_htf', 'majority', 'none'
      priorityMode: 'highest_tf',

      // Equal level detection
      equalLevelTolerance: 3,

      // Setup management
      maxConcurrentSetups: 50,
      expiryMultiplier: 1.0,

      // 1m confirmation (deferred entry)
      confirmationDeadline: 5,
      zoneInvalidationBuffer: 5,

      // Fibonacci retracement
      requireFibZone: false,

      // Entry models
      useDirectEntry: true,
      useMomentumContinuation: true,

      // Daily open bias
      dailyOpenBiasTolerance: 5,

      // Direction filter
      useLongEntries: true,
      useShortEntries: true,

      // Standard
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      debug: false,

      ...params
    };

    // Parse active timeframes from string if needed
    if (typeof this.params.activeTimeframes === 'string') {
      this.params.activeTimeframes = this.params.activeTimeframes.split(',').map(s => s.trim());
    }

    // Filter to only valid higher TFs (1m is implicit as input)
    this.activeTimeframes = this.params.activeTimeframes.filter(tf => ALL_TIMEFRAMES.includes(tf));

    // Candle aggregator for multi-TF streams
    this.aggregator = new CandleAggregator();

    // Per-TF analyzers
    this.analyzers = {};
    for (const tf of this.activeTimeframes) {
      this.analyzers[tf] = new TimeframeAnalyzer({
        timeframe: tf,
        swingLookback: this.params.swingLookback,
        minFVGSize: this.params.minFVGSize,
        minSwingSize: this.params.minSwingSize,
        breakConfirmation: this.params.breakConfirmation,
      });
    }

    // Shared components
    this.liquidityTracker = new LiquidityPoolTracker({
      sweepMinWick: this.params.sweepMinWick,
      sweepRequireClose: this.params.sweepRequireClose,
      equalLevelTolerance: this.params.equalLevelTolerance,
      dailyOpenBiasTolerance: this.params.dailyOpenBiasTolerance,
    });

    this.rangeDetector = new RangeDetector();

    this.setupTracker = new SetupTracker({
      maxSetups: this.params.maxConcurrentSetups,
      expiryMultiplier: this.params.expiryMultiplier,
      debug: this.params.debug,
      requireConfirmation: true,
      confirmationDeadline: this.params.confirmationDeadline,
      zoneInvalidationBuffer: this.params.zoneInvalidationBuffer,
    });

    this.prioritizer = new SetupPrioritizer({
      priorityMode: this.params.priorityMode,
    });

    this.killzoneFilter = new KillzoneFilter({
      requireKillzone: this.params.requireKillzone,
    });

    // Track candle counts per TF for new-candle detection
    this.lastCandleCount = {};
    for (const tf of this.activeTimeframes) {
      this.lastCandleCount[tf] = 0;
    }

    // Daily tracking
    this.currentDay = null;
    this.tradesThisDay = 0;

    // Candle counter for 1m
    this.candleCount = 0;
  }

  reset() {
    super.reset();
    this.candleCount = 0;
    this.currentDay = null;
    this.tradesThisDay = 0;

    for (const tf of this.activeTimeframes) {
      this.analyzers[tf].reset();
      this.lastCandleCount[tf] = 0;
    }

    this.liquidityTracker.reset();
    this.setupTracker.reset();
    this.rangeDetector.reset();

    // Reset aggregator state
    this.aggregator = new CandleAggregator();
  }

  /**
   * Main entry: evaluate on each 1m candle close
   */
  evaluateSignal(candle, prevCandle, marketData = {}, options = {}) {
    const ts = this.toMs(candle.timestamp);
    this.candleCount++;

    // Track daily resets
    this._updateDayTracking(candle, ts);

    // Daily trade limit
    if (this.tradesThisDay >= this.params.maxTradesPerDay) return null;

    // Cooldown
    if (!this.checkCooldown(ts, this.params.signalCooldownMs)) return null;

    // 1. Update liquidity pools (PDH/PDL, sessions, etc.) and range detector
    this.liquidityTracker.processCandle(candle);
    this.rangeDetector.processCandle(candle, this.liquidityTracker.currentDay);

    // 2. Feed candle to each TF aggregation stream and run analyzers
    for (const tf of this.activeTimeframes) {
      const candles = this.aggregator.addCandleIncremental(candle, tf, 'mtf');
      const currentCount = candles.length;

      // Check if a new candle completed on this TF
      if (currentCount > this.lastCandleCount[tf] && this.lastCandleCount[tf] > 0) {
        // The second-to-last element is the just-completed candle
        const completedCandle = candles[candles.length - 2];
        if (completedCandle) {
          this._processCompletedCandle(tf, completedCandle, ts);
        }
      }
      this.lastCandleCount[tf] = currentCount;
    }

    // 3. Check for sweeps on 1m candles against all liquidity pools
    this._checkSweepsOnCandle(candle, ts);

    // 4. Try to advance setups (structure shifts and entry zones)
    this._tryAdvanceSetups(ts);

    // 5. Expire stale setups
    this.setupTracker.expireOldSetups();

    // 5b. Invalidate mitigated entry zones (price closed through zone)
    this.setupTracker.checkZoneMitigation(candle);

    // 6a. Check for zone touches on ENTRY_ZONE setups → mark ENTRY_PENDING
    const zoneTouches = this.setupTracker.checkZoneTouches(candle, this.params.fvgEntryMode);
    for (const touch of zoneTouches) {
      this.setupTracker.markEntryPending(touch.id, candle);
    }

    // 6b. Check ENTRY_PENDING setups for 1m confirmation
    const entryReady = this.setupTracker.checkConfirmation(candle, this.params.fvgEntryMode);
    if (entryReady.length === 0) return null;

    // 7. Filter entries
    const filtered = entryReady.filter(setup => this._filterEntry(setup, candle, ts));
    if (filtered.length === 0) return null;

    // 8. Prioritize and return best signal
    const best = this.prioritizer.pick(filtered);
    if (!best) return null;

    const signal = this._buildSignal(best, candle, ts);
    if (!signal) return null;

    // Cleanup: remove the used setup
    this.setupTracker.removeSetup(best.id);

    this.updateLastSignalTime(ts);
    this.tradesThisDay++;

    return signal;
  }

  // ── Process completed higher-TF candle ────────────────────

  _processCompletedCandle(tf, candle, currentTs) {
    const analyzer = this.analyzers[tf];
    const result = analyzer.processCandle(candle);

    // Register new swings with liquidity tracker
    if (result.newSwings.length > 0) {
      this.liquidityTracker.addSwingLevels(result.newSwings, tf);
    }

    // Tick setup candle counters for this TF
    this.setupTracker.tickCandles(tf);

    // If structure shift detected, try to advance SWEEP → STRUCTURE_SHIFT setups
    if (result.structureShift) {
      const sweepSetups = this.setupTracker.getSetupsByPhase('SWEEP');
      for (const setup of sweepSetups) {
        if (setup.structureTF === tf && setup.direction === result.structureShift.direction) {
          this.setupTracker.advanceToStructureShift(setup.id, result.structureShift);
        }
      }

      // STRUCTURE_RETRACE model: every structure shift creates a direct retrace setup
      this.setupTracker.createRetraceSetup(result.structureShift, tf);

      // STRUCTURE_DIRECT model: scan active FVGs/OBs and create direct setups
      if (this.params.useDirectEntry) {
        this._createDirectSetups(result.structureShift, tf);
      }
    }

    // If new FVGs or OBs found, try to advance STRUCTURE_SHIFT → ENTRY_ZONE
    if (result.newFVGs.length > 0 || result.newOBs.length > 0) {
      const shiftSetups = this.setupTracker.getSetupsByPhase('STRUCTURE_SHIFT');
      for (const setup of shiftSetups) {
        this._tryAssignEntryZone(setup, tf, result);
      }
    }

    // MOMENTUM_CONTINUATION: check for filled+rejected FVGs
    if (this.params.useMomentumContinuation && result.filledRejections.length > 0) {
      for (const rejection of result.filledRejections) {
        this.setupTracker.createMomentumSetup(rejection, tf);
        analyzer.consumeRejection(rejection);
      }
    }
  }

  /**
   * STRUCTURE_DIRECT: When a structure shift fires, scan all active FVGs/OBs
   * that already exist (candleAge <= 3) in matching direction across entry TFs.
   */
  _createDirectSetups(structureShift, structureTF) {
    const entryTFs = this._getEntryTFsForStructure(structureTF);
    const direction = structureShift.direction;

    for (const tf of entryTFs) {
      const analyzer = this.analyzers[tf];
      if (!analyzer) continue;

      // Check existing FVGs
      const fvgs = analyzer.getActiveFVGs(direction);
      for (const fvg of fvgs) {
        if (fvg.candleAge <= 3) {
          this.setupTracker.createDirectSetup(structureShift, structureTF, {
            type: 'fvg',
            top: fvg.top,
            bottom: fvg.bottom,
            midpoint: fvg.midpoint,
            timestamp: fvg.timestamp,
            entryTF: tf,
          });
        }
      }

      // Check existing OBs
      if (this.params.useOBEntry) {
        const obs = analyzer.getActiveOBs(direction);
        for (const ob of obs) {
          if (ob.candleAge <= 3) {
            this.setupTracker.createDirectSetup(structureShift, structureTF, {
              type: 'ob',
              top: ob.high,
              bottom: ob.low,
              midpoint: ob.midpoint,
              timestamp: ob.timestamp,
              entryTF: tf,
            });
          }
        }
      }
    }
  }

  // ── Sweep Detection on 1m ─────────────────────────────────

  _checkSweepsOnCandle(candle, ts) {
    const pools = this.liquidityTracker.getLiquidityPools(candle.close, ts);

    for (const pool of pools) {
      const sweepResult = this.liquidityTracker.checkSweep(candle, pool);
      if (!sweepResult) continue;

      // Create setups for each active TF that could reasonably use this sweep
      // Higher TF setups from lower TF sweeps: PDH/PDL sweeps create setups for all TFs
      // Session/swing sweeps create setups for lower TFs only
      const tfCandidates = this._getTFCandidatesForPool(pool);

      for (const tf of tfCandidates) {
        this.setupTracker.createSetup(
          { direction: sweepResult.direction, sweepPrice: sweepResult.sweepPrice, timestamp: ts },
          tf,
          pool
        );
      }
    }
  }

  _getTFCandidatesForPool(pool) {
    // PDH/PDL and monthly open sweeps are high-conviction — create setups for all TFs
    if (pool.type === 'PDH' || pool.type === 'PDL' || pool.type === 'monthly_open') {
      return this.activeTimeframes;
    }

    // Weekly open sweeps feed all TFs (like PDH/PDL)
    if (pool.type === 'weekly_open') {
      return this.activeTimeframes;
    }

    // Daily open and session sweeps — medium conviction
    if (pool.source === 'session' || pool.type === 'daily_open') {
      return this.activeTimeframes.filter(tf => ['5m', '15m', '1h'].includes(tf));
    }

    // Equal H/L and swing levels — lower TFs only
    return this.activeTimeframes.filter(tf => ['5m', '15m'].includes(tf));
  }

  // ── Advance Setups ────────────────────────────────────────

  _tryAdvanceSetups(currentTs) {
    // Check if any STRUCTURE_SHIFT setups can find entry zones
    const shiftSetups = this.setupTracker.getSetupsByPhase('STRUCTURE_SHIFT');
    for (const setup of shiftSetups) {
      // Look for FVGs/OBs in the structure TF and lower TFs
      const entryTFs = this._getEntryTFsForStructure(setup.structureTF);
      for (const tf of entryTFs) {
        const analyzer = this.analyzers[tf];
        if (!analyzer) continue;

        const direction = setup.direction;

        // Check FVGs
        const fvgs = analyzer.getActiveFVGs(direction);
        if (fvgs.length > 0) {
          // Use the most recent FVG
          const fvg = fvgs[fvgs.length - 1];
          this.setupTracker.advanceToEntryZone(setup.id, {
            type: 'fvg',
            top: fvg.top,
            bottom: fvg.bottom,
            midpoint: fvg.midpoint,
            timestamp: fvg.timestamp,
            entryTF: tf,
          });
          break;
        }

        // Check OBs if enabled
        if (this.params.useOBEntry) {
          const obs = analyzer.getActiveOBs(direction);
          if (obs.length > 0) {
            const ob = obs[obs.length - 1];
            this.setupTracker.advanceToEntryZone(setup.id, {
              type: 'ob',
              top: ob.high,
              bottom: ob.low,
              midpoint: ob.midpoint,
              timestamp: ob.timestamp,
              entryTF: tf,
            });
            break;
          }
        }
      }
    }
  }

  _tryAssignEntryZone(setup, tf, analyzerResult) {
    const direction = setup.direction;
    const entryTFs = this._getEntryTFsForStructure(setup.structureTF);
    if (!entryTFs.includes(tf)) return;

    // Try FVGs first
    for (const fvg of analyzerResult.newFVGs) {
      if ((direction === 'bullish' && fvg.type === 'bullish') ||
          (direction === 'bearish' && fvg.type === 'bearish')) {
        this.setupTracker.advanceToEntryZone(setup.id, {
          type: 'fvg',
          top: fvg.top,
          bottom: fvg.bottom,
          midpoint: fvg.midpoint,
          timestamp: fvg.timestamp,
          entryTF: tf,
        });
        return;
      }
    }

    // Try OBs if enabled
    if (this.params.useOBEntry) {
      for (const ob of analyzerResult.newOBs) {
        if ((direction === 'bullish' && ob.type === 'bullish') ||
            (direction === 'bearish' && ob.type === 'bearish')) {
          this.setupTracker.advanceToEntryZone(setup.id, {
            type: 'ob',
            top: ob.high,
            bottom: ob.low,
            midpoint: ob.midpoint,
            timestamp: ob.timestamp,
            entryTF: tf,
          });
          return;
        }
      }
    }
  }

  /**
   * Get valid entry TFs for a given structure TF
   * Higher structure TF → can use same or lower TF for entry
   */
  _getEntryTFsForStructure(structureTF) {
    const tfOrder = ['5m', '15m', '1h', '4h'];
    const structIdx = tfOrder.indexOf(structureTF);
    if (structIdx === -1) return this.activeTimeframes;

    // Entry TF can be the structure TF or any lower TF
    return tfOrder.slice(0, structIdx + 1).filter(tf => this.activeTimeframes.includes(tf));
  }

  // ── Entry Filtering ───────────────────────────────────────

  _filterEntry(setup, candle, ts) {
    // Direction filter
    if (setup.direction === 'bullish' && !this.params.useLongEntries) return false;
    if (setup.direction === 'bearish' && !this.params.useShortEntries) return false;

    // Killzone filter
    const kzResult = this.killzoneFilter.isEntryAllowed(ts, setup.structureTF);
    setup.isKillzone = kzResult.inKillzone;
    if (!kzResult.allowed) return false;

    // TF alignment filter (optional)
    if (this.params.requireTFAlignment && this.params.tfAlignmentMode !== 'none') {
      if (!this._checkTFAlignment(setup.direction)) return false;
    }

    // Fib zone filter (optional — metadata always computed)
    if (setup.structureShift?.impulseRange && setup.entryZone) {
      setup.fibData = this.setupTracker.checkFibZoneOverlap(
        setup.entryZone, setup.structureShift.impulseRange, setup.direction
      );
      if (this.params.requireFibZone && !setup.fibData.inFibZone) return false;
    }

    // R:R check
    const rr = this._estimateRR(setup, candle);
    if (rr !== null) {
      setup.riskReward = rr;
      if (rr < (this.params.minRR || 1.5)) return false;
    }

    return true;
  }

  _checkTFAlignment(direction) {
    const mode = this.params.tfAlignmentMode || 'any_htf';

    if (mode === 'any_htf') {
      // Require 1H OR 4H to agree. If neither has an opinion (null), allow.
      const htfTFs = ['1h', '4h'];
      let anyAgree = false;
      let anyDisagree = false;

      for (const tf of htfTFs) {
        if (!this.analyzers[tf]) continue;
        const trend = this.analyzers[tf].trend;
        if (trend === direction) anyAgree = true;
        if (trend !== null && trend !== direction) anyDisagree = true;
      }

      // If at least one HTF agrees, allow
      if (anyAgree) return true;
      // If none have an opinion, allow
      if (!anyAgree && !anyDisagree) return true;
      // All that have opinions disagree
      return false;
    }

    // 'majority' mode: original behavior
    let agree = 0;
    let total = 0;

    for (const tf of this.activeTimeframes) {
      const trend = this.analyzers[tf].trend;
      if (trend !== null) {
        total++;
        if (trend === direction) agree++;
      }
    }

    return total === 0 || agree >= total * 0.5;
  }

  /**
   * Get HTF bias data for metadata
   */
  _getHTFBias(direction) {
    const bias = {};
    for (const tf of ['1h', '4h']) {
      if (this.analyzers[tf]) {
        bias[tf] = this.analyzers[tf].trend;
      }
    }
    bias.aligned = this._checkTFAlignment(direction);
    return bias;
  }

  _estimateRR(setup, candle) {
    if (!setup.entryPrice) return null;

    const tfDefaults = TF_DEFAULTS[setup.structureTF] || TF_DEFAULTS['15m'];
    const side = setup.direction === 'bullish' ? 'buy' : 'sell';

    // Stop: beyond the causal swing (or sweep extreme as fallback)
    const causalSwing = setup.structureShift?.causalSwing ?? null;
    let stopLoss;
    if (side === 'buy') {
      let stopRef;
      if (setup.sweepEvent) {
        const sweepFallback = Math.min(setup.sweepEvent.price, setup.sweepEvent.level);
        stopRef = (causalSwing !== null && causalSwing < setup.entryPrice)
          ? causalSwing : sweepFallback;
      } else {
        stopRef = causalSwing ?? (setup.entryZone?.bottom ?? setup.entryPrice) - 10;
      }
      stopLoss = stopRef - this.params.stopBuffer;
    } else {
      let stopRef;
      if (setup.sweepEvent) {
        const sweepFallback = Math.max(setup.sweepEvent.price, setup.sweepEvent.level);
        stopRef = (causalSwing !== null && causalSwing > setup.entryPrice)
          ? causalSwing : sweepFallback;
      } else {
        stopRef = causalSwing ?? (setup.entryZone?.top ?? setup.entryPrice) + 10;
      }
      stopLoss = stopRef + this.params.stopBuffer;
    }

    // Reject if stop is on wrong side of entry
    const stopOnCorrectSide = side === 'buy' ? stopLoss < setup.entryPrice : stopLoss > setup.entryPrice;
    if (!stopOnCorrectSide) return 0;

    const stopDistance = Math.abs(setup.entryPrice - stopLoss);
    if (stopDistance > (this.params.maxStopPoints || tfDefaults.maxStop)) return 0;
    if (stopDistance < 2) return 0;

    // Target: opposing liquidity pool or R:R ratio
    let opposing = null;
    if (setup.sweepEvent) {
      opposing = this.liquidityTracker.getOpposingPool(setup.sweepEvent, candle.close);
    } else {
      const syntheticPool = { direction: setup.direction === 'bullish' ? 'below' : 'above' };
      opposing = this.liquidityTracker.getOpposingPool(syntheticPool, candle.close);
    }
    let target;
    const rrTarget = side === 'buy'
      ? setup.entryPrice + stopDistance * (this.params.defaultRR || tfDefaults.defaultRR)
      : setup.entryPrice - stopDistance * (this.params.defaultRR || tfDefaults.defaultRR);

    if (opposing) {
      const oppDistance = Math.abs(opposing.price - setup.entryPrice);
      if (oppDistance >= stopDistance * 1.5) {
        target = opposing.price;
      } else {
        target = rrTarget;
      }
    } else {
      target = rrTarget;
    }

    const targetDistance = Math.abs(target - setup.entryPrice);
    return targetDistance / stopDistance;
  }

  // ── Signal Builder ────────────────────────────────────────

  _buildSignal(setup, candle, ts) {
    const side = setup.direction === 'bullish' ? 'buy' : 'sell';
    const tfDefaults = TF_DEFAULTS[setup.structureTF] || TF_DEFAULTS['15m'];

    // Stop loss: beyond the causal swing (the opposing swing point that existed
    // when the structure shift was detected) per JV eBook methodology.
    //   W pattern (BUY): stop below the swing LOW that caused the bullish shift
    //   M pattern (SELL): stop above the swing HIGH that caused the bearish shift
    // Fallback to sweep extreme if causalSwing is unavailable or on wrong side of entry.
    // RETRACE setups have no sweepEvent — fallback to causalSwing or zone boundary.
    const causalSwing = setup.structureShift?.causalSwing ?? null;
    let stopLoss;
    if (side === 'buy') {
      let stopRef;
      if (setup.sweepEvent) {
        const sweepFallback = Math.min(setup.sweepEvent.price, setup.sweepEvent.level);
        stopRef = (causalSwing !== null && causalSwing < setup.entryPrice)
          ? causalSwing : sweepFallback;
      } else {
        stopRef = causalSwing ?? (setup.entryZone?.bottom ?? setup.entryPrice) - 10;
      }
      stopLoss = stopRef - this.params.stopBuffer;
    } else {
      let stopRef;
      if (setup.sweepEvent) {
        const sweepFallback = Math.max(setup.sweepEvent.price, setup.sweepEvent.level);
        stopRef = (causalSwing !== null && causalSwing > setup.entryPrice)
          ? causalSwing : sweepFallback;
      } else {
        stopRef = causalSwing ?? (setup.entryZone?.top ?? setup.entryPrice) + 10;
      }
      stopLoss = stopRef + this.params.stopBuffer;
    }

    // Final guard: reject if stop is still on wrong side of entry
    const stopOnCorrectSide = side === 'buy' ? stopLoss < setup.entryPrice : stopLoss > setup.entryPrice;
    if (!stopOnCorrectSide) {
      if (this.params.debug) {
        console.log(`  [MTF] SKIP: inverted stop ${stopLoss.toFixed(2)} vs entry ${setup.entryPrice.toFixed(2)} (${side})`);
      }
      return null;
    }

    const stopDistance = Math.abs(setup.entryPrice - stopLoss);

    // Validate stop distance
    if (stopDistance > (this.params.maxStopPoints || tfDefaults.maxStop)) {
      if (this.params.debug) {
        console.log(`  [MTF] SKIP: stop ${stopDistance.toFixed(1)}pts > max ${tfDefaults.maxStop}`);
      }
      return null;
    }
    if (stopDistance < 2) {
      if (this.params.debug) {
        console.log(`  [MTF] SKIP: stop ${stopDistance.toFixed(1)}pts too tight`);
      }
      return null;
    }

    // Target: opposing liquidity pool or R:R ratio
    let opposing = null;
    if (setup.sweepEvent) {
      opposing = this.liquidityTracker.getOpposingPool(setup.sweepEvent, candle.close);
    } else {
      const syntheticPool = { direction: setup.direction === 'bullish' ? 'below' : 'above' };
      opposing = this.liquidityTracker.getOpposingPool(syntheticPool, candle.close);
    }
    let target;
    const rr = this.params.defaultRR || tfDefaults.defaultRR;
    const rrTarget = side === 'buy'
      ? setup.entryPrice + stopDistance * rr
      : setup.entryPrice - stopDistance * rr;

    if (opposing) {
      const oppDistance = Math.abs(opposing.price - setup.entryPrice);
      if (oppDistance >= stopDistance * 1.5) {
        // Use opposing pool but cap at R:R if it's too far
        target = side === 'buy'
          ? Math.min(opposing.price, setup.entryPrice + stopDistance * 4)
          : Math.max(opposing.price, setup.entryPrice - stopDistance * 4);
      } else {
        target = rrTarget;
      }
    } else {
      target = rrTarget;
    }

    const targetDistance = Math.abs(target - setup.entryPrice);
    const riskReward = targetDistance / stopDistance;

    if (this.params.debug) {
      console.log(`  [MTF] SIGNAL: ${side.toUpperCase()} @ ${setup.entryPrice.toFixed(2)} | SL ${stopLoss.toFixed(2)} (${stopDistance.toFixed(1)}pts) | TP ${target.toFixed(2)} (${targetDistance.toFixed(1)}pts) | R:R ${riskReward.toFixed(2)} | TF ${setup.structureTF}→${setup.entryTF} | ${new Date(ts).toISOString()}`);
    }

    // Compute enrichment metadata
    const dailyOpenBias = this.liquidityTracker.getDailyBias(candle.close);
    const htfBias = this._getHTFBias(setup.direction);
    const rangeContext = this.rangeDetector.getRangeContext();
    const dailyBarPattern = this.liquidityTracker.getDailyBarPattern();

    // Fib data (may already be computed in filter step)
    let fibData = setup.fibData || null;
    if (!fibData && setup.structureShift?.impulseRange && setup.entryZone) {
      fibData = this.setupTracker.checkFibZoneOverlap(
        setup.entryZone, setup.structureShift.impulseRange, setup.direction
      );
    }

    // Map entry model to signal type
    let signalType;
    switch (setup.entryModel) {
      case 'STRUCTURE_RETRACE': signalType = 'STRUCTURE_RETRACE'; break;
      case 'STRUCTURE_DIRECT': signalType = 'STRUCTURE_DIRECT'; break;
      case 'MOMENTUM_CONTINUATION': signalType = 'MOMENTUM_CONTINUATION'; break;
      default: signalType = setup.direction === 'bullish' ? 'W_PATTERN' : 'M_PATTERN';
    }

    // Composite trailing stop configuration
    const useComposite = this.params.useCompositeTrailing !== false;
    const compositeConfig = useComposite ? {
      activationThreshold: this.params.compositeActivationThreshold ?? 20, // MFE pts before composite kicks in
      postActivationTrailDistance: this.params.compositeTrailDistance ?? 40, // Fixed trail distance after activation
      entryZone: setup.entryZone || null,
      zoneBreakevenEnabled: this.params.compositeZoneBreakevenEnabled ?? false,
      structuralEnabled: this.params.compositeStructuralEnabled ?? false, // Disabled: too aggressive, cuts winners
      structuralThreshold: this.params.compositeStructuralThreshold ?? 20,
      swingLookback: this.params.compositeSwingLookback ?? 5,
      swingBuffer: this.params.compositeSwingBuffer ?? 8,
      minSwingSize: this.params.compositeMinSwingSize ?? 3,
      aggressiveThreshold: this.params.compositeAggressiveThreshold ?? 50,
      aggressiveTiers: this.params.compositeAggressiveTiers || [
        { mfe: 50, trailDistance: 25 },
        { mfe: 80, trailDistance: 15 },
      ],
      targetProximity: this.params.compositeTargetProximity ?? true,
      proximityPct: this.params.compositeProximityPct ?? 0.20,
      proximityTrailDistance: this.params.compositeProximityTrailDistance ?? 5,
    } : null;

    return {
      strategy: 'ICT_MTF_SWEEP',
      side,
      action: 'place_limit',
      symbol: candle.symbol || this.params.tradingSymbol,
      price: setup.entryPrice,
      stop_loss: stopLoss,
      take_profit: target,
      quantity: this.params.defaultQuantity,
      timeoutCandles: this.params.timeoutCandles ?? 5,
      maxHoldBars: this.params.maxHoldBars || tfDefaults.maxHoldBars,
      stopCheckMode: 'close', // JV eBook: stop triggers on candle close, not wick
      // Composite trailing handles zone breakeven internally (Phase 1)
      zoneTraverseStop: useComposite ? false : !!(setup.entryZone?.top != null && setup.entryZone?.bottom != null),
      breakevenStop: useComposite ? false : !!(setup.entryZone?.top != null && setup.entryZone?.bottom != null),
      compositeTrailing: useComposite,
      compositeConfig: compositeConfig,
      metadata: {
        entryModel: setup.entryModel || 'MW_PATTERN',
        signalType,
        structureTF: setup.structureTF,
        entryTF: setup.entryTF,
        sweepLevel: setup.sweepEvent?.level ?? null,
        sweepPrice: setup.sweepEvent?.price ?? null,
        sweepType: setup.sweepEvent?.type ?? null,
        sweepDirection: setup.direction,
        sweepTimestamp: setup.sweepEvent?.timestamp ?? null,
        structureShift: setup.structureShift,
        entryZone: setup.entryZone,
        causalSwing,
        targetPool: opposing ? { price: opposing.price, type: opposing.type } : null,
        isKillzone: setup.isKillzone,
        confirmationType: setup.confirmationType || null,
        riskReward,
        stopDistance,
        targetDistance,
        pdh: this.liquidityTracker.pdh,
        pdl: this.liquidityTracker.pdl,
        // New metadata fields
        dailyOpenBias,
        dailyOpen: this.liquidityTracker.dailyOpen,
        weeklyOpen: this.liquidityTracker.weeklyOpen,
        monthlyOpen: this.liquidityTracker.monthlyOpen,
        htfBias,
        rangeContext,
        dailyBarPattern,
        fibData,
      },
    };
  }

  // ── Day Tracking ──────────────────────────────────────────

  _updateDayTracking(candle, ts) {
    const d = new Date(ts);
    const etStr = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const etHour = this.killzoneFilter.getETHour(ts);
    const dayKey = etHour >= 18 ? this._getNextETDate(d) : etStr;

    if (dayKey !== this.currentDay) {
      this.currentDay = dayKey;
      this.tradesThisDay = 0;
    }
  }

  _getNextETDate(date) {
    const next = new Date(date.getTime() + 24 * 60 * 60 * 1000);
    return next.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  }
}

export default ICTMTFSweepStrategy;
