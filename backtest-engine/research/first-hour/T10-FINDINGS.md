# T10: Opening Drive (wide-range + high-volume first 5/15m candle) Continuation

## TL;DR
**NULL RESULT.** The "wide-range × high-volume opening candle => first-hour continues in the candle's direction" hypothesis does not hold for NQ in the 2025-01-13 → 2026-04-23 window. On the 31 first-5m drive days the close at 11:00 ET is in the candle's direction only **48.4 %** of the time; on the 34 first-15m drive days it is **52.9 %** — both indistinguishable from a coin flip. The first-touch test at ±30 pts from the candle close is even worse for first-15m drives (TP-before-SL = 41.2 %). No grid variant clears the WR ≥ 55 % / PF ≥ 1.3 bar at a meaningful sample size with OOS confirmation. Recommend abandoning T10.

## Dataset
- Source: `data/ohlcv/nq/NQ_ohlcv_1m.csv` (raw contract, `filterPrimaryContract` applied).
- Date range: **2025-01-13 → 2026-04-23**, 50-day warmup before start for trailing references.
- IS / OOS split: OOS = 2026-02-23 → 2026-04-23 (~last 2 months).
- Trading days kept after rollover skip + opening-window completeness: **325**.
- Drive-day classification (relaxed from the original 80th/1.5×):
  - first-5m drive: 5m range_pctile ≥ 70 vs trailing 20 days **AND** 5m volume ≥ 1.30 × trailing-20-day mean.
  - first-15m drive: same on the 9:30–9:45 candle.
- Drive sample sizes:
  - first-5m drives: **31** (11 long / 20 short)
  - first-15m drives: **34** (10 long / 24 short)
- Output: `output/T10-opening-drive.json` (172 KB).

## Findings

### Headline conditional probabilities (on drive days, candle direction = sign(close − open) of the drive candle)

| Metric (entry = drive candle close, sign = candle direction) | first-5m drives (n=31) | first-15m drives (n=34) |
|---|---:|---:|
| P(close at 11:00 in same direction) | **48.4 %** | **52.9 %** |
| P(reach +30 pts before −30 pts in candle dir) | 48.4 % | 41.2 % |
| P(reach −30 pts first) | 51.6 % | 58.8 % |
| Median end-of-window PnL (pts in candle dir) | **−14.0** | +9.4 |
| p75 end-of-window PnL (pts in candle dir) | +34.9 | +127.3 |

A useful continuation effect would push P(same dir at end) to ≥ 60 % and P(TP-before-SL ±30) similarly above 55 %. Neither shows up; **first-15m drives actually fade more often than they continue at the ±30 first-touch test (58.8 % SL-first).** The asymmetry between median (negative for 5m, slightly positive for 15m) and p75 (large positive) means the right-tail wins on a handful of trend-day outliers are dragging the average; the modal drive day reverses.

### Strategy grid (120 variants: 2 entry-modes × 30 stop/target combos × 2 candle bases)

Top by raw PF, with IS / OOS split (OOS = 1 trade only — drives are too rare):

| Variant | All n | All WR | All PF | All PnL$ | All MaxDD$ | IS n | IS PF | OOS n |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 5m / breakStop / fixedStop=40 / TP=30 | 24 | 75.0 % | **2.10** | $5,364 | $1,831 | 23 | 1.98 | 1 |
| 5m / breakStop / oppExtreme / TP=30 | 24 | 87.5 % | 1.54 | $4,224 | $3,661 | 23 | 1.47 | 1 |
| 5m / breakStop / oppExtreme / TP=100 | 24 | 62.5 % | 1.46 | $6,999 | $5,473 | 23 | 1.33 | 1 |
| 15m / breakStop / oppExtreme / TP=100 | 27 | 63.0 % | 1.31 | $7,117 | $7,135 | 26 | 1.22 | 1 |
| 15m / close / oppExtreme / TP=30 | 34 | 82.4 % | 1.14 | $1,984 | $4,906 | 33 | 1.09 | 1 |
| 15m / breakStop / oppExtreme / TP=20 | 27 | 88.9 % | 1.08 | $692 | $4,392 | 26 | 1.03 | 1 |

The "best" variant (5m / breakStop / SL=40 / TP=30) has only **24 trades over 15 months (≈ 1.7 trades / month)** and a **single OOS trade**. PF=2.10 with that sample size has wide error bars; even +/− 2 trades flipping outcome moves PF substantially. The "high-WR / TP=30" variants achieve impressive win rates only because tight TPs harvest the modest mean-reversion that does occur — but they offer barely-positive expectancy ($25-58 / trade) once losses are weighted, and avg loss ($2.4-2.9 k) dwarfs avg win ($400-600). Even worse, `topBySharpe` returned **zero** variants (no variant met PF > 1.2 AND n ≥ 30 AND finite Sharpe simultaneously).

### Why the hypothesis fails

1. **Drive direction is itself noisy** — only 11/31 (35 %) of first-5m drives are long; the bias of the wide+volume candle leans short by a 2:1 margin in this window, suggesting "drives" are more often selling pressure than trend kickoffs.
2. **Mean reversion within the first hour is the dominant regime in this dataset** — consistent with T0 baseline showing typical first-60m range only ~80 pts and a strong tendency to retrace.
3. **Sample size is the killing constraint** — even with relaxed thresholds (70th pctile / 1.30×) only 9–10 % of trading days qualify. A meaningful continuation-effect test would need >100 drives to be statistically credible.
4. **The asymmetric exit-reason mix** (most "wins" come from quick TP=30 hits; most "losses" come from time-stop or reverse extreme) is a fingerprint of mean-reversion-dominated paths rather than trend continuation.

## Proposed Strategy v0
**None — null result.** The hypothesis fails on its own conditional-probability terms (P < 55 %), fails the WR ≥ 60 % / PF ≥ 1.3 promotion bar at any reasonable sample size, and has zero OOS evidence (only 1 trade in the held-out window). Promoting any of the top-3 variants would be overfitting to ≤ 24-trade samples.

If a future track wants to revisit drive-style ideas, two pivots have a better prior given this evidence:

- **Inverse / fade variant** (T6 family) — first-15m drives reverse 58.8 % of the time at ±30. A "fade the wide+volume opening candle" rule with appropriate stops may have edge; this is exactly what T6 / T7 are testing.
- **Combine drive direction with an external bias** (overnight bias, gap, T1 sweep prediction, T3 IV bias). The drive itself is too noisy in isolation; conditioning on agreement with another high-signal feature might rescue the continuation hypothesis on a smaller subset.

## Backtest-engine integration sketch
N/A — no candidate strategy promoted.

## Caveats / Followups
- **Threshold sweep not exhausted.** I relaxed to 70/1.3× at the start; tightening back to 80/1.5× cuts samples below 20 (not statistically usable). It is theoretically possible an even tighter "extreme drive" tier (e.g. range > p95 + vol > 2.5×) carves out a small high-edge subset, but the sample size will be in single digits per year — not a viable single-trade-per-day strategy in the spirit of this research.
- **Coverage of OOS is essentially zero (1 trade).** Any "OOS-validated" claim from this script would be misleading. The drive frequency itself is the limiting factor.
- **Data quality assumption.** All checks honor `filterPrimaryContract` and skip rollover days from `NQ_rollover_log.csv`; the 21 rollover dates contributed 0 samples to the drive set after filtering.
- **No GEX / IV / sweep cross-features tested here.** Per the original brief T10 was the standalone test of the wide+volume-only premise. The "combine with external bias" pivot above belongs in a follow-up track (would slot under T4-style filters or as a T10b).
- **Not the inverse of T6/T7.** T6 (failure-reversal) and T7 (HL-retest fade) are conceptually near-inverses; this null result is consistent with — and arguably reinforces — those tracks' fade premises.
