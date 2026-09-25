#!/usr/bin/env node
/**
 * NinjaTrader's "how to verify" checklist for the Dynamic API Host changeover (deadline 2026-10-03), run through
 * slingshot's own TradovateClient. DEMO ONLY — the script refuses to run against anything else.
 *
 *   node scripts/verify-tradovate-api-hosts.js            REST checks only
 *   node scripts/verify-tradovate-api-hosts.js --stream   also opens a streaming connection to the returned host
 *
 * ⚠ --stream opens a WebSocket. Tradovate allows one socket per user and shared/.env's user is the same one
 *   tickpilot-book trades on, so it can knock the book off its connection. Stop the book first.
 *
 * Mirrors tickpilot's bin/verify-api-hosts.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import TradovateClient from '../tradovate-service/TradovateClient.js';
import { resolveHosts } from '../shared/connectors/tradovate-hosts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '../shared/.env') });
const e = process.env;
const STREAM = process.argv.includes('--stream');

const DEMO_REST = e.TRADOVATE_DEMO_URL || 'https://demo.tradovateapi.com/v1';
const DEMO_WSS = e.TRADOVATE_WSS_DEMO_URL || 'wss://demo.tradovateapi.com/v1/websocket';
const DEMO_ACCOUNT = Number(e.TRADOVATE_DEMO_ACCOUNT_ID);
const LIVE_ACCOUNT = Number(e.TRADOVATE_LIVE_ACCOUNT_ID);

// The live host takes the same credentials and returns the real account. Nothing below may point there.
if (!/^https:\/\/demo\./.test(DEMO_REST) || !/^wss:\/\/demo\./.test(DEMO_WSS)) {
  console.error(`refusing: bootstrap is not a demo host (${DEMO_REST} / ${DEMO_WSS})`);
  process.exit(2);
}
if (!Number.isFinite(DEMO_ACCOUNT)) { console.error('refusing: TRADOVATE_DEMO_ACCOUNT_ID not set'); process.exit(2); }

const logs = [];
const logger = {
  info: (...a) => logs.push(a.join(' ')),
  debug: () => {},
  warn: (...a) => { logs.push(a.join(' ')); console.log(`    warn: ${a.join(' ')}`); },
  error: (...a) => { logs.push(a.join(' ')); console.log(`    error: ${a.join(' ')}`); },
};

const client = new TradovateClient({
  useDemo: true,
  demoUrl: DEMO_REST, wssDemoUrl: DEMO_WSS,
  liveUrl: 'https://invalid.invalid/v1', wssLiveUrl: 'wss://invalid.invalid/v1/websocket',   // never used
  username: e.TRADOVATE_USERNAME, appId: e.TRADOVATE_APP_ID, appVersion: e.TRADOVATE_APP_VERSION || '1.0',
  deviceId: e.TRADOVATE_DEVICE_ID, cid: e.TRADOVATE_CID, secret: e.TRADOVATE_SECRET,
  defaultAccountId: DEMO_ACCOUNT,
}, logger, { publish: async () => {}, subscribe: async () => {} }, {});

let failed = 0;
const check = (n, ok, detail) => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}${detail ? `  ${detail}` : ''}`); if (!ok) failed++; };
const demoOnly = (where) => {
  if (client.purpose !== 'demo' || !/^https:\/\/demo[.-]/.test(client.baseUrl)) {
    console.error(`ABORT (${where}): client is not on a demo host: ${client.baseUrl}`);
    process.exit(3);
  }
};

// 1. authenticate and confirm apiHosts is read from the RESPONSE, not from stored configuration
const bootstrapped = client.baseUrl;
const a1 = await client.authenticate();
console.log(`  apiHosts: ${JSON.stringify(a1.apiHosts)}`);
check('apiHosts present in the auth response', !!a1.apiHosts, `${Object.keys(a1.apiHosts || {}).length} keys`);
check('hosts came from the response, not config', client.hostSource === 'apiHosts', `source=${client.hostSource}`);
const expected = resolveHosts(a1.apiHosts, 'demo', {});
check('resolved REST url = apiHosts.demo', client.baseUrl === expected.restUrl, client.baseUrl);
check('resolved WS url = apiHosts.demo', client.wssUrl === expected.wssUrl, client.wssUrl);
check('resolved host is NOT apiHosts.live', expected.host && expected.host !== a1.apiHosts?.live, `live=${a1.apiHosts?.live}`);
console.log(`       bootstrap was ${bootstrapped}${bootstrapped === client.baseUrl ? '  (same host today — the switch is a no-op until the org moves)' : ''}`);
demoOnly('after first auth');

// 3. REST paths use the returned host
const accts = await client.makeRequest('GET', '/account/list');
const lastUrl = `${client.baseUrl}/account/list`;
check('REST account/list against the returned host', Array.isArray(accts), `GET ${lastUrl} -> ${accts?.length} account(s)`);
check('demo account is reachable there', accts.some(a => a.id === DEMO_ACCOUNT), `account ${DEMO_ACCOUNT}`);
if (Number.isFinite(LIVE_ACCOUNT)) {
  check('live account is NOT on this host', !accts.some(a => a.id === LIVE_ACCOUNT), `account ${LIVE_ACCOUNT}`);
}

// 4. authenticate a SECOND time and confirm the hosts are re-read rather than reused
const before = { rest: client.baseUrl, ws: client.wssUrl, token: client.accessToken };
// Poison the stored streaming host. The request itself still goes to the known-good REST host, so this asks the
// only question that matters: does the second session take its hosts from the new response, or reuse the first's?
client.wssUrl = 'wss://stale.invalid/v1/websocket';
const a2 = await client.authenticate();
check('second auth re-read apiHosts', !!a2.apiHosts && client.hostSource === 'apiHosts');
check('stored host was replaced, not reused', client.wssUrl === before.ws, client.wssUrl);
check('a fresh token came back', client.accessToken !== before.token);
demoOnly('after second auth');

// also: the renewal path re-reads apiHosts
const r = await client.refreshToken();
check('renewaccesstoken succeeded and re-resolved', r === true && client.hostSource === 'apiHosts', client.baseUrl);
demoOnly('after renew');

// 2. streaming connection to the returned demo host
if (STREAM) {
  const t0 = Date.now();
  await client.connectWebSocket();
  while (!logs.some(l => l.includes('WebSocket authorization successful')) && Date.now() - t0 < 15_000) {
    await new Promise(res => setTimeout(res, 100));
  }
  const authorized = logs.some(l => l.includes('WebSocket authorization successful'));
  check('streaming connection authorized on the returned host', authorized, client.wssUrl);
  await new Promise(res => setTimeout(res, 1500));   // let the sync request answer before hanging up
  client.disconnect();
} else {
  console.log('  skip  streaming check (needs --stream; opens a socket — stop tickpilot-book first)');
}

if (client.tokenRefreshTimer) clearTimeout(client.tokenRefreshTimer);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
