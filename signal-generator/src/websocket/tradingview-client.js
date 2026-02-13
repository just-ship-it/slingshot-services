// TradingView WebSocket Client
import WebSocket from 'ws';
import EventEmitter from 'events';
import { createLogger } from '../../../shared/index.js';
import Redis from 'ioredis';

const logger = createLogger('tradingview-client');

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

    // Message counter for TradingView protocol
    this.messageCounter = 1;

    // Connection monitoring
    this.lastHeartbeat = null;
    this.lastQuoteReceived = null;
    this.connectionHealthInterval = null;

    // Redis for storing latest quotes
    this.redis = null;
    this.redisConnected = false;
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

    // Initialize sessions
    this.initializeSessions();

    // Start connection health monitoring
    this.startConnectionHealthMonitoring();

    // TradingView handles ping/pong automatically - no need for custom interval
    this.emit('connected');
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
      logger.info(`✅ TradingView HEALTH: Connection active - last quote ${Math.floor(quoteAge)}s ago`);
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
        if (JSON.stringify(data).includes('auth') || JSON.stringify(data).includes('permission')) {
          logger.error('🚨 AUTHENTICATION FAILURE - JWT token may be expired or invalid!');
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

      if (!symbol) {
        logger.debug(`Unknown session ${sessionId} - skipping timescale update`);
        return;
      }

      if (ohlcData && ohlcData.length > 0) {
        // Get the latest candle (like Python implementation)
        const latestCandle = ohlcData[ohlcData.length - 1];
        const values = latestCandle.v;

        if (values && values.length >= 5) {
          const [candleTimestamp, open, high, low, close, volume] = values;

          if (candleTimestamp && close) {
            // Always emit quote update for real-time price
            const baseSymbol = this.extractBaseSymbol(symbol);
            // Convert TradingView epoch seconds to milliseconds for proper Date handling
            const candleTimeMs = candleTimestamp * 1000;
            const quote = {
              symbol: symbol,
              baseSymbol: baseSymbol,
              close: close,
              open: open,
              high: high,
              low: low,
              volume: volume || 0,
              // Use TradingView's candle timestamp (aligned to minute boundaries)
              timestamp: new Date(candleTimeMs).toISOString(),
              candleTimestamp: candleTimestamp, // Epoch seconds for precise comparison
              source: 'tradingview'
            };

            // Store latest quote in Redis for GEX calculator (non-blocking)
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

    logger.info('Quote session active - qsd messages will provide session-level data');
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
        10,   // Number of candles like Python default
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

      logger.info(`Successfully subscribed to ${exchangeSymbol} with chart session ${chartSession}`);


    } catch (error) {
      logger.error(`Failed to subscribe to ${symbolFull}:`, error);
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

    // Log the impact
    logger.error(`💥 IMPACT: No live quotes will be available until TradingView reconnects!`);

    // Attempt reconnection
    if (!this.isDisconnecting) {
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

  async disconnect() {
    logger.info('Disconnecting from TradingView...');
    this.isDisconnecting = true;

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