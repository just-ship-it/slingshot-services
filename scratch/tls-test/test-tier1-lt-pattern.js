// Experiment A: does TV's polling cap differ for chart_session+create_series
// (lt-monitor's pattern) vs quote_add_symbols (our passing test pattern)?
//
// Same TLS-tuned Agent as test-tier1-node-tls.js (proven to survive 35 min on
// quote-only subscription). This script mirrors lt-monitor's full init
// sequence up to and including create_series (but NOT the Pine PUB study —
// that needs a metadata HTTP fetch that's tangential). If TV cuts us at ~75s
// here too, we know the chart+series pattern is what TV's classifier dislikes.
// If we survive, the Pine PUB study itself is the trigger.
//
// Run:  node test-tier1-lt-pattern.js [duration_ms]

import https from 'https';
import tls from 'tls';
import WebSocket from 'ws';
import Redis from 'ioredis';

const REDIS_URL = `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
const TEST_DURATION_MS = parseInt(process.argv[2] || `${4 * 60 * 1000}`, 10);
const SYMBOL = 'CME_MINI:NQM2026';
const TIMEFRAME = '1';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const TLS13_CIPHERSUITES = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';

class ChromeTunedAgent extends https.Agent {
  constructor() { super({ keepAlive: false }); }
  createConnection(options, callback) {
    const sock = tls.connect({
      host: options.host,
      port: options.port,
      servername: options.servername || options.host,
      ALPNProtocols: ['h2', 'http/1.1'],
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
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

function frame(payload) { return `~m~${payload.length}~m~${payload}`; }
function msgFrame(method, params) { return frame(JSON.stringify({ m: method, p: params })); }
function genSession(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 14); }

async function loadAuth() {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await r.connect();
  const jwt = await r.get('tradingview:jwt_token');
  const cookiesRaw = await r.get('tradingview:session_cookies');
  r.disconnect();
  return { jwt, cookies: cookiesRaw ? JSON.parse(cookiesRaw) : {} };
}

async function main() {
  console.log('=== Exp A: lt-monitor-pattern subscription, TLS-tuned Agent ===');
  console.log(`Symbol: ${SYMBOL}  Timeframe: ${TIMEFRAME}m  Duration: ${TEST_DURATION_MS/1000}s`);

  const { jwt, cookies } = await loadAuth();
  if (!jwt) { console.error('No JWT in Redis'); process.exit(1); }
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  const now = new Date().toISOString().slice(0, 19);
  const params = new URLSearchParams({ from: 'chart/4NTS38Zt/', date: now, type: 'chart', auth: 'sessionid' });
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

  const stats = { msgCount: 0, quoteCount: 0, seriesUpdates: 0, hbRecv: 0, pingSent: 0, startTs: 0 };
  let pingCounter = 0, pingInterval, timeout, closed = false;

  ws.on('open', () => {
    stats.startTs = Date.now();
    console.log(`WS OPEN @ ${new Date().toISOString().slice(11, 19)} — sending lt-monitor handshake sequence`);

    const cs = genSession('cs');  // chart session
    const qs = genSession('qs');  // quote session

    // 1. Auth + locale
    ws.send(msgFrame('set_auth_token', [jwt]));
    ws.send(msgFrame('set_locale', ['en', 'US']));

    // 2. Create chart + quote sessions
    ws.send(msgFrame('chart_create_session', [cs, '']));
    ws.send(msgFrame('quote_create_session', [qs]));

    // 3. Quote fields (matching lt-monitor exactly)
    ws.send(msgFrame('quote_set_fields', [
      qs,
      'ch', 'chp', 'current_session', 'description', 'local_description',
      'language', 'exchange', 'fractional', 'is_tradable', 'lp', 'lp_time',
      'minmov', 'minmove2', 'original_name', 'pricescale', 'pro_name',
      'short_name', 'type', 'update_mode', 'volume', 'currency_code',
      'rchp', 'rtc'
    ]));

    // 4. Resolve symbol for chart + add to quote
    const resolveJson = JSON.stringify({ adjustment: 'splits', symbol: SYMBOL });
    ws.send(msgFrame('quote_add_symbols', [qs, `=${resolveJson}`]));
    ws.send(msgFrame('resolve_symbol', [cs, 'sds_sym_1', `=${resolveJson}`]));

    // 5. Create the series — 1m, 700 bars (matches lt-monitor)
    ws.send(msgFrame('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', TIMEFRAME, 700, '']));

    // 6. Fast symbols (matches lt-monitor's keep-alive-ish trick)
    ws.send(msgFrame('quote_fast_symbols', [qs, SYMBOL]));

    console.log(`Handshake sent: chart_session=${cs.slice(0,10)}.. quote_session=${qs.slice(0,10)}..`);

    pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      pingCounter += 1;
      stats.pingSent += 1;
      ws.send(frame(`~h~${pingCounter}`));
      const uptime = Math.floor((Date.now() - stats.startTs) / 1000);
      process.stdout.write(`  [uptime ${uptime}s] msgs=${stats.msgCount} quotes=${stats.quoteCount} series=${stats.seriesUpdates} hb=${stats.hbRecv} pings=${stats.pingSent}\r`);
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
    if (/"timescale_update"|"du"/.test(s)) stats.seriesUpdates += 1;
    if (/"protocol_error"|"critical_error"/.test(s)) {
      console.warn('\nTV protocol error:', s.slice(0, 240));
    }
  });

  ws.on('error', (e) => console.error('WS error:', e.message));

  ws.on('close', (code, reason) => {
    if (closed) return; closed = true;
    const uptime = stats.startTs ? Math.floor((Date.now() - stats.startTs) / 1000) : 0;
    console.log(`\n❌ WS CLOSED after ${uptime}s — code=${code}, reason=${reason?.toString() || 'none'}`);
    console.log('Final stats:', stats);
    if (uptime > 90) console.log('✅ Survived >90s — chart+series subscription does NOT trigger the cap');
    else console.log('❌ Cut early — chart+series subscription DOES trigger the cap (TLS tuning insufficient for this pattern)');
    clearInterval(pingInterval);
    clearTimeout(timeout);
    process.exit(0);
  });

  timeout = setTimeout(() => {
    if (closed) return; closed = true;
    const uptime = Math.floor((Date.now() - stats.startTs) / 1000);
    console.log(`\n✅ TEST PASSED — chart+series survived ${uptime}s. Pine PUB study likely is the cap trigger.`);
    console.log('Final stats:', stats);
    clearInterval(pingInterval);
    ws.close();
    process.exit(0);
  }, TEST_DURATION_MS);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
