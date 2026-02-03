# R1 Resistance Short Strategy - Performance Analysis

## Strategy Overview

Short entries when price touches R1 (first resistance level) from below.

**Entry Conditions**:
- Price within 15 pts of R1 level
- Candle high touches R1 from below (candle.high >= R1 - 10)
- Close is below R1

**Exit Parameters**:
- Stop Loss: 10 pts above R1
- Take Profit: 30 pts (fixed) or trailing (15 pt trigger, 8 pt offset)

---

## Backtest Results

### 2024 (In-Sample) - 252 GEX Days

| Exit Mode | Trades | Win Rate | Total P&L | Avg P&L | Profit Factor |
|-----------|--------|----------|-----------|---------|---------------|
| Fixed | 1,660 | 39.6% | -503.16 | -0.30 | 0.97 |
| Trailing | 1,660 | 52.7% | -2,953.10 | -1.78 | 0.77 |

### 2025 (Out-of-Sample) - 11 GEX Days

| Exit Mode | Trades | Win Rate | Total P&L | Avg P&L | Profit Factor |
|-----------|--------|----------|-----------|---------|---------------|
| Fixed | 77 | 39.0% | -10.49 | -0.14 | 0.99 |
| Trailing | 77 | 51.9% | -205.04 | -2.66 | 0.70 |

---

## Analysis by Session (2024 Fixed Exit)

| Session | Trades | P&L | Win Rate |
|---------|--------|-----|----------|
| Overnight | 98 | +374.59 | 56.1% |
| Premarket | 128 | +115.50 | 42.2% |
| RTH | 1,312 | -694.71 | 38.0% |
| Afterhours | 122 | -298.54 | 41.0% |

**Finding**: Strategy is profitable in overnight session only (+374.59 pts, 56.1% win rate).

---

## Analysis by Regime (2024 Fixed Exit)

| Regime | Trades | P&L | Win Rate |
|--------|--------|-----|----------|
| Negative | 40 | +166.34 | 50.0% |
| Strong Negative | 580 | +225.83 | 40.9% |
| Positive | 49 | -84.22 | 38.8% |
| Strong Positive | 991 | -811.12 | 38.5% |

**Finding**: Strategy is profitable in negative GEX regimes (+392.17 pts combined).

---

## Why This Strategy Fails (Baseline)

1. **R1 is a weak resistance level**: 39.6% win rate across all conditions is below random
2. **Trend following market**: In positive regimes (65% of time), shorting resistance fails
3. **Trailing stops hurt**: Higher win rate but much worse P&L - letting winners run doesn't work for shorts in uptrend

---

## Suggested Improvements

### Filter 1: Overnight + Negative Regime Only

Based on segment analysis, combining:
- Session: overnight only
- Regime: negative or strong_negative

Expected improvement:
- Win rate: ~55%
- Positive expectancy in limited sample

### Filter 2: Add Momentum Confirmation

Instead of simple touch, require:
- RSI > 70 at entry (overbought)
- Previous 3 candles net positive (exhausted move)
- Volume spike (capitulation buying)

### Filter 3: Use Wider Stop

Current 10 pt stop is too tight for R1 bounces. Consider:
- Stop at R2 level (avg ~40 pts above R1)
- Reduce position size to maintain risk budget

---

## Recommendation

**DO NOT TRADE** this strategy in current form.

The baseline strategy is unprofitable. While the overnight + negative regime filter shows promise, the sample size is too small (98 overnight trades, ~40% in negative regime = ~40 trades) for reliable conclusions.

If implementing, use strict filters:
```javascript
{
  useSessionFilter: true,
  allowedSessions: ['overnight'],
  useRegimeFilter: true,
  allowedRegimes: ['negative', 'strong_negative'],
  exitMode: 'fixed',
  takeProfitPoints: 30
}
```

This would reduce trade count from 1,660 to ~40 per year but may achieve positive expectancy.
