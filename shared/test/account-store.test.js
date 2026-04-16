import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAccountStore } from '../utils/account-store.js';
import { _resetCacheForTests, isEncryptedBlob } from '../utils/credential-store.js';

const KEY = crypto.randomBytes(32).toString('base64');

function makeFakeRedis() {
  const kv = new Map();
  const sets = new Map();
  return {
    _kv: kv,
    _sets: sets,
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, v); return 'OK'; },
    async del(k) { return kv.delete(k) ? 1 : 0; },
    async sAdd(k, m) {
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k).add(m);
      return 1;
    },
    async sRem(k, m) {
      if (!sets.has(k)) return 0;
      return sets.get(k).delete(m) ? 1 : 0;
    },
    async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; }
  };
}

function makeFakeBus() {
  const events = [];
  return {
    events,
    async publish(channel, payload) {
      events.push({ channel, payload });
    }
  };
}

before(() => {
  process.env.SLINGSHOT_MASTER_KEY = KEY;
  _resetCacheForTests();
});

beforeEach(() => {
  process.env.SLINGSHOT_MASTER_KEY = KEY;
  _resetCacheForTests();
});

describe('account-store', () => {
  test('creates an account and encrypts credential fields', async () => {
    const redis = makeFakeRedis();
    const bus = makeFakeBus();
    const store = createAccountStore({ redis, messageBus: bus });

    const created = await store.create({
      id: 'tradovate-funded',
      displayName: 'Funded Live',
      broker: 'tradovate',
      config: { mode: 'live', accountId: 'A12345' },
      credentials: { username: 'drew', password: 'hunter2' }
    });

    assert.equal(created.id, 'tradovate-funded');
    assert.equal(created.broker, 'tradovate');
    assert.equal(created.credentials.password.hasValue, true);
    assert.equal(created.credentials.password.lastFour, 'ter2');
    // username was treated as a credential field too — also encrypted
    assert.equal(created.credentials.username.hasValue, true);

    // Raw stored value has real ciphertext
    const raw = JSON.parse(redis._kv.get('accounts:tradovate-funded'));
    assert.equal(isEncryptedBlob(raw.credentials.password), true);
    assert.equal(isEncryptedBlob(raw.credentials.username), true);

    // Index updated
    assert.deepEqual(redis._sets.get('accounts:index'), new Set(['tradovate-funded']));

    // Event published
    assert.equal(bus.events[0].channel, 'account.changed');
    assert.equal(bus.events[0].payload.action, 'created');
  });

  test('getDecrypted returns plaintext credentials', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });

    await store.create({
      id: 'pmt-1',
      broker: 'pickmytrade',
      credentials: { token: 'plaintext-token-value' }
    });

    const decrypted = await store.getDecrypted('pmt-1');
    assert.equal(decrypted.credentials.token, 'plaintext-token-value');
  });

  test('get returns redacted credentials by default', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });

    await store.create({
      id: 'pmt-1',
      broker: 'pickmytrade',
      credentials: { token: 'plaintext-token-value' }
    });

    const account = await store.get('pmt-1');
    assert.equal(account.credentials.token.hasValue, true);
    assert.equal(account.credentials.token.lastFour, 'alue');
    assert.equal(account.credentials.token.ciphertext, undefined);
  });

  test('update merges fields and only re-encrypts what is sent', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });

    await store.create({
      id: 'tv-1',
      broker: 'tradovate',
      credentials: { username: 'drew', password: 'old-pass' }
    });

    const before = JSON.parse(redis._kv.get('accounts:tv-1'));

    await store.update('tv-1', { credentials: { password: 'new-pass' } });

    const after = JSON.parse(redis._kv.get('accounts:tv-1'));

    // username untouched (same ciphertext)
    assert.equal(after.credentials.username.ciphertext, before.credentials.username.ciphertext);
    // password rotated (new ciphertext)
    assert.notEqual(after.credentials.password.ciphertext, before.credentials.password.ciphertext);

    const decrypted = await store.getDecrypted('tv-1');
    assert.equal(decrypted.credentials.username, 'drew');
    assert.equal(decrypted.credentials.password, 'new-pass');
  });

  test('update preserves createdAt, refreshes updatedAt', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });

    const created = await store.create({ id: 'tv-1', broker: 'tradovate' });
    await new Promise(r => setTimeout(r, 5));
    const updated = await store.update('tv-1', { displayName: 'Renamed' });

    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.equal(updated.displayName, 'Renamed');
  });

  test('list returns all accounts', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });

    await store.create({ id: 'a', broker: 'tradovate' });
    await store.create({ id: 'b', broker: 'pickmytrade' });

    const all = await store.list();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map(a => a.id).sort(), ['a', 'b']);
  });

  test('remove deletes record and index entry', async () => {
    const redis = makeFakeRedis();
    const bus = makeFakeBus();
    const store = createAccountStore({ redis, messageBus: bus });

    await store.create({ id: 'a', broker: 'tradovate' });
    const removed = await store.remove('a');
    assert.equal(removed, true);
    assert.equal(await store.get('a'), null);
    assert.equal(redis._sets.get('accounts:index').has('a'), false);
    assert.equal(bus.events.find(e => e.payload.action === 'deleted').payload.id, 'a');
  });

  test('create rejects duplicate id', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });
    await store.create({ id: 'a', broker: 'tradovate' });
    await assert.rejects(() => store.create({ id: 'a', broker: 'tradovate' }), /already exists/);
  });

  test('rejects invalid account ids', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });
    await assert.rejects(() => store.create({ id: 'has spaces', broker: 'tradovate' }));
    await assert.rejects(() => store.create({ id: '', broker: 'tradovate' }));
  });

  test('rejects missing broker', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });
    await assert.rejects(() => store.create({ id: 'a' }), /broker is required/);
  });

  test('auto-generates id when not provided', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });
    const created = await store.create({ broker: 'tradovate' });
    assert.match(created.id, /^tradovate-[a-f0-9]{8}$/);
  });

  test('setEnabled toggles the enabled flag', async () => {
    const redis = makeFakeRedis();
    const store = createAccountStore({ redis });
    await store.create({ id: 'a', broker: 'tradovate' });
    const off = await store.setEnabled('a', false);
    assert.equal(off.enabled, false);
    const on = await store.setEnabled('a', true);
    assert.equal(on.enabled, true);
  });
});
