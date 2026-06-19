# Consecutive same-direction re-entries — does the next signal "chase" past the prior TP?

**Date:** 2026-06-16 · **Strategies:** GLF, GFI, GLX (LS-Flip excluded). **Range:** 2025-01-13 → 2026-04-23.
**Data:** per-strategy gold JSONs (each = trades that strategy actually took, one slot → trade[i] fires after trade[i-1] closed). Entries/TPs/outcomes already 1s-honest.

## Question
When a strategy fires another **same-direction** signal after the previous one closed, how often does it enter **beyond the prior signal's target** — a new SHORT at/below the last short's TP, or a new LONG at/above the last long's TP (chasing the move, e.g. the GLX CW_SHORT @ 30621.75 that entered below the prior TP near the day's low)? And does chasing past the prior TP make or lose money?

Definition: `beyond = (short ? priorTP − newEntry : newEntry − priorTP)`. `beyond ≥ 0` = entered at/past the prior TP ("chase").

## How often
| strat | same-dir pairs | at/beyond prior TP | % | median gap |
|---|---|---|---|---|
| GLF | 449 | 46 | **10.2%** | 24 min |
| GFI | 112 | 19 | **17.0%** | 1106 min |
| GLX | 407 | 60 | **14.7%** | 79 min |
| **ALL** | **968** | **125** | **12.9%** | 49 min |

≈ **1 in 8** same-direction re-entries enters at/beyond the prior signal's target.

## Does chasing pay? (outcome of the chase entry)
| | n | WR | avg net$ | tot net$ | PF |
|---|---|---|---|---|---|
| ALL **chase** | 125 | 44.8% | $399 | $49,849 | **1.84** |
| ALL non-chase | 843 | 42.2% | $358 | $301,526 | 1.87 |
| GLF chase | 46 | 19.6% | $47 | $2,180 | **1.12** |
| GLF non-chase | 403 | 25.1% | $138 | $55,490 | 1.39 |
| GFI chase | 19 | 63.2% | $1,509 | $28,674 | **4.33** |
| GLX chase | 60 | 58.3% | $317 | $18,995 | **1.57** |
| GLX non-chase | 347 | 59.9% | $405 | $140,508 | 1.94 |

**Headline: chasing past the prior TP is NOT a money-loser** — overall PF 1.84 ≈ non-chase 1.87, and avg $/trade is actually slightly *higher* ($399 vs $358). Momentum continuation roughly offsets the worse entry price. The example strategy (GLX) chases at PF 1.57 / $317 avg — Drew's "captures momentum moves down" intuition holds.

**The one caveat is GLF** (a fade strategy): chasing past your own prior TP barely profits (PF 1.12, WR 19.6%) — fighting its own mean-reversion logic. That's the only cohort worth a second look.

## Two useful nuances
- **Deeper = better, not worse.** By distance past prior TP: `0–50pt` PF 1.54, `50–150pt` PF 1.41, **`≥150pt` PF 2.76 / $726 avg** (n=42). Entering *way* beyond the prior TP = strong trend day = best outcomes. Shallow chases are the mediocre ones.
- **The "fires shortly after" case is good.** Chases with A→B gap ≤60 min (Drew's exact scenario): n=28, WR 57%, **PF 1.82**; ≤15 min: PF 1.98. Quick re-fires are momentum, not exhaustion.
- Prior trade hitting TP doesn't matter much: prior-hit chases PF 1.65 vs prior-missed chases PF 2.11 (small n).

## Verdict
~13% of same-direction re-entries chase past the prior TP; in aggregate they're **roughly break-even-vs-baseline to slightly better**, driven by trend-day continuation (deep chases & quick re-fires are the strongest). No portfolio-wide problem. **Only GLF same-direction chases (PF 1.12) are weak enough to consider filtering.** Sample sizes for GFI/deep/quick cuts are small (19–42) — directional, not conclusive.

Caveat: per-strategy JSONs ignore the shared 1-NQ production slot, so a few of these consecutive same-strategy trades wouldn't both be taken live; this measures each strategy's own repeat-firing behavior, which is what the question asks.

## Drill-down: Drew's exact example (GLX CW_SHORT chasing below prior short TP)
The specific live signal: GLX `S_CW` (CW_SHORT) re-entering as a SHORT at/below the prior short's TP, shortly after it closed, near the day low.

- **Frequency: 8 times in 16 months** (~1 every 6–7 weeks). Restricted to "fires shortly after" (gap ≤30 min): only **3**.
- **As a group of 8: 5W/3L, 62.5% WR, +$6,565, PF 2.54** — a net winner. Profit comes from *delayed* re-shorts that caught continuation (+$4,015 / +$3,995 / +$2,030, all with 100min+ gaps).
- **The ≤30-min subset (the worry): 3 trades, +395 / −1,400 / −1,435 = −$2,440** (two stops near day lows). But n=3 = noise.
- Broader GLX same-dir SHORT chase (all rules, n=18): PF 1.44 / +$5,160 — positive but weaker than non-chase shorts (PF 2.05). The drag is **`S_GF_SOLO` chase (n=7, PF 0.77, −$1,335)**, NOT CW_SHORT.

**Verdict: leave as is.** The exact CW_SHORT-chase pattern is profitable (PF 2.54); filtering it removes profit. The shortly-after losers are too few (3) to act on without overfitting, and a filter risks cutting the big continuation winners. If trimming ever warranted, target `S_GF_SOLO` chases first.

## Files
- `01-analyze.js` → `output/pairs.json` (968 pairs, all cuts, sorted by how far past TP).
