/**
 * Routes Store
 *
 * Owns the strategy → account routing table. Reads/writes Redis key
 * `routes:config`. Publishes `routes.changed` on every write so every
 * service can refresh its routing view without a restart.
 *
 * Schema:
 *   {
 *     version: 1,
 *     defaultAccounts: [ "accountId", ... ],
 *     routes: { [strategyName]: [ "accountId", ... ] },
 *     updatedAt: "ISO timestamp"
 *   }
 *
 * If Redis has no entry yet, the store can bootstrap from:
 *   1. `shared/routing-config.json` (legacy destination-string format),
 *      translated via an accountId map you supply.
 *   2. An empty default `{ defaultAccounts: [], routes: {} }`.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROUTES_KEY = 'routes:config';
const ROUTES_CHANGED_CHANNEL = 'routes.changed';
const SCHEMA_VERSION = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nowIso() { return new Date().toISOString(); }

function emptyConfig() {
  return { version: SCHEMA_VERSION, defaultAccounts: [], routes: {}, updatedAt: nowIso() };
}

function normalizeList(list, label) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${label} must be an array`);
  for (const v of list) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`${label} must contain non-empty strings (got ${JSON.stringify(v)})`);
    }
  }
  return [...list];
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return emptyConfig();
  return {
    version: raw.version || SCHEMA_VERSION,
    defaultAccounts: normalizeList(raw.defaultAccounts, 'defaultAccounts'),
    routes: (() => {
      const out = {};
      if (raw.routes && typeof raw.routes === 'object') {
        for (const [strategy, list] of Object.entries(raw.routes)) {
          out[strategy] = normalizeList(list, `routes.${strategy}`);
        }
      }
      return out;
    })(),
    updatedAt: raw.updatedAt || nowIso()
  };
}

export function createRoutesStore({ redis, messageBus = null, logger = console }) {
  if (!redis) throw new Error('createRoutesStore: redis client is required');

  async function publishChange(action) {
    if (!messageBus) return;
    try {
      await messageBus.publish(ROUTES_CHANGED_CHANNEL, { action, timestamp: nowIso() });
    } catch (err) {
      logger.warn?.(`routes-store: failed to publish change event: ${err.message}`);
    }
  }

  async function read() {
    const raw = await redis.get(ROUTES_KEY);
    if (!raw) return null;
    try {
      return normalizeConfig(JSON.parse(raw));
    } catch (err) {
      throw new Error(`routes-store: corrupt JSON at ${ROUTES_KEY}: ${err.message}`);
    }
  }

  async function get() {
    const existing = await read();
    return existing || emptyConfig();
  }

  async function write(config) {
    const normalized = normalizeConfig({ ...config, updatedAt: nowIso() });
    await redis.set(ROUTES_KEY, JSON.stringify(normalized));
    await publishChange('replaced');
    return normalized;
  }

  async function setDefaults(accountIds) {
    const config = await get();
    config.defaultAccounts = normalizeList(accountIds, 'defaultAccounts');
    config.updatedAt = nowIso();
    await redis.set(ROUTES_KEY, JSON.stringify(config));
    await publishChange('defaults_updated');
    return config;
  }

  async function setRoute(strategyName, accountIds) {
    if (!strategyName) throw new Error('setRoute: strategyName required');
    const config = await get();
    const ids = normalizeList(accountIds, `routes.${strategyName}`);
    if (ids.length === 0) {
      delete config.routes[strategyName];
    } else {
      config.routes[strategyName] = ids;
    }
    config.updatedAt = nowIso();
    await redis.set(ROUTES_KEY, JSON.stringify(config));
    await publishChange('route_updated');
    return config;
  }

  async function addAccountToStrategy(strategyName, accountId) {
    const config = await get();
    const list = config.routes[strategyName] || [];
    if (!list.includes(accountId)) list.push(accountId);
    return setRoute(strategyName, list);
  }

  async function removeAccountFromStrategy(strategyName, accountId) {
    const config = await get();
    const list = (config.routes[strategyName] || []).filter(id => id !== accountId);
    return setRoute(strategyName, list);
  }

  async function deleteRoute(strategyName) {
    return setRoute(strategyName, []);
  }

  /**
   * Resolve the account list a strategy should route to.
   * Falls back to defaultAccounts when the strategy has no explicit route.
   */
  async function resolve(strategyName) {
    const config = await get();
    if (strategyName && config.routes[strategyName]?.length) {
      return config.routes[strategyName];
    }
    return config.defaultAccounts;
  }

  /**
   * One-time bootstrap from legacy `shared/routing-config.json`.
   * Only runs if Redis has no config yet.
   *
   * @param {Object} destinationToAccount — map old destination string → new accountId
   *        e.g. { "tradovate-live": "tv-funded", "pickmytrade": "pmt-prop" }
   * @param {string} [filePath] — override for tests
   */
  async function bootstrapFromFile(destinationToAccount = {}, filePath = null) {
    const existing = await read();
    if (existing) return { bootstrapped: false, reason: 'routes:config already present' };

    const target = filePath || path.join(__dirname, '..', 'routing-config.json');
    let raw;
    try {
      raw = await fs.readFile(target, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return { bootstrapped: false, reason: 'no legacy file found' };
      throw err;
    }

    const legacy = JSON.parse(raw);
    const translateList = (list) => (list || [])
      .map(dest => destinationToAccount[dest])
      .filter(Boolean);

    const config = {
      version: SCHEMA_VERSION,
      defaultAccounts: translateList(legacy.defaultDestinations),
      routes: Object.fromEntries(
        Object.entries(legacy.routes || {}).map(([k, v]) => [k, translateList(v)])
      ),
      updatedAt: nowIso()
    };
    const normalized = normalizeConfig(config);
    await redis.set(ROUTES_KEY, JSON.stringify(normalized));
    await publishChange('bootstrapped');
    return { bootstrapped: true, config: normalized };
  }

  return {
    get,
    write,
    setDefaults,
    setRoute,
    addAccountToStrategy,
    removeAccountFromStrategy,
    deleteRoute,
    resolve,
    bootstrapFromFile,
    KEY: ROUTES_KEY,
    CHANNEL: ROUTES_CHANGED_CHANNEL
  };
}

export const ROUTES_CHANNEL = ROUTES_CHANGED_CHANNEL;
export const ROUTES_CONFIG_KEY = ROUTES_KEY;
