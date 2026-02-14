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

  // Symbols to Stream
  OHLCV_SYMBOLS: (process.env.OHLCV_SYMBOLS || 'CME_MINI:NQ1!,CME_MINI:MNQ1!,CME_MINI:ES1!,CME_MINI:MES1!,NASDAQ:QQQ,AMEX:SPY,BITSTAMP:BTCUSD').split(','),
  LT_SYMBOL: process.env.LT_SYMBOL || 'CME_MINI:NQ1!',
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
  TRADING_SYMBOL: process.env.TRADING_SYMBOL || 'NQH5',
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
  IV_SKEW_BREAKEVEN_STOP: process.env.IV_SKEW_BREAKEVEN_STOP?.toLowerCase() === 'true',
  IV_SKEW_BREAKEVEN_TRIGGER: parseFloat(process.env.IV_SKEW_BREAKEVEN_TRIGGER || '25'),
  IV_SKEW_BREAKEVEN_OFFSET: parseFloat(process.env.IV_SKEW_BREAKEVEN_OFFSET || '-45'),
  IV_SKEW_LEVEL_PROXIMITY: parseFloat(process.env.IV_SKEW_LEVEL_PROXIMITY || '25'),
  IV_SKEW_NEG_THRESHOLD: parseFloat(process.env.IV_SKEW_NEG_THRESHOLD || '-0.01'),
  IV_SKEW_POS_THRESHOLD: parseFloat(process.env.IV_SKEW_POS_THRESHOLD || '0.01'),
  IV_SKEW_MIN_IV: parseFloat(process.env.IV_SKEW_MIN_IV || '0.18'),
  IV_SKEW_COOLDOWN_MS: parseInt(process.env.IV_SKEW_COOLDOWN_MS || '1800000'), // 30 minutes

  // ES Cross-Signal Strategy Parameters
  ES_CROSS_TARGET_POINTS: parseFloat(process.env.ES_CROSS_TARGET_POINTS || '10'),
  ES_CROSS_STOP_POINTS: parseFloat(process.env.ES_CROSS_STOP_POINTS || '10'),
  ES_CROSS_BREAKEVEN_STOP: process.env.ES_CROSS_BREAKEVEN_STOP?.toLowerCase() !== 'false', // Default true
  ES_CROSS_BREAKEVEN_TRIGGER: parseFloat(process.env.ES_CROSS_BREAKEVEN_TRIGGER || '3'),
  ES_CROSS_BREAKEVEN_OFFSET: parseFloat(process.env.ES_CROSS_BREAKEVEN_OFFSET || '0'),
  ES_CROSS_FILTER_REGIME_SIDE: process.env.ES_CROSS_FILTER_REGIME_SIDE || 'strong_positive_buy',
  ES_CROSS_FILTER_LT_SPACING_MAX: parseFloat(process.env.ES_CROSS_FILTER_LT_SPACING_MAX || '40'),
  ES_CROSS_COOLDOWN_MS: parseInt(process.env.ES_CROSS_COOLDOWN_MS || '300000'), // 5 minutes

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

  // Tradovate Account ID (for position sync on startup)
  TRADOVATE_ACCOUNT_ID: process.env.TRADOVATE_DEFAULT_ACCOUNT_ID || '',

  // Tradier API Configuration
  TRADIER_ACCESS_TOKEN: process.env.TRADIER_ACCESS_TOKEN || '',
  TRADIER_ACCOUNT_ID: process.env.TRADIER_ACCOUNT_ID || '',
  TRADIER_BASE_URL: process.env.TRADIER_BASE_URL || 'https://api.tradier.com/v1',
  TRADIER_ENABLED: process.env.TRADIER_ENABLED?.toLowerCase() === 'true',
  TRADIER_AUTO_START: process.env.TRADIER_AUTO_START?.toLowerCase() !== 'false', // Default true

  // Options Flow Configuration
  RISK_FREE_RATE: parseFloat(process.env.RISK_FREE_RATE || '0.05'),
  EXPOSURE_POLL_INTERVAL_MINUTES: parseInt(process.env.EXPOSURE_POLL_INTERVAL_MINUTES || '2'),
  TRADIER_SYMBOLS: (process.env.TRADIER_SYMBOLS || 'SPY,QQQ').split(',').map(s => s.trim()),
  TRADIER_MAX_EXPIRATIONS: parseInt(process.env.TRADIER_MAX_EXPIRATIONS || '6'),

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

      // Signal cooldown
      signalCooldownMs: this.IV_SKEW_COOLDOWN_MS,

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

  getTradierConfig() {
    return {
      accessToken: this.TRADIER_ACCESS_TOKEN,
      accountId: this.TRADIER_ACCOUNT_ID,
      baseUrl: this.TRADIER_BASE_URL,
      symbols: this.TRADIER_SYMBOLS,
      maxExpirations: this.TRADIER_MAX_EXPIRATIONS,
      pollInterval: this.EXPOSURE_POLL_INTERVAL_MINUTES,
      riskFreeRate: this.RISK_FREE_RATE
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