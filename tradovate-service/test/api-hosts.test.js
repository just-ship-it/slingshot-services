/**
 * Dynamic API hosts (NinjaTrader/Tradovate, mandatory 2026-10-03). Ported from tickpilot's test/api-hosts.js.
 *
 * The rules being pinned down: hosts come from the auth response every time, a response WITHOUT apiHosts must not
 * drag us back to the bootstrap address, a renewal that moves the host redials the socket, a 3xx is never followed
 * with a bearer token attached, and a 421 costs exactly one re-auth and one redial.
 *
 * REST is stubbed at axios's adapter (so axios's own validateStatus / response handling still runs). The 421 test
 * uses a real local HTTP server that rejects the first upgrade — not a mock.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import { WebSocketServer } from 'ws';
import { resolveHosts } from '../../shared/connectors/tradovate-hosts.js';
import TradovateClient from '../TradovateClient.js';

const BOOT = { restUrl: 'https://demo.tradovateapi.com/v1', wssUrl: 'wss://demo.tradovateapi.com/v1/websocket' };
const LIVE_SHAPE = {            // exactly what demo returned on 2026-09-24, unknown keys included
  live: 'live.tradovateapi.com', demo: 'demo.tradovateapi.com', mdLive: 'md.tradovateapi.com',
  mdDemo: 'md-demo.tradovateapi.com', replay: 'replay.tradovateapi.com',
  reportingLive: 'rpt-live.tradovateapi.com', reportingDemo: 'rpt-demo.tradovateapi.com',
  riskMonitorLive: 'risk-monitor-api-live.ninjatrader.com', riskMonitorDemo: 'risk-monitor-api-demo.ninjatrader.com',
  userContext: 'user-context-api.ninjatrader.com',
};
const EVAL7 = { ...LIVE_SHAPE, demo: 'demo-eval-7.tradovateapi.com' };
const EXP = new Date(Date.now() + 80 * 60_000).toISOString();

process.env.TRADOVATE_PASSWORD = 'p';

// ---- axios stub ----------------------------------------------------------------------------------------
const realAdapter = axios.defaults.adapter;
let calls = [];
let handler = () => ({ status: 500, data: {} });
function reply(data, { status = 200, location = null } = {}) {
  return { status, data, headers: location ? { location } : {} };
}
function networkError(message = 'getaddrinfo ENOTFOUND') {
  return { network: message };
}
axios.defaults.adapter = async (config) => {
  calls.push(config);
  const r = await handler(config.url, config);
  if (r.network) throw new axios.AxiosError(r.network, 'ENOTFOUND', config, {});
  const response = { status: r.status, statusText: '', data: r.data, headers: r.headers, config, request: {} };
  if (!config.validateStatus || config.validateStatus(response.status)) return response;
  throw new axios.AxiosError(`Request failed with status code ${response.status}`, 'ERR_BAD_RESPONSE', config, {}, response);
};
const stub = (fn) => { calls = []; handler = fn; };

function capturingLogger() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const log = (k) => (...a) => lines[k].push(a.map(String).join(' '));
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}

const clients = [];
function newClient(over = {}) {
  const logger = capturingLogger();
  const c = new TradovateClient({
    useDemo: true, username: 'u', appId: 'Slingshot Dev', appVersion: '1.0', deviceId: 'd', cid: 'c', secret: 's',
    demoUrl: BOOT.restUrl, liveUrl: 'https://live.tradovateapi.com/v1',
    wssDemoUrl: BOOT.wssUrl, wssLiveUrl: 'wss://live.tradovateapi.com/v1/websocket',
    ...over,
  }, logger, null, null);
  clients.push(c);
  return { c, logger };
}
const token = (t, extra = {}) => ({ accessToken: t, mdAccessToken: `md-${t}`, userId: 9, expirationTime: EXP, ...extra });

afterEach(() => {
  while (clients.length) {
    const c = clients.pop();
    if (c.tokenRefreshTimer) clearTimeout(c.tokenRefreshTimer);
    c.stopHeartbeat();
    if (c.ws) { const ws = c.ws; c.ws = null; try { ws.terminate?.(); } catch {} }
  }
});

// ---- resolver ------------------------------------------------------------------------------------------
describe('resolveHosts', () => {
  test('real shape, eval org, per-purpose keys, fallbacks, unknown keys ignored', () => {
    const r = resolveHosts(LIVE_SHAPE, 'demo', BOOT);
    assert.deepEqual(r, { restUrl: 'https://demo.tradovateapi.com/v1', wssUrl: 'wss://demo.tradovateapi.com/v1/websocket',
      host: 'demo.tradovateapi.com', source: 'apiHosts' });

    const evalOrg = resolveHosts(EVAL7, 'demo', BOOT);
    assert.equal(evalOrg.restUrl, 'https://demo-eval-7.tradovateapi.com/v1');
    assert.equal(evalOrg.wssUrl, 'wss://demo-eval-7.tradovateapi.com/v1/websocket');

    assert.equal(resolveHosts(LIVE_SHAPE, 'live', BOOT).restUrl, 'https://live.tradovateapi.com/v1');
    assert.equal(resolveHosts(LIVE_SHAPE, 'mdDemo', BOOT).wssUrl, 'wss://md-demo.tradovateapi.com/v1/websocket');

    for (const bad of [undefined, null, {}, { demo: '' }, { demo: '   ' }, { demo: 42 }, { live: 'x.com' }]) {
      const f = resolveHosts(bad, 'demo', BOOT);
      assert.equal(f.source, 'fallback', `${JSON.stringify(bad)} must fall back`);
      assert.equal(f.restUrl, BOOT.restUrl);
      assert.equal(f.wssUrl, BOOT.wssUrl);
    }
    assert.equal(resolveHosts({ demo: 'https://d.example.com/' }, 'demo', BOOT).restUrl, 'https://d.example.com/v1');
  });
});

// ---- auth ----------------------------------------------------------------------------------------------
describe('authentication reads apiHosts', () => {
  test('first auth goes to bootstrap, then hosts come from the response; no redial on startup', async () => {
    stub(() => reply(token('T1', { apiHosts: EVAL7 })));
    const { c } = newClient();
    let redials = 0; c._redialOnNewHost = () => { redials++; };
    assert.equal(c.baseUrl, BOOT.restUrl);
    assert.equal(c.hostSource, 'bootstrap');
    await c.authenticate();
    assert.equal(calls[0].url, `${BOOT.restUrl}/auth/accesstokenrequest`);
    assert.equal(c.baseUrl, 'https://demo-eval-7.tradovateapi.com/v1');
    assert.equal(c.wssUrl, 'wss://demo-eval-7.tradovateapi.com/v1/websocket');
    assert.equal(c.hostSource, 'apiHosts');
    assert.equal(c.accessToken, 'T1');
    assert.equal(c.mdAccessToken, 'md-T1');
    assert.equal(c.userId, 9);
    assert.equal(c.tokenExpiry.toISOString(), EXP);
    assert.ok(c.tokenRefreshTimer, 'auth arms the renewal timer');
    assert.equal(redials, 0, 'no socket yet, so no redial');
    assert.deepEqual(c.hostInfo, { purpose: 'demo', restUrl: c.baseUrl, wssUrl: c.wssUrl, hostSource: 'apiHosts' });
  });

  test('purpose follows the account mode: live uses apiHosts.live, demo never picks the live host', async () => {
    stub(() => reply(token('T1', { apiHosts: { ...LIVE_SHAPE, live: 'live-x.tradovateapi.com' } })));
    const { c: live } = newClient({ useDemo: false });
    assert.equal(live.baseUrl, 'https://live.tradovateapi.com/v1', 'live bootstraps on the live host');
    await live.authenticate();
    assert.equal(live.baseUrl, 'https://live-x.tradovateapi.com/v1');
    const { c: demo } = newClient();
    await demo.authenticate();
    assert.equal(demo.baseUrl, 'https://demo.tradovateapi.com/v1');
    assert.equal(demo.wssUrl, 'wss://demo.tradovateapi.com/v1/websocket');
  });

  test('auth without apiHosts keeps the current host and warns once', async () => {
    stub(() => reply(token('T1')));
    const { c, logger } = newClient();
    await c.authenticate();
    await c.authenticate();
    assert.equal(c.baseUrl, BOOT.restUrl);
    assert.equal(c.hostSource, 'fallback');
    assert.equal(logger.lines.warn.filter(l => l.includes('no apiHosts')).length, 1);
  });

  test('CAPTCHA ticket: one retry, and the retry response still resolves the hosts', async () => {
    let n = 0;
    stub((url, cfg) => (++n === 1 ? reply({ 'p-ticket': 'TK', 'p-time': 0 }) : reply(token('T1', { apiHosts: EVAL7 }))));
    const { c } = newClient();
    await c.authenticate();
    assert.equal(n, 2);
    assert.equal(JSON.parse(calls[1].data).p_ticket, 'TK');
    assert.equal(c.baseUrl, 'https://demo-eval-7.tradovateapi.com/v1');
  });

  test('errorText is reported, not treated as a host problem', async () => {
    stub(() => reply({ errorText: 'Incorrect username or password' }));
    const { c } = newClient();
    await assert.rejects(() => c.authenticate(), /Authentication failed: Incorrect username/);
    assert.equal(calls.length, 1);
  });

  test('concurrent authentications share one accesstokenrequest', async () => {
    stub(() => reply(token('T1', { apiHosts: LIVE_SHAPE })));
    const { c } = newClient();
    await Promise.all([c.authenticate(), c.authenticate(), c.authenticate()]);
    assert.equal(calls.length, 1);
  });
});

// ---- renewal -------------------------------------------------------------------------------------------
describe('renewal re-reads apiHosts', () => {
  test('a renewal that MOVES the host updates both URLs and redials the socket exactly once', async () => {
    stub((url) => url.includes('renewaccesstoken')
      ? reply(token('T2', { apiHosts: { ...LIVE_SHAPE, demo: 'demo-eval-9.tradovateapi.com' } }))
      : reply(token('T1', { apiHosts: LIVE_SHAPE })));
    const { c } = newClient();
    await c.authenticate();
    let closed = 0, dials = [];
    c.ws = { close() { closed++; }, readyState: 1 };           // stand in for a connected socket
    c.wsConnected = true;
    c.connectWebSocket = async function () { dials.push(this.wssUrl); };
    assert.equal(await c.refreshToken(), true);
    const renew = calls.find(x => x.url.includes('renewaccesstoken'));
    assert.equal(renew.url, 'https://demo.tradovateapi.com/v1/auth/renewaccesstoken');
    assert.equal(renew.headers.Authorization, 'Bearer T1');
    assert.equal(c.accessToken, 'T2');
    assert.equal(c.baseUrl, 'https://demo-eval-9.tradovateapi.com/v1');
    assert.equal(c.wssUrl, 'wss://demo-eval-9.tradovateapi.com/v1/websocket');
    assert.equal(closed, 1, 'old socket retired');
    assert.deepEqual(dials, ['wss://demo-eval-9.tradovateapi.com/v1/websocket'], 'one redial, on the new host');
    assert.ok(c.tokenRefreshTimer, 'renewal re-arms the next renewal');
  });

  test('a renewal WITHOUT apiHosts stays on the last resolved host, not the bootstrap one', async () => {
    stub((url) => url.includes('renewaccesstoken') ? reply(token('T2')) : reply(token('T1', { apiHosts: EVAL7 })));
    const { c } = newClient();
    await c.authenticate();
    let redials = 0; c._redialOnNewHost = () => { redials++; };
    c.ws = { close() {}, readyState: 1 };
    await c.refreshToken();
    assert.equal(c.baseUrl, 'https://demo-eval-7.tradovateapi.com/v1', 'must NOT snap back to bootstrap');
    assert.equal(c.wssUrl, 'wss://demo-eval-7.tradovateapi.com/v1/websocket');
    assert.equal(c.accessToken, 'T2');
    assert.equal(redials, 0);
  });

  test('renew 307: not followed, re-auth re-reads hosts, one retry, no loop', async () => {
    let renews = 0;
    stub((url) => {
      if (url.includes('renewaccesstoken')) {
        renews++;
        if (url.startsWith('https://demo.tradovateapi.com')) {
          return reply({}, { status: 307, location: 'https://demo-eval-7.tradovateapi.com/v1/auth/renewaccesstoken' });
        }
        return reply(token('T3'));
      }
      return reply(token('T2', { apiHosts: EVAL7 }));
    });
    const { c } = newClient();
    await c.authenticate();
    c.baseUrl = BOOT.restUrl; c.wssUrl = BOOT.wssUrl;          // pretend the org moved while we sat on the old host
    await c.refreshToken();
    assert.equal(renews, 2, 'one redirected attempt, one retry');
    assert.equal(c.accessToken, 'T3');
    assert.equal(c.baseUrl, 'https://demo-eval-7.tradovateapi.com/v1');
    assert.ok(calls.every(x => x.maxRedirects === 0), 'every Tradovate call disables automatic redirects');
  });
});

// ---- REST wrong host -----------------------------------------------------------------------------------
describe('REST on the wrong host', () => {
  test('307: re-auth, then exactly one retry on the re-resolved host', async () => {
    let moved = false;
    stub((url) => {
      if (url.includes('accesstokenrequest')) return reply(token('T', { apiHosts: moved ? EVAL7 : LIVE_SHAPE }));
      if (url.startsWith('https://demo.tradovateapi.com')) {
        moved = true;
        return reply({}, { status: 307, location: 'https://demo-eval-7.tradovateapi.com/v1/account/list' });
      }
      return reply([{ id: 1 }]);
    });
    const { c } = newClient();
    await c.authenticate();
    const out = await c.makeRequest('GET', '/account/list');
    assert.deepEqual(out, [{ id: 1 }]);
    assert.deepEqual(calls.map(x => x.url), [
      `${BOOT.restUrl}/auth/accesstokenrequest`,
      `${BOOT.restUrl}/account/list`,
      `${BOOT.restUrl}/auth/accesstokenrequest`,
      'https://demo-eval-7.tradovateapi.com/v1/account/list',
    ]);
    const bearer = calls.filter(x => x.headers?.Authorization);
    assert.ok(bearer.length >= 2 && bearer.every(x => x.maxRedirects === 0), 'a bearer-token request never auto-follows');
  });

  test('a persistent 307 fails after ONE re-auth — no loop', async () => {
    let auths = 0;
    stub((url) => {
      if (url.includes('accesstokenrequest')) { auths++; return reply(token('T', { apiHosts: LIVE_SHAPE })); }
      return reply({}, { status: 307, location: 'https://elsewhere.tradovateapi.com/v1/account/list' });
    });
    const { c } = newClient();
    await c.authenticate();
    await assert.rejects(() => c.makeRequest('GET', '/account/list'), /API Error: 307 .*still redirects/);
    assert.equal(auths, 2, 'initial auth + one re-auth');
    assert.equal(calls.filter(x => x.url.endsWith('/account/list')).length, 2);
  });

  test('concurrent 307s trigger a single re-auth', async () => {
    let moved = false, auths = 0;
    stub(async (url) => {
      if (url.includes('accesstokenrequest')) {
        auths++;
        await new Promise(r => setTimeout(r, 5));
        return reply(token('T', { apiHosts: moved ? EVAL7 : LIVE_SHAPE }));
      }
      if (url.startsWith('https://demo.tradovateapi.com')) { moved = true; return reply({}, { status: 307, location: 'x' }); }
      return reply({ ok: 1 });
    });
    const { c } = newClient();
    await c.authenticate();
    auths = 0;
    await Promise.all([c.makeRequest('GET', '/a'), c.makeRequest('GET', '/b'), c.makeRequest('GET', '/c')]);
    assert.equal(auths, 1);
  });

  test('bodyless 404 (md-demo / rpt-demo behaviour) names the status and URL', async () => {
    stub((url) => url.includes('accesstokenrequest') ? reply(token('T')) : reply('', { status: 404 }));
    const { c } = newClient();
    await c.authenticate();
    await assert.rejects(() => c.makeRequest('GET', '/account/list'), (err) => {
      assert.match(err.message, /API Error: 404 - https:\/\/demo\.tradovateapi\.com\/v1\/account\/list returned an empty body/);
      return true;
    });

    stub(() => reply('', { status: 404 }));
    const { c: c2 } = newClient();
    await assert.rejects(() => c2.authenticate(), (err) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /accesstokenrequest -> 404 with an empty body/);
      assert.doesNotMatch(err.message, /JSON/i);
      return true;
    });
  });

  test('an unreachable resolved host falls back to bootstrap ONCE, then re-resolves', async () => {
    const hits = [];
    stub((url) => {
      hits.push(url);
      if (url.startsWith('https://demo-eval-7.')) return networkError();   // host retired between sessions
      return reply(token('T4', { apiHosts: LIVE_SHAPE }));
    });
    const { c } = newClient();
    c.baseUrl = 'https://demo-eval-7.tradovateapi.com/v1';                // yesterday's resolved host, now dead
    await c.authenticate();
    assert.equal(hits.length, 2);
    assert.ok(hits[1].startsWith(BOOT.restUrl));
    assert.equal(c.baseUrl, BOOT.restUrl);
    assert.equal(c.hostSource, 'apiHosts');

    // and if bootstrap is ALSO down, it fails rather than retrying again
    stub(() => networkError());
    const { c: c2 } = newClient();
    c2.baseUrl = 'https://demo-eval-7.tradovateapi.com/v1';
    await assert.rejects(() => c2.authenticate(), /Network error/);
    assert.equal(calls.length, 2);
  });
});

// ---- WebSocket 421 against a real server ---------------------------------------------------------------
describe('WebSocket 421 (real socket server)', () => {
  let server, wss, upgrades, rejectFirst;
  beforeEach(async () => {
    upgrades = 0;
    wss = new WebSocketServer({ noServer: true });
    server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
      if (++upgrades <= rejectFirst) {
        socket.write('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => ws.send('o'));   // 'o' is Tradovate's socket-open frame
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
  });
  afterEach(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise(r => server.close(r));
  });
  const until = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
  };

  test('first upgrade 421 → one re-auth → one redial that succeeds', async () => {
    rejectFirst = 1;
    const url = `ws://127.0.0.1:${server.address().port}/v1/websocket`;
    let auths = 0;
    stub(() => { auths++; return reply(token('T9')); });           // no apiHosts → keeps the test URL
    const { c } = newClient({ wssDemoUrl: url });
    await c.connectWebSocket();
    await until(() => c.wsConnected);
    assert.equal(upgrades, 2, 'exactly one redial after the 421');
    assert.equal(auths, 1, 'the 421 triggered exactly one re-auth');
    assert.equal(c.accessToken, 'T9');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(upgrades, 2, 'no stray reconnect from the aborted socket');
    assert.equal(c.wsReconnectAttempts, 0);
  });

  test('a persistent 421 gives up after one re-auth and one redial — no loop', async () => {
    rejectFirst = Infinity;
    const url = `ws://127.0.0.1:${server.address().port}/v1/websocket`;
    let auths = 0;
    stub(() => { auths++; return reply(token('T9')); });
    const { c, logger } = newClient({ wssDemoUrl: url });
    await c.connectWebSocket();
    await until(() => logger.lines.error.some(l => l.includes('giving up')));
    // Outlast the first reconnect backoff (2s): a close event from an aborted socket must not start the
    // reconnect chain behind the 421 handler's back.
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(upgrades, 2);
    assert.equal(auths, 1);
    assert.equal(c.ws, null);
    assert.equal(c.wsConnected, false);
  });
});

test.after?.(() => { axios.defaults.adapter = realAdapter; });
