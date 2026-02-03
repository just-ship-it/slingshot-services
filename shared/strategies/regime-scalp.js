/**
 * Regime Scalp Strategy
 *
 * A longs-only aggressive scalping strategy that uses the RegimeIdentifier to detect
 * favorable market conditions and enter with limit orders at key support levels.
 *
 * Core Logic:
 * - BOUNCING_SUPPORT: Enter long when price is within levelProximity of GEX support (S1, S2, PutWall)
 * - WEAK_TRENDING_UP: Enter long on pullback to recent swing low + buffer
 * - STRONG_TRENDING_UP: Enter long on pullback to recent swing low + buffer (more aggressive)
 *
 * Exit Management:
 * - Fixed stop loss (20 points NQ / 8 points ES)
 * - Trailing stop activates at 7 pts profit, trails 4 pts behind high water mark
 * - No fixed take profit - trailing stop manages all exits
 *
 * Re-entry Logic:
 * - After profitable exit: 30 second cooldown (fast re-entry if regime holds)
 * - After stop loss: 120 second cooldown (wait for conditions to stabilize)
 */

import { BaseStrategy } from './base-strategy.js';
import { RegimeIdentifier, REGIME_PRESETS } from '../indicators/regime-identifier.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

// Symbol-specific parameters
const SYMBOL_CONFIGS = {
  NQ: {
    stopLossPoints: 20,
    trailingTrigger: 7,
    trailingOffset: 4,
    swingBuffer: 3,
    levelProximity: 5,
    pointValue: 20
  },
  ES: {
    stopLossPoints: 8,
    trailingTrigger: 3,
    trailingOffset: 2,
    swingBuffer: 1.5,
    levelProximity: 2,
    pointValue: 50
  }
};

export class RegimeScalpStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Get symbol-specific config
    const symbol = params.symbol || 'NQ';
    const symbolConfig = SYMBOL_CONFIGS[symbol] || SYMBOL_CONFIGS.NQ;

    // Default parameters
    this.params = {
      // Symbol configuration
      symbol: symbol,
      tradingSymbol: params.tradingSymbol || symbol,
      defaultQuantity: params.defaultQuantity ?? 1,

      // Regime configuration
      // Using aggressive preset - more selective than ultraAggressive
      preset: params.preset || 'aggressive',
      allowedRegimes: params.allowedRegimes || [
        'BOUNCING_SUPPORT',  // Most reliable regime for support bounces
        // Removing trending and neutral to reduce low-quality signals
      ],
      // When true, NEUTRAL regime requires price to be within levelProximity of a support level
      requireSupportForNeutral: params.requireSupportForNeutral ?? true,

      // Entry parameters
      levelProximity: params.levelProximity ?? symbolConfig.levelProximity,
      swingBuffer: params.swingBuffer ?? symbolConfig.swingBuffer,
      useLimitOrders: params.useLimitOrders ?? true,

      // Stop loss (fixed)
      stopLossPoints: params.stopLossPoints ?? symbolConfig.stopLossPoints,

      // Trailing stop (no fixed take profit)
      useTrailingStop: params.useTrailingStop ?? true,
      trailingTrigger: params.trailingTrigger ?? symbolConfig.trailingTrigger,
      trailingOffset: params.trailingOffset ?? symbolConfig.trailingOffset,

      // Cooldown configuration - conservative for live trading
      signalCooldownMs: params.signalCooldownMs ?? 300000,  // 5 minutes after profit
      reducedCooldownMs: params.reducedCooldownMs ?? 600000, // 10 minutes after loss

      // Session filter
      useSessionFilter: params.useSessionFilter ?? true,
      allowedSessions: params.allowedSessions || ['rth'],

      // GEX level configuration
      tradeSupportLevels: params.tradeSupportLevels || ['S1', 'S2', 'PutWall'],

      // Swing lookback for trend entries
      swingLookback: params.swingLookback ?? 10,

      // Order timeout - cancel unfilled limit orders after N candles
      // Also invalidate on regime change if configured
      timeoutCandles: params.timeoutCandles ?? 5,  // 5 candles = 5 minutes on 1m chart
      invalidateOnRegimeChange: params.invalidateOnRegimeChange ?? true,

      // Daily trade limit to prevent overtrading
      maxTradesPerDay: params.maxTradesPerDay ?? 5,

      // Debug and live mode
      debug: params.debug ?? false,
      liveMode: params.liveMode ?? false,

      ...params
    };

    // Initialize RegimeIdentifier with preset configuration
    // When useSessionFilter is false, allow all sessions in RegimeIdentifier too
    const presetConfig = REGIME_PRESETS[this.params.preset] || REGIME_PRESETS.aggressive;
    const allowAllSessions = !this.params.useSessionFilter;
    this.regimeIdentifier = new RegimeIdentifier({
      symbol: this.params.symbol,
      ...presetConfig,
      allowRTH: allowAllSessions || this.params.allowedSessions.includes('rth'),
      allowOvernight: allowAllSessions || this.params.allowedSessions.includes('overnight'),
      allowPremarket: allowAllSessions || this.params.allowedSessions.includes('premarket'),
      allowAftermarket: allowAllSessions || this.params.allowedSessions.includes('afterhours')
    });

    // Candle history for regime identification
    this.candleHistory = [];
    this.maxHistorySize = 100;

    // Track last exit type for cooldown management
    this.lastExitProfitable = null;
    this.lastRegime = null;

    // Daily trade tracking
    this.currentTradingDay = null;
    this.tradesToday = 0;
  }

  /**
   * Update candle history for regime identification
   * @param {Object} candle - Current candle
   */
  updateCandleHistory(candle) {
    this.candleHistory.push(candle);
    if (this.candleHistory.length > this.maxHistorySize) {
      this.candleHistory.shift();
    }
  }

  /**
   * Check if current time is in allowed session
   * @param {number} timestamp - Timestamp in ms
   * @returns {boolean} True if in allowed session
   */
  isInAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;

    const date = new Date(timestamp);
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

    // Session definitions (EST)
    const sessions = {
      overnight: timeDecimal >= 18 || timeDecimal < 4,
      premarket: timeDecimal >= 4 && timeDecimal < 9.5,
      rth: timeDecimal >= 9.5 && timeDecimal < 16,
      afterhours: timeDecimal >= 16 && timeDecimal < 18
    };

    return this.params.allowedSessions.some(s => sessions[s]);
  }

  /**
   * Find nearest GEX support level within proximity threshold
   * @param {number} price - Current price
   * @param {Object} gexLevels - GEX levels object
   * @returns {Object|null} Nearest level info or null
   */
  findNearestSupportLevel(price, gexLevels) {
    if (!gexLevels) return null;

    const allLevels = [];

    // Add support levels (S1, S2, etc.)
    (gexLevels.support || []).forEach((level, i) => {
      const type = `S${i + 1}`;
      if (level && this.params.tradeSupportLevels.includes(type)) {
        allLevels.push({ type, level, category: 'support' });
      }
    });

    // Add PutWall if configured
    if (gexLevels.putWall && this.params.tradeSupportLevels.includes('PutWall')) {
      allLevels.push({ type: 'PutWall', level: gexLevels.putWall, category: 'support' });
    }

    // Add GammaFlip if configured
    if (gexLevels.gammaFlip && this.params.tradeSupportLevels.includes('GammaFlip')) {
      allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'support' });
    }

    // Find nearest within threshold
    let nearest = null;
    let nearestDist = Infinity;

    for (const lvl of allLevels) {
      const dist = Math.abs(price - lvl.level);
      if (dist < nearestDist && dist <= this.params.levelProximity) {
        nearestDist = dist;
        nearest = { ...lvl, distance: dist };
      }
    }

    return nearest;
  }

  /**
   * Find recent swing low for trend entry
   * @param {Array} candles - Historical candles
   * @returns {Object|null} Swing low info or null
   */
  findRecentSwingLow(candles) {
    if (!candles || candles.length < this.params.swingLookback + 2) {
      return null;
    }

    const lookbackCandles = candles.slice(-this.params.swingLookback);

    // Find the lowest low in the lookback period
    let lowestLow = Infinity;
    let lowestIndex = -1;

    for (let i = 0; i < lookbackCandles.length; i++) {
      if (lookbackCandles[i].low < lowestLow) {
        lowestLow = lookbackCandles[i].low;
        lowestIndex = i;
      }
    }

    // Verify it's a swing low (surrounded by higher lows)
    // Skip first and last candles in lookback
    if (lowestIndex <= 0 || lowestIndex >= lookbackCandles.length - 1) {
      return null;
    }

    // Check if it's a valid swing low
    const prevLow = lookbackCandles[lowestIndex - 1].low;
    const nextLow = lookbackCandles[lowestIndex + 1].low;

    if (lowestLow < prevLow && lowestLow < nextLow) {
      return {
        price: lowestLow,
        timestamp: lookbackCandles[lowestIndex].timestamp,
        index: lowestIndex
      };
    }

    return null;
  }

  /**
   * Evaluate if a regime scalp signal should be generated
   *
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Market data including gexLevels
   * @param {Object} options - Additional options including historicalCandles from backtest engine
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);
    const gexLevels = marketData?.gexLevels;

    // Use historical candles from backtest engine if available, otherwise use internal history
    let historicalCandles;
    if (options.historicalCandles && options.historicalCandles.length >= 30) {
      historicalCandles = options.historicalCandles;
    } else {
      // Update internal candle history for live trading or when no history provided
      this.updateCandleHistory(candle);
      historicalCandles = this.candleHistory;
    }

    // Validate candle
    if (!isValidCandle(candle)) {
      this.logEvaluationSummary(candle, null, gexLevels, null, 'invalid candle');
      return null;
    }

    // Determine current cooldown based on last exit type
    const currentCooldownMs = this.lastExitProfitable === false
      ? this.params.reducedCooldownMs
      : this.params.signalCooldownMs;

    // Check cooldown
    if (!this.checkCooldown(timestamp, currentCooldownMs)) {
      this.logEvaluationSummary(candle, null, gexLevels, null, 'cooldown active');
      return null;
    }

    // Check session filter
    if (!this.isInAllowedSession(timestamp)) {
      this.logEvaluationSummary(candle, null, gexLevels, null, 'outside session');
      return null;
    }

    // Check daily trade limit
    const tradingDay = new Date(timestamp).toDateString();
    if (tradingDay !== this.currentTradingDay) {
      this.currentTradingDay = tradingDay;
      this.tradesToday = 0;
    }
    if (this.params.maxTradesPerDay > 0 && this.tradesToday >= this.params.maxTradesPerDay) {
      this.logEvaluationSummary(candle, null, gexLevels, null, `daily limit reached (${this.tradesToday}/${this.params.maxTradesPerDay})`);
      return null;
    }

    // Need enough candle history for regime identification
    if (historicalCandles.length < 30) {
      this.logEvaluationSummary(candle, null, gexLevels, null, 'insufficient history');
      return null;
    }

    // Identify current regime
    const regimeResult = this.regimeIdentifier.identify(candle, historicalCandles);

    if (!regimeResult || regimeResult.regime === 'SESSION_BLOCKED') {
      this.logEvaluationSummary(candle, regimeResult, gexLevels, null, 'session blocked by regime');
      return null;
    }

    this.lastRegime = regimeResult.regime;

    // Check if regime is in allowed list
    if (!this.params.allowedRegimes.includes(regimeResult.regime)) {
      this.logEvaluationSummary(candle, regimeResult, gexLevels, null, `regime not allowed: ${regimeResult.regime}`);
      return null;
    }

    // Evaluate entry based on regime type
    let signal = null;

    switch (regimeResult.regime) {
      case 'BOUNCING_SUPPORT':
        signal = this.evaluateBouncingSupport(candle, gexLevels, regimeResult);
        break;

      case 'WEAK_TRENDING_UP':
      case 'STRONG_TRENDING_UP':
        signal = this.evaluateTrendingEntry(candle, gexLevels, regimeResult, historicalCandles);
        break;

      case 'NEUTRAL':
        // For NEUTRAL regime, only enter if near support (conservative approach)
        if (this.params.requireSupportForNeutral) {
          signal = this.evaluateNeutralEntry(candle, gexLevels, regimeResult);
        }
        break;

      default:
        this.logEvaluationSummary(candle, regimeResult, gexLevels, null, `unhandled regime: ${regimeResult.regime}`);
        return null;
    }

    if (signal) {
      this.updateLastSignalTime(timestamp);
      this.tradesToday++;  // Increment daily trade counter
      this.logEvaluationSummary(candle, regimeResult, gexLevels, signal, null);
    } else {
      this.logEvaluationSummary(candle, regimeResult, gexLevels, null, 'no entry conditions met');
    }

    return signal;
  }

  /**
   * Evaluate entry for BOUNCING_SUPPORT regime
   * @param {Object} candle - Current candle
   * @param {Object} gexLevels - GEX levels
   * @param {Object} regimeResult - Regime identification result
   * @returns {Object|null} Signal or null
   */
  evaluateBouncingSupport(candle, gexLevels, regimeResult) {
    if (!gexLevels) return null;

    const price = candle.close;

    // Find nearest support level within proximity
    const nearestLevel = this.findNearestSupportLevel(price, gexLevels);

    if (!nearestLevel) {
      if (this.params.debug) {
        console.log(`[REGIME_SCALP] BOUNCING_SUPPORT: No support within ${this.params.levelProximity} pts`);
      }
      return null;
    }

    // Create signal at support level (limit order)
    return this.createSignal('long', candle, nearestLevel.level, {
      entryType: 'support_bounce',
      levelType: nearestLevel.type,
      levelDistance: nearestLevel.distance,
      regime: regimeResult.regime,
      regimeConfidence: regimeResult.confidence
    });
  }

  /**
   * Evaluate entry for WEAK_TRENDING_UP or STRONG_TRENDING_UP regime
   * @param {Object} candle - Current candle
   * @param {Object} gexLevels - GEX levels
   * @param {Object} regimeResult - Regime identification result
   * @param {Array} historicalCandles - Historical candles for swing detection
   * @returns {Object|null} Signal or null
   */
  evaluateTrendingEntry(candle, gexLevels, regimeResult, historicalCandles) {
    const price = candle.close;

    // Find recent swing low using passed historical candles
    const swingLow = this.findRecentSwingLow(historicalCandles || this.candleHistory);

    if (!swingLow) {
      if (this.params.debug) {
        console.log(`[REGIME_SCALP] ${regimeResult.regime}: No swing low found`);
      }
      return null;
    }

    // Entry price is swing low + buffer
    const entryPrice = swingLow.price + this.params.swingBuffer;

    // Check if price is near the swing low entry level
    const distanceToEntry = price - entryPrice;

    // Only enter if price is within proximity of swing low
    // (pulling back to it, not already past it)
    if (distanceToEntry < 0 || distanceToEntry > this.params.levelProximity * 2) {
      if (this.params.debug) {
        console.log(`[REGIME_SCALP] ${regimeResult.regime}: Price not near swing low entry (dist: ${distanceToEntry.toFixed(1)})`);
      }
      return null;
    }

    // Create signal at swing low + buffer (limit order)
    return this.createSignal('long', candle, entryPrice, {
      entryType: 'trend_pullback',
      swingLowPrice: swingLow.price,
      swingBuffer: this.params.swingBuffer,
      regime: regimeResult.regime,
      regimeConfidence: regimeResult.confidence
    });
  }

  /**
   * Evaluate entry for NEUTRAL regime - only enter if near GEX support
   * @param {Object} candle - Current candle
   * @param {Object} gexLevels - GEX levels
   * @param {Object} regimeResult - Regime identification result
   * @returns {Object|null} Signal or null
   */
  evaluateNeutralEntry(candle, gexLevels, regimeResult) {
    if (!gexLevels) return null;

    const price = candle.close;

    // Find nearest support level within proximity
    const nearestLevel = this.findNearestSupportLevel(price, gexLevels);

    if (!nearestLevel) {
      if (this.params.debug) {
        console.log(`[REGIME_SCALP] NEUTRAL: No support within ${this.params.levelProximity} pts`);
      }
      return null;
    }

    // Create signal at support level (limit order)
    return this.createSignal('long', candle, nearestLevel.level, {
      entryType: 'neutral_support',
      levelType: nearestLevel.type,
      levelDistance: nearestLevel.distance,
      regime: regimeResult.regime,
      regimeConfidence: regimeResult.confidence
    });
  }

  /**
   * Create a signal object
   * @param {string} side - 'long' or 'short' (always 'long' for this strategy)
   * @param {Object} candle - Current candle
   * @param {number} entryPrice - Desired entry price (for limit order)
   * @param {Object} metadata - Signal metadata
   * @returns {Object} Signal object
   */
  createSignal(side, candle, entryPrice, metadata) {
    const timestamp = this.toMs(candle.timestamp);

    // Calculate stop loss (fixed distance from entry)
    const stopLoss = entryPrice - this.params.stopLossPoints;

    if (this.params.debug) {
      console.log(`[REGIME_SCALP] Signal: ${side.toUpperCase()} at ${entryPrice.toFixed(2)}`);
      console.log(`  Stop: ${stopLoss.toFixed(2)} (${this.params.stopLossPoints} pts)`);
      console.log(`  Trailing: trigger=${this.params.trailingTrigger}pts, offset=${this.params.trailingOffset}pts`);
      console.log(`  Regime: ${metadata.regime} (${(metadata.regimeConfidence * 100).toFixed(1)}%)`);
    }

    const signal = {
      // Core signal data
      timestamp,
      side: 'buy',  // Always long for this strategy
      price: roundTo(entryPrice),
      strategy: 'REGIME_SCALP',
      action: this.params.useLimitOrders ? 'place_limit' : 'place_market',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,

      // Exit parameters (camelCase for backtest engine)
      stopLoss: roundTo(stopLoss),
      // No fixed take profit - trailing stop manages exit

      // Trailing stop configuration (camelCase for backtest engine)
      trailingTrigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailingOffset: this.params.useTrailingStop ? this.params.trailingOffset : null,

      // Snake_case versions for trade orchestrator
      stop_loss: roundTo(stopLoss),
      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,

      // Order timeout - cancel unfilled limit orders after N candles
      // CRITICAL: Without this, limit orders stay pending forever and block all subsequent signals
      timeoutCandles: this.params.timeoutCandles,

      // Signal metadata
      entryType: metadata.entryType,
      levelType: metadata.levelType,
      levelDistance: metadata.levelDistance,
      swingLowPrice: metadata.swingLowPrice,
      swingBuffer: metadata.swingBuffer,
      regime: metadata.regime,
      regimeConfidence: metadata.regimeConfidence
    };

    return signal;
  }

  /**
   * Notify strategy of trade exit for cooldown management
   * @param {Object} trade - Completed trade object
   */
  onTradeExit(trade) {
    this.lastExitProfitable = trade.netPnL > 0;
  }

  /**
   * Check if a pending order should be invalidated due to changed conditions.
   * Called by backtest engine on each candle for unfilled orders.
   *
   * @param {Object} pendingSignal - The pending signal/order
   * @param {Object} candle - Current candle
   * @param {Array} historicalCandles - Historical candles for regime detection
   * @returns {Object|null} - { shouldCancel: true, reason: 'regime_changed' } or null
   */
  shouldInvalidatePendingOrder(pendingSignal, candle, historicalCandles) {
    if (!this.params.invalidateOnRegimeChange) {
      return null;
    }

    // Skip if no regime info on the signal
    if (!pendingSignal.regime) {
      return null;
    }

    // Need enough history for regime identification
    if (!historicalCandles || historicalCandles.length < 30) {
      return null;
    }

    // Identify current regime
    const currentRegime = this.regimeIdentifier.identify(candle, historicalCandles);

    if (!currentRegime || currentRegime.regime === 'SESSION_BLOCKED') {
      // Session blocked - invalidate the order
      return { shouldCancel: true, reason: 'session_blocked' };
    }

    // Check if regime has changed from when signal was generated
    if (currentRegime.regime !== pendingSignal.regime) {
      if (this.params.debug) {
        console.log(`[REGIME_SCALP] Regime changed: ${pendingSignal.regime} -> ${currentRegime.regime}, invalidating pending order`);
      }
      return { shouldCancel: true, reason: `regime_changed:${pendingSignal.regime}->${currentRegime.regime}` };
    }

    return null;
  }

  /**
   * Log evaluation summary for debugging/monitoring
   * @param {Object} candle - Current candle
   * @param {Object} regimeResult - Regime identification result
   * @param {Object} gexLevels - GEX levels
   * @param {Object} result - Signal result or null
   * @param {string} reason - Reason for no signal
   */
  logEvaluationSummary(candle, regimeResult, gexLevels, result, reason) {
    if (!this.params.liveMode && !this.params.debug) {
      return;
    }

    const timestamp = this.toMs(candle.timestamp);
    const date = new Date(timestamp);
    const timeStr = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const price = candle.close.toFixed(2);
    const regime = regimeResult?.regime || 'N/A';
    const confidence = regimeResult?.confidence ? `${(regimeResult.confidence * 100).toFixed(0)}%` : 'N/A';

    // Format nearest level info
    let levelStr = 'Level:N/A';
    if (gexLevels) {
      const nearestLevel = this.findNearestSupportLevel(candle.close, gexLevels);
      if (nearestLevel) {
        levelStr = `${nearestLevel.type}@${nearestLevel.distance.toFixed(1)}pts`;
      }
    }

    // Format result
    let resultStr;
    if (result) {
      resultStr = `LONG SIGNAL @ ${result.price.toFixed(2)}`;
    } else {
      resultStr = `No signal: ${reason}`;
    }

    console.log(`[REGIME_SCALP] ${timeStr} | ${price} | ${regime} (${confidence}) | ${levelStr} | ${resultStr}`);
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.candleHistory = [];
    this.lastExitProfitable = null;
    this.lastRegime = null;
    this.currentTradingDay = null;
    this.tradesToday = 0;
    this.regimeIdentifier.reset();
  }

  /**
   * Get strategy name
   * @returns {string} Strategy name
   */
  getName() {
    return 'REGIME_SCALP';
  }

  /**
   * Get strategy description
   * @returns {string} Strategy description
   */
  getDescription() {
    return 'Longs-only regime scalp strategy - enters at GEX support in bullish regimes with trailing stop exit';
  }

  /**
   * Get required market data fields
   * @returns {string[]} Required fields
   */
  getRequiredMarketData() {
    return ['gexLevels'];
  }
}

export default RegimeScalpStrategy;
