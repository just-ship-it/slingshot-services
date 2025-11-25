import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';

const SERVICE_NAME = 'monitoring-service';
const logger = createLogger(SERVICE_NAME);

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3014 });

// Position sizing config file path
const POSITION_SIZING_CONFIG_PATH = path.join(process.cwd(), 'config', 'position-sizing.json');

// Position sizing file I/O functions
function loadPositionSizingSettings() {
  try {
    if (existsSync(POSITION_SIZING_CONFIG_PATH)) {
      const data = readFileSync(POSITION_SIZING_CONFIG_PATH, 'utf8');
      const settings = JSON.parse(data);
      logger.info('Position sizing settings loaded from file:', settings);
      return settings;
    }
  } catch (error) {
    logger.error('Error loading position sizing settings from file:', error);
  }

  // Return defaults if file doesn't exist or error occurred
  const defaults = {
    method: 'fixed',
    fixedQuantity: 1,
    riskPercentage: 10,
    maxContracts: 10,
    contractType: 'micro'
  };
  logger.info('Using default position sizing settings:', defaults);
  return defaults;
}

function savePositionSizingSettings(settings) {
  try {
    writeFileSync(POSITION_SIZING_CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf8');
    logger.info('Position sizing settings saved to file:', settings);
    return true;
  } catch (error) {
    logger.error('Error saving position sizing settings to file:', error);
    return false;
  }
}

// Monitoring state
const monitoringState = {
  accounts: new Map(),
  positions: new Map(),
  orders: new Map(),
  prices: new Map(),
  services: new Map(),
  activity: [],
  maxActivitySize: 1000,
  positionSizing: loadPositionSizingSettings()
};

// Contract conversion mappings
const contractSpecs = {
  'MNQ': { pointValue: 2, type: 'micro', fullSize: 'NQ' },
  'NQ': { pointValue: 20, type: 'full', microSize: 'MNQ' },
  'MES': { pointValue: 5, type: 'micro', fullSize: 'ES' },
  'ES': { pointValue: 50, type: 'full', microSize: 'MES' },
  'M2K': { pointValue: 5, type: 'micro', fullSize: 'RTY' },
  'RTY': { pointValue: 50, type: 'full', microSize: 'M2K' }
};

// Position sizing conversion logic
function convertPositionSize(originalSymbol, originalQuantity, action, settings) {
  // Clean symbol (remove suffixes like 1!, Z5, etc.)
  const cleanSymbol = originalSymbol.replace(/[0-9!].*$/, '').toUpperCase();
  const spec = contractSpecs[cleanSymbol];

  if (!spec) {
    logger.warn(`Unknown symbol for conversion: ${originalSymbol}`);
    return {
      symbol: originalSymbol,
      quantity: originalQuantity,
      action,
      converted: false,
      reason: 'Unknown symbol'
    };
  }

  let targetSymbol = cleanSymbol;
  let targetQuantity = originalQuantity;
  let converted = false;
  let reason = 'No conversion needed';

  // Apply conversion based on settings
  if (settings.method === 'fixed') {
    // Fixed quantity method
    targetQuantity = settings.fixedQuantity;
    converted = targetQuantity !== originalQuantity;

    // Contract type conversion
    if (settings.contractType === 'micro' && spec.type === 'full' && spec.microSize) {
      targetSymbol = spec.microSize;
      // Use fixed quantity as-is when converting to micro
      targetQuantity = settings.fixedQuantity;
      converted = true;
      reason = `Converted to micro contracts (${settings.fixedQuantity} fixed)`;
    } else if (settings.contractType === 'full' && spec.type === 'micro' && spec.fullSize) {
      targetSymbol = spec.fullSize;
      // Use fixed quantity as-is when converting to full size
      targetQuantity = settings.fixedQuantity;
      converted = true;
      reason = `Converted to full-size contracts (${settings.fixedQuantity} fixed)`;
    } else {
      reason = `Fixed quantity: ${settings.fixedQuantity} contracts`;
    }
  } else if (settings.method === 'risk_based') {
    // Risk-based sizing would require account balance and stop loss data
    // For now, just return the original with a note
    reason = 'Risk-based sizing requires account balance data';
  }

  return {
    symbol: targetSymbol,
    quantity: Math.max(1, targetQuantity), // Ensure minimum 1 contract
    action,
    originalSymbol,
    originalQuantity,
    converted,
    reason,
    settings: settings.method
  };
}

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

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
  logger.info('New Socket.IO client connected');

  // Send current state to new client
  socket.emit('initial_state', {
    accounts: Array.from(monitoringState.accounts.values()),
    positions: Array.from(monitoringState.positions.values()),
    services: Array.from(monitoringState.services.values()),
    activity: monitoringState.activity.slice(-100)
  });

  // Handle ping/pong
  socket.on('ping', (data) => {
    socket.emit('pong', data);
  });

  // Handle subscription requests
  socket.on('subscribe_account', (accountId) => {
    socket.join(`account_${accountId}`);
    logger.info(`Client subscribed to account ${accountId}`);
  });

  socket.on('subscribe_quote', (symbol) => {
    socket.join(`quote_${symbol}`);
    logger.info(`Client subscribed to quotes for ${symbol}`);
  });

  socket.on('disconnect', (reason) => {
    logger.info('Socket.IO client disconnected:', reason);
  });

  socket.on('error', (error) => {
    logger.error('Socket.IO error:', error);
  });
});

// Broadcast to all Socket.IO clients
function broadcast(eventName, data) {
  io.emit(eventName, data);
}

// REST API Endpoints
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

app.get('/api/dashboard', (req, res) => {
  res.json({
    accounts: Array.from(monitoringState.accounts.values()),
    positions: Array.from(monitoringState.positions.values()),
    orders: Array.from(monitoringState.orders.values()),
    prices: Object.fromEntries(monitoringState.prices),
    services: Array.from(monitoringState.services.values()),
    activity: monitoringState.activity.slice(-100)
  });
});

app.get('/api/accounts', (req, res) => {
  res.json(Array.from(monitoringState.accounts.values()));
});

app.get('/api/accounts/:accountId', (req, res) => {
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

app.get('/api/positions', (req, res) => {
  const positions = Array.from(monitoringState.positions.values());
  if (req.query.accountId) {
    const filtered = positions.filter(p => p.accountId === req.query.accountId);
    res.json(filtered);
  } else {
    res.json(positions);
  }
});

app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(monitoringState.activity.slice(-limit));
});

app.get('/api/services', (req, res) => {
  res.json(Array.from(monitoringState.services.values()));
});

app.get('/api/quotes', (req, res) => {
  res.json(Object.fromEntries(monitoringState.prices));
});

app.get('/api/quotes/:symbol', (req, res) => {
  const quote = monitoringState.prices.get(req.params.symbol);
  if (quote) {
    res.json(quote);
  } else {
    res.status(404).json({ error: 'Quote not found' });
  }
});

// Debug endpoint to clear orders
app.delete('/api/orders', (req, res) => {
  const clearedCount = monitoringState.orders.size;
  monitoringState.orders.clear();
  logger.info(`🧹 Cleared ${clearedCount} orders from monitoring state`);
  res.json({ cleared: clearedCount, message: 'Orders cleared successfully' });
});

// Position Sizing endpoints
app.get('/api/position-sizing/settings', (req, res) => {
  logger.info('📊 Position sizing settings requested');
  res.json(monitoringState.positionSizing);
});

app.post('/api/position-sizing/settings', (req, res) => {
  const settings = req.body;
  logger.info('📊 Updating position sizing settings:', settings);

  // Update the settings in memory
  monitoringState.positionSizing = {
    ...monitoringState.positionSizing,
    ...settings
  };

  // Save to file
  const saved = savePositionSizingSettings(monitoringState.positionSizing);
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
app.post('/api/position-sizing/convert', (req, res) => {
  const { originalSymbol, quantity, action } = req.body;
  logger.info(`📊 Converting position sizing: ${action} ${quantity} ${originalSymbol}`);

  const settings = monitoringState.positionSizing;
  const result = convertPositionSize(originalSymbol, quantity, action, settings);

  logger.info(`📊 Conversion result:`, result);
  res.json(result);
});

// Proxy endpoint to trade-orchestrator for active trading status
app.get('/api/trading/active-status', async (req, res) => {
  try {
    logger.info('🔄 Proxying request to trade-orchestrator...');

    const axios = require('axios');
    const response = await axios.get('http://localhost:3013/api/trading/active-status', {
      timeout: 5000
    });

    logger.info('✅ Trade-orchestrator proxy response received');
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
  logger.info('📊 Received account update:', {
    accountId: message.accountId,
    accountName: message.accountName,
    cashData: JSON.stringify(message.cashData),
    accountData: JSON.stringify(message.accountData)
  });

  const account = {
    id: message.accountId,
    name: message.accountName,
    balance: message.cashData?.totalCashValue || message.cashData?.cashUSD || message.cashData?.balance || 0,
    realizedPnL: message.cashData?.realizedPnL || 0,
    unrealizedPnL: message.cashData?.unrealizedPnL || 0,
    marginUsed: message.accountData?.marginUsed || 0,
    marginAvailable: message.accountData?.marginAvailable || 0,
    lastUpdate: message.timestamp
  };

  monitoringState.accounts.set(message.accountId, account);
  logger.info('💰 Account stored:', account);

  broadcast('account_update', account);

  logActivity('account', `Account ${message.accountName} updated`, account);
}

async function handlePositionUpdate(message) {
  logger.info('📊 Received position update:', message);

  const positionKey = `${message.accountId}-${message.symbol || message.positionId}`;

  if (message.positions) {
    // Bulk update
    message.positions.forEach(pos => {
      const key = `${message.accountId}-${pos.symbol}`;
      const position = {
        ...pos,
        accountId: message.accountId,
        lastUpdate: message.timestamp || new Date().toISOString(),
        // Ensure we have essential P&L fields
        netPos: pos.netPos || pos.quantity || 0,
        pnl: pos.pnl || pos.unrealizedPnL || 0,
        realizedPnL: pos.realizedPnL || 0,
        unrealizedPnL: pos.unrealizedPnL || pos.pnl || 0
      };
      monitoringState.positions.set(key, position);
      logger.info(`📊 Position stored: ${key}`, position);
    });
  } else {
    // Single update
    const position = {
      id: message.positionId,
      accountId: message.accountId,
      symbol: message.symbol,
      netPos: message.netPos || message.quantity || 0,
      currentPrice: message.currentPrice,
      pnl: message.pnl || message.unrealizedPnL || 0,
      realizedPnL: message.realizedPnL || 0,
      unrealizedPnL: message.unrealizedPnL || message.pnl || 0,
      lastUpdate: message.timestamp || new Date().toISOString()
    };

    monitoringState.positions.set(positionKey, position);
    logger.info(`📊 Single position stored: ${positionKey}`, position);
  }

  broadcast('position_update', message);

  logActivity('position', `Position updated for ${message.symbol || 'multiple symbols'}`, message);
}

async function handlePriceUpdate(message) {
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
  logger.info('📋 Received order update:', message);

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
    logger.info('📋 Order already exists, updating:', message.orderId);
    // Update existing order with new data
    const updatedOrder = { ...existingOrder, ...order };
    monitoringState.orders.set(message.orderId, updatedOrder);
  } else {
    logger.info('📋 New order, adding to monitoring state:', message.orderId);
    monitoringState.orders.set(message.orderId, order);
  }

  broadcast('order_update', order);

  logActivity('order', `Order ${message.action} ${message.symbol} - ${message.status || 'placed'}`, order);
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

    // Subscribe to all relevant channels
    const subscriptions = [
      [CHANNELS.ACCOUNT_UPDATE, handleAccountUpdate],
      [CHANNELS.POSITION_UPDATE, handlePositionUpdate],
      [CHANNELS.PRICE_UPDATE, handlePriceUpdate],
      [CHANNELS.ORDER_PLACED, handleOrderUpdate],
      [CHANNELS.ORDER_FILLED, handleOrderUpdate],
      [CHANNELS.ORDER_REJECTED, handleOrderUpdate],
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

    // Start server
    server.listen(config.service.port, config.service.host, () => {
      logger.info(`${SERVICE_NAME} listening on ${config.service.host}:${config.service.port}`);
      logger.info(`Environment: ${config.service.env}`);
      logger.info(`Health check: http://localhost:${config.service.port}/health`);
      logger.info(`Dashboard API: http://localhost:${config.service.port}/api/dashboard`);
      logger.info(`WebSocket: ws://localhost:${config.service.port}`);
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