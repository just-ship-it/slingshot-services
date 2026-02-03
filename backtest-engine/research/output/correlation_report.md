# Correlation Analysis Report

**Generated**: 2026-01-21T06:04:34.359Z
**Analysis Period**: 2025-01-13 to 2025-12-24
**Total Records**: 22,630
**RTH Records (with GEX/IV)**: 5,700

---

## Executive Summary

Analyzed 171 variable pairs across price, GEX, IV, and liquidity data.
Found **59 statistically significant correlations** (p < 0.05, |r| > 0.15).

---

## Top Correlation Findings

| Rank | Variable 1 | Variable 2 | Pearson r | Strength | Direction | p-value | n |
|------|------------|------------|-----------|----------|-----------|---------|---|
| 1 | gex_regime_encoded | total_gex | 0.8607 | strong | positive | 0.0000 | 5700 |
| 2 | iv | iv_percentile_all | 0.8186 | strong | positive | 0.0000 | 5700 |
| 3 | gex_dist_support_1 | gex_dist_resistance_1 | -0.6771 | strong | negative | 0.0000 | 5700 |
| 4 | iv | liq_spacing_avg | 0.6530 | strong | positive | 0.0000 | 5700 |
| 5 | gex_dist_gamma_flip | total_gex | 0.5851 | strong | positive | 0.0000 | 5700 |
| 6 | iv_percentile_all | liq_spacing_avg | 0.5125 | strong | positive | 0.0000 | 5700 |
| 7 | price_return_15m | price_return_1h | 0.5045 | strong | positive | 0.0000 | 5700 |
| 8 | gex_dist_gamma_flip | gex_regime_encoded | 0.4859 | moderate | positive | 0.0000 | 5700 |
| 9 | total_gex | iv_percentile_all | -0.4690 | moderate | negative | 0.0000 | 5700 |
| 10 | gex_regime_encoded | iv_percentile_all | -0.4632 | moderate | negative | 0.0000 | 5700 |
| 11 | gex_dist_gamma_flip | gex_dist_resistance_1 | -0.4585 | moderate | negative | 0.0000 | 5700 |
| 12 | total_gex | iv | -0.4121 | moderate | negative | 0.0000 | 5700 |
| 13 | price_return_15m | gex_dist_resistance_1 | -0.4113 | moderate | negative | 0.0000 | 5700 |
| 14 | gex_regime_encoded | iv | -0.4108 | moderate | negative | 0.0000 | 5700 |
| 15 | price_return_15m | gex_dist_support_1 | 0.3906 | moderate | positive | 0.0000 | 5700 |
| 16 | gex_dist_gamma_flip | gex_dist_support_1 | 0.3860 | moderate | positive | 0.0000 | 5700 |
| 17 | price_range_15m | price_volatility_1h | 0.3788 | moderate | positive | 0.0000 | 5700 |
| 18 | liq_max_change | liq_dist_nearest | 0.3482 | moderate | positive | 0.0000 | 5700 |
| 19 | price_volatility_1h | iv | 0.3365 | moderate | positive | 0.0000 | 5700 |
| 20 | price_return_1h | gex_dist_resistance_1 | -0.3363 | moderate | negative | 0.0000 | 5700 |
| 21 | liq_spacing_avg | liq_max_change | 0.3328 | moderate | positive | 0.0000 | 5700 |
| 22 | total_gex | liq_sentiment_encoded | 0.3304 | moderate | positive | 0.0000 | 5700 |
| 23 | price_return_1h | gex_dist_support_1 | 0.3198 | moderate | positive | 0.0000 | 5700 |
| 24 | gex_dist_gamma_flip | iv | -0.3188 | moderate | negative | 0.0000 | 5700 |
| 25 | iv | liq_max_change | 0.3102 | moderate | positive | 0.0000 | 5700 |
| 26 | price_volatility_1h | iv_percentile_all | 0.3076 | moderate | positive | 0.0000 | 5700 |
| 27 | gex_regime_encoded | liq_spacing_avg | -0.2884 | weak | negative | 0.0000 | 5700 |
| 28 | price_return_15m | iv_skew | -0.2878 | weak | negative | 0.0000 | 5696 |
| 29 | gex_regime_encoded | liq_sentiment_encoded | 0.2858 | weak | positive | 0.0000 | 5700 |
| 30 | total_gex | liq_spacing_avg | -0.2856 | weak | negative | 0.0000 | 5700 |

---

## Key Insights

### Price-GEX Relationships
- **price_return_15m** vs **gex_dist_resistance_1**: negative moderate correlation (r=-0.411)
- **price_return_15m** vs **gex_dist_support_1**: positive moderate correlation (r=0.391)
- **price_return_1h** vs **gex_dist_resistance_1**: negative moderate correlation (r=-0.336)
- **price_return_1h** vs **gex_dist_support_1**: positive moderate correlation (r=0.320)

### Price-IV Relationships
- **price_volatility_1h** vs **iv**: positive moderate correlation (r=0.337)
- **price_volatility_1h** vs **iv_percentile_all**: positive moderate correlation (r=0.308)
- **price_return_15m** vs **iv_skew**: negative weak correlation (r=-0.288)

### Price-Liquidity Relationships
- No significant price-liquidity correlations found

### GEX-IV Relationships
- **total_gex** vs **iv_percentile_all**: negative moderate correlation (r=-0.469)
- **gex_regime_encoded** vs **iv_percentile_all**: negative moderate correlation (r=-0.463)
- **total_gex** vs **iv**: negative moderate correlation (r=-0.412)
- **gex_regime_encoded** vs **iv**: negative moderate correlation (r=-0.411)
- **gex_dist_gamma_flip** vs **iv**: negative moderate correlation (r=-0.319)

---

## Variables Analyzed

### Price Features
- `price_return_15m`
- `price_return_1h`
- `price_range_15m`
- `price_volatility_1h`

### GEX Features
- `gex_dist_gamma_flip`
- `gex_dist_support_1`
- `gex_dist_resistance_1`
- `gex_regime_encoded`
- `total_gex`

### IV Features
- `iv`
- `iv_skew`
- `iv_change_15m`
- `iv_percentile_all`

### Liquidity Features
- `liq_sentiment_encoded`
- `liq_spacing_avg`
- `liq_momentum`
- `liq_max_change`
- `liq_dist_nearest`

---

## Methodology

- **Pearson Correlation**: Measures linear relationship between variables
- **Spearman Correlation**: Measures monotonic relationship (rank-based)
- **Significance Threshold**: p < 0.05
- **Minimum Correlation**: |r| > 0.15 for inclusion in findings
- **Data Filter**: RTH (Regular Trading Hours) records only, where all data sources are available

---

*Report generated by correlation-analysis.js*
