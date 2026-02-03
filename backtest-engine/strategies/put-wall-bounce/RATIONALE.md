# Put Wall Bounce Strategy - Rationale

## Discovery Process

This strategy was developed through systematic analysis of NQ backtesting data spanning 2023-2025.

### Data Analyzed
- 2.57M 1-minute OHLCV candles (Dec 2020 - Dec 2025)
- 690 daily GEX level records
- ~500 intraday GEX snapshots with 15-min resolution
- 66,161 liquidity trigger level records

### Key Finding

When analyzing price behavior at GEX levels, the **Put Wall** emerged as the strongest support level with exceptional bounce characteristics:

| Holding Period | Avg Return | Win Rate | N |
|---------------|------------|----------|---|
| 5 min | +4.86 pts | 59.7% | 62 |
| 10 min | +8.35 pts | 59.7% | 62 |
| 15 min | +17.89 pts | 54.4% | 57 |
| **30 min** | **+44.79 pts** | **78.6%** | 42 |
| **60 min** | **+59.61 pts** | **100%** | 33 |

This dramatically outperformed other GEX levels:
- S1 Support: ~0 pts avg, 50% win rate
- R1 Resistance: +2.7 pts avg, 52% win rate (for shorts)

---

## Why Put Wall Works

### Market Mechanics
1. **Put Wall = Maximum Put Open Interest**: This is where market makers have sold the most puts
2. **Gamma Hedging**: As price approaches Put Wall, MMs must buy futures to hedge → creates buying pressure
3. **Dealer Gamma**: Negative gamma at Put Wall means MMs amplify moves → bounce is aggressive

### Regime Consideration
All Put Wall touches in the sample occurred during `strong_negative` regime. This makes sense:
- In negative regimes, price is more likely to test lower support levels
- Negative regime = bearish sentiment → more put buying → stronger Put Wall effect

---

## Strategy Logic

### Entry Conditions
1. **Price proximity**: Within 15 pts of Put Wall level
2. **Touch type**: Price must touch Put Wall from above (support test)
3. **GEX Regime**: `negative` or `strong_negative` preferred (optional filter)
4. **Session filter**: Premarket (4AM-9:30AM EST) optional for best performance

### Exit Conditions
1. **Take Profit**: 30 pts (matches ~1:3 R:R with typical stop)
2. **Stop Loss**: 10 pts below Put Wall (or below candle low + buffer)
3. **Trailing Stop**: Optional - activate at 15 pts profit, trail 8 pts

### Risk Management
- Max risk per trade: 15 pts ($300/contract)
- Risk:Reward target: 1:3 minimum
- Commission: $2.50/rt
- Slippage: 1 tick (0.25 pts)

---

## Expected Performance (Based on Analysis)

### Conservative Estimate (using 30m hold data)
- Win Rate: ~75%
- Avg Win: +30 pts (capped at target)
- Avg Loss: -10 pts (stopped out)
- Expected P&L per trade: (0.75 × 30) - (0.25 × 10) = +20 pts

### Trade Frequency
- Put Wall is touched infrequently (~6 times per day in test sample)
- Valid entry conditions (from above, correct regime) reduce frequency further
- Expect 1-3 trades per day during negative regime periods

---

## Caveats and Risks

### Limited Sample Size
- Only 62 support test events in 15-day sample
- Need out-of-sample validation on larger dataset

### Regime Dependency
- Strategy likely performs best in negative GEX regime
- In positive regime, Put Wall may not be tested as often

### Execution Risk
- Limit orders at Put Wall may not fill if bounce is too fast
- Slippage on stop losses in volatile conditions

### Market Changes
- GEX dynamics could change if more traders exploit this pattern
- Options market structure evolution could affect Put Wall significance

---

## Implementation Notes

### Required Data
- Intraday GEX levels with `put_wall` field
- Real-time price data (1-min minimum)
- GEX regime indicator (optional enhancement)

### Order Type
- Entry: Limit order at Put Wall level (or slightly above)
- Stop: Stop-market 10 pts below entry
- Target: Limit order 30 pts above entry

### Position Sizing
- Start with 1 contract for validation
- Scale based on account size and risk tolerance
- Never risk more than 2% of account per trade

---

## Comparison to Existing Strategies

### vs. GEX Recoil
- Put Wall Bounce is more selective (fewer trades)
- Higher win rate expected (75% vs ~50%)
- Focused on single strong level vs. all support levels

### vs. Liquidity Sweep
- Similar concept (mean reversion at key levels)
- Put Wall Bounce uses GEX-derived levels (market maker positioning)
- Liquidity Sweep uses TradingView indicator levels

### vs. IV Skew GEX
- Simpler signal (no IV data required)
- Less filtering complexity
- Potentially more robust to data availability

---

## Conclusion

The Put Wall Bounce strategy capitalizes on a well-defined market microstructure phenomenon: gamma hedging by market makers at major put open interest levels. The exceptional win rate (78-100% in sample) and large average returns (+45-60 pts) make this a compelling strategy to test.

Key to success will be:
1. Proper identification of Put Wall levels in real-time
2. Patient waiting for valid entry conditions
3. Strict adherence to stop losses
4. Regime awareness (prefer negative GEX regimes)
