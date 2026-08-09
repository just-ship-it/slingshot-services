/**
 * TV one-shot series fetcher — paginated OHLC pull over the TradingView
 * WebSocket using the system's cached auth (Redis JWT/cookies via
 * tradingview-auth.js). Port of the proven backtest-engine/scripts/
 * fetch-macro-daily.js fetch loop (request_more_data pagination + oldest-bar
 * stability polling), returning full OHLC bars.
 *
 * Used by: intraday-momentum (ES) sigma-profile seeding — ~20 days of ES1!
 * 1m bars at startup so the strategy is live immediately instead of warming
 * up for 14 sessions. Failure-tolerant: returns [] on any error (caller
 * falls back to live-feed warmup).
 */
import WebSocket from 'ws';
import {
  getBestAvailableToken, getCachedSessionCookies, refreshJwtFromSession,
  cacheTokenInRedis,
} from './tradingview-auth.js';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('tv-series-fetcher');

const TV_HOST = 'prodata.tradingview.com';
const TV_ORIGIN = 'https://www.tradingview.com';
const HARD_TIMEOUT_MS = 90_000;
const OLDEST_STABLE_MS = 6_000;
const STABLE_POLL_MS = 1_000;

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
  const params = new URLSearchParams({ from: 'chart/', date: now, type: 'chart', auth: 'sessionid' });
  return `wss://${TV_HOST}/socket.io/websocket?${params.toString()}`;
}

async function resolveAuth(redisUrl) {
  try {
    try {
      const fresh = await refreshJwtFromSession(redisUrl);
      if (fresh) await cacheTokenInRedis(redisUrl, fresh);
    } catch { /* fall through to cached/env token */ }
    const auth = await getBestAvailableToken(process.env.TRADINGVIEW_JWT_TOKEN, redisUrl);
    const cookies = await getCachedSessionCookies(redisUrl);
    return {
      jwt: auth?.token || null,
      cookieHeader: cookies && Object.keys(cookies).length
        ? Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') : null,
    };
  } catch (err) {
    logger.warn(`TV auth unavailable: ${err.message}`);
    return { jwt: null, cookieHeader: null };
  }
}

/**
 * Fetch up to `bars` x (1+pages) bars of `resolution` for `tvSymbol`.
 * -> sorted array of { ts (epoch sec), o, h, l, c } (possibly empty).
 */
export async function fetchTvSeries(tvSymbol, resolution, bars, pages, redisUrl) {
  const { jwt, cookieHeader } = await resolveAuth(redisUrl);
  if (!jwt) return [];

  const chartSession = genId('cs');
  return new Promise((resolve) => {
    const headers = {
      'Origin': TV_ORIGIN,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    };
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    const ws = new WebSocket(buildTvUrl(), { headers });

    const barsMap = new Map(); // ts -> [o,h,l,c]
    let oldestTs = null, oldestChangedAt = Date.now();
    let cyclesDone = 0, lastSettleCount = 0;
    let pollTimer = null, hardTimer = null, done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (pollTimer) clearInterval(pollTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try { ws.close(); } catch { /* closing */ }
      resolve(Array.from(barsMap.entries()).sort((a, b) => a[0] - b[0])
        .map(([ts, v]) => ({ ts, o: v[0], h: v[1], l: v[2], c: v[3] })));
    };
    hardTimer = setTimeout(finish, HARD_TIMEOUT_MS);

    pollTimer = setInterval(() => {
      if (barsMap.size === 0) return;
      if (Date.now() - oldestChangedAt < OLDEST_STABLE_MS) return;
      const gained = barsMap.size - lastSettleCount;
      if (cyclesDone < pages && gained > 0) {
        cyclesDone += 1;
        lastSettleCount = barsMap.size;
        try {
          ws.send(wrapFrame('request_more_data', [chartSession, 'sds_1', bars]));
          oldestChangedAt = Date.now();
        } catch { finish(); }
      } else {
        finish();
      }
    }, STABLE_POLL_MS);

    ws.on('open', () => {
      ws.send(wrapFrame('set_auth_token', [jwt]));
      ws.send(wrapFrame('set_locale', ['en', 'US']));
      ws.send(wrapFrame('chart_create_session', [chartSession, '']));
      const resolveSym = JSON.stringify({ adjustment: 'splits', symbol: tvSymbol });
      ws.send(wrapFrame('resolve_symbol', [chartSession, 'sds_sym_1', `=${resolveSym}`]));
      ws.send(wrapFrame('create_series', [chartSession, 'sds_1', 's1', 'sds_sym_1', resolution, bars, '']));
      oldestChangedAt = Date.now();
    });

    ws.on('message', (data) => {
      const message = data.toString();
      if (message.match(/^~m~\d+~m~~h~\d+$/)) {
        try { ws.send(message); } catch { /* closing */ }
        return;
      }
      for (const part of message.split(/~m~\d+~m~/)) {
        if (!part || !part.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(part); } catch { continue; }
        if (parsed.m === 'timescale_update') {
          const ohlc = parsed.p?.[1]?.sds_1?.s || [];
          for (const bar of ohlc) {
            if (!bar.v || bar.v.length < 5) continue;
            const ts = bar.v[0];
            barsMap.set(ts, [bar.v[1], bar.v[2], bar.v[3], bar.v[4]]);
            if (oldestTs === null || ts < oldestTs) { oldestTs = ts; oldestChangedAt = Date.now(); }
          }
        } else if (['series_error', 'critical_error', 'protocol_error'].includes(parsed.m)) {
          logger.warn(`TV ${parsed.m} for ${tvSymbol}`);
          finish();
        }
      }
    });
    ws.on('error', (err) => { logger.warn(`TV ws error (${tvSymbol}): ${err.message}`); finish(); });
    ws.on('close', finish);
  });
}

/**
 * Seed loader for the intraday-momentum (Zarattini) strategy: ~4 weeks of
 * ES1! 1m bars -> completed RTH day profiles {open, mClose[390]} (fill-
 * forwarded, full days only: >=300 RTH bars), oldest first, today excluded.
 * Returns [] on failure (strategy falls back to live warmup).
 */
export async function fetchZimSeedDays(redisUrl, { symbol = 'CME_MINI:ES1!', lookback = 14 } = {}) {
  const bars = await fetchTvSeries(symbol, '1', 20000, 3, redisUrl);
  if (!bars.length) return [];

  const RTH_MIN = 390;
  const byDay = new Map(); // ET date -> {open, mClose, count}
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  for (const b of bars) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(b.ts * 1000))
      .map(p => [p.type, p.value]));
    let hour = parseInt(parts.hour, 10);
    if (hour === 24) hour = 0;
    const minute = parseInt(parts.minute, 10);
    const m = (hour * 60 + minute) - (9 * 60 + 30);
    if (m < 0 || m >= RTH_MIN) continue; // RTH only
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (date >= todayEt) continue;       // completed days only
    let d = byDay.get(date);
    if (!d) { d = { open: null, mClose: new Array(RTH_MIN).fill(NaN), count: 0 }; byDay.set(date, d); }
    if (m === 0 && d.open === null) d.open = b.o;
    d.mClose[m] = b.c;
    d.count++;
  }

  const days = [];
  for (const date of Array.from(byDay.keys()).sort()) {
    const d = byDay.get(date);
    if (d.open === null || d.count < 300) continue; // full RTH days only
    let last = d.open;
    for (let m = 0; m < RTH_MIN; m++) {
      if (isNaN(d.mClose[m])) d.mClose[m] = last;
      else last = d.mClose[m];
    }
    days.push({ date, open: d.open, mClose: Float64Array.from(d.mClose) });
  }
  const out = days.slice(-lookback);
  logger.info(`ZIM seed: ${bars.length} ES 1m bars -> ${days.length} full RTH days, using last ${out.length}`);
  return out;
}

export default { fetchTvSeries, fetchZimSeedDays };
