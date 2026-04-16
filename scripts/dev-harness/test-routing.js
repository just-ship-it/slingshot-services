#!/usr/bin/env node
/**
 * End-to-end routing smoke test against a real local Redis.
 *
 * Prereqs:
 *   1. Redis running locally (redis-cli ping → PONG)
 *   2. SLINGSHOT_MASTER_KEY set
 *   3. Ran scripts/dev-harness/seed-dev-accounts.js
 *
 * What it does:
 *   - Loads all accounts from Redis (with decrypted credentials)
 *   - Instantiates a MockConnector per account via the registry
 *   - Resolves account lists for IV_SKEW_GEX, SHORT_DTE_IV, and an
 *     unknown strategy, then calls placeOrder on each
 *   - Prints the list of connector calls so you can see the fan-out
 */

import { messageBus } from '../../shared/index.js';
import { createAccountStore } from '../../shared/utils/account-store.js';
import { createRoutesStore } from '../../shared/utils/routes-store.js';
import { getConnectorClass } from '../../shared/connectors/registry.js';
import './mock-connector.js';
import { drainMockCalls } from './mock-connector.js';

function silentLogger() {
  return {
    info: (...a) => console.log('[info]', ...a),
    warn: (...a) => console.warn('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a),
    debug: () => {}
  };
}

async function main() {
  if (!process.env.SLINGSHOT_MASTER_KEY) {
    console.error('SLINGSHOT_MASTER_KEY is not set.');
    process.exit(1);
  }

  await messageBus.connect();
  const redis = messageBus.publisher;

  const accounts = createAccountStore({ redis });
  const routes = createRoutesStore({ redis });
  const logger = silentLogger();

  const ids = await accounts.listIds();
  const dev = ids.filter(id => id.startsWith('mock-'));
  if (dev.length === 0) {
    console.error('No mock-* accounts found. Run seed-dev-accounts.js first.');
    process.exit(1);
  }

  // Build connector map keyed by account id
  const connectors = new Map();
  const connectorLookup = (id) => connectors.get(id);
  for (const id of dev) {
    const acct = await accounts.getDecrypted(id);
    const Cls = getConnectorClass(acct.broker);
    if (!Cls) {
      console.error(`No connector registered for broker=${acct.broker}`);
      continue;
    }
    const conn = new Cls(acct, logger, { connectorLookup });
    await conn.init();
    connectors.set(id, conn);
  }

  // Simulated order — what signal-generator would publish
  const order = {
    action: 'Buy',
    symbol: 'MNQM6',
    quantity: 1,
    orderType: 'Limit',
    price: 25000,
    stopPrice: 24900,
    takeProfit: 25100,
    strategy: null  // filled in per test
  };

  async function fanOut(strategy) {
    const targets = await routes.resolve(strategy);
    console.log(`\n  resolve(${strategy}) → ${JSON.stringify(targets)}`);
    const results = await Promise.allSettled(
      targets.map(id => connectors.get(id)?.placeOrder({ ...order, strategy }))
    );
    results.forEach((r, i) => {
      const state = r.status === 'fulfilled' ? 'OK' : `FAIL(${r.reason?.message || r.reason})`;
      console.log(`    → ${targets[i].padEnd(12)} ${state}`);
    });
  }

  drainMockCalls();
  console.log('\n=== Routing fan-out tests ===');
  await fanOut('IV_SKEW_GEX');
  await fanOut('SHORT_DTE_IV');
  await fanOut('UNKNOWN_STRATEGY');  // should hit defaultAccounts

  const calls = drainMockCalls();
  console.log(`\n=== ${calls.length} connector calls recorded ===`);
  for (const c of calls) {
    console.log(`  [${c.accountId}] ${c.method} ${c.args.strategy || ''}`);
  }

  // Shutdown
  for (const c of connectors.values()) await c.shutdown();

  const expected = {
    IV_SKEW_GEX: ['mock-live', 'mock-pmt'],
    SHORT_DTE_IV: ['mock-pmt'],
    UNKNOWN_STRATEGY: ['mock-demo']
  };
  let fail = 0;
  for (const [strategy, acctIds] of Object.entries(expected)) {
    const actual = calls.filter(c => c.args.strategy === strategy).map(c => c.accountId).sort();
    const want = [...acctIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      console.error(`FAIL ${strategy}: expected ${JSON.stringify(want)} got ${JSON.stringify(actual)}`);
      fail++;
    }
  }
  if (fail === 0) {
    console.log('\nAll fan-out assertions passed.');
    process.exit(0);
  } else {
    console.error(`\n${fail} assertions failed.`);
    process.exit(1);
  }
}

main().then((code) => process.exit(code || 0)).catch(err => {
  console.error(err);
  process.exit(1);
});
