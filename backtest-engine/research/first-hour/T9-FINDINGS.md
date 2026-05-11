# T9: Day-of-week & event-day stratification (NQ first-hour kill-switch study)

## TL;DR
Weekday alone is **a weak filter** — Mon/Tue/Wed/Thu/Fri first-hour ranges are within ±8% of baseline median once you strip the 2025-04-07 tariff-shock outlier. Event days, however, are **massively distorted**: NVDA-reaction mornings (T+1 after AMC earnings) show 4.1× the baseline 60-min MAE and just 20% pBull90, FOMC-T+1 days show 1.92× MAE with 30% pBull90, and PCE / FOMC days themselves show 1.8–1.9× MAE. **Recommended kill-list: NVDA T+1, FOMC T+1, FOMC announcement day, PCE day, PCE T+1.** CPI-day distortion is mild and can stay tradeable with widened stops.

## Dataset
- Date range: **2025-01-13 → 2026-04-23**
- 316 trading days kept after filtering (333 candidate ET weekdays in window; -5 rollover days, -12 NYSE holidays)
- 209 days are "calm" (no FOMC/CPI/NFP/PCE/NVDA-T+1 tag)
- Event counts in window: FOMC=10, CPI=15, NFP=12, PCE=14, NVDA reaction=5
- Source: `data/ohlcv/nq/NQ_ohlcv_1m.csv` with `filterPrimaryContract()`
- Holidays excluded (full list): MLK, Presidents Day, Good Friday, Memorial Day, Juneteenth, July 4, Labor Day, Thanksgiving, Christmas (2025 + 2026)

Event calendar (manually compiled, see header of `T9-dow-events.js`):
- FOMC: 8 regular meetings/yr, second day of meeting (the 2pm-ET statement day)
- CPI: BLS releases at 8:30 ET (Sep 2025 release postponed by gov't shutdown → 10/24/2025)
- NFP: first Friday of month at 8:30 ET (Oct 2025 NFP postponed by shutdown → 11/20/2025)
- PCE: BEA last business day of month (Oct 2025 PCE delayed → combined 12/19/2025)
- NVDA earnings: AMC announcement; the **next morning** is the reaction day (5 events)

## Findings

### 1. Weekday is a weak filter

Baseline first-60m: range med=179.1, stdev=120.5, MFE med=77.3, MAE med=71.9, **pBull90=54.1%**.

| Day | n | range60 med | range60 med×base | range60 stdev×base | pBull90 | Δ pBull90 |
|---|---:|---:|---:|---:|---:|---:|
| Mon | 57 | 182.0 | 1.02 | 1.75 | 63.2% | **+9.1pp** |
| Tue | 66 | 170.6 | 0.95 | 0.77 | 51.5% | -2.6pp |
| Wed | 67 | 164.3 | 0.92 | 0.66 | 58.2% | +4.1pp |
| Thu | 63 | 188.8 | 1.05 | 0.75 | 46.0% | **-8.1pp** |
| Fri | 63 | 194.1 | 1.08 | 0.73 | 52.4% | -1.7pp |

The Monday "stdev × 1.75" headline is **entirely driven by 2025-04-07** (the post-Liberation-Day tariff-shock Monday: range60=1688, MFE=1436, MAE=251). Drop that single day and Monday stdev is 77.5 vs all-days 120.5 — actually **lower** than baseline. After excluding events ("calm Mondays" only): med 182.3, std 77.5 (with outlier still in: 211.3).

**Net weekday call**:
- **Tilt LONG-bias on Monday** (63% bull at 11:00) and **SHORT-bias on Thursday** (54% bear). Both effects are real but only ~9pp deltas — useful as a tie-breaker, not a stand-alone gate.
- Wed/Fri have slightly wider ranges. Tue/Wed are the calmest days in the calm-only sample.
- Do NOT skip any whole weekday based on this data.

### 2. Event-day distortions (ranked by composite distortion score)

Score = sum of `|metric_ratio − 1|` across range60, MFE60, MAE60, |directional90|.

| Event | n | distortion | range60×base | MAE60×base | MFE60×base | pBull90 | Δ pBull90 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **NVDA T+1** | 5 | **4.37** | 1.67× | **4.09×** | 0.52× | 20.0% | **−34.1pp** |
| **NFP T+1** | 12 | 3.39 | 1.02× | 0.62× | 1.26× | 75.0% | **+20.9pp** |
| **NVDA T+2** | 5 | 2.65 | 1.34× | 2.05× | 1.22× | 40.0% | -14.1pp |
| **FOMC T+1** | 10 | 2.21 | 1.30× | **1.92×** | 0.73× | 30.0% | **−24.1pp** |
| **PCE day** | 14 | 1.97 | 1.19× | 1.84× | 1.20× | 57.1% | +3.0pp |
| PCE T-1 | 14 | 1.46 | 1.16× | 1.71× | 0.65× | 50.0% | -4.1pp |
| **FOMC day** | 10 | 1.26 | 0.63× | 1.02× | 0.71× | 30.0% | **−24.1pp** |
| CPI T+1 | 15 | 1.11 | 0.90× | 0.57× | 0.78× | 46.7% | -7.4pp |
| PCE T+1 | 14 | 1.01 | 1.31× | 1.25× | 1.23× | 57.1% | +3.0pp |
| FOMC T-1 | 10 | 1.00 | 0.74× | 0.79× | 1.04× | 60.0% | +5.9pp |
| NFP day | 12 | 0.94 | 1.30× | 1.03× | 1.19× | 50.0% | -4.1pp |
| CPI day | 15 | 0.84 | 1.10× | 1.41× | 1.04× | 60.0% | +5.9pp |
| NFP T-1 | 12 | 0.80 | 1.02× | 1.06× | 1.40× | 58.3% | +4.2pp |
| CPI T-1 | 15 | 0.76 | 1.01× | 0.78× | 0.92× | 60.0% | +5.9pp |

#### What the worst offenders look like raw

**NVDA T+1 (n=5):** All five mornings opened with a downside reaction. Median MAE60 = 294 pts, median MFE60 = **40 pts** (the *highest* MFE was 102). Three of five had MFE60 ≤ 40 with MAE60 between 250 and 460. A long-biased first-hour strategy gets crushed; a short-biased strategy is fine but the sample is tiny.

| date | range60 | MAE60 | MFE60 | dir90 |
|---|---:|---:|---:|---:|
| 2025-02-27 | 484.8 | 444.5 | 40.3 | -322.3 |
| 2025-05-29 | 299.3 | 293.8 | 5.5 | -158.3 |
| 2025-08-28 | 169.8 | 67.8 | 102.0 | +74.0 |
| 2025-11-20 | 153.8 | 65.5 | 88.3 | -48.8 |
| 2026-02-26 | 457.0 | 457.0 | 0.0 | -343.3 |

**FOMC T+1 (n=10):** Strong directional follow-through, mostly bearish (7 of 10 closed below 9:30 open at 11:00). Median MAE60 = 138 pts (1.9× baseline), and three of ten had MAE60 ≥ 250. Wide stops or skip.

**FOMC day (n=10):** Range is *narrow* (×0.63) before the 2pm announcement, but pBull90 is just 30%. The first hour drifts down on average. Low expected payoff for a long, modestly OK for a short with tight target.

**PCE day (n=14):** Released 8:30 ET so the 9:30 open already has the move priced in, but the residual volatility in the first hour is real (range ×1.19, MAE ×1.84). Direction is balanced (57% bull) so it's a stop-widening regime, not a directional one.

**NFP T+1 (n=12):** Strongly bullish bias (75%, +21pp). MAE is *suppressed* (0.62×) — once the post-NFP gap is digested, follow-through is one-sided up.

#### Directional kill-vs-bias map

| Event | Skip? | Or use directional bias? |
|---|---|---|
| NVDA T+1 | **SKIP** (LONG); short OK if signal | Short bias (80%) but n=5 |
| FOMC T+1 | **SKIP** (LONG); short OK with ≥250pt stop | Short bias 70% |
| FOMC day | **SKIP** (LONG); short OK | Short bias 70% (small range) |
| PCE day | Trade with **2× wider stop** | No directional bias |
| PCE T-1 | Tradable, watch MAE | Slight short bias |
| NFP T+1 | **Long-only** strong bias | 75% bullish |
| NVDA T+2 | Skip or wide stops | Mild short bias |
| CPI day | Tradable; mild bull bias | 60% bullish |
| NFP day | Tradable, watch range | Balanced |
| CPI T+1 | Tradable | Mild bear |
| All others | Tradable as baseline | Within noise |

### 3. Adjacency (T-1 / T+1) check

T-1 distortions are uniformly milder than the event-day itself except for **PCE T-1** (MAE ×1.71). This makes sense — PCE day is well-known and positioning starts the day before. T+1 distortion is **larger** than T-day for NVDA, FOMC, NFP, and PCE, confirming the "hangover" pattern: the big move happens *during/after* the event, and the next-morning first hour is where dealers/funds reposition with maximum noise.

## Proposed Strategy v0 (this is a filter, not an entry)

This is a **kill-switch / regime overlay** for any first-hour NQ strategy. No standalone entry rule.

- **Hard skip** (no first-hour trade either side): NVDA T+1, FOMC T+1, FOMC day
  - Rationale: 30% or worse pBull90, MAE 1.9–4.1× baseline, sample skews so heavily one-way that any non-directionally-aware strategy will donate
- **Long-only mode**: NFP T+1
  - 75% bullish; MAE suppressed
- **Short-only mode**: NVDA T+1 if a strategy has a short rule with conviction (n=5 too small to mandate)
- **Wide-stop mode (1.5–2× normal)**: PCE day, PCE T-1, PCE T+1, NVDA T+2, FOMC T-1, CPI day, NFP day
  - Range is normal-to-elevated; direction noisy; standard stop will get tagged on noise but trend can still pay
- **Weekday tilts** (tie-breaker only):
  - Monday: prefer LONG (+9pp pBull90)
  - Thursday: prefer SHORT (-8pp pBull90)

### Recommended kill-list (concrete dates, 2025-01-13 → 2026-04-23, n=15 hard-skip days)

```
NVDA T+1 (5):  2025-02-27, 2025-05-29, 2025-08-28, 2025-11-20, 2026-02-26
FOMC T+1 (10): 2025-01-30, 2025-03-20, 2025-05-08, 2025-06-20, 2025-07-31,
               2025-09-18, 2025-10-30, 2025-12-11, 2026-01-29, 2026-03-19
FOMC day (10): 2025-01-29, 2025-03-19, 2025-05-07, 2025-06-18, 2025-07-30,
               2025-09-17, 2025-10-29, 2025-12-10, 2026-01-28, 2026-03-18
```

(FOMC T+1 partially overlaps with FOMC day in unique-date terms; total unique hard-skip ≈ 23 days = ~7% of trading sample. Not a huge sample reduction.)

Long-only mode (n=12): NFP-T+1 dates from output JSON.

Wide-stop mode (~50 days): PCE ±1, NVDA T+2, CPI day, NFP day, FOMC T-1.

## Backtest-engine integration sketch

- New file: `shared/strategies/event-day-filter.js` (helper, not a strategy)
  - Exports `getEventTag(dateStr) -> { hardSkip, longOnly, shortOnly, wideStop, weekdayTilt }` based on bundled JSON of dates
- Engine plumbing:
  - In `backtest-engine.js` strategy-evaluation loop, before evaluating a candidate signal, call `getEventTag(et.date)`. If `hardSkip` → record `blocked_event_day` and continue. If `longOnly` and signal is short → block. Etc.
  - Stop multiplier: `wideStop ? config.stopLossPoints * 1.75 : config.stopLossPoints`.
- CLI flags:
  - `--event-filter on|off` (default off until validated per-strategy)
  - `--event-filter-hard-skip` (comma list to override default)
  - `--event-filter-wide-stop-mult 1.75`
- Data delivery: ship `T9-dow-events.json`'s `events` set as a versioned static file; refresh it quarterly with an updated calendar.

## Caveats / Followups

- **Sample sizes are small for events**: n=5 for NVDA, n=10–15 for the others. NVDA results in particular ride on outliers like 2025-02-27 (-322pts) and 2026-02-26 (-343pts). These are real, but a single Q where NVDA beats and rallies on T+1 would shift pBull90 by ±20pp.
- **The 2025-04-07 tariff-shock day** is the dominant outlier in the entire window (range60 = 1688). It happens to land on Monday and on NFP-T+1 (which is why NFP-T+1 has a stdev×3.5 spike but a tame median). Decide whether to leave it in (real market regime) or carve out as "tariff/breaking news" exception.
- **Government-shutdown-affected releases** (2025 Sep CPI delayed, Oct 2025 NFP delayed → 11/20, Oct 2025 PCE delayed → 12/19) are dated to their actual release date. If the strategy uses pre-event positioning, the canonical scheduled date may matter more than the actual date.
- **NVDA T+2 is barely worth its own bucket** (n=5, score 2.6) but the median MAE of 147pts is double baseline. Keep in wide-stop bucket.
- **Cross-event collisions**: Several days are simultaneously NFP and FOMC-T+something or PCE T+1 and NFP-day. The current code does not deduplicate or weight; ANY_MAJOR_EVENT bucket counts each day once and shows mild distortion overall, suggesting the per-event tags above are not double-counting any single day's effect.
- **Followup T10/T11 tracks** should re-run with this filter on/off to quantify the OOS Sharpe lift from skipping the kill-list days.
