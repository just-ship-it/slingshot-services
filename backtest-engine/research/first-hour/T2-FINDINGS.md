# T2: Pre-RTH Sweep Features → First-Hour Direction

## TL;DR

The pre-RTH features from `pre-sweep-prediction.js` (90.5% sweep-side OOS) **DO** generalize to first-hour direction (9:30–11:00 ET) — but the strongest single signal is **GEX wall asymmetry**, NOT the original "score" composite that was tuned for the sweep problem. A simple rule "long if (call_wall − price) − (price − put_wall) ≥ 150 pts; short if ≤ −150 pts" produces **218 trades / 70.6% WR / PF 2.06 / Sharpe 5.65 / DD $401 (in NQ pts)** on 13 months of in-sample data with a 75pt TP / 100pt SL, and holds up OOS at **n=37, 67.6% WR, PF 1.65, Sharpe 3.95** — a meaningful edge above the 50/50 baseline.

Stacking LT sentiment on top (R2: wallAsym ≥ 100 + LT bullish or wallAsym ≤ −100 + LT bearish) raises in-sample to **PF 4.01 / Sharpe 11.43** and OOS to **PF 1.81 / Sharpe 4.68 (n=26)**. The triple-confluence R5 (wall asym + LT + gamma-flip side) hits PF 6.29 / Sharpe 15.72 IS but trades only 61 days IS / 3 days OOS — too narrow to validate.

## Dataset

- Range: 2025-01-13 → 2026-04-23 (15 months)
- Total trading days processed: **325** (skipped 4 — 1 rollover, 3 short-RTH)
- In-sample: 283 days (2025-01-13 → 2026-02-22)
- OOS: 42 days (2026-02-23 → 2026-04-23)
- Source: NQ raw 1m OHLCV with `filterPrimaryContract()`, post-fix CBBO GEX (`data/gex/nq-cbbo/`), LT levels (`data/liquidity/nq/`)

### Baseline (no rule)

- Up days (close_11:00 > open_9:30): **47.4%** | Down: 52.6% | avg MFE: 100.4 / avg MAE: 110.1
- Race base rates (which threshold is hit first):
  - 30pt: up 49.5% / dn 47.7% (1.8% edge — almost no asymmetry)
  - 50pt: up 47.7% / dn 47.7% / neither 4.6% (perfectly balanced)
  - 75pt: up 43.7% / dn 44.6% / neither 11.7%
  - 100pt: up 37.5% / dn 40.0% / neither 22.5%

The market does NOT have an inherent bullish or bearish first-hour bias — base rate is ~50/50. Any edge has to come from features.

## Findings

### Single-feature buckets (in-sample, n=283)

| Feature | Bucket | n | up% | avgNet | race50 edge |
|---|---|---:|---:|---:|---:|
| **gex_wall_asymmetry** | ≥ 150 | 109 | **70.6** | +64.4 | +14.7 |
| | ≤ −150 | 109 | **35.8** | −65.2 | −24.8 |
| **gex_call_wall_dist** | ≥ 300 | 148 | 63.5 | +32.3 | +8.8 |
| | < 50 | 22 | **22.7** | −86.2 | −54.5 |
| **gex_put_wall_dist** | < 50 | 39 | **74.4** | +69.4 | +23.1 |
| | ≥ 300 | 145 | 40.0 | −50.0 | −22.8 |
| **gex_imbalance** | ≤ −0.5 | 55 | 61.8 | +50.0 | +1.8 |
| | ≥ 0.5 | 80 | 43.8 | −17.1 | −18.7 |
| **gex_regime** | strong_negative | 14 | **85.7** | +163.9 | −42.9* |
| | strong_positive | 14 | 21.4 | −42.1 | −35.7 |
| **gex_gamma_flip_position** | below | 142 | 55.6 | +20.2 | −8.5 |
| | above | 57 | 36.8 | −83.9 | −21.1 |
| **lt_sentiment** | BULLISH | 149 | **65.1** | +33.4 | +19.5 |
| | BEARISH | 134 | **38.8** | −43.8 | −36.6 |

*strong_negative regime sample is too small to read the race-edge sign reliably*

The original sweep-prediction features (price_position_in_on_range, overnight_bias, gap_from_pdc) are **WEAKER** for first-hour direction than they are for sweep direction. Their first-hour up/down splits hover around 45–55% — they predict *which side gets touched* but not whether the day closes up or down by 11:00.

### Correlations with net first-hour points (in-sample)

| feature | r | n |
|---|---:|---:|
| gex_wall_asymmetry | **+0.27** | 274 |
| gex_call_wall_dist | **+0.25** | 274 |
| gex_imbalance | −0.18 | 271 |
| gex_put_wall_dist | −0.17 | 274 |
| gap_from_pdc | −0.15 | 282 |
| overnight_range | +0.14 | 283 |
| asian_range | +0.11 | 283 |
| asian_position | −0.08 | 283 |
| overnight_bias | −0.07 | 283 |
| lt_asymmetry | −0.07 | 283 |
| price_position_in_on_range | −0.02 | 283 |

**GEX wall geometry dominates.** Overnight-context features that drove the original 90.5% sweep predictor are essentially noise for the close-by-11:00 question.

### Rule sweep (in-sample)

Best Sharpe per rule (TP/SL grid over {30, 50, 75, 100} pts):

| Rule | Best TP/SL | n | WR | PF | Sharpe | totalPts | DD |
|---|---|---:|---:|---:|---:|---:|---:|
| R1_wallAsym (≥150 long, ≤−150 short) | 75 / 100 | **218** | 70.6 | 2.06 | 5.65 | 5,682 | 401 |
| R2_wallAsymPlusLT (≥100 + BULLISH or ≤−100 + BEARISH) | 50 / 75 | 143 | 83.2 | 4.01 | 11.43 | 4,400 | 175 |
| R3_wallDist (put<50 long, call<50 short) | 75 / 100 | 61 | 80.3 | 3.42 | 10.06 | 2,481 | 200 |
| R4_ltAndFlip (BULLISH+flip-below or BEARISH+flip-above) | 30 / 75 | 101 | 89.1 | 3.55 | 9.79 | 1,940 | 201 |
| R5_combo (wallAsym + LT + flip side) | 75 / 100 | 61 | 86.9 | 6.29 | 15.72 | 3,163 | 154 |
| R6_imbalance (≤−0.4 long, ≥0.4 short) | 75 / 100 | 160 | 66.9 | 1.85 | 4.72 | 3,486 | 325 |
| R7_score (sweep-prediction net composite) | 30 / 30 | 148 | 55.4 | 1.24 | 1.73 | 480 | 270 |

R7 (the original score) is **the worst** — confirmation that the sweep-side composite is not the right scaffold for first-hour direction.

### OOS (last 2 months, n=42 days max)

| Rule | TP/SL | n | WR | PF | Sharpe | totalPts |
|---|---|---:|---:|---:|---:|---:|
| R1_wallAsym | 75/100 | **37** | 67.6 | **1.65** | **3.95** | 738 |
| R2_wallAsymPlusLT | 50/75 | 26 | 73.1 | 1.81 | 4.68 | 425 |
| R3_wallDist | 75/100 | 10 | 80.0 | 3.00 | 9.07 | 400 |
| R4_ltAndFlip | 30/75 | 9 | 77.8 | 1.40 | 2.42 | 60 |
| R5_combo | 75/100 | 3 | 66.7 | 1.50 | 3.21 | 50 |
| R6_imbalance | 75/100 | 36 | 58.3 | 1.10 | 0.72 | 138 |
| R7_score | 30/30 | 20 | 35.0 | 0.54 | −4.99 | −180 |

Decay vs in-sample is substantial (R1 PF 2.06 → 1.65, R2 PF 4.01 → 1.81), but the *direction* of the edge is preserved on every rule except R7 and R6. R7's in-sample edge was almost entirely overfit; R6 still works but barely. **R1 is the workhorse** — best frequency among the rules with PF > 1.5 OOS — and R2 stacks reliably for higher selectivity.

## Proposed Strategy v0

**Two-tier rule** designed to trade roughly 1 day in 6 with the option to add a higher-conviction tier.

### Tier 1 — wallAsym (workhorse)

- **Entry time:** 9:30 ET on RTH open bar (place limit at 9:30 open, or market at 9:30 + 5s)
- **Side:**
  - LONG if `(call_wall − price_9:30) − (price_9:30 − put_wall) ≥ 150 NQ pts`
  - SHORT if same expression `≤ −150 NQ pts`
  - Otherwise no trade
- **Stop:** 100 NQ pts adverse (entry ± 100; equity-curve DD plateaus past 75pt SL)
- **Target:** 75 NQ pts favorable
- **Time stop:** 11:00 ET (90 minutes from open)
- **Expected frequency:** ~218 trades / 283 IS days = **77% of days = ~16 trades/month** (very high — this is more like a daily directional filter than a setup)
- **Expected per-trade EV (in-sample):** +26 NQ pts/trade ≈ **$520/contract** in NQ ($130/contract MNQ)
- **Expected EV (OOS):** ~+20 pts/trade

### Tier 2 — wallAsymPlusLT (selective)

- Same as Tier 1 but require `lt_sentiment === 'BULLISH'` for long, `=== 'BEARISH'` for short, and lower the threshold to ±100 pts.
- **Stop:** 75 pts | **Target:** 50 pts | Time stop 11:00 ET
- **Expected frequency:** ~143 trades / 283 days = ~50% of days = ~10/month
- **Expected per-trade EV (in-sample):** +30 NQ pts/trade
- **Expected EV (OOS):** +16 NQ pts/trade

If "single trade per day, 20–30+ pt target" is the goal, **Tier 1 with TP=30 / SL=75** also works very well: n=218, WR=78.9%, PF=1.54, Sharpe=3.11, DD=$300, total=1,798 pts in-sample. That fits the 20-30pt target spec with a more conservative profile.

### Why the rule works (intuition)

A large positive `gex_wall_asymmetry` means the call wall is far above price while the put wall is close beneath — i.e., dealers are short downside gamma and long upside gamma. The hedge-flow asymmetry tilts intraday flows in the bullish direction. Symmetric logic for the short side. This is a structural-flow read, distinct from the sweep-prediction score (which measures position within a range).

## Backtest-engine integration sketch

- **New strategy file:** `shared/strategies/first-hour-wall-asym.js`
- **Inputs the strategy needs at 9:30 ET:**
  - latest GEX snapshot (call_wall, put_wall) → already published on `gex.levels` channel
  - LT sentiment from latest `lt.levels` payload (Tier 2 only)
  - Spot price (open of 9:30 1m bar)
- **Lifecycle:**
  - At 9:30:00 ET on RTH days, evaluate threshold; emit `place_market` with side, SL, TP, and a `time_exit_at: 11:00 ET`.
  - Skip the trade if the position is already open, if it's a holiday, or if the most recent GEX snapshot is older than 30 min.
- **CLI flags for backtest engine:**
  - `--strategy first-hour-wall-asym`
  - `--fhwa-tier {1|2|combo}` (default 1)
  - `--fhwa-asym-threshold 150`
  - `--fhwa-tp 75 --fhwa-sl 100 --fhwa-time-exit 11:00`
  - `--fhwa-require-lt-sentiment` (Tier 2)
- **Engine integration**: should reuse the existing 9:30 ET RTH-day filter pattern and the `place_market` execution path. EOD cutoff/cancel not required since time_exit at 11:00 is well within RTH.

## Caveats / Followups

1. **OOS sample is small (42 days, 26–37 trades depending on rule).** R1's OOS PF=1.65 / Sharpe=3.95 is suggestive but noisy; another 6-month walk-forward would tighten the confidence interval.
2. **GEX snapshot used here is the 9:15 ET snap (closest to 9:30 due to 15-min bucketing, post-fix).** In live, ensure the 9:30 evaluation uses a snap timestamp ≤ 9:30. The post-fix CBBO labels are now as-of timestamps so this is straightforward.
3. **Race outcomes** for thresholds 30/50/75/100 are similar but slightly favor 30 and 50 pt targets (higher hit rate before opposite SL); the rule sweep already captures this. The 30/75 variant of R1 is a great "20-30pt target" strategy and has the highest WR.
4. **Tier 2 (wallAsymPlusLT) is the natural next step** if Tier 1's frequency feels too high — drops to ~50% of days but materially improves PF.
5. **Has not been combined with T1 (post-sweep reversal)** — these may be complementary on different day types.
6. **R3 (wallDist proximity)** is the most exotic — it fires only when price opens *at* a wall (≤50pts away). Only 61 IS / 10 OOS trades, but the OOS PF 3.0 hints there may be additional edge in this niche worth deepening.
7. **R7 score collapse OOS confirms that the original sweep-prediction composite was overfit to that specific problem** and does not transfer to first-hour direction prediction.
