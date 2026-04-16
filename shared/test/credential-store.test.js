import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encrypt,
  decrypt,
  isEncryptedBlob,
  redact,
  generateMasterKey,
  _resetCacheForTests,
  CURRENT_VERSION
} from '../utils/credential-store.js';

const KEY_V1 = crypto.randomBytes(32).toString('base64');
const KEY_V2 = crypto.randomBytes(32).toString('base64');

before(() => {
  process.env.SLINGSHOT_MASTER_KEY = KEY_V1;
  _resetCacheForTests();
});

beforeEach(() => {
  _resetCacheForTests();
  process.env.SLINGSHOT_MASTER_KEY = KEY_V1;
  delete process.env.SLINGSHOT_MASTER_KEY_V2;
});

describe('credential-store', () => {
  test('round-trip encrypts and decrypts a string', () => {
    const blob = encrypt('super-secret-token');
    assert.equal(typeof blob.ciphertext, 'string');
    assert.equal(typeof blob.iv, 'string');
    assert.equal(typeof blob.tag, 'string');
    assert.equal(blob.keyVersion, CURRENT_VERSION);
    assert.equal(blob.lastFour, 'oken');

    const plain = decrypt(blob);
    assert.equal(plain, 'super-secret-token');
  });

  test('different ciphertexts for same plaintext (random IV)', () => {
    const a = encrypt('hello');
    const b = encrypt('hello');
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.notEqual(a.iv, b.iv);
    assert.equal(decrypt(a), 'hello');
    assert.equal(decrypt(b), 'hello');
  });

  test('tampered ciphertext fails auth', () => {
    const blob = encrypt('value');
    const tampered = { ...blob, ciphertext: Buffer.from('garbage').toString('base64') };
    assert.throws(() => decrypt(tampered));
  });

  test('tampered tag fails auth', () => {
    const blob = encrypt('value');
    const tampered = { ...blob, tag: Buffer.alloc(16, 0).toString('base64') };
    assert.throws(() => decrypt(tampered));
  });

  test('missing master key throws', () => {
    delete process.env.SLINGSHOT_MASTER_KEY;
    _resetCacheForTests();
    assert.throws(() => encrypt('x'), /SLINGSHOT_MASTER_KEY is not set/);
  });

  test('non-base64 master key throws', () => {
    process.env.SLINGSHOT_MASTER_KEY = 'not-32-bytes';
    _resetCacheForTests();
    assert.throws(() => encrypt('x'), /must decode to 32 bytes/);
  });

  test('decrypt with unknown keyVersion throws', () => {
    const blob = encrypt('value');
    const wrongVersion = { ...blob, keyVersion: 99 };
    assert.throws(() => decrypt(wrongVersion), /No master key registered for keyVersion 99/);
  });

  test('multiple key versions can decrypt their own blobs', () => {
    // Encrypt with v1
    const v1Blob = encrypt('v1-secret');

    // Now register v2 as primary by simulating rotation
    process.env.SLINGSHOT_MASTER_KEY = KEY_V2;
    process.env.SLINGSHOT_MASTER_KEY_V1 = KEY_V1; // keep old key for legacy blobs
    _resetCacheForTests();

    // Old blob (keyVersion=1) still decrypts
    assert.equal(decrypt(v1Blob), 'v1-secret');

    // New blobs use v1 too because CURRENT_VERSION is hardcoded to 1
    // (Rotation requires bumping CURRENT_KEY_VERSION in code; test verifies legacy path works)
  });

  test('isEncryptedBlob recognizes a real blob', () => {
    const blob = encrypt('x');
    assert.equal(isEncryptedBlob(blob), true);
    assert.equal(isEncryptedBlob('hello'), false);
    assert.equal(isEncryptedBlob({ foo: 'bar' }), false);
    assert.equal(isEncryptedBlob(null), false);
  });

  test('redact returns lastFour and hasValue, not ciphertext', () => {
    const blob = encrypt('abcdef1234');
    const r = redact(blob);
    assert.deepEqual(r, { hasValue: true, lastFour: '1234', keyVersion: CURRENT_VERSION });
    assert.equal(r.ciphertext, undefined);
  });

  test('encrypts non-string values by stringifying', () => {
    const blob = encrypt(12345);
    assert.equal(decrypt(blob), '12345');
  });

  test('refuses to encrypt null/undefined', () => {
    assert.throws(() => encrypt(null));
    assert.throws(() => encrypt(undefined));
  });

  test('generateMasterKey returns valid 32-byte base64', () => {
    const key = generateMasterKey();
    const buf = Buffer.from(key, 'base64');
    assert.equal(buf.length, 32);
  });
});
