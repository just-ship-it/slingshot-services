# R1 — Reverse-engineering NQ intraday rejection levels from options-market state

Greenfield study, 2026-07-16/17. Charter: `GREENFIELD.md`; contract: `KNOWABILITY.md`.

**Hypothesis under test (owner):** dealer hedging responds to more than net gamma;
if this morning's rejection level can be explained from options-market features,
the same recipe may predict this afternoon's (or this week's) levels.

**Verdict: decisive NULL on the hypothesis.** No options-market feature marks
which prices become rejection levels (2023–2026, honest broken-extreme control);
GEX proximity doesn't either; morning levels do not transfer to the afternoon or
the week. One survivor, and it is a touch-moment STATE feature, not a level
recipe: fast arrival + locally elevated 0DTE IV at the strike → extreme far more
likely to hold; the bulk of it is pure price-action arrival speed. Details in
Conclusions.

---

## Phase 1 — Labels (ex-post by design; labels are the target, not features)

Scripts: `R1-01-labels.py` (events + levels + controls), `R1-02-map-ratio.py`
(strike mapping). Data: `cache_nq_primary_1m.csv` (primary-contract 1m, no
cross-symbol spans; days with <120 RTH bars skipped; all windows stay inside the
day's dominant RTH contract).

Definitions (RTH, touch 09:30–15:00 ET so the 60m forward window is complete):

- **Candidate touch** — bar whose high/low is the most extreme of the trailing
  30 minutes (context includes overnight bars).
- **REJECTED@X** (X ∈ {30, 35, 50}, main = 35): reversal ≥ X pts occurs strictly
  before penetration beyond the extreme ever exceeds 8 pts, within 60m.
- **BROKEN**: penetration > 20 pts occurs strictly before a 35-pt reversal.
  1m same-bar ties are unresolvable and fall out of both classes.
- **Clustering**: same day + direction + class, prices within 5 pts → one level
  (first touch time kept, touches counted).
- **Controls**: `placebo` = 2 per rejection level at level ± U(40,120) pts, same
  touch timestamp; `round` = multiples of 100 touched that day (±2 pts), ≥10 pts
  from any real level.

### Label census (levels, after clustering)

| year | rejected | rejected30only | broken | placebo | round |
|------|----------|----------------|--------|---------|-------|
| 2020 (stub) | 12 | 4 | 16 | 24 | 1 |
| 2021 | 1856 | 133 | 2677 | 3712 | 51 |
| 2022 | 2949 | 79 | 4130 | 5898 | 67 |
| 2023 | 1945 | 83 | 2933 | 3890 | 45 |
| 2024 | 2370 | 101 | 3502 | 4740 | 74 |
| 2025 | 3112 | 108 | 3871 | 6224 | 119 |
| 2026 (H1) | 1634 | 31 | 1960 | 3268 | 89 |

Time-of-day of first touch (rejected levels): 09:xx 3360, 10:xx 2999, 11:xx 2299,
12:xx 1832, 13:xx 1683, 14:xx 1654, 15:00 51 — monotone decay through the day
(mechanical: earlier touches have more day left to form 30m extremes, plus the
open is the volatility peak).

Spot-checks (3 rejected + 3 broken re-walked from the raw cache) confirmed the
class rules; note a rejected level may still break LATER in its 60m window after
the ≥35 reversal completes (it still rejected first).

Caveat: on trend days successive 30m extremes each become candidates and mostly
break → the broken class over-represents trend days. All feature contrasts are
therefore also run day-matched (rejected vs broken on the same day; R1-08 f).

## NQ → QQQ strike mapping (Phase 2 prerequisite)

`R1-02-map-ratio.py`: ratio = NQ close / QQQ close of the last minute bar fully
closed before the touch (bar stamped T−1 for a touch during bar T → knowable
at the touch). Mapped price = level / ratio.

**Mapping validation** (1372 days): intraday RTH ratio drift open→close, in bps:
mean +0.5, median +0.2, p5 −2.1, p95 +2.6; intraday rel-std median 0.5 bps,
max 48.5. One QQQ $1 strike ≈ 26 bps ⇒ a same-morning ratio identifies the
strike with ~0.02–0.1 strike error all day. The futures basis moves far too
slowly intraday to matter. Mapping is safe.

61,412 of 61,708 level/control rows mapped (296 missing QQQ bar overlap).

## Phase 2 — Feature panel and knowability

| feature family | source | knowable at touch? | live-sourceable? |
|---|---|---|---|
| OI at mapped strike (tot/put/call/0DTE/weekly), OI percentile vs ±3% neighbors, concentration ±$5, dist to max-OI strike, dist to max-pain, prior-day option volume | `data/statistics/qqq` stat_type 9 (OI) & 6 (prior-day cleared volume); received 05:30–06:30 ET same day (verified), values are PRIOR session | yes (pre-open) | YES (broker chains: OI + prior volume) |
| dist of mapped price to nearest strike | arithmetic | yes | YES |
| quote state at touch: put/call spread, rel-spread, size imbalance, depth, depth vs neighbors, Δspread over 30m, BS IV at strike, put−call IV gap, IV kink vs neighbor strikes (0DTE) | `data/cbbo-1m/qqq`, rows used only with interval-END ts_recv ≤ touch | yes | PARTIAL (Schwab chains, coarser refresh) |
| same-morning traded options volume near strike before touch | `data/options-trades/qqq` (2025) | yes | **NO — flagged, cannot deploy** |
| GEX baseline: distance from level to nearest causal GEX level/wall, within-25pt flag, total GEX, regime | `data/gex/nq` (causal), as-of join at-or-before touch | yes | YES |

Scripts: `R1-03-oi-cache.py` (65GB statistics -> per-day strike OI/vol cache,
1.89M rows, 2023-03→2026-06), `R1-04-features-oi.py` (join + GEX baseline),
`R1-06-features-cbbo.py` (0DTE quote panel 2025-01→2026-06),
`R1-07-features-trades.py` (trade tape, FLAGGED non-deployable),
`R1-05-contrast.py` + `R1-08-hunt.py` (analysis).

Analysis universe (levels mapped + OI coverage): 2023: 1,387 rej / 2,181 brk;
2024: 2,363 / 3,494; 2025: 3,094 / 3,845; 2026H1: 1,621 / 1,933 (+ placebo 16,930,
round 313). Which comparisons use which control: **rejected-vs-BROKEN is the
honest test** (both classes are 30m local extremes; one held, one didn't);
rejected-vs-placebo is reported to expose "price is at a local extreme"
mechanical separators, NOT as evidence of a rejection recipe.

### OI / prior-day-volume panel (full 2023-03→2026-06) — R1-05, out-R1-05.txt

AUC (rejected vs broken), per year 2023/2024/2025/2026, pooled:

| feature | 23 | 24 | 25 | 26 | pooled | verdict |
|---|---|---|---|---|---|---|
| dist_to_strike | .502 | .502 | .500 | .495 | .500 | dead |
| oi_tot | .496 | .488 | .484 | .510 | .483 | dead (sign flips) |
| oi_put / oi_call / oi_dir | ~.49 | ~.49 | ~.48 | ~.50 | .48–.49 | dead |
| oi_0dte, oi_wk, oi_pctile, oi0_pctile | .48–.52 all years | | | | ~.49 | dead |
| oi_conc5 (±$5 concentration) | .500 | .490 | .485 | .497 | .489 | dead |
| oi_pcr | .501 | .510 | .518 | .510 | .513 | noise-level |
| oi_0dte_share | .509 | .505 | .514 | .514 | .516 | consistent sign but ~1.5pp; too small |
| dist_maxoi | .496 | .503 | .493 | .491 | .501 | dead |
| dist_maxpain | .497 | .515 | .513 | .486 | .514 | sign flips; dead |
| **prevvol** | **.462** | **.465** | **.449** | **.447** | **.461** | stable INVERTED signal (see below) |
| **vol_pctile** | **.473** | **.469** | **.450** | **.456** | **.462** | same |
| gex_min_dist (BASELINE) | .496 | .512 | .499 | .535 | .519 | GEX proximity does NOT separate |
| gex_within25 (BASELINE) | .506 | .490 | .501 | .487 | .491 | dead |
| gex_cw_dist / gex_pw_dist / gex_total | .48–.52 | | | | ~.51 | dead |

vs placebo, the only separators are prevvol/vol_pctile (~.60) — i.e., high
prior-day option volume marks strikes where price forms local extremes AT ALL
(both classes), the predicted mechanical confound, not a hold-vs-break signal.

### Deeper hunt (R1-08, out-R1-08.txt) — all null

- **Sharpened labels** (rej50 vs clean-break max_rev<10, n=6271/4907): all
  features .47–.53, no stable separator.
- **Direction split** (upper/lower) and **morning/afternoon**: same picture.
- **GEX slices** (within 25pt of a GEX level or not): same picture inside both.
- **Day-matched sign test** (same-day rejected vs broken mean, 806 days):
  everything .47–.55 except prevvol .29 / vol_pctile .35 (the inverted signal).
- **Decile lift** (base P(rejected)=.425 in rej+brk universe): only
  vol_pctile top decile passes |lift|>.04: P(rej)=.377, per-year lift
  −.032/−.050/−.066/−.034 — stable sign, 4 years.

### The one stable (but inverted, tiny) finding

Strikes with HIGH prior-day options volume are ~4–7pp MORE likely to BREAK when
touched, per-year stable 2023–2026 (AUC .45–.47 vs broken; day-matched share
.29–.35). This is the opposite of "dealer hedging defends busy strikes." Likely
mechanics: high prior-day volume strikes sit near the prior session's
high-activity zone; touches there occur in continuation moves that break 30m
extremes. Effect size is far too small to build on (5pp on a 42.5% base), and it
explains breaks, not rejections. Recorded as an anti-signal, not a recipe.

### GEX baseline verdict

Causal net-GEX proximity (nearest level/wall distance, within-25pt flag, regime,
total GEX) does NOT separate held from broken extremes in any year (.49–.52).
The owner's suspicion that "GEX alone is too narrow" is half-right: GEX explains
nothing here — but nothing else in the options state beats it, because nothing
separates.

### Options trade-tape panel (FLAGGED non-deployable; 2-week prototype only)

`R1-07-features-trades.py`, 2025-03-03→03-14 (n≈200 rejected): raw pre-touch
volumes show AUC .41–.44 vs broken, but the time-controlled neighbor ratio
(tvol_ratio_nb) is .494 — the raw effect is the cumulative-volume-by-touch-time
confound (later touches have more tape behind them), nothing level-specific.
Given the OI/quote nulls and the no-live-source constraint, the full-year pass
was not spent.

## Phase 3 — Transfer / forward tests

Phase 2 found no stable separator in the hypothesized direction, so the frozen-
recipe forward test per spec was NOT justified. What was run instead:

**Within-day price-memory transfer (R1-09)** — the owner's premise in its purest
form, no options features: morning (<12:00 ET) rejection levels, afternoon
(12:00–14:30 touch) respect vs distance-matched placebo (signed distances
resampled from other days' morning-rejection levels, ±25% magnitude, same side
of 12:00 spot; identical touch/outcome machinery):

| year | real touched / resp20 / resp35 / broken | placebo |
|---|---|---|
| 2021 | 520 / .327 / .254 / .500 | 1568 / .327 / .243 / .489 |
| 2022 | 910 / .311 / .253 / .580 | 2802 / .311 / .257 / .586 |
| 2023 | 586 / .350 / .256 / .503 | 1781 / .340 / .243 / .504 |
| 2024 | 704 / .342 / .274 / .531 | 2114 / .345 / .266 / .535 |
| 2025 | 917 / .338 / .284 / .565 | 2793 / .325 / .267 / .578 |
| 2026 | 474 / .359 / .297 / .561 | 1451 / .334 / .284 / .568 |
| ALL | 4114 / **.335** / .269 / .545 | 12518 / **.329** / .260 / .550 |

+0.6pp pooled, inside noise every year. **A morning rejection price carries no
afternoon information beyond its distance from spot.**

**Within-week transfer (R1-10)** — day-D rejected levels touched on later days
of the same ISO week vs the same placebo construction (spot = touch-day 09:30):
ALL real 9562 touches / resp20 .302 / broken .624 vs placebo 29372 / .306 /
.619. Null in every year (2021–2026). No week-scale memory either.

**Forward test of the inverted prevvol signal (R1-11)** — recipe frozen at
09:31 ET (spot, ratio, same-day pre-open statistics file): top-decile prior-day
volume strikes vs mid-vol strikes matched by side and distance-from-spot;
prediction "flagged break more when touched >=09:35". Pooled 2023–2026:
flag n=151 touched, resp20 .278, broken .629; ctrl n=123, .309, .618.
Direction agrees, magnitude ~1–3pp on tiny n — not remotely actionable.

## Quote-state panel (cbbo-1m, 2025-01→2026-06) — out-R1-05-cbbo.txt

n = 4.7k rejected / 5.8k broken (2 years only — below the charter's multi-year
stability bar; treat as provisional). AUC vs broken: spreads .53–.54, depth_ratio
.53, iv_put/iv_call .54 (consistent sign both years); imbalance, iv_gap, iv_kink,
dspread_otm ≈ .50 dead. vs placebo, rel-spreads at .35 are the moneyness
mechanical (placebo strikes are farther OTM), not signal. cbbo-1m is a 1-minute
snapshot series, so quote-update intensity is not measurable from it (constant).

### The only live finding: touch-moment vol state, mostly price-action in disguise

Chasing the IV effect (all sign tests on same-day rejected-vs-broken means):

| matching | iv_put share of days/cells > .5 |
|---|---|
| day | .693 (n=361 days) |
| day + hour | .621 (n=1487 cells) |
| day + hour + arrival-speed terciles | .590 (n=1627) |
| day + hour + arrival-speed quintiles | **.572 (n=1172, se .015)** |
| (reverse: speed within day+hour+IV-quintiles) | **.633 (n=1016)** |

Day+hour z-scored top-decile lifts (P(rejected), base ≈ .41):
iv_put → **.687** (2025 .698 / 2026 .666); iv_call → .668;
pure NQ arrival speed (|Δclose| over 10m before touch) → **.649** (.642/.661);
iv_put within low/mid-speed events only → .548 vs base .351.

Reading: extremes reached FAST, at moments when 0DTE IV at the touched strike is
locally elevated, hold much more often. The bulk of this is ARRIVAL SPEED — a
pure price-action feature needing no options data. A small residual
options-vol component survives full matching (share .572, ~5σ) — the options
market appears to reprice slightly ahead of / beyond the trailing-10m price move.
Crucially: **this is a state-at-touch timing feature, not a level-marking
recipe** — it says nothing about WHICH price will be a level, only about the
regime at the moment any extreme is touched. It cannot generate afternoon level
forecasts from morning structure (that was tested directly and is null).

## Conclusions (ranked)

1. **DEAD — the core hypothesis.** Nothing in the options market's morning or
   at-touch structure marks WHICH prices become strong rejection levels:
   OI level/percentile/concentration, put-call composition, 0DTE/weekly mix,
   dist-to-strike, max-OI, max-pain, spreads, depth, quote imbalance, IV kinks,
   put-call IV gap — all AUC .47–.53 vs broken extremes, no year-stable
   separator in the hypothesized direction (2023–2026 for OI panel).
2. **DEAD — GEX baseline.** Causal net-GEX proximity does not separate held
   from broken extremes in any year (.49–.52). Nothing "beats" GEX because
   neither GEX nor anything else separates.
3. **DEAD — the transfer premise.** Morning rejection levels are NOT respected
   in the afternoon (+0.6pp vs distance-matched placebo, 6/6 years null), nor
   later in the week (−0.4pp, null). The "same hedging algos react the same way
   later" mechanism has no footprint at the level-price scale.
4. **Anti-signal (stable, tiny, not actionable).** High prior-day option volume
   at a strike ⇒ level slightly MORE likely to break (AUC .45–.47 all 4 years;
   forward-tested 09:31-frozen recipe agrees in direction at +1–3pp on n=151 —
   too small to use).
5. **ALIVE (small, state-not-level).** Touch-moment vol state: fast arrival +
   locally elevated 0DTE IV at the strike ⇒ extreme holds far more often
   (top-decile lift +23–28pp on a 41% base, consistent 2025/2026). Majority
   component is arrival speed = pure price action (live-sourceable trivially);
   options-IV increment beyond speed is real but small (share .57 post-matching)
   and only 1.5y of data. If anything from R1 deserves a follow-up under the
   survival bar, it is arrival-speed-conditioned continuation/reversal at fresh
   extremes — an R2-shaped question, NOT an options-structure question.

### Dead list (do not re-run)

- OI-at-strike features (all variants, incl. directional put/call, percentiles,
  concentration, 0DTE share as level-marker) — 4-year null vs broken.
- Max-pain / max-OI distance features — sign-flips across years.
- dist-to-strike ("levels sit on strikes") — exactly .50 everywhere.
- GEX-level proximity as hold-vs-break separator — null all years.
- Quote imbalance / depth / spread-change / IV-kink / IV put-call gap at the
  strike as level-markers — null (2025–2026).
- Same-day pre-touch options tape volume (flagged non-deployable anyway) — the
  raw effect is a touch-time artifact; neighbor-controlled version null.
- Morning→afternoon and day→same-week level-price transfer — null 6/6 years.
- Round-number grid as rejection candidates — nothing distinctive in options
  features at round numbers (control class, R1-features.csv).

### Live-sourceability of the survivor

- Arrival speed: NQ 1m closes — live via TradingView feed. YES.
- 0DTE IV at touched strike: needs ~minute-fresh option quotes at the mapped
  QQQ strike. Schwab chain polling is coarser; PARTIAL — usable only in a
  degraded form, and its increment over speed is small.

### Files

- Labels: `R1-labels-events.csv`, `R1-labels-levels.csv`, mapped:
  `R1-levels-mapped.csv`
- Caches: `R1-oi-cache.csv` (1.89M rows), `R1-cbbo-all.csv` (20k rows),
  `R1-trades-features.csv` (2wk prototype)
- Features: `R1-features.csv` (37.5k rows)
- Outputs: `out-R1-05.txt`, `out-R1-08.txt`, `out-R1-05-cbbo.txt`, `out-R1-12.txt`
- Scripts: `R1-01` labels, `R1-02` mapping, `R1-03` OI cache, `R1-04` OI/GEX
  features, `R1-05` contrasts, `R1-06` cbbo features, `R1-07` trades (flagged),
  `R1-08` deep hunt, `R1-09` within-day transfer, `R1-10` within-week transfer,
  `R1-11` prevvol forward test, `R1-12` IV-vs-arrival-speed decomposition.
