# PILOTFISH — flow-state detection engine (pre-registered plan)

**Codename origin:** the pilot fish swims alongside the shark and feeds off its
hunts. Goal: detect — not assume — when market-maker / broker-dealer forced-flow
algorithms are executing (buy programs, sell programs, liquidity sweeps, pins),
and trade alongside them. Started 2026-07-13.

**Core idea:** a state estimator. Prior from the CLOCK (time-of-day/week
schedules of obligated flows) and the DEALER BOOK (signed-flow inventory from
the dealer-flow program). Evidence from the TAPE (1s feature signatures).
Posterior = which named flow state is running *right now*. Strategies subscribe
to states.

**The placebo standard (BEAT THE CLOCK):** every detector must outperform a
clock-only baseline. A detector firing 3:30–4:00 on down days will "predict"
closing flows from the calendar alone; it earns its place only if detector-ON
minutes beat the same clock window without tape confirmation. This is the
PILOTFISH equivalent of the dealer-flow program's random-level placebo.
Corollary from meta-strategy research (2026-05): unvalidated state switching
DESTROYS baselines — every switch rule clears the same bar as a strategy.

**Discipline:** one detector at a time, signature and tradable consequence
pre-registered below BEFORE outcome analysis. Time-of-day baselines are always
causal (trailing window, no same-day data). All fills/exits per the 1s research
mandate in CLAUDE.md.

---

## Phase 0 — minute feature library (foundation, $0)

`00-feature-library.py` → `data/features/pilotfish_minute_features.csv`

One streaming pass over `NQ_ohlcv_1s.csv` (2023-01-02 → 2026-06-15, primary
contract via `research/causal-gex-screen/nq_1m_primary_2023plus.csv`, calendar
spreads dropped). Per minute:

- `open,high,low,close,volume,nbars` — minute aggregate from 1s bars
- `svol_co` — Σ vol·sign(close−open) per 1s bar (signed pressure proxy)
- `svol_tick` — Σ vol·sign(close−prevclose) (tick-rule variant)
- `travel` — Σ |Δclose| across 1s bars (points the tape actually traversed)
- `absorption` — volume / max(travel, 0.25) (contracts spent per point moved;
  wick-fade research: absorption≥40 at a level → 64% rejection)
- `maxrun_up/dn`, `runvol_up/dn` — longest consecutive same-direction 1s run
  (bars) and its volume (sweep signature)
- `et_date, et_hhmm, dow` — ET clock fields for baselining

Derived later (causally, in detectors): volume/absorption SURPRISE vs trailing
60-day median for that exact minute-of-day.

## Phase 1 — detector ladder (all $0, each vs beat-the-clock)

**D1 — LETF_REBAL (3:30–4:00 ET).** Mechanism: leveraged ETF daily rebalance,
flow ≈ (λ²−λ)·AUM·day-return, executed into the close, same sign as the day.
Pre-registered: on days with |return through 15:30| ≥ threshold, 15:30–16:00
drifts in the SAME direction; effect scales with |return|; tape confirmation =
signed-pressure surprise in the window aligned with predicted flow beats the
calendar-only version. Consequence: momentum entry 15:30 exit 16:00.

**D2 — 0DTE wall decay (charm clock).** Mechanism: 0DTE-heavy walls are
intraday pins that die at expiry. Pre-registered: DWF walls split by
`dte0_share` (field already in dwf_levels.csv) — high-0DTE walls hold early in the
day and fail after ~14:00 ET; low-0DTE (multi-day) walls persist. Consequence:
DWF time-of-day gate / re-weighting.

**D3 — open re-hedge (9:30–10:00 ET).** Mechanism: overnight gap lands on
dealer books at the open. Pre-registered: gap × dealer net-gamma sign (from
dealer-strikes inventory) → first-30-min drift: short-gamma+gap = continuation
(chase), long-gamma+gap = fade (gap-fill). Consequence: directional open trade
only when book sign and gap agree.

**D4 — gamma-sign day selector.** Mechanism: dealer long gamma damps (fades
work), short gamma chases (momentum works). Pre-registered: label every day by
net dealer gamma; simple momentum module must be profitable ONLY on
dealer-short days; fade modules (DWF/GLF-class) better on dealer-long days.
Consequence: regime switch for which strategy class is enabled.

## Phase 2 — intraday EVENT detectors (pre-registered 2026-07-13, post-ladder pivot)

Protocol for ALL of E1-E5: discovery = 2023-2024, holdout = 2025-2026 (price/
volume detectors get the full library — no inventory dependence). Baselines
causal (trailing 60-day median per minute-of-day). Outcomes = signed forward
drift on minute closes at 15/30/60m — SCREENING numbers only; any surviving
rule goes through 1s/engine simulation before its stats are believed. Costs
quoted at 2.0pt slip + $4 RT. Each detector must beat its own clock/context
baseline, not zero.

**E1 SWEEP_HUNT.** Event: RTH minute (09:30-15:30) whose high/low breaks the
overnight (18:00→09:29 ET) or prior-RTH-day extreme, same contract. Snapback =
event-minute close back inside the reference; acceptance = close beyond.
Conditioning: event-minute volume surprise (<1× / 1-2× / >2×). Pre-registered:
snapback + LOW volume surprise → drift AWAY from the reference (fade the
sweep) over 30m; acceptance + HIGH surprise → continuation. Baseline: all
breaks unconditioned.

**E2 DEALER_DAMP (absorption exhaustion).** Event: minute with volume ≥500,
travel ≥1pt, absorption surprise ≥5× AND volume surprise ≥2×, following a
directional 15m move (|drift15| ≥ 0.10%). Pre-registered: forward drift 15-30m
REVERSES the prior move (absorption = someone standing there). Baseline: same
prior-move condition WITHOUT the absorption event (any move mean-reverts?).

**E3 MOC_RUN.** Signal: 15:45-15:51 ET signed pressure |Σsvol/Σvol| ≥ 0.2 with
window volume surprise ≥1.5×. Trade 15:52 close → 16:00 close in pressure
direction. Pre-registered: imbalance execution continues into the bell.
Baselines: unconditional 15:52→16:00; pressure-only without volume surprise.

**E4 VACUUM vs BATTLE.** 5m move |≥0.06%|: LOW participation (vol surprise
<0.7×) = vacuum → pre-registered continuation 15-30m; EXTREME participation
(>2.5×) = battle → reversion. Baseline: mid-participation moves.

**E5 OPENING DRIVE.** 09:30-09:44 drift |≥0.25%| + aligned signed pressure
≥0.15 + volume surprise ≥1.2× → enter 09:45, exit 15:30 in drive direction.
Pre-registered: confirmed drives trend; unconfirmed identical drifts don't
(that comparison IS the beat-the-clock).

**E6 ROUND-STALL (registered 2026-07-13 after E1-E5, before any outcome
look).** The DWF episode shape at round hundreds — completes the open
placebo-with-stall cell from the dealer-flow program (stall was never tested
on placebo levels). Levels = NQ round 100s. Shape: prev close outside zone,
enter ±0.05% zone from BELOW, 5 consecutive minute closes with |log r| <
0.05% -> SHORT at stall close; cooldown 15m per level. Outcomes: fixed 60m
and 120m horizons. Controls: (a) same zone entry WITHOUT stall (isolates the
stall's value), (b) approach from ABOVE -> LONG (secondary). Interpretation
key: E6 positive => stall shape is generic (DWF partly pattern, not flow);
E6 null => flow-signing IS the edge (strengthens DWF). Either result is
informative. Discovery 2023-24 / holdout 2025-26.

Escalation rule: any detector stable in BOTH discovery and holdout, net of
costs, graduates to a 1s-honest simulation and then an engine port (DWF
pattern). Angle bank if E1-E5 null: absorption at round hundreds (3.5yr),
absorption at causal GEX walls (2025 window), prior-day-close magnet,
sweep clustering. Day-regime labels stay retired.

## Phase 3 — LT/LS multi-timeframe program (registered 2026-07-13, pre-outcome)

Drew's pivot after the DWF spend dilemma: the LT/LS complex ($11/mo) has
out-earned the options tape per dollar by orders of magnitude (LSTB Sharpe 13;
ltAlign the only PF+Sharpe+DD filter; LS overlays improved every strategy
touched). DWF PARKED (mechanism confirmed; OOS test is one command if tape
data ever arrives for another reason). Data on disk: LS flips 1m/3m/15m,
LT levels 1m/3m (2025-01 → 2026-05/07). Missing 5m/1h/4h = Drew's TV exports
only if the 3-TF structure shows promise.

Protocol: forward-fill states from flip records; join to
pilotfish_minute_features (raw primary contract); costs 2pt+$4 quoted;
stability = quarter blocks + discovery (2025-01→09) / holdout (2025-10→
2026-05) split; anything LSTB-shaped graduates to engine + 1s.

**L1 state matrix.** 1m×3m×15m LS states (8 combos) → forward 15/30/60m
drift. Pre-registered: full-alignment states (111/000) carry directional
drift; 1m-vs-15m conflict states mean-revert. Baseline: unconditional.

**L2 flip cascade.** At each 15m flip: lead time since the 1m and 3m flips
in the same direction; forward drift by cascade completeness. Pre-registered:
15m flips CONFIRMED by fresh same-direction 1m+3m flips outperform
unconfirmed 15m flips. Also inverse: P(15m follows | 1m+3m flipped) as an
early-warning detector.

**L3 state age.** Fresh vs stale 15m state (age quartiles) → forward drift;
LSTB trades re-scored by 15m-state age at entry.

**L4 LT touch × LS alignment.** Touches of LT level_1..5 (1m LT file, raw
space, vs raw OHLCV): rejection/continuation conditioned on 1m/15m LS
alignment with the fade side. Wick-fade × multi-TF sentiment.

**L5 LT geometry regime.** level_1..5 span/density → chop-vs-trend regime
labels → forward vol/drift. Secondary.

**L6 LSTB 3m-align increment.** Does requiring 3m alignment ON TOP of
ltAlign (1m trigger + 15m align) improve the honest gold? Engine run,
`--lstb-require-lt-align` + new 3m gate. The direct-to-production test.

## Phase 3b — overnight alpha sweep on the full multi-TF library (registered 2026-07-14 ~04:40Z, pre-outcome)

Data now on disk: LS 1m(2023-07+)/3m/5m/15m/1h/4h/1D(2021+), LT 15m/1h/4h
(2021+). KNOWABILITY LAW for every study: a bar-stamped state/level is usable
only from stamp + TF width (the ls15 lesson, generalized). All forward
returns measured from the knowability instant on 1m closes; costs 2pt+$4
quoted for any trade framing.

Splits: discovery = 2021-2023 where data allows, validation = 2024; 2025-26
touched ONLY as final confirmation of anything that survives both. For
LSTB-conditioned studies (trade-level): in-sample gold window (2025-26)
discovers, the 2023-24 OOS trade set confirms.

**M1 — LSTB × higher-TF state meta-label.** Join the 5,934 IS + 6,108 OOS
LSTB trades with 3m/5m/15m/1h/4h LS states at signal time (each shifted +TF).
Pre-registered: trades aligned with the higher-TF state outperform
counter-state trades; the effect strengthens with TF. Any gate must improve
PF+Sharpe+DD together on IS AND hold on OOS (the honest ltAlign replacement).

**M2 — multi-TF state matrix redux.** L1 with knowability shifts, TFs
3m/5m/15m/1h, 2021+ window. Pre-registered: full-stack alignment carries
drift; the 2025-26 sign pattern (long-side positive) replicates in 2021-23.

**M3 — HTF flip + LTF pullback (Drew's crossover events).** After a 15m/1h
flip becomes knowable, wait for the first counter-direction 5m state, enter
on its resolution back to alignment. Pre-registered: beats entering at the
flip instant (better price, fewer whipsaws).

**M4 — slow LT levels as intraday S/R.** First test of 1h/4h LT levels:
1m-close touch episodes (DWF-style zones, ±0.05%), rejection vs continuation,
controls = round hundreds + the level set shifted +37pt (placebo). Pre-
registered: real slow LT levels reject more than both controls.

**M5 — LS state age (L3).** Forward drift by state age quartile per TF.
Pre-registered: fresh states carry more drift than stale ones.

### Phase 3b results (2026-07-14 overnight, all five registered studies)

- **M1 REFUTED (decisively, both periods):** no HTF state gate improves LSTB
  at ANY timeframe. 15m keeps directional edge honestly (aligned PF 1.40/1.32
  vs counter 1.31/1.22) but counter trades are PROFITABLE — dropping them cuts
  Sharpe below baseline (IS 7.5 vs 10.0; OOS 5.9 vs 7.6). 5m/4h INVERT between
  IS and OOS. LSTB is state-agnostic; the meta-label thread is CLOSED.
- **M2 REFUTED:** all-aligned bull drift (+2.3-2.9pt 2021-24) inverts in
  2025-26; bear alignment never works; conflicts flip signs. No tradable
  state-level drift at 30-60m horizons.
- **M3 REFUTED:** honest 15m/1h flips carry no post-knowability drift in any
  period, immediate or pullback entry (4th independent confirmation: the
  flip's predictive content is consumed by the bar that creates it).
- **M4 REFUTED:** slow LT levels (1h/4h) reject NO better than +37pt-shifted
  placebo or round hundreds, all three periods. Naked levels of any
  provenance = placebo (matches the dealer-flow GEX result).
- **M5 REFUTED:** no monotone state-age pattern; quartile signs shuffle
  across periods.

- **M6 (level-crossover continuation, registered post-M4 on the fade-differential
  hint) REFUTED for stability:** signs flip era-to-era at every TF; placebo
  sometimes beats real (15m 2024: shifted +13.6pt vs real +4.3). The one hot
  cell — 4h crossovers 2025-26, +24.9pt/60m, WR 59%, n=227, beats both
  controls — is the trending-regime signature (shifted placebo also +12.7
  there), NOT a durable level effect. Fourth independent detection of the
  same regime split: 2025-26 trends / 2021-24 mean-reverts (with E5
  opening-drive, M2 alignment inversion, D4 tariff-momentum). A causal
  regime classifier would be needed to trade it; regime labels are exactly
  what keeps failing OOS. `15-m6-level-crossover.py`

**M7 — LT structure × moving-anchor crossovers (registered 2026-07-14 pre-
outcome, Drew's request).** Event: the MEDIAN of the knowable LT level set
(15m and 1h series) crosses an indicator line, with a 0.03% deadband
(hysteresis) to kill chatter. Indicators on 1m closes: EMA20/50/200/300
(≈EMA20@15m)/1200 (≈EMA20@1h)/3000 (≈EMA50@1h), session VWAP (18:00 ET
anchor), weekly VWAP (Sun 18:00 anchor). Knowability: LT row from stamp+TF;
indicators from sealed 1m closes. Pre-registered: LT-structure crossing
ABOVE the anchor → bullish continuation 60/120m (and inverse). Control:
+37pt-shifted level set. Splits 2021-23 / 2024 / 2025-26.

- **M7 REFUTED (comprehensively):** 96 cells (EMA20/50/200/300/1200/3000 +
  session/weekly VWAP × LT-15m/1h median × 3 eras, real + shifted control) —
  all gross drifts within ±4pt, WR 47-55%, no sign stability, real ≈ placebo
  throughout. LT structure crossing moving anchors carries no information.
  `16-m7-lt-indicator-cross.py`

- **M8 (× GEX levels, 2023-2026) REFUTED for a deployable edge, two notable
  reads:** (1) gamma-FLIP crossings show continuation +1.5..+3.9pt in 2023/24
  and NEGATIVE −2.8..−6.2pt in 2025-26 across ALL seven subjects — a 6th
  regime-split detection, and INVERTED vs the price-level pattern (flip-cross
  momentum died exactly when price-level momentum was born). (2) Best cell
  EMA1200 × put-wall: positive all three eras (+11.7/+16.0/+9.1pt) but
  n=16/18/114 and the shifted placebo is also positive (+6.2/+3.6/+8.3) —
  margin over placebo collapses in the only era with real n. Not deployable.
  `17-m8-gex-crossovers.py`

**Phase 3 meta-conclusion:** across ~250k samples, 12k trades, 5 TFs, 3
regimes, and placebo controls, the LS/LT complex contains exactly ONE piece
of alpha — the 1m flip microstructure LSTB already harvests — and LSTB needs
no gate on top of it. The multi-TF library's value is validation depth (the
OOS confirmation), not new conditioners.

## Phase 4 — regime classifier (registered 2026-07-14, Drew: "we need to answer that question next")

The question: what OBSERVABLE, CAUSAL variable separates the 2021-24
mean-reversion regime from the 2025-26 continuation regime (detected by 5+
independent tests)? Candidates, all computable daily from on-disk data with
trailing windows only:

  R1 trailing lag-1 daily-return autocorrelation (20/60d) — the direct measure
  R2 trailing efficiency ratio (|net move| / travel, 5/20d) — trendiness
  R3 overnight→intraday return relation (trailing 60d beta)
  R4 LS flip-rate / state-run-length percentile per TF (we hold 2021+ series)
  R5 trailing realized-vol level + 5d/20d structure
  R6 trailing opening-drive follow-through (the E5 effect, measured causally)

**The bar that killed every previous regime label (pre-registered):** a
candidate must separate behavior WITHIN each macro-era, not just between
eras — high-signal days inside 2021-24 must show continuation behavior and
low-signal days inside 2025-26 must show reversion. A variable that only
tracks the calendar is a date proxy and gets rejected (that's what D4's
book-sign and every era-unstable cell actually were). Test harness: condition
the two strongest era-unstable effects (opening-drive continuation; 4h-level
crossover continuation) on each candidate's trailing percentile, within-era.

### Phase 4 step 3 — TREND-PERMISSION v2 on virgin 2021-22 (registered 2026-07-14 BEFORE the 2021-22 feature build completed)

Findings so far (2023-2026): combo = R2rank252 − R3rank252 ≥ +0.25 on
|drive|≥0.15% days → ride drive 09:45→15:30: 2023 +56.7pt/tr (77% WR),
2025 +48.2, 2026 +43.0 — but 2024 INVERTED (−85.6pt, 29% WR), failure
CONCENTRATED at vol-shock onsets (Aug 5-8 carry unwind −170pt avg, Sep 11
CPI). Mechanism: trailing trend signals peak exactly when a shock lands.

Amended rule (v2): permission = combo ≥ +0.25 AND vol-shock veto
R5 = mean|dailyret|5d / mean|dailyret|20d ≤ 1.5. Fixed constants, no tuning.

Virgin-data predictions for 2021-22 (2022 is shock-rich):
  P1: v2 permission-ON drive days average positive follow-through (points).
  P2: the UNVETOED rule shows 2024-style concentrated failures inside 2022
      shock clusters (falsifiable mechanism check — if unvetoed does FINE in
      2022, the vol-shock story is wrong and v2 is an overfit patch).
  P3: v2 materially beats unvetoed in 2022; roughly ties it in calm 2021.

### Phase 4 VERDICT (2026-07-14): TREND-PERMISSION REFUTED on virgin 2021-22

All three registered predictions failed. P1: v2-ON drive days NEGATIVE both
virgin years (2021 −14.9pt/tr, 2022 −10.5pt/tr). P2: the vol-shock mechanism
story is WRONG — 2022's failures (Jan −64pt, Feb −69pt) happened at LOW R5
(1.1-1.3; veto fired on only 5 of 275 days) and were spread across the year,
not shock-concentrated. P3: v2 worse than unvetoed in both years. Most
damning: 2022 permission-OFF days averaged +30.9pt (61% WR) — anti-predictive,
exactly like 2024. Six-year tally for combo-ON: works 2023/2025/2026, inverts
2021/2022/2024. A coin flip across years; the 2023-26 within-era consistency
was partly an artifact of where the era boundary sat.

**Phase 4 conclusion: trailing price-derived regime signals do not forecast
the regime — they describe the past, and are maximally wrong at turns.** This
now spans R1-R6 (4 failed within-era, R2/R3 failed virgin data), D4's
book-sign, and the causal-gex-screen year-inversions. The regime question
stays open ONLY for non-price information (vol term structure, positioning,
macro calendar); price-derived daily labels are exhausted and closed.

## Phase 5 — LT-ANATOMY: candle × level interaction taxonomy (registered 2026-07-14, Drew's design request)

Explicitly exploratory (Drew: "data mining and correlation to explore"), so
the protocol carries the multiple-comparisons burden: ~60 cells will be
examined; a finding SURVIVES only if (i) same sign in ALL THREE eras
(2021-22 / 2023-24 / 2025-26), (ii) |gross| > cost floor (2.2pt) in all
three, (iii) beats the +37pt-shifted placebo where level identity matters.
Under the null, ~60 cells × (1/4 same-sign-triple) × P(3× magnitude) ≈ ≤2
false survivors expected — anything surviving gets a dedicated verification
pass before belief. All outcomes in NQ POINTS. Knowability shifts everywhere.

**A. Touch anatomy.** Level TFs {15m, 1h, 4h} × evaluation-candle TFs
{1m, 5m, 15m} × three events at a ±0.05% zone touch (approach side s from
prior candle close):
  A1 WICK-REJECT: extreme penetrates zone, close ≥2 zones clear on approach
     side → predict continuation AWAY from level.
  A2 CLOSE-THROUGH: close ≥1 zone beyond the far side → predict continuation
     THROUGH.
  A3 WICK-HOLD: close inside the zone → next candle's close direction
     predicts resolution.
Outcomes 30/60/120m (points, prediction-signed), each vs shifted placebo.

**B. Level-set geometry (per-minute, exploratory measurements first, trades
only if structure appears).**
  B1 cluster tightness: span of the 5 levels (pts, and trailing-252d
     percentile, causal).
  B2 price position: above-all / below-all / inside-span; distance to
     nearest level.
  B3 magnet-vs-repellent: signed forward drift (60/120m) TOWARD the nearest
     level and toward the cluster centroid, by distance decile — measured
     symmetrically, no directional prior.
  B4 tight vs dispersed: touch-rejection rates and forward |drift| when the
     touched level sits inside a tight cluster vs isolated.

**C. Level persistence:** touch outcomes split by how many consecutive HTF
rows the level has survived (fresh vs persistent levels).

### Phase 5 RESULTS (2026-07-14)

- **A (27 anatomy cells): ZERO survivors.** No wick-reject / close-through /
  wick-hold pattern holds sign across three eras at any level-TF × candle-TF;
  hot recent cells (1h close-through +10..14pt 2023-26) fail 2021-22 and the
  placebo. `21-a-touch-anatomy.py`
- **B3 magnet test: NULL** — drift toward nearest level / centroid ≈ 0..−1pt
  in all eras. LT levels neither attract nor repel price.
- **B4: isolated levels out-fade clustered ones in all 3 eras** — direction
  stable, magnitude <1pt = economically nil.
- **B1 → THE PHASE'S FINDING: LT-structure tightness forecasts forward
  RANGE.** Monotone in all 3 eras raw; survives the trailing-vol control
  specifically in the TOP vol quartile: wide-vs-tight gap +10.9/+14.0/+24.2pt
  of 2h |drift| (2021-22/23-24/25-26). Non-directional — a vol forecast
  (sizing / stop-width / vol-strategy input), no entry signal falls out.
  `22-b-geometry.py` + confound check.
- **C: NOT APPLICABLE** — LT levels are ephemeral by construction (±2pt
  identity survives only 1-2 rows; 16+ row buckets empty). No persistence
  classes exist.

## Phase 6 — vendor-semantics (DeepDive papers decoded, 2026-07-14/15)

Papers reviewed (skunkworks/lt-gex-of/): LDPM Primer, LDPS Primer, LDPS PoC,
LDPM+LDPS Addendum, LTA Handbook, DLP Primer. Decode: our "LT levels" =
LDPM oscillator family at fib lookbacks (fast→slow money), NOT S/R; our "LS"
= LDPS Liquidity Condition (binary export of a 6-grade output; the LF
Improving/Worsening dimension is NOT captured); DLP = Dealer Long Puts
(weekly macro metric, no levels); sentiment_raw ≈ granular LDPM line.

- **M9 rip/dip currents (vendor motion semantics): REFUTED for stability** —
  RIP longs +$56/+$34 net in 23-24/25-26 but negative 21-22; DIP shorts fail
  everywhere; level velocity = recent-price-momentum proxy wearing the
  familiar era split. `23-m9-currents.py`
- **M10 upright/inverted + trap doctrine: REFUTED** — bull-trap shorts
  negative 2/3 eras; bear-trap longs −16pt/event in 25-26; upright+bull
  longs = the standard 23-26-only momentum shadow. (Assumes slot order =
  fib order per dumper wiring.)
- **Vendor's own fine print corroborates our program:** LDPS PoC medians ≈0
  and wrong-signed (means tail-driven); LTA backtests: 1m and 5m intervals
  NEGATIVE, 15m the only significantly-positive interval (their median
  backtest = +0.99%); LF effect clearest on Daily only. Their strongest
  formal claim (LDPM distance → future range) = our B1 three-era-stable
  finding, independently confirmed.

**Uncaptured dimensions (need new dumpers):** 6-grade LC + LF flow (LDPS full
output; RPA doctrine halves size on LC/LF incongruence = a SIZE semantic,
never a direction one); Liquidity Toolkit Price Triggers (per-TF hourly/daily
S/R with crossover + squeeze/plane semantics); full LDPM ladder incl. -233 +
granular line at chosen TFs.

## Phase 7 — Price Trigger study (registered 2026-07-14 pre-outcome)

Data: Toolkit PT levels (nq_pt_15m_raw.csv, point-in-time, raw space,
sealed cadences: P5 per-bar, PH hourly, PD daily @18:00 ET, PW weekly,
PM monthly; wiring + cross-file validation passed). Knowability: stamp+15m.
Eras 2021-22 / 2023-24 / 2025-26; outcomes in points; costs 2pt+$4.

**PT1 touch/rejection.** PD, PW, PM as S/R: 1m close approaches within
±0.05% zone from outside, fade payoff 30/60/120m, split by approach side
(support vs resistance touch). Control: levels +37pt. Pre-registered: sealed
daily/weekly reference levels reject BETTER than placebo (unlike LDPM).

**PT2 vendor crossover rule.** "Bullish crossover: lower PT crosses above
higher PT with bullish liquidity": PH×PD and PD×PW crossings, gated by the
matching-TF LS state (1h LS for PH×PD, 1D LS for PD×PW), continuation
60/120m. Ungated variant as the clock baseline.

**PT3 squeeze (Bullplane/Bearplane).** |PH−PD| tightness percentile
(trailing causal): (a) forward range by tightness quartile (B1 analogue);
(b) direction after squeeze release = side PH exits on, continuation payoff.

### Phase 7 RESULTS (2026-07-14)

- **PT1 REFUTED:** PD/PW/PM touches era-flip on both sides; placebo-
  comparable. Sealed, non-repainting reference levels STILL aren't fadeable
  S/R — the strongest-constructed level class yet, same null.
- **PT2 REFUTED by placebo:** PH×PD crossings looked like the program's
  first non-inverting signal (+29.5/+1.4/+16.2 LS-gated), but shifted-PD
  controls reproduce or beat it (shift−83: +31.7/+20.0/+2.0); 23h horizons
  decay/flip. It's hourly momentum vs any slow reference, not the level.
- **PT3 weak/unstable:** tightness→range only in 25-26; release direction
  flips. `24-pt-study.py` + verification block.

- **PT4 (added 2026-07-15 after Drew's visual): price×PH / price×PD
  trend-flip crossings REFUTED** — price×PH flat-negative everywhere
  (~3,000 whipsaws/era); price×PD's small positives are beaten by the
  shift37 placebo in every era at 2h. The visual identity of PH is a
  trailing trend anchor (staircase), which is WHY fading it failed and
  crossing it is momentum-generic.

**Phase 7 meta:** even with perfect data hygiene (sealed cadences, zero
repaint, triple cross-validation), the Toolkit levels carry no directional
or S/R edge beyond generic momentum — as levels, as crossovers, or as
trend-flip lines. The level-hypothesis is now closed across FOUR level
families (LDPM/LT, GEX walls, round numbers, PT triggers).

## Phase 2b — state labeler + re-scoring

Named states (each: cause, window, signature, consequence): `LETF_REBAL_SELL/BUY`,
`CHARM_DRIFT`, `DEALER_DAMP`, `DEALER_CHASE`, `SWEEP_HUNT`, `MOC_RUN`, `NOISE`
(null state — most minutes). Rule-based first (interpretable); no ML until
rules are exhausted. Then re-score DWF and LSTB conditioned on state — hypothesis:
LSTB's worst hours coincide with adverse states it can't see.

## Phase 3 — live module

New publisher on the Redis bus (`flow.state`), consumed by multi-strategy
engine like `gex.levels`. Inputs live: clock + nightly dealer inventory +
Schwab intraday poll deltas (75% sign agreement — regime-grade, not
strike-grade) + 1s features from the TV/Schwab candle feed. Only states that
survived Phases 1–2 ship.

## Status log

- 2026-07-13: plan registered; Phase 0 script launched.
- 2026-07-13: **P0 DONE** — 1,221,361 minute rows, 2023-01-02 → 2026-06-15
  (`data/features/pilotfish_minute_features.csv`, 137MB, 21 unmapped minutes).
- 2026-07-13: **D1 REFUTED** — no same-sign LETF drift 15:30→16:00 at any |r|
  threshold (continuation NEGATIVE −5..−8pt on 0.5-2% days); tape confirm
  failed beat-the-clock (aligned worse than opposed at |r|≥1.5%); inverse
  fade-the-day decays monotonically 2023→2026 → dead net of costs. `01-*.py`
- 2026-07-13: **D2 REFUTED AS STATED, INVERTED** — high-0DTE walls STRENGTHEN
  after 14:00 ET (PF 1.87 vs 1.23), low-0DTE decay late (PF 1.05); monotone
  tertile gradient PF 1.04→1.44→1.53 with dte0_share. Post-hoc story: charm
  ACCELERATES into expiry. Registered as OOS hypothesis (needs data beyond
  2026-01); NOT deployable from in-sample n=60.
- 2026-07-13: **D3 REFUTED as mechanism** — effect must scale with gap, but it
  dies: short-gamma chase −6.8pt at |gap|≥0.3%, −27.4pt at ≥1% (big gaps
  mean-revert regardless of book). Small-gap differential in the registered
  direction (|gap|≥0.1%: long-gamma fade +11.8pt vs short-gamma cont +4.1pt)
  is single-12mo-window, no OOS possible. `02-*.py`
- 2026-07-13: **D4 REFUTED** — as-registered, momentum on dealer-short days
  LOSES (−13.4pt/day). Apparent inversion (momentum on dealer-LONG +37pt/day,
  survives vol 2×2) collapses under audit: April 2025 tariff months = +293pt/
  day driver; ex-tariff +9.0pt = marginal after costs, monthly signs unstable;
  book sign autocorrelated (54 flips/246 days). Same failure mode as the
  causal-gex-screen: day-level state conditioners don't hold. `03-*.py`

- 2026-07-13: **E1 REFUTED** — sweep-fade cells negative in discovery AND
  holdout; grid flips sign across periods/ref types. Intraday RTH sweeps ≠
  the validated pre-RTH sweep effect. `04-*.py`
- 2026-07-13: **E2 REFUTED** — original thresholds self-contradictory
  (11 events/3.5yr; directional moves have low absorption by construction);
  honest discovery-grid best cell still −$25/tr, holdout −$37/tr. Gross
  mean-reversion after 0.2% moves exists (+0.3..+1pt) but ≪ costs; minute
  absorption ≠ 1s wick absorption at levels. `05*.py`
- 2026-07-13: **E3 UNFIREABLE/REFUTED** — 7-min signed pressure ≥0.2 almost
  never occurs (minute svol nets out — LESSON: pressure detectors need
  sub-minute signing); pressure-only variant negative both periods. `06-*.py`
- 2026-07-13: **E4 REFUTED** — vacuum continuation +0.5pt disc / −1.9pt hold
  (sign flip); battle reversion negative both. `07-*.py`
- 2026-07-13: **E5 gate UNFIREABLE**; baseline row = Zarattini ORB echo:
  opening-drive continuation +41pt/day 2025-26 vs ~0 2023-24 — real in the
  current regime, NOT year-stable, stays parked with intraday-momentum
  memory. `08-*.py`
- 2026-07-13: **E6 NULL both periods — HIGH-VALUE null**: DWF stall shape at
  round hundreds loses (below+stall short −2..−3pt/ep both periods). CLOSES
  the placebo-with-stall control cell: the stall pattern is NOT generic —
  flow-signed dealer-long gamma IS the DWF edge. `09-*.py`

- 2026-07-13: **DWF v1.1 conditioning (gate #2) — the day's find.** One
  condition at a time on the v1 gold config: A `--dwf-ls-align` 115tr/$20,609/
  PF 1.61/Sh 2.11/DD 4.21%; **B `--dwf-min-dte0 0.16` 183tr/$25,758/PF 1.47/
  Sh 2.28/DD 3.83%, ALL quarters positive — preferred (PF+Sharpe+DD up
  together, 94% PnL kept)**; C both 73tr/$18,251/PF 1.88/Sh 2.19/DD 2.40%.
  Flags wired (cli.js, dealer-wall-fade.js). Same-12mo-window caveat: the
  2026-02+ OOS purchase remains the arbiter for all variants.

**Ladder meta-conclusion (2026-07-13):** the textbook CLOCK/day-level priors do
not survive on NQ — all four refuted, two with seductive inversions that died
under regime audit. Everything that HAS validated in this whole research
program is EVENT-level at specific prices: DWF stall at dealer-long walls,
wick-fade absorption (≥40/pt → 64% reject), pre-RTH sweep side (90.5% OOS).
=> Phase 2 pivots: skip day-labels entirely; build intraday EVENT detectors
(SWEEP_HUNT, DEALER_DAMP/absorption, MOC_RUN as tape events) on the P0 feature
library, each still vs beat-the-clock. Day-regime labels only return if an
event detector needs them as a minor prior.
