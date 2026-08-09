/**
 * PCC conditioner fetcher — live inputs for the preclose-continuation
 * breadth/stress sizing ladder (research I1/I2/I3, 2026-08-08).
 *
 * Fetches two series over the TradingView WebSocket (one-shot, same auth path
 * as tradingview-auth.js — cached JWT/cookies in Redis, maintained by
 * data-service /tv-auth):
 *   USI:TRIN   1h bars  -> today's last bar CLOSING <= 14:30 ET (label <=13:30)
 *   CBOE:COR1M 1D bars  -> prior-day close minus close 5 sessions earlier
 *
 * Called by the multi-strategy engine in a 14:40-14:59 ET window (the PCC
 * decision is at 15:00). Schwab (the live quote source) does not carry these
 * indices, and data-service is deliberately untouched — this is a self-
 * contained one-shot fetch, not a streaming subscription.
 *
 * Returns { date, trin, cor } (ET trade date; fields null when unavailable).
 * Any failure returns nulls — the strategy FAILS OPEN to base 1-lot sizing.
 */
import WebSocket from 'ws';
import {
  getBestAvailableToken, getCachedSessionCookies, refreshJwtFromSession,
  cacheTokenInRedis,
} from './tradingview-auth.js';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('pcc-conditioner');

const TV_HOST = 'prodata.tradingview.com';
const TV_ORIGIN = 'https://www.tradingview.com';
const FETCH_TIMEOUT_MS = 45_000;
const SETTLE_MS = 4_000;

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

/** ET calendar date + minutes-of-day for an epoch-seconds timestamp. */
function etParts(tsSec) {
  const s = new Date(tsSec * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [datePart, timePart] = s.split(', ');
  const [month, day, year] = datePart.split('/');
  let [hour, minute] = timePart.split(':').map(Number);
  if (hour === 24) hour = 0;
  return { date: `${year}-${month}-${day}`, minOfDay: hour * 60 + minute };
}

/** One-shot series fetch: resolve symbol, pull `bars` bars, settle, close. */
function fetchSeries(tvSymbol, resolution, bars, jwt, cookieHeader) {
  const chartSession = genId('cs');
  return new Promise((resolve) => {
    const headers = {
      'Origin': TV_ORIGIN,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    };
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const ws = new WebSocket(buildTvUrl(), { headers });
    const barsMap = new Map(); // ts -> close
    let settleTimer = null, hardTimeout = null, pingCounter = 0, done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      try { ws.close(); } catch { /* already closed */ }
      resolve(Array.from(barsMap.entries()).sort((a, b) => a[0] - b[0]));
    };
    hardTimeout = setTimeout(finish, FETCH_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(wrapFrame('set_auth_token', [jwt || 'unauthorized_user_token']));
      ws.send(wrapFrame('set_locale', ['en', 'US']));
      ws.send(wrapFrame('chart_create_session', [chartSession, '']));
      const resolveSym = JSON.stringify({ adjustment: 'splits', symbol: tvSymbol });
      ws.send(wrapFrame('resolve_symbol', [chartSession, 'sds_sym_1', `=${resolveSym}`]));
      ws.send(wrapFrame('create_series', [chartSession, 'sds_1', 's1', 'sds_sym_1', resolution, bars, '']));
    });

    ws.on('message', (data) => {
      const message = data.toString();
      if (message.match(/^~m~\d+~m~~h~\d+$/)) {
        pingCounter += 1;
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
            barsMap.set(bar.v[0], bar.v[4]); // ts -> close
          }
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(finish, SETTLE_MS);
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
 * Fetch today's conditioner values. `redisUrl` supplies the cached TV auth.
 * Never throws; missing pieces come back null (strategy fails open to base size).
 */
export async function fetchPccConditioner(redisUrl) {
  const today = etParts(Math.floor(Date.now() / 1000)).date;
  const result = { date: today, trin: null, cor: null };

  let jwt = null, cookieHeader = null;
  try {
    try {
      const fresh = await refreshJwtFromSession(redisUrl);
      if (fresh) await cacheTokenInRedis(redisUrl, fresh);
    } catch { /* fall through to cached/env token */ }
    const auth = await getBestAvailableToken(process.env.TRADINGVIEW_JWT_TOKEN, redisUrl);
    jwt = auth?.token || null;
    const cookies = await getCachedSessionCookies(redisUrl);
    cookieHeader = cookies && Object.keys(cookies).length
      ? Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') : null;
  } catch (err) {
    logger.warn(`TV auth unavailable: ${err.message}`);
  }
  if (!jwt) return result;

  // TRIN: today's last 1h bar labeled <=13:30 ET (closes <=14:30)
  try {
    const trinBars = await fetchSeries('USI:TRIN', '60', 30, jwt, cookieHeader);
    for (const [ts, close] of trinBars) {
      const p = etParts(ts);
      if (p.date === today && p.minOfDay <= 13 * 60 + 30) result.trin = close;
    }
  } catch (err) {
    logger.warn(`TRIN fetch failed: ${err.message}`);
  }

  // COR1M: prior-day close minus close 5 sessions earlier (completed bars only)
  try {
    const corBars = await fetchSeries('CBOE:COR1M', '1D', 12, jwt, cookieHeader);
    const prior = corBars.filter(([ts]) => etParts(ts).date < today).map(([, c]) => c);
    if (prior.length >= 6) {
      result.cor = prior[prior.length - 1] - prior[prior.length - 6];
    }
  } catch (err) {
    logger.warn(`COR1M fetch failed: ${err.message}`);
  }

  return result;
}

export default { fetchPccConditioner };
