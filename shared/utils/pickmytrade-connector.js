/**
 * PickMyTrade Connector
 *
 * Transforms Slingshot order requests into PickMyTrade webhook format
 * and POSTs them to the PMT API. Fire-and-forget — no position tracking
 * or fill callbacks. PMT manages the broker connection on their side.
 */

// Known futures root symbols, ordered longest-first so MNQ matches before NQ
const ROOT_SYMBOLS = ['MNQ', 'MES', 'M2K', 'MYM', 'NQ', 'ES', 'RTY', 'YM'];

export class PickMyTradeConnector {
  constructor(config, logger) {
    this.webhookUrl = config.webhookUrl;
    this.token = config.token;
    this.accountId = config.accountId || null;
    this.logger = logger;

    // Validate required config
    if (!this.webhookUrl || !this.token) {
      throw new Error('PickMyTrade connector requires webhookUrl and token');
    }

    this.logger.info(`[PMT] Connector initialized — URL: ${this.webhookUrl}`);
  }

  /**
   * Extract root symbol from full contract symbol.
   * "MNQM6" → "MNQ", "NQM6" → "NQ", "MESM6" → "MES"
   */
  extractRootSymbol(symbol) {
    if (!symbol) return symbol;
    const upper = symbol.toUpperCase();
    for (const root of ROOT_SYMBOLS) {
      if (upper.startsWith(root) && upper.length > root.length) {
        return root;
      }
    }
    return upper;
  }

  /**
   * Map Slingshot action ("Buy"/"Sell") to PMT data field ("buy"/"sell")
   */
  mapAction(action) {
    if (!action) return 'buy';
    const lower = action.toLowerCase();
    if (lower === 'buy' || lower === 'sell') return lower;
    return lower;
  }

  /**
   * Handle ORDER_REQUEST messages (new entries from trade-orchestrator).
   *
   * Message shape: { symbol, action, quantity, orderType, price, stopPrice,
   *   takeProfit, trailingTrigger, trailingOffset, strategy, signalId, ... }
   */
  async handleOrderRequest(message) {
    const pmtPayload = {
      symbol: this.extractRootSymbol(message.symbol),
      data: this.mapAction(message.action),
      quantity: message.quantity || 1,
      price: message.orderType === 'Market' ? 0 : (message.price || 0),
      order_type: message.orderType === 'Market' ? 'MKT' : 'LMT',
      sl: message.stopPrice || 0,
      tp: message.takeProfit || 0,
      token: this.token,
    };

    // Add account_id if configured
    if (this.accountId) {
      pmtPayload.account_id = this.accountId;
    }

    // Trailing stop
    if (message.trailingTrigger || message.trailingOffset) {
      pmtPayload.trail = 1;
      pmtPayload.trail_trigger = message.trailingTrigger || 0;
      pmtPayload.trail_stop = message.trailingOffset || 0;
    }

    return this.sendWebhook(pmtPayload, `ORDER ${message.action} ${message.symbol} [${message.strategy}]`);
  }

  /**
   * Handle WEBHOOK_TRADE messages (management actions from trade-orchestrator).
   *
   * Message shape: { id, type, body: { action, symbol, side, strategy, ... } }
   *
   * Supported: place_limit, place_market, position_closed, modify_stop
   * Skipped: cancel_limit, update_limit (no PMT equivalent)
   */
  async handleWebhookAction(webhookMessage) {
    const signal = webhookMessage.body;
    const action = signal.action;

    let pmtPayload;

    switch (action) {
      case 'place_limit':
        pmtPayload = {
          symbol: this.extractRootSymbol(signal.symbol),
          data: signal.side || 'buy',
          quantity: signal.quantity || 1,
          price: signal.price || 0,
          sl: signal.stop_loss || 0,
          tp: signal.take_profit || 0,
          token: this.token,
        };
        if (signal.trailing_trigger || signal.trailing_offset) {
          pmtPayload.trail = 1;
          pmtPayload.trail_trigger = signal.trailing_trigger || 0;
          pmtPayload.trail_stop = signal.trailing_offset || 0;
        }
        break;

      case 'place_market':
        pmtPayload = {
          symbol: this.extractRootSymbol(signal.symbol),
          data: signal.side || 'buy',
          quantity: signal.quantity || 1,
          price: 0,
          sl: signal.stop_loss || 0,
          tp: signal.take_profit || 0,
          token: this.token,
        };
        if (signal.trailing_trigger || signal.trailing_offset) {
          pmtPayload.trail = 1;
          pmtPayload.trail_trigger = signal.trailing_trigger || 0;
          pmtPayload.trail_stop = signal.trailing_offset || 0;
        }
        break;

      case 'position_closed':
      case 'cancel_limit':
        pmtPayload = {
          symbol: this.extractRootSymbol(signal.symbol),
          data: 'close',
          quantity: 0,
          price: 0,
          token: this.token,
        };
        break;

      case 'modify_stop':
        pmtPayload = {
          symbol: this.extractRootSymbol(signal.symbol),
          data: signal.side || 'buy',
          quantity: signal.quantity || 1,
          update_sl: true,
          sl: signal.new_stop_price || 0,
          token: this.token,
        };
        break;

      default:
        this.logger.info(`[PMT] Skipping unsupported action: ${action}`);
        return { skipped: true, action };
    }

    // Add account_id if configured
    if (this.accountId && pmtPayload) {
      pmtPayload.account_id = this.accountId;
    }

    return this.sendWebhook(pmtPayload, `WEBHOOK ${action} ${signal.symbol} [${signal.strategy || 'unknown'}]`);
  }

  /**
   * POST payload to PickMyTrade webhook endpoint.
   * Fire-and-forget: errors are logged but never thrown.
   */
  async sendWebhook(payload, context) {
    try {
      this.logger.info(`[PMT] Sending ${context}: ${JSON.stringify(payload)}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        const responseText = await response.text();

        if (response.ok) {
          this.logger.info(`[PMT] ${context} — ${response.status} OK`);
        } else {
          this.logger.warn(`[PMT] ${context} — ${response.status}: ${responseText}`);
        }

        return { success: response.ok, status: response.status, body: responseText };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const msg = error.name === 'AbortError' ? 'Request timed out (5s)' : error.message;
      this.logger.error(`[PMT] ${context} FAILED: ${msg}`);
      return { success: false, error: msg };
    }
  }
}
