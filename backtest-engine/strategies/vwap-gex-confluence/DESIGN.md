# Strategy: VWAP + GEX Confluence

## Hypothesis
VWAP (Volume-Weighted Average Price) represents institutional fair value for the day. Price trading below VWAP indicates sellers are in control and the market is "cheap" relative to average transaction prices. When price is below VWAP AND near a GEX support level:

1. **Value position**: Price is below institutional fair value (discounted)
2. **Structural support**: GEX hedging flows provide mechanical support
3. **Mean reversion potential**: Two independent forces pushing for upward reversion

Combining VWAP position with GEX levels creates a higher probability entry than either signal alone. VWAP adds a "value" filter to the structural GEX bounce.

## Risk Profile
- **Stop loss logic**: Fixed points below entry
- **Default stop**: 20 points
- **Target**: 60 points (3x risk)
- **Risk/Reward**: 1:3

### Risk Validation
```
Risk = 20 points < 30 points max  ✓
Target = 60 points = 3x risk      ✓
```

## Entry Rules
- **Setup conditions**:
  1. Price is BELOW intraday VWAP (trading at discount to fair value)
  2. Price is within 15 points of GEX Support 1
  3. GEX regime can be positive OR negative (VWAP discount is the filter)
  4. Current bar closes above Support 1 (not breaking through)
  5. RTH session only

- **VWAP Calculation**:
  ```
  VWAP = Cumulative(Price × Volume) / Cumulative(Volume)
  Reset at RTH open (9:30 AM EST)
  ```

- **Trigger**:
  - Price near support while below VWAP
  - Entry at candle close

- **Entry type**: LIMIT order at close of signal candle

- **Time filter**:
  - RTH only (14:30 - 21:00 UTC)
  - No entries in first 15 minutes (VWAP not yet established)
  - No entries after 3:30 PM EST

## Exit Rules
- **Take profit**: Entry + 60 points (or VWAP as dynamic target if closer)
- **Stop loss**: Entry - 20 points
- **Trailing**: Activate at 25 points profit, trail 8 points behind high
- **Time stop**: 60 bars maximum hold

### VWAP-Based Target Option
Alternative target logic: Exit at VWAP reversion if VWAP distance > 30 points from entry:
```javascript
const vwapTarget = vwap - 5; // Just below VWAP
const fixedTarget = entry + 60;
const target = Math.min(vwapTarget, fixedTarget);
```

## Filters (when NOT to trade)
1. **Already in position** - one trade at a time
2. **Price above VWAP** - no discount, skip
3. **First 15 min of RTH** - VWAP not established
4. **Price breaking through support** - breakdown, not bounce
5. **VWAP too far (> 100 points away)** - extreme move, risky to fade
6. **Within 30 minutes of market close**
7. **Cooldown period** - 30 minutes between signals

## Required Data
- `gex/nq/nq_gex_YYYY-MM-DD.json` - GEX levels with support arrays
- `ohlcv/nq/NQ_ohlcv_1m.csv` - 1-minute OHLCV for VWAP calculation and signals
- `ohlcv/nq/NQ_ohlcv_1s.csv` - 1-second data for exits (optional)

**Note**: VWAP is computed from OHLCV data, no additional data file needed.

## Expected Performance
- **Win rate estimate**: 58-63% (VWAP discount filter should improve base rate)
- **Trades per day estimate**: 0.5-2 (selective - requires both conditions)
- **Best conditions**:
  - Price below VWAP approaching GEX support
  - Normal IV environment
  - Mean-reverting regime
- **Worst conditions**:
  - Strong trend days with VWAP slope
  - Breakdown days where support fails
  - Low volume days (VWAP less meaningful)

## Validation Checklist
- [x] Stop ≤ 30 points (20pt stop)
- [x] Target ≥ 3x stop (60pt = 3x)
- [x] Clear, codeable entry rules
- [x] Clear exit rules
- [x] Defined filters

## Parameter Sensitivity
| Parameter | Default | Test Range | Rationale |
|-----------|---------|------------|-----------|
| levelProximity | 15 | 10-20 | Distance from GEX level |
| stopLossPoints | 20 | 15-25 | Fixed stop distance |
| takeProfitPoints | 60 | 45-75 | Fixed target (3x stop) |
| minVWAPDiscount | 5 | 0-15 | Min points below VWAP required |
| maxVWAPDistance | 100 | 75-150 | Max distance from VWAP (avoid extremes) |
| useVWAPTarget | false | true/false | Use VWAP as dynamic target |
| signalCooldownMs | 1800000 | 900000-3600000 | Cooldown between signals |
| skipFirstMinutes | 15 | 10-30 | Minutes to skip at RTH open |
| useTrailingStop | true | true/false | Enable trailing stop |
| trailingTrigger | 25 | 20-35 | Points before trailing activates |
| trailingOffset | 8 | 5-12 | Trailing stop distance |

## VWAP Calculation Implementation
```javascript
class VWAPCalculator {
  constructor() {
    this.reset();
  }

  reset() {
    this.cumulativePV = 0;  // Price × Volume sum
    this.cumulativeVolume = 0;
    this.vwap = null;
  }

  update(candle) {
    // Typical price = (H + L + C) / 3
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const volume = candle.volume || 1;

    this.cumulativePV += typicalPrice * volume;
    this.cumulativeVolume += volume;

    this.vwap = this.cumulativePV / this.cumulativeVolume;
    return this.vwap;
  }

  getVWAP() {
    return this.vwap;
  }

  isBelow(price) {
    return this.vwap !== null && price < this.vwap;
  }

  getDistance(price) {
    return this.vwap !== null ? price - this.vwap : null;
  }
}
```

## Code Interface
```javascript
class VWAPGexConfluenceStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // GEX proximity
    this.params.levelProximity = params.levelProximity ?? 15;

    // VWAP parameters
    this.params.minVWAPDiscount = params.minVWAPDiscount ?? 5;
    this.params.maxVWAPDistance = params.maxVWAPDistance ?? 100;
    this.params.useVWAPTarget = params.useVWAPTarget ?? false;

    // Risk management
    this.params.stopLossPoints = params.stopLossPoints ?? 20;
    this.params.takeProfitPoints = params.takeProfitPoints ?? 60;
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // Signal management
    this.params.signalCooldownMs = params.signalCooldownMs ?? 1800000;
    this.params.skipFirstMinutes = params.skipFirstMinutes ?? 15;

    // Trailing stop
    this.params.useTrailingStop = params.useTrailingStop ?? true;
    this.params.trailingTrigger = params.trailingTrigger ?? 25;
    this.params.trailingOffset = params.trailingOffset ?? 8;

    // Session filter
    this.params.useSessionFilter = params.useSessionFilter ?? true;
    this.params.allowedSessions = params.allowedSessions ?? ['rth'];

    // VWAP calculator (reset daily)
    this.vwapCalc = new VWAPCalculator();
    this.lastTradingDate = null;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Update VWAP (reset on new day)
    // Check if price below VWAP
    // Check proximity to GEX support
    // Generate signal if confluence exists
  }
}
```

## Backtest Configuration
```bash
node index.js \
  --ticker NQ \
  --strategy vwap-gex-confluence \
  --start 2024-01-01 \
  --end 2024-12-31 \
  --timeframe 15m \
  --stop-loss-points 20 \
  --target-points 60 \
  --use-trailing-stop \
  --trailing-trigger 25 \
  --trailing-offset 8 \
  --use-session-filter
```

## Expected Confluence Improvement
| Signal Type | Expected Win Rate | Rationale |
|-------------|-------------------|-----------|
| GEX Support Only | 54% | Base historical rate |
| Below VWAP Only | 52% | Slight value edge |
| **Both (Confluence)** | **58-63%** | Combined probability |
