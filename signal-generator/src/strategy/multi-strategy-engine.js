// Multi-Strategy Engine
// Runs multiple strategies across multiple products (NQ, ES) in a single process.
// Subscribes to data channels from the data service rather than sourcing data directly.

import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';
import { CandleBuffer } from '../utils/candle-buffer.js';
import { CandleAggregator } from '../../../shared/utils/candle-aggregator.js';
import { createStrategy, getStrategyConstant, getDataRequirements, requiresIVData, supportsBreakevenStop } from './strategy-factory.js';
import { LiveShortDTEIVProvider } from '../tradier/short-dte-iv-provider.js';
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
    this.hidden = strategyConfig.hidden || false;
    this.priority = strategyConfig.priority || 99;
    this.evalTimeframe = strategyConfig.evalTimeframe || '1m';
    this.requiresIV = requiresIVData(name);
    this.supportsBreakeven = supportsBreakevenStop(name);
    this.tradingSymbol = productConfig.tradingSymbol;

    // Data readiness flag — strategies gate on this before evaluating
    this.dataReady = false;

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
    this.gexLevelsReceivedAt = 0; // Epoch ms — tracks when GEX data last arrived via Redis
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

    // Live short-DTE IV provider (shared across strategies that need it)
    this.shortDTEIVProvider = null;

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
      // Derive tradingSymbol from env vars (*_CONTRACT) - single source of truth for contract rollover
      const contractEnvVar = `${product}_CONTRACT`;
      if (process.env[contractEnvVar]) {
        productConfig.tradingSymbol = process.env[contractEnvVar];
      } else if (!productConfig.tradingSymbol) {
        productConfig.tradingSymbol = config.TRADING_SYMBOL;
      }

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

          // Wire up live Short-DTE IV provider if strategy needs it
          const reqs = getDataRequirements(name);
          if (reqs?.shortDTEIV && typeof strategy.loadShortDTEIVData === 'function') {
            if (!this.shortDTEIVProvider) {
              this.shortDTEIVProvider = new LiveShortDTEIVProvider();
              logger.info('Created LiveShortDTEIVProvider for short-dte-iv strategy');
            }
            strategy.loadShortDTEIVData(this.shortDTEIVProvider);
            logger.info(`  Wired LiveShortDTEIVProvider → ${name}`);
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
        state.gexLevelsReceivedAt = Date.now();
        logger.debug(`GEX levels updated for ${product}`);
        // Re-check data readiness for strategies waiting on GEX
        this.recheckDataReadiness(state);
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
        // Re-check data readiness for strategies waiting on LT
        this.recheckDataReadiness(state);
      }
    });

    // Subscribe to IV skew
    messageBus.subscribe(CHANNELS.IV_SKEW, (message) => {
      // IV data applies to NQ product (from QQQ options)
      const state = this.products.get('NQ');
      if (state) {
        state.ivData = message;
        logger.debug('IV skew data updated');
        this.recheckDataReadiness(state);
      }
    });

    // Subscribe to short-DTE IV snapshots (0-2 DTE, from data-service)
    if (this.shortDTEIVProvider) {
      messageBus.subscribe(CHANNELS.SHORT_DTE_IV_SNAPSHOT, (message) => {
        this.shortDTEIVProvider.receiveSnapshot(message);
        // Re-check data readiness (provider needs 2 snapshots to be ready)
        const nqState = this.products.get('NQ');
        if (nqState) this.recheckDataReadiness(nqState);
      });
      logger.info('Subscribed to short_dte_iv.snapshot channel');
    }

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

    // Subscribe to data.ready events from data-service
    messageBus.subscribe(CHANNELS.DATA_READY, async (message) => {
      logger.info(`Data ready: ${message.product} ${message.timeframe} (${message.candleCount} candles)`);

      // Re-seed strategies that need this data
      await this.seedStrategies();

      // Re-check readiness for all strategies
      for (const [product, state] of this.products) {
        for (const [name, runner] of state.strategies) {
          const wasReady = runner.dataReady;
          this.checkStrategyDataReady(runner, state);
          if (!wasReady && runner.dataReady) {
            logger.info(`Strategy ${name} (${product}) is now data-ready`);
          }
        }
      }
    });

    logger.info('Subscribed to data channels: candle.close, gex.levels, lt.levels, iv.skew, short_dte_iv.snapshot, data.ready, position.*, order.*');

    // Initial seed attempt after brief delay (data-service may already have data)
    setTimeout(() => this.seedStrategies(), 5000);
  }

  /**
   * Seed strategies with historical candle data from data-service.
   * Strategies that implement seedHistoricalData() will be called.
   */
  async seedStrategies() {
    const dataServiceUrl = process.env.DATA_SERVICE_URL || 'http://localhost:3019';

    for (const [product, state] of this.products) {
      for (const [name, runner] of state.strategies) {
        if (typeof runner.strategy?.seedHistoricalData === 'function') {
          try {
            logger.info(`Seeding historical data for ${name} (${product})...`);
            await runner.strategy.seedHistoricalData(dataServiceUrl);
            logger.info(`Historical data seeded for ${name} (${product})`);
          } catch (err) {
            logger.warn(`Failed to seed ${name} (${product}): ${err.message} — strategy will build state from live candles`);
          }
        }
      }
      // Recheck data readiness after seeding
      this.recheckDataReadiness(state);
    }
  }

  /**
   * Check if a strategy's data requirements are met.
   * Updates runner.dataReady and returns the result.
   */
  checkStrategyDataReady(runner, state) {
    const reqs = getDataRequirements(runner.name);

    // No declared requirements = always ready (backward compatible)
    if (!reqs) {
      runner.dataReady = true;
      return true;
    }

    const blockers = [];

    // Check candle seeding (strategies that implement isSeeded)
    if (reqs.candles !== false && typeof runner.strategy?.isSeeded === 'function' && !runner.strategy.isSeeded()) {
      blockers.push('candle history');
    }

    // Check GEX levels (unless strategy explicitly opts out)
    if (reqs.gex !== false && !state.gexLevels) {
      blockers.push('GEX levels');
    }

    // Check LT levels (unless strategy explicitly opts out)
    if (reqs.lt !== false && !state.ltLevels) {
      blockers.push('LT levels');
    }

    // Check IV data (only if strategy requires it)
    if (reqs.ivSkew === true && !state.ivData) {
      blockers.push('IV data');
    }

    // Check short-DTE IV provider (needs 2 snapshots to compute IV change)
    if (reqs.shortDTEIV === true && (!this.shortDTEIVProvider || !this.shortDTEIVProvider.isReady())) {
      blockers.push('short-DTE IV data (need 2 snapshots)');
    }

    runner.dataReady = blockers.length === 0;
    return runner.dataReady;
  }

  /**
   * Re-check data readiness for all strategies on a product.
   * Called when new market data (GEX, LT, IV) arrives so strategies
   * don't have to wait for the next candle evaluation to become ready.
   */
  recheckDataReadiness(state) {
    for (const [name, runner] of state.strategies) {
      if (runner.dataReady) continue; // already ready
      const wasReady = runner.dataReady;
      this.checkStrategyDataReady(runner, state);
      if (!wasReady && runner.dataReady) {
        logger.info(`Strategy ${name} (${state.product}) is now data-ready`);
      }
    }
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
    // Check maxHoldBars (force exit after N candles in trade)
    if (state.positionMaxHoldBars > 0) {
      state.positionBarsInTrade++;
      if (state.positionBarsInTrade >= state.positionMaxHoldBars) {
        logger.info(`Max hold bars (${state.positionMaxHoldBars}) reached for ${state.product} — forcing close`);
        const closeSignal = {
          webhook_type: 'trade_signal',
          action: 'position_closed',
          symbol: state.currentPosition?.symbol || state.tradingSymbol,
          side: state.currentPosition?.side,
          strategy: state.positionStrategy,
          reason: `max_hold_bars (${state.positionMaxHoldBars})`,
          timestamp: new Date().toISOString()
        };
        await this.publishSignal(closeSignal);
        return;
      }
    }

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

    // Update time-based trailing (global config OR per-signal rules)
    if (state.timeBasedTrailingState) {
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
    const inSession = this.isInTradingSession();

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

        await this.evaluateStrategyOnCandle(state, runner, evalCandle, inSession);

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
  async evaluateStrategyOnCandle(state, runner, candle, inSession = true) {
    // Gate on data readiness — skip until all requirements met
    if (!runner.dataReady && !this.checkStrategyDataReady(runner, state)) {
      logger.debug(`${runner.name} (${state.product}): data not ready, skipping evaluation`);
      return;
    }

    // Gate iv-skew-gex on fresh GEX data during RTH.
    // Pre-market GEX is calculated with stale QQQ quotes (previous close);
    // require a GEX update received AFTER today's 09:30 ET before allowing entry.
    if (runner.name === 'iv-skew-gex') {
      const now = new Date();
      const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const h = et.getHours();
      const m = et.getMinutes();
      const isRTH = (h > 9 || (h === 9 && m >= 30)) && h < 16;

      if (isRTH) {
        const rthOpen = new Date(et);
        rthOpen.setHours(9, 30, 0, 0);
        const rthOpenMs = rthOpen.getTime();

        if (state.gexLevelsReceivedAt < rthOpenMs) {
          logger.info(`${runner.name} (${state.product}): waiting for fresh RTH GEX data (last update: ${state.gexLevelsReceivedAt ? new Date(state.gexLevelsReceivedAt).toISOString() : 'never'})`);
          return;
        }
      }
    }

    // Get GEX levels from cached data (for strategies that need them)
    const gexLevels = state.gexLevels;
    const reqs = getDataRequirements(runner.name);
    if (reqs?.gex !== false && !gexLevels) {
      logger.debug(`No GEX levels for ${state.product}, skipping ${runner.name}`);
      return;
    }

    // Gate on short-DTE IV readiness
    if (reqs?.shortDTEIV === true && (!this.shortDTEIVProvider || !this.shortDTEIVProvider.isReady())) {
      logger.debug(`Short-DTE IV not ready for ${runner.name}, skipping`);
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

    if (signal && !inSession) {
      logger.warn(`⏰ [${runner.name}] Signal BLOCKED by session filter: ${signal.side} @ ${signal.price} (server hour outside ${this.sessionStart}-${this.sessionEnd} EST window)`);
    }

    if (signal && inSession) {
      // Add webhook format fields
      signal.webhook_type = 'trade_signal';

      // Always use the per-product trading symbol from strategy-config.json
      // (strategy factory sets config.TRADING_SYMBOL which is the global NQ symbol)
      signal.symbol = state.tradingSymbol;

      // Handle sameCandleFill signals in live mode: backtest uses candle.open
      // with 1s replay, but in live mode we enter at current price (candle.close)
      if (signal.sameCandleFill) {
        const livePrice = candle.close;
        const stopDist = runner.strategy.params?.stopPoints || 30;
        const tpDist = runner.strategy.params?.targetPoints || 30;
        signal.action = 'place_market';
        signal.price = livePrice;
        signal.entryPrice = livePrice;
        signal.stop_loss = signal.side === 'buy' ? livePrice - stopDist : livePrice + stopDist;
        signal.take_profit = signal.side === 'buy' ? livePrice + tpDist : livePrice - tpDist;
        signal.stopLoss = signal.stop_loss;
        signal.takeProfit = signal.take_profit;
        delete signal.sameCandleFill;
        logger.info(`Converted sameCandleFill → market order @ ${livePrice} (candle.open was ${candle.open})`);
      }

      // Add breakeven parameters if supported
      if (runner.supportsBreakeven && runner.strategy.params.breakevenStop) {
        signal.breakeven_trigger = runner.strategy.params.breakevenTrigger;
        signal.breakeven_offset = runner.strategy.params.breakevenOffset;
      }

      // Store signal metadata for use when position closes
      state.pendingSignalMetadata = signal.metadata || {};
      state.pendingMaxHoldBars = signal.maxHoldBars || 0;
      state.pendingTimeBasedConfig = signal.timeBasedConfig || null;
      state.pendingTimeBasedTrailing = signal.timeBasedTrailing || false;

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

    // If we already have a position for this strategy, update stop order ID if provided
    if (message.stopOrderId || message.orderStrategyId) {
      const strategy = message.strategy;
      for (const [product, state] of this.products) {
        if (state.inPosition && state.currentPosition?.strategy === strategy) {
          if (message.stopOrderId && !state.currentPosition.stopOrderId) {
            state.currentPosition.stopOrderId = message.stopOrderId;
            logger.info(`Updated stopOrderId for ${product}: ${message.stopOrderId}`);
          }
          if (message.orderStrategyId && !state.currentPosition.orderStrategyId) {
            state.currentPosition.orderStrategyId = message.orderStrategyId;
            logger.info(`Updated orderStrategyId for ${product}: ${message.orderStrategyId}`);
          }
          return;
        }
      }
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
            quantity: Math.abs(message.netPos) || 1,
            strategy: strategy,
            orderStrategyId: message.orderStrategyId || message.order_strategy_id,
            stopOrderId: message.stopOrderId || message.stop_order_id,
            metadata: state.pendingSignalMetadata || {}
          };
          state.pendingSignalMetadata = null;

          // Initialize maxHoldBars tracking
          state.positionBarsInTrade = 0;
          state.positionMaxHoldBars = state.pendingMaxHoldBars || 0;
          state.pendingMaxHoldBars = 0;

          logger.info(`Position opened for ${product} (${strategy}): ${state.currentPosition.side} @ ${state.currentPosition.entryPrice}${state.positionMaxHoldBars > 0 ? ` [maxHold: ${state.positionMaxHoldBars} bars]` : ''}`);

          // Initialize GF tracking
          if (state.gfEarlyExitConfig.enabled) {
            this.initializeGFTracking(state);
          }

          // Initialize time-based trailing (per-signal config takes priority over global)
          const signalHasTimeBased = state.pendingTimeBasedTrailing && state.pendingTimeBasedConfig;
          if (signalHasTimeBased || state.timeBasedTrailingConfig.enabled) {
            this.initializeTimeBasedTrailing(state);
            if (signalHasTimeBased) {
              state.timeBasedTrailingState.signalRules = state.pendingTimeBasedConfig.rules || [];
            }
          }
          state.pendingTimeBasedConfig = null;
          state.pendingTimeBasedTrailing = false;

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

        // Notify strategy of position close (for P&L tracking, loss limits, etc.)
        if (state.currentPosition) {
          const entryPrice = state.currentPosition.entryPrice;
          const exitPrice = message.exitPrice || message.price || message.currentPrice;
          const side = state.currentPosition.side;

          if (entryPrice && exitPrice) {
            const pnl = side === 'long' || side === 'buy'
              ? exitPrice - entryPrice
              : entryPrice - exitPrice;

            for (const [, runner] of state.strategies) {
              if (runner.strategyConstant === strategy && typeof runner.strategy.onPositionClosed === 'function') {
                runner.strategy.onPositionClosed({
                  entryPrice,
                  exitPrice,
                  pnl,
                  side,
                  timestamp: message.timestamp || new Date().toISOString(),
                  metadata: { ...(state.currentPosition.metadata || {}), ...(message.metadata || {}) }
                });
              }
            }
          }
        }

        state.inPosition = false;
        state.currentPosition = null;
        state.positionStrategy = null;
        state.gfTrackingState = null;
        state.timeBasedTrailingState = null;
        state.positionBarsInTrade = 0;
        state.positionMaxHoldBars = 0;

        // Cooldown is NOT reset on position close — it continues from signal time,
        // matching backtest behavior (30min cooldown from signal generation)

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

    // Try matching by orderId first
    if (orderId) {
      for (const [, state] of this.products) {
        for (const [, runner] of state.strategies) {
          if (runner.pendingOrders.has(orderId)) {
            runner.pendingOrders.delete(orderId);
            logger.info(`Cleared pending order ${orderId} for ${runner.name} (matched by orderId)`);
            return;
          }
        }
      }
    }

    // Fallback: match by strategy name (cancel_limit events may lack orderId)
    if (message.strategy) {
      for (const [, state] of this.products) {
        for (const [, runner] of state.strategies) {
          if (runner.strategyConstant === message.strategy && runner.pendingOrders.size > 0) {
            const count = runner.pendingOrders.size;
            runner.pendingOrders.clear();
            logger.info(`Cleared ${count} pending orders for ${runner.name} (matched by strategy: ${message.strategy})`);
            return;
          }
        }
      }
    }
  }

  async checkOrderTimeouts(runner) {
    if (runner.pendingOrders.size === 0) return;

    // If strategy is disabled, clear stale pending orders silently
    if (!runner.enabled) {
      const count = runner.pendingOrders.size;
      runner.pendingOrders.clear();
      logger.info(`Cleared ${count} stale pending orders for disabled strategy ${runner.name}`);
      return;
    }

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
      quantity: state.currentPosition.quantity || 1,
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
    if (!state.inPosition || !state.timeBasedTrailingState) return;

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

    // Use per-signal rules if available, otherwise global config
    const rules = tbState.signalRules || state.timeBasedTrailingConfig.rules;

    // Check rules for new activations
    for (let i = 0; i < rules.length; i++) {
      if (tbState.rulesTriggered.includes(i)) continue;
      const rule = rules[i];

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

    // Continuous trailing: keep moving stop behind peak for active trail rules
    if (tbState.activeRuleIndex >= 0) {
      const activeRule = rules[tbState.activeRuleIndex];
      if (activeRule && activeRule.trailDistance) {
        const continuousStop = isLong
          ? tbState.peakPrice - activeRule.trailDistance
          : tbState.peakPrice + activeRule.trailDistance;
        const shouldUpdate = tbState.currentStopPrice === null ||
          (isLong ? continuousStop > tbState.currentStopPrice : continuousStop < tbState.currentStopPrice);
        if (shouldUpdate) {
          tbState.currentStopPrice = continuousStop;
          this.sendTimeBasedTrailingModification(state, continuousStop, activeRule, tbState.activeRuleIndex);
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
      quantity: state.currentPosition.quantity || 1,
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
        const response = await fetch(`${config.TRADOVATE_SERVICE_URL}/positions/${accountId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const positions = await response.json();

        for (const [product, state] of this.products) {
          const openPos = positions.find(p => p.netPos !== 0 && p.symbol && p.symbol.includes(product));
          if (openPos) {
            // Check orchestrator's Redis state for position ownership
            const owner = await this._getOrchestratorPositionOwner(product);
            const matchedRunner = owner
              ? Array.from(state.strategies.values()).find(r => r.strategyConstant === owner)
              : null;
            if (matchedRunner) {
              state.inPosition = true;
              state.positionStrategy = owner;
              state.currentPosition = {
                symbol: openPos.symbol || `Contract ${openPos.contractId}`,
                side: openPos.netPos > 0 ? 'long' : 'short',
                entryPrice: openPos.netPrice || 0,
                entryTime: openPos.timestamp || new Date().toISOString(),
                strategy: owner,
                quantity: Math.abs(openPos.netPos)
              };
              logger.info(`Found ${product} position: ${state.currentPosition.side} @ ${state.currentPosition.entryPrice} (owned by ${owner})`);
            } else {
              logger.info(`Found ${product} position (${openPos.symbol} @ ${openPos.netPrice}) owned by ${owner || 'unknown/manual'} — NOT claiming`);
            }
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

  /**
   * Read the trade orchestrator's authoritative strategy-to-position mapping
   * from Redis. Returns the strategy source (e.g. 'GEX_SCALP', 'AI_TRADER')
   * for the given underlying, or null if no position tracked / unknown / manual.
   */
  async _getOrchestratorPositionOwner(underlying) {
    try {
      const data = await messageBus.publisher.get('multi-strategy:state');
      if (!data) return null;
      const parsed = JSON.parse(data);
      if (parsed.version !== '2.0' || !parsed.positions) return null;
      const posInfo = parsed.positions[underlying];
      if (!posInfo || !posInfo.source || posInfo.source === 'UNKNOWN') return null;
      return posInfo.source;
    } catch (e) {
      logger.debug(`[RECONCILE] Could not read orchestrator state: ${e.message}`);
      return null;
    }
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
      const response = await fetch(`${config.TRADOVATE_SERVICE_URL}/positions/${accountId}`);
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
          // Check orchestrator's Redis state for position ownership
          const owner = await this._getOrchestratorPositionOwner(product);
          const matchedRunner = owner
            ? Array.from(state.strategies.values()).find(r => r.strategyConstant === owner)
            : null;
          if (matchedRunner) {
            state.inPosition = true;
            state.positionStrategy = owner;
            state.currentPosition = {
              symbol: openPos.symbol,
              side: openPos.netPos > 0 ? 'long' : 'short',
              entryPrice: openPos.netPrice || 0,
              entryTime: openPos.timestamp || new Date().toISOString(),
              strategy: owner,
              quantity: Math.abs(openPos.netPos)
            };
            state.reconciliationConfirmed = false;
            logger.warn(`[RECONCILE] Missed ${product} position open: ${state.currentPosition.side} @ ${state.currentPosition.entryPrice} (owned by ${owner})`);
          } else {
            // Safety: block all signals for this product when broker has ANY position,
            // regardless of ownership. Prevents duplicate signals when orchestrator
            // state is stale or position was opened manually.
            state.inPosition = true;
            state.positionStrategy = owner || 'EXTERNAL';
            state.currentPosition = {
              symbol: openPos.symbol,
              side: openPos.netPos > 0 ? 'long' : 'short',
              entryPrice: openPos.netPrice || 0,
              entryTime: openPos.timestamp || new Date().toISOString(),
              strategy: owner || 'EXTERNAL',
              quantity: Math.abs(openPos.netPos)
            };
            state.reconciliationConfirmed = false;
            logger.warn(`[RECONCILE] ${product} position (${openPos.symbol}) owned by ${owner || 'unknown/manual'} — claiming as safety measure to block duplicate signals`);
          }
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

  /**
   * Reconcile pending orders against broker state.
   * Uses strategy-name matching (not order IDs) to avoid OrderStrategy vs child order ID mismatch.
   */
  async reconcilePendingOrders() {
    // Skip if no runner has pending orders
    let totalPending = 0;
    for (const [, state] of this.products) {
      for (const [, runner] of state.strategies) {
        totalPending += runner.pendingOrders.size;
      }
    }
    if (totalPending === 0) return;

    const accountId = config.TRADOVATE_ACCOUNT_ID;
    if (!accountId) return;

    try {
      // Fetch working orders and strategy mappings from tradovate-service
      const [ordersRes, mappingsRes] = await Promise.all([
        fetch(`${config.TRADOVATE_SERVICE_URL}/orders/${accountId}`),
        fetch(`${config.TRADOVATE_SERVICE_URL}/api/order-strategy-mappings`)
      ]);

      if (!ordersRes.ok || !mappingsRes.ok) return;

      const orders = await ordersRes.json();
      const mappingsData = await mappingsRes.json();

      // Build set of strategy names that still have working orders at the broker
      const strategiesWithWorkingOrders = new Set();
      const workingStatuses = ['Working', 'Accepted', 'PendingNew'];
      for (const order of orders) {
        if (workingStatuses.includes(order.ordStatus)) {
          const mapping = mappingsData.mappings?.find(m => String(m.orderId) === String(order.id));
          if (mapping?.strategy) {
            strategiesWithWorkingOrders.add(mapping.strategy);
          }
        }
      }

      // Clear pending orders for runners whose strategy has no working orders at broker
      for (const [, state] of this.products) {
        for (const [, runner] of state.strategies) {
          if (runner.pendingOrders.size > 0 && !strategiesWithWorkingOrders.has(runner.strategyConstant)) {
            const count = runner.pendingOrders.size;
            runner.pendingOrders.clear();
            logger.warn(`[RECONCILE] Cleared ${count} stale pending orders for ${runner.name} — no working orders at broker`);
          }
        }
      }
    } catch (error) {
      logger.debug(`[RECONCILE] Pending order reconciliation skipped: ${error.message}`);
    }
  }

  // === Session & Lifecycle ===

  isInTradingSession() {
    const now = new Date();
    const hour = parseInt(now.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false
    }));
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
            dataReady: runner.dataReady,
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

  async enableStrategy(strategyName) {
    for (const [, state] of this.products) {
      const runner = state.strategies.get(strategyName)
        || [...state.strategies.values()].find(r => r.strategyConstant === strategyName);
      if (runner) {
        if (runner.hidden) {
          logger.warn(`Cannot enable hidden strategy: ${strategyName}`);
          return false;
        }
        runner.enable();
        logger.info(`Enabled strategy: ${strategyName}`);
        await this.persistStrategyEnabledState();
        return true;
      }
    }
    return false;
  }

  async disableStrategy(strategyName) {
    for (const [, state] of this.products) {
      const runner = state.strategies.get(strategyName)
        || [...state.strategies.values()].find(r => r.strategyConstant === strategyName);
      if (runner) {
        runner.disable();
        const pendingCount = runner.pendingOrders.size;
        runner.pendingOrders.clear();
        logger.info(`Disabled strategy: ${strategyName}${pendingCount > 0 ? ` (cleared ${pendingCount} pending orders)` : ''}`);
        await this.persistStrategyEnabledState();
        return true;
      }
    }
    return false;
  }

  /**
   * Persist strategy enabled/disabled state to Redis.
   * On restart, this state is loaded and applied over the defaults from strategy-config.json.
   */
  async persistStrategyEnabledState() {
    try {
      const state = {};
      for (const [product, productState] of this.products) {
        for (const [name, runner] of productState.strategies) {
          state[`${product}:${name}`] = runner.enabled;
        }
      }
      await messageBus.publisher.set('strategy:enabled-state', JSON.stringify(state));
      logger.info('Strategy enabled state persisted to Redis');
    } catch (err) {
      logger.warn(`Failed to persist strategy enabled state: ${err.message}`);
    }
  }

  /**
   * Load persisted strategy enabled/disabled state from Redis and apply it.
   * Called after initializeProducts() to override defaults with user's last known state.
   */
  async loadStrategyEnabledState() {
    const maxRetries = 3;
    const retryDelayMs = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const data = await messageBus.publisher.get('strategy:enabled-state');
        if (!data) {
          logger.info('No persisted strategy enabled state found in Redis, using defaults');
          return;
        }
        const state = JSON.parse(data);
        let applied = 0;
        for (const [product, productState] of this.products) {
          for (const [name, runner] of productState.strategies) {
            const key = `${product}:${name}`;
            if (key in state) {
              const wasEnabled = runner.enabled;
              runner.enabled = state[key];
              if (wasEnabled !== runner.enabled) {
                logger.info(`  ${product}:${name} ${runner.enabled ? 'enabled' : 'disabled'} (restored from Redis)`);
              }
              applied++;
            }
          }
        }
        logger.info(`Restored strategy enabled state from Redis (${applied} strategies)`);
        return;
      } catch (err) {
        if (attempt < maxRetries) {
          logger.warn(`Failed to load strategy enabled state (attempt ${attempt}/${maxRetries}): ${err.message} — retrying in ${retryDelayMs}ms`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        } else {
          logger.error(`Failed to load strategy enabled state after ${maxRetries} attempts: ${err.message} — using config defaults (strategies may be in wrong enabled state)`);
        }
      }
    }
  }

  /**
   * Get all strategies status for HTTP endpoint
   */
  getStrategiesStatus() {
    const now = new Date();
    const result = [];

    for (const [product, state] of this.products) {
      for (const [name, runner] of state.strategies) {
        if (runner.hidden) continue;
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
        const reqs = getDataRequirements(name);
        const needsGex = !reqs || reqs.gex !== false;

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

        const gexOk = !needsGex || !!gexLevels;
        const isReady = runner.enabled && runner.dataReady && inAllowedSession && gexOk
          && !(state.inPosition && state.positionStrategy !== runner.strategyConstant)
          && !pastCutoff;
        const blockers = [
          !runner.enabled ? 'Strategy disabled' : null,
          !runner.dataReady ? 'Data not ready (waiting for history)' : null,
          !inAllowedSession ? 'Outside allowed session' : null,
          needsGex && !gexLevels ? 'No GEX levels' : null,
          state.inPosition ? `Position held by ${state.positionStrategy}` : null,
          pastCutoff ? `Past entry cutoff (${strategy.params.entryCutoffHour}:${String(strategy.params.entryCutoffMinute).padStart(2, '0')} ET)` : null,
          inAvoidHour ? `SHORT restricted (hour ${strategy.params.avoidHours.join(', ')} — longs OK)` : null,
        ].filter(Boolean);
        const conditionsMet = [
          runner.enabled ? 'Strategy enabled' : null,
          runner.dataReady ? 'Data ready' : null,
          inAllowedSession ? 'In allowed session' : null,
          needsGex ? (gexLevels ? 'GEX levels loaded' : null) : null,
          !state.inPosition ? 'No active position' : null,
          !pastCutoff ? 'Before entry cutoff' : null,
          !inAvoidHour || !strategy?.params?.avoidHours?.length ? null : 'Outside restricted hours',
        ].filter(Boolean);

        result.push({
          product,
          name,
          constant: runner.strategyConstant,
          enabled: runner.enabled,
          data_ready: runner.dataReady,
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
          product_position: state.inPosition ? {
            in_position: true,
            strategy: state.positionStrategy,
            side: state.currentPosition?.side || null,
            symbol: state.currentPosition?.symbol || state.tradingSymbol,
            entry_price: state.currentPosition?.entryPrice || null,
            quantity: state.currentPosition?.quantity || null,
            is_own: state.positionStrategy === runner.strategyConstant
          } : { in_position: false },
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

        // Position + pending order reconciliation
        const now = Date.now();
        if (now - lastReconciliationTime >= reconciliationIntervalMs) {
          await this.reconcilePositionState();
          await this.reconcilePendingOrders();
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
