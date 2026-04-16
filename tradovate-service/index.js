/**
 * Broker Execution Service (legacy name: tradovate-service).
 *
 * Loads all enabled broker accounts from account-store, instantiates the
 * matching connector class per account, registers each with the order router,
 * and subscribes to order.request on the bus. Hot-reloads on account.changed.
 *
 * Currently hosts:
 *   - TradovateConnector   (broker=tradovate)
 *   - PickMyTradeConnector (broker=pickmytrade)  — fire-and-forget webhook
 *
 * This service knows NOTHING about strategies, routing, or kill switches.
 * See ARCHITECTURE.md.
 */

import express from 'express';
import cors from 'cors';
import {
  messageBus,
  CHANNELS,
  createLogger,
  healthCheck
} from '../shared/index.js';
import { createAccountStore, ACCOUNT_CHANNEL } from '../shared/utils/account-store.js';
import { createOrderRouter } from '../shared/utils/order-router.js';
import { TradovateConnector } from '../shared/connectors/tradovate-connector.js';
import { PickMyTradeConnector } from '../shared/connectors/pickmytrade-connector.js';
import TradovateClient from './TradovateClient.js';

const SUPPORTED_BROKERS = new Set(['tradovate', 'pickmytrade']);

const SERVICE_NAME = 'tradovate-service';
const logger = createLogger(SERVICE_NAME);

const PORT = Number(process.env.PORT || process.env.TRADOVATE_SERVICE_PORT || 3011);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

const connectors = new Map(); // accountId → TradovateConnector
const router = createOrderRouter({ logger });
let accountStore = null;
let redisClient = null;

// -------------------- Connector lifecycle --------------------

function buildConnector(account) {
  const deps = {
    messageBus,
    channels: CHANNELS,
    redis: redisClient,
    accountStore,
    ClientClass: TradovateClient,
    connectorLookup: (id) => connectors.get(id) || null
  };
  if (account.broker === 'tradovate') {
    return new TradovateConnector(account, logger, deps);
  }
  if (account.broker === 'pickmytrade') {
    return new PickMyTradeConnector(account, logger, deps);
  }
  throw new Error(`Unsupported broker: ${account.broker}`);
}

async function bringUpConnector(account) {
  if (!account) return;
  if (!SUPPORTED_BROKERS.has(account.broker)) {
    logger.debug?.(`[${account.id}] broker=${account.broker} not hosted here, skipping`);
    return;
  }
  if (!account.enabled) {
    logger.info(`[${account.id}] disabled — not starting connector`);
    return;
  }
  if (connectors.has(account.id)) {
    logger.warn(`[${account.id}] connector already running — skipping re-init`);
    return;
  }

  let decrypted;
  try {
    decrypted = await accountStore.getDecrypted(account.id);
  } catch (err) {
    logger.error(`[${account.id}] failed to decrypt credentials: ${err.message}`);
    return;
  }
  if (!decrypted) {
    logger.error(`[${account.id}] account record missing`);
    return;
  }

  let connector;
  try {
    connector = buildConnector(decrypted);
  } catch (err) {
    logger.error(`[${account.id}] buildConnector failed: ${err.message}`);
    return;
  }

  try {
    await connector.init();
    connectors.set(account.id, connector);
    router.register(account.id, connector);
    logger.info(`[${account.id}] connector online (${account.broker})`);
  } catch (err) {
    logger.error(`[${account.id}] init failed: ${err.message}`);
    try { await connector.shutdown(); } catch {}
  }
}

async function tearDownConnector(accountId) {
  const connector = connectors.get(accountId);
  if (!connector) return;
  router.unregister(accountId);
  connectors.delete(accountId);
  try { await connector.shutdown(); }
  catch (err) { logger.warn(`[${accountId}] shutdown error: ${err.message}`); }
}

// Accounts referenced as a tracking shadow by any PMT account — these are
// NOT directly routable (they're owned by their PMT). Returns a Set of ids.
function findShadowIds(accounts) {
  const ids = new Set();
  for (const a of accounts) {
    if (a.broker === 'pickmytrade' && a.tracking?.via) ids.add(a.tracking.via);
  }
  return ids;
}

async function loadAllAccounts() {
  const accounts = await accountStore.list();
  const eligible = accounts.filter(a => SUPPORTED_BROKERS.has(a.broker));
  const shadows = findShadowIds(eligible);

  // Bring up PMT accounts first — each instantiates its own shadow internally.
  // Then bring up remaining Tradovate accounts that aren't owned as shadows.
  const pmt = eligible.filter(a => a.broker === 'pickmytrade');
  const standalone = eligible.filter(a => a.broker === 'tradovate' && !shadows.has(a.id));
  const skipped = eligible.filter(a => a.broker === 'tradovate' && shadows.has(a.id));

  logger.info(`Found ${eligible.length} broker accounts: pmt=${pmt.length}, standalone_tradovate=${standalone.length}, pmt_shadow_tradovate=${skipped.length}`);
  for (const acct of skipped) {
    logger.info(`[${acct.id}] reserved as shadow for a PMT account — not directly registered`);
  }

  for (const acct of pmt) await bringUpConnector(acct);
  for (const acct of standalone) await bringUpConnector(acct);
}

async function handleAccountChanged(event) {
  const { action, id } = event || {};
  if (!id) return;

  const existing = connectors.has(id);
  let record = null;
  try { record = await accountStore.get(id); } catch {}
  const isOurs = record && SUPPORTED_BROKERS.has(record.broker);

  // If this is a Tradovate account reserved as a PMT shadow, don't register directly.
  if (isOurs && record.broker === 'tradovate') {
    const all = await accountStore.list();
    const shadows = findShadowIds(all);
    if (shadows.has(id)) {
      if (existing) {
        logger.info(`[${id}] now reserved as PMT shadow — tearing down direct registration`);
        await tearDownConnector(id);
      }
      return;
    }
  }

  if (action === 'deleted' || !record) {
    if (existing) {
      logger.info(`[${id}] account deleted — tearing down connector`);
      await tearDownConnector(id);
    }
    return;
  }

  if (!isOurs) return;

  if (existing && !record.enabled) {
    logger.info(`[${id}] disabled — tearing down connector`);
    await tearDownConnector(id);
    return;
  }

  if (!existing && record.enabled) {
    logger.info(`[${id}] enabled — bringing up connector`);
    await bringUpConnector(record);
    return;
  }

  if (existing && record.enabled) {
    // Credentials or config may have changed — cycle connector to pick up new values
    logger.info(`[${id}] updated — cycling connector`);
    await tearDownConnector(id);
    await bringUpConnector(record);
  }
}

// -------------------- Connector lookup (includes PMT shadows) --------------------

function findConnector(accountId) {
  const direct = connectors.get(accountId);
  if (direct) return direct;
  // Check if it's a shadow owned by a PMT connector
  for (const conn of connectors.values()) {
    if (conn.shadow && conn.shadow.account?.id === accountId) return conn.shadow;
  }
  return null;
}

// -------------------- Order routing --------------------

async function handleOrderRequest(message) {
  if (!router.owns(message?.accountId)) return;
  await router.routeOrderRequest(message);
}

// -------------------- HTTP --------------------

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    const connectorHealth = {};
    for (const [id, conn] of connectors.entries()) {
      connectorHealth[id] = await conn.healthCheck().catch(err => ({ ok: false, error: err.message }));
    }
    const h = await healthCheck(SERVICE_NAME, {
      connectors: connectorHealth,
      registered: router.listRegistered()
    }, messageBus);
    res.json(h);
  });

  app.get('/accounts', (_req, res) => {
    res.json({
      connectors: router.listRegistered().map(id => ({
        accountId: id,
        ready: connectors.get(id)?.ready ?? false
      }))
    });
  });

  app.get('/accounts/:accountId/positions', async (req, res) => {
    const conn = findConnector(req.params.accountId);
    if (!conn) return res.status(404).json({ error: 'connector not found' });
    try {
      const positions = await conn.getPositions();
      res.json({ accountId: req.params.accountId, positions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/accounts/:accountId/balance', async (req, res) => {
    const conn = findConnector(req.params.accountId);
    if (!conn) return res.status(404).json({ error: 'connector not found' });
    if (!conn.client) return res.status(503).json({ error: 'not connected' });
    try {
      const [account, cash] = await Promise.all([
        conn.client.getAccountBalances(conn.brokerAccountId),
        conn.client.getCashBalances(conn.brokerAccountId)
      ]);
      // Tradovate cash snapshot may omit unrealizedPnL — derive from netLiq vs totalCashValue
      const totalCash = cash?.totalCashValue ?? cash?.cashBalance ?? 0;
      const netLiq = cash?.netLiq ?? totalCash;
      const unrealizedPnL = cash?.unrealizedPnL ?? ((netLiq - totalCash) || 0);
      res.json({
        accountId: req.params.accountId,
        brokerAccountId: conn.brokerAccountId,
        mode: conn.mode,
        balance: totalCash,
        realizedPnL: cash?.realizedPnL ?? 0,
        unrealizedPnL,
        marginUsed: account?.marginUsed ?? 0,
        netLiq,
        openTradeEquity: cash?.openTradeEquity ?? 0,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/accounts/:accountId/test', async (req, res) => {
    const conn = findConnector(req.params.accountId);
    if (!conn) return res.status(404).json({ error: 'connector not found' });
    res.json(await conn.testConnection());
  });

  app.post('/accounts/:accountId/cancel/:signalId', async (req, res) => {
    const conn = findConnector(req.params.accountId);
    if (!conn) return res.status(404).json({ error: 'connector not found' });
    if (typeof conn.cancelBySignalId !== 'function') {
      return res.status(501).json({ error: 'connector does not support cancelBySignalId' });
    }
    try {
      const hint = { symbol: req.query.symbol || req.body?.symbol || null };
      const result = await conn.cancelBySignalId(req.params.signalId, hint);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/accounts/:accountId/snapshot', async (req, res) => {
    const conn = findConnector(req.params.accountId);
    if (!conn) return res.status(404).json({ error: 'connector not found' });
    try {
      // PMT connectors delegate to their shadow for reconciliation
      const target = conn.shadow || conn;
      if (typeof target._reconcileAndSnapshot !== 'function') {
        return res.status(501).json({ error: 'connector does not support snapshot' });
      }
      await target._reconcileAndSnapshot('manual');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// -------------------- Bootstrap --------------------

async function main() {
  await messageBus.connect();
  redisClient = messageBus.publisher;

  accountStore = createAccountStore({ redis: redisClient, messageBus, logger });

  await loadAllAccounts();

  await messageBus.subscribe(CHANNELS.ORDER_REQUEST, handleOrderRequest);
  await messageBus.subscribe(ACCOUNT_CHANNEL, handleAccountChanged);

  const app = buildApp();
  app.listen(PORT, BIND_HOST, () => logger.info(`tradovate-service listening on ${BIND_HOST}:${PORT}`));

  await messageBus.publish(CHANNELS.SERVICE_STARTED, {
    service: SERVICE_NAME, timestamp: new Date().toISOString(),
    connectors: router.listRegistered()
  });
}

async function shutdown() {
  logger.info('Shutting down — tearing down connectors');
  for (const id of [...connectors.keys()]) await tearDownConnector(id);
  try { await messageBus.disconnect(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
