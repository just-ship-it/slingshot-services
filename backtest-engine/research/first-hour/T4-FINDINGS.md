# T4: Opening Range Breakout (ORB) with confluence filters

## TL;DR
Tested 5/15/30-min OR breakouts on NQ with first valid 1m close beyond OR after window end, stop = opposite OR boundary, time stop = 11:00 ET. Date range 2025-01-13 → 2026-04-23 (324 days). Baseline 15-min ORB without filters generates ~318 trades with PF=1.19 at 100-pt target. Best filtered combination: **OR=15 gap_direction+overnight_bias+iv_middle60** with target=50pt → 73 trades, 72.6% WR, PF=1.91, Sharpe=4.79, MaxDD=214pts, total=1200pts.

## Dataset
- Date range: 2025-01-13 → 2026-04-23
- Trading days analyzed: 324
- Rollover days skipped: 5
- NQ raw 1m via filterPrimaryContract
- GEX: `data/gex/nq-cbbo/` (post-bucketing-fix)
- IV: `qqq_atm_iv_1m.csv` 9:30 ET sample. p20=0.149, p80=0.249

## OR-length Quick Comparison (no filters)
Top 10 by PF:
| OR | Target | n | WR% | PnL(pts) | PF | Sharpe | MaxDD |
|---|---|---:|---:|---:|---:|---:|---:|
| 15m | 3R | 318 | 56 | 4479 | 1.41 | 1.95 | 1207 |
| 15m | 2R | 318 | 56 | 3935 | 1.36 | 1.85 | 1129 |
| 15m | 200pt | 318 | 56 | 3472 | 1.32 | 1.76 | 1183 |
| 15m | 1.5R | 318 | 56 | 3452 | 1.32 | 1.72 | 1157 |
| 30m | 1.5R | 287 | 56.4 | 2489 | 1.3 | 1.35 | 888 |
| 15m | 150pt | 318 | 56.3 | 3120 | 1.29 | 1.66 | 1200 |
| 15m | 1R | 318 | 57.2 | 2917 | 1.28 | 1.57 | 1447 |
| 30m | 1R | 287 | 56.4 | 2084 | 1.25 | 1.26 | 997 |
| 30m | 200pt | 287 | 56.4 | 1798 | 1.22 | 1.17 | 888 |
| 30m | 3R | 287 | 56.4 | 1791 | 1.22 | 1.15 | 888 |

## Baseline 15-min ORB (no filters)
| Target | n | WR% | PnL | PF | Sharpe | MaxDD |
|---|---:|---:|---:|---:|---:|---:|
| 25pt | 318 | 79.2 | 965 | 1.18 | 1.04 | 663 |
| 50pt | 318 | 67.3 | 1102 | 1.13 | 0.81 | 1280 |
| 75pt | 318 | 61 | 1529 | 1.15 | 0.97 | 1236 |
| 100pt | 318 | 57.9 | 1961 | 1.19 | 1.16 | 1257 |
| 150pt | 318 | 56.3 | 3120 | 1.29 | 1.66 | 1200 |
| 200pt | 318 | 56 | 3472 | 1.32 | 1.76 | 1183 |
| 1R | 318 | 57.2 | 2917 | 1.28 | 1.57 | 1447 |
| 1.5R | 318 | 56 | 3452 | 1.32 | 1.72 | 1157 |
| 2R | 318 | 56 | 3935 | 1.36 | 1.85 | 1129 |
| 3R | 318 | 56 | 4479 | 1.41 | 1.95 | 1207 |

## Single-filter best targets (15-min OR)
| Filter | Best target | n | WR% | PnL | PF | Sharpe | MaxDD |
|---|---|---:|---:|---:|---:|---:|---:|
| gex_regime | 3R | 273 | 54.2 | 3314 | 1.34 | 1.63 | 1125 |
| iv_middle60 | 3R | 192 | 54.7 | 3468 | 1.57 | 2.76 | 726 |
| gap_direction | 3R | 158 | 53.8 | 2113 | 1.39 | 2.02 | 909 |
| overnight_bias | 3R | 136 | 55.1 | 2308 | 1.47 | 2.03 | 632 |

## Top 10 combinations overall by PF (n>=25)
| Config | Target | n | WR% | PnL | PF | Sharpe | MaxDD |
|---|---|---:|---:|---:|---:|---:|---:|
| OR=15 gap_direction+overnight_bias+iv_middle60 | 3R | 73 | 56.2 | 2020 | 2.11 | 4.31 | 363 |
| OR=15 gex_regime+gap_direction+overnight_bias+iv_middle60 | 3R | 67 | 56.7 | 1828 | 2.07 | 4.24 | 363 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 2R | 73 | 56.2 | 1842 | 2.02 | 4.16 | 363 |
| OR=15 gex_regime+gap_direction+overnight_bias+iv_middle60 | 2R | 67 | 56.7 | 1671 | 1.98 | 4.09 | 363 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 75pt | 73 | 67.1 | 1410 | 1.94 | 4.77 | 252 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 50pt | 73 | 72.6 | 1200 | 1.91 | 4.79 | 214 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 1.5R | 73 | 56.2 | 1638 | 1.9 | 3.91 | 375 |
| OR=15 gex_regime+gap_direction+overnight_bias+iv_middle60 | 75pt | 67 | 67.2 | 1268 | 1.89 | 4.62 | 258 |
| OR=15 gex_regime+gap_direction+overnight_bias+iv_middle60 | 1.5R | 67 | 56.7 | 1520 | 1.89 | 3.9 | 375 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 200pt | 73 | 56.2 | 1571 | 1.87 | 3.91 | 363 |

## Top 10 by Sharpe (n>=25)
| Config | Target | n | WR% | PnL | PF | Sharpe | MaxDD |
|---|---|---:|---:|---:|---:|---:|---:|
| OR=15 gap_direction+overnight_bias+iv_middle60 | 50pt | 73 | 72.6 | 1200 | 1.91 | 4.79 | 214 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 75pt | 73 | 67.1 | 1410 | 1.94 | 4.77 | 252 |
| OR=15 gex_regime+gap_direction+overnight_bias+iv_middle60 | 75pt | 67 | 67.2 | 1268 | 1.89 | 4.62 | 258 |
| OR=15 gex_regime+gap_direction+overnight_bias+iv_middle60 | 50pt | 67 | 71.6 | 1066 | 1.86 | 4.57 | 217 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 3R | 73 | 56.2 | 2020 | 2.11 | 4.31 | 363 |
| OR=15 gex_regime+gap_direction+overnight_bias+iv_middle60 | 3R | 67 | 56.7 | 1828 | 2.07 | 4.24 | 363 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 2R | 73 | 56.2 | 1842 | 2.02 | 4.16 | 363 |
| OR=15 gex_regime+gap_direction+overnight_bias+iv_middle60 | 2R | 67 | 56.7 | 1671 | 1.98 | 4.09 | 363 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 200pt | 73 | 56.2 | 1571 | 1.87 | 3.91 | 363 |
| OR=15 gap_direction+overnight_bias+iv_middle60 | 1.5R | 73 | 56.2 | 1638 | 1.9 | 3.91 | 375 |

## OR Range distribution (15m, baseline)
| p10 | p25 | p50 | p75 | p90 |
|---:|---:|---:|---:|---:|
| 56.8 | 75.0 | 98.5 | 133.0 | 185.3 |

## Proposed Strategy v0 — `OR=15 gap_direction+overnight_bias+iv_middle60`
- **Entry**: First 1m close beyond 9:30-9:45 ET OR after 9:45 ET (long if close > orHigh, short if close < orLow). Entry price = bar close.
- **Side**: Long on upside breakout, short on downside breakout.
- **Filters**: gap_direction+overnight_bias+iv_middle60
  - `gex_regime`: skip if 9:30 GEX regime = `strong_negative`; skip shorts if regime = `strong_positive`
  - `iv_middle60`: take only if 9:30 QQQ ATM IV is between p20 (0.149) and p80 (0.249)
  - `gap_direction`: longs only if RTH open > prev RTH close; shorts only if RTH open < prev RTH close
  - `overnight_bias`: longs need overnight close in upper half of overnight range (≥0.55); shorts need ≤0.45
- **Stop**: opposite OR boundary (typical stop distance ≈ 108.9 pts; equals OR width)
- **Target**: 50pt from entry
- **Time stop**: 11:00 ET (close at last bar before 11:00 if neither stop nor target hit)
- **Expected frequency**: 73 trades over 324 days ≈ 0.23 trades/day
- **Per-trade EV**: 16.44 pts (≈ $329 on 1 NQ contract)
- **PF**: 1.91 | **Sharpe**: 4.79 | **WR**: 72.6% | **MaxDD**: 214 pts

## Backtest-engine integration sketch
- New strategy file: `shared/strategies/orb-first-hour.js` extending `base-strategy.js`.
- Subscribes to `candle.close` (1m) on NQ.
- State per ET trading day: `orHigh`, `orLow`, `orFinalized`, `signalFired`.
- Reset state at 9:30 ET (or first bar after the daily session boundary).
- Between 9:30:00 and 9:44:59, accumulate high/low into OR.
- At 9:45:00, finalize OR. From 9:45:00 to 11:00:00, on each closed 1m bar:
  - If `!signalFired` and close > orHigh and filters pass → publish `place_market` long with stop=`orLow`, target=`entry+50pt`.
  - If `!signalFired` and close < orLow and filters pass → publish `place_market` short, stop=`orHigh`.
  - Filter inputs:
    - GEX regime: from latest `gex.levels` snapshot at 9:30 ET
    - IV: live QQQ ATM IV at 9:30 ET (already computed in data-service)
    - Gap dir: from prev day RTH close vs today's RTH open
    - Overnight bias: position of overnight close within overnight range
- Time stop: cancel + flatten if no exit by 11:00 ET.
- CLI flags for backtester: `--orb-or-min 15 --orb-target 50pt --orb-filters "gap_direction+overnight_bias+iv_middle60"`

## Caveats / Followups
- Entry uses 1m close; live execution should fire a market order at bar close — slippage of 1-2 pts realistic on NQ but not modeled here.
- Stop = opposite OR boundary means stop distance varies daily (median ≈ 108.9 pts); risk per trade is non-constant. Consider a max stop cap (e.g. 80 pts).
- Both stop and target inside same bar default to stop fill — pessimistic. Real fill depends on intra-bar path; consider 1s data for top combos.
- Overnight bias is a proxy for the T1/T2 sweep predictor; once those tracks land, swap in the actual 90.5% OOS predictor.
- GEX regime skipped if no snapshot exists; check coverage = 314 / 324 days have a regime label.
- All results are pre-fee, pre-slippage. NQ tick = 0.25 pt = $5; commission ~$1-2 per RT.
- Hold out OOS: top combos should be re-validated on Feb-Apr 2026 if not already.
