import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
// File system imports removed - using Redis for persistence
import axios from 'axios';
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';

const SERVICE_NAME = 'monitoring-service';
const logger = createLogger(SERVICE_NAME);

// Debug PM2 vs direct execution - compare with siggen-nq-ivskew
console.log('📊 MONITORING PRE-LOGGER: stdout.isTTY:', process.stdout.isTTY);
console.log('🚀 MONITORING CONSOLE LOG: Monitoring service starting...');
console.error('🚀 MONITORING CONSOLE ERROR: Monitoring service starting...');
logger.info('🧪 MONITORING WINSTON TEST: Logger working?');

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3014 });

// Auth secrets from environment
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Internal service URLs
const SIGNAL_GENERATOR_URL = process.env.SIGNAL_GENERATOR_URL || 'http://localhost:3015';
const DATA_SERVICE_URL = process.env.DATA_SERVICE_URL || 'http://localhost:3019';
const MACRO_BRIEFING_URL = process.env.MACRO_BRIEFING_URL || 'http://localhost:3017';
const SIGNAL_GENERATOR_AI_URL = process.env.SIGNAL_GENERATOR_AI_URL || 'http://localhost:3018';

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
      'NQ': 'NQH6',
      'MNQ': 'MNQH6',
      'ES': 'ESH6',
      'MES': 'MESH6'
    },
    pointValues: {
      'NQ': 20,
      'MNQ': 2,
      'ES': 50,
      'MES': 5
    },
    tickSize: 0.25,
    notes: 'March 2026 contract mappings - store in Redis for rollover updates'
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

// Monitoring state - trigger redeploy for market news
const monitoringState = {
  accounts: new Map(),
  positions: new Map(),
  orders: new Map(),
  prices: new Map(),
  services: new Map(),
  activity: [],
  maxActivitySize: 1000,
  signals: [], // Store recent trade signal webhooks
  maxSignalsSize: 100,
  marketNews: [], // Store recent Kalshi market events
  maxNewsSize: 200,
  positionSizing: null, // Will be loaded async on startup
  contractMappings: null, // Will be loaded async on startup
  strategyStatus: null, // Strategy status from siggen-nq-ivskew
  squeezeData: null, // Current squeeze momentum data
  analyticsData: new Map(), // Analytics data by type
  gexLevels: { cboe: null, tradier: null }, // GEX levels from both sources
  ivSkew: null // IV skew data from Tradier
};

// ============================================
// Discord Notification Functions
// ============================================

/**
 * Send a Discord notification via webhook
 * @param {Object} embed - Discord embed object
 */
async function sendDiscordNotification(embed) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const enabled = process.env.DISCORD_NOTIFICATIONS_ENABLED === 'true';

  if (!webhookUrl || !enabled) {
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!response.ok) {
      logger.warn(`Discord notification failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    logger.error('Discord notification error:', error.message);
  }
}

/**
 * Check if a strategy is whitelisted for Discord notifications
 */
function isDiscordWhitelistedStrategy(strategy) {
  const whitelist = process.env.DISCORD_STRATEGY_WHITELIST;
  if (!whitelist) return true; // no whitelist = notify everything (backward compatible)
  const allowed = whitelist.split(',').map(s => s.trim().toUpperCase());
  return allowed.includes((strategy || '').toUpperCase());
}

/**
 * Handle trade signal for Discord notification
 */
async function handleTradeSignalDiscord(signal) {
  if (!isDiscordWhitelistedStrategy(signal.strategy)) return;
  const actionEmoji = signal.action === 'cancel_limit' ? '🚫' : '📊';
  const sideColor = signal.side === 'buy' ? 0x22c55e : 0xef4444; // green / red

  const fields = [
    { name: 'Side', value: (signal.side || 'N/A').toUpperCase(), inline: true },
    { name: 'Symbol', value: signal.symbol || 'N/A', inline: true },
    { name: 'Strategy', value: signal.strategy || 'N/A', inline: true }
  ];

  if (signal.price) {
    fields.push({ name: 'Price', value: signal.price.toFixed(2), inline: true });
  }
  if (signal.stop_loss) {
    fields.push({ name: 'Stop Loss', value: signal.stop_loss.toFixed(2), inline: true });
  }
  if (signal.take_profit) {
    fields.push({ name: 'Take Profit', value: signal.take_profit.toFixed(2), inline: true });
  }
  if (signal.trailing_trigger && signal.trailing_offset) {
    fields.push({ name: 'Trailing', value: `${signal.trailing_trigger}/${signal.trailing_offset} pts`, inline: true });
  }
  if (signal.quantity) {
    fields.push({ name: 'Qty', value: signal.quantity.toString(), inline: true });
  }

  await sendDiscordNotification({
    title: `${actionEmoji} ${(signal.action || 'SIGNAL').toUpperCase().replace('_', ' ')}`,
    color: sideColor,
    fields,
    timestamp: new Date().toISOString()
  });
}

/**
 * Handle trade rejected for Discord notification
 */
async function handleTradeRejectedDiscord(message) {
  const rejected = message.rejectedSignal || {};
  if (!isDiscordWhitelistedStrategy(rejected.strategy)) return;
  const fields = [
    { name: 'Reason', value: message.reason || 'Unknown', inline: false },
    { name: 'Strategy', value: rejected.strategy || 'N/A', inline: true },
    { name: 'Symbol', value: rejected.symbol || 'N/A', inline: true },
    { name: 'Action', value: rejected.action || 'N/A', inline: true }
  ];

  if (rejected.price) {
    fields.push({ name: 'Price', value: rejected.price.toFixed(2), inline: true });
  }
  if (rejected.quantity) {
    fields.push({ name: 'Qty', value: rejected.quantity.toString(), inline: true });
  }

  await sendDiscordNotification({
    title: '⛔ Signal Rejected',
    color: 0xf59e0b, // amber
    fields,
    timestamp: new Date().toISOString()
  });
}

/**
 * Handle order filled for Discord notification
 */
async function handleOrderFilledDiscord(order) {
  if (!isDiscordWhitelistedStrategy(order.strategy)) return;
  const sideColor = order.side === 'Buy' || order.action === 'Buy' ? 0x22c55e : 0xef4444;
  const side = order.side || order.action || 'N/A';

  const fields = [
    { name: 'Side', value: side, inline: true },
    { name: 'Symbol', value: order.symbol || order.contractSymbol || 'N/A', inline: true },
    { name: 'Qty', value: (order.qty || order.filledQty || 1).toString(), inline: true }
  ];

  if (order.avgPrice || order.avgFillPrice) {
    fields.push({ name: 'Fill Price', value: (order.avgPrice || order.avgFillPrice).toFixed(2), inline: true });
  }
  if (order.orderType) {
    fields.push({ name: 'Order Type', value: order.orderType, inline: true });
  }
  if (order.strategy) {
    fields.push({ name: 'Strategy', value: order.strategy, inline: true });
  }

  await sendDiscordNotification({
    title: '✅ Order Filled',
    color: sideColor,
    fields,
    timestamp: new Date().toISOString()
  });
}

/**
 * Handle position opened for Discord notification
 */
async function handlePositionOpenedDiscord(position) {
  if (!isDiscordWhitelistedStrategy(position.strategy)) return;
  const sideColor = position.netPos > 0 ? 0x22c55e : 0xef4444;
  const side = position.netPos > 0 ? 'LONG' : 'SHORT';

  const fields = [
    { name: 'Side', value: side, inline: true },
    { name: 'Symbol', value: position.symbol || position.contractSymbol || 'N/A', inline: true },
    { name: 'Size', value: Math.abs(position.netPos || position.qty || 1).toString(), inline: true }
  ];

  if (position.avgPrice || position.entryPrice) {
    fields.push({ name: 'Entry Price', value: (position.avgPrice || position.entryPrice).toFixed(2), inline: true });
  }
  if (position.strategy) {
    fields.push({ name: 'Strategy', value: position.strategy, inline: true });
  }

  await sendDiscordNotification({
    title: '📈 Position Opened',
    color: sideColor,
    fields,
    timestamp: new Date().toISOString()
  });
}

/**
 * Handle position closed for Discord notification
 */
async function handlePositionClosedDiscord(position) {
  if (!isDiscordWhitelistedStrategy(position.strategy)) return;
  // Determine P&L and color
  const pnl = position.realizedPnl || position.pnl || 0;
  const isProfit = pnl >= 0;
  const color = isProfit ? 0x22c55e : 0xef4444;
  const emoji = isProfit ? '✅' : '❌';
  const result = isProfit ? 'PROFIT' : 'LOSS';

  const fields = [
    { name: 'Symbol', value: position.symbol || position.contractSymbol || 'N/A', inline: true },
    { name: 'Result', value: result, inline: true }
  ];

  // Add entry/exit prices if available
  if (position.entryPrice && position.exitPrice) {
    fields.push({ name: 'Entry → Exit', value: `${position.entryPrice.toFixed(2)} → ${position.exitPrice.toFixed(2)}`, inline: true });
  } else if (position.fillPrice) {
    fields.push({ name: 'Exit Price', value: position.fillPrice.toFixed(2), inline: true });
  }

  // Add P&L
  if (pnl !== 0) {
    const pnlSign = pnl >= 0 ? '+' : '';
    fields.push({ name: 'P&L', value: `${pnlSign}$${pnl.toFixed(2)}`, inline: true });
  }

  // Add points if available
  if (position.pnlPoints !== undefined) {
    const ptsSign = position.pnlPoints >= 0 ? '+' : '';
    fields.push({ name: 'Points', value: `${ptsSign}${position.pnlPoints.toFixed(2)} pts`, inline: true });
  }

  if (position.strategy) {
    fields.push({ name: 'Strategy', value: position.strategy, inline: true });
  }

  // Add duration if available
  if (position.duration) {
    fields.push({ name: 'Duration', value: position.duration, inline: true });
  }

  if (position.exitReason || position.orderType) {
    fields.push({ name: 'Exit Type', value: position.exitReason || position.orderType || 'N/A', inline: true });
  }

  await sendDiscordNotification({
    title: `${emoji} Position Closed - ${result}`,
    color,
    fields,
    timestamp: new Date().toISOString()
  });
}

// Throttle map for TV auth Discord notifications
const tvAuthDiscordThrottle = new Map();
const TV_AUTH_THROTTLE_MS = 4 * 60 * 60 * 1000; // 4 hours — token refresh failures are not urgent

/**
 * Handle TradingView authentication events for Discord notification.
 * Listens on service.error channel, filters for tv_auth_* types.
 */
async function handleTvAuthDiscord(message) {
  const type = message.type;

  // Only handle TV auth events
  if (!type || !type.startsWith('tv_')) return;

  // Throttle: max once per 30 minutes per event type
  const lastSent = tvAuthDiscordThrottle.get(type) || 0;
  if (Date.now() - lastSent < TV_AUTH_THROTTLE_MS) return;
  tvAuthDiscordThrottle.set(type, Date.now());

  let title, color;
  switch (type) {
    case 'tv_auth_degraded':
      title = 'TradingView Delayed Quotes';
      color = 0xf97316; // orange
      break;
    case 'tv_token_refresh_failed':
      title = 'TradingView Token Refresh Failed';
      color = 0xef4444; // red
      break;
    case 'tv_token_refreshed':
      title = 'TradingView Token Refreshed';
      color = 0x22c55e; // green
      break;
    case 'tv_auth_restored':
      title = 'TradingView Quotes Restored';
      color = 0x22c55e; // green
      break;
    default:
      return; // Unknown tv_ event, skip
  }

  const fields = [
    { name: 'Service', value: message.service || 'signal-generator', inline: true },
    { name: 'Status', value: message.authState || 'unknown', inline: true }
  ];

  if (message.tokenTTL !== undefined && message.tokenTTL !== null) {
    const ttlMin = Math.floor(message.tokenTTL / 60);
    fields.push({ name: 'Token TTL', value: ttlMin >= 0 ? `${ttlMin}min` : `Expired ${-ttlMin}min ago`, inline: true });
  }

  if (message.message) {
    fields.push({ name: 'Details', value: message.message, inline: false });
  }

  // Add actionable guidance for token refresh failures
  if (type === 'tv_token_refresh_failed') {
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://slingshot-dashboard.pages.dev/';
    fields.push({
      name: 'Action Required',
      value: `Open the dashboard and paste a fresh JWT token:\n${dashboardUrl}\n\nSignal Generator > Set Token`,
      inline: false
    });
  }

  await sendDiscordNotification({
    title: `${type === 'tv_auth_degraded' || type === 'tv_token_refresh_failed' ? '🔴' : '🟢'} ${title}`,
    color,
    fields,
    timestamp: new Date().toISOString()
  });
}

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
 * Create human-readable summary from trade signal webhook data
 */
function createSignalSummary(signalData) {
  try {
    const { action, side, symbol, quantity, price, stop_loss, take_profit, trailing_trigger, trailing_offset, strategy } = signalData;

    // Determine action type
    const actionText = action === 'place_limit' ? (side === 'buy' ? 'Buy' : 'Sell') :
                      action === 'place_market' ? (side === 'buy' ? 'Buy Market' : 'Sell Market') :
                      action === 'position_closed' ? 'Close Position' :
                      action === 'cancel_limit' ? 'Cancel Order' : action;

    // Base summary
    let summary = `${actionText} ${quantity} ${symbol}`;

    // Add price for limit orders
    if (price && action === 'place_limit') {
      summary += ` at ${price}`;
    }

    // Add stop/target info
    const parts = [];
    if (stop_loss && price) {
      const stopPoints = Math.abs(price - stop_loss);
      parts.push(`Stop: ${stopPoints.toFixed(0)}pts`);
    }
    if (take_profit && price) {
      const targetPoints = Math.abs(take_profit - price);
      parts.push(`Target: ${targetPoints.toFixed(0)}pts`);
    }
    if (trailing_trigger && trailing_offset) {
      parts.push(`Trailing: ${trailing_trigger}/${trailing_offset}`);
    }

    if (parts.length > 0) {
      summary += ` (${parts.join(', ')})`;
    }

    // Add strategy if present
    if (strategy) {
      summary += ` [${strategy}]`;
    }

    return summary;
  } catch (error) {
    logger.error('Failed to create signal summary:', error);
    return `Signal: ${signalData.action || 'unknown'} ${signalData.symbol || 'unknown'}`;
  }
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
    signals: monitoringState.signals.slice(0, 50),
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
          // Store the signal in monitoring state
          const signalData = {
            id: req.id,
            timestamp: new Date().toISOString(),
            summary: createSignalSummary(req.body),
            status: 'received',
            rawData: req.body,
            source: req.headers['user-agent'] || 'unknown'
          };

          monitoringState.signals.unshift(signalData);

          // Limit signal storage
          if (monitoringState.signals.length > monitoringState.maxSignalsSize) {
            monitoringState.signals = monitoringState.signals.slice(0, monitoringState.maxSignalsSize);
          }

          // Emit WebSocket event for real-time updates
          io.emit('signal_received', signalData);

          await messageBus.publish(CHANNELS.WEBHOOK_RECEIVED, webhookMessage);
          logger.info(`Trade signal webhook stored and routed: ${req.id} - ${signalData.summary}`);
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
    activity: monitoringState.activity.slice(-100),
    signals: monitoringState.signals.slice(0, 50)
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

app.get('/api/signals', dashboardAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(monitoringState.signals.slice(0, limit));
});

app.get('/api/market-news', dashboardAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(monitoringState.marketNews.slice(0, limit));
});

app.get('/api/services', dashboardAuth, async (req, res) => {
  // Get baseline services from monitoring state
  const baselineServices = Array.from(monitoringState.services.values());

  // Define internal services to check (including self)
  const internalServices = [
    { name: 'monitoring-service', url: `http://localhost:${config.service.port}`, port: config.service.port },
    { name: 'trade-orchestrator', url: process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013', port: 3013 },
    { name: 'tradovate-service', url: process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011', port: 3011 },
    { name: 'data-service', url: DATA_SERVICE_URL, port: 3019 },
    { name: 'signal-generator', url: SIGNAL_GENERATOR_URL, port: 3015 },
    { name: 'ai-trader', url: SIGNAL_GENERATOR_AI_URL, port: 3018 },
    { name: 'macro-briefing', url: MACRO_BRIEFING_URL, port: 3017 }
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

// Signal generator / data-service detailed connection status endpoint
app.get('/api/signal-generator/status', dashboardAuth, async (req, res) => {
  try {
    // Fetch health from data-service (owns TradingView, GEX, Tradier connections)
    const [healthResponse, gexHealthResponse, tradierStatusResponse] = await Promise.allSettled([
      axios.get(`${DATA_SERVICE_URL}/health`, { timeout: 5000 }),
      axios.get(`${DATA_SERVICE_URL}/gex/health`, { timeout: 5000 }),
      axios.get(`${DATA_SERVICE_URL}/tradier/status`, { timeout: 5000 })
    ]);

    const status = {
      timestamp: new Date().toISOString(),
      overall: 'unknown',
      connections: {
        tradingview: {
          connected: false,
          lastHeartbeat: null,
          lastQuoteReceived: null,
          symbols: [],
          reconnectAttempts: 0
        },
        ltMonitor: {
          connected: false,
          hasLevels: false,
          lastHeartbeat: null
        },
        tradier: {
          available: false,
          active: false,
          running: false,
          connectionType: null,
          lastCalculation: null,
          hasToken: false,
          displayStatus: 'Unknown',
          websocketStatus: 'initializing'
        },
        cboe: {
          enabled: true,
          hasData: false,
          lastFetch: null,
          ageMinutes: null
        },
        hybridGex: {
          enabled: false,
          primarySource: null,
          usingRTHCache: false,
          tradierFresh: false
        }
      }
    };

    // Parse health response
    if (healthResponse.status === 'fulfilled') {
      const health = healthResponse.value.data;

      // Basic component status
      status.connections.tradingview.connected = health.components?.tradingview === 'connected';

      // LT status: data-service returns components.lt as object { NQ: 'connected', ES: '...' }
      const ltComponents = health.components?.lt;
      if (ltComponents && typeof ltComponents === 'object') {
        // Connected if any product is connected
        status.connections.ltMonitor.connected = Object.values(ltComponents).some(s => s === 'connected');
        status.connections.ltMonitor.notRequired = Object.values(ltComponents).every(s => s === 'not_required');
      } else if (typeof ltComponents === 'string') {
        status.connections.ltMonitor.connected = ltComponents === 'connected';
        status.connections.ltMonitor.notRequired = ltComponents === 'not_required';
      }

      // Connection details if available
      if (health.connectionDetails) {
        const tvDetails = health.connectionDetails.tradingview;
        if (tvDetails) {
          status.connections.tradingview.lastHeartbeat = tvDetails.lastHeartbeat;
          status.connections.tradingview.lastQuoteReceived = tvDetails.lastQuoteReceived;
          status.connections.tradingview.reconnectAttempts = tvDetails.reconnectAttempts || 0;
          status.connections.tradingview.authState = tvDetails.authState || 'unknown';
          status.connections.tradingview.tokenTTL = tvDetails.tokenTTL;
        }

        // LT details: data-service returns connectionDetails.ltMonitors as { NQ: {...}, ES: {...} }
        const ltMonitors = health.connectionDetails.ltMonitors;
        if (ltMonitors && typeof ltMonitors === 'object') {
          // Aggregate: pick first connected monitor's details, or first available
          const monitorEntries = Object.values(ltMonitors);
          const connectedMonitor = monitorEntries.find(m => m.connected) || monitorEntries[0];
          if (connectedMonitor) {
            status.connections.ltMonitor.lastHeartbeat = connectedMonitor.lastHeartbeat;
            status.connections.ltMonitor.hasLevels = monitorEntries.some(m => m.hasLevels);
          }
        }
      }

      // Config info
      status.connections.tradingview.symbols = health.config?.symbols || [];

      // Tradier basic info from health
      if (health.tradier) {
        status.connections.tradier.available = health.tradier.available;
        status.connections.tradier.active = health.tradier.active;
        status.connections.tradier.running = health.tradier.running;
        status.connections.tradier.hasToken = health.tradier.config?.hasToken || false;
        // New market-aware status fields
        status.connections.tradier.displayStatus = health.tradier.displayStatus || 'Unknown';
        status.connections.tradier.websocketStatus = health.tradier.websocketStatus || 'initializing';
      }
    }

    // Parse GEX health response
    // Data-service /gex/health returns: { gex: { NQ, ES }, hybridGex: { NQ: { session, hybrid, tradier, cboe }, ES: {...} }, tradier }
    if (gexHealthResponse.status === 'fulfilled') {
      const gexHealth = gexHealthResponse.value.data;

      // Pick NQ product details (primary), fall back to first available
      const hybridDetails = gexHealth.hybridGex?.NQ || gexHealth.hybridGex?.ES || Object.values(gexHealth.hybridGex || {})[0];

      if (hybridDetails) {
        status.connections.hybridGex.enabled = hybridDetails.hybrid?.enabled || false;

        // CBOE status
        if (hybridDetails.cboe) {
          status.connections.cboe.enabled = hybridDetails.cboe.enabled !== false;
          status.connections.cboe.hasData = hybridDetails.cboe.hasData || false;
          status.connections.cboe.lastFetch = hybridDetails.cboe.lastUpdate || null;
          status.connections.cboe.ageMinutes = hybridDetails.cboe.ageMinutes || null;
        }

        // Hybrid GEX status
        if (hybridDetails.hybrid) {
          status.connections.hybridGex.primarySource = hybridDetails.hybrid.primarySource || null;
        }

        // Session/RTH cache status
        if (hybridDetails.session) {
          status.connections.hybridGex.usingRTHCache = hybridDetails.session.usingRTHCache || false;
        }

        // Tradier freshness
        if (hybridDetails.tradier) {
          status.connections.hybridGex.tradierFresh = (hybridDetails.tradier.ageMinutes || 999) < 5;
        }
      } else {
        // No hybrid data — check if plain GEX calculators have data
        const gexStatus = gexHealth.gex;
        if (gexStatus) {
          const hasAnyData = Object.values(gexStatus).some(s => s === 'ready');
          status.connections.cboe.hasData = hasAnyData;
        }
      }
    }

    // Parse Tradier status response for additional details
    if (tradierStatusResponse.status === 'fulfilled') {
      const tradierStatus = tradierStatusResponse.value.data;

      if (tradierStatus.health) {
        status.connections.tradier.lastCalculation = tradierStatus.health.lastCalculation || null;
        // Determine connection type based on available data
        status.connections.tradier.connectionType = tradierStatus.health.spotPrices ? 'rest_polling' : null;
      }
    }

    // Determine overall status
    const tvConnected = status.connections.tradingview.connected;
    const hasGexData = status.connections.tradier.active || status.connections.cboe.hasData;

    if (tvConnected && hasGexData) {
      status.overall = 'healthy';
    } else if (tvConnected) {
      status.overall = 'degraded';
    } else if (healthResponse.status === 'fulfilled') {
      status.overall = 'unhealthy';
    } else {
      status.overall = 'unavailable';
    }

    res.json(status);
  } catch (error) {
    logger.error('Failed to fetch data-service status:', error.message);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      overall: 'unavailable',
      error: error.message,
      connections: null
    });
  }
});

// Signal generator (ES) detailed connection status endpoint - now served by data-service
app.get('/api/es-signal-generator/status', dashboardAuth, async (req, res) => {
  try {
    // Data service handles all connections now (TradingView, GEX, Tradier, LT)
    const [healthResponse, gexHealthResponse, tradierStatusResponse] = await Promise.allSettled([
      axios.get(`${DATA_SERVICE_URL}/health`, { timeout: 5000 }),
      axios.get(`${DATA_SERVICE_URL}/gex/health`, { timeout: 5000 }),
      axios.get(`${DATA_SERVICE_URL}/tradier/status`, { timeout: 5000 })
    ]);

    const status = {
      timestamp: new Date().toISOString(),
      overall: 'unknown',
      connections: {
        tradingview: {
          connected: false,
          lastHeartbeat: null,
          lastQuoteReceived: null,
          symbols: [],
          reconnectAttempts: 0
        },
        ltMonitor: {
          connected: false,
          notRequired: false,
          hasLevels: false,
          lastHeartbeat: null
        },
        tradier: {
          available: false,
          active: false,
          running: false,
          connectionType: null,
          lastCalculation: null,
          hasToken: false,
          displayStatus: 'Unknown',
          websocketStatus: 'initializing'
        },
        cboe: {
          enabled: true,
          hasData: false,
          lastFetch: null,
          ageMinutes: null
        },
        hybridGex: {
          enabled: false,
          primarySource: null,
          usingRTHCache: false,
          tradierFresh: false
        }
      }
    };

    if (healthResponse.status === 'fulfilled') {
      const health = healthResponse.value.data;
      status.connections.tradingview.connected = health.components?.tradingview === 'connected';

      // LT status: data-service returns components.lt as object { NQ: 'connected', ES: '...' }
      const ltComponents = health.components?.lt;
      if (ltComponents && typeof ltComponents === 'object') {
        status.connections.ltMonitor.connected = Object.values(ltComponents).some(s => s === 'connected');
        status.connections.ltMonitor.notRequired = Object.values(ltComponents).every(s => s === 'not_required');
      } else if (typeof ltComponents === 'string') {
        status.connections.ltMonitor.connected = ltComponents === 'connected';
        status.connections.ltMonitor.notRequired = ltComponents === 'not_required';
      }

      if (health.connectionDetails) {
        const tvDetails = health.connectionDetails.tradingview;
        if (tvDetails) {
          status.connections.tradingview.lastHeartbeat = tvDetails.lastHeartbeat;
          status.connections.tradingview.lastQuoteReceived = tvDetails.lastQuoteReceived;
          status.connections.tradingview.reconnectAttempts = tvDetails.reconnectAttempts || 0;
        }
        // LT details: data-service returns connectionDetails.ltMonitors as { NQ: {...}, ES: {...} }
        const ltMonitors = health.connectionDetails.ltMonitors;
        if (ltMonitors && typeof ltMonitors === 'object') {
          const monitorEntries = Object.values(ltMonitors);
          const connectedMonitor = monitorEntries.find(m => m.connected) || monitorEntries[0];
          if (connectedMonitor) {
            status.connections.ltMonitor.lastHeartbeat = connectedMonitor.lastHeartbeat;
            status.connections.ltMonitor.hasLevels = monitorEntries.some(m => m.hasLevels);
          }
        }
      }

      status.connections.tradingview.symbols = health.config?.symbols || [];

      if (health.tradier) {
        status.connections.tradier.available = health.tradier.available;
        status.connections.tradier.active = health.tradier.active;
        status.connections.tradier.running = health.tradier.running;
        status.connections.tradier.hasToken = health.tradier.config?.hasToken || false;
        status.connections.tradier.displayStatus = health.tradier.displayStatus || 'Unknown';
        status.connections.tradier.websocketStatus = health.tradier.websocketStatus || 'initializing';
      }
    }

    // Parse GEX health response
    // Data-service /gex/health returns: { gex: { NQ, ES }, hybridGex: { NQ: { session, hybrid, tradier, cboe }, ES: {...} }, tradier }
    if (gexHealthResponse.status === 'fulfilled') {
      const gexHealth = gexHealthResponse.value.data;

      const hybridDetails = gexHealth.hybridGex?.ES || gexHealth.hybridGex?.NQ || Object.values(gexHealth.hybridGex || {})[0];

      if (hybridDetails) {
        status.connections.hybridGex.enabled = hybridDetails.hybrid?.enabled || false;

        if (hybridDetails.cboe) {
          status.connections.cboe.enabled = hybridDetails.cboe.enabled !== false;
          status.connections.cboe.hasData = hybridDetails.cboe.hasData || false;
          status.connections.cboe.lastFetch = hybridDetails.cboe.lastUpdate || null;
          status.connections.cboe.ageMinutes = hybridDetails.cboe.ageMinutes || null;
        }
        if (hybridDetails.hybrid) {
          status.connections.hybridGex.primarySource = hybridDetails.hybrid.primarySource || null;
        }
        if (hybridDetails.session) {
          status.connections.hybridGex.usingRTHCache = hybridDetails.session.usingRTHCache || false;
        }
        if (hybridDetails.tradier) {
          status.connections.hybridGex.tradierFresh = (hybridDetails.tradier.ageMinutes || 999) < 5;
        }
      } else {
        const gexStatus = gexHealth.gex;
        if (gexStatus) {
          const hasAnyData = Object.values(gexStatus).some(s => s === 'ready');
          status.connections.cboe.hasData = hasAnyData;
        }
      }
    }

    if (tradierStatusResponse.status === 'fulfilled') {
      const tradierStatus = tradierStatusResponse.value.data;
      if (tradierStatus.health) {
        status.connections.tradier.lastCalculation = tradierStatus.health.lastCalculation || null;
        status.connections.tradier.connectionType = tradierStatus.health.spotPrices ? 'rest_polling' : null;
      }
    }

    const tvConnected = status.connections.tradingview.connected;
    const hasGexData = status.connections.tradier.active || status.connections.cboe.hasData;

    if (tvConnected && hasGexData) {
      status.overall = 'healthy';
    } else if (tvConnected) {
      status.overall = 'degraded';
    } else if (healthResponse.status === 'fulfilled') {
      status.overall = 'unhealthy';
    } else {
      status.overall = 'unavailable';
    }

    res.json(status);
  } catch (error) {
    logger.error('Failed to fetch siggen-es-cross status:', error.message);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      overall: 'unavailable',
      error: error.message,
      connections: null
    });
  }
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

// GEX levels endpoint - proxy to data-service
app.get('/api/gex/levels', dashboardAuth, async (req, res) => {
  try {
    logger.info('📊 Fetching GEX levels from data-service');
    const response = await axios.get(`${DATA_SERVICE_URL}/gex/levels/nq`, {
      timeout: 5000
    });

    const rawData = response.data;

    // Transform data to format expected by frontend
    const transformedData = {
      timestamp: rawData.timestamp || new Date().toISOString(),
      levels: {
        // Map backend field names to frontend expected names
        gamma_flip: rawData.gammaFlip,
        zero_gamma: rawData.gammaFlip, // alias
        call_wall: rawData.callWall,
        put_wall: rawData.putWall,
        resistance: rawData.resistance,
        support: rawData.support,
        regime: rawData.regime,
        total_gex: rawData.totalGex,
        qqq_spot: rawData.qqqSpot,
        nq_spot: rawData.nqSpot,
        multiplier: rawData.multiplier,
        data_source: rawData.dataSource,
        used_live_prices: rawData.usedLivePrices
      }
    };

    logger.info('✅ GEX levels fetched and transformed successfully');
    res.json(transformedData);
  } catch (error) {
    logger.error('❌ Failed to fetch GEX levels:', error.message);
    res.status(500).json({
      error: 'Failed to fetch GEX levels',
      message: error.message
    });
  }
});

// GEX refresh endpoint - trigger recalculation of GEX levels
app.post('/api/gex/refresh', dashboardAuth, async (req, res) => {
  try {
    logger.info('🔄 Triggering GEX levels refresh...');
    const response = await axios.post(`${DATA_SERVICE_URL}/gex/refresh?product=nq`, {
      force: true
    }, {
      timeout: 30000 // Longer timeout for refresh operation
    });

    const rawData = response.data;

    // Transform data to format expected by frontend (same as get endpoint)
    const transformedData = {
      timestamp: rawData.timestamp || new Date().toISOString(),
      levels: {
        gamma_flip: rawData.gammaFlip,
        zero_gamma: rawData.gammaFlip,
        call_wall: rawData.callWall,
        put_wall: rawData.putWall,
        resistance: rawData.resistance,
        support: rawData.support,
        regime: rawData.regime,
        total_gex: rawData.totalGex,
        qqq_spot: rawData.qqqSpot,
        nq_spot: rawData.nqSpot,
        multiplier: rawData.multiplier,
        data_source: rawData.dataSource,
        used_live_prices: rawData.usedLivePrices
      }
    };

    logger.info('✅ GEX levels refreshed and transformed successfully');
    res.json(transformedData);
  } catch (error) {
    logger.error('❌ Failed to refresh GEX levels:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh GEX levels',
      message: error.message
    });
  }
});

// TradingView manual token update - proxy to data-service (single TradingView connection)
app.post('/api/tradingview/token', dashboardAuth, async (req, res) => {
  try {
    logger.info('🔑 Proxying TradingView token update to data-service');
    const response = await axios.post(`${DATA_SERVICE_URL}/tradingview/token`, req.body, { timeout: 15000 });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to update TradingView token:', error.message);
    res.status(500).json({ error: 'Token update failed', message: error.message });
  }
});

// ES GEX levels endpoint - proxy to data-service
app.get('/api/es/gex/levels', dashboardAuth, async (req, res) => {
  try {
    logger.info('📊 Fetching ES GEX levels from data-service');
    const response = await axios.get(`${DATA_SERVICE_URL}/gex/levels/es`, {
      timeout: 5000
    });

    const rawData = response.data;

    // Transform data to format expected by frontend (same as NQ route)
    const transformedData = {
      timestamp: rawData.timestamp || new Date().toISOString(),
      levels: {
        gamma_flip: rawData.gammaFlip,
        zero_gamma: rawData.gammaFlip,
        call_wall: rawData.callWall,
        put_wall: rawData.putWall,
        resistance: rawData.resistance,
        support: rawData.support,
        regime: rawData.regime,
        total_gex: rawData.totalGex,
        spy_spot: rawData.spySpot,
        es_spot: rawData.esSpot,
        multiplier: rawData.multiplier,
        data_source: rawData.dataSource,
        used_live_prices: rawData.usedLivePrices
      }
    };

    logger.info('✅ ES GEX levels fetched and transformed successfully');
    res.json(transformedData);
  } catch (error) {
    logger.error('❌ Failed to fetch ES GEX levels:', error.message);
    res.status(500).json({
      error: 'Failed to fetch ES GEX levels',
      message: error.message
    });
  }
});

// ES GEX refresh endpoint - trigger recalculation of ES GEX levels
app.post('/api/es/gex/refresh', dashboardAuth, async (req, res) => {
  try {
    logger.info('🔄 Triggering ES GEX levels refresh...');
    const response = await axios.post(`${DATA_SERVICE_URL}/gex/refresh?product=es`, {
      force: true
    }, {
      timeout: 30000
    });

    const rawData = response.data;

    const transformedData = {
      timestamp: rawData.timestamp || new Date().toISOString(),
      levels: {
        gamma_flip: rawData.gammaFlip,
        zero_gamma: rawData.gammaFlip,
        call_wall: rawData.callWall,
        put_wall: rawData.putWall,
        resistance: rawData.resistance,
        support: rawData.support,
        regime: rawData.regime,
        total_gex: rawData.totalGex,
        spy_spot: rawData.spySpot,
        es_spot: rawData.esSpot,
        multiplier: rawData.multiplier,
        data_source: rawData.dataSource,
        used_live_prices: rawData.usedLivePrices
      }
    };

    logger.info('✅ ES GEX levels refreshed and transformed successfully');
    res.json(transformedData);
  } catch (error) {
    logger.error('❌ Failed to refresh ES GEX levels:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh ES GEX levels',
      message: error.message
    });
  }
});

// ES candle history endpoint - proxy to data-service
app.get('/api/es/candles', dashboardAuth, async (req, res) => {
  try {
    const count = req.query.count || 60;
    const response = await axios.get(`${DATA_SERVICE_URL}/candles?symbol=ES&count=${count}`, {
      timeout: 5000
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch ES candle history:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch ES candle history',
      message: error.message
    });
  }
});

// Candle history endpoint - proxy to data-service
app.get('/api/candles', dashboardAuth, async (req, res) => {
  try {
    const count = req.query.count || 60;
    const response = await axios.get(`${DATA_SERVICE_URL}/candles?symbol=NQ&count=${count}`, {
      timeout: 5000
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch candle history:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch candle history',
      message: error.message
    });
  }
});

// IV Skew endpoint - proxy to data-service
app.get('/api/iv/skew', dashboardAuth, async (req, res) => {
  try {
    logger.info('📊 Fetching IV skew from data-service');
    const response = await axios.get(`${DATA_SERVICE_URL}/iv/skew`, {
      timeout: 5000
    });

    res.json(response.data);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      logger.warn('IV skew data not available yet');
      res.status(404).json({
        error: 'IV skew data not available',
        message: 'Tradier service may not be running or no data calculated yet'
      });
    } else {
      logger.error('❌ Failed to fetch IV skew:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch IV skew',
        message: error.message
      });
    }
  }
});

// IV Skew history endpoint - proxy to data-service
app.get('/api/iv/history', dashboardAuth, async (req, res) => {
  try {
    const response = await axios.get(`${DATA_SERVICE_URL}/iv/history`, {
      timeout: 5000
    });
    res.json(response.data);
  } catch (error) {
    logger.error('❌ Failed to fetch IV history:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch IV history',
      message: error.message
    });
  }
});

// Tradier GEX levels endpoint - get enhanced options data from Tradier
app.get('/api/tradier/gex/levels', dashboardAuth, async (req, res) => {
  try {
    logger.info('📊 Fetching Tradier GEX levels from data-service');
    const response = await axios.get(`${DATA_SERVICE_URL}/exposure/levels`, {
      timeout: 5000
    });

    if (response.data && response.data.futures && response.data.futures.NQ) {
      const nqData = response.data.futures.NQ;

      // Transform to dashboard format
      const transformedData = {
        timestamp: response.data.timestamp,
        source: 'tradier',
        nqSpot: nqData.spotPrice,
        gammaFlip: nqData.levels.gammaFlip,
        callWall: nqData.levels.callWall,
        putWall: nqData.levels.putWall,
        resistance: nqData.levels.resistance,
        support: nqData.levels.support,
        totalGex: nqData.totals.gex,
        totalVex: nqData.totals.vex,
        totalCex: nqData.totals.cex,
        maxCallOI: nqData.levels.maxCallOI,
        maxPutOI: nqData.levels.maxPutOI,
        regime: nqData.regime?.gex || 'neutral'  // Use the proper regime from Tradier calculation
      };

      res.json(transformedData);
      logger.info('✅ Tradier GEX levels fetched and transformed successfully');
    } else {
      throw new Error('No NQ data in Tradier response');
    }
  } catch (error) {
    logger.error('❌ Failed to fetch Tradier GEX levels:', error.message);
    res.status(500).json({
      error: 'Failed to fetch Tradier GEX levels',
      message: error.message
    });
  }
});

// Force Tradier exposure recalculation - triggers WebSocket broadcast when complete
app.post('/api/tradier/gex/refresh', dashboardAuth, async (req, res) => {
  try {
    logger.info('🔄 Forcing Tradier exposure recalculation...');
    const response = await axios.post(`${DATA_SERVICE_URL}/exposure/refresh`, {}, {
      timeout: 30000  // Longer timeout for recalculation
    });

    if (response.data && response.data.futures && response.data.futures.NQ) {
      const nqData = response.data.futures.NQ;

      // Transform to dashboard format
      const transformedData = {
        timestamp: response.data.timestamp,
        source: 'tradier',
        nqSpot: nqData.futuresPrice,
        gammaFlip: nqData.levels.gammaFlip,
        callWall: nqData.levels.callWall,
        putWall: nqData.levels.putWall,
        resistance: nqData.levels.resistance,
        support: nqData.levels.support,
        totalGex: nqData.totals.gex,
        regime: nqData.regime?.gex || 'neutral'
      };

      // Note: The recalculation also publishes to EXPOSURE_LEVELS channel,
      // which triggers handleExposureLevels and broadcasts via WebSocket
      res.json(transformedData);
      logger.info('✅ Tradier exposure recalculated and WebSocket broadcast triggered');
    } else {
      throw new Error('No NQ data in Tradier refresh response');
    }
  } catch (error) {
    logger.error('❌ Failed to refresh Tradier exposures:', error.message);
    res.status(500).json({
      error: 'Failed to refresh Tradier exposures',
      message: error.message
    });
  }
});

// ES Tradier GEX levels endpoint - get enhanced options data from data-service
app.get('/api/es/tradier/gex/levels', dashboardAuth, async (req, res) => {
  try {
    logger.info('📊 Fetching ES Tradier GEX levels from data-service');
    const response = await axios.get(`${DATA_SERVICE_URL}/exposure/levels`, {
      timeout: 5000
    });

    if (response.data && response.data.futures && response.data.futures.ES) {
      const esData = response.data.futures.ES;

      // Transform to dashboard format
      const transformedData = {
        timestamp: response.data.timestamp,
        source: 'tradier',
        esSpot: esData.spotPrice,
        gammaFlip: esData.levels.gammaFlip,
        callWall: esData.levels.callWall,
        putWall: esData.levels.putWall,
        resistance: esData.levels.resistance,
        support: esData.levels.support,
        totalGex: esData.totals.gex,
        totalVex: esData.totals.vex,
        totalCex: esData.totals.cex,
        maxCallOI: esData.levels.maxCallOI,
        maxPutOI: esData.levels.maxPutOI,
        regime: esData.regime?.gex || 'neutral'
      };

      res.json(transformedData);
      logger.info('✅ ES Tradier GEX levels fetched and transformed successfully');
    } else {
      throw new Error('No ES data in Tradier response');
    }
  } catch (error) {
    logger.error('❌ Failed to fetch ES Tradier GEX levels:', error.message);
    res.status(500).json({
      error: 'Failed to fetch ES Tradier GEX levels',
      message: error.message
    });
  }
});

// Force ES Tradier exposure recalculation
app.post('/api/es/tradier/gex/refresh', dashboardAuth, async (req, res) => {
  try {
    logger.info('🔄 Forcing ES Tradier exposure recalculation...');
    const response = await axios.post(`${DATA_SERVICE_URL}/exposure/refresh`, {}, {
      timeout: 30000
    });

    if (response.data && response.data.futures && response.data.futures.ES) {
      const esData = response.data.futures.ES;

      // Transform to dashboard format
      const transformedData = {
        timestamp: response.data.timestamp,
        source: 'tradier',
        esSpot: esData.futuresPrice,
        gammaFlip: esData.levels.gammaFlip,
        callWall: esData.levels.callWall,
        putWall: esData.levels.putWall,
        resistance: esData.levels.resistance,
        support: esData.levels.support,
        totalGex: esData.totals.gex,
        regime: esData.regime?.gex || 'neutral'
      };

      res.json(transformedData);
      logger.info('✅ ES Tradier exposure recalculated successfully');
    } else {
      throw new Error('No ES data in Tradier refresh response');
    }
  } catch (error) {
    logger.error('❌ Failed to refresh ES Tradier exposures:', error.message);
    res.status(500).json({
      error: 'Failed to refresh ES Tradier exposures',
      message: error.message
    });
  }
});

// Macro Briefing proxy endpoints (macro-briefing service on port 3017)
app.get('/api/briefing/status', dashboardAuth, async (req, res) => {
  try {
    const response = await axios.get(`${MACRO_BRIEFING_URL}/briefing/status`, { timeout: 5000 });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch briefing status:', error.message);
    res.status(500).json({ error: 'Failed to fetch briefing status', message: error.message });
  }
});

app.get('/api/briefing/latest', dashboardAuth, async (req, res) => {
  try {
    const response = await axios.get(`${MACRO_BRIEFING_URL}/briefing/latest`, { timeout: 5000 });
    res.json(response.data);
  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json(error.response.data);
    }
    logger.error('Failed to fetch latest briefing:', error.message);
    res.status(500).json({ error: 'Failed to fetch latest briefing', message: error.message });
  }
});

app.get('/api/briefing/latest/markdown', dashboardAuth, async (req, res) => {
  try {
    const response = await axios.get(`${MACRO_BRIEFING_URL}/briefing/latest/markdown`, { timeout: 5000 });
    res.type('text/markdown').send(response.data);
  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json(error.response.data);
    }
    logger.error('Failed to fetch briefing markdown:', error.message);
    res.status(500).json({ error: 'Failed to fetch briefing markdown', message: error.message });
  }
});

app.post('/api/briefing/generate', dashboardAuth, async (req, res) => {
  try {
    const response = await axios.post(`${MACRO_BRIEFING_URL}/briefing/generate`, {}, { timeout: 180000 });
    res.json(response.data);
  } catch (error) {
    if (error.response?.status === 429) {
      return res.status(429).json(error.response.data);
    }
    logger.error('Failed to generate briefing:', error.message);
    res.status(500).json({ error: 'Failed to generate briefing', message: error.message });
  }
});

// Strategy status endpoint - get latest GEX scalp strategy status
app.get('/api/strategy/gex-scalp/status', dashboardAuth, async (req, res) => {
  try {
    // Check if we have real strategy status from siggen-nq-ivskew
    if (monitoringState.strategyStatus) {
      res.json({
        success: true,
        ...monitoringState.strategyStatus
      });
      return;
    }

    // Fallback to demo data
    res.json({
      success: true,
      strategy: {
        name: 'GEX_SCALP',
        enabled: true,
        session: {
          in_session: true,
          current_hour: new Date().getHours(),
          session_hours: "18:00 - 16:00"
        },
        cooldown: {
          in_cooldown: false,
          formatted: "Ready",
          seconds_remaining: 0
        }
      },
      candle: {
        symbol: 'NQ',
        open: 25550.0,
        high: 25580.0,
        low: 25530.0,
        close: 25570.0,
        time_to_close: {
          seconds_remaining: Math.floor(Math.random() * 900),
          formatted: `${String(Math.floor(Math.random() * 15)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`,
          percentage_complete: Math.random() * 100
        }
      },
      gex_levels: {
        put_wall: 25500.0,
        call_wall: 25650.0,
        support: [25480.0, 25460.0, 25440.0],
        resistance: [25600.0, 25620.0, 25640.0]
      },
      proximity: {
        put_wall: {
          level: 25500.0,
          distance_points: 70.0 + (Math.random() - 0.5) * 20,
          distance_percent: 0.27 + (Math.random() - 0.5) * 0.1,
          above: true,
          approaching: false,
          critical: false
        },
        support_1: {
          level: 25480.0,
          distance_points: 90.0 + (Math.random() - 0.5) * 20,
          distance_percent: 0.35 + (Math.random() - 0.5) * 0.1,
          above: true,
          approaching: false,
          critical: false
        }
      },
      evaluation_readiness: {
        ready: true,
        conditions_met: ["Strategy enabled", "In trading session", "Cooldown expired", "GEX levels available"],
        blockers: []
      },
      timestamp: new Date().toISOString(),
      message: 'Demo data - awaiting real strategy publisher'
    });
  } catch (error) {
    logger.error('Failed to fetch strategy status:', error);
    res.status(500).json({
      error: 'Failed to fetch strategy status',
      details: error.message
    });
  }
});

// ES Cross-Signal strategy status - proxied from signal-generator (multi-strategy engine)
app.get('/api/strategy/es-cross-signal/status', dashboardAuth, async (req, res) => {
  try {
    const response = await axios.get(`${SIGNAL_GENERATOR_URL}/strategy/status/es-cross-signal`, { timeout: 5000 });
    res.json({ success: true, ...response.data });
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      res.json({
        success: false,
        error: 'signal-generator not running',
        message: 'Start signal-generator: pm2 start ecosystem.config.cjs --only signal-generator'
      });
    } else {
      logger.error('Failed to fetch ES cross-signal status:', error.message);
      res.status(500).json({ error: 'Failed to fetch ES cross-signal status', details: error.message });
    }
  }
});

// IV Skew GEX strategy status - proxied from signal-generator (multi-strategy engine)
app.get('/api/strategy/iv-skew-gex/status', dashboardAuth, async (req, res) => {
  try {
    const response = await axios.get(`${SIGNAL_GENERATOR_URL}/strategy/status/iv-skew-gex`, { timeout: 5000 });
    res.json({ success: true, ...response.data });
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      res.json({
        success: false,
        error: 'signal-generator not running',
        message: 'Start signal-generator: pm2 start ecosystem.config.cjs --only signal-generator'
      });
    } else {
      logger.error('Failed to fetch IV skew GEX status:', error.message);
      res.status(500).json({ error: 'Failed to fetch IV skew GEX status', details: error.message });
    }
  }
});

// AI Trader strategy status - proxied from siggen-nq-aitrader
app.get('/api/strategy/ai-trader/status', dashboardAuth, async (req, res) => {
  try {
    const response = await axios.get(`${SIGNAL_GENERATOR_AI_URL}/ai/status`, { timeout: 5000 });
    res.json({ success: true, ...response.data });
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      res.json({
        success: false,
        error: 'siggen-nq-aitrader not running',
        message: 'Start AI trader: pm2 start ecosystem.config.cjs --only siggen-nq-aitrader'
      });
    } else {
      logger.error('Failed to fetch AI trader status:', error.message);
      res.status(500).json({ error: 'Failed to fetch AI trader status', details: error.message });
    }
  }
});

// Squeeze Momentum endpoints
app.get('/api/squeeze/status', dashboardAuth, (req, res) => {
  try {
    // Get current squeeze momentum data from monitoring state
    if (monitoringState.squeezeData) {
      res.json({
        success: true,
        timestamp: monitoringState.squeezeData.timestamp,
        symbol: 'NQ',
        squeeze: monitoringState.squeezeData.squeeze,
        momentum: monitoringState.squeezeData.momentum,
        signals: monitoringState.squeezeData.signals,
        squeezeColor: monitoringState.squeezeData.squeezeColor
      });
    } else {
      res.json({
        success: true,
        message: 'No squeeze momentum data available yet',
        symbol: 'NQ',
        squeeze: null,
        momentum: null
      });
    }
  } catch (error) {
    logger.error('Failed to fetch squeeze momentum status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch squeeze momentum status',
      details: error.message
    });
  }
});

// Combined GEX and Squeeze analysis endpoint
app.get('/api/analysis/gex-squeeze', dashboardAuth, async (req, res) => {
  try {
    // Get current GEX levels
    let gexLevels = null;
    try {
      const gexResponse = await axios.get(`${DATA_SERVICE_URL}/gex/levels/nq`, { timeout: 3000 });
      gexLevels = gexResponse.data;
    } catch (error) {
      logger.warn('Failed to fetch live GEX levels for analysis:', error.message);
    }

    // Combine GEX and squeeze data for analysis
    const analysis = {
      timestamp: new Date().toISOString(),
      gex_levels: gexLevels,
      squeeze_momentum: monitoringState.squeezeData,
      confluence_analysis: null
    };

    // Perform confluence analysis if we have both datasets
    if (gexLevels && monitoringState.squeezeData) {
      const currentPrice = gexLevels.nqSpot || 21000; // Fallback price

      analysis.confluence_analysis = {
        current_price: currentPrice,
        near_gex_level: isNearGexLevel(currentPrice, gexLevels),
        squeeze_condition: monitoringState.squeezeData.squeeze.state,
        momentum_direction: monitoringState.squeezeData.momentum.value > 0 ? 'bullish' : 'bearish',
        momentum_strength: Math.abs(monitoringState.squeezeData.momentum.value),
        potential_setup: evaluateSqueezeGexSetup(currentPrice, gexLevels, monitoringState.squeezeData)
      };
    }

    res.json({
      success: true,
      ...analysis
    });

  } catch (error) {
    logger.error('Failed to generate GEX-Squeeze analysis:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate GEX-Squeeze analysis',
      details: error.message
    });
  }
});

// Helper function to check if price is near GEX level
function isNearGexLevel(price, gexLevels, proximityPoints = 50) {
  if (!gexLevels) return null;

  // Check gamma flip
  if (Math.abs(price - gexLevels.gammaFlip) <= proximityPoints) {
    return { level: gexLevels.gammaFlip, type: 'gamma_flip', distance: Math.abs(price - gexLevels.gammaFlip) };
  }

  // Check support levels
  if (gexLevels.support) {
    for (const support of gexLevels.support.slice(0, 3)) {
      if (Math.abs(price - support) <= proximityPoints) {
        return { level: support, type: 'support', distance: Math.abs(price - support) };
      }
    }
  }

  // Check resistance levels
  if (gexLevels.resistance) {
    for (const resistance of gexLevels.resistance.slice(0, 3)) {
      if (Math.abs(price - resistance) <= proximityPoints) {
        return { level: resistance, type: 'resistance', distance: Math.abs(price - resistance) };
      }
    }
  }

  return null;
}

// Helper function to evaluate potential squeeze + GEX setup
function evaluateSqueezeGexSetup(price, gexLevels, squeezeData) {
  const nearLevel = isNearGexLevel(price, gexLevels);
  if (!nearLevel || !squeezeData) return 'no_setup';

  const momentum = squeezeData.momentum.value;
  const squeezeState = squeezeData.squeeze.state;

  // Look for confluence patterns
  if (nearLevel.type === 'support' && momentum > 0 && squeezeData.signals.momentumShift) {
    return 'bullish_reversal_setup';
  }

  if (nearLevel.type === 'resistance' && momentum < 0 && squeezeData.signals.momentumShift) {
    return 'bearish_reversal_setup';
  }

  if (squeezeData.signals.squeezeBreakout && nearLevel.distance <= 25) {
    return 'squeeze_breakout_near_level';
  }

  return 'monitoring';
}

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

    let tradingEnabled = true;
    try { const v = await messageBus.publisher.get('trading:kill_switch'); if (v !== null) tradingEnabled = v === 'true'; } catch (e) { /* default true */ }

    res.json({
      tradingEnabled,
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

    let tradingEnabled = true;
    try { const v = await messageBus.publisher.get('trading:kill_switch'); if (v !== null) tradingEnabled = v === 'true'; } catch (e) { /* default true */ }

    res.json({
      tradingEnabled,
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
    'tradovate': process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011',
    'data-service': DATA_SERVICE_URL,
    'signal-generator': SIGNAL_GENERATOR_URL,
    'ai-trader': SIGNAL_GENERATOR_AI_URL,
    'macro-briefing': MACRO_BRIEFING_URL
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

// Restart service endpoint (Sevalla API integration for production)
app.post('/api/services/:serviceName/restart', dashboardAuth, async (req, res) => {
  const { serviceName } = req.params;

  // Sevalla configuration
  const sevallaApiKey = process.env.SEVALLA_API_KEY;
  const sevallaAppIds = {
    'tradovate-service': process.env.SEVALLA_APP_ID_TRADOVATE,
    'trade-orchestrator': process.env.SEVALLA_APP_ID_ORCHESTRATOR,
    'monitoring-service': process.env.SEVALLA_APP_ID_MONITORING,
    'data-service': process.env.SEVALLA_APP_ID_DATA_SERVICE,
    'signal-generator': process.env.SEVALLA_APP_ID_SIGNAL_GENERATOR,
    'ai-trader': process.env.SEVALLA_APP_ID_AI_TRADER,
    'macro-briefing': process.env.SEVALLA_APP_ID_MACRO_BRIEFING
  };

  const appId = sevallaAppIds[serviceName];

  // Check if we have Sevalla configuration
  if (!sevallaApiKey || !appId) {
    logger.warn(`⚠️ Restart requested for ${serviceName} but Sevalla not configured`);
    return res.status(503).json({
      error: 'Service restart not available - Sevalla configuration missing',
      service: serviceName
    });
  }

  try {
    logger.info(`🔄 Initiating restart for ${serviceName} via Sevalla API`);

    // Add to activity log
    monitoringState.activity.push({
      timestamp: new Date().toISOString(),
      type: 'system',
      message: `🔄 Restarting ${serviceName} (requested by dashboard)`
    });
    if (monitoringState.activity.length > monitoringState.maxActivitySize) {
      monitoringState.activity.shift();
    }

    // Emit WebSocket event for real-time update
    io.emit('service_restart_initiated', {
      service: serviceName,
      timestamp: new Date().toISOString(),
      status: 'initiated'
    });

    // Special handling for monitoring-service self-restart
    if (serviceName === 'monitoring-service') {
      // Send response BEFORE triggering restart
      res.json({
        success: true,
        message: 'Restart initiated - monitoring service will be temporarily unavailable',
        service: serviceName
      });

      // Small delay to ensure response is sent
      setTimeout(async () => {
        try {
          const response = await axios.post(
            'https://api.sevalla.com/v2/applications/deployments',
            {
              app_id: appId,
              is_restart: true  // Restart without rebuild
            },
            {
              headers: {
                'Authorization': `Bearer ${sevallaApiKey}`,
                'Content-Type': 'application/json'
              },
              timeout: 30000
            }
          );
          logger.info(`✅ Monitoring service self-restart triggered successfully`);
        } catch (error) {
          logger.error(`❌ Failed to restart monitoring service:`, error.message);
        }
      }, 500);

      return; // Exit early for self-restart
    }

    // Normal restart for other services
    const response = await axios.post(
      'https://api.sevalla.com/v2/applications/deployments',
      {
        app_id: appId,
        is_restart: true  // Restart without rebuild
      },
      {
        headers: {
          'Authorization': `Bearer ${sevallaApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    logger.info(`✅ Restart initiated for ${serviceName}:`, response.data);

    // Add to activity log
    monitoringState.activity.push({
      timestamp: new Date().toISOString(),
      type: 'system',
      message: `✅ ${serviceName} restart triggered successfully`
    });
    if (monitoringState.activity.length > monitoringState.maxActivitySize) {
      monitoringState.activity.shift();
    }

    // Emit WebSocket event
    io.emit('service_restart_success', {
      service: serviceName,
      timestamp: new Date().toISOString(),
      deploymentId: response.data?.deployment_id
    });

    res.json({
      success: true,
      message: `Restart initiated for ${serviceName}`,
      deploymentId: response.data?.deployment_id
    });

  } catch (error) {
    logger.error(`❌ Failed to restart ${serviceName}:`, error.response?.data || error.message);

    // Add error to activity log
    monitoringState.activity.push({
      timestamp: new Date().toISOString(),
      type: 'stderr',
      message: `❌ Failed to restart ${serviceName}: ${error.message}`
    });
    if (monitoringState.activity.length > monitoringState.maxActivitySize) {
      monitoringState.activity.shift();
    }

    // Emit error event
    io.emit('service_restart_failed', {
      service: serviceName,
      timestamp: new Date().toISOString(),
      error: error.message
    });

    res.status(500).json({
      error: 'Failed to restart service',
      service: serviceName,
      details: error.response?.data?.error || error.message
    });
  }
});

// Generic proxy endpoint for internal service API calls
app.all('/api/proxy/:serviceName/*', dashboardAuth, async (req, res) => {
  const { serviceName } = req.params;
  const path = req.params[0];

  const serviceUrls = {
    'trade-orchestrator': process.env.TRADE_ORCHESTRATOR_URL || 'http://localhost:3013',
    'tradovate': process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011',
    'data-service': DATA_SERVICE_URL,
    'signal-generator': SIGNAL_GENERATOR_URL,
    'ai-trader': SIGNAL_GENERATOR_AI_URL,
    'macro-briefing': MACRO_BRIEFING_URL
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

// Handler for strategy status updates
async function handleStrategyStatus(message) {
  try {
    // Store latest status in memory for now (Redis access method TBD)
    monitoringState.strategyStatus = message;

    // Broadcast to WebSocket clients
    broadcast('strategyStatus', message);
    logger.info('📈 Strategy status updated and broadcasted');
  } catch (error) {
    logger.error('Error handling strategy status:', error);
  }
}

// Handler for squeeze momentum status updates
async function handleSqueezeStatus(message) {
  try {
    // Store latest squeeze momentum data
    monitoringState.squeezeData = message;

    // Broadcast to WebSocket clients
    broadcast('squeezeStatus', message);
    logger.debug(`🎯 Squeeze momentum status updated: ${message.momentum?.value?.toFixed(4) || 'N/A'} | State: ${message.squeeze?.state || 'N/A'}`);
  } catch (error) {
    logger.error('Error handling squeeze status:', error);
  }
}

// Handler for general analytics data
async function handleAnalytics(message) {
  try {
    if (message.type && message.data) {
      // Store analytics data by type
      monitoringState.analyticsData.set(message.type, {
        ...message,
        timestamp: new Date().toISOString()
      });

      // Broadcast squeeze momentum analytics specifically
      if (message.type === 'squeeze_momentum') {
        broadcast('analyticsUpdate', message);
        logger.debug('📊 Analytics data updated:', message.type);
      }
    }
  } catch (error) {
    logger.error('Error handling analytics data:', error);
  }
}

// Handler for GEX exposure levels from Tradier
async function handleExposureLevels(message) {
  try {
    if (!message || !message.futures) {
      logger.warn('Invalid exposure levels message received');
      return;
    }

    // Transform Tradier NQ data to the format frontend expects
    const nqData = message.futures.NQ;
    if (nqData) {
      const tradierLevels = {
        timestamp: message.timestamp,
        source: 'tradier',
        nqSpot: nqData.futuresPrice,
        gammaFlip: nqData.levels?.gammaFlip,
        callWall: nqData.levels?.callWall,
        putWall: nqData.levels?.putWall,
        resistance: nqData.levels?.resistance || [],
        support: nqData.levels?.support || [],
        totalGex: nqData.totals?.gex,
        totalVex: nqData.totals?.vex,
        totalCex: nqData.totals?.cex,
        regime: nqData.regime?.gex || 'neutral'
      };

      // Store in monitoring state
      monitoringState.gexLevels.tradier = tradierLevels;

      // Broadcast to WebSocket clients
      // Send both CBOE (if cached) and Tradier for full update
      const gexUpdate = {
        cboe: monitoringState.gexLevels.cboe,
        tradier: tradierLevels
      };

      broadcast('gex_levels', gexUpdate);
      logger.info(`📊 GEX levels broadcasted: Tradier GF=${tradierLevels.gammaFlip}, S1=${tradierLevels.support?.[0]}, R1=${tradierLevels.resistance?.[0]}`);
    }
  } catch (error) {
    logger.error('Error handling exposure levels:', error);
  }
}

// Handler for IV Skew updates from Tradier
async function handleIVSkew(message) {
  try {
    if (!message) {
      logger.warn('Invalid IV skew message received');
      return;
    }

    // Store in monitoring state for REST API access
    monitoringState.ivSkew = message;

    // Broadcast to WebSocket clients
    broadcast('iv_skew', message);
    logger.debug(`📈 IV Skew broadcasted: skew=${(message.skew * 100).toFixed(3)}%, signal=${message.signal}`);
  } catch (error) {
    logger.error('Error handling IV skew:', error);
  }
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

  // Broadcast in format expected by frontend (account_data_updated with dataType)
  broadcast('account_data_updated', {
    dataType: 'balance',
    accountId: message.accountId,
    data: {
      accountId: account.id,
      balance: account.balance,
      equity: account.balance, // Use balance as equity for now
      margin: account.marginUsed,
      availableFunds: account.marginAvailable || (account.balance - account.marginUsed),
      dayPnL: account.realizedPnL,
      dayPnLPercent: account.balance > 0 ? (account.realizedPnL / account.balance * 100) : 0,
      cached: false,
      timestamp: account.lastUpdate
    }
  });

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

async function handlePositionClosed(message) {
  logger.info(`🔒 Position closed event received:`, message);

  if (!message || !message.symbol) {
    logger.warn('Position closed event missing symbol:', message);
    return;
  }

  // Remove the position from state
  const positionKey = `${message.accountId}-${message.symbol}`;
  if (monitoringState.positions.has(positionKey)) {
    monitoringState.positions.delete(positionKey);
    logger.info(`🧹 Removed closed position from state: ${positionKey}`);
  }

  // Broadcast position_closed event to frontend (triggers account refresh)
  broadcast('position_closed', {
    accountId: message.accountId,
    symbol: message.symbol,
    contractId: message.contractId,
    closedByOrder: message.closedByOrder,
    orderType: message.orderType,
    fillPrice: message.fillPrice,
    timestamp: message.timestamp || new Date().toISOString(),
    source: message.source
  });

  logActivity('position', `Position CLOSED for ${message.symbol}`, message);
}

async function handlePriceUpdate(message) {
  // Add error handling for malformed messages
  if (!message || typeof message !== 'object') {
    logger.warn('Received invalid price update message:', message);
    return;
  }


  if (!message.symbol || message.close === undefined) {
    logger.warn('Received incomplete price update message:', message);
    return;
  }

  logger.debug(`🔔 PRICE_UPDATE received: ${message.baseSymbol || message.symbol} = ${message.close} (source: ${message.source})`);

  // Merge with existing stored data so session fields (from qsd) persist
  // across candle updates (from du), and vice versa. Each broadcast then
  // carries complete data — the frontend doesn't need to merge.
  const key = message.baseSymbol || message.symbol;
  const existing = monitoringState.prices.get(key) || {};
  const quoteData = {
    ...existing,
    // Always overwrite core fields
    symbol: message.symbol,
    baseSymbol: message.baseSymbol,
    close: message.close,
    timestamp: message.timestamp,
    source: message.source,
  };
  // Only update fields that are actually present in this message
  if (message.open != null) quoteData.open = message.open;
  if (message.high != null) quoteData.high = message.high;
  if (message.low != null) quoteData.low = message.low;
  if (message.volume != null) quoteData.volume = message.volume;
  if (message.previousClose != null) quoteData.previousClose = message.previousClose;
  if (message.sessionOpen != null) quoteData.sessionOpen = message.sessionOpen;
  if (message.sessionHigh != null) quoteData.sessionHigh = message.sessionHigh;
  if (message.sessionLow != null) quoteData.sessionLow = message.sessionLow;
  if (message.prevClose != null) quoteData.prevClose = message.prevClose;
  if (message.change != null) quoteData.change = message.change;
  if (message.changePercent != null) quoteData.changePercent = message.changePercent;
  // candleTimestamp: only carry forward when present, otherwise clear it
  // so qsd broadcasts don't carry a stale candle timestamp
  if (message.candleTimestamp != null) {
    quoteData.candleTimestamp = message.candleTimestamp;
  } else {
    delete quoteData.candleTimestamp;
  }

  // Store by full contract symbol (e.g., "NQZ2024")
  monitoringState.prices.set(message.symbol, quoteData);

  // Also store by base symbol for frontend compatibility (e.g., "NQ")
  if (message.baseSymbol) {
    monitoringState.prices.set(message.baseSymbol, quoteData);
  }

  broadcast('market_data', quoteData);
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

    // Source-based priority handling for order updates
    const incomingSource = message.source || 'unknown';
    const existingSource = existingOrder.source || 'unknown';
    const incomingTimestamp = new Date(message.timestamp || new Date().toISOString()).getTime();
    const existingTimestamp = new Date(existingOrder.timestamp || existingOrder.lastUpdate || '1970-01-01').getTime();
    const timeDifference = incomingTimestamp - existingTimestamp;

    // Priority rules:
    // 1. Strategy updates (strategy_order_update) take priority over WebSocket updates within 10 seconds
    // 2. Recent updates (< 5 seconds) take priority regardless of source
    // 3. WebSocket updates older than 10 seconds can override strategy updates

    let shouldUpdate = true;
    if (existingSource === 'strategy_order_update' && incomingSource === 'websocket_order_update') {
      // Don't let WebSocket updates override recent strategy updates
      if (timeDifference < 10000) { // 10 seconds grace period
        shouldUpdate = false;
        logger.info(`🚫 Ignoring WebSocket order update for ${message.orderId} - strategy update ${Math.round(timeDifference/1000)}s ago takes priority`);
      }
    } else if (incomingSource === 'strategy_order_update') {
      // Strategy updates always take priority
      shouldUpdate = true;
      logger.info(`✅ Strategy order update for ${message.orderId} - overriding existing data`);
    } else if (timeDifference < -5000) {
      // Don't accept updates that are more than 5 seconds older than existing data
      shouldUpdate = false;
      logger.debug(`🕒 Ignoring older order update for ${message.orderId} - existing data is newer`);
    }

    if (shouldUpdate) {
      // Update existing order with new data, preserving important fields
      const updatedOrder = {
        ...existingOrder,
        ...order,
        lastUpdate: order.timestamp,
        source: incomingSource
      };
      monitoringState.orders.set(message.orderId, updatedOrder);
      logger.debug(`📋 Updated order ${message.orderId} from source: ${incomingSource}`);
    }
  } else {
    logger.debug('📋 New order, adding to monitoring state:', message.orderId);
    const newOrder = { ...order, source: message.source || 'unknown' };
    monitoringState.orders.set(message.orderId, newOrder);
  }

  broadcast('order_update', order);

  logActivity('order', `Order ${message.action} ${message.symbol} - ${message.status || 'placed'}`, order);
}

async function handleOrderCancelled(message) {
  logger.info('📋 Received order cancellation:', message.orderId || message.symbol);

  // Build order data from monitoring state (has full details) or from the message
  const existing = message.orderId ? monitoringState.orders.get(message.orderId) : null;
  const order = {
    orderId: message.orderId,
    symbol: existing?.symbol || message.symbol,
    action: existing?.action || message.action || message.side,
    quantity: existing?.quantity || message.quantity,
    price: existing?.price || message.price,
    status: 'Cancelled',
    orderStatus: 'Cancelled',
  };

  // Remove from monitoring state
  if (message.orderId) {
    monitoringState.orders.delete(message.orderId);
  }

  broadcast('order_cancelled', order);
  broadcast('order_update', order);

  logActivity('order', `Order cancelled: ${order.action || '?'} ${order.symbol || '?'}`, order);
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

// Handle full sync start - clear orders to prepare for ground truth
async function handleFullSyncStarted(message) {
  const previousCount = monitoringState.orders.size;
  monitoringState.orders.clear();

  logger.info(`🔄 Full sync started - cleared ${previousCount} orders from monitoring state to prepare for ground truth`);

  // Broadcast update to connected clients
  broadcast('orders', {
    orders: [],
    source: 'full_sync_start'
  });
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

async function handleMarketNews(message) {
  logger.info(`📰 Market news: ${message.title} (${message.type})`);

  // Add to news array with timestamp
  const newsItem = {
    ...message,
    id: `${message.type}_${Date.now()}`,
    receivedAt: new Date().toISOString()
  };

  monitoringState.marketNews.unshift(newsItem);

  // Trim to max size
  if (monitoringState.marketNews.length > monitoringState.maxNewsSize) {
    monitoringState.marketNews = monitoringState.marketNews.slice(0, monitoringState.maxNewsSize);
  }

  // Emit WebSocket event for real-time updates
  io.emit('market_news', newsItem);
}

// Startup sequence
async function startup() {
  try {
    logger.info(`Starting ${SERVICE_NAME}...`);

    // Connect to message bus
    logger.info('Connecting to message bus...');
    await messageBus.connect();
    logger.info('Message bus connected');

    // Handle MessageBus errors to prevent crashes
    messageBus.on('error', (err) => {
      logger.error('MessageBus error (handled):', err);
      // Service continues running - reconnection logic will handle recovery
    });

    // Load configuration from Redis
    logger.info('Loading configuration from Redis...');
    monitoringState.positionSizing = await loadPositionSizingSettings();
    monitoringState.contractMappings = await loadContractMappings();
    logger.info('Configuration loaded from Redis');

    // Subscribe to all relevant channels
    const subscriptions = [
      [CHANNELS.ACCOUNT_UPDATE, handleAccountUpdate],
      [CHANNELS.POSITION_UPDATE, handlePositionUpdate],
      [CHANNELS.POSITION_CLOSED, handlePositionClosed],
      [CHANNELS.POSITION_REALTIME_UPDATE, handlePositionRealtimeUpdate],
      [CHANNELS.PRICE_UPDATE, handlePriceUpdate],
      [CHANNELS.ORDER_PLACED, handleOrderUpdate],
      [CHANNELS.ORDER_FILLED, handleOrderUpdate],
      [CHANNELS.ORDER_REJECTED, handleOrderUpdate],
      [CHANNELS.ORDER_CANCELLED, handleOrderCancelled],
      [CHANNELS.ORDER_REALTIME_UPDATE, handleOrderRealtimeUpdate],
      [CHANNELS.TRADOVATE_SYNC_COMPLETED, handleTradovateSyncCompleted],
      [CHANNELS.TRADOVATE_FULL_SYNC_STARTED, handleFullSyncStarted],
      [CHANNELS.SERVICE_HEALTH, handleServiceHealth],
      [CHANNELS.SERVICE_STARTED, handleServiceStarted],
      [CHANNELS.SERVICE_STOPPED, handleServiceStopped],
      [CHANNELS.WEBHOOK_RECEIVED, handleWebhookReceived],
      [CHANNELS.TRADE_VALIDATED, handleTradeValidated],
      [CHANNELS.TRADE_REJECTED, handleTradeRejected],
      [CHANNELS.MARKET_NEWS, handleMarketNews],
      [CHANNELS.STRATEGY_STATUS, handleStrategyStatus],
      [CHANNELS.SQUEEZE_STATUS, handleSqueezeStatus],
      [CHANNELS.ANALYTICS, handleAnalytics],
      [CHANNELS.EXPOSURE_LEVELS, handleExposureLevels],
      [CHANNELS.IV_SKEW, handleIVSkew],
      // Discord notification subscriptions
      [CHANNELS.TRADE_SIGNAL, handleTradeSignalDiscord],
      [CHANNELS.TRADE_REJECTED, handleTradeRejectedDiscord],
      [CHANNELS.ORDER_FILLED, handleOrderFilledDiscord],
      [CHANNELS.POSITION_OPENED, handlePositionOpenedDiscord],
      [CHANNELS.POSITION_CLOSED, handlePositionClosedDiscord],
      // TradingView auth event Discord notifications
      [CHANNELS.SERVICE_ERROR, handleTvAuthDiscord]
    ];


    for (const [channel, handler] of subscriptions) {
      try {
        await messageBus.subscribe(channel, handler);
        logger.info(`Subscribed to ${channel}`);
      } catch (error) {
        logger.error(`Failed to subscribe to ${channel}:`, error.message);
      }
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

      // Log Discord notification status
      const discordEnabled = process.env.DISCORD_NOTIFICATIONS_ENABLED === 'true';
      const discordConfigured = !!process.env.DISCORD_WEBHOOK_URL;
      if (discordEnabled && discordConfigured) {
        logger.info(`📢 Discord notifications: ENABLED (strategy whitelist: ${process.env.DISCORD_STRATEGY_WHITELIST || 'ALL'})`);
      } else if (discordConfigured && !discordEnabled) {
        logger.info('📢 Discord notifications: DISABLED (set DISCORD_NOTIFICATIONS_ENABLED=true to enable)');
      } else {
        logger.info('📢 Discord notifications: NOT CONFIGURED (add DISCORD_WEBHOOK_URL to .env)');
      }
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