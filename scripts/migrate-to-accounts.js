#!/usr/bin/env node
/**
 * One-shot migration: env vars + routing-config.json → Redis account records + routes.
 *
 * Reads TRADOVATE_*, PICKMYTRADE_* from process.env and shared/routing-config.json,
 * writes encrypted account records via account-store and a translated route table
 * via routes-store.
 *
 * Usage:
 *   SLINGSHOT_MASTER_KEY=... node scripts/migrate-to-accounts.js --dry-run
 *   SLINGSHOT_MASTER_KEY=... node scripts/migrate-to-accounts.js
 *   SLINGSHOT_MASTER_KEY=... node scripts/migrate-to-accounts.js --force
 *
 * Flags:
 *   --dry-run   Print planned writes, make no changes.
 *   --force     Overwrite existing accounts/routes. Default is to skip anything
 *               already in Redis (idempotent re-run).
 *
 * Account ids produced:
 *   tradovate-demo    (if TRADOVATE_DEMO_ACCOUNT_ID is set)
 *   tradovate-live    (if TRADOVATE_LIVE_ACCOUNT_ID is set)
 *   pickmytrade-prop  (if PICKMYTRADE_ENABLED === 'true')
 *
 * Destination-string → account-id translation for routing-config.json:
 *   tradovate        → tradovate-live (or -demo if only demo is defined)
 *   tradovate-demo   → tradovate-demo
 *   tradovate-live   → tradovate-live
 *   pickmytrade      → pickmytrade-prop
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__here, '..', 'shared', '.env') });

import { messageBus } from '../shared/index.js';
import { createAccountStore } from '../shared/utils/account-store.js';
import { createRoutesStore } from '../shared/utils/routes-store.js';

const ROUTING_CONFIG_PATH = path.join(__here, '..', 'shared', 'routing-config.json');

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');
const FORCE = argv.has('--force');

function prefix() { return DRY_RUN ? '[dry-run]' : '[migrate]'; }

function envOr(key, fallback = undefined) {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

function buildTradovateAccount(mode) {
  const accountId = envOr(mode === 'demo' ? 'TRADOVATE_DEMO_ACCOUNT_ID' : 'TRADOVATE_LIVE_ACCOUNT_ID');
  if (!accountId || accountId.startsWith('your_')) return null;

  const credentials = {};
  const username = envOr('TRADOVATE_USERNAME');
  const password = envOr('TRADOVATE_PASSWORD');
  const cid = envOr('TRADOVATE_CID');
  const secret = envOr('TRADOVATE_SEC') || envOr('TRADOVATE_SECRET');
  const appId = envOr('TRADOVATE_APP_ID');

  if (username) credentials.username = username;
  if (password) credentials.password = password;
  if (cid) credentials.cid = cid;
  if (secret) credentials.secret = secret;
  if (appId) credentials.appId = appId;

  const config = {
    mode,
    accountId,
    appVersion: envOr('TRADOVATE_APP_VERSION', '1.0'),
    demoUrl: envOr('TRADOVATE_DEMO_URL', 'https://demo.tradovateapi.com/v1'),
    liveUrl: envOr('TRADOVATE_LIVE_URL', 'https://live.tradovateapi.com/v1'),
    wssDemoUrl: envOr('TRADOVATE_WSS_DEMO_URL', 'wss://md-demo.tradovateapi.com/v1/websocket'),
    wssLiveUrl: envOr('TRADOVATE_WSS_LIVE_URL', 'wss://md.tradovateapi.com/v1/websocket')
  };

  return {
    id: `tradovate-${mode}`,
    displayName: `Tradovate ${mode === 'demo' ? 'Demo' : 'Live'}`,
    broker: 'tradovate',
    enabled: true,
    config,
    credentials
  };
}

function buildPickMyTradeAccount() {
  const enabled = envOr('PICKMYTRADE_ENABLED') === 'true';
  if (!enabled) return null;

  const webhookUrl = envOr('PICKMYTRADE_WEBHOOK_URL');
  const token = envOr('PICKMYTRADE_TOKEN');
  if (!webhookUrl || !token || token.startsWith('your_')) return null;

  const pmtAccountId = envOr('PICKMYTRADE_ACCOUNT_ID');

  return {
    id: 'pickmytrade-prop',
    displayName: 'PickMyTrade Prop Firm',
    broker: 'pickmytrade',
    enabled: true,
    config: {
      webhookUrl,
      ...(pmtAccountId ? { pmtAccountId } : {})
    },
    credentials: { token },
    tracking: { via: 'tradovate-demo' }
  };
}

function loadLegacyRoutingConfig() {
  try {
    const raw = fs.readFileSync(ROUTING_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function buildDestinationMap(plannedAccounts) {
  const ids = new Set(plannedAccounts.map(a => a.id));
  const map = {
    'tradovate-demo': ids.has('tradovate-demo') ? 'tradovate-demo' : null,
    'tradovate-live': ids.has('tradovate-live') ? 'tradovate-live' : null,
    'pickmytrade': ids.has('pickmytrade-prop') ? 'pickmytrade-prop' : null
  };
  map['tradovate'] = map['tradovate-live'] || map['tradovate-demo'];
  return map;
}

function translateDestinationList(list, destMap, warnings) {
  const out = [];
  for (const dest of list || []) {
    const mapped = destMap[dest];
    if (mapped) {
      if (!out.includes(mapped)) out.push(mapped);
    } else {
      warnings.push(`No account for legacy destination "${dest}" — dropping`);
    }
  }
  return out;
}

function translateRoutes(legacyConfig, destMap) {
  const warnings = [];
  if (!legacyConfig) {
    return {
      config: { defaultAccounts: [], routes: {} },
      warnings: ['No routing-config.json found — seeding empty routes']
    };
  }
  const defaultAccounts = translateDestinationList(legacyConfig.defaultDestinations, destMap, warnings);
  const routes = {};
  for (const [strategy, list] of Object.entries(legacyConfig.routes || {})) {
    const ids = translateDestinationList(list, destMap, warnings);
    if (ids.length > 0) routes[strategy] = ids;
  }
  return { config: { defaultAccounts, routes }, warnings };
}

async function migrateAccount(accounts, account) {
  const existing = await accounts.get(account.id);
  if (existing && !FORCE) {
    console.log(`${prefix()} account ${account.id} already exists — skipping (use --force to overwrite)`);
    return 'skipped';
  }

  if (DRY_RUN) {
    const credKeys = Object.keys(account.credentials || {}).join(', ') || '(none)';
    console.log(`${prefix()} would ${existing ? 'UPDATE' : 'CREATE'} account ${account.id} (broker=${account.broker}, creds=[${credKeys}])`);
    return existing ? 'updated' : 'created';
  }

  if (existing) {
    await accounts.update(account.id, account);
    console.log(`${prefix()} updated account ${account.id}`);
    return 'updated';
  }
  await accounts.create(account);
  console.log(`${prefix()} created account ${account.id}`);
  return 'created';
}

async function migrateOrderStrategyMappings(redis, plannedAccounts) {
  // Old: tradovate:${env}:order:strategy:mappings (env = demo | live)
  // New: tradovate:${accountId}:order:strategy:mappings
  const translations = [];
  for (const acct of plannedAccounts) {
    if (acct.broker !== 'tradovate') continue;
    const env = acct.config?.mode;
    if (!env) continue;
    const oldKey = `tradovate:${env}:order:strategy:mappings`;
    const newKey = `tradovate:${acct.id}:order:strategy:mappings`;
    if (oldKey === newKey) continue;
    translations.push({ acct: acct.id, oldKey, newKey });
  }

  if (translations.length === 0) return;

  console.log('');
  console.log(`${prefix()} persisted-state translations:`);
  for (const t of translations) {
    let oldValue;
    try { oldValue = await redis.get(t.oldKey); } catch { oldValue = null; }
    if (!oldValue) {
      console.log(`         ${t.oldKey} → no data, skipping`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`         would copy ${t.oldKey} → ${t.newKey} (${oldValue.length} bytes)`);
      continue;
    }

    const existsAtNew = await redis.get(t.newKey);
    if (existsAtNew && !FORCE) {
      console.log(`         ${t.newKey} already exists — skipping (use --force to overwrite)`);
      continue;
    }

    await redis.set(t.newKey, oldValue);
    console.log(`         copied ${t.oldKey} → ${t.newKey}`);
  }
}

async function migrateRoutes(routesStore, plannedConfig) {
  const existing = await routesStore.get();
  const hasExisting = existing.defaultAccounts.length > 0 || Object.keys(existing.routes).length > 0;

  if (hasExisting && !FORCE) {
    console.log(`${prefix()} routes already present in Redis — skipping (use --force to overwrite)`);
    return 'skipped';
  }

  if (DRY_RUN) {
    console.log(`${prefix()} would write routes:`);
    console.log(`         defaultAccounts: ${JSON.stringify(plannedConfig.defaultAccounts)}`);
    for (const [s, ids] of Object.entries(plannedConfig.routes)) {
      console.log(`         ${s.padEnd(16)} → ${JSON.stringify(ids)}`);
    }
    return 'would-write';
  }

  await routesStore.write(plannedConfig);
  console.log(`${prefix()} routes written`);
  return 'written';
}

async function main() {
  if (!process.env.SLINGSHOT_MASTER_KEY) {
    console.error('SLINGSHOT_MASTER_KEY is not set. Generate one with:');
    console.error('  node scripts/dev-harness/generate-master-key.js');
    process.exit(1);
  }

  const plannedAccounts = [
    buildTradovateAccount('demo'),
    buildTradovateAccount('live'),
    buildPickMyTradeAccount()
  ].filter(Boolean);

  if (plannedAccounts.length === 0) {
    console.error('No accounts could be built from the current env vars. Nothing to migrate.');
    process.exit(1);
  }

  console.log(`${prefix()} planned accounts:`);
  for (const a of plannedAccounts) {
    const credKeys = Object.keys(a.credentials).join(', ');
    console.log(`         ${a.id.padEnd(18)} broker=${a.broker.padEnd(12)} creds=[${credKeys}]`);
  }

  const legacy = loadLegacyRoutingConfig();
  const destMap = buildDestinationMap(plannedAccounts);
  const { config: plannedRoutes, warnings } = translateRoutes(legacy, destMap);
  for (const w of warnings) console.warn(`${prefix()} WARN: ${w}`);

  console.log(`${prefix()} planned routes:`);
  console.log(`         defaultAccounts: ${JSON.stringify(plannedRoutes.defaultAccounts)}`);
  for (const [s, ids] of Object.entries(plannedRoutes.routes)) {
    console.log(`         ${s.padEnd(16)} → ${JSON.stringify(ids)}`);
  }

  await messageBus.connect();
  const redis = messageBus.publisher;
  const accounts = createAccountStore({ redis, messageBus });
  const routes = createRoutesStore({ redis, messageBus });

  console.log('');
  const accountResults = [];
  for (const a of plannedAccounts) {
    accountResults.push({ id: a.id, result: await migrateAccount(accounts, a) });
  }
  const routesResult = await migrateRoutes(routes, plannedRoutes);
  await migrateOrderStrategyMappings(redis, plannedAccounts);

  console.log('');
  console.log(`${prefix()} summary:`);
  for (const r of accountResults) console.log(`         ${r.id.padEnd(18)} ${r.result}`);
  console.log(`         routes:            ${routesResult}`);

  if (DRY_RUN) {
    console.log('\nDry run complete — no changes written. Re-run without --dry-run to apply.');
  } else {
    console.log('\nMigration complete.');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nMigration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
