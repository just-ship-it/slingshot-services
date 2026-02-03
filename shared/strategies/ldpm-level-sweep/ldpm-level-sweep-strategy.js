/**
 * LDPM Level Sweep Strategy
 *
 * Multi-state trading strategy that:
 * 1. Uses LDPM direction to determine trade bias
 * 2. Tracks GEX and session-based S/R levels
 * 3. Enters on level sweeps when conditions align
 *
 * Core Logic:
 * - LDPM rising → look for shorts (resistance sweeps)
 * - LDPM falling → look for longs (support sweeps)
 * - LDPM flat → either direction allowed
 * - Enter immediately when sweep detected + LDPM aligned
 * - Fixed symmetric stop/target for testing (10, 20, 30, 40, 50 pts)
 */

import { BaseStrategy } from '../base-strategy.js';
import { isValidCandle, roundTo, roundToNQTick } from '../strategy-utils.js';
import { LdpmDirectionCalculator } from './ldpm-direction-calculator.js';
import { LevelTracker } from './level-tracker.js';
import { SweepDetector } from './sweep-detector.js';

export class LdpmLevelSweepStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Default strategy parameters
    this.defaultParams = {
      // Exit parameters (symmetric for testing)
      targetPoints: 20.0,
      stopPoints: 20.0,

      // LDPM direction parameters
      ldpmLookbackPeriods: 4,        // 4 x 15min = 1 hour lookback
      ldpmSlopeThreshold: 3,         // Points per period for rising/falling

      // Sweep detection parameters
      sweepBuffer: 2,                // Points beyond level for sweep

      // Signal parameters
      signalCooldownMs: 900000,      // 15 minutes
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Trailing stop (optional)
      useTrailingStop: false,
      trailingTrigger: 10.0,
      trailingOffset: 5.0,

      // Session filtering
      useSessionFilter: false,
      blockedSessions: [],

      // Direction filtering
      useLongEntries: true,
      useShortEntries: true,

      // Level filtering
      includeGexLevels: true,
      includeSessionLevels: true,
      tradeLevels: [1, 2, 3],        // Which GEX levels to trade (1=S1/R1, 2=S2/R2, etc.)
    };

    // Merge with provided parameters
    this.params = { ...this.defaultParams, ...params };

    // Initialize components
    this.ldpmCalculator = new LdpmDirectionCalculator({
      lookbackPeriods: this.params.ldpmLookbackPeriods,
      slopeThreshold: this.params.ldpmSlopeThreshold
    });

    this.levelTracker = new LevelTracker();

    this.sweepDetector = new SweepDetector({
      sweepBuffer: this.params.sweepBuffer
    });

    // Internal state
    this.lastSignalTime = 0;
    this.ohlcvHistory = [];
    this.maxHistoryLength = 500; // Keep last 500 candles
  }

  /**
   * Evaluate if a trade signal should be generated
   *
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Contains gexLevels, ltLevels, etc.
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Validate inputs
    if (!isValidCandle(candle) || !isValidCandle(prevCandle)) {
      return null;
    }

    // Check cooldown
    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) {
      return null;
    }

    // Extract market data
    const { gexLevels, ltLevels } = marketData || {};

    // Update OHLCV history
    this.updateOhlcvHistory(candle);

    // Update LDPM calculator with LT levels
    if (ltLevels) {
      this.ldpmCalculator.processSnapshot(ltLevels, candle.timestamp);
    }

    // Calculate LDPM direction and get bias
    const ldpmDirection = this.ldpmCalculator.calculateDirection(candle.timestamp);
    const bias = ldpmDirection
      ? this.ldpmCalculator.getBias(ldpmDirection.direction)
      : 'either';

    // Apply direction filters
    if (bias === 'long' && !this.params.useLongEntries) return null;
    if (bias === 'short' && !this.params.useShortEntries) return null;

    // Update level tracker with current GEX and session levels
    const levels = this.levelTracker.updateLevels(
      gexLevels,
      this.ohlcvHistory,
      candle.timestamp
    );

    // Filter levels based on configuration
    const filteredLevels = this.filterLevels(levels);

    // Scan for sweeps matching bias
    const sweeps = this.sweepDetector.scanForSweeps(
      candle,
      prevCandle,
      filteredLevels,
      bias
    );

    // If we found a valid sweep, generate signal
    if (sweeps.length > 0) {
      const bestSweep = this.sweepDetector.getBestSweep(sweeps);

      // Verify sweep alignment with bias
      if (this.isSweepAlignedWithBias(bestSweep, bias)) {
        this.updateLastSignalTime(candle.timestamp);

        return this.generateSignalObject(
          candle,
          bestSweep,
          ldpmDirection,
          gexLevels
        );
      }
    }

    return null;
  }

  /**
   * Filter levels based on strategy configuration
   * @param {Object[]} levels - All tracked levels
   * @returns {Object[]} Filtered levels
   */
  filterLevels(levels) {
    return levels.filter(level => {
      // Filter by source
      if (level.source === 'gex' && !this.params.includeGexLevels) return false;
      if (level.source === 'session' && !this.params.includeSessionLevels) return false;

      // Filter GEX levels by number
      if (level.source === 'gex' && level.id.includes('support_')) {
        const levelNum = parseInt(level.id.split('_').pop());
        if (!this.params.tradeLevels.includes(levelNum)) return false;
      }
      if (level.source === 'gex' && level.id.includes('resistance_')) {
        const levelNum = parseInt(level.id.split('_').pop());
        if (!this.params.tradeLevels.includes(levelNum)) return false;
      }

      return true;
    });
  }

  /**
   * Check if a sweep is aligned with the LDPM bias
   * @param {Object} sweep - Sweep detection result
   * @param {string} bias - Trade bias ('long', 'short', 'either')
   * @returns {boolean} True if aligned
   */
  isSweepAlignedWithBias(sweep, bias) {
    if (bias === 'either') return true;

    if (bias === 'long' && sweep.side === 'long') return true;
    if (bias === 'short' && sweep.side === 'short') return true;

    return false;
  }

  /**
   * Update OHLCV history buffer
   * @param {Object} candle - Current candle
   */
  updateOhlcvHistory(candle) {
    // Avoid duplicates
    const candleTime = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    const lastTime = this.ohlcvHistory.length > 0
      ? (typeof this.ohlcvHistory[this.ohlcvHistory.length - 1].timestamp === 'number'
          ? this.ohlcvHistory[this.ohlcvHistory.length - 1].timestamp
          : new Date(this.ohlcvHistory[this.ohlcvHistory.length - 1].timestamp).getTime())
      : 0;

    if (candleTime > lastTime) {
      this.ohlcvHistory.push(candle);

      // Trim history
      if (this.ohlcvHistory.length > this.maxHistoryLength) {
        this.ohlcvHistory = this.ohlcvHistory.slice(-this.maxHistoryLength);
      }
    }
  }

  /**
   * Generate signal object
   * @param {Object} candle - Current candle
   * @param {Object} sweep - Sweep detection result
   * @param {Object} ldpmDirection - LDPM direction info
   * @param {Object} gexLevels - GEX levels for context
   * @returns {Object} Signal object
   */
  generateSignalObject(candle, sweep, ldpmDirection, gexLevels) {
    const side = sweep.side;
    const entryPrice = roundToNQTick(candle.close);

    // Calculate stop and target based on side
    let stopLoss, takeProfit;
    if (side === 'long') {
      stopLoss = roundToNQTick(entryPrice - this.params.stopPoints);
      takeProfit = roundToNQTick(entryPrice + this.params.targetPoints);
    } else {
      stopLoss = roundToNQTick(entryPrice + this.params.stopPoints);
      takeProfit = roundToNQTick(entryPrice - this.params.targetPoints);
    }

    const signal = {
      // Core signal data
      strategy: 'LDPM_LEVEL_SWEEP',
      side: side === 'long' ? 'buy' : 'sell',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      entryPrice,
      stopLoss,
      takeProfit,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      // Strategy-specific metadata
      metadata: {
        // Sweep info
        sweep_type: sweep.type,
        sweep_level_name: sweep.level?.name || 'unknown',
        sweep_level_price: roundTo(sweep.levelPrice),
        sweep_level_type: sweep.level?.type,
        sweep_level_source: sweep.level?.source,
        sweep_extension: roundTo(sweep.extension),
        sweep_strength: sweep.strength,
        sweep_reclaimed: sweep.reclaimed,

        // LDPM direction info
        ldpm_direction: ldpmDirection?.direction || 'unknown',
        ldpm_slope: ldpmDirection?.slope !== undefined ? roundTo(ldpmDirection.slope, 4) : null,
        ldpm_com_change: ldpmDirection?.comChange !== undefined ? roundTo(ldpmDirection.comChange) : null,
        ldpm_spread_direction: ldpmDirection?.spreadDirection || 'unknown',
        ldpm_sentiment: ldpmDirection?.sentiment || 'unknown',

        // Trade parameters
        target_points: this.params.targetPoints,
        stop_points: this.params.stopPoints,
        risk_points: this.params.stopPoints,

        // GEX context
        gex_regime: gexLevels?.regime || 'unknown',
        gex_total: gexLevels?.total_gex ? Math.round(gexLevels.total_gex / 1e9) : null,

        // Candle context
        candle_time: new Date(candle.timestamp).toISOString(),
        entry_reason: `${sweep.type} at ${sweep.level?.name} (${roundTo(sweep.levelPrice)}) with LDPM ${ldpmDirection?.direction || 'unknown'}`
      }
    };

    // Add trailing stop if enabled
    if (this.params.useTrailingStop) {
      signal.trailingTrigger = this.params.trailingTrigger;
      signal.trailingOffset = this.params.trailingOffset;
    }

    return signal;
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.ldpmCalculator.reset();
    this.levelTracker.reset();
    this.ohlcvHistory = [];
  }

  /**
   * Get strategy name
   * @returns {string} Strategy name
   */
  getName() {
    return 'LDPM_LEVEL_SWEEP';
  }

  /**
   * Get strategy description
   * @returns {string} Strategy description
   */
  getDescription() {
    return 'LDPM Level Sweep - Enters on level sweeps aligned with LDPM direction';
  }

  /**
   * Get required market data fields
   * @returns {string[]} Array of required field paths
   */
  getRequiredMarketData() {
    return ['gexLevels', 'ltLevels'];
  }

  /**
   * Get debug info
   * @returns {Object} Debug information
   */
  getDebugInfo() {
    return {
      params: this.params,
      ldpmCalculator: this.ldpmCalculator.getDebugInfo(),
      levelTracker: this.levelTracker.getDebugInfo(),
      ohlcvHistoryLength: this.ohlcvHistory.length
    };
  }
}

export default LdpmLevelSweepStrategy;
