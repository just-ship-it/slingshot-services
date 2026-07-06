// Data Service - Centralized market data sourcing
// Single instance providing TradingView quotes, GEX levels, Tradier exposure,
// LT levels, and IV skew to all consumers via Redis pub/sub and HTTP.

import { createLogger, messageBus, CHANNELS } from '../../shared/index.js';
import config from './config.js';
import TradingViewClient from '../../signal-generator/src/websocket/tradingview-client.js';
import LTMonitor from '../../signal-generator/src/websocket/lt-monitor.js';
import SchwabStreamer from '../../signal-generator/src/schwab/schwab-streamer.js';
import GexCalculator from '../../signal-generator/src/gex/gex-calculator.js';
import OptionsExposureService from '../../signal-generator/src/tradier/options-exposure-service.js';
import HybridGexCalculator from '../../signal-generator/src/gex/hybrid-gex-calculator.js';
import {
  getBestAvailableToken,
  cacheTokenInRedis,
  getTokenTTL,
  cacheSessionCookies,
  getCachedSessionCookies,
  extractJwtFromPage,
  refreshJwtFromSession,
  parseCookieString,
} from '../../signal-generator/src/utils/tradingview-auth.js';
import { CandleManager } from './candle-manager.js';
import { ShortDTEIVCalculator } from './short-dte-iv-calculator.js';

const logger = createLogger('data-service');

// [2026-05-22] Symbol mappers for TradingView → Schwab migration.
// Used by data-service to translate the existing OHLCV_SYMBOLS / QUOTE_ONLY_SYMBOLS
// (TV-formatted) into the symbol shapes Schwab's streamer expects.
function tvSymbolToSchwabFuture(tvSym) {
  // 'CME_MINI:NQM2026' → '/NQM26'   /   'CME_MINI:ESH2026' → '/ESH26'
  const m = tvSym.match(/^(?:CME_MINI:)?([A-Z]+[A-Z])(\d{2,4})$/);
  if (!m) return null;
  let year = m[2];
  if (year.length === 4) year = year.slice(2);
  return `/${m[1]}${year}`;
}
function tvSymbolToSchwabEquity(tvSym) {
  // 'NASDAQ:QQQ' → 'QQQ'   /   'AMEX:SPY' → 'SPY'   /   bare 'QQQ' → 'QQQ'
  const idx = tvSym.indexOf(':');
  return idx >= 0 ? tvSym.slice(idx + 1) : tvSym;
}

// Don't full-reload history on every Schwab reconnect — a transient reconnect
// resumes the live stream where it left off, and re-seeding each time is what
// turned a Schwab flap into a DATA_READY storm that froze every strategy.
const RESEED_DEBOUNCE_MS = 120_000; // 2 min between history re-seeds

// Single-instance guard for the Schwab streamer. Schwab permits ONE streamer
// session per account, so two data-service instances (e.g. a deploy overlap)
// would boot each other in an endless code=1000 loop. A Redis lock makes exactly
// one instance run the streamer; the others stand by and take over if it dies.
const SCHWAB_LOCK_KEY = 'data-service:schwab-streamer:owner';
const SCHWAB_LOCK_TTL_MS = 30_000;   // ownership lease
const SCHWAB_LOCK_RENEW_MS = 10_000; // renew well within the lease
const SCHWAB_LOCK_RETRY_MS = 15_000; // standby re-acquire cadence
const INSTANCE_ID = process.env.HOSTNAME || `pid-${process.pid}`; // k8s pod name

class DataService {
  constructor() {
    this.tradingViewClient = null;
    this.schwabStreamer = null;

    // Per-product GEX calculators
    this.gexCalculators = new Map();  // 'NQ' -> GexCalculator, 'ES' -> GexCalculator

    // Tradier exposure service (handles both QQQ and SPY)
    this.tradierExposureService = null;
    this.ivSkewCalculator = null;
    this.shortDTEIVCalculator = null;

    // Hybrid GEX calculators (per product)
    this.hybridGexCalculators = new Map();

    // LT Monitors (per product)
    this.ltMonitors = new Map();  // 'NQ' -> LTMonitor, 'ES' -> LTMonitor

    // Candle manager for all products
    this.candleManager = new CandleManager();

    // Throttle repeated Schwab connectivity alerts (keyed by alert type)
    this._schwabAlertLastAt = new Map();

    this.isRunning = false;
  }

  // Publish a Schwab connectivity/auth problem to STRATEGY_ALERT so it reaches
  // the dashboard + Discord instead of dying in the logs. Failure types are
  // throttled (the token refresher retries every 25 min and every API 401 also
  // triggers a refresh, so an expired refresh token would otherwise spam);
  // recovery alerts always go out and reset the throttle so a NEW failure
  // after recovery alerts immediately.
  _publishSchwabAlert(type, severity, message, details = {}, { throttleMs = 15 * 60_000 } = {}) {
    const now = Date.now();
    if (throttleMs > 0) {
      const last = this._schwabAlertLastAt.get(type) || 0;
      if (now - last < throttleMs) return;
    }
    this._schwabAlertLastAt.set(type, now);
    messageBus.publish(CHANNELS.STRATEGY_ALERT, {
      severity,
      source: 'data-service',
      type,
      message,
      details,
      timestamp: new Date().toISOString(),
    }).catch(err => logger.warn(`Failed to publish ${type} alert: ${err.message}`));
  }

  async start() {
    try {
      logger.info('Starting Data Service...');
      console.log('Starting Data Service...');

      // Connect to message bus
      logger.info('Connecting to message bus...');
      if (!messageBus.isConnected) {
        await messageBus.connect();
      }
      logger.info('Connected to message bus successfully');

      // Initialize Tradier service first (needed by hybrid GEX calculators)
      await this.initializeTradierService();

      // Initialize GEX calculators for both products (uses Tradier if available for hybrid mode)
      await this.initializeGexCalculators();

      // Startup token check
      const redisUrl = config.getRedisUrl();
      let startupJwtToken = config.TRADINGVIEW_JWT_TOKEN;
      const tokenRefreshEnabled = process.env.TV_TOKEN_REFRESH_ENABLED !== 'false';

      if (tokenRefreshEnabled && config.TRADINGVIEW_CREDENTIALS) {
        try {
          const best = await getBestAvailableToken(config.TRADINGVIEW_JWT_TOKEN, redisUrl);
          if (best) {
            startupJwtToken = best.token;
            const ttlMin = Math.floor(best.ttl / 60);
            logger.info(`Startup token source: ${best.source} (JWT exp: ${ttlMin > 0 ? `${ttlMin}min` : `expired ${-ttlMin}min ago`})`);
          } else {
            logger.warn('No JWT token available - TradingView will use unauthenticated mode');
          }
        } catch (error) {
          logger.warn('Startup token check failed:', error.message);
        }
      }

      // [2026-05-22] TradingViewClient kept instantiated ONLY for JWT-token
      // plumbing into LT monitors (lt-monitor.js still needs TV WS for the
      // proprietary LT/LS Pine studies). OHLCV/quote streaming has migrated
      // to Schwab — TV WS is NOT opened here anymore.
      this.tradingViewClient = new TradingViewClient({
        symbols: config.OHLCV_SYMBOLS,
        quoteOnlySymbols: config.QUOTE_ONLY_SYMBOLS,
        ltSymbol: null,
        jwtToken: startupJwtToken,
        credentials: config.TRADINGVIEW_CREDENTIALS,
        tokenRefreshEnabled,
        redisUrl,
        candleHistoryBars: 500,
      });

      // ─── Schwab streaming (replaces TradingView for OHLCV + quotes) ───
      const schwabFutureSymbols = config.OHLCV_SYMBOLS.map(tvSymbolToSchwabFuture).filter(Boolean);
      const schwabEquitySymbols = config.QUOTE_ONLY_SYMBOLS.map(tvSymbolToSchwabEquity).filter(Boolean);
      logger.info(`Schwab streamer symbols: futures=[${schwabFutureSymbols.join(',')}] equities=[${schwabEquitySymbols.join(',')}]`);

      this.schwabStreamer = new SchwabStreamer({
        appKey: config.SCHWAB_APP_KEY,
        appSecret: config.SCHWAB_APP_SECRET,
        redisUrl,
        futureSymbols: schwabFutureSymbols,
        equitySymbols: schwabEquitySymbols,
        historyBarCount: 500,
      });

      this.schwabStreamer.on('quote', (quote) => this.handleQuoteUpdate(quote));

      this.schwabStreamer.on('history_loaded', ({ symbol, baseSymbol, timeframe, candles }) => {
        const canonical = this.candleManager.resolveBaseSymbol(baseSymbol);
        if (canonical) {
          this.candleManager.seedHistory(canonical, timeframe, candles);
          this.candleManager.markSeeded(canonical, timeframe);
          const tfLabel = timeframe === '1D' ? '1D' : `${timeframe}m`;
          logger.info(`History loaded: ${candles.length} ${tfLabel} candles for ${canonical} (from ${baseSymbol})`);
          messageBus.publish(CHANNELS.DATA_READY, {
            product: canonical,
            timeframe,
            candleCount: candles.length,
            readiness: this.candleManager.getReadiness()
          }).catch(err => logger.warn(`Failed to publish data.ready: ${err.message}`));
        }
      });

      this.schwabStreamer.on('reconnected', async () => {
        // Debounce the history re-seed. The live stream resumes on its own; only
        // re-seed if we haven't recently, so a brief reconnect (or flap) can't
        // trigger a DATA_READY storm that freezes the strategy engine.
        const sinceLast = Date.now() - (this._lastHistoryReseedAt || 0);
        if (sinceLast < RESEED_DEBOUNCE_MS) {
          logger.info(`Schwab streamer reconnected — skipping history re-seed (last ${Math.round(sinceLast / 1000)}s ago)`);
          return;
        }
        logger.info('Schwab streamer reconnected — recreating history sessions...');
        this.candleManager.resetReadiness();
        await this.createHistorySessions();
      });

      // A flapping streamer (repeated short-lived connections) almost always
      // means a competing Schwab session — surface it as a critical alert
      // instead of silently looping for hours.
      this.schwabStreamer.on('session_conflict', (info) => {
        messageBus.publish(CHANNELS.STRATEGY_ALERT, {
          severity: 'critical',
          source: 'data-service',
          type: 'schwab_session_conflict',
          message: info?.message || 'Schwab streamer session conflict (competing session likely)',
          timestamp: new Date().toISOString(),
        }).catch(err => logger.warn(`Failed to publish schwab session_conflict alert: ${err.message}`));
      });

      // Streamer down across multiple reconnect attempts (dead token, Schwab
      // outage) — distinct from session_conflict, which flaps. The streamer
      // throttles this itself, so no _publishSchwabAlert throttle needed.
      this.schwabStreamer.on('prolonged_disconnect', (info) => {
        this._schwabStreamerDownAlerted = true;
        this._publishSchwabAlert(
          'schwab_streamer_down', 'critical',
          info?.message || 'Schwab streamer down — repeated reconnect failures; live candles are NOT flowing.',
          info, { throttleMs: 0 }
        );
      });
      // 'reconnected' fires on every routine reconnect — only publish a
      // recovery alert if we previously alerted that the streamer was down.
      this.schwabStreamer.on('reconnected', () => {
        if (!this._schwabStreamerDownAlerted) return;
        this._schwabStreamerDownAlerted = false;
        this._publishSchwabAlert(
          'schwab_streamer_recovered', 'info',
          'Schwab streamer reconnected — live candles/quotes flowing again.',
          {}, { throttleMs: 0 }
        );
      });

      // Connect to Schwab — gated by a single-instance Redis lock so two
      // data-service instances can't fight over the one-per-account streamer
      // session. NON-FATAL on failure (expired token, etc.); the instance that
      // does NOT win the lock stands by and takes over if the owner dies.
      await this._startSchwabStreamingGuarded(redisUrl);

      // Initialize LT Monitors for both products
      // Use the client's current token (may have been refreshed during connect) rather than the startup token
      const ltToken = this.tradingViewClient.jwtToken || startupJwtToken;
      await this.initializeLtMonitors(ltToken, redisUrl);

      // Set up GEX refresh schedules
      this.scheduleGexRefresh();
      this.scheduleRTHOpenRefresh();

      // Auto-refresh JWT from cached sessionid every ~90 min (Option A).
      // No-op if no sessionid is cached yet (bootstrap via POST /tv-auth/sessionid).
      this.scheduleSessionRefresh();

      // Publish cached GEX levels to Redis so signal generators pick them up immediately
      for (const [product, calculator] of this.gexCalculators) {
        const levels = calculator.getCurrentLevels();
        if (levels) {
          await messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product });
          logger.info(`Published cached GEX levels for ${product} on startup`);
        }
      }

      this.isRunning = true;
      logger.info('Data Service started successfully');

      // Publish service health
      await messageBus.publish('service.health', {
        service: config.SERVICE_NAME,
        status: 'running',
        timestamp: new Date().toISOString(),
        components: {
          tradingview: 'connected',
          gex_nq: this.gexCalculators.has('NQ') ? 'ready' : 'not_initialized',
          gex_es: this.gexCalculators.has('ES') ? 'ready' : 'not_initialized',
          lt_nq: this.ltMonitors.has('NQ') ? 'connected' : 'not_initialized',
          lt_es: this.ltMonitors.has('ES') ? 'connected' : 'not_initialized',
          tradier: this.tradierExposureService ? 'ready' : 'not_required'
        }
      });

    } catch (error) {
      logger.error('Failed to start Data Service:', error);
      throw error;
    }
  }

  /**
   * Initialize GEX calculators for NQ (from QQQ) and ES (from SPY)
   */
  async initializeGexCalculators() {
    const products = [
      {
        key: 'NQ',
        etfSymbol: config.NQ_GEX_SYMBOL,
        futuresSymbol: config.NQ_GEX_FUTURES_SYMBOL,
        defaultMultiplier: config.NQ_GEX_DEFAULT_MULTIPLIER,
        cacheFile: config.NQ_GEX_CACHE_FILE
      },
      // [2026-05-20] ES GEX calculator disabled — no live strategies trade ES.
      // The CBOE SPY chain fetch happens on a schedule and was a non-trivial
      // chunk of data-service startup time + memory. Re-enable alongside ES
      // LT monitor + ES OHLCV streaming in config.js if reviving ES.
      // {
      //   key: 'ES',
      //   etfSymbol: config.ES_GEX_SYMBOL,
      //   futuresSymbol: config.ES_GEX_FUTURES_SYMBOL,
      //   defaultMultiplier: config.ES_GEX_DEFAULT_MULTIPLIER,
      //   cacheFile: config.ES_GEX_CACHE_FILE
      // }
    ];

    const hasOptionsProvider = (config.SCHWAB_ENABLED && !!config.SCHWAB_APP_KEY) || (config.TRADIER_ENABLED && !!config.TRADIER_ACCESS_TOKEN);
    const hybridEnabled = hasOptionsProvider && config.HYBRID_GEX_ENABLED;

    for (const product of products) {
      try {
        if (hybridEnabled && this.tradierExposureService) {
          // Hybrid mode: Tradier + CBOE
          logger.info(`Initializing Hybrid GEX for ${product.key} (${product.etfSymbol}->${product.futuresSymbol})...`);
          const hybrid = new HybridGexCalculator({
            tradierEnabled: hasOptionsProvider && config.TRADIER_AUTO_START,
            tradierRefreshMinutes: config.HYBRID_TRADIER_REFRESH_MINUTES || 3,
            cboeEnabled: config.HYBRID_CBOE_ENABLED !== false && process.env.HYBRID_CBOE_ENABLED !== 'false',
            cboeRefreshMinutes: config.HYBRID_CBOE_REFRESH_MINUTES || 15,
            preferTradierWhenFresh: config.HYBRID_PREFER_TRADIER_WHEN_FRESH ?? true,
            tradierFreshnessMinutes: config.HYBRID_TRADIER_FRESHNESS_MINUTES || 5,
            tradierService: this.tradierExposureService,
            cboe: {
              symbol: product.etfSymbol,
              futuresSymbol: product.futuresSymbol,
              etfSymbol: product.etfSymbol,
              defaultMultiplier: product.defaultMultiplier,
              cacheFile: product.cacheFile,
              cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
              redisUrl: config.getRedisUrl()
            }
          });
          await hybrid.initialize();

          // Publish fresh GEX levels to Redis on every hybrid refresh
          // so signal-generator strategies always have current regime data
          const productKey = product.key;
          hybrid.setUpdateCallback((levels) => {
            messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product: productKey })
              .then(() => logger.debug(`Published refreshed GEX levels for ${productKey} to Redis`))
              .catch(err => logger.warn(`Failed to publish GEX levels for ${productKey}:`, err.message));
          });

          this.hybridGexCalculators.set(product.key, hybrid);
          this.gexCalculators.set(product.key, hybrid);
          logger.info(`Hybrid GEX for ${product.key} initialized`);
        } else {
          // CBOE-only mode
          logger.info(`Initializing CBOE GEX for ${product.key} (${product.etfSymbol}->${product.futuresSymbol})...`);
          const gex = new GexCalculator({
            symbol: product.etfSymbol,
            futuresSymbol: product.futuresSymbol,
            etfSymbol: product.etfSymbol,
            defaultMultiplier: product.defaultMultiplier,
            cacheFile: product.cacheFile,
            cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
            redisUrl: config.getRedisUrl()
          });
          await gex.loadCachedLevels();
          if (!gex.currentLevels) {
            logger.info(`No cached GEX levels for ${product.key} - fetching from CBOE...`);
            try {
              await gex.calculateLevels(true);
            } catch (err) {
              logger.warn(`Initial CBOE fetch for ${product.key} failed:`, err.message);
            }
          }
          this.gexCalculators.set(product.key, gex);
          logger.info(`CBOE GEX for ${product.key} initialized`);
        }
      } catch (error) {
        logger.error(`Failed to initialize GEX for ${product.key}:`, error.message);
        // Try CBOE fallback
        try {
          const gex = new GexCalculator({
            symbol: product.etfSymbol,
            futuresSymbol: product.futuresSymbol,
            etfSymbol: product.etfSymbol,
            defaultMultiplier: product.defaultMultiplier,
            cacheFile: product.cacheFile,
            cooldownMinutes: config.GEX_COOLDOWN_MINUTES,
            redisUrl: config.getRedisUrl()
          });
          await gex.loadCachedLevels();
          this.gexCalculators.set(product.key, gex);
          logger.info(`CBOE GEX for ${product.key} initialized as fallback`);
        } catch (fallbackError) {
          logger.error(`CBOE fallback for ${product.key} also failed:`, fallbackError.message);
        }
      }
    }
  }

  /**
   * Initialize Tradier Exposure Service for both QQQ and SPY
   */
  async initializeTradierService() {
    const schwabEnabled = config.SCHWAB_ENABLED && config.SCHWAB_APP_KEY;
    const tradierEnabled = config.TRADIER_ENABLED && config.TRADIER_ACCESS_TOKEN;

    if (!schwabEnabled && !tradierEnabled) {
      logger.info('No options data provider configured (Schwab or Tradier), skipping');
      return;
    }

    const provider = schwabEnabled ? 'Schwab' : 'Tradier';
    logger.info(`Initializing options data via ${provider}...`);

    try {
      this.tradierExposureService = new OptionsExposureService({
        symbols: config.TRADIER_SYMBOLS
      });

      await this.tradierExposureService.initialize();

      // Surface Schwab REST auth failures (token refresh 400/401, missing
      // refresh token) on the dashboard — this is the path that feeds
      // GEX/exposure/IV, and it previously died silently in the logs while
      // every strategy ran on stale levels.
      const optionsClient = this.tradierExposureService.tradierClient;
      if (optionsClient?.on) {
        optionsClient.on('auth_failure', (info) => {
          const hint = info.needsReauth
            ? 'Refresh token EXPIRED/INVALID — re-authenticate Schwab via the browser OAuth flow.'
            : 'May be transient (network/Schwab outage) — will keep retrying.';
          this._publishSchwabAlert(
            info.needsReauth ? 'schwab_auth_expired' : 'schwab_auth_failure',
            'critical',
            `Schwab token refresh failed (HTTP ${info.status ?? 'n/a'}, ${info.consecutiveFailures} consecutive). ` +
            `GEX/IV/exposure data is going STALE. ${hint}`,
            info
          );
        });
        optionsClient.on('auth_recovered', (info) => {
          this._schwabAlertLastAt.clear();
          this._publishSchwabAlert(
            'schwab_auth_recovered', 'info',
            `Schwab auth recovered after ${info.consecutiveFailures} failed refresh attempt(s) — GEX/IV/exposure data flowing again.`,
            info, { throttleMs: 0 }
          );
        });
      }

      if (config.TRADIER_AUTO_START) {
        await this.tradierExposureService.start();
        logger.info('Tradier Exposure Service initialized and started');
      } else {
        logger.info('Tradier Exposure Service initialized (manual start)');
      }

      // Cache IV skew calculator reference
      if (this.tradierExposureService.ivSkewCalculator) {
        this.ivSkewCalculator = this.tradierExposureService.ivSkewCalculator;
        logger.info('IV Skew calculator available');
      }

      // Wire up short-DTE IV calculator (0-2 DTE for short-dte-iv strategy)
      this.shortDTEIVCalculator = new ShortDTEIVCalculator();
      this.tradierExposureService.shortDTEIVCalculator = this.shortDTEIVCalculator;
      this.shortDTEIVCalculator.startPreBoundaryTimer();
      logger.info('Short-DTE IV calculator wired to exposure service (pre-boundary timer active)');
    } catch (error) {
      logger.error('Failed to initialize Tradier service:', error.message);
      this.tradierExposureService = null;
    }
  }

  /**
   * Initialize LT Monitors for NQ and ES
   */
  async initializeLtMonitors(jwtToken, redisUrl) {
    const ltConfigs = [
      { key: 'NQ', symbol: config.LT_NQ_SYMBOL, timeframe: config.LT_NQ_TIMEFRAME },
      // [2026-05-20] ES LT monitor disabled — no live strategies trade ES.
      // Running a second LT WebSocket roughly doubled TV reconnect rate
      // (Code 1000 closes ~30-60s) and every reconnect on an expired JWT
      // caused a phantom bar-close LS flip on the OTHER product. To
      // re-enable: uncomment + verify token-refresh wiring is healthy first.
      // { key: 'ES', symbol: config.LT_ES_SYMBOL, timeframe: config.LT_ES_TIMEFRAME }
    ];

    for (const ltConfig of ltConfigs) {
      try {
        logger.info(`Initializing LT monitor for ${ltConfig.key} (${ltConfig.symbol} ${ltConfig.timeframe}m)...`);
        const monitor = new LTMonitor({
          symbol: ltConfig.symbol,
          timeframe: ltConfig.timeframe,
          jwtToken,
          redisUrl
        });

        // Wire up token refresh from main client
        this.tradingViewClient.on('token_refreshed', (newToken) => {
          monitor.updateToken(newToken).catch(err => {
            logger.error(`LT monitor ${ltConfig.key} token update failed:`, err.message);
          });
        });

        // Set up LT event listener
        monitor.on('lt_levels', (ltLevels) => this.handleLtUpdate(ltConfig.key, ltLevels));

        // Set up LS sentiment listener
        monitor.on('ls_status', (lsStatus) => this.handleLsUpdate(ltConfig.key, lsStatus));

        await monitor.connect();
        await monitor.startMonitoring();
        this.ltMonitors.set(ltConfig.key, monitor);
        logger.info(`LT monitor for ${ltConfig.key} started`);
      } catch (error) {
        logger.error(`Failed to start LT monitor for ${ltConfig.key}:`, error.message);
      }
    }
  }

  /**
   * Create 1h and 1D history (and seed 1m) for each OHLCV symbol via Schwab's
   * pricehistory REST endpoint. Called on startup and after Schwab streamer
   * reconnection.
   */
  // ─────────────────────── Schwab single-instance guard ───────────────────────

  async _getLockRedis(redisUrl) {
    if (this._lockRedis) return this._lockRedis;
    try {
      const Redis = (await import('ioredis')).default;
      const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
      await client.connect();
      this._lockRedis = client;
      return client;
    } catch (err) {
      logger.warn(`[SCHWAB-LOCK] redis unavailable (${err.message}) — proceeding WITHOUT lock`);
      return null;
    }
  }

  // Try to acquire/hold the streamer lock. Returns true if we own it. Fail-OPEN:
  // if Redis is unreachable we return true so the (normal) single instance still
  // streams — the lock only needs to work when Redis is up, which is exactly when
  // a deploy overlap happens.
  async _acquireSchwabLock(redisUrl) {
    const redis = await this._getLockRedis(redisUrl);
    if (!redis) return true;
    try {
      const res = await redis.set(SCHWAB_LOCK_KEY, INSTANCE_ID, 'NX', 'PX', SCHWAB_LOCK_TTL_MS);
      if (res === 'OK') return true;
      // Already held — is it us (restart reusing the same pod name)?
      const owner = await redis.get(SCHWAB_LOCK_KEY);
      return owner === INSTANCE_ID;
    } catch (err) {
      logger.warn(`[SCHWAB-LOCK] acquire failed (${err.message}) — proceeding WITHOUT lock`);
      return true;
    }
  }

  // Decide ownership, then either start streaming (+renew) or stand by.
  async _startSchwabStreamingGuarded(redisUrl) {
    const owns = await this._acquireSchwabLock(redisUrl);
    if (owns) {
      logger.info(`[SCHWAB-LOCK] ${INSTANCE_ID} owns the Schwab streamer — starting`);
      await this._startSchwabStreaming();
      this._startSchwabLockRenew(redisUrl);
    } else {
      logger.warn(`[SCHWAB-LOCK] Schwab streamer owned by another data-service instance — standing by (not streaming).`);
      messageBus.publish(CHANNELS.STRATEGY_ALERT, {
        severity: 'warning',
        source: 'data-service',
        type: 'schwab_standby',
        message: `A second data-service instance (${INSTANCE_ID}) started and is standing by — the Schwab streamer is owned by another instance. Expected briefly during a deploy; investigate if it persists (two long-lived pods).`,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      this._startSchwabStandbyLoop(redisUrl);
    }
  }

  // The actual connect/subscribe/seed. NON-FATAL — an expired token logs and
  // leaves the streamer in place so updateSchwabToken() can retry.
  async _startSchwabStreaming() {
    try {
      logger.info('Connecting to Schwab streamer...');
      await this.schwabStreamer.connect();
      logger.info('Schwab streamer connected, starting subscriptions...');
      await this.schwabStreamer.startStreaming();
      logger.info('Schwab streaming started');
      await this.createHistorySessions();
    } catch (err) {
      logger.error(`Schwab streamer init failed (continuing without quotes): ${err.message}`);
      logger.error('→ Re-authenticate Schwab via the dashboard "Set Token" button to recover.');
    }
  }

  _startSchwabLockRenew(redisUrl) {
    if (this._lockRenewTimer) clearInterval(this._lockRenewTimer);
    this._lockRenewTimer = setInterval(async () => {
      const redis = await this._getLockRedis(redisUrl);
      if (!redis) return; // no lock backend; nothing to renew
      try {
        const owner = await redis.get(SCHWAB_LOCK_KEY);
        if (owner === INSTANCE_ID || owner === null) {
          await redis.set(SCHWAB_LOCK_KEY, INSTANCE_ID, 'PX', SCHWAB_LOCK_TTL_MS);
        } else {
          // We lost ownership (our lease lapsed and another instance took over).
          // Stop streaming to avoid two live sessions, and fall back to standby.
          logger.error(`[SCHWAB-LOCK] lost ownership to ${owner} — stopping streamer, standing by`);
          clearInterval(this._lockRenewTimer); this._lockRenewTimer = null;
          try { await this.schwabStreamer.disconnect(); } catch {}
          this.schwabStreamer.isDisconnecting = false; // allow standby to reconnect later
          this._startSchwabStandbyLoop(redisUrl);
        }
      } catch (err) {
        logger.warn(`[SCHWAB-LOCK] renew failed (${err.message})`);
      }
    }, SCHWAB_LOCK_RENEW_MS);
    this._lockRenewTimer.unref?.();
  }

  _startSchwabStandbyLoop(redisUrl) {
    if (this._lockStandbyTimer) clearInterval(this._lockStandbyTimer);
    this._lockStandbyTimer = setInterval(async () => {
      const owns = await this._acquireSchwabLock(redisUrl);
      if (owns) {
        clearInterval(this._lockStandbyTimer); this._lockStandbyTimer = null;
        logger.warn(`[SCHWAB-LOCK] previous owner gone — ${INSTANCE_ID} taking over the Schwab streamer`);
        await this._startSchwabStreaming();
        this._startSchwabLockRenew(redisUrl);
      }
    }, SCHWAB_LOCK_RETRY_MS);
    this._lockStandbyTimer.unref?.();
  }

  async _releaseSchwabLock() {
    if (this._lockRenewTimer) { clearInterval(this._lockRenewTimer); this._lockRenewTimer = null; }
    if (this._lockStandbyTimer) { clearInterval(this._lockStandbyTimer); this._lockStandbyTimer = null; }
    try {
      if (this._lockRedis) {
        const owner = await this._lockRedis.get(SCHWAB_LOCK_KEY);
        if (owner === INSTANCE_ID) await this._lockRedis.del(SCHWAB_LOCK_KEY);
        this._lockRedis.disconnect();
        this._lockRedis = null;
      }
    } catch (err) {
      logger.warn(`[SCHWAB-LOCK] release failed (${err.message})`);
    }
  }

  async createHistorySessions() {
    if (!this.schwabStreamer) return;
    this._lastHistoryReseedAt = Date.now(); // for the reconnect re-seed debounce
    const schwabFutureSymbols = config.OHLCV_SYMBOLS.map(tvSymbolToSchwabFuture).filter(Boolean);
    for (const sym of schwabFutureSymbols) {
      try {
        await this.schwabStreamer.createHistorySession(sym, '1', 500);
        logger.info(`Created 1m history session for ${sym}`);
      } catch (error) {
        logger.error(`Failed to create 1m history session for ${sym}: ${error.message}`);
      }
      try {
        await this.schwabStreamer.createHistorySession(sym, '60', 300);
        logger.info(`Created 1h history session for ${sym}`);
      } catch (error) {
        logger.error(`Failed to create 1h history session for ${sym}: ${error.message}`);
      }
      try {
        await this.schwabStreamer.createHistorySession(sym, '1D', 10);
        logger.info(`Created 1D history session for ${sym}`);
      } catch (error) {
        logger.error(`Failed to create 1D history session for ${sym}: ${error.message}`);
      }
    }
  }

  /**
   * Handle incoming TradingView quote
   */
  async handleQuoteUpdate(quote) {
    try {
      // Track quote counts for logging
      this.quoteCount = (this.quoteCount || 0) + 1;
      if (this.quoteCount % 100 === 0 || !this.lastQuoteLogTime || Date.now() - this.lastQuoteLogTime > 30000) {
        logger.info(`Processed ${this.quoteCount} quotes | Latest: ${quote.baseSymbol} = ${quote.close}`);
        this.lastQuoteLogTime = Date.now();
      }

      // Feed to candle manager for close detection (only candle data)
      if (quote.candleTimestamp) {
        await this.candleManager.processQuote(quote);
      }

      // Publish price.update to Redis for all consumers
      await messageBus.publish(CHANNELS.PRICE_UPDATE, {
        symbol: quote.symbol,
        baseSymbol: quote.baseSymbol,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        volume: quote.volume,
        timestamp: quote.timestamp,
        source: quote.source,
        candleTimestamp: quote.candleTimestamp,
        sessionOpen: quote.sessionOpen,
        sessionHigh: quote.sessionHigh,
        sessionLow: quote.sessionLow,
        prevClose: quote.prevClose,
        change: quote.change,
        changePercent: quote.changePercent
      });

    } catch (error) {
      logger.error('Error handling quote update:', error);
    }
  }

  /**
   * Handle LT level update from a monitor
   */
  async handleLtUpdate(product, ltLevels) {
    try {
      logger.info(`LT levels updated for ${product}: ${JSON.stringify(ltLevels)}`);

      // Publish with product identifier
      await messageBus.publish(CHANNELS.LT_LEVELS, {
        ...ltLevels,
        product
      });

    } catch (error) {
      logger.error(`Error handling LT update for ${product}:`, error);
    }
  }

  /**
   * Handle LS sentiment update from a monitor
   */
  async handleLsUpdate(product, lsStatus) {
    try {
      logger.info(`LS sentiment for ${product}: ${lsStatus.sentiment}`);
      await messageBus.publish(CHANNELS.LS_STATUS, { ...lsStatus, product });
    } catch (error) {
      logger.error(`Error handling LS update for ${product}:`, error);
    }
  }

  /**
   * Schedule GEX refresh at configured time
   */
  scheduleGexRefresh() {
    setInterval(async () => {
      try {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const [targetHour, targetMinute] = config.GEX_FETCH_TIME.split(':').map(Number);

        if (hour === targetHour && minute === targetMinute) {
          for (const [product, calculator] of this.gexCalculators) {
            try {
              logger.info(`Refreshing GEX levels for ${product} at scheduled time...`);
              const levels = await calculator.calculateLevels(true);
              await messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product });
              logger.info(`GEX levels for ${product} published`);
            } catch (err) {
              logger.error(`GEX refresh for ${product} failed:`, err.message);
            }
          }
        }
      } catch (error) {
        logger.error('Error in GEX refresh schedule:', error);
      }
    }, 60000);
  }

  /**
   * Schedule forced GEX + IV/exposure refresh shortly after RTH open (09:30 ET).
   * Pre-market GEX/IV uses stale QQQ quotes (previous close); this ensures
   * fresh calculations run once the options chain is actively quoting.
   */
  scheduleRTHOpenRefresh() {
    let lastRTHRefreshDate = null;

    setInterval(async () => {
      try {
        const now = new Date();
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

        const day = et.getDay();
        if (day === 0 || day === 6) return; // Skip weekends

        const hour = et.getHours();
        const minute = et.getMinutes();
        const second = et.getSeconds();
        const timeInSeconds = hour * 3600 + minute * 60 + second;

        // Target window: 09:30:30 to 09:31:30 ET (gives options chain ~30s to start quoting)
        const windowStart = 9 * 3600 + 30 * 60 + 30;  // 09:30:30
        const windowEnd   = 9 * 3600 + 31 * 60 + 30;  // 09:31:30
        if (timeInSeconds < windowStart || timeInSeconds >= windowEnd) return;

        // Only fire once per calendar date
        const todayStr = et.toDateString();
        if (lastRTHRefreshDate === todayStr) return;
        lastRTHRefreshDate = todayStr;

        logger.info('RTH open detected — forcing GEX + IV/exposure refresh with live quotes...');

        // Force GEX refresh for all products
        for (const [product, calculator] of this.gexCalculators) {
          try {
            const levels = await calculator.calculateLevels(true);
            if (levels) {
              await messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product });
              logger.info(`RTH refresh: GEX for ${product} published`);
            }
          } catch (err) {
            logger.error(`RTH refresh: GEX for ${product} failed:`, err.message);
          }
        }

        // Force Tradier exposure + IV skew refresh (clears chain cache, re-fetches live data)
        if (this.tradierExposureService) {
          try {
            await this.tradierExposureService.forceRefresh();
            logger.info('RTH refresh: Tradier exposure + IV skew completed');
          } catch (err) {
            logger.error('RTH refresh: Tradier exposure failed:', err.message);
          }
        }

        logger.info('RTH open refresh cycle complete');
      } catch (error) {
        logger.error('Error in RTH open refresh:', error);
      }
    }, 30000); // Check every 30 seconds
  }

  // === Public API methods (called by HTTP routes) ===

  /**
   * Get GEX levels for a product
   * @param {string} product - 'NQ' or 'ES'
   */
  getGexLevels(product = 'NQ') {
    const calculator = this.gexCalculators.get(product.toUpperCase());
    return calculator?.getCurrentLevels() || null;
  }

  /**
   * Force GEX refresh for a product
   * @param {string} product - 'NQ' or 'ES'
   */
  async refreshGexLevels(product = 'NQ') {
    const key = product.toUpperCase();
    const calculator = this.gexCalculators.get(key);
    if (!calculator) throw new Error(`No GEX calculator for ${key}`);

    const levels = await calculator.calculateLevels(true);
    await messageBus.publish(CHANNELS.GEX_LEVELS, { ...levels, product: key });
    return levels;
  }

  /**
   * Get candle history
   */
  getCandles(symbol, count) {
    return this.candleManager.getCandles(symbol.toUpperCase(), count);
  }

  /**
   * Get hourly candle history
   */
  getHourlyCandles(symbol, count) {
    return this.candleManager.getHourlyCandles(symbol.toUpperCase(), count);
  }

  /**
   * Get daily candle history
   */
  getDailyCandles(symbol, count) {
    return this.candleManager.getDailyCandles(symbol.toUpperCase(), count);
  }

  /**
   * Get IV skew data
   */
  getIVSkew() {
    return this.ivSkewCalculator?.getCurrentIVSkew() || null;
  }

  /**
   * Get IV skew history
   */
  getIVHistory() {
    return this.ivSkewCalculator?.getSkewHistory() || [];
  }

  /**
   * Get exposure levels from Tradier
   */
  getExposureLevels() {
    return this.tradierExposureService?.getCurrentExposures() || null;
  }

  /**
   * Force Tradier exposure refresh
   */
  async refreshExposure() {
    if (!this.tradierExposureService) throw new Error('Tradier service not available');
    return await this.tradierExposureService.forceRefresh();
  }

  /**
   * Get VEX levels
   */
  getVexLevels() {
    const exposures = this.tradierExposureService?.getCurrentExposures();
    if (!exposures?.futures) return null;

    const vexData = {};
    for (const [symbol, data] of Object.entries(exposures.futures)) {
      vexData[symbol] = {
        symbol,
        timestamp: exposures.timestamp,
        futuresPrice: data.futuresPrice,
        totalVex: data.totals.vex,
        regime: data.regime.vex,
        levels: data.levels
      };
    }
    return vexData;
  }

  /**
   * Get CEX levels
   */
  getCexLevels() {
    const exposures = this.tradierExposureService?.getCurrentExposures();
    if (!exposures?.futures) return null;

    const cexData = {};
    for (const [symbol, data] of Object.entries(exposures.futures)) {
      cexData[symbol] = {
        symbol,
        timestamp: exposures.timestamp,
        futuresPrice: data.futuresPrice,
        totalCex: data.totals.cex,
        regime: data.regime.cex,
        levels: data.levels
      };
    }
    return cexData;
  }

  /**
   * Get LT levels for a product
   */
  getLtLevels(product = 'NQ') {
    const monitor = this.ltMonitors.get(product.toUpperCase());
    return monitor?.getCurrentLevels() || null;
  }

  /**
   * Get LS sentiment for a product
   */
  getLsSentiment(product = 'NQ') {
    const monitor = this.ltMonitors.get(product.toUpperCase());
    return monitor?.getCurrentLsSentiment() || null;
  }

  /**
   * Get Tradier service status
   */
  getTradierStatus() {
    const health = this.tradierExposureService?.getHealthStatus() || null;
    const wsStatus = health?.websocket?.status || 'initializing';
    const statusMap = {
      'connected': 'Active',
      'market_closed': 'Market Closed',
      'disconnected': 'Disconnected',
      'reconnecting': 'Reconnecting',
      'initializing': 'Initializing'
    };

    return {
      available: !!this.tradierExposureService,
      active: !!this.tradierExposureService?.isRunning,
      initialized: this.tradierExposureService?.isInitialized || false,
      running: this.tradierExposureService?.isRunning || false,
      health,
      displayStatus: statusMap[wsStatus] || wsStatus,
      websocketStatus: wsStatus,
      config: {
        enabled: config.TRADIER_ENABLED,
        autoStart: config.TRADIER_AUTO_START,
        hasToken: !!config.TRADIER_ACCESS_TOKEN
      }
    };
  }

  /**
   * Enable Tradier service manually
   */
  async enableTradier() {
    if (!this.tradierExposureService) {
      throw new Error('Tradier service not configured');
    }
    if (!this.tradierExposureService.isInitialized) {
      await this.tradierExposureService.initialize();
    }
    await this.tradierExposureService.start();
    return { success: true, message: 'Tradier service enabled' };
  }

  /**
   * Disable Tradier service manually
   */
  async disableTradier() {
    if (!this.tradierExposureService) {
      return { success: true, message: 'Tradier service not available' };
    }
    await this.tradierExposureService.stop();
    return { success: true, message: 'Tradier service disabled' };
  }

  /**
   * Update TradingView JWT token
   */
  async updateTradingViewToken(token) {
    const redisUrl = config.getRedisUrl();

    await cacheTokenInRedis(redisUrl, token);
    logger.info('Manual token cached in Redis');

    // [2026-05-22] OHLCV/quotes now flow via Schwab streamer; TradingViewClient's
    // WS is no longer opened by this service. We still update its `jwtToken`
    // field so any status reporting that reads from it stays current, but
    // we do NOT call reconnectWithNewToken() — that would re-open the WS
    // we explicitly migrated away from.
    if (this.tradingViewClient) {
      this.tradingViewClient.jwtToken = token;
      this.tradingViewClient.tokenRefreshRetryCount = 0;
      this.tradingViewClient.stopTokenRefreshSchedule?.();
      // INTENTIONALLY NOT calling reconnectWithNewToken() — see comment above.
    }

    // Update all LT monitors (this is the only path that still needs a TV JWT).
    for (const [product, monitor] of this.ltMonitors) {
      try {
        await monitor.updateToken(token);
        logger.info(`LT monitor ${product} updated with new token`);
      } catch (err) {
        logger.error(`LT monitor ${product} token update failed:`, err.message);
      }
    }

    const ttl = getTokenTTL(token);
    return {
      success: true,
      message: 'Token updated and connections reconnected',
      tokenTTL: ttl,
      authState: this.tradingViewClient?.authState || 'unknown'
    };
  }

  /**
   * Bootstrap TradingView session from a cookie string (Option A).
   *
   * Caller (dashboard input) pastes the cookies from a separate TV browser
   * session — e.g., an incognito window logged in just for this purpose, NOT
   * the user's daily-driver tab (TV pins one JWT per sessionid, so reusing the
   * daily tab's sessionid would make the data-service kick that tab off the WS).
   *
   * On success: cookies cached in Redis with 7-day TTL, JWT extracted &
   * propagated through the same updateTradingViewToken flow used by the manual
   * "Set Token" button. The scheduled refresh (see scheduleSessionRefresh)
   * will subsequently re-extract a fresh JWT every refreshIntervalMs.
   */
  async bootstrapTradingViewSession(cookieStr) {
    const redisUrl = config.getRedisUrl();
    const cookies = parseCookieString(cookieStr);
    if (!cookies.sessionid) {
      throw new Error('No sessionid found in pasted cookies. Open TV in an incognito window, log in, then copy the sessionid cookie (and ideally sessionid_sign too).');
    }
    logger.info(`Bootstrapping TV session from pasted cookies (${Object.keys(cookies).join(', ')})`);

    // Validate cookies by extracting a JWT — also picks up any refreshed cookies
    const { jwt, cookies: refreshedCookies } = await extractJwtFromPage(cookies);
    if (!jwt) {
      throw new Error('Pasted sessionid did not yield a JWT — the session may already be expired or invalid. Re-login in incognito and copy a fresh sessionid.');
    }
    const ttl = getTokenTTL(jwt);
    if (ttl !== null && ttl <= 0) {
      throw new Error('Pasted sessionid yielded an already-expired JWT.');
    }

    await cacheSessionCookies(redisUrl, refreshedCookies);
    logger.info(`TV session cookies cached (sessionid len=${refreshedCookies.sessionid.length}, JWT TTL=${Math.floor(ttl / 60)}m). Routing JWT to clients...`);

    // Push the JWT through the existing manual-update path so the WS reconnects
    // and LT monitors pick it up. This is exactly what the dashboard "Set Token"
    // button does, just with a server-extracted JWT.
    const updateResult = await this.updateTradingViewToken(jwt);
    return {
      success: true,
      message: 'Session bootstrapped — scheduled refresh will keep JWT alive.',
      tokenTTL: ttl,
      cookieNames: Object.keys(refreshedCookies),
      ...updateResult,
    };
  }

  /**
   * Schedule periodic JWT refresh from the cached sessionid (Option A).
   * Runs every TV_AUTO_REFRESH_INTERVAL_MS (default 90 min). No-op if no
   * sessionid is cached yet.
   */
  scheduleSessionRefresh() {
    const intervalMs = parseInt(process.env.TV_AUTO_REFRESH_INTERVAL_MS || `${90 * 60 * 1000}`, 10);
    if (this._sessionRefreshInterval) clearInterval(this._sessionRefreshInterval);
    logger.info(`Scheduling TV JWT auto-refresh every ${Math.floor(intervalMs / 60000)} min (from cached sessionid)`);

    const tick = async () => {
      const redisUrl = config.getRedisUrl();
      try {
        const cookies = await getCachedSessionCookies(redisUrl);
        if (!cookies || !cookies.sessionid) {
          logger.debug('TV auto-refresh: no cached sessionid, skipping');
          return;
        }
        const currentTTL = getTokenTTL(this.tradingViewClient?.jwtToken);
        // Skip if we already have a healthy JWT (TTL > 4h) — no point refreshing
        if (currentTTL != null && currentTTL > 4 * 3600) {
          logger.debug(`TV auto-refresh: JWT still healthy (TTL ${Math.floor(currentTTL / 60)}m), skipping`);
          return;
        }
        logger.info(`TV auto-refresh: attempting JWT refresh from cached session (current TTL: ${currentTTL != null ? Math.floor(currentTTL / 60) + 'm' : 'n/a'})`);
        const newJwt = await refreshJwtFromSession(redisUrl);
        if (!newJwt) {
          logger.warn('TV auto-refresh: no JWT returned — sessionid may have expired. Re-bootstrap via /tv-auth/sessionid.');
          return;
        }
        await this.updateTradingViewToken(newJwt);
        logger.info(`TV auto-refresh: JWT refreshed, new TTL ${Math.floor(getTokenTTL(newJwt) / 60)}m`);
      } catch (err) {
        logger.error('TV auto-refresh failed:', err.message);
      }
    };

    this._sessionRefreshInterval = setInterval(tick, intervalMs);
    // Kick off one immediately on schedule install — common case: service just
    // started, cached cookies exist but no JWT was extracted yet.
    setTimeout(tick, 5_000);
  }

  /**
   * Exchange Schwab authorization code for tokens, store in Redis, and reinitialize the service
   */
  async updateSchwabToken(authorizationCode) {
    const redisUrl = config.getRedisUrl();
    const appKey = config.SCHWAB_APP_KEY;
    const appSecret = config.SCHWAB_APP_SECRET;
    const callbackUrl = config.SCHWAB_CALLBACK_URL || 'https://127.0.0.1:8182';

    if (!appKey || !appSecret) {
      throw new Error('SCHWAB_APP_KEY and SCHWAB_APP_SECRET must be configured');
    }

    // Exchange authorization code for access + refresh tokens
    const axios = (await import('axios')).default;
    const basicAuth = Buffer.from(`${appKey}:${appSecret}`).toString('base64');

    logger.info('Exchanging Schwab authorization code for tokens...');
    const tokenResponse = await axios.post('https://api.schwabapi.com/v1/oauth/token',
      `grant_type=authorization_code&code=${encodeURIComponent(authorizationCode)}&redirect_uri=${encodeURIComponent(callbackUrl)}`,
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000,
        decompress: true
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;
    if (!refresh_token) {
      throw new Error('No refresh token in Schwab response');
    }

    logger.info('Schwab authorization code exchanged successfully');

    // Store tokens in Redis (same key/format as SchwabClient)
    const Redis = (await import('ioredis')).default;
    let redis;
    try {
      redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
      await redis.connect();

      const tokenData = {
        access_token,
        refresh_token,
        token_type: 'Bearer',
        obtained_at: new Date().toISOString()
      };
      await redis.set('schwab:tokens', JSON.stringify(tokenData));
      logger.info('Schwab tokens stored in Redis');
    } finally {
      try { redis?.disconnect(); } catch {}
    }

    // Stop existing service if running
    if (this.tradierExposureService) {
      try {
        await this.tradierExposureService.stop();
      } catch (err) {
        logger.warn('Error stopping existing Schwab service:', err.message);
      }
      this.tradierExposureService = null;
    }

    // Reinitialize — this will pick up the new tokens from Redis
    await this.initializeTradierService();

    // Reinitialize hybrid GEX calculators to use the new Schwab service
    if (this.tradierExposureService) {
      await this.initializeGexCalculators();
    }

    // [2026-05-22] Also (re)start the Schwab streamer for OHLCV/quotes if it
    // failed at startup due to expired tokens. With fresh tokens in Redis it
    // should connect cleanly now.
    let streamerOk = this.schwabStreamer?.isConnected() ?? false;
    if (this.schwabStreamer && !streamerOk) {
      try {
        logger.info('Retrying Schwab streamer with fresh tokens...');
        await this.schwabStreamer.connect();
        await this.schwabStreamer.startStreaming();
        await this.createHistorySessions();
        streamerOk = true;
        logger.info('✅ Schwab streamer up after token refresh');
      } catch (err) {
        logger.error(`Schwab streamer retry failed: ${err.message}`);
      }
    }

    const running = this.tradierExposureService?.isRunning || false;
    return {
      success: true,
      message: running
        ? `Schwab authenticated and services restarted (streamer: ${streamerOk ? 'up' : 'down'})`
        : 'Tokens stored but service failed to start — check logs',
      running,
      streamerConnected: streamerOk,
    };
  }

  /**
   * Health check
   */
  getHealth() {
    const gexStatus = {};
    for (const [key, calc] of this.gexCalculators) {
      gexStatus[key] = calc.getCurrentLevels() ? 'ready' : 'no_data';
    }

    const ltStatus = {};
    for (const [key, monitor] of this.ltMonitors) {
      ltStatus[key] = monitor.isConnected() ? 'connected' : 'disconnected';
    }

    return {
      service: config.SERVICE_NAME,
      status: this.isRunning ? 'running' : 'stopped',
      timestamp: new Date().toISOString(),
      components: {
        // [2026-05-22] OHLCV/quotes now flow through Schwab streamer.
        // 'tradingview' status reflects the (now unused) WS client's state
        // for back-compat with the dashboard; expect 'disconnected'.
        schwab_streamer: this.schwabStreamer?.isConnected() ? 'connected' : 'disconnected',
        tradingview: this.tradingViewClient?.isConnected() ? 'connected' : 'disconnected',
        gex: gexStatus,
        lt: ltStatus,
        tradier: this.tradierExposureService
          ? (this.tradierExposureService.isRunning ? 'running' : 'available')
          : 'not_configured',
        iv_skew: this.ivSkewCalculator ? 'ready' : 'not_available'
      },
      connectionDetails: {
        schwabStreamer: {
          connected: this.schwabStreamer?.isConnected() || false,
          futureSymbols: this.schwabStreamer?.futureSymbols || [],
          equitySymbols: this.schwabStreamer?.equitySymbols || [],
          reconnectAttempts: this.schwabStreamer?.reconnectAttempts || 0,
        },
        tradingview: {
          connected: this.tradingViewClient?.isConnected() || false,
          authState: this.tradingViewClient?.authState || 'unknown',
          tokenTTL: this.tradingViewClient?.jwtToken ? getTokenTTL(this.tradingViewClient.jwtToken) : null,
          lastHeartbeat: this.tradingViewClient?.lastHeartbeat?.toISOString() || null,
          lastQuoteReceived: this.tradingViewClient?.lastQuoteReceived?.toISOString() || null,
          reconnectAttempts: this.tradingViewClient?.reconnectAttempts || 0
        },
        ltMonitors: Object.fromEntries(
          Array.from(this.ltMonitors.entries()).map(([key, m]) => [key, {
            connected: m.isConnected() || false,
            hasLevels: !!m.currentLevels,
            lastHeartbeat: m.lastHeartbeat?.toISOString() || null,
            reconnectAttempts: m.reconnectAttempts || 0
          }])
        ),
        hybridGex: Object.fromEntries(
          Array.from(this.hybridGexCalculators.entries()).map(([key, h]) => [key,
            typeof h.getHealthStatus === 'function' ? h.getHealthStatus() : null
          ])
        )
      },
      candles: this.candleManager.getStats(),
      tradier: this.getTradierStatus()
    };
  }

  async stop() {
    try {
      logger.info('Stopping Data Service...');
      this.isRunning = false;

      // Release the streamer lock first so a standby instance can take over
      // immediately instead of waiting out the lease.
      await this._releaseSchwabLock();

      if (this.schwabStreamer) {
        await this.schwabStreamer.disconnect();
      }

      if (this.tradingViewClient) {
        this.tradingViewClient.disconnect();
      }

      for (const [key, monitor] of this.ltMonitors) {
        await monitor.disconnect();
      }

      if (this.tradierExposureService) {
        await this.tradierExposureService.stop();
      }

      if (this.shortDTEIVCalculator) {
        this.shortDTEIVCalculator.stopPreBoundaryTimer();
      }

      logger.info('Data Service stopped');
    } catch (error) {
      logger.error('Error stopping Data Service:', error);
    }
  }
}

// Create and export singleton
const service = new DataService();

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await service.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  await service.stop();
  process.exit(0);
});

export default service;
