const CWD = '/home/drew/projects/slingshot-services';

module.exports = {
  apps: [
    {
      name: 'tradovate-service',
      script: './tradovate-service/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3011,
        BIND_HOST: '127.0.0.1'
      }
    },
    {
      name: 'trade-orchestrator',
      script: './trade-orchestrator/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3013,
        BIND_HOST: '127.0.0.1'
      }
    },
    {
      name: 'monitoring-service',
      script: './monitoring-service/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3014,
        BIND_HOST: '0.0.0.0'
      }
    },
    {
      name: 'data-service',
      script: './data-service/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3019,
        BIND_HOST: '127.0.0.1',
        SERVICE_NAME: 'data-service',
        HYBRID_GEX_ENABLED: 'true'
      }
    },
    {
      name: 'signal-generator',
      script: './signal-generator/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        HTTP_PORT: 3015,
        LOG_LEVEL: 'info',
        STRATEGY_ENABLED: 'true',
        SERVICE_NAME: 'signal-generator'
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
