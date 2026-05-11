# First-Hour RTH NQ Strategy — Overnight Research Plan

**Date kicked off:** 2026-05-09
**User goal:** Single trade per day, 9:30–11:00 ET window, 20–30+ NQ point target. Phase 2 = partials + runners.
**Mandate:** Be exhaustive. Every promising finding must produce: entry rule, stop/target params, expected frequency, and a path to backtest-engine integration.

## Hard Rules (CRITICAL — apply to every track)

1. **Raw contracts only** — load `NQ_ohlcv_1m.csv` and call `filterPrimaryContract()` from `csv-loader.js`. Continuous prices break LT/GEX comparisons. See CLAUDE.md "Price Space & Contract Rollover Rules".
2. **GEX = post-bucketing-fix CBBO** — use `data/gex/nq-cbbo/` (325 days, 2025-01-13 → 2026-05-01). The 2026-05-06 lookahead fix has been applied; do NOT use any GEX figures published before that date as ground truth.
3. **All times in ET** for windowing, but timestamps in source data are UTC. Use `toET`/`fromET` from `research/utils/data-loader.js`.
4. **Skip trade if signal/entry would land inside a contract rollover boundary** — see `data/ohlcv/nq/NQ_rollover_log.csv` for roll dates.
5. **Date range:** 2025-01-13 → 2026-04-23 (15 months) unless data dictates a tighter window. Hold out last 2 months for OOS where statistically meaningful.
6. **Output format:** every track writes `T{N}-FINDINGS.md` to this directory plus any data files to `output/`.

## Track Roster

| Track | Hypothesis | Status |
|---|---|---|
| T0 | Baseline first-hour MFE/MAE/range distribution | dispatched |
| T1 | Pre-RTH sweep prediction (90.5% OOS) + RTH-timed reversal entry | dispatched |
| T2 | Pre-RTH sweep features generalize to direction even without sweep | dispatched |
| T3 | 0-DTE QQQ IV at 9:30 → first-hour NQ direction | dispatched |
| T4 | 15-min ORB with GEX/IV/sweep-prediction filters | dispatched |
| T5 | GEX wall reaction at the open (rejection vs breakthrough) | dispatched |
| T6 | Initial Balance failure reversal (10:30 IB extension → re-entry) | dispatched |
| T7 | Overnight High/Low retest in first hour | dispatched |
| T8 | Gap × GEX regime first-hour bias matrix | dispatched |
| T9 | Day-of-week & event-day kill-switch filters | dispatched |
| T10 | Opening drive (wide+volume first 5/15m) continuation | dispatched |
| T11 | VWAP reclaim/rejection at the open | dispatched |

## Output Schema for Each Track

Each `T{N}-FINDINGS.md` must contain:

```markdown
# T{N}: {Title}

## TL;DR
{2-3 sentences: hypothesis, did it hold, headline number}

## Dataset
- Date range, sample count, exclusions

## Findings
{Tables / bullets with conditional probabilities, MFE/MAE distributions}

## Proposed Strategy v0
- Entry: {exact rule}
- Side: {long/short logic}
- Stop: {points + rationale, ideally tied to MAE distribution percentile}
- Target: {points + rationale, ideally tied to MFE distribution percentile}
- Time stop: {bars or ET cutoff}
- Expected frequency: {trades/day or trades/month}
- Expected per-trade EV (if computable)

## Backtest-engine integration sketch
- New strategy file location, key params, CLI flags

## Caveats / Followups
```
