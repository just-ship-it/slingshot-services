# JV-ICT Implementation Notes (2026-07-22)

Implementation: `shared/strategies/jv-ict.js` (`JvIctStrategy`, strategy name `jv-ict`, alias `jvi`).
Registered in `backtest-engine/src/backtest-engine.js` (`createStrategy`) and `backtest-engine/src/cli.js`
(`--strategy` choices). NOTE: alias `jv` was already taken by the contaminated `ict-mtf-sweep` —
this implementation uses `jv-ict`/`jvi` and shares no code with any `ict-*` path.

Also added a generic `--strategy-json '<json>'` CLI flag (merged into strategy params before
strategy-specific flags) — no per-param flags existed for new strategies.

## Spec conformance

Implements 02-STRATEGY-SPEC.md §1–§6 defaults: 15m run TF, PIVOT_N=2 confirm-lagged fractal
pivots, close-based structure breaks, wick-qualifying sweeps of the most recent unbroken confirmed
swing high/low plus PDH/PDL, O re-anchoring, MSS on close beyond O, 40-bar sweep→MSS timeout,
body-to-body fib (fib100 = extreme-bar body, fib0 = min/max body over leg per pseudocode §5),
3-bar wick-gap IMBs with close-beyond-far-edge consumption, last-opposite-close-candle OB
(full range), confluence/bias/session gates, resting limit entry, stop at extreme ± 1pt,
TP at leg terminus ± 1 tick, MAX_STOP_PTS 50, TTL 24 bars, pre-fill cancels, both models
concurrent, 1 contract, no BE/trailing/scaling. EOD flat via `--eod-cutoff-et 15:45`.

## Deviations / resolutions vs spec

1. **Continuous data, not raw contracts.** Spec §heading says raw + `filterPrimaryContract()`;
   task directive overrides: pure price action, all levels self-derived → continuous is correct
   per repo rules (avoids rollover state-flush complexity; spec §1 rollover rules are therefore
   moot). Continuous 1m pairs with continuous 1s automatically in the engine.
2. **Default entry level is pure 70.5% (`entryLevel:'optimal'`).** Spec §4.3/A6 default snaps to
   `max(level(.705), IMB proximal edge)`; the task's axis definition names pure 70.5% as default.
   The snap variant is implemented as `entryLevel:'imbEdge'` and run as an axis.
3. **fib0 = min body over the whole leg** (pseudocode §5 `minBody(NH.bar..b)`), not "body of the
   leg-low bar" (§3 prose). Where the lowest-low bar and lowest-body bar differ, pseudocode wins.
   TP however uses the wick extreme (`legLow + 1 tick`) exactly per §4.5 — the "(0% fib)" gloss
   in §4.5 is approximate; wick low ≠ fib0 (body).
4. **O re-anchoring (A13):** re-anchor to a newer confirmed opposing swing only when it formed
   at/before the running-extreme bar (a low formed after NH cannot have "caused" it) AND it is on
   the pullback side of the current O (higher low for M, per §4.1 prose "forming above O").
   Bare pseudocode (`if newConfirmedSwingLowSince(O): O = it`) would let mid-decline lows ratchet
   the MSS trigger toward price; the constrained version matches the book's causal-low intent.
5. **Pivot usable at its confirmation close** (spec: "confirmed at close of bar i+PIVOT_N") —
   a pivot confirming on the MSS bar itself can re-anchor O on that same close (pseudocode order
   `updatePivots(b)` then `step(model, b)`). A same-bar-confirmed swing high can never be swept by
   the same bar (its high must exceed the current bar's high by definition).
6. **Broken-swing marking runs AFTER the model step** each bar: a close-through sweep bar still
   sees its level as "most recent unbroken swing high" (the level existed at the prior close);
   the close-through then breaks it for subsequent bars.
7. **`biasMode:'pdhpdl'` interpretation** (task axis, not defined in spec): genuine break of the
   prior-day range in the trade direction — shorts require MSS close < PDL, longs > PDH (book p5:
   full body close through PDH/PDL = genuine break). Documented as an interpretation choice.
8. **Both models firing on the same bar:** single position slot → deterministic M-first, W setup
   discarded (counted in `both_models_same_bar`; 0 occurrences in dev).
9. **Setup consumption:** the sweep is consumed (state → IDLE) once the MSS bar is processed,
   whether or not a signal was emitted or the simulator accepted it. Matches "the same sweep may
   not be re-traded".
10. **PDH/PDL warmup:** the first (partial) trading day in the data window never seeds PDH/PDL or
    Daily Open; a day only counts if its first bar is the 18:00 ET session open. Bias-gated
    setups during warmup are rejected (`bias_warmup`).
11. **Time base:** trading-day keying uses bar START time (18:00 ET boundary); session gate and
    TTL use bar CLOSE time (placement happens at the close). Run-TF duration is inferred from
    minimum bar spacing (no hardcoded 15m).

## What `stopMode:'close'` actually does in this engine (A7)

Checked `trade-simulator.js` directly:

- The simulator's `stopCheckMode:'close'` signal field makes `checkStopHit()` compare
  `candle.close` (instead of wick) against the stop — **but under 1s execution the candle is a
  1s bar**, so "close" means *any 1s bar closing beyond the stop*. That is functionally a hard
  stop with ~1s confirmation, NOT the book's 15m-close-confirmed stop. It is therefore NOT used.
- `softStopPoints` is a PnL-from-entry check evaluated **once per minute candle close** (in
  `updateTradeWithSecondResolution`'s tail), exiting at market with market slippage. This is the
  closest close-confirmed mechanism the engine offers (1m closes, not 15m).
- **Implemented 'close' mode:** `softStopPoints = structural stop distance` (entry is a fixed
  limit so PnL-distance ≈ level-based; price-improved gap fills shift it slightly) **plus a
  catastrophic wick-based hard `stop_loss` at 2× the structural distance**
  (`closeStopCatastrophicMult`, spec A7 alternative). Bounded intrabar risk is preserved; the
  trade survives wicks through the structural level unless a 1m bar closes beyond it.

## Pre-fill cancellation semantics

`shouldInvalidatePendingOrder` is invoked once per closed run-TF candle, AFTER that period's
1m/1s fill processing and BEFORE `evaluateSignal` — i.e., an order that fills mid-period is no
longer pending when the cancel check runs, and cancels evaluate the just-closed candle. Cancels:
(a) close beyond sweep extreme, (b) close beyond leg terminus pre-fill, (c) TTL
(24 × run-TF bars, wall-clock), (d) session end — any run-TF close at/after 15:30 ET (< 18:00)
cancels, plus a trading-day-rollover backstop. Engine-side `timeoutCandles`/`maxHoldBars` are
set to 0 (they count 1m bars, not run-TF bars, in this engine; TTL is handled in-strategy).

## Gate rejection stats (dev period 2021-01-18 → 2024-12-31, defaults)

Full-period funnel: 6,025 sweeps → 4,613 MSS (1,411 sweeps timed out) → rejections at setup
build: session 1,585, confluence 1,189, bias 1,108, stop-width 340, degenerate 3 → **386 signals
→ 137 fills** (~35% fill rate; rest cancelled pre-fill via extreme-break / leg-break / TTL /
session end). No gate is degenerate-binding; per-gate counts scale sanely across axis variants
(conf=none → 548 signals; bias=none → 632). Full table in 04-DEV-RESULTS.md.

## Verification performed

1. Smoke run 2024-03-01→2024-04-30: 8 signals, 5 trades, engine completes clean.
2. **Independent re-derivation:** fresh Python implementation of the spec (scratchpad `audit.py`)
   over raw 1m continuous CSV reproduced **8/8 signals with identical entry/stop/TP, fib anchors,
   O, sweep extreme, OB zones and timestamps**. One fully hand-worked example in 04-DEV-RESULTS.md.
3. **Lookahead sniff:** every metadata timestamp (sweep, causal swing, extreme, MSS, leg terminus,
   IMB, OB) ≤ signal close time on all trades; fills strictly after signal time. 0 violations.
4. 1s-honesty: continuous 1s file starts 2021-01-18 → dev runs start there (not 2021-01-01);
   engine 1s replay drives all fills/exits (no `--minute-resolution`).
