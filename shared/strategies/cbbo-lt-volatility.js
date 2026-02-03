/**
 * CBBO-LT Volatility Strategy
 *
 * Predicts volatility using QQQ options spread widening combined with
 * LT (Liquidity Trigger) sentiment for direction prediction.
 *
 * Statistical basis:
 *   - CBBO spreads widen before large candles: Cohen's d = 0.24 (significant)
 *   - LT Sentiment predicts direction: Cohen's d = 0.645 (highly significant)
 *   - 59% of bullish events had BULLISH LT sentiment vs only 29% of bearish events
 *
 * Signal Logic:
 *   1. Detect spread increase above threshold (volatility precursor)
 *   2. Use LT sentiment to predict direction (BULLISH -> long, BEARISH -> short)
 *   3. Enter near GEX levels for additional confluence
 */

import { BaseStrategy } from './base-strategy.js';

export class CBBOLTVolatilityStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Default strategy parameters
    this.defaultParams = {
      // CBBO spread detection
      spreadThreshold: 0.15,        // % increase in avgSpread to trigger volatility alert
      lookbackMinutes: 30,          // Window for spread change calculation
      minSpreadIncrease: 0.10,      // Minimum spread increase to consider
      minAbsoluteSpread: 0.5,       // Minimum absolute spread % to avoid noise

      // LT sentiment configuration
      ltSentimentWeight: 0.65,      // Weight given to LT sentiment for direction
      requiredLtSentiment: null,    // Optional: only trade specific sentiment

      // GEX level entry
      useGexLevels: true,           // Use GEX levels for entry price
      gexProximityPoints: 15,       // Max distance from GEX level for entry

      // Exit parameters - symmetrical 1:1 R/R for baseline analysis
      targetPoints: 30.0,           // Profit target
      stopLossPoints: 30.0,         // Stop loss
      maxHoldMinutes: null,         // No max hold time

      // Trailing stop - disabled by default for clean win/loss analysis
      useTrailingStop: false,
      trailingTrigger: 10.0,        // Points profit before trailing activates
      trailingOffset: 5.0,          // Points behind high water mark

      // Position sizing
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Cooldown
      signalCooldownMs: 900000,     // 15 minutes between signals

      // Session filtering (volatility patterns differ by session)
      useSessionFilter: true,
      blockedSessions: ['overnight'], // Avoid overnight due to thin liquidity

      // Direction filter
      useLongEntries: true,
      useShortEntries: true,
    };

    // Merge with provided parameters
    this.params = { ...this.defaultParams, ...params };

    // Internal state
    this.lastVolatilityAlert = null;
    this.pendingDirection = null;
  }

  /**
   * Evaluate if a volatility signal should be generated
   *
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Contains gexLevels, ltLevels, cbbo, cbboSpreadChange
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Validate inputs
    if (!candle || !prevCandle || !marketData) {
      return null;
    }

    // Check cooldown
    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) {
      return null;
    }

    // Get CBBO spread change data
    const spreadChange = marketData.cbboSpreadChange;
    const cbboMetrics = marketData.cbbo;

    // Get LT sentiment
    const ltLevels = marketData.ltLevels;
    const sentiment = ltLevels?.sentiment;

    // Skip if no CBBO or LT data
    if (!spreadChange && !cbboMetrics) {
      return null;
    }

    if (!sentiment || !['BULLISH', 'BEARISH'].includes(sentiment)) {
      return null;
    }

    // Check required sentiment filter
    if (this.params.requiredLtSentiment && sentiment !== this.params.requiredLtSentiment) {
      return null;
    }

    // Step 1: Check for volatility precursor (spread widening)
    const volatilityDetected = this.detectVolatility(spreadChange, cbboMetrics);
    if (!volatilityDetected) {
      return null;
    }

    // Step 2: Determine direction from LT sentiment
    const direction = sentiment === 'BULLISH' ? 'buy' : 'sell';

    // Check direction filters
    if (direction === 'buy' && !this.params.useLongEntries) {
      return null;
    }
    if (direction === 'sell' && !this.params.useShortEntries) {
      return null;
    }

    // Step 3: Check GEX level proximity for entry
    const gexLevels = marketData.gexLevels;
    const entryLevel = this.findEntryLevel(candle.close, direction, gexLevels);

    // Step 4: Generate signal
    this.updateLastSignalTime(candle.timestamp);

    return this.generateSignalObject(
      candle,
      direction,
      entryLevel,
      spreadChange,
      cbboMetrics,
      ltLevels,
      gexLevels
    );
  }

  /**
   * Detect volatility precursor from CBBO spread data
   *
   * @param {Object} spreadChange - Spread change metrics
   * @param {Object} cbboMetrics - Current CBBO metrics
   * @returns {boolean} True if volatility detected
   */
  detectVolatility(spreadChange, cbboMetrics) {
    // Method 1: Check spread change over lookback window
    if (spreadChange) {
      const percentChange = spreadChange.percentChange || 0;

      // Spreads widening indicates uncertainty/volatility
      if (percentChange >= this.params.spreadThreshold) {
        return true;
      }

      // Also check minimum increase threshold
      if (percentChange >= this.params.minSpreadIncrease &&
          spreadChange.secondHalfAvg >= this.params.minAbsoluteSpread) {
        return true;
      }
    }

    // Method 2: Check current spread level
    if (cbboMetrics) {
      const currentSpread = cbboMetrics.avgSpread || 0;
      const spreadVol = cbboMetrics.spreadVolatility || 0;

      // High absolute spread with high volatility indicates uncertainty
      if (currentSpread >= this.params.minAbsoluteSpread * 2 && spreadVol >= 0.5) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find entry level based on GEX levels and direction
   *
   * @param {number} currentPrice - Current price
   * @param {string} direction - 'buy' or 'sell'
   * @param {Object} gexLevels - GEX levels object
   * @returns {Object|null} Entry level info or null
   */
  findEntryLevel(currentPrice, direction, gexLevels) {
    if (!this.params.useGexLevels || !gexLevels) {
      return null;
    }

    const proximity = this.params.gexProximityPoints;

    if (direction === 'buy') {
      // Look for nearby support levels
      const supportLevels = [
        ...(gexLevels.support || []),
        gexLevels.put_wall,
        gexLevels.gamma_flip
      ].filter(l => l != null && !isNaN(l));

      // Find closest support below or near current price
      let bestLevel = null;
      let bestDistance = Infinity;

      for (const level of supportLevels) {
        const distance = currentPrice - level;
        if (distance >= -proximity && distance <= proximity * 2 && Math.abs(distance) < bestDistance) {
          bestLevel = level;
          bestDistance = Math.abs(distance);
        }
      }

      if (bestLevel !== null) {
        return {
          price: bestLevel,
          type: bestLevel === gexLevels.put_wall ? 'put_wall' :
                bestLevel === gexLevels.gamma_flip ? 'gamma_flip' : 'support',
          distance: currentPrice - bestLevel
        };
      }
    } else {
      // Look for nearby resistance levels
      const resistanceLevels = [
        ...(gexLevels.resistance || []),
        gexLevels.call_wall,
        gexLevels.gamma_flip
      ].filter(l => l != null && !isNaN(l));

      // Find closest resistance above or near current price
      let bestLevel = null;
      let bestDistance = Infinity;

      for (const level of resistanceLevels) {
        const distance = level - currentPrice;
        if (distance >= -proximity && distance <= proximity * 2 && Math.abs(distance) < bestDistance) {
          bestLevel = level;
          bestDistance = Math.abs(distance);
        }
      }

      if (bestLevel !== null) {
        return {
          price: bestLevel,
          type: bestLevel === gexLevels.call_wall ? 'call_wall' :
                bestLevel === gexLevels.gamma_flip ? 'gamma_flip' : 'resistance',
          distance: bestLevel - currentPrice
        };
      }
    }

    return null;
  }

  /**
   * Generate signal object
   *
   * @param {Object} candle - Current candle
   * @param {string} direction - 'buy' or 'sell'
   * @param {Object|null} entryLevel - GEX level entry info
   * @param {Object} spreadChange - Spread change metrics
   * @param {Object} cbboMetrics - CBBO metrics
   * @param {Object} ltLevels - LT levels data
   * @param {Object} gexLevels - GEX levels data
   * @returns {Object} Signal object
   */
  generateSignalObject(candle, direction, entryLevel, spreadChange, cbboMetrics, ltLevels, gexLevels) {
    const entryPrice = this.roundTo(candle.close);

    // Calculate stops based on direction
    let stopLoss, takeProfit;
    if (direction === 'buy') {
      stopLoss = this.roundTo(entryPrice - this.params.stopLossPoints);
      takeProfit = this.roundTo(entryPrice + this.params.targetPoints);
    } else {
      stopLoss = this.roundTo(entryPrice + this.params.stopLossPoints);
      takeProfit = this.roundTo(entryPrice - this.params.targetPoints);
    }

    const signal = {
      // Core signal data
      strategy: 'CBBO_LT_VOLATILITY',
      side: direction,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      entryPrice: entryPrice,
      stopLoss: stopLoss,
      takeProfit: takeProfit,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      // Strategy-specific metadata
      metadata: {
        // CBBO metrics
        spread_change_pct: spreadChange?.percentChange != null ?
          this.roundTo(spreadChange.percentChange * 100, 2) : null,
        spread_first_half: spreadChange?.firstHalfAvg != null ?
          this.roundTo(spreadChange.firstHalfAvg, 4) : null,
        spread_second_half: spreadChange?.secondHalfAvg != null ?
          this.roundTo(spreadChange.secondHalfAvg, 4) : null,
        current_avg_spread: cbboMetrics?.avgSpread != null ?
          this.roundTo(cbboMetrics.avgSpread, 4) : null,
        spread_volatility: cbboMetrics?.spreadVolatility != null ?
          this.roundTo(cbboMetrics.spreadVolatility, 4) : null,
        put_call_size_ratio: cbboMetrics?.putCallSizeRatio != null ?
          this.roundTo(cbboMetrics.putCallSizeRatio, 4) : null,

        // LT metrics
        lt_sentiment: ltLevels?.sentiment || 'UNKNOWN',
        lt_level_1: ltLevels?.level_1 || null,
        lt_level_2: ltLevels?.level_2 || null,
        lt_level_3: ltLevels?.level_3 || null,

        // GEX context
        entry_gex_level: entryLevel?.price || null,
        entry_gex_type: entryLevel?.type || null,
        entry_gex_distance: entryLevel?.distance != null ?
          this.roundTo(entryLevel.distance, 2) : null,
        gex_regime: gexLevels?.regime || 'unknown',

        // Entry reasoning
        entry_reason: this.formatEntryReason(direction, spreadChange, ltLevels, entryLevel),

        // Risk parameters
        target_points: this.params.targetPoints,
        stop_loss_points: this.params.stopLossPoints,
        lookback_minutes: this.params.lookbackMinutes,
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
   * Format entry reason for metadata
   *
   * @param {string} direction - 'buy' or 'sell'
   * @param {Object} spreadChange - Spread change data
   * @param {Object} ltLevels - LT levels data
   * @param {Object} entryLevel - Entry level data
   * @returns {string} Formatted entry reason
   */
  formatEntryReason(direction, spreadChange, ltLevels, entryLevel) {
    const parts = [];

    // Volatility detection
    if (spreadChange?.percentChange) {
      parts.push(`Spread widened ${(spreadChange.percentChange * 100).toFixed(1)}%`);
    }

    // Direction from sentiment
    parts.push(`${ltLevels?.sentiment} sentiment -> ${direction.toUpperCase()}`);

    // GEX level
    if (entryLevel) {
      parts.push(`near ${entryLevel.type} @ ${entryLevel.price}`);
    }

    return parts.join('; ');
  }

  /**
   * Round to specified decimal places
   *
   * @param {number} value - Value to round
   * @param {number} decimals - Decimal places (default 2)
   * @returns {number} Rounded value
   */
  roundTo(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return null;
    const multiplier = Math.pow(10, decimals);
    return Math.round(value * multiplier) / multiplier;
  }

  /**
   * Get strategy name
   * @returns {string} Strategy name
   */
  getName() {
    return 'CBBO_LT_VOLATILITY';
  }

  /**
   * Get strategy description
   * @returns {string} Strategy description
   */
  getDescription() {
    return 'CBBO-LT Volatility Strategy - predicts volatility using options spread widening and LT sentiment for direction';
  }

  /**
   * Get required market data fields
   * @returns {string[]} Array of required field paths
   */
  getRequiredMarketData() {
    return ['cbbo', 'cbboSpreadChange', 'ltLevels'];
  }

  /**
   * Validate strategy parameters
   * @param {Object} params - Parameters to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validateParams(params) {
    const errors = [];

    if (params.spreadThreshold <= 0 || params.spreadThreshold > 1) {
      errors.push('spreadThreshold must be between 0 and 1');
    }

    if (params.lookbackMinutes <= 0) {
      errors.push('lookbackMinutes must be greater than 0');
    }

    if (params.targetPoints <= 0) {
      errors.push('targetPoints must be greater than 0');
    }

    if (params.stopLossPoints <= 0) {
      errors.push('stopLossPoints must be greater than 0');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export default CBBOLTVolatilityStrategy;
