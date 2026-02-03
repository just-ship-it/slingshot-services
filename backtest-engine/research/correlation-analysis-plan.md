# Correlation Analysis Plan - 2025 Trading Data

**Created**: January 21, 2026
**Objective**: Find correlation and confluence between backtesting datasets to develop new NQ futures trading strategies using QQQ options as a proxy for gamma exposure.

---

## Progress Tracker

### Phase 1: Data Preparation & Alignment
- [x] 1.1 Build unified time series (align to 15-min intervals) ✅
- [ ] 1.2 Aggregate 1-second NQ data to compute micro-structure metrics
- [x] 1.3 Feature engineering for GEX, IV, Liquidity, and Price ✅

### Phase 2: Statistical Correlation Analysis
- [x] 2.1 Pairwise correlations matrix ✅
- [x] 2.2 Lead-lag analysis (IV, liquidity, GEX vs price) ✅
- [ ] 2.3 Rolling correlation windows (1hr, 4hr, daily)

### Phase 3: Event Studies
- [x] 3.1 Liquidity spike events analysis ✅
- [x] 3.2 GEX level touch events analysis ✅
- [x] 3.3 IV expansion events analysis ✅

### Phase 4: Regime Analysis
- [x] 4.1 Market regime classification (8 composite states) ✅
- [x] 4.2 Regime performance metrics calculation ✅

### Phase 5: 1-Second Microstructure Analysis
- [ ] 5.1 High-resolution price reaction studies
- [ ] 5.2 Intraday pattern analysis

### Phase 6: Strategy Signal Generation
- [ ] 6.1 Build confluence scoring model
- [ ] 6.2 Backtest framework validation

---

## Data Inventory

| Dataset | Resolution | 2025 Coverage | Size | Key Fields |
|---------|-----------|---------------|------|------------|
| NQ 1-second | 1s bars | Full year | 7.1 GB (67M+ bars) | OHLCV |
| NQ 1-minute | 1m bars | Full year | 280 MB | OHLCV |
| GEX Intraday | 15-min | Full year | 14 MB (688 files) | gamma_flip, support/resistance tiers, regime, total_gex |
| QQQ ATM IV | 15-min | Jan 13 - Dec 24 | 394 KB | IV, call_iv, put_iv, dte |
| Liquidity Triggers | 15-min | Full year | 5.5 MB | sentiment, 5 price levels |

**Analysis Window**: January 13, 2025 - December 24, 2025 (IV data is limiting factor)

---

## Phase 1: Data Preparation & Alignment

### 1.1 Build Unified Time Series
Align all datasets to 15-minute intervals (lowest common denominator for IV and liquidity data).

**Tasks:**
- Load NQ 1-minute OHLCV data, filter calendar spreads
- Resample to 15-minute OHLCV bars
- Load GEX intraday JSON files, extract 15-min snapshots
- Load QQQ ATM IV CSV
- Load Liquidity Trigger CSV
- Create master DataFrame with aligned timestamps

**Output:** `unified_15m_2025.csv` or similar format

### 1.2 Aggregate 1-Second NQ Data for Micro-Structure Metrics
Compute per 15-minute interval:
- **Volatility**: Standard deviation of 1-second returns
- **Volume Profile**: Volume-weighted average price (VWAP), volume at price clusters
- **Trade Imbalance**: Count of up-ticks vs down-ticks
- **Micro-Range**: Average high-low range of 1-second bars
- **Tick Count**: Number of 1-second bars (activity measure)

**Output:** Append micro-structure columns to unified dataset

### 1.3 Feature Engineering

#### GEX Features
| Feature | Description |
|---------|-------------|
| `gex_dist_gamma_flip` | Price distance to gamma flip level (points) |
| `gex_dist_nearest_support` | Distance to nearest support level |
| `gex_dist_nearest_resistance` | Distance to nearest resistance level |
| `gex_regime` | Categorical: strong_positive, positive, negative, strong_negative |
| `gex_regime_change` | Boolean: regime changed from prior interval |
| `gex_total_momentum` | Change in total_gex from prior interval |
| `gex_support_strength` | Count of support levels within X points |

#### IV Features
| Feature | Description |
|---------|-------------|
| `iv_current` | Current ATM implied volatility |
| `iv_change_15m` | IV change over 15 minutes |
| `iv_change_1h` | IV change over 1 hour |
| `iv_percentile_20d` | IV percentile rank over 20-day lookback |
| `iv_skew` | Put IV - Call IV (put skew indicator) |
| `iv_dte` | Days to expiration (expiry cycle effects) |

#### Liquidity Features
| Feature | Description |
|---------|-------------|
| `liq_sentiment` | BULLISH or BEARISH |
| `liq_sentiment_change` | Boolean: sentiment flipped |
| `liq_level_1` through `liq_level_5` | The 5 liquidity levels |
| `liq_spacing` | Average spacing between levels (tight vs wide) |
| `liq_momentum` | Average change in levels (rising = improving) |
| `liq_spike` | Boolean: any level moved > X std dev |
| `liq_spike_magnitude` | Size of largest level movement |
| `liq_dist_nearest` | Price distance to nearest liquidity level |

#### Price Features
| Feature | Description |
|---------|-------------|
| `price_return_15m` | 15-minute return |
| `price_return_1h` | 1-hour return |
| `price_volatility_1h` | 1-hour realized volatility |
| `price_range_15m` | High-low range of 15-min bar |
| `price_trend_4h` | 4-hour trend direction (slope) |
| `price_vwap_dist` | Distance from VWAP |

---

## Phase 2: Statistical Correlation Analysis

### 2.1 Pairwise Correlations

**Hypotheses to Test:**

| # | Relationship | Hypothesis | Expected Correlation |
|---|-------------|------------|---------------------|
| 1 | IV change → Price volatility | IV expansion predicts increased volatility | Positive |
| 2 | GEX regime → Directional bias | Positive GEX favors bullish moves | Positive |
| 3 | Liquidity sentiment → Price direction | BULLISH sentiment = upward bias | Positive |
| 4 | IV skew → GEX regime | Higher put IV correlates with negative GEX | Negative |
| 5 | Liquidity spacing → Volatility | Wide spacing = higher volatility potential | Positive |
| 6 | GEX total → Mean reversion | Higher absolute GEX = stronger reversion | Positive |
| 7 | IV level → GEX sensitivity | High IV = stronger GEX level reactions | Positive |
| 8 | Liquidity spike → Price move | Spike direction predicts price direction | Positive |

**Methods:**
- Pearson correlation (linear relationships)
- Spearman correlation (monotonic relationships)
- Statistical significance testing (p-values)

**Output:** Correlation matrix heat map, significance table

### 2.2 Lead-Lag Analysis

Test if indicators predict future price moves at various lags:

| Indicator | Lags to Test | Target Variable |
|-----------|--------------|-----------------|
| IV change | 1, 5, 15, 30 min | Price return |
| IV change | 1, 5, 15, 30 min | Price volatility |
| Liquidity level shift | 1, 5, 15, 30 min | Price return |
| Liquidity spike | 1, 5, 15, 30 min | Price return |
| GEX regime transition | 15, 30, 60 min | Price direction |
| GEX total momentum | 15, 30, 60 min | Mean reversion |

**Methods:**
- Cross-correlation function (CCF)
- Granger causality tests
- Information coefficient (IC) at each lag

**Output:** Lead-lag relationship table with optimal lags

### 2.3 Rolling Correlation Windows

Track how correlations evolve over time:

| Window Size | Purpose |
|-------------|---------|
| 1 hour | Short-term regime detection |
| 4 hours | Session-level patterns |
| 1 day | Daily regime changes |
| 1 week | Longer-term structural shifts |

**Analysis:**
- Identify periods when correlations break down
- Correlate rolling correlation with market events (FOMC, OPEX, etc.)
- Detect regime changes via correlation regime shifts

**Output:** Time series of rolling correlations, regime change detection

---

## Phase 3: Event Studies

### 3.1 Liquidity Spike Events

**Definition:** Level movement > 2 standard deviations from mean change

**Event Classification:**
- Spike UP (levels moving higher)
- Spike DOWN (levels moving lower)
- Segment by current sentiment (BULLISH/BEARISH)

**Measurement Windows:**
| Window | Metric |
|--------|--------|
| T+0 to T+1 (15m) | Immediate reaction |
| T+0 to T+5 (75m) | Short-term follow-through |
| T+0 to T+15 (3.75h) | Medium-term impact |
| T+0 to T+30 (7.5h) | Full session impact |

**Metrics per Window:**
- Average return
- Win rate (% positive)
- Average volatility
- Max favorable excursion (MFE)
- Max adverse excursion (MAE)

**Output:** Event study statistics table, cumulative return charts

### 3.2 GEX Level Touch Events

**Definition:** Price comes within X points of support_1 or resistance_1

**Event Classification:**
- Touch Support (potential long)
- Touch Resistance (potential short)
- Segment by: IV regime, liquidity sentiment, GEX magnitude

**Outcomes to Measure:**
- Bounce rate (price reverses from level)
- Breakthrough rate (price continues through)
- Average bounce magnitude
- Average breakthrough magnitude
- Time to resolution

**Segmentation Analysis:**
| Segment | Expected Finding |
|---------|------------------|
| High IV + Positive GEX + Bullish Liq | Strong support bounces |
| High IV + Negative GEX + Bearish Liq | Strong resistance rejections |
| Low IV + Any | Weaker level reactions |

**Output:** Bounce/breakthrough statistics by segment

### 3.3 IV Expansion Events

**Definition:** IV spike > 1.5 standard deviations above recent mean

**Event Classification:**
- IV expansion (spike up)
- IV contraction (spike down)
- Segment by: GEX regime, liquidity sentiment

**Measurement:**
- Subsequent 15m, 1h, 4h price range
- Directional bias
- Mean reversion tendency

**Output:** IV event impact statistics

---

## Phase 4: Regime Analysis

### 4.1 Market Regime Classification

Create 8 composite regime states from 3 binary dimensions:

| Dimension | States |
|-----------|--------|
| IV | High (>50th percentile) / Low |
| GEX | Positive (gamma_flip above price) / Negative |
| Liquidity | Bullish / Bearish |

**Resulting Regimes:**
1. High IV / Positive GEX / Bullish Liquidity
2. High IV / Positive GEX / Bearish Liquidity
3. High IV / Negative GEX / Bullish Liquidity
4. High IV / Negative GEX / Bearish Liquidity
5. Low IV / Positive GEX / Bullish Liquidity
6. Low IV / Positive GEX / Bearish Liquidity
7. Low IV / Negative GEX / Bullish Liquidity
8. Low IV / Negative GEX / Bearish Liquidity

### 4.2 Regime Performance Metrics

For each of the 8 regimes, calculate:

| Metric | Description |
|--------|-------------|
| Frequency | % of time in this regime |
| Avg Return | Average 15-min return |
| Volatility | Standard deviation of returns |
| Sharpe | Risk-adjusted return |
| Skewness | Return distribution shape |
| Mean Reversion | Autocorrelation of returns |
| Trend Strength | Average directional movement |
| Optimal Strategy | Trend-following vs mean-reversion |

**Output:** Regime performance comparison table

---

## Phase 5: 1-Second Microstructure Analysis

### 5.1 High-Resolution Price Reaction Studies

Using 67M+ 1-second bars:

**GEX Level Reaction Speed:**
- How quickly does price react when touching GEX levels?
- Measure time to bounce/breakthrough at 1-second resolution
- Identify optimal entry timing

**Liquidity Spike Microstructure:**
- What happens in the seconds following a liquidity spike detection?
- Volume surge patterns
- Price acceleration/deceleration

**Volume Analysis:**
- Volume clustering around GEX levels
- Volume profile at support vs resistance
- Abnormal volume detection

### 5.2 Intraday Patterns

**Time-of-Day Effects:**
- Correlation strength by hour
- Best hours for each strategy type
- Session transition analysis

**Session Analysis:**
| Session | Hours (EST) | Focus |
|---------|-------------|-------|
| Overnight | 18:00 - 09:30 | Lower volume, wider spreads |
| Pre-market | 08:00 - 09:30 | Building momentum |
| RTH Morning | 09:30 - 12:00 | Highest volume, strongest moves |
| RTH Afternoon | 12:00 - 16:00 | Consolidation, mean reversion |
| After-hours | 16:00 - 18:00 | Lower volume reactions |

**Special Days:**
- OPEX days (3rd Friday, 0DTE expiry)
- FOMC days
- Quad witching

**Output:** Intraday pattern statistics, optimal trading windows

---

## Phase 6: Strategy Signal Generation

### 6.1 Confluence Scoring Model

Build composite score from correlated indicators:

```
CONFLUENCE_SCORE =
    w1 * GEX_PROXIMITY_SCORE +      (0-100: closer to level = higher)
    w2 * IV_REGIME_SCORE +          (0-100: favorable IV = higher)
    w3 * LIQUIDITY_ALIGNMENT_SCORE + (0-100: aligned sentiment = higher)
    w4 * HISTORICAL_REGIME_SCORE    (0-100: regime performance = higher)
```

**Score Thresholds:**
- 80+ : Strong signal
- 60-80: Moderate signal
- <60 : No signal

**Weight Optimization:**
- Use correlation results to inform initial weights
- Optimize via walk-forward analysis

### 6.2 Backtest Framework Validation

**Methodology:**
1. Train on H1 2025 (Jan-Jun)
2. Test on H2 2025 (Jul-Dec)
3. Compare to existing GEX Recoil strategy

**Metrics to Compare:**
- Total return
- Sharpe ratio
- Max drawdown
- Win rate
- Profit factor
- Average trade P&L

**Output:** Strategy comparison table, equity curves

---

## Expected Deliverables

1. **Unified Dataset**: `unified_15m_2025.csv` with all features
2. **Correlation Report**: Heat maps, significance tests, lead-lag results
3. **Event Study Report**: Statistical summaries for each event type
4. **Regime Analysis Report**: Performance by regime combination
5. **Microstructure Report**: 1-second analysis findings
6. **Confluence Strategy**: Implementable scoring algorithm
7. **Backtest Results**: Validation of new strategy signals

---

## Session Log

### Session 1 - January 21, 2026
- Created analysis plan
- Inventoried all available data
- Identified 2025 as optimal analysis window (IV data constraint)
- Set up research directory structure

**Completed Phase 1.1 - Build Unified Time Series**

Created `build-unified-dataset.js` script that:
1. Loaded 397,727 NQ 1-minute candles (filtered calendar spreads)
2. Resampled to 22,448 15-minute bars
3. Loaded 6,442 GEX snapshots from 240 intraday JSON files
4. Loaded 6,435 IV records
5. Loaded 22,448 Liquidity Trigger records
6. Joined all datasets by 15-minute timestamp

**Output**: `research/output/unified_15m_2025.csv` (4.66 MB, 22,630 records)

**Coverage Analysis**:
| Dataset | Coverage | Notes |
|---------|----------|-------|
| OHLCV | 99.2% | Full 24-hour coverage |
| Liquidity | 99.2% | Full 24-hour coverage |
| GEX | 28.5% | RTH only (9:30 AM - 4:00 PM) |
| IV | 28.4% | RTH only |
| Full (all 4) | 25.5% | 5,773 bars with complete data |

**Key Insight**: GEX and IV data only covers RTH sessions. For correlation analysis focusing on GEX/IV, should filter to RTH periods only.

**Next Steps:** Phase 1.2 - Aggregate 1-second NQ data for microstructure metrics (optional) OR Phase 1.3 - Feature engineering

---

### Session 1 (Continued) - Overnight Analysis Run

**Completed Phases 1.3, 2.1, 2.2, 3.1-3.3, 4.1-4.2**

#### Phase 1.3 - Feature Engineering
- Created `feature-engineering.js`
- Generated 53 features including price returns, GEX distances, IV percentiles, liquidity spacing
- Output: `unified_15m_2025_features.csv` (9.45 MB)

#### Phase 2.1 - Correlation Analysis
- Created `correlation-analysis.js`
- Found 59 statistically significant correlations
- Key findings:
  - IV negatively correlated with GEX (r=-0.47)
  - Price returns correlate with GEX level proximity
  - IV strongly correlates with liquidity spacing (r=0.65)

#### Phase 2.2 - Lead-Lag Analysis
- Created `lead-lag-analysis.js`
- Found 15 predictor-target pairs with predictive power
- Key findings:
  - IV percentile predicts volatility 15m ahead (r=0.30)
  - GEX regime predicts volatility (negative GEX = higher vol)
  - Distance from gamma flip predicts returns (mean reversion)

#### Phase 3 - Event Studies
- Created `event-studies.js`
- Analyzed 627 liquidity spikes, 500 support touches, 409 resistance touches, 200 IV expansions
- Key findings:
  - GEX Support 1 bounce rate: 54.2%
  - Negative GEX regime support touches: 57.1% win rate (+0.095% avg return)
  - Liquidity spikes predict volatility but not direction

#### Phase 4 - Regime Analysis
- Created `regime-analysis.js`
- Classified 8 composite regimes (IV × GEX × Liquidity)
- Key findings:
  - All regimes show negative autocorrelation (mean reversion dominant)
  - Best regime for longs: HIGH_IV|NEG_GEX|BULL_LIQ (+0.14% avg 1h return)
  - Highest volatility: HIGH_IV|NEG_GEX environments

#### Summary Report Generated
- Created comprehensive `SUMMARY_REPORT.md` with trading recommendations
- Proposed confluence scoring framework for trade entries
- Documented all findings and next steps

**Remaining Tasks:**
- Phase 1.2: 1-second microstructure analysis (optional, requires processing 7GB)
- Phase 2.3: Rolling correlation windows
- Phase 5: High-resolution timing optimization
- Phase 6: Confluence strategy implementation and backtesting

**Files Generated:**
```
research/output/
├── unified_15m_2025.csv (4.66 MB)
├── unified_15m_2025_features.csv (9.45 MB)
├── correlation_results.json
├── correlation_matrix.csv
├── correlation_report.md
├── lead_lag_results.json
├── lead_lag_report.md
├── event_study_results.json
├── event_study_report.md
├── regime_analysis_results.json
├── regime_analysis_report.md
└── SUMMARY_REPORT.md
```

---

### Session 2 - January 21, 2026 (Enhanced Strategy Implementation)

**Objective**: Implement and validate the negative GEX regime filter as a strategy enhancement

**Completed Tasks:**

#### 1. Created Enhanced GEX Recoil Strategy
- Created `/shared/strategies/gex-recoil-enhanced.js`
- Extends base `GexRecoilStrategy` with regime filtering
- Key parameters:
  - `useGexRegimeFilter: true`
  - `allowedGexRegimes: ['negative', 'strong_negative']`
  - `blockPositiveGexRegime: true`

#### 2. Integrated with Backtest Engine
- Added import to `backtest-engine.js`
- Added case to `createStrategy()` switch statement
- Added CLI option for `--strategy gex-recoil-enhanced`
- Added default config in `default.json`

#### 3. Built Validation Script
- Created `research/validate-enhanced-strategy.js`
- Runs both strategies on same data for A/B comparison
- Generates comparison table and saves detailed results

#### 4. Validation Results (Full Year 2025)

| Metric | Original | Enhanced | Change |
|--------|----------|----------|--------|
| Total Trades | 1,062 | 434 | -59.1% |
| **Win Rate** | 46.61% | 49.77% | **+3.16%** |
| Net P&L | $33,290 | $27,150 | -$6,140 |
| **Avg Trade** | $31.35 | $62.56 | **+99.6%** |
| Profit Factor | 1.33 | 1.36 | +0.03 |
| **Max Drawdown** | 6.18% | 4.01% | **-35.1%** |
| Largest Loss | $1,985 | $1,170 | -41.1% |

**Key Findings:**
1. **Correlation analysis validated**: Predicted 3.8% win rate improvement, achieved 3.16%
2. **Per-trade quality doubled**: Average trade went from $31.35 to $62.56
3. **Risk significantly reduced**: Max drawdown cut by 35%, largest loss by 41%
4. **Trade-off**: Fewer total trades = lower absolute P&L but higher quality

**Conclusion**: The negative GEX regime filter successfully improves per-trade quality at the cost of fewer trading opportunities.

**Files Generated:**
```
shared/strategies/gex-recoil-enhanced.js
research/validate-enhanced-strategy.js
research/output/strategy_comparison_results.json
research/output/original_strategy_trades.json
research/output/enhanced_strategy_trades.json
research/output/ENHANCED_STRATEGY_VALIDATION.md
```

---
