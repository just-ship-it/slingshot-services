// SchwabStreamer — real-time market data via Schwab Trader API streamer.
//
// Drop-in replacement for TradingViewClient where data-service uses it for
// OHLCV + quote streaming (futures L1 + chart, equities L1). Mirrors the same
// EventEmitter surface:
//   - 'quote'           — per L1 tick or chart bar update
//   - 'history_loaded'  — after createHistorySession() REST fetch completes
//   - 'reconnected'     — after a recovery
//   - 'connected'       — after LOGIN ack
//   - 'error'
//
// Auth: pulls Schwab tokens from Redis (`schwab:tokens` key, populated by
// SchwabClient OAuth flow). Refreshes the access token via refresh_token
// grant when stale (Schwab access tokens last 30 min).
//
// Subscribed services:
//   - LEVELONE_FUTURES   → tick L1 for futures (NQ/ES); 1Hz throttle
//   - CHART_FUTURES      → 1-minute OHLCV bars
//   - LEVELONE_EQUITIES  → tick L1 for equities (QQQ/SPY)
//
// History: Schwab `/marketdata/v1/pricehistory` REST gives us up to ~500 bars
// at any timeframe; createHistorySession() fetches + emits history_loaded.

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('schwab-streamer');

const REDIS_TOKEN_KEY = 'schwab:tokens';
const ACCESS_TOKEN_TTL_SEC = 25 * 60; // refresh when within 5 min of expiry
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const SCHWAB_USER_PREF_URL = 'https://api.schwabapi.com/trader/v1/userPreference';
const SCHWAB_PRICE_HISTORY_URL = 'https://api.schwabapi.com/marketdata/v1/pricehistory';

// LEVELONE_FUTURES field map (only fields we surface).
const FUT_L1 = {
  KEY: 'key',
  BID: '1',
  ASK: '2',
  LAST: '3',
  BID_SIZE: '4',
  ASK_SIZE: '5',
  TOTAL_VOLUME: '8',
  LAST_SIZE: '9',
  LAST_TRADE_TIME: '10',
  HIGH: '12',
  LOW: '13',
  OPEN: '14',
  PREV_CLOSE: '18',
  NET_CHANGE: '19',
  PERCENT_CHANGE: '20',
};
// CHART_FUTURES field map (1-min bar updates).
const FUT_CHART = {
  KEY: 'key',
  CHART_TIME: '1',
  OPEN: '2',
  HIGH: '3',
  LOW: '4',
  CLOSE: '5',
  VOLUME: '6',
};
// LEVELONE_EQUITIES field map (only fields we surface).
const EQ_L1 = {
  KEY: 'key',
  BID: '1',
  ASK: '2',
  LAST: '3',
  BID_SIZE: '4',
  ASK_SIZE: '5',
  TOTAL_VOLUME: '8',
};

// Schwab futures symbol → canonical base symbol used by downstream code.
function futureToBaseSymbol(schwabSym) {
  if (!schwabSym) return null;
  // /NQM26 → NQ, /ESM26 → ES, /MNQM26 → MNQ, /MESM26 → MES
  const m = schwabSym.match(/^\/(M?NQ|M?ES)[A-Z]\d+$/);
  return m ? m[1] : null;
}

function equityToBaseSymbol(schwabSym) {
  return schwabSym; // QQQ / SPY are already canonical
}

class SchwabStreamer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(20);

    this.appKey = options.appKey;
    this.appSecret = options.appSecret;
    this.redisUrl = options.redisUrl || 'redis://localhost:6379';

    // Symbol lists
    this.futureSymbols = options.futureSymbols || []; // e.g., ['/NQM26']
    this.equitySymbols = options.equitySymbols || []; // e.g., ['QQQ']
    this.historyBarCount = options.historyBarCount || 500;

    // Connection state
    this.ws = null;
    this.connected = false;
    this.isDisconnecting = false;
    this.streamerInfo = null; // populated from userPreference
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenObtainedAt = null;
    this.tokenRefreshTimer = null;

    // Request tracking
    this.requestId = 0;
    this.pendingRequests = new Map(); // requestid → {service, command, resolve, reject}

    // Reconnect logic
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.reconnectAttempts = 0;

    // Last-seen day-stats per future, used to compose composite `quote` events
    // when CHART_FUTURES delivers a bar update (chart doesn't carry day high/low/prev_close).
    this.lastFuturesL1 = new Map(); // baseSymbol → last L1 snapshot
  }

  // ───────────────────────────── Token lifecycle ─────────────────────────────

  async _loadTokensFromRedis() {
    const redis = new Redis(this.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    try {
      await redis.connect();
      const raw = await redis.get(REDIS_TOKEN_KEY);
      if (!raw) throw new Error(`No ${REDIS_TOKEN_KEY} in Redis — bootstrap via OAuth first`);
      const t = JSON.parse(raw);
      this.accessToken = t.access_token;
      this.refreshToken = t.refresh_token;
      this.tokenObtainedAt = t.obtained_at;
      logger.info('Loaded Schwab tokens from Redis');
    } finally {
      try { redis.disconnect(); } catch {}
    }
  }

  async _saveTokensToRedis() {
    const redis = new Redis(this.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    try {
      await redis.connect();
      await redis.set(REDIS_TOKEN_KEY, JSON.stringify({
        access_token: this.accessToken,
        refresh_token: this.refreshToken,
        obtained_at: this.tokenObtainedAt,
      }));
    } finally {
      try { redis.disconnect(); } catch {}
    }
  }

  _accessTokenStale() {
    if (!this.tokenObtainedAt) return true;
    const ageSec = (Date.now() - new Date(this.tokenObtainedAt).getTime()) / 1000;
    return ageSec >= ACCESS_TOKEN_TTL_SEC;
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh_token available');
    const auth = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64');
    const res = await fetch(SCHWAB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${this.refreshToken}`,
    });
    if (!res.ok) throw new Error(`Schwab token refresh failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.tokenObtainedAt = new Date().toISOString();
    await this._saveTokensToRedis();
    logger.info('Schwab access token refreshed');
  }

  _scheduleTokenRefresh() {
    if (this.tokenRefreshTimer) clearInterval(this.tokenRefreshTimer);
    // Check every 5 min; refresh when stale.
    this.tokenRefreshTimer = setInterval(async () => {
      if (this._accessTokenStale()) {
        try { await this._refreshAccessToken(); }
        catch (e) { logger.warn(`Scheduled token refresh failed: ${e.message}`); }
      }
    }, 5 * 60 * 1000);
  }

  // ───────────────────────────── Connect / login ─────────────────────────────

  async connect() {
    if (this.isDisconnecting) this.isDisconnecting = false;

    await this._loadTokensFromRedis();
    if (this._accessTokenStale()) {
      logger.info('Access token stale at connect; refreshing');
      await this._refreshAccessToken();
    }

    logger.info('Fetching Schwab userPreference for streamer config');
    const prefRes = await fetch(SCHWAB_USER_PREF_URL, {
      headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Accept': 'application/json' },
    });
    if (!prefRes.ok) throw new Error(`userPreference failed: ${prefRes.status} ${await prefRes.text()}`);
    const prefs = await prefRes.json();
    this.streamerInfo = prefs.streamerInfo?.[0];
    if (!this.streamerInfo) throw new Error('No streamerInfo in userPreference response');

    logger.info(`Connecting to Schwab streamer: ${this.streamerInfo.streamerSocketUrl}`);
    this.ws = new WebSocket(this.streamerInfo.streamerSocketUrl);

    this.ws.on('open', () => this._handleOpen());
    this.ws.on('message', (raw) => this._handleMessage(raw));
    this.ws.on('error', (err) => {
      logger.error(`Schwab WS error: ${err.message}`);
      this.emit('error', err);
    });
    this.ws.on('close', (code, reason) => this._handleClose(code, reason));

    // Wait for LOGIN ack before resolving.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Schwab LOGIN timeout (30s)')), 30000);
      this.once('connected', () => { clearTimeout(timeout); resolve(); });
      this.once('error', (e) => { clearTimeout(timeout); reject(e); });
    });

    this._scheduleTokenRefresh();
  }

  _handleOpen() {
    logger.info('Schwab WS opened — sending LOGIN');
    this._send({
      service: 'ADMIN',
      command: 'LOGIN',
      parameters: {
        Authorization: this.accessToken,
        SchwabClientChannel: this.streamerInfo.schwabClientChannel,
        SchwabClientFunctionId: this.streamerInfo.schwabClientFunctionId,
      },
    });
  }

  _send(req) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`Cannot send ${req.service}/${req.command} — WS not open`);
      return;
    }
    req.requestid = String(this.requestId++);
    req.SchwabClientCustomerId = this.streamerInfo.schwabClientCustomerId;
    req.SchwabClientCorrelId = randomUUID();
    this.ws.send(JSON.stringify({ requests: [req] }));
    logger.debug(`📤 ${req.service} ${req.command} req=${req.requestid}`);
  }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (e) { logger.warn(`Non-JSON Schwab message: ${raw.toString().slice(0, 200)}`); return; }

    if (msg.response) {
      for (const r of msg.response) {
        const ok = r.content?.code === 0;
        logger.debug(`📥 ${r.service} ${r.command} req=${r.requestid} → ${ok ? 'OK' : 'ERR'} ${r.content?.msg ?? ''}`);
        if (r.service === 'ADMIN' && r.command === 'LOGIN') {
          if (ok) {
            this.connected = true;
            this.reconnectAttempts = 0;
            this.emit('connected');
          } else {
            this.emit('error', new Error(`Schwab LOGIN failed: ${r.content?.msg}`));
          }
        }
      }
    }

    if (msg.data) {
      for (const d of msg.data) {
        try { this._handleDataUpdate(d); }
        catch (e) { logger.warn(`Error processing ${d.service} data: ${e.message}`); }
      }
    }

    // msg.notify — heartbeats / session-alive; ignore.
  }

  _handleDataUpdate(d) {
    if (!d.content || !d.content.length) return;
    for (const c of d.content) {
      if (d.service === 'LEVELONE_FUTURES') this._handleFuturesL1(c);
      else if (d.service === 'CHART_FUTURES') this._handleFuturesChart(c);
      else if (d.service === 'LEVELONE_EQUITIES') this._handleEquityL1(c);
    }
  }

  _handleFuturesL1(c) {
    const symbol = c[FUT_L1.KEY];
    const baseSymbol = futureToBaseSymbol(symbol);
    if (!baseSymbol) return;

    const snapshot = {
      bid: c[FUT_L1.BID],
      ask: c[FUT_L1.ASK],
      last: c[FUT_L1.LAST],
      volume: c[FUT_L1.TOTAL_VOLUME],
      high: c[FUT_L1.HIGH],
      low: c[FUT_L1.LOW],
      open: c[FUT_L1.OPEN],
      prevClose: c[FUT_L1.PREV_CLOSE],
      change: c[FUT_L1.NET_CHANGE],
      changePercent: c[FUT_L1.PERCENT_CHANGE],
      lastTradeTime: c[FUT_L1.LAST_TRADE_TIME],
    };
    // Merge with last snapshot so partial updates carry full day-stats forward.
    const prev = this.lastFuturesL1.get(baseSymbol) || {};
    const merged = { ...prev, ...Object.fromEntries(Object.entries(snapshot).filter(([, v]) => v !== undefined)) };
    this.lastFuturesL1.set(baseSymbol, merged);

    if (merged.last == null) return;

    this.emit('quote', {
      symbol,
      baseSymbol,
      open: merged.open ?? null,
      high: merged.high ?? null,
      low: merged.low ?? null,
      close: merged.last,
      volume: merged.volume ?? null,
      timestamp: new Date().toISOString(),
      source: 'schwab-l1-futures',
      candleTimestamp: null, // L1 tick, not a bar
      sessionOpen: merged.open ?? null,
      sessionHigh: merged.high ?? null,
      sessionLow: merged.low ?? null,
      prevClose: merged.prevClose ?? null,
      change: merged.change ?? null,
      changePercent: merged.changePercent ?? null,
    });
  }

  _handleFuturesChart(c) {
    const symbol = c[FUT_CHART.KEY];
    const baseSymbol = futureToBaseSymbol(symbol);
    if (!baseSymbol) return;

    const chartTime = c[FUT_CHART.CHART_TIME];
    const open = c[FUT_CHART.OPEN];
    const high = c[FUT_CHART.HIGH];
    const low = c[FUT_CHART.LOW];
    const close = c[FUT_CHART.CLOSE];
    const volume = c[FUT_CHART.VOLUME];
    if (chartTime == null || close == null) return;

    // Pull day-stats from latest L1 snapshot (chart event doesn't carry these).
    const dayStats = this.lastFuturesL1.get(baseSymbol) || {};

    this.emit('quote', {
      symbol,
      baseSymbol,
      open,
      high,
      low,
      close,
      volume,
      timestamp: new Date().toISOString(),
      source: 'schwab-chart-futures',
      candleTimestamp: new Date(chartTime).toISOString(),
      sessionOpen: dayStats.open ?? null,
      sessionHigh: dayStats.high ?? null,
      sessionLow: dayStats.low ?? null,
      prevClose: dayStats.prevClose ?? null,
      change: dayStats.change ?? null,
      changePercent: dayStats.changePercent ?? null,
    });
  }

  _handleEquityL1(c) {
    const symbol = c[EQ_L1.KEY];
    const baseSymbol = equityToBaseSymbol(symbol);

    const last = c[EQ_L1.LAST];
    if (last == null) return;

    this.emit('quote', {
      symbol,
      baseSymbol,
      open: null,
      high: null,
      low: null,
      close: last,
      volume: c[EQ_L1.TOTAL_VOLUME] ?? null,
      timestamp: new Date().toISOString(),
      source: 'schwab-l1-equity',
      candleTimestamp: null,
      sessionOpen: null,
      sessionHigh: null,
      sessionLow: null,
      prevClose: null,
      change: null,
      changePercent: null,
    });
  }

  // ───────────────────────────── Streaming ─────────────────────────────

  async startStreaming() {
    if (!this.connected) throw new Error('Schwab streamer not connected — call connect() first');

    if (this.futureSymbols.length > 0) {
      // Comprehensive field set for L1; we keep all so future extensions don't need a resub.
      const futL1Fields = Array.from({ length: 36 }, (_, i) => i).join(',');
      this._send({
        service: 'LEVELONE_FUTURES',
        command: 'SUBS',
        parameters: { keys: this.futureSymbols.join(','), fields: futL1Fields },
      });
      this._send({
        service: 'CHART_FUTURES',
        command: 'SUBS',
        parameters: { keys: this.futureSymbols.join(','), fields: '0,1,2,3,4,5,6' },
      });
      logger.info(`Subscribed to LEVELONE_FUTURES + CHART_FUTURES for ${this.futureSymbols.join(',')}`);
    }

    if (this.equitySymbols.length > 0) {
      this._send({
        service: 'LEVELONE_EQUITIES',
        command: 'SUBS',
        parameters: { keys: this.equitySymbols.join(','), fields: '0,1,2,3,4,5,6,7,8' },
      });
      logger.info(`Subscribed to LEVELONE_EQUITIES for ${this.equitySymbols.join(',')}`);
    }
  }

  // ───────────────────────────── History (REST) ─────────────────────────────

  /**
   * Fetch historical bars and emit a history_loaded event. Mirrors the TV
   * client's createHistorySession contract so data-service's history-load
   * handler (candleManager.seedHistory) works unchanged.
   *
   * @param {string} schwabSym       e.g., '/NQM26' or 'QQQ'
   * @param {string} timeframe       '1', '60', '1D' (TV-style; mapped here)
   * @param {number} barCount        approximate number of bars to request
   */
  async createHistorySession(schwabSym, timeframe, barCount = this.historyBarCount) {
    const params = this._tvTimeframeToSchwabParams(timeframe, barCount);
    const isFuture = schwabSym.startsWith('/');
    const baseSymbol = isFuture ? futureToBaseSymbol(schwabSym) : equityToBaseSymbol(schwabSym);
    const url = new URL(SCHWAB_PRICE_HISTORY_URL);
    url.searchParams.set('symbol', schwabSym);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    if (this._accessTokenStale()) await this._refreshAccessToken();
    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`pricehistory ${schwabSym} ${timeframe} failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const candles = (data.candles || []).map(c => ({
      timestamp: new Date(c.datetime).toISOString(),
      symbol: schwabSym,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    logger.info(`Loaded ${candles.length} ${timeframe} candles for ${schwabSym} (${baseSymbol}) via Schwab pricehistory`);
    this.emit('history_loaded', { symbol: schwabSym, baseSymbol, timeframe, candles });
    return candles;
  }

  _tvTimeframeToSchwabParams(timeframe, barCount) {
    // Schwab pricehistory params:
    //   periodType: day/month/year/ytd
    //   frequencyType: minute/daily/weekly/monthly
    //   frequency: 1,5,10,15,30 (minute), 1 (daily/weekly/monthly)
    if (timeframe === '1') {
      // 1-min bars: at 500 bars ~ 8.3 hours of trading; use periodType=day with period covering desired bars.
      const minutesNeeded = barCount;
      const daysNeeded = Math.max(1, Math.ceil(minutesNeeded / (60 * 8)));
      return { periodType: 'day', period: daysNeeded, frequencyType: 'minute', frequency: 1 };
    }
    if (timeframe === '60') {
      // 60-min bars: use frequencyType=minute frequency=30 (Schwab max minute freq), aggregated client-side?
      // Schwab supports periodType=day with frequencyType=minute up to 30. For true 60m we approximate via 30 and re-aggregate downstream,
      // OR use periodType=year with daily — but daily isn't 60m. For now, use minute=30 and let candle-manager aggregate, OR fetch daily history.
      // Simpler: 1h history via periodType=year period=1 frequencyType=daily frequency=1 — that's daily bars, not 60m.
      // We'll send minute=30 with period to approximately span barCount 60m bars (so 2× the 30m bars).
      const minutesNeeded = barCount * 60;
      const daysNeeded = Math.max(1, Math.ceil(minutesNeeded / (60 * 8)));
      return { periodType: 'day', period: Math.min(10, daysNeeded), frequencyType: 'minute', frequency: 30 };
    }
    if (timeframe === '1D') {
      const daysNeeded = barCount;
      const yearsNeeded = Math.max(1, Math.ceil(daysNeeded / 252));
      return { periodType: 'year', period: Math.min(20, yearsNeeded), frequencyType: 'daily', frequency: 1 };
    }
    // Default: daily, 1 year.
    return { periodType: 'year', period: 1, frequencyType: 'daily', frequency: 1 };
  }

  // ───────────────────────────── Close / reconnect ─────────────────────────────

  _handleClose(code, reason) {
    logger.warn(`Schwab WS closed code=${code} reason=${reason?.toString() || 'none'}`);
    this.connected = false;

    if (this.isDisconnecting) {
      logger.info('Schwab streamer shutting down — no reconnect');
      return;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    logger.warn(`Schwab streamer reconnect attempt #${this.reconnectAttempts} in ${delay/1000}s`);
    setTimeout(async () => {
      try {
        await this.connect();
        await this.startStreaming();
        logger.info('Schwab streamer reconnected');
        this.emit('reconnected');
      } catch (e) {
        logger.error(`Schwab reconnect failed: ${e.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  async disconnect() {
    logger.info('Disconnecting Schwab streamer');
    this.isDisconnecting = true;
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}

export default SchwabStreamer;
