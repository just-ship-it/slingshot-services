# NQ Strategy Discovery - Exploratory Analysis

## Objective

Explore the available backtesting data, identify patterns and anomalies, and develop trading strategies based on what you discover. This is open-ended research - let the data guide you.

---

## Project Location

**Backtest Engine:** `/home/drew/projects/slingshot-services/backtest-engine/`
**Data Directory:** `/home/drew/projects/slingshot-services/backtest-engine/data/`

### Getting Started

1. **Explore the data directory structure:**
   ```bash
   find /home/drew/projects/slingshot-services/backtest-engine/data -type f -name "*.csv" | head -50
   find /home/drew/projects/slingshot-services/backtest-engine/data -type f -name "*.json" | head -50
   ```

2. **Sample each data type to understand schemas:**
   ```bash
   head -5 [file]
   ```

3. **Learn the backtest engine:**
   ```bash
   cd /home/drew/projects/slingshot-services/backtest-engine
   node index.js --help
   ```

4. **Study the reference strategy for code patterns:**
   ```bash
   cat /home/drew/projects/slingshot-services/shared/strategies/iv-skew-gex.js
   ```

5. **Review any existing analysis:**
   ```bash
   ls -la /home/drew/projects/slingshot-services/backtest-engine/data/analysis/
   cat /home/drew/projects/slingshot-services/backtest-engine/data/analysis/*.md
   ```

---

## Risk Constraints (NON-NEGOTIABLE)

Whatever strategies you develop must adhere to:

```
MAX_RISK_PER_TRADE = 30 points ($600/contract)
MIN_RISK_REWARD = 1:3 (e.g., 20pt stop → 60pt minimum target)
ORDER_TYPE = Limit entries only, with attached stop and target
COMMISSION = $2.50/rt per contract
SLIPPAGE = 1 tick (0.25 points)
```

Test both fixed targets and trailing stops for profit management.

---

## Timezone

- User timezone: EST (Eastern)
- Most data is in UTC
- Handle conversions appropriately for session analysis

---

## Your Mission

### Phase 1: Data Exploration & Pattern Discovery

Dig into the data. Look for:
- Statistical anomalies
- Correlations between datasets (e.g., GEX levels vs price action)
- Time-of-day patterns
- Regime changes
- Anything interesting or unexpected

Write findings to `discovery/DATA_EXPLORATION.md`

Questions to answer:
- What data do we have and what time periods does it cover?
- What's the quality of the data? Any gaps or issues?
- What relationships exist between different data sources?
- What patterns jump out from basic statistical analysis?
- What hypotheses does the data suggest?

### Phase 2: Hypothesis Testing

Pick the most promising patterns and test them:
- Formulate specific, falsifiable hypotheses
- Write simple tests to validate/invalidate
- Document what works and what doesn't

Write findings to `discovery/HYPOTHESIS_TESTS.md`

### Phase 3: Strategy Development

For patterns that hold up:
- Develop into tradeable strategies
- Implement following the reference strategy patterns
- Backtest with proper walk-forward validation
- Document everything

Output to `strategies/[name]/` with implementation and results.

### Phase 4: Synthesis

Create `discovery/SUMMARY.md` with:
- What you explored
- What you found
- What worked vs didn't
- Recommended strategies for live testing
- Ideas for future exploration

---

## Output Format

```
discovery/
├── DATA_EXPLORATION.md    # What's in the data
├── HYPOTHESIS_TESTS.md    # What you tested
├── SUMMARY.md             # Final recommendations
└── notebooks/             # Any analysis scripts

strategies/
└── [discovered-strategy]/
    ├── RATIONALE.md       # Why this should work
    ├── strategy.js        # Implementation
    └── results/           # Backtest output
```

---

## Ralph Wiggum Usage

**Exploratory run (recommended - give it room to explore):**
```bash
/ralph-loop "Explore the NQ backtesting data in /home/drew/projects/slingshot-services/backtest-engine/data. Analyze the available datasets, discover patterns, and develop trading strategies based on what you find. Follow the constraints in nq-strategy-discovery-prompt.md. Output <promise>DISCOVERY_COMPLETE</promise> when you have documented findings and at least one backtested strategy." --max-iterations 50 --completion-promise "DISCOVERY_COMPLETE"
```

**If you want to cap it shorter:**
```bash
/ralph-loop "Explore the NQ backtesting data, document interesting patterns, and develop at least one strategy. Follow nq-strategy-discovery-prompt.md. Output <promise>DISCOVERY_COMPLETE</promise> when done." --max-iterations 30 --completion-promise "DISCOVERY_COMPLETE"
```

## Completion Criteria

Output `<promise>DISCOVERY_COMPLETE</promise>` when you have:
- [ ] Documented data exploration findings
- [ ] Tested at least 3 hypotheses
- [ ] Developed at least 1 backtested strategy meeting risk constraints
- [ ] Created summary with recommendations

Good hunting! 🔍
