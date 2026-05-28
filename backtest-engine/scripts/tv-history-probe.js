#!/usr/bin/env node
/**
 * TradingView Historical Bar Probe
 * --------------------------------
 * Empirically determines how much historical OHLCV data TradingView's
 * WebSocket will serve for a given timeframe + requested bar count.
 *
 * For each (timeframe, requestedBars) pair:
 *   1. Open a fresh WebSocket (mirrors how a cron job would behave)
 *   2. Do the handshake exactly like signal-generator/src/websocket/tradingview-client.js
 *   3. Send `create_series` with the requested bar count
 *   4. Capture all `timescale_update` messages until quiet for QUIET_MS
 *   5. Record: returned bar count, oldest ts, newest ts, span, elapsed ms
 *   6. (Optional) Send a `request_more_data` to see if pagination extends further
 *
 * After all tests finish, prints a summary table + writes
 * /tmp/tv-history-probe-<timestamp>.json
 *
 * Run:
 *   node backtest-engine/scripts/tv-history-probe.js
 *
 * Env (read from shared/.env):
 *   TRADINGVIEW_JWT_TOKEN  - JWT for prodata host
 *   REDIS_URL              - optional, default redis://localhost:6379
 */
import 'dotenv/config';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getBestAvailableToken,
  getCachedSessionCookies,
  refreshJwtFromSession,
  cacheTokenInRedis,
  getTokenTTL
} from '../../signal-generator/src/utils/tradingview-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load shared/.env explicitly (script may run from any cwd)
const dotenv = await import('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '..', 'shared', '.env') });

const SYMBOL = 'CME_MINI:NQ1!';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const TV_HOST = 'prodata.tradingview.com';
const TV_ORIGIN = 'https://www.tradingview.com';

// History delivery is "done" when the OLDEST bar timestamp has been stable
// (not moved further back) for this many ms. We can't use "no messages for X ms"
// because live 1s tape merges in continuously and would never let a quiet period
// trigger — but live ticks only extend the NEWEST end, never the oldest.
const OLDEST_STABLE_MS = 8000;
// How often to poll the stable-oldest condition
const STABLE_POLL_MS = 1000;
// Absolute ceiling per test
const TEST_TIMEOUT_MS = 600_000;
// Pause between tests so TV doesn't rate-limit our IP
const INTER_TEST_DELAY_MS = 3000;
// Pagination: how many request_more_data cycles to attempt
const PAGINATION_CYCLES_DEFAULT = 1;

// Test matrix: [resolution, requestedBars, label]
// '1'  = 1-minute
// '1S' = 1-second (TV's lowercase-s also seen; uppercase matches Pine convention)
const TESTS = [
  // 1-minute pulls
  { resolution: '1',  bars: 1_000,     label: '1m × 1k' },
  { resolution: '1',  bars: 10_000,    label: '1m × 10k' },
  { resolution: '1',  bars: 100_000,   label: '1m × 100k' },
  { resolution: '1',  bars: 500_000,   label: '1m × 500k' },
  { resolution: '1',  bars: 1_000_000, label: '1m × 1M', testPagination: true },

  // 1-second pulls - the real unknown
  { resolution: '1S', bars: 1_000,     label: '1s × 1k' },
  { resolution: '1S', bars: 10_000,    label: '1s × 10k' },
  { resolution: '1S', bars: 100_000,   label: '1s × 100k' },
  { resolution: '1S', bars: 500_000,   label: '1s × 500k' },
  { resolution: '1S', bars: 1_000_000, label: '1s × 1M', testPagination: true },

  // 5-second bonus (sometimes available when 1s isn't)
  { resolution: '5S', bars: 100_000,   label: '5s × 100k' },

  // === Pagination depth tests — the critical question for cron design ===
  // Request the per-call cap (30k) then chain multiple request_more_data cycles.
  { resolution: '1',  bars: 30_000,    label: '1m × 30k pgn×5', testPagination: true, paginationCycles: 5 },
  { resolution: '1S', bars: 30_000,    label: '1s × 30k pgn×5', testPagination: true, paginationCycles: 5 },
  { resolution: '1S', bars: 30_000,    label: '1s × 30k pgn×20', testPagination: true, paginationCycles: 20 },
];

function genId(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return `${prefix}_${s}`;
}

function wrapFrame(func, params) {
  const json = JSON.stringify({ m: func, p: params });
  return `~m~${json.length}~m~${json}`;
}

function buildTvUrl() {
  const now = new Date().toISOString().slice(0, 19);
  const params = new URLSearchParams({
    from: 'chart/4NTS38Zt/',
    date: now,
    type: 'chart',
    auth: 'sessionid'
  });
  return `wss://${TV_HOST}/socket.io/websocket?${params.toString()}`;
}

/**
 * Run a single probe test. Returns a result object.
 */
async function runTest(test, jwt, cookieHeader) {
  const paginationCycles = test.testPagination ? (test.paginationCycles ?? PAGINATION_CYCLES_DEFAULT) : 0;
  const result = {
    label: test.label,
    resolution: test.resolution,
    requestedBars: test.bars,
    paginationCyclesRequested: paginationCycles,
    paginationCyclesCompleted: 0,
    initialReturnedBars: 0,
    initialOldestTs: null,
    returnedBars: 0,
    oldestTs: null,
    newestTs: null,
    spanSeconds: null,
    spanDays: null,
    paginationGainBars: null,
    paginationGainDays: null,
    elapsedMs: null,
    timescaleUpdates: 0,
    cycleSnapshots: [], // [{cycle: 0|1|2..., bars, oldestTs, gainBars}]
    error: null,
    serverErrors: []
  };

  const startedAt = Date.now();
  const chartSession = genId('cs');
  const quoteSession = genId('qs');

  return new Promise((resolve) => {
    const wsUrl = buildTvUrl();
    const headers = {
      'Connection': 'upgrade',
      'Host': TV_HOST,
      'Origin': TV_ORIGIN,
      'Cache-Control': 'no-cache',
      'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
      'Sec-WebSocket-Version': '13',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Pragma': 'no-cache',
      'Upgrade': 'websocket'
    };
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const ws = new WebSocket(wsUrl, { headers });
    const allBars = new Map(); // ts -> [o,h,l,c,v]
    let runningOldestTs = null;          // tracked incrementally; only goes down
    let oldestLastChangedAt = Date.now(); // wall-clock of last backward extension
    let stablePollTimer = null;
    let pingCounter = 0;
    let pingInterval = null;
    let hardTimeout = null;
    let done = false;
    let cyclesCompleted = 0; // 0 = initial delivery; 1+ = pagination cycles
    let lastBarCountAtCycleEnd = 0;

    const snapshotCycle = () => {
      const bars = Array.from(allBars.keys()).sort((a, b) => a - b);
      const oldestTs = bars[0] ?? null;
      const gainBars = allBars.size - lastBarCountAtCycleEnd;
      result.cycleSnapshots.push({
        cycle: cyclesCompleted,
        totalBars: allBars.size,
        oldestTs,
        oldestISO: oldestTs ? new Date(oldestTs * 1000).toISOString() : null,
        gainBars
      });
      if (cyclesCompleted === 0) {
        result.initialReturnedBars = allBars.size;
        result.initialOldestTs = oldestTs;
      }
      lastBarCountAtCycleEnd = allBars.size;
    };

    const finish = (errMsg = null) => {
      if (done) return;
      done = true;
      if (errMsg) result.error = errMsg;
      if (stablePollTimer) clearInterval(stablePollTimer);
      if (pingInterval) clearInterval(pingInterval);
      if (hardTimeout) clearTimeout(hardTimeout);

      const bars = Array.from(allBars.entries()).sort((a, b) => a[0] - b[0]);
      result.returnedBars = bars.length;
      if (bars.length > 0) {
        result.oldestTs = bars[0][0];
        result.newestTs = bars[bars.length - 1][0];
        result.spanSeconds = result.newestTs - result.oldestTs;
        result.spanDays = +(result.spanSeconds / 86400).toFixed(2);
      }
      result.paginationCyclesCompleted = cyclesCompleted;
      if (result.initialReturnedBars > 0 && result.returnedBars > result.initialReturnedBars) {
        result.paginationGainBars = result.returnedBars - result.initialReturnedBars;
        if (result.initialOldestTs && result.oldestTs) {
          result.paginationGainDays = +((result.initialOldestTs - result.oldestTs) / 86400).toFixed(2);
        }
      }
      result.elapsedMs = Date.now() - startedAt;

      try { ws.close(); } catch {}
      resolve(result);
    };

    hardTimeout = setTimeout(() => finish('hard_timeout'), TEST_TIMEOUT_MS);

    // Cycle completion is decided by polling: if oldestTs hasn't moved further
    // back for OLDEST_STABLE_MS, this cycle's history delivery is done.
    const onCycleComplete = () => {
      snapshotCycle();
      const snap = result.cycleSnapshots[result.cycleSnapshots.length - 1];
      const cycleLabel = cyclesCompleted === 0 ? 'initial' : `pagination #${cyclesCompleted}`;
      console.log(`    ↳ ${cycleLabel} settled: ${snap.totalBars.toLocaleString()} total bars (+${snap.gainBars.toLocaleString()}), oldest=${snap.oldestISO}`);

      if (cyclesCompleted < paginationCycles && snap.gainBars > 0) {
        cyclesCompleted += 1;
        const morePayload = wrapFrame('request_more_data', [chartSession, 'sds_1', test.bars]);
        try {
          ws.send(morePayload);
          console.log(`    ↳ pagination cycle ${cyclesCompleted}: sent request_more_data (+${test.bars} bars)`);
          // Reset stability timer so we wait for new bars from this request
          oldestLastChangedAt = Date.now();
        } catch (e) {
          console.log(`    ↳ pagination send failed: ${e.message}`);
          finish();
        }
      } else {
        if (cyclesCompleted > 0 && cyclesCompleted < paginationCycles && snap.gainBars === 0) {
          console.log(`    ↳ pagination yielded 0 new bars — stopping`);
        }
        finish();
      }
    };

    stablePollTimer = setInterval(() => {
      // Only check stability after we have at least some bars
      if (allBars.size === 0) return;
      if (Date.now() - oldestLastChangedAt >= OLDEST_STABLE_MS) {
        onCycleComplete();
      }
    }, STABLE_POLL_MS);

    ws.on('open', () => {
      // Keepalive heartbeat — TV cuts WS at ~65-75s without client-originated pings
      pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        pingCounter += 1;
        const body = `~h~${pingCounter}`;
        try { ws.send(`~m~${body.length}~m~${body}`); } catch {}
      }, 10_000);

      // Handshake (mirrors tradingview-client.js initializeSessions + subscribeToSymbol)
      ws.send(wrapFrame('set_auth_token', [jwt || 'unauthorized_user_token']));
      ws.send(wrapFrame('set_locale', ['en', 'US']));
      ws.send(wrapFrame('quote_create_session', [quoteSession]));
      ws.send(wrapFrame('quote_set_fields', [quoteSession, 'lp', 'lp_time', 'update_mode']));

      const resolveSym = JSON.stringify({ adjustment: 'splits', symbol: SYMBOL });
      ws.send(wrapFrame('chart_create_session', [chartSession, '']));
      ws.send(wrapFrame('quote_add_symbols', [quoteSession, `=${resolveSym}`]));
      ws.send(wrapFrame('resolve_symbol', [chartSession, 'sds_sym_1', `=${resolveSym}`]));
      ws.send(wrapFrame('create_series', [
        chartSession, 'sds_1', 's1', 'sds_sym_1', test.resolution, test.bars, ''
      ]));

      // Stability poll is already running; reset the marker so the first
      // batch of bars has a fresh window to extend `runningOldestTs` backward.
      oldestLastChangedAt = Date.now();
    });

    ws.on('message', (data) => {
      const message = data.toString();

      // Echo heartbeat (some TV server-side frames want echoing)
      if (message.match(/^~m~\d+~m~~h~\d+$/)) {
        try { ws.send(message); } catch {}
        return;
      }

      // Split possibly-batched frames
      const parts = message.split(/~m~\d+~m~/);
      for (const part of parts) {
        if (!part || !part.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(part); } catch { continue; }

        if (parsed.m === 'timescale_update') {
          result.timescaleUpdates += 1;
          const ohlc = parsed.p?.[1]?.sds_1?.s || [];
          for (const bar of ohlc) {
            if (!bar.v || bar.v.length < 5) continue;
            const ts = bar.v[0];
            allBars.set(ts, bar.v.slice(1));
            if (runningOldestTs === null || ts < runningOldestTs) {
              runningOldestTs = ts;
              oldestLastChangedAt = Date.now();
            }
          }
        } else if (parsed.m === 'series_completed') {
          // TV sometimes sends this to signal end-of-history-batch — treat it
          // as a hint that delivery is done, but stability poll is authoritative.
        } else if (parsed.m === 'series_error' || parsed.m === 'cs_error' || parsed.m === 'protocol_error' || parsed.m === 'critical_error') {
          result.serverErrors.push({ m: parsed.m, p: parsed.p });
          console.log(`    ⚠ server error: ${parsed.m} ${JSON.stringify(parsed.p).slice(0, 200)}`);
        }
      }
    });

    ws.on('error', (err) => finish(`ws_error: ${err.message}`));
    ws.on('close', (code, reason) => {
      // If we close before getting data, capture why
      if (allBars.size === 0 && !done) {
        finish(`closed_early: code=${code} reason=${reason || 'none'}`);
      }
    });
  });
}

async function main() {
  // Optional filter: --only <substring>  → run only tests whose label contains substring
  const args = process.argv.slice(2);
  let onlyFilter = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && args[i + 1]) { onlyFilter = args[++i]; }
  }
  const testsToRun = onlyFilter
    ? TESTS.filter(t => t.label.includes(onlyFilter))
    : TESTS;

  console.log('=== TradingView Historical Bar Probe ===');
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Tests: ${testsToRun.length}${onlyFilter ? ` (filtered by --only "${onlyFilter}")` : ''}`);
  console.log('');

  // Step 1: try to refresh the JWT from cached session cookies so we test with
  // a fresh token. Stale JWTs may still authenticate but TV is known to
  // silently downgrade entitlements (e.g. seconds-resolution data).
  console.log('Refreshing JWT from cached session cookies...');
  let freshJwt = null;
  try {
    freshJwt = await refreshJwtFromSession(REDIS_URL);
    if (freshJwt) {
      await cacheTokenInRedis(REDIS_URL, freshJwt);
      const ttl = getTokenTTL(freshJwt);
      console.log(`✓ JWT refreshed via session cookies (TTL ${Math.floor(ttl/60)}min)`);
    } else {
      console.log('⚠ Session-based refresh returned no JWT (cookies may be expired)');
    }
  } catch (e) {
    console.log(`⚠ Session refresh failed: ${e.message}`);
  }

  // Step 2: resolve final auth (prefers the now-cached fresh JWT)
  const auth = await getBestAvailableToken(process.env.TRADINGVIEW_JWT_TOKEN, REDIS_URL);
  if (!auth || !auth.token) {
    console.error('No JWT token available. Set TRADINGVIEW_JWT_TOKEN in shared/.env or bootstrap via /tv-auth/sessionid.');
    process.exit(1);
  }
  console.log(`JWT source: ${auth.source} (TTL ${auth.ttl > 0 ? Math.floor(auth.ttl/60) + 'min' : 'expired'})`);

  const cookies = await getCachedSessionCookies(REDIS_URL);
  let cookieHeader = null;
  if (cookies && Object.keys(cookies).length > 0) {
    cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    console.log(`Cookies attached: ${Object.keys(cookies).join(', ')}`);
  } else {
    console.log('No session cookies cached — proceeding with JWT only (TV may downgrade).');
  }
  console.log('');

  const results = [];
  for (const test of testsToRun) {
    process.stdout.write(`▶ ${test.label.padEnd(14)} ... `);
    const r = await runTest(test, auth.token, cookieHeader);
    results.push(r);

    if (r.error && r.returnedBars === 0) {
      console.log(`FAILED: ${r.error}`);
    } else {
      const oldest = r.oldestTs ? new Date(r.oldestTs * 1000).toISOString() : 'n/a';
      const newest = r.newestTs ? new Date(r.newestTs * 1000).toISOString() : 'n/a';
      console.log(`${r.returnedBars.toLocaleString().padStart(10)} bars  span=${(r.spanDays ?? 0).toString().padStart(7)}d  ${oldest} → ${newest}  (${r.elapsedMs}ms, ${r.timescaleUpdates} updates, ${r.paginationCyclesCompleted}/${r.paginationCyclesRequested} pgn cycles)`);
    }
    if (r.error && r.returnedBars > 0) {
      console.log(`    note: ${r.error} (got data anyway)`);
    }

    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
  }

  // Summary table
  console.log('\n=== Summary ===');
  console.log('Label                  | Requested  | Returned   | Span (d) | Cycles | Gain bars | Gain (d)');
  console.log('-----------------------+------------+------------+----------+--------+-----------+---------');
  for (const r of results) {
    const req = r.requestedBars.toLocaleString().padStart(10);
    const ret = r.returnedBars.toLocaleString().padStart(10);
    const span = (r.spanDays ?? 0).toString().padStart(8);
    const cyc = `${r.paginationCyclesCompleted}/${r.paginationCyclesRequested}`.padStart(6);
    const gainBars = (r.paginationGainBars ?? 0).toLocaleString().padStart(9);
    const gainDays = (r.paginationGainDays ?? 0).toString().padStart(7);
    console.log(`${r.label.padEnd(22)} | ${req} | ${ret} | ${span} | ${cyc} | ${gainBars} | ${gainDays}`);
  }

  // Write JSON report
  const reportPath = `/tmp/tv-history-probe-${Date.now()}.json`;
  fs.writeFileSync(reportPath, JSON.stringify({
    symbol: SYMBOL,
    runAt: new Date().toISOString(),
    auth: { source: auth.source, ttlMin: Math.floor(auth.ttl / 60), hasCookies: !!cookieHeader },
    tests: results
  }, null, 2));
  console.log(`\nReport: ${reportPath}`);

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
