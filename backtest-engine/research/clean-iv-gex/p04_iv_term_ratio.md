# p04 — 0-DTE / 7-DTE IV ratio → forward absolute NQ return

## Hypothesis

When QQQ 0-DTE IV runs much higher than 7-DTE IV (steep front-end vol), option
markets are pricing **near-term** event risk.  Forward 60-min absolute NQ return
should be larger than baseline.  In contango (0-DTE < 7-DTE), front-end is calm and
NQ should drift quietly.

This is a vol-magnitude predictor, not directional.

## Feature

```
term_ratio(T) = dte0_avg_iv(T) / atm_iv_7dte(T)
```

- `dte0_avg_iv` from `data/iv/qqq/qqq_short_dte_iv_15m.csv` (15-min cadence)
- `atm_iv_7dte` from `data/iv/qqq/qqq_atm_iv_1m.csv` (1-min cadence, value sampled at the snapshot minute)

Both files were regenerated 2026-05-01 with the corrected shared `calculateATMIVFromQuotes`.

## Response

`abs_fwd_ret_60m` = `|ln(price[T+61m] / price[T+1m])|`.

(Directional `fwd_ret_60m` was also tested — failed the |r|≥0.10 bar at -0.07, though the *top decile only* shows -22 pt drift with 44% hit rate, suggesting a tail-only directional bias that this brief does not promote.)

## Statistics

- **n = 4,463** snapshots (limited by the 15-min cadence of the 0-DTE IV file and overnight non-coverage)
- **Spearman r = +0.295**, p ≈ 0
- Train/test 70/30: train Δ = 73.45 pts, test Δ = 51.74 pts (sign matches; test/train = 0.70 — stable but weakening on out-of-sample)

## Decile table

| Decile | term_ratio range | mean \|fwd_ret_60m\| (NQ pts) |
|---|---|---|
| 0  (deepest contango)        | [0.73, 1.05] | 25.92 |
| 1                            | [1.05, 1.12] | 33.39 |
| 2                            | [1.12, 1.17] | 37.86 |
| 3                            | [1.17, 1.21] | 42.34 |
| 4                            | [1.21, 1.25] | 46.22 |
| 5                            | [1.25, 1.30] | 46.80 |
| 6                            | [1.30, 1.36] | 55.30 |
| 7                            | [1.36, 1.43] | 79.94 |
| 8                            | [1.43, 1.53] | 88.35 |
| 9  (steepest backwardation)  | [1.53, 2.23] | 92.36 |

Top-vs-bottom decile = **66 NQ pts** of forward 60-min absolute-return difference.

## Suggested entry rule for backtesting

A **vol-expansion entry filter**:

- Only enter directional NQ trades when `term_ratio(T) ≥ 1.43` (top 30%) — these
  are the snapshots where 60-min realized magnitude dwarfs the baseline.
- For mean-reverting strategies, do the **opposite** — only enter when
  `term_ratio(T) ≤ 1.12` (bottom 20%) so the small expected forward move makes
  reversion-to-mean a tighter trade.

Alternative: **straddle setup**.  When `term_ratio` enters the top decile, take a
long-volatility 1-hour position (long straddle / synthetic via NQ options or a
delta-neutral long-gamma overlay).

## Notes

- **r = 0.295 is unusually strong** — the brief warned to triple-check leakage at
  this level.  Leakage spot-check (`_leakage_check_p04.js`):

  | entry lag | n     | Spearman r | decile-diff (NQ pts) |
  |---|---|---|---|
  | +1m       | 4,463 | 0.295      | 66.4 |
  | +16m      | 4,463 | 0.305      | 64.0 |
  | +31m      | 4,277 | 0.302      | 66.0 |
  | +46m      | 4,091 | 0.309      | 66.3 |

  **r is constant across lag windows.**  This RULES OUT bucket-overlap leakage
  (which would have collapsed r at lag ≥ +16m, when the response window no
  longer touches the IV-bucket window).  But it ALSO means the predictor is
  not a tight short-horizon forecaster — it's a **slow-moving regime
  indicator**.  When term_ratio is high, *any* 60-min window in the next few
  hours has elevated absolute return.

- Practical implication: this is **not a 60-min entry trigger**.  It is a
  **vol-regime conditional** — use it to scale position sizes, choose between
  long-vol vs short-vol structures, or filter when to run other strategies.
  Don't paper-trade it as "enter when term_ratio crosses 1.5."

- Likely to **fire heavily on macro event days** (FOMC, NFP, CPI).  A backtest
  should check whether the edge survives once event days are excluded — if it
  collapses, the predictor reduces to "trade more on event days," which is
  obvious and not a tradeable edge per se.

- The signal is partly a known IV→RV relationship.  Novelty here: the **ratio** of
  two clean IV series (0-DTE / 7-DTE) is a stronger forecaster than either level
  alone, and on the corrected data it survives the n / r / stability gates cleanly.
