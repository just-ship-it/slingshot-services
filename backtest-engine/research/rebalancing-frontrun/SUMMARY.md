# Rebalancing Front-Run (Harvey/Mazzoleni/Melone NBER w33554) — Replication

**Date:** 2026-07-05/06 · **Status:** Phase 1 (proxy-fidelity) DONE — qualitative replication
succeeded; NO independent OOS confirmation post-2023. Futures-exact rerun needed before any
deployment decision.

## What this is

Front-run mechanical 60/40 institutional rebalancing in an ES-vs-10Y-note (ZN) futures pair.
Signals per Appendix B: simulate 60/40 portfolios whose equity weight drifts with daily
relative returns; **Threshold** signal = mean drifted deviation across 26 sims (δ=0..2.5%
step 0.1%, reset to 60% the day after |dev|≥δ); **Calendar** signal = same with reset on
last business day of month. Strategy (Section 4): `R = (rE − rB) · w`,
`w = (−Thr/1.5% + calLeg)/2`, calLeg = sign(−Cal) in last 5 BD, sign(Cal_[−4BD]) on first
BD (reversal), else 0. Position at close t earns t+1.

## Implementation

- `01-fetch-data.js` — Yahoo daily (SPY, IEF, VFITX, ES=F, ZN=F) + FRED (DGS10, DTB3).
  **Gotcha fixed:** Yahoo needs `period1/period2` (not `range=max`, which silently returns
  MONTHLY bars) and timestamps are session-start epochs — do NOT add +12h (shifts every
  date +1 day, corrupts month-end detection, and drops all Fridays vs FRED alignment).
- `02-build-signals.js` — exact Appendix-B sims. Signal = drifted deviation
  `drift(W[i-1], r[i]) − 60%` (δ=0 ⇒ one-day drift ≈ 0.24·(rE−rB), matches paper fn 8);
  tracked weight resets the day AFTER breach / on first BD.
- `03-backtest.js` — strategy + legs, turnover costs (1bp base), `--lag` stress, paper
  window vs OOS split, per-year table. `04-regression-decay.js` — paper eq. 1/3 with HC SEs.
- Two bond-leg variants: `etf` (VFITX→IEF splice) and `dgs10` (10Y par-bond return from
  FRED yields). Equity = SPY total return. RF cancels in the long-short difference.

## Results

**Validation, paper window 1997-09-10 → 2023-03-17** (paper: 10.20%/9.17% vol/Sharpe 1.11/skew 5.23):

| | gross ret | vol | Sharpe | skew |
|---|---|---|---|---|
| etf bond leg | 7.64% | 10.35% | **0.74** | 5.78 |
| dgs10 bond leg | 6.57% | 10.29% | **0.64** | 4.52 |

corr(Thr,Cal) = 0.62–0.63 (paper 0.605). 2008: +57%; 2020: +23% — crisis-convex like the
paper (ex-GFC/COVID Sharpe 0.56–0.59 vs paper 0.90). Threshold regression γ1 = −0.23
(t=−3.8) vs paper −0.33 (proxy attenuation expected: ETF legs ≠ ES/TY futures, IEF dur 7.4
vs CTD ~6.4, VFITX 5.2 pre-2002). Qualitative replication: **confirmed**.

**True out-of-sample 2023-03-18 → 2026-07** (~3.3yr, post paper circulation):

| | net Sharpe | Threshold leg | Calendar leg |
|---|---|---|---|
| etf | 0.15 | **−0.21** | +0.50 |
| dgs10 | 0.37 | −0.09 | +0.73 |

2024/2025/2026 each ~flat-to-negative. OOS regressions: Threshold γ1 halves to −0.10/−0.12
(t≈−0.8, underpowered); Calendar·week4 flips sign (+0.07, ns). The Calendar STRATEGY leg
stays profitable OOS (nonlinear sign rule + first-BD reversal trade) and — unique among the
pieces — **survives a 1-day execution lag** (+0.76 OOS).

**Lag stress:** lag-1 kills the Threshold edge in-sample (leg Sharpe 0.73→0.24) — the alpha
is entirely in the first next day. Execution must be at/near the signal-day close (paper
fn 28: 3:30pm signals work too). Costs are immaterial at 1–2bp/turnover.

## Verdict

- Mechanism replicates in-sample at proxy fidelity, with the paper's fingerprints (skew,
  crisis convexity, signal corr).
- **No independent OOS confirmation:** the always-on Threshold component — most exposed to
  crowding after AFA-2026 publicity — is ≤0 OOS on proxies. Only the month-end Calendar
  sleeve (~6 trade-days/month) made money OOS, and it's lag-robust.
- Cannot yet distinguish "decayed" from "quiet regime" (strategy is crisis-convex; 2023-26
  had no high-friction episode) nor from proxy noise (paper fn 32 claims through-2025
  results are STRONGER on their futures data — direct tension with our proxy OOS).

## Next steps (Phase 2, before any deploy decision)

1. **Futures-exact data:** download ZN daily OHLCV (GLBX, 2010→) + reuse our ES; apply the
   paper's roll rule (roll at end of month preceding expiry; use 2nd contract during expiry
   month). Rerun validation + OOS. This settles the fn-32 tension.
2. If OOS confirms on futures: size a **Calendar-sleeve-first** implementation (MES + Micro
   10Y *Yield* futures — note yield quote ⇒ inverted sign; no price-quoted micro 10Y note
   exists; 1 ZN ≈ 3.2 MES notional). Threshold sleeve only if futures OOS rehabilitates it.
3. Optional: condition Threshold exposure on friction regime (VIX/MOVE high) per Table 6
   Panel C — its alpha is 3-4× larger in high-friction halves.

## Broker facts (2026-07-05)

Tradovate: ZN tradable (standard CBOT). Micros = Micro Treasury **Yield** futures (2YY/5YY/
10Y/30Y), cash-settled, yield-quoted (inverse to price), $1/0.1bp, ~$175 maint margin.
