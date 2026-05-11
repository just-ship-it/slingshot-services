# T8: Gap × GEX Regime First-Hour Bias Matrix

## TL;DR
Crossing today's gap with the 9:30 GEX regime cleanly separates first-hour drift. **Positive-gamma days fade gaps**: any gap_up × positive-or-stronger cell shows a 58-86% short bias with strongly negative mean returns. **Negative-gamma days extend / mean-revert toward fair**: gap_down × negative-or-stronger cells lean long. The standout actionable cell is `gap_up_strong × positive (n=33)`: SHORT @ 9:30 wins 60.6% of the time with mean -69 pts and median MAE-down (109% of the open) crushing median MFE-up — i.e. dealers actively suppress the open. With a 20-pt stop / 30-pt target this cell delivers 57.6% WR / PF 2.04 / Sharpe 5.65 / +290 pts standalone in 16 months.

## Dataset
- Range: 2025-01-13 → 2026-04-23 (15 months)
- Universe: NQ raw 1m (`NQ_ohlcv_1m.csv`), `filterPrimaryContract()`
- GEX: `data/gex/nq-cbbo/` (post-bucket-fix CBBO), regime read from snapshot at-or-before 9:30 ET
- Days kept: **314** of 333 trading days (rolloverDates and incomplete RTH excluded)
- Window: 9:30 ET open → 11:00 ET close (90 inclusive 1m bars)
- Gap def: `(open_9:30 - prev_RTH_close) / prev_RTH_close`
  - `gap_up_strong` >+0.5%, `gap_up` +0.2 to +0.5%, `flat` ±0.2%, `gap_down` -0.5 to -0.2%, `gap_down_strong` <-0.5%
- Gap counts: gap_up_strong 70, gap_up 53, flat 98, gap_down 33, gap_down_strong 60
- Regime counts: strong_negative 24, negative 92, neutral 51, positive 131, strong_positive 16
- Note: regime distribution is heavily skewed positive in this dataset (45%+), so `× positive` cells dominate the n.

## Findings

### Master matrix — pUp ( n ) — directional bias of close@11:00 vs open@9:30

| Gap \ Regime    | strong_negative | negative      | neutral       | positive      | strong_positive |
|-----------------|----------------|---------------|---------------|---------------|----------------|
| gap_down_strong | 75% (12)       | 59% (29)      | 67% (15)      | 25% (4)       | —              |
| gap_down        | 75% (4)        | 40% (15)      | 86% (7)       | 43% (7)       | —              |
| flat            | 100% (5)       | **74% (23)**  | 56% (16)      | 46% (54)      | —              |
| gap_up          | 100% (2)       | 71% (7)       | 50% (4)       | **42% (33)**  | 14% (7)        |
| gap_up_strong   | 100% (1)       | 67% (18)      | 56% (9)       | **39% (33)**  | 33% (9)        |

(Bold = n≥30 with edge ≥10pp from 50/50.)

### Mean first-hour return (pts) — magnitude bias

| Gap \ Regime    | str_neg | negative | neutral | positive | str_pos |
|-----------------|--------:|---------:|--------:|---------:|--------:|
| gap_down_strong | +124.79 | +26.83   | +24.95  | -153.12  | —       |
| gap_down        | +146.00 | -62.10   | +71.82  | -42.00   | —       |
| flat            | +189.50 | **+58.12** | -12.94 | -16.23  | —       |
| gap_up          | +204.63 | +62.79   | -91.87  | **-52.06** | -34.32 |
| gap_up_strong   | +27.75  | +51.38   | +8.97   | **-69.22** | -27.69 |

### Magnitude tilt (mean MFE_up − mean MAE_dn) — large-n cells

- gap_up_strong × positive (n=33):  **-94.3 pts** — sustained downside dominance
- gap_up × positive       (n=33):   -57.8 pts
- flat × positive         (n=54):   -43.4 pts
- gap_up_strong × negative (n=18):  **+58.2 pts** — clean upside
- flat × negative         (n=23):   +62.0 pts
- gap_down_strong × negative (n=29): +34.9 pts (weak, but consistent with mean-reversion in negative gamma)

### Cells that meet the actionability bar (n≥30 AND optimal-direction WR≥60% OR magnitude≥10pts)

| Rank | Cell | n | dir | optWR | meanRet (pts) | magTilt | edgeScore |
|------|------|---|-----|-------|---------------|---------|-----------|
| 1 | gap_up_strong × positive | 33 | SHORT | 60.6% | -69.22 | -94.27 | 5.42 |
| 2 | gap_up × positive        | 33 | SHORT | 57.6% | -52.06 | -57.81 | 3.32 |
| 3 | flat × positive          | 54 | SHORT | 53.7% | -16.23 | -43.35 | 3.19 |

Several cells with strong WR fall below the n=30 bar (`flat × strong_negative` 100%(5), `flat × negative` 74%(23), `gap_down × neutral` 86%(7)) but flag the same theme: **negative-gamma days mean-revert; positive-gamma days fade extension**. Once strong_positive sample size grows, those cells should be added — `gap_up × strong_positive` (n=7) is already 86% short with -62 pts magnitude tilt.

## Mini-backtest grid for top 3 cells

Simulator: enter at 9:30 open, exit on first of (target hit, stop hit, 11:00 close). When both stop and target are touched in the same 1m bar, fill the **stop** first (conservative). Sharpe annualized assuming ≤1 trade/day.

### Cell 1 — gap_up_strong × positive — SHORT (n=33)
| stop | target | WR | PF | Sharpe | totalPts | avgPts |
|-----:|-------:|---:|---:|-------:|---------:|-------:|
| 10 | 50 | 45.5% | 4.17 | 9.18 | +570 | +17.27 |
| 15 | 50 | 51.5% | 3.54 | 9.03 | +610 | +18.48 |
| 10 | 30 | 51.5% | 3.19 | 8.42 | +350 | +10.61 |
| **20** | **30** | **57.6%** | **2.04** | **5.65** | **+290** | **+8.79** |

Tight stops (10-15) carry the highest PF/Sharpe but also high tail risk: if same-bar tiebreak in reality goes the other way more often, those numbers compress. The 20/30 baseline is the most defensible config.

### Cell 2 — gap_up × positive — SHORT (n=33)
| stop | target | WR | PF | Sharpe | totalPts | avgPts |
|-----:|-------:|---:|---:|-------:|---------:|-------:|
| 10 | 75 | 24.2% | 2.40 | 4.62 | +350 | +10.61 |
| 30 | 75 | 39.4% | 1.59 | 3.34 | +351 | +10.64 |
| 20 | 30 | 36.4% | 0.86 | -1.20 | -60 | -1.82 |

Cell 2 only works with **wide targets** (≥50). With a 30-pt target it loses, because the move is real but slow — many days drift -50 to -100 over the full hour but hit the 30-pt target rarely without first being stopped at -20. This cell is more of a "let it run" trade than a quick scalp.

### Cell 3 — flat × positive — SHORT (n=54)
| stop | target | WR | PF | Sharpe | totalPts | avgPts |
|-----:|-------:|---:|---:|-------:|---------:|-------:|
| 10 | 30 | 44.4% | 2.40 | 6.21 | +420 | +7.78 |
| **20** | **30** | **57.4%** | **2.02** | **5.59** | **+470** | **+8.70** |
| 40 | 30 | 72.2% | 1.95 | 5.34 | +570 | +10.56 |
| 20 | 75 | 37.0% | 2.18 | 5.18 | +801.5 | +14.84 |

Cell 3 has the best frequency (54 trades / 16 mo ≈ 3.4 trades/mo) and a very stable WR/PF surface across stops. The 20/30 config is the sweet spot.

## Proposed Strategy v0 — Three Filter-Cell Trades

These are intended to be combined into a single first-hour decision rule. On any RTH morning:

```
At 9:30 ET, read:
  gapPct  = (open_9:30 - prev_RTH_close) / prev_RTH_close
  regime  = nq-cbbo regime at-or-before 9:30 ET snapshot

If regime in {positive, strong_positive}:
  if gapPct > +0.5%:    SHORT_HARD   (Cell 1)
  if gapPct > +0.2%:    SHORT_FADE   (Cell 2 — wider target)
  if |gapPct| <= 0.2%:  SHORT_DRIFT  (Cell 3)

Otherwise: NO TRADE (insufficient sample or noisy)
```

### Variant A — SHORT_HARD (gap_up_strong × positive)
- **Entry**: SHORT NQ at 9:30 market
- **Trigger**: gapPct > +0.5% AND 9:30 GEX regime ∈ {positive, strong_positive}
- **Stop**: 20 pts above entry (~p65 of single-bar MAE; matches median MFE-up of 50pts as a comfortable buffer)
- **Target**: 30 pts below entry
- **Time stop**: 11:00 ET close (cancel and exit at market)
- **Frequency**: ~33 setups / 16 months ≈ 2 trades/mo
- **Per-trade EV**: +8.8 pts (≈$176 / NQ contract or $17.60 / MNQ)
- **Risk metrics**: WR 57.6%, PF 2.04, Sharpe 5.65 over 33 trades (unannualized PnL +290 pts)

### Variant B — SHORT_FADE (gap_up × positive)
- **Entry**: SHORT NQ at 9:30 market
- **Trigger**: +0.2% < gapPct ≤ +0.5% AND 9:30 GEX regime ∈ {positive, strong_positive}
- **Stop**: 30 pts above entry (this cell needs more room — moves slow but real)
- **Target**: 75 pts below entry
- **Time stop**: 11:00 ET close
- **Frequency**: ~33 setups / 16 months ≈ 2 trades/mo
- **Per-trade EV**: +10.6 pts. WR 39%, PF 1.59, Sharpe 3.34. Lower-frequency-of-win, larger-magnitude trade.

### Variant C — SHORT_DRIFT (flat × positive)
- **Entry**: SHORT NQ at 9:30 market
- **Trigger**: |gapPct| ≤ 0.2% AND 9:30 GEX regime = positive (note: only the un-modified `positive`, not `strong_positive` — n=0 there)
- **Stop**: 20 pts
- **Target**: 30 pts
- **Time stop**: 11:00 ET close
- **Frequency**: ~54 setups / 16 months ≈ 3.4 trades/mo
- **Per-trade EV**: +8.7 pts. WR 57.4%, PF 2.02, Sharpe 5.59.

### Combined ensemble
If you take all three signals as separate trades over the 16 months, you'd have 33+33+54 = 120 trades with combined PnL ≈ +290 + (run cell 2 at 30/75: +351) + 470 = **+1,111 pts** ≈ $22,220 / NQ contract / 16mo. Aggregate WR ≈ 50%, blended PF ≈ 1.95.

## Backtest-engine integration sketch

This is a **filter** rather than a stand-alone strategy. Two integration paths:

1. **As a stand-alone strategy** (`gap-regime-fade.js`):
   - New file: `shared/strategies/gap-regime-fade.js` extending `base-strategy.js`
   - Inputs: 1m candle stream, GEX `regime` field (from gex.levels msg)
   - State: latch `prevRthClose` from 4:00 ET candle close; latch `regime` from the snapshot at-or-before 9:30 ET
   - At first 9:30 ET bar `open`, evaluate gap and regime → emit `place_market` SHORT signal with one of three (stop, target) pairs from variant A/B/C
   - Emit time stop at 11:00 ET → `position_closed` if still open
   - CLI: `--ticker NQ --strategy gap-regime-fade --timeframe 1m --raw-contracts --gex-dir data/gex/nq-cbbo --start 2025-01-13 --end 2026-04-23`
   - Add to `strategy-factory.js` registry

2. **As a per-trade gate / filter** that wraps another first-hour strategy:
   - Add `--require-regime positive,strong_positive` and `--require-gap-bucket gap_up,gap_up_strong,flat` flags to existing engine
   - Strategies subscribe to filter results and short-circuit signals when not in matching cell
   - This is more flexible: the same matrix can gate ORB, IV-skew, sweep-reversal, etc.

Recommended: implement as **path 2** (filter) since the matrix is more about regime-conditioning than a price-pattern signal.

## Caveats / Followups

- **Regime distribution is unbalanced** (45% of days are `positive`). Strong_positive (n=16 total) is interesting but underpowered; revisit when more data accumulates.
- **Same-bar tiebreak is conservative**. The simulator assumes the stop fills before the target whenever both touch in the same 1m bar. Real-world fills typically split closer to 50/50, which would meaningfully improve the tight-stop variants (10-15pt stops). To remove this assumption, the engine would need to walk 1s bars in the disputed minute — feasible since `data/ohlcv/nq/NQ_ohlcv_1s_continuous.csv` exists.
- **No OOS holdout was performed** for this analysis (n is too small to split usefully). Recommended next step: re-run on the last 2 months as walk-forward validation.
- **Variant B PF is borderline** (1.59 with the wide-target config). It's likely the weakest of the three and could be dropped or downsized.
- **The `gap_down_strong × strong_negative` cell** is theoretically attractive (75% WR, n=12, mean +124.8pts) but n is too small to act on alone. Combining with other negative-gamma + sweep prediction signals (T1/T2) might bring it to actionable size.
- **Magnitude tilts on small cells** (`flat × strong_negative` +189pts, `gap_up × strong_negative` +204pts) all point the same direction (long mean-reversion in negative gamma). When more strong_negative days are observed, those cells should jump straight to actionable.
- **Per-day data file is included** in the JSON so any downstream track can re-aggregate without re-loading 450k candles.
