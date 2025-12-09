import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';
import { CandleAggregator, TIMEFRAMES } from './utils/candle-aggregator.js';
import { TimeframeBuffer } from './utils/timeframe-buffer.js';
import { SMACrossoverStrategy } from './strategies/sma-crossover.js';

const SERVICE_NAME = 'signal-generator';
const logger = createLogger(SERVICE_NAME);

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3015 });

// Service state
const serviceState = {
  strategies: [],
  aggregator: new CandleAggregator(),
  buffers: new TimeframeBuffer(200),
  stats: {
    ticksProcessed: 0,
    candlesGenerated: 0,
    signalsGenerated: 0,
    signalsSent: 0,
    signalsFailed: 0,
    startTime: new Date().toISOString()
  },
  lastTick: null,
  webhookEndpoint: process.env.WEBHOOK_ENDPOINT || 'http://localhost:3014/webhook',
  webhookSecret: process.env.WEBHOOK_SECRET || ''
};

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = await healthCheck(SERVICE_NAME, {
    messageBus: messageBus.isConnected,
    strategies: serviceState.strategies.length,
    activeBuffers: serviceState.buffers.getStats().activeBuffers,
    ticksProcessed: serviceState.stats.ticksProcessed,
    signalsGenerated: serviceState.stats.signalsGenerated,
    lastTick: serviceState.lastTick
  }, messageBus);
  res.json(health);
});

// API Endpoints
app.get('/api/strategies', (req, res) => {
  res.json(serviceState.strategies.map(s => s.getInfo()));
});

app.get('/api/stats', (req, res) => {
  res.json({
    ...serviceState.stats,
    buffers: serviceState.buffers.getStats(),
    aggregator: serviceState.aggregator.getActiveCandles(),
    uptime: Math.floor((Date.now() - new Date(serviceState.stats.startTime).getTime()) / 1000)
  });
});

app.get('/api/buffers/:symbol/:timeframe', (req, res) => {
  const { symbol, timeframe } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const history = serviceState.buffers.getHistory(symbol.toUpperCase(), timeframe, limit);
  res.json(history);
});

app.post('/api/strategies/:name/enable', (req, res) => {
  const strategy = serviceState.strategies.find(s => s.name === req.params.name);
  if (strategy) {
    strategy.config.enabled = true;
    res.json({ success: true, strategy: strategy.getInfo() });
  } else {
    res.status(404).json({ error: 'Strategy not found' });
  }
});

app.post('/api/strategies/:name/disable', (req, res) => {
  const strategy = serviceState.strategies.find(s => s.name === req.params.name);
  if (strategy) {
    strategy.config.enabled = false;
    res.json({ success: true, strategy: strategy.getInfo() });
  } else {
    res.status(404).json({ error: 'Strategy not found' });
  }
});

app.post('/api/strategies/:name/config', (req, res) => {
  const strategy = serviceState.strategies.find(s => s.name === req.params.name);
  if (strategy) {
    strategy.updateConfig(req.body);
    res.json({ success: true, strategy: strategy.getInfo() });
  } else {
    res.status(404).json({ error: 'Strategy not found' });
  }
});

// Send signal to webhook endpoint
async function sendSignalToWebhook(signal) {
  try {
    // Add webhook secret to signal
    const signalWithAuth = {
      ...signal,
      secret: serviceState.webhookSecret
    };

    logger.info(`📤 Sending signal to webhook: ${signal.side} ${signal.symbol} @ ${signal.price}`);

    const response = await axios.post(serviceState.webhookEndpoint, signalWithAuth, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Source': SERVICE_NAME
      }
    });

    serviceState.stats.signalsSent++;
    logger.info(`✅ Signal accepted by webhook: ${response.data.id || 'success'}`);
    return response.data;

  } catch (error) {
    serviceState.stats.signalsFailed++;
    logger.error(`❌ Failed to send signal to webhook: ${error.message}`);
    throw error;
  }
}

// Process completed candles through strategies
async function processCandle(candle) {
  const { symbol, baseSymbol, timeframe } = candle;
  const targetSymbol = baseSymbol || symbol;

  // Add candle to buffer
  serviceState.buffers.addCandle(targetSymbol, timeframe, candle);
  serviceState.stats.candlesGenerated++;

  // Run strategies that match this timeframe
  for (const strategy of serviceState.strategies) {
    if (!strategy.config.enabled) continue;
    if (strategy.config.timeframe !== timeframe) continue;
    if (!strategy.shouldProcessSymbol(targetSymbol)) continue;

    // Get history for this strategy
    const history = serviceState.buffers.getHistory(
      targetSymbol,
      timeframe,
      strategy.config.historyRequired
    );

    // Check if we have enough history
    if (history.length < strategy.config.historyRequired) {
      logger.debug(`⏳ Strategy ${strategy.name} waiting for history: ${history.length}/${strategy.config.historyRequired} candles`);
      continue;
    }

    try {
      // Remove current candle from history (strategy expects history without current)
      const historyWithoutCurrent = history.slice(0, -1);
      const signal = strategy.analyze(candle, historyWithoutCurrent, targetSymbol);

      if (signal) {
        serviceState.stats.signalsGenerated++;
        logger.info(`🎯 Signal generated by ${strategy.name}: ${signal.side} ${targetSymbol} on ${timeframe} chart`);

        // Send signal to webhook
        await sendSignalToWebhook(signal);
      }
    } catch (error) {
      logger.error(`Strategy ${strategy.name} error:`, error.message);
    }
  }
}

// Handle incoming price updates from Redis
async function handlePriceUpdate(message) {
  try {
    serviceState.stats.ticksProcessed++;
    serviceState.lastTick = {
      symbol: message.symbol,
      price: message.close,
      timestamp: message.timestamp
    };

    // Log every 10th tick to avoid spam
    if (serviceState.stats.ticksProcessed % 10 === 0) {
      logger.debug(`📊 Processing tick #${serviceState.stats.ticksProcessed}: ${message.baseSymbol || message.symbol} = ${message.close}`);
    }

    // Process tick through aggregator
    const completedCandles = serviceState.aggregator.processTick(
      message.baseSymbol || message.symbol,
      message,
      message.timestamp
    );

    // Process each completed candle
    for (const candle of completedCandles) {
      await processCandle(candle);
    }

  } catch (error) {
    logger.error('Failed to process price update:', error);
  }
}

// Load strategy configuration from Redis
async function loadStrategyConfig() {
  try {
    const data = await messageBus.publisher.get('config:signal-strategies');
    if (data) {
      const config = JSON.parse(data);
      logger.info('✅ Strategy configuration loaded from Redis');
      return config;
    }
  } catch (error) {
    logger.error('Failed to load strategy config from Redis:', error);
  }

  // Return default configuration
  const defaults = {
    strategies: [
      {
        name: 'sma_1m',
        type: 'sma-crossover',
        enabled: true,
        timeframe: '1m',
        parameters: {
          period: 20,
          stopLoss: 10,
          takeProfit: 100,
          trailingTrigger: 10,
          trailingOffset: 5,
          quantity: 1
        }
      },
      {
        name: 'sma_5m',
        type: 'sma-crossover',
        enabled: false,
        timeframe: '5m',
        parameters: {
          period: 20,
          stopLoss: 15,
          takeProfit: 150,
          trailingTrigger: 15,
          trailingOffset: 7,
          quantity: 1
        }
      }
    ]
  };

  // Save defaults to Redis
  try {
    await messageBus.publisher.set('config:signal-strategies', JSON.stringify(defaults));
    logger.info('📝 Default strategy configuration saved to Redis');
  } catch (error) {
    logger.error('Failed to save default config to Redis:', error);
  }

  return defaults;
}

// Initialize strategies from configuration
async function initializeStrategies() {
  const config = await loadStrategyConfig();

  for (const strategyConfig of config.strategies) {
    if (strategyConfig.type === 'sma-crossover') {
      const strategy = new SMACrossoverStrategy({
        name: strategyConfig.name,
        enabled: strategyConfig.enabled,
        timeframe: strategyConfig.timeframe,
        ...strategyConfig.parameters
      });

      serviceState.strategies.push(strategy);
      logger.info(`📈 Loaded strategy: ${strategy.name} (${strategy.config.timeframe} timeframe, ${strategy.config.enabled ? 'enabled' : 'disabled'})`);
    }
  }

  logger.info(`✅ Loaded ${serviceState.strategies.length} strategies`);
}

// Startup sequence
async function startup() {
  try {
    logger.info(`Starting ${SERVICE_NAME}...`);

    // Connect to message bus
    logger.info('Connecting to message bus...');
    await messageBus.connect();
    logger.info('Message bus connected');

    // Initialize strategies
    await initializeStrategies();

    // Subscribe to price updates
    await messageBus.subscribe(CHANNELS.PRICE_UPDATE, handlePriceUpdate);
    logger.info(`Subscribed to ${CHANNELS.PRICE_UPDATE} channel`);

    // Log available timeframes
    logger.info('📊 Available timeframes:', Object.keys(TIMEFRAMES).join(', '));

    // Publish startup event
    await messageBus.publish(CHANNELS.SERVICE_STARTED, {
      service: SERVICE_NAME,
      port: config.service.port,
      strategies: serviceState.strategies.length,
      timeframes: Object.keys(TIMEFRAMES),
      timestamp: new Date().toISOString()
    });

    // Start Express server
    const bindHost = process.env.BIND_HOST || '127.0.0.1';
    const server = app.listen(config.service.port, bindHost, () => {
      logger.info(`${SERVICE_NAME} listening on ${bindHost}:${config.service.port}`);
      logger.info(`Environment: ${config.service.env}`);
      logger.info(`Health check: http://localhost:${config.service.port}/health`);
      logger.info(`Strategies API: http://localhost:${config.service.port}/api/strategies`);
      logger.info(`Stats API: http://localhost:${config.service.port}/api/stats`);
      logger.info(`Webhook target: ${serviceState.webhookEndpoint}`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received, starting graceful shutdown...`);

      // Close any active candles
      const closedCandles = serviceState.aggregator.closeAllCandles();
      logger.info(`Closed ${closedCandles.length} active candles`);

      // Stop Express server
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Publish shutdown event
      try {
        await messageBus.publish(CHANNELS.SERVICE_STOPPED, {
          service: SERVICE_NAME,
          reason: signal,
          stats: serviceState.stats,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Failed to publish shutdown event:', error);
      }

      // Disconnect from message bus
      await messageBus.disconnect();
      logger.info('Message bus disconnected');

      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error('Startup failed:', error);
    process.exit(1);
  }
}

// Start the service
startup();