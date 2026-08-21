# Liquidity Toolkit | T — extraction + first read (2026-08-21)

`PUB;8ec4a4d429674d018d2cae43c621341e` v1.0. Invite-only (absent from the public index),
but `pine-facade/translate` returns full metadata with NO auth, so the output map is known.
Computing the study DOES require the entitled session.

## Getting the data

```
TV_COOKIE="sessionid=...; sessionid_sign=..." \
  node dump-study.js --symbol CME_MINI:NQU2026 --tf 3 --bars 40000 --out t_NQ_3m_deep.csv
```

Three things had to be right, each of which failed loudly first:
1. **JWT, not just cookies.** Connecting with `unauthorized_user_token` yields
   "maximum number of studies per chart has been reached for current subscription" —
   which is the documented signature of degraded premium auth, NOT a real study cap.
   `extractJwtFromPage(cookies)` derives the token.
2. **Colors as ARGB ints.** metaInfo returns `#RRGGBB`; create_study wants the integer, or
   TV replies `NumberFormatException: For input string: "#80DEEA"`.
3. **Flush before exit.** `process.exit()` right after `ws.end()` silently produced no file.

## Column map (value index -> meaning)

| col | meaning |
|---|---|
| `v11_5` | **T:5** |
| `v14_H` | **T:H** |
| `v17_D` | T:D |
| `v16_Plot` / `v19_Plot` | band edges (the visual compression zone) |
| `v55/56` | 5-Minute Bullish Crossover / Bearish Crossunder |
| `v57/58` | 1-Hour Bullish / Bearish |
| `v59/60` | 1-Day Bullish / Bearish |
| `v51-54` | Recovery Opp. Enter/Exit, Status became Bearish/Bullish |

Triggers are 6 timeframes (1/5/H/D/W/M), not the two plotted. **Crossovers are first-class
outputs** — no need to derive them by thresholding two lines.

## Structure

- **T:H is a clean hourly step**: changes at `minute==0` on 99.8% of changes, then holds.
- **T:5 is NOT a 5-minute step**: it changes on EVERY 3m bar (only 33% land on 5-minute
  boundaries), so it moves within a forming 5m bar.
- Spread `TH-T5`: mean +11.8, sd 171, range -614..+494.

## 🚨 Lookahead: UNRESOLVED

The script uses `request.security`. If built with `lookahead_on`, T:H would be both stable
within the hour AND sourced from the future. Static tests cannot separate the two:

| TH held during hour N vs | corr |
|---|---|
| hour N-1 close (knowable) | 0.9616 |
| hour N close (future) | 0.9554 |

Step direction matches the prior hour 61.2% and the coming hour 61.4% — a non-result,
because consecutive hourly moves are autocorrelated. **Only a live capture settles this**:
record T:H as it appears in real time, then compare against the historical series pulled
later. Until that runs, no backtest on T:H is trustworthy.

## First read on the crossovers — matches the chart, fails the error bars

64 days, 20,891 bars, 52 bullish + 54 bearish 5m crossovers (~1.8/day).

The signal is **contrarian**, exactly as Drew read it off the chart (a bullish 5m crossover
marking a top): after a 5m bullish crossover price falls -11.4 / -12.6 / -16.8 / -11.3 pts
at +5/10/20/40 bars.

But significance is absent:

| combined contrarian book | +5b | +10b | +20b | +40b |
|---|---|---|---|---|
| t | +0.42 | +0.05 | +1.24 | +0.17 |
| p | 0.68 | 0.96 | 0.22 | 0.87 |

Win rate 58%, but the mean is swamped by variance. The single nominally-significant cell
(5m bull at +5b, p=0.027) is what 8 tested cells produce by chance.

## The binding constraint, and the only fast way past it

Detecting a +12pt effect against sd≈134 at 80% power needs **~980 events ≈ 2 years**.
TV caps 3m history at **64 days**, so we are ~10x short and cannot wait it out.

Options, in order of value:
1. **Reverse-engineer T:5 / T:H from OHLCV.** We now hold 20,891 bars of ground truth to
   fit against. An exact (or near-exact) reconstruction lets us compute the levels over the
   full 5-year NQ set and test properly — and it sidesteps the lookahead question entirely,
   because our reconstruction would be causal by construction.
2. Accumulate forward: run the dumper on a schedule and merge (`--merge` pattern from
   `scripts/fetch-macro-daily.js`). Correct but slow.
3. Higher timeframes buy more calendar history but lose the 5m crossover resolution.

Data (not committed, ~10MB): `t_NQ_3m.csv` (15d), `t_NQ_3m_deep.csv` (64d).

---

# ★ REVERSE-ENGINEERED (2026-08-21) — and both hypotheses then died

## The indicator is Wilder's MA

```
T:{timeframe} = RMA(close, 14)        # alpha = 1/14, seeded with SMA(14)
```

Fitted by solving the recursion `T[i] = a*c[i] + (1-a)*T[i-1]` on TV's own bars:

| series | alpha | 1/alpha | R² | rmse | max err |
|---|---|---|---|---|---|
| T:5 on native 5m | 0.071429 | **14.000** | **1.000000** | **0.0000** | **0.000** |
| T:H on native 60m | 0.071429 | **14.000** | **1.000000** | **0.0000** | **0.000** |

An identity, not a fit. All six timeframes (1/5/H/D/W/M) are the same function on
different bars — the "Liquidity Toolkit | T" is a multi-timeframe Wilder moving average.

**Why it had to be fitted on the NATIVE timeframe.** On a 3m chart the recursion gives
R²=0.607 and 21pt errors, because T:5 is a 5-minute value evaluated in real time (it moves
on every 3m bar as the forming 5m bar updates). Fit it on 5m bars and it is exact.

### What this bought

- **No TV dependency and no history cap.** TV serves 64 days at 3m (~115 events); we now
  compute 2,250 crossovers over 5.5 years from our own 1m data.
- **The lookahead question is dead.** TV's script uses `request.security` and static tests
  could not prove whether T:H peeks (corr 0.9616 prior-hour vs 0.9554 current-hour; step
  direction 61.2% vs 61.4% — a non-result). Our reconstruction is causal by construction:
  a 5m bar sees only the LAST COMPLETED hourly RMA, enforced with a `merge_asof` on the
  hour's close time.

Validation against TV ground truth on the overlap: our bars match **100% exactly**;
T:5 within 0.01 on **98.5%** of bars (mean |diff| 0.045, sub-tick), T:H on 88.7%. The
residual is a recursive filter meeting occasional data gaps (~9-bar memory).

`build-triggers.py` reconstructs over the full history, per front-month contract, resetting
the recursion at each roll so the ~200pt gap cannot poison the filter.

## Hypothesis 1: crossovers — DEAD

64 days of TV data suggested a strong contrarian signal (5m bullish crossover followed by
−11.4/−12.6/−16.8/−11.3 pts) that matched Drew's chart reading. It does not survive the
full sample. 2,222 events, rolls excluded:

| contrarian book | 15m | 30m | 60m | 120m |
|---|---|---|---|---|
| mean pts | −0.22 | −0.02 | +0.34 | −1.41 |
| t | −0.30 | −0.02 | +0.26 | −0.77 |
| win% | 51% | 50% | 50% | 49% |
| net $/trade | −19.46 | −15.32 | −8.10 | −43.27 |

The direction is now mildly OPPOSITE the 64-day read. That window was noise, exactly as
its error bars said (t=+0.05..+1.24 there).

## Hypothesis 2: compression → expansion — 98% volatility clustering

Raw, the result looks spectacular and monotone across five quintiles: the tightest
`|T5-TH|/ATR` bucket sees 1.16x the baseline forward move, the widest 0.67x, t=+76.

🚨 It is the denominator. `rel = |spread|/ATR` with a RAW forward move means a low `rel`
mostly identifies **high ATR**, which mechanically predicts big moves. ATR by quintile:
**19.39** (tightest) vs **11.04** (widest) — the "compressed" bucket is just the volatile
regime.

Normalising the forward move by ATR as well:

| horizon | tightest | widest | t | p |
|---|---|---|---|---|
| +30m | 1.328 | 1.298 | +3.90 | 0.0001 |
| +60m | 1.935 | 1.902 | +2.92 | 0.0035 |
| +120m | 2.852 | 2.842 | +0.60 | 0.55 |

A 2.3% relative difference, detectable only because n=76,325 per bucket, and gone by 120m.
Not tradeable. Consistent with vol clustering being the #1 survivor of the Wave A census —
it keeps turning up as the thing that explains apparent structure.

## Keepers

- `RMA(close,14)` per timeframe — the levels themselves, now computable over any history
  for free, causally, for NQ/ES/anything.
- `build-triggers.py` — front-month handling, per-contract recursion reset, causal
  hour-to-5m alignment. Any future T-based hypothesis drops straight into it.
- `dump-study.js` — pulls ANY TradingView Pine study to CSV.
- The rule this session keeps re-learning: **normalise both sides, or volatility will
  masquerade as signal.**
