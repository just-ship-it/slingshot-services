# B4 — Pre-close continuation + monthly-expiry morning weakness (honest 1s sims)

**Date:** 2026-07-17. **Charter:** GREENFIELD.md / KNOWABILITY.md.
**Scripts:** `B4-00-npz-cache.py` (format cache), `B4_common.py` (1s walker + metrics reuse from `B12_sim.py`), `B4-01-preclose.py` (B4a), `B4-02-expiry.py` (B4b).
**Data:** `cache_nq_rth_1s.csv` (31.18M rows, 1,395 days, per-day primary contract; monotone-ts verified per day), `B12-days.csv` (day features knowable at 09:30), `R2-calendar.csv` (expiry classes).

**Sim contract (both studies):** market orders fill at the next 1s bar open +0.25pt adverse (×2 sensitivity line); stops fill at stop ∓0.5pt with same-1s-bar ambiguity against the trade (stop may fire on the entry bar); time exits at the flat bar's open ∓0.25pt; $5 RT commission; NQ $20/pt, 1 contract; flat by 15:45 ET max; days with an intraday contract roll excluded (`rth_same_sym`). A decision "at" wall time T uses only 1s bars closed by T (bar stamped 14:59:59 closes 15:00:00). Sim spot-verified by independent raw-CSV replication of 3 trades (exact fill/PnL match).

**Dev = 2021–2024 only. 2025–2026 locked, run ONCE on the frozen config per study, reported verbatim below.**

---

## B4a — Pre-close continuation

Hypothesis (from sibling census, taken as hypothesis): 15:00→15:30 ET NQ return continues the 09:30→15:00 day move (census gross ~+5.2 pts aligned, monotone in |move|, concentrated in top ATR tercile).

Construction: at 15:00:00, `day_move` = close of last 1s bar before 15:00:00 minus open of first 1s bar ≥09:30:00. Enter aligned (long if up-day) market placed 15:00:01. Eligibility: full RTH session, no intraday roll, ATR14 + trailing tercile knowable, signal bar within 120s of 15:00. Dev universe: 929 days (skips: 34 early-close, 4 roll, 54 ATR/tercile warmup, 1 zero-move).

Grid (24 configs, all disclosed): |move| filter {none, >0.15·ATR14, >0.30·ATR14} × vol gate {none, top trailing-250d ATR14 tercile (strictly-prior window, min 60 obs)} × exit {15:30, 15:45} × stop {none, 25pt}.

### Dev results 2021–2024, slip 1× (n / WR / PF / Sharpe / maxDD / PnL; per-year = PnL/count)

| config | n | WR | PF | Sh | maxDD | PnL | 2021 | 2022 | 2023 | 2024 | PF@2×slip |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none · allvol · 15:30 · no stop (census baseline) | 929 | 55.9 | 1.237 | 1.16 | −20,875 | +49,820 | +11,265/186 | +28,040/248 | +18,855/247 | −8,340/248 | 1.189 |
| none · allvol · 15:30 · 25pt | 929 | 47.0 | 1.034 | 0.21 | −18,515 | +6,850 | +9,505 | +2,120 | +9,025 | −13,800 | 0.983 |
| none · allvol · 15:45 · no stop | 929 | 54.7 | 1.176 | 0.85 | −28,440 | +45,670 | +1,385 | +29,375 | +27,210 | −12,300 | 1.138 |
| none · allvol · 15:45 · 25pt | 929 | 43.4 | 0.949 | −0.33 | −24,955 | −11,870 | +370 | +750 | +7,955 | −20,945 | 0.908 |
| none · topATR · 15:30 · no stop | 321 | 53.6 | 1.131 | 0.41 | −21,225 | +12,785 | +1,695/43 | +25,615/118 | +2,215/10 | −16,740/150 | 1.097 |
| none · topATR · 15:30 · 25pt | 321 | 40.2 | 0.910 | −0.34 | −18,325 | −7,615 | | | | | 0.874 |
| none · topATR · 15:45 · no stop | 321 | 53.6 | 1.119 | 0.37 | −28,035 | +13,965 | | | | | 1.090 |
| none · topATR · 15:45 · 25pt | 321 | 35.5 | 0.815 | −0.75 | −23,765 | −17,710 | | | | | 0.786 |
| >0.15 · allvol · 15:30 · no stop | 714 | 59.1 | 1.398 | 1.60 | −14,610 | +63,050 | +15,025/142 | +30,815/201 | +19,455/191 | −2,245/180 | 1.347 |
| >0.15 · allvol · 15:30 · 25pt | 714 | 49.9 | 1.193 | 0.95 | −13,250 | +28,745 | | | | | 1.137 |
| >0.15 · allvol · 15:45 · no stop | 714 | 57.8 | 1.319 | 1.25 | −23,465 | +61,505 | | | | | 1.278 |
| >0.15 · allvol · 15:45 · 25pt | 714 | 46.6 | 1.109 | 0.57 | −18,985 | +18,210 | | | | | 1.062 |
| >0.15 · topATR · 15:30 · no stop | 243 | 57.2 | 1.326 | 0.81 | −14,435 | +22,885 | +5,235/31 | +24,895/93 | +2,215/10 | −9,460/109 | 1.287 |
| >0.15 · topATR · 15:30 · 25pt | 243 | 43.2 | 1.068 | 0.20 | −13,595 | +4,235 | | | | | 1.026 |
| >0.15 · topATR · 15:45 · no stop | 243 | 58.0 | 1.293 | 0.74 | −21,545 | +24,285 | | | | | 1.261 |
| >0.15 · topATR · 15:45 · 25pt | 243 | 39.1 | 0.976 | −0.08 | −16,785 | −1,630 | | | | | 0.942 |
| **>0.30 · allvol · 15:30 · no stop** | **514** | **60.5** | **1.461** | **1.56** | **−11,270** | **+50,815** | **+8,260/107** | **+22,230/137** | **+19,710/134** | **+615/136** | **1.407** |
| >0.30 · allvol · 15:30 · 25pt | 514 | 51.8 | 1.272 | 1.12 | −8,300 | +28,235 | | | | | 1.212 |
| >0.30 · allvol · 15:45 · no stop | 514 | 59.5 | 1.394 | 1.23 | −19,505 | +52,100 | +3,695 | +24,420 | +25,055 | −1,070 | 1.350 |
| >0.30 · allvol · 15:45 · 25pt | 514 | 48.4 | 1.174 | 0.75 | −12,725 | +20,310 | | | | | 1.123 |
| >0.30 · topATR · 15:30 · no stop | 165 | 57.6 | 1.288 | 0.63 | −11,440 | +13,455 | +1,755/24 | +17,990/60 | +445/6 | −6,735/75 | 1.249 |
| >0.30 · topATR · 15:30 · 25pt | 165 | 45.5 | 1.146 | 0.36 | −8,245 | +5,910 | | | | | 1.103 |
| >0.30 · topATR · 15:45 · no stop | 165 | 57.0 | 1.273 | 0.57 | −18,785 | +14,760 | | | | | 1.240 |
| >0.30 · topATR · 15:45 · 25pt | 165 | 39.4 | 1.035 | 0.09 | −11,940 | +1,615 | | | | | 0.999 |

(Blank per-year cells share the row-above's day counts; full per-year figures for every config are in the `B4-01-preclose.py dev` output.)

### Dev findings

1. **The census effect survives 1s costs in dev, attenuated.** Unfiltered baseline gross = **+3.43 pts/trade** (census 2021–2026 gross was +5.2; dev-only is smaller) against total costs of ~0.75 pt (0.5 pt round-trip slippage + $5 = $15 ≈ 0.75 pt). Net ≈ **+2.7 pts ≈ +$54/trade**, PF 1.24. So roughly **78% of the dev gross edge survives costs** — cost drag is not the binding problem.
2. **The binding problem is 2024.** Every filterless/filtered variant decays hard in 2024 (baseline −$8.3k; best filter +$0.6k ≈ flat). 2021–2023 are uniformly strong.
3. **Monotone-in-|move| confirms:** PF 1.237 → 1.398 → 1.461 as the filter tightens (matches the census's monotonicity claim).
4. **The census's top-ATR-tercile conditioner FAILS in knowable form.** With trailing-250d terciles the gate *worsens* every pairing (e.g. 1.461 → 1.288). Mechanically: trailing terciles after the 2022 vol regime mark almost no 2023 days as top-tercile (n=10) and concentrate exposure in 2024 (n=150) — exactly the bad year. The census conditioner was presumably full-sample terciles (not knowable). Rejected.
5. **Stops hurt uniformly** (25pt stop cuts PF in all 12 pairings): the effect is a drift, not a favorable path; stop-outs eat the winners' noise.
6. **15:30 exit ≥ 15:45 exit everywhere** — consistent with the effect being specifically the 15:00→15:30 window (census clock-lock).

### FROZEN CONFIG (declared before any 2025–2026 run)

**B4a-frozen:** enter aligned market at 15:00:01 when |day_move| > 0.30×ATR14; no vol gate; no stop; exit market 15:30:00. Chosen because: highest dev PF, the only config positive all 4 dev years, and its one filter is the census's own pre-stated monotonicity conditioner (not post-hoc). Dev: n=514, WR 60.5, PF 1.461, Sharpe 1.56, maxDD −$11,270, avg +$99/trade, gross +5.69 pts/trade, PF 1.407 @2× slip.

### LOCKED VALIDATION 2025–2026 (verbatim)

**Protocol deviation, disclosed:** the first frozen invocation ran with a stale `FROZEN` constant left at the unfiltered baseline (`fmove=None`) instead of the declared config — i.e. one unintended extra look at validation data, on a *different* (unfiltered) config. Its output, verbatim, so nothing is hidden: `mv>- allvol ex1530 st-  n=360 WR=51.9 PF=1.269 PnL=$30525 Sh=1.24 DD=$-14305 yrs+=2/2 [2025:+22810/247 2026:+7715/113] grossPts=4.99` (2×slip PF 1.233). The constant was then corrected to the pre-declared config (declared in this doc before any 2025–2026 run) and run once:

```
[B4a frozen] eligible days: 360  skipped: {'not_in_days': 0, 'not_full': 13, 'roll': 0, 'atr': 0, 'cover': 0, 'zero': 0}

=== B4a frozen 2025-2026 | slip 1x ===
mv>0.3 allvol ex1530 st-                   n=195  WR=52.3  PF=1.572  PnL=$33910    Sh=1.66  DD=$-7610   hold(m) avg=30.0/med=30.0 yrs+=2/2 [2025:+18125/133 2026:+15785/62] grossPts=9.44

=== B4a frozen 2025-2026 | slip 2x (sensitivity) ===
mv>0.3 allvol ex1530 st- 2xslip            n=195  WR=50.8  PF=1.531  PnL=$31960    Sh=1.57  DD=$-8385   hold(m) avg=30.0/med=30.0 yrs+=2/2 [2025:+16795/133 2026:+15165/62]
```

Per-year: 2025 n=133 WR 49.6 PF 1.45 +$18,125 (gross +7.56 pts) · 2026 n=62 WR 58.1 PF 1.82 +$15,785 (gross +13.48 pts).

**Validation PF 1.572 ≥ 1.2 bar → PASS.** Both locked years positive; gross edge per trade *larger* in validation (+9.4 pts) than dev (+5.7); 2× slippage barely dents it (PF 1.531). The 2024 dev flatline (PF 1.02) was a soft year, not the start of decay — 2025–2026 came back strong. Note validation WR is lower (52.3 vs 60.5) with fatter winners: the character shifted from steady drift to fewer/larger continuation days, consistent with the higher-vol 2025–2026 regime.

### B4a VERDICT: **ALIVE** (vs this study's bar)

All bar components met: dev PF 1.461 (≥1.3), positive every dev year (4/4), n=514 (≥100), locked validation PF 1.572 (≥1.2, 2/2 years, n=195). Full-sample 2021–2026: 709 trades, +$84,725, every calendar year positive except 2024 (+$615, ~flat). Caveats for any deployment discussion: (1) single trade/day, 30-min hold, avg +$120/trade — thin absolute edge per event, all execution-honest but sensitive to fill quality worse than 0.5pt round trip beyond the tested 2× line; (2) 2024 shows the effect can go dormant for a year; (3) inputs are pure clock + 1s price + prior-day ATR — fully live-sourceable (TradingView), no data purchases.

---

## B4b — Monthly-expiry morning weakness

Hypothesis (census): 3rd-Friday **monthly** (non-quarterly) expirations, 09:30→10:30 mean −45 pts / median −54, 64% negative. Thin by construction (~8/yr).

Calendar verification: all 65 monthly+quarterly rows in `R2-calendar.csv` equal the computed true 3rd Friday (or its holiday-shifted Thursday, e.g. 2022-04-14); quarterlies = Mar/Jun/Sep/Dec; no month missing. Universe: `exp_class == 'monthly'` (matches census n≈44 = 8/yr). Dev-eligible: 31 of 32 (2021-01-15 predates the 1s cache).

Construction: SHORT market placed 09:30:01 (fills 1s open −0.25), exit market 10:30:00. Grid (4 configs): stop {none, 40pt} × {plain, skip if gap-down > 0.3×ATR14}.

### Dev results 2021–2024, slip 1×

| config | n | WR | PF | Sh* | maxDD | PnL | avg/trade | PF@2×slip |
|---|---|---|---|---|---|---|---|---|
| **plain · no stop** | **31** | **64.5** | **3.726** | 8.49* | −2,165 | +25,095 | +$810 | 3.661 |
| skip-gapdn · no stop | 28 | 64.3 | 3.243 | 7.21* | −2,325 | +20,020 | +$715 | 3.187 |
| plain · 40pt stop | 31 | 54.8 | 3.233 | 7.46* | −2,715 | +21,340 | +$688 | 3.169 |
| skip-gapdn · 40pt stop | 28 | 53.6 | 2.922 | 6.42* | −2,715 | +16,800 | +$600 | 2.862 |

*Sharpe computed over expiry days only (8 trades/yr) — the √252 annualization wildly overstates it; ignore its level, it is not comparable to a daily strategy's Sharpe.

Per-year, plain/no-stop: 2021 n=7 WR 85.7 PF 2.95 +$3,790 (gross +27.8pts) · 2022 n=8 WR 75.0 PF 5.83 +$11,230 (+70.9) · 2023 n=8 WR 50.0 PF 2.63 +$3,180 (+20.6) · 2024 n=8 WR 50.0 PF 3.31 +$6,895 (+43.8). Dev gross mean **+41.2 pts** short (median +43.25) vs ~0.75 pt costs — costs are negligible at this size; ~98% of gross survives.

Controls (descriptive, not swept): same short on **quarterly** 3rd Fridays: n=16, PF 0.90, gross −2.8 pts (no effect). Same short on **weekly Fridays**: n=151, PF 0.66, gross −14.4 pts (i.e. weekly Friday mornings drift UP — census-consistent). The effect is specific to the monthly class, as censused.

### FROZEN CONFIG (declared before any 2025–2026 run)

**B4b-frozen:** plain short, no stop, 09:30:01 → 10:30:00, monthly-class expiries only. Chosen because: highest dev PF; both added knobs (stop, gap-skip) only subtract. Dev: n=31, WR 64.5, PF 3.726, +$25,095, avg +$810/trade, 4/4 years, PF 3.661 @2× slip.

### LOCKED VALIDATION 2025–2026 (run once, verbatim)

```
[B4b frozen] monthly-expiry eligible days: 12 (['2025-01-17', '2025-02-21', '2025-04-17']...['2026-05-15'])

=== B4b frozen 2025-2026 SHORT 09:30:01->10:30 | slip 1x ===
short st- plain                            n=12   WR=66.7  PF=1.956  PnL=$9635     Sh=4.43  DD=$-6390   hold(m) avg=60.0/med=60.0 yrs+=1/2 [2025:+12200/8 2026:-2565/4] grossPts mean=40.9 med=75.62

=== B4b frozen | slip 2x (sensitivity) ===
short st- plain 2xslip                     n=12   WR=66.7  PF=1.941  PnL=$9515     Sh=4.38  DD=$-6420   hold(m) avg=60.0/med=60.0 yrs+=1/2 [2025:+12120/8 2026:-2605/4]
```

Validation: n=12, WR 66.7%, PF 1.96, +$9,635 total; 2025 strongly positive (+$12,200/8) but **2026 negative (−$2,565/4)**; gross mean +40.9 pts (median +75.6 — one large loser drags the mean).

### B4b VERDICT: **SUGGESTIVE — not establishable at this n** (by construction it can never meet the ≥100-trade bar)

The dev picture is strong (PF 3.7, 4/4 years, gross +41 pts vs ~0.75 pt costs, monthly-specific: quarterly control PF 0.90/gross −2.8 pts, weekly-Friday control opposite-signed) and locked validation stays net-positive (PF 1.96), but 2026 is negative on its 4 events and total n=43 means a few large down-mornings carry the PnL. The charter's ≥100-trade bar is unreachable for an 8-event/yr calendar effect, so the claim is capped as **suggestive**: real-looking, cost-robust, OOS net-positive, but not establishable — and the 2026 sign flip is exactly the kind of thing n=4 cannot adjudicate. If pursued at all: paper-trade at 1 contract (8 events/yr, avg ~+$800 over the full sample, observed maxDD −$6.4k in validation) purely to accumulate n; never size it as a validated edge. Failure risks: the economic story (monthly OPEX morning hedge unwind) was not independently verified here, and 0DTE migration is actively eroding monthly-OPEX concentration — the mechanism may be dying in real time (2026's −4 is weakly consistent with that).

---

## Summary vs survival bar

| study | dev PF / yrs+ / n | locked PF / yrs+ / n | bar (dev ≥1.3, all yrs+, n≥100, val ≥1.2) | verdict |
|---|---|---|---|---|
| B4a pre-close continuation | 1.461 / 4/4 / 514 | **1.572 / 2/2 / 195** | **ALL PASS** | **ALIVE** (2024 dormancy noted; 2× slip PF 1.531) |
| B4b expiry morning weakness | 3.726 / 4/4 / 31 | 1.956 / 1/2 / 12 | n-bar unreachable by construction | **SUGGESTIVE** (OOS net-positive; 2026 negative on n=4) |

Net-of-costs edge per trade: B4a unfiltered dev gross +3.43 pts → net ~+2.7 pts (~78% survives ~0.75 pt costs); B4a frozen config gross +5.69 dev / +9.44 validation → net +4.9 / +8.7 pts. B4b gross +41.2 dev / +40.9 validation → net ~+40.5 / +40.2 pts (costs negligible at this size).

**Follow-ups if B4a advances:** independent re-implementation cross-check (charter rule 7) by a fresh agent before belief; live fill-quality audit at 15:00:01 (book is thick then, but MOC-adjacent); decide dormancy tolerance (2024 was ~flat for a year).
