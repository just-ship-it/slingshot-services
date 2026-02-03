/**
 * GEX Scalp Strategy - Shared Implementation
 *
 * Fast scalping strategy that trades bounces off GEX support/resistance levels.
 * - Long entries on Support 1 touches
 * - Short entries on Resistance 1 touches
 * - Tight targets (7 pts) and stops (3 pts)
 * - Trailing stop to lock in profits
 * - 10-minute max hold window
 *
 * Based on analysis of 13,804 trades with verified performance:
 * - Target hit: 4,724 trades (34%)
 * - Trailing stop: 2,555 trades (19%)
 * - Initial stop: 5,658 trades (41%)
 * - Window exit: 867 trades (6%)
 * - Total P&L: 26,180 points ($523k gross on 1 NQ contract)
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

// CVD Filter Imports (Phase 3 Order Flow - True CVD from Databento)
import { CVDCalculator, CVDFilter } from '../indicators/cvd.js';

// Book Imbalance Filter Imports (Phase 4 Order Flow - MBP-1 Data)
import { BookImbalanceCalculator, BookImbalanceFilter } from '../indicators/book-imbalance.js';

export class GexScalpStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Default strategy parameters (verified optimal from backtesting analysis)
    this.defaultParams = {
      // Entry parameters
      touchThreshold: 3.0,        // Within 3 points of level to trigger entry

      // Exit parameters
      targetPoints: 7.0,          // Take profit target
      stopPoints: 3.0,            // Initial stop loss
      maxHoldBars: 10,            // Max candles to hold (10 minutes on 1m chart)

      // Order parameters
      limitOrderTimeout: 3,       // Cancel unfilled limit orders after 3 candles (3 min on 1m)

      // Trailing stop parameters
      useTrailingStop: true,
      trailingTrigger: 3.0,       // Activate trailing when 3 pts in profit
      trailingOffset: 1.0,        // Trail 1 pt behind high water mark

      // Signal management
      signalCooldownMs: 60000,    // 60 seconds between signals (scalping pace)
      allowSimultaneous: false,   // One position at a time

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Filter parameters
      useLongEntries: true,       // Enable long entries at support
      useShortEntries: true,      // Enable short entries at resistance
      allowedRegimes: null,       // null = all regimes, or array like ['negative', 'strong_negative']
      blockedHoursUTC: [],        // UTC hours to avoid (e.g., [12, 13, 14] for news times)

      // Level configuration
      tradeLevels: [1],           // Which levels to trade: [1] = S1/R1 only, [1,2,3,4,5] = all levels
                                  // Longs trigger on support levels, shorts on resistance levels

      // Session filtering (all times in EST)
      useSessionFilter: true,     // Enable session-based filtering
      allowedSessions: ['rth'],   // Which sessions to trade: 'overnight', 'premarket', 'rth', 'afterhours'
      // Session definitions (EST):
      // overnight:   6:00 PM - 4:00 AM (18:00 - 04:00)
      // premarket:   4:00 AM - 9:30 AM (04:00 - 09:30)
      // rth:         9:30 AM - 4:00 PM (09:30 - 16:00) - Regular Trading Hours
      // afterhours:  4:00 PM - 6:00 PM (16:00 - 18:00)

      // CVD Filters (Phase 3 Order Flow - True CVD from Databento)
      cvdDirectionFilter: false,
      cvdSlopeLookback: 5,
      cvdMinSlope: 0,
      cvdDivergenceFilter: false,
      cvdDivergenceLookback: 20,
      cvdZeroCrossFilter: false,
      cvdZeroCrossLookback: 10,

      // Book Imbalance Filters (Phase 4 Order Flow - MBP-1 Data)
      bookImbalanceFilter: false,          // Require imbalance alignment with trade direction
      bookImbalanceThreshold: 0.1,         // Minimum imbalance to consider significant
      bookImbalanceMomentumFilter: false,  // Require improving imbalance momentum
      bookImbalanceBlockContrary: false    // Block on strong contrary imbalance
    };

    // Merge with provided parameters
    this.params = { ...this.defaultParams, ...params };

    // Handle CLI parameter name mapping (CLI uses stopLossPoints, strategy uses stopPoints)
    if (params.stopLossPoints !== undefined && params.stopPoints === undefined) {
      this.params.stopPoints = params.stopLossPoints;
    }

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

    // Initialize Book Imbalance Components (Phase 4 Order Flow - MBP-1 Data)
    this.bookImbalanceCalculator = new BookImbalanceCalculator({
      slopeLookback: 5,
      emaPeriod: 14,
      minImbalanceThreshold: this.params.bookImbalanceThreshold
    });
    this.bookImbalanceFilter = new BookImbalanceFilter(this.bookImbalanceCalculator, {
      requireAlignment: this.params.bookImbalanceFilter,
      minImbalanceThreshold: this.params.bookImbalanceThreshold,
      requireImproving: this.params.bookImbalanceMomentumFilter,
      blockOnContraryStrength: this.params.bookImbalanceBlockContrary
    });
    this.lastBookImbalanceResults = null;
    this.bookImbalanceDataLoaded = false;

    // Track last touched levels to avoid immediate re-entry
    this.lastTouchedSupport = null;
    this.lastTouchedResistance = null;
    this.lastTouchTime = 0;
  }

  /**
   * Evaluate if a GEX scalp signal should be generated
   *
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle (not required for touch detection)
   * @param {Object} marketData - Contains gexLevels
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    // Validate inputs
    if (!isValidCandle(candle)) {
      if (debug) {
        const fields = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];
        const issues = fields.filter(f => candle[f] === null || candle[f] === undefined || isNaN(candle[f]));
        console.log(`[GEX_SCALP] ❌ Invalid candle - issues with: ${issues.join(', ')} | candle: ${JSON.stringify({
          timestamp: candle?.timestamp,
          open: candle?.open,
          high: candle?.high,
          low: candle?.low,
          close: candle?.close,
          volume: candle?.volume
        })}`);
      }
      return null;
    }

    // Check cooldown
    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) {
      const currentMs = this.toMs(candle.timestamp);
      const remainingMs = (this.lastSignalTime + cooldownMs) - currentMs;
      if (debug) console.log(`[GEX_SCALP] ❌ In cooldown (${Math.ceil(remainingMs/1000)}s remaining)`);
      return null;
    }

    // Extract market data
    const { gexLevels } = marketData || {};
    if (!gexLevels) {
      if (debug) console.log('[GEX_SCALP] ❌ No GEX levels available');
      return null;
    }

    // Check session filter (RTH only by default)
    if (!this.isAllowedSession(candle.timestamp)) {
      const currentSession = this.getSession(candle.timestamp);
      if (debug) console.log(`[GEX_SCALP] ❌ Session filter blocked (current: ${currentSession}, allowed: ${this.params.allowedSessions.join(',')})`);
      return null;
    }

    // Check blocked hours
    if (this.isBlockedHour(candle.timestamp)) {
      if (debug) console.log('[GEX_SCALP] ❌ Blocked hour');
      return null;
    }

    // Check regime filter
    if (!this.isAllowedRegime(gexLevels.regime)) {
      if (debug) console.log(`[GEX_SCALP] ❌ Regime filter blocked (current: ${gexLevels.regime})`);
      return null;
    }

    const price = candle.close;

    // Check each configured level for entry signals
    // Levels are checked in order, first valid signal wins
    let closestLevel = null;
    let closestDistance = Infinity;
    let closestType = null;

    for (const levelNum of this.params.tradeLevels) {
      // Check for long entry at support level
      if (this.params.useLongEntries) {
        const supportLevel = this.getSupportLevel(gexLevels, levelNum);

        if (supportLevel !== null) {
          const distanceToSupport = Math.abs(price - supportLevel);

          // Track closest level for debug output
          if (distanceToSupport < closestDistance) {
            closestDistance = distanceToSupport;
            closestLevel = supportLevel;
            closestType = `S${levelNum}`;
          }

          if (distanceToSupport <= this.params.touchThreshold) {
            // Check if this is a fresh touch (not same level as recent touch)
            if (!this.isRecentTouch(supportLevel, 'support', candle.timestamp)) {
              // Apply CVD filter if enabled
              const recentPrices = options.historicalCandles
                ? options.historicalCandles.slice(-20).map(c => c.close)
                : [];
              const cvdFilterResult = this.checkCVDFilters('buy', candle, recentPrices);
              if (!cvdFilterResult.passes) {
                if (debug) console.log(`[GEX_SCALP] ❌ CVD filter blocked LONG at S${levelNum}=${supportLevel}`);
                continue; // Try next level
              }

              // Apply book imbalance filter if enabled
              const bookImbalanceResult = this.checkBookImbalanceFilters('buy', candle);
              if (!bookImbalanceResult.passes) {
                if (debug) console.log(`[GEX_SCALP] ❌ Book imbalance filter blocked LONG at S${levelNum}=${supportLevel}`);
                continue; // Try next level
              }

              // Valid long entry
              if (debug) console.log(`[GEX_SCALP] ✅ LONG SIGNAL at S${levelNum}=${supportLevel}, price=${price}, dist=${distanceToSupport.toFixed(2)}`);
              this.updateLastSignalTime(candle.timestamp);
              this.recordTouch(supportLevel, 'support', candle.timestamp);

              return this.generateSignalObject(
                candle,
                'buy',
                supportLevel,
                `support_${levelNum}`,
                gexLevels,
                cvdFilterResult
              );
            } else {
              if (debug) console.log(`[GEX_SCALP] ❌ Recent touch blocked S${levelNum}=${supportLevel} (last touch: ${this.lastTouchedSupport})`);
            }
          }
        }
      }

      // Check for short entry at resistance level
      if (this.params.useShortEntries) {
        const resistanceLevel = this.getResistanceLevel(gexLevels, levelNum);

        if (resistanceLevel !== null) {
          const distanceToResistance = Math.abs(price - resistanceLevel);

          // Track closest level for debug output
          if (distanceToResistance < closestDistance) {
            closestDistance = distanceToResistance;
            closestLevel = resistanceLevel;
            closestType = `R${levelNum}`;
          }

          if (distanceToResistance <= this.params.touchThreshold) {
            // Check if this is a fresh touch
            if (!this.isRecentTouch(resistanceLevel, 'resistance', candle.timestamp)) {
              // Apply CVD filter if enabled
              const recentPrices = options.historicalCandles
                ? options.historicalCandles.slice(-20).map(c => c.close)
                : [];
              const cvdFilterResult = this.checkCVDFilters('sell', candle, recentPrices);
              if (!cvdFilterResult.passes) {
                if (debug) console.log(`[GEX_SCALP] ❌ CVD filter blocked SHORT at R${levelNum}=${resistanceLevel}`);
                continue; // Try next level
              }

              // Apply book imbalance filter if enabled
              const bookImbalanceResult = this.checkBookImbalanceFilters('sell', candle);
              if (!bookImbalanceResult.passes) {
                if (debug) console.log(`[GEX_SCALP] ❌ Book imbalance filter blocked SHORT at R${levelNum}=${resistanceLevel}`);
                continue; // Try next level
              }

              // Valid short entry
              if (debug) console.log(`[GEX_SCALP] ✅ SHORT SIGNAL at R${levelNum}=${resistanceLevel}, price=${price}, dist=${distanceToResistance.toFixed(2)}`);
              this.updateLastSignalTime(candle.timestamp);
              this.recordTouch(resistanceLevel, 'resistance', candle.timestamp);

              return this.generateSignalObject(
                candle,
                'sell',
                resistanceLevel,
                `resistance_${levelNum}`,
                gexLevels,
                cvdFilterResult
              );
            } else {
              if (debug) console.log(`[GEX_SCALP] ❌ Recent touch blocked R${levelNum}=${resistanceLevel} (last touch: ${this.lastTouchedResistance})`);
            }
          }
        }
      }
    }

    // Log closest level if no signal generated
    if (debug && closestLevel !== null) {
      console.log(`[GEX_SCALP] 📊 No signal - closest: ${closestType}=${closestLevel}, dist=${closestDistance.toFixed(2)}, threshold=${this.params.touchThreshold}`);
    }

    return null;
  }

  /**
   * Get support level by index (1-based)
   * Handles both JSON (support array) and CSV (individual fields) formats
   * @param {Object} gexLevels - GEX levels object
   * @param {number} levelNum - Level number (1=S1, 2=S2, etc.)
   * @returns {number|null} Support level price or null
   */
  getSupportLevel(gexLevels, levelNum = 1) {
    const index = levelNum - 1; // Convert to 0-based index

    // JSON format: support array
    if (gexLevels.support && Array.isArray(gexLevels.support) && gexLevels.support[index] != null) {
      return gexLevels.support[index];
    }

    // CSV format fallback
    const csvKey = `nq_put_wall_${levelNum}`;
    if (gexLevels[csvKey] != null) {
      return gexLevels[csvKey];
    }

    return null;
  }

  /**
   * Get resistance level by index (1-based)
   * @param {Object} gexLevels - GEX levels object
   * @param {number} levelNum - Level number (1=R1, 2=R2, etc.)
   * @returns {number|null} Resistance level price or null
   */
  getResistanceLevel(gexLevels, levelNum = 1) {
    const index = levelNum - 1; // Convert to 0-based index

    // JSON format: resistance array
    if (gexLevels.resistance && Array.isArray(gexLevels.resistance) && gexLevels.resistance[index] != null) {
      return gexLevels.resistance[index];
    }

    // CSV format fallback
    const csvKey = `nq_call_wall_${levelNum}`;
    if (gexLevels[csvKey] != null) {
      return gexLevels[csvKey];
    }

    return null;
  }

  /**
   * Get Support 1 level (convenience method for backward compatibility)
   */
  getSupport1(gexLevels) {
    return this.getSupportLevel(gexLevels, 1);
  }

  /**
   * Get Resistance 1 level (convenience method for backward compatibility)
   */
  getResistance1(gexLevels) {
    return this.getResistanceLevel(gexLevels, 1);
  }

  /**
   * Check if hour is blocked
   */
  isBlockedHour(timestamp) {
    if (!this.params.blockedHoursUTC || this.params.blockedHoursUTC.length === 0) {
      return false;
    }

    const hour = new Date(timestamp).getUTCHours();
    return this.params.blockedHoursUTC.includes(hour);
  }

  /**
   * Get the current trading session based on timestamp
   * All times are in EST (Eastern Standard Time)
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
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) {
      return true; // No filtering
    }

    const currentSession = this.getSession(timestamp);
    return this.params.allowedSessions.includes(currentSession);
  }

  /**
   * Check if regime is allowed
   */
  isAllowedRegime(regime) {
    if (!this.params.allowedRegimes || this.params.allowedRegimes.length === 0) {
      return true; // All regimes allowed
    }

    return this.params.allowedRegimes.includes(regime);
  }

  /**
   * Check if this is a recent touch of the same level
   * Prevents immediate re-entry on the same level
   */
  isRecentTouch(level, type, timestamp) {
    const recentTouchWindow = 5 * 60 * 1000; // 5 minutes
    const currentMs = this.toMs(timestamp);
    const lastTouchMs = this.lastTouchTime || 0;

    if (type === 'support') {
      if (this.lastTouchedSupport === level &&
          currentMs - lastTouchMs < recentTouchWindow) {
        return true;
      }
    } else {
      if (this.lastTouchedResistance === level &&
          currentMs - lastTouchMs < recentTouchWindow) {
        return true;
      }
    }

    return false;
  }

  /**
   * Record a touch for deduplication
   */
  recordTouch(level, type, timestamp) {
    if (type === 'support') {
      this.lastTouchedSupport = level;
    } else {
      this.lastTouchedResistance = level;
    }
    this.lastTouchTime = this.toMs(timestamp);
  }

  /**
   * Generate signal object for the backtest engine
   *
   * @param {Object} candle - Current candle
   * @param {string} side - 'buy' or 'sell'
   * @param {number} gexLevel - The GEX level that triggered the signal
   * @param {string} gexLevelType - Type of level ('support_1' or 'resistance_1')
   * @param {Object} gexLevels - Full GEX levels object
   * @param {Object} cvdFilterResult - CVD filter result with slope and momentum data
   * @returns {Object} Signal object
   */
  generateSignalObject(candle, side, gexLevel, gexLevelType, gexLevels, cvdFilterResult = null) {
    const entryPrice = candle.close;

    // Calculate stop and target based on direction
    let stopPrice, targetPrice;

    if (side === 'buy') {
      // Long: stop below entry, target above
      stopPrice = entryPrice - this.params.stopPoints;
      targetPrice = entryPrice + this.params.targetPoints;
    } else {
      // Short: stop above entry, target below
      stopPrice = entryPrice + this.params.stopPoints;
      targetPrice = entryPrice - this.params.targetPoints;
    }

    const signal = {
      // Core signal data (snake_case for trade orchestrator compatibility)
      strategy: 'GEX_SCALP',
      side: side,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      // Trailing stop configuration (snake_case for trade orchestrator)
      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,

      // Strategy-specific metadata
      metadata: {
        gex_level: roundTo(gexLevel),
        gex_level_type: gexLevelType,
        distance_to_level: roundTo(Math.abs(candle.close - gexLevel)),
        target_points: this.params.targetPoints,
        stop_points: this.params.stopPoints,
        trailing_trigger: this.params.trailingTrigger,
        trailing_offset: this.params.trailingOffset,
        max_hold_minutes: this.params.maxHoldBars,
        timeout_candles: this.params.limitOrderTimeout,
        candle_time: new Date(candle.timestamp).toISOString(),
        entry_reason: `Price within ${this.params.touchThreshold}pts of ${gexLevelType} at ${roundTo(gexLevel)}`,

        // GEX context
        gex_regime: gexLevels?.regime || 'unknown',
        gex_support_1: this.getSupport1(gexLevels),
        gex_resistance_1: this.getResistance1(gexLevels),

        // CVD Order Flow Analysis (Phase 3)
        cvd_slope: cvdFilterResult?.results?.slope !== undefined ? roundTo(cvdFilterResult.results.slope, 2) : null,
        cvd_cumulative_delta: cvdFilterResult?.results?.cumulativeDelta !== undefined ? roundTo(cvdFilterResult.results.cumulativeDelta, 0) : null,
        cvd_momentum: cvdFilterResult?.results?.momentum !== undefined ? roundTo(cvdFilterResult.results.momentum, 0) : null,
        cvd_filter_passed: cvdFilterResult?.passes ?? true
      }
    };

    return signal;
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.lastTouchedSupport = null;
    this.lastTouchedResistance = null;
    this.lastTouchTime = 0;
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'GEX_SCALP';
  }

  /**
   * Get strategy description
   */
  getDescription() {
    return 'GEX Scalp strategy - fast scalping at Support 1 and Resistance 1 levels with tight stops and trailing';
  }

  /**
   * Get required market data fields
   */
  getRequiredMarketData() {
    return ['gexLevels'];
  }

  /**
   * Validate strategy parameters
   */
  validateParams(params) {
    const errors = [];

    if (params.targetPoints <= 0) {
      errors.push('targetPoints must be greater than 0');
    }

    if (params.stopPoints <= 0) {
      errors.push('stopPoints must be greater than 0');
    }

    if (params.touchThreshold <= 0) {
      errors.push('touchThreshold must be greater than 0');
    }

    if (params.maxHoldBars <= 0) {
      errors.push('maxHoldBars must be greater than 0');
    }

    if (params.useTrailingStop) {
      if (params.trailingTrigger <= 0) {
        errors.push('trailingTrigger must be greater than 0 when trailing stop is enabled');
      }
      if (params.trailingOffset <= 0) {
        errors.push('trailingOffset must be greater than 0 when trailing stop is enabled');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
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
   * Load pre-computed book imbalance data from MBP loader
   * @param {Map<number, Object>} imbalanceMap - Map from MBPLoader
   */
  loadBookImbalanceData(imbalanceMap) {
    if (imbalanceMap && imbalanceMap.size > 0) {
      this.bookImbalanceCalculator.loadPrecomputedImbalance(imbalanceMap);
      this.bookImbalanceDataLoaded = true;
    }
  }

  /**
   * Check Book Imbalance Filters (Phase 4 Order Flow - MBP-1 Data)
   * @param {string} side - 'buy' or 'sell'
   * @param {Object} candle - Current candle
   * @returns {Object} { passes: boolean, results: Object, reasons: string[] }
   */
  checkBookImbalanceFilters(side, candle) {
    // If no book imbalance filters enabled, always pass
    const anyFilterEnabled = this.params.bookImbalanceFilter ||
                              this.params.bookImbalanceMomentumFilter ||
                              this.params.bookImbalanceBlockContrary;

    if (!anyFilterEnabled) {
      return { passes: true, results: null, reasons: ['No book imbalance filters enabled'] };
    }

    // If book imbalance data not loaded, skip filter (allow trade)
    if (!this.bookImbalanceDataLoaded) {
      return { passes: true, results: null, reasons: ['Book imbalance data not loaded'] };
    }

    // Run the book imbalance filter check
    const filterResult = this.bookImbalanceFilter.check(side, candle);

    this.lastBookImbalanceResults = {
      passes: filterResult.passes,
      sizeImbalance: filterResult.details.sizeImbalance,
      bidAskRatio: filterResult.details.bidAskRatio,
      strength: filterResult.details.strength,
      details: filterResult.details
    };

    return {
      passes: filterResult.passes,
      results: this.lastBookImbalanceResults,
      reasons: filterResult.reasons
    };
  }
}

export default GexScalpStrategy;
