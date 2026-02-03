# Regime Identifier - Phase 1 Implementation

## Overview

The Regime Identifier is an aggressive scalping strategy component that classifies market conditions into actionable trading regimes. This Phase 1 implementation focuses on accurate regime detection with anti-flapping mechanisms to prevent signal noise.

## Architecture

### Core Components

#### 1. RegimeStabilizer (`/shared/indicators/regime-stabilizer.js`)
**Purpose**: Prevents regime flapping using multi-tier confirmation

**Features**:
- **Hysteresis**: Different confidence thresholds for regime changes (0.7) vs maintaining (0.5)
- **Minimum Duration**: Locks regime for 5 candles before allowing change
- **Historical Consensus**: Requires 60% agreement over 20-candle window
- **Transition States**:
  - `stable` - Regime is solid
  - `uncertain` - Low confidence
  - `locked` - Minimum duration not met
  - `transition` - Regime just changed

#### 2. SessionFilter (`/shared/indicators/session-filter.js`)
**Purpose**: Filters trading sessions and manages indicator resets

**Allowed Sessions**:
- **RTH**: 9:30 AM - 4:00 PM ET (14:30 - 21:00 UTC)
- **Overnight**: 6:00 PM - 9:30 AM ET (23:00 - 14:30 UTC)
- **Blocked**: 4:00 PM - 6:00 PM ET (transition period, low liquidity)

**Features**:
- Session boundary detection
- Automatic indicator reset on session changes
- Minutes-into-session calculation

#### 3. TrendLineDetector (`/shared/indicators/trend-line-detector.js`)
**Purpose**: Calculates trend lines using linear regression

**Features**:
- Upper/lower trend line detection from swing points
- Slope calculation using linear regression
- R² validation (minimum 0.5 correlation)
- Distance to trend line measurement
- Trend line break detection

#### 4. RangeDetector (`/shared/indicators/range-detector.js`)
**Purpose**: Identifies ranging markets with support/resistance boundaries

**Validation Criteria**:
- Minimum 2 touches per boundary
- Range width < 1.5 × ATR (configurable)
- Minimal breakouts (≤1 false breakout allowed)
- Volume profile confirmation at boundaries

**Features**:
- Swing high/low boundary identification
- Touch counting with proximity threshold
- Range position calculation (0 = support, 1 = resistance)
- Confidence scoring

#### 5. RegimeIdentifier (`/shared/indicators/regime-identifier.js`)
**Purpose**: Main regime classifier combining all indicators

**Regime States**:
1. **STRONG_TRENDING_UP**: Higher highs + expansion + high confidence (>70%)
2. **STRONG_TRENDING_DOWN**: Lower lows + expansion + high confidence (>70%)
3. **WEAK_TRENDING_UP**: Bullish structure + squeeze or lower confidence
4. **WEAK_TRENDING_DOWN**: Bearish structure + squeeze or lower confidence
5. **RANGING_TIGHT**: Squeeze on + valid range < 1.5 × ATR
6. **RANGING_CHOPPY**: Multiple structure breaks (>6 direction changes)
7. **BOUNCING_SUPPORT**: Near support level (within 2 points)
8. **BOUNCING_RESISTANCE**: Near resistance level (within 2 points)
9. **SESSION_OPENING**: First 30 minutes of RTH
10. **NEUTRAL**: No clear regime detected
11. **SESSION_BLOCKED**: Filtered session (transition period)

**Indicator Dependencies**:
- `MarketStructureAnalyzer` - Trend structure, swing detection
- `SqueezeMomentumIndicator` - Volatility state (squeeze vs expansion)
- `MomentumDivergenceDetector` - Reversal signals (future use)
- `TrendLineDetector` - Trend line support/resistance
- `RangeDetector` - Range validation
- `RegimeStabilizer` - Anti-flapping mechanism
- `SessionFilter` - Session filtering

### Symbol-Specific Parameters

**NQ (Nasdaq E-mini)**:
```javascript
{
  initialStopPoints: 20,        // $400 risk at $20/point
  profitProtectionPoints: 5,
  tickSize: 0.25,
  pointValue: 20,
  rangeATRMultiplier: 1.5,
  levelProximityPoints: 2,
  chopThreshold: 6
}
```

**ES (S&P E-mini)**:
```javascript
{
  initialStopPoints: 8,         // $400 risk at $50/point
  profitProtectionPoints: 2,
  tickSize: 0.25,
  pointValue: 50,
  rangeATRMultiplier: 1.2,      // Tighter ranges
  levelProximityPoints: 1,       // Closer proximity
  chopThreshold: 5
}
```

## Data Pipeline

### 1-Second OHLCV Support

**New Methods in CSVLoader**:
- `load1SecondOHLCVData(ticker, startDate, endDate)` - Load 1-second data
- `get1SecondFilePath(ticker)` - Find 1-second CSV file

**File Naming Convention**:
```
ohlcv/{ticker}/{TICKER}_ohlcv_1s.csv
```

**Critical Filtering**:
1. **Calendar Spread Filtering**: Exclude symbols containing "-"
2. **Primary Contract Filtering**: Use `filterPrimaryContract()` to avoid rollover whipsaws
3. **Corrupted Candle Filtering**: Remove single-tick anomalies

### Timeframe Aggregation

The existing `CandleAggregator` supports aggregating from any timeframe:
```javascript
const aggregator = new CandleAggregator();
const candles3m = aggregator.aggregate(candles1s, '3m');
```

**Strategy**:
- Use 3-minute aggregated candles for regime detection
- Use 1-second data for precise entry/exit fills (Phase 2)

## Testing Framework

### Test Harness (`test-regime-identifier.js`)

**Usage**:
```bash
cd backtest-engine

# Test NQ on 1-minute data (faster for testing)
node test-regime-identifier.js --ticker NQ --startDate 2024-01-01 --endDate 2024-12-31

# Test ES on 1-second data with 3-minute aggregation
node test-regime-identifier.js --ticker ES --startDate 2024-01-01 --endDate 2024-12-31 \
  --resolution 1s --aggregateTo 3m

# Custom output directory
node test-regime-identifier.js --ticker NQ --startDate 2024-06-01 --endDate 2024-06-30 \
  --outputDir ./june-test
```

**Outputs**:
1. **CSV Export**: `regime-analysis-{ticker}-{start}-{end}.csv`
   - Timestamp, regime, confidence, price, OHLC, metadata
   - TradingView compatible for visual validation

2. **JSON Report**: `regime-report-{ticker}-{start}-{end}.json`
   - Stability metrics
   - Distribution analysis
   - Predictive accuracy by regime

### Metrics Calculated

#### 1. Stability Metrics
- **Median Duration**: Median regime duration in candles and minutes
- **Mean Duration**: Average regime duration
- **Flapping Rate**: % of regimes lasting <5 candles (target: <10%)
- **Duration Distribution**: Histogram of regime durations

#### 2. Distribution Analysis
- **Regime Frequency**: Count and percentage for each regime
- **Average Confidence**: Mean confidence score per regime
- Validates each regime appears in >3% of dataset (not overfit)

#### 3. Predictive Accuracy
- **Overall Accuracy**: % of regimes that correctly predict next N candles
- **Per-Regime Accuracy**: Breakdown by regime type
- **Lookforward Window**: Default 10 candles (configurable)

**Prediction Logic**:
- STRONG_TRENDING_UP: Next N candles move up
- STRONG_TRENDING_DOWN: Next N candles move down
- RANGING: Net move < 0.5 × ATR
- BOUNCING_SUPPORT: Bounce upward
- BOUNCING_RESISTANCE: Bounce downward

## Usage Example

### Basic Usage

```javascript
import { RegimeIdentifier } from '../shared/indicators/regime-identifier.js';

// Initialize for NQ
const regimeId = new RegimeIdentifier({
  symbol: 'NQ'
});

// Process each candle
for (let i = 50; i < candles.length; i++) {
  const historical = candles.slice(Math.max(0, i - 50), i + 1);
  const current = candles[i];

  const result = regimeId.identify(current, historical);

  console.log(`Regime: ${result.regime}`);
  console.log(`Confidence: ${result.confidence}`);
  console.log(`Transition: ${result.transitionState}`);
  console.log(`Metadata:`, result.metadata);
}
```

### Advanced Usage with Session Filtering

```javascript
const regimeId = new RegimeIdentifier({
  symbol: 'NQ',
  allowRTH: true,
  allowOvernight: true,
  allowPremarket: false,
  allowAftermarket: false
});

// Process candles
const result = regimeId.identify(currentCandle, historicalCandles);

// Check if session blocked
if (result.regime === 'SESSION_BLOCKED') {
  console.log(`Session blocked: ${result.metadata.session}`);
  continue;
}

// Use regime for trading logic
if (result.regime === 'STRONG_TRENDING_UP' && result.confidence > 0.8) {
  // Enter long position logic
}
```

## Validation Criteria

### Acceptance Criteria

✅ **Functionality**:
- Runs without errors on full 2024 dataset (NQ and ES)
- Processes 3-minute candles at acceptable speed (<5 min/year)
- Session filtering correctly excludes transition periods
- Symbol-specific parameters applied correctly

✅ **Stability** (Anti-Flapping):
- Median regime duration: >15 minutes (5+ candles)
- Flapping rate: <10% of transitions
- No rapid oscillations visible in timeline

✅ **Accuracy** (Visual + Predictive):
- Manual chart verification: >85% visual agreement
- Predictive power: >55% accuracy for trending regimes (10-candle lookforward)
- Confidence scores correlate with indicator alignment

✅ **Distribution**:
- Each regime appears in >3% of dataset
- RANGING regimes appear during known consolidation
- TRENDING regimes appear during known breakouts

✅ **Edge Cases**:
- Contract rollovers: No false signals at rollover dates
- Market opens: 30-minute warmup period enforced
- Extreme volatility: High ATR events don't cause flapping
- Low liquidity: Transition periods correctly filtered

## Performance Targets

| Metric | Target | Importance |
|--------|--------|------------|
| Median Duration | >15 minutes | Prevents overtrading |
| Flapping Rate | <10% | Clean transitions |
| Trending Accuracy | >55% | Validates predictive power |
| Processing Speed | <5 min/year | Fast iteration |
| Visual Agreement | >85% | Matches human intuition |

## Next Steps (Phase 2)

Once Phase 1 regime identifier is validated:

### 1. Pattern-Specific Trading Logic

**STRONG_TRENDING**: Pullback entries with trailing stops
- Enter on pullback to trend line (3-5 point buffer)
- Stop below recent swing low (1.5× ATR max)
- Trail aggressively after profit protection threshold

**RANGING_TIGHT**: Fade the extremes
- Sell resistance, buy support with limit orders
- Stop just outside range (2-3 points)
- Target opposite boundary

**BOUNCING**: Level bounce entries
- Enter at key levels with tight stops
- Target opposite level or recent swing
- Early trailing activation (50% of profit protection)

**AVOID**: RANGING_CHOPPY, NEUTRAL, SESSION_BLOCKED

### 2. 1-Second Exit Monitoring

- Monitor stops with 1-second precision
- Update trailing stops every second
- Accurate slippage simulation

### 3. Risk Management

- Position sizing: 1 contract
- Risk per trade: $400 (20 points NQ, 8 points ES)
- Re-entry logic after stops
- Max hold time per regime

## File Structure

```
/shared/indicators/
  ├── regime-stabilizer.js          # Anti-flapping mechanism
  ├── regime-identifier.js          # Main regime classifier
  ├── session-filter.js             # Session filtering
  ├── trend-line-detector.js        # Trend line calculation
  ├── range-detector.js             # Range validation
  ├── market-structure.js           # [Existing] Swing detection
  ├── squeeze-momentum.js           # [Existing] Volatility state
  └── momentum-divergence.js        # [Existing] Divergence detection

/backtest-engine/
  ├── test-regime-identifier.js     # Test harness
  └── src/data/
      └── csv-loader.js             # [Modified] 1-second support
```

## Key Innovation: Hierarchical Architecture

Unlike simple indicator-based strategies:

1. **Macro Context** (3-minute regimes): Filters structural conditions
2. **Micro Timing** (1-second precision): Entry/exit execution
3. **Stability Layer** (anti-flapping): Prevents whipsaw signals
4. **Multi-Symbol Support** (NQ/ES): Proportional risk management

## Risk Mitigation

**Phase 1 De-Risks Phase 2**:
- Validate regime accuracy BEFORE building trades
- Tune thresholds on historical data
- Identify which regimes have predictive power
- Measure stability before going live

**Fallback Plan**:
If complex regime system proves unstable:
- Simplify to 3-4 basic regimes (trend up/down, range, chop)
- Use simpler price-action-only classification
- Focus on highest-confidence patterns only
