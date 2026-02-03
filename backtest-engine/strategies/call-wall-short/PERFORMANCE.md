# Call Wall Short Strategy - Performance Analysis

## Strategy Overview

Short entries when price touches Call Wall from below.

**Entry Conditions**:
- Price within 15 pts of Call Wall level
- Candle high touches Call Wall from below
- Close is below Call Wall

**Exit Parameters**:
- Stop Loss: 12 pts above Call Wall
- Take Profit: 35 pts (fixed) or trailing (15 pt trigger, 8 pt offset)

---

## Backtest Results

### 2024 (In-Sample) - 252 GEX Days

| Exit Mode | Trades | Win Rate | Total P&L | Avg P&L | Profit Factor |
|-----------|--------|----------|-----------|---------|---------------|
| Fixed | 163 | 39.9% | -248.03 | -1.52 | 0.86 |
| Trailing | 163 | 51.5% | -537.86 | -3.30 | 0.62 |

### 2025 (Out-of-Sample) - 11 GEX Days

| Exit Mode | Trades | Win Rate | Total P&L | Avg P&L | Profit Factor |
|-----------|--------|----------|-----------|---------|---------------|
| Fixed | 2 | 50.0% | +18.95 | +9.48 | 2.21 |
| Trailing | 2 | 50.0% | -3.05 | -1.52 | 0.81 |

**Note**: 2025 sample size is too small (2 trades) to draw conclusions.

---

## Analysis by Session (2024 Fixed Exit)

| Session | Trades | P&L | Win Rate |
|---------|--------|-----|----------|
| Overnight | 15 | +40.44 | 73.3% |
| Premarket | 12 | +91.95 | 50.0% |
| RTH | 118 | -300.09 | 34.7% |
| Afterhours | 18 | -80.33 | 38.9% |

**Finding**: Strategy shows promise in overnight (73.3% WR) and premarket (50% WR) sessions.

---

## Analysis by Regime (2024 Fixed Exit)

| Regime | Trades | P&L | Win Rate |
|--------|--------|-----|----------|
| Strong Positive | 136 | +3.99 | 43.4% |
| Strong Negative | 16 | -76.99 | 31.3% |
| Negative | 5 | -104.60 | 0.0% |
| Positive | 6 | -70.43 | 16.7% |

**Finding**: Strategy only works in strong_positive regime - makes sense as Call Wall is heavily tested when market is bullish.

---

## Why This Strategy Fails (Baseline)

1. **Infrequent signals**: Only 163 trades/year vs 1,660 for R1
2. **Call Wall is bullish level**: In positive regime, price pushes through Call Wall
3. **Trailing stops destroy value**: Win rate increases but P&L worsens significantly
4. **Counter-trend**: Shorting at Call Wall fights the dominant market direction

---

## Suggested Improvements

### Filter 1: Overnight/Premarket + Strong Positive Regime

Based on segment analysis:
```javascript
{
  useSessionFilter: true,
  allowedSessions: ['overnight', 'premarket'],
  useRegimeFilter: true,
  allowedRegimes: ['strong_positive'],
  exitMode: 'fixed'
}
```

Expected trades: ~27/year (15 overnight + 12 premarket × regime overlap)
Combined session P&L: +132.39 pts on 27 trades = +4.90 pts/trade

### Filter 2: Wait for Rejection Candle

Instead of any touch, require:
- Shooting star or doji at Call Wall
- Close in lower half of candle range
- Next candle confirms down

### Filter 3: Volume Exhaustion

Look for:
- Volume declining on approach to Call Wall
- High volume rejection bar at level
- Suggests buying exhaustion

---

## Recommendation

**MARGINAL - Consider with strict filters only**

The strategy is unprofitable baseline but shows potential with session + regime filters:
- Overnight: 73.3% win rate, +40.44 pts (15 trades)
- Premarket: 50% win rate, +91.95 pts (12 trades)
- Combined: +132.39 pts on 27 trades

However:
- Low trade frequency (~27/year with filters)
- 2024-only data (no OOS validation possible due to 2025 sample size)
- Highly dependent on strong_positive regime persistence

If trading, use conservative position sizing until more data validates the edge.
