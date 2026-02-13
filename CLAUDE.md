# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a microservices trading system called "Slingshot" that separates trading functionality into 5 independent services communicating via Redis pub/sub. The system handles webhook ingestion, Tradovate API interactions, real-time market data, trade orchestration, signal generation, and monitoring.

## Quick Start

```bash
# 1. Configure environment
cp shared/.env.example shared/.env
# Edit shared/.env with your credentials

# 2. Verify Redis is running
redis-cli ping  # Should return PONG

# 3. Start all services
./start-all.sh
```

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
- **Port 3015**: Signal Generator Service - NodeJS service for TradingView data streaming, strategy evaluation, and trade signal generation

### Key Dependencies
- All services use Node.js with ES modules (`"type": "module"` in package.json)
- Shared utilities in `/shared/` directory provide common functionality across all services
- Redis pub/sub handles inter-service communication
- All services import from `../shared/index.js` for logging, message bus, and configuration
- Express servers provide HTTP endpoints for external access and health checks

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
5. Signal Generator Service (NodeJS service, depends on Redis, streams TradingView data and generates trade signals)

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

## Order Execution and Backtesting

### Order Fill Logic (Critical for Backtesting Accuracy)

**IMPORTANT**: The backtest engine simulates order execution with specific logic that must be followed to ensure accurate results.

#### Limit Orders
Limit orders fill at the EXACT limit price when the market reaches that level:

**BUY Limit Orders:**
- Fill condition: `candle.low <= limit_price`
- Fill price: Exactly `limit_price` (no slippage)
- Rationale: If candle low went at/below your limit, you get filled at your limit price

**SELL Limit Orders:**
- Fill condition: `candle.high >= limit_price`
- Fill price: Exactly `limit_price` (no slippage)
- Rationale: If candle high went at/above your limit, you get filled at your limit price

#### Market Orders
Market orders fill immediately with slippage applied:
- **BUY Market**: Fill at `candle.close + slippage`
- **SELL Market**: Fill at `candle.close - slippage`

#### Stop Loss Orders
Stop losses convert to market orders when triggered, incurring slippage:
- **BUY Stop Loss**: When `candle.low <= stop_price`, fill at `stop_price - slippage`
- **SELL Stop Loss**: When `candle.high >= stop_price`, fill at `stop_price + slippage`

### Why This Matters
Incorrect order simulation can invalidate entire backtesting analyses. The key principle is that **limit orders should NEVER have slippage** - they either fill at the limit price or not at all. Only market orders and triggered stop losses experience slippage due to immediate execution requirements.

### Implementation Location
Order fill logic is implemented in `/backtest-engine/src/execution/trade-simulator.js` in the `checkOrderFill()` method.

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
- **GEX Levels**: `http://localhost:3014/api/gex/levels` - Current GEX levels (proxied)
- **GEX Refresh**: `http://localhost:3014/api/gex/refresh` - Force GEX recalculation (proxied)
- **Strategy Status**: `http://localhost:3014/api/strategy/gex-scalp/status` - Real-time strategy monitoring
- **Health Check**: `http://localhost:3014/health` - Service health status
- **WebSocket**: `ws://localhost:3014` - Real-time updates

### Internal Service Endpoints (localhost only)
- **Tradovate Service**: `http://localhost:3011/health` - Tradovate API gateway
- **Market Data Service**: `http://localhost:3012/health` - Price streaming service
- **Trade Orchestrator**: `http://localhost:3013/health` - Trade logic service
- **Signal Generator Service**: `http://localhost:3015/health` - NodeJS service health check
  - `/gex/levels` - Get current GEX levels
  - `/gex/refresh` - Force GEX recalculation
  - `/lt/levels` - Get current LT levels
  - `/strategy/enable` - Enable strategy evaluation
  - `/strategy/disable` - Disable strategy evaluation

Note: Internal services bind to 127.0.0.1 and are not publicly accessible. Only the monitoring service (3014) binds to 0.0.0.0 for external access.

## Slingshot Dashboard (React Frontend)

The dashboard is a React-based web application for monitoring and controlling the trading system.

**Location**: `/mnt/c/projects/ereptor/slingshot/frontend`

### Tech Stack
- React 18.2 with Create React App
- Tailwind CSS 3.3 for styling
- Socket.io Client for real-time WebSocket updates
- Lightweight Charts for financial charting (GEX levels, price action)
- Chart.js for additional visualizations
- Axios for REST API communication

### Quick Start
```bash
cd /mnt/c/projects/ereptor/slingshot/frontend
npm install
npm start  # Runs on port 3002
```

### Key Components
- **Dashboard.jsx** - Main dashboard with accounts, positions, orders, GEX levels, service health
- **GexChart.jsx** - Financial chart with price action and GEX support/resistance overlay
- **GexLevelsPanel.jsx** - GEX support/resistance level display
- **GexComparisonPanel.jsx** - CBOE vs Tradier GEX comparison
- **EnhancedTradingStatus.jsx** - Real-time position/order tracking with P&L
- **QuotesPanel.jsx** - Real-time market quotes (NQ, ES, QQQ, SPY, BTC)
- **TestTrading.jsx** - Manual trade testing interface
- **Login.jsx** - Token-based authentication

### Configuration
Environment variables in `.env`:
```
PORT=3002
REACT_APP_API_URL=http://localhost:3014
REACT_APP_ENVIRONMENT=development
```

### Backend Integration
The frontend communicates exclusively through the **Monitoring Service (Port 3014)**:
- All REST API calls go through `/api/*` endpoints
- WebSocket connection for real-time updates (positions, orders, prices)
- Authentication via Bearer token (stored in localStorage as `dashboardToken`)

### Key API Endpoints Used
```
GET  /api/dashboard              - Comprehensive dashboard data
GET  /api/gex/levels             - Current GEX levels
GET  /api/strategy/gex-scalp/status - Strategy evaluation status
POST /api/gex/refresh            - Force GEX recalculation
POST /api/trading/enable|disable - Trading kill switch
```

### WebSocket Events
- `position_update` / `position_realtime_update` - Position changes
- `order_placed` / `order_update` - Order status changes
- `market_data` - Price/quote updates
- `pnl_update` - P&L changes

## Signal Generator Service (NodeJS)

The Signal Generator Service is a NodeJS-based Express application that handles:

### Core Functionality
- **TradingView Data Streaming**: Real-time OHLCV data from multiple symbols via WebSocket
- **Liquidity Trigger (LT) Monitoring**: Tracks support/resistance levels
- **GEX Level Calculation**: Gamma exposure calculations for market positioning
- **Strategy Engine**: Evaluates market conditions and generates trade signals
- **Strategy Status Publishing**: Real-time strategy monitoring via Redis pub/sub
- **1-minute Candle Close Detection**: Triggers GEX Scalp strategy evaluation on candle completions
- **Dual WebSocket Architecture**: Separate connections for quotes and LT indicators for stability

### Key Components
- **TradingView Client**: `/signal-generator/src/websocket/tradingview-client.js`
  - Streams real-time quotes from TradingView via WebSocket
  - Auto-reconnection with proper session management
  - Publishes real-time price updates to `price.update` channel
- **LT Monitor**: `/signal-generator/src/websocket/lt-monitor.js`
  - Dedicated WebSocket for Liquidity Trigger level monitoring
  - Fetches indicator metadata from TradingView's pine-facade API
  - Publishes LT levels to `lt.levels` channel
- **GEX Calculator**: `/signal-generator/src/gex/gex-calculator.js`
  - Fetches CBOE options data and calculates gamma exposure levels
  - Translates QQQ levels to NQ using live price ratios
  - Caches levels and provides HTTP endpoints
- **Strategy Engine**: `/signal-generator/src/strategy/engine.js`
  - Evaluates GEX Scalp strategy conditions on 1-minute candle closes
  - Tracks pending limit orders and sends `cancel_limit` after timeout (3 candles)
  - Tracks position state via Redis events (POSITION_OPENED, POSITION_CLOSED)
  - Publishes strategy status to `strategy.status` channel
  - Resets cooldown when position closes for immediate next signal
- **HTTP Server**: `/signal-generator/index.js`
  - Provides REST API endpoints for GEX levels and strategy control
  - Health check and monitoring endpoints

### Environment Configuration
The service requires these environment variables:
- `TRADINGVIEW_CREDENTIALS`: TradingView authentication
- `TRADINGVIEW_JWT_TOKEN`: Optional hardcoded JWT token
- `REDIS_URL`: Redis connection string
- `OHLCV_SYMBOLS`: Comma-separated list of symbols to monitor
- `LT_SYMBOL`: Symbol for liquidity trigger monitoring
- `GEX_SYMBOL`: Symbol for GEX calculations

**Strategy Configuration:**
- `STRATEGY_ENABLED`: Enable/disable strategy evaluation (true/false)
- `TRADING_SYMBOL`: Symbol to trade (e.g., `NQH6`)
- `DEFAULT_QUANTITY`: Default order quantity
- `USE_SESSION_FILTER`: Enable session-based filtering (true/false, default: true)
- `ALLOWED_SESSIONS`: Comma-separated sessions to trade (overnight, premarket, rth, afterhours)

### Development Commands
- **Start**: `pm2 start ecosystem.config.cjs --only signal-generator`
- **Logs**: `pm2 logs signal-generator`
- **Restart**: `pm2 restart signal-generator`
- **Direct run**: `cd signal-generator && node index.js`
- **Development mode**: `cd signal-generator && npm run dev` (with hot reload)

## Backtest Engine

The backtest engine is a CLI tool for running historical strategy analysis. Located in `/backtest-engine/`.

### Usage

```bash
cd backtest-engine

# Basic backtest
node index.js --ticker NQ --start 2023-03-01 --end 2025-12-25

# Full configuration
node index.js --ticker NQ --start 2023-03-01 --end 2025-12-25 \
  --strategy gex-recoil --timeframe 15m \
  --target-points 25 --stop-buffer 10 \
  --output results.json --output-csv trades.csv
```

### Available Strategies
- `gex-recoil` (default) - Long entries on GEX support level crossovers
- `gex-ldpm-confluence` - GEX + LDPM confluence strategy
- `gex-ldpm-confluence-lt` - With LT level filtering
- `gex-ldpm-confluence-enhanced` - Enhanced confluence
- `gex-level-sweep` - Level sweep detection
- `gex-squeeze-confluence` - With squeeze momentum
- `gex-ldpm-confluence-pullback` - Pullback entries

Run `node index.js --help` for all options.

### Architecture
- `/backtest-engine/src/cli.js` - Command-line interface
- `/backtest-engine/src/backtest-engine.js` - Core engine
- `/backtest-engine/src/execution/trade-simulator.js` - Order fill simulation
- `/backtest-engine/src/analytics/performance-calculator.js` - Performance metrics
- `/backtest-engine/src/data/csv-loader.js` - Historical data loading
- `/backtest-engine/data/` - Historical candle and GEX data (CSV)

## Backtest Data Sources

Historical data for backtesting is stored in `/backtest-engine/data/`:

### Data Overview

| Data Type | Location | Format | Date Range | Frequency |
|-----------|----------|--------|------------|-----------|
| NQ OHLCV | `ohlcv/nq/NQ_ohlcv_1m.csv` | CSV | Dec 2020 - Dec 2025 | 1-minute |
| ES OHLCV | `ohlcv/es/ES_ohlcv_1m.csv` | CSV | Jan 2021 - Jan 2026 | 1-minute |
| QQQ OHLCV | `ohlcv/qqq/QQQ_ohlcv_1m.csv` | CSV | Dec 2020 - present | 1-minute |
| SPY OHLCV | `ohlcv/spy/SPY_ohlcv_1m.csv` | CSV | Dec 2020 - present | 1-minute |
| NQ GEX Daily | `gex/nq/NQ_gex_levels.csv` | CSV | Mar 2023 - Dec 2025 | Daily |
| NQ GEX Intraday | `gex/nq/nq_gex_*.json` | JSON | Mar 2023 - Jan 2026 | 15-min snapshots |
| ES GEX Intraday | `gex/es/es_gex_*.json` | JSON | Mar 2023 - Jan 2026 | 15-min snapshots |
| NQ LT Levels | `liquidity/nq/NQ_liquidity_levels.csv` | CSV | Mar 2023 - Dec 2025 | 15-minute |
| ES LT Levels (Daily) | `liquidity/es/ES_liquidity_levels_1D.csv` | CSV | Apr 2000 - Feb 2026 | Daily |
| ES LT Levels (Hourly) | `liquidity/es/ES_liquidity_levels_1h.csv` | CSV | Feb 2020 - Feb 2026 | Hourly |
| ES LT Levels (15m) | `liquidity/es/ES_liquidity_levels_15m.csv` | CSV | Jan 2020 - Feb 2026 | 15-minute |
| ATM IV | `iv/qqq_atm_iv_15m.csv` | CSV | Jan 2025 - Dec 2025 | 15-minute |
| Options CBBO | `cbbo-1m/*.csv` | CSV | Jan 2025 | 1-minute |
| Options Definitions | `definition/*.csv` | CSV | Jan 2021 - present | Daily |
| QQQ Options Stats | `statistics/qqq/*.csv` | CSV | Mar 2023 - present | Daily |
| SPY Options Stats | `statistics/spy/*.csv` | CSV | Jan 2021 - Jan 2026 | Daily |
| NQ MBO (L3) | `orderflow/nq/mbo/*.csv` | CSV | Dec 2025 - Jan 2026 | Tick-level |
| VIX Options OHLCV | `ohlcv/vix/*.csv` | CSV | Jan 2021 - Jan 2026 | 1-minute |
| QQQ Options TCBBO | `tcbbo/qqq/*.csv` | CSV | Jan 2025 - Jan 2026 | Tick-level |

### OHLCV Data
Price data with columns: `ts_event, rtype, publisher_id, instrument_id, open, high, low, close, volume, symbol`
- NQ futures: ~2.5M 1-minute bars (also 1-second available)
- ES futures: ~10.2M 1-minute bars (also 1-second available, ~6.3GB)
- QQQ ETF: ~1M 1-minute bars
- SPY ETF: ~1M 1-minute bars
- VIX options: 1-minute bars per contract (Jan 2021 - Jan 2026, ~600MB)
- 1-second data available for NQ and ES (large files)

**IMPORTANT: Calendar Spread Filtering**: The NQ and ES OHLCV files contain calendar spread entries that must be filtered out during backtesting. These are NOT actual price quotes - they represent the price difference between two contracts with different expiries. Calendar spreads have a dash between two symbols:
```
2020-12-28T09:00:00.000000000Z,33,1,20987,-14.850000000,-14.850000000,-14.850000000,-14.850000000,1,NQH1-NQM1
```
Filter by checking if the `symbol` column contains a dash (e.g., `NQH1-NQM1`).

**IMPORTANT: Primary Contract Filtering**: The NQ and ES OHLCV files contain multiple contract months at the same timestamps (e.g., NQH5 at 21200 and NQM5 at 21425 simultaneously, or ESH6 and ESM6). These different contracts have significant price differences. If you load all candles without filtering, your analysis will see artificial price swings when switching between contracts, causing FALSE signals and INVALID results.

**You MUST use `filterPrimaryContract()` when loading OHLCV data for any analysis or backtesting.** This function:
1. Groups candles by hour
2. Finds the highest-volume contract symbol per hour
3. Only includes candles from that primary contract

The backtest engine implements this in `csv-loader.js`. Any standalone analysis scripts must also implement this filtering. Failure to do so will produce dramatically wrong results (e.g., 84% win rate when actual is 30%).

### GEX Levels
Gamma exposure levels calculated from ETF options and translated to futures prices:
- **NQ GEX** (from QQQ options): `gex/nq/` — daily CSV + 15-min intraday JSON
- **ES GEX** (from SPY options): `gex/es/` — 15-min intraday JSON

**Daily CSV** (NQ only): `date, nq_gamma_flip, nq_put_wall_1/2/3, nq_call_wall_1/2/3, total_gex, regime`

**Intraday JSON** (both NQ and ES): 15-min snapshots with fields:
- `{futures}_spot`, `{etf}_spot`, `multiplier` — price translation ratio
- `gamma_flip`, `call_wall`, `put_wall` — key levels (in futures price space)
- `resistance[0-4]`, `support[0-4]` — 5 levels each
- `total_gex`, `total_vex`, `total_cex` — aggregate Greeks
- `regime` — `strong_positive`, `positive`, `neutral`, `negative`, `strong_negative`
- `options_count` — number of contracts in calculation

**Generation**: Both products use `backtest-engine/scripts/generate-intraday-gex.py`:
```bash
# NQ (default)
python3 generate-intraday-gex.py --start 2023-03-28 --end 2026-01-28

# ES
python3 generate-intraday-gex.py --product es --start 2023-03-28 --end 2026-01-28
```

The script uses Brenner-Subrahmanyam IV approximation from OPRA statistics (OI + close prices), computes Black-Scholes gamma/vega/charm per contract, aggregates by strike, and translates ETF levels to futures using the intraday spot ratio.

**TradingView Indicator Format**: The GEX levels can be exported in a CSV format compatible with the TradingView GEX indicator:
```
cboe_zero,cboe_call,cboe_put,cboe_r1,cboe_r2,cboe_r3,cboe_r4,cboe_r5,cboe_s1,cboe_s2,cboe_s3,cboe_s4,cboe_s5,tradier_zero,tradier_call,tradier_put,tradier_r1,tradier_r2,tradier_r3,tradier_r4,tradier_r5,tradier_s1,tradier_s2,tradier_s3,tradier_s4,tradier_s5
```

### Liquidity Trigger Levels
TradingView-sourced support/resistance levels exported from the Liquidity Data Exporter indicator.

**NQ**: `liquidity/nq/NQ_liquidity_levels.csv` — 15-minute, Mar 2023 - Dec 2025
**ES**: Multi-timeframe coverage in `liquidity/es/`:
- `ES_liquidity_levels_1D.csv` — Daily, Apr 2000 - Feb 2026 (6,531 snapshots)
- `ES_liquidity_levels_1h.csv` — Hourly, Feb 2020 - Feb 2026 (35,408 snapshots)
- `ES_liquidity_levels_15m.csv` — 15-minute, Jan 2020 - Feb 2026 (143,181 snapshots)

**Important**: LT levels are fundamentally different across timeframes — different Fibonacci lookback periods on different chart resolutions produce distinct level sets. They should NOT be merged; each timeframe captures different liquidity dynamics.

**CSV format**: `datetime,unix_timestamp,sentiment,level_1,level_2,level_3,level_4,level_5`

**Conversion**: Raw TradingView xlsx exports are converted via `scripts/convert-lt-excel.py`:
```bash
python3 scripts/convert-lt-excel.py <input.xlsx> <output.csv>
```

- Sentiment: BULLISH or BEARISH (derived from level configuration — not independently predictive, see LT Configuration Filters below)
- 5 price levels per timestamp, each corresponding to a Fibonacci lookback period:

| CSV Field | Fibonacci Lookback | Timeframe Significance |
|-----------|-------------------|------------------------|
| level_1 | 34 bars | Short-term liquidity |
| level_2 | 55 bars | Short-term liquidity |
| level_3 | 144 bars | Medium-term liquidity |
| level_4 | 377 bars | Long-term liquidity |
| level_5 | 610 bars | Long-term liquidity |

**Key insight:** The levels are NOT ordered by price — the indicator outputs them in fixed series order (fib-34 first, fib-610 last). They reorder frequently relative to each other (~93.7% of snapshots have inversions). The *relative dynamics* between levels are more informative than any single level's position:
- **Level crossings through price** (a level migrating from above to below spot, or vice versa) predict post-volatility-event direction at ~74% accuracy (5min lookforward, n=62 events)
- **Which Fibonacci lookback crossed** matters: short-term (fib 34/55) crossings indicate near-term liquidity shifts; long-term (fib 377/610) crossings indicate structural zone breaks
- **Migration direction** (levels converging toward vs diverging from price) provides additional signal
- Sentiment is a byproduct of level configuration and should not be used as a standalone predictor

### Implied Volatility
ATM implied volatility for QQQ: `timestamp, iv, spot_price, atm_strike, call_iv, put_iv, dte`

### OPRA Options Data (Databento)
Raw options market data from OPRA.PILLAR feed:
- **CBBO**: Best bid/offer per option contract
- **Definitions**: Contract specifications (strikes, expirations, multipliers)
- **Statistics**: Market statistics per instrument (open interest, volume)
  - `statistics/qqq/` - QQQ options (Mar 2023 - present)
  - `statistics/spy/` - SPY options (Jan 2021 - Jan 2026, ~67GB, 1255 daily files)

**Statistics columns**: `ts_recv, ts_event, rtype, publisher_id, instrument_id, ts_ref, price, quantity, sequence, ts_in_delta, stat_type, channel_id, update_action, stat_flags, symbol`

### TCBBO (Trade-Corrected Best Bid/Offer)
Trade data with corrected BBO at time of execution. More accurate than raw CBBO for execution analysis.
- `tcbbo/qqq/` - QQQ options (Jan 2025 - Jan 2026, ~24GB, 251 daily files)

**TCBBO columns**: `ts_recv, ts_event, rtype, publisher_id, instrument_id, action, side, price, size, flags, ts_in_delta, bid_px_00, ask_px_00, bid_sz_00, ask_sz_00, bid_pb_00, ask_pb_00, symbol`

### NQ Market-By-Order Data (Databento GLBX.MDP3)
Level 3 order book data from CME Globex for NQ futures. This is the most granular market data available, showing every individual order event.

**Location**: `orderflow/nq/mbo/`
**Source**: Databento GLBX.MDP3 dataset
**Schema**: MBO (Market-By-Order)
**Date Range**: Dec 29, 2025 - Jan 28, 2026
**Size**: ~58GB (26 daily files)

**Columns**:
| Column | Description |
|--------|-------------|
| `ts_recv` | Timestamp received by Databento |
| `ts_event` | Timestamp of market event from exchange |
| `rtype` | Record type (160 = MBO) |
| `publisher_id` | Publisher identifier |
| `instrument_id` | Unique instrument ID (see symbology.csv) |
| `action` | Order action: R=Reset, A=Add, C=Cancel, M=Modify, T=Trade, F=Fill |
| `side` | Order side: B=Bid, A=Ask, N=None |
| `price` | Order price |
| `size` | Order size |
| `channel_id` | Market data channel |
| `order_id` | Unique order identifier |
| `flags` | Various flags |
| `ts_in_delta` | Timestamp delta |
| `sequence` | Sequence number |
| `symbol` | Human-readable symbol |

**Included Instruments** (from `symbology.json`):
- **Outright contracts**: NQH6, NQM6, NQU6, NQZ6, NQH7, NQM7, NQZ7, NQZ8, NQZ9, NQZ0
- **Calendar spreads**: NQH6-NQM6, NQH6-NQU6, NQH6-NQZ6, NQM6-NQU6, NQM6-NQZ6, NQU6-NQZ6, etc.

**Metadata Files**:
- `metadata.json` - Query parameters and job ID
- `symbology.json` - Instrument ID to symbol mapping
- `symbology.csv` - Daily symbol mappings
- `condition.json` - Data availability per date
- `manifest.json` - File checksums and download URLs

**IMPORTANT: Calendar Spread Filtering**: Same as OHLCV data, filter out symbols containing a dash (e.g., `NQH6-NQM6`) for outright futures analysis.

**Use Cases**:
- Order flow analysis and imbalance detection
- Reconstruction of limit order book at any point in time
- Trade execution quality analysis
- Market microstructure research
- High-frequency strategy backtesting

## Shared Utilities

The `/shared/` directory contains reusable components:
- `/shared/indicators/` - Technical analysis indicators (squeeze momentum, fibonacci, confluence, etc.)
- `/shared/strategies/` - Strategy implementations shared between live trading and backtesting (extend `base-strategy.js`)
- `/shared/utils/` - Common utilities (logger, technical analysis helpers)

## Trading Strategies

### GEX Scalp (Primary Live Strategy)
Fast scalping strategy that trades bounces off GEX Support 1 and Resistance 1 levels.
Implementation: `/shared/strategies/gex-scalp.js`

**Entry Conditions:**
- Long: Price within 3 points of Support 1 (S1)
- Short: Price within 3 points of Resistance 1 (R1)
- RTH session by default (9:30 AM - 4:00 PM EST), configurable via `ALLOWED_SESSIONS`
- Cooldown: 60 seconds between signals
- Not already in position

**Exit Parameters:**
- Target: 7 points profit
- Stop Loss: 3 points
- Trailing Stop: Activates at 3 points profit, trails 1 point behind
- Max Hold: 10 minutes (10 candles on 1m chart)
- Limit Order Timeout: Cancel unfilled orders after 3 candles

**Order Flow:**
1. Signal generates `place_limit` at current price
2. If not filled within 3 candles, sends `cancel_limit`
3. On fill, Tradovate manages bracket orders (stop/target/trailing)
4. On position close (via stop/target/trailing), strategy resets for next signal

**Signal Format (snake_case for trade orchestrator):**
```json
{
  "strategy": "GEX_SCALP",
  "action": "place_limit",
  "side": "buy",
  "symbol": "NQH6",
  "price": 21455.00,
  "stop_loss": 21452.00,
  "take_profit": 21462.00,
  "trailing_trigger": 3,
  "trailing_offset": 1,
  "quantity": 1
}
```

### GEX Recoil (Backtesting Strategy)
Enters long when price crosses below GEX support levels (put walls), anticipating a reversion to mean.
Used primarily for backtesting via the backtest engine.

**Entry Conditions:**
- Price crosses below a GEX support level (put_wall, gamma_flip, or support levels)
- Risk within acceptable parameters
- Cooldown period elapsed since last signal

**Key Parameters:**
- `targetPoints`: Profit target (default: 25 points)
- `stopBuffer`: Points below candle low for stop (default: 10)
- `maxRisk`: Maximum acceptable risk in points (default: 30)
- `useLiquidityFilter`: Filter by LT levels below entry
- `filterByLtConfiguration`: Use LDPM pattern analysis

**LT Configuration Filters:**
Based on historical performance analysis:
- BULLISH sentiment: ~$169 avg P&L (2x better than BEARISH) — but sentiment is derived from level configuration, not independently informative
- ASCENDING ordering: Poor performer ($8 avg), typically blocked
- BULLISH_REVERSAL / BEARISH_REVERSAL: Negative P&L, blocked
- WIDE spacing: Best performance ($121 avg)

**⚠️ Important:** Sentiment-based filtering has historically been the focus, but the underlying price levels themselves carry stronger predictive signal. Level crossing events (a Fibonacci lookback zone migrating through spot price) predict post-event direction at ~74% accuracy. Future LT filter work should prioritize level dynamics (crossing, migration, convergence) over the derived sentiment label. See `scripts/analyze-lt-dynamics-vs-cbbo.js` for the crossing analysis.

## Symbol Conventions

### TradingView Symbols
- `NQ1!` - Nasdaq 100 E-mini continuous front-month contract
- `ES1!` - S&P 500 E-mini continuous front-month contract
- Format: `{ROOT}{MONTH_CODE}!` or `{ROOT}1!` for continuous

### Broker Symbols (Tradovate)
- `MNQZ5` - Micro Nasdaq December 2025 contract
- `MNQ` - Base symbol for micro Nasdaq
- Format: `{ROOT}{MONTH}{YEAR}` where month is F,G,H,J,K,M,N,Q,U,V,X,Z

### GEX/Options Symbols
- `QQQ` - Options tracked for Nasdaq GEX calculation
- `SPY` - Options tracked for S&P GEX calculation
- GEX levels are translated from ETF prices to futures prices using live ratios

### Month Codes
F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec

## Debugging

### Redis Commands
```bash
# Check Redis is running
redis-cli ping

# Monitor all Redis traffic in real-time
redis-cli monitor

# List active pub/sub channels
redis-cli pubsub channels

# Subscribe to a channel manually
redis-cli subscribe "price.update"

# Check channel subscriber count
redis-cli pubsub numsub "trade.signal"
```

### Service Health
```bash
# Check all service health endpoints
curl http://localhost:3011/health  # Tradovate
curl http://localhost:3012/health  # Market Data
curl http://localhost:3013/health  # Trade Orchestrator
curl http://localhost:3014/health  # Monitoring
curl http://localhost:3015/health  # Signal Generator
```

### Test Webhook
```bash
curl -X POST http://localhost:3014/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_type": "trade_signal",
    "secret": "your_webhook_secret",
    "action": "place_limit",
    "side": "buy",
    "symbol": "NQ1!",
    "price": 21000.00,
    "stop_loss": 20980.00,
    "take_profit": 21050.00,
    "quantity": 1,
    "strategy": "TEST"
  }'
```

## Troubleshooting

### Redis Connection Failures
**Symptom**: Services fail to start with Redis connection errors
**Solutions**:
1. Verify Redis is running: `redis-cli ping`
2. Check Redis host/port in `shared/.env`
3. Restart Redis: `sudo systemctl restart redis`

### WebSocket Reconnection Issues
**Symptom**: TradingView data stops streaming
**Solutions**:
1. Check `pm2 logs signal-generator` for auth errors
2. Verify `TRADINGVIEW_CREDENTIALS` in `.env`
3. Restart signal generator: `pm2 restart signal-generator`

### Service Startup Order Failures
**Symptom**: Services report missing dependencies
**Solution**: Use `./start-all.sh` which handles startup order, or start manually in order:
1. Tradovate Service
2. Market Data Service
3. Trade Orchestrator
4. Monitoring Service
5. Signal Generator

### No Trade Signals Generated
**Symptoms**: Strategy running but no signals
**Check**:
1. GEX levels loaded: `curl http://localhost:3015/gex/levels`
2. Price streaming: `redis-cli subscribe "price.update"`
3. Strategy enabled: Check `STRATEGY_ENABLED=true` in `.env`
4. Session filter: Check `USE_SESSION_FILTER` and `ALLOWED_SESSIONS` settings
5. Check strategy status: `curl http://localhost:3014/api/strategy/gex-scalp/status`
6. GEX Scalp cooldown is 60 seconds between signals

### Backtest Data Issues
**Symptom**: Backtest fails with missing data
**Solutions**:
1. Verify CSV data exists in `backtest-engine/data/`
2. Check date range matches available data
3. Ensure ticker matches data file naming convention