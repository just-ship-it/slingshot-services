#!/usr/bin/env node
/**
 * Dump ANY TradingView Pine study's history to CSV.
 *
 * We already pull two Pine studies live (LT levels, LS state) through the
 * lt-monitor socket. This generalises that path into an offline exporter so a
 * new indicator can be pulled into the backtest data set without touching the
 * live service.
 *
 * NOTE: T:H / T:5 are NOT the liquidity-trigger levels lt-monitor already reads
 * (those are the Fib set L0-L6 at value indices 5..17 of PUB;93e43ec4...). This
 * is a different script, so it needs its own id.
 *
 *   # 1. find the script id by name
 *   node dump-study.js --search "trigger"
 *
 *   # 2. dump it (also prints the plot titles so columns get real names)
 *   node dump-study.js --script "PUB;abc123..." --symbol CME_MINI:NQU2026 \
 *        --tf 3 --bars 5000 --out th_t5_3m.csv
 *
 * History depth is whatever TV serves for that timeframe — roughly 24-45 days on
 * NQ 1m, more on higher timeframes. For a deep series, run this on a schedule and
 * merge forward (same pattern as scripts/fetch-macro-daily.js --merge).
 */
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { getBestAvailableToken, getCachedSessionCookies } from
  '../../signal-generator/src/utils/tradingview-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const REDIS = process.env.REDIS_URL || 'redis://localhost:6379';
const TV_ORIGIN = 'https://www.tradingview.com';

async function searchScripts(q) {
  const url = `https://www.tradingview.com/pubscripts-suggest-json/?search=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Origin: TV_ORIGIN } });
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const j = await r.json();
  const rows = j.results || [];
  console.log(`\n${rows.length} matches for "${q}":\n`);
  for (const s of rows.slice(0, 25)) {
    console.log(`  ${(s.scriptIdPart || '').padEnd(42)} v${s.version || '?'}  ${s.scriptName}`);
    console.log(`  ${''.padEnd(42)}   by ${s.author?.username || '?'}  (${s.agreeCount || 0} boosts)`);
  }
  console.log('\nPass the id on the left to --script.');
}

async function fetchMeta(scriptId, version) {
  // Works WITHOUT auth even for invite-only scripts — the endpoint is keyed on
  // knowing the id. (lt-monitor fetches its invite-only LT script the same way.)
  const url = `https://pine-facade.tradingview.com/pine-facade/translate/${encodeURIComponent(scriptId)}/${version || 'last'}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`translate HTTP ${r.status}`);
  const j = await r.json();
  const meta = j.result?.metaInfo;
  if (!meta) throw new Error('no metaInfo in translate response');
  return meta;
}

/** Mirror lt-monitor.prepareIndicatorMetadata: inputs[0].defval is the compiled script. */
function studyPayload(scriptId, meta, version) {
  const p = {
    text: meta.inputs?.[0]?.defval || '',
    pineId: scriptId,
    pineVersion: version || meta.pine?.version || '1.0',
    pineFeatures: { v: '{"indicator":1,"plot":1,"ta":1}', f: true, t: 'text' },
    __profile: { v: false, f: true, t: 'bool' },
  };
  for (const i of meta.inputs || []) {
    if (i?.id?.startsWith('in_')) p[i.id] = { v: i.defval, f: true, t: i.type };
  }
  return p;
}

/**
 * Map plot index -> title. For "Liquidity Toolkit | T" the trigger lines are
 * idx 7=1m, 10=5m(T:5), 13=H(T:H), 16=D, 19=W, 22=M, and idx 50-59 are the
 * alertconditions INCLUDING the 5-Minute / 1-Hour / 1-Day crossovers, which is
 * the signal we actually want rather than re-deriving crossings ourselves.
 *
 * The plot index is NOT necessarily the value index: LT interleaves its levels
 * at odd indices 5..17. So every index is dumped and confirmed against a known
 * on-screen value.
 */
function plotNames(meta) {
  const names = {};
  const styles = meta.styles || {};
  (meta.plots || []).forEach((p, i) => {
    const st = styles[p.id];
    const t = (st && typeof st === 'object' ? st.title : null) || p.type || p.id || `plot${i}`;
    names[i] = String(t);
  });
  return names;
}

function frame(msg) { return `~m~${msg.length}~m~${msg}`; }
function send(ws, m, p) { ws.send(frame(JSON.stringify({ m, p }))); }
const sess = (pre) => pre + '_' + Math.random().toString(36).slice(2, 14);

async function dump() {
  // defaults to Liquidity Toolkit | T (invite-only; needs the entitled session)
  const scriptId = arg('script', 'PUB;8ec4a4d429674d018d2cae43c621341e');
  const symbol = arg('symbol', 'CME_MINI:NQU2026');
  const tf = arg('tf', '3');
  const bars = +arg('bars', 5000);
  const out = path.join(__dirname, arg('out', 'study.csv'));

  const version = arg('version', '1.0');
  const meta = await fetchMeta(scriptId, version);
  const names = plotNames(meta);
  console.log(`script: ${meta.description || meta.shortDescription || scriptId}`);
  console.log(`plots : ${Object.entries(names).map(([i, n]) => `${i}=${n}`).join(', ') || '(none listed)'}`);

  // Invite-only scripts only COMPUTE for an entitled session. TV_COOKIE lets this
  // run anywhere ("sessionid=...; sessionid_sign=..."); otherwise fall back to the
  // session cached in Redis (populated on the data-service host).
  let token = null, cookieHeader = process.env.TV_COOKIE || null;
  if (!cookieHeader) {
    try {
      token = await getBestAvailableToken(REDIS);
      const cookies = await getCachedSessionCookies(REDIS);
      if (cookies) cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    } catch (e) { /* fall through to the explicit error below */ }
  }
  if (!cookieHeader) {
    throw new Error('no TV session. Set TV_COOKIE="sessionid=...; sessionid_sign=..." ' +
      'or run where the data-service Redis session is reachable. ' +
      'Invite-only scripts will not compute without it.');
  }
  const url = `wss://prodata.tradingview.com/socket.io/websocket?from=chart%2F4NTS38Zt%2F&type=chart&auth=sessionid`;
  const headers = {
    Origin: TV_ORIGIN,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const ws = new WebSocket(url, { headers });
  const cs = sess('cs'), rows = new Map();
  let pings = 0;

  ws.on('open', () => {
    send(ws, 'set_auth_token', [token || 'unauthorized_user_token']);
    send(ws, 'set_locale', ['en', 'US']);
    send(ws, 'chart_create_session', [cs, '']);
    send(ws, 'resolve_symbol', [cs, 'sds_sym_1', `=${JSON.stringify({ adjustment: 'splits', symbol })}`]);
    send(ws, 'create_series', [cs, 'sds_1', 's1', 'sds_sym_1', tf, bars, '']);
    setInterval(() => { pings++; ws.send(frame(`~h~${pings}`)); }, 10_000).unref();
  });

  let studyMade = false;
  ws.on('message', async (buf) => {
    const raw = buf.toString();
    for (const m of raw.split(/~m~\d+~m~/).filter(Boolean)) {
      if (/^~h~\d+$/.test(m)) { ws.send(frame(m)); continue; }   // echo server heartbeat
      let d; try { d = JSON.parse(m); } catch { continue; }
      if (d.m === 'timescale_update' && !studyMade) {
        studyMade = true;
        send(ws, 'create_study', [cs, 'st1', 'st1', 'sds_1', 'Script@tv-scripting-101!',
          studyPayload(scriptId, meta, version)]);
        console.log('study requested; collecting…');
      }
      const upd = d.p?.[1];
      const st = upd?.st1?.st;
      if (Array.isArray(st)) {
        for (const b of st) if (b.v?.length) rows.set(b.v[0], b.v);
        process.stdout.write(`\r  ${rows.size} study bars`);
      }
      if (d.m === 'study_error') console.error('\nstudy_error:', JSON.stringify(d.p).slice(0, 300));
    }
  });

  setTimeout(() => {
    const keys = [...rows.keys()].sort((a, b) => a - b);
    if (!keys.length) { console.error('\nno study data — check the script id / entitlement'); process.exit(1); }
    const width = Math.max(...[...rows.values()].map(v => v.length));
    const hdr = ['ts', 'iso', ...Array.from({ length: width - 1 }, (_, i) =>
      names[i] ? `v${i + 1}_${String(names[i]).replace(/[^\w]+/g, '')}` : `v${i + 1}`)];
    const ws2 = fs.createWriteStream(out);
    ws2.write(hdr.join(',') + '\n');
    for (const k of keys) {
      const v = rows.get(k);
      const vals = v.slice(1).map(x => (x === 1e100 || x == null ? '' : x));
      ws2.write([k, new Date(k * 1000).toISOString(), ...vals].join(',') + '\n');
    }
    ws2.end();
    console.log(`\nwrote ${keys.length} bars -> ${out}`);
    console.log(`range ${new Date(keys[0] * 1000).toISOString()} .. ${new Date(keys.at(-1) * 1000).toISOString()}`);
    console.log('\nConfirm the columns by matching a value against the chart:');
    console.log('  T:H 24,254.74 and T:5 24,250.17 at 2026-08-23 ~02:45 in the screenshot.');
    process.exit(0);
  }, +arg('wait', 25) * 1000);
}

const q = arg('search');
(q ? searchScripts(q) : dump()).catch(e => { console.error(e.message); process.exit(1); });
