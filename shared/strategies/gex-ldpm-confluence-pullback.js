/**
 * GEX-LDPM Confluence Strategy with GEX Level Pullback Entry System
 *
 * Strategy flow:
 * 1. Wait for confluence deviation signal from parent strategy
 * 2. Monitor GEX levels (support/resistance) for entry confirmation
 * 3. For longs: bounce off GEX support (wick below or multi-bar reclaim)
 * 4. For shorts: rejection at GEX resistance (wick above or multi-bar rejection)
 * 5. Stop loss: lowest low (longs) or highest high (shorts) since deviation signal
 * 6. Target: original confluence zone from deviation signal
 * 7. If new deviation signal arrives before entry, replace old signal
 */

import { GexLdpmConfluenceStrategy } from './gex-ldpm-confluence.js';

export class GexLdpmConfluencePullbackStrategy extends GexLdpmConfluenceStrategy {
  constructor(params = {}) {
    super(params);

    // Strategy parameters
    this.confluenceThreshold = params.confluenceThreshold || 5;
    this.entryDistance = params.entryDistance || 10;
    this.stopLossBuffer = params.stopLossBuffer || 3;  // Points beyond price extreme
    this.targetAtCenter = params.targetAtCenter !== false;

    // GEX entry parameters
    this.maxReclaimBars = params.maxReclaimBars || 3;  // Max bars for multi-bar reclaim
    this.gexLevelTolerance = params.gexLevelTolerance || 1.0;  // Points tolerance for level validation

    // Signal freshness filter
    // Cancel deviation signal if no valid entry within this many bars
    // Data shows entries within 1-2 bars are profitable, 3+ bars lose money
    this.maxBarsToEntry = params.maxBarsToEntry ?? 2;

    // Session filter parameters
    // Block entries during US market open rush (UTC 14-17 = 9 AM - 12 PM EST)
    // This is when GEX levels are most volatile due to aggressive options trading
    this.useSessionFilter = params.useSessionFilter !== false;  // Enabled by default
    this.blockedSessionStartUTC = params.blockedSessionStartUTC ?? 14;  // 9 AM EST
    this.blockedSessionEndUTC = params.blockedSessionEndUTC ?? 17;      // 12 PM EST

    // Level type filter parameters
    // Block specific GEX level types that historically underperform
    // Analysis shows resistance_2 (21% win) and resistance_3 (0% win) are poor performers
    this.blockedLevelTypes = params.blockedLevelTypes ?? ['resistance_2', 'resistance_3'];

    // Regime filter parameters
    // Block entries during specific GEX regimes
    // Analysis shows strong_negative regime (29% win rate) underperforms because
    // dealers amplify moves (buy rips, sell dips) which works against reversion strategies
    this.blockedRegimes = params.blockedRegimes ?? ['strong_negative'];

    // SELL time filter parameters
    // Analysis shows SELL trades lose money overnight/pre-market (1-7 AM EST)
    // but are profitable during RTH, especially at 8 AM EST market open
    // Only allow SELL trades after this hour (UTC)
    this.sellStartHourUTC = params.sellStartHourUTC ?? 13;  // 13:00 UTC = 8:00 AM EST

    // State tracking for active signal
    this.activeSignal = null;
    this.lowestLowSinceSweep = null;
    this.highestHighSinceSweep = null;
    this.sweepStartTimestamp = null;
    this.barsSinceDeviation = 0;  // Track bars since deviation signal
    this.pendingReclaims = [];

    // Candle history for context
    this.candleHistory = [];
  }

  /**
   * Main signal evaluation
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    try {
      // Build candle history for context
      this.updateCandleHistory(candle, options);

      // Track price extremes if we have an active signal
      if (this.activeSignal) {
        this.barsSinceDeviation++;

        // Check if signal has expired (no entry within maxBarsToEntry)
        if (this.maxBarsToEntry > 0 && this.barsSinceDeviation > this.maxBarsToEntry) {
          if (this.params.verbose) {
            console.log(`Deviation signal expired after ${this.barsSinceDeviation} bars without entry`);
          }
          this.clearActiveSignal();
          return null;
        }

        this.updatePriceExtremes(candle);

        // Check for GEX level entry (bounce/rejection)
        const entry = this.checkGexLevelEntry(candle, prevCandle, marketData);
        if (entry) {
          return entry;
        }
      }

      // Check for new deviation signal from parent strategy
      const deviationSignal = super.evaluateSignal(candle, prevCandle, marketData, options);

      if (deviationSignal) {
        // Replace any existing signal with new one
        if (this.activeSignal && this.params.verbose) {
          console.log(`Replacing pending signal with new deviation signal at ${candle.close.toFixed(2)}`);
        }

        // Store new signal and initialize tracking
        this.activeSignal = {
          ...deviationSignal,
          deviationTimestamp: candle.timestamp
        };
        this.sweepStartTimestamp = candle.timestamp;
        this.lowestLowSinceSweep = candle.low;
        this.highestHighSinceSweep = candle.high;
        this.barsSinceDeviation = 0;  // Reset counter for new signal
        this.pendingReclaims = [];

        // Log the new signal
        if (this.params.verbose) {
          console.log(`New ${deviationSignal.side.toUpperCase()} deviation signal at ${candle.close.toFixed(2)}, target: ${deviationSignal.take_profit?.toFixed(2)}`);
        }

        // Don't return signal yet - wait for GEX level confirmation
        return null;
      }

      return null;

    } catch (error) {
      console.error('Error in pullback evaluateSignal:', error);
      return null;
    }
  }

  /**
   * Update candle history for context
   */
  updateCandleHistory(candle, options) {
    if (!this.candleHistory) {
      this.candleHistory = [];
    }

    // Try to get historical context from options for backtesting
    if (options && options.allCandles && options.currentIndex !== undefined && this.candleHistory.length === 0) {
      const startIdx = Math.max(0, options.currentIndex - 50);
      const endIdx = options.currentIndex + 1;
      this.candleHistory = options.allCandles.slice(startIdx, endIdx);
    } else {
      this.candleHistory.push(candle);
    }

    // Keep reasonable history length
    if (this.candleHistory.length > 400) {
      this.candleHistory = this.candleHistory.slice(-350);
    }
  }

  /**
   * Track lowest low / highest high since deviation signal
   */
  updatePriceExtremes(candle) {
    if (this.lowestLowSinceSweep === null || candle.low < this.lowestLowSinceSweep) {
      this.lowestLowSinceSweep = candle.low;
    }
    if (this.highestHighSinceSweep === null || candle.high > this.highestHighSinceSweep) {
      this.highestHighSinceSweep = candle.high;
    }
  }

  /**
   * Get all GEX entry levels for the current side
   */
  getGexEntryLevels(marketData, side, currentPrice) {
    const gex = marketData?.gexLevels;
    if (!gex) return [];

    const levels = [];

    if (side === 'buy') {
      // For longs: support levels, put_wall, gamma_flip below price
      (gex.support || []).forEach((price, idx) => {
        if (price && price < currentPrice) {
          levels.push({
            price,
            type: `support_${idx + 1}`,
            description: `GEX Support ${idx + 1}`,
            strength: 90 - (idx * 5)
          });
        }
      });

      if (gex.put_wall && gex.put_wall < currentPrice) {
        // Check if not already in support array
        const notInSupport = !(gex.support || []).some(s => Math.abs(s - gex.put_wall) < 1);
        if (notInSupport) {
          levels.push({
            price: gex.put_wall,
            type: 'put_wall',
            description: 'Put Wall',
            strength: 95
          });
        }
      }

      if (gex.gammaFlip && gex.gammaFlip < currentPrice) {
        levels.push({
          price: gex.gammaFlip,
          type: 'gamma_flip',
          description: 'Gamma Flip',
          strength: 100
        });
      }
    } else if (side === 'sell') {
      // For shorts: resistance levels, call_wall, gamma_flip above price
      (gex.resistance || []).forEach((price, idx) => {
        if (price && price > currentPrice) {
          levels.push({
            price,
            type: `resistance_${idx + 1}`,
            description: `GEX Resistance ${idx + 1}`,
            strength: 90 - (idx * 5)
          });
        }
      });

      if (gex.call_wall && gex.call_wall > currentPrice) {
        // Check if not already in resistance array
        const notInResistance = !(gex.resistance || []).some(r => Math.abs(r - gex.call_wall) < 1);
        if (notInResistance) {
          levels.push({
            price: gex.call_wall,
            type: 'call_wall',
            description: 'Call Wall',
            strength: 95
          });
        }
      }

      if (gex.gammaFlip && gex.gammaFlip > currentPrice) {
        levels.push({
          price: gex.gammaFlip,
          type: 'gamma_flip',
          description: 'Gamma Flip',
          strength: 100
        });
      }
    }

    // Filter out blocked level types
    const filteredLevels = levels.filter(level =>
      !this.blockedLevelTypes || this.blockedLevelTypes.length === 0 || !this.blockedLevelTypes.includes(level.type)
    );

    // Sort by strength (highest first)
    return filteredLevels.sort((a, b) => b.strength - a.strength);
  }

  /**
   * Check for GEX level entry (bounce/rejection with multi-bar support)
   */
  checkGexLevelEntry(candle, prevCandle, marketData) {
    if (!this.activeSignal) return null;

    const side = this.activeSignal.side;
    const currentGexLevels = this.getGexEntryLevels(marketData, side, candle.close);

    // First: Check pending reclaims and validate GEX levels still exist
    const reclaimEntry = this.processPendingReclaims(candle, currentGexLevels, marketData);
    if (reclaimEntry) return reclaimEntry;

    // Check all current GEX levels
    for (const level of currentGexLevels) {
      // LONG: bounce off support
      if (side === 'buy') {
        // Pattern A: Same-candle wick rejection (sweep and recovery)
        const wickedBelow = candle.low < level.price;
        const closedAbove = candle.close > level.price;
        if (wickedBelow && closedAbove) {
          return this.generateEntry(candle, level, 'wick_rejection', marketData);
        }

        // Pattern B: Close below - start tracking for multi-bar reclaim
        const closedBelow = candle.close < level.price;
        if (closedBelow && !this.isLevelPendingReclaim(level)) {
          this.startPendingReclaim(level, side, candle);
        }
      }

      // SHORT: rejection at resistance
      if (side === 'sell') {
        // Pattern A: Same-candle wick rejection
        const wickedAbove = candle.high > level.price;
        const closedBelow = candle.close < level.price;
        if (wickedAbove && closedBelow) {
          return this.generateEntry(candle, level, 'wick_rejection', marketData);
        }

        // Pattern B: Close above - start tracking for multi-bar rejection
        const closedAbove = candle.close > level.price;
        if (closedAbove && !this.isLevelPendingReclaim(level)) {
          this.startPendingReclaim(level, side, candle);
        }
      }
    }

    return null;
  }

  /**
   * Start tracking a level for multi-bar reclaim
   */
  startPendingReclaim(level, side, candle) {
    this.pendingReclaims.push({
      level,
      side,
      startBar: candle.timestamp,
      barsCount: 1
    });
    if (this.params.verbose) {
      console.log(`  Started tracking ${level.description} at ${level.price.toFixed(2)} for multi-bar ${side === 'buy' ? 'reclaim' : 'rejection'}`);
    }
  }

  /**
   * Check if a level is already being tracked for reclaim
   */
  isLevelPendingReclaim(level) {
    return this.pendingReclaims.some(pr =>
      Math.abs(pr.level.price - level.price) < 0.5
    );
  }

  /**
   * Process pending reclaims and check for completion
   */
  processPendingReclaims(candle, currentGexLevels, marketData) {
    const toRemove = [];

    for (let i = 0; i < this.pendingReclaims.length; i++) {
      const pending = this.pendingReclaims[i];
      pending.barsCount++;

      // CRITICAL: Validate GEX level still exists in current snapshot
      const levelStillValid = currentGexLevels.some(l =>
        Math.abs(l.price - pending.level.price) <= this.gexLevelTolerance
      );

      if (!levelStillValid) {
        // GEX level shifted or removed - invalidate this pending reclaim
        if (this.params.verbose) {
          console.log(`  GEX level ${pending.level.price.toFixed(2)} no longer valid - invalidating reclaim`);
        }
        toRemove.push(i);
        continue;
      }

      // Check if exceeded max bars
      if (pending.barsCount > this.maxReclaimBars) {
        if (this.params.verbose) {
          console.log(`  Reclaim timeout: ${pending.barsCount} bars > max ${this.maxReclaimBars}`);
        }
        toRemove.push(i);
        continue;
      }

      // Check for reclaim/rejection
      if (pending.side === 'buy') {
        // Reclaim: was below, now closed above
        if (candle.close > pending.level.price) {
          toRemove.push(i);
          return this.generateEntry(candle, pending.level, 'multi_bar_reclaim', marketData);
        }
      } else {
        // Rejection: was above, now closed below
        if (candle.close < pending.level.price) {
          toRemove.push(i);
          return this.generateEntry(candle, pending.level, 'multi_bar_rejection', marketData);
        }
      }
    }

    // Clean up expired/invalid reclaims
    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.pendingReclaims.splice(toRemove[i], 1);
    }

    return null;
  }

  /**
   * Calculate stop loss based on price extremes since deviation
   */
  calculateStopLoss(side) {
    if (side === 'buy') {
      return this.lowestLowSinceSweep - this.stopLossBuffer;
    } else {
      return this.highestHighSinceSweep + this.stopLossBuffer;
    }
  }

  /**
   * Check if timestamp is in a blocked trading session
   * Default blocks UTC 14-17 (9 AM - 12 PM EST) - the market open rush
   * @param {number} timestamp - Timestamp in milliseconds
   * @returns {boolean} True if in blocked session
   */
  isBlockedSession(timestamp) {
    if (!this.useSessionFilter) return false;

    const date = new Date(timestamp);
    const utcHour = date.getUTCHours();

    // Check if within blocked hours
    return utcHour >= this.blockedSessionStartUTC && utcHour < this.blockedSessionEndUTC;
  }

  /**
   * Generate entry signal
   */
  generateEntry(candle, level, confirmationType, marketData) {
    // Session filter: Block entries during US market open rush
    if (this.isBlockedSession(candle.timestamp)) {
      if (this.params.verbose) {
        const date = new Date(candle.timestamp);
        const utcHour = date.getUTCHours();
        console.log(`Entry rejected: In blocked session (UTC ${utcHour}:00 = ${utcHour - 5} AM EST)`);
      }
      return null;
    }

    // Regime filter: Block entries during unfavorable GEX regimes
    const currentRegime = marketData?.gexLevels?.regime;
    if (this.blockedRegimes && this.blockedRegimes.length > 0 && currentRegime) {
      if (this.blockedRegimes.includes(currentRegime)) {
        if (this.params.verbose) {
          console.log(`Entry rejected: Blocked regime '${currentRegime}' (dealers amplifying moves)`);
        }
        return null;
      }
    }

    const side = this.activeSignal.side;

    // SELL time filter: Block SELL trades before sellStartHourUTC (default 13:00 UTC = 8 AM EST)
    // Analysis shows SELL trades lose money overnight/pre-market but work during RTH
    if (side === 'sell' && this.sellStartHourUTC !== null) {
      const utcHour = new Date(candle.timestamp).getUTCHours();
      if (utcHour < this.sellStartHourUTC) {
        if (this.params.verbose) {
          console.log(`Entry rejected: SELL trades blocked before ${this.sellStartHourUTC}:00 UTC (current: ${utcHour}:00 UTC)`);
        }
        return null;
      }
    }
    const entryPrice = candle.close;
    const stopLoss = this.calculateStopLoss(side);
    const takeProfit = this.activeSignal.take_profit;

    const riskPoints = Math.abs(entryPrice - stopLoss);
    const rewardPoints = Math.abs(takeProfit - entryPrice);

    // Validate risk is acceptable
    const maxRisk = this.params.maxRisk || 50;
    if (riskPoints > maxRisk) {
      if (this.params.verbose) {
        console.log(`Entry rejected: Risk ${riskPoints.toFixed(1)} exceeds max ${maxRisk}`);
      }
      return null;
    }

    // Validate risk/reward
    const minRR = this.params.minRiskReward || 1.0;
    if (rewardPoints / riskPoints < minRR) {
      if (this.params.verbose) {
        console.log(`Entry rejected: R:R ${(rewardPoints / riskPoints).toFixed(2)} below min ${minRR}`);
      }
      return null;
    }

    if (this.params.verbose) {
      console.log(`GEX ${confirmationType} entry: ${side.toUpperCase()} at ${entryPrice.toFixed(2)}, stop: ${stopLoss.toFixed(2)}, target: ${takeProfit.toFixed(2)}`);
      console.log(`  Entry level: ${level.description} at ${level.price.toFixed(2)}`);
      console.log(`  Risk: ${riskPoints.toFixed(1)} pts, Reward: ${rewardPoints.toFixed(1)} pts, R:R: ${(rewardPoints / riskPoints).toFixed(2)}`);
    }

    const signal = {
      id: `gex_entry_${candle.timestamp}`,
      strategy: 'gex-ldpm-confluence-pullback',
      action: 'place_limit',
      side,
      symbol: this.activeSignal.symbol || this.params.tradingSymbol || 'NQ',
      price: entryPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: this.activeSignal.quantity || 1,
      timestamp: candle.timestamp,

      // Trailing stop params (only included if enabled)
      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,

      // Metadata for analysis
      metadata: {
        entryLevel: {
          price: level.price,
          type: level.type,
          description: level.description,
          strength: level.strength
        },
        confirmationType,
        regime: marketData?.gexLevels?.regime || 'unknown',
        lowestLowSinceSweep: this.lowestLowSinceSweep,
        highestHighSinceSweep: this.highestHighSinceSweep,
        riskPoints,
        rewardPoints,
        riskRewardRatio: rewardPoints / riskPoints,
        deviationTimestamp: this.activeSignal.deviationTimestamp,
        barsToEntry: this.candleHistory.length > 0 ?
          Math.floor((candle.timestamp - this.sweepStartTimestamp) / (15 * 60 * 1000)) : null
      },

      // Original signal reference
      originalSignal: {
        id: this.activeSignal.id,
        timestamp: this.activeSignal.deviationTimestamp,
        take_profit: this.activeSignal.take_profit
      }
    };

    // Clear active signal after entry
    this.clearActiveSignal();

    return signal;
  }

  /**
   * Clear active signal state
   */
  clearActiveSignal() {
    this.activeSignal = null;
    this.lowestLowSinceSweep = null;
    this.highestHighSinceSweep = null;
    this.sweepStartTimestamp = null;
    this.barsSinceDeviation = 0;
    this.pendingReclaims = [];
  }

  /**
   * Get strategy status for debugging
   */
  getStrategyStatus() {
    return {
      name: 'gex-ldpm-confluence-pullback',
      hasActiveSignal: !!this.activeSignal,
      activeSignalSide: this.activeSignal?.side || null,
      lowestLowSinceSweep: this.lowestLowSinceSweep,
      highestHighSinceSweep: this.highestHighSinceSweep,
      pendingReclaims: this.pendingReclaims.length,
      maxReclaimBars: this.maxReclaimBars,
      stopLossBuffer: this.stopLossBuffer,
      candleHistoryLength: this.candleHistory?.length || 0
    };
  }
}
