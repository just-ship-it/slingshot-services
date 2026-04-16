import crypto from 'crypto';
import { encrypt, decrypt, isEncryptedBlob, redact } from './credential-store.js';

const ACCOUNT_KEY_PREFIX = 'accounts:';
const ACCOUNT_INDEX_KEY = 'accounts:index';
const ACCOUNT_CHANGED_CHANNEL = 'account.changed';

function accountKey(id) {
  return `${ACCOUNT_KEY_PREFIX}${id}`;
}

function nowIso() {
  return new Date().toISOString();
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error(`Invalid account id: ${id}. Use 1–64 chars, alphanumeric/underscore/hyphen.`);
  }
}

function validateBroker(broker) {
  if (typeof broker !== 'string' || broker.length === 0) {
    throw new Error('Account broker is required (e.g. "tradovate", "pickmytrade")');
  }
}

function encryptCredentials(creds = {}) {
  const out = {};
  for (const [k, v] of Object.entries(creds)) {
    if (v === null || v === undefined || v === '') {
      continue;
    }
    if (isEncryptedBlob(v)) {
      out[k] = v;
    } else {
      out[k] = encrypt(v);
    }
  }
  return out;
}

function redactCredentials(creds = {}) {
  const out = {};
  for (const [k, v] of Object.entries(creds)) {
    out[k] = isEncryptedBlob(v) ? redact(v) : v;
  }
  return out;
}

function decryptCredentials(creds = {}) {
  const out = {};
  for (const [k, v] of Object.entries(creds)) {
    out[k] = isEncryptedBlob(v) ? decrypt(v) : v;
  }
  return out;
}

function buildRecord(input, existing = null) {
  const record = {
    id: input.id || existing?.id,
    displayName: input.displayName ?? existing?.displayName ?? input.id,
    broker: input.broker || existing?.broker,
    enabled: input.enabled ?? existing?.enabled ?? true,
    config: { ...(existing?.config || {}), ...(input.config || {}) },
    credentials: encryptCredentials({
      ...(existing?.credentials || {}),
      ...(input.credentials || {})
    }),
    tracking: input.tracking ?? existing?.tracking ?? null,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  validateId(record.id);
  validateBroker(record.broker);
  return record;
}

export function createAccountStore({ redis, messageBus = null, logger = console }) {
  if (!redis) throw new Error('createAccountStore: redis client is required');

  async function publishChange(action, id) {
    if (!messageBus) return;
    try {
      await messageBus.publish(ACCOUNT_CHANGED_CHANNEL, { action, id, timestamp: nowIso() });
    } catch (err) {
      logger.warn?.(`account-store: failed to publish change event: ${err.message}`);
    }
  }

  async function readRaw(id) {
    const raw = await redis.get(accountKey(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`account-store: corrupt JSON for account ${id}: ${err.message}`);
    }
  }

  async function listIds() {
    const ids = await redis.sMembers(ACCOUNT_INDEX_KEY);
    return ids.sort();
  }

  async function list() {
    const ids = await listIds();
    const accounts = await Promise.all(ids.map(id => get(id)));
    return accounts.filter(Boolean);
  }

  async function get(id) {
    const record = await readRaw(id);
    if (!record) return null;
    return {
      ...record,
      credentials: redactCredentials(record.credentials || {})
    };
  }

  async function getDecrypted(id) {
    const record = await readRaw(id);
    if (!record) return null;
    return {
      ...record,
      credentials: decryptCredentials(record.credentials || {})
    };
  }

  async function create(input) {
    if (input.id === undefined) {
      input = { ...input, id: `${input.broker || 'account'}-${crypto.randomBytes(4).toString('hex')}` };
    }
    const existing = await readRaw(input.id);
    if (existing) {
      throw new Error(`Account ${input.id} already exists`);
    }
    const record = buildRecord(input);
    await redis.set(accountKey(record.id), JSON.stringify(record));
    await redis.sAdd(ACCOUNT_INDEX_KEY, record.id);
    await publishChange('created', record.id);
    return get(record.id);
  }

  async function update(id, patch) {
    validateId(id);
    const existing = await readRaw(id);
    if (!existing) {
      throw new Error(`Account ${id} not found`);
    }
    const record = buildRecord({ ...patch, id, broker: patch.broker || existing.broker }, existing);
    await redis.set(accountKey(id), JSON.stringify(record));
    await publishChange('updated', id);
    return get(id);
  }

  async function remove(id) {
    validateId(id);
    const existed = (await redis.del(accountKey(id))) > 0;
    await redis.sRem(ACCOUNT_INDEX_KEY, id);
    if (existed) {
      await publishChange('deleted', id);
    }
    return existed;
  }

  async function setEnabled(id, enabled) {
    return update(id, { enabled: !!enabled });
  }

  return {
    list,
    listIds,
    get,
    getDecrypted,
    create,
    update,
    remove,
    setEnabled,
    CHANNEL: ACCOUNT_CHANGED_CHANNEL
  };
}

export const ACCOUNT_CHANNEL = ACCOUNT_CHANGED_CHANNEL;
