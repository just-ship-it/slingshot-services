import express from 'express';
import axios from 'axios';
// File system imports removed - using Redis for persistence
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';

const SERVICE_NAME = 'trade-orchestrator';
const logger = createLogger(SERVICE_NAME);

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3013 });

// Redis configuration keys
const CONTRACT_MAPPINGS_KEY = 'contracts:mappings';
const SIGNAL_CONTEXT_KEY = 'signal:context';
const ORDER_STRATEGY_MAPPING_KEY = 'orders:strategy-mapping';
const SIGNAL_MAPPINGS_KEY = 'signal:mappings';
const SIGNAL_LIFECYCLES_KEY = 'signal:lifecycles';

// Signal context persistence functions
async function saveSignalContext() {
  try {
    // Convert Map to object for JSON serialization
    const signalContextData = {};
    for (const [key, value] of tradingState.signalContext) {
      signalContextData[key] = value;
    }

    const dataToSave = {
      timestamp: new Date().toISOString(),
      signalContext: signalContextData,
      version: '1.0'
    };

    await messageBus.publisher.set('signal:context', JSON.stringify(dataToSave));
    logger.info('💾 Signal context saved to Redis');
  } catch (error) {
    logger.error('❌ Failed to save signal context to Redis:', error);
  }
}

async function loadSignalContext() {
  try {
    const data = await messageBus.publisher.get('signal:context');
    if (data) {
      const parsedData = JSON.parse(data);

      // Restore signal context from Redis
      if (parsedData.signalContext) {
        let loadedCount = 0;
        for (const [key, value] of Object.entries(parsedData.signalContext)) {
          tradingState.signalContext.set(key, value);
          loadedCount++;
        }
        logger.info(`🔄 Loaded ${loadedCount} signal contexts from Redis (saved: ${parsedData.timestamp})`);
      }
    } else {
      logger.info('📂 No existing signal context found in Redis, starting fresh');
    }
  } catch (error) {
    logger.error('❌ Failed to load signal context from Redis:', error);
  }
}

// Order strategy mapping persistence functions
async function saveOrderStrategyMapping() {
  try {
    // Convert Map to object for JSON serialization
    const orderStrategyMappingData = {};
    for (const [orderId, strategyId] of tradingState.orderToStrategy) {
      orderStrategyMappingData[orderId] = strategyId;
    }

    const dataToSave = {
      timestamp: new Date().toISOString(),
      orderToStrategy: orderStrategyMappingData,
      version: '1.0'
    };

    await messageBus.publisher.set('orders:strategy-mapping', JSON.stringify(dataToSave));
    logger.info('💾 Order strategy mapping saved to Redis');
  } catch (error) {
    logger.error('❌ Failed to save order strategy mapping to Redis:', error);
  }
}

async function loadOrderStrategyMapping() {
  try {
    const data = await messageBus.publisher.get('orders:strategy-mapping');
    if (data) {
      const parsedData = JSON.parse(data);

      // Restore order strategy mapping from Redis
      let loadedCount = 0;
      if (parsedData.orderToStrategy) {
        for (const [orderId, strategyId] of Object.entries(parsedData.orderToStrategy)) {
          tradingState.orderToStrategy.set(orderId, strategyId);
          loadedCount++;
        }

        logger.info(`🔄 Loaded ${loadedCount} order-strategy mappings from Redis (saved: ${parsedData.timestamp})`);
      }
    } else {
      logger.info('📂 No existing order strategy mapping found in Redis, starting fresh');
    }
  } catch (error) {
    logger.error('❌ Failed to load order strategy mapping from Redis:', error);
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
    notes: 'Default contract mappings - stored in Redis for rollover updates'
  };

  // Save defaults to Redis
  try {
    await messageBus.publisher.set('contracts:mappings', JSON.stringify(defaults));
    logger.info('✅ Default contract mappings saved to Redis');
  } catch (error) {
    logger.error('❌ Failed to save default contract mappings to Redis:', error);
  }

  logger.warn('Using default contract mappings:', defaults);
  return defaults;
}

function loadPositionSizingSettings() {
  // Return defaults that will be updated from monitoring service
  const defaults = {
    method: 'fixed',
    fixedQuantity: 1,
    riskPercentage: 10,
    maxContracts: 10,
    contractType: 'micro'
  };
  logger.info('Using default position sizing settings (will sync with monitoring service):', defaults);
  return defaults;
}

async function syncPositionSizingSettings() {
  try {
    // Get latest settings from monitoring service (no auth needed for internal calls)
    const monitoringUrl = process.env.MONITORING_SERVICE_URL || 'http://localhost:3014';
    const response = await axios.get(`${monitoringUrl}/api/position-sizing/settings`, {
      headers: {
        'Authorization': `Bearer ${process.env.DASHBOARD_SECRET}`
      },
      timeout: 5000
    });

    // Update the trading state with latest settings
    tradingState.positionSizing = response.data;
    logger.info('📊 Synced position sizing settings from monitoring service:', response.data);
    return response.data;
  } catch (error) {
    logger.warn('Failed to sync position sizing settings, using cached:', {
      message: error.message,
      status: error.response?.status
    });
    return tradingState.positionSizing;
  }
}

// SignalRegistry - Centralized signal tracking and lifecycle management
class SignalRegistry {
  constructor() {
    // Fast bidirectional lookups for real-time operations
    this.signalToOrders = new Map(); // signalId -> Set<orderId>
    this.orderToSignal = new Map();  // orderId -> signalId
    this.signalToPosition = new Map(); // signalId -> positionSymbol
    this.signalLifecycles = new Map(); // signalId -> Array<events>
  }

  // Register a new signal when webhook is received
  registerSignal(signalId, signalData) {
    this.signalToOrders.set(signalId, new Set());
    this.signalLifecycles.set(signalId, [{
      timestamp: new Date().toISOString(),
      event: 'signal_received',
      data: signalData
    }]);

    logger.info(`📡 Signal registered: ${signalId}`);
  }

  // Link an order to a signal
  linkOrderToSignal(orderId, signalId, orderRole = 'unknown') {
    // Add order to signal's order set
    if (!this.signalToOrders.has(signalId)) {
      this.signalToOrders.set(signalId, new Set());
    }
    this.signalToOrders.get(signalId).add(orderId);

    // Create reverse mapping
    this.orderToSignal.set(orderId, signalId);

    // Log lifecycle event
    this.addLifecycleEvent(signalId, 'order_linked', {
      orderId,
      orderRole,
      timestamp: new Date().toISOString()
    });

    logger.info(`🔗 Order ${orderId} linked to signal ${signalId} (role: ${orderRole})`);
  }

  // Link a position to a signal when order fills
  linkPositionToSignal(signalId, positionSymbol, entryOrderId) {
    this.signalToPosition.set(signalId, positionSymbol);

    this.addLifecycleEvent(signalId, 'position_created', {
      positionSymbol,
      entryOrderId,
      timestamp: new Date().toISOString()
    });

    logger.info(`📈 Position ${positionSymbol} linked to signal ${signalId}`);
  }

  // Find signal ID for a given order
  findSignalForOrder(orderId) {
    return this.orderToSignal.get(orderId);
  }

  // Get all orders for a signal
  getOrdersForSignal(signalId) {
    return this.signalToOrders.get(signalId) || new Set();
  }

  // Get position for a signal
  getPositionForSignal(signalId) {
    return this.signalToPosition.get(signalId);
  }

  // Add lifecycle event
  addLifecycleEvent(signalId, event, data) {
    if (!this.signalLifecycles.has(signalId)) {
      this.signalLifecycles.set(signalId, []);
    }

    this.signalLifecycles.get(signalId).push({
      timestamp: new Date().toISOString(),
      event,
      data
    });
  }

  // Get complete signal lifecycle
  getSignalLifecycle(signalId) {
    return this.signalLifecycles.get(signalId) || [];
  }

  // Clean up completed signal
  cleanupSignal(signalId) {
    const orders = this.signalToOrders.get(signalId);
    if (orders) {
      for (const orderId of orders) {
        this.orderToSignal.delete(orderId);
      }
    }

    this.addLifecycleEvent(signalId, 'signal_completed', {
      timestamp: new Date().toISOString()
    });

    // Keep lifecycle but remove active mappings
    this.signalToOrders.delete(signalId);
    this.signalToPosition.delete(signalId);

    logger.info(`🏁 Signal ${signalId} completed and cleaned up`);
  }

  // Persistence methods
  async saveMappings() {
    try {
      const mappingsData = {
        timestamp: new Date().toISOString(),
        signalToOrders: Object.fromEntries(
          Array.from(this.signalToOrders.entries()).map(([k, v]) => [k, Array.from(v)])
        ),
        orderToSignal: Object.fromEntries(this.orderToSignal),
        signalToPosition: Object.fromEntries(this.signalToPosition),
        version: '1.0'
      };

      await messageBus.publisher.set('signal:mappings', JSON.stringify(mappingsData));
      logger.info('💾 Signal mappings saved to Redis');
    } catch (error) {
      logger.error('❌ Failed to save signal mappings to Redis:', error);
    }
  }

  async saveLifecycles() {
    try {
      const lifecycleData = {
        timestamp: new Date().toISOString(),
        signalLifecycles: Object.fromEntries(this.signalLifecycles),
        version: '1.0'
      };

      // Set with 7-day TTL (604800 seconds) to prevent indefinite growth
      await messageBus.publisher.set('signal:lifecycles', JSON.stringify(lifecycleData), { EX: 604800 });
      logger.info('💾 Signal lifecycles saved to Redis (7-day TTL)');
    } catch (error) {
      logger.error('❌ Failed to save signal lifecycles to Redis:', error);
    }
  }

  async loadMappings() {
    try {
      const data = await messageBus.publisher.get('signal:mappings');
      if (data) {
        const parsed = JSON.parse(data);

        if (parsed.signalToOrders) {
          for (const [signalId, orderIds] of Object.entries(parsed.signalToOrders)) {
            this.signalToOrders.set(signalId, new Set(orderIds));
          }
        }

        if (parsed.orderToSignal) {
          for (const [orderId, signalId] of Object.entries(parsed.orderToSignal)) {
            this.orderToSignal.set(orderId, signalId);
          }
        }

        if (parsed.signalToPosition) {
          for (const [signalId, positionSymbol] of Object.entries(parsed.signalToPosition)) {
            this.signalToPosition.set(signalId, positionSymbol);
          }
        }

        logger.info(`📁 Signal mappings loaded from Redis: ${this.signalToOrders.size} signals, ${this.orderToSignal.size} orders`);
      } else {
        logger.info('📂 No existing signal mappings found in Redis, starting fresh');
      }
    } catch (error) {
      logger.error('❌ Failed to load signal mappings from Redis:', error);
    }
  }

  async loadLifecycles() {
    try {
      const data = await messageBus.publisher.get('signal:lifecycles');
      if (data) {
        const parsed = JSON.parse(data);

        if (parsed.signalLifecycles) {
          for (const [signalId, lifecycle] of Object.entries(parsed.signalLifecycles)) {
            this.signalLifecycles.set(signalId, lifecycle);
          }
        }

        logger.info(`📁 Signal lifecycles loaded from Redis: ${this.signalLifecycles.size} signal histories`);
      } else {
        logger.info('📂 No existing signal lifecycles found in Redis, starting fresh');
      }
    } catch (error) {
      logger.error('❌ Failed to load signal lifecycles from Redis:', error);
    }
  }

  // Debug/monitoring methods
  getStats() {
    return {
      totalSignals: this.signalToOrders.size,
      totalOrderMappings: this.orderToSignal.size,
      totalPositionMappings: this.signalToPosition.size,
      totalLifecycles: this.signalLifecycles.size
    };
  }
}

// Initialize signal registry
const signalRegistry = new SignalRegistry();

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

  // Trade Signal Context: Store original signal details for pending orders
  // Key: signalId, Value: Original trade signal with context
  signalContext: new Map(),

  // Order Strategy Mapping: Map individual order IDs to their strategy IDs
  // Key: individual orderId, Value: strategyId
  orderToStrategy: new Map(),

  // Position reconciliation tracking
  lastPositionReconciliation: 0,

  // Current Market Prices: Latest prices for active symbols
  // Key: symbol, Value: { price, timestamp, source }
  marketPrices: new Map(),

  // Account settings and configuration
  accountSettings: new Map(),

  // Position sizing settings
  positionSizing: loadPositionSizingSettings(),

  // Contract mappings for symbol conversion
  contractMappings: null, // Will be loaded async on startup

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
function getTradeAccountBalance() {
  // Try to get from account state first
  const accounts = Array.from(tradingState.accountSettings.values());
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
function convertPositionSize(originalSymbol, originalQuantity, action, entryPrice = null, stopLoss = null) {
  const settings = tradingState.positionSizing;
  const mappings = tradingState.contractMappings;
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

    const accountBalance = getTradeAccountBalance();
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
  // Filter out positions with null or zero netPos (ghost positions)
  const positions = Array.from(tradingState.tradingPositions.values()).filter(pos =>
    pos.netPos !== null && pos.netPos !== undefined && pos.netPos !== 0
  );
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

// Enhanced trading status with signal context and market data
app.get('/api/trading/enhanced-status', (req, res) => {
  // Helper function to calculate distance from current price to order price
  const calculateMarketDistance = (orderPrice, currentPrice, isLong) => {
    if (!orderPrice || !currentPrice) return null;
    const distance = orderPrice - currentPrice;
    const percentage = (distance / currentPrice) * 100;
    const pointsAway = Math.abs(distance);
    const direction = distance > 0 ? 'above' : 'below';

    return {
      points: pointsAway,
      percentage: Math.abs(percentage),
      direction,
      needsToMove: isLong ? (distance > 0 ? 'down' : 'filled') : (distance < 0 ? 'up' : 'filled')
    };
  };

  // Filter out positions with null or zero netPos
  const positions = Array.from(tradingState.tradingPositions.values()).filter(pos =>
    pos.netPos !== null && pos.netPos !== undefined && pos.netPos !== 0
  );

  // Get all working orders
  const orders = Array.from(tradingState.workingOrders.values());

  // Separate different types of orders - only show unfilled limit orders
  // Exclude bracket orders (stop_loss, take_profit) and filled entry orders
  const pendingEntryOrders = orders.filter(order => {
    // Skip invalid orders with undefined ID
    if (!order.id || order.id === 'undefined') {
      logger.warn(`⚠️ Skipping order with undefined ID: ${JSON.stringify(order)}`);
      return false;
    }

    // Skip bracket orders (stop_loss, take_profit)
    const relationship = tradingState.orderRelationships.get(order.id);
    if (relationship && (relationship.orderRole === 'stop_loss' || relationship.orderRole === 'take_profit')) {
      return false;
    }

    // SIGNAL-BASED FILTERING: The key simplification
    // If this order has a signalId and that signal already has a position, hide it
    if (order.signalId) {
      const signalHasPosition = positions.some(pos =>
        pos.signalContext && pos.signalContext.signalId === order.signalId
      );
      if (signalHasPosition) {
        logger.debug(`🎯 Hiding order ${order.id} - signal ${order.signalId} already has position`);
        return false; // Signal completed, position exists
      }
    }

    // Legacy fallback: Hide ANY order where a position exists for the same symbol
    // This catches orders without signal tracking
    const hasMatchingPosition = positions.some(pos => pos.symbol === order.symbol);
    if (hasMatchingPosition) {
      // Only hide entry orders, not stops/targets
      if (!order.stopPrice && !order.isTakeProfit && !order.isStopLoss) {
        logger.info(`🔍 Hiding filled order ${order.id} - position exists for ${order.symbol} (legacy fallback)`);
        return false; // Order likely filled and created the position
      }
    }

    // Show unfilled orders
    return true;
  });

  // Enhanced pending orders with signal context and market data
  const enhancedPendingOrders = pendingEntryOrders.map(order => {
    // Look up signal context using the signalId stored in the order
    let signalContext = null;

    if (order.signalId) {
      signalContext = tradingState.signalContext.get(order.signalId);
      if (signalContext) {
        logger.debug(`📡 Found signal context for order ${order.id} via signalId ${order.signalId}`);
      }
    }

    // Fallback: check if this is part of an order strategy (for backward compatibility)
    if (!signalContext) {
      const strategyId = tradingState.orderToStrategy.get(order.id);
      if (strategyId) {
        const strategySignalContext = tradingState.signalContext.get(strategyId);
        if (strategySignalContext) {
          signalContext = strategySignalContext;
          logger.debug(`📡 Found signal context for order ${order.id} via strategy ${strategyId}`);
        }
      }
    }
    const baseSymbol = getBaseSymbol(order.symbol);
    const marketData = tradingState.marketPrices.get(baseSymbol);
    const currentPrice = marketData?.price;

    // Calculate market distance if we have both order price and current price
    const marketDistance = order.price && currentPrice ?
      calculateMarketDistance(order.price, currentPrice, order.action === 'Buy') : null;

    return {
      // Basic order info
      orderId: order.id,
      symbol: order.symbol,
      baseSymbol,
      action: order.action,
      quantity: order.quantity,
      orderType: order.orderType,
      price: order.price,

      // Signal context (original trade signal details)
      signalContext: signalContext ? {
        signalId: signalContext.signalId,
        action: signalContext.action,
        originalAction: signalContext.action,
        originalSymbol: signalContext.originalSymbol,
        strategy: signalContext.strategy,
        reason: signalContext.reason,
        price: signalContext.price || order.price || null,  // Ensure null instead of undefined
        quantity: signalContext.quantity || order.quantity,
        stopLoss: signalContext.stopPrice,
        stopPrice: signalContext.stopPrice,
        takeProfit: signalContext.takeProfit,
        // Include separate trailing stop fields
        trailingOffset: signalContext.trailingOffset,
        trailingTrigger: signalContext.trailingTrigger,
        // Legacy trailing stop field
        trailingStop: signalContext.trailingStop,
        side: signalContext.side,
        timestamp: signalContext.timestamp,
        source: signalContext.source || 'tradingview',
        notes: signalContext.notes
      } : null,

      // Market data and distance
      marketData: marketData ? {
        currentPrice: marketData.price,
        timestamp: marketData.timestamp,
        source: marketData.source
      } : null,

      marketDistance,

      // Order metadata
      orderStatus: order.orderStatus,
      timestamp: order.timestamp,
      createdAt: order.timestamp || order.createdAt,
      timeSinceSignal: signalContext ?
        Date.now() - new Date(signalContext.timestamp).getTime() : null
    };
  });

  // Enhanced positions with current P&L and exit levels
  const enhancedPositions = positions.map(position => {
    const baseSymbol = getBaseSymbol(position.symbol);
    const marketData = tradingState.marketPrices.get(baseSymbol);
    const currentPrice = marketData?.price;

    // Find associated stop and target orders
    const stopOrders = orders.filter(order => {
      const relationship = tradingState.orderRelationships.get(order.id);
      return relationship &&
             relationship.orderRole === 'stop_loss' &&
             relationship.positionSymbol === position.symbol;
    });

    const targetOrders = orders.filter(order => {
      const relationship = tradingState.orderRelationships.get(order.id);
      return relationship &&
             relationship.orderRole === 'take_profit' &&
             relationship.positionSymbol === position.symbol;
    });

    return {
      // Basic position info
      symbol: position.symbol,
      baseSymbol,
      netPos: position.netPos,
      netPrice: position.netPrice,
      entryPrice: position.netPrice, // Frontend expects entryPrice
      unrealizedPnL: position.unrealizedPnL || 0,
      side: position.netPos > 0 ? 'long' : 'short', // Frontend expects side field

      // Current market data
      currentPrice,
      marketData: marketData ? {
        price: marketData.price,
        timestamp: marketData.timestamp,
        source: marketData.source
      } : null,

      // Exit levels for detailed view
      exitLevels: {
        stopLoss: stopOrders.map(order => ({
          orderId: order.id,
          price: order.stopPrice || order.price,
          quantity: order.quantity
        })),
        takeProfit: targetOrders.map(order => ({
          orderId: order.id,
          price: order.price,
          quantity: order.quantity
        }))
      },

      // Flattened fields for frontend compatibility
      stopPrice: stopOrders.length > 0 ? (stopOrders[0].stopPrice || stopOrders[0].price) : null,
      targetPrice: targetOrders.length > 0 ? targetOrders[0].price : null,

      // Position metadata
      lastUpdate: position.lastUpdate,
      displaySummary: position.displaySummary,

      // Signal context from original trade signal
      signalContext: position.signalContext
    };
  });

  res.json({
    tradingEnabled: tradingState.tradingEnabled,
    timestamp: new Date().toISOString(),

    // Question 1: Pending orders from trade signals
    pendingOrders: enhancedPendingOrders,

    // Question 2: Open positions
    openPositions: enhancedPositions,

    // Current market prices for all active symbols
    marketPrices: Object.fromEntries(tradingState.marketPrices),

    // Trading statistics (removed dailyPnL - should come from Tradovate account data only)
    stats: {
      pendingOrdersCount: enhancedPendingOrders.length,
      openPositionsCount: enhancedPositions.length,
      totalUnrealizedPnL: enhancedPositions.reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0),
      dailyTrades: tradingState.stats.dailyTrades
    }
  });
});

// Signal Registry debugging and monitoring endpoint
app.get('/api/trading/signal-registry', (req, res) => {
  const stats = signalRegistry.getStats();

  // Optionally include detailed signal lifecycles
  const includeLifecycles = req.query.includeLifecycles === 'true';

  const response = {
    timestamp: new Date().toISOString(),
    signalRegistryStats: stats,
    service: SERVICE_NAME
  };

  if (includeLifecycles) {
    // Convert Map to object for JSON serialization
    response.signalLifecycles = Object.fromEntries(signalRegistry.signalLifecycles);
  }

  res.json(response);
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

    // Sync latest position sizing settings before processing
    await syncPositionSizingSettings();

    // Calculate position size and apply position sizing conversion
    const positionSizing = convertPositionSize(signal.symbol, signal.quantity, signal.action, signal.price, signal.stop_loss);

    // Log position sizing results
    if (positionSizing.converted) {
      logger.info(`🔄 Position sizing conversion: ${positionSizing.originalQuantity} ${positionSizing.originalSymbol} → ${positionSizing.quantity} ${positionSizing.symbol} (${positionSizing.reason})`);
    } else {
      logger.info(`📊 Position sizing: ${positionSizing.quantity} ${positionSizing.symbol} (${positionSizing.reason})`);
    }

    // Special handling for direct tradovate service actions (position_closed, cancel_limit, update_limit)
    if (signal.action === 'position_closed' || signal.action === 'cancel_limit' || signal.action === 'update_limit') {
      const actionType = signal.action === 'update_limit' ? 'order update' : 'position liquidation';
      logger.info(`🔄 ${actionType} requested for ${positionSizing.symbol} (action: ${signal.action})`);

      // Send request directly to tradovate-service via webhook channel
      // This bypasses the ORDER_REQUEST channel and uses the webhook handler
      let routeMessage;

      if (signal.action === 'update_limit') {
        // For update_limit, preserve all the original fields
        routeMessage = {
          id: message.id,
          type: 'trade_signal',
          body: {
            action: 'update_limit',
            symbol: positionSizing.symbol, // Use converted symbol
            side: signal.side,
            old_price: signal.old_price,
            new_price: signal.new_price,
            stop_loss: signal.stop_loss,
            take_profit: signal.take_profit,
            quantity: signal.quantity,
            strategy: signal.strategy,
            accountId: signal.accountId || getDefaultAccountId(),
            timestamp: new Date().toISOString()
          }
        };
      } else {
        // For position_closed and cancel_limit
        routeMessage = {
          id: message.id,
          type: 'trade_signal',
          body: {
            action: 'position_closed', // Always use position_closed for the liquidation handler
            symbol: positionSizing.symbol, // Use converted symbol
            side: signal.side,
            accountId: signal.accountId || getDefaultAccountId(),
            timestamp: new Date().toISOString()
          }
        };
      }

      // Route directly to tradovate service webhook handler
      await messageBus.publish(CHANNELS.WEBHOOK_TRADE, routeMessage);

      if (signal.action === 'update_limit') {
        logger.info(`Order update signal routed to tradovate-service: ${positionSizing.symbol} ${signal.old_price} → ${signal.new_price}`);
      } else {
        logger.info(`Position liquidation signal routed to tradovate-service: ${positionSizing.symbol} (${signal.action} → position_closed)`);
      }
      return; // Exit early, no need to process as regular order
    }

    // Map signal fields to tradovate-service format for regular orders
    let mappedAction, mappedOrderType, mappedPrice, mappedStopPrice, mappedTakeProfit;

    // Log the incoming signal for debugging
    logger.info(`📝 Processing signal - action: ${signal.action}, side: ${signal.side}, price: ${signal.price}, stop_loss: ${signal.stop_loss}, take_profit: ${signal.take_profit}, trailing_trigger: ${signal.trailing_trigger}, trailing_offset: ${signal.trailing_offset}`);

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

    // CRITICAL: Check for existing positions to prevent multiple position stacking
    if (signal.action === 'place_limit' || mappedAction === 'Buy' || mappedAction === 'Sell') {
      // First, perform a quick position reconciliation to ensure we have latest state
      const lastReconciliation = tradingState.lastPositionReconciliation || 0;
      const reconciliationAge = Date.now() - lastReconciliation;

      // If position state is older than 30 seconds, reconcile with Tradovate
      if (reconciliationAge > 30000) {
        logger.info(`🔄 Position state is ${Math.round(reconciliationAge/1000)}s old, performing reconciliation before order validation`);
        const reconcileSuccess = await reconcilePositions();
        if (reconcileSuccess) {
          tradingState.lastPositionReconciliation = Date.now();
          logger.info(`✅ Position reconciliation completed before order validation`);
        } else {
          logger.warn(`⚠️ Position reconciliation failed, proceeding with local state`);
        }
      }

      const existingPosition = tradingState.tradingPositions.get(positionSizing.symbol);
      if (existingPosition && Math.abs(existingPosition.netPos) > 0) {
        logger.error(`🚨 POSITION COLLISION DETECTED: Existing position ${existingPosition.netPos} for ${positionSizing.symbol}`);
        logger.error(`🚨 Signal attempted: ${mappedAction} ${positionSizing.quantity} ${positionSizing.symbol} @ ${mappedPrice}`);
        logger.error(`🚨 Last update: ${existingPosition.lastUpdate}, source: ${existingPosition.lastUpdateSource}`);

        // Reject the order to prevent stacking
        await messageBus.publish(CHANNELS.TRADE_REJECTED, {
          reason: `Position collision: Existing ${existingPosition.netPos > 0 ? 'LONG' : 'SHORT'} position of ${existingPosition.netPos} units exists for ${positionSizing.symbol}. Cannot place new ${mappedAction} order to prevent position stacking.`,
          existingPosition: {
            symbol: existingPosition.symbol,
            netPos: existingPosition.netPos,
            entryPrice: existingPosition.netPrice,
            lastUpdate: existingPosition.lastUpdate,
            lastUpdateSource: existingPosition.lastUpdateSource
          },
          rejectedSignal: {
            symbol: positionSizing.symbol,
            action: mappedAction,
            quantity: positionSizing.quantity,
            price: mappedPrice
          },
          originalSignal: message,
          timestamp: new Date().toISOString()
        });

        logger.error(`🚫 Order rejected due to position collision for ${positionSizing.symbol}`);
        return; // Exit early to prevent order placement
      }

      logger.info(`✅ Position validation passed: No existing position for ${positionSizing.symbol}`);
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
      // Add trailing stop parameters if present
      trailing_trigger: signal.trailing_trigger,
      trailing_offset: signal.trailing_offset,
      // Add position sizing metadata
      positionSizing: {
        originalSymbol: positionSizing.originalSymbol,
        originalQuantity: positionSizing.originalQuantity,
        converted: positionSizing.converted,
        reason: positionSizing.reason
      }
    };

    // Store original signal context for status tracking
    tradingState.signalContext.set(message.id, {
      signalId: message.id,
      originalSignal: signal,
      action: signal.action,
      symbol: positionSizing.symbol,
      originalSymbol: signal.symbol,
      price: mappedPrice,
      stopPrice: mappedStopPrice,
      takeProfit: mappedTakeProfit,
      quantity: positionSizing.quantity,
      side: signal.side,
      orderType: mappedOrderType,
      strategy: signal.strategy,
      reason: signal.reason,
      timestamp: new Date().toISOString(),
      positionSizing,
      source: signal.source || 'tradingview',
      // Keep trailing stop components separate
      trailingOffset: signal.trailing_offset,
      trailingTrigger: signal.trailing_trigger,
      // Legacy support for existing trailingStop field
      trailingStop: signal.trailingStop,
      notes: signal.notes
    });

    // Register signal with SignalRegistry for comprehensive tracking
    signalRegistry.registerSignal(message.id, {
      originalSignal: signal,
      processedSignal: {
        symbol: positionSizing.symbol,
        price: mappedPrice,
        stopPrice: mappedStopPrice,
        takeProfit: mappedTakeProfit,
        quantity: positionSizing.quantity,
        side: signal.side,
        orderType: mappedOrderType
      }
    });

    // Save signal context and registry to disk for persistence
    await saveSignalContext();
    await signalRegistry.saveMappings();
    await signalRegistry.saveLifecycles();

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
        accountId: body.account_id,
        // Add trailing stop support for TradingView format
        trailing_trigger: body.trailing_trigger,
        trailing_offset: body.trailing_offset
      };
    }

    // Format 2: Test interface format with bracket order support
    if (body.symbol && (body.side || body.action === 'place_limit' || body.action === 'update_limit' || body.action === 'cancel_limit' || body.action === 'position_closed')) {
      return {
        symbol: body.symbol,
        action: body.action, // Preserve original action (e.g., 'place_limit', 'update_limit')
        side: body.side, // Preserve side for bracket order mapping
        orderType: body.type || 'Market',
        price: body.price,
        old_price: body.old_price, // For update_limit actions
        new_price: body.new_price, // For update_limit actions
        stop_loss: body.stop_loss, // Preserve for bracket orders
        take_profit: body.take_profit, // Preserve for bracket orders
        stopPrice: body.stop_price,
        quantity: body.quantity,
        accountId: body.accountId || body.account,
        trailing_trigger: body.trailing_trigger,
        trailing_offset: body.trailing_offset,
        strategy: body.strategy, // Preserve strategy field
        reason: body.reason // For cancel_limit actions
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
// Position sizing is now handled locally by convertPositionSize() function above

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
  // Handle null/undefined
  if (!contractSymbol) return null;

  // Convert to string if needed
  const symbol = String(contractSymbol);

  // Remove month/year suffixes to get base symbol
  if (symbol.includes('MNQ')) return 'MNQ';
  if (symbol.includes('NQ')) return 'NQ';
  if (symbol.includes('MES')) return 'MES';
  if (symbol.includes('ES')) return 'ES';
  if (symbol.includes('M2K')) return 'M2K';
  if (symbol.includes('RTY')) return 'RTY';
  return symbol; // Return original if no match
}


// Calculate unrealized P&L for a position
function calculateUnrealizedPnL(position, currentPrice) {
  logger.debug(`🧮 Calculating P&L: symbol=${position.symbol}, currentPrice=${currentPrice}, netPrice=${position.netPrice}, netPos=${position.netPos}`);

  if (!currentPrice || position.netPos === 0) {
    logger.debug(`🧮 P&L calculation failed: currentPrice=${currentPrice}, netPos=${position.netPos}`);
    return 0;
  }

  // Try multiple sources for entry price
  const entryPrice = position.netPrice || position.entryPrice || position.averagePrice;
  if (!entryPrice) {
    logger.warn(`⚠️ No entry price available for ${position.symbol} - cannot calculate P&L`);
    return 0;
  }

  const pointValue = getPointValue(position.symbol);
  const quantity = Math.abs(position.netPos);
  const priceDiff = position.netPos > 0
    ? (currentPrice - entryPrice)  // Long position: profit when price goes up
    : (entryPrice - currentPrice); // Short position: profit when price goes down

  const result = priceDiff * quantity * pointValue;

  logger.debug(`🧮 P&L calculation: ${position.netPos} ${position.symbol} @ ${entryPrice} → ${currentPrice} | diff=${priceDiff} × qty=${quantity} × pv=${pointValue} = $${result.toFixed(2)}`);

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
    source: message.source,
    signalId: message.signalId  // Store signal ID from tradovate-service
  };

  // Create signal ID mapping if signal ID is present
  if (message.signalId) {
    // Store the mapping between order ID and signal ID for signal context lookup
    // This allows both direct lookup and strategy-based lookup to work
    logger.info(`📡 Creating signal mapping: order ${message.orderId} → signal ${message.signalId}`);

    // For order strategies, we also need to handle the strategy ID mapping
    if (message.strategyId && message.strategyId !== message.orderId) {
      tradingState.orderToStrategy.set(message.orderId, message.strategyId);
      // Also map the strategy ID to the signal ID
      tradingState.orderToStrategy.set(message.strategyId, message.signalId);
      logger.info(`📡 Creating strategy mapping: order ${message.orderId} → strategy ${message.strategyId} → signal ${message.signalId}`);
    }
  }

  // Store the working order
  tradingState.workingOrders.set(message.orderId, order);

  // Link order to signal in SignalRegistry
  if (message.signalId) {
    signalRegistry.linkOrderToSignal(message.orderId, message.signalId, message.orderRole || 'entry');
  }

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
    // Don't delete the order relationship for entry orders - we need it for dashboard filtering
    logger.info(`🔗 Keeping order relationship for filled entry order ${message.orderId} for dashboard tracking`);
  } else if (orderRole === 'stop_loss' || orderRole === 'take_profit') {
    // This is a bracket order fill - update position and remove other bracket orders
    await handleBracketOrderFill(message, orderRole);
    // Clean up bracket order relationships since they're no longer needed
    tradingState.orderRelationships.delete(message.orderId);
    logger.info(`🗑️ Cleaned up bracket order relationship for ${message.orderId}`);
  }

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

// Handle order cancellations from Tradovate
async function handleOrderCancelled(message) {
  logger.warn(`❌ Order cancelled: ${message.orderId}`);

  // Check if this is an individual order from an order strategy
  const strategyId = tradingState.orderToStrategy.get(message.orderId);
  const orderIdToDelete = strategyId || message.orderId;

  // Remove from working orders (using strategy ID if available)
  tradingState.workingOrders.delete(orderIdToDelete);

  // Clean up order relationship
  tradingState.orderRelationships.delete(orderIdToDelete);

  // Clean up the mapping
  if (strategyId) {
    tradingState.orderToStrategy.delete(message.orderId);
    // Save mapping after modification
    await saveOrderStrategyMapping();
  }

  // Update statistics
  tradingState.stats.totalWorkingOrders = tradingState.workingOrders.size;

  logger.info(`💼 Working orders after cancellation: ${tradingState.workingOrders.size}`);
}

// Handle position updates from Tradovate (for real-time P&L)
async function handlePositionUpdate(message) {
  logger.info(`📊 Processing position update from ${message.source || 'unknown'}`);

  if (message.positions && Array.isArray(message.positions)) {
    // Bulk position update
    let newPositionsAdded = 0;
    let duplicatesSkipped = 0;

    for (const posData of message.positions) {
      // Check for duplicate by contract ID
      const existingPosition = Array.from(tradingState.tradingPositions.values())
        .find(pos => pos.contractId === posData.contractId);

      if (existingPosition && message.source === 'websocket_sync') {
        logger.info(`⚠️  Skipping duplicate position from sync: Contract ${posData.contractId}`);
        duplicatesSkipped++;
        continue;
      }

      if (posData.netPos !== 0) {
        await updateTradingPositionFromMarketData(posData, message.accountId);
        newPositionsAdded++;
      } else {
        // Position closed
        const symbolToDelete = posData.symbol || getSymbolFromContractId(posData.contractId);
        if (symbolToDelete) {
          tradingState.tradingPositions.delete(symbolToDelete);
          logger.info(`🗑️  Removed closed position: ${symbolToDelete}`);
        }
      }
    }

    if (duplicatesSkipped > 0) {
      logger.info(`📊 Position update summary: ${newPositionsAdded} new, ${duplicatesSkipped} duplicates skipped`);
    }
  } else if (message.symbol) {
    // Single position update
    if (message.netPos !== 0) {
      await updateTradingPositionFromMarketData(message, message.accountId);
    } else {
      tradingState.tradingPositions.delete(message.symbol);
      logger.info(`🗑️  Removed closed position: ${message.symbol}`);
    }
  }

  // Update position count
  tradingState.stats.totalPositions = tradingState.tradingPositions.size;
}

// Helper function to find symbol by contract ID
function getSymbolFromContractId(contractId) {
  for (const [symbol, position] of tradingState.tradingPositions.entries()) {
    if (position.contractId === contractId) {
      return symbol;
    }
  }
  return null;
}

// Handle explicit position closure
async function handlePositionClosed(message) {
  // Defensive check for undefined message or symbol
  if (!message) {
    logger.error(`❌ Position closed event received with undefined message`);
    return;
  }

  if (!message.symbol) {
    logger.warn(`⚠️ Position closed event received with undefined symbol:`, message);
    // Try to resolve symbol from contractId if available
    if (message.contractId) {
      const symbol = getSymbolFromContractId(message.contractId);
      if (symbol) {
        message.symbol = symbol;
        logger.info(`✅ Resolved symbol from contractId ${message.contractId}: ${symbol}`);
      } else {
        logger.error(`❌ Cannot resolve symbol for contractId ${message.contractId}, skipping position closure`);
        return;
      }
    } else {
      logger.error(`❌ Position closed event has no symbol or contractId, skipping:`, message);
      return;
    }
  }

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
    // FUTURES PARADIGM: One position per symbol - all fills adjust the existing position

    // Normalize action to handle various formats (Buy/Sell, B/S, 1/2, etc.)
    const action = String(fillMessage.action).toUpperCase();
    let isBuyFill;

    if (action === 'BUY' || action === 'B' || action === '1') {
      isBuyFill = true;
    } else if (action === 'SELL' || action === 'S' || action === '2') {
      isBuyFill = false;
    } else {
      logger.error(`🚨 Unknown fill action: ${fillMessage.action}, treating as BUY`);
      isBuyFill = true;
    }

    // Calculate signed quantity change
    const signedFillQuantity = isBuyFill ? fillMessage.quantity : -fillMessage.quantity;
    const oldNetPos = existing.netPosition;
    const newQuantity = oldNetPos + signedFillQuantity;

    logger.info(`📊 Position adjustment: ${symbol} ${oldNetPos} → ${newQuantity} (${isBuyFill ? 'BUY' : 'SELL'} ${fillMessage.quantity})`);

    if (newQuantity === 0) {
      // Position closed
      tradingState.tradingPositions.delete(symbol);
      logger.info(`📊 Position closed via fill: ${symbol}`);
    } else {
      // Determine if we're adding, reducing, or flipping the position
      const isAdding = (oldNetPos > 0 && signedFillQuantity > 0) || (oldNetPos < 0 && signedFillQuantity < 0);
      const isFlipping = (oldNetPos > 0 && newQuantity < 0) || (oldNetPos < 0 && newQuantity > 0);

      let newEntryPrice;

      if (isAdding) {
        // ADDING to position: calculate weighted average
        const totalValue = (oldNetPos * existing.entryPrice) + (signedFillQuantity * fillMessage.fillPrice);
        newEntryPrice = Math.abs(totalValue / newQuantity);
        logger.info(`📈 ADDING to position: avg price = (${oldNetPos} × ${existing.entryPrice.toFixed(2)} + ${signedFillQuantity} × ${fillMessage.fillPrice}) / ${newQuantity} = ${newEntryPrice.toFixed(2)}`);
      } else if (isFlipping) {
        // Position FLIPPED: use fill price as new entry
        newEntryPrice = fillMessage.fillPrice;
        logger.info(`🔄 Position FLIPPED: new entry = ${newEntryPrice.toFixed(2)} (fill price)`);
      } else {
        // REDUCING position: keep existing entry price
        newEntryPrice = existing.entryPrice;
        logger.info(`📉 REDUCING position: entry unchanged at ${newEntryPrice.toFixed(2)}`);
      }

      // Round entry price to nearest tick (0.25 for NQ futures)
      const tickSize = 0.25;
      newEntryPrice = Math.round(newEntryPrice / tickSize) * tickSize;
      logger.info(`📏 Rounded entry price to nearest tick: ${newEntryPrice}`);

      // Validate the calculated price is reasonable (basic sanity check)
      if (!newEntryPrice || newEntryPrice < 1 || newEntryPrice > 1000000) {
        logger.error(`🚨 Invalid entry price calculated: ${newEntryPrice}, using fill price ${fillMessage.fillPrice}`);
        newEntryPrice = fillMessage.fillPrice;
      }

      // Update both frontend-expected and internal fields
      const newSide = newQuantity > 0 ? 'long' : 'short';
      existing.netPos = newQuantity;
      existing.netPrice = newEntryPrice;
      existing.netPosition = newQuantity;
      existing.side = newSide;
      existing.entryPrice = newEntryPrice;
      existing.lastUpdate = fillMessage.timestamp;

      // Create order relationship to mark this filled order (for position updates too)
      tradingState.orderRelationships.set(fillMessage.orderId, {
        orderRole: 'entry',
        positionSymbol: symbol,
        signalId: existing.signalContext?.signalId || 'unknown'
      });
      logger.info(`🔗 Created order relationship for filled order ${fillMessage.orderId} -> existing position ${symbol}`);

      logger.info(`📊 Updated position: ${symbol} = ${newQuantity} @ ${newEntryPrice.toFixed(2)}`);
    }
  } else {
    // Look up signal context for this order using SignalRegistry first (needed for action fallback)
    let signalContext = null;

    // PRIMARY: Use signalId from the fill message (sent by tradovate-service)
    if (fillMessage.signalId) {
      signalContext = tradingState.signalContext.get(fillMessage.signalId);
      if (signalContext) {
        logger.debug(`📡 Found signal context via message signalId for ${fillMessage.orderId}: Signal ID ${fillMessage.signalId}`);
      }
    }

    // Fallback: Use SignalRegistry for fast lookup
    if (!signalContext) {
      const signalId = signalRegistry.findSignalForOrder(fillMessage.orderId);
      if (signalId) {
        signalContext = tradingState.signalContext.get(signalId);
        if (signalContext) {
          logger.debug(`📡 Found signal context via SignalRegistry for ${fillMessage.orderId}: Signal ID ${signalId}`);
        }
      }
    }

    // Fallback: Use working order data (for compatibility)
    if (!signalContext) {
      const workingOrder = tradingState.workingOrders.get(fillMessage.orderId);
      if (workingOrder && workingOrder.signalId) {
        signalContext = tradingState.signalContext.get(workingOrder.signalId);
        if (signalContext) {
          logger.debug(`📡 Found signal context via working order for ${fillMessage.orderId}: Signal ID ${signalContext.signalId}`);
        }
      }
    }

    // Emergency fallback: Find recent signal context by symbol/price match (for immediate fills)
    if (!signalContext) {
      logger.warn(`⚡ Immediate fill scenario detected for ${fillMessage.orderId} - searching recent signals by symbol/price`);

      for (const [contextSignalId, contextData] of tradingState.signalContext.entries()) {
        // Look for recent signal (within last 30 seconds) with matching symbol and similar price
        const signalTime = new Date(contextData.timestamp).getTime();
        const fillTime = new Date(fillMessage.timestamp || new Date()).getTime();
        const timeDiff = Math.abs(fillTime - signalTime);

        if (timeDiff < 30000 && // Within 30 seconds
            contextData.symbol === symbol && // Same symbol
            Math.abs(contextData.price - fillMessage.fillPrice) < 10) { // Price within 10 points
          signalContext = contextData;
          logger.debug(`⚡ Found signal context via emergency price/time match: ${contextSignalId} (time diff: ${timeDiff}ms, price diff: ${Math.abs(contextData.price - fillMessage.fillPrice)})`);

          // Register this order with the signal for future lookups
          signalRegistry.linkOrderToSignal(fillMessage.orderId, contextSignalId, 'entry_order');
          break;
        }
      }
    }

    // Additional fallback: Search for parent OrderStrategy orders with same symbol
    // This handles the case where child order fills but doesn't inherit parent signal context
    if (!signalContext) {
      logger.warn(`🔍 Searching for parent OrderStrategy orders for symbol ${symbol}`);

      for (const [orderId, order] of tradingState.workingOrders.entries()) {
        if (order.symbol === symbol && (order.isOrderStrategy || order.strategyId) && order.signalId) {
          signalContext = tradingState.signalContext.get(order.signalId);
          if (signalContext) {
            logger.debug(`🔗 Found signal context via parent OrderStrategy ${orderId}: Signal ID ${order.signalId}`);
            break;
          }
        }
      }
    }

    // Final fallback: Try the order-to-strategy mapping (for bracket orders)
    if (!signalContext) {
      const strategyId = tradingState.orderToStrategy.get(fillMessage.orderId);
      if (strategyId) {
        const strategySignalContext = tradingState.signalContext.get(strategyId);
        if (strategySignalContext) {
          signalContext = strategySignalContext;
          logger.debug(`📡 Found signal context via strategy ${strategyId} for order ${fillMessage.orderId}: Signal ID ${signalContext.signalId}`);
        }
      }
    }

    if (!signalContext) {
      logger.warn(`⚠️  No signal context found for filled order ${fillMessage.orderId}`);
    }

    // Normalize action to handle various formats (Buy/Sell, B/S, 1/2, etc.)
    let isBuyFill;
    const rawAction = String(fillMessage.action || '').toUpperCase();

    if (rawAction === 'BUY' || rawAction === 'B' || rawAction === '1') {
      isBuyFill = true;
    } else if (rawAction === 'SELL' || rawAction === 'S' || rawAction === '2') {
      isBuyFill = false;
    } else if (signalContext) {
      // Fallback: If action is not recognized, use signal context
      if (signalContext.side === 'buy') {
        isBuyFill = true;
        logger.info(`📡 Using signal context to determine action: ${signalContext.side} → BUY`);
      } else if (signalContext.side === 'sell') {
        isBuyFill = false;
        logger.info(`📡 Using signal context to determine action: ${signalContext.side} → SELL`);
      } else {
        logger.warn(`⚠️ Unknown action '${fillMessage.action}' and signal side '${signalContext?.side}', defaulting to BUY`);
        isBuyFill = true;
      }
    } else {
      logger.warn(`⚠️ Unknown action '${fillMessage.action}' with no signal context, defaulting to BUY`);
      isBuyFill = true;
    }

    // Calculate position quantity (positive = long, negative = short)
    const quantity = isBuyFill ? fillMessage.quantity : -fillMessage.quantity;
    const side = quantity > 0 ? 'long' : 'short';

    logger.info(`📊 New position created: ${isBuyFill ? 'BUY' : 'SELL'} ${fillMessage.quantity} → netPos=${quantity} (${side})`);

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

      // Signal context from trade signal
      signalContext: signalContext,

      // Metadata
      createdAt: fillMessage.timestamp,
      lastUpdate: fillMessage.timestamp,
      strategy: signalContext?.source || 'unknown',
      riskParams: {}
    };

    tradingState.tradingPositions.set(symbol, newPosition);
    logger.info(`🆕 New position created: ${symbol} = ${quantity} @ ${fillMessage.fillPrice}`);

    // Create order relationship to mark this filled entry order
    // This is crucial for the dashboard filtering logic to properly hide filled orders
    tradingState.orderRelationships.set(fillMessage.orderId, {
      orderRole: 'entry',
      positionSymbol: symbol,
      signalId: signalContext?.signalId || 'unknown'
    });
    logger.info(`🔗 Created order relationship for filled entry order ${fillMessage.orderId} -> position ${symbol}`);

    // If this fill has a signal context, also check if there's a parent OrderStrategy to link
    if (signalContext && signalContext.signalId) {
      // Find any OrderStrategy orders with the same signal ID
      for (const [orderId, order] of tradingState.workingOrders.entries()) {
        if (order.signalId === signalContext.signalId && (order.isOrderStrategy || order.strategyId)) {
          tradingState.orderRelationships.set(orderId, {
            orderRole: 'entry',
            positionSymbol: symbol,
            signalId: signalContext.signalId
          });
          logger.info(`🔗 Created order relationship for parent OrderStrategy ${orderId} -> position ${symbol}`);
        }
      }
    }

    // Link position to signal in SignalRegistry
    if (signalContext && signalContext.signalId) {
      signalRegistry.linkPositionToSignal(signalContext.signalId, symbol, fillMessage.orderId);
    }

    // Link bracket orders to the new position
    await linkBracketOrdersToPosition(newPosition, signalContext, fillMessage.orderId);
  }

  // Update statistics
  tradingState.stats.totalPositions = tradingState.tradingPositions.size;
}

// Link bracket orders to a newly created position
async function linkBracketOrdersToPosition(position, signalContext, entryOrderId) {
  if (!signalContext) {
    logger.warn(`⚠️ No signal context available to link bracket orders for ${position.symbol}`);
    return;
  }

  logger.info(`🔗 Looking for bracket orders to link to position ${position.symbol} from signal ${signalContext.signalId}`);

  let stopOrdersLinked = 0;
  let targetOrdersLinked = 0;

  // Find bracket orders that belong to the same signal/strategy
  for (const [orderId, order] of tradingState.workingOrders.entries()) {
    // Check if this order belongs to the same signal
    const orderSignalContext = tradingState.signalContext.get(orderId);
    const strategyId = tradingState.orderToStrategy.get(orderId);
    const strategySignalContext = strategyId ? tradingState.signalContext.get(strategyId) : null;

    const orderContext = orderSignalContext || strategySignalContext;

    if (orderContext && orderContext.signalId === signalContext.signalId && order.symbol === position.symbol) {
      // This is a bracket order from the same signal - determine its role
      const isStopOrder = order.orderType === 'Stop' || order.orderType === 'StopLimit' ||
                         (orderContext.stopPrice && Math.abs(order.price - orderContext.stopPrice) < 1);
      const isTargetOrder = orderContext.takeProfit && Math.abs(order.price - orderContext.takeProfit) < 1;

      if (isStopOrder) {
        // Link as stop loss order
        tradingState.orderRelationships.set(orderId, {
          orderRole: 'stop_loss',
          positionSymbol: position.symbol,
          signalId: signalContext.signalId
        });
        stopOrdersLinked++;
        logger.info(`🔗 Linked stop loss order ${orderId} to position ${position.symbol}`);
      } else if (isTargetOrder) {
        // Link as take profit order
        tradingState.orderRelationships.set(orderId, {
          orderRole: 'take_profit',
          positionSymbol: position.symbol,
          signalId: signalContext.signalId
        });
        targetOrdersLinked++;
        logger.info(`🔗 Linked take profit order ${orderId} to position ${position.symbol}`);
      }
    }
  }

  logger.info(`✅ Bracket order linking complete for ${position.symbol}: ${stopOrdersLinked} stop orders, ${targetOrdersLinked} target orders`);

  // Update the position with bracket order info for immediate display
  await linkAssociatedOrders(position);
}

// Link bracket orders to a synced position (without signal context)
async function linkBracketOrdersForSyncedPosition(position) {
  logger.info(`🔗 Searching for bracket orders to link to synced position ${position.symbol}`);

  let stopOrdersLinked = 0;
  let targetOrdersLinked = 0;

  // Look through all signal contexts to find one that matches this position
  let matchingSignalContext = null;

  for (const [signalId, signalContext] of tradingState.signalContext.entries()) {
    // Check if this signal is for the same symbol and has bracket order prices
    if (signalContext.originalSymbol === position.baseSymbol || signalContext.originalSymbol === position.symbol) {
      // Check if position price is close to signal entry price
      if (signalContext.price && Math.abs(position.entryPrice - signalContext.price) < 10) {
        matchingSignalContext = signalContext;
        logger.info(`🎯 Found matching signal context ${signalId} for position ${position.symbol}`);
        break;
      }
    }
  }

  if (!matchingSignalContext) {
    logger.info(`⚠️ No matching signal context found for position ${position.symbol}`);
    return;
  }

  // Now use the matching signal context to link bracket orders
  for (const [orderId, order] of tradingState.workingOrders.entries()) {
    // Check if this order belongs to the matching signal
    const orderSignalContext = tradingState.signalContext.get(orderId);
    const strategyId = tradingState.orderToStrategy.get(orderId);
    const strategySignalContext = strategyId ? tradingState.signalContext.get(strategyId) : null;

    const orderContext = orderSignalContext || strategySignalContext;

    if (orderContext && orderContext.signalId === matchingSignalContext.signalId && order.symbol === position.symbol) {
      // This is a bracket order from the matching signal - determine its role
      const isStopOrder = order.orderType === 'Stop' || order.orderType === 'StopLimit' ||
                         (orderContext.stopPrice && Math.abs(order.price - orderContext.stopPrice) < 1);
      const isTargetOrder = orderContext.takeProfit && Math.abs(order.price - orderContext.takeProfit) < 1;

      if (isStopOrder) {
        // Link as stop loss order
        tradingState.orderRelationships.set(orderId, {
          orderRole: 'stop_loss',
          positionSymbol: position.symbol,
          signalId: matchingSignalContext.signalId
        });
        stopOrdersLinked++;
        logger.info(`🔗 Linked stop loss order ${orderId} to synced position ${position.symbol}`);
      } else if (isTargetOrder) {
        // Link as take profit order
        tradingState.orderRelationships.set(orderId, {
          orderRole: 'take_profit',
          positionSymbol: position.symbol,
          signalId: matchingSignalContext.signalId
        });
        targetOrdersLinked++;
        logger.info(`🔗 Linked take profit order ${orderId} to synced position ${position.symbol}`);
      }
    }
  }

  logger.info(`✅ Bracket order linking complete for synced position ${position.symbol}: ${stopOrdersLinked} stop orders, ${targetOrdersLinked} target orders`);

  // Update position with signal context and refresh bracket order info
  position.signalContext = matchingSignalContext;
  await linkAssociatedOrders(position);
}

// Handle when a bracket order (stop/target) fills
async function handleBracketOrderFill(fillMessage, orderRole) {
  const symbol = fillMessage.symbol;

  logger.info(`🎯 Bracket ${orderRole} filled for ${symbol}`);

  // In futures paradigm, bracket orders are just fills that adjust the position
  // Let updatePositionFromFill handle it with the proper one-position-per-symbol logic
  await updatePositionFromFill(fillMessage);

  // If position was closed, cancel other bracket orders
  const remainingPosition = tradingState.tradingPositions.get(symbol);
  if (!remainingPosition) {
    logger.info(`🔒 Position closed via ${orderRole}, cancelling other bracket orders`);
    await cancelOtherBracketOrders(symbol, fillMessage.orderId);
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
  const updateSource = posData.source || 'unknown';
  const updateTimestamp = posData.timestamp || new Date().toISOString();

  logger.info(`🔄 Position update from ${updateSource}:`, {
    symbol: posData.symbol,
    contractId: posData.contractId,
    netPos: posData.netPos,
    netPrice: posData.netPrice,
    averagePrice: posData.averagePrice,
    entryPrice: posData.entryPrice,
    currentPrice: posData.currentPrice,
    unrealizedPnL: posData.pnl || posData.unrealizedPnL,
    timestamp: updateTimestamp
  });
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
    logger.info(`📊 Updating existing position ${symbol} from ${updateSource}`);

    // Always update current price for real-time market data
    position.currentPrice = posData.currentPrice || position.currentPrice;

    // Simplified position update logic - Tradovate is authoritative
    let shouldUpdateEntryPrice = false;
    let newEntryPrice = position.netPrice;

    // Trust Tradovate data sources for entry price updates
    if (updateSource === 'websocket_position_update' || updateSource === 'websocket_update' || updateSource === 'websocket_sync') {
      // WebSocket data from Tradovate is always authoritative
      shouldUpdateEntryPrice = true;
      if (posData.netPrice && posData.netPrice > 0) {
        newEntryPrice = posData.netPrice;
      } else if (posData.averagePrice && posData.averagePrice > 0) {
        newEntryPrice = posData.averagePrice;
      }
      logger.info(`📡 WebSocket position update: ${newEntryPrice} from ${updateSource}`);
    } else if (updateSource === 'fill_update') {
      // Fill data is always trusted - this is direct execution data
      shouldUpdateEntryPrice = true;
      if (posData.netPrice && posData.netPrice > 0) {
        newEntryPrice = posData.netPrice;
      } else if (posData.averagePrice && posData.averagePrice > 0) {
        newEntryPrice = posData.averagePrice;
      }
      logger.info(`💰 Fill position update: ${newEntryPrice} from execution`);
    } else if (!position.netPrice || position.netPrice === 0) {
      // Fill missing entry price from any source
      if (posData.netPrice && posData.netPrice > 0) {
        shouldUpdateEntryPrice = true;
        newEntryPrice = posData.netPrice;
        logger.info(`🔄 Setting missing entry price: ${newEntryPrice}`);
      } else if (posData.averagePrice && posData.averagePrice > 0) {
        shouldUpdateEntryPrice = true;
        newEntryPrice = posData.averagePrice;
        logger.info(`📈 Setting missing entry price from average: ${newEntryPrice}`);
      }
    }

    // Apply entry price update if approved
    if (shouldUpdateEntryPrice && newEntryPrice > 0) {
      const oldPrice = position.netPrice;
      position.netPrice = newEntryPrice;
      position.entryPrice = newEntryPrice;
      logger.info(`✅ Entry price updated: ${oldPrice} → ${newEntryPrice} (source: ${updateSource})`);
    }

    // Update metadata
    position.lastUpdate = updateTimestamp;
    position.lastUpdateSource = updateSource;

    // Update net position if provided
    if (posData.netPos !== undefined) {
      position.netPos = posData.netPos;
    }

    // Update associated orders in the position
    await linkAssociatedOrders(position);
  } else if (posData.netPos && posData.netPos !== 0) {
    // Create position from market data (startup sync scenario)
    // Only create if netPos is valid and not zero
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
      currentPrice: posData.currentPrice || 0,

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

    // Try to link bracket orders for this position using signal context matching
    await linkBracketOrdersForSyncedPosition(newPosition);

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
        const stopOrder = {
          orderId: orderId,
          price: order.stopPrice || order.price,
          status: order.status,
          orderType: order.orderType
        };

        // Check if this is a trailing stop order
        if (order.orderType === 'Stop' || (order.orderType === 'Limit' && order.stopPrice)) {
          stopOrder.isTrailing = true;

          // Calculate trailing stop activation point
          const currentPrice = position.currentPrice;
          const entryPrice = position.entryPrice;
          const isLong = position.netPos > 0;

          // For trailing stops, calculate how far price needs to move before trailing activates
          if (currentPrice && entryPrice) {
            const priceMovement = isLong ? currentPrice - entryPrice : entryPrice - currentPrice;
            const stopDistance = isLong ? currentPrice - stopOrder.price : stopOrder.price - currentPrice;

            stopOrder.trailingInfo = {
              activationPrice: stopOrder.price, // This is the current trailing level
              priceMovement: priceMovement,
              stopDistance: stopDistance,
              distanceToActivation: Math.max(0, stopDistance - priceMovement)
            };

            logger.info(`📈 Trailing stop for ${position.symbol}: activation=${stopOrder.price}, movement=${priceMovement.toFixed(2)}, distance=${stopDistance.toFixed(2)}`);
          }
        }

        position.stopLossOrder = stopOrder;
      } else if (orderRole === 'take_profit') {
        position.takeProfitOrder = {
          orderId: orderId,
          price: order.price,
          status: order.status,
          orderType: order.orderType
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

  // Add unified position display summary
  const stopInfo = position.stopLossOrder ?
    (position.stopLossOrder.isTrailing ? `${position.stopLossOrder.price} (trailing)` : position.stopLossOrder.price) : 'none';
  const targetInfo = position.takeProfitOrder?.price || 'none';
  const entryOrders = position.pendingEntryOrders.length || 0;

  // Enhanced position summary for display
  position.displaySummary = {
    direction: position.netPos > 0 ? 'Long' : 'Short',
    quantity: Math.abs(position.netPos),
    symbol: position.symbol,
    entryPrice: position.entryPrice,
    currentPrice: position.currentPrice,
    stopPrice: position.stopLossOrder?.price || position.signalContext?.stopPrice,
    targetPrice: position.takeProfitOrder?.price || position.signalContext?.takeProfit,
    isTrailingStop: position.stopLossOrder?.isTrailing || false,
    trailingInfo: position.stopLossOrder?.trailingInfo,
    unrealizedPnL: position.unrealizedPnL,
    // Unified string for display: "Long 1 MNQ @ 24895 | Stop: 24850 (trailing) | Target: 24950"
    displayString: `${position.netPos > 0 ? 'Long' : 'Short'} ${Math.abs(position.netPos)} ${position.symbol} @ ${position.entryPrice}${position.stopLossOrder ? ` | Stop: ${stopInfo}` : ''}${position.takeProfitOrder ? ` | Target: ${targetInfo}` : ''}`
  };

  logger.info(`🔗 Position summary: ${position.displaySummary.displayString}`);
}

// ===== MARKET DATA AND P&L MANAGEMENT =====

// Handle real-time price updates from message bus
async function handlePriceUpdate(message) {
  try {
    const symbol = message.symbol;
    const baseSymbol = message.baseSymbol || getBaseSymbol(symbol);
    const currentPrice = message.close || message.price;

    logger.debug(`📈 Price update received: ${symbol} (base: ${baseSymbol}) = ${currentPrice}`);

    if (!currentPrice) {
      logger.warn(`📈 No price in update for ${symbol}`);
      return;
    }

    // Store current market price for all symbols (not just those with positions)
    tradingState.marketPrices.set(baseSymbol, {
      price: currentPrice,
      timestamp: new Date().toISOString(),
      source: message.source || 'market-data-service',
      symbol: symbol,
      baseSymbol: baseSymbol
    });

    // Only process P&L updates if we have positions for this symbol
    let hasPositions = false;
    logger.debug(`📊 Checking positions for base symbol: ${baseSymbol}`);

    for (const position of tradingState.tradingPositions.values()) {
      const positionBaseSymbol = getBaseSymbol(position.symbol);
      logger.debug(`📊 Position ${position.symbol} -> base: ${positionBaseSymbol} (looking for: ${baseSymbol})`);
      logger.debug(`🔍 String comparison: "${positionBaseSymbol}" === "${baseSymbol}" = ${positionBaseSymbol === baseSymbol}`);
      logger.debug(`🔍 Types: ${typeof positionBaseSymbol} vs ${typeof baseSymbol}`);
      logger.debug(`🔍 Lengths: ${positionBaseSymbol.length} vs ${baseSymbol.length}`);

      if (positionBaseSymbol === baseSymbol) {
        hasPositions = true;
        logger.debug(`🎯 MATCH! Processing P&L for ${position.symbol}: ${positionBaseSymbol} === ${baseSymbol}`);

        // Calculate new P&L with updated price
        const unrealizedPnL = calculateUnrealizedPnL(position, currentPrice);

        // Update position with current price and calculated P&L
        position.currentPrice = currentPrice;
        position.unrealizedPnL = unrealizedPnL;
        position.lastUpdate = new Date().toISOString();

        logger.debug(`💰 Updated P&L for ${position.symbol}: ${position.netPos} @ ${position.netPrice} → current ${currentPrice} = $${unrealizedPnL.toFixed(2)}`);
        logger.debug(`✅ Position object after update: unrealizedPnL=${position.unrealizedPnL}, currentPrice=${position.currentPrice}`);

        // Broadcast real-time position update for dashboard
        await messageBus.publish(CHANNELS.POSITION_REALTIME_UPDATE, {
          positionId: position.id,
          accountId: position.accountId,
          symbol: position.symbol,
          netPos: position.netPos,
          currentPrice: position.currentPrice,
          entryPrice: position.netPrice,
          unrealizedPnL: position.unrealizedPnL,
          realizedPnL: position.realizedPnL || 0,
          side: position.netPos > 0 ? 'long' : 'short',
          lastUpdate: position.lastUpdate,
          marketData: { price: currentPrice, timestamp: message.timestamp, source: message.source },
          source: 'realtime_price_update'
        });
      }
    }

    // Broadcast real-time updates for pending orders with matching base symbol
    for (const order of tradingState.workingOrders.values()) {
      const orderBaseSymbol = getBaseSymbol(order.symbol);
      if (orderBaseSymbol === baseSymbol) {
        // Calculate market distance for this order
        const calculateMarketDistance = (orderPrice, currentPrice, isLong) => {
          if (!orderPrice || !currentPrice) return null;
          const distance = orderPrice - currentPrice;
          const percentage = (distance / currentPrice) * 100;
          const pointsAway = Math.abs(distance);
          const direction = distance > 0 ? 'above' : 'below';

          return {
            points: pointsAway,
            percentage: Math.abs(percentage),
            direction,
            needsToMove: isLong ? (distance > 0 ? 'down' : 'filled') : (distance < 0 ? 'up' : 'filled')
          };
        };

        const marketDistance = order.price ? calculateMarketDistance(order.price, currentPrice, order.action === 'Buy') : null;

        // Get signal context for this order
        let signalContext = null;
        if (order.signalId) {
          signalContext = tradingState.signalContext.get(order.signalId);
        }

        // Broadcast real-time order update for dashboard
        await messageBus.publish(CHANNELS.ORDER_REALTIME_UPDATE, {
          orderId: order.id,
          symbol: order.symbol,
          baseSymbol: orderBaseSymbol,
          action: order.action,
          quantity: order.quantity,
          orderType: order.orderType,
          price: order.price,
          orderStatus: order.orderStatus,
          currentPrice,
          marketDistance,
          marketData: { price: currentPrice, timestamp: message.timestamp, source: message.source },
          signalContext,
          lastUpdate: new Date().toISOString(),
          source: 'realtime_price_update'
        });

        logger.debug(`📋 Broadcast real-time order update: ${order.symbol} ${order.action} @ ${order.price}, market: ${currentPrice}`);
      }
    }

    // Only log and update stats if we actually used this price update
    if (hasPositions) {
      logger.debug(`📈 Price update used: ${baseSymbol} = ${currentPrice}`);

      // Note: Daily P&L should come from Tradovate account data, not unrealized P&L
    }

  } catch (error) {
    logger.error('Failed to handle price update:', error.message);
  }
}

// Handle Tradovate sync completion to reconcile pending orders
async function handleTradovateSyncCompleted(message) {
  try {
    // Handle both old and new field names for compatibility
    const workingOrderIds = message.validWorkingOrderIds || message.workingOrderIds || [];
    logger.info(`🔄 Tradovate sync completed with ${workingOrderIds.length} working orders from source: ${message.source}`);

    // Get current pending order IDs from our state
    const currentPendingOrderIds = new Set(tradingState.workingOrders.keys());
    const tradovateWorkingOrderIds = new Set(workingOrderIds);

    // Find orders that are no longer working in Tradovate but still in our state
    const staleOrderIds = [...currentPendingOrderIds].filter(orderId => !tradovateWorkingOrderIds.has(orderId));

    if (staleOrderIds.length > 0) {
      logger.info(`🧹 Found ${staleOrderIds.length} stale pending orders to remove: ${staleOrderIds.join(', ')}`);

      // Remove stale orders from working orders
      for (const orderId of staleOrderIds) {
        const order = tradingState.workingOrders.get(orderId);
        if (order) {
          logger.info(`🗑️ Removing stale order: ${orderId} (${order.symbol} ${order.action})`);
          tradingState.workingOrders.delete(orderId);
        }
      }

      // Update statistics
      tradingState.stats.totalWorkingOrders = tradingState.workingOrders.size;

      logger.info(`✅ Cleaned up ${staleOrderIds.length} stale orders. Current working orders: ${tradingState.stats.totalWorkingOrders}`);
    } else {
      logger.info('✅ No stale orders found - pending orders state is synchronized');
    }

  } catch (error) {
    logger.error('Failed to handle Tradovate sync completion:', error.message);
  }
}

// Handle full sync start - clear working orders to prepare for ground truth
async function handleFullSyncStarted(message) {
  const previousCount = tradingState.workingOrders.size;
  const previousSignalCount = tradingState.signalContext.size;
  const previousPositionCount = tradingState.tradingPositions.size;

  tradingState.workingOrders.clear();
  tradingState.signalContext.clear();
  tradingState.tradingPositions.clear();
  tradingState.stats.totalWorkingOrders = 0;
  tradingState.stats.totalPositions = 0;

  // Clear Redis signal context data too
  await saveSignalContext(); // This saves empty signalContext to Redis, effectively clearing it

  logger.info(`🔄 Full sync started - cleared ${previousCount} working orders, ${previousSignalCount} signal contexts, and ${previousPositionCount} positions to prepare for ground truth from broker`);
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

      // Note: Daily P&L should come from Tradovate account data, not unrealized P&L

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

// Reconcile local position state with Tradovate authoritative data
async function reconcilePositions() {
  try {
    logger.info('🔄 Starting position reconciliation with Tradovate...');

    // Request current position sync from tradovate-service
    await messageBus.publish(CHANNELS.POSITION_SYNC_REQUEST, {
      requestedBy: 'trade-orchestrator',
      reason: 'position_reconciliation',
      timestamp: new Date().toISOString()
    });

    // Track positions before reconciliation
    const positionsBeforeSync = Array.from(tradingState.tradingPositions.keys());
    logger.info(`📊 Local positions before sync: [${positionsBeforeSync.join(', ')}]`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('⚠️ Position reconciliation timeout after 10 seconds');
        resolve(false);
      }, 10000);

      // Listen for sync completion
      const cleanup = messageBus.subscribe(CHANNELS.TRADOVATE_SYNC_COMPLETED, (message) => {
        if (message.requestedBy === 'trade-orchestrator' && message.reason === 'position_reconciliation') {
          clearTimeout(timeout);

          // Cleanup subscription
          if (typeof cleanup === 'function') {
            cleanup();
          }

          const positionsAfterSync = Array.from(tradingState.tradingPositions.keys());
          logger.info(`📊 Local positions after sync: [${positionsAfterSync.join(', ')}]`);
          logger.info(`✅ Position reconciliation completed in ${Date.now() - Date.parse(message.timestamp)}ms`);
          resolve(true);
        }
      });
    });
  } catch (error) {
    logger.error('❌ Position reconciliation failed:', error);
    return false;
  }
}

// Perform initial sync by requesting current state from monitoring service
async function performInitialSync() {
  try {
    // The monitoring service has the most recent state from tradovate-service
    const monitoringBaseUrl = process.env.MONITORING_SERVICE_URL || 'http://localhost:3014';

    logger.info('📡 Fetching current trading state from monitoring service...');

    // Clear existing state before sync to avoid stale data
    logger.info('🧹 Clearing existing state before sync...');
    tradingState.workingOrders.clear();
    tradingState.tradingPositions.clear();
    tradingState.orderRelationships.clear();

    // Get current dashboard data which includes positions and orders
    const response = await fetch(`${monitoringBaseUrl}/api/dashboard`, {
      headers: {
        'Authorization': `Bearer ${process.env.DASHBOARD_SECRET}`
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch dashboard: ${response.status} ${response.statusText}`);
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
        // Try to find signal context for this order by looking through saved signal contexts
        let signalId = null;
        const orderId = orderData.id || orderData.orderId;

        // First, check if we have direct signal mapping from SignalRegistry
        signalId = signalRegistry.findSignalForOrder(orderId);

        // Fallback: check if this order can be matched to a signal by symbol/price/time
        if (!signalId) {
          for (const [contextSignalId, contextData] of tradingState.signalContext.entries()) {
            if (contextData.symbol === orderData.symbol &&
                Math.abs(contextData.price - orderData.price) < 10) {
              signalId = contextSignalId;
              logger.info(`🔄 Sync: Matched order ${orderId} to signal ${signalId} via symbol/price match`);
              break;
            }
          }
        }

        const orderMessage = {
          orderId: orderId,
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
          source: 'startup_sync',
          signalId: signalId  // Include signal ID if found
        };

        await handleOrderPlaced(orderMessage);

        // If we found a signal context, link the order to it
        if (signalId) {
          signalRegistry.linkOrderToSignal(orderId, signalId, orderData.orderRole || 'entry');
          logger.info(`🔗 Sync: Linked restored order ${orderId} to signal ${signalId}`);
        } else {
          logger.warn(`⚠️ Sync: No signal context found for order ${orderId} - this may cause dashboard filtering issues`);
        }
      }
    }

    // Link orders to positions now that we have both
    for (const position of tradingState.tradingPositions.values()) {
      await linkAssociatedOrders(position);
    }

    // CRITICAL FIX: Check for orders that should be hidden because corresponding positions exist
    // This handles the case where an order filled immediately but sync restored it as working
    const orderIdsToRemoveFromWorking = [];
    for (const [orderId, order] of tradingState.workingOrders.entries()) {
      // Check if there's a position for this symbol
      const position = tradingState.tradingPositions.get(order.symbol);
      if (position && order.signalId) {
        // Check if this order and position are from the same signal
        const orderSignalContext = tradingState.signalContext.get(order.signalId);
        if (orderSignalContext && position.signalContext &&
            orderSignalContext.signalId === position.signalContext.signalId) {

          // This order was actually filled and created the position
          logger.info(`🔧 Sync Fix: Order ${orderId} actually filled and created position ${order.symbol} - marking as filled`);

          // Create the order relationship to mark this as a filled entry order
          tradingState.orderRelationships.set(orderId, {
            orderRole: 'entry',
            positionSymbol: order.symbol,
            signalId: order.signalId
          });

          // Remove from working orders since it's actually filled
          orderIdsToRemoveFromWorking.push(orderId);

          // Register in signal registry if not already done
          signalRegistry.linkPositionToSignal(order.signalId, order.symbol, orderId);

          logger.info(`✅ Sync Fix: Properly linked filled order ${orderId} to position ${order.symbol}`);
        }
      }
    }

    // Remove the filled orders from working orders
    for (const orderId of orderIdsToRemoveFromWorking) {
      tradingState.workingOrders.delete(orderId);
    }

    if (orderIdsToRemoveFromWorking.length > 0) {
      logger.info(`🧹 Sync Fix: Removed ${orderIdsToRemoveFromWorking.length} actually-filled orders from working orders`);
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

    // Load configuration from Redis
    logger.info('Loading configuration from Redis...');
    tradingState.contractMappings = await loadContractMappings();
    logger.info('Configuration loaded from Redis');

    // Load persisted signal context
    await loadSignalContext();
    await loadOrderStrategyMapping();

    // Load SignalRegistry persistence data
    await signalRegistry.loadMappings();
    await signalRegistry.loadLifecycles();

    // Subscribe to relevant channels
    await messageBus.subscribe(CHANNELS.WEBHOOK_RECEIVED, handleWebhookReceived);
    await messageBus.subscribe(CHANNELS.ORDER_PLACED, handleOrderPlaced);
    await messageBus.subscribe(CHANNELS.ORDER_FILLED, handleOrderFilled);
    await messageBus.subscribe(CHANNELS.ORDER_REJECTED, handleOrderRejected);
    await messageBus.subscribe(CHANNELS.ORDER_CANCELLED, handleOrderCancelled);
    await messageBus.subscribe(CHANNELS.POSITION_UPDATE, handlePositionUpdate);
    await messageBus.subscribe(CHANNELS.POSITION_CLOSED, handlePositionClosed);
    await messageBus.subscribe(CHANNELS.PRICE_UPDATE, handlePriceUpdate);
    await messageBus.subscribe(CHANNELS.TRADOVATE_SYNC_COMPLETED, handleTradovateSyncCompleted);
    await messageBus.subscribe(CHANNELS.TRADOVATE_FULL_SYNC_STARTED, handleFullSyncStarted);
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

    // Start Express server - bind to all interfaces for container networking
    const bindHost = process.env.BIND_HOST || '0.0.0.0';
    const server = app.listen(config.service.port, bindHost, () => {
      logger.info(`${SERVICE_NAME} listening on ${bindHost}:${config.service.port}`);
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