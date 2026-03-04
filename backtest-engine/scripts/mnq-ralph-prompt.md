# MNQ Adaptive Scalper — Ralph Loop Optimization

## Objective

Optimize the MNQ Adaptive Scalper strategy parameters to achieve consistent profitability with **1-second exit resolution** in the backtest engine.

**Current problem**: The strategy was tuned against a standalone 1-minute bar backtest (99.7% WR, PF=131). With realistic 1-second exit simulation, trailing stops capture only ~3pts per win while losses are 4-14x larger. Parameters need re-tuning.

**Target**: PF >= 1.5 on training data, PF >= 1.2 on validation data, positive P&L on both.
**Acceptable**: PF >= 1.2 on training, PF >= 1.0 on validation.

## How to Run Backtests

Use the wrapper script from the `backtest-engine` directory:

```bash
cd /home/drew/projects/slingshot-services/backtest-engine

# Training run (2024)
bash scripts/mnq-ralph-run.sh --start 2024-01-01 --end 2024-12-31 \
  --stop-points 20 --soft-stop-points 8 --trailing-trigger 5 --trailing-offset 2 \
  --daily-loss-limit -20 --daily-target 40 --proximity 3

# Validation run (2025)
bash scripts/mnq-ralph-run.sh --start 2025-01-01 --end 2025-09-30 \
  --stop-points 20 --soft-stop-points 8 --trailing-trigger 5 --trailing-offset 2 \
  --daily-loss-limit -20 --daily-target 40 --proximity 3
```

The script outputs a machine-readable summary with:
- Overall: trades, WR, PF, total P&L, expectancy, avg win, avg loss, max DD
- Exit breakdown: trailing_stop / soft_stop / stop_loss / market_close counts and P&L
- Daily aggregates: trading days, days hitting target/loss limit, avg daily P&L, worst/best day

## Available Parameters

All parameters have defaults from the strategy config. Only pass those you want to override.

| CLI Flag | What It Controls | Default | Range to Explore |
|----------|-----------------|---------|------------------|
| `--stop-points` | Hard stop loss (points) | 40 | 8-40 |
| `--soft-stop-points` | Soft stop (0=disabled) | 0 | 0-15 |
| `--target-points` | Profit target (points) | 50 | 10-75 |
| `--trailing-trigger` | Trail activates at N pts profit | 3 | 2-10 |
| `--trailing-offset` | Trail distance behind HWM | 1 | 0.5-5 |
| `--daily-loss-limit` | Halt day at N pts loss | -25 | -15 to -50 |
| `--daily-target` | Halt day at N pts profit | 50 | 25-75 |
| `--proximity` | Entry zone distance from level | 3 | 1-5 |
| `--signal-cooldown-ms` | Min ms between signals | 60000 | 15000-120000 |
| `--last-entry-time` | Last entry as EST decimal | 15.917 | 14.0-15.917 |

## Parameter Space (Prioritized)

### Tier 1 — High Impact (iterations 1-10)
Focus on the stop/trail parameters that directly control the win/loss asymmetry:

- `stopPoints`: [8, 12, 15, 20, 25, 30, 40] — smaller stops reduce avg loss but lower WR
- `softStopPoints`: [0, 5, 8, 10, 12, 15] — soft stop as an intermediate exit before hard stop
- `trailingTrigger`: [2, 3, 5, 7, 10] — when trailing activates; higher = lets winners run more
- `trailingOffset`: [0.5, 1, 2, 3, 5] — how tight the trail is; tighter = more exits but captures less

### Tier 2 — Medium Impact (iterations 11-18)
Daily risk limits and entry filters:

- `dailyLossLimit`: [-15, -20, -25, -35, -50] — tighter = fewer disaster days
- `dailyTarget`: [25, 35, 50, 75] — lower = more consistent but caps upside
- `proximity`: [1, 2, 3, 5] — tighter = fewer but better entries
- `signalCooldownMs`: [15000, 30000, 60000, 120000] — faster = more trades

### Tier 3 — Fine-Tuning (iterations 19-22)
Polish the best config:

- `targetPoints`: [10, 15, 20, 25, 50] — fixed target distance
- `lastEntryTime`: [14.0, 14.5, 15.0, 15.5, 15.917] — cut off late entries

### Validation (iterations 23-25)
Run the best 2-3 configs from training on validation data (2025-01-01 to 2025-09-30).

## Train/Test Split

- **Training**: `--start 2024-01-01 --end 2024-12-31` (~250 trading days)
- **Validation**: `--start 2025-01-01 --end 2025-09-30` (~190 trading days)

**Rules**:
- Only use training data for parameter exploration (iterations 1-22)
- Only validate after finding a promising config on training
- NEVER iterate based on validation results — that's overfitting
- If validation PF < 1.0 for a config that had PF > 1.5 on training, it's overfit — try a different approach

## Iteration Strategy

### Phase 1: Baselines (iterations 1-3)
Run 3 baseline configs to understand the landscape:

1. **Default params** (current config as-is): stop=40, soft=0, trail=3/1
2. **Tight stops**: stop=12, soft=0, trail=3/1
3. **Soft stop enabled**: stop=40, soft=8, trail=5/2

### Phase 2: Focused Exploration (iterations 4-10)
Based on baseline results, explore the most promising direction:
- If tight stops improved PF → sweep stop range [8, 15, 20] x trail [2, 5, 7]
- If soft stops helped → sweep soft [5, 10, 15] x hard [20, 30, 40]
- If both hurt → try wider trails [trail=7/3, trail=10/5] or no-trail with wider targets

### Phase 3: Daily Limits (iterations 11-15)
Take the best Tier 1 config and sweep daily limits:
- Test dailyLossLimit at [-15, -20, -35]
- Test dailyTarget at [25, 35, 75]

### Phase 4: Entry Filters (iterations 16-18)
Fine-tune entry parameters with best risk config:
- Test proximity at [1, 2, 5]
- Test signalCooldownMs at [15000, 30000, 120000]

### Phase 5: Polish (iterations 19-22)
- Try targetPoints adjustments
- Try lastEntryTime cutoffs
- Combine best individual improvements

### Phase 6: Validation (iterations 23-25)
- Run top 2-3 configs on 2025 data
- Report final recommended config

## Results Tracking

Track ALL results in `.claude/ralph-loop.local.md` with this format:

```
## Iteration N: [description]
**Params**: stop=X soft=Y trail=A/B daily=-L/+T prox=P cooldown=C
**Training (2024)**: Trades=N WR=X% PF=X.XX P&L=X Exp=X AvgWin=X AvgLoss=X MaxDD=X
**Exit breakdown**: trailing_stop=N(P&L) soft_stop=N(P&L) stop_loss=N(P&L) market_close=N(P&L)
**Daily**: Days=N Positive=N Negative=N HitTarget=N HitLossLimit=N AvgDaily=X Worst=X Best=X
**Notes**: [observations, what to try next]
```

## Key Insights from Prior Testing

- With default params (40pt hard stop, 3pt trail trigger, 1pt trail offset):
  - 93% WR but PF=0.96 — wins average ~3pts, losses average ~60pts
  - The trailing stop at 3/1 locks in tiny gains while hard stop losses are massive
- With 10pt hard stop: WR drops to 77%, PF=0.83 — still losing money
- With 40pt hard + 10pt soft stop: WR=84.5%, PF=1.00 — breakeven
- The fundamental challenge: many small wins vs few large losses

## Completion Criteria

Stop iterating when ANY of these are met:
1. **Success**: Found a config with PF >= 1.5 on training AND PF >= 1.2 on validation
2. **Acceptable**: Found a config with PF >= 1.2 on training AND PF >= 1.0 on validation
3. **Max iterations**: Completed 25 iterations regardless of results
4. **Dead end**: After 15+ iterations, best training PF is still < 1.0 — strategy may need structural changes, not just parameter tuning

When done, write the final recommended config (or "no viable config found") to the results tracking file.
