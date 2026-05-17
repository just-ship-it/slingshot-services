# Structural-Magnet MFE Ratchet — Results

## Mechanic

Instead of locking a fixed percentage of MFE at fixed MFE thresholds, the
**structural-magnet ratchet** anchors the ratchet to real swing levels visible
on the chart at signal time. For each new trade:

1. Compute 1m 9/9 swing pivots from raw-contract OHLCV (precomputed CSV,
   live-honest: only pivots confirmed by signal time are used).
2. Filter to the trade's profit region: for a SHORT at entry E with TP at
   E − 200, keep swing LOWS in (E − 200, E). Symmetric for longs.
3. Each surviving swing becomes a tier in the engine's `mfeRatchet` config:
   `{ minMFE: |E − swingPrice|, lockPct: 0.75 }`. Sorted highest-MFE-first.
4. The engine's existing ratchet code consumes the tiers unchanged. Once
   MFE crosses the shallowest magnet, the stop trails at `lockPct × MFE`.
   As MFE grows past deeper magnets, the lock grows proportionally.

Default v1 parameters:
- **Lock %**: 75% (Drew's stated preference — locks +103 on +138 MFE)
- **Recency window**: 4 hours of swings backward from signal
- **Pivot definition**: 9 bars left, 9 bars right (matches Drew's TV indicator)
- **No magnets in profit region** → no ratchet (trade rides original SL/TP)

## Yesterday's day (2026-05-14) under each lock %

T1 and T3 both had the same visible magnet set per Drew's screenshot:
swing lows at 29664, 29595.25, 29533. T2 had MFE only ~10pt — no magnet
touched, original SL fires. T4 and T5 stay blocked by T3.

| Config | T1 (138.75 MFE) | T2 (10 MFE) | T3 (138 MFE) | Day total |
|---|---:|---:|---:|---:|
| Baseline BE 70/+5 | +$100 | −$1,200 | +$100 | **−$1,000** |
| Pure ratchet s1-m70l40 | +$1,110 | −$1,200 | +$1,104 | +$1,014 |
| Pure ratchet s1-m100l60 | +$1,665 | −$1,200 | +$1,656 | +$2,121 |
| **Structural 75%** | **+$2,081** | **−$1,200** | **+$2,070** | **+$2,951** |
| Structural 65% | +$1,804 | −$1,200 | +$1,794 | +$2,398 |
| Structural 85% | +$2,359 | −$1,200 | +$2,346 | +$3,505 |

The structural variant wins yesterday because the MFE peaks landed exactly
on swing levels. A pure ratchet locks 60% of running MFE; the structural
locks 75% of running MFE *only after MFE crosses the shallowest magnet*,
and the MFE peak coincided with a deeper magnet. So lock = 75% of 138 =
103 pt (vs pure 60% × 138 = 82 pt).

## Full 16-month backtest

`gfi-magnet-ratchet --gfi-magnet-lock-pct 0.75 --gfi-magnet-recency-hours 4`

| Metric | Baseline (BE 70/+5) | Pure s1-m70l40 (best pure PnL) | **Structural 75% / 4h** |
|---|---:|---:|---:|
| Trades | 172 | 181 | **199** |
| Win Rate | 61.6% | 61.9% | **71.9%** |
| Profit Factor | 2.99 | 2.61 | 1.93 |
| Sharpe | 6.41 | 5.97 | 2.89 |
| Max DD | 11.3% | 8.3% | **8.0%** |
| Total PnL | $157,329 | $133,542 | $53,920 |
| Avg Winner MFE | 155.76 | 139.44 | **49.37** |
| **Winner Capture %** | 71.75% | 69.44% | **79.83%** ← best |
| BE-Clip | 38 | 2 | 5 |
| Big-BE-Clip | 20 | 14 | **3** ← best |
| MFE→SL | 8 | 12 | **7** ← best |
| Giveback $ | $93,280 | $95,466 | **$28,483** ← best (lowest) |

The structural ratchet wins on every "smoothness" metric (capture %, BE-clips,
big BE-clips, MFE→SL, giveback dollars, drawdown), and loses on aggregate
PnL by 66%. It produces 27 MORE trades than baseline — earlier exits free
the cooldown sooner, allowing more same-side re-entries.

### Sweep over lockPct × recencyHours (running-mode)

Tested 5 lockPct values × 3 recency windows. Clear winners emerged:

| id | lock | recency | trades | PF | Sharpe | DD% | PnL | Capture% | Giveback$ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **struct-l95-r2h** | **0.95** | **2h** | 193 | **2.08** | **3.52** | **6.99** | **$69,455** | **91.46** | **$12,540** |
| struct-l85-r2h | 0.85 | 2h | 193 | 2.07 | 3.46 | 7.13 | $68,735 | 86.16 | $21,467 |
| struct-l75-r2h | 0.75 | 2h | 191 | 2.08 | 3.44 | 7.40 | $69,495 | 81.90 | $29,697 |
| struct-l65-r2h | 0.65 | 2h | 190 | 2.07 | 3.33 | 7.24 | $68,507 | 75.19 | $44,002 |
| struct-l55-r2h | 0.55 | 2h | 188 | 1.93 | 2.96 | 7.94 | $60,547 | 70.38 | $53,268 |

Two clean patterns:
- **Shorter recency wins**: 2h is best across all lockPct levels. 4h trades PnL
  and Sharpe for slightly more capture; 8h collapses PnL by ~$30k.
- **Higher lockPct wins** (in running mode): at 2h recency, lockPct from 55 → 95
  has approximately flat PnL ($60–70k) but capture goes 70% → 91% and
  giveback drops $53k → $12.5k. **No downside to going tight in running mode.**

The 75%/4h I ran first turns out to have been pessimistic on both axes. The
real running-mode winner is **`struct-l95-r2h`**: capture 91%, giveback $12.5k,
DD 6.99%, $69k PnL, Sharpe 3.52.

### Why the avg winner MFE collapsed (49 vs 156)

Most trades now exit at the FIRST magnet's lockPct × running MFE, well before
they'd reach the deeper magnets. With minMFE=69 tier and lockPct=0.75, the
stop sits at +52pt when MFE = 70. Any 25% retrace from the running MFE
triggers exit. Tail runners that would reach MFE 138+ under baseline now
get clipped at the 50–80pt range.

This is a semantic issue, not a bug. My implementation tracks `lockPct × current_MFE` once any tier matches. Your intuitive description ("lock 75% when
price touches the magnet, stay there until next magnet") implies a
**fixed-per-magnet** lock instead:

```
MFE = 70 (touched magnet 1): stop = 70 × 0.75 = +52, HELD until next magnet
MFE = 138 (touched magnet 2): stop = 138 × 0.75 = +103, HELD
```

This would give trades more room between magnets to reach the next one. The
engine code at `trade-simulator.js:1178` currently does `entry − (currentMFE × lockPct)`. A fixed-per-magnet implementation would use `entry − (tier.minMFE × lockPct)` — i.e., the lock is computed from the tier's anchor MFE, not the running MFE.

Pending the lockPct/recency sweep, this is the most likely fix to recover
the missing PnL while keeping the smoothness wins.

### Fixed-per-tier sweep results

8 configs: lockPct ∈ {0.40, 0.50, 0.60, 0.70} × recency ∈ {2h, 4h}.
Fixed-per-tier mode means stop = `entry − tier.minMFE × lockPct` (held
constant until next magnet) instead of `entry − currentMFE × lockPct`
(tightens continuously).

| id | lock | recency | trades | PF | Sharpe | DD% | PnL | Capture% | Giveback$ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **fixed-l40-r2h** | **0.40** | **2h** | 175 | **2.47** | **3.87** | 7.58 | **$90,512** | 72.03 | $59,357 |
| fixed-l40-r4h | 0.40 | 4h | 182 | 2.48 | 3.71 | **6.87** | $82,239 | 70.19 | $58,830 |
| fixed-l50-r2h | 0.50 | 2h | 182 | 2.14 | 3.31 | 10.04 | $74,607 | 69.18 | $62,650 |
| fixed-l50-r4h | 0.50 | 4h | 188 | 2.12 | 3.14 | 9.56 | $66,384 | 67.07 | $62,031 |
| fixed-l60-r2h | 0.60 | 2h | 185 | 2.03 | 3.02 | 9.14 | $65,944 | 69.69 | $56,857 |
| fixed-l60-r4h | 0.60 | 4h | 193 | 2.12 | 3.18 | 8.83 | $65,124 | 68.35 | $57,352 |
| fixed-l70-r2h | 0.70 | 2h | 187 | 2.02 | 3.12 | 8.53 | $64,104 | 70.44 | $53,575 |
| fixed-l70-r4h | 0.70 | 4h | 195 | 1.76 | 2.36 | 9.11 | $44,197 | 65.30 | $54,724 |

**Fixed mode dramatically improves PnL over running mode** — best fixed config
$90.5k vs best running $69.5k (+30%). Fixed mode also restores avg winner MFE
from 56 (running) to 90 (fixed) — trades can reach deeper magnets without
being clipped on shallow MFE retraces.

The cost: lower capture % (72% vs 91%) and higher giveback dollars ($59k vs
$12.5k). Fixed mode trades some capture-of-MFE for raw P&L by allowing larger
swings between magnet checkpoints.

### Comparison summary

| Variant | PF | Sharpe | DD% | PnL | Capture% | Giveback$ |
|---|---:|---:|---:|---:|---:|---:|
| Baseline BE 70/+5 | **2.99** | **6.41** | 11.3 | **$157k** | 71.8 | $93k |
| Pure ratchet s1-m70l40 | 2.61 | 5.97 | 8.34 | $134k | 69.4 | $95k |
| Structural running 95%/2h | 2.08 | 3.52 | 6.99 | $69k | **91.5** | **$12.5k** |
| Structural fixed 40%/2h | 2.47 | 3.87 | 7.58 | **$91k** | 72.0 | $59k |

The leading structural-fixed variant (40%/2h) **does not beat the pure ratchet
s1-m70l40 on aggregate** ($91k vs $134k, PF 2.47 vs 2.61, Sharpe 3.87 vs 5.97).
Within the structural family it's the best, but the simpler pure-ratchet rule
with the same lockPct still produces a smoother, higher-PnL outcome at the
16-month scale.

### Why the structural mechanic underperforms its theoretical promise

Three contributors:

1. **No fallback when no magnets exist.** Trades with no 9/9 swing lows in
   the profit region (4h recency × 200pt band) get ZERO ratchet protection —
   they ride original SL/TP. Pure ratchet protects every trade.

2. **Magnets at sub-30 MFE are noisy.** Short-recency / close-to-entry
   swings produce shallow tiers (e.g., minMFE=15). At 40% lock, stop locks
   at +6pt. Almost any continuation past +15 MFE that wiggles back triggers
   a +6pt exit. Adds whipsaw without meaningful protection.

3. **Magnet count per trade varies.** Some trades have 1 magnet, some have
   5. Discretionary edge in "level structure" doesn't translate cleanly to
   the engine's tier semantics — the engine treats every magnet equally.

Possible follow-ups (not yet tested):
- Magnet significance filter: only use swings that survived a depth threshold
- Minimum-distance filter: drop magnets within N pts of entry
- Hybrid: pure ratchet as fallback when no magnets present
- A "structural inflection" mechanic that triggers on the candle-close-through
  signal at a magnet rather than tier-by-MFE

## What changes if the swing-pivot data is stale or missing

- If `magnetRatchet=true` but no pivot loader is attached → strategy emits
  no ratchet fields. Trade rides original SL/TP. No silent broken behavior.
- If pivots are attached but no magnets fall in a trade's profit region →
  same fallback. Trade rides original SL/TP.

This is the design tradeoff for v1: **a clean A/B test**. If we want a
softer fallback to a pure-MFE ratchet on trades with no magnets, we'd add
that as a separate flag.

## Live-deployment implications

Same architectural gap as the pure ratchet (see `live-deployment-gap.md`).
The strategy emits `mfeRatchetConfig.tiers` on the signal, but no live
position-management loop currently consumes it for gex-flip-ivpct. To
deploy: generalize `signal-generator/src/ai/live-trade-manager.js` to
accept per-trade tier config from the originating signal's payload (rather
than hard-coded defaults), wire it into multi-strategy mode.

Additionally, live needs a swing-pivot computation source:
- Backtest path: precomputed CSV (current implementation).
- Live path: compute 9/9 pivots from the 1m candle stream in the strategy
  or in the live trade manager. 9-bar confirmation lag means a swing is
  "knowable" 9 minutes after it occurred. Acceptable for use as an
  exit-management anchor on a swing-trading strategy.

## Files

- `backtest-engine/scripts/precompute-swing-pivots.js` — 9/9 pivot precompute
- `backtest-engine/research/swing-pivots/NQ_swings_1m_9_9.csv` — output
- `backtest-engine/src/data-loaders/swing-pivot-loader.js` — engine loader
- `shared/strategies/gex-flip-ivpct.js` — `loadSwingPivots`, `buildMagnetTiers`
- `backtest-engine/src/backtest-engine.js` — wires loader into strategy
- `backtest-engine/src/cli.js` — `--gfi-magnet-ratchet`, `--gfi-magnet-lock-pct`,
  `--gfi-magnet-recency-hours` flags
