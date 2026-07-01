# gamma-clock research — does the "0DTE pros" article improve the 4-strat FCFS book?

**Source:** mathandmarkets.com — *"0DTE: What the Pros Are Really Doing While Reddit Sells Iron Condors"*
**Date:** 2026-06-26
**Question (Drew):** use 0DTE positioning to filter longs/shorts by time-of-day + order book; specifically
the article's "mean-reverting mornings, trending afternoons" → can a filter stop our longs/shorts getting
run over in the afternoon?

## Article's transferable claims
1. **Positive GEX (dealer long gamma) → dampening → mean-reversion**; **negative/collapsed GEX → amplification → momentum/trend.**
2. **Time-of-day:** dampening strongest AM, collapses ~2:00–2:30pm ET → afternoon = trend/run-over risk.
   Rules quoted: "no new entries after 2:00pm", "skip negative-GEX days (~20% of sessions) improves Sharpe."
3. The "order book" angle is NOT actually in the article — its signal is open-interest-derived GEX, which we already compute (NQ from QQQ). No order-flow technique given.

## What our data says (1s-honest; trades from the 4 gold-standard strategies)
Pipeline: `01-pnl-by-hour-side-gamma.js` (descriptive), `02-fcfs-gate-test.js` (FCFS portfolio gate test).
gammaSign from `deck-filters/lib/annotate.js` (NQ total_gex sign, ~78% coverage). Win=2025-01-13→2026-04-23, TRAIN≤2025-09-30.

### Finding 1 — the afternoon "run-over" thesis does NOT hold for our book.
PM (≥14 ET) trades hold up fine for EVERY strategy (often *better* than midday). Reason: the 15:45 ET EOD
flatten + each strategy's own baked-in hour filters already neutralize the late-day negative-gamma window.
There is nothing to fix on the clock axis. (Caveat: this means "no *residual* afternoon effect in our
already-filtered book," not "no afternoon effect exists in raw NQ.")

### Finding 2 — the real effect is gamma SIGN, cleanest on gex-level-fade SHORTS, and it matches the article.
glf is a fade (mean-reversion) strategy → article predicts it needs positive-gamma dampening. Confirmed,
train/test-consistent, on the short side:

| glf shorts        | ALL PF | TRAIN PF | TEST PF |
|-------------------|--------|----------|---------|
| gamma = POSITIVE  | 1.61   | 1.41     | 2.06    |  ← healthy
| gamma = NEGATIVE  | 1.00   | 0.88     | 1.12    |  ← ~zero edge (dead)

glf LONGS show a gamma effect too but it is train/test-INCONSISTENT (neg-gamma longs are good out-of-sample).
lstb / glx / gfi gamma effects are noisy or small-n — not reliably gateable.

NOTE: this refines (not contradicts) the prior deck-filters **A3** gamma gate. A3-H1 = "glf positive-gamma
only" (drop neg-gamma both sides) raised PF but here is shown to throw away good OOS glf longs. The surgical
short-only cut is better.

### Finding 3 — FCFS portfolio gate test (single 1-NQ slot; benefit = slot liberation)
Baseline: PF 1.77 / Sh 10.78 / DD 4.45% / DD$11,642 / $614,730.

| Gate | dropped | ALL PF | ALL Sh | TEST Sh | TEST DD$ | $ | verdict |
|------|---------|--------|--------|---------|----------|---|---------|
| **C1 glf short & g=neg** | 142 | **1.80** | **11.07** | **13.36** | 6,860 | 606,867 (−1.3%) | **WINNER — PF+Sh+DD all improve train AND test** |
| C2 glf any & g=neg | 350 | 1.83 | 10.88 | 12.41↓ | 6,260 | 587,772 (−4.4%) | higher PF but TEST Sharpe drops (cuts good OOS longs) |
| C3 C1 + lstb short g=pos | 1569 | 1.86 | 10.90 | 12.94 | 6,860 | 593,293 (−3.5%) | best PF/DD% but test Sharpe < baseline; lstb gate not clean |

## Verdict
- **The article's headline idea (afternoon time-of-day filter) adds NOTHING to our book** — already handled by EOD 15:45.
- The only real, robust, mechanism-justified lever is **gamma SIGN on glf fade shorts**, which is essentially
  the deck-filters **A3** idea (already "deployable, not deployed"). C1 is a cleaner, more surgical variant.
- **C1 is a small but genuine win**: ~+0.3 Sharpe, flat-to-better DD, −1.3% PnL, train/test consistent, only 142
  trades touched. Low-risk refinement, not a step-change.
- "Order book" filter: not supported by this article; our orderflow-sweep track already found 2nd-scale tape
  largely efficient. Not pursued here.

## Possible next steps (NOT done — exploratory)
- Raw-NQ market characterization (trendiness/efficiency-ratio by ET hour × gamma) to test whether the article's
  morning-MR/afternoon-trend is even true for NQ *independent* of our already-filtered strategies → would reveal
  untapped structure if any.
- Fold C1 into the existing deck-filters A1+A3 bundle rather than deploying standalone.

## Files
- `01-pnl-by-hour-side-gamma.js` / `output/01-*.txt` — descriptive slices (hour × side × gamma, per strategy, train/test)
- `02-fcfs-gate-test.js` / `output/02-*.txt` — FCFS portfolio gate test (note: C4 is a redundant dupe of C1)
