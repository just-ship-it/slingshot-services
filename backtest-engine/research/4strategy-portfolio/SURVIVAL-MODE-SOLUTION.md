# Small-Account Survival Mode — Firm Solution (2026-06-08)

## Problem
Drew's live account bleeds: up in the morning, gives it all back shorting into
the afternoon trend. The 4-strategy FCFS portfolio backtests beautifully
($614k+ / huge MAR) but that scoring assumes an **infinite-tolerance account**.
The real account is a **$1,500 cash account that ladders MNQ→NQ with balance**,
where a 100-pt giveback is 13% of capital and an early losing streak ends the
account before compounding ever helps.

## Tools built (`research/4strategy-portfolio/`)
- `run-real-account.js` — sequential, compounding, **real-account** sim of the
  FCFS portfolio: $1,500 start, MNQ $2/pt + NQ $20/pt, real commission, the
  **dashboard balance-tier ladder** (mirrors `no-trade-day/precompute-projection.py`),
  margin/ruin floor, optional daily give-back lock + loss limit. Survival-focused
  scorecard (final balance, blowup date, max $ + % DD, **micro-phase DD < $25k**,
  giveback $).
- `bootstrap-survival.js` — sequence-safe judge: resample daily-PnL kernels
  (IID or N-day **block** to preserve regime clustering) through the ladder; report
  P(ruin), final-balance p10/50/90, DD p50/p90, micro-phase DD p90.
- `staged-survival.js` — staged "survival mode then graduate" simulation + threshold sweep.

## What did NOT work (and why every prior optimizer said "don't change it")
1. **Per-trade MFE-ratchet (tighten exits to capture giveback).** Engine re-run
   (1s-honest) of gex-level-fade with tiers `30:0.40,50:0.55,75:0.65,100:0.72`:
   capture 18%→**7%**, PF 1.44→**1.16**, PnL $111k→**$36k**, DD up. Tightening
   strangles the mean-reversion edge — the bread-and-butter trades go +30, pull
   back, then run to target; locking +12 after +30 kills them. **Confirms the
   16-month research: exits can't be improved for PnL.**
2. **Daily give-back lock (portfolio-level).** On the single historical ordering
   it looked great (maxDD 28%→18%, "validated" train/test). Under the **bootstrap**
   it does **nothing** to the drawdown tail (microP90 stays 39-43%) and halves
   growth. The historical benefit was **sequence luck**. A give-back lock only
   helps green-then-red days; the drawdown tail is driven by clusters of **pure
   red trend days** it never touches.
3. **Gentler contract ladders.** 39%→35% only. Drawdown % is scale-invariant when
   sizing tracks balance. The binding constraint is the **floor**: you can't size
   below 1 MNQ, and 1 MNQ with a 70-pt stop = $140 = ~9% of $1,500 per trade →
   a normal 6-7 trade losing streak is structurally a ~38% drawdown. The fragility
   is the **wide stops**, not the scaling.

## Root cause
The fatal micro-phase drawdown is a **portfolio property**, driven by the
**wide-stop fade strategies**. Per-strategy survival from $1,500 (bootstrap):

| Strategy (alone) | stop | P(ruin) | median final | micro-phase DD p90 |
|---|---|---|---|---|
| **lstb** | 12 pt | **0.0%** | $1.4M | **21%** |
| gex-flip | wide | 0.0% | $4.7M | 39% |
| lt-3m | 70 pt | 0.2% | $1.9M | 47% |
| **level-fade** | 22 pt | **2.2%** | $66k | **67%** ☠ |

`lstb`'s 12-pt stop (~1.6% risk/trade on $1,500) makes it the only strategy a
small account can safely run. level-fade and lt-3m are small-account death traps.

## THE SOLUTION — balance-gated survival mode
- **Balance < $25,000 → SURVIVAL MODE: trade `lstb` (LS_FLIP_TRIGGER_BAR) only.**
- **Balance ≥ $25,000 → GROWTH MODE: full 4-strategy portfolio.**
- Hysteresis: demote back to survival if balance falls below ~$20,000.

$25k is also exactly where the ladder switches MNQ→NQ, so the fragile micro phase
ends there by construction.

### Backtested result (staged-survival, 10-day block bootstrap, seed 999)
| Graduate at | P(ruin) | median final | micro-phase DD | worst DD |
|---|---|---|---|---|
| full always (status quo) | 0.03% | $4.81M | 41% | 41% |
| **$25,000** | **0.00%** | **$3.64M** | **26%** | **30%** |
| lstb-only forever | 0.00% | $1.40M | 26% | 26% |

**Graduating at $25k cuts worst-ever drawdown 41%→30% and micro-phase 41%→26%,
removes the ruin tail, and keeps ~75% of the upside.** Stable across seeds and
under regime-clustering (block) resampling. Median ~105 trading days (~5 months)
in survival mode before graduating.

## Implementation (trade-orchestrator)
A balance-gated strategy gate in the routing/gate chain:
- Config (OFF by default): `SURVIVAL_MODE_ENABLED`, `SURVIVAL_GRADUATE_BALANCE=25000`,
  `SURVIVAL_DEMOTE_BALANCE=20000`, `SURVIVAL_STRATEGIES=LS_FLIP_TRIGGER_BAR`.
- Per account: read broker netLiq; if in survival mode, reject any signal whose
  strategy ∉ `SURVIVAL_STRATEGIES` with reason `survival_mode_small_account`.
- Log mode transitions.

## Caveats (must hold for live to match backtest)
1. Absolute $ figures are idealized-exit fantasies; the **relative drawdown/ruin
   improvement** is the deliverable, not the $3.6M.
2. Survival mode rides entirely on `lstb` — the **lstb candle-feed one-bar-lag fix
   must be deployed** (see memory `lstb-candle-feed-one-bar-lag`), or live lstb
   underperforms its backtest and survival mode is compromised.
3. Drawdown floor is ~26-30% even in survival mode under clustering — not zero.
