# JV-ICT Confluence Stacking — Spatial Confluence Census (2026-07-23)

**Question (final untested hypothesis of the program):** Drew reports the source trader never took a trade on one signal alone — he required 2-3+ independent things aligning NEAR THE SAME PRICE LEVEL (book p8: fib + OB + IMB + weekly open = "A+ setup"). Prior rounds only tested pairwise gates. Does the number of independent levels/states aligning with the entry price ("confluence count") produce a dose-response in outcome quality over the 3,600-signal universe?

**Verdict up front: NO — confluence stacking does not rescue the universe.** The pre-registered primary test FAILS (expectancy is not monotone in confluence count; the top bin turns DOWN), the +20-before-−20 race win rate *decreases* with count (52.6% → 45.3%), the per-year profile sign-flips (2021 is *anti*-monotone, 2022 monotone, 2023/2024 shapeless), and a hindsight oracle restricted to confluence≥3 trades lands at the **28th percentile** of the placebo-null distribution — random days with randomly assigned counts offer more. High counts are also partly a bookkeeping artifact: on Monday-session signals the "independent" levels collapse (daily open = weekly open, PDH = prior-week high).

---

## 1. Method

### Causal tagger (`09-confluence-tagger.py` → `confluence-tags.csv`)

One chronological replay of `NQ_ohlcv_1m_continuous.csv` from file start (2020-12-27, pre-dev warmup — strictly past data) through 2024-12-31 (**nothing at/after 2025-01-01 is ever read**), aggregated to closed 15m bars (epoch-floor buckets ≡ `CandleAggregator` under the whole-hour-offset host TZ). For each of the 3,600 captured signals, the feature set is snapshotted at the signal's decision time (the MSS 15m close = `signal.ts`), using only bars closed at/before that instant.

Features relative to ENTRY PRICE. Proximity band: **primary = max(15 pts, 0.1% × entry)** (binds at 0.1% for all of 2021-2024 continuous prices, 15.0-21.9 pts); 0.5x and 2x computed as robustness checks of the same hypothesis, not a search space.

| # | feature | source | counted? |
|---|---|---|---|
| 1 | `fib_band` — entry inside 50-79% band | metadata | baseline only (it IS the entry definition; true 3599/3600, 1 tick-rounding miss) |
| 2 | `imb_overlap` — IMB zone overlaps fib band | metadata | ✓ |
| 3 | `ob_overlap` — OB overlaps fib band | metadata | ✓ |
| 4 | `pdh_pdl` — prev-day H or L within band | metadata (engine-computed) | ✓ |
| 5 | `daily_open` — 18:00-ET session open within band | metadata (engine-computed) | ✓ |
| 6 | `weekly_open` — trading week's open (Sun 18:00 ET) within band | replay | ✓ |
| 7 | `monthly_open` — month's first-session open within band | replay | ✓ |
| 8 | `prev_week_hl` — prior completed week's H or L within band | replay | ✓ |
| 9 | `htf_align` — causal 1H structure (exact port of jv-ict.js `_processClosedHtfBar`: pivotN=2 lag-confirmed fractals, close-confirmed breaks) agrees with side | replay | ✓ |
| 10 | `smt` — ES divergence at the final sweep push (exact port of `smtMode` logic; ES 1m continuous deduped → UTC-aligned 15m, per-bar sweep info looked up at `sweep_extreme_ts`) | replay | ✓ |

`confluence_count` = sum of #2-#10 (0-9). Day/week/month keying uses the 18:00 ET Globex boundary exactly as `jv-ict.js _tradingDayInfo`; opens from partial first periods are untrusted (null → feature false). Coverage: SMT unavailable for 81/3600 (ES series starts 2021-01-26); 1H structure defined for all (warmup from 2020-12-27).

### Causality verification

- **Replay vs engine, full census:** replayed `daily_open`/`pdh`/`pdl` match the engine's own captured metadata on **0 mismatches / 3,599-3,596 comparable signals** — the replayed 15m stream is bar-identical to what the engine saw.
- **3 signals hand-audited from raw 1m rows** (independent inline logic): weekly open, monthly open, prev-week H/L all exact, and every source bar's timestamp strictly precedes the signal (worked example §6).
- **3 independent 1H-structure re-derivations** (fresh code, 60-90d warmup): 3/3 match.
- **3 independent ES-SMT re-derivations**: 3/3 match (consistent with Round 3's 5/5 engine verification).

### Outcomes

Joined 1:1 (signal_ts + side; entry prices re-checked equal) to the already-simulated 1s-honest outcomes in `mfe-mae-universe.csv` (no re-simulation). Primary population = 1,390 fills; outcome = 16:00-ET-hold PnL (no management), plus the +20-before-−20 first-passage race and median MFE:MAE.

---

## 2. Count distribution

| count | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| all 3,600 | 78 | 521 | 977 | 1,017 | 635 | 272 | 77 | 18 | 5 |
| filled 1,390 | 30 | 217 | 376 | 392 | 240 | 100 | 28 | 4 | 3 |

Median count 3 — by the book's own bar ("2-3+ things aligning"), **most mechanical signals already qualify**, which is itself informative: spatial confluence is cheap around a 70.5% retracement of a 15m impulse leg, because opens/prior extremes cluster where price recently traded.

- **Fill rate is flat-to-declining in count**: 41.2% (0-1) → 38.5% (2) → 38.5% (3) → 37.2% (≥4). No differential-fill story.
- **Counts are stable across years** (mean 2.57-2.87) — no regime drift in the tagger.
- **High counts are partly double-counting**: among count≥6 signals, 57% sit in Sun/Mon ET sessions, 52% have daily open == weekly open (same bar), 65% have both opens inside the band, 27% have both PDH/PDL and prev-week H/L hit (Friday's high IS the prior-week high on Mondays). The features are not independent where it matters most.

## 3. PRIMARY TEST — dose-response (pre-registered): **FAIL**

Filled trades, primary band, 16:00-hold expectancy by bin. (Per-bin SD ≈ 146-166 pts → SE ≈ 7.5-9.4 pts; every bin-to-bin difference is ≲ 2 SE.)

| bin | n | exp (pts/tr) | med | WR +20-before-−20 | med MFE:MAE |
|---|---|---|---|---|---|
| 0-1 | 247 | **−13.51** | −3.00 | 0.526 | 1.27 |
| 2 | 376 | **+1.54** | +6.12 | 0.519 | 1.16 |
| 3 | 392 | **+4.27** | −3.12 | 0.497 | 1.03 |
| ≥4 | 375 | **−1.46** | +2.75 | 0.453 | 1.04 |

**Not monotone — the ≥4 bin turns down → PRIMARY TEST FAIL; the hypothesis is refuted at the primary band.** Note the two secondary outcome measures point the *wrong way with dose*: the ±20 first-passage race falls from 52.6% to 45.3% and median MFE:MAE from 1.27 to 1.04 as confluence rises. If anything, more levels near the entry = slightly worse short-horizon odds (crowded price regions revisit both sides).

### Per-year (a real discretionary filter should hold in 2024)

| bin | 2021 exp (n) | 2022 exp (n) | 2023 exp (n) | 2024 exp (n) |
|---|---|---|---|---|
| 0-1 | **+29.46** (57) | −46.02 (76) | +5.86 (61) | −35.39 (53) |
| 2 | +22.13 (96) | −11.46 (83) | −12.75 (97) | +6.43 (100) |
| 3 | −12.24 (93) | +12.94 (104) | +8.73 (114) | +5.82 (81) |
| ≥4 | **−15.99** (107) | **+16.77** (71) | −6.72 (96) | +6.12 (101) |

Sign-flip chaos: **2021 is cleanly ANTI-monotone** (low confluence best, +29.5 → −16.0), **2022 is cleanly monotone** (−46.0 → +16.8), 2023 zig-zags, 2024 is flat across 2/3/≥4 (+6.4/+5.8/+6.1 ≈ the year's long-drift) with only the small 0-1 cell negative. Yearly inversion of this magnitude is the signature of noise, not of a filter the source trader could have been relying on every week.

### Robustness bands (same hypothesis, not a search)

- **0.5x band:** not monotone (−5.4 / −6.3 / +4.2 / +5.5).
- **2x band:** nominally monotone (−8.4 / −5.1 / −1.3 / +2.1) but the full sweep is ~10.5 pts ≈ 1 SE, and WR20 *still declines* with count (0.570 → 0.461). Per pre-registration, the primary-band failure refutes the hypothesis regardless; the 2x ordering is what two adjacent noise draws look like.

## 4. Secondary (descriptive only — 9 features, multiplicity applies)

Per-feature marginal expectancy delta (present − absent), filled trades:

| feature | on n | exp on | off n | exp off | delta |
|---|---|---|---|---|---|
| imb_overlap | 504 | +17.03 | 886 | −11.52 | **+28.55** |
| monthly_open | 57 | +7.98 | 1,333 | −1.56 | +9.54 (n<60) |
| htf_align | 574 | +2.43 | 816 | −3.70 | +6.13 |
| ob_overlap | 758 | +0.05 | 632 | −2.64 | +2.69 |
| weekly_open | 119 | −4.41 | 1,271 | −0.87 | −3.54 |
| smt (divergence) | 906 | −2.60 | 484 | +1.50 | −4.10 |
| daily_open | 471 | −6.94 | 919 | +1.79 | −8.73 |
| prev_week_hl | 89 | −10.07 | 1,301 | −0.56 | −9.50 |
| pdh_pdl | 347 | −13.29 | 1,043 | +2.86 | **−16.15** |

The only large positive is IMB (+28.5) — the same tag already recorded in 08 §4 and **already killed in Round 3** (the IMB-gated config loses to placebo in 2024; its oracle lift was placebo-equivalent-selected-max). Everything else is ±16 pts on SEs of ~8-17 — and note the *book's own headline levels* (PDH/PDL, daily open, prev-week H/L) all carry **negative** point estimates. There is no coherent "levels help" story here; there is a familiar "IMB whisper plus noise" story.

Side split: no rescue. Buys are best at count 2 (+19.1) not ≥4 (+5.5); sells are negative in 3 of 4 bins including ≥4 (−7.8). The overall buy-positive/sell-negative drift split of 08 §3 persists unmodified within every bin.

## 5. Oracle re-check — does confluence≥3 help perfect hindsight selection? **No.**

Same oracle-1/day machinery as 08 §5 (hold model, 0.7 pts friction), picker restricted to trades with count≥3. Null = the five seed-matched placebo universes' fills, each given 40 independent random count assignments drawn i.i.d. from the real filled-count distribution, restricted and oracled identically (200 null oracles).

| | total pts 2021-24 | days | pts/fill-day |
|---|---|---|---|
| real, unrestricted (08) | 30,574 | 727 | 42.1 |
| **real, count≥3 only** | **13,071** | 497 | **26.3** |
| placebo null min / median / max | 6,984 / 15,217 / 23,956 | — | 13.2 / 29.6 / 44.0 |
| **real percentile in null** | **0.28** | — | **0.32** |

Restricting the (already placebo-equivalent) oracle to high-confluence trades leaves it **below the median of the randomly-tagged placebo null** on both totals and per-day. Per-year real cc≥3 oracle: 573 / 6,676 / 2,179 / 3,643 pts — 2021, the year the unrestricted oracle earned 7.7k, collapses to ~0.6k under the confluence restriction (consistent with 2021's anti-monotone table). Confluence does not tell even a clairvoyant picker which days to work.

## 6. Worked example — a maximum-confluence signal (count 8 of 9)

**BUY limit 18378.50, emitted 2021-08-29T23:45:00Z** (Sunday 19:45 ET → Monday trading day; continuous price space). Band = 18.38 pts. Aligning at signal time:

| feature | level | distance from entry |
|---|---|---|
| fib band (baseline) | 18,375.72 - 18,385.00 | inside |
| imb_overlap | IMB zone overlaps band | ✓ (metadata) |
| ob_overlap | OB overlaps band | ✓ (metadata) |
| pdh_pdl | PDH 18,389.75 (Friday's high) | 11.25 ✓ |
| daily_open | 18,378.75 (Sun 18:00 ET open) | 0.25 ✓ |
| weekly_open | 18,378.75 (same bar as daily open) | 0.25 ✓ |
| monthly_open | 17,918.75 | 459.75 ✗ (only miss) |
| prev_week_hl | prior-week high 18,389.75 (= Friday's high = PDH) | 11.25 ✓ |
| htf_align | 1H structure bullish, buy | ✓ |
| smt | ES did not sweep its own low at the final push bar (2021-08-27T20:00Z, Friday close area; MSS confirmed Sunday) | divergent ✓ |

This is the "A+ setup" of the book rendered literally — sweep, MSS, fib+OB+IMB, weekly open, PDH, HTF alignment, SMT divergence, all within a ~18-pt window. It filled and made **+166.75 pts**. The catch: (a) note the double-counting — daily open ≡ weekly open and PDH ≡ prev-week high, so "8 confluences" is really ~5 distinct objects; (b) **the very next session** (2021-08-30T11:45Z) produced a count-7 SELL at 18,396.75 against the same level cluster, which lost **−148.50** — the cluster giveth and the cluster taketh away, which is exactly what the bin tables say in aggregate (count ≥4 expectancy −1.5 pts).

## 7. Bottom line

**Does confluence stacking rescue the universe? No.** (Not even "partially": the only nominally-positive slice — 2x-band monotonicity — is ≈1 SE wide, contradicted by its own declining race-WR, and pre-registration binds us to the primary-band FAIL.)

1. **Dose-response fails where it must.** Expectancy is non-monotone at the primary and half bands; the top bin is negative; the first-passage race and MFE:MAE *worsen* with confluence.
2. **No year-stability.** 2021 anti-monotone vs 2022 monotone is a coin whose faces alternate by year; 2024 shows no separation among counts 2-≥4.
3. **Perfect hindsight still can't use it.** The count≥3-restricted oracle sits at the 28th-32nd percentile of the randomly-tagged placebo null — high-confluence days are, if anything, below-average selection pools.
4. **"Confluence" is partially self-similar.** The highest counts concentrate on Monday sessions where daily open = weekly open and PDH = prior-week high; the census counts a level *cluster*, and price near a cluster resolves both directions with coin-flip odds (§3 race table).

This closes the confluence-stacking hypothesis and, with it, the last untested mechanical ingredient of the jv-ict program. Combined with 08 ("no selection function over the universe can survive"), the program verdict stands unchanged: whatever the source trader's edge was, it is not expressible as any function — pairwise, stacked, or hindsight-optimal — of the setups plus the level/structure vocabulary the book teaches. The reopening conditions of 07-PROGRAM-SUMMARY (his actual taken trades, live selection commentary) remain the only paths worth resources.

**Files:** tagger `09-confluence-tagger.py` (13s runtime; verification report printed inline), tags `confluence-tags.csv` (3,600 rows: features + counts at 3 bands + raw levels), analysis `09b-confluence-analysis.py` (all tables above), outcomes joined from `mfe-mae-universe.csv` / null from `mfe-mae-placebo.csv` (unmodified).
