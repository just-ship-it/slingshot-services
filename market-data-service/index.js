import express from 'express';
import cors from 'cors';
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';

const SERVICE_NAME = 'market-data-service';
const logger = createLogger(SERVICE_NAME);

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3015 });

// Market data service now operates in webhook-only mode

// Market data state
const marketDataState = {
  quotes: new Map(),
  contracts: new Map(),
  subscriptions: new Set(),
  lastUpdate: null
};

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = await healthCheck(SERVICE_NAME, {
    messageBus: messageBus.isConnected,
    webhookMode: true,
    activeSubscriptions: marketDataState.subscriptions.size,
    quotesReceived: marketDataState.quotes.size
  }, messageBus);
  res.json(health);
});

// REST API Endpoints
app.get('/api/quotes', (req, res) => {
  res.json(Object.fromEntries(marketDataState.quotes));
});

app.get('/api/quotes/:symbol', (req, res) => {
  const quote = marketDataState.quotes.get(req.params.symbol);
  if (quote) {
    res.json(quote);
  } else {
    res.status(404).json({ error: 'Quote not found' });
  }
});

app.get('/api/contracts', (req, res) => {
  res.json(Object.fromEntries(marketDataState.contracts));
});

app.get('/api/subscriptions', (req, res) => {
  res.json(Array.from(marketDataState.subscriptions));
});

// Market data now comes via webhooks - old WebSocket handlers removed

// Webhook quote handler function (to be subscribed after message bus connects)
async function handleWebhookQuote(webhookMessage) {
  try {
    const body = webhookMessage.body;

    // Check if this is a batch format (NinjaTrader)
    if (body.webhook_type === 'quote' && body.type === 'quote_batch' && body.quotes) {
      logger.debug(`📡 Received quote batch with ${body.quotes.length} quotes from ${body.source || 'unknown'}`);

      const processed = [];

      for (const quote of body.quotes) {
        if (!quote.baseSymbol || quote.close === undefined) {
          logger.warn(`Skipping invalid quote in batch: ${JSON.stringify(quote)}`);
          continue;
        }

        const processedQuote = {
          symbol: quote.symbol || quote.baseSymbol,
          baseSymbol: quote.baseSymbol,
          contractId: quote.contractId || quote.symbol || quote.baseSymbol,
          name: quote.name || quote.symbol || quote.baseSymbol,
          open: quote.open ?? null,
          high: quote.high ?? null,
          low: quote.low ?? null,
          close: quote.close ?? null,
          previousClose: quote.previousClose ?? null,
          volume: quote.volume ?? null,
          timestamp: body.timestamp || new Date().toISOString(),
          source: body.source || 'ninjatrader'
        };

        marketDataState.quotes.set(processedQuote.baseSymbol, processedQuote);

        if (!marketDataState.subscriptions.has(processedQuote.baseSymbol)) {
          marketDataState.subscriptions.add(processedQuote.baseSymbol);
        }

        await messageBus.publish(CHANNELS.PRICE_UPDATE, {
          symbol: processedQuote.symbol,
          baseSymbol: processedQuote.baseSymbol,
          open: processedQuote.open,
          high: processedQuote.high,
          low: processedQuote.low,
          close: processedQuote.close,
          previousClose: processedQuote.previousClose,
          volume: processedQuote.volume,
          timestamp: processedQuote.timestamp,
          source: processedQuote.source
        });

        processed.push(processedQuote.baseSymbol);
      }

      marketDataState.lastUpdate = new Date().toISOString();
      logger.debug(`📊 Processed batch via webhook: ${processed.join(', ')}`);
      return;
    }

    // Handle single quote (TradingView format)
    const quote = body;

    logger.debug(`📡 Received webhook quote for ${quote.baseSymbol} (${quote.symbol}): ${quote.close}`);

    // Validate required fields
    if (!quote.symbol || !quote.baseSymbol || quote.close === undefined) {
      logger.error('Invalid webhook quote data - missing required fields');
      return;
    }

    // Process the quote update with OHLC data
    const processedQuote = {
      symbol: quote.symbol,
      baseSymbol: quote.baseSymbol,
      contractId: quote.contractId || quote.symbol,
      name: quote.name || quote.symbol,
      open: quote.open || null,
      high: quote.high || null,
      low: quote.low || null,
      close: quote.close || null,
      previousClose: quote.previousClose || null,
      volume: quote.volume || null,
      timestamp: quote.timestamp || new Date().toISOString(),
      source: quote.source || 'tradingview'
    };

    // Store quote in local state
    marketDataState.quotes.set(processedQuote.baseSymbol, processedQuote);
    marketDataState.lastUpdate = new Date().toISOString();

    // Add to subscriptions if not already present
    if (!marketDataState.subscriptions.has(processedQuote.baseSymbol)) {
      marketDataState.subscriptions.add(processedQuote.baseSymbol);
    }

    // Publish to message bus for other services
    await messageBus.publish(CHANNELS.PRICE_UPDATE, {
      symbol: processedQuote.symbol,
      baseSymbol: processedQuote.baseSymbol,
      open: processedQuote.open,
      high: processedQuote.high,
      low: processedQuote.low,
      close: processedQuote.close,
      previousClose: processedQuote.previousClose,
      volume: processedQuote.volume,
      timestamp: processedQuote.timestamp,
      source: processedQuote.source
    });

    logger.debug(`📊 Published webhook price update for ${processedQuote.baseSymbol}: ${processedQuote.close}`);

  } catch (error) {
    logger.error('Failed to process webhook quote:', error.message);
  }
}

// Contract resolution no longer needed - quotes come via webhooks

// Manual subscription no longer needed - quotes come via webhooks
// Endpoint kept for API compatibility but returns webhook mode message
app.post('/api/subscribe/:symbol', async (req, res) => {
  const baseSymbol = req.params.symbol.toUpperCase();

  res.json({
    success: true,
    baseSymbol,
    mode: 'webhook',
    message: 'Market data service operates in webhook mode. Quotes received via TradingView webhooks.',
    timestamp: new Date().toISOString()
  });
});

// Webhook endpoint for TradingView quote updates
app.post('/api/webhook/quote', async (req, res) => {
  try {
    const quote = req.body;

    // Validate required fields
    if (!quote.symbol || !quote.baseSymbol || quote.close === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: symbol, baseSymbol, or close price'
      });
    }

    logger.debug(`📈 Received TradingView quote for ${quote.baseSymbol} (${quote.symbol}): ${quote.close}`);

    // Process the quote update with OHLC data
    const processedQuote = {
      symbol: quote.symbol,
      baseSymbol: quote.baseSymbol,
      contractId: quote.contractId || quote.symbol,
      name: quote.name || quote.symbol,
      open: quote.open || null,
      high: quote.high || null,
      low: quote.low || null,
      close: quote.close || null,
      previousClose: quote.previousClose || null,
      volume: quote.volume || null,
      timestamp: quote.timestamp || new Date().toISOString(),
      source: quote.source || 'tradingview'
    };

    // Store quote in local state
    marketDataState.quotes.set(processedQuote.baseSymbol, processedQuote);
    marketDataState.lastUpdate = new Date().toISOString();

    // Add to subscriptions if not already present
    if (!marketDataState.subscriptions.has(processedQuote.baseSymbol)) {
      marketDataState.subscriptions.add(processedQuote.baseSymbol);
    }

    // Publish to message bus for other services
    await messageBus.publish(CHANNELS.PRICE_UPDATE, {
      symbol: processedQuote.symbol,
      baseSymbol: processedQuote.baseSymbol,
      open: processedQuote.open,
      high: processedQuote.high,
      low: processedQuote.low,
      close: processedQuote.close,
      previousClose: processedQuote.previousClose,
      volume: processedQuote.volume,
      timestamp: processedQuote.timestamp,
      source: processedQuote.source
    });

    logger.debug(`📊 Published TradingView price update for ${processedQuote.baseSymbol}: ${processedQuote.last}`);

    res.json({
      success: true,
      symbol: processedQuote.symbol,
      baseSymbol: processedQuote.baseSymbol,
      received: true,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to process TradingView webhook:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Webhook endpoint for batched quote updates (NinjaTrader)
app.post('/api/webhook/quote-batch', async (req, res) => {
  try {
    const { webhook_type, type, quotes, timestamp, source } = req.body;

    // Validate webhook format
    if (webhook_type !== 'quote' || type !== 'quote_batch') {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook format. Expected webhook_type: "quote" and type: "quote_batch"'
      });
    }

    if (!quotes || !Array.isArray(quotes) || quotes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid quotes array'
      });
    }

    logger.debug(`📈 Received ${type} with ${quotes.length} quotes from ${source || 'unknown'}`);

    const processed = [];

    for (const quote of quotes) {
      if (!quote.baseSymbol || quote.close === undefined) {
        logger.warn(`Skipping invalid quote in batch: ${JSON.stringify(quote)}`);
        continue;
      }

      const processedQuote = {
        symbol: quote.symbol || quote.baseSymbol,
        baseSymbol: quote.baseSymbol,
        contractId: quote.contractId || quote.symbol || quote.baseSymbol,
        name: quote.name || quote.symbol || quote.baseSymbol,
        open: quote.open ?? null,
        high: quote.high ?? null,
        low: quote.low ?? null,
        close: quote.close ?? null,
        previousClose: quote.previousClose ?? null,
        volume: quote.volume ?? null,
        timestamp: timestamp || new Date().toISOString(),
        source: source || 'ninjatrader'
      };

      marketDataState.quotes.set(processedQuote.baseSymbol, processedQuote);

      if (!marketDataState.subscriptions.has(processedQuote.baseSymbol)) {
        marketDataState.subscriptions.add(processedQuote.baseSymbol);
      }

      await messageBus.publish(CHANNELS.PRICE_UPDATE, {
        symbol: processedQuote.symbol,
        baseSymbol: processedQuote.baseSymbol,
        open: processedQuote.open,
        high: processedQuote.high,
        low: processedQuote.low,
        close: processedQuote.close,
        previousClose: processedQuote.previousClose,
        volume: processedQuote.volume,
        timestamp: processedQuote.timestamp,
        source: processedQuote.source
      });

      processed.push(processedQuote.baseSymbol);
    }

    marketDataState.lastUpdate = new Date().toISOString();

    logger.debug(`📊 Processed batch: ${processed.join(', ')}`);

    res.json({
      success: true,
      webhook_type: 'quote',
      type: 'quote_batch_response',
      processed: processed.length,
      symbols: processed,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to process batch webhook:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Symbol initialization no longer needed - quotes come via webhooks

// Startup sequence
async function startup() {
  try {
    logger.info(`Starting ${SERVICE_NAME}...`);

    // Connect to message bus
    logger.info('Connecting to message bus...');
    await messageBus.connect();
    logger.info('Message bus connected');

    // Subscribe to webhook quote updates from the gateway
    await messageBus.subscribe(CHANNELS.WEBHOOK_QUOTE, handleWebhookQuote);
    logger.info('Subscribed to webhook quote updates');

    // Running in webhook-only mode - no Tradovate WebSocket connection needed
    logger.info('📡 Running in webhook-only mode - receiving quotes via webhooks');
    logger.info('💡 Quotes flow: TradingView → webhook-gateway → market-data-service');

    // Publish startup event
    await messageBus.publish(CHANNELS.SERVICE_STARTED, {
      service: SERVICE_NAME,
      port: config.service.port,
      webhookMode: true,
      subscriptions: Array.from(marketDataState.subscriptions),
      timestamp: new Date().toISOString()
    });

    // Start Express server - bind to localhost only for internal access
    const bindHost = process.env.BIND_HOST || '127.0.0.1';
    const server = app.listen(config.service.port, bindHost, () => {
      logger.info(`${SERVICE_NAME} listening on ${bindHost}:${config.service.port}`);
      logger.info(`Environment: ${config.service.env}`);
      logger.info(`Market Data Mode: WEBHOOK`);
      logger.info(`Health check: http://localhost:${config.service.port}/health`);
      logger.info(`Quotes API: http://localhost:${config.service.port}/api/quotes`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received, starting graceful shutdown...`);

      // Stop Express server
      server.close(() => {
        logger.info('HTTP server closed');
      });

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

  } catch (error) {
    logger.error('Startup failed:', error);
    process.exit(1);
  }
}

// Start the service
startup();
