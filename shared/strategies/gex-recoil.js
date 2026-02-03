/**
 * GEX Recoil Strategy - Shared Implementation
 *
 * Pure strategy logic that can be used by both backtesting engine and live signal generator.
 * Enters long when price crosses below GEX support levels (put walls).
 */

import { BaseStrategy } from './base-strategy.js';
import { SqueezeMomentumIndicator } from '../indicators/squeeze-momentum.js';
import {
  didCrossBelowLevel,
  countLevelsBelow,
  isValidCandle,
  roundTo
} from './strategy-utils.js';
import { RSI, WilliamsR, Stochastic, CCI } from 'technicalindicators';

// CVD Filter Imports (Phase 3 Order Flow - True CVD from Databento)
import { CVDCalculator, CVDFilter } from '../indicators/cvd.js';

// Book Imbalance Filter Imports (Phase 4 Order Flow - MBP-1 from Databento)
import { BookImbalanceCalculator, BookImbalanceFilter } from '../indicators/book-imbalance.js';

export class GexRecoilStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Default strategy parameters
    this.defaultParams = {
      targetPoints: 25.0,
      stopBuffer: 10.0,
      maxRisk: 30.0,
      useTrailingStop: false,
      trailingTrigger: 15.0,
      trailingOffset: 10.0,
      useLiquidityFilter: false,
      maxLtLevelsBelow: 3,
      signalCooldownMs: 900000, // 15 minutes
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // LT Configuration Filtering
      filterByLtConfiguration: false,
      ltFilterProfile: 'conservative',
      blockedLtOrderings: ['ASCENDING'],
      blockedLdmpTypes: ['BULLISH_REVERSAL', 'BEARISH_REVERSAL'],
      allowedLtSentiments: ['BULLISH', 'BEARISH'],
      preferredLtSentiment: null,
      requiredLtSentiment: null,
      minLtSpacing: null,
      preferredLtSpacing: ['WIDE', 'MEDIUM'],
      allowedLtOrderings: ['MIXED', 'DESCENDING'],
      preferredLdmpTypes: ['BULLISH_TRAP_POTENTIAL', 'BEARISH_NORMAL', 'BEARISH_TIGHT_STACK'],
      minAvgPnlThreshold: 50.0,
      maxNegativePnlTypes: 0,

      // CVD Filters (Phase 3 Order Flow - True CVD from Databento)
      cvdDirectionFilter: false,
      cvdSlopeLookback: 5,
      cvdMinSlope: 0,
      cvdDivergenceFilter: false,
      cvdDivergenceLookback: 20,
      cvdZeroCrossFilter: false,
      cvdZeroCrossLookback: 10,

      // Book Imbalance Filters (Phase 4 Order Flow - MBP-1 from Databento)
      bookImbalanceFilter: false,
      bookImbalanceThreshold: 0.1,
      bookImbalanceMomentumFilter: false,
      bookImbalanceMomentumLookback: 5,
      bookImbalanceBlockContrary: false
    };

    // Merge with provided parameters
    this.params = { ...this.defaultParams, ...params };

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

    // Initialize Book Imbalance Components (Phase 4 Order Flow)
    this.bookImbalanceCalculator = new BookImbalanceCalculator({
      slopeLookback: this.params.bookImbalanceMomentumLookback,
      minImbalanceThreshold: this.params.bookImbalanceThreshold
    });
    this.bookImbalanceFilter = new BookImbalanceFilter(this.bookImbalanceCalculator, {
      requireAlignment: this.params.bookImbalanceFilter,
      minImbalanceThreshold: this.params.bookImbalanceThreshold,
      requireImproving: this.params.bookImbalanceMomentumFilter,
      momentumLookback: this.params.bookImbalanceMomentumLookback,
      blockOnContraryStrength: this.params.bookImbalanceBlockContrary
    });
    this.lastBookImbalanceResults = null;
    this.bookImbalanceDataLoaded = false;

    // Initialize squeeze momentum indicator
    this.squeezeIndicator = new SqueezeMomentumIndicator({
      bbLength: 20,
      bbMultFactor: 2.0,
      kcLength: 20,
      kcMultFactor: 1.5,
      useTrueRange: true
    });
  }

  /**
   * Evaluate if a GEX recoil signal should be generated
   *
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Contains gexLevels and ltLevels
   * @param {Object} options - Additional options, including historicalCandles
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
    if (!gexLevels) {
      return null;
    }

    // Calculate squeeze momentum value if historical data is available
    let momentumValue = null;
    if (options.historicalCandles && options.historicalCandles.length >= 20) {
      try {
        const momentum = this.squeezeIndicator.calculateMomentum(options.historicalCandles);
        if (momentum && momentum.value !== null) {
          momentumValue = momentum.value;
        }
      } catch (error) {
        // Log error but don't fail signal generation
        console.warn('Failed to calculate squeeze momentum:', error.message);
      }
    }

    // Calculate RSI (14 period) if sufficient historical data is available
    let rsiValue = null;
    if (options.historicalCandles && options.historicalCandles.length >= 15) {
      try {
        const closes = options.historicalCandles.map(candle => candle.close);
        const rsiResults = RSI.calculate({
          values: closes,
          period: 14
        });
        // Get the most recent RSI value
        if (rsiResults.length > 0) {
          rsiValue = rsiResults[rsiResults.length - 1];
        }
      } catch (error) {
        // Log error but don't fail signal generation
        console.warn('Failed to calculate RSI:', error.message);
      }
    }

    // Calculate Williams %R (14 period) if sufficient historical data is available
    let williamsRValue = null;
    if (options.historicalCandles && options.historicalCandles.length >= 15) {
      try {
        const input = {
          high: options.historicalCandles.map(candle => candle.high),
          low: options.historicalCandles.map(candle => candle.low),
          close: options.historicalCandles.map(candle => candle.close),
          period: 14
        };
        const williamsRResults = WilliamsR.calculate(input);
        // Get the most recent Williams %R value
        if (williamsRResults.length > 0) {
          williamsRValue = williamsRResults[williamsRResults.length - 1];
        }
      } catch (error) {
        // Log error but don't fail signal generation
        console.warn('Failed to calculate Williams %R:', error.message);
      }
    }

    // Calculate Stochastic Oscillator (14,3,3) if sufficient historical data is available
    let stochasticK = null;
    let stochasticD = null;
    if (options.historicalCandles && options.historicalCandles.length >= 17) { // Need extra periods for smoothing
      try {
        const input = {
          high: options.historicalCandles.map(candle => candle.high),
          low: options.historicalCandles.map(candle => candle.low),
          close: options.historicalCandles.map(candle => candle.close),
          period: 14,        // %K period
          signalPeriod: 3    // %D period (smoothing)
        };
        const stochasticResults = Stochastic.calculate(input);
        // Get the most recent Stochastic values
        if (stochasticResults.length > 0) {
          const latest = stochasticResults[stochasticResults.length - 1];
          stochasticK = latest.k;
          stochasticD = latest.d;
        }
      } catch (error) {
        // Log error but don't fail signal generation
        console.warn('Failed to calculate Stochastic:', error.message);
      }
    }

    // Calculate Commodity Channel Index CCI (20 period) if sufficient historical data is available
    let cciValue = null;
    if (options.historicalCandles && options.historicalCandles.length >= 21) {
      try {
        const input = {
          high: options.historicalCandles.map(candle => candle.high),
          low: options.historicalCandles.map(candle => candle.low),
          close: options.historicalCandles.map(candle => candle.close),
          period: 20
        };
        const cciResults = CCI.calculate(input);
        // Get the most recent CCI value
        if (cciResults.length > 0) {
          cciValue = cciResults[cciResults.length - 1];
        }
      } catch (error) {
        // Log error but don't fail signal generation
        console.warn('Failed to calculate CCI:', error.message);
      }
    }

    // Get GEX levels to check (in priority order)
    const levelsToCheck = this.getGexLevelsToCheck(gexLevels);

    // Check each level for crossover
    for (const { levelName, levelValue } of levelsToCheck) {
      if (levelValue === null || levelValue === undefined) {
        continue;
      }

      // Did price cross below this level?
      if (didCrossBelowLevel(prevCandle, candle, levelValue)) {
        // Apply liquidity filter if enabled
        const ltCheckResult = this.checkLiquidityFilter(ltLevels, levelValue);
        if (!ltCheckResult.passed) {
          continue; // Skip this level, try next one
        }

        // Calculate risk
        const stopPrice = candle.low - this.params.stopBuffer;
        const risk = this.calculateRisk(candle.close, stopPrice);

        // Apply risk filter
        if (risk > this.params.maxRisk || risk <= 0) {
          continue; // Skip this level, try next one
        }

        // Apply CVD filter if enabled (GEX Recoil is always long entries)
        const recentPrices = options.historicalCandles
          ? options.historicalCandles.slice(-20).map(c => c.close)
          : [];
        const cvdFilterResult = this.checkCVDFilters('buy', candle, recentPrices);
        if (!cvdFilterResult.passes) {
          continue; // Skip this level, CVD filter blocked it
        }

        // Apply Book Imbalance filter if enabled (GEX Recoil is always long entries)
        const bookImbalanceResult = this.checkBookImbalanceFilters('buy', candle);
        if (!bookImbalanceResult.passes) {
          continue; // Skip this level, book imbalance filter blocked it
        }

        // Valid entry found - update signal time and return signal
        this.updateLastSignalTime(candle.timestamp);

        return this.generateSignalObject(candle, levelValue, levelName, stopPrice, ltCheckResult.ltLevelsBelow, risk, ltCheckResult.ltConfig, gexLevels, momentumValue, rsiValue, williamsRValue, stochasticK, stochasticD, cciValue, cvdFilterResult);
      }
    }

    return null;
  }

  /**
   * Get GEX levels to check in priority order
   * Uses native JSON structure: put_wall, gamma_flip, support[0-4]
   *
   * @param {Object} gexLevels - GEX levels object
   * @returns {Array} Array of {levelName, levelValue} objects
   */
  getGexLevelsToCheck(gexLevels) {
    const levels = [];

    // Put wall - primary support level from options market makers
    if (gexLevels.put_wall != null) {
      levels.push({ levelName: 'put_wall', levelValue: gexLevels.put_wall });
    }

    // Gamma flip - level where dealer gamma exposure flips sign
    if (gexLevels.gamma_flip != null) {
      levels.push({ levelName: 'gamma_flip', levelValue: gexLevels.gamma_flip });
    }

    // Support levels array (5 levels from JSON, nearest to furthest from price)
    if (gexLevels.support && Array.isArray(gexLevels.support)) {
      gexLevels.support.forEach((level, idx) => {
        if (level != null) {
          levels.push({ levelName: `support_${idx + 1}`, levelValue: level });
        }
      });
    }

    // Legacy CSV format fallback (only used if JSON not available)
    if (levels.length === 0) {
      if (gexLevels.nq_put_wall_1 != null) levels.push({ levelName: 'put_wall_1', levelValue: gexLevels.nq_put_wall_1 });
      if (gexLevels.nq_put_wall_2 != null) levels.push({ levelName: 'put_wall_2', levelValue: gexLevels.nq_put_wall_2 });
      if (gexLevels.nq_put_wall_3 != null) levels.push({ levelName: 'put_wall_3', levelValue: gexLevels.nq_put_wall_3 });
      if (gexLevels.nq_gamma_flip != null) levels.push({ levelName: 'gamma_flip', levelValue: gexLevels.nq_gamma_flip });
    }

    return levels;
  }

  /**
   * Check liquidity filter if enabled and analyze LT stacking configuration
   *
   * @param {Object} ltLevels - Liquidity trigger levels
   * @param {number} levelValue - GEX level value (entry price level)
   * @returns {Object} { passed: boolean, ltLevelsBelow: number, ltConfig: Object, filterReason?: string }
   */
  checkLiquidityFilter(ltLevels, levelValue) {
    // Always count LT levels below entry for data collection
    let ltLevelsBelow = 0;
    let ltConfig = null;

    if (ltLevels) {
      // Convert LT levels to array format if needed
      let ltLevelArray = [];
      if (ltLevels.level_1 !== undefined) {
        // CSV format: level_1, level_2, etc.
        ltLevelArray = [
          ltLevels.level_1,
          ltLevels.level_2,
          ltLevels.level_3,
          ltLevels.level_4,
          ltLevels.level_5
        ].filter(level => level !== null && level !== undefined);
      } else if (Array.isArray(ltLevels.support)) {
        // Array format
        ltLevelArray = ltLevels.support;
      }

      ltLevelsBelow = countLevelsBelow(ltLevelArray, levelValue);

      // Analyze LT level configuration
      ltConfig = this.analyzeLtConfiguration(ltLevelArray, ltLevels.sentiment);
    }

    // Apply basic liquidity filter if enabled
    if (this.params.useLiquidityFilter) {
      const basicFilterPassed = ltLevelsBelow <= this.params.maxLtLevelsBelow;
      if (!basicFilterPassed) {
        return {
          passed: false,
          ltLevelsBelow,
          ltConfig,
          filterReason: `Too many LT levels below (${ltLevelsBelow} > ${this.params.maxLtLevelsBelow})`
        };
      }
    }

    // Apply enhanced LT configuration filtering
    if (this.params.filterByLtConfiguration && ltConfig) {
      const configFilter = this.evaluateLtConfigurationFilter(ltConfig);
      if (!configFilter.passed) {
        return {
          passed: false,
          ltLevelsBelow,
          ltConfig,
          filterReason: configFilter.reason
        };
      }
    }

    return { passed: true, ltLevelsBelow, ltConfig };
  }

  /**
   * Analyze LT level stacking configuration for LDPM patterns
   *
   * @param {number[]} ltLevels - Array of LT levels
   * @param {string} sentiment - Market sentiment (BULLISH/BEARISH)
   * @returns {Object} Configuration analysis
   */
  analyzeLtConfiguration(ltLevels, sentiment) {
    if (!ltLevels || ltLevels.length < 2) {
      return { ordering: 'UNKNOWN', spacing: 'UNKNOWN', sentiment: sentiment || 'UNKNOWN' };
    }

    // Analyze ordering pattern
    const ordering = this.getLtOrdering(ltLevels);

    // Analyze spacing pattern
    const spacing = this.getLtSpacing(ltLevels);

    // Determine LDMP configuration type
    const ldmpType = this.classifyLdmpConfiguration(ordering, spacing, sentiment);

    return {
      ordering,
      spacing,
      sentiment: sentiment || 'UNKNOWN',
      ldmpType,
      levelValues: ltLevels.slice(0, 5), // Keep first 5 levels for analysis
      avgSpacing: this.calculateAverageSpacing(ltLevels)
    };
  }

  /**
   * Determine ordering pattern of LT levels
   */
  getLtOrdering(levels) {
    if (levels.length < 2) return 'UNKNOWN';

    let ascending = true;
    let descending = true;

    for (let i = 1; i < levels.length; i++) {
      if (levels[i] <= levels[i-1]) ascending = false;
      if (levels[i] >= levels[i-1]) descending = false;
    }

    if (ascending) return 'ASCENDING';
    if (descending) return 'DESCENDING';
    return 'MIXED';
  }

  /**
   * Calculate average spacing between levels
   */
  calculateAverageSpacing(levels) {
    if (levels.length < 2) return 0;

    let totalSpacing = 0;
    let spacingCount = 0;

    for (let i = 1; i < levels.length; i++) {
      totalSpacing += Math.abs(levels[i] - levels[i-1]);
      spacingCount++;
    }

    return spacingCount > 0 ? totalSpacing / spacingCount : 0;
  }

  /**
   * Classify spacing as tight, medium, or wide
   */
  getLtSpacing(levels) {
    const avgSpacing = this.calculateAverageSpacing(levels);

    if (avgSpacing < 50) return 'TIGHT';
    if (avgSpacing < 150) return 'MEDIUM';
    return 'WIDE';
  }

  /**
   * Classify LDMP configuration based on ordering, spacing, and sentiment
   * Based on LDPM Primer patterns for bullish vs bearish vs trap setups
   */
  classifyLdmpConfiguration(ordering, spacing, sentiment) {
    // Based on LDPM Primer analysis patterns
    if (sentiment === 'BULLISH') {
      if (ordering === 'ASCENDING' && spacing === 'TIGHT') return 'BULLISH_TIGHT_STACK';
      if (ordering === 'ASCENDING' && spacing === 'MEDIUM') return 'BULLISH_NORMAL';
      if (ordering === 'DESCENDING') return 'BULLISH_REVERSAL';
      if (ordering === 'MIXED' && spacing === 'WIDE') return 'BULLISH_TRAP_POTENTIAL';
    }

    if (sentiment === 'BEARISH') {
      if (ordering === 'DESCENDING' && spacing === 'TIGHT') return 'BEARISH_TIGHT_STACK';
      if (ordering === 'DESCENDING' && spacing === 'MEDIUM') return 'BEARISH_NORMAL';
      if (ordering === 'ASCENDING') return 'BEARISH_REVERSAL';
      if (ordering === 'MIXED' && spacing === 'WIDE') return 'BEARISH_TRAP_POTENTIAL';
    }

    return 'MIXED_CONFIGURATION';
  }

  /**
   * Evaluate LT configuration against filtering criteria
   * Based on performance analysis: BULLISH_TRAP_POTENTIAL ($258), MIXED ($116), etc.
   *
   * @param {Object} ltConfig - LT configuration analysis
   * @returns {Object} { passed: boolean, reason?: string }
   */
  evaluateLtConfigurationFilter(ltConfig) {
    if (!ltConfig) {
      return { passed: true, reason: 'No LT config available' };
    }

    // Apply filter profile-specific rules
    if (this.params.ltFilterProfile === 'conservative') {
      return this.applyConservativeFilter(ltConfig);
    } else if (this.params.ltFilterProfile === 'aggressive') {
      return this.applyAggressiveFilter(ltConfig);
    }

    // Apply custom filtering rules
    return this.applyCustomFilter(ltConfig);
  }

  /**
   * Apply conservative filtering (higher quality setups)
   */
  applyConservativeFilter(ltConfig) {
    // Block worst performers (negative P&L)
    if (['BULLISH_REVERSAL', 'BEARISH_REVERSAL'].includes(ltConfig.ldmpType)) {
      return {
        passed: false,
        reason: `Conservative: Blocked ${ltConfig.ldmpType} (negative P&L: BULLISH_REVERSAL -$75, BEARISH_REVERSAL -$12)`
      };
    }

    // Block ASCENDING ordering (only $7.89 avg P&L)
    if (ltConfig.ordering === 'ASCENDING') {
      return {
        passed: false,
        reason: `Conservative: Blocked ASCENDING ordering (avg P&L: $7.89 vs MIXED: $116.79)`
      };
    }

    // Prefer BULLISH sentiment (2x better performance)
    if (this.params.preferredLtSentiment === 'BULLISH' && ltConfig.sentiment !== 'BULLISH') {
      return {
        passed: false,
        reason: `Conservative: Prefer BULLISH sentiment ($168.95 avg) over ${ltConfig.sentiment} ($83.74 avg)`
      };
    }

    // Block TIGHT spacing in conservative mode (worst spacing performance)
    if (ltConfig.spacing === 'TIGHT') {
      return {
        passed: false,
        reason: `Conservative: Blocked TIGHT spacing ($94.57 avg) vs MEDIUM ($112.76) or WIDE ($120.92)`
      };
    }

    return { passed: true };
  }

  /**
   * Apply aggressive filtering (more trades, block only worst)
   */
  applyAggressiveFilter(ltConfig) {
    // Only block confirmed negative performers
    if (['BULLISH_REVERSAL', 'BEARISH_REVERSAL'].includes(ltConfig.ldmpType)) {
      return {
        passed: false,
        reason: `Aggressive: Blocked ${ltConfig.ldmpType} (negative P&L)`
      };
    }

    // Only block worst ordering pattern
    if (ltConfig.ordering === 'ASCENDING') {
      return {
        passed: false,
        reason: `Aggressive: Blocked ASCENDING ordering (worst performer: $7.89 avg)`
      };
    }

    return { passed: true };
  }

  /**
   * Apply custom filtering rules based on parameters
   */
  applyCustomFilter(ltConfig) {
    // Block specific ordering patterns
    if (this.params.blockedLtOrderings?.includes(ltConfig.ordering)) {
      return {
        passed: false,
        reason: `Blocked LT ordering: ${ltConfig.ordering} (avg P&L analysis)`
      };
    }

    // Block specific LDMP types
    if (this.params.blockedLdmpTypes?.includes(ltConfig.ldmpType)) {
      return {
        passed: false,
        reason: `Blocked LDMP type: ${ltConfig.ldmpType} (negative P&L pattern)`
      };
    }

    // Check required sentiment
    if (this.params.requiredLtSentiment && ltConfig.sentiment !== this.params.requiredLtSentiment) {
      return {
        passed: false,
        reason: `Required sentiment: ${this.params.requiredLtSentiment}, got: ${ltConfig.sentiment}`
      };
    }

    // Check allowed sentiments
    if (this.params.allowedLtSentiments?.length > 0 &&
        !this.params.allowedLtSentiments.includes(ltConfig.sentiment)) {
      return {
        passed: false,
        reason: `Sentiment ${ltConfig.sentiment} not in allowed list: ${this.params.allowedLtSentiments.join(', ')}`
      };
    }

    // Check spacing requirements
    if (this.params.minLtSpacing) {
      const spacingHierarchy = { 'TIGHT': 1, 'MEDIUM': 2, 'WIDE': 3 };
      if (spacingHierarchy[ltConfig.spacing] < spacingHierarchy[this.params.minLtSpacing]) {
        return {
          passed: false,
          reason: `Minimum spacing: ${this.params.minLtSpacing}, got: ${ltConfig.spacing}`
        };
      }
    }

    // Check allowed ordering patterns
    if (this.params.allowedLtOrderings?.length > 0 &&
        !this.params.allowedLtOrderings.includes(ltConfig.ordering)) {
      return {
        passed: false,
        reason: `Ordering ${ltConfig.ordering} not in allowed list: ${this.params.allowedLtOrderings.join(', ')}`
      };
    }

    return { passed: true };
  }

  /**
   * Generate signal object in consistent format
   *
   * @param {Object} candle - Current candle
   * @param {number} gexLevel - GEX level that was crossed
   * @param {string} gexLevelType - Type of GEX level
   * @param {number} stopPrice - Stop loss price
   * @param {number} ltLevelsBelowGex - Number of LT levels below GEX trigger level
   * @param {number} riskPoints - Risk in points
   * @param {Object} ltConfig - LT configuration analysis
   * @param {Object} gexLevels - Full GEX levels object for context metadata
   * @param {number} momentumValue - Squeeze momentum value at signal time
   * @param {number} rsiValue - RSI (14 period) value at signal time
   * @param {number} williamsRValue - Williams %R (14 period) value at signal time
   * @param {number} stochasticK - Stochastic %K (14,3,3) value at signal time
   * @param {number} stochasticD - Stochastic %D (14,3,3) value at signal time
   * @param {number} cciValue - CCI (20 period) value at signal time
   * @param {Object} cvdFilterResult - CVD filter result with slope and momentum data
   * @returns {Object} Signal object
   */
  generateSignalObject(candle, gexLevel, gexLevelType, stopPrice, ltLevelsBelowGex, riskPoints, ltConfig, gexLevels, momentumValue = null, rsiValue = null, williamsRValue = null, stochasticK = null, stochasticD = null, cciValue = null, cvdFilterResult = null) {
    // Set takeProfit to null if targetPoints is 0/null (trailing stop only mode)
    const takeProfit = this.params.targetPoints ? candle.close + this.params.targetPoints : null;

    const signal = {
      // Core signal data
      strategy: 'GEX_RECOIL',
      side: 'buy',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      entryPrice: roundTo(candle.close),
      stopLoss: roundTo(stopPrice),
      takeProfit: takeProfit != null ? roundTo(takeProfit) : null,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      // Strategy-specific metadata
      metadata: {
        gex_level: roundTo(gexLevel),
        gex_level_type: gexLevelType,
        lt_levels_below_gex: ltLevelsBelowGex,
        risk_points: roundTo(riskPoints),
        candle_time: new Date(candle.timestamp).toISOString(),
        entry_reason: `Price crossed below ${gexLevelType} at ${roundTo(gexLevel)}`,
        target_points: this.params.targetPoints,
        stop_buffer: this.params.stopBuffer,

        // LT Configuration Analysis (LDPM patterns)
        lt_sentiment: ltConfig?.sentiment || 'UNKNOWN',
        lt_ordering: ltConfig?.ordering || 'UNKNOWN',
        lt_spacing: ltConfig?.spacing || 'UNKNOWN',
        lt_ldmp_type: ltConfig?.ldmpType || 'UNKNOWN',
        lt_avg_spacing: ltConfig?.avgSpacing ? roundTo(ltConfig.avgSpacing) : 0,
        lt_level_values: ltConfig?.levelValues || [],

        // Squeeze Momentum Analysis
        squeeze_momentum_value: momentumValue !== null ? roundTo(momentumValue, 6) : null,

        // Technical Indicators
        rsi_14: rsiValue !== null ? roundTo(rsiValue, 2) : null,
        williams_r_14: williamsRValue !== null ? roundTo(williamsRValue, 2) : null,
        stochastic_k: stochasticK !== null ? roundTo(stochasticK, 2) : null,
        stochastic_d: stochasticD !== null ? roundTo(stochasticD, 2) : null,
        cci_20: cciValue !== null ? roundTo(cciValue, 2) : null,

        // GEX context at signal time
        gex_regime: gexLevels?.regime || 'unknown',
        gex_total: gexLevels?.total_gex ? Math.round(gexLevels.total_gex / 1e9) : null, // In billions
        gex_source: gexLevels?.support ? 'json_15min' : 'csv_daily',

        // CVD Order Flow Analysis (Phase 3)
        cvd_slope: cvdFilterResult?.results?.slope !== undefined ? roundTo(cvdFilterResult.results.slope, 2) : null,
        cvd_cumulative_delta: cvdFilterResult?.results?.cumulativeDelta !== undefined ? roundTo(cvdFilterResult.results.cumulativeDelta, 0) : null,
        cvd_momentum: cvdFilterResult?.results?.momentum !== undefined ? roundTo(cvdFilterResult.results.momentum, 0) : null,
        cvd_filter_passed: cvdFilterResult?.passes ?? true
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
   * Get strategy name
   *
   * @returns {string} Strategy name
   */
  getName() {
    return 'GEX_RECOIL';
  }

  /**
   * Get strategy description
   *
   * @returns {string} Strategy description
   */
  getDescription() {
    return 'GEX Recoil Fade strategy - enters long when price crosses below GEX support levels (put walls)';
  }

  /**
   * Get required market data fields
   *
   * @returns {string[]} Array of required field paths
   */
  getRequiredMarketData() {
    const required = ['gexLevels'];
    if (this.params.useLiquidityFilter) {
      required.push('ltLevels');
    }
    return required;
  }

  /**
   * Validate strategy parameters
   *
   * @param {Object} params - Parameters to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validateParams(params) {
    const errors = [];

    if (params.targetPoints <= 0) {
      errors.push('targetPoints must be greater than 0');
    }

    if (params.stopBuffer < 0) {
      errors.push('stopBuffer must be non-negative');
    }

    if (params.maxRisk <= 0) {
      errors.push('maxRisk must be greater than 0');
    }

    if (params.signalCooldownMs < 0) {
      errors.push('signalCooldownMs must be non-negative');
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
   * @param {Map<number, Object>} imbalanceMap - Map from MBPLoader.computeImbalanceForDateRange()
   */
  loadBookImbalanceData(imbalanceMap) {
    if (imbalanceMap && imbalanceMap.size > 0) {
      this.bookImbalanceCalculator.loadPrecomputedImbalance(imbalanceMap);
      this.bookImbalanceDataLoaded = true;
    }
  }

  /**
   * Check Book Imbalance Filters (Phase 4 Order Flow)
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

    // If imbalance data not loaded, skip filter (allow trade)
    if (!this.bookImbalanceDataLoaded) {
      return { passes: true, results: null, reasons: ['Book imbalance data not loaded'] };
    }

    // Run the book imbalance filter check
    const filterResult = this.bookImbalanceFilter.check(side, candle);

    this.lastBookImbalanceResults = {
      passes: filterResult.passes,
      sizeImbalance: filterResult.details.sizeImbalance,
      bidAskRatio: filterResult.details.bidAskRatio,
      slope: filterResult.details.slope,
      strength: filterResult.details.strength
    };

    return {
      passes: filterResult.passes,
      results: this.lastBookImbalanceResults,
      reasons: filterResult.reasons
    };
  }
}

export default GexRecoilStrategy;