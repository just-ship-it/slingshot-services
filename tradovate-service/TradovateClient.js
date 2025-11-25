import axios from 'axios';
import { EventEmitter } from 'events';

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

  // Order enrichment methods
  async enrichOrder(order) {
    try {
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
          const contractDetails = await this.makeRequest('GET', `/contract/item?id=${order.contractId}`);

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
      return enrichedOrder;

    } catch (error) {
      this.logger.error(`Failed to enrich order ${order.id}:`, error.message);
      // Return original order if enrichment fails
      return order;
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

  disconnect() {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    this.isConnected = false;
    this.accessToken = null;
    this.mdAccessToken = null;

    this.emit('disconnected');
    this.logger.info('Disconnected from Tradovate');
  }
}

export default TradovateClient;