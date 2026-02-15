// Liquidity Trigger Monitor - Dedicated WebSocket for LT levels
import WebSocket from 'ws';
import EventEmitter from 'events';
import { createLogger } from '../../../shared/index.js';
import { getCachedToken, getTokenTTL } from '../utils/tradingview-auth.js';

const logger = createLogger('lt-monitor');

// TradingView WebSocket endpoint
const TV_WEBSOCKET_URL = 'wss://data.tradingview.com/socket.io/websocket?from=chart%2FVEPYsueI%2F&type=chart';
const TV_ORIGIN = 'https://www.tradingview.com';

// Liquidity Triggers indicator by DeepDiveStocks
const LIQUIDITY_TRIGGER_INDICATOR = 'PUB;7e87924bf26940f3b0e4e245ec9e30b2';
const LIQUIDITY_TRIGGER_VERSION = '1';

class LTMonitor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.symbol = options.symbol || 'CME_MINI:NQ1!';
    this.timeframe = options.timeframe || '15'; // 15-minute timeframe
    this.jwtToken = options.jwtToken;
    this.redisUrl = options.redisUrl || 'redis://localhost:6379';

    this.ws = null;
    this.connected = false;
    this.quoteSession = null;
    this.chartSession = null;

    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.reconnectAttempts = 0;

    this.currentLevels = null;
    this.lastTimestamp = null;
    this.lastHeartbeat = null;
  }

  generateSession(prefix = 'qs') {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    let randomString = '';
    for (let i = 0; i < 12; i++) {
      randomString += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${prefix}_${randomString}`;
  }

  createMessage(func, params) {
    const message = JSON.stringify({ m: func, p: params });
    return `~m~${message.length}~m~${message}`;
  }

  sendMessage(func, params) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = this.createMessage(func, params);
      this.ws.send(message);
      logger.debug(`📤 Sent: ${func}`);
    } else {
      logger.warn(`Cannot send ${func} - WebSocket not open`);
    }
  }

  async connect() {
    try {
      logger.info(`🔌 Connecting LT monitor to TradingView for ${this.symbol} on ${this.timeframe}m...`);

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

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => {
        logger.debug(`📨 LT monitor received WebSocket data (${data.toString().length} bytes)`);
        this.handleMessage(data);
      });
      this.ws.on('error', (error) => this.handleError(error));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason));

      // Wait for connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('LT monitor connection timeout'));
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
      logger.info('✅ LT monitor connected successfully');

    } catch (error) {
      logger.error('Failed to connect LT monitor:', error);
      throw error;
    }
  }

  handleOpen() {
    logger.info('LT monitor WebSocket opened');
    this.reconnectAttempts = 0;
    this.initializeSessions();
    this.emit('connected');
  }

  initializeSessions() {
    // Generate session IDs
    this.quoteSession = this.generateSession('qs');
    this.chartSession = this.generateSession('cs');

    // Send initialization sequence
    this.sendMessage('set_auth_token', [this.jwtToken || 'unauthorized_user_token']);
    this.sendMessage('set_locale', ['en', 'US']);

    // Create sessions
    this.sendMessage('chart_create_session', [this.chartSession, '']);
    this.sendMessage('quote_create_session', [this.quoteSession]);
    this.sendMessage('quote_set_fields', [
      this.quoteSession,
      'ch', 'chp', 'current_session', 'description', 'local_description',
      'language', 'exchange', 'fractional', 'is_tradable', 'lp', 'lp_time',
      'minmov', 'minmove2', 'original_name', 'pricescale', 'pro_name',
      'short_name', 'type', 'update_mode', 'volume', 'currency_code',
      'rchp', 'rtc'
    ]);

    logger.info('LT monitor sessions initialized');
  }

  async startMonitoring() {
    logger.info(`📊 Starting LT monitoring for ${this.symbol} on ${this.timeframe}m timeframe`);

    const resolveSymbol = JSON.stringify({
      "adjustment": "splits",
      "symbol": this.symbol
    });

    // Add symbol to quote session
    this.sendMessage('quote_add_symbols', [this.quoteSession, `=${resolveSymbol}`]);

    // Resolve symbol for chart
    this.sendMessage('resolve_symbol', [this.chartSession, 'sds_sym_1', `=${resolveSymbol}`]);

    // Create 15-minute series with more historical data
    this.sendMessage('create_series', [
      this.chartSession,
      'sds_1',
      's1',
      'sds_sym_1',
      this.timeframe,  // 15-minute timeframe
      300,             // Request 300 bars for LT calculation
      ''
    ]);

    // Study will be added after receiving timescale_update message
    // This ensures the series is fully loaded before adding the indicator

    // Add fast symbols for real-time updates
    this.sendMessage('quote_fast_symbols', [this.quoteSession, this.symbol]);

    // Hibernate quote session after setup
    this.sendMessage('quote_hibernate_all', [this.quoteSession]);

    logger.info(`✅ LT indicator added for ${this.symbol}`);
  }

  handleMessage(data) {
    const message = data.toString();

    // Handle heartbeat
    if (message.match(/^~m~\d+~m~~h~\d+$/)) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(message);
        this.lastHeartbeat = new Date();
      }
      return;
    }

    // Log non-heartbeat messages for debugging
    if (!message.startsWith('~h~')) {
      logger.debug(`🔍 LT monitor raw message: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`);
    }

    // Split messages
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

      // Log all message types for debugging
      if (data.m) {
        logger.debug(`LT monitor received message type: ${data.m}`);
      }

      // Handle data updates
      if (data.m === 'du') {
        logger.debug('📊 LT monitor received data update');
        this.handleDataUpdate(data);
      } else if (data.m === 'study_error') {
        logger.error('LT study error:', data);
      } else if (data.m === 'symbol_resolved') {
        logger.debug('LT symbol resolved');
      } else if (data.m === 'timescale_update') {
        logger.debug('LT timescale update received');
        // Try adding study after receiving timescale update
        if (!this.studyAdded) {
          this.studyAdded = true;
          // Wait longer to ensure series is fully loaded, then fetch metadata and create study
          setTimeout(async () => {
            try {
              // Fetch metadata first, like Python does
              const metainfo = await this.fetchIndicatorMetadata(LIQUIDITY_TRIGGER_INDICATOR, LIQUIDITY_TRIGGER_VERSION);

              if (metainfo) {
                // Prepare study payload using fetched metadata
                const studyPayload = this.prepareIndicatorMetadata(LIQUIDITY_TRIGGER_INDICATOR, metainfo);

                // Create study parameters matching Python's format exactly
                const studyParams = [
                  this.chartSession,
                  'st9',  // Study ID (matching Python)
                  'st1',  // Output ID
                  'sds_1',  // Data source
                  'Script@tv-scripting-101!',
                  studyPayload
                ];

                this.sendMessage('create_study', studyParams);
                logger.info('📐 LT study creation sent using fetched metadata');
              } else {
                logger.error('❌ Failed to fetch LT indicator metadata, cannot create study');
              }
            } catch (error) {
              logger.error('❌ Error creating LT study with metadata:', error);
            }
          }, 3000);  // Wait 3 seconds
        }
      } else if (data.m === 'study_loading') {
        logger.info('📚 LT study loading...');
      } else if (data.m === 'study_completed') {
        logger.info('✅ LT study completed loading');
      } else if (data.m === 'series_completed') {
        logger.info('✅ Series completed loading');
      }

    } catch (error) {
      // Not JSON, ignore
    }
  }

  handleDataUpdate(data) {
    const payload = data.p;
    if (!payload || payload.length < 2) return;

    const update = payload[1];

    // Look for LT indicator data in st9
    if (update.st9 && update.st9.st) {
      const studyData = update.st9.st;

      if (studyData.length > 0) {
        // Get the most recent data point
        const latest = studyData[studyData.length - 1];
        const values = latest.v;

        if (values && values.length >= 18) {
          const timestamp = values[0];

          // Skip if same timestamp as last update
          if (timestamp === this.lastTimestamp) {
            return;
          }

          // Parse LT levels (positions 5, 7, 9, 11, 13, 15, 17)
          const levels = {
            timestamp: timestamp,
            candleTime: new Date(timestamp * 1000).toISOString(),
            L0: values[5] !== 1e+100 ? values[5] : null,
            L1: values[7] !== 1e+100 ? values[7] : null,
            L2: values[9] !== 1e+100 ? values[9] : null,
            L3: values[11] !== 1e+100 ? values[11] : null,
            L4: values[13] !== 1e+100 ? values[13] : null,
            L5: values[15] !== 1e+100 ? values[15] : null,
            L6: values[17] !== 1e+100 ? values[17] : null
          };

          this.currentLevels = levels;
          this.lastTimestamp = timestamp;

          // Emit the levels
          this.emit('lt_levels', levels);

          logger.info('📍 LT levels updated:', Object.entries(levels)
            .filter(([k, v]) => k.startsWith('L') && v !== null)
            .map(([k, v]) => `${k}:${v.toFixed(2)}`)
            .join(', '));
        }
      }
    }
  }

  handleError(error) {
    logger.error('LT monitor WebSocket error:', error.message);
    this.emit('error', error);
  }

  handleClose(code, reason) {
    logger.warn(`LT monitor disconnected - Code: ${code}, Reason: ${reason || 'No reason'}`);
    this.connected = false;

    if (!this.isDisconnecting) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    logger.info(`LT monitor reconnecting in ${delay/1000} seconds...`);

    setTimeout(async () => {
      try {
        // Check Redis for a fresher token before reconnecting
        const cachedToken = await getCachedToken(this.redisUrl);
        if (cachedToken) {
          const cachedTTL = getTokenTTL(cachedToken) || 0;
          const currentTTL = getTokenTTL(this.jwtToken) || 0;
          if (cachedTTL > currentTTL) {
            logger.info(`LT monitor using fresher token from Redis (TTL: ${Math.floor(cachedTTL / 60)}min)`);
            this.jwtToken = cachedToken;
          }
        }

        await this.connect();
        await this.startMonitoring();
        logger.info('LT monitor reconnected successfully');
      } catch (error) {
        logger.error('LT monitor reconnection failed:', error.message);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Update JWT token and reconnect. Called when the main TradingView client
   * refreshes its token.
   */
  async updateToken(newToken) {
    logger.info('LT monitor received new JWT token - reconnecting...');
    this.jwtToken = newToken;

    // Reconnect with new token
    const wasDisconnecting = this.isDisconnecting;
    this.isDisconnecting = true;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.studyAdded = false;

    this.isDisconnecting = wasDisconnecting;
    this.reconnectAttempts = 0;

    try {
      await this.connect();
      await this.startMonitoring();
      logger.info('LT monitor reconnected with new token');
    } catch (error) {
      logger.error('LT monitor reconnection with new token failed:', error.message);
      this.scheduleReconnect();
    }
  }

  async disconnect() {
    logger.info('Disconnecting LT monitor...');
    this.isDisconnecting = true;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    logger.info('LT monitor disconnected');
  }

  getCurrentLevels() {
    return this.currentLevels;
  }

  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async fetchIndicatorMetadata(scriptId, scriptVersion) {
    /**
     * Fetch metadata for a TradingView indicator (like Python's fetch_indicator_metadata)
     */
    const url = `https://pine-facade.tradingview.com/pine-facade/translate/${scriptId}/${scriptVersion}`;

    try {
      logger.info(`📥 Fetching indicator metadata for ${scriptId} v${scriptVersion}`);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const metainfo = data.result?.metaInfo;

      if (metainfo) {
        logger.info('📋 Successfully fetched indicator metadata');
        return metainfo;
      }

      logger.error('No metainfo found in indicator metadata');
      return null;

    } catch (error) {
      logger.error(`Failed to fetch indicator metadata: ${error.message}`);
      return null;
    }
  }

  prepareIndicatorMetadata(scriptId, metainfo) {
    /**
     * Prepare indicator metadata into the required payload structure
     * (exactly like Python's prepare_indicator_metadata)
     */
    const studyPayload = {
      text: metainfo.inputs?.[0]?.defval || '',
      pineId: scriptId,
      pineVersion: metainfo.pine?.version || '1.0',
      pineFeatures: {
        v: '{"indicator":1,"plot":1,"ta":1}',
        f: true,
        t: 'text'
      },
      __profile: {
        v: false,
        f: true,
        t: 'bool'
      }
    };

    // Add additional inputs that start with 'in_'
    const inputs = metainfo.inputs || [];
    inputs.forEach((input) => {
      if (input.id && input.id.startsWith('in_')) {
        studyPayload[input.id] = {
          v: input.defval,
          f: true,
          t: input.type
        };
      }
    });

    logger.info('📋 Prepared indicator metadata successfully');
    logger.debug('Prepared payload:', JSON.stringify(studyPayload, null, 2));
    return studyPayload;
  }
}

export default LTMonitor;