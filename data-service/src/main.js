// Data Service - Centralized market data sourcing
// Single instance providing TradingView quotes, GEX levels, Tradier exposure,
// LT levels, and IV skew to all consumers via Redis pub/sub and HTTP.

import { createLogger, messageBus, CHANNELS } from '../../shared/index.js';
import config from './config.js';
import TradingViewClient from '../../signal-generator/src/websocket/tradingview-client.js';
import LTMonitor from '../../signal-generator/src/websocket/lt-monitor.js';
import GexCalculator from '../../signal-generator/src/gex/gex-calculator.js';
import TradierExposureService from '../../signal-generator/src/tradier/tradier-exposure-service.js';
import HybridGexCalculator from '../../signal-generator/src/gex/hybrid-gex-calculator.js';
import { getBestAvailableToken, cacheTokenInRedis, getTokenTTL } from '../../signal-generator/src/utils/tradingview-auth.js';
import { CandleManager } from './candle-manager.js';

const logger = createLogger('data-service');

class DataService {
  constructor() {
    this.tradingViewClient = null;

    // Per-product GEX calculators
    this.gexCalculators = new Map();  // 'NQ' -> GexCalculator, 'ES' -> GexCalculator

    // Tradier exposure service (handles both QQQ and SPY)
    this.tradierExposureService = null;
    this.ivSkewCalculator = null;

    // Hybrid GEX calculators (per product)
    this.hybridGexCalculators = new Map();

    // LT Monitors (per product)
    this.ltMonitors = new Map();  // 'NQ' -> LTMonitor, 'ES' -> LTMonitor

    // Candle manager for all products
    this.candleManager = new CandleManager();

    this.isRunning = false;
  }

  async start() {
    try {
      logger.info('Starting Data Service...');
      console.log('Starting Data Service...');

      // Connect to message bus
      logger.info('Connecting to message bus...');
      if (!messageBus.isConnected) {
        await messageBus.connect();
      }
      logger.info('Connected to message bus successfully');

      // Initialize Tradier service first (needed by hybrid GEX calculators)
      await this.initializeTradierService();

      // Initialize GEX calculators for both products (uses Tradier if available for hybrid mode)
      await this.initializeGexCalculators();

      // Startup token check
      const redisUrl = config.getRedisUrl();
      let startupJwtToken = config.TRADINGVIEW_JWT_TOKEN;
      const tokenRefreshEnabled = process.env.TV_TOKEN_REFRESH_ENABLED !== 'false';

      if (tokenRefreshEnabled && config.TRADINGVIEW_CREDENTIALS) {
        try {
          const best = await getBestAvailableToken(config.TRADINGVIEW_JWT_TOKEN, redisUrl);
          if (best) {
            startupJwtToken = best.token;
            const ttlMin = Math.floor(best.ttl / 60);
            logger.info(`Startup token source: ${best.source} (JWT exp: ${ttlMin > 0 ? `${ttlMin}min` : `expired ${-ttlMin}min ago`})`);
          } else {
            logger.warn('No JWT token available - TradingView will use unauthenticated mode');
          }
        } catch (error) {
          logger.warn('Startup token check failed:', error.message);
        }
      }

      // Initialize TradingView Client
      // Chart sessions for symbols needing OHLCV candle data (NQ, ES)
      // Quote-only for symbols needing just last price (MNQ, MES, QQQ, SPY, BTC)
      this.tradingViewClient = new TradingViewClient({
        symbols: config.OHLCV_SYMBOLS,
        quoteOnlySymbols: config.QUOTE_ONLY_SYMBOLS,
        ltSymbol: null,  // LT handled by separate monitors
        jwtToken: startupJwtToken,
        credentials: config.TRADINGVIEW_CREDENTIALS,
        tokenRefreshEnabled,
        redisUrl,
        candleHistoryBars: 500  // Load enough history for AI trader daily context
      });

      // Set up quote handler
      this.tradingViewClient.on('quote', (quote) => this.handleQuoteUpdate(quote));

      // Seed candle buffers from TradingView history and publish data readiness
      this.tradingViewClient.on('history_loaded', ({ symbol, baseSymbol, timeframe, candles }) => {
        const canonical = this.candleManager.resolveBaseSymbol(baseSymbol);
        if (canonical) {
          this.candleManager.seedHistory(canonical, timeframe, candles);
          this.candleManager.markSeeded(canonical, timeframe);
          const tfLabel = timeframe === '1D' ? '1D' : `${timeframe}m`;
          logger.info(`History loaded: ${candles.length} ${tfLabel} candles for ${canonical} (from ${baseSymbol})`);

          // Broadcast data readiness to consumers (signal-generator, ai-trader)
          messageBus.publish(CHANNELS.DATA_READY, {
            product: canonical,
            timeframe,
            candleCount: candles.length,
            readiness: this.candleManager.getReadiness()
          }).catch(err => logger.warn(`Failed to publish data.ready: ${err.message}`));
        }
      });

      // Connect and start streaming
      logger.info('Connecting to TradingView WebSocket...');
      await this.tradingViewClient.connect();
      logger.info('TradingView WebSocket connected');

      logger.info('Starting TradingView data streaming...');
      await this.tradingViewClient.startStreaming();
      logger.info(`TradingView streaming started: ${config.OHLCV_SYMBOLS.length} chart sessions + ${config.QUOTE_ONLY_SYMBOLS.length} quote-only symbols`);

      // Create 1h + 1D history sessions
      await this.createHistorySessions();

      // Recreate history sessions on TradingView reconnection (JWT refresh, disconnect)
      this.tradingViewClient.on('reconnected', async () => {
        logger.info('TradingView reconnected — recreating history sessions...');
        this.candleManager.resetReadiness();
        await this.createHistorySessions();
      });

      // Initialize LT Monitors for both products
      // Use the client's current token (may have been refreshed during connect) rather than the startup token
      const ltToken = this.tradingViewClient.jwtToken || startupJwtToken;
      await this.initializeLtMonitors(ltToken, redisUrl);

      // Set up GEX refresh schedules
      this.scheduleGexRefresh();

      // Publish cached GEX levels to Redis so signal generators pick them up immediately
      for (const [product, calculator] of this.gexCalculators) {
        const levels = calculator.getCurrentLevels();
        if (levels) {
          await messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product });
          logger.info(`Published cached GEX levels for ${product} on startup`);
        }
      }

      this.isRunning = true;
      logger.info('Data Service started successfully');

      // Publish service health
      await messageBus.publish('service.health', {
        service: config.SERVICE_NAME,
        status: 'running',
        timestamp: new Date().toISOString(),
        components: {
          tradingview: 'connected',
          gex_nq: this.gexCalculators.has('NQ') ? 'ready' : 'not_initialized',
          gex_es: this.gexCalculators.has('ES') ? 'ready' : 'not_initialized',
          lt_nq: this.ltMonitors.has('NQ') ? 'connected' : 'not_initialized',
          lt_es: this.ltMonitors.has('ES') ? 'connected' : 'not_initialized',
          tradier: this.tradierExposureService ? 'ready' : 'not_required'
        }
      });

    } catch (error) {
      logger.error('Failed to start Data Service:', error);
      throw error;
    }
  }

  /**
   * Initialize GEX calculators for NQ (from QQQ) and ES (from SPY)
   */
  async initializeGexCalculators() {
    const products = [
      {
        key: 'NQ',
        etfSymbol: config.NQ_GEX_SYMBOL,
        futuresSymbol: config.NQ_GEX_FUTURES_SYMBOL,
        defaultMultiplier: config.NQ_GEX_DEFAULT_MULTIPLIER,
        cacheFile: config.NQ_GEX_CACHE_FILE
      },
      {
        key: 'ES',
        etfSymbol: config.ES_GEX_SYMBOL,
        futuresSymbol: config.ES_GEX_FUTURES_SYMBOL,
        defaultMultiplier: config.ES_GEX_DEFAULT_MULTIPLIER,
        cacheFile: config.ES_GEX_CACHE_FILE
      }
    ];

    const needsTradier = config.TRADIER_ENABLED && !!config.TRADIER_ACCESS_TOKEN;
    const hybridEnabled = needsTradier && config.HYBRID_GEX_ENABLED;

    for (const product of products) {
      try {
        if (hybridEnabled && this.tradierExposureService) {
          // Hybrid mode: Tradier + CBOE
          logger.info(`Initializing Hybrid GEX for ${product.key} (${product.etfSymbol}->${product.futuresSymbol})...`);
          const hybrid = new HybridGexCalculator({
            tradierEnabled: config.TRADIER_ENABLED && config.TRADIER_AUTO_START,
            tradierRefreshMinutes: config.HYBRID_TRADIER_REFRESH_MINUTES || 3,
            cboeEnabled: true,
            cboeRefreshMinutes: config.HYBRID_CBOE_REFRESH_MINUTES || 15,
            preferTradierWhenFresh: config.HYBRID_PREFER_TRADIER_WHEN_FRESH ?? true,
            tradierFreshnessMinutes: config.HYBRID_TRADIER_FRESHNESS_MINUTES || 5,
            tradierService: this.tradierExposureService,
            cboe: {
              symbol: product.etfSymbol,
              futuresSymbol: product.futuresSymbol,
              etfSymbol: product.etfSymbol,
              defaultMultiplier: product.defaultMultiplier,
              cacheFile: product.cacheFile,
              cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
              redisUrl: config.getRedisUrl()
            }
          });
          await hybrid.initialize();

          // Publish fresh GEX levels to Redis on every hybrid refresh
          // so signal-generator strategies always have current regime data
          const productKey = product.key;
          hybrid.setUpdateCallback((levels) => {
            messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product: productKey })
              .then(() => logger.debug(`Published refreshed GEX levels for ${productKey} to Redis`))
              .catch(err => logger.warn(`Failed to publish GEX levels for ${productKey}:`, err.message));
          });

          this.hybridGexCalculators.set(product.key, hybrid);
          this.gexCalculators.set(product.key, hybrid);
          logger.info(`Hybrid GEX for ${product.key} initialized`);
        } else {
          // CBOE-only mode
          logger.info(`Initializing CBOE GEX for ${product.key} (${product.etfSymbol}->${product.futuresSymbol})...`);
          const gex = new GexCalculator({
            symbol: product.etfSymbol,
            futuresSymbol: product.futuresSymbol,
            etfSymbol: product.etfSymbol,
            defaultMultiplier: product.defaultMultiplier,
            cacheFile: product.cacheFile,
            cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
            redisUrl: config.getRedisUrl()
          });
          await gex.loadCachedLevels();
          if (!gex.currentLevels) {
            logger.info(`No cached GEX levels for ${product.key} - fetching from CBOE...`);
            try {
              await gex.calculateLevels(true);
            } catch (err) {
              logger.warn(`Initial CBOE fetch for ${product.key} failed:`, err.message);
            }
          }
          this.gexCalculators.set(product.key, gex);
          logger.info(`CBOE GEX for ${product.key} initialized`);
        }
      } catch (error) {
        logger.error(`Failed to initialize GEX for ${product.key}:`, error.message);
        // Try CBOE fallback
        try {
          const gex = new GexCalculator({
            symbol: product.etfSymbol,
            futuresSymbol: product.futuresSymbol,
            etfSymbol: product.etfSymbol,
            defaultMultiplier: product.defaultMultiplier,
            cacheFile: product.cacheFile,
            cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
            redisUrl: config.getRedisUrl()
          });
          await gex.loadCachedLevels();
          this.gexCalculators.set(product.key, gex);
          logger.info(`CBOE GEX for ${product.key} initialized as fallback`);
        } catch (fallbackError) {
          logger.error(`CBOE fallback for ${product.key} also failed:`, fallbackError.message);
        }
      }
    }
  }

  /**
   * Initialize Tradier Exposure Service for both QQQ and SPY
   */
  async initializeTradierService() {
    if (!config.TRADIER_ENABLED || !config.TRADIER_ACCESS_TOKEN) {
      logger.info('Tradier not configured, skipping');
      return;
    }

    try {
      this.tradierExposureService = new TradierExposureService({
        symbols: config.TRADIER_SYMBOLS
      });

      await this.tradierExposureService.initialize();

      if (config.TRADIER_AUTO_START) {
        await this.tradierExposureService.start();
        logger.info('Tradier Exposure Service initialized and started');
      } else {
        logger.info('Tradier Exposure Service initialized (manual start)');
      }

      // Cache IV skew calculator reference
      if (this.tradierExposureService.ivSkewCalculator) {
        this.ivSkewCalculator = this.tradierExposureService.ivSkewCalculator;
        logger.info('IV Skew calculator available');
      }
    } catch (error) {
      logger.error('Failed to initialize Tradier service:', error.message);
      this.tradierExposureService = null;
    }
  }

  /**
   * Initialize LT Monitors for NQ and ES
   */
  async initializeLtMonitors(jwtToken, redisUrl) {
    const ltConfigs = [
      { key: 'NQ', symbol: config.LT_NQ_SYMBOL, timeframe: config.LT_NQ_TIMEFRAME },
      { key: 'ES', symbol: config.LT_ES_SYMBOL, timeframe: config.LT_ES_TIMEFRAME }
    ];

    for (const ltConfig of ltConfigs) {
      try {
        logger.info(`Initializing LT monitor for ${ltConfig.key} (${ltConfig.symbol} ${ltConfig.timeframe}m)...`);
        const monitor = new LTMonitor({
          symbol: ltConfig.symbol,
          timeframe: ltConfig.timeframe,
          jwtToken,
          redisUrl
        });

        // Wire up token refresh from main client
        this.tradingViewClient.on('token_refreshed', (newToken) => {
          monitor.updateToken(newToken).catch(err => {
            logger.error(`LT monitor ${ltConfig.key} token update failed:`, err.message);
          });
        });

        // Set up LT event listener
        monitor.on('lt_levels', (ltLevels) => this.handleLtUpdate(ltConfig.key, ltLevels));

        // Set up LS sentiment listener
        monitor.on('ls_status', (lsStatus) => this.handleLsUpdate(ltConfig.key, lsStatus));

        await monitor.connect();
        await monitor.startMonitoring();
        this.ltMonitors.set(ltConfig.key, monitor);
        logger.info(`LT monitor for ${ltConfig.key} started`);
      } catch (error) {
        logger.error(`Failed to start LT monitor for ${ltConfig.key}:`, error.message);
      }
    }
  }

  /**
   * Create 1h and 1D history sessions for each OHLCV symbol.
   * Called on startup and after TradingView reconnection.
   */
  async createHistorySessions() {
    for (const sym of config.OHLCV_SYMBOLS) {
      try {
        await this.tradingViewClient.createHistorySession(sym, '60', 300);
        logger.info(`Created 1h history session for ${sym}`);
      } catch (error) {
        logger.error(`Failed to create 1h history session for ${sym}:`, error.message);
      }
      try {
        await this.tradingViewClient.createHistorySession(sym, '1D', 10);
        logger.info(`Created 1D history session for ${sym}`);
      } catch (error) {
        logger.error(`Failed to create 1D history session for ${sym}:`, error.message);
      }
    }
  }

  /**
   * Handle incoming TradingView quote
   */
  async handleQuoteUpdate(quote) {
    try {
      // Track quote counts for logging
      this.quoteCount = (this.quoteCount || 0) + 1;
      if (this.quoteCount % 100 === 0 || !this.lastQuoteLogTime || Date.now() - this.lastQuoteLogTime > 30000) {
        logger.info(`Processed ${this.quoteCount} quotes | Latest: ${quote.baseSymbol} = ${quote.close}`);
        this.lastQuoteLogTime = Date.now();
      }

      // Feed to candle manager for close detection (only candle data)
      if (quote.candleTimestamp) {
        await this.candleManager.processQuote(quote);
      }

      // Publish price.update to Redis for all consumers
      await messageBus.publish(CHANNELS.PRICE_UPDATE, {
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

  /**
   * Handle LT level update from a monitor
   */
  async handleLtUpdate(product, ltLevels) {
    try {
      logger.info(`LT levels updated for ${product}: ${JSON.stringify(ltLevels)}`);

      // Publish with product identifier
      await messageBus.publish(CHANNELS.LT_LEVELS, {
        ...ltLevels,
        product
      });

    } catch (error) {
      logger.error(`Error handling LT update for ${product}:`, error);
    }
  }

  /**
   * Handle LS sentiment update from a monitor
   */
  async handleLsUpdate(product, lsStatus) {
    try {
      logger.info(`LS sentiment for ${product}: ${lsStatus.sentiment}`);
      await messageBus.publish(CHANNELS.LS_STATUS, { ...lsStatus, product });
    } catch (error) {
      logger.error(`Error handling LS update for ${product}:`, error);
    }
  }

  /**
   * Schedule GEX refresh at configured time
   */
  scheduleGexRefresh() {
    setInterval(async () => {
      try {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const [targetHour, targetMinute] = config.GEX_FETCH_TIME.split(':').map(Number);

        if (hour === targetHour && minute === targetMinute) {
          for (const [product, calculator] of this.gexCalculators) {
            try {
              logger.info(`Refreshing GEX levels for ${product} at scheduled time...`);
              const levels = await calculator.calculateLevels(true);
              await messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product });
              logger.info(`GEX levels for ${product} published`);
            } catch (err) {
              logger.error(`GEX refresh for ${product} failed:`, err.message);
            }
          }
        }
      } catch (error) {
        logger.error('Error in GEX refresh schedule:', error);
      }
    }, 60000);
  }

  // === Public API methods (called by HTTP routes) ===

  /**
   * Get GEX levels for a product
   * @param {string} product - 'NQ' or 'ES'
   */
  getGexLevels(product = 'NQ') {
    const calculator = this.gexCalculators.get(product.toUpperCase());
    return calculator?.getCurrentLevels() || null;
  }

  /**
   * Force GEX refresh for a product
   * @param {string} product - 'NQ' or 'ES'
   */
  async refreshGexLevels(product = 'NQ') {
    const key = product.toUpperCase();
    const calculator = this.gexCalculators.get(key);
    if (!calculator) throw new Error(`No GEX calculator for ${key}`);

    const levels = await calculator.calculateLevels(true);
    await messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product: key });
    return levels;
  }

  /**
   * Get candle history
   */
  getCandles(symbol, count) {
    return this.candleManager.getCandles(symbol.toUpperCase(), count);
  }

  /**
   * Get hourly candle history
   */
  getHourlyCandles(symbol, count) {
    return this.candleManager.getHourlyCandles(symbol.toUpperCase(), count);
  }

  /**
   * Get daily candle history
   */
  getDailyCandles(symbol, count) {
    return this.candleManager.getDailyCandles(symbol.toUpperCase(), count);
  }

  /**
   * Get IV skew data
   */
  getIVSkew() {
    return this.ivSkewCalculator?.getCurrentIVSkew() || null;
  }

  /**
   * Get IV skew history
   */
  getIVHistory() {
    return this.ivSkewCalculator?.getSkewHistory() || [];
  }

  /**
   * Get exposure levels from Tradier
   */
  getExposureLevels() {
    return this.tradierExposureService?.getCurrentExposures() || null;
  }

  /**
   * Force Tradier exposure refresh
   */
  async refreshExposure() {
    if (!this.tradierExposureService) throw new Error('Tradier service not available');
    return await this.tradierExposureService.forceRefresh();
  }

  /**
   * Get VEX levels
   */
  getVexLevels() {
    const exposures = this.tradierExposureService?.getCurrentExposures();
    if (!exposures?.futures) return null;

    const vexData = {};
    for (const [symbol, data] of Object.entries(exposures.futures)) {
      vexData[symbol] = {
        symbol,
        timestamp: exposures.timestamp,
        futuresPrice: data.futuresPrice,
        totalVex: data.totals.vex,
        regime: data.regime.vex,
        levels: data.levels
      };
    }
    return vexData;
  }

  /**
   * Get CEX levels
   */
  getCexLevels() {
    const exposures = this.tradierExposureService?.getCurrentExposures();
    if (!exposures?.futures) return null;

    const cexData = {};
    for (const [symbol, data] of Object.entries(exposures.futures)) {
      cexData[symbol] = {
        symbol,
        timestamp: exposures.timestamp,
        futuresPrice: data.futuresPrice,
        totalCex: data.totals.cex,
        regime: data.regime.cex,
        levels: data.levels
      };
    }
    return cexData;
  }

  /**
   * Get LT levels for a product
   */
  getLtLevels(product = 'NQ') {
    const monitor = this.ltMonitors.get(product.toUpperCase());
    return monitor?.getCurrentLevels() || null;
  }

  /**
   * Get LS sentiment for a product
   */
  getLsSentiment(product = 'NQ') {
    const monitor = this.ltMonitors.get(product.toUpperCase());
    return monitor?.getCurrentLsSentiment() || null;
  }

  /**
   * Get Tradier service status
   */
  getTradierStatus() {
    const health = this.tradierExposureService?.getHealthStatus() || null;
    const wsStatus = health?.websocket?.status || 'initializing';
    const statusMap = {
      'connected': 'Active',
      'market_closed': 'Market Closed',
      'disconnected': 'Disconnected',
      'reconnecting': 'Reconnecting',
      'initializing': 'Initializing'
    };

    return {
      available: !!this.tradierExposureService,
      active: !!this.tradierExposureService?.isRunning,
      initialized: this.tradierExposureService?.isInitialized || false,
      running: this.tradierExposureService?.isRunning || false,
      health,
      displayStatus: statusMap[wsStatus] || wsStatus,
      websocketStatus: wsStatus,
      config: {
        enabled: config.TRADIER_ENABLED,
        autoStart: config.TRADIER_AUTO_START,
        hasToken: !!config.TRADIER_ACCESS_TOKEN
      }
    };
  }

  /**
   * Enable Tradier service manually
   */
  async enableTradier() {
    if (!this.tradierExposureService) {
      throw new Error('Tradier service not configured');
    }
    if (!this.tradierExposureService.isInitialized) {
      await this.tradierExposureService.initialize();
    }
    await this.tradierExposureService.start();
    return { success: true, message: 'Tradier service enabled' };
  }

  /**
   * Disable Tradier service manually
   */
  async disableTradier() {
    if (!this.tradierExposureService) {
      return { success: true, message: 'Tradier service not available' };
    }
    await this.tradierExposureService.stop();
    return { success: true, message: 'Tradier service disabled' };
  }

  /**
   * Update TradingView JWT token
   */
  async updateTradingViewToken(token) {
    const redisUrl = config.getRedisUrl();

    await cacheTokenInRedis(redisUrl, token);
    logger.info('Manual token cached in Redis');

    if (this.tradingViewClient) {
      this.tradingViewClient.jwtToken = token;
      this.tradingViewClient.tokenRefreshRetryCount = 0;
      this.tradingViewClient.stopTokenRefreshSchedule?.();
      await this.tradingViewClient.reconnectWithNewToken();
      logger.info('TradingView client reconnected with new token');
    }

    // Update all LT monitors
    for (const [product, monitor] of this.ltMonitors) {
      try {
        await monitor.updateToken(token);
        logger.info(`LT monitor ${product} updated with new token`);
      } catch (err) {
        logger.error(`LT monitor ${product} token update failed:`, err.message);
      }
    }

    const ttl = getTokenTTL(token);
    return {
      success: true,
      message: 'Token updated and connections reconnected',
      tokenTTL: ttl,
      authState: this.tradingViewClient?.authState || 'unknown'
    };
  }

  /**
   * Health check
   */
  getHealth() {
    const gexStatus = {};
    for (const [key, calc] of this.gexCalculators) {
      gexStatus[key] = calc.getCurrentLevels() ? 'ready' : 'no_data';
    }

    const ltStatus = {};
    for (const [key, monitor] of this.ltMonitors) {
      ltStatus[key] = monitor.isConnected() ? 'connected' : 'disconnected';
    }

    return {
      service: config.SERVICE_NAME,
      status: this.isRunning ? 'running' : 'stopped',
      timestamp: new Date().toISOString(),
      components: {
        tradingview: this.tradingViewClient?.isConnected() ? 'connected' : 'disconnected',
        gex: gexStatus,
        lt: ltStatus,
        tradier: this.tradierExposureService
          ? (this.tradierExposureService.isRunning ? 'running' : 'available')
          : 'not_configured',
        iv_skew: this.ivSkewCalculator ? 'ready' : 'not_available'
      },
      connectionDetails: {
        tradingview: {
          connected: this.tradingViewClient?.isConnected() || false,
          authState: this.tradingViewClient?.authState || 'unknown',
          tokenTTL: this.tradingViewClient?.jwtToken ? getTokenTTL(this.tradingViewClient.jwtToken) : null,
          lastHeartbeat: this.tradingViewClient?.lastHeartbeat?.toISOString() || null,
          lastQuoteReceived: this.tradingViewClient?.lastQuoteReceived?.toISOString() || null,
          reconnectAttempts: this.tradingViewClient?.reconnectAttempts || 0
        },
        ltMonitors: Object.fromEntries(
          Array.from(this.ltMonitors.entries()).map(([key, m]) => [key, {
            connected: m.isConnected() || false,
            hasLevels: !!m.currentLevels,
            lastHeartbeat: m.lastHeartbeat?.toISOString() || null,
            reconnectAttempts: m.reconnectAttempts || 0
          }])
        ),
        hybridGex: Object.fromEntries(
          Array.from(this.hybridGexCalculators.entries()).map(([key, h]) => [key,
            typeof h.getHealthStatus === 'function' ? h.getHealthStatus() : null
          ])
        )
      },
      candles: this.candleManager.getStats(),
      tradier: this.getTradierStatus()
    };
  }

  async stop() {
    try {
      logger.info('Stopping Data Service...');
      this.isRunning = false;

      if (this.tradingViewClient) {
        this.tradingViewClient.disconnect();
      }

      for (const [key, monitor] of this.ltMonitors) {
        await monitor.disconnect();
      }

      if (this.tradierExposureService) {
        await this.tradierExposureService.stop();
      }

      logger.info('Data Service stopped');
    } catch (error) {
      logger.error('Error stopping Data Service:', error);
    }
  }
}

// Create and export singleton
const service = new DataService();

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
