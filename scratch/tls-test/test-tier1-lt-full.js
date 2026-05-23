// Experiment A.2: full lt-monitor pattern INCLUDING Pine PUB studies.
//
// Same TLS-tuned Agent. Replicates lt-monitor's exact behavior end-to-end:
//   - chart_create_session + quote sessions
//   - resolve_symbol + create_series (700 bars, 1m)
//   - quote_fast_symbols
//   - fetch Pine indicator metadata for LT + LS via HTTPS
//   - create_study for both with the fetched metadata payloads
//
// If THIS dies at ~75s, the Pine PUB study is confirmed as the cap trigger.
// If it survives, something else in lt-monitor (timing? state?) is different.

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
const LT_INDICATOR = 'PUB;93e43ec4c20f420fac2b70f0f2b286cf';
const LS_INDICATOR = 'PUB;eb74f266acd04379bd7828ba0fd54c84';

class ChromeTunedAgent extends https.Agent {
  constructor() { super({ keepAlive: false }); }
  createConnection(options, callback) {
    const sock = tls.connect({
      host: options.host, port: options.port,
      servername: options.servername || options.host,
      ALPNProtocols: ['h2', 'http/1.1'],
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
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

function frame(p) { return `~m~${p.length}~m~${p}`; }
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

async function fetchIndicatorMetadata(scriptId, version = '1') {
  const url = `https://pine-facade.tradingview.com/pine-facade/translate/${scriptId}/${version}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': CHROME_UA,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`metadata fetch ${scriptId} → ${res.status}`);
  const data = await res.json();
  const metainfo = data.result?.metaInfo;
  if (!metainfo) throw new Error(`no metainfo for ${scriptId}`);
  const m = data.result?.id?.match(/@(tv-scripting-\d+)/);
  const endpoint = m ? `Script@${m[1]}!` : 'Script@tv-scripting-101!';
  return { metainfo, endpoint };
}

function preparePayload(scriptId, metainfo) {
  const payload = {
    text: metainfo.inputs?.[0]?.defval || '',
    pineId: scriptId,
    pineVersion: metainfo.pine?.version || '1.0',
    pineFeatures: { v: '{"indicator":1,"plot":1,"ta":1}', f: true, t: 'text' },
    __profile: { v: false, f: true, t: 'bool' },
  };
  (metainfo.inputs || []).forEach(input => {
    if (input.id && input.id.startsWith('in_')) {
      payload[input.id] = { v: input.defval, f: true, t: input.type };
    }
  });
  return payload;
}

async function main() {
  console.log('=== Exp A.2: FULL lt-monitor pattern (chart+series+Pine PUB studies) ===');
  console.log(`Duration: ${TEST_DURATION_MS/1000}s`);

  const { jwt, cookies } = await loadAuth();
  if (!jwt) { console.error('No JWT'); process.exit(1); }
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

  const stats = { msgCount: 0, quoteCount: 0, hbRecv: 0, pingSent: 0, ltStudyCreated: false, lsStudyCreated: false, startTs: 0 };
  let pingCounter = 0, pingInterval, timeout, closed = false;
  const cs = genSession('cs');
  const qs = genSession('qs');

  ws.on('open', () => {
    stats.startTs = Date.now();
    console.log(`WS OPEN @ ${new Date().toISOString().slice(11,19)} — sending handshake`);
    ws.send(msgFrame('set_auth_token', [jwt]));
    ws.send(msgFrame('set_locale', ['en', 'US']));
    ws.send(msgFrame('chart_create_session', [cs, '']));
    ws.send(msgFrame('quote_create_session', [qs]));
    ws.send(msgFrame('quote_set_fields', [qs,
      'ch', 'chp', 'current_session', 'description', 'local_description', 'language',
      'exchange', 'fractional', 'is_tradable', 'lp', 'lp_time', 'minmov', 'minmove2',
      'original_name', 'pricescale', 'pro_name', 'short_name', 'type', 'update_mode',
      'volume', 'currency_code', 'rchp', 'rtc',
    ]));
    const resolveJson = JSON.stringify({ adjustment: 'splits', symbol: SYMBOL });
    ws.send(msgFrame('quote_add_symbols', [qs, `=${resolveJson}`]));
    ws.send(msgFrame('resolve_symbol', [cs, 'sds_sym_1', `=${resolveJson}`]));
    ws.send(msgFrame('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', TIMEFRAME, 700, '']));
    ws.send(msgFrame('quote_fast_symbols', [qs, SYMBOL]));
    console.log('Chart+series sent — waiting 3s before adding Pine studies (mirroring lt-monitor)');

    setTimeout(async () => {
      try {
        console.log('Fetching LT indicator metadata...');
        const lt = await fetchIndicatorMetadata(LT_INDICATOR);
        const ltPayload = preparePayload(LT_INDICATOR, lt.metainfo);
        ws.send(msgFrame('create_study', [cs, 'st9', 'st1', 'sds_1', lt.endpoint, ltPayload]));
        stats.ltStudyCreated = true;
        console.log(`📐 LT study created (endpoint=${lt.endpoint}) at uptime ${Math.floor((Date.now()-stats.startTs)/1000)}s`);

        console.log('Fetching LS indicator metadata...');
        const ls = await fetchIndicatorMetadata(LS_INDICATOR);
        const lsPayload = preparePayload(LS_INDICATOR, ls.metainfo);
        ws.send(msgFrame('create_study', [cs, 'st10', 'st2', 'sds_1', ls.endpoint, lsPayload]));
        stats.lsStudyCreated = true;
        console.log(`📐 LS study created (endpoint=${ls.endpoint}) at uptime ${Math.floor((Date.now()-stats.startTs)/1000)}s`);
      } catch (e) {
        console.error('Study setup error:', e.message);
      }
    }, 3000);

    pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      pingCounter += 1; stats.pingSent += 1;
      ws.send(frame(`~h~${pingCounter}`));
      const uptime = Math.floor((Date.now() - stats.startTs) / 1000);
      process.stdout.write(`  [uptime ${uptime}s] msgs=${stats.msgCount} hb=${stats.hbRecv} pings=${stats.pingSent} LT=${stats.ltStudyCreated?'Y':'n'} LS=${stats.lsStudyCreated?'Y':'n'}\r`);
    }, 10_000);
  });

  ws.on('message', (data) => {
    stats.msgCount += 1;
    const s = data.toString();
    if (/^~m~\d+~m~~h~\d+$/.test(s)) { stats.hbRecv += 1; ws.send(s); return; }
    if (/"qsd"/.test(s)) stats.quoteCount += 1;
    if (/"protocol_error"|"critical_error"|"study_error"/.test(s)) {
      console.warn('\n⚠️ TV error:', s.slice(0, 280));
    }
  });

  ws.on('error', (e) => console.error('WS error:', e.message));
  ws.on('close', (code, reason) => {
    if (closed) return; closed = true;
    const uptime = stats.startTs ? Math.floor((Date.now() - stats.startTs) / 1000) : 0;
    console.log(`\n❌ WS CLOSED after ${uptime}s — code=${code}, reason=${reason?.toString() || 'none'}`);
    console.log('Final stats:', stats);
    if (uptime <= 90) console.log('❌ Cut at the polling-cap window — Pine PUB study CONFIRMED as the trigger');
    else console.log(`✅ Survived ${uptime}s with full Pine PUB studies — something else must be different in lt-monitor`);
    clearInterval(pingInterval); clearTimeout(timeout); process.exit(0);
  });

  timeout = setTimeout(() => {
    if (closed) return; closed = true;
    const uptime = Math.floor((Date.now() - stats.startTs) / 1000);
    console.log(`\n✅ Survived ${uptime}s with Pine PUB studies attached — Pine studies are NOT the cap trigger.`);
    console.log('Final stats:', stats);
    clearInterval(pingInterval);
    ws.close();
    process.exit(0);
  }, TEST_DURATION_MS);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
