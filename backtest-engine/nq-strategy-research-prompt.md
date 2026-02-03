# NQ Futures Strategy Research & Development

## Overview

Research market microstructure concepts and develop new quantitative strategies for NQ futures scalping using the existing backtesting infrastructure. This task is designed for iterative development using Ralph Wiggum loops.

---

## Project Location & Data

**Backtest Engine:** `/home/drew/projects/slingshot-services/backtest-engine/`
**Data Directory:** `/home/drew/projects/slingshot-services/backtest-engine/data/`

### Available Datasets

| Data Type | Path | Description |
|-----------|------|-------------|
| **NQ OHLCV 1s** | `ohlcv/nq/NQ_ohlcv_1s.csv` | 1-second NQ bars |
| **NQ OHLCV 1m** | `ohlcv/nq/NQ_ohlcv_1m.csv` | 1-minute NQ bars |
| **ES OHLCV 1s** | `ohlcv/es/ES_ohlcv_1s.csv` | 1-second ES bars |
| **QQQ OHLCV 1m** | `ohlcv/qqq/QQQ_ohlcv_1m.csv` | QQQ ETF 1-minute bars |
| **NQ GEX** | `gex/nq/nq_gex_YYYY-MM-DD.json` | Daily gamma exposure (2023-2025) |
| **NQ Order Flow** | `orderflow/nq/mbp-1/*.csv` | Market-by-price L1 data (2025+) |
| **NQ Book Imbalance** | `orderflow/nq/book-imbalance-1m.csv` | 1-minute bid/ask imbalance |
| **NQ Liquidity** | `liquidity/nq/NQ_liquidity_levels.csv` | Key liquidity levels |
| **QQQ Options CBBO** | `cbbo-1m/qqq/*.csv` | 1-minute options quotes (2025-2026) |
| **SPX Options CBBO** | `cbbo-1m/spx/*.csv` | 1-minute SPX options quotes |
| **VIX Options CBBO** | `cbbo-1m/vix/*.csv` | 1-minute VIX options quotes |
| **QQQ IV** | `iv/qqq/qqq_atm_iv_15m.csv` | 15-minute ATM implied vol |
| **Option Definitions** | `definition/*.csv` | Contract specs (2021-2025) |
| **QQQ/SPX Options Trades** | `options-trades/{qqq,spx}/*.csv` | Tick-level option trades |
| **Pre-computed Analysis** | `analysis/sweep-strategy-*.json` | Existing sweep strategy results |
| **Reference Strategy** | `ict-smt-strategy.md` | ICT Smart Money documentation |

---

## Reference Implementation

**Study this strategy first for code patterns and style:**
```
/home/drew/projects/slingshot-services/shared/strategies/iv-skew-gex.js
```

---

## Risk Parameters (CRITICAL)

These parameters are non-negotiable:

```
MAX_RISK_PER_TRADE = 30 points ($600/contract)
TARGET_RISK_REWARD = 1:3 (30pt risk → 90pt target)
COMMISSION = $2.50/rt per contract
SLIPPAGE = 1 tick (0.25 points)
```

**All strategies MUST be designed around these risk parameters:**
- Stop loss placement should be logical (structure-based), then position sized to not exceed 30 points
- If a setup requires >30 point stop, SKIP IT or use tighter entry
- Minimum target = 3x risk (e.g., 20pt stop → 60pt target minimum)

---

## Order Execution Requirements

**All strategies MUST use limit orders with attached stops and targets:**
- Entry: LIMIT order only (no market orders)
- Stop loss: Attached stop order
- Take profit: Attached limit order (target)
- Optional: Trailing stops for profit protection (test both fixed target and trailing)

**Timezone Handling:**
- User timezone: EST (Eastern)
- Data timezone: UTC
- All session filters must convert properly (e.g., RTH 9:30am EST = 14:30 UTC)

---

## Phase 1: Research

### Objective
Use web search and available resources to research trading concepts that could generate edge in NQ scalping.

### Research Topics

1. **Gamma Exposure (GEX) Trading**
   - How dealer hedging creates support/resistance
   - GEX flip levels and their significance
   - Optimal entry timing around GEX levels

2. **Order Flow Analysis**
   - Book imbalance as directional signal
   - Absorption patterns (large orders consumed without price movement)
   - Delta divergence from price

3. **Options Flow for Futures**
   - Put/call ratio extremes as reversal signals
   - 0DTE gamma impact on intraday NQ
   - IV term structure for regime detection

4. **Time-Based Patterns**
   - Overnight session characteristics
   - Opening range (first 15-30 min) breakout/failure patterns
   - End-of-day reversion

5. **Liquidity Patterns**
   - Liquidity sweep and reversal (ICT concepts)
   - Thin overnight levels as targets
   - VWAP and volume profile integration

### Deliverable
Create `research/FINDINGS.md` with:
- Summary of each topic researched
- Specific, testable hypotheses
- Ranked list of concepts by expected edge

When research is complete and documented, output: `<promise>RESEARCH_COMPLETE</promise>`

---

## Phase 2: Strategy Design

### Objective
Design 3-5 concrete trading strategies based on research findings.

### Strategy Template

For each strategy, create `strategies/[name]/DESIGN.md`:

```markdown
# Strategy: [Name]

## Hypothesis
[Why this edge exists - structural market reason]

## Risk Profile
- Stop loss logic: [how stop is determined]
- Default stop: [X] points (max 30)
- Target: [3X stop] points minimum
- Risk/Reward: 1:[calculated]

## Entry Rules
- Setup conditions: [what must be true]
- Trigger: [exact entry condition]
- Entry type: limit/market
- Time filter: [valid trading hours]

## Exit Rules
- Take profit: [condition or level - minimum 3x risk]
- Stop loss: [condition or level - max 30 points]
- Trailing: [if applicable]
- Time stop: [max hold time if any]

## Filters (when NOT to trade)
- [Condition 1]
- [Condition 2]

## Required Data
- [List specific data files needed]

## Expected Performance
- Win rate estimate: [X]%
- Trades per day estimate: [N]
- Best conditions: [when it works]
- Worst conditions: [when to avoid]
```

### Validation Checklist
Before proceeding, verify each strategy:
- [ ] Stop ≤ 30 points
- [ ] Target ≥ 3x stop
- [ ] Clear, codeable entry rules
- [ ] Clear exit rules
- [ ] Defined filters

When all strategies are designed and validated, output: `<promise>DESIGN_COMPLETE</promise>`

---

## Phase 3: Implementation

### Objective
Implement the most promising strategy as a backtest-ready module.

### Implementation Steps

1. **Study the reference strategy first**
   ```bash
   cat /home/drew/projects/slingshot-services/shared/strategies/iv-skew-gex.js
   ```
   Match this code style, patterns, and interfaces.

2. **Learn the backtest engine CLI**
   ```bash
   cd /home/drew/projects/slingshot-services/backtest-engine
   node index.js --help
   ```
   Understand all available options before writing code.

3. **Examine existing code**
   - Review backtest engine structure
   - Understand data loading patterns
   - Check for existing utilities (GEX parsing, session filters, etc.)

2. **Create strategy module**
   ```
   strategies/[name]/
   ├── DESIGN.md          # From Phase 2
   ├── strategy.js        # Core logic
   ├── config.js          # Parameters
   └── tests/             # Unit tests
   ```

3. **Strategy Module Interface**
   ```javascript
   module.exports = {
     name: 'StrategyName',
     version: '1.0.0',
     
     config: {
       stopPoints: 30,           // Max 30
       targetMultiple: 3,        // Minimum 3x
       useTrailingStop: false,   // Test both modes
       trailingStopPoints: 15,   // If trailing enabled
       // ... other params
     },
     
     async init(data, config) {
       // Load required data
     },
     
     generateSignal(bar, state) {
       // Returns signal object for LIMIT order entry
       return { 
         signal: 'long' | 'short' | 'flat',
         entryPrice: number,     // Limit price
         stopPrice: number,      // Attached stop
         targetPrice: number,    // Attached target
         confidence: 0-1, 
         reason: string 
       };
     },
     
     // Optional: trailing stop logic
     updateTrailingStop(position, currentBar, config) {
       // Returns new stop price if trailing
     },
     
     validateRiskReward(entry, stop, target) {
       const risk = Math.abs(entry - stop);
       const reward = Math.abs(target - entry);
       if (risk > 30) return { valid: false, reason: 'Risk exceeds 30pt max' };
       if (reward / risk < 3) return { valid: false, reason: 'R:R below 1:3' };
       return { valid: true, riskReward: reward / risk };
     }
   };
   ```

4. **Write tests**
   - Test signal generation
   - Test risk validation (must reject >30pt stops)
   - Test R:R validation (must reject <1:3)

When implementation is complete with passing tests, output: `<promise>IMPLEMENTATION_COMPLETE</promise>`

---

## Phase 4: Backtest & Optimize

### Objective
Run backtests, analyze results, and optimize parameters.

### Backtest Requirements

1. **Initial Backtest**
   - Run on 2024 data (in-sample)
   - Track all metrics

2. **Required Metrics**
   ```
   - Total P&L
   - Total trades
   - Win rate
   - Average winner / Average loser
   - Profit factor
   - Max drawdown (points and %)
   - Sharpe ratio
   - Average R:R achieved (must be ≥3.0 average)
   ```

3. **Session Analysis**
   Break down performance by:
   - Overnight (6pm-6am ET)
   - Premarket (6am-9:30am ET)
   - RTH (9:30am-4pm ET)

4. **Validate Risk Compliance**
   - NO trades with actual stop > 30 points
   - Average R:R ≥ 3.0
   - Flag any violations

5. **Optimization**
   - Use walk-forward (avoid overfitting)
   - Test parameter sensitivity
   - **Compare fixed target vs trailing stop exits**
   - Document optimal values

6. **Out-of-Sample Validation**
   - Run on 2025 data
   - Compare to in-sample results

### Output Files
```
strategies/[name]/
├── backtest-results-2024.json    # In-sample
├── backtest-results-2025.json    # Out-of-sample
├── optimization-log.md           # Parameter tuning notes
└── PERFORMANCE.md                # Final report
```

### Performance Report Format
```markdown
# [Strategy Name] - Performance Report

## Summary
| Metric | 2024 (IS) | 2025 (OOS) |
|--------|-----------|------------|
| Total P&L | | |
| Trades | | |
| Win Rate | | |
| Avg R:R | | |
| Profit Factor | | |
| Max DD | | |
| Sharpe | | |

## Exit Mode Comparison
| Metric | Fixed Target | Trailing Stop |
|--------|--------------|---------------|
| Total P&L | | |
| Win Rate | | |
| Avg Winner | | |
| Max DD | | |

## Risk Compliance
- Max stop used: [X] points (limit: 30)
- Min R:R trade: [X]:1 (limit: 3:1)
- Violations: [none / list]

## Session Breakdown
| Session | Trades | Win% | Avg P&L | Best Setup |
|---------|--------|------|---------|------------|
| Overnight | | | | |
| Premarket | | | | |
| RTH | | | | |

## Recommendations
- [Production readiness assessment]
- [Suggested improvements]
- [Recommended exit mode: fixed target / trailing stop]
```

When backtest is complete with documented results, output: `<promise>BACKTEST_COMPLETE</promise>`

---

## Final Deliverable

When all phases are complete:

1. Verify all files exist:
   - `research/FINDINGS.md`
   - `strategies/[name]/DESIGN.md`
   - `strategies/[name]/strategy.js`
   - `strategies/[name]/PERFORMANCE.md`
   - `strategies/[name]/backtest-results-*.json`

2. Create `SUMMARY.md` with:
   - Executive summary
   - Best performing strategy
   - Recommended next steps

3. Output: `<promise>ALL_PHASES_COMPLETE</promise>`

---

## Ralph Wiggum Usage

**Recommended approach: Run phase-by-phase** (allows review and course-correction between phases)

```bash
# Phase 1: Research
/ralph-loop "Execute Phase 1 from nq-strategy-research-prompt.md" --max-iterations 12 --completion-promise "RESEARCH_COMPLETE"

# Phase 2: Design  
/ralph-loop "Execute Phase 2 from nq-strategy-research-prompt.md" --max-iterations 10 --completion-promise "DESIGN_COMPLETE"

# Phase 3: Implementation (heaviest phase)
/ralph-loop "Execute Phase 3 from nq-strategy-research-prompt.md" --max-iterations 20 --completion-promise "IMPLEMENTATION_COMPLETE"

# Phase 4: Backtest
/ralph-loop "Execute Phase 4 from nq-strategy-research-prompt.md" --max-iterations 20 --completion-promise "BACKTEST_COMPLETE"
```

**Alternative: Run all at once (overnight)**
```bash
/ralph-loop "Execute all phases from nq-strategy-research-prompt.md sequentially" --max-iterations 45 --completion-promise "ALL_PHASES_COMPLETE"
```

### If Stuck After 80% of Iterations
- Document what's blocking progress
- List approaches attempted
- Save partial work
- Output relevant promise with `_PARTIAL` suffix (e.g., `RESEARCH_COMPLETE_PARTIAL`)

---

## Priority Strategy Concepts

Based on available data, prioritize:

1. **GEX Mean Reversion** - Fade moves into major GEX levels
2. **Book Imbalance Momentum** - Trade with strong order flow imbalance
3. **Liquidity Sweep Fade** - Enter after false breakouts sweep liquidity
4. **IV Regime Filter** - Adjust parameters based on QQQ ATM IV

Good luck! 🚀
