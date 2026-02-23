module.exports = {
  apps: [
    {
      name: 'tradovate-service',
      script: './tradovate-service/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3011,
        BIND_HOST: '127.0.0.1'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3011,
        BIND_HOST: '127.0.0.1'
      }
    },
    {
      name: 'trade-orchestrator',
      script: './trade-orchestrator/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3013,
        BIND_HOST: '127.0.0.1'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3013,
        BIND_HOST: '127.0.0.1'
      }
    },
    {
      name: 'monitoring-service',
      script: './monitoring-service/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3014,
        BIND_HOST: '0.0.0.0'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3014,
        BIND_HOST: '0.0.0.0'
      }
    },
    {
      name: 'siggen-nq-ivskew',
      script: './signal-generator/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        HTTP_PORT: 3015,
        LOG_LEVEL: 'info',
        SERVICE_NAME: 'siggen-nq-ivskew'
      },
      env_production: {
        NODE_ENV: 'production',
        HTTP_PORT: 3015,
        LOG_LEVEL: 'info',
        SERVICE_NAME: 'siggen-nq-ivskew'
      }
    },
    {
      name: 'siggen-es-cross',
      script: './signal-generator/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        HTTP_PORT: 3016,
        LOG_LEVEL: 'info',
        ACTIVE_STRATEGY: 'es-cross-signal',
        TRADING_SYMBOL: 'ESH6',
        CANDLE_BASE_SYMBOL: 'ES',
        LT_SYMBOL: 'CME_MINI:ES1!',
        GEX_SYMBOL: 'SPY',
        GEX_FUTURES_SYMBOL: 'ES',
        GEX_DEFAULT_MULTIPLIER: '10.5',
        STRATEGY_ENABLED: 'true',
        SERVICE_NAME: 'siggen-es-cross',
        EVAL_TIMEFRAME: '15m'
      },
      env_production: {
        NODE_ENV: 'production',
        HTTP_PORT: 3016,
        LOG_LEVEL: 'info',
        ACTIVE_STRATEGY: 'es-cross-signal',
        TRADING_SYMBOL: 'ESH6',
        CANDLE_BASE_SYMBOL: 'ES',
        LT_SYMBOL: 'CME_MINI:ES1!',
        GEX_SYMBOL: 'SPY',
        GEX_FUTURES_SYMBOL: 'ES',
        GEX_DEFAULT_MULTIPLIER: '10.5',
        STRATEGY_ENABLED: 'true',
        SERVICE_NAME: 'siggen-es-cross',
        EVAL_TIMEFRAME: '15m'
      }
    },
    {
      name: 'siggen-nq-aitrader',
      script: './signal-generator/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        HTTP_PORT: 3018,
        LOG_LEVEL: 'info',
        ACTIVE_STRATEGY: 'ai-trader',
        TRADING_SYMBOL: 'NQH6',
        CANDLE_BASE_SYMBOL: 'NQ',
        GEX_SYMBOL: 'QQQ',
        GEX_FUTURES_SYMBOL: 'NQ',
        CANDLE_HISTORY_BARS: 500,
        AI_TRADER_MODEL: 'claude-sonnet-4-20250514',
        AI_TRADER_DRY_RUN: 'false',
        AI_TRADER_QUANTITY: 1,
        STRATEGY_ENABLED: 'true',
        SERVICE_NAME: 'siggen-nq-aitrader'
      },
      env_production: {
        NODE_ENV: 'production',
        HTTP_PORT: 3018,
        LOG_LEVEL: 'info',
        ACTIVE_STRATEGY: 'ai-trader',
        TRADING_SYMBOL: 'NQH6',
        CANDLE_BASE_SYMBOL: 'NQ',
        GEX_SYMBOL: 'QQQ',
        GEX_FUTURES_SYMBOL: 'NQ',
        CANDLE_HISTORY_BARS: 500,
        AI_TRADER_MODEL: 'claude-sonnet-4-20250514',
        AI_TRADER_DRY_RUN: 'false',
        AI_TRADER_QUANTITY: 1,
        STRATEGY_ENABLED: 'true',
        SERVICE_NAME: 'siggen-nq-aitrader'
      }
    },
    {
      name: 'macro-briefing',
      script: './macro-briefing/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
        PORT: 3017,
        BIND_HOST: '127.0.0.1'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3017,
        BIND_HOST: '127.0.0.1'
      }
    },
    {
      name: 'dashboard',
      script: '/usr/lib/node_modules/serve/build/main.js',
      args: '-s /mnt/c/projects/ereptor/slingshot/frontend/build -l 3020',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M'
    },
    {
      name: 'cloudflared',
      script: 'cloudflared',
      args: 'tunnel run slingshot-dashboard',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      restart_delay: 5000
    }
  ]
};