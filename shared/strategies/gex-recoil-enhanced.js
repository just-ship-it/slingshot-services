/**
 * Enhanced GEX Recoil Strategy
 *
 * Extends the base GEX Recoil strategy with additional filters based on
 * correlation analysis findings:
 *
 * Key Enhancement: Negative GEX Regime Filter
 * - Analysis showed support bounces have 57.1% win rate in negative GEX regimes
 *   vs 53.3% in positive GEX regimes
 * - Average return: +0.095% in negative GEX vs +0.015% in positive GEX
 *
 * Additional Filters Available:
 * - IV percentile filter (high IV predicts higher volatility)
 * - Liquidity sentiment alignment
 */

import { GexRecoilStrategy } from './gex-recoil.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class GexRecoilEnhancedStrategy extends GexRecoilStrategy {
  constructor(params = {}) {
    // Enhanced default parameters
    const enhancedDefaults = {
      // GEX Regime Filter (Primary Enhancement)
      useGexRegimeFilter: true,
      preferNegativeGexRegime: true,  // Based on analysis: 57.1% vs 53.3% win rate
      allowedGexRegimes: ['negative', 'strong_negative'],  // Only trade in negative GEX
      blockPositiveGexRegime: true,

      // IV Filter (Secondary Enhancement)
      useIvFilter: false,
      minIvPercentile: null,  // e.g., 30 - only trade when IV > 30th percentile
      maxIvPercentile: null,  // e.g., 80 - avoid extreme IV
      preferHighIv: false,    // High IV = larger targets potential

      // Liquidity Sentiment Filter
      useLiquiditySentimentFilter: false,
      requiredLiquiditySentiment: null,  // 'BULLISH' or 'BEARISH'
      alignLiquidityWithGex: false,  // Require sentiment to align with GEX regime

      // Dynamic Target Adjustment based on IV
      useDynamicTargets: false,
      lowIvTargetMultiplier: 0.8,   // Reduce targets in low IV
      highIvTargetMultiplier: 1.3,  // Increase targets in high IV
      ivThresholdLow: 30,
      ivThresholdHigh: 70,

      // Logging
      logFilterReasons: true
    };

    // Merge with base defaults and provided params
    super({ ...enhancedDefaults, ...params });

    // Track filter statistics
    this.filterStats = {
      totalSignalsEvaluated: 0,
      passedAllFilters: 0,
      blockedByGexRegime: 0,
      blockedByIv: 0,
      blockedByLiquiditySentiment: 0,
      blockedByOtherFilters: 0
    };
  }

  /**
   * Override evaluateSignal to add enhanced filtering
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Validate inputs
    if (!isValidCandle(candle) || !isValidCandle(prevCandle)) {
      return null;
    }

    // Extract market data
    const { gexLevels, ltLevels, ivData } = marketData || {};
    if (!gexLevels) {
      return null;
    }

    this.filterStats.totalSignalsEvaluated++;

    // === ENHANCED FILTER 1: GEX Regime Filter ===
    if (this.params.useGexRegimeFilter) {
      const regimeCheckResult = this.checkGexRegimeFilter(gexLevels);
      if (!regimeCheckResult.passed) {
        this.filterStats.blockedByGexRegime++;
        if (this.params.logFilterReasons && options.verbose) {
          console.log(`   [GEX Regime Filter] Blocked: ${regimeCheckResult.reason}`);
        }
        return null;
      }
    }

    // === ENHANCED FILTER 2: IV Filter ===
    if (this.params.useIvFilter && ivData) {
      const ivCheckResult = this.checkIvFilter(ivData);
      if (!ivCheckResult.passed) {
        this.filterStats.blockedByIv++;
        if (this.params.logFilterReasons && options.verbose) {
          console.log(`   [IV Filter] Blocked: ${ivCheckResult.reason}`);
        }
        return null;
      }
    }

    // === ENHANCED FILTER 3: Liquidity Sentiment Filter ===
    if (this.params.useLiquiditySentimentFilter && ltLevels) {
      const liqCheckResult = this.checkLiquiditySentimentFilter(ltLevels, gexLevels);
      if (!liqCheckResult.passed) {
        this.filterStats.blockedByLiquiditySentiment++;
        if (this.params.logFilterReasons && options.verbose) {
          console.log(`   [Liquidity Sentiment Filter] Blocked: ${liqCheckResult.reason}`);
        }
        return null;
      }
    }

    // Call parent evaluateSignal for core logic
    const signal = super.evaluateSignal(candle, prevCandle, marketData, options);

    if (signal) {
      this.filterStats.passedAllFilters++;

      // Add enhanced metadata
      signal.metadata = {
        ...signal.metadata,
        enhanced_strategy: true,
        gex_regime_at_entry: gexLevels.regime || 'unknown',
        gex_regime_filter_active: this.params.useGexRegimeFilter,
        iv_filter_active: this.params.useIvFilter,
        liq_sentiment_filter_active: this.params.useLiquiditySentimentFilter
      };

      // Apply dynamic targets if enabled
      if (this.params.useDynamicTargets && ivData && signal.takeProfit) {
        signal.takeProfit = this.adjustTargetForIv(signal, ivData);
        signal.metadata.target_adjusted_for_iv = true;
        signal.metadata.iv_at_entry = ivData.iv || ivData.iv_percentile;
      }
    }

    return signal;
  }

  /**
   * Check GEX Regime Filter
   *
   * Based on analysis: Negative GEX regimes show 57.1% win rate vs 53.3% for positive
   *
   * @param {Object} gexLevels - GEX levels including regime
   * @returns {Object} { passed: boolean, reason?: string }
   */
  checkGexRegimeFilter(gexLevels) {
    const regime = gexLevels.regime || gexLevels.gex_regime;

    if (!regime) {
      // No regime data available - pass through (don't block)
      return { passed: true, reason: 'No regime data available' };
    }

    const normalizedRegime = regime.toLowerCase();

    // Check if regime is in allowed list
    if (this.params.allowedGexRegimes && this.params.allowedGexRegimes.length > 0) {
      const isAllowed = this.params.allowedGexRegimes.some(allowed =>
        normalizedRegime.includes(allowed.toLowerCase())
      );

      if (!isAllowed) {
        return {
          passed: false,
          reason: `Regime '${regime}' not in allowed list: ${this.params.allowedGexRegimes.join(', ')}`
        };
      }
    }

    // Block positive regimes if configured
    if (this.params.blockPositiveGexRegime) {
      if (normalizedRegime.includes('positive') || normalizedRegime === 'positive' || normalizedRegime === 'strong_positive') {
        return {
          passed: false,
          reason: `Blocked positive GEX regime: ${regime} (analysis shows 53.3% win rate vs 57.1% in negative)`
        };
      }
    }

    return { passed: true };
  }

  /**
   * Check IV Filter
   *
   * Based on analysis: IV percentile correlates with future volatility (r=0.30)
   *
   * @param {Object} ivData - IV data including percentile
   * @returns {Object} { passed: boolean, reason?: string }
   */
  checkIvFilter(ivData) {
    const ivPercentile = ivData.iv_percentile || ivData.ivPercentile || ivData.percentile;

    if (ivPercentile === null || ivPercentile === undefined) {
      return { passed: true, reason: 'No IV percentile data' };
    }

    // Check minimum IV percentile
    if (this.params.minIvPercentile !== null && ivPercentile < this.params.minIvPercentile) {
      return {
        passed: false,
        reason: `IV percentile ${ivPercentile.toFixed(1)} below minimum ${this.params.minIvPercentile}`
      };
    }

    // Check maximum IV percentile
    if (this.params.maxIvPercentile !== null && ivPercentile > this.params.maxIvPercentile) {
      return {
        passed: false,
        reason: `IV percentile ${ivPercentile.toFixed(1)} above maximum ${this.params.maxIvPercentile}`
      };
    }

    return { passed: true };
  }

  /**
   * Check Liquidity Sentiment Filter
   *
   * @param {Object} ltLevels - Liquidity trigger levels
   * @param {Object} gexLevels - GEX levels for alignment check
   * @returns {Object} { passed: boolean, reason?: string }
   */
  checkLiquiditySentimentFilter(ltLevels, gexLevels) {
    const sentiment = ltLevels.sentiment || ltLevels.liq_sentiment;

    if (!sentiment) {
      return { passed: true, reason: 'No liquidity sentiment data' };
    }

    // Check required sentiment
    if (this.params.requiredLiquiditySentiment) {
      if (sentiment.toUpperCase() !== this.params.requiredLiquiditySentiment.toUpperCase()) {
        return {
          passed: false,
          reason: `Liquidity sentiment '${sentiment}' != required '${this.params.requiredLiquiditySentiment}'`
        };
      }
    }

    // Check GEX-Liquidity alignment
    if (this.params.alignLiquidityWithGex && gexLevels.regime) {
      const gexRegime = gexLevels.regime.toLowerCase();
      const liqSentiment = sentiment.toUpperCase();

      // In negative GEX, prefer BULLISH liquidity (contrarian bounce setup)
      // In positive GEX, either sentiment is acceptable
      if (gexRegime.includes('negative') && liqSentiment !== 'BULLISH') {
        return {
          passed: false,
          reason: `Negative GEX + ${liqSentiment} liquidity - prefer BULLISH for bounce`
        };
      }
    }

    return { passed: true };
  }

  /**
   * Adjust target based on IV conditions
   *
   * @param {Object} signal - Original signal
   * @param {Object} ivData - IV data
   * @returns {number} Adjusted take profit price
   */
  adjustTargetForIv(signal, ivData) {
    const ivPercentile = ivData.iv_percentile || ivData.ivPercentile || 50;
    const entryPrice = signal.entryPrice;
    const originalTarget = signal.takeProfit;
    const originalTargetPoints = originalTarget - entryPrice;

    let multiplier = 1.0;

    if (ivPercentile < this.params.ivThresholdLow) {
      multiplier = this.params.lowIvTargetMultiplier;
    } else if (ivPercentile > this.params.ivThresholdHigh) {
      multiplier = this.params.highIvTargetMultiplier;
    }

    const adjustedTargetPoints = originalTargetPoints * multiplier;
    return roundTo(entryPrice + adjustedTargetPoints);
  }

  /**
   * Get filter statistics
   *
   * @returns {Object} Filter statistics
   */
  getFilterStats() {
    const total = this.filterStats.totalSignalsEvaluated;
    return {
      ...this.filterStats,
      passRate: total > 0 ? (this.filterStats.passedAllFilters / total * 100).toFixed(1) + '%' : '0%',
      gexRegimeBlockRate: total > 0 ? (this.filterStats.blockedByGexRegime / total * 100).toFixed(1) + '%' : '0%',
      ivBlockRate: total > 0 ? (this.filterStats.blockedByIv / total * 100).toFixed(1) + '%' : '0%',
      liqSentimentBlockRate: total > 0 ? (this.filterStats.blockedByLiquiditySentiment / total * 100).toFixed(1) + '%' : '0%'
    };
  }

  /**
   * Reset filter statistics (for new backtest runs)
   */
  resetFilterStats() {
    this.filterStats = {
      totalSignalsEvaluated: 0,
      passedAllFilters: 0,
      blockedByGexRegime: 0,
      blockedByIv: 0,
      blockedByLiquiditySentiment: 0,
      blockedByOtherFilters: 0
    };
  }

  /**
   * Override reset to also reset filter stats
   */
  reset() {
    super.reset();
    this.resetFilterStats();
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'GEX_RECOIL_ENHANCED';
  }

  /**
   * Get strategy description
   */
  getDescription() {
    return 'Enhanced GEX Recoil strategy with negative GEX regime filter (57.1% vs 53.3% win rate improvement)';
  }
}

export default GexRecoilEnhancedStrategy;
