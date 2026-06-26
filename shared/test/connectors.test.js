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

// Minimal fake messageBus + channels for connector tests that exercise init().
function fakeBus() {
  return {
    publish: async () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
  };
}
function fakeChannels() {
  return {
    ORDER_PLACED: 'order.placed',
    ORDER_FILLED: 'order.filled',
    ORDER_REJECTED: 'order.rejected',
    ORDER_CANCELLED: 'order.cancelled',
    POSITION_OPENED: 'position.opened',
    POSITION_CLOSED: 'position.closed',
    POSITION_SNAPSHOT: 'position.snapshot',
    ORDERS_SNAPSHOT: 'orders.snapshot',
    PRICE_UPDATE: 'price.update',
  };
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
      credentials: { token: 'FAKE_PMT_TOKEN' }
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
    assert.equal(calls[0].body.token, 'FAKE_PMT_TOKEN');
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

  // ── Strategy-attribution tagging (2026-05-27) ─────────────────────────────
  // Verified live on demo: text + clOrdId round-trip via OrderVersion + Command.
  // These tests pin the parser shape and the cache-miss recovery wiring so the
  // attribution-loss bug from 16:13–16:16 stays fixed.

  test('_buildOrderTag returns signalId when present and short enough', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    class FakeClient { async connect() {} }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo', accountId: 1 }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: {}, channels: {} }
    );
    assert.equal(conn._buildOrderTag({ signalId: 'GEX_LT_3M_CROSSOVER-short-29990.75-1779898382960' }),
      'GEX_LT_3M_CROSSOVER-short-29990.75-1779898382960');
    assert.equal(conn._buildOrderTag({}), null);
    assert.equal(conn._buildOrderTag({ signalId: '' }), null);
    // 65 chars — exceeds bracket-child headroom (60 cap so ".sl"/".tp" fit in 64).
    assert.equal(conn._buildOrderTag({ signalId: 'x'.repeat(65) }), null);
  });

  test('_parseStrategyFromText decodes orchestrator signalId shape', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    class FakeClient { async connect() {} }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo', accountId: 1 }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: {}, channels: {} }
    );
    // Canonical shape
    assert.deepEqual(
      conn._parseStrategyFromText('GEX_LT_3M_CROSSOVER-short-29990.75-1779898382960'),
      { strategy: 'GEX_LT_3M_CROSSOVER', signalId: 'GEX_LT_3M_CROSSOVER-short-29990.75-1779898382960' }
    );
    // Strategy with hyphens — non-greedy first segment, direction segment anchors
    assert.deepEqual(
      conn._parseStrategyFromText('LS-FLIP-TRIGGER-BAR-long-21050.5-1700000000000'),
      { strategy: 'LS-FLIP-TRIGGER-BAR', signalId: 'LS-FLIP-TRIGGER-BAR-long-21050.5-1700000000000' }
    );
    // Bracket child clOrdId suffix is stripped before decoding
    assert.deepEqual(
      conn._parseStrategyFromText('GEX_FLIP_IVPCT-long-30000-123.sl'),
      { strategy: 'GEX_FLIP_IVPCT', signalId: 'GEX_FLIP_IVPCT-long-30000-123' }
    );
    assert.deepEqual(
      conn._parseStrategyFromText('GEX_FLIP_IVPCT-long-30000-123.tp'),
      { strategy: 'GEX_FLIP_IVPCT', signalId: 'GEX_FLIP_IVPCT-long-30000-123' }
    );
    // Non-matching shape — return text as signalId, no strategy. Avoids attributing
    // manually-placed orders to a real strategy and triggering automated lifecycle.
    assert.deepEqual(conn._parseStrategyFromText('FILLTEST-1779907636745'),
      { strategy: null, signalId: 'FILLTEST-1779907636745' });
    assert.deepEqual(conn._parseStrategyFromText(''), { strategy: null, signalId: null });
    assert.deepEqual(conn._parseStrategyFromText(null), { strategy: null, signalId: null });
    assert.deepEqual(conn._parseStrategyFromText(undefined), { strategy: null, signalId: null });
  });

  test('_recoverFromOrderText pulls OrderVersion.text, decodes, rehydrates maps', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    let fetchCalls = 0;
    class FakeClient {
      async connect() {}
      async getOrderVersions(orderId) {
        fetchCalls++;
        if (orderId === 16061898661) return [{ id: 1, text: 'GEX_LT_3M_CROSSOVER-short-29990.75-1779898382960' }];
        if (orderId === 9999)        return [{ id: 2, text: null }];
        return [];
      }
    }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo', accountId: 1 }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: fakeBus(), channels: fakeChannels() }
    );
    await conn.init();

    // Miss → fetch → decode → rehydrate
    const got = await conn._recoverFromOrderText(16061898661);
    assert.equal(got.strategy, 'GEX_LT_3M_CROSSOVER');
    assert.equal(got.signalId, 'GEX_LT_3M_CROSSOVER-short-29990.75-1779898382960');
    assert.equal(conn.orderStrategyMap.get(16061898661), 'GEX_LT_3M_CROSSOVER');
    assert.equal(conn.orderSignalMap.get(16061898661), 'GEX_LT_3M_CROSSOVER-short-29990.75-1779898382960');

    // Second call on the same orderId should NOT hit the network — fast path.
    const got2 = await conn._recoverFromOrderText(16061898661);
    assert.equal(got2.strategy, 'GEX_LT_3M_CROSSOVER');
    assert.equal(fetchCalls, 1, 'second call should be served from cache');

    // Unknown order with null text → no attribution, no rehydration
    const miss = await conn._recoverFromOrderText(9999);
    assert.equal(miss.strategy, null);
    assert.equal(miss.signalId, null);
    assert.equal(conn.orderStrategyMap.has(9999), false);
  });

  test('placeOrder stamps text + clOrdId on simple market order', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    let captured = null;
    class FakeClient {
      async connect() {}
      async findContract(symbol) { return { id: 4327110, name: symbol, symbol }; }
      async placeOrder(o) { captured = o; return { orderId: 555 }; }
    }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo', accountId: 1 }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: fakeBus(), channels: fakeChannels() }
    );
    await conn.init();
    const SID = 'GEX_LT_3M_CROSSOVER-short-29990.75-1779898382960';
    await conn.handleOrderRequest({
      signalId: SID, strategy: 'GEX_LT_3M_CROSSOVER',
      symbol: 'MNQM6', action: 'Sell', orderType: 'Market', quantity: 1
    });
    assert.equal(captured.text, SID);
    assert.equal(captured.clOrdId, SID);
  });

  test('placeOrder stamps text + clOrdId on bracket OSO including children', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    let captured = null;
    class FakeClient {
      async connect() {}
      async findContract(symbol) { return { id: 4327110, name: symbol, symbol }; }
      async placeBracketOrder(o) { captured = o; return { orderId: 100, oso1Id: 101, oso2Id: 102 }; }
    }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo', accountId: 1 }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: fakeBus(), channels: fakeChannels() }
    );
    await conn.init();
    const SID = 'GEX_FLIP_IVPCT-short-30000-1700000000000';
    await conn.handleOrderRequest({
      signalId: SID, strategy: 'GEX_FLIP_IVPCT',
      symbol: 'MNQM6', action: 'Sell', orderType: 'Limit', price: 30000,
      stopLoss: 30060, takeProfit: 29900, quantity: 1
    });
    assert.equal(captured.text, SID);
    assert.equal(captured.clOrdId, SID);
    assert.equal(captured.bracket1.text, SID);
    assert.equal(captured.bracket1.clOrdId, `${SID}.sl`);
    assert.equal(captured.bracket2.text, SID);
    assert.equal(captured.bracket2.clOrdId, `${SID}.tp`);
  });

  test('signalId longer than 60 chars skips tag (avoids 64-char broker cap on children)', async () => {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    let captured = null;
    class FakeClient {
      async connect() {}
      async findContract(symbol) { return { id: 1, name: symbol, symbol }; }
      async placeOrder(o) { captured = o; return { orderId: 1 }; }
    }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo', accountId: 1 }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: fakeBus(), channels: fakeChannels() }
    );
    await conn.init();
    await conn.handleOrderRequest({
      signalId: 'x'.repeat(61), strategy: 'X',
      symbol: 'NQM6', action: 'Buy', orderType: 'Market', quantity: 1
    });
    assert.equal(captured.text, undefined);
    assert.equal(captured.clOrdId, undefined);
  });
});

describe('TradovateConnector — entry-through-stop guard (Layer 2)', () => {
  beforeEach(() => _resetRegistryForTests());

  // Build an inited connector and stub the two flatten paths so we can assert
  // which one fired (and with what args) without hitting a broker.
  async function makeConn() {
    const { TradovateConnector } = await import('../connectors/tradovate-connector.js');
    class FakeClient {
      constructor() { this.isConnected = false; this.accessToken = null; }
      async connect() { this.isConnected = true; this.accessToken = 't'; }
    }
    const conn = new TradovateConnector(
      { id: 'tv', broker: 'tradovate', config: { mode: 'demo', accountId: 1 }, credentials: {} },
      silentLogger(),
      { ClientClass: FakeClient, messageBus: fakeBus(), channels: fakeChannels() }
    );
    await conn.init();
    const calls = { bySignal: [], bySymbol: [] };
    conn.closePositionBySignalId = async (signalId, hint) => { calls.bySignal.push({ signalId, hint }); };
    conn.closePosition = async (symbol) => { calls.bySymbol.push(symbol); };
    return { conn, calls };
  }

  test('short filled AT the stop is flattened (zero tolerance)', async () => {
    const { conn, calls } = await makeConn();
    conn.orderStrategyLinks.set('S1', { stopLoss: 30557, takeProfit: 30530 });
    const attr = { signalId: 'sig-1', strategy: 'LSTB', strategyId: 'S1' };
    const flat = await conn._guardEntryThroughStop('MNQU6', -1, { netPrice: 30557 }, {}, attr);
    assert.equal(flat, true);
    assert.equal(calls.bySignal.length, 1);
    assert.equal(calls.bySignal[0].signalId, 'sig-1');
    assert.deepEqual(calls.bySignal[0].hint, { symbol: 'MNQU6' });
  });

  test('short filled THROUGH the stop is flattened (the live 30562 vs 30557 case)', async () => {
    const { conn, calls } = await makeConn();
    conn.orderStrategyLinks.set('S2', { stopLoss: 30557 });
    const attr = { signalId: 'sig-2', strategy: 'LSTB', strategyId: 'S2' };
    const flat = await conn._guardEntryThroughStop('MNQU6', -1, { netPrice: 30562 }, {}, attr);
    assert.equal(flat, true);
    assert.equal(calls.bySignal.length, 1);
  });

  test('long filled THROUGH the stop is flattened', async () => {
    const { conn, calls } = await makeConn();
    conn.orderStrategyLinks.set('S3', { stopLoss: 30534.75 });
    const attr = { signalId: 'sig-3', strategy: 'LSTB', strategyId: 'S3' };
    const flat = await conn._guardEntryThroughStop('MNQU6', 1, { netPrice: 30530 }, {}, attr);
    assert.equal(flat, true);
    assert.equal(calls.bySignal.length, 1);
  });

  test('short with stop still ABOVE entry is NOT flattened (valid trade)', async () => {
    const { conn, calls } = await makeConn();
    conn.orderStrategyLinks.set('S4', { stopLoss: 30557 });
    const attr = { signalId: 'sig-4', strategy: 'LSTB', strategyId: 'S4' };
    const flat = await conn._guardEntryThroughStop('MNQU6', -1, { netPrice: 30545 }, {}, attr);
    assert.equal(flat, false);
    assert.equal(calls.bySignal.length, 0);
    assert.equal(calls.bySymbol.length, 0);
  });

  test('long with stop still BELOW entry is NOT flattened (valid trade)', async () => {
    const { conn, calls } = await makeConn();
    conn.orderStrategyLinks.set('S5', { stopLoss: 30534.75 });
    const attr = { signalId: 'sig-5', strategy: 'LSTB', strategyId: 'S5' };
    const flat = await conn._guardEntryThroughStop('MNQU6', 1, { netPrice: 30546.75 }, {}, attr);
    assert.equal(flat, false);
    assert.equal(calls.bySignal.length, 0);
  });

  test('unknown stop (no strategy link) fails OPEN — no flatten', async () => {
    const { conn, calls } = await makeConn();
    const attr = { signalId: 'sig-6', strategy: 'LSTB', strategyId: 'missing' };
    const flat = await conn._guardEntryThroughStop('MNQU6', -1, { netPrice: 99999 }, {}, attr);
    assert.equal(flat, false);
    assert.equal(calls.bySignal.length, 0);
    assert.equal(calls.bySymbol.length, 0);
  });

  test('through-stop with no signalId falls back to closePosition(symbol)', async () => {
    const { conn, calls } = await makeConn();
    conn.orderStrategyLinks.set('S7', { stopLoss: 30557 });
    const attr = { signalId: null, strategy: 'UNKNOWN', strategyId: 'S7' };
    const flat = await conn._guardEntryThroughStop('MNQU6', -1, { netPrice: 30560 }, {}, attr);
    assert.equal(flat, true);
    assert.equal(calls.bySymbol.length, 1);
    assert.equal(calls.bySymbol[0], 'MNQU6');
    assert.equal(calls.bySignal.length, 0);
  });

  test('entry price falls back to avgPrice then fill.price', async () => {
    const { conn, calls } = await makeConn();
    conn.orderStrategyLinks.set('S8', { stopLoss: 30557 });
    const attr = { signalId: 'sig-8', strategy: 'LSTB', strategyId: 'S8' };
    // no netPrice on the position row → avgPrice used
    const flatA = await conn._guardEntryThroughStop('MNQU6', -1, { avgPrice: 30562 }, {}, attr);
    assert.equal(flatA, true);
    // neither netPrice nor avgPrice → fill.price used
    const flatB = await conn._guardEntryThroughStop('MNQU6', -1, {}, { price: 30562 }, attr);
    assert.equal(flatB, true);
  });
});
