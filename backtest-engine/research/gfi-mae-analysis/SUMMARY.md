# gex-flip-ivpct Tight-Stop Research Summary

## Motivation

The post-fix gold-standard config of gex-flip-ivpct used per-rule stops of
106-184pt. On a small account this produced two unacceptable problems:

1. Max single-trade loss of $3,720 (worst rule L3, 184pt stop × $20/pt).
2. Catastrophic giveback: 15 of 143 trades (10.5%) reached MFE > 50pt then
   ended negative. The worst was T000130 (L3 long, 2025-02-17): hit +153pt
   MFE, then stopped out at -186pt for a 339pt swing (~$6,780).

The user said "we either need to drastically lower the stops (max 50-60
points) or throw it away entirely."

## Approach

1. **MAE/MFE distribution analysis** on the existing 143 trades.
2. **Feature analysis** comparing clean-MAE (≤10pt) vs ugly-MAE trades to
   find entry-time filters.
3. **Bar-by-bar re-simulation** through the backtest engine with tighter
   stops, breakeven moves, and entry filters. Three sweep stages, 20 combos.

## Key data findings (from baseline trades)

- MAE ≤ 10pt: only 14% of trades. **86% of trades pull back >10pt** before
  resolving — a true 10pt stop is not feasible on this strategy's signals.
- MFE ≥ 20pt: 93% of trades. MFE ≥ 50pt: 84%. **Profit is plentiful;
  drawdown is the problem.**
- **ET hours 06-08 are poison**: 18 of 18 trades had MAE > 10pt (zero clean).
- **Friday is the worst weekday** for clean-rate (8%).
- **IV at entry**: clean trades cluster at lower IV (20.6% p75 vs 24.1% ugly p75).
- **Put-wall distance**: clean p50 = 135pt vs ugly p50 = 249pt.

## Recommended new config

**s60_t200_BE70o5_drop0608** — 60pt stop, 200pt target, BE at +70pt → entry+5,
drop ET 06-08 hours.

```bash
node index.js --ticker NQ --strategy gex-flip-ivpct --timeframe 5m --raw-contracts \
  --start 2025-01-13 --end 2026-04-20 \
  --iv-resolution 1m \
  --eod-cutoff-et 16:40 \
  --gfi-stop-pts 60 --gfi-target-pts 200 \
  --gfi-breakeven-stop --gfi-breakeven-trigger 70 --gfi-breakeven-offset 5 \
  --gfi-blocked-hours 6,7,8
```

### Performance (Jan 2025 → Apr 2026, ~16 months)

| Metric | Wide-stop baseline | **Tight (NEW)** | Δ |
|---|---|---|---|
| Trades | 143 | 172 | +29 |
| WR | 74.1% | 61.6% | -12.5pp |
| PF | 4.31 | 2.99 | -1.32 |
| **Sharpe** | 5.71 | **6.41** | **+0.70** |
| MaxDD % | 5.5% | 11.3% | +5.8pp |
| Total PnL | $276k | $157k | -$119k |
| Avg win | $4,304 | $2,230 | -$2,074 |
| Avg loss | $-2,584 | $-1,198 | +$1,386 |
| **Max single loss** | **-$3,720** | **-$1,240** | **-67%** |
| **Max giveback** | **-$6,780** | **-$2,520** | **-63%** |
| Painful losers | 15 | 10 | -33% |
| Max consecutive losses | — | 5 trades / $5,345 cum | — |

Trades JSON: `data/gold-standard/gex-flip-ivpct-tight-s60t200be70.json`.

### Trade-offs

- PnL dropped 43% — we leave money on the table, but the absolute loss per
  trade is small enough to be tradable on a small account.
- Sharpe **improved** (5.71 → 6.41) — return per unit of variance is actually
  better despite the higher MaxDD%. The DD% rose because the equity curve
  has more small wins / scratches mixed with the runners, but each individual
  loss is far smaller.
- WR dropped (74% → 62%) because more trades hit the tight 60pt stop than
  hit the wide 113pt stop. Cumulative pnl is still well in the green.

## Pareto frontier of viable tight configs

| Tier | Config | n | PF | Sharpe | DD% | PnL | Painful | Use case |
|---|---|---|---|---|---|---|---|---|
| Max-PnL | s60/t200/BE70o5 | 172 | 2.99 | 6.41 | 11.3% | **$157k** | 10 | DEFAULT |
| Balanced | s60/t180/BE60o5 | 161 | 2.64 | 5.00 | 12.5% | $115k | 4 | Risk-averse |
| Zero-giveback | s60/t150/BE50o5 | 168 | 2.38 | 4.46 | 11.6% | $92k | **0** | Sleep-easy |
| 50pt-stop | s50/t180/BE60o5 | 167 | 2.41 | 4.38 | 12.5% | $102k | 4 | Tighter risk |

## Rejected variants

- **Trailing stop**: tested trail trigger 50 / offset 30 and 80 / offset 40.
  Both produced lower PnL ($53k, $89k) than the BE equivalent ($157k). The
  trailing offset gets hit too often by normal candle wiggle.
- **Disable L3**: tried removing L3 (the rule with the widest natural MAE
  and worst absolute baseline losses). Result: $34k less PnL with same
  painful count — under tight stops, L3 becomes a net positive contributor.
- **Disable S1**: S2 picks up S1's trades (the conditions overlap), so
  the aggregate is unchanged. No benefit.
- **Tighter stop+target (40/80)**: $32k PnL only. Too tight — strategy needs
  room.
- **BE trigger at 25-30**: too aggressive. PnL drops to $55-70k because most
  trades hit +25 MFE quickly then drift back to BE+5, capping winners at
  small wins.
- **BE trigger at 100**: regression vs BE@75. Some painful losers slip through
  before BE arms.

## What we cannot tell from this work

The MFE/MAE bounds analysis (without bar-by-bar re-simulation) cannot
distinguish between "10pt stop + 20pt target = 14% WR" and "10pt stop +
20pt target = 93% WR" — the answer depends on order of events within the
candle. Re-simulation through the engine resolves this. Findings here
reflect that resolved answer.

## Implementation changes

- `shared/strategies/gex-flip-ivpct.js`: added `ruleOverrides`, `disabledRules`,
  `globalStopPts`, `globalTargetPts`, `blockedHoursEt`, `breakevenStop` +
  `breakevenTrigger`/`breakevenOffset`, `trailingTrigger`/`trailingOffset`.
- `backtest-engine/src/cli.js`: added `--gfi-stop-pts`, `--gfi-target-pts`,
  `--gfi-rule-overrides`, `--gfi-disable-rules`, `--gfi-blocked-hours`,
  `--gfi-breakeven-stop`, `--gfi-breakeven-trigger`, `--gfi-breakeven-offset`,
  `--gfi-trailing-trigger`, `--gfi-trailing-offset`. The BE flags MUST come
  after the engine-wide `--breakeven-stop` block (which has `default: false`
  and would otherwise clobber `strategyParams.breakevenStop`).
