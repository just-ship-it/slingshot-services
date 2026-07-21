# R3 — Census of Volume / Speed Signatures in 1-Second NQ (RTH, 2021-01 → 2026-06)

**Mandate.** Stop hunting price levels; hunt the dealer-flow *signature* — speed,
volume, rate-of-change, and blocks of volume/trades that leave a mechanical
fingerprint in the 1s tape that 1m bars destroy. This is a **descriptive census +
ranked candidates**: no win rates, no profit factors, no fill simulation (that
comes later, only for survivors). Every statistic below is knowable strictly
before its outcome window.

**Charter/knowability compliance.** No banned path was read; no prior conclusion
was used as a prior. All baselines are causal (trailing-20 *eligible-day* median
for the same minute-of-day bucket, strictly prior days, ≥15 priors required).
Day-level vol regime = trailing-250d ATR14 tercile of `atr14_prior` (itself
prior-day). Forward outcomes are close-to-close moves from a knowable instant
(minute/second close). Per-year splits on every effect; day-clustered t-stats
(average within a day first, then across days) so intraday autocorrelation does
not inflate significance.

**Data.** `cache_nq_rth_1s.csv` (31.2M rows, 1,395 days, 09:28–16:00 ET, per-day
primary contract). Densified to `R3-dense.npz` (D×23,580 sec matrices; missing
seconds = no trades → volume 0, close forward-filled from past only). Analyses
use 1,330 days that are full-RTH, ≥20k traded seconds, and have ≥15 prior
eligible days for a baseline.

### LIMITATION — stated plainly
1s OHLCV has **no aggressor side and no order book**. Every "signed pressure"
number here is a **tick-rule proxy**: `sign(close_t − close_{t−1}) × volume_t`
(with a trailing-10s flow fallback when a bar's close is unchanged). Directional
claims are proxy-directional. **Deployability:** every feature used is computable
from a live 1s bar stream plus ~20 days of history (per-second/minute volume vs
trailing-median baseline, tick-rule sign, coefficient-of-variation, Fano factor).
No depth/tape feed is required and none is assumed — consistent with the
"live source = YES" constraint.

---

## 0. Baselines (the normalization everything rests on)

Per-second volume has a strong, stable U-shape (medians across used days):

| ET | 09:30 | 09:45 | 10:30 | 12:00 | 14:00 | 15:00 | 15:30 | 15:59 |
|---|---|---|---|---|---|---|---|---|
| contracts/sec (p50 baseline) | 85.6 | 43.9 | 30.6 | 18.4 | 16.6 | 17.3 | 17.2 | 128.6 |

Open and the 15:59 print are ~5–8× the midday floor — hence **all** volume/speed
features are expressed as multiples of the causal same-second (or same-minute)
baseline, never raw. Marginal minute-volume multiple `Vmin/volb`: p50=1.00,
p90=1.93, p99=3.85 (well-behaved, baseline is doing its job). Single-second
monsters (`v` ÷ per-sec baseline): ≥25× occurs 11/day, ≥50× 1.5/day, ≥100× 0.1/day.
Zero-volume seconds: p50=577/day (of 23,460) — the tape is genuinely sparse
midday, which matters for any 1s execution assumption.

Baseline builder: `R3-01-baselines.py` → `R3-baselines.npz` +
`R3-minute-features.csv.gz` (slim per-minute feature rows for cheap re-analysis).

---

## 1. Burst taxonomy — `R3-02-bursts.py`

**Mechanism.** Forced/mechanical participants (stop cascades, hedge slices, large
sweeps) concentrate volume into single seconds or short blocks; if that carries
information, forward drift should align with the burst's direction beyond a
normal tick at that time of day.

**Monster seconds (single 1s ≥ 25/50/100× baseline).** Aligned forward drift is a
**null with a mean-reversion tilt**. 25× monsters: pooled +15m = −0.51 pts but
**sign-unstable per year** (2022 +0.49, 2024 −1.48, 2025 −2.53). The "drive"
subset (1s displacement ≥ 4× path baseline, n=8,730) mean-reverts modestly
(−0.55 pts/+15m, t−2.9). Burst *anatomy* (front- vs back-loaded, one- vs
two-sided seconds) does **not** cleanly separate outcomes — every split lands in
the −0.7…−1.8 pt band. **The 1m "spike-direction is dead" result stays dead at
1s for single seconds.**

**Burst blocks (≥3 consecutive sec each ≥5× baseline, v≥50; 24,378 blocks).**
Here the signature is real and stable but it is a **FADE**: aligned drift *from
block end* is negative every year — pooled −1.37 pts/+5m (day-t −6.6), −2.02/+15m
(day-t −6.3). Time-matched normal-second control is ≈0 (−0.24/+5m). This is the
first appearance of the census's one recurring directional theme.

Events cached: `R3-burst-events.csv`.

## 2. Algorithmic-slicing detector (centerpiece) — `R3-03-slicing.py`

**Mechanism.** TWAP/VWAP slicers emit abnormally *steady* per-second volume;
organic flow is bursty. Steadiness measured scale-free as the coefficient of
variation of 1s volumes over a trailing 180s, relative to its causal
time-of-day baseline (`rcv = CV/CVb`). *(A raw-Fano version was tried first and
rejected: Fano scales with volume level, so "low-Fano AND elevated" was near-empty
— 28 blocks in 5.5y. CV is the correct scale-free steadiness metric.)*

**Do steady "program blocks" exist beyond chance?** Emphatically yes. Steady +
elevated minutes (`rcv≤0.70 & vm3≥1.2`) form ≥3-minute runs **229× more often**
than an independence null (1,410 blocks, 478 days; steady+quiet 725×). Steadiness
is a real, clustered property of the tape — not noise.

**Do they predict?** **No.** Forward drift from block detection is a null:
pooled +15m = −0.19 pts, sign-unstable per year. The blocks occur *during* moves
(concurrent full-block drift +16 pts, t+21) but carry **no forward directional
edge** once detected. The centerpiece hypothesis — "a running program lets you
ride its direction" — is refuted for the tradable (post-detection) window.

**Time-of-day:** program-block starts rise steadily through the session and peak
14:00–15:00 (0.125/day) — consistent with EOD-flow timing — but see §6: their
*direction* does not match the known re-hedge, so the clustering is timing without
a tradable directional signal.

**What the slicing family *does* confirm:** the plain **volume-run** (`vm3≥1.5`
for ≥3 min, any texture; 12,340 blocks) fades, aligned +15m = −1.52 pts
(day-t −3.6), negative every year — same fade theme as burst blocks. Texture
(steadier vs burstier) does not change the sign. Blocks cached:
`R3-program-blocks.csv`.

## 3. Crescendo / decrescendo + vacuum — `R3-04-crescendo-vacuum.py`

**Mechanism.** A run fed by *rising* volume = participation building
(continuation?); a run on *fading* volume = exhaustion (snap-back?). A fast move
on *low* volume (vacuum) is liquidity withdrawal, not initiative.

Directional runs (|net3| ≥ 2× baseline, 5m cooldown; 49,860 events, 37.5/day):

- **Crescendo does NOT continue — it fades harder.** vslope quintiles are
  monotone: steepest-rising-volume quintile Q5 +15m = −1.01 pts (t−2.6) vs Q1
  (falling volume) −0.23. Rising volume into a move → *more* reversion.
- **Vacuum vs heavy is the clean cut.** Heavy runs (vm3≥1.5): −2.09 pts/+15m
  (day-t −5.5), **negative all 6 years**. Vacuum runs (vm3≤0.7): +0.34, noisy/flat.
  Volume-confirmed thrust reverts; thin thrust does neither.

## 4. Dry-ups / vacuum vol — `R3-04`

Sustained low volume (`vm3≤0.4` ≥3 min, 10:00–15:30; 538 events) predicts
**continued low realized volatility**: forward |move| is 0.72× (15m) / 0.81×
(60m) of a time-matched normal-volume control. **Directionally null** (aligned
with trailing move: −0.86/+15m, sign-unstable). Dry-ups are a *volatility* filter,
not a trade — consistent with the 1m calibration that only non-directional vol
persistence survives.

## 5. Speed × volume grid — `R3-05-grid.py`

Location-free 2-D map of non-overlapping 5-min windows (velocity multiple ×
volume multiple; 101,580 windows).

- **Forward realized vol is monotone in current volume, flat in velocity**
  (|+15m| rises 17→31 pts across volume columns; day-t +20…+55). Strong, stable,
  non-directional — the cleanest signal in the whole census, but it is a
  vol-forecast, not a direction.
- **Directional drift:** the populated **fast+heavy corner (vel≥4× & vol≥2×,
  n=1,984) fades hardest: −4.19 pts/+15m (day-t −4.4), negative 5/6 years**
  (2022 flat). This is the grid's expression of the same fade theme and its
  single most negative well-populated cell.
- **Flag (single-cell wonder):** fast-on-*low*-volume (vel 2–4 & vol<0.6,
  n=104) shows +5.44/+15m (t+2.2) positive 6/6 — but n is tiny and the adjacent
  vel≥4 & vol<0.6 cell has n=2. Do **not** treat as a candidate; it is the best
  of many cuts on thin data.

---

## 6. EOD positive control + onset timing — `R3-06-eod-control.py`

The known mechanical flow (independent calibration): **15:00→15:30 ET continues
the day's move, +5–9 pts.** A real dealer-flow detector should light up here.

**Clock control reproduces on our cache** ✅ — aligned 15:00→15:30 continuation
= **+3.76 pts pooled (day-t +3.2), +4.08 on trend days**, positive **5/6 years**
(only 2024 negative, −1.23). Good ground truth.

**Detector direction-alignment with the re-hedge:** ❌ **null.** For 14:00–15:45
blocks, the block's flow direction matches the day's move-so-far only:
program **47.1%**, bursty 54.5%, volrun 51.5% (≈coin-flip, stable across years).
**The steady-program-block detector does NOT identify the direction of the known
EOD flow** — this caps the slicing family's directional promise and is the
single most important negative result for the centerpiece.

**Onset timing — the one place a volume signature *adds* to the clock** ✅:
condition the 15:00→15:30 continuation on whether an **aligned** volume-run
(vm3≥1.5, pointing the same way as the day) fired in **14:30–15:00**:

| | days | 15:00→15:30 aligned continuation |
|---|---|---|
| aligned late run fired | 423 | **+6.64 pts** (day-t +2.8) |
| quiet | 907 | +2.42 pts (day-t +1.9) |

Positive **every year** for the "fired" set (2024 weakest, +1.70). Anchoring off
the run's own detection minute (14:3x) to 15:30 gives +8.37 pts (t+2.9). So the
volume signature does not *replace* the clock, but **late-day aligned
volume-confirmation ~2.7× the continuation** — a genuine conditioner on the known
trade, and it is causal (all inputs knowable at 15:00).

---

## Ranked shortlist (effect size · n · stability · live-computable)

1. **Elevated-volume directional thrust FADES** (consolidated in
   `R3-07-fade-consolidate.py` → `R3-thrust-events.csv`). This is the census's
   one recurring, control-validated *directional* signature — it appears
   independently in burst blocks (§1), volume-runs (§2), heavy directional runs
   (§3), and the fast+heavy grid cell (§5), always with the same sign.
   Consolidated headline (thrust = |net3|≥2× baseline, condition on trailing-3m
   volume multiple vm3), aligned forward drift (negative = fade):

   | vm3 bucket | n | +5m pts | +15m pts | +15m/ATR | day-t(15m) |
   |---|---|---|---|---|---|
   | vacuum ≤0.7 | 1,954 | +0.01 | +0.35 | +0.002 | +0.4 |
   | 0.7–1.0 | 11,034 | −0.09 | +0.33 | +0.002 | +0.8 |
   | 1.0–1.5 | 21,663 | −0.17 | +0.33 | +0.001 | +1.2 |
   | 1.5–2.5 | 12,028 | −0.53 | **−1.79** | −0.005 | **−4.4** |
   | heavy ≥2.5 | 2,689 | −1.95 | **−2.58** | −0.009 | −2.9 |

   **Monotone in volume**; the same-events **random-sign matched control is ≈0
   everywhere** (largest |mean|=1.0 pt, t+1.0), so the fade is about thrust
   *direction* conditioned on volume, not a time-of-day drift. Heavy-thrust
   +15m fade is **negative all 6 years** (−0.93 to −6.84 pts) and **stronger in
   high-ATR regimes** (−3.42 vs −1.10 pts). Mechanism: volume-confirmed thrust
   exhausts; the crowd chasing the volume gets faded (short-horizon,
   volume-conditioned reversal). *Proposed follow-up:* 1s-honest fade sim —
   enter counter-thrust after a vm3≥1.5 directional minute, ~15-min horizon,
   size/target scaled to ATR; test whether the 1.8–2.6 pt edge clears
   costs+slippage. **Caveat for that stage:** mean effect is small vs NQ
   round-trip cost — the survivor test is whether the high-ATR / heavy-vm3 tail
   (−3.4 to −6.8 pts) carries it, not the pooled number.

2. **Late-day aligned volume-confirmation of the EOD continuation** (§6). +6.64
   vs +2.42 pts, positive every year, causal. *Follow-up:* 1s sim of the 15:00
   clock trade gated on a 14:30–15:00 aligned vm3≥1.5 run; compare to the
   ungated clock trade.

3. **Volume multiple → forward realized-vol forecast** (§5, §0). Monotone,
   day-t up to +55, stable every year. Not a standalone trade — deployable as a
   **vol-regime / position-sizing input** or an entry filter for (1). Highest
   statistical reliability in the census.

4. **Dry-up → continued low vol** (§4). 0.72× forward |move|. A quiet-market
   filter (e.g., stand-aside or tighten targets), not a directional edge.

## Dead list (do not re-mine)

- **Single-second "monster" DIRECTION** — sign-unstable per year; burst anatomy
  (front/back-load, one/two-sided) does not separate outcomes. Matches the 1m
  spike-direction null.
- **Slicing/program-block DIRECTION (centerpiece)** — blocks exist 229× beyond
  chance but carry **no forward directional edge** post-detection, and their
  direction does **not** align with the known EOD re-hedge (47%). Steadiness is
  real; it is not tradable as direction.
- **Vacuum (thin-volume) moves** — no reliable continuation *or* reversion
  (noisy both ways).
- **Fast-on-low-volume grid cell** (+5.44/+15m) — single-cell wonder, n=104,
  flagged as best-of-many-cuts. Not a candidate.
- **Crescendo-as-continuation** — the opposite is true (rising volume fades
  harder); folded into candidate 1.

## Live-feed requirements note

All candidates need only: the live 1s NQ bar stream (OHLCV) + ~20 trading days of
history to maintain per-second/minute volume baselines, plus daily ATR14. No
depth, no tape, no options/GEX feed. Baselines are trailing medians (O(1) update
per bar). Everything here is deployable within the charter's "live source = YES"
constraint — the open question left for the sim stage is purely whether the
edges clear costs, not whether they can be computed live.

## Reproduce

```
python3 R3-00-dense-cache.py        # 31M-row CSV -> R3-dense.npz (~33s)
python3 R3-01-baselines.py          # causal ToD baselines -> R3-baselines.npz + slim CSV
python3 R3-02-bursts.py             # family 1  -> R3-burst-events.csv
python3 R3-03-slicing.py            # family 2  -> R3-program-blocks.csv
python3 R3-04-crescendo-vacuum.py   # families 3+4
python3 R3-05-grid.py               # family 5
python3 R3-06-eod-control.py        # family 6 (EOD positive control)
python3 R3-07-fade-consolidate.py   # headline consolidation -> R3-thrust-events.csv
```
Outputs mirrored in `out-R3-0*.txt`. Shared helpers: `R3_common.py`.
