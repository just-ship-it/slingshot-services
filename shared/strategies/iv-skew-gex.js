/**
 * IV Skew GEX Strategy
 *
 * A bidirectional strategy based on academically-validated research:
 * - Kolm/Turiel/Westray 2023: Order flow imbalance shows 60-65% directional accuracy
 * - SqueezeMetrics: GEX outperforms VIX for variance prediction
 * - Muravyev et al: Options contribute ~25% of price discovery
 *
 * Core Logic (momentum/flow-following at GEX levels):
 * - LONG: Near GEX support + Negative IV skew (calls expensive = bullish flow)
 * - SHORT: Near GEX resistance + Positive IV skew (puts expensive = bearish flow)
 *
 * Skew = putIV - callIV:
 * - Negative skew = calls expensive = bullish positioning → long at support
 * - Positive skew = puts expensive = bearish hedging → short at resistance
 */

import { BaseStrategy } from './base-strategy.js';

export class IVSkewGexStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // IV Skew thresholds (skew = putIV - callIV)
    this.params.negSkewThreshold = params.negSkewThreshold ?? -0.01;  // For LONG (calls expensive = bullish flow)
    this.params.posSkewThreshold = params.posSkewThreshold ?? 0.01;   // For SHORT (puts expensive = bearish flow)

    // GEX level proximity
    this.params.levelProximity = params.levelProximity ?? 25;  // Points from level

    // Risk management
    this.params.stopLossPoints = params.stopLossPoints ?? 15;
    this.params.takeProfitPoints = params.takeProfitPoints ?? 30;
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // Signal management
    this.params.signalCooldownMs = params.signalCooldownMs ?? 1800000; // 30 minutes

    // Filters
    this.params.minIV = params.minIV ?? 0.18;  // Skip low IV environments
    this.params.avoidHours = params.avoidHours ?? [12]; // Skip noon for shorts (20% win rate)
    this.params.useSessionFilter = params.useSessionFilter ?? true;
    this.params.allowedSessions = params.allowedSessions ?? ['rth'];

    // Market close cutoff - no new entries after this time (EST)
    this.params.entryCutoffHour = params.entryCutoffHour ?? 15;  // 3 PM EST
    this.params.entryCutoffMinute = params.entryCutoffMinute ?? 30;  // 3:30 PM EST

    // Level types to trade
    this.params.tradeSupportLevels = params.tradeSupportLevels ?? ['S1', 'S2', 'S3', 'S4', 'S5', 'PutWall', 'GammaFlip'];
    this.params.tradeResistanceLevels = params.tradeResistanceLevels ?? ['R1', 'R2', 'R3', 'R4', 'R5', 'CallWall', 'GammaFlip'];

    // Trading symbol
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug mode
    this.params.debug = params.debug ?? false;

    // Live mode - enables verbose logging for real-time monitoring
    this.params.liveMode = params.liveMode ?? false;

    // Breakeven stop parameters
    this.params.breakevenStop = params.breakevenStop ?? false;
    this.params.breakevenTrigger = params.breakevenTrigger ?? 25;  // Move stop when 25 pts in profit
    this.params.breakevenOffset = params.breakevenOffset ?? -45;   // Move stop to entry - 45 (not true breakeven)

    // Zero Gamma / Gamma Flip early exit parameters
    // When GF moves against the trade direction for consecutive 15-min intervals
    this.params.gfEarlyExit = params.gfEarlyExit ?? false;
    this.params.gfBreakevenThreshold = params.gfBreakevenThreshold ?? 2;  // Move to breakeven after 2 adverse
    this.params.gfExitThreshold = params.gfExitThreshold ?? 3;            // Force exit after 3 adverse

    // IV data storage
    this.ivData = null;
    this.ivLoader = null;
    this.liveIVData = null;  // For live trading
  }

  /**
   * Load IV data for the strategy (backtesting)
   * @param {Object} ivLoader - IVLoader instance
   */
  loadIVData(ivLoader) {
    this.ivLoader = ivLoader;
    if (this.params.debug) {
      const stats = ivLoader.getStats();
      console.log(`IV data loaded: ${stats.count} records, ${stats.startDate} to ${stats.endDate}`);
    }
  }

  /**
   * Set live IV data for production trading
   * @param {Object} ivData - Current IV data from live calculator
   */
  setLiveIVData(ivData) {
    this.liveIVData = ivData;
  }

  /**
   * Get IV data at a specific time
   * For live trading, uses liveIVData; for backtesting, uses ivLoader
   * @param {number} timestamp - Timestamp in ms
   * @returns {Object|null} IV record
   */
  getIVAtTime(timestamp) {
    // Prefer live data for production trading
    if (this.liveIVData) {
      return this.liveIVData;
    }
    // Fall back to loader for backtesting
    if (this.ivLoader) {
      return this.ivLoader.getIVAtTime(timestamp);
    }
    return null;
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

    // Session definitions
    const sessions = {
      overnight: timeDecimal >= 18 || timeDecimal < 4,
      premarket: timeDecimal >= 4 && timeDecimal < 9.5,
      rth: timeDecimal >= 9.5 && timeDecimal < 16,
      afterhours: timeDecimal >= 16 && timeDecimal < 18
    };

    return this.params.allowedSessions.some(s => sessions[s]);
  }

  /**
   * Get hour in Eastern Time
   * @param {number} timestamp - Timestamp in ms
   * @returns {number} Hour (0-23)
   */
  getETHour(timestamp) {
    const date = new Date(timestamp);
    return parseInt(date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false
    }));
  }

  /**
   * Check if current time is past entry cutoff
   * @param {number} timestamp - Timestamp in ms
   * @returns {boolean} True if past cutoff (no new entries allowed)
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

    // Past cutoff if hour is greater, or same hour but minute is >= cutoff
    return hour > cutoffHour || (hour === cutoffHour && min >= cutoffMin);
  }

  /**
   * Find nearest GEX level within proximity threshold
   * @param {number} price - Current price
   * @param {Object} gexLevels - GEX levels object
   * @param {string} category - 'support' or 'resistance'
   * @returns {Object|null} Nearest level info or null
   */
  findNearestLevel(price, gexLevels, category) {
    if (!gexLevels) return null;

    const allLevels = [];
    const validLevelTypes = category === 'support'
      ? this.params.tradeSupportLevels
      : this.params.tradeResistanceLevels;

    // Add support levels
    if (category === 'support') {
      (gexLevels.support || []).forEach((level, i) => {
        const type = `S${i + 1}`;
        if (level && validLevelTypes.includes(type)) {
          allLevels.push({ type, level, category: 'support' });
        }
      });

      if (gexLevels.putWall && validLevelTypes.includes('PutWall')) {
        allLevels.push({ type: 'PutWall', level: gexLevels.putWall, category: 'support' });
      }

      if (gexLevels.gammaFlip && validLevelTypes.includes('GammaFlip')) {
        allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'support' });
      }
    }

    // Add resistance levels
    if (category === 'resistance') {
      (gexLevels.resistance || []).forEach((level, i) => {
        const type = `R${i + 1}`;
        if (level && validLevelTypes.includes(type)) {
          allLevels.push({ type, level, category: 'resistance' });
        }
      });

      if (gexLevels.callWall && validLevelTypes.includes('CallWall')) {
        allLevels.push({ type: 'CallWall', level: gexLevels.callWall, category: 'resistance' });
      }

      if (gexLevels.gammaFlip && validLevelTypes.includes('GammaFlip')) {
        allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'resistance' });
      }
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
   * Evaluate trading signal
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Market data including gexLevels
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);
    const gexLevels = marketData?.gexLevels;
    const iv = this.getIVAtTime(timestamp);

    // Check cooldown
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      this.logEvaluationSummary(candle, iv, gexLevels, null, 'cooldown active');
      return null;
    }

    // Check session filter
    if (!this.isInAllowedSession(timestamp)) {
      this.logEvaluationSummary(candle, iv, gexLevels, null, 'outside session');
      return null;
    }

    // Check entry cutoff (no new entries after 3:30 PM EST)
    if (this.isPastEntryCutoff(timestamp)) {
      if (this.params.debug) console.log(`[IV-SKEW] Past entry cutoff at ${new Date(timestamp).toISOString()}`);
      this.logEvaluationSummary(candle, iv, gexLevels, null, 'past entry cutoff');
      return null;
    }

    // Get GEX levels
    if (!gexLevels) {
      if (this.params.debug) console.log(`[IV-SKEW] No GEX levels at ${new Date(timestamp).toISOString()}`);
      this.logEvaluationSummary(candle, iv, gexLevels, null, 'no GEX levels');
      return null;
    }

    // Get IV data
    if (!iv) {
      if (this.params.debug) console.log(`[IV-SKEW] No IV data at ${new Date(timestamp).toISOString()}`);
      this.logEvaluationSummary(candle, iv, gexLevels, null, 'no IV data');
      return null;
    }

    // Skip low IV environments
    if (iv.iv < this.params.minIV) {
      if (this.params.debug) console.log(`[IV-SKEW] Low IV (${iv.iv.toFixed(3)}) at ${new Date(timestamp).toISOString()}`);
      this.logEvaluationSummary(candle, iv, gexLevels, null, `low IV (${(iv.iv * 100).toFixed(1)}%)`);
      return null;
    }

    const hour = this.getETHour(timestamp);
    const price = candle.close;

    // Check for LONG signal: Negative skew (calls expensive = bullish flow) + near support
    // When calls are expensive at support, bullish positioning supports a bounce
    if (iv.skew < this.params.negSkewThreshold) {
      const level = this.findNearestLevel(price, gexLevels, 'support');
      if (level) {
        const signal = this.createSignal('long', candle, level, iv);
        this.logEvaluationSummary(candle, iv, gexLevels, signal, null);
        return signal;
      }
    }

    // Check for SHORT signal: Positive skew (puts expensive = bearish flow) + near resistance
    // When puts are expensive at resistance, hedging pressure supports a pullback
    if (iv.skew > this.params.posSkewThreshold) {
      // Skip avoided hours for shorts
      if (this.params.avoidHours.includes(hour)) {
        if (this.params.debug) console.log(`[IV-SKEW] Avoiding hour ${hour} for SHORT`);
        this.logEvaluationSummary(candle, iv, gexLevels, null, `avoiding hour ${hour} for shorts`);
        return null;
      }

      const level = this.findNearestLevel(price, gexLevels, 'resistance');
      if (level) {
        const signal = this.createSignal('short', candle, level, iv);
        this.logEvaluationSummary(candle, iv, gexLevels, signal, null);
        return signal;
      }
    }

    // Determine reason for no signal
    let reason;
    const skewPct = (iv.skew * 100).toFixed(2);
    const negThreshPct = (this.params.negSkewThreshold * 100).toFixed(2);
    const posThreshPct = (this.params.posSkewThreshold * 100).toFixed(2);

    if (iv.skew >= this.params.negSkewThreshold && iv.skew <= this.params.posSkewThreshold) {
      reason = `skew neutral (${skewPct}%)`;
    } else if (iv.skew < this.params.negSkewThreshold) {
      reason = `neg skew but not near support (>${this.params.levelProximity}pts)`;
    } else {
      reason = `pos skew but not near resistance (>${this.params.levelProximity}pts)`;
    }

    this.logEvaluationSummary(candle, iv, gexLevels, null, reason);
    return null;
  }

  /**
   * Create a signal object
   * @param {string} side - 'long' or 'short'
   * @param {Object} candle - Current candle
   * @param {Object} level - GEX level info
   * @param {Object} iv - IV data
   * @returns {Object} Signal object
   */
  createSignal(side, candle, level, iv) {
    const timestamp = this.toMs(candle.timestamp);
    this.updateLastSignalTime(timestamp);

    const entryPrice = candle.close;
    const stopLoss = side === 'long'
      ? entryPrice - this.params.stopLossPoints
      : entryPrice + this.params.stopLossPoints;
    const takeProfit = side === 'long'
      ? entryPrice + this.params.takeProfitPoints
      : entryPrice - this.params.takeProfitPoints;

    if (this.params.debug) {
      console.log(`[IV-SKEW] Signal: ${side.toUpperCase()} at ${entryPrice.toFixed(2)}`);
      console.log(`  Level: ${level.type} @ ${level.level.toFixed(2)} (dist: ${level.distance.toFixed(1)})`);
      console.log(`  IV: ${iv.iv.toFixed(3)} | Skew: ${iv.skew.toFixed(4)}`);
    }

    const signal = {
      timestamp,
      side,
      price: entryPrice,
      strategy: 'IV_SKEW_GEX',
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
      levelCategory: level.category,
      ivValue: iv.iv,
      ivSkew: iv.skew,
      callIV: iv.callIV,
      putIV: iv.putIV,

      // For bracket orders (snake_case for trade orchestrator)
      stop_loss: stopLoss,
      take_profit: takeProfit
    };

    // Add breakeven config if enabled (snake_case for trade orchestrator)
    if (this.params.breakevenStop) {
      signal.breakeven_trigger = this.params.breakevenTrigger;
      signal.breakeven_offset = this.params.breakevenOffset;
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
    return 'IV_SKEW_GEX';
  }

  /**
   * Log a summary of the candle evaluation
   * Only logs when in liveMode or debug mode to avoid cluttering backtest output
   * @param {Object} candle - Current candle
   * @param {Object} iv - IV data (or null)
   * @param {Object} gexLevels - GEX levels (or null)
   * @param {Object} result - Signal result (or null)
   * @param {string} reason - Reason for no signal (if applicable)
   */
  logEvaluationSummary(candle, iv, gexLevels, result, reason) {
    // Only log in live mode or debug mode
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

    // Format IV info
    let ivStr = 'IV:N/A';
    if (iv) {
      const ivPct = (iv.iv * 100).toFixed(1);
      const skewPct = (iv.skew * 100).toFixed(2);
      ivStr = `IV:${ivPct}% Skew:${skewPct}%`;
    }

    // Find nearest level (support or resistance) for context
    let levelStr = 'Level:N/A';
    if (gexLevels) {
      const nearSupport = this.findNearestLevel(candle.close, gexLevels, 'support');
      const nearResist = this.findNearestLevel(candle.close, gexLevels, 'resistance');

      // Pick the closer one for display
      let nearest = null;
      if (nearSupport && nearResist) {
        nearest = nearSupport.distance <= nearResist.distance ? nearSupport : nearResist;
      } else {
        nearest = nearSupport || nearResist;
      }

      if (nearest) {
        levelStr = `${nearest.category === 'support' ? 'Support' : 'Resist'}:${nearest.type}@${nearest.distance.toFixed(1)}pts`;
      } else {
        // No level within threshold, find absolute nearest for context
        const allLevels = [];
        (gexLevels.support || []).forEach((l, i) => l && allLevels.push({ type: `S${i+1}`, level: l, cat: 'S' }));
        (gexLevels.resistance || []).forEach((l, i) => l && allLevels.push({ type: `R${i+1}`, level: l, cat: 'R' }));
        if (gexLevels.gammaFlip) allLevels.push({ type: 'GF', level: gexLevels.gammaFlip, cat: 'G' });

        let closestLevel = null;
        let closestDist = Infinity;
        for (const lvl of allLevels) {
          const dist = Math.abs(candle.close - lvl.level);
          if (dist < closestDist) {
            closestDist = dist;
            closestLevel = lvl;
          }
        }
        if (closestLevel) {
          levelStr = `Nearest:${closestLevel.type}@${closestDist.toFixed(1)}pts`;
        }
      }
    }

    // Format result
    let resultStr;
    if (result) {
      resultStr = `→ ${result.side.toUpperCase()} SIGNAL FIRED`;
    } else {
      resultStr = `→ No signal: ${reason}`;
    }

    console.log(`[IV-SKEW] ${timeStr} | ${price} | ${ivStr} | ${levelStr} | ${resultStr}`);
  }
}

export default IVSkewGexStrategy;
