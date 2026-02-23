# Composite Trailing Stop — Development Notes

## Overview

The ICT MTF Sweep strategy finds excellent entries (88.9% of max-hold exits are profitable), but uses rigid fixed targets based on opposing liquidity pools. Trades that go 100+ points in favor can come back to breakeven or stop out. The composite trailing stop was built to address this profit give-back problem.

## What Was Built

### MFE/MAE Tracking (All Trades)
Every trade now tracks:
- `mfePoints` / `maePoints` — max favorable/adverse excursion in points
- `mfePrice` / `maePrice` — best/worst price reached
- `profitGiveBack` — MFE minus actual P&L (how much was left on the table)

Summary stats added to performance calculator: `avgMFE`, `avgMAE`, `avgProfitGiveBack`, `avgWinnerMFE`, `avgLoserMFE`, `mfeEfficiency`.

### Composite Multi-Phase Trailing Stop
New trailing stop mode `'composite'` with layered phases:

| Phase | Trigger | Action |
|-------|---------|--------|
| Pre-activation | MFE < activationThreshold (20pts) | Zone-traverse BE when price clears entry zone (if enabled) |
| Fixed Trail | MFE >= activationThreshold | Trail at `postActivationTrailDistance` (40pts) behind HWM |
| Aggressive | MFE >= aggressiveThreshold (50pts) | Progressive tightening per tier |
| Target Proximity | Within proximityPct (20%) of TP | Tight 5pt trail |

Phases are layered — higher phases override lower ones. Stop only moves in the favorable direction.

### Files Modified
- `backtest-engine/src/execution/trade-simulator.js` — MFE/MAE tracking, `updateCompositeTrailingStop()`, initialization, dispatch
- `backtest-engine/src/analytics/performance-calculator.js` — MFE/MAE summary stats
- `shared/strategies/ict-mtf-sweep/index.js` — `_buildSignal()` emits composite config
- `backtest-engine/src/cli.js` — CLI options for composite params
- `backtest-engine/src/backtest-engine.js` — pass-through composite config
- `backtest-engine/src/config/default.json` — defaults for ict-mtf-sweep, mtf-sweep, jv entries

## Current Default Configuration

```javascript
{
  activationThreshold: 20,        // MFE pts before composite engages
  postActivationTrailDistance: 40, // Fixed trail distance after activation
  zoneBreakevenEnabled: false,     // Zone-traverse BE in pre-activation phase
  structuralEnabled: false,        // Swing-based trailing (disabled — too aggressive)
  aggressiveThreshold: 50,         // MFE pts to activate aggressive tiers
  aggressiveTiers: [
    { mfe: 50, trailDistance: 25 },
    { mfe: 80, trailDistance: 15 },
  ],
  targetProximity: true,
  proximityPct: 0.20,             // Within 20% of TP distance
  proximityTrailDistance: 5,       // Tight 5pt trail near target
}
```

## Backtesting Results (2025-01-01 to 2026-01-28, NQ, JV preset)

### Version History

| Version | Change | Total PnL | Profit Factor | Sharpe | Max DD |
|---------|--------|-----------|---------------|--------|--------|
| Baseline (no composite) | Zone-traverse BE only | -$980 | 0.98 | -0.33 | 8.92% |
| v1 (original composite) | All phases, struct@5pt | -$5,277 | 0.91 | -0.61 | 10.2% |
| v4 (tuned) | Activation@20, struct@20, zone BE pre-act | +$1,711 | 1.03 | 0.00 | 8.59% |
| **v5 (fixed trail)** | **Struct disabled, 40pt fixed trail, zone BE on** | **+$4,603** | **1.08** | **0.24** | **8.09%** |
| v6 (no zone BE) | Zone BE disabled in pre-activation | -$10,423 | 0.93 | -0.79 | 18.89% |

### Best Configuration: v5

```
Total PnL:       +$4,603 (685 trades)
Profit Factor:   1.08
Expectancy:      +$6.72/trade
Sharpe Ratio:    0.24
Max Drawdown:    8.09%
Win Rate:        11.97%
Avg Win:         $752
Avg Loss:        $95
Payoff Ratio:    7.91
```

### Key Findings

1. **Zone-traverse BE is essential** — Without it (v6), avg loss balloons from $95 to $357 and total PnL drops to -$10K. The zone BE limits losses to ~$10 on trades that don't work.

2. **Structural trailing (swing-based) hurts** — At any threshold, it cuts winners short. The structural phase had 87-93% win rate but avg PnL of only 3-10 pts, clipping trades that would have gone much further.

3. **Fixed 40pt trail is the sweet spot** — After activation at 20pt MFE, trailing at 40pts behind the high water mark lets winners develop. Avg win recovered to $752 (vs $450 with structural).

4. **Aggressive + Target Proximity phases work perfectly** — 100% win rate, capturing 40-48 pts avg on big moves.

5. **Profit give-back problem reduced** — Trades with MFE >= 20 that ended up losing money: 86 (baseline) vs 59 (v5).

6. **Slippage classification matters** — Zone-traverse BE exits must set `trailing.triggered = true` so they get `limitOrderSlippage` (0.25pts) not `stopOrderSlippage` (1.50pts). This was a 521pt bug across 417 trades.

## Open Questions

- The strategy has a low base win rate (~8-12%). Improving entry quality would compound the trailing stop gains.
- The 20pt activation threshold was chosen from MFE distribution analysis. Could be tuned per timeframe or entry model.
- Momentum continuation trades (fvg_rejection entries) make up ~85% of all trades. Their zone sizes are tight (avg 8.76 pts) so zone BE triggers quickly. This is working as intended — cheap scratches vs expensive structural stop-outs.
- Zone BE is currently disabled via `zoneBreakevenEnabled: false` but the pre-activation code also checks this flag. The current state has zone BE effectively disabled everywhere. The v5 results (best performer) had zone BE enabled in pre-activation.

## CLI Options

```bash
--composite-trailing              # Enable/disable composite trailing
--composite-activation-threshold  # MFE pts before composite engages (default: 20)
--composite-zone-be               # Enable zone-traverse BE in pre-activation (default: false)
--composite-structural-threshold  # MFE pts for structural phase (default: 20)
--composite-aggressive-threshold  # MFE pts for aggressive phase (default: 30)
--composite-proximity-pct         # % of target distance for proximity phase (default: 0.20)
```
