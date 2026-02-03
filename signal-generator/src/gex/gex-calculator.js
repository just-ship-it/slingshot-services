// GEX Calculator - Fetches CBOE options data and calculates gamma exposure levels
import axios from 'axios';
import { createLogger, messageBus } from '../../../shared/index.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Redis from 'ioredis';
import { isOptionsRTH, isOptionsRTHCached, getCurrentSession } from '../utils/session-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('gex-calculator');

// CBOE API endpoint for options data
const CBOE_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json';

class GexCalculator {
  constructor(options = {}) {
    this.symbol = options.symbol || 'QQQ';
    this.cacheFile = options.cacheFile || path.join(__dirname, '../../data/gex_cache.json');
    this.cooldownMinutes = options.cooldownMinutes || 5;
    this.redisUrl = options.redisUrl || 'redis://localhost:6379';

    this.currentLevels = null;
    this.lastFetchTime = 0;
    this.updateCallback = null;
    this.redis = null;

    // RTH ratio cache - stores the NQ/QQQ multiplier from last RTH session
    // This prevents level drift during off-hours when QQQ is frozen but NQ moves
    this.rthRatioCache = {
      multiplier: null,
      nqSpot: null,
      qqqSpot: null,
      timestamp: null,
      session: null
    };

    // Fallback ratio from external source (e.g., Tradier) when no RTH cache available
    this.fallbackRatio = {
      multiplier: null,
      source: null,
      timestamp: null
    };

    // Ensure data directory exists
    this.ensureDataDir();
  }

  /**
   * Set a fallback ratio from an external source (e.g., Tradier)
   * Used when CBOE has no RTH cache but another service does
   */
  setFallbackRatio(multiplier, source = 'external', timestamp = null) {
    this.fallbackRatio = {
      multiplier,
      source,
      timestamp: timestamp || new Date().toISOString()
    };
    logger.info(`Set fallback ratio from ${source}: ${multiplier?.toFixed(4)}`);
  }

  async ensureRedisConnection() {
    if (!this.redis) {
      this.redis = new Redis(this.redisUrl, {
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      await this.redis.connect();
      logger.info('Connected to Redis for quote fetching');
    }
    return this.redis;
  }

  async getLatestQuotesFromRedis() {
    try {
      await this.ensureRedisConnection();

      // Get latest quotes for QQQ and NQ from Redis
      // TradingView publishes quotes with baseSymbol as key
      const qqqKey = 'latest_quote_QQQ';
      const nqKey = 'latest_quote_NQ';

      const [qqqData, nqData] = await Promise.all([
        this.redis.get(qqqKey),
        this.redis.get(nqKey)
      ]);

      const quotes = {};

      if (qqqData) {
        try {
          const qqqQuote = JSON.parse(qqqData);
          quotes.qqq = qqqQuote.close;
          logger.info(`Got latest QQQ quote from Redis: $${quotes.qqq}`);
        } catch (e) {
          logger.warn('Failed to parse QQQ quote from Redis');
        }
      }

      if (nqData) {
        try {
          const nqQuote = JSON.parse(nqData);
          quotes.nq = nqQuote.close;
          logger.info(`Got latest NQ quote from Redis: ${quotes.nq}`);
        } catch (e) {
          logger.warn('Failed to parse NQ quote from Redis');
        }
      }

      return quotes;

    } catch (error) {
      logger.warn('Failed to fetch quotes from Redis:', error.message);
      return {};
    }
  }

  async ensureDataDir() {
    const dataDir = path.dirname(this.cacheFile);
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (error) {
      // Directory may already exist
    }
  }

  async loadCachedLevels() {
    try {
      const data = await fs.readFile(this.cacheFile, 'utf8');
      const parsed = JSON.parse(data);
      this.currentLevels = parsed;

      // Also restore RTH ratio cache if present
      if (parsed.rthRatioCache) {
        this.rthRatioCache = parsed.rthRatioCache;
        logger.info(`Loaded RTH ratio cache: multiplier=${this.rthRatioCache.multiplier?.toFixed(4)}, from=${this.rthRatioCache.timestamp}`);
      }

      logger.info('Loaded cached GEX levels from file');
      return this.currentLevels;
    } catch (error) {
      logger.info('No cached GEX levels found');
      return null;
    }
  }

  async saveCachedLevels() {
    if (!this.currentLevels) return;

    try {
      // Include RTH ratio cache in saved data
      const dataToSave = {
        ...this.currentLevels,
        rthRatioCache: this.rthRatioCache
      };
      await fs.writeFile(this.cacheFile, JSON.stringify(dataToSave, null, 2));
      logger.info('Saved GEX levels to cache file');
    } catch (error) {
      logger.error('Failed to save GEX levels to cache:', error);
    }
  }

  async fetchCBOEOptions() {
    const url = CBOE_URL.replace('{symbol}', this.symbol);

    try {
      logger.info(`Fetching options data from CBOE for ${this.symbol}...`);
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      logger.info(`Successfully fetched CBOE options data for ${this.symbol}`);
      return response.data;
    } catch (error) {
      logger.error('Failed to fetch CBOE data:', error.message);
      throw error;
    }
  }

  // Black-Scholes gamma calculation
  calcGammaEx(S, K, vol, T, r, q, optType, OI) {
    if (T <= 0 || vol <= 0 || isNaN(vol) || S <= 0 || K <= 0 || isNaN(OI)) {
      return 0;
    }

    try {
      const sqrtT = Math.sqrt(T);
      const d1 = (Math.log(S / K) + (r - q + 0.5 * vol * vol) * T) / (vol * sqrtT);

      // Standard normal PDF
      const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

      const gamma = Math.exp(-q * T) * normPdf(d1) / (S * vol * sqrtT);

      // GEX = OI * 100 * S^2 * 0.01 * gamma
      const gex = OI * 100 * S * S * 0.01 * gamma;

      // Put gamma is negative
      return optType === 'put' ? -gex : gex;
    } catch (error) {
      return 0;
    }
  }

  parseOptionSymbol(symbol) {
    // Parse CBOE option symbol format: QQQ250117C00400000
    // Last 9 chars: C00400000 → C=Call, 00400=strike ($400), 000=decimal
    const strikeInfo = symbol.slice(-9);
    const optType = strikeInfo[0] === 'C' ? 'call' : 'put';
    const strike = parseFloat(strikeInfo.slice(1, 6)) + parseFloat(strikeInfo.slice(6)) / 1000;

    // Chars -15 to -9: 250117 → Expiry 2025-01-17
    const expiryStr = symbol.slice(-15, -9);
    const year = 2000 + parseInt(expiryStr.slice(0, 2));
    const month = parseInt(expiryStr.slice(2, 4));
    const day = parseInt(expiryStr.slice(4, 6));
    const expiry = new Date(year, month - 1, day);

    // Underlying symbol
    const underlying = symbol.slice(0, -15);

    return { underlying, expiry, optType, strike };
  }

  calculateGEX(optionsData) {
    const data = optionsData.data || {};
    const spotPrice = data.close;

    if (!spotPrice) {
      throw new Error('No spot price in options data');
    }

    const options = data.options || [];
    if (options.length === 0) {
      throw new Error('No options in data');
    }

    // Parameters
    const r = 0.05; // Risk-free rate
    const q = 0.01; // Dividend yield
    const now = new Date();

    // Process options
    const gexByStrike = new Map();
    const callOIByStrike = new Map();
    const putOIByStrike = new Map();

    for (const opt of options) {
      const symbol = opt.option;
      if (!symbol) continue;

      try {
        const { expiry, optType, strike } = this.parseOptionSymbol(symbol);

        // Calculate time to expiration
        const dte = Math.max(0, (expiry - now) / (1000 * 60 * 60 * 24));
        const T = dte / 365.0;

        if (T <= 0) continue;

        const iv = opt.iv || 0.25; // Default IV if missing
        const oi = opt.open_interest || 0;

        // Calculate gamma exposure
        const gex = this.calcGammaEx(spotPrice, strike, iv, T, r, q, optType, oi);

        // Aggregate by strike
        const currentGex = gexByStrike.get(strike) || 0;
        gexByStrike.set(strike, currentGex + gex);

        if (optType === 'call') {
          const currentOI = callOIByStrike.get(strike) || 0;
          callOIByStrike.set(strike, currentOI + oi);
        } else {
          const currentOI = putOIByStrike.get(strike) || 0;
          putOIByStrike.set(strike, currentOI + oi);
        }
      } catch (error) {
        // Skip invalid options
        continue;
      }
    }

    if (gexByStrike.size === 0) {
      throw new Error('No valid options processed');
    }

    // Find key levels
    const strikes = Array.from(gexByStrike.keys()).sort((a, b) => a - b);

    // Call wall - highest call OI
    let callWall = 0;
    let maxCallOI = 0;
    for (const [strike, oi] of callOIByStrike) {
      if (oi > maxCallOI) {
        maxCallOI = oi;
        callWall = strike;
      }
    }

    // Put wall - highest put OI
    let putWall = 0;
    let maxPutOI = 0;
    for (const [strike, oi] of putOIByStrike) {
      if (oi > maxPutOI) {
        maxPutOI = oi;
        putWall = strike;
      }
    }

    // Gamma flip - where gamma crosses zero
    const gammaFlip = this.findZeroGammaCrossing(gexByStrike, spotPrice);

    // Find support/resistance levels
    const resistance = this.findResistanceLevels(strikes, spotPrice, gexByStrike, callOIByStrike);
    const support = this.findSupportLevels(strikes, spotPrice, gexByStrike, putOIByStrike);

    // Total GEX
    let totalGex = 0;
    for (const gex of gexByStrike.values()) {
      totalGex += gex;
    }

    return {
      spotPrice,
      totalGex: totalGex / 1e9, // Convert to billions
      regime: totalGex > 0 ? 'positive' : 'negative',
      gammaFlip,
      callWall,
      putWall,
      resistance,
      support
    };
  }

  findZeroGammaCrossing(gexByStrike, spot) {
    const strikes = Array.from(gexByStrike.keys()).sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));

    for (let i = 0; i < strikes.length - 1; i++) {
      const strike1 = strikes[i];
      const strike2 = strikes[i + 1];
      const gex1 = gexByStrike.get(strike1);
      const gex2 = gexByStrike.get(strike2);

      if (gex1 * gex2 < 0) {
        // Linear interpolation
        const zeroCrossing = strike1 + (strike2 - strike1) * (-gex1 / (gex2 - gex1));
        return Math.round(zeroCrossing);
      }
    }

    return Math.round(spot);
  }

  findResistanceLevels(strikes, spot, gexByStrike, callOIByStrike, n = 5) {
    const strikesAbove = strikes.filter(s => s > spot);
    if (strikesAbove.length === 0) return [];

    // Score by call OI + abs(GEX)
    const scored = strikesAbove.map(strike => ({
      strike,
      score: (callOIByStrike.get(strike) || 0) + Math.abs(gexByStrike.get(strike) || 0)
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map(s => Math.round(s.strike)).sort((a, b) => a - b);
  }

  findSupportLevels(strikes, spot, gexByStrike, putOIByStrike, n = 5) {
    const strikesBelow = strikes.filter(s => s < spot);
    if (strikesBelow.length === 0) return [];

    // Score by put OI + abs(GEX)
    const scored = strikesBelow.map(strike => ({
      strike,
      score: (putOIByStrike.get(strike) || 0) + Math.abs(gexByStrike.get(strike) || 0)
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map(s => Math.round(s.strike)).sort((a, b) => b - a);
  }

  translateToNQ(qqqLevels, nqSpot = null, qqqSpot = null) {
    // Use provided spot prices or fall back to calculated/default values
    const actualQqqSpot = qqqSpot || qqqLevels.spotPrice;
    let actualNqSpot = nqSpot;
    let multiplier = 41.5; // Default fallback
    let fromRTHCache = false;
    const currentSession = getCurrentSession();

    // Check if we're in RTH (options market open)
    const isInRTH = isOptionsRTHCached();

    if (isInRTH) {
      // During RTH: Calculate multiplier from live prices and cache it
      if (actualNqSpot && actualNqSpot > 0) {
        multiplier = actualNqSpot / actualQqqSpot;

        // Update RTH ratio cache
        this.rthRatioCache = {
          multiplier,
          nqSpot: actualNqSpot,
          qqqSpot: actualQqqSpot,
          timestamp: new Date().toISOString(),
          session: currentSession
        };

        logger.info(`[RTH] Using live prices: QQQ=${actualQqqSpot.toFixed(2)}, NQ=${actualNqSpot.toFixed(0)}, Multiplier=${multiplier.toFixed(4)} (cached for off-hours)`);
      } else {
        // No live NQ price during RTH - use default
        actualNqSpot = actualQqqSpot * multiplier;
        logger.warn(`[RTH] No live NQ price available, using default multiplier ${multiplier}`);
      }
    } else {
      // Outside RTH: Use cached multiplier to prevent drift
      if (this.rthRatioCache.multiplier) {
        // Priority 1: Use our own RTH cache
        multiplier = this.rthRatioCache.multiplier;
        fromRTHCache = true;

        // Calculate NQ spot using cached multiplier (keeps levels stable)
        actualNqSpot = actualQqqSpot * multiplier;

        logger.info(`[OFF-HOURS] Using RTH cached multiplier=${multiplier.toFixed(4)} from ${this.rthRatioCache.timestamp} (session: ${currentSession})`);
      } else if (this.fallbackRatio.multiplier) {
        // Priority 2: Use fallback ratio from external source (e.g., Tradier)
        multiplier = this.fallbackRatio.multiplier;
        fromRTHCache = true; // Treat as cached since it's from a trusted source

        // Calculate NQ spot using fallback multiplier
        actualNqSpot = actualQqqSpot * multiplier;

        logger.info(`[OFF-HOURS] Using fallback multiplier=${multiplier.toFixed(4)} from ${this.fallbackRatio.source} (${this.fallbackRatio.timestamp})`);
      } else if (actualNqSpot && actualNqSpot > 0) {
        // Priority 3: Calculate live but warn about potential drift
        multiplier = actualNqSpot / actualQqqSpot;
        logger.warn(`[OFF-HOURS] No RTH cache or fallback available, using live multiplier=${multiplier.toFixed(4)} - levels may drift!`);
      } else {
        // Priority 4: Fallback to default
        actualNqSpot = actualQqqSpot * multiplier;
        logger.warn(`[OFF-HOURS] No RTH cache, fallback, or live prices - using default multiplier ${multiplier}`);
      }
    }

    return {
      spot: actualNqSpot,
      multiplier,
      fromRTHCache,
      currentSession,
      gammaFlip: Math.round(qqqLevels.gammaFlip * multiplier),
      callWall: Math.round(qqqLevels.callWall * multiplier),
      putWall: Math.round(qqqLevels.putWall * multiplier),
      resistance: qqqLevels.resistance.map(r => Math.round(r * multiplier)),
      support: qqqLevels.support.map(s => Math.round(s * multiplier))
    };
  }

  async calculateLevels(force = false, providedSpots = {}) {
    const now = Date.now();

    // Check cooldown unless forced
    if (!force && this.currentLevels) {
      const timeSinceFetch = (now - this.lastFetchTime) / 1000 / 60; // minutes
      if (timeSinceFetch < this.cooldownMinutes) {
        logger.info(`Returning cached GEX levels (${(this.cooldownMinutes - timeSinceFetch).toFixed(1)} minutes until refresh)`);
        return { ...this.currentLevels, fromCache: true };
      }
    }

    try {
      logger.info('Fetching fresh GEX levels from CBOE...');
      const optionsData = await this.fetchCBOEOptions();
      const qqqLevels = this.calculateGEX(optionsData);

      // Get latest quotes from Redis (TradingView data)
      let liveSpots = providedSpots;
      if (!liveSpots.nq || !liveSpots.qqq) {
        logger.info('Fetching latest quotes from TradingView Redis data...');
        const redisQuotes = await this.getLatestQuotesFromRedis();
        liveSpots = {
          nq: liveSpots.nq || redisQuotes.nq,
          qqq: liveSpots.qqq || redisQuotes.qqq
        };
      }

      // Use live spot prices from TradingView if available
      const nqLevels = this.translateToNQ(
        qqqLevels,
        liveSpots.nq,
        liveSpots.qqq || qqqLevels.spotPrice
      );

      this.currentLevels = {
        timestamp: new Date().toISOString(),
        qqqSpot: liveSpots.qqq || qqqLevels.spotPrice,
        nqSpot: nqLevels.spot,
        multiplier: nqLevels.multiplier,
        totalGex: qqqLevels.totalGex,
        regime: qqqLevels.regime,
        gammaFlip: nqLevels.gammaFlip,
        callWall: nqLevels.callWall,
        putWall: nqLevels.putWall,
        resistance: nqLevels.resistance,
        support: nqLevels.support,
        fromCache: false,
        usedLivePrices: !!(liveSpots.nq && liveSpots.qqq),
        dataSource: liveSpots.nq ? 'tradingview' : 'cboe',
        fromRTHCache: nqLevels.fromRTHCache,
        currentSession: nqLevels.currentSession
      };

      this.lastFetchTime = now;
      await this.saveCachedLevels();

      logger.info(`GEX levels calculated: Put Wall=${nqLevels.putWall}, Call Wall=${nqLevels.callWall}, Regime=${qqqLevels.regime} (using ${this.currentLevels.dataSource} prices)`);

      // Trigger callback if set
      if (this.updateCallback) {
        await this.updateCallback(this.currentLevels);
      }

      return this.currentLevels;

    } catch (error) {
      logger.error('Failed to calculate GEX levels:', error);

      // Try to return cached levels
      if (this.currentLevels) {
        logger.info('Returning cached GEX levels due to error');
        return { ...this.currentLevels, fromCache: true };
      }

      throw error;
    }
  }

  setUpdateCallback(callback) {
    this.updateCallback = callback;
  }

  getCurrentLevels() {
    return this.currentLevels;
  }
}

export default GexCalculator;