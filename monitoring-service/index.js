import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
// File system imports removed - using Redis for persistence
import axios from 'axios';
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';

const SERVICE_NAME = 'monitoring-service';
const logger = createLogger(SERVICE_NAME);

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3014 });

// Auth secrets from environment
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Redis configuration keys
const POSITION_SIZING_KEY = 'config:position-sizing';
const CONTRACT_MAPPINGS_KEY = 'contracts:mappings';

// Position sizing Redis functions
async function loadPositionSizingSettings() {
  try {
    const data = await messageBus.publisher.get('config:position-sizing');
    if (data) {
      const settings = JSON.parse(data);
      logger.info('✅ Position sizing settings loaded from Redis:', settings);
      return settings;
    } else {
      logger.warn('⚠️ Position sizing config not found in Redis, will create with defaults');
    }
  } catch (error) {
    logger.error('❌ Error loading position sizing settings from Redis:', error);
  }

  // Return defaults if Redis key doesn't exist or error occurred
  const defaults = {
    method: 'fixed',
    fixedQuantity: 1,
    riskPercentage: 10,
    maxContracts: 10,
    contractType: 'micro'
  };
  logger.warn('📋 Using default position sizing settings (Redis missing or error):', defaults);

  logger.info('🆕 Creating new position sizing config in Redis with defaults');
  await savePositionSizingSettings(defaults, 'initial_redis_creation');
  return defaults;
}

async function savePositionSizingSettings(settings, reason = 'unknown') {
  try {
    // Get stack trace to see who called this function
    const stack = new Error().stack.split('\n').slice(1, 4).map(line => line.trim()).join(' → ');

    logger.info(`💾 Saving position sizing settings to Redis (reason: ${reason}):`, settings);
    logger.debug(`📍 Save called from: ${stack}`);

    await messageBus.publisher.set('config:position-sizing', JSON.stringify(settings));
    logger.info('✅ Position sizing settings successfully saved to Redis');
    return true;
  } catch (error) {
    logger.error('❌ Failed to save position sizing settings to Redis:', error);
    return false;
  }
}

// Contract mappings Redis functions
async function loadContractMappings() {
  try {
    const data = await messageBus.publisher.get('contracts:mappings');
    if (data) {
      const mappings = JSON.parse(data);
      logger.info('Contract mappings loaded from Redis:', mappings);
      return mappings;
    }
  } catch (error) {
    logger.error('Error loading contract mappings from Redis:', error);
  }

  // Return defaults if Redis key doesn't exist or error occurred
  const defaults = {
    lastUpdated: new Date().toISOString(),
    currentContracts: {
      'NQ': 'NQZ5',
      'MNQ': 'MNQZ5',
      'ES': 'ESZ5',
      'MES': 'MESZ5'
    },
    pointValues: {
      'NQ': 20,
      'MNQ': 2,
      'ES': 50,
      'MES': 5
    },
    tickSize: 0.25,
    notes: 'Default contract mappings - store in Redis for rollover updates'
  };

  // Save defaults to Redis for future use
  try {
    await messageBus.publisher.set('contracts:mappings', JSON.stringify(defaults));
    logger.info('✅ Default contract mappings saved to Redis');
  } catch (error) {
    logger.error('❌ Failed to save default contract mappings to Redis:', error);
  }

  logger.warn('Using default contract mappings:', defaults);
  return defaults;
}

// Monitoring state - trigger redeploy
const monitoringState = {
  accounts: new Map(),
  positions: new Map(),
  orders: new Map(),
  prices: new Map(),
  services: new Map(),
  activity: [],
  maxActivitySize: 1000,
  positionSizing: null, // Will be loaded async on startup
  contractMappings: null // Will be loaded async on startup
};

/**
 * Parse TradingView symbol to extract base contract type
 * Handles variations like: NQ, NQ!, NQ1, NQ1!, NQH4, NQZ23, etc.
 * Returns: NQ, MNQ, ES, MES
 */
function parseBaseSymbol(symbol) {
  // Extract base symbol using regex - everything before numbers/special chars
  const match = symbol.toUpperCase().match(/^(NQ|MNQ|ES|MES)/);
  if (match) {
    return match[1];
  }

  // Fallback: remove all numbers and special characters
  const fallback = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  logger.warn(`Unknown symbol pattern for ${symbol}, using fallback: ${fallback}`);
  return fallback;
}

/**
 * Get account balance for risk-based calculations
 */
function getAccountBalance() {
  // Try to get from account state first
  const accounts = Array.from(monitoringState.accounts.values());
  if (accounts.length > 0 && accounts[0].netLiquidatingValue) {
    return accounts[0].netLiquidatingValue;
  }

  // Default fallback - this should be configurable
  logger.warn('Using default account balance for risk calculations');
  return 100000; // $100k default
}

/**
 * Complete position sizing conversion logic
 * Handles both fixed contracts and risk-based sizing
 */
function convertPositionSize(originalSymbol, originalQuantity, action, settings, entryPrice = null, stopLoss = null) {
  const mappings = monitoringState.contractMappings;
  let converted = false;
  let reason = 'No conversion needed';

  // Step 1: Parse base symbol from TradingView input
  const baseSymbol = parseBaseSymbol(originalSymbol);
  logger.info(`🔍 Parsed base symbol: ${originalSymbol} → ${baseSymbol}`);

  // Step 2: Check if we have mapping for this base symbol
  if (!mappings.currentContracts[baseSymbol]) {
    logger.error(`No contract mapping found for base symbol: ${baseSymbol}`);
    return {
      symbol: originalSymbol,
      quantity: originalQuantity,
      action,
      converted: false,
      reason: `Unknown base symbol: ${baseSymbol}`,
      error: true
    };
  }

  let targetSymbol;
  let targetQuantity = originalQuantity;

  // Step 3: Handle Fixed Contracts method
  if (settings.method === 'fixed') {
    // Use fixed quantity
    targetQuantity = settings.fixedQuantity;

    // Apply contract type override
    if (settings.contractType === 'auto') {
      // Auto: preserve original contract size
      if (baseSymbol.startsWith('M')) {
        // Micro symbol (MNQ, MES)
        const microBase = baseSymbol;
        targetSymbol = mappings.currentContracts[microBase];
        reason = `Fixed auto (micro preserved): ${originalSymbol} → ${targetSymbol}, qty: ${targetQuantity}`;
      } else {
        // Full symbol (NQ, ES)
        targetSymbol = mappings.currentContracts[baseSymbol];
        reason = `Fixed auto (full preserved): ${originalSymbol} → ${targetSymbol}, qty: ${targetQuantity}`;
      }
    } else if (settings.contractType === 'micro') {
      // Force micro contracts
      const microBase = baseSymbol.startsWith('M') ? baseSymbol : `M${baseSymbol}`;
      targetSymbol = mappings.currentContracts[microBase];
      reason = `Fixed micro forced: ${originalSymbol} → ${targetSymbol}, qty: ${targetQuantity}`;
    } else if (settings.contractType === 'full') {
      // Force full contracts
      const fullBase = baseSymbol.startsWith('M') ? baseSymbol.slice(1) : baseSymbol;
      targetSymbol = mappings.currentContracts[fullBase];
      reason = `Fixed full forced: ${originalSymbol} → ${targetSymbol}, qty: ${targetQuantity}`;
    }

    converted = (targetSymbol !== originalSymbol || targetQuantity !== originalQuantity);

  // Step 4: Handle Risk-Based Sizing method
  } else if (settings.method === 'risk_based') {
    if (!entryPrice || !stopLoss) {
      logger.warn('Risk-based sizing requires entry price and stop loss');
      return {
        symbol: originalSymbol,
        quantity: originalQuantity,
        action,
        converted: false,
        reason: 'Risk-based sizing requires entry price and stop loss',
        error: true
      };
    }

    const accountBalance = getAccountBalance();
    const riskAmount = accountBalance * (settings.riskPercentage / 100);
    const stopDistance = Math.abs(entryPrice - stopLoss);

    logger.info(`📊 Risk calculation: balance=${accountBalance}, risk%=${settings.riskPercentage}, riskAmount=${riskAmount}, stopDistance=${stopDistance}`);

    // Start with full contracts if possible
    let workingBase = baseSymbol.startsWith('M') ? baseSymbol.slice(1) : baseSymbol;
    let workingPointValue = mappings.pointValues[workingBase];
    let riskPerContract = stopDistance * workingPointValue;

    logger.info(`💰 Full contract risk: ${workingBase} @ $${workingPointValue}/pt = $${riskPerContract} per contract`);

    // Check if we need to downconvert to micro
    if (riskPerContract > riskAmount) {
      logger.info(`⚠️ Risk per contract ($${riskPerContract}) exceeds risk budget ($${riskAmount}), downconverting to micro`);
      workingBase = `M${workingBase}`;
      workingPointValue = mappings.pointValues[workingBase];
      riskPerContract = stopDistance * workingPointValue;
      logger.info(`🔄 Micro contract risk: ${workingBase} @ $${workingPointValue}/pt = $${riskPerContract} per contract`);
    }

    // Calculate position size
    targetQuantity = Math.floor(riskAmount / riskPerContract);
    targetQuantity = Math.min(targetQuantity, settings.maxContracts); // Apply max limit
    targetQuantity = Math.max(1, targetQuantity); // Ensure minimum 1 contract

    targetSymbol = mappings.currentContracts[workingBase];
    converted = true;
    reason = `Risk-based: ${originalSymbol} → ${targetSymbol}, qty: ${targetQuantity} (risk: $${riskPerContract.toFixed(0)}/contract, budget: $${riskAmount.toFixed(0)})`;

    logger.info(`📈 Final position: ${targetQuantity} contracts of ${targetSymbol}`);
  }

  logger.info(`🔄 Position sizing result: ${reason}`);

  return {
    symbol: targetSymbol,
    quantity: targetQuantity,
    action,
    originalSymbol,
    originalQuantity,
    converted,
    reason,
    settings: settings.method,
    error: false
  };
}

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

// Dashboard auth middleware
const dashboardAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Unauthorized dashboard access attempt - missing token');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);

  if (!DASHBOARD_SECRET || token !== DASHBOARD_SECRET) {
    logger.warn('Unauthorized dashboard access attempt - invalid token');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

// Webhook auth validation functions
function validateTradingViewWebhook(body) {
  if (!WEBHOOK_SECRET) {
    logger.warn('WEBHOOK_SECRET not configured, skipping TradingView webhook validation');
    return true;
  }

  if (!body.secret) {
    logger.warn('TradingView webhook missing secret field');
    return false;
  }

  return body.secret === WEBHOOK_SECRET;
}

function validateNinjaTraderWebhook(headers) {
  if (!WEBHOOK_SECRET) {
    logger.warn('WEBHOOK_SECRET not configured, skipping NinjaTrader webhook validation');
    return true;
  }

  const apiKey = headers['x-api-key'];

  if (!apiKey) {
    logger.warn('NinjaTrader webhook missing X-API-Key header');
    return false;
  }

  return apiKey === WEBHOOK_SECRET;
}

// Webhook type detection
function detectWebhookType(body) {
  // Check explicit webhook_type field first (preferred method)
  if (body.webhook_type) {
    // Normalize trading_signal to trade_signal for consistency
    if (body.webhook_type === 'trading_signal') {
      return 'trade_signal';
    }
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

// Create HTTP server
const server = createServer(app);

// Create Socket.IO server for real-time updates
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.debug('New Socket.IO client connected');

  // Send current state to new client
  socket.emit('initial_state', {
    accounts: Array.from(monitoringState.accounts.values()),
    positions: Array.from(monitoringState.positions.values()),
    services: Array.from(monitoringState.services.values()),
    activity: monitoringState.activity.slice(-100),
    quotes: Object.fromEntries(monitoringState.prices)
  });

  // Handle ping/pong
  socket.on('ping', (data) => {
    socket.emit('pong', data);
  });

  // Handle subscription requests
  socket.on('subscribe_account', (accountId) => {
    socket.join(`account_${accountId}`);
    logger.debug(`Client subscribed to account ${accountId}`);
  });

  socket.on('subscribe_quote', (symbol) => {
    socket.join(`quote_${symbol}`);
    logger.debug(`Client subscribed to quotes for ${symbol}`);
  });

  socket.on('disconnect', (reason) => {
    logger.debug('Socket.IO client disconnected:', reason);
  });

  socket.on('error', (error) => {
    logger.error('Socket.IO error:', error);
  });
});

// Broadcast to all Socket.IO clients
function broadcast(eventName, data) {
  const clientCount = io.engine.clientsCount;
  logger.debug(`📡 Broadcasting ${eventName} to ${clientCount} connected clients`);
  if (eventName === 'market_data') {
    logger.debug(`📊 Market data broadcast: ${data.baseSymbol || data.symbol} = ${data.close}`);
  }
  io.emit(eventName, data);
}

// Webhook endpoints (no auth required)
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();

  try {
    logger.debug(`Webhook received: ${req.id}`, {
      headers: req.headers,
      bodySize: JSON.stringify(req.body).length
    });

    // Quick validation
    if (!req.body || Object.keys(req.body).length === 0) {
      logger.warn(`Empty webhook body: ${req.id}`);
      res.status(400).json({ error: 'Empty request body' });
      return;
    }

    // Detect webhook source and validate
    const isNinjaTrader = req.headers['x-api-key'] !== undefined;
    const isTradingView = req.body.secret !== undefined;

    if (isNinjaTrader) {
      if (!validateNinjaTraderWebhook(req.headers)) {
        logger.warn(`Unauthorized NinjaTrader webhook: ${req.id}`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    } else if (isTradingView) {
      if (!validateTradingViewWebhook(req.body)) {
        logger.warn(`Unauthorized TradingView webhook: ${req.id}`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    const webhookType = detectWebhookType(req.body);
    if (webhookType === 'trade_signal') {
      logger.info(`Detected webhook type: ${webhookType} for request ${req.id}`);
    } else {
      logger.debug(`Detected webhook type: ${webhookType} for request ${req.id}`);
    }

    // Prepare webhook message
    const webhookMessage = {
      id: req.id,
      receivedAt: req.receivedAt,
      type: webhookType,
      source: req.headers['x-source'] || (isNinjaTrader ? 'ninjatrader' : isTradingView ? 'tradingview' : 'unknown'),
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
          logger.debug(`Quote webhook routed to market-data-service: ${req.id}`);
          break;

        case 'trade_signal':
          await messageBus.publish(CHANNELS.WEBHOOK_RECEIVED, webhookMessage);
          logger.info(`Trade signal webhook routed to trade-orchestrator: ${req.id}`);
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

    if (webhookType === 'trade_signal') {
      logger.info(`Webhook processed: ${req.id} (${webhookType}) in ${processingTime}ms`);
    } else {
      logger.debug(`Webhook processed: ${req.id} (${webhookType}) in ${processingTime}ms`);
    }
  } catch (error) {
    logger.error(`Error processing webhook: ${req.id}`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy webhook endpoints for compatibility
app.post('/autotrader', async (req, res) => {
  logger.info('Legacy autotrader webhook received');
  req.headers['x-source'] = 'autotrader-legacy';
  return app._router.handle(Object.assign(req, { url: '/webhook', method: 'POST' }), res);
});

app.post('/slingshot', async (req, res) => {
  logger.info('Slingshot webhook received on dedicated endpoint');
  req.headers['x-source'] = 'slingshot-endpoint';
  return app._router.handle(Object.assign(req, { url: '/webhook', method: 'POST' }), res);
});

app.post('/quote', async (req, res) => {
  logger.info('Quote webhook received on legacy endpoint');
  req.body.webhook_type = 'quote';
  req.headers['x-source'] = 'quote-endpoint-legacy';
  return app._router.handle(Object.assign(req, { url: '/webhook', method: 'POST' }), res);
});

// REST API Endpoints (auth required except for health)
app.get('/health', async (req, res) => {
  const health = await healthCheck(SERVICE_NAME, {
    messageBus: messageBus.isConnected,
    socketClients: io.engine.clientsCount,
    accounts: monitoringState.accounts.size,
    positions: monitoringState.positions.size,
    services: monitoringState.services.size
  }, messageBus);
  res.json(health);
});

// Public system health endpoint for external monitoring (UptimeRobot, etc)
app.get('/api/health/system', async (req, res) => {
  try {
    // Define services to check (including self)
    const servicesToCheck = [
      { name: 'monitoring-service', url: `http://localhost:${config.service.port}`, port: config.service.port },
      { name: 'trade-orchestrator', url: process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013', port: 3013 },
      { name: 'market-data-service', url: process.env.MARKET_DATA_SERVICE_URL || 'http://localhost:3012', port: 3012 },
      { name: 'tradovate-service', url: process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011', port: 3011 }
    ];

    // Check health of all services
    console.log('🔍 DEBUG: Services to check:', servicesToCheck);
    const healthChecks = await Promise.allSettled(
      servicesToCheck.map(async (service) => {
        try {
          console.log(`🔍 DEBUG: Checking ${service.name} at ${service.url}/health`);
          const response = await axios.get(`${service.url}/health`, {
            timeout: 2000 // Quick timeout for monitoring
          });
          console.log(`✅ DEBUG: ${service.name} responded with ${response.status}`);
          return { name: service.name, status: 'up', healthy: true };
        } catch (error) {
          console.log(`❌ DEBUG: ${service.name} failed:`, error.message);
          return { name: service.name, status: 'down', healthy: false };
        }
      })
    );

    // Process results
    const services = {};
    let upCount = 0;

    healthChecks.forEach((result, index) => {
      const serviceData = result.status === 'fulfilled' ? result.value :
        { name: servicesToCheck[index].name, status: 'down', healthy: false };

      services[serviceData.name] = serviceData.status;
      if (serviceData.healthy) upCount++;
    });

    // Determine overall status
    const totalServices = servicesToCheck.length;
    let overallStatus = 'healthy';

    if (upCount === 0) {
      overallStatus = 'down';
    } else if (upCount < totalServices - 1) {
      overallStatus = 'degraded';
    } else if (upCount < totalServices) {
      overallStatus = 'degraded';
    }

    // Return health status
    res.json({
      status: overallStatus,
      services,
      summary: `${upCount}/${totalServices} services running`,
      healthy: overallStatus === 'healthy',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('System health check failed:', error);
    res.status(500).json({
      status: 'down',
      error: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/dashboard', dashboardAuth, (req, res) => {
  res.json({
    accounts: Array.from(monitoringState.accounts.values()),
    positions: Array.from(monitoringState.positions.values()),
    orders: Array.from(monitoringState.orders.values()),
    prices: Object.fromEntries(monitoringState.prices),
    services: Array.from(monitoringState.services.values()),
    activity: monitoringState.activity.slice(-100)
  });
});

app.get('/api/accounts', dashboardAuth, (req, res) => {
  res.json(Array.from(monitoringState.accounts.values()));
});

app.get('/api/accounts/:accountId', dashboardAuth, (req, res) => {
  const accountId = req.params.accountId;
  // Try both string and number lookups since account IDs might be stored differently
  let account = monitoringState.accounts.get(accountId) ||
                monitoringState.accounts.get(parseInt(accountId));

  if (account) {
    // Return in the format expected by frontend: {summary: {...}}
    const summary = {
      accountId: account.id,
      balance: account.balance,
      equity: account.balance, // For now, use balance as equity
      margin: account.marginUsed,
      availableFunds: account.balance - account.marginUsed,
      dayPnL: account.realizedPnL,
      dayPnLPercent: account.balance > 0 ? (account.realizedPnL / account.balance * 100) : 0,
      totalPositions: 0, // Will be filled from positions data
      longPositions: 0,
      shortPositions: 0,
      workingOrders: 0, // Will be filled from orders data
      tradesExecutedToday: 0,
      cached: true,
      timestamp: new Date().toISOString()
    };

    res.json({ summary });
  } else {
    // Debug: log what accounts we have
    const availableAccounts = Array.from(monitoringState.accounts.keys());
    console.log(`❌ Account ${accountId} not found. Available accounts:`, availableAccounts);
    res.status(404).json({ error: 'Account not found' });
  }
});

app.get('/api/positions', dashboardAuth, (req, res) => {
  const positions = Array.from(monitoringState.positions.values());
  if (req.query.accountId) {
    const filtered = positions.filter(p => p.accountId === req.query.accountId);
    res.json(filtered);
  } else {
    res.json(positions);
  }
});

app.get('/api/activity', dashboardAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(monitoringState.activity.slice(-limit));
});

app.get('/api/services', dashboardAuth, async (req, res) => {
  // Get baseline services from monitoring state
  const baselineServices = Array.from(monitoringState.services.values());

  // Define internal services to check (including self)
  const internalServices = [
    { name: 'monitoring-service', url: `http://localhost:${config.service.port}`, port: config.service.port },
    { name: 'trade-orchestrator', url: process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013', port: 3013 },
    { name: 'market-data-service', url: process.env.MARKET_DATA_SERVICE_URL || 'http://localhost:3012', port: 3012 },
    { name: 'tradovate-service', url: process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011', port: 3011 }
  ];

  // Perform health checks for all internal services
  const healthChecks = await Promise.allSettled(
    internalServices.map(async (service) => {
      try {
        const response = await axios.get(`${service.url}/health`, {
          timeout: 3000
        });
        return {
          name: service.name,
          status: 'running',
          health: response.data,
          port: service.port,
          lastChecked: new Date().toISOString(),
          url: service.url
        };
      } catch (error) {
        return {
          name: service.name,
          status: 'down',
          error: error.message,
          port: service.port,
          lastChecked: new Date().toISOString(),
          url: service.url
        };
      }
    })
  );

  // Combine baseline services with health check results
  const servicesMap = new Map();

  // Add baseline services
  baselineServices.forEach(service => {
    servicesMap.set(service.name, service);
  });

  // Override with real-time health check results
  healthChecks.forEach((result, index) => {
    const serviceName = internalServices[index].name;
    if (result.status === 'fulfilled') {
      servicesMap.set(serviceName, result.value);
    } else {
      servicesMap.set(serviceName, {
        name: serviceName,
        status: 'down',
        error: result.reason?.message || 'Health check failed',
        port: internalServices[index].port,
        lastChecked: new Date().toISOString()
      });
    }
  });

  res.json(Array.from(servicesMap.values()));
});

app.get('/api/quotes', dashboardAuth, (req, res) => {
  res.json(Object.fromEntries(monitoringState.prices));
});

app.get('/api/quotes/:symbol', dashboardAuth, (req, res) => {
  const quote = monitoringState.prices.get(req.params.symbol);
  if (quote) {
    res.json(quote);
  } else {
    res.status(404).json({ error: 'Quote not found' });
  }
});

// Debug endpoint to clear orders
app.delete('/api/orders', dashboardAuth, (req, res) => {
  const clearedCount = monitoringState.orders.size;
  monitoringState.orders.clear();
  logger.info(`🧹 Cleared ${clearedCount} orders from monitoring state`);
  res.json({ cleared: clearedCount, message: 'Orders cleared successfully' });
});

// Debug endpoint to clear positions
app.delete('/api/positions', dashboardAuth, (req, res) => {
  const clearedCount = monitoringState.positions.size;
  monitoringState.positions.clear();
  logger.info(`🧹 Cleared ${clearedCount} positions from monitoring state`);
  res.json({ cleared: clearedCount, message: 'Positions cleared successfully' });
});

// Position Sizing endpoints
app.get('/api/position-sizing/settings', dashboardAuth, (req, res) => {
  logger.info('📊 Position sizing settings requested');
  res.json(monitoringState.positionSizing);
});

app.post('/api/position-sizing/settings', dashboardAuth, (req, res) => {
  const settings = req.body;
  logger.info('📊 Updating position sizing settings:', settings);

  // Update the settings in memory
  monitoringState.positionSizing = {
    ...monitoringState.positionSizing,
    ...settings
  };

  // Save to file
  const saved = savePositionSizingSettings(monitoringState.positionSizing, 'api_update');
  if (!saved) {
    logger.warn('Position sizing settings updated in memory but failed to save to file');
  }

  // Log activity
  monitoringState.activity.push({
    timestamp: new Date().toISOString(),
    type: 'position_sizing',
    message: `Position sizing updated: ${settings.method} method${saved ? ' (saved to file)' : ' (memory only)'}`,
    data: settings
  });

  // Keep activity array from growing too large
  if (monitoringState.activity.length > monitoringState.maxActivitySize) {
    monitoringState.activity = monitoringState.activity.slice(-monitoringState.maxActivitySize);
  }

  res.json(monitoringState.positionSizing);
});

// Position sizing conversion endpoint
app.post('/api/position-sizing/convert', dashboardAuth, (req, res) => {
  const { originalSymbol, quantity, action, entryPrice, stopLoss } = req.body;
  logger.info(`📊 Converting position sizing: ${action} ${quantity} ${originalSymbol}`, { entryPrice, stopLoss });

  const settings = monitoringState.positionSizing;
  const result = convertPositionSize(originalSymbol, quantity, action, settings, entryPrice, stopLoss);

  logger.info(`📊 Conversion result:`, result);
  res.json(result);
});

// Proxy endpoint to trade-orchestrator for active trading status
app.get('/api/trading/active-status', dashboardAuth, async (req, res) => {
  try {
    logger.debug('🔄 Proxying request to trade-orchestrator...');

    const tradeOrchestratorUrl = process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013';
    const response = await axios.get(`${tradeOrchestratorUrl}/api/trading/active-status`, {
      timeout: 5000
    });

    logger.debug('✅ Trade-orchestrator proxy response received');
    res.json(response.data);
  } catch (error) {
    logger.error('❌ Trade-orchestrator proxy failed:', error.message);

    // Fallback to local monitoring data
    const openPositions = Array.from(monitoringState.positions.values())
      .filter(pos => pos.netPos !== 0);

    const workingOrders = Array.from(monitoringState.orders.values())
      .filter(order => order.status === 'working' || order.orderStatus === 'Working');

    res.json({
      tradingEnabled: true,
      positions: openPositions,
      pendingEntryOrders: workingOrders.filter(o => !o.orderRole || o.orderRole === 'entry'),
      stopOrders: workingOrders.filter(o => o.orderRole === 'stop_loss'),
      targetOrders: workingOrders.filter(o => o.orderRole === 'take_profit'),
      stats: {
        totalPositions: openPositions.length,
        totalWorkingOrders: workingOrders.length,
        dailyTrades: 0,
        dailyPnL: 0
      },
      lastUpdate: new Date().toISOString(),
      source: 'monitoring_fallback'
    });
  }
});

// Trading control proxy endpoints
app.get('/api/trading/status', dashboardAuth, async (req, res) => {
  try {
    logger.debug('🔄 Proxying trading status request to trade-orchestrator...');

    const tradeOrchestratorUrl = process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013';
    const response = await axios.get(`${tradeOrchestratorUrl}/trading/status`, {
      timeout: 5000
    });

    logger.debug('✅ Trading status response received');
    res.json(response.data);
  } catch (error) {
    logger.error('❌ Trading status proxy failed:', error.message);
    res.status(503).json({
      error: 'Failed to get trading status',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/trading/enable', dashboardAuth, async (req, res) => {
  try {
    logger.debug('🔄 Proxying trading enable request to trade-orchestrator...');

    const tradeOrchestratorUrl = process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013';
    const response = await axios.post(`${tradeOrchestratorUrl}/trading/enable`, {}, {
      timeout: 5000
    });

    logger.info('✅ Trading enabled successfully');
    res.json(response.data);
  } catch (error) {
    logger.error('❌ Trading enable proxy failed:', error.message);
    res.status(503).json({
      error: 'Failed to enable trading',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/trading/disable', dashboardAuth, async (req, res) => {
  try {
    logger.debug('🔄 Proxying trading disable request to trade-orchestrator...');

    const tradeOrchestratorUrl = process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013';
    const response = await axios.post(`${tradeOrchestratorUrl}/trading/disable`, {}, {
      timeout: 5000
    });

    logger.info('✅ Trading disabled successfully');
    res.json(response.data);
  } catch (error) {
    logger.error('❌ Trading disable proxy failed:', error.message);
    res.status(503).json({
      error: 'Failed to disable trading',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Proxy endpoint to trade-orchestrator for enhanced trading status
app.get('/api/trading/enhanced-status', dashboardAuth, async (req, res) => {
  try {
    logger.debug('🔄 Proxying enhanced status request to trade-orchestrator...');

    const tradeOrchestratorUrl = process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013';
    const response = await axios.get(`${tradeOrchestratorUrl}/api/trading/enhanced-status`, {
      timeout: 5000
    });

    logger.debug('✅ Enhanced trade-orchestrator proxy response received');
    res.json(response.data);
  } catch (error) {
    logger.error('❌ Enhanced trade-orchestrator proxy failed:', error.message);

    // Enhanced fallback with signal context simulation
    const openPositions = Array.from(monitoringState.positions.values())
      .filter(pos => pos.netPos !== 0);

    const workingOrders = Array.from(monitoringState.orders.values())
      .filter(order => order.status === 'working' || order.orderStatus === 'Working');

    // Group orders by symbol for context
    const ordersBySymbol = new Map();
    workingOrders.forEach(order => {
      if (!ordersBySymbol.has(order.symbol)) {
        ordersBySymbol.set(order.symbol, []);
      }
      ordersBySymbol.get(order.symbol).push(order);
    });

    res.json({
      tradingEnabled: true,
      pendingOrders: Array.from(ordersBySymbol.entries()).map(([symbol, orders]) => {
        const entryOrder = orders.find(o => !o.orderRole || o.orderRole === 'entry');
        const currentPrice = monitoringState.prices.get(symbol)?.close;

        return {
          signalId: entryOrder?.id || 'unknown',
          symbol,
          action: entryOrder?.action || 'unknown',
          price: entryOrder?.price || 0,
          quantity: entryOrder?.quantity || 0,
          orderId: entryOrder?.id,
          orderStatus: entryOrder?.orderStatus || 'Working',
          marketDistance: currentPrice && entryOrder?.price ?
            Math.abs(currentPrice - entryOrder.price) : null,
          marketDistancePercent: currentPrice && entryOrder?.price ?
            ((Math.abs(currentPrice - entryOrder.price) / currentPrice) * 100) : null,
          orders,
          signalContext: {
            signalId: entryOrder?.id || 'unknown',
            action: entryOrder?.action || 'unknown',
            symbol,
            price: entryOrder?.price || 0,
            quantity: entryOrder?.quantity || 0,
            timestamp: entryOrder?.timestamp || new Date().toISOString(),
            source: 'fallback'
          },
          currentMarketData: monitoringState.prices.get(symbol)
        };
      }),
      openPositions: openPositions.map(pos => {
        const currentPrice = monitoringState.prices.get(pos.symbol)?.close;
        const isLong = pos.netPos > 0;

        return {
          positionId: pos.id,
          symbol: pos.symbol,
          quantity: pos.netPos,
          side: isLong ? 'long' : 'short',
          currentPrice,
          entryPrice: pos.avgFillPrice || null,
          unrealizedPnL: pos.unrealizedPnL || 0,
          realizedPnL: pos.realizedPnL || 0,
          stopPrice: null,
          targetPrice: null,
          trailingStopPrice: null,
          signalContext: {
            signalId: 'unknown',
            symbol: pos.symbol,
            action: isLong ? 'long' : 'short',
            source: 'fallback'
          },
          currentMarketData: monitoringState.prices.get(pos.symbol)
        };
      }),
      marketData: Object.fromEntries(monitoringState.prices),
      stats: {
        pendingOrdersCount: workingOrders.length,
        openPositionsCount: openPositions.length,
        totalUnrealizedPnL: openPositions.reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0),
        totalRealizedPnL: openPositions.reduce((sum, pos) => sum + (pos.realizedPnL || 0), 0)
      },
      lastUpdate: new Date().toISOString(),
      source: 'monitoring_fallback'
    });
  }
});

// Proxy endpoints for internal service health checks
app.get('/api/services/:serviceName/health', dashboardAuth, async (req, res) => {
  const { serviceName } = req.params;
  const serviceUrls = {
    'trade-orchestrator': process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013',
    'market-data': process.env.MARKET_DATA_SERVICE_URL || 'http://localhost:3012',
    'tradovate': process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011'
  };

  const serviceUrl = serviceUrls[serviceName];

  if (!serviceUrl) {
    return res.status(404).json({ error: 'Service not found' });
  }

  try {
    logger.debug(`🔄 Proxying health check to ${serviceName}...`);
    const response = await axios.get(`${serviceUrl}/health`, {
      timeout: 5000
    });
    logger.debug(`✅ ${serviceName} health check proxy response received`);
    res.json(response.data);
  } catch (error) {
    logger.error(`❌ ${serviceName} health check proxy failed:`, error.message);
    res.status(503).json({
      service: serviceName,
      status: 'unavailable',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Generic proxy endpoint for internal service API calls
app.all('/api/proxy/:serviceName/*', dashboardAuth, async (req, res) => {
  const { serviceName } = req.params;
  const path = req.params[0];

  const serviceUrls = {
    'trade-orchestrator': process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013',
    'market-data': process.env.MARKET_DATA_SERVICE_URL || 'http://localhost:3012',
    'tradovate': process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011'
  };

  const serviceUrl = serviceUrls[serviceName];

  if (!serviceUrl) {
    return res.status(404).json({ error: 'Service not found' });
  }

  try {
    logger.debug(`🔄 Proxying ${req.method} request to ${serviceName}/${path}...`);

    const axiosConfig = {
      method: req.method,
      url: `${serviceUrl}/${path}`,
      timeout: 10000,
      params: req.query
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      axiosConfig.data = req.body;
    }

    const response = await axios(axiosConfig);
    logger.debug(`✅ ${serviceName} proxy response received`);
    res.status(response.status).json(response.data);
  } catch (error) {
    logger.error(`❌ ${serviceName} proxy failed:`, error.message);

    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(503).json({
        service: serviceName,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
});

// Activity logging helper
function logActivity(type, message, data = {}) {
  const activity = {
    id: Date.now().toString(),
    type,
    message,
    data,
    timestamp: new Date().toISOString()
  };

  monitoringState.activity.push(activity);

  // Keep activity size limited
  if (monitoringState.activity.length > monitoringState.maxActivitySize) {
    monitoringState.activity.shift();
  }

  // Broadcast to Socket.IO clients
  broadcast('activity', activity);

  return activity;
}

// Message bus event handlers
async function handleAccountUpdate(message) {
  logger.debug('📊 Received account update:', {
    accountId: message.accountId,
    accountName: message.accountName,
    source: message.source || 'unknown',
    hasDirectBalance: !!message.balance,
    hasCashData: !!message.cashData,
    hasAccountData: !!message.accountData
  });

  // Handle both formats: direct fields (WebSocket sync) and nested objects (REST API)
  const account = {
    id: message.accountId,
    name: message.accountName,
    balance: message.balance || message.cashData?.totalCashValue || message.cashData?.cashUSD || message.cashData?.balance || 0,
    realizedPnL: message.realizedPnL || message.cashData?.realizedPnL || 0,
    unrealizedPnL: message.unrealizedPnL || message.cashData?.unrealizedPnL || 0,
    marginUsed: message.marginUsed || message.accountData?.marginUsed || 0,
    marginAvailable: message.marginAvailable || message.accountData?.marginAvailable || 0,
    lastUpdate: message.timestamp
  };

  monitoringState.accounts.set(message.accountId, account);
  logger.debug('💰 Account stored:', account);

  broadcast('account_update', account);

  logActivity('account', `Account ${message.accountName} updated`, account);
}

async function handlePositionUpdate(message) {
  logger.debug('📊 Received position update:', message);

  const positionKey = `${message.accountId}-${message.symbol || message.positionId}`;

  if (message.positions) {
    // Bulk update
    message.positions.forEach(pos => {
      const key = `${message.accountId}-${pos.symbol}`;
      const netPos = pos.netPos || pos.quantity || 0;

      // Remove position if netPos is 0
      if (netPos === 0) {
        if (monitoringState.positions.has(key)) {
          monitoringState.positions.delete(key);
          logger.info(`🧹 Removed closed position: ${key}`);
        }
        return;
      }

      const position = {
        ...pos,
        accountId: message.accountId,
        lastUpdate: message.timestamp || new Date().toISOString(),
        // Ensure we have essential P&L fields
        netPos: netPos,
        pnl: pos.pnl || pos.unrealizedPnL || 0,
        realizedPnL: pos.realizedPnL || 0,
        unrealizedPnL: pos.unrealizedPnL || pos.pnl || 0
      };
      monitoringState.positions.set(key, position);
      logger.debug(`📊 Position stored: ${key}`, position);
    });
  } else {
    // Single update
    const netPos = message.netPos || message.quantity || 0;

    // Remove position if netPos is 0
    if (netPos === 0) {
      if (monitoringState.positions.has(positionKey)) {
        monitoringState.positions.delete(positionKey);
        logger.info(`🧹 Removed closed position: ${positionKey}`);
      }
      broadcast('position_update', message);
      logActivity('position', `Position closed for ${message.symbol}`, message);
      return;
    }

    const position = {
      id: message.positionId,
      accountId: message.accountId,
      symbol: message.symbol,
      netPos: netPos,
      currentPrice: message.currentPrice,
      pnl: message.pnl || message.unrealizedPnL || 0,
      realizedPnL: message.realizedPnL || 0,
      unrealizedPnL: message.unrealizedPnL || message.pnl || 0,
      lastUpdate: message.timestamp || new Date().toISOString()
    };

    monitoringState.positions.set(positionKey, position);
    logger.debug(`📊 Single position stored: ${positionKey}`, position);
  }

  broadcast('position_update', message);

  logActivity('position', `Position updated for ${message.symbol || 'multiple symbols'}`, message);
}

async function handlePriceUpdate(message) {
  logger.debug(`🔔 PRICE_UPDATE received: ${message.baseSymbol || message.symbol} = ${message.close} (source: ${message.source})`);

  const quoteData = {
    symbol: message.symbol,
    baseSymbol: message.baseSymbol,
    open: message.open,
    high: message.high,
    low: message.low,
    close: message.close,
    previousClose: message.previousClose,
    volume: message.volume,
    timestamp: message.timestamp,
    source: message.source
  };

  // Store by full contract symbol (e.g., "NQZ2024")
  monitoringState.prices.set(message.symbol, quoteData);

  // Also store by base symbol for frontend compatibility (e.g., "NQ")
  if (message.baseSymbol) {
    monitoringState.prices.set(message.baseSymbol, quoteData);
  }

  broadcast('market_data', message);
}

async function handleOrderUpdate(message) {
  logger.debug('📋 Received order update:', message);

  // Skip if no orderId - this would be invalid
  if (!message.orderId) {
    logger.warn('📋 Skipping order update - no orderId provided:', message);
    return;
  }

  const order = {
    id: message.orderId,
    orderId: message.orderId, // Also store as orderId for compatibility
    accountId: message.accountId,
    symbol: message.symbol,
    action: message.action,
    quantity: message.quantity,
    orderType: message.orderType,
    status: message.status || 'working', // Default to 'working' for new orders
    orderStatus: message.orderStatus || message.status || 'Working', // Preserve original orderStatus from Tradovate
    price: message.price,
    stopPrice: message.stopPrice,
    contractId: message.contractId,
    contractName: message.contractName, // Include contract name from enrichment
    tickSize: message.tickSize, // Include tick size from enrichment
    parentOrderId: message.parentOrderId,
    orderRole: message.orderRole, // 'stop_loss', 'take_profit', or undefined for main order
    timestamp: message.timestamp || new Date().toISOString()
  };

  // Check if we already have this order (prevent duplicates)
  const existingOrder = monitoringState.orders.get(message.orderId);
  if (existingOrder) {
    logger.debug('📋 Order already exists, updating:', message.orderId);
    // Update existing order with new data
    const updatedOrder = { ...existingOrder, ...order };
    monitoringState.orders.set(message.orderId, updatedOrder);
  } else {
    logger.debug('📋 New order, adding to monitoring state:', message.orderId);
    monitoringState.orders.set(message.orderId, order);
  }

  broadcast('order_update', order);

  logActivity('order', `Order ${message.action} ${message.symbol} - ${message.status || 'placed'}`, order);
}

async function handlePositionRealtimeUpdate(message) {
  logger.debug('📊 Received real-time position update:', message);

  // Update monitoring state with real-time P&L data
  const positionKey = `${message.accountId}-${message.symbol}`;
  const existingPosition = monitoringState.positions.get(positionKey);

  const updatedPosition = {
    ...(existingPosition || {}),
    id: message.positionId,
    accountId: message.accountId,
    symbol: message.symbol,
    netPos: message.netPos,
    currentPrice: message.currentPrice,
    entryPrice: message.entryPrice,
    unrealizedPnL: message.unrealizedPnL,
    realizedPnL: message.realizedPnL,
    side: message.side,
    lastUpdate: message.lastUpdate,
    source: message.source
  };

  monitoringState.positions.set(positionKey, updatedPosition);

  // Broadcast real-time position update to dashboard
  broadcast('position_realtime_update', {
    positionId: message.positionId,
    symbol: message.symbol,
    netPos: message.netPos,
    currentPrice: message.currentPrice,
    entryPrice: message.entryPrice,
    unrealizedPnL: message.unrealizedPnL,
    realizedPnL: message.realizedPnL,
    side: message.side,
    lastUpdate: message.lastUpdate,
    marketData: message.marketData
  });

  logger.debug(`📡 Broadcast real-time position update for ${message.symbol}: $${message.unrealizedPnL?.toFixed(2)} P&L`);
}

async function handleOrderRealtimeUpdate(message) {
  logger.debug('📋 Received real-time order update:', message);

  // Update monitoring state with real-time market distance data
  const existingOrder = monitoringState.orders.get(message.orderId);

  const updatedOrder = {
    ...(existingOrder || {}),
    id: message.orderId,
    orderId: message.orderId,
    symbol: message.symbol,
    baseSymbol: message.baseSymbol,
    action: message.action,
    quantity: message.quantity,
    orderType: message.orderType,
    price: message.price,
    orderStatus: message.orderStatus,
    currentPrice: message.currentPrice,
    marketDistance: message.marketDistance,
    lastUpdate: message.lastUpdate,
    source: message.source
  };

  monitoringState.orders.set(message.orderId, updatedOrder);

  // Broadcast real-time order update to dashboard
  broadcast('order_realtime_update', {
    orderId: message.orderId,
    symbol: message.symbol,
    baseSymbol: message.baseSymbol,
    action: message.action,
    quantity: message.quantity,
    orderType: message.orderType,
    price: message.price,
    orderStatus: message.orderStatus,
    currentPrice: message.currentPrice,
    marketDistance: message.marketDistance,
    marketData: message.marketData,
    signalContext: message.signalContext,
    lastUpdate: message.lastUpdate
  });

  logger.debug(`📡 Broadcast real-time order update for ${message.symbol}: ${message.action} @ ${message.price}, market: ${message.currentPrice}`);
}

async function handleTradovateSyncCompleted(message) {
  try {
    const { accountId, validWorkingOrderIds = [], source } = message;
    logger.info(`🔄 Tradovate sync completed for account ${accountId} with ${validWorkingOrderIds.length} valid orders from ${source}`);

    // Get all current orders for this account
    const currentOrdersForAccount = Array.from(monitoringState.orders.values())
      .filter(order => order.accountId === accountId);

    const validOrderSet = new Set(validWorkingOrderIds);
    let removedCount = 0;

    // Remove any orders not in the valid list
    for (const order of currentOrdersForAccount) {
      if (!validOrderSet.has(order.id) && !validOrderSet.has(order.orderId)) {
        logger.info(`🗑️ Removing stale order from monitoring: ${order.id} - ${order.symbol} ${order.action}`);
        monitoringState.orders.delete(order.id);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.info(`✅ Cleaned up ${removedCount} stale orders from monitoring state`);

      // Broadcast update to connected clients
      broadcast('orders', {
        orders: Array.from(monitoringState.orders.values()),
        source: 'sync_cleanup'
      });
    } else {
      logger.info('✅ No stale orders found in monitoring state');
    }
  } catch (error) {
    logger.error('Failed to handle Tradovate sync completion:', error);
  }
}

async function handleServiceHealth(message) {
  monitoringState.services.set(message.service, {
    name: message.service,
    status: message.status,
    uptime: message.uptime,
    memory: message.memory,
    details: message,
    lastUpdate: message.timestamp
  });

  broadcast('service_health', message);
}

async function handleServiceStarted(message) {
  monitoringState.services.set(message.service, {
    name: message.service,
    status: 'running',
    startTime: message.timestamp,
    port: message.port,
    details: message
  });

  logActivity('system', `Service ${message.service} started on port ${message.port}`, message);
}

async function handleServiceStopped(message) {
  const service = monitoringState.services.get(message.service);
  if (service) {
    service.status = 'stopped';
    service.stopTime = message.timestamp;
    service.stopReason = message.reason;
  }

  logActivity('system', `Service ${message.service} stopped: ${message.reason}`, message);
}

async function handleWebhookReceived(message) {
  logActivity('webhook', `Webhook received from ${message.source || 'unknown'}`, message);
}

async function handleTradeValidated(message) {
  logActivity('trade', `Trade validated: ${message.signal.action} ${message.signal.symbol}`, message);
}

async function handleTradeRejected(message) {
  logActivity('trade', `Trade rejected: ${message.reason}`, message);
}

// Startup sequence
async function startup() {
  try {
    logger.info(`Starting ${SERVICE_NAME}...`);

    // Connect to message bus
    logger.info('Connecting to message bus...');
    await messageBus.connect();
    logger.info('Message bus connected');

    // Load configuration from Redis
    logger.info('Loading configuration from Redis...');
    monitoringState.positionSizing = await loadPositionSizingSettings();
    monitoringState.contractMappings = await loadContractMappings();
    logger.info('Configuration loaded from Redis');

    // Subscribe to all relevant channels
    const subscriptions = [
      [CHANNELS.ACCOUNT_UPDATE, handleAccountUpdate],
      [CHANNELS.POSITION_UPDATE, handlePositionUpdate],
      [CHANNELS.POSITION_REALTIME_UPDATE, handlePositionRealtimeUpdate],
      [CHANNELS.PRICE_UPDATE, handlePriceUpdate],
      [CHANNELS.ORDER_PLACED, handleOrderUpdate],
      [CHANNELS.ORDER_FILLED, handleOrderUpdate],
      [CHANNELS.ORDER_REJECTED, handleOrderUpdate],
      [CHANNELS.ORDER_REALTIME_UPDATE, handleOrderRealtimeUpdate],
      [CHANNELS.TRADOVATE_SYNC_COMPLETED, handleTradovateSyncCompleted],
      [CHANNELS.SERVICE_HEALTH, handleServiceHealth],
      [CHANNELS.SERVICE_STARTED, handleServiceStarted],
      [CHANNELS.SERVICE_STOPPED, handleServiceStopped],
      [CHANNELS.WEBHOOK_RECEIVED, handleWebhookReceived],
      [CHANNELS.TRADE_VALIDATED, handleTradeValidated],
      [CHANNELS.TRADE_REJECTED, handleTradeRejected]
    ];

    for (const [channel, handler] of subscriptions) {
      await messageBus.subscribe(channel, handler);
      logger.info(`Subscribed to ${channel}`);
    }

    // Publish startup event
    await messageBus.publish(CHANNELS.SERVICE_STARTED, {
      service: SERVICE_NAME,
      port: config.service.port,
      timestamp: new Date().toISOString()
    });

    // Request account data sync from tradovate-service
    logger.info('🔄 Requesting account data sync from tradovate-service...');
    await messageBus.publish('account.sync.request', {
      requestedBy: SERVICE_NAME,
      timestamp: new Date().toISOString()
    });

    // Start server - bind to all interfaces for external access
    const bindHost = process.env.BIND_HOST || '0.0.0.0';
    server.listen(config.service.port, bindHost, () => {
      logger.info(`${SERVICE_NAME} listening on ${bindHost}:${config.service.port}`);
      logger.info(`Environment: ${config.service.env}`);
      logger.info(`Health check: http://localhost:${config.service.port}/health`);
      logger.info(`Dashboard API: http://localhost:${config.service.port}/api/dashboard`);
      logger.info(`WebSocket: ws://localhost:${config.service.port}`);
      logger.info(`Webhook endpoint: http://localhost:${config.service.port}/webhook`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received, starting graceful shutdown...`);

      // Close Socket.IO server
      io.close(() => {
        logger.info('Socket.IO server closed');
      });

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