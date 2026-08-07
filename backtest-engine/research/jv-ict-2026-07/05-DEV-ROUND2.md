# JV-ICT Dev-Period Results, Round 2 (2026-07-23)

Extends 04-DEV-RESULTS.md. Same dev window (**2021-01-18 → 2024-12-31**, 2025+ locked/untouched),
same honest flags on every run: `--ticker NQ --eod-cutoff-et 15:45 --slippage 0.25
--stop-slippage 0.5 --strict-fill` (1s execution on, continuous data), 1 contract, $ = NQ $20/pt.

## New code (shared/strategies/jv-ict.js)

1. **`biasMode: 'htf1h'`** — book-faithful HTF-structure bias (eBook p33 #1: "1HR and 4HR control
   intraday structure. Always align lower timeframe trades with higher timeframe structure").
   1H candles are aggregated internally from run-TF candles via `CandleAggregator.addCandleIncremental`;
   only **fully-closed** 1H bars are consumed (a 1H bar is usable at the run-TF close that equals its
   period end — every constituent bar is closed at that instant; no in-progress 1H bar ever
   influences a decision). On closed 1H bars the exact run-TF structure discipline runs:
   pivotN(2)-lagged fractal pivots, close-confirmed breaks of the most recent unbroken confirmed
   swing, broken-marking after break detection. **1H structure state = direction of the last
   confirmed break** (bullish/bearish, null until first break → `bias_warmup`). Gate: M shorts
   require 1H bearish, W longs require 1H bullish. `biasMode:'htf4h'` exists as a diagnostic
   (unused this round — htf1h did not collapse trade count). 4h-period alignment inherits the
   aggregator's local-clock boundaries (ET, whole-hour offset; 1h alignment is tz-invariant).
2. **`sides` param** — `'both'` (default) | `'long'` | `'short'`, overrides allowShorts/allowLongs.
3. **`entryStartMin` / `entryEndMin`** — optional narrower SIGNAL-EMISSION window (ET minutes)
   inside the session; pending-order lifecycle (fills/cancels) still runs to `sessionEndMin`.
4. Signal metadata now records `htf_structure` at emission.

**Verification:** smoke run (2024-03-01→04-30, htf1h): 6 signals / 5 trades (round-1 default smoke:
8 signals), every trade's `htf_structure` matches its side. **Independent re-derivation**
(scratchpad `htf_audit.py`): fresh Python 1H aggregation from the raw 1m continuous CSV + own
pivot/break machine reproduced the engine's structure state at all 5 MSS times — PASS.

## Run table (dev 2021-01-18 → 2024-12-31)

| run | tf | config | sig | trades | WR | PF | maxDD $ | net $ |
|---|---|---|---|---|---|---|---|---|
| a | 15m | bias=**htf1h** | 285 | 112 | .420 | 1.05 | 11,365 | +2,075 |
| b | 15m | bias=**htf1h** + conf=imb | 127 | 41 | .439 | 1.18 | 5,760 | +2,565 |
| c | 5m | defaults | 1,428 | 399 | .404 | 1.00 | 16,375 | +270 |
| d | 5m | conf=imb | 854 | 195 | .390 | 1.04 | 14,115 | +2,805 |
| e | 30m | conf=imb | 75 | 24 | .375 | 0.80 | 6,025 | −2,100 |
| f | 15m | conf=imb, entries 09:30–12:00 ET | 103 | 36 | .444 | 1.40 | 6,775 | +5,155 |
| g | 15m | **POST-HOC**: sides=long + conf=imb + entry=premium | 123 | 30 | .533 | **2.07** | **2,040** | +8,235 |
| h | 5m | **POST-HOC**: same compound | 472 | 82 | .341 | 0.91 | 6,285 | −2,385 |

Round-1 anchors: default 15m PF 1.04 (137 tr), conf=imb 15m PF 1.44 (52 tr).

## Per-year PF (n) — 2024 in bold

| run | 2021 | 2022 | 2023 | **2024** |
|---|---|---|---|---|
| a htf1h | 1.42 (29) | 1.42 (16) | 1.09 (37) | **0.63 (30)** |
| b htf1h+imb | 2.36 (12) | 3.21 (5) | 0.90 (13) | **0.40 (11)** |
| c 5m default | 0.74 (122) | 0.95 (98) | 1.08 (94) | **1.39 (85)** |
| d 5m imb | 0.82 (62) | 0.81 (41) | 1.10 (49) | **1.68 (43)** |
| e 30m imb | 0.24 (6) | 0.16 (8) | 4.89 (6) | **1.01 (4)** |
| f imb 09:30–12:00 | 2.64 (7) | 6.28 (8) | 0.62 (10) | **0.24 (11)** |
| g compound 15m | 1.79 (8) | 2.38 (5) | 2.25 (11) | **1.67 (6)** |
| h compound 5m | 1.00 (34) | 0.50 (12) | 0.77 (20) | **1.37 (16)** |

Side splits (where informative):

| run | M-short PF (n) | W-long PF (n) | notes |
|---|---|---|---|
| a htf1h | 1.03 (48) | 1.07 (64) | htf gate evens the sides but lifts neither |
| b htf1h+imb | 0.79 (20) | 1.73 (21) | longs again carry it; W 2024 = 0.03 (2) |
| c 5m default | 0.98 (209) | 1.04 (190) | both flat |
| d 5m imb | 1.01 (110) | 1.10 (85) | W 2024 = 2.21 (19), W 2021-23 ≤ 0.92 |
| f imb-am | 1.11 (18) | 1.83 (18) | M 2024 = 0.03 (8) |

## Gate funnels — htf1h runs

Gate order in `_buildSetup` is confluence → bias → session, so counts are order-dependent.
Sweeps/MSS identical to round-1 default (same detector): 6,025 sweeps → 4,613 MSS, 1,411 timeouts.

```
run a (htf1h):            confluence_fail 1,189 | bias_fail 1,864 | bias_warmup 0
                          session_fail 1,073 | stop_too_wide 197 | signals 285 -> 112 filled
run b (htf1h + imb):      confluence_fail 2,645 | bias_fail 1,059 | bias_warmup 0
                          session_fail   669 | stop_too_wide 110 | signals 127 ->  41 filled
```

htf1h is a stricter directional gate than dailyOpen (a: 1,864 rejects vs 1,108 in round-1 default)
but nowhere near strangling — 112 trades (~28/yr). No 4H diagnostic needed.

## Honest assessment

**1. Does the book-faithful HTF bias fix 2024? No.** htf1h lands between bias=none (0.99) and
dailyOpen (1.04) on aggregate (1.05) and its 2024 is 0.63 / 0.40 (with imb) — same failure as every
round-1 config. Alignment with causal 1H structure is a real, correctly-causal implementation of
the book's #1 rule and it changes nothing material. The 2024 problem is not a bias-definition
problem.

**2. Does 5m recover trade frequency, and does the edge survive? Frequency yes (~100 fills/yr,
~3x the 15m rate — the "source trader trades daily" gap is mechanically closable), edge no
(PF 1.00/1.04).** Worse than neutral, actually: **the per-year profile INVERTS with timeframe.**
15m variants are 2021-22-strong / 2024-dead; 5m variants are 2021-22-dead / 2024-good
(d: 1.68 in 2024 after 0.82/0.81 in 2021-22); 30m is dead everywhere except a 6-trade 2023.
The same mechanical setup produces opposite year-rankings at adjacent timeframes. That is the
signature of a model whose fixed geometry (50-79% band, 50-pt stop cap, 40-bar timeout) resonates
with whichever noise regime matches its scale — not of a mechanism that transfers.

**3. Is the compound just dev-fitting? Yes — by its own cross-TF test.** Run g (long+imb+premium,
15m) is the prettiest table in the program: PF 2.07, 4/4 positive years, 2024 = 1.67, maxDD $2,040.
But (i) it is the intersection of three axes each selected AFTER seeing round-1 results, on 30
trades (~7.5/yr — below any deployable bar); (ii) run h applies the identical compound at 5m,
where the ingredient observations (imb helps, longs carry, premium best) were supposed to be
structural, and gets **PF 0.91 with 2022/2023 losing**. A real mechanism thinned to its best
expression should degrade gracefully across scale, not flip sign. Verdict: g is curve-fit residue
of NQ long drift plus small-n luck, and it does not earn a locked-set run.

**4. Session probe:** restricting emission to 09:30–12:00 (f) concentrates the same 2021-22 PnL
(6.28 in 2022) and makes 2024 WORSE (0.24). Morning-only is not the missing killzone ingredient.

**Alive check (≥3/4 positive years incl. 2024, PF ≥ 1.3, sane DD): nothing honestly passes.**
Run g passes numerically but is post-hoc, n=30, and refuted by its own 5m replication — reporting
it as alive would be exactly the dev-fitting this program's rules exist to prevent.

**What are we still missing vs the source trader?** Ranked hypotheses:
1. **Discretionary setup selection.** Our detector finds ~1,500 sweeps/yr and mechanically trades
   whatever passes gates; the trader hand-picks a handful of "obvious" pools (clean equal
   highs/lows, session extremes) per day. No round-1/2 gate is a proxy for chart-reading
   selectivity, and every attempt to approximate it by re-slicing price (confluence, bias, depth,
   session, TF) has failed the 2024 test. This is now the default explanation.
2. **Pairs/SMT confirmation (spec §7 `pairs_confirm`)** — ES/QQQ divergence at the sweep. The one
   book gate that adds an *independent information source* rather than re-slicing NQ price. Untested.
3. **News avoidance** (p33 #8) — unmodeled; red-news days are in our sample. Plausible variance
   reducer, unlikely to flip 2024's sign by itself.
4. **The source results may simply not be real** (unverifiable screenshots, survivorship). Two
   rounds of faithful mechanization producing coin-flips is consistent with this null.

## Recommendations for round 3

1. **Pairs/SMT gate or bust.** Implement `pairs_confirm` (ES 15m divergence/agreement at sweep and
   at MSS) on top of default and conf=imb, 15m. It is the last untested book ingredient with new
   information content. Acid test unchanged: 2024 ≥ ~0.8 or dead.
2. **Placebo-test the long side before any further compounding.** Compare W-model longs against
   time/depth-matched random long limit entries (same session, similar retracement depth, same
   stop/TP geometry) on dev years. If the ICT scaffolding is not distinguishable from generic
   "buy NQ pullbacks", close the program — every surviving table row so far (imb longs, compound g)
   is consistent with drift + selection.

If both come back null, jv-ict joins the dead-family list; do not re-sweep axes.

## Artifacts

Scratchpad (`/tmp/claude-1000/.../scratchpad/`): `r2-*.json` / `r2-*.log` (8 runs), `run2.sh`,
`r2-analyze.py` (summary/side/year/funnel extractor), `htf_audit.py` (independent 1H structure
re-derivation, PASS), `smoke-htf.json`.
