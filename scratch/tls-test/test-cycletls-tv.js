// CycleTLS vs TradingView polling cap test.
//
// Opens a WebSocket to wss://prodata.tradingview.com/... using Chrome's TLS
// fingerprint (via cycletls), sends the same minimal protocol our lt-monitor
// uses (set_auth_token, quote_create_session, quote_add_symbols), and watches
// for the ~65-75s polling-cap disconnect that's been biting us with the stock
// `ws` library.
//
// Success: WS stays open for >5 minutes, receiving quote updates continuously.
// Failure: TV cuts us at the usual ~65-75s mark — means cycletls's Chrome
// fingerprint isn't enough and we need to explore the JA3/JA4 string more.
//
// Run: node test-cycletls-tv.js [duration_ms]

import initCycleTLS from 'cycletls';
import Redis from 'ioredis';

const TEST_DURATION_MS = parseInt(process.argv[2] || `${10 * 60 * 1000}`, 10); // 10 min default
const REDIS_URL = `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;

// Modern Chrome 131+ JA3 (from public fingerprint databases — same shape as
// what tls.peet.ws reported for a real Chrome session).
const CHROME_JA3 = '771,4865-4867-4866-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Build a TradingView protocol frame: `~m~<len>~m~<payload>`
function frame(payload) {
  return `~m~${payload.length}~m~${payload}`;
}
function msgFrame(method, params) {
  const body = JSON.stringify({ m: method, p: params });
  return frame(body);
}

async function loadAuthFromRedis() {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await r.connect();
  const jwt = await r.get('tradingview:jwt_token');
  const cookiesRaw = await r.get('tradingview:session_cookies');
  r.disconnect();
  const cookies = cookiesRaw ? JSON.parse(cookiesRaw) : {};
  return { jwt, cookies };
}

function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function main() {
  console.log('=== CycleTLS vs TradingView polling-cap test ===');
  console.log(`Test duration: ${TEST_DURATION_MS / 1000}s`);

  const { jwt, cookies } = await loadAuthFromRedis();
  if (!jwt) {
    console.error('No JWT in Redis (`tradingview:jwt_token`). Bootstrap via /tv-auth/sessionid first.');
    process.exit(1);
  }
  console.log(`JWT loaded: ${jwt.length} chars`);
  console.log(`Cookies loaded: ${Object.keys(cookies).join(', ') || 'NONE'}`);

  console.log('Initializing CycleTLS (spawning Go child)...');
  const cycletls = await initCycleTLS({ port: 9595, autoExit: true });
  console.log('CycleTLS ready');

  // Build the WS URL with the same query params our prod client uses
  const now = new Date().toISOString().slice(0, 19);
  const params = new URLSearchParams({
    from: 'chart/4NTS38Zt/',
    date: now,
    type: 'chart',
    auth: 'sessionid',
  });
  const url = `wss://prodata.tradingview.com/socket.io/websocket?${params.toString()}`;
  console.log(`Opening WS to: ${url}`);

  const ws = await cycletls.ws(url, {
    ja3: CHROME_JA3,
    userAgent: CHROME_UA,
    headers: {
      'Origin': 'https://www.tradingview.com',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      ...(Object.keys(cookies).length ? { 'Cookie': buildCookieHeader(cookies) } : {}),
    },
  });
  console.log(`WS opened, status: ${ws.status}`);

  // Stats
  const stats = {
    msgCount: 0,
    quoteCount: 0,
    heartbeatRecv: 0,
    pingSent: 0,
    bytesIn: 0,
    startTs: Date.now(),
    lastMsgTs: Date.now(),
    lastQuoteTs: null,
  };

  let pingCounter = 0;
  let testTimeout;
  let closed = false;

  ws.onMessage((msg) => {
    stats.msgCount += 1;
    stats.lastMsgTs = Date.now();
    const data = msg.data?.toString?.() || String(msg.data);
    stats.bytesIn += data.length;

    // Heartbeat from TV: ~m~N~m~~h~K — echo it back
    if (/^~m~\d+~m~~h~\d+$/.test(data)) {
      stats.heartbeatRecv += 1;
      ws.send(data).catch(e => console.warn('echo failed:', e.message));
      return;
    }
    // Quote/chart data starts with ~m~N~m~{...}
    if (/~m~\d+~m~\{/.test(data)) {
      // crude quote-message detection
      if (data.includes('"qsd"')) stats.quoteCount += 1;
      if (data.includes('"protocol_error"') || data.includes('"critical_error"')) {
        console.warn('TV protocol error:', data.slice(0, 200));
      }
    }
  });

  ws.onClose((code, reason) => {
    if (closed) return;
    closed = true;
    const uptimeSec = Math.floor((Date.now() - stats.startTs) / 1000);
    console.log(`\n❌ WS CLOSED after ${uptimeSec}s — code=${code} reason=${reason || 'none'}`);
    printStats();
    if (testTimeout) clearTimeout(testTimeout);
    cycletls.exit().catch(() => {});
    process.exit(code === 1000 ? 1 : 0);
  });

  ws.onError((err) => {
    console.error('WS error:', err.message || err);
  });

  // Initial protocol handshake
  console.log('Sending initial handshake...');
  await ws.send(msgFrame('set_auth_token', [jwt]));
  await ws.send(msgFrame('set_locale', ['en', 'US']));
  const qs = 'qs_' + Math.random().toString(36).slice(2, 14);
  await ws.send(msgFrame('quote_create_session', [qs]));
  await ws.send(msgFrame('quote_set_fields', [qs, 'ch', 'chp', 'lp', 'volume', 'high_price', 'low_price', 'open_price', 'description']));
  await ws.send(msgFrame('quote_add_symbols', [qs, 'CME_MINI:NQM2026']));
  console.log('Handshake sent; subscribed to CME_MINI:NQM2026');

  // Client-originated keepalive ping every 10s
  const pingInterval = setInterval(() => {
    if (closed) return;
    pingCounter += 1;
    stats.pingSent += 1;
    const body = `~h~${pingCounter}`;
    ws.send(`~m~${body.length}~m~${body}`).catch(e => console.warn('ping failed:', e.message));
    process.stdout.write(`[${pingCounter * 10}s uptime] msgs=${stats.msgCount} quotes=${stats.quoteCount} hb=${stats.heartbeatRecv} pings=${stats.pingSent}\r`);
  }, 10_000);

  // Periodic full snapshot
  const snapshotInterval = setInterval(() => {
    if (closed) return;
    const uptimeSec = Math.floor((Date.now() - stats.startTs) / 1000);
    console.log(`\n[snapshot ${uptimeSec}s] msgs=${stats.msgCount} quotes=${stats.quoteCount} hb_recv=${stats.heartbeatRecv} pings_sent=${stats.pingSent} bytesIn=${(stats.bytesIn / 1024).toFixed(1)}KB`);
  }, 60_000);

  testTimeout = setTimeout(() => {
    if (closed) return;
    closed = true;
    const uptimeSec = Math.floor((Date.now() - stats.startTs) / 1000);
    console.log(`\n✅ TEST PASSED — WS survived ${uptimeSec}s without polling-cap cut`);
    printStats();
    clearInterval(pingInterval);
    clearInterval(snapshotInterval);
    ws.close().catch(() => {});
    cycletls.exit().catch(() => {});
    process.exit(0);
  }, TEST_DURATION_MS);

  function printStats() {
    console.log('Final stats:', JSON.stringify({ ...stats, uptimeSec: Math.floor((Date.now() - stats.startTs) / 1000) }, null, 2));
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
