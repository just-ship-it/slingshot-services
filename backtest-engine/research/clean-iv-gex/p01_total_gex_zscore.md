# p01 — total_gex Z-score → forward realized vol

## Hypothesis

When NQ-cbbo `total_gex` is in the **upper tail** of its trailing 30-day distribution,
dealers carry a large positive gamma book against price moves: hedging mechanics
**dampen** realized vol over the next 30 minutes. When `total_gex` is in the **lower
tail** (low/negative gamma), the same mechanics **amplify** moves.

This is a vol-magnitude predictor, not directional.

## Feature

```
total_gex_z(T) = (total_gex(T) - μ_30d) / σ_30d
```
where μ, σ are computed over all snapshots whose timestamp is in the 30 calendar days
*strictly before* T (no lookahead).  At least 100 prior observations required or the
sample is dropped.

## Response

`fwd_realized_vol_30m` = stdev of 1-min log returns over `[T+1m … T+31m]`.

(Also tested `|fwd_ret_15m|` as a secondary response — also passes.)

## Statistics

- **n = 16,205** aligned snapshots (after rollover-buffer skip and 30-day warm-up)
- **Spearman r = -0.296**, p ≈ 0
- Train/test 70/30 chronological split: train Δ = -16.98 pts, test Δ = -22.45 pts (sign matches; test/train = 1.32 — overfit-resistant)

## Decile table

| Decile | total_gex_z range | mean realized vol (1m log-σ) | NQ-pt-equivalent over 30m |
|---|---|---|---|
| 0  (lowest GEX z)  | [-4.09, -1.45] | 0.000420 | 50.6 |
| 1                  | [-1.45, -0.91] | 0.000437 | 52.7 |
| 2                  | [-0.91, -0.48] | 0.000351 | 42.3 |
| 3                  | [-0.48, -0.13] | 0.000388 | 46.7 |
| 4                  | [-0.13,  0.19] | 0.000358 | 43.1 |
| 5                  | [ 0.19,  0.52] | 0.000311 | 37.5 |
| 6                  | [ 0.52,  0.79] | 0.000260 | 31.3 |
| 7                  | [ 0.79,  1.11] | 0.000252 | 30.4 |
| 8                  | [ 1.11,  1.51] | 0.000238 | 28.7 |
| 9  (highest GEX z) | [ 1.51,  4.75] | 0.000266 | 32.0 |

Top-vs-bottom decile = **18 NQ pts** of forward 30-min realized-vol difference.

## Suggested entry rule for backtesting

Combine with a direction-emitting strategy as a **vol-conditional position-sizer**.

- When `total_gex_z(T) ≥ +1.0`: scale TP / SL targets *down* by ~30% (vol regime is suppressed) and accept that fewer bars hit aggressive targets.
- When `total_gex_z(T) ≤ -1.0`: scale TP / SL *up* — the same exposure carries higher absolute return potential and more whipsaw.

Alternative standalone use: a **straddle / breakout filter** that only enters when the next 30 min is forecast to be high-vol (z ≤ -1.0).

## Notes

- Effect size is asymmetric: the suppression at the top tail is mild compared to the elevation at the bottom tail (deciles 0-2 average 47 pt-equivalent vol, deciles 7-9 average 30).  The negative gamma side carries more of the predictive signal.
- Not novel as a *concept* — this is the classic dealer-gamma mechanic.  Novel here as a **clean** number on **clean** GEX data: prior work was contaminated by the 4/30 ts_event bucketing bug.
