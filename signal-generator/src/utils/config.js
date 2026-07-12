// Configuration management for Signal Generator Service
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from shared .env if it exists
const sharedEnvPath = join(__dirname, '../../../shared/.env');
const localEnvPath = join(__dirname, '../../.env');

if (fs.existsSync(sharedEnvPath)) {
  dotenv.config({ path: sharedEnvPath });
} else if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}

// Derive TradingView symbols from contract env vars (update *_CONTRACT for quarterly rollover)
const nqContract = process.env.NQ_CONTRACT || 'NQH6';
const mnqContract = process.env.MNQ_CONTRACT || 'MNQH6';
const esContract = process.env.ES_CONTRACT || 'ESH6';
const mesContract = process.env.MES_CONTRACT || 'MESH6';
const additionalQuoteSymbols = process.env.ADDITIONAL_QUOTE_SYMBOLS || 'NASDAQ:QQQ,AMEX:SPY,BITSTAMP:BTCUSD';

// TradingView uses full-year format (e.g., NQM2026) instead of short (NQM6)
function toTradingViewSymbol(contract) {
  return contract.replace(/(\d)$/, (_, d) => `202${d}`);
}
const tvNQ = toTradingViewSymbol(nqContract);
const tvMNQ = toTradingViewSymbol(mnqContract);
const tvES = toTradingViewSymbol(esContract);
const tvMES = toTradingViewSymbol(mesContract);

const config = {
  // Redis Configuration
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379'),

  // Active Strategy Selection
  // Options: 'gex-scalp' (default), 'iv-skew-gex'
  ACTIVE_STRATEGY: process.env.ACTIVE_STRATEGY || 'gex-scalp',

  // TradingView Configuration
  TRADINGVIEW_CREDENTIALS: process.env.TRADINGVIEW_CREDENTIALS || '',
  TRADINGVIEW_JWT_TOKEN: process.env.TRADINGVIEW_JWT_TOKEN || '',

  // Symbols to Stream — derived from *_CONTRACT env vars
  OHLCV_SYMBOLS: (process.env.OHLCV_SYMBOLS || `CME_MINI:${tvNQ},CME_MINI:${tvMNQ},CME_MINI:${tvES},CME_MINI:${tvMES},${additionalQuoteSymbols}`).split(','),
  LT_SYMBOL: process.env.LT_SYMBOL || `CME_MINI:${tvNQ}`,
  LT_TIMEFRAME: process.env.LT_TIMEFRAME || '15',

  // GEX Calculator Configuration
  GEX_SYMBOL: process.env.GEX_SYMBOL || 'QQQ',
  GEX_FUTURES_SYMBOL: process.env.GEX_FUTURES_SYMBOL || 'NQ',
  GEX_DEFAULT_MULTIPLIER: parseFloat(process.env.GEX_DEFAULT_MULTIPLIER || '41.5'),
  GEX_FETCH_TIME: process.env.GEX_FETCH_TIME || '16:35',
  GEX_COOLDOWN_MINUTES: parseInt(process.env.GEX_COOLDOWN_MINUTES || '5'),
  GEX_CACHE_FILE: process.env.GEX_CACHE_FILE || './data/gex_cache.json',

  // Symbol Configuration
  // CANDLE_BASE_SYMBOL determines which candle stream feeds the strategy engine
  // Default 'NQ' for existing instance; set to 'ES' for ES instance
  CANDLE_BASE_SYMBOL: process.env.CANDLE_BASE_SYMBOL || 'NQ',

  // Strategy Configuration
  STRATEGY_ENABLED: process.env.STRATEGY_ENABLED?.toLowerCase() === 'true',
  TRADING_SYMBOL: process.env.TRADING_SYMBOL || process.env.NQ_CONTRACT || 'NQM6',
  DEFAULT_QUANTITY: parseInt(process.env.DEFAULT_QUANTITY || '1'),
  EVAL_TIMEFRAME: process.env.EVAL_TIMEFRAME || '1m',

  // Strategy Parameters
  TARGET_POINTS: parseFloat(process.env.TARGET_POINTS || '25.0'),
  STOP_BUFFER: parseFloat(process.env.STOP_BUFFER || '10.0'),
  MAX_RISK: parseFloat(process.env.MAX_RISK || '30.0'),
  USE_TRAILING_STOP: process.env.USE_TRAILING_STOP?.toLowerCase() === 'true',
  TRAILING_TRIGGER: parseFloat(process.env.TRAILING_TRIGGER || '15.0'),
  TRAILING_OFFSET: parseFloat(process.env.TRAILING_OFFSET || '10.0'),
  USE_LIQUIDITY_FILTER: process.env.USE_LIQUIDITY_FILTER?.toLowerCase() === 'true',
  MAX_LT_LEVELS_BELOW: parseInt(process.env.MAX_LT_LEVELS_BELOW || '3'),

  // Session Times (EST)
  SESSION_START_HOUR: parseInt(process.env.SESSION_START_HOUR || '18'),
  SESSION_END_HOUR: parseInt(process.env.SESSION_END_HOUR || '16'),

  // Session Filter Configuration
  // Set USE_SESSION_FILTER=false to allow trading in all sessions (for testing)
  // Or set ALLOWED_SESSIONS=overnight,premarket,rth,afterhours to specify which sessions
  USE_SESSION_FILTER: process.env.USE_SESSION_FILTER?.toLowerCase() !== 'false', // Default true
  ALLOWED_SESSIONS: (process.env.ALLOWED_SESSIONS || 'rth').split(',').map(s => s.trim()),

  // Trade Levels Configuration
  // Which GEX levels to trade: "1" = S1/R1 only (default), "1,2,3,4,5" = all levels
  // Longs trigger on support levels, shorts on resistance levels
  TRADE_LEVELS: (process.env.TRADE_LEVELS || '1').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)),

  // IV Skew GEX Strategy Parameters (backtested optimal values)
  IV_SKEW_STOP_LOSS_POINTS: parseFloat(process.env.IV_SKEW_STOP_LOSS_POINTS || '70'),
  IV_SKEW_TAKE_PROFIT_POINTS: parseFloat(process.env.IV_SKEW_TAKE_PROFIT_POINTS || '70'),
  IV_SKEW_MAX_HOLD_BARS: parseInt(process.env.IV_SKEW_MAX_HOLD_BARS || '60'),
  IV_SKEW_BREAKEVEN_STOP: process.env.IV_SKEW_BREAKEVEN_STOP?.toLowerCase() === 'true',
  IV_SKEW_BREAKEVEN_TRIGGER: parseFloat(process.env.IV_SKEW_BREAKEVEN_TRIGGER || '25'),
  IV_SKEW_BREAKEVEN_OFFSET: parseFloat(process.env.IV_SKEW_BREAKEVEN_OFFSET || '-45'),
  IV_SKEW_LEVEL_PROXIMITY: parseFloat(process.env.IV_SKEW_LEVEL_PROXIMITY || '25'),
  IV_SKEW_NEG_THRESHOLD: parseFloat(process.env.IV_SKEW_NEG_THRESHOLD || '-0.01'),
  IV_SKEW_POS_THRESHOLD: parseFloat(process.env.IV_SKEW_POS_THRESHOLD || '0.01'),
  IV_SKEW_MIN_IV: parseFloat(process.env.IV_SKEW_MIN_IV || '0.18'),
  IV_SKEW_MAX_IV: process.env.IV_SKEW_MAX_IV ? parseFloat(process.env.IV_SKEW_MAX_IV) : null,
  IV_SKEW_MAX_IV_VOLATILITY: process.env.IV_SKEW_MAX_IV_VOLATILITY ? parseFloat(process.env.IV_SKEW_MAX_IV_VOLATILITY) : null,
  IV_SKEW_IV_VOLATILITY_LOOKBACK: parseInt(process.env.IV_SKEW_IV_VOLATILITY_LOOKBACK || '15'),
  IV_SKEW_IV_DEAD_ZONE_MIN: parseFloat(process.env.IV_SKEW_IV_DEAD_ZONE_MIN || '0.30'),
  IV_SKEW_IV_DEAD_ZONE_MAX: parseFloat(process.env.IV_SKEW_IV_DEAD_ZONE_MAX || '0.35'),
  IV_SKEW_IV_DEAD_ZONE_SIDE: process.env.IV_SKEW_IV_DEAD_ZONE_SIDE || 'long',
  IV_SKEW_COOLDOWN_MS: parseInt(process.env.IV_SKEW_COOLDOWN_MS || '1800000'), // 30 minutes
  IV_SKEW_BLOCKED_REGIMES: process.env.IV_SKEW_BLOCKED_REGIMES
    ? process.env.IV_SKEW_BLOCKED_REGIMES.split(',').map((s) => s.trim()).filter(Boolean)
    : null,

  // ES Cross-Signal Strategy Parameters
  ES_CROSS_TARGET_POINTS: parseFloat(process.env.ES_CROSS_TARGET_POINTS || '10'),
  ES_CROSS_STOP_POINTS: parseFloat(process.env.ES_CROSS_STOP_POINTS || '10'),
  ES_CROSS_BREAKEVEN_STOP: process.env.ES_CROSS_BREAKEVEN_STOP?.toLowerCase() === 'true', // Default false (using broker trailing stop instead)
  ES_CROSS_BREAKEVEN_TRIGGER: parseFloat(process.env.ES_CROSS_BREAKEVEN_TRIGGER || '3'),
  ES_CROSS_BREAKEVEN_OFFSET: parseFloat(process.env.ES_CROSS_BREAKEVEN_OFFSET || '0'),
  ES_CROSS_FILTER_REGIME_SIDE: process.env.ES_CROSS_FILTER_REGIME_SIDE || 'strong_positive_buy',
  ES_CROSS_FILTER_LT_SPACING_MAX: parseFloat(process.env.ES_CROSS_FILTER_LT_SPACING_MAX || '40'),
  ES_CROSS_COOLDOWN_MS: parseInt(process.env.ES_CROSS_COOLDOWN_MS || '300000'), // 5 minutes

  // GEX-FLIP-IVPCT Strategy Parameters (V7DTSP13 backtest-matched defaults)
  // 6-rule day-trade strategy. Entries 04:00-13:00 ET. Broker liquidates 4:45 PM ET.
  // Each rule has its own stop/target — these are gates, not exits.
  //
  // GFI_PRESET (research/gex-flip-ivpct-improve, 2026-05-21). Default 'v2' —
  // the new gold standard ($229k / PF 3.92 / Sharpe 5.87 / DD 5.4% / 152tr,
  // +44% PnL vs tight with -32% DD and +0.93 PF). Set GFI_PRESET=tight to
  // revert to the prior gold (May 2026 tight-stop refit). Individual GFI_*
  // env vars below override preset fields when explicitly set, so existing
  // Sevalla configs continue to work.
  GFI_PRESET: process.env.GFI_PRESET || 'v2',

  GFI_WALL_PROXIMITY: parseFloat(process.env.GFI_WALL_PROXIMITY || '50'),
  GFI_IV_PCTILE_WINDOW_DAYS: parseInt(process.env.GFI_IV_PCTILE_WINDOW_DAYS || '20'),
  GFI_IV_PCTILE_LOW_MAX: parseFloat(process.env.GFI_IV_PCTILE_LOW_MAX || '0.20'),
  GFI_IV_PCTILE_HIGH_MIN: parseFloat(process.env.GFI_IV_PCTILE_HIGH_MIN || '0.80'),
  GFI_SKEW_POSITIVE_MIN: parseFloat(process.env.GFI_SKEW_POSITIVE_MIN || '0.015'),
  GFI_NEUTRAL_REGIME: process.env.GFI_NEUTRAL_REGIME || 'neutral',
  GFI_STRONG_NEGATIVE_REGIME: process.env.GFI_STRONG_NEGATIVE_REGIME || 'strong_negative',
  GFI_ENTRY_WINDOW_START_HOUR: parseInt(process.env.GFI_ENTRY_WINDOW_START_HOUR || '4'),
  GFI_ENTRY_WINDOW_END_HOUR: parseInt(process.env.GFI_ENTRY_WINDOW_END_HOUR || '13'),
  GFI_COOLDOWN_MS: parseInt(process.env.GFI_COOLDOWN_MS || '1800000'), // 30 minutes
  // GFI_MAX_HOLD_BARS, GFI_STOP_POINTS, GFI_TARGET_POINTS, GFI_BREAKEVEN_*
  // and GFI_BLOCKED_* are resolved against the preset in getGexFlipIvpctParams().
  // Stored raw here so the preset resolver can detect "user explicitly set" vs default.
  _GFI_MAX_HOLD_BARS_RAW: process.env.GFI_MAX_HOLD_BARS,
  _GFI_STOP_POINTS_RAW: process.env.GFI_STOP_POINTS,
  _GFI_TARGET_POINTS_RAW: process.env.GFI_TARGET_POINTS,
  _GFI_BREAKEVEN_STOP_RAW: process.env.GFI_BREAKEVEN_STOP,
  _GFI_BREAKEVEN_TRIGGER_RAW: process.env.GFI_BREAKEVEN_TRIGGER,
  _GFI_BREAKEVEN_OFFSET_RAW: process.env.GFI_BREAKEVEN_OFFSET,
  _GFI_BLOCKED_HOURS_ET_RAW: process.env.GFI_BLOCKED_HOURS_ET,
  _GFI_BLOCKED_DOWS_ET_RAW: process.env.GFI_BLOCKED_DOWS_ET,
  _GFI_DISABLED_RULES_RAW: process.env.GFI_DISABLED_RULES,
  // Fibonacci-retrace bar-close exit: independent of preset (older tuned).
  // Disabled by default in v2 (research showed fib HURTS the new wider-target
  // exits — set GFI_FIB_RETRACE=true to re-enable if desired). The tight preset
  // also disables fib by default because the new research subsumes the prior
  // two-layer config.
  GFI_FIB_RETRACE: process.env.GFI_FIB_RETRACE?.toLowerCase() === 'true', // default false now
  GFI_FIB_RETRACE_PCT: parseFloat(process.env.GFI_FIB_RETRACE_PCT || '0.618'),
  GFI_FIB_ACTIVATION_MFE: parseFloat(process.env.GFI_FIB_ACTIVATION_MFE || '40'),

  // LS-BE-on-flip overlay (research/ls-overlay, 2026-05-19). When enabled,
  // arms a breakeven stop on the first adverse LS_1m flip during the trade.
  // Phase 5 winner for gex-flip-ivpct: BE+0 offset, no entry filter.
  // Default OFF — flip to true once the data-service LS feed is verified.
  GFI_LS_BE_ON_FLIP: process.env.GFI_LS_BE_ON_FLIP?.toLowerCase() === 'true',
  GFI_LS_BE_OFFSET: parseFloat(process.env.GFI_LS_BE_OFFSET || '0'),

  // LS-BE-on-flip for gex-lt-3m-crossover (Phase 5 winner: BE+0 only,
  // no entry filter, $179k → $274k, PF 1.44 → 1.87, DD 4.55% → 2.08%).
  GLX_LS_BE_ON_FLIP: process.env.GLX_LS_BE_ON_FLIP?.toLowerCase() === 'true',
  GLX_LS_BE_OFFSET: parseFloat(process.env.GLX_LS_BE_OFFSET || '0'),

  // gex-lt-3m-crossover preset (research/gex-lt-3m-improve, 2026-05-21).
  // Default 'v3' — the new gold standard ($217,864 / PF 1.90 / Sharpe 8.73 /
  // DD 5.56%, +22% PnL vs W12 with -33% DD). Set GLX_PRESET=w12 to revert to
  // the prior gold for comparison runs. Mirrors cli.js GLX_PRESETS so live and
  // backtest stay in lockstep.
  GLX_PRESET: process.env.GLX_PRESET || 'v3',

  // LS-BE-on-flip for gex-level-fade. Phase 7 found +10 offset modestly
  // outperforms +0 ($173k vs $162k); default to +10.
  GLF_LS_BE_ON_FLIP: process.env.GLF_LS_BE_ON_FLIP?.toLowerCase() === 'true',
  GLF_LS_BE_OFFSET: parseFloat(process.env.GLF_LS_BE_OFFSET || '10'),

  // gex-level-fade preset (research/gex-level-fade-improve, 2026-05-21).
  // Default 'v2' — the new recommended gold (wider exits + structural BE +
  // drop SH/SL: +28% PnL vs gold-100/18 with PF lift and DD cut). Set
  // GLF_PRESET=gold to revert to the prior gold (t=100 s=18, all levels).
  // Mirrors cli.js GLF_PRESETS so live and backtest stay in lockstep.
  // Individual GLF_* env vars (TARGET_POINTS etc.) override preset values
  // when explicitly set.
  GLF_PRESET: process.env.GLF_PRESET || 'v2',
  _GLF_TARGET_POINTS_RAW: process.env.GLF_TARGET_POINTS,
  _GLF_STOP_POINTS_RAW: process.env.GLF_STOP_POINTS,
  _GLF_MAX_HOLD_BARS_RAW: process.env.GLF_MAX_HOLD_BARS,
  _GLF_BREAKEVEN_TRIGGER_RAW: process.env.GLF_BREAKEVEN_TRIGGER,
  _GLF_BREAKEVEN_OFFSET_RAW: process.env.GLF_BREAKEVEN_OFFSET,
  _GLF_LEVELS_RAW: process.env.GLF_LEVELS,

  // LS-Flip-Trigger-Bar (lstb) — v3 candJ defaults (the new recommended gold,
  // see CLAUDE.md "Gold Standard Commands"). Env vars override only when
  // explicitly set. Setting LSTB_PRESET to 'v2', 'v3', 'v3-max', 'v3-balanced',
  // or 'v3-low-dd' below expands to the full bundle; individual env vars then
  // override preset values.
  LSTB_PRESET: process.env.LSTB_PRESET || 'v3',
  // LT-alignment gate (2026-07-11 production standard): reject LS-flip entries
  // that fight the 15m LS state (the historical "LT sentiment"). Default ON —
  // set LSTB_REQUIRE_LT_ALIGN=false to disable. Requires the 15m LS feed
  // (ls.status.15m) to be flowing; the gate fails OPEN without it and the
  // strategy logs a warning.
  LSTB_REQUIRE_LT_ALIGN: (process.env.LSTB_REQUIRE_LT_ALIGN || 'true').toLowerCase() !== 'false',
  LSTB_FIB: parseFloat(process.env.LSTB_FIB || '0.5'),
  LSTB_CB_ATR_MAX: parseFloat(process.env.LSTB_CB_ATR_MAX || '1.81'),
  LSTB_ATR_PERIOD: parseInt(process.env.LSTB_ATR_PERIOD || '20'),
  LSTB_FILL_TIMEOUT_CANDLES: parseInt(process.env.LSTB_FILL_TIMEOUT_CANDLES || '10'),
  LSTB_MAX_HOLD_BARS: parseInt(process.env.LSTB_MAX_HOLD_BARS || '60'),
  LSTB_BLOCKED_HOURS_ET: process.env.LSTB_BLOCKED_HOURS_ET ?? null,
  LSTB_STOP_POINTS: process.env.LSTB_STOP_POINTS !== undefined ? parseFloat(process.env.LSTB_STOP_POINTS) : null,
  LSTB_TARGET_POINTS: process.env.LSTB_TARGET_POINTS !== undefined ? parseFloat(process.env.LSTB_TARGET_POINTS) : null,
  LSTB_MIN_RANGE: process.env.LSTB_MIN_RANGE !== undefined ? parseFloat(process.env.LSTB_MIN_RANGE) : null,
  LSTB_BREAKEVEN_STOP: process.env.LSTB_BREAKEVEN_STOP !== undefined ? (process.env.LSTB_BREAKEVEN_STOP.toLowerCase() === 'true') : null,
  LSTB_BE_TRIGGER: process.env.LSTB_BE_TRIGGER !== undefined ? parseFloat(process.env.LSTB_BE_TRIGGER) : null,
  LSTB_BE_OFFSET: process.env.LSTB_BE_OFFSET !== undefined ? parseFloat(process.env.LSTB_BE_OFFSET) : null,
  LSTB_TRAIL_TRIGGER: process.env.LSTB_TRAIL_TRIGGER !== undefined ? parseFloat(process.env.LSTB_TRAIL_TRIGGER) : null,
  LSTB_TRAIL_OFFSET: process.env.LSTB_TRAIL_OFFSET !== undefined ? parseFloat(process.env.LSTB_TRAIL_OFFSET) : null,
  // Mirrors trade-orchestrator's EOD_CUTOFF_ET so the dashboard can show the
  // same time the orchestrator will actually force-flat at. Set EOD_CUTOFF_ET=""
  // (empty) to disable the dashboard indicator (matches orchestrator semantics).
  EOD_CUTOFF_ET: process.env.EOD_CUTOFF_ET ?? '16:40',

  // Short-DTE IV Strategy Parameters (sweep-optimized: th=0.015, S30/T30)
  SDIV_IV_THRESHOLD: parseFloat(process.env.SDIV_IV_THRESHOLD || '0.015'),
  SDIV_STOP_POINTS: parseFloat(process.env.SDIV_STOP_POINTS || '30'),
  SDIV_TARGET_POINTS: parseFloat(process.env.SDIV_TARGET_POINTS || '30'),
  SDIV_ENABLE_LONG: process.env.SDIV_ENABLE_LONG?.toLowerCase() !== 'false',   // Default true
  SDIV_ENABLE_SHORT: process.env.SDIV_ENABLE_SHORT?.toLowerCase() !== 'false', // Default true
  SDIV_COOLDOWN_MS: parseInt(process.env.SDIV_COOLDOWN_MS || '900000'),        // 15 minutes
  SDIV_MAX_HOLD_BARS: parseInt(process.env.SDIV_MAX_HOLD_BARS || '60'),
  SDIV_TIMEOUT_CANDLES: parseInt(process.env.SDIV_TIMEOUT_CANDLES || '2'),

  // GF (Zero Gamma) Early Exit Configuration
  // Monitors Zero Gamma movement during trades and moves stop to breakeven after consecutive adverse moves
  // Check interval is fixed at 15 minutes to match backtest GEX data resolution
  GF_EARLY_EXIT_ENABLED: process.env.GF_EARLY_EXIT_ENABLED?.toLowerCase() === 'true',
  GF_BREAKEVEN_THRESHOLD: parseInt(process.env.GF_BREAKEVEN_THRESHOLD || '2'), // Consecutive adverse moves to trigger breakeven

  // Time-Based Trailing Stop Configuration
  // Progressive trailing stops that tighten based on bars held and MFE (Maximum Favorable Excursion)
  // Rules format: "bars,mfe,action" where action is "breakeven" or "trail:N"
  // Example: "20,35,trail:20" means after 20 bars, if MFE >= 35 pts, trail 20 pts behind peak
  // Multiple rules separated by pipe: "20,35,trail:20|35,50,trail:10"
  TIME_BASED_TRAILING_ENABLED: process.env.TIME_BASED_TRAILING_ENABLED?.toLowerCase() === 'true',
  TIME_BASED_TRAILING_RULES: process.env.TIME_BASED_TRAILING_RULES || '20,35,trail:20|35,50,trail:10',

  // Service Configuration
  HTTP_PORT: parseInt(process.env.HTTP_PORT || '3015'),
  LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
  SERVICE_NAME: process.env.SERVICE_NAME || 'siggen-nq-ivskew',

  // Tradovate Service URL (for position sync)
  TRADOVATE_SERVICE_URL: process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011',

  // Tradovate Account ID (for position sync on startup)
  TRADOVATE_ACCOUNT_ID: process.env.TRADOVATE_DEFAULT_ACCOUNT_ID || '',

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
  TRADIER_AUTO_START: process.env.TRADIER_AUTO_START?.toLowerCase() !== 'false', // Default true

  // Options Flow Configuration
  RISK_FREE_RATE: parseFloat(process.env.RISK_FREE_RATE || '0.05'),
  // Exclude same-day (0DTE) expirations from GEX so live matches the backtest
  // generator (generate-intraday-gex.py filters dte > 0). Live otherwise includes
  // 0DTE contracts whose ATM gamma explodes under the 0.001-year TTE floor,
  // inflating near-spot strikes and pulling the walls to spot. Default on for parity.
  EXCLUDE_ZERO_DTE: (process.env.EXCLUDE_ZERO_DTE || 'true') !== 'false',
  EXPOSURE_POLL_INTERVAL_MINUTES: parseInt(process.env.EXPOSURE_POLL_INTERVAL_MINUTES || '2'),
  TRADIER_SYMBOLS: (process.env.TRADIER_SYMBOLS || 'SPY,QQQ').split(',').map(s => s.trim()),
  // Cache every expiration in [0, CHAIN_MAX_DTE] days. Must cover the longest
  // DTE any consumer needs: iv-skew-gex uses 7-45 DTE, short-dte-iv uses 0-1
  // DTE, GEX/VEX/CEX integrate the full chain including LEAPS (matches the
  // backtest's OPRA-Statistics universe).
  CHAIN_MAX_DTE: parseInt(process.env.CHAIN_MAX_DTE || '730'),

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

  // Helper methods
  getRedisUrl() {
    const password = process.env.REDIS_PASSWORD;
    const auth = password ? `:${password}@` : '';
    return `redis://${auth}${this.REDIS_HOST}:${this.REDIS_PORT}`;
  },

  getStrategyParams() {
    return {
      targetPoints: this.TARGET_POINTS,
      stopBuffer: this.STOP_BUFFER,
      maxRisk: this.MAX_RISK,
      useTrailingStop: this.USE_TRAILING_STOP,
      trailingTrigger: this.TRAILING_TRIGGER,
      trailingOffset: this.TRAILING_OFFSET,
      useLiquidityFilter: this.USE_LIQUIDITY_FILTER,
      maxLtLevelsBelow: this.MAX_LT_LEVELS_BELOW,
      useSessionFilter: this.USE_SESSION_FILTER,
      allowedSessions: this.ALLOWED_SESSIONS,
      tradeLevels: this.TRADE_LEVELS
    };
  },

  getIVSkewStrategyParams() {
    return {
      // Risk management
      stopLossPoints: this.IV_SKEW_STOP_LOSS_POINTS,
      takeProfitPoints: this.IV_SKEW_TAKE_PROFIT_POINTS,
      maxHoldBars: this.IV_SKEW_MAX_HOLD_BARS,

      // Breakeven stop configuration
      breakevenStop: this.IV_SKEW_BREAKEVEN_STOP,
      breakevenTrigger: this.IV_SKEW_BREAKEVEN_TRIGGER,
      breakevenOffset: this.IV_SKEW_BREAKEVEN_OFFSET,

      // GEX level proximity
      levelProximity: this.IV_SKEW_LEVEL_PROXIMITY,

      // IV Skew thresholds
      negSkewThreshold: this.IV_SKEW_NEG_THRESHOLD,
      posSkewThreshold: this.IV_SKEW_POS_THRESHOLD,
      minIV: this.IV_SKEW_MIN_IV,
      maxIV: this.IV_SKEW_MAX_IV,
      maxIVVolatility: this.IV_SKEW_MAX_IV_VOLATILITY,
      ivVolatilityLookback: this.IV_SKEW_IV_VOLATILITY_LOOKBACK,
      ivDeadZoneMin: this.IV_SKEW_IV_DEAD_ZONE_MIN,
      ivDeadZoneMax: this.IV_SKEW_IV_DEAD_ZONE_MAX,
      ivDeadZoneSide: this.IV_SKEW_IV_DEAD_ZONE_SIDE,

      // Signal cooldown
      signalCooldownMs: this.IV_SKEW_COOLDOWN_MS,

      // GEX regime filter (e.g. ["strong_negative"] for v5/balanced mode)
      blockedRegimes: this.IV_SKEW_BLOCKED_REGIMES,

      // Session filter (reuse from common config)
      useSessionFilter: this.USE_SESSION_FILTER,
      allowedSessions: this.ALLOWED_SESSIONS,

      // Evaluation timeframe
      evalTimeframe: this.EVAL_TIMEFRAME
    };
  },

  getESCrossSignalParams() {
    return {
      // Exit parameters
      targetPoints: this.ES_CROSS_TARGET_POINTS,
      stopPoints: this.ES_CROSS_STOP_POINTS,

      // Breakeven stop configuration
      breakevenStop: this.ES_CROSS_BREAKEVEN_STOP,
      breakevenTrigger: this.ES_CROSS_BREAKEVEN_TRIGGER,
      breakevenOffset: this.ES_CROSS_BREAKEVEN_OFFSET,

      // Entry filters
      filterRegimeSide: this.ES_CROSS_FILTER_REGIME_SIDE
        ? this.ES_CROSS_FILTER_REGIME_SIDE.split(',').map(s => s.trim())
        : null,
      filterLtSpacingMax: this.ES_CROSS_FILTER_LT_SPACING_MAX,

      // Signal cooldown
      signalCooldownMs: this.ES_CROSS_COOLDOWN_MS,

      // Session filter (reuse from common config)
      useSessionFilter: this.USE_SESSION_FILTER,
      allowedSessions: this.ALLOWED_SESSIONS,

      // Evaluation timeframe
      evalTimeframe: this.EVAL_TIMEFRAME
    };
  },

  getMnqAdaptiveScalperParams() {
    return {
      stopPoints: 10,
      targetPoints: 50,
      trailingTrigger: 3,
      trailingOffset: 1,
      dailyLossLimit: -25,
      dailyTarget: 50,
      weeklyMaxLossDays: 1,
      proximity: 3,
      maxDistance: 80,
      minDistance: 1,
      signalCooldownMs: 60000,
      orderTimeoutCandles: 3,
      orbCandles: 15,
      ibCandles: 30,
      lastEntryTime: 15.917
    };
  },

  getLsFlipTriggerBarParams() {
    // Preset-first param construction. LSTB_PRESET (default 'v3' = candJ
    // recommended) provides a complete bundle; individual LSTB_* env vars
    // then override preset values when explicitly set.
    //
    // Preset values mirror cli.js LSTB_PRESETS (keep in sync if either changes):
    const PRESETS = {
      v2:            { blockedHours: [5, 16, 21],                              minRange: null, target: null, stop: null, be: false, beTrig: null, beOff: 0, trailTrig: null, trailOff: null },
      v3:            { blockedHours: [5, 16, 17, 18, 19, 20, 21, 22, 23],     minRange: 3,    target: 15,   stop: 12,   be: true,  beTrig: 8,    beOff: 2, trailTrig: null, trailOff: null },
      'v3-max':      { blockedHours: [5, 16, 17, 18, 19, 20, 21, 22, 23],     minRange: 3,    target: 20,   stop: 12,   be: true,  beTrig: 10,   beOff: 1, trailTrig: null, trailOff: null },
      'v3-balanced': { blockedHours: [5, 16, 17, 18, 19, 20, 21, 22, 23],     minRange: 3,    target: 10,   stop: 9,    be: true,  beTrig: 6,    beOff: 1, trailTrig: null, trailOff: null },
      'v3-low-dd':   { blockedHours: [5, 16, 17, 18, 19, 20, 21, 22, 23],     minRange: 3,    target: null, stop: 8,    be: false, beTrig: null, beOff: 0, trailTrig: 12,   trailOff: 5 },
    };
    const preset = PRESETS[this.LSTB_PRESET] || PRESETS['v3'];

    // Apply per-field overrides only when env var was explicitly set
    // (config.js loader returns null for "not set", actual value when set).
    let blockedHoursEt = preset.blockedHours;
    if (this.LSTB_BLOCKED_HOURS_ET !== null) {
      blockedHoursEt = this.LSTB_BLOCKED_HOURS_ET
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    }
    return {
      fib: this.LSTB_FIB,
      cbAtrMax: this.LSTB_CB_ATR_MAX,
      atrPeriod: this.LSTB_ATR_PERIOD,
      fillTimeoutCandles: this.LSTB_FILL_TIMEOUT_CANDLES,
      maxHoldBars: this.LSTB_MAX_HOLD_BARS,
      blockedHoursEt,
      stopPoints:       this.LSTB_STOP_POINTS    ?? preset.stop,
      targetPoints:     this.LSTB_TARGET_POINTS  ?? preset.target,
      minTriggerRange:  this.LSTB_MIN_RANGE      ?? preset.minRange,
      breakevenStop:    this.LSTB_BREAKEVEN_STOP ?? preset.be,
      breakevenTrigger: this.LSTB_BE_TRIGGER     ?? preset.beTrig,
      breakevenOffset:  this.LSTB_BE_OFFSET      ?? preset.beOff,
      trailingTrigger:  this.LSTB_TRAIL_TRIGGER  ?? preset.trailTrig,
      trailingOffset:   this.LSTB_TRAIL_OFFSET   ?? preset.trailOff,
      requireLtAlign:   this.LSTB_REQUIRE_LT_ALIGN,
    };
  },

  getGexLt3mCrossoverParams() {
    // Live preset bundle — mirrors backtest-engine/src/cli.js GLX_PRESETS so
    // any backtest reproduction with --glx-preset $GLX_PRESET matches live.
    // Default 'w12' = current production gold; flip to 'v3' for the new
    // research-validated gold. Disabled rules and ruleOverrides are baked into
    // the preset; the strategy class W12 defaults are overridden when the
    // preset is selected. The LS-BE-on-flip overlay layers on top.
    const GLX_PRESETS = {
      w12: {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 120, maxHoldBars: 90 },
          S_GF_SOLO: {                 maxHoldBars: 90 },
          S_CW:      { targetPts: 120, maxHoldBars: 90, blockedHoursEt: [14, 15] },
        },
      },
      v3: {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 100, stopPts: 70, maxHoldBars: 120, breakevenTrigger: 70, breakevenOffset: 20, blockedLtIdx: [2, 4], blockedDowsEt: ['Thu', 'Fri'] },
          S_GF_SOLO: { targetPts: 180, stopPts: 70, maxHoldBars: 120, breakevenTrigger: 80, breakevenOffset: 20, blockedHoursEt: [11] },
          S_CW:      { targetPts: 200, stopPts: 70, maxHoldBars: 120, breakevenTrigger: 80, breakevenOffset: 20, blockedHoursEt: [14, 15] },
          S_R4:      { targetPts: 80,  stopPts: 40, maxHoldBars: 60,  trailingTrigger: 70, trailingOffset: 25, blockedLtIdx: [2, 4], blockedDowsEt: ['Fri'], blockedHoursEt: [11, 15] },
        },
      },
      'v3-max': {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 140, stopPts: 70, maxHoldBars: 150, blockedLtIdx: [2, 4], blockedDowsEt: ['Thu', 'Fri'] },
          S_GF_SOLO: { targetPts: 180, stopPts: 70, maxHoldBars: 150, breakevenTrigger: 80, breakevenOffset: 20, blockedHoursEt: [11] },
          S_CW:      { targetPts: 200, stopPts: 70, maxHoldBars: 150, blockedHoursEt: [14, 15] },
          S_R4:      { targetPts: 80,  stopPts: 40, maxHoldBars: 60,  trailingTrigger: 70, trailingOffset: 25, blockedLtIdx: [2, 4], blockedDowsEt: ['Fri'], blockedHoursEt: [11, 15] },
        },
      },
      'v3-balanced': {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 100, stopPts: 70, maxHoldBars: 120, breakevenTrigger: 70, breakevenOffset: 20, blockedLtIdx: [2, 4], blockedDowsEt: ['Thu', 'Fri'] },
          S_GF_SOLO: { targetPts: 50,  stopPts: 40, maxHoldBars: 60,  breakevenTrigger: 25, breakevenOffset: 5,  blockedHoursEt: [11] },
          S_CW:      { targetPts: 140, stopPts: 50, maxHoldBars: 90,  breakevenTrigger: 60, breakevenOffset: 10, blockedHoursEt: [14, 15] },
          S_R4:      { targetPts: 70,  stopPts: 40, maxHoldBars: 60,  breakevenTrigger: 35, breakevenOffset: 5,  blockedLtIdx: [2, 4], blockedDowsEt: ['Fri'], blockedHoursEt: [11, 15] },
        },
      },
      'v3-low-dd': {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 120, stopPts: 50, maxHoldBars: 90, blockedLtIdx: [2, 4], blockedDowsEt: ['Thu', 'Fri'] },
          S_GF_SOLO: { targetPts: 60,  stopPts: 50, maxHoldBars: 90, blockedHoursEt: [11] },
          S_CW:      { targetPts: 120, stopPts: 50, maxHoldBars: 90, blockedHoursEt: [14, 15] },
          S_R4:      { targetPts: 80,  stopPts: 50, maxHoldBars: 60, blockedLtIdx: [2, 4], blockedDowsEt: ['Fri'], blockedHoursEt: [11, 15] },
        },
      },
    };
    const preset = GLX_PRESETS[this.GLX_PRESET] || GLX_PRESETS.w12;
    return {
      disabledRules: preset.disabledRules,
      ruleOverrides: preset.ruleOverrides,
      lsBeOnFlip: this.GLX_LS_BE_ON_FLIP,
      lsBeOffset: this.GLX_LS_BE_OFFSET,
    };
  },

  getGexLevelFadeParams() {
    // Preset-first param construction (research/gex-level-fade-improve, 2026-05-21).
    // GLF_PRESET (default 'v2') provides a complete bundle; individual GLF_* env
    // vars then override preset values when explicitly set. Mirrors backtest-engine
    // GLF_PRESETS so live and backtest stay in lockstep.
    const GLF_PRESETS = {
      gold:        { tgt: 100, stop: 18, mh: 180, beTrig: 0,   beOff: 0,  levels: 'PRH,PRL,SH,SL' },
      v2:          { tgt: 110, stop: 22, mh: 180, beTrig: 100, beOff: 10, levels: 'PRH,PRL' },
      'v2-max':    { tgt: 140, stop: 25, mh: 180, beTrig: 100, beOff: 20, levels: 'PRH,PRL,SH,SL' },
      'v2-low-dd': { tgt: 110, stop: 20, mh: 180, beTrig: 80,  beOff: 10, levels: 'PRH,PRL' },
    };
    const preset = GLF_PRESETS[this.GLF_PRESET] || GLF_PRESETS.v2;

    const intOrDef = (v, d) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? d : n;
    };
    const numOrDef = (v, d) => {
      const n = Number(v);
      return isNaN(n) ? d : n;
    };
    const boolFlag = (v, d) => {
      if (v === undefined || v === null || v === '') return d;
      const s = String(v).toLowerCase();
      return s === 'true' || s === '1' || s === 'yes';
    };
    const blockedHoursEt = (this.GLF_BLOCKED_HOURS_ET || '')
      .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    const blockedRegimes = (this.GLF_BLOCKED_REGIMES ?? 'strong_negative')
      .split(',').map(s => s.trim()).filter(Boolean);

    // Preset fields, then individual env-var overrides
    const targetPts = this._GLF_TARGET_POINTS_RAW !== undefined ? parseInt(this._GLF_TARGET_POINTS_RAW, 10) : preset.tgt;
    const stopPts   = this._GLF_STOP_POINTS_RAW   !== undefined ? parseInt(this._GLF_STOP_POINTS_RAW, 10)   : preset.stop;
    const maxHoldBars = this._GLF_MAX_HOLD_BARS_RAW !== undefined ? parseInt(this._GLF_MAX_HOLD_BARS_RAW, 10) : preset.mh;
    const beTrig = this._GLF_BREAKEVEN_TRIGGER_RAW !== undefined ? parseInt(this._GLF_BREAKEVEN_TRIGGER_RAW, 10) : preset.beTrig;
    const beOff  = this._GLF_BREAKEVEN_OFFSET_RAW  !== undefined ? parseInt(this._GLF_BREAKEVEN_OFFSET_RAW, 10)  : preset.beOff;
    const levelsStr = this._GLF_LEVELS_RAW !== undefined ? this._GLF_LEVELS_RAW : preset.levels;
    const levels = levelsStr.split(',').map(s => s.trim()).filter(Boolean);

    return {
      targetPts,
      stopPts,
      maxHoldBars,
      levels,
      limitTimeoutBars: intOrDef(this.GLF_LIMIT_TIMEOUT_BARS, 1),
      minEpisodeNum: intOrDef(this.GLF_MIN_EPISODE_NUM, 2),
      includeGexLevels: boolFlag(this.GLF_INCLUDE_GEX, true),
      entryWindowStartHour: intOrDef(this.GLF_ENTRY_START_HOUR, 9),
      entryWindowStartMinute: intOrDef(this.GLF_ENTRY_START_MIN, 0),
      entryWindowEndHour: intOrDef(this.GLF_ENTRY_END_HOUR, 10),
      entryWindowEndMinute: intOrDef(this.GLF_ENTRY_END_MIN, 30),
      blockedHoursEt,
      blockedRegimes,
      signalCooldownMs: intOrDef(this.GLF_COOLDOWN_MS, 0),
      directionMode: this.GLF_DIRECTION_MODE || 'fade',
      // Quality filters (null = disabled). Sweep showed they don't help at 100/18
      // but the env hooks are here so future variants can enable them.
      maxLastEpPenetrationPts: this.GLF_MAX_LAST_EP_PEN ? numOrDef(this.GLF_MAX_LAST_EP_PEN, null) : null,
      minLastEpBarsInZone: this.GLF_MIN_LAST_EP_BARS ? intOrDef(this.GLF_MIN_LAST_EP_BARS, null) : null,
      minLastEpRej5m: this.GLF_MIN_LAST_EP_REJ_5M ? intOrDef(this.GLF_MIN_LAST_EP_REJ_5M, null) : null,
      minLastEpRej15m: this.GLF_MIN_LAST_EP_REJ_15M ? intOrDef(this.GLF_MIN_LAST_EP_REJ_15M, null) : null,
      minLastEpVolBursts: this.GLF_MIN_LAST_EP_VOL_BURSTS ? intOrDef(this.GLF_MIN_LAST_EP_VOL_BURSTS, null) : null,
      trailingTrigger: intOrDef(this.GLF_TRAILING_TRIGGER, 0),
      trailingOffset: intOrDef(this.GLF_TRAILING_OFFSET, 0),
      breakevenTrigger: beTrig,
      breakevenOffset: beOff,
      // LS-BE-on-flip overlay
      lsBeOnFlip: this.GLF_LS_BE_ON_FLIP,
      lsBeOffset: this.GLF_LS_BE_OFFSET,
    };
  },

  getGexFlipIvpctParams() {
    // Resolve preset (research/gex-flip-ivpct-improve, 2026-05-21). Individual
    // GFI_* env vars override preset fields when explicitly set on the env.
    const GFI_PRESETS = {
      tight:         { stop: 60, target: 200, beStop: true, beTrig: 70,  beOff: 5,  mh: 600, blockedHours: '6,7,8',     blockedDows: '',    disabledRules: '', fibDefault: true },
      v2:            { stop: 60, target: 260, beStop: true, beTrig: 160, beOff: 10, mh: 600, blockedHours: '6,7,8',     blockedDows: '',    disabledRules: '', fibDefault: false },
      'v2-max':      { stop: 60, target: 320, beStop: true, beTrig: 160, beOff: 10, mh: 480, blockedHours: '6,7,8',     blockedDows: '',    disabledRules: '', fibDefault: false },
      'v2-low-dd':   { stop: 60, target: 260, beStop: true, beTrig: 160, beOff: 10, mh: 600, blockedHours: '6,7,8,11',  blockedDows: 'Fri', disabledRules: 'S1', fibDefault: false },
    };
    const preset = GFI_PRESETS[this.GFI_PRESET] || GFI_PRESETS.v2;
    // Tied to preset: tight enables fib (prior production "twolayer-be80p10-fib618-a40"
    // overlay); v2+ disables it (research showed fib hurts new wider-target exits).
    // GFI_FIB_RETRACE env var, if set, overrides regardless of preset.
    const fibRetrace = process.env.GFI_FIB_RETRACE !== undefined
      ? process.env.GFI_FIB_RETRACE.toLowerCase() === 'true'
      : preset.fibDefault;

    const stopPts     = this._GFI_STOP_POINTS_RAW     !== undefined ? parseFloat(this._GFI_STOP_POINTS_RAW)     : preset.stop;
    const targetPts   = this._GFI_TARGET_POINTS_RAW   !== undefined ? parseFloat(this._GFI_TARGET_POINTS_RAW)   : preset.target;
    const beStop      = this._GFI_BREAKEVEN_STOP_RAW  !== undefined ? this._GFI_BREAKEVEN_STOP_RAW.toLowerCase() !== 'false' : preset.beStop;
    const beTrig      = this._GFI_BREAKEVEN_TRIGGER_RAW !== undefined ? parseFloat(this._GFI_BREAKEVEN_TRIGGER_RAW) : preset.beTrig;
    const beOff       = this._GFI_BREAKEVEN_OFFSET_RAW  !== undefined ? parseFloat(this._GFI_BREAKEVEN_OFFSET_RAW)  : preset.beOff;
    const mh          = this._GFI_MAX_HOLD_BARS_RAW     !== undefined ? parseInt(this._GFI_MAX_HOLD_BARS_RAW, 10)    : preset.mh;
    const blockedHoursStr = this._GFI_BLOCKED_HOURS_ET_RAW ?? preset.blockedHours;
    const blockedDowsStr  = this._GFI_BLOCKED_DOWS_ET_RAW  ?? preset.blockedDows;
    const disabledRulesStr = this._GFI_DISABLED_RULES_RAW  ?? preset.disabledRules;

    const blockedHoursEt = (blockedHoursStr || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    const blockedDowsEt  = (blockedDowsStr  || '').split(',').map(s => s.trim()).filter(Boolean);
    const disabledRules  = (disabledRulesStr || '').split(',').map(s => s.trim()).filter(Boolean);

    return {
      wallProximity: this.GFI_WALL_PROXIMITY,
      ivPctileWindowDays: this.GFI_IV_PCTILE_WINDOW_DAYS,
      ivPctileLowMax: this.GFI_IV_PCTILE_LOW_MAX,
      ivPctileHighMin: this.GFI_IV_PCTILE_HIGH_MIN,
      skewPositiveMin: this.GFI_SKEW_POSITIVE_MIN,
      neutralRegime: this.GFI_NEUTRAL_REGIME,
      strongNegativeRegime: this.GFI_STRONG_NEGATIVE_REGIME,
      entryWindowStartHour: this.GFI_ENTRY_WINDOW_START_HOUR,
      entryWindowEndHour: this.GFI_ENTRY_WINDOW_END_HOUR,
      signalCooldownMs: this.GFI_COOLDOWN_MS,
      maxHoldBars: mh,
      eodCutoffEt: this.EOD_CUTOFF_ET,
      // Preset-driven exit policy (v2 / v2-max / v2-balanced / v2-low-dd / tight)
      globalStopPts: stopPts,
      globalTargetPts: targetPts,
      breakevenStop: beStop,
      breakevenTrigger: beTrig,
      breakevenOffset: beOff,
      // Fibonacci-retrace bar-close exit. Tied to preset (tight=on, v2+=off);
      // GFI_FIB_RETRACE env var overrides regardless of preset.
      fibRetrace,
      fibRetracePct: this.GFI_FIB_RETRACE_PCT,
      fibActivationMFE: this.GFI_FIB_ACTIVATION_MFE,
      // LS-BE-on-flip (orchestrator-side exit rule; independent of structural BE).
      lsBeOnFlip: this.GFI_LS_BE_ON_FLIP,
      lsBeOffset: this.GFI_LS_BE_OFFSET,
      blockedHoursEt,
      blockedDowsEt,
      disabledRules,
    };
  },

  getShortDTEIVParams() {
    return {
      ivChangeThreshold: this.SDIV_IV_THRESHOLD,
      stopPoints: this.SDIV_STOP_POINTS,
      targetPoints: this.SDIV_TARGET_POINTS,
      enableLong: this.SDIV_ENABLE_LONG,
      enableShort: this.SDIV_ENABLE_SHORT,
      cooldownMs: this.SDIV_COOLDOWN_MS,
      maxHoldBars: this.SDIV_MAX_HOLD_BARS,
      timeoutCandles: this.SDIV_TIMEOUT_CANDLES,
      // Disable trailing (pure TP/SL — best from sweep)
      trailingTrigger: 9999,
      trailingOffset: 0,
      // Quality filter
      minQuality: 2,
    };
  },

  getLTCandleRegimeParams() {
    return {
      holdBars: parseInt(process.env.LT_REGIME_HOLD_BARS || '15'),
      ratchetTrigger: parseFloat(process.env.LT_REGIME_RATCHET_TRIGGER || '25'),
      ratchetTrailDist: parseFloat(process.env.LT_REGIME_RATCHET_TRAIL_DIST || '15'),
      maxHoldWithTrail: parseInt(process.env.LT_REGIME_MAX_HOLD || '120'),
      cooldownMs: parseInt(process.env.LT_REGIME_COOLDOWN_MS || '900000'),
      direction: process.env.LT_REGIME_DIRECTION || 'both',
      requireSentiment: process.env.LT_REGIME_REQUIRE_SENTIMENT === 'true',
    };
  },

  getImpulseFVGParams() {
    return {
      mode: 'no-fvg-fade',
      minBodyPoints: 25,
      noFvgStopBuffer: 2,
      noFvgTargetPoints: 30,
      noFvgMaxRisk: 40,
      useTrailingStop: true,
      trailingTrigger: 8,
      trailingOffset: 3,
      signalCooldownMs: 20 * 60 * 1000,
      maxHoldBars: 60,
      useLimitEntry: false,
      limitRetracePct: 50,
      limitTimeoutBars: 3,
      useSessionFilter: false,
      allowedSessions: ['overnight', 'premarket', 'rth', 'afterhours'],
    };
  },

  getTradierConfig() {
    return {
      accessToken: this.TRADIER_ACCESS_TOKEN,
      accountId: this.TRADIER_ACCOUNT_ID,
      baseUrl: this.TRADIER_BASE_URL,
      symbols: this.TRADIER_SYMBOLS,
      chainMaxDTE: this.CHAIN_MAX_DTE,
      pollInterval: this.EXPOSURE_POLL_INTERVAL_MINUTES,
      riskFreeRate: this.RISK_FREE_RATE,
      excludeZeroDTE: this.EXCLUDE_ZERO_DTE,
      // Schwab override
      useSchwab: this.SCHWAB_ENABLED,
      schwabAppKey: this.SCHWAB_APP_KEY,
      schwabAppSecret: this.SCHWAB_APP_SECRET,
      schwabCallbackUrl: this.SCHWAB_CALLBACK_URL
    };
  },

  getGexThresholds() {
    return {
      strongPositive: this.GEX_STRONG_POSITIVE_THRESHOLD,
      positive: this.GEX_POSITIVE_THRESHOLD,
      neutral: this.GEX_NEUTRAL_THRESHOLD,
      negative: this.GEX_NEGATIVE_THRESHOLD
    };
  }
};

export default config;