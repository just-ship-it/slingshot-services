# Tick Engine — built 2026-08-19/20

1-second decision engine with a predictive conditional-trigger layer. Design rationale: `DESIGN.md`.
Broker capability map: `BROKER-CAPABILITIES.md`. Overnight results: `RESULTS.md`.

## Layout

| file | what |
|---|---|
| `build-cache.js` | CSV → columnar binary 1s cache, primary-contract filtered, rollovers recorded |
| `verify-cache.js` | invariants + day-index + exact spot-check against the source CSV |
| `cache.js` | loader (typed arrays; no per-bar objects, ever) |
| `watch-index.js` | price-bucketed conditional-trigger index — the hot structure |
| `tick-core.js` | cursor, session tracking, incremental MTF aggregation, per-second watch evaluation |
| `broker.js` | honest fill simulation: resting stop/limit/stop-limit, latency budget, N concurrent orders |
| `test-replay.js` | knowability gate — a truncated run must be a byte-exact prefix of the full run |
| `bench-tick.js` | throughput benchmark |
| `lib-fvg.js` / `sweep-fvg.js` | FVG strategy + dev/val parameter sweep |
| `lib-hs.js` / `run-hs.js` | head-and-shoulders, classic vs predictive formulation |
| `lib-retest.js` / `run-retest.js` | twin-extreme retest continuation (native stop-limit) |
| `lib-orb.js` / `run-orb.js` | opening-range breakout — the latency-cost experiment |
| `run-pcc.js` | cross-validation against the live book's PCC |

## Cache

```
node build-cache.js --product NQ     # 73M source rows → 67.6M primary bars, ~75s
node verify-cache.js NQ 12
```
Columns: `ts.i32` (epoch seconds), `o/h/l/c.i32` (**integer ticks** — exact, integer compares),
`v.i32`, `sym.u8`; `meta.json` carries the symbol table, per-trade-date row ranges and rollovers.
NQ 67,579,889 bars (1400 sessions, 2021-01-17→2026-06-15) ≈ 1.6 GB.
ES 55,552,225 bars (1293 sessions, 2021-01-26→2026-01-25) ≈ 1.3 GB.

## Measured performance (full NQ history, this box)

| live watches | timeframes | throughput | full history | slot checks/bar |
|---|---|---|---|---|
| 0 | 1 | 22.7M bars/s | 3.0 s | 0 |
| 8 | 1 | 10.5M bars/s | 6.4 s | 1.0 |
| 128 | 3 | 8.2M bars/s | 8.2 s | 2.6 |
| 2048 | 3 | 3.2M bars/s | 21 s | 19.9 |

The old bar-close engine took ~20 minutes for one full-history 1m run. This is ~8 seconds at 1-second
resolution — and a 432-config dev sweep finishes in about half an hour.

## Honesty guarantees

1. **Replay gate** (`test-replay.js`): state at T is a pure function of bars ≤ T; a truncated run
   must be a byte-exact prefix of the full run. PASS at every cut.
2. **Orders that could not exist do not fill.** A sell-stop requires the market above it at
   placement; a sell-limit requires the market below. Wrong-side placement degrades to a market
   order and is counted (`rejected.wrongSide`) — this is exactly the fantasy that inflated the
   bar-close hs-top research by 8×.
3. **Stops chase, limits improve.** Stop fills take slippage and never get price improvement on a
   gap; limits fill at their price or better.
4. **Resting vs reacting is explicit.** Broker-resting orders fill at the level. Software-reacted
   decisions pay `reactionSec` and cannot fill before it elapses.
5. **Adverse-first within the second.** 1s OHLC does not order H and L: stop before target, void
   before arm.
6. **Validated against two independent implementations** — the bar-close pattern engine and the
   greenfield Python harness (see `RESULTS.md` §1).
