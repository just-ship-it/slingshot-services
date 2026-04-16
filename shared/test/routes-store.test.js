import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRoutesStore } from '../utils/routes-store.js';

function makeFakeRedis() {
  const kv = new Map();
  return {
    _kv: kv,
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, v); return 'OK'; },
    async del(k) { return kv.delete(k) ? 1 : 0; }
  };
}

function makeFakeBus() {
  const events = [];
  return { events, async publish(channel, payload) { events.push({ channel, payload }); } };
}

describe('routes-store', () => {
  test('get returns empty default when nothing stored', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    const config = await store.get();
    assert.deepEqual(config.defaultAccounts, []);
    assert.deepEqual(config.routes, {});
  });

  test('setRoute persists and publishes change event', async () => {
    const redis = makeFakeRedis();
    const bus = makeFakeBus();
    const store = createRoutesStore({ redis, messageBus: bus });

    const updated = await store.setRoute('IV_SKEW_GEX', ['tv-funded', 'pmt-prop']);
    assert.deepEqual(updated.routes.IV_SKEW_GEX, ['tv-funded', 'pmt-prop']);

    const raw = JSON.parse(redis._kv.get('routes:config'));
    assert.deepEqual(raw.routes.IV_SKEW_GEX, ['tv-funded', 'pmt-prop']);

    assert.equal(bus.events.length, 1);
    assert.equal(bus.events[0].channel, 'routes.changed');
    assert.equal(bus.events[0].payload.action, 'route_updated');
  });

  test('setRoute with empty list deletes the strategy entry', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await store.setRoute('X', ['a']);
    const after = await store.setRoute('X', []);
    assert.equal(after.routes.X, undefined);
  });

  test('addAccountToStrategy is idempotent', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await store.addAccountToStrategy('IV_SKEW_GEX', 'tv-funded');
    await store.addAccountToStrategy('IV_SKEW_GEX', 'tv-funded');
    const config = await store.get();
    assert.deepEqual(config.routes.IV_SKEW_GEX, ['tv-funded']);
  });

  test('removeAccountFromStrategy removes only the targeted id', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await store.setRoute('IV_SKEW_GEX', ['tv-funded', 'pmt-prop']);
    await store.removeAccountFromStrategy('IV_SKEW_GEX', 'tv-funded');
    const config = await store.get();
    assert.deepEqual(config.routes.IV_SKEW_GEX, ['pmt-prop']);
  });

  test('resolve returns explicit route when present', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await store.setDefaults(['fallback-acct']);
    await store.setRoute('IV_SKEW_GEX', ['tv-funded']);
    const resolved = await store.resolve('IV_SKEW_GEX');
    assert.deepEqual(resolved, ['tv-funded']);
  });

  test('resolve falls back to defaultAccounts for unknown strategy', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await store.setDefaults(['fallback-acct']);
    const resolved = await store.resolve('UNKNOWN');
    assert.deepEqual(resolved, ['fallback-acct']);
  });

  test('resolve returns empty list when nothing is configured', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    const resolved = await store.resolve('X');
    assert.deepEqual(resolved, []);
  });

  test('rejects non-string account ids', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await assert.rejects(() => store.setRoute('X', [123]), /non-empty strings/);
  });

  test('write replaces the entire config', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await store.setRoute('A', ['x']);
    const replaced = await store.write({ defaultAccounts: ['d'], routes: { B: ['y'] } });
    assert.deepEqual(replaced.defaultAccounts, ['d']);
    assert.deepEqual(replaced.routes, { B: ['y'] });
    assert.equal(replaced.routes.A, undefined);
  });

  test('deleteRoute removes strategy entry', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await store.setRoute('A', ['x']);
    await store.deleteRoute('A');
    const config = await store.get();
    assert.equal(config.routes.A, undefined);
  });

  test('corrupt JSON in Redis throws with context', async () => {
    const redis = makeFakeRedis();
    redis._kv.set('routes:config', '{not json');
    const store = createRoutesStore({ redis });
    await assert.rejects(() => store.get(), /corrupt JSON/);
  });

  test('bootstrapFromFile translates legacy destination strings to account ids', async () => {
    const tmp = path.join(os.tmpdir(), `routes-legacy-${Date.now()}.json`);
    await fs.writeFile(tmp, JSON.stringify({
      defaultDestinations: ['tradovate-demo', 'pickmytrade'],
      routes: {
        IV_SKEW_GEX: ['tradovate-live', 'pickmytrade'],
        SHORT_DTE_IV: ['pickmytrade']
      }
    }));

    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    const result = await store.bootstrapFromFile({
      'tradovate-live': 'tv-funded',
      'tradovate-demo': 'tv-demo',
      pickmytrade: 'pmt-prop'
    }, tmp);

    assert.equal(result.bootstrapped, true);
    assert.deepEqual(result.config.defaultAccounts, ['tv-demo', 'pmt-prop']);
    assert.deepEqual(result.config.routes.IV_SKEW_GEX, ['tv-funded', 'pmt-prop']);
    assert.deepEqual(result.config.routes.SHORT_DTE_IV, ['pmt-prop']);

    await fs.unlink(tmp);
  });

  test('bootstrapFromFile is a no-op if routes already exist', async () => {
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    await store.setRoute('X', ['a']);
    const result = await store.bootstrapFromFile({}, '/nonexistent');
    assert.equal(result.bootstrapped, false);
    assert.match(result.reason, /already present/);
  });

  test('bootstrapFromFile drops unknown destinations silently', async () => {
    const tmp = path.join(os.tmpdir(), `routes-partial-${Date.now()}.json`);
    await fs.writeFile(tmp, JSON.stringify({
      defaultDestinations: ['unknown-dest', 'pickmytrade'],
      routes: { X: ['tradovate-live', 'mystery'] }
    }));
    const redis = makeFakeRedis();
    const store = createRoutesStore({ redis });
    const result = await store.bootstrapFromFile({
      pickmytrade: 'pmt-prop',
      'tradovate-live': 'tv-live'
    }, tmp);
    assert.deepEqual(result.config.defaultAccounts, ['pmt-prop']);
    assert.deepEqual(result.config.routes.X, ['tv-live']);
    await fs.unlink(tmp);
  });
});
