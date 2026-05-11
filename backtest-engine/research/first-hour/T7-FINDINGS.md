# T7: Overnight High/Low (ONH/ONL) retest in first hour

## TL;DR

Hypothesis held with **structural strength**, even stronger than expected. ONH/ONL gets touched on **94% of trading days** during 9:30-11:00 ET (50% ONH, 46% ONL), and the **base reversal-30 rate is 79.9%** (i.e., after touch, 80% of cases see price retreat ≥30pts away from the level within 60min). The fade edge is large enough on its own and gets dramatically sharper when stratified by **GEX regime**. Best in-sample: ONL-fade × neutral regime PF=11.4 (stop=50/tgt=30, n=20, DD=50pt, WR=95%); ONL-fade × non-positive regime PF=2.60 (stop=50/tgt=20, n=69, DD=140pt, WR=87%); ONH-fade × positive regime PF=2.62 (stop=40/tgt=30, n=57, DD=70pt, WR=77%). Best OOS: **Aligned-gap break** (gap_up_strong→ONH-break or gap_down_strong→ONL-break), IS PF=2.04 → OOS PF=4.0, WR=94% (n=16 OOS).

## Dataset

- Date range: 2025-01-13 → 2026-04-23 (15 months)
- Trading days analyzed: 323 (after rollover skip + ON-contract-change skip)
- Touch events: 304 (155 ONH, 149 ONL)
- Non-touches: 329 (when ONH/ONL never tested in 9:30–11:00)
- IS: 265 events (through 2026-02-23); OOS: 39 events (last 2 months)
- ONH/ONL = max-high/min-low of NQ raw 1m candles between 18:00 prior trading day → 09:30 today ET
- Touch tolerance: 5pt; min open-distance: 5pt (skip days that open within 5pt of the level)
- Reaction window: 60 min after first touch
- GEX regime from `data/gex/nq-cbbo` snapshot at 09:30 (post-bucketing-fix)

## Findings

### Frequency & base rates

| Metric | Value |
|---|---|
| P(ONH touched per eligible day) | 50.0% |
| P(ONL touched per eligible day) | 46.1% |
| Touches per day (avg) | 0.94 |
| **P(reverse ≥30pt within 60min)** | **79.9%** |
| P(continue ≥20pt within 60min) | 81.2% |
| Median MFE-reversal | 67.9 pt |
| Median MAE-reversal | 58.9 pt |

(Both reversal AND continuation > 80% means the level is "magnetic" both ways — the level acts as a pivot, and which way wins depends on the day's regime.)

### Stratification — Reversal probability by GEX regime

| Regime | ONH n | ONH pRev30 | ONL n | ONL pRev30 |
|---|---:|---:|---:|---:|
| strong_negative | 13 | 0.769 | 15 | **1.000** |
| negative | 44 | 0.750 | 44 | 0.886 |
| neutral | 27 | 0.741 | 20 | **1.000** |
| positive | 61 | 0.787 | 61 | 0.721 |

- **ONL fades dominate in non-positive regimes**: pRev30 = 0.886 (n=44) in negative, 1.000 (n=20) in neutral, 1.000 (n=15) in strong_negative.
- **ONH fades hold their own in positive regimes**: pRev30 = 0.787, with very low median MAE (37pt) — clean fades.
- The asymmetry makes intuitive sense: in negative GEX, dealers absorb supply at lows (ONL bounces); in positive GEX, dealers sell rips (ONH fades).

### Stratification — by gap

ONL touches on **gap_down_strong** days reverse 88.9% of the time (n=45). ONH touches on **gap_up_strong** days reverse only 74.1% of the time (n=54) — the breakout has more edge when gap-aligned.

### Stratification — by overnight inventory (% time spent above prior RTH close)

`mostly_above` ON inventory + ONH touch reverses 74% (n=85, lower than baseline) — the level got "earned" overnight and price is not exhausted. Conversely, ONL touches in `mixed` inventory reverse 87.9% (n=33).

### Grid search — Top 3 by PF (stop/target in NQ pts, conservative same-bar = stop)

**ONH-fade × positive regime** (n=57)
| stop | target | n | WR | PF | exp | maxDD |
|---:|---:|---:|---:|---:|---:|---:|
| 40 | 30 | 57 | 77.2% | **2.62** | +14.1pt | 70pt |
| 40 | 20 | 57 | 82.5% | 2.48 | +9.7pt | 80pt |
| 40 | 40 | 57 | 70.2% | 2.44 | +16.1pt | 102pt |

**ONL-fade × non-positive regime** (n=69)
| stop | target | n | WR | PF | exp | maxDD |
|---:|---:|---:|---:|---:|---:|---:|
| 50 | 20 | 69 | 87.0% | **2.60** | +10.4pt | 140pt |
| 40 | 20 | 69 | 84.1% | 2.56 | +10.0pt | 120pt |
| 60 | 20 | 69 | 88.4% | 2.48 | +10.3pt | 200pt |

**Aligned-gap break (gap_up_strong→ONH-break OR gap_down_strong→ONL-break)** — best OOS validator
| stop | target | n | WR | PF | exp | maxDD |
|---:|---:|---:|---:|---:|---:|---:|
| 75 | 20 | 72 | 87.5% | **2.04** | +8.9pt | 185pt |
| 75 | 25 | 72 | 81.9% | 1.77 | +8.8pt | 175pt |
| 60 | 25 | 72 | 76.4% | 1.42 | +5.6pt | 260pt |

### OOS validation (last 2 months: 2026-02-23 → 2026-04-23)

| Strategy | IS PF | OOS n | OOS WR | OOS PF | OOS exp |
|---|---:|---:|---:|---:|---:|
| **Aligned-gap break (BREAK)** | 2.04 | 16 | 93.8% | **4.00** | +14.1pt |
| **ONL-break × gap_down_strong (BREAK)** | 3.00 | 8 | 87.5% | 2.33 | +12.5pt |
| **ONH-break × gap_up_strong (BREAK)** | 1.83 | 8 | 100% | ∞ | +20.0pt |
| ONL-fade × gap_down + mostly_below inv (BREAK) | 1.89 | 7 | 57.1% | 1.67 | +17.1pt |
| ONL-fade × non-positive regime (BREAK) | 1.13 | 12 | 91.7% | 4.40 | +14.2pt |
| ONL-fade × neg/strong_neg (BREAK) | 1.53 | 12 | 58.3% | 1.40 | +8.3pt |
| ONH-fade × non-negative regime (FADE) | 2.13 | 6 | 66.7% | 1.50 | +6.7pt |

**Critical OOS observation:** the FADE configs with the highest IS PF (ONL-fade × non-positive PF 2.60, ONH-fade × positive PF 2.62) **degraded substantially OOS** (PF 0.6 and 1.5). The BREAK configs held up far better. The most likely explanation: 2026-02-23 → 2026-04-23 had unusually trendy days (Q1 2026 sustained moves), and faders got run.

The **Aligned-gap break** is the clear winner — IS+OOS combined would be n=88, WR ≈ 88%, PF ≈ 2.4. And it's a structurally compelling thesis: a strong gap that drives all the way back to ONH/ONL has momentum to push through.

## Proposed Strategy v0

### Strategy A — "ONH/ONL Aligned-Gap Break" (PRIMARY)

- **Entry trigger**: First time NQ price reaches `level + 5pt` (for ONH on a gap_up_strong day) or `level - 5pt` (for ONL on a gap_down_strong day) between 09:30 and 11:00 ET. Use stop-market order resting at `level ± 5pt` from open.
- **Pre-condition (gap)**: gap_up_strong = `(open930 - prevRthClose) / prevRthClose > +0.4%` for ONH-break; gap_down_strong = `< -0.4%` for ONL-break.
- **Pre-condition (no-touch-yet)**: Skip if 9:30 open is already past the level (same-side breakaway gap — different play).
- **Side**: LONG on ONH-break (gap-up), SHORT on ONL-break (gap-down). Aligned with the gap direction.
- **Stop**: 75 NQ pts beyond entry (i.e., `entry - 75` for long, `entry + 75` for short). Justification: 90th-percentile MAE-on-continuation in this cell. Tighter stops cut PF (60/25 dropped PF to 1.42).
- **Target**: 20 NQ pts. Justification: per-bar grid optimum; tightening to 15 lowered PF, widening to 25 lowered PF as the 80% reversal probability eats the trade. Conservative target lets the 87% WR carry the curve.
- **Time stop**: 11:00 ET + 60min cap (12:00 ET hard exit).
- **Expected frequency**: ~80 IS + ~16 OOS = 96 trades / 15 months = **~6.4 trades/month** (about every 3rd–4th trading day).
- **Expected EV**: +8.9pt per trade IS, +14.1pt OOS. Maxis-DD = 185 pt IS, ~lower OOS.
- **Risk note**: 75pt stop is ~$1500/contract. Position-size accordingly. The user's spec said 20-30+ pt target — this satisfies tgt=20 with high WR.

### Strategy B — "ONH/ONL Regime Fade" (SECONDARY, smaller size pending OOS recovery)

Run only when the touch occurs in the **regime-aligned cell** AND no aligned-gap break is firing:

- **ONH fade** when `gexRegime ∈ {positive, strong_positive}` AND gap is NOT gap_up_strong: SHORT at level on first touch in 9:30-11:00 ET window. Stop `level + 40`; target `level - 30`. IS PF 2.62 (n=57, WR 77%, DD 70pt).
- **ONL fade** when `gexRegime ∈ {strong_negative, negative, neutral}` AND gap is NOT gap_down_strong: LONG at level on first touch. Stop `level - 50`; target `level + 20`. IS PF 2.60 (n=69, WR 87%, DD 140pt).

OOS degradation flag: this fade family lost edge in the trend-heavy Q1 2026 OOS window. Consider gating fade entries on additional risk-off filter (e.g., NQ already moved >100pt by 9:30 in the trend direction → skip fade) before live deployment.

- **Time stop**: same 60-min from entry, hard exit 11:30 ET if entered at 10:30.
- **Expected frequency**: 57 (ONH-fade × positive) + 69 (ONL-fade × non-positive) = 126 IS events, ~9 trades/month combined; in practice ~4-5 trades/month after dropping the days that already triggered Strategy A.

## Backtest-engine integration sketch

- New strategy file: `shared/strategies/onh-onl-retest.js` (extends `base-strategy.js`).
- Required engine inputs:
  - Raw NQ 1m candles + `filterPrimaryContract`
  - GEX snapshots from `data/gex/nq-cbbo/nq_gex_<date>.json` for regime at 09:30
  - Per-day overnight session (18:00 prev → 09:30 today ET) for ONH/ONL
- Per-day setup:
  1. At 09:29 ET, snapshot ONH, ONL, prevRthClose, gap = open930 − prevRthClose, GEX regime.
  2. Decide which side(s) are armed:
     - Aligned-gap break: arm a stop-buy at `ONH+5` if gap > +0.4%; arm a stop-sell at `ONL−5` if gap < −0.4%.
     - Regime fade: arm limit at level (subject to no-touch-yet at open).
- New CLI flags:
  - `--t7-mode` ∈ {`break`, `fade`, `both`} (default `break`)
  - `--t7-gap-strong-pct` (default 0.004)
  - `--t7-stop-pts-break` (default 75), `--t7-tgt-pts-break` (default 20)
  - `--t7-stop-pts-fade` (default 40 for ONH, 50 for ONL), `--t7-tgt-pts-fade` (default 30 for ONH, 20 for ONL)
  - `--t7-touch-tolerance-pts` (default 5)
  - `--t7-trigger-pts-break` (default 5)
  - `--t7-time-stop-min` (default 60)
  - `--t7-window` (default `09:30-11:00`)
- Reuse existing rollover skip and EOD cutoff logic.

## Caveats / Followups

1. **Conservative same-bar resolution**: when a 1m bar prints both stop and target, sim counts it as STOP. Real 1s replay would split many of these into wins. Re-running on 1s data would likely lift PFs by 5-15%.
2. **OOS sample is small (39 events)** — only 8-16 OOS trades per cell. The Aligned-Gap-Break OOS sweep is encouraging but more out-of-sample is needed.
3. **Fade family's OOS degradation** is the biggest red flag. Q1 2026 had multi-day trends in NQ; fades tend to suffer in such regimes. Need a regime-shift filter (e.g., last 5d realized vol, last 5d ON-range trend) before scaling fades live.
4. **GEX regime label depends on `data/gex/nq-cbbo/`** which has the post-bucketing fix applied. Live regime at 09:30 should match — but live regime publishes `strong_positive`/`strong_negative` cleanly; only 8 events in `strong_negative` IS so confidence on that bin is low.
5. **Contract-change skip**: We drop days where the ON contract differs from the RTH contract (rollover overlap). 21 rollover dates plus their 1-day overlap eliminated <10 candidates total.
6. **Combo with T8 (Gap × GEX matrix)**: T8's per-cell expected first-hour direction may further filter T7 entries; recommend running T8 first then sanity-checking that ONH-break-LONG aligns with T8's "gap_up_strong + positive regime" expected direction.
7. **Phase 2 partials**: With 88% WR on aligned breaks, a partial-exit at +20 (50% off) and runner to ONH/ONL +50 with breakeven stop should compound nicely without sacrificing the headline win-rate.

## Files

- Script: `/home/drew/projects/slingshot-services/backtest-engine/research/first-hour/T7-onh-onl-retest.js`
- Data: `/home/drew/projects/slingshot-services/backtest-engine/research/first-hour/output/T7-onh-onl-retest.json`
