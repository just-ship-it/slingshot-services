# Instant Stop-Out Investigation — Can We Predict and Block at Entry?

Companion to CORRELATION-FINDINGS.md. Tests whether the entry-time state of the OTHER two strategies (knowable LIVE via per-strategy position state subscription) can predict the <5-min stop-outs that dominate losses.

## Premise

Drew's observation: "if they're already eating the full loss in 5 minutes, the only solution is to not enter in the first place." Correct. A post-entry time-stop can't save these trades — by the time the time-stop fires, the stop has already filled.

So we need a **rejection signal evaluable at signal time** that flags incoming entries as high-probability instant stops.

## What we tested

For every accepted `first-in-wins` entry, we captured the state of the other two strategies at that signal time:
- Are they currently in an open native position?
- If yes, same-side or opposite-side as our new signal?
- How long have they been open?

Then we bucketed instant-stop rate by these features.

## The result: portfolio state has almost no predictive power

| Origin × other-strategies' state at entry | Trades | Instant rate | Instant PnL |
|---|---:|---:|---:|
| gex-level-fade / **flat-others** | 636 | 47.5% | **-$119,290** |
| gex-level-fade / conflict (others opp-side) | 22 | 45.5% | -$3,950 |
| gex-level-fade / confluence (others same-side) | 11 | 27.3% | -$1,185 |
| gex-lt-3m / flat-others | 724 | 9.9% | -$66,040 |
| gex-lt-3m / conflict | 12 | 0.0% | $0 |
| gex-lt-3m / confluence | 19 | 10.5% | -$2,070 |
| gex-flip-ivpct / flat-others | 141 | 3.5% | -$6,100 |

**95% of all entries fire when the other two strategies are flat.** Conflict and confluence states together represent only ~4-5% of entries (3-30 trades per origin). Even the slight differences in instant-stop rate within those small buckets don't generate enough savings to matter.

## Gate experiments

Every entry-time rejection rule we tried saves ~$1-5k of instant stops, but loses an equivalent or greater amount in dropped winners. Headline DD% doesn't move because the global max-DD window doesn't overlap with the few trades we can drop.

| Gate | Trades dropped | Instant stops dropped | PnL change | Sharpe | DD% | DD$ |
|---|---:|---:|---:|---:|---:|---:|
| GATE-1 reject level-fade when others opp-side open | 22 | 10 | -$1,645 | 5.69 | 10.98% | $16,739 |
| GATE-7 reject level-fade SHORT when others LONG | 12 | 5 | -$740 | 5.70 | 10.98% | $16,739 |
| GATE-9 reject level-fade @ 09 ET when others opp-side | 13 | 8 | -$2,180 | 5.67 | 11.15% | $16,739 |
| GATE-10 reject level-fade @ 09-10 ET when others opp-side | 22 | 10 | -$1,645 | 5.69 | 10.98% | $16,739 |

Best case ($3,950 of instant stops gated) saves less than 2% of the total instant-stop cost. The 302 instant stops we CAN'T predict from portfolio state remain.

## Why this doesn't work

`gex-level-fade`'s gold-standard config uses a 9:00-10:30 ET entry window. In that window:
- `gex-flip-ivpct` fires ~12 entries per month total → almost never overlapping a level-fade fire
- `gex-lt-3m` fires more often (~57/month) but its average overlap density with the level-fade window is small

So `gex-level-fade` is, in practice, firing into a portfolio-empty state nearly every time. **There is no "other strategy fighting it" signal to gate on, because nothing else is usually open when it fires.**

## What this means structurally

The 47.5% instant stop-out rate for `gex-level-fade` is **intrinsic to the strategy itself**, not a portfolio interaction. It uses a tight 18pt stop (~$360) on a level-fade thesis where the level either holds or breaks. When it breaks, the stop fires within minutes. That's the cost of the strategy's sharp risk/reward profile (PF 1.45, Sharpe 3.94 at the strategy level).

The 18pt stop was sweep-optimized for `gex-level-fade` standalone. From memory: 12pt stop blows DD to 12.4%, 15pt is similar to 18pt, 20pt drops total PnL to $88k. **18pt is the optimum at its own optimization surface — you can't tune the stop wider without losing edge.**

## Realistic paths forward

### 1. Accept the trade-off (recommended)

`gex-level-fade` produces +$67k net under `first-in-wins` even with the 47% instant stop rate. Trying to filter out the bad ones without an external signal is a losing game — every gate either dilutes the strategy or saves negligible amounts.

### 2. Switch to the GEX-only level-fade variant

From memory: `gex-level-fade-gexonly.json` (add `--glf-levels NONE` to the CLI) → 200 trades / WR 28% / **PF 1.97** / Sharpe 3.26 / **DD 3.92%** / $55.4k. Less than half the PnL of the all-levels variant, but the DD is roughly half, and the per-trade quality is higher. Worth re-running the multi-strategy pipeline with this swap.

### 3. Switch the rule to confluence-only-last-exit

Already the recommended low-DD rule from the main SUMMARY. Structurally filters out un-confirmed level-fade entries (must have ≥1 other strategy agreeing same-side). $105k / Sharpe 8.56 / DD 4.24% on 1 contract. The cleanest single-slot answer.

### 4. Look outside the 3-strategy state for an external entry-gate

Real candidates (none testable in this pipeline):
- **Tick velocity at signal time**: if NQ has been moving >X pts/sec in the wrong direction, skip level-fade
- **Order book imbalance**: heavy directional flow predicts level break
- **Recent realized volatility**: if 5-min ATR is in top decile, skip tight-stop fades
- **CVD imbalance** at the level being faded

Any of these would need a separate data source and a separate research project. The current 3-strategy stack doesn't carry that information at signal time.

## Bottom line

You're right that an entry-gate is the only fix, and **the entry-gate cannot be built from the 3-strategy portfolio state alone** — they're not synchronized enough. The instant stop-outs in `gex-level-fade` are baked into its own design at its current tuning. The lever is the choice of strategy variant (gold-standard vs gexonly) or the choice of cross-strategy rule (first-in-wins vs confluence-only-last-exit), not a smart entry filter.
