/**
 * LT Level Migration Strategy
 *
 * Bidirectional strategy that trades when an LT level MIGRATES through price
 * between consecutive 15-minute snapshots. This is distinct from price crossing
 * a level — here the LEVEL moves, not the price.
 *
 * Signal logic (from analyze-lt-dynamics-vs-cbbo.js):
 * - Bullish crossing: level migrates from above price to below price → LONG
 * - Bearish crossing: level migrates from below price to above price → SHORT
 * - Both prev and curr levels compared against CURRENT price
 * - All 5 Fibonacci levels contribute; L4 (fib377) strongest bullish, L5 (fib610) strongest bearish
 * - Signal strongest at 5-10min, decays by 30-60min (mean reversion, not trend)
 */

import { BaseStrategy } from './base-strategy.js';

export class LTLevelMigrationStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Risk Management
    this.params.stopLossPoints = params.stopLossPoints ?? 15;
    this.params.takeProfitPoints = params.takeProfitPoints ?? 30;
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // Level Selection — validate that tradeLevels are valid LT keys;
    // fall back to all 5 if invalid (e.g., numeric [1] from --gex-levels CLI default)
    const validLTKeys = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
    const passedLevels = params.tradeLevels;
    this.params.tradeLevels = (passedLevels && passedLevels.length > 0 && passedLevels.every(k => validLTKeys.includes(k)))
      ? passedLevels
      : validLTKeys;

    // Signal Cooldown
    this.params.signalCooldownMs = params.signalCooldownMs ?? 900000; // 15 minutes

    // Session Filter
    this.params.useSessionFilter = params.useSessionFilter ?? false;
    this.params.allowedSessions = params.allowedSessions ?? ['rth', 'premarket', 'overnight', 'afterhours'];

    // Symbol
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug
    this.params.debug = params.debug ?? false;

    // Direction Modes
    this.params.longOnly = params.longOnly ?? false;        // Only take long signals
    this.params.inverseShorts = params.inverseShorts ?? false; // Flip shorts to longs

    // State
    this.ltLevels = null;
    this.ltIndex = 0;
    this.prevLTSnapshot = null;
    this.currentLTSnapshot = null;
    this.candleCount = 0;
  }

  /**
   * Load LT levels data
   */
  loadLTData(ltData) {
    this.ltLevels = [...ltData].sort((a, b) => a.timestamp - b.timestamp);
    this.ltIndex = 0;

    if (this.params.debug) {
      console.log(`[LT-MIG] Loaded ${this.ltLevels.length} LT level records`);
      if (this.ltLevels.length > 0) {
        const first = new Date(this.ltLevels[0].timestamp).toISOString();
        const last = new Date(this.ltLevels[this.ltLevels.length - 1].timestamp).toISOString();
        console.log(`[LT-MIG] Date range: ${first} to ${last}`);
      }
    }
  }

  /**
   * Get LT levels at a specific timestamp (forward-advancing index)
   */
  getLTAtTime(timestamp) {
    if (!this.ltLevels || this.ltLevels.length === 0) return null;

    // Advance index to find the latest LT snapshot at or before timestamp
    while (this.ltIndex < this.ltLevels.length - 1 &&
           this.ltLevels[this.ltIndex + 1].timestamp <= timestamp) {
      this.ltIndex++;
    }

    // Make sure we're not past the timestamp
    if (this.ltLevels[this.ltIndex].timestamp > timestamp) {
      // Look back for a valid entry
      let idx = this.ltIndex;
      while (idx > 0 && this.ltLevels[idx].timestamp > timestamp) {
        idx--;
      }
      if (this.ltLevels[idx].timestamp <= timestamp) {
        return this.ltLevels[idx];
      }
      return null;
    }

    return this.ltLevels[this.ltIndex];
  }

  /**
   * Detect level migration through price.
   * Both prev and curr levels are compared against CURRENT price.
   *
   * @param {number} price - Current price
   * @param {Object} prevLT - Previous LT snapshot
   * @param {Object} currLT - Current LT snapshot
   * @returns {Object|null} Crossing signal or null
   */
  detectCrossing(price, prevLT, currLT) {
    const crossedBelow = []; // Levels that migrated from above to below price → bullish
    const crossedAbove = []; // Levels that migrated from below to above price → bearish

    for (const levelKey of this.params.tradeLevels) {
      const prevValue = prevLT[levelKey];
      const currValue = currLT[levelKey];

      if (!prevValue || !currValue || isNaN(prevValue) || isNaN(currValue)) continue;

      // Level migrated from above price to below price → bullish signal
      if (prevValue > price && currValue < price) {
        crossedBelow.push({ key: levelKey, prevValue, currValue });
      }

      // Level migrated from below price to above price → bearish signal
      if (prevValue < price && currValue > price) {
        crossedAbove.push({ key: levelKey, prevValue, currValue });
      }
    }

    if (crossedBelow.length === 0 && crossedAbove.length === 0) return null;

    // Determine direction: whichever has more crossings wins
    const side = crossedBelow.length >= crossedAbove.length ? 'buy' : 'sell';

    // Primary level is the first in the dominant direction
    const dominant = side === 'buy' ? crossedBelow : crossedAbove;
    const primaryLevelKey = dominant[0].key;

    return {
      side,
      primaryLevelKey,
      crossedBelow,
      crossedAbove
    };
  }

  /**
   * Evaluate for level migration signal
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);
    const debug = this.params.debug || options.debug;

    this.candleCount++;

    if (debug && this.candleCount % 500 === 0) {
      console.log(`[LT-MIG] evaluateSignal called ${this.candleCount} times, ltLevels: ${this.ltLevels?.length || 0}`);
    }

    // Check cooldown
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Check session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(timestamp)) {
      return null;
    }

    // Get current LT levels
    const currLT = this.getLTAtTime(timestamp);
    if (!currLT) return null;

    // Advance snapshot tracking: detect when we move to a new LT snapshot
    if (this.currentLTSnapshot && currLT.timestamp !== this.currentLTSnapshot.timestamp) {
      this.prevLTSnapshot = this.currentLTSnapshot;
    }
    this.currentLTSnapshot = currLT;

    // Need a previous snapshot to compare against
    if (!this.prevLTSnapshot) return null;

    // Skip if prev and current are the same snapshot
    if (this.prevLTSnapshot.timestamp === this.currentLTSnapshot.timestamp) return null;

    const price = candle.close;

    // Detect level migration
    let crossing = this.detectCrossing(price, this.prevLTSnapshot, this.currentLTSnapshot);
    if (!crossing) return null;

    // Direction mode filtering
    if (crossing.side === 'sell') {
      if (this.params.longOnly) {
        // Skip short signals entirely
        return null;
      }
      if (this.params.inverseShorts) {
        // Flip short to long
        crossing = { ...crossing, side: 'buy', inverted: true };
      }
    }

    if (debug) {
      console.log(`[LT-MIG] Migration detected: ${crossing.side} | Primary: ${crossing.primaryLevelKey}`);
      console.log(`  crossedBelow: ${crossing.crossedBelow.map(c => c.key).join(', ')}`);
      console.log(`  crossedAbove: ${crossing.crossedAbove.map(c => c.key).join(', ')}`);
      console.log(`  prevLT ts: ${new Date(this.prevLTSnapshot.timestamp).toISOString()}`);
      console.log(`  currLT ts: ${new Date(this.currentLTSnapshot.timestamp).toISOString()}`);
    }

    this.updateLastSignalTime(timestamp);
    return this.createSignal(candle, crossing);
  }

  /**
   * Create signal object
   */
  createSignal(candle, crossing) {
    const price = candle.close;
    const isLong = crossing.side === 'buy';

    const stopLoss = isLong
      ? price - this.params.stopLossPoints
      : price + this.params.stopLossPoints;

    const takeProfit = isLong
      ? price + this.params.takeProfitPoints
      : price - this.params.takeProfitPoints;

    if (this.params.debug) {
      const dir = isLong ? 'LONG' : 'SHORT';
      console.log(`[LT-MIG] Signal: ${dir} at ${price.toFixed(2)}`);
      console.log(`  Stop: ${stopLoss.toFixed(2)}, Target: ${takeProfit.toFixed(2)}`);
    }

    return {
      timestamp: candle.timestamp,
      side: crossing.side,
      price,
      strategy: 'LT_LEVEL_MIGRATION',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,

      // Signal metadata
      primaryLevelKey: crossing.primaryLevelKey,
      crossedBelowLevels: crossing.crossedBelow.map(c => c.key),
      crossedAboveLevels: crossing.crossedAbove.map(c => c.key),

      // Snake_case for trade orchestrator compatibility
      stop_loss: stopLoss,
      take_profit: takeProfit
    };
  }

  /**
   * Get session based on timestamp
   */
  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });

    const [hourStr, minStr] = estString.split(':');
    const hour = parseInt(hourStr);
    const min = parseInt(minStr);
    const timeDecimal = hour + min / 60;

    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
    if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
    return 'afterhours';
  }

  /**
   * Check if current session is allowed
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    const currentSession = this.getSession(timestamp);
    return this.params.allowedSessions.includes(currentSession);
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.prevLTSnapshot = null;
    this.currentLTSnapshot = null;
    this.ltIndex = 0;
    this.candleCount = 0;
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'LT_LEVEL_MIGRATION';
  }
}

export default LTLevelMigrationStrategy;
