/**
 * Contrarian Bounce Strategy (Scalping Variant)
 *
 * A mean-reversion scalping strategy optimized via grid search on 2025 data.
 * Enters LONG when price closes below gamma flip, uses trailing stop to capture profits.
 *
 * Optimization Results (Jan-Dec 2025, 216 configurations tested):
 * - Best Config: D35_S12_T8/3 (maxDist=35, stop=12, trailTrigger=8, trailOffset=3)
 * - 688 trades | 78.5% win rate | $22,180 P&L | 12.5% max drawdown
 * - Sharpe: 3.33 | Annualized: 24%
 *
 * Key Findings:
 * - Trailing stops drive profitability (+$76,655 from trailing vs -$49,340 from stop losses)
 * - Stop buffer doesn't matter much (12/15/18 all perform identically)
 * - 8pt trailing trigger is optimal (6pt too tight, 10pt loses some profits)
 * - 3pt trailing offset is optimal (locks in gains faster)
 * - Larger distance filter = more trades = better results (35pt max is good)
 * - GEX filter reduces both risk AND reward (trade-off)
 *
 * Entry Logic:
 * - LONG: Price closes below gamma flip, within max distance threshold
 *
 * Exit Logic:
 * - Primary: Trailing stop (triggers at 8pt profit, trails by 3pt)
 * - Target: Gamma flip level (rarely hit due to trailing exits)
 * - Stop: Fixed 12 points below entry
 */

import { BaseStrategy } from './base-strategy.js';
import {
  isValidCandle,
  roundTo,
  roundToNQTick,
  isWithinTimeWindow
} from './strategy-utils.js';

export class ContrarianBounceStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Default strategy parameters - OPTIMIZED via grid search (D35_S12_T8/3)
    // Grid search tested 216 configs on Jan-Dec 2025 data
    // Best result: 688 trades, 78.5% WR, $22,180 P&L, 12.5% DD, Sharpe 3.33
    this.defaultParams = {
      // Position sizing
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Risk management - OPTIMIZED
      stopBuffer: 12.0,          // Points below entry for stop (12/15/18 perform identically)
      maxRisk: 200.0,            // Max risk threshold
      useGexLevelStops: false,   // Use fixed stop (put wall is often too far)

      // Targets
      targetMode: 'gamma_flip',  // 'gamma_flip', 'call_wall', 'fixed', or 'trailing'
      fixedTargetPoints: 30.0,   // Used when targetMode is 'fixed'

      // Trailing stop - ENABLED (primary exit mechanism)
      useTrailingStop: true,
      trailingTrigger: 8.0,      // Activate trailing stop after 8 pts profit (optimal)
      trailingOffset: 3.0,       // Trail by 3 pts (locks in gains faster)

      // Signal cooldown
      signalCooldownMs: 0,       // No cooldown for maximum opportunity capture

      // === FILTERS ===

      // GEX regime filter (reduces DD but also reduces P&L - trade-off)
      requirePositiveGex: false,  // Set true for lower DD (11%) but less P&L ($12,700)

      // Time-of-day filter (UTC hours)
      useTimeFilter: false,
      timeFilterStartHour: 17,   // 12:00 ET = 17:00 UTC
      timeFilterEndHour: 20,     // 15:00 ET = 20:00 UTC

      // Liquidity sentiment filter
      useSentimentFilter: false,
      requiredSentiment: 'BULLISH',

      // Distance filter - ENABLED (critical for scalping approach)
      useDistanceFilter: true,
      minDistanceBelowFlip: 0,   // Enter as soon as price goes below gamma flip
      maxDistanceBelowFlip: 35,  // Only enter within 35 pts of gamma flip (optimal)

      // IV filter (for future implementation)
      useIvFilter: false,
      maxIv: 0.30,

      // Direction
      allowLong: true,
      allowShort: false          // Short signals disabled by default
    };

    // Merge with provided parameters
    this.params = { ...this.defaultParams, ...params };
  }

  /**
   * Evaluate if a contrarian bounce signal should be generated
   *
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Contains gexLevels, ltLevels, ivData
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Validate inputs
    if (!isValidCandle(candle)) {
      return null;
    }

    // Check cooldown
    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) {
      return null;
    }

    // Extract market data
    const { gexLevels, ltLevels, ivData } = marketData || {};
    if (!gexLevels) {
      return null;
    }

    // Get gamma flip level
    const gammaFlip = gexLevels.gamma_flip || gexLevels.nq_gamma_flip;
    if (!gammaFlip) {
      return null;
    }

    const price = candle.close;

    // === CHECK LONG SIGNAL CONDITIONS ===
    if (this.params.allowLong) {
      const longSignal = this.checkLongConditions(candle, prevCandle, price, gammaFlip, gexLevels, ltLevels, ivData);
      if (longSignal) {
        this.updateLastSignalTime(candle.timestamp);
        return longSignal;
      }
    }

    // === CHECK SHORT SIGNAL CONDITIONS ===
    if (this.params.allowShort) {
      const shortSignal = this.checkShortConditions(candle, prevCandle, price, gammaFlip, gexLevels, ltLevels, ivData);
      if (shortSignal) {
        this.updateLastSignalTime(candle.timestamp);
        return shortSignal;
      }
    }

    return null;
  }

  /**
   * Check conditions for a long (buy) signal
   */
  checkLongConditions(candle, prevCandle, price, gammaFlip, gexLevels, ltLevels, ivData) {
    // Core condition: Price must be below gamma flip
    if (price >= gammaFlip) {
      return null;
    }

    const distanceBelowFlip = gammaFlip - price;

    // === APPLY FILTERS ===

    // GEX regime filter
    if (this.params.requirePositiveGex) {
      const regime = gexLevels.regime || 'unknown';
      if (regime !== 'positive' && regime !== 'strong_positive') {
        return null;
      }
    }

    // Time-of-day filter
    if (this.params.useTimeFilter) {
      if (!isWithinTimeWindow(candle.timestamp,
          this.params.timeFilterStartHour,
          this.params.timeFilterEndHour)) {
        return null;
      }
    }

    // Liquidity sentiment filter
    if (this.params.useSentimentFilter && ltLevels) {
      const sentiment = ltLevels.sentiment || 'UNKNOWN';
      if (sentiment !== this.params.requiredSentiment) {
        return null;
      }
    }

    // Distance filter
    if (this.params.useDistanceFilter) {
      if (distanceBelowFlip < this.params.minDistanceBelowFlip ||
          distanceBelowFlip > this.params.maxDistanceBelowFlip) {
        return null;
      }
    }

    // IV filter (requires ivData)
    if (this.params.useIvFilter && ivData) {
      if (ivData.iv > this.params.maxIv) {
        return null;
      }
    }

    // === CALCULATE STOP LOSS ===
    let stopPrice;
    if (this.params.useGexLevelStops && gexLevels.put_wall) {
      // Use put wall as stop with small buffer
      stopPrice = gexLevels.put_wall - 5;
    } else if (gexLevels.support && gexLevels.support[0]) {
      // Use first support level
      stopPrice = gexLevels.support[0] - 5;
    } else {
      // Fixed stop below entry
      stopPrice = price - this.params.stopBuffer;
    }

    // Check risk
    const risk = price - stopPrice;
    if (risk > this.params.maxRisk || risk <= 0) {
      return null;
    }

    // === CALCULATE TARGET ===
    let takeProfit = null;
    switch (this.params.targetMode) {
      case 'gamma_flip':
        takeProfit = gammaFlip;
        break;
      case 'call_wall':
        takeProfit = gexLevels.call_wall || gammaFlip + 30;
        break;
      case 'fixed':
        takeProfit = price + this.params.fixedTargetPoints;
        break;
      case 'trailing':
        takeProfit = null; // Will use trailing stop
        break;
      default:
        takeProfit = gammaFlip;
    }

    // === GENERATE SIGNAL ===
    return this.generateSignal('buy', candle, price, stopPrice, takeProfit, gammaFlip, gexLevels, ltLevels, {
      distanceBelowFlip,
      entryReason: `Price ${roundTo(distanceBelowFlip)} pts below gamma flip - mean reversion long`
    });
  }

  /**
   * Check conditions for a short (sell) signal
   * Inverse of long - price above gamma flip in negative GEX regime
   */
  checkShortConditions(candle, prevCandle, price, gammaFlip, gexLevels, ltLevels, ivData) {
    // Core condition: Price must be above gamma flip
    if (price <= gammaFlip) {
      return null;
    }

    const distanceAboveFlip = price - gammaFlip;

    // For shorts, we want negative GEX regime (higher volatility expected)
    if (this.params.requirePositiveGex) {
      // In this case, require NEGATIVE gex for shorts
      const regime = gexLevels.regime || 'unknown';
      if (regime !== 'negative' && regime !== 'strong_negative') {
        return null;
      }
    }

    // Time-of-day filter
    if (this.params.useTimeFilter) {
      if (!isWithinTimeWindow(candle.timestamp,
          this.params.timeFilterStartHour,
          this.params.timeFilterEndHour)) {
        return null;
      }
    }

    // Liquidity sentiment filter (require bearish for shorts)
    if (this.params.useSentimentFilter && ltLevels) {
      const sentiment = ltLevels.sentiment || 'UNKNOWN';
      if (sentiment !== 'BEARISH') {
        return null;
      }
    }

    // Distance filter
    if (this.params.useDistanceFilter) {
      if (distanceAboveFlip < this.params.minDistanceBelowFlip ||
          distanceAboveFlip > this.params.maxDistanceBelowFlip) {
        return null;
      }
    }

    // === CALCULATE STOP LOSS (above entry for shorts) ===
    let stopPrice;
    if (this.params.useGexLevelStops && gexLevels.call_wall) {
      stopPrice = gexLevels.call_wall + 5;
    } else if (gexLevels.resistance && gexLevels.resistance[0]) {
      stopPrice = gexLevels.resistance[0] + 5;
    } else {
      stopPrice = price + this.params.stopBuffer;
    }

    // Check risk
    const risk = stopPrice - price;
    if (risk > this.params.maxRisk || risk <= 0) {
      return null;
    }

    // === CALCULATE TARGET (below entry for shorts) ===
    let takeProfit = null;
    switch (this.params.targetMode) {
      case 'gamma_flip':
        takeProfit = gammaFlip;
        break;
      case 'call_wall': // For shorts, use put wall
        takeProfit = gexLevels.put_wall || gammaFlip - 30;
        break;
      case 'fixed':
        takeProfit = price - this.params.fixedTargetPoints;
        break;
      case 'trailing':
        takeProfit = null;
        break;
      default:
        takeProfit = gammaFlip;
    }

    // === GENERATE SIGNAL ===
    return this.generateSignal('sell', candle, price, stopPrice, takeProfit, gammaFlip, gexLevels, ltLevels, {
      distanceAboveFlip,
      entryReason: `Price ${roundTo(distanceAboveFlip)} pts above gamma flip - mean reversion short`
    });
  }

  /**
   * Generate the signal object
   */
  generateSignal(side, candle, entryPrice, stopPrice, takeProfit, gammaFlip, gexLevels, ltLevels, context = {}) {
    const signal = {
      // Core signal data
      strategy: 'CONTRARIAN_BOUNCE',
      side: side,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      entryPrice: roundToNQTick(entryPrice),
      stopLoss: roundToNQTick(stopPrice),
      takeProfit: takeProfit ? roundToNQTick(takeProfit) : null,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      // Strategy-specific metadata
      metadata: {
        // Entry context
        gamma_flip: roundTo(gammaFlip),
        distance_from_flip: roundTo(Math.abs(entryPrice - gammaFlip)),
        entry_reason: context.entryReason,
        candle_time: new Date(candle.timestamp).toISOString(),

        // GEX context
        gex_regime: gexLevels?.regime || 'unknown',
        gex_call_wall: gexLevels?.call_wall ? roundTo(gexLevels.call_wall) : null,
        gex_put_wall: gexLevels?.put_wall ? roundTo(gexLevels.put_wall) : null,
        gex_total: gexLevels?.total_gex ? Math.round(gexLevels.total_gex / 1e9) : null,

        // Liquidity context (if available)
        lt_sentiment: ltLevels?.sentiment || 'UNKNOWN',
        lt_levels: ltLevels ? [
          ltLevels.L0, ltLevels.L1, ltLevels.L2, ltLevels.L3, ltLevels.L4
        ].filter(l => l != null).map(l => roundTo(l)) : [],

        // Risk/reward
        risk_points: roundTo(Math.abs(entryPrice - stopPrice)),
        reward_points: takeProfit ? roundTo(Math.abs(takeProfit - entryPrice)) : null,

        // Filter status (useful for analysis)
        filters_applied: this.getActiveFilters()
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
   * Get list of currently active filters (for logging/analysis)
   */
  getActiveFilters() {
    const filters = [];
    if (this.params.requirePositiveGex) filters.push('positive_gex');
    if (this.params.useTimeFilter) filters.push('time_of_day');
    if (this.params.useSentimentFilter) filters.push('sentiment');
    if (this.params.useDistanceFilter) filters.push('distance');
    if (this.params.useIvFilter) filters.push('iv');
    return filters.length > 0 ? filters : ['none'];
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'CONTRARIAN_BOUNCE';
  }

  /**
   * Get strategy description
   */
  getDescription() {
    return 'Contrarian Bounce - Mean reversion strategy that enters long when price is below gamma flip level';
  }

  /**
   * Get required market data fields
   */
  getRequiredMarketData() {
    const required = ['gexLevels'];
    if (this.params.useSentimentFilter) {
      required.push('ltLevels');
    }
    if (this.params.useIvFilter) {
      required.push('ivData');
    }
    return required;
  }

  /**
   * Get current parameters (useful for logging)
   */
  getParams() {
    return { ...this.params };
  }

  /**
   * Update parameters dynamically
   */
  updateParams(newParams) {
    this.params = { ...this.params, ...newParams };
  }
}

export default ContrarianBounceStrategy;
