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
const RISK_FREE_RATE = 0.045;

// ===== Black's Model IV Solver =====
// Schwab returns a single IV per strike (identical for call and put).
// We need independent call/put IVs for skew calculation, so we solve
// implied volatility from each option's bid/ask mid price using Black's
// model (forward-based). This correctly handles dividends without needing
// to know the dividend schedule — the forward price from put-call parity
// already incorporates expected dividends.

// Abramowitz & Stegun 26.2.17, max error 7.5e-8
function normalCDF(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937;
  const b4 = -1.821255978, b5 = 1.330274429;
  const pp = 0.2316419;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + pp * ax);
  const y = (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
  const cdf = 1 - y * t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  return x >= 0 ? cdf : 1 - cdf;
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black's model option price (forward-based, handles dividends implicitly).
 * F = forward price, K = strike, T = time to expiry, r = risk-free rate
 */
function blackPrice(F, K, T, r, sigma, isCall) {
  if (T <= 0 || sigma <= 0) {
    const df = Math.exp(-r * T);
    return isCall ? Math.max(df * (F - K), 0) : Math.max(df * (K - F), 0);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const df = Math.exp(-r * T);
  if (isCall) {
    return df * (F * normalCDF(d1) - K * normalCDF(d2));
  } else {
    return df * (K * normalCDF(-d2) - F * normalCDF(-d1));
  }
}

function blackVega(F, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return Math.exp(-r * T) * F * Math.sqrt(T) * normalPDF(d1);
}

/**
 * Newton-Raphson IV solver using Black's model (forward-based).
 * Returns decimal IV (e.g. 0.25) or null if it can't converge.
 */
function impliedVolatility(midPrice, F, K, T, r, isCall) {
  if (midPrice <= 0 || T <= 0 || F <= 0 || K <= 0) return null;

  const df = Math.exp(-r * T);
  const intrinsic = isCall ? Math.max(df * (F - K), 0) : Math.max(df * (K - F), 0);
  if (midPrice <= intrinsic + 0.001) return null;

  // Brenner-Subrahmanyam initial guess (adapted for forward)
  let sigma = Math.sqrt(2 * Math.PI / T) * midPrice / (F * df);
  if (sigma <= 0.01 || !isFinite(sigma)) sigma = 0.3;
  if (sigma > 3) sigma = 1.0;

  for (let i = 0; i < 50; i++) {
    const price = blackPrice(F, K, T, r, sigma, isCall);
    const vega = blackVega(F, K, T, r, sigma);
    if (vega < 1e-10) break;

    const diff = price - midPrice;
    if (Math.abs(diff) < 1e-6) break;

    sigma -= diff / vega;
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 5) sigma = 5;
  }

  if (sigma <= 0 || sigma > 5 || !isFinite(sigma)) return null;
  return sigma;
}

/**
 * Compute the implied forward price from ATM put-call parity.
 * F = K + e^(rT) * (C_mid - P_mid)
 * This inherently accounts for dividends.
 */
function computeForwardPrice(spotPrice, callContracts, putContracts, T, r) {
  if (!spotPrice || callContracts.length === 0 || putContracts.length === 0) return spotPrice;

  // Build strike→contract maps
  const callByStrike = new Map();
  for (const c of callContracts) {
    if (c.bid > 0 && c.ask > 0) callByStrike.set(c.strikePrice, c);
  }
  const putByStrike = new Map();
  for (const p of putContracts) {
    if (p.bid > 0 && p.ask > 0) putByStrike.set(p.strikePrice, p);
  }

  // Find ATM strike with both call and put
  let bestStrike = null;
  let bestDist = Infinity;
  for (const strike of callByStrike.keys()) {
    if (!putByStrike.has(strike)) continue;
    const dist = Math.abs(strike - spotPrice);
    if (dist < bestDist) {
      bestDist = dist;
      bestStrike = strike;
    }
  }

  if (bestStrike === null) return spotPrice;

  const callMid = (callByStrike.get(bestStrike).bid + callByStrike.get(bestStrike).ask) / 2;
  const putMid = (putByStrike.get(bestStrike).bid + putByStrike.get(bestStrike).ask) / 2;

  // Put-call parity: F = K + e^(rT) * (C - P)
  const F = bestStrike + Math.exp(r * T) * (callMid - putMid);
  return F;
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
  // Schwab returns ALL expirations in one call, so we cache it
  // and serve both getExpirations() and getOptionsChain() from the same response.

  async _getFullChain(symbol) {
    const cached = this._fullChainCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this._fullChainCacheExpiry) {
      return cached.data;
    }

    // Fetch per-expiration to avoid 502 errors from overly large responses.
    // First get the list of expirations with a minimal chain call.
    const stub = await this.makeRequest(
      `/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}&contractType=ALL&strikeCount=1`
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
   * for a specific expiration date. Computes the implied forward price from
   * ATM put-call parity to handle dividends in IV calculation.
   */
  _flattenChainForExpiration(chain, expiration) {
    const underlyingPrice = chain.underlyingPrice || 0;

    // Collect raw contracts by type for this expiration
    const callContracts = [];
    const putContracts = [];

    for (const [expKey, strikes] of Object.entries(chain.callExpDateMap || {})) {
      if (!expKey.startsWith(expiration)) continue;
      for (const [, contracts] of Object.entries(strikes)) {
        for (const contract of contracts) callContracts.push(contract);
      }
    }
    for (const [expKey, strikes] of Object.entries(chain.putExpDateMap || {})) {
      if (!expKey.startsWith(expiration)) continue;
      for (const [, contracts] of Object.entries(strikes)) {
        for (const contract of contracts) putContracts.push(contract);
      }
    }

    // Compute time to expiry from the expiration date string
    const expMs = new Date(expiration + 'T16:00:00-05:00').getTime();
    const T = Math.max((expMs - Date.now()) / (365.25 * 24 * 60 * 60 * 1000), 1 / 365);

    // Compute forward price from ATM put-call parity (handles dividends)
    const forwardPrice = computeForwardPrice(underlyingPrice, callContracts, putContracts, T, RISK_FREE_RATE);

    // Convert all contracts using the forward price
    const options = [];
    for (const contract of callContracts) {
      options.push(this._convertToTradierFormat(contract, forwardPrice, T));
    }
    for (const contract of putContracts) {
      options.push(this._convertToTradierFormat(contract, forwardPrice, T));
    }

    return options;
  }

  /**
   * Convert a single Schwab option contract to Tradier format.
   * Calculates independent IV from bid/ask mid price via Black's model
   * (forward-based), since Schwab returns a single shared IV per strike.
   *
   * @param {Object} contract - Raw Schwab contract
   * @param {number} forwardPrice - Implied forward from ATM put-call parity
   * @param {number} T - Time to expiration in years (precomputed per expiration)
   */
  _convertToTradierFormat(contract, forwardPrice, T) {
    const isCall = (contract.putCall || '').toUpperCase() === 'CALL';

    // Schwab expirationDate is ISO with timezone: "2026-03-11T20:00:00.000+00:00"
    let expirationDate = '';
    if (contract.expirationDate) {
      expirationDate = contract.expirationDate.substring(0, 10);
    }

    // Calculate independent IV from bid/ask mid price using Black's model
    const bid = contract.bid || 0;
    const ask = contract.ask || 0;
    const midPrice = (bid + ask) / 2;

    let midIV = (contract.volatility || 0) / 100; // fallback to Schwab's shared IV
    if (forwardPrice > 0 && midPrice > 0 && T > 0 && contract.strikePrice > 0) {
      const solved = impliedVolatility(midPrice, forwardPrice, contract.strikePrice, T, RISK_FREE_RATE, isCall);
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
