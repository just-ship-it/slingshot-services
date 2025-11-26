# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a microservices trading system called "Slingshot" that separates trading functionality into 5 independent services communicating via Redis pub/sub. The system handles webhook ingestion, Tradovate API interactions, real-time market data, trade orchestration, and monitoring.

## Development Commands

### Service Management
- **Start all services**: `./start-all.sh` (includes dependency installation and health checks)
- **Stop all services**: `./stop-all.sh`
- **PM2 management**: `pm2 start ecosystem.config.js` / `pm2 logs` / `pm2 monit`

### Individual Service Development
Each service supports the same npm scripts:
- **Production**: `npm start` (runs `node index.js`)
- **Development**: `npm run dev` (runs `node --watch index.js` with hot reload)

### Prerequisites Check
- Redis must be running: `redis-cli ping`
- Environment file: Copy `shared/.env.example` to `shared/.env` and configure

## Architecture

### Service Structure
- **Port 3010**: Webhook Gateway - Fast webhook ingestion and routing
- **Port 3011**: Tradovate Service - All Tradovate API interactions
- **Port 3012**: Market Data Service - Real-time price streaming and P&L
- **Port 3013**: Trade Orchestrator - Business logic and trade coordination
- **Port 3014**: Monitoring Service - Data aggregation and dashboard APIs

### Key Dependencies
- All services use ES modules (`"type": "module"` in package.json)
- Shared utilities in `/shared/` directory provide common functionality
- Redis pub/sub handles inter-service communication
- Services import from `../shared/index.js` for logging, message bus, and configuration

### Message Bus Channels
The system uses predefined Redis channels for communication (defined in `shared/index.js`):
- Webhook events: `webhook.received`, `webhook.validated`, `webhook.rejected`
- Trading signals: `trade.signal`, `trade.validated`, `trade.rejected`
- Order events: `order.request`, `order.placed`, `order.filled`, `order.rejected`
- Position events: `position.opened`, `position.closed`, `position.update`
- Market data: `price.update`, `market.connected`, `market.disconnected`
- Account events: `account.update`, `balance.update`, `margin.update`
- System events: `service.health`, `service.error`, `service.started`

### Configuration
- Environment variables are managed through `shared/.env`
- Each service has its own `package.json` with consistent script structure
- PM2 configuration in `ecosystem.config.js` defines all service startup parameters
- Default ports are defined but configurable via environment variables

### Service Dependencies
Services must start in this order (handled by `start-all.sh`):
1. Webhook Gateway (no dependencies)
2. Tradovate Service (depends on message bus)
3. Market Data Service (depends on message bus and Tradovate)
4. Trade Orchestrator (depends on message bus)
5. Monitoring Service (depends on message bus)

## Common Development Tasks

### Adding New Services
1. Create service directory with standard structure
2. Use shared utilities: `import { messageBus, createLogger, CHANNELS } from '../shared/index.js'`
3. Add to `ecosystem.config.js` PM2 configuration
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