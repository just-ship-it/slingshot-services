# MTF-Fib Confluence for GEX Mean-Reversion (JV / Jordan Vera retracement research)

**Date:** 2026-06-28 · **Status:** CONCLUDED. Real per-trade signal, characterized gate, but NOT
deployable in the single-slot FCFS book (fungible). Phase-2 standalone sleeve considered and
DECLINED for now — revisit only if a 2nd slot/account becomes available.

## Goal
Re-open research into JV's (Jordan Vera) ICT-style strategy, focused on one testable piece:
do higher-timeframe **structural-swing Fibonacci retracement levels** (15m / 1h / 4h) provide
**additional confluence** for the two mean-reversion strategies in the 4-strat FCFS book
(`gex-level-fade` = glf, `gex-flip-ivpct` = gfi)? Establish/track those levels over time as new
highs/lows confirm, line them up against the GEX levels the book fades, and test the edge.

## What was built
- **`01-build-mtf-fib-levels.js`** — the deliverable Drew asked for: a causal, rollover-aware
  time series of 15m/1h/4h **structural-swing** fib retracement levels in **raw front-contract**
  price space (so they align with GEX levels + gold-standard trade entries). Output:
  `output/mtf-fib-active.json` (5.1 MB; 15m 7,313 / 1h 1,719 / 4h 526 leg snapshots, 2024-09→2026-06).
  - JV/ICT-authentic anchoring: fib drawn off the most recent **confirmed** swing leg per TF;
    re-anchors only when a new fractal pivot confirms. Both an up-leg (long-side support) and a
    down-leg (short-side resistance) tracked at all times.
  - **Causality (no lookahead):** a pivot at bar `i` becomes active only at the close of bar
    `i+lookback` (`activeFrom`); annotation uses the latest leg with `activeFrom <= entryTime`.
  - **Rollover:** primary-contract filter replicated in-stream (highest-volume symbol/hour); pivot
    state hard-resets on contract change; mixed buckets dropped; trades matched to legs of their
    own `signalContract`. Levels verified in correct raw space (first glf long @20780.25 sat 5.5pt
    from the 15m 50% fib support 20785.75 on NQH5).
- **`lib/fib-confluence.js`** — causal leg lookup + per-trade confluence features (per-TF nearest
  matched-side fib distance/ratio, stacked count, OTE flag).
- **`lib/book-with-fib.js`** — the canonical 4-strat FCFS book (via `deck-filters/lib/annotate.js`,
  baseline-exact) with fib features attached to glf/gfi.
- **`00`–`05`** scripts: baseline repro, annotation+standalone EV, FCFS sweep, winner validation,
  sizing controls.

## Baseline (reproduced to the dollar)
`$614,730 / PF 1.77 / Sharpe 10.8 / DD $11,642 / 6,128 trades / test-half PF 2.04`
Window 2025-01-13 → 2026-04-23 (train ≤2025-09-30). Acceptance = PF-over-PnL: PF↑, Sharpe not
materially worse, DD ≤+2%, **test-half PF beats baseline (OOS)**.

## Findings

### 1. The confluence signal is REAL per-trade (`02`)
Standalone EV (ignores FCFS slot), confluent vs non-confluent mean-reversion trades:

| Pool | ALL PF | CONF prox≤8 ≥1TF | NON | CONF prox≤3 | 
|------|-------:|-----------------:|----:|------------:|
| glf+gfi | 1.94 | 2.23 (WR 34%) | 1.80 | 2.53 |
| glf | 1.44 | 1.62 | 1.35 | 1.82 |
| gfi | 3.39 | 4.17 (WR 59%) | 3.04 | 4.58 |
| glf+gfi OTE-only prox≤8 | — | 2.31 | 1.82 | — |

Monotonic in proximity (tighter = stronger), OTE (0.5–0.786) slightly better, holds for both
strategies. **Requiring ≥2 TFs over-filters and kills it** (PF collapses to ~1.2–1.4 on tiny n) —
single-TF proximity is the signal. Inverse book-control (drop *confluent*) → PF 1.77→1.76, sign
confirmed. **This answers Drew's question: YES, HTF structural retracement confluence marks better
mean-reversion trades.**

### 2. It does NOT convert to a book-level edge (`03`,`04`,`05`) — the honest verdict
- **As a FILTER on glf** (drop non-confluent), book metrics improve (PF 1.77→1.86, DD −14%, test
  2.05) and pass the strict rule — **BUT** the apt control kills it: random-dropping the *same 576/716*
  glf trades gives PF 1.83–1.86 across seeds (test 1.98–2.11). The "win" is a **drop-the-weakest-
  strategy** artifact (glf is the lowest-PF leg), not confluence selection skill. FCFS shared-slot
  **fungibility**: freed/contended slots get reallocated to other strategies, washing out glf trade
  selection.
- **As a SIZING lever** (size up confluent trades, keeps all — no fungibility-from-dropping):
  `05` vs random-sizing the same count, 8 seeds. **Every variant is `~null`** — confluence-sizing
  edge over random is within ±1 std on full *and* test PF, for gfi, glf, and both. The confluent
  subsets (29–237 trades) are too few to move a 6,128-trade book beyond noise, and gfi is already
  PF 3.39 so any sized subset looks alike.

**Verdict:** real per-trade signal; **not a deployable lever inside the existing FCFS book**
(filter ≈ random drop; sizing ≈ random sizing). A textbook PF-over-PnL false-positive caught by
proper controls. NOT deployed.

### 3. WHERE the per-trade edge concentrates (`06`) — informs a Phase-2 gate
Standalone EV, well-sampled buckets (n≥25), glf:
- **Timeframe:** 1h confluence strongest (PF 1.80, n=97), 15m helps (1.60, n=110); **4h adds
  nothing** (1.21, n=40 — worse than non-confluent). Drop 4h from any gate.
- **Ratio:** the **0.618 golden ratio is the carrier** (PF 2.41, avg $440, n=35), NOT deep OTE
  .705/.786 (1.49). Refines the earlier "OTE-favored" read to "0.618-favored."
- **Leg size:** big 80–150pt legs best (2.15, n=68); **mid 40–80pt legs dead (0.87, n=33).**
- **Gamma:** confluence is **incremental to gamma-sign** (not a proxy): glf pos-gamma non-conf
  1.48 → conf **1.90** (n=104); neg-gamma 1.21 → 1.54. Long-side (1.79) > short (1.53).
- gfi shows the same directions but every bucket is n<27 (under-sampled).

### 4. The sharp slice still does NOT survive in-book (`07`)
Re-tested each candidate vs a matched random-drop control (drop the same number of glf trades, 8
seeds); a rule "survives" only if it beats the random band on full AND test PF.

| keep-glf rule | keeps | full PF | random band | verdict |
|---|---:|---:|---|---|
| pos-γ only | 357 | 1.84 | 1.829±0.011 | fungible |
| confluent any-TF | 196 | 1.84 | 1.833±0.019 | fungible |
| pos-γ AND confluent | 104 | 1.87 | 1.854±0.017 | fungible |
| sharp (pos-γ+1h/15m+0.618+legR≥80) | 9 | 1.87 | 1.863±0.005 | "survives"* |
| mid-sharp (pos-γ+1h/15m+legR≥80) | 56 | 1.87 | 1.863±0.010 | fungible |

\*degenerate — keeps only 9/716 glf trades (≈ removing glf) and beats a razor-tight band by 0.01.
**No real in-book lever exists.** Even the gamma-sign gate (noted elsewhere as PF 1.77→1.80) sits
within the random-drop band — that small lever is also mostly "drop weak glf trades."

## Where the signal could still pay off (Phase 2, not yet run)
The per-trade edge is genuine and standalone, so it most plausibly pays off **outside** the
fungible single-slot book:
1. **New standalone confluence-gated mean-reversion entries** — fade GEX levels *only* when they
   coincide with a multi-TF structural fib, as its own sleeve on a separate slot/capital (honest 1s
   fills from scratch). This is the original Phase-2 plan; the slot-fungibility that defeated Phase 1
   does not apply to a dedicated sleeve. The `06`/`07` profiling gives a concrete, characterized gate
   to build on: **1h or 15m confluence (NOT 4h), 0.618 golden ratio, leg ≥80pt, positive gamma,
   long-favored.** Open question for the sleeve: throughput (how many such entries/month) and whether
   standalone PF/Sharpe clears the bar after honest 1s fills + EOD/hold rules.
2. **Quality gate for a future standalone mean-reversion strategy** rather than a book overlay.

## Files
`research/mtf-fib-confluence/` — `00-baseline.js`, `01-build-mtf-fib-levels.js`,
`02-annotate-fib.js`, `03-sweep.js`, `04-validate-winner.js`, `05-controls-sizing.js`,
`lib/{fib-confluence,book-with-fib}.js`, `output/{mtf-fib-active.json, glf-gfi-fib.csv}`.
