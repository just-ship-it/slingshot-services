# Position Scaling Guide - IV Skew GEX Strategy

This guide outlines how to scale position sizes based on account equity while maintaining appropriate risk management.

## Strategy Risk Profile

Based on backtesting (Jan 2025 - Jan 2026):

| Metric | Value |
|--------|-------|
| Win Rate | 64% (90% with time-based trailing) |
| Max Stop Loss | 70 points |
| Max Consecutive Losses | 4 |
| Max Losses in One Day | 4 |
| Worst Single Day | -$1,445 (at 1 NQ) |
| Average Trades/Day | 2.65 |
| Max Trades/Day | 8 |

## Contract Specifications

| Contract | Point Value | Margin Required | 70pt Loss |
|----------|-------------|-----------------|-----------|
| MNQ (Micro) | $2/point | $100 | $140 |
| NQ (Full) | $20/point | $1,000 | $1,400 |

Note: 10 MNQ = 1 NQ equivalent exposure

## Scaling Tiers

### Micro NQ (MNQ) Phase

| Account Size | Contracts | Max Loss/Trade | Risk % | After 4 Losses | Action |
|-------------|-----------|----------------|--------|----------------|--------|
| $1,000 | 1 MNQ | $140 | 14.0% | $440 (44%) | Pilot - accept higher risk |
| $2,500 | 1 MNQ | $140 | 5.6% | $1,940 (78%) | Building buffer |
| $4,000 | 2 MNQ | $280 | 7.0% | $2,880 (72%) | First scale-up |
| $6,000 | 3 MNQ | $420 | 7.0% | $4,320 (72%) | Continue scaling |
| $8,000 | 4 MNQ | $560 | 7.0% | $5,760 (72%) | Approaching NQ |
| $10,000 | 5 MNQ | $700 | 7.0% | $7,200 (72%) | Max MNQ tier |

### Full NQ Phase

| Account Size | Contracts | Max Loss/Trade | Risk % | After 4 Losses | Action |
|-------------|-----------|----------------|--------|----------------|--------|
| $15,000 | 1 NQ | $1,400 | 9.3% | $9,400 (63%) | First NQ contract |
| $20,000 | 1 NQ | $1,400 | 7.0% | $14,400 (72%) | Comfortable NQ |
| $30,000 | 2 NQ | $2,800 | 9.3% | $18,800 (63%) | Scale NQ |
| $40,000 | 2 NQ | $2,800 | 7.0% | $28,800 (72%) | Buffer for 3 NQ |
| $50,000 | 3 NQ | $4,200 | 8.4% | $33,200 (66%) | Continue scaling |

## Scaling Rules

### When to Scale Up
- Account grows **50-60% above** current tier's minimum threshold
- Example: At 1 MNQ tier ($1,000 min), scale to 2 MNQ when account reaches ~$4,000

### When to Scale Down
- **Immediately** scale down if account drops below current tier threshold
- Example: If trading 2 MNQ and account drops below $4,000, reduce to 1 MNQ

### Risk Limits
1. **Never exceed 15% risk** on a single trade (pilot phase exception)
2. **Target 5-7% risk** per trade once past $2,500
3. **Keep margin under 30%** of account value
4. **Maintain 4-loss buffer** - always have enough to survive max consecutive losses

## Growth Projection

### Backtest Monthly Average (12.4 months, 405 trades)

| Contract | Monthly P&L |
|----------|-------------|
| 1 MNQ ($2/pt) | **$2,470/mo** |
| 1 NQ ($20/pt) | **$25,027/mo** |

Live performance is tracking closely with backtest. The strategy uses limit orders (minimal slippage) and is fully automated (no psychological element).

### Growth Timeline

| Starting | Contracts | Monthly P&L | Time to Next Tier |
|----------|-----------|-------------|-------------------|
| $1,000 | 1 MNQ | $2,470 | ~1.5 months to $4k |
| $4,000 | 2 MNQ | $4,940 | ~2 weeks to $6k |
| $6,000 | 3 MNQ | $7,410 | ~2 weeks to $10k |
| $10,000 | 5 MNQ | $12,350 | ~2 weeks to $15k |
| $15,000 | 1 NQ | $25,027 | Compounding accelerates |

**Path to 1 NQ: ~3 months** from $1,000 starting equity.

*Based on backtest averages. Actual results will vary by market conditions.*

## Configuration

### Setting Position Size in Slingshot

In `shared/.env`:
```bash
# Contract type: use MNQ for micros, NQ for full
TRADING_SYMBOL=MNQH6

# Number of contracts
DEFAULT_QUANTITY=1
```

Update `TRADING_SYMBOL` to current front-month contract (H=Mar, M=Jun, U=Sep, Z=Dec).

### Quick Reference: Contract Months
- H = March
- M = June
- U = September
- Z = December

Example: `MNQH6` = Micro NQ March 2026

## Risk Management Checklist

Before scaling up, verify:
- [ ] Account equity is 50%+ above current tier minimum
- [ ] No recent unusual drawdowns or strategy issues
- [ ] Comfortable with new max loss amount psychologically
- [ ] Margin requirements still under 30% of account

Before each trading day:
- [ ] Confirm account equity supports current position size
- [ ] Check if scale-down is needed after recent losses
- [ ] Verify correct contract month is configured

## Emergency Procedures

### Max Drawdown Hit (4 consecutive losses)
1. Stop trading for the day
2. Review trades for any pattern or issue
3. Resume next session if strategy operated correctly

### Account Below Tier Minimum
1. Immediately reduce position size to appropriate tier
2. Do not "trade back" losses with same size
3. Rebuild equity at smaller size before scaling back up

---

*Last updated: February 2026*
*Based on IV Skew GEX strategy backtest: Jan 2025 - Jan 2026*
