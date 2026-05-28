/**
 * TradovateConnector
 *
 * Per-account connector that owns ONE Tradovate account's entire reality:
 * TradovateClient, WebSocket, order/position state, bracket correlation,
 * structural-stop resolution, breakeven handling, reconciliation, and
 * per-account Redis persistence.
 *
 * The broker service (tradovate-service) is a thin bootstrapper — it loads
 * account records, instantiates one of these per account, and registers
 * each with the router. The router routes `order.request` by accountId;
 * nothing else in the system knows about this class.
 *
 * Every outbound message is stamped with `accountId` (the slingshot id,
 * not the Tradovate numeric id). The numeric Tradovate id lives in
 * `account.config.accountId` and is used only when talking to Tradovate.
 */

import { BaseConnector } from './base-connector.js';
import { registerConnector } from './registry.js';

const ORDER_STRATEGY_MAP_PREFIX = 'tradovate:'; // legacy key shape; used for backward-compat read
const ORDER_MAPPINGS_PREFIX = 'tradovate:';     // new: tradovate:{accountId}:order:mappings (superset)
const PENDING_STRUCTURAL_STOP_TTL_MS = 5 * 60 * 1000;
const PENDING_ORDER_SIGNAL_TTL_MS = 30 * 1000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

export class TradovateConnector extends BaseConnector {
  constructor(account, logger, deps = {}) {
    super(account, logger, deps);

    if (!deps.ClientClass) throw new Error('TradovateConnector requires deps.ClientClass');
    if (!deps.messageBus) throw new Error('TradovateConnector requires deps.messageBus');
    if (!deps.channels) throw new Error('TradovateConnector requires deps.channels');

    const config = account.config || {};
    const credentials = account.credentials || {};

    this.messageBus = deps.messageBus;
    this.channels = deps.channels;
    this.redis = deps.redis || null;

    // When this connector is used as a shadow by another connector (e.g. PMT),
    // `accountIdOverride` replaces this.account.id in every outbound event so
    // fills/positions look like they belong to the owning account.
    this.accountIdOverride = deps.accountIdOverride || null;
    this.emittedAccountId = this.accountIdOverride || account.id;

    this.mode = config.mode === 'live' ? 'live' : 'demo';
    this.brokerAccountId = Number(config.accountId); // Tradovate numeric id (API requires number)
    if (!Number.isFinite(this.brokerAccountId)) {
      throw new Error(`TradovateConnector ${account.id}: account.config.accountId must be numeric (got ${config.accountId})`);
    }

    this.clientConfig = {
      username: credentials.username,
      password: credentials.password,
      appId: credentials.appId || config.appId,
      appVersion: credentials.appVersion || config.appVersion || '1.0',
      deviceId: `${config.deviceId || 'slingshot'}-${account.id}`,
      cid: credentials.cid || config.cid,
      secret: credentials.secret,
      useDemo: this.mode === 'demo',
      defaultAccountId: this.brokerAccountId,
      demoUrl: config.demoUrl || 'https://demo.tradovateapi.com/v1',
      liveUrl: config.liveUrl || 'https://live.tradovateapi.com/v1',
      wssDemoUrl: config.wssDemoUrl || 'wss://md-demo.tradovateapi.com/v1/websocket',
      wssLiveUrl: config.wssLiveUrl || 'wss://md.tradovateapi.com/v1/websocket'
    };

    this.client = null;

    // Per-account state
    this.orderSignalMap = new Map();            // orderId → signalId
    this.orderStrategyMap = new Map();          // orderId|strategyId → strategyName
    this.orderStrategyLinks = new Map();        // strategyId → {entryOrderId, stopOrderId, targetOrderId}
    this.strategyChildMap = new Map();          // strategyId → {signalId, childOrderIds: Set}
    this.pendingOrderSignals = new Map();       // symbol → {signalId, strategy, timestamp}
    this.pendingStructuralStops = new Map();    // strategyId → {stopPrice, targetPrice, action, timestamp}
    // strategyId → { entryPrice, direction, symbol, filledAt, mfe, rules: [{afterMinutes, mfeThreshold, action, trailOffset, triggered}] }
    this.tbTracking = new Map();

    // Cache of contractId → symbol
    this.contractCache = new Map();

    this.reconcileTimer = null;
    this.lastError = null;
  }

  static brokerKey() { return 'tradovate'; }
  static displayName() { return 'Tradovate'; }

  static credentialSchema() {
    return {
      configFields: [
        { key: 'mode', label: 'Mode', type: 'select', options: ['live', 'demo'], required: true },
        { key: 'accountId', label: 'Tradovate Account ID', type: 'text', required: true,
          help: 'Numeric Tradovate account id' },
        { key: 'appId', label: 'App ID', type: 'text', required: false }
      ],
      fields: [
        { key: 'username', label: 'Username', type: 'text', sensitive: true, required: true },
        { key: 'password', label: 'Password', type: 'password', sensitive: true, required: true },
        { key: 'cid', label: 'CID', type: 'text', sensitive: true, required: false },
        { key: 'secret', label: 'Secret', type: 'password', sensitive: true, required: false }
      ]
    };
  }

  // -------------------- Lifecycle --------------------

  async init() {
    const { ClientClass, messageBus, channels } = this.deps;
    this.client = new ClientClass(this.clientConfig, this.logger, messageBus, channels);
    await this.client.connect();
    this.ready = true;

    this._attachClientEvents();
    await this._loadOrderMappings();

    // Initial reconcile + snapshot broadcast (positions AND working orders)
    await this._reconcileAndSnapshot('startup');

    this.reconcileTimer = setInterval(
      () => this._reconcileAndSnapshot('periodic').catch(err =>
        this.logger.error(`[${this._label()}] reconcile failed: ${err.message}`)),
      RECONCILE_INTERVAL_MS
    );
    this.reconcileTimer.unref?.();

    // Subscribe to price updates for breakeven watching
    this._priceHandler = msg => this._onPriceUpdate(msg);
    await this.messageBus.subscribe(this.channels.PRICE_UPDATE, this._priceHandler);

    this.logger.info(`[${this._label()}] connected (${this.mode}) broker=${this.brokerAccountId}`);
  }

  async shutdown() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;

    if (this._priceHandler) {
      try { await this.messageBus.unsubscribe?.(this.channels.PRICE_UPDATE, this._priceHandler); } catch {}
    }

    if (this.client?.ws) {
      try { this.client.ws.close(); } catch {}
    }
    if (this.client?.tokenRefreshTimer) {
      clearTimeout(this.client.tokenRefreshTimer);
    }
    this.client = null;
    this.ready = false;
    this.logger.info(`[${this._label()}] shut down`);
  }

  async healthCheck() {
    return {
      ok: this.ready && (this.client?.isConnected ?? false),
      mode: this.mode,
      brokerAccountId: this.brokerAccountId,
      openStrategies: this.orderStrategyLinks.size,
      pendingStructuralStops: this.pendingStructuralStops.size,
      lastError: this.lastError
    };
  }

  async testConnection() {
    try {
      if (!this.client) await this.init();
      if (!this.client?.accessToken) return { ok: false, error: 'no access token' };
      const balance = await this.client.getCashBalances(this.brokerAccountId);
      return {
        ok: true,
        accountId: this.brokerAccountId,
        balance: balance?.totalCashValue ?? balance?.cashBalance ?? null,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // -------------------- Order handling --------------------

  /**
   * Entry point called by the router. `message` has been stamped by the
   * orchestrator with `accountId` (slingshot id), `signalId`, `strategy`.
   */
  async handleOrderRequest(message) {
    const signalId = message.signalId;
    const strategy = message.strategy || 'UNKNOWN';
    const symbol = message.symbol;

    if (!symbol) {
      return this._rejectLocally(signalId, strategy, 'missing symbol');
    }
    if (!message.action || !['Buy', 'Sell'].includes(message.action)) {
      return this._rejectLocally(signalId, strategy, `invalid action: ${message.action}`);
    }

    // Defense-in-depth: round limit / stop / target prices to the instrument's
    // tick grid. Strategies that compute mid-bar fib entries (e.g. ls-flip-
    // trigger-bar with fib=0.5 on an odd-tick range) can produce .125 / .375
    // half-ticks that the broker rejects.
    this._roundPricesToTick(message, symbol);

    // Contract resolution
    let contract;
    try {
      contract = await this.client.findContract(symbol);
    } catch (err) {
      return this._rejectLocally(signalId, strategy, `contract lookup failed: ${err.message}`, { symbol });
    }
    if (!contract?.id) {
      return this._rejectLocally(signalId, strategy, `contract not found: ${symbol}`, { symbol });
    }
    this.contractCache.set(contract.id, contract.symbol || symbol);

    const quantity = message.quantity || 1;
    const orderType = message.orderType;               // 'Limit' | 'Market'
    const hasStop = message.stopLoss != null;
    const hasTarget = message.takeProfit != null;
    const hasTrailing = message.trailingTrigger != null && message.trailingOffset != null;
    const isBracket = hasStop || hasTarget || hasTrailing;

    this.pendingOrderSignals.set(symbol, { signalId, strategy, timestamp: Date.now() });

    try {
      let result;
      if (hasTrailing) {
        result = await this._placeTrailingStrategy(message, contract);
      } else if (isBracket) {
        result = await this._placeBracket(message, contract);
      } else {
        result = await this._placeSimple(message, contract);
      }

      const strategyId = result.strategyId || result.orderId;
      if (!strategyId) {
        return this._rejectLocally(signalId, strategy, 'broker returned no order id');
      }

      // Record correlation maps
      this.orderSignalMap.set(strategyId, signalId);
      this.orderStrategyMap.set(strategyId, strategy);
      await this._saveOrderMappings();

      this.orderStrategyLinks.set(strategyId, {
        entryOrderId: result.entryOrderId || strategyId,
        stopOrderId: result.stopOrderId || null,
        targetOrderId: result.targetOrderId || null,
        isTrailing: !!hasTrailing,
        stopLoss: message.stopLoss ?? null,
        takeProfit: message.takeProfit ?? null,
        timestamp: Date.now()
      });

      // Stage structural stop correction if the caller wanted one
      if (message.structuralStop && message.stopLoss != null) {
        this.pendingStructuralStops.set(strategyId, {
          stopPrice: message.stopLoss,
          targetPrice: message.takeProfit,
          action: message.action,
          timestamp: Date.now()
        });
      }

      // Time-based trailing rules (from orchestrator, sourced from config:tb-rules)
      if (message.tbRules && Array.isArray(message.tbRules) && message.tbRules.length > 0) {
        this.tbTracking.set(strategyId, {
          entryPrice: message.price,
          direction: message.direction || (message.action === 'Buy' ? 'long' : 'short'),
          symbol,
          filledAt: null,  // set on actual fill
          mfe: 0,
          currentStop: message.stopLoss,
          rules: message.tbRules.map(r => ({ ...r, triggered: false }))
        });
      }

      await this.messageBus.publish(this.channels.ORDER_PLACED, {
        signalId, accountId: this.emittedAccountId, strategy, symbol,
        orderId: strategyId,
        brokerAccountId: this.brokerAccountId,
        action: message.action,
        orderType,
        quantity,
        price: message.price ?? null,
        stopPrice: message.stopLoss ?? null,
        takeProfit: message.takeProfit ?? null,
        isBracket,
        isTrailing: !!hasTrailing,
        timestamp: new Date().toISOString(),
        source: 'order_request_handler'
      });

      return { dispatched: true, strategyId };

    } catch (err) {
      return this._rejectLocally(signalId, strategy, err.message, { symbol });
    } finally {
      // TTL cleanup for pendingOrderSignals
      this._sweepExpired(this.pendingOrderSignals, PENDING_ORDER_SIGNAL_TTL_MS, 'timestamp');
    }
  }

  /**
   * Tick size for a given broker symbol. NQ/MNQ/ES/MES all tick at 0.25.
   * Add more as needed. Falls back to 0.25 with a warn.
   */
  _tickSizeFor(symbol) {
    const root = String(symbol || '').replace(/[A-Z]\d+$/, '').toUpperCase();
    switch (root) {
      case 'NQ': case 'MNQ':
      case 'ES': case 'MES':
      case 'RTY': case 'M2K':
      case 'YM': case 'MYM':
        return 0.25;
      default:
        this.logger.warn?.(`[${this._label()}] unknown tick size for ${symbol}; defaulting to 0.25`);
        return 0.25;
    }
  }

  _roundPricesToTick(message, symbol) {
    const tick = this._tickSizeFor(symbol);
    const snap = (v) => {
      if (v == null) return v;
      const n = Number(v);
      if (!Number.isFinite(n)) return v;
      const rounded = Math.round(n / tick) * tick;
      // Avoid 0.30000000000000004-style float artifacts.
      return Number(rounded.toFixed(4));
    };
    const before = { price: message.price, stopLoss: message.stopLoss, takeProfit: message.takeProfit };
    if (message.price != null) message.price = snap(message.price);
    if (message.stopLoss != null) message.stopLoss = snap(message.stopLoss);
    if (message.takeProfit != null) message.takeProfit = snap(message.takeProfit);
    const changed = before.price !== message.price
      || before.stopLoss !== message.stopLoss
      || before.takeProfit !== message.takeProfit;
    if (changed) {
      this.logger.warn?.(`[${this._label()}] tick-snapped ${symbol} prices: ` +
        `price ${before.price}->${message.price}, stop ${before.stopLoss}->${message.stopLoss}, ` +
        `target ${before.takeProfit}->${message.takeProfit} (tick=${tick})`);
    }
  }

  async _placeSimple(message, contract) {
    const tag = this._buildOrderTag(message);
    const orderData = {
      accountId: this.brokerAccountId,
      contractId: Number(contract.id),
      symbol: contract.name || message.symbol,
      action: message.action,
      orderQty: Number(message.quantity || 1),
      orderType: message.orderType,
      price: message.orderType === 'Limit' ? Number(message.price) : undefined,
      isAutomated: true,
      // Server-side attribution carriers. `text` lives on OrderVersion forever;
      // `clOrdId` on Command. Lets reconcile recover strategy without local state.
      ...(tag ? { text: tag, clOrdId: tag } : {})
    };
    const res = await this.client.placeOrder(orderData);
    return { orderId: res.orderId, strategyId: res.orderId, entryOrderId: res.orderId };
  }

  async _placeBracket(message, contract) {
    const action = message.action;
    const oppositeAction = action === 'Buy' ? 'Sell' : 'Buy';
    const tag = this._buildOrderTag(message);
    const orderData = {
      accountId: this.brokerAccountId,
      contractId: Number(contract.id),
      symbol: contract.name || message.symbol,
      action,
      orderQty: Number(message.quantity || 1),
      orderType: message.orderType,
      price: message.orderType === 'Limit' ? Number(message.price) : undefined,
      isAutomated: true,
      // Server-side attribution. customTag50 (FIX 50) is rejected by CME
      // ("Unregisted Tag50") so we only use text (FIX 58) + clOrdId (FIX 11).
      ...(tag ? { text: tag, clOrdId: tag } : {}),
      bracket1: message.stopLoss != null ? {
        action: oppositeAction, orderType: 'Stop', stopPrice: Number(message.stopLoss),
        ...(tag ? { text: tag, clOrdId: `${tag}.sl` } : {})
      } : undefined,
      bracket2: message.takeProfit != null ? {
        action: oppositeAction, orderType: 'Limit', price: Number(message.takeProfit),
        ...(tag ? { text: tag, clOrdId: `${tag}.tp` } : {})
      } : undefined
    };
    const res = await this.client.placeBracketOrder(orderData);
    // Tradovate's /order/placeOSO returns {orderId, oso1Id, oso2Id}; older
    // wrappers exposed bracket1OrderId/bracket2OrderId. Accept either so the
    // stop/target child orderIds get linked — without them, snapshot lookups
    // can't classify bracket legs as role='stop'/'target' and the orchestrator
    // ends up restoring all 3 legs as separate UNATTRIBUTED pending entries.
    const stopId   = res.bracket1OrderId ?? res.oso1Id ?? null;
    const targetId = res.bracket2OrderId ?? res.oso2Id ?? null;
    return {
      orderId: res.orderId,
      strategyId: res.orderId,
      entryOrderId: res.orderId,
      stopOrderId: stopId,
      targetOrderId: targetId
    };
  }

  async _placeTrailingStrategy(message, contract) {
    const orderData = {
      accountId: this.brokerAccountId,
      contractId: Number(contract.id),
      symbol: contract.name || message.symbol,
      action: message.action,
      orderQty: Number(message.quantity || 1),
      orderType: message.orderType,
      price: message.orderType === 'Limit' ? Number(message.price) : undefined,
      trailingTrigger: Number(message.trailingTrigger),
      trailingOffset: Number(message.trailingOffset),
      stopLoss: message.stopLoss != null ? Number(message.stopLoss) : undefined,
      takeProfit: message.takeProfit != null ? Number(message.takeProfit) : undefined,
      isAutomated: true
    };
    const res = await this.client.placeOrderStrategy(orderData);
    const strategyId = res?.orderStrategy?.id;
    let entryOrderId = null;
    let stopOrderId = null;
    let targetOrderId = null;

    if (strategyId) {
      try {
        const deps = await this.client.getOrderStrategyDependents(strategyId);
        if (Array.isArray(deps)) {
          for (const o of deps) {
            if (o.orderType === 'Stop' || o.orderType === 'StopLimit') stopOrderId = o.id;
            else if (o.orderType === 'Limit' && !entryOrderId && o.action === message.action) entryOrderId = o.id;
            else if (o.orderType === 'Limit') targetOrderId = o.id;
            else if (o.orderType === 'Market' && !entryOrderId) entryOrderId = o.id;
          }
        }
      } catch (err) {
        this.logger.warn(`[${this._label()}] getOrderStrategyDependents failed: ${err.message}`);
      }
    }

    return { orderId: strategyId, strategyId, entryOrderId, stopOrderId, targetOrderId };
  }

  /**
   * Cancel an order. Not part of the router contract — invoked internally when
   * higher layers need it (e.g. position-close flows). Left public for tests.
   */
  async cancelBySignalId(signalId) {
    // Reverse lookup orderSignalMap (orderId/strategyId → signalId)
    let strategyId = null;
    for (const [sid, signal] of this.orderSignalMap.entries()) {
      if (signal === signalId) { strategyId = sid; break; }
    }
    if (!strategyId) return { ok: false, reason: `no order found for signalId ${signalId}` };

    const strategy = this.orderStrategyMap.get(strategyId) || null;
    const result = await this.cancelOrder(strategyId);
    if (result?.ok) this._cleanupStrategy(strategyId);
    return { ...result, strategyId, signalId, strategy };
  }

  async cancelOrder(orderId) {
    if (!orderId) return { ok: false, reason: 'missing orderId' };
    // Capture context BEFORE deleting state so the event can carry strategy/symbol.
    const strategy = this.orderStrategyMap.get(orderId)
      || this.orderStrategyMap.get(String(orderId)) || null;
    const signalId = this.orderSignalMap.get(orderId)
      || this.orderSignalMap.get(String(orderId)) || null;
    try {
      await this.client.cancelOrder(orderId);
      this.orderSignalMap.delete(orderId);
      this.orderStrategyLinks.delete(orderId);
      await this.messageBus.publish(this.channels.ORDER_CANCELLED, {
        accountId: this.emittedAccountId, orderId,
        signalId, strategy,
        timestamp: new Date().toISOString(), source: 'cancel_order'
      });
      return { ok: true };
    } catch (err) {
      this.logger.error(`[${this._label()}] cancelOrder ${orderId} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Cancel every working order tied to a given symbol or contract on this
   * account. Used by EOD force-flat to remove orphan stops/targets after
   * the position itself has been closed via market order. Returns the
   * raw result from cancelAllOrdersForContract: { success, cancelledCount, failedOrders }.
   */
  async cancelAllOrdersForSymbol(symbolOrContractId) {
    if (!this.client) throw new Error(`${this._label()} not initialized`);
    let contractId = symbolOrContractId;
    if (typeof symbolOrContractId !== 'number') {
      const contract = await this.client.findContract(symbolOrContractId);
      if (!contract?.id) {
        return { success: false, error: `contract not found for ${symbolOrContractId}`, cancelledCount: 0 };
      }
      contractId = contract.id;
    }
    return this.client.cancelAllOrdersForContract(this.brokerAccountId, contractId);
  }

  async closePosition(symbolOrContractId) {
    if (!this.client) throw new Error(`${this._label()} not initialized`);
    if (typeof symbolOrContractId === 'number') {
      return this.client.liquidatePosition(this.brokerAccountId, symbolOrContractId);
    }
    const contract = await this.client.findContract(symbolOrContractId);
    if (!contract) throw new Error(`Contract not found for ${symbolOrContractId}`);
    return this.client.liquidatePosition(this.brokerAccountId, contract.id);
  }

  async modifyStop(strategyId, newStopPrice) {
    return this.client.modifyBracketStop(strategyId, newStopPrice);
  }

  /**
   * Modify the stop on the bracket order associated with the given signalId.
   * Mirrors cancelBySignalId — reverse-looks-up orderSignalMap to find the
   * strategyId, then defers to modifyStop().
   */
  async modifyStopBySignalId(signalId, newStopPrice, hint = {}) {
    if (!signalId) return { ok: false, reason: 'missing signalId' };
    if (!Number.isFinite(Number(newStopPrice))) return { ok: false, reason: 'invalid newStopPrice' };

    let strategyId = null;
    for (const [sid, sig] of this.orderSignalMap.entries()) {
      if (sig === signalId) { strategyId = sid; break; }
    }
    if (!strategyId) {
      return { ok: false, reason: `no order found for signalId ${signalId}` };
    }
    const strategy = this.orderStrategyMap.get(strategyId) || null;
    try {
      await this.modifyStop(strategyId, Number(newStopPrice));
      this.logger.info(`[${this._label()}] modify-stop ${signalId} → ${newStopPrice} (${hint.reason || 'no reason'})`);
      return { ok: true, strategyId, signalId, strategy, newStopPrice: Number(newStopPrice) };
    } catch (err) {
      this.logger.error(`[${this._label()}] modifyStopBySignalId ${signalId} failed: ${err.message}`);
      return { ok: false, reason: err.message, strategyId, signalId, strategy };
    }
  }

  /**
   * Flatten the position associated with the given signalId and cancel any
   * remaining bracket orders (SL/TP) for the same symbol. Used by the
   * orchestrator's exit-rule manager when a fibRetrace rule fires at bar
   * close — the trade is over, we want an immediate market exit and the
   * bracket orders cleaned up so they don't fire later as ghost orders.
   *
   * Returns { ok, signalId, strategy, symbol, closeResult, cancelResult }.
   * `ok` is true if the market liquidation succeeded; bracket-cancel
   * failures are logged but don't flip ok to false (the position is what
   * matters; orphan brackets get cleaned by EOD flatten if needed).
   */
  async closePositionBySignalId(signalId, hint = {}) {
    if (!signalId) return { ok: false, reason: 'missing signalId' };

    // Reverse-look up strategyId → symbol from the order map. Multiple
    // bracket legs share a signalId; we just need one to get the symbol.
    let strategyId = null;
    for (const [sid, sig] of this.orderSignalMap.entries()) {
      if (sig === signalId) { strategyId = sid; break; }
    }
    if (!strategyId) {
      return { ok: false, reason: `no order found for signalId ${signalId}` };
    }
    const strategy = this.orderStrategyMap.get(strategyId) || null;
    const symbol = hint.symbol || null;
    if (!symbol) {
      return { ok: false, reason: `symbol hint required to close by signalId`, strategyId, strategy };
    }

    let closeResult = null;
    let closeErr = null;
    try {
      closeResult = await this.closePosition(symbol);
      this.logger.info(`[${this._label()}] close-position ${signalId} ${symbol} ok (${hint.reason || 'no reason'})`);
    } catch (err) {
      closeErr = err;
      this.logger.error(`[${this._label()}] closePositionBySignalId ${signalId} ${symbol} liquidate failed: ${err.message}`);
    }

    let cancelResult = null;
    try {
      cancelResult = await this.cancelAllOrdersForSymbol(symbol);
    } catch (err) {
      this.logger.warn(`[${this._label()}] cancelAllOrdersForSymbol ${symbol} failed after close: ${err.message}`);
    }

    if (closeErr) {
      return { ok: false, reason: closeErr.message, strategyId, signalId, strategy, symbol, cancelResult };
    }
    return { ok: true, strategyId, signalId, strategy, symbol, closeResult, cancelResult };
  }

  async getPositions() {
    if (!this.client) return [];
    return this.client.getPositions(this.brokerAccountId);
  }

  // -------------------- Client event wiring --------------------

  _attachClientEvents() {
    const c = this.client;
    if (!c || typeof c.on !== 'function') {
      this.logger.warn(`[${this._label()}] client does not support .on() — no WS events will be relayed`);
      return;
    }

    c.on('orderUpdate', (payload) => this._onOrderUpdate(payload).catch(err =>
      this.logger.error(`[${this._label()}] orderUpdate handler: ${err.message}`)));

    c.on('executionUpdate', (payload) => this._onExecutionUpdate(payload).catch(err =>
      this.logger.error(`[${this._label()}] executionUpdate handler: ${err.message}`)));

    c.on('positionUpdate', (payload) => this._onPositionUpdate(payload).catch(err =>
      this.logger.error(`[${this._label()}] positionUpdate handler: ${err.message}`)));
  }

  async _onOrderUpdate(payload) {
    const order = payload?.entity || payload;
    if (!order || !order.id) return;

    const status = order.ordStatus || order.status;
    const signalId = this.orderSignalMap.get(order.id)
      || this.orderSignalMap.get(String(order.id)) || null;
    const strategy = this.orderStrategyMap.get(order.id)
      || this.orderStrategyMap.get(String(order.id)) || 'UNKNOWN';
    let symbol = this._resolveSymbol(order.contractId);
    if (!symbol && order.contractId) {
      try {
        const cd = await this.client.getContractDetails(order.contractId);
        symbol = cd?.name || null;
        if (symbol) this.contractCache.set(order.contractId, symbol);
      } catch { /* ignore */ }
    }

    const base = {
      signalId, accountId: this.emittedAccountId, strategy, symbol,
      orderId: order.id,
      brokerAccountId: this.brokerAccountId,
      action: order.action,
      orderType: order.orderType,
      price: order.price ?? null,
      quantity: order.orderQty,
      filledQuantity: order.cumQty || 0,
      timestamp: new Date().toISOString(),
      source: 'websocket_order_update'
    };

    if (status === 'Filled') {
      await this.messageBus.publish(this.channels.ORDER_FILLED, { ...base, fillPrice: order.avgPx ?? order.price ?? null });
    } else if (status === 'Rejected') {
      await this.messageBus.publish(this.channels.ORDER_REJECTED, { ...base, reason: order.rejectReason });
      this.orderSignalMap.delete(order.id);
      this.orderStrategyLinks.delete(order.id);
    } else if (status === 'Canceled' || status === 'Cancelled') {
      await this.messageBus.publish(this.channels.ORDER_CANCELLED, base);
      this.orderSignalMap.delete(order.id);
      this.orderStrategyLinks.delete(order.id);
    }
  }

  async _onExecutionUpdate(payload) {
    const execution = payload?.entity || payload;
    if (!execution) return;

    // Tradovate emits executionReports for every order state change (New,
    // Working, Canceled, Rejected, Filled...). Only real fills have execType
    // of 'Fill' or 'Trade' with a lastQty > 0 and a price. Everything else
    // is an ack we ignore — firing POSITION_OPENED on an ack is a bug.
    const execType = execution.execType || execution.xAction || null;
    const fillQty = Number(execution.lastQty || 0);
    const fillPrice = execution.price ?? execution.lastPrice ?? null;
    const isActualFill =
      (execType === 'Fill' || execType === 'Trade') ||
      (execType == null && fillQty > 0 && fillPrice != null);

    if (!isActualFill) {
      this.logger.debug?.(`[${this._label()}] executionReport ignored (execType=${execType}, lastQty=${fillQty}, price=${fillPrice})`);
      return;
    }

    const orderId = execution.orderId || execution.order?.id;
    const strategyId = execution.orderStrategyId || orderId;
    let signalId = this.orderSignalMap.get(orderId) || this.orderSignalMap.get(strategyId) || null;
    let strategy = this.orderStrategyMap.get(strategyId) || this.orderStrategyMap.get(orderId) || null;

    // Broker-side recovery on in-memory cache miss. ExecutionReport doesn't
    // carry `text` (verified live 2026-05-27 — see memory/tradovate-order-
    // tagging-fields.md), so we fetch OrderVersion.text directly. One HTTP
    // round-trip on miss only; rehydrates the maps for subsequent events.
    if (!strategy || strategy === 'UNKNOWN') {
      const recovered = await this._recoverFromOrderText(orderId);
      if (recovered.strategy) {
        strategy = recovered.strategy;
        signalId = signalId || recovered.signalId;
      }
    }
    if (!strategy) strategy = 'UNKNOWN';

    const symbol = this._resolveSymbol(execution.contractId);
    const links = this.orderStrategyLinks.get(strategyId);
    const isStopOrder = links && links.stopOrderId === orderId;
    const isTargetOrder = links && links.targetOrderId === orderId;
    const isEntry = links && links.entryOrderId === orderId;

    await this.messageBus.publish(this.channels.ORDER_FILLED, {
      signalId, accountId: this.emittedAccountId, strategy, symbol,
      orderId,
      strategyId,
      brokerAccountId: this.brokerAccountId,
      action: execution.action,
      fillPrice,
      quantity: fillQty || execution.cumQty || null,
      isStopOrder, isTargetOrder, isEntry,
      timestamp: new Date().toISOString(),
      source: 'websocket_execution'
    });

    // Entry fill → position opened. Structural stop resolution.
    if (isEntry || (!isStopOrder && !isTargetOrder)) {
      await this.messageBus.publish(this.channels.POSITION_OPENED, {
        signalId, accountId: this.emittedAccountId, strategy, symbol,
        strategyId,
        brokerAccountId: this.brokerAccountId,
        side: execution.action === 'Buy' ? 'long' : 'short',
        netPos: execution.lastQty ?? 1,
        entryPrice: execution.price ?? execution.lastPrice ?? null,
        stopLoss: links?.stopLoss ?? null,
        takeProfit: links?.takeProfit ?? null,
        timestamp: new Date().toISOString(),
        source: 'websocket_execution'
      });

      // Update TB tracking with real fill price and fill time
      if (this.tbTracking.has(strategyId)) {
        const tb = this.tbTracking.get(strategyId);
        tb.entryPrice = execution.price ?? tb.entryPrice;
        tb.filledAt = Date.now();
        this.logger.info(`[${this._label()}] TB tracking started for ${strategyId}: entry=${tb.entryPrice} direction=${tb.direction} rules=${tb.rules.length}`);
      }

      // Resolve structural stop
      const pending = this.pendingStructuralStops.get(strategyId);
      if (pending) {
        try {
          await this.client.modifyBracketStop(strategyId, pending.stopPrice);
          this.logger.info(`[${this._label()}] structural stop resolved ${strategyId} → ${pending.stopPrice}`);
        } catch (err) {
          this.logger.warn(`[${this._label()}] structural stop modify failed for ${strategyId}: ${err.message}`);
        }
        this.pendingStructuralStops.delete(strategyId);
      }
    }

    // Stop or target fill → position closed
    if (isStopOrder || isTargetOrder) {
      await this.messageBus.publish(this.channels.POSITION_CLOSED, {
        signalId, accountId: this.emittedAccountId, strategy, symbol,
        strategyId,
        brokerAccountId: this.brokerAccountId,
        exitPrice: execution.price ?? execution.lastPrice ?? null,
        reason: isStopOrder ? 'stop_hit' : 'target_hit',
        timestamp: new Date().toISOString(),
        source: 'websocket_execution'
      });
      this._cleanupStrategy(strategyId);
    }
  }

  async _onPositionUpdate(payload) {
    const position = payload?.entity || payload;
    if (!position) return;
    const symbol = this._resolveSymbol(position.contractId);

    if (!position.netPos) {
      await this.messageBus.publish(this.channels.POSITION_UPDATE, {
        accountId: this.emittedAccountId,
        brokerAccountId: this.brokerAccountId,
        strategy: null, // orchestrator knows from its own map
        symbol,
        side: 'flat',
        netPos: 0,
        timestamp: new Date().toISOString(),
        source: 'websocket_position_update'
      });
      return;
    }

    await this.messageBus.publish(this.channels.POSITION_UPDATE, {
      accountId: this.emittedAccountId,
      brokerAccountId: this.brokerAccountId,
      strategy: null,
      symbol,
      side: position.netPos > 0 ? 'long' : 'short',
      netPos: position.netPos,
      entryPrice: position.netPrice ?? position.avgPrice ?? null,
      timestamp: new Date().toISOString(),
      source: 'websocket_position_update'
    });
  }

  // -------------------- Time-based trailing stop management --------------------

  async _onPriceUpdate(msg) {
    if (this.tbTracking.size === 0) return;
    const symbol = msg?.symbol;
    const baseSymbol = msg?.baseSymbol;
    const price = msg?.close ?? msg?.price;
    if (!symbol || price == null) return;

    for (const [strategyId, tb] of this.tbTracking.entries()) {
      if (!tb.filledAt || !tb.entryPrice) continue;
      // Match by symbol or base symbol (NQ matches MNQ positions)
      const tbBase = (tb.symbol || '').replace(/[FGHJKMNQUVXZ]\d{1,2}$/i, '');
      const msgBase = baseSymbol || symbol.replace(/[FGHJKMNQUVXZ]\d{1,2}$/i, '');
      const MICRO_MAP = { NQ: 'MNQ', MNQ: 'NQ', ES: 'MES', MES: 'ES' };
      if (tbBase !== msgBase && tbBase !== MICRO_MAP[msgBase] && tb.symbol !== symbol) continue;

      const isLong = tb.direction === 'long';
      const mfe = isLong ? price - tb.entryPrice : tb.entryPrice - price;
      if (mfe > tb.mfe) tb.mfe = mfe;

      const minutesInTrade = (Date.now() - tb.filledAt) / 60000;

      for (const rule of tb.rules) {
        if (rule.triggered && rule.action !== 'trail') continue;
        if (minutesInTrade < rule.afterMinutes) continue;
        if (tb.mfe < rule.mfeThreshold) continue;

        if (rule.action === 'breakeven' && !rule.triggered) {
          const newStop = tb.entryPrice;
          try {
            await this.client.modifyBracketStop(strategyId, newStop);
            rule.triggered = true;
            tb.currentStop = newStop;
            this.logger.info(`[${this._label()}] TB breakeven: ${strategyId} stop → ${newStop} (${minutesInTrade.toFixed(0)}min, MFE=${tb.mfe.toFixed(1)}pts)`);
            this.deps.onTbStopModified?.({ strategyId, newStop, symbol: tb.symbol, direction: tb.direction, rule: 'breakeven', mfe: tb.mfe });
          } catch (err) {
            this.logger.warn(`[${this._label()}] TB breakeven modifyStop failed: ${err.message}`);
          }
        } else if (rule.action === 'trail') {
          const offset = rule.trailOffset || 10;
          const watermark = isLong ? tb.entryPrice + tb.mfe : tb.entryPrice - tb.mfe;
          const newStop = isLong ? watermark - offset : watermark + offset;
          // Only move stop if it's better than current
          const isBetter = isLong ? newStop > (tb.currentStop || 0) : newStop < (tb.currentStop || Infinity);
          if (isBetter) {
            try {
              await this.client.modifyBracketStop(strategyId, newStop);
              rule.triggered = true;
              tb.currentStop = newStop;
              this.logger.info(`[${this._label()}] TB trail: ${strategyId} stop → ${newStop} (${minutesInTrade.toFixed(0)}min, MFE=${tb.mfe.toFixed(1)}pts, watermark=${watermark})`);
              this.deps.onTbStopModified?.({ strategyId, newStop, symbol: tb.symbol, direction: tb.direction, rule: 'trail', mfe: tb.mfe });
            } catch (err) {
              this.logger.warn(`[${this._label()}] TB trail modifyStop failed: ${err.message}`);
            }
          }
        }
      }
    }
  }

  // -------------------- Reconciliation --------------------

  async _reconcileAndSnapshot(reason) {
    if (!this.client) return;

    // --- Working orders FIRST (positions use the side-map we build here) ---
    // Enriched=true so each order carries orderType/price/stopPrice from
    // /orderVersion/deps — without that, the bracket-child price scan below
    // can't classify Stop vs Limit children and TP/SL come through null.
    let workingOrders = [];
    try {
      const all = (await this.client.getOrders(this.brokerAccountId, true)) || [];
      workingOrders = all.filter(o => this._isActive(o.ordStatus || o.status));
    } catch (err) {
      this.logger.error(`[${this._label()}] reconcile getOrders failed: ${err.message}`);
    }

    // contractId → { strategy, signalId, stopLoss, takeProfit }
    // Built from enriched orders so the position loop can attribute by contract
    // without scanning maps. Survives the "orderStrategyMap is empty after the
    // process forgot a fill" failure mode that produced UNATTRIBUTED on
    // 2026-05-27.
    const strategyByContract = new Map();

    // contractId → { stopPrice, buyLimit, sellLimit }
    // TP/SL read straight off the live working bracket children. /order/placeOSO
    // does not return oso1Id/oso2Id synchronously so the in-memory links never
    // learn the bracket children's orderIds — every subsequent reconcile fails
    // the id-match and the recovery path creates fresh links with null TP/SL.
    // Pulling stopPrice/price off the working orders themselves bypasses that
    // bookkeeping gap and also picks up any later BE / stop modifications.
    const bracketByContract = new Map();

    const enrichedOrders = [];
    const seenStrategyIds = new Set();
    for (const o of workingOrders) {
      // Cache contract symbol if we can resolve it
      let symbol = this._resolveSymbol(o.contractId) || o.symbol;
      if (!symbol && o.contractId) {
        try {
          const cd = await this.client.getContractDetails(o.contractId);
          symbol = cd?.name || null;
          if (symbol) this.contractCache.set(o.contractId, symbol);
        } catch { /* ignore */ }
      }

      // Map this order back to a strategyId bundle by scanning persisted links.
      // Entry orders are their own strategyId in bracket orders.
      let strategyId = null;
      let role = 'unknown';
      for (const [sid, links] of this.orderStrategyLinks.entries()) {
        if (links.entryOrderId === o.id) { strategyId = sid; role = 'entry'; break; }
        if (links.stopOrderId === o.id)  { strategyId = sid; role = 'stop'; break; }
        if (links.targetOrderId === o.id){ strategyId = sid; role = 'target'; break; }
      }
      // If no links entry found but orderStrategyMap knows this id, treat as entry
      if (!strategyId && this.orderStrategyMap.has(String(o.id))) {
        strategyId = String(o.id);
        role = 'entry';
        // Create a minimal links entry so future cancel/modify works
        if (!this.orderStrategyLinks.has(strategyId)) {
          this.orderStrategyLinks.set(strategyId, {
            entryOrderId: o.id, stopOrderId: null, targetOrderId: null,
            isTrailing: false, timestamp: Date.now()
          });
        }
      }

      let strategy = strategyId ? this.orderStrategyMap.get(strategyId) || null : null;
      let signalId = strategyId ? this.orderSignalMap.get(strategyId) || null : null;

      // Broker-side recovery: when local maps don't know this order, fetch its
      // `text` from OrderVersion and decode the signalId. Tradovate stores the
      // tag indefinitely so this works across restarts, redeploys, and snapshot
      // races. One HTTP per unattributed order, only on the cache-miss path.
      if (!strategy) {
        const recovered = await this._recoverFromOrderText(o.id);
        if (recovered.strategy) {
          strategy = recovered.strategy;
          signalId = signalId || recovered.signalId;
          // Treat this order as entry-like for future links lookups
          if (!strategyId) {
            strategyId = String(o.id);
            role = 'entry';
            if (!this.orderStrategyLinks.has(strategyId)) {
              this.orderStrategyLinks.set(strategyId, {
                entryOrderId: o.id, stopOrderId: null, targetOrderId: null,
                isTrailing: false, timestamp: Date.now()
              });
            }
          }
        }
      }

      if (strategyId) seenStrategyIds.add(strategyId);

      // Populate the per-contract side-map for downstream position attribution.
      if (strategy && o.contractId && !strategyByContract.has(o.contractId)) {
        const links = strategyId ? this.orderStrategyLinks.get(strategyId) : null;
        strategyByContract.set(o.contractId, {
          strategy,
          signalId,
          stopLoss: links?.stopLoss ?? null,
          takeProfit: links?.takeProfit ?? null,
        });
      }

      // Stash live bracket-child prices per contract. The position loop will
      // pick the correct Limit side based on position direction.
      if (o.contractId) {
        const entry = bracketByContract.get(o.contractId) || { stopPrice: null, buyLimit: null, sellLimit: null };
        if ((o.orderType === 'Stop' || o.orderType === 'StopLimit') && o.stopPrice != null) {
          entry.stopPrice = Number(o.stopPrice);
        } else if (o.orderType === 'Limit' && o.price != null) {
          if (o.action === 'Buy') entry.buyLimit = Number(o.price);
          else if (o.action === 'Sell') entry.sellLimit = Number(o.price);
        }
        bracketByContract.set(o.contractId, entry);
      }

      enrichedOrders.push({
        orderId: o.id,
        strategyId,
        role,
        strategy,
        signalId,
        contractId: o.contractId,
        symbol,
        action: o.action,
        orderType: o.orderType,
        price: o.price ?? null,
        stopPrice: o.stopPrice ?? null,
        orderQty: o.orderQty,
        status: o.ordStatus || o.status
      });
    }

    // --- Positions (attributed from strategyByContract first, then local maps) ---
    let positions = [];
    try {
      positions = await this.client.getPositions(this.brokerAccountId);
    } catch (err) {
      this.logger.error(`[${this._label()}] reconcile getPositions failed: ${err.message}`);
    }

    const enrichedPositions = [];
    for (const p of (positions || [])) {
      const symbol = this._resolveSymbol(p.contractId) || p.symbol;
      const netPos = p.netPos ?? 0;
      if (!symbol) continue;

      // Cache contract symbol for later resolution
      if (p.contractId && !this.contractCache.has(p.contractId)) {
        this.contractCache.set(p.contractId, symbol);
      }

      let strategy = null;
      let signalId = null;
      let stopLoss = null;
      let takeProfit = null;

      // Primary: side-map populated from this snapshot's working orders.
      const side = strategyByContract.get(p.contractId);
      if (side) {
        strategy = side.strategy;
        signalId = side.signalId;
        stopLoss = side.stopLoss;
        takeProfit = side.takeProfit;
      }

      // Fallback: legacy local-links scan (preserves prior behaviour when no
      // working bracket children exist — e.g. simple non-bracket positions).
      if (!strategy) {
        for (const [sid, links] of this.orderStrategyLinks.entries()) {
          if (this.contractCache.get(p.contractId) === symbol || links.entryOrderId) {
            strategy = this.orderStrategyMap.get(sid) || strategy;
            signalId = signalId || this.orderSignalMap.get(sid) || null;
            stopLoss = links.stopLoss ?? stopLoss;
            takeProfit = links.takeProfit ?? takeProfit;
            if (strategy) break;
          }
        }
      }

      // Authoritative TP/SL from live working bracket children for this contract.
      // Overrides the link-derived values because the working order reflects any
      // BE / stop modifications, and because placeOSO doesn't return bracket child
      // ids so the links values for in-flight bracket positions are routinely null.
      const live = bracketByContract.get(p.contractId);
      if (live) {
        if (live.stopPrice != null) stopLoss = live.stopPrice;
        // Bracket target is opposite-action to entry. netPos > 0 → long entry
        // (Buy), so target = Sell Limit. netPos < 0 → short entry, target = Buy Limit.
        if (netPos > 0 && live.sellLimit != null) takeProfit = live.sellLimit;
        else if (netPos < 0 && live.buyLimit != null) takeProfit = live.buyLimit;
      }

      enrichedPositions.push({
        contractId: p.contractId,
        symbol,
        netPos,
        entryPrice: p.netPrice ?? p.avgPrice ?? null,
        strategy,
        signalId,
        stopLoss,
        takeProfit
      });
    }

    // --- Emit snapshots ---
    const ts = new Date().toISOString();
    await this.messageBus.publish(this.channels.POSITION_SNAPSHOT, {
      accountId: this.emittedAccountId,
      brokerAccountId: this.brokerAccountId,
      positions: enrichedPositions,
      reason,
      timestamp: ts
    });

    await this.messageBus.publish(this.channels.ORDERS_SNAPSHOT, {
      accountId: this.emittedAccountId,
      brokerAccountId: this.brokerAccountId,
      orders: enrichedOrders,
      reason,
      timestamp: ts
    });

    // Sweep expired structural stops
    this._sweepExpired(this.pendingStructuralStops, PENDING_STRUCTURAL_STOP_TTL_MS, 'timestamp');

    // Persist any new/refreshed links
    await this._saveOrderMappings();

    this.logger.info(`[${this._label()}] reconcile (${reason}): ${enrichedPositions.length} positions, ${enrichedOrders.length} working orders`);
  }

  _isActive(status) {
    return ['Working', 'Pending', 'PendingNew', 'Suspended', 'PendingReplace', 'PendingCancel'].includes(status);
  }

  _findStrategyForContract(contractId) {
    if (!contractId) return null;
    for (const [sid, links] of this.orderStrategyLinks.entries()) {
      if (links.entryOrderId && this.contractCache.has(contractId)) {
        return this.orderStrategyMap.get(sid) || null;
      }
    }
    return null;
  }

  // -------------------- Persistence --------------------

  _orderMappingsKey() {
    return `${ORDER_MAPPINGS_PREFIX}${this.account.id}:order:mappings`;
  }

  _orderStrategyMapLegacyKey() {
    // Old v2.0 format — strategy-only. Read for backward compat only.
    return `${ORDER_STRATEGY_MAP_PREFIX}${this.account.id}:order:strategy:mappings`;
  }

  /**
   * Persist everything needed to resume managing an order after restart:
   *   strategyId → { strategy, signalId, entryOrderId, stopOrderId, targetOrderId, isTrailing }
   */
  async _saveOrderMappings() {
    if (!this.redis) return;
    try {
      const orders = {};
      const ids = new Set([
        ...this.orderStrategyMap.keys(),
        ...this.orderSignalMap.keys(),
        ...this.orderStrategyLinks.keys()
      ]);
      for (const strategyId of ids) {
        const links = this.orderStrategyLinks.get(strategyId) || {};
        orders[strategyId] = {
          strategy: this.orderStrategyMap.get(strategyId) || null,
          signalId: this.orderSignalMap.get(strategyId) || null,
          entryOrderId: links.entryOrderId ?? null,
          stopOrderId: links.stopOrderId ?? null,
          targetOrderId: links.targetOrderId ?? null,
          isTrailing: !!links.isTrailing
        };
      }
      await this.redis.set(this._orderMappingsKey(), JSON.stringify({
        timestamp: new Date().toISOString(),
        version: '3.0',
        orders
      }));
    } catch (err) {
      this.logger.warn(`[${this._label()}] persist order mappings failed: ${err.message}`);
    }
  }

  async _loadOrderMappings() {
    if (!this.redis) return;

    // Preferred: v3.0 mappings
    try {
      const raw = await this.redis.get(this._orderMappingsKey());
      if (raw) {
        const data = JSON.parse(raw);
        if (data?.orders) {
          let count = 0;
          for (const [strategyId, m] of Object.entries(data.orders)) {
            if (m.strategy) this.orderStrategyMap.set(strategyId, m.strategy);
            if (m.signalId) this.orderSignalMap.set(strategyId, m.signalId);
            if (m.entryOrderId || m.stopOrderId || m.targetOrderId) {
              this.orderStrategyLinks.set(strategyId, {
                entryOrderId: m.entryOrderId,
                stopOrderId: m.stopOrderId,
                targetOrderId: m.targetOrderId,
                isTrailing: !!m.isTrailing,
                timestamp: Date.now()
              });
            }
            count++;
          }
          this.logger.info(`[${this._label()}] loaded ${count} order mappings from Redis (v3.0)`);
          return;
        }
      }
    } catch (err) {
      this.logger.warn(`[${this._label()}] load order mappings (v3.0) failed: ${err.message}`);
    }

    // Fallback: v2.0 legacy — strategy-only map
    try {
      const raw = await this.redis.get(this._orderStrategyMapLegacyKey());
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.mappings) {
        for (const [k, v] of Object.entries(data.mappings)) this.orderStrategyMap.set(k, v);
        this.logger.info(`[${this._label()}] loaded ${this.orderStrategyMap.size} order-strategy mappings from Redis (v2.0 legacy — no signalId recovery)`);
      }
    } catch (err) {
      this.logger.warn(`[${this._label()}] load order-strategy map (legacy) failed: ${err.message}`);
    }
  }

  // -------------------- Helpers --------------------

  _label() { return `TV:${this.account.id}`; }

  _resolveSymbol(contractId) {
    if (!contractId) return null;
    return this.contractCache.get(contractId) || null;
  }

  _cleanupStrategy(strategyId) {
    this.orderSignalMap.delete(strategyId);
    this.orderStrategyLinks.delete(strategyId);
    this.strategyChildMap.delete(strategyId);
    this.pendingStructuralStops.delete(strategyId);
    this.tbTracking.delete(strategyId);
    // Keep orderStrategyMap entry for historical attribution; sweep periodically if it grows.
  }

  _sweepExpired(map, ttlMs, tsField) {
    const now = Date.now();
    for (const [k, v] of map.entries()) {
      const ts = typeof v?.[tsField] === 'number' ? v[tsField] : (v?.[tsField] ? new Date(v[tsField]).getTime() : 0);
      if (ts && (now - ts) > ttlMs) map.delete(k);
    }
  }

  /**
   * Build the broker-side tag string (used for `text` and `clOrdId`) from
   * the order request. We use `signalId` directly since it already encodes
   * strategy, direction, price, and timestamp — `${strategy}-${direction}-
   * ${price}-${ts}` per trade-orchestrator/index.js:138. Returns null when
   * there's no signalId or it's too long for the 64-char broker field.
   */
  _buildOrderTag(message) {
    const sid = message?.signalId;
    if (!sid || typeof sid !== 'string') return null;
    if (sid.length > 60) {
      // 60 not 64 — bracket children append ".sl"/".tp" (+3 chars). Leave headroom.
      this.logger.warn?.(`[${this._label()}] signalId too long (${sid.length}>60) for broker text/clOrdId — skipping tag`);
      return null;
    }
    return sid;
  }

  /**
   * Decode the orchestrator-generated signalId shape `${strategy}-${direction}
   * -${price}-${ts}` back into its parts. Returns {strategy, signalId} so a
   * caller can attribute a position/order without local state.
   *
   * Bracket-child clOrdIds are signalId + ".sl" / ".tp" — strip those before
   * decoding. Anything that doesn't match the pattern still returns the raw
   * text as signalId so callers can store it; strategy stays null.
   */
  _parseStrategyFromText(text) {
    if (!text || typeof text !== 'string') return { strategy: null, signalId: null };
    const trimmed = text.replace(/\.(sl|tp|flat)$/, '');
    const m = trimmed.match(/^(.+?)-(long|short)-([\d.]+)-(\d+)$/);
    if (m) return { strategy: m[1], signalId: trimmed };
    return { strategy: null, signalId: trimmed };
  }

  /**
   * Lazy attribution recovery. When the in-memory orderStrategyMap misses,
   * fetch `OrderVersion.text` for the order, decode strategy/signalId, and
   * rehydrate the in-memory maps so subsequent lookups are free. Returns
   * {strategy, signalId} or {strategy: null, signalId: null} on failure.
   *
   * Cheap on cache hit (no HTTP). One HTTP round-trip on miss; lossless
   * server-side source of truth.
   */
  async _recoverFromOrderText(orderId) {
    if (!orderId || !this.client?.getOrderVersions) return { strategy: null, signalId: null };
    // Fast path: already attributed in-memory.
    const cachedStrategy = this.orderStrategyMap.get(orderId) || this.orderStrategyMap.get(String(orderId));
    const cachedSignal = this.orderSignalMap.get(orderId) || this.orderSignalMap.get(String(orderId));
    if (cachedStrategy && cachedStrategy !== 'UNKNOWN') {
      return { strategy: cachedStrategy, signalId: cachedSignal || null };
    }
    try {
      const versions = await this.client.getOrderVersions(orderId);
      // Most recent first — text is set at place and immutable on the version row.
      for (const v of (versions || [])) {
        if (v?.text) {
          const parsed = this._parseStrategyFromText(v.text);
          if (parsed.strategy) {
            // Rehydrate the in-memory maps so future lookups skip the HTTP fetch.
            this.orderStrategyMap.set(orderId, parsed.strategy);
            if (parsed.signalId) this.orderSignalMap.set(orderId, parsed.signalId);
            this.logger.info(`[${this._label()}] attribution recovered for order ${orderId}: strategy=${parsed.strategy} signalId=${parsed.signalId}`);
            return parsed;
          }
        }
      }
    } catch (err) {
      this.logger.warn?.(`[${this._label()}] _recoverFromOrderText(${orderId}) failed: ${err.message}`);
    }
    return { strategy: null, signalId: null };
  }

  async _rejectLocally(signalId, strategy, reason, extra = {}) {
    this.logger.warn(`[${this._label()}] reject [${signalId || '?'} / ${strategy}]: ${reason}`);
    await this.messageBus.publish(this.channels.ORDER_REJECTED, {
      signalId, accountId: this.emittedAccountId, strategy,
      reason,
      ...extra,
      timestamp: new Date().toISOString(),
      source: 'connector_local_reject'
    });
    return { dispatched: false, reason };
  }
}

registerConnector(TradovateConnector);

export default TradovateConnector;
