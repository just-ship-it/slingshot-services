import dotenv from 'dotenv';
import path from 'path';
import { existsSync } from 'fs';

class ConfigManager {
  constructor() {
    this.config = {};
    this.loaded = false;
  }

  loadConfig(serviceName, options = {}) {
    if (this.loaded && !options.reload) {
      return this.config;
    }

    // Load environment variables from multiple sources
    const envPaths = [
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), `.env.${process.env.NODE_ENV || 'development'}`),
      path.join(process.cwd(), 'shared', '.env'),  // For PM2 running from root
      path.join(process.cwd(), '..', 'shared', '.env')  // For running from service dir
    ];

    envPaths.forEach(envPath => {
      if (existsSync(envPath)) {
        dotenv.config({ path: envPath, override: false });
      }
    });

    // Service-specific configuration
    this.config = {
      service: {
        name: serviceName,
        port: process.env.PORT || process.env[`${serviceName.toUpperCase().replace(/-/g, '_')}_PORT`] || options.defaultPort,
        host: process.env.HOST || '0.0.0.0',
        env: process.env.NODE_ENV || 'development'
      },
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0')
      },
      tradovate: {
        useDemo: process.env.TRADOVATE_USE_DEMO === 'true',
        demoUrl: process.env.TRADOVATE_DEMO_URL || 'https://demo.tradovateapi.com/v1',
        liveUrl: process.env.TRADOVATE_LIVE_URL || 'https://live.tradovateapi.com/v1',
        wssDemoUrl: process.env.TRADOVATE_WSS_DEMO_URL || 'wss://demo.tradovateapi.com/v1',
        wssLiveUrl: process.env.TRADOVATE_WSS_LIVE_URL || 'wss://live.tradovateapi.com/v1',
        username: process.env.TRADOVATE_USERNAME,
        password: process.env.TRADOVATE_PASSWORD,
        appId: process.env.TRADOVATE_APP_ID || serviceName,
        appVersion: process.env.TRADOVATE_APP_VERSION || '1.0.0',
        deviceId: process.env.TRADOVATE_DEVICE_ID || `${serviceName}-${Date.now()}`,
        cid: process.env.TRADOVATE_CID,
        secret: process.env.TRADOVATE_SECRET,
        defaultAccountId: process.env.TRADOVATE_DEFAULT_ACCOUNT_ID
      },
      logging: {
        level: process.env.LOG_LEVEL || 'info',
        dir: process.env.LOG_DIR || path.join(process.cwd(), 'logs')
      },
      ...options.additionalConfig
    };

    this.loaded = true;
    return this.config;
  }

  get(key) {
    const keys = key.split('.');
    let value = this.config;

    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) {
        return undefined;
      }
    }

    return value;
  }

  set(key, value) {
    const keys = key.split('.');
    let obj = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!obj[k]) {
        obj[k] = {};
      }
      obj = obj[k];
    }

    obj[keys[keys.length - 1]] = value;
  }

  getAll() {
    return { ...this.config };
  }
}

const configManager = new ConfigManager();

export default configManager;