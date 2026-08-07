# M3 — Intraday forced/scheduled-flow edges in GOLD & CRUDE (medium TF)

Descriptive census + ranked candidates. Data: `backtest-engine/data/macro/`
(`cl_15m` 2024-10→2026-07, `cl_1h` 2019→, `gc_15m` 2024-10→, `gc_1h` 2022→).
ts = epoch **seconds UTC**, converted to ET via `America/New_York` (DST-correct).
Knowability: signal from bars CLOSED by decision time; enter the NEXT bar's open;
exits walk contiguous bars forward. Costs = 2 ticks round-trip slippage
(+ small commission). Point values: CL $1000/pt (MCL $100), GC $100/pt (MGC $10).

Scripts (rerunnable, repo root): `greenfield/explore/M3-*.py` (+ `m3lib.py`).

---

## Headline verdicts

| Hypothesis | Verdict |
|---|---|
| ⭐ **#1 Crude EIA (Wed 10:30 ET) reaction** | **DEAD** — reaction vol is real, no tradeable direction |
| **#3 Gold evening (Asian-session) LONG drift** | ✅ **SURVIVOR** — the one real, per-year-stable, cost-clearing edge |
| #3 Crude clock-locked drift | DEAD — best slot below micro cost |
| #2 Crude API (Tue 16:30 ET) | DEAD — thin/after-hours, CME break truncates |
| #3b Gold 13:30 ET settlement long | WEAK echo of the evening bias; not distinct |
| #5 Gold FOMC/CPI event reactions | NOT TESTABLE here (no event-date file; time-vol proxy insufficient for a directional claim) |

---

## #1 CRUDE EIA INVENTORY REACTION — DEAD (the headline null)

Proxy: EIA petroleum report drops Wed 10:30 ET. Signal = the 10:30 ET bar move
(close−open, fully captures the 10:30 print, knowable at 10:45). Proxy limit: on
holiday weeks EIA shifts to Thu — a minority of weeks are mislabeled, which only
*dilutes* an edge; it cannot manufacture the null below.

**(a) Reaction magnitude is real.** Wed-10:30 |move| mean 0.242pt vs non-Wed 0.208pt
(t of the difference is modest but the vol signature is there).

**(b) Continuation vs fade — no tradeable direction.** Enter 10:45, hold 30/60/90min:

| Horizon | CONTINUATION net | FADE net | Wed WR | per-year cont ($/CL) |
|---|---|---|---|---|
| 30min | −$45/CL | +$5 | 48% | 2024 −103 / 2025 −62 / 2026 −0 |
| 60min | −$38/CL | −$2 | 42% | 2024 −93 / 2025 −52 / 2026 +3 |
| 90min | −$57/CL | +$17 | 47% | 2024 −107 / 2025 −97 / 2026 +30 |

Both directions lose or scratch after cost; per-year signs are unstable. Wednesday's
60min continuation ($−38) is not distinguishable from the non-Wed control ($−14) or
from Thu/Fri. **Magnitude-conditioned** (trade only top-tercile |r0|): n=31, t≈0,
2024 CONT −$625 vs FADE +$585 (small-n noise, opposite sign next years). **Pre-report
drift** (09:30→10:30): Wed +$23 vs ctrl −$29, t≈0.3 — nothing.

**Verdict:** the EIA reaction produces volatility, not a knowable-at-close directional
edge at 15m resolution. Do not deploy an EIA-reaction trade.

---

## #3 CLOCK-LOCKED TIME-OF-DAY DRIFT — census

Method: for each ET 15m/1h slot, enter at bar open, hold N bars, signed forward
return. **Critical confound:** gold rose ~50% and crude trended over the window, so
any long slot looks good. Fixed by subtracting **each year's ambient drift** (all-slot
mean per hold) → isolates the time-of-day anomaly. Survivors must keep a consistent
demeaned sign **every year** and beat cost.

### GOLD — evening (Asian-session) LONG drift ✅ SURVIVOR

Demeaned 15m census, hold 2h: the entire **18:00–20:30 ET** block is LONG, consistent
across 2024/2025/2026, t ≈ 2.4–2.8 (a broad plateau, not a knife-edge slot). Confirmed
out-of-sample on 1h back to 2022: 19:00 ET +2h demean +$92 net, t+2.6, positive **all
5 years** [2022 +15 / 2023 +27 / 2024 +26 / 2025 +100 / 2026 +522] — **sign never
inverts.**

**Concrete trade — LONG GC at 18:00 ET, exit 21:00 ET (hold 3h), net cost:**

| metric | value (GC) | value (MGC) |
|---|---|---|
| n | 353 | |
| mean / trade | **+$397** | **+$40** |
| median | +$190 | +$19 |
| win rate | **58.6%** | |
| t-stat | **+3.40** | |
| p10 / p90 | −$1,456 / +$2,336 | −$146 / +$234 |
| worst / best trade | −$7,850 / +$17,150 | −$785 / +$1,715 |
| mean MAE (in-trade) | −$1,209 | −$121 |
| p10 MAE | −$2,862 | −$286 |
| equity maxDD | −$14,590 | −$1,459 |

Per-year: **2024 +$148/tr (wr61%), 2025 +$188/tr (wr60%), 2026 +$847/tr (wr55%)** —
profitable every year; magnitude scales with gold's vol/trend regime (thin in the
quiet 2022–23 1h years: ~+$20/trade demeaned, still positive).

**Placebo (random ET entry-hour, 200 shuffles):** actual mean +$397 vs random-hour
distribution median $0, p99 +$269 → **0/200 placebos beat actual.** The window is
specifically special.

**Control (same 3h LONG at 10:00 ET US day):** mean −$74/GC, t−0.63, equity −$32.8k,
maxDD −$79.6k. The US day has **no** such drift — the long bias lives in the Asian
session, confirming a clock-locked rotation rather than an all-day trend artifact.

**Mechanism:** gold is accumulated through the Asia/China session (physical demand,
SGE/PBOC-linked flow, overnight risk premium); the US RTH gives it back on average.
This is a structural session bias, not a scheduled-event reaction.

### GOLD 13:30 ET COMEX settlement — WEAK
Enter 13:30, +30min LONG: mean +$72/GC, t+1.63, per-year [+26,+24,+172] (2026-driven);
+1h version has 2024 negative. A weaker echo of the same long bias, t<2, not distinct
from the evening finding. Not separately deployable.

### CRUDE clock drift — DEAD
1h census 2019–2026: the ONLY all-8-year-consistent slot is **15:00 ET LONG** (post
14:30 pit settlement), hold 2h: demean +$28, **net +$8/CL over 2h** — that's
**+$0.8/MCL**, below micro cost, and boosted by 2020 (COVID, +$92). 15m best crude
slots (09:30/09:45 ET RTH-open short fade, net +$16–26/CL) are t≈2 but tiny and
2026-concentrated. No robust, cost-clearing crude flow window exists at this resolution.

---

## #2 CRUDE API (Tue ~16:30 ET) — DEAD
16:30 ET +30min: mean −$30/CL, t−1.66, 2026 −$85. The 1h hold is untestable — the
17:00–18:00 ET CME maintenance break truncates it. After-hours, thin, negative. Dead.

## #5 GOLD FOMC / CPI reactions — NOT TESTED
No event-date file available; proxying 2:00 ET FOMC / 8:30 ET CPI by "recurrent
time-locked vol" cannot support a *directional* claim (it conflates 8 FOMC/yr with
every other 2:00 ET bar). Flagged as open, not claimed. Would need an event-date
calendar to test honestly.

---

## RANKED SHORTLIST

**1. GOLD EVENING (Asian-session) LONG — the only survivor.**
- Direction: LONG. Enter 18:00 ET, exit 21:00 ET (3h). Broad plateau 18:00–20:30 ET.
- $-dist: +$397/GC (+$40/MGC) mean, +$190 median, wr 58.6%, t+3.40; p10/p90 −$146/+$234 (MGC).
- Per-year stability: positive every year 2022–2026 (1h) and 2024–2026 (15m); sign never
  inverts. Magnitude regime-dependent (big in high-vol gold years, marginal in flat years).
- Placebo: 0/200 random-hour shuffles beat it. US-day control flat/negative.
- events/yr ≈ 200 (one per weekday).
- **Micro sizing (MGC $10/pt):** +$40/trade expectancy; budget ~−$120 typical / −$785 worst
  adverse per contract and ~−$1,459 equity drawdown per MGC. Size on drawdown tolerance.
- **⭐ Uncorrelated diversifier:** it is gold, driven by the Asian session — structurally
  uncorrelated with an equity-long book by construction.
- **Real? yes. Stable? sign-stable across 5 years; magnitude regime-dependent. Big enough?
  yes on MGC (+$40 clears the ~$3.5 micro round-trip cost ~11×), but it is a
  wide-distribution carry trade, not a high-Sharpe scalp — treat as a sized overlay, not a
  tight-stop setup (a stop inside the ~$120 mean MAE would knife most winners).**

## DEAD LIST
- Crude EIA (Wed 10:30) reaction — continuation, fade, and magnitude-conditioned all null; per-year signs flip.
- Crude API (Tue 16:30) — thin, negative, CME-break-truncated.
- Crude clock-locked drift — best window (15:00 ET post-settlement long) net +$8/CL / +$0.8/MCL, below micro cost.
- Gold 13:30 settlement long — weak (t<2), 2026-driven echo of the evening bias.
- Gold/crude scheduled-event (EIA/FOMC/CPI) directional reactions — not knowable-directional at 15m / not testable without event dates.
