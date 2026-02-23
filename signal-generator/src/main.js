// Signal Generator Service - Main entry point
import { createLogger, messageBus } from '../../shared/index.js';
import config from './utils/config.js';
import TradingViewClient from './websocket/tradingview-client.js';
import LTMonitor from './websocket/lt-monitor.js';
import GexCalculator from './gex/gex-calculator.js';
import TradierExposureService from './tradier/tradier-exposure-service.js';
import HybridGexCalculator from './gex/hybrid-gex-calculator.js';
import StrategyEngine from './strategy/engine.js';
import { getDataRequirements } from './strategy/strategy-factory.js';
import { getBestAvailableToken, cacheTokenInRedis, getTokenTTL } from './utils/tradingview-auth.js';

// AI Trader imports (only used when ACTIVE_STRATEGY === 'ai-trader')
import { CandleBuffer } from './utils/candle-buffer.js';
import { LiveFeatureAggregator } from './ai/live-feature-aggregator.js';
import { AIStrategyEngine } from './ai/ai-strategy-engine.js';
import { LiveTradeManager } from './ai/live-trade-manager.js';

const logger = createLogger('signal-generator');

class SignalGeneratorService {
  constructor() {
    this.tradingViewClient = null;
    this.ltMonitor = null;
    this.gexCalculator = null; // Keep for backward compatibility
    this.hybridGexCalculator = null;
    this.tradierExposureService = null;
    this.ivSkewCalculator = null;  // Direct reference for API endpoint
    this.strategyEngine = null;
    this.isRunning = false;

    // AI Trader components (null unless ACTIVE_STRATEGY === 'ai-trader')
    this.aiEngine = null;
    this.candle1mBuffer = null;
    this.candle1hBuffer = null;
    this.liveFeatureAggregator = null;
    this.liveTradeManager = null;
    this.isAiTrader = (config.ACTIVE_STRATEGY || '').toLowerCase() === 'ai-trader';
  }

  async start() {
    try {
      logger.info('Starting Signal Generator Service...');
      console.log('🚀 CONSOLE: Starting Signal Generator Service...');

      // --- Resolve data requirements from strategy ---
      const dataReqs = getDataRequirements(config.ACTIVE_STRATEGY);

      // Strategy requirements override config defaults; env vars override everything
      const gexEtfSymbol = process.env.GEX_SYMBOL || dataReqs?.gex?.etfSymbol || config.GEX_SYMBOL;
      const gexFuturesSymbol = process.env.GEX_FUTURES_SYMBOL || dataReqs?.gex?.futuresSymbol || config.GEX_FUTURES_SYMBOL;
      const gexDefaultMultiplier = process.env.GEX_DEFAULT_MULTIPLIER
        ? parseFloat(process.env.GEX_DEFAULT_MULTIPLIER)
        : (dataReqs?.gex?.defaultMultiplier ?? config.GEX_DEFAULT_MULTIPLIER);
      const ohlcvSymbols = process.env.OHLCV_SYMBOLS
        ? config.OHLCV_SYMBOLS  // already parsed from env in config.js
        : (dataReqs?.candles?.quoteSymbols || config.OHLCV_SYMBOLS);
      this.candleBaseSymbol = process.env.CANDLE_BASE_SYMBOL
        ? config.CANDLE_BASE_SYMBOL
        : (dataReqs?.candles?.baseSymbol || config.CANDLE_BASE_SYMBOL);
      const ltConfig = process.env.LT_SYMBOL
        ? { symbol: config.LT_SYMBOL, timeframe: config.LT_TIMEFRAME }
        : (dataReqs?.lt || (dataReqs === null && config.LT_SYMBOL ? { symbol: config.LT_SYMBOL, timeframe: config.LT_TIMEFRAME } : false));
      const needsTradier = dataReqs?.tradier ?? (config.TRADIER_ENABLED && !!config.TRADIER_ACCESS_TOKEN);
      const needsIVSkew = dataReqs?.ivSkew ?? false;
      const tradierSymbols = dataReqs?.tradierSymbols || config.TRADIER_SYMBOLS;
      const tradierOpts = needsTradier ? { symbols: tradierSymbols } : {};
      this.gexCacheFile = process.env.GEX_CACHE_FILE || `./data/gex_cache_${gexFuturesSymbol.toLowerCase()}.json`;

      // Log resolved data requirements
      const activeComponents = [];
      activeComponents.push(`GEX(${gexEtfSymbol}->${gexFuturesSymbol} x${gexDefaultMultiplier})`);
      if (ltConfig) activeComponents.push(`LT(${ltConfig.symbol} ${ltConfig.timeframe}m)`);
      if (needsTradier) activeComponents.push(`Tradier(${tradierSymbols.join(', ')})`);
      if (needsIVSkew) activeComponents.push('IV Skew');
      activeComponents.push(`TradingView(${ohlcvSymbols.join(', ')})`);

      const skippedComponents = [];
      if (!ltConfig) skippedComponents.push('LT Monitor');
      if (!needsTradier) skippedComponents.push('Tradier');
      if (!needsIVSkew) skippedComponents.push('IV Skew');

      logger.info(`Strategy: ${config.ACTIVE_STRATEGY}`);
      logger.info(`Data requirements: ${activeComponents.join(', ')}`);
      logger.info(`Candle base symbol: ${this.candleBaseSymbol}`);
      if (skippedComponents.length > 0) {
        logger.info(`Skipping: ${skippedComponents.join(', ')}`);
      }

      // Connect to message bus
      logger.info('Connecting to message bus...');
      if (!messageBus.isConnected) {
        await messageBus.connect();
      }
      logger.info('Connected to message bus successfully');

      // Initialize GEX services — use resolved symbols instead of config defaults
      const hybridEnabled = needsTradier && config.HYBRID_GEX_ENABLED && config.TRADIER_ACCESS_TOKEN && config.TRADIER_ENABLED;

      if (hybridEnabled) {
        logger.info('Initializing Hybrid GEX Calculator (Tradier + CBOE)...');

        // Initialize Tradier service for the hybrid calculator
        this.tradierExposureService = new TradierExposureService(tradierOpts);

        try {
          if (config.TRADIER_AUTO_START) {
            await this.tradierExposureService.initialize();
            await this.tradierExposureService.start();
            logger.info('Tradier service initialized and started for hybrid mode');
          } else {
            await this.tradierExposureService.initialize();
            logger.info('Tradier service initialized but not started (manual start enabled)');
          }

          // Create hybrid calculator
          this.hybridGexCalculator = new HybridGexCalculator({
            tradierEnabled: config.TRADIER_ENABLED && config.TRADIER_AUTO_START,
            tradierRefreshMinutes: config.HYBRID_TRADIER_REFRESH_MINUTES || 3,
            cboeEnabled: true,
            cboeRefreshMinutes: config.HYBRID_CBOE_REFRESH_MINUTES || 15,
            preferTradierWhenFresh: config.HYBRID_PREFER_TRADIER_WHEN_FRESH ?? true,
            tradierFreshnessMinutes: config.HYBRID_TRADIER_FRESHNESS_MINUTES || 5,
            tradierService: this.tradierExposureService,
            cboe: {
              symbol: gexEtfSymbol,
              futuresSymbol: gexFuturesSymbol,
              etfSymbol: gexEtfSymbol,
              defaultMultiplier: gexDefaultMultiplier,
              cacheFile: this.gexCacheFile,
              cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
              redisUrl: config.getRedisUrl()
            }
          });

          await this.hybridGexCalculator.initialize();

          // Set backward compatibility
          this.gexCalculator = this.hybridGexCalculator;

          logger.info('Hybrid GEX Calculator initialized successfully');
          logger.info(`Configuration: Tradier every ${config.HYBRID_TRADIER_REFRESH_MINUTES || 3}min, CBOE every ${config.HYBRID_CBOE_REFRESH_MINUTES || 15}min`);

        } catch (error) {
          logger.error('Failed to initialize hybrid calculator:', error.message);
          logger.info('Falling back to CBOE-only mode...');

          // Fallback to CBOE only
          this.gexCalculator = new GexCalculator({
            symbol: gexEtfSymbol,
            futuresSymbol: gexFuturesSymbol,
            etfSymbol: gexEtfSymbol,
            defaultMultiplier: gexDefaultMultiplier,
            cacheFile: this.gexCacheFile,
            cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
            redisUrl: config.getRedisUrl()
          });
          await this.gexCalculator.loadCachedLevels();
          logger.info('CBOE GEX Calculator initialized as fallback');
        }
      } else if (needsTradier && config.TRADIER_ACCESS_TOKEN && config.TRADIER_ENABLED && config.TRADIER_AUTO_START) {
        logger.info('Initializing Tradier-only mode...');
        this.tradierExposureService = new TradierExposureService(tradierOpts);

        try {
          await this.tradierExposureService.initialize();
          await this.tradierExposureService.start();
          this.gexCalculator = this.tradierExposureService;
          logger.info('Tradier Exposure Service initialized and started');
        } catch (error) {
          logger.error('Failed to initialize Tradier service:', error.message);
          logger.info('Falling back to CBOE GEX Calculator...');

          this.gexCalculator = new GexCalculator({
            symbol: gexEtfSymbol,
            futuresSymbol: gexFuturesSymbol,
            etfSymbol: gexEtfSymbol,
            defaultMultiplier: gexDefaultMultiplier,
            cacheFile: this.gexCacheFile,
            cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
            redisUrl: config.getRedisUrl()
          });
          await this.gexCalculator.loadCachedLevels();
          logger.info('CBOE GEX Calculator initialized as fallback');
        }
      } else if (needsTradier && config.TRADIER_ACCESS_TOKEN && config.TRADIER_ENABLED && !config.TRADIER_AUTO_START) {
        logger.info('Tradier configured but auto-start disabled, using CBOE...');
        this.tradierExposureService = new TradierExposureService(tradierOpts);
        this.gexCalculator = new GexCalculator({
          symbol: gexEtfSymbol,
          cacheFile: this.gexCacheFile,
          cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
          redisUrl: config.getRedisUrl()
        });
        await this.gexCalculator.loadCachedLevels();
        logger.info('CBOE GEX Calculator initialized, Tradier ready for manual start');
      } else {
        if (needsTradier && !config.TRADIER_ACCESS_TOKEN) {
          logger.warn('Strategy requires Tradier but no token configured, using CBOE-only mode');
        }
        this.gexCalculator = new GexCalculator({
          symbol: gexEtfSymbol,
          futuresSymbol: gexFuturesSymbol,
          etfSymbol: gexEtfSymbol,
          defaultMultiplier: gexDefaultMultiplier,
          cacheFile: this.gexCacheFile,
          cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
          redisUrl: config.getRedisUrl()
        });
        await this.gexCalculator.loadCachedLevels();
        // Fetch fresh levels on startup if cache is empty
        if (!this.gexCalculator.currentLevels) {
          logger.info('No cached GEX levels — fetching from CBOE on startup...');
          try {
            await this.gexCalculator.calculateLevels(true);
          } catch (err) {
            logger.warn('Initial CBOE fetch failed, will retry on schedule:', err.message);
          }
        }
        logger.info('CBOE GEX Calculator initialized');
      }

      // Initialize Strategy Engine (standard or AI trader)
      if (this.isAiTrader) {
        logger.info('Initializing AI Trader engine...');

        // Create dedicated candle buffers for AI trader (much larger than standard)
        const historyBars1m = parseInt(process.env.CANDLE_HISTORY_BARS || '500', 10);
        this.candle1mBuffer = new CandleBuffer({
          symbol: this.candleBaseSymbol,
          timeframe: '1',
          maxSize: Math.max(historyBars1m + 500, 8000), // Extra headroom for live candles
        });
        this.candle1hBuffer = new CandleBuffer({
          symbol: this.candleBaseSymbol,
          timeframe: '60',
          maxSize: 500,
        });

        // LiveFeatureAggregator — same interface as backtest, backed by live buffers
        this.liveFeatureAggregator = new LiveFeatureAggregator({
          candle1mBuffer: this.candle1mBuffer,
          candle1hBuffer: this.candle1hBuffer,
          gexCalculator: this.gexCalculator,
          ltMonitor: null, // LT data is pushed via events
          ivCalculator: null, // Not wired for v1
          ticker: this.candleBaseSymbol,
        });

        // LiveTradeManager — MFE ratchet + structural trail for live stops
        this.liveTradeManager = new LiveTradeManager({
          featureAggregator: this.liveFeatureAggregator,
          strategyConstant: 'AI_TRADER',
        });

        // AI Strategy Engine — replaces standard StrategyEngine entirely
        this.aiEngine = new AIStrategyEngine({
          featureAggregator: this.liveFeatureAggregator,
          gexCalculator: this.gexCalculator,
          tradingSymbol: config.TRADING_SYMBOL,
          ticker: this.candleBaseSymbol,
          tradeManager: this.liveTradeManager,
        });

        // AI trader does NOT use the standard StrategyEngine — candle detection
        // is handled by the dedicated candle1mBuffer directly.
        // We still set strategyEngine to null so callers know to skip it.
        this.strategyEngine = null;

        logger.info('AI Trader engine initialized');
      } else {
        this.strategyEngine = new StrategyEngine(this.gexCalculator, null, { candleBaseSymbol: this.candleBaseSymbol });

        // Wire up IV Skew calculator to strategy engine (only if strategy needs it)
        if (needsIVSkew && this.tradierExposureService?.ivSkewCalculator) {
          this.ivSkewCalculator = this.tradierExposureService.ivSkewCalculator;
          this.strategyEngine.setIVSkewCalculator(this.ivSkewCalculator);
          logger.info('IV Skew calculator wired to strategy engine');
        } else if (needsIVSkew) {
          logger.warn('Strategy requires IV Skew but Tradier service not available');
        }
      }

      // --- Startup Token Check ---
      // Compare env var token vs Redis-cached token, use whichever expires later.
      // NOTE: JWT exp is NOT a reliable invalidation signal for TradingView tokens.
      // They typically work for days after exp. Only refresh reactively when
      // the WebSocket drops or quotes are detected as delayed.
      const redisUrl = config.getRedisUrl();
      let startupJwtToken = config.TRADINGVIEW_JWT_TOKEN;
      const tokenRefreshEnabled = process.env.TV_TOKEN_REFRESH_ENABLED !== 'false';

      if (tokenRefreshEnabled && config.TRADINGVIEW_CREDENTIALS) {
        try {
          const best = await getBestAvailableToken(config.TRADINGVIEW_JWT_TOKEN, redisUrl);
          if (best) {
            startupJwtToken = best.token;
            const ttlMin = Math.floor(best.ttl / 60);
            logger.info(`Startup token source: ${best.source} (JWT exp: ${ttlMin > 0 ? `${ttlMin}min` : `expired ${-ttlMin}min ago`} - token likely still valid)`);
          } else {
            logger.warn('No JWT token available - TradingView will use unauthenticated mode (delayed quotes)');
          }
        } catch (error) {
          logger.warn('Startup token check failed:', error.message);
        }
      }

      // Initialize TradingView Client with strategy-resolved symbols
      this.tradingViewClient = new TradingViewClient({
        symbols: ohlcvSymbols,
        ltSymbol: ltConfig ? ltConfig.symbol : null,
        ltTimeframe: ltConfig ? ltConfig.timeframe : config.LT_TIMEFRAME,
        jwtToken: startupJwtToken,
        credentials: config.TRADINGVIEW_CREDENTIALS,
        tokenRefreshEnabled,
        redisUrl
      });

      // Set up TradingView event listeners
      this.tradingViewClient.on('quote', (quote) => this.handleQuoteUpdate(quote));

      // AI Trader: register history_loaded listener BEFORE streaming starts
      // (startStreaming triggers subscribeToSymbol which emits history_loaded synchronously)
      if (this.isAiTrader) {
        this.tradingViewClient.on('history_loaded', ({ symbol, baseSymbol, timeframe, candles }) => {
          logger.info(`History loaded: ${candles.length} ${timeframe}m candles for ${baseSymbol}`);
          if (timeframe === '1' && this.candle1mBuffer) {
            const loaded = this.candle1mBuffer.seedCandles(candles);
            logger.info(`Seeded ${loaded} 1m candles into buffer`);
            this.aiEngine?.markHistoryReady('1');
          } else if (timeframe === '60' && this.candle1hBuffer) {
            const loaded = this.candle1hBuffer.seedCandles(candles);
            logger.info(`Seeded ${loaded} 1h candles into buffer`);
            this.aiEngine?.markHistoryReady('60');
          }
        });
      }

      // Start TradingView connection
      logger.info('Connecting to TradingView WebSocket...');
      try {
        await this.tradingViewClient.connect();
        logger.info('TradingView WebSocket connected successfully');
      } catch (error) {
        logger.error('Failed to connect to TradingView:', error.message);
        throw error;
      }

      // Start streaming data for all symbols
      logger.info('Starting TradingView data streaming...');
      try {
        await this.tradingViewClient.startStreaming();
        logger.info(`TradingView streaming started for ${ohlcvSymbols.length} symbols`);
      } catch (error) {
        logger.error('Failed to start TradingView streaming:', error.message);
        throw error;
      }

      // AI Trader: create 1h chart session after streaming is active
      if (this.isAiTrader) {
        const ohlcvSymbol = ohlcvSymbols[0]; // e.g. 'CME_MINI:NQ1!'
        logger.info(`Creating 1h history session for ${ohlcvSymbol}...`);
        try {
          await this.tradingViewClient.createHistorySession(ohlcvSymbol, '60', 300);
          logger.info('1h history session created');
        } catch (error) {
          logger.error('Failed to create 1h history session:', error.message);
        }
      }

      // Initialize and start LT Monitor only if strategy requires it
      if (ltConfig) {
        logger.info(`Initializing LT monitor for ${ltConfig.symbol} (${ltConfig.timeframe}m)...`);
        this.ltMonitor = new LTMonitor({
          symbol: ltConfig.symbol,
          timeframe: ltConfig.timeframe,
          jwtToken: startupJwtToken,
          redisUrl
        });

        // Wire up token refresh: when main client refreshes, update LT monitor too
        this.tradingViewClient.on('token_refreshed', (newToken) => {
          if (this.ltMonitor) {
            this.ltMonitor.updateToken(newToken).catch(err => {
              logger.error('LT monitor token update failed:', err.message);
            });
          }
        });

        // Set up LT event listener
        this.ltMonitor.on('lt_levels', (ltLevels) => this.handleLtUpdate(ltLevels));

        try {
          await this.ltMonitor.connect();
          await this.ltMonitor.startMonitoring();
          logger.info('LT monitor started successfully');
        } catch (error) {
          logger.error('Failed to start LT monitor:', error.message);
          // Don't throw - LT is optional
        }
      }

      // Start Tradier service if initialized and auto-start enabled, or set up GEX refresh schedule
      if (this.tradierExposureService && this.gexCalculator === this.tradierExposureService) {
        logger.info('Starting Tradier Exposure Service...');
        await this.tradierExposureService.start();
        logger.info('Tradier Exposure Service started');
      } else {
        // Set up GEX refresh schedule for CBOE fallback
        this.scheduleGexRefresh();
      }

      // Sync position state and start appropriate engine
      if (this.isAiTrader && this.aiEngine) {
        await this.aiEngine.syncPositionState();

        // Mark GEX as ready if levels already available
        if (this.gexCalculator?.getCurrentLevels()) {
          this.aiEngine.markGexReady();
        }

        // Start AI engine background loop (reconciliation + status)
        this.aiEngine.run().catch(error => {
          logger.error('AI Strategy engine error:', error);
        });
        logger.info('AI Trader engine started');
      } else {
        // Standard strategy: sync and start
        await this.strategyEngine.syncPositionState();
        this.strategyEngine.run().catch(error => {
          logger.error('Strategy engine error:', error);
        });
      }

      this.isRunning = true;
      logger.info('Signal Generator Service started successfully');

      // Publish service health
      await messageBus.publish('service.health', {
        service: config.SERVICE_NAME,
        status: 'running',
        timestamp: new Date().toISOString(),
        components: {
          tradingview: 'connected',
          gex_calculator: 'ready',
          strategy_engine: 'running'
        }
      });

    } catch (error) {
      logger.error('Failed to start Signal Generator Service:', error);
      throw error;
    }
  }

  async handleQuoteUpdate(quote) {
    try {
      // Track quote counts and log periodically instead of every quote
      this.quoteCount = (this.quoteCount || 0) + 1;
      if (this.quoteCount % 100 === 0 || !this.lastQuoteLogTime || Date.now() - this.lastQuoteLogTime > 30000) {
        logger.info(`📊 Processed ${this.quoteCount} quotes | Latest: ${quote.baseSymbol} = ${quote.close}`);
        this.lastQuoteLogTime = Date.now();
      }

      // Feed candle-based quotes to strategy engine (only quotes with candleTimestamp from OHLCV data)
      if (quote.candleTimestamp && quote.baseSymbol === this.candleBaseSymbol) {
        const candleData = {
          symbol: quote.symbol,
          timestamp: quote.timestamp,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          close: quote.close,
          volume: quote.volume
        };

        if (this.isAiTrader && this.aiEngine) {
          // AI Trader: use dedicated candle1mBuffer for candle detection
          const isNewCandle = this.candle1mBuffer.addCandle(candleData);
          if (isNewCandle) {
            const closedCandle = this.candle1mBuffer.getLastClosedCandle();
            if (closedCandle) {
              logger.info(`🕯️ 1-minute candle closed: ${closedCandle.close} @ ${closedCandle.timestamp}`);
              await this.aiEngine.processCandle(closedCandle);
            }
          }
        } else if (this.strategyEngine) {
          // Standard strategy: use StrategyEngine's candle buffer
          const isNewCandle = this.strategyEngine.processCandle(candleData);
          if (isNewCandle) {
            const closedCandle = this.strategyEngine.candleBuffer.getLastClosedCandle();
            if (closedCandle) {
              logger.info(`🕯️ 1-minute candle closed: ${closedCandle.close} @ ${closedCandle.timestamp}`);
              await this.strategyEngine.evaluateCandle(closedCandle);
            }
          }
        }
      }

      // Always publish quote to message bus for other services (like monitoring-service/frontend)
      // candleTimestamp is only present on du/timescale_update messages (proper 1-min OHLCV),
      // absent on qsd messages (session-level data). Frontend uses this to distinguish.
      await messageBus.publish('price.update', {
        symbol: quote.symbol,
        baseSymbol: quote.baseSymbol,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        volume: quote.volume,
        timestamp: quote.timestamp,
        source: quote.source,
        candleTimestamp: quote.candleTimestamp,
        // Session-level fields from qsd (undefined on du/timescale_update messages)
        sessionOpen: quote.sessionOpen,
        sessionHigh: quote.sessionHigh,
        sessionLow: quote.sessionLow,
        prevClose: quote.prevClose,
        change: quote.change,
        changePercent: quote.changePercent
      });

    } catch (error) {
      logger.error('Error handling quote update:', error);
    }
  }

  async handleLtUpdate(ltLevels) {
    try {
      logger.info(`LT levels updated: ${JSON.stringify(ltLevels)}`);

      // Update strategy engine (null in AI trader mode)
      if (this.strategyEngine) {
        this.strategyEngine.setLtLevels(ltLevels);
      }

      // Push LT snapshot to AI trader's feature aggregator (for migration analysis)
      if (this.isAiTrader && this.liveFeatureAggregator) {
        this.liveFeatureAggregator.pushLtSnapshot(ltLevels);
      }

      // Publish LT levels to message bus
      await messageBus.publish('lt.levels', ltLevels);

    } catch (error) {
      logger.error('Error handling LT update:', error);
    }
  }

  scheduleGexRefresh() {
    // Check for GEX refresh every 5 minutes
    setInterval(async () => {
      try {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();

        // Refresh GEX at configured time (default 16:35 EST)
        const [targetHour, targetMinute] = config.GEX_FETCH_TIME.split(':').map(Number);

        if (hour === targetHour && minute === targetMinute) {
          logger.info('Refreshing GEX levels at scheduled time...');
          const levels = await this.gexCalculator.calculateLevels(true);

          // Publish GEX levels
          await messageBus.publish('gex.levels', levels);
          logger.info('GEX levels published');
        }

      } catch (error) {
        logger.error('Error in GEX refresh schedule:', error);
      }
    }, 60000); // Check every minute
  }

  async stop() {
    try {
      logger.info('Stopping Signal Generator Service...');
      this.isRunning = false;

      if (this.tradingViewClient) {
        this.tradingViewClient.disconnect();
      }

      if (this.ltMonitor) {
        await this.ltMonitor.disconnect();
      }

      if (this.tradierExposureService) {
        await this.tradierExposureService.stop();
      }

      logger.info('Signal Generator Service stopped');

    } catch (error) {
      logger.error('Error stopping service:', error);
    }
  }

  // Manual Tradier service control
  async enableTradier() {
    if (!this.tradierExposureService) {
      throw new Error('Tradier service not available - check configuration');
    }

    if (this.gexCalculator === this.tradierExposureService) {
      logger.warn('Tradier service already active');
      return { success: true, message: 'Tradier service already active' };
    }

    try {
      logger.info('Manually starting Tradier Exposure Service...');

      // Initialize if not done already
      if (!this.tradierExposureService.isInitialized) {
        await this.tradierExposureService.initialize();
      }

      // Start the service
      await this.tradierExposureService.start();

      // Switch to using Tradier instead of CBOE
      this.gexCalculator = this.tradierExposureService;

      // Update strategy engine reference
      if (this.strategyEngine) {
        this.strategyEngine.setGexCalculator(this.gexCalculator);
      }

      logger.info('✅ Tradier service enabled and active');
      return { success: true, message: 'Tradier service enabled successfully' };

    } catch (error) {
      logger.error('Failed to enable Tradier service:', error.message);
      throw error;
    }
  }

  async disableTradier() {
    if (!this.tradierExposureService || this.gexCalculator !== this.tradierExposureService) {
      logger.warn('Tradier service not currently active');
      return { success: true, message: 'Tradier service not currently active' };
    }

    try {
      logger.info('Manually stopping Tradier Exposure Service...');

      // Stop Tradier service
      await this.tradierExposureService.stop();

      // Switch back to CBOE GEX Calculator
      const gexCalculator = new GexCalculator({
        symbol: config.GEX_SYMBOL,
        futuresSymbol: config.GEX_FUTURES_SYMBOL,
        etfSymbol: config.GEX_SYMBOL,
        defaultMultiplier: config.GEX_DEFAULT_MULTIPLIER,
        cacheFile: this.gexCacheFile,
        cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
        redisUrl: config.getRedisUrl()
      });
      await gexCalculator.loadCachedLevels();

      this.gexCalculator = gexCalculator;

      // Update strategy engine reference
      if (this.strategyEngine) {
        this.strategyEngine.setGexCalculator(this.gexCalculator);
      }

      // Restart GEX refresh schedule
      this.scheduleGexRefresh();

      logger.info('✅ Switched back to CBOE GEX Calculator');
      return { success: true, message: 'Tradier service disabled, switched to CBOE' };

    } catch (error) {
      logger.error('Failed to disable Tradier service:', error.message);
      throw error;
    }
  }

  async updateTradingViewToken(token) {
    const redisUrl = config.getRedisUrl();

    // Cache the new token in Redis
    await cacheTokenInRedis(redisUrl, token);
    logger.info('Manual token cached in Redis');

    // Update the TradingView client's token and reconnect
    if (this.tradingViewClient) {
      this.tradingViewClient.jwtToken = token;
      // Reset refresh retry state — fresh manual token means we're good
      this.tradingViewClient.tokenRefreshRetryCount = 0;
      this.tradingViewClient.stopTokenRefreshSchedule(); // Clear any pending retry timers
      await this.tradingViewClient.reconnectWithNewToken();
      logger.info('TradingView client reconnected with new token');
    }

    // Update LT monitor if active
    if (this.ltMonitor) {
      await this.ltMonitor.updateToken(token);
      logger.info('LT monitor updated with new token');
    }

    const ttl = getTokenTTL(token);
    logger.info(`Manual token set successfully (TTL: ${Math.floor(ttl / 60)}min)`);

    return {
      success: true,
      message: 'Token updated and connections reconnected',
      tokenTTL: ttl,
      authState: this.tradingViewClient?.authState || 'unknown'
    };
  }

  getTradierStatus() {
    const health = this.tradierExposureService?.getHealthStatus() || null;

    // Map websocket status to display-friendly labels
    const websocketStatusMap = {
      'connected': 'Active',
      'market_closed': 'Market Closed',
      'disconnected': 'Disconnected',
      'reconnecting': 'Reconnecting',
      'initializing': 'Initializing'
    };

    const wsStatus = health?.websocket?.status || 'initializing';
    const displayStatus = websocketStatusMap[wsStatus] || wsStatus;

    return {
      available: !!this.tradierExposureService,
      active: this.gexCalculator === this.tradierExposureService,
      initialized: this.tradierExposureService?.isInitialized || false,
      running: this.tradierExposureService?.isRunning || false,
      health: health,
      // Display-friendly status for dashboard
      displayStatus: displayStatus,
      websocketStatus: wsStatus,
      config: {
        enabled: config.TRADIER_ENABLED,
        autoStart: config.TRADIER_AUTO_START,
        hasToken: !!config.TRADIER_ACCESS_TOKEN
      }
    };
  }

  // Health check endpoint
  getHealth() {
    const tradierStatus = this.getTradierStatus();
    const hybridHealth = this.hybridGexCalculator?.getHealthStatus() || null;

    return {
      service: config.SERVICE_NAME,
      strategy: config.ACTIVE_STRATEGY,
      status: this.isRunning ? 'running' : 'stopped',
      timestamp: new Date().toISOString(),
      components: {
        tradingview: this.tradingViewClient?.isConnected() ? 'connected' : 'disconnected',
        lt_monitor: this.ltMonitor
          ? (this.ltMonitor.isConnected() ? 'connected' : 'disconnected')
          : 'not_required',
        gex_calculator: this.gexCalculator ? 'ready' : 'not_initialized',
        strategy_engine: this.strategyEngine?.enabled ? 'enabled' : 'disabled',
        tradier_service: this.tradierExposureService
          ? (tradierStatus.active ? 'active' : 'available')
          : 'not_required',
        iv_skew: this.ivSkewCalculator ? 'ready' : 'not_required'
      },
      // Connection details for dashboard monitoring
      connectionDetails: {
        tradingview: {
          connected: this.tradingViewClient?.isConnected() || false,
          authState: this.tradingViewClient?.authState || 'unknown',
          tokenTTL: this.tradingViewClient?.jwtToken ? getTokenTTL(this.tradingViewClient.jwtToken) : null,
          lastHeartbeat: this.tradingViewClient?.lastHeartbeat?.toISOString() || null,
          lastQuoteReceived: this.tradingViewClient?.lastQuoteReceived?.toISOString() || null,
          reconnectAttempts: this.tradingViewClient?.reconnectAttempts || 0
        },
        ltMonitor: this.ltMonitor ? {
          connected: this.ltMonitor.isConnected() || false,
          lastHeartbeat: this.ltMonitor.lastHeartbeat?.toISOString() || null,
          hasLevels: !!this.ltMonitor.currentLevels,
          reconnectAttempts: this.ltMonitor.reconnectAttempts || 0
        } : null,
        hybridGex: hybridHealth
      },
      config: {
        active_strategy: config.ACTIVE_STRATEGY,
        candle_base_symbol: this.candleBaseSymbol,
        strategy_enabled: config.STRATEGY_ENABLED,
        tradier: tradierStatus.config
      },
      lt_levels: this.ltMonitor?.getCurrentLevels() || null,
      tradier: tradierStatus
    };
  }
}

// Create and start service
const service = new SignalGeneratorService();

// Graceful shutdown
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

// Service will be started by index.js

export default service;