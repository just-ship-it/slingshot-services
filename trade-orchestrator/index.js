import express from 'express';
import axios from 'axios';
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';

const SERVICE_NAME = 'trade-orchestrator';
const logger = createLogger(SERVICE_NAME);

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3013 });

// Trading state - comprehensive position and order tracking
const tradingState = {
  // Trading Positions: Complete view of active trades
  // Key: symbol, Value: TradingPosition object with main position + associated orders
  tradingPositions: new Map(),

  // Working Orders: All orders that are still active/pending
  // Key: orderId, Value: Order object with enriched data
  workingOrders: new Map(),

  // Order Relationships: Track which orders belong to which position/bracket
  // Key: orderId, Value: { positionSymbol, orderRole, parentOrderId }
  orderRelationships: new Map(),

  // Account settings and configuration
  accountSettings: new Map(),

  // Global trading controls
  tradingEnabled: true,

  // Trading statistics
  stats: {
    totalPositions: 0,
    totalWorkingOrders: 0,
    dailyTrades: 0,
    dailyPnL: 0
  }
};

// TradingPosition structure:
// {
//   symbol: 'MNQZ5',
//   accountId: '12345',
//   netPosition: 2,  // Net quantity (positive = long, negative = short)
//   side: 'long',    // 'long' or 'short'
//   entryPrice: 21050.0,
//   currentPrice: 21075.0,
//   unrealizedPnL: 50.0,
//
//   // Associated orders
//   stopLossOrder: { orderId, price, status },
//   takeProfitOrder: { orderId, price, status },
//   pendingEntryOrders: [{ orderId, action, quantity, price }],
//
//   // Metadata
//   createdAt: timestamp,
//   lastUpdate: timestamp,
//   strategy: 'LDPS',
//   riskParams: { stopPoints, targetPoints, trailingStop }
// }

// Initialize Express app
const app = express();
app.use(express.json());

// Enable CORS for frontend access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = await healthCheck(SERVICE_NAME, {
    messageBus: messageBus.isConnected,
    tradingEnabled: tradingState.tradingEnabled,
    tradingPositions: tradingState.tradingPositions.size,
    workingOrders: tradingState.workingOrders.size,
    stats: tradingState.stats
  });
  res.json(health);
});

// Trading control endpoints
app.post('/trading/enable', (req, res) => {
  tradingState.tradingEnabled = true;
  logger.info('Trading enabled');
  res.json({ status: 'Trading enabled' });
});

app.post('/trading/disable', (req, res) => {
  tradingState.tradingEnabled = false;
  logger.warn('Trading disabled');
  res.json({ status: 'Trading disabled' });
});

app.get('/trading/status', (req, res) => {
  res.json({
    enabled: tradingState.tradingEnabled,
    tradingPositions: tradingState.tradingPositions.size,
    workingOrders: tradingState.workingOrders.size,
    stats: tradingState.stats
  });
});

// API Endpoints for Frontend Dashboard

// Get all active trading positions with their associated orders
app.get('/api/trading/positions', (req, res) => {
  const positions = Array.from(tradingState.tradingPositions.values());
  res.json(positions);
});

// Get all working orders
app.get('/api/trading/orders', (req, res) => {
  const orders = Array.from(tradingState.workingOrders.values());
  res.json(orders);
});

// Get comprehensive trading status for dashboard
app.get('/api/trading/active-status', (req, res) => {
  const positions = Array.from(tradingState.tradingPositions.values());
  const orders = Array.from(tradingState.workingOrders.values());

  // Separate different types of orders
  const pendingEntryOrders = orders.filter(order =>
    !tradingState.orderRelationships.has(order.id) ||
    tradingState.orderRelationships.get(order.id).orderRole === 'entry'
  );

  const stopOrders = orders.filter(order => {
    const relationship = tradingState.orderRelationships.get(order.id);
    return relationship && relationship.orderRole === 'stop_loss';
  });

  const targetOrders = orders.filter(order => {
    const relationship = tradingState.orderRelationships.get(order.id);
    return relationship && relationship.orderRole === 'take_profit';
  });

  res.json({
    tradingEnabled: tradingState.tradingEnabled,
    positions: positions,
    pendingEntryOrders: pendingEntryOrders,
    stopOrders: stopOrders,
    targetOrders: targetOrders,
    stats: tradingState.stats,
    lastUpdate: new Date().toISOString()
  });
});

// Get specific position by symbol
app.get('/api/trading/positions/:symbol', (req, res) => {
  const position = tradingState.tradingPositions.get(req.params.symbol);
  if (position) {
    res.json(position);
  } else {
    res.status(404).json({ error: 'Position not found' });
  }
});

// Process webhook signals
async function handleWebhookReceived(message) {
  try {
    logger.info('Processing webhook signal:', message.id);

    // Check if trading is enabled
    if (!tradingState.tradingEnabled) {
      logger.warn('Trading disabled - ignoring signal');
      await messageBus.publish(CHANNELS.TRADE_REJECTED, {
        reason: 'Trading disabled',
        originalSignal: message,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Parse and validate trading signal
    const signal = parseTradeSignal(message.body);
    if (!signal) {
      logger.warn('Invalid trade signal format');
      await messageBus.publish(CHANNELS.TRADE_REJECTED, {
        reason: 'Invalid signal format',
        originalSignal: message,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Apply business rules
    const validation = await validateTradeSignal(signal);
    if (!validation.valid) {
      logger.warn(`Trade signal rejected: ${validation.reason}`);
      await messageBus.publish(CHANNELS.TRADE_REJECTED, {
        reason: validation.reason,
        signal,
        originalSignal: message,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Calculate position size and apply position sizing conversion
    const positionSizing = await calculatePositionSize(signal);

    // Log position sizing results
    if (positionSizing.converted) {
      logger.info(`🔄 Position sizing conversion: ${positionSizing.originalQuantity} ${positionSizing.originalSymbol} → ${positionSizing.quantity} ${positionSizing.symbol} (${positionSizing.reason})`);
    } else {
      logger.info(`📊 Position sizing: ${positionSizing.quantity} ${positionSizing.symbol} (${positionSizing.reason})`);
    }

    // Special handling for position_closed action
    if (signal.action === 'position_closed') {
      logger.info(`🔴 Position close requested for ${positionSizing.symbol}`);

      // Send position close request directly to tradovate-service via webhook channel
      // This bypasses the ORDER_REQUEST channel and uses the webhook handler that expects position_closed
      const closeMessage = {
        id: message.id,
        type: 'trade_signal',
        body: {
          action: 'position_closed',
          symbol: positionSizing.symbol, // Use converted symbol
          side: signal.side,
          accountId: signal.accountId || getDefaultAccountId(),
          timestamp: new Date().toISOString()
        }
      };

      // Route directly to tradovate service webhook handler
      await messageBus.publish(CHANNELS.WEBHOOK_TRADE, closeMessage);

      logger.info(`Position close signal routed to tradovate-service: ${positionSizing.symbol}`);
      return; // Exit early, no need to process as regular order
    }

    // Map signal fields to tradovate-service format for regular orders
    let mappedAction, mappedOrderType, mappedPrice, mappedStopPrice, mappedTakeProfit;

    // Log the incoming signal for debugging
    logger.info(`📝 Processing signal - action: ${signal.action}, side: ${signal.side}, price: ${signal.price}, stop_loss: ${signal.stop_loss}, take_profit: ${signal.take_profit}`);

    // Handle different action types
    if (signal.action === 'place_limit') {
      // Bracket limit order
      mappedAction = signal.side === 'buy' ? 'Buy' : 'Sell';
      mappedOrderType = 'Limit';
      mappedPrice = signal.price;
      mappedStopPrice = signal.stop_loss; // Frontend sends stop_loss → tradovate needs stopPrice
      mappedTakeProfit = signal.take_profit; // Frontend sends take_profit → tradovate needs takeProfit
      logger.info(`🎯 Mapped to bracket order - action: ${mappedAction}, type: ${mappedOrderType}, price: ${mappedPrice}, stop: ${mappedStopPrice}, target: ${mappedTakeProfit}`);
    } else {
      // Handle other action types (buy, sell, etc.)
      mappedAction = signal.action;
      mappedOrderType = signal.orderType || 'Market';
      mappedPrice = signal.price;
      mappedStopPrice = signal.stopPrice;
      mappedTakeProfit = signal.takeProfit;
      logger.info(`📌 Standard order - action: ${mappedAction}, type: ${mappedOrderType}`);
    }

    // Prepare order request with potentially converted symbol and quantity
    const orderRequest = {
      accountId: signal.accountId || getDefaultAccountId(),
      symbol: positionSizing.symbol, // Use converted symbol
      action: mappedAction,
      quantity: positionSizing.quantity, // Use converted quantity
      orderType: mappedOrderType,
      price: mappedPrice,
      stopPrice: mappedStopPrice,
      takeProfit: mappedTakeProfit,
      signalId: message.id,
      timestamp: new Date().toISOString(),
      // Add position sizing metadata
      positionSizing: {
        originalSymbol: positionSizing.originalSymbol,
        originalQuantity: positionSizing.originalQuantity,
        converted: positionSizing.converted,
        reason: positionSizing.reason
      }
    };

    // Publish validated trade signal
    await messageBus.publish(CHANNELS.TRADE_VALIDATED, {
      signal,
      orderRequest,
      originalSignal: message,
      timestamp: new Date().toISOString()
    });

    // Request order execution
    await messageBus.publish(CHANNELS.ORDER_REQUEST, orderRequest);

    logger.info(`Trade signal processed and order requested: ${positionSizing.symbol} ${signal.action} ${positionSizing.quantity}`);
  } catch (error) {
    logger.error('Failed to process webhook signal:', error);

    await messageBus.publish(CHANNELS.TRADE_REJECTED, {
      reason: error.message,
      originalSignal: message,
      timestamp: new Date().toISOString()
    });
  }
}

// Parse trade signal from webhook body
function parseTradeSignal(body) {
  try {
    // Handle different signal formats
    // Format 1: TradingView webhook
    if (body.ticker && body.action) {
      return {
        symbol: body.ticker,
        action: body.action.toUpperCase() === 'BUY' ? 'Buy' : 'Sell',
        orderType: body.order_type || 'Market',
        price: body.price,
        stopPrice: body.stop_price,
        quantity: body.contracts,
        accountId: body.account_id
      };
    }

    // Format 2: Test interface format with bracket order support
    if (body.symbol && (body.side || body.action === 'place_limit')) {
      return {
        symbol: body.symbol,
        action: body.action, // Preserve original action (e.g., 'place_limit')
        side: body.side, // Preserve side for bracket order mapping
        orderType: body.type || 'Market',
        price: body.price,
        stop_loss: body.stop_loss, // Preserve for bracket orders
        take_profit: body.take_profit, // Preserve for bracket orders
        stopPrice: body.stop_price,
        quantity: body.quantity,
        accountId: body.accountId || body.account,
        trailing_trigger: body.trailing_trigger,
        trailing_offset: body.trailing_offset
      };
    }

    // Format 3: Custom format (legacy)
    if (body.symbol && body.side && !body.action) {
      return {
        symbol: body.symbol,
        action: body.side === 'long' ? 'Buy' : 'Sell',
        orderType: body.type || 'Market',
        price: body.limit_price,
        stopPrice: body.stop_price,
        quantity: body.quantity,
        accountId: body.accountId
      };
    }

    // Format 3: Simple text parsing (legacy)
    if (typeof body === 'string' || body.message) {
      const text = body.message || body;
      // Parse text format like "BUY MNQU24 10 contracts at market"
      const match = text.match(/^(BUY|SELL)\s+(\S+)\s+(\d+)/i);
      if (match) {
        return {
          symbol: match[2],
          action: match[1] === 'BUY' ? 'Buy' : 'Sell',
          quantity: parseInt(match[3]),
          orderType: 'Market'
        };
      }
    }

    return null;
  } catch (error) {
    logger.error('Failed to parse trade signal:', error);
    return null;
  }
}

// Validate trade signal against business rules
async function validateTradeSignal(signal) {
  // Check required fields
  if (!signal.symbol || !signal.action) {
    return { valid: false, reason: 'Missing required fields' };
  }

  // Check position limits
  const existingPosition = tradingState.tradingPositions.get(signal.symbol);
  if (existingPosition) {
    // Check if we're already at max position size
    if (existingPosition.quantity >= getMaxPositionSize(signal.symbol)) {
      return { valid: false, reason: 'Maximum position size reached' };
    }

    // Check if this would reverse the position
    if (existingPosition.side !== signal.action && !isReversalAllowed()) {
      return { valid: false, reason: 'Position reversal not allowed' };
    }
  }

  // Check daily loss limit
  const dailyPnL = await getDailyPnL(signal.accountId);
  if (dailyPnL < getDailyLossLimit()) {
    return { valid: false, reason: 'Daily loss limit reached' };
  }

  // Check trading hours - DISABLED for futures (24/7 trading)
  // Futures markets trade nearly 24/7, so this check is not applicable
  // if (!isTradingHours(signal.symbol)) {
  //   return { valid: false, reason: 'Outside trading hours' };
  // }

  return { valid: true };
}

// Calculate position size and apply position sizing conversion
async function calculatePositionSize(signal) {
  // Get position sizing settings from monitoring service
  let positionSizingSettings;
  try {
    const response = await axios.get('http://localhost:3014/api/position-sizing/settings', {
      timeout: 5000
    });
    positionSizingSettings = response.data;
    logger.info('📊 Retrieved position sizing settings:', positionSizingSettings);
  } catch (error) {
    logger.error('Failed to get position sizing settings, using defaults:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      url: 'http://localhost:3014/api/position-sizing/settings'
    });
    positionSizingSettings = {
      method: 'fixed',
      fixedQuantity: 1,
      contractType: 'micro'
    };
  }

  // Get original quantity from signal or calculate it
  let originalQuantity = signal.quantity;
  if (!originalQuantity) {
    // Calculate based on risk parameters if no quantity specified
    const accountBalance = getAccountBalance(signal.accountId);
    const riskPerTrade = getRiskPerTrade(); // e.g., 0.02 (2%)
    const stopLoss = signal.stopPrice || getDefaultStopLoss(signal.symbol);

    if (!stopLoss) {
      originalQuantity = getDefaultPositionSize(signal.symbol);
    } else {
      const riskAmount = accountBalance * riskPerTrade;
      const pointValue = getPointValue(signal.symbol);
      const stopDistance = Math.abs(signal.price - stopLoss);
      originalQuantity = Math.floor(riskAmount / (stopDistance * pointValue));
    }
  }

  // Apply position sizing conversion
  try {
    const conversionResponse = await axios.post('http://localhost:3014/api/position-sizing/convert', {
      originalSymbol: signal.symbol,
      quantity: originalQuantity,
      action: signal.action
    }, {
      timeout: 5000
    });

    const conversionResult = conversionResponse.data;
    logger.info('📊 Position sizing conversion result:', conversionResult);

    // Return both symbol and quantity for modification in the order request
    return {
      symbol: conversionResult.symbol,
      quantity: conversionResult.quantity,
      originalSymbol: signal.symbol,
      originalQuantity: originalQuantity,
      converted: conversionResult.converted,
      reason: conversionResult.reason
    };

  } catch (error) {
    logger.error('Position sizing conversion failed, using original values:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      url: 'http://localhost:3014/api/position-sizing/convert'
    });
    return {
      symbol: signal.symbol,
      quantity: Math.min(originalQuantity, getMaxPositionSize(signal.symbol)),
      originalSymbol: signal.symbol,
      originalQuantity: originalQuantity,
      converted: false,
      reason: 'Conversion service unavailable'
    };
  }
}

// Helper functions (these would typically fetch from config or state)
function getDefaultAccountId() {
  // Use configured account ID from environment/config
  const configuredAccountId = config.tradovate.defaultAccountId;
  if (configuredAccountId) {
    return parseInt(configuredAccountId); // Ensure it's a number
  }

  // Fallback to first account in tradingState if available
  const firstAccount = tradingState.accountSettings.keys().next().value;
  if (firstAccount) {
    return parseInt(firstAccount);
  }

  // Last resort fallback
  logger.warn('No configured account ID found, using default demo account');
  return 33316485; // Use the actual demo account ID as numeric
}

function getMaxPositionSize(symbol) {
  // Symbol-specific limits
  if (symbol.includes('MNQ')) return 10;
  if (symbol.includes('MES')) return 20;
  return 5;
}

function isReversalAllowed() {
  return false; // Conservative default
}

function getDailyLossLimit() {
  return -2000; // $2000 daily loss limit
}

function getDailyPnL(accountId) {
  // This would fetch from state or database
  return 0;
}

function isTradingHours(symbol) {
  const now = new Date();
  const hour = now.getHours();

  // Simple check - would be more sophisticated in production
  if (symbol.includes('MNQ') || symbol.includes('MES')) {
    // E-mini futures trade almost 24 hours
    return hour >= 6 || hour < 5;
  }

  return hour >= 9 && hour < 16; // Regular market hours
}

function getAccountBalance(accountId) {
  // This would fetch from state
  return 100000; // Default $100k
}

function getRiskPerTrade() {
  return 0.02; // 2% risk per trade
}

function getDefaultStopLoss(symbol) {
  // This would be calculated based on ATR or fixed points
  return null;
}

function getDefaultPositionSize(symbol) {
  if (symbol.includes('MNQ')) return 2;
  if (symbol.includes('MES')) return 5;
  return 1;
}

function getPointValue(symbol) {
  // Map contract symbols to their point values
  if (symbol.includes('MNQ')) return 2;   // Micro E-mini NASDAQ-100: $2 per point
  if (symbol.includes('NQ')) return 20;   // E-mini NASDAQ-100: $20 per point
  if (symbol.includes('MES')) return 5;   // Micro E-mini S&P 500: $5 per point
  if (symbol.includes('ES')) return 50;   // E-mini S&P 500: $50 per point
  if (symbol.includes('M2K')) return 5;   // Micro E-mini Russell 2000: $5 per point
  if (symbol.includes('RTY')) return 50;  // E-mini Russell 2000: $50 per point
  return 1; // Default fallback
}

// Get base symbol for price lookup (e.g., MNQZ5 -> MNQ)
function getBaseSymbol(contractSymbol) {
  // Remove month/year suffixes to get base symbol
  if (contractSymbol.includes('MNQ')) return 'MNQ';
  if (contractSymbol.includes('NQ')) return 'NQ';
  if (contractSymbol.includes('MES')) return 'MES';
  if (contractSymbol.includes('ES')) return 'ES';
  if (contractSymbol.includes('M2K')) return 'M2K';
  if (contractSymbol.includes('RTY')) return 'RTY';
  return contractSymbol; // Return original if no match
}

// Calculate unrealized P&L for a position
function calculateUnrealizedPnL(position, currentPrice) {
  logger.info(`🧮 Calculating P&L: symbol=${position.symbol}, currentPrice=${currentPrice}, netPrice=${position.netPrice}, netPos=${position.netPos}`);

  if (!currentPrice || !position.netPrice || position.netPos === 0) {
    logger.info(`🧮 P&L calculation failed: currentPrice=${currentPrice}, netPrice=${position.netPrice}, netPos=${position.netPos}`);
    return 0;
  }

  const pointValue = getPointValue(position.symbol);
  const quantity = Math.abs(position.netPos);
  const priceDiff = position.netPos > 0
    ? (currentPrice - position.netPrice)  // Long position
    : (position.netPrice - currentPrice); // Short position

  const result = priceDiff * quantity * pointValue;

  logger.info(`🧮 P&L calculation: ${position.netPos} ${position.symbol} @ ${position.netPrice} → ${currentPrice} | diff=${priceDiff} × qty=${quantity} × pv=${pointValue} = $${result.toFixed(2)}`);

  return result;
}

// ===== COMPREHENSIVE POSITION AND ORDER MANAGEMENT =====

// Handle new order placement
async function handleOrderPlaced(message) {
  logger.info(`📋 Order placed: ${message.orderId} - ${message.action} ${message.symbol} ${message.orderType}`);

  // Create working order record
  const order = {
    id: message.orderId,
    accountId: message.accountId,
    symbol: message.symbol,
    action: message.action,
    quantity: message.quantity,
    orderType: message.orderType,
    price: message.price,
    stopPrice: message.stopPrice,
    status: 'Working',
    contractName: message.contractName,
    tickSize: message.tickSize,
    parentOrderId: message.parentOrderId,
    orderRole: message.orderRole, // 'entry', 'stop_loss', 'take_profit'
    timestamp: message.timestamp,
    source: message.source
  };

  // Store the working order
  tradingState.workingOrders.set(message.orderId, order);

  // Track order relationships for bracket orders
  if (message.parentOrderId || message.orderRole) {
    tradingState.orderRelationships.set(message.orderId, {
      positionSymbol: message.symbol,
      orderRole: message.orderRole || 'entry',
      parentOrderId: message.parentOrderId
    });
  }

  // Update statistics
  tradingState.stats.totalWorkingOrders = tradingState.workingOrders.size;

  logger.info(`💼 Working orders: ${tradingState.stats.totalWorkingOrders}, Positions: ${tradingState.tradingPositions.size}`);
}

// Handle order fills - this creates or updates positions
async function handleOrderFilled(message) {
  logger.info(`✅ Order filled: ${message.orderId} - ${message.action} ${message.quantity} ${message.symbol} @ ${message.fillPrice}`);

  // Remove from working orders
  tradingState.workingOrders.delete(message.orderId);

  // Get order relationship to understand what type of order this was
  const relationship = tradingState.orderRelationships.get(message.orderId);
  const orderRole = relationship?.orderRole || 'entry';

  if (orderRole === 'entry') {
    // This is a main entry order - create or update position
    await updatePositionFromFill(message);
  } else if (orderRole === 'stop_loss' || orderRole === 'take_profit') {
    // This is a bracket order fill - update position and remove other bracket orders
    await handleBracketOrderFill(message, orderRole);
  }

  // Clean up order relationship
  tradingState.orderRelationships.delete(message.orderId);

  // Update statistics
  tradingState.stats.totalWorkingOrders = tradingState.workingOrders.size;
  tradingState.stats.dailyTrades += 1;

  logger.info(`📊 Updated stats - Orders: ${tradingState.stats.totalWorkingOrders}, Positions: ${tradingState.tradingPositions.size}, Daily trades: ${tradingState.stats.dailyTrades}`);
}

// Handle order rejections or cancellations
async function handleOrderRejected(message) {
  logger.warn(`❌ Order rejected/cancelled: ${message.orderId} - ${message.error || 'Cancelled'}`);

  // Remove from working orders
  tradingState.workingOrders.delete(message.orderId);

  // Clean up order relationship
  tradingState.orderRelationships.delete(message.orderId);

  // Update statistics
  tradingState.stats.totalWorkingOrders = tradingState.workingOrders.size;
}

// Handle position updates from Tradovate (for real-time P&L)
async function handlePositionUpdate(message) {
  if (message.positions && Array.isArray(message.positions)) {
    // Bulk position update
    for (const posData of message.positions) {
      if (posData.netPos !== 0) {
        await updateTradingPositionFromMarketData(posData, message.accountId);
      } else {
        // Position closed
        tradingState.tradingPositions.delete(posData.symbol);
      }
    }
  } else if (message.symbol) {
    // Single position update
    if (message.netPos !== 0) {
      await updateTradingPositionFromMarketData(message, message.accountId);
    } else {
      tradingState.tradingPositions.delete(message.symbol);
    }
  }

  // Update position count
  tradingState.stats.totalPositions = tradingState.tradingPositions.size;
}

// Handle explicit position closure
async function handlePositionClosed(message) {
  logger.info(`🔒 Position closed: ${message.symbol}`);

  // Remove the trading position
  tradingState.tradingPositions.delete(message.symbol);

  // Remove any working orders associated with this position
  const ordersToRemove = [];
  for (const [orderId, relationship] of tradingState.orderRelationships.entries()) {
    if (relationship.positionSymbol === message.symbol) {
      ordersToRemove.push(orderId);
    }
  }

  for (const orderId of ordersToRemove) {
    tradingState.workingOrders.delete(orderId);
    tradingState.orderRelationships.delete(orderId);
    logger.info(`🗑️ Removed associated order: ${orderId}`);
  }

  // Update statistics
  tradingState.stats.totalPositions = tradingState.tradingPositions.size;
  tradingState.stats.totalWorkingOrders = tradingState.workingOrders.size;
}

// ===== HELPER FUNCTIONS FOR POSITION MANAGEMENT =====

// Create or update position when an entry order fills
async function updatePositionFromFill(fillMessage) {
  const symbol = fillMessage.symbol;
  const existing = tradingState.tradingPositions.get(symbol);

  if (existing) {
    // Update existing position
    const newQuantity = existing.netPosition + (fillMessage.action === 'Buy' ? fillMessage.quantity : -fillMessage.quantity);

    if (newQuantity === 0) {
      // Position closed
      tradingState.tradingPositions.delete(symbol);
      logger.info(`📊 Position closed via fill: ${symbol}`);
    } else {
      // Update position
      const newSide = newQuantity > 0 ? 'long' : 'short';
      // Calculate new average entry price
      const totalValue = (existing.netPosition * existing.entryPrice) + (fillMessage.quantity * fillMessage.fillPrice);
      const newEntryPrice = Math.abs(totalValue / newQuantity);

      // Update both frontend-expected and internal fields
      existing.netPos = newQuantity;
      existing.netPrice = newEntryPrice;
      existing.netPosition = newQuantity;
      existing.side = newSide;
      existing.entryPrice = newEntryPrice;
      existing.lastUpdate = fillMessage.timestamp;

      logger.info(`📊 Updated position: ${symbol} = ${newQuantity} @ ${newEntryPrice.toFixed(2)}`);
    }
  } else {
    // Create new position
    const quantity = fillMessage.action === 'Buy' ? fillMessage.quantity : -fillMessage.quantity;
    const side = quantity > 0 ? 'long' : 'short';

    const newPosition = {
      symbol: symbol,
      accountId: fillMessage.accountId,

      // Frontend expects these field names
      netPos: quantity,
      netPrice: fillMessage.fillPrice,
      unrealizedPnL: 0,

      // Trade-orchestrator additional fields
      netPosition: quantity,
      side: side,
      entryPrice: fillMessage.fillPrice,
      currentPrice: fillMessage.fillPrice,

      // Associated orders (will be populated as bracket orders are identified)
      stopLossOrder: null,
      takeProfitOrder: null,
      pendingEntryOrders: [],

      // Metadata
      createdAt: fillMessage.timestamp,
      lastUpdate: fillMessage.timestamp,
      strategy: 'unknown',
      riskParams: {}
    };

    tradingState.tradingPositions.set(symbol, newPosition);
    logger.info(`🆕 New position created: ${symbol} = ${quantity} @ ${fillMessage.fillPrice}`);
  }

  // Update statistics
  tradingState.stats.totalPositions = tradingState.tradingPositions.size;
}

// Handle when a bracket order (stop/target) fills
async function handleBracketOrderFill(fillMessage, orderRole) {
  const symbol = fillMessage.symbol;
  const position = tradingState.tradingPositions.get(symbol);

  if (position) {
    logger.info(`🎯 Bracket ${orderRole} filled for ${symbol} - closing/reducing position`);

    // The bracket order fill should reduce or close the position
    const quantity = fillMessage.action === 'Buy' ? fillMessage.quantity : -fillMessage.quantity;
    const newNetPosition = position.netPosition - quantity; // Opposite of position direction

    if (Math.abs(newNetPosition) < 0.01) {
      // Position fully closed
      tradingState.tradingPositions.delete(symbol);
      logger.info(`🔒 Position fully closed via ${orderRole}: ${symbol}`);

      // Remove other bracket orders for this position
      await cancelOtherBracketOrders(symbol, fillMessage.orderId);
    } else {
      // Position partially closed
      // Update both frontend-expected and internal fields
      position.netPos = newNetPosition;
      position.netPrice = position.netPrice; // Keep existing entry price
      position.netPosition = newNetPosition;
      position.side = newNetPosition > 0 ? 'long' : 'short';
      position.lastUpdate = fillMessage.timestamp;
      logger.info(`📉 Position reduced via ${orderRole}: ${symbol} = ${newNetPosition}`);
    }
  }
}

// Cancel other bracket orders when one fills
async function cancelOtherBracketOrders(symbol, filledOrderId) {
  const ordersToCancel = [];

  for (const [orderId, relationship] of tradingState.orderRelationships.entries()) {
    if (relationship.positionSymbol === symbol && orderId !== filledOrderId) {
      const orderRole = relationship.orderRole;
      if (orderRole === 'stop_loss' || orderRole === 'take_profit') {
        ordersToCancel.push(orderId);
      }
    }
  }

  for (const orderId of ordersToCancel) {
    tradingState.workingOrders.delete(orderId);
    tradingState.orderRelationships.delete(orderId);
    logger.info(`🚫 Auto-cancelled bracket order: ${orderId}`);
  }
}

// Update position with real-time market data
async function updateTradingPositionFromMarketData(posData, accountId) {
  // Handle positions that only have contractId - need to resolve symbol
  let symbol = posData.symbol;
  if (!symbol && posData.contractId) {
    // Try to resolve symbol from contractId using tradovate-service
    symbol = await resolveSymbolFromContractId(posData.contractId);
    if (!symbol) {
      symbol = `CONTRACT_${posData.contractId}`;
      logger.warn(`Could not resolve symbol for contractId ${posData.contractId}, using: ${symbol}`);
    }
  }

  if (!symbol) {
    logger.warn('Position update missing both symbol and contractId, skipping:', posData);
    return;
  }

  const position = tradingState.tradingPositions.get(symbol);

  if (position) {
    // Update existing position with market data
    position.currentPrice = posData.currentPrice || position.currentPrice;
    // Don't overwrite real-time calculated P&L with monitoring service data
    // position.unrealizedPnL is managed by real-time price updates
    position.lastUpdate = new Date().toISOString();

    // Update associated orders in the position
    await linkAssociatedOrders(position);
  } else if (posData.netPos !== 0) {
    // Create position from market data (startup sync scenario)
    const newPosition = {
      symbol: symbol,
      contractId: posData.contractId,
      accountId: accountId,

      // Frontend expects these field names
      netPos: posData.netPos,
      netPrice: posData.netPrice || posData.averagePrice || posData.entryPrice || 0,
      unrealizedPnL: posData.pnl || posData.unrealizedPnL || 0,

      // Trade-orchestrator additional fields
      netPosition: posData.netPos,
      side: posData.netPos > 0 ? 'long' : 'short',
      entryPrice: posData.netPrice || posData.averagePrice || posData.entryPrice || 0,
      currentPrice: posData.currentPrice || posData.netPrice || posData.entryPrice || 0,

      stopLossOrder: null,
      takeProfitOrder: null,
      pendingEntryOrders: [],

      createdAt: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      strategy: 'external', // Position created outside our system
      riskParams: {}
    };

    tradingState.tradingPositions.set(symbol, newPosition);
    await linkAssociatedOrders(newPosition);

    logger.info(`📊 Position synced from market data: ${symbol} = ${posData.netPos} @ ${newPosition.entryPrice}`);
  }
}

// Link working orders to their associated positions
async function linkAssociatedOrders(position) {
  position.stopLossOrder = null;
  position.takeProfitOrder = null;
  position.pendingEntryOrders = [];

  for (const [orderId, order] of tradingState.workingOrders.entries()) {
    if (order.symbol === position.symbol) {
      const relationship = tradingState.orderRelationships.get(orderId);
      const orderRole = relationship?.orderRole || 'entry';

      if (orderRole === 'stop_loss') {
        position.stopLossOrder = {
          orderId: orderId,
          price: order.stopPrice || order.price,
          status: order.status
        };
      } else if (orderRole === 'take_profit') {
        position.takeProfitOrder = {
          orderId: orderId,
          price: order.price,
          status: order.status
        };
      } else if (orderRole === 'entry') {
        position.pendingEntryOrders.push({
          orderId: orderId,
          action: order.action,
          quantity: order.quantity,
          price: order.price,
          status: order.status
        });
      }
    }
  }
}

// ===== MARKET DATA AND P&L MANAGEMENT =====

// Handle real-time price updates from message bus
async function handlePriceUpdate(message) {
  try {
    const symbol = message.symbol;
    const baseSymbol = message.baseSymbol || getBaseSymbol(symbol);
    const currentPrice = message.close || message.price;

    logger.info(`📈 Price update received: ${symbol} (base: ${baseSymbol}) = ${currentPrice}`);

    if (!currentPrice) {
      logger.warn(`📈 No price in update for ${symbol}`);
      return;
    }

    // Only process if we have positions for this symbol
    let hasPositions = false;
    logger.info(`📊 Checking positions for base symbol: ${baseSymbol}`);

    for (const position of tradingState.tradingPositions.values()) {
      const positionBaseSymbol = getBaseSymbol(position.symbol);
      logger.info(`📊 Position ${position.symbol} -> base: ${positionBaseSymbol} (looking for: ${baseSymbol})`);
      logger.info(`🔍 String comparison: "${positionBaseSymbol}" === "${baseSymbol}" = ${positionBaseSymbol === baseSymbol}`);
      logger.info(`🔍 Types: ${typeof positionBaseSymbol} vs ${typeof baseSymbol}`);
      logger.info(`🔍 Lengths: ${positionBaseSymbol.length} vs ${baseSymbol.length}`);

      if (positionBaseSymbol === baseSymbol) {
        hasPositions = true;
        logger.info(`🎯 MATCH! Processing P&L for ${position.symbol}: ${positionBaseSymbol} === ${baseSymbol}`);

        // Calculate new P&L with updated price
        const unrealizedPnL = calculateUnrealizedPnL(position, currentPrice);

        // Update position with current price and calculated P&L
        position.currentPrice = currentPrice;
        position.unrealizedPnL = unrealizedPnL;
        position.lastUpdate = new Date().toISOString();

        logger.info(`💰 Updated P&L for ${position.symbol}: ${position.netPos} @ ${position.netPrice} → current ${currentPrice} = $${unrealizedPnL.toFixed(2)}`);
        logger.info(`✅ Position object after update: unrealizedPnL=${position.unrealizedPnL}, currentPrice=${position.currentPrice}`);
      }
    }

    // Only log and update stats if we actually used this price update
    if (hasPositions) {
      logger.debug(`📈 Price update used: ${baseSymbol} = ${currentPrice}`);

      // Update daily P&L stats
      tradingState.stats.dailyPnL = Array.from(tradingState.tradingPositions.values())
        .reduce((total, pos) => total + (pos.unrealizedPnL || 0), 0);
    }

  } catch (error) {
    logger.error('Failed to handle price update:', error.message);
  }
}

// Initialize P&L system with initial price data
async function initializePnLSystem() {
  logger.info('💰 Initializing real-time P&L system...');

  if (tradingState.tradingPositions.size === 0) {
    logger.info('💰 No positions to track - P&L system ready for future positions');
    return;
  }

  // Get initial prices for all position symbols
  try {
    const response = await fetch('http://localhost:3014/api/quotes');
    if (response.ok) {
      const quotes = await response.json();

      for (const position of tradingState.tradingPositions.values()) {
        const baseSymbol = getBaseSymbol(position.symbol);
        const quote = quotes[baseSymbol];

        if (quote && quote.close) {
          const currentPrice = quote.close;
          const unrealizedPnL = calculateUnrealizedPnL(position, currentPrice);

          position.currentPrice = currentPrice;
          position.unrealizedPnL = unrealizedPnL;
          position.lastUpdate = new Date().toISOString();

          logger.info(`💰 Initial P&L for ${position.symbol}: $${unrealizedPnL.toFixed(2)}`);
        }
      }

      // Update daily P&L stats
      tradingState.stats.dailyPnL = Array.from(tradingState.tradingPositions.values())
        .reduce((total, pos) => total + (pos.unrealizedPnL || 0), 0);

      logger.info(`💰 P&L system initialized for ${tradingState.tradingPositions.size} positions`);
    }
  } catch (error) {
    logger.warn('Failed to get initial prices:', error.message);
  }
}

// ===== CONTRACT/SYMBOL RESOLUTION =====

// Resolve symbol from contractId by calling tradovate-service
async function resolveSymbolFromContractId(contractId) {
  try {
    // Call tradovate-service to get contract details
    const response = await fetch(`http://localhost:3011/contract/${contractId}`);
    if (response.ok) {
      const contract = await response.json();
      if (contract && contract.name) {
        logger.info(`✅ Resolved contractId ${contractId} to symbol: ${contract.name}`);
        return contract.name;
      }
    }
  } catch (error) {
    logger.warn(`Failed to resolve contractId ${contractId}:`, error.message);
  }
  return null;
}

// ===== STARTUP SYNC FUNCTIONALITY =====

// Perform initial sync by requesting current state from monitoring service
async function performInitialSync() {
  try {
    // The monitoring service has the most recent state from tradovate-service
    const monitoringBaseUrl = 'http://localhost:3014'; // monitoring-service port

    logger.info('📡 Fetching current trading state from monitoring service...');

    // Clear existing state before sync to avoid stale data
    logger.info('🧹 Clearing existing state before sync...');
    tradingState.workingOrders.clear();
    tradingState.tradingPositions.clear();
    tradingState.orderRelationships.clear();

    // Get current dashboard data which includes positions and orders
    const response = await fetch(`${monitoringBaseUrl}/api/dashboard`);
    if (!response.ok) {
      throw new Error(`Failed to fetch dashboard: ${response.status}`);
    }

    const dashboardData = await response.json();

    // Process positions
    if (dashboardData.positions && Array.isArray(dashboardData.positions)) {
      logger.info(`📊 Syncing ${dashboardData.positions.length} positions...`);

      for (const posData of dashboardData.positions) {
        if (posData.netPos !== 0) {
          await updateTradingPositionFromMarketData(posData, posData.accountId);
        }
      }
    }

    // Process working orders - but filter out filled/cancelled orders
    if (dashboardData.orders && Array.isArray(dashboardData.orders)) {
      // Filter to only truly working orders
      const workingOrders = dashboardData.orders.filter(order =>
        (order.status === 'working' || order.orderStatus === 'Working') &&
        order.orderStatus !== 'Filled' &&
        order.orderStatus !== 'Cancelled' &&
        order.orderStatus !== 'Rejected'
      );

      logger.info(`📋 Syncing ${workingOrders.length} working orders (filtered from ${dashboardData.orders.length} total)...`);

      for (const orderData of workingOrders) {
        const orderMessage = {
          orderId: orderData.id || orderData.orderId,
          accountId: orderData.accountId,
          symbol: orderData.symbol,
          action: orderData.action,
          quantity: orderData.quantity,
          orderType: orderData.orderType,
          price: orderData.price,
          stopPrice: orderData.stopPrice,
          contractName: orderData.contractName,
          tickSize: orderData.tickSize,
          parentOrderId: orderData.parentOrderId,
          orderRole: orderData.orderRole,
          timestamp: orderData.timestamp,
          source: 'startup_sync'
        };

        await handleOrderPlaced(orderMessage);
      }
    }

    // Link orders to positions now that we have both
    for (const position of tradingState.tradingPositions.values()) {
      await linkAssociatedOrders(position);
    }

    logger.info(`✅ Initial sync complete: ${tradingState.tradingPositions.size} positions, ${tradingState.workingOrders.size} working orders`);

  } catch (error) {
    logger.error('❌ Failed to perform initial sync:', error.message);
    // Continue startup even if sync fails - we'll get updates from live events
  }
}

// Startup sequence
async function startup() {
  try {
    logger.info(`Starting ${SERVICE_NAME}...`);

    // Connect to message bus
    logger.info('Connecting to message bus...');
    await messageBus.connect();
    logger.info('Message bus connected');

    // Subscribe to relevant channels
    await messageBus.subscribe(CHANNELS.WEBHOOK_RECEIVED, handleWebhookReceived);
    await messageBus.subscribe(CHANNELS.ORDER_PLACED, handleOrderPlaced);
    await messageBus.subscribe(CHANNELS.ORDER_FILLED, handleOrderFilled);
    await messageBus.subscribe(CHANNELS.ORDER_REJECTED, handleOrderRejected);
    await messageBus.subscribe(CHANNELS.POSITION_UPDATE, handlePositionUpdate);
    await messageBus.subscribe(CHANNELS.POSITION_CLOSED, handlePositionClosed);
    await messageBus.subscribe(CHANNELS.PRICE_UPDATE, handlePriceUpdate);
    logger.info('Subscribed to message bus channels');

    // Request initial sync of existing positions and orders from other services
    logger.info('🔄 Requesting initial sync of trading data...');
    await performInitialSync();

    // Initialize P&L calculation system with message bus
    logger.info('💰 Initializing real-time P&L system...');
    await initializePnLSystem();

    // Publish startup event
    await messageBus.publish(CHANNELS.SERVICE_STARTED, {
      service: SERVICE_NAME,
      port: config.service.port,
      tradingEnabled: tradingState.tradingEnabled,
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

      // Disable trading
      tradingState.tradingEnabled = false;

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