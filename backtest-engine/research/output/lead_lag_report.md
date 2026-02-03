# Lead-Lag Analysis Report

**Generated**: 2026-01-21T06:05:58.890Z
**Records Analyzed**: 5,700 (RTH only)
**Lags Tested**: 15m, 30m, 60m, 120m, 240m

---

## Executive Summary

Tested 9 predictors against 3 target variables at 5 different lags.
Found **15 predictor-target pairs** with statistically significant predictive relationships.

---

## Key Predictive Relationships

| Predictor | Target | Best Lag | Correlation | Hit Rate | Interpretation |
|-----------|--------|----------|-------------|----------|----------------|
| iv_percentile_all | price_volatility_1h | 15m | 0.3036 | 100.0% | Higher iv percentile all predicts higher volatility |
| gex_regime_encoded | price_volatility_1h | 15m | -0.2557 | 61.3% | Higher gex regime encoded predicts lower volatility |
| gex_regime_encoded | price_range_15m | 15m | -0.2514 | 61.3% | Higher gex regime encoded predicts lower volatility |
| total_gex | price_range_15m | 15m | -0.2452 | 61.3% | Higher total gex predicts lower volatility |
| iv_percentile_all | price_range_15m | 15m | 0.2355 | 100.0% | Higher iv percentile all predicts higher volatility |
| total_gex | price_volatility_1h | 15m | -0.2171 | 61.3% | Higher total gex predicts lower volatility |
| liq_max_change | price_volatility_1h | 15m | 0.1878 | 100.0% | Higher liq max change predicts higher volatility |
| gex_dist_gamma_flip | price_range_15m | 15m | -0.1712 | 54.1% | Higher gex dist gamma flip predicts lower volatility |
| gex_dist_gamma_flip | price_return_15m | 15m | -0.1693 | 46.9% | Positive GEX predicts downward price movement (mean reversion) |
| liq_max_change | price_range_15m | 15m | 0.1689 | 100.0% | Higher liq max change predicts higher volatility |
| gex_dist_gamma_flip | price_volatility_1h | 240m | -0.1683 | 54.0% | Higher gex dist gamma flip predicts lower volatility |
| liq_sentiment_encoded | price_range_15m | 15m | -0.1010 | 50.0% | Higher liq sentiment encoded predicts lower volatility |
| iv_skew | price_return_15m | 15m | -0.0920 | 45.4% | Higher IV change predicts lower returns 15m later |
| liq_sentiment_encoded | price_volatility_1h | 30m | -0.0866 | 50.0% | Higher liq sentiment encoded predicts lower volatility |
| iv_change_15m | price_return_15m | 60m | 0.0532 | 49.0% | Higher IV change predicts higher returns 60m later |

---

## Detailed Findings

### IV as Predictor of Price Movement

**iv_percentile_all → price_volatility_1h**
- Best lag: 15 minutes
- Correlation: 0.3036
- Interpretation: Higher iv percentile all predicts higher volatility

**iv_percentile_all → price_range_15m**
- Best lag: 15 minutes
- Correlation: 0.2355
- Interpretation: Higher iv percentile all predicts higher volatility

**iv_skew → price_return_15m**
- Best lag: 15 minutes
- Correlation: -0.0920
- Interpretation: Higher IV change predicts lower returns 15m later

**iv_change_15m → price_return_15m**
- Best lag: 60 minutes
- Correlation: 0.0532
- Interpretation: Higher IV change predicts higher returns 60m later

### Liquidity as Predictor of Price Movement

**liq_max_change → price_volatility_1h**
- Best lag: 15 minutes
- Correlation: 0.1878
- Interpretation: Higher liq max change predicts higher volatility

**liq_max_change → price_range_15m**
- Best lag: 15 minutes
- Correlation: 0.1689
- Interpretation: Higher liq max change predicts higher volatility

**liq_sentiment_encoded → price_range_15m**
- Best lag: 15 minutes
- Correlation: -0.1010
- Interpretation: Higher liq sentiment encoded predicts lower volatility

**liq_sentiment_encoded → price_volatility_1h**
- Best lag: 30 minutes
- Correlation: -0.0866
- Interpretation: Higher liq sentiment encoded predicts lower volatility

### GEX as Predictor of Price Movement

**gex_regime_encoded → price_volatility_1h**
- Best lag: 15 minutes
- Correlation: -0.2557
- Interpretation: Higher gex regime encoded predicts lower volatility

**gex_regime_encoded → price_range_15m**
- Best lag: 15 minutes
- Correlation: -0.2514
- Interpretation: Higher gex regime encoded predicts lower volatility

**total_gex → price_range_15m**
- Best lag: 15 minutes
- Correlation: -0.2452
- Interpretation: Higher total gex predicts lower volatility

**total_gex → price_volatility_1h**
- Best lag: 15 minutes
- Correlation: -0.2171
- Interpretation: Higher total gex predicts lower volatility

**gex_dist_gamma_flip → price_range_15m**
- Best lag: 15 minutes
- Correlation: -0.1712
- Interpretation: Higher gex dist gamma flip predicts lower volatility

**gex_dist_gamma_flip → price_return_15m**
- Best lag: 15 minutes
- Correlation: -0.1693
- Interpretation: Positive GEX predicts downward price movement (mean reversion)

**gex_dist_gamma_flip → price_volatility_1h**
- Best lag: 240 minutes
- Correlation: -0.1683
- Interpretation: Higher gex dist gamma flip predicts lower volatility

---

## Lag Profile Analysis

Shows how correlation changes across different lags for key predictors:

### iv_percentile_all → price_volatility_1h

| Lag | Correlation | Significant |
|-----|-------------|-------------|
| 15m | 0.3036 | ✓ |
| 30m | 0.2977 | ✓ |
| 60m | 0.2869 | ✓ |
| 120m | 0.2677 | ✓ |
| 240m | 0.2659 | ✓ |

### gex_regime_encoded → price_volatility_1h

| Lag | Correlation | Significant |
|-----|-------------|-------------|
| 15m | -0.2557 | ✓ |
| 30m | -0.2509 | ✓ |
| 60m | -0.2335 | ✓ |
| 120m | -0.2206 | ✓ |
| 240m | -0.2060 | ✓ |

### gex_regime_encoded → price_range_15m

| Lag | Correlation | Significant |
|-----|-------------|-------------|
| 15m | -0.2514 | ✓ |
| 30m | -0.2452 | ✓ |
| 60m | -0.2365 | ✓ |
| 120m | -0.2273 | ✓ |
| 240m | -0.2192 | ✓ |

### total_gex → price_range_15m

| Lag | Correlation | Significant |
|-----|-------------|-------------|
| 15m | -0.2452 | ✓ |
| 30m | -0.2368 | ✓ |
| 60m | -0.2309 | ✓ |
| 120m | -0.2216 | ✓ |
| 240m | -0.2075 | ✓ |

### iv_percentile_all → price_range_15m

| Lag | Correlation | Significant |
|-----|-------------|-------------|
| 15m | 0.2355 | ✓ |
| 30m | 0.2324 | ✓ |
| 60m | 0.2219 | ✓ |
| 120m | 0.2134 | ✓ |
| 240m | 0.2044 | ✓ |


---

## Trading Implications

Based on the lead-lag analysis:

- **IV Expansion → Price Decline**: IV increases tend to precede price declines by 15 minutes. Consider this for timing short entries.
- **Volatility Prediction**: iv percentile all can predict future volatility with 15m lead time.

---

## Methodology

- **Lead-Lag Correlation**: Pearson correlation between predictor at time T and target at time T+lag
- **Hit Rate**: Percentage of times the sign of the predictor matches the sign of the future target
- **Significance Threshold**: p < 0.05 and |r| > 0.05
- **Data**: RTH (Regular Trading Hours) records with complete GEX and IV data

---

*Report generated by lead-lag-analysis.js*
