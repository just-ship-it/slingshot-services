# Order Flow Enhancement Plan for ICT-SMT Strategy

**Created**: 2026-01-24
**Status**: In Progress - Phase 1 Complete (ineffective), Phase 3 Complete (EFFECTIVE!)
**Baseline Results**: `/home/drew/projects/slingshot-services/backtest-engine/results/ict_smt_2025.json`

---

## Phase 1 Results (Preliminary - January 2025)

### Implementation Status: COMPLETE

**Files Created:**
- `/shared/indicators/volume-delta-proxy.js` - Volume delta proxy using OHLCV data
- `/shared/indicators/volume-filters.js` - Volume trend and spike filters
- `/shared/indicators/volume-profile.js` - Volume profile with POC/Value Area
- CLI flags added to `backtest-engine/src/cli.js`
- Integration in `shared/strategies/ict-smc-strategy.js`

### Test Results (January 2025 Sample)

| Test | Trades | Win Rate | P&L | Change vs Baseline |
|------|--------|----------|-----|-------------------|
| **Baseline** | 63 | 41.27% | +$8,482 | - |
| Volume Delta Filter | 23 | 39.13% | +$3,080 | -63% trades, -64% P&L |
| Volume Trend Filter | 28 | 28.57% | -$250 | Worse |
| Volume Spike (1.3x) | 13 | 15.38% | -$2,410 | Much worse |

### Key Finding

**The OHLCV-based volume proxy filters are NOT effective for improving the strategy.**

The proxy delta (calculated from candle direction * volume) lacks the granularity of true order flow data. Without knowing which trades hit the bid vs ask, we're essentially guessing at buying/selling pressure.

### Recommendation

**Skip to Phase 3 (True CVD with Databento data)** - The proxy-based filters need actual tick data with trade side classification to be effective. Your Databento subscription provides this data.

**Priority data to download:**
```bash
# ESSENTIAL: Trade data with side classification
databento download --dataset GLBX.MDP3 --schema trades \
  --symbols "NQ.FUT" --start 2025-01-01 --end 2025-12-31 \
  -o backtest-engine/data/orderflow/trades/nq_trades_2025.csv
```

---

## Phase 3 Implementation Status: COMPLETE

### Files Created:
- `/backtest-engine/src/data/databento-loader.js` - Databento trade data loader with CVD computation
- `/shared/indicators/cvd.js` - True CVD calculator and filter classes

### Integration Points:
- CLI flags added: `--cvd-direction-filter`, `--cvd-divergence-filter`, `--cvd-zero-cross-filter`
- Strategy integration: `checkCVDFilters()` method in ICT-SMC strategy
- Backtest engine: Auto-loads Databento trade data when CVD filters enabled

### Data Format:
Files expected in: `backtest-engine/data/orderflow/trades/glbx-mdp3-YYYYMMDD.trades.csv`

Key fields:
- `side`: 'A' = Ask aggressor (buyer), 'B' = Bid aggressor (seller)
- `size`: Trade size (contracts)
- `ts_event`: Nanosecond timestamp

### Test Commands:
```bash
# Baseline (no CVD filter)
node index.js --ticker NQ --start 2025-01-01 --end 2025-01-31 --strategy ict-smc --structure-timeframe 15m --entry-timeframe 1m

# With CVD Direction Filter
node index.js --ticker NQ --start 2025-01-01 --end 2025-01-31 --strategy ict-smc --structure-timeframe 15m --entry-timeframe 1m --cvd-direction-filter

# With CVD Divergence Filter
node index.js --ticker NQ --start 2025-01-01 --end 2025-01-31 --strategy ict-smc --structure-timeframe 15m --entry-timeframe 1m --cvd-divergence-filter

# Combined CVD Filters
node index.js --ticker NQ --start 2025-01-01 --end 2025-01-31 --strategy ict-smc --structure-timeframe 15m --entry-timeframe 1m --cvd-direction-filter --cvd-divergence-filter
```

### Phase 3 Test Results (January 2025)

| Metric | Baseline | CVD Direction | CVD Divergence | CVD Combined |
|--------|----------|---------------|----------------|--------------|
| **Trades** | 63 | 25 (-60%) | 48 (-24%) | 18 (-71%) |
| **Win Rate** | 41.3% | 40.0% | **50.0%** | **55.6%** |
| **Net P&L** | $8,482 | $4,082 | **$11,832** | $6,582 |
| **Profit Factor** | 2.27 | 2.74 | 2.22 | **3.32** |
| **Avg Trade** | $135 | $163 | $247 | **$366** |
| **Avg Loss** | $367 | $304 | $389 | **$251** |

### Key Findings

**TRUE CVD FILTERS ARE EFFECTIVE!** (Unlike proxy filters from Phase 1)

1. **CVD Divergence Filter** is the best single filter:
   - Improved win rate from 41.3% to 50% (+8.7 pts)
   - Increased net P&L from $8,482 to $11,832 (+39%)
   - Higher average trade ($247 vs $135)

2. **CVD Combined (Direction + Divergence)** achieves highest quality:
   - Win rate: 55.6% (vs 41.3% baseline) - **+14.3 percentage points**
   - Profit factor: 3.32 (vs 2.27 baseline) - **+46% improvement**
   - Avg trade: $366 (vs $135 baseline) - **+171% improvement**
   - Avg loss reduced: $251 (vs $367 baseline) - **-32% smaller losses**

3. **Trade-off**: The combined filter reduces trade count by 71%, so use it when you want quality over quantity.

### Full Year 2025 Results (~97 million trades processed)

| Metric | Baseline | CVD Direction | CVD Divergence | CVD Combined |
|--------|----------|---------------|----------------|--------------|
| **Trades** | 975 | 438 (-55%) | 788 (-19%) | 386 (-60%) |
| **Win Rate** | 28.7% | 27.2% | 28.3% | 26.4% |
| **Net P&L** | **-$42,124** | **-$26,114** | -$38,044 | **-$25,555** |
| **Profit Factor** | 2.05 | 2.08 | 2.05 | 2.11 |
| **Avg Win** | $795 | $826 | $793 | $839 |
| **Avg Loss** | $387 | $396 | $387 | $398 |

### Key Findings (Full Year)

1. **Baseline strategy has a net LOSS of $42,124** - the strategy needs improvement beyond order flow filtering

2. **CVD filters reduce losses significantly:**
   - CVD Direction Filter: **Reduced loss by 38%** ($16,010 less lost)
   - CVD Combined Filter: **Reduced loss by 39%** ($16,569 less lost)

3. **Trade quality improved:**
   - Average winning trade: $795 → $839 (+6%)
   - Profit factor: 2.05 → 2.11 (+3%)

4. **January vs Full Year difference:** The January sample showed strong positive results (55% win rate, 3.32 PF) which didn't persist across the full year. This highlights the importance of full-year testing.

### Recommendation

For the ICT-SMC strategy:

1. **Use CVD Direction Filter** (`--cvd-direction-filter`) as the default:
   - Best loss reduction (38%)
   - 55% fewer trades means lower commission costs
   - Maintains win rate and profit factor

2. **The strategy itself needs optimization** - even with perfect filtering, you can't turn a losing strategy into a winner. Consider:
   - Adjusting entry timing
   - Reviewing stop loss placement
   - Testing different structure/entry timeframe combinations

```bash
# Recommended: CVD Direction Filter
--cvd-direction-filter

# Alternative: Combined filters (most selective)
--cvd-direction-filter --cvd-divergence-filter
```

## Current Strategy Performance Analysis

| Metric | Value |
|--------|-------|
| Total Trades | 949 |
| Win Rate | 24% (227 wins / 949 trades) |
| Take Profit | 227 trades, +$206,722 |
| Stop Loss | 584 trades, -$253,444 |
| Market Close | 138 trades, +$1,298 |
| **Net P&L** | **-$45,424** |

The primary issue is **entry quality** - too many trades get stopped out before reaching the target. Order flow can act as a confirmation filter to avoid entering when institutional activity contradicts your direction.

---

## Order Flow Data Sources (Tiered by Cost)

### Tier 1: Free / Minimal Cost

| Source | Data Type | Coverage | Notes |
|--------|-----------|----------|-------|
| **TradingView (Basic)** | Candle volume, buy/sell volume indicator | All markets | Already integrated; limited depth |
| **You already have: OHLCV volume** | Volume per candle | NQ 1m 2020-2025 | Can derive volume delta proxy |
| **CME Settlement Data** | Daily volume/OI | Public | Free from CME website |
| **Your IV data** | ATM IV 15-min | QQQ 2025 | Could indicate directional sentiment |

**What you can do NOW for free:**
1. **Volume Delta Proxy**: Calculate buy/sell volume ratio from price action (up-closes vs down-closes weighted by volume)
2. **Volume Profile**: Identify high-volume nodes as support/resistance
3. **Volume Spikes**: Detect unusual volume at key levels

### Tier 2: Low Cost ($20-50/month)

| Source | Data Type | Cost | Coverage |
|--------|-----------|------|----------|
| **dxFeed** | Real-time trades/quotes, volume analysis | $19/mo | CME futures via platforms |
| **Exocharts** | Footprint, CVD, delta | $38-49/mo | CME, crypto, ETFs |
| **NinjaTrader Free** | CVD indicator, volume analysis | Free platform | 6 months tick history |
| **Bookmap (Tradovate bundle)** | Full DOM, heatmap | Varies | Free on Coinbase micro-futures |

### Tier 3: Professional ($100-200/month) - YOUR TIER (Databento)

| Source | Data Type | Cost | Coverage |
|--------|-----------|------|----------|
| **Databento** | Full order book (MBO), tick data, nanosecond | $179/mo (Standard) | CME Globex MDP 3.0 |
| **Tick Data** | Historical tick + L1 quotes | Per-symbol pricing | 20+ years history |
| **Algoseek** | L2 order book, ML-ready | Enterprise | Quant-focused |
| **CME DataMine** | Official CME historical | Per-dataset | Source of truth |

### Tier 4: Enterprise ($500+/month)

| Source | Data Type | Notes |
|--------|-----------|-------|
| **Rithmic + Bookmap** | Full MBO feed | Requires broker agreement |
| **Portara/CQG** | Tick since 1987 | For CTAs/hedge funds |

---

## Databento Data Download Specifications

Since you have a Databento subscription, here's exactly what to download:

### Priority 1: Trade Data for CVD (ESSENTIAL)

```bash
# Dataset: GLBX.MDP3 (CME Globex)
# Schema: trades
# Symbols: NQ (E-mini Nasdaq) or ES (E-mini S&P)
# Date Range: 2025-01-01 to 2025-12-31 (match your backtest period)

databento-cli download \
  --dataset GLBX.MDP3 \
  --schema trades \
  --symbols "NQ.FUT" \
  --start 2025-01-01 \
  --end 2025-12-31 \
  --output nq_trades_2025.csv
```

**Fields you'll get:**
- `ts_event`: Timestamp (nanosecond precision)
- `price`: Trade price
- `size`: Trade size (contracts)
- `side`: Trade side (bid/ask aggressor)
- `action`: Trade action type

**Estimated size**: ~2-5 GB for full year of NQ trades

### Priority 2: MBP-1 (Top of Book) for Imbalance

```bash
# Schema: mbp-1 (Market-by-Price, 1 level = best bid/ask)
databento-cli download \
  --dataset GLBX.MDP3 \
  --schema mbp-1 \
  --symbols "NQ.FUT" \
  --start 2025-01-01 \
  --end 2025-12-31 \
  --output nq_mbp1_2025.csv
```

**Fields you'll get:**
- `bid_px_00`, `ask_px_00`: Best bid/ask prices
- `bid_sz_00`, `ask_sz_00`: Best bid/ask sizes
- `ts_event`: Timestamp

**Use for**: Order book imbalance calculation

### Priority 3: MBP-10 (Market Depth) for Absorption Detection

```bash
# Schema: mbp-10 (10 levels of depth)
databento-cli download \
  --dataset GLBX.MDP3 \
  --schema mbp-10 \
  --symbols "NQ.FUT" \
  --start 2025-01-01 \
  --end 2025-12-31 \
  --output nq_mbp10_2025.csv
```

**Warning**: This is LARGE data. Consider downloading 1-3 months first for testing.

### Priority 4: OHLCV-1s (1-second bars) for Fine-Grained Analysis

```bash
# Schema: ohlcv-1s
databento-cli download \
  --dataset GLBX.MDP3 \
  --schema ohlcv-1s \
  --symbols "NQ.FUT" \
  --start 2025-01-01 \
  --end 2025-12-31 \
  --output nq_ohlcv_1s_2025.csv
```

**Use for**: High-resolution volume analysis, volume profile

### Recommended Download Order

1. **Start with trades** (Priority 1) - This is essential for CVD
2. **Then mbp-1** (Priority 2) - For book imbalance
3. **Then ohlcv-1s** (Priority 4) - For volume profile refinement
4. **Finally mbp-10** (Priority 3) - Only if absorption testing needed

### Data Storage Location

Save downloaded files to:
```
/home/drew/projects/slingshot-services/backtest-engine/data/orderflow/
├── trades/
│   └── nq_trades_2025.csv
├── mbp-1/
│   └── nq_mbp1_2025.csv
├── mbp-10/
│   └── nq_mbp10_2025.csv (optional)
└── ohlcv-1s/
    └── nq_ohlcv_1s_2025.csv
```

---

## Order Flow Indicators to Test

### 1. Cumulative Volume Delta (CVD) - HIGH PRIORITY

**What it measures**: Net buying vs selling pressure (aggressive orders hitting bid vs ask)

**How to use**: Confirm entries when CVD aligns with trade direction

**Filter logic**:
- Long entry: CVD trending up or positive divergence
- Short entry: CVD trending down or negative divergence

**Data required**: Trade data with side classification (Databento `trades` schema)

### 2. Delta Divergence

**What it measures**: Price making new highs/lows while delta weakens

**How to use**: Avoid entries when delta diverges from price (exhaustion signal)

**Filter logic**:
- Skip long if price makes higher high but CVD makes lower high
- Skip short if price makes lower low but CVD makes higher low

### 3. Order Book Imbalance

**What it measures**: Bid volume vs ask volume at best prices

**Formula**: `(Bid Volume - Ask Volume) / (Bid Volume + Ask Volume)`

**Filter logic**:
- Long entry: Imbalance > +0.3 (more buyers)
- Short entry: Imbalance < -0.3 (more sellers)

**Data required**: MBP-1 or MBP-10 from Databento

### 4. Absorption Detection

**What it measures**: Large limit orders absorbing aggressive orders

**How to use**: Confirms reversals at order blocks/support levels

**Filter logic**: At OB retest, look for absorption (high delta but no price movement)

### 5. Stacked Imbalances

**What it measures**: 3+ consecutive price levels with buy/sell dominance

**How to use**: Confirms institutional presence in direction

**Filter logic**: Only enter when stacked imbalances align with trade direction

### 6. Volume Profile (POC/Value Area)

**What it measures**: Price levels with highest traded volume

**How to use**: Confirm entries near high-volume nodes (POC)

**Filter logic**: Avoid entries in low-volume "gaps" (LVN)

---

## Implementation Phases

### Phase 1: No-Cost Volume Analysis (Use Existing Data)

**Objective**: Establish baseline improvement using only OHLCV data you already have.

**Tests to run:**

| Test | Description | Implementation |
|------|-------------|----------------|
| **1A. Volume Delta Proxy** | Calculate pseudo-delta from candle direction * volume | `delta = volume * sign(close - open)` |
| **1B. Volume Trend Filter** | Only enter when 5-bar volume SMA is increasing | Skip entries during declining volume |
| **1C. Volume Spike Confirmation** | Require entry candle volume > 1.5x average | High volume = conviction |
| **1D. Volume Profile Zones** | Identify POC levels from prior session | Filter entries near POC (support) |

**Command examples:**
```bash
# Baseline (current)
node index.js --ticker NQ --start 2025-01-01 --end 2025-12-31 --strategy ict-smc --structure-timeframe 15m --entry-timeframe 1m

# With volume delta filter
node index.js --ticker NQ --start 2025-01-01 --end 2025-12-31 --strategy ict-smc --structure-timeframe 15m --entry-timeframe 1m --volume-delta-filter true

# With volume spike confirmation
node index.js --ticker NQ --start 2025-01-01 --end 2025-12-31 --strategy ict-smc --structure-timeframe 15m --entry-timeframe 1m --volume-spike-threshold 1.5
```

### Phase 2: IV-Based Sentiment Filter (Use Existing IV Data)

**Objective**: Use options IV skew as a directional sentiment indicator.

**Tests to run:**

| Test | Description | Logic |
|------|-------------|-------|
| **2A. Call/Put IV Skew** | Compare call_iv vs put_iv from your data | Call IV > Put IV = bullish sentiment |
| **2B. IV Expansion Filter** | Avoid entries during IV spikes | High IV = uncertainty, skip entries |
| **2C. IV Trend Alignment** | Enter only when IV trend matches direction | Falling IV + long = good |

### Phase 3: CVD Integration (Databento Trade Data)

**Objective**: Integrate true Cumulative Volume Delta for entry confirmation.

**Data required**: Databento `trades` schema with side classification

**Tests to run:**

| Test | Description | Logic |
|------|-------------|-------|
| **3A. CVD Direction Filter** | CVD must trend in entry direction | 5-bar CVD slope > 0 for longs |
| **3B. CVD Divergence Block** | Block entries on price/CVD divergence | New price high + CVD lower high = no entry |
| **3C. CVD Zero-Line Cross** | Enter after CVD crosses zero line | Momentum confirmation |
| **3D. Session CVD Reset** | Track CVD from session open | Relative momentum |

### Phase 4: DOM/Absorption Signals (Databento MBP Data)

**Objective**: Test order book dynamics for entry confirmation.

**Data required**: Databento `mbp-1` or `mbp-10` schema

**Tests to run:**

| Test | Description | Logic |
|------|-------------|-------|
| **4A. Book Imbalance Filter** | Only enter when book supports direction | Imbalance ratio > 0.3 |
| **4B. Absorption Confirmation** | Detect large orders absorbing aggression | High delta, no price movement |
| **4C. Spoofing Filter** | Ignore orders that cancel quickly | Persistence threshold |

### Phase 5: Combined Order Flow Score

**Objective**: Create composite order flow score combining multiple indicators.

**Score components:**

| Component | Weight | Range | Logic |
|-----------|--------|-------|-------|
| CVD Direction | 30% | 0-100 | Trend alignment |
| Volume Delta | 25% | 0-100 | Candle-level momentum |
| IV Sentiment | 20% | 0-100 | Options market view |
| Volume Profile | 15% | 0-100 | Near POC = higher |
| Book Imbalance | 10% | 0-100 | If available |

**Filter rule**: Only enter when `orderFlowScore >= 60`

---

## Task Tracking

See task list managed by Claude Code TaskCreate/TaskUpdate tools.

Tasks are broken into:
- Phase 1 tasks (1.x)
- Phase 2 tasks (2.x)
- Phase 3 tasks (3.x)
- Phase 4 tasks (4.x)
- Phase 5 tasks (5.x)

---

## Expected Outcome

Based on order flow research, a well-tuned filter could:
- **Reduce trade count** by 30-50% (filtering low-quality setups)
- **Improve win rate** from 24% to 35-45%
- **Reduce stop-outs** by filtering counter-trend entries
- **Net result**: Positive expectancy instead of -$45k

---

## Sources

- [Bookmap - Cumulative Volume Delta](https://bookmap.com/blog/how-cumulative-volume-delta-transform-your-trading-strategy)
- [JumpStart Trading - Volume Delta Guide](https://www.jumpstarttrading.com/volume-delta/)
- [ATAS - Delta and Cumulative Delta](https://atas.net/atas-possibilities/indicators/what-is-delta/)
- [QuestDB - Order Book Imbalance](https://questdb.com/glossary/order-book-imbalance/)
- [Trader Dale - Absorption Setup](https://www.trader-dale.com/order-flow-how-to-trade-the-absorption-setup-trade-entry-confirmation/)
- [TradeZella - Order Flow Concepts](https://www.tradezella.com/learning-items/order-flow-terms-and-concepts)
- [Databento - CME Futures Data](https://databento.com/datasets/GLBX.MDP3)
- [Optimus Futures - Order Flow Analysis](https://www.cannontrading.com/services/order-flow-analysis-in-futures-trading)
- [Tick Data - Historical Futures](https://www.tickdata.com/product/historical-futures-data/)
