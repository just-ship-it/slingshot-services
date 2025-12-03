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
const tradovateClient = new TradovateClient(config.tradovate, logger);

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

      default:
        throw new Error(`Unknown action: ${tradeSignal.action}. Expected: place_limit, cancel_limit, or position_closed`);
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

// Handle cancel_limit action from LDPS Trader
async function handleCancelLimitOrders(tradeSignal, accountId, webhookId) {
  logger.info(`Processing cancel_limit: ${tradeSignal.side} ${tradeSignal.symbol} (reason: ${tradeSignal.reason})`);

  try {
    // Get all open orders for the account
    const orders = await tradovateClient.getOrders(accountId);

    // Filter for working limit orders matching symbol and side
    const matchingOrders = orders.filter(order => {
      return order.orderStatus === 'Working' &&
             order.orderType === 'Limit' &&
             order.contractId === tradovateClient.mapToFullContractSymbol(tradeSignal.symbol);
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
          quantity: execution.cumQty,
          fillPrice: execution.avgPx || execution.price,
          status: 'filled',
          timestamp: execution.timestamp || new Date().toISOString(),
          source: 'websocket_execution_report',
          signalId: signalId,  // Include the original signal ID!
          isStopOrder: isStopOrder,
          isTargetOrder: isTargetOrder
        });

        // Clean up the mapping since order is now filled
        if (signalId) {
          orderSignalMap.delete(execution.orderId);
          logger.info(`🧹 Cleaned up signal mapping for filled order ${execution.orderId}`);
        }

        logger.info(`📊 Published execution fill for order ${execution.orderId} with symbol: ${symbol}`);

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
      logger.warn(`🔍 DEBUG: OrderStrategy status: ${data.entity.status}`);

      const strategy = data.entity;

      // Check if the strategy is completed/closed/interrupted
      if (data.eventType === 'Updated' && (strategy.status === 'Completed' || strategy.status === 'Canceled' || strategy.status === 'ExecutionInterrupted')) {
        logger.info(`🔚 OrderStrategy ${strategy.id} completed with status: ${strategy.status}`);

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

            await messageBus.publish(CHANNELS.POSITION_UPDATE, {
              accountId: position.accountId,
              positionId: position.id,
              contractId: position.contractId,
              symbol: symbol, // Now properly resolved
              contractName: symbol,
              netPos: position.netPos,
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
    } else {
      logger.warn('Tradovate credentials not configured');
    }

    // Subscribe to message bus channels
    await messageBus.subscribe(CHANNELS.ORDER_REQUEST, handleOrderRequest);
    logger.info(`Subscribed to ${CHANNELS.ORDER_REQUEST}`);

    await messageBus.subscribe(CHANNELS.WEBHOOK_TRADE, handleWebhookTrade);
    logger.info(`Subscribed to ${CHANNELS.WEBHOOK_TRADE}`);

    // Subscribe to account sync requests
    await messageBus.subscribe('account.sync.request', handleAccountSyncRequest);
    logger.info('Subscribed to account.sync.request');

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

// Start the service
startup();