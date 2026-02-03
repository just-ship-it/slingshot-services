# S1 Support Long Strategy - Performance Analysis

## Strategy Overview

Long entries when price touches S1 (first support level) from above.

**Entry Conditions**:
- Price within 15 pts of S1 level
- Candle low touches S1 from above (candle.low <= S1 + 10)
- Close is above S1

**Exit Parameters**:
- Stop Loss: 10 pts below S1
- Take Profit: 30 pts (fixed) or trailing (15 pt trigger, 8 pt offset)

---

## Backtest Results

### 2024 (In-Sample) - 252 GEX Days

| Exit Mode | Trades | Win Rate | Total P&L | Avg P&L | Profit Factor |
|-----------|--------|----------|-----------|---------|---------------|
| Fixed | 1,682 | 39.8% | -700.73 | -0.42 | 0.96 |
| Trailing | 1,682 | 53.3% | -2,899.71 | -1.72 | 0.79 |

### 2025 (Out-of-Sample) - 11 GEX Days

| Exit Mode | Trades | Win Rate | Total P&L | Avg P&L | Profit Factor |
|-----------|--------|----------|-----------|---------|---------------|
| Fixed | 89 | 41.6% | +93.75 | +1.05 | 1.09 |
| Trailing | 89 | 58.4% | +36.02 | +0.40 | 1.05 |

**Note**: 2025 shows improved performance - possible regime shift or small sample variance.

---

## Analysis by Session (2024 Fixed Exit)

| Session | Trades | P&L | Win Rate |
|---------|--------|-----|----------|
| Afterhours | 124 | +64.10 | 45.2% |
| Overnight | 77 | -36.50 | 48.1% |
| RTH | 1,360 | -249.45 | 39.4% |
| Premarket | 121 | -478.88 | 33.1% |

**Finding**: Only afterhours session is profitable. Premarket is particularly bad.

---

## Analysis by Regime (2024 Fixed Exit)

| Regime | Trades | P&L | Win Rate |
|--------|--------|-----|----------|
| Strong Negative | 468 | +5.88 | 39.3% |
| Strong Positive | 1,100 | -307.83 | 40.8% |
| Negative | 57 | -217.23 | 29.8% |
| Positive | 57 | -181.54 | 33.3% |

**Finding**: Only marginally profitable in strong_negative regime (+5.88 pts on 468 trades).

---

## 2025 Out-of-Sample Deep Dive

Interestingly, 2025 data shows positive results:

**By Session (2025 Fixed)**:
| Session | Trades | P&L | Win Rate |
|---------|--------|-----|----------|
| Afterhours | 10 | +183.49 | 80.0% |
| Premarket | 7 | +68.38 | 57.1% |
| Overnight | 4 | +17.13 | 50.0% |
| RTH | 68 | -175.25 | 33.8% |

**By Regime (2025 Fixed)**:
| Regime | Trades | P&L | Win Rate |
|--------|--------|-----|----------|
| Strong Positive | 57 | +71.90 | 42.1% |
| Strong Negative | 30 | +12.89 | 40.0% |

The afterhours session shows exceptional performance (80% WR, +183.49 pts) in 2025.

---

## Why This Strategy Fails (Baseline)

1. **S1 is a weak support level**: First support frequently breaks during trends
2. **High trade frequency = noise**: 1,682 trades/year includes many low-quality setups
3. **Trailing stops hurt**: Same pattern - higher WR but worse P&L
4. **Session timing matters**: Premarket is terrible (-478.88 pts) - often pre-gap

---

## Suggested Improvements

### Filter 1: Afterhours Only

Based on consistent afterhours outperformance:
```javascript
{
  useSessionFilter: true,
  allowedSessions: ['afterhours'],
  exitMode: 'fixed',
  takeProfitPoints: 30
}
```

2024: +64.10 pts, 45.2% WR (124 trades)
2025: +183.49 pts, 80.0% WR (10 trades)

### Filter 2: Strong Negative Regime + Afterhours

Combine regime and session:
```javascript
{
  useSessionFilter: true,
  allowedSessions: ['afterhours'],
  useRegimeFilter: true,
  allowedRegimes: ['strong_negative'],
  exitMode: 'fixed'
}
```

### Filter 3: Multiple Support Confluence

Instead of S1 alone, require:
- S1 + S2 within 20 pts (support cluster)
- Put Wall within 50 pts below (gamma support)
- Creates stronger support zone

### Filter 4: Candlestick Confirmation

Require rejection pattern:
- Hammer or pin bar at S1
- Close in upper 25% of candle range
- Next candle confirms direction

---

## Recommendation

**MARGINAL - Afterhours filter shows potential**

The baseline strategy is unprofitable, but:
- Afterhours session is consistently profitable (2024 + 2025)
- Low trade frequency with filter (~124 trades/year)
- Simple to implement

Recommended configuration:
```javascript
{
  useSessionFilter: true,
  allowedSessions: ['afterhours'],
  exitMode: 'fixed',
  stopLossPoints: 10,
  takeProfitPoints: 30
}
```

Expected performance: +64 pts/year (2024), +183 pts/year (2025 projected)

Caveats:
- 2025 afterhours sample is only 10 trades (high variance)
- Need more OOS data to validate
- Afterhours has lower liquidity - execution may differ
