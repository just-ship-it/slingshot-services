# C1 — Census of price-derived S/R levels and higher-timeframe structure (NQ)

**Date:** 2026-07-17. **Data:** NQ primary-contract 1m 2021-01→2026-06 (1,319 usable
trading days; roll days and cross-symbol levels excluded), ES 1m 2021-01→2026-01
(generalization). Descriptive census only — no fills, no WR/PF; per KNOWABILITY.md
all levels activate only after their defining bars close (+60s), and all touch
outcomes are measured from the bar AFTER the touch bar.

**One-line verdict:** classic price-structure S/R levels on NQ are, as touch-response
objects at 1m resolution, statistically indistinguishable from random prices run
through identical machinery. The only deviations that survive both placebo classes
are (1) a stable bounce-DEFICIT at opening-range levels, (2) a prior-day
volume-POC bounce surplus that fails endpoint-year stability, and (3) a small
compression-box continuation effect. The famous conditioners (confluence,
multi-touch, "held once holds again", fast arrival at structure) are all placebo
artifacts, several of them *stronger at random prices than at real levels*.

---

## 1. Method

### Trading-day frame
td = 18:00 ET → 17:00 ET next day; minute-of-td `tmin` ∈ [0,1380): ON = [0,930),
RTH = [930,1320), late = [1320,1380). Symbol column is truth; roll days
(`roll_in_day` or >1 symbol) skipped entirely; any cross-day level requires the
same contract symbol on both sides.

### Level families (registry: `C1-levels-registry.csv`, 202,845 level-day rows)
| family | definition | active window | knowability |
|---|---|---|---|
| PDH/PDL/PDC/PDM | prior td RTH high/low/close/mid | whole td | prior 16:00 close |
| PDVWAP | prior td final RTH VWAP (Σv·tp/Σv, tp=(h+l+c)/3) | whole td | prior close |
| PDPOC / PDHVN | prior full-td volume-at-price POC + ≤2 HVN peaks (5pt bins, ≥25pts apart) | whole td | prior close |
| PWH/PWL | prior ISO-week session high/low | whole td | prior Fri close |
| ONH/ONL | current overnight (18:00–09:30) high/low | RTH only | 09:30 (+2m) |
| OPEN | RTH open price | 09:32–16:00 | 09:30 (+2m) |
| OR5/15/30 H/L | opening-range extremes | range end +60s → 16:00 | range completion |
| SW5/SW15/SW60 H/L | strict fractal swings on 5/15/60m aggregated bars, N=3/3/2 bars each side; **level exists only N agg-bars after the swing bar closes, +60s** (the classic fractal lookahead is handled here); dies on 1m close >15pts beyond, after 3 tds, or at symbol change | conf → death | confirm bar close |
| MT | multi-touch: 2pt price bin visited twice intraday with ≥25pt excursion between visits; born at 2nd visit; tested on the (k+1)th approach | birth+60s → td end | 2nd visit close |
| VWAP (dyn) | running RTH session VWAP, 2-bar lag | 09:40–16:00 | bar close +60s |
| RPOC (dyn) | running full-td volume POC, 2-bar lag | tmin≥120 | bar close +60s |

### Touch machinery (identical for real and both placebo classes)
Arm: price ≥25pts away on a given side. Touch: first bar entering within tol
∈ {2,5,10}pts (tol=5 primary). Re-touch requires re-arming. Outcomes from bar
i+1 onward: max penetration beyond level (`pen5..pen60`), max retrace against the
approach (`ret5..ret60`, = MFE against approach direction), `t_brk` = first minute
with pen>5pts, `t_r15`/`t_r35` = first minute with retrace ≥15/35pts.
**Primary metric `race15`** = P(15pt retrace happens before a 5pt break | one of
them happens within 60m). Also `race35` (35pt before 5pt, 120m window — the
sibling-calibration framing). Same-bar pierces (`pen0`>5, 11.6% of tol-5 touches)
are flagged; the held/broken analysis excludes them. Windows truncate at td end
(valid_min recorded); horizon stats require full windows.

### Placebos
1. **Random-offset**: every real level gets 3 seeded twins at ±U(30,120)pts
   (deterministic per level_id×seed), same activation windows. Twins that landed
   within 5pts of any active real level are excluded from placebo baselines
   ("clean"); the unfiltered baseline is also reported (differences are ≤1pp).
   Per-seed race15 = 0.507/0.508/0.506 — machinery is stable.
2. **Round-number grid**: 100pt multiples spanning each day's range, active all day.

Census: **3,195,359 touch rows** (914,390 real / 2,222,996 rand / 57,973 round)
in `C1-touches.csv.gz`. Scripts: `C1_common.py`, `C1-10-levels.py`,
`C1-20-touch-census.py`, `C1-30-analyze.py` (full tables: `out-C1-30.txt`),
`C1-40-patterns.py` (`out-C1-40.txt`), `C1-50-es.py` (`out-C1-50.log`).

---

## 2. Census facts that reframe everything downstream

**Structure is nearly dense.** Median 80 static real levels active at noon;
**80.8% of the RTH price range lies within 5pts of an active level** (median day);
75.6% of *random-offset placebo* touches sit within 5pts of real structure.
"Price is at a level" is therefore close to information-free on NQ — any
single-family level study without placebo controls will "work" by construction.

**Everything breaks and everything bounces.** At tol=5, P(pen>5pts within 60m)
≈ 0.83 and P(ret≥15pts within 60m) ≈ 0.83 for real AND placebo. The base
touch-response process is short-horizon two-sided churn, exactly as the
calibration warned.

**Pooled real-vs-placebo deltas are ~zero at every tolerance:**
tol=2: +0.007, tol=5: +0.005, tol=10: +0.008 (race15; n_real 262–342k per tol).
Round grid ≈ rand throughout.

**Drift/side artifact (methodology finding).** Placebo touches whose "bounce"
direction is UP resolve bounce-first at 0.512 vs 0.502 for down-bounces (NQ
2021–26 drift). Any family whose touches are structurally one-sided fakes an
edge this size. Concretely: swing lows showed +1.6 to +2.1pp at every tolerance,
6/6 positive years — and the entire effect vanishes (+0.002, yearly sign flips)
when compared side-matched against placebo, because real swing-low touches are
100% from-above while placebo twins mix sides. **Side-matched placebo comparison
is mandatory for one-sided level families.** Side-matched pooled delta across all
families: +0.0045.

---

## 3. Family / class results (tol=5, race15, clean rand placebo)

| class | n_real | real | rand | Δ | z | yearly Δ signs |
|---|---|---|---|---|---|---|
| PriorDay | 29,457 | .511 | .503 | **+.008** | 1.6 | **6/6 pos** (+.002…+.013) |
| PriorWeek | 2,309 | .525 | .520 | +.005 | 0.3 | 4/2 |
| Overnight | 4,546 | .514 | .516 | −.002 | −0.1 | 4/2 (ONH/ONL flip each other) |
| Opening | 19,064 | .502 | .526 | **−.024** | **−3.5** | **1/5 neg** |
| Swing | 93,857 | .512 | .503 | +.009 | 3.1 | 5/1 — **artifact, see §2 side-matching** |
| MultiTouch | 121,407 | .522 | .516 | +.005 | 2.0 | 5/1 — trivial size |
| DynVWAP | 16,358 | .444 | .437 | +.007 | 1.0 | 4/2 — dyn levels bounce less than static, both kinds |

Notable families:
- **PDPOC** (prior-day volume POC): +.038 (z=2.7), the largest positive.
  Survives side-matching (+.043 from above, +.032 from below) and all three
  tolerances (+.037/+.038/+.028). **Fails endpoint stability**: side-matched
  yearly Δ = −.010 (2021), +.066, +.085, +.062, +.026, **−.035 (2026)**.
  4/6 positive, sign inversion in the most recent year → not believable as a
  standalone edge under the charter's kill rule.
- **OR30H/OR30L**: −.053/−.059 (z≈−3), OPEN −.023; the Opening class deficit is
  robust across tolerances (−.011/−.024/−.011) and concentrated at fast arrival
  (arr5 Q4–5: −.050/−.056, z≈−3.2; yearly 1/5 neg). Real opening-range edges
  bounce *less* than random prices — they behave as continuation zones at 1m.
- PDH, PDL, PDC, PDVWAP, ONH, ONL, PWH, VWAP, RPOC, MT, SW60: all |Δ|≤.03 with
  yearly sign flips → indistinguishable from placebo.

## 4. The arr5 × structure interaction (the key commissioned test)

Arrival speed `arr5` = side×(touch-bar extreme − close 5m earlier)/1m-ATR14,
knowable at touch-bar close.

- **arr5 is a large, monotone, stable outcome conditioner**: race15 by quintile
  0.580 / 0.544 / 0.515 / 0.479 / 0.441 (slow→fast; same on ES 0.605→0.426).
  In this touch framing, FAST arrivals resolve break-first more often. (The
  sibling calibration's rising P(retrace) with arr5 was measured on fresh
  session extremes, not on approaches to pre-existing levels; both can be true —
  do not conflate the two event populations.)
- **The interaction with structure is absent.** Δ(real−rand) by quintile:
  −.002 / −.010 / −.004 / −.007 / +.006 (round placebo matches too). A fast
  arrival AT a structural level behaves exactly like a fast arrival at a random
  price. ES replicates the null (+.011/+.009/−.006/+.007/−.013).
- Only exceptions: Opening class (fast arrival at OR levels is MORE break-prone
  than placebo, −.05, consistent with §3), and a DynVWAP Q1 cell (+.121, z=9)
  that is a machinery artifact of offset dynamic series (placebo VWAP+offset has
  pen60 median 68pts vs 33 real — different touch geometry; yearly unstable) —
  do not chase it.

**Verdict: NO — arrival speed matters, structure does not, and they do not interact.**

## 5. Other commissioned interactions

- **Time of day / RTH vs ON**: all |Δ| ≤ .010. Nothing.
- **First vs later touch**: 3rd+ touches show +.021 vs rand (z=5.7) — but the
  ROUND placebo's 3rd+ touches show race15 0.550 vs real 0.511, i.e. the
  conditioning-on-many-touches effect is *bigger at round numbers than at real
  levels*. Touch count selects for chop zones; not a structure effect.
- **Level age**: Δ +.008 (2–8h), +.013 (8–24h), ~0 elsewhere. z≈4 at 8–24h but
  ≤1.3pp — noise-level economics.
- **Confluence**: real touches at 2+-family confluence bounce at 0.507 vs 0.514
  (1 other family) vs 0.489 (solo) vs 0.505 (placebo-solo baseline). Confluence
  adds nothing; solo real levels are if anything slightly worse. Yearly flat.
  (84% of real touches are themselves confluent — see density §2.)
- **Approach side**: Δ_a +.005, Δ_b +.004 side-matched — nothing beyond the
  drift artifact described in §2.
- **Held vs broken (extremes, same-bar pierces excluded)**: broken touches had
  slightly faster arrival (arr5 2.27 vs 2.39 held), higher touch index, deeper
  touch-bar penetration (pen0 −1.49 vs −2.50), younger levels, higher-vol regime
  — all z-significant on n=22.7k, all tiny (the best, pen0, is mechanical:
  touch bars that got closer to the level break more). No knowable-at-touch
  feature usefully separates hold from break.

## 6. Higher-timeframe pattern primitives

- **(a) Compression boxes** (8×15m-bar range below causal 15th pct of trailing
  30-day distribution; breakout = close beyond box ±2pts; control = identical
  machinery on 40–70th-pct boxes): follow-through positivity at 12 bars (3h)
  comp 0.492 vs ctrl 0.451; yearly Δ +(−.007)/+.071/+.038/+.066/+.031/+.052 =
  **5/6 positive**, n=2,542 comp events. Real but small — median 12-bar move is
  ≈0 pts (−0.5 comp vs −1.0 ctrl; ATR-normalized ~0.00) — i.e. compression
  breakouts *don't mean-revert* while ordinary box breaks do. Context-filter
  material at best.
- **(b) Springs / failed breakouts at C1 levels**: shallow (pierce ≤5pts, no
  break within 15m) → P(ret60≥35) real 0.555 vs rand 0.562; yearly flips. Deep
  (break >5 then re-enter ≤10m) → post-re-entry 60m traverse toward origin:
  real trav_pos 0.506 vs rand 0.511, medians ≈1pt, MFE≈MAE. **Spring behavior is
  generic 1m price action, fully present at random prices. Dead.**
- **(c) Double test** (2nd touch, 1st touch had not broken): real 0.540 vs 0.510
  for 1st touches (+3pp — looks like "a level that held once holds again") —
  but the placebo shows 0.603 vs 0.510 (+9pp). The effect is *selection*, not
  structure: surviving-to-a-second-armed-touch conditions on local mean
  reversion wherever the price is. **Dead, and a warning for all "respected
  level" heuristics.**

## 7. ES generalization (thresholds ×0.211 = ES/NQ ATR ratio)

248,894 touches, 1,211 days. Class deltas: PriorDay −.009, Overnight −.014,
Opening +.004, Swing +.007, DynVWAP −.012; yearly pooled Δ flips sign
(−.007/−.004/−.003/+.016/+.003/+.030). arr5 main effect replicates exactly;
interaction null replicates. **ES confirms the NQ null and kills any
NQ-specific-family excuse.**

---

## 8. Ranked shortlist (candidates for 1s follow-up)

1. **Opening-range bounce-deficit** (OR30/OPEN, fast-arrival flavored).
   Effect: −2.4pp pooled, −5pp at arr5 Q4–5, 5/6 years, robust at tol 2/5/10,
   n_real 19k. Interpretation: OR edges are continuation zones, not S/R.
   Proposed 1s follow-up: on fast approaches to OR30 extremes, measure
   1s-honest continuation economics (entry through the level, not fade) —
   distinct from the known-dead ON-break follow-through family, but overlap
   must be checked first. This is the only effect that is simultaneously
   placebo-clean, tolerance-robust, and year-stable.
2. **PDPOC bounce surplus** — +3.5pp both sides, tolerance-robust, but sign
   inverts in 2021 and 2026. Park unless some independent study needs a
   PriorDay conditioner; re-test on 2026H2 data before any investment.
3. **Compression-box breakout persistence** — 5/6 years, +4pp directionality,
   near-zero point magnitude. Context filter only; never standalone.

Consistent-but-unusable: PriorDay class +0.8pp with 6/6 positive years (a real,
microscopic structure effect — the honest size of "prior-day levels work").

## 9. Dead list (explicit)

- ONH/ONL, PDH/PDL/PDC/PDM, PDVWAP, PWH/PWL, OPEN (as S/R), OR5/OR15 as S/R,
  session VWAP, running POC, PDHVN, multi-touch levels, SW5/SW15/SW60 fractal
  swings (side-matching artifact), round numbers (≡ placebo).
- Confluence (2+ families ≤5pts): no additive effect vs matched solo or placebo.
- arr5 × structure interaction: null on NQ and ES.
- First-vs-later touch, level age, time-of-day, RTH/ON, approach side: no
  placebo-clearing effect anywhere.
- Springs (shallow and deep), double-test/"respected level" conditioning.
- Held-vs-broken discrimination from knowable-at-touch features.

## 10. Caveats
- 1m resolution: touch ordering inside the touch bar is unknowable (11.6%
  same-bar pierces flagged); any surviving candidate must be re-derived on 1s.
- Arming requires a ≥25pt excursion *within the level's active window*; first
  approaches that never left the band are not counted (identical for placebos).
- Placebo offsets (±30–120pts) stay in the same volatility neighborhood by
  construction; they do not control for "distance from current price" effects
  beyond that band.
- Forward windows truncate at 17:00 ET (valid_min filters applied).
