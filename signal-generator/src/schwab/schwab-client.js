import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Redis from 'ioredis';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('schwab-client');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOKEN_FILE = join(__dirname, '../../../shared/.schwab-tokens.json');
const REDIS_TOKEN_KEY = 'schwab:tokens';
const BASE_URL = 'https://api.schwabapi.com';
const TOKEN_REFRESH_INTERVAL = 25 * 60 * 1000; // 25 minutes (access token lasts 30 min)
const REFRESH_TOKEN_WARN_DAYS = 5; // Warn when refresh token has < 5 days left
const RISK_FREE_RATE = 0.05;

// ===== Vanilla Black-Scholes IV Solver (spot-based) =====
// Matches the backtest precompute-short-dte-iv.js exactly.
// Schwab returns a single shared IV per strike, so we solve independent
// call/put IVs from bid/ask mid prices using the same vanilla BS model
// that the backtest uses. This ensures live and backtest IV values align.

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function blackScholesPrice(S, K, T, r, sigma, optionType) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (optionType === 'C') {
    return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
  } else {
    return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
  }
}

function blackScholesVega(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normalPDF(d1);
}

/**
 * Newton-Raphson IV solver using vanilla Black-Scholes (spot-based).
 * Matches backtest precompute-short-dte-iv.js exactly.
 * Returns decimal IV (e.g. 0.25) or null if it can't converge.
 */
function calculateIV(optionPrice, S, K, T, r, optionType) {
  if (optionPrice <= 0 || T <= 0) return null;

  const intrinsic = optionType === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (optionPrice < intrinsic * 0.99) return null;

  let iv = 0.30;
  for (let i = 0; i < 100; i++) {
    const price = blackScholesPrice(S, K, T, r, iv, optionType);
    const vega = blackScholesVega(S, K, T, r, iv);
    if (vega < 0.0001) return calculateIVBisection(optionPrice, S, K, T, r, optionType);
    const diff = price - optionPrice;
    if (Math.abs(diff) < 0.0001) return iv;
    iv = iv - diff / vega;
    if (iv <= 0.001) iv = 0.001;
    if (iv > 5.0) iv = 5.0;
  }
  return calculateIVBisection(optionPrice, S, K, T, r, optionType);
}

function calculateIVBisection(optionPrice, S, K, T, r, optionType) {
  let low = 0.001, high = 5.0;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice(S, K, T, r, mid, optionType);
    if (Math.abs(price - optionPrice) < 0.0001) return mid;
    if (price > optionPrice) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

class SchwabClient {
  constructor(options = {}) {
    this.appKey = options.appKey;
    this.appSecret = options.appSecret;
    this.callbackUrl = options.callbackUrl || 'https://127.0.0.1:8182';
    this.redisUrl = options.redisUrl || null;

    // Tokens
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenObtainedAt = null;

    // Rate limiting: 120 requests per minute (same as Tradier)
    this.requestWindow = 60 * 1000;
    this.maxRequests = 100; // Conservative
    this.requestTimes = [];

    // Interface compatibility with TradierClient
    this.isConnected = false;
    this.marketStatus = 'initializing';
    this.subscribedSymbols = ['SPY', 'QQQ'];
    this.quotesCallback = null;

    // Internal cache: fetch full chain once per symbol per poll cycle
    this._fullChainCache = new Map();
    this._fullChainCacheExpiry = 90 * 1000; // 90 seconds
    // Window of expirations to fetch from Schwab. Must cover the longest DTE
    // any downstream consumer needs. iv-skew-gex uses up to 45 DTE; +5 buffer.
    this._chainMaxDTE = options.chainMaxDTE ?? 50;

    // Token refresh timer
    this._refreshTimer = null;

    if (!this.appKey || !this.appSecret) {
      throw new Error('Schwab app key and secret are required');
    }

    // Synchronous file-based load as initial fallback (constructor can't be async)
    this._loadTokensFromFile();
  }

  // ===== Token Management =====

  /**
   * Load tokens from Redis first, then fall back to file.
   * Must be called after construction (async). testConnection() calls this.
   */
  async _loadTokens() {
    // Try Redis first
    if (this.redisUrl) {
      const loaded = await this._loadTokensFromRedis();
      if (loaded) return;
    }
    // Fall back to file
    this._loadTokensFromFile();
  }

  async _loadTokensFromRedis() {
    let redis;
    try {
      redis = new Redis(this.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
      await redis.connect();
      const raw = await redis.get(REDIS_TOKEN_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        this.tokenObtainedAt = data.obtained_at;
        logger.info('Loaded Schwab tokens from Redis');
        this._checkRefreshTokenAge();
        return true;
      }
      logger.info('No Schwab tokens in Redis');
      return false;
    } catch (error) {
      logger.warn('Failed to load Schwab tokens from Redis:', error.message);
      return false;
    } finally {
      try { redis?.disconnect(); } catch {}
    }
  }

  _loadTokensFromFile() {
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        this.tokenObtainedAt = data.obtained_at;
        logger.info('Loaded Schwab tokens from file');
        this._checkRefreshTokenAge();
      } else {
        logger.warn('No Schwab token file found at', TOKEN_FILE);
      }
    } catch (error) {
      logger.error('Failed to load Schwab tokens from file:', error.message);
    }
  }

  _checkRefreshTokenAge() {
    if (this.tokenObtainedAt) {
      const ageMs = Date.now() - new Date(this.tokenObtainedAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const remainDays = 7 - ageDays;
      if (remainDays < REFRESH_TOKEN_WARN_DAYS) {
        logger.warn(`Schwab refresh token expires in ~${remainDays.toFixed(1)} days — re-authenticate soon`);
      }
    }
  }

  async _saveTokens() {
    const data = {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      token_type: 'Bearer',
      obtained_at: new Date().toISOString()
    };

    // Save to Redis (primary)
    if (this.redisUrl) {
      let redis;
      try {
        redis = new Redis(this.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
        await redis.connect();
        await redis.set(REDIS_TOKEN_KEY, JSON.stringify(data));
        logger.debug('Saved Schwab tokens to Redis');
      } catch (error) {
        logger.error('Failed to save Schwab tokens to Redis:', error.message);
      } finally {
        try { redis?.disconnect(); } catch {}
      }
    }

    // Save to file (local backup)
    try {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
      logger.debug('Saved Schwab tokens to file');
    } catch (error) {
      // Expected to fail on Sevalla — not an error
      logger.debug('Could not save Schwab tokens to file (expected in containerized env)');
    }
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available — re-authenticate via browser OAuth flow');
    }

    try {
      const basicAuth = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64');

      const response = await axios.post(`${BASE_URL}/v1/oauth/token`,
        `grant_type=refresh_token&refresh_token=${this.refreshToken}`,
        {
          headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 15000,
          decompress: true
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      this.tokenObtainedAt = new Date().toISOString();
      await this._saveTokens();

      logger.info('Schwab access token refreshed successfully');
    } catch (error) {
      const status = error.response?.status;
      const errData = error.response?.data;
      logger.error(`Schwab token refresh failed (${status}):`, JSON.stringify(errData || error.message));

      if (status === 401 || errData?.error === 'invalid_grant') {
        logger.error('Refresh token expired or invalid — re-authenticate via browser OAuth flow');
      }
      throw error;
    }
  }

  startTokenRefresh() {
    if (this._refreshTimer) return;

    this._refreshTimer = setInterval(async () => {
      try {
        await this.refreshAccessToken();
      } catch (error) {
        logger.error('Scheduled token refresh failed:', error.message);
      }
    }, TOKEN_REFRESH_INTERVAL);

    logger.info(`Schwab token auto-refresh started (every ${TOKEN_REFRESH_INTERVAL / 60000} min)`);
  }

  stopTokenRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  // ===== Rate Limiting =====

  checkRateLimit() {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter(time => now - time < this.requestWindow);

    if (this.requestTimes.length >= this.maxRequests) {
      const oldestRequest = this.requestTimes[0];
      const waitTime = this.requestWindow - (now - oldestRequest);
      throw new Error(`Rate limit exceeded. Wait ${Math.ceil(waitTime / 1000)} seconds`);
    }

    this.requestTimes.push(now);
  }

  // ===== HTTP Requests =====

  async makeRequest(endpoint) {
    this.checkRateLimit();

    if (!this.accessToken) {
      throw new Error('No Schwab access token — load tokens or authenticate first');
    }

    try {
      logger.debug(`Schwab GET ${endpoint}`);
      const response = await axios.get(`${BASE_URL}${endpoint}`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json'
        },
        timeout: 30000,
        decompress: true
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status;

      // Auto-refresh on 401
      if (status === 401 && this.refreshToken) {
        logger.warn('Schwab 401 — attempting token refresh...');
        await this.refreshAccessToken();
        // Retry the request once
        const retryResponse = await axios.get(`${BASE_URL}${endpoint}`, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json'
          },
          timeout: 30000,
          decompress: true
        });
        return retryResponse.data;
      }

      logger.error(`Schwab API error for ${endpoint}:`, error.message, {
        status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      throw error;
    }
  }

  // ===== Full Chain Cache (internal) =====
  // Fetches every expiration from today through today + chainMaxDTE so that
  // downstream calculators (iv-skew-gex 7-45 DTE, short-dte-iv 0-1 DTE,
  // exposure GEX/VEX/CEX) can each filter the cache to their own needs
  // without re-fetching. Without an explicit fromDate/toDate Schwab returns
  // a narrow default subset (today + tomorrow + next monthly), which silently
  // starved the iv-skew-gex calculator and caused an incident on 2026-04-15.

  async _getFullChain(symbol) {
    const cached = this._fullChainCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this._fullChainCacheExpiry) {
      return cached.data;
    }

    const today = new Date();
    const fromDate = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + this._chainMaxDTE * 86400000);
    const toDate = to.toISOString().slice(0, 10);

    // Fetch per-expiration to avoid 502 errors from overly large responses.
    // The stub call enumerates expirations in [fromDate, toDate] only.
    const stub = await this.makeRequest(
      `/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}` +
      `&contractType=ALL&strikeCount=1&fromDate=${fromDate}&toDate=${toDate}`
    );

    // Build a merged chain by fetching each expiration individually
    const merged = {
      symbol: stub.symbol,
      underlyingPrice: stub.underlyingPrice,
      callExpDateMap: {},
      putExpDateMap: {}
    };

    const expKeys = Object.keys(stub.callExpDateMap || {});

    // Fetch chains per expiration in parallel (batches of 3 to respect rate limits)
    for (let i = 0; i < expKeys.length; i += 3) {
      const batch = expKeys.slice(i, i + 3);
      const results = await Promise.allSettled(
        batch.map(async (expKey) => {
          const expDate = expKey.split(':')[0];
          const data = await this.makeRequest(
            `/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}&contractType=ALL&greeks=true&fromDate=${expDate}&toDate=${expDate}`
          );
          return { expKey, data };
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { data } = result.value;
          // Merge the per-expiration chain maps
          Object.assign(merged.callExpDateMap, data.callExpDateMap || {});
          Object.assign(merged.putExpDateMap, data.putExpDateMap || {});
        } else {
          logger.warn(`Failed to fetch chain for ${symbol} expiration:`, result.reason?.message);
        }
      }
    }

    this._fullChainCache.set(symbol, { data: merged, timestamp: Date.now() });
    return merged;
  }

  // ===== Tradier-Compatible Interface =====

  /**
   * Get available options expirations for a symbol.
   * Returns data in Tradier format: { expirations: { date: ['2026-03-11', ...] } }
   */
  async getExpirations(symbol) {
    const chain = await this._getFullChain(symbol);

    const expirationKeys = Object.keys(chain.callExpDateMap || {});
    const dates = expirationKeys
      .map(key => key.split(':')[0]) // "2026-03-11:0" → "2026-03-11"
      .sort();

    return { expirations: { date: dates } };
  }

  /**
   * Get options chain for symbol and expiration.
   * Returns data in Tradier format: { options: { option: [...] } }
   */
  async getOptionsChain(symbol, expiration) {
    const chain = await this._getFullChain(symbol);
    const options = this._flattenChainForExpiration(chain, expiration);

    return { options: { option: options } };
  }

  /**
   * Flatten Schwab's nested chain structure into Tradier's flat array format
   * for a specific expiration date. Uses spot price for vanilla BS IV calculation
   * to match the backtest pipeline.
   */
  _flattenChainForExpiration(chain, expiration) {
    const spotPrice = chain.underlyingPrice || 0;

    // Collect raw contracts for this expiration
    const allContracts = [];

    for (const [expKey, strikes] of Object.entries(chain.callExpDateMap || {})) {
      if (!expKey.startsWith(expiration)) continue;
      for (const [, contracts] of Object.entries(strikes)) {
        for (const contract of contracts) allContracts.push(contract);
      }
    }
    for (const [expKey, strikes] of Object.entries(chain.putExpDateMap || {})) {
      if (!expKey.startsWith(expiration)) continue;
      for (const [, contracts] of Object.entries(strikes)) {
        for (const contract of contracts) allContracts.push(contract);
      }
    }

    // Compute time to expiry from the expiration date string
    const expMs = new Date(expiration + 'T16:00:00-05:00').getTime();
    const T = Math.max((expMs - Date.now()) / (365.25 * 24 * 60 * 60 * 1000), 1 / 365);

    // Convert all contracts using spot price and vanilla BS
    const options = [];
    for (const contract of allContracts) {
      options.push(this._convertToTradierFormat(contract, spotPrice, T));
    }

    return options;
  }

  /**
   * Convert a single Schwab option contract to Tradier format.
   * Calculates independent IV from bid/ask mid price via vanilla Black-Scholes
   * (spot-based) to match the backtest pipeline exactly.
   *
   * @param {Object} contract - Raw Schwab contract
   * @param {number} spotPrice - Underlying spot price
   * @param {number} T - Time to expiration in years (precomputed per expiration)
   */
  _convertToTradierFormat(contract, spotPrice, T) {
    const isCall = (contract.putCall || '').toUpperCase() === 'CALL';
    const optionType = isCall ? 'C' : 'P';

    // Schwab expirationDate is ISO with timezone: "2026-03-11T20:00:00.000+00:00"
    let expirationDate = '';
    if (contract.expirationDate) {
      expirationDate = contract.expirationDate.substring(0, 10);
    }

    // Calculate independent IV from bid/ask mid price using vanilla BS
    const bid = contract.bid || 0;
    const ask = contract.ask || 0;
    const midPrice = (bid + ask) / 2;

    let midIV = (contract.volatility || 0) / 100; // fallback to Schwab's shared IV
    if (spotPrice > 0 && midPrice > 0 && T > 0 && contract.strikePrice > 0) {
      const solved = calculateIV(midPrice, spotPrice, contract.strikePrice, T, RISK_FREE_RATE, optionType);
      if (solved !== null) {
        midIV = solved;
      }
    }

    return {
      symbol: (contract.symbol || '').trim(),
      strike: contract.strikePrice,
      option_type: isCall ? 'call' : 'put',
      expiration_date: expirationDate,
      open_interest: contract.openInterest || 0,
      bid,
      ask,
      last: contract.last,
      volume: contract.totalVolume || 0,
      greeks: {
        delta: contract.delta || 0,
        gamma: contract.gamma || 0,
        theta: contract.theta || 0,
        vega: contract.vega || 0,
        rho: contract.rho || 0,
        mid_iv: midIV
      }
    };
  }

  /**
   * Get quotes for symbols.
   * Returns data in Tradier format: { quotes: { quote: [{ symbol, last, ... }] } }
   */
  async getQuotes(symbols) {
    const symbolString = Array.isArray(symbols) ? symbols.join(',') : symbols;
    const data = await this.makeRequest(
      `/marketdata/v1/quotes?symbols=${encodeURIComponent(symbolString)}&indicative=false`
    );

    // Schwab returns { "QQQ": { quote: { lastPrice: 605.51 } }, "SPY": { ... } }
    // Convert to Tradier format: { quotes: { quote: [{ symbol: "QQQ", last: 605.51 }] } }
    const quotes = [];

    for (const [sym, entry] of Object.entries(data || {})) {
      const q = entry.quote || entry;
      quotes.push({
        symbol: sym,
        last: q.lastPrice ?? q.last ?? null,
        bid: q.bidPrice ?? q.bid ?? null,
        ask: q.askPrice ?? q.ask ?? null,
        volume: q.totalVolume ?? q.volume ?? 0
      });
    }

    return { quotes: { quote: quotes } };
  }

  // ===== WebSocket Stubs (trigger REST polling fallback) =====

  async connectWebSocket(symbols = ['SPY', 'QQQ']) {
    this.subscribedSymbols = symbols;
    // Intentionally throw to trigger the REST polling fallback path
    // in OptionsExposureService.start()
    throw new Error('Schwab WebSocket not implemented — using REST polling');
  }

  setQuotesCallback(callback) {
    this.quotesCallback = callback;
  }

  disconnect() {
    this.stopTokenRefresh();
    this._fullChainCache.clear();
    this.isConnected = false;
    this.marketStatus = 'disconnected';
    logger.info('Schwab client disconnected');
  }

  getMarketStatus() {
    return {
      status: this.marketStatus,
      isConnected: this.isConnected,
      isConnecting: false,
      lastCloseCode: null,
      reconnectAttempts: 0,
      pendingMarketCheck: false,
      pendingReconnect: false,
      provider: 'schwab'
    };
  }

  // ===== Utility Methods =====

  getRateLimitStatus() {
    const now = Date.now();
    const activeRequests = this.requestTimes.filter(time => now - time < this.requestWindow);

    return {
      requestsInWindow: activeRequests.length,
      maxRequests: this.maxRequests,
      windowMs: this.requestWindow,
      remaining: this.maxRequests - activeRequests.length
    };
  }

  isConfigured() {
    return !!(this.accessToken && this.appKey);
  }

  async testConnection() {
    try {
      // Load tokens from Redis (may have been seeded or updated by another instance)
      await this._loadTokens();

      // Refresh token first in case access token expired
      if (this.refreshToken) {
        await this.refreshAccessToken();
      }
      // Test with a simple quotes call
      await this.getQuotes('SPY');
      this.isConnected = true;
      this.marketStatus = 'connected';
      // Start auto-refresh now that we know tokens work
      this.startTokenRefresh();
      return true;
    } catch (error) {
      logger.error('Schwab connection test failed:', error.message);
      this.isConnected = false;
      this.marketStatus = 'disconnected';
      return false;
    }
  }
}

export default SchwabClient;
