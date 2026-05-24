// Liquidity Trigger Monitor - Dedicated WebSocket for LT levels
import WebSocket from 'ws';
import EventEmitter from 'events';
import { createLogger, messageBus } from '../../../shared/index.js';
import { getCachedToken, getTokenTTL, getCachedSessionCookies } from '../utils/tradingview-auth.js';

const logger = createLogger('lt-monitor');

// TradingView WebSocket endpoint
// [2026-05-22] prodata host + browser-fingerprint matching. See
// tradingview-client.js for the HAR-derived rationale (auth=sessionid +
// date=<ISO> query params, Accept-Language, Accept-Encoding headers).
const TV_WEBSOCKET_BASE = 'wss://prodata.tradingview.com/socket.io/websocket';
function buildTvWebsocketUrl() {
  const now = new Date().toISOString().slice(0, 19);
  const params = new URLSearchParams({
    from: 'chart/4NTS38Zt/',
    date: now,
    type: 'chart',
    auth: 'sessionid',
  });
  return `${TV_WEBSOCKET_BASE}?${params.toString()}`;
}
const TV_ORIGIN = 'https://www.tradingview.com';

// Liquidity Triggers indicator by DDScript
const LIQUIDITY_TRIGGER_INDICATOR = 'PUB;93e43ec4c20f420fac2b70f0f2b286cf';
const LIQUIDITY_TRIGGER_VERSION = '1';

// Liquidity Status indicator by DDScript
// Set to empty string to disable LS subscription
const LIQUIDITY_STATUS_INDICATOR = 'PUB;eb74f266acd04379bd7828ba0fd54c84';
const LIQUIDITY_STATUS_VERSION = '1';

class LTMonitor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.symbol = options.symbol || 'CME_MINI:NQ1!';
    this.timeframe = options.timeframe || '15'; // 15-minute timeframe
    this.jwtToken = options.jwtToken;
    this.redisUrl = options.redisUrl || 'redis://localhost:6379';

    this.ws = null;
    this.connected = false;
    this.quoteSession = null;
    this.chartSession = null;

    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.reconnectAttempts = 0;

    // Client-originated keepalive (mirrors tradingview-client.js fix from
    // 2026-05-22). Without 10s client-pings, TV cuts the WS at ~65-75s as
    // "polling only" — same fingerprint as the May-21 hibernate incident.
    this.pingInterval = null;
    this.pingCounter = 0;

    this.currentLevels = null;
    this.lastTimestamp = null;
    this.lastHeartbeat = null;
    this.lsStudyAdded = false;
    this.lastLsValues = null;
    this.currentLsSentiment = null;

    // LS bar-close gating: the LS indicator's value on the currently-forming
    // bar can flip intrabar. We only want to fire on a CONFIRMED close. So
    // we track the timestamp of the bar that's currently forming and the
    // last-observed (provisional) sentiment for it. When a NEW bar's
    // timestamp arrives, the previous bar is finalized — that's when we
    // compare against the last CONFIRMED emission and emit on flip.
    this.lsFormingBarTs = null;        // ts of the bar currently forming
    this.lsFormingBarSentiment = null; // latest provisional sentiment seen
    this.lsFormingBarRaw = null;
    this.lsConfirmedSentiment = null;  // last emitted (confirmed) sentiment
    this.lsConfirmedBarTs = null;      // ts of the bar that produced last confirmed sentiment
    // Was the currently-forming bar observed from its OPEN tick? If we seeded
    // mid-bar after a reconnect, we don't know its true close value — the
    // lsFormingBarSentiment is just the latest intrabar tick we caught, not
    // a real close. So the "new bar arrived" handler treats this bar's close
    // as untrustworthy and skips emission.
    this.lsBarFullyObserved = false;
    // ~1m bar = 60s; allow some clock drift before classifying as a gap.
    this.LS_GAP_THRESHOLD_SEC = 90;
  }

  generateSession(prefix = 'qs') {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    let randomString = '';
    for (let i = 0; i < 12; i++) {
      randomString += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${prefix}_${randomString}`;
  }

  createMessage(func, params) {
    const message = JSON.stringify({ m: func, p: params });
    return `~m~${message.length}~m~${message}`;
  }

  sendMessage(func, params) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = this.createMessage(func, params);
      this.ws.send(message);
      logger.debug(`📤 Sent: ${func}`);
    } else {
      logger.warn(`Cannot send ${func} - WebSocket not open`);
    }
  }

  async connect() {
    try {
      logger.info(`🔌 Connecting LT monitor to TradingView for ${this.symbol} on ${this.timeframe}m...`);

      const wsUrl = buildTvWebsocketUrl();

      // Inject cached session cookies on the WS handshake — see
      // tradingview-client.js connect() for the full rationale.
      let cookieHeader;
      try {
        const cookies = await getCachedSessionCookies(this.redisUrl);
        if (cookies && Object.keys(cookies).length > 0) {
          cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
          logger.info(`🍪 LT monitor attaching ${Object.keys(cookies).length} cookie(s): ${Object.keys(cookies).join(', ')}`);
        }
      } catch (err) {
        logger.warn(`🍪 LT monitor cookie fetch failed (continuing without): ${err.message}`);
      }

      const headers = {
        'Connection': 'upgrade',
        'Host': 'prodata.tradingview.com',
        'Origin': TV_ORIGIN,
        'Cache-Control': 'no-cache',
        'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
        'Sec-WebSocket-Version': '13',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Pragma': 'no-cache',
        'Upgrade': 'websocket'
      };
      if (cookieHeader) headers['Cookie'] = cookieHeader;

      this.ws = new WebSocket(wsUrl, { headers });

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => {
        logger.debug(`📨 LT monitor received WebSocket data (${data.toString().length} bytes)`);
        this.handleMessage(data);
      });
      this.ws.on('error', (error) => this.handleError(error));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason));

      // Wait for connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('LT monitor connection timeout'));
        }, 30000);

        this.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.connected = true;
      logger.info('✅ LT monitor connected successfully');

    } catch (error) {
      logger.error('Failed to connect LT monitor:', error);
      throw error;
    }
  }

  handleOpen() {
    logger.info('LT monitor WebSocket opened');
    this.reconnectAttempts = 0;
    // Reset study flags so indicators are re-added on the new session
    this.studyAdded = false;
    this.lsStudyAdded = false;
    this.lastLsValues = null;
    // Drop forming-bar cache; the next data update will reseed.
    // Keep lsConfirmedSentiment AND lsConfirmedBarTs so we don't re-fire on
    // the same state after a reconnect (last confirmed values stay valid).
    // Mark next bar as NOT fully observed — the reseed happens mid-bar at
    // an arbitrary intrabar moment, so its lsFormingBarSentiment is a
    // partial observation, not a real close value. The "new bar arrived"
    // handler will skip emission on the first post-reconnect bar transition.
    this.lsFormingBarTs = null;
    this.lsFormingBarSentiment = null;
    this.lsFormingBarRaw = null;
    this.lsBarFullyObserved = false;
    this.initializeSessions();
    this.startKeepalivePing();
    this.emit('connected');
  }

  /**
   * Mirror tradingview-client's client-originated keepalive: send
   * ~m~<size>~m~~h~<n> every 10s with n incrementing from 1. Required to
   * prevent TV's ~65-75s "polling only" session cut. See lt-monitor-hibernate
   * memory for prior incident — server-heartbeat echoes alone are not enough.
   */
  startKeepalivePing() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingCounter = 0;
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        logger.warn(`LT keepalive ping skipped — WS state: ${this.ws?.readyState ?? 'no-ws'}`);
        return;
      }
      this.pingCounter += 1;
      const body = `~h~${this.pingCounter}`;
      const frame = `~m~${body.length}~m~${body}`;
      try {
        this.ws.send(frame);
      } catch (err) {
        logger.warn(`LT monitor keepalive ping send failed: ${err.message}`);
      }
    }, 10_000);
  }

  initializeSessions() {
    // Generate session IDs
    this.quoteSession = this.generateSession('qs');
    this.chartSession = this.generateSession('cs');

    // Send initialization sequence
    this.sendMessage('set_auth_token', [this.jwtToken || 'unauthorized_user_token']);
    this.sendMessage('set_locale', ['en', 'US']);

    // Create sessions
    this.sendMessage('chart_create_session', [this.chartSession, '']);
    this.sendMessage('quote_create_session', [this.quoteSession]);
    this.sendMessage('quote_set_fields', [
      this.quoteSession,
      'ch', 'chp', 'current_session', 'description', 'local_description',
      'language', 'exchange', 'fractional', 'is_tradable', 'lp', 'lp_time',
      'minmov', 'minmove2', 'original_name', 'pricescale', 'pro_name',
      'short_name', 'type', 'update_mode', 'volume', 'currency_code',
      'rchp', 'rtc'
    ]);

    logger.info('LT monitor sessions initialized');
  }

  async startMonitoring() {
    logger.info(`📊 Starting LT monitoring for ${this.symbol} on ${this.timeframe}m timeframe`);

    const resolveSymbol = JSON.stringify({
      "adjustment": "splits",
      "symbol": this.symbol
    });

    // Add symbol to quote session
    this.sendMessage('quote_add_symbols', [this.quoteSession, `=${resolveSymbol}`]);

    // Resolve symbol for chart
    this.sendMessage('resolve_symbol', [this.chartSession, 'sds_sym_1', `=${resolveSymbol}`]);

    // Create 15-minute series with more historical data
    this.sendMessage('create_series', [
      this.chartSession,
      'sds_1',
      's1',
      'sds_sym_1',
      this.timeframe,  // 15-minute timeframe
      700,             // Request 700 bars (LT Fib 7 needs 610 bars to calculate)
      ''
    ]);

    // Study will be added after receiving timescale_update message
    // This ensures the series is fully loaded before adding the indicator

    // Add fast symbols for real-time updates. We don't act on the quote
    // payloads (handleMessage only consumes the st10 indicator data), but
    // keeping the quote stream FLOWING is what keeps the WebSocket alive.
    //
    // [2026-05-20] Investigation showed connections were being dropped by
    // TradingView at a fixed ~63s after connect — a session-lifetime cap
    // applied to indicator-only / hibernated sessions. The previous code
    // called quote_hibernate_all here as a bandwidth optimization, which
    // killed the quote stream and triggered the cap. Removing hibernate
    // lets quotes flow continuously and matches the behavior of the main
    // tradingViewClient (which never hibernates and stays connected for
    // hours). See memory/ls-bar-close-gating.md for context.
    this.sendMessage('quote_fast_symbols', [this.quoteSession, this.symbol]);
    // this.sendMessage('quote_hibernate_all', [this.quoteSession]);  // removed

    logger.info(`✅ LT indicator added for ${this.symbol}`);
  }

  handleMessage(data) {
    const message = data.toString();

    // Handle heartbeat
    if (message.match(/^~m~\d+~m~~h~\d+$/)) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(message);
        this.lastHeartbeat = new Date();
      }
      return;
    }

    // Log non-heartbeat messages for debugging
    if (!message.startsWith('~h~')) {
      logger.debug(`🔍 LT monitor raw message: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`);
    }

    // Split messages
    const messages = message.split(/~m~\d+~m~/);

    for (const msg of messages) {
      if (msg && msg.trim()) {
        this.parseMessage(msg);
      }
    }
  }

  parseMessage(content) {
    try {
      const data = JSON.parse(content);

      // Log all message types for debugging
      if (data.m) {
        logger.debug(`LT monitor received message type: ${data.m}`);
      }

      // Handle data updates
      if (data.m === 'du') {
        logger.debug('📊 LT monitor received data update');
        this.handleDataUpdate(data);
      } else if (data.m === 'study_error') {
        logger.error('LT study error:', data);
        // Classify auth-related study errors and publish them so the dashboard
        // can show a "JWT needs refresh" banner. The two known JWT-degraded
        // signatures from TV:
        //   "study_not_auth:Script@tv-scripting-XYZ" — premium script not
        //       authorized under the current token (token effectively expired).
        //   "The maximum number of studies per chart has been reached for
        //       current subscription" — TV applying free-tier study quota,
        //       which happens when premium auth has degraded.
        // Both indicate the same root cause: refresh the JWT.
        const errorParts = Array.isArray(data.p) ? data.p : [];
        const errorMsg = errorParts.find(p => typeof p === 'string' && (
          p.includes('study_not_auth') ||
          p.includes('maximum number of studies')
        ));
        if (errorMsg) {
          this._publishAuthDegraded(errorMsg, data);
        }
      } else if (data.m === 'symbol_resolved') {
        logger.debug('LT symbol resolved');
      } else if (data.m === 'timescale_update') {
        logger.debug('LT timescale update received');
        // Try adding study after receiving timescale update
        if (!this.studyAdded) {
          this.studyAdded = true;
          // Wait longer to ensure series is fully loaded, then fetch metadata and create study
          setTimeout(async () => {
            try {
              // Fetch metadata first, like Python does
              const ltResult = await this.fetchIndicatorMetadata(LIQUIDITY_TRIGGER_INDICATOR, LIQUIDITY_TRIGGER_VERSION);

              if (ltResult) {
                // Prepare study payload using fetched metadata
                const studyPayload = this.prepareIndicatorMetadata(LIQUIDITY_TRIGGER_INDICATOR, ltResult.metainfo);

                // Create study parameters matching Python's format exactly
                const studyParams = [
                  this.chartSession,
                  'st9',  // Study ID (matching Python)
                  'st1',  // Output ID
                  'sds_1',  // Data source
                  ltResult.scriptEndpoint,
                  studyPayload
                ];

                this.sendMessage('create_study', studyParams);
                logger.info(`📐 LT study creation sent using fetched metadata (${ltResult.scriptEndpoint})`);
              } else {
                logger.error('❌ Failed to fetch LT indicator metadata, cannot create study');
              }

              // Create LS study if configured
              if (LIQUIDITY_STATUS_INDICATOR && !this.lsStudyAdded) {
                this.lsStudyAdded = true;
                try {
                  const lsResult = await this.fetchIndicatorMetadata(LIQUIDITY_STATUS_INDICATOR, LIQUIDITY_STATUS_VERSION);
                  if (lsResult) {
                    const lsPayload = this.prepareIndicatorMetadata(LIQUIDITY_STATUS_INDICATOR, lsResult.metainfo);
                    // Use Simplified mode (default) for clean BULLISH/BEARISH binary output
                    const lsStudyParams = [
                      this.chartSession,
                      'st10',   // LS study ID (distinct from LT's st9)
                      'st2',    // Output ID
                      'sds_1',  // Same data source
                      lsResult.scriptEndpoint,
                      lsPayload
                    ];
                    this.sendMessage('create_study', lsStudyParams);
                    logger.info(`📐 LS study creation sent using fetched metadata (${lsResult.scriptEndpoint})`);
                  } else {
                    logger.error('❌ Failed to fetch LS indicator metadata, cannot create study');
                  }
                } catch (lsError) {
                  logger.error('❌ Error creating LS study with metadata:', lsError);
                }
              }
            } catch (error) {
              logger.error('❌ Error creating LT study with metadata:', error);
            }
          }, 3000);  // Wait 3 seconds
        }
      } else if (data.m === 'study_loading') {
        logger.info('📚 LT study loading...');
      } else if (data.m === 'study_completed') {
        logger.info('✅ LT study completed loading');
      } else if (data.m === 'series_completed') {
        logger.info('✅ Series completed loading');
      }

    } catch (error) {
      // Not JSON, ignore
    }
  }

  handleDataUpdate(data) {
    const payload = data.p;
    if (!payload || payload.length < 2) return;

    const update = payload[1];

    // Look for LS indicator data in st10
    //
    // BAR-CLOSE GATING (2026-05-19): TV pushes intrabar updates on the
    // currently-forming bar. The LS indicator can flip BULLISH↔BEARISH
    // intrabar and revert before close. We only want to act on CONFIRMED
    // bar closes. Strategy: cache the forming bar's latest sentiment, and
    // when a new bar's timestamp arrives, the previously-forming bar is
    // now closed — that's when we compare and emit.
    if (update.st10 && update.st10.st) {
      const lsStudyData = update.st10.st;
      if (lsStudyData.length > 0) {
        const latest = lsStudyData[lsStudyData.length - 1];
        const values = latest.v;
        if (values) {
          const newTs = values[0];
          // Simplified mode: raw 5 = BULLISH, raw 8 = BEARISH (matches backtest CSV)
          const raw = values[5];
          const sentiment = raw <= 6 ? 'BULLISH' : raw >= 7 ? 'BEARISH' : null;

          if (this.lsFormingBarTs === null) {
            // Seed: either first observation ever OR first post-reconnect tick.
            // Either way we don't know if we caught the bar from its OPEN — the
            // sentiment cached here is just whatever intrabar value happened to
            // arrive first. Mark the bar as NOT fully observed so the "new bar
            // arrived" branch skips emission for this bar's close.
            this.lsFormingBarTs = newTs;
            this.lsFormingBarSentiment = sentiment;
            this.lsFormingBarRaw = raw;
            this.lsBarFullyObserved = false;
            if (sentiment) {
              logger.info(`📊 LS seed (partial): ${sentiment} (raw=${raw}) candle=${new Date(newTs * 1000).toISOString()} — close will be skipped, awaiting next fully-observed bar`);
              // Don't update currentLsSentiment from a partial seed — keep
              // the last confirmed value as the public state until the next
              // fully-observed close confirms something new.
            }
          } else if (newTs === this.lsFormingBarTs) {
            // Same bar — intrabar update. Cache provisional value, do NOT emit.
            if (sentiment) {
              this.lsFormingBarSentiment = sentiment;
              this.lsFormingBarRaw = raw;
            }
          } else if (newTs > this.lsFormingBarTs) {
            // New bar arrived. The previous forming bar is now CONFIRMED CLOSED.
            // Its final sentiment is whatever we last cached for it.
            const closedBarTs = this.lsFormingBarTs;
            const closedBarSentiment = this.lsFormingBarSentiment;
            const closedBarRaw = this.lsFormingBarRaw;
            const isoClose = new Date(closedBarTs * 1000).toISOString();

            // Gap detection: if the bar that just closed is more than ~1 bar
            // after the last confirmed close, we missed at least one bar in
            // between — could have been a real flip on a bar we didn't see.
            // We can't claim this is THE trigger bar; emit with gap=true so
            // tradeable strategies (lstb) skip while the dashboard chip can
            // still catch up its displayed state.
            const gapSec = this.lsConfirmedBarTs == null
              ? 0
              : closedBarTs - this.lsConfirmedBarTs;
            const isGap = this.lsConfirmedBarTs != null && gapSec > this.LS_GAP_THRESHOLD_SEC;

            if (!this.lsBarFullyObserved) {
              // First bar after a seed (startup or reconnect). Don't trust
              // its close value — we may have missed the bar's opening ticks.
              // Update internal state so we have a baseline going forward,
              // but do NOT emit (no consumer can act on a partial bar).
              if (closedBarSentiment) {
                logger.info(`📊 LS partial-bar skipped (post-seed): ${closedBarSentiment} @ ${isoClose} — establishing baseline only`);
                this.lsConfirmedSentiment = closedBarSentiment;
                this.lsConfirmedBarTs = closedBarTs;
                this.currentLsSentiment = closedBarSentiment;
              }
            } else if (closedBarSentiment && closedBarSentiment !== this.lsConfirmedSentiment) {
              const tag = isGap ? `GAP-CATCHUP (gap=${gapSec}s)` : 'FLIP';
              logger.info(`📊 LS ${tag} (bar-close): ${this.lsConfirmedSentiment ?? 'null'} → ${closedBarSentiment} (raw=${closedBarRaw}) candle=${isoClose}`);
              this.currentLsSentiment = closedBarSentiment;
              this.emit('ls_status', {
                sentiment: closedBarSentiment,
                raw: closedBarRaw,
                timestamp: closedBarTs,
                candleTime: isoClose,
                priorSentiment: this.lsConfirmedSentiment,
                barClose: true,
                gap: isGap,
                gapSec,
              });
              this.lsConfirmedSentiment = closedBarSentiment;
              this.lsConfirmedBarTs = closedBarTs;
              // A real bar-close flip means studies are subscribed AND
              // authenticated AND emitting — auth is healthy. If we had
              // previously published a degraded event, clear it now so the
              // dashboard banner disappears.
              this._publishAuthRestoredIfNeeded();
            } else if (closedBarSentiment) {
              // No state change — still update lsConfirmedBarTs so the next
              // gap check uses the most recent observed close.
              this.lsConfirmedBarTs = closedBarTs;
            }

            // Now start tracking the new forming bar. We observed it from
            // its opening tick (the boundary we just crossed), so its close
            // value next round WILL be trustworthy.
            this.lsFormingBarTs = newTs;
            this.lsFormingBarSentiment = sentiment;
            this.lsFormingBarRaw = raw;
            this.lsBarFullyObserved = true;
            // (Don't update currentLsSentiment from the forming bar — it's
            // provisional. Last confirmed value remains the public state.)
          }
          // newTs < lsFormingBarTs: out-of-order update; ignore.
        }
      }
    }

    // Look for LT indicator data in st9
    if (update.st9 && update.st9.st) {
      const studyData = update.st9.st;

      if (studyData.length > 0) {
        // Get the most recent data point
        const latest = studyData[studyData.length - 1];
        const values = latest.v;

        if (values && values.length >= 18) {
          const timestamp = values[0];

          // Skip if same timestamp as last update
          if (timestamp === this.lastTimestamp) {
            return;
          }

          // Parse LT levels - alternating value/counter at odd indices [5..17]
          // Maps to Fib 8,13,34,55,144,377,610 (verified via velocity analysis)
          // [19],[21] are disabled Reference Lines (always null)
          const levels = {
            timestamp: timestamp,
            candleTime: new Date(timestamp * 1000).toISOString(),
            L0: values[5] !== 1e+100 ? values[5] : null,
            L1: values[7] !== 1e+100 ? values[7] : null,
            L2: values[9] !== 1e+100 ? values[9] : null,
            L3: values[11] !== 1e+100 ? values[11] : null,
            L4: values[13] !== 1e+100 ? values[13] : null,
            L5: values[15] !== 1e+100 ? values[15] : null,
            L6: values[17] !== 1e+100 ? values[17] : null
          };

          this.currentLevels = levels;
          this.lastTimestamp = timestamp;

          // Emit the levels
          this.emit('lt_levels', levels);

          logger.info('📍 LT levels updated:', Object.entries(levels)
            .filter(([k, v]) => k.startsWith('L') && v !== null)
            .map(([k, v]) => `${k}:${v.toFixed(2)}`)
            .join(', '));
        }
      }
    }
  }

  handleError(error) {
    logger.error('LT monitor WebSocket error:', error.message);
    this.emit('error', error);
  }

  handleClose(code, reason) {
    logger.warn(`LT monitor disconnected - Code: ${code}, Reason: ${reason || 'No reason'}`);
    this.connected = false;

    // Tear down the client-keepalive timer; startKeepalivePing() will rearm
    // it on the next handleOpen().
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (!this.isDisconnecting) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    logger.info(`LT monitor reconnecting in ${delay/1000} seconds...`);

    setTimeout(async () => {
      try {
        // Check Redis for a fresher token before reconnecting
        const cachedToken = await getCachedToken(this.redisUrl);
        if (cachedToken) {
          const cachedTTL = getTokenTTL(cachedToken) || 0;
          const currentTTL = getTokenTTL(this.jwtToken) || 0;
          if (cachedTTL > currentTTL) {
            logger.info(`LT monitor using fresher token from Redis (TTL: ${Math.floor(cachedTTL / 60)}min)`);
            this.jwtToken = cachedToken;
          }
        }

        await this.connect();
        await this.startMonitoring();
        logger.info('LT monitor reconnected successfully');
      } catch (error) {
        logger.error('LT monitor reconnection failed:', error.message);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Update JWT token and reconnect. Called when the main TradingView client
   * refreshes its token.
   */
  /**
   * Publish a TV-auth-degraded event to the service.error channel so the
   * monitoring-service can track current health and the dashboard can show
   * an actionable banner ("JWT needs refresh"). Throttles to avoid spamming
   * — same error within 5 min is suppressed.
   */
  _publishAuthDegraded(errorMsg, raw) {
    const now = Date.now();
    if (this._lastAuthErrorAt && (now - this._lastAuthErrorAt) < 5 * 60_000) return;
    this._lastAuthErrorAt = now;
    this._authDegraded = true;
    const truncated = String(errorMsg).slice(0, 200);
    try {
      messageBus.publish('service.error', {
        service: 'data-service',
        type: 'tv_auth_degraded',
        source: 'lt-monitor',
        symbol: this.symbol,
        message: `LT study rejected by TradingView: "${truncated}" — JWT likely needs manual refresh`,
        tokenTTL: getTokenTTL(this.jwtToken),
        timestamp: new Date().toISOString(),
        raw: raw ? JSON.stringify(raw).slice(0, 400) : null,
      }).catch(err => logger.error('Failed to publish tv_auth_degraded:', err.message));
    } catch (err) {
      logger.error('Failed to publish tv_auth_degraded:', err.message);
    }
  }

  /**
   * Publish a TV-auth-restored event when LS data starts flowing again
   * after a degraded period. Called from the LS bar-close emit path
   * (the existence of a confirmed flip means studies are subscribed and
   * authenticated). One-shot per recovery cycle.
   */
  _publishAuthRestoredIfNeeded() {
    if (!this._authDegraded) return;
    this._authDegraded = false;
    try {
      messageBus.publish('service.error', {
        service: 'data-service',
        type: 'tv_auth_restored',
        source: 'lt-monitor',
        symbol: this.symbol,
        message: 'LT study data flowing again — JWT auth healthy',
        tokenTTL: getTokenTTL(this.jwtToken),
        timestamp: new Date().toISOString(),
      }).catch(err => logger.error('Failed to publish tv_auth_restored:', err.message));
    } catch (err) {
      logger.error('Failed to publish tv_auth_restored:', err.message);
    }
  }

  async updateToken(newToken) {
    this.jwtToken = newToken;

    // [2026-05-22] Prefer in-place token refresh over reconnect. TV's
    // protocol accepts a new `set_auth_token` message on the existing
    // connection — exactly what the browser does. Forcing a close+reconnect
    // here used to trigger 3 rapid reconnects at data-service startup (the
    // `scheduleSessionRefresh` 5s-after-startup tick → updateToken cascade),
    // which TV's classifier appears to flag as "polling client" and apply
    // the ~75s session-lifetime cap to. Sending set_auth_token on the live
    // WS avoids the cascade entirely.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.sendMessage('set_auth_token', [newToken]);
        logger.info('LT monitor JWT updated in-place (set_auth_token on live WS)');
        return;
      } catch (err) {
        logger.warn(`In-place token update failed (${err.message}) — falling back to reconnect`);
      }
    }

    // Fallback: full reconnect (only if WS isn't open).
    logger.info('LT monitor token update requires reconnect (WS not open)');
    const wasDisconnecting = this.isDisconnecting;
    this.isDisconnecting = true;
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.connected = false;
    this.isDisconnecting = wasDisconnecting;
    this.reconnectAttempts = 0;
    try {
      await this.connect();
      await this.startMonitoring();
      logger.info('LT monitor reconnected with new token');
    } catch (error) {
      logger.error('LT monitor reconnection with new token failed:', error.message);
      this.scheduleReconnect();
    }
  }

  async disconnect() {
    logger.info('Disconnecting LT monitor...');
    this.isDisconnecting = true;

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    logger.info('LT monitor disconnected');
  }

  getCurrentLevels() {
    return this.currentLevels;
  }

  getCurrentLsSentiment() {
    return this.currentLsSentiment;
  }

  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async fetchIndicatorMetadata(scriptId, scriptVersion) {
    /**
     * Fetch metadata for a TradingView indicator (like Python's fetch_indicator_metadata)
     */
    const url = `https://pine-facade.tradingview.com/pine-facade/translate/${scriptId}/${scriptVersion}`;

    try {
      logger.info(`📥 Fetching indicator metadata for ${scriptId} v${scriptVersion}`);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const metainfo = data.result?.metaInfo;
      const scriptEndpoint = this.extractScriptEndpoint(data.result?.id);

      if (metainfo) {
        logger.info(`📋 Successfully fetched indicator metadata (endpoint: ${scriptEndpoint})`);
        return { metainfo, scriptEndpoint };
      }

      logger.error('No metainfo found in indicator metadata');
      return null;

    } catch (error) {
      logger.error(`Failed to fetch indicator metadata: ${error.message}`);
      return null;
    }
  }

  prepareIndicatorMetadata(scriptId, metainfo) {
    /**
     * Prepare indicator metadata into the required payload structure
     * (exactly like Python's prepare_indicator_metadata)
     */
    const studyPayload = {
      text: metainfo.inputs?.[0]?.defval || '',
      pineId: scriptId,
      pineVersion: metainfo.pine?.version || '1.0',
      pineFeatures: {
        v: '{"indicator":1,"plot":1,"ta":1}',
        f: true,
        t: 'text'
      },
      __profile: {
        v: false,
        f: true,
        t: 'bool'
      }
    };

    // Add additional inputs that start with 'in_'
    const inputs = metainfo.inputs || [];
    inputs.forEach((input) => {
      if (input.id && input.id.startsWith('in_')) {
        studyPayload[input.id] = {
          v: input.defval,
          f: true,
          t: input.type
        };
      }
    });

    logger.info('📋 Prepared indicator metadata successfully');
    logger.debug('Prepared payload:', JSON.stringify(studyPayload, null, 2));
    return studyPayload;
  }

  extractScriptEndpoint(resultId) {
    /**
     * Extract the script endpoint from the translate API result id.
     * e.g., "Script$PUB;abc123@tv-scripting-707" → "Script@tv-scripting-707!"
     */
    if (!resultId) return 'Script@tv-scripting-101!';
    const match = resultId.match(/@(tv-scripting-\d+)/);
    if (match) {
      return `Script@${match[1]}!`;
    }
    return 'Script@tv-scripting-101!';
  }
}

export default LTMonitor;