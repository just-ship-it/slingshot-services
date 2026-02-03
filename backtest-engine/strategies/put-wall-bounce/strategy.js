/**
 * Put Wall Bounce Strategy
 *
 * Discovered through analysis of GEX level bounce patterns.
 * Enters long when price touches Put Wall from above during negative GEX regime.
 *
 * Key findings from analysis:
 * - Put Wall support test: 78.6% win rate at 30m, +44.79 pts avg
 * - Best performance in strong_negative regime
 * - Premarket session enhances results
 */

import { BaseStrategy } from '../../../shared/strategies/base-strategy.js';

export class PutWallBounceStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Entry parameters
    this.params.levelProximity = params.levelProximity ?? 15;  // Points from Put Wall
    this.params.touchThreshold = params.touchThreshold ?? 10;   // Max distance to consider "touch"

    // Risk management
    this.params.stopLossPoints = params.stopLossPoints ?? 10;
    this.params.takeProfitPoints = params.takeProfitPoints ?? 30;
    this.params.maxRisk = params.maxRisk ?? 15;  // Max acceptable risk
    this.params.maxHoldBars = params.maxHoldBars ?? 60;  // 60 min max hold

    // Trailing stop
    this.params.useTrailingStop = params.useTrailingStop ?? true;
    this.params.trailingTrigger = params.trailingTrigger ?? 15;  // Points in profit before trailing
    this.params.trailingOffset = params.trailingOffset ?? 8;     // Trail 8 pts behind

    // Signal management
    this.params.signalCooldownMs = params.signalCooldownMs ?? 900000; // 15 min cooldown

    // Session filter
    this.params.useSessionFilter = params.useSessionFilter ?? false;
    this.params.allowedSessions = params.allowedSessions ?? ['premarket', 'overnight'];

    // Regime filter
    this.params.useRegimeFilter = params.useRegimeFilter ?? false;
    this.params.allowedRegimes = params.allowedRegimes ?? ['negative', 'strong_negative'];

    // Trading symbol
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug mode
    this.params.debug = params.debug ?? false;

    // State tracking
    this.lastPutWallTouch = 0;
    this.watchingForBounce = false;
  }

  /**
   * Get session from timestamp
   * @param {number} timestamp - Timestamp in ms
   * @returns {string} Session name
   */
  getSession(timestamp) {
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

    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
    if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
    return 'afterhours';
  }

  /**
   * Check if current session is allowed
   * @param {number} timestamp - Timestamp in ms
   * @returns {boolean} True if allowed
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    const session = this.getSession(timestamp);
    return this.params.allowedSessions.includes(session);
  }

  /**
   * Check if current regime is allowed
   * @param {string} regime - GEX regime
   * @returns {boolean} True if allowed
   */
  isAllowedRegime(regime) {
    if (!this.params.useRegimeFilter) return true;
    if (!regime) return true;  // Allow if no regime data
    return this.params.allowedRegimes.includes(regime);
  }

  /**
   * Get Put Wall level from GEX data
   * @param {Object} gexLevels - GEX levels object
   * @returns {number|null} Put Wall price or null
   */
  getPutWall(gexLevels) {
    if (!gexLevels) return null;

    // Check different possible field names
    if (gexLevels.putWall) return gexLevels.putWall;
    if (gexLevels.put_wall) return gexLevels.put_wall;

    // For daily GEX data format
    if (gexLevels.nq_put_wall_1) return parseFloat(gexLevels.nq_put_wall_1);

    return null;
  }

  /**
   * Check if price is touching Put Wall from above
   * @param {Object} candle - Current candle
   * @param {number} putWall - Put Wall level
   * @returns {boolean} True if valid touch from above
   */
  isTouchFromAbove(candle, putWall) {
    const threshold = this.params.touchThreshold;

    // Low touched or penetrated the Put Wall level
    const lowTouched = candle.low <= putWall + threshold;

    // But price recovered (close is above Put Wall)
    const priceRecovered = candle.close > putWall;

    return lowTouched && priceRecovered;
  }

  /**
   * Calculate stop loss and take profit levels
   * @param {number} entryPrice - Entry price
   * @param {Object} candle - Entry candle
   * @param {number} putWall - Put Wall level
   * @returns {Object} { stopLoss, takeProfit }
   */
  calculateLevels(entryPrice, candle, putWall) {
    // Stop below Put Wall or below candle low, whichever is lower
    const stopBelowPutWall = putWall - this.params.stopLossPoints;
    const stopBelowCandleLow = candle.low - 2;  // 2 pt buffer
    const stopLoss = Math.min(stopBelowPutWall, stopBelowCandleLow);

    // Take profit
    const takeProfit = entryPrice + this.params.takeProfitPoints;

    return { stopLoss, takeProfit };
  }

  /**
   * Evaluate trading signal
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Market data including gexLevels
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);

    // Check cooldown
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Check session filter
    if (!this.isAllowedSession(timestamp)) {
      return null;
    }

    // Get GEX levels
    const gexLevels = marketData?.gexLevels;
    if (!gexLevels) {
      if (this.params.debug) console.log(`[PUT-WALL] No GEX levels at ${new Date(timestamp).toISOString()}`);
      return null;
    }

    // Check regime filter
    const regime = gexLevels.regime;
    if (!this.isAllowedRegime(regime)) {
      if (this.params.debug) console.log(`[PUT-WALL] Regime ${regime} not allowed`);
      return null;
    }

    // Get Put Wall level
    const putWall = this.getPutWall(gexLevels);
    if (!putWall) {
      if (this.params.debug) console.log(`[PUT-WALL] No Put Wall data`);
      return null;
    }

    // Check if price is within proximity of Put Wall
    const distanceToLevel = candle.close - putWall;
    if (distanceToLevel < 0 || distanceToLevel > this.params.levelProximity) {
      return null;  // Too far from Put Wall or below it
    }

    // Check for valid touch from above
    if (!this.isTouchFromAbove(candle, putWall)) {
      return null;
    }

    // Calculate entry, stop, and target
    const entryPrice = candle.close;
    const { stopLoss, takeProfit } = this.calculateLevels(entryPrice, candle, putWall);

    // Check risk is acceptable
    const risk = entryPrice - stopLoss;
    if (risk > this.params.maxRisk) {
      if (this.params.debug) console.log(`[PUT-WALL] Risk ${risk.toFixed(1)} pts exceeds max ${this.params.maxRisk}`);
      return null;
    }

    // Valid signal - update cooldown
    this.updateLastSignalTime(timestamp);

    if (this.params.debug) {
      console.log(`[PUT-WALL] Signal: LONG at ${entryPrice.toFixed(2)}`);
      console.log(`  Put Wall: ${putWall.toFixed(2)}, Distance: ${distanceToLevel.toFixed(1)} pts`);
      console.log(`  Stop: ${stopLoss.toFixed(2)}, Target: ${takeProfit.toFixed(2)}`);
      console.log(`  Risk: ${risk.toFixed(1)} pts, Regime: ${regime}`);
    }

    const signal = {
      timestamp,
      side: 'long',
      price: entryPrice,
      strategy: 'PUT_WALL_BOUNCE',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,

      // Signal metadata
      levelType: 'PutWall',
      levelPrice: putWall,
      levelDistance: distanceToLevel,
      regime: regime,
      risk: risk,

      // For bracket orders (snake_case for trade orchestrator)
      stop_loss: stopLoss,
      take_profit: takeProfit
    };

    // Add trailing stop config if enabled
    if (this.params.useTrailingStop) {
      signal.trailing_trigger = this.params.trailingTrigger;
      signal.trailing_offset = this.params.trailingOffset;
    }

    return signal;
  }

  /**
   * Get strategy name
   * @returns {string} Strategy name
   */
  getName() {
    return 'PUT_WALL_BOUNCE';
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.lastPutWallTouch = 0;
    this.watchingForBounce = false;
  }
}

export default PutWallBounceStrategy;
