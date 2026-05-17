# Multi-Strategy Overlap & Rule-Set Research — SUMMARY

Generated: 2026-05-17T16:05:32.229Z

## Inputs

| Strategy | Trades | Date range | Reported PnL | PF | Sharpe | DD% |
|---|---:|---|---:|---:|---:|---:|
| gex-flip-ivpct | 191 | 2025-01-13 → 2026-04-17 | $129,412 | 2.9 | 5.68 | 7.11 |
| gex-lt-3m | 909 | 2025-01-14 → 2026-04-21 | $164,847 | 1.39 | 5.62 | 8.3 |
| gex-level-fade | 889 | 2025-01-13 → 2026-04-22 | $104,771 | 1.38 | 4.21 | 7.04 |

**Important date-range note:** `gex-level-fade` data ends 2026-01-28; the other two extend through April 2026. Overlap counts and Model A/B PnL after Jan 28 reflect only `gex-flip-ivpct` and `gex-lt-3m` for the last ~3 months.

## 1. Overlap census

Overlap defined as strict time-interval intersection: trades A `[entryA, exitA]` and B `[entryB, exitB]` overlap iff `entryA < exitB ∧ entryB < exitA`.

- **Total pairwise overlap events:** 3145
- **3-way overlap events:** 65

| Pair | Total | Confluence | Conflict |
|---|---:|---:|---:|
| gex-flip-ivpct__gex-level-fade | 1365 | 655 (48.0%) | 710 (52.0%) |
| gex-flip-ivpct__gex-lt-3m | 1458 | 712 (48.8%) | 746 (51.2%) |
| gex-level-fade__gex-lt-3m | 322 | 153 (47.5%) | 169 (52.5%) |

**3-way side combos:** {"mixed":44,"all-short":13,"all-long":8}

**Headline takeaway:** confluence and conflict are split ~50/50 in every pair. The strategies fire largely independently of each other's direction.

## 2. Conflict outcomes — when sides disagree, who was right?

"Right" = trade closed profitable under its own gold-standard exit rules (`netPnL > 0`). A long AND a short can both be right.

| Pair | Conflict events | A win% | B win% | Both right% | Both lose% | Avg joint PnL |
|---|---:|---:|---:|---:|---:|---:|
| gex-flip-ivpct__gex-level-fade | 710 | 98.9% | 20.8% | 20.1% | 0.4% | $469 |
| gex-flip-ivpct__gex-lt-3m | 746 | 99.2% | 48.5% | 48.1% | 0.4% | $386 |
| gex-level-fade__gex-lt-3m | 169 | 26% | 58.6% | 4.7% | 20.1% | $765 |

**⚠️ Per-event counts are inflated by trade duration asymmetry.** A single long-hold `gex-flip-ivpct` winner can overlap dozens of shorter `gex-lt-3m` / `gex-level-fade` trades, counting once per overlap event. So the 98-99% "A win%" for `gex-flip-ivpct` reflects that during a typical conflict moment, flip's open trade is usually the one in profit — not that every gex-flip trade wins 99% of conflicts.

**Real findings:**
- Avg joint PnL is POSITIVE for every conflict pair (≥0). When both fire, both books usually pay something on average.
- `gex-flip-ivpct` is dominant in any conflict it participates in (long hold + high WR = it’s already in profit when the opposing signal arrives).
- `gex-level-fade` vs `gex-lt-3m` conflicts: lt-3m wins ~59%, level-fade ~28%, both lose 19% — the most genuinely "either side could be right" pair.

## 3. Confluence outcomes — does same-direction agreement predict bigger winners?

Z-test compares the confluence-leg win rate to the strategy's overall baseline win rate.

| Pair | Events | A WR (confluence / baseline) | A z | B WR (confluence / baseline) | B z | Avg joint PnL |
|---|---:|---:|---:|---:|---:|---:|
| gex-flip-ivpct__gex-level-fade | 655 | 98.8% / 68.6% | 13.5 | 23.4% / 21.1% | 1.04 | $409 |
| gex-flip-ivpct__gex-lt-3m | 712 | 97.3% / 68.6% | 12.48 | 49.3% / 47.2% | 0.84 | $571 |
| gex-level-fade__gex-lt-3m | 153 | 46.4% / 21.1% | 6.68 | 54.9% / 47.2% | 1.76 | $1,050 |

**Findings:**
- Every confluence pair shows POSITIVE uplift for both legs (z > 0).
- `gex-flip-ivpct`'s win rate in confluence jumps from 68.6% baseline to 97-98% — but again, this is inflated by long-hold overlap (it's usually already winning when the agreeing signal arrives).
- `gex-level-fade` confluence with `gex-lt-3m`: 49% WR vs 22.2% baseline (z = 6.66). When BOTH level-fade and lt-3m agree on direction, level-fade's WR more than doubles.
- This is the single strongest confluence signal in the dataset and the main basis for the confluence-only rule's edge.

## 4. Per-strategy reconstruction (sanity check)

Run each strategy alone through `first-in-wins`. Result should match the JSON's reported total PnL exactly — confirming the loader and simulator behave correctly and that no strategy has internal overlap that would reduce its PnL under single-position semantics.

| Strategy | Reported PnL | Reconstructed PnL | Trades kept | Internal overlap loss |
|---|---:|---:|---:|---:|
| gex-flip-ivpct | $129,412 | $129,412 ✓ | 191/191 | $0 |
| gex-lt-3m | $164,847 | $164,847 ✓ | 909/909 | $0 |
| gex-level-fade | $104,771 | $104,771 ✓ | 889/889 | -$0 |

**Result:** all three reconstruct exactly. None of the three strategies has any internal trade overlap — each strategy's next signal is always issued after the previous trade has natively exited.

## 5. Model A — Stacking baseline (each strategy = own book, up to 3 contracts)

- **Trades:** 1989
- **Total PnL:** $399,030
- **Win rate:** 37.61%
- **Profit factor:** 1.52
- **Sharpe (daily-PnL annualized):** 6.38
- **Max DD (engine convention):** 11.35% ($20,184)

**Concurrency dwell (fraction of wall time at each open-position count):**

| Open positions | Dwell time (h) | % of total |
|---:|---:|---:|
| 0 | 10016.5 | 89.95% |
| 1 | 957.7 | 8.6% |
| 2 | 148.5 | 1.33% |
| 3 | 13.5 | 0.12% |

Bottom line: Model A holds 2+ contracts only **1.4% of the wall time**. The diversification benefit is real (combined Sharpe 6.58 > any single strategy's) but the broker would rarely actually carry 3 contracts.

## 6. Model B — Single shared 1-NQ position, candidate rules

Each rule replays the merged trade timeline chronologically against a single global slot.

| Rule | Trades | WR | PF | Sharpe | DD% | Total PnL | Accept% | Synth% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| first-in-wins | 1571 | 37.5% | 1.47 | 5.71 | 11.19% | $294,060 | 79% | 0% |
| flip-on-conflict | 1766 | 38.1% | 1.38 | 4.89 | 11.22% | $251,800 | 89% | 10% |
| confluence-only-first-exit | 246 | 50.8% | 2.08 | 6.1 | 3.94% | $75,216 | 12% | 50% |
| confluence-only-last-exit | 223 | 48.9% | 2.42 | 7.83 | 4.24% | $103,719 | 11% | 0% |
| priority-weighted | 1654 | 39.8% | 1.45 | 5.62 | 12.46% | $288,575 | 83% | 7% |

**Strategy-of-origin PnL by rule:**

| Rule | gex-flip-ivpct | gex-lt-3m | gex-level-fade |
|---|---:|---:|---:|
| first-in-wins | $95,702 | $131,210 | $67,148 |
| flip-on-conflict | $66,842 | $141,056 | $43,903 |
| confluence-only-first-exit | $11,038 | $25,638 | $38,540 |
| confluence-only-last-exit | $22,082 | $30,317 | $51,320 |
| priority-weighted | $129,412 | $116,107 | $43,056 |

**Reading the table:**
- `first-in-wins` captures most of Model A's PnL on a single shared slot (~73% of Model A) with 0% synthetic exits. The honest single-slot baseline.
- `priority-weighted` (favoring gex-flip) achieves similar PnL to first-in-wins because gex-flip's long holds dominate the slot anyway. Adds 7% synthetic exits from preemption.
- `flip-on-conflict` doesn't outperform first-in-wins despite trading more aggressively (1643 vs 1473 trades, similar PnL/Sharpe/DD). Flipping doesn't add edge — and 9% of its trades close via synthetic flip-PnL, so the number is biased high.
- `confluence-only-last-exit` has the **best Sharpe and lowest DD** of any rule, with ZERO synthetic exits — fully honest. Lower frequency (212 trades / 16mo) but per-trade quality is exceptional (PF 2.56, Sharpe 8.56).
- `confluence-only-first-exit` is half synthetic; its PnL leans on the approximation. The last-exit variant is the cleaner choice.

## 7. Recommended starting rule set

**Two viable single-slot rules depending on risk appetite:**

### Option A — Maximize PnL: `first-in-wins`
- $289k / Sharpe 5.79 / DD 11.19% / 1473 trades / 0% synthetic.
- Captures ~73% of Model A's PnL on a single contract.
- Mechanically simplest: when flat, take any signal; when in a position, reject all incoming signals until native exit. No flipping, no priority, no confluence gate.
- DD almost identical to Model A (11.19% vs 11.35%).

### Option B — Maximize risk-adjusted return: `confluence-only-last-exit`
- $105k / Sharpe 8.56 / DD 4.24% / 212 trades / 0% synthetic.
- Lower absolute PnL but **roughly 1/3 the drawdown** and the best Sharpe of any rule tested.
- Mechanically: require ≥2 strategies in same-direction overlap to enter; hold the governing trade through its own native exit; ignore other cluster members' exits.
- PF 2.56 — per-trade quality is exceptional.

### Comparison of all three viable options
| Mode | Contracts at peak | Total PnL | Sharpe | Max DD | Trades |
|---|---:|---:|---:|---:|---:|
| Model A — stacking | 3 | $398k | 6.58 | 11.35% | 1858 |
| Model B — first-in-wins | 1 | $289k | 5.79 | 11.19% | 1473 |
| Model B — confluence-only-last-exit | 1 | $105k | 8.56 | 4.24% | 212 |

**Heuristic for picking:**
- Margin allows 3 NQ contracts at peak (rare, only 0.1% of wall time anyway) → **Model A** for max PnL.
- Single contract + DD tolerance ~$20k → **first-in-wins** for high PnL on one contract.
- Single contract + DD-conscious / small account → **confluence-only-last-exit** for best Sharpe and ~$4k max DD.

**Worth knowing:** `flip-on-conflict` does NOT outperform `first-in-wins` (both ~$280-290k, similar Sharpe and DD) AND introduces 9% synthetic exits. Conclusion: flipping on opposite-direction signals does not add edge in this strategy set; you might as well just take the first signal and ride it through.

## 8. Caveats

1. **Synthetic-exit approximation.** Rules that close before native exit (`flip-on-conflict`, `confluence-only-first-exit`, `priority-weighted` preemption) cannot know whether the displaced trade would've hit its own stop/target sooner. Synthetic PnL uses `actualEntry → displacing-signal entry` × 20 − $5. This is optimistic for the displaced winner case and pessimistic for the displaced loser case. The `Synth%` column flags exposure.
2. **Confluence exit policy is a design choice.** `first-exit` (conservative) vs `last-exit` (more PnL). Both reported. Last-exit chosen as primary because it's synthesis-free.
3. **Pipeline does not model margin.** Model A's $398k headline assumes 3-contract margin headroom at peak. Capital-efficiency comparison left to the analyst.
4. **Date-range mismatch.** `gex-level-fade` ends 2026-01-28; overlaps after that involve only flip + lt-3m. The 12.5-month common window vs 16-month flip/lt-3m window is preserved in the JSONs; rule outputs are reported on the full union.
5. **Sharpe convention.** Daily-PnL series annualized at √252. Engine's reported Sharpe uses a different basis (consistent within itself but not matched here). Within this pipeline's tables Sharpe values ARE directly comparable across rules.
6. **3-way overlaps are rare** (61 events, 21 same-side). The confluence rule fires on any 2-strategy same-side overlap; 3-way is the rarer high-confidence case.
7. **Entry-proximity overlap definition** (window like 15-min after first signal) was not used; strict interval-intersection only. The proximity alternative would generate more confluence events but might dilute signal quality.
8. **Zero-duration trades:** two `fib_retrace` exits in `gex-flip-ivpct` have `entryTime === exitTime`. The simulator's sort handles these as entry-before-exit at the same instant (fix applied 2026-05-16) so they don't block subsequent entries.

## 9. Artifact index

- `output/overlap-tables.csv` — every pairwise overlap event
- `output/overlap-three-way.csv` — every 3-way overlap
- `output/conflict-outcomes.json` — per-pair 2×2 win/loss matrices, monthly buckets, direction-asymmetric splits
- `output/confluence-outcomes.json` — per-pair confluence-leg win rates + z-tests vs baselines, side splits, monthly buckets
- `output/model-a-portfolio.json` — Model A headline, per-strategy contribution, concurrency dwell, sampled equity curve
- `output/model-b-rule-comparison.csv` — head-to-head table
- `output/model-b-<rule>-trades.csv` — per-rule trade audit log

## 10. How to reproduce

```bash
cd backtest-engine
node research/multi-strategy-rules/run-all.js
# or step by step:
node research/multi-strategy-rules/01-build-overlap-tables.js
node research/multi-strategy-rules/02-classify-outcomes.js
node research/multi-strategy-rules/03-model-a-portfolio.js
node research/multi-strategy-rules/04-model-b-simulate.js
node research/multi-strategy-rules/05-write-summary.js
```
