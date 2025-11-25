// Shared utilities for all microservices
export { default as messageBus, MessageBus } from './message-bus/index.js';
export { default as createLogger } from './utils/logger.js';
export { default as configManager } from './utils/config.js';

// Message bus channel constants
export const CHANNELS = {
  // Webhook events
  WEBHOOK_RECEIVED: 'webhook.received',
  WEBHOOK_VALIDATED: 'webhook.validated',
  WEBHOOK_REJECTED: 'webhook.rejected',
  WEBHOOK_QUOTE: 'webhook.quote',
  WEBHOOK_TRADE: 'webhook.trade',

  // Trading signals
  TRADE_SIGNAL: 'trade.signal',
  TRADE_VALIDATED: 'trade.validated',
  TRADE_REJECTED: 'trade.rejected',

  // Order events
  ORDER_REQUEST: 'order.request',
  ORDER_PLACED: 'order.placed',
  ORDER_FILLED: 'order.filled',
  ORDER_REJECTED: 'order.rejected',
  ORDER_CANCELLED: 'order.cancelled',

  // Position events
  POSITION_OPENED: 'position.opened',
  POSITION_CLOSED: 'position.closed',
  POSITION_UPDATE: 'position.update',

  // Market data events
  PRICE_UPDATE: 'price.update',
  MARKET_CONNECTED: 'market.connected',
  MARKET_DISCONNECTED: 'market.disconnected',
  QUOTE_REQUEST: 'quote.request',
  QUOTE_RESPONSE: 'quote.response',

  // Account events
  ACCOUNT_UPDATE: 'account.update',
  BALANCE_UPDATE: 'balance.update',
  MARGIN_UPDATE: 'margin.update',

  // System events
  SERVICE_HEALTH: 'service.health',
  SERVICE_ERROR: 'service.error',
  SERVICE_STARTED: 'service.started',
  SERVICE_STOPPED: 'service.stopped'
};

// Service health check helper
export async function healthCheck(serviceName, details = {}, messageBusInstance = null) {
  const health = {
    service: serviceName,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    ...details
  };

  if (messageBusInstance && messageBusInstance.isConnected) {
    await messageBusInstance.publish(CHANNELS.SERVICE_HEALTH, health);
  }

  return health;
}