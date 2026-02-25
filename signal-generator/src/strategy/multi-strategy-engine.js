// Multi-Strategy Engine
// Runs multiple strategies across multiple products (NQ, ES) in a single process.
// Subscribes to data channels from the data service rather than sourcing data directly.

import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';
import { CandleBuffer } from '../utils/candle-buffer.js';
import { CandleAggregator } from '../../../shared/utils/candle-aggregator.js';
import { createStrategy, getStrategyConstant, requiresIVData, supportsBreakevenStop } from './strategy-factory.js';
import config from '../utils/config.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('multi-strategy-engine');

/**
 * Wraps a single strategy instance with its runtime state
 */
class StrategyRunner {
  constructor(name, strategy, strategyConfig, productConfig) {
    this.name = name;
    this.strategyConstant = getStrategyConstant(name);
    this.strategy = strategy;
    this.enabled = strategyConfig.enabled;
    this.priority = strategyConfig.priority || 99;
    this.evalTimeframe = strategyConfig.evalTimeframe || '1m';
    this.requiresIV = requiresIVData(name);
    this.supportsBreakeven = supportsBreakevenStop(name);
    this.tradingSymbol = productConfig.tradingSymbol;

    // Pending order tracking
    this.pendingOrders = new Map();
    this.orderTimeoutCandles = strategy?.params?.limitOrderTimeout || 3;

    // Aggregator for higher-TF evaluation
    this.aggregator = null;
    this.lastEvaluatedPeriod = null;
    if (this.evalTimeframe !== '1m') {
      this.aggregator = new CandleAggregator();
      this.aggregator.initIncremental(this.evalTimeframe, this.strategyConstant);
      logger.info(`  ${name}: eval timeframe ${this.evalTimeframe} (aggregating 1m candles)`);
    }

    // Previous candle tracking for strategy evaluation
    this.prevCandle = null;
  }

  enable() { this.enabled = true; }
  disable() { this.enabled = false; }

  reset() {
    this.strategy?.reset();
    this.prevCandle = null;
    this.pendingOrders.clear();
    if (this.aggregator) {
      this.aggregator.resetIncremental(this.evalTimeframe, this.strategyConstant);
      this.aggregator.initIncremental(this.evalTimeframe, this.strategyConstant);
      this.lastEvaluatedPeriod = null;
    }
  }
}

/**
 * Per-product state: position tracking, candle buffer, market data cache, strategy runners
 */
class ProductState {
  constructor(product, productConfig) {
    this.product = product;
    this.tradingSymbol = productConfig.tradingSymbol;

    // Strategy runners keyed by name
    this.strategies = new Map();

    // Mutual exclusion: only one position per product
    this.inPosition = false;
    this.currentPosition = null;
    this.positionStrategy = null;  // Which strategy holds the position

    // Rolling candle buffer (for prevCandle + multi-bar lookback)
    this.candleBuffer = new CandleBuffer({
      symbol: product,
      timeframe: '1',
      maxSize: 100
    });

    // Cached market data from data service
    this.gexLevels = null;
    this.ltLevels = null;
    this.ivData = null;

    // Position reconciliation
    this.reconciliationConfirmed = false;
    this.lastInPositionLogTime = 0;

    // GF Early Exit tracking (per-product, for position-holding strategy)
    this.gfTrackingState = null;
    this.gfEarlyExitConfig = {
      enabled: config.GF_EARLY_EXIT_ENABLED ?? false,
      breakevenThreshold: config.GF_BREAKEVEN_THRESHOLD ?? 2,
      checkIntervalMs: 15 * 60 * 1000
    };

    // Time-based trailing (per-product)
    this.timeBasedTrailingConfig = {
      enabled: config.TIME_BASED_TRAILING_ENABLED ?? false,
      rules: this._parseTimeBasedTrailingRules(config.TIME_BASED_TRAILING_RULES || '')
    };
    this.timeBasedTrailingState = null;
  }

  _parseTimeBasedTrailingRules(rulesStr) {
    if (!rulesStr || rulesStr.trim() === '') return [];
    const rules = [];
    for (const part of rulesStr.split('|')) {
      const [barsStr, mfeStr, actionStr] = part.split(',').map(s => s.trim());
      if (!barsStr || !mfeStr || !actionStr) continue;
      const afterBars = parseInt(barsStr, 10);
      const ifMFE = parseFloat(mfeStr);
      if (isNaN(afterBars) || isNaN(ifMFE)) continue;
      let action, trailDistance;
      if (actionStr === 'breakeven') { action = 'breakeven'; trailDistance = 0; }
      else if (actionStr.startsWith('trail:')) {
        action = 'trail';
        trailDistance = parseFloat(actionStr.substring(6));
        if (isNaN(trailDistance)) continue;
      } else continue;
      rules.push({ afterBars, ifMFE, action, trailDistance });
    }
    rules.sort((a, b) => a.afterBars - b.afterBars);
    return rules;
  }
}

class MultiStrategyEngine {
  constructor() {
    // Per-product state
    this.products = new Map();

    // Global enabled flag
    this.enabled = config.STRATEGY_ENABLED;

    // Session tracking
    this.inSession = false;
    this.sessionStart = config.SESSION_START_HOUR;
    this.sessionEnd = config.SESSION_END_HOUR;

    // IV Skew calculator reference (set externally if available from data via HTTP)
    this.ivSkewCalculator = null;

    // Load strategy configuration
    this.strategyConfig = this.loadStrategyConfig();
    this.initializeProducts();
  }

  /**
   * Load strategy configuration from JSON file or env var
   */
  loadStrategyConfig() {
    // Check STRATEGY_CONFIG env var first
    const configEnv = process.env.STRATEGY_CONFIG;
    if (configEnv) {
      try {
        return JSON.parse(configEnv);
      } catch (e) {
        logger.warn('Failed to parse STRATEGY_CONFIG env var:', e.message);
      }
    }

    // Try loading from file
    const configPath = join(__dirname, '../../strategy-config.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      logger.info(`Loaded strategy config from ${configPath}`);
      return parsed;
    } catch (e) {
      logger.warn(`No strategy-config.json found, using single-strategy fallback`);
      // Fallback: use legacy single-strategy config from env vars
      return this.buildLegacyConfig();
    }
  }

  /**
   * Build config from legacy env vars (backward compatibility)
   */
  buildLegacyConfig() {
    const baseSymbol = config.CANDLE_BASE_SYMBOL || 'NQ';
    return {
      products: {
        [baseSymbol]: {
          tradingSymbol: config.TRADING_SYMBOL,
          strategies: [
            {
              name: config.ACTIVE_STRATEGY || 'gex-scalp',
              enabled: true,
              priority: 1,
              evalTimeframe: config.EVAL_TIMEFRAME || '1m'
            }
          ]
        }
      }
    };
  }

  /**
   * Initialize product states and strategy runners from config
   */
  initializeProducts() {
    const productsConfig = this.strategyConfig.products || {};

    for (const [product, productConfig] of Object.entries(productsConfig)) {
      const state = new ProductState(product, productConfig);

      for (const stratConfig of (productConfig.strategies || [])) {
        const name = stratConfig.name;

        // Skip AI trader (separate process)
        if (name === 'ai-trader') {
          logger.info(`Skipping ai-trader in multi-strategy engine (separate process)`);
          continue;
        }

        try {
          const strategy = createStrategy(name, config);
          if (!strategy) {
            logger.warn(`Strategy factory returned null for ${name}, skipping`);
            continue;
          }
          const runner = new StrategyRunner(name, strategy, stratConfig, productConfig);
          state.strategies.set(name, runner);
          logger.info(`  ${product}: ${name} (priority ${runner.priority}, ${runner.evalTimeframe}, ${stratConfig.enabled ? 'enabled' : 'disabled'})`);
        } catch (error) {
          logger.error(`Failed to create strategy ${name} for ${product}:`, error.message);
        }
      }

      this.products.set(product, state);
      logger.info(`Product ${product}: ${state.strategies.size} strategies configured, trading ${productConfig.tradingSymbol}`);
    }
  }

  /**
   * Subscribe to Redis data channels from the data service
   */
  async subscribeToDataChannels() {
    // Subscribe to candle closes
    messageBus.subscribe(CHANNELS.CANDLE_CLOSE, (message) => {
      this.handleCandleClose(message);
    });

    // Subscribe to GEX levels
    messageBus.subscribe(CHANNELS.GEX_LEVELS, (message) => {
      const product = message.product || 'NQ';
      const state = this.products.get(product);
      if (state) {
        state.gexLevels = message;
        logger.debug(`GEX levels updated for ${product}`);
      }
    });

    // Subscribe to LT levels
    messageBus.subscribe(CHANNELS.LT_LEVELS, (message) => {
      const product = message.product || 'NQ';
      const state = this.products.get(product);
      if (state) {
        // Map L2-L6 to level_1-level_5 (same as old engine)
        if (message.L2 !== undefined) {
          state.ltLevels = {
            ...message,
            level_1: message.L2,
            level_2: message.L3,
            level_3: message.L4,
            level_4: message.L5,
            level_5: message.L6
          };
        } else {
          state.ltLevels = message;
        }
        logger.debug(`LT levels updated for ${product}`);
      }
    });

    // Subscribe to IV skew
    messageBus.subscribe(CHANNELS.IV_SKEW, (message) => {
      // IV data applies to NQ product (from QQQ options)
      const state = this.products.get('NQ');
      if (state) {
        state.ivData = message;
        logger.debug('IV skew data updated');
      }
    });

    // Subscribe to position events
    messageBus.subscribe(CHANNELS.POSITION_UPDATE, (message) => {
      this.handlePositionUpdate(message);
    });
    messageBus.subscribe(CHANNELS.POSITION_CLOSED, (message) => {
      this.handlePositionClosed(message);
    });

    // Subscribe to order events
    messageBus.subscribe(CHANNELS.ORDER_PLACED, (message) => {
      this.handleOrderPlaced(message);
    });
    messageBus.subscribe(CHANNELS.ORDER_FILLED, (message) => {
      this.handleOrderFilled(message);
    });
    messageBus.subscribe(CHANNELS.ORDER_CANCELLED, (message) => {
      this.handleOrderCancelled(message);
    });

    logger.info('Subscribed to data channels: candle.close, gex.levels, lt.levels, iv.skew, position.*, order.*');
  }

  // === Candle Processing ===

  async handleCandleClose(candleData) {
    const product = candleData.product;
    const state = this.products.get(product);
    if (!state) return;

    // Add to product's candle buffer
    const candle = {
      symbol: candleData.symbol,
      timestamp: candleData.timestamp,
      open: candleData.open,
      high: candleData.high,
      low: candleData.low,
      close: candleData.close,
      volume: candleData.volume
    };

    // We receive already-closed candles from data service, so push directly
    state.candleBuffer.candles.push({ ...candle, toDict: () => candle });
    state.candleBuffer.maintainBufferSize();

    // If in position, handle position management (time-based trailing, order timeouts, EOD close)
    if (state.inPosition) {
      await this.handleInPositionCandle(state, candle);
      return;
    }

    // Evaluate all enabled strategies for this product
    await this.evaluateStrategies(state, candle);
  }

  /**
   * Handle candle when in position: trailing stops, order timeouts, EOD close
   */
  async handleInPositionCandle(state, candle) {
    // Check for EOD force close (3:55 PM EST)
    const estTime = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [h, m] = estTime.split(':').map(Number);
    if (h > 15 || (h === 15 && m >= 55)) {
      logger.info(`EOD force close for ${state.product}: ${h}:${String(m).padStart(2, '0')} EST`);
      const closeSignal = {
        webhook_type: 'trade_signal',
        action: 'position_closed',
        symbol: state.currentPosition?.symbol || state.tradingSymbol,
        side: state.currentPosition?.side,
        strategy: state.positionStrategy,
        reason: 'EOD force close (3:55 PM EST)',
        timestamp: new Date().toISOString()
      };
      await this.publishSignal(closeSignal);
      return;
    }

    // Update time-based trailing
    if (state.timeBasedTrailingConfig.enabled && state.timeBasedTrailingState) {
      this.updateTimeBasedTrailing(state, candle);
    }

    const now = Date.now();
    if (now - state.lastInPositionLogTime >= 60000) {
      logger.info(`${state.product}: In position (${state.positionStrategy}) ${state.currentPosition?.side} @ ${state.currentPosition?.entryPrice}`);
      state.lastInPositionLogTime = now;
    }

    // Check order timeouts for all strategies on this product
    for (const [, runner] of state.strategies) {
      await this.checkOrderTimeouts(runner);
    }
  }

  /**
   * Evaluate all enabled strategies for a product on candle close
   */
  async evaluateStrategies(state, candle) {
    if (!this.enabled) return;
    if (!this.isInTradingSession()) return;

    // Get strategies sorted by priority
    const runners = Array.from(state.strategies.values())
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority);

    for (const runner of runners) {
      try {
        // Handle timeframe aggregation
        let evalCandle = candle;
        if (runner.aggregator) {
          evalCandle = this.getAggregatedCandle(runner, candle);
          if (!evalCandle) {
            await this.checkOrderTimeouts(runner);
            continue;  // Still accumulating
          }
          logger.info(`${runner.evalTimeframe} candle closed for ${runner.name}: O=${evalCandle.open} H=${evalCandle.high} L=${evalCandle.low} C=${evalCandle.close}`);
        }

        await this.evaluateStrategyOnCandle(state, runner, evalCandle);

        // If we just entered a position, stop evaluating other strategies
        if (state.inPosition) break;
      } catch (error) {
        logger.error(`Error evaluating ${runner.name} for ${state.product}:`, error);
      }
    }

    // Check order timeouts for all strategies
    for (const [, runner] of state.strategies) {
      await this.checkOrderTimeouts(runner);
    }
  }

  /**
   * Aggregate 1m candle for higher timeframe strategies
   */
  getAggregatedCandle(runner, candle) {
    const key = `${runner.strategyConstant}_${runner.evalTimeframe}`;
    const stateObj = runner.aggregator.incrementalState[key];
    const prevCompletedCount = stateObj ? stateObj.aggregatedCandles.length : 0;

    runner.aggregator.addCandleIncremental(candle, runner.evalTimeframe, runner.strategyConstant);

    const newCompletedCount = stateObj ? stateObj.aggregatedCandles.length : 0;

    // Check if aggregator finalized a period
    if (newCompletedCount > prevCompletedCount) {
      const finalized = stateObj.aggregatedCandles[stateObj.aggregatedCandles.length - 1];
      if (finalized.timestamp !== runner.lastEvaluatedPeriod) {
        runner.lastEvaluatedPeriod = finalized.timestamp;
        return finalized;
      }
    }

    // Check if this is the last 1m candle in the current period
    if (stateObj && stateObj.currentPeriod) {
      const candleTime = typeof candle.timestamp === 'number'
        ? candle.timestamp : new Date(candle.timestamp).getTime();
      const nextMinute = candleTime + 60000;
      const intervalMinutes = runner.aggregator.getIntervalMinutes(runner.evalTimeframe);
      const currentPeriodStart = runner.aggregator.getPeriodStart(candleTime, intervalMinutes);
      const nextPeriodStart = runner.aggregator.getPeriodStart(nextMinute, intervalMinutes);

      if (nextPeriodStart !== currentPeriodStart && currentPeriodStart !== runner.lastEvaluatedPeriod) {
        runner.lastEvaluatedPeriod = currentPeriodStart;
        return { ...stateObj.currentPeriod };
      }
    }

    return null;
  }

  /**
   * Core evaluation: run a single strategy on a candle
   */
  async evaluateStrategyOnCandle(state, runner, candle) {
    // Get GEX levels from cached data
    const gexLevels = state.gexLevels;
    if (!gexLevels) {
      logger.debug(`No GEX levels for ${state.product}, skipping ${runner.name}`);
      return;
    }

    // Prepare market data
    const marketData = {
      gexLevels: gexLevels,
      ltLevels: state.ltLevels
    };

    // Add IV data for strategies that need it
    if (runner.requiresIV && state.ivData) {
      if (typeof runner.strategy.setLiveIVData === 'function') {
        runner.strategy.setLiveIVData(state.ivData);
      }
      marketData.ivData = state.ivData;
    }

    // Evaluate
    const signal = runner.strategy.evaluateSignal(candle, runner.prevCandle, marketData);
    runner.prevCandle = candle;

    if (signal) {
      // Add webhook format fields
      signal.webhook_type = 'trade_signal';

      // Always use the per-product trading symbol from strategy-config.json
      // (strategy factory sets config.TRADING_SYMBOL which is the global NQ symbol)
      signal.symbol = state.tradingSymbol;

      // Add breakeven parameters if supported
      if (runner.supportsBreakeven && runner.strategy.params.breakevenStop) {
        signal.breakeven_trigger = runner.strategy.params.breakevenTrigger;
        signal.breakeven_offset = runner.strategy.params.breakevenOffset;
      }

      logger.info(`Signal from ${runner.name} for ${state.product}: ${signal.action} ${signal.side} @ ${signal.price}`);
      await this.publishSignal(signal);
    }
  }

  // === Position Management ===

  handlePositionUpdate(message) {
    if (message.netPos === 0 || message.source === 'position_closed') {
      this.handlePositionClosed(message);
      return;
    }
    if (message.netPos !== 0) {
      this.handlePositionOpened(message);
    }
  }

  handlePositionOpened(message) {
    const strategy = message.strategy;

    // Find which product this position belongs to
    for (const [product, state] of this.products) {
      // Check if any strategy on this product matches
      for (const [, runner] of state.strategies) {
        if (runner.strategyConstant === strategy) {
          state.inPosition = true;
          state.positionStrategy = strategy;
          state.currentPosition = {
            symbol: message.symbol,
            side: message.side || (message.action === 'Buy' ? 'long' : 'short'),
            entryPrice: message.price || message.entryPrice,
            entryTime: message.timestamp || new Date().toISOString(),
            strategy: strategy,
            orderStrategyId: message.orderStrategyId || message.order_strategy_id,
            stopOrderId: message.stopOrderId || message.stop_order_id
          };

          logger.info(`Position opened for ${product} (${strategy}): ${state.currentPosition.side} @ ${state.currentPosition.entryPrice}`);

          // Initialize GF tracking
          if (state.gfEarlyExitConfig.enabled) {
            this.initializeGFTracking(state);
          }

          // Initialize time-based trailing
          if (state.timeBasedTrailingConfig.enabled) {
            this.initializeTimeBasedTrailing(state);
          }

          return;
        }
      }
    }
  }

  handlePositionClosed(message) {
    const strategy = message.strategy;

    for (const [product, state] of this.products) {
      if (state.positionStrategy === strategy || state.currentPosition?.strategy === strategy) {
        const exitInfo = message.exitPrice ? ` @ ${message.exitPrice}` : '';
        const pnlInfo = message.pnl ? ` (P&L: ${message.pnl > 0 ? '+' : ''}${message.pnl})` : '';
        logger.info(`Position closed for ${product}${exitInfo}${pnlInfo}`);

        state.inPosition = false;
        state.currentPosition = null;
        state.positionStrategy = null;
        state.gfTrackingState = null;
        state.timeBasedTrailingState = null;

        // Reset cooldown on the strategy that was in position
        for (const [, runner] of state.strategies) {
          if (runner.strategyConstant === strategy) {
            runner.strategy.lastSignalTime = 0;
          }
        }

        state.reconciliationConfirmed = false;
        logger.info(`${product}: Strategy reset, ready for next signal`);
        return;
      }
    }
  }

  // === Order Tracking ===

  handleOrderPlaced(message) {
    for (const [, state] of this.products) {
      for (const [, runner] of state.strategies) {
        if (runner.strategyConstant === message.strategy) {
          const orderId = message.orderId || message.strategyId;
          if (!orderId) return;
          runner.pendingOrders.set(orderId, {
            orderId,
            symbol: message.symbol,
            side: message.action === 'Buy' ? 'buy' : 'sell',
            price: message.price,
            candleCount: 0,
            placedAt: new Date().toISOString(),
            strategy: message.strategy
          });
          logger.info(`Tracking pending order ${orderId} for ${runner.name} (${runner.orderTimeoutCandles} candle timeout)`);
          return;
        }
      }
    }
  }

  handleOrderFilled(message) {
    const orderId = message.orderId || message.strategyId;
    if (!orderId) return;
    for (const [, state] of this.products) {
      for (const [, runner] of state.strategies) {
        if (runner.pendingOrders.has(orderId)) {
          runner.pendingOrders.delete(orderId);
          return;
        }
      }
    }
  }

  handleOrderCancelled(message) {
    const orderId = message.orderId || message.strategyId;
    if (!orderId) return;
    for (const [, state] of this.products) {
      for (const [, runner] of state.strategies) {
        if (runner.pendingOrders.has(orderId)) {
          runner.pendingOrders.delete(orderId);
          return;
        }
      }
    }
  }

  async checkOrderTimeouts(runner) {
    if (runner.pendingOrders.size === 0) return;

    const ordersToCancel = [];
    for (const [orderId, order] of runner.pendingOrders) {
      order.candleCount++;
      if (order.candleCount >= runner.orderTimeoutCandles) {
        ordersToCancel.push(order);
      }
    }

    for (const order of ordersToCancel) {
      logger.info(`Order ${order.orderId} timed out after ${order.candleCount} candles (${runner.name})`);
      const cancelSignal = {
        webhook_type: 'trade_signal',
        action: 'cancel_limit',
        symbol: order.symbol,
        side: order.side,
        strategy: order.strategy,
        reason: `Limit order timeout after ${order.candleCount} candles`,
        original_price: order.price,
        placed_at: order.placedAt,
        timestamp: new Date().toISOString()
      };
      await this.publishSignal(cancelSignal);
      runner.pendingOrders.delete(order.orderId);
    }
  }

  // === GF Early Exit ===

  initializeGFTracking(state) {
    const gexLevels = state.gexLevels;
    if (!gexLevels || gexLevels.gammaFlip == null) return;

    const now = Date.now();
    const periodMs = state.gfEarlyExitConfig.checkIntervalMs;
    state.gfTrackingState = {
      entryGF: gexLevels.gammaFlip,
      lastGF: gexLevels.gammaFlip,
      lastCheckPeriod: Math.floor(now / periodMs),
      consecutiveAdverse: 0,
      breakevenTriggered: false
    };
    logger.info(`GF tracking initialized for ${state.product}: entry GF = ${gexLevels.gammaFlip.toFixed(2)}`);
  }

  checkGFEarlyExit(state) {
    if (!state.gfEarlyExitConfig.enabled || !state.inPosition || !state.gfTrackingState) return;

    const now = Date.now();
    const periodMs = state.gfEarlyExitConfig.checkIntervalMs;
    const currentPeriod = Math.floor(now / periodMs);

    if (currentPeriod <= state.gfTrackingState.lastCheckPeriod) return;

    const gexLevels = state.gexLevels;
    if (!gexLevels || gexLevels.gammaFlip == null) return;

    const currentGF = gexLevels.gammaFlip;
    const gfDelta = currentGF - state.gfTrackingState.lastGF;
    const isLong = state.currentPosition.side === 'long' || state.currentPosition.side === 'buy';
    const isAdverse = isLong ? gfDelta < 0 : gfDelta > 0;

    state.gfTrackingState.lastCheckPeriod = currentPeriod;

    if (isAdverse && Math.abs(gfDelta) > 0.5) {
      state.gfTrackingState.consecutiveAdverse++;
    } else if (!isAdverse && Math.abs(gfDelta) > 0.5) {
      state.gfTrackingState.consecutiveAdverse = 0;
    }

    state.gfTrackingState.lastGF = currentGF;

    if (state.gfTrackingState.consecutiveAdverse >= state.gfEarlyExitConfig.breakevenThreshold &&
        !state.gfTrackingState.breakevenTriggered) {
      state.gfTrackingState.breakevenTriggered = true;
      this.sendBreakevenStopModification(state);
    }
  }

  async sendBreakevenStopModification(state) {
    if (!state.currentPosition) return;
    const signal = {
      webhook_type: 'trade_signal',
      action: 'modify_stop',
      strategy: state.currentPosition.strategy,
      symbol: state.currentPosition.symbol,
      new_stop_price: state.currentPosition.entryPrice,
      reason: 'gf_adverse_breakeven',
      order_strategy_id: state.currentPosition.orderStrategyId,
      order_id: state.currentPosition.stopOrderId,
      timestamp: new Date().toISOString()
    };
    await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
    logger.info(`GF breakeven stop sent for ${state.product}: stop -> ${state.currentPosition.entryPrice}`);
  }

  // === Time-Based Trailing ===

  initializeTimeBasedTrailing(state) {
    if (!state.currentPosition) return;
    state.timeBasedTrailingState = {
      entryPrice: state.currentPosition.entryPrice,
      barsInTrade: 0,
      mfe: 0,
      peakPrice: state.currentPosition.entryPrice,
      currentStopPrice: null,
      activeRuleIndex: -1,
      lastModificationBar: -1,
      rulesTriggered: []
    };
  }

  updateTimeBasedTrailing(state, candle) {
    if (!state.timeBasedTrailingConfig.enabled || !state.inPosition || !state.timeBasedTrailingState) return;

    const tbState = state.timeBasedTrailingState;
    const isLong = state.currentPosition.side === 'long' || state.currentPosition.side === 'buy';

    tbState.barsInTrade++;

    if (isLong) {
      if (candle.high > tbState.peakPrice) {
        tbState.peakPrice = candle.high;
        tbState.mfe = tbState.peakPrice - tbState.entryPrice;
      }
    } else {
      if (candle.low < tbState.peakPrice) {
        tbState.peakPrice = candle.low;
        tbState.mfe = tbState.entryPrice - tbState.peakPrice;
      }
    }

    // Check rules
    for (let i = 0; i < state.timeBasedTrailingConfig.rules.length; i++) {
      if (tbState.rulesTriggered.includes(i)) continue;
      const rule = state.timeBasedTrailingConfig.rules[i];

      if (tbState.barsInTrade >= rule.afterBars && tbState.mfe >= rule.ifMFE) {
        let newStopPrice;
        if (rule.action === 'breakeven') {
          newStopPrice = tbState.entryPrice;
        } else {
          newStopPrice = isLong
            ? tbState.peakPrice - rule.trailDistance
            : tbState.peakPrice + rule.trailDistance;
        }

        // Only update if tighter
        const shouldUpdate = tbState.currentStopPrice === null ||
          (isLong ? newStopPrice > tbState.currentStopPrice : newStopPrice < tbState.currentStopPrice);

        if (shouldUpdate) {
          tbState.rulesTriggered.push(i);
          tbState.activeRuleIndex = i;
          tbState.lastModificationBar = tbState.barsInTrade;
          this.sendTimeBasedTrailingModification(state, newStopPrice, rule, i);
        }
      }
    }
  }

  async sendTimeBasedTrailingModification(state, newStopPrice, rule, ruleIndex) {
    if (!state.currentPosition) return;
    const tbState = state.timeBasedTrailingState;
    const actionStr = rule.action === 'breakeven' ? 'breakeven' : `trail:${rule.trailDistance}`;

    const signal = {
      webhook_type: 'trade_signal',
      action: 'modify_stop',
      strategy: state.currentPosition.strategy,
      symbol: state.currentPosition.symbol,
      new_stop_price: newStopPrice,
      reason: `time_based_trailing_rule_${ruleIndex + 1}`,
      order_strategy_id: state.currentPosition.orderStrategyId,
      order_id: state.currentPosition.stopOrderId,
      metadata: {
        entryPrice: tbState.entryPrice,
        barsInTrade: tbState.barsInTrade,
        mfe: tbState.mfe,
        peakPrice: tbState.peakPrice,
        ruleAction: actionStr
      },
      timestamp: new Date().toISOString()
    };

    await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
    tbState.currentStopPrice = newStopPrice;
    logger.info(`TB-Trail: ${state.product} stop -> ${newStopPrice.toFixed(2)} (Rule ${ruleIndex + 1}: ${actionStr})`);
  }

  // === Position Sync ===

  async syncPositionState() {
    const accountId = config.TRADOVATE_ACCOUNT_ID;
    if (!accountId) {
      logger.warn('No TRADOVATE_ACCOUNT_ID, skipping position sync');
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.info(`Syncing position state (attempt ${attempt}/3)...`);
        const response = await fetch(`http://localhost:3011/positions/${accountId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const positions = await response.json();

        for (const [product, state] of this.products) {
          const openPos = positions.find(p => p.netPos !== 0 && p.symbol && p.symbol.includes(product));
          if (openPos) {
            state.inPosition = true;
            // Try to match to a strategy runner
            const matchedStrategy = this.findStrategyForPosition(state);
            state.positionStrategy = matchedStrategy;
            state.currentPosition = {
              symbol: openPos.symbol || `Contract ${openPos.contractId}`,
              side: openPos.netPos > 0 ? 'long' : 'short',
              entryPrice: openPos.netPrice || 0,
              entryTime: openPos.timestamp || new Date().toISOString(),
              strategy: matchedStrategy,
              quantity: Math.abs(openPos.netPos)
            };
            logger.info(`Found ${product} position: ${state.currentPosition.side} @ ${state.currentPosition.entryPrice} (${matchedStrategy || 'unknown'})`);
          } else {
            logger.info(`No open ${product} position`);
          }
        }
        return;
      } catch (error) {
        logger.warn(`Position sync attempt ${attempt} failed: ${error.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
      }
    }
    logger.warn('Position sync failed after 3 attempts');
  }

  findStrategyForPosition(state) {
    // Return the highest-priority enabled strategy's constant
    const runners = Array.from(state.strategies.values())
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority);
    return runners.length > 0 ? runners[0].strategyConstant : null;
  }

  async reconcilePositionState() {
    const accountId = config.TRADOVATE_ACCOUNT_ID;
    if (!accountId) return;

    try {
      const response = await fetch(`http://localhost:3011/positions/${accountId}`);
      if (!response.ok) return;
      const positions = await response.json();

      for (const [product, state] of this.products) {
        const openPos = positions.find(p => p.netPos !== 0 && p.symbol && p.symbol.includes(product));

        if (state.inPosition && !openPos) {
          logger.warn(`[RECONCILE] Stale ${product} position detected, resetting`);
          state.inPosition = false;
          state.currentPosition = null;
          state.positionStrategy = null;
          state.gfTrackingState = null;
          state.timeBasedTrailingState = null;
          for (const [, runner] of state.strategies) {
            runner.strategy.lastSignalTime = 0;
          }
          state.reconciliationConfirmed = false;
        } else if (!state.inPosition && openPos) {
          const matchedStrategy = this.findStrategyForPosition(state);
          state.inPosition = true;
          state.positionStrategy = matchedStrategy;
          state.currentPosition = {
            symbol: openPos.symbol,
            side: openPos.netPos > 0 ? 'long' : 'short',
            entryPrice: openPos.netPrice || 0,
            entryTime: openPos.timestamp || new Date().toISOString(),
            strategy: matchedStrategy,
            quantity: Math.abs(openPos.netPos)
          };
          state.reconciliationConfirmed = false;
          logger.warn(`[RECONCILE] Missed ${product} position open: ${state.currentPosition.side} @ ${state.currentPosition.entryPrice}`);
        } else if (!state.reconciliationConfirmed) {
          const desc = state.inPosition ? `in position (${state.currentPosition?.side})` : 'flat';
          logger.info(`[RECONCILE] ${product}: ${desc}`);
          state.reconciliationConfirmed = true;
        }
      }
    } catch (error) {
      logger.debug(`[RECONCILE] Skipped: ${error.message}`);
    }
  }

  // === Session & Lifecycle ===

  isInTradingSession() {
    const now = new Date();
    const hour = now.getHours();
    if (this.sessionStart > this.sessionEnd) {
      return hour >= this.sessionStart || hour < this.sessionEnd;
    }
    return hour >= this.sessionStart && hour < this.sessionEnd;
  }

  async publishSignal(signal) {
    try {
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
      logger.info(`Published trade signal: ${signal.action} ${signal.side || ''} ${signal.symbol || ''} (${signal.strategy})`);
    } catch (error) {
      logger.error('Failed to publish signal:', error);
    }
  }

  async publishStrategyStatus() {
    try {
      const now = new Date();
      const allStrategies = [];

      for (const [product, state] of this.products) {
        for (const [name, runner] of state.strategies) {
          allStrategies.push({
            product,
            name: runner.name,
            constant: runner.strategyConstant,
            enabled: runner.enabled,
            priority: runner.priority,
            evalTimeframe: runner.evalTimeframe,
            tradingSymbol: state.tradingSymbol,
            inPosition: state.inPosition && state.positionStrategy === runner.strategyConstant,
            position: state.inPosition && state.positionStrategy === runner.strategyConstant ? {
              side: state.currentPosition?.side,
              entryPrice: state.currentPosition?.entryPrice,
              entryTime: state.currentPosition?.entryTime
            } : null,
            pendingOrders: runner.pendingOrders.size,
            gexAvailable: !!state.gexLevels,
            ltAvailable: !!state.ltLevels,
            ivAvailable: !!state.ivData,
            cooldown: {
              inCooldown: !runner.strategy.checkCooldown(now.getTime(), runner.strategy.params.signalCooldownMs),
              secondsRemaining: Math.max(0, Math.ceil((runner.strategy.lastSignalTime + runner.strategy.params.signalCooldownMs - now.getTime()) / 1000))
            }
          });
        }
      }

      await messageBus.publish(CHANNELS.STRATEGY_STATUS, {
        engine: 'multi-strategy',
        strategies: allStrategies,
        timestamp: now.toISOString()
      });
    } catch (error) {
      logger.error('Failed to publish strategy status:', error);
    }
  }

  resetProduct(product) {
    const state = this.products.get(product);
    if (!state) return;
    for (const [, runner] of state.strategies) {
      runner.reset();
    }
    state.reconciliationConfirmed = false;
    logger.info(`${product}: All strategies reset for new session`);
  }

  enable() { this.enabled = true; }
  disable() { this.enabled = false; }

  enableStrategy(strategyName) {
    for (const [, state] of this.products) {
      const runner = state.strategies.get(strategyName);
      if (runner) {
        runner.enable();
        logger.info(`Enabled strategy: ${strategyName}`);
        return true;
      }
    }
    return false;
  }

  disableStrategy(strategyName) {
    for (const [, state] of this.products) {
      const runner = state.strategies.get(strategyName);
      if (runner) {
        runner.disable();
        logger.info(`Disabled strategy: ${strategyName}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Get all strategies status for HTTP endpoint
   */
  getStrategiesStatus() {
    const now = new Date();
    const result = [];

    for (const [product, state] of this.products) {
      for (const [name, runner] of state.strategies) {
        // Use strategy-level session check if available
        const strategy = runner.strategy;
        let inAllowedSession = this.isInTradingSession();
        let sessionInfo = {};
        if (strategy && typeof strategy.isAllowedSession === 'function') {
          const currentSession = strategy.getSession(now);
          const allowed = strategy.isAllowedSession(now);
          inAllowedSession = allowed;
          sessionInfo = { currentSession, allowed, allowedSessions: strategy.params.allowedSessions };
        }

        const gexLevels = state.gexLevels;

        const inCooldown = !runner.strategy.checkCooldown(now.getTime(), runner.strategy.params.signalCooldownMs);

        // Check entry cutoff
        const pastCutoff = typeof strategy.isPastEntryCutoff === 'function'
          && strategy.isPastEntryCutoff(now.getTime());

        // Check avoid hours
        let inAvoidHour = false;
        if (strategy?.params?.avoidHours?.length > 0) {
          const estHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
          inAvoidHour = strategy.params.avoidHours.includes(estHour);
        }

        const isReady = runner.enabled && inAllowedSession && !!gexLevels
          && !(state.inPosition && state.positionStrategy !== runner.strategyConstant)
          && !pastCutoff && !inAvoidHour;
        const blockers = [
          !runner.enabled ? 'Strategy disabled' : null,
          !inAllowedSession ? 'Outside allowed session' : null,
          !gexLevels ? 'No GEX levels' : null,
          state.inPosition ? `Position held by ${state.positionStrategy}` : null,
          pastCutoff ? `Past entry cutoff (${strategy.params.entryCutoffHour}:${String(strategy.params.entryCutoffMinute).padStart(2, '0')} ET)` : null,
          inAvoidHour ? `Restricted hour (avoid hour ${strategy.params.avoidHours.join(', ')})` : null,
        ].filter(Boolean);
        const conditionsMet = [
          runner.enabled ? 'Strategy enabled' : null,
          inAllowedSession ? 'In allowed session' : null,
          gexLevels ? 'GEX levels loaded' : null,
          !state.inPosition ? 'No active position' : null,
          !pastCutoff ? 'Before entry cutoff' : null,
          !inAvoidHour || !strategy?.params?.avoidHours?.length ? null : 'Outside restricted hours',
        ].filter(Boolean);

        result.push({
          product,
          name,
          constant: runner.strategyConstant,
          enabled: runner.enabled,
          priority: runner.priority,
          eval_timeframe: runner.evalTimeframe,
          trading_symbol: state.tradingSymbol,
          requires_iv: runner.requiresIV,
          supports_breakeven: runner.supportsBreakeven,
          session: {
            in_session: inAllowedSession,
            ...sessionInfo
          },
          cooldown: {
            in_cooldown: inCooldown,
            formatted: inCooldown ? 'In cooldown' : 'Ready',
            seconds_remaining: Math.max(0, Math.ceil((runner.strategy.lastSignalTime + runner.strategy.params.signalCooldownMs - now.getTime()) / 1000))
          },
          internals: typeof runner.strategy.getInternalState === 'function' ? runner.strategy.getInternalState() : null,
          position: {
            in_position: state.inPosition && state.positionStrategy === runner.strategyConstant,
            current: state.inPosition && state.positionStrategy === runner.strategyConstant ? state.currentPosition : null
          },
          gex_levels: gexLevels ? {
            futures_spot: gexLevels.futures_spot || gexLevels.nqSpot || null,
            put_wall: gexLevels.putWall,
            call_wall: gexLevels.callWall,
            support: gexLevels.support || [],
            resistance: gexLevels.resistance || [],
            regime: gexLevels.regime,
            total_gex: gexLevels.totalGex
          } : null,
          lt_levels: state.ltLevels || null,
          iv_data: runner.requiresIV ? (state.ivData || null) : null,
          pending_orders: {
            count: runner.pendingOrders.size,
            timeout_candles: runner.orderTimeoutCandles
          },
          evaluation_readiness: {
            ready: isReady,
            blockers,
            conditions_met: conditionsMet
          }
        });
      }
    }

    return result;
  }

  /**
   * Main background loop
   */
  async run() {
    logger.info('Multi-strategy engine started');
    let lastReconciliationTime = 0;
    const reconciliationIntervalMs = 5 * 60 * 1000;

    while (true) {
      try {
        // Check session changes
        const inSessionNow = this.isInTradingSession();
        if (inSessionNow !== this.inSession) {
          this.inSession = inSessionNow;
          if (inSessionNow) {
            logger.info('Trading session started');
            for (const [product] of this.products) {
              this.resetProduct(product);
            }
          } else {
            logger.info('Trading session ended');
          }
        }

        // Position reconciliation
        const now = Date.now();
        if (now - lastReconciliationTime >= reconciliationIntervalMs) {
          await this.reconcilePositionState();
          lastReconciliationTime = now;
        }

        // Publish strategy status
        await this.publishStrategyStatus();

        // GF early exit checks
        for (const [, state] of this.products) {
          this.checkGFEarlyExit(state);
        }

        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (error) {
        logger.error('Error in engine run loop:', error);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
}

export default MultiStrategyEngine;
