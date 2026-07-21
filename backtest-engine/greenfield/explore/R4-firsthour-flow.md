# R4 — First-Hour (09:30–10:45 ET) Dealer/Hedging-Flow Census (NQ)

Descriptive census only. **No WR / PF / EV / fills** — those wait for 1s simulation on
survivors. Data: `cache/NQ_1m_primary.csv` via `a1_common` (ET columns, rollover-safe),
day features from `B12-days.csv` (all knowable at 09:30). 1348 qualifying days,
2021–2026 (full RTH, single-symbol RTH, ATR>0). ES generalization on `cache/ES_1m_primary.csv`.

**Conventions.** `price_at(mod M)` = OPEN of the 1m bar stamped at minute-of-day M
(= close of the M−1 bar, closed at M:00 → knowable at M:00). Opening 15m candle =
1m bars mod 570..584 (09:30–09:44), close = P(0945). Effects reported in NQ points
**and** /prior-14d-ATR. Per-year sign stability (2021–2026) on every effect; `STABLE(±)`
= same sign every year with n≥20. `arr5` = side×(extreme − close_5m_ago)/ATR14 arrival
speed. **Every signal here fires exactly once per day, so pooled == day-weighted**
(honesty rule #8 has no bite; no day-clustering divergence exists in this census).

Scripts: `R4-00-build.py` (→ `R4-marks.csv`, `R4-minute-returns.csv`), `R4-01..07`.
Raw outputs: `out-R4-0*.txt`.

---

## Verdict on the two owner observations

### (a) "The first 15-min candle (09:30–09:45) often reverses" — **FALSE (weak CONTINUATION instead)**
`side×fwd` from the opening candle (side = its direction; + = continuation, − = fade):

| horizon | mean pts | /atr | t | per-year |
|---|---|---|---|---|
| →10:00 (15m) | +0.89 | +0.003 | +0.63 | MIXED(3/3) |
| →10:15 (30m) | +0.64 | +0.004 | +0.30 | MIXED(3/3) |
| →10:45 (60m) | **+5.43** | +0.017 | +2.15 | **STABLE(+) 6/6** |
| →10:30 | +2.10 | +0.007 | +0.93 | MIXED(5/1) |
| →12:00 | +4.31 | +0.013 | +1.26 | MIXED(5/1) |

The sign is **positive** (continuation), never systematically negative (fade). The only
per-year-stable horizon (→10:45) is continuation, consistent with the OR-continuation
prior. **A naive "fade the opening 15m" bet fights the data.**

The reversal the owner perceives is **conditional on arrival speed**: fast opening drives
(arr5 top quartile) fade to 10:30 (−4.4 pts, STABLE(−) 6/6 on NQ), slow drives continue
(+4.7 pts). **But this arr5 fast-drive fade does NOT replicate on ES** (−0.2 pts,
t=−0.19, MIXED) — so it is NQ-specific and fragile, and arrival-speed fades are the class
that historically die at 1s costs. Treat as a weak lead, not a strategy.

### (b) "Price frequently turns/rejects around 10:15–10:30" — **FALSE**
Morning-extreme timing over [09:30,12:00] (`R4-02`):

| bin | P(high) | P(low) | P(either) |
|---|---|---|---|
| 09:30–09:45 | 0.301 | 0.319 | **0.620** |
| 09:45–10:00 | 0.090 | 0.116 | 0.205 |
| 10:00–10:15 | 0.082 | 0.097 | 0.179 |
| **10:15–10:30** | 0.062 | 0.058 | **0.119** |
| 10:30–10:45 | 0.056 | 0.062 | 0.119 |
| 11:30–12:00 | 0.242 | 0.197 | 0.438 (window-edge artifact) |

10:15–10:30 is the **least** likely bin for a morning extreme. The RTH session extreme
forms in the first 30 min on 62.5% of days and first 60 min on 79.1% — the morning
"turn" people see is the **open** setting the extreme, not a fresh 10:15–10:30 reversal.

Causal fresh-extreme reversal test (extreme over closed window [09:30,10:30], fresh in
10:00–10:30, outcome strictly after 10:30): revert = −1.0/−1.7/−2.9 pts to
10:45/11:00/12:00, **t≈−1, MIXED(1+/5−)** — i.e. a fresh 10:00–10:30 extreme weakly
**continues**, it does not reverse. (An earlier full-morning-window version showed a
huge fake "reversal" — a mechanical selection artifact the placebos exposed; the causal
version is the honest one.)

---

## Per-hypothesis results

### H1 — Opening-15m (see verdict a). Conditioners on `side×fwd` to 10:30:
| condition | n | pts | per-year |
|---|---|---|---|
| gap aligned with opening candle | 654 | +4.75 | MIXED(5/1) |
| gap opposite | 668 | −0.79 | MIXED(3/3) |
| **fast opening drive (arr5 top q)** | 336 | **−4.36** | **STABLE(−) 6/6** (NQ only; ES refutes) |
| slow opening drive (arr5 bot q) | 336 | +4.68 | MIXED(5/1) |
| **compressed ON (bot tercile)** | 444 | **+4.54** | **STABLE(+) 6/6** |
| wide ON (top tercile) | 444 | −3.41 | MIXED(3/3) |
| opening trend-bar (body/range≥0.7) | 336 | +4.82 | STABLE(+) 6/6 |
P(opening candle sets the eventual RTH extreme in its drive direction) = 0.110.

### H2 — 10:00–10:30 turn (see verdict b). Extremes front-load to the open; no fresh-turn edge.

### H3 — Time-locked minute drift (`R4-03`). 149 minutes 09:30–11:59; 14 with |t|>2
(chance ~7), **5 with |t|>2 AND per-year sign-stable**. Midday control 12:00–14:00
(120 min): 16 |t|>2, **5 stable** — i.e. the *density* of significant-stable minutes is
the same as a control band, so most are multiple-testing noise. Standouts by magnitude:

| minute | drift pts | /atr | t | per-year | ES replication |
|---|---|---|---|---|---|
| **09:49** | −1.16 | −0.004 | **−4.00** | STABLE(−) 6/6 | **−0.245, t−3.49, STABLE(−) 5/5** |
| **10:50** | −1.69 | −0.005 | **−5.64** | STABLE(−) 6/6 | **−0.301, t−4.46, STABLE(−) 5/5** |
| 11:00 | +1.20 | +0.004 | +3.69 | STABLE(+) 6/6 | +0.151, t+2.26, MIXED(4/1) |
| 11:06 | +0.79 | +0.002 | +2.97 | STABLE(+) 6/6 | +0.185, t+3.23, MIXED(4/1) |
| 09:38 | +0.90 | +0.003 | +2.23 | STABLE(+) 6/6 | — |

The **09:49 and 10:50 fades independently replicate on ES** (both STABLE 5/5) — that
cross-market confirmation lifts them above the multiple-testing floor: they are real
clock-locked one-minute down-drifts. But magnitude is ~1 pt (NQ) / 0.25 pt (ES) over a
single minute — below realistic 1s cost as a standalone entry. Highest-vol (event) minute
is 10:00 (0.065/atr) but its *drift* is insignificant (−0.80, t−1.75): 10:00 is a
volatility event, not a directional one.

### H4 — 10:00 macro reaction (`R4-04`). 10:00 5m realized range = 0.129/atr vs 0.089 at
11:00 (the known event vol, confirmed). Signed drift:
- Vol-gated (top-tercile 10:00 range) impulse **continuation** 10:00→10:15: **+7.1 pts,
  t+2.14, STABLE(+) 6/6** — but the gate uses the 10:00–10:05 range (knowable only at 10:05).
- **Causal** versions: gate on impulse magnitude known *at 10:00* → +6.3 pts, t+2.18,
  **MIXED(5/1)** (one year flips). Wait to 10:05 to confirm vol, enter 10:05 → **+2.0 pts,
  t+0.75** (edge is spent in the 10:00–10:05 window).
- Fading the 10:00 spike LOSES (−7.1 pts, mirror). 
Net: a real but timing-fragile impulse-continuation; honest capture is marginal.

### H5 — OR-break continuation (`R4-05`). The 09:30–09:45 range is broken on **99.9%** of
days, median break 09:48 — so "OR break" is not a selective event and carries **no edge**
alone (cont to 10:30 = −0.17, MIXED). What matters is the *state*, not the break:
- break aligned with gap → +3.6 to 11:00 (STABLE 6/6, t0.98); against gap → −3.9 to 10:30.
- **break + compressed ON → +11.9 pts to 12:00, t+2.47, STABLE(+) 6/6** (same compressed-ON
  flow as H1, at longer horizon).

### H6 — Overnight-unwind (`R4-06`). **DEAD.** corr(gap, first-hour move) = −0.045.
All continue/fade splits by gap size and ON range are MIXED across years. Wide-ON →
gap-fade to 09:45 (−8.7 pts) reaches t−2.56 but MIXED(1/5) (one-year artifact). The
first-hour direction is essentially independent of the overnight move.

---

## RANKED first-hour flow candidates

1. **Compressed-overnight morning continuation** (H1 + H5 convergent). When the overnight
   range is in its trailing bottom tercile (knowable at 09:30 from `on_range_atr`), the
   first-hour direction — whether read from the opening candle or the first OR-break —
   **continues** through late morning/noon. Effect: +4.5 pts to 10:30 (H1), +11.9 pts to
   12:00 (H5 break+compressed), **STABLE(+) 6/6**, n≈440. *Mechanism:* coiled overnight
   positioning releases as a directional RTH trend (trend extension, not a re-hedge pulse).
   *Live-computable:* yes, purely from OHLCV at 09:30. *1s follow-up:* trend-follow the
   opening drive on compressed-ON days with a proper stop/target; slow drift so exit design
   is the whole game. **Caveat:** long horizon, pooled t only ~2.1–2.5; verify it is not
   merely the generic ON-compression day-type before committing.

2. **10:00 macro-impulse continuation** (H4). On a large 09:45→10:00 impulse, ride it into
   10:15. +6.3 pts, t+2.18, but **MIXED(5/1)** causally, and most of the edge is in the
   first 5 minutes. *Mechanism:* 10:00 release repricing continues as slower hedgers follow.
   *Live-computable:* yes at 10:00. *1s follow-up:* measure how much survives an honest
   10:00–10:01 entry; likely thin. Rank below #1 for stability.

3. **Clock-locked 09:49 & 10:50 fades** (H3). Real, per-year-stable, **cross-market
   confirmed on ES**. ~1 pt (NQ) single-minute down-drift. *Mechanism:* plausibly a
   recurring benchmark/rebalance or opening-rotation-completion re-hedge at a fixed clock
   minute. *Live-computable:* trivially (a clock). *1s follow-up:* almost certainly not
   standalone-tradable after costs; test only as a micro-overlay/timing filter on a larger
   entry, or as a signed short over a 2–3 min window.

## DEAD list

- **Owner obs (a) opening-15m reversal** — false; opening candle weakly *continues*.
- **Owner obs (b) 10:15–10:30 turn** — false; morning extremes front-load to 09:30–09:45,
  10:15–10:30 is the least-likely extreme bin, and a causal fresh 10:00–10:30 extreme
  continues rather than reverses.
- **Overnight-unwind (H6)** — corr −0.045; no stable continue/fade relationship.
- **Plain OR-break** — 99.9% of days break; no edge without the ON-compression/gap state.
- **arr5 fast-open fade** — NQ-only STABLE(−) but **refuted on ES**; arrival-speed fades
  are the class that dies at 1s costs. Not pursued.
- **10:00 as a directional event** — 10:00 is a *volatility* spike; its drift is
  insignificant. Fading the 10:00 move loses.

## Caveats
- Release-day proxy (H4) is recurrent-10:00-vol, not a calendar; it catches
  ISM/UMich/JOLTS-class prints but also non-scheduled vol — a vol-conditioned census,
  not an event study.
- All candidates are 1m descriptive. None has a WR/PF number and none should be trusted
  as tradable until an independent 1s simulation (fills, stops, targets, MFE/MAE from the
  fill instant, honest slippage) reproduces the effect. Candidate #1 is the only one
  clearing the descriptive bar comfortably; #2 and #3 are borderline and likely thin.
