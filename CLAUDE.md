# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a microservices trading system called "Slingshot" that separates trading functionality into 5 independent services communicating via Redis pub/sub. The system handles webhook ingestion, Tradovate API interactions, real-time market data, trade orchestration, signal generation, and monitoring.

## Development Commands

### Service Management
- **Start all services**: `./start-all.sh` (includes dependency installation and health checks)
- **Stop all services**: `./stop-all.sh`
- **PM2 management**: `pm2 start ecosystem.config.cjs` / `pm2 logs` / `pm2 monit`

### Individual Service Development
Each service supports the same npm scripts:
- **Production**: `npm start` (runs `node index.js`)
- **Development**: `npm run dev` (runs `node --watch index.js` with hot reload)

### Prerequisites Check
- Redis must be running: `redis-cli ping`
- Environment file: Copy `shared/.env.example` to `shared/.env` and configure

## Architecture

### Service Structure
- **Port 3011**: Tradovate Service - All Tradovate API interactions
- **Port 3012**: Market Data Service - Real-time price streaming and P&L (receives quotes via webhooks)
- **Port 3013**: Trade Orchestrator - Business logic and trade coordination
- **Port 3014**: Monitoring Service - Webhook ingestion, data aggregation, and dashboard APIs
- **Port 3015**: Signal Generator Service - Python service for TradingView data streaming, strategy evaluation, and trade signal generation

### Key Dependencies
- Node.js services use ES modules (`"type": "module"` in package.json)
- Signal Generator Service is Python-based (FastAPI + asyncio)
- Shared utilities in `/shared/` directory provide common functionality for Node.js services
- Redis pub/sub handles inter-service communication
- Node.js services import from `../shared/index.js` for logging, message bus, and configuration
- Python service uses direct Redis client for pub/sub communication

### Message Bus Channels
The system uses predefined Redis channels for communication (defined in `shared/index.js`):
- Webhook events: `webhook.received`, `webhook.validated`, `webhook.rejected`, `webhook.quote`, `webhook.trade`
- Trading signals: `trade.signal`, `trade.validated`, `trade.rejected`
- Order events: `order.request`, `order.placed`, `order.filled`, `order.rejected`, `order.cancelled`
- Position events: `position.opened`, `position.closed`, `position.update`, `position.realtime_update`
- Market data: `price.update`, `market.connected`, `market.disconnected`, `quote.request`, `quote.response`
- Account events: `account.update`, `balance.update`, `margin.update`
- System events: `service.health`, `service.error`, `service.started`, `service.stopped`
- Sync events: `tradovate_sync_completed`
- Signal Generator events: `lt.levels`, `gex.levels`, `candle.close`, `gex.refresh`

### Configuration
- Environment variables are managed through `shared/.env`
- Each service has its own `package.json` with consistent script structure
- PM2 configuration in `ecosystem.config.cjs` defines all service startup parameters
- Default ports are defined but configurable via environment variables

### Service Dependencies
Services must start in this order (handled by `start-all.sh`):
1. Tradovate Service (depends on message bus)
2. Market Data Service (depends on message bus, receives quotes via webhooks from NinjaTrader)
3. Trade Orchestrator (depends on message bus)
4. Monitoring Service (depends on message bus, handles all webhook ingestion)
5. Signal Generator Service (Python service, depends on Redis, streams TradingView data and generates trade signals)

## Webhook Data Formats

### Trade Signal Format
The system accepts trade signals via webhook at `http://localhost:3014/webhook`:

```json
{
  "webhook_type": "trade_signal",
  "secret": "your_webhook_secret_here",
  "action": "place_limit",
  "side": "buy",
  "symbol": "NQ1!",
  "price": 25534.5,
  "stop_loss": 25482.5,
  "take_profit": 25634.5,
  "trailing_trigger": 22,      // Points from entry, not price
  "trailing_offset": 6,         // Points, not price
  "quantity": 1,
  "strategy": "LDPS"
}
```

**Supported Actions:**
- `place_limit` - Place a limit order with bracket orders (stop loss and take profit)
- `place_market` - Place a market order
- `position_closed` - Close an existing position
- `cancel_limit` - Cancel pending limit orders

**Key Fields:**
- `webhook_type`: Must be "trade_signal" for trading signals
- `secret`: Webhook authentication secret (configured in .env)
- `trailing_trigger`: Distance in points from entry where trailing stop activates
- `trailing_offset`: Trailing stop distance in points
- `strategy`: Strategy identifier for tracking and grouping orders

### Quote Data Format
Real-time market quotes are sent from NinjaTrader via webhook:

```json
{
  "webhook_type": "quote",
  "type": "quote_batch",
  "source": "ninjatrader",
  "timestamp": "2024-12-03T12:00:00Z",
  "quotes": [
    {
      "symbol": "MNQZ5",
      "baseSymbol": "MNQ",
      "open": 25500.0,
      "high": 25550.0,
      "low": 25480.0,
      "close": 25530.0,
      "previousClose": 25495.0,
      "volume": 1234
    }
  ]
}
```

The monitoring service receives these webhooks and routes them to the appropriate services via Redis pub/sub.

## Common Development Tasks

### Adding New Services
1. Create service directory with standard structure
2. Use shared utilities: `import { messageBus, createLogger, CHANNELS } from '../shared/index.js'`
3. Add to `ecosystem.config.cjs` PM2 configuration
4. Update `start-all.sh` and `stop-all.sh` scripts

### Working with Message Bus
- Import channels: `import { CHANNELS } from '../shared/index.js'`
- Publish events: `messageBus.publish(CHANNELS.EVENT_NAME, data)`
- Subscribe to events: `messageBus.subscribe(CHANNELS.EVENT_NAME, handler)`

### Health Checks
- All services expose `/health` endpoints
- Use shared helper: `import { healthCheck } from '../shared/index.js'`
- Health data is automatically published to `service.health` channel

### Logging
- Use shared logger: `import { createLogger } from '../shared/index.js'`
- Logs are written to `logs/[service-name].log` when using startup scripts
- PM2 provides centralized log management: `pm2 logs [service-name]`

## Service Endpoints

### Public Endpoints (Monitoring Service - Port 3014)
- **Webhook Endpoint**: `http://localhost:3014/webhook` - Receives trade signals and quotes
- **Dashboard API**: `http://localhost:3014/api/dashboard` - Dashboard data aggregation
- **Health Check**: `http://localhost:3014/health` - Service health status
- **WebSocket**: `ws://localhost:3014` - Real-time updates

### Internal Service Endpoints (localhost only)
- **Tradovate Service**: `http://localhost:3011/health` - Tradovate API gateway
- **Market Data Service**: `http://localhost:3012/health` - Price streaming service
- **Trade Orchestrator**: `http://localhost:3013/health` - Trade logic service
- **Signal Generator Service**: `http://localhost:3015/health` - Python service health check
  - `/gex/levels` - Get current GEX levels
  - `/gex/refresh` - Force GEX recalculation
  - `/lt/levels` - Get current LT levels
  - `/strategy/enable` - Enable strategy evaluation
  - `/strategy/disable` - Disable strategy evaluation

Note: Internal services bind to 127.0.0.1 and are not publicly accessible. Only the monitoring service (3014) binds to 0.0.0.0 for external access.

## Signal Generator Service (Python)

The Signal Generator Service is a Python-based FastAPI application that handles:

### Core Functionality
- **TradingView Data Streaming**: Real-time OHLCV data from multiple symbols via WebSocket
- **Liquidity Trigger (LT) Monitoring**: Tracks support/resistance levels
- **GEX Level Calculation**: Gamma exposure calculations for market positioning
- **Strategy Engine**: Evaluates market conditions and generates trade signals
- **15-minute Candle Close Detection**: Triggers strategy evaluation on candle completions

### Key Components
- **OHLCV Monitor**: `/signal-generator/src/data_sources/ohlcv_monitor_stable.py`
  - Streams quotes from TradingView using threading + direct Redis publishing
  - Auto-restarts connections on failure
  - Publishes real-time price updates to `price.update` channel
- **LT Monitor**: `/signal-generator/src/data_sources/lt_monitor.py`
  - Tracks liquidity trigger levels
  - Publishes to `lt.levels` channel
- **GEX Calculator**: `/signal-generator/src/data_sources/gex_calculator.py`
  - Calculates gamma exposure levels
  - Publishes to `gex.levels` channel
- **Strategy Engine**: `/signal-generator/src/strategy/engine.py`
  - Evaluates market conditions using LT levels, GEX data, and price action
  - Generates trade signals published to `trade.signal` channel
- **Redis Publisher**: `/signal-generator/src/publishers/redis_publisher.py`
  - Handles all Redis pub/sub communication
  - Compatible with Node.js message bus format

### Environment Configuration
The service requires these environment variables:
- `TRADINGVIEW_CREDENTIALS`: TradingView authentication
- `TRADINGVIEW_JWT_TOKEN`: Optional hardcoded JWT token
- `REDIS_URL`: Redis connection string
- `OHLCV_SYMBOLS`: Comma-separated list of symbols to monitor
- `LT_SYMBOL`: Symbol for liquidity trigger monitoring
- `GEX_SYMBOL`: Symbol for GEX calculations

### Development Commands
- **Start**: `pm2 start ecosystem.config.cjs --only signal-generator`
- **Logs**: `pm2 logs signal-generator`
- **Restart**: `pm2 restart signal-generator`
- **Direct run**: `cd signal-generator && python -m src.main`