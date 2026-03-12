import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';
import TradierClient from './tradier-client.js';
import SchwabClient from '../schwab/schwab-client.js';
import OptionsChainManager from './options-chain-manager.js';
import ExposureCalculator from './exposure-calculator.js';
import FuturesConverter from './futures-converter.js';
import IVSkewCalculator from './iv-skew-calculator.js';
import config from '../utils/config.js';
import { isGexCalculationHours, getCurrentSession } from '../utils/session-utils.js';

class OptionsExposureService {
  constructor(options = {}) {
    this.config = config.getTradierConfig();
    this.provider = this.config.useSchwab ? 'schwab' : 'tradier';
    this.logger = createLogger(`${this.provider}-exposure-service`);

    // Allow strategy-driven symbol override
    if (options.symbols) {
      this.config.symbols = options.symbols;
    }
    this.isRunning = false;
    this.isInitialized = false;

    // Components
    this.tradierClient = null;
    this.chainManager = null;
    this.exposureCalculator = null;
    this.futuresConverter = null;
    this.ivSkewCalculator = null;

    // Current data
    this.currentExposures = null;
    this.currentIVSkew = null;
    this.shortDTEIVCalculator = null;  // Set externally by data-service
    this.lastCalculation = null;
    this.spotPrices = {};

    // Processing state
    this.isCalculating = false;
    this.calculationInterval = null;
    this.calculationFrequency = 2 * 60 * 1000; // 2 minutes
    this.pricePollingTimer = null; // Timer for REST price polling

    // Callbacks
    this.updateCallbacks = [];
  }

  /**
   * Initialize the service
   */
  async initialize() {
    if (this.isInitialized) {
      this.logger.warn('Exposure service already initialized');
      return;
    }

    try {
      this.logger.info(`Initializing ${this.provider} exposure service...`);

      // Initialize API client (Schwab or Tradier)
      if (this.config.useSchwab && this.config.schwabAppKey) {
        this.logger.info('Using Schwab API for options data');
        this.tradierClient = new SchwabClient({
          appKey: this.config.schwabAppKey,
          appSecret: this.config.schwabAppSecret,
          callbackUrl: this.config.schwabCallbackUrl,
          redisUrl: config.getRedisUrl()
        });
      } else if (this.config.accessToken) {
        this.logger.info('Using Tradier API for options data');
        this.tradierClient = new TradierClient({
          accessToken: this.config.accessToken,
          baseUrl: this.config.baseUrl,
          accountId: this.config.accountId
        });
      } else {
        throw new Error('No options data provider configured (set SCHWAB_ENABLED or TRADIER_ACCESS_TOKEN)');
      }

      // Test connection
      const connected = await this.tradierClient.testConnection();
      if (!connected) {
        throw new Error(`Failed to connect to ${this.provider} API`);
      }

      // Initialize chain manager
      this.chainManager = new OptionsChainManager({
        tradierClient: this.tradierClient,
        symbols: this.config.symbols,
        maxExpirations: this.config.maxExpirations,
        pollIntervalMinutes: this.config.pollInterval
      });

      // Initialize exposure calculator
      this.exposureCalculator = new ExposureCalculator({
        riskFreeRate: this.config.riskFreeRate
      });

      // Initialize futures converter
      this.futuresConverter = new FuturesConverter({
        redisUrl: config.getRedisUrl(),
        tradierClient: this.tradierClient
      });

      await this.futuresConverter.initialize();

      // Initialize IV Skew calculator
      this.ivSkewCalculator = new IVSkewCalculator({
        symbol: 'QQQ',  // Calculate IV skew from QQQ options
        publishToRedis: true
      });
      this.logger.info('IV Skew calculator initialized');

      // Set up WebSocket for real-time quotes
      this.setupWebSocketQuotes();

      this.isInitialized = true;
      this.logger.info(`${this.provider} exposure service initialized successfully`);

    } catch (error) {
      this.logger.error(`Failed to initialize ${this.provider} exposure service:`, error.message);
      throw error;
    }
  }

  /**
   * Start the service
   */
  async start() {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (this.isRunning) {
      this.logger.warn(`${this.provider} exposure service already running`);
      return;
    }

    try {
      this.logger.info(`Starting ${this.provider} exposure service...`);

      // Start chain manager
      this.chainManager.start();

      // Start WebSocket for quotes (optional - may fail in sandbox)
      try {
        await this.tradierClient.connectWebSocket(this.config.symbols);
        this.logger.info(`${this.provider} WebSocket connected successfully`);
      } catch (error) {
        this.logger.warn(`${this.provider} WebSocket connection failed (using REST polling instead):`, error.message);
        // Start REST polling for price updates instead
        this.startPricePolling();
      }

      // Start calculation timer
      this.startCalculationTimer();

      // Initial calculation
      setTimeout(() => {
        this.calculateExposures().catch(error => {
          this.logger.error('Initial exposure calculation failed:', error.message);
        });
      }, 5000); // Wait 5 seconds for initial data

      this.isRunning = true;
      this.logger.info(`${this.provider} exposure service started`);

    } catch (error) {
      this.logger.error(`Failed to start ${this.provider} exposure service:`, error.message);
      throw error;
    }
  }

  /**
   * Stop the service
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.logger.info(`Stopping ${this.provider} exposure service...`);

    // Stop calculation timer
    if (this.calculationInterval) {
      clearInterval(this.calculationInterval);
      this.calculationInterval = null;
    }

    // Stop price polling timer
    if (this.pricePollingTimer) {
      clearInterval(this.pricePollingTimer);
      this.pricePollingTimer = null;
    }

    // Stop chain manager
    if (this.chainManager) {
      this.chainManager.stop();
    }

    // Disconnect WebSocket
    if (this.tradierClient) {
      this.tradierClient.disconnect();
    }

    // Cleanup futures converter
    if (this.futuresConverter) {
      await this.futuresConverter.cleanup();
    }

    this.isRunning = false;
    this.logger.info(`${this.provider} exposure service stopped`);
  }

  /**
   * Set up WebSocket quotes handling
   */
  setupWebSocketQuotes() {
    this.tradierClient.setQuotesCallback((message) => {
      if (message.type === 'quote' || message.type === 'trade') {
        const symbol = message.symbol;
        const price = parseFloat(message.last || message.price);

        if (symbol && price && this.config.symbols.includes(symbol)) {
          this.spotPrices[symbol] = price;
          this.logger.debug(`Updated ${symbol} price: ${price}`);
        }
      }
    });
  }

  /**
   * Start polling for price updates via REST API (fallback when WebSocket unavailable)
   */
  startPricePolling() {
    if (this.pricePollingTimer) {
      clearInterval(this.pricePollingTimer);
    }

    const pollPrices = async () => {
      try {
        const quotes = await this.tradierClient.getQuotes(this.config.symbols);

        if (quotes && quotes.quotes) {
          const quoteArray = Array.isArray(quotes.quotes.quote) ? quotes.quotes.quote : [quotes.quotes.quote];

          for (const quote of quoteArray) {
            if (quote && quote.symbol && quote.last) {
              const symbol = quote.symbol;
              const price = parseFloat(quote.last);

              if (this.config.symbols.includes(symbol)) {
                this.spotPrices[symbol] = price;
                this.logger.debug(`Updated ${symbol} price (REST): ${price}`);
              }
            }
          }
        }
      } catch (error) {
        this.logger.warn('Price polling failed:', error.message);
      }
    };

    // Poll every 30 seconds for price updates
    this.pricePollingTimer = setInterval(pollPrices, 30000);

    // Initial poll
    pollPrices();

    this.logger.info('Started price polling via REST API (30s interval)');
  }

  /**
   * Start calculation timer
   */
  startCalculationTimer() {
    this.calculationInterval = setInterval(() => {
      if (!this.isCalculating) {
        this.calculateExposures().catch(error => {
          this.logger.error('Scheduled exposure calculation failed:', error.message);
        });
      }
    }, this.calculationFrequency);
  }

  /**
   * Calculate exposures for all symbols
   * Skips calculations outside GEX calculation hours (9:30 AM - 4:30 PM EST)
   * Allows initial calculation on startup to populate cache
   */
  async calculateExposures(force = false) {
    // Skip calculations outside GEX hours, but allow initial sync if no cached data
    const hasCachedData = this.currentExposures !== null;
    if (!isGexCalculationHours() && hasCachedData) {
      const session = getCurrentSession();
      this.logger.debug(`Skipping exposure calculation - outside GEX hours (session: ${session})`);
      return this.currentExposures;
    }

    if (this.isCalculating && !force) {
      this.logger.debug('Exposure calculation already in progress');
      return this.currentExposures;
    }

    this.isCalculating = true;
    const startTime = Date.now();
    const isInitialSync = !hasCachedData;

    try {
      this.logger.info(`Calculating exposures...${isInitialSync ? ' (initial sync)' : ''}`);

      // Get latest chains data
      const chainsData = this.chainManager.getAllCachedChains();

      // Check if we have data
      const hasData = Object.values(chainsData).some(chains => chains.length > 0);
      if (!hasData) {
        this.logger.warn('No options chain data available yet');
        return this.currentExposures;
      }

      // Profiling: count options loaded per symbol
      const chainStats = {};
      for (const [sym, chains] of Object.entries(chainsData)) {
        const totalOptions = chains.reduce((sum, c) => sum + (c.options?.length || 0), 0);
        chainStats[sym] = { expirations: chains.length, options: totalOptions };
      }

      // Get current spot prices (fallback if WebSocket not updated)
      const t0 = Date.now();
      let currentSpotPrices = { ...this.spotPrices };

      // Fill missing spot prices
      for (const symbol of this.config.symbols) {
        if (!currentSpotPrices[symbol]) {
          try {
            const quotes = await this.tradierClient.getQuotes([symbol]);
            if (quotes?.quotes?.quote) {
              const quote = Array.isArray(quotes.quotes.quote) ? quotes.quotes.quote[0] : quotes.quotes.quote;
              if (quote.last) {
                currentSpotPrices[symbol] = parseFloat(quote.last);
              }
            }
          } catch (error) {
            this.logger.warn(`Failed to get ${symbol} quote:`, error.message);
          }
        }
      }
      const quotesMs = Date.now() - t0;

      this.logger.debug('Current spot prices:', currentSpotPrices);

      // Calculate exposures
      const t1 = Date.now();
      const exposureResults = this.exposureCalculator.calculateExposures(chainsData, currentSpotPrices);
      const exposureMs = Date.now() - t1;

      // Calculate IV skew (use QQQ spot price)
      const t2 = Date.now();
      if (this.ivSkewCalculator && currentSpotPrices.QQQ) {
        try {
          this.currentIVSkew = this.ivSkewCalculator.calculateIVSkew(currentSpotPrices.QQQ, chainsData);
        } catch (error) {
          this.logger.warn('IV skew calculation failed:', error.message);
        }
      }

      // Update short-DTE IV calculator (0-2 DTE, publishes to Redis)
      if (this.shortDTEIVCalculator && currentSpotPrices.QQQ) {
        try {
          await this.shortDTEIVCalculator.update(currentSpotPrices.QQQ, chainsData);
        } catch (error) {
          this.logger.warn('Short-DTE IV update failed:', error.message);
        }
      }
      const skewMs = Date.now() - t2;

      // Convert to futures if we have results
      let convertedResults = {};
      if (Object.keys(exposureResults).length > 0) {
        // Update futures ratios
        const t3 = Date.now();
        await this.futuresConverter.updateRatios();
        const ratioMs = Date.now() - t3;

        // Convert exposures to futures
        convertedResults = this.futuresConverter.convertExposures(exposureResults);

        // Store results
        const totalMs = Date.now() - startTime;
        this.currentExposures = {
          timestamp: new Date().toISOString(),
          raw: exposureResults,
          futures: convertedResults,
          spotPrices: currentSpotPrices,
          ratios: this.futuresConverter.getRatioInfo(),
          calculationTime: totalMs
        };

        this.lastCalculation = Date.now();

        // Publish to Redis channels
        await this.publishExposures(this.currentExposures);

        // Trigger callbacks
        this.triggerCallbacks(this.currentExposures);

        // Profiling summary
        const statsStr = Object.entries(chainStats).map(([s, v]) => `${s}: ${v.expirations} exp, ${v.options} opts`).join(' | ');
        this.logger.info(`Exposure calculation completed in ${totalMs}ms [quotes=${quotesMs}ms, exposure=${exposureMs}ms, skew=${skewMs}ms, ratios=${ratioMs}ms] (${statsStr})`);
      }

      return this.currentExposures;

    } catch (error) {
      this.logger.error('Exposure calculation failed:', error.message);
      throw error;
    } finally {
      this.isCalculating = false;
    }
  }

  /**
   * Publish exposure results to Redis channels
   */
  async publishExposures(exposures) {
    try {
      // Publish comprehensive exposure data
      await messageBus.publish(CHANNELS.EXPOSURE_LEVELS, exposures);

      // Note: ES GEX levels are NOT published here because the hybrid GEX calculator
      // in data-service already merges Tradier + CBOE data and publishes to gex.levels
      // in the flat format that signal-generator/dashboard expects (futures_spot, callWall,
      // putWall, support[], resistance[]). Publishing here with a nested format would
      // overwrite the hybrid data and break the dashboard display.

      if (exposures.futures.NQ) {
        await messageBus.publish(CHANNELS.VEX_LEVELS, {
          timestamp: exposures.timestamp,
          symbol: 'NQ',
          futuresPrice: exposures.futures.NQ.futuresPrice,
          totalVex: exposures.futures.NQ.totals.vex,
          regime: exposures.futures.NQ.regime.vex,
          levels: exposures.futures.NQ.levels,
          source: this.provider
        });

        await messageBus.publish(CHANNELS.CEX_LEVELS, {
          timestamp: exposures.timestamp,
          symbol: 'NQ',
          futuresPrice: exposures.futures.NQ.futuresPrice,
          totalCex: exposures.futures.NQ.totals.cex,
          regime: exposures.futures.NQ.regime.cex,
          levels: exposures.futures.NQ.levels,
          source: this.provider
        });
      }

      this.logger.debug('Published exposure data to Redis channels');

    } catch (error) {
      this.logger.error('Failed to publish exposures:', error.message);
    }
  }

  /**
   * Trigger update callbacks
   */
  triggerCallbacks(exposures) {
    for (const callback of this.updateCallbacks) {
      try {
        callback(exposures);
      } catch (error) {
        this.logger.warn('Exposure callback error:', error.message);
      }
    }
  }

  /**
   * Add update callback
   */
  addUpdateCallback(callback) {
    this.updateCallbacks.push(callback);
  }

  /**
   * Remove update callback
   */
  removeUpdateCallback(callback) {
    const index = this.updateCallbacks.indexOf(callback);
    if (index > -1) {
      this.updateCallbacks.splice(index, 1);
    }
  }

  /**
   * Force refresh of all data
   */
  async forceRefresh() {
    this.logger.info('Forcing exposure refresh...');

    try {
      // Clear chains cache and force refresh
      this.chainManager.clearCache();
      await this.chainManager.forceRefresh();

      // Force ratio update
      await this.futuresConverter.forceUpdateRatios();

      // Force exposure calculation
      await this.calculateExposures(true);

      this.logger.info('Exposure refresh completed');
      return this.currentExposures;

    } catch (error) {
      this.logger.error('Exposure refresh failed:', error.message);
      throw error;
    }
  }

  /**
   * Get current exposures
   */
  getCurrentExposures() {
    return this.currentExposures;
  }

  /**
   * Get current IV skew data
   */
  getCurrentIVSkew() {
    return this.ivSkewCalculator?.getCurrentIVSkew() || null;
  }

  /**
   * Get IV skew calculator instance
   */
  getIVSkewCalculator() {
    return this.ivSkewCalculator;
  }

  /**
   * Get the NQ/QQQ ratio (for use as fallback by other calculators)
   * Returns the cached RTH ratio if available, otherwise the current ratio
   */
  getNQRatio() {
    if (!this.futuresConverter) return null;

    const ratioInfo = this.futuresConverter.getRatioInfo();

    // Prefer RTH cached ratio if available (more stable during off-hours)
    if (ratioInfo.rthCache?.NQ_QQQ) {
      return {
        multiplier: ratioInfo.rthCache.NQ_QQQ,
        timestamp: ratioInfo.rthCache.timestamp,
        source: `${this.provider}-rth-cache`
      };
    }

    // Fall back to current ratio
    if (ratioInfo.current?.NQ_QQQ) {
      return {
        multiplier: ratioInfo.current.NQ_QQQ,
        timestamp: ratioInfo.current.lastUpdate,
        source: `${this.provider}-current`
      };
    }

    return null;
  }

  /**
   * Get service health status
   */
  getHealthStatus() {
    const rateLimitStatus = this.tradierClient?.getRateLimitStatus();
    const cacheStats = this.chainManager?.getCacheStats();
    const websocketStatus = this.tradierClient?.getMarketStatus();

    return {
      isRunning: this.isRunning,
      isInitialized: this.isInitialized,
      isCalculating: this.isCalculating,
      lastCalculation: this.lastCalculation,
      hasCurrentData: !!this.currentExposures,
      spotPrices: this.spotPrices,
      rateLimits: rateLimitStatus,
      cache: cacheStats,
      ratios: this.futuresConverter?.getRatioInfo(),
      symbols: this.config.symbols,
      chainCount: cacheStats?.totalChains || 0,
      websocket: websocketStatus
    };
  }

  /**
   * Backward compatibility: implement the legacy GEX calculator interface
   */
  async calculateLevels(force = false) {
    const exposures = await this.calculateExposures(force);

    if (!exposures || !exposures.futures.NQ) {
      return null;
    }

    const nqData = exposures.futures.NQ;

    return {
      timestamp: exposures.timestamp,
      nqSpot: nqData.futuresPrice,
      qqqSpot: nqData.originalSpotPrice,
      totalGex: nqData.totals.gex / 1e9, // Convert to billions
      regime: nqData.regime.gex,
      gammaFlip: nqData.levels.gammaFlip,
      callWall: nqData.levels.callWall,
      putWall: nqData.levels.putWall,
      resistance: nqData.levels.resistance,
      support: nqData.levels.support,
      fromCache: false,
      usedLivePrices: true,
      dataSource: this.provider,
      // Additional fields for enhanced data
      totalVex: nqData.totals.vex / 1e9,
      totalCex: nqData.totals.cex / 1e9,
      overallRegime: nqData.regime.overall
    };
  }

  /**
   * Get current levels (backward compatibility)
   */
  getCurrentLevels() {
    if (!this.currentExposures || !this.currentExposures.futures.NQ) {
      return null;
    }

    return this.convertToLegacyFormat(this.currentExposures.futures.NQ);
  }

  /**
   * Convert to legacy GEX levels format for backward compatibility
   */
  convertToLegacyFormat(nqData) {
    return {
      timestamp: this.currentExposures.timestamp,
      nqSpot: nqData.futuresPrice,
      qqqSpot: nqData.originalSpotPrice,
      totalGex: nqData.totals.gex / 1e9,
      regime: nqData.regime.gex,
      gammaFlip: nqData.levels.gammaFlip,
      callWall: nqData.levels.callWall,
      putWall: nqData.levels.putWall,
      resistance: nqData.levels.resistance,
      support: nqData.levels.support,
      fromCache: false,
      usedLivePrices: true,
      dataSource: this.provider
    };
  }
}

export default OptionsExposureService;