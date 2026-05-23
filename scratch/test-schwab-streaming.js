// Schwab Streamer test — verifies whether the data we currently get from
// TradingView (NQ futures L1 + 1m OHLCV, QQQ spot quote) is available via
// Schwab's streaming API at usable freshness.
//
// Run: `node scratch/test-schwab-streaming.js`
//
// Reads Schwab tokens from Redis (already populated in dev). Connects to the
// streamer, LOGINs via admin request, subscribes to:
//   - LEVELONE_FUTURES /NQM26
//   - CHART_FUTURES   /NQM26   (1-min bars)
//   - LEVELONE_EQUITIES QQQ
// Logs every update for 60 seconds, then summarizes update counts + intervals.

import WebSocket from 'ws';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';

// Load shared/.env explicitly (dotenv defaults look at cwd's .env first)
import { config as loadEnv } from 'dotenv';
loadEnv({ path: new URL('../shared/.env', import.meta.url).pathname });

const REDIS_URL = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
const APP_KEY = process.env.SCHWAB_APP_KEY;
const APP_SECRET = process.env.SCHWAB_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
  console.error('Missing SCHWAB_APP_KEY / SCHWAB_APP_SECRET in env');
  process.exit(1);
}

const NQ_FUTURE = process.argv[2] || '/NQM26';     // override via CLI if rolled
const QQQ_SYMBOL = 'QQQ';
const TEST_DURATION_MS = parseInt(process.argv[3] || '60000', 10);

const stats = {
  l1Futures: { count: 0, firstTs: null, lastTs: null, samples: [] },
  chartFutures: { count: 0, firstTs: null, lastTs: null, samples: [] },
  l1Equity: { count: 0, firstTs: null, lastTs: null, samples: [] },
};

function recordUpdate(bucket, payload) {
  const now = Date.now();
  bucket.count++;
  if (!bucket.firstTs) bucket.firstTs = now;
  bucket.lastTs = now;
  if (bucket.samples.length < 3) bucket.samples.push(payload);
}

async function loadAccessToken() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  const raw = await redis.get('schwab:tokens');
  redis.disconnect();
  if (!raw) throw new Error('No schwab:tokens in Redis — re-authenticate first');
  const t = JSON.parse(raw);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, obtainedAt: t.obtained_at };
}

async function refreshIfStale(tokens) {
  const ageSec = (Date.now() - new Date(tokens.obtainedAt).getTime()) / 1000;
  // Schwab access tokens last 30 min. Refresh if > 25 min old to be safe.
  if (ageSec < 25 * 60) {
    console.log(`Access token age ${Math.floor(ageSec)}s — using as-is`);
    return tokens.accessToken;
  }
  console.log(`Access token age ${Math.floor(ageSec)}s — refreshing`);
  const auth = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');
  const res = await fetch('https://api.schwabapi.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${tokens.refreshToken}`,
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function getUserPreferences(accessToken) {
  const res = await fetch('https://api.schwabapi.com/trader/v1/userPreference', {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`userPreference failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log('=== Schwab Streamer Test ===');
  console.log(`Symbols: ${NQ_FUTURE} (futures L1 + 1m), ${QQQ_SYMBOL} (equity L1)`);
  console.log(`Duration: ${TEST_DURATION_MS / 1000}s\n`);

  const tokens = await loadAccessToken();
  const accessToken = await refreshIfStale(tokens);

  console.log('Fetching userPreference for streamer config...');
  const prefs = await getUserPreferences(accessToken);
  const streamer = prefs.streamerInfo?.[0];
  if (!streamer) throw new Error('No streamerInfo in userPreference response');
  console.log(`Streamer URL: ${streamer.streamerSocketUrl}`);
  console.log(`CustomerId: ${streamer.schwabClientCustomerId?.slice(0, 8)}...`);
  console.log(`ChannelKey: ${streamer.schwabClientChannel}`);
  console.log(`FunctionId: ${streamer.schwabClientFunctionId}\n`);

  const ws = new WebSocket(streamer.streamerSocketUrl);
  let loggedIn = false;
  let requestId = 0;

  const send = (req) => {
    req.requestid = String(requestId++);
    req.SchwabClientCustomerId = streamer.schwabClientCustomerId;
    req.SchwabClientCorrelId = randomUUID();
    const payload = JSON.stringify({ requests: [req] });
    ws.send(payload);
    console.log(`📤 ${req.service} ${req.command} req=${req.requestid}`);
  };

  ws.on('open', () => {
    console.log('🌐 WS opened — sending LOGIN');
    send({
      service: 'ADMIN',
      command: 'LOGIN',
      parameters: {
        Authorization: accessToken,
        SchwabClientChannel: streamer.schwabClientChannel,
        SchwabClientFunctionId: streamer.schwabClientFunctionId,
      },
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (e) { console.warn('Non-JSON:', raw.toString().slice(0, 200)); return; }

    // Response (to LOGIN / SUBS)
    if (msg.response) {
      for (const r of msg.response) {
        const ok = r.content?.code === 0;
        console.log(`📥 ${r.service} ${r.command} req=${r.requestid} → ${ok ? 'OK' : 'ERR'} ${r.content?.msg ?? ''}`);
        if (r.service === 'ADMIN' && r.command === 'LOGIN' && ok) {
          loggedIn = true;
          // Subscribe to everything we want
          send({
            service: 'LEVELONE_FUTURES',
            command: 'SUBS',
            parameters: { keys: NQ_FUTURE, fields: '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35' },
          });
          send({
            service: 'CHART_FUTURES',
            command: 'SUBS',
            parameters: { keys: NQ_FUTURE, fields: '0,1,2,3,4,5,6' }, // seq, key, open, high, low, close, volume + timestamp varies
          });
          send({
            service: 'LEVELONE_EQUITIES',
            command: 'SUBS',
            parameters: { keys: QQQ_SYMBOL, fields: '0,1,2,3,4,5,6,7,8' },
          });
        }
      }
    }

    // Data updates
    if (msg.data) {
      for (const d of msg.data) {
        if (d.service === 'LEVELONE_FUTURES') {
          recordUpdate(stats.l1Futures, d.content?.[0] || d.content);
        } else if (d.service === 'CHART_FUTURES') {
          recordUpdate(stats.chartFutures, d.content?.[0] || d.content);
        } else if (d.service === 'LEVELONE_EQUITIES') {
          recordUpdate(stats.l1Equity, d.content?.[0] || d.content);
        }
      }
    }

    // Notify (heartbeat/snapshot)
    if (msg.notify) {
      // Quiet — just confirms session is alive
    }
  });

  ws.on('error', (e) => console.error('WS error:', e.message));
  ws.on('close', (code, reason) => console.log(`🔌 WS closed code=${code} reason=${reason?.toString() || 'none'}`));

  // Print summary after test duration
  setTimeout(() => {
    console.log('\n=== Summary ===');
    for (const [name, bucket] of Object.entries(stats)) {
      const durationSec = bucket.firstTs && bucket.lastTs ? (bucket.lastTs - bucket.firstTs) / 1000 : 0;
      const rate = durationSec > 0 ? (bucket.count / durationSec).toFixed(2) : '0';
      console.log(`\n[${name}]  count=${bucket.count}  rate=${rate}/sec  duration=${durationSec.toFixed(1)}s`);
      if (bucket.samples.length) {
        console.log('  sample payload:', JSON.stringify(bucket.samples[0]).slice(0, 240));
      }
    }
    ws.close();
    process.exit(0);
  }, TEST_DURATION_MS);
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});
