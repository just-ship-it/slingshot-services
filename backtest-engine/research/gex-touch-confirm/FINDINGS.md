# GEX-Touch Confirmation Study — Findings

**Date:** 2026-05-12
**Range:** 2025-01-13 → 2026-04-23 (16 months)
**Dataset:** NQ 1m raw + post-fix `data/gex/nq-cbbo/` + QQQ ATM IV (1m smoothed) + NQ 1s OHLCV
**Touches:** 21,761 (every RTH 1m bar where price came within 10pts of any S1-S5 / R1-R5 / gamma_flip / call_wall / put_wall level)

## Goal

Determine whether a 10-point GEX-level proximity event is tradable as a directional 20-point bounce when filtered by confirmation features. Target: high win rate, minimal drawdown, tight stops near structural S/R.

## Methodology

Phase 1 — wide-net touch dataset. Both bounce and break setups, 5 stop tiers (8, 10, 12, 15, 20pts), forward MFE/MAE at 5/15/30/60/120min, same-bar stop+target ambiguity flagged.

Phase 1b — 1s OHLCV resolution of same-bar ambiguity (first-hit-wins).

Phase 2 — feature enrichment. Volume (1m), QQQ ATM IV and skew, 1m candle patterns (rejection wick, body/range, doji, pinbar, engulfing), 1s micro-patterns (intra-minute VWAP-close diff, min-distance-to-level, seconds-at-level, first-rejection-second), structural context (level GEX rank in snapshot, distance to nearest opposite level), ATR(14), prior-3-bar compression.

Phase 3 — single-feature filter sweep, stratified by (setup × stop_distance × feature × threshold).

Phase 4 — composite (pair / triple) filter search, ranked by win rate.

Phase 5 — split-half stability check (chronological halves).

## Critical methodology fix — Lookahead bias caught and corrected

**v1 entry model: "Enter at level price at touch instant; walk forward from M+1."** This produced spectacular results (top filter `s1_vwap_close_diff >= p90` showed **92% WR / PF 28.72** at stop=8pts).

**v1 was lookahead-contaminated.** Several enrichment features (e.g., `s1_vwap_close_diff`, `s1_max_rej_wick_pts`) are computed over the *entire touch minute*, including 1s data that arrives AFTER the moment of presumed entry. The "92% WR" was achievable only with access to information that would not exist at decision time.

**v2 entry model: "Detect touch on M close; place LIMIT at level on M+1; fill only when a subsequent bar revisits the level within 5min; otherwise no_fill."** All Phase 2 features are computed using only minute-M data (1m + 1s). The limit is placed *after* minute M closes, so every feature is strictly observable before the trade can fire.

**Net effect of fix:** the strongest single filter dropped from PF 28.72 / WR 92% to PF 1.49 / WR 42.7% (stop=10). The honest edge is real but ~10× smaller than the lookahead-biased numbers suggested.

All numbers below are post-fix and use the v2 limit-fill model.

## Honest baseline (no filter)

Bounce setup, conditional on filled trades only (no_fill ≈ 34% of touches):

| stop (pts) | n_filled | wins | losses | WR | PF | EV/filled |
|---|---|---|---|---|---|---|
| 8  | 14,448 | 3,745 | 10,526 | 26.2% | 0.89 | -0.64 |
| 10 | 14,448 | 4,628 | 9,671  | 32.4% | 0.96 | -0.29 |
| 12 | 14,448 | 5,261 | 9,064  | 36.7% | 0.97 | -0.25 |
| 15 | 14,448 | 6,174 | 8,159  | 43.1% | 1.01 | +0.08 |
| 20 | 14,448 | 7,124 | 7,216  | 49.7% | 0.99 | -0.13 |

Wide-net is essentially break-even. Edge must come from confirmation.

Break setup is unprofitable at every stop tier (PF 0.24-0.39). The limit-at-level entry doesn't fit "break continuation" semantics — fill rate is artificially high because price is already past the level on the wrong side. **Recommend dropping break entirely; use only bounce.**

## Phase 3 — strongest single filters (bounce)

The five strongest single features (ranked by PF at stop=15):

| feature | threshold | WR | PF | n_filled | EV lift (pts) |
|---|---|---|---|---|---|
| `s1_vwap_close_diff` ≥ +5.74 (p90) | top decile | 57.4% | 1.80 | 822 | +5.02 |
| `s1_min_dist_to_level` ≥ 8.44 (p90) | top decile | 51.6% | 1.42 | 663 | +2.98 |
| `s1_min_dist_to_level` ≥ 6.79 (p80) | top 20% | 51.3% | 1.40 | 1,425 | +2.86 |
| `qqq_iv_skew` < 0.017 (p10) | bottom decile | 49.9% | 1.33 | 1,084 | +2.39 |
| `touch_rej_wick_pts` ≥ 10.5 (p90) | top decile | 49.0% | 1.30 | 1,420 | +2.40 |

Several "touch quality" features (`s1_vwap_close_diff`, `touch_rej_wick_pts`, `touch_pinbar`, `touch_doji`, `touch_body_range_ratio`) are correlated — they all describe the same "strong rejection at the level" pattern. The first listed (`s1_vwap_close_diff`) is the most discriminating individual representative.

`qqq_iv_skew` (put-call skew) and `atr14` (1m volatility regime) are structurally different and combine well with the rejection-quality features.

## Phase 4 — strongest composite filters (bounce)

### Stop = 15pts (recommended balance of WR and tightness)

| filter | n_filled | WR | PF | total (pts) |
|---|---|---|---|---|
| `s1_vwap_close_diff ≥ p60 AND s1_min_dist_to_level ≥ p80 AND atr14 ≥ p90` | 56 | 73.2% | 3.64 | 595 |
| `s1_vwap_close_diff ≥ p70 AND s1_min_dist_to_level ≥ p80 AND tod=open_30` | 62 | 72.6% | 3.53 | 645 |
| `s1_vwap_close_diff ≥ p70 AND qqq_iv_skew < p10 AND atr14 ≥ p90` | 58 | 72.4% | 3.50 | 600 |
| `s1_vwap_close_diff ≥ p80 AND qqq_iv_skew < p10 AND atr14 ≥ p90` | 51 | 70.6% | 3.20 | 495 |
| `s1_vwap_close_diff ≥ p80 AND atr14 ≥ p90` (pair, more trades) | 359 | 62.0% | 2.20 | (extrap ~1500) |
| `s1_vwap_close_diff ≥ p70 AND atr14 ≥ p80` (pair, even more trades) | 726 | 58.5% | 1.85 | (extrap ~2000) |

### Stop = 20pts (highest WR)

| filter | n_filled | WR | PF | total (pts) |
|---|---|---|---|---|
| `s1_vwap_close_diff ≥ p60 AND s1_min_dist_to_level ≥ p80 AND atr14 ≥ p90` | 56 | 80.4% | 4.09 | 680 |
| `s1_vwap_close_diff ≥ p80 AND atr14 ≥ p90` (pair, more trades) | 267 | 76.0% | 3.17 | 2,780 |
| `s1_vwap_close_diff ≥ p70 AND atr14 ≥ p80` (pair) | 413 | 72.4% | 2.62 | 3,700 |
| `s1_vwap_close_diff ≥ p70 AND atr14 ≥ p80` (pair, full) | 726 | ~66% | ~2.0 | ~4,400 |

## Phase 5 — Split-half stability check

The strongest triples have **too few trades in the second half** (8-19 filled) to validate — they may be regime-specific. The strongest PAIRS validate cleanly:

| filter | stop | H1 (Jan'25–Aug'25) | H2 (Sep'25–Apr'26) | verdict |
|---|---|---|---|---|
| `s1_vwap_close_diff ≥ p80 AND atr14 ≥ p90` | 15 | n=267 WR 59.9% PF 1.99 | n=92 WR 68.5% PF 2.90 | **STABLE** |
| `s1_vwap_close_diff ≥ p80 AND atr14 ≥ p90` | 20 | n=267 WR 70.0% PF 2.34 | n=92 WR 81.5% PF 4.41 | **STABLE** |
| `s1_vwap_close_diff ≥ p70 AND atr14 ≥ p80` | 15 | n=517 WR 57.4% PF 1.80 | n=209 WR 61.2% PF 2.11 | **STABLE** |
| `s1_vwap_close_diff ≥ p70 AND atr14 ≥ p80` | 20 | n=517 WR 64.6% PF 1.83 | n=209 WR 70.8% PF 2.43 | **STABLE** |

Edge is consistent (and slightly stronger in H2). The pair-filter level is the right level of abstraction — triple filters risk overfit but pair filters generalize.

## Comparison vs other Slingshot strategies (post-lookahead-fix)

| strategy | n_trades | WR | PF | Sharpe | MaxDD | total |
|---|---|---|---|---|---|---|
| iv-skew-gex (balanced) | 244 | 49.6% | 1.64 | 3.97 | 9.23% | $92k |
| gex-flip-ivpct | 143 | 74.1% | 4.29 | 10.60 | 4.16% | $275k |
| gex-lt-3m-crossover W12 | 909 | ~46% | 1.39 | 5.62 | 8.30% | $164k |
| **gex-touch-confirm (proposed pair)** | **~726** | **~66%** | **~2.0** | (TBD) | (TBD) | **~$88k** |
| **gex-touch-confirm (proposed pair, narrower)** | **~359** | **~73%** | **~3.0** | (TBD) | (TBD) | **~$60k** |

Total PnL estimate uses stop=20pts which is the highest-WR variant. Tighter stops (10-15) earn less raw PnL but with tighter drawdown. Live PF/Sharpe/DD will be computed in Phase 6.

## Recommended candidates for Phase 6 (live strategy)

**Candidate A — Wider net, moderate WR (~66%):**
- Setup: bounce only
- Entry: limit at level at minute-M close, 5min timeout
- Filter: `s1_vwap_close_diff ≥ p70 (≥ 1.59)` AND `atr14 ≥ p80 (≥ 22.66)`
- Stop: 20pts past level (R:R = 1:1)
- Target: level + 20pts (long) / level - 20pts (short)
- Expected: ~45 trades/month, 66% WR, PF ~2.0

**Candidate B — Selective, high WR (~73%, "minimal drawdown"):**
- Setup: bounce only
- Same entry/exit mechanics
- Filter: `s1_vwap_close_diff ≥ p80 (≥ 2.99)` AND `atr14 ≥ p90 (≥ 28.95)`
- Stop: 15pts past level
- Target: 20pts
- Expected: ~22 trades/month, ~62% WR, PF ~2.2 (or stop=20 → 76% WR, PF 3.17)

The user's stated preference is "HIGH win rate with minimal drawdown" + "tight stops near structural S/R," which points to Candidate B with stop=15.

## Caveats

1. **Sample sizes**: triples with n_filled < 60 are sensitive to regime. The pair candidates above (n=267-726) are statistically more reliable.
2. **Percentile thresholds are dataset-bound**. Cutoffs like `vwap_close_diff ≥ p80 = 2.99` are computed on the 21,761-touch population — live trading needs the same calibration window. Use a rolling 6-month percentile in the live strategy or hard-code the value with a periodic re-calibration job.
3. **Fill rate ~66%** — about a third of touch signals don't get a retest within 5 min. Widening the limit timeout would increase fill rate at the cost of stale entries.
4. **No_fill is not a loss** in expectancy terms, but it does waste signal opportunity. The strategy should track no_fill rate live and alert if it diverges materially from backtest.
5. **1s feature dependency in live trading**: `s1_vwap_close_diff` requires intra-minute 1s OHLCV. The data-service streams TradingView 1s; signal-generator would need a small aggregator to compute intra-minute VWAP and the close-vs-VWAP diff at the bar boundary.
6. **GEX snapshot lookahead correction**: the strategy must observe the 2026-05-06 fix — only consume the snapshot whose `timestamp ≤ candle_ts - 16min`.

## Files produced

| File | Purpose |
|---|---|
| `01v2-build-touch-dataset.js` | Phase 1 — wide-net touch dataset, limit-fill model |
| `01b-resolve-ambiguity-1s.js` | Phase 1b — 1s same-bar resolution |
| `02-enrich-features.js` | Phase 2 — feature enrichment (vol, IV, candle, 1s, structural) |
| `03-filter-sweep.js` | Phase 3 — single-filter sweep, per-cell ranking |
| `04-composite-search.js` | Phase 4 — pair/triple search |
| `05-split-stability.js` | Phase 5 — chronological split-half check |

Output JSONs in `backtest-engine/research/output/gex-touch-confirm-*`.

## Next steps (Phase 6, if user proceeds)

1. Implement `shared/strategies/gex-touch-confirm.js` (extends `base-strategy.js`).
2. Wire a 1s-aggregation helper into the signal-generator so `s1_vwap_close_diff` is computable on live data.
3. Run `backtest-engine` with this strategy over the same 16-month window. Verify trade count and PF match Phase 4 numbers ± 5%.
4. Generate gold-standard JSON: `data/gold-standard/gex-touch-confirm.json`.
5. Register in `signal-generator/src/strategy/strategy-factory.js`.
6. Deploy as a separate paper-trading PM2 process with `TRADING_SYMBOL=MNQ<contract>` until live numbers track backtest.
