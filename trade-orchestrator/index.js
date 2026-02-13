import express from 'express';
import axios from 'axios';
// File system imports removed - using Redis for persistence
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';
import { evaluateCrossStrategyRules, getCrossStrategyRules } from './cross-strategy-filter.js';

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
    if (!messageBus.isConnected) {
      logger.warn('Redis disconnected, skipping saveSignalContext operation');
      return;
    }

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
    if (!messageBus.isConnected) {
      logger.warn('Redis disconnected, skipping loadSignalContext operation');
      return;
    }

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
    if (!messageBus.isConnected) {
      logger.warn('Redis disconnected, skipping saveOrderStrategyMapping operation');
      return;
    }

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
    if (!messageBus.isConnected) {
      logger.warn('Redis disconnected, skipping loadOrderStrategyMapping operation');
      return;
    }

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

// Multi-strategy state persistence functions
async function saveStrategyState() {
  try {
    if (!messageBus.isConnected) {
      logger.warn('Redis disconnected, skipping saveStrategyState operation');
      return;
    }

    // Convert Maps to objects for JSON serialization
    const positionsData = {};
    for (const [underlying, posInfo] of tradingState.strategyState.positions) {
      positionsData[underlying] = posInfo;
    }

    const pendingOrdersData = {};
    for (const [orderId, orderInfo] of tradingState.strategyState.pendingOrders) {
      pendingOrdersData[orderId] = orderInfo;
    }

    const dataToSave = {
      positions: positionsData,
      pendingOrders: pendingOrdersData,
      timestamp: new Date().toISOString(),
      version: '2.0'
    };

    await messageBus.publisher.set('multi-strategy:state', JSON.stringify(dataToSave));
    const posSummary = Array.from(tradingState.strategyState.positions.entries()).map(([u, p]) => `${u}:${p.position}(${p.source})`).join(', ') || 'flat';
    logger.info(`💾 Multi-strategy state saved to Redis: [${posSummary}], ${tradingState.strategyState.pendingOrders.size} pending orders`);
  } catch (error) {
    logger.error('❌ Failed to save multi-strategy state to Redis:', error);
  }
}

async function loadStrategyState() {
  try {
    if (!messageBus.isConnected) {
      logger.warn('Redis disconnected, skipping loadStrategyState operation');
      return;
    }

    const data = await messageBus.publisher.get('multi-strategy:state');
    if (data) {
      const parsedData = JSON.parse(data);

      // Restore positions Map
      tradingState.strategyState.positions.clear();
      if (parsedData.version === '2.0' && parsedData.positions) {
        // v2.0 format: per-underlying positions map
        for (const [underlying, posInfo] of Object.entries(parsedData.positions)) {
          tradingState.strategyState.positions.set(underlying, posInfo);
        }
      } else if (parsedData.position && parsedData.position !== 'flat') {
        // v1.0 backward compat: migrate single global position
        logger.warn(`🔄 Migrating v1 strategy state: position=${parsedData.position}, source=${parsedData.positionSource} — will be corrected by reconciliation`);
        // Don't migrate — let reconciliation set the correct per-underlying state on next sync
      }

      // Restore pending orders Map
      tradingState.strategyState.pendingOrders.clear();
      if (parsedData.pendingOrders) {
        for (const [orderId, orderInfo] of Object.entries(parsedData.pendingOrders)) {
          tradingState.strategyState.pendingOrders.set(orderId, orderInfo);
        }
      }

      const posSummary = Array.from(tradingState.strategyState.positions.entries()).map(([u, p]) => `${u}:${p.position}(${p.source})`).join(', ') || 'flat';
      logger.info(`🔄 Loaded multi-strategy state from Redis: [${posSummary}], pending=${tradingState.strategyState.pendingOrders.size} (saved: ${parsedData.timestamp})`);
    } else {
      logger.info('📂 No existing multi-strategy state found in Redis, starting fresh');
    }
  } catch (error) {
    logger.error('❌ Failed to load multi-strategy state from Redis:', error);
  }
}

// Contract mappings Redis functions
async function loadContractMappings() {
  try {
    if (!messageBus.isConnected) {
      logger.warn('Redis disconnected, skipping loadContractMappings operation');
      // Return defaults when Redis is unavailable
      return {
        lastUpdated: new Date().toISOString(),
        currentContracts: {
          'NQ': 'NQH6',
          'MNQ': 'MNQH6',
          'ES': 'ESH6',
          'MES': 'MESH6'
        }
      };
    }

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
    notes: 'March 2026 contract mappings - stored in Redis for rollover updates'
  };

  // Save defaults to Redis
  try {
    if (!messageBus.isConnected) {
      logger.warn('Redis disconnected, skipping save of default contract mappings');
    } else {
      await messageBus.publisher.set('contracts:mappings', JSON.stringify(defaults));
      logger.info('✅ Default contract mappings saved to Redis');
    }
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
    // Ensure orderId is a string for consistent Map key format
    const orderIdStr = String(orderId);

    // Add order to signal's order set
    if (!this.signalToOrders.has(signalId)) {
      this.signalToOrders.set(signalId, new Set());
    }
    this.signalToOrders.get(signalId).add(orderIdStr);

    // Create reverse mapping (using string key)
    this.orderToSignal.set(orderIdStr, signalId);

    // Log lifecycle event
    this.addLifecycleEvent(signalId, 'order_linked', {
      orderId: orderIdStr,
      orderRole,
      timestamp: new Date().toISOString()
    });

    logger.info(`🔗 Order ${orderIdStr} linked to signal ${signalId} (role: ${orderRole})`);
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
    // Ensure orderId is a string for consistent Map key format
    return this.orderToSignal.get(String(orderId));
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
      if (!messageBus.isConnected) {
        logger.warn('Redis disconnected, skipping saveMappings operation');
        return;
      }

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
      if (!messageBus.isConnected) {
        logger.warn('Redis disconnected, skipping saveLifecycles operation');
        return;
      }

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
      if (!messageBus.isConnected) {
        logger.warn('Redis disconnected, skipping loadMappings operation');
        return;
      }

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
            // Ensure orderId is stored as string for consistent lookups
            this.orderToSignal.set(String(orderId), signalId);
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
      if (!messageBus.isConnected) {
        logger.warn('Redis disconnected, skipping loadLifecycles operation');
        return;
      }

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

  // Get strategy information for an order using signal context
  getOrderStrategy(orderId) {
    // Convert orderId to string to ensure consistent Map key format
    const orderIdStr = String(orderId);
    const signalId = this.orderToSignal.get(orderIdStr);

    logger.info(`🔍 [SignalRegistry] Looking up strategy for order ${orderIdStr}: found signalId=${signalId}, mappings loaded=${this.orderToSignal.size}`);

    if (!signalId) {
      return 'UNKNOWN';
    }

    const lifecycle = this.signalLifecycles.get(signalId);
    if (!lifecycle || !Array.isArray(lifecycle)) {
      logger.info(`🔍 [SignalRegistry] No lifecycle found for signal ${signalId}`);
      return 'UNKNOWN';
    }

    // Find the signal_received event which contains the original signal data
    const signalEvent = lifecycle.find(event => event.event === 'signal_received');
    if (!signalEvent || !signalEvent.data) {
      logger.info(`🔍 [SignalRegistry] No signal_received event found in lifecycle for signal ${signalId}`);
      return 'UNKNOWN';
    }

    // Strategy could be in data.strategy (direct) or data.originalSignal.strategy (nested)
    const strategy = signalEvent.data.strategy ||
                    (signalEvent.data.originalSignal && signalEvent.data.originalSignal.strategy) ||
                    'UNKNOWN';
    logger.info(`🔍 [SignalRegistry] Found strategy ${strategy} for order ${orderIdStr} via signal ${signalId}`);
    return strategy;
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

  // Filled Entry Orders: Store filled entry orders for price recovery
  // Key: orderId, Value: { id, symbol, fillPrice, price, quantity, timestamp, signalId }
  filledEntryOrders: new Map(),

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
  },

  // Multi-strategy state tracking (per-underlying: NQ, ES, etc.)
  strategyState: {
    positions: new Map(), // underlying (e.g., 'NQ') -> { position: 'long'|'short', source: strategyName }
    pendingOrders: new Map() // orderId -> { strategy, direction, price, createdAt, symbol }
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
 * Normalize any symbol to its underlying product (NQ or ES)
 * NQ, MNQ, NQH6, MNQH6 → 'NQ'
 * ES, MES, ESH6, MESH6 → 'ES'
 */
function getUnderlyingSymbol(symbol) {
  const base = parseBaseSymbol(symbol);
  // MNQ → NQ, MES → ES
  if (base.startsWith('M')) {
    return base.substring(1);
  }
  return base;
}

/**
 * Check if tradingPositions Map has any entry matching the given underlying
 * tradingPositions is keyed by contract symbol (e.g., 'MNQH6')
 */
function hasPositionForUnderlying(underlying) {
  for (const [symbol] of tradingState.tradingPositions) {
    if (getUnderlyingSymbol(symbol) === underlying) {
      return true;
    }
  }
  return false;
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
//   symbol: 'MNQH6',
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
    stats: tradingState.stats,
    crossStrategyFilter: {
      enabled: process.env.CROSS_STRATEGY_FILTER_ENABLED !== 'false',
      rules: getCrossStrategyRules(),
    }
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

    // BRACKET ORDER DETECTION: Identify orphaned bracket orders
    // These are Stop/Limit orders that belong to existing positions but weren't linked
    const matchingPosition = positions.find(pos => pos.symbol === order.symbol);
    if (matchingPosition && (order.orderType === 'Stop' || order.orderType === 'StopLimit' || order.orderType === 'Limit')) {
      // Check if this is a bracket order based on direction
      const isLongPosition = matchingPosition.netPos > 0;
      const isSellOrder = order.action === 'Sell';
      const isBuyOrder = order.action === 'Buy';

      // For long positions: Sell orders are exits (stop/target)
      // For short positions: Buy orders are exits (stop/target)
      const isBracketOrder = (isLongPosition && isSellOrder) || (!isLongPosition && isBuyOrder);

      if (isBracketOrder && !order.signalId) {
        // This is an orphaned bracket order - link it now
        const orderRole = order.orderType === 'Stop' || order.orderType === 'StopLimit' ? 'stop_loss' : 'take_profit';
        tradingState.orderRelationships.set(order.id, {
          orderRole: orderRole,
          positionSymbol: matchingPosition.symbol,
          linkedAt: new Date().toISOString(),
          linkMethod: 'orphan_detection'
        });
        logger.info(`🔗 Auto-linked orphaned bracket order ${order.id} (${orderRole}) to position ${matchingPosition.symbol}`);
        return false; // Hide it
      }
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
      price: order.orderType === 'Stop' || order.orderType === 'StopLimit' ? order.stopPrice : order.price,

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
    // Generate signal ID if missing - critical for strategy→order→position tracking
    if (!message.id) {
      message.id = `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    logger.info('Processing webhook signal:', message.id || message.strategy);

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
    // Handle both webhook format (message.body) and direct signal format (from siggen-nq-ivskew)
    const signalBody = message.body || message;
    const signal = parseTradeSignal(signalBody);
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

    // Cross-strategy filter
    const signalUnderlying = getUnderlyingSymbol(signal.symbol);
    const signalDirection = (signal.side === 'buy' || signal.side === 'long') ? 'long' : 'short';
    const crossFilterResult = evaluateCrossStrategyRules(
      signal, signalUnderlying, signalDirection,
      tradingState.strategyState.positions
    );

    if (!crossFilterResult.allowed) {
      logger.warn(`[CROSS-FILTER] Signal rejected: ${crossFilterResult.reason}`);
      await messageBus.publish(CHANNELS.TRADE_REJECTED, {
        reason: crossFilterResult.reason,
        filter: 'cross_strategy',
        ruleName: crossFilterResult.ruleName,
        signal: { strategy: signal.strategy, symbol: signal.symbol, side: signal.side, action: signal.action, price: signal.price },
        crossStrategyState: Object.fromEntries(tradingState.strategyState.positions),
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

    // Apply cross-strategy quantity adjustment if applicable
    if (crossFilterResult.adjustments?.quantityMultiplier) {
      const originalQty = positionSizing.quantity;
      positionSizing.quantity = Math.round(positionSizing.quantity * crossFilterResult.adjustments.quantityMultiplier);
      logger.info(`[CROSS-FILTER] Quantity adjusted: ${originalQty} → ${positionSizing.quantity} (x${crossFilterResult.adjustments.quantityMultiplier}, rule: ${crossFilterResult.ruleName})`);
    }

    // Special handling for direct tradovate service actions (position_closed, cancel_limit, update_limit, modify_stop)
    if (signal.action === 'position_closed' || signal.action === 'cancel_limit' || signal.action === 'update_limit' || signal.action === 'modify_stop') {
      const actionType = signal.action === 'update_limit' ? 'order update' :
                        signal.action === 'modify_stop' ? 'stop modification' : 'position liquidation';
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
      } else if (signal.action === 'position_closed') {
        // For position_closed only
        routeMessage = {
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
      } else if (signal.action === 'cancel_limit') {
        // For cancel_limit, route directly to tradovate-service webhook handler
        logger.info(`🎯 Routing cancel_limit for strategy ${signal.strategy} to working cancellation handler`);

        routeMessage = {
          id: message.id,
          body: {
            action: signal.action,
            symbol: positionSizing.symbol, // Use converted symbol from position sizing
            side: signal.side,
            strategy: signal.strategy,
            reason: signal.reason || 'strategy_request',
            quantity: signal.quantity,
            accountId: signal.accountId || getDefaultAccountId(),
            timestamp: new Date().toISOString()
          }
        };
      } else if (signal.action === 'modify_stop') {
        // For modify_stop, route directly to tradovate-service for stop loss modification
        logger.info(`🎯 Routing modify_stop for strategy ${signal.strategy}: new stop = ${signal.new_stop_price}`);

        routeMessage = {
          id: message.id,
          type: 'trade_signal',
          body: {
            action: 'modify_stop',
            symbol: positionSizing.symbol, // Use converted symbol
            strategy: signal.strategy,
            new_stop_price: signal.new_stop_price,
            order_strategy_id: signal.order_strategy_id,
            order_id: signal.order_id,
            reason: signal.reason || 'breakeven_triggered',
            accountId: signal.accountId || getDefaultAccountId(),
            timestamp: new Date().toISOString()
          }
        };
      }

      // Route directly to tradovate service webhook handler
      await messageBus.publish(CHANNELS.WEBHOOK_TRADE, routeMessage);

      if (signal.action === 'update_limit') {
        logger.info(`Order update signal routed to tradovate-service: ${positionSizing.symbol} ${signal.old_price} → ${signal.new_price}`);
      } else if (signal.action === 'modify_stop') {
        logger.info(`Stop modification signal routed to tradovate-service: ${positionSizing.symbol} new stop = ${signal.new_stop_price}`);
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
      // Support both conventions: 'buy'/'sell' and 'long'/'short'
      mappedAction = (signal.side === 'buy' || signal.side === 'long') ? 'Buy' : 'Sell';
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

      // Multi-strategy position check - per-underlying (NQ, ES trade independently)
      const strategy = signal.strategy || 'UNKNOWN';
      const signalUnderlying = getUnderlyingSymbol(positionSizing.symbol);

      // Check if already in a filled position for THIS underlying
      const existingPos = tradingState.strategyState.positions.get(signalUnderlying);

      // Also check if there's already a pending order for this underlying
      let existingPending = null;
      for (const [, orderInfo] of tradingState.strategyState.pendingOrders) {
        if (getUnderlyingSymbol(orderInfo.symbol) === signalUnderlying) {
          existingPending = orderInfo;
          break;
        }
      }

      if (existingPos) {
        logger.warn(`📊 [${strategy}] Signal skipped - ${signalUnderlying} already in ${existingPos.position} position from ${existingPos.source}`);
        logger.warn(`📊 Signal attempted: ${mappedAction} ${positionSizing.quantity} ${positionSizing.symbol} @ ${mappedPrice}`);

        await messageBus.publish(CHANNELS.TRADE_REJECTED, {
          reason: `${signalUnderlying} already in ${existingPos.position} position from ${existingPos.source} strategy`,
          currentPosition: {
            underlying: signalUnderlying,
            state: existingPos.position,
            source: existingPos.source
          },
          rejectedSignal: {
            strategy: strategy,
            symbol: positionSizing.symbol,
            action: mappedAction,
            quantity: positionSizing.quantity,
            price: mappedPrice
          },
          originalSignal: message,
          timestamp: new Date().toISOString()
        });

        return; // Exit early - already in position for this underlying
      }

      if (existingPending) {
        logger.warn(`📊 [${strategy}] Signal skipped - ${signalUnderlying} already has pending ${existingPending.direction} order from ${existingPending.strategy}`);
        logger.warn(`📊 Signal attempted: ${mappedAction} ${positionSizing.quantity} ${positionSizing.symbol} @ ${mappedPrice}`);

        await messageBus.publish(CHANNELS.TRADE_REJECTED, {
          reason: `${signalUnderlying} already has pending ${existingPending.direction} order from ${existingPending.strategy} strategy`,
          pendingOrder: {
            underlying: signalUnderlying,
            direction: existingPending.direction,
            source: existingPending.strategy,
            symbol: existingPending.symbol
          },
          rejectedSignal: {
            strategy: strategy,
            symbol: positionSizing.symbol,
            action: mappedAction,
            quantity: positionSizing.quantity,
            price: mappedPrice
          },
          originalSignal: message,
          timestamp: new Date().toISOString()
        });

        return; // Exit early - already has pending order for this underlying
      }

      logger.info(`✅ [${strategy}] Position validation passed: ${signalUnderlying} is flat with no pending orders, allowing ${mappedAction} order`);
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
      strategy: signal.strategy, // CRITICAL: Include strategy for multi-strategy support
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
      // Breakeven stop configuration
      breakevenTrigger: signal.breakeven_trigger,
      breakevenOffset: signal.breakeven_offset,
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

    const strategy = signal.strategy || 'UNKNOWN';
    const pendingCount = tradingState.strategyState.pendingOrders.size;
    logger.info(`[${strategy}] Trade signal processed and order requested: ${positionSizing.symbol} ${signal.action} ${positionSizing.quantity} (${pendingCount} pending orders across all strategies)`);
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
    if (body.symbol && (body.side || body.action === 'place_limit' || body.action === 'update_limit' || body.action === 'cancel_limit' || body.action === 'position_closed' || body.action === 'modify_stop')) {
      return {
        symbol: body.symbol,
        action: body.action, // Preserve original action (e.g., 'place_limit', 'update_limit', 'modify_stop')
        side: body.side, // Preserve side for bracket order mapping
        orderType: body.type || 'Market',
        price: body.price,
        old_price: body.old_price, // For update_limit actions
        new_price: body.new_price, // For update_limit actions
        new_stop_price: body.new_stop_price, // For modify_stop actions
        order_strategy_id: body.order_strategy_id, // For modify_stop actions
        order_id: body.order_id, // For modify_stop actions
        stop_loss: body.stop_loss, // Preserve for bracket orders
        take_profit: body.take_profit, // Preserve for bracket orders
        stopPrice: body.stop_price,
        quantity: body.quantity,
        accountId: body.accountId || body.account,
        trailing_trigger: body.trailing_trigger,
        trailing_offset: body.trailing_offset,
        strategy: body.strategy, // Preserve strategy field
        reason: body.reason, // For cancel_limit and modify_stop actions
        breakeven_trigger: body.breakeven_trigger,
        breakeven_offset: body.breakeven_offset
      };
    }

    // Format 3: Custom format (legacy)
    // Support both conventions: 'buy'/'sell' and 'long'/'short'
    if (body.symbol && body.side && !body.action) {
      return {
        symbol: body.symbol,
        action: (body.side === 'long' || body.side === 'buy') ? 'Buy' : 'Sell',
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

  // Skip position limit checks for non-order actions (cancel, modify, close)
  if (signal.action === 'modify_stop' || signal.action === 'cancel_limit' || signal.action === 'position_closed') {
    return { valid: true };
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

// Get base symbol for price lookup (e.g., MNQH6 -> MNQ)
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

// Normalize micro and standard contracts to the same underlying for price matching.
// Position sizing may convert ES→MES or NQ→MNQ, but price updates arrive as ES/NQ
// from TradingView. Both need to match for P&L and breakeven calculations.
function getPriceSymbol(baseSymbol) {
  const microToStandard = { 'MNQ': 'NQ', 'MES': 'ES', 'M2K': 'RTY' };
  return microToStandard[baseSymbol] || baseSymbol;
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

  // Track pending order for multi-strategy management (only for entry orders)
  if (!message.orderRole || message.orderRole === 'entry') {
    // Extract strategy from signal context - try multiple sources
    let strategy = 'UNKNOWN';
    let strategySource = 'none';

    // First try: Current signal context (for new signals)
    if (message.signalId && tradingState.signalContext.has(message.signalId)) {
      const signalContext = tradingState.signalContext.get(message.signalId);
      strategy = signalContext.strategy || 'UNKNOWN';
      strategySource = 'signal_context';
    }

    // Second try: SignalRegistry lifecycle data (for restored orders)
    if (strategy === 'UNKNOWN') {
      strategy = signalRegistry.getOrderStrategy(String(message.orderId));
      if (strategy !== 'UNKNOWN') {
        strategySource = 'signal_registry';
      }
    }

    logger.info(`🔍 [${strategy}] Strategy extracted from ${strategySource} for order ${message.orderId}`);

    // Determine direction from action
    const direction = message.action === 'Buy' ? 'long' : 'short';

    // Add to pending orders for multi-strategy tracking
    tradingState.strategyState.pendingOrders.set(message.orderId, {
      strategy: strategy,
      direction: direction,
      symbol: message.symbol,
      price: message.price,
      quantity: message.quantity,
      createdAt: new Date().toISOString()
    });

    logger.info(`📌 [${strategy}] Added pending ${direction} order ${message.orderId} to multi-strategy tracking (total pending: ${tradingState.strategyState.pendingOrders.size})`);

    // Save strategy state to Redis
    await saveStrategyState();
  }

  // Link order to signal in SignalRegistry
  if (message.signalId) {
    signalRegistry.linkOrderToSignal(message.orderId, message.signalId, message.orderRole || 'entry');
    // Save the updated mappings to Redis immediately after linking
    await signalRegistry.saveMappings();
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

    // Multi-strategy: Cancel other pending entry orders for the SAME underlying when an order fills
    const filledOrderInfo = tradingState.strategyState.pendingOrders.get(message.orderId);
    if (filledOrderInfo) {
      const filledStrategy = filledOrderInfo.strategy;
      const filledDirection = filledOrderInfo.direction;
      const filledUnderlying = getUnderlyingSymbol(filledOrderInfo.symbol);

      // Update strategy state - set position for this underlying
      tradingState.strategyState.positions.set(filledUnderlying, {
        position: filledDirection,
        source: filledStrategy
      });

      // Get list of other pending orders for the SAME underlying to cancel
      const ordersToCancel = [];
      const ordersToKeep = [];
      for (const [orderId, orderInfo] of tradingState.strategyState.pendingOrders) {
        if (orderId === message.orderId) continue;
        const orderUnderlying = getUnderlyingSymbol(orderInfo.symbol);
        if (orderUnderlying === filledUnderlying) {
          ordersToCancel.push({ orderId, ...orderInfo });
        } else {
          ordersToKeep.push(orderId);
        }
      }

      if (ordersToCancel.length > 0) {
        logger.info(`🎯 [${filledStrategy}] Order filled for ${filledUnderlying} - cancelling ${ordersToCancel.length} other pending ${filledUnderlying} orders`);

        // Send cancel requests for each order
        for (const orderToCancel of ordersToCancel) {
          logger.info(`❌ Cancelling ${orderToCancel.strategy} ${orderToCancel.direction} order ${orderToCancel.orderId} (${filledUnderlying})`);

          // Publish cancel request to tradovate-service
          await messageBus.publish(CHANNELS.ORDER_CANCEL_REQUEST, {
            orderId: orderToCancel.orderId,
            reason: `${filledStrategy} order filled first for ${filledUnderlying}`,
            filledOrderId: message.orderId,
            timestamp: new Date().toISOString()
          });
        }
      }

      // Remove the filled order and cancelled orders, keep orders for other underlyings
      tradingState.strategyState.pendingOrders.delete(message.orderId);
      for (const order of ordersToCancel) {
        tradingState.strategyState.pendingOrders.delete(order.orderId);
      }

      // Save updated strategy state to Redis
      await saveStrategyState();

      const posSummary = Array.from(tradingState.strategyState.positions.entries()).map(([u, p]) => `${u}:${p.position}(${p.source})`).join(', ');
      logger.info(`📊 Multi-strategy state updated: [${posSummary}], pending=${tradingState.strategyState.pendingOrders.size}`);
    } else {
      logger.warn(`⚠️ Filled order ${message.orderId} not found in pending orders tracking`);
    }
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

  // Multi-strategy: Remove from pending orders tracking
  if (tradingState.strategyState.pendingOrders.has(message.orderId)) {
    const cancelledOrderInfo = tradingState.strategyState.pendingOrders.get(message.orderId);
    tradingState.strategyState.pendingOrders.delete(message.orderId);

    logger.info(`🧹 [${cancelledOrderInfo.strategy}] Removed cancelled ${cancelledOrderInfo.direction} order from pending tracking (remaining: ${tradingState.strategyState.pendingOrders.size})`);

    // Save updated strategy state to Redis
    await saveStrategyState();
  }

  // Update statistics
  tradingState.stats.totalWorkingOrders = tradingState.workingOrders.size;

  logger.info(`💼 Working orders after cancellation: ${tradingState.workingOrders.size}`);
}

/**
 * Recover entry price for a position with zero/missing netPrice
 * Checks signal context, order fill history, and existing position data
 */
async function recoverEntryPrice(position) {
  // 1. Check if we already have a valid entry price
  if (position.netPrice && position.netPrice > 0) {
    return position.netPrice;
  }
  if (position.entryPrice && position.entryPrice > 0) {
    return position.entryPrice;
  }

  logger.warn(`🔍 Attempting to recover entry price for position ${position.symbol} (netPos: ${position.netPos})`);

  // 2. Try signal context (most reliable)
  for (const [signalId, signalContext] of tradingState.signalContext.entries()) {
    if ((signalContext.symbol === position.symbol ||
         signalContext.originalSymbol === position.symbol ||
         signalContext.originalSymbol === position.baseSymbol) &&
        signalContext.price) {

      logger.info(`✅ Recovered entry price ${signalContext.price} from signal ${signalId}`);
      return signalContext.price;
    }
  }

  // 3. Try filled entry orders for this symbol
  const filledEntryOrders = Array.from(tradingState.filledEntryOrders.values()).filter(
    order => order.symbol === position.symbol
  );

  if (filledEntryOrders.length > 0) {
    // Use most recent fill
    const mostRecent = filledEntryOrders.sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    )[0];

    if (mostRecent.fillPrice || mostRecent.price) {
      const recoveredPrice = mostRecent.fillPrice || mostRecent.price;
      logger.info(`✅ Recovered entry price ${recoveredPrice} from filled order ${mostRecent.id}`);
      return recoveredPrice;
    }
  }

  // 4. No recovery possible
  logger.error(`❌ Could not recover entry price for ${position.symbol} - position will show $0.00 entry`);
  return 0;
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

  // Multi-strategy: Reset state for this underlying when position is closed
  const closedUnderlying = getUnderlyingSymbol(message.symbol);
  const previousPos = tradingState.strategyState.positions.get(closedUnderlying);
  tradingState.strategyState.positions.delete(closedUnderlying);

  // Remove any pending orders for this underlying (should already be empty, but clean up)
  for (const [orderId, orderInfo] of tradingState.strategyState.pendingOrders) {
    if (getUnderlyingSymbol(orderInfo.symbol) === closedUnderlying) {
      tradingState.strategyState.pendingOrders.delete(orderId);
    }
  }

  // Save updated strategy state to Redis
  await saveStrategyState();

  const posSummary = Array.from(tradingState.strategyState.positions.entries()).map(([u, p]) => `${u}:${p.position}(${p.source})`).join(', ') || 'flat';
  logger.info(`📊 ${closedUnderlying} position closed (was ${previousPos?.source || 'unknown'}). Remaining: [${posSummary}]`);

  // Update statistics
  tradingState.stats.totalPositions = tradingState.tradingPositions.size;
  tradingState.stats.totalWorkingOrders = tradingState.workingOrders.size;
}

// ===== HELPER FUNCTIONS FOR POSITION MANAGEMENT =====

/**
 * Check if breakeven stop should be triggered for a position
 * When position profit reaches breakevenTrigger points, move stop to entry + breakevenOffset
 *
 * @param {Object} position - Trading position object
 * @param {number} currentPrice - Current market price
 */
async function checkBreakevenTrigger(position, currentPrice) {
  // Skip if no breakeven config or already triggered
  if (!position.breakevenConfig || position.breakevenConfig.triggered) {
    return;
  }

  const { trigger, offset, originalStopPrice } = position.breakevenConfig;
  const entryPrice = position.entryPrice || position.netPrice;
  const isLong = position.netPos > 0;

  // Calculate profit in points
  const profitPoints = isLong
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;

  // Check if profit meets trigger threshold
  if (profitPoints >= trigger) {
    // Calculate new stop price: entry + offset (offset is typically negative like -45)
    const newStopPrice = entryPrice + offset;

    logger.info(`🎯 BREAKEVEN TRIGGERED for ${position.symbol}:`);
    logger.info(`   Entry: ${entryPrice}, Current: ${currentPrice}, Profit: ${profitPoints.toFixed(2)} pts`);
    logger.info(`   Trigger threshold: ${trigger} pts, Offset: ${offset}`);
    logger.info(`   Moving stop: ${originalStopPrice} → ${newStopPrice}`);

    // Mark as triggered BEFORE sending signal to prevent duplicate triggers
    position.breakevenConfig.triggered = true;
    position.breakevenConfig.triggeredAt = new Date().toISOString();
    position.breakevenConfig.newStopPrice = newStopPrice;

    // Find the order strategy ID or stop order ID for modification
    let orderStrategyId = null;
    let stopOrderId = null;

    // Check for order strategy ID in signal context
    if (position.signalContext?.orderStrategyId) {
      orderStrategyId = position.signalContext.orderStrategyId;
    }

    // Check working orders for associated stop order
    for (const [orderId, relationship] of tradingState.orderRelationships.entries()) {
      if (relationship.positionSymbol === position.symbol && relationship.orderRole === 'stop_loss') {
        stopOrderId = orderId;
        break;
      }
    }

    // Also check if stop loss order is directly on the position
    if (!stopOrderId && position.stopLossOrder?.orderId) {
      stopOrderId = position.stopLossOrder.orderId;
    }

    // Build the modify_stop signal
    const modifyStopSignal = {
      webhook_type: 'trade_signal',
      action: 'modify_stop',
      strategy: position.strategy || position.signalContext?.strategy || 'IV_SKEW_GEX',
      symbol: position.symbol,
      new_stop_price: newStopPrice,
      reason: 'breakeven_triggered',
      order_strategy_id: orderStrategyId,
      order_id: stopOrderId,
      metadata: {
        entryPrice,
        currentPrice,
        profitPoints,
        trigger,
        offset,
        originalStopPrice
      },
      timestamp: new Date().toISOString()
    };

    try {
      // Publish the modify_stop signal to tradovate-service
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, modifyStopSignal);
      logger.info(`✅ Breakeven stop modification signal sent for ${position.symbol}`);

      // Also publish a notification for monitoring
      await messageBus.publish(CHANNELS.SERVICE_HEALTH, {
        service: 'trade-orchestrator',
        event: 'breakeven_triggered',
        symbol: position.symbol,
        entryPrice,
        currentPrice,
        profitPoints,
        newStopPrice,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error(`❌ Failed to send breakeven stop modification: ${error.message}`);
      // Reset triggered flag so it can retry
      position.breakevenConfig.triggered = false;
      position.breakevenConfig.triggeredAt = null;
    }
  }
}

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
      const closedPosition = { ...existing, netPos: 0 };
      tradingState.tradingPositions.delete(symbol);
      logger.info(`📊 Position closed via fill: ${symbol}`);

      // Broadcast position closure to monitoring service
      await messageBus.publish(CHANNELS.POSITION_UPDATE, {
        symbol: closedPosition.symbol,
        netPos: 0,
        netPrice: closedPosition.netPrice,
        entryPrice: closedPosition.entryPrice,
        currentPrice: fillMessage.fillPrice,
        unrealizedPnL: 0,
        side: 'flat',
        accountId: closedPosition.accountId,
        strategy: closedPosition.strategy,
        timestamp: new Date().toISOString(),
        source: 'position_closed'
      });
      logger.info(`📡 Broadcasted position closure for ${symbol} to monitoring service`);
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

      // Broadcast position update to monitoring service for dashboard
      await messageBus.publish(CHANNELS.POSITION_UPDATE, {
        symbol: existing.symbol,
        netPos: existing.netPos,
        netPrice: existing.netPrice,
        entryPrice: existing.entryPrice,
        currentPrice: existing.currentPrice,
        unrealizedPnL: existing.unrealizedPnL,
        side: existing.side,
        accountId: existing.accountId,
        strategy: existing.strategy,
        timestamp: new Date().toISOString(),
        source: 'order_fill_update'
      });
      logger.info(`📡 Broadcasted position update for ${symbol} to monitoring service`);
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
      // Support both conventions: 'buy'/'sell' and 'long'/'short'
      if (signalContext.side === 'buy' || signalContext.side === 'long') {
        isBuyFill = true;
        logger.info(`📡 Using signal context to determine action: ${signalContext.side} → BUY`);
      } else if (signalContext.side === 'sell' || signalContext.side === 'short') {
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

      // Breakeven stop configuration (from signal)
      breakevenConfig: signalContext?.breakevenTrigger ? {
        trigger: signalContext.breakevenTrigger,       // Points in profit to trigger
        offset: signalContext.breakevenOffset,         // Offset from entry (-45 means entry-45)
        triggered: false,                               // Has breakeven been triggered?
        triggeredAt: null,                             // When was it triggered
        originalStopPrice: signalContext.stopPrice     // Original stop for reference
      } : null,

      // Metadata
      createdAt: fillMessage.timestamp,
      lastUpdate: fillMessage.timestamp,
      strategy: signalContext?.strategy || signalContext?.source || 'unknown',
      riskParams: {}
    };

    tradingState.tradingPositions.set(symbol, newPosition);
    logger.info(`🆕 New position created: ${symbol} = ${quantity} @ ${fillMessage.fillPrice}`);

    // Broadcast position update to monitoring service for dashboard
    await messageBus.publish(CHANNELS.POSITION_UPDATE, {
      symbol: newPosition.symbol,
      netPos: newPosition.netPos,
      netPrice: newPosition.netPrice,
      entryPrice: newPosition.entryPrice,
      currentPrice: newPosition.currentPrice,
      unrealizedPnL: newPosition.unrealizedPnL,
      side: newPosition.side,
      accountId: newPosition.accountId,
      strategy: newPosition.strategy,
      timestamp: new Date().toISOString(),
      source: 'order_fill'
    });
    logger.info(`📡 Broadcasted new position update for ${symbol} to monitoring service`);

    // Store filled entry order for price recovery
    tradingState.filledEntryOrders.set(fillMessage.orderId, {
      id: fillMessage.orderId,
      symbol: symbol,
      fillPrice: fillMessage.fillPrice,
      price: fillMessage.price,
      quantity: fillMessage.quantity,
      timestamp: fillMessage.timestamp || new Date().toISOString(),
      signalId: signalContext?.signalId
    });
    logger.debug(`📝 Stored filled entry order ${fillMessage.orderId} for recovery`);

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
    logger.warn(`⚠️ No signal context - attempting fallback bracket order linking for ${position.symbol}`);

    // FALLBACK: Link by symbol + order strategy + timing
    const orders = Array.from(tradingState.workingOrders.values()).filter(
      order => order.symbol === position.symbol &&
               (order.orderType === 'Stop' || order.orderType === 'Limit')
    );

    for (const order of orders) {
      // Check if order timestamp is close to position timestamp (within 2 minutes)
      const orderTime = new Date(order.timestamp);
      const posTime = position.timestamp ? new Date(position.timestamp) : new Date();
      const timeDiff = Math.abs(posTime - orderTime) / (1000 * 60);

      if (timeDiff < 2) {
        const isBuy = order.action === 'Buy';
        const isPositionLong = position.netPos > 0;

        // Buy order on short position = stop loss
        // Sell order on long position = stop loss
        const isStopOrder = (isBuy && !isPositionLong) || (!isBuy && isPositionLong);

        tradingState.orderRelationships.set(order.id, {
          positionSymbol: position.symbol,
          orderRole: isStopOrder ? 'stop_loss' : 'take_profit',
          linkedAt: new Date().toISOString(),
          linkMethod: 'fallback_timing'
        });

        logger.info(`🔗 Fallback linked ${order.id} as ${isStopOrder ? 'stop' : 'target'} to ${position.symbol}`);
      }
    }
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

  // Look through all signal contexts to find one that matches this position.
  // Search both active contexts and the stash (populated during full sync to preserve
  // our metadata while the broker provides ground truth for positions/orders).
  let matchingSignalContext = null;
  let matchingSignalId = null;
  let matchedFromStash = false;

  const contextsToSearch = new Map([
    ...tradingState.signalContext.entries(),
    ...(tradingState.stashedSignalContext ? tradingState.stashedSignalContext.entries() : [])
  ]);

  for (const [signalId, signalContext] of contextsToSearch.entries()) {
    // Check if this signal is for the same symbol (normalize micro/standard)
    const signalBase = getBaseSymbol(signalContext.originalSymbol || signalContext.symbol);
    const positionBase = getBaseSymbol(position.symbol);
    if (signalContext.originalSymbol === positionBase || signalContext.originalSymbol === position.symbol ||
        getPriceSymbol(signalBase) === getPriceSymbol(positionBase)) {
      // Check if position price is close to signal entry price OR if entry price is zero
      if (signalContext.price &&
          (position.entryPrice === 0 ||  // Match if entry price unknown
           Math.abs(position.entryPrice - signalContext.price) < 10)) {
        matchingSignalContext = signalContext;
        matchingSignalId = signalId;
        matchedFromStash = !tradingState.signalContext.has(signalId);
        logger.info(`🎯 Found matching signal context ${signalId} for position ${position.symbol}${matchedFromStash ? ' (restored from stash)' : ''}`);

        // If position has zero entry price, use signal price
        if (position.entryPrice === 0 && signalContext.price) {
          position.netPrice = signalContext.price;
          position.entryPrice = signalContext.price;
          logger.info(`📌 Set entry price to ${signalContext.price} from signal context`);
        }
        break;
      }
    }
  }

  // If still no match and position has zero entry price, try symbol+time matching
  if (!matchingSignalContext && (position.entryPrice === 0 || !position.entryPrice)) {
    for (const [signalId, signalContext] of contextsToSearch.entries()) {
      // Match by symbol only if position has no entry price
      const signalBase2 = getBaseSymbol(signalContext.originalSymbol || signalContext.symbol);
      const positionBase2 = getBaseSymbol(position.symbol);
      if (signalContext.originalSymbol === positionBase2 ||
          signalContext.originalSymbol === position.symbol ||
          getPriceSymbol(signalBase2) === getPriceSymbol(positionBase2)) {

        // Additional check: ensure signal timestamp is recent (within 5 minutes of position)
        const signalTime = new Date(signalContext.timestamp);
        const positionTime = position.timestamp ? new Date(position.timestamp) : new Date();
        const timeDiffMinutes = Math.abs(positionTime - signalTime) / (1000 * 60);

        if (timeDiffMinutes < 5) {
          matchingSignalContext = signalContext;
          matchingSignalId = signalId;
          matchedFromStash = !tradingState.signalContext.has(signalId);
          logger.info(`🎯 Matched signal ${signalId} to position ${position.symbol} by symbol+time${matchedFromStash ? ' (restored from stash)' : ''}`);

          // Use signal price as entry price
          if (signalContext.price) {
            position.netPrice = signalContext.price;
            position.entryPrice = signalContext.price;
            logger.info(`📌 Set entry price to ${signalContext.price} from signal context`);
          }
          break;
        }
      }
    }
  }

  if (!matchingSignalContext) {
    logger.info(`⚠️ No matching signal context found for position ${position.symbol}`);
    return;
  }

  // If matched from stash, promote back to active signal contexts
  if (matchedFromStash && matchingSignalId) {
    tradingState.signalContext.set(matchingSignalId, matchingSignalContext);
    tradingState.stashedSignalContext.delete(matchingSignalId);
    logger.info(`📥 Promoted signal context ${matchingSignalId} from stash to active`);
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

  // Update position with signal context, strategy, and breakeven config
  position.signalContext = matchingSignalContext;
  position.strategy = matchingSignalContext.strategy || matchingSignalContext.source || position.strategy;

  // Restore breakeven config from signal context (lost on restart since it's only
  // created in the order-fill path, not the startup sync path)
  if (!position.breakevenConfig) {
    let beTrigger = matchingSignalContext.breakevenTrigger;
    let beOffset = matchingSignalContext.breakevenOffset;

    // Fall back to strategy defaults if signal context doesn't have breakeven fields
    // (e.g. signals created before breakeven was wired into signal payload)
    if (!beTrigger) {
      const strategy = matchingSignalContext.strategy;
      const STRATEGY_BREAKEVEN_DEFAULTS = {
        'ES_CROSS_SIGNAL': { trigger: 3, offset: 0 },
        'IV_SKEW_GEX': { trigger: 3, offset: 0 },
        'GEX_SCALP': { trigger: 3, offset: 1 }
      };
      const defaults = STRATEGY_BREAKEVEN_DEFAULTS[strategy];
      if (defaults) {
        beTrigger = defaults.trigger;
        beOffset = defaults.offset;
        logger.info(`🎯 Using strategy default breakeven for ${strategy}: trigger=${beTrigger}, offset=${beOffset}`);
      }
    }

    if (beTrigger) {
      position.breakevenConfig = {
        trigger: beTrigger,
        offset: beOffset || 0,
        triggered: false,
        triggeredAt: null,
        originalStopPrice: matchingSignalContext.stopPrice
      };
      logger.info(`🎯 Restored breakeven config for ${position.symbol}: trigger=${beTrigger} pts, offset=${beOffset || 0}`);
    }
  }

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

      // If incoming position has zero/invalid netPrice, preserve existing entry price
      if ((!posData.netPrice || posData.netPrice === 0) && position.netPrice && position.netPrice > 0) {
        logger.debug(`📌 Preserving existing entry price ${position.netPrice} for ${position.symbol} (incoming netPrice was ${posData.netPrice || 0})`);
        newEntryPrice = position.netPrice; // Keep existing
      } else if (posData.netPrice && posData.netPrice > 0) {
        newEntryPrice = posData.netPrice;
      } else if (posData.averagePrice && posData.averagePrice > 0) {
        newEntryPrice = posData.averagePrice;
      } else if (posData.entryPrice && posData.entryPrice > 0) {
        newEntryPrice = posData.entryPrice;
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

    // FALLBACK: Use recovery function if we still have zero entry price for an open position
    if ((!newEntryPrice || newEntryPrice === 0) && posData.netPos !== 0) {
      logger.warn(`⚠️ Position ${posData.symbol} has netPos ${posData.netPos} but no entry price - attempting recovery`);
      newEntryPrice = await recoverEntryPrice(position);
      if (newEntryPrice > 0) {
        shouldUpdateEntryPrice = true;
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
    const priceSymbol = getPriceSymbol(baseSymbol);
    const currentPrice = message.close || message.price;

    logger.debug(`📈 Price update received: ${symbol} (base: ${baseSymbol}, price: ${priceSymbol}) = ${currentPrice}`);

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
      const positionPriceSymbol = getPriceSymbol(positionBaseSymbol);
      logger.debug(`📊 Position ${position.symbol} -> base: ${positionBaseSymbol} -> price: ${positionPriceSymbol} (looking for: ${priceSymbol})`);

      if (positionPriceSymbol === priceSymbol) {
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

        // Check breakeven stop trigger
        await checkBreakevenTrigger(position, currentPrice);

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
      if (getPriceSymbol(orderBaseSymbol) === priceSymbol) {
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

    // Strategy state reconciliation: check each underlying for stale position entries
    let strategyStateChanged = false;

    if (tradingState.strategyState.positions.size > 0) {
      for (const [underlying, posInfo] of tradingState.strategyState.positions) {
        if (!hasPositionForUnderlying(underlying)) {
          logger.warn(`🔄 Strategy state reconciliation: removing stale ${underlying} position "${posInfo.position}" from ${posInfo.source} — no actual positions exist for ${underlying}`);
          tradingState.strategyState.positions.delete(underlying);
          // Remove pending orders for this underlying
          for (const [orderId, orderInfo] of tradingState.strategyState.pendingOrders) {
            if (getUnderlyingSymbol(orderInfo.symbol) === underlying) {
              tradingState.strategyState.pendingOrders.delete(orderId);
            }
          }
          strategyStateChanged = true;
        }
      }
    }

    // Also clean orphaned pending orders — if a pending order no longer exists
    // as a working order, it was either filled or cancelled and we missed the cleanup
    if (tradingState.strategyState.pendingOrders.size > 0) {
      for (const [orderId, orderInfo] of tradingState.strategyState.pendingOrders) {
        if (!tradingState.workingOrders.has(orderId)) {
          logger.warn(`🔄 Strategy state reconciliation: removing orphaned pending order ${orderId} (${orderInfo.strategy} ${orderInfo.direction} ${orderInfo.symbol}) — no longer a working order`);
          tradingState.strategyState.pendingOrders.delete(orderId);
          strategyStateChanged = true;
        }
      }
    }

    if (strategyStateChanged) {
      await saveStrategyState();
      const posSummary = Array.from(tradingState.strategyState.positions.entries()).map(([u, p]) => `${u}:${p.position}(${p.source})`).join(', ') || 'flat';
      logger.info(`✅ Strategy state reconciled. Positions: [${posSummary}], pending: ${tradingState.strategyState.pendingOrders.size}`);
    } else {
      const posSummary = Array.from(tradingState.strategyState.positions.entries()).map(([u, p]) => `${u}:${p.position}(${p.source})`).join(', ') || 'flat';
      logger.info(`✅ Strategy state verified: [${posSummary}], pending: ${tradingState.strategyState.pendingOrders.size}, actual positions: ${tradingState.tradingPositions.size}`);
    }

    // Discard remaining stashed signal contexts — anything not matched to a real
    // position is truly orphaned (order was cancelled/closed while services were down)
    if (tradingState.stashedSignalContext && tradingState.stashedSignalContext.size > 0) {
      logger.info(`🗑️ Discarding ${tradingState.stashedSignalContext.size} orphaned signal contexts from stash`);
      tradingState.stashedSignalContext.clear();
    }
    tradingState.stashedSignalContext = null;

    // Persist the surviving signal contexts (only those matched to real positions)
    await saveSignalContext();
    logger.info(`💾 Saved ${tradingState.signalContext.size} active signal contexts after sync`);

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
  tradingState.tradingPositions.clear();
  tradingState.stats.totalWorkingOrders = 0;
  tradingState.stats.totalPositions = 0;

  // Stash signal contexts instead of clearing — they contain our metadata (breakeven config,
  // strategy, entry price) that the broker doesn't provide. linkBracketOrdersForSyncedPosition
  // will pull matched contexts back from the stash as positions arrive from the broker.
  // Any unmatched stash entries are discarded in handleTradovateSyncCompleted.
  tradingState.stashedSignalContext = new Map(tradingState.signalContext);
  tradingState.signalContext.clear();

  logger.info(`🔄 Full sync started - cleared ${previousCount} working orders and ${previousPositionCount} positions, stashed ${previousSignalCount} signal contexts for re-matching`);
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

    // Handle MessageBus errors to prevent crashes
    messageBus.on('error', (err) => {
      logger.error('MessageBus error (handled):', err);
      // Service continues running - reconnection logic will handle recovery
    });

    // Load configuration from Redis
    logger.info('Loading configuration from Redis...');
    tradingState.contractMappings = await loadContractMappings();
    logger.info('Configuration loaded from Redis');

    // Load persisted signal context
    await loadSignalContext();
    await loadOrderStrategyMapping();

    // Load multi-strategy state
    await loadStrategyState();

    // Load SignalRegistry persistence data
    await signalRegistry.loadMappings();
    await signalRegistry.loadLifecycles();

    // Subscribe to relevant channels
    await messageBus.subscribe(CHANNELS.WEBHOOK_RECEIVED, handleWebhookReceived);
    // Also listen for internal trade signals from signal generators (same handler, different source)
    await messageBus.subscribe(CHANNELS.TRADE_SIGNAL, handleWebhookReceived);
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

    // Request full sync which includes strategy state reconciliation
    logger.info('🔄 Requesting full sync of trading data (includes strategy state reconciliation)...');
    await messageBus.publish(CHANNELS.TRADOVATE_FULL_SYNC_REQUESTED, {
      requestedBy: 'trade-orchestrator-startup',
      reason: 'Initial sync with strategy state reconciliation',
      dryRun: false
    });

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