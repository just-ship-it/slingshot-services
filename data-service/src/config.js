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
// const esContract = process.env.ES_CONTRACT || 'ESH6';      // [2026-05-20] disabled — no ES strategies
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
// const tvES = toTradingViewSymbol(esContract);     // [2026-05-20] disabled
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
  QUOTE_ONLY_SYMBOLS: (process.env.QUOTE_ONLY_SYMBOLS || additionalQuoteSymbols).split(','),

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
