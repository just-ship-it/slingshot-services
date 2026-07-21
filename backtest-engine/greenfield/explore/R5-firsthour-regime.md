# R5 — First-Hour Regime Classifier

**Question (owner's hypothesis):** dealers "show their hand" in the first NY hour; the
day settles into a recognizable regime (buy-the-dip / sell-the-rip / sweep-revert /
one-way-trend / chop) identifiable by ~10:30 ET from first-hour price BEHAVIOR, and that
regime predicts how the REST of the day trades.

**Verdict: DEAD as a regime effect.** First-hour regimes do **not persist** into the
afternoon (labels dissolve by lunch), and on NQ **no regime beats an unconditional
same-day-type baseline** (first-hour direction × vol tercile). The directional signal that
exists is unconditional momentum-continuation-scaled-by-vol — the exact sibling-study trap.
One residual (ES sweep-revert) beats its baseline on ES but **fails to replicate on NQ**
(sign inverts across years) → not a robust, cross-market edge. Descriptive census only
(no fills/WR/PF — those are a later 1s step).

Data: NQ 1m primary cache (2021–2026, 1348 clean RTH days w/ ATR), B12 day features
(ON range, ATR, gap — all knowable at 09:30), ES 1m primary (1231 clean days). Clean day =
`full_rth & rth_same_sym` (no roll-in-day). Effects reported ATR14-normalized.
Each metric is **one value per day**, so pooled == day-weighted here (honesty rule #8 has
no multi-signal-per-day divergence to flag).

## Pre-registered regime definitions (declared BEFORE measuring outcomes)

All computed from **≤10:30 ET data only** (first hour = 09:30–10:29, 60 bars) plus the
overnight range (ON high/low, 18:00→09:30, knowable at 09:30). No threshold sweep — one
fixed set of thresholds:

- `net = fh_close − fh_open`; `rng = fh_high − fh_low`; `prog = |net|/rng` (efficiency);
  `loc = (fh_close − fh_low)/rng` (close location in range).
- **PROG_ONEWAY = 0.60, PROG_CHOP = 0.25, LOC_UP = 0.70, LOC_DN = 0.30.**

Priority-ordered (each day gets exactly one label):
1. **SWEEP_REVERT_BEAR** — first hour took out the ON high (`fh_high > on_high`) but closed
   back below it (`fh_close < on_high`) with `net < 0` (failed breakout, bearish).
2. **SWEEP_REVERT_BULL** — mirror: took out ON low, closed back above, `net > 0` (failed
   breakdown, bullish).
3. **ONEWAY_UP** — `prog ≥ 0.60 & net>0 & loc ≥ 0.70` (monotone drive, close near high).
4. **ONEWAY_DOWN** — `prog ≥ 0.60 & net<0 & loc ≤ 0.30`.
5. **CHOP** — `prog < 0.25` (two-sided, no net progress).
6. **BTD** — otherwise `net>0` (moderate-efficiency advance = dips bought).
7. **STR** — otherwise `net<0` (moderate-efficiency decline = rips sold).

Afternoon texture (for persistence) labels the 13:00–16:00 window with the same
efficiency scheme → family UP / DOWN / CHOP.

## 1. Frequency & stability (NQ)

| regime | share | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|
| ONEWAY_UP | 17.6% | 19 | 17 | 19 | 16 | 16 | 21 |
| ONEWAY_DOWN | 13.1% | 11 | 17 | 11 | 15 | 13 | 12 |
| BTD | 15.4% | 18 | 15 | 13 | 16 | 17 | 12 |
| STR | 15.5% | 13 | 17 | 15 | 15 | 19 | 16 |
| CHOP | 14.2% | 15 | 11 | 18 | 14 | 13 | 15 |
| SWEEP_REVERT_BULL | 10.9% | 9 | 13 | 10 | 11 | 10 | 13 |
| SWEEP_REVERT_BEAR | 13.4% | 16 | 11 | 14 | 15 | 13 | 11 |

Regimes are well-populated and stable year-to-year. Sweep-revert is **not rare** (~24%
of days combined) — first-hour breaks of the ON range fail-and-revert reasonably often.
So the definitions are usable; the problem is downstream (persistence + prediction).

## 2. PERSISTENCE — the crux. Do 10:30 labels still describe 13:00–16:00? NO.

10:30 regime → realized 13:00–16:00 family, match rate vs afternoon-family base rate:

| morning regime | n | match% | base% | **lift** (NQ) | lift (ES) |
|---|---|---|---|---|---|
| ONEWAY_UP | 237 | 46.0 | 41.5 | **1.11** | 1.06 |
| ONEWAY_DOWN | 177 | 40.7 | 32.8 | **1.24** | 1.21 |
| BTD | 207 | 42.5 | 41.5 | **1.02** | 0.98 |
| STR | 209 | 34.9 | 32.8 | **1.07** | 1.02 |
| CHOP | 191 | 25.1 | 25.7 | **0.98** | 0.93 |
| SWEEP_REVERT_BULL | 147 | 42.2 | 41.5 | **1.02** | 1.30 |
| SWEEP_REVERT_BEAR | 180 | 36.1 | 32.8 | **1.10** | 1.17 |

**Regimes do not persist.** The best NQ lift is 1.24 (ONEWAY_DOWN) and most are ~1.00–1.11.
CHOP is the tell: a chop morning predicts a chop afternoon at **below** the base rate
(lift 0.98 NQ / 0.93 ES) — morning texture carries essentially no information about
afternoon texture. By ~13:00 the morning regime has dissolved. **Untradable on the
persistence axis alone.**

## 3. PREDICTION vs the load-bearing control

Rest-of-day drift = (close − 10:30 price)/ATR14. Raw per-regime means look mildly
directional on NQ (ONEWAY_UP +0.04 t1.6, ONEWAY_DOWN −0.065 t−1.7, SWEEP_BULL +0.067 t2.0,
SWEEP_BEAR −0.05 t−1.4). **But the raw numbers are the trap.**

The unconditional (fh_dir × vol tercile) baseline already carries the whole signal:

| cell | n | mean rod/ATR | t |
|---|---|---|---|
| fh_dir +1, vol hi | 207 | **+0.068** | +1.89 |
| fh_dir +1, vol mid | 239 | +0.052 | +1.69 |
| fh_dir +1, vol lo | 252 | +0.012 | +0.47 |
| fh_dir −1, vol hi | 239 | **−0.053** | −1.49 |
| fh_dir −1, vol mid | 210 | −0.011 | −0.34 |
| fh_dir −1, vol lo | 200 | +0.008 | +0.29 |

i.e. "first hour up + high realized range → rest of day drifts up," and mirror down. That
is unconditional intraday momentum scaled by vol. **Regime EXCESS over its own cell (NQ):**

| regime | n | excess/ATR | t | placebo p (within-cell shuffle) |
|---|---|---|---|---|
| ONEWAY_UP | 237 | −0.007 | −0.28 | 0.564 |
| ONEWAY_DOWN | 177 | −0.036 | −0.95 | 0.099 |
| BTD | 207 | −0.016 | −0.44 | 0.759 |
| STR | 209 | +0.028 | +0.90 | 0.736 |
| CHOP | 191 | +0.042 | +1.19 | 0.106 |
| SWEEP_REVERT_BULL | 147 | +0.020 | +0.61 | 0.293 |
| SWEEP_REVERT_BEAR | 180 | −0.030 | −0.86 | 0.231 |

**No NQ regime adds anything over the unconditional same-day-type baseline** (all |t|<1.2,
all placebo p>0.09). The regime label is redundant with "first-hour direction + vol." This
is precisely the sibling-study finding restated: continuation is unconditional drift, not a
regime effect.

### The one residual: ES sweep-revert — beats baseline on ES, DIES on NQ

ES is the only place any regime beats its baseline:

| regime (ES) | n | excess/ATR | t | placebo p | per-year excess sign |
|---|---|---|---|---|---|
| SWEEP_REVERT_BULL | 84 | +0.145 | +3.08 | **0.0125** | +,+,+,+,+,+ (stable) |
| SWEEP_REVERT_BEAR | 114 | −0.135 | −3.07 | **0.0025** | 0,−,−,−,−,− (2021 flat) |

On ES, a first-hour failed break of the ON range genuinely predicts rest-of-day drift in
the reversal direction, beyond vol/direction, and survives the within-cell placebo. **But
the identical definition on NQ produces a null that inverts sign across years:**

- NQ SWEEP_REVERT_BULL per-year excess: +0.10, +0.02, +0.08, −0.00, −0.03, −0.08 (pooled +0.020, t0.61)
- NQ SWEEP_REVERT_BEAR per-year excess: +0.07, −0.23, −0.04, −0.05, +0.02, +0.09 (pooled −0.030, t−0.86)

Same regime, correlated index, opposite conclusion, and NQ's sign flips year to year →
**fails the charter's cross-market + per-year-stability bars.** Not a deployable edge. Most
likely ES-specific microstructure or noise; flagged for the record, not for a book.

## 4. Short-side / counter-trend scan

- **ONEWAY_DOWN (NQ)** is the only regime with all-years-negative *raw* rest-of-day drift
  (−0.065/ATR). But its EXCESS over the unconditional down-day baseline is −0.036 (t−0.95,
  placebo p=0.099) → it is just the unconditional "first-hour-down, high-vol continues down"
  drift, **not a regime-specific short edge.**
- **SWEEP_REVERT_BEAR** is short-biased and beats baseline **on ES only**; NQ refutes it
  (see above). No robust short-side conditional edge survives.

## Shortlist of regime→rest-of-day edges beating the unconditional baseline

**Empty.** Nothing clears the bar (beat baseline + per-year sign-stable + cross-market).
The single item that beat *a* baseline (ES sweep-revert) is ES-only and NQ-refuted.

Closest-to-interesting (parked, NOT candidates):
- ES SWEEP_REVERT_BEAR/BULL: real on ES (placebo p<0.02, per-year stable), effect ~0.14 ATR
  (~15–20 ES pts over 5.5h). Live-computable (ON range + first-hour OHLC only). Dead on NQ.
  A 1s follow-up is **not** warranted until the NQ contradiction is explained.

## DEAD list (regime effects that decompose to unconditional day-type / noise)

- ONEWAY_UP → rest-of-day up: = unconditional up-first-hour/vol drift (excess t−0.28).
- ONEWAY_DOWN → rest-of-day down: = unconditional down drift (excess t−0.95); no short edge.
- BTD / STR: no excess over baseline (t−0.44 / +0.90); "dip-buying continues" is not a
  distinct predictor.
- CHOP → chop afternoon: below chance (persistence lift 0.98/0.93) — actively uninformative.
- SWEEP_REVERT (both) on **NQ**: null, sign-inverts across years.
- **Persistence generally**: 10:30 regime does not describe 13:00–16:00 texture above ~1.1×
  chance on NQ. Regimes dissolve by lunch.

## Explicit answers

- **Do first-hour regimes persist?** No. Max afternoon-match lift ~1.1–1.24 (NQ), CHOP
  below chance. The 10:30 label does not survive to 13:00–close.
- **Does any regime beat the unconditional same-day-type baseline?** On NQ: none (all
  |t_excess|<1.2, placebo p>0.09). On ES: sweep-revert does, but it fails to replicate on
  NQ (sign inverts by year) → not robust.
- **Any short-side conditional edge?** Only ES SWEEP_REVERT_BEAR, and it is NQ-refuted. No
  deployable short regime.
- **Clearest null:** first-hour "regime" directional prediction is unconditional
  momentum-continuation scaled by vol; the texture label adds no conditional information
  once you know first-hour direction and vol tercile.

## Files
- `R5_prep.py` — builds `R5-days.csv` (causal first-hour label + rest-of-day/afternoon outcomes, NQ).
- `R5_analyze.py` — frequency, persistence, prediction, unconditional-baseline excess, shuffle placebo (NQ).
- `R5_es.py` — ES cross-check (ON range + ATR14 computed from ES cache).
- `R5-days.csv` — per-day intermediate.
