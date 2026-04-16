/**
 * PickMyTradeConnector
 *
 * Per-account adapter for PickMyTrade. Wraps the existing PMT webhook
 * logic and conforms to the BaseConnector interface.
 *
 * Tracking-via-shadow-account (e.g. mirroring orders to a Tradovate demo
 * account so the dashboard can see PMT positions) is an internal detail
 * of this connector, not visible to the router or routing config.
 */

import { BaseConnector } from './base-connector.js';
import { registerConnector } from './registry.js';

const ROOT_SYMBOLS = ['MNQ', 'MES', 'M2K', 'MYM', 'NQ', 'ES', 'RTY', 'YM'];
const FETCH_TIMEOUT_MS = 5000;

export class PickMyTradeConnector extends BaseConnector {
  constructor(account, logger, deps = {}) {
    super(account, logger, deps);

    const config = account.config || {};
    const credentials = account.credentials || {};

    this.webhookUrl = config.webhookUrl || credentials.webhookUrl;
    this.token = credentials.token;
    this.pmtAccountId = config.pmtAccountId || null;
    this.tracking = account.tracking || account.config?.tracking || null;
    this.fetchImpl = deps.fetch || globalThis.fetch;
  }

  static brokerKey() { return 'pickmytrade'; }
  static displayName() { return 'PickMyTrade'; }

  static credentialSchema() {
    return {
      configFields: [
        { key: 'webhookUrl', label: 'Webhook URL', type: 'text', required: true,
          placeholder: 'https://app.pickmytrade.io/webhook/...' },
        { key: 'pmtAccountId', label: 'PMT Account ID', type: 'text', required: false,
          help: 'Optional override sent to PMT as account_id' }
      ],
      fields: [
        { key: 'token', label: 'API Token', type: 'password', sensitive: true, required: true }
      ],
      tracking: {
        supports: true,
        label: 'Mirror positions to (for visibility only)',
        help: 'Optionally place each order on another account too so positions appear in the dashboard. The mirror account is not used for execution.',
        options: ['none', 'tradovate-demo']
      }
    };
  }

  async init() {
    if (!this.webhookUrl) throw new Error(`PMT account ${this.account.id}: webhookUrl missing`);
    if (!this.token) throw new Error(`PMT account ${this.account.id}: token missing`);

    // Shadow tracking is REQUIRED. PMT is fire-and-forget with no fill stream,
    // so we mirror every order to a paired Tradovate demo account and use its
    // fills as the source of truth for positions attributed to THIS PMT id.
    const shadowId = this.tracking?.via;
    if (!shadowId) {
      throw new Error(`PMT account ${this.account.id}: tracking.via is required (the id of a Tradovate demo account used for shadow tracking)`);
    }
    if (!this.deps.accountStore) {
      throw new Error(`PMT account ${this.account.id}: deps.accountStore is required to resolve shadow account`);
    }
    if (!this.deps.ClientClass) {
      throw new Error(`PMT account ${this.account.id}: deps.ClientClass (TradovateClient) is required for shadow`);
    }

    const { TradovateConnector } = await import('./tradovate-connector.js');

    const shadowRecord = await this.deps.accountStore.getDecrypted(shadowId);
    if (!shadowRecord) {
      throw new Error(`PMT account ${this.account.id}: shadow account '${shadowId}' not found`);
    }
    if (shadowRecord.broker !== 'tradovate') {
      throw new Error(`PMT account ${this.account.id}: shadow account '${shadowId}' must be broker=tradovate`);
    }
    if (shadowRecord.config?.mode !== 'demo') {
      this.logger.warn(`[${this._label()}] shadow account ${shadowId} is not mode=demo — are you sure?`);
    }

    this.shadow = new TradovateConnector(shadowRecord, this.logger, {
      ClientClass: this.deps.ClientClass,
      messageBus: this.deps.messageBus,
      channels: this.deps.channels,
      redis: this.deps.redis,
      // Every event the shadow publishes will be stamped with this.account.id
      // instead of the shadow's own id. To the orchestrator and dashboard,
      // fills look like they belong to the PMT account.
      accountIdOverride: this.account.id
    });

    await this.shadow.init();
    this.ready = true;
    this.logger.info(`[${this._label()}] initialized → webhook=${this.webhookUrl}, shadow=${shadowId} (broker ${shadowRecord.config?.accountId})`);
  }

  async shutdown() {
    if (this.shadow) {
      try { await this.shadow.shutdown(); }
      catch (err) { this.logger.warn(`[${this._label()}] shadow shutdown error: ${err.message}`); }
      this.shadow = null;
    }
    this.ready = false;
  }

  _label() { return `PMT:${this.account.id}`; }

  async testConnection() {
    if (!this.webhookUrl || !this.token) {
      return { ok: false, error: 'Missing webhookUrl or token' };
    }
    const results = { webhook: null, shadow: null };

    // Test webhook endpoint is reachable (HEAD request, no order placed)
    const fetchImpl = this.fetchImpl;
    if (fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const resp = await fetchImpl(this.webhookUrl, {
          method: 'HEAD',
          signal: controller.signal
        });
        results.webhook = { ok: resp.ok, status: resp.status };
      } catch (err) {
        const msg = err.name === 'AbortError' ? `Timed out (${FETCH_TIMEOUT_MS}ms)` : err.message;
        results.webhook = { ok: false, error: msg };
      } finally {
        clearTimeout(timer);
      }
    }

    // Test shadow Tradovate demo connection
    if (this.shadow) {
      results.shadow = await this.shadow.testConnection();
    }

    return {
      ok: (results.webhook?.ok !== false) && (results.shadow?.ok !== false),
      ...results
    };
  }

  // ---- Order operations ----

  /**
   * Router entry point. The orchestrator emits `order.request` with { action: 'Buy'|'Sell',
   * orderType: 'Limit'|'Market', price, stopLoss, takeProfit, accountId, strategy, signalId, ... }.
   * PMT is fire-and-forget; we translate to its webhook shape and POST.
   */
  async handleOrderRequest(message) {
    const signalId = message.signalId;
    const strategy = message.strategy || 'UNKNOWN';
    const symbol = message.symbol;

    if (!symbol || !message.action) {
      await this._publishReject(signalId, strategy, 'missing symbol or action');
      return { dispatched: false, reason: 'invalid payload' };
    }

    const pmtOrder = {
      action: message.action === 'Buy' ? 'buy' : 'sell',
      symbol,
      quantity: message.quantity,
      orderType: message.orderType,
      price: message.price,
      stopPrice: message.stopLoss ?? null,
      stop_loss: message.stopLoss ?? null,
      takeProfit: message.takeProfit ?? null,
      take_profit: message.takeProfit ?? null,
      trailingTrigger: message.trailingTrigger ?? null,
      trailingOffset: message.trailingOffset ?? null,
      strategy
    };

    const result = await this.placeOrder(pmtOrder);

    if (result?.success) {
      await this._publish(this.deps.channels?.ORDER_PLACED || 'order.placed', {
        signalId, accountId: this.account.id, strategy, symbol,
        orderId: signalId,
        action: message.action,
        orderType: message.orderType,
        price: message.price ?? null,
        stopPrice: message.stopLoss ?? null,
        takeProfit: message.takeProfit ?? null,
        quantity: message.quantity,
        source: 'pmt_webhook_ack',
        timestamp: new Date().toISOString()
      });

      // Mirror the SAME order to the shadow Tradovate demo account. The shadow
      // is what gives us fills, positions, and pending-order lifecycle for
      // this PMT account. Its events emit stamped with this.account.id.
      try {
        await this.shadow.handleOrderRequest(message);
      } catch (err) {
        this.logger.error(`[${this._label()}] shadow mirror failed: ${err.message}`);
        await this._publishReject(signalId, strategy, `shadow mirror failed: ${err.message}`);
        return { dispatched: false, reason: 'shadow_failed' };
      }

      return { dispatched: true, signalId };
    }

    await this._publishReject(signalId, strategy, result?.error || `PMT rejected: ${result?.status}`);
    return { dispatched: false, reason: result?.error || 'pmt_failed' };
  }

  async placeOrder(order) {
    const payload = this._buildOrderPayload(order);
    const result = await this._send(payload, `ORDER ${order.action} ${order.symbol} [${order.strategy || 'unknown'}]`);
    await this._mirror('placeOrder', order);
    return result;
  }

  async _publish(channel, payload) {
    if (this.deps.messageBus && channel) {
      try { await this.deps.messageBus.publish(channel, payload); } catch (err) {
        this.logger.warn(`[PMT:${this.account.id}] publish ${channel} failed: ${err.message}`);
      }
    }
  }

  async _publishReject(signalId, strategy, reason) {
    await this._publish(this.deps.channels?.ORDER_REJECTED || 'order.rejected', {
      signalId, accountId: this.account.id, strategy, reason,
      source: 'pmt_connector',
      timestamp: new Date().toISOString()
    });
  }

  async cancelOrder(orderId) {
    this.logger.info(`[PMT:${this.account.id}] cancelOrder ${orderId} — no PMT equivalent, skipping`);
    return { skipped: true, reason: 'PMT does not support cancel by orderId; use cancelBySignalId with a symbol' };
  }

  /**
   * Cancel / close anything associated with this signal. Hits the PMT webhook
   * with data='close' (prop firms accept this as close+cancel) and cancels the
   * corresponding order on the shadow Tradovate account.
   */
  async cancelBySignalId(signalId, hint = {}) {
    const ts = new Date().toISOString();
    const symbol = hint.symbol || null;

    // 1) Send 'close' to PMT webhook. PMT uses this for both cancel-pending
    //    and close-open-position on prop-firm accounts.
    let pmtResult = { skipped: true, reason: 'no symbol hint provided' };
    if (symbol) {
      const payload = {
        symbol: this._extractRoot(symbol),
        data: 'close',
        quantity: 0,
        price: 0,
        token: this.token
      };
      if (this.pmtAccountId) payload.account_id = this.pmtAccountId;
      pmtResult = await this._send(payload, `CLOSE/CANCEL ${symbol} [signal ${signalId}]`);
    }

    // 2) Cancel on the shadow account so the tracking Tradovate order is killed too.
    let shadowResult = { skipped: true, reason: 'no shadow' };
    if (this.shadow) {
      shadowResult = await this.shadow.cancelBySignalId(signalId);
    }

    // Pull strategy from shadow if it resolved (signalId → strategyId → strategy)
    const strategy = shadowResult?.strategy || hint.strategy || null;

    await this._publish(this.deps.channels?.ORDER_CANCELLED || 'order.cancelled', {
      signalId, accountId: this.account.id,
      symbol, strategy,
      source: 'pmt_cancel_by_signal',
      timestamp: ts
    });

    return { pmt: pmtResult, shadow: shadowResult };
  }

  async modifyStop(_orderId, newStopPrice, hint = {}) {
    const payload = {
      symbol: this._extractRoot(hint.symbol),
      data: hint.side || 'buy',
      quantity: hint.quantity || 1,
      update_sl: true,
      sl: newStopPrice || 0,
      token: this.token
    };
    if (this.pmtAccountId) payload.account_id = this.pmtAccountId;
    const result = await this._send(payload, `MODIFY STOP ${hint.symbol} → ${newStopPrice}`);
    await this._mirror('modifyStop', { orderId: _orderId, newStopPrice, hint });
    return result;
  }

  async closePosition(symbol) {
    const payload = {
      symbol: this._extractRoot(symbol),
      data: 'close',
      quantity: 0,
      price: 0,
      token: this.token
    };
    if (this.pmtAccountId) payload.account_id = this.pmtAccountId;
    const result = await this._send(payload, `CLOSE ${symbol}`);
    await this._mirror('closePosition', symbol);
    return result;
  }

  async getPositions() {
    return [];
  }

  // ---- Internals ----

  _extractRoot(symbol) {
    if (!symbol) return symbol;
    const upper = symbol.toUpperCase();
    for (const root of ROOT_SYMBOLS) {
      if (upper.startsWith(root) && upper.length > root.length) return root;
    }
    return upper;
  }

  _buildOrderPayload(order) {
    const isMarket = order.orderType === 'Market' || order.orderType === 'MKT';
    const payload = {
      symbol: this._extractRoot(order.symbol),
      data: (order.action || 'buy').toLowerCase(),
      quantity: order.quantity || 1,
      price: isMarket ? 0 : (order.price || 0),
      order_type: isMarket ? 'MKT' : 'LMT',
      sl: order.stopPrice || order.stop_loss || 0,
      tp: order.takeProfit || order.take_profit || 0,
      token: this.token
    };
    if (this.pmtAccountId) payload.account_id = this.pmtAccountId;
    if (order.trailingTrigger || order.trailingOffset) {
      payload.trail = 1;
      payload.trail_trigger = order.trailingTrigger || 0;
      payload.trail_stop = order.trailingOffset || 0;
    }
    return payload;
  }

  async _send(payload, context) {
    const fetchImpl = this.fetchImpl;
    if (!fetchImpl) {
      const err = 'No fetch implementation available';
      this.logger.error(`[PMT:${this.account.id}] ${context} FAILED: ${err}`);
      return { success: false, error: err };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      this.logger.info(`[PMT:${this.account.id}] Sending ${context} → ${JSON.stringify(payload)}`);
      const response = await fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const text = await response.text();
      if (response.ok) {
        this.logger.info(`[PMT:${this.account.id}] ${context} — ${response.status} OK`);
      } else {
        this.logger.warn(`[PMT:${this.account.id}] ${context} — ${response.status}: ${text}`);
      }
      return { success: response.ok, status: response.status, body: text };
    } catch (err) {
      const msg = err.name === 'AbortError' ? `Request timed out (${FETCH_TIMEOUT_MS}ms)` : err.message;
      this.logger.error(`[PMT:${this.account.id}] ${context} FAILED: ${msg}`);
      return { success: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async _mirror(method, arg) {
    if (!this.tracking?.via) return;
    const mirror = this.deps.connectorLookup?.(this.tracking.via);
    if (!mirror) return;
    try {
      const fn = mirror[method];
      if (typeof fn === 'function') {
        await fn.call(mirror, arg);
      }
    } catch (err) {
      this.logger.warn(`[PMT:${this.account.id}] mirror ${method} via ${this.tracking.via} failed: ${err.message}`);
    }
  }
}

registerConnector(PickMyTradeConnector);

export default PickMyTradeConnector;
