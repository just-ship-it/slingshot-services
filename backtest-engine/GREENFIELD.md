# GREENFIELD RESEARCH CHARTER (2026-07-16)

Drew's directive: all pre-2026-07-16 research was run on data/engines with lookahead
contamination. **None of it is admissible — not as a prior, not as a pruning device,
not as "we already tried that."** This is a brand-new project against clean data.
The project's only purpose is to find day-trading strategies that make money. If it
can't, it shuts down.

## The line: mechanics carry forward, conclusions do not

**ALLOWED inputs (engineering, not conclusions):**
- `KNOWABILITY.md` — the no-lookahead contract. Non-negotiable.
- The backtest engine itself (`src/`) — fixed and honest as of 2026-07-16.
- CLAUDE.md sections on data mechanics: raw-vs-continuous price spaces,
  `filterPrimaryContract()`, rollover handling, 1s fill rules, slippage model.
- Research *methods*: placebo controls, per-year stability splits, independent
  1s re-implementation before trusting any number.
- Raw datasets listed in the table below.

**BANNED inputs (conclusions from tainted research):**
- `research/**` — every prior study, script output, and episodes file.
- `STRATEGY-GOLD-STANDARDS.md`, `RESTART-PLAN.md`, `data/gold-standard/**`,
  `data/sweep-results/**`, `data/analysis/**`, `data/quarantine-lookahead/**`.
- `shared/strategies/**` as a source of *ideas* (reading them for engine API
  mechanics is fine; importing their entry/exit logic as a hypothesis is not).
- `data/features/**` — ALL derived feature files were built under old assumptions.
- Any strategy name, filter, threshold, or "known edge" from before 2026-07-16.
- Any statement of the form "X was already tested" — it wasn't, not honestly.
- The `~/.claude/.../memory/` directory (main-agent memory; research agents must
  never be given its contents).

## Clean data inventory

| Dataset | Path | Status | Live source? |
|---|---|---|---|
| NQ/ES OHLCV 1s + 1m, raw + continuous | `data/ohlcv/{nq,es}/` | CLEAN (Databento; use raw + `filterPrimaryContract()` for any level work; rollover logs present) | YES (TradingView) |
| QQQ/SPY/VIX OHLCV | `data/ohlcv/{qqq,spy,vix}/` | CLEAN | YES (TV quotes) |
| NQ GEX (causal) | `data/gex/nq/` (804 days, 2023-03→2026-06) and `data/gex/nq-cbbo-causal/` (357 days) | CLEAN — causally regenerated 2026-07-11, prev-day close source | YES (Schwab chains) |
| ES GEX | `data/gex/es/` | **NOT CLEARED** — never causally regenerated; do not use until regen | — |
| Other GEX dirs | `data/gex/nq-cbbo/`, `nq-cbbo-spotfix/` | **NOT CLEARED** (pre-causal) | — |
| GEX (live-captured) | `data/gex/nq-schwab/` | CLEAN by construction (captured live) | YES |
| LT levels | `data/liquidity/{nq,es}/` — level_1..5 columns only | CLEAN (live-captured, knowable at stamp). **`sentiment` column is EXCLUDED** (LS-derived; LS is banned) | YES (LT feed) |
| QQQ ATM IV 1m | `data/iv/qqq/qqq_atm_iv_1m.csv` | CLEAN (as-of interval-END labels, verified 2026-07-16) | YES (Schwab) |
| QQQ IV 15m | `data/iv/qqq/*15m*` | **NOT CLEARED** — predates shared calculator; regen before use | — |
| Options quotes | `data/cbbo-1m/` | CLEAN raw quotes (`ts_recv` is interval-END snapped) | partial (Schwab chains, coarser) |
| Signed options flow | `data/tcbbo/`, `data/flow/`, `data/orderflow/` | Research-only — **NO live source and none will be purchased**; a strategy that needs it cannot deploy, so do not build on it | NO |
| LS state series | `research/lt-extraction/output/*` | **BANNED** — third-party indicator, internals unknown, repeated lookahead incidents | — |

**Deployability constraint (hard):** no new data purchases or subscriptions. A
strategy is only worth building if every input it needs at decision time is on the
"live source = YES" rows above: OHLCV, causal GEX, LT levels, ATM IV.

## Honesty rules (summary — full contract in KNOWABILITY.md)

1. Every time-lookup is at-or-before. A datum is usable only after the instant it
   became knowable (interval-END for bar/snapshot data).
2. Descriptive statistics may use 1m bars. **Any WR / PF / Sharpe / EV-per-trade
   number requires 1s simulation from the fill instant onward** (fills, stops,
   targets, MFE/MAE all walk 1s bars from fill_ts).
3. Raw contracts + `filterPrimaryContract()` for anything touching GEX/LT levels.
   Handle rollovers explicitly (symbol column is truth; roll log has spreads).
4. Costs: limit fills exact; every stop-type exit slips; every market/time exit
   slips. No zero-slip exits anywhere.
5. Level studies must carry placebo controls (round numbers + random offsets) —
   an effect that also shows at placebo levels is not a level effect.
6. Stability: report per-year (minimum) splits for every candidate effect. An
   effect that inverts sign across years is noise, whatever its pooled p-value.
7. Before any candidate is believed: independent small re-implementation on 1s
   must reproduce trade count / WR / PF within ~10%.
8. Pooled vs day-weighted (learned the hard way, B5 2026-07-17): when a signal
   can fire a VARIABLE number of times per day, a day-CLUSTERED mean/t-stat can
   show a strong effect that has NO per-trade (pooled) edge — the reversal lives
   on low-count days while the high-count days that emit most signals go the
   other way. A trader realizes the POOLED expectation. Any census of a
   multi-signal-per-day effect MUST report both pooled and day-weighted means
   and flag divergence; trust the pooled number for tradability.

## Survival bar for a candidate strategy

PF ≥ 1.3 after honest costs, positive every calendar year covered, ≥100 trades,
1s-verified, placebo-controlled if level-based, and all inputs live-sourceable.
Anything below this is not "promising" — it is dead. Do not accumulate a zoo of
almost-strategies.

## Agent protocol

- Research runs in FRESH agents with no prior conversation context. Prompts must
  be self-contained: data paths, formats, this charter, KNOWABILITY.md pointer.
- Agents must not read banned paths. If a banned file is needed for *mechanics*
  (e.g., engine API), the orchestrator extracts the mechanical fact and passes it
  in the prompt instead.
- All greenfield work products live under `backtest-engine/greenfield/` —
  scripts in `greenfield/explore/`, findings as markdown alongside. Nothing is
  written into `research/`.
- The orchestrator (contaminated by prior context) does not propose hypotheses.
  It supplies data, enforces this charter, and adversarially verifies findings.
