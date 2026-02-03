# Regime Analysis Report

**Generated**: 2026-01-21T06:09:05.229Z
**Records Analyzed**: 5,700 (RTH with complete data)
**Composite Regimes**: 8

---

## Regime Classification

Markets are classified into 8 composite regimes based on three dimensions:
- **IV Regime**: HIGH_IV (>50th percentile) or LOW_IV
- **GEX Regime**: POS_GEX (positive gamma) or NEG_GEX (negative gamma)
- **Liquidity Regime**: BULL_LIQ (bullish sentiment) or BEAR_LIQ (bearish sentiment)

---

## Regime Performance Summary

| Regime | Freq | 1h Avg Return | 1h Win Rate | Volatility | Autocorr | Strategy |
|--------|------|--------------|-------------|------------|----------|----------|
| LOW_IV|POS_GEX|BULL_LIQ | 23.6% | NaN% | 57.6% | 0.2603 | -0.370 | MEAN_REVERSION |
| HIGH_IV|NEG_GEX|BEAR_LIQ | 17.6% | -0.0200% | 51.8% | 0.5000 | -0.302 | MEAN_REVERSION |
| LOW_IV|POS_GEX|BEAR_LIQ | 16.1% | 0.0054% | 52.6% | 0.2723 | -0.285 | MEAN_REVERSION |
| HIGH_IV|POS_GEX|BULL_LIQ | 13.6% | -0.0161% | 52.1% | 0.3046 | -0.279 | MEAN_REVERSION |
| HIGH_IV|NEG_GEX|BULL_LIQ | 10.9% | 0.1416% | 52.3% | 0.5095 | -0.274 | MEAN_REVERSION |
| LOW_IV|NEG_GEX|BEAR_LIQ | 8.4% | -0.0143% | 51.0% | 0.3389 | -0.332 | MEAN_REVERSION |
| HIGH_IV|POS_GEX|BEAR_LIQ | 7.9% | 0.0217% | 54.3% | 0.3497 | -0.252 | MEAN_REVERSION |
| LOW_IV|NEG_GEX|BULL_LIQ | 1.9% | 0.0768% | 57.5% | 0.2506 | -0.382 | MEAN_REVERSION |

---

## Detailed Regime Analysis

### LOW_IV|POS_GEX|BULL_LIQ

**Frequency**: 23.6% (1348 observations)

**Returns**:
- 15m: Mean=0.0225%, Win Rate=55.6%
- 1h: Mean=NaN%, Win Rate=57.6%
- 4h: Mean=NaN%, Win Rate=58.9%

**Volatility**: Mean=0.2603

**Market Dynamics**:
- Autocorrelation: -0.370
- Mean Reversion Strength: 0.370
- Trend Strength: 0.000

**Recommended Strategy**: MEAN_REVERSION (Confidence: HIGH)
**Directional Bias**: NEUTRAL
**Volatility Level**: HIGH

---

### HIGH_IV|NEG_GEX|BEAR_LIQ

**Frequency**: 17.6% (1001 observations)

**Returns**:
- 15m: Mean=-0.0614%, Win Rate=46.5%
- 1h: Mean=-0.0200%, Win Rate=51.8%
- 4h: Mean=0.0145%, Win Rate=50.6%

**Volatility**: Mean=0.5000

**Market Dynamics**:
- Autocorrelation: -0.302
- Mean Reversion Strength: 0.302
- Trend Strength: 0.000

**Recommended Strategy**: MEAN_REVERSION (Confidence: HIGH)
**Directional Bias**: BEARISH
**Volatility Level**: HIGH

---

### LOW_IV|POS_GEX|BEAR_LIQ

**Frequency**: 16.1% (918 observations)

**Returns**:
- 15m: Mean=-0.0336%, Win Rate=43.2%
- 1h: Mean=0.0054%, Win Rate=52.6%
- 4h: Mean=0.0276%, Win Rate=57.5%

**Volatility**: Mean=0.2723

**Market Dynamics**:
- Autocorrelation: -0.285
- Mean Reversion Strength: 0.285
- Trend Strength: 0.000

**Recommended Strategy**: MEAN_REVERSION (Confidence: HIGH)
**Directional Bias**: NEUTRAL
**Volatility Level**: HIGH

---

### HIGH_IV|POS_GEX|BULL_LIQ

**Frequency**: 13.6% (776 observations)

**Returns**:
- 15m: Mean=0.0454%, Win Rate=58.6%
- 1h: Mean=-0.0161%, Win Rate=52.1%
- 4h: Mean=-0.0580%, Win Rate=50.1%

**Volatility**: Mean=0.3046

**Market Dynamics**:
- Autocorrelation: -0.279
- Mean Reversion Strength: 0.279
- Trend Strength: 0.000

**Recommended Strategy**: MEAN_REVERSION (Confidence: HIGH)
**Directional Bias**: NEUTRAL
**Volatility Level**: HIGH

---

### HIGH_IV|NEG_GEX|BULL_LIQ

**Frequency**: 10.9% (620 observations)

**Returns**:
- 15m: Mean=0.0824%, Win Rate=57.4%
- 1h: Mean=0.1416%, Win Rate=52.3%
- 4h: Mean=0.3480%, Win Rate=59.2%

**Volatility**: Mean=0.5095

**Market Dynamics**:
- Autocorrelation: -0.274
- Mean Reversion Strength: 0.274
- Trend Strength: 0.000

**Recommended Strategy**: MEAN_REVERSION (Confidence: HIGH)
**Directional Bias**: BULLISH
**Volatility Level**: HIGH

---

### LOW_IV|NEG_GEX|BEAR_LIQ

**Frequency**: 8.4% (480 observations)

**Returns**:
- 15m: Mean=-0.0148%, Win Rate=48.1%
- 1h: Mean=-0.0143%, Win Rate=51.0%
- 4h: Mean=-0.0779%, Win Rate=48.8%

**Volatility**: Mean=0.3389

**Market Dynamics**:
- Autocorrelation: -0.332
- Mean Reversion Strength: 0.332
- Trend Strength: 0.000

**Recommended Strategy**: MEAN_REVERSION (Confidence: HIGH)
**Directional Bias**: NEUTRAL
**Volatility Level**: HIGH

---

### HIGH_IV|POS_GEX|BEAR_LIQ

**Frequency**: 7.9% (451 observations)

**Returns**:
- 15m: Mean=-0.0253%, Win Rate=46.1%
- 1h: Mean=0.0217%, Win Rate=54.3%
- 4h: Mean=0.2851%, Win Rate=63.0%

**Volatility**: Mean=0.3497

**Market Dynamics**:
- Autocorrelation: -0.252
- Mean Reversion Strength: 0.252
- Trend Strength: 0.000

**Recommended Strategy**: MEAN_REVERSION (Confidence: HIGH)
**Directional Bias**: BULLISH
**Volatility Level**: HIGH

---

### LOW_IV|NEG_GEX|BULL_LIQ

**Frequency**: 1.9% (106 observations)

**Returns**:
- 15m: Mean=0.0821%, Win Rate=67.9%
- 1h: Mean=0.0768%, Win Rate=57.5%
- 4h: Mean=0.0006%, Win Rate=62.3%

**Volatility**: Mean=0.2506

**Market Dynamics**:
- Autocorrelation: -0.382
- Mean Reversion Strength: 0.382
- Trend Strength: 0.000

**Recommended Strategy**: MEAN_REVERSION (Confidence: HIGH)
**Directional Bias**: BULLISH
**Volatility Level**: HIGH

---


## Regime Transitions

Top regime transitions and their forward returns:

| Transition | Count | Avg 1h Return | Win Rate |
|------------|-------|---------------|----------|
| LOW_IV|POS_GEX|BULL_LIQ → LOW_IV|POS_GEX|BEAR_LIQ | 92 | -0.0042% | 47.8% |
| LOW_IV|POS_GEX|BEAR_LIQ → LOW_IV|POS_GEX|BULL_LIQ | 82 | 0.0305% | 59.8% |
| HIGH_IV|NEG_GEX|BEAR_LIQ → HIGH_IV|NEG_GEX|BULL_LIQ | 75 | 0.0416% | 46.7% |
| HIGH_IV|POS_GEX|BULL_LIQ → LOW_IV|POS_GEX|BULL_LIQ | 75 | 0.0582% | 50.7% |
| LOW_IV|POS_GEX|BULL_LIQ → HIGH_IV|POS_GEX|BULL_LIQ | 67 | 0.1013% | 52.2% |
| HIGH_IV|NEG_GEX|BULL_LIQ → HIGH_IV|NEG_GEX|BEAR_LIQ | 59 | 0.2229% | 67.8% |
| HIGH_IV|POS_GEX|BEAR_LIQ → LOW_IV|POS_GEX|BEAR_LIQ | 53 | 0.0347% | 52.8% |
| LOW_IV|POS_GEX|BEAR_LIQ → HIGH_IV|POS_GEX|BEAR_LIQ | 51 | -0.0401% | 52.9% |
| HIGH_IV|POS_GEX|BULL_LIQ → HIGH_IV|POS_GEX|BEAR_LIQ | 50 | -0.0166% | 52.0% |
| HIGH_IV|POS_GEX|BEAR_LIQ → HIGH_IV|POS_GEX|BULL_LIQ | 43 | 0.1439% | 55.8% |
| LOW_IV|NEG_GEX|BEAR_LIQ → HIGH_IV|NEG_GEX|BEAR_LIQ | 42 | -0.0235% | 45.2% |
| LOW_IV|POS_GEX|BEAR_LIQ → LOW_IV|NEG_GEX|BEAR_LIQ | 39 | -0.1943% | 43.6% |
| HIGH_IV|NEG_GEX|BEAR_LIQ → LOW_IV|NEG_GEX|BEAR_LIQ | 37 | 0.0203% | 43.2% |
| LOW_IV|NEG_GEX|BEAR_LIQ → LOW_IV|POS_GEX|BEAR_LIQ | 33 | -0.0129% | 54.5% |
| HIGH_IV|POS_GEX|BEAR_LIQ → HIGH_IV|NEG_GEX|BEAR_LIQ | 29 | -0.3481% | 41.4% |
| HIGH_IV|NEG_GEX|BULL_LIQ → HIGH_IV|POS_GEX|BULL_LIQ | 29 | -0.0254% | 65.5% |
| LOW_IV|NEG_GEX|BEAR_LIQ → LOW_IV|NEG_GEX|BULL_LIQ | 23 | 0.0018% | 47.8% |
| HIGH_IV|POS_GEX|BULL_LIQ → HIGH_IV|NEG_GEX|BULL_LIQ | 18 | 0.0004% | 44.4% |
| LOW_IV|NEG_GEX|BULL_LIQ → LOW_IV|NEG_GEX|BEAR_LIQ | 18 | -0.0574% | 55.6% |
| HIGH_IV|NEG_GEX|BEAR_LIQ → HIGH_IV|POS_GEX|BEAR_LIQ | 16 | -0.0799% | 56.3% |

---

## Trading Implications

### Best Regimes for Long Trades
- **HIGH_IV|NEG_GEX|BULL_LIQ**: 0.1416% avg return, 52.3% win rate
- **LOW_IV|NEG_GEX|BULL_LIQ**: 0.0768% avg return, 57.5% win rate
- **HIGH_IV|POS_GEX|BEAR_LIQ**: 0.0217% avg return, 54.3% win rate

### Best Regimes for Short Trades
- **HIGH_IV|NEG_GEX|BEAR_LIQ**: -0.0200% avg return, 48.2% short win rate
- **HIGH_IV|POS_GEX|BULL_LIQ**: -0.0161% avg return, 47.9% short win rate
- **LOW_IV|NEG_GEX|BEAR_LIQ**: -0.0143% avg return, 49.0% short win rate

### Mean Reversion Opportunities
- **LOW_IV|NEG_GEX|BULL_LIQ**: Autocorr=-0.382 (strong mean reversion)
- **LOW_IV|POS_GEX|BULL_LIQ**: Autocorr=-0.370 (strong mean reversion)
- **LOW_IV|NEG_GEX|BEAR_LIQ**: Autocorr=-0.332 (strong mean reversion)

### Trend Following Opportunities
- No strong trending regimes identified

---

## Methodology

- **Regime Classification**: Binary classification on IV (median split), GEX (positive/negative), Liquidity (bullish/bearish)
- **Autocorrelation**: Lag-1 autocorrelation of 15-minute returns; negative = mean reversion, positive = trending
- **Sharpe Ratio**: Mean return / Standard deviation (risk-adjusted performance)
- **Data**: RTH (Regular Trading Hours) records with complete data for all three regime dimensions

---

*Report generated by regime-analysis.js*
