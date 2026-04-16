// Strategy engine that coordinates strategy evaluation on candle closes
import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';
import { CandleBuffer } from '../utils/candle-buffer.js';
import { CandleAggregator } from '../../../shared/utils/candle-aggregator.js';
import { createStrategy, getStrategyConstant, requiresIVData, supportsBreakevenStop } from './strategy-factory.js';
import config from '../utils/config.js';

const logger = createLogger('strategy-engine');

class StrategyEngine {
  constructor(gexCalculator, redisPublisher, options = {}) {
    this.gexCalculator = gexCalculator;
    this.redisPublisher = redisPublisher;

    // Strategy selection from config
    this.strategyName = config.ACTIVE_STRATEGY;
    this.strategyConstant = getStrategyConstant(this.strategyName);
    this.requiresIV = requiresIVData(this.strategyName);
    this.supportsBreakeven = supportsBreakevenStop(this.strategyName);

    // Initialize strategy using factory
    this.strategy = createStrategy(this.strategyName, config);

    // IV Skew Calculator reference (set by main service if needed)
    this.ivSkewCalculator = null;

    logger.info(`📊 Active strategy: ${this.strategyName} (${this.strategyConstant})`);
    logger.info(`   Requires IV data: ${this.requiresIV}, Supports breakeven: ${this.supportsBreakeven}`);

    // Initialize candle buffer for 1-minute data
    this.candleBuffer = new CandleBuffer({
      symbol: options.candleBaseSymbol || config.CANDLE_BASE_SYMBOL || 'NQ',
      timeframe: '1',
      maxSize: 100
    });

    // Evaluation timeframe: '1m' means evaluate every 1m candle (default),
    // '15m' etc. means aggregate 1m candles and only evaluate on completed higher-TF candles
    this.evalTimeframe = config.EVAL_TIMEFRAME || '1m';
    this.aggregator = null;
    if (this.evalTimeframe !== '1m') {
      this.aggregator = new CandleAggregator();
      this.aggregator.initIncremental(this.evalTimeframe, this.strategyConstant);
      this.lastEvaluatedPeriod = null; // Track last evaluated period to prevent double-eval
      logger.info(`📊 Evaluation timeframe: ${this.evalTimeframe} (aggregating 1m candles)`);
    } else {
      logger.info(`📊 Evaluation timeframe: 1m (every candle close)`);
    }

    this.currentLtLevels = null;
    this.enabled = config.STRATEGY_ENABLED;
    this.inSession = false;
    this.sessionStart = config.SESSION_START_HOUR;
    this.sessionEnd = config.SESSION_END_HOUR;
    this.prevCandle = null;

    // Pending order tracking for limit order timeout
    // Map: signalId -> { symbol, side, price, candleCount, placedAt, strategy }
    this.pendingOrders = new Map();
    this.orderTimeoutCandles = this.strategy.params?.limitOrderTimeout || 3;
  }

  /**
   * Parse time-based trailing rules from config string
   * Format: "bars,mfe,action|bars,mfe,action" where action is "breakeven" or "trail:N"
   * Example: "20,35,trail:20|35,50,trail:10"
   * @param {string} rulesStr - Rules configuration string
   * @returns {Array} Parsed rules array
   */
  parseTimeBasedTrailingRules(rulesStr) {
    if (!rulesStr || rulesStr.trim() === '') return [];

    const rules = [];
    const ruleParts = rulesStr.split('|');

    for (const part of ruleParts) {
      const [barsStr, mfeStr, actionStr] = part.split(',').map(s => s.trim());

      if (!barsStr || !mfeStr || !actionStr) {
        logger.warn(`Invalid time-based trailing rule: "${part}" - skipping`);
        continue;
      }

      const afterBars = parseInt(barsStr, 10);
      const ifMFE = parseFloat(mfeStr);

      if (isNaN(afterBars) || isNaN(ifMFE)) {
        logger.warn(`Invalid numeric values in rule: "${part}" - skipping`);
        continue;
      }

      let action, trailDistance;
      if (actionStr === 'breakeven') {
        action = 'breakeven';
        trailDistance = 0;
      } else if (actionStr.startsWith('trail:')) {
        action = 'trail';
        trailDistance = parseFloat(actionStr.substring(6));
        if (isNaN(trailDistance)) {
          logger.warn(`Invalid trail distance in rule: "${part}" - skipping`);
          continue;
        }
      } else {
        logger.warn(`Unknown action in rule: "${part}" - skipping`);
        continue;
      }

      rules.push({ afterBars, ifMFE, action, trailDistance });
    }

    // Sort rules by afterBars ascending so we apply them in order
    rules.sort((a, b) => a.afterBars - b.afterBars);

    return rules;
  }

  async checkOrderTimeouts() {
    if (this.pendingOrders.size === 0) {
      return;
    }

    const ordersToCancel = [];

    // Increment candle count and check for timeouts
    for (const [orderId, order] of this.pendingOrders) {
      order.candleCount++;
      logger.debug(`Order ${orderId} candle count: ${order.candleCount}/${this.orderTimeoutCandles}`);

      if (order.candleCount >= this.orderTimeoutCandles) {
        ordersToCancel.push(order);
      }
    }

    // Send cancel signals for timed out orders
    for (const order of ordersToCancel) {
      logger.info(`⏰ Order ${order.orderId} timed out after ${order.candleCount} candles, sending cancel_limit`);

      const cancelSignal = {
        webhook_type: 'trade_signal',
        action: 'cancel_limit',
        symbol: order.symbol,
        side: order.side,
        strategy: order.strategy,
        reason: `Limit order timeout after ${order.candleCount} candles (${order.candleCount} minutes)`,
        original_price: order.price,
        placed_at: order.placedAt,
        timestamp: new Date().toISOString()
      };

      await this.publishSignal(cancelSignal);

      this.pendingOrders.delete(order.orderId);
    }
  }

  setLtLevels(ltLevels) {
    // Map monitor fields (L2-L6) to strategy fields (level_1-level_5)
    // Monitor L0/L1 are non-Fibonacci indicator outputs; L2-L6 are the Fib 34/55/144/377/610 levels
    if (ltLevels && ltLevels.L2 !== undefined) {
      this.currentLtLevels = {
        ...ltLevels,
        level_1: ltLevels.L2,
        level_2: ltLevels.L3,
        level_3: ltLevels.L4,
        level_4: ltLevels.L5,
        level_5: ltLevels.L6
      };
    } else {
      // Already has level_1-level_5 (e.g. from backtest loader)
      this.currentLtLevels = ltLevels;
    }
    logger.debug(`LT levels updated: ${JSON.stringify(this.currentLtLevels)}`);
  }

  setGexCalculator(gexCalculator) {
    this.gexCalculator = gexCalculator;
    logger.info('GEX calculator updated in strategy engine');
  }

  setIVSkewCalculator(ivSkewCalculator) {
    this.ivSkewCalculator = ivSkewCalculator;
    logger.info('IV Skew calculator set in strategy engine');
  }

  /**
   * Process incoming candle data from TradingView
   * @param {object} candleData - Raw candle data with TradingView timestamp
   * @returns {boolean} True if new candle was closed
   */
  processCandle(candleData) {
    // Add candle to buffer and check if it's a new closed candle
    return this.candleBuffer.addCandle(candleData);
  }

  isInTradingSession() {
    // Check if we're in the trading session (6PM - 4PM EST)
    const now = new Date();
    const hour = now.getHours();

    // Session runs from 18:00 to 16:00 next day
    if (this.sessionStart > this.sessionEnd) {
      // Session crosses midnight
      return hour >= this.sessionStart || hour < this.sessionEnd;
    } else {
      // Session within same day
      return hour >= this.sessionStart && hour < this.sessionEnd;
    }
  }

  async evaluateCandle(candle) {
    if (!this.enabled) {
      logger.debug('Strategy evaluation disabled');
      return;
    }

    // Check if we're in trading session
    if (!this.isInTradingSession()) {
      logger.debug('Outside trading session, skipping evaluation');
      return;
    }

    // Only evaluate candles matching configured base symbol
    const baseSymbol = config.CANDLE_BASE_SYMBOL || 'NQ';
    if (!candle.symbol.includes(baseSymbol)) {
      logger.debug(`Skipping non-${baseSymbol} symbol: ${candle.symbol}`);
      return;
    }

    // If using a higher evaluation timeframe, aggregate 1m candles
    // and only run strategy evaluation when a new aggregated candle completes
    if (this.aggregator) {
      const key = `${this.strategyConstant}_${this.evalTimeframe}`;
      const state = this.aggregator.incrementalState[key];
      const prevCompletedCount = state ? state.aggregatedCandles.length : 0;

      this.aggregator.addCandleIncremental(candle, this.evalTimeframe, this.strategyConstant);

      const newCompletedCount = state ? state.aggregatedCandles.length : 0;

      let completedCandle = null;

      if (newCompletedCount > prevCompletedCount) {
        // Aggregator finalized previous period (a candle from the next period arrived).
        // Only evaluate if we didn't already evaluate this period early.
        const finalized = state.aggregatedCandles[state.aggregatedCandles.length - 1];
        if (finalized.timestamp !== this.lastEvaluatedPeriod) {
          completedCandle = finalized;
          this.lastEvaluatedPeriod = finalized.timestamp;
        }
      }

      if (!completedCandle && state && state.currentPeriod) {
        // Check if this 1m candle is the LAST in the current period
        // (i.e., the next minute would start a new period)
        const candleTime = typeof candle.timestamp === 'number'
          ? candle.timestamp : new Date(candle.timestamp).getTime();
        const nextMinute = candleTime + 60000;
        const intervalMinutes = this.aggregator.getIntervalMinutes(this.evalTimeframe);
        const currentPeriodStart = this.aggregator.getPeriodStart(candleTime, intervalMinutes);
        const nextPeriodStart = this.aggregator.getPeriodStart(nextMinute, intervalMinutes);

        if (nextPeriodStart !== currentPeriodStart && currentPeriodStart !== this.lastEvaluatedPeriod) {
          // This is the last 1m candle in the period — evaluate now
          completedCandle = { ...state.currentPeriod };
          this.lastEvaluatedPeriod = currentPeriodStart;
        }
      }

      if (!completedCandle) {
        // Still accumulating — check order timeouts on every 1m candle
        await this.checkOrderTimeouts();
        return;
      }

      logger.info(`🕯️ ${this.evalTimeframe} candle closed: O=${completedCandle.open} H=${completedCandle.high} L=${completedCandle.low} C=${completedCandle.close} (${completedCandle.candleCount} 1m candles)`);

      // Evaluate using the aggregated candle instead of the raw 1m candle
      await this._evaluateStrategyOnCandle(completedCandle);
      return;
    }

    // Default: evaluate on every 1m candle (evalTimeframe === '1m')
    await this._evaluateStrategyOnCandle(candle);
  }

  /**
   * Core strategy evaluation logic, called with either a 1m candle or an aggregated candle
   * @param {Object} candle - The candle to evaluate (1m or aggregated)
   */
  async _evaluateStrategyOnCandle(candle) {
    try {
      // Get current GEX levels
      const gexLevels = this.gexCalculator.getCurrentLevels();
      if (!gexLevels) {
        logger.warn('No GEX levels available, skipping evaluation');
        return;
      }

      // Debug: Log candle and configured trading levels
      const tradeLevels = this.strategy.params.tradeLevels || [1];
      const levelInfo = tradeLevels.map(level => {
        const idx = level - 1;  // tradeLevels are 1-indexed, arrays are 0-indexed
        const sLevel = gexLevels.support?.[idx];
        const rLevel = gexLevels.resistance?.[idx];
        const sDist = sLevel ? Math.abs(candle.close - sLevel).toFixed(2) : 'N/A';
        const rDist = rLevel ? Math.abs(candle.close - rLevel).toFixed(2) : 'N/A';
        return `S${level}=${sLevel}(${sDist}) R${level}=${rLevel}(${rDist})`;
      }).join(', ');

      // Prepare market data for strategy
      const marketData = {
        gexLevels: gexLevels,
        ltLevels: this.currentLtLevels
      };

      // Add IV data for strategies that require it
      if (this.requiresIV && this.ivSkewCalculator) {
        const ivData = this.ivSkewCalculator.getCurrentIVSkew();
        if (ivData) {
          // Set live IV data on strategy for getIVAtTime() method
          if (typeof this.strategy.setLiveIVData === 'function') {
            this.strategy.setLiveIVData(ivData);
          }
          marketData.ivData = ivData;
          logger.info(`📊 Evaluating: close=${candle.close}, ${levelInfo}, IV=${(ivData.iv * 100).toFixed(2)}%, Skew=${(ivData.skew * 100).toFixed(3)}%`);
        } else {
          logger.debug(`📊 Evaluating: close=${candle.close}, ${levelInfo} (no IV data)`);
        }
      } else {
        logger.info(`📊 Evaluating: close=${candle.close}, ${levelInfo}, vol=${candle.volume}`);
      }

      // Generate signal using shared strategy logic
      const signal = this.strategy.evaluateSignal(
        candle,
        this.prevCandle,
        marketData
      );

      // Update previous candle for next evaluation
      this.prevCandle = candle;

      if (signal) {
        // Add webhook format fields for compatibility
        signal.webhook_type = 'trade_signal';

        // Add breakeven parameters if strategy supports it and is configured
        if (this.supportsBreakeven && this.strategy.params.breakevenStop) {
          signal.breakeven_trigger = this.strategy.params.breakevenTrigger;
          signal.breakeven_offset = this.strategy.params.breakevenOffset;
        }

        await this.publishSignal(signal);
      }

      // Check for timed out limit orders after each evaluation
      await this.checkOrderTimeouts();

    } catch (error) {
      logger.error('Error evaluating candle:', error);
    }
  }

  async publishSignal(signal) {
    try {
      signal.signalId = signal.signalId || `${signal.strategy || 'UNKNOWN'}-${signal.side || 'na'}-${(signal.price ?? signal.entryPrice ?? 'mkt')}-${Date.now()}`;
      // Publish trade signal via message bus
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
      logger.info(`Published trade signal: ${JSON.stringify(signal)}`);

      // Also publish to monitoring service
      await messageBus.publish(CHANNELS.SERVICE_HEALTH, {
        service: 'signal-generator',
        event: 'signal_generated',
        signal: signal,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to publish signal:', error);
    }
  }

  resetStrategy() {
    this.strategy.reset();
    this.prevCandle = null;
    this.candleBuffer.clear();
    this.pendingOrders.clear();
    // Reset aggregator state so partial periods don't carry over across sessions
    if (this.aggregator) {
      this.aggregator.resetIncremental(this.evalTimeframe, this.strategyConstant);
      this.aggregator.initIncremental(this.evalTimeframe, this.strategyConstant);
      this.lastEvaluatedPeriod = null;
    }
    logger.info('Strategy engine reset for new session');
  }

  /**
   * Get candle buffer statistics
   * @returns {object} Buffer statistics
   */
  getCandleBufferStats() {
    return this.candleBuffer.getStats();
  }

  enable() {
    this.enabled = true;
    logger.info('Strategy engine enabled');
  }

  disable() {
    this.enabled = false;
    logger.info('Strategy engine disabled');
  }

  async publishStrategyStatus() {
    try {
      const gexLevels = this.gexCalculator.getCurrentLevels();
      const now = new Date();

      // Get IV data if available
      const ivData = this.ivSkewCalculator?.getCurrentIVSkew() || null;

      const status = {
        strategy: {
          name: this.strategy.getName(),
          type: this.strategyName,
          constant: this.strategyConstant,
          enabled: this.enabled,
          requires_iv: this.requiresIV,
          supports_breakeven: this.supportsBreakeven,
          session: {
            in_session: this.inSession,
            current_hour: now.getHours(),
            session_hours: `${this.sessionStart}:00 - ${this.sessionEnd}:00`
          },
          cooldown: {
            in_cooldown: !this.strategy.checkCooldown(now.getTime(), this.strategy.params.signalCooldownMs),
            formatted: this.strategy.checkCooldown(now.getTime(), this.strategy.params.signalCooldownMs) ? "Ready" : "In cooldown",
            seconds_remaining: Math.max(0, Math.ceil((this.strategy.lastSignalTime + this.strategy.params.signalCooldownMs - now.getTime()) / 1000))
          }
        },
        iv_data: ivData ? {
          symbol: ivData.symbol,
          iv: ivData.iv,
          skew: ivData.skew,
          call_iv: ivData.callIV,
          put_iv: ivData.putIV,
          signal: ivData.signal,
          atm_strike: ivData.atmStrike,
          timestamp: ivData.timestamp
        } : null,
        gex_levels: gexLevels ? {
          put_wall: gexLevels.putWall,
          call_wall: gexLevels.callWall,
          support: gexLevels.support || [],
          resistance: gexLevels.resistance || [],
          regime: gexLevels.regime,
          total_gex: gexLevels.totalGex
        } : null,
        candle_buffer: {
          count: this.candleBuffer.getStats().count,
          initialized: this.candleBuffer.getStats().initialized,
          last_candle_time: this.candleBuffer.getStats().lastCandleTime
        },
        pending_orders: {
          count: this.pendingOrders.size,
          timeout_candles: this.orderTimeoutCandles,
          orders: Array.from(this.pendingOrders.values()).map(o => ({
            orderId: o.orderId,
            side: o.side,
            price: o.price,
            candleCount: o.candleCount,
            placedAt: o.placedAt
          }))
        },
        evaluation_readiness: {
          ready: this.enabled && this.inSession && !!gexLevels,
          conditions_met: [],
          blockers: []
        },
        timestamp: now.toISOString()
      };

      // Add condition details
      if (this.enabled) status.evaluation_readiness.conditions_met.push("Strategy enabled");
      else status.evaluation_readiness.blockers.push("Strategy disabled");

      if (this.inSession) status.evaluation_readiness.conditions_met.push("In trading session");
      else status.evaluation_readiness.blockers.push("Outside trading session");

      if (gexLevels) status.evaluation_readiness.conditions_met.push("GEX levels available");
      else status.evaluation_readiness.blockers.push("GEX levels unavailable");

      await messageBus.publish(CHANNELS.STRATEGY_STATUS, status);
      logger.debug('📈 Strategy status published');
    } catch (error) {
      logger.error('Failed to publish strategy status:', error);
    }
  }

  async run() {
    logger.info('Strategy engine started');

    while (true) {
      try {
        // Check for session change
        const inSessionNow = this.isInTradingSession();
        if (inSessionNow !== this.inSession) {
          this.inSession = inSessionNow;
          if (inSessionNow) {
            logger.info('Trading session started');
            this.resetStrategy();
          } else {
            logger.info('Trading session ended');
          }
        }

        // Publish strategy status
        await this.publishStrategyStatus();

        // Sleep and continue
        await new Promise(resolve => setTimeout(resolve, 30000)); // Check every 30 seconds

      } catch (error) {
        logger.error('Error in strategy engine run loop:', error);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
}

export default StrategyEngine;