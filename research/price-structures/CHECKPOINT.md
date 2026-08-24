# Price-structures program — CHECKPOINT (2026-08-19)

Program PAUSED here to pivot to a 1-second / predictive engine. Everything below is finished,
verified, and resumable. Nothing is committed to git yet.

## What exists and is TRUSTWORTHY

| asset | path | state |
|---|---|---|
| Structure catalog (~200 names to 22 primitives) | `catalog/00-master-index.md` + 01-05 | DONE |
| PatternEvent schema | `schema/pattern-event.schema.json` | DONE (v0) |
| Streaming MTF pattern engine, 15 detectors | `../../shared/pattern-engine/` | DONE, knowability gate PASS |
| Knowability replay gate | `engine/test-knowability.js` | PASS (normal / early-close / DST) |
| Event corpus | `events/{NQ,ES}/*.jsonl.gz` | NQ 2021-01..2026-06 (1410 sessions), ES to 2026-01 (1293) |
| 1s-honest labeler + placebo twins | `analysis/PS_common.py`, `PS-10/11` | DONE |
| Base-rate atlas (2.6M events) | `analysis/out/REPORT.md`, `atlas_{NQ,ES}.csv` | DONE |
| Tuning logs (5 strategies, ~1400 variants) | `analysis/tuning/*.md` + `SUMMARY.md` | DONE |
| **Port-parity findings** | `analysis/out/parity/PARITY-FINDINGS.md` | **READ FIRST ON RESUME** |
| 6-strategy book / net-ledger study | `analysis/out/book/BOOK.md` | DONE (optimistic: research trade lists) |
| Engine additions | `place_stop`, `place_stop_limit` in trade-simulator + tests | DONE, 11/11 tests |
| Live additions | place_stop/place_stop_limit to Stop/StopLimit, cancelOnCloseBeyond, exemptEodCutoff | DONE, suites green |
| Ported strategies | `shared/strategies/pattern-{hs-top,fvg-bear,retest-long}.js` | hs-top VOID, fvg-bear blocked, retest-long unfinished |

## Verdicts at pause (do NOT re-derive)

- **hs-top: DEAD.** Research edge was a fill fantasy (sold at necklines price had already passed;
  88% of PnL). Valid-stop subset matches the engine exactly but is only ~$2k/yr.
  *Strongest motivation for the tick engine: the signal was right, we were late.*
- **fvg-bear: edge REAL but uncapturable today.** Honest re-test PF 1.43 / $82k/yr. 100% of PnL sits
  in 736 trades the engine cannot take because engine+orchestrator allow ONE working order at a time.
  Needs multi-concurrent working orders (first-fill-wins + sibling cancel).
- **retest-long: unfinished.** Causal bar-close port = PF 1.08 / $9.3k/yr. `place_stop_limit` was
  built to recover the research's intra-minute fills; parity re-run killed at the pivot.
  Resume: switch the strategy to place_stop_limit at emission, re-run full period with
  `--allow-overnight-holds --slippage 0.25 --stop-slippage 0.5`.
- **STRICT-1 net ledger (independent of the above): same PnL as today's FCFS gate at -34% maxDD.**

## Methodology that carries forward

1. Port-parity BEFORE believing any edge (caught 3 distinct classes of overstatement).
2. Research sims overstate when they: fill at levels price already passed; apply entry filters
   post-hoc to an FCFS list; assume order concurrency the execution path lacks.
3. Side-matched placebos, per-year sign stability, dev/val split with untouched holdout.
4. 1s-honest fills from the decision instant.
