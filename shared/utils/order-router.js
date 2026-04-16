/**
 * Order Router (per broker service)
 *
 * Dispatches `order.request` messages to the connector that owns the target
 * accountId. Route resolution (strategy → accountIds) is the orchestrator's
 * job and happens before the request ever reaches a broker service. By the
 * time a message arrives here it already names the account.
 *
 * The service (tradovate-service) owns connector lifecycle: it instantiates
 * connectors from account records and calls `register(id, connector)` /
 * `unregister(id)` as accounts are added, updated, or removed.
 *
 * If an order.request arrives for an accountId we don't own, it's silently
 * ignored — it belongs to a different broker service subscribed to the same
 * channel.
 *
 * Contract each connector must implement:
 *   async handleOrderRequest(message)
 */

export function createOrderRouter({ logger } = {}) {
  if (!logger) throw new Error('createOrderRouter: logger is required');

  const connectors = new Map();

  function register(accountId, connector) {
    if (!accountId) throw new Error('router.register: accountId required');
    if (!connector) throw new Error('router.register: connector required');
    if (typeof connector.handleOrderRequest !== 'function') {
      throw new Error(`router.register: connector for ${accountId} must implement handleOrderRequest`);
    }
    connectors.set(accountId, connector);
    logger.info(`[Router] registered connector: ${accountId}`);
  }

  function unregister(accountId) {
    if (connectors.delete(accountId)) {
      logger.info(`[Router] unregistered connector: ${accountId}`);
    }
  }

  function listRegistered() {
    return [...connectors.keys()];
  }

  function getConnector(accountId) {
    return connectors.get(accountId) || null;
  }

  function owns(accountId) {
    return connectors.has(accountId);
  }

  async function routeOrderRequest(message) {
    const accountId = message?.accountId;
    if (!accountId) {
      logger.warn('[Router] order.request without accountId — dropping');
      return { dispatched: false, reason: 'missing accountId' };
    }
    const connector = connectors.get(accountId);
    if (!connector) {
      return { dispatched: false, reason: 'not owned by this broker' };
    }

    const signalId = message.signalId || '(no signalId)';
    const strategy = message.strategy || 'UNKNOWN';
    logger.info(`[Router] order.request ${signalId} [${strategy}] → ${accountId}`);

    try {
      const result = await connector.handleOrderRequest({ ...message });
      return { dispatched: true, result };
    } catch (err) {
      logger.error(`[Router] ${accountId} handleOrderRequest failed: ${err.message}`);
      return { dispatched: true, error: err.message };
    }
  }

  return {
    register,
    unregister,
    listRegistered,
    getConnector,
    owns,
    routeOrderRequest
  };
}
