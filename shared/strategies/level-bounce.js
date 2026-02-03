/**
 * Level Bounce Strategy
 *
 * Trades confirmed bounces off dynamic indicator levels:
 * - EMAs (9, 20, 50)
 * - VWAP with standard deviation bands
 * - Bollinger Bands
 *
 * Entry: Price touches level + shows rejection (wick touch with close moving away)
 * Stop: Tight stop just beyond the level
 * Exit: Trailing stop to lock profits
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';
import { DynamicLevels } from '../indicators/dynamic-levels.js';
import { LevelPerformanceTracker } from '../utils/level-performance-tracker.js';

export class LevelBounceStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Bounce detection
      proximityPoints: 3,         // Price must be within X points of level to trigger
      minWickTouch: 1,            // Wick must extend at least X points past close toward level
      minRejectionSize: 1,        // Close must be at least X points away from level

      // Risk management
      stopBuffer: 2,              // Points beyond the level for stop loss (structural)
      maxRisk: 6,                 // Maximum risk in points
      stopLossPoints: null,       // Fixed stop loss from entry (overrides structural stop)

      // Trailing stop - lock profits
      trailingTrigger: 2,         // Activate at X pts profit
      trailingOffset: 2,          // Trail X pts behind (breakeven lock)

      // Target
      targetPoints: 10,           // Take profit target

      // Order management
      useLimitOrders: true,       // Place limit orders at level (vs market at close)
      orderTimeoutCandles: 3,     // Cancel unfilled limit orders after X candles

      // Signal management
      signalCooldownMs: 60000,    // 1 minute cooldown

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Level weights (higher = more trusted)
      levelPriority: {
        vwap: 3,          // VWAP is king
        ema: 2,           // EMAs respected by algos
        vwap_band: 2,     // VWAP bands
        bb: 1,            // Bollinger bands
      },

      // Filter to only trade specific levels (null = trade all)
      // e.g., ['EMA100', 'BB_Lower', 'VWAP-2σ', 'VWAP-3σ']
      allowedLevels: null,

      // Level+Session rules - only trade specific levels in specific sessions
      // e.g., { 'VWAP': ['overnight'], 'BB_Lower': ['rth'] }
      // Sessions: 'overnight', 'premarket', 'rth', 'afterhours'
      levelSessionRules: null,

      // Session filter (RTH only by default)
      useSessionFilter: true,
      allowedHoursEST: [[9.5, 16]], // 9:30 AM - 4:00 PM EST

      // Indicator settings (passed to DynamicLevels)
      emaPeriods: [9, 20, 50, 100],
      vwapBands: [1, 2, 3],
      bbPeriod: 20,
      bbStdDev: 2,

      // Confirmation mode - wait for next candle to confirm
      useConfirmation: false,       // Enable confirmation mode
      confirmationMinMove: 1,       // Next candle must move X pts in bounce direction

      // Adaptive tracking - automatically disable underperforming combos
      useAdaptiveTracking: false,
      adaptiveWindowSize: 50,       // Rolling window for performance
      adaptiveMinTrades: 10,        // Min trades before disabling
      adaptiveMinWinRate: 0.50,     // Disable if win rate falls below
      adaptiveMinProfitFactor: 1.0, // Disable if PF falls below
      adaptiveCooldownTrades: 100,  // Trades before re-enabling

      ...params
    };

    this.params = { ...this.defaultParams, ...params };

    // Initialize the dynamic levels indicator
    this.dynamicLevels = new DynamicLevels({
      emaPeriods: this.params.emaPeriods,
      vwapBands: this.params.vwapBands,
      bbPeriod: this.params.bbPeriod,
      bbStdDev: this.params.bbStdDev,
    });

    // Initialize performance tracker for adaptive mode
    this.performanceTracker = new LevelPerformanceTracker({
      windowSize: this.params.adaptiveWindowSize,
      minTrades: this.params.adaptiveMinTrades,
      minWinRate: this.params.adaptiveMinWinRate,
      minProfitFactor: this.params.adaptiveMinProfitFactor,
      cooldownTrades: this.params.adaptiveCooldownTrades,
      autoDisable: this.params.useAdaptiveTracking,
      autoEnable: this.params.useAdaptiveTracking,
    });

    // Track the last level we bounced off (avoid re-entry)
    this.lastBounceLevel = null;
    this.lastBounceTime = 0;

    // Pending bounce for confirmation mode
    this.pendingBounce = null;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;
    const isNewSession = options.isNewSession || false;

    if (!isValidCandle(candle)) return null;
    if (!prevCandle) return null;

    // Update dynamic levels with new candle
    this.dynamicLevels.update(candle, isNewSession);

    // Check cooldown
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Session filter
    if (this.params.useSessionFilter) {
      if (!this.checkSessionFilter(candle.timestamp)) {
        if (debug) console.log(`[LEVEL_BOUNCE] Outside session hours`);
        this.pendingBounce = null; // Clear pending on session filter
        return null;
      }
    }

    // Get all current levels
    const levels = this.dynamicLevels.getLevelsArray();
    if (levels.length === 0) {
      if (debug) console.log(`[LEVEL_BOUNCE] No levels available yet`);
      return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // CONFIRMATION MODE: Check if previous bounce is confirmed
    // ═══════════════════════════════════════════════════════════════════
    if (this.params.useConfirmation && this.pendingBounce) {
      const pending = this.pendingBounce;
      const confirmed = this.checkBounceConfirmation(candle, pending, debug);

      if (confirmed) {
        // Clear pending and generate signal
        this.pendingBounce = null;

        // Entry price: level value for limit orders, candle close for market orders
        const entryPrice = this.params.useLimitOrders ? pending.levelValue : candle.close;
        const stopPrice = this.calculateStopPrice(entryPrice, pending.side, pending.levelValue);
        const risk = Math.abs(entryPrice - stopPrice);

        if (risk > this.params.maxRisk) {
          if (debug) console.log(`[LEVEL_BOUNCE] Confirmed but risk ${risk.toFixed(2)} > maxRisk`);
          return null;
        }

        const targetPrice = pending.side === 'buy'
          ? entryPrice + this.params.targetPoints
          : entryPrice - this.params.targetPoints;

        this.updateLastSignalTime(candle.timestamp);
        this.lastBounceLevel = pending.levelName;
        this.lastBounceTime = this.toMs(candle.timestamp);

        const action = this.params.useLimitOrders ? 'place_limit' : 'place_market';

        if (debug) {
          console.log(`[LEVEL_BOUNCE] ✅ CONFIRMED ${pending.side.toUpperCase()} ${action} @ ${entryPrice.toFixed(2)} | ` +
            `Level: ${pending.levelName} (${pending.levelValue.toFixed(2)})`);
        }

        return {
          strategy: 'LEVEL_BOUNCE',
          side: pending.side,
          action: action,
          symbol: this.params.tradingSymbol,
          price: roundTo(entryPrice),
          stop_loss: roundTo(stopPrice),
          take_profit: roundTo(targetPrice),
          quantity: this.params.defaultQuantity,
          timestamp: new Date(candle.timestamp).toISOString(),
          trailing_trigger: this.params.trailingTrigger,
          trailing_offset: this.params.trailingOffset,
          timeoutCandles: this.params.orderTimeoutCandles,
          metadata: {
            level_name: pending.levelName,
            level_value: roundTo(pending.levelValue),
            level_type: pending.levelType,
            bounce_quality: pending.quality,
            risk_points: roundTo(risk),
            confirmed: true,
            candle_time: new Date(candle.timestamp).toISOString(),
          }
        };
      } else {
        // Bounce not confirmed - clear pending
        if (debug) console.log(`[LEVEL_BOUNCE] Pending bounce NOT confirmed, clearing`);
        this.pendingBounce = null;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // DETECT NEW BOUNCE
    // ═══════════════════════════════════════════════════════════════════
    const bounce = this.detectBounce(candle, prevCandle, levels, debug, candle.timestamp);
    if (!bounce) return null;

    // Check if we recently bounced off this same level (avoid re-entry)
    const candleTime = this.toMs(candle.timestamp);
    if (this.lastBounceLevel === bounce.levelName &&
        (candleTime - this.lastBounceTime) < this.params.signalCooldownMs * 3) {
      if (debug) console.log(`[LEVEL_BOUNCE] Already bounced off ${bounce.levelName} recently`);
      return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // CONFIRMATION MODE: Store bounce and wait for next candle
    // ═══════════════════════════════════════════════════════════════════
    if (this.params.useConfirmation) {
      this.pendingBounce = {
        ...bounce,
        triggerCandle: { ...candle },
        timestamp: candleTime
      };
      if (debug) {
        console.log(`[LEVEL_BOUNCE] 📌 Pending ${bounce.side} bounce off ${bounce.levelName} - waiting for confirmation`);
      }
      return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // IMMEDIATE MODE: Generate signal now
    // ═══════════════════════════════════════════════════════════════════
    // Entry price: level value for limit orders, candle close for market orders
    const entryPrice = this.params.useLimitOrders ? bounce.levelValue : candle.close;
    const stopPrice = this.calculateStopPrice(entryPrice, bounce.side, bounce.levelValue);
    const risk = Math.abs(entryPrice - stopPrice);

    if (risk > this.params.maxRisk) {
      if (debug) console.log(`[LEVEL_BOUNCE] Risk ${risk.toFixed(2)} > maxRisk ${this.params.maxRisk}`);
      return null;
    }

    const targetPrice = bounce.side === 'buy'
      ? entryPrice + this.params.targetPoints
      : entryPrice - this.params.targetPoints;

    // Update state
    this.updateLastSignalTime(candle.timestamp);
    this.lastBounceLevel = bounce.levelName;
    this.lastBounceTime = candleTime;

    const action = this.params.useLimitOrders ? 'place_limit' : 'place_market';

    if (debug) {
      console.log(`[LEVEL_BOUNCE] ✅ ${bounce.side.toUpperCase()} ${action} @ ${entryPrice.toFixed(2)} | ` +
        `Level: ${bounce.levelName} (${bounce.levelValue.toFixed(2)}) | ` +
        `Stop: ${stopPrice.toFixed(2)} | Risk: ${risk.toFixed(2)}pts`);
    }

    return {
      strategy: 'LEVEL_BOUNCE',
      side: bounce.side,
      action: action,
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),
      trailing_trigger: this.params.trailingTrigger,
      trailing_offset: this.params.trailingOffset,
      timeoutCandles: this.params.orderTimeoutCandles,
      metadata: {
        level_name: bounce.levelName,
        level_value: roundTo(bounce.levelValue),
        level_type: bounce.levelType,
        bounce_quality: bounce.quality,
        risk_points: roundTo(risk),
        wick_size: roundTo(bounce.wickSize),
        rejection_size: roundTo(bounce.rejectionSize),
        candle_time: new Date(candle.timestamp).toISOString(),
      }
    };
  }

  /**
   * Check if a pending bounce is confirmed by the current candle
   */
  checkBounceConfirmation(candle, pending, debug) {
    const minMove = this.params.confirmationMinMove;

    if (pending.side === 'buy') {
      // For long: current candle should close higher than trigger candle
      // AND should not have broken below the level
      const moveUp = candle.close - pending.triggerCandle.close;
      const levelBroken = candle.low < pending.levelValue - this.params.stopBuffer;

      if (levelBroken) {
        if (debug) console.log(`[LEVEL_BOUNCE] Level broken on confirmation candle`);
        return false;
      }

      if (moveUp >= minMove) {
        if (debug) console.log(`[LEVEL_BOUNCE] Confirmed: moved up ${moveUp.toFixed(2)}pts`);
        return true;
      }
    } else {
      // For short: current candle should close lower than trigger candle
      // AND should not have broken above the level
      const moveDown = pending.triggerCandle.close - candle.close;
      const levelBroken = candle.high > pending.levelValue + this.params.stopBuffer;

      if (levelBroken) {
        if (debug) console.log(`[LEVEL_BOUNCE] Level broken on confirmation candle`);
        return false;
      }

      if (moveDown >= minMove) {
        if (debug) console.log(`[LEVEL_BOUNCE] Confirmed: moved down ${moveDown.toFixed(2)}pts`);
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate stop price - uses fixed stop if stopLossPoints is set,
   * otherwise uses structural stop based on level
   */
  calculateStopPrice(entryPrice, side, levelValue) {
    if (this.params.stopLossPoints) {
      // Fixed stop from entry
      return side === 'buy'
        ? entryPrice - this.params.stopLossPoints
        : entryPrice + this.params.stopLossPoints;
    }
    // Structural stop based on level
    return side === 'buy'
      ? levelValue - this.params.stopBuffer
      : levelValue + this.params.stopBuffer;
  }

  /**
   * Detect if price bounced off any level
   * @returns {Object|null} Bounce info or null
   */
  detectBounce(candle, prevCandle, levels, debug, timestamp) {
    const close = candle.close;
    const high = candle.high;
    const low = candle.low;

    let bestBounce = null;
    let bestQuality = 0;

    for (const level of levels) {
      const levelValue = level.value;
      if (!levelValue) continue;

      // Filter to allowed levels if specified
      if (this.params.allowedLevels && !this.params.allowedLevels.includes(level.name)) {
        continue;
      }

      // Filter by level+session rules if specified
      if (this.params.levelSessionRules && !this.isLevelAllowedInSession(level.name, timestamp)) {
        continue;
      }

      // Adaptive tracking filter - skip if this level+session combo is disabled
      if (this.params.useAdaptiveTracking) {
        const session = this.getSessionName(timestamp);
        if (!this.performanceTracker.isEnabled(level.name, session)) {
          continue;
        }
      }

      // Check for SUPPORT bounce (long entry)
      // Price low touched level, but closed above it
      const distanceFromLowToLevel = low - levelValue;
      const isNearSupportFromBelow = distanceFromLowToLevel >= 0 && distanceFromLowToLevel <= this.params.proximityPoints;
      const isWickTouchSupport = low <= levelValue + this.params.proximityPoints && close > levelValue;

      if (isNearSupportFromBelow || isWickTouchSupport) {
        // Calculate wick size (how far price went toward level)
        const wickSize = close - low;
        // Calculate rejection (how far close is from level)
        const rejectionSize = close - levelValue;

        if (wickSize >= this.params.minWickTouch && rejectionSize >= this.params.minRejectionSize) {
          // Confirm: current close should be higher than previous close (momentum up)
          if (close > prevCandle.close) {
            const priority = this.params.levelPriority[level.type] || 1;
            const quality = priority * (wickSize + rejectionSize);

            if (quality > bestQuality) {
              bestQuality = quality;
              bestBounce = {
                side: 'buy',
                levelName: level.name,
                levelValue: levelValue,
                levelType: level.type,
                wickSize,
                rejectionSize,
                quality: roundTo(quality),
              };
            }
          }
        }
      }

      // Check for RESISTANCE bounce (short entry)
      // Price high touched level, but closed below it
      const distanceFromHighToLevel = levelValue - high;
      const isNearResistanceFromAbove = distanceFromHighToLevel >= 0 && distanceFromHighToLevel <= this.params.proximityPoints;
      const isWickTouchResistance = high >= levelValue - this.params.proximityPoints && close < levelValue;

      if (isNearResistanceFromAbove || isWickTouchResistance) {
        // Calculate wick size (how far price went toward level)
        const wickSize = high - close;
        // Calculate rejection (how far close is from level)
        const rejectionSize = levelValue - close;

        if (wickSize >= this.params.minWickTouch && rejectionSize >= this.params.minRejectionSize) {
          // Confirm: current close should be lower than previous close (momentum down)
          if (close < prevCandle.close) {
            const priority = this.params.levelPriority[level.type] || 1;
            const quality = priority * (wickSize + rejectionSize);

            if (quality > bestQuality) {
              bestQuality = quality;
              bestBounce = {
                side: 'sell',
                levelName: level.name,
                levelValue: levelValue,
                levelType: level.type,
                wickSize,
                rejectionSize,
                quality: roundTo(quality),
              };
            }
          }
        }
      }
    }

    if (debug && bestBounce) {
      console.log(`[LEVEL_BOUNCE] Detected ${bestBounce.side} bounce off ${bestBounce.levelName} ` +
        `@ ${bestBounce.levelValue.toFixed(2)} (quality: ${bestBounce.quality})`);
    }

    return bestBounce;
  }

  /**
   * Check if within allowed trading session
   */
  checkSessionFilter(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;

    for (const [start, end] of this.params.allowedHoursEST) {
      if (timeDecimal >= start && timeDecimal < end) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get current session name based on timestamp
   * @returns {string} 'overnight', 'premarket', 'rth', or 'afterhours'
   */
  getSessionName(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;

    // Session definitions (EST):
    // Overnight: 6:00 PM - 4:00 AM (18.0 - 24.0 and 0.0 - 4.0)
    // Pre-Market: 4:00 AM - 9:30 AM (4.0 - 9.5)
    // RTH: 9:30 AM - 4:00 PM (9.5 - 16.0)
    // After Hours: 4:00 PM - 6:00 PM (16.0 - 18.0)

    if (timeDecimal >= 9.5 && timeDecimal < 16) {
      return 'rth';
    } else if (timeDecimal >= 4 && timeDecimal < 9.5) {
      return 'premarket';
    } else if (timeDecimal >= 16 && timeDecimal < 18) {
      return 'afterhours';
    } else {
      return 'overnight';
    }
  }

  /**
   * Check if a level is allowed in the current session based on levelSessionRules
   */
  isLevelAllowedInSession(levelName, timestamp) {
    if (!this.params.levelSessionRules) {
      return true; // No rules = all levels allowed everywhere
    }

    const allowedSessions = this.params.levelSessionRules[levelName];
    if (!allowedSessions) {
      return false; // Level not in rules = not allowed
    }

    const currentSession = this.getSessionName(timestamp);
    return allowedSessions.includes(currentSession);
  }

  /**
   * Get current indicator levels (for debugging/display)
   */
  getLevels() {
    return this.dynamicLevels.getLevels();
  }

  reset(resetTracker = false) {
    super.reset();
    this.dynamicLevels.reset();
    this.lastBounceLevel = null;
    this.lastBounceTime = 0;
    this.pendingBounce = null;

    // Only reset tracker if explicitly requested (preserve performance data across runs)
    if (resetTracker) {
      this.performanceTracker.reset();
    }
  }

  /**
   * Record a completed trade result for performance tracking
   * Called by the backtest engine after each trade closes
   * @param {Object} trade - { levelName, session, pnl, entryPrice, exitPrice, side, timestamp }
   */
  recordTradeResult(trade) {
    if (!trade.levelName || !trade.session) {
      // Try to extract from metadata if available
      if (trade.metadata) {
        trade.levelName = trade.levelName || trade.metadata.level_name;
      }
      // Determine session from timestamp
      if (!trade.session && trade.entryTime) {
        trade.session = this.getSessionName(trade.entryTime);
      }
    }

    if (trade.levelName && trade.session) {
      this.performanceTracker.recordTrade(trade.levelName, trade.session, trade);
    }
  }

  /**
   * Get the performance tracker instance
   */
  getPerformanceTracker() {
    return this.performanceTracker;
  }

  /**
   * Print a performance report from the tracker
   */
  printPerformanceReport() {
    this.performanceTracker.printReport();
  }

  /**
   * Get performance summary
   */
  getPerformanceSummary() {
    return this.performanceTracker.getSummary();
  }

  getName() {
    return 'LEVEL_BOUNCE';
  }

  getDescription() {
    return 'Trades confirmed bounces off dynamic indicator levels (EMA, VWAP, BB)';
  }
}

export default LevelBounceStrategy;
