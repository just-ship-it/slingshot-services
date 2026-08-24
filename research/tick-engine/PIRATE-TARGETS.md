# Pirate targets — structural raids worth investigating (2026-08-20)

## The filter (derived from what actually works here)

Every edge that has survived in this repo — PCC, Monday strength, gap-fade — shares four traits.
Anything on this list must have all four:

1. **Rare** — 4 to ~700 events/year. Not a screen over 600k candles.
2. **Anchored to a clock, calendar or structural event**, never to a chart shape.
3. **Awkward to scale** — capacity so small that nobody with lower costs bothers to compete.
4. **Big enough per event** that our cost bar (+1.7pp at 22-pt targets, +3.7pp at 10-pt) is clearable.

## Already dead — do NOT re-dig

European open (cost cliff), Tuesday effects (decay), midday census (R9, null), first-hour reversal
(B6 dead — first 15m *continues*), classic S/R + channels + level reactions (C1/C2/A2 placebo),
index-rebalance front-run (in-sample only, OOS failed post-2023), all candle/chart shape families
(this session), GEX level reactions (9 separate nulls).

## The list, ranked by (expected size × prior × speed to test)

| # | raid | the structural story — why it could survive | freq/yr | data we hold |
|---|---|---|---|---|
| 1 | **Quarterly roll week** | Open interest migrates front→back over ~5 days. Forced, calendar-known, mechanical flow; calendar spreads trade separately. Nobody arbitrages the *futures* path because the flow is in the spread. | 4 (20 sessions) | rollover logs, calendar-spread rows, symbol changes in cache |
| 2 | **Pre-FOMC drift** | Lucca–Moench: equities drift up in the ~24h before FOMC announcements, documented and persistent, too small/rare for funds to bother. | 8 | need FOMC dates (public) |
| 3 | **Holiday & half-day sessions** | 13:00 ET early closes, day-after-Thanksgiving, Christmas/New Year weeks. Liquidity collapses, participants are absent, mechanics differ. Untested here. | ~10 | derivable from session lengths in cache |
| 4 | **Month-end / quarter-end** | Pension and target-date rebalancing on the last 1–2 sessions; direction conditioned on the month's equity move. Distinct from the (dead) index-rebalance front-run. | 12 / 4 | dates + cache |
| 5 | **Monthly OpEx & quad witching** | 3rd Friday gamma unwind; dealer hedges expire and positioning resets. Our GEX archive can condition it. | 12 / 4 | GEX 804 days + cache |
| 6 | **Overnight-range → next-day extremes** | A1 found: low overnight-range tercile → BOTH RTH extremes broken 38.3% vs 15.7%. Real, 6/6 years, **never traded**. A straddle-shaped raid. | ~80 | cache + A1 method |
| 7 | **Gap size-conditioned** | A1 found gap-fill monotone 96%→24% across \|gap\|/ATR. Only the up-gap fade is deployed; the size relationship is unharvested. | ~120 | cache |
| 8 | **Post-settlement hour (16:00–17:00 ET)** | After the 16:00 settlement print, one thin hour before the 17:00 halt. Structurally different regime; almost nobody trades it. | 250 | cache (24/7) |
| 9 | **Sunday Globex open** | Weekend gap + first hours of the week into thin books. | 52 | cache |
| 10 | **Post-shock sessions** | The session after an N-sigma day: vol clustering is the single most robust A1 finding (lag-1 corr +0.61) but has only ever been used as a conditioner, never as an entry. | ~60 | cache |

## Method for each (same discipline, no exceptions)

- Dev ≤2024 / validation 2025–26, thresholds frozen from dev.
- A **matched control**: same-clock non-event sessions (this is the drift twin that killed ORB).
- Report **absolute EV**, not excess over a losing baseline (the trap from the last round).
- Neighbourhood/plateau test before believing any optimised parameter.
- Honest 1s fills, one position at a time, real costs.
- Kill criterion: fails validation, or the effect is concentrated in ≤2 years.

## Order of attack

Batch A (all date-anchored, one harness, testable together): **1, 3, 4, 5, 9**
Batch B (state-conditioned, need per-session features): **6, 7, 10**
Batch C (needs an external calendar): **2**

---

# SCOREBOARD — round 1 (2026-08-20)

Harness built: `build-sessions.js` (1400 sessions × 12 ET clock windows, 33s) + `raid-calendar.py`.
**Validation of the harness:** it independently rediscovered **Monday strength** (dev +$350/session,
val +$983, n=187/70) — a strategy already deployed in the live book. The method finds real things.

| # | raid | status | detail |
|---|---|---|---|
| 1 | Quarterly roll week | **DEAD — artifact** | Looked like +$684/trade overnight. It is the contract roll: symbol-change sessions show a mean overnight move of **149.8 pts vs 4.9** for everything else, and the roll log confirms ~202-pt spreads. Cleaned of every session touching a contract change, dev +$433 → **val +$62**, and morning/RTH flip to −$1,791/−$1,620. |
| 3 | Holiday / half-days | weak-positive | RTH long dev +$185 / val +$483, but n=36/16 and control is +$24. Underpowered. |
| 4 | Month-end | **no** | dev ≈ $0 (+$5) with val +$1,017 — noise, wrong direction of evidence. |
| 5 | OpEx / quad | weak | morning short dev +$525 / val +$34, n=46/**16**. Too thin to call. |
| 9 | Sunday/Monday open | **already ours** | This is Monday-strength, already live. |
| 10 | **Post-shock sessions** | **BEST CANDIDATE — see below** | |

## Target 10 in detail: buy the session after capitulation

On the 1s cache (2021-26): after a top-5% DOWN session, next RTH long = dev n=32, mean +$1,414,
median +$1,202, trimmed +$1,084, WR 69%, control −$17. Asymmetric — after big *UP* sessions the same
trade loses (−$317 dev / −$1,914 val), so it is capitulation-buying, not a symmetric artifact.
Threshold plateau is clean (+$636 → +$1,414 as you tighten). **But** validation n=24 has a NEGATIVE
median (−$265) and WR 46%, and 2026 is −$1,589. Underpowered at ~8 events/yr.

**Power-tested on 27 years of NQ daily (6,839 sessions, `data/macro/nq_1d.csv`):** the effect is a
clean MONOTONE gradient, not a spike —

| prior session move | n | next session mean | median | WR |
|---|---|---|---|---|
| ≤ −2.0 ATR | 31 | **+59.4 pts** | +20.8 | 58% |
| −2.0 to −1.5 | 76 | +32.9 | +8.0 | 62% |
| −0.5 to +0.5 (calm) | 4,022 | +3.1 | +3.0 | 54% |
| +1.5 to +2.0 | 56 | −12.2 | +7.1 | 61% |

**The catch — it is entirely a post-2015 phenomenon:**

| era | n | mean | median | WR | baseline |
|---|---|---|---|---|---|
| 1999-2007 | 16 | −5.0 | +1.1 | 56% | −0.2 |
| 2008-2014 | 35 | +3.3 | −2.0 | 49% | +0.9 |
| 2015-2020 | 35 | +46.5 | +31.5 | 66% | +6.1 |
| 2021-2026 | 21 | +127.3 | +94.2 | 76% | +8.9 |

Fifty-one observations across 1999–2014 show no edge at all. By this repo's standard kill criterion
(sign-stable across eras) that is a fail; read charitably it is a genuine regime feature of the
post-2015 market (central-bank puts, passive flows, retail dip-buying) that may persist but is not
structural. The 2026 sub-sample (−$1,589, WR 25%) is an early warning either way.

**The more useful reading:** the *gradient* is the finding, and it has n=6,839 rather than n=107.
"Lean long after down sessions, lean flat after up sessions" is a **sizing conditioner** — which is
exactly the shape that already worked once here (the PCC breadth ladder took PCC from $68k to $119.6k
by conditioning size, not entries). That is a far better use of it than a rare standalone trade.

## Next up
Batch B (6: overnight-range → both extremes; 7: gap size-conditioned) and Batch C (2: pre-FOMC drift,
needs an FOMC date list). Then: test the post-shock gradient as a size conditioner on PCC/Monday/gap-fade.

# SCOREBOARD — round 2 (Batch B)

| # | raid | status | detail |
|---|---|---|---|
| 6 | **Overnight-range → breakout** | **DEAD on the median test** | A1's mechanism is REAL and confirmed: both ON extremes break on 26.3% of quiet nights vs **1.1%** of wide nights. The trade looked outstanding — positive all 6 years (+$50 → +$1,136), mean ≈ trimmed ≈ median (+$216/+$277/+$222), monotone threshold plateau, $14.6k/yr dev and $57.2k/yr val. Then the drift twin: signal +$175 vs unconditional-long-same-day +$77 (dev). Excess is only +$112/trade, **4/6 years positive on the mean but 0/6 on the median** (−$330 typical). Tighter stops make it monotonically worse (0.5 ATR → −$547), i.e. it needs $6.4k of room — exposure, not defined-risk edge. Long-breakout excess is −$1,154; the entire mean sits in short-breakout tails. |
| 7 | **Gap size-conditioned** | partial | Fill rate is monotone as A1 said (92.4% at <0.1 ATR → 10.3% at >0.75). Continuation at large gaps (+$219) and mid gaps (+$318) is dev-positive but this overlaps the deployed gap-fade; not yet separated. |
| — | **Vol-state conditioning of the live book** | **no** | Conditioning PCC / Monday / gap-fade on overnight range or prior-day move: dev and val disagree in nearly every cell (PCC prefers low-ON on dev, high-ON on val; same for gap-fade). No reliable improvement. |

## The pattern in the failures — a screening rule

Five candidates tonight looked strong and died to the **same two tests**:

1. **The drift twin.** Any long-biased NQ strategy must be compared to simply being long over the same
   window on the same days. ORB, wide-ON breakout, and post-shock all lost most or all of their edge here.
2. **Median vs mean.** A positive mean with a negative median is a tail artifact, not an edge. The
   wide-ON breakout has a negative median excess in *every one of six years* while the mean is positive.

**Run both BEFORE anything else.** They are two lines of pandas and they would have saved most of
tonight. A candidate is only worth deeper work if it survives: positive mean AND positive median AND
beats its drift twin, in dev and val separately.

## Still genuinely untested
- Pre-FOMC drift (needs an FOMC date list) — the one remaining item with published academic support.
- Gap-continuation cleanly separated from the deployed gap-fade.
- Post-holiday first session; day-before-holiday; turn-of-month (last 1 + first 3).
