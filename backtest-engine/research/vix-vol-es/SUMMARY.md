# Vol-regime filter on the 4-strategy FCFS NQ portfolio — findings + rule set

Status: **EXPLORING (not deployed).** Goal: use a volatility-regime signal to FILTER the production
4-strategy FCFS NQ book (lstb / gex-flip-ivpct / gex-lt-3m / gex-level-fade) per-strategy and lift
blended PF / drawdown without wrecking Sharpe. Feeds the portfolio-filter research.

## Headline result (v2, QQQ intraday vol, full $614,730 window)

Baseline FCFS (2025-01-13 → 2026-04-23): **PnL $614,730 / PF 1.77 / Sharpe 10.8 / maxDD $11,642.**

| Version | Full PnL | Full PF | Full Sharpe | Full maxDD | Test PF (OOS) |
|---|---|---|---|---|---|
| baseline | $614,730 | 1.77 | 10.8 | $11,642 | 2.04 |
| per-strat robust | $522,895 | 2.11 | 9.9 | $11,145 | 2.45 |
| **greedy joint** | $420,529 (−32%) | **2.24** (+27%) | **10.3** (≈flat) | **$8,300** (−29%) | 2.41 |

**Greedy-joint is the standout**: PF +27%, drawdown −29%, Sharpe essentially preserved (unlike
independent picks, where filtering lstb dropped Sharpe). Cost = −32% PnL (a PF/DD-for-PnL trade).

**Per-slice stability (improves PF in EVERY quarter — not split-lucky):**
```
Q1 base 1.84 → robust 2.14 → joint 2.22
Q2 base 1.46 → robust 1.62 → joint 1.99
Q3 base 1.47 → robust 1.92 → joint 1.74
Q4 base 2.02 → robust 2.55 → joint 2.87   (OOS)
Q5 base 2.03 → robust 2.28 → joint 2.23   (OOS)
```

## Feature definitions (QQQ = Nasdaq-native, live-computable)

- **ivPct** — percentile of CURRENT QQQ ATM IV (~7-DTE, read at signal time) vs trailing-252
  daily-close QQQ ATM IV. Full coverage 2025-01→2026-04 (intraday, from `iv/qqq/qqq_atm_iv_1m.csv`;
  live = data-service ATM-IV calculator + 252-day buffer).
- **ivChg** — QQQ daily-close ATM IV today ÷ 5 trading days ago − 1 (>0 = vol rising).
- **slope** — QQQ term_slope (dte0→dte2), prior-day close (<0 = backwardation/stress). From
  `iv/qqq/qqq_short_dte_iv_daily.csv`. **DATA WALL: ends 2026-01-28** (OPRA-stats pipeline) → in
  BACKTEST slope gates pass-through after that; live always available.

## RULE SET — greedy joint (each strategy fires only if gate passes; fail → slot frees, FCFS)

| Strategy | Gate (allow only when…) |
|---|---|
| LS_FLIP_TRIGGER_BAR (lstb) | `ivPct ≥ 0.50 AND ivChg > 0` (elevated AND rising vol) |
| GEX_LEVEL_FADE (glf) | `ivPct ≥ 0.50 AND slope < 0` (elevated AND backwardated) |
| GEX_LT_3M_CROSSOVER (glx) | `slope < 0` (backwardated) |
| GEX_FLIP_IVPCT (gfi) | `ivPct ≥ 0.67` (top third of 1-yr IV range) |

## RULE SET — per-strat robust (CONSERVATIVE, recommended for first deploy)

More robust (each gate independently improves BOTH train and test; no filter forced onto glx;
leans on full-coverage IV-level/change, not the slope data-wall feature):

| Strategy | Gate |
|---|---|
| lstb | `ivPct ≥ 0.50 AND ivChg > 0` |
| glf  | `ivChg < 0` (falling vol) |
| gfi  | `ivPct ≥ 0.33` |
| glx  | none (no robust vol edge) |
→ Full PF 2.11 / Sharpe 9.9 / DD $11,145 / PnL $522,895; test PF 2.45.

## What each thread found
- **Richer features cracked gfi** (got a robust filter under QQQ+vol-change; got *none* under SPY).
  **glx has no robust standalone vol edge** (none independently; joint uses a mild slope<0).
- **Vol momentum (ivChg) matters** — lstb wants high AND rising; glf wants falling.
- **QQQ (Nasdaq-native) > SPY/VIX** for these NQ strategies, AND its 1m IV solves the data wall.
- Greedy-joint (accounts for FCFS slot reallocation) beats stacking independent picks.

## Honest caveats
- −32% PnL cost (joint) / −15% (robust) — PF/DD-for-PnL trade (per Drew's preference).
- lstb-dominated (80% of trades) — most of the effect is "run lstb only in elevated+rising vol".
- Joint fits 4 gates on ~9mo train (overfit-prone); robust (3 gates, both-halves) is safer.
- slope gates inactive in backtest after 2026-01-28 (term-structure data wall; live unaffected).
- Backtest validatable only where vol data exists; live deployment has current vol always.

## Pipeline (`research/vix-vol-es/`)
- `01-vix-termstructure-es.js` — vol as ES TIMING (DEAD: just long-equity beta, no short side).
- `02-vol-regime-filter.js` — regime × existing book discovery (raw splits).
- `03-vol-filter-fcfs.js` — VIX/SPY causal portfolio-gate POC (train/test).
- `04-per-strategy-sweep.js` — SPY-IV per-strategy sweep (data wall → ~$475k window).
- `05-qqq-intraday-sweep.js` — **QQQ intraday, richer features, greedy joint, per-slice stability
  (THE definitive run; full $614,730 window).** Picks in `output/`.

## Next ideas (not done)
threshold sensitivity around each gate; robust-vs-joint walk-forward; intraday slope (regen QQQ
short-DTE intraday); wire gates into multi-strategy-engine; live parity check on QQQ ATM-IV calc.
