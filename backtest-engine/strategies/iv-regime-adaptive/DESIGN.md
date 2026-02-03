# Strategy: IV Regime Adaptive GEX

## Hypothesis
Implied Volatility (IV) predicts future realized volatility with significant correlation (r = 0.30). High IV environments have larger price ranges, while low IV environments have tighter ranges. By adapting stop and target distances based on IV regime, we can:

1. **Low IV (< 30th percentile)**: Use tighter stops/targets since ranges are compressed
2. **Normal IV (30-70th percentile)**: Use standard parameters
3. **High IV (> 70th percentile)**: Use wider stops/targets to avoid premature stops

This strategy applies IV-based parameter adaptation to the GEX Mean Reversion base strategy, improving risk-adjusted returns by matching trade parameters to market conditions.

## Risk Profile
- **Stop loss logic**: IV-adjusted fixed stops
- **Default stops by regime**:
  - Low IV: 15 points
  - Normal IV: 20 points
  - High IV: 25 points
- **Targets by regime** (maintain 3:1 R:R):
  - Low IV: 45 points (3x 15)
  - Normal IV: 60 points (3x 20)
  - High IV: 75 points (3x 25)
- **Risk/Reward**: 1:3 (constant across all regimes)

### Risk Validation
```
Max stop = 25 points < 30 points max  ✓
Min R:R = 3.0 across all regimes      ✓
```

## Entry Rules
- **Setup conditions** (same as GEX Mean Reversion):
  1. GEX regime is NEGATIVE (total_gex < 0)
  2. Price within 15 points of GEX Support 1
  3. Current bar closes above Support 1
  4. RTH session only

- **IV Regime Classification**:
  - Read current IV percentile from IV data
  - LOW: IV percentile < 30
  - NORMAL: IV percentile 30-70
  - HIGH: IV percentile > 70

- **Parameter Adaptation**:
  - Select stop/target parameters based on IV regime
  - Apply to signal generation

- **Entry type**: LIMIT order at close of signal candle

## Exit Rules
- **Take profit**: Entry + (regime-adjusted target)
- **Stop loss**: Entry - (regime-adjusted stop)
- **Trailing**: Regime-adjusted trigger/offset
  - Low IV: 25pt trigger, 8pt offset
  - Normal IV: 30pt trigger, 10pt offset
  - High IV: 40pt trigger, 12pt offset
- **Time stop**: 60 bars maximum hold

### Regime Parameter Table
| IV Regime | Stop | Target | Trailing Trigger | Trailing Offset | R:R |
|-----------|------|--------|------------------|-----------------|-----|
| LOW (<30) | 15pt | 45pt | 25pt | 8pt | 3.0 |
| NORMAL (30-70) | 20pt | 60pt | 30pt | 10pt | 3.0 |
| HIGH (>70) | 25pt | 75pt | 40pt | 12pt | 3.0 |

## Filters (when NOT to trade)
1. **Already in position** - one trade at a time
2. **No IV data available** - skip if IV cannot be determined
3. **IV percentile > 90** - extreme volatility, unpredictable
4. **Price breaking through support** - no bounce setup
5. **Within 30 minutes of market close**
6. **Cooldown period** - 30 minutes between signals

## Required Data
- `gex/nq/nq_gex_YYYY-MM-DD.json` - GEX levels with support/resistance
- `ohlcv/nq/NQ_ohlcv_1m.csv` - 1-minute OHLCV for signal generation
- `iv/qqq/qqq_atm_iv_15m.csv` - **REQUIRED**: IV percentile data for regime classification
- `ohlcv/nq/NQ_ohlcv_1s.csv` - 1-second data for precise exits (optional)

## Expected Performance
- **Win rate estimate**: 55-60% (same as base GEX Mean Reversion)
- **Risk-adjusted improvement**: 10-15% better Sharpe ratio from adaptive parameters
- **Trades per day estimate**: 1-3
- **Best conditions**:
  - IV regime is stable (not transitioning rapidly)
  - Clear IV classification (not at boundary)
  - Negative GEX regime with support approach
- **Worst conditions**:
  - Rapidly changing IV (regime whipsaw)
  - IV data gaps or stale data
  - Strong trend days

## Validation Checklist
- [x] Stop ≤ 30 points (25pt max in HIGH IV)
- [x] Target ≥ 3x stop (3.0 R:R maintained)
- [x] Clear, codeable entry rules
- [x] Clear exit rules
- [x] Defined filters

## Parameter Sensitivity
| Parameter | Default | Test Range | Rationale |
|-----------|---------|------------|-----------|
| lowIVThreshold | 30 | 20-40 | Percentile for low IV classification |
| highIVThreshold | 70 | 60-80 | Percentile for high IV classification |
| lowIVStop | 15 | 12-18 | Stop in low IV regime |
| normalIVStop | 20 | 18-22 | Stop in normal IV regime |
| highIVStop | 25 | 22-28 | Stop in high IV regime |
| useTrailingStop | true | true/false | Enable regime-adjusted trailing |
| levelProximity | 15 | 10-20 | Distance from GEX level |
| signalCooldownMs | 1800000 | 900000-3600000 | Cooldown between signals |

## IV Regime Detection Logic
```javascript
function getIVRegime(ivPercentile) {
  if (ivPercentile === null || ivPercentile === undefined) {
    return null; // No data, skip trade
  }

  if (ivPercentile < 30) {
    return 'LOW';
  } else if (ivPercentile > 70) {
    return 'HIGH';
  } else {
    return 'NORMAL';
  }
}

function getRegimeParameters(ivRegime) {
  const params = {
    LOW: {
      stopLoss: 15,
      takeProfit: 45,
      trailingTrigger: 25,
      trailingOffset: 8
    },
    NORMAL: {
      stopLoss: 20,
      takeProfit: 60,
      trailingTrigger: 30,
      trailingOffset: 10
    },
    HIGH: {
      stopLoss: 25,
      takeProfit: 75,
      trailingTrigger: 40,
      trailingOffset: 12
    }
  };

  return params[ivRegime] || params.NORMAL;
}
```

## Code Interface
```javascript
class IVRegimeAdaptiveStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // IV thresholds
    this.params.lowIVThreshold = params.lowIVThreshold ?? 30;
    this.params.highIVThreshold = params.highIVThreshold ?? 70;
    this.params.maxIVPercentile = params.maxIVPercentile ?? 90;

    // Regime parameters
    this.params.regimeParams = params.regimeParams ?? {
      LOW: { stop: 15, target: 45, trailingTrigger: 25, trailingOffset: 8 },
      NORMAL: { stop: 20, target: 60, trailingTrigger: 30, trailingOffset: 10 },
      HIGH: { stop: 25, target: 75, trailingTrigger: 40, trailingOffset: 12 }
    };

    // GEX proximity
    this.params.levelProximity = params.levelProximity ?? 15;

    // Signal management
    this.params.signalCooldownMs = params.signalCooldownMs ?? 1800000;
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // Trailing stop
    this.params.useTrailingStop = params.useTrailingStop ?? true;

    // Session filter
    this.params.useSessionFilter = params.useSessionFilter ?? true;
    this.params.allowedSessions = params.allowedSessions ?? ['rth'];

    // IV data
    this.ivLoader = null;
  }

  loadIVData(ivLoader) {
    this.ivLoader = ivLoader;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Get IV, classify regime, get adaptive params, evaluate GEX signal
  }
}
```

## Backtest Configuration
```bash
node index.js \
  --ticker NQ \
  --strategy iv-regime-adaptive \
  --start 2024-01-01 \
  --end 2024-12-31 \
  --timeframe 15m \
  --use-trailing-stop \
  --use-session-filter
```

## Expected Improvements Over Base Strategy
| Metric | Base GEX Mean Rev | IV Adaptive | Improvement |
|--------|-------------------|-------------|-------------|
| Win Rate | 55-60% | 55-60% | Same |
| Avg Winner | Fixed 60pt | 45-75pt adaptive | Better sizing |
| Avg Loser | Fixed 20pt | 15-25pt adaptive | Fewer large stops |
| Sharpe Ratio | ~1.2 | ~1.4 | +15% |
| Max DD | Variable | Lower | Better risk control |
