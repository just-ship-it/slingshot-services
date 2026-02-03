# LT Filter Implementation Guide

## Quick Summary

Analysis of 1,962 GEX LDPM trades reveals **LT4 < LT5 relationship** as the strongest predictor of trade success.

## Key Finding: LT4 vs LT5 Performance

| Condition | Trades | Win Rate | Avg P&L | Performance |
|-----------|--------|----------|---------|-------------|
| **LT4 < LT5** | 1,029 | **42.47%** | **$82.12** | ✅ Preferred |
| **LT4 > LT5** | 930 | 40.22% | $35.13 | ❌ Avoid |

**Impact**: +2.25% win rate, +134% higher average P&L

## Implementation

### 1. Strategy Configuration Update

Add to strategy parameters in `strategyParams`:

```javascript
"ltFiltering": {
  "enabled": true,
  "requireLt4Lt5Ascending": true,  // Primary filter: LT4 < LT5
  "requireLt1Lt2Descending": false, // Optional: LT1 > LT2 (+4.1% win rate)
  "requireLt2Lt3Descending": false  // Optional: LT2 > LT3 (+4.2% win rate)
}
```

### 2. Signal Generation Filter

Add to signal evaluation logic:

```javascript
function evaluateLTPatterns(availableLTLevels, config) {
  if (!config.ltFiltering.enabled) return true;

  const { level_1, level_2, level_3, level_4, level_5 } = availableLTLevels;

  // Primary filter: LT4 < LT5 (highest impact)
  if (config.ltFiltering.requireLt4Lt5Ascending) {
    if (level_4 >= level_5) {
      return {
        passed: false,
        reason: 'LT4_NOT_LESS_THAN_LT5',
        lt4: level_4,
        lt5: level_5
      };
    }
  }

  // Optional secondary filters
  if (config.ltFiltering.requireLt1Lt2Descending) {
    if (level_1 <= level_2) {
      return {
        passed: false,
        reason: 'LT1_NOT_GREATER_THAN_LT2'
      };
    }
  }

  if (config.ltFiltering.requireLt2Lt3Descending) {
    if (level_2 <= level_3) {
      return {
        passed: false,
        reason: 'LT2_NOT_GREATER_THAN_LT3'
      };
    }
  }

  return { passed: true };
}
```

### 3. Integration in Signal Generator

In `signal-generator/src/strategy/gex-recoil.js`:

```javascript
// Add to signal evaluation
const ltFilterResult = evaluateLTPatterns(
  availableLTLevels,
  strategyConfig.ltFiltering
);

if (!ltFilterResult.passed) {
  logger.debug('Signal filtered out by LT pattern', {
    reason: ltFilterResult.reason,
    ltLevels: availableLTLevels,
    symbol: currentPrice.symbol
  });
  return null; // Reject signal
}
```

### 4. Monitoring & Analytics

Track filter performance:

```javascript
// Add to strategy status
strategyStatus.ltFiltering = {
  enabled: config.ltFiltering.enabled,
  filtersApplied: {
    lt4Lt5Ascending: config.ltFiltering.requireLt4Lt5Ascending,
    lt1Lt2Descending: config.ltFiltering.requireLt1Lt2Descending,
    lt2Lt3Descending: config.ltFiltering.requireLt2Lt3Descending
  },
  recentFilterReasons: recentFilterReasons.slice(-10) // Last 10 filtered signals
};
```

## Phase Rollout Plan

### Phase 1: Conservative Start (Recommended)
- Enable only `requireLt4Lt5Ascending: true`
- Monitor for 30 days
- Expected: 52% of signals remain, improved performance

### Phase 2: Enhanced Filtering (If Phase 1 successful)
- Add `requireLt1Lt2Descending: true`
- Add `requireLt2Lt3Descending: true`
- Monitor for reduced signal frequency but higher quality

## Expected Impact

### With LT4 < LT5 Filter Only:
- **Signal Reduction**: ~47% of signals filtered out
- **Win Rate**: +2.25 percentage points improvement
- **Average P&L**: +134% improvement
- **Risk**: Lower trade frequency

### Risk Mitigation:
- Start with paper trading or reduced position sizes
- Monitor across different market regimes
- Have rollback plan if performance degrades

## Code Files to Modify

1. **Strategy Parameters**: `backtest-engine/strategies/gex-ldpm-confluence.js`
2. **Signal Logic**: `signal-generator/src/strategy/gex-recoil.js`
3. **Configuration**: Strategy config objects
4. **Monitoring**: Dashboard API endpoints for filter tracking

## Validation

Monitor these metrics post-implementation:
- Daily win rate vs baseline
- Average P&L per trade vs baseline
- Signal frequency vs baseline
- Performance across long/short trades
- Performance across different market regimes