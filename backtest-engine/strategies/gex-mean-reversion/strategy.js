/**
 * GEX Mean Reversion Strategy
 *
 * Exploits the empirically-validated 57.1% win rate for support bounces
 * in NEGATIVE GEX regimes. Based on research findings from Phase 1.
 *
 * Entry: Long when price touches GEX Support 1 in negative GEX regime
 * Exit: Fixed 60pt target or 20pt stop (1:3 R:R)
 * Filter: RTH only, IV < 80th percentile
 */

import { BaseStrategy } from '../../../shared/strategies/base-strategy.js';

export class GexMeanReversionStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Strategy identification
    this.name = 'GEX_MEAN_REVERSION';
    this.version = '1.0.0';

    // GEX level proximity
    this.params.levelProximity = params.levelProximity ?? 15;

    // Risk management - 1:3 R:R
    this.params.stopLossPoints = params.stopLossPoints ?? 20;
    this.params.takeProfitPoints = params.takeProfitPoints ?? 60;
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // Validate risk parameters
    this._validateRiskParams();

    // Signal management
    this.params.signalCooldownMs = params.signalCooldownMs ?? 1800000; // 30 minutes

    // Filters
    this.params.maxIVPercentile = params.maxIVPercentile ?? 80;
    this.params.requireNegativeGEX = params.requireNegativeGEX ?? true;
    this.params.useSessionFilter = params.useSessionFilter ?? true;
    this.params.allowedSessions = params.allowedSessions ?? ['rth'];

    // Entry cutoff (3:30 PM EST)
    this.params.entryCutoffHour = params.entryCutoffHour ?? 15;
    this.params.entryCutoffMinute = params.entryCutoffMinute ?? 30;

    // Trailing stop (optional)
    this.params.useTrailingStop = params.useTrailingStop ?? false;
    this.params.trailingTrigger = params.trailingTrigger ?? 30;
    this.params.trailingOffset = params.trailingOffset ?? 10;

    // Trading symbol
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug mode
    this.params.debug = params.debug ?? false;

    // IV data storage
    this.ivLoader = null;
  }

  /**
   * Validate risk parameters meet requirements
   * - Stop must be <= 30 points
   * - Target must be >= 3x stop
   */
  _validateRiskParams() {
    const stop = this.params.stopLossPoints;
    const target = this.params.takeProfitPoints;

    if (stop > 30) {
      throw new Error(`Stop loss (${stop}pt) exceeds 30pt maximum`);
    }

    if (target / stop < 3) {
      throw new Error(`R:R (${(target / stop).toFixed(1)}) is below 3.0 minimum`);
    }
  }

  /**
   * Validate a specific trade's risk/reward
   * @param {number} entry - Entry price
   * @param {number} stop - Stop price
   * @param {number} target - Target price
   * @returns {Object} Validation result
   */
  validateRiskReward(entry, stop, target) {
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);

    if (risk > 30) {
      return { valid: false, reason: 'Risk exceeds 30pt max' };
    }

    if (reward / risk < 3) {
      return { valid: false, reason: `R:R (${(reward / risk).toFixed(1)}) below 1:3` };
    }

    return { valid: true, riskReward: reward / risk };
  }

  /**
   * Load IV data for the strategy (backtesting)
   * @param {Object} ivLoader - IVLoader instance
   */
  loadIVData(ivLoader) {
    this.ivLoader = ivLoader;
    if (this.params.debug) {
      const stats = ivLoader.getStats();
      console.log(`[GEX-MR] IV data loaded: ${stats.count} records`);
    }
  }

  /**
   * Get IV percentile at a specific time
   * @param {number} timestamp - Timestamp in ms
   * @returns {number|null} IV percentile (0-100) or null
   */
  getIVPercentileAtTime(timestamp) {
    if (!this.ivLoader) return null;

    const iv = this.ivLoader.getIVAtTime(timestamp);
    if (!iv) return null;

    // ivLoader should provide percentile, or we calculate from raw IV
    return iv.ivPercentile ?? null;
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
   * Check if current time is past entry cutoff
   * @param {number} timestamp - Timestamp in ms
   * @returns {boolean} True if past cutoff
   */
  isPastEntryCutoff(timestamp) {
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

    const cutoffHour = this.params.entryCutoffHour;
    const cutoffMin = this.params.entryCutoffMinute;

    return hour > cutoffHour || (hour === cutoffHour && min >= cutoffMin);
  }

  /**
   * Check if GEX regime is negative
   * @param {Object} gexLevels - GEX levels object
   * @returns {boolean} True if negative GEX regime
   */
  isNegativeGEXRegime(gexLevels) {
    if (!gexLevels) return false;

    // Check total_gex value
    if (gexLevels.total_gex !== undefined) {
      return gexLevels.total_gex < 0;
    }

    // Check regime string
    if (gexLevels.regime) {
      const regimeLower = gexLevels.regime.toLowerCase();
      return regimeLower.includes('negative') || regimeLower.includes('neg');
    }

    // Check isNegativeGEX flag
    if (gexLevels.isNegativeGEX !== undefined) {
      return gexLevels.isNegativeGEX;
    }

    return false;
  }

  /**
   * Find nearest GEX support level within proximity threshold
   * @param {number} price - Current price
   * @param {Object} gexLevels - GEX levels object
   * @returns {Object|null} Nearest support level info or null
   */
  findNearestSupport(price, gexLevels) {
    if (!gexLevels) return null;

    const supports = [];

    // Add support levels from array
    if (gexLevels.support && Array.isArray(gexLevels.support)) {
      gexLevels.support.forEach((level, idx) => {
        if (level && !isNaN(level)) {
          supports.push({
            type: `S${idx + 1}`,
            level: level,
            priority: 90 - idx * 5
          });
        }
      });
    }

    // Add put wall
    if (gexLevels.put_wall || gexLevels.putWall) {
      const putWall = gexLevels.put_wall || gexLevels.putWall;
      if (putWall && !isNaN(putWall)) {
        supports.push({ type: 'PutWall', level: putWall, priority: 95 });
      }
    }

    // Add gamma flip (if below price, acts as support)
    const gammaFlip = gexLevels.gamma_flip || gexLevels.gammaFlip || gexLevels.nq_gamma_flip;
    if (gammaFlip && !isNaN(gammaFlip) && gammaFlip < price) {
      supports.push({ type: 'GammaFlip', level: gammaFlip, priority: 100 });
    }

    // Find nearest within proximity
    let nearest = null;
    let nearestDist = Infinity;

    for (const sup of supports) {
      const dist = Math.abs(price - sup.level);
      if (dist <= this.params.levelProximity && dist < nearestDist) {
        nearestDist = dist;
        nearest = { ...sup, distance: dist };
      }
    }

    return nearest;
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
    if (!this.isInAllowedSession(timestamp)) {
      return null;
    }

    // Check entry cutoff
    if (this.isPastEntryCutoff(timestamp)) {
      if (this.params.debug) {
        console.log(`[GEX-MR] Past entry cutoff at ${new Date(timestamp).toISOString()}`);
      }
      return null;
    }

    // Get GEX levels
    const gexLevels = marketData?.gexLevels;
    if (!gexLevels) {
      if (this.params.debug) {
        console.log(`[GEX-MR] No GEX levels at ${new Date(timestamp).toISOString()}`);
      }
      return null;
    }

    // Check negative GEX regime requirement
    if (this.params.requireNegativeGEX && !this.isNegativeGEXRegime(gexLevels)) {
      if (this.params.debug) {
        console.log(`[GEX-MR] Not in negative GEX regime at ${new Date(timestamp).toISOString()}`);
      }
      return null;
    }

    // Check IV filter (if data available)
    const ivPercentile = this.getIVPercentileAtTime(timestamp);
    if (ivPercentile !== null && ivPercentile > this.params.maxIVPercentile) {
      if (this.params.debug) {
        console.log(`[GEX-MR] IV percentile (${ivPercentile}) exceeds max (${this.params.maxIVPercentile})`);
      }
      return null;
    }

    const price = candle.close;

    // Find nearest support level
    const support = this.findNearestSupport(price, gexLevels);
    if (!support) {
      return null;
    }

    // Check that price is closing above support (bounce, not breakdown)
    if (price < support.level) {
      if (this.params.debug) {
        console.log(`[GEX-MR] Price (${price}) below support (${support.level}) - breakdown, not bounce`);
      }
      return null;
    }

    // Generate LONG signal
    return this.createSignal('long', candle, support, gexLevels, ivPercentile);
  }

  /**
   * Create a signal object
   * @param {string} side - 'long' or 'short'
   * @param {Object} candle - Current candle
   * @param {Object} level - GEX level info
   * @param {Object} gexLevels - Full GEX levels for metadata
   * @param {number|null} ivPercentile - IV percentile
   * @returns {Object} Signal object
   */
  createSignal(side, candle, level, gexLevels, ivPercentile) {
    const timestamp = this.toMs(candle.timestamp);
    this.updateLastSignalTime(timestamp);

    const entryPrice = candle.close;
    const stopLoss = side === 'long'
      ? entryPrice - this.params.stopLossPoints
      : entryPrice + this.params.stopLossPoints;
    const takeProfit = side === 'long'
      ? entryPrice + this.params.takeProfitPoints
      : entryPrice - this.params.takeProfitPoints;

    // Validate R:R
    const validation = this.validateRiskReward(entryPrice, stopLoss, takeProfit);
    if (!validation.valid) {
      if (this.params.debug) {
        console.log(`[GEX-MR] Signal rejected: ${validation.reason}`);
      }
      return null;
    }

    if (this.params.debug) {
      console.log(`[GEX-MR] Signal: ${side.toUpperCase()} at ${entryPrice.toFixed(2)}`);
      console.log(`  Level: ${level.type} @ ${level.level.toFixed(2)} (dist: ${level.distance.toFixed(1)})`);
      console.log(`  GEX Regime: ${gexLevels.regime || 'negative'}`);
      console.log(`  IV Percentile: ${ivPercentile ?? 'N/A'}`);
      console.log(`  R:R: 1:${validation.riskReward.toFixed(1)}`);
    }

    const signal = {
      timestamp,
      side,
      price: entryPrice,
      strategy: this.name,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,

      // Signal metadata
      levelType: level.type,
      levelPrice: level.level,
      levelDistance: level.distance,
      gexRegime: gexLevels.regime || (gexLevels.total_gex < 0 ? 'negative' : 'positive'),
      totalGex: gexLevels.total_gex,
      ivPercentile: ivPercentile,
      riskReward: validation.riskReward,

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
   * Reset strategy state
   */
  reset() {
    super.reset();
  }

  /**
   * Get strategy name
   * @returns {string} Strategy name
   */
  getName() {
    return this.name;
  }

  /**
   * Get strategy configuration for display
   * @returns {Object} Configuration summary
   */
  getConfig() {
    return {
      name: this.name,
      version: this.version,
      stopLoss: this.params.stopLossPoints,
      takeProfit: this.params.takeProfitPoints,
      riskReward: this.params.takeProfitPoints / this.params.stopLossPoints,
      levelProximity: this.params.levelProximity,
      requireNegativeGEX: this.params.requireNegativeGEX,
      maxIVPercentile: this.params.maxIVPercentile,
      sessions: this.params.allowedSessions,
      useTrailingStop: this.params.useTrailingStop
    };
  }
}

export default GexMeanReversionStrategy;
