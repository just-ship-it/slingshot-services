# KNOWABILITY — the data contract (2026-07-16)

**The invariant (Drew, 2026-07-16):** a time lookup can NEVER know something in the
future. Every timestamp lookup anywhere in the backtest engine must resolve to the
MOST RECENTLY KNOWABLE datum at the query instant.

**The contract, stated precisely:**
1. **Point/event data** (GEX snapshots, IV rows, LT feed rows, state flips, levels):
   the row's stamp must equal the instant the value became observable in live trading
   ("as-of" labeling). All lookups are at-or-before on that stamp, optionally with a
   staleness cap. Never nearest-by-absolute-distance; never a future fallback.
2. **Bar-shaped data** (OHLCV, per-bar aggregates like book-imbalance/CVD/s1-VWAP):
   stamped at bar OPEN by convention, representing [T, T+bar). May only be consumed
   at or after the bar's CLOSE. The engine's evaluate-at-close path satisfies this;
   any sub-bar or at-open consumer must shift explicitly.
3. **Loader-derived fields** (e.g. adverseFlipTs) are data too: any timestamp a
   loader computes from other rows must itself be knowability-shifted. This is where
   the LSTB lookahead lived — audits had covered series, not derived fields.
4. **New series entering the engine get a knowability audit BEFORE any strategy
   consumes them** (standing pilotfish rule, now extended to derived fields), stating:
   stamp meaning, knowable-at instant, live emission timing, and evidence.

## Incident log (why this file exists)

| date | series/path | defect | impact |
|---|---|---|---|
| 2026-05-06 | stats-GEX intraday | snapshot buckets held T+14:59 data (later: EOD close IV) | GFI void (PF 3.39→0.98), ISG re-based |
| 2026-07-12 | qqq_short_dte_iv 15m | floor-labeled buckets = up to 15m IV foresight | SDIV void (PF ~1.6→0.80) |
| 2026-07-13 | nq_ls_15m stamps | dumper stamps bar OPEN; state seals at CLOSE | ltAlign retired (all ltAlign golds void) |
| **2026-07-15** | **adverseFlipTs (LS 1m loader-derived)** | **cancel at next flip's OPEN stamp = 60s foresight** | **ALL LSTB golds void; honest PF 1.31→0.87; book emptied** |

## Audit results + fixes applied 2026-07-15/16 (all uncommitted)

**Fixed — true lookahead in live code paths:**
1. `backtest-engine.js _loadLs1mFile` — `adverseFlipTs = next stamp + LS_1M_KNOWABLE_OFFSET_MS (60_000)`.
2. `backtest-engine.js` ltLevels lookup — was nearest-by-|Δt| within ±15min (could bind a FUTURE row); now at-or-before with 15min staleness cap.
3. `trade-simulator.js getClosestCalendarSpread` — same nearest-|Δt| pattern on rollover conversion; now at-or-before (conversion may fail slightly more near rolls; preferable to foresight).
4. `backtest-engine.js` FVG candle slice — included the still-forming 15m bar with its final OHLC (≤15min intra-bar future); now only 15m bars whose close ≤ evaluation instant.
5. `data-loaders/gex-loader.js getGexLevels` — removed the (never-used) allowInterpolation fallback that returned the NEXT snapshot when no prior existed.

**Fixed — mislabeled data (SDIV-class traps):**
6. `data/iv/qqq/qqq_atm_iv_1m.csv` (+60s) and `qqq_atm_iv_15m.csv` (+900s) relabeled
   to as-of bucket-END stamps (backups: `*.floor-labeled-bak`). Consumers (ISG, GFI)
   were close-evaluated and thus consistent in the standard path, but the labels
   violated the contract and were one `sameCandleFill`-style change away from another
   SDIV. NOTE: any re-run of `precompute-iv.js` will regenerate floor labels — port
   the `Math.ceil` as-of labeling from `precompute-short-dte-iv.js` before rerunning.

**Verified clean (as-of / at-or-before / properly shifted):**
- GEX `nq-cbbo-causal` (causal regen, bucket-END labels) and `nq-cbbo` (+15m relabel).
- ls15Sentiment (knowableAt = stamp−15m... i.e., exposure only from stamp+15m onward), es15 clearpath (as-of rebuild), dwf_levels (daily ≥09:45 ET), charm-vanna daily (loader stamps 16:00 ET), swing pivots (confirmedAt-gated — the model implementation), IV/short-DTE loaders (at-or-before), cbbo metrics (at-or-before, spread-change strictly past), lt-1m + lsState1m exact-match at bar open consumed at bar close (knowable-consistent), book-imbalance/trade-ofi/s1-vwap (bar-shaped, consumed at close), OHLCV (bar-shaped).

**Known residual caveats (documented, not code-fixed):**
- FVG objects are *dated* at the middle candle though confirmable one bar later. With
  fix #4 the runtime slice is causal (a gap can only appear after its confirming bar
  closes), so no foresight — but the `timestamp` field understates age by one bar.
  If FVG work resumes, add `confirmedAt` like swing pivots.
- Live LT 1m feed emits PROVISIONAL forming-bar levels at bar open; the dumped CSV
  holds sealed close values. Backtests consuming lt-1m are honest at close, but live
  GLX-style consumers act on provisional values — a live-vs-backtest parity gap (not
  a lookahead). Resolve before GLX returns: either gate live on bar close or dump
  forming values for the backtest.
- `NQ_liquidity_levels.csv` sentiment column 2026-05-12→05-18 is backfilled from LS15
  (see lt-sentiment-is-ls15 memory); rows are otherwise live-captured (knowable at stamp).

## Consequences for existing results

Every LSTB number generated before 2026-07-15 is void (see
`research/vp-defended-wick/REPORT.md` Part 3). Honest full-window LSTB = 16,298tr /
WR 43.9% / PF 0.87 / −$304,128. The production book contains NO tradable strategies.
All other strategy golds should be regenerated under this engine before any re-use;
treat every pre-2026-07-16 JSON in `data/gold-standard/` as historical reference only.
