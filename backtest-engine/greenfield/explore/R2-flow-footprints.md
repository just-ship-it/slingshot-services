# R2 — Dealer/Hedging-Flow Footprints in the Tape (census + ranking)

Date: 2026-07-17. Charter: `GREENFIELD.md`; contract: `KNOWABILITY.md`.
Scope: descriptive census only — NO win rates, NO profit factors, NO fill
simulation. Effects reported in NQ points AND ATR units (prior-14d ATR),
per-year splits everywhere. Survivors get a 1s follow-up spec.

## Data & conventions

- NQ/ES primary-contract 1m: `greenfield/explore/cache/{NQ,ES}_1m_primary.csv`
  (ET annotations, roll flags). Same-symbol guard on every return; bars
  consumed at close; day universe = `cache/NQ_daily_sessions.csv` (1,319 clean
  full-RTH days 2021-01→2026-06; holidays/half-days/roll days excluded).
- QQQ 1m cash: `data/ohlcv/qqq/` (pinning measured in QQQ space — no
  ETF→futures strike mapping needed).
- QQQ OPRA statistics → daily OI census: file dated D holds D-1-close OI,
  received ~05:30–06:30 ET on D ⇒ knowable all day D. `stat_type==9` rows,
  publisher-deduped. Caches: `R2-oi-daily.csv`, `R2-oi-strikes.csv`
  (near-money strike distributions, OI≥500), 807 days 2023-03→2026-06.
- Expiry calendar `R2-calendar.csv`: union of expirations from
  `data/definition/qqq/` plus expiries observed in statistics symbols (the
  definition files end early 2026). Classes: daily / weekly_fri / monthly
  (3rd-Fri window incl. holiday-shifted Thu) / quarterly (Mar/Jun/Sep/Dec =
  triple witching) / none. Month/quarter-end offsets (me_t/qe_t) included.
- Vol regime proxy = `atr14_prior` (and `atr_rel` = ATR/prior close). NOTE:
  there is no VIX *index* series in the clean inventory (`data/ohlcv/vix/` is
  VIX **options** OHLCV), so "VIX regime" is proxied by realized ATR —
  knowable, live-sourceable.
- Mean ATR14 by year (NQ pts): 2021: 238, 2022: 372, 2023: 244, 2024: 299,
  2025: 413, 2026: 475.

Scripts (rerunnable, in order): `R2-00-expiry-calendar.py`,
`R2-01-oi-cache.py`, `R2-02-eod-rehedge.py`, `R2-03-expiry-flows.py`,
`R2-04-monthend.py`, `R2-05-minutes.py`, `R2-06-midday-vol.py`,
`R2-07-crossmarket.py`, `R2-08-candidate-checks.py` (+ inline specificity
check logged in `R2-09.log`). Full tables in `R2-0*.log`.

---

## H1. EOD re-hedge (day-move → late-day flow)

Mechanism: short-gamma dealers must buy after up-moves / sell after
down-moves, concentrated late in the day; long-gamma books damp instead.

**Full last hour (15:00→16:00): DEAD as a fixed effect.** Beta of last-hour
return on day-move-to-15:00 (ATR units) inverts across years:
2021 −0.010, 2022 +0.069, 2023 +0.058, 2024 −0.023, 2025 +0.061, 2026 −0.042.

**15:00→15:30 sub-window: SURVIVOR.** Same construction, positive every year:

| year | beta (t) | P(cont same sign)* | aligned pts mean/med* |
|---|---|---|---|
| 2021 | +0.042 (+2.5) | 0.562 | +5.6 / +4.0 |
| 2022 | +0.039 (+2.5) | 0.623 | +7.6 / +9.8 |
| 2023 | +0.064 (+4.2) | 0.649 | +6.8 / +8.0 |
| 2024 | +0.013 (+0.9) | 0.490 | +0.2 / −0.3 |
| 2025 | +0.048 (+3.6) | 0.527 | +4.1 / +1.3 |
| 2026 | +0.009 (+0.4) | 0.604 | +8.3 / +12.5 |
| ALL | +0.037 (+5.8), n=1319 | 0.574 | +5.2 / +4.5 (t=+4.0, n=1118) |

\* conditioned on |day move| > 0.10 ATR; "aligned pts" = 15:00→15:30 NQ points
signed by the direction of the day move.

- **Window-specific** (R2-09 log): the same beta computed for 12:00–12:30,
  13:00–13:30, 14:00–14:30, 14:30–15:00, 15:30–16:00 is ~zero or
  sign-unstable in every case. Only 15:00–15:30 carries it. This is a
  clock-locked flow, not generic intraday momentum.
- **Monotone in move size** (pooled): |move| 0.1–0.3 ATR → +0.9 pts;
  0.3–0.6 → +6.5; 0.6–1 → +7.6; >1 ATR → +14.1 (n=74).
- **ES confirms**: aligned mean +0.96 ES pts (t=+3.1, n=1037), positive mean
  5/6 years (2024 ~flat, matching NQ's weak year).
- 15:30→16:00 shows NO continuation (and 2021/2026 mildly reverse) —
  consistent with re-hedge flow completing before the 15:50 MOC imbalance
  publication, after which the imbalance is public and gets traded against.
- Caveat: 2024 is flat (not inverted). Effect is time-varying in magnitude
  but has not flipped sign in any year, in either market.

**State-conditional amplification (secondary):** last-hour beta by ATR-regime
tercile × era — high-vol tercile positive in all three eras (+0.049/+0.050/
+0.145), low-vol tercile ~zero/negative. Short-gamma-like amplification is a
high-vol-regime phenomenon; readable live via ATR. (Weaker evidence than the
window effect; treat as a conditioner for #1, not a standalone.)

**Volume:** last-hour volume share rises with |day move| (14.8% → 16.0% from
smallest to largest quintile) — direction consistent with re-hedge volume
proportional to the move; modest size.

**Overnight-gap re-hedge (open window): DEAD.** First-30m drift conditional
on gap size inverts across years in every gap bucket (see R2-02 §F).

## H2. Expiration-cycle flows

**Monthly-expiry morning weakness: SURVIVOR.** 09:30→10:30 drift by Friday
class (ATR units, control = other Fridays — same weekday by construction):

| class | ALL (t, n) | per-year |
|---|---|---|
| NQ monthly | **−0.152 (−3.3, 44)** | −0.14 / −0.20 / −0.09 / −0.19 / −0.20 / −0.02 (all 6 neg) |
| NQ quarterly | −0.038 (−0.5, 21) | mixed |
| NQ weekly Fri | +0.056 (+2.4, 208) | 4/6 pos |
| ES monthly | **−0.158 (−3.0, 40)** | −0.15 / −0.16 / −0.09 / −0.15 / −0.19 / −0.46 (all 6 neg) |
| ES weekly Fri | +0.063 (+2.0, 185) | 4/6 pos |

In points: NQ monthly-expiry mornings mean **−45 pts**, median −54, 64% of
days negative (n=44). Calendar-locked (12 per year, knowable weeks ahead),
cross-market confirmed, sign-stable every year in both markets. Mechanism
consistent with monthly-OI delta/charm unwind executing at the open — and
notably absent on quarterlies, where the index SOQ settlement at the open
clears much of the futures-linked book instead (n=21 is too small to say
more).

**Pinning (path attraction to max-OI strike): DEAD, placebo-controlled.**
QQQ space, 2023-03+, pin = max-OI expiring strike within ±3% of 10:00 spot
(prior-day OI, knowable): P(distance at 16:00 < distance at 10:00) = 0.42
(monthly, n=26), 0.43 (weekly, n=126), 0.38 (daily, n=620) vs offset-placebo
0.40–0.45 and a random-walk-expected <0.5. No monthly>weekly gradient, no
pin-OI-magnitude gradient (hiOI 0.42 vs loOI 0.36), no year where it appears.
The price path is NOT attracted to max-OI strikes.

**TW/expiry vol & volume: NULL.** Realized vol and volume-share profiles by
window are indistinguishable across weekly/monthly/quarterly Fridays
(triple-witching open vol NOT systematically elevated, per-year medians
overlap). Mon–Thu daily-expiry vs no-expiry days (2021–22, when "none"
existed): no drift or vol differences.

## H3. Calendar-forced rebalancing (month/quarter-end): DEAD

- Day/late-day drift by trading-day offset to month end (me_t −4..+3): no
  offset with |t|>2 vs control; ME−1/ME0 late-day drift inverts across years
  (2021 −0.10, 2022 +0.06, 2026 +0.13).
- State-dependent pension direction (MTD up ⇒ month-end selling): late-day
  return on ME−1/ME0 by MTD sign — MTD_up +0.013 (t=+0.4, n=81), MTD_dn
  +0.006 (t=+0.1, n=49); per-year signs flip; quarter-end subset likewise
  (MTD_up −0.031 t=−0.7, n=28, sign flips 2023/2025). No footprint at 1m
  resolution in index futures.
- Only residue: turn-of-month +2 day drift +0.12 ATR (t=+1.8, 5/6 years
  positive) — the classic TOM equity premium, weak, not obviously dealer flow;
  not ranked.

## H4. Time-locked micro-flows (minute census): SURVIVOR (family)

1,380 minutes tested; Bonferroni t≈4.2. Minutes with pooled |t|≥3.5, 6/6-year
sign agreement on NQ, **and** independent ES replication (R2-08 C3):

| ET minute | NQ mean pts (t) | ES (t) | note |
|---|---|---|---|
| 10:50 | **−1.73 (−5.7)** | −4.6 | biggest; 52/66 months negative; ES neg 2021-25 |
| 09:49 | −1.24 (−4.2) | −4.3 | pre-10:00 fade |
| 11:00 | +1.10 (+3.7) | +2.5 | rebound after 10:50-ish weakness |
| 23:00 | +0.68 (+6.9) | **+9.0** | Asia session; positive every year, both markets |
| 03:25 | −0.45 (−3.7) | −4.6 | pre-Europe-open fade; all years, both markets |
| 15:57 | +0.81 (+4.1) | +3.0 | post-MOC-publication drift-up |
| 16:13 | +0.74 (+4.1) | +2.9 | settlement window |
| 18:30 | +0.62 (+5.3) | +4.6 | Globex reopen +30m |
| 13:12 | +0.90 (+4.8) | +5.8 | 5/6 NQ years; unexplained |
| 05:32 | +0.43 (+3.5) | +2.8 | small |

09:27 (NQ −0.93, t=−5.0, 6/6) replicates only weakly on ES (t=−2.5, 2021 ~0).

These are genuine, stable clock effects — but magnitudes are 0.4–1.7 NQ pts
per minute, i.e. near round-trip cost for a 1-minute hold. Only 10:50 (and
possibly a 09:49+10:50 / 10:45–11:00 straddle-window composite) is big enough
to justify a 1s look. No public event maps to 10:50/13:12; treat as
unexplained systematic execution schedules.

**Named-window signed drift: NULL** for 08:30 data window, 09:30 open,
09:35–10:00, 10:00 data, 14:00–14:30, 15:00–15:30 unconditional, 15:50–15:59
MOC window, 16:00–16:15 settlement, 18:00 reopen, 02:00–04:00 Europe — all
either |t|<2 pooled or year-sign-unstable. (Event VOL at 08:30/09:30/10:00 is
of course huge — but it is two-sided; no exploitable signed drift.)

## H5. Midday vol-selling footprint: WEAK / NOT RANKED

- U-shape baseline extremely stable across eras (midday/morning suppression
  ratio S ≈ 0.60–0.65 every year 2021–2026).
- S by 0DTE-OI-share tercile (2023-03+): hi 0.605 vs lo 0.649, directionally
  consistent in 3 of 4 years — but the **absolute** midday vol level shows no
  0DTE gradient within ATR terciles (flat to slightly higher on hi-0DTE days).
  The ratio effect therefore comes from relatively hotter mornings on hi-0DTE
  days, not from extra midday damping. Confounded; not a survivor.
- High-vol regimes do NOT break the suppression (top-decile ATR: S 0.51–0.85,
  unstable by era). No state-readable lever found.

## H6. Cross-market execution lead/lag: DEAD (clean null)

1m contemporaneous corr NQ-ES 0.83–0.97, NQ-QQQ 0.98–0.997. Lead asymmetry
A = corr(x_t, y_{t+1}) − corr(y_t, x_{t+1}):
- NQ vs ES: |A| ≤ 0.04, sign flips across years and windows (open, midday,
  last hour, Europe). No stable window-localized lead.
- NQ vs QQQ: A > 0 in 17/18 window-years but tiny (+0.001..+0.014) — the
  well-known futures-lead-cash microstructure effect, uniform across windows,
  not a hedge-window footprint. Nothing exploitable at 1m.

---

## RANKED SHORTLIST (stable + state-readable live)

1. **Pre-close continuation window, 15:00→15:30** (H1). Mechanism: EOD delta
   re-hedge proportional to the day's move executes early in the last hour,
   before MOC imbalance publication. State: day move 09:30→15:00 (knowable at
   15:00), size-gated (|move|>0.3 ATR). Effect: +6.5 to +7.6 NQ pts aligned
   (mean; +14 on >1 ATR days), P(same sign) 0.57–0.61 pooled; positive beta
   every year 2021–2026, window-specific, monotone in move size, ES-confirmed.
   Weak year: 2024 (~flat, not inverted). n=1319 (644 with |move|>0.3 ATR).
   **1s follow-up:** market entry at 15:00:01 in day-move direction on
   |move|≥0.3 ATR days, flat 15:30, honest market-order slippage both sides;
   ~+6 pts gross mean vs ~1–1.5 pts cost is a real margin to test; also test
   ATR-tercile conditioning (hi-vol amplification) and a 15:29 vs adverse-stop
   exit variant.
2. **Monthly-expiry (3rd-Friday) morning weakness, 09:30→10:30** (H2).
   Mechanism: monthly-OI unwind/charm de-hedge at the open. State: pure
   calendar, knowable weeks ahead. Effect: −45 pts mean / −54 median
   (−0.15 ATR), 64% negative days; negative all 6 years in NQ AND all 6 in
   ES (t≈−3 in each). n=44 (12/yr). **1s follow-up:** short at 09:30:01 open
   on monthly-expiry days, cover 10:30, slippage both sides; n will stay
   small — judge by per-year sign stability and DD, not pooled PF alone.
3. **10:50 ET minute fade (± the 10:45–11:00 complex)** (H4). Mechanism
   unknown — no public event at 10:50; footprint looks like a recurring
   scheduled execution. Effect: −1.7 pts in that single minute (t=−5.7,
   6/6 years, 52/66 months), ES −4.6; neighboring minutes flat, 11:00
   bounces +1.1. **1s follow-up:** localize the flow inside 10:49–10:51 at
   1s resolution; only tradable if the 1s path shows a front-runnable ramp
   rather than a single print.
4. **High-vol-regime EOD amplification** (H1 conditional). Last-hour
   day-move beta positive in the top ATR-regime tercile in all three eras
   (+0.05/+0.05/+0.15) and ~zero in low-vol. Use as a conditioner/sizer for
   #1 rather than a standalone signal.
5. **23:00 ET Asia drift-up** (H4). +0.7 NQ pts (t=+6.9), ES t=+9.0, positive
   every year both markets — the most statistically robust clock minute, but
   sub-1-pt magnitude: only viable inside an execution-timing overlay (e.g.,
   prefer buys at 22:59, sells at 23:01), not as a trade.

## DEAD LIST (do not re-run at 1m)

- Full last-hour EOD re-hedge as a fixed effect (year-sign inversions).
- Overnight-gap open re-hedge (first-30m drift vs gap: inverts).
- Max-OI strike pinning as path attraction — placebo-flat in every class,
  year, and OI tercile (flow version; sibling study killed the level version).
- Month-end / quarter-end rebalancing drift, unconditional AND
  MTD-conditional (pension direction) — signs flip yearly; QE no better.
- Triple-witching open vol elevation; expiry-class vol/volume differences.
- Daily-0DTE-day drift/vol vs non-expiry controls (2021–22).
- 0DTE-share midday vol suppression (ratio artifact; no absolute effect).
- Cross-market window-localized lead/lag (NQ-ES unstable; NQ-QQQ = known
  microstructure, uniform, tiny).
- Signed drift in named event windows: 08:30, 09:30 open, 10:00, MOC
  15:50–16:00, settlement 16:00–16:15, 18:00 reopen, Europe 02:00–04:00.
- Turn-of-month +2 drift: weak (t=1.8), classic TOM premium, not flow-locked
  enough to rank.

## Known limitations

- No VIX index series (VIX-options file only) — vol regime = realized ATR.
- OI data starts 2023-03; 0DTE-share conditioning has no 2021–22 coverage.
- Quarterly-expiry cells are n≈21 — census-grade only.
- 1m bars cannot see intraminute execution shape; every ranked candidate
  needs the mandated 1s re-implementation before any WR/PF/EV claim.
