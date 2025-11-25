import express from 'express';
import cors from 'cors';
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';
import WebhookRelayService from './webhookRelay.js';

const SERVICE_NAME = 'webhook-gateway';
const logger = createLogger(SERVICE_NAME);

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3010 });

// Initialize Webhook Relay Service
const webhookRelay = new WebhookRelayService();

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request ID middleware for tracking
let requestCounter = 0;
app.use((req, res, next) => {
  req.id = `${Date.now()}-${++requestCounter}`;
  req.receivedAt = new Date().toISOString();
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = await healthCheck(SERVICE_NAME, {
    messageBus: messageBus.isConnected,
    requestsProcessed: requestCounter
  });
  res.json(health);
});

// Webhook type detection
function detectWebhookType(body) {
  // Check explicit webhook_type field first (preferred method)
  if (body.webhook_type) {
    return body.webhook_type;
  }

  // Fallback to content-based detection
  if (body.type === 'quote_update' || body.source === 'tradingview') {
    return 'quote';
  }

  if (body.action || body.orderAction || body.side) {
    return 'trade_signal';
  }

  return 'unknown';
}

// Main webhook endpoint
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();

  try {
    logger.info(`Webhook received: ${req.id}`, {
      headers: req.headers,
      bodySize: JSON.stringify(req.body).length
    });

    // Quick validation
    if (!req.body || Object.keys(req.body).length === 0) {
      logger.warn(`Empty webhook body: ${req.id}`);
      res.status(400).json({ error: 'Empty request body' });
      return;
    }

    const webhookType = detectWebhookType(req.body);
    logger.info(`Detected webhook type: ${webhookType} for request ${req.id}`);

    // Prepare webhook message
    const webhookMessage = {
      id: req.id,
      receivedAt: req.receivedAt,
      type: webhookType,
      source: req.headers['x-source'] || 'unknown',
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      body: req.body,
      headers: req.headers
    };

    // Route to appropriate service
    if (messageBus.isConnected) {
      switch(webhookType) {
        case 'quote':
          await messageBus.publish(CHANNELS.WEBHOOK_QUOTE, webhookMessage);
          logger.info(`Quote webhook routed to market-data-service: ${req.id}`);
          break;

        case 'trade_signal':
          await messageBus.publish(CHANNELS.WEBHOOK_TRADE, webhookMessage);
          logger.info(`Trade signal webhook routed to tradovate-service: ${req.id}`);
          break;

        default:
          await messageBus.publish(CHANNELS.WEBHOOK_RECEIVED, webhookMessage);
          logger.warn(`Unknown webhook type routed to generic handler: ${req.id}`);
          break;
      }
    } else {
      logger.error(`Message bus not connected, webhook dropped: ${req.id}`);
      res.status(503).json({ error: 'Service temporarily unavailable' });
      return;
    }

    // Send immediate response
    const processingTime = Date.now() - startTime;
    res.status(200).json({
      status: 'accepted',
      id: req.id,
      type: webhookType,
      processingTime: `${processingTime}ms`
    });

    logger.info(`Webhook processed: ${req.id} (${webhookType}) in ${processingTime}ms`);
  } catch (error) {
    logger.error(`Error processing webhook: ${req.id}`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy autotrader endpoint compatibility
app.post('/autotrader', async (req, res) => {
  logger.info('Legacy autotrader webhook received');

  // Forward to main webhook handler
  req.headers['x-source'] = 'autotrader-legacy';
  return app._router.handle(Object.assign(req, { url: '/webhook', method: 'POST' }), res);
});

// Generic slingshot endpoint for all TradingView webhooks
app.post('/slingshot', async (req, res) => {
  logger.info('Slingshot webhook received on dedicated endpoint');

  // Forward to main webhook handler with source identification
  req.headers['x-source'] = 'slingshot-endpoint';
  return app._router.handle(Object.assign(req, { url: '/webhook', method: 'POST' }), res);
});

// Quote-specific endpoint for better organization (legacy compatibility)
app.post('/quote', async (req, res) => {
  logger.info('Quote webhook received on legacy endpoint');

  // Add quote identifier and forward to main webhook handler
  req.body.webhook_type = 'quote';
  req.headers['x-source'] = 'quote-endpoint-legacy';
  return app._router.handle(Object.assign(req, { url: '/webhook', method: 'POST' }), res);
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Set up webhook relay event handlers
webhookRelay.on('started', (info) => {
  logger.info(`Webhook relay started successfully: PID ${info.pid}`);
});

webhookRelay.on('connected', () => {
  logger.info('Webhook relay connected to webhookrelay.com');
});

webhookRelay.on('urlDetected', (url) => {
  logger.info(`Webhook relay URL: ${url}`);
});

webhookRelay.on('exit', (info) => {
  logger.warn(`Webhook relay exited: code ${info.code}`);
});

webhookRelay.on('error', (error) => {
  logger.error(`Webhook relay error: ${error.message}`);
});

// Startup sequence
async function startup() {
  try {
    logger.info(`Starting ${SERVICE_NAME}...`);

    // Connect to message bus
    logger.info('Connecting to message bus...');
    await messageBus.connect();
    logger.info('Message bus connected');

    // Initialize webhook relay
    logger.info('Initializing webhook relay...');
    await webhookRelay.initialize();
    logger.info('Webhook relay initialized');

    // Publish startup event
    await messageBus.publish(CHANNELS.SERVICE_STARTED, {
      service: SERVICE_NAME,
      port: config.service.port,
      timestamp: new Date().toISOString()
    });

    // Start Express server
    const server = app.listen(config.service.port, config.service.host, () => {
      logger.info(`${SERVICE_NAME} listening on ${config.service.host}:${config.service.port}`);
      logger.info(`Environment: ${config.service.env}`);
      logger.info(`Health check: http://localhost:${config.service.port}/health`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received, starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop webhook relay
      logger.info('Stopping webhook relay...');
      webhookRelay.dispose();

      // Publish shutdown event
      try {
        await messageBus.publish(CHANNELS.SERVICE_STOPPED, {
          service: SERVICE_NAME,
          reason: signal,
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

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection:', reason);
      shutdown('unhandledRejection');
    });

  } catch (error) {
    logger.error('Startup failed:', error);
    process.exit(1);
  }
}

// Start the service
startup();