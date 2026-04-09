/**
 * Order Router
 *
 * Intercepts ORDER_REQUEST and WEBHOOK_TRADE messages and fans them out
 * to configured connector destinations (tradovate-live, tradovate-demo,
 * pickmytrade, etc.) based on strategy-level routing rules.
 *
 * Routing config is persisted in Redis (key: routing:config) and read
 * dynamically on each routing call. Falls back to routing-config.json
 * if Redis has no config. Dashboard can update routing per-strategy
 * without service restarts.
 *
 * Error isolation: connectors run in parallel via Promise.allSettled.
 * A PickMyTrade failure will never block Tradovate execution.
 */

import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PickMyTradeConnector } from './pickmytrade-connector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load routing config from JSON file (fallback).
 */
function loadRoutingConfigFromFile(logger) {
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
 * Create the order router.
 *
 * @param {Object} logger - Logger instance
 * @param {Object} [messageBus] - Message bus instance (for Redis-backed config)
 * @param {Object} [tradovateHandlers] - Map of tradovate destination names to handler objects.
 * @returns {{ routeOrderRequest: Function, routeWebhookTrade: Function, getRoutingConfig: Function }}
 */
export function createOrderRouter(logger, messageBus = null, tradovateHandlers = {}) {
  const fileConfig = loadRoutingConfigFromFile(logger);
  const connectors = initConnectors(logger);
  const redisClient = messageBus?.publisher || null;

  /**
   * Get the current routing config. Reads from Redis first, falls back to file.
   */
  async function getActiveConfig() {
    if (redisClient) {
      try {
        const cached = await redisClient.get('routing:config');
        if (cached) return JSON.parse(cached);
      } catch { /* fall through to file */ }
    }
    return fileConfig;
  }

  /**
   * Resolve destinations for a given strategy name.
   */
  async function getDestinations(strategy) {
    const config = await getActiveConfig();
    if (!config) return [Object.keys(tradovateHandlers)[0] || 'tradovate'];
    if (strategy && config.routes && config.routes[strategy]) {
      return config.routes[strategy];
    }
    return config.defaultDestinations || [Object.keys(tradovateHandlers)[0] || 'tradovate'];
  }

  /**
   * Check if a destination is a tradovate handler.
   */
  function isTradovateDestination(dest) {
    return dest === 'tradovate' || dest.startsWith('tradovate-');
  }

  /**
   * Filter destinations to only those with available handlers/connectors.
   */
  function filterAvailableDestinations(destinations) {
    const available = [];
    for (const dest of destinations) {
      if (isTradovateDestination(dest)) {
        if (tradovateHandlers[dest]) {
          available.push(dest);
        } else {
          logger.warn(`[Router] No tradovate handler registered for: ${dest}`);
        }
      } else if (connectors.has(dest)) {
        available.push(dest);
      }
    }
    return available;
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
    const configuredDests = await getDestinations(strategy);
    const destinations = filterAvailableDestinations(configuredDests);

    if (destinations.length === 0) {
      logger.warn(`[Router] ORDER_REQUEST [${strategy}] — no available destinations (configured: [${configuredDests.join(', ')}])`);
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
    const configuredDests = await getDestinations(strategy);
    const destinations = filterAvailableDestinations(configuredDests);

    if (destinations.length === 0) {
      logger.warn(`[Router] WEBHOOK_TRADE ${action} [${strategy}] — no available destinations`);
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
   * Get the current routing config (for API responses).
   */
  async function getRoutingConfig() {
    return await getActiveConfig();
  }

  // Log routing table on startup
  if (fileConfig && fileConfig.routes) {
    for (const [strategy, dests] of Object.entries(fileConfig.routes)) {
      logger.info(`[Router]   ${strategy} → [${dests.join(', ')}]`);
    }
  }
  if (Object.keys(tradovateHandlers).length > 0) {
    logger.info(`[Router] Tradovate handlers: [${Object.keys(tradovateHandlers).join(', ')}]`);
  }
  if (connectors.size > 0) {
    logger.info(`[Router] External connectors: [${[...connectors.keys()].join(', ')}]`);
  }

  return { routeOrderRequest, routeWebhookTrade, getRoutingConfig };
}
