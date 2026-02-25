// TradingView WebSocket Client
import WebSocket from 'ws';
import EventEmitter from 'events';
import { createLogger, messageBus } from '../../../shared/index.js';
import Redis from 'ioredis';
import { refreshToken, refreshJwtFromSession, getTokenTTL, cacheTokenInRedis, getBestAvailableToken } from '../utils/tradingview-auth.js';

const logger = createLogger('tradingview-client');

// Token refresh constants
// NOTE: JWT exp claim is NOT a reliable indicator of token invalidity.
// TradingView WebSocket tokens typically work for DAYS after exp.
// Only refresh when there's actual evidence: WS disconnect or delayed quotes.
const TOKEN_REFRESH_RETRY_MS = 4 * 60 * 60 * 1000; // 4 hours on failure (no rush if WS still works)
const TOKEN_REFRESH_MAX_RETRIES = 3; // Stop retrying after 3 consecutive failures
const DELAYED_QUOTE_THRESHOLD_S = 10 * 60; // 10 minutes lag = delayed

// TradingView WebSocket endpoints (match working Python implementation)
const TV_WEBSOCKET_URL = 'wss://data.tradingview.com/socket.io/websocket?from=chart%2FVEPYsueI%2F&type=chart';
const TV_ORIGIN = 'https://www.tradingview.com';

// Liquidity Triggers indicator by DeepDiveStocks
const LIQUIDITY_TRIGGER_INDICATOR = 'PUB;7e87924bf26940f3b0e4e245ec9e30b2';

class TradingViewClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(20); // Increase max listeners to prevent warnings

    this.credentials = options.credentials;
    this.jwtToken = options.jwtToken;
    this.symbols = options.symbols || [];
    this.quoteOnlySymbols = options.quoteOnlySymbols || [];
    this.redisUrl = options.redisUrl || 'redis://localhost:6379';

    this.ws = null;
    this.connected = false;
    this.quoteSession = null;
    this.chartSessions = new Map(); // Track chart sessions per symbol
    this.sessionToSymbol = new Map(); // Track which symbol each chart session belongs to
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.reconnectAttempts = 0;
    this.pingInterval = null;

    // Candle tracking for 15-minute detection
    this.lastCandleTimes = new Map();

    // Timeframe tracking per chart session (sessionId -> timeframe string)
    this.sessionTimeframe = new Map();

    // Configurable candle history bars (default 10 for standard, 500 for AI trader)
    this.candleHistoryBars = parseInt(options.candleHistoryBars || process.env.CANDLE_HISTORY_BARS || '10');

    // Message counter for TradingView protocol
    this.messageCounter = 1;

    // Connection monitoring
    this.lastHeartbeat = null;
    this.lastQuoteReceived = null;
    this.connectionHealthInterval = null;

    // Redis for storing latest quotes
    this.redis = null;
    this.redisConnected = false;

    // Auth state tracking: 'authenticated' | 'delayed' | 'unknown'
    this.authState = 'unknown';
    this.tokenRefreshEnabled = options.tokenRefreshEnabled !== false;
    this.tokenRefreshRetryTimeout = null;
    this.isRefreshingToken = false; // Prevent reconnect loop during token refresh
    this.tokenRefreshRetryCount = 0; // Track consecutive refresh failures
    this.lastDelayedAlert = null; // Throttle delayed-quote alerts
  }

  async initializeRedis() {
    if (!this.redis) {
      try {
        this.redis = new Redis(this.redisUrl, {
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 3,
          lazyConnect: true
        });

        await this.redis.connect();
        this.redisConnected = true;
        logger.info('Connected to Redis for quote storage');
      } catch (error) {
        logger.warn('Failed to connect to Redis for quote storage:', error.message);
        this.redisConnected = false;
      }
    }
  }

  storeLatestQuote(baseSymbol, quoteData) {
    // Fire-and-forget Redis storage to avoid blocking quote processing
    this.initializeRedis().then(() => {
      if (this.redisConnected) {
        const key = `latest_quote_${baseSymbol}`;
        this.redis.setex(key, 300, JSON.stringify(quoteData)).catch(error => {
          logger.warn(`Failed to store quote for ${baseSymbol}:`, error.message);
        });
      }
    }).catch(error => {
      logger.warn(`Redis initialization failed for ${baseSymbol}:`, error.message);
    });
  }

  generateSession(prefix = 'qs') {
    // Generate random session ID like qs_xxxxxxxxxxxx or cs_xxxxxxxxxxxx
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    let randomString = '';
    for (let i = 0; i < 12; i++) {
      randomString += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${prefix}_${randomString}`;
  }

  createMessage(func, params) {
    // Create message in TradingView format
    const message = JSON.stringify({ m: func, p: params });
    return `~m~${message.length}~m~${message}`;
  }

  sendMessage(func, params) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = this.createMessage(func, params);
      this.ws.send(message);
      logger.debug(`📤 Sent: ${func} with params: ${JSON.stringify(params)}`);
    } else {
      logger.warn(`❌ Cannot send ${func} - WebSocket not open (state: ${this.ws?.readyState})`);
    }
  }

  async connect() {
    try {      
      logger.info(`🌐 Connecting to TradingView WebSocket: ${TV_WEBSOCKET_URL}`);
      logger.info(`📋 Symbols to stream: [${this.symbols.join(', ')}]`);

      // Create WebSocket connection with proper headers
      this.ws = new WebSocket(TV_WEBSOCKET_URL, {
        headers: {
          'Connection': 'upgrade',
          'Host': 'data.tradingview.com',
          'Origin': TV_ORIGIN,
          'Cache-Control': 'no-cache',
          'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
          'Sec-WebSocket-Version': '13',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.116 Safari/537.36',
          'Pragma': 'no-cache',
          'Upgrade': 'websocket'
        }
      });

      // Set up event handlers
      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (error) => this.handleError(error));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason));

      // Wait for connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 30000);

        this.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.connected = true;
      logger.info('Successfully connected to TradingView');

    } catch (error) {
      logger.error('Failed to connect to TradingView:', error);
      throw error;
    }
  }

  handleOpen() {
    logger.info('WebSocket connection opened');
    this.reconnectAttempts = 0;
    this.tokenRefreshRetryCount = 0; // Reset on successful connection

    // Initialize sessions
    this.initializeSessions();

    // Start connection health monitoring
    this.startConnectionHealthMonitoring();

    // TradingView handles ping/pong automatically - no need for custom interval
    this.emit('connected');

    // Token refresh is now reactive-only (triggered by delayed quotes or WS auth errors).
    // No proactive schedule — JWT exp is not a reliable invalidation signal.
  }

  initializeSessions() {
    // Generate session IDs
    this.quoteSession = this.generateSession('qs');

    // Log authentication status
    const authToken = this.jwtToken || 'unauthorized_user_token';
    const isAuthenticated = this.jwtToken && this.jwtToken !== '';

    logger.info(`🔐 TradingView Authentication Status: ${isAuthenticated ? 'AUTHENTICATED' : 'UNAUTHENTICATED'}`);
    if (isAuthenticated) {
      logger.info(`🔑 Using JWT token (${this.jwtToken.length} chars): ${this.jwtToken.substring(0, 50)}...`);
    } else {
      logger.warn('⚠️  NO JWT TOKEN - Using unauthorized_user_token (15min delayed quotes!)');
    }

    // Send initialization sequence exactly like Python implementation
    this.sendMessage('set_auth_token', [authToken]);
    this.sendMessage('set_locale', ['en', 'US']);
    this.sendMessage('quote_create_session', [this.quoteSession]);
    this.sendMessage('quote_set_fields', [
      this.quoteSession,
      'ch', 'chp', 'current_session', 'description', 'local_description',
      'language', 'exchange', 'fractional', 'is_tradable', 'lp', 'lp_time',
      'minmov', 'minmove2', 'original_name', 'pricescale', 'pro_name',
      'short_name', 'type', 'update_mode', 'volume', 'currency_code',
      'rchp', 'rtc',
      'open_price', 'high_price', 'low_price', 'prev_close_price'
    ]);

    logger.info('Sessions initialized with proper handshake sequence');
  }

  startConnectionHealthMonitoring() {
    // Clear any existing interval
    if (this.connectionHealthInterval) {
      clearInterval(this.connectionHealthInterval);
    }

    // Monitor connection health every 60 seconds
    this.connectionHealthInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, 60000);

    logger.info('🩺 TradingView connection health monitoring started');
  }

  checkConnectionHealth() {
    const now = new Date();
    const heartbeatAge = this.lastHeartbeat ? (now - this.lastHeartbeat) / 1000 : null;
    const quoteAge = this.lastQuoteReceived ? (now - this.lastQuoteReceived) / 1000 : null;

    if (!this.connected) {
      logger.error(`❌ TradingView HEALTH CHECK: Connection is DOWN`);
      return;
    }

    if (heartbeatAge === null) {
      logger.warn(`⚠️ TradingView HEALTH: No heartbeat received yet`);
    } else if (heartbeatAge > 60) {
      logger.error(`❌ TradingView HEALTH: No heartbeat for ${Math.floor(heartbeatAge)}s - connection may be stale`);
    }

    if (quoteAge === null) {
      logger.warn(`⚠️ TradingView HEALTH: No quotes received yet`);
    } else if (quoteAge > 120) {
      logger.error(`❌ TradingView HEALTH: No quotes for ${Math.floor(quoteAge)}s - data flow stopped!`);
    } else {
      logger.info(`✅ TradingView HEALTH: Connection active - last quote ${Math.floor(quoteAge)}s ago, authState: ${this.authState}`);
    }

    // Report token TTL
    const ttl = getTokenTTL(this.jwtToken);
    if (ttl !== null) {
      if (ttl < 0) {
        logger.warn(`⚠️ TradingView HEALTH: JWT token EXPIRED ${Math.floor(-ttl / 60)} minutes ago`);
      } else {
        logger.info(`🔑 TradingView HEALTH: JWT token expires in ${Math.floor(ttl / 60)} minutes`);
      }
    }
  }

  handleMessage(data) {
    const message = data.toString();

    // Only log raw messages in debug mode (reduces spam)
    if (!message.startsWith('~h~')) {
      logger.debug(`🔍 TradingView raw message: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`);
    }

    // Handle TradingView protocol messages (heartbeat) - match Python implementation
    if (message.match(/^~m~\d+~m~~h~\d+$/)) {
      // Echo back the message immediately (like Python implementation)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(message);
        this.lastHeartbeat = new Date();
        logger.debug(`🏓 Heartbeat echoed: ${message}`);
      }
      return;
    }

    // Split messages using regex pattern
    const messages = message.split(/~m~\d+~m~/);

    for (const msg of messages) {
      if (msg && msg.trim()) {
        this.parseMessage(msg);
      }
    }
  }

  parseMessage(content) {
    try {
      const data = JSON.parse(content);

      // Handle different message types
      if (data.m === 'qsd') {
        // Quote data
        this.handleQuoteData(data);
      } else if (data.m === 'du') {
        // Data update (candles, indicators)
        this.handleDataUpdate(data);
      } else if (data.m === 'timescale_update') {
        // Timescale update contains OHLCV data
        this.handleTimescaleUpdate(data);
      } else if (data.m === 'symbol_resolved') {
        logger.info('Symbol resolved');
      } else if (data.m === 'series_loading') {
        logger.info('Series loading...');
      } else if (data.m === 'cs_error') {
        logger.error('Chart session error:', data);
      } else if (data.m === 'quote_error') {
        logger.error('Quote session error:', data);
        if (JSON.stringify(data).includes('delayed') || JSON.stringify(data).includes('permission')) {
          logger.error('🚨 AUTHENTICATION ISSUE DETECTED - Check JWT token validity!');
        }
      } else if (data.m === 'critical_error' || data.m === 'protocol_error') {
        logger.error('TradingView protocol error:', data);
        const dataStr = JSON.stringify(data);
        if (dataStr.includes('auth') || dataStr.includes('permission')) {
          logger.error('🚨 AUTHENTICATION FAILURE - JWT token is expired or invalid!');
          if (this.tokenRefreshEnabled) {
            logger.info('🔄 Triggering immediate token refresh due to auth failure...');
            this.refreshAndReconnect();
          }
        }
      } else if (data.m && data.m.includes('error')) {
        logger.warn('TradingView error message:', data);
      }

    } catch (error) {
      // Not JSON, might be protocol message
      if (content.length > 0 && content !== '~') {
        logger.debug('Non-JSON message:', content.substring(0, 100));
      }
    }
  }

  async handleQuoteData(data) {
    const payload = data.p;
    if (payload && payload.length >= 2) {
      const quoteData = payload[1];
      let symbol = quoteData.n;
      const values = quoteData.v || {};

      // TradingView echoes resolve-format strings back as the symbol identifier
      // e.g. '={"adjustment":"splits","symbol":"CME_MINI:MES1!"}' — extract the actual symbol
      if (symbol && symbol.startsWith('=')) {
        try {
          const resolved = JSON.parse(symbol.slice(1));
          symbol = resolved.symbol || symbol;
        } catch {
          // Not valid JSON after '=' — use as-is
        }
      }

      const baseSymbol = this.extractBaseSymbol(symbol);
      // qsd provides session-level data — emit under distinct names so they
      // don't collide with candle open/high/low from du/timescale_update.
      // Only set close from lp (last price); do NOT set open/high/low here.
      const quote = {
        symbol: symbol,
        baseSymbol: baseSymbol,
        close: values.lp,
        volume: values.volume,
        sessionOpen: values.open_price,
        sessionHigh: values.high_price,
        sessionLow: values.low_price,
        prevClose: values.prev_close_price,
        change: values.ch,
        changePercent: values.chp,
        timestamp: new Date().toISOString(),
        source: 'tradingview'
      };

      // Skip qsd messages with no last price — TradingView sends periodic
      // incremental updates with only volume/change fields that aren't useful
      // without a price. Session data (open, prev close) arrives with lp set.
      if (!values.lp) {
        return;
      }

      // Detect delayed quotes (fallback auth detection)
      this.checkQuoteDelay(values);

      // Store latest quote in Redis for GEX calculator
      this.storeLatestQuote(baseSymbol, quote);

      this.emit('quote', quote);
    }
  }

  async handleTimescaleUpdate(data) {
    // Handle timescale_update which contains OHLCV data (like Python _serialize_ohlc)
    if (data.p && data.p.length >= 2) {
      const sessionId = data.p[0];
      const ohlcData = data.p[1]?.sds_1?.s || [];
      const symbol = this.sessionToSymbol.get(sessionId);
      const seriesTimeframe = this.sessionTimeframe.get(sessionId) || '1';

      if (!symbol) {
        logger.debug(`Unknown session ${sessionId} - skipping timescale update`);
        return;
      }

      if (ohlcData && ohlcData.length > 0) {
        const baseSymbol = this.extractBaseSymbol(symbol);

        // Emit ALL historical candles as a history_loaded event
        if (ohlcData.length > 1) {
          const allCandles = ohlcData
            .filter(bar => bar.v && bar.v.length >= 5 && bar.v[0] && bar.v[4])
            .map(bar => ({
              symbol,
              baseSymbol,
              timestamp: new Date(bar.v[0] * 1000).toISOString(),
              candleTimestamp: bar.v[0],
              open: bar.v[1],
              high: bar.v[2],
              low: bar.v[3],
              close: bar.v[4],
              volume: bar.v[5] || 0,
              source: 'tradingview'
            }));

          if (allCandles.length > 0) {
            logger.info(`📚 History loaded: ${allCandles.length} ${seriesTimeframe}m candles for ${baseSymbol}`);
            this.emit('history_loaded', {
              symbol,
              baseSymbol,
              timeframe: seriesTimeframe,
              candles: allCandles
            });
          }
        }

        // Get the latest candle and emit as quote (preserves backward compatibility)
        const latestCandle = ohlcData[ohlcData.length - 1];
        const values = latestCandle.v;

        if (values && values.length >= 5) {
          const [candleTimestamp, open, high, low, close, volume] = values;

          if (candleTimestamp && close) {
            const candleTimeMs = candleTimestamp * 1000;
            const quote = {
              symbol: symbol,
              baseSymbol: baseSymbol,
              close: close,
              open: open,
              high: high,
              low: low,
              volume: volume || 0,
              timestamp: new Date(candleTimeMs).toISOString(),
              candleTimestamp: candleTimestamp,
              source: 'tradingview'
            };

            this.storeLatestQuote(baseSymbol, quote);
            this.emit('quote', quote);
          }
        }
      }
    }
  }

  extractSymbolFromSession(data) {
    // Extract chart session from the message
    if (data.p && data.p.length > 0) {
      const sessionId = data.p[0];
      const symbol = this.sessionToSymbol.get(sessionId);
      if (symbol) {
        return symbol;
      }
    }

    // Fallback to first symbol if we can't determine from session
    return this.symbols[0] || 'CME_MINI:NQ1!';
  }

  handleDataUpdate(data) {
    const payload = data.p;
    if (!payload || payload.length < 2) return;

    const sessionId = payload[0];
    const update = payload[1];
    const symbol = this.sessionToSymbol.get(sessionId);

    if (!symbol) {
      logger.debug(`Unknown session ${sessionId} in du message - skipping data update`);
      return;
    }

    logger.debug(`📊 Data update for session ${sessionId} -> ${symbol}`);

    // Check for OHLCV data in sds_1 (like Python parsing)
    if (update.sds_1?.s) {
      const series = update.sds_1.s;
      if (series && series.length > 0) {
        // Get the latest bar (like Python implementation)
        const latestBar = series[series.length - 1];
        const values = latestBar.v;

        // v = [timestamp, open, high, low, close, volume]
        if (values && values.length >= 5) {
          const candleTimestamp = values[0];
          const baseSymbol = this.extractBaseSymbol(symbol);
          // Convert TradingView epoch seconds to milliseconds for proper Date handling
          const candleTimeMs = candleTimestamp * 1000;
          const quote = {
            symbol: symbol,
            baseSymbol: baseSymbol,
            close: values[4], // close price
            open: values[1],
            high: values[2],
            low: values[3],
            volume: values[5] || 0,
            // Use TradingView's candle timestamp (aligned to minute boundaries)
            timestamp: new Date(candleTimeMs).toISOString(),
            candleTimestamp: candleTimestamp, // Epoch seconds for precise comparison
            source: 'tradingview'
          };

          // Store latest quote in Redis for GEX calculator
          this.storeLatestQuote(baseSymbol, quote);

          // Track quote reception for health monitoring
          this.lastQuoteReceived = new Date();

          this.emit('quote', quote);
        }
      }
    }

    // Check for indicator data (LT levels)
    for (const key in update) {
      if (key.startsWith('st') && update[key]?.st) {
        this.handleIndicatorData(update[key].st);
      }
    }
  }

  handleOHLCVData(data) {
    const series = data.s;
    if (!series || series.length === 0) return;

    // Get the latest candle
    const latestCandle = series[series.length - 1];
    const values = latestCandle.v;

    if (values && values.length >= 6) {
      const [timestamp, open, high, low, close, volume] = values;

      // Check for 15-minute candle completion
      const symbol = data.ns?.d || 'UNKNOWN';
      if (this.checkCandleClose(symbol, timestamp)) {
        const candle = {
          symbol: symbol,
          timestamp: timestamp,
          open: open,
          high: high,
          low: low,
          close: close,
          volume: volume,
          timeframe: '15'
        };

        this.emit('candle', candle);
        logger.info(`15-minute candle closed for ${symbol} at ${close}`);
      }
    }
  }

  handleIndicatorData(studyData) {
    if (!studyData || studyData.length === 0) return;

    // Get the most recent indicator values
    const latest = studyData[studyData.length - 1];
    const values = latest.v;

    if (!values || values.length < 18) return;

    // Parse LT levels (positions 5, 7, 9, 11, 13, 15, 17)
    const levels = {
      timestamp: values[0],
      candleTime: new Date(values[0] * 1000).toISOString(),
      L0: values[5] !== 1e+100 ? values[5] : null,
      L1: values[7] !== 1e+100 ? values[7] : null,
      L2: values[9] !== 1e+100 ? values[9] : null,
      L3: values[11] !== 1e+100 ? values[11] : null,
      L4: values[13] !== 1e+100 ? values[13] : null,
      L5: values[15] !== 1e+100 ? values[15] : null,
      L6: values[17] !== 1e+100 ? values[17] : null
    };

    this.emit('lt_levels', levels);
    logger.info('LT levels updated:', Object.entries(levels)
      .filter(([k, v]) => k.startsWith('L') && v !== null)
      .map(([k, v]) => `${k}:${v}`)
      .join(', '));
  }

  checkCandleClose(symbol, timestamp) {
    const currentInterval = Math.floor(timestamp / 900) * 900; // 900 seconds = 15 minutes
    const lastInterval = this.lastCandleTimes.get(symbol) || 0;

    if (currentInterval > lastInterval) {
      this.lastCandleTimes.set(symbol, currentInterval);
      return true;
    }
    return false;
  }

  extractBaseSymbol(symbol) {
    // Extract base symbol from full symbol
    if (symbol.includes('NQ') && !symbol.includes('MNQ')) return 'NQ';
    if (symbol.includes('MNQ')) return 'MNQ';
    if (symbol.includes('ES') && !symbol.includes('MES')) return 'ES';
    if (symbol.includes('MES')) return 'MES';
    if (symbol.includes('BTC')) return 'BTC';
    if (symbol.includes('QQQ')) return 'QQQ';
    if (symbol.includes('SPY')) return 'SPY';
    return symbol;
  }


  async startStreaming() {
    logger.info('Starting data streaming for symbols:', this.symbols);

    // Subscribe to all symbols with delay between subscriptions
    for (const symbolFull of this.symbols) {
      await this.subscribeToSymbol(symbolFull);
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay between subscriptions
    }

    // Subscribe to quote-only symbols (no chart session, just price data via qsd)
    if (this.quoteOnlySymbols && this.quoteOnlySymbols.length > 0) {
      logger.info('Adding quote-only symbols:', this.quoteOnlySymbols);
      for (const symbolFull of this.quoteOnlySymbols) {
        this.addQuoteOnlySymbol(symbolFull);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    logger.info('Quote session active - qsd messages will provide session-level data');
  }

  /**
   * Add a symbol to the quote session only (no chart session / OHLCV data).
   * Used for symbols where only the last price is needed (e.g., QQQ, SPY for GEX translation).
   */
  addQuoteOnlySymbol(symbolFull) {
    const [exchange, symbol] = symbolFull.includes(':')
      ? symbolFull.split(':')
      : ['CME_MINI', symbolFull];

    const exchangeSymbol = `${exchange}:${symbol}`;
    const resolveSymbol = JSON.stringify({ "adjustment": "splits", "symbol": exchangeSymbol });

    this.sendMessage('quote_add_symbols', [this.quoteSession, `=${resolveSymbol}`]);
    this.sendMessage('quote_fast_symbols', [this.quoteSession, exchangeSymbol]);

    logger.info(`Added quote-only symbol: ${exchangeSymbol} (no chart session)`);
  }

  async subscribeToSymbol(symbolFull) {
    try {
      const [exchange, symbol] = symbolFull.includes(':')
        ? symbolFull.split(':')
        : ['CME_MINI', symbolFull];

      const exchangeSymbol = `${exchange}:${symbol}`;
      logger.info(`Subscribing to ${exchangeSymbol}`);

      // Generate chart session ID
      const chartSession = this.generateSession('cs');

      // Create symbol resolve string exactly like Python implementation
      const resolveSymbol = JSON.stringify({
        "adjustment": "splits",
        "symbol": exchangeSymbol
      });

      // Create chart session
      this.sendMessage('chart_create_session', [chartSession, '']);

      // Add symbols to quote session exactly like Python
      this.sendMessage('quote_add_symbols', [this.quoteSession, `=${resolveSymbol}`]);

      // Resolve symbol for chart data
      this.sendMessage('resolve_symbol', [chartSession, 'sds_sym_1', `=${resolveSymbol}`]);

      // Create series for 1-minute timeframe (like Python)
      this.sendMessage('create_series', [
        chartSession,
        'sds_1',
        's1',
        'sds_sym_1',
        '1',  // 1-minute timeframe like Python
        this.candleHistoryBars,  // Configurable: 10 default, 500 for AI trader
        ''
      ]);

      // Add quote_fast_symbols like Python implementation (with raw symbol, not resolve format)
      this.sendMessage('quote_fast_symbols', [this.quoteSession, exchangeSymbol]);

      // TODO: Fix LT indicator - needs proper 15-minute series setup
      // Temporarily disabled to stabilize connection
      /*
      if (symbol.includes('NQ') && !symbol.includes('MNQ')) {
        // Need to create 15-minute series and add LT indicator
        logger.info(`LT indicator temporarily disabled for ${symbol}`);
      }
      */

      // Store chart session mapping before hibernation
      this.chartSessions.set(exchangeSymbol, chartSession);
      this.sessionToSymbol.set(chartSession, exchangeSymbol);
      this.sessionTimeframe.set(chartSession, '1'); // Default 1m timeframe

      logger.info(`Successfully subscribed to ${exchangeSymbol} with chart session ${chartSession} (${this.candleHistoryBars} bars)`);


    } catch (error) {
      logger.error(`Failed to subscribe to ${symbolFull}:`, error);
      throw error;
    }
  }

  /**
   * Create an additional chart session at a different timeframe for history capture.
   * Used by AI trader to get hourly candles alongside the standard 1m session.
   * @param {string} symbolFull - Symbol in exchange:symbol format (e.g., 'CME_MINI:NQ1!')
   * @param {string} timeframe - TradingView timeframe string (e.g., '60' for 1h, '15' for 15m)
   * @param {number} barCount - Number of historical bars to request
   */
  async createHistorySession(symbolFull, timeframe, barCount) {
    try {
      const [exchange, symbol] = symbolFull.includes(':')
        ? symbolFull.split(':')
        : ['CME_MINI', symbolFull];

      const exchangeSymbol = `${exchange}:${symbol}`;
      const chartSession = this.generateSession('cs');

      logger.info(`Creating history session for ${exchangeSymbol} @ ${timeframe}m (${barCount} bars)`);

      const resolveSymbol = JSON.stringify({
        "adjustment": "splits",
        "symbol": exchangeSymbol
      });

      this.sendMessage('chart_create_session', [chartSession, '']);
      this.sendMessage('resolve_symbol', [chartSession, 'sds_sym_1', `=${resolveSymbol}`]);
      this.sendMessage('create_series', [
        chartSession,
        'sds_1',
        's1',
        'sds_sym_1',
        timeframe,
        barCount,
        ''
      ]);

      // Track session mappings
      this.chartSessions.set(`${exchangeSymbol}_${timeframe}`, chartSession);
      this.sessionToSymbol.set(chartSession, exchangeSymbol);
      this.sessionTimeframe.set(chartSession, timeframe);

      logger.info(`History session created: ${chartSession} for ${exchangeSymbol} @ ${timeframe}m`);

      // Small delay to let TradingView process
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(`Failed to create history session for ${symbolFull}@${timeframe}:`, error);
      throw error;
    }
  }

  handleError(error) {
    logger.error(`❌ TradingView WebSocket ERROR: ${error.message}`);
    logger.error(`🔧 Error details:`, error);
    this.emit('error', error);
  }

  handleClose(code, reason) {
    logger.error(`❌ TradingView WebSocket DISCONNECTED - Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    logger.error(`📊 Connection lost with ${this.chartSessions.size} chart sessions active`);
    logger.error(`🔄 This is reconnection attempt #${this.reconnectAttempts}`);

    this.connected = false;

    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Clear health monitoring
    if (this.connectionHealthInterval) {
      clearInterval(this.connectionHealthInterval);
      this.connectionHealthInterval = null;
    }

    // Note: token refresh schedule is NOT cleared on disconnect - it should continue
    // so that a fresh token is ready when we reconnect.

    // Log the impact
    logger.error(`💥 IMPACT: No live quotes will be available until TradingView reconnects!`);

    // Attempt reconnection
    if (this.isRefreshingToken) {
      logger.info(`🔄 Not auto-reconnecting - token refresh in progress will handle reconnection`);
    } else if (!this.isDisconnecting) {
      this.scheduleReconnect();
    } else {
      logger.info(`✋ Not reconnecting - service is shutting down`);
    }
  }

  scheduleReconnect() {
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    logger.warn(`⏰ TradingView reconnection attempt #${this.reconnectAttempts} scheduled in ${delay/1000} seconds...`);

    setTimeout(async () => {
      try {
        logger.info(`🔄 Attempting TradingView reconnection...`);
        await this.connect();
        logger.info(`✅ TradingView reconnected successfully!`);

        // Critical: Start streaming after reconnection
        await this.startStreaming();
        logger.info(`📊 TradingView streaming restarted after reconnection`);
      } catch (error) {
        logger.error(`❌ TradingView reconnection failed: ${error.message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  // --- Token Refresh & Delayed Quote Detection ---

  /**
   * Check if quote data indicates delayed/unauthenticated mode.
   * Called from handleQuoteData() on every qsd message with lp.
   */
  checkQuoteDelay(values) {
    // Check update_mode field for "delayed" indicator
    if (values.update_mode && typeof values.update_mode === 'string' && values.update_mode.includes('delayed')) {
      this.transitionAuthState('delayed');
      return;
    }

    // Check lp_time (last price time, epoch seconds) for staleness
    if (values.lp_time) {
      const nowS = Math.floor(Date.now() / 1000);
      const lag = nowS - values.lp_time;

      if (lag > DELAYED_QUOTE_THRESHOLD_S) {
        // Only flag during likely market hours (weekdays, rough check)
        const now = new Date();
        const dayOfWeek = now.getUTCDay();
        const utcHour = now.getUTCHours();

        // Futures trade Sun 6pm - Fri 5pm ET (roughly UTC Sun 23:00 - Sat 00:00)
        // Skip weekend detection (Sat full day, Sun before 23:00 UTC)
        const isWeekend = dayOfWeek === 6 || (dayOfWeek === 0 && utcHour < 22);

        if (!isWeekend) {
          this.transitionAuthState('delayed');
          return;
        }
      }
    }

    // If we get here with valid data, quotes are real-time
    if (this.authState !== 'authenticated') {
      this.transitionAuthState('authenticated');
    }
  }

  /**
   * Transition auth state and take action on degradation.
   */
  transitionAuthState(newState) {
    if (this.authState === newState) return;

    const oldState = this.authState;
    this.authState = newState;
    logger.info(`Auth state transition: ${oldState} -> ${newState}`);

    if (newState === 'delayed') {
      logger.error('DELAYED QUOTES DETECTED - JWT token may be expired or invalid');

      // Publish service error for monitoring/Discord
      this.publishAuthEvent('tv_auth_degraded', 'Delayed quotes detected - token may be expired');

      // Trigger immediate refresh attempt
      if (this.tokenRefreshEnabled && this.credentials) {
        this.refreshAndReconnect().catch(err => {
          logger.error('Auto-refresh on delayed detection failed:', err.message);
        });
      }
    } else if (newState === 'authenticated' && oldState === 'delayed') {
      logger.info('Quotes restored to real-time');
      this.publishAuthEvent('tv_auth_restored', 'Real-time quotes restored');
    }
  }

  /**
   * Stop any pending refresh retry timers.
   */
  stopTokenRefreshSchedule() {
    if (this.tokenRefreshRetryTimeout) {
      clearTimeout(this.tokenRefreshRetryTimeout);
      this.tokenRefreshRetryTimeout = null;
    }
  }

  /**
   * Refresh the JWT token via HTTP login and reconnect WebSocket.
   * Only called reactively (delayed quotes detected or WS auth error).
   */
  async refreshAndReconnect() {
    if (this.isRefreshingToken) {
      logger.info('Token refresh already in progress, skipping duplicate request');
      return;
    }

    // Check if we've exceeded max retries
    if (this.tokenRefreshRetryCount >= TOKEN_REFRESH_MAX_RETRIES) {
      logger.warn(`Token refresh abandoned after ${TOKEN_REFRESH_MAX_RETRIES} consecutive failures - waiting for manual intervention or WS reconnect to reset`);
      return;
    }

    // Set flag immediately to prevent handleClose from scheduling a reconnect
    // with the same bad token (handleClose checks this flag synchronously)
    this.isRefreshingToken = true;
    try {
      logger.info('Starting JWT token refresh...');

      // Step 1: Try session-based refresh (no login POST, no CAPTCHA risk)
      let newToken = await refreshJwtFromSession(this.redisUrl);

      // Step 2: Fall back to full login if session refresh didn't work
      if (!newToken) {
        logger.info('Session-based refresh unavailable - falling back to full login');
        newToken = await refreshToken(this.credentials, this.redisUrl);
      }

      // Update token
      this.jwtToken = newToken;

      // Cache in Redis for other instances
      await cacheTokenInRedis(this.redisUrl, newToken);

      // Reset retry counter on success
      this.tokenRefreshRetryCount = 0;

      // Publish token refreshed event (for LT monitor and monitoring service)
      this.publishAuthEvent('tv_token_refreshed', 'JWT token refreshed successfully');
      this.emit('token_refreshed', newToken);

      // Reconnect WebSocket with new token
      logger.info('Token refreshed - reconnecting WebSocket with new token...');
      await this.reconnectWithNewToken();

      logger.info('Token refresh and reconnection complete');
    } catch (error) {
      this.tokenRefreshRetryCount++;
      logger.error(`Token refresh failed (attempt ${this.tokenRefreshRetryCount}/${TOKEN_REFRESH_MAX_RETRIES}): ${error.message}`);
      this.publishAuthEvent('tv_token_refresh_failed', `Token refresh failed (attempt ${this.tokenRefreshRetryCount}/${TOKEN_REFRESH_MAX_RETRIES}): ${error.message}`);

      // Schedule retry in 4 hours if we haven't exhausted retries
      if (this.tokenRefreshRetryCount < TOKEN_REFRESH_MAX_RETRIES) {
        logger.info(`Scheduling token refresh retry in ${TOKEN_REFRESH_RETRY_MS / 3600000} hours`);
        if (this.tokenRefreshRetryTimeout) clearTimeout(this.tokenRefreshRetryTimeout);
        this.tokenRefreshRetryTimeout = setTimeout(() => {
          this.refreshAndReconnect().catch(err => {
            logger.error(`Token refresh retry failed: ${err.message}`);
          });
        }, TOKEN_REFRESH_RETRY_MS);
      } else {
        logger.warn(`Max token refresh retries (${TOKEN_REFRESH_MAX_RETRIES}) reached - manual token update required`);
      }

      // Don't reconnect when refresh failed — we'd just loop with the same bad token.
      return;
    } finally {
      this.isRefreshingToken = false;
    }

    // Safety net: if the connection dropped during a SUCCESSFUL refresh (e.g. stale session
    // error caused a second disconnect while isRefreshingToken was true), reconnect now
    // with the fresh token.
    if (!this.connected && !this.isDisconnecting) {
      logger.warn('Connection lost during token refresh - scheduling reconnect with new token');
      this.scheduleReconnect();
    }
  }

  /**
   * Close current WebSocket and reconnect (reuses existing reconnect flow).
   */
  async reconnectWithNewToken() {
    // Temporarily set flag to prevent auto-reconnect in handleClose
    const wasDisconnecting = this.isDisconnecting;
    this.isDisconnecting = true;

    // Close existing connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;

    // Clear intervals that will be recreated on connect
    if (this.connectionHealthInterval) {
      clearInterval(this.connectionHealthInterval);
      this.connectionHealthInterval = null;
    }

    // Reset state
    this.chartSessions.clear();
    this.sessionToSymbol.clear();
    this.sessionTimeframe.clear();
    this.isDisconnecting = wasDisconnecting;
    this.reconnectAttempts = 0;

    // Reconnect
    await this.connect();
    await this.startStreaming();
  }

  /**
   * Publish auth-related events to Redis for monitoring service / Discord.
   */
  publishAuthEvent(type, message) {
    try {
      messageBus.publish('service.error', {
        service: 'signal-generator',
        type,
        message,
        authState: this.authState,
        tokenTTL: getTokenTTL(this.jwtToken),
        timestamp: new Date().toISOString()
      }).catch(err => {
        logger.warn('Failed to publish auth event:', err.message);
      });
    } catch (err) {
      logger.warn('Failed to publish auth event:', err.message);
    }
  }

  async disconnect() {
    logger.info('Disconnecting from TradingView...');
    this.isDisconnecting = true;

    // Stop token refresh schedule
    this.stopTokenRefreshSchedule();

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    logger.info('Disconnected from TradingView');
  }

  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

export default TradingViewClient;