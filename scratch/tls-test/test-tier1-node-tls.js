// Tier-1 test: pure-Node TLS tuning vs TradingView polling cap.
//
// We can't replicate Chrome's ClientHello exactly from Node (OpenSSL ≠
// BoringSSL, no GREASE, no Chrome-specific extensions). But we CAN force:
//   - TLS 1.3 only (matches Chrome/Firefox/Electron baseline)
//   - ALPN order ['h2', 'http/1.1'] (matches browser)
//   - Servername (SNI) explicitly
//   - Limit cipher list to TLS 1.3 only (no TLS 1.2 fallbacks visible)
//
// Step 1: hit tls.peet.ws to get our JA4 hash under these settings.
// Step 2: open a WebSocket to prodata.tradingview.com using a custom Agent
//          that returns our tuned tls.TLSSocket. Watch uptime for ≥75s — if
//          we exceed the polling-cap window, this tier passes.
//
// Run:  node test-tier1-node-tls.js [duration_ms]

import https from 'https';
import tls from 'tls';
import WebSocket from 'ws';
import Redis from 'ioredis';

const REDIS_URL = `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
const TEST_DURATION_MS = parseInt(process.argv[2] || `${5 * 60 * 1000}`, 10);

// Settings we'll apply to every TLS connection in this test.
const CHROME_LIKE_TLS = {
  ALPNProtocols: ['h2', 'http/1.1'],
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
  // Force only TLS-1.3 ciphersuites (the only three the spec defines).
  // Node's `ciphers` controls TLS<=1.2; TLS 1.3 ciphersuites have a separate
  // OpenSSL knob exposed via secureContext.tls13Ciphers (Node 22+).
};
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const TLS13_CIPHERSUITES = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';

class ChromeTunedAgent extends https.Agent {
  constructor(opts = {}) {
    super({ keepAlive: false, ...opts });
  }
  createConnection(options, callback) {
    const sock = tls.connect({
      host: options.host,
      port: options.port,
      servername: options.servername || options.host,
      ALPNProtocols: ['h2', 'http/1.1'],
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      // honorCipherOrder doesn't apply to client-side, but spec our preferences:
      ciphers: TLS13_CIPHERSUITES,
      ecdhCurve: 'X25519:P-256:P-384',
      requestOCSP: true,
    });
    if (callback) {
      sock.once('secureConnect', () => callback(null, sock));
      sock.once('error', (e) => callback(e));
    }
    return sock;
  }
}

async function step1_checkJa4() {
  console.log('=== Step 1: probe our JA4 via tls.peet.ws ===');
  const agent = new ChromeTunedAgent();
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'tls.peet.ws',
      port: 443,
      path: '/api/all',
      method: 'GET',
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
      },
      agent,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          const j = JSON.parse(body);
          console.log(`  TLS negotiated: ${j.tls?.tls_version_negotiated} (771=1.2, 772=1.3)`);
          console.log(`  HTTP version:   ${j.http_version}`);
          console.log(`  JA3 hash:       ${j.tls?.ja3_hash}`);
          console.log(`  JA4:            ${j.tls?.ja4}`);
          console.log(`  Cipher count:   ${j.tls?.ciphers?.length}`);
          console.log(`  Extensions:     ${j.tls?.extensions?.map(e => e.name?.match(/^(\S+)/)?.[1]).join(', ')}`);
          console.log('  Compare to known browser JA4s:');
          console.log('    Chrome 148 (approx):  t13d1517h2_...');
          console.log('    Firefox 150 (Drew):   t13d1617h2_86a278354501_3cbfd9057e0d');
          console.log('    Node default (prev):  t13d5911h1_a33745022dd6_1f22a2ca17c4');
          resolve();
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function loadAuth() {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await r.connect();
  const jwt = await r.get('tradingview:jwt_token');
  const cookiesRaw = await r.get('tradingview:session_cookies');
  r.disconnect();
  return { jwt, cookies: cookiesRaw ? JSON.parse(cookiesRaw) : {} };
}

function frame(payload) { return `~m~${payload.length}~m~${payload}`; }
function msgFrame(method, params) { return frame(JSON.stringify({ m: method, p: params })); }

async function step2_tvWebsocketTest() {
  console.log('\n=== Step 2: open WS to TradingView with tuned TLS ===');
  const { jwt, cookies } = await loadAuth();
  if (!jwt) { console.error('No JWT in Redis'); process.exit(1); }
  console.log(`JWT loaded (${jwt.length} chars), cookies: ${Object.keys(cookies).join(', ')}`);

  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const now = new Date().toISOString().slice(0, 19);
  const params = new URLSearchParams({
    from: 'chart/4NTS38Zt/', date: now, type: 'chart', auth: 'sessionid',
  });
  const wsUrl = `wss://prodata.tradingview.com/socket.io/websocket?${params.toString()}`;

  const ws = new WebSocket(wsUrl, {
    agent: new ChromeTunedAgent(),
    headers: {
      'User-Agent': CHROME_UA,
      'Origin': 'https://www.tradingview.com',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
    },
  });

  const stats = { msgCount: 0, quoteCount: 0, hbRecv: 0, pingSent: 0, startTs: 0 };
  let pingCounter = 0, pingInterval, closed = false, timeout;

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      stats.startTs = Date.now();
      console.log(`WS OPEN @ ${new Date().toISOString().slice(11, 19)} — sending handshake`);
      ws.send(msgFrame('set_auth_token', [jwt]));
      ws.send(msgFrame('set_locale', ['en', 'US']));
      const qs = 'qs_' + Math.random().toString(36).slice(2, 14);
      ws.send(msgFrame('quote_create_session', [qs]));
      ws.send(msgFrame('quote_set_fields', [qs, 'ch', 'chp', 'lp', 'volume', 'high_price', 'low_price', 'open_price']));
      ws.send(msgFrame('quote_add_symbols', [qs, 'CME_MINI:NQM2026']));
      console.log(`Subscribed to CME_MINI:NQM2026`);

      pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        pingCounter += 1; stats.pingSent += 1;
        const body = `~h~${pingCounter}`;
        ws.send(frame(body));
        const uptime = Math.floor((Date.now() - stats.startTs) / 1000);
        process.stdout.write(`  [uptime ${uptime}s] msgs=${stats.msgCount} quotes=${stats.quoteCount} hb=${stats.hbRecv} pings=${stats.pingSent}\r`);
      }, 10_000);
    });
    ws.on('message', (data) => {
      stats.msgCount += 1;
      const s = data.toString();
      if (/^~m~\d+~m~~h~\d+$/.test(s)) {
        stats.hbRecv += 1;
        ws.send(s);
        return;
      }
      if (/"qsd"/.test(s)) stats.quoteCount += 1;
      if (/"protocol_error"|"critical_error"/.test(s)) {
        console.warn('\nTV protocol error:', s.slice(0, 200));
      }
    });
    ws.on('error', (e) => {
      console.error('WS error:', e.message);
    });
    ws.on('close', (code, reason) => {
      if (closed) return; closed = true;
      const uptime = stats.startTs ? Math.floor((Date.now() - stats.startTs) / 1000) : 0;
      const reasonStr = reason?.toString() || '';
      console.log(`\n❌ WS CLOSED after ${uptime}s — code=${code}${reasonStr ? ', reason: ' + reasonStr.slice(0, 60) : ''}`);
      console.log('Final stats:', stats);
      clearInterval(pingInterval); clearTimeout(timeout);
      const passed = uptime > 90;
      console.log(passed ? `✅ EXCEEDED 90s — tier-1 likely passes` : `❌ Cut at ${uptime}s — same fingerprint as before`);
      resolve();
    });
    timeout = setTimeout(() => {
      if (closed) return; closed = true;
      const uptime = Math.floor((Date.now() - stats.startTs) / 1000);
      console.log(`\n✅ TIER-1 PASSED — WS survived ${uptime}s without polling-cap cut`);
      console.log('Final stats:', stats);
      clearInterval(pingInterval);
      ws.close();
      resolve();
    }, TEST_DURATION_MS);
  });
}

async function main() {
  try { await step1_checkJa4(); }
  catch (e) { console.error('Step 1 failed:', e.message); }
  await step2_tvWebsocketTest();
  process.exit(0);
}
main();
