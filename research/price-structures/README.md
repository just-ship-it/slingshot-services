# Price-Structure Research Program (started 2026-08-18)

**Goal (Drew):** find out whether any price structure / candle formation carries a probabilistic,
forward-looking edge worth building on. Steps: (1) catalog every common and less-common structure
detectable from OHLCV alone; (2) build a streaming, timeframe-configurable classifier that flags
structures *as they emerge* (a 3m bull flag inside a 15m bull flag must be representable);
(3) estimate P(resolves up / down) per structure × state × timeframe, with the key tradable levels
that validate/invalidate each; (4) only then, strategies.

Honesty contract: `backtest-engine/KNOWABILITY.md` + CLAUDE.md 1s/raw-contract rules. This program
follows the greenfield conventions (`backtest-engine/GREENFIELD.md`) but is allowed to read the
greenfield C1/C2/A1 conclusions as priors (they were produced under the honest engine).

## Layout

```
research/price-structures/
  README.md                       ← this file (charter, plan, decisions, open questions)
  DESIGN.md                       ← engine architecture (data flow, modules, lookahead audit, params, eval)
  schema/pattern-event.schema.json← the detector→probability-layer contract (v0)
  catalog/
    00-master-index.md            ← every structure → canonical primitive, TF viability, evidence, build tier
    01-chart-patterns.md          ← 62 classical chart patterns, code-ready geometry + Bulkowski stats
    02-candlestick-patterns.md    ← 56 candles + 10 modern descriptors, TA-Lib rules, intraday-futures verdicts
    03-school-specific-structures.md ← Brooks, Wyckoff/VSA, harmonics, Elliott/Wolfe, ICT/SMC, Crabel/Raschke/… + equivalence table
    04-detection-methods-and-literature.md ← pivots, pattern matching, libraries, evaluation stats, MTF, streaming
    05-repo-audit.md              ← what already exists in this repo; reuse vs build-fresh
  engine/        (phase 1)        ← historical runner + tests   (core lives in shared/pattern-engine/)
  events/        (phase 2)        ← JSONL pattern events per product/day (gitignored, large)
  analysis/      (phase 3)        ← PS-NN-*.py outcome labeling + probability atlas
```

## What the research says (short version)

- ~200 named structures collapse to **~22 canonical primitives** (pivots, bar features, twin extremes,
  slope-sign shapes, prior impulse, breakout, sweep-reversal, breakout-retest, 3-bar gap/FVG,
  compression, session range, gap event, climax bar, two-leg pullback, three-push, 1-2-3 reversal,
  origin zone, rounded base, regime, fib/harmonic ratios, volume-effort, wave validator) plus 5
  lifecycle meta-states (false-break, throwback, bust, partial rise/decline, expiry). Roughly 40% of
  ICT/Wyckoff/Brooks/Raschke/Williams names are `sweep_reversal` or `breakout_retest` in disguise.
- Evidence for standalone predictive value is thin everywhere: identification is reproducible
  (Lo-Mamaysky-Wang), conditional return *distributions* differ but conditional *means* ≈ 0 in
  liquid indices; H&S is the best-documented and it's small/one-sided; flags after sharp moves are
  the most robust *intraday* result (15m index futures, ~0.25%/trade with vol-scaled SL/TP, after
  Reality Check); candlesticks on 5m futures test null; ORB has academic support (equities); most
  schools (Brooks, Wyckoff, VSA, harmonics, Elliott, ICT) have no published tests at all.
- Bulkowski's own best numbers are *not* textbook completions: single-busted patterns and partial
  rise/decline tells beat the breakouts. Failure states must be first-class in the engine.
- This repo's priors (C1/C2/A1): static geometry on NQ ≈ placebo; dynamics (arrival speed, vol
  expansion, pole speed) and forced flow carried what edge exists. Expect many completions to be
  placebo-equivalent; the interesting quantities are emerging-state base rates, failure states,
  dynamics-encoding patterns, and nesting/alignment as a conditioner.

## Plan

| phase | deliverable | done when |
|---|---|---|
| 0 ✅ | catalog + design + schema (this commit) | — |
| 1 | substrate: ET session-anchored MTF aggregator, bar features, fractal + ATR-zigzag pivots with `confirmedAt`, historical runner over `greenfield/explore/cache/NQ_1m_primary.csv` | **knowability replay test passes**: streaming output at every t == batch output truncated at t; pivots never emitted before `confirmedAt` |
| 2 | Tier-1 detectors (P1–P13) + lifecycle state machine + JSONL events + in-engine side-matched placebo emitter; run NQ 2021→2026 (+ES) at 1m/3m/5m/15m/1h/1d | event counts/day sane vs literature; each pattern's levels reconstructible from anchors |
| 3 | outcome labeler (1s-honest from `ts`, B12_sim semantics) + **pattern base-rate atlas**: P(up), P(trigger<invalidation), P(target|trigger), MFE/MAE per (pattern, state, tf, dir, context) vs placebo, per-year, pooled+day-weighted, DSR-corrected | atlas published; survivors list (sign-stable ≥5/6 yrs, beats side-matched placebo) |
| 4 | nesting/conditioners (parents, alignment, level coincidence, session, vol regime); survivors → 1s strategy sims in $/yr at 1-5 MNQ; live `PATTERN_EVENTS` publisher if anything survives | — |

## Decisions taken (change if you disagree)

1. **Detector core in JS** (`shared/pattern-engine/`) for live/backtest parity; research analysis in
   Python (greenfield convention). No TA-Lib dependency — rules transcribed.
2. **Timeframes** configurable; default set `1m 3m 5m 15m 30m 1h 4h 1d`, aggregation
   **session-anchored ET** (18:00 Globex open anchor; 09:30 as a second anchor for RTH-aligned
   intraday bars, selectable). The existing `candle-aggregator.js` is local-TZ rolling — not reused
   for period boundaries.
3. **All parameters ATR-scaled**, bar-count durations held ~constant across tf; every event carries
   its param-set id (grid bookkeeping for multiple-comparison correction).
4. **One geometry, many labels**: school names are tags on canonical-primitive events; no hard-coded
   exclusivity between sibling shapes.
5. **Both emerging and completed states are logged and evaluated**; placebo events are generated in
   the same code path; side-matched, tiled.
6. Products: NQ primary, ES for replication. Sessions: 24h with session as a context bin.

## Drew's answers (2026-08-18)

1. **24/7** — evaluate all sessions, not just RTH (session is a context bin, never a filter).
2. **Keep ALL structures for the first pass** — the goal is to broadly find which structures
   statistically resolve one way or the other, not boilerplate entries.
3. **Atlas focus: 3m, 5m, 15m, 1h** (all TFs run; these get eyeballed first).
