/**
 * Sweep Detector
 *
 * Detects level sweeps (liquidity grabs) on candle data.
 *
 * Sweep Types:
 * - Resistance Sweep (short setup): Close or wick above level then reversal
 * - Support Sweep (long setup): Close or wick below level then reversal
 *
 * Sweep Patterns:
 * - Close sweep: Price closes beyond the level
 * - Wick sweep (failed breakout): Wick extends beyond level but closes back
 */

export class SweepDetector {
  constructor(params = {}) {
    this.params = {
      sweepBuffer: params.sweepBuffer || 2,             // Minimum points beyond level
      wickSweepRequired: params.wickSweepRequired || 1, // Min wick beyond level
      requireCloseReclaim: params.requireCloseReclaim || false, // For wick sweeps
      ...params
    };
  }

  /**
   * Detect if a candle swept a specific level
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle (for trend context)
   * @param {Object} level - Level object { price, type, ... }
   * @returns {Object|null} Sweep info or null if no sweep
   */
  detectSweep(candle, prevCandle, level) {
    if (!candle || !level || level.price === null) return null;

    const levelPrice = level.price;
    const levelType = level.type;
    const currentPrice = candle.close;

    // CRITICAL: Validate level position relative to current price
    // Support levels MUST be below price to be valid
    // Resistance levels MUST be above price to be valid
    // This prevents false sweeps when using stale GEX data
    if (levelType === 'support' && levelPrice >= currentPrice) {
      return null; // "Support" above price is not valid support
    }
    if (levelType === 'resistance' && levelPrice <= currentPrice) {
      return null; // "Resistance" below price is not valid resistance
    }

    // Determine expected sweep type based on level type
    if (levelType === 'resistance' || (levelType === 'neutral' && levelPrice > currentPrice)) {
      return this.detectResistanceSweep(candle, prevCandle, level);
    } else if (levelType === 'support' || (levelType === 'neutral' && levelPrice < currentPrice)) {
      return this.detectSupportSweep(candle, prevCandle, level);
    }

    return null;
  }

  /**
   * Detect a resistance sweep (short setup)
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} level - Level object
   * @returns {Object|null} Sweep info or null
   */
  detectResistanceSweep(candle, prevCandle, level) {
    const levelPrice = level.price;

    // Close sweep: Price closes above resistance
    const closeSweep = candle.close >= levelPrice + this.params.sweepBuffer;

    // Wick sweep: High went above resistance but closed below
    const wickExtension = candle.high - levelPrice;
    const wickSweep = wickExtension >= this.params.wickSweepRequired &&
                      candle.close < levelPrice;

    // Failed breakout: Previous candle above, current closes back below
    const failedBreakout = prevCandle &&
                            prevCandle.close > levelPrice &&
                            candle.close < levelPrice;

    if (closeSweep || wickSweep || failedBreakout) {
      return {
        detected: true,
        type: closeSweep ? 'close_sweep' : (failedBreakout ? 'failed_breakout' : 'wick_sweep'),
        side: 'short',
        level: level,
        levelPrice: levelPrice,
        sweepPrice: closeSweep ? candle.close : candle.high,
        extension: closeSweep ? (candle.close - levelPrice) : wickExtension,
        candleTimestamp: candle.timestamp,
        reclaimed: candle.close < levelPrice,
        strength: this.calculateSweepStrength(candle, level, 'resistance')
      };
    }

    return null;
  }

  /**
   * Detect a support sweep (long setup)
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} level - Level object
   * @returns {Object|null} Sweep info or null
   */
  detectSupportSweep(candle, prevCandle, level) {
    const levelPrice = level.price;

    // Close sweep: Price closes below support
    const closeSweep = candle.close <= levelPrice - this.params.sweepBuffer;

    // Wick sweep: Low went below support but closed above
    const wickExtension = levelPrice - candle.low;
    const wickSweep = wickExtension >= this.params.wickSweepRequired &&
                      candle.close > levelPrice;

    // Failed breakdown: Previous candle below, current closes back above
    const failedBreakdown = prevCandle &&
                             prevCandle.close < levelPrice &&
                             candle.close > levelPrice;

    if (closeSweep || wickSweep || failedBreakdown) {
      return {
        detected: true,
        type: closeSweep ? 'close_sweep' : (failedBreakdown ? 'failed_breakdown' : 'wick_sweep'),
        side: 'long',
        level: level,
        levelPrice: levelPrice,
        sweepPrice: closeSweep ? candle.close : candle.low,
        extension: closeSweep ? (levelPrice - candle.close) : wickExtension,
        candleTimestamp: candle.timestamp,
        reclaimed: candle.close > levelPrice,
        strength: this.calculateSweepStrength(candle, level, 'support')
      };
    }

    return null;
  }

  /**
   * Calculate sweep strength based on extension and level strength
   * @param {Object} candle - Candle data
   * @param {Object} level - Level object
   * @param {string} sweepType - 'support' or 'resistance'
   * @returns {number} Strength score 0-100
   */
  calculateSweepStrength(candle, level, sweepType) {
    let strength = level.strength || 50;

    // Bonus for reclaim (wick sweep)
    const reclaimed = sweepType === 'support'
      ? candle.close > level.price
      : candle.close < level.price;

    if (reclaimed) {
      strength += 15;
    }

    // Bonus for strong wick
    const bodySize = Math.abs(candle.close - candle.open);
    const wickSize = sweepType === 'support'
      ? candle.close - candle.low
      : candle.high - candle.close;

    if (wickSize > bodySize * 2) {
      strength += 10;
    }

    return Math.min(100, strength);
  }

  /**
   * Scan for sweeps across multiple levels
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object[]} levels - Array of level objects
   * @param {string} bias - Trade bias ('long', 'short', 'either')
   * @returns {Object[]} Array of detected sweeps
   */
  scanForSweeps(candle, prevCandle, levels, bias = 'either') {
    if (!candle || !levels || levels.length === 0) return [];

    const sweeps = [];
    const maxSweepDistance = this.params.maxSweepDistance || 100; // Max 100 points from price

    for (const level of levels) {
      // Filter by bias
      if (bias === 'long' && level.type === 'resistance') continue;
      if (bias === 'short' && level.type === 'support') continue;

      // Skip levels too far from price (absolute distance check)
      const distance = Math.abs(candle.close - level.price);
      if (distance > maxSweepDistance) continue;

      // Also check relative distance based on candle range
      const candleRange = candle.high - candle.low;
      if (candleRange > 0 && distance > candleRange * 3) continue;

      const sweep = this.detectSweep(candle, prevCandle, level);
      if (sweep) {
        sweeps.push(sweep);
      }
    }

    // Sort by strength (highest first)
    return sweeps.sort((a, b) => b.strength - a.strength);
  }

  /**
   * Get the best sweep from an array (highest strength)
   * @param {Object[]} sweeps - Array of sweep objects
   * @returns {Object|null} Best sweep or null
   */
  getBestSweep(sweeps) {
    if (!sweeps || sweeps.length === 0) return null;
    return sweeps.reduce((best, current) =>
      current.strength > best.strength ? current : best
    );
  }

  /**
   * Check if price is near a level (potential sweep zone)
   * @param {number} price - Current price
   * @param {Object} level - Level object
   * @param {number} zoneSize - Zone size in points
   * @returns {boolean} True if in sweep zone
   */
  isInSweepZone(price, level, zoneSize = 5) {
    return Math.abs(price - level.price) <= zoneSize;
  }

  /**
   * Get debug info
   * @returns {Object} Debug information
   */
  getDebugInfo() {
    return {
      params: this.params
    };
  }
}

export default SweepDetector;
