# Price-Structure Engine — design (v0, 2026-08-18)

Purpose: a streaming, multi-timeframe classifier that, from OHLCV alone, detects price
structures (candle formations, chart patterns, school-specific structures) *as they emerge*,
emits state transitions with the levels that validate/invalidate each structure, and logs
everything so the downstream layer can estimate P(resolve up | structure, state, context)
honestly. Detailed method survey: `catalog/04-detection-methods-and-literature.md` (§7 is the
streaming architecture this doc adopts). Substrate/parameter defaults:
`catalog/01-chart-patterns.md` §A, §D, §E. Candle normalization: `catalog/02-candlestick-patterns.md`
§1.3. What exists in the repo: `catalog/05-repo-audit.md`.

## 0. Lookahead self-audit (read first — C2 §0 style)

| element | stamp meaning | knowable at | rule |
|---|---|---|---|
| base 1m bar | bar OPEN (`[T,T+1m)`) | T+1m (close) | consumed only at close |
| aggregated tf bar | period OPEN, session-anchored ET | close of last 1m constituent | emitted on that 1m close (multi-strategy-engine `getAggregatedCandle` precedent) |
| pivot | extreme bar ts | `confirmedAt` = close of bar `i+k` (fractal) or of the bar the zigzag reversal threshold crossed | a pattern may use a pivot only when `confirmedAt ≤ now` |
| pattern state | — | `ts` of the transition = close of the bar that caused it | append-only record; never rewrite an earlier state's levels |
| trendline value at t | computed from confirmed pivots only | t | provisional (unconfirmed) extremes never enter geometry |
| ATR / vol normalizers | closed bars of the same tf only | t | no same-bar range in its own normalizer |
| resolution / outcomes | walked forward on 1s from `triggerTs` (or `formingTs` for fixed-horizon returns) | offline | B12_sim fill contract; never earlier than the emission instant |
| session/roll boundaries | 18:00 ET Globex open, 09:30/16:00 regime marks; primary-contract switch | — | intraday state hard-reset at roll; `spansSessionBreak` flag |

## 1. Data flow

```
historical: greenfield/explore/cache/NQ_1m_primary.csv (raw primary contract, rollover-aware)
live:       data-service candle.close (1m, raw front month)
        │
        ▼
  SessionAnchoredAggregator(tf ∈ TF_SET)      TF_SET default: 1m 3m 5m 15m 30m 1h 4h 1d
        │  (bars stamped at OPEN, emitted at CLOSE; anchored to 18:00 ET session open,
        │   with 09:30 as a second anchor for RTH-aligned intraday tfs — configurable)
        ▼  per tf:
  BarFeatures   → ATR14, medianBody60, medianRange60, minute-of-session median-range table,
                  time-of-day-normalized volume, EMA20 slope, structure trend (hh-hl / lh-ll)
  CandleRules   → O(1) TA-Lib-style detectors on the last ≤5 bars  → PatternEvent(family=candle)
  PivotTracks   → (a) fractal k-window (k configurable, default 2-3 intraday / 3-5 htf)
                  (b) ATR-zigzag (θ default 1.5-2.5 ATR)   both emit {ts, price, kind, confirmedAt}
                  alternation enforced (same-kind → keep more extreme, demote other to minor)
  ChartDetectors→ predicates over last 5-7 confirmed pivots + OHLC between them
                  (LMW-style E1..E5 inequalities, ATR-normalized tolerances; outer trendlines
                   through pivots scored by touches/containment/ATR-slope)
  StructureRules→ swing structure (BOS/CHoCH), FVG/imbalance, order block, equal H/L,
                  sweep/failed-break, opening range / IB, compression box, NR-n, ORB …
        │
        ▼
  PatternStateMachine per instance: candidate → forming → confirmed → triggered
                                     → resolved-up|down | invalidated | expired
        │
        ▼
  NestingIndex (higher-tf forming/confirmed instances) → parents[] + alignment + levelCoincidence
        │
        ▼
  emit PatternEvent (schema/pattern-event.schema.json) → JSONL per (product, tf, day) [research]
                                                        → Redis PATTERN_EVENTS [live, later]
  + Placebo (OFFLINE, in the labeler — simpler than in-engine and identical in effect): for each real
    event, k time-shifted twins 1-3 sessions later at the same session minute, same direction, all
    levels shifted by Δclose so point distances are preserved (side/ToD/distance-matched null).
```

## 1b. Implementation status (2026-08-18)
- `shared/pattern-engine/`: time.js (ET/session/DST-safe), aggregator.js (session-anchored MTF, emit-at-close,
  partial flush stamped at arrival), features.js, pivots/{fractal,zigzag,track}.js, lifecycle.js (generic
  forming→…→resolved + false-break/throwback/busted), nesting.js, engine.js (roll hard-reset, knowability
  guard on anchors, dedup, context), patterns/README.md (detector contract), patterns/index.js (registry).
- `research/price-structures/engine/run-historical.js` (JSONL.gz per trade date), `test-knowability.js`
  (truncation replay + anchor check — PASS on normal, early-close, DST windows).
- `research/price-structures/analysis/PS_common.py` (1m loader, 1s SecondReader, Labeler with 1s-honest fill
  ordering, placebo twins), `PS-10-label.py`, `PS-20-atlas.py`.

## 2. Language / location decision

- **Detector core in JS** under `shared/pattern-engine/` (ES modules), so the same code runs in
  the historical runner and, later, in data-service/signal-generator (live parity is the point —
  every past "research says X, live says Y" incident in this repo was a parity gap).
  Template: `shared/strategies/ict-mtf-sweep/timeframe-analyzer.js` (incremental, causal).
- **Historical runner** `research/price-structures/engine/run-historical.js`: streams the
  primary-1m cache day by day, drives the aggregators, writes
  `research/price-structures/events/{product}/{yyyy-mm-dd}.jsonl`.
- **Outcome labeling + statistics in Python** (greenfield convention `PS-NN-name.py`,
  `PS_common.py`, `out-PS-NN.txt`), reusing `greenfield/explore/B12_sim.py` for 1s-honest
  trigger→resolution walks and `C1_common.py`/`C2_common.py` placebo/tiling helpers.
- No new npm deps for the core; no external TA lib (TA-Lib rules are transcribed in catalog 02).

## 3. Module sketch (`shared/pattern-engine/`)

```
index.js                     PatternEngine({ product, timeframes, params }) .onBar1m(bar) → events[]
aggregator.js                SessionAnchoredAggregator(tf) — ET anchors, OPEN stamps, emit at CLOSE
features.js                  rolling ATR/median/percentile/tod-tables, EMA slope, structure trend
pivots/fractal.js            k-window with monotonic deque, confirmedAt = close(i+k)
pivots/zigzag.js             ATR-threshold directional change, provisional leg never emitted
pivots/track.js              alternation, minors, bounded history, leg volume
geometry/lines.js            two-touch / outer(envelope) / OLS lines, touches, containment,
                             ATR-normalized slope, apex, width(t)
geometry/prior-trend.js      trend-start search, move/ATR, speed, efficiency ratio
patterns/registry.js         { id, family, tfViability, params, detect(ctx) → candidates,
                               update(instance, bar) → transition|null, levels(instance) }
patterns/candles/*.js        one file per family (doji, hammer-family, engulfing, stars, three-*, inside/outside/NR/WRB, pin-bar)
patterns/chart/*.js          twin-extreme matcher (double/triple/pipe/H&S), slope-sign classifier
                             (triangle/wedge/broadening/rectangle/channel/flag/pennant), cup/rounding,
                             gaps/islands (session-gap variants), measured-move/ABCD, V/spike
patterns/structure/*.js      bos-choch, fvg, order-block, equal-levels, sweep/failed-break,
                             opening-range/IB, compression-box, orb, nr-n, three-push/wedge (Brooks)
lifecycle/state-machine.js   transitions, instanceId, append-only versions, expiry, bust/throwback
nesting/index.js             interval containment against higher-tf live instances
placebo.js                   side-matched synthetic emitter
```

Two design rules from catalog 01 §E that shape the registry:
- **One geometry, many labels.** Compute pivot geometry once; the twin-extreme matcher emits
  double/triple/pipe/H&S labels with discriminating features (`depth/ATR`, `sepBars`,
  `headExcess`, `nTouches`); the slope-sign classifier emits triangle/wedge/broadening/
  rectangle/channel/flag labels from (`upperSlope_n`, `lowerSlope_n`, `Δwidth`, `priorMove`).
  Evaluation decides which labels carry information — no hard-coded exclusivity.
- **Failure states are first-class**: false-break (close back inside ≤3 bars), throwback/pullback,
  single/double bust, partial rise/decline. Bulkowski's best numbers and this repo's own
  sweep-and-fail findings live there.

## 4. Levels contract (per pattern, at every emission)

`trigger` (+side), `invalidation`, `target` (measure rule; expose x·H for x∈{0.5,0.62,1}),
`upper/lower` boundary values at `ts` with ATR-normalized slopes, `midline`, and pattern-specific
`extra` (neckline, apex, prz, ob/fvg bounds, ce). Levels are frozen per emission; later
emissions may update sloped boundaries. Everything in raw contract price.

## 5. Parameters (ATR-scaled; bar-count durations ~constant across tf)

Start from catalog 01 §D table (θ, tol_eq, tol_line, flat-slope, breakout ε, flag pole K/M,
durations, double-top depth/sep, HS shoulder tol/symmetry, throwback window, bust threshold).
Candles: catalog 02 §1.3 (scale = max(ATR20, medRange60); body vs medBody60; tick floors
k_tf×tick; doji = body ≤ 10% own range; ShadowVeryLong = max(2×body, 2/3 range); no shape label
when range < 8 ticks at 1m). Every emitted event carries `geometry.params` (param-set id) so the
pattern×param×tf grid is bookkept for multiple-comparison correction.

## 6. Outcome labeling & probability layer (offline, Python)

For every event at state ∈ {forming, confirmed, triggered}:
1. Which of {trigger, invalidation} is touched first (1s walk from `ts`; B12_sim fill semantics),
   time-to-touch, and then which of {target, invalidation/stop} first after trigger.
2. Fixed-horizon signed returns from `ts` at h ∈ {5, 15, 30, 60, 120} bars of the tf, in ATR.
3. MFE/MAE from `ts` to horizon.
4. Resolution direction (up/down) by target-vs-invalidation or by sign at horizon.
Then per (patternId, state, tf [, direction, context bins]): P(up), P(trigger before invalidation),
P(target|triggered), median MFE/MAE — each vs. the side-matched placebo distribution, per-year
splits (kill criterion: sign-stable ≥5/6 yrs), pooled AND day-weighted, block bootstrap CIs, and
a Reality-Check/DSR-style correction across the grid. Only survivors get a 1s strategy sim
($/yr at 1-5 MNQ per the capacity-constrained target).

## 7. Priors to respect (greenfield C1/C2/A1)

Static geometry (levels, channels, springs, double tests, confluence) tested placebo-equivalent
on NQ; edges came from dynamics (arrival speed, vol expansion) and forced flow. Expectation
management: many chart-pattern *completions* will be placebo-equivalent; the more promising
questions are (a) emerging-state base rates (does a forming X predict which side breaks?),
(b) failure states (busts, failed breaks, partial rise/decline), (c) patterns that encode
dynamics (flag pole speed / efficiency ratio, climax bars, WRB runs), (d) nesting/alignment as
a conditioner. Log it all; assume nothing.
