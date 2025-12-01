import axios from 'axios';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

class TradovateClient extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.accessToken = null;
    this.mdAccessToken = null;
    this.userId = null;
    this.accounts = [];
    this.tokenExpiry = null;
    this.isConnected = false;
    this.rateLimitTracker = new Map();
    this.maxRequestsPerSecond = 10;

    // WebSocket properties
    this.ws = null;
    this.wsConnected = false;
    this.wsReconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.heartbeatInterval = null;

    // Order enrichment cache to avoid repeated API calls
    this.enrichmentCache = new Map(); // orderId -> enrichedOrderData
    this.contractCache = new Map();   // contractId -> contractDetails

    // Set base URLs
    this.baseUrl = config.useDemo ? config.demoUrl : config.liveUrl;
    this.wssUrl = config.useDemo ? config.wssDemoUrl : config.wssLiveUrl;
  }

  async connect() {
    try {
      this.logger.info(`Connecting to Tradovate ${this.config.useDemo ? 'DEMO' : 'LIVE'} API...`);

      // Use the same format as the working slingshot backend
      const authData = {
        name: this.config.username,
        password: process.env.TRADOVATE_PASSWORD  // Use env directly to avoid masking issues
      };

      // Add WSL2-specific Slingshot credentials
      if (this.config.appId) authData.appId = this.config.appId;
      if (this.config.appVersion) authData.appVersion = this.config.appVersion;
      if (this.config.deviceId) authData.deviceId = this.config.deviceId;
      if (this.config.cid) authData.cid = this.config.cid;
      if (this.config.secret) authData.sec = this.config.secret; // Map 'secret' to 'sec' field

      // Debug the request
      this.logger.info(`Auth request URL: ${this.baseUrl}/auth/accesstokenrequest`);
      this.logger.info(`Auth request data: ${JSON.stringify({ ...authData, password: '***masked***' }, null, 2)}`);


      const response = await axios({
        method: 'POST',
        url: `${this.baseUrl}/auth/accesstokenrequest`,
        data: authData,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        validateStatus: function (status) {
          return status < 500; // Accept any status code less than 500
        }
      });


      // Check for error response first
      if (response.data.errorText) {
        throw new Error(`Authentication failed: ${response.data.errorText}`);
      }

      // Handle CAPTCHA challenge if present (copied from working backend)
      if (response.data['p-ticket']) {
        const ticket = response.data['p-ticket'];
        const waitTime = response.data['p-time'];

        this.logger.warn(`CAPTCHA challenge received. Waiting ${waitTime} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

        // Retry with ticket
        authData.p_ticket = ticket;
        const retryResponse = await axios({
          method: 'POST',
          url: `${this.baseUrl}/auth/accesstokenrequest`,
          data: authData,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          validateStatus: function (status) {
            return status < 500; // Accept any status code less than 500
          }
        });

        if (!retryResponse.data.accessToken) {
          throw new Error('CAPTCHA challenge failed - app registration required');
        }

        this.accessToken = retryResponse.data.accessToken;
        this.mdAccessToken = retryResponse.data.mdAccessToken;
        this.userId = retryResponse.data.userId;
        this.tokenExpiry = new Date(retryResponse.data.expirationTime);

        this.logger.info(`📋 Token expires at: ${this.tokenExpiry}`);
      } else if (response.data.accessToken) {
        this.accessToken = response.data.accessToken;
        this.mdAccessToken = response.data.mdAccessToken;
        this.userId = response.data.userId;
        this.tokenExpiry = new Date(response.data.expirationTime);

        this.logger.info(`📋 Token expires at: ${this.tokenExpiry}`);
      } else {
        throw new Error(response.data.errorText || 'Authentication failed');
      }

      this.logger.info(`Connected to Tradovate. User ID: ${this.userId}`);
      this.isConnected = true;

      // Load accounts
      await this.loadAccounts();

      // Set up token refresh
      this.setupTokenRefresh();

      // Initialize WebSocket connection
      await this.connectWebSocket();

      this.emit('connected', {
        userId: this.userId,
        accounts: this.accounts,
        environment: this.config.useDemo ? 'demo' : 'live'
      });

      return true;
    } catch (error) {

      // Handle HTTP error responses that might contain CAPTCHA challenges
      if (error.response && error.response.data) {
        this.logger.error(`HTTP Status: ${error.response.status}`);
        this.logger.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);

        // Check if this is actually a CAPTCHA challenge in the error response
        if (error.response.data['p-ticket']) {
          this.logger.info('CAPTCHA challenge detected in error response, handling...');
          const ticket = error.response.data['p-ticket'];
          const waitTime = error.response.data['p-time'];

          this.logger.warn(`CAPTCHA challenge received. Waiting ${waitTime} seconds...`);
          await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

          // Retry with ticket
          authData.p_ticket = ticket;
          try {
            const retryResponse = await axios.post(`${this.baseUrl}/auth/accesstokenrequest`, authData, {
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              }
            });

            if (retryResponse.data.accessToken) {
              this.accessToken = retryResponse.data.accessToken;
              this.mdAccessToken = retryResponse.data.mdAccessToken;
              this.userId = retryResponse.data.userId;
              this.tokenExpiry = new Date(retryResponse.data.expirationTime);

              this.logger.info(`📋 Token expires at: ${this.tokenExpiry}`);
              this.logger.info(`Connected to Tradovate. User ID: ${this.userId}`);
              this.isConnected = true;

              // Load accounts
              await this.loadAccounts();
              this.setupTokenRefresh();

              this.emit('connected', {
                userId: this.userId,
                accounts: this.accounts,
                environment: this.config.useDemo ? 'demo' : 'live'
              });

              return true;
            } else {
              throw new Error('CAPTCHA challenge failed - no access token received');
            }
          } catch (retryError) {
            this.logger.error('CAPTCHA retry failed:', retryError.message);
            throw new Error(`CAPTCHA retry failed: ${retryError.message}`);
          }
        } else {
          // Regular error response
          const errorText = error.response.data.errorText || error.message;
          throw new Error(`Authentication failed: ${errorText}`);
        }
      } else {
        this.logger.error(`Network error: ${error.message}`);
        this.logger.error(`Error code: ${error.code || 'Unknown'}`);
        throw new Error(`Network error: ${error.message}`);
      }
    }
  }

  async loadAccounts() {
    try {
      const response = await this.makeRequest('GET', '/account/list');
      this.accounts = response;
      this.logger.info(`Loaded ${this.accounts.length} accounts`);
      return this.accounts;
    } catch (error) {
      this.logger.error('Failed to load accounts:', error.message);
      throw error;
    }
  }

  async makeRequest(method, endpoint, data = null, retries = 3, pTicket = null) {
    // Rate limiting
    await this.enforceRateLimit();

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    try {
      const config = {
        method,
        url,
        headers
      };

      // Add p-ticket to request data if provided (for penalty retry)
      let requestData = data;
      if (pTicket) {
        requestData = { ...data, 'p-ticket': pTicket };
        this.logger.info(`Retrying with p-ticket after penalty wait`);
      }

      if (requestData) {
        config.data = requestData;
      }

      const response = await axios(config);

      // Check for p-ticket penalty in successful response
      if (response.data && response.data['p-ticket']) {
        const pTicketNew = response.data['p-ticket'];
        const pTime = response.data['p-time'];
        const pCaptcha = response.data['p-captcha'];

        if (pCaptcha) {
          // Severe penalty - need to wait 1 hour
          this.logger.error('⛔ Received p-captcha penalty. Manual intervention required. Please wait 1 hour.');
          throw new Error('Rate limit penalty with captcha. Please wait 1 hour before retrying.');
        }

        if (pTime && retries > 0) {
          this.logger.warn(`⏰ Received p-ticket penalty. Waiting ${pTime} seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, pTime * 1000));
          // Retry with the p-ticket included
          return this.makeRequest(method, endpoint, data, retries - 1, pTicketNew);
        }
      }

      return response.data;
    } catch (error) {
      if (error.response) {
        // Handle 401 - try to refresh token
        if (error.response.status === 401 && retries > 0) {
          this.logger.warn('Token expired, attempting refresh...');
          await this.refreshToken();
          return this.makeRequest(method, endpoint, data, retries - 1, pTicket);
        }

        // Handle rate limiting (429 response)
        if (error.response.status === 429) {
          // Check if response contains p-ticket data
          if (error.response.data && error.response.data['p-ticket']) {
            const pTicketNew = error.response.data['p-ticket'];
            const pTime = error.response.data['p-time'];
            const pCaptcha = error.response.data['p-captcha'];

            if (pCaptcha) {
              this.logger.error('⛔ Received p-captcha penalty (429). Manual intervention required. Please wait 1 hour.');
              throw new Error('Rate limit penalty with captcha. Please wait 1 hour before retrying.');
            }

            if (pTime && retries > 0) {
              this.logger.warn(`⏰ Received p-ticket penalty (429). Waiting ${pTime} seconds before retry...`);
              await new Promise(resolve => setTimeout(resolve, pTime * 1000));
              // Retry with the p-ticket included
              return this.makeRequest(method, endpoint, data, retries - 1, pTicketNew);
            }
          }

          // Fallback to retry-after header if no p-ticket
          const retryAfter = error.response.headers['retry-after'] || 60;
          this.logger.warn(`⏱️ Rate limited (429). Retrying after ${retryAfter} seconds`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return this.makeRequest(method, endpoint, data, retries - 1, pTicket);
        }

        throw new Error(`API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  async enforceRateLimit() {
    const now = Date.now();
    const windowStart = now - 1000; // 1 second window

    // Clean old entries
    for (const [timestamp] of this.rateLimitTracker) {
      if (timestamp < windowStart) {
        this.rateLimitTracker.delete(timestamp);
      }
    }

    // Check if we're at the limit
    if (this.rateLimitTracker.size >= this.maxRequestsPerSecond) {
      const oldestRequest = Math.min(...this.rateLimitTracker.keys());
      const waitTime = 1000 - (now - oldestRequest);
      if (waitTime > 0) {
        this.logger.debug(`Rate limit: waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    // Track this request
    this.rateLimitTracker.set(now, true);
  }

  async refreshToken() {
    try {
      const response = await axios.post(`${this.baseUrl}/auth/renewaccesstoken`, {}, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      this.accessToken = response.data.accessToken;
      this.mdAccessToken = response.data.mdAccessToken;
      this.tokenExpiry = new Date(response.data.expirationTime);

      this.logger.info('Token refreshed successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to refresh token:', error.message);
      // If refresh fails, try to reconnect
      return this.connect();
    }
  }

  setupTokenRefresh() {
    // Clear existing timer
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    // Refresh token 5 minutes before expiry
    const refreshTime = this.tokenExpiry.getTime() - Date.now() - (5 * 60 * 1000);

    if (refreshTime > 0) {
      this.tokenRefreshTimer = setTimeout(() => {
        this.refreshToken();
      }, refreshTime);
    }
  }

  // Order Management Methods
  async placeOrder(orderData) {
    try {
      this.logger.info('Placing order:', orderData);
      const response = await this.makeRequest('POST', '/order/placeorder', orderData);

      this.emit('orderPlaced', response);
      return response;
    } catch (error) {
      this.logger.error('Failed to place order:', error.message);
      this.emit('orderError', { error: error.message, orderData });
      throw error;
    }
  }

  // Place a bracket order (One-Sends-Other) with stop loss and take profit
  async placeBracketOrder(orderData) {
    try {
      this.logger.info(`Placing bracket order: ${orderData.action} ${orderData.orderQty} ${orderData.symbol}`);
      this.logger.info('Bracket order payload:', orderData);

      const response = await this.makeRequest('POST', '/order/placeOSO', orderData);

      this.logger.info('Tradovate OSO API response:', response);

      if (response && response.orderId) {
        this.logger.info(`✅ Bracket order placed successfully. Primary ID: ${response.orderId}`);

        // Log bracket order IDs if available
        if (response.bracket1OrderId) {
          this.logger.info(`📊 Stop loss order ID: ${response.bracket1OrderId}`);
        }
        if (response.bracket2OrderId) {
          this.logger.info(`📊 Take profit order ID: ${response.bracket2OrderId}`);
        }

        this.emit('bracketOrderPlaced', response);
        return response;
      } else {
        // Bracket order was not placed successfully
        const errorMsg = response?.errorText || 'Bracket order placement failed - no orderId returned';
        this.logger.error(`❌ Bracket order placement failed: ${errorMsg}`);
        this.logger.error(`❌ Full response:`, response);
        throw new Error(errorMsg);
      }

    } catch (error) {
      this.logger.error(`Failed to place bracket order: ${error.message}`);
      this.emit('orderError', { error: error.message, orderData });
      throw error;
    }
  }

  async cancelOrder(orderId) {
    try {
      const response = await this.makeRequest('POST', '/order/cancelorder', { orderId });
      this.emit('orderCancelled', response);
      return response;
    } catch (error) {
      this.logger.error(`Failed to cancel order ${orderId}:`, error.message);
      throw error;
    }
  }

  // Place a bracket order with trailing stop using orderStrategy endpoint
  async placeOrderStrategy(orderData) {
    try {
      this.logger.info(`Placing order strategy: ${orderData.action} ${orderData.orderQty} ${orderData.symbol}`);

      // Build the strategy parameters
      const strategyParams = {
        entryVersion: {
          symbol: orderData.symbol,
          orderQty: orderData.orderQty,
          orderType: orderData.orderType,
          timeInForce: "Day"
        },
        brackets: []
      };

      // Add limit price if this is a limit order
      if (orderData.orderType === 'Limit' && orderData.price) {
        strategyParams.entryVersion.price = orderData.price;
      }

      // Create bracket with stop loss, take profit, and autoTrail
      const bracket = {
        qty: orderData.orderQty
      };

      // Add stop loss and take profit as relative values
      if (orderData.bracket1 && orderData.bracket1.stopPrice) {
        // Calculate relative stop loss distance from entry
        // For Buy: negative value = stop below entry, positive = stop above
        // For Sell: positive value = stop above entry, negative = stop below
        const stopLossDistance = orderData.action === 'Buy'
          ? orderData.bracket1.stopPrice - orderData.price  // Buy: stop below entry (stop - entry = negative)
          : orderData.bracket1.stopPrice - orderData.price; // Sell: stop above entry (stop - entry = positive)
        bracket.stopLoss = stopLossDistance;  // Preserve the sign for Tradovate API

        // Add autoTrail if specified
        if (orderData.bracket1.autoTrail) {
          bracket.autoTrail = {
            stopLoss: orderData.bracket1.autoTrail.stopLoss,
            trigger: orderData.bracket1.autoTrail.trigger,
            freq: orderData.bracket1.autoTrail.freq
          };
        }
      }

      if (orderData.bracket2 && orderData.bracket2.price) {
        // Calculate relative profit target
        // For Tradovate API: positive value = profit in the direction of the trade
        const profitDistance = orderData.action === 'Buy'
          ? orderData.bracket2.price - orderData.price   // Buy: profit above entry (target - entry = positive)
          : orderData.bracket2.price - orderData.price;  // Sell: profit below entry (target - entry = negative)
        bracket.profitTarget = profitDistance; // Preserve sign: positive for buy, negative for sell
      }

      strategyParams.brackets.push(bracket);

      // Build the complete request
      const strategyRequest = {
        accountId: orderData.accountId,
        contractId: orderData.contractId,
        symbol: orderData.symbol,  // Add symbol at top level too
        orderStrategyTypeId: 2, // Bracket strategy
        action: orderData.action,
        params: JSON.stringify(strategyParams)
      };

      this.logger.info('Order strategy request:', JSON.stringify(strategyRequest, null, 2));

      const response = await this.makeRequest('POST', '/orderStrategy/startOrderStrategy', strategyRequest);

      this.logger.info('Tradovate orderStrategy API response:', response);

      // Check for success in multiple possible response structures
      const strategyId = response?.id || response?.orderStrategy?.id;
      const isActiveStrategy = response?.status === 'ActiveStrategy' || response?.orderStrategy?.status === 'ActiveStrategy';

      if (response && (strategyId || isActiveStrategy)) {
        this.logger.info(`✅ Order strategy placed successfully. Strategy ID: ${strategyId || 'N/A'}`);
        this.emit('orderStrategyPlaced', response);
        return response;
      } else {
        const errorMsg = response?.errorText || response?.error || 'Order strategy placement failed';
        this.logger.error(`❌ Order strategy placement failed: ${errorMsg}`);
        throw new Error(errorMsg);
      }

    } catch (error) {
      this.logger.error(`Failed to place order strategy: ${error.message}`);
      this.emit('orderError', { error: error.message, orderData });
      throw error;
    }
  }

  // Get OrderStrategy dependents (child orders)
  async getOrderStrategyDependents(strategyId) {
    try {
      this.logger.info(`🔍 Getting OrderStrategy dependents for strategy ${strategyId}`);
      // Try different endpoint variations to find the correct one
      let response;
      try {
        this.logger.info(`🔍 Trying /orderStrategyLink/deps?masterid=${strategyId}`);
        response = await this.makeRequest('GET', `/orderStrategyLink/deps?masterid=${strategyId}`);
      } catch (error1) {
        this.logger.warn(`⚠️ orderStrategyLink failed: ${error1.message}`);
        try {
          this.logger.info(`🔍 Trying /orderStrategy/deps?masterid=${strategyId}`);
          response = await this.makeRequest('GET', `/orderStrategy/deps?masterid=${strategyId}`);
        } catch (error2) {
          this.logger.warn(`⚠️ orderStrategy masterid failed: ${error2.message}`);
          try {
            this.logger.info(`🔍 Trying /orderStrategy/deps?id=${strategyId}`);
            response = await this.makeRequest('GET', `/orderStrategy/deps?id=${strategyId}`);
          } catch (error3) {
            this.logger.warn(`⚠️ orderStrategy id failed: ${error3.message}`);
            try {
              this.logger.info(`🔍 Trying /orderStrategy/${strategyId}/deps`);
              response = await this.makeRequest('GET', `/orderStrategy/${strategyId}/deps`);
            } catch (error4) {
              this.logger.error(`❌ All endpoint variations failed`);
              throw error1; // Throw the original error
            }
          }
        }
      }
      this.logger.info(`📋 OrderStrategy dependents response: ${JSON.stringify(response, null, 2)}`);
      return response;
    } catch (error) {
      this.logger.error(`Failed to get OrderStrategy dependents for ${strategyId}:`, error.message);
      this.logger.error(`Error details: ${JSON.stringify(error.response?.data || error.message, null, 2)}`);
      throw error;
    }
  }

  // Get OrderStrategy link dependents
  async getOrderStrategyLinkDependents(strategyId) {
    try {
      this.logger.info(`🔗 Getting OrderStrategy link dependents for strategy ${strategyId}`);
      const response = await this.makeRequest('GET', `/orderStrategyLink/deps?masterid=${strategyId}`);
      this.logger.info(`🔗 OrderStrategy link dependents response: ${JSON.stringify(response, null, 2)}`);
      return response;
    } catch (error) {
      this.logger.error(`Failed to get OrderStrategy link dependents for ${strategyId}:`, error.message);
      throw error;
    }
  }

  // Get OrderStrategy details
  async getOrderStrategyItem(strategyId) {
    try {
      this.logger.info(`📄 Getting OrderStrategy item details for strategy ${strategyId}`);
      const response = await this.makeRequest('GET', `/orderStrategy/item?id=${strategyId}`);
      this.logger.info(`📄 OrderStrategy item response: ${JSON.stringify(response, null, 2)}`);
      return response;
    } catch (error) {
      this.logger.error(`Failed to get OrderStrategy item for ${strategyId}:`, error.message);
      throw error;
    }
  }

  // Liquidate position - cancels all orders and closes position for a contract
  async liquidatePosition(accountId, contractId) {
    try {
      this.logger.info(`Liquidating position: accountId=${accountId}, contractId=${contractId}`);

      const response = await this.makeRequest('POST', '/order/liquidateposition', {
        accountId: accountId,
        contractId: contractId,
        admin: false  // Required field - false for regular user liquidation
      });

      this.logger.info('Position liquidated successfully:', response);
      this.emit('positionLiquidated', { accountId, contractId, response });
      return response;
    } catch (error) {
      this.logger.error(`Failed to liquidate position: ${error.message}`);
      this.emit('orderError', { error: error.message, accountId, contractId });
      throw error;
    }
  }

  async getOrders(accountId, enriched = true) {
    try {
      // Get basic order data
      const response = await this.makeRequest('GET', `/order/list?accountId=${accountId}`);
      const basicOrders = response || [];

      if (!enriched) {
        return basicOrders;
      }

      this.logger.info(`📋 Enriching ${basicOrders.length} orders for account ${accountId}...`);

      // Enrich each order with additional data
      const enrichedOrders = [];
      for (const order of basicOrders) {
        const enrichedOrder = await this.enrichOrder(order);
        enrichedOrders.push(enrichedOrder);
      }

      this.logger.info(`✨ Enrichment completed: ${enrichedOrders.length} orders`);
      return enrichedOrders;
    } catch (error) {
      this.logger.error('Failed to get orders:', error.message);
      throw error;
    }
  }

  // Enrich a single order with price and contract details
  async enrichOrder(order) {
    let enrichedOrder = { ...order };

    try {
      // Step 1: Get order version details (this has the real prices!)
      this.logger.info(`🔬 Getting order version details for order ${order.id}...`);

      const orderVersionResponse = await this.makeRequest('GET', `/orderVersion/deps?masterid=${order.id}`);
      const orderVersions = orderVersionResponse || [];

      if (orderVersions.length > 0) {
        // Usually there's only one version, but take the most recent
        const latestVersion = orderVersions[orderVersions.length - 1];

        // Extract price information from version (CRITICAL!)
        const versionPrice = latestVersion.price || latestVersion.limitPrice || latestVersion.stopPrice;

        enrichedOrder = {
          ...enrichedOrder,
          // Price information from order version
          limitPrice: versionPrice,
          price: versionPrice,
          // Order details
          orderType: latestVersion.orderType || order.orderType || 'Market',
          qty: latestVersion.orderQty || order.orderQty,
          orderQty: latestVersion.orderQty || order.orderQty,
          // Action
          action: order.action || latestVersion.action
        };

        this.logger.info(`🔬 Enriched order ${order.id}: Price=${versionPrice}, Type=${enrichedOrder.orderType}, Qty=${enrichedOrder.qty}`);
      }

      // Step 2: Get contract details if contractId is available
      if (order.contractId) {
        try {
          const contractDetails = await this.makeRequest('GET', `/contract/item?id=${order.contractId}`);

          if (contractDetails) {
            enrichedOrder.contractName = contractDetails.name;
            enrichedOrder.symbol = contractDetails.name; // Use contract name as symbol
            enrichedOrder.tickSize = contractDetails.tickSize;

            this.logger.info(`📋 Contract details for ${order.id}: ${contractDetails.name}`);
          }
        } catch (contractError) {
          this.logger.warn(`Failed to get contract details for order ${order.id}:`, contractError.message);
        }
      }

    } catch (error) {
      this.logger.warn(`Failed to enrich order ${order.id}:`, error.message);
    }

    return enrichedOrder;
  }

  // Position Management Methods
  async getPositions(accountId) {
    try {
      const response = await this.makeRequest('GET', `/position/list?accountId=${accountId}`);
      return response;
    } catch (error) {
      this.logger.error('Failed to get positions:', error.message);
      throw error;
    }
  }

  async closePosition(positionId) {
    try {
      const response = await this.makeRequest('POST', '/position/closeposition', { positionId });
      this.emit('positionClosed', response);
      return response;
    } catch (error) {
      this.logger.error(`Failed to close position ${positionId}:`, error.message);
      throw error;
    }
  }

  // Account Information Methods
  async getAccountBalances(accountId) {
    try {
      const response = await this.makeRequest('GET', `/account/item?id=${accountId}`);
      return response;
    } catch (error) {
      this.logger.error('Failed to get account balances:', error.message);
      throw error;
    }
  }

  async getCashBalances(accountId) {
    try {
      const response = await this.makeRequest('GET', `/cashBalance/getcashbalancesnapshot?accountId=${accountId}`);
      return response;
    } catch (error) {
      this.logger.error('Failed to get cash balances:', error.message);
      throw error;
    }
  }

  // Contract/Instrument Methods
  async findContract(symbol) {
    try {
      // Map generic symbols to specific contract months
      const mappedSymbol = this.mapToFullContractSymbol(symbol);
      this.logger.info(`Looking up contract: ${symbol} -> ${mappedSymbol}`);

      const response = await this.makeRequest('GET', `/contract/find?name=${mappedSymbol}`);
      return response;
    } catch (error) {
      this.logger.error(`Failed to find contract ${symbol}:`, error.message);
      throw error;
    }
  }

  // Map generic symbols like "MNQ" to full contract symbols like "MNQZ5"
  mapToFullContractSymbol(symbol) {
    const symbolMap = {
      // Micro E-mini NASDAQ-100
      'MNQ': 'MNQZ5',  // December 2025
      'MNQZ5': 'MNQZ5',

      // E-mini NASDAQ-100
      'NQ': 'NQZ5',    // December 2025
      'NQZ5': 'NQZ5',

      // Micro E-mini S&P 500
      'MES': 'MESZ5',  // December 2025
      'MESZ5': 'MESZ5',

      // E-mini S&P 500
      'ES': 'ESZ5',    // December 2025
      'ESZ5': 'ESZ5',

      // E-mini Russell 2000
      'RTY': 'RTYZ5',  // December 2025
      'RTYZ5': 'RTYZ5',

      // Micro E-mini Russell 2000
      'M2K': 'M2KZ5',  // December 2025
      'M2KZ5': 'M2KZ5'
    };

    return symbolMap[symbol.toUpperCase()] || symbol;
  }

  async getContract(contractId) {
    try {
      const response = await this.makeRequest('GET', `/contract/item?id=${contractId}`);
      return response;
    } catch (error) {
      this.logger.error(`Failed to get contract ${contractId}:`, error.message);
      throw error;
    }
  }

  async getContractDetails(contractId) {
    try {
      // Check cache first
      if (this.contractCache.has(contractId)) {
        this.logger.debug(`📦 Using cached contract details for ${contractId}`);
        return this.contractCache.get(contractId);
      }

      this.logger.info(`🔍 Fetching contract details for ${contractId}`);
      const response = await this.makeRequest('GET', `/contract/item?id=${contractId}`);

      // Cache the result
      if (response) {
        this.contractCache.set(contractId, response);
      }

      return response;
    } catch (error) {
      this.logger.error(`Failed to get contract details ${contractId}:`, error.message);
      throw error;
    }
  }

  // Order enrichment methods
  async enrichOrder(order) {
    try {
      // Check if we already have enriched data for this order
      if (this.enrichmentCache.has(order.id)) {
        this.logger.debug(`📦 Using cached enrichment for order ${order.id}`);
        const cached = this.enrichmentCache.get(order.id);
        // Merge any new status updates from WebSocket with cached enriched data
        return { ...cached, ...order };
      }

      this.logger.info(`Enriching order ${order.id} for symbol ${order.symbol || 'unknown'}`);

      let enrichedOrder = { ...order };

      // Step 1: Get order version details (has real prices!)
      try {
        const orderVersionResponse = await this.makeRequest('GET', `/orderVersion/deps?masterid=${order.id}`);

        if (orderVersionResponse && Array.isArray(orderVersionResponse) && orderVersionResponse.length > 0) {
          const orderVersion = orderVersionResponse[0];
          this.logger.info(`Order version data for ${order.id}:`, orderVersion);

          // Merge order version data which has the real prices
          enrichedOrder = {
            ...enrichedOrder,
            price: orderVersion.price || enrichedOrder.price,
            stopPrice: orderVersion.stopPrice || enrichedOrder.stopPrice,
            qty: orderVersion.qty || enrichedOrder.qty,
            filledQty: orderVersion.filledQty || enrichedOrder.filledQty,
            avgFillPrice: orderVersion.avgFillPrice || enrichedOrder.avgFillPrice
          };
        }
      } catch (versionError) {
        this.logger.warn(`Failed to get order version for ${order.id}:`, versionError.message);
      }

      // Step 2: Get contract details if we have a contractId
      if (order.contractId) {
        try {
          // Check contract cache first
          let contractDetails = this.contractCache.get(order.contractId);

          if (!contractDetails) {
            contractDetails = await this.makeRequest('GET', `/contract/item?id=${order.contractId}`);
            if (contractDetails) {
              // Cache the contract details
              this.contractCache.set(order.contractId, contractDetails);
            }
          } else {
            this.logger.debug(`📦 Using cached contract details for ${order.contractId}`);
          }

          if (contractDetails) {
            this.logger.info(`Contract details for ${order.contractId}:`, contractDetails);
            enrichedOrder.contractName = contractDetails.name;
            enrichedOrder.tickSize = contractDetails.tickSize;
            enrichedOrder.pointValue = contractDetails.pointValue;

            // If we don't have a symbol, use the contract name
            if (!enrichedOrder.symbol) {
              enrichedOrder.symbol = contractDetails.name;
            }
          }
        } catch (contractError) {
          this.logger.warn(`Failed to get contract details for ${order.contractId}:`, contractError.message);
        }
      }

      this.logger.info(`Order ${order.id} enriched successfully`);

      // Cache the enriched order to avoid future API calls
      this.enrichmentCache.set(order.id, enrichedOrder);

      return enrichedOrder;

    } catch (error) {
      this.logger.error(`Failed to enrich order ${order.id}:`, error.message);
      // Return original order if enrichment fails
      return order;
    }
  }

  // Handle WebSocket order updates efficiently
  async handleOrderUpdate(orderData, eventType) {
    if (eventType === 'Created') {
      // New order - needs enrichment
      this.logger.info(`🔔 New order ${orderData.id} created - enriching...`);
      return await this.enrichOrder(orderData);
    } else {
      // Order update - merge with cached data if available
      if (this.enrichmentCache.has(orderData.id)) {
        this.logger.debug(`📦 Updating cached order ${orderData.id}`);
        const cachedOrder = this.enrichmentCache.get(orderData.id);
        const updatedOrder = { ...cachedOrder, ...orderData };
        // Update cache with new data
        this.enrichmentCache.set(orderData.id, updatedOrder);
        return updatedOrder;
      } else {
        // Not cached yet - enrich if needed
        this.logger.info(`🔔 Order ${orderData.id} updated but not cached - enriching...`);
        return await this.enrichOrder(orderData);
      }
    }
  }

  // Enrich multiple orders
  async enrichOrders(orders) {
    if (!Array.isArray(orders)) {
      return orders;
    }

    const enrichedOrders = [];
    for (const order of orders) {
      try {
        const enriched = await this.enrichOrder(order);
        enrichedOrders.push(enriched);
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        this.logger.error(`Failed to enrich order ${order.id}:`, error.message);
        enrichedOrders.push(order); // Keep original if enrichment fails
      }
    }

    return enrichedOrders;
  }

  // WebSocket connection management
  async connectWebSocket() {
    if (this.ws && this.wsConnected) {
      this.logger.info('WebSocket already connected');
      return;
    }

    try {
      this.logger.info('Connecting to Tradovate WebSocket...');

      // Connect without headers - authenticate after connection
      this.ws = new WebSocket(this.wssUrl);

      // Set up event handlers
      this.ws.on('open', () => {
        this.logger.info('✅ WebSocket connected to Tradovate');
        this.wsConnected = true;
        this.wsReconnectAttempts = 0;

        // Don't send anything immediately - wait for open frame
        // Authorization and sync will be triggered by open frame

        // Set up heartbeat
        this.startHeartbeat();
      });

      this.ws.on('message', (data) => {
        try {
          const rawMessage = data.toString();
          this.logger.debug(`📥 Raw WebSocket message: "${rawMessage}"`);

          // Parse Tradovate frame format: frame type + payload
          const frameType = rawMessage.slice(0, 1);
          const payload = rawMessage.slice(1);

          this.logger.debug(`Frame type: "${frameType}", Payload: "${payload}"`);

          switch (frameType) {
            case 'o':
              this.logger.info('📡 WebSocket open frame received - connection established');
              // Send authorization after open frame
              this.authorizeConnection();
              break;

            case 'h':
              this.logger.debug('💓 Heartbeat frame received - sending response');
              // Respond to heartbeat with empty array
              this.ws.send('[]');
              break;

            case 'a':
              this.logger.info('📨 Array frame received');
              if (payload && payload !== '[]') {
                const messages = JSON.parse(payload);
                if (Array.isArray(messages)) {
                  messages.forEach(msg => this.handleWebSocketMessage(msg));
                }
              }
              break;

            case 'c':
              this.logger.warn(`🔚 Close frame received: ${payload}`);
              break;

            default:
              this.logger.debug(`Unknown frame type: "${frameType}"`);
          }

        } catch (error) {
          this.logger.error(`Failed to parse WebSocket message: "${data.toString()}"`, error.message);
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error('WebSocket error:', error);
        this.wsConnected = false;
      });

      this.ws.on('close', (code, reason) => {
        this.logger.warn(`WebSocket disconnected: ${code} - ${reason}`);
        this.wsConnected = false;

        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }

        // Attempt reconnection
        this.attemptWebSocketReconnection();
      });

    } catch (error) {
      this.logger.error('Failed to connect WebSocket:', error);
      this.wsConnected = false;
    }
  }

  // Add request ID counter
  wsRequestId = 1;

  authorizeConnection() {
    if (!this.ws || !this.wsConnected) {
      this.logger.warn('Cannot authorize - WebSocket not connected');
      return;
    }

    const requestId = this.wsRequestId++;

    // Tradovate WebSocket format: endpoint\nid\nquery\nbody
    const authMessage = `authorize\n${requestId}\n\n${this.accessToken}`;

    this.logger.info('🔐 Authorizing WebSocket connection...');
    this.ws.send(authMessage);
  }

  subscribeToUserSync() {
    if (!this.ws || !this.wsConnected) {
      this.logger.warn('Cannot subscribe to user sync - WebSocket not connected');
      return;
    }

    const requestId = this.wsRequestId++;

    // Try without any body first, based on WebSocket documentation format
    const syncMessage = `user/syncrequest\n${requestId}`;

    this.logger.info('📡 Sending user sync request...');
    this.logger.info('📨 Request message format:', JSON.stringify(syncMessage));
    this.ws.send(syncMessage);
  }

  handleWebSocketMessage(message) {
    // Handle different message types
    if (message.e === 'props') {
      this.logger.info(`🔄 WebSocket event: ${message.d.entityType} - ${message.d.eventType}`);
      this.handleUserPropertyUpdate(message.d);
    } else if (message.s && message.i) {
      // Response message (could be auth response or sync response)
      this.handleResponseMessage(message);
    } else {
      // Other message types
      this.logger.debug('Unhandled WebSocket message type:', message);
    }
  }

  handleResponseMessage(message) {
    const { s: status, i: requestId, d: data } = message;

    this.logger.info(`📨 Response ${requestId}: status ${status}`);

    if (status === 200) {
      // Check if this is an authorization response (requestId 1)
      if (requestId === 1) {
        this.logger.info('✅ WebSocket authorization successful');
        // Now request user sync
        this.subscribeToUserSync();
      } else {
        // Could be sync response or other successful response
        this.handleSuccessfulResponse(requestId, data);
      }
    } else {
      this.logger.error(`❌ WebSocket request ${requestId} failed with status ${status}: ${data}`);
    }
  }

  handleSuccessfulResponse(requestId, data) {
    this.logger.info(`✅ Request ${requestId} successful`);

    if (requestId === 2) {
      // This is likely the sync response
      this.handleInitialSyncResponse({ d: data, i: requestId });
    } else {
      this.logger.debug('Response data:', JSON.stringify(data, null, 2));
    }
  }

  handleUserPropertyUpdate(data) {
    const { entity, entityType, eventType } = data;

    // Special handling for Kalshi market data - infrastructure ready for future use
    if (entityType === 'kalshiMarket') {
      // TODO: Future Kalshi market analysis and correlation features
      // Silently process kalshiMarket events without any logging to avoid spam
      // Available data: entity.title, entity.status, entity.result, entity.openTime/closeTime, entity.rulesPrimary
    } else {
      // Log all other entity types (tradovate trading events)
      this.logger.info(`🔄 User property update: ${entityType} - ${eventType}`);
      // Entity data logged at debug level to avoid console spam
      this.logger.debug('Entity data:', JSON.stringify(entity, null, 2));
    }

    // Emit specific events for different entity types
    this.emit('userPropertyUpdate', {
      entityType,
      eventType,
      entity,
      timestamp: new Date().toISOString()
    });

    // Emit type-specific events
    switch (entityType) {
      case 'Order':
        // Handle order updates efficiently with caching
        this.handleOrderUpdate(entity, eventType).then(enrichedOrder => {
          this.emit('orderUpdate', { entity: enrichedOrder, eventType });
        }).catch(error => {
          this.logger.error(`Failed to handle order update for ${entity.id}:`, error.message);
          // Emit the original order if enrichment fails
          this.emit('orderUpdate', { entity, eventType });
        });
        break;
      case 'Position':
        this.emit('positionUpdate', { entity, eventType });
        break;
      case 'CashBalance':
        this.emit('balanceUpdate', { entity, eventType });
        break;
      case 'ExecutionReport':
      case 'executionReport':
        this.emit('executionUpdate', { entity, eventType });
        break;
      case 'orderStrategy':
        this.emit('orderStrategyUpdate', { entity, eventType });
        break;
      default:
        this.logger.debug(`Unhandled entity type: ${entityType}`);
    }
  }

  handleInitialSyncResponse(message) {
    this.logger.info('📊 Initial sync response received');

    if (message.d) {
      // Log summary of sync data without massive JSON dumps
      const summary = {};
      for (const [key, value] of Object.entries(message.d)) {
        if (Array.isArray(value)) {
          summary[key] = `${value.length} items`;
        } else {
          summary[key] = 'object';
        }
      }
      this.logger.info('📈 Sync data summary:', summary);
    }

    this.emit('initialSync', message.d);
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.wsConnected) {
        this.ws.ping();
      }
    }, 30000); // 30 second heartbeat
  }

  attemptWebSocketReconnection() {
    if (this.wsReconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max WebSocket reconnection attempts reached');
      return;
    }

    this.wsReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.wsReconnectAttempts), 30000);

    this.logger.info(`Attempting WebSocket reconnection ${this.wsReconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  disconnectWebSocket() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.wsConnected = false;
  }

  disconnect() {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    // Disconnect WebSocket
    this.disconnectWebSocket();

    this.isConnected = false;
    this.accessToken = null;
    this.mdAccessToken = null;

    this.emit('disconnected');
    this.logger.info('Disconnected from Tradovate');
  }
}

export default TradovateClient;