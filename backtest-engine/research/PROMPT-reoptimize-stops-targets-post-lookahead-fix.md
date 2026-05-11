# Agent prompt — Re-optimize per-rule stops & targets after the GEX lookahead fix

> Paste this entire document into a fresh agent. It assumes no prior session context and contains everything needed to execute the task.

## Context

The slingshot-services backtest engine uses 15-min GEX snapshot files at `backtest-engine/data/gex/nq/`, `backtest-engine/data/gex/nq-cbbo/`, and `backtest-engine/data/gex-cbbo/nq/`. Until 2026-05-06 these files had a 14-minute lookahead bias: snapshot timestamps labeled the bucket-START but contained the LAST OHLCV close in the `[T, T+15)` window, so a snapshot labeled `T:00` actually reflected market state at `~T:14:59`. Every NQ-space field (multiplier, walls, gamma_flip, regime, gamma_imbalance) inherited the 14-min spot lookahead.

The bug has now been fixed. Specifically:
1. Both generator scripts (`scripts/generate-intraday-gex.py` and `scripts/generate-cbbo-gex.js`) now bucket on `(ts + 1min).ceil('15min')` so a snapshot labeled `T` represents data from `[T-15, T)` only.
2. All existing JSONs in those three directories were one-shot relabeled with `scripts/relabel-gex-timestamps.js` (each snapshot's `timestamp` shifted forward by 15 min). Backups are at `*.lookahead-bak`.
3. Each touched JSON has `metadata.lookahead_relabel` recorded for traceability.

**Why this matters for stops & targets:** the existing per-rule stop/target values for `GEX-FLIP-IVPCT` (and the global exit params for `IV-SKEW-GEX`) were derived from MFE/MAE distributions of trades captured under the lookahead-biased data. Because the entry conditions now fire at slightly different bars (and on slightly different feature values) under the corrected snapshots, the original stops/targets may no longer be MFE/MAE-aligned. Initial tests showed that GEX-FLIP-IVPCT's headline P&L dropped 17% and PF dropped from 5.87 to 4.29 under the corrected data using the same params — strongly suggesting room to recover edge by re-tuning.

**Corrected baselines (record these — they are what to beat):**

| Strategy | Trades | P&L | WR | PF | Sharpe | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| GEX-FLIP-IVPCT v1 (current params, fixed data) | 143 | $275,400 | 74.13% | 4.29 | 10.60 | 4.16% |
| IV-SKEW-GEX v8-balanced (current params, fixed data) | TBD | TBD | TBD | TBD | TBD | TBD |

(IV-SKEW-GEX baseline in `/tmp/ivsk-fixed.log` — pull headline numbers from it, or re-run.)

## Strategies in scope

### 1. GEX-FLIP-IVPCT — primary target (per-rule stops/targets)

**Code:** `shared/strategies/gex-flip-ivpct.js`. Six priority-ordered rules, each with its own hardcoded stop and target derived from MFE/MAE percentiles of historical trades that fired that rule:

| Rule | Side | Priority | Conditions | Stop | Target |
|---|---|---:|---|---:|---:|
| L1 | long  | 100 | putWall ≤ 50 + ivPctile ≤ 0.20 + skew > +0.015 | 113 | 198 |
| L4 | long  | 90  | regime=neutral + above gammaFlip + ivPctile ≤ 0.20 | 106 | 187 |
| L3 | long  | 80  | regime=strong_negative + above gammaFlip | 184 | 278 |
| S3 | short | 100 | callWall ≤ 50 + below gammaFlip | 114 | 196 |
| S1 | short | 90  | callWall ≤ 50 + ivPctile ≥ 0.80 + skew > +0.015 | 131 | 211 |
| S2 | short | 80  | callWall ≤ 50 + ivPctile ≥ 0.80 | 129 | 211 |

**Gold-standard backtest command (must use exact flags for parity):**
```
cd backtest-engine
node index.js --ticker NQ --strategy gex-flip-ivpct --timeframe 5m --raw-contracts \
  --start 2025-01-13 --end 2026-04-20 \
  --iv-resolution 1m \
  --eod-cutoff-et 16:40
```
GEX dir defaults to `data/gex/nq/` (already relabeled).

**Other gotchas (verbatim from `memory/gex-flip-ivpct-strategy.md`):**
- `--iv-resolution 1m` is REQUIRED. With 15m IV, skew can be up to 14 min stale at non-15m-boundary bars and trip the +0.015 threshold, causing L1↔L4 / S1↔S2 rule swaps that break parity.
- `--eod-cutoff-et 16:40` is REQUIRED. Without it, trades that would have been force-liquidated run to max-hold and get different exit prices.
- `--timeframe 5m` is REQUIRED.
- The engine increments `barsSinceEntry` per 1-minute candle regardless of `--timeframe`, so `maxHoldBars` is effectively in MINUTES. Strategy default is 600 (= 120 5m bars).

### 2. IV-SKEW-GEX v8-balanced — secondary target (global exit params)

**Code:** `shared/strategies/iv-skew-gex.js`. Single set of exit params (no per-rule). Current "balanced" gold-standard params (now stale):
- `--target-points 200`
- `--stop-loss-points 60`
- `--max-hold-bars 90`
- `--breakeven-trigger 140 --breakeven-offset 10`
- Skew thresholds: `--neg-skew-threshold 0.0145 --pos-skew-threshold 0.0250`
- `--blocked-regimes strong_negative --level-proximity 100`

Less rule-specific than GEX-FLIP-IVPCT, but the SL/TP/BE settings were sweep-tuned against lookahead-biased data so are likely not optimal anymore.

## Your task

For **GEX-FLIP-IVPCT** (primary), and as a stretch goal **IV-SKEW-GEX** (secondary):

1. **Capture trades under current (relabeled) data.** Run the gold-standard command. Locate the trades JSON the engine writes (typically under `backtest-engine/output/`); confirm each trade has `ruleId` (or equivalent) so trades can be grouped by rule.

2. **Compute per-rule MFE/MAE distributions.** For each trade, you need the maximum favorable excursion and maximum adverse excursion *during the holding window* — measured against the actual NQ raw-contract 1m candles starting from the entry bar. Two reasonable approaches:
    - **(a)** Re-run the backtest with very wide TP/SL (say 600pt each) so trades exit only by max-hold or EOD; the engine's per-trade record will then expose the natural MFE/MAE without being clipped.
    - **(b)** Walk the trades JSON yourself, load `data/ohlcv/nq/NQ_ohlcv_1m.csv` with `filterPrimaryContract()` (see `backtest-engine/src/data/csv-loader.js:523` for the implementation), and compute MFE/MAE from entry to (entry + maxHoldBars × 60s) or EOD-cutoff, whichever fires first.

    Either is fine. (a) is cheaper if the engine already records MFE/MAE; (b) is the safer fallback. Read the trade JSON schema first to choose.

3. **Derive new stops/targets per rule** using percentile-based logic similar to V7DTSP13's original methodology:
    - Stop ≈ p75 (or p80) of MAE — captures most losers, doesn't hard-clip the trades that ultimately won
    - Target ≈ median MFE of the rule's *winning* trades (where winners = MFE > MAE), or p60 of overall MFE — calibrate to the rule's actual reach
    - Always check that proposed stop < proposed target (i.e., the rule still has positive R:R)
    - If a rule has fewer than 15 trades, leave its params unchanged and flag it (sample too small)

    Be conservative — round to nearest 5 pts. Don't fit so tight to historical that the new params won't generalize.

4. **Validate** by running the backtest with the new per-rule params and comparing to the corrected baseline (143 trades / $275,400 / PF 4.29 / Sharpe 10.60 / DD 4.16% for GEX-FLIP-IVPCT). The bar to clear: any of {PF, Sharpe, max DD, expectancy} should improve without other metrics regressing meaningfully.

5. **For IV-SKEW-GEX** (if you have time): same workflow but for the global SL/TP/BE rather than per-rule. A small grid sweep around current params (`SL ∈ {50, 60, 70, 80}`, `TP ∈ {180, 200, 220}`, `BE_trigger ∈ {120, 140, 160}`) is sufficient — don't overfit. Compare against `/tmp/ivsk-fixed.log` baseline.

## Deliverables

Write `backtest-engine/research/STOPS-TARGETS-REOPTIMIZED.md` containing:

1. **Methodology** — exactly which sample window, what MFE/MAE measurement procedure, percentile cutoffs used.
2. **Per-rule diagnostics for GEX-FLIP-IVPCT** — table with: rule, n, current stop, p75 MAE, current target, median MFE, proposed stop, proposed target, expected stop-rate change, expected hit-rate change.
3. **Validation backtest** — full headline metrics (trades, P&L, WR, PF, Sharpe, max DD, expectancy) with new params, vs corrected baseline.
4. **Per-rule trade breakdown** before vs after — count per rule, win rate per rule, avg P&L per rule. Flag any rule whose count drops to <10 — that may indicate the new stop/target broke the rule's edge.
5. **IV-SKEW-GEX results** if attempted, same format.
6. **Recommendation** — propose updates to either:
    - The hardcoded `RULES` array in `shared/strategies/gex-flip-ivpct.js` (preferred — patches live & backtest together), OR
    - The CLI flag defaults if the strategy uses CLI overrides for the params (check it actually accepts per-rule overrides; current code path doesn't read CLI per-rule)

    Do **not** edit production strategy code yet — the user reviews proposed changes before merging.

## Constraints

- Use raw-contract OHLCV (`--raw-contracts`) — already enforced by the gold-standard command.
- Honor the EOD cutoff (`--eod-cutoff-et 16:40`).
- All results should be on the relabeled GEX data — don't accidentally re-introduce lookahead by reading from `data/gex/nq.lookahead-bak/` etc.
- If you find that a rule's MFE/MAE distribution suggests no positive R:R is achievable post-fix, recommend disabling that rule rather than forcing parameters that will lose money.
- Keep the report focused — bullet points and tables, not prose. Aim for under 400 lines.

## Reference points to verify mid-task

If you find yourself proposing radical changes (e.g., halving every stop), sanity-check by:
- Comparing the per-rule trade count under the lookahead-biased data (in `data/gex/nq.lookahead-bak/`) to under the fixed data. Some rules likely gained or lost trades on the corrected snapshot timing, which itself shifts the population the params should be tuned for.
- Looking at `memory/gex-flip-ivpct-strategy.md` for the original V7DTSP13 derivation context.

When in doubt, prefer parameter changes that improve the *worst-performing* rule's expectancy without hurting other rules — those are most likely to generalize.
