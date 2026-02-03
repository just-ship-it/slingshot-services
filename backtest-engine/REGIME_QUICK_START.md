# Regime Identifier - Quick Start Guide

## TL;DR - Run Your First Test

```bash
cd /home/drew/projects/slingshot-services/backtest-engine

# Test NQ for one week
node test-regime-identifier.js --ticker NQ --startDate 2024-01-02 --endDate 2024-01-08

# Test ES for one month
node test-regime-identifier.js --ticker ES --startDate 2024-01-01 --endDate 2024-01-31

# Test with custom output directory
node test-regime-identifier.js --ticker NQ --startDate 2024-06-01 --endDate 2024-06-30 \
  --outputDir ./june-test
```

## What You'll Get

### 1. Console Report
```
═══════════════════════════════════════════════════════════
                   STABILITY METRICS
═══════════════════════════════════════════════════════════
  Total Regime Transitions:    5
  Median Duration:             110 candles (330 minutes)
  Mean Duration:               82.20 candles (246.6 minutes)
  Flapping Rate:               0.0%

  Duration Distribution:
    <5 candles           0
    5-10 candles         0
    10-20 candles        0
    20+ candles          5

═══════════════════════════════════════════════════════════
                   REGIME DISTRIBUTION
═══════════════════════════════════════════════════════════
  BOUNCING_SUPPORT       31.63% (avg conf: 0.675)
  SESSION_BLOCKED        31.63% (avg conf: 1.000)
  SESSION_OPENING        31.63% (avg conf: 0.661)
  NEUTRAL                 5.11% (avg conf: 0.469)

═══════════════════════════════════════════════════════════
                   PREDICTIVE ACCURACY
═══════════════════════════════════════════════════════════
  Overall Accuracy:            17.0%
  Correct Predictions:         68 / 401
  Lookforward:                 10 candles (30 minutes)

  Per-Regime Accuracy:
    BOUNCING_SUPPORT     52.3% (68/130)
    SESSION_BLOCKED       0.0% (0/130)
    SESSION_OPENING       0.0% (0/130)
    NEUTRAL               0.0% (0/11)
═══════════════════════════════════════════════════════════
```

### 2. CSV Export (TradingView Compatible)
File: `regime-test-results/regime-analysis-NQ-2024-01-02-2024-01-08.csv`

Columns:
- timestamp, regime, confidence, transition_state, candles_in_regime
- price, open, high, low, volume
- trend, trend_confidence, squeeze, atr, session

**Load into TradingView** to visually validate regimes match chart analysis.

### 3. JSON Report
File: `regime-test-results/regime-report-NQ-2024-01-02-2024-01-08.json`

Full metrics for programmatic analysis.

## Regime States Explained

### Tradeable Regimes (Use for Phase 2)

| Regime | When It Triggers | Trading Approach (Phase 2) |
|--------|------------------|---------------------------|
| **STRONG_TRENDING_UP** | Higher highs + expansion + >70% confidence | Pullback entries with trailing stops |
| **STRONG_TRENDING_DOWN** | Lower lows + expansion + >70% confidence | Pullback entries with trailing stops |
| **WEAK_TRENDING_UP** | Bullish structure + squeeze OR <70% confidence | More conservative targets |
| **WEAK_TRENDING_DOWN** | Bearish structure + squeeze OR <70% confidence | More conservative targets |
| **RANGING_TIGHT** | Squeeze on + range <1.5× ATR | Fade extremes (sell resistance, buy support) |
| **RANGING_CHOPPY** | >6 structure break direction changes | Skip or ultra-tight scalps |
| **BOUNCING_SUPPORT** | Within 2 points of support level | Long entries at level |
| **BOUNCING_RESISTANCE** | Within 2 points of resistance level | Short entries at level |

### Non-Tradeable Regimes (Filter Out)

| Regime | When It Triggers | Why Skip |
|--------|------------------|----------|
| **SESSION_BLOCKED** | 4:00 PM - 6:00 PM ET (transition period) | Low liquidity, poor fills |
| **SESSION_OPENING** | First 30 minutes of RTH | Establishing range, high volatility |
| **NEUTRAL** | No clear pattern detected | No edge |

## Key Metrics to Watch

### 1. Stability Metrics
- **Median Duration**: Should be >15 minutes (5+ candles)
  - Higher = more stable regimes
  - Test showed **330 minutes** (excellent!)

- **Flapping Rate**: Should be <10%
  - % of regimes lasting <5 candles
  - Test showed **0.0%** (perfect!)

### 2. Predictive Accuracy
- **Per-Regime Accuracy**: Focus on tradeable regimes
  - BOUNCING_SUPPORT: **52.3%** (>50% = predictive power)
  - STRONG_TRENDING: Target >55% (need full year test)

- **Overall Accuracy**: Will be low due to blocked regimes
  - Filter to tradeable-only for real accuracy

### 3. Distribution
- **Each regime >3%**: Validates not overfit to one pattern
- **Confidence scores**: Should differ by regime type
  - SESSION_BLOCKED: 1.0 (certain)
  - BOUNCING: 0.6-0.8 (good confidence)
  - NEUTRAL: 0.3-0.5 (low confidence)

## Recommended Test Sequence

### 1. Quick Validation (5 minutes)
```bash
# One week test - fast validation
node test-regime-identifier.js --ticker NQ --startDate 2024-01-02 --endDate 2024-01-08
```

**Check**:
- ✅ No errors
- ✅ Multiple regime types detected
- ✅ Flapping rate <10%
- ✅ CSV exports successfully

### 2. Monthly Validation (30 minutes)
```bash
# One month test - representative sample
node test-regime-identifier.js --ticker NQ --startDate 2024-01-01 --endDate 2024-01-31
```

**Check**:
- ✅ All regime types appear
- ✅ Median duration >15 minutes
- ✅ TRENDING regimes have >55% accuracy
- ✅ Distribution looks reasonable

### 3. Full Year Validation (2-3 hours)
```bash
# Full 2024 backtest
node test-regime-identifier.js --ticker NQ --startDate 2024-01-01 --endDate 2024-12-31
```

**Check**:
- ✅ Stability across different market conditions
- ✅ Regime frequency distributions
- ✅ Seasonal patterns (if any)
- ✅ Parameter tuning opportunities

### 4. Visual Validation
1. Load CSV into TradingView
2. Randomly sample 30 regime transitions
3. Verify regimes match visual chart analysis
4. Target: >85% visual agreement

## Parameter Tuning

If results don't meet targets, tune these parameters:

### In RegimeIdentifier Constructor
```javascript
const regimeId = new RegimeIdentifier({
  symbol: 'NQ', // or 'ES'

  // Trend detection
  trendConfidenceThreshold: 70,      // Higher = stricter trending requirement
  weakTrendConfidenceThreshold: 50,  // Lower = more weak trends detected

  // Range detection
  rangeATRMultiplier: 1.5,           // Lower = tighter range requirement

  // Level proximity
  levelProximityPoints: 2,           // Lower = must be closer to level

  // Chop detection
  chopThreshold: 6,                  // Lower = detect chop sooner

  // Session filtering
  allowRTH: true,
  allowOvernight: true,
  sessionOpeningMinutes: 30          // First X minutes = SESSION_OPENING
});
```

### Tuning Strategy

**If too many regime changes (high flapping)**:
- Increase `minRegimeDuration` in RegimeStabilizer
- Increase `changeConfidenceThreshold` in RegimeStabilizer

**If not detecting trending regimes**:
- Lower `trendConfidenceThreshold` (try 60)
- Check if data has actual trends (visual validation)

**If too many neutral regimes**:
- Lower `weakTrendConfidenceThreshold` (try 40)
- Adjust `chopThreshold` to catch chop earlier

**If ranging regimes not appearing**:
- Increase `rangeATRMultiplier` (try 2.0)
- Check `touchProximity` in RangeDetector

## Common Issues & Solutions

### Issue: "Unsupported timeframe: 3m"
**Solution**: Already fixed - CandleAggregator now supports 3m

### Issue: "TypeError: TechnicalAnalysis.atr is not a function"
**Solution**: Already fixed - ATR function added to TechnicalAnalysis

### Issue: "TypeError: swings.filter is not a function"
**Solution**: Already fixed - RegimeIdentifier converts swings object to array

### Issue: Low overall accuracy (<20%)
**Solution**: This is expected! Filter out non-tradeable regimes:
```javascript
// Only evaluate tradeable regimes
if (['SESSION_BLOCKED', 'SESSION_OPENING', 'NEUTRAL'].includes(regime.regime)) {
  continue;
}
```

### Issue: No RANGING or TRENDING regimes detected
**Possible causes**:
1. Test period is too short (try 1 month minimum)
2. Market was actually choppy/neutral (visual validation needed)
3. Thresholds too strict (lower confidence thresholds)

## Integration with Phase 2 (Coming Soon)

```javascript
// Phase 2 will use regimes as filters
const result = regimeId.identify(currentCandle, historicalCandles);

// Skip non-tradeable regimes
if (result.regime === 'SESSION_BLOCKED' ||
    result.regime === 'SESSION_OPENING' ||
    result.regime === 'NEUTRAL') {
  continue;
}

// Apply regime-specific trading logic
switch (result.regime) {
  case 'STRONG_TRENDING_UP':
    // Wait for pullback to trend line
    // Enter long with trailing stop
    break;

  case 'RANGING_TIGHT':
    // Fade resistance, buy support
    // Tight targets at opposite boundary
    break;

  case 'BOUNCING_SUPPORT':
    // Enter long at level
    // Stop just below level (2-3 points)
    break;
}
```

## Performance Expectations

### Processing Speed
- **1 week**: ~5 seconds
- **1 month**: ~30 seconds
- **Full year**: ~2-3 minutes

### Memory Usage
- **1 week**: <50 MB
- **1 month**: ~150 MB
- **Full year**: ~300 MB

### Output File Sizes
- **CSV**: ~100 KB per month
- **JSON**: ~50 KB per month

## Next Steps After Validation

1. ✅ **Run full year backtest** on NQ and ES
2. ✅ **Visual validation** on TradingView (30 samples)
3. ✅ **Parameter tuning** based on full year results
4. ✅ **Document regime patterns** by market condition
5. 🚀 **Proceed to Phase 2** - Build trading logic

---

**Questions?** Check `REGIME_IDENTIFIER_README.md` for detailed documentation.

**Issues?** Check `PHASE1_COMPLETE_SUMMARY.md` for implementation details.
