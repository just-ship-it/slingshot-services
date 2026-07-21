# R7 — Census of Calendar- and Event-Day Flow Signatures on NQ

**Scope:** descriptive census of which calendar days / scheduled events carry a *signed, clock-locked drift* on NQ, with matched controls, per-year (2021–2026) stability, ES generalization, and points + vol-normalized (prior-14d ATR) effect sizes. **No WR/PF/fills** — those require the 1s sims that follow. Data: `cache_nq_primary_1m.csv` (NQ 1m primary, 1409 trade-days 2020-12→2026-06), `B12-days.csv` (day features), `cache/ES_1m_primary.csv` (generalization).

**Method notes**
- NQ 1m cache `ts` is **UTC** (verified: winter 14:30Z = summer 13:30Z = 09:30 ET open, matched to `rth_open`). Converted to America/New_York with DST; trade_date rolls at 18:00 ET (Globex). ES file carries ET stamps.
- Each calendar bucket produces **exactly one drift value per day** → pooled == day-weighted by construction (honesty rule #8 satisfied; no variable-count-per-day divergence possible here).
- Segment drifts are **same-symbol gated** (endpoints must share the `symbol` column) so no drift ever spans a contract rollover (phantom 200pt jumps excluded).
- All conditioners (dow, trading-day-of-month, OPEX week, holiday adjacency) are pure date arithmetic knowable before the outcome window. The one place a **lookahead crept in was a volume-normalized event classifier — see the DEAD list, it is instructive.**
- `t` is a simple one-sample t on the per-day drift; treat |t|≳2 as suggestive only (many buckets tested → multiple-testing; I privilege *per-year sign coherence* and *ES replication* over any single t).
- Scripts: `R7-01-extract-anchors.py` (NQ anchor pass), `R7-02…es.py`, `R7-03-analyze.py` (all hypotheses → `R7-out.txt`), `R7-04-causal-and-es.py` (causal proxies + ES → `R7-out2.txt`), `R7-05-robustness.py` (`R7-out3.txt`). Panel: `R7-nq-panel.csv`.

**⚠️ Tradability cap (structural):** calendar effects are event-count-capped. Weekday effects fire ~50×/yr → can reach n≥100 (**CORE-eligible**). Anything tied to a monthly/quarterly date (OPEX, month-end, FOMC, holidays) fires ≤12×/yr → can never reach n≥100 over this sample (**SATELLITE-only**, paper-trade), exactly as the calibration warned.

---

## RANKED SHORTLIST

| # | Candidate | Window (ET) | Dir | NQ effect (pts / ATR) | NQ per-yr | ES check | events/yr, n | Core? |
|---|-----------|-------------|-----|-----------------------|-----------|----------|--------------|-------|
| 1 | **Monday RTH strength** | 09:30→16:00 (full RTH) | LONG | **+24.6 pt / +0.084 ATR** | **6/7 +** (only 2022 −1) | **ES +5.1pt, 5/6 +, t=2.32** | ~48/yr, **n=251** | **CORE** |
| 2 | **Tuesday morning weakness** | 09:30→10:30 | SHORT | **−10.5 pt / −0.043 ATR** | **7/7 −** (every year) | **ES −1.9pt, 5/6 −, t=−1.63** | ~52/yr, **n=285** | **CORE** |
| 3 | Turn-of-month afternoon drift | 14:00→16:00, last-td + first-3-td | LONG | +9.3 pt / +0.032 ATR (window); last-td alone +21.9pt 6/7 | 6/7 + (window) | ES +1.1pt 5/6 + (weak) | window ~48/yr n=255; last-td 12/yr n=64 | marginal-CORE / SATELLITE |
| 4 | OPEX-week Thursday afternoon weakness | 14:00→16:00 on OPEX-week Thu | SHORT | −20.5 pt / −0.046 ATR | 2/6 (one big yr drives) | **ES −4.6pt, 1/6, t=−1.69** | ~12/yr, n=64 | SATELLITE |
| 5 | Monthly-OPEX Friday morning weakness | 09:30→10:30 on 3rd-Fri | SHORT | −19.5 pt / −0.071 ATR | **6/6 −** (all years) | (not separately ES-run) | ~11/yr, n=65 | SATELLITE (known prior, re-confirmed) |

### Candidate detail

**#1 Monday RTH strength (CORE).** NQ Monday 09:30→16:00 drifts **+24.6 pt** (t=2.41), positive **6 of 7 years** (2022 only −1). ES replicates: **+5.1 pt, 5/6 years, t=2.32**. Holiday-clean (excluding half/pre/post-holiday: +25.1 pt, unchanged — market-holiday Mondays simply drop out of the sample). The drift is *spread across the whole session* (each sub-window long and positive: open15 +4.3, am1 +8.2, mid +9.1 [6/7], pm +6.8 [6/7], last-hr +6.6), so a full-RTH hold captures it best; there is no single tight sub-window that dominates. **Mechanism:** weekend risk-premium / systematic Monday re-risking and fund inflows after the non-trading gap — a recurrent, knowable-date flow. **Non-stationarity flag:** effect is regime-loaded — sample-half split gives +7.3 pt (2021–H1'23) vs **+38.9 pt (H2'23–'26, 4/4 years, t=2.66)**; it never inverts but is much larger recently, and the within-day locus shifted from PM (early sample) to AM+all-day (recent). **1s follow-up:** long NQ at 09:30 Monday, exit 16:00 (or 15:45 for the pre-close-cutoff live rule); test a morning-only variant (09:30→12:00) to cut exposure; verify the +24pt gross survives ~2–4pt round-trip costs, and stress the weak first-half separately.

**#2 Tuesday morning weakness (CORE).** NQ Tuesday 09:30→10:30 drifts **−10.5 pt** (t=−1.76), negative **every one of 7 years** (−41,−5,−24,−5,−11,−4,−18) — the single most sign-stable cell in the census. Extends to 09:30→11:00 (−12.0 pt). ES replicates: **−1.9 pt, 5/6 years, t=−1.63**. Holiday-clean −9.6 pt (still 0/7). Note Tuesday is a *V-shape*: morning down, then midday/PM positive (mid +8.2, pm +6.0), so full-day nets ~flat (+1.7) — the tradable, stable leg is the **AM short only**. **Mechanism:** give-back of the Monday-strength move / Tuesday re-hedging at the open. **Non-stationarity flag:** decaying — H1 −15.1 pt (0/4) vs H2 −6.6 pt (1/4; 2024 printed +6). Sign persists but magnitude has roughly halved; the recent half is where costs bite. **1s follow-up:** short NQ 09:30→10:30 Tuesdays; confirm the shrunken recent-era edge still clears costs; optionally pair with a Tuesday-PM long (less stable, 4/7) as a same-day mean-reversion combo.

**#3 Turn-of-month afternoon drift (marginal).** The last-trading-day-of-month 14:00→16:00 is +21.9 pt (6/7 years) and the classic ToM window (last td + first 3 tds) afternoon is +9.3 pt (6/7); ES agrees weakly (+1.1 pt, 5/6). The *direction* over the full day is noisy (the tdom-1..10 sweep shows **no monotone structure** — see DEAD list), but the **into-the-close afternoon** leg is coherent. The last-trading-day version is the cleanest but only 12/yr (SATELLITE); the pooled 4-day window reaches n=255 but is a weak (t≈1.5), heterogeneous mix. Paper-trade candidate at best.

**#4 OPEX-week Thursday afternoon weakness (SATELLITE).** Thursday of the week containing the 3rd Friday drifts −20.5 pt (14:00→16:00, t=−1.85) and −34 pt full-day; ES confirms the sign (−4.6 pt PM, 1/6, t=−1.69; −6.5 pt RTH). Coherent across close windows and across both markets — but per-year 2/6 (one big year drives), ~12/yr, and it is the worst of the 5 OPEX-week weekdays I looked at (multiple-testing exposure). Interesting, not bankable.

**#5 Monthly-OPEX Friday morning weakness (SATELLITE, prior re-confirmed).** 3rd-Friday 09:30→10:30 = −19.5 pt, **negative all 6 years** (0/6). This is the known monthly-OPEX morning-weakness effect; the census reproduces it cleanly, which validates the pipeline — but at ~11/yr it can never reach n≥100 and is a paper-trade satellite, as flagged in calibration.

---

## Per-hypothesis tables (condensed; full numbers in `R7-out*.txt`)

### H1 — Day-of-week × time-of-day (control = pooled all weekdays)
| Day | rth_full | am1 09:30-10:30 | pm 14:00-16:00 | last-hr |
|-----|----------|-----------------|----------------|---------|
| Mon | **+24.6 (6/7)** | +8.2 (5/7) | +6.8 (6/7) | +6.6 (5/7) |
| Tue | +1.7 (4/7) | **−10.5 (0/7)** | +6.0 (4/7) | −0.6 |
| Wed | +7.1 (3/7) | +5.0 (3/7) | +0.8 | −2.0 |
| Thu | −16.6 (4/7) | −6.4 (2/7) | −8.2 (2/7) | −6.1 (2/7) |
| Fri | +3.3 (3/6) | +3.7 (3/6) | +1.2 (4/6) | +0.5 |
| ALL | +3.7 | 0.0 | +1.3 | −0.4 |

Monday-long and Tuesday-AM-short are the standouts. Thursday is weak across the day in both markets but **sign-unstable per year** (2021 flips hard positive) → not a clean candidate. Wednesday's signal lives **overnight**, not in RTH: Wed gap (prior close→open) = **+17.0 pt, 7/7 years**, and Wed overnight session (18:00→09:30) +14.1 (6/7) — a real, every-year Wednesday-overnight-up flow, but it is an **overnight/gap effect (defer to the overnight-hour sibling)**; you cannot harvest a gap intraday without holding the overnight.

### H2 — Turn-of-month (control = mid-month, tdom 8..−8)
Full-day *direction* is noise: tdom forward-1..10 and reverse-1..−5 sweeps show **no monotone structure**, signs scatter year to year. Only the **afternoon/into-close** leg is coherent (see shortlist #3). Gap on first-3-tds is −16 pt but 2/7 (unstable).

### H3 — OPEX week (control = non-OPEX weeks)
Whole OPEX week is mildly weak (rth_full −9.3 vs +7.6 control) but per-year 3/6. Day-by-day, weakness concentrates on **Thu (afternoon)** and the known **Fri morning** (shortlist #4, #5). Quarterly OPEX (Mar/Jun/Sep/Dec 3rd-Fri) direction is pure noise (n=21, wild per-year swings).

### H4 — Month-end / month-start
Month-start overnight (first-td 18:00→09:30) +21.1 pt (5/7) and month-end last-hr +10.9 (5/7) are the only mildly-coherent cells; both ≤12/yr SATELLITE and largely a restatement of H2's afternoon/overnight coherence. Month-boundary *gap direction* is unstable.

### H5 — FOMC / macro proxy
FOMC proxy = top-8/yr Wednesdays by 14:00 volume spike (real FOMC dates are scheduled/knowable, so proxy identification is legitimate descriptively). The **14:00 volatility bump is real** (that's what the proxy keys on) but the **signed drift is not stable**: post-announcement 14:00→15:00 = +12.8 pt but only **3/7 years** once the classifier baseline is made causal (prior-day-normalized); full-RTH and last-hour swing wildly by year. **FOMC = a volatility event, not a tradable directional drift** — consistent with separating VOL from DRIFT. SATELLITE and directionally DEAD.

### H6 — Holiday-adjacent / half days
pre/post-holiday n=17 each (~3/yr), half-days n=47. All noisy; the only mild cell is post-holiday afternoon +32 pt (5/6) but n=17. **Can never reach n≥100 → SATELLITE, effectively DEAD.**

---

## DEAD LIST (do not pursue as directional edges)

1. **08:30-release morning drift — NULL (was a lookahead artifact).** Selecting "big 08:30 news" days by an 08:30 volume spike *normalized by the same day's full-RTH average volume* produced a spectacular +15.9 pt / **6-of-6-years** 09:30→10:30 long. **That normalizer includes post-09:30 volume — future information in the day-classifier.** Re-run with a *causal* baseline (prior-day RTH avg vol, and a trailing-20d self-median), the effect **collapses to +3.8 pt (3/6) and +0.8 pt (4/6)** — gone. The "edge" was just that days which *turned out* high-volume also trended. **Lesson for the book: an event-set classifier is data too; its inputs must be knowable before the outcome window, or it manufactures the result.**
2. **FOMC directional drift** — vol event only; sign 3/7 after causal classifier. (Vol bump real.)
3. **Turn-of-month / month-boundary DIRECTION (full-day)** — no monotone tdom structure; sign scatters. (Only the afternoon leg has weak coherence.)
4. **Quarterly-expiration direction** — noise (n=21).
5. **Thursday full-day short** — weak in both markets but per-year sign-unstable (2021 large positive).
6. **Holiday-adjacent & half-day drifts** — tiny n, noisy, structurally un-bankable.
7. **Friday-afternoon drift** — mildly positive both markets (ES 5/6) but ~+1.5 pt; too small to survive costs alone; note only.

---

## What to hand to the 1s stage

- **Priority A (CORE-eligible, ES-confirmed):** Monday 09:30→16:00 long; Tuesday 09:30→10:30 short. Build honest 1s sims (fills + stops + MFE/MAE from fill instant), report per-year and **especially per-sample-half** (Monday is recent-loaded, Tuesday is decaying). These two are the census's real output and are plausibly uncorrelated with the confirmed 15:00→15:30 pre-close edge (different clock, different mechanism).
- **Priority B (satellites, paper-trade):** turn-of-month last-day into-close long; OPEX-week Thursday afternoon short; monthly-OPEX Friday morning short. Interesting, mechanically motivated, but event-capped — never book cores.
- **Hand to the overnight-hour sibling:** Wednesday overnight/gap-up (18:00→09:30, +17 pt gap 7/7) and Monday overnight (+19 pt, 5/7) live outside RTH.
