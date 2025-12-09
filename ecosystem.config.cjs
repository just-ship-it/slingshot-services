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
        PORT: 3012,
        BIND_HOST: '127.0.0.1'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3012,
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
      name: 'signal-generator',
      script: './signal-generator/index.js',
      cwd: '/home/drew/projects/slingshot-services',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3015,
        BIND_HOST: '127.0.0.1'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3015,
        BIND_HOST: '127.0.0.1'
      }
    }
  ]
};