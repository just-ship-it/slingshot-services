import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactObject } from '../utils/logger-redactor.js';

describe('logger-redactor', () => {
  test('redacts known sensitive keys', () => {
    const input = { username: 'drew', password: 'hunter2', token: 'abc123' };
    const out = redactObject(input);
    assert.equal(out.username, 'drew');
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.token, '[REDACTED]');
  });

  test('redacts case-insensitively and ignores separators', () => {
    const input = { API_KEY: 'k', 'api-secret': 's', PMTToken: 't' };
    const out = redactObject(input);
    assert.equal(out.API_KEY, '[REDACTED]');
    assert.equal(out['api-secret'], '[REDACTED]');
    assert.equal(out.PMTToken, '[REDACTED]');
  });

  test('preserves encrypted blob shape with lastFour', () => {
    const input = {
      password: { ciphertext: 'xx', iv: 'y', tag: 'z', keyVersion: 1, lastFour: '4f2a' }
    };
    const out = redactObject(input);
    assert.deepEqual(out.password, { hasValue: true, lastFour: '4f2a' });
  });

  test('walks nested objects', () => {
    const input = { account: { id: 'a', credentials: { token: 'secret' } } };
    const out = redactObject(input);
    assert.equal(out.account.id, 'a');
    assert.equal(out.account.credentials.token, '[REDACTED]');
  });

  test('walks arrays', () => {
    const input = { accounts: [{ token: 'a' }, { token: 'b' }] };
    const out = redactObject(input);
    assert.equal(out.accounts[0].token, '[REDACTED]');
    assert.equal(out.accounts[1].token, '[REDACTED]');
  });

  test('handles circular references', () => {
    const input = { a: 1 };
    input.self = input;
    const out = redactObject(input);
    assert.equal(out.a, 1);
    assert.equal(out.self, '[Circular]');
  });

  test('respects additionalKeys option', () => {
    const input = { customField: 'sensitive', other: 'fine' };
    const out = redactObject(input, { additionalKeys: ['customField'] });
    assert.equal(out.customField, '[REDACTED]');
    assert.equal(out.other, 'fine');
  });

  test('passes through primitives unchanged', () => {
    assert.equal(redactObject('hello'), 'hello');
    assert.equal(redactObject(42), 42);
    assert.equal(redactObject(null), null);
  });
});
