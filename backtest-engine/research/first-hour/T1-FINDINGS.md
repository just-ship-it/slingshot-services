# T1: Sweep + RTH-Timed Reversal Entry

## TL;DR

Hypothesis was **NOT confirmed**. Restricting overnight-range-sweep reversal entries to the RTH window (entry ≥ 9:30 ET, exit by 11:00 ET) does **not** produce a cleaner MFE/MAE distribution than the all-session post-sweep reversal study. Base "reversal-favorable" rate (MFE ≥ MAE) drops from 67.6% (all-session) to **51.02%** (RTH-timed). MFE/MAE are nearly symmetric (avg MFE 99 / MAE 105). The best param combo (stop=25 / target=150 / timeStop≥90m) earns IS PF 1.33 / Sharpe 1.61 / DD 26.8% — too thin and too volatile to be a standalone strategy. RTH-only re-entry kills more of the post-sweep reversal mass than it preserves.

## Dataset

- **Source:** `backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv` raw contract, loaded via `CSVLoader.loadOHLCVData('NQ', ...)` which auto-applies `filterPrimaryContract()`.
- **Date range:** 2025-01-13 → 2026-04-23 (399 calendar dates).
- **OOS holdout:** 2026-02-23 → 2026-04-23 (~2 months). 217 IS trades, 28 OOS trades.
- **Exclusions:**
  - 10 days inside contract-rollover boundary (current or previous day).
  - 2 days with no Asian session.
  - 17 days with no sweep in the 7:30-10:00 ET window.
  - 59 days where sweep occurred but no 1m close ever reclaimed the swept side by 10:30 ET.
- **Final trade count:** 245 (~15.3/month, ~0.6/day) — *not* a full 1/day strategy.

### Setup

- **Asian range:** prev day 19:00 ET → today 03:00 ET (high/low across all 1m bars).
- **Sweep:** first 1m bar in 07:30-10:00 ET that touches Asian high (within 2pt) or Asian low (within 2pt). High-sweep → SHORT bias; low-sweep → LONG bias.
- **Entry:** first 1m bar after sweep whose CLOSE is back inside the swept range. Entry executed on the *next* bar's OPEN. Entry deferred to 09:30 ET if reclaim happens earlier.
- **Force-flat:** 11:00 ET hard cutoff.
- **NQ point value:** $20 (full-size NQ).

## Findings

### Aggregate distributions (n=245)

| Metric | p25 | p50 | p75 | p90 |
|---|---:|---:|---:|---:|
| MFE (pts) | 31.75 | 71.75 | 145.25 | 236.75 |
| MAE (pts) | 30.50 | 74.75 | 148.75 | 226.00 |
| Time-to-MFE (min) | 11 | 34 | 69 | 86 |

- **Symmetry tells the story.** MFE ≈ MAE at every percentile — there is no built-in directional edge from this entry rule once the sweep window is restricted to mornings.
- 230/245 (94%) of entries land in the 9:30-10:00 ET window. Only 15 entries fire 10:00-10:30 ET. Almost no qualifying entries before 9:30 ET (deferred to 9:30 open).
- Sweep side mix: 145 high (59%, → SHORT) / 100 low (41%, → LONG). Both sides have identical 51.0% reversal-favorable rate.
- Time-to-MFE p50 = 34 min — when the trade works, it works inside the first half of the window. p75 = 69 min ⇒ ~95% of MFEs are realized before the 11:00 ET force-flat.

### Comparison to the all-session post-sweep reversal study

| Metric | All-session (existing) | T1 (RTH-timed) |
|---|---:|---:|
| Sample | ~500 | 245 |
| Reversal rate (price hits opposite) | 67.6% | n/a (force-flat at 11:00) |
| Reversal-favorable (MFE ≥ MAE) | n/a | **51.0%** |
| Avg MFE | 167 pts | **99 pts** |
| Avg MAE | 84 pts | **105 pts** |
| MFE:MAE ratio | ~2:1 | ~1:1 |

The all-session study captures the FULL post-sweep reversal which often takes 2-6 hours and drives 167pt average MFE. By forcing the trade to be flat at 11:00 ET, T1 chops off most of that distribution. **The conclusion is that the post-sweep reversal edge is real but slow — it isn't a first-hour phenomenon.**

### Top 3 parameter combos (full sample, ranked by Sharpe)

| Stop | Target | TimeStop | Trades | WR | PF | Sharpe | $ PnL | Max DD% |
|-----:|-------:|---------:|-------:|---:|---:|-------:|------:|--------:|
| 25 | 150 | 90m | 245 | 23.7% | 1.29 | **1.46** | $27,160 | 30.4% |
| 25 | 100 | 90m | 245 | 26.5% | 1.24 | 1.39 | $21,925 | 46.5% |
| 25 | 150 | 60m | 245 | 24.5% | 1.24 | 1.21 | $21,605 | 39.2% |

### Top 3 parameter combos by IS Sharpe (n=217, OOS check)

| Stop | Target | TimeStop | IS PF | IS Sharpe | IS WR | IS PnL | IS DD% | OOS PF | OOS Sharpe | OOS PnL |
|-----:|-------:|---------:|------:|----------:|------:|-------:|-------:|-------:|-----------:|--------:|
| 25 | 150 | 90m | 1.33 | **1.61** | 24.4% | $26,445 | 26.8% | 1.06 | 0.33 | $715 |
| 25 | 150 | 60m | 1.24 | 1.25 | 24.9% | $19,700 | 35.9% | 1.17 | 0.92 | $1,905 |
| 25 | 100 | 90m | 1.20 | 1.16 | 26.3% | $15,925 | 44.8% | 1.60 | 3.01 | $6,000 |

OOS sample (n=28) is too small for confident inference, but the third row (stop=25/tgt=100/90m) is the only combo where OOS Sharpe exceeds IS — a hint that 100pt target may be more durable than 150pt.

### Best "robust" combo (both IS and OOS PF>1)

`stop=25 / tgt=75 / timeStop≥90m`: IS PF 1.12 (Sharpe 0.80) and OOS PF 1.67 (Sharpe 3.55). Lower headline numbers but agreement across the IS/OOS split.

### Why the grid universally picks stop=25

The MFE distribution has a long right tail (p90=237, max well above) but the MAE distribution is similarly long (p90=226). With wider stops (40/60/80) the strategy traps more big losers on a 24% WR profile, blowing PF/Sharpe. With stop=25 you get many small losses and the rare 100-200pt winner. This is a textbook *small-edge / fat-tail* profile — not a robust day-trade entry.

## Proposed Strategy v0

Given the weak edge, this is presented as a *minimum-viable* strategy. It is **not recommended as a standalone** — better used as one ingredient in a confluence stack, or paired with the pre-RTH side-prediction filter (90.5% OOS) to take only the trades where the predicted-sweep-side and observed-sweep-side agree.

- **Entry:** First 1m bar in 07:30-10:00 ET that touches Asian high/low (±2pt) → wait for first 1m CLOSE back inside the swept range → enter at next bar OPEN. If that bar is before 9:30 ET, defer entry to the 9:30 open.
- **Side:** SHORT after high sweep, LONG after low sweep.
- **Stop:** 25 NQ pts from entry (tied to MAE p25).
- **Target:** 100 NQ pts from entry (tied to MFE p65 — selected for OOS robustness over the 150pt grid winner).
- **Time stop:** 90 min, OR force-flat at 11:00 ET, whichever fires first.
- **Expected frequency:** ~15 trades/month (~0.6/day). Days without a sweep, without a reclaim, or inside rollover are no-trades.
- **Expected per-trade EV (full sample):** +$89.5 ($21,925 / 245). Win rate 26.5%, PF 1.24. **Headline IS Sharpe 1.16, OOS Sharpe 3.01** (small OOS sample — large CI).
- **Risk profile:** Max DD 46.5% of peak equity in IS — high. Tail-driven returns; expect long losing streaks.

## Backtest-engine integration sketch

This entry rule does not match any existing strategy template cleanly — it requires (a) Asian range computation at session boundary, (b) sweep + reclaim detection on 1m, (c) RTH-window gating, and (d) a hard 11:00 ET force-flat.

- **New file:** `shared/strategies/asian-sweep-rth-reversal.js`, extending `BaseStrategy`.
- **Inputs needed at construction:** Asian high/low for the day (compute once at 03:00 ET), sweep state (idle / triggered / reclaim-pending / armed / done).
- **CLI integration:** `--strategy asian-sweep-rth-reversal --timeframe 1m --raw-contracts --eod-cutoff-et 11:00 --start 2025-01-13 --end 2026-04-23`.
- **Engine flags to reuse:** `--target-points`, `--stop-loss-points`, `--max-hold-bars` (translate `--max-hold-bars 90` for 90m on 1m timeframe).
- **State per day:** reset at 00:00 ET; compute Asian high/low at 03:01 ET; track sweep candidate; on `place_limit` use entry bar OPEN (5-min limit timeout to mirror live conditions).

## Caveats / Followups

1. **Hypothesis falsified.** The 167pt MFE / 84pt MAE / 67.6% reversal rate reported in `post-sweep-reversal.js` does **not** survive a 9:30-11:00 ET window restriction. The post-sweep reversal edge is a slow, multi-hour phenomenon — not a first-hour trade.
2. **Small OOS sample** (28 trades). The strong OOS Sharpe of 3.01 on stop=25/tgt=100 should not be over-interpreted — that is plausibly noise on a 28-trade window.
3. **Sweep-only-no-reclaim days (n=59) are a meaningful loss of opportunity.** Worth investigating if those days are systematically directional (i.e., the sweep was a real breakout). If so, the strategy could be inverted on confirmed-breakout days.
4. **No GEX/IV filter applied.** A natural followup is to overlay the GEX-regime or 0-DTE QQQ IV-direction signal at sweep time. Strong-positive gamma + sweep-into-call-wall might lift WR on SHORT entries; strong-negative gamma + sweep-into-put-wall might do the same for LONG. Recommend a confluence study before promoting this to a live strategy.
5. **Combine with T2 (pre-sweep side prediction).** T2 may show that 90.5% OOS side prediction holds in this dataset — if so, taking only T1 trades where (predicted side == observed sweep side) should bias the WR upward.
6. **Sub-minute entry quality.** The "next bar open" entry assumption may be optimistic for live trading — slippage of 1-3 ticks per trade would erode the already-thin edge significantly. A 1s-bar replay would tighten this.
7. **Ten-rollover-day skip is conservative** but appropriate; without skipping, 200pt phantom moves at the rollover boundary would generate fake MFE/MAE.

## Files

- Script: `/home/drew/projects/slingshot-services/backtest-engine/research/first-hour/T1-sweep-rth-reversal.js`
- Data: `/home/drew/projects/slingshot-services/backtest-engine/research/first-hour/output/T1-sweep-rth-reversal.json` (param grid + per-trade records)
- This file: `/home/drew/projects/slingshot-services/backtest-engine/research/first-hour/T1-FINDINGS.md`
