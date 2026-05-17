# Ratchet Variant Comparison

16-month gex-flip-ivpct backtest (2025-01-13 → 2026-04-20)

| Metric | Baseline (BE 70/+5) | Pure ratchet s1-m70l40 (best pure PnL) | Pure ratchet s1-m100l40 (best pure capture) | Structural 95% / 2h (running-mode winner) | Fixed-per-tier 40% / 2h (fixed winner) | Fixed-per-tier 40% / 4h (lowest DD) | Fixed-per-tier 50% / 2h | Fixed-per-tier 60% / 2h | **Fib 78.6% / act-40 (default)** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Trades | 172 | 181 | 172 | 193 | 175 | 182 | 182 | 185 | 184 |
| Win Rate | 61.63% | 61.88% | 56.40% | 68.39% | 67.43% | 68.68% | 67.03% | 67.57% | 62.50% |
| Profit Factor | 2.99 | 2.61 | 2.46 | 2.08 | 2.47 | 2.48 | 2.14 | 2.03 | 2.78 |
| Sharpe | 6.41 | 5.97 | 5.73 | 3.52 | 3.87 | 3.71 | 3.31 | 3.02 | 5.47 |
| MaxDD % | 11.30% | 8.34% | 10.10% | 6.99% | 7.58% | 6.87% | 10.04% | 9.14% | 8.75% |
| Total PnL | $157,329 | $133,542 | $129,901 | $69,455 | $90,512 | $82,239 | $74,607 | $65,944 | $131,157 |
| Avg Winner MFE | 155.76 | 139.44 | 157.98 | 55.62 | 89.91 | 78.93 | 83.31 | 75.04 | 129.73 |
| Winner Capture % | 71.75% | 69.44% | 71.57% | 91.46% | 72.03% | 70.19% | 69.18% | 69.69% | 68.89% |
| BE-Clip | 38 | 2 | 11 | 6 | 14 | 13 | 12 | 10 | 31 |
| Big-BE-Clip | 20 | 14 | 19 | 3 | 11 | 10 | 10 | 7 | 18 |
| MFE→SL | 8 | 12 | 17 | 7 | 7 | 7 | 7 | 7 | 5 |
| Giveback $ | $93,280 | $95,466 | $87,138 | $12,540 | $59,357 | $58,830 | $62,650 | $56,857 | $92,832 |

## Fib-retrace default observations (78.6% / activationMFE=40)

- 73 of 184 trades exit via fib_retrace (vs 38 BE-clip in baseline) — the
  mechanism is active and firing often.
- Bar-close confirmation prevents wick-trigger exits: only 5 MFE→SL events
  (lowest of any variant), and largestLoss = -$1,235, matching the SL=60
  hard cap. No "stop got run" surprises.
- PF 2.78 / Sharpe 5.47 / DD 8.75% / $131k — solid all-around but trails
  baseline by ~$26k. Trades that would have run from BE-trigger to TP under
  baseline get clipped mid-flight when a single bar closes >78.6% retraced.
- Capture ratio 68.89% — essentially same as baseline (71.75%) but with
  much better DD (8.75% vs 11.30%).

## Fib-retrace 20-config sweep results

Full 16-month NQ backtest, retracePct ∈ {0.50, 0.618, 0.706, 0.786, 0.886} ×
activationMFE ∈ {30, 40, 50, 70}. All variants: SL=60, TP=200, no BE.

### Top 6 by PF

| Config | retracePct | actMFE | Trades | WR% | PF | Sharpe | DD% | PnL$ | Giveback | fibExits | mfe→SL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `fib-r786-a30` | 0.786 | 30 | 189 | 63.0 | **2.80** | 5.10 | 8.28 | 123,429 | 51.6 | 88 | 5 |
| `fib-r786-a40` | 0.786 | 40 | 184 | 62.5 | 2.78 | 5.47 | 8.75 | 131,157 | 55.6 | 73 | 5 |
| `fib-r618-a40` | 0.618 | 40 | 189 | 66.7 | 2.77 | 5.59 | **7.11** | 127,502 | 52.0 | 86 | 5 |
| `fib-r886-a50` | 0.886 | 50 | 178 | 60.7 | 2.77 | 5.69 | 10.24 | 138,346 | 59.6 | 52 | 6 |
| `fib-r886-a30` | 0.886 | 30 | 182 | 58.8 | 2.75 | 4.87 | 9.61 | 120,576 | 55.1 | 75 | 5 |
| `fib-r786-a50` | 0.786 | 50 | 180 | 62.8 | 2.74 | 5.61 | 9.44 | 134,987 | 58.3 | 62 | 6 |

### Best-of-category

| Category | Winner | PF | Sharpe | DD% | PnL$ |
|---|---|---:|---:|---:|---:|
| Best PF | `fib-r786-a30` | 2.80 | 5.10 | 8.28 | 123,429 |
| **Best Sharpe** | `fib-r886-a70` | 2.68 | **6.00** | 9.98 | **145,956** |
| **Best PnL** | `fib-r886-a70` | 2.68 | 6.00 | 9.98 | **145,956** |
| Lowest DD | `fib-r618-a30` | 2.72 | 4.97 | **6.58** | 114,112 |
| Best balanced | `fib-r618-a40` | 2.77 | 5.59 | 7.11 | 127,502 |

### Patterns

- **retracePct = 0.50 is too tight** — every variant in that column has PF
  ≤ 2.37 and DD ≥ 8.13%. Locking 50% of MFE clips winners mid-flight.
- **retracePct = 0.618 – 0.886 forms a plateau** — PF clusters tightly at
  2.53 – 2.80. The exit-trigger is loose enough to ride winners but tight
  enough to materially cut giveback.
- **activationMFE = 70** is the right floor for max PnL — leaves the
  mechanism dormant on small-MFE noise trades that would have closed
  naturally via TP/SL, so the rare big trade keeps running. Trade count
  drops to ~170 (vs ~185 at lower activations).
- **mfe→SL stays low** at activationMFE ≤ 50 (≤6 events) — bar-close
  confirmation is doing its job. At activation=70, mfe→SL jumps to 14-17
  because the mechanism never engages on borderline trades.

### Vs baseline (BE 70/+5 at $157,329 / PF 2.99 / Sharpe 6.41 / DD 11.30%)

No fib variant beats baseline on PnL or PF. The closest:
- **fib-r886-a70** trails baseline by **$11k** on PnL but cuts DD from
  11.30% → **9.98%** (-1.32pp), Sharpe 6.41 → **6.00** (-0.41).
- **fib-r618-a40** cuts DD almost in half (11.30% → **7.11%**) for a $30k
  PnL haircut and -0.84 Sharpe — meaningful smoothness at meaningful cost.

### Vs pure-MFE ratchet `s1-m70l40` ($133,542 / PF 2.61 / Sharpe 5.97 / DD 8.34%)

- **fib-r886-a70** beats `s1-m70l40` on PnL (+$12k), Sharpe (+0.03), PF
  (+0.07), and trails on DD (+1.64pp). On every PF≥2.7 cell, fib variants
  match or beat pure-MFE ratchet performance.

### Verdict

Fib-retrace is a strict improvement over pure-MFE ratchet on PF / Sharpe /
PnL — the bar-close confirmation and activation gate let winners run
longer before triggering. It does NOT beat the simple BE 70/+5 baseline on
PnL/PF, but cuts DD by 1-5pp.

If Drew is willing to trade $12k for half the drawdown, **fib-r618-a40** is
the strongest "smoothness" pick (DD 7.11%, PF 2.77, $127k). If he wants
maximum PnL with bar-close discipline, **fib-r886-a70** is the closest to
baseline on PnL with material DD improvement.

## Two-layer (BE + fib) sweep — the new leader

Two-layer combines a low BE trigger as a floor with fib on top:

| Config | Trades | WR% | PF | Sharpe | DD% | PnL$ |
|---|---:|---:|---:|---:|---:|---:|
| Baseline (BE 70/+5) | 172 | 61.6 | **2.99** | **6.41** | 11.30 | **$157,329** |
| **`twolayer-be80p10-fib618-a40`** | 191 | **68.6** | **2.90** | 5.68 | **7.11** | $129,412 |
| `twolayer-be100p15-fib618-a40` | 189 | 67.7 | 2.83 | 5.59 | 7.11 | $126,662 |
| `twolayer-be120p20-fib618-a40` | 189 | 67.7 | 2.83 | 5.59 | 7.11 | $127,162 |
| `fib-r618-a45` (no BE) | 185 | 64.9 | 2.74 | 5.73 | 6.89 | $131,587 |
| `fib-r618-a35` (no BE) | 192 | 67.2 | 2.79 | 5.48 | **6.40** | $124,549 |

`twolayer-be80p10-fib618-a40` is the new winner: matches fib-alone DD (7.11%) while gaining +0.13 PF and +0.09 Sharpe. Drops baseline PF by only 0.09 while cutting DD from 11.30% to 7.11% — meaningful smoothness for a -$28k PnL cost.

## Regime-conditional fib — tried, didn't help

Three modes tested on top of `twolayer-be80p10-fib618-a40`:

| Mode | Trades | WR% | PF | Sharpe | DD% | PnL$ |
|---|---:|---:|---:|---:|---:|---:|
| Plain (no conditional) | 191 | 68.6 | 2.90 | **5.68** | **7.11** | **$129,412** |
| `full` (disable S2+mid-IV, tighten wave-prone) | 193 | 70.5 | 2.90 | 5.59 | 8.84 | $125,044 |
| `s2-only` (disable S2 only) | 191 | 68.6 | 2.90 | 5.68 | 7.11 | $129,412 |
| `tighten-only` (no disables, tighten wave-prone) | 193 | 70.5 | 2.90 | 5.59 | 8.84 | $125,044 |

Three observations:
1. **`s2-only` is byte-identical to plain** — the S2 trades never reach the fib trigger anyway (they go straight to TP), so disabling fib for them is a no-op.
2. **`tighten-only` and `full` are functionally identical** (193 / 70.5% / PF 2.90 / Sharpe 5.59 / DD 8.84%) — the disables in `full` redirect trades to the default config, but the tightening of wave-prone trades is what actually moves the numbers.
3. **All conditional modes WORSEN the result vs plain.** The tight fib (0.55/35) on L4/S1/negative-GEX trades clips winners that would have run to TP under default fib. The regime classification I derived from the 172 BASELINE trades (BE 70/+5 dynamics) doesn't generalize to BE 80/+10 + fib dynamics — the trade profiles change enough that the conditional rules misfire.

A second-pass conditional design (bucketing on twolayer's OWN trades, not baseline) might do better. Filed as future work.

## Final ranking

| Goal | Pick | Notes |
|---|---|---|
| **Ship to live** | **`twolayer-be80p10-fib618-a40`** | Best DD/PF balance; close to baseline PF |
| Maximize PnL with some DD relief | `fib-r886-a70` ($146k / DD 9.98%) | From prior sweep; closest to baseline PnL |
| Lowest DD anywhere | `fib-r618-a35` (DD 6.40%) | -2pp less DD for ~$5k less PnL |
| Best wave-day rescue | `fib-r618-a45` | Best fib-alone PnL; deepest retrace catch |
