import express from 'express';
import { messageBus, CHANNELS, createLogger, configManager, healthCheck } from '../shared/index.js';
import TradovateClient from './TradovateClient.js';

const SERVICE_NAME = 'tradovate-service';
const logger = createLogger(SERVICE_NAME);

// Load configuration
const config = configManager.loadConfig(SERVICE_NAME, { defaultPort: 3011 });

// Debug: Log the configuration (mask password)
const debugConfig = { ...config };
if (debugConfig.tradovate && debugConfig.tradovate.password) {
  debugConfig.tradovate.password = '***masked***';
}
logger.info('Loaded configuration:', debugConfig);

// Initialize Tradovate client
const tradovateClient = new TradovateClient(config.tradovate, logger, messageBus, CHANNELS);

// Track orderStrategy relationships
// Map: strategyId -> { entryOrderId, stopOrderId, targetOrderId, symbol, isTrailing, trailingTrigger, trailingOffset }
const orderStrategyLinks = new Map();

// Track order to signal mapping for WebSocket fill notifications
// Map: orderId -> signalId (to preserve signal context when orders fill via WebSocket)
const orderSignalMap = new Map();

// Track OrderStrategy parent-child relationships
// Map: parentStrategyId -> { signalId, childOrderIds: Set<orderId> }
const strategyChildMap = new Map();

// Initialize Express app for REST API
const app = express();
app.use(express.json());

// Enable CORS for frontend health checks
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    tradovate: tradovateClient.isConnected,
    accounts: tradovateClient.accounts.length
  }, messageBus);
  res.json(health);
});

// REST API Endpoints
app.get('/accounts', async (req, res) => {
  try {
    const accounts = await tradovateClient.loadAccounts();
    res.json(accounts);
  } catch (error) {
    logger.error('Failed to get accounts:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/positions/:accountId', async (req, res) => {
  try {
    const positions = await tradovateClient.getPositions(req.params.accountId);
    res.json(positions);
  } catch (error) {
    logger.error('Failed to get positions:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/orders/:accountId', async (req, res) => {
  try {
    const orders = await tradovateClient.getOrders(req.params.accountId);
    res.json(orders);
  } catch (error) {
    logger.error('Failed to get orders:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/contract/:contractId', async (req, res) => {
  try {
    const contract = await tradovateClient.getContract(req.params.contractId);
    res.json(contract);
  } catch (error) {
    logger.error('Failed to get contract:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/balance/:accountId', async (req, res) => {
  try {
    const [account, cash] = await Promise.all([
      tradovateClient.getAccountBalances(req.params.accountId),
      tradovateClient.getCashBalances(req.params.accountId)
    ]);
    res.json({ account, cash });
  } catch (error) {
    logger.error('Failed to get balances:', error);
    res.status(500).json({ error: error.message });
  }
});

// Full sync endpoints
app.post('/sync/full', async (req, res) => {
  try {
    const { dryRun = false, reason = 'manual_api_request' } = req.body;

    logger.info(`🔄 Full sync triggered via API (dryRun: ${dryRun}, reason: ${reason})`);

    const stats = await performFullSync({
      dryRun,
      requestedBy: 'api_endpoint',
      reason
    });

    res.json({
      success: true,
      stats,
      message: dryRun ? 'Dry run completed successfully' : 'Full sync completed successfully'
    });
  } catch (error) {
    logger.error('Full sync API failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Trigger full sync via message bus (for remote triggering)
app.post('/sync/trigger', async (req, res) => {
  try {
    const { dryRun = false, reason = 'manual_trigger', requestedBy = 'api' } = req.body;

    logger.info(`🔄 Publishing full sync request (dryRun: ${dryRun}, reason: ${reason})`);

    await messageBus.publish(CHANNELS.TRADOVATE_FULL_SYNC_REQUESTED, {
      dryRun,
      reason,
      requestedBy,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Full sync request published to message bus'
    });
  } catch (error) {
    logger.error('Failed to trigger full sync:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Handle individual order cancel requests (multi-strategy support)
async function handleOrderCancelRequest(message) {
  try {
    logger.info(`🎯 Received order cancel request: ${message.orderId} (reason: ${message.reason})`);

    // Cancel the specific order
    const result = await tradovateClient.cancelOrder(message.orderId);

    if (result) {
      logger.info(`✅ Successfully cancelled order ${message.orderId}`);

      // Publish cancellation confirmation
      await messageBus.publish(CHANNELS.ORDER_CANCELLED, {
        orderId: message.orderId,
        reason: message.reason,
        timestamp: new Date().toISOString()
      });
    } else {
      logger.warn(`⚠️ Cancel request for order ${message.orderId} returned no result`);
    }

    return result;
  } catch (error) {
    logger.error(`❌ Failed to cancel order ${message.orderId}:`, {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      stack: error.stack,
      fullError: error
    });

    // Publish error event
    await messageBus.publish(CHANNELS.ORDER_REJECTED, {
      orderId: message.orderId,
      error: error.message,
      reason: 'Cancel failed',
      timestamp: new Date().toISOString()
    });
  }
}

// Message bus event handlers
async function handleOrderRequest(message) {
  try {
    logger.info('Received order request:', message);

    // Validate order data
    if (!message.accountId || !message.action || !message.symbol || !message.quantity) {
      throw new Error('Invalid order request: missing required fields');
    }

    // Find contract
    const contractResponse = await tradovateClient.findContract(message.symbol);
    logger.info('Contract lookup response:', contractResponse);

    let contractId, contractSymbol;
    if (Array.isArray(contractResponse) && contractResponse.length > 0) {
      contractId = contractResponse[0].id;
      contractSymbol = contractResponse[0].name; // Use the resolved contract name (e.g., MNQZ5)
    } else if (contractResponse && contractResponse.id) {
      contractId = contractResponse.id;
      contractSymbol = contractResponse.name; // Use the resolved contract name (e.g., MNQZ5)
    } else {
      throw new Error(`Contract not found or invalid response: ${message.symbol}`);
    }

    // Prepare order data
    const orderData = {
      accountId: message.accountId,
      contractId: contractId,
      symbol: contractSymbol, // Use resolved contract symbol (MNQZ5) not generic (MNQ)
      action: message.action, // 'Buy' or 'Sell'
      orderQty: message.quantity,
      orderType: message.orderType || 'Market',
      isAutomated: true
    };

    logger.info(`🔍 OrderData created: action=${message.action}, orderType=${orderData.orderType}`);

    // Add price for limit orders
    if (message.orderType === 'Limit' && message.price) {
      orderData.price = message.price;
    }

    // Add stop price for stop orders
    if (message.orderType === 'Stop' && message.stopPrice) {
      orderData.stopPrice = message.stopPrice;
    }

    // Check if this should be a bracket order (with stop loss and/or take profit)
    // For limit orders, stopPrice is the stop loss, not the order's stop price
    const hasBracketData = (orderData.orderType === 'Limit' && (message.stopPrice || message.takeProfit));

    logger.info(`🔍 Bracket check: orderType=${orderData.orderType}, stopPrice=${message.stopPrice}, takeProfit=${message.takeProfit}, hasBracketData=${hasBracketData}`);

    let result;
    if (hasBracketData) {
      // Check if trailing parameters are present - use orderStrategy if so
      const hasTrailingStop = message.trailing_trigger && message.trailing_offset;

      if (hasTrailingStop) {
        logger.info(`Creating order strategy with trailing stop functionality`);

        // Build orderData for orderStrategy method
        if (message.stopPrice) {
          orderData.bracket1 = {
            action: message.action === 'Buy' ? 'Sell' : 'Buy',
            orderType: 'Stop',
            stopPrice: message.stopPrice,
            autoTrail: {
              trigger: message.trailing_trigger,
              stopLoss: message.trailing_offset,
              freq: 0.25  // Use quarter point for NQ/MNQ
            }
          };
          logger.info(`📈 Trailing stop - trigger: ${message.trailing_trigger}, offset: ${message.trailing_offset}`);
        }

        if (message.takeProfit) {
          orderData.bracket2 = {
            action: message.action === 'Buy' ? 'Sell' : 'Buy',
            orderType: 'Limit',
            price: message.takeProfit
          };
        }

        logger.info(`Placing order strategy:`, JSON.stringify(orderData, null, 2));
        result = await tradovateClient.placeOrderStrategy(orderData);

      } else {
        logger.info(`Creating standard bracket order with stop/profit exits`);

        // Add bracket1 (stop loss) if provided
        if (message.stopPrice) {
          // Validate stop loss direction
          const isBuy = message.action === 'Buy';
          const entryPrice = message.price;
          if (isBuy && message.stopPrice >= entryPrice) {
            logger.warn(`⚠️  Invalid stop loss: Buy order stop price (${message.stopPrice}) should be below entry price (${entryPrice})`);
          } else if (!isBuy && message.stopPrice <= entryPrice) {
            logger.warn(`⚠️  Invalid stop loss: Sell order stop price (${message.stopPrice}) should be above entry price (${entryPrice})`);
          }

          orderData.bracket1 = {
            action: message.action === 'Buy' ? 'Sell' : 'Buy',
            orderType: 'Stop',
            stopPrice: message.stopPrice
          };
          logger.info(`📊 Stop loss: ${message.action === 'Buy' ? 'Sell' : 'Buy'} Stop at ${message.stopPrice}`);
        }

        // Add bracket2 (take profit) if provided
        if (message.takeProfit) {
          // Validate take profit direction
          const isBuy = message.action === 'Buy';
          const entryPrice = message.price;
          if (isBuy && message.takeProfit <= entryPrice) {
            logger.warn(`⚠️  Invalid take profit: Buy order take profit (${message.takeProfit}) should be above entry price (${entryPrice})`);
          } else if (!isBuy && message.takeProfit >= entryPrice) {
            logger.warn(`⚠️  Invalid take profit: Sell order take profit (${message.takeProfit}) should be below entry price (${entryPrice})`);
          }

          orderData.bracket2 = {
            action: message.action === 'Buy' ? 'Sell' : 'Buy',
            orderType: 'Limit',
            price: message.takeProfit
          };
          logger.info(`📊 Take profit: ${message.action === 'Buy' ? 'Sell' : 'Buy'} Limit at ${message.takeProfit}`);
        }

        logger.info(`Placing bracket order:`, JSON.stringify(orderData, null, 2));

        // Place the bracket order
        result = await tradovateClient.placeBracketOrder(orderData);
      }

      // Publish events for all orders
      const timestamp = new Date().toISOString();

      // Handle different response formats for bracket orders vs order strategies
      if (hasTrailingStop) {
        // Order strategy response - extract ID from response structure
        const strategyId = result.orderStrategy?.id || result.id;
        logger.info(`Order strategy placed with ID: ${strategyId}`);
        await messageBus.publish(CHANNELS.ORDER_PLACED, {
          strategyId: strategyId,
          orderId: strategyId,
          accountId: message.accountId,
          symbol: contractSymbol,
          action: message.action,
          quantity: message.quantity,
          orderType: message.orderType,
          price: message.price,
          contractId: contractId,
          status: 'working',
          timestamp: timestamp,
          isOrderStrategy: true,
          hasTrailingStop: true,
          trailing_trigger: message.trailing_trigger,
          trailing_offset: message.trailing_offset,
          signalId: message.signalId,
          response: result
        });

        // Store strategy-signal mapping for OrderStrategy child order tracking
        if (message.signalId && strategyId) {
          strategyChildMap.set(strategyId, {
            signalId: message.signalId,
            childOrderIds: new Set()
          });
          logger.info(`🔗 Stored OrderStrategy mapping: strategy ${strategyId} → signal ${message.signalId}`);

          // IMPORTANT: Also map the parent OrderStrategy order itself to the signal
          // This allows dashboard filtering to hide the parent when child orders fill
          orderSignalMap.set(strategyId, message.signalId);
          logger.info(`🔗 Mapped parent OrderStrategy ${strategyId} → signal ${message.signalId}`);

          // Query Tradovate for the child orders that belong to this strategy
          try {
            logger.info(`🔍 Querying Tradovate for child orders of strategy ${strategyId}`);

            const dependents = await tradovateClient.getOrderStrategyDependents(strategyId);

            if (dependents && Array.isArray(dependents)) {
              const mapping = strategyChildMap.get(strategyId);
              if (mapping) {
                // Store strategy info in orderStrategyLinks for stop detection
                const strategyInfo = orderStrategyLinks.get(strategyId) || {
                  strategyId: strategyId,
                  timestamp: new Date().toISOString(),
                  entryOrderId: null,
                  stopOrderId: null,
                  targetOrderId: null,
                  isTrailing: hasTrailingStop,
                  symbol: contractSymbol
                };

                // Store all child order IDs
                dependents.forEach(dep => {
                  if (dep.orderId) {
                    mapping.childOrderIds.add(dep.orderId);
                    // Also map individual orders to the signal
                    orderSignalMap.set(dep.orderId, message.signalId);
                    logger.info(`🔗 Mapped child order ${dep.orderId} (label: ${dep.label}) → signal ${message.signalId}`);

                    // Track which order is which based on label or order
                    // First order is usually entry, second is stop
                    if (!strategyInfo.entryOrderId) {
                      strategyInfo.entryOrderId = dep.orderId;
                      logger.info(`🎯 Identified order ${dep.orderId} as ENTRY order for strategy ${strategyId}`);
                    } else if (!strategyInfo.stopOrderId) {
                      strategyInfo.stopOrderId = dep.orderId;
                      logger.info(`🛑 Identified order ${dep.orderId} as STOP order for strategy ${strategyId}`);
                    } else if (!strategyInfo.targetOrderId) {
                      strategyInfo.targetOrderId = dep.orderId;
                      logger.info(`🎯 Identified order ${dep.orderId} as TARGET order for strategy ${strategyId}`);
                    }
                  }
                });

                // Update the strategy links map
                orderStrategyLinks.set(strategyId, strategyInfo);
                logger.info(`✅ Successfully mapped ${mapping.childOrderIds.size} child orders + parent strategy to signal ${message.signalId}`);
              }
            }

            logger.info(`📊 Strategy ${strategyId} child order mapping completed`);
          } catch (error) {
            logger.warn(`⚠️ Failed to query OrderStrategy dependents: ${error.message}`);
          }
        }
      } else {
        // Standard bracket order response
        await messageBus.publish(CHANNELS.ORDER_PLACED, {
          orderId: result.orderId,
          accountId: message.accountId,
          symbol: contractSymbol,
          action: message.action,
          quantity: message.quantity,
          orderType: message.orderType,
          price: message.price,
          contractId: contractId,
          status: 'working',
          timestamp: timestamp,
          isBracketOrder: true,
          signalId: message.signalId,
          response: result
        });

        // Store signal mapping for WebSocket fill notifications
        if (message.signalId && result.orderId) {
          orderSignalMap.set(result.orderId, message.signalId);
          logger.info(`🔗 Stored signal mapping: order ${result.orderId} → signal ${message.signalId}`);
        }
      }

      // Only publish bracket order events for standard bracket orders (not order strategies)
      if (!hasTrailingStop) {
        // Stop loss order (if exists)
        if (result.bracket1OrderId) {
          await messageBus.publish(CHANNELS.ORDER_PLACED, {
            orderId: result.bracket1OrderId,
            accountId: message.accountId,
            symbol: contractSymbol,
            action: orderData.bracket1.action,
            quantity: message.quantity,
            orderType: orderData.bracket1.orderType,
            stopPrice: orderData.bracket1.stopPrice,
            contractId: contractId,
            status: 'working',
            timestamp: timestamp,
            parentOrderId: result.orderId,
            orderRole: 'stop_loss',
            signalId: message.signalId
          });

          // Store signal mapping for bracket stop loss order
          if (message.signalId) {
            orderSignalMap.set(result.bracket1OrderId, message.signalId);
            logger.info(`🔗 Stored signal mapping: bracket stop order ${result.bracket1OrderId} → signal ${message.signalId}`);
          }
        }

        // Take profit order (if exists)
        if (result.bracket2OrderId) {
          await messageBus.publish(CHANNELS.ORDER_PLACED, {
            orderId: result.bracket2OrderId,
            accountId: message.accountId,
            symbol: contractSymbol,
            action: orderData.bracket2.action,
            quantity: message.quantity,
            orderType: orderData.bracket2.orderType,
            price: orderData.bracket2.price,
            contractId: contractId,
            status: 'working',
            timestamp: timestamp,
            parentOrderId: result.orderId,
            orderRole: 'take_profit',
            signalId: message.signalId
          });

          // Store signal mapping for bracket take profit order
          if (message.signalId) {
            orderSignalMap.set(result.bracket2OrderId, message.signalId);
            logger.info(`🔗 Stored signal mapping: bracket target order ${result.bracket2OrderId} → signal ${message.signalId}`);
          }
        }
      }

    } else {
      logger.info(`Placing regular order:`, orderData);

      // Place regular order
      result = await tradovateClient.placeOrder(orderData);

      // Publish success event for regular order
      await messageBus.publish(CHANNELS.ORDER_PLACED, {
        orderId: result.orderId,
        accountId: message.accountId,
        symbol: contractSymbol, // Use resolved symbol
        action: message.action,
        quantity: message.quantity,
        orderType: message.orderType,
        price: message.price,
        stopPrice: message.stopPrice,
        takeProfit: message.takeProfit,
        contractId: contractId,
        status: 'working',
        timestamp: new Date().toISOString(),
        signalId: message.signalId,
        originalRequest: message,
        response: result
      });

      // Store signal mapping for regular order
      if (message.signalId && result.orderId) {
        orderSignalMap.set(result.orderId, message.signalId);
        logger.info(`🔗 Stored signal mapping: regular order ${result.orderId} → signal ${message.signalId}`);
      }
    }

    logger.info('Order placed successfully:', result.orderId);
  } catch (error) {
    logger.error('Failed to process order request:', error);

    // Publish rejection event
    await messageBus.publish(CHANNELS.ORDER_REJECTED, {
      error: error.message,
      originalRequest: message,
      timestamp: new Date().toISOString()
    });
  }
}

async function handlePositionUpdate() {
  try {
    // Update positions for all accounts
    for (const account of tradovateClient.accounts) {
      const positions = await tradovateClient.getPositions(account.id);

      // Log the raw position data to see what Tradovate provides
      if (positions && positions.length > 0) {
        logger.info(`📊 Raw position data from Tradovate for account ${account.id}:`, JSON.stringify(positions[0]));

        // Try to get more details about positions using /position/items
        try {
          const positionIds = positions.map(p => p.id);
          const positionDetails = await tradovateClient.makeRequest('POST', '/position/items', { ids: positionIds });
          logger.info(`📊 Detailed position data from /position/items:`, JSON.stringify(positionDetails));
        } catch (error) {
          logger.warn(`Could not fetch position details: ${error.message}`);
        }
      }

      await messageBus.publish(CHANNELS.POSITION_UPDATE, {
        accountId: account.id,
        accountName: account.name,
        positions: positions,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('Failed to update positions:', error);
  }
}

async function handleAccountUpdate() {
  try {
    // Update account balances for all accounts
    for (const account of tradovateClient.accounts) {
      const [accountData, cashData] = await Promise.all([
        tradovateClient.getAccountBalances(account.id),
        tradovateClient.getCashBalances(account.id)
      ]);

      await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
        accountId: account.id,
        accountName: account.name,
        accountData,
        cashData,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('Failed to update accounts:', error);
  }
}

// Sync existing orders and positions from Tradovate on startup
async function syncExistingData() {
  try {
    logger.info('🔄 Syncing existing orders and positions from Tradovate...');

    for (const account of tradovateClient.accounts) {
      logger.info(`📋 Syncing data for account: ${account.name} (${account.id})`);

      // Sync existing orders (with enrichment!)
      try {
        const orders = await tradovateClient.getOrders(account.id, true); // true = enriched
        logger.info(`📋 Found ${orders.length} existing orders for account ${account.id}`);

        // Debug: Log order statuses to see what we're getting
        const statusCounts = {};
        for (const order of orders) {
          // Tradovate uses 'ordStatus' not 'orderStatus'!
          const status = order.ordStatus || order.orderStatus || 'undefined';
          statusCounts[status] = (statusCounts[status] || 0) + 1;
        }
        logger.info(`📊 Order status breakdown:`, statusCounts);

        // Track which orders we've seen
        const currentOrderIds = new Set();

        for (const order of orders) {
          currentOrderIds.add(order.id);

          // Get the actual status field (Tradovate uses 'ordStatus')
          const orderStatus = order.ordStatus || order.orderStatus;

          // Handle different order statuses
          if (orderStatus === 'Working') {
            logger.info(`📋 Syncing working order: ${order.id} - ${order.action} ${order.symbol || order.contractName} ${order.orderType} @ ${order.price}`);

            // Debug: Log what quantity fields are available
            logger.info(`🔍 DEBUG Order ${order.id} quantity fields: qty=${order.qty}, orderQty=${order.orderQty}, final=${order.qty || order.orderQty}`);

            await messageBus.publish(CHANNELS.ORDER_PLACED, {
              orderId: order.id,
              accountId: account.id,
              symbol: order.symbol || order.contractName, // Use enriched symbol
              action: order.action,
              quantity: order.qty || order.orderQty,
              orderType: order.orderType,
              price: order.price || order.limitPrice, // Use enriched price
              stopPrice: order.stopPrice,
              contractId: order.contractId,
              contractName: order.contractName,
              tickSize: order.tickSize,
              status: 'working',
              orderStatus: orderStatus, // Include original Tradovate status
              timestamp: new Date().toISOString(),
              source: 'sync'
            });
          } else if (orderStatus === 'Filled') {
            // Don't sync historical filled orders - they're already complete
            logger.info(`✅ Skipping historical filled order: ${order.id} - ${order.action} ${order.symbol || order.contractName}`);
          } else if (orderStatus === 'Cancelled' || orderStatus === 'Rejected') {
            // Don't sync historical cancelled/rejected orders - they're already complete
            logger.info(`❌ Skipping historical cancelled/rejected order: ${order.id} - ${orderStatus}`);
          }
        }
      } catch (orderError) {
        logger.error(`Failed to sync orders for account ${account.id}:`, orderError);
      }

      // Sync existing positions
      try {
        const positions = await tradovateClient.getPositions(account.id);
        logger.info(`📊 Found ${positions.length} positions for account ${account.id}`);

        // Filter for open positions (non-zero netPos)
        const openPositions = positions.filter(pos => pos.netPos !== 0);

        if (openPositions.length > 0) {
          logger.info(`📊 Syncing ${openPositions.length} open positions`);

          // Get fills to calculate average entry price
          let fillsData = [];
          try {
            // Get all fills for the account
            fillsData = await tradovateClient.makeRequest('GET', `/fill/list?accountId=${account.id}`);
            logger.info(`📊 Retrieved ${fillsData.length} total fills for account ${account.id}`);

            // Log first few fills to see structure
            if (fillsData.length > 0) {
              logger.info(`📊 Sample fill data (first 2):`, JSON.stringify(fillsData.slice(0, 2), null, 2));
            }
          } catch (error) {
            logger.error(`Failed to fetch fills: ${error.message}`);
          }

          // Calculate average entry price for each position from fills
          const positionPrices = {};
          for (const pos of openPositions) {
            try {
              // Filter fills for this contract
              const contractFills = fillsData.filter(fill =>
                fill.contractId === pos.contractId &&
                fill.active === true
              );

              logger.info(`📊 Found ${contractFills.length} active fills for position ${pos.id} (contract ${pos.contractId})`);

              if (contractFills.length > 0) {
                // Sort fills by timestamp (most recent first)
                const sortedFills = contractFills.sort((a, b) => {
                  const timeA = new Date(a.timestamp || a.tradeDate || 0);
                  const timeB = new Date(b.timestamp || b.tradeDate || 0);
                  return timeB - timeA; // Most recent first
                });

                logger.info(`📊 Working backwards from ${sortedFills.length} fills to reconstruct current position of ${pos.netPos}`);

                // Work backwards to reconstruct the current open position
                let currentNetPos = 0;
                const relevantFills = [];

                for (const fill of sortedFills) {
                  const qty = fill.qty || 0;
                  const isBuy = fill.action === 'Buy';
                  const signedQty = isBuy ? qty : -qty;

                  logger.info(`  Fill: ${fill.action} (${isBuy ? 'BUY' : 'SELL'}) ${qty} @ ${fill.price} [Net: ${currentNetPos} → ${currentNetPos + signedQty}]`);

                  relevantFills.push({ ...fill, signedQty });
                  currentNetPos += signedQty;

                  // Stop when we've reconstructed the current position
                  if (Math.abs(currentNetPos) >= Math.abs(pos.netPos)) {
                    logger.info(`📊 Reconstructed position: target=${pos.netPos}, current=${currentNetPos}`);
                    break;
                  }
                }

                // Calculate weighted average price from relevant fills only
                let totalValue = 0;
                let totalQuantity = 0;

                for (const fill of relevantFills) {
                  const qty = fill.qty || 0;
                  const price = fill.price || 0;
                  const isBuy = fill.action === 'Buy';

                  if (isBuy) {
                    totalValue += qty * price;
                    totalQuantity += qty;
                  } else {
                    // For sells, subtract from both value and quantity
                    totalValue -= qty * price;
                    totalQuantity -= qty;
                  }
                }

                const avgPrice = totalQuantity !== 0 ? Math.abs(totalValue / totalQuantity) : 0;
                positionPrices[pos.contractId] = avgPrice;
                logger.info(`📊 Calculated entry price from ${relevantFills.length} relevant fills: ${avgPrice.toFixed(2)}`);
              }
            } catch (error) {
              logger.error(`Failed to calculate entry price for position ${pos.id}: ${error.message}`);
            }
          }

          // Resolve contract symbols for each position
          const enrichedPositions = [];
          for (const position of openPositions) {
            let symbol = 'Unknown';
            try {
              const contractDetails = await tradovateClient.getContractDetails(position.contractId);
              symbol = contractDetails.name || contractDetails.symbol || `CONTRACT_${position.contractId}`;
              logger.info(`✅ Resolved startup contract ${position.contractId} to symbol: ${symbol}`);
            } catch (error) {
              logger.warn(`Failed to resolve startup contract ${position.contractId}: ${error.message}`);
              symbol = `CONTRACT_${position.contractId}`;
            }

            enrichedPositions.push({
              ...position,
              symbol: symbol,
              contractName: symbol,
              netPrice: positionPrices[position.contractId] || 0,
              averagePrice: positionPrices[position.contractId] || 0,
              entryPrice: positionPrices[position.contractId] || 0
            });
          }

          await messageBus.publish(CHANNELS.POSITION_UPDATE, {
            accountId: account.id,
            accountName: account.name,
            positions: enrichedPositions,
            timestamp: new Date().toISOString(),
            source: 'startup_sync'
          });
        }
      } catch (positionError) {
        logger.error(`Failed to sync positions for account ${account.id}:`, positionError);
      }
    }

    logger.info('✅ Startup sync completed');
  } catch (error) {
    logger.error('❌ Failed to sync existing data:', error);
  }
}

// Comprehensive full re-sync function to reconcile trading state with Tradovate
// Handles stale orders, archived orders, and position discrepancies
async function performFullSync(options = {}) {
  const {
    dryRun = false,
    requestedBy = 'system',
    reason = 'manual_request'
  } = options;

  const syncStats = {
    startTime: new Date().toISOString(),
    endTime: null,
    accountsProcessed: 0,
    ordersFound: 0,
    ordersReconciled: 0,
    ordersRemoved: 0,
    positionsFound: 0,
    positionsReconciled: 0,
    signalMappingsRemoved: 0,
    accountBalancesUpdated: 0,
    errors: [],
    dryRun: dryRun
  };

  try {
    logger.info(`🔄 Starting full sync (${dryRun ? 'DRY RUN' : 'LIVE'}) - requested by: ${requestedBy}, reason: ${reason}`);

    await messageBus.publish(CHANNELS.TRADOVATE_FULL_SYNC_STARTED, {
      requestedBy,
      reason,
      dryRun,
      timestamp: syncStats.startTime
    });

    // Get fresh account list
    await tradovateClient.loadAccounts();
    const accounts = tradovateClient.accounts;

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts available for sync');
    }

    for (const account of accounts) {
      syncStats.accountsProcessed++;
      logger.info(`📋 Full sync for account: ${account.name} (${account.id})`);

      // Step 1: Get ground truth from Tradovate (including account balances)
      const [freshOrders, freshPositions, accountData, cashData] = await Promise.all([
        tradovateClient.getOrders(account.id, true), // enriched
        tradovateClient.getPositions(account.id),
        tradovateClient.getAccountBalances(account.id),
        tradovateClient.getCashBalances(account.id)
      ]);

      syncStats.ordersFound += freshOrders.length;
      syncStats.positionsFound += freshPositions.length;

      logger.info(`📊 Tradovate ground truth: ${freshOrders.length} orders, ${freshPositions.length} positions, balance: $${cashData?.amount || 0}`);

      // Step 2: Reconcile orders - identify truly working vs archived/stale
      const workingOrders = freshOrders.filter(order =>
        order.ordStatus === 'Working' || order.ordStatus === 'Pending'
      );

      const completedOrders = freshOrders.filter(order =>
        order.ordStatus === 'Filled' ||
        order.ordStatus === 'Cancelled' ||
        order.ordStatus === 'Rejected'
      );

      logger.info(`📊 Order breakdown: ${workingOrders.length} working, ${completedOrders.length} completed`);

      // Step 3: Clean up signal mappings for completed orders
      let cleanedMappings = 0;
      for (const order of completedOrders) {
        if (orderSignalMap.has(order.id)) {
          if (!dryRun) {
            orderSignalMap.delete(order.id);
          }
          cleanedMappings++;
          logger.info(`🧹 ${dryRun ? '[DRY RUN] Would remove' : 'Removed'} signal mapping for completed order ${order.id}`);
        }
      }
      syncStats.signalMappingsRemoved += cleanedMappings;

      // Step 4: Collect all valid working order IDs for this account
      const validOrderIds = [];

      for (const order of workingOrders) {
        syncStats.ordersReconciled++;
        validOrderIds.push(order.id);

        if (!dryRun) {
          await messageBus.publish(CHANNELS.ORDER_PLACED, {
            orderId: order.id,
            accountId: account.id,
            symbol: order.symbol || order.contractName,
            action: order.action,
            quantity: order.qty || order.orderQty,
            orderType: order.orderType,
            price: order.price || order.limitPrice,
            stopPrice: order.stopPrice,
            contractId: order.contractId,
            contractName: order.contractName,
            tickSize: order.tickSize,
            status: 'working',
            orderStatus: order.ordStatus,
            timestamp: new Date().toISOString(),
            source: 'full_sync'
          });
        }

        logger.debug(`📋 ${dryRun ? '[DRY RUN] Would reconcile' : 'Reconciled'} working order: ${order.id} - ${order.action} ${order.symbol || order.contractName}`);
      }

      // Step 4b: Publish a sync completed event for this account with valid order IDs
      // This allows downstream services to clean up any orders not in this list
      if (!dryRun) {
        await messageBus.publish(CHANNELS.TRADOVATE_SYNC_COMPLETED, {
          accountId: account.id,
          validWorkingOrderIds: validOrderIds,
          timestamp: new Date().toISOString(),
          source: 'full_sync_reconciliation'
        });

        logger.info(`📋 Published sync completion for account ${account.id} with ${validOrderIds.length} valid working orders`);
      }

      // Step 5: Publish account balance update
      if (!dryRun && (accountData || cashData)) {
        await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
          accountId: account.id,
          accountName: account.name,
          balance: cashData?.amount || 0,
          cashData: cashData,
          accountData: accountData,
          realizedPnL: cashData?.realizedPnL || 0,
          unrealizedPnL: cashData?.unrealizedPnL || 0,
          marginUsed: accountData?.marginUsed || 0,
          marginAvailable: accountData?.marginAvailable || 0,
          timestamp: new Date().toISOString(),
          source: 'full_sync'
        });

        syncStats.accountBalancesUpdated++;
        logger.info(`💰 Published account balance update for ${account.name}: $${cashData?.amount || 0}`);
      }

      // Step 6: Reconcile positions
      const openPositions = freshPositions.filter(pos => pos.netPos !== 0);

      for (const position of openPositions) {
        syncStats.positionsReconciled++;

        // Get contract details for enrichment
        let symbol = `CONTRACT_${position.contractId}`;
        try {
          const contractDetails = await tradovateClient.getContractDetails(position.contractId);
          symbol = contractDetails.name || contractDetails.symbol || symbol;
        } catch (error) {
          logger.warn(`Failed to resolve contract ${position.contractId}: ${error.message}`);
        }

        if (!dryRun) {
          await messageBus.publish(CHANNELS.POSITION_UPDATE, {
            accountId: account.id,
            contractId: position.contractId,
            symbol: symbol,
            netPos: position.netPos,
            side: position.netPos > 0 ? 'long' : 'short',
            timestamp: new Date().toISOString(),
            source: 'full_sync'
          });
        }

        logger.debug(`📊 ${dryRun ? '[DRY RUN] Would reconcile' : 'Reconciled'} position: ${symbol} netPos=${position.netPos}`);
      }
    }

    syncStats.endTime = new Date().toISOString();

    logger.info(`✅ Full sync ${dryRun ? '(DRY RUN) ' : ''}completed successfully`);
    logger.info(`📊 Sync stats: ${syncStats.accountsProcessed} accounts, ${syncStats.ordersReconciled} orders, ${syncStats.positionsReconciled} positions, ${syncStats.accountBalancesUpdated} balances updated, ${syncStats.signalMappingsRemoved} mappings cleaned`);

    // Publish completion event
    await messageBus.publish(CHANNELS.TRADOVATE_FULL_SYNC_COMPLETED, {
      requestedBy,
      reason,
      stats: syncStats,
      success: true,
      timestamp: syncStats.endTime
    });

    return syncStats;

  } catch (error) {
    syncStats.errors.push(error.message);
    syncStats.endTime = new Date().toISOString();

    logger.error(`❌ Full sync failed: ${error.message}`);

    await messageBus.publish(CHANNELS.TRADOVATE_FULL_SYNC_COMPLETED, {
      requestedBy,
      reason,
      stats: syncStats,
      success: false,
      error: error.message,
      timestamp: syncStats.endTime
    });

    throw error;
  }
}

// Handle full sync requests
async function handleFullSyncRequest(message) {
  const { requestedBy = 'unknown', reason = 'unknown', dryRun = false } = message;

  logger.info(`🔄 Received full sync request from ${requestedBy} (reason: ${reason}, dryRun: ${dryRun})`);

  try {
    await performFullSync({ requestedBy, reason, dryRun });
  } catch (error) {
    logger.error(`❌ Failed to handle full sync request: ${error.message}`);
  }
}

// Scheduled sync functionality
let scheduledSyncInterval = null;

function startScheduledSync(intervalHours = 6, enabled = true) {
  if (!enabled) {
    logger.info('📅 Scheduled sync is disabled');
    return;
  }

  // Clear any existing interval
  if (scheduledSyncInterval) {
    clearInterval(scheduledSyncInterval);
  }

  const intervalMs = intervalHours * 60 * 60 * 1000; // Convert hours to milliseconds

  logger.info(`📅 Starting scheduled full sync every ${intervalHours} hours`);

  scheduledSyncInterval = setInterval(async () => {
    try {
      logger.info('📅 Triggering scheduled full sync...');

      await performFullSync({
        requestedBy: 'scheduler',
        reason: 'scheduled_interval',
        dryRun: false
      });

      logger.info('✅ Scheduled full sync completed successfully');
    } catch (error) {
      logger.error(`❌ Scheduled full sync failed: ${error.message}`);
    }
  }, intervalMs);

  logger.info(`📅 Next scheduled sync in ${intervalHours} hours`);
}

function stopScheduledSync() {
  if (scheduledSyncInterval) {
    clearInterval(scheduledSyncInterval);
    scheduledSyncInterval = null;
    logger.info('📅 Scheduled sync stopped');
  }
}

// Market hours based sync - trigger sync after market close and before market open
function startMarketHoursSync(enabled = false) {
  if (!enabled) {
    logger.info('📅 Market hours sync is disabled');
    return;
  }

  logger.info('📅 Setting up market hours sync (after close: 5:15pm EST, before open: 5:45pm EST)');

  // Schedule for 5:15 PM EST (after futures close at 5:00 PM EST)
  const scheduleAfterClose = () => {
    const now = new Date();
    const target = new Date(now);

    // Set to 5:15 PM EST (convert to local time if needed)
    target.setHours(17, 15, 0, 0); // 5:15 PM

    // If it's already past 5:15 PM today, schedule for tomorrow
    if (now > target) {
      target.setDate(target.getDate() + 1);
    }

    const timeout = target.getTime() - now.getTime();

    logger.info(`📅 Scheduled post-close sync for: ${target.toLocaleString()}`);

    setTimeout(async () => {
      try {
        logger.info('📅 Triggering post-market-close sync...');

        await performFullSync({
          requestedBy: 'market_scheduler',
          reason: 'post_market_close',
          dryRun: false
        });

        // Schedule the next one
        scheduleAfterClose();

      } catch (error) {
        logger.error(`❌ Post-market-close sync failed: ${error.message}`);
        // Still schedule the next one
        scheduleAfterClose();
      }
    }, timeout);
  };

  // Schedule for 5:45 PM EST (before futures reopen at 6:00 PM EST)
  const scheduleBeforeOpen = () => {
    const now = new Date();
    const target = new Date(now);

    // Set to 5:45 PM EST
    target.setHours(17, 45, 0, 0); // 5:45 PM

    // If it's already past 5:45 PM today, schedule for tomorrow
    if (now > target) {
      target.setDate(target.getDate() + 1);
    }

    const timeout = target.getTime() - now.getTime();

    logger.info(`📅 Scheduled pre-open sync for: ${target.toLocaleString()}`);

    setTimeout(async () => {
      try {
        logger.info('📅 Triggering pre-market-open sync...');

        await performFullSync({
          requestedBy: 'market_scheduler',
          reason: 'pre_market_open',
          dryRun: false
        });

        // Schedule the next one
        scheduleBeforeOpen();

      } catch (error) {
        logger.error(`❌ Pre-market-open sync failed: ${error.message}`);
        // Still schedule the next one
        scheduleBeforeOpen();
      }
    }, timeout);
  };

  scheduleAfterClose();
  scheduleBeforeOpen();
}

// Handle webhook trade signals from TradingView
async function handleWebhookTrade(webhookMessage) {
  try {
    logger.info('Received trade signal webhook:', webhookMessage.id);
    const tradeSignal = webhookMessage.body;

    logger.debug('Trade signal data:', tradeSignal);

    // Validate required fields
    if (!tradeSignal.action) {
      throw new Error('Invalid trade signal: missing action field');
    }

    if (!tradeSignal.symbol) {
      throw new Error('Invalid trade signal: missing symbol field');
    }

    // Get account ID
    const accountId = tradovateClient.accounts.length > 0 ? tradovateClient.accounts[0].id : null;
    if (!accountId) {
      throw new Error('No Tradovate accounts available');
    }

    // Handle different action types from LDPS Trader
    switch (tradeSignal.action) {
      case 'place_limit':
        await handlePlaceLimitOrder(tradeSignal, accountId, webhookMessage.id);
        break;

      case 'cancel_limit':
        await handleCancelLimitOrders(tradeSignal, accountId, webhookMessage.id);
        break;

      case 'position_closed':
        await handlePositionClosed(tradeSignal, accountId, webhookMessage.id);
        break;

      case 'update_limit':
        await handleUpdateLimitOrder(tradeSignal, accountId, webhookMessage.id);
        break;

      default:
        throw new Error(`Unknown action: ${tradeSignal.action}. Expected: place_limit, cancel_limit, position_closed, or update_limit`);
    }

    // Publish webhook processed event
    await messageBus.publish(CHANNELS.WEBHOOK_VALIDATED, {
      webhookId: webhookMessage.id,
      type: 'trade_signal',
      processed: true,
      action: tradeSignal.action,
      symbol: tradeSignal.symbol,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to process trade signal webhook:', error);

    // Publish webhook rejection
    await messageBus.publish(CHANNELS.WEBHOOK_REJECTED, {
      webhookId: webhookMessage.id,
      type: 'trade_signal',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// Handle place_limit action from LDPS Trader
async function handlePlaceLimitOrder(tradeSignal, accountId, webhookId) {
  // Map side to Tradovate action
  let action;
  if (tradeSignal.side === 'buy') action = 'Buy';
  else if (tradeSignal.side === 'sell') action = 'Sell';
  else throw new Error(`Invalid side: ${tradeSignal.side}. Expected 'buy' or 'sell'.`);

  // Check for existing working limit orders to prevent stacking
  try {
    const orders = await tradovateClient.getOrders(accountId);
    const existingLimitOrders = orders.filter(order => {
      return order.orderStatus === 'Working' &&
             order.orderType === 'Limit' &&
             order.contractId === tradovateClient.mapToFullContractSymbol(tradeSignal.symbol) &&
             order.action === action;
    });

    if (existingLimitOrders.length > 0) {
      logger.warn(`⚠️ Found ${existingLimitOrders.length} existing working limit order(s) for ${tradeSignal.symbol} ${tradeSignal.side}`);

      // Cancel existing orders to prevent stacking
      for (const existingOrder of existingLimitOrders) {
        logger.info(`🔄 Cancelling existing order ${existingOrder.id} at price ${existingOrder.price} to prevent stacking`);
        await tradovateClient.cancelOrder(existingOrder.id);
      }

      logger.info(`✅ Cancelled ${existingLimitOrders.length} existing order(s), proceeding with new order placement`);
    }
  } catch (error) {
    logger.error(`Failed to check/cancel existing orders: ${error.message}`);
    // Continue with order placement even if check fails
  }

  // Create order request
  const orderRequest = {
    accountId: accountId,
    action: action,
    symbol: tradeSignal.symbol,
    quantity: tradeSignal.quantity || 1,
    orderType: 'Limit',
    price: tradeSignal.price,
    stopPrice: tradeSignal.stop_loss,
    takeProfit: tradeSignal.take_profit,
    trailing_trigger: tradeSignal.trailing_trigger,
    trailing_offset: tradeSignal.trailing_offset,
    source: 'webhook',
    strategy: tradeSignal.strategy || 'unknown',
    webhookId: webhookId
  };

  logger.info(`Processing place_limit: ${action} ${orderRequest.quantity} ${tradeSignal.symbol} at ${tradeSignal.price}`);
  if (orderRequest.stopPrice) logger.info(`📊 Stop loss: ${orderRequest.stopPrice}`);
  if (orderRequest.takeProfit) logger.info(`📊 Take profit: ${orderRequest.takeProfit}`);
  if (orderRequest.trailing_trigger && orderRequest.trailing_offset) {
    logger.info(`📈 Trailing stop - trigger: ${orderRequest.trailing_trigger}, offset: ${orderRequest.trailing_offset}`);
  }

  // Forward to order handler
  await handleOrderRequest(orderRequest);
}

// Handle account sync requests from monitoring service
async function handleAccountSyncRequest(message) {
  logger.info(`🔄 Received account sync request from ${message.requestedBy}`);

  try {
    // Re-publish current account data if we have accounts available
    await tradovateClient.loadAccounts();
    const accounts = tradovateClient.accounts;
    if (accounts && accounts.length > 0) {
      for (const account of accounts) {
        try {
          // Get current account and cash data
          const [accountData, cashData] = await Promise.all([
            tradovateClient.getAccountBalances(account.id),
            tradovateClient.getCashBalances(account.id)
          ]);

          // Publish account update
          await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
            accountId: account.id,
            accountName: account.name,
            accountData,
            cashData,
            source: 'sync_request',
            timestamp: new Date().toISOString()
          });

          logger.info(`✅ Re-published account data for ${account.name} (${account.id})`);
        } catch (error) {
          logger.error(`❌ Failed to sync account ${account.id}:`, error.message);
        }
      }
    } else {
      logger.warn('⚠️ No accounts available to sync');
    }
  } catch (error) {
    logger.error('❌ Failed to handle account sync request:', {
      error: error.message,
      stack: error.stack,
      tradovateConnected: tradovateClient?.isConnected || false
    });
  }
}

// Handle position sync requests from trade-orchestrator
async function handlePositionSyncRequest(message) {
  const { requestedBy = 'unknown', reason = 'unknown' } = message;
  logger.info(`🔄 Received position sync request from ${requestedBy} (reason: ${reason})`);

  try {
    if (!tradovateClient || !tradovateClient.isConnected) {
      logger.warn('⚠️ Tradovate client not connected - cannot sync positions');
      return;
    }

    // Get current accounts
    await tradovateClient.loadAccounts();
    const accounts = tradovateClient.accounts;

    if (!accounts || accounts.length === 0) {
      logger.warn('⚠️ No accounts available for position sync');
      return;
    }

    // Sync positions for each account
    for (const account of accounts) {
      try {
        logger.info(`📊 Syncing positions for account ${account.name} (${account.id})`);

        // Get current positions from Tradovate
        const positions = await tradovateClient.getPositions(account.id);

        if (positions && positions.length > 0) {
          const validPositions = positions.filter(pos => pos.netPos !== 0);

          logger.info(`📊 Found ${validPositions.length} open positions for account ${account.id}`);

          // Publish position updates with authoritative data
          for (const position of validPositions) {
            try {
              // Resolve contract ID to symbol
              let symbol = 'Unknown';
              try {
                const contractDetails = await tradovateClient.getContractDetails(position.contractId);
                symbol = contractDetails.name || contractDetails.symbol || `CONTRACT_${position.contractId}`;
              } catch (error) {
                logger.warn(`Failed to resolve contract ${position.contractId}: ${error.message}`);
                symbol = `CONTRACT_${position.contractId}`;
              }

              // Publish individual position update
              await messageBus.publish(CHANNELS.POSITION_UPDATE, {
                accountId: position.accountId,
                positionId: position.id,
                contractId: position.contractId,
                symbol: symbol,
                contractName: symbol,
                netPos: position.netPos,
                netPrice: position.netPrice,
                bought: position.bought,
                sold: position.sold,
                pnl: position.pnl,
                timestamp: new Date().toISOString(),
                source: 'position_sync_request'
              });

              logger.info(`✅ Published position sync: ${symbol} (${position.netPos} @ ${position.netPrice})`);
            } catch (error) {
              logger.error(`❌ Failed to publish position for contract ${position.contractId}:`, error.message);
            }
          }
        } else {
          logger.info(`📊 No open positions found for account ${account.id}`);
        }
      } catch (error) {
        logger.error(`❌ Failed to sync positions for account ${account.id}:`, error.message);
      }
    }

    // Publish completion event
    await messageBus.publish(CHANNELS.TRADOVATE_SYNC_COMPLETED, {
      requestedBy,
      reason,
      success: true,
      timestamp: new Date().toISOString()
    });

    logger.info('✅ Position sync request completed');
  } catch (error) {
    logger.error('❌ Failed to handle position sync request:', {
      error: error.message,
      stack: error.stack,
      tradovateConnected: tradovateClient?.isConnected || false
    });

    // Publish failure event
    await messageBus.publish(CHANNELS.TRADOVATE_SYNC_COMPLETED, {
      requestedBy,
      reason,
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// Handle cancel_limit action from LDPS Trader
async function handleCancelLimitOrders(tradeSignal, accountId, webhookId) {
  logger.info(`Processing cancel_limit: ${tradeSignal.side} ${tradeSignal.symbol} (reason: ${tradeSignal.reason})`);

  try {
    // Map side to Tradovate action for filtering
    let sideAction;
    if (tradeSignal.side === 'buy') sideAction = 'Buy';
    else if (tradeSignal.side === 'sell') sideAction = 'Sell';
    else throw new Error(`Invalid side: ${tradeSignal.side}. Expected 'buy' or 'sell'.`);

    // Get all open orders for the account
    const orders = await tradovateClient.getOrders(accountId);

    // Debug: Log what we're looking for
    const expectedContractName = tradovateClient.mapToFullContractSymbol(tradeSignal.symbol);
    logger.info(`🔍 Looking for: orderStatus=Working, orderType=Limit, action=${sideAction}, symbol=${expectedContractName}`);

    // Debug: Log working limit orders for cancellation
    const workingLimitOrders = orders.filter(o => {
      const isWorking = (o.orderStatus === 'Working' || o.ordStatus === 'Working');
      const orderType = o.orderType || o.ordType;
      const isLimit = orderType === 'Limit';
      return isWorking && isLimit;
    });
    logger.info(`📋 Found ${workingLimitOrders.length} working limit orders for ${sideAction} ${expectedContractName}`);

    // Filter for working limit orders matching symbol and side - orderType should now be enriched properly
    const matchingOrders = orders.filter(order => {
      const isWorking = order.orderStatus === 'Working' || order.ordStatus === 'Working';
      const orderType = order.orderType || order.ordType;
      const isLimit = orderType === 'Limit';
      const actionMatch = order.action === sideAction;
      const symbolMatch = order.symbol === expectedContractName;

      // Removed verbose debug logging

      return isWorking && isLimit && actionMatch && symbolMatch;
    });

    if (matchingOrders.length === 0) {
      logger.info(`No matching limit orders found to cancel for ${tradeSignal.symbol} ${tradeSignal.side}`);
      return;
    }

    // Cancel each matching order
    for (const order of matchingOrders) {
      await tradovateClient.cancelOrder(order.id);
      logger.info(`Cancelled order ${order.id} for ${tradeSignal.symbol}`);
    }

    // Publish cancellation event
    await messageBus.publish(CHANNELS.ORDER_CANCELLED, {
      accountId: accountId,
      symbol: tradeSignal.symbol,
      side: tradeSignal.side,
      reason: tradeSignal.reason,
      ordersCount: matchingOrders.length,
      timestamp: new Date().toISOString()
    });

    // Refresh account balance after cancellation
    logger.info(`💰 Refreshing account balance after order cancellation for account ${accountId}`);
    try {
      const [accountData, cashData] = await Promise.all([
        tradovateClient.getAccountBalances(accountId),
        tradovateClient.getCashBalances(accountId)
      ]);

      await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
        accountId: accountId,
        accountName: `Account ${accountId}`,
        accountData,
        cashData,
        timestamp: new Date().toISOString(),
        source: 'post_cancel_refresh'
      });
      logger.info(`✅ Account balance refreshed after cancellation`);
    } catch (error) {
      logger.error(`❌ Failed to refresh account balance after cancellation:`, error);
    }

  } catch (error) {
    logger.error('Failed to cancel limit orders:', error);
    throw error;
  }
}

// Handle update_limit action from LDPS Trader
async function handleUpdateLimitOrder(tradeSignal, accountId, webhookId) {
  logger.info(`🔄 STARTING handleUpdateLimitOrder function`);
  logger.info(`Processing update_limit: ${tradeSignal.side} ${tradeSignal.symbol} from ${tradeSignal.old_price} to ${tradeSignal.new_price}`);
  logger.debug(`Full tradeSignal object:`, JSON.stringify(tradeSignal, null, 2));

  try {
    // Validate required fields
    if (!tradeSignal.old_price && tradeSignal.old_price !== 0) {
      throw new Error(`Missing required field: old_price`);
    }
    if (!tradeSignal.new_price && tradeSignal.new_price !== 0) {
      throw new Error(`Missing required field: new_price`);
    }
    if (!tradeSignal.symbol) {
      throw new Error(`Missing required field: symbol`);
    }
    if (!tradeSignal.side) {
      throw new Error(`Missing required field: side`);
    }

    // Map side to Tradovate action for filtering
    let sideAction;
    if (tradeSignal.side === 'buy') sideAction = 'Buy';
    else if (tradeSignal.side === 'sell') sideAction = 'Sell';
    else throw new Error(`Invalid side: ${tradeSignal.side}. Expected 'buy' or 'sell'.`);

    // Get all open orders for the account
    const orders = await tradovateClient.getOrders(accountId);
    logger.info(`Found ${orders.length} total orders for account ${accountId}`);

    // Debug: Log first few orders to see their actual field names
    logger.info(`Debugging order field names (first 2):`);
    orders.slice(0, 2).forEach(order => {
      logger.info(`  Order ${order.id}: Fields available: ${Object.keys(order).join(', ')}`);
    });

    // Try different field name variations for status and type
    const workingOrders = orders.filter(order =>
      (order.orderStatus === 'Working' || order.ordStatus === 'Working' || order.status === 'Working')
    );
    logger.info(`Working orders: ${workingOrders.length}`);
    workingOrders.forEach(order => {
      const status = order.orderStatus || order.ordStatus || order.status;
      const type = order.orderType || order.ordType || order.type;
      logger.info(`  Order ${order.id}: ${order.action} ${order.contractId} ${type} at ${order.price} (status: ${status})`);
    });

    // Look up the numeric contract ID for comparison
    const contractSymbol = tradovateClient.mapToFullContractSymbol(tradeSignal.symbol);
    const contractInfo = await tradovateClient.findContract(tradeSignal.symbol);
    const expectedContractId = contractInfo.id;
    logger.info(`Looking for: ${sideAction} ${contractSymbol} (contractId: ${expectedContractId}) Limit orders`);

    // First, check for ANY working limit orders for this symbol/side
    // Note: We identify limit orders by having a price field and Working status
    const workingLimitOrders = orders.filter(order => {
      return order.ordStatus === 'Working' &&
             order.price &&  // Limit orders have a price
             order.contractId === expectedContractId &&
             order.action === sideAction;
    });

    logger.info(`Found ${workingLimitOrders.length} working limit orders matching ${sideAction} ${expectedContractId}`);

    // If no working orders at all, fallback to place_limit
    if (workingLimitOrders.length === 0) {
      logger.warn(`No working limit orders found for ${tradeSignal.symbol} ${tradeSignal.side}`);
      logger.info(`🔄 Falling back to place_limit with price ${tradeSignal.new_price}`);

      // Convert to a place_limit order with the new price
      const fallbackSignal = {
        ...tradeSignal,
        action: 'place_limit',
        price: tradeSignal.new_price  // Use the new_price as the limit price
      };

      // Call the place limit handler (which will handle duplicates)
      await handlePlaceLimitOrder(fallbackSignal, accountId, webhookId);

      logger.info(`✅ Placed new limit order (fallback from update_limit)`);
      return;
    }

    // Now check for orders matching the old price
    const matchingOrders = workingLimitOrders.filter(order => {
      return Math.abs(order.price - tradeSignal.old_price) < 0.01; // Allow small floating point tolerance
    });

    if (matchingOrders.length === 0) {
      // We have working orders but none at the old price - don't create duplicates!
      const existingPrices = workingLimitOrders.map(o => o.price).join(', ');
      logger.warn(`⚠️ Found ${workingLimitOrders.length} working order(s) at price(s) [${existingPrices}], but none at ${tradeSignal.old_price}`);
      logger.warn(`⚠️ Skipping update to avoid order stacking. Consider cancelling existing orders first.`);

      // Publish a warning event but don't throw an error
      await messageBus.publish(CHANNELS.ORDER_REJECTED, {
        accountId: accountId,
        symbol: tradeSignal.symbol,
        side: tradeSignal.side,
        action: 'update_limit',
        reason: 'price_mismatch',
        message: `Working order exists but at different price. Expected ${tradeSignal.old_price}, found ${existingPrices}`,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (matchingOrders.length > 1) {
      logger.warn(`Found multiple matching orders (${matchingOrders.length}), updating the first one`);
    }

    const orderToUpdate = matchingOrders[0];
    logger.info(`Found order ${orderToUpdate.id} to update: ${orderToUpdate.action} ${orderToUpdate.contractId} at ${orderToUpdate.price}`);

    // Build the update request
    const updateRequest = {
      orderId: orderToUpdate.id,
      price: tradeSignal.new_price,
      quantity: tradeSignal.quantity || orderToUpdate.qty, // qty is the correct field name
      orderType: 'Limit' // Required by Tradovate API
    };

    // Note: For bracket orders, we can only modify the main order price
    // Bracket components (stop loss, take profit) cannot be modified via /order/modifyorder
    // If bracket modifications are needed, the entire strategy would need to be cancelled and recreated
    if (tradeSignal.stop_loss !== undefined || tradeSignal.take_profit !== undefined) {
      logger.warn(`⚠️ Bracket order modifications not supported via update_limit. Only updating main order price.`);
    }

    // Perform the order update
    const updatedOrder = await tradovateClient.modifyOrder(updateRequest);

    logger.info(`✅ Successfully updated order ${orderToUpdate.id}:`);
    logger.info(`   Price: ${orderToUpdate.price} → ${tradeSignal.new_price}`);
    if (tradeSignal.stop_loss !== undefined) {
      logger.info(`   Stop Loss: ${tradeSignal.stop_loss}`);
    }
    if (tradeSignal.take_profit !== undefined) {
      logger.info(`   Take Profit: ${tradeSignal.take_profit}`);
    }

    // Debug: Check what updatedOrder contains
    logger.info(`🔍 DEBUG: updatedOrder response:`, JSON.stringify(updatedOrder, null, 2));

    // Publish order update event with comprehensive field mapping
    // Use original order ID since modifyOrder response might not contain id
    try {
      const orderUpdateEvent = {
        accountId: accountId,
        orderId: orderToUpdate.id, // Use original order ID
        symbol: tradeSignal.symbol,
        contractId: orderToUpdate.contractId,
        contractName: tradeSignal.symbol,
        side: tradeSignal.side,
        action: 'update_limit', // Keep action as update_limit for tracking
        orderType: 'Limit',
        price: tradeSignal.new_price, // Use new price as the current price
        oldPrice: tradeSignal.old_price,
        newPrice: tradeSignal.new_price,
        quantity: updateRequest.quantity,
        stopPrice: updateRequest.stopPrice,
        takeProfit: updateRequest.takeProfit,
        status: 'working', // Order is still working after update
        orderStatus: 'Working', // Tradovate format
        strategy: tradeSignal.strategy || 'unknown',
        webhookId: webhookId,
        timestamp: new Date().toISOString(),
        source: 'strategy_order_update', // Mark as strategy update for priority handling
        updateType: 'price_modification' // Specific update type
      };

      logger.info(`📤 Publishing ORDER_PLACED event for updated order ${orderToUpdate.id} with price ${tradeSignal.new_price}`);
      await messageBus.publish(CHANNELS.ORDER_PLACED, orderUpdateEvent);
      logger.info(`✅ ORDER_PLACED event published successfully for order ${orderToUpdate.id}`);
    } catch (error) {
      logger.error(`❌ Failed to publish ORDER_PLACED event for updated order:`, error);
    }

    // Refresh account balance after update
    logger.info(`💰 Refreshing account balance after order update for account ${accountId}`);
    try {
      const [accountData, cashData] = await Promise.all([
        tradovateClient.getAccountBalances(accountId),
        tradovateClient.getCashBalances(accountId)
      ]);

      await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
        accountId: accountId,
        accountName: `Account ${accountId}`,
        accountData,
        cashData,
        timestamp: new Date().toISOString(),
        source: 'post_update_refresh'
      });
      logger.info(`✅ Account balance refreshed after order update`);
    } catch (error) {
      logger.error(`❌ Failed to refresh account balance after update:`, error);
    }

  } catch (error) {
    logger.error('Failed to update limit order:', {
      error: error.message,
      symbol: tradeSignal.symbol,
      side: tradeSignal.side,
      oldPrice: tradeSignal.old_price,
      newPrice: tradeSignal.new_price
    });
    throw error;
  }
}

// Handle position_closed action from LDPS Trader - liquidate position and cancel orders
async function handlePositionClosed(tradeSignal, accountId, webhookId) {
  logger.info(`Processing position_closed: ${tradeSignal.side} ${tradeSignal.symbol} - liquidating position`);

  try {
    // Find the contract to get contractId
    const contractResponse = await tradovateClient.findContract(tradeSignal.symbol);

    let contractId;
    if (Array.isArray(contractResponse) && contractResponse.length > 0) {
      contractId = contractResponse[0].id;
    } else if (contractResponse && contractResponse.id) {
      contractId = contractResponse.id;
    } else {
      throw new Error(`Contract not found for ${tradeSignal.symbol}`);
    }

    logger.info(`📋 Using liquidatePosition API for accountId=${accountId}, contractId=${contractId}`);

    // Use Tradovate's liquidatePosition API - cancels all orders AND closes position
    const result = await tradovateClient.liquidatePosition(accountId, contractId);

    logger.info(`✅ Position liquidated successfully for ${tradeSignal.symbol}`);

    // Publish position closure event
    await messageBus.publish(CHANNELS.POSITION_CLOSED, {
      accountId: accountId,
      symbol: tradeSignal.symbol,
      side: tradeSignal.side,
      contractId: contractId,
      liquidationResult: result,
      strategy: tradeSignal.strategy,
      source: 'ldps_trader',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to liquidate position:', error);

    // Check if error is because no position exists
    if (error.message.includes('404') || error.message.includes('not found')) {
      logger.warn(`⚠️ No position found to liquidate for ${tradeSignal.symbol} - this may be expected`);

      // Still publish event indicating the liquidation attempt
      await messageBus.publish(CHANNELS.POSITION_CLOSED, {
        accountId: accountId,
        symbol: tradeSignal.symbol,
        side: tradeSignal.side,
        message: 'No position found to liquidate',
        strategy: tradeSignal.strategy,
        source: 'ldps_trader',
        timestamp: new Date().toISOString()
      });
    } else {
      throw error;
    }
  }
}

// Periodic updates
function startPeriodicUpdates() {
  // Aggressive polling disabled - WebSocket provides real-time updates via user/syncrequest
  // Position updates (5s), account balance updates (30s), and order sync (60s) are now handled via WebSocket events

  logger.info('📡 Periodic polling disabled - using WebSocket real-time updates');
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

    // Set up Tradovate event forwarding BEFORE connecting
    tradovateClient.on('orderPlaced', async (data) => {
      await messageBus.publish(CHANNELS.ORDER_PLACED, data);
    });

    tradovateClient.on('orderFilled', async (data) => {
      await messageBus.publish(CHANNELS.ORDER_FILLED, data);
    });

    tradovateClient.on('positionOpened', async (data) => {
      await messageBus.publish(CHANNELS.POSITION_OPENED, data);
    });

    tradovateClient.on('positionClosed', async (data) => {
      await messageBus.publish(CHANNELS.POSITION_CLOSED, data);
    });

    // Handle orderStrategy placement to track relationships
    tradovateClient.on('orderStrategyPlaced', async (data) => {
      logger.info(`🔗 OrderStrategy placed: ${data.id}`);

      // We'll need to track the resulting orders when they appear
      // The strategy ID can be used to link orders together later
      const strategyInfo = {
        strategyId: data.id,
        timestamp: new Date().toISOString(),
        // We'll populate order IDs as they get created
        entryOrderId: null,
        stopOrderId: null,
        targetOrderId: null,
        isTrailing: data.hasTrailingStop || false
      };

      orderStrategyLinks.set(data.id, strategyInfo);
      logger.info(`🔗 Tracking orderStrategy: ${data.id}`);
    });

    // Handle WebSocket order updates (critical for orderStrategy tracking)
    tradovateClient.on('orderUpdate', async (data) => {
      logger.info(`📋 Order update event: ${data.eventType} for order ${data.entity.id}`);

      const order = data.entity;

      // Detect bracket orders by checking if this order might be part of an orderStrategy
      let orderRole = 'entry'; // Default
      let parentOrderId = null;
      let strategyId = null;

      // Enhanced order role detection - check order text for clues
      const orderText = order.text || order.description || '';
      const isTrailingStop = orderText.toLowerCase().includes('trail') || order.isAutoTrade;

      // Try to determine if this is a bracket order based on order type and timing
      if (order.orderType === 'Stop' || (order.orderType === 'StopLimit' && order.stopPrice)) {
        orderRole = 'stop_loss';
        logger.info(`🛑 Detected STOP order ${order.id} (type: ${order.orderType}, trailing: ${isTrailingStop})`);
      } else if (order.orderType === 'Limit' && order.stopPrice) {
        // This might be a trailing stop order that has been converted
        orderRole = 'stop_loss';
        logger.info(`🛑 Detected converted trailing STOP order ${order.id}`);
      } else if (order.orderType === 'Limit' && !order.stopPrice) {
        // This might be a profit target order
        // We need more logic to distinguish between entry and profit target
        const recentStrategies = Array.from(orderStrategyLinks.values())
          .filter(s => Date.now() - new Date(s.timestamp).getTime() < 60000); // Within last minute

        if (recentStrategies.length > 0) {
          const strategy = recentStrategies[0];
          if (!strategy.targetOrderId && strategy.entryOrderId) {
            orderRole = 'take_profit';
            strategyId = strategy.strategyId;
            logger.info(`🎯 Detected TARGET order ${order.id} for strategy`);
          }
        }
      }

      // Track the order in strategy links if we can identify it
      if (strategyId || orderRole !== 'entry') {
        const recentStrategies = Array.from(orderStrategyLinks.values())
          .filter(s => Date.now() - new Date(s.timestamp).getTime() < 60000);

        for (const strategy of recentStrategies) {
          if (orderRole === 'entry' && !strategy.entryOrderId) {
            strategy.entryOrderId = order.id;
            strategy.symbol = order.contractName || order.symbol;
            logger.info(`🔗 Linked entry order ${order.id} to strategy ${strategy.strategyId}`);
            break;
          } else if (orderRole === 'stop_loss' && !strategy.stopOrderId) {
            strategy.stopOrderId = order.id;
            strategy.isTrailing = isTrailingStop;
            logger.info(`🔗 Linked stop order ${order.id} to strategy ${strategy.strategyId} (trailing: ${isTrailingStop})`);
            break;
          } else if (orderRole === 'take_profit' && !strategy.targetOrderId) {
            strategy.targetOrderId = order.id;
            logger.info(`🔗 Linked target order ${order.id} to strategy ${strategy.strategyId}`);
            break;
          }
        }
      }

      // Check if this is a fill event
      if (order.ordStatus === 'Filled') {
        logger.info(`✅ Order filled: ${order.id} (role: ${orderRole})`);

        // Enrich the order data if needed
        try {
          const enrichedOrder = await tradovateClient.handleOrderUpdate(order, data.eventType);

          await messageBus.publish(CHANNELS.ORDER_FILLED, {
            orderId: enrichedOrder.id,
            accountId: enrichedOrder.accountId,
            symbol: enrichedOrder.symbol || enrichedOrder.contractName,
            action: enrichedOrder.action,
            quantity: enrichedOrder.qty || enrichedOrder.orderQty,
            fillPrice: enrichedOrder.avgFillPrice || enrichedOrder.price,
            status: 'filled',
            parentOrderId: parentOrderId,
            orderRole: orderRole,
            timestamp: new Date().toISOString(),
            source: 'websocket_order_update'
          });

          // Refresh account balance after fill
          logger.info(`💰 Refreshing account balance after order fill for account ${enrichedOrder.accountId}`);
          try {
            const [accountData, cashData] = await Promise.all([
              tradovateClient.getAccountBalances(enrichedOrder.accountId),
              tradovateClient.getCashBalances(enrichedOrder.accountId)
            ]);

            await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
              accountId: enrichedOrder.accountId,
              accountName: enrichedOrder.accountName || `Account ${enrichedOrder.accountId}`,
              accountData,
              cashData,
              timestamp: new Date().toISOString(),
              source: 'post_fill_refresh'
            });
            logger.info(`✅ Account balance refreshed after fill`);
          } catch (error) {
            logger.error(`❌ Failed to refresh account balance after fill:`, error);
          }

          // Check if stop/target fill closes position
          if (orderRole === 'stop_loss' || orderRole === 'take_profit') {
            logger.info(`🔍 ${orderRole} filled - scheduling position check for contract ${order.contractId}`);

            setTimeout(async () => {
              try {
                const positions = await tradovateClient.getPositions(order.accountId);
                const position = positions.find(pos => pos.contractId === order.contractId);

                if (!position || position.netPos === 0) {
                  logger.info(`✅ Position CLOSED after ${orderRole} fill`);

                  // Resolve symbol
                  let symbol = enrichedOrder.symbol || enrichedOrder.contractName;
                  if (!symbol && order.contractId) {
                    try {
                      const contractDetails = await tradovateClient.getContractDetails(order.contractId);
                      symbol = contractDetails?.name || `CONTRACT_${order.contractId}`;
                    } catch (err) {
                      symbol = `CONTRACT_${order.contractId}`;
                    }
                  }

                  await messageBus.publish(CHANNELS.POSITION_CLOSED, {
                    accountId: order.accountId,
                    contractId: order.contractId,
                    symbol: symbol,
                    closedByOrder: order.id,
                    orderType: orderRole,
                    fillPrice: enrichedOrder.avgFillPrice || enrichedOrder.price,
                    timestamp: new Date().toISOString(),
                    source: 'order_update_position_check'
                  });

                  logger.info(`📉 Published POSITION_CLOSED for ${symbol} after ${orderRole} fill`);
                }
              } catch (error) {
                logger.error(`Failed to check position after ${orderRole} fill:`, error);
              }
            }, 2000);
          }
        } catch (error) {
          logger.error(`Failed to process order fill for ${order.id}:`, error);
        }
      } else if (order.ordStatus === 'Working') {
        logger.info(`📝 Order working: ${order.id} (role: ${orderRole})`);

        // Publish working order with bracket info
        await messageBus.publish(CHANNELS.ORDER_PLACED, {
          orderId: order.id,
          accountId: order.accountId,
          symbol: order.contractName || order.symbol,
          action: order.action,
          quantity: order.qty || order.orderQty,
          orderType: order.orderType,
          price: order.price || order.limitPrice,
          stopPrice: order.stopPrice,
          status: 'working',
          parentOrderId: parentOrderId,
          orderRole: orderRole,
          timestamp: new Date().toISOString(),
          source: 'websocket_order_update'
        });
      }
    });

    // Handle WebSocket position updates
    tradovateClient.on('positionUpdate', async (data) => {
      logger.info(`📊 Position update event: ${data.eventType} for position ${data.entity.id}`);

      const position = data.entity;

      // Resolve contract ID to symbol
      let symbol = 'Unknown';
      try {
        const contractDetails = await tradovateClient.getContractDetails(position.contractId);
        symbol = contractDetails.name || contractDetails.symbol || `CONTRACT_${position.contractId}`;
        logger.info(`✅ Resolved contract ${position.contractId} to symbol: ${symbol}`);
      } catch (error) {
        logger.warn(`Failed to resolve contract ${position.contractId}: ${error.message}`);
        symbol = `CONTRACT_${position.contractId}`;
      }

      // Only process positions with non-zero netPos
      if (position.netPos !== 0) {
        // Enhance position with resolved symbol
        const enrichedPosition = {
          ...position,
          symbol: symbol,
          contractName: symbol
        };

        await messageBus.publish(CHANNELS.POSITION_UPDATE, {
          accountId: position.accountId,
          positions: [enrichedPosition],
          timestamp: new Date().toISOString(),
          source: 'websocket_position_update'
        });

        logger.info(`📈 Published position update: ${symbol} (Contract ${position.contractId}), NetPos: ${position.netPos}`);
      } else if (data.eventType === 'Closed' || position.netPos === 0) {
        // Position was closed
        await messageBus.publish(CHANNELS.POSITION_CLOSED, {
          accountId: position.accountId,
          contractId: position.contractId,
          symbol: symbol,
          timestamp: new Date().toISOString(),
          source: 'websocket_position_update'
        });

        logger.info(`📉 Published position closed: ${symbol} (Contract ${position.contractId})`);
      }
    });

    // Handle WebSocket execution reports (fills from orderStrategy)
    tradovateClient.on('executionUpdate', async (data) => {
      logger.info(`🎯 Execution report event: ${data.eventType} for execution ${data.entity.id}`);

      const execution = data.entity;
      logger.info(`🔍 Execution data: execType=${execution.execType}, orderId=${execution.orderId}, cumQty=${execution.cumQty}, avgPx=${execution.avgPx}`);
      logger.info(`🔍 Full execution object: ${JSON.stringify(execution, null, 2)}`);

      // ExecutionReport indicates an order fill - check all possible execType values
      // "New" = order acknowledged, "Trade"/"Fill"/"F" = order filled
      if (execution.execType === 'Trade' || execution.execType === 'Fill' || execution.execType === 'F') {
        logger.info(`✅ Execution fill detected: Order ${execution.orderId}, Qty: ${execution.cumQty}, ExecType: ${execution.execType}`);

        // Resolve contractId to symbol
        let symbol = null;
        if (execution.contractId) {
          try {
            const contractDetails = await tradovateClient.getContractDetails(execution.contractId);
            symbol = contractDetails?.name;
            logger.info(`🔍 Resolved contractId ${execution.contractId} to symbol: ${symbol}`);
          } catch (error) {
            logger.warn(`⚠️ Failed to resolve contractId ${execution.contractId}:`, error.message);
          }
        }

        // Look up the signalId for this order
        let signalId = orderSignalMap.get(execution.orderId);

        // If no direct mapping, check if this is a child order from an OrderStrategy
        if (!signalId) {
          // Check if this order belongs to any tracked OrderStrategy
          for (const [strategyId, strategyInfo] of strategyChildMap.entries()) {
            // Add this child order to the strategy's child set
            strategyInfo.childOrderIds.add(execution.orderId);
            signalId = strategyInfo.signalId;
            logger.info(`🎯 Mapped child order ${execution.orderId} to parent strategy ${strategyId} → signal ${signalId}`);
            break; // Use the first (most recent) strategy - could be enhanced with better matching
          }
        }

        if (signalId) {
          logger.info(`🎯 Found signal mapping for filled order ${execution.orderId}: signal ${signalId}`);
        } else {
          logger.warn(`⚠️ No signal mapping found for filled order ${execution.orderId} - signal context will be lost`);
        }

        // Check if this order is a stop or target from an OrderStrategy
        let isStopOrder = false;
        let isTargetOrder = false;
        for (const [strategyId, strategyLinks] of orderStrategyLinks.entries()) {
          if (strategyLinks.stopOrderId === execution.orderId) {
            isStopOrder = true;
            logger.info(`🛑 Identified order ${execution.orderId} as STOP ORDER from strategy ${strategyId}`);
            break;
          } else if (strategyLinks.targetOrderId === execution.orderId) {
            isTargetOrder = true;
            logger.info(`🎯 Identified order ${execution.orderId} as TARGET ORDER from strategy ${strategyId}`);
            break;
          }
        }

        // LOG EVERY SINGLE FIELD from execution report for analysis
        logger.info(`🔬 COMPLETE EXECUTION REPORT ANALYSIS:`);
        logger.info(`🔬 Raw execution object keys: ${Object.keys(execution).join(', ')}`);
        for (const [key, value] of Object.entries(execution)) {
          logger.info(`🔬 execution.${key} = ${value} (type: ${typeof value})`);
        }

        // The action is in execution.action field (Buy/Sell)
        let action = execution.action || execution.side || execution.buySell || execution.orderSide || execution.direction;

        logger.info(`🔍 Action determination: side=${execution.side}, action=${execution.action}, buySell=${execution.buySell}, orderSide=${execution.orderSide}, direction=${execution.direction}`);
        logger.info(`🔍 Final action: ${action || 'UNDEFINED'}`);

        await messageBus.publish(CHANNELS.ORDER_FILLED, {
          orderId: execution.orderId,
          accountId: execution.accountId,
          contractId: execution.contractId,
          symbol: symbol,
          action: action,  // Will be undefined if we can't determine it
          quantity: execution.lastQty || execution.cumQty,  // Use incremental qty, fallback to cumQty
          fillPrice: execution.avgPx || execution.price,
          status: 'filled',
          timestamp: execution.timestamp || new Date().toISOString(),
          source: 'websocket_execution_report',
          signalId: signalId,  // Include the original signal ID!
          isStopOrder: isStopOrder,
          isTargetOrder: isTargetOrder,
          cumQty: execution.cumQty,  // Also send cumulative for reference
          lastQty: execution.lastQty  // And the incremental quantity
        });

        // Clean up the mapping since order is now filled
        if (signalId) {
          orderSignalMap.delete(execution.orderId);
          logger.info(`🧹 Cleaned up signal mapping for filled order ${execution.orderId}`);
        }

        logger.info(`📊 Published execution fill for order ${execution.orderId} with symbol: ${symbol}`);

        // Check position state after execution fill to detect position closures
        try {
          const positions = await tradovateClient.getPositions(execution.accountId);
          const position = positions?.find(pos => pos.contractId === execution.contractId);

          if (!position || position.netPos === 0) {
            // Position was closed by this execution
            logger.info(`🔒 Position closed by execution - publishing POSITION_CLOSED for ${symbol}`);
            await messageBus.publish(CHANNELS.POSITION_CLOSED, {
              accountId: execution.accountId,
              contractId: execution.contractId,
              symbol: symbol,
              timestamp: new Date().toISOString(),
              source: 'execution_fill_close'
            });
          } else {
            logger.info(`📈 Position still open after execution: ${symbol} netPos=${position.netPos}`);
          }
        } catch (error) {
          logger.warn(`⚠️ Failed to check position state after execution fill: ${error.message}`);
        }

        // Refresh account balance after execution fill
        logger.info(`💰 Refreshing account balance after execution fill for account ${execution.accountId}`);
        try {
          const [accountData, cashData] = await Promise.all([
            tradovateClient.getAccountBalances(execution.accountId),
            tradovateClient.getCashBalances(execution.accountId)
          ]);

          await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
            accountId: execution.accountId,
            accountName: `Account ${execution.accountId}`,
            accountData,
            cashData,
            timestamp: new Date().toISOString(),
            source: 'post_execution_refresh'
          });
          logger.info(`✅ Account balance refreshed after execution fill`);
        } catch (error) {
          logger.error(`❌ Failed to refresh account balance after execution fill:`, error);
        }

        // IMPORTANT: Check if this fill closes a position (stop or target fills)
        if ((isStopOrder || isTargetOrder) && execution.accountId && execution.contractId) {
          logger.info(`🔍 Stop/Target filled - checking if position is closed for contract ${execution.contractId}`);

          // Wait a brief moment for Tradovate to update position state
          setTimeout(async () => {
            try {
              // Get current positions for this account
              const positions = await tradovateClient.getPositions(execution.accountId);

              // Find position for this contract
              const position = positions.find(pos => pos.contractId === execution.contractId);

              if (!position || position.netPos === 0) {
                logger.info(`✅ Position CLOSED after stop/target fill for contract ${execution.contractId}`);

                // Publish position closed event
                await messageBus.publish(CHANNELS.POSITION_CLOSED, {
                  accountId: execution.accountId,
                  contractId: execution.contractId,
                  symbol: symbol,
                  closedByOrder: execution.orderId,
                  orderType: isStopOrder ? 'stop' : 'target',
                  fillPrice: execution.avgPx || execution.price,
                  timestamp: new Date().toISOString(),
                  source: 'stop_fill_position_check',
                  signalId: signalId
                });

                logger.info(`📉 Published POSITION_CLOSED for ${symbol} after ${isStopOrder ? 'stop' : 'target'} fill`);
              } else {
                logger.info(`📊 Position still open: ${symbol} netPos=${position.netPos}`);
              }
            } catch (error) {
              logger.error(`❌ Failed to check position after stop/target fill:`, error);
            }
          }, 2000); // 2 second delay to allow Tradovate to update
        }
      } else if (execution.execType === 'New') {
        logger.info(`📝 Execution report: New order acknowledged for order ${execution.orderId}`);
      } else if (execution.execType === 'Canceled' || execution.execType === 'Cancelled') {
        logger.info(`❌ Order cancelled: ${execution.orderId}`);

        await messageBus.publish(CHANNELS.ORDER_CANCELLED, {
          orderId: execution.orderId,
          accountId: execution.accountId,
          timestamp: execution.timestamp || new Date().toISOString(),
          source: 'websocket_execution_report'
        });

        logger.info(`📊 Published order cancelled for order ${execution.orderId}`);
      } else {
        logger.info(`⚠️ Execution report with unknown execType: ${execution.execType}`);
      }
    });

    // Handle orderStrategy WebSocket updates (for detecting strategy completion)
    tradovateClient.on('orderStrategyUpdate', async (data) => {
      logger.info(`📋 OrderStrategy update event: ${data.eventType} for strategy ${data.entity.id}`);
      logger.info(`📋 Strategy details: status=${data.entity.status}, accountId=${data.entity.accountId}, contractId=${data.entity.contractId || 'undefined'}`);
      logger.warn(`🔍 DEBUG: OrderStrategy status: ${data.entity.status}`);

      const strategy = data.entity;

      // Check if the strategy is completed/closed/interrupted
      // API statuses: ExecutionFinished, ExecutionInterrupted, ExecutionFailed, Canceled, StoppedByUser
      if (data.eventType === 'Updated' && (
        strategy.status === 'ExecutionFinished' ||
        strategy.status === 'ExecutionInterrupted' ||
        strategy.status === 'ExecutionFailed' ||
        strategy.status === 'Canceled' ||
        strategy.status === 'StoppedByUser'
      )) {
        logger.info(`🔚 OrderStrategy ${strategy.id} completed with status: ${strategy.status}`);

        // Enhanced cleanup: Get child orders from the strategy and cancel them explicitly
        await cleanupOrderStrategyChildren(strategy);

        // Also run general orphaned order cleanup as a fallback
        await cleanupOrphanedBracketOrders(strategy);

        // Notify trade-orchestrator about strategy cancellation
        await messageBus.publish(CHANNELS.ORDER_CANCELLED, {
          orderId: strategy.id,
          strategyId: strategy.id,
          accountId: strategy.accountId,
          timestamp: new Date().toISOString(),
          source: 'websocket_orderStrategy_status',
          status: strategy.status
        });

        // Refresh account balance after strategy completion/cancellation
        logger.info(`💰 Refreshing account balance after strategy ${strategy.status.toLowerCase()} for account ${strategy.accountId}`);
        try {
          const [accountData, cashData] = await Promise.all([
            tradovateClient.getAccountBalances(strategy.accountId),
            tradovateClient.getCashBalances(strategy.accountId)
          ]);

          await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
            accountId: strategy.accountId,
            accountName: `Account ${strategy.accountId}`,
            accountData,
            cashData,
            timestamp: new Date().toISOString(),
            source: 'post_strategy_completion'
          });
          logger.info(`✅ Account balance refreshed after strategy ${strategy.status.toLowerCase()}`);
        } catch (error) {
          logger.error(`❌ Failed to refresh account balance after strategy completion:`, error);
        }

        // Find and remove from our tracking
        const strategyInfo = orderStrategyLinks.get(strategy.id);
        if (strategyInfo) {
          logger.info(`🔗 Found tracked strategy info: ${JSON.stringify(strategyInfo)}`);

          // Publish strategy completion event
          await messageBus.publish('strategy_completed', {
            strategyId: strategy.id,
            status: strategy.status,
            symbol: strategyInfo.symbol,
            timestamp: new Date().toISOString(),
            source: 'orderStrategy_websocket'
          });

          // Clean up tracking
          orderStrategyLinks.delete(strategy.id);
          logger.info(`🧹 Removed completed strategy ${strategy.id} from tracking`);
        }
      }
    });

    // Handle initial WebSocket sync data BEFORE connecting
    tradovateClient.on('initialSync', async (syncData) => {
      logger.info('📊 Processing WebSocket initial sync data...');

      try {
        // Process accounts and cash balances
        if (syncData.accounts && syncData.cashBalances) {
          const accountMap = new Map(syncData.accounts.map(acc => [acc.id, acc]));
          const cashMap = new Map(syncData.cashBalances.map(cash => [cash.accountId, cash]));

          for (const account of syncData.accounts) {
            const cashBalance = cashMap.get(account.id);

            if (cashBalance) {
              await messageBus.publish(CHANNELS.ACCOUNT_UPDATE, {
                accountId: account.id,
                accountName: account.name,
                balance: cashBalance.amount,
                realizedPnL: cashBalance.realizedPnL,
                weekRealizedPnL: cashBalance.weekRealizedPnL,
                marginUsed: 0, // Will be updated from margin snapshots if available
                marginAvailable: cashBalance.amount,
                timestamp: new Date().toISOString(),
                source: 'websocket_sync'
              });

              logger.info(`📊 Published account data: ${account.name} (${account.id}) - Balance: $${cashBalance.amount}`);
            }
          }
        }

        // Process positions
        if (syncData.positions) {
          logger.info(`📊 Raw position data (${syncData.positions.length} positions):`,
            syncData.positions.map(pos => ({
              id: pos.id,
              contractId: pos.contractId,
              netPos: pos.netPos,
              type: typeof pos.netPos
            }))
          );

          const positionsWithSymbols = syncData.positions.filter(pos =>
            pos.netPos !== 0 ||
            pos.bought > 0 ||
            pos.sold > 0 ||
            pos.boughtValue > 0 ||
            pos.soldValue > 0
          );

          for (const position of positionsWithSymbols) {
            // Resolve contract ID to symbol
            let symbol = 'Unknown';
            try {
              const contractDetails = await tradovateClient.getContractDetails(position.contractId);
              symbol = contractDetails.name || contractDetails.symbol || `CONTRACT_${position.contractId}`;
              logger.info(`✅ Resolved sync contract ${position.contractId} to symbol: ${symbol}`);
            } catch (error) {
              logger.warn(`Failed to resolve sync contract ${position.contractId}: ${error.message}`);
              symbol = `CONTRACT_${position.contractId}`;
            }

            // Enhanced logging for position updates
            logger.info(`📊 Publishing position update: ${symbol} netPos=${position.netPos}, netPrice=${position.netPrice || 'undefined'}, bought=${position.bought}, sold=${position.sold}`);

            await messageBus.publish(CHANNELS.POSITION_UPDATE, {
              accountId: position.accountId,
              positionId: position.id,
              contractId: position.contractId,
              symbol: symbol, // Now properly resolved
              contractName: symbol,
              netPos: position.netPos,
              netPrice: position.netPrice, // Include entry price data
              bought: position.bought,
              boughtValue: position.boughtValue,
              sold: position.sold,
              soldValue: position.soldValue,
              timestamp: new Date().toISOString(),
              source: 'websocket_sync'
            });
          }

          logger.info(`📊 Published ${positionsWithSymbols.length} positions from WebSocket sync`);
        }

        // Process working orders
        if (syncData.orders) {
          // Log first order to see what fields are available
          if (syncData.orders.length > 0) {
            logger.debug('📋 Sample order fields:', JSON.stringify(syncData.orders[0], null, 2));
          }

          // Only include orders that are truly working (not filled or cancelled)
          const workingOrders = syncData.orders.filter(order =>
            order.ordStatus === 'Working' &&
            !order.filledTimestamp &&
            !order.cancelledTimestamp &&
            (!order.filledQty || order.filledQty < (order.qty || 1))
          );

          logger.info(`📋 Filtered ${workingOrders.length} truly working orders from ${syncData.orders.length} total orders`);

          for (const order of workingOrders) {
            await messageBus.publish(CHANNELS.ORDER_PLACED, {
              orderId: order.id,
              accountId: order.accountId,
              contractId: order.contractId,
              symbol: 'Unknown', // Will be enriched if needed
              action: order.action,
              quantity: order.qty || 1,
              orderType: order.orderType || 'Unknown',
              price: order.limitPrice || 0,
              stopPrice: order.stopPrice,
              status: 'working',
              orderStatus: order.ordStatus,
              timestamp: new Date().toISOString(),
              source: 'websocket_sync'
            });
          }

          logger.info(`📊 Published ${workingOrders.length} working orders from WebSocket sync`);

          // Publish sync completion with current working order IDs for reconciliation
          const workingOrderIds = workingOrders.map(order => order.id);
          await messageBus.publish(CHANNELS.TRADOVATE_SYNC_COMPLETED, {
            workingOrderIds,
            timestamp: new Date().toISOString(),
            source: 'tradovate_initial_sync'
          });

          logger.info(`📋 Published sync completion with ${workingOrderIds.length} working order IDs for reconciliation`);
        } else {
          // Even if no orders, publish sync completion for reconciliation
          await messageBus.publish(CHANNELS.TRADOVATE_SYNC_COMPLETED, {
            workingOrderIds: [],
            timestamp: new Date().toISOString(),
            source: 'tradovate_initial_sync'
          });

          logger.info('📋 Published sync completion with 0 working orders for reconciliation');
        }

        logger.info('✅ WebSocket initial sync data processing completed');
      } catch (error) {
        logger.error('❌ Error processing WebSocket sync data:', error);
      }
    });

    // Connect to Tradovate
    if (config.tradovate.username && config.tradovate.password) {
      logger.info('Connecting to Tradovate...');
      await tradovateClient.connect();
      logger.info('Tradovate connected');

      // Start periodic updates
      startPeriodicUpdates();

      // Perform initial data sync
      logger.info('Performing initial data sync...');
      // Skip REST API account/position updates - WebSocket provides this data
      // await handleAccountUpdate();
      // await handlePositionUpdate();

      // Sync existing orders and positions from Tradovate
      await syncExistingData();

      logger.info('Initial data sync completed');

      // Initialize scheduled sync functionality
      // Can be configured via environment variables
      const syncIntervalHours = parseInt(process.env.SYNC_INTERVAL_HOURS) || 6;
      const enableScheduledSync = process.env.ENABLE_SCHEDULED_SYNC !== 'false'; // Default enabled
      const enableMarketHoursSync = process.env.ENABLE_MARKET_HOURS_SYNC === 'true'; // Default disabled

      if (enableScheduledSync) {
        logger.info(`🔄 Enabling scheduled sync every ${syncIntervalHours} hours`);
        startScheduledSync(syncIntervalHours, true);
      }

      if (enableMarketHoursSync) {
        logger.info('🔄 Enabling market hours sync (5:15pm & 5:45pm EST)');
        startMarketHoursSync(true);
      }
    } else {
      logger.warn('Tradovate credentials not configured');
    }

    // Subscribe to message bus channels
    await messageBus.subscribe(CHANNELS.ORDER_REQUEST, handleOrderRequest);
    logger.info(`Subscribed to ${CHANNELS.ORDER_REQUEST}`);

    await messageBus.subscribe(CHANNELS.ORDER_CANCEL_REQUEST, handleOrderCancelRequest);
    logger.info(`Subscribed to ${CHANNELS.ORDER_CANCEL_REQUEST}`);

    await messageBus.subscribe(CHANNELS.WEBHOOK_TRADE, handleWebhookTrade);
    logger.info(`Subscribed to ${CHANNELS.WEBHOOK_TRADE}`);

    // Subscribe to account sync requests
    await messageBus.subscribe('account.sync.request', handleAccountSyncRequest);
    logger.info('Subscribed to account.sync.request');

    // Subscribe to position sync requests
    await messageBus.subscribe(CHANNELS.POSITION_SYNC_REQUEST, handlePositionSyncRequest);
    logger.info(`Subscribed to ${CHANNELS.POSITION_SYNC_REQUEST}`);

    // Subscribe to full sync requests
    await messageBus.subscribe(CHANNELS.TRADOVATE_FULL_SYNC_REQUESTED, handleFullSyncRequest);
    logger.info(`Subscribed to ${CHANNELS.TRADOVATE_FULL_SYNC_REQUESTED}`);

    // Publish startup event
    await messageBus.publish(CHANNELS.SERVICE_STARTED, {
      service: SERVICE_NAME,
      port: config.service.port,
      tradovateConnected: tradovateClient.isConnected,
      environment: config.tradovate.useDemo ? 'demo' : 'live',
      timestamp: new Date().toISOString()
    });

    // Start Express server - bind to all interfaces for container networking
    const bindHost = process.env.BIND_HOST || '0.0.0.0';
    const server = app.listen(config.service.port, bindHost, () => {
      logger.info(`${SERVICE_NAME} listening on ${bindHost}:${config.service.port}`);
      logger.info(`Environment: ${config.service.env}`);
      logger.info(`Tradovate: ${config.tradovate.useDemo ? 'DEMO' : 'LIVE'} mode`);
      logger.info(`Health check: http://localhost:${config.service.port}/health`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received, starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Disconnect from Tradovate
      tradovateClient.disconnect();

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

// Enhanced OrderStrategy cleanup - get and cancel child orders explicitly
async function cleanupOrderStrategyChildren(strategy) {
  try {
    logger.info(`🧹 Getting child orders for strategy ${strategy.id}`);

    // Try to get child orders using OrderStrategy dependents API
    let childOrders = [];
    try {
      const dependents = await tradovateClient.getOrderStrategyDependents(strategy.id);
      childOrders = Array.isArray(dependents) ? dependents : [];
      logger.info(`📋 Found ${childOrders.length} child orders from strategy dependents`);
    } catch (error) {
      logger.warn(`⚠️ Failed to get strategy dependents: ${error.message}`);
    }

    // If we couldn't get dependents, look for child orders by orderStrategyId
    if (childOrders.length === 0) {
      try {
        const allOrders = await tradovateClient.getOrders(strategy.accountId);
        childOrders = allOrders.filter(order =>
          order.orderStrategyId === strategy.id &&
          (order.ordStatus === 'Working' || order.ordStatus === 'Placed')
        );
        logger.info(`📋 Found ${childOrders.length} child orders by orderStrategyId search`);
      } catch (error) {
        logger.warn(`⚠️ Failed to search for child orders: ${error.message}`);
      }
    }

    // Cancel all child orders
    for (const order of childOrders) {
      try {
        logger.info(`🗑️ Cancelling strategy child order ${order.id} (${order.ordType || 'Unknown'}) - parent strategy ${strategy.id} completed with ${strategy.status}`);
        await tradovateClient.cancelOrder(order.id);

        // Publish cancellation event
        await messageBus.publish(CHANNELS.ORDER_CANCELLED, {
          orderId: order.id,
          strategyId: strategy.id,
          accountId: order.accountId,
          reason: `Child order cleanup - parent strategy ${strategy.status}`,
          timestamp: new Date().toISOString(),
          source: 'strategy_child_cleanup'
        });
      } catch (error) {
        logger.error(`❌ Failed to cancel strategy child order ${order.id}:`, error.message);
      }
    }

    if (childOrders.length > 0) {
      logger.info(`✅ Strategy child cleanup complete: cancelled ${childOrders.length} child orders from strategy ${strategy.id}`);
    } else {
      logger.info(`✅ No child orders found for strategy ${strategy.id}`);
    }

  } catch (error) {
    logger.error(`❌ Failed to cleanup strategy children for ${strategy.id}:`, error.message);
  }
}

// Clean up orphaned bracket orders when a strategy completes
async function cleanupOrphanedBracketOrders(strategy) {
  try {
    logger.info(`🧹 Looking for orphaned bracket orders from strategy ${strategy.id}`);

    // Get all working orders for this account
    const orders = await tradovateClient.getOrders(strategy.accountId);

    let ordersToCancel = [];

    for (const order of orders) {
      // Check if this order is part of the completed strategy
      // OrderStrategy orders typically have a parent relationship or are created at the same time

      // Look for orders that might be bracket orders from this strategy:
      // 1. Stop/StopLimit orders without fills
      // 2. Limit orders that are still working from around the same time
      // 3. Orders that don't have an associated position

      if (order.ordStatus === 'Working') {
        // Check if this is likely a stop loss order
        const isStopOrder = order.ordType === 'Stop' || order.ordType === 'StopLimit' ||
                           order.stopPrice !== undefined;

        // Check if this is a bracket order by looking for orders without associated positions
        // In a properly closed strategy, the main position should be closed but stops might remain
        const hasMatchingPosition = await checkOrderHasMatchingPosition(order);

        if (isStopOrder && !hasMatchingPosition) {
          logger.info(`🎯 Found potential orphaned stop order: ${order.id} (${order.ordType}) for contract ${order.contractId}`);
          ordersToCancel.push(order);
        }
      }
    }

    logger.info(`🧹 Found ${ordersToCancel.length} potentially orphaned orders to cancel`);

    // Cancel the orphaned orders
    for (const order of ordersToCancel) {
      try {
        logger.info(`🗑️ Cancelling orphaned order ${order.id} (${order.ordType}) - strategy ${strategy.id} completed`);
        await tradovateClient.cancelOrder(order.id);

        // Publish cancellation event
        await messageBus.publish(CHANNELS.ORDER_CANCELLED, {
          orderId: order.id,
          strategyId: strategy.id,
          accountId: order.accountId,
          reason: `Bracket order cleanup after strategy ${strategy.status}`,
          timestamp: new Date().toISOString(),
          source: 'orphaned_order_cleanup'
        });
      } catch (error) {
        logger.error(`Failed to cancel orphaned order ${order.id}:`, error.message);
      }
    }

    if (ordersToCancel.length > 0) {
      logger.info(`✅ Cleanup complete: cancelled ${ordersToCancel.length} orphaned orders from strategy ${strategy.id}`);
    } else {
      logger.info(`✅ No orphaned orders found for strategy ${strategy.id}`);
    }

  } catch (error) {
    logger.error(`Failed to cleanup orphaned orders for strategy ${strategy.id}:`, error.message);
  }
}

// Helper function to check if an order has a matching open position
async function checkOrderHasMatchingPosition(order) {
  try {
    const positions = await tradovateClient.getPositions(order.accountId);

    // Look for a position with the same contract that's still open
    const matchingPosition = positions.find(pos =>
      pos.contractId === order.contractId &&
      Math.abs(pos.netPos) > 0
    );

    return !!matchingPosition;
  } catch (error) {
    logger.error(`Failed to check position for order ${order.id}:`, error.message);
    return false; // Assume no position if we can't check
  }
}

// Start the service
startup();