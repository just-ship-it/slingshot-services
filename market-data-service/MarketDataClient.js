import WebSocket from 'ws';
import axios from 'axios';

class MarketDataClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    this.baseUrl = config.useDemo ? config.demoUrl : config.liveUrl;
    this.wsUrl = config.useDemo ? config.wsDemoUrl : config.wsLiveUrl;

    this.accessToken = null;
    this.mdAccessToken = null;
    this.websocket = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.subscriptions = new Set();
    this.pendingSubscriptions = new Set();

    // Contract resolution cache
    this.contractCache = new Map();
    this.cacheTimestamp = null;
    this.cacheExpiryHours = 24;

    // Common futures symbols we'll support
    this.supportedSymbols = ['MNQ', 'NQ', 'MES', 'ES'];

    // Create axios instance
    this.api = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor to include auth token
    this.api.interceptors.request.use((config) => {
      if (this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`;
      }
      return config;
    });
  }

  /**
   * Authenticate with Tradovate API
   */
  async authenticate() {
    try {
      this.logger.info('🔐 Authenticating with Tradovate...');

      const authData = {
        name: this.config.username,
        password: this.config.password,
        appId: this.config.appId || 'SlinghotMarketData',
        appVersion: '1.0',
        cid: this.config.cid,
        sec: this.config.secret
      };

      if (this.config.deviceId) {
        authData.deviceId = this.config.deviceId;
      }

      const response = await axios.post(`${this.baseUrl}/auth/accesstokenrequest`, authData, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (response.data.errorText) {
        throw new Error(response.data.errorText);
      }

      this.accessToken = response.data.accessToken;
      this.mdAccessToken = response.data.mdAccessToken;

      this.logger.info('✅ Authentication successful');
      return true;
    } catch (error) {
      this.logger.error('❌ Authentication failed:', error.message);
      throw error;
    }
  }

  /**
   * Connect to market data WebSocket
   */
  async connectWebSocket() {
    if (!this.mdAccessToken) {
      throw new Error('Market data access token required');
    }

    return new Promise((resolve, reject) => {
      this.logger.info(`📡 Connecting to market data WebSocket: ${this.wsUrl}`);

      this.websocket = new WebSocket(this.wsUrl);

      this.websocket.on('open', () => {
        this.logger.info('✅ Market data WebSocket connected');
        this.isConnected = true;

        // Start heartbeat to keep connection alive
        this.startHeartbeat();

        // Wait for the 'o' (open) message from server before sending auth
        this.logger.info('⏳ Waiting for server open message before authentication...');
        resolve();
      });

      this.websocket.on('message', (data) => {
        try {
          const messageStr = data.toString();
          this.logger.debug('📨 Raw WebSocket message:', messageStr);

          if (!messageStr) {
            this.logger.debug('Received empty WebSocket message, ignoring');
            return;
          }

          // Handle Tradovate's newline-delimited protocol
          this.handleTradovateMessage(messageStr);
        } catch (error) {
          this.logger.error(`WebSocket message parse error: ${error.message}, Data:`, data.toString().substring(0, 100));
        }
      });

      this.websocket.on('close', (code, reason) => {
        this.logger.warn(`📡 Market data WebSocket disconnected - Code: ${code}, Reason: ${reason || 'No reason provided'}`);
        this.isAuthenticated = false;
        this.isConnected = false;
        this.stopHeartbeat();

        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
          if (!this.isConnected) {
            this.logger.info('🔄 Attempting WebSocket reconnection...');
            this.connectWebSocket().catch(err => {
              this.logger.error('Reconnection failed:', err.message);
            });
          }
        }, 5000);
      });

      this.websocket.on('error', (error) => {
        this.logger.error(`❌ WebSocket error: ${error.message}`);
        this.logger.error(`❌ Error details:`, error);
        reject(error);
      });
    });
  }

  /**
   * Handle incoming Tradovate WebSocket messages (newline-delimited format)
   */
  handleTradovateMessage(messageStr) {
    const type = messageStr.slice(0, 1); // First character indicates message type

    switch (type) {
      case 'o': // Open message - server ready, send authorization
        this.logger.info('📡 Server sent open message, sending authorization...');
        this.sendAuthentication();
        break;

      case 'h': // Heartbeat
        this.logger.debug('💓 Received server heartbeat');
        break;

      case 'a': // Array response data
        this.logger.info(`📋 Received array response, message length: ${messageStr.length}`);
        this.logger.info(`📋 Raw array message: ${messageStr.substring(0, 500)}...`); // Show first 500 chars
        try {
          const responseData = JSON.parse(messageStr.slice(1));
          this.handleArrayResponse(responseData);
        } catch (error) {
          this.logger.error(`Failed to parse array response: ${error.message}`);
          this.logger.error(`Raw message causing error: ${messageStr.substring(0, 200)}`);
        }
        break;

      case 'd': // Data message (might contain quotes)
        this.logger.info('📊 Received data message (type d):', messageStr);
        try {
          const data = JSON.parse(messageStr.slice(1));
          this.logger.info('📊 Parsed data message:', JSON.stringify(data, null, 2));
          if (data && typeof data === 'object') {
            this.handleQuoteUpdate(data);
          }
        } catch (error) {
          this.logger.error('Failed to parse data message:', error.message);
        }
        break;

      case 'e': // Event message (market data events according to docs)
        this.logger.info('📊 Received event message (type e):', messageStr);
        try {
          const eventData = JSON.parse(messageStr.slice(1));
          this.logger.info('📊 Parsed event data:', JSON.stringify(eventData, null, 2));
          this.handleMarketDataEvent(eventData);
        } catch (error) {
          this.logger.error('Failed to parse event message:', error.message);
        }
        break;

      case 'c': // Close message
        this.logger.warn('📡 Server sent close message');
        break;

      default:
        this.logger.info('🤔 UNHANDLED MESSAGE TYPE:', type);
        this.logger.info('🤔 Full message data:', messageStr);
    }
  }

  /**
   * Start heartbeat to keep WebSocket alive
   */
  startHeartbeat() {
    this.stopHeartbeat(); // Clear any existing heartbeat

    // Disable heartbeat for now - it's causing "Not found: h" errors
    // this.heartbeatInterval = setInterval(() => {
    //   if (this.websocket && this.isConnected) {
    //     const heartbeatMessage = 'h';
    //     this.logger.debug('💓 Sending heartbeat to server');
    //     try {
    //       this.websocket.send(heartbeatMessage);
    //     } catch (error) {
    //       this.logger.error('❌ Failed to send heartbeat:', error.message);
    //     }
    //   }
    // }, 20000);
  }

  /**
   * Stop heartbeat interval
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger.debug('💔 Heartbeat stopped');
    }
  }

  /**
   * Send authentication using correct newline-delimited format
   */
  sendAuthentication() {
    if (!this.mdAccessToken) {
      this.logger.error('❌ No mdAccessToken available for authentication');
      return;
    }

    // Tradovate format: operation\nrequestId\nquery\nbody
    const authMessage = `authorize\n1\n\n${this.mdAccessToken}`;

    this.logger.info('🔐 Preparing WebSocket authentication...');
    this.logger.info(`📋 Auth token length: ${this.mdAccessToken.length}`);
    this.logger.info('📤 Sending authorization message (newline-delimited format)');

    try {
      this.websocket.send(authMessage);
      this.logger.info('✅ Authorization message sent successfully');
    } catch (error) {
      this.logger.error('❌ Failed to send authorization message:', error.message);
    }
  }

  /**
   * Handle array response data (JSON format within 'a' messages)
   */
  handleArrayResponse(responseArray) {
    this.logger.info(`📥 Received array with ${responseArray.length} items`);

    for (const response of responseArray) {
      this.logger.info('📥 Processing response item:', JSON.stringify(response, null, 2));

      // Check for authentication response
      if (response.i === 1) { // Our auth request ID
        if (response.s === 200) {
          this.logger.info('✅ WebSocket authenticated successfully');
          this.isAuthenticated = true;

          // Process any pending subscriptions
          this.processPendingSubscriptions();

          // Trigger authenticated event
          this.emit('authenticated');
        } else {
          this.logger.error('❌ WebSocket authentication failed. Status:', response.s, 'Response:', response);
          this.isAuthenticated = false;
        }
      }

      // Check for subscription response
      else if (response.i && response.s) {
        if (response.s === 200) {
          // Check if there's an error in the data
          if (response.d && response.d.errorText) {
            this.logger.error(`❌ Subscription failed for request ID ${response.i}: ${response.d.errorText} (Code: ${response.d.errorCode || 'Unknown'})`);
          } else {
            this.logger.info(`✅ Subscription successful for request ID ${response.i}`);
          }
        } else {
          this.logger.error(`❌ Request failed for request ID ${response.i}. Status: ${response.s}. Full response:`, JSON.stringify(response, null, 2));
        }
      }

      // Handle quote data - check various possible formats
      else if (response.d) {
        this.logger.info('📊 Received potential quote data:', JSON.stringify(response.d, null, 2));
        if (response.d.symbol) {
          this.handleQuoteUpdate(response.d);
        }
      }

      // Handle direct quote format
      else if (response.symbol) {
        this.logger.info('📊 Received direct quote format:', JSON.stringify(response, null, 2));
        this.handleQuoteUpdate(response);
      }

      // Log unhandled responses
      else {
        this.logger.debug('🤔 Unhandled response format:', JSON.stringify(response, null, 2));
      }
    }
  }

  /**
   * Handle market data events (type 'e' messages)
   */
  handleMarketDataEvent(eventData) {
    if (eventData.e === 'md' && eventData.d && eventData.d.quotes) {
      this.logger.info(`📊 Processing ${eventData.d.quotes.length} market data quotes`);

      for (const quoteObject of eventData.d.quotes) {
        this.logger.info('📊 Processing quote object:', JSON.stringify(quoteObject, null, 2));

        if (quoteObject.entries) {
          const quote = {
            contractId: quoteObject.contractId,
            timestamp: quoteObject.timestamp,
            bid: quoteObject.entries.Bid?.price,
            ask: quoteObject.entries.Offer?.price,
            last: quoteObject.entries.Trade?.price,
            volume: quoteObject.entries.TotalTradeVolume?.size,
            bidSize: quoteObject.entries.Bid?.size,
            askSize: quoteObject.entries.Offer?.size,
            lastSize: quoteObject.entries.Trade?.size,
            high: quoteObject.entries.HighPrice?.price,
            low: quoteObject.entries.LowPrice?.price,
            open: quoteObject.entries.OpeningPrice?.price,
            settle: quoteObject.entries.SettlementPrice?.price,
            openInterest: quoteObject.entries.OpenInterest?.size
          };

          this.logger.info('📊 Formatted market data quote:', JSON.stringify(quote, null, 2));
          this.emit('quoteUpdate', quote);
        }
      }
    } else {
      this.logger.debug('🤔 Unhandled market data event:', JSON.stringify(eventData, null, 2));
    }
  }

  /**
   * Handle quote update messages
   */
  handleQuoteUpdate(quoteData) {
    if (!quoteData) {
      this.logger.debug('❌ Received null/undefined quote data');
      return;
    }

    this.logger.info('📊 Processing quote data:', JSON.stringify(quoteData, null, 2));

    const quote = {
      symbol: quoteData.symbol,
      bid: quoteData.bid,
      ask: quoteData.ask,
      last: quoteData.last || quoteData.trade || quoteData.lastPrice,
      volume: quoteData.volume || quoteData.totalVolume,
      timestamp: new Date().toISOString()
    };

    // Add base symbol for easier frontend handling
    const baseSymbol = this.getBaseSymbol(quote.symbol);
    if (baseSymbol) {
      quote.baseSymbol = baseSymbol;
    }

    this.logger.info(`📊 Formatted quote update: ${quote.symbol} - Last: ${quote.last}, Bid: ${quote.bid}, Ask: ${quote.ask}, Volume: ${quote.volume}`);

    // Emit quote update event (will be connected to Redis in next step)
    this.emit('quoteUpdate', quote);
    this.logger.info('✅ Quote update event emitted');
  }

  /**
   * Subscribe to quote for a symbol
   */
  subscribeToQuote(symbol, contractId = null) {
    if (!this.websocket || !this.isConnected) {
      this.logger.warn(`❌ Cannot subscribe to ${symbol} - WebSocket not connected (isConnected: ${this.isConnected})`);
      return;
    }

    if (!this.isAuthenticated) {
      this.logger.info(`⏳ Queueing subscription for ${symbol} - waiting for authentication`);
      this.pendingSubscriptions.add(symbol);
      return;
    }

    // Try subscription with contract ID (as shown in docs) - FIXED: contractId as string
    if (contractId) {
      const requestId = Date.now();
      const idQuoteMessage = `md/subscribequote\n${requestId}\n\n{"symbol":"${contractId}"}`;
      this.logger.info(`📈 Trying quote subscription with contract ID: ${contractId}`);
      this.logger.info(`📤 Message: ${idQuoteMessage}`);
      this.websocket.send(idQuoteMessage);

      // Also try known working symbol formats as backup
      const requestId2 = Date.now() + 1;
      const knownSymbols = ['ESM5', 'NQM5', 'MNQM5', 'MESM5']; // Current month contracts
      const testSymbol = knownSymbols.find(s => symbol.startsWith(s.substring(0, 2)) || symbol.startsWith(s.substring(0, 3)));

      if (testSymbol) {
        const testMessage = `md/subscribequote\n${requestId2}\n\n{"symbol":"${testSymbol}"}`;
        this.logger.info(`📈 Also trying known working symbol format: ${testSymbol}`);
        this.websocket.send(testMessage);
      }
    } else {
      // Fallback to symbol name
      const requestId = Date.now();
      const quoteMessage = `md/subscribequote\n${requestId}\n\n{"symbol":"${symbol}"}`;
      this.logger.info(`📈 Trying quote subscription for symbol: ${symbol}`);
      this.logger.info(`📤 Message: ${quoteMessage}`);
      this.websocket.send(quoteMessage);
    }

    this.subscriptions.add(symbol);
    this.logger.info(`✅ Subscription request sent for ${symbol}`);

    // Wait for real-time updates instead of manual requests
    this.logger.info(`⏳ Waiting for real-time quote updates for ${symbol}...`);
  }

  /**
   * Request current quote for a symbol
   */
  requestCurrentQuote(symbol) {
    if (!this.websocket || !this.isConnected || !this.isAuthenticated) {
      this.logger.warn(`❌ Cannot request quote for ${symbol} - WebSocket not ready`);
      return;
    }

    // Request current quote using Tradovate format - try getquote instead of getcurrentquote
    const requestId = Date.now();
    const quoteRequest = `md/getquote\n${requestId}\n\n{"symbol":"${symbol}"}`;

    this.logger.info(`🔍 Requesting current quote for ${symbol} (request ID: ${requestId})`);
    this.logger.debug('📤 Quote request message:', quoteRequest);

    try {
      this.websocket.send(quoteRequest);
      this.logger.info(`✅ Quote request sent for ${symbol}`);
    } catch (error) {
      this.logger.error(`❌ Failed to send quote request for ${symbol}:`, error.message);
    }
  }

  /**
   * Process any pending subscriptions after authentication
   */
  processPendingSubscriptions() {
    if (this.pendingSubscriptions.size > 0) {
      this.logger.info(`🔄 Processing ${this.pendingSubscriptions.size} pending subscriptions...`);

      for (const symbol of this.pendingSubscriptions) {
        this.subscribeToQuote(symbol);
      }

      this.pendingSubscriptions.clear();
      this.logger.info('✅ All pending subscriptions processed');
    }
  }

  /**
   * Get current front-month contract for a base symbol
   */
  async getCurrentContract(baseSymbol) {
    // Check cache first
    const cached = this.contractCache.get(baseSymbol);
    if (cached && this.isCacheValid()) {
      this.logger.info(`💾 Using cached contract for ${baseSymbol}: ${cached.name}`);
      return cached;
    }

    try {
      this.logger.info(`🔍 Resolving current contract for ${baseSymbol}...`);

      // Try contract suggestion endpoint first
      this.logger.debug(`📡 Calling /contract/suggest?t=${baseSymbol}`);
      let response = await this.api.get(`/contract/suggest?t=${baseSymbol}`);
      let contracts = response.data;
      this.logger.debug(`📋 Contract suggestion response for ${baseSymbol}:`, JSON.stringify(contracts, null, 2));

      if (!contracts || contracts.length === 0) {
        // Fallback to find endpoint
        response = await this.api.get(`/contract/find?name=${baseSymbol}`);
        contracts = response.data;
      }

      if (!contracts || contracts.length === 0) {
        throw new Error(`No contracts found for ${baseSymbol}`);
      }

      // Find the front-month (nearest expiration) contract
      const currentContract = this.findFrontMonthContract(contracts, baseSymbol);

      if (currentContract) {
        this.contractCache.set(baseSymbol, currentContract);
        this.cacheTimestamp = Date.now();
        this.logger.info(`✅ Resolved ${baseSymbol} to ${currentContract.name}`);
        this.logger.info(`📋 Contract name: ${currentContract.name}`);
        this.logger.info(`📋 Contract ID: ${currentContract.id}`);
        this.logger.info(`📋 Contract fields available:`, Object.keys(currentContract));

        // Check for other potential symbol fields
        if (currentContract.masterName) {
          this.logger.info(`📋 Master name: ${currentContract.masterName}`);
        }
        if (currentContract.tickerSymbol) {
          this.logger.info(`📋 Ticker symbol: ${currentContract.tickerSymbol}`);
        }
        if (currentContract.symbol) {
          this.logger.info(`📋 Symbol field: ${currentContract.symbol}`);
        }
        return currentContract;
      }

      throw new Error(`Could not determine front-month contract for ${baseSymbol}`);
    } catch (error) {
      this.logger.error(`Failed to resolve contract for ${baseSymbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find front-month contract from list
   */
  findFrontMonthContract(contracts, baseSymbol) {
    // Filter active contracts
    const now = new Date();
    const activeContracts = contracts.filter(contract => {
      const expirationDate = contract.expirationDate ? new Date(contract.expirationDate) : null;
      return !expirationDate || expirationDate > now;
    });

    if (activeContracts.length === 0) {
      return contracts[0]; // Fallback to first contract
    }

    // Sort by expiration date (nearest first)
    activeContracts.sort((a, b) => {
      const dateA = a.expirationDate ? new Date(a.expirationDate) : new Date('2099-12-31');
      const dateB = b.expirationDate ? new Date(b.expirationDate) : new Date('2099-12-31');
      return dateA - dateB;
    });

    return activeContracts[0];
  }

  /**
   * Check if contract cache is valid
   */
  isCacheValid() {
    if (!this.cacheTimestamp) return false;
    const ageHours = (Date.now() - this.cacheTimestamp) / (1000 * 60 * 60);
    return ageHours < this.cacheExpiryHours;
  }

  /**
   * Extract base symbol from full contract name
   */
  getBaseSymbol(contractName) {
    for (const symbol of this.supportedSymbols) {
      if (contractName.startsWith(symbol)) {
        return symbol;
      }
    }
    return null;
  }

  /**
   * Subscribe to quotes for all supported symbols
   */
  async subscribeToAllSymbols() {
    this.logger.info('📈 Subscribing to quotes for all supported symbols...');

    for (const baseSymbol of this.supportedSymbols) {
      try {
        const contract = await this.getCurrentContract(baseSymbol);
        this.subscribeToQuote(contract.name);

        // Small delay between subscriptions
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        this.logger.error(`Failed to subscribe to ${baseSymbol}: ${error.message}`);
      }
    }
  }

  /**
   * Event emitter functionality
   */
  emit(event, data) {
    if (this.listeners && this.listeners[event]) {
      this.listeners[event].forEach(callback => callback(data));
    }
  }

  on(event, callback) {
    if (!this.listeners) {
      this.listeners = {};
    }
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Disconnect and cleanup
   */
  disconnect() {
    this.stopHeartbeat();
    if (this.websocket) {
      this.websocket.close();
    }
    this.isConnected = false;
    this.isAuthenticated = false;
    this.subscriptions.clear();
    this.pendingSubscriptions.clear();
    this.logger.info('📡 Market data client disconnected');
  }
}

export default MarketDataClient;