module.exports = {
  apps: [
    {
      name: 'webhook-gateway',
      script: './webhook-gateway/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3010
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3010
      }
    },
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
        PORT: 3011
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3011
      }
    },
    {
      name: 'market-data-service',
      script: './market-data-service/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3015
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3015
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
        PORT: 3013
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3013
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
        PORT: 3014
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3014
      }
    }
  ]
};