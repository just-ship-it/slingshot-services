# Strategy: GEX Liquidity Sweep Confluence

## Hypothesis
Smart Money Concepts (SMC) theory suggests that institutional traders often "sweep" liquidity by triggering stop losses clustered at obvious swing highs/lows before reversing. When this liquidity sweep occurs at a GEX support level, we have double confluence:

1. **Liquidity cleared**: Retail stops have been taken, removing selling pressure
2. **GEX support**: Dealer hedging flows create structural support at this level

The combination should produce higher probability entries than either signal alone. The sweep acts as a "spring" - price extends beyond the level, takes out stops, then reverses with force.

## Risk Profile
- **Stop loss logic**: Structure-based - below the sweep low + buffer
- **Default stop**: 25 points maximum (below sweep low, max 25pt from entry)
- **Target**: 75 points minimum (3x risk)
- **Risk/Reward**: 1:3

### Risk Validation
```
Risk = max 25 points < 30 points max  ✓
Target = 75 points = 3x risk          ✓
```

## Entry Rules
- **Setup conditions**:
  1. Identify prior swing low (minimum 5 bars on each side)
  2. Price sweeps below swing low (new low created)
  3. Sweep low is within 20 points of GEX Support 1 or Support 2
  4. Current bar closes back above the prior swing low (failed breakdown)
  5. Session is RTH only

- **Trigger**:
  - After sweep, wait for bullish close above the swept level
  - Entry at close of reversal candle

- **Entry type**: LIMIT order at close of reversal candle

- **Time filter**:
  - RTH only (14:30 - 21:00 UTC)
  - No entries after 3:00 PM EST to allow trade development

## Exit Rules
- **Take profit**: Entry + 75 points (3x risk)
- **Stop loss**: Below sweep low - 5 point buffer (structure-based)
  - Maximum 25 points from entry, skip trade if structure requires more
- **Trailing**: Activate at 40 points profit, trail 15 points behind high
- **Time stop**: 90 bars (1.5 hours) maximum hold

### Exit Priority Order
1. Stop loss hit → immediate exit
2. Take profit hit → exit at target
3. Trailing stop triggered → exit when breached
4. Time stop → exit at market

## Filters (when NOT to trade)
1. **Already in position** - one trade at a time
2. **Sweep continues lower** - if close is below sweep low, not a valid reversal
3. **Structure stop > 25 points** - if sweep low is too far from entry, skip
4. **LT sentiment BEARISH** - prefer BULLISH LT sentiment for longs
5. **Strong trend day** - avoid fading momentum on trend days (measure by day range > 150pt)
6. **Cooldown period** - 45 minutes between signals

## Required Data
- `gex/nq/nq_gex_YYYY-MM-DD.json` - GEX levels with support arrays
- `ohlcv/nq/NQ_ohlcv_1m.csv` - 1-minute OHLCV for signal generation
- `liquidity/nq/NQ_liquidity_levels.csv` - LT levels and sentiment for filtering
- `ohlcv/nq/NQ_ohlcv_1s.csv` - 1-second data for precise exits (optional)

## Expected Performance
- **Win rate estimate**: 55-62% (confluence should improve base GEX bounce rate)
- **Trades per day estimate**: 0-2 (sweeps at GEX levels are selective)
- **Best conditions**:
  - Clear swing low that gets swept
  - GEX support nearby (within 20 points of sweep)
  - Bullish LT sentiment
  - Normal volatility (IV 30-60%)
- **Worst conditions**:
  - Trend days with consecutive new lows
  - Thin overnight levels with no swing structure
  - High IV blow-off moves

## Validation Checklist
- [x] Stop ≤ 30 points (25pt max structure-based)
- [x] Target ≥ 3x stop (75pt = 3x 25pt)
- [x] Clear, codeable entry rules
- [x] Clear exit rules
- [x] Defined filters

## Parameter Sensitivity
| Parameter | Default | Test Range | Rationale |
|-----------|---------|------------|-----------|
| swingLookback | 5 | 3-10 | Bars to confirm swing high/low |
| gexProximity | 20 | 15-30 | Distance from GEX level for confluence |
| maxStopPoints | 25 | 20-30 | Maximum allowed stop distance |
| stopBuffer | 5 | 3-10 | Buffer below sweep low for stop |
| takeProfitMultiple | 3.0 | 3.0-4.0 | Target as multiple of risk |
| signalCooldownMs | 2700000 | 1800000-3600000 | 45 min default cooldown |
| maxHoldBars | 90 | 60-120 | Maximum hold time |
| trailingTrigger | 40 | 30-50 | Points before trailing activates |
| trailingOffset | 15 | 10-20 | Trailing stop distance |
| requireBullishLT | true | true/false | Require bullish LT sentiment |

## Swing Low Detection Logic
```javascript
function isSwingLow(candles, index, lookback = 5) {
  const low = candles[index].low;

  // Check bars before
  for (let i = 1; i <= lookback; i++) {
    if (index - i < 0) return false;
    if (candles[index - i].low <= low) return false;
  }

  // Check bars after
  for (let i = 1; i <= lookback; i++) {
    if (index + i >= candles.length) return false;
    if (candles[index + i].low <= low) return false;
  }

  return true;
}
```

## Sweep Detection Logic
```javascript
function detectLiquiditySweep(currentCandle, swingLow, gexSupport, proximity = 20) {
  // Check if current candle swept below swing low
  const swept = currentCandle.low < swingLow.price;

  // Check if close is back above swing low (reversal)
  const reversed = currentCandle.close > swingLow.price;

  // Check if sweep is near GEX support
  const nearGEX = Math.abs(currentCandle.low - gexSupport) <= proximity;

  return swept && reversed && nearGEX;
}
```

## Code Interface
```javascript
class GexLiquiditySweepStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Swing detection
    this.params.swingLookback = params.swingLookback ?? 5;

    // GEX proximity
    this.params.gexProximity = params.gexProximity ?? 20;

    // Risk management
    this.params.maxStopPoints = params.maxStopPoints ?? 25;
    this.params.stopBuffer = params.stopBuffer ?? 5;
    this.params.takeProfitMultiple = params.takeProfitMultiple ?? 3.0;
    this.params.maxHoldBars = params.maxHoldBars ?? 90;

    // Signal management
    this.params.signalCooldownMs = params.signalCooldownMs ?? 2700000; // 45 min

    // Trailing stop
    this.params.useTrailingStop = params.useTrailingStop ?? true;
    this.params.trailingTrigger = params.trailingTrigger ?? 40;
    this.params.trailingOffset = params.trailingOffset ?? 15;

    // Filters
    this.params.requireBullishLT = params.requireBullishLT ?? true;
    this.params.useSessionFilter = params.useSessionFilter ?? true;
    this.params.allowedSessions = params.allowedSessions ?? ['rth'];

    // Tracked swing lows
    this.recentSwingLows = [];
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Detect swings, check for sweep, validate GEX confluence, generate signal
  }
}
```

## Backtest Configuration
```bash
node index.js \
  --ticker NQ \
  --strategy gex-liquidity-sweep \
  --start 2024-01-01 \
  --end 2024-12-31 \
  --timeframe 15m \
  --max-risk 25 \
  --use-trailing-stop \
  --trailing-trigger 40 \
  --trailing-offset 15 \
  --use-session-filter
```
