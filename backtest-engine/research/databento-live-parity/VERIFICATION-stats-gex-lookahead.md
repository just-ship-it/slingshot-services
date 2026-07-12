# Verification: stats-variant GEX lookahead in gfi + lgpr gold standards

**Date:** 2026-07-11
**Question (Drew):** we spent days eradicating lookahead a month ago — confirm methodically whether the current gfi and lgpr golds really used lookahead-contaminated GEX snapshots.
**Answer: CONFIRMED — with precision on what the May campaign did and did not fix, plus two additional findings discovered during verification.**

## What the 2026-04-30 → 05-06 campaign fixed (and didn't)

The 4 documented fixes (`data/gold-standard/lookahead-fix-history.md`):
1. cbbo GEX ts_event bucketing → fixed **cbbo variant** (`gex/nq-cbbo`) → glx, glf, iv-skew-gex ✔ clean
2. + 3. `precompute-iv.js` rounds → fixed the **ATM IV 1m CSV** → gfi's `--iv-resolution 1m` IV-percentile input ✔ clean
4. GEX snapshot spot-label (+15 min as-of relabel) → applied to `gex/nq`, `gex/nq-cbbo`, `gex-cbbo/nq` ✔ — **but NOT `gex/es`** (Finding C below)

The same campaign **added** `--iv-source cbbo` to `generate-intraday-gex.py` (commit `38dcf05`, 2026-05-02) — its docstring says verbatim: *"iv_source='stats' (default) uses stat_type 11 EOD close for every snapshot."* The cbbo option was used for the cbbo dirs; **the stats dirs (`gex/nq`, `gex/es`) were never regenerated causally.** So the campaign knew about this path and built the fix mechanism, but gfi/lgpr's input data still uses it un-fixed.

## Evidence chain

**1. What the golds consumed.**
- gfi v2 gold (`data/gold-standard/gex-flip-ivpct-v2.json`): `config.gexDir: null` → `backtest-engine.js:185` defaults to `data/gex` → `GexLoader` resolves ticker subdir → **`data/gex/nq/nq_gex_*.json`**.
- lgpr v1/v1-ES gold: command in STRATEGY-GOLD-STANDARDS.md explicitly `--gex-dir data/gex/nq`; the ES gate file `data/features/es15_clearpath_states.csv` was precomputed from **`data/gex/es`**.

**2. Provenance of those files.** All 802 `gex/nq` + 709 `gex/es` JSONs carry this generator's metadata format; the 30 newest stamp `iv_source: "stats"`, older ones predate the field (added 2026-05-02) — generated Jan/Feb/Apr 2026 when only the stats path existed for these dirs. Current script is the 05-02 version + the 05-06 label fix; the `stat_type == 11` close extraction (`load_statistics`, line ~93) is unchanged across every git version.

**3. The close prices are EOD, robustly.** Hour-of-publication histograms for `stat_type 11` on 5 sampled days across 2023/2024/2025/2026 (both `ts_event` AND `ts_recv`): **100% of close-price records publish 20:00–22:00 UTC (16:00–17:00 ET)**, zero premarket. OI (`stat_type 9`) publishes ~10:00 UTC (premarket, causal). So every intraday snapshot of day D is built with option prices from day-D's 4pm close.

**4. Mechanism.** Per snapshot: `time_value = EOD_close − intrinsic(intraday_spot)` → Brenner-Subrahmanyam IV → gamma → per-strike GEX → walls/support/resistance/flip/regime. The lookahead is in every field the strategies consume.

**5. Magnitude (counterfactual A/B, `counterfactual-stats-gex.py`).** Same generator code, same spot inputs; control = day-D closes (as shipped), causal = prior-day closes (premarket-knowable, best causally-achievable stats variant). 10 days spread 2023-06 → 2026-05, 580 snapshots:

| Metric (per-snapshot, day-mean) | Result |
|---|---|
| Regime label changed | **22.0%** of snapshots |
| Put wall at different strike | **57.8%** |
| Call wall at different strike | **47.2%** |
| Top-5 support set overlap (Jaccard) | **0.55** (~2 of 5 levels differ) |
| Support ordering changed | 96.7% |
| gamma_flip moved | median **206–925 pts** on 4/10 days; flip presence toggled up to 73% of snapshots (2026-05-14) |

**This is not cosmetic.** gfi trades gamma-flip crossings and regime; lgpr classifies path-clear/path-blocked from the support/resistance lists. Results in `counterfactual-nq-results.json`.

**Attribution caveat:** part of the A/B delta is *universe shrinkage* — ~30% of contracts (day-D-listed 0DTE/1DTEs, the highest-gamma ones) have no prior-day close, so the causal-stats arm drops them. That is itself part of the lookahead structure (a causal stats variant cannot price them), but it means "prior-day close" is NOT the right fix — the right fix is `--iv-source cbbo` (intraday quotes, full universe), which is also exactly what a live feed computes.

## Finding B (new): generator spot selection is non-reproducible

Control regen (day-D closes, current code) does NOT byte-match the shipped `nq_gex_2025-04-04.json`: 44 field diffs, all a constant ×1.00917 scaling = **different futures/ETF multiplier**. Cause: `load_ohlcv_for_date` greps the raw multi-contract CSV and keeps the *last row per 15-min bucket* — when two contract months (or, pre-repair, duplicate rows) print in the same minute, file row order decides which price becomes "spot". The OHLCV file has been extended (2026-06-16) and fragmentation-repaired since the shipped files were generated. Consequence: **shipped stats-GEX files cannot be exactly regenerated from current inputs**, and any regen (including the cbbo migration) will differ from the golds for this second reason too. Fix opportunity: make the loader roll-aware / primary-contract-aware (same per-hour volume rule as `filterPrimaryContract`).

## Finding C (new): `data/gex/es` never got the 2026-05-06 as-of relabel

`es_gex_*.json` snapshots are floor-labeled (day starts 08:00; NQ starts 08:15 post-relabel; generated 2026-02-10, before the fix; the fix history lists only the three NQ dirs as relabeled). So the ES files retain the **~14-minute spot-label lookahead** on top of the EOD-close IV issue. lgpr's v1-ES gate states were precomputed from these files → the **v1-ES gold (113tr / PF 5.10) is optimistic by construction on two counts**. (How much is unknown — gate states persist for hours, so the 14-min shift may be small; the IV issue is the bigger unknown.)

## Bottom line

| Strategy | GEX input | Status |
|---|---|---|
| glx, glf | `gex/nq-cbbo` | clean (post-May fixes) |
| iv-skew-gex | cbbo GEX + fixed IV CSV | clean |
| lstb | none | clean |
| **gfi** | `gex/nq` (stats) | **contaminated (EOD-close IV; IV-percentile input itself is clean)** |
| **lgpr v1** | `gex/nq` (stats) | **contaminated (EOD-close IV)** |
| **lgpr v1-ES** | `gex/nq` + `gex/es` | **contaminated (EOD-close IV + un-relabeled ES spot lookahead)** |

**Required before any Databento work proceeds:**
1. Regenerate `gex/nq` with `--iv-source cbbo` (QQQ cbbo exists locally 2023-03 → 2026-06).
2. `gex/es` needs BOTH the relabel and cbbo IV — but SPY cbbo-1m is NOT on disk (statistics only). Interim: regen ES stats variant with prior-day closes + as-of labels (causal but shrunken universe); proper: buy the SPY cbbo-1m backfill (~$350).
3. Re-run gfi v2 and lgpr v1/v1-ES golds on the regenerated data; expect material movement (each prior fix of this class cut PF); re-baseline the FCFS book.
4. Fix `load_ohlcv_for_date` contract selection (Finding B) in the same pass, or regens will carry a second uncontrolled diff.
