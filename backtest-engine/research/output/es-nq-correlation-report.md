# ES-NQ Correlation & Lead-Lag Analysis Report

**Date Range**: Jan 26, 2021 to Jan 25, 2026 (~5 years)
**Data**: Continuous (back-adjusted) 1-minute OHLCV for both NQ and ES
**Overlapping Bars**: 1,768,095

---

## Executive Summary

ES and NQ are highly correlated (r=0.67 at 1m, r=0.93 at daily) but **no scalping-timeframe strategy** survived rigorous out-of-sample testing. The strongest findings are at **daily or multi-hour timeframes**, particularly the NQ/ES ratio mean reversion signal (90.6% reversion rate at z>2 extremes).

The most actionable finding: **NQ leads ES by exactly 1 minute** (cross-correlation r=0.242 at lag 1), but this lead-lag relationship is **too small to profitably trade** after transaction costs. The information is already largely priced in at the next bar.

---

## Key Findings

### 1. Return Correlation at Multiple Timeframes

| Timeframe | Correlation | Directional Agreement | NQ/ES Volatility Ratio |
|-----------|-------------|----------------------|----------------------|
| 1m        | 0.6724      | 84.0%                | 0.972                |
| 5m        | 0.8701      | 88.4%                | 0.979                |
| 15m       | 0.9037      | 89.0%                | 0.983                |
| 30m       | 0.9128      | 89.2%                | 0.985                |
| 1h        | 0.9180      | 89.3%                | 0.986                |
| Daily     | 0.9254      | 87.2%                | 0.989                |

**Insight**: Correlation increases with timeframe. At the 1-minute level, there's 16% directional disagreement — enough for potential divergence trades. NQ is slightly less volatile than ES in percentage terms (ratio ~0.97), which is counterintuitive since NQ has larger point moves. This is because ES trades at a much lower nominal price.

### 2. Lead-Lag Cross-Correlation

| Lag (min) | Correlation | Interpretation |
|-----------|-------------|----------------|
| -1        | 0.0008      | ES leads NQ by 1m |
| **0**     | **0.6724**  | **Contemporaneous** |
| **+1**    | **0.2420**  | **NQ leads ES by 1m** |
| +2        | -0.0025     | Noise |

**Key Finding**: NQ leads ES by exactly 1 minute with r=0.242. This is a very strong cross-correlation but it does **not** translate to a profitable trading strategy:

- Best NQ-leads-ES strategy: 0.15% threshold, 5m hold → PF 1.04, avg +0.16 ES pts/trade
- After 1 tick of slippage per side (0.25 pts each = 0.50), this becomes negative
- The edge is real but too small for the transaction costs of futures trading

**Why NQ leads**: NQ is the more speculative/tech-heavy index and tends to react to market-moving information first. ES follows within 1 minute. This is consistent with NQ being the "smart money" instrument.

### 3. Divergence Analysis (5-minute returns)

Only 0.03% of 5-minute bars show meaningful divergence (NQ and ES moving in opposite directions >0.1% each). When they do:

| After Divergence | NQ Reverts | ES Reverts | Both Revert | Neither |
|-----------------|-----------|-----------|-------------|---------|
| 5 min           | 31.2%     | 46.2%     | 17.2%       | 5.3%    |
| 15 min          | 38.3%     | 47.9%     | 8.9%        | 4.9%    |
| 30 min          | 40.9%     | 45.6%     | 8.8%        | 4.7%    |
| 60 min          | 42.8%     | 45.3%     | 9.4%        | 2.5%    |

**Insight**: ES reverts more often than NQ across all timeframes. This aligns with finding #2 — NQ leads, so NQ is more likely to be "right" during divergences. When ES and NQ disagree, bet on NQ's direction.

### 4. NQ/ES Ratio Analysis (MOST ACTIONABLE)

The daily NQ/ES ratio (mean ~4.35, range 3.67-5.20) exhibits **strong mean reversion**:

- **20-day rolling z-score analysis:**
  - Z > 2 events: 99 occurrences
  - Z < -2 events: 134 occurrences
  - **5-day mean reversion rate: 90.6%** (n=233)
  - When NQ outperforms (z>2): 86.9% revert
  - When ES outperforms (z<-2): 93.3% revert

**Strategy Implication**: A pairs-style daily strategy that fades extreme relative moves has a 90%+ historical success rate. This is the strongest signal in the entire analysis.

### 5. Session-Based Correlation

| Session       | Correlation | Dir. Agreement | NQ/ES Vol Ratio |
|---------------|-------------|----------------|-----------------|
| Overnight     | 0.6922      | 85.5%          | 0.927           |
| RTH Open      | 0.6037      | 75.0%          | 1.082           |
| RTH Mid       | 0.6864      | 81.7%          | 0.987           |
| RTH Close     | 0.6834      | 82.0%          | 0.906           |

**Key Findings**:
- **RTH Open (9:30-10:30 ET) has the lowest correlation** (0.60) and lowest directional agreement (75%). This is the window where NQ and ES diverge most.
- NQ is MORE volatile than ES during RTH Open (ratio 1.082) but LESS volatile in all other sessions. The first hour of RTH is when NQ "overreacts" relative to ES.
- Overnight has the highest correlation but lowest NQ relative volatility — the instruments move more in lockstep overnight.

### 6. Volume-Based Lead-Lag

| Event | Occurs | Follow-Through |
|-------|--------|----------------|
| Simultaneous vol spikes | 48,009 | N/A |
| NQ spike alone | 85,211 | ES follows within 3 bars: 39.8% |
| ES spike alone | 77,370 | NQ follows within 3 bars: 32.6% |

NQ volume spikes are somewhat more predictive of ES following (39.8%) than the reverse (32.6%), consistent with NQ as the "leading" instrument. However, the directional follow-through of volume spikes is weak (29% for NQ leading, 19% for ES leading), making this **not directly tradeable**.

### 7. SMT Divergence (Swing High/Low Non-Confirmation)

**IMPORTANT: Initial results were misleading due to look-ahead bias.**

The initial analysis (using standard ±5 bar swing detection) showed 87-89% win rates. However, this method requires **future bars** to confirm swings, creating look-ahead bias.

With rigorous **lookback-only** swing detection (3 consecutive bars confirming the swing before it's tradeable):
- Bearish SMT: 206 signals, **all configurations were losers** (best PF: 0.82)
- Bullish SMT: Only 20 signals — insufficient sample

**Conclusion**: The standard SMT divergence signal (as popularized by ICT) does **not** produce edge on 1-minute NQ/ES data when look-ahead bias is removed. The apparent success in the initial analysis was entirely due to the swing detection method "knowing" the future.

### 8. Relative Strength Momentum/Reversion

All formation→holding period correlations are **negative** (mean reversion), but the effect is very small:

| Formation | 5m Hold | 15m Hold | 30m Hold | 60m Hold |
|-----------|---------|----------|----------|----------|
| 5m        | -0.197  | -0.136   | -0.101   | -0.073   |
| 15m       | -0.136  | -0.094   | -0.070   | -0.051   |
| 30m       | -0.100  | -0.070   | -0.049   | -0.039   |

**Quintile Analysis** (15m formation → 30m holding):
- Bottom quintile (ES strongest): NQ outperforms next by 0.50 bps
- Top quintile (NQ strongest): ES outperforms next by -0.60 bps
- Monotonic relationship confirms mean reversion

However, when tested as a strategy with realistic entry/exit, the edge is **too small** (all PFs near 1.00, no configuration exceeded PF 1.02). The mean reversion is real but not tradeable at the intraday level.

### 9. Rolling Correlation & Regime Analysis

| Statistic | Value |
|-----------|-------|
| Mean      | 0.7344 |
| Median    | 0.7991 |
| P5        | 0.3127 |
| P25       | 0.6523 |
| P75       | 0.8765 |
| P95       | 0.9366 |

The correlation is "very strong" (>0.8) half the time and goes negative only 0.22% of the time.

Surprisingly, forward NQ volatility is **not** elevated after low-correlation periods (ratio 0.94x). Decorrelation between ES and NQ is not a volatility warning signal.

---

## Strategy Recommendations

### Viable Strategies (Worth Further Development)

1. **Daily NQ/ES Ratio Mean Reversion** (Best signal)
   - When 20-day rolling z-score of NQ/ES ratio exceeds ±2, fade the move
   - 90.6% historical success rate over 5 days
   - Implementation: Long the underperformer, short the outperformer using MNQ/MES micros
   - Needs: Daily EOD execution, 5-day hold period, proper position sizing
   - Risk: Structural shifts in the ratio (it's been declining from 5.2 to 3.7 over this period)

2. **RTH Open Divergence Exploitation**
   - The first hour (9:30-10:30 ET) shows lowest correlation (0.60) and highest NQ relative vol
   - NQ overreacts in the open → mean reversion is strongest at this time
   - Could be combined with existing GEX levels or LT data for entry timing

### Marginal Strategies (Weak Edge, High Noise)

3. **NQ-Leads-ES**
   - Real statistical effect (r=0.242 at 1m lag) but edge too small after costs
   - Could serve as a **confirming filter** for other strategies rather than standalone

### Strategies That Don't Work

4. **SMT Divergence** — Look-ahead bias explains all the apparent edge
5. **Intraday Relative Strength Mean Reversion** — Effect exists but PF < 1.02
6. **Volume Spike Follow-Through** — Directional accuracy too low (19-29%)

---

## Interesting Observations

1. **NQ is the "leader"**: Across lead-lag, divergence resolution, and volume analysis, NQ consistently leads ES. When they diverge, NQ is more likely to be correct.

2. **The ratio has been declining**: NQ/ES went from 5.2 (Feb 2021) to 3.7 (Dec 2025), meaning ES has outperformed NQ over this period. This matters for any ratio-based strategy — the declining trend could produce false signals.

3. **Overnight vs RTH**: The character of the NQ/ES relationship changes significantly by session. Overnight is higher correlation, lower NQ volatility. RTH open is the most divergent period.

4. **84% directional agreement at 1-minute**: This means ~16% of minutes, one is up while the other is down. Those 16% are essentially random noise and don't contain a tradeable signal.

---

## Scripts

- `research/es-nq-correlation.js` — Full correlation analysis (9 analyses)
- `research/es-nq-strategy-deep-dive.js` — Strategy backtests (4 strategies)
- Results in `research/output/es-nq-correlation-report.md`

---

*Generated 2026-03-05 by es-nq-correlation.js and es-nq-strategy-deep-dive.js*


---

## GEX/IV Overlay Analysis (Addendum)

**Date Range**: 2023-03-28 to 2026-01-25 (GEX period), 2025-01-13 to 2026-01-25 (IV period)
**Generated**: 2026-03-05

### Analysis 1: GEX Regime Effect on NQ/ES Correlation

Key finding: Correlation varies by regime combination. Negative GEX regimes tend to show similar or higher correlation than positive regimes.

### Analysis 2: GEX Regime Divergence as Signal

- **nqPos_esNeg** (n=206): 1h forward NQ-ES relative return: 0.0053%, NQ outperforms 49% of time
- **nqNeg_esPos** (n=152): 1h forward NQ-ES relative return: -0.0091%, NQ outperforms 49.3% of time
- **aligned** (n=10675): 1h forward NQ-ES relative return: 0.0013%, NQ outperforms 51.5% of time

### Analysis 3: GEX Level Proximity

- **NQ pinned, ES free** (n=696): 30m forward — pinned instrument shows smaller move: NO (not confirmed)
- **ES pinned, NQ free** (n=1208): 30m forward — pinned instrument shows smaller move: YES (confirmed)

### Analysis 4: NQ-Leads-ES by GEX Regime

| Regime | Trades | Win Rate | Avg ES Pts | PF |
|--------|--------|----------|------------|----|
| negative | 2517 | 59.5% | 3.43 | 1.79 |
| mixed | 478 | 60.3% | 2.53 | 2.05 |
| positive | 419 | 66.3% | 3.28 | 3.01 |
| no_gex | 367 | 53.4% | 1.32 | 1.35 |
| neutral | 158 | 64.6% | 3.99 | 2.71 |

### Analysis 5: Daily Ratio Mean Reversion by GEX

Overall reversion rate: 91.4% (n=128)

- Both GEX positive: 91.2% reversion (n=68)
- Any GEX negative: 91.1% reversion (n=56)

### Analysis 6: IV Effect on Correlation

| IV Level | Correlation | Dir Agreement | N |
|----------|------------|--------------|---|
| low | 0.7111 | 73.5% | 35,010 |
| mid | 0.6695 | 74% | 34,911 |
| high | 0.6717 | 77.6% | 36,060 |

### Analysis 7: Combined GEX Divergence + IV

Events: 26 combined, 73 GEX-only, 2629 IV-only

*Generated by es-nq-gex-iv-overlay.js*
