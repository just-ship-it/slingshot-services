// Configuration management for Data Service
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from shared .env
const sharedEnvPath = join(__dirname, '../../shared/.env');
const localEnvPath = join(__dirname, '../.env');

if (fs.existsSync(sharedEnvPath)) {
  dotenv.config({ path: sharedEnvPath });
} else if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}

// Derive TradingView symbols from contract env vars (update *_CONTRACT for quarterly rollover)
const nqContract = process.env.NQ_CONTRACT || 'NQH6';
// const mnqContract = process.env.MNQ_CONTRACT || 'MNQH6';   // [2026-05-20] disabled — micro prices match NQ
// const mesContract = process.env.MES_CONTRACT || 'MESH6';   // [2026-05-20] disabled — micro prices match ES (also disabled)

// Quote symbols kept on the feed:
//   QQQ — required for NQ GEX calculator (live underlying price for options chain)
// Quote symbols disabled (re-enable by appending to ADDITIONAL_QUOTE_SYMBOLS):
//   AMEX:SPY (only used for ES GEX which is disabled)
//   BITSTAMP:BTCUSD (no consumers)
const additionalQuoteSymbols = process.env.ADDITIONAL_QUOTE_SYMBOLS || 'NASDAQ:QQQ';

// TradingView uses full-year format (e.g., NQM2026) instead of short (NQM6)
// Expand single-digit year to full year: H6 → H2026, M6 → M2026, etc.
function toTradingViewSymbol(contract) {
  return contract.replace(/(\d)$/, (_, d) => `202${d}`);
}
const tvNQ = toTradingViewSymbol(nqContract);
// const tvMNQ = toTradingViewSymbol(mnqContract);   // [2026-05-20] disabled
// const tvMES = toTradingViewSymbol(mesContract);   // [2026-05-20] disabled

const config = {
  // Redis Configuration
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379'),

  // TradingView Configuration
  TRADINGVIEW_CREDENTIALS: process.env.TRADINGVIEW_CREDENTIALS || '',
  TRADINGVIEW_JWT_TOKEN: process.env.TRADINGVIEW_JWT_TOKEN || '',

  // Chart symbols (get full OHLCV chart sessions - needed for candle buffers).
  // [2026-05-20] ES chart session removed — no live strategies consume it,
  // and it was contributing to TradingView WebSocket churn (separate LT
  // monitors disconnect/reconnect cycles caused phantom LS flip emissions).
  OHLCV_SYMBOLS: (process.env.OHLCV_SYMBOLS || `CME_MINI:${tvNQ}`).split(','),

  // Quote-only symbols (just last price, no chart session).
  // [2026-05-20] MNQ/MES quotes removed — prices match NQ/ES within 0.1%,
  // tradovate is the authoritative source for traded contract pricing.
  // QQQ remains (NQ GEX needs live underlying for options chain pricing).
  // [2026-08-21] QQQ existed solely so NQ GEX could price its options chain from a
  // live underlying. GEX is retired, so the default is now empty unless GEX is on.
  // This is also the last material protocol difference vs the stable lt-monitor
  // socket, which subscribes no quote-only symbols: an equity on a futures quote
  // session is a plausible trigger for TV's ~65-75s session cap. Empties are
  // filtered so QUOTE_ONLY_SYMBOLS='' means none, not [''].
  QUOTE_ONLY_SYMBOLS: (process.env.QUOTE_ONLY_SYMBOLS
    ?? (process.env.GEX_ENABLED?.toLowerCase() === 'true' ? additionalQuoteSymbols : '')
  ).split(',').map(x => x.trim()).filter(Boolean),

  // LT Monitor Configuration (per product) — derived from contract env vars
  LT_NQ_SYMBOL: process.env.LT_NQ_SYMBOL || `CME_MINI:${tvNQ}`,
  LT_NQ_TIMEFRAME: process.env.LT_NQ_TIMEFRAME || '1',
  // [2026-05-20] ES LT monitor disabled — re-enable by uncommenting in main.js
  // (config kept here in case someone re-enables the ES product later).
  LT_ES_SYMBOL: process.env.LT_ES_SYMBOL || `CME_MINI:NQM2026`,  // dummy fallback (unused)
  LT_ES_TIMEFRAME: process.env.LT_ES_TIMEFRAME || '1',

  // NQ GEX Configuration (from QQQ)
  NQ_GEX_SYMBOL: process.env.NQ_GEX_SYMBOL || 'QQQ',
  NQ_GEX_FUTURES_SYMBOL: process.env.NQ_GEX_FUTURES_SYMBOL || 'NQ',
  NQ_GEX_DEFAULT_MULTIPLIER: parseFloat(process.env.NQ_GEX_DEFAULT_MULTIPLIER || '41.5'),
  NQ_GEX_CACHE_FILE: process.env.NQ_GEX_CACHE_FILE || './data/gex_cache_nq.json',

  // ES GEX Configuration (from SPY)
  ES_GEX_SYMBOL: process.env.ES_GEX_SYMBOL || 'SPY',
  ES_GEX_FUTURES_SYMBOL: process.env.ES_GEX_FUTURES_SYMBOL || 'ES',
  ES_GEX_DEFAULT_MULTIPLIER: parseFloat(process.env.ES_GEX_DEFAULT_MULTIPLIER || '10.5'),
  ES_GEX_CACHE_FILE: process.env.ES_GEX_CACHE_FILE || './data/gex_cache_es.json',

  // GEX common settings
  GEX_FETCH_TIME: process.env.GEX_FETCH_TIME || '16:35',
  GEX_COOLDOWN_MINUTES: parseInt(process.env.GEX_COOLDOWN_MINUTES || '5'),

  // Schwab API Configuration (alternative to Tradier for options data)
  // ─── Market data source ────────────────────────────────────────────────────
  // [2026-08-20] Schwab's refresh token has a hard 7-day life and renewing it
  // requires an interactive browser login, so a Schwab-fed system needs a human
  // every week (schwab-client.js: `const remainDays = 7 - ageDays`). In the
  // 2026-07/08 shadow window that produced 304 auth-expired log lines and 11
  // disconnects on 07-27 alone. TradingView refreshes its JWT from cached
  // session cookies with no login and logged ZERO disconnects over the same
  // 14 days, while already carrying the LT monitors. Default is now TradingView.
  //   'tradingview' — OHLCV + quotes stream from TV (default)
  //   'schwab'      — legacy path, kept intact for instant rollback
  MARKET_DATA_SOURCE: (process.env.MARKET_DATA_SOURCE || 'tradingview').toLowerCase(),

  // [2026-08-20] Master switch for the options/GEX stack (GEX/VEX/CEX, CBOE
  // chains, short-DTE IV). Every strategy that consumed it is retired, and it is
  // the only remaining reason to hold a Schwab/Tradier options connection.
  // Code is left in place; this simply stops it running. Set 'true' to revive.
  GEX_ENABLED: process.env.GEX_ENABLED?.toLowerCase() === 'true',

  // [2026-08-20] LT monitors hold their own TradingView chart sessions for the
  // proprietary LT/LS Pine studies. No live strategy consumes lt.levels any more
  // (lt-candle-regime, gex-lt-3m-crossover and ls-flip-trigger-bar are all off;
  // PCC / monday-strength / gapup-fade declare candles-only). Off by default to
  // cut startup time and TV session pressure; code retained.
  // [2026-08-21] Which extra chart sessions to open on the persistent market-data
  // socket: 'both' (1h+1D) | '1h' | '1d' | 'none'. Diagnostic lever for the ~70s
  // TV session cut — every steady-state cut carries chartSessions=3, while
  // lt-monitor (1-2 sessions) survives indefinitely on the same account.
  // NOTE: 'none' starves preclose-continuation of its 10 daily ranges (no ATR ->
  // never trades), so it is a TEST setting, not a resting state.
  TV_HISTORY_SESSIONS: (process.env.TV_HISTORY_SESSIONS || 'both').toLowerCase(),

  // [2026-08-21] Route OHLCV through the LT monitor's TradingView socket instead of
  // tradingview-client's. Measured equivalent intra-bar resolution (du(sds_1) ~0.7-2.0/s
  // on both, one forming bar per message) on a socket that holds indefinitely, while
  // tradingview-client is cut by TV every 65-75s. Requires LT_MONITORS_ENABLED=true.
  LT_FEED_OHLCV: process.env.LT_EMIT_OHLCV?.toLowerCase() === 'true',

  LT_MONITORS_ENABLED: process.env.LT_MONITORS_ENABLED?.toLowerCase() === 'true',

  SCHWAB_ENABLED: process.env.SCHWAB_ENABLED?.toLowerCase() === 'true',
  SCHWAB_APP_KEY: process.env.SCHWAB_APP_KEY || '',
  SCHWAB_APP_SECRET: process.env.SCHWAB_APP_SECRET || '',
  SCHWAB_CALLBACK_URL: process.env.SCHWAB_CALLBACK_URL || 'https://127.0.0.1:8182',

  // Tradier API Configuration
  TRADIER_ACCESS_TOKEN: process.env.TRADIER_ACCESS_TOKEN || '',
  TRADIER_ACCOUNT_ID: process.env.TRADIER_ACCOUNT_ID || '',
  TRADIER_BASE_URL: process.env.TRADIER_BASE_URL || 'https://api.tradier.com/v1',
  TRADIER_ENABLED: process.env.TRADIER_ENABLED?.toLowerCase() === 'true',
  TRADIER_AUTO_START: process.env.TRADIER_AUTO_START?.toLowerCase() !== 'false',
  // [2026-05-20] SPY dropped from Tradier subscribe list — ES strategies
  // are disabled, so SPY options data has no consumers. Add SPY back to
  // this list (env: TRADIER_SYMBOLS=SPY,QQQ) if reviving ES.
  TRADIER_SYMBOLS: (process.env.TRADIER_SYMBOLS || 'QQQ').split(',').map(s => s.trim()),
  TRADIER_MAX_EXPIRATIONS: parseInt(process.env.TRADIER_MAX_EXPIRATIONS || '6'),

  // Options Flow Configuration
  RISK_FREE_RATE: parseFloat(process.env.RISK_FREE_RATE || '0.05'),
  EXPOSURE_POLL_INTERVAL_MINUTES: parseInt(process.env.EXPOSURE_POLL_INTERVAL_MINUTES || '2'),

  // [2026-08-25] Intraday refresh cadence for CBOE-ONLY mode. The hybrid path
  // drives updates from HybridGexCalculator's internal timers; the plain
  // GexCalculator has none, so without this gex.levels only moved twice a day.
  // CBOE regenerates its delayed_quotes file about every 60s (measured), so a
  // 5-minute pull is comfortably conservative.
  CBOE_REFRESH_MINUTES: parseInt(process.env.CBOE_REFRESH_MINUTES || '5'),

  // Hybrid GEX Configuration
  HYBRID_GEX_ENABLED: process.env.HYBRID_GEX_ENABLED === 'true',
  HYBRID_TRADIER_REFRESH_MINUTES: parseInt(process.env.HYBRID_TRADIER_REFRESH_MINUTES || '3'),
  HYBRID_CBOE_REFRESH_MINUTES: parseInt(process.env.HYBRID_CBOE_REFRESH_MINUTES || '15'),
  HYBRID_PREFER_TRADIER_WHEN_FRESH: process.env.HYBRID_PREFER_TRADIER_WHEN_FRESH !== 'false',
  HYBRID_TRADIER_FRESHNESS_MINUTES: parseInt(process.env.HYBRID_TRADIER_FRESHNESS_MINUTES || '5'),

  // GEX Thresholds (in billions)
  GEX_STRONG_POSITIVE_THRESHOLD: parseFloat(process.env.GEX_STRONG_POSITIVE_THRESHOLD || '5.0') * 1e9,
  GEX_POSITIVE_THRESHOLD: parseFloat(process.env.GEX_POSITIVE_THRESHOLD || '1.0') * 1e9,
  GEX_NEUTRAL_THRESHOLD: parseFloat(process.env.GEX_NEUTRAL_THRESHOLD || '-1.0') * 1e9,
  GEX_NEGATIVE_THRESHOLD: parseFloat(process.env.GEX_NEGATIVE_THRESHOLD || '-5.0') * 1e9,

  // Service Configuration
  HTTP_PORT: parseInt(process.env.PORT || process.env.HTTP_PORT || '3019'),
  LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
  SERVICE_NAME: process.env.SERVICE_NAME || 'data-service',

  // Helper methods
  getRedisUrl() {
    const password = process.env.REDIS_PASSWORD;
    const auth = password ? `:${password}@` : '';
    return `redis://${auth}${this.REDIS_HOST}:${this.REDIS_PORT}`;
  }
};

export default config;
