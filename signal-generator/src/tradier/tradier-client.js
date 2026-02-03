import axios from 'axios';
import WebSocket from 'ws';
import { createLogger } from '../../../shared/index.js';
import { isOptionsRTH, tradierMarketClock } from '../utils/session-utils.js';

const logger = createLogger('tradier-client');

// Market check interval: 15 minutes
const MARKET_CHECK_INTERVAL = 15 * 60 * 1000;

class TradierClient {
  constructor(options = {}) {
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl || 'https://api.tradier.com/v1';
    this.accountId = options.accountId;

    // Rate limiting: 120 requests per minute
    this.requestCount = 0;
    this.requestWindow = 60 * 1000; // 1 minute in ms
    this.maxRequests = 100; // Conservative limit under 120
    this.requestTimes = [];

    // WebSocket properties
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.isConnecting = false; // Prevent overlapping connection attempts
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    this.quotesCallback = null;
    this.subscribedSymbols = ['SPY', 'QQQ'];

    // Market-aware status tracking
    // States: 'initializing', 'connected', 'market_closed', 'disconnected', 'reconnecting'
    this.marketStatus = 'initializing';
    this.marketCheckTimer = null;
    this.reconnectTimer = null; // Track pending reconnection timeout
    this.lastCloseCode = null;

    if (!this.accessToken) {
      throw new Error('Tradier access token is required');
    }
  }

  /**
   * Check rate limits before making a request
   */
  checkRateLimit() {
    const now = Date.now();

    // Remove requests older than the window
    this.requestTimes = this.requestTimes.filter(time => now - time < this.requestWindow);

    if (this.requestTimes.length >= this.maxRequests) {
      const oldestRequest = this.requestTimes[0];
      const waitTime = this.requestWindow - (now - oldestRequest);
      throw new Error(`Rate limit exceeded. Wait ${Math.ceil(waitTime / 1000)} seconds`);
    }

    this.requestTimes.push(now);
  }

  /**
   * Make authenticated request to Tradier API
   */
  async makeRequest(endpoint, method = 'GET', data = null) {
    this.checkRateLimit();

    const config = {
      method,
      url: `${this.baseUrl}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'Slingshot-Signal-Generator/1.0'
      },
      timeout: 30000
    };

    if (data && method !== 'GET') {
      config.data = data;
      config.headers['Content-Type'] = 'application/json';
    }

    try {
      logger.debug(`Making ${method} request to ${endpoint}`);
      const response = await axios(config);
      return response.data;
    } catch (error) {
      logger.error(`Tradier API error for ${endpoint}:`, error.message, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      throw error;
    }
  }

  /**
   * Get available options expirations for a symbol
   */
  async getExpirations(symbol, includeAllRoots = true) {
    const endpoint = `/markets/options/expirations?symbol=${symbol}&includeAllRoots=${includeAllRoots}&strikes=false`;
    return await this.makeRequest(endpoint);
  }

  /**
   * Get options chain for symbol and expiration
   */
  async getOptionsChain(symbol, expiration, includeGreeks = true) {
    const endpoint = `/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=${includeGreeks}`;
    return await this.makeRequest(endpoint);
  }

  /**
   * Get quotes for symbols
   */
  async getQuotes(symbols) {
    const symbolString = Array.isArray(symbols) ? symbols.join(',') : symbols;
    const endpoint = `/markets/quotes?symbols=${symbolString}&greeks=false`;
    return await this.makeRequest(endpoint);
  }

  /**
   * Create WebSocket session for streaming
   */
  async createSession() {
    try {
      const response = await this.makeRequest('/markets/events/session', 'POST', {});
      this.sessionId = response.stream?.sessionid;

      if (!this.sessionId) {
        throw new Error('Failed to create Tradier WebSocket session');
      }

      logger.info('Created Tradier WebSocket session:', this.sessionId);
      return this.sessionId;
    } catch (error) {
      logger.error('Failed to create Tradier session:', error.message);
      throw error;
    }
  }

  /**
   * Clean up existing WebSocket connection
   */
  cleanupWebSocket() {
    if (this.ws) {
      // Remove all event listeners to prevent race conditions
      this.ws.removeAllListeners('open');
      this.ws.removeAllListeners('message');
      this.ws.removeAllListeners('close');
      this.ws.removeAllListeners('error');

      // Close if not already closed
      if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
        this.ws.close();
      }

      this.ws = null;
    }
    this.isConnected = false;
  }

  /**
   * Connect to Tradier WebSocket for real-time quotes (market-aware)
   * Only connects when options market is open
   */
  async connectWebSocket(symbols = ['SPY', 'QQQ']) {
    // Guard against overlapping connection attempts
    if (this.isConnected) {
      logger.debug('Tradier WebSocket already connected, skipping connection attempt');
      return;
    }

    if (this.isConnecting) {
      logger.debug('Tradier WebSocket connection already in progress, skipping');
      return;
    }

    try {
      this.isConnecting = true;
      this.subscribedSymbols = symbols;

      // Check if market is open before attempting connection
      const isMarketOpen = await isOptionsRTH();
      const marketDesc = tradierMarketClock.getDescription();

      if (!isMarketOpen) {
        this.marketStatus = 'market_closed';
        const reason = marketDesc || 'outside options market hours';
        logger.info(`Tradier WebSocket paused - ${reason}. Will check again in 15 minutes.`);
        this.scheduleMarketCheck();
        return;
      }

      this.marketStatus = 'reconnecting';

      // Clean up any existing WebSocket before creating new one
      this.cleanupWebSocket();

      // Force session recreation to prevent invalid session reuse
      this.sessionId = null;

      if (!this.sessionId) {
        await this.createSession();
      }

      this.ws = new WebSocket('wss://ws.tradier.com/v1/markets/events');

      this.ws.on('open', () => {
        logger.info('Tradier WebSocket connected');
        this.isConnected = true;
        this.marketStatus = 'connected';
        this.reconnectAttempts = 0;
        this.lastCloseCode = null;

        // Clear any pending market check timer
        if (this.marketCheckTimer) {
          clearTimeout(this.marketCheckTimer);
          this.marketCheckTimer = null;
        }

        // Subscribe to symbols
        const subscription = {
          symbols: this.subscribedSymbols,
          filter: ['quote', 'trade'],
          sessionid: this.sessionId,
          linebreak: true
        };

        this.ws.send(JSON.stringify(subscription));
        logger.info(`Subscribed to Tradier quotes for: ${this.subscribedSymbols.join(', ')}`);
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleWebSocketMessage(message);
        } catch (error) {
          logger.warn('Failed to parse Tradier WebSocket message:', error.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.lastCloseCode = code;
        this.isConnected = false;
        this.sessionId = null; // Force fresh session on next connect

        // Code 1000 = normal closure (often market closed)
        if (code === 1000) {
          logger.info(`Tradier WebSocket closed normally (code ${code})`);
        } else {
          logger.warn(`Tradier WebSocket closed: ${code} - ${reason}`);
        }

        // Attempt market-aware reconnection
        this.scheduleReconnect(code);
      });

      this.ws.on('error', (error) => {
        logger.error('Tradier WebSocket error:', error.message);
        this.isConnected = false;
        this.marketStatus = 'disconnected';
        this.cleanupWebSocket();
      });

    } catch (error) {
      logger.error('Failed to connect Tradier WebSocket:', error.message);
      this.marketStatus = 'disconnected';
      throw error;
    } finally {
      // Always clear isConnecting flag
      this.isConnecting = false;
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleWebSocketMessage(message) {
    if (message.type === 'quote' || message.type === 'trade') {
      if (this.quotesCallback) {
        this.quotesCallback(message);
      }
    } else if (message.type === 'error') {
      logger.error('Tradier WebSocket error message:', message.error || message.message || 'Unknown error');
    } else {
      logger.debug('Tradier WebSocket message:', message.type);
    }
  }

  /**
   * Set callback for quote messages
   */
  setQuotesCallback(callback) {
    this.quotesCallback = callback;
  }

  /**
   * Schedule WebSocket reconnection (market-aware)
   * - Code 1000 during off-hours: wait for market open (check every 15 min)
   * - Code 1000 during market hours: short delay reconnect (with limit)
   * - Other codes: exponential backoff
   */
  async scheduleReconnect(closeCode = null) {
    // Cancel any existing reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Check if market is currently open
    const isMarketOpen = await isOptionsRTH();
    const marketDesc = tradierMarketClock.getDescription();

    // Code 1000 (normal close) + market closed = wait for market open
    if (closeCode === 1000 && !isMarketOpen) {
      this.marketStatus = 'market_closed';
      const reason = marketDesc || 'outside options market hours';
      logger.info(`Tradier WebSocket closed (market closed: ${reason}). Will check again in 15 minutes.`);
      this.scheduleMarketCheck();
      return;
    }

    // Code 1000 during market hours = possible temporary issue, short delay (with limit)
    if (closeCode === 1000 && isMarketOpen) {
      // Increment reconnect attempts to prevent infinite loops
      this.reconnectAttempts++;

      // Check max attempts
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.error('Max Tradier WebSocket reconnection attempts reached (code 1000 during market hours)');
        this.marketStatus = 'disconnected';
        // After max attempts, fall back to market check interval
        this.scheduleMarketCheck();
        return;
      }

      this.marketStatus = 'reconnecting';
      logger.info(`Tradier WebSocket closed during market hours - reconnecting in 5 seconds... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.isConnected && !this.isConnecting) {
          this.connectWebSocket(this.subscribedSymbols).catch(error => {
            logger.error('Tradier WebSocket reconnection failed:', error.message);
          });
        }
      }, 5000);
      return;
    }

    // Other close codes: exponential backoff (existing behavior)
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max Tradier WebSocket reconnection attempts reached');
      this.marketStatus = 'disconnected';
      // After max attempts, fall back to market check interval
      this.scheduleMarketCheck();
      return;
    }

    this.marketStatus = 'reconnecting';
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    logger.info(`Scheduling Tradier WebSocket reconnection in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isConnected && !this.isConnecting) {
        this.connectWebSocket(this.subscribedSymbols).catch(error => {
          logger.error('Tradier WebSocket reconnection failed:', error.message);
        });
      }
    }, delay);
  }

  /**
   * Schedule a check for market open (used during off-hours)
   */
  scheduleMarketCheck() {
    // Clear any existing timer
    if (this.marketCheckTimer) {
      clearTimeout(this.marketCheckTimer);
    }

    this.marketCheckTimer = setTimeout(async () => {
      this.marketCheckTimer = null;

      const isMarketOpen = await isOptionsRTH();
      const marketDesc = tradierMarketClock.getDescription();

      if (isMarketOpen) {
        logger.info('Options market is now open - attempting Tradier WebSocket connection...');
        this.reconnectAttempts = 0; // Reset reconnect attempts for fresh start
        this.connectWebSocket(this.subscribedSymbols).catch(error => {
          logger.error('Tradier WebSocket connection failed:', error.message);
        });
      } else {
        const reason = marketDesc || 'outside options market hours';
        logger.debug(`Market still closed (${reason}) - checking again in 15 minutes`);
        this.scheduleMarketCheck();
      }
    }, MARKET_CHECK_INTERVAL);
  }

  /**
   * Get current market-aware status
   */
  getMarketStatus() {
    return {
      status: this.marketStatus,
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      lastCloseCode: this.lastCloseCode,
      reconnectAttempts: this.reconnectAttempts,
      pendingMarketCheck: !!this.marketCheckTimer,
      pendingReconnect: !!this.reconnectTimer
    };
  }

  /**
   * Disconnect WebSocket
   */
  disconnect() {
    // Clear any pending reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clear any pending market check timer
    if (this.marketCheckTimer) {
      clearTimeout(this.marketCheckTimer);
      this.marketCheckTimer = null;
    }

    if (this.ws) {
      this.marketStatus = 'disconnected';
      this.cleanupWebSocket();
      logger.info('Tradier WebSocket disconnected');
    }
  }

  /**
   * Get current rate limit status
   */
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

  /**
   * Check if client is properly configured
   */
  isConfigured() {
    return !!(this.accessToken && this.baseUrl);
  }

  /**
   * Test API connectivity
   */
  async testConnection() {
    try {
      await this.getQuotes('SPY');
      return true;
    } catch (error) {
      logger.error('Tradier connection test failed:', error.message);
      return false;
    }
  }
}

export default TradierClient;