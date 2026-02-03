/**
 * GEX Scalp Confirmed Strategy
 *
 * Combines GEX level-based entries with ICT-style candle pattern confirmation.
 * Instead of entering immediately when price touches a GEX level, this strategy
 * waits for confirmation patterns before triggering entry:
 *
 * 1. SWEEP + RECLAIM: Price sweeps beyond level then closes back inside zone
 * 2. HAMMER/SHOOTING STAR: Long wick rejection candle near the level
 * 3. ENGULFING: Current candle engulfs previous opposite-direction candle
 *
 * This approach reduces getting stopped out by a few points before major reversals.
 *
 * Flow:
 * 1. Price enters GEX zone (level ± zoneSize points)
 * 2. Start "watching" for confirmation patterns
 * 3. Wait up to N candles for pattern confirmation
 * 4. On confirmation: enter with dynamic stop based on confirmation candle
 * 5. On timeout: cancel watching, wait for next zone entry
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';
import { LTFConfirmation } from './ict-smc/ltf-confirmation.js';

export class GexScalpConfirmedStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Default strategy parameters
    this.defaultParams = {
      // Zone parameters (defines the area around GEX levels)
      zoneSize: 8.0,              // Points above/below level to define zone
      levelBuffer: 2.0,           // Price must get within this distance of level to trigger watching

      // Confirmation parameters
      confirmationTimeout: 15,    // Max candles to wait for confirmation
      minWickToBodyRatio: 1.5,    // For hammer/shooting star detection (lowered for 1m candles)
      stopBuffer: 2.0,            // Points beyond confirmation candle for stop
      minBodySize: 0.5,           // Minimum body size to avoid doji (lowered for 1m candles)

      // Exit parameters
      targetPoints: 7.0,          // Take profit target
      defaultStopPoints: 5.0,     // Default stop if confirmation stop is too tight
      maxStopPoints: 8.0,         // Maximum allowed stop distance (tightened from 15)
      minStopPoints: 3.0,         // Minimum stop distance
      useFixedStops: false,       // If true, always use fixed stops instead of dynamic
      maxHoldBars: 10,            // Max candles to hold (10 minutes on 1m chart)

      // Order parameters
      limitOrderTimeout: 3,       // Cancel unfilled limit orders after 3 candles

      // Trailing stop parameters
      useTrailingStop: true,
      trailingTrigger: 3.0,       // Activate trailing when 3 pts in profit
      trailingOffset: 1.0,        // Trail 1 pt behind high water mark

      // Signal management
      signalCooldownMs: 60000,    // 60 seconds between signals
      allowSimultaneous: false,   // One position at a time

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Filter parameters
      useLongEntries: true,       // Enable long entries at support
      useShortEntries: true,      // Enable short entries at resistance
      allowedRegimes: null,       // null = all regimes
      blockedHoursUTC: [],        // UTC hours to avoid

      // Level configuration
      tradeLevels: [1],           // Which levels to trade: [1] = S1/R1 only

      // Session filtering (all times in EST)
      useSessionFilter: true,
      allowedSessions: ['rth'],   // Which sessions to trade

      // Confirmation types to accept
      confirmationTypes: ['sweep_reclaim', 'hammer', 'shooting_star', 'engulfing'],
    };

    // Merge with provided parameters
    this.params = { ...this.defaultParams, ...params };

    // Handle CLI parameter name mapping (check original params before merge)
    if (params.stopLossPoints !== undefined) {
      this.params.defaultStopPoints = params.stopLossPoints;
    }

    // Initialize LTF confirmation module
    this.ltfConfirmation = new LTFConfirmation({
      timeoutCandles: this.params.confirmationTimeout,
      minWickToBodyRatio: this.params.minWickToBodyRatio,
      stopBuffer: this.params.stopBuffer,
      minBodySize: this.params.minBodySize,
    });

    // Watching state
    this.watchingLevel = null;        // The GEX level we're watching
    this.watchingLevelType = null;    // 'support_N' or 'resistance_N'
    this.watchingSide = null;         // 'buy' or 'sell'
    this.watchStartCandleIndex = 0;   // When we started watching
    this.watchingZone = null;         // { high, low } zone boundaries

    // Global candle counter (doesn't reset when we reset watching)
    this.totalCandleCount = 0;

    // Track previous candle for engulfing detection
    this.prevCandle = null;

    // Track last touched levels to avoid immediate re-entry
    this.lastTouchedSupport = null;
    this.lastTouchedResistance = null;
    this.lastTouchTime = 0;
  }

  /**
   * Evaluate if a GEX scalp confirmed signal should be generated
   *
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Contains gexLevels
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    // Validate inputs
    if (!isValidCandle(candle)) {
      if (debug) {
        console.log(`[GEX_SCALP_CONFIRMED] Invalid candle`);
      }
      return null;
    }

    // Increment global candle counter
    this.totalCandleCount++;
    const candleIndex = this.totalCandleCount;

    // Store previous candle for engulfing detection
    if (prevCandle && isValidCandle(prevCandle)) {
      this.prevCandle = prevCandle;
    }

    // Extract market data
    const { gexLevels } = marketData || {};
    if (!gexLevels) {
      if (debug) console.log('[GEX_SCALP_CONFIRMED] No GEX levels available');
      return null;
    }

    // If we're watching for confirmation, check for it first
    if (this.watchingLevel !== null) {
      const confirmation = this.checkConfirmation(candle, candleIndex, gexLevels, debug);
      if (confirmation) {
        return confirmation;
      }
      // Still watching or timed out - don't look for new entries
      return null;
    }

    // Not watching - check cooldown before looking for new zone entries
    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) {
      if (debug) {
        const currentMs = this.toMs(candle.timestamp);
        const remainingMs = (this.lastSignalTime + cooldownMs) - currentMs;
        console.log(`[GEX_SCALP_CONFIRMED] In cooldown (${Math.ceil(remainingMs/1000)}s remaining)`);
      }
      return null;
    }

    // Check session filter
    if (!this.isAllowedSession(candle.timestamp)) {
      if (debug) {
        const currentSession = this.getSession(candle.timestamp);
        console.log(`[GEX_SCALP_CONFIRMED] Session filter blocked (current: ${currentSession})`);
      }
      return null;
    }

    // Check blocked hours
    if (this.isBlockedHour(candle.timestamp)) {
      if (debug) console.log('[GEX_SCALP_CONFIRMED] Blocked hour');
      return null;
    }

    // Check regime filter
    if (!this.isAllowedRegime(gexLevels.regime)) {
      if (debug) console.log(`[GEX_SCALP_CONFIRMED] Regime filter blocked`);
      return null;
    }

    // Look for zone entries
    const zoneEntry = this.findZoneEntry(candle, gexLevels, debug);
    if (zoneEntry) {
      this.startWatching(zoneEntry, candleIndex, debug);
    }

    return null;
  }

  /**
   * Find if price has entered a GEX level zone
   * @param {Object} candle - Current candle
   * @param {Object} gexLevels - GEX levels data
   * @param {boolean} debug - Debug mode
   * @returns {Object|null} Zone entry info or null
   */
  findZoneEntry(candle, gexLevels, debug) {
    const price = candle.close;

    for (const levelNum of this.params.tradeLevels) {
      // Check support levels for long entries
      if (this.params.useLongEntries) {
        const supportLevel = this.getSupportLevel(gexLevels, levelNum);

        if (supportLevel !== null) {
          const zoneHigh = supportLevel + this.params.zoneSize;
          const zoneLow = supportLevel - this.params.zoneSize;
          const distanceToLevel = Math.abs(price - supportLevel);

          // Check if price is in zone AND close to level
          if (price >= zoneLow && price <= zoneHigh && distanceToLevel <= this.params.levelBuffer) {
            // Check if this is a fresh touch
            if (!this.isRecentTouch(supportLevel, 'support', candle.timestamp)) {
              if (debug) {
                console.log(`[GEX_SCALP_CONFIRMED] Entered S${levelNum} zone: level=${supportLevel}, price=${price}, dist=${distanceToLevel.toFixed(2)}`);
              }
              return {
                level: supportLevel,
                levelType: `support_${levelNum}`,
                side: 'buy',
                zone: { high: zoneHigh, low: zoneLow },
                entryCandle: candle,
              };
            }
          }
        }
      }

      // Check resistance levels for short entries
      if (this.params.useShortEntries) {
        const resistanceLevel = this.getResistanceLevel(gexLevels, levelNum);

        if (resistanceLevel !== null) {
          const zoneHigh = resistanceLevel + this.params.zoneSize;
          const zoneLow = resistanceLevel - this.params.zoneSize;
          const distanceToLevel = Math.abs(price - resistanceLevel);

          // Check if price is in zone AND close to level
          if (price >= zoneLow && price <= zoneHigh && distanceToLevel <= this.params.levelBuffer) {
            // Check if this is a fresh touch
            if (!this.isRecentTouch(resistanceLevel, 'resistance', candle.timestamp)) {
              if (debug) {
                console.log(`[GEX_SCALP_CONFIRMED] Entered R${levelNum} zone: level=${resistanceLevel}, price=${price}, dist=${distanceToLevel.toFixed(2)}`);
              }
              return {
                level: resistanceLevel,
                levelType: `resistance_${levelNum}`,
                side: 'sell',
                zone: { high: zoneHigh, low: zoneLow },
                entryCandle: candle,
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Start watching for confirmation patterns
   * @param {Object} zoneEntry - Zone entry info
   * @param {number} candleIndex - Current candle index
   * @param {boolean} debug - Debug mode
   */
  startWatching(zoneEntry, candleIndex, debug) {
    this.watchingLevel = zoneEntry.level;
    this.watchingLevelType = zoneEntry.levelType;
    this.watchingSide = zoneEntry.side;
    this.watchStartCandleIndex = candleIndex;
    this.watchingZone = zoneEntry.zone;

    // Create a pseudo order block for the LTF confirmation module
    const pseudoOB = {
      high: zoneEntry.zone.high,
      low: zoneEntry.zone.low,
      type: zoneEntry.side === 'buy' ? 'bullish' : 'bearish',
      timestamp: zoneEntry.entryCandle.timestamp,
    };

    this.ltfConfirmation.startWatching(pseudoOB, zoneEntry.side, candleIndex);

    if (debug) {
      console.log(`[GEX_SCALP_CONFIRMED] Started watching ${zoneEntry.levelType} at ${zoneEntry.level} for confirmation`);
    }
  }

  /**
   * Check for confirmation patterns
   * @param {Object} candle - Current candle
   * @param {number} candleIndex - Current candle index
   * @param {Object} gexLevels - GEX levels data
   * @param {boolean} debug - Debug mode
   * @returns {Object|null} Signal if confirmed, null otherwise
   */
  checkConfirmation(candle, candleIndex, gexLevels, debug) {
    const confirmation = this.ltfConfirmation.checkConfirmation(candle, candleIndex);

    if (!confirmation || confirmation.status === 'not_watching') {
      this.clearWatching();
      return null;
    }

    if (confirmation.status === 'timeout') {
      if (debug) {
        console.log(`[GEX_SCALP_CONFIRMED] Timeout waiting for confirmation at ${this.watchingLevelType}=${this.watchingLevel}`);
      }
      this.clearWatching();
      return null;
    }

    if (confirmation.status === 'watching') {
      // Still watching, check if price has left the zone (invalidate)
      const price = candle.close;
      if (price < this.watchingZone.low - this.params.zoneSize ||
          price > this.watchingZone.high + this.params.zoneSize) {
        if (debug) {
          console.log(`[GEX_SCALP_CONFIRMED] Price left zone, cancelling watch`);
        }
        this.clearWatching();
      }
      return null;
    }

    if (confirmation.status === 'confirmed') {
      // Check if this confirmation type is enabled
      if (!this.params.confirmationTypes.includes(confirmation.confirmationType)) {
        if (debug) {
          console.log(`[GEX_SCALP_CONFIRMED] Confirmation type ${confirmation.confirmationType} not enabled`);
        }
        this.clearWatching();
        return null;
      }

      // Generate signal
      const signal = this.generateConfirmedSignal(candle, confirmation, gexLevels, debug);

      // Record the touch and update signal time
      if (signal) {
        const levelType = this.watchingSide === 'buy' ? 'support' : 'resistance';
        this.recordTouch(this.watchingLevel, levelType, candle.timestamp);
        this.updateLastSignalTime(candle.timestamp);
      }

      this.clearWatching();
      return signal;
    }

    return null;
  }

  /**
   * Generate signal from confirmed pattern
   * @param {Object} candle - Current candle
   * @param {Object} confirmation - Confirmation result
   * @param {Object} gexLevels - GEX levels data
   * @param {boolean} debug - Debug mode
   * @returns {Object|null} Signal object
   */
  generateConfirmedSignal(candle, confirmation, gexLevels, debug) {
    const side = this.watchingSide;
    const entryPrice = confirmation.entryPrice;
    let stopPrice = confirmation.stopPrice;
    let stopDistance;

    // Option to use fixed stops instead of dynamic confirmation-based stops
    if (this.params.useFixedStops) {
      stopDistance = this.params.defaultStopPoints;
      stopPrice = side === 'buy'
        ? entryPrice - stopDistance
        : entryPrice + stopDistance;
    } else {
      // Calculate stop distance from confirmation candle
      stopDistance = Math.abs(entryPrice - stopPrice);

      // Ensure stop is within bounds
      if (stopDistance < this.params.minStopPoints) {
        stopDistance = this.params.minStopPoints;
        stopPrice = side === 'buy'
          ? entryPrice - stopDistance
          : entryPrice + stopDistance;
      } else if (stopDistance > this.params.maxStopPoints) {
        stopDistance = this.params.maxStopPoints;
        stopPrice = side === 'buy'
          ? entryPrice - stopDistance
          : entryPrice + stopDistance;
      }
    }

    // Calculate target
    const targetPrice = side === 'buy'
      ? entryPrice + this.params.targetPoints
      : entryPrice - this.params.targetPoints;

    if (debug) {
      console.log(`[GEX_SCALP_CONFIRMED] SIGNAL: ${side.toUpperCase()} at ${this.watchingLevelType}=${this.watchingLevel}`);
      console.log(`  Confirmation: ${confirmation.confirmationType} (${confirmation.confidence})`);
      console.log(`  Entry: ${entryPrice}, Stop: ${stopPrice} (${stopDistance.toFixed(1)} pts), Target: ${targetPrice}`);
    }

    const signal = {
      // Core signal data
      strategy: 'GEX_SCALP_CONFIRMED',
      side: side,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      // Trailing stop configuration
      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,

      // Strategy-specific metadata
      metadata: {
        gex_level: roundTo(this.watchingLevel),
        gex_level_type: this.watchingLevelType,
        confirmation_type: confirmation.confirmationType,
        confirmation_confidence: confirmation.confidence,
        stop_distance: roundTo(stopDistance),
        target_points: this.params.targetPoints,
        trailing_trigger: this.params.trailingTrigger,
        trailing_offset: this.params.trailingOffset,
        max_hold_minutes: this.params.maxHoldBars,
        timeout_candles: this.params.limitOrderTimeout,
        candle_time: new Date(candle.timestamp).toISOString(),
        entry_reason: `${confirmation.confirmationType} at ${this.watchingLevelType}`,
        zone_high: roundTo(this.watchingZone.high),
        zone_low: roundTo(this.watchingZone.low),

        // GEX context
        gex_regime: gexLevels?.regime || 'unknown',
        gex_support_1: this.getSupportLevel(gexLevels, 1),
        gex_resistance_1: this.getResistanceLevel(gexLevels, 1),

        // Confirmation candle details
        confirmation_candle: confirmation.confirmationCandle ? {
          open: confirmation.confirmationCandle.open,
          high: confirmation.confirmationCandle.high,
          low: confirmation.confirmationCandle.low,
          close: confirmation.confirmationCandle.close,
        } : null,
      }
    };

    return signal;
  }

  /**
   * Clear watching state
   */
  clearWatching() {
    this.watchingLevel = null;
    this.watchingLevelType = null;
    this.watchingSide = null;
    this.watchStartCandleIndex = 0;
    this.watchingZone = null;
    this.ltfConfirmation.reset();
  }

  /**
   * Get support level by index (1-based)
   */
  getSupportLevel(gexLevels, levelNum = 1) {
    const index = levelNum - 1;

    if (gexLevels.support && Array.isArray(gexLevels.support) && gexLevels.support[index] != null) {
      return gexLevels.support[index];
    }

    const csvKey = `nq_put_wall_${levelNum}`;
    if (gexLevels[csvKey] != null) {
      return gexLevels[csvKey];
    }

    return null;
  }

  /**
   * Get resistance level by index (1-based)
   */
  getResistanceLevel(gexLevels, levelNum = 1) {
    const index = levelNum - 1;

    if (gexLevels.resistance && Array.isArray(gexLevels.resistance) && gexLevels.resistance[index] != null) {
      return gexLevels.resistance[index];
    }

    const csvKey = `nq_call_wall_${levelNum}`;
    if (gexLevels[csvKey] != null) {
      return gexLevels[csvKey];
    }

    return null;
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
   * Get the current trading session
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
   * Check if current session is allowed
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) {
      return true;
    }
    const currentSession = this.getSession(timestamp);
    return this.params.allowedSessions.includes(currentSession);
  }

  /**
   * Check if regime is allowed
   */
  isAllowedRegime(regime) {
    if (!this.params.allowedRegimes || this.params.allowedRegimes.length === 0) {
      return true;
    }
    return this.params.allowedRegimes.includes(regime);
  }

  /**
   * Check if this is a recent touch of the same level
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
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.clearWatching();
    this.totalCandleCount = 0;
    this.prevCandle = null;
    this.lastTouchedSupport = null;
    this.lastTouchedResistance = null;
    this.lastTouchTime = 0;
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'GEX_SCALP_CONFIRMED';
  }

  /**
   * Get strategy description
   */
  getDescription() {
    return 'GEX Scalp strategy with candle pattern confirmation - waits for sweep+reclaim, hammer, or engulfing patterns at GEX levels';
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

    if (params.zoneSize <= 0) {
      errors.push('zoneSize must be greater than 0');
    }

    if (params.confirmationTimeout <= 0) {
      errors.push('confirmationTimeout must be greater than 0');
    }

    if (params.minWickToBodyRatio <= 0) {
      errors.push('minWickToBodyRatio must be greater than 0');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export default GexScalpConfirmedStrategy;
