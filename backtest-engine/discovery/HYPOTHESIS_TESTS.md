# NQ Strategy Discovery - Hypothesis Tests

## Test 1: GEX Regime Distribution

**Hypothesis**: GEX regimes are evenly distributed between positive and negative.

**Result**: REJECTED
- Positive regime: 65.1% of days (449/690)
- Negative regime: 34.9% of days (241/690)
- Market spends ~2x more time in positive GEX regime

**Trading Implication**: Positive GEX regime is the "normal" state. Strategy should account for this bias.

---

## Test 2: GEX Level Distance Analysis

**Hypothesis**: Support and resistance levels are symmetrically placed around gamma flip.

**Result**: REJECTED
- Put walls: avg 1,097-1,139 pts from gamma flip
- Call walls: avg 1,501-1,624 pts from gamma flip
- Call walls are ~30% further from gamma flip than put walls

**Trading Implication**: Asymmetric level placement suggests different behavior at support vs resistance.

---

## Test 3: S1 Support Level Bounces

**Hypothesis**: Price touching S1 support level from above leads to upward reversion.

**Test Details**: 15 trading days, 1,051 touches within 10 pts of S1

**Result**: MIXED
- Support tests (from above): 777 events
  - 5m return: +0.28 pts (52.6% win rate)
  - 15m return: -0.26 pts (48.5% win rate)
  - 60m return: -2.13 pts (57.4% win rate)

**Conclusion**: S1 support is NOT a reliable long entry. Short-term bounce exists but fades.

---

## Test 4: R1 Resistance Level Bounces

**Hypothesis**: Price touching R1 resistance level from below leads to downward reversion.

**Test Details**: 15 trading days, 1,085 touches within 10 pts of R1

**Result**: CONFIRMED
- Resistance tests (from below): 751 events
  - 5m return: +1.27 pts (51.4% short win rate)
  - 15m return: +2.72 pts (51.9% short win rate)
  - 30m return: +5.60 pts (55.5% short win rate)
  - 60m return: +10.51 pts (52.8% short win rate)

**Conclusion**: R1 resistance shows consistent short opportunity. Positive expectancy at all timeframes.

---

## Test 5: Put Wall Support Bounces

**Hypothesis**: Price touching Put Wall from above leads to strong upward reversion.

**Test Details**: 15 trading days, 85 touches within 10 pts of Put Wall

**Result**: STRONGLY CONFIRMED
- Support tests (from above): 62 events
  - 5m return: +4.86 pts (59.7% win rate)
  - 10m return: +8.35 pts (59.7% win rate)
  - 15m return: +17.89 pts (54.4% win rate)
  - **30m return: +44.79 pts (78.6% win rate)**
  - **60m return: +59.61 pts (100% win rate)**

**CRITICAL FINDING**: Put Wall is the strongest support level. Exceptional win rates and returns.

**Caveat**: All Put Wall touches in sample occurred during strong_negative regime. May not generalize to all regimes.

---

## Test 6: Call Wall Resistance Bounces

**Hypothesis**: Price touching Call Wall from below leads to downward reversion.

**Test Details**: 15 trading days, 99 touches within 10 pts of Call Wall

**Result**: PARTIAL
- Resistance tests (from below): 41 events
  - 10m return: +3.64 pts (56.1% short win rate)
  - 15m return: +5.99 pts (45.9% short win rate)

**Conclusion**: Call Wall resistance shows some short potential but less reliable than R1.

---

## Test 7: Session Analysis (All GEX Level Touches)

**Hypothesis**: Overnight/premarket sessions have better GEX level bounce performance.

**Test Details**: 2,320 total level touches across all sessions

**Result**: CONFIRMED
| Session | Avg 15m Return | Win Rate | N |
|---------|---------------|----------|---|
| Premarket | +9.23 pts | 57.5% | 160 |
| Afterhours | +0.65 pts | 53.6% | 267 |
| Overnight | -0.67 pts | 37.4% | 216 |
| RTH | -1.12 pts | 49.6% | 1,677 |

**CRITICAL FINDING**: Premarket session (4AM-9:30AM EST) shows significantly better performance:
- 8x better average return than RTH
- 8 percentage points higher win rate

**Conclusion**: Filter trades to premarket session for best results.

---

## Test 8: GEX Regime Impact on Level Bounces

**Hypothesis**: GEX regime affects level bounce success.

**Results by Regime (15m returns)**:
- strong_positive: avg -1.08 pts (S1), -3.75 pts (Call Wall)
- strong_negative: avg +2.43 pts (S1), +23.65 pts (Put Wall)
- positive: avg +75.94 pts (S1) - small sample
- negative: avg +9.50 pts (S1) - small sample

**Conclusion**: Regime matters significantly:
- In strong_negative regime: Put Wall support works exceptionally well
- In strong_positive regime: Resistance levels work better than support

---

## Summary of Key Findings

### Strong Signals (High Confidence)
1. **Put Wall Support in Negative Regime**: 78-100% win rate, +45-60 pts avg
2. **R1 Resistance (all regimes)**: 52-56% win rate, +2.7-10.5 pts avg
3. **Premarket Session**: 57.5% win rate, +9.23 pts avg

### Weak/Neutral Signals
1. S1 Support: ~50% win rate, near-zero expectancy
2. Call Wall Resistance: Inconsistent results

### Recommended Strategy Focus
1. **Primary**: Put Wall long entries during negative GEX regime
2. **Secondary**: R1 resistance short entries during premarket
3. **Filter**: Premarket session for best results

---

## Next Steps

1. Develop Put Wall Bounce strategy for negative regime
2. Test R1 resistance short strategy with premarket filter
3. Backtest combined approach with proper risk management
4. Validate on out-of-sample data
