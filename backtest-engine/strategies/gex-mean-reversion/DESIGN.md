# Strategy: GEX Mean Reversion

## Hypothesis
Dealer hedging flows create mechanical support at GEX support levels. When dealers are short gamma (negative GEX regime), they amplify moves - but the same gamma concentration at support levels still attracts hedging activity. The counterintuitive finding that negative GEX regimes show BETTER support bounce performance (57.1% vs 53.3%) may be explained by:

1. **Larger magnitude moves to levels**: Negative GEX creates larger swings, so when price reaches support, it has already exhausted momentum
2. **Cleaner setups**: The amplified move "clears out" weak hands before the bounce
3. **Hedging flow concentration**: Even in negative gamma, put wall levels still attract hedging flows

This strategy exploits the empirically-validated 57.1% win rate for support bounces in negative GEX environments.

## Risk Profile
- **Stop loss logic**: Fixed points below entry (structure-based would require additional data)
- **Default stop**: 20 points (allows 3:1 R:R with 60pt target within 30pt max risk)
- **Target**: 60 points minimum (3x risk)
- **Risk/Reward**: 1:3

### Risk Validation
```
Risk = 20 points < 30 points max  ✓
Target = 60 points = 3x risk      ✓
```

## Entry Rules
- **Setup conditions**:
  1. GEX regime is NEGATIVE (total_gex < 0 or regime contains "negative")
  2. Price is within 15 points of GEX Support 1 (closest support level)
  3. Current bar closes above Support 1 (not breaking through)
  4. Session is RTH only (9:30 AM - 4:00 PM EST)

- **Trigger**:
  - Price touches or briefly undercuts S1, then closes above S1
  - Entry at candle close price

- **Entry type**: LIMIT order at close of signal candle

- **Time filter**:
  - RTH only (14:30 - 21:00 UTC)
  - No entries after 3:30 PM EST (20:30 UTC) to allow time for trade to play out

## Exit Rules
- **Take profit**: Entry + 60 points (fixed target)
- **Stop loss**: Entry - 20 points (fixed stop)
- **Trailing**: Optional - activate at 30 points profit, trail 10 points behind high
- **Time stop**: 60 bars (1 hour on 1m chart) maximum hold time

### Exit Priority Order
1. Stop loss hit → immediate exit at stop
2. Take profit hit → immediate exit at target
3. Time stop → exit at market

## Filters (when NOT to trade)
1. **Already in position** - one trade at a time
2. **Price breaking through support** - if close is below S1, skip (breakdown, not bounce)
3. **IV percentile > 80** - extremely high volatility environments are unpredictable
4. **Within 30 minutes of market close** - insufficient time for trade to develop
5. **Cooldown period** - 30 minutes between signals to avoid overtrading

## Required Data
- `gex/nq/nq_gex_YYYY-MM-DD.json` - GEX levels with support/resistance arrays and regime
- `ohlcv/nq/NQ_ohlcv_1m.csv` - 1-minute OHLCV data for signal generation
- `ohlcv/nq/NQ_ohlcv_1s.csv` - 1-second data for precise exit execution (optional)
- `iv/qqq/qqq_atm_iv_15m.csv` - IV percentile data for volatility filter (optional)

## Expected Performance
- **Win rate estimate**: 55-60% (based on 57.1% historical for negative GEX bounces)
- **Trades per day estimate**: 1-3 (depends on how often price reaches support in negative GEX)
- **Best conditions**:
  - Negative GEX regime (total_gex < 0)
  - Price approaching support after extended move
  - IV percentile 30-60 (normal volatility)
- **Worst conditions**:
  - Strong trending days with momentum continuation
  - High IV environments (>80th percentile)
  - Gap days where support levels are far from price

## Validation Checklist
- [x] Stop ≤ 30 points (20pt stop)
- [x] Target ≥ 3x stop (60pt target = 3x)
- [x] Clear, codeable entry rules
- [x] Clear exit rules
- [x] Defined filters

## Parameter Sensitivity
Parameters to test during optimization:
| Parameter | Default | Test Range | Rationale |
|-----------|---------|------------|-----------|
| levelProximity | 15 | 10-25 | How close to level before signal |
| stopLossPoints | 20 | 15-30 | Fixed stop distance |
| takeProfitPoints | 60 | 45-90 | Fixed target (maintain 3:1 min) |
| signalCooldownMs | 1800000 | 900000-3600000 | Time between signals |
| maxHoldBars | 60 | 30-120 | Maximum trade duration |
| useTrailingStop | false | true/false | Compare fixed vs trailing exits |
| trailingTrigger | 30 | 20-40 | Points before trailing activates |
| trailingOffset | 10 | 5-15 | Trailing stop distance |

## Code Interface
```javascript
class GexMeanReversionStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // GEX level proximity
    this.params.levelProximity = params.levelProximity ?? 15;

    // Risk management (1:3 R:R)
    this.params.stopLossPoints = params.stopLossPoints ?? 20;
    this.params.takeProfitPoints = params.takeProfitPoints ?? 60;
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // Signal management
    this.params.signalCooldownMs = params.signalCooldownMs ?? 1800000; // 30 min

    // Filters
    this.params.maxIVPercentile = params.maxIVPercentile ?? 80;
    this.params.useSessionFilter = params.useSessionFilter ?? true;
    this.params.allowedSessions = params.allowedSessions ?? ['rth'];

    // Entry cutoff (3:30 PM EST = 15:30 + 5 = 20:30 UTC)
    this.params.entryCutoffHour = params.entryCutoffHour ?? 15;
    this.params.entryCutoffMinute = params.entryCutoffMinute ?? 30;

    // Trailing stop (optional)
    this.params.useTrailingStop = params.useTrailingStop ?? false;
    this.params.trailingTrigger = params.trailingTrigger ?? 30;
    this.params.trailingOffset = params.trailingOffset ?? 10;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Check filters, regime, proximity to support, generate signal
  }
}
```

## Backtest Configuration
```bash
node index.js \
  --ticker NQ \
  --strategy gex-mean-reversion \
  --start 2024-01-01 \
  --end 2024-12-31 \
  --timeframe 15m \
  --stop-loss-points 20 \
  --target-points 60 \
  --use-session-filter
```
