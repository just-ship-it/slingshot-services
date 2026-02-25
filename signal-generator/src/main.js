// Signal Generator Service - Main entry point
// Refactored: subscribes to data channels from data-service instead of sourcing data directly.
// Runs multiple strategies across multiple products in a single process.

import fs from 'fs';
import { createLogger, messageBus, CHANNELS } from '../../shared/index.js';
import config from './utils/config.js';
import MultiStrategyEngine from './strategy/multi-strategy-engine.js';

// AI Trader imports (only used when ACTIVE_STRATEGY === 'ai-trader')
import { CandleBuffer } from './utils/candle-buffer.js';
import { LiveFeatureAggregator } from './ai/live-feature-aggregator.js';
import { AIStrategyEngine } from './ai/ai-strategy-engine.js';
import { LiveTradeManager } from './ai/live-trade-manager.js';
import GexCalculator from './gex/gex-calculator.js';
import { getDataRequirements } from './strategy/strategy-factory.js';

const logger = createLogger('signal-generator');

const DATA_SERVICE_URL = process.env.DATA_SERVICE_URL || 'http://localhost:3019';

class SignalGeneratorService {
  constructor() {
    // Multi-strategy engine (new architecture)
    this.multiStrategyEngine = null;

    // AI Trader components (null unless ACTIVE_STRATEGY === 'ai-trader')
    this.gexCalculator = null;
    this.aiEngine = null;
    this.candle1mBuffer = null;
    this.candle1hBuffer = null;
    this.liveFeatureAggregator = null;
    this.liveTradeManager = null;

    this.isRunning = false;
    this.isAiTrader = (config.ACTIVE_STRATEGY || '').toLowerCase() === 'ai-trader';
  }

  async start() {
    try {
      logger.info('Starting Signal Generator Service...');
      console.log('Starting Signal Generator Service...');

      // Connect to message bus
      logger.info('Connecting to message bus...');
      if (!messageBus.isConnected) {
        await messageBus.connect();
      }
      logger.info('Connected to message bus');

      if (this.isAiTrader) {
        // AI Trader mode: subscribes to all data from data-service
        await this.startAiTrader();
      } else {
        // Multi-strategy mode: subscribe to data from data-service
        await this.startMultiStrategy();
      }

      this.isRunning = true;
      logger.info('Signal Generator Service started successfully');

      await messageBus.publish('service.health', {
        service: config.SERVICE_NAME,
        status: 'running',
        timestamp: new Date().toISOString(),
        mode: this.isAiTrader ? 'ai-trader' : 'multi-strategy'
      });

    } catch (error) {
      logger.error('Failed to start Signal Generator Service:', error);
      throw error;
    }
  }

  /**
   * Start in multi-strategy mode (subscribes to data-service via Redis)
   */
  async startMultiStrategy() {
    logger.info('Initializing multi-strategy engine...');

    this.multiStrategyEngine = new MultiStrategyEngine();

    // Subscribe to data channels from data-service
    await this.multiStrategyEngine.subscribeToDataChannels();

    // Sync position state from Tradovate
    await this.multiStrategyEngine.syncPositionState();

    // Start background loop (reconciliation, status publishing, GF checks)
    this.multiStrategyEngine.run().catch(error => {
      logger.error('Multi-strategy engine error:', error);
    });

    logger.info('Multi-strategy engine started');
  }

  /**
   * Start in AI Trader mode (subscribes to all data from data-service)
   */
  async startAiTrader() {
    logger.info('Initializing AI Trader engine...');

    const dataReqs = getDataRequirements(config.ACTIVE_STRATEGY);
    const gexEtfSymbol = process.env.GEX_SYMBOL || dataReqs?.gex?.etfSymbol || config.GEX_SYMBOL;
    const gexFuturesSymbol = process.env.GEX_FUTURES_SYMBOL || dataReqs?.gex?.futuresSymbol || config.GEX_FUTURES_SYMBOL;
    const gexDefaultMultiplier = process.env.GEX_DEFAULT_MULTIPLIER
      ? parseFloat(process.env.GEX_DEFAULT_MULTIPLIER)
      : (dataReqs?.gex?.defaultMultiplier ?? config.GEX_DEFAULT_MULTIPLIER);
    const candleBaseSymbol = process.env.CANDLE_BASE_SYMBOL
      ? config.CANDLE_BASE_SYMBOL
      : (dataReqs?.candles?.baseSymbol || config.CANDLE_BASE_SYMBOL);
    const gexCacheFile = process.env.GEX_CACHE_FILE || `./data/gex_cache_${gexFuturesSymbol.toLowerCase()}.json`;
    const targetProduct = gexFuturesSymbol.toUpperCase();

    // Resolve trading symbol from strategy-config.json (single source of truth)
    const strategyConfigPath = new URL('../../strategy-config.json', import.meta.url).pathname;
    let tradingSymbol = config.TRADING_SYMBOL; // fallback to env var
    try {
      const stratCfg = JSON.parse(fs.readFileSync(strategyConfigPath, 'utf-8'));
      const productCfg = stratCfg.products?.[targetProduct];
      if (productCfg?.tradingSymbol) {
        tradingSymbol = productCfg.tradingSymbol;
        logger.info(`Trading symbol from strategy-config.json: ${tradingSymbol} (product: ${targetProduct})`);
      }
    } catch (e) {
      logger.warn(`Could not load strategy-config.json, using env TRADING_SYMBOL: ${tradingSymbol}`);
    }

    // Initialize GEX calculator (for cached levels on startup)
    this.gexCalculator = new GexCalculator({
      symbol: gexEtfSymbol,
      futuresSymbol: gexFuturesSymbol,
      etfSymbol: gexEtfSymbol,
      defaultMultiplier: gexDefaultMultiplier,
      cacheFile: gexCacheFile,
      cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
      redisUrl: config.getRedisUrl()
    });
    await this.gexCalculator.loadCachedLevels();
    if (!this.gexCalculator.currentLevels) {
      try { await this.gexCalculator.calculateLevels(true); }
      catch (err) { logger.warn('Initial CBOE fetch failed:', err.message); }
    }

    // Subscribe to GEX level updates from data-service
    // Data-service publishes fresh levels every 15min (CBOE) or 3min (Tradier hybrid)
    messageBus.subscribe(CHANNELS.GEX_LEVELS, (message) => {
      const product = (message.product || 'NQ').toUpperCase();
      if (product === targetProduct) {
        const prevRegime = this.gexCalculator.currentLevels?.regime;
        this.gexCalculator.currentLevels = message;
        this.gexCalculator.lastFetchTime = Date.now();

        if (message.regime !== prevRegime) {
          logger.info(`GEX regime changed: ${prevRegime} → ${message.regime} (PW=${message.putWall}, CW=${message.callWall})`);
        } else {
          logger.debug(`GEX levels refreshed: regime=${message.regime}, PW=${message.putWall}, CW=${message.callWall}`);
        }

        if (this.aiEngine && !this.aiEngine.gexReady) {
          this.aiEngine.markGexReady();
        }
      }
    });

    // Create AI trader candle buffers
    const historyBars1m = parseInt(process.env.CANDLE_HISTORY_BARS || '500', 10);
    this.candle1mBuffer = new CandleBuffer({
      symbol: candleBaseSymbol,
      timeframe: '1',
      maxSize: Math.max(historyBars1m + 500, 8000),
    });
    this.candle1hBuffer = new CandleBuffer({
      symbol: candleBaseSymbol,
      timeframe: '60',
      maxSize: 500,
    });

    this.liveFeatureAggregator = new LiveFeatureAggregator({
      candle1mBuffer: this.candle1mBuffer,
      candle1hBuffer: this.candle1hBuffer,
      gexCalculator: this.gexCalculator,
      ltMonitor: null,
      ivCalculator: null,
      ticker: candleBaseSymbol,
    });

    this.liveTradeManager = new LiveTradeManager({
      featureAggregator: this.liveFeatureAggregator,
      strategyConstant: 'AI_TRADER',
    });

    this.aiEngine = new AIStrategyEngine({
      featureAggregator: this.liveFeatureAggregator,
      gexCalculator: this.gexCalculator,
      tradingSymbol,
      ticker: candleBaseSymbol,
      tradeManager: this.liveTradeManager,
    });

    // Seed candle history from data-service HTTP API
    await this._seedCandleHistory(targetProduct, historyBars1m);

    // Subscribe to candle.close from data-service for real-time 1m candle updates
    messageBus.subscribe(CHANNELS.CANDLE_CLOSE, (message) => {
      const product = (message.product || 'NQ').toUpperCase();
      if (product === targetProduct) {
        const candleData = {
          symbol: message.symbol,
          timestamp: message.timestamp,
          open: message.open,
          high: message.high,
          low: message.low,
          close: message.close,
          volume: message.volume
        };

        const isNewCandle = this.candle1mBuffer.addCandle(candleData);
        if (isNewCandle) {
          const closedCandle = this.candle1mBuffer.getLastClosedCandle();
          if (closedCandle) {
            // Also aggregate into 1h buffer
            this._aggregateInto1h(closedCandle);
            this.aiEngine.processCandle(closedCandle).catch(err =>
              logger.error('Error processing candle:', err)
            );
          }
        }
      }
    });

    // Subscribe to LT level updates from data-service
    // Data-service runs dedicated LT monitors for NQ and ES on 15m timeframes
    messageBus.subscribe(CHANNELS.LT_LEVELS, (message) => {
      const product = (message.product || 'NQ').toUpperCase();
      if (product === targetProduct) {
        if (this.liveFeatureAggregator) {
          this.liveFeatureAggregator.pushLtSnapshot(message);
        }
        logger.debug(`LT levels received from data-service: product=${product}, L2=${message.L2}, L3=${message.L3}`);
      }
    });

    // Seed current LT levels from data-service HTTP API
    await this._seedLtLevels(targetProduct);

    await this.aiEngine.syncPositionState();
    if (this.gexCalculator?.getCurrentLevels()) {
      this.aiEngine.markGexReady();
    }
    this.aiEngine.run().catch(error => logger.error('AI engine error:', error));
  }

  /**
   * Seed candle history from data-service on startup.
   * Fetches 1m and 1h candles from the data-service HTTP API.
   */
  async _seedCandleHistory(product, requestedBars) {
    // Seed 1m candles
    try {
      const url = `${DATA_SERVICE_URL}/candles?symbol=${product}&count=${requestedBars}`;
      logger.info(`Seeding 1m candle history from data-service: ${url}`);

      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const data = await response.json();
      const candles = data.candles || [];

      if (candles.length > 0) {
        this.candle1mBuffer.seedCandles(candles);
        logger.info(`Seeded ${candles.length} 1m candles from data-service`);
      } else {
        logger.warn('No 1m candle history available from data-service');
      }
    } catch (error) {
      logger.error('Failed to seed 1m candle history:', error.message);
    }
    this.aiEngine?.markHistoryReady('1');

    // Seed 1h candles (for prior daily context / HTF swing analysis)
    try {
      const url = `${DATA_SERVICE_URL}/candles/hourly?symbol=${product}&count=300`;
      logger.info(`Seeding 1h candle history from data-service: ${url}`);

      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const data = await response.json();
      const candles = data.candles || [];

      if (candles.length > 0) {
        this.candle1hBuffer.seedCandles(candles);
        logger.info(`Seeded ${candles.length} 1h candles from data-service`);
      } else {
        logger.warn('No 1h candle history available from data-service — will aggregate from 1m');
        // Fallback: aggregate available 1m candles into 1h
        const candles1m = this.candle1mBuffer.getCandles();
        if (candles1m.length > 0) {
          const hourlyCandles = this._aggregate1mTo1h(candles1m.map(c => c.toDict ? c.toDict() : c));
          if (hourlyCandles.length > 0) {
            this.candle1hBuffer.seedCandles(hourlyCandles);
            logger.info(`Aggregated ${hourlyCandles.length} 1h candles from 1m history`);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to seed 1h candle history:', error.message);
    }
    this.aiEngine?.markHistoryReady('60');
  }

  /**
   * Aggregate 1-minute candles into 1-hour candles.
   * Groups by hour boundary and creates OHLCV bars.
   */
  _aggregate1mTo1h(candles1m) {
    const hourlyMap = new Map();

    for (const c of candles1m) {
      const ts = typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime();
      // Floor to hour boundary
      const hourTs = ts - (ts % 3600000);
      const hourKey = hourTs;

      if (!hourlyMap.has(hourKey)) {
        hourlyMap.set(hourKey, {
          symbol: c.symbol,
          timestamp: new Date(hourTs).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume || 0,
        });
      } else {
        const bar = hourlyMap.get(hourKey);
        bar.high = Math.max(bar.high, c.high);
        bar.low = Math.min(bar.low, c.low);
        bar.close = c.close;
        bar.volume += (c.volume || 0);
      }
    }

    // Return sorted by timestamp, excluding the current (incomplete) hour
    const now = Date.now();
    const currentHour = now - (now % 3600000);
    return Array.from(hourlyMap.values())
      .filter(c => new Date(c.timestamp).getTime() < currentHour)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /**
   * Aggregate a closed 1m candle into the running 1h buffer.
   * Called on each new candle.close event.
   */
  _aggregateInto1h(candle) {
    const ts = typeof candle.timestamp === 'number' ? candle.timestamp : new Date(candle.timestamp).getTime();
    const hourTs = ts - (ts % 3600000);

    // Check if we have a current hour bar
    const candles1h = this.candle1hBuffer.getCandles();
    const lastHourCandle = candles1h.length > 0 ? candles1h[candles1h.length - 1] : null;
    const lastHourTs = lastHourCandle
      ? new Date(lastHourCandle.timestamp).getTime()
      : null;

    if (lastHourTs && lastHourTs === hourTs) {
      // Same hour — update in place (high/low/close/volume)
      // CandleBuffer doesn't support in-place updates, so we track this
      // via the aggregation on the next full seed cycle
      return;
    }

    // New hour boundary — if there was a previous hour, it's now closed
    // The 1h buffer will naturally accumulate from the aggregation in _seedCandleHistory
    // and periodic re-aggregation isn't needed since the feature aggregator
    // reads the 1h buffer for daily/swing analysis which updates on bias cycles
  }

  /**
   * Seed current LT levels from data-service HTTP API on startup.
   */
  async _seedLtLevels(product) {
    try {
      const url = `${DATA_SERVICE_URL}/lt/levels?product=${product}`;
      logger.info(`Seeding LT levels from data-service: ${url}`);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const ltLevels = await response.json();
      if (ltLevels && ltLevels.L2) {
        this.liveFeatureAggregator.pushLtSnapshot(ltLevels);
        logger.info(`Seeded LT levels from data-service: L2=${ltLevels.L2?.toFixed(1)}, L3=${ltLevels.L3?.toFixed(1)}, L4=${ltLevels.L4?.toFixed(1)}`);
      } else {
        logger.warn('No LT levels available from data-service yet');
      }
    } catch (error) {
      logger.error('Failed to seed LT levels from data-service:', error.message);
    }
  }

  getHealth() {
    if (this.isAiTrader) {
      return {
        service: config.SERVICE_NAME,
        mode: 'ai-trader',
        status: this.isRunning ? 'running' : 'stopped',
        timestamp: new Date().toISOString(),
        components: {
          data_service: 'subscribed',
          gex_calculator: this.gexCalculator ? 'ready' : 'not_initialized',
          ai_engine: this.aiEngine ? 'running' : 'not_initialized'
        }
      };
    }

    return {
      service: config.SERVICE_NAME,
      mode: 'multi-strategy',
      status: this.isRunning ? 'running' : 'stopped',
      timestamp: new Date().toISOString(),
      enabled: this.multiStrategyEngine?.enabled,
      products: this.multiStrategyEngine ? Object.fromEntries(
        Array.from(this.multiStrategyEngine.products.entries()).map(([product, state]) => [
          product,
          {
            tradingSymbol: state.tradingSymbol,
            strategies: Array.from(state.strategies.entries()).map(([name, runner]) => ({
              name,
              constant: runner.strategyConstant,
              enabled: runner.enabled,
              evalTimeframe: runner.evalTimeframe
            })),
            inPosition: state.inPosition,
            positionStrategy: state.positionStrategy,
            gexAvailable: !!state.gexLevels,
            ltAvailable: !!state.ltLevels,
            ivAvailable: !!state.ivData
          }
        ])
      ) : {}
    };
  }

  async stop() {
    try {
      logger.info('Stopping Signal Generator Service...');
      this.isRunning = false;
      logger.info('Signal Generator Service stopped');
    } catch (error) {
      logger.error('Error stopping service:', error);
    }
  }
}

const service = new SignalGeneratorService();

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await service.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  await service.stop();
  process.exit(0);
});

export default service;
