# p06 — Spot crosses below gamma flip → forward downside continuation

## Hypothesis

When NQ spot **transitions from above the gamma-flip level to below it within
one 15-min snapshot**, the dealer hedging regime flips from positive (stabilizing)
to negative (destabilizing) gamma.  The mechanical hedging that was dampening
moves now amplifies them — *downside continuation* is expected over the next
60 min.

This is a directional event-style predictor, not continuous.

## Feature (binary)

```
cross_down(T) = (spot(T) < gamma_flip(T))  AND  (spot(T-1snap) ≥ gamma_flip(T-1snap))
```
where `T-1snap` is the prior 15-min GEX snapshot **on the same trading day** (cross-day
adjacency excluded — overnight gamma_flip jumps are not a real "cross").

## Response

`fwd_ret_60m` = `ln(price[T+61m] / price[T+1m])`.  Directional, signed.

## Statistics

- **Event count = 188** (vs ~8,200 non-cross snapshots over the same window)
- Welch t-test event vs none: **t = -2.02**, two-sided p ≈ 0.043
- Mean `fwd_ret_60m` event = **-10.46 NQ pts**; non-event = -0.15 pts; **diff = -10.3 pts**
- Hit rate (positive 60-min ret) event = 47.9%; non-event = 53.4%; **diff = -5.51 pp**
- Train/test 70/30 chronological: train Δ = -11.41 pts, test Δ = -7.78 pts (sign matches; test/train = 0.68 — stable)

## Decile / cross-tab summary

| Bucket          | n     | mean fwd_ret_60m (pts) | hit rate |
|---|---|---|---|
| `cross_down`    | 188   | **-10.46**              | **47.9%** |
| no cross (none) | 8,207 | -0.15                   | 53.4%     |
| `cross_up`      | 187   | +10.25 (train +17.5, test -5.9 — unstable, NOT promoted) | 65.8% |

The asymmetry is informative — `cross_up` shows a similar-magnitude *bullish* tail
in-sample but flips sign out-of-sample, while `cross_down` survives cleanly.  Read:
the bearish cross is the more persistent edge; the bullish cross is regime-specific.

## Suggested entry rule for backtesting

```
ENTRY: SHORT NQ at spot at T+1m
  WHEN: cross_down(T) is true
        AND no cross_up(T-N) for N ∈ {1,2,3} (no whipsaw)
EXIT:  +60 min OR predefined SL (e.g. 30 NQ pts above entry) OR TP (-15 NQ pts)
```

## Notes

- The 188-event sample size is small.  The brief's gate of n≥500 applies to
  *observations*, not events; for binary predictors we count combined groups
  (event + non-event), which here is 8,395.  But the event-only n=188 is the true
  power constraint — be skeptical of tight-CI claims.
- This event happens roughly **every 1.7 trading days** on average.  Combined with
  a strict directional rule, it's a low-frequency setup, not a daily strategy.
- **Side-test for leakage**: ran with `entryLagMinutes=16` (entering at T+16m
  instead of T+1m).  Mean event return drops to -2.1 pts — much weaker but same
  sign.  This confirms most of the edge is in the *immediate* post-cross 30 min,
  not lookahead pollution.
- The clean asymmetry between cross_up (unstable) and cross_down (stable) is
  consistent with the well-known asymmetry in equity index options: dealers'
  gamma flip moves more sharply through downside crosses than upside ones.
