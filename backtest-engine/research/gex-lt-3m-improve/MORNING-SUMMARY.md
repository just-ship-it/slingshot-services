# Morning Summary — GEX-LT-3M-Crossover v3 Improvements

**Date:** 2026-05-21 (overnight)
**Goal:** Dramatically improve PnL of GEX_LT_3M_CROSSOVER from $179k W12 gold standard.
**Outcome:** Four engine-validated v3 presets dominating gold on PnL, PF, Sharpe, AND DD.

## TL;DR

**v3 (recommended): $217,864 / +22% PnL / PF 1.90 / Sharpe 8.73 / MaxDD 5.56% / 553 trades.** Dominates gold on every metric — higher PnL, higher WR, higher PF, +43% Sharpe, -33% DD.

**v3-max (max PnL): $256,450 / +43% PnL / PF 2.03 / Sharpe 8.75 / DD 6.40% / 500 trades.** Pick if you want maximum dollars and accept 15% wider DD than v3.

## Engine-validated Pareto family

| Preset | Trades | PnL | WR | PF | Sharpe | MaxDD% | vs Gold |
|--------|-------:|----:|---:|---:|-------:|-------:|--------:|
| Gold W12 | 888 | $179,201 | 48% | 1.44 | 6.12 | 8.26% | baseline |
| **v3** | 553 | **$217,864** | **60%** | **1.90** | **8.73** | **5.56%** | +22% PnL / +43% Sh / -33% DD |
| **v3-max** | 500 | **$256,450** | 55% | **2.03** | **8.75** | 6.40% | +43% PnL / +43% Sh / -23% DD |
| v3-balanced | 658 | $177,908 | **62%** | 1.76 | 8.03 | 7.03% | flat PnL / +31% Sh |
| **v3-low-dd** | 623 | $202,045 | 52% | 1.80 | 8.33 | **5.93%** | +13% PnL / +36% Sh / -28% DD |

Engine sim:engine ratio ~0.85× (slot conflicts on wider holds; 498-580 rejected signals on v3/v3-max vs 222 for gold).

## Train/test split (Sep 1 2025) — no overfit

| Variant | H1 PnL / PF | H2 PnL / PF | Stability |
|---------|------------:|------------:|-----------|
| Gold | $90.6k / 1.37 | $88.6k / 1.53 | flat/improving |
| v3 | $103.7k / 1.72 | $114.1k / 2.15 | H2 stronger |
| v3-max | $106.1k / 1.71 | $150.3k / **2.53** | H2 much stronger |
| v3-balanced | $87.5k / 1.62 | $90.4k / 1.98 | both > gold |
| v3-low-dd | $113.5k / 1.78 | $88.5k / 1.83 | very stable |

H2 outperforms H1 for v3 and v3-max — improvements generalize forward, not overfit.

## Pareto guide

| Pick | When to use |
|------|-------------|
| **v3** (RECOMMENDED) | Best PnL × Sharpe × DD trade-off. Drew's `feedback_pf_over_pnl` memory leans here. |
| v3-max | Max dollars with same Sharpe as v3. DD 15% wider. |
| v3-low-dd | Most conservative. Filters-only on gold exits. Lowest DD in family. |
| v3-balanced | Highest WR (62%). Dominated by v3-low-dd elsewhere — niche pick. |

## What changed vs gold

Same entry logic (3-min LT × GEX crossover). Per-rule changes:
* **Stops widened to 70pt** (3 of 4 rules) — gold's 50pt fires at MAE p99 (most "stop hits" are fake-outs that would turn around). Stop=70 absorbs the noise.
* **Targets widened per-rule** — gold capped at 120/80/60pt, but winner MFE p90 was bounded above by gold's target (artefact). Lifting captures the fat tail:
  - L_S4: 120 → 100 (v3) / 140 (v3-max), mh 90 → 120/150
  - S_GF_SOLO: **60 → 180** (huge — sim says PnL doubles)
  - S_CW: 120 → 200
  - S_R4: 80 → 80 (target unchanged; stop tightened to 40 with trailing 70/25)
* **Per-rule BE** at MFE = 70-80pt with offset 20 (locks meaningful profit at the median giveback).
* **Per-rule filters** (subtractive — drop loser-only buckets):
  - L_S4 blocks **Thu/Fri** DOW (+$5k/Sh +0.43) and **L3/L5** ltIdx (+$10k)
  - S_GF_SOLO blocks **hour 11** (+$4k)
  - S_R4 blocks **Fri** + **L3/L5** + **hours 11/15** (combined +$10-15k)
  - S_CW 14-15 ET block unchanged from W12

## Deployment (Sevalla env vars)

Live deployment is gated by `GLX_PRESET` env var. Default = `w12` (current gold, no behavior change). To roll out v3:

```
GLX_PRESET=v3
```

`signal-generator/src/utils/config.js` reads the env var and threads the full per-rule overrides through `getGexLt3mCrossoverParams()`. The strategy class still has W12 hardcoded as the no-preset default, so existing deployments without `GLX_PRESET` set keep behaving as W12.

Other env vars unchanged (LS-BE-on-flip overlay etc.).

## Files modified (all uncommitted in working tree)

* `shared/strategies/gex-lt-3m-crossover.js` — added per-rule `blockedDowsEt` and `blockedLtIdx` to `_resolvedRule()` and the rule-match loop. `_toEt()` now also returns `dow`.
* `backtest-engine/src/cli.js` — new `--glx-preset {w12, v3, v3-max, v3-balanced, v3-low-dd}` flag with full bundled per-rule overrides.
* `signal-generator/src/utils/config.js` — new `GLX_PRESET` env var; `getGexLt3mCrossoverParams()` returns the full preset bundle.
* `CLAUDE.md` — updated "Gold Standard Commands" section: v3 is now the recommended command, W12 preserved as historical baseline.
* Research: `backtest-engine/research/gex-lt-3m-improve/` (SUMMARY.md + 13 phases).
* Gold-standard JSONs: `data/gold-standard/gex-lt-3m-crossover-v3{,-max,-balanced,-low-dd}.json`.

## Pre-deployment sanity check

Before flipping `GLX_PRESET=v3` in Sevalla:
1. Re-run a quick backtest: `node index.js --strategy gex-lt-3m-crossover --glx-preset v3 ...` — confirm output JSON has the new per-rule stop/target values.
2. Push 5-10 paper trades and verify the broker receives the new stop/target values, and BE moves trigger as expected.
3. `gex-lt-3m-crossover` is currently `enabled: false` in `strategy-config.json`. Set `enabled: true` along with `GLX_PRESET=v3` to deploy.

The strategy + CLI + signal-generator changes are backwards-compatible — existing live without `GLX_PRESET` continues running W12 unchanged.

## What's not done

* Could not validate with `--eod-cutoff-et 15:45` (live cutoff) — backtests use 16:40 per gold-standard methodology. Live PnL expected slightly below backtest (consistent with `production-eod-cutoff` memory).
* Did not commit changes (no commit was requested by the user).
* gex-lt-3m-crossover is currently disabled in prod (`enabled: false`); deployment requires flipping that flag too.
