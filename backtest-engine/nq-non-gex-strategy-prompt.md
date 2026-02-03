# NQ Strategy Development - Order Flow, IV & Liquidity Focus

## Objective

Develop trading strategies leveraging the **underutilized datasets**: order flow, implied volatility, liquidity levels, and options activity. GEX has been extensively explored already - focus elsewhere.

---

## Project Location

**Backtest Engine:** `/home/drew/projects/slingshot-services/backtest-engine/`
**Data Directory:** `/home/drew/projects/slingshot-services/backtest-engine/data/`

**CLI Help:**
```bash
cd /home/drew/projects/slingshot-services/backtest-engine
node index.js --help
```

**Reference Strategy (for code patterns):**
```bash
cat /home/drew/projects/slingshot-services/shared/strategies/iv-skew-gex.js
```

---

## DATA PRIORITY (IMPORTANT)

### PRIMARY FOCUS - Build strategies using these:

| Dataset | Path | Explore First |
|---------|------|---------------|
| **Order Flow MBP** | `orderflow/nq/mbp-1/*.csv` | Market-by-price L1 data |
| **Book Imbalance** | `orderflow/nq/book-imbalance-1m.csv` | Bid/ask imbalance signals |
| **Liquidity Levels** | `liquidity/nq/NQ_liquidity_levels.csv` | Key trigger levels |
| **IV Data** | `iv/qqq/qqq_atm_iv_15m.csv` | ATM implied volatility |
| **Options Trades** | `options-trades/qqq/*.csv` | Tick-level option flow |
| **Options Trades** | `options-trades/spx/*.csv` | SPX option flow |
| **Options CBBO** | `cbbo-1m/qqq/*.csv` | Options quote data |
| **Statistics** | `statistics/` | Pre-computed stats |

### SECONDARY - Use only as filters/confirmation:

| Dataset | Path | Use As |
|---------|------|--------|
| **GEX** | `gex/nq/*.json` | Filter only, NOT primary signal |

### DO NOT build another GEX-primary strategy. GEX has been thoroughly explored.

---

## Strategy Ideas to Explore

### 1. Order Flow Imbalance
- What does persistent bid/ask imbalance predict?
- How does imbalance at different price levels correlate with future moves?
- Absorption signals: large orders consumed without price movement

### 2. Liquidity Level Reactions
- How does price behave at the liquidity trigger levels?
- Sweep and reverse patterns
- Failed breakouts at liquidity levels

### 3. IV Regime Strategies
- How do different IV environments affect NQ behavior?
- IV expansion/contraction as entry filter
- IV term structure signals

### 4. Options Flow Confirmation
- Large options trades as directional signal
- Put/call imbalance from actual trades (not just quotes)
- Unusual options activity detection

### 5. Multi-Signal Confluence
- Combine orderflow + liquidity + IV
- What happens when multiple non-GEX signals align?

---

## Risk Constraints (NON-NEGOTIABLE)

```
MAX_RISK_PER_TRADE = 30 points ($600/contract)
MIN_RISK_REWARD = 1:3 (e.g., 20pt stop → 60pt minimum target)
ORDER_TYPE = Limit entries only, with attached stop and target
COMMISSION = $2.50/rt per contract
SLIPPAGE = 1 tick (0.25 points)
```

Test both fixed targets and trailing stops.

---

## Timezone

- User timezone: EST
- Data timezone: UTC
- Convert appropriately for session analysis

---

## Your Tasks

### Step 1: Explore the Priority Datasets

For EACH primary dataset, document:
- Schema and fields
- Time coverage
- Data quality (gaps, anomalies)
- Initial statistical observations
- Potential signal ideas

**Start with orderflow and liquidity - these are completely unexplored.**

Write to `discovery/DATASET_ANALYSIS.md`

### Step 2: Identify Patterns

Look for:
- Book imbalance thresholds that predict moves
- Price behavior at liquidity levels
- IV regime characteristics
- Options flow anomalies

Write to `discovery/PATTERNS.md`

### Step 3: Develop & Backtest

Build at least 2 strategies that DO NOT use GEX as primary signal:
- One based on order flow / book imbalance
- One based on liquidity levels or IV

GEX may be used as a filter (e.g., "only trade when not near major GEX level") but NOT as the entry trigger.

### Step 4: Document Results

Create `discovery/NON_GEX_SUMMARY.md` with:
- What you found in the underutilized data
- Strategy performance comparison
- Recommendations

---

## Output Structure

```
discovery/
├── DATASET_ANALYSIS.md    # Deep dive on each primary dataset
├── PATTERNS.md            # Discovered patterns
└── NON_GEX_SUMMARY.md     # Final recommendations

strategies/
├── orderflow-[name]/      # Order flow based strategy
│   ├── strategy.js
│   └── PERFORMANCE.md
└── liquidity-[name]/      # Liquidity/IV based strategy
    ├── strategy.js
    └── PERFORMANCE.md
```

---

## Ralph Wiggum Commands

**Full exploration (overnight):**
```bash
/ralph-loop "Explore the NON-GEX datasets (orderflow, liquidity, IV, options-trades, statistics) and develop strategies from them. DO NOT build another GEX-primary strategy - GEX may only be used as a filter. Follow nq-non-gex-strategy-prompt.md. Output <promise>NON_GEX_COMPLETE</promise> when you have analyzed the datasets and backtested at least 2 strategies." --max-iterations 50 --completion-promise "NON_GEX_COMPLETE"
```

**Shorter run:**
```bash
/ralph-loop "Focus on orderflow/nq/ and liquidity/nq/ data. Build and backtest strategies using book imbalance and liquidity levels as primary signals. NO GEX-primary strategies. Follow nq-non-gex-strategy-prompt.md. Output <promise>NON_GEX_COMPLETE</promise> when done." --max-iterations 30 --completion-promise "NON_GEX_COMPLETE"
```

---

## Completion Criteria

Output `<promise>NON_GEX_COMPLETE</promise>` when:
- [ ] Analyzed orderflow data (mbp-1, book-imbalance)
- [ ] Analyzed liquidity levels data
- [ ] Analyzed IV data
- [ ] Developed at least 2 non-GEX strategies
- [ ] Backtested with performance reports
- [ ] Documented findings and recommendations

**Remember: The goal is to find edge in the DATA YOU HAVEN'T FULLY EXPLORED YET.**

Go find something new! 🔍
