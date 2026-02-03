// Signal Generator Service - Main entry point
import { createLogger, messageBus } from '../../shared/index.js';
import config from './utils/config.js';
import TradingViewClient from './websocket/tradingview-client.js';
import LTMonitor from './websocket/lt-monitor.js';
import GexCalculator from './gex/gex-calculator.js';
import TradierExposureService from './tradier/tradier-exposure-service.js';
import HybridGexCalculator from './gex/hybrid-gex-calculator.js';
import StrategyEngine from './strategy/engine.js';

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
  }

  async start() {
    try {
      logger.info('Starting Signal Generator Service...');
      console.log('🚀 CONSOLE: Starting Signal Generator Service...');


      // Connect to message bus
      logger.info('Connecting to message bus...');
      if (!messageBus.isConnected) {
        await messageBus.connect();
      }
      logger.info('✅ Connected to message bus successfully');

      // Initialize GEX services with hybrid approach
      const hybridEnabled = config.HYBRID_GEX_ENABLED && config.TRADIER_ACCESS_TOKEN && config.TRADIER_ENABLED;

      if (hybridEnabled) {
        logger.info('🔄 Initializing Hybrid GEX Calculator (Tradier + CBOE)...');

        // Initialize Tradier service for the hybrid calculator
        this.tradierExposureService = new TradierExposureService();

        try {
          if (config.TRADIER_AUTO_START) {
            await this.tradierExposureService.initialize();
            await this.tradierExposureService.start();
            logger.info('✅ Tradier service initialized and started for hybrid mode');
          } else {
            await this.tradierExposureService.initialize();
            logger.info('📍 Tradier service initialized but not started (manual start enabled)');
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
              symbol: config.GEX_SYMBOL,
              cacheFile: config.GEX_CACHE_FILE,
              cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
              redisUrl: config.getRedisUrl()
            }
          });

          await this.hybridGexCalculator.initialize();

          // Set backward compatibility
          this.gexCalculator = this.hybridGexCalculator;

          logger.info('✅ Hybrid GEX Calculator initialized successfully');
          logger.info(`📊 Configuration: Tradier every ${config.HYBRID_TRADIER_REFRESH_MINUTES || 3}min, CBOE every ${config.HYBRID_CBOE_REFRESH_MINUTES || 15}min`);

        } catch (error) {
          logger.error('Failed to initialize hybrid calculator:', error.message);
          logger.info('Falling back to CBOE-only mode...');

          // Fallback to CBOE only
          this.gexCalculator = new GexCalculator({
            symbol: config.GEX_SYMBOL,
            cacheFile: config.GEX_CACHE_FILE,
            cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
            redisUrl: config.getRedisUrl()
          });
          await this.gexCalculator.loadCachedLevels();
          logger.info('✅ CBOE GEX Calculator initialized as fallback');
        }
      } else if (config.TRADIER_ACCESS_TOKEN && config.TRADIER_ENABLED && config.TRADIER_AUTO_START) {
        logger.info('Initializing Tradier-only mode...');
        this.tradierExposureService = new TradierExposureService();

        try {
          await this.tradierExposureService.initialize();
          await this.tradierExposureService.start();
          this.gexCalculator = this.tradierExposureService;
          logger.info('✅ Tradier Exposure Service initialized and started');
        } catch (error) {
          logger.error('Failed to initialize Tradier service:', error.message);
          logger.info('Falling back to CBOE GEX Calculator...');

          this.gexCalculator = new GexCalculator({
            symbol: config.GEX_SYMBOL,
            cacheFile: config.GEX_CACHE_FILE,
            cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
            redisUrl: config.getRedisUrl()
          });
          await this.gexCalculator.loadCachedLevels();
          logger.info('✅ CBOE GEX Calculator initialized as fallback');
        }
      } else if (config.TRADIER_ACCESS_TOKEN && config.TRADIER_ENABLED && !config.TRADIER_AUTO_START) {
        logger.info('Tradier configured but auto-start disabled, using CBOE...');
        this.tradierExposureService = new TradierExposureService();
        this.gexCalculator = new GexCalculator({
          symbol: config.GEX_SYMBOL,
          cacheFile: config.GEX_CACHE_FILE,
          cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
          redisUrl: config.getRedisUrl()
        });
        await this.gexCalculator.loadCachedLevels();
        logger.info('✅ CBOE GEX Calculator initialized, Tradier ready for manual start');
      } else {
        const reason = !config.TRADIER_ACCESS_TOKEN ? 'No Tradier token configured' : 'Tradier disabled in configuration';
        logger.info(`${reason}, using CBOE-only mode...`);
        this.gexCalculator = new GexCalculator({
          symbol: config.GEX_SYMBOL,
          cacheFile: config.GEX_CACHE_FILE,
          cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
          redisUrl: config.getRedisUrl()
        });
        await this.gexCalculator.loadCachedLevels();
        logger.info('✅ CBOE GEX Calculator initialized');
      }

      // Initialize Strategy Engine
      this.strategyEngine = new StrategyEngine(this.gexCalculator);

      // Wire up IV Skew calculator to strategy engine (if Tradier service has it)
      if (this.tradierExposureService?.ivSkewCalculator) {
        this.ivSkewCalculator = this.tradierExposureService.ivSkewCalculator;
        this.strategyEngine.setIVSkewCalculator(this.ivSkewCalculator);
        logger.info('✅ IV Skew calculator wired to strategy engine');
      } else {
        logger.warn('⚠️ IV Skew calculator not available (Tradier service may not be running)');
      }

      // Initialize TradingView Client
      this.tradingViewClient = new TradingViewClient({
        symbols: config.OHLCV_SYMBOLS,
        ltSymbol: config.LT_SYMBOL,
        ltTimeframe: config.LT_TIMEFRAME,
        jwtToken: config.TRADINGVIEW_JWT_TOKEN,
        credentials: config.TRADINGVIEW_CREDENTIALS,
        redisUrl: config.getRedisUrl()
      });

      // Set up TradingView event listeners
      this.tradingViewClient.on('quote', (quote) => this.handleQuoteUpdate(quote));

      // Start TradingView connection
      logger.info('🔌 Connecting to TradingView WebSocket...');
      try {
        await this.tradingViewClient.connect();
        logger.info('✅ TradingView WebSocket connected successfully');
      } catch (error) {
        logger.error('❌ Failed to connect to TradingView:', error.message);
        throw error;
      }

      // Start streaming data for all symbols
      logger.info('📡 Starting TradingView data streaming...');
      try {
        await this.tradingViewClient.startStreaming();
        logger.info('📊 TradingView streaming started for all symbols');
      } catch (error) {
        logger.error('❌ Failed to start TradingView streaming:', error.message);
        throw error;
      }

      // Initialize and start LT Monitor for NQ
      if (config.LT_SYMBOL && config.LT_SYMBOL.includes('NQ')) {
        logger.info('🎯 Initializing LT monitor for NQ...');
        this.ltMonitor = new LTMonitor({
          symbol: config.LT_SYMBOL,
          timeframe: config.LT_TIMEFRAME,
          jwtToken: config.TRADINGVIEW_JWT_TOKEN
        });

        // Set up LT event listener
        this.ltMonitor.on('lt_levels', (ltLevels) => this.handleLtUpdate(ltLevels));

        try {
          await this.ltMonitor.connect();
          await this.ltMonitor.startMonitoring();
          logger.info('✅ LT monitor started successfully');
        } catch (error) {
          logger.error('❌ Failed to start LT monitor:', error.message);
          // Don't throw - LT is optional
        }
      }

      // Start Tradier service if initialized and auto-start enabled, or set up GEX refresh schedule
      if (this.tradierExposureService && this.gexCalculator === this.tradierExposureService) {
        logger.info('Starting Tradier Exposure Service...');
        await this.tradierExposureService.start();
        logger.info('✅ Tradier Exposure Service started');
      } else {
        // Set up GEX refresh schedule for CBOE fallback
        this.scheduleGexRefresh();
      }

      // Sync position state from Tradovate before starting strategy evaluation
      // This prevents duplicate signals if the service restarts while in a position
      await this.strategyEngine.syncPositionState();

      // Start strategy engine
      this.strategyEngine.run().catch(error => {
        logger.error('Strategy engine error:', error);
      });

      this.isRunning = true;
      logger.info('Signal Generator Service started successfully');

      // Publish service health
      await messageBus.publish('service.health', {
        service: 'signal-generator',
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
      if (quote.candleTimestamp && quote.baseSymbol === 'NQ') {
        const isNewCandle = this.strategyEngine.processCandle({
          symbol: quote.symbol,
          timestamp: quote.timestamp,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          close: quote.close,
          volume: quote.volume
        });

        // When a new candle closes, evaluate strategy on the closed candle
        if (isNewCandle) {
          const closedCandle = this.strategyEngine.candleBuffer.getLastClosedCandle();
          if (closedCandle) {
            logger.info(`🕯️ 1-minute candle closed: ${closedCandle.close} @ ${closedCandle.timestamp}`);
            await this.strategyEngine.evaluateCandle(closedCandle);
          }
        }
      }

      // Always publish quote to message bus for other services (like monitoring-service/frontend)
      await messageBus.publish('price.update', {
        symbol: quote.symbol,
        baseSymbol: quote.baseSymbol,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        previousClose: quote.previousClose,
        volume: quote.volume,
        timestamp: quote.timestamp,
        source: quote.source
      });

    } catch (error) {
      logger.error('Error handling quote update:', error);
    }
  }

  async handleLtUpdate(ltLevels) {
    try {
      logger.info(`LT levels updated: ${JSON.stringify(ltLevels)}`);

      // Update strategy engine
      this.strategyEngine.setLtLevels(ltLevels);

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
      this.strategyEngine.setGexCalculator(this.gexCalculator);

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
        cacheFile: config.GEX_CACHE_FILE,
        cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
        redisUrl: config.getRedisUrl()
      });
      await gexCalculator.loadCachedLevels();

      this.gexCalculator = gexCalculator;

      // Update strategy engine reference
      this.strategyEngine.setGexCalculator(this.gexCalculator);

      // Restart GEX refresh schedule
      this.scheduleGexRefresh();

      logger.info('✅ Switched back to CBOE GEX Calculator');
      return { success: true, message: 'Tradier service disabled, switched to CBOE' };

    } catch (error) {
      logger.error('Failed to disable Tradier service:', error.message);
      throw error;
    }
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
      service: 'signal-generator',
      status: this.isRunning ? 'running' : 'stopped',
      timestamp: new Date().toISOString(),
      components: {
        tradingview: this.tradingViewClient?.isConnected() ? 'connected' : 'disconnected',
        lt_monitor: this.ltMonitor?.isConnected() ? 'connected' : 'disconnected',
        gex_calculator: this.gexCalculator ? 'ready' : 'not_initialized',
        strategy_engine: this.strategyEngine?.enabled ? 'enabled' : 'disabled',
        tradier_service: tradierStatus.active ? 'active' : (tradierStatus.available ? 'available' : 'unavailable')
      },
      // Connection details for dashboard monitoring
      connectionDetails: {
        tradingview: {
          connected: this.tradingViewClient?.isConnected() || false,
          lastHeartbeat: this.tradingViewClient?.lastHeartbeat?.toISOString() || null,
          lastQuoteReceived: this.tradingViewClient?.lastQuoteReceived?.toISOString() || null,
          reconnectAttempts: this.tradingViewClient?.reconnectAttempts || 0
        },
        ltMonitor: {
          connected: this.ltMonitor?.isConnected() || false,
          lastHeartbeat: this.ltMonitor?.lastHeartbeat?.toISOString() || null,
          hasLevels: !!this.ltMonitor?.currentLevels,
          reconnectAttempts: this.ltMonitor?.reconnectAttempts || 0
        },
        hybridGex: hybridHealth
      },
      config: {
        symbols: config.OHLCV_SYMBOLS,
        lt_symbol: config.LT_SYMBOL,
        gex_symbol: config.GEX_SYMBOL,
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