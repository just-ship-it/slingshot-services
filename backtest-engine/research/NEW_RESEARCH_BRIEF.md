# New Strategy Research Brief — clean-IV/clean-GEX correlation hunt

**Author:** prep handoff for new research agent
**Date:** 2026-05-02
**Scope:** identify NEW (uncorrelated with existing strategies) predictor → forward-NQ-return
relationships using the freshly corrected IV and GEX datasets.

---

## Mission (one line)

Find at most **3-5 predictor candidates** that pass a statistical bar against forward NQ
returns, on data that historically wasn't trustworthy. Promote each with a one-page
brief and reproducible code; do not implement strategies, just identify edges.

---

## What's already known — do NOT reinvent

These two strategies have been thoroughly mined and are at parameter-frontier. Don't
research variations.

- **iv-skew-gex** — QQQ 7-DTE put-call IV skew vs threshold + GEX-level proximity. Gold
  standard at PF 2.03 / Sharpe 5.71. Whole input space (skew thresholds × BE × TP/SL ×
  maxHold × proximity) is fully swept. See `data/gold-standard/iv-skew-gex-v8-balanced.json`.
- **short-dte-iv** — 0-DTE QQQ IV change over 15 min predicts NQ direction. 15m timeframe.
  Production parameters frozen. See `shared/strategies/short-dte-iv.js`.

Other implemented strategies (less mature, but still off-limits for direct iteration):
`lt-candle-regime`, `impulse-fvg`, `gex-scalp`, `es-cross-signal`. List in
`signal-generator/strategy-config.json`.

---

## Why this brief exists — the data history

Three correctness fixes in 2026-04-30 → 2026-05-01 invalidated all prior research. Past
findings in `research/FINDINGS.md` and prior scripts were trained on contaminated data:

1. **GEX `ts_event` bucketing bug**: late-arriving rows polluted earlier 15-min buckets
   with future-day quotes. Fixed → 40% of apparent edge was lookahead.
2. **`precompute-iv.js` bugs**: ts_event bucketing, no forward-fill, missing DTE
   tiebreaker, wrong expiration time. Fixed.
3. **precompute-iv → shared `calculateATMIVFromQuotes`**: precompute used QQQ ETF close
   as spot; shared (live) uses parity-derived spot from chain. Caused 1-2pp minute-to-minute
   IV "noise" we had attributed to data quality. After fix, backtest IV is byte-identical
   to live signal-generator IV.

**The clean datasets are**: `data/iv/qqq/qqq_atm_iv_1m.csv` (regenerated 5/1) and
`data/gex/nq-cbbo/nq_gex_YYYY-MM-DD.json` files. Use these. Do not use:
- `data/gex/nq/` (legacy, EOD/lookahead-biased)
- `data/iv/qqq/qqq_atm_iv_1m_smoothed.csv` (obsolete, was a workaround for the noise that turned out to be a calc bug)
- Any `iv-skew-gex-cbbo-v6-*` or `iv-skew-gex-v7-*` JSONs in `data/gold-standard/` (built on broken IV)

Validation parity confirmed 2026-05-02: cbbo-derived walls match Schwab live-snapshot
walls within ~1 strike on calls/puts and ~1-3 QQQ pts on gamma flip across 4/29-5/1.

---

## Data inventory (clean, available, in scope)

All paths relative to `backtest-engine/`.

### Predictor sources

| Path | Granularity | Date range | Notes |
|---|---|---|---|
| `data/iv/qqq/qqq_atm_iv_1m.csv` | 1-min | 2025-01-13 → 2026-04-23 | ATM call/put IV + skew |
| `data/iv/qqq/qqq_short_dte_iv_15m.csv` | 15-min | Jan 2025 → Jan 2026 | 0-DTE IV (used by short-dte-iv) |
| `data/gex/nq-cbbo/nq_gex_YYYY-MM-DD.json` | 15-min | 2025-01 → 2026-05-01 | call/put walls, gamma flip, regime, total GEX/VEX/CEX, gamma_above/below_spot, gamma_imbalance |
| `data/gex/es-cbbo/` | 15-min | similar coverage | ES equivalent |
| `data/liquidity/nq/` | per-bar | check coverage | LT levels (S1-S5, R1-R5) |
| `data/liquidity/es/` | per-bar | similar | ES equivalent |
| `data/statistics/qqq/opra-pillar-YYYYMMDD.statistics.csv` | daily | 2025+ | OI per contract, EOD prices |
| `data/cbbo-1m/qqq/` | 1-min | similar | raw bid/ask per option (large; only use if computing custom features) |
| `data/charm-vanna/` | check | check | second-order Greeks if relevant |

### Response source

| Path | Granularity | Notes |
|---|---|---|
| `data/ohlcv/nq/NQ_ohlcv_1m.csv` | 1-min | **MUST use `filterPrimaryContract()` + `--raw-contracts`-equivalent in your code**. Filter calendar spreads (symbol contains `-`). |

### Cross-asset (optional context)

| `data/ohlcv/es/ES_ohlcv_1m.csv` | ES futures |
| `data/ohlcv/qqq/QQQ_ohlcv_1m.csv` | QQQ ETF |
| `data/ohlcv/spy/SPY_ohlcv_1m.csv` | SPY ETF |

---

## Candidate predictor categories — ranked by expected novelty

Prioritize categories higher up. Skip anything that's just a re-frame of skew-vs-spot.

### Tier 1 — most likely to find new edge

1. **GEX magnitude regime (not levels)** — total_gex Z-score over rolling 30-day; gamma_imbalance over rolling window; transitions between regime states (positive ↔ negative gamma). Predict forward realized vol or trend persistence, not direction.
2. **Wall proximity asymmetry** — `(call_wall - spot) - (spot - put_wall)`, normalized by ATR. Hypothesis: when path to call wall is much shorter than path to put wall, mean-reversion bias.
3. **Gamma flip distance + direction** — distance from spot to gamma_flip, and rate of change of gamma_flip itself (gamma_flip moving away from price = trend persists; toward price = reversion likely).
4. **IV term structure** — ratio of 1-DTE IV (`qqq_short_dte_iv_15m.csv`) to 7-DTE IV (`qqq_atm_iv_1m.csv`). Backwardation vs contango. Predict trend persistence.
5. **IV crush events** — large 30-min IV drops while NQ stays in range. Setup for breakout.

### Tier 2 — fallback if Tier 1 is dry

6. Cross-asset SPY/QQQ skew divergence vs ES/NQ leadership.
7. Gamma flip crossover events (spot crosses gamma_flip going up vs down).
8. LT-level + GEX-wall confluence (where they coincide vs disagree).
9. OI delta day-over-day at specific strikes near walls.
10. Time-of-day × regime interactions (does positive gamma at 14:00 UTC differ from 19:00 UTC?).

### Off-limits — won't be accepted as findings

- Skew threshold variations (already at frontier)
- 0-DTE IV change at 15m (covered by short-dte-iv)
- LT levels alone (covered by lt-candle-regime / overnight research)
- Any FVG/impulse-candle work (covered by impulse-fvg)

---

## Response variables — pick one or two, not all

For each predictor, regress against:

- **Primary:** forward NQ log-return at +15min, +1h. Continuous.
- **Secondary (path-dependent):** does NQ reach +X pts before -Y pts (path target/stop)? Binary.
- **Tertiary (regime):** forward realized vol over +30min window. Continuous.

**Do NOT use raw forward returns at +1m / +5m** — those are dominated by microstructure
noise and won't separate signal from noise at the n we have.

---

## Statistical bar — what counts as "promotable"

A predictor is promotable to backtest only if it meets ALL of:

1. **n ≥ 500** observations (so we have ~2 years × 250 days × at least 1 obs/day, or
   subsample similarly).
2. **|Spearman r| ≥ 0.10** (rank correlation, not Pearson — robust to outliers).
3. **Effect size:** the top-decile vs bottom-decile of predictor produces a ≥ 5 NQ-pt
   difference in mean forward return at +15min, OR a ≥ 5pp difference in directional
   hit rate at +1h.
4. **Train/test stability:** split data 70/30 chronologically. Effect size in test must
   be at least 50% of train. Reject anything that doesn't replicate.
5. **No data leakage:** the predictor must be observable strictly *before* the response
   window. Common pitfall: using GEX from the snapshot at T to predict NQ from T+1m
   — but the GEX snapshot is timestamped at the bucket *boundary* (15-min mark), so
   make sure your alignment respects this. When in doubt, lag by one full snapshot.

A "fail" is fine. Most predictors won't pass. The point is to filter cleanly.

---

## Output format — strict

For each predictor explored, the agent must emit:

1. **One row** in a master `research/output/clean-iv-gex-correlations.csv` with columns:
   `predictor_id, predictor_description, response, n, spearman_r, p_value, top_decile_effect, bottom_decile_effect, train_test_ratio, promotable, notes`

2. **A separate JS file** under `research/clean-iv-gex/<predictor_id>.js` that
   reproduces the calculation end-to-end. Self-contained; runnable as `node <file>`.
   Must print n, r, effects, and write a row to the master CSV.

3. **For promoted predictors only** (passed all 5 bars), one markdown brief at
   `research/clean-iv-gex/<predictor_id>.md` (max 1 page) with: hypothesis, exact
   feature definition, n, effect sizes by decile (table), train-test split numbers,
   and a single suggested entry rule for backtesting.

**Do not write narrative findings docs. Do not summarize prior research.** The CSV is
the deliverable; the briefs are entry points for follow-on backtests.

---

## Scope guardrails — hard limits

- **Stop at 5 promoted predictors.** If more pass, rank by effect size × n and keep top 5.
- **Time budget:** ~6 hours of agent compute. If a predictor calculation takes > 20 min, skip.
- **No new strategy implementations.** Promotion = "worth backtesting." Backtesting is a separate task for the human or a later agent.
- **No parameter sweeps within this brief.** A predictor either has natural definition or it doesn't. No `for threshold in [0.01, 0.02, ..., 0.30]` over-fitting.
- **No machine learning.** Linear/rank correlation only. ML on n~500 with 10+ features is overfitting theater.

---

## Critical data caveats — agent will fail without these

1. **Raw vs continuous OHLCV**: `NQ_ohlcv_1m.csv` is raw contracts. **Must filter calendar
   spreads** (symbol contains `-`) **and use `filterPrimaryContract()` from
   `src/data/csv-loader.js`** when loading. Continuous price (`NQ_ohlcv_1m_continuous.csv`)
   is shifted by accumulated roll spreads — DO NOT use it with GEX/LT levels.
2. **Contract rollover**: at rollover dates (see `data/ohlcv/nq/NQ_rollover_log.csv`)
   the primary contract switches and price "jumps" by the roll spread (200-300 NQ pts).
   Either work in returns (jump cancels) or skip rollover days.
3. **Bucket fragmentation post-2026-01-29**: `NQ_ohlcv_1m.csv` had duplicate same-minute
   rows from this date — repaired 2026-04-30 via `scripts/repair-ohlcv-fragmentation.js`,
   verify before using.
4. **GEX snapshot timestamp = bucket boundary**: `nq_gex_YYYY-MM-DD.json` snapshots are
   labeled at the 15-min boundary (HH:00, HH:15, HH:30, HH:45). The snapshot reflects
   the chain state at the *end* of the 15-min window. To use as a predictor at time T,
   ensure T is *after* the snapshot timestamp.
5. **5/2/2026 onward not in data**: the most recent IV CSV regen is dated 2026-04-23.
   Limit response windows to before this.
6. **Skew is positive-baseline, not zero-baseline**: structural ATM put-call skew on
   QQQ 7-DTE sits at +1.74%. Do not center predictors at 0 — center at the rolling
   median or use rank/Z-score.

---

## What to read first (in order, ~30 min total)

1. `CLAUDE.md` — top-level repo orientation. Sections: "Backtest Engine" → "Gold Standard Commands"; "CRITICAL: Price Space & Contract Rollover Rules"; "Backtest Data: Additional Filtering Rules".
2. This file.
3. `research/FINDINGS.md` — historical findings (treat with skepticism — most predate the IV/GEX corrections).
4. `data/iv/qqq/qqq_atm_iv_1m.csv` — first 5 rows, understand schema.
5. One sample `data/gex/nq-cbbo/nq_gex_2026-05-01.json` — understand the snapshot
   structure (see `data` array with per-snapshot metadata: gamma_flip, call_wall,
   put_wall, gamma_imbalance, regime, etc.).

---

## Deliverables — checklist for the human reviewing the agent's output

- [ ] `research/output/clean-iv-gex-correlations.csv` with one row per predictor explored
- [ ] One JS file per predictor under `research/clean-iv-gex/`
- [ ] One MD brief per *promoted* predictor (max 5)
- [ ] No narrative findings doc (skip even if tempted)
- [ ] No edits to `shared/strategies/`, `signal-generator/`, or anywhere outside `research/`
- [ ] Runtime under 6 hours total

---

## When stuck

- Predictor doesn't have natural decile structure (e.g., binary event): use mean
  forward return when event=true vs false, plus n in each bucket.
- Cross-asset features needing alignment: use 5-min bars, accept some smoothing.
- If raw correlation is r=0.05 with n=10000: that's a "fail" with high confidence
  — record and move on, don't try to rescue.
- If you find a very strong signal (r > 0.25, large effects): triple-check for
  data leakage. Stronger than expected almost always means a bug.
