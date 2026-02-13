import { createLogger } from '../../../shared/index.js';
import Redis from 'ioredis';
import { isOptionsRTH, isOptionsRTHCached, tradierMarketClock } from '../utils/session-utils.js';

const logger = createLogger('futures-converter');

class FuturesConverter {
  constructor(options = {}) {
    this.redisUrl = options.redisUrl || 'redis://localhost:6379';
    this.tradierClient = options.tradierClient;

    // Current ratios (updated dynamically)
    this.ratios = {
      ES_SPY: null,
      NQ_QQQ: null,
      lastUpdate: null
    };

    // Fallback ratios (historical averages)
    this.fallbackRatios = {
      ES_SPY: 10.0,  // ES is roughly 10x SPY
      NQ_QQQ: 41.5   // NQ is roughly 41.5x QQQ
    };

    // RTH cache - stores last ratios from Regular Trading Hours
    // Used to freeze ratios during off-hours when options don't trade
    // Persisted to Redis to survive service restarts
    this.rthCache = {
      ES_SPY: null,
      NQ_QQQ: null,
      timestamp: null,
      qqqSpot: null,
      nqSpot: null,
      spySpot: null,
      esSpot: null
    };

    // Redis key for persisted RTH cache
    this.RTH_CACHE_KEY = 'gex:rth_cache:ratios';

    // Redis connection
    this.redis = null;
    this.isConnected = false;

    // Update frequency
    this.ratioUpdateInterval = 5 * 60 * 1000; // 5 minutes
    this.lastRatioUpdate = 0;
  }

  /**
   * Initialize Redis connection and load persisted RTH cache
   */
  async initialize() {
    try {
      this.redis = new Redis(this.redisUrl, {
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      await this.redis.connect();
      this.isConnected = true;
      logger.info('FuturesConverter connected to Redis');

      // Load persisted RTH cache from Redis (survives restarts)
      await this.loadRTHCacheFromRedis();

      // Initial ratio update
      await this.updateRatios();

    } catch (error) {
      logger.error('Failed to initialize FuturesConverter:', error.message);
      throw error;
    }
  }

  /**
   * Load RTH cache from Redis (persisted across restarts)
   */
  async loadRTHCacheFromRedis() {
    try {
      const cached = await this.redis.get(this.RTH_CACHE_KEY);
      if (cached) {
        this.rthCache = JSON.parse(cached);
        logger.info(`Loaded RTH cache from Redis: NQ/QQQ=${this.rthCache.NQ_QQQ?.toFixed(4)}, ES/SPY=${this.rthCache.ES_SPY?.toFixed(4)}, from ${this.rthCache.timestamp}`);
      } else {
        logger.info('No persisted RTH cache found in Redis');
      }
    } catch (error) {
      logger.warn('Failed to load RTH cache from Redis:', error.message);
    }
  }

  /**
   * Save RTH cache to Redis (persists across restarts)
   */
  async saveRTHCacheToRedis() {
    try {
      await this.redis.set(this.RTH_CACHE_KEY, JSON.stringify(this.rthCache));
      logger.info(`Saved RTH cache to Redis: NQ/QQQ=${this.rthCache.NQ_QQQ?.toFixed(4)}, ES/SPY=${this.rthCache.ES_SPY?.toFixed(4)}`);
    } catch (error) {
      logger.error('Failed to save RTH cache to Redis:', error.message);
    }
  }

  /**
   * Update ratio calculations using latest prices
   * During off-hours (including holidays), returns cached RTH ratios to prevent artificial drift
   * Uses Tradier market clock API for holiday awareness
   * Cache is persisted to Redis to survive service restarts
   */
  async updateRatios(force = false) {
    const now = Date.now();
    // Use Tradier-aware RTH check (handles holidays)
    const inRTH = await isOptionsRTH();
    const marketDesc = tradierMarketClock.getDescription();

    // Outside RTH (or holiday): use cached ratios to prevent drift from frozen QQQ prices
    if (!inRTH && this.rthCache.NQ_QQQ) {
      // Apply cached RTH ratios
      this.ratios.ES_SPY = this.rthCache.ES_SPY;
      this.ratios.NQ_QQQ = this.rthCache.NQ_QQQ;
      this.ratios.lastUpdate = this.rthCache.timestamp;

      const reason = marketDesc || 'outside RTH';
      logger.debug(`Options market closed (${reason}) - using cached ratios from ${this.rthCache.timestamp} (NQ/QQQ=${this.rthCache.NQ_QQQ?.toFixed(4)})`);
      return this.ratios;
    }

    // Outside RTH with no cache: use fallback ratios
    if (!inRTH && !this.rthCache.NQ_QQQ) {
      const reason = marketDesc || 'outside RTH';
      logger.warn(`Options market closed (${reason}) with no cached ratios - using fallback ratios`);
      this.ratios.ES_SPY = this.fallbackRatios.ES_SPY;
      this.ratios.NQ_QQQ = this.fallbackRatios.NQ_QQQ;
      this.ratios.lastUpdate = new Date().toISOString();
      return this.ratios;
    }

    // Check if we need to update (during RTH)
    if (!force && (now - this.lastRatioUpdate) < this.ratioUpdateInterval) {
      return this.ratios;
    }

    try {
      // Get latest prices from multiple sources
      const prices = await this.getLatestPrices();

      let anyUpdated = false;

      if (prices.ES && prices.SPY) {
        this.ratios.ES_SPY = prices.ES / prices.SPY;
        anyUpdated = true;
        logger.debug(`Updated ES/SPY ratio: ${this.ratios.ES_SPY.toFixed(4)} (ES=${prices.ES}, SPY=${prices.SPY})`);
      }

      if (prices.NQ && prices.QQQ) {
        this.ratios.NQ_QQQ = prices.NQ / prices.QQQ;
        anyUpdated = true;
        logger.debug(`Updated NQ/QQQ ratio: ${this.ratios.NQ_QQQ.toFixed(4)} (NQ=${prices.NQ}, QQQ=${prices.QQQ})`);
      }

      // If no live prices available yet (e.g. startup before data streams connect),
      // fall back to cached RTH ratios rather than leaving ratios null
      if (!anyUpdated && this.rthCache.NQ_QQQ) {
        this.ratios.ES_SPY = this.rthCache.ES_SPY;
        this.ratios.NQ_QQQ = this.rthCache.NQ_QQQ;
        this.ratios.lastUpdate = this.rthCache.timestamp;
        this.lastRatioUpdate = now;
        logger.info(`No live prices available yet - using cached RTH ratios: NQ/QQQ=${this.rthCache.NQ_QQQ?.toFixed(4)}, ES/SPY=${this.rthCache.ES_SPY?.toFixed(4)}`);
        return this.ratios;
      }

      this.ratios.lastUpdate = new Date().toISOString();
      this.lastRatioUpdate = now;

      // Cache ratios during RTH for use during off-hours and persist to Redis
      // Only update cache if we actually got live prices (don't overwrite with nulls)
      if (inRTH && anyUpdated) {
        this.rthCache = {
          ES_SPY: this.ratios.ES_SPY ?? this.rthCache.ES_SPY,
          NQ_QQQ: this.ratios.NQ_QQQ ?? this.rthCache.NQ_QQQ,
          timestamp: this.ratios.lastUpdate,
          qqqSpot: prices.QQQ ?? this.rthCache.qqqSpot,
          nqSpot: prices.NQ ?? this.rthCache.nqSpot,
          spySpot: prices.SPY ?? this.rthCache.spySpot,
          esSpot: prices.ES ?? this.rthCache.esSpot
        };
        await this.saveRTHCacheToRedis();
      }

      logger.info(`Updated futures ratios: ES/SPY=${this.ratios.ES_SPY?.toFixed(4) || 'N/A'}, NQ/QQQ=${this.ratios.NQ_QQQ?.toFixed(4) || 'N/A'}${inRTH ? ' (RTH - cached to Redis)' : ' (off-hours)'}`);

    } catch (error) {
      logger.error('Failed to update ratios:', error.message);
    }

    return this.ratios;
  }

  /**
   * Get latest prices from Redis and Tradier
   */
  async getLatestPrices() {
    const prices = {};

    try {
      // Get TradingView futures prices from Redis (primary source)
      if (this.isConnected) {
        const [nqData, esData] = await Promise.all([
          this.redis.get('latest_quote_NQ'),
          this.redis.get('latest_quote_ES')
        ]);

        if (nqData) {
          const nqQuote = JSON.parse(nqData);
          prices.NQ = nqQuote.close;
        }

        if (esData) {
          const esQuote = JSON.parse(esData);
          prices.ES = esQuote.close;
        }
      }

      // Get Tradier ETF prices (SPY/QQQ)
      if (this.tradierClient && this.tradierClient.isConfigured()) {
        try {
          const etfQuotes = await this.tradierClient.getQuotes(['SPY', 'QQQ']);

          if (etfQuotes?.quotes?.quote) {
            const quotes = Array.isArray(etfQuotes.quotes.quote) ? etfQuotes.quotes.quote : [etfQuotes.quotes.quote];

            for (const quote of quotes) {
              if (quote.symbol === 'SPY' && quote.last) {
                prices.SPY = parseFloat(quote.last);
              } else if (quote.symbol === 'QQQ' && quote.last) {
                prices.QQQ = parseFloat(quote.last);
              }
            }
          }
        } catch (error) {
          logger.warn('Failed to get Tradier quotes for ratio calculation:', error.message);
        }
      }

      // Fallback: try to get ETF prices from Redis if available
      if (!prices.SPY || !prices.QQQ) {
        try {
          const [spyData, qqqData] = await Promise.all([
            this.redis?.get('latest_quote_SPY'),
            this.redis?.get('latest_quote_QQQ')
          ]);

          if (spyData && !prices.SPY) {
            const spyQuote = JSON.parse(spyData);
            prices.SPY = spyQuote.close;
          }

          if (qqqData && !prices.QQQ) {
            const qqqQuote = JSON.parse(qqqData);
            prices.QQQ = qqqQuote.close;
          }
        } catch (error) {
          logger.debug('No ETF prices available in Redis cache');
        }
      }

      logger.debug('Retrieved prices:', prices);
      return prices;

    } catch (error) {
      logger.error('Error getting latest prices:', error.message);
      return prices;
    }
  }

  /**
   * Convert SPY strike/exposure to ES levels
   */
  spyToES(spyValue, useLatest = true) {
    let ratio = this.ratios.ES_SPY;

    // Use fallback if no live ratio available
    if (!ratio) {
      ratio = this.fallbackRatios.ES_SPY;
      if (!this._warnedFallbackES) {
        logger.warn(`Using fallback ES/SPY ratio: ${ratio} (will not repeat)`);
        this._warnedFallbackES = true;
      }
    } else {
      this._warnedFallbackES = false;
    }

    return spyValue * ratio;
  }

  /**
   * Convert QQQ strike/exposure to NQ levels
   */
  qqqToNQ(qqqValue, useLatest = true) {
    let ratio = this.ratios.NQ_QQQ;

    // Use fallback if no live ratio available
    if (!ratio) {
      ratio = this.fallbackRatios.NQ_QQQ;
      if (!this._warnedFallbackNQ) {
        logger.warn(`Using fallback NQ/QQQ ratio: ${ratio} (will not repeat)`);
        this._warnedFallbackNQ = true;
      }
    } else {
      this._warnedFallbackNQ = false;
    }

    return qqqValue * ratio;
  }

  /**
   * Convert ES level to SPY equivalent
   */
  esToSPY(esValue) {
    let ratio = this.ratios.ES_SPY;
    if (!ratio) {
      ratio = this.fallbackRatios.ES_SPY;
    }

    return esValue / ratio;
  }

  /**
   * Convert NQ level to QQQ equivalent
   */
  nqToQQQ(nqValue) {
    let ratio = this.ratios.NQ_QQQ;
    if (!ratio) {
      ratio = this.fallbackRatios.NQ_QQQ;
    }

    return nqValue / ratio;
  }

  /**
   * Convert exposure results to futures prices
   */
  convertExposures(exposureData) {
    const converted = {};

    for (const [symbol, data] of Object.entries(exposureData)) {
      let convertedData = { ...data };

      if (symbol === 'SPY') {
        // Convert SPY exposures to ES
        const futuresPrice = this.spyToES(data.spotPrice);

        convertedData = {
          ...data,
          symbol: 'ES',
          futuresPrice: futuresPrice,
          originalSpotPrice: data.spotPrice,
          ratio: this.ratios.ES_SPY || this.fallbackRatios.ES_SPY,
          levels: this.convertLevels(data.levels, 'SPY')
        };

        // Convert exposures by strike
        if (data.exposuresByStrike) {
          const convertedExposures = {};
          for (const [strike, exposures] of Object.entries(data.exposuresByStrike)) {
            const futuresStrike = Math.round(this.spyToES(parseFloat(strike)));
            if (!convertedExposures[futuresStrike]) {
              convertedExposures[futuresStrike] = { gex: 0, vex: 0, cex: 0, callOI: 0, putOI: 0 };
            }

            // Aggregate if multiple strikes map to same futures level
            convertedExposures[futuresStrike].gex += exposures.gex;
            convertedExposures[futuresStrike].vex += exposures.vex;
            convertedExposures[futuresStrike].cex += exposures.cex;
            convertedExposures[futuresStrike].callOI += exposures.callOI;
            convertedExposures[futuresStrike].putOI += exposures.putOI;
          }
          convertedData.exposuresByStrike = convertedExposures;
        }

      } else if (symbol === 'QQQ') {
        // Convert QQQ exposures to NQ
        const futuresPrice = this.qqqToNQ(data.spotPrice);

        convertedData = {
          ...data,
          symbol: 'NQ',
          futuresPrice: futuresPrice,
          originalSpotPrice: data.spotPrice,
          ratio: this.ratios.NQ_QQQ || this.fallbackRatios.NQ_QQQ,
          levels: this.convertLevels(data.levels, 'QQQ')
        };

        // Convert exposures by strike
        if (data.exposuresByStrike) {
          const convertedExposures = {};
          for (const [strike, exposures] of Object.entries(data.exposuresByStrike)) {
            const futuresStrike = Math.round(this.qqqToNQ(parseFloat(strike)));
            if (!convertedExposures[futuresStrike]) {
              convertedExposures[futuresStrike] = { gex: 0, vex: 0, cex: 0, callOI: 0, putOI: 0 };
            }

            // Aggregate if multiple strikes map to same futures level
            convertedExposures[futuresStrike].gex += exposures.gex;
            convertedExposures[futuresStrike].vex += exposures.vex;
            convertedExposures[futuresStrike].cex += exposures.cex;
            convertedExposures[futuresStrike].callOI += exposures.callOI;
            convertedExposures[futuresStrike].putOI += exposures.putOI;
          }
          convertedData.exposuresByStrike = convertedExposures;
        }
      }

      converted[convertedData.symbol] = convertedData;
    }

    return converted;
  }

  /**
   * Convert key levels to futures prices
   */
  convertLevels(levels, sourceSymbol) {
    if (!levels) return {};

    const convertFunc = sourceSymbol === 'SPY' ? this.spyToES.bind(this) : this.qqqToNQ.bind(this);

    return {
      ...levels,
      gammaFlip: levels.gammaFlip ? Math.round(convertFunc(levels.gammaFlip)) : null,
      callWall: levels.callWall ? Math.round(convertFunc(levels.callWall)) : null,
      putWall: levels.putWall ? Math.round(convertFunc(levels.putWall)) : null,
      resistance: levels.resistance ? levels.resistance.map(r => Math.round(convertFunc(r))) : [],
      support: levels.support ? levels.support.map(s => Math.round(convertFunc(s))) : []
    };
  }

  /**
   * Get current ratio information
   */
  getRatioInfo() {
    // Use cached Tradier market state for sync method
    const inRTH = isOptionsRTHCached();
    const usingCachedRatios = !inRTH && this.rthCache.NQ_QQQ;
    const marketDesc = tradierMarketClock.getDescription();

    return {
      current: {
        ES_SPY: this.ratios.ES_SPY,
        NQ_QQQ: this.ratios.NQ_QQQ,
        lastUpdate: this.ratios.lastUpdate
      },
      fallback: this.fallbackRatios,
      isUsingFallback: {
        ES_SPY: !this.ratios.ES_SPY,
        NQ_QQQ: !this.ratios.NQ_QQQ
      },
      lastRatioUpdate: this.lastRatioUpdate,
      rthCache: {
        ...this.rthCache,
        isActive: usingCachedRatios
      },
      sessionInfo: {
        isOptionsOpen: inRTH,
        usingCachedRatios,
        marketDescription: marketDesc
      }
    };
  }

  /**
   * Force update ratios
   */
  async forceUpdateRatios() {
    logger.info('Forcing ratio update...');
    return await this.updateRatios(true);
  }

  /**
   * Validate ratio reasonableness
   */
  validateRatios() {
    const issues = [];

    if (this.ratios.ES_SPY) {
      if (this.ratios.ES_SPY < 8 || this.ratios.ES_SPY > 12) {
        issues.push(`ES/SPY ratio ${this.ratios.ES_SPY.toFixed(4)} is outside expected range [8, 12]`);
      }
    }

    if (this.ratios.NQ_QQQ) {
      if (this.ratios.NQ_QQQ < 35 || this.ratios.NQ_QQQ > 50) {
        issues.push(`NQ/QQQ ratio ${this.ratios.NQ_QQQ.toFixed(4)} is outside expected range [35, 50]`);
      }
    }

    if (issues.length > 0) {
      logger.warn('Ratio validation issues:', issues);
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.redis && this.isConnected) {
      await this.redis.disconnect();
      this.isConnected = false;
      logger.info('FuturesConverter disconnected from Redis');
    }
  }
}

export default FuturesConverter;