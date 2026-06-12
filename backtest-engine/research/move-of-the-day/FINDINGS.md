# Move-of-the-Day Meta-Strategy — Findings

**Question (Drew, 2026-06-12):** Take all signals from the four production strategies over
the 16-month backtest (Jan 2025 → Apr 2026), restrict the whole system to **one trade per
RTH session**, and see if we can predict/select the single trade that captures the most NQ
points. Treat each strategy's signal as one input to a combined meta-engine. No lookahead.

**Design (locked with Drew):**
- Entry universe: selector over the *real* signals each strategy fired (then a free-exit comparison).
- Exit: each candidate reuses its **own** strategy's stop/target → we inherit the already-1s-honest
  realized `pointsPnL` per signal (no re-simulation).
- Objective: **risk-adjusted** (PF / Sharpe / DD), not raw PnL.
- Phase 1: establish the oracle ceiling first.

Pipeline: `00-unify-signals.js` → `01-oracle-ohlcv.js` → `02-signal-oracle-baselines.js`
→ `03-feature-analysis.js` → `04-selector.js` → `05-free-exit-and-robustness.js`.
Sources: `data/gold-standard/{gex-lt-3m-crossover-v3, gex-level-fade-v2, gex-flip-ivpct-v2,
ls-flip-trigger-bar-v3}.json`. NQ point = $20.

---

## TL;DR

1. **One trade/day is a strictly smaller pie than the live portfolio.** The *perfect* one-trade/day
   selection (full hindsight, restricted to real signals) tops out at **$495,954** — below the
   existing 4-strategy FCFS stacking baseline **$614,730**. So this is **not** a PnL play.
2. **As a selective, risk-adjusted filter it is real and deployable.** A trivially simple causal
   rule — *take the first glx-or-gfi signal of the day, skip everything else* — does
   **$105,106 / PF 1.98 / Sharpe 4.32 / DD 10.8%** on 212 of 329 days, beating the naive
   "first signal of the day" baseline ($74,777 / PF 1.81 / Sh 3.12) on every axis.
3. **The "move of the day" is barely predictable ex-ante.** Even perfect signal selection captures
   only **~25% of the day's range**, and the winning signal is spread across all four strategies
   (lstb 119 / glx 96 / glf 87 / gfi 27 days) with no single dominant predictor.
4. **A wider fixed target is a real, 1s-validated exit upgrade — but a trailing stop is NOT.**
   On the selected picks, replacing the native exit with a **~150 pt fixed target (own stop kept)**
   lifts results to **$132,345 / PF 2.05 / Sharpe 5.08 / DD 8.6%** vs own-exit $105k / PF 1.98 /
   Sh 4.32 / DD 10.8% — and it's near-identical across halves (H1 Sh 5.10 / H2 Sh 5.06).
   A **trailing** stop, by contrast, *destroys* the edge (best $52k / Sh 2.99): the Phase-2
   MFE-based trailing estimate ($174k) was a **false positive** that the 1s sim caught.

---

## Ceilings (hindsight)

| Reference | $ PnL | PF | Sharpe | DD | Note |
|---|--:|--:|--:|--:|---|
| Theoretical OHLCV (full daily range) | $2,183,660 | — | — | — | 331 pt/day avg; absolute ceiling |
| **Best achievable signal/day** | **$495,954** | ∞ | 18.73 | 0% | 22.8% of theoretical; perfect pick |
| Worst signal/day (anti-oracle) | −$229,923 | 0 | — | — | per-day selection swing is huge |

The theoretical max single-trade move equals the **full daily range every day** (the earlier of
the day's high/low is always capturable one direction). Best-achievable-signal captures only
~25% of that — the strategies simply don't fire at most daily extremes.

## Causal baselines & the selector (one trade/day, RTH)

| Rule (causal) | $ PnL | PF | Sharpe | DD% | Days traded |
|---|--:|--:|--:|--:|--:|
| First signal/day (any strategy) | 74,777 | 1.81 | 3.12 | 7.4 | 329/329 |
| **First glx+gfi/day** | **105,106** | **1.98** | **4.32** | 10.8 | 212/329 |
| First glx+gfi/day, ≤11 ET | 97,786 | 2.20 | 5.00 | 11.2 | 164/329 |
| First glx+gfi+glf/day | 103,442 | 1.93 | 3.90 | **5.25** | 302/329 |
| First glx only/day | 66,819 | 1.67 | 3.42 | 19.5 | 193/329 |
| Fitted selector (shrunk-mean score, τ on train) | 86k in-sample | 2.32 | 5.32 | 10.8 | 123/329 |

The fitted selector (`04-selector.js`) independently rediscovers the same thing — at its tuned
threshold only glx/gfi signals clear the bar. Forward H1→H2 generalized well (test PF 2.55 / Sh 6.6)
but reverse H2→H1 degraded (test PF 1.56 / Sh 2.97 / DD 27.8%), exposing **gfi regime instability**
(gfi mean pts: H1 2.0 → H2 84.3). The simple unfitted "first glx+gfi" rule is more robust than the
fitted one and is what I'd actually deploy.

## What predicts a good signal (univariate, `03`)

- **Strategy quality:** gfi 45 pt/sig (⚠️ unstable) > glx 21 pt (stable, H1 18 → H2 25) >
  glf 7 pt (26% WR, lottery) > lstb 3 pt (76% WR, tiny & rock-stable).
- **Hour:** 9–10 ET is where size lives (hour 9 = 12 pt avg, decays to ~3 pt by 15:00).
  glx@9 = 31 pt, glx@14 = 26 pt, gfi@10 = 58 pt (small n).
- **glx:** lt0/lt2/lt3 levels ~20–31 pt; rules all positive (S_CW 27, L_S4 21).
- **gfi:** all gexRegimes positive; L3/L4 rules strongest.
- **glf:** PRL (12 pt) ≫ PRH (1.6 pt); put_wall negative — PRH/put_wall add noise.
- Side is symmetric (long 7.0 / short 6.0 pt) — no directional bias to exploit.

## The exit finding — Phase 2 hint, Phase 3 verdict

**Phase 2 hint (`05`, MFE-based — NOT validated):** on the 212 picks, avg MFE 80.4 pt vs avg
realized 24.8 pt → own exits bank only 31% of peak. An MFE-approximation trailing exit *suggested*
$174k. **This was a false positive** — see Phase 3.

**Phase 3 verdict (`06`/`07`, 1s-VALIDATED on real 1s OHLCV from the fill instant, own stop kept):**

| Exit policy (same 212 entries) | $ PnL | PF | Sharpe | DD% | Stable H1≈H2? |
|---|--:|--:|--:|--:|:--:|
| Own strategy exit (realized) | 105,106 | 1.98 | 4.32 | 10.8 | no (H1 weak / H2 strong) |
| **Fixed target 150 pt** | **132,345** | **2.05** | **5.08** | **8.6** | **yes (Sh 5.10 / 5.06)** |
| Fixed target 120 pt | 112,125 | 1.92 | 4.82 | 9.8 | — |
| Fixed target 260 pt | 134,495 | 1.97 | 4.27 | 10.4 | — |
| Hold to EOD (own stop only) | 152,295 | 2.08 | 4.00 | 9.2 | higher PnL, lower Sharpe |
| **Trailing stop (best: trig 50/off 40)** | 52,335 | 1.55 | 2.99 | 22.0 | **NO — destroys edge** |

Verdict: **a wide *fixed* target (~150 pt) keeping the own stop is a genuine, robust upgrade**
(+26% PnL, +PF, +Sharpe, −DD, and it balances the own-exit's lopsided H1/H2). A **trailing**
stop fails because it gives back from the peak on every winner and converts clean target-hits
into worse stop-outs. The lever is "let winners run to a far fixed level," not "trail the peak."
This matches the v2/v3 wider-target research; the MFE/give-back framing was misleading because
MFE is an instantaneous peak you can't causally exit at.

---

## Comparison vs FCFS gold-standard portfolio (`08`, same metrics engine)

All rows below run through one metrics fn mirroring `multi-strategy-rules/lib/metrics.js`
(daily √252 Sharpe, $100k-notional DD%, $5 commission). Reproduces canonical FCFS exactly.

| System | Trades | Total PnL | $/trade | PF | Sharpe | DD% | WR |
|---|--:|--:|--:|--:|--:|--:|--:|
| 4-strat FCFS (with lstb) | 6,128 | $614,730 | $100 | 1.77 | **10.78** | **4.45** | 67% |
| 3-strat FCFS (no lstb) | 1,047 | $420,343 | $401 | 2.00 | 7.81 | 5.69 | 42% |
| MotD first any signal/day | 329 | $73,132 | $222 | 1.79 | 3.04 | 4.72 | 48% |
| MotD first glx+gfi own exit | 212 | $104,046 | $491 | 1.96 | 4.27 | 8.20 | 56% |
| **MotD first glx+gfi target 150** | 212 | $131,285 | **$619** | **2.04** | 5.03 | 6.95 | 51% |
| MotD first glx+gfi hold-EOD | 212 | $151,235 | $713 | 2.07 | 3.96 | 8.43 | 45% |

**Verdict:** FCFS wins every tracked metric except **per-trade efficiency**. Its Sharpe 10.78
is a *daily-aggregation / intraday-diversification* effect (~18 trades/day → ultra-consistent
daily PnL, largely lstb-driven — strip lstb → 7.81), which a one-trade/day book structurally
can't reach (caps ~Sh 5). Move-of-the-day's edge is per-trade quality: $619/t vs $100/t (~6×)
at higher PF (2.04 vs 1.77). It's not a portfolio replacement — it's a low-frequency, high-conviction
product (~30× fewer trades) comparable to one good standalone strategy, with far lower exec burden.

## Sizing & preemption overlays on FCFS (`09`, real engine, S0 reproduces $614,730)

| Scenario | Trades | Total PnL | PF | Sharpe | DD% |
|---|--:|--:|--:|--:|--:|
| S0 baseline FCFS | 6,128 | $614,730 | 1.77 | 10.78 | 4.45 |
| S1 +2× size MotD trade | 6,128 | $690,728 | 1.78 | 9.27 | 6.55 |
| S2 +preempt (1×) | 6,099 | $613,776 | 1.77 | 10.68 | 4.93 |
| S3 +preempt +2× | 6,099 | $701,062 | 1.78 | 9.14 | 6.00 |

**Q1 sizing 2 contracts on the MotD trade:** +$76k (+12.4%) PnL but Sharpe −14% (10.78→9.27),
DD +47% deeper (4.45→6.55%). Pure leverage on a +EV trade, not alpha — and *less* risk-efficient
than uniform 2× (which would be exactly 2× PnL at identical Sharpe/DD%), because it concentrates
lumpy variance on one undiversified daily trade. Redeeming angle: MotD trades avg ~$422 net vs the
book's $100/trade, so if margin-constrained to one extra contract/day, the MotD trade is the best
place to spend it (~4× edge-per-contract). On the PF/Sharpe scorecard it's a marginal negative.

**Q2 preempt the slot with the first morning glx/gfi signal:** a WASH (−$954, DD slightly worse).
Of 212 days with a glx/gfi RTH signal, the slot is FREE 144 / held-by-family 23 / foreign-in-morning
42 / foreign-late 3 — so preemption can only fire 42×, and acting on all of them nets ≈0 because you
forfeit the foreign holder's remaining PnL (often an lstb winner, 72% WR) and the downstream slot-
displacement cascade cancels the gain. Not worth implementing.

## Recommendation

- **Don't** build this as a PnL replacement for the portfolio — the ceiling is below it.
- **Do** consider it as a low-touch, high-Sharpe overlay: "one high-conviction trade/day"
  = first glx-or-gfi signal, optionally morning-only, with a **wide ~150 pt fixed target**
  (own stop kept) instead of the native exit. That is the 1s-validated risk-adjusted sweet spot
  ($132k / PF 2.05 / Sh 5.08 / DD 8.6%, stable across halves). **Avoid trailing stops here.**

## Caveats / next steps (honest)

1. **Trail numbers are an MFE approximation, NOT 1s-simulated.** Per CLAUDE.md, any trusted
   PF/Sharpe must be replicated on 1s OHLCV from the fill instant. The `max(realized, MFE−G)`
   model is optimistic about exiting near the peak. **Next:** real 1s trailing-stop sim on the
   212 picks before believing the ~$174k figure. (Selection-only numbers ARE honest — they reuse
   each strategy's existing 1s-honest realized PnL.)
2. **Candidate universe = signals that actually fired** under each strategy's own 1-position slot
   rule. Signals suppressed because the strategy was already in a trade are absent. A true meta-engine
   seeing *all* raw (pre-suppression) signals could differ — would require re-running engines with
   `--allow-parallel` or dumping raw signals.
3. **gfi instability:** its edge is concentrated in H2 (post-Aug 2025). Any live rule leaning on gfi
   should expect H1-like dry spells; glx is the stable backbone.
4. First-half (early-2025, tariff-vol) drawdowns dominate every rule's DD — regime, not strategy.
5. Free-*entry* (enter at arbitrary bars, not just signal timestamps) was scoped but not built —
   the free-*exit* test above is the higher-value half of that question and already shows exits
   matter more than entries here.
