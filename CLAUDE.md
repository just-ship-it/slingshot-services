# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a microservices trading system called "Slingshot" with independent services communicating via Redis pub/sub. The system handles webhook ingestion, Tradovate API interactions, real-time market data sourcing, trade orchestration, strategy evaluation, AI-powered trading, and monitoring.

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

## Architecture

### Service Structure
- **Port 3011**: Tradovate Service - All Tradovate API interactions (orders, positions, WebSocket)
- **Port 3013**: Trade Orchestrator - Business logic, signal routing, and trade coordination
- **Port 3014**: Monitoring Service - Webhook ingestion, data aggregation, dashboard APIs (only public-facing service, binds 0.0.0.0)
- **Port 3015**: Signal Generator Service - Multi-strategy evaluation engine, consumes market data from data-service via Redis
- **Port 3017**: Macro Briefing Service - Daily macro trading briefing generation using Claude AI
- **Port 3018**: AI Trader Service - AI-powered trading strategy using Claude AI (same codebase as signal-generator with `ACTIVE_STRATEGY=ai-trader`)
- **Port 3019**: Data Service - Centralized market data sourcing: TradingView streaming, GEX calculations (CBOE + hybrid Tradier), LT monitoring, candle management, IV skew
- **Port 3020**: Dashboard UI - React frontend served via `serve`

### Key Dependencies
- All services use Node.js with ES modules (`"type": "module"` in package.json)
- Shared utilities in `/shared/` directory provide common functionality across all services
- Redis pub/sub handles inter-service communication
- All services import from `../shared/index.js` for logging, message bus, and configuration
- Express servers provide HTTP endpoints for external access and health checks

### Message Bus Channels
Channels are defined in `shared/index.js` (`CHANNELS` constant). Major groups: webhook.*, trade.*, order.*, position.*, price.*, account.*, service.*, plus data-service events (`lt.levels`, `gex.levels`, `candle.close`, `gex.refresh`, `vex.levels`, `cex.levels`) and `strategy.status`. When adding new channels, register them in `shared/index.js` and import via `import { CHANNELS } from '../shared/index.js'`.

### Configuration
- Environment variables managed through `shared/.env`
- PM2 configuration in `ecosystem.config.cjs`

### Service Dependencies (startup order, handled by `start-all.sh`)
1. Tradovate Service
2. Trade Orchestrator
3. Monitoring Service (handles all webhook ingestion)
4. Data Service (sources TradingView data, GEX, LT levels)
5. Signal Generator Service (depends on data-service publishing via Redis)
6. AI Trader Service (separate PM2 instance of signal-generator with `ACTIVE_STRATEGY=ai-trader`)
7. Macro Briefing Service (independent; cron-scheduled)

When adding a new service, mirror the pattern in `tradovate-service/index.js` and register it in `ecosystem.config.cjs`, `start-all.sh`, and `stop-all.sh`.

## Webhook Trade Signal Format

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
  "trailing_trigger": 22,
  "trailing_offset": 6,
  "quantity": 1,
  "strategy": "SHORT_DTE_IV"
}
```

**Supported Actions:** `place_limit`, `place_market`, `position_closed`, `cancel_limit`, `modify_stop`

**Key Fields:**
- `trailing_trigger` / `trailing_offset`: Distance in points (not price) for trailing stop activation and offset
- `strategy`: Strategy identifier (e.g., `IV_SKEW_GEX`, `SHORT_DTE_IV`, `AI_TRADER`)

## Order Execution and Backtesting

### CRITICAL: Strategy research MUST use 1s OHLCV from the fill instant onward

This rule supersedes any earlier "ambiguity resolution" pattern in this repo. Drew has been burned by 1m-bar optimism in live trading multiple times — see `memory/feedback_1s_research_mandatory.md` for the why.

**MANDATORY for any research producing WR / PF / Sharpe / drawdown numbers:**

1. **Fills must be simulated on 1s OHLCV.** Limit orders: first 1s bar (after order placement) where `low <= limit_price` (BUY) or `high >= limit_price` (SELL). Market orders: next 1s bar's open after the signal candle closes. Fill ts = that 1s bar's timestamp.
2. **Stop/target evaluation walks 1s bars chronologically from fill_ts.** First side to hit wins. Never use any 1s bar with `ts < fill_ts` to evaluate exits.
3. **The 1m bar containing the fill is NOT a unit of analysis.** Don't check `bar.high >= target` on the full 1m fill bar — only the 1s subset from fill_ts onward.
4. **Same-bar "ambiguous → retroactive 1s resolve" is the SAME bug.** A resolver that walks 1s from the MINUTE START still includes pre-fill 1s ticks.
5. **MFE/MAE measured from the fill instant**, walking 1s bars forward to max-hold ceiling, rollover, or EOD cutoff.
6. **Verification before trusting research numbers:** run a small 1s-honest replication of the top filter on the same date range. If trade count, WR, and PF don't match within ~10%, the research has the fill-bar bug.
7. **Suspect this bug first** when research produces PF / Sharpe that materially exceed already-validated 1s strategies.

The 1s file (`backtest-engine/data/ohlcv/nq/NQ_ohlcv_1s.csv`) is 7.6GB sorted by `ts_event`. Stream with readline + lex-compare on the ISO timestamp. See `research/gex-touch-confirm/06-precompute-s1-vwap.js` for the streaming pattern (also demonstrates per-hour primary gate).

Strategies in `shared/strategies/*` already operate on 1s data via the engine's `SecondDataProvider` — that path is honest. The risk is purely in offline research scripts that aggregate to 1m for speed.

### Order Fill Logic (Critical for Backtesting Accuracy)

**IMPORTANT**: The backtest engine simulates order execution with specific logic that must be followed to ensure accurate results.

#### Limit Orders
Limit orders fill at the EXACT limit price when the market reaches that level:

**BUY Limit Orders:**
- Fill condition: `candle.low <= limit_price`
- Fill price: Exactly `limit_price` (no slippage)

**SELL Limit Orders:**
- Fill condition: `candle.high >= limit_price`
- Fill price: Exactly `limit_price` (no slippage)

#### Market Orders
Market orders fill immediately with slippage applied:
- **BUY Market**: Fill at `candle.close + slippage`
- **SELL Market**: Fill at `candle.close - slippage`

#### Stop Loss Orders
Stop losses convert to market orders when triggered, incurring slippage:
- **BUY Stop Loss**: When `candle.low <= stop_price`, fill at `stop_price - slippage`
- **SELL Stop Loss**: When `candle.high >= stop_price`, fill at `stop_price + slippage`

**Key principle**: Limit orders should NEVER have slippage — they either fill at the limit price or not at all. EVERY other exit slips (fixed 2026-07-13): stop-type exits (`stop_loss`, `trailing_stop`/breakeven) take `stopOrderSlippage`; time/market exits (`eod_liquidation`, `market_close`, `max_hold_time`, etc.) take `marketOrderSlippage`. Golds generated before 2026-07-13 credited BE/trailing exits with zero slippage and are optimistic. Implementation: `/backtest-engine/src/execution/trade-simulator.js` `checkOrderFill()` / `exitTrade()`.

## Dashboard (React Frontend)

**Location**: `/mnt/c/projects/ereptor/slingshot/frontend` | **Port**: 3002
React 18 + Tailwind CSS + Socket.io + Lightweight Charts. Communicates exclusively through Monitoring Service (3014) via REST `/api/*` endpoints and WebSocket. Auth via Bearer token in localStorage (`dashboardToken`).

## Data Service (Port 3019)

Centralized market data sourcing and aggregation layer — single authoritative source for all real-time market data.

### Core Functionality
- **TradingView Data Streaming**: Real-time OHLCV data (NQ, ES) and quote-only updates (MNQ, MES, QQQ, SPY, BTC) via WebSocket
- **Liquidity Trigger (LT) Monitoring**: Dedicated WebSocket connections per product (NQ, ES) for support/resistance levels
- **GEX Level Calculation**: CBOE-based gamma exposure calculations for NQ (from QQQ) and ES (from SPY)
- **Hybrid GEX Mode**: Blends Tradier real-time exposure data with CBOE GEX when `HYBRID_GEX_ENABLED=true`
- **Candle Management**: Per-symbol 1-minute (600 bars) and 1-hour (500 bars) candle buffers with close detection
- **IV Skew Calculation**: Call/put IV skew from Tradier data
- **Tradier Exposure Service**: Optional real-time options Greeks (VEX, CEX)

**Note**: Key components (TradingView client, LT monitor, GEX calculators) still live under `/signal-generator/src/` but are imported by data-service.

## Signal Generator Service (Port 3015)

Pure strategy evaluation engine. Consumes market data from Data Service via Redis pub/sub, applies configured strategies, generates trade signals.

- **Multi-Strategy Engine**: `/signal-generator/src/strategy/multi-strategy-engine.js` — subscribes to `candle.close`, `gex.levels`, `lt.levels`, `price.update`
- **Strategy Config**: `/signal-generator/strategy-config.json` — enable/disable strategies per product with priority ordering
- **Strategy Factory**: `/signal-generator/src/strategy/strategy-factory.js` — registered live strategies
- **Position State**: Tracks positions per product, syncs with Tradovate at startup, reconciles every 5 minutes

### Active Strategies
- **IV-SKEW-GEX** (`iv-skew-gex`): IV skew + GEX confluence (1m timeframe, requires `--raw-contracts` for backtesting)
- **Short-DTE-IV** (`short-dte-iv`): 0-DTE QQQ IV change predicts NQ direction (15m timeframe)

### Environment Configuration
- `ACTIVE_STRATEGY`: Strategy mode (`multi-strategy` or `ai-trader`)
- `STRATEGY_ENABLED`: Enable/disable strategy evaluation (true/false)
- `TRADING_SYMBOL`: Symbol to trade (e.g., `NQM6`)
- `DEFAULT_QUANTITY`: Default order quantity
- `USE_SESSION_FILTER`: Enable session-based filtering (true/false, default: true)
- `ALLOWED_SESSIONS`: Comma-separated sessions to trade (overnight, premarket, rth, afterhours)

## AI Trader Service (Port 3018)

Separate PM2 instance of signal-generator codebase with `ACTIVE_STRATEGY=ai-trader`. Uses Claude API (Sonnet) for market analysis and trade decisions.

- **AI Strategy Engine**: `/signal-generator/src/ai/`
- **Live Feature Aggregator**: `/signal-generator/src/ai/live-feature-aggregator.js` — collects 1m/1h candles, GEX, LT levels
- **Historical Seeding**: Seeds 500 bars (1m) + 300 bars (1h) from data-service HTTP API at startup
- **Cost Tracking**: Monitors LLM API usage costs

## Macro Briefing Service (Port 3017)

Generates daily macro trading briefings using Claude AI. Located in `/macro-briefing/`.
Cron-scheduled (default: 6:30 AM ET weekdays), Anthropic SDK, email via nodemailer.

## Backtest Engine

CLI tool for historical strategy analysis. Located in `/backtest-engine/`.

### Gold Standard Commands

Per-strategy invocations, current gold-standard numbers, alternate presets, and version histories are in **`backtest-engine/STRATEGY-GOLD-STANDARDS.md`**. Lookahead-bias correction history (2026-04-30 → 2026-05-06) is in `backtest-engine/data/gold-standard/lookahead-fix-history.md`. Auto-memory `MEMORY.md` entries track the latest live-default changes.

Run `node index.js --help` for all available strategies and options.

### Key Architecture
- `/backtest-engine/src/backtest-engine.js` - Core engine
- `/backtest-engine/src/execution/trade-simulator.js` - Order fill simulation
- `/backtest-engine/src/data/csv-loader.js` - Historical data loading
- `/backtest-engine/data/` - Historical candle, GEX, LT, IV, and options data (CSV/JSON)

## CRITICAL: Price Space & Contract Rollover Rules

**MANDATORY READING for any analysis, backtesting, or strategy work involving historical data.** Failure here has produced wrong results repeatedly (e.g., 84% WR when actual is 30%).

### Two price spaces — NOT interchangeable

| File | Price Space | Example (Dec 2020 NQH1) |
|------|-------------|--------------------------|
| `NQ_ohlcv_1m.csv` | **Raw contract** — actual traded prices | 12,676 |
| `NQ_ohlcv_1m_continuous.csv` | **Back-adjusted** — shifted to form a continuous series | 15,643 (shifted +2,967) |

### LT and GEX levels are ALWAYS raw contract prices

LT levels in `backtest-engine/data/liquidity/` and GEX levels are in raw contract price space. They MUST be compared against raw OHLCV (`NQ_ohlcv_1m.csv` + `filterPrimaryContract()`), NEVER continuous data. Comparing against continuous data produces phantom 200+ point gaps.

### When to use raw vs continuous

- **Raw contracts (`--raw-contracts`)**: REQUIRED for any analysis involving LT levels, GEX levels, or GEX proximity. **When in doubt, use raw.**
- **Continuous**: Only for pure price-action analysis with no external level data.

### `filterPrimaryContract()` is mandatory for raw data

Raw OHLCV files contain multiple contract months simultaneously (e.g., NQH5 at 21200 and NQM5 at 21425 at the same timestamps) plus calendar spread rows (symbol contains `-`, e.g. `NQH1-NQM1` — these are price *differences*, not quotes). Loading unfiltered causes artificial price swings, false signals, invalid results.

`filterPrimaryContract()` (in `csv-loader.js`) groups by hour, picks the highest-volume contract per hour, and drops calendar spreads. **Always use it when loading raw OHLCV for analysis or backtesting.**

### Contract rollover (CRITICAL)

When `filterPrimaryContract()` switches to a new front month, prices appear to "jump" by the roll spread (NQ typically 200-300 points). **This is a contract change, not a market move.** Exact spreads per roll date in `backtest-engine/data/ohlcv/nq/NQ_rollover_log.csv`.

When writing code that spans rollovers:
1. Track the `symbol` column — it's the source of truth for which contract a row belongs to.
2. Detect symbol changes — that's the rollover.
3. Force-close any open position at the last price of the old contract (or translate via roll-log spread).
4. Flush/shift cached levels (LT, GEX, S/R) by the roll spread.
5. Never assume prices are continuous across the boundary.

The trade simulator attempts cross-contract conversion via calendar spread bars, but fails silently when spread data is missing — trades get "stuck" on a contract that stopped emitting candles. Handle rollovers explicitly in research code.

### GEX Data Generation

Intraday GEX data (15-min snapshots) generated via `backtest-engine/scripts/generate-intraday-gex.py`. Supports NQ (from QQQ options) and ES (from SPY options). Uses Brenner-Subrahmanyam IV approximation from OPRA statistics.

## Shared Utilities

The `/shared/` directory contains reusable components:
- `/shared/indicators/` - Technical analysis indicators (squeeze momentum, fibonacci, confluence, etc.)
- `/shared/strategies/` - Strategy implementations shared between live trading and backtesting (extend `base-strategy.js`)
- `/shared/utils/` - Common utilities (logger, technical analysis helpers)

## Symbol Conventions

- **TradingView**: `NQ1!` / `ES1!` continuous front-month; format `{ROOT}{MONTH_CODE}!` or `{ROOT}1!`
- **Broker (Tradovate)**: `{ROOT}{MONTH}{YEAR}` e.g. `MNQM6` = Micro Nasdaq June 2026. Month codes: F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec
- **GEX/Options**: `QQQ` → Nasdaq GEX, `SPY` → S&P GEX (translated from ETF to futures prices using live ratios)

## Debugging

### Troubleshooting
- **Redis connection failures**: `redis-cli ping`, check `shared/.env`, `sudo systemctl restart redis`
- **TradingView data stops**: `pm2 logs data-service`, verify `TRADINGVIEW_CREDENTIALS`, `pm2 restart data-service`
- **No trade signals**: Check GEX levels (`curl localhost:3019/gex/levels?product=NQ`), price streaming (`redis-cli subscribe "price.update"`), `STRATEGY_ENABLED=true`, session filter, data service health
- **Service startup issues**: Use `./start-all.sh` which handles order
- **Backtest data issues**: Verify CSV in `backtest-engine/data/`, check date range, confirm ticker matches file naming

### Production Logs (Sevalla MCP)

First step for diagnosing production issues. Uses `mcp__sevalla__search` (discover endpoints) and `mcp__sevalla__execute` (make API calls via `sevalla.request()`).

**Gotcha:** the MCP base URL already includes `/v3`. All paths must omit it — `/v3/applications/...` returns 404. Code examples and full query parameter reference in `memory/sevalla-mcp.md`.

**Service app IDs** (also in `deploy.config.json`):

| Service | App ID |
|---------|--------|
| tradovate-service | `70a68761-395c-4773-9bc0-7bdb9dcddc53` |
| trade-orchestrator | `588e37da-cebf-4be1-892b-58e67569c813` |
| monitoring-service | `62c3e8a4-bb68-440e-b3d5-6c0e889393e8` |
| data-service | `af7aeee4-8712-4a62-994f-c9d09d70d15e` |
| signal-generator | `1fe0898f-1f2c-4677-bea8-71012cbd2188` |
| ai-trader | `081d3d7f-f464-4501-964e-34b30ff43a32` |
| macro-briefing | `a287bf53-0e8f-44e5-a3ae-4bcf03a4637b` |

**Auth:** OAuth via `/mcp` command after each Claude Code restart.

### Selective Deployment

`deploy.sh` diffs changes since the last deploy, maps affected directories to Sevalla services, and only redeploys what changed. Config in `deploy.config.json`, last-deploy marker in `.last-deploy`.

```bash
./deploy.sh              # Auto-detect and deploy affected services
./deploy.sh --dry-run    # Preview without deploying
./deploy.sh --all        # Deploy everything
./deploy.sh --status     # Show pending changes since last deploy
```

Requires `SEVALLA_API_KEY` env var. Changes to `shared/` trigger all services.
