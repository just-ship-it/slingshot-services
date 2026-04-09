/**
 * Order Router
 *
 * Intercepts ORDER_REQUEST and WEBHOOK_TRADE messages and fans them out
 * to configured connector destinations (tradovate-live, tradovate-demo,
 * pickmytrade, etc.) based on strategy-level routing rules.
 *
 * Error isolation: connectors run in parallel via Promise.allSettled.
 * A PickMyTrade failure will never block Tradovate execution.
 *
 * Runtime toggle: each non-tradovate connector's enabled state is checked
 * in Redis (key: connector:{name}:enabled) on every routing call, allowing
 * dashboard-driven enable/disable without restarts.
 */

import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PickMyTradeConnector } from './pickmytrade-connector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load routing config from env var (base64) or JSON file.
 * Returns null if no config exists → tradovate-only default.
 */
function loadRoutingConfig(logger) {
  const configEnv = process.env.ROUTING_CONFIG;
  if (configEnv) {
    try {
      const config = JSON.parse(Buffer.from(configEnv, 'base64').toString());
      logger.info('[Router] Loaded routing config from ROUTING_CONFIG env var');
      return config;
    } catch (e) {
      logger.warn(`[Router] Failed to parse ROUTING_CONFIG env var: ${e.message}`);
    }
  }

  const configPath = join(__dirname, '../routing-config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    logger.info(`[Router] Loaded routing config from ${configPath}`);
    return config;
  } catch (e) {
    if (e.code === 'ENOENT') {
      logger.info('[Router] No routing-config.json found — all orders route to tradovate');
    } else {
      logger.warn(`[Router] Failed to load routing-config.json: ${e.message}`);
    }
    return null;
  }
}

/**
 * Initialize external connectors based on env vars.
 * Returns a Map of connector name → connector instance.
 */
function initConnectors(logger) {
  const connectors = new Map();

  const pmtEnabled = process.env.PICKMYTRADE_ENABLED === 'true';
  if (pmtEnabled) {
    try {
      const pmt = new PickMyTradeConnector({
        webhookUrl: process.env.PICKMYTRADE_WEBHOOK_URL,
        token: process.env.PICKMYTRADE_TOKEN,
        accountId: process.env.PICKMYTRADE_ACCOUNT_ID || null,
      }, logger);
      connectors.set('pickmytrade', pmt);
      logger.info('[Router] PickMyTrade connector initialized');
    } catch (e) {
      logger.error(`[Router] Failed to initialize PickMyTrade connector: ${e.message}`);
    }
  }

  return connectors;
}

/**
 * Check if a connector is enabled at runtime via Redis.
 * Falls back to true (enabled) if Redis is unavailable or key doesn't exist.
 */
async function isConnectorEnabled(redisClient, connectorName) {
  if (!redisClient) return true;
  try {
    const val = await redisClient.get(`connector:${connectorName}:enabled`);
    if (val === null) return true;
    return val === 'true';
  } catch {
    return true;
  }
}

/**
 * Create the order router.
 *
 * @param {Object} logger - Logger instance
 * @param {Object} [messageBus] - Message bus instance (for Redis-backed connector toggles)
 * @param {Object} [tradovateHandlers] - Map of tradovate destination names to handler objects.
 *   Each handler: { order: async (message) => ..., webhook: async (message) => ... }
 *   Example: { 'tradovate-live': { order: fn, webhook: fn }, 'tradovate-demo': { order: fn, webhook: fn } }
 * @returns {{ routeOrderRequest: Function, routeWebhookTrade: Function, getConnectorStatus: Function }}
 */
export function createOrderRouter(logger, messageBus = null, tradovateHandlers = {}) {
  const config = loadRoutingConfig(logger);
  const connectors = initConnectors(logger);
  const redisClient = messageBus?.publisher || null;

  /**
   * Resolve destinations for a given strategy name.
   */
  function getDestinations(strategy) {
    if (!config) return [Object.keys(tradovateHandlers)[0] || 'tradovate'];
    if (strategy && config.routes && config.routes[strategy]) {
      return config.routes[strategy];
    }
    return config.defaultDestinations || [Object.keys(tradovateHandlers)[0] || 'tradovate'];
  }

  /**
   * Check if a destination is a tradovate handler (tradovate, tradovate-live, tradovate-demo).
   */
  function isTradovateDestination(dest) {
    return dest === 'tradovate' || dest.startsWith('tradovate-');
  }

  /**
   * Filter destinations by checking enabled state.
   * Tradovate destinations are always available (controlled by trading kill switch).
   * External connectors check Redis enabled state.
   */
  async function filterEnabledDestinations(destinations) {
    const enabled = [];
    for (const dest of destinations) {
      if (isTradovateDestination(dest)) {
        if (tradovateHandlers[dest]) {
          enabled.push(dest);
        } else {
          logger.warn(`[Router] No tradovate handler registered for: ${dest}`);
        }
      } else if (connectors.has(dest) && await isConnectorEnabled(redisClient, dest)) {
        enabled.push(dest);
      }
    }
    return enabled;
  }

  /**
   * Dispatch a single destination — resolve to tradovate handler or external connector.
   */
  function dispatchOrder(dest, message) {
    if (tradovateHandlers[dest]) {
      return tradovateHandlers[dest].order(message);
    }
    const connector = connectors.get(dest);
    if (connector) {
      return connector.handleOrderRequest(message);
    }
    logger.warn(`[Router] No handler or connector for destination: ${dest}`);
    return Promise.resolve({ skipped: true, reason: 'no handler' });
  }

  function dispatchWebhook(dest, message) {
    if (tradovateHandlers[dest]) {
      return tradovateHandlers[dest].webhook(message);
    }
    const connector = connectors.get(dest);
    if (connector) {
      return connector.handleWebhookAction(message);
    }
    logger.warn(`[Router] No handler or connector for destination: ${dest}`);
    return Promise.resolve({ skipped: true, reason: 'no handler' });
  }

  /**
   * Route an ORDER_REQUEST message to configured destinations.
   */
  async function routeOrderRequest(message) {
    const strategy = message.strategy || 'UNKNOWN';
    const configuredDests = getDestinations(strategy);
    const destinations = await filterEnabledDestinations(configuredDests);

    if (destinations.length === 0) {
      logger.warn(`[Router] ORDER_REQUEST [${strategy}] — no enabled destinations (configured: [${configuredDests.join(', ')}])`);
      return;
    }

    // Fast path — single tradovate destination
    if (destinations.length === 1 && isTradovateDestination(destinations[0])) {
      return dispatchOrder(destinations[0], message);
    }

    logger.info(`[Router] ORDER_REQUEST [${strategy}] → [${destinations.join(', ')}]`);

    const promises = destinations.map(dest => dispatchOrder(dest, message));
    const results = await Promise.allSettled(promises);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const dest = destinations[i];
      if (result.status === 'rejected') {
        if (isTradovateDestination(dest)) {
          logger.error(`[Router] ${dest} handler failed: ${result.reason}`);
        } else {
          logger.warn(`[Router] ${dest} failed (non-blocking): ${result.reason}`);
        }
      }
    }
  }

  /**
   * Route a WEBHOOK_TRADE message to configured destinations.
   */
  async function routeWebhookTrade(message) {
    const strategy = message.body?.strategy || 'UNKNOWN';
    const action = message.body?.action || 'unknown';
    const configuredDests = getDestinations(strategy);
    const destinations = await filterEnabledDestinations(configuredDests);

    if (destinations.length === 0) {
      logger.warn(`[Router] WEBHOOK_TRADE ${action} [${strategy}] — no enabled destinations`);
      return;
    }

    if (destinations.length === 1 && isTradovateDestination(destinations[0])) {
      return dispatchWebhook(destinations[0], message);
    }

    logger.info(`[Router] WEBHOOK_TRADE ${action} [${strategy}] → [${destinations.join(', ')}]`);

    const promises = destinations.map(dest => dispatchWebhook(dest, message));
    const results = await Promise.allSettled(promises);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const dest = destinations[i];
      if (result.status === 'rejected') {
        if (isTradovateDestination(dest)) {
          logger.error(`[Router] ${dest} handler failed: ${result.reason}`);
        } else {
          logger.warn(`[Router] ${dest} failed (non-blocking): ${result.reason}`);
        }
      }
    }
  }

  /**
   * Get status of all configured external connectors.
   */
  async function getConnectorStatus() {
    const status = {};
    for (const [name, connector] of connectors) {
      const enabled = await isConnectorEnabled(redisClient, name);
      status[name] = {
        configured: true,
        enabled,
        webhookUrl: connector.webhookUrl ? connector.webhookUrl.replace(/token=[^&]+/, 'token=***') : null,
      };
    }
    return status;
  }

  function getRoutingConfig() {
    return config;
  }

  // Log routing table on startup
  if (config && config.routes) {
    for (const [strategy, dests] of Object.entries(config.routes)) {
      logger.info(`[Router]   ${strategy} → [${dests.join(', ')}]`);
    }
  }
  if (Object.keys(tradovateHandlers).length > 0) {
    logger.info(`[Router] Tradovate handlers: [${Object.keys(tradovateHandlers).join(', ')}]`);
  }

  return { routeOrderRequest, routeWebhookTrade, getConnectorStatus, getRoutingConfig };
}
