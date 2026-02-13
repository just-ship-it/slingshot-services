/**
 * ICT Smart Money Concepts Strategy
 *
 * A comprehensive ICT (Inner Circle Trader) strategy implementation that uses:
 * - 4H timeframe for structure analysis (CHoCH, MSS, Order Blocks)
 * - 5m timeframe for precise entries
 * - M/W pattern detection for reversal setups
 * - Structure-based stop losses (beyond swing that created shift)
 *
 * Signal Types:
 * - M_PATTERN: Bearish reversal pattern
 * - W_PATTERN: Bullish reversal pattern
 * - OB_BOUNCE: Order Block bounce trade
 * - MOMENTUM_CONTINUATION: Trend continuation after MSS
 */

import { BaseStrategy } from './base-strategy.js';
import { CandleAggregator } from '../utils/candle-aggregator.js';
import { ICTStructureAnalyzer } from '../indicators/ict-structure-analyzer.js';
import { ICTStateMachine } from './ict-smc/ict-state-machine.js';
import { MWPatternDetector } from './ict-smc/pattern-detector.js';
import { ICTEntryFinder } from './ict-smc/entry-finder.js';

// Volume Filter Imports (Phase 1 Order Flow)
import { VolumeDeltaProxy } from '../indicators/volume-delta-proxy.js';
import { VolumeTrendFilter, VolumeSpikeDetector } from '../indicators/volume-filters.js';
import { VolumeProfile } from '../indicators/volume-profile.js';

// CVD Filter Imports (Phase 3 Order Flow - True CVD from Databento)
import { CVDCalculator, CVDFilter } from '../indicators/cvd.js';

export class ICTSMCStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Default parameters
    this.params = {
      // Timeframe settings
      structureTimeframe: '4h',
      entryTimeframe: '5m',

      // Signal types to generate
      signalTypes: ['M_PATTERN', 'W_PATTERN', 'OB_BOUNCE', 'MOMENTUM_CONTINUATION'],

      // Fixed stop/target from CLI (when provided, overrides structure-based)
      stopLossPoints: null,      // Fixed stop distance in points (from CLI --stop-loss-points)
      targetPoints: null,        // Fixed target distance in points (from CLI --target-points)

      // Risk management
      maxStopDistance: 25,       // Maximum stop loss in points (fallback)
      maxTargetDistance: 75,     // Maximum target distance in points
      stopBuffer: 3,             // Additional buffer beyond structure
      targetMethod: 'rr_ratio',  // 'structure', 'rr_ratio', or 'liquidity' - rr_ratio is most reliable
      defaultRR: 2.0,            // Default risk:reward ratio

      // Order management
      timeoutCandles: 5,                 // Cancel unfilled limit orders after 5 candles (5 minutes on 1m)

      // Trailing stop
      useTrailingStop: params.useTrailingStop || false,
      trailingTrigger: params.trailingTrigger || 15,  // Points in profit to activate trailing
      trailingOffset: params.trailingOffset || 10,    // Points behind high water mark

      // Cooldown
      signalCooldownMs: 15 * 60 * 1000,  // 15 minutes

      // Session filter
      useSessionFilter: false,
      allowedSessions: ['rth', 'premarket'],

      // Structure analyzer settings
      choch: {
        swingLookback: 5,
        minSwingSize: 15,
        breakConfirmation: 2
      },

      // Order Block settings
      orderBlock: {
        minImpulseSize: 20,
        maxOrderBlockAge: 48,
        timeInZoneFilterEnabled: params.timeInZoneFilterEnabled === true,  // Default: disabled
        timeInZoneThreshold: params.timeInZoneThreshold || 0.33  // Invalidate OB if price spent >33% of time inside
      },

      // MSS settings
      mss: {
        breakBuffer: 2,
        requireCandleClose: true
      },

      // Entry settings
      entry: {
        maxEntryDistance: 50,
        minRiskReward: 1.5,
        entryTriggers: ['fvg_fill', 'ob_retest', 'choch_ltf', 'fib_retest'],
        // Range context filter - prevents countertrend entries at range extremes
        rangeFilterEnabled: params.rangeFilterEnabled === true,   // Default: disabled
        rangeExclusionZone: params.rangeExclusionZone || 0.20     // Don't short in bottom 20%, don't long in top 20%
      },

      // Pattern settings
      pattern: {
        patternTimeoutCandles: 100,
        minPatternRange: 25,
        sweepMinPenetration: 2,
        sweepMaxPenetration: 30
      },

      // LTF Confirmation settings (for OB retest entries)
      // When enabled, waits for sweep+reclaim or bullish pattern before entering
      ltfConfirmation: {
        enabled: params.ltfConfirmation?.enabled !== false,     // Default: enabled
        timeoutCandles: params.ltfConfirmation?.timeoutCandles || 15,
        minWickToBodyRatio: params.ltfConfirmation?.minWickToBodyRatio || 2.0,
        stopBuffer: params.ltfConfirmation?.stopBuffer || 3,
        ...(params.ltfConfirmation || {})
      },

      // Maximum risk per trade (used for LTF confirmation validation)
      maxRisk: params.maxRisk || 40,

      // GEX Proximity Filter
      // When enabled, longs must be within threshold of GEX support, shorts within threshold of resistance
      gexProximityFilter: params.gexProximityFilter || false,
      gexProximityThreshold: params.gexProximityThreshold || 20,  // Default 20 points based on analysis

      // Volume Filters (Phase 1 Order Flow)
      volumeDeltaFilter: params.volumeDeltaFilter || false,
      volumeDeltaLookback: params.volumeDeltaLookback || 5,
      volumeTrendFilter: params.volumeTrendFilter || false,
      volumeTrendPeriod: params.volumeTrendPeriod || 5,
      volumeSpikeFilter: params.volumeSpikeFilter || false,
      volumeSpikeThreshold: params.volumeSpikeThreshold || 1.5,
      volumeSpikePeriod: params.volumeSpikePeriod || 20,
      volumeProfileFilter: params.volumeProfileFilter || false,
      volumeProfilePocThreshold: params.volumeProfilePocThreshold || 10,

      // CVD Filters (Phase 3 Order Flow - True CVD from Databento)
      cvdDirectionFilter: params.cvdDirectionFilter || false,
      cvdSlopeLookback: params.cvdSlopeLookback || 5,
      cvdMinSlope: params.cvdMinSlope || 0,
      cvdDivergenceFilter: params.cvdDivergenceFilter || false,
      cvdDivergenceLookback: params.cvdDivergenceLookback || 20,
      cvdZeroCrossFilter: params.cvdZeroCrossFilter || false,
      cvdZeroCrossLookback: params.cvdZeroCrossLookback || 10,

      ...params
    };

    // Store current GEX data for proximity checks
    this.currentGexLevels = null;

    // Initialize Volume Filter Components (Phase 1 Order Flow)
    this.volumeDeltaProxy = new VolumeDeltaProxy({
      slopeLookback: this.params.volumeDeltaLookback
    });
    this.volumeTrendFilter = new VolumeTrendFilter({
      smaPeriod: this.params.volumeTrendPeriod
    });
    this.volumeSpikeDetector = new VolumeSpikeDetector({
      averagePeriod: this.params.volumeSpikePeriod,
      spikeThreshold: this.params.volumeSpikeThreshold
    });
    this.volumeProfile = new VolumeProfile({
      tickSize: 0.25  // NQ tick size
    });

    // Track last volume filter results for metadata
    this.lastVolumeFilterResults = null;

    // Initialize CVD Components (Phase 3 Order Flow - True CVD)
    this.cvdCalculator = new CVDCalculator({
      slopeLookback: this.params.cvdSlopeLookback,
      divergenceLookback: this.params.cvdDivergenceLookback
    });
    this.cvdFilter = new CVDFilter(this.cvdCalculator, {
      requireSlopeAlignment: this.params.cvdDirectionFilter,
      minSlope: this.params.cvdMinSlope,
      blockOnDivergence: this.params.cvdDivergenceFilter,
      divergenceLookback: this.params.cvdDivergenceLookback,
      requireRecentZeroCross: this.params.cvdZeroCrossFilter,
      zeroCrossLookback: this.params.cvdZeroCrossLookback
    });
    this.lastCvdFilterResults = null;
    this.cvdDataLoaded = false;

    // Initialize components
    this.candleAggregator = new CandleAggregator();

    this.structureAnalyzer = new ICTStructureAnalyzer({
      choch: this.params.choch,
      mss: this.params.mss,
      orderBlock: this.params.orderBlock
    });

    this.stateMachine = new ICTStateMachine({
      cooldownMs: this.params.signalCooldownMs,
      maxEntryDistance: this.params.maxStopDistance
    });

    this.patternDetector = new MWPatternDetector(this.params.pattern);

    // Pass ltfConfirmation settings to entry finder
    this.entryFinder = new ICTEntryFinder({
      ...this.params.entry,
      ltfConfirmation: this.params.ltfConfirmation
    });

    // Candle buffers for aggregation
    this.rawCandles = [];           // 1m candles
    this.htfCandles = [];           // 4H candles
    this.ltfCandles = [];           // 5m candles

    // Global candle counter (doesn't reset when buffer is trimmed)
    this.totalCandleCount = 0;

    // Last aggregation timestamps
    this.lastHTFTimestamp = 0;
    this.lastLTFTimestamp = 0;

    // Aggregation intervals in ms
    this.htfIntervalMs = this.candleAggregator.getIntervalMinutes(this.params.structureTimeframe) * 60 * 1000;
    this.ltfIntervalMs = this.candleAggregator.getIntervalMinutes(this.params.entryTimeframe) * 60 * 1000;

    // Analysis cache
    this.lastStructureAnalysis = null;
    this.lastPattern = null;

    // LTF Confirmation watching state
    this.watchingOB = null;           // The OB we're watching for confirmation
    this.watchingSide = null;         // 'buy' or 'sell'
    this.watchStartCandleIndex = 0;   // When we started watching
    this.watchingEntry = null;        // The original entry that triggered watching

    // Debug tracking
    this._lastLoggedBias = null;
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.rawCandles = [];
    this.htfCandles = [];
    this.ltfCandles = [];
    this.totalCandleCount = 0;
    this.lastHTFTimestamp = 0;
    this.lastLTFTimestamp = 0;
    this.lastStructureAnalysis = null;
    this.lastPattern = null;

    // Reset incremental aggregation state
    this.candleAggregator.resetIncremental(this.params.entryTimeframe, 'ltf');
    this.candleAggregator.resetIncremental(this.params.structureTimeframe, 'htf');

    // Reset LTF confirmation watching state
    this.watchingOB = null;
    this.watchingSide = null;
    this.watchStartCandleIndex = 0;
    this.watchingEntry = null;
    this.entryFinder.resetOBWatch();

    this.structureAnalyzer.reset();
    this.stateMachine.reset();
    this.patternDetector.reset();

    // Reset Volume Filters (Phase 1 Order Flow)
    this.volumeDeltaProxy.reset();
    this.volumeProfile.reset();
    this.lastVolumeFilterResults = null;

    // Reset CVD (Phase 3 Order Flow)
    this.cvdCalculator.reset();
    this.lastCvdFilterResults = null;
    this.cvdDataLoaded = false;
  }

  /**
   * Evaluate signal on new candle
   *
   * @param {Object} candle - Current 1m candle
   * @param {Object} prevCandle - Previous 1m candle
   * @param {Object} marketData - Additional market data (optional)
   * @param {Object} options - Options including session info
   * @returns {Object|null} Signal or null
   */
  evaluateSignal(candle, prevCandle, marketData = {}, options = {}) {
    const currentTime = this.toMs(candle.timestamp);

    // Store current GEX levels for proximity checks
    this.currentGexLevels = marketData.gexLevels || null;

    // Check cooldown (but allow if we're watching an OB for confirmation)
    const isWatching = this.watchingOB !== null;
    if (!isWatching && !this.checkCooldown(currentTime, this.params.signalCooldownMs)) {
      return null;
    }

    // Check session filter (but allow if we're watching an OB for confirmation)
    if (!isWatching && !this.isAllowedSession(currentTime)) {
      return null;
    }

    // Add candle to buffer and increment global counter
    this.rawCandles.push(candle);
    this.totalCandleCount++;
    const candleIndex = this.totalCandleCount;  // Use global counter, not array length

    // Keep buffer manageable (keep last 2000 1m candles = ~33 hours)
    if (this.rawCandles.length > 2000) {
      this.rawCandles = this.rawCandles.slice(-2000);
    }

    // Update Volume Indicators (Phase 1 Order Flow)
    // Process candle through volume delta proxy
    this.volumeDeltaProxy.processCandle(candle);
    // Add candle to volume profile
    this.volumeProfile.addCandle(candle);

    // Update timeframe aggregations
    this.updateAggregations(candle);

    // Need enough HTF candles for analysis
    if (this.htfCandles.length < 20) {
      return null;
    }

    // Run HTF structure analysis
    this.lastStructureAnalysis = this.structureAnalyzer.analyzeStructure(
      this.htfCandles,
      currentTime
    );

    // Run pattern detection
    this.lastPattern = this.patternDetector.analyze(
      this.htfCandles,
      this.lastStructureAnalysis
    );


    // Update state machine
    const stateResult = this.stateMachine.process(
      this.lastStructureAnalysis,
      { candle: candle, fvgs: [] },
      currentTime
    );

    // If watching an OB for LTF confirmation, check for confirmation first
    if (this.watchingOB) {
      const confirmation = this.checkLTFConfirmation(candle, candleIndex, currentTime);
      if (confirmation) {
        return confirmation;
      }
      // Still watching - don't look for new entries
      return null;
    }

    // Check for entry using LTF data
    const entry = this.findEntry(candle, currentTime);

    if (entry) {
      // Check if this is a "watching" status (LTF confirmation enabled)
      if (entry.status === 'watching') {
        this.startWatchingOB(entry, candleIndex);
        return null;  // Don't generate signal yet, wait for confirmation
      }

      // Generate signal based on entry type
      const signal = this.generateSignal(entry, candle, currentTime);

      if (signal) {
        this.updateLastSignalTime(currentTime);
        return signal;
      }
    }

    return null;
  }

  /**
   * Start watching an OB for LTF confirmation
   * @param {Object} entry - Entry with status 'watching'
   * @param {number} candleIndex - Current candle index
   */
  startWatchingOB(entry, candleIndex) {
    this.watchingOB = entry.orderBlock;
    this.watchingSide = entry.side;
    this.watchStartCandleIndex = candleIndex;
    this.watchingEntry = entry;

    // Start watching in the entry finder's LTF confirmation module
    this.entryFinder.startWatchingOB(entry.orderBlock, entry.side, candleIndex);
  }

  /**
   * Clear the OB watching state
   */
  clearWatchingOB() {
    this.watchingOB = null;
    this.watchingSide = null;
    this.watchStartCandleIndex = 0;
    this.watchingEntry = null;
    this.entryFinder.resetOBWatch();
  }

  /**
   * Check for LTF confirmation on the watched OB
   * @param {Object} candle - Current 1m candle
   * @param {number} candleIndex - Current candle index
   * @param {number} currentTime - Current timestamp
   * @returns {Object|null} Signal if confirmed, null otherwise
   */
  checkLTFConfirmation(candle, candleIndex, currentTime) {
    const confirmation = this.entryFinder.checkOBConfirmation(candle, candleIndex);

    if (!confirmation || confirmation.status === 'not_watching') {
      // Something went wrong, clear state
      this.clearWatchingOB();
      return null;
    }

    if (confirmation.status === 'timeout') {
      // Timeout - OB didn't confirm within the allowed candles
      this.clearWatchingOB();
      return null;
    }

    if (confirmation.status === 'watching') {
      // Still watching, no confirmation yet
      return null;
    }

    if (confirmation.status === 'confirmed') {
      // LTF confirmation received - generate signal
      const entry = {
        ...this.watchingEntry,
        status: 'entry',
        price: confirmation.entryPrice,
        confirmationCandle: confirmation.confirmationCandle,
        confirmationType: confirmation.confirmationType,
        confirmationStopPrice: confirmation.stopPrice,
        trigger: 'ob_retest',
        signalType: this.determineSignalType(this.watchingEntry, this.lastPattern)
      };

      // Validate stop distance against maxRisk
      const stopDistance = Math.abs(confirmation.entryPrice - confirmation.stopPrice);
      if (stopDistance > this.params.maxRisk) {
        // Stop too far, skip this entry
        this.clearWatchingOB();
        return null;
      }

      // Generate signal with confirmation-based stop
      const signal = this.generateSignalWithConfirmation(entry, candle, currentTime, confirmation);

      this.clearWatchingOB();

      if (signal) {
        this.updateLastSignalTime(currentTime);
        return signal;
      }
    }

    return null;
  }

  /**
   * Generate signal with LTF confirmation-based stop
   * @param {Object} entry
   * @param {Object} candle
   * @param {number} currentTime
   * @param {Object} confirmation
   * @returns {Object|null}
   */
  generateSignalWithConfirmation(entry, candle, currentTime, confirmation) {
    const side = entry.side;
    const entryPrice = confirmation.entryPrice;

    // Check GEX proximity filter
    const gexProximity = this.checkGexProximity(side, entryPrice);
    if (!gexProximity.passes) {
      return null; // Entry not near favorable GEX level
    }

    // Check Volume Filters (Phase 1 Order Flow)
    const volumeFilterResult = this.checkVolumeFilters(side, candle);
    if (!volumeFilterResult.passes) {
      return null; // Volume conditions not met
    }

    // Check CVD Filters (Phase 3 Order Flow - True CVD)
    const recentPrices = this.rawCandles.slice(-this.params.cvdDivergenceLookback).map(c => c.close);
    const cvdFilterResult = this.checkCVDFilters(side, candle, recentPrices);
    if (!cvdFilterResult.passes) {
      return null; // CVD conditions not met
    }

    let stopLoss = confirmation.stopPrice;

    // Validate stop is on correct side
    if (side === 'buy' && stopLoss >= entryPrice) {
      stopLoss = entryPrice - this.params.maxRisk;
    } else if (side === 'sell' && stopLoss <= entryPrice) {
      stopLoss = entryPrice + this.params.maxRisk;
    }

    const stopDistance = Math.abs(entryPrice - stopLoss);

    // Ensure minimum stop distance
    if (stopDistance < 5) {
      if (side === 'buy') {
        stopLoss = entryPrice - 10;
      } else {
        stopLoss = entryPrice + 10;
      }
    }

    // Calculate target
    const target = this.calculateTarget(entry, side, entryPrice, stopDistance);

    // Calculate risk:reward
    const targetDistance = Math.abs(target - entryPrice);
    const riskReward = targetDistance / stopDistance;

    // Skip R:R validation when using fixed stops/targets
    if (this.params.stopLossPoints || this.params.targetPoints) {
      // Using fixed values - skip R:R filter
    } else if (riskReward < this.params.entry.minRiskReward) {
      return null;
    }

    // Build metadata
    const structureAnalysis = this.lastStructureAnalysis || {};
    const lastCHoCH = this.structureAnalyzer.lastCHoCH;
    const lastMSS = this.structureAnalyzer.lastMSS;

    return {
      strategy: 'ICT_SMC',
      side: side,
      action: 'place_limit',
      symbol: candle.symbol || 'NQ1!',
      price: entryPrice,
      stop_loss: stopLoss,
      take_profit: target,
      quantity: 1,
      timeoutCandles: this.params.timeoutCandles,
      signalType: entry.signalType,
      // Trailing stop parameters
      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,
      metadata: {
        signalType: entry.signalType,
        structureTF: this.params.structureTimeframe,
        entryTF: this.params.entryTimeframe,
        htfBias: structureAnalysis.bias,
        trigger: entry.trigger,
        confidence: structureAnalysis.confidence || 0,
        riskReward: riskReward,

        // LTF Confirmation details
        confirmationType: confirmation.confirmationType,
        confirmationConfidence: confirmation.confidence,

        // Order Block details
        orderBlock: entry.orderBlock ? {
          high: entry.orderBlock.high,
          low: entry.orderBlock.low,
          timestamp: entry.orderBlock.timestamp,
          type: entry.orderBlock.type
        } : null,

        // CHoCH details
        chochLevel: lastCHoCH?.level || null,
        chochTime: lastCHoCH?.timestamp || null,
        chochType: lastCHoCH?.type || null,

        // MSS/BOS details
        mssLevel: lastMSS?.level || null,
        mssTime: lastMSS?.timestamp || null,
        mssType: lastMSS?.type || null,

        // Swing points
        swingHigh: structureAnalysis.swingHigh?.price || null,
        swingHighTime: structureAnalysis.swingHigh?.timestamp || null,
        swingLow: structureAnalysis.swingLow?.price || null,
        swingLowTime: structureAnalysis.swingLow?.timestamp || null,

        // Pattern details
        patternType: this.lastPattern?.type || null,
        patternStage: this.lastPattern?.stage || null,

        // GEX proximity filter info
        gexProximityDistance: gexProximity.distance,
        gexProximityLevel: gexProximity.level,
        gexProximityType: gexProximity.levelType,

        // Range context filter info
        rangeContext: entry.rangeContext ? {
          pricePosition: entry.rangeContext.pricePosition,
          rangeHigh: entry.rangeContext.rangeHigh,
          rangeLow: entry.rangeContext.rangeLow
        } : null,

        // Volume Filter results (Phase 1 Order Flow)
        volumeFilters: this.lastVolumeFilterResults ? {
          volumeDelta: this.lastVolumeFilterResults.volumeDelta,
          volumeTrend: this.lastVolumeFilterResults.volumeTrend,
          volumeSpike: this.lastVolumeFilterResults.volumeSpike,
          volumeProfile: this.lastVolumeFilterResults.volumeProfile
        } : null,

        // CVD Filter results (Phase 3 Order Flow - True CVD)
        cvdFilters: this.lastCvdFilterResults ? {
          passes: this.lastCvdFilterResults.passes,
          slope: this.lastCvdFilterResults.slope,
          cumulativeDelta: this.lastCvdFilterResults.cumulativeDelta,
          momentum: this.lastCvdFilterResults.momentum,
          zeroCross: this.lastCvdFilterResults.zeroCross
        } : null,

        timestamp: currentTime
      }
    };
  }

  /**
   * Update candle aggregations using incremental aggregation (O(1) per candle)
   * @param {Object} candle - New 1m candle
   */
  updateAggregations(candle) {
    // Use incremental aggregation - O(1) per candle instead of O(n)
    // The aggregator maintains state and only updates the current period

    // Update LTF candles incrementally
    this.ltfCandles = this.candleAggregator.addCandleIncremental(
      candle,
      this.params.entryTimeframe,
      'ltf'
    );

    // Update HTF candles incrementally
    this.htfCandles = this.candleAggregator.addCandleIncremental(
      candle,
      this.params.structureTimeframe,
      'htf'
    );
  }

  /**
   * Find entry using LTF analysis
   * @param {Object} currentCandle - Current 1m candle
   * @param {number} currentTime - Current timestamp
   * @returns {Object|null} Entry object or null
   */
  findEntry(currentCandle, currentTime) {
    if (!this.lastStructureAnalysis || this.lastStructureAnalysis.bias === 'neutral') {
      return null;
    }

    // Use the entry finder with LTF candles
    const entry = this.entryFinder.findEntry(
      this.ltfCandles,
      this.lastStructureAnalysis,
      this.lastPattern
    );

    if (entry) {
      // Determine signal type based on pattern and trigger
      entry.signalType = this.determineSignalType(entry, this.lastPattern);

      // Check if this signal type is enabled
      if (!this.params.signalTypes.includes(entry.signalType)) {
        return null;
      }
    }

    return entry;
  }

  /**
   * Determine the signal type based on entry and pattern
   * @param {Object} entry
   * @param {Object|null} pattern
   * @returns {string}
   */
  determineSignalType(entry, pattern) {
    // Check for M/W patterns first
    if (pattern) {
      if (pattern.type === 'M' && pattern.stage >= MWPatternDetector.STAGES.CHOCH) {
        return 'M_PATTERN';
      }
      if (pattern.type === 'W' && pattern.stage >= MWPatternDetector.STAGES.CHOCH) {
        return 'W_PATTERN';
      }
    }

    // Check entry trigger for OB_BOUNCE
    if (entry.trigger === 'ob_retest') {
      return 'OB_BOUNCE';
    }

    // Default to momentum continuation
    return 'MOMENTUM_CONTINUATION';
  }

  /**
   * Generate signal from entry
   * @param {Object} entry
   * @param {Object} candle
   * @param {number} currentTime
   * @returns {Object|null}
   */
  generateSignal(entry, candle, currentTime) {
    const side = entry.side;
    const entryPrice = entry.price;

    // Check GEX proximity filter
    const gexProximity = this.checkGexProximity(side, entryPrice);
    if (!gexProximity.passes) {
      return null; // Entry not near favorable GEX level
    }

    // Check Volume Filters (Phase 1 Order Flow)
    const volumeFilterResult = this.checkVolumeFilters(side, candle);
    if (!volumeFilterResult.passes) {
      return null; // Volume conditions not met
    }

    // Check CVD Filters (Phase 3 Order Flow - True CVD)
    const recentPrices = this.rawCandles.slice(-this.params.cvdDivergenceLookback).map(c => c.close);
    const cvdFilterResult = this.checkCVDFilters(side, candle, recentPrices);
    if (!cvdFilterResult.passes) {
      return null; // CVD conditions not met
    }

    // Calculate stop loss based on structure
    let stopLoss = this.calculateStopLoss(entry, side);

    // CRITICAL: Validate stop is on correct side
    if (side === 'buy' && stopLoss >= entryPrice) {
      // Stop must be BELOW entry for longs
      stopLoss = entryPrice - this.params.maxStopDistance;
    } else if (side === 'sell' && stopLoss <= entryPrice) {
      // Stop must be ABOVE entry for shorts
      stopLoss = entryPrice + this.params.maxStopDistance;
    }

    // Validate stop distance (skip validation if using fixed stops from CLI)
    const stopDistance = Math.abs(entryPrice - stopLoss);
    const maxAllowedStop = this.params.stopLossPoints || this.params.maxStopDistance;
    if (stopDistance > maxAllowedStop) {
      return null; // Stop too far
    }

    // Ensure minimum stop distance (avoid stops that are too tight)
    if (stopDistance < 5) {
      if (side === 'buy') {
        stopLoss = entryPrice - 10;
      } else {
        stopLoss = entryPrice + 10;
      }
    }

    // Calculate target
    const target = this.calculateTarget(entry, side, entryPrice, stopDistance);

    // Calculate risk:reward
    const targetDistance = Math.abs(target - entryPrice);
    const riskReward = targetDistance / stopDistance;

    // Skip R:R validation when using fixed stops/targets (baseline testing mode)
    // The user controls R:R via their fixed stop/target settings
    if (this.params.stopLossPoints || this.params.targetPoints) {
      // Using fixed values - skip R:R filter
    } else if (riskReward < this.params.entry.minRiskReward) {
      return null;
    }

    // Build detailed metadata for trade reconstruction
    const structureAnalysis = this.lastStructureAnalysis || {};

    // Get persisted CHoCH/MSS from structure analyzer (these persist across candles)
    const lastCHoCH = this.structureAnalyzer.lastCHoCH;
    const lastMSS = this.structureAnalyzer.lastMSS;

    return {
      strategy: 'ICT_SMC',
      side: side,
      action: 'place_limit',
      symbol: candle.symbol || 'NQ1!',
      price: entryPrice,
      stop_loss: stopLoss,
      take_profit: target,
      quantity: 1,
      timeoutCandles: this.params.timeoutCandles,  // Cancel unfilled limit orders after N candles
      signalType: entry.signalType,
      // Trailing stop parameters
      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,
      metadata: {
        signalType: entry.signalType,
        structureTF: this.params.structureTimeframe,
        entryTF: this.params.entryTimeframe,
        htfBias: structureAnalysis.bias,
        trigger: entry.trigger,
        confidence: structureAnalysis.confidence || 0,
        riskReward: riskReward,

        // Order Block details
        orderBlock: entry.orderBlock ? {
          high: entry.orderBlock.high,
          low: entry.orderBlock.low,
          timestamp: entry.orderBlock.timestamp,
          type: entry.orderBlock.type
        } : null,

        // FVG details
        fvg: entry.fvg ? {
          top: entry.fvg.top,
          bottom: entry.fvg.bottom,
          timestamp: entry.fvg.timestamp
        } : null,

        // Fibonacci details
        fibLevel: entry.fibLevel || null,
        fibPrice: entry.fibPrice || null,

        // CHoCH details (use persisted values that don't reset each candle)
        chochLevel: lastCHoCH?.level || null,
        chochTime: lastCHoCH?.timestamp || null,
        chochType: lastCHoCH?.type || null,

        // MSS/BOS details (use persisted values)
        mssLevel: lastMSS?.level || null,
        mssTime: lastMSS?.timestamp || null,
        mssType: lastMSS?.type || null,

        // Swing points used for structure
        swingHigh: structureAnalysis.swingHigh?.price || null,
        swingHighTime: structureAnalysis.swingHigh?.timestamp || null,
        swingLow: structureAnalysis.swingLow?.price || null,
        swingLowTime: structureAnalysis.swingLow?.timestamp || null,

        // Pattern details
        patternType: this.lastPattern?.type || null,
        patternStage: this.lastPattern?.stage || null,

        // GEX proximity filter info
        gexProximityDistance: gexProximity.distance,
        gexProximityLevel: gexProximity.level,
        gexProximityType: gexProximity.levelType,

        // Range context filter info
        rangeContext: entry.rangeContext ? {
          pricePosition: entry.rangeContext.pricePosition,
          rangeHigh: entry.rangeContext.rangeHigh,
          rangeLow: entry.rangeContext.rangeLow
        } : null,

        // Volume Filter results (Phase 1 Order Flow)
        volumeFilters: this.lastVolumeFilterResults ? {
          volumeDelta: this.lastVolumeFilterResults.volumeDelta,
          volumeTrend: this.lastVolumeFilterResults.volumeTrend,
          volumeSpike: this.lastVolumeFilterResults.volumeSpike,
          volumeProfile: this.lastVolumeFilterResults.volumeProfile
        } : null,

        // CVD Filter results (Phase 3 Order Flow - True CVD)
        cvdFilters: this.lastCvdFilterResults ? {
          passes: this.lastCvdFilterResults.passes,
          slope: this.lastCvdFilterResults.slope,
          cumulativeDelta: this.lastCvdFilterResults.cumulativeDelta,
          momentum: this.lastCvdFilterResults.momentum,
          zeroCross: this.lastCvdFilterResults.zeroCross
        } : null,

        timestamp: currentTime
      }
    };
  }

  /**
   * Calculate stop loss based on structure
   * @param {Object} entry
   * @param {string} side
   * @returns {number}
   */
  calculateStopLoss(entry, side) {
    const buffer = this.params.stopBuffer;
    const entryPrice = entry.price;

    // If fixed stop loss is specified via CLI, use it
    if (this.params.stopLossPoints) {
      return side === 'buy'
        ? entryPrice - this.params.stopLossPoints
        : entryPrice + this.params.stopLossPoints;
    }

    // For BUY: stop must be BELOW entry
    // For SELL: stop must be ABOVE entry

    if (side === 'buy') {
      // Try swing low first (most appropriate for longs)
      if (this.lastStructureAnalysis?.swingLow) {
        const swingLowPrice = this.lastStructureAnalysis.swingLow.price;
        // Only use if it's below entry
        if (swingLowPrice < entryPrice) {
          return swingLowPrice - buffer;
        }
      }

      // Try structure level if it's a swing_low type and below entry
      if (this.lastStructureAnalysis?.structureLevel) {
        const structurePrice = this.lastStructureAnalysis.structureLevel.price;
        if (structurePrice < entryPrice) {
          return structurePrice - buffer;
        }
      }

      // Try pattern-based stop
      if (this.lastPattern?.keyLevels?.stopLevel) {
        const patternStop = this.lastPattern.keyLevels.stopLevel;
        if (patternStop < entryPrice) {
          return patternStop;
        }
      }

      // Fallback - use fixed distance below entry
      return entryPrice - this.params.maxStopDistance;

    } else {
      // SELL - stop must be ABOVE entry

      // Try swing high first (most appropriate for shorts)
      if (this.lastStructureAnalysis?.swingHigh) {
        const swingHighPrice = this.lastStructureAnalysis.swingHigh.price;
        // Only use if it's above entry
        if (swingHighPrice > entryPrice) {
          return swingHighPrice + buffer;
        }
      }

      // Try structure level if it's above entry
      if (this.lastStructureAnalysis?.structureLevel) {
        const structurePrice = this.lastStructureAnalysis.structureLevel.price;
        if (structurePrice > entryPrice) {
          return structurePrice + buffer;
        }
      }

      // Try pattern-based stop
      if (this.lastPattern?.keyLevels?.stopLevel) {
        const patternStop = this.lastPattern.keyLevels.stopLevel;
        if (patternStop > entryPrice) {
          return patternStop;
        }
      }

      // Fallback - use fixed distance above entry
      return entryPrice + this.params.maxStopDistance;
    }
  }

  /**
   * Calculate target based on method
   * @param {Object} entry
   * @param {string} side
   * @param {number} entryPrice
   * @param {number} stopDistance
   * @returns {number}
   */
  calculateTarget(entry, side, entryPrice, stopDistance) {
    // If fixed target is specified via CLI, use it
    if (this.params.targetPoints) {
      return side === 'buy'
        ? entryPrice + this.params.targetPoints
        : entryPrice - this.params.targetPoints;
    }

    const maxTarget = this.params.maxTargetDistance || 75;

    switch (this.params.targetMethod) {
      case 'structure':
        return this.calculateStructureTarget(entry, side, entryPrice, stopDistance);

      case 'rr_ratio': {
        let targetDistance = stopDistance * this.params.defaultRR;
        targetDistance = Math.min(targetDistance, maxTarget);
        return side === 'buy' ? entryPrice + targetDistance : entryPrice - targetDistance;
      }

      case 'liquidity':
        return this.calculateLiquidityTarget(entry, side, entryPrice, stopDistance);

      default: {
        // Default to R:R method
        let defaultTarget = stopDistance * this.params.defaultRR;
        defaultTarget = Math.min(defaultTarget, maxTarget);
        return side === 'buy' ? entryPrice + defaultTarget : entryPrice - defaultTarget;
      }
    }
  }

  /**
   * Calculate structure-based target
   * @param {Object} entry
   * @param {string} side
   * @param {number} entryPrice
   * @param {number} stopDistance
   * @returns {number}
   */
  calculateStructureTarget(entry, side, entryPrice, stopDistance) {
    const maxTarget = this.params.maxTargetDistance || 75;

    // Use swing points as targets
    if (side === 'buy' && this.lastStructureAnalysis?.swingHigh) {
      const targetPrice = this.lastStructureAnalysis.swingHigh.price;
      const targetDist = targetPrice - entryPrice;
      // Ensure minimum R:R AND maximum target distance
      if (targetDist >= stopDistance * this.params.entry.minRiskReward && targetDist <= maxTarget) {
        return targetPrice;
      }
    } else if (side === 'sell' && this.lastStructureAnalysis?.swingLow) {
      const targetPrice = this.lastStructureAnalysis.swingLow.price;
      const targetDist = entryPrice - targetPrice;
      // Ensure minimum R:R AND maximum target distance
      if (targetDist >= stopDistance * this.params.entry.minRiskReward && targetDist <= maxTarget) {
        return targetPrice;
      }
    }

    // Fallback to R:R method (capped at max target)
    let targetDistance = stopDistance * this.params.defaultRR;
    targetDistance = Math.min(targetDistance, maxTarget);
    return side === 'buy' ? entryPrice + targetDistance : entryPrice - targetDistance;
  }

  /**
   * Calculate liquidity-based target (PDH/PDL, session highs/lows)
   * @param {Object} entry
   * @param {string} side
   * @param {number} entryPrice
   * @param {number} stopDistance
   * @returns {number}
   */
  calculateLiquidityTarget(entry, side, entryPrice, stopDistance) {
    // For now, use structure target
    // This could be enhanced with PDH/PDL, session levels, etc.
    return this.calculateStructureTarget(entry, side, entryPrice, stopDistance);
  }

  /**
   * Load pre-computed CVD data from Databento trade loader
   * @param {Map<number, Object>} cvdMap - Map from DatabentoTradeLoader.computeCVDForCandles()
   */
  loadCVDData(cvdMap) {
    if (cvdMap && cvdMap.size > 0) {
      this.cvdCalculator.loadPrecomputedCVD(cvdMap);
      this.cvdDataLoaded = true;
    }
  }

  /**
   * Check CVD Filters (Phase 3 Order Flow - True CVD)
   * @param {string} side - 'buy' or 'sell'
   * @param {Object} candle - Current candle
   * @param {number[]} recentPrices - Recent prices for divergence detection
   * @returns {Object} { passes: boolean, results: Object, reasons: string[] }
   */
  checkCVDFilters(side, candle, recentPrices = []) {
    // If no CVD filters enabled, always pass
    const anyCvdFilterEnabled = this.params.cvdDirectionFilter ||
                                 this.params.cvdDivergenceFilter ||
                                 this.params.cvdZeroCrossFilter;

    if (!anyCvdFilterEnabled) {
      return { passes: true, results: null, reasons: ['No CVD filters enabled'] };
    }

    // If CVD data not loaded, skip filter (allow trade)
    if (!this.cvdDataLoaded) {
      return { passes: true, results: null, reasons: ['CVD data not loaded'] };
    }

    // Process candle CVD if available in market data
    const candleTime = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();
    const cvdData = this.cvdCalculator.getCVDAtTime(candleTime);

    if (cvdData) {
      this.cvdCalculator.processCandle(cvdData);
    }

    // Run the CVD filter check
    const filterResult = this.cvdFilter.check(side, recentPrices);

    this.lastCvdFilterResults = {
      passes: filterResult.passes,
      slope: this.cvdCalculator.getSlope(),
      cumulativeDelta: this.cvdCalculator.getCVD(),
      momentum: this.cvdCalculator.getMomentum(),
      zeroCross: this.cvdCalculator.checkZeroCross(),
      details: filterResult.details
    };

    return {
      passes: filterResult.passes,
      results: this.lastCvdFilterResults,
      reasons: filterResult.reasons
    };
  }

  /**
   * Get current state for debugging/monitoring
   * @returns {Object}
   */
  getState() {
    return {
      rawCandleCount: this.rawCandles.length,
      htfCandleCount: this.htfCandles.length,
      ltfCandleCount: this.ltfCandles.length,
      structureAnalysis: this.lastStructureAnalysis,
      pattern: this.lastPattern,
      stateMachineState: this.stateMachine.getState(),
      lastSignalTime: this.lastSignalTime
    };
  }

  /**
   * Get strategy info for display
   * @returns {Object}
   */
  getInfo() {
    return {
      name: 'ICT_SMC',
      description: 'ICT Smart Money Concepts Strategy',
      signalTypes: this.params.signalTypes,
      structureTimeframe: this.params.structureTimeframe,
      entryTimeframe: this.params.entryTimeframe,
      params: this.params
    };
  }

  /**
   * Check if entry price is within acceptable distance of favorable GEX level
   * For longs: must be near GEX support level
   * For shorts: must be near GEX resistance level
   *
   * @param {string} side - 'buy' or 'sell'
   * @param {number} entryPrice - Proposed entry price
   * @returns {Object} { passes: boolean, distance: number|null, level: number|null, levelType: string|null }
   */
  checkGexProximity(side, entryPrice) {
    // If filter is disabled, always pass
    if (!this.params.gexProximityFilter) {
      return { passes: true, distance: null, level: null, levelType: null };
    }

    // If no GEX data available, skip filter (allow trade)
    if (!this.currentGexLevels) {
      return { passes: true, distance: null, level: null, levelType: null };
    }

    const threshold = this.params.gexProximityThreshold;
    const gex = this.currentGexLevels;

    if (side === 'buy') {
      // For longs, find nearest support level below entry
      let nearestSupport = null;
      let minDist = Infinity;

      // Check support array
      if (gex.support && Array.isArray(gex.support)) {
        for (const level of gex.support) {
          if (level && level < entryPrice) {
            const dist = entryPrice - level;
            if (dist < minDist) {
              minDist = dist;
              nearestSupport = level;
            }
          }
        }
      }

      // Also check put_wall as support
      if (gex.put_wall && gex.put_wall < entryPrice) {
        const dist = entryPrice - gex.put_wall;
        if (dist < minDist) {
          minDist = dist;
          nearestSupport = gex.put_wall;
        }
      }

      if (nearestSupport === null) {
        return { passes: false, distance: null, level: null, levelType: 'no_support_found' };
      }

      return {
        passes: minDist <= threshold,
        distance: minDist,
        level: nearestSupport,
        levelType: 'support'
      };

    } else {
      // For shorts, find nearest resistance level above entry
      let nearestResistance = null;
      let minDist = Infinity;

      // Check resistance array
      if (gex.resistance && Array.isArray(gex.resistance)) {
        for (const level of gex.resistance) {
          if (level && level > entryPrice) {
            const dist = level - entryPrice;
            if (dist < minDist) {
              minDist = dist;
              nearestResistance = level;
            }
          }
        }
      }

      // Also check call_wall as resistance
      if (gex.call_wall && gex.call_wall > entryPrice) {
        const dist = gex.call_wall - entryPrice;
        if (dist < minDist) {
          minDist = dist;
          nearestResistance = gex.call_wall;
        }
      }

      if (nearestResistance === null) {
        return { passes: false, distance: null, level: null, levelType: 'no_resistance_found' };
      }

      return {
        passes: minDist <= threshold,
        distance: minDist,
        level: nearestResistance,
        levelType: 'resistance'
      };
    }
  }

  /**
   * Check Volume Filters (Phase 1 Order Flow)
   * Validates entry against volume-based conditions
   *
   * @param {string} side - 'buy' or 'sell'
   * @param {Object} candle - Current candle
   * @returns {Object} { passes: boolean, results: Object, reasons: string[] }
   */
  checkVolumeFilters(side, candle) {
    const results = {
      volumeDelta: null,
      volumeTrend: null,
      volumeSpike: null,
      volumeProfile: null
    };
    const reasons = [];
    let anyFilterEnabled = false;
    let allEnabledPass = true;

    // Check Volume Delta Proxy Filter
    if (this.params.volumeDeltaFilter) {
      anyFilterEnabled = true;
      const deltaState = this.volumeDeltaProxy.getState();
      const aligns = this.volumeDeltaProxy.alignsWithDirection(side, {
        useSlope: true,
        minSlope: 0
      });

      results.volumeDelta = {
        passes: aligns,
        cumulativeDelta: deltaState.cumulativeDelta,
        slope: deltaState.slope,
        ema: deltaState.ema
      };

      if (!aligns) {
        allEnabledPass = false;
        reasons.push(`Volume delta slope doesn't support ${side} (slope: ${deltaState.slope?.toFixed(2)})`);
      } else {
        reasons.push(`Volume delta confirms ${side} direction`);
      }
    }

    // Check Volume Trend Filter
    if (this.params.volumeTrendFilter) {
      anyFilterEnabled = true;
      const trendResult = this.volumeTrendFilter.check(this.rawCandles);

      results.volumeTrend = {
        passes: trendResult.isTrendingUp === true,
        changePercent: trendResult.changePercent,
        currentSMA: trendResult.currentSMA,
        previousSMA: trendResult.previousSMA
      };

      if (trendResult.isTrendingUp !== true) {
        allEnabledPass = false;
        reasons.push(`Volume not trending up (${trendResult.changePercent?.toFixed(1)}% change)`);
      } else {
        reasons.push(`Volume trending up (+${trendResult.changePercent?.toFixed(1)}%)`);
      }
    }

    // Check Volume Spike Filter
    if (this.params.volumeSpikeFilter) {
      anyFilterEnabled = true;
      const spikeResult = this.volumeSpikeDetector.check(this.rawCandles);

      results.volumeSpike = {
        passes: spikeResult.hasSpike === true,
        spikeRatio: spikeResult.spikeRatio,
        currentVolume: spikeResult.currentVolume,
        averageVolume: spikeResult.averageVolume
      };

      if (spikeResult.hasSpike !== true) {
        allEnabledPass = false;
        reasons.push(`No volume spike (${spikeResult.spikeRatio?.toFixed(2)}x avg, need ${this.params.volumeSpikeThreshold}x)`);
      } else {
        reasons.push(`Volume spike detected (${spikeResult.spikeRatio?.toFixed(2)}x avg)`);
      }
    }

    // Check Volume Profile Filter
    if (this.params.volumeProfileFilter) {
      anyFilterEnabled = true;
      const entryPrice = candle.close;
      const profileCheck = this.volumeProfile.checkEntry(entryPrice, side, {
        requireNearPOC: false,
        pocThreshold: this.params.volumeProfilePocThreshold,
        avoidLVN: true
      });

      results.volumeProfile = {
        passes: profileCheck.passes,
        score: profileCheck.score,
        poc: profileCheck.details?.poc,
        reasons: profileCheck.reasons
      };

      if (!profileCheck.passes) {
        allEnabledPass = false;
        reasons.push(`Volume profile unfavorable: ${profileCheck.reasons.join(', ')}`);
      } else {
        reasons.push(`Volume profile favorable (score: ${profileCheck.score})`);
      }
    }

    // Store results for metadata
    this.lastVolumeFilterResults = results;

    // If no filters enabled, always pass
    if (!anyFilterEnabled) {
      return { passes: true, results, reasons: ['No volume filters enabled'] };
    }

    return {
      passes: allEnabledPass,
      results,
      reasons
    };
  }

  /**
   * Get current session based on timestamp
   * All times are in EST (Eastern Standard Time)
   * @param {number} timestamp
   * @returns {string} 'overnight' | 'premarket' | 'rth' | 'afterhours'
   */
  getSession(timestamp) {
    const date = new Date(timestamp);

    // Convert to EST - get hours and minutes in Eastern time
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });

    const [hourStr, minStr] = estString.split(':');
    const hour = parseInt(hourStr);
    const min = parseInt(minStr);
    const timeDecimal = hour + min / 60;

    // Session definitions (EST):
    // overnight:   6:00 PM - 4:00 AM (18:00 - 04:00)
    // premarket:   4:00 AM - 9:30 AM (04:00 - 09:30)
    // rth:         9:30 AM - 4:00 PM (09:30 - 16:00)
    // afterhours:  4:00 PM - 6:00 PM (16:00 - 18:00)

    if (timeDecimal >= 18 || timeDecimal < 4) {
      return 'overnight';
    } else if (timeDecimal >= 4 && timeDecimal < 9.5) {
      return 'premarket';
    } else if (timeDecimal >= 9.5 && timeDecimal < 16) {
      return 'rth';
    } else {
      return 'afterhours';
    }
  }

  /**
   * Check if current session is allowed for trading
   * @param {number} timestamp
   * @returns {boolean}
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) {
      return true; // No filtering
    }

    const currentSession = this.getSession(timestamp);
    return this.params.allowedSessions.includes(currentSession);
  }
}

export default ICTSMCStrategy;
