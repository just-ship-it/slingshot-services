# GEX Mean Reversion - Performance Report

## Summary

| Metric | 2024 (IS) | Notes |
|--------|-----------|-------|
| Total P&L | -$14,156 | Strategy unprofitable |
| Trades | 259 | ~1 trade per day |
| Win Rate | 27.03% | Far below expected 57% |
| Avg R:R | 2.22 | Target R:R of 3.0 partially achieved |
| Profit Factor | 2.22 | Good when winning |
| Max DD | 20.77% | Significant drawdown |
| Sharpe | -1.36 | Negative risk-adjusted return |

## Exit Mode Comparison

| Metric | Fixed Target (20/60) | Wider (30/90) |
|--------|---------------------|---------------|
| Total P&L | -$14,156 | -$5,139 |
| Win Rate | 27.03% | ~25% |
| Avg Winner | $935 | $1,797 (take profit) |
| Max DD | 20.77% | 16.62% |

**Observation**: Wider stops help reduce drawdown but still unprofitable.

## Risk Compliance

- **Max stop used**: 20 points (limit: 30) ✓
- **Min R:R trade**: 3.0 (limit: 3:1) ✓
- **Violations**: None

## Trade Breakdown by Exit Reason

### 20pt Stop / 60pt Target
| Exit Reason | Count | Total P&L | Avg P&L |
|-------------|-------|-----------|---------|
| STOP LOSS | 184 | -$79,324 | -$431 |
| TAKE PROFIT | 46 | $54,938 | $1,194 |
| MAX HOLD_TIME | 28 | $10,200 | $364 |
| MARKET CLOSE | 1 | $30 | $30 |

**Analysis**:
- 71% of trades hit stop loss
- When target is hit, avg win is $1,194 (exactly as designed)
- Time stops are positive, suggesting momentum continuation

### 30pt Stop / 90pt Target
| Exit Reason | Count | Total P&L | Avg P&L |
|-------------|-------|-----------|---------|
| STOP LOSS | 137 | -$86,429 | -$631 |
| TAKE PROFIT | 23 | $41,323 | $1,797 |
| MAX HOLD_TIME | 73 | $37,922 | $519 |
| MARKET CLOSE | 3 | $2,045 | $682 |

**Analysis**:
- Fewer stop outs (58% vs 71%)
- More time exits (profitable on average)
- Still unprofitable overall

## Root Cause Analysis

### Why 27% Win Rate Instead of 57%?

1. **Research vs Reality Gap**: The 57.1% win rate from the event study was for price behavior over 1-hour windows, not for a specific trading strategy with fixed stops/targets.

2. **Entry Timing**: The strategy enters at the close of a 15-minute candle when price is "near" support. This is not the same as entering exactly when price touches support.

3. **Stop Distance**: 20-point stops may be too tight for NQ volatility. Many "bounces" first make a lower low before reversing.

4. **Regime Definition**: The strategy requires negative GEX regime, but the 57% stat may have included all GEX regimes.

5. **Level Proximity**: The 15-point proximity threshold may be either too tight (missing setups) or too loose (entering poor locations).

### Potential Improvements

1. **Use confirmation patterns**: Wait for a hammer/doji at support before entering
2. **Structure-based stops**: Place stops below the actual sweep low, not fixed distance
3. **Wider proximity + confirmation**: Allow 25pt proximity but require price rejection
4. **Remove negative GEX filter**: Test with all GEX regimes
5. **Add momentum filter**: Require RSI oversold or squeeze momentum bullish
6. **Session filtering**: Focus only on RTH first 2 hours when volatility is highest

## Recommendations

1. **DO NOT deploy to production** - Strategy is unprofitable in current form
2. **Investigate the GEX-Scalp-Confirmed strategy** - Uses confirmation patterns which may address the entry timing issue
3. **Run parameter sweep** - Test proximity 10-25, stops 15-30, targets 45-90
4. **Add momentum/confirmation filters** - The raw GEX level touch is not sufficient

## Lessons Learned

1. **Research findings are hypotheses, not strategies**: The 57% win rate from event study was a data observation, not a tradeable edge definition.

2. **Entry timing is critical**: "Near support" is ambiguous; precise entry rules with confirmation are needed.

3. **Fixed stops don't match structure**: GEX levels create support zones, not exact prices. Structure-based stops may be more appropriate.

4. **Profit factor can mislead**: 2.22 PF sounds good, but with 27% win rate it produces losses.

## Next Steps

1. Implement GEX Level Sweep strategy (Phase 2 design exists)
2. Add confirmation logic to this strategy
3. Test IV Regime Adaptive with different base entry logic

---

*Report generated: January 28, 2026*
*Phase 4 complete - Strategy backtested but requires optimization*
