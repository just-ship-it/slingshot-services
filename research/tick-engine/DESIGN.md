# Tick Engine — 1-second decisions with a predictive (conditional-trigger) layer
Design v0, 2026-08-19. Supersedes the bar-close evaluation model for new strategies.

## Why (evidence, not vibes)

The port-parity work on the price-structures program produced the exact diagnosis Drew described:

- **hs-top died of latency, not of a bad hypothesis.** 44% of its signals arrived at a 5m bar close
  *after* price had already traded through the neckline. Where the level was still available, the
  research and the honest engine agree to 2% (1.83 vs 1.80 pts/trade) — the structure predicts; we
  were simply late. 88% of its paper PnL was the simulator pretending we got a price that was gone.
- **fvg-bear's whole edge (100% of PnL, 736 trades) sits in setups our execution path can't hold**,
  because it allows one working order at a time.
- **retest-long lost half its edge** to the same class of problem (limit needed to be live at the
  break instant, not at the next bar close).

Three strategies, three different symptoms, one cause: **decisions are made on a clock instead of
on price, and orders are placed after the fact instead of in advance.**

## The core idea: compile structures into conditional triggers

A structure that is *not yet complete* is not "nothing" — it is a **predicate over future price**:

> IF price trades to A before it trades to B, the structure is confirmed.

That single object — call it a **Watch** — is simultaneously:
1. the **predictive layer** (we know what completion looks like before it happens),
2. the **hot path** (checking `high >= A || low <= B` is two comparisons per bar), and
3. the **execution plan** (A is usually exactly where the order belongs).

```
Watch := {
  id, structureId, tf-context,
  armIf:      { side: 'above'|'below', price: A },     // completion / trigger
  voidIf:     { side, price: B } | { atTime },          // invalidation
  onArm:      Action,                                   // emit signal | spawn child watches | place order
  restingOrder?: { type: 'stop'|'limit'|'stop_limit', ... }   // pre-positioned at the broker
}
```

Structures become **state machines whose transitions are price levels**, not bar closes. A double
top mid-formation spawns: "if high re-enters [peak1−tol, peak1+tol] → arm child watch: if low breaks
trough before high exceeds peak1+tol → CONFIRMED, sell the trough break." Every arrow is a Watch.

### The most important consequence: pre-position, don't react

Reacting in software — feed → decode → decide → order → exchange — is 10s-100s of ms. That race is
lost to HFT by construction and **we should stop entering it**. A Watch whose `armIf` level is known
in advance becomes a **resting broker-side conditional order** (stop / stop-limit / limit) sitting at
the exchange. Fill latency: zero. We are not faster than an HFT; we are *already there*.

This is the actual "modern" upgrade: the engine's job is to decide **where orders should already be**,
continuously, and to move them as structures evolve. Software reaction is the fallback for triggers
that can't be expressed as an order (multi-leg conditions, time-based, cross-instrument).

## Architecture

```
1s bars (live feed / historical binary cache)
        │  single monotonic time cursor; never reads ahead
        ▼
┌─ TickCore (zero-allocation hot loop) ─────────────────────────────┐
│  columnar state: ts/o/h/l/c/v as typed arrays                     │
│  rolling features updated incrementally (ATR, EMA, extremes,      │
│    session stats, running VWAP) — O(1) per tick, no rescans       │
│  WatchIndex: watches bucketed by price → only those whose level   │
│    lies within [low, high] of this bar are examined  (O(log n))   │
│  provisional structure state machines (pivots, legs, boxes)       │
└───────────────────────────────────────────────────────────────────┘
        │ armed watches
        ▼
  Signal / OrderIntent  ──►  (backtest) fill simulator  |  (live) order router
```

**Same core object in both paths.** Backtest and live differ only in the bar source and the sink.
This is the parity guarantee; the last three strategies all failed for want of it.

### Measured feasibility (real NQ 1s data, this machine)

| live watches | throughput | full-history (90M bars) |
|---|---|---|
| 8 | 15.7M bars/s | **5.7 s** |
| 32 | 7.1M bars/s | 12.6 s |
| 128 (naive linear scan) | 1.9M bars/s | 47.6 s |

JS + typed arrays is sufficient; **no Rust/C++ needed.** The 128-watch row is the naive O(watches)
scan — the price-bucketed WatchIndex removes that slope, so hundreds of concurrent watches stay
near the 8-watch number. Binary columnar cache: 90M bars × 24 B ≈ **2.2 GB**, fits in RAM (31 GB),
loads by mmap in ~1 s vs ~60 s of CSV parsing. Research iteration goes from ~20 min/full run to
~10 s — a 100× loop speedup, which matters more than any single strategy.

## Honesty rules (carried over, tightened for sub-minute)

1. **Cursor discipline**: state at time T is a pure function of bars ≤ T. The truncation-replay gate
   (`test-knowability.js`, already built) generalizes directly: run to T, compare against the full
   run truncated at T — must be byte-identical.
2. **Intra-second ambiguity is real and must be assumed adverse.** A 1s bar gives O/H/L/C but not the
   order of H and L. Rules: our stops/adverse events resolve first; our targets/favorable events
   resolve last; a watch and its void level touched in the same second → **void wins**. Same
   conservative convention the labeler already uses.
3. **Latency budget is explicit, not assumed zero.** Every software-reacted signal carries a
   configurable `reactionLatencyMs` (default 250 ms live-realistic) applied in the simulator; only
   broker-resting orders may fill at the level. This is the discipline that would have caught
   hs-top's fantasy fills automatically.
4. **Orders that could not exist don't fill.** A sell-stop is only valid if the market is above it at
   placement; a resting limit only fills after it has been resting. Enforced in the simulator, not
   by convention.

## What we keep from the price-structures program

The catalog (~200 structures → 22 primitives), the detector geometry, the labeler, the placebo /
per-year / dev-val methodology, the event corpus and atlas as priors, and the parity discipline.
What changes is **when** a structure is evaluated (every second, provisionally) and **how** a decision
becomes an order (pre-positioned conditional, not post-hoc reaction).

## Build order

| phase | deliverable | gate |
|---|---|---|
| T1 | binary columnar 1s cache + loader (NQ full history, ES next) | 90M bars load < 2 s; spot-check vs CSV |
| T2 | TickCore: cursor, rolling features, WatchIndex, replay-truncation gate | gate PASS; ≥5M bars/s at 32 watches |
| T3 | Watch compiler for 3 primitives (twin-extreme, FVG, break-retest) + provisional pivots | structures fire at the level, not the bar close |
| T4 | Fill simulator with latency budget + resting-order semantics + multi-concurrent orders | reproduces the honest fvg-bear number (PF ≈1.43) |
| T5 | Re-run the three parked strategies as tick strategies | beat their bar-close ports; hs-top revisited with real fills |
| T6 | Live adapter: same core behind the 1s feed; STRICT-1 net ledger; shadow | live-vs-sim fill parity on a clean month |

## Open questions for Drew

1. **Instrument scope** — NQ only first (fastest path), or NQ+ES from T1?
2. **Live feed shape** — we get 1s OHLCV today. Do we also have (or want) quote/BBO updates? The
   design works on 1s bars; quotes would let watches fire on the touch rather than the second-close.
3. **Broker order palette** — confirm on the demo account which conditional types Tradovate accepts
   for entries (Stop, StopLimit verified in code; OCO/bracket-with-stop-primary unverified). The
   more of the Watch vocabulary the broker can hold, the less we race.
4. **Do we keep the current bar-close book running** (PCC / Monday / gap-fade are daily-clock
   strategies and are unaffected by this) while the tick engine is built? Recommend yes.
