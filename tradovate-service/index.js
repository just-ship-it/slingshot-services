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

// Initialize Express app for REST API
const app = express();
app.use(express.json());

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
    const hasBracketData = (message.orderType === 'Limit' && (message.stopPrice || message.takeProfit));

    let result;
    if (hasBracketData) {
      logger.info(`Creating bracket order with stop/profit exits`);

      // Add bracket1 (stop loss) if provided
      if (message.stopPrice) {
        orderData.bracket1 = {
          action: message.action === 'Buy' ? 'Sell' : 'Buy',
          orderType: 'Stop',
          stopPrice: message.stopPrice
        };
        logger.info(`📊 Stop loss: ${message.action === 'Buy' ? 'Sell' : 'Buy'} Stop at ${message.stopPrice}`);
      }

      // Add bracket2 (take profit) if provided
      if (message.takeProfit) {
        orderData.bracket2 = {
          action: message.action === 'Buy' ? 'Sell' : 'Buy',
          orderType: 'Limit',
          price: message.takeProfit
        };
        logger.info(`📊 Take profit: ${message.action === 'Buy' ? 'Sell' : 'Buy'} Limit at ${message.takeProfit}`);
      }

      logger.info(`Placing bracket order:`, orderData);

      // Place the bracket order
      result = await tradovateClient.placeBracketOrder(orderData);

      // Publish events for all three orders (primary, stop, target)
      const timestamp = new Date().toISOString();

      // Main order
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
        response: result
      });

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
          orderRole: 'stop_loss'
        });
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
          orderRole: 'take_profit'
        });
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
        originalRequest: message,
        response: result
      });
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
            // Publish filled order event
            logger.info(`✅ Syncing filled order: ${order.id} - ${order.action} ${order.symbol || order.contractName}`);

            await messageBus.publish(CHANNELS.ORDER_FILLED, {
              orderId: order.id,
              accountId: account.id,
              symbol: order.symbol || order.contractName,
              action: order.action,
              quantity: order.qty || order.orderQty,
              fillPrice: order.avgFillPrice || order.price,
              contractId: order.contractId,
              timestamp: order.fillTime || new Date().toISOString(),
              source: 'sync'
            });
          } else if (orderStatus === 'Cancelled' || orderStatus === 'Rejected') {
            // Publish cancelled/rejected order event
            logger.info(`❌ Syncing cancelled/rejected order: ${order.id} - ${orderStatus}`);

            await messageBus.publish(CHANNELS.ORDER_REJECTED, {
              orderId: order.id,
              accountId: account.id,
              symbol: order.symbol || order.contractName,
              reason: orderStatus,
              timestamp: new Date().toISOString(),
              source: 'sync'
            });
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

          await messageBus.publish(CHANNELS.POSITION_UPDATE, {
            accountId: account.id,
            accountName: account.name,
            positions: openPositions,
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
    source: 'webhook',
    strategy: tradeSignal.strategy || 'unknown',
    webhookId: webhookId
  };

  logger.info(`Processing place_limit: ${action} ${orderRequest.quantity} ${tradeSignal.symbol} at ${tradeSignal.price}`);
  if (orderRequest.stopPrice) logger.info(`📊 Stop loss: ${orderRequest.stopPrice}`);
  if (orderRequest.takeProfit) logger.info(`📊 Take profit: ${orderRequest.takeProfit}`);

  // Forward to order handler
  await handleOrderRequest(orderRequest);
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
  // Update positions every 5 seconds
  setInterval(() => {
    if (tradovateClient.isConnected) {
      handlePositionUpdate();
    }
  }, 5000);

  // Update account balances every 30 seconds
  setInterval(() => {
    if (tradovateClient.isConnected) {
      handleAccountUpdate();
    }
  }, 30000);

  // Sync orders and positions every 60 seconds to catch external changes
  setInterval(() => {
    if (tradovateClient.isConnected) {
      logger.info('🔄 Running periodic sync...');
      syncExistingData().catch(error => {
        logger.error('Periodic sync failed:', error);
      });
    }
  }, 60000);
}

// Startup sequence
async function startup() {
  try {
    logger.info(`Starting ${SERVICE_NAME}...`);

    // Connect to message bus
    logger.info('Connecting to message bus...');
    await messageBus.connect();
    logger.info('Message bus connected');

    // Connect to Tradovate
    if (config.tradovate.username && config.tradovate.password) {
      logger.info('Connecting to Tradovate...');
      await tradovateClient.connect();
      logger.info('Tradovate connected');

      // Start periodic updates
      startPeriodicUpdates();

      // Perform initial data sync
      logger.info('Performing initial data sync...');
      await handleAccountUpdate();
      await handlePositionUpdate();

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

    // Set up Tradovate event forwarding
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

    // Publish startup event
    await messageBus.publish(CHANNELS.SERVICE_STARTED, {
      service: SERVICE_NAME,
      port: config.service.port,
      tradovateConnected: tradovateClient.isConnected,
      environment: config.tradovate.useDemo ? 'demo' : 'live',
      timestamp: new Date().toISOString()
    });

    // Start Express server
    const server = app.listen(config.service.port, config.service.host, () => {
      logger.info(`${SERVICE_NAME} listening on ${config.service.host}:${config.service.port}`);
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