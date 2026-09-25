import axios from 'axios';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { Resend } from 'resend';
import { resolveHosts } from '../shared/connectors/tradovate-hosts.js';

// WS liveness watchdog. Tradovate pushes an 'h' heartbeat frame ~every 2.5s, so
// a healthy user-data socket has continuous inbound traffic. A "zombie" socket
// (half-open: still reports connected but delivers nothing) drops every
// executionReport silently until the OS finally emits a 1006 — observed dropping
// ~20min of fills/closes in prod. We watch the time since the LAST inbound frame
// and force-reconnect once it exceeds the stale threshold (~5 missed heartbeats).
const WS_STALE_TIMEOUT_MS = 12_000;     // declare zombie after 12s of silence
const WS_WATCHDOG_INTERVAL_MS = 4_000;  // check cadence

class TradovateClient extends EventEmitter {
  constructor(config, logger, messageBus, channels) {
    super();
    this.config = config;
    this.logger = logger;
    this.messageBus = messageBus;
    this.channels = channels;
    this.accessToken = null;
    this.mdAccessToken = null;
    this.userId = null;
    this.accounts = [];
    this.tokenExpiry = null;
    this.isConnected = false;
    this.rateLimitTracker = new Map();
    this.maxRequestsPerSecond = 10;

    // Define active order statuses that need to be cancelled during liquidation
    // These are orders that are still "alive" and could prevent position closure
    this.ACTIVE_ORDER_STATUSES = [
      'Working',      // Order is active at the exchange
      'Pending',      // Order pending exchange confirmation
      'PendingNew',   // New order pending submission
      'Suspended',    // Order suspended but can become active (e.g., OSO/OCO legs)
      'PendingReplace', // Order modification pending
      'PendingCancel'   // Cancellation pending (might still fill)
    ];

    // WebSocket properties
    this.ws = null;
    this.wsConnected = false;
    this.wsReconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.heartbeatInterval = null;

    // Order enrichment cache to avoid repeated API calls
    this.enrichmentCache = new Map(); // orderId -> enrichedOrderData
    this.contractCache = new Map();   // contractId -> contractDetails

    // HOSTS ARE NOT CONFIGURATION (NinjaTrader Dynamic API Hosts, mandatory 2026-10-03). The configured URLs are
    // the BOOTSTRAP pair: where the first accesstokenrequest goes, and the one-shot fallback if the resolved host
    // becomes unreachable. Every auth and every renewal re-resolves baseUrl/wssUrl from the response's apiHosts,
    // because an organisation can be moved to different hosts between sessions.
    this.purpose = config.useDemo ? 'demo' : 'live';
    this.bootstrap = {
      restUrl: config.useDemo ? config.demoUrl : config.liveUrl,
      wssUrl: config.useDemo ? config.wssDemoUrl : config.wssLiveUrl
    };
    this.baseUrl = this.bootstrap.restUrl;
    this.wssUrl = this.bootstrap.wssUrl;
    this.apiHosts = null;
    this.hostSource = 'bootstrap';   // 'bootstrap' until the first auth, then 'apiHosts' | 'fallback'
    this._warnedNoHosts = false;
    this._wrongHostRedialed = false;
    this._connecting = false;
  }

  /** What the client is actually talking to, for /health and audits. */
  get hostInfo() {
    return { purpose: this.purpose, restUrl: this.baseUrl, wssUrl: this.wssUrl, hostSource: this.hostSource };
  }

  /**
   * Book the token AND re-resolve the hosts from one auth/renew response. The fallback is the CURRENTLY resolved
   * pair rather than config, so a response that omits apiHosts (errors, CAPTCHA and MFA do) leaves us on the host
   * we were already talking to instead of snapping back to a bootstrap address the org may have moved off.
   */
  _applyAuthResponse(data) {
    this.accessToken = data.accessToken;
    if (data.mdAccessToken) this.mdAccessToken = data.mdAccessToken;
    if (data.userId != null) this.userId = data.userId;
    if (data.expirationTime) this.tokenExpiry = new Date(data.expirationTime);

    const fromRest = this.baseUrl, fromWs = this.wssUrl;
    const r = resolveHosts(data.apiHosts, this.purpose, { restUrl: this.baseUrl, wssUrl: this.wssUrl });
    this.apiHosts = data.apiHosts ?? this.apiHosts;
    this.hostSource = r.source;
    this.baseUrl = r.restUrl;
    this.wssUrl = r.wssUrl;

    if (r.source === 'fallback' && !this._warnedNoHosts) {
      this._warnedNoHosts = true;
      this.logger.warn(`⚠️ Auth response carried no apiHosts.${this.purpose} — staying on ${this.baseUrl} (fallback)`);
    }
    if (r.source === 'apiHosts') this._warnedNoHosts = false;

    if (fromRest !== this.baseUrl || fromWs !== this.wssUrl) {
      this.logger.info(`🌐 Tradovate API host → ${r.host ?? this.baseUrl} (${r.source})`);
      // Only an existing socket needs redialling: it is now pointed at the wrong host. On the first auth there is
      // no socket yet (connectWebSocket reads this.wssUrl), so announcing a redial there would be a scary log
      // line for an ordinary startup.
      if (fromWs !== this.wssUrl && this.ws) this._redialOnNewHost(fromWs, this.wssUrl);
    }
    return data;
  }

  /**
   * POST accesstokenrequest to one URL. Redirects are never followed automatically, and a reply that is not a
   * JSON object (a wrong host can answer a BODYLESS 404 instead of the documented 307) is reported with its
   * status and URL rather than surfacing as a vague "Authentication failed".
   */
  async _postToken(url, authData) {
    let res;
    try {
      res = await axios({
        method: 'POST',
        url,
        data: authData,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        maxRedirects: 0,
        validateStatus: () => true
      });
    } catch (error) {
      const e = new Error(`Network error: ${url}: ${error.message}`);
      e.code = error.code;
      throw e;
    }

    const location = res.status >= 300 && res.status < 400 ? res.headers?.location : null;
    if (location) {
      const e = new Error(`${url} -> ${res.status} -> ${location}`);
      e.status = res.status;
      e.location = location;
      throw e;
    }

    const data = res.data;
    if (data && typeof data === 'object') {
      // A 5xx is only an answer when it is a CAPTCHA/penalty ticket; anything else is a failed request.
      if (res.status >= 500 && !data['p-ticket']) {
        const e = new Error(`${url} -> ${res.status}: ${data.errorText || JSON.stringify(data).slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }
      return data;
    }
    const e = new Error(data === '' || data == null
      ? `${url} -> ${res.status} with an empty body`
      : `${url} -> ${res.status} non-JSON: ${String(data).slice(0, 120)}`);
    e.status = res.status;
    throw e;
  }

  /**
   * The first request has to go somewhere, so it goes to the current host (bootstrap on a cold start); apiHosts in
   * the reply decides everything after that.
   */
  async _requestToken(authData) {
    const post = (base) => this._postToken(`${base}/auth/accesstokenrequest`, authData);
    try {
      return await post(this.baseUrl);
    } catch (error) {
      if (error.location) {
        // No Authorization header on an auth request, so following ONE redirect is safe. A second redirect
        // throws out of _postToken; nothing here loops.
        this.logger.warn(`Auth redirected ${error.status} → ${error.location}`);
        return this._postToken(error.location, authData);
      }
      if (this.baseUrl !== this.bootstrap.restUrl) {
        // The last resolved host is unreachable (DNS, or it was retired between sessions). Hosts can only come FROM
        // an auth response, so without this the client is stranded. One retry on the bootstrap address, whose
        // reply then re-resolves everything.
        this.logger.warn(`⚠️ Auth to ${this.baseUrl} failed (${error.message}) — retrying once on bootstrap host ${this.bootstrap.restUrl}`);
        return post(this.bootstrap.restUrl);
      }
      throw error;
    }
  }

  /**
   * accesstokenrequest → token + hosts. No accounts, no socket: used by connect() and by the wrong-host
   * recovery paths (REST 3xx, WebSocket 421), which only need to re-read apiHosts.
   */
  authenticate() {
    // Single flight: concurrent wrong-host recoveries (several REST calls hitting the same 307) share ONE
    // accesstokenrequest instead of each firing their own.
    if (!this._authInFlight) {
      this._authInFlight = this._authenticate().finally(() => { this._authInFlight = null; });
    }
    return this._authInFlight;
  }

  async _authenticate() {
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

    this.logger.info(`Auth request URL: ${this.baseUrl}/auth/accesstokenrequest`);
    this.logger.info(`Auth request data: ${JSON.stringify({ ...authData, password: '***masked***' }, null, 2)}`);

    let data = await this._requestToken(authData);

    if (data.errorText) {
      throw new Error(`Authentication failed: ${data.errorText}`);
    }

    // Handle CAPTCHA challenge if present (copied from working backend)
    if (data['p-ticket']) {
      const waitTime = data['p-time'];
      this.logger.warn(`CAPTCHA challenge received. Waiting ${waitTime} seconds...`);
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

      // Retry with ticket — once
      authData.p_ticket = data['p-ticket'];
      data = await this._requestToken(authData);
      if (!data.accessToken) {
        throw new Error(`CAPTCHA challenge failed - ${data.errorText || 'app registration required'}`);
      }
    }

    if (!data.accessToken) {
      throw new Error('Authentication failed: no access token in response');
    }

    this._applyAuthResponse(data);
    this.logger.info(`📋 Token expires at: ${this.tokenExpiry}`);
    this.setupTokenRefresh();
    return data;
  }

  async connect() {
    this.logger.info(`Connecting to Tradovate ${this.config.useDemo ? 'DEMO' : 'LIVE'} API...`);
    this._connecting = true;
    try {
      await this.authenticate();

      this.logger.info(`Connected to Tradovate. User ID: ${this.userId}`);
      this.isConnected = true;

      // Load accounts
      await this.loadAccounts();

      // Initialize WebSocket connection
      await this.connectWebSocket();

      this.emit('connected', {
        userId: this.userId,
        accounts: this.accounts,
        environment: this.config.useDemo ? 'demo' : 'live'
      });

      return true;
    } catch (error) {
      this.logger.error(`Tradovate connect failed: ${error.message}`);
      throw error;
    } finally {
      this._connecting = false;
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

  /**
   * `redirected` marks the single retry after a wrong-host 3xx; it is carried through every other retry so the
   * re-auth happens at most once per call.
   */
  async makeRequest(method, endpoint, data = null, retries = 3, pTicket = null, redirected = false) {
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
        headers,
        // Never follow a redirect with a bearer token attached: axios strips Authorization on a cross-origin
        // redirect, so a wrong-host 307 would come back as a 401 and hide the real cause (routing).
        maxRedirects: 0
      };

      // Add p-ticket to request data if provided (for penalty retry)
      let requestData = data;
      if (pTicket) {
        requestData = { ...data, 'p-ticket': pTicket };
        this.logger.info(`Retrying with p-ticket after penalty wait`);
      }

      if (requestData) {
        config.data = requestData;
        // Debug: Log the exact JSON being sent
        this.logger.info(`🔍 Sending JSON to ${endpoint}:`);
        this.logger.info(`🔍 Request data:`, requestData);
        this.logger.info(`🔍 OrderId type: ${typeof requestData.orderId}, value: ${requestData.orderId}`);
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
          return this.makeRequest(method, endpoint, data, retries - 1, pTicketNew, redirected);
        }
      }

      return response.data;
    } catch (error) {
      if (error.response) {
        const status = error.response.status;

        // Handle 3xx - we are on the wrong host. Re-auth re-reads apiHosts, then exactly one retry.
        if (status >= 300 && status < 400) {
          const location = error.response.headers?.location;
          if (redirected) {
            throw new Error(`API Error: ${status} - ${url} still redirects (Location: ${location}) after re-reading apiHosts`);
          }
          this.logger.warn(`⚠️ ${method} ${url} -> ${status} (Location: ${location}) — wrong host; re-authenticating to re-read apiHosts`);
          await this.authenticate();
          return this.makeRequest(method, endpoint, data, retries, pTicket, true);
        }

        // Handle 401 - try to refresh token
        if (status === 401 && retries > 0) {
          this.logger.warn('Token expired, attempting refresh...');
          await this.refreshToken();
          return this.makeRequest(method, endpoint, data, retries - 1, pTicket, redirected);
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
              return this.makeRequest(method, endpoint, data, retries - 1, pTicketNew, redirected);
            }
          }

          // Fallback to retry-after header if no p-ticket
          const retryAfter = error.response.headers['retry-after'] || 60;
          this.logger.warn(`⏱️ Rate limited (429). Retrying after ${retryAfter} seconds`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return this.makeRequest(method, endpoint, data, retries - 1, pTicket, redirected);
        }

        // A wrong host can answer a BODYLESS 404 instead of a 307 — name the URL so the host is visible.
        const body = error.response.data;
        const detail = body === '' || body == null ? `${url} returned an empty body` : JSON.stringify(body);
        throw new Error(`API Error: ${status} - ${detail}`);
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

  /**
   * renewaccesstoken also carries apiHosts, and the org can move between renewals, so the reply goes through
   * _applyAuthResponse (which redials the socket if the trading host changed). `redirected` bounds the wrong-host
   * recovery to one re-auth + one retry.
   */
  async refreshToken(redirected = false) {
    let response;
    try {
      response = await axios.post(`${this.baseUrl}/auth/renewaccesstoken`, {}, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        maxRedirects: 0   // see makeRequest: a followed redirect drops the bearer token
      });
      if (!response.data?.accessToken) {
        throw new Error(`renew returned no token: ${JSON.stringify(response.data).slice(0, 200)}`);
      }
    } catch (error) {
      const status = error.response?.status;
      if (status >= 300 && status < 400 && !redirected) {
        // A redirect on a renewal means the org moved hosts. A full auth re-reads apiHosts, then one retry.
        this.logger.warn(`⚠️ Token renew redirected ${status} — re-authenticating to re-read apiHosts`);
        await this.authenticate();
        return this.refreshToken(true);
      }
      this.logger.error('Failed to refresh token:', error.message);
      // connect() can reach here itself (loadAccounts → 401 → refresh). Falling back to connect() again from
      // inside it would re-enter the same path — fail instead and let the outer connect() report it.
      if (this._connecting) throw error;
      // If refresh fails, try to reconnect
      return this.connect();
    }

    this._applyAuthResponse(response.data);
    this.logger.info('Token refreshed successfully');
    this.setupTokenRefresh();   // re-arm: every renewal is also a host re-read
    return true;
  }

  setupTokenRefresh() {
    // Clear existing timer
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    // Refresh token 5 minutes before expiry
    const refreshTime = this.tokenExpiry?.getTime() - Date.now() - (5 * 60 * 1000);

    if (refreshTime > 0) {
      this.tokenRefreshTimer = setTimeout(() => {
        this.refreshToken().catch(err => this.logger.error(`Scheduled token refresh failed: ${err.message}`));
      }, refreshTime);
      this.tokenRefreshTimer.unref?.();
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
      // Try sending as integer - Tradovate might expect number not string
      const orderIdInt = parseInt(orderId, 10);
      this.logger.info(`🔢 Converting orderId ${orderId} to integer: ${orderIdInt}, safe: ${Number.isSafeInteger(orderIdInt)}`);

      const response = await this.makeRequest('POST', '/order/cancelorder', {
        orderId: orderIdInt,
        isAutomated: true  // Match the isAutomated flag from order placement
      });
      this.emit('orderCancelled', response);
      return response;
    } catch (error) {
      this.logger.error(`Failed to cancel order ${orderId}:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        fullError: error
      });
      throw error;
    }
  }

  async modifyOrder(modifyData) {
    try {
      this.logger.info(`Modifying order ${modifyData.orderId}: ${modifyData.orderType} ${modifyData.orderQty} @ ${modifyData.price}`);

      // Build the modify request according to Tradovate API schema
      const modifyRequest = {
        orderId: modifyData.orderId,
        orderQty: modifyData.quantity || modifyData.orderQty,
        orderType: modifyData.orderType || 'Limit'
      };

      // Add price for limit orders
      if (modifyData.price !== undefined) {
        modifyRequest.price = modifyData.price;
      }

      // Add stop price if provided
      if (modifyData.stopPrice !== undefined) {
        modifyRequest.stopPrice = modifyData.stopPrice;
      }

      // Add client order ID if provided
      if (modifyData.clOrdId) {
        modifyRequest.clOrdId = modifyData.clOrdId;
      }

      const response = await this.makeRequest('POST', '/order/modifyorder', modifyRequest);

      // Update the cache with the new price instead of just invalidating
      if (this.enrichmentCache.has(modifyData.orderId)) {
        const cachedOrder = this.enrichmentCache.get(modifyData.orderId);
        const updatedOrder = {
          ...cachedOrder,
          price: modifyData.price,
          qty: modifyRequest.orderQty || cachedOrder.qty
        };
        this.enrichmentCache.set(modifyData.orderId, updatedOrder);
        this.logger.debug(`🔄 Updated cache for order ${modifyData.orderId}: price ${cachedOrder.price} → ${modifyData.price}`);
      }

      this.emit('orderModified', response);
      return response;
    } catch (error) {
      this.logger.error(`Failed to modify order ${modifyData.orderId}:`, error.message);
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
      if (orderData.bracket1 && (orderData.bracket1.stopPrice || orderData.stop_points)) {
        let stopLossDistance;
        if (orderData.price) {
          // Limit orders: compute relative distance from entry price
          stopLossDistance = orderData.action === 'Buy'
            ? orderData.bracket1.stopPrice - orderData.price  // Buy: stop below entry (negative)
            : orderData.bracket1.stopPrice - orderData.price; // Sell: stop above entry (positive)
        } else if (orderData.stop_points) {
          // Market orders: use point-based distance directly (no entry price available)
          stopLossDistance = orderData.action === 'Buy'
            ? -Math.abs(orderData.stop_points)   // Buy: stop below entry (negative)
            : Math.abs(orderData.stop_points);    // Sell: stop above entry (positive)
        }
        if (stopLossDistance != null) {
          bracket.stopLoss = stopLossDistance;  // Preserve the sign for Tradovate API
        }

        // Add autoTrail if specified
        if (orderData.bracket1.autoTrail) {
          bracket.autoTrail = {
            stopLoss: orderData.bracket1.autoTrail.stopLoss,
            trigger: orderData.bracket1.autoTrail.trigger,
            freq: orderData.bracket1.autoTrail.freq
          };
        }
      }

      if (orderData.bracket2 && (orderData.bracket2.price || orderData.target_points)) {
        let profitDistance;
        if (orderData.price) {
          // Limit orders: compute relative distance from entry price
          profitDistance = orderData.action === 'Buy'
            ? orderData.bracket2.price - orderData.price   // Buy: profit above entry (positive)
            : orderData.bracket2.price - orderData.price;  // Sell: profit below entry (negative)
        } else if (orderData.target_points) {
          // Market orders: use point-based distance directly (no entry price available)
          profitDistance = orderData.action === 'Buy'
            ? Math.abs(orderData.target_points)    // Buy: profit above entry (positive)
            : -Math.abs(orderData.target_points);  // Sell: profit below entry (negative)
        }
        if (profitDistance != null) {
          bracket.profitTarget = profitDistance; // Preserve sign: positive for buy, negative for sell
        }
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

  /**
   * Fetch all OrderVersion rows for a given orderId. The `text` field on
   * OrderVersion is where the slingshot signalId/strategy tag round-trips
   * after a placeOrder/placeOSO POST. Used for lazy attribution recovery in
   * the connector when the in-memory orderStrategyMap misses.
   */
  async getOrderVersions(orderId) {
    try {
      const response = await this.makeRequest('GET', `/orderVersion/deps?masterid=${Number(orderId)}`);
      return Array.isArray(response) ? response : [];
    } catch (err) {
      this.logger.warn(`getOrderVersions(${orderId}) failed: ${err.message}`);
      return [];
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

  /**
   * Modify an existing order strategy (e.g., to adjust stop loss for breakeven)
   * Uses the interruptOrderStrategy endpoint to change bracket parameters
   *
   * @param {number} orderStrategyId - The ID of the order strategy to modify
   * @param {Object} modifications - Object containing modifications to apply
   * @param {number} [modifications.stopPrice] - New stop loss price
   * @returns {Promise<Object>} Response from Tradovate
   */
  async modifyOrderStrategy(orderStrategyId, modifications) {
    try {
      this.logger.info(`🔧 Modifying OrderStrategy ${orderStrategyId}: ${JSON.stringify(modifications)}`);

      // Build the interrupt command
      // The command format depends on what we're modifying
      // For modifying stop loss, we use the "ModifyStop" action
      const interruptRequest = {
        orderStrategyId: parseInt(orderStrategyId, 10)
      };

      // If we're modifying the stop price, build the appropriate command
      if (modifications.stopPrice !== undefined) {
        // Format: JSON command to modify the bracket stop
        interruptRequest.command = JSON.stringify({
          action: 'modifyStop',
          stopPrice: modifications.stopPrice
        });
      }

      this.logger.info(`📤 InterruptOrderStrategy request: ${JSON.stringify(interruptRequest)}`);

      const response = await this.makeRequest('POST', '/orderStrategy/interruptorderstrategy', interruptRequest);

      this.logger.info(`✅ OrderStrategy modification response: ${JSON.stringify(response)}`);

      this.emit('orderStrategyModified', {
        orderStrategyId,
        modifications,
        response
      });

      return response;
    } catch (error) {
      this.logger.error(`❌ Failed to modify OrderStrategy ${orderStrategyId}:`, error.message);
      this.logger.error(`Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }

  /**
   * Alternative method to modify stop using direct order modification
   * Some Tradovate setups require modifying the child order directly
   *
   * @param {number} orderStrategyId - The ID of the order strategy
   * @param {number} newStopPrice - New stop loss price
   * @returns {Promise<Object>} Response from modification
   */
  async modifyBracketStop(orderStrategyId, newStopPrice) {
    try {
      this.logger.info(`🎯 Modifying bracket stop for strategy ${orderStrategyId} to ${newStopPrice}`);

      // First, get the strategy details to find the stop order
      const strategyDetails = await this.getOrderStrategyItem(orderStrategyId);

      if (!strategyDetails) {
        throw new Error(`OrderStrategy ${orderStrategyId} not found`);
      }

      // Get dependent orders (the bracket legs)
      const dependents = await this.getOrderStrategyDependents(orderStrategyId);

      // Find the stop order (ordType === 'Stop' or 'StopLimit')
      let stopOrderId = null;
      if (dependents && Array.isArray(dependents)) {
        for (const dep of dependents) {
          if (dep.ordType === 'Stop' || dep.ordType === 'StopLimit' || dep.ordType === 'StopMarket') {
            stopOrderId = dep.id;
            this.logger.info(`Found stop order: ${stopOrderId} (type: ${dep.ordType})`);
            break;
          }
        }
      }

      if (!stopOrderId) {
        this.logger.warn(`No stop order found in strategy ${orderStrategyId}, trying interruptOrderStrategy`);
        return await this.modifyOrderStrategy(orderStrategyId, { stopPrice: newStopPrice });
      }

      // Modify the stop order directly
      const modifyResult = await this.modifyOrder({
        orderId: stopOrderId,
        stopPrice: newStopPrice
      });

      this.logger.info(`✅ Stop order ${stopOrderId} modified to ${newStopPrice}`);

      return modifyResult;
    } catch (error) {
      this.logger.error(`❌ Failed to modify bracket stop for strategy ${orderStrategyId}:`, error.message);
      throw error;
    }
  }

  // Helper method to explicitly cancel all orders for a contract
  async cancelAllOrdersForContract(accountId, contractId) {
    try {
      this.logger.info(`🎯 Explicitly cancelling all orders for contract ${contractId}`);

      // Get all orders for this account
      const orders = await this.makeRequest('GET', `/order/list?accountId=${accountId}`);
      const activeOrdersForContract = (orders || []).filter(order =>
        order.contractId === contractId &&
        this.ACTIVE_ORDER_STATUSES.includes(order.ordStatus)
      );

      if (activeOrdersForContract.length === 0) {
        this.logger.info(`✅ No active orders to cancel for contract ${contractId}`);
        return { success: true, cancelledCount: 0, failedOrders: [] };
      }

      this.logger.info(`📋 Found ${activeOrdersForContract.length} active orders to cancel`);

      // First, try to identify and cancel parent orders (OSO/OCO strategies)
      const parentOrders = [];
      const childOrders = [];
      const standaloneOrders = [];

      for (const order of activeOrdersForContract) {
        // Check if this is part of an order strategy
        if (order.orderStrategyId) {
          // This is a child order of a strategy
          childOrders.push(order);
        } else if (order.ocoId || order.osoId) {
          // This might be a parent or linked order
          parentOrders.push(order);
        } else {
          // Standalone order
          standaloneOrders.push(order);
        }

        // Log detailed order information for debugging
        this.logger.info(`📄 Order ${order.id}: Status=${order.ordStatus}, Type=${order.orderType || 'Unknown'}, Strategy=${order.orderStrategyId || 'None'}`);
      }

      const cancelledOrders = [];
      const failedOrders = [];

      // Cancel in order: parent orders first, then standalone, then children
      const ordersToCancel = [...parentOrders, ...standaloneOrders, ...childOrders];

      for (const order of ordersToCancel) {
        try {
          this.logger.info(`🚫 Cancelling order ${order.id} (${order.ordStatus})`);


          // Only try to cancel if the status suggests it's cancellable
          const cancellableStatuses = ['Working', 'Suspended', 'Pending', 'PendingNew'];
          if (!cancellableStatuses.includes(order.ordStatus)) {
            this.logger.warn(`⚠️ Order ${order.id} has status ${order.ordStatus} - may not be cancellable`);
          }

          const cancelResult = await this.cancelOrder(order.id);

          if (cancelResult) {
            this.logger.info(`✅ Successfully cancelled order ${order.id}`);
            cancelledOrders.push(order.id);
          } else {
            this.logger.warn(`⚠️ Cancel request for order ${order.id} returned no result`);
            failedOrders.push({ orderId: order.id, reason: 'No result from cancel API' });
          }

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (cancelError) {
          this.logger.error(`❌ Failed to cancel order ${order.id}: ${cancelError.message}`);
          failedOrders.push({
            orderId: order.id,
            status: order.ordStatus,
            reason: cancelError.message
          });
        }
      }

      // Check if all orders were cancelled
      const allCancelled = failedOrders.length === 0;

      if (allCancelled) {
        this.logger.info(`✅ Successfully cancelled all ${cancelledOrders.length} orders for contract ${contractId}`);
      } else {
        this.logger.warn(`⚠️ Cancelled ${cancelledOrders.length} orders, but ${failedOrders.length} orders failed to cancel`);
        failedOrders.forEach(failed => {
          this.logger.error(`  Failed order ${failed.orderId}: ${failed.reason}`);
        });
      }

      return {
        success: allCancelled,
        cancelledCount: cancelledOrders.length,
        failedOrders: failedOrders,
        totalOrders: activeOrdersForContract.length
      };

    } catch (error) {
      this.logger.error(`❌ Error in cancelAllOrdersForContract: ${error.message}`);
      throw error;
    }
  }

  // Helper method to wait for liquidation completion
  async waitForLiquidationComplete(accountId, contractId, options = {}) {
    const {
      maxPollTime = 30000,     // 30 seconds max polling time
      pollInterval = 5000,     // 5 second intervals to avoid rate limits
      maxRetries = 3           // Maximum liquidation retry attempts
    } = options;

    const startTime = Date.now();
    let retryCount = 0;
    let useExplicitCancellation = false;  // Flag to trigger explicit order cancellation

    while (Date.now() - startTime < maxPollTime) {
      try {
        this.logger.info(`🔍 Checking liquidation status for contract ${contractId} (attempt ${Math.floor((Date.now() - startTime) / pollInterval) + 1})`);

        // Check for open orders on this contract
        const orders = await this.makeRequest('GET', `/order/list?accountId=${accountId}`);
        let openOrdersForContract = (orders || []).filter(order =>
          order.contractId === contractId &&
          this.ACTIVE_ORDER_STATUSES.includes(order.ordStatus)
        );


        // Check position for this contract
        const positions = await this.makeRequest('GET', `/position/list?accountId=${accountId}`);
        const positionForContract = (positions || []).find(position => position.contractId === contractId);
        const netPosition = positionForContract ? positionForContract.netPos : 0;

        this.logger.info(`📊 Liquidation status - Open orders: ${openOrdersForContract.length}, Net position: ${netPosition}`);

        // Success condition: no open orders AND zero net position
        if (openOrdersForContract.length === 0 && netPosition === 0) {
          this.logger.info(`✅ Liquidation verified complete for contract ${contractId}`);
          return { success: true, retries: retryCount };
        }

        // If we still have open orders or position, retry liquidation if within retry limit
        if (openOrdersForContract.length > 0 || netPosition !== 0) {
          if (retryCount < maxRetries) {
            this.logger.warn(`⚠️ Incomplete liquidation detected. Orders: ${openOrdersForContract.length}, Position: ${netPosition}. Retry ${retryCount + 1}/${maxRetries}`);

            // Log details of remaining orders
            if (openOrdersForContract.length > 0) {
              this.logger.info(`📋 Remaining orders details:`);
              openOrdersForContract.forEach(order => {
                this.logger.info(`  • Order ${order.id}: Status=${order.ordStatus}, Type=${order.orderType || 'Unknown'}, Action=${order.action || 'Unknown'}`);
              });
            }

            // On second retry and beyond, try explicit order cancellation first
            if (retryCount >= 1 && openOrdersForContract.length > 0) {
              this.logger.info(`🎯 Attempting explicit order cancellation before retry ${retryCount + 1}`);

              try {
                const cancelResult = await this.cancelAllOrdersForContract(accountId, contractId);

                if (cancelResult.success) {
                  this.logger.info(`✅ Successfully cancelled all ${cancelResult.cancelledCount} orders`);
                } else {
                  this.logger.warn(`⚠️ Partial cancellation: ${cancelResult.cancelledCount} cancelled, ${cancelResult.failedOrders.length} failed`);

                  // Log failed orders for debugging
                  if (cancelResult.failedOrders.length > 0) {
                    this.logger.error(`❌ Failed to cancel the following orders:`);
                    cancelResult.failedOrders.forEach(failed => {
                      this.logger.error(`  • Order ${failed.orderId} (${failed.status}): ${failed.reason}`);
                    });
                  }
                }

                // Wait a bit for cancellations to process
                await new Promise(resolve => setTimeout(resolve, 2000));

              } catch (cancelError) {
                this.logger.error(`❌ Error during explicit order cancellation: ${cancelError.message}`);
              }
            }

            // Retry liquidation API call
            this.logger.info(`🔄 Retrying liquidatePosition API call (attempt ${retryCount + 1})`);

            try {
              await this.makeRequest('POST', '/order/liquidateposition', {
                accountId: accountId,
                contractId: contractId,
                admin: false
              });
              this.logger.info(`📤 Liquidation retry ${retryCount + 1} sent successfully`);
            } catch (liquidateError) {
              this.logger.error(`❌ Liquidation retry ${retryCount + 1} failed: ${liquidateError.message}`);
            }

            retryCount++;
          } else {
            // Max retries exceeded - prepare detailed error information
            this.logger.error(`❌ Max retries (${maxRetries}) exceeded. Liquidation incomplete.`);

            const failedOrderDetails = openOrdersForContract.map(order => ({
              id: order.id,
              status: order.ordStatus,
              type: order.orderType,
              action: order.action
            }));

            // This will trigger the alert
            throw new Error(`Liquidation failed after ${maxRetries} retries. ${openOrdersForContract.length} orders remain open, position: ${netPosition}`);
          }
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));

      } catch (error) {
        // If it's our deliberate error, re-throw it
        if (error.message.includes('Liquidation failed after')) {
          throw error;
        }

        this.logger.error(`Error during liquidation verification: ${error.message}`);
        // Continue polling unless this is a critical error
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    // Timeout reached - check final status and prepare detailed error
    try {
      const orders = await this.makeRequest('GET', `/order/list?accountId=${accountId}`);
      const openOrdersForContract = (orders || []).filter(order =>
        order.contractId === contractId &&
        this.ACTIVE_ORDER_STATUSES.includes(order.ordStatus)
      );

      const positions = await this.makeRequest('GET', `/position/list?accountId=${accountId}`);
      const positionForContract = (positions || []).find(position => position.contractId === contractId);
      const netPosition = positionForContract ? positionForContract.netPos : 0;

      // Include order IDs in the error for manual intervention
      const orderIds = openOrdersForContract.map(o => o.id).join(', ');
      throw new Error(`Liquidation timeout after ${maxPollTime}ms. Remaining orders: ${openOrdersForContract.length} (IDs: ${orderIds}), Net position: ${netPosition}`);
    } catch (statusError) {
      throw statusError;
    }
  }

  // Liquidate position - cancels all orders and closes position for a contract
  // Now with polling to ensure complete liquidation
  async liquidatePosition(accountId, contractId, options = {}) {
    try {
      this.logger.info(`🔥 Liquidating position: accountId=${accountId}, contractId=${contractId}`);

      // Get initial status
      const initialOrders = await this.makeRequest('GET', `/order/list?accountId=${accountId}`);
      const initialOrdersForContract = (initialOrders || []).filter(order =>
        order.contractId === contractId &&
        this.ACTIVE_ORDER_STATUSES.includes(order.ordStatus)
      );

      const initialPositions = await this.makeRequest('GET', `/position/list?accountId=${accountId}`);
      const initialPosition = (initialPositions || []).find(position => position.contractId === contractId);
      const initialNetPos = initialPosition ? initialPosition.netPos : 0;

      this.logger.info(`📊 Initial state - Open orders: ${initialOrdersForContract.length}, Net position: ${initialNetPos}`);

      // If already liquidated, return success
      if (initialOrdersForContract.length === 0 && initialNetPos === 0) {
        this.logger.info(`✅ Contract ${contractId} already liquidated`);
        this.emit('positionLiquidated', { accountId, contractId, alreadyLiquidated: true });
        return { success: true, message: 'Already liquidated' };
      }

      // Call Tradovate liquidation API
      const response = await this.makeRequest('POST', '/order/liquidateposition', {
        accountId: accountId,
        contractId: contractId,
        admin: false  // Required field - false for regular user liquidation
      });

      this.logger.info('📤 Liquidation request sent to Tradovate:', response);

      // Wait for liquidation to complete with polling
      const verificationResult = await this.waitForLiquidationComplete(accountId, contractId, options);

      this.logger.info(`✅ Position liquidated and verified complete for contract ${contractId} after ${verificationResult.retries} retries`);
      this.emit('positionLiquidated', { accountId, contractId, response, verified: true, retries: verificationResult.retries });
      return { ...response, verified: true, retries: verificationResult.retries };

    } catch (error) {
      this.logger.error(`❌ Failed to liquidate position: ${error.message}`);

      // Send critical alert for liquidation failures with additional context
      const alertDetails = {
        retries: error.message.includes('retries') ? error.message.match(/after (\d+) retries/)?.[1] : undefined,
        timestamp: new Date().toISOString()
      };
      await this.sendLiquidationAlert(error, accountId, contractId, alertDetails);

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
        // For bulk operations, we can bypass cache to ensure fresh data
        const enrichedOrder = await this.enrichOrder(order, { bypassCache: true });
        enrichedOrders.push(enrichedOrder);
      }

      this.logger.info(`✨ Enrichment completed: ${enrichedOrders.length} orders`);
      return enrichedOrders;
    } catch (error) {
      this.logger.error('Failed to get orders:', error.message);
      throw error;
    }
  }

  // LEGACY METHOD - COMMENTED OUT FOR ROLLBACK SAFETY
  // async enrichOrder(order) {
  //   let enrichedOrder = { ...order };
  //   try {
  //     // Step 1: Get order version details (this has the real prices!)
  //     this.logger.info(`🔬 Getting order version details for order ${order.id}...`);
  //     const orderVersionResponse = await this.makeRequest('GET', `/orderVersion/deps?masterid=${order.id}`);
  //     const orderVersions = orderVersionResponse || [];
  //     this.logger.info(`🔍 DEBUG Order ${order.id} versions found: ${orderVersions.length}`);
  //     if (orderVersions.length > 0) {
  //       // Usually there's only one version, but take the most recent
  //       const latestVersion = orderVersions[orderVersions.length - 1];
  //       // Extract price information from version (CRITICAL!)
  //       const versionPrice = latestVersion.price || latestVersion.limitPrice || latestVersion.stopPrice;
  //       enrichedOrder = {
  //         ...enrichedOrder,
  //         // Price information from order version
  //         limitPrice: versionPrice,
  //         price: versionPrice,
  //         // Order details
  //         orderType: latestVersion.orderType || order.orderType || 'Market',
  //         qty: latestVersion.orderQty || order.orderQty,
  //         orderQty: latestVersion.orderQty || order.orderQty,
  //         // Action
  //         action: order.action || latestVersion.action
  //       };
  //       this.logger.info(`🔬 Enriched order ${order.id}: Price=${versionPrice}, Type=${enrichedOrder.orderType}, Qty=${enrichedOrder.qty}`);
  //       this.logger.info(`🔍 DEBUG Enrichment - latestVersion.orderQty=${latestVersion.orderQty}, order.orderQty=${order.orderQty}, final qty=${enrichedOrder.qty}`);
  //     }
  //     // Step 2: Get contract details if contractId is available
  //     if (order.contractId) {
  //       try {
  //         const contractDetails = await this.makeRequest('GET', `/contract/item?id=${order.contractId}`);
  //         if (contractDetails) {
  //           enrichedOrder.contractName = contractDetails.name;
  //           enrichedOrder.symbol = contractDetails.name; // Use contract name as symbol
  //           enrichedOrder.tickSize = contractDetails.tickSize;
  //           this.logger.info(`📋 Contract details for ${order.id}: ${contractDetails.name}`);
  //         }
  //       } catch (contractError) {
  //         this.logger.warn(`Failed to get contract details for order ${order.id}:`, contractError.message);
  //       }
  //     }
  //   } catch (error) {
  //     this.logger.warn(`Failed to enrich order ${order.id}:`, error.message);
  //   }
  //   return enrichedOrder;
  // }

  // CONSOLIDATED enrichOrder method with caching and improved field mapping
  async enrichOrder(order, options = {}) {
    const { bypassCache = false } = options;

    try {
      // Check if we already have enriched data for this order (unless bypassing cache)
      if (!bypassCache && this.enrichmentCache.has(order.id)) {
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

          // Merge order version data which has the real prices AND order type
          enrichedOrder = {
            ...enrichedOrder,
            price: orderVersion.price || enrichedOrder.price,
            stopPrice: orderVersion.stopPrice || enrichedOrder.stopPrice,
            qty: orderVersion.orderQty || orderVersion.qty || enrichedOrder.qty,
            orderQty: orderVersion.orderQty || orderVersion.qty || enrichedOrder.orderQty,
            filledQty: orderVersion.filledQty || enrichedOrder.filledQty,
            avgFillPrice: orderVersion.avgFillPrice || enrichedOrder.avgFillPrice,
            orderType: orderVersion.orderType || enrichedOrder.orderType
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

      // Cache the enriched order to avoid future API calls (unless bypassing cache)
      if (!bypassCache) {
        this.enrichmentCache.set(order.id, enrichedOrder);
      }

      return enrichedOrder;

    } catch (error) {
      this.logger.error(`Failed to enrich order ${order.id}:`, error.message);
      // Return original order if enrichment fails
      return order;
    }
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

  // Fill & Trade History Methods
  async getFills(accountId) {
    try {
      const response = await this.makeRequest('GET', `/fill/list?accountId=${accountId}`);
      return response;
    } catch (error) {
      this.logger.error('Failed to get fills:', error.message);
      throw error;
    }
  }

  async getFillPairs() {
    try {
      const response = await this.makeRequest('GET', '/fillPair/list');
      return response;
    } catch (error) {
      this.logger.error('Failed to get fill pairs:', error.message);
      throw error;
    }
  }

  async getFillFees() {
    try {
      const response = await this.makeRequest('GET', '/fillFee/list');
      return response;
    } catch (error) {
      this.logger.error('Failed to get fill fees:', error.message);
      throw error;
    }
  }

  async getContractMaturity(maturityId) {
    try {
      const response = await this.makeRequest('GET', `/contractMaturity/item?id=${maturityId}`);
      return response;
    } catch (error) {
      this.logger.error(`Failed to get contract maturity ${maturityId}:`, error.message);
      throw error;
    }
  }

  async getProduct(productId) {
    try {
      const response = await this.makeRequest('GET', `/product/item?id=${productId}`);
      return response;
    } catch (error) {
      this.logger.error(`Failed to get product ${productId}:`, error.message);
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

  // Map generic symbols like "MNQ" to full contract symbols like "MNQM6"
  // Contract symbols are driven by env vars (*_CONTRACT) - update in .env for quarterly rollover
  mapToFullContractSymbol(symbol) {
    const nq = process.env.NQ_CONTRACT || 'NQM6';
    const mnq = process.env.MNQ_CONTRACT || 'MNQM6';
    const es = process.env.ES_CONTRACT || 'ESM6';
    const mes = process.env.MES_CONTRACT || 'MESM6';

    const symbolMap = {
      // Micro E-mini NASDAQ-100
      'MNQ': mnq,
      [mnq]: mnq,

      // E-mini NASDAQ-100
      'NQ': nq,
      'NQ!': nq,    // TradingView continuous contract
      'NQ1!': nq,   // TradingView format variant
      [nq]: nq,

      // Micro E-mini S&P 500
      'MES': mes,
      [mes]: mes,

      // E-mini S&P 500
      'ES': es,
      [es]: es,

      // E-mini Russell 2000 (update manually or add RTY_CONTRACT env var)
      'RTY': 'RTYM6',
      'RTYM6': 'RTYM6',

      // Micro E-mini Russell 2000
      'M2K': 'M2KM6',
      'M2KM6': 'M2KM6'
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

  // DUPLICATE METHOD REMOVED - Using consolidated enrichOrder method above

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
  async enrichOrders(orders, options = {}) {
    if (!Array.isArray(orders)) {
      return orders;
    }

    const enrichedOrders = [];
    for (const order of orders) {
      try {
        const enriched = await this.enrichOrder(order, options);
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
    // Tradovate allows ONE socket per user — never open a second while one is still handshaking.
    if (this.ws && (this.wsConnected || this.ws.readyState === WebSocket.CONNECTING)) {
      this.logger.info('WebSocket already connected');
      return;
    }

    try {
      const url = this.wssUrl;
      this.logger.info(`Connecting to Tradovate WebSocket ${url}...`);

      // Connect without headers - authenticate after connection
      const ws = new WebSocket(url);
      this.ws = ws;

      // Listening for this makes `ws` hand us the handshake response instead of a bare Error, so the status code
      // survives — 421 (wrong host) must be told apart from any other handshake failure.
      ws.on('unexpected-response', (req, res) => {
        const status = res.statusCode;
        if (this.ws === ws) { this.ws = null; this.wsConnected = false; }
        try { ws.terminate(); } catch { /* already gone */ }   // its error/close now land on a socket we no longer own
        if (status === 421) {
          this._recoverFromWrongHost(url);
          return;
        }
        this.logger.error(`WebSocket handshake rejected: ${url} -> ${status}`);
        this.attemptWebSocketReconnection();
      });

      // Set up event handlers
      ws.on('open', () => {
        this.logger.info('✅ WebSocket connected to Tradovate');
        this.wsConnected = true;
        this.wsReconnectAttempts = 0;
        this._wrongHostRedialed = false;
        this.wsRequestId = 1;  // Reset for clean state on each new connection

        // Don't send anything immediately - wait for open frame
        // Authorization and sync will be triggered by open frame

        // Set up heartbeat
        this.startHeartbeat();
      });

      ws.on('message', (data) => {
        try {
          // Liveness: any inbound frame (incl. 'h' heartbeats) proves the feed
          // is alive. The watchdog reconnects if this stops advancing.
          this.lastInboundTs = Date.now();

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
              this.logger.debug('📨 Array frame received');
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

      // Pong is also an inbound liveness signal (response to our ping()).
      ws.on('pong', () => { this.lastInboundTs = Date.now(); });

      // error/close from a socket we already replaced or deliberately closed (host-change redial, 421 abort,
      // disconnect()) must not touch the current socket's state or start a second reconnect chain.
      ws.on('error', (error) => {
        if (this.ws !== ws) return;
        this.logger.error('WebSocket error:', error);
        this.wsConnected = false;
      });

      ws.on('close', (code, reason) => {
        if (this.ws !== ws) {
          this.logger.info(`Retired WebSocket closed: ${code}`);
          return;
        }
        this.logger.warn(`WebSocket disconnected: ${code} - ${reason}`);
        this.wsConnected = false;

        this.stopHeartbeat();

        // Attempt reconnection
        this.attemptWebSocketReconnection();
      });

    } catch (error) {
      this.logger.error('Failed to connect WebSocket:', error);
      this.wsConnected = false;
    }
  }

  /**
   * A 421 is the wrong-host rejection and it has NO fallback — redialling the same URL can only fail again. So one
   * re-auth (which re-reads apiHosts) and exactly ONE more dial. Deliberately not wired into
   * attemptWebSocketReconnection: the 2026-09-20 reconnect storm is what happens when a retry path can re-enter
   * itself. The allowance resets only when a socket actually opens.
   */
  async _recoverFromWrongHost(rejectedUrl) {
    if (this._wrongHostRedialed) {
      this.logger.error(`🚨 WebSocket 421 again at ${rejectedUrl} after re-reading apiHosts — giving up; manual intervention needed`);
      return;
    }
    this._wrongHostRedialed = true;
    this.logger.warn(`⚠️ WebSocket 421 at ${rejectedUrl} — wrong host; re-authenticating to re-read apiHosts`);
    try {
      await this.authenticate();
    } catch (err) {
      this.logger.error(`🚨 Re-auth after WebSocket 421 failed: ${err.message} — not redialling`);
      return;
    }
    await this.connectWebSocket();
  }

  /** A renewal moved the trading host: retire the socket on the old host and dial the new one, once. */
  _redialOnNewHost(fromUrl, toUrl) {
    this.logger.warn(`🌐 Trading host changed ${fromUrl} → ${toUrl} — redialling WebSocket`);
    this.disconnectWebSocket();   // nulls this.ws first, so the old socket's close is ignored
    this.connectWebSocket();
  }

  // Add request ID counter
  wsRequestId = 1;

  authorizeConnection() {
    if (!this.ws || !this.wsConnected) {
      this.logger.warn('Cannot authorize - WebSocket not connected');
      return;
    }

    this._authRequestId = this.wsRequestId;  // Track auth requestId before incrementing
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

    this._syncRequestId = this.wsRequestId;  // Track sync requestId before incrementing
    const requestId = this.wsRequestId++;

    // Tradovate WS frame: endpoint\nid\nquery\nbody. The documented user sync
    // (openapi.json "User Synchronization") includes a body { users: [userId] }
    // to start the real-time user-data subscription. Include it when we know
    // the userId (captured at auth); fall back to bodyless otherwise.
    const body = this.userId ? `\n\n${JSON.stringify({ users: [this.userId] })}` : '';
    const syncMessage = `user/syncrequest\n${requestId}${body}`;

    this.logger.info(`📡 Sending user sync request (users=[${this.userId ?? 'none'}])...`);
    this.ws.send(syncMessage);
  }

  handleWebSocketMessage(message) {
    // Handle different message types
    if (message.e === 'props') {
      // Don't log Kalshi events to avoid spam
      const kalshiEvents = ['kalshiMarket', 'kalshiMilestone', 'kalshiStructuredTarget'];
      if (!kalshiEvents.includes(message.d.entityType)) {
        this.logger.info(`🔄 WebSocket event: ${message.d.entityType} - ${message.d.eventType}`);
      }
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
      // Check if this is an authorization response (dynamic requestId)
      if (requestId === this._authRequestId) {
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
    this.logger.debug(`✅ Request ${requestId} successful`);

    if (requestId === this._syncRequestId) {
      // This is the sync response
      this.handleInitialSyncResponse({ d: data, i: requestId });
    } else {
      this.logger.debug('Response data:', JSON.stringify(data, null, 2));
    }
  }

  handleUserPropertyUpdate(data) {
    const { entity, entityType, eventType } = data;

    // Special handling for Kalshi data - publish to news channel
    const kalshiEvents = ['kalshiMarket', 'kalshiMilestone', 'kalshiStructuredTarget'];
    if (kalshiEvents.includes(entityType)) {
      // Log Kalshi market events for news panel
      this.logger.debug(`📰 Kalshi ${entityType}: ${entity.title || entity.id} - ${eventType}`);

      // Publish to market news channel
      const newsEvent = {
        type: entityType,
        eventType,
        timestamp: new Date().toISOString(),
        title: entity.title || `${entityType} Update`,
        description: entity.rulesPrimary || entity.status || '',
        status: entity.status || eventType,
        result: entity.result,
        openTime: entity.openTime,
        closeTime: entity.closeTime,
        entity: entity
      };

      if (this.messageBus && this.channels) {
        this.messageBus.publish(this.channels.MARKET_NEWS, newsEvent);
      }
    } else {
      // Log important trading events at info level, others at debug
      const importantTypes = ['order', 'fill', 'position', 'executionReport', 'orderStrategy'];
      if (importantTypes.includes(entityType)) {
        this.logger.info(`🔄 User property update: ${entityType} - ${eventType}`);
      } else {
        this.logger.debug(`🔄 User property update: ${entityType} - ${eventType}`);
      }
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

    // Emit type-specific events. Tradovate sends entityType in lowercase
    // ("order","position","cashBalance","executionReport","orderStrategy");
    // normalize so the switch matches regardless of casing (capitalized labels
    // silently dropped position/order/cashBalance updates).
    switch ((entityType || '').toLowerCase()) {
      case 'order':
        // Handle order updates efficiently with caching
        this.handleOrderUpdate(entity, eventType).then(enrichedOrder => {
          this.emit('orderUpdate', { entity: enrichedOrder, eventType });
        }).catch(error => {
          this.logger.error(`Failed to handle order update for ${entity.id}:`, error.message);
          // Emit the original order if enrichment fails
          this.emit('orderUpdate', { entity, eventType });
        });
        break;
      case 'position':
        this.emit('positionUpdate', { entity, eventType });
        break;
      case 'fill':
        // The `fill` entity is the only one carrying the fill PRICE (order /
        // executionReport do not). The connector uses it for ORDER_FILLED + to
        // attribute/price position transitions.
        this.emit('fillUpdate', { entity, eventType });
        break;
      case 'cashbalance':
        this.emit('balanceUpdate', { entity, eventType });
        break;
      case 'executionreport':
        this.emit('executionUpdate', { entity, eventType });
        break;
      case 'orderstrategy':
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
    this.stopHeartbeat();              // clear any timers from a prior socket
    this.lastInboundTs = Date.now();   // seed liveness at connect time

    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.wsConnected) {
        try { this.ws.ping(); } catch { /* socket mid-teardown */ }
      }
    }, 30000); // 30 second WS-protocol ping

    // Zombie-socket watchdog (see WS_STALE_TIMEOUT_MS comment at top of file).
    this.wsWatchdogInterval = setInterval(() => {
      if (!this.ws || !this.wsConnected) return;
      const silentMs = Date.now() - this.lastInboundTs;
      if (silentMs > WS_STALE_TIMEOUT_MS) {
        this.logger.warn(`🧟 WebSocket feed stale — no inbound frames for ${Math.round(silentMs / 1000)}s (> ${WS_STALE_TIMEOUT_MS / 1000}s). Terminating to force reconnect.`);
        this.wsConnected = false;   // prevent re-entry before 'close' fires
        this.stopHeartbeat();       // stop timers; 'close' handler reconnects
        try { this.ws.terminate(); } catch (err) { this.logger.error(`WS terminate failed: ${err.message}`); }
      }
    }, WS_WATCHDOG_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    if (this.wsWatchdogInterval) { clearInterval(this.wsWatchdogInterval); this.wsWatchdogInterval = null; }
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
    this.wsConnected = false;   // set first so the watchdog no-ops during teardown
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // Send email alert for critical liquidation failures using Resend
  async sendLiquidationAlert(error, accountId, contractId, additionalDetails = {}) {
    try {
      // Skip if Resend not configured
      if (!process.env.RESEND_API_KEY) {
        this.logger.warn('📧 Email alert skipped - RESEND_API_KEY not configured');
        return;
      }

      // Skip if no alert destination configured
      if (!process.env.ALERT_SMS_EMAIL && !process.env.ALERT_EMAIL) {
        this.logger.warn('📧 Email alert skipped - no alert destinations configured');
        return;
      }

      this.logger.info('📧 Sending liquidation failure alert via Resend...');

      // Initialize Resend client
      const resend = new Resend(process.env.RESEND_API_KEY);

      // Get contract details for better context
      let contractInfo = `Contract ${contractId}`;
      try {
        const contract = await this.getContract(contractId);
        if (contract?.name) {
          contractInfo = `${contract.name} (${contractId})`;
        }
      } catch (contractError) {
        // Ignore contract lookup errors for alerts
      }

      // Try to get current order and position status
      let orderStatus = '';
      let positionStatus = '';
      try {
        const orders = await this.makeRequest('GET', `/order/list?accountId=${accountId}`);
        const activeOrders = (orders || []).filter(order =>
          order.contractId === contractId &&
          this.ACTIVE_ORDER_STATUSES.includes(order.ordStatus)
        );

        if (activeOrders.length > 0) {
          const orderIds = activeOrders.map(o => o.id).slice(0, 5).join(', '); // Limit to first 5
          orderStatus = `\nOpen Orders: ${activeOrders.length} (IDs: ${orderIds})`;
        }

        const positions = await this.makeRequest('GET', `/position/list?accountId=${accountId}`);
        const position = (positions || []).find(p => p.contractId === contractId);
        if (position && position.netPos !== 0) {
          positionStatus = `\nNet Position: ${position.netPos}`;
        }
      } catch (statusError) {
        // Ignore errors when fetching status for alert
      }

      // Extract order IDs from error message if present
      let orderIdsFromError = '';
      const orderIdMatch = error.message.match(/IDs: ([^)]+)/);
      if (orderIdMatch) {
        orderIdsFromError = `\nFailed Order IDs: ${orderIdMatch[1]}`;
      }

      // Send SMS alert if SMS email is configured
      if (process.env.ALERT_SMS_EMAIL) {
        const smsMessage = `🚨 LIQUIDATION FAILED
Account: ${accountId}
Contract: ${contractInfo}${orderStatus}${positionStatus}${orderIdsFromError}
Error: ${error.message.substring(0, 100)}
Time: ${new Date().toLocaleString()}

MANUAL INTERVENTION REQUIRED`;

        const smsResult = await resend.emails.send({
          from: process.env.ALERT_FROM_EMAIL,
          to: process.env.ALERT_SMS_EMAIL,
          subject: '🚨 LIQUIDATION FAILURE - URGENT',
          text: smsMessage
        });

        this.logger.info(`✅ SMS alert sent via Resend: ${smsResult.data?.id}`);
      }

      // Send detailed email alert if email is configured
      if (process.env.ALERT_EMAIL) {
        const detailedMessage = `
CRITICAL ALERT: Position Liquidation Failed

Account ID: ${accountId}
Contract: ${contractInfo}
Timestamp: ${new Date().toISOString()}

ERROR DETAILS:
${error.message}

CURRENT STATUS:${orderStatus}${positionStatus}

${orderIdsFromError ? 'PROBLEMATIC ORDER IDS:' + orderIdsFromError : ''}

ACTION REQUIRED:
1. Log into Tradovate immediately
2. Manually cancel all open orders for ${contractInfo}
3. Close any remaining positions
4. Check system logs for additional details

${additionalDetails.retries ? `Retry Attempts: ${additionalDetails.retries}` : ''}

This is an automated alert from the Slingshot Trading System.
`;

        const emailResult = await resend.emails.send({
          from: process.env.ALERT_FROM_EMAIL,
          to: process.env.ALERT_EMAIL,
          subject: '🚨 CRITICAL: Liquidation Failure - Manual Intervention Required',
          text: detailedMessage
        });

        this.logger.info(`✅ Detailed email alert sent via Resend: ${emailResult.data?.id}`);
      }

    } catch (emailError) {
      this.logger.error(`❌ Failed to send liquidation alert via Resend: ${emailError.message}`);
      // Don't throw - we don't want email failures to break liquidation error handling
    }
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