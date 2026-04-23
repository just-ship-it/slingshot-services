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

  async _placeSimple(message, contract) {
    const orderData = {
      accountId: this.brokerAccountId,
      contractId: Number(contract.id),
      symbol: contract.name || message.symbol,
      action: message.action,
      orderQty: Number(message.quantity || 1),
      orderType: message.orderType,
      price: message.orderType === 'Limit' ? Number(message.price) : undefined,
      isAutomated: true
    };
    const res = await this.client.placeOrder(orderData);
    return { orderId: res.orderId, strategyId: res.orderId, entryOrderId: res.orderId };
  }

  async _placeBracket(message, contract) {
    const action = message.action;
    const oppositeAction = action === 'Buy' ? 'Sell' : 'Buy';
    const orderData = {
      accountId: this.brokerAccountId,
      contractId: Number(contract.id),
      symbol: contract.name || message.symbol,
      action,
      orderQty: Number(message.quantity || 1),
      orderType: message.orderType,
      price: message.orderType === 'Limit' ? Number(message.price) : undefined,
      isAutomated: true,
      bracket1: message.stopLoss != null ? {
        action: oppositeAction, orderType: 'Stop', stopPrice: Number(message.stopLoss)
      } : undefined,
      bracket2: message.takeProfit != null ? {
        action: oppositeAction, orderType: 'Limit', price: Number(message.takeProfit)
      } : undefined
    };
    const res = await this.client.placeBracketOrder(orderData);
    return {
      orderId: res.orderId,
      strategyId: res.orderId,
      entryOrderId: res.orderId,
      stopOrderId: res.bracket1OrderId || null,
      targetOrderId: res.bracket2OrderId || null
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
    const signalId = this.orderSignalMap.get(orderId) || this.orderSignalMap.get(strategyId) || null;
    const strategy = this.orderStrategyMap.get(strategyId) || this.orderStrategyMap.get(orderId) || 'UNKNOWN';
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

    // --- Positions ---
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

      // Attribute strategy + SL/TP via persisted links
      let strategy = null;
      let stopLoss = null;
      let takeProfit = null;
      for (const [sid, links] of this.orderStrategyLinks.entries()) {
        if (this.contractCache.get(p.contractId) === symbol || links.entryOrderId) {
          strategy = this.orderStrategyMap.get(sid) || strategy;
          stopLoss = links.stopLoss ?? stopLoss;
          takeProfit = links.takeProfit ?? takeProfit;
          if (strategy) break;
        }
      }

      enrichedPositions.push({
        contractId: p.contractId,
        symbol,
        netPos,
        entryPrice: p.netPrice ?? p.avgPrice ?? null,
        strategy,
        stopLoss,
        takeProfit
      });
    }

    // --- Working orders ---
    let workingOrders = [];
    try {
      const all = (await this.client.getOrders(this.brokerAccountId, false)) || [];
      workingOrders = all.filter(o => this._isActive(o.ordStatus || o.status));
    } catch (err) {
      this.logger.error(`[${this._label()}] reconcile getOrders failed: ${err.message}`);
    }

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

      const strategy = strategyId ? this.orderStrategyMap.get(strategyId) || null : null;
      const signalId = strategyId ? this.orderSignalMap.get(strategyId) || null : null;

      if (strategyId) seenStrategyIds.add(strategyId);

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
