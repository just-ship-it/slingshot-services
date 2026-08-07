# 0DTE-Flow → Index-Futures — FINDINGS (2026-07-23)

**Verdict: comprehensive NULL.** 0DTE flow (QQQ→NQ) does not drive NQ opening ranges or day-to-day
mean-reversion levels in any way not already captured by price-based volatility clustering. One
mechanically-real effect (0DTE gamma sign → forward vol) is entirely redundant with recent realized vol.

Window: 2025-01-29 → 2026-01-28 (251 days, ~1yr), QQQ→NQ (SPX 0DTE unavailable — monthly-root-only data).
Method: intraday 0DTE dealer inventory from signed QQQ tape (quote-rule aggressor), 15-min snapshots, causal.
Controls: placebo levels, per-quarter stability, bootstrap p, incremental-over-recent-vol regression.

## Hypothesis results
| # | Hypothesis | Result |
|---|---|---|
| **H1** | pre-open 0DTE gamma sign → opening-range width / mean-reversion | **NULL** — insignificant (p .22–.99), signs flip every quarter; all-DTE ≥ 0DTE (opposite of thesis) |
| **H2** | intraday 0DTE gamma sign → NQ forward behavior | **VOL effect real** (long-gamma compresses range, short-gamma expands; p .005–.034, 4/5 quarters) but **directional/mean-reversion NULL** (autocorr p .18–.68) |
| **H2b** | 0DTE pin = a mean-reversion LEVEL for NQ (directional) | **NULL** — pin attraction slope −0.0009 (p .89); **pin loses to a prior-close placebo**; gamma-asymmetry→direction null |
| **H2c** | is the H2 vol effect INCREMENTAL over recent realized vol? | **NO — ΔR²=0.00000**, gamma-sign OLS t=−0.04; within recent-vol terciles gamma sign no longer separates. The vol effect IS vol clustering (A1). |
| **H3** | B4a pre-close continuation conditioned by 15:00 0DTE gamma | **NULL** — B4a ~flat on window (PF 0.99); regime splits small-n, quarter-unstable |

## Why (consistent with all prior work)
- Directional/level piece dead = the 5th independent confirmation that **GEX-type levels are placebo-equivalent**
  as magnets (after DWF-H0, R1-rejection, Wave-A, causal-gex touch-study). 0DTE-specific + flow-signed doesn't
  rescue it.
- Vol piece real but redundant: dealer-short-gamma coincides with elevated vol, and vol clusters — so 0DTE
  gamma "forecasts" forward vol only as a noisy proxy for recent vol. Price already contains it.
- The ONLY surviving dealer-flow edge remains DWF's flow-signed **level-interaction** (fade at dealer-long wall
  after flat stall, PF 1.33–1.53) — a conditional level-reaction, NOT a broad OR/mean-reversion driver.

## Reusable assets built (permanent, survive the null)
- `01-build-spx-signed-flow.py` — SPX signed flow via trades×cbbo-1m minute-BBO join (100% match). PARKED:
  our SPX data is monthly-root-only; needs **SPXW tape purchase** to run (0DTE cross-validation on ES).
- `02-qqq-0dte-daily-features.py` → `qqq-0dte-daily.csv` (overnight 0DTE book, causal).
- `04-qqq-0dte-intraday-inventory.py` → `qqq-0dte-intraday.csv` (**intraday time-evolving 0DTE dealer gamma**,
  251 days × 26 snaps — the core new dataset; reusable for any future 0DTE study).
- `05/06/07/08` — regime, close-charm, pin-attraction, incremental-vol test harnesses.

## Disposition
Thesis tested thoroughly; does not survive. Do NOT re-sweep 0DTE-level directional conditioners. If revisited:
(a) SPXW purchase would enable an ES cross-check of the (dead) directional claim — low expected value given
5 concordant nulls; (b) finer-than-15min gamma or true-TTE greeks could sharpen the vol effect but it's
redundant anyway. The vol-regime signal has zero incremental value over recent realized vol — use price.
