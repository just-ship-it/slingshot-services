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

---

# Do the trigger levels carry alpha? (2026-08-21) — NO

Reconstructed T:1 / T:5 / T:H / T:D over 318,732 5m bars (2021-01-13 -> 2026-06-12),
front-month, rolls excluded, each higher-timeframe value usable only after that bar
CLOSES (`merge_asof` on close time). `build-triggers.py --out triggers_NQ_mtf.csv`.

## 1. MTF alignment ("stack" = how many of c>T1, T1>T5, T5>TH, TH>TD hold)

Raw forward returns are positive in EVERY state — that is NQ's 2021-26 drift, not signal.
Net of the unconditional mean the pattern is a **U**, not a ladder: fully-bearish (stack 0)
and fully-bullish (stack 4) both positive, the middle flat. stack4 vs stack0 is
insignificant at every horizon (p = 0.36 / 0.67 / 0.96).

🚨 **The overlap trap.** Using every bar gave z up to −4.5 and looked convincing. Forward
windows of 24 bars on adjacent rows overlap almost entirely, so nominal n=318,085 is really
13k-53k independent observations. Striding by the horizon:

| horizon | independent n | (nominal) | max abs t |
|---|---|---|---|
| +30m | 53,014 | 318,085 | 1.77 |
| +60m | 26,507 | 318,079 | 1.58 |
| +120m | 13,253 | 318,067 | 1.14 |

Nothing clears t=2. Net $/trade negative in nearly every cell.

## 2. Why it is empty — most of it is momentum we have already tested

R² of each trigger feature regressed on {30m momentum, 2h momentum, c−SMA20, c−EMA50}:

| feature | R² | reading |
|---|---|---|
| `c_vs_T5` | 0.699 | repackaged momentum |
| `slopeT5` | 0.604 | repackaged momentum |
| `c_vs_T1` | 0.557 | repackaged momentum |
| `c_vs_TH` | 0.272 | partly novel |
| `T5_vs_TH` | 0.204 | partly novel |
| **`c_vs_TD`** | **0.029** | **nearly orthogonal** |
| **`TH_vs_TD`** | **0.005** | **essentially orthogonal** |

RMA(14) on 5m is a short moving average, so the fast triggers cannot be anything else. The
DAILY-scale relations genuinely are new information — and the stack score diluted them by
averaging them with the redundant ones.

## 3. The orthogonal daily-scale features, tested directly — still nothing

Quintiles of `c_vs_TD` and `TH_vs_TD`, independent (strided) observations, +60/120/240m:
**max abs t = 1.78**, no monotonicity. Large-looking net$ cells (+$93 at q0/+240m) carry
t = 0.25 and are drift.

## Verdict

The trigger levels carry **no standalone directional alpha** on NQ at 5m-4h horizons —
neither the fast components (already-known momentum) nor the orthogonal daily ones.

Not ruled out, and the framing the repo's own history favours: triggers as a **conditioner**
on an already-validated edge rather than a signal in their own right
("conditioners only sharpen forced-flow edges", [[internals-breadth-program]]). That test
needs an edge to condition, e.g. PCC, not a standalone sweep.

## Method notes worth keeping

1. **Stride by the horizon.** Overlapping forward windows inflated z from <2 to −4.5.
2. **Subtract the unconditional mean.** NQ's drift makes every cell look positive.
3. **Normalise by ATR on BOTH sides** — see the compression finding above.
4. **Check redundancy before hunting.** An R² of 0.70 against plain momentum would have
   predicted the null before any of the return work was done.

---

# LT-fibs vs T-levels (2026-08-21)

**Terminology** (settled to stop "trigger" collisions):
* **T-levels** — Liquidity Toolkit | T: `T5`, `TH`, `TD` = `RMA(close,14)` per timeframe.
* **LT-fibs** — Liquidity Triggers, named by PERIOD: `LT34`, `LT55`, `LT144`, `LT377`, `LT610`.
  Name by period, never index: the indicator's UI numbers them Fib 1..7 (8/13/34/55/144/377/610)
  while `lt-monitor` keys them `L0..L6`, so the UI is ONE AHEAD of our code.

Backtest CSV maps: `level_1..level_5` = LT34/LT55/LT144/LT377/LT610, confirmed by
responsiveness (mean|diff| 18.10 / 13.66 / 9.08 / 7.14 / 6.73, monotonic).
128,292 rows, 15-min cadence, 2021-01-27 -> 2026-07-14.

## 🚨 MY ALIGNMENT BUG — the one Drew called out

First pass showed LT spikes predicting reversal at **t = -6 to -19**, and
`corr(dLT, next price change)` of **-0.14 to -0.21**. All of it was mine.

`triggers_NQ_mtf.csv` labels bars by OPEN time, and the LT feed labels each snapshot by its
CANDLE OPEN. A 15-minute LT value stamped 07:30 is known only at **07:45**. My `merge_asof`
attached it to the 5m bars at 07:30 / 07:35 / 07:40 — up to 15 minutes before it existed.

I had applied exactly this rule to T:H (`avail = dt + 1h`) and T:D and then failed to carry
it to LT. **The rule: a value labelled T on an N-minute series is knowable at T+N, never at T.**

Fixed (`avail = dt_open + cadence`, joined on the 5m bar's CLOSE):

| | dC[t-1] (past) | dC[t] | dC[t+1] (FUTURE) |
|---|---|---|---|
| before fix | +0.10 | +0.04..+0.21 | **-0.14 .. -0.21** |
| after fix | +0.18..+0.27 | -0.09..-0.29 | **+0.012 .. +0.015** |

Forward information is now zero, and the levels load on PAST price as a lagging level must.

## Results after the fix

**Directional: nothing.** LT spikes (>6x their own MAD; kurtosis 847-1616, so genuinely
fat-tailed events rather than wiggle) give excess of -2.5..+3.1 pts, all |t| < 1.72, no
consistent sign across level or horizon.

**Volatility: small but the largest residual we have found.** |move| after a spike is
1.40-1.57x normal raw; ATR at spike 21.5 vs 16.1 normal, so most of it is volatility
clustering — but the ATR-NORMALISED ratio is still **1.08-1.17x**, versus 1.02x for the
T5/TH compression test. Not directional, so its use would be sizing/vol, not entry.

**Redundancy: LT-fibs are genuinely new information.** R² of each LT change on
{dT5, dTH, dTD, dPrice} is only **0.09-0.25** — unlike the T-levels, which were 0.56-0.70
against plain momentum. Whatever LT is doing, it is not a moving average of price.

## Also pulled: the LT indicator's full output map

`dump-study.js --script "PUB;93e43ec4c20f420fac2b70f0f2b286cf" --tf 15` gives
28 plots: `2=LT`, `4..16 = L1..L7`, `18/20 = LT Reference-1/2`, `22/23 = Is Bullish/Bearish`,
`24/25 = Has Become Bullish/Bearish`, and — untested — **`26 = Suspected Rip Incoming`,
`27 = Suspected Dip Incoming`**.

## Full sweep: expansion / compression / deviation / snap-back — all empty

Ten features x horizons on correctly-aligned data, independent (strided) samples:
price deviation from each of the five LT-fibs, distance to the NEAREST level, fan width
(LT max-min), fan expansion rate, LT34-vs-LT610 spread, price vs fan centre.

**Directional: nothing, anywhere.** Every q4-q0 spread has |t| < 1.60. No level, no
distance, no spread, no width, at 60m or 120m.

**Volatility: everything that looked strong was volatility state in disguise.**

| feature | q4/q0 fwd \|move\| (ATR-norm) | t | after controlling for plain vol |
|---|---|---|---|
| `fan_chg` (60m expansion rate) | 0.701x | **-14.02** | **t = -0.37 / -1.80 — GONE** |
| `fan_width` | 1.154x | +5.89 | t = +3.62 / +4.31, incremental R² **+0.0005** |
| `dev_near` | 1.104x | +3.66 | not tested separately |

The `fan_chg` result was the strongest single number found all session (t=-14) and it is
pure volatility proxy. Worse, plain realised-vol features BEAT it at its own job and in the
opposite direction: `vol_ratio_chg` gives q4/q0 = 1.905x at **t = +24.19** (vol begets vol),
versus the fan's 0.701x at t=-14. `fan_width` does survive the control, but adds 0.1% of
variance — statistically real, economically nil.

### Verdict on the LT-fibs

No tradeable alpha in the levels themselves: not from where price sits relative to them,
not from how far apart they are, not from how fast they spread or contract, not from
snap-back to the nearest one. The one property that IS distinctive — they are genuinely
non-redundant with price and the T-levels (R² 0.09-0.25) — does not convert into forward
information about either direction or volatility beyond what ATR already says.

### What remains untested (the honest gap)

The indicator's own directional calls, which are unambiguous outputs rather than something
we derive: plots **26 "Suspected Rip Incoming"** and **27 "Suspected Dip Incoming"**, plus
`22/23 Is Bullish/Bearish` and `24/25 Has Become Bullish/Bearish`. Everything above tests
OUR constructions from the levels; those test the AUTHOR'S. Cheap to run with
`dump-study.js` now that the plot map is known.

## Directionality and reversals — also empty

Slope over 60min, ATR-normalised, computed on windows long enough that the 15m ffill
cannot fake them. Independent (strided) samples, drift removed.

| test | series | best abs t |
|---|---|---|
| **direction state** (rising / flat / falling) | LT34/144/610, T5/TH/TD | **1.48** |
| **reversal** (level bottom / level top, detected causally) | same | **1.04** |
| **confluence** (all 5 LT-fibs rising / all falling) | LT ladder | **0.57** |
| **mass flip** (ladder swings from mostly-down to mostly-up) | LT ladder | **1.25** |

Nothing clears t=2 anywhere, in either direction, at 60m or 120m. Volatility is flat too —
|move| ratios 0.94-1.08x for the confluence states.

### The feature space is now covered

Across this and the previous sweeps, on 311,625 correctly-aligned 5m bars (2021-2026):
crossovers, compression, expansion rate, fan width, deviation from price, deviation
between levels, distance to nearest level, snap-back, spikes, direction, reversals,
confluence, mass flips. **No directional edge anywhere.** The only survivors were
volatility restatements that died under an ATR control, except `fan_width` at +0.1% R².

The levels describe where price has been. They do not appear to say anything about where
it goes next, at 5m-2h horizons, on NQ.

### The one genuinely untested thing

The indicator's OWN outputs, which are claims rather than our constructions:
plots **26 "Suspected Rip Incoming"**, **27 "Suspected Dip Incoming"**,
`22/23 Is Bullish/Bearish`, `24/25 Has Become Bullish/Bearish`. If the author encoded
something beyond the level geometry, it lives there — everything above tests geometry.

## "Buyers/sellers stepping in at a level" — candle signature x level interaction

Drew's framing: not the levels alone, but a candle signature that says someone defended a
level. Substrate: `firstbreak/NQ_5m_fb.csv` (wick/volume/time features + a 1s-honest causal
outcome), joined to all eight levels with candle-close alignment. 293,915 rows.

Rejection candle = lower wick > 40% of range, close in the top 30% (`clv > 0.7`), down-wick
volume in the top 40% — i.e. price was pushed down and bought back with volume in the wick.
Mirror for sellers. "At a level" = the wick pierced one of the eight and the candle closed
back on the other side.

**The control is the whole point**: does the LEVEL add anything to the signature alone?

| | +30m | +120m |
|---|---|---|
| BUY rejection **at a level** | -0.52 (t=-1.33) | **-1.89 (t=-1.76)** |
| BUY rejection, **no level** | +0.10 (t=+0.31) | +0.65 (t=+0.71) |
| SELL rejection **at a level** | -0.20 (t=-0.44) | -0.17 (t=-0.15) |
| SELL rejection, **no level** | -0.25 (t=-0.77) | +0.09 (t=+0.11) |

No edge, and the level makes it WORSE for the buy side rather than better. On the
first-break payoff the same test gives -0.08pp with a level vs -0.41pp without (control),
against the ~+7pp needed — and the sign is backwards: a high-volume down-wick slightly
predicts the LOW breaking first, i.e. continuation, not rejection.

### Why this probably cannot work from OHLCV

"Buyers stepping in" is an order-flow statement — resting bids absorbing market sells. A
wick with volume in it is only a proxy: it cannot distinguish absorption (passive buyers
soaking supply) from a fast round trip (sellers hit, then buyers lift). Both print the same
candle. Measuring it properly needs the book/tape, not OHLCV — and per
[[orderflow-sweep-strategy]] the tape came back EFFICIENT, and the MBO recon in
[[vacuum-program]] found a fragility footprint with NO direction.

So this is the third route to the same wall: the geometry of levels, the shape of candles,
and their interaction all fail to say who is stepping in.

### Two of my own bugs worth recording

1. `clv` is on **0..1**, not -1..1. My first sell-side filter used `clv < -0.5` and matched
   **zero** candles — the sell side silently went untested until the counts were checked.
   Always print event counts before reading results.
2. Earlier in the same file: LT levels joined on candle OPEN rather than candle CLOSE, worth
   up to 15 minutes of lookahead (see the alignment section above).

## Is the ORDER BOOK different when price is at an LT level? (first look)

Never previously tested — the level work was all OHLCV, and the MBO work was about vacuum
candles, not levels. Substrate: `orderflow/nq/book-imbalance-1m.csv` (377k 1m rows,
2025-01 -> 2026-01), joined to LT levels with candle-close alignment. 60,762 overlapping rows.

Control: a **placebo level set** shifted +37.5pt. Tests "this level" against "a level".

### Two confounds had to be removed first

1. **The raw sums are activity, not depth.** `totalBidSize` is summed over the minute's
   book updates, so it scales with `updates`. Raw, it showed the book at 0.527x near a level
   — but the placebo showed 0.615x, i.e. mostly not level-specific. Per-update normalisation
   is required.
2. **Proximity to a level IS a volatility state.** ATR near a level 15.54 vs 26.53 far,
   because the levels lag price: calm price sits on them, running price leaves them behind.
   Un-matched, |imbalance| looked 1.204x higher near levels at t=13.35.

### Volatility-matched result: nothing

| ATR bucket | REAL imb near/far | t | PLACEBO | t |
|---|---|---|---|---|
| 0-4 | 0.995 / 1.055 / 0.976 / 1.003 / 1.091 | all abs t < 2 | comparable | comparable |

Depth per update: REAL 0.992 / 1.018 / 1.026 / **1.112** / 1.045; PLACEBO 1.033 / 1.045 /
1.078 / 1.042 / 1.051 — the placebo is LARGER in three of five buckets. One cell (bucket 3,
1.112x at t=10.77) exceeds its placebo, which is one standout in ten comparisons.

**The book is not meaningfully different when price is at an LT level.**

### 🚨 But this does NOT answer the sharpest version of the question

`book-imbalance-1m.csv` is a per-minute AGGREGATE. It cannot see WHERE in the book the size
sits. The question that matters — *is there resting size AT the level's price* — needs an
actual depth snapshot keyed to price, which is what `mbp-1/` (407GB) and `mbo/` (58GB) hold
and this file does not.

That version is well-posed and is the kind of STATE question order-book data answers well
(as opposed to direction, which it does not — see the vacuum program's "fragility footprint,
NO direction"). Concretely: for each LT level at each moment, how much size rests within
N ticks of it, versus a placebo price the same distance from spot? If the levels coincide
with real resting liquidity, that is a genuine finding even though the levels predict
nothing directionally — it would matter for EXECUTION (where stops get run, where limits
fill) rather than for entry.
