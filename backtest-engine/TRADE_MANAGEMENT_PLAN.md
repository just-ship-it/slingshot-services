# Tiered Trade Management System Plan

## Problem Identified
Current strategy has 10.42% win rate but many trades go profitable before reversing to losses.

**Example**: Trade T001017
- Entry: 25042.5
- Went +42 points in profit
- Final exit: -21.5 points (63.5 point swing from peak to loss)

## Root Cause Analysis
**Binary Exit Logic Problem:**
- Hit target = Big win (~62 points average)
- Hit stop = Loss (~21 points average)
- No middle ground for profit protection on medium-quality signals

**Fresh Swing Low Issue:**
- Many signals trigger on same bar as new swing low creation
- These "fresh levels" haven't had time to mature/prove market significance
- Higher quality trades use established, aged levels that market recognizes

## Proposed Solution: Trade Quality Scoring + Dynamic Exits

### Phase 1: Trade Quality Classification
**High Quality Trades (Score 80+):**
- Aged levels (established over multiple bars/hours)
- Strong confluence from multiple sources
- Clear market structure context
- Volume/momentum alignment

**Medium Quality Trades (Score 50-79):**
- Moderately aged levels
- Some confluence factors
- Mixed market context

**Low Quality Trades (Score <50):**
- Fresh levels (created recently)
- Weak confluence
- Poor market structure timing

### Phase 2: Tiered Exit Strategy
```
High Quality: Standard stops + full profit targets
Medium Quality: Trailing stops after +20 points profit
Low Quality: Tight trailing stops after +10 points profit
```

**Profit Protection Rules:**
- Once profitable by threshold, move stop to breakeven
- Trail stops based on trade quality tier
- Prioritize capital preservation over home run profits for lower quality signals

### Phase 3: Implementation Details

**Level Age Calculation:**
- Track time between swing formation and signal generation
- Flag "fresh swing" signals for different treatment

**Dynamic Stop Management:**
- Modify trade simulator to support conditional trailing stops
- Add profit threshold tracking
- Implement quality-based exit logic

**Backtesting Integration:**
- Test tiered system against current binary approach
- Compare win rates, expectancy, maximum drawdown
- Validate profit protection effectiveness

### Expected Outcomes
- **Improved Win Rate**: Convert losses like T001017 into wins/scratches
- **Better Expectancy**: Protect profitable moves that currently reverse
- **Reduced Drawdown**: Fewer painful reversals from profit to loss
- **Psychological Benefit**: Less frustrating "winning trades that became losers"

### Key Metrics to Track
- Win rate improvement by trade quality tier
- Average profit capture on trades that go profitable
- Reduction in profitable-trades-turned-losers
- Overall strategy expectancy improvement

## Next Steps
1. Complete comprehensive test matrix analysis
2. Identify patterns in profitable trades that reverse
3. Determine optimal profit thresholds and trailing distances
4. Implement and backtest tiered system
5. Compare performance against current approach

---
*Saved: January 13, 2026*
*Context: After discovering trade T001017 went +42pts before -21.5pt exit*