# p07 — LT level + put_wall confluence below spot → forward upside

## Hypothesis

When the **published LT support level** (any of `level_1` … `level_5` from
`NQ_liquidity_levels.csv`) sits within 25 NQ pts of the **GEX put_wall** *below*
spot, the level is reinforced by both crowd-traded liquidity and dealer-gamma
defense.  Approaching such confluence levels should reverse upward more often
than approaching either alone.

This is an asymmetric directional predictor — only the *underneath* side
(LT-near-put_wall) survives the train/test gate; the symmetric *overhead* side
(LT-near-call_wall) does not.

## Feature (binary)

```
conf_underneath(T) =
   ∃ level_i in LT(T) such that:
     level_i < spot(T)              (the LT level is below spot)
     AND  | level_i - put_wall(T) | ≤ 25 NQ pts
   AND  conf_overhead(T) is false   (exclude both-sides confluence — different regime)
```

LT levels are looked up at the same 15-min boundary as the GEX snapshot; if missing,
the prior 15-min publication is used (no forward fill — strict no-lookahead).

## Response

`fwd_ret_60m` = `ln(price[T+61m] / price[T+1m])`.  Signed.

## Statistics

- **Event count = 1,344** (over 12,343 valid snapshots)
- Welch t-test event vs neither: **t = +2.61**, two-sided p ≈ 0.009
- Mean `fwd_ret_60m` event = **+6.13 NQ pts**; neither = +0.18 pts; **diff = +5.95 pts**
- Hit rate event = 54.7%; neither = 52.6%; **diff = +2.10 pp**
- Train/test 70/30 chronological: train Δ = 4.51 pts, test Δ = 9.29 pts (sign matches; test/train = 2.06 — strengthens out-of-sample)

## Cross-tab summary

| Bucket               | n      | mean fwd_ret_60m (pts) | hit rate |
|---|---|---|---|
| `conf_underneath`    | 1,344  | **+6.13**              | **54.7%** |
| `conf_overhead`      | 1,208  | -4.70 (train -7.16, test +0.43 — UNSTABLE, NOT promoted) | 50.2% |
| both                 |    43  | n/a (too small)        | n/a       |
| neither              | 9,748  | +0.18                  | 52.6%     |

The asymmetry is notable: confluence overhead does *not* survive the gate even
though its event-time signal looks larger.  The underneath side is more robust.

## Suggested entry rule for backtesting

```
ENTRY: LONG NQ at spot at T+1m
  WHEN: conf_underneath(T) is true
        AND  spot(T) is within 50 NQ pts of the matched LT-level / put_wall
EXIT:  +60 min  OR  TP +15 NQ pts  OR  SL -10 NQ pts
```

The "within 50 pts" gate is suggested because the predictor itself only conditions on
*existence* of the confluence; the practical setup needs price actually near the level.

## Notes

- The 5.95-pt effect is right at the brief's gate.  The signal strengthens
  out-of-sample (test = 9.29 pts), which is unusual and increases confidence
  this is structural — but a wider-window backtest (paper trades for a few
  weeks live) should validate before sizing.
- LT levels alone are *off-limits* per the brief (covered by `lt-candle-regime`).
  This predictor's novelty is the **AND** with `put_wall`: it filters which LT
  levels carry stronger reaction.  A pure-LT pre-existing strategy would fire on
  many levels; this one fires on a subset (1,344 of however many LT-level
  approaches occur over the period) with stronger expected return.
- Could be partly explained by **trend bias** — over the 16-month sample NQ rose
  considerably, so any "near-low support" event will average positive return
  by drift alone.  Suggest the backtest also test a **detrended** version of
  fwd_ret (subtract daily-mean-return) to isolate the level-reaction edge.
