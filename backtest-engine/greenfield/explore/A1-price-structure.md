# A1 — Price-Action Structure Census of NQ Futures (1m OHLCV, Dec 2020 → Jun 2026)

**Status:** descriptive census. NO win rates, NO profit factors, NO fill simulation — those
require 1s data per KNOWABILITY.md. Everything here is a statistic, not a strategy result.

## Data & method

- Source: `data/ohlcv/nq/NQ_ohlcv_1m.csv` (raw contracts). Calendar-spread rows dropped;
  primary contract selected per clock-hour by highest volume (`A1-00-build-cache.py`).
  2,796,681 raw rows → 1,934,369 primary bars, 1,399 trade days, 2021-01-11 → 2026-06-15.
- ES check: `data/ohlcv/es/ES_ohlcv_1m.csv`, 2021-02 → 2026-01, 1,209 usable days.
  **Data note:** the ES 1m source contains fragmented duplicate bars (multiple partial rows
  for the same symbol+minute). The cache builder merges them (o=first, h=max, l=min, c=last,
  v=sum). NQ source verified free of duplicates.
- Returns are NEVER computed across a symbol change (rollovers excluded pairwise).
- Sessions in ET: RTH 09:30–15:59 bars, overnight (ON) 18:00 prev → 09:29. Half days
  (<300 RTH bars) excluded from session studies. Usable full-session days: **1,319**.
- Normalization: ATR14 = mean of prior 14 full-day session ranges, **shifted one day**
  (knowable before the session). Mean ATR by year (pts): 2021: 238, 2022: 372, 2023: 244,
  2024: 299, 2025: 413, 2026: 475 (pooled 327). Multiply ATR-unit effects by these to get points.
- Knowability: a 1m bar stamped T is used only after T+60s. Every conditional statistic
  conditions on information closing strictly before its outcome window. Per-year splits
  reported for every flagged effect; sign-inversion across years = ruled noise.

Scripts: `A1-00-build-cache.py` (cache builder), `A1-01…A1-09` (one topic each),
raw outputs in `out-A1-*.txt`, day-level cache `cache/NQ_daily_sessions.csv`.

---

## 1. Volatility & volume seasonality (A1-01)

Mean 1m range in ATR-units by ET hour (all years; n≈84k bars/hour):

| ET hour | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 18 | 19 | 20 | 21 | 22 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rng/ATR ×100 | .92 | 1.16 | 1.47 | **2.06** | 1.83 | 1.56 | 1.58 | 1.77 | 2.44 | **4.36** | **4.88** | 3.74 | 3.14 | 3.07 | 3.23 | 3.51 | 1.65 | 1.47 | 1.22 | 1.49 | 1.34 | 1.12 | .95 |
| vol share/day | .6% | .8% | 1.1% | 1.8% | 1.6% | 1.3% | 1.4% | 1.8% | 3.5% | **14.7%** | **16.3%** | 11.3% | 8.6% | 7.9% | 8.4% | **11.9%** | 3.0% | 1.1% | .9% | 1.1% | 1.0% | .8% | .6% |

- Classic U-shape in RTH: 09:30–10:30 carries ~31% of daily volume; 15:00–16:00 a secondary
  peak. The 09:30 five-minute bucket alone runs 0.082 rng/ATR per minute — ~2.5× midday.
  Shape is stable in every year (per-year table in `out-A1-01.txt`).
- **03:00 ET (Europe cash open) bump**: hour-3 vol is ~2.2× hour-0/1, every year. Real,
  stable, and the largest overnight feature.
- 14:00 ET Wednesday bump (FOMC days) visible in the hour×dow interaction (0.041 vs
  ~0.030 other days) — event-driven, sanity check that the pipeline is honest.
- Day-of-week: Monday has the lowest RTH range (0.78 ATR) vs Thursday highest (0.90).
  Monday-lowest holds in 5/6 years (2021 inverted). Weak; regime-dependent.
- Regime note: 2025–2026 overnight hours (18:00–23:00) run ~50% hotter in ATR units than
  2023–2024 — the overnight/RTH vol split is not stationary.

## 2. Session structure & gaps (A1-02)

n=1,319 days (gap pairs exclude rolls; n as shown).

- ON range: mean 0.57 ATR; RTH range: mean 0.84 ATR. corr(ON range, RTH range) = 0.345,
  positive every year (0.20–0.49).
- **Gap (RTH open − prior RTH close):** median |gap| = 0.23 ATR (~68 pts pooled).
  Distribution roughly symmetric (5%/95% quantiles ±0.69 ATR).

**Gap fill (touch prior RTH close during RTH) by |gap| size — monotone and stable:**

| \|gap\| (ATR) | n | fill rate | median mins to fill |
|---|---|---|---|
| 0–.05 | 152 | 96.1% | 0 |
| .05–.1 | 159 | 89.9% | 4 |
| .1–.2 | 276 | 76.1% | 14 |
| .2–.35 | 290 | 56.2% | 32 |
| .35–.6 | 268 | 41.8% | 82 |
| >.6 | 170 | 24.1% | 142 |

Per-year: small gaps (≤0.1 ATR) fill 89–96% every year; big gaps (>0.2 ATR) fill 35–50%
every year. **ES replicates almost exactly** (98%→25% across the same buckets).

- Gap **direction** → RTH return: MIXED across years in every size bucket (e.g. big-gap-up
  fade in 2025, go in 2024). No stable directional edge. Dead as a direction signal.

**Overnight extremes vs RTH:**

- 96.4% of days RTH breaks at least one ON extreme; 26.6% break both; 3.6% inside days.
- Median time to first break: ON-high 15 min, ON-low 21 min after the open.
- By ON-range tercile (knowable at 09:30): low-ON-range days break both extremes 38.3%
  vs 15.7% for high-ON-range days; RTH range rises 0.72 → 1.00 ATR from low to high tercile
  — but in *expansion* terms the compressed-ON days expand most vs their overnight.
  ES: 35.3% vs 12.2%, same shape. Stable every year on both instruments.

## 3. Timing of RTH extremes (A1-03)

- RTH high forms in first 30m on 29.6% of days, last 30m on 19.8% — U-shaped, midday trough.
  Low: 33.4% first 30m, 14.6% last 30m.
- **P(at least one RTH extreme is set in the first 30m) = 62.5%; first 60m = 79.1%.**
  Per-year 60m: 0.82/0.76/0.78/0.78/0.77/0.87 — stable. ES: 52.4%/71.0% (weaker but same).
- P(both extremes in first 60m — rest of day fully inside) = 3.0%.
- Day-type (descriptive, ex-post labels): trend days (close in outer 15% of range,
  range >0.8 ATR) put the counter-extreme in the first hour ~78% of the time and the
  final extreme in the last 30m 61–71% of the time.

## 4. Return autocorrelation & momentum (A1-04)

- Lag-1 AC of non-overlapping intraday RTH returns: 1m +0.004, 5m +0.001, 15m +0.003,
  30m +0.008 — all MIXED across years. **The tape is efficient at these horizons on 1m data.**
  60m: +0.047, positive 5/6 years (only 2022 −0.01) — weakly suggestive only.
- **First-60m direction → rest of day (10:30 close → 15:59 close):** hit 55.8%, aligned
  mean +0.032 ATR (~10 pts), corr +0.067, **positive all 6 years** (+0.001…+0.050).
  First-15m variant on |move|>median also STABLE(+) but tiny (+0.036 ATR).
  **Caveat: ES is MIXED (3+/3−, aligned +0.013)** — does not generalize cleanly.
- First-60m → **last hour only**: dead (aligned +0.002, MIXED). The classic "intraday
  momentum" (first hour predicts last hour) form is NOT present 2021–2026.
- Session-to-session: ON→RTH (hit 48.8%), RTH→next-ON, RTH→next-RTH — all corr ≈ −0.03..−0.04,
  MIXED per year. No stable sign prediction day-to-day.

## 5. Volatility dynamics (A1-05)

- Daily range/ATR persistence: lag-1 corr +0.23, positive all 6 years (0.02–0.43).
- **Intraday 15m range clustering (de-seasoned): corr +0.61, n=34,671, positive every year
  (+0.48…+0.69). ES: +0.64, every year.** The strongest, most stable regularity in the census.
- First-hour range quartile → rest-of-day range: narrow 0.55 ATR vs wide 0.83 ATR,
  narrow-minus-wide negative all 6 years (−0.13…−0.38). I.e. intraday vol clustering, not
  compression-then-expansion: **a quiet first hour predicts a quiet rest-of-day.**
- NR7 daily compression → next-day expansion: **FALSE** (NR7 days are followed by *smaller*
  next-day range, ratio 0.90, MIXED 2+/4−). Compression does not predict expansion at the
  daily scale either.
- Trend days: 21.2% of days (range>0.8 ATR and close in outer 15%); frequency drifting down
  (24% 2022 → 15% 2026). Early signature: first-hour "drive" (|10:30−open| / first-hour
  range) top quartile → aligned continuation +0.041 ATR, hit 59.4%, positive 5/6 years
  (2021 −0.007). Modest, borderline.

## 6. Volume/price interaction (A1-06)

Causal baseline: per minute-of-day rolling median of prior 20 same-minute volumes.

- Spikes ≥4× baseline (n=4,740 RTH bars): forward 5m/15m/30m return aligned with the spike
  bar's direction = −0.001/−0.000/+0.006 ATR, **all MIXED across years**. Split by context
  (breakout of prior-60m range vs interior): still MIXED everywhere. Climax-reversal and
  continuation are both absent at 1m resolution.
- The only stable fact: **vol persistence** — |15m forward return| after a ≥4× spike is
  1.5–2.2× a quiet bar's, every year. A spike tells you vol arrived, not direction.

## 7. Round numbers (A1-07)

First touch per day of 100/250/500/1000-pt multiples, penetration measured 15/30m after the
touch-bar close, vs placebo grids (same spacing, offsets +23/+41/+59/+77; +137 for 500s).

- 100s: pen30 = +0.004 ATR, P(beyond at 30m) = 0.525 — placebos span −0.001…+0.002 and
  0.497–0.507. Differences are inside placebo noise and MIXED per year.
- 250s/500s/1000s: same story; the 1000s "STABLE" line has only 2 years with n>60 — noise.
- Close-price clustering mod 100: flat (worst bin 1.94%, best 2.08% vs uniform 2.00%).
- **Verdict: NQ shows no measurable round-number behavior distinguishable from placebo.**

## 8. ON-extreme break follow-through (A1-08)

After the first ON-extreme break (n=1,272): P(close beyond the broken extreme) ≈ 0.51 pooled,
~0.48–0.53 every year regardless of break time or side. Continuation from break-bar close to
RTH close: MIXED. **Breaking the overnight extreme carries no directional information by itself.**

---

## RANKED SHORTLIST — candidate structures worth pursuing

**#1. Intraday volatility clustering / first-hour range → rest-of-day range.**
Effect: 15m de-seasoned range lag-1 corr +0.61 (n=34,671), positive every year; first-hour
range quartile spreads rest-of-day range 0.55 → 0.83 ATR (≈ 90 → 270 pts at 2025 ATR),
stable 6/6 years; replicates on ES (+0.64, 6/6). Not directional — this is the *conditioning
layer*: it says vol regime for the day is largely knowable by 10:30.
Follow-up: build a knowable 10:30 vol forecast (first-hour range/ATR + ON range/ATR) and test
whether it usefully gates stop width, target width, and strategy family (breakout vs fade) in
1s simulation of whatever directional candidates survive.

**#2. Gap-fill magnetism (fill probability curve).**
Effect: fill rate monotone 96% → 24% across |gap| 0→>0.6 ATR, stable every year, near-identical
on ES; median time-to-fill scales 0 → 142 min. Sample: 1,315 gaps. Economically plausible
(inventory/auction reversion to prior settlement area). The *direction-of-day* given a gap is
dead — the candidate is strictly "prior RTH close acts as a high-probability touch target for
sub-0.2-ATR gaps, early."
Follow-up: 1s study of entries at 09:30 open toward the fill on |gap| in [0.05, 0.2] ATR with
defined risk beyond the ON extreme; measure honestly with slippage. Also test the *converse*:
gaps >0.35 ATR NOT filling in the first hour as an acceptance/trend-day input to #4.

**#3. Overnight-range compression → RTH expansion & double-break structure.**
Effect: lowest ON-range tercile (knowable at 09:30) → both ON extremes broken 38.3% vs 15.7%
(NQ, n=441/440), ES 35.3% vs 12.2%; stable direction every year. Compressed overnights produce
whippy, double-sided RTH sessions; wide overnights contain the day (RTH stays inside more).
Follow-up: condition ON-extreme breakout behavior on ON-range tercile: on low-ON days a first
break is far more likely to be reversed (both broken) — test fade-the-first-break on 1s data;
on high-ON days test the inside-day/containment play.

**#4. Early-extreme anchoring (one side of the day is set in the first hour).**
Effect: one RTH extreme final by 10:00 on 62.5% of days, by 10:30 on 79.1%; stable 6/6 years
(0.76–0.87); ES 71% at 10:30. This is the structural skeleton for any "hold the morning
extreme" trade: after 10:30 the open-side extreme survives to the close on ~4 of 5 days.
Follow-up: the conditional form — given the first-hour high/low and a 10:30 drive/position
signature, what is P(each side survives)? Then a 1s test of stop placement beyond the
favored extreme. Must beware selection: which extreme survives is correlated with
direction already traveled (interacts with #5).

**#5. First-hour direction → rest-of-day drift (NQ-only, weak).**
Effect: aligned rest-of-day return +0.032 ATR (~10 pts, ~0.1%/day gross), hit 55.8%, positive
all 6 NQ years; drive-quartile variant +0.041 ATR, 5/6 years. BUT: ES MIXED (3+/3−), the
first→last-hour literature form is absent, and 2021/2026 NQ contributions are ≈0. This is a
real but fragile drift; rank it last and only pursue it as a *tiebreaker/overlay* (e.g., trade
#2/#3 setups only in the first-hour direction), not as a standalone.
Follow-up: 1s test as an overlay on #3's break trades; kill it if the overlay doesn't improve
per-year stability.

## DEAD ENDS (showed nothing — do not re-run without new information)

1. **Round numbers** (100/250/500/1000-pt): indistinguishable from placebo grids in
   penetration, rejection, and close-clustering. Dead.
2. **Short-horizon return autocorrelation & all session-sign prediction**: 1m–30m AC ≈ 0 and
   MIXED; ON→RTH, RTH→next-ON, day→day all ≈ 0, MIXED. First-hour→last-hour momentum: dead.
   The 1m tape is directionally efficient at these horizons.
3. **Volume-spike direction** (climax vs continuation, incl. breakout/interior context):
   MIXED everywhere; only vol persistence (non-directional) survives.
4. **ON-extreme break follow-through**: P(close beyond) ≈ coin flip every year and every
   break-time bucket. A break alone tells nothing.
5. **Compression → expansion at the daily scale (NR7)**: inverted — quiet days follow quiet
   days (vol clustering wins). Gap **direction** plays (gap-and-go / gap-fade): MIXED.

## Honesty notes / limitations

- 1m resolution: touch/fill statistics (gap fill, extreme breaks) count a touch if the 1m
  bar's H/L crossed the level — order-queue reality needs the 1s pass.
- ATR normalization uses prior-14-day session ranges; effects were also eyeballed in raw
  points (tables in out-*.txt). No statistic conditions on same-period information.
- Day-type labels in §3 are ex-post and used descriptively only.
- ES fragmented-bar defect in the raw file is handled in the cache; anyone reusing
  `data/ohlcv/es/ES_ohlcv_1m.csv` directly must merge duplicate (ts,symbol) rows first.
