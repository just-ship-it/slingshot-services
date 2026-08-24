#!/usr/bin/env node
/**
 * Macro Daily OHLCV Fetcher (TradingView)
 * ---------------------------------------
 * Pulls DAILY bars for a cross-market basket via TradingView's WebSocket,
 * reusing the system's cached JWT + session cookies (same auth path as
 * signal-generator/src/websocket/tradingview-client.js and tv-history-probe.js).
 * Writes one CSV per symbol: date,ts,open,high,low,close,volume.
 *
 * Purpose: cross-market macro divergence research (daily/swing timeframe). Daily
 * history goes back years on TV — unlike the 24-45 day 1m wall — so a single
 * create_series request usually returns the full series.
 *
 * Run (in an env where TV auth is available — i.e. shared/.env has
 * TRADINGVIEW_JWT_TOKEN or cached session cookies live in Redis):
 *   node backtest-engine/scripts/fetch-macro-daily.js
 *   node backtest-engine/scripts/fetch-macro-daily.js --symbols TLT,HYG --bars 6000
 *   node backtest-engine/scripts/fetch-macro-daily.js --out data/macro
 *
 * Output: backtest-engine/data/macro/<name>_1d.csv
 */
import 'dotenv/config';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getBestAvailableToken, getCachedSessionCookies, refreshJwtFromSession,
  cacheTokenInRedis, getTokenTTL,
} from '../../signal-generator/src/utils/tradingview-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dotenv = await import('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '..', 'shared', '.env') });

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TV_HOST = 'prodata.tradingview.com';
const TV_ORIGIN = 'https://www.tradingview.com';
const OLDEST_STABLE_MS = 8000;
const STABLE_POLL_MS = 1000;
const TEST_TIMEOUT_MS = 120_000;
const INTER_SYMBOL_DELAY_MS = 3000;

// Cross-market basket. name → TradingView symbol. Edit freely; ETF proxies are
// tradeable (option-expressible); TVC:* are the underlying indices.
const BASKET = [
  { name: 'nq',   tv: 'CME_MINI:NQ1!' },     // the target (equity index futures)
  { name: 'spy',  tv: 'AMEX:SPY' },          // broad equity / breadth ref
  { name: 'vix',  tv: 'TVC:VIX' },           // vol / risk-off (also local)
  { name: 'tlt',  tv: 'NASDAQ:TLT' },        // long rates (risk-off)
  { name: 'ief',  tv: 'NASDAQ:IEF' },        // 7-10y rates
  { name: 'hyg',  tv: 'AMEX:HYG' },          // high-yield credit (stress lead)
  { name: 'lqd',  tv: 'AMEX:LQD' },          // IG credit
  { name: 'uup',  tv: 'AMEX:UUP' },          // dollar (ETF)
  { name: 'dxy',  tv: 'TVC:DXY' },           // dollar index (alt)
  { name: 'gld',  tv: 'AMEX:GLD' },          // gold / safe-haven
  { name: 'iwm',  tv: 'AMEX:IWM' },          // small caps (breadth)
  { name: 'btc',  tv: 'BITSTAMP:BTCUSD' },   // crypto / risk appetite (long history)
  // Commodity complex (genuinely uncorrelated with equities — book diversifiers)
  { name: 'gc',   tv: 'COMEX:GC1!' },        // gold futures (tradeable: GC/MGC)
  { name: 'cl',   tv: 'NYMEX:CL1!' },        // WTI crude futures (tradeable: CL/MCL)
  { name: 'si',   tv: 'COMEX:SI1!' },        // silver
  { name: 'hg',   tv: 'COMEX:HG1!' },        // copper (growth proxy)
  { name: 'ng',   tv: 'NYMEX:NG1!' },        // natural gas
  // Market internals (breadth) — RTH-only series; TICK/TRIN closes are noise,
  // bar HIGH/LOW carry the extreme readings. ADD/VOLD closes are meaningful.
  { name: 'tick',  tv: 'USI:TICK' },         // NYSE tick (upticking - downticking issues)
  { name: 'tickq', tv: 'USI:TICKQ' },        // Nasdaq tick (NQ-native breadth)
  { name: 'add',   tv: 'USI:ADD' },          // NYSE advancers - decliners
  { name: 'addq',  tv: 'USI:ADDQ' },         // Nasdaq advancers - decliners
  { name: 'vold',  tv: 'USI:VOLD' },         // NYSE up-volume - down-volume
  { name: 'voldq', tv: 'USI:VOLDQ' },        // Nasdaq up/down volume diff
  { name: 'trin',  tv: 'USI:TRIN' },         // NYSE arms index
  // Vol web (cross-asset vol surfaces — "is the whole web repricing?")
  { name: 'vxn',   tv: 'CBOE:VXN' },         // Nasdaq-100 vol (NQ's own VIX)
  { name: 'vvix',  tv: 'CBOE:VVIX' },        // vol-of-vol
  { name: 'vix9d', tv: 'CBOE:VIX9D' },       // short-dated vol (term structure front)
  { name: 'vix3m', tv: 'CBOE:VIX3M' },       // 3m vol (term structure back)
  { name: 'move',  tv: 'TVC:MOVE' },         // bond vol (ICE BofA MOVE)
  { name: 'ovx',   tv: 'CBOE:OVX' },         // oil vol
  { name: 'gvz',   tv: 'CBOE:GVZ' },         // gold vol
  { name: 'cor1m', tv: 'CBOE:COR1M' },       // 1m implied correlation (dispersion regime)
  { name: 'cor3m', tv: 'CBOE:COR3M' },       // 3m implied correlation
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
  const params = new URLSearchParams({ from: 'chart/4NTS38Zt/', date: now, type: 'chart', auth: 'sessionid' });
  return `wss://${TV_HOST}/socket.io/websocket?${params.toString()}`;
}

async function fetchSymbol(tvSymbol, resolution, bars, pages, jwt, cookieHeader) {
  const chartSession = genId('cs');
  const quoteSession = genId('qs');
  return new Promise((resolve) => {
    const headers = {
      'Connection': 'upgrade', 'Host': TV_HOST, 'Origin': TV_ORIGIN, 'Cache-Control': 'no-cache',
      'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits', 'Sec-WebSocket-Version': '13',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br, zstd', 'Pragma': 'no-cache', 'Upgrade': 'websocket',
    };
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const ws = new WebSocket(buildTvUrl(), { headers });
    const barsMap = new Map(); // ts -> [o,h,l,c,v]
    let runningOldestTs = null, oldestLastChangedAt = Date.now();
    let pollTimer = null, pingInterval = null, hardTimeout = null, pingCounter = 0, done = false;
    const errors = [];

    const finish = (err) => {
      if (done) return; done = true;
      if (pollTimer) clearInterval(pollTimer);
      if (pingInterval) clearInterval(pingInterval);
      if (hardTimeout) clearTimeout(hardTimeout);
      const rows = Array.from(barsMap.entries()).sort((a, b) => a[0] - b[0]);
      try { ws.close(); } catch {}
      resolve({ rows, errors, error: err || null });
    };
    hardTimeout = setTimeout(() => finish('timeout'), TEST_TIMEOUT_MS);
    let cyclesCompleted = 0, lastSettleBarCount = 0;
    pollTimer = setInterval(() => {
      if (barsMap.size === 0) return;
      if (Date.now() - oldestLastChangedAt < OLDEST_STABLE_MS) return;
      // History delivery for this cycle has settled (oldest bar stable).
      const gained = barsMap.size - lastSettleBarCount;
      if (cyclesCompleted < pages && gained > 0) {
        cyclesCompleted += 1;
        lastSettleBarCount = barsMap.size;
        try { ws.send(wrapFrame('request_more_data', [chartSession, 'sds_1', bars])); oldestLastChangedAt = Date.now(); }
        catch { finish(); }
      } else {
        finish();
      }
    }, STABLE_POLL_MS);

    ws.on('open', () => {
      pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        pingCounter += 1; const body = `~h~${pingCounter}`;
        try { ws.send(`~m~${body.length}~m~${body}`); } catch {}
      }, 10_000);
      ws.send(wrapFrame('set_auth_token', [jwt || 'unauthorized_user_token']));
      ws.send(wrapFrame('set_locale', ['en', 'US']));
      ws.send(wrapFrame('quote_create_session', [quoteSession]));
      ws.send(wrapFrame('quote_set_fields', [quoteSession, 'lp', 'lp_time', 'update_mode']));
      const resolveSym = JSON.stringify({ adjustment: 'splits', symbol: tvSymbol });
      ws.send(wrapFrame('chart_create_session', [chartSession, '']));
      ws.send(wrapFrame('quote_add_symbols', [quoteSession, `=${resolveSym}`]));
      ws.send(wrapFrame('resolve_symbol', [chartSession, 'sds_sym_1', `=${resolveSym}`]));
      ws.send(wrapFrame('create_series', [chartSession, 'sds_1', 's1', 'sds_sym_1', resolution, bars, '']));
      oldestLastChangedAt = Date.now();
    });

    ws.on('message', (data) => {
      const message = data.toString();
      if (message.match(/^~m~\d+~m~~h~\d+$/)) { try { ws.send(message); } catch {} return; }
      for (const part of message.split(/~m~\d+~m~/)) {
        if (!part || !part.trim()) continue;
        let parsed; try { parsed = JSON.parse(part); } catch { continue; }
        if (parsed.m === 'timescale_update') {
          const ohlc = parsed.p?.[1]?.sds_1?.s || [];
          for (const bar of ohlc) {
            if (!bar.v || bar.v.length < 5) continue;
            const ts = bar.v[0];
            barsMap.set(ts, bar.v.slice(1));
            if (runningOldestTs === null || ts < runningOldestTs) { runningOldestTs = ts; oldestLastChangedAt = Date.now(); }
          }
        } else if (['series_error', 'cs_error', 'protocol_error', 'critical_error'].includes(parsed.m)) {
          errors.push({ m: parsed.m, p: parsed.p });
        }
      }
    });
    ws.on('error', (err) => finish(`ws_error: ${err.message}`));
    ws.on('close', (code, reason) => { if (barsMap.size === 0 && !done) finish(`closed_early: code=${code} reason=${reason || 'none'}`); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let bars = 8000, outDir = path.join(__dirname, '..', 'data', 'macro'), only = null;
  let resolution = '1D', pages = 0, merge = false, tvSymbols = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--merge') merge = true;
    else if (args[i] === '--bars' && args[i + 1]) bars = parseInt(args[++i], 10);
    else if (args[i] === '--out' && args[i + 1]) outDir = path.isAbsolute(args[i + 1]) ? args[++i] : path.join(process.cwd(), args[++i]);
    else if (args[i] === '--symbols' && args[i + 1]) only = args[++i].toLowerCase().split(',');
    // Arbitrary full TV symbols (exchange-prefixed), bypassing BASKET:
    //   --tv-symbols NYSE:GME,NASDAQ:BYND  → out files gme_1d.csv, bynd_1d.csv
    else if (args[i] === '--tv-symbols' && args[i + 1]) tvSymbols = args[++i].split(',');
    else if ((args[i] === '--resolution' || args[i] === '--res') && args[i + 1]) resolution = args[++i];
    else if (args[i] === '--pages' && args[i + 1]) pages = parseInt(args[++i], 10);
  }
  // Output suffix: '1D'→1d, '60'→1h, '240'→4h, '15'→15m, '5'→5m, '1'→1m, '1S'→1s
  const resSuffix = ({ '1D': '1d', '1W': '1w', '60': '1h', '120': '2h', '240': '4h' }[resolution])
    || (/^\d+$/.test(resolution) ? `${resolution}m` : resolution.toLowerCase());
  const basket = tvSymbols
    ? tvSymbols.map(s => ({ name: s.split(':').pop().toLowerCase(), tv: s }))
    : (only ? BASKET.filter(b => only.includes(b.name)) : BASKET);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('=== Market Data Fetcher (TradingView) ===');
  console.log(`Symbols: ${basket.map(b => b.name).join(', ')} | res: ${resolution} (${resSuffix}) | bars/req: ${bars} | pages: ${pages} | out: ${outDir}\n`);

  // Auth: refresh JWT from session cookies, then resolve best token (mirrors probe).
  let freshJwt = null;
  try {
    freshJwt = await refreshJwtFromSession(REDIS_URL);
    if (freshJwt) { await cacheTokenInRedis(REDIS_URL, freshJwt); console.log(`✓ JWT refreshed (TTL ${Math.floor(getTokenTTL(freshJwt) / 60)}min)`); }
  } catch (e) { console.log(`⚠ session refresh failed: ${e.message}`); }
  const auth = await getBestAvailableToken(process.env.TRADINGVIEW_JWT_TOKEN, REDIS_URL);
  if (!auth || !auth.token) { console.error('No TV JWT available. Set TRADINGVIEW_JWT_TOKEN in shared/.env or bootstrap TV auth (data-service /tv-auth).'); process.exit(1); }
  const cookies = await getCachedSessionCookies(REDIS_URL);
  const cookieHeader = cookies && Object.keys(cookies).length ? Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') : null;
  console.log(`JWT source: ${auth.source} | cookies: ${cookieHeader ? Object.keys(cookies).join(',') : 'none'}\n`);

  const summary = [];
  for (const { name, tv } of basket) {
    process.stdout.write(`▶ ${name.padEnd(5)} (${tv}) ... `);
    const { rows, errors, error } = await fetchSymbol(tv, resolution, bars, pages, auth.token, cookieHeader);
    if (!rows.length) {
      console.log(`FAILED${error ? ` (${error})` : ''}${errors.length ? ` [${errors.map(e => e.m).join(',')}]` : ''}`);
      summary.push({ name, tv, bars: 0, ok: false });
      await new Promise(r => setTimeout(r, INTER_SYMBOL_DELAY_MS));
      continue;
    }
    const outFile = path.join(outDir, `${name}_${resSuffix}.csv`);
    if (merge && fs.existsSync(outFile)) {
      // Union with existing rows so periodic re-runs accumulate history beyond
      // TV's rolling depth wall (1m ~6wk, 5m ~6mo). New fetch wins on ts collision.
      const existing = fs.readFileSync(outFile, 'utf8').trim().split('\n').slice(1);
      const merged = new Map();
      for (const line of existing) {
        const ts = parseInt(line.split(',')[1], 10);
        if (Number.isFinite(ts)) merged.set(ts, line.split(',').slice(2));
      }
      for (const [ts, ohlcv] of rows) merged.set(ts, ohlcv);
      rows.length = 0;
      rows.push(...Array.from(merged.entries()).sort((a, b) => a[0] - b[0]));
    }
    const lines = ['date,ts,open,high,low,close,volume'];
    for (const [ts, ohlcv] of rows) {
      const d = new Date(ts * 1000).toISOString().slice(0, 10);
      lines.push([d, ts, ...ohlcv].join(','));
    }
    fs.writeFileSync(outFile, lines.join('\n') + '\n');
    const oldest = new Date(rows[0][0] * 1000).toISOString().slice(0, 10);
    const newest = new Date(rows[rows.length - 1][0] * 1000).toISOString().slice(0, 10);
    console.log(`${String(rows.length).padStart(6)} bars  ${oldest} → ${newest}  → ${path.basename(outFile)}`);
    summary.push({ name, tv, bars: rows.length, oldest, newest, ok: true });
    await new Promise(r => setTimeout(r, INTER_SYMBOL_DELAY_MS));
  }

  const ok = summary.filter(s => s.ok).length;
  console.log(`\nDone: ${ok}/${summary.length} symbols. CSVs in ${outDir}`);
  const failed = summary.filter(s => !s.ok);
  if (failed.length) console.log(`Failed: ${failed.map(s => `${s.name}(${s.tv})`).join(', ')} — check the TV symbol prefix or entitlement.`);
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
