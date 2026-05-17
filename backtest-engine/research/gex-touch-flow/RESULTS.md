# GEX-Touch Flow — Research Findings (2026-05-14)

## TL;DR — Honest answer

**The 90% WR scalp at the GEX touch event level isn't there in the data we have.** I ran the full 1s-honest research the user requested, mined 27,201 GEX touches over 12 months across 49 microstructure features, and the highest stable WR I could find on a 15-20pt scalp with tight stops is **~43% on ~300 trades/year (+$5k/year gross on 1 contract)**. Higher-WR cells exist (70-82% on 77-107 trades) but are small-sample overfit — by-month stability shows wild swings (0% in Oct 2025, 65% in Sep 2025) and they lose money under realistic concurrency + slippage.

**What this means:** the "ride the dealer wave / quick win / 90% WR" framing requires a different data resolution than 1m OHLCV + 1s OHLCV + 15min GEX snapshots. The signal that distinguishes "dealer defending" from "dealer capitulating" lives in order book / quote / tape data, not in the OHLCV aggregates we have. To make this strategy work at 90% WR would require ingesting order book L2 or tape data and computing real-time absorption / aggression signatures — not something we can do with the existing data pipeline.

**The existing gex-touch-patterns strategy (33% WR, $38k/year on 1 contract) is actually well-tuned for the data resolution we have.** It uses bigger targets (20-150pt) which dilute slippage drag.

---

## What was tested

### Phase 1 — Enriched touch dataset (27,201 touches over 272 trading days, Jan 13 2025 → Jan 28 2026)

For every touch within 10pt of any GEX level (S1-S5, R1-R5, gamma_flip, call_wall, put_wall), captured **49 features**:

- **Approach signature** (5/15/30min rolling): speed, consistency, distance traveled, ATR, range/ATR ratio
- **Touch-bar 1m features**: range, body position, body/range ratio, upper/lower wicks, wick-at-level, close relative to level, engulfing, pin-bar, doji flags
- **Volume features** ("big boys" hypothesis): touch-bar volume, ratios vs 5/15/30min mean, 15m z-score, trend slope/sign, max-to-mean over 5min
- **1s flow features** (within touch minute): closest distance to level, max penetration, max wick past level, seconds at level, first rejection second, total/top3 1s volume, vol concentration
- **Level context**: level type, GEX magnitude, rank in snapshot, regime, gamma imbalance, distance to next opposite/same-side level
- **History**: tests of this level today so far
- **Session**: minute of day, TOD bucket, day of week

For each touch, walked 1s OHLCV forward 30min in both directions (bounce = away from approach, break = continuation):
- MFE/MAE per horizon at 1/2/3/5/10/15/30min
- Time-to-first-hit at target tiers {5, 7, 8, 10, 12, 15, 18, 20, 22, 25}pt
- Time-to-first-stop at tiers {3, 4, 5, 6, 7, 8, 10, 12, 15}pt
- Close prices at horizons

**Dataset:** `research/output/gex-touch-flow-2026-05-14T05-52-19-372Z.json` (~70MB)

### Phase 2a — Baseline outcome rates

For T=20pt / S=8pt / H=15min (R:R 2.5:1; theoretical random-walk breakeven ≈ 28.6%):

| Direction | n | W | L | TO | WR |
|---|---:|---:|---:|---:|---:|
| Bounce | 27,201 | 6,618 | 18,047 | 2,536 | 24.3% |
| Break | 27,201 | 6,624 | 18,272 | 2,305 | 24.4% |

- **Bounce-only winners**: 24.3%
- **Break-only winners**: 24.4%
- **Both directions hit 20pt**: 0% (mutually exclusive)
- **Neither hits 20pt (chop)**: 51.3%

WR matches random-walk expectation almost exactly. **The market is efficient at GEX levels — no free 20pt move on average.**

### Phase 2b — Config sweep across (target, stop, hold)

Tested 30 combinations. Top single-feature filters max out at **~32% WR** above baseline ~24%. Top pair-feature filters reach **~70% WR** only on tiny samples in narrow numeric buckets.

Best pair filter found: `gamma_imbalance ∈ (0.036, 0.264] AND dist_next_break_level ∈ (207.1, 208.22]` → **70.1% WR on n=107** (break direction, T15/S12/H15)

### Phase 2d — Drill-down into the 70% WR filter

The narrow `dist_next_break_level` bucket d6 spans only ~1 NQ pt (~207.1 to 208.22) — it's a **discretization artifact** of GEX level spacing. Looking at the 107 matched touches:

| Breakdown | n | WR |
|---|---:|---:|
| approach = from_below | 77 | **81.8%** |
| approach = from_above | 30 | 40.0% |
| level = put_wall | 15 | 93.3% |
| level = S1 | 15 | 93.3% |
| level = S2 | 23 | 73.9% |
| level = R4 | 23 | 47.8% |
| TOD = pre_rth_early (<09:00 ET) | 24 | 87.5% |
| TOD = rth_aft (13:00-15:30) | 23 | 56.5% |

**But by-month stability is poor:** Sep 2025 = 64.7% on n=34 vs Oct 2025 = 0% on n=10. The 70% WR is concentrated in specific market regimes, not stable across time.

### Phase 2e — Relaxing the filter

When we relax `dist_next_break_level` from the narrow d6 band to `>= 100pt` (generalizable "lots of room"), WR collapses:

| Rule | n | WR | EV |
|---|---:|---:|---:|
| V1 (original narrow pair) | 107 | 70.1% | +$133/trade |
| V2 (+ from_below filter) | 77 | 81.8% | +$202/trade |
| V3 (relaxed dist ≥ 100, all good levels) | 593 | 43.5% | **+$1.6/trade (essentially zero)** |
| V4 (V3 narrowed to put_wall/S1/S2) | 510 | 42.2% | -$1/trade |

The narrow band was the load-bearing constraint, and it doesn't generalize.

### Phase 2f — Tight-scalp configs

User specifically asked about "15 or 20 point move." Tested all combinations of T={5,7,8,10,12,15} × S={3,5,8,10}:

- T5/S3 baseline = **37.1% WR** (random-walk breakeven for 5:3 R:R is ≈37.5%) — no edge
- T5/S5 baseline = **49.3% WR** (R:R 1:1, breakeven = 50%) — no edge
- T10/S5 baseline = **31.7% WR** (R:R 2:1, breakeven = 33.3%) — no edge
- T8/S8 baseline = **47.9% WR** (R:R 1:1, breakeven = 50%) — no edge

**EV per trade is zero across the board.** Every config matches the random-walk breakeven within 1-2pp.

### Phase 2g — Pin-bar bounce setups ("wicks below closes above")

User specifically described this scenario. Tested 11 pin-bar variants:

| Rule | n | WR | EV |
|---|---:|---:|---:|
| Touch wick ≥ 3pt + close back ≥ 2pt + bounce T10/S5/H10 | 9,360 | 31.8% | -$4/trade |
| Touch wick ≥ 5pt + close back ≥ 3pt + bounce T10/S5/H10 | 5,423 | 32.7% | -$2/trade |
| Touch wick ≥ 5pt + close back ≥ 3pt + bounce T15/S10/H15 | 5,423 | 38.8% | -$4/trade |
| Touch wick ≥ 8pt (extreme pin) + bounce T15/S10/H15 | 3,009 | 39.0% | -$4/trade |
| Extreme pin + s1 wick past ≥ 2pt + bounce T15/S10/H15 | 1,070 | 40.6% | +$3/trade |
| **Extreme pin + s1 wick + vol_ratio_15m ≥ 1.5 + T15/S10/H15** | **323** | **43.3%** | **+$18/trade** |

The strongest pin-bar setup (P7) gives +$18 gross/trade × 323 = ~$5,800/year gross. After slippage (~$30/trade entry + commission + occasional stop slip) we're at ~$2k net/year. Real but tiny.

### Phase 2h — Reverse-engineer: what do winners have in common?

Took the 8,727 touches that DID produce a clean 15pt bounce within 15min without first hitting an 8pt stop, and compared their feature distributions to the 17,037 clean losers. **No single feature shows a strong effect size.** Top distinguishing features (Cohen's d > 0.1 is meaningful):

| Feature | Winner mean | Loser mean | Effect size |
|---|---:|---:|---:|
| approach_speed_5m | 0.12 | -0.08 | ~0.05 |
| atr_14 | 11.2 | 12.4 | ~-0.10 |
| distance_traveled_5m | 12.1 | 14.8 | ~-0.10 |
| s1_max_wick_past_pts | 0.7 | 0.6 | ~+0.05 |

(All small. None gives a strong predictive signal.)

Cross-tab of `level_type × approach` (n ≥ 100) for bounce T15/S8/H15:

| Best cells | n | WR | | Worst cells | n | WR |
|---|---:|---:|---|---|---:|---:|
| R2/from_below | 1,125 | 35.3% | | R3/from_above | 421 | 25.9% |
| S2/from_below | 1,223 | 34.8% | | R5/from_above | 449 | 26.1% |
| S4/from_above | 1,034 | 33.9% | | R3/from_below | 568 | 26.8% |

Spread between best and worst structural cell is only ~10pp. **No cell exceeds 38% WR.** Theoretical random-walk breakeven for R:R 15:8 = 34.8%. Our actual WRs are 25-37% — i.e., raw price action at GEX touches is essentially efficient.

### Phase 3 — Portfolio simulation (concurrency + slippage)

Combined UP_BREAK + DN_BREAK + BOUNCE_HIGH_GAMMA rules with realistic execution. Result over 12 months:

| Metric | Value |
|---|---|
| Trades | 729 |
| WR | 38.7% |
| Net PnL | **-$34,675** |
| PF | 0.75 |
| Sharpe | -6.06 |
| Max DD | $37,435 |

Confirms: when the narrow overfit filter is relaxed for sample size + concurrency, the strategy bleeds money.

---

## Why 90% WR isn't there

Three structural reasons the data refuses to deliver:

1. **The market is efficient at GEX levels.** Random-walk breakeven WR for any (target, stop) is closely matched by actual WR across all configs. There's no free lunch at the touch event because GEX levels are widely watched.

2. **1m + 1s OHLCV is the wrong resolution.** The user's framing — "read what dealers are doing" — requires order book / quote / tape data. The signal that distinguishes "dealer aggressively defending" from "dealer absorbing then capitulating" lives in:
   - Bid/ask depth dynamics at the level
   - Internalization patterns (off-exchange aggression)
   - Order size distributions in the seconds around the touch
   - Quote-flicker / hidden orders behavior
   - None of which exist in OHLCV aggregates, even at 1s resolution

3. **"Big boys" volume hypothesis doesn't materialize.** I extensively tested volume features (vol_ratio_5m, vol_ratio_15m, vol_zscore, top3_1s_vol_pct, vol_max_to_mean) and they offer only ~1-2pp WR lift. Bar-level volume is too aggregated to identify aggressive institutional flow vs retail/HFT.

The closest proxy I found — `vol_ratio_15m ≥ 1.5 + extreme pin + s1 wick past ≥ 2pt` — gets to 43% WR (P7 above), which is real edge but modest. **The "big boys" signal in our data is real but small.**

---

## What IS achievable here

Three realistic strategies, ordered by Sharpe potential:

### A. Keep the existing gex-touch-patterns strategy (v6 gold standard)
- **33% WR, $38.7k/yr on 1 contract, Sharpe 2.24, DD 5.58%**
- Already in `shared/strategies/gex-touch-patterns.js`
- Uses 4 structural patterns (R1/R2/A1/A2) with targets 20-150pt
- Slippage drag manageable on the bigger-target trades
- **Scale to 3 contracts → ~$116k/yr**

### B. New "pin + vol + 1s wick" scalp (the modest signal from P7)
- Filter: `touch_wick_at_level ≥ 8 AND touch_close_relative ≥ 3 AND s1_max_wick_past_pts ≥ 2 AND vol_ratio_15m ≥ 1.5`
- Direction: bounce (away from approach)
- T=15 / S=10 / H=15min
- 43% WR on ~323 trades/yr, +0.9pt EV/trade gross, ~$2k net/yr after slippage on 1 contract
- **NOT WORTH BUILDING** as a standalone strategy — too low EV
- Could complement an existing strategy as a high-conviction overlay

### C. Hybrid: gex-touch-patterns + the GI/level-type/approach insights
- Use the existing 4 patterns BUT add a "context filter" derived from this research:
  - Skip touches where dist_next_break_level < 100pt (no room to run)
  - Favor approach-direction trades when gamma_imbalance is mid-range positive
  - Skip touches in rth_aft / rth_close TOD buckets
- Could potentially lift gex-touch-patterns from 33% → 38-40% WR

---

## To unlock 90% WR (recommendation for next iteration)

The framing the user described — "learn what dealers are doing, ride their wave, get in and out fast" — is a **microstructure / order flow strategy**, not an OHLCV-aggregated strategy. To make this work would require:

1. **Order book data**: Databento NQ depth-of-book (NASDAQ-100 futures) or CME MBP-10. This gives you bid/ask sizes at each price level. Then features like:
   - Bid/ask imbalance at the touch
   - Absorption signature (large bid soaked by aggressors, no price move)
   - Lift / hit sequences in the seconds at the level
   - Quote refresh speed
2. **Trades classifier**: tag each print as aggressive vs passive (Lee-Ready), then look for aggression imbalance at the level.
3. **Real-time aggregation**: not 1s OHLCV — sub-second event-based.

**This is a different research project, not a tweak of what we have.** If the user wants to pursue it, the first step is acquiring the right data feed.

---

## Files

- **Research scripts**: `backtest-engine/research/gex-touch-flow/`
  - `01-build-flow-dataset.js` — Phase 1 (enriched touch dataset, 1s-honest)
  - `02-analyze-features.js` — Phase 2 (single/pair filter mining)
  - `02b-sweep-configs.js` — Phase 2b (target/stop/hold sweep)
  - `02c-early-confirmation.js` — Phase 2c (early confirmation test)
  - `02d-drill-into-filter.js` — Phase 2d (top filter breakdown)
  - `02e-refine-and-simulate.js` — Phase 2e (refined variants + stability)
  - `02f-tight-scalp.js` — Phase 2f (tight scalp configs)
  - `02g-pin-bounce.js` — Phase 2g (pin-bar bounce setups)
  - `03-simulate-composite.js` — Phase 3 (concurrency-aware sim)
  - `03b-portfolio-sim.js` — Phase 3b (multi-rule portfolio sim)
- **Dataset**: `research/output/gex-touch-flow-2026-05-14T05-52-19-372Z.json` (~70MB; 27,201 touches with full features and outcomes)
- **No engine or strategy code changes were made** (per user instruction).

## Methodology guardrails

Every script follows the 1s-honest mandate from CLAUDE.md:
- Touch events detected from 1m OHLCV with primary-contract filtering
- All outcome labeling (target hit / stop hit / time) done by walking 1s OHLCV from entry_ts forward
- Entry price = open of first 1s bar after touch minute closes
- Same-bar stop+target ambiguity is naturally resolved by 1s granularity
- 16-min snap_lag applied to GEX snapshots (no lookahead)
- Raw contracts with primary-contract-per-hour filter
- Range capped at 2026-01-28 (end of available 1s data)
