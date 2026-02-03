# NQ Data Exploration - Findings

## Data Inventory

### 1. OHLCV Price Data
**Location**: `/backtest-engine/data/ohlcv/nq/`

| File | Records | Time Range | Resolution |
|------|---------|------------|------------|
| NQ_ohlcv_1m.csv | 2.57M | Dec 27, 2020 - Dec 25, 2025 | 1-minute |
| NQ_ohlcv_1s.csv | ~7.6GB | Jan 17, 2021 - present | 1-second |

**Schema**: `ts_event, rtype, publisher_id, instrument_id, open, high, low, close, volume, symbol`

**Important Notes**:
- Contains multiple contract months (e.g., NQH1, NQM1, NQH6)
- Must filter for primary contract (highest volume per hour) to avoid false signals
- Calendar spread entries (e.g., NQH1-NQM1) must be filtered out

---

### 2. GEX (Gamma Exposure) Levels
**Location**: `/backtest-engine/data/gex/nq/`

| File | Records | Time Range | Resolution |
|------|---------|------------|------------|
| NQ_gex_levels.csv | 690 | Mar 28, 2023 - Dec 26, 2025 | Daily |
| nq_gex_*.json | ~500 files | Mar 2023 - Dec 2025 | 15-min intraday |

**Daily CSV Schema**: `date, nq_gamma_flip, nq_put_wall_1/2/3, nq_call_wall_1/2/3, conversion_factor, nq_contract, total_gex, regime`

**Intraday JSON Schema**: Contains `gamma_flip, call_wall, put_wall, total_gex, total_vex, total_cex, resistance[], support[], regime, nq_spot, qqq_spot, multiplier`

**Regimes Observed**: `strong_positive`, `positive`, `negative`, `strong_negative`

---

### 3. Liquidity Trigger (LT) Levels
**Location**: `/backtest-engine/data/liquidity/nq/`

| File | Records | Time Range | Resolution |
|------|---------|------------|------------|
| NQ_liquidity_levels.csv | 66,161 | Mar 9, 2023 - Dec 29, 2025 | 15-minute |

**Schema**: `datetime, unix_timestamp, sentiment, level_1, level_2, level_3, level_4, level_5`

**Sentiment Values**: `BULLISH`, `BEARISH`

**Level Structure**:
- level_1 = Fib 34 (short-term liquidity)
- level_2 = Fib 55 (short-term liquidity)
- level_3 = Fib 144 (medium-term)
- level_4 = Fib 377 (long-term)
- level_5 = Fib 610 (long-term)

**Key Insight**: Levels are NOT ordered by price - they output in fixed series order. Level crossings through price predict direction at ~74% accuracy.

---

### 4. Implied Volatility (IV) Data
**Location**: `/backtest-engine/data/iv/qqq/`

| File | Records | Time Range | Resolution |
|------|---------|------------|------------|
| qqq_atm_iv_15m.csv | 6,450 | Jan 13, 2025 - Dec 24, 2025 | 15-minute |

**Schema**: `timestamp, iv, spot_price, atm_strike, call_iv, put_iv, dte`

**Key Metrics**:
- IV Skew = put_iv - call_iv
- Negative skew = calls expensive = bullish positioning
- Positive skew = puts expensive = bearish hedging

---

### 5. Options Trade Data (OPRA)
**Location**: `/backtest-engine/data/options-trades/`

| Symbol | Files | Date Range |
|--------|-------|------------|
| QQQ | ~200+ files | 2025 (various dates) |
| VIX | Metadata only | - |
| SPX | Metadata only | - |

**File Format**: `opra-pillar-YYYYMMDD.trades.csv`

---

### 6. Options CBBO (Consolidated BBO)
**Location**: `/backtest-engine/data/cbbo-1m/`

Available for QQQ, VIX, SPX with 1-minute resolution.

---

### 7. Options Statistics
**Location**: `/backtest-engine/data/statistics/`

Per-instrument market statistics.

---

### 8. Options Definitions
**Location**: `/backtest-engine/data/definition/`

Contract specifications (strikes, expirations, multipliers).

---

## Data Quality Assessment

### Strengths
1. **5+ years of 1-minute OHLCV data** - Excellent for robust backtesting
2. **Aligned GEX levels** - Daily and intraday GEX synchronized with price data
3. **2+ years of LT levels** - Good sample size for pattern analysis
4. **IV data for 2025** - Enables IV-based strategy development

### Gaps & Issues
1. **IV data limited to 2025** - Cannot backtest IV strategies on earlier data
2. **Multiple contracts in OHLCV** - Must filter for primary contract
3. **Calendar spreads in data** - Must exclude (contain dash in symbol)
4. **LT levels not price-ordered** - Require special handling for analysis

---

## Existing Analysis (Prior Work)

### Liquidity Sweep Strategy (Jan 2025)
Found in `/backtest-engine/data/analysis/`:

**Best Configuration**: Overnight + Premarket + Shorts Only
- Total P&L: +768 pts (Jan 1-20, 2025)
- Profit Factor: 1.09
- Win Rate: 18.56%
- Avg Win: +9.56 pts, Avg Loss: -2.00 pts
- Risk/Reward: 4.97:1

**Key Findings**:
- RTH loses money (-0.05 pts avg)
- Overnight best (+0.12 pts avg)
- Shorts outperform longs

---

## Initial Observations & Patterns

### Session Performance (from prior work)
| Session | Avg P&L | Win Rate |
|---------|---------|----------|
| Overnight (8PM-4AM) | +0.12 pts | 18.48% |
| Premarket (4AM-9:30AM) | +0.07 pts | - |
| RTH (9:30AM-4PM) | -0.05 pts | - |
| Afterhours (4PM-8PM) | +0.07 pts | - |

**Hypothesis**: Lower liquidity sessions favor mean-reversion strategies.

### GEX Regime Distribution
From daily GEX data, `positive` and `strong_positive` regimes dominate. Need to quantify:
- What % of time is each regime?
- How does price behavior differ by regime?

### LT Level Crossings
The CLAUDE.md mentions 74% accuracy on level crossings predicting direction. This is a key hypothesis to validate.

---

## Hypotheses to Test

### H1: GEX Regime-Based Directional Bias
- **Hypothesis**: In positive GEX regimes, long trades at support outperform shorts
- **Test**: Segment trades by regime, compare long vs short performance

### H2: IV Skew Momentum
- **Hypothesis**: Extreme IV skew (puts/calls expensive) predicts short-term direction
- **Test**: Entry on skew extremes, measure 15m/60m forward returns

### H3: GEX Level + Session Confluence
- **Hypothesis**: GEX level touches during overnight session have higher reversion probability
- **Test**: Compare bounce rate at GEX levels across sessions

### H4: LT Level Crossing as Entry Trigger
- **Hypothesis**: When price crosses through an LT level, direction of cross predicts continuation
- **Test**: Measure returns after level crossings, segment by level type (fib lookback)

### H5: Multi-Factor Confluence
- **Hypothesis**: Combining GEX level proximity + favorable IV skew + LT sentiment alignment produces better signals
- **Test**: Create composite signal, compare to single-factor approaches

---

## Next Steps

1. **Validate H1** - GEX regime impact on long vs short
2. **Test H3** - GEX + Session confluence
3. **Develop strategy** based on strongest signal
4. **Backtest with proper validation**
