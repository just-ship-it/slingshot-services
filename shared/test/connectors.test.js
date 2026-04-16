import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BaseConnector } from '../connectors/base-connector.js';
import {
  registerConnector,
  getConnectorClass,
  listBrokers,
  listSchemas,
  _resetRegistryForTests
} from '../connectors/registry.js';

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

describe('BaseConnector', () => {
  test('cannot be instantiated directly', () => {
    assert.throws(() => new BaseConnector({ id: 'x' }, silentLogger()), /abstract/);
  });

  test('subclass must provide account.id and logger', () => {
    class C extends BaseConnector {}
    assert.throws(() => new C(null, silentLogger()), /account record/);
    assert.throws(() => new C({ id: 'a' }, null), /logger/);
  });

  test('abstract methods throw NOT_IMPLEMENTED', async () => {
    class C extends BaseConnector {}
    const c = new C({ id: 'a' }, silentLogger());
    await assert.rejects(() => c.init(), /must be implemented/);
    await assert.rejects(() => c.placeOrder({}), /must be implemented/);
    await assert.rejects(() => c.cancelOrder('1'), /must be implemented/);
  });

  test('default healthCheck reports ready flag', async () => {
    class C extends BaseConnector {}
    const c = new C({ id: 'a' }, silentLogger());
    let h = await c.healthCheck();
    assert.equal(h.ok, false);
    c.ready = true;
    h = await c.healthCheck();
    assert.equal(h.ok, true);
  });

  test('static descriptors must be overridden', () => {
    class C extends BaseConnector {}
    assert.throws(() => C.brokerKey(), /brokerKey/);
    assert.throws(() => C.displayName(), /displayName/);
    assert.throws(() => C.credentialSchema(), /credentialSchema/);
  });
});

describe('Connector registry', () => {
  beforeEach(() => _resetRegistryForTests());

  test('rejects classes that do not extend BaseConnector', () => {
    class NotAConnector { static brokerKey() { return 'foo'; } }
    assert.throws(() => registerConnector(NotAConnector), /extend BaseConnector/);
  });

  test('registers and looks up by broker key', () => {
    class FakeConn extends BaseConnector {
      static brokerKey() { return 'fake'; }
      static displayName() { return 'Fake Broker'; }
      static credentialSchema() { return { fields: [] }; }
    }
    registerConnector(FakeConn);
    assert.equal(getConnectorClass('fake'), FakeConn);
    assert.deepEqual(listBrokers(), ['fake']);
    const schemas = listSchemas();
    assert.equal(schemas.fake.displayName, 'Fake Broker');
    assert.equal(schemas.fake.brokerKey, 'fake');
  });
});

describe('PickMyTradeConnector', () => {
  beforeEach(() => _resetRegistryForTests());

  test('builds order payload and POSTs to webhook URL', async () => {
    const { PickMyTradeConnector } = await import('../connectors/pickmytrade-connector.js');
    const calls = [];
    const fakeFetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, text: async () => 'ok' };
    };

    const account = {
      id: 'pmt-prop',
      broker: 'pickmytrade',
      config: { webhookUrl: 'https://pmt.example/hook', pmtAccountId: 'PA-1' },
      credentials: { token: 'secret-token' }
    };
    const conn = new PickMyTradeConnector(account, silentLogger(), { fetch: fakeFetch });
    await conn.init();

    const result = await conn.placeOrder({
      symbol: 'MNQM6', action: 'Buy', quantity: 2, orderType: 'Limit',
      price: 25000, stopPrice: 24900, takeProfit: 25100, strategy: 'IV_SKEW_GEX'
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://pmt.example/hook');
    assert.equal(calls[0].body.symbol, 'MNQ');
    assert.equal(calls[0].body.data, 'buy');
    assert.equal(calls[0].body.quantity, 2);
    assert.equal(calls[0].body.price, 25000);
    assert.equal(calls[0].body.order_type, 'LMT');
    assert.equal(calls[0].body.sl, 24900);
    assert.equal(calls[0].body.tp, 25100);
    assert.equal(calls[0].body.token, 'secret-token');
    assert.equal(calls[0].body.account_id, 'PA-1');
  });

  test('market order sets price=0 and order_type=MKT', async () => {
    const { PickMyTradeConnector } = await import('../connectors/pickmytrade-connector.js');
    const calls = [];
    const fakeFetch = async (_u, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const conn = new PickMyTradeConnector(
      { id: 'pmt', broker: 'pickmytrade', config: { webhookUrl: 'https://x' }, credentials: { token: 't' } },
      silentLogger(),
      { fetch: fakeFetch }
    );
    await conn.init();
    await conn.placeOrder({ symbol: 'NQM6', action: 'Sell', quantity: 1, orderType: 'Market', price: 25000 });
    assert.equal(calls[0].order_type, 'MKT');
    assert.equal(calls[0].price, 0);
    assert.equal(calls[0].data, 'sell');
  });

  test('closePosition emits close payload', async () => {
    const { PickMyTradeConnector } = await import('../connectors/pickmytrade-connector.js');
    const calls = [];
    const fakeFetch = async (_u, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const conn = new PickMyTradeConnector(
      { id: 'pmt', broker: 'pickmytrade', config: { webhookUrl: 'https://x' }, credentials: { token: 't' } },
      silentLogger(),
      { fetch: fakeFetch }
    );
    await conn.init();
    await conn.closePosition('MNQM6');
    assert.equal(calls[0].data, 'close');
    assert.equal(calls[0].symbol, 'MNQ');
  });

  test('init throws when token missing', async () => {
    const { PickMyTradeConnector } = await import('../connectors/pickmytrade-connector.js');
    const conn = new PickMyTradeConnector(
      { id: 'pmt', broker: 'pickmytrade', config: { webhookUrl: 'https://x' }, credentials: {} },
      silentLogger(),
      { fetch: async () => ({}) }
    );
    await assert.rejects(() => conn.init(), /token missing/);
  });

  test('mirrors order to tracking account when configured', async () => {
    const { PickMyTradeConnector } = await import('../connectors/pickmytrade-connector.js');
    const fakeFetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
    const mirrorCalls = [];
    const mirror = {
      placeOrder: async (order) => { mirrorCalls.push(order); return { mirrored: true }; }
    };
    const conn = new PickMyTradeConnector(
      {
        id: 'pmt-prop',
        broker: 'pickmytrade',
        config: { webhookUrl: 'https://x' },
        credentials: { token: 't' },
        tracking: { via: 'tradovate-demo' }
      },
      silentLogger(),
      { fetch: fakeFetch, connectorLookup: (id) => id === 'tradovate-demo' ? mirror : null }
    );
    await conn.init();
    await conn.placeOrder({ symbol: 'NQM6', action: 'Buy', quantity: 1, orderType: 'Limit', price: 25000 });
    assert.equal(mirrorCalls.length, 1);
    assert.equal(mirrorCalls[0].symbol, 'NQM6');
  });

  test('mirror failure does not break primary placeOrder', async () => {
    const { PickMyTradeConnector } = await import('../connectors/pickmytrade-connector.js');
    const fakeFetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
    const mirror = { placeOrder: async () => { throw new Error('mirror down'); } };
    const conn = new PickMyTradeConnector(
      {
        id: 'pmt', broker: 'pickmytrade',
        config: { webhookUrl: 'https://x' },
        credentials: { token: 't' },
        tracking: { via: 'tradovate-demo' }
      },
      silentLogger(),
      { fetch: fakeFetch, connectorLookup: () => mirror }
    );
    await conn.init();
    const result = await conn.placeOrder({ symbol: 'NQM6', action: 'Buy', quantity: 1, orderType: 'Limit' });
    assert.equal(result.success, true);
  });
});

describe('TradovateConnector', () => {
  beforeEach(() => _resetRegistryForTests());

  test('credentialSchema lists expected fields', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    const schema = TradovateConnector.credentialSchema();
    const keys = schema.fields.map(f => f.key);
    assert.ok(keys.includes('username'));
    assert.ok(keys.includes('password'));
    const configKeys = schema.configFields.map(f => f.key);
    assert.ok(configKeys.includes('mode'));
    assert.ok(configKeys.includes('accountId'));
  });

  test('init creates client, connect succeeds, ready=true', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    let constructed = null;
    class FakeClient {
      constructor(cfg) { this.cfg = cfg; constructed = cfg; this.isConnected = false; this.accessToken = null; }
      async connect() { this.isConnected = true; this.accessToken = 'tok'; }
      async placeOrder(o) { return { orderId: 99, sent: o }; }
      async cancelOrder(id) { return { cancelled: id }; }
      async getPositions(accId) { return [{ accountId: accId, qty: 1 }]; }
    }

    const account = {
      id: 'tv-funded',
      broker: 'tradovate',
      config: { mode: 'live', accountId: 12345 },
      credentials: { username: 'drew', password: 'pw' }
    };
    const conn = new TradovateConnector(account, silentLogger(), {
      ClientClass: FakeClient, messageBus: {}, channels: {}
    });
    await conn.init();
    assert.equal(conn.ready, true);
    assert.equal(constructed.useDemo, false);
    assert.equal(constructed.username, 'drew');
    assert.equal(constructed.defaultAccountId, 12345);

    const placed = await conn.placeOrder({ symbol: 'NQM6', action: 'Buy', quantity: 1 });
    assert.equal(placed.orderId, 99);

    const cancelled = await conn.cancelOrder('42');
    assert.equal(cancelled.cancelled, '42');

    const positions = await conn.getPositions();
    assert.equal(positions[0].accountId, 12345);
  });

  test('demo mode sets useDemo=true', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    let constructed = null;
    class FakeClient {
      constructor(cfg) { constructed = cfg; }
      async connect() {}
    }
    const conn = new TradovateConnector(
      { id: 'tv-demo', broker: 'tradovate', config: { mode: 'demo', accountId: 1 }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: {}, channels: {} }
    );
    await conn.init();
    assert.equal(constructed.useDemo, true);
  });

  test('placeOrder before init throws', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    class FakeClient { async connect() {} }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo' }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: {}, channels: {} }
    );
    await assert.rejects(() => conn.placeOrder({}), /not initialized/);
  });

  test('healthCheck reflects ready + isConnected', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    class FakeClient {
      constructor() { this.isConnected = false; this.accessToken = null; }
      async connect() { this.isConnected = true; this.accessToken = 't'; }
    }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo' }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: {}, channels: {} }
    );
    let h = await conn.healthCheck();
    assert.equal(h.ok, false);
    await conn.init();
    h = await conn.healthCheck();
    assert.equal(h.ok, true);
  });

  test('throws when required deps missing', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    assert.throws(() => new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: {}, credentials: {} },
      silentLogger(),
      {}
    ), /ClientClass/);
  });
});
