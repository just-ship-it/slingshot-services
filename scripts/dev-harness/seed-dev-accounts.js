#!/usr/bin/env node
/**
 * Seed a local dev Redis with mock accounts + a routing table that
 * exercises the new infrastructure end-to-end without real credentials.
 *
 * Usage:
 *   SLINGSHOT_MASTER_KEY=... node scripts/dev-harness/seed-dev-accounts.js
 *   # Idempotent: re-running overwrites account records but preserves
 *   # non-dev accounts.
 *
 * What it creates:
 *   accounts:
 *     mock-live        (broker=mock, represents a "live" Tradovate)
 *     mock-demo        (broker=mock, represents a "demo" Tradovate)
 *     mock-pmt         (broker=mock, represents PickMyTrade prop firm)
 *   routes:
 *     IV_SKEW_GEX      → [mock-live, mock-pmt]
 *     SHORT_DTE_IV     → [mock-pmt]
 *     defaultAccounts  → [mock-demo]
 */

import { messageBus } from '../../shared/index.js';
import { createAccountStore } from '../../shared/utils/account-store.js';
import { createRoutesStore } from '../../shared/utils/routes-store.js';
import './mock-connector.js';

const DEV_ACCOUNT_IDS = ['mock-live', 'mock-demo', 'mock-pmt'];

async function main() {
  if (!process.env.SLINGSHOT_MASTER_KEY) {
    console.error('SLINGSHOT_MASTER_KEY is not set. Run:');
    console.error('  node scripts/dev-harness/generate-master-key.js');
    process.exit(1);
  }

  await messageBus.connect();
  const redis = messageBus.publisher;

  const accounts = createAccountStore({ redis, messageBus });
  const routes = createRoutesStore({ redis, messageBus });

  // Clear any stale dev accounts first so create() doesn't complain
  for (const id of DEV_ACCOUNT_IDS) {
    await accounts.remove(id).catch(() => {});
  }

  await accounts.create({
    id: 'mock-live',
    displayName: 'Mock Funded Live',
    broker: 'mock',
    config: { simulateLatencyMs: 50 },
    credentials: { apiKey: 'dev-fake-live-key' }
  });

  await accounts.create({
    id: 'mock-demo',
    displayName: 'Mock Demo',
    broker: 'mock',
    config: { simulateLatencyMs: 30 },
    credentials: { apiKey: 'dev-fake-demo-key' }
  });

  await accounts.create({
    id: 'mock-pmt',
    displayName: 'Mock Prop Firm (via PMT)',
    broker: 'mock',
    config: { simulateLatencyMs: 100 },
    credentials: { apiKey: 'dev-fake-pmt-token' },
    tracking: { via: 'mock-demo' }
  });

  await routes.write({
    defaultAccounts: ['mock-demo'],
    routes: {
      IV_SKEW_GEX: ['mock-live', 'mock-pmt'],
      SHORT_DTE_IV: ['mock-pmt']
    }
  });

  const all = await accounts.list();
  const cfg = await routes.get();

  console.log('\n=== Seeded dev accounts ===');
  for (const a of all) {
    const credKeys = Object.keys(a.credentials || {}).join(', ') || '(none)';
    console.log(`  ${a.id.padEnd(12)}  broker=${a.broker.padEnd(10)}  enabled=${a.enabled}  creds=[${credKeys}]`);
  }

  console.log('\n=== Routes ===');
  console.log(`  defaultAccounts: ${JSON.stringify(cfg.defaultAccounts)}`);
  for (const [s, ids] of Object.entries(cfg.routes)) {
    console.log(`  ${s.padEnd(16)} → ${JSON.stringify(ids)}`);
  }

  console.log('\nDone. Next: node scripts/dev-harness/test-routing.js');
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
