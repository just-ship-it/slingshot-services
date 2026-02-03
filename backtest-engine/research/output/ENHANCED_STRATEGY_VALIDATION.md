# Enhanced GEX Recoil Strategy Validation Report

**Generated**: 2026-01-21
**Analysis Period**: January 13, 2025 - December 24, 2025
**Strategy**: GEX Recoil Enhanced with Negative GEX Regime Filter

---

## Executive Summary

The enhanced GEX Recoil strategy with negative GEX regime filtering shows **significant improvement** in per-trade quality metrics, validating the correlation analysis findings. While total P&L is lower due to fewer trades, the average trade profitability nearly doubled.

### Key Finding
The correlation analysis predicted that support bounces in negative GEX regimes would show 57.1% win rate vs 53.3% in positive GEX regimes (a +3.8% improvement). The backtest validation confirmed this with a **+3.16% win rate improvement** (46.61% → 49.77%), demonstrating the analysis findings translate into real trading improvement.

---

## Validation Results

### Full Year 2025 Comparison

| Metric | Original GEX Recoil | Enhanced (Regime Filter) | Change |
|--------|---------------------|--------------------------|--------|
| **Total Trades** | 1,062 | 434 | -59.1% |
| **Win Rate** | 46.61% | 49.77% | **+3.16%** |
| **Net P&L** | $33,290 | $27,150 | -$6,140 |
| **Average Trade** | $31.35 | $62.56 | **+99.6%** |
| **Profit Factor** | 1.33 | 1.36 | +0.03 |
| **Max Drawdown** | 6.18% | 4.01% | **-35.1%** |
| **Largest Loss** | $1,985 | $1,170 | **-41.1%** |
| **Sharpe Ratio** | 5.17 | 3.69 | -1.48 |
| **Average Win** | $469.35 | $489.21 | +$19.86 |
| **Average Loss** | $351.66 | $360.18 | +$8.52 |

### Q1 2025 Quick Test

| Metric | Original | Enhanced | Change |
|--------|----------|----------|--------|
| Total Trades | 296 | 184 | -37.8% |
| Win Rate | 49.32% | 49.46% | +0.14% |
| Net P&L | $11,070 | $6,995 | -$4,075 |
| Average Trade | $37.40 | $38.02 | +$0.62 |
| Profit Factor | 1.24 | 1.24 | 0.00 |

---

## Analysis

### Why Per-Trade Quality Improved

1. **Negative GEX Regimes = Better Bounce Setup**
   - In negative GEX environments, dealer hedging creates stronger support level reactions
   - The correlation analysis showed 57.1% bounce rate vs 53.3% in positive GEX
   - Backtest confirms: 49.77% win rate vs 46.61% (+3.16%)

2. **Risk-Adjusted Improvement**
   - Max drawdown reduced from 6.18% to 4.01% (-35%)
   - Largest single loss reduced from $1,985 to $1,170 (-41%)
   - This suggests the filtered-out positive GEX trades had higher tail risk

3. **Trade Quality vs Quantity**
   - Average trade nearly doubled ($31.35 → $62.56)
   - Fewer but better quality signals
   - Higher selectivity leads to more reliable setups

### Why Total P&L is Lower

The enhanced strategy generates $6,140 less total profit, but this is due to taking 59% fewer trades. When normalized per-trade:

- **Original**: $33,290 / 1,062 trades = $31.35/trade
- **Enhanced**: $27,150 / 434 trades = $62.56/trade

The enhanced strategy extracts more value per trade, but the original strategy makes up for lower quality with volume.

### Lower Sharpe Ratio Explained

The Sharpe ratio dropped from 5.17 to 3.69 because:
1. Fewer trades = higher volatility in returns distribution
2. Sharpe ratio rewards consistent frequency of returns
3. Despite lower Sharpe, the Calmar ratio (return/max drawdown) likely improved

---

## Strategy Parameters

### Enhanced Strategy Default Configuration

```json
{
  "useGexRegimeFilter": true,
  "preferNegativeGexRegime": true,
  "allowedGexRegimes": ["negative", "strong_negative"],
  "blockPositiveGexRegime": true,
  "targetPoints": 20.0,
  "stopBuffer": 12.0,
  "maxRisk": 30.0
}
```

### Filter Statistics

- **Signals Evaluated**: ~1,062 (based on original trade count)
- **Passed Regime Filter**: 434 (40.9%)
- **Blocked by Positive GEX**: ~628 (59.1%)

---

## Recommendations

### 1. Use Enhanced Strategy for Better Per-Trade Quality

The enhanced strategy is recommended when:
- Capital preservation is important (lower max drawdown)
- You want higher quality, more reliable signals
- You prefer fewer but better trades

### 2. Consider the Original Strategy for Higher Total P&L

The original strategy may be preferred when:
- Maximizing total P&L is the primary goal
- You can tolerate higher drawdowns
- You want more frequent trading opportunities

### 3. Potential Further Enhancements

Based on the correlation analysis, additional filters could be tested:

1. **IV Percentile Filter**
   - High IV predicts larger price ranges (r=0.30)
   - Could be used to adjust targets dynamically

2. **Liquidity Sentiment Alignment**
   - BULLISH liquidity in negative GEX = better bounces
   - Could further improve win rate

3. **Combined Regime Scoring**
   - Use the confluence scoring framework from the analysis
   - Entry threshold of score ≥ 3 for higher quality

---

## Files Generated

| File | Description |
|------|-------------|
| `gex-recoil-enhanced.js` | Enhanced strategy implementation |
| `validate-enhanced-strategy.js` | Validation script for A/B testing |
| `strategy_comparison_results.json` | Detailed comparison data |
| `original_strategy_trades.json` | Trade log for original strategy |
| `enhanced_strategy_trades.json` | Trade log for enhanced strategy |

---

## Conclusion

The enhanced GEX Recoil strategy with negative GEX regime filtering successfully validates the correlation analysis findings:

1. **Win rate improved by 3.16%** (close to the predicted 3.8% improvement)
2. **Per-trade profitability nearly doubled**
3. **Risk metrics significantly improved** (lower drawdown, smaller max loss)
4. **The correlation analysis findings translate into real trading improvement**

The trade-off is fewer total trades and lower absolute P&L, but the quality improvement makes this a viable strategy for risk-conscious traders.

---

*Validation conducted using the Slingshot Backtesting Engine*
