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

### Prerequisites Check
- Redis must be running: `redis-cli ping`
- Environment file: Copy `shared/.env.example` to `shared/.env` and configure

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
The system uses predefined Redis channels for communication (defined in `shared/index.js`):
- Webhook events: `webhook.received`, `webhook.validated`, `webhook.rejected`, `webhook.quote`, `webhook.trade`
- Trading signals: `trade.signal`, `trade.validated`, `trade.rejected`
- Order events: `order.request`, `order.placed`, `order.filled`, `order.rejected`, `order.cancelled`
- Position events: `position.opened`, `position.closed`, `position.update`, `position.realtime_update`
- Market data: `price.update`, `market.connected`, `market.disconnected`, `quote.request`, `quote.response`
- Account events: `account.update`, `balance.update`, `margin.update`
- System events: `service.health`, `service.error`, `service.started`, `service.stopped`
- Sync events: `tradovate_sync_completed`
- Data Service events: `lt.levels`, `gex.levels`, `candle.close`, `gex.refresh`, `vex.levels`, `cex.levels`
- Strategy events: `strategy.status`

### Configuration
- Environment variables are managed through `shared/.env`
- Each service has its own `package.json` with consistent script structure
- PM2 configuration in `ecosystem.config.cjs` defines all service startup parameters
- Default ports are defined but configurable via environment variables

### Service Dependencies
Services must start in this order (handled by `start-all.sh`):
1. Tradovate Service (depends on message bus)
2. Trade Orchestrator (depends on message bus)
3. Monitoring Service (depends on message bus, handles all webhook ingestion)
4. Data Service (depends on message bus; sources TradingView data, GEX, LT levels)
5. Signal Generator Service (depends on data-service publishing market data via Redis)
6. AI Trader Service (depends on data-service; runs as separate PM2 instance of signal-generator codebase)
7. Macro Briefing Service (independent; cron-scheduled)

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

**This rule supersedes any earlier "ambiguity resolution" pattern in this repo.** It exists because the same bug has bitten us repeatedly: research builds a strategy on optimistic 1m-bar logic, the strategy looks great on paper, the backtest engine (which simulates 1s honestly) runs it, and the live performance collapses. Drew has been burned by this in live trading multiple times.

**MANDATORY for any research script that produces WR / PF / Sharpe / drawdown numbers used to design a strategy:**

1. **Fills must be simulated on 1s OHLCV.** Detect the fill instant exactly:
   - For limit orders: the first 1s bar (after order placement) where `low <= limit_price` (BUY) or `high >= limit_price` (SELL). Fill ts = that 1s bar's timestamp.
   - For market orders: the next 1s bar's open after the signal candle closes. Fill ts = that 1s bar's timestamp.

2. **Stop/target evaluation runs forward in 1s ORDER from the fill instant.** Walk 1s bars chronologically starting at fill_ts. First side to hit (stop or target) wins. Do NOT use any 1s bar with `ts < fill_ts` to evaluate exits — that data describes a trade that didn't exist yet.

3. **The 1m bar containing the fill is NOT a unit of analysis.** Do not check `bar.high >= target` or `bar.low <= stop` on the full 1m fill bar. Use only the 1s subset from fill_ts onward.

4. **Same-bar "ambiguous → retroactive 1s resolve" is the SAME bug.** A resolver that walks 1s from the MINUTE START still includes pre-fill 1s ticks. Don't do this.

5. **MFE/MAE for events must be measured from the fill instant**, walking 1s bars forward to a max-hold ceiling, contract rollover, or EOD cutoff (whichever comes first).

6. **Verification check before trusting research numbers:** before writing a strategy file based on a research output, run a small 1s-honest replication of the top filter on the same date range. If trade count, WR, and PF don't match the research within ~10%, the research has the fill-bar bug. Fix the research, not the strategy.

7. **Suspect this bug first** when research produces PF / Sharpe that materially exceed already-validated 1s strategies (e.g., gex-flip-ivpct post-fix PF 4.29, Sharpe 10.60).

The 1s file (`backtest-engine/data/ohlcv/nq/NQ_ohlcv_1s.csv`) is 7.6GB and sorted by `ts_event`. Stream it with readline + lex-compare on the ISO timestamp for fast date-range filtering. Use the same per-hour primary-contract filter as the 1m loader; the per-hour primary map can be precomputed from 1m data once. See `research/gex-touch-confirm/06-precompute-s1-vwap.js` for the streaming pattern (it also demonstrates the per-hour primary gate).

Strategies in `shared/strategies/*` already operate on 1s data via the engine's `SecondDataProvider` — that path is honest. The risk is purely in offline research scripts that aggregate to 1m for speed and then "fix it" with a retroactive 1s pass.

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

**Key principle**: Limit orders should NEVER have slippage — they either fill at the limit price or not at all. Only market orders and triggered stop losses experience slippage. Implementation: `/backtest-engine/src/execution/trade-simulator.js` `checkOrderFill()`.

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

### Logging
- Use shared logger: `import { createLogger } from '../shared/index.js'`
- PM2 provides centralized log management: `pm2 logs [service-name]`

## Service Endpoints

### Public Endpoints (Monitoring Service - Port 3014)
- `POST /webhook` - Receives trade signals and quotes
- `GET /api/dashboard` - Dashboard data aggregation
- `GET /api/gex/levels` - Current GEX levels (proxied from data-service)
- `POST /api/gex/refresh` - Force GEX recalculation
- `GET /api/strategy/gex-scalp/status` - Real-time strategy monitoring
- `POST /api/trading/enable|disable` - Trading kill switch
- `GET /health` - Service health status
- `ws://localhost:3014` - Real-time WebSocket updates

Note: Internal services bind to 127.0.0.1. Only the monitoring service (3014) binds to 0.0.0.0. See individual service `index.js` files for their specific endpoints.

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
- **IV-SKEW-GEX** (`iv-skew-gex`): IV skew + GEX confluence strategy (1m timeframe, requires `--raw-contracts` for backtesting)
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

> **2026-05-06 lookahead fix applied.** A 14-min spot lookahead was found in `generate-intraday-gex.py` and `generate-cbbo-gex.js` (snapshots labeled `T:00` actually contained data through `T:14:59`). All three GEX directories were one-shot relabeled with `scripts/relabel-gex-timestamps.js`; both generators now bucket on `(ts + 1min).ceil('15min')` so future runs are correct. Backups at `*.lookahead-bak`. **All gold-standard numbers below are the post-fix re-runs and supersede prior figures.**

**IV-SKEW-GEX** (1m IV resolution, raw contracts, cbbo-derived GEX, shared-calc IV):
```bash
cd backtest-engine
node index.js --ticker NQ --strategy iv-skew-gex --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --target-points 200 --stop-loss-points 60 --max-hold-bars 90 \
  --breakeven-stop --breakeven-trigger 140 --breakeven-offset 10 \
  --blocked-regimes strong_negative \
  --level-proximity 100 \
  --neg-skew-threshold 0.0145 --pos-skew-threshold 0.0250 \
  --iv-resolution 1m \
  --gex-dir data/gex/nq-cbbo
```
**Post-fix baseline (2026-05-06):** 244 trades, **$92,164** PnL, 49.6% WR, **PF 1.64**, Sharpe 3.97, **Max DD 9.23%** over 16 months. Same trade count as the pre-fix gold standard (signals fire on the same conditions) but materially worse fills/exits. **The current SL/TP/BE params (60 / 200 / 140-10) and skew thresholds (0.0145 / 0.0250) were sweep-tuned against the lookahead-biased data and are no longer optimal — re-tune via `research/PROMPT-reoptimize-stops-targets-post-lookahead-fix.md`.**

Pre-fix v8 gold standard for historical reference: 244 trades, $136,864 PnL, 51.6% WR, PF 2.03, Sharpe 5.71, Max DD 6.04%. Trades JSON: `data/gold-standard/iv-skew-gex-v8-balanced.json` (do NOT use for live deployment — generated under lookahead-biased GEX).

The 5/2 sweeps (93 main + 21 fu + 12 mv3 + 10 mv4 = 136 combos in `/tmp/overnight-sweep/`) compounded four improvements over the 5/1 baseline (291/$116k/PF 1.91/Sharpe 4.71/DD 7.20%):
1. **Lower negSkewThreshold** (0.0165 → 0.0145): tighter LONG selectivity.
2. **Wider BE offset** (5 → 10): bigger profit on the rare BE-floor exits.
3. **Very late BE trigger** (60 → 140): BE arms only on extreme MFE retracements. Most trades exit cleanly via TP=200 or SL=−60 instead of getting clipped at the +10 floor.
4. **Longer maxHold** (60 → 90 bars): lets the rare big winner run the full 90 minutes instead of timing out at 60.

Combined improvement: +0.12 PF, +1.00 Sharpe, **-1.16pp DD**, +$21k PnL.

The posSkewThreshold is insensitive in the 0.024–0.028 range — once skew exceeds the +0.025 fear-spike level, results barely change.

**MUST include `--level-proximity 100`** — the default of 25 is too tight and reduces trade count to ~94 with mediocre performance. The 100pt window lets price proximity to S1-S5/R1-R5/PutWall/CallWall/GammaFlip levels be the binding signal filter.

**Both skew thresholds are POSITIVE** because the natural ATM put-call structural skew on 7-DTE QQQ sits at +1.74% (puts persistently richer due to crash-hedge demand). LONG fires when skew dips below +1.45% (calls relatively expensive), SHORT fires when skew spikes above +2.50% (puts unusually expensive). Distribution stdev is only 0.35% — the strategy reads deviations from the +1.74% baseline.

Exit logic: at +140pts MFE, stop moves to entry+10 (locks 10pts profit). The +140 trigger is so late that BE rarely arms — most trades exit via TP=200, SL=-60, or maxHold=90 bars. Plus regime filter: rejects entries when `gexLevels.regime === 'strong_negative'`.

### v8 risk modes — pre-fix sweeps (STALE post 2026-05-06 lookahead fix)

> The table below was sweep-tuned against the lookahead-biased GEX. It's preserved as historical context but **none of these modes are valid baselines anymore**. The "Balanced" config is the current code default; its post-fix performance is in the headline command above. The other modes have not been re-measured under fixed data — assume similar 17–33% PnL/PF degradation pending re-sweep.

All variants share `--target-points 200 --level-proximity 100 --neg-skew-threshold 0.0145 --pos-skew-threshold 0.0250 --breakeven-offset 10 --blocked-regimes strong_negative` unless noted.

| Mode | Config | Trades | WR | PF | Sharpe | DD | PnL | Status |
|---|---|---:|---:|---:|---:|---:|---:|---|
| **Balanced** (default) | SL=60, BE=140, mh=90 | 244 | 51.6% | 2.03 | 5.71 | 6.04% | $137k | Pre-fix; see headline cmd for post-fix numbers |
| **Aggressive** (PnL) | SL=80, BE=130, mh=90 | 233 | 58.4% | 2.05 | 5.54 | 8.06% | $141k | Pre-fix; needs re-measurement |
| **Even-longer hold** | SL=60, BE=130, mh=120 | 234 | 53.0% | 2.07 | 5.70 | 6.83% | $139k | Pre-fix; needs re-measurement |
| **Earlier BE** | SL=60, BE=120, mh=90 | 244 | 53.3% | 2.05 | 5.54 | 6.98% | $135k | Pre-fix; needs re-measurement |
| **5/1 Baseline** | SL=60, BE=60+5, neg=0.0165, mh=60 | 291 | 60.5% | 1.91 | 4.71 | 7.20% | $116k | Pre-fix |
| **Selective Tight** | SL=80, neg=+0.0100 (+TP/SL=120/80) | 63 | 73.0% | 2.48 | 1.93 | 6.16% | $35k | Pre-fix |

**Key insight on the BE × maxHold interaction**: at BE=140 the floor barely ever arms — most trades just run their TP/SL/maxHold course. Lengthening maxHold from 60 → 90 then captures more upside on trades that haven't yet hit TP=200, while DD stays bounded by the -60 SL. The combined effect on the equity curve is much smoother (Sharpe 5.71) and DD drops to 6.04% — exceptional for a 16-month, 0.75-trade-per-day strategy. Avg win is now ~$1900 vs $1380 at the 5/1 baseline.

The fine-grained skew sweep showed neg=0.0145–0.0165 forms a plateau (Sharpe 4.93–5.02), with neg=0.0145 the local optimum. Cliff still exists at neg≥0.0173 — PF crashes from 1.94 → 1.30, trades 3x explode (~900) into noise region, DD blows out to 30%+. Natural trade ceiling is ~300/16mo with quality.

The v6 Tight filter set (level + max-iv) actively HURTS v8: it indiscriminately trims good signals with bad. The threshold sweep already finds the right selectivity — additional filters add nothing. Stick with Balanced or Aggressive.

**Lookahead-bias correction history (2026-04-30 → 2026-05-06)**: Four separate corrections to reach honest baseline:
1. **cbbo GEX `ts_event` bucketing fix** (4/30): late-arriving rows polluted earlier 15-min buckets with future-day quotes. v6 = v5 config re-run on corrected GEX. Reduced PnL by ~40%, PF by ~32%.
2. **IV CSV regen #1** (5/1 morning): four bugs in `precompute-iv.js` (ts_event bucketing, no forward-fill, missing DTE tiebreaker, midnight-local expiration time). v7 = v6 with corrected IV. Reduced PnL by ~60%, PF 2.37 → 1.32. **Still buggy.**
3. **precompute-iv.js → shared calculator** (5/1 evening): replaced precompute's local `calculateATMIV` (used QQQ-ETF-close as spot) with the shared `calculateATMIVFromQuotes` (uses parity-derived spot from chain itself). Eliminated implementation drift between backtest precompute and live signal-generator. v8 = v7 with byte-identical-to-live IV. **Result: same $113k PnL with HALF the trades, +0.58 PF, +1.48 Sharpe, -10pp DD.** v8 thresholds had to flip POSITIVE because skew distribution is concentrated at +1.74% (natural ATM put-call structural skew).
4. **GEX snapshot bucket-label fix** (5/6): both generator scripts (`generate-intraday-gex.py:load_ohlcv_for_date` and `generate-cbbo-gex.js:loadSpotPrices`/`loadCBBO`) floored OHLCV bucketing to interval-start and kept the LAST close — so a snapshot labeled `T:00` actually contained spot at `~T:14:59`. Every NQ-space field (multiplier, walls, gamma_flip, regime, gamma_imbalance) inherited the 14-min spot lookahead. Both generators now bucket on `(ts + 1min).ceil('15min')`. All existing JSONs in `data/gex/nq/`, `data/gex/nq-cbbo/`, and `data/gex-cbbo/nq/` were one-shot relabeled (each timestamp shifted +15min). **Result: v8 balanced same 244 trades but $137k → $92k PnL, PF 2.03 → 1.64, Sharpe 5.71 → 3.97, DD 6.04% → 9.23%.** Discovered while investigating a candidate `gex-imbalance-shift` strategy whose Pearson r=0.67 vs forward returns dropped to −0.03 with honest timing.

Pre-v8 history: v2 (stats lookahead): PF 7.65. v3-v5 (cbbo with ts_event bug): PF 2.94-3.51. v6 (corrected cbbo, broken IV): PF 2.37. v7 (corrected IV, but precompute drift from live): PF 1.32. v8 pre-bucket-fix: PF 2.03. **v8 post-bucket-fix (5/6) is the current honest baseline at PF 1.64.** Trade-by-trade backtest-to-live parity should now hold.

Stale JSONs (DO NOT USE for live deployment): `iv-skew-gex-cbbo-v6-*` (broken IV), `iv-skew-gex-v7-*` (precompute-vs-live drift).

**IMPORTANT**: Must use `--timeframe 1m --raw-contracts` — without `--raw-contracts`, continuous data breaks GEX proximity calculations and produces invalid results.

**IMPORTANT**: Must include `--gex-dir data/gex/nq-cbbo` — without it, the engine falls back to legacy daily CSV (1 EOD snapshot/day) which produces totally different (and lookahead-biased) results.

**GEX-FLIP-IVPCT** (5m timeframe, 1m IV resolution, day-trade-margin friendly):

> **2026-05-12 tight-stop refit.** The original per-rule stops (106-184pt) capped single-trade losses at $3,720 and produced 10.5% trades with catastrophic giveback (best example: +153pt MFE → -186pt = $6,780 round trip). Untradable on a small account. A 20-combo sweep produced a tight-stop config that **caps single-trade loss at $1,240** while preserving most of the strategy edge.

```bash
cd backtest-engine
node index.js --ticker NQ --strategy gex-flip-ivpct --timeframe 5m --raw-contracts \
  --start 2025-01-13 --end 2026-04-20 \
  --iv-resolution 1m \
  --eod-cutoff-et 16:40 \
  --gfi-stop-pts 60 --gfi-target-pts 200 \
  --gfi-breakeven-stop --gfi-breakeven-trigger 70 --gfi-breakeven-offset 5 \
  --gfi-blocked-hours 6,7,8
```

**Tight-stop gold standard (2026-05-12):** 172 trades, **$157,329** PnL, 61.6% WR, **PF 2.99**, **Sharpe 6.41**, **Max DD 11.3%**. Max single loss capped at **-$1,240**, max giveback **-$2,520**, 10 painful losers (vs 15 baseline). Trades JSON: `data/gold-standard/gex-flip-ivpct-tight-s60t200be70.json`. These flag defaults are also baked into the live signal-generator via `config.js` (env vars `GFI_STOP_POINTS`, `GFI_TARGET_POINTS`, `GFI_BREAKEVEN_STOP`, `GFI_BREAKEVEN_TRIGGER`, `GFI_BREAKEVEN_OFFSET`, `GFI_BLOCKED_HOURS_ET` — all optional, sensible defaults applied). Full research writeup in `research/gfi-mae-analysis/SUMMARY.md`.

Pareto alternatives (each caps loss at $1,240, just trades PnL for fewer painful events):
- **Zero-giveback**: `--gfi-stop-pts 60 --gfi-target-pts 150 --gfi-breakeven-trigger 50 --gfi-breakeven-offset 5 --gfi-blocked-hours 6,7,8` → 168 trades, $92k, PF 2.38, **0 painful**.
- **Balanced**: `--gfi-stop-pts 60 --gfi-target-pts 180 --gfi-breakeven-trigger 60 --gfi-breakeven-offset 5 --gfi-blocked-hours 6,7,8` → 161 trades, $115k, PF 2.64, 4 painful.

Reference: pre-refit wide-stop baseline (per-rule stops 106-184pt) was 143 trades, $275k PnL, PF 4.29, Sharpe 10.60, Max DD 4.16% — higher headline numbers but max single-trade loss $3,720 and 15 painful givebacks. Trades JSON: `data/gold-standard/gex-flip-ivpct-postfix-baseline.json` (preserved for historical reference; do NOT use for live deployment on a small account).

**IMPORTANT** for parity: `--iv-resolution 1m`, `--timeframe 5m`, and `--eod-cutoff-et 16:40` are all REQUIRED. With 15m IV, skew can be up to 14 min stale at non-15m-boundary bars and trip the +0.015 threshold, causing L1↔L4 / S1↔S2 rule swaps. With `--timeframe 1m` the engine puts evaluations on a different bar grid and only ~1/142 trades line up exactly (aggregate stats stay close, but bar-level audit fails).

**Short-DTE-IV** (15m timeframe, production params from default.json):
```bash
cd backtest-engine
node index.js --ticker NQ --strategy short-dte-iv --timeframe 15m \
  --start 2025-01-13 --end 2026-01-23
```
Production defaults baked into `src/config/default.json`. Does NOT require `--raw-contracts`.

**GEX-LT-3M-Crossover** (1m timeframe, 1m LT × GEX 3-min sign-flip detector):
```bash
cd backtest-engine
node index.js --ticker NQ --strategy gex-lt-3m-crossover --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --gex-dir data/gex/nq-cbbo \
  --lt-1m-file research/lt-extraction/output/nq_lt_1m_raw.csv \
  --glx-force-any \
  --eod-cutoff-et 16:40 \
  --glx-entry-window 07:00-16:00 \
  --glx-blocked-hours 13 \
  --glx-disable-rules "S_R5,S_R3,S_S2_SOLO,L_S5_SOLO,S_PW_SOLO,L_PW,L_S3" \
  --glx-rule-overrides '{"L_S4":{"targetPts":120,"maxHoldBars":90},"S_GF_SOLO":{"maxHoldBars":90},"S_CW":{"targetPts":120,"maxHoldBars":90}}'
```
**W12 baseline (2026-05-08):** 909 trades, **$164,847** PnL, ~46% WR, **PF 1.39**, **Sharpe 5.62**, **MaxDD 8.30%** over 16 months. Result of wide-net rebuild: started with all 11 rules / no constraints, then added one filter at a time and kept only those that improved Sharpe/DD/PnL. Active rules (4): L_S4 (LONG @ S4 support, TP=120/SL=50/mh=90), S_GF_SOLO (SHORT @ gamma_flip, TP=60/SL=50/mh=90), S_CW (SHORT @ call_wall, TP=120/SL=50/mh=90), S_R4 (SHORT @ R4 resistance, TP=80/SL=50/mh=60). 7 rules dropped for PF<1.0. Trades JSON: `data/gold-standard/gex-lt-3m-crossover.json`. Strategy uses `place_limit` at signal close with 5-min timeout (zero entry slippage). Full implementation write-up: `research/GEX-LT-3M-IMPLEMENTATION-RESULTS.md`.

Earlier "v14" config (139 trades, $40k, only 2 rules) was an overfit driven by stacking unjustified constraints copied from gex-flip-ivpct (30-min cooldown, 9:30 entry start, default TP/SL from research's biased grid). Wide-net rebuild revealed L_S4 has real edge ($80k by itself with TP=120/mh=90) that the constraints had been hiding, and that 8am pre-market and the 7am hour add meaningful profit beyond the default 9:30 RTH start. **Methodology lesson: cast a wide net first, then filter one constraint at a time and keep only those proven to help.**

Run `node index.js --help` for all available strategies and options.

### Key Architecture
- `/backtest-engine/src/backtest-engine.js` - Core engine
- `/backtest-engine/src/execution/trade-simulator.js` - Order fill simulation
- `/backtest-engine/src/data/csv-loader.js` - Historical data loading
- `/backtest-engine/data/` - Historical candle, GEX, LT, IV, and options data (CSV/JSON)

## CRITICAL: Price Space & Contract Rollover Rules

**THIS SECTION IS MANDATORY READING FOR ANY ANALYSIS, BACKTESTING, OR STRATEGY WORK INVOLVING HISTORICAL DATA.**

Failure to follow these rules has caused incorrect results repeatedly. Do NOT skip this section.

### The Two Price Spaces

There are TWO versions of OHLCV data. They are NOT interchangeable:

| File | Price Space | Example (Dec 2020 NQH1) |
|------|-------------|--------------------------|
| `NQ_ohlcv_1m.csv` | **Raw contract** — actual traded prices | 12,676 |
| `NQ_ohlcv_1m_continuous.csv` | **Back-adjusted** — prices shifted to form a continuous series | 15,643 (shifted +2,967) |

### LT Levels Are ALWAYS Raw Contract Prices

Liquidity Trigger (LT) levels in `backtest-engine/data/liquidity/` are in **raw contract price space**. They reflect actual market prices at the time they were generated.

**LT levels MUST be compared against raw contract OHLCV data (`NQ_ohlcv_1m.csv` with `filterPrimaryContract()`), NEVER against continuous/back-adjusted data.** Comparing LT levels against continuous data produces phantom 200+ point gaps that do not exist in reality.

GEX levels have the same constraint — they are in raw price space.

### When To Use Raw vs Continuous

- **Raw contracts (`--raw-contracts`)**: REQUIRED for any analysis involving LT levels, GEX levels, or GEX proximity calculations. Use `NQ_ohlcv_1m.csv` + `filterPrimaryContract()`.
- **Continuous**: Only appropriate for pure price-action analysis where no external level data (LT, GEX) is involved and you need a gap-free price series.
- **When in doubt, use raw contracts.** It is always correct. Continuous is a convenience that breaks level comparisons.

### Contract Rollover in Raw Data (CRITICAL)

Raw OHLCV data contains **multiple contract months simultaneously** (e.g., NQH5 and NQM5 trading at the same time). `filterPrimaryContract()` selects the highest-volume contract per hour, which means at rollover the primary contract **switches** and prices **jump by the roll spread**.

**This is NOT a gap in the market — it is a contract change.** The rollover spread for NQ is typically 200-300 points (see `backtest-engine/data/ohlcv/nq/NQ_rollover_log.csv` for exact values per roll date).

#### What happens at rollover:
1. `filterPrimaryContract()` switches from e.g. NQH5 (~19,683) to NQM5 (~19,899)
2. Price appears to "jump" ~208 points — this is the contract spread, not a market move
3. Any LT/GEX levels from before the roll are still valid — LT data transitions naturally because the LT provider tracks the front contract
4. **Stale LT levels from the old contract era will be ~200pts off from new contract prices** — they must be flushed or shifted by the roll spread at the boundary

#### The rollover log:
`backtest-engine/data/ohlcv/nq/NQ_rollover_log.csv` contains every roll date with the exact spread:
```
date,from_symbol,to_symbol,spread
2025-03-18,NQH5,NQM5,208.5
2024-12-17,NQZ4,NQH5,297.5
```

#### Handling open trades at rollover:
The trade simulator (`trade-simulator.js`) attempts to convert prices between contracts using calendar spread bars. This works when spread data exists but **fails silently when it doesn't**, causing trades to get "stuck" — the old contract stops emitting candles and the trade never closes. When writing analysis or strategy code that spans rollovers:

1. **Track the current contract symbol** from the `symbol` column in raw OHLCV data
2. **Detect when it changes** — that's the rollover
3. **Force-close any open position** at the last price of the old contract (or use the rollover log spread to translate)
4. **Flush/shift all cached levels** (LT, GEX, support/resistance) by the roll spread
5. **Never assume prices are continuous** — a 200pt jump between bars is normal at rollover

### The `symbol` Column Is Your Source of Truth

Every row in the raw OHLCV data has a `symbol` column (e.g., `NQH5`, `NQM5`, `NQH5-NQM5`). This tells you:
- Which contract the price belongs to
- Whether it's a calendar spread (contains `-`) — **filter these out, they are NOT price quotes**
- When the rollover happened (symbol changes from one contract month to the next)

**Always check and use the `symbol` column.** Never assume all rows are the same contract.

## Backtest Data: Additional Filtering Rules

Historical data is stored in `/backtest-engine/data/`. Column schemas and date ranges can be discovered by reading CSV headers and listing directories.

### Calendar Spread Filtering (IMPORTANT)
The NQ and ES OHLCV files contain calendar spread entries that must be filtered out. These are NOT actual price quotes — they represent price differences between contracts. Filter by checking if the `symbol` column contains a dash (e.g., `NQH1-NQM1`).

### Primary Contract Filtering (IMPORTANT)
The NQ and ES OHLCV files contain multiple contract months at the same timestamps (e.g., NQH5 at 21200 and NQM5 at 21425 simultaneously). Loading all candles without filtering causes artificial price swings, FALSE signals, and INVALID results.

**You MUST use `filterPrimaryContract()` when loading OHLCV data for any analysis or backtesting.** This function groups candles by hour, finds the highest-volume contract per hour, and only includes candles from that primary contract. Implemented in `csv-loader.js`. Failure to filter produces dramatically wrong results (e.g., 84% win rate when actual is 30%).

### GEX Data Generation
Intraday GEX data (15-min snapshots) generated via `backtest-engine/scripts/generate-intraday-gex.py`. Supports both NQ (from QQQ options) and ES (from SPY options). Uses Brenner-Subrahmanyam IV approximation from OPRA statistics.

## Shared Utilities

The `/shared/` directory contains reusable components:
- `/shared/indicators/` - Technical analysis indicators (squeeze momentum, fibonacci, confluence, etc.)
- `/shared/strategies/` - Strategy implementations shared between live trading and backtesting (extend `base-strategy.js`)
- `/shared/utils/` - Common utilities (logger, technical analysis helpers)

## Symbol Conventions

### TradingView Symbols
- `NQ1!` / `ES1!` - Continuous front-month contracts
- Format: `{ROOT}{MONTH_CODE}!` or `{ROOT}1!` for continuous

### Broker Symbols (Tradovate)
- Format: `{ROOT}{MONTH}{YEAR}` (e.g., `MNQM6` = Micro Nasdaq June 2026)
- Month codes: F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec

### GEX/Options Symbols
- `QQQ` → Nasdaq GEX, `SPY` → S&P GEX (translated from ETF to futures prices using live ratios)

## Debugging

### Redis
```bash
redis-cli ping                          # Check Redis
redis-cli monitor                       # Monitor all traffic
redis-cli pubsub channels               # List active channels
redis-cli subscribe "price.update"      # Subscribe to channel
redis-cli pubsub numsub "trade.signal"  # Check subscriber count
```

### Troubleshooting
- **Redis connection failures**: `redis-cli ping`, check `shared/.env`, `sudo systemctl restart redis`
- **TradingView data stops**: Check `pm2 logs data-service`, verify `TRADINGVIEW_CREDENTIALS` in `.env`, `pm2 restart data-service`
- **No trade signals**: Check GEX levels (`curl localhost:3019/gex/levels?product=NQ`), price streaming (`redis-cli subscribe "price.update"`), `STRATEGY_ENABLED=true`, session filter settings, data service health
- **Service startup issues**: Use `./start-all.sh` which handles startup order
- **Backtest data issues**: Verify CSV data exists in `backtest-engine/data/`, check date range, ensure ticker matches file naming

### Production Logs (Sevalla MCP)

The Sevalla MCP server provides direct access to production runtime logs from all services. Use it as the first step when diagnosing production issues.

**MCP tools:** `mcp__sevalla__search` (discover API endpoints) and `mcp__sevalla__execute` (make API calls via `sevalla.request()`).

**IMPORTANT:** The MCP base URL already includes `/v3`. All paths must omit it:
```js
// CORRECT
sevalla.request({ method: "GET", path: `/applications/${appId}/runtime-logs` })
// WRONG — doubles the prefix, returns 404
sevalla.request({ method: "GET", path: `/v3/applications/${appId}/runtime-logs` })
```

**Pull runtime logs:**
```js
async () => {
  const res = await sevalla.request({
    method: "GET",
    path: `/applications/${appId}/runtime-logs`,
    query: { limit: 50 }
  });
  return res.body.map(l => ({
    time: l.timestamp,
    severity: l.severity,
    msg: l.message.replace(/\u001b\[\d+m/g, '').substring(0, 200)
  }));
}
```

**Query parameters:**
- `limit`: 1–5000 (default 1000)
- `from` / `to`: ISO 8601 time range (default: last hour)
- `filters`: JSON array, e.g. `[{"key":"severity","operator":"EQUALS","value":"ERROR"}]`

**Service app IDs** are in `deploy.config.json`. Key mappings:
| Service | App ID |
|---------|--------|
| tradovate-service | `70a68761-395c-4773-9bc0-7bdb9dcddc53` |
| trade-orchestrator | `588e37da-cebf-4be1-892b-58e67569c813` |
| monitoring-service | `62c3e8a4-bb68-440e-b3d5-6c0e889393e8` |
| data-service | `af7aeee4-8712-4a62-994f-c9d09d70d15e` |
| signal-generator | `1fe0898f-1f2c-4677-bea8-71012cbd2188` |
| ai-trader | `081d3d7f-f464-4501-964e-34b30ff43a32` |
| macro-briefing | `a287bf53-0e8f-44e5-a3ae-4bcf03a4637b` |

**Auth:** Requires OAuth via `/mcp` command after each Claude Code restart.

### Selective Deployment

`deploy.sh` diffs changes since the last deploy, maps affected directories to Sevalla services, and only redeploys what changed. Config in `deploy.config.json`, last-deploy marker in `.last-deploy`.

```bash
./deploy.sh              # Auto-detect and deploy affected services
./deploy.sh --dry-run    # Preview without deploying
./deploy.sh --all        # Deploy everything
./deploy.sh --status     # Show pending changes since last deploy
```

Requires `SEVALLA_API_KEY` env var. Changes to `shared/` trigger all services.
