# Slingshot Microservices Architecture

A scalable microservices architecture for trading system operations, separating concerns for better performance and reliability.

## Architecture Overview

The system consists of 4 independent microservices that communicate via Redis pub/sub:

1. **Tradovate Service** (Port 3011) - Manages all Tradovate API interactions
2. **Market Data Service** (Port 3012) - Real-time price streaming and P&L calculations
3. **Trade Orchestrator** (Port 3013) - Business logic and trade coordination
4. **Monitoring Service** (Port 3014) - Webhook ingestion, data aggregation and dashboard APIs

## Prerequisites

- Node.js 16+
- Redis server running locally
- Tradovate account credentials (demo or live)

## Quick Start

### 1. Install Redis

```bash
# Ubuntu/Debian
sudo apt-get install redis-server

# macOS
brew install redis

# Windows (WSL)
sudo apt-get install redis-server

# Start Redis
redis-server
```

### 2. Configure Environment

Copy the example environment file and update with your credentials:

```bash
cd slingshot/services/shared
cp .env.example .env
# Edit .env with your Tradovate credentials
```

### 3. Install Dependencies

```bash
cd slingshot/services

# Install shared dependencies
cd shared && npm install && cd ..

# Install service dependencies
cd tradovate-service && npm install && cd ..
cd market-data-service && npm install && cd ..
cd trade-orchestrator && npm install && cd ..
cd monitoring-service && npm install && cd ..
```

### 4. Start Services

#### Option A: Start all services at once
```bash
cd slingshot/services
./start-all.sh
```

#### Option B: Start services individually
```bash
# Terminal 1 - Tradovate Service
cd slingshot/services/tradovate-service
npm start

# Terminal 2 - Market Data Service
cd slingshot/services/market-data-service
npm start

# Terminal 3 - Trade Orchestrator
cd slingshot/services/trade-orchestrator
npm start

# Terminal 4 - Monitoring Service
cd slingshot/services/monitoring-service
npm start
```

#### Option C: Use PM2 (recommended for production)
```bash
# Install PM2 globally
npm install -g pm2

# Start all services
cd slingshot/services
pm2 start ecosystem.config.js

# View logs
pm2 logs

# Stop all services
pm2 stop all

# Restart all services
pm2 restart all
```

## Service Endpoints

### Health Checks
- Tradovate Service: http://localhost:3011/health
- Market Data Service: http://localhost:3012/health
- Trade Orchestrator: http://localhost:3013/health
- Monitoring Service: http://localhost:3014/health

### API Endpoints

#### Monitoring Service (Webhook Ingestion)
- `POST /webhook` - Receive trading webhooks and quotes

#### Tradovate Service
- `GET /accounts` - List all accounts
- `GET /positions/:accountId` - Get positions for account
- `GET /orders/:accountId` - Get orders for account
- `GET /balance/:accountId` - Get account balance

#### Market Data Service
- `GET /price/:symbol` - Get current price for symbol
- `GET /prices` - Get all cached prices

#### Trade Orchestrator
- `POST /trading/enable` - Enable trading
- `POST /trading/disable` - Disable trading
- `GET /trading/status` - Get trading status

#### Monitoring Service
- `GET /api/dashboard` - Complete dashboard data
- `GET /api/accounts` - All accounts
- `GET /api/positions` - All positions
- `GET /api/activity` - Recent activity log
- `GET /api/services` - Service health status
- `WebSocket ws://localhost:3014` - Real-time updates

## Testing Webhooks

Send a test webhook to the monitoring service:

```bash
curl -X POST http://localhost:3014/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_type": "trade_signal",
    "secret": "your_webhook_secret_here",
    "action": "place_market",
    "side": "buy",
    "symbol": "NQ1!",
    "quantity": 1,
    "strategy": "TEST"
  }'
```

## Monitoring Dashboard

The monitoring service provides a real-time dashboard at:
- REST API: http://localhost:3014/api/dashboard
- WebSocket: ws://localhost:3014

Connect your existing web dashboard to these endpoints for real-time updates.

## Message Bus Events

Services communicate via Redis pub/sub channels:

- `webhook.received` - New webhook received
- `trade.signal` - Validated trade signal
- `order.request` - Order placement request
- `order.placed` - Order successfully placed
- `order.filled` - Order execution confirmed
- `position.opened` - New position created
- `position.update` - Position P&L update
- `price.update` - Real-time price tick
- `account.update` - Account balance update

## Development

### Running in Development Mode

Each service supports hot-reload in development:

```bash
cd slingshot/services/[service-name]
npm run dev
```

### Viewing Logs

When using the startup scripts:
```bash
tail -f slingshot/services/logs/*.log
```

When using PM2:
```bash
pm2 logs [service-name]
pm2 monit  # Interactive monitoring
```

### Adding a New Service

1. Create service directory: `mkdir slingshot/services/new-service`
2. Create package.json and index.js
3. Import shared utilities from `../shared/index.js`
4. Add to PM2 ecosystem.config.js
5. Update start-all.sh and stop-all.sh scripts

## Troubleshooting

### Redis Connection Issues
- Ensure Redis is running: `redis-cli ping`
- Check Redis port (default 6379): `redis-cli INFO server | grep tcp_port`

### Service Won't Start
- Check logs in `logs/` directory
- Verify port is not in use: `lsof -i :PORT`
- Check environment variables in `.env` file

### Tradovate Authentication Failed
- Verify credentials in `.env` file
- Check if using demo vs live URLs
- Ensure account is not locked out

## Production Deployment

### Using PM2

```bash
# Start with production environment
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save

# Set up startup script
pm2 startup
```

### Environment Variables

Set production variables in `.env` or export them:

```bash
export NODE_ENV=production
export TRADOVATE_USE_DEMO=false
export REDIS_HOST=your-redis-host
```

### Monitoring

- Use PM2 monitoring: `pm2 monit`
- Set up log aggregation (e.g., CloudWatch, Datadog)
- Configure alerts for service health checks

## Architecture Benefits

- **Performance**: Webhook processing no longer blocked by API calls
- **Scalability**: Each service can be scaled independently
- **Reliability**: Service failures are isolated
- **Real-time**: Live market data enables instant P&L updates
- **Maintainability**: Clean separation of concerns

## Next Steps

1. Connect your existing web dashboard to the monitoring service
2. Migrate trading logic from the monolithic backend
3. Add more sophisticated risk management rules
4. Implement service discovery for dynamic scaling
5. Add distributed tracing for debugging