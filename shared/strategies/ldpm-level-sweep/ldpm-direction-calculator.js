/**
 * LDPM Direction Calculator
 *
 * Calculates the direction (slope) of LDPM levels over a lookback period.
 * Uses center of mass approach from ldpm-gex-analyzer.js
 *
 * Direction is used to determine bias:
 * - LDPM rising → deteriorating liquidity → look for shorts
 * - LDPM falling → improving liquidity → look for longs
 * - LDPM flat → either direction allowed
 */

export class LdpmDirectionCalculator {
  constructor(params = {}) {
    this.params = {
      lookbackPeriods: params.lookbackPeriods || 4,      // 4 x 15min = 1 hour lookback
      slopeThreshold: params.slopeThreshold || 3,        // Points per period for rising/falling
      intervalMs: params.intervalMs || 15 * 60 * 1000,   // 15-minute intervals
      ...params
    };

    // History buffer for LDPM snapshots
    this.history = [];
  }

  /**
   * Process a new LDPM snapshot
   * @param {Object} ltLevels - Liquidity trigger levels
   * @param {number} timestamp - Timestamp of the snapshot
   */
  processSnapshot(ltLevels, timestamp) {
    if (!ltLevels) return;

    // Extract levels array from various formats
    const levels = this.extractLevels(ltLevels);
    if (!levels || levels.length < 2) return;

    const snapshot = {
      timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime(),
      levels,
      centerOfMass: this.calculateCenterOfMass(levels),
      spread: Math.max(...levels) - Math.min(...levels),
      sentiment: ltLevels.sentiment || 'UNKNOWN'
    };

    // Add to history, maintaining sorted order
    this.history.push(snapshot);
    this.history.sort((a, b) => a.timestamp - b.timestamp);

    // Keep history limited to avoid memory bloat
    const maxHistory = this.params.lookbackPeriods * 10;
    if (this.history.length > maxHistory) {
      this.history = this.history.slice(-maxHistory);
    }
  }

  /**
   * Extract levels array from various LT data formats
   * @param {Object} ltLevels - LT levels data
   * @returns {number[]} Array of level values
   */
  extractLevels(ltLevels) {
    if (!ltLevels) return null;

    // Array format (preferred)
    if (Array.isArray(ltLevels.levels)) {
      return ltLevels.levels.filter(l => l !== null && l !== undefined && !isNaN(l));
    }

    // CSV format: level_1, level_2, etc.
    if (ltLevels.level_1 !== undefined) {
      const levels = [];
      for (let i = 1; i <= 5; i++) {
        const level = ltLevels[`level_${i}`];
        if (level !== null && level !== undefined && !isNaN(level)) {
          levels.push(level);
        }
      }
      return levels;
    }

    return null;
  }

  /**
   * Calculate center of mass of levels
   * @param {number[]} levels - Array of price levels
   * @returns {number} Center of mass (average)
   */
  calculateCenterOfMass(levels) {
    if (!levels || levels.length === 0) return 0;
    return levels.reduce((sum, l) => sum + l, 0) / levels.length;
  }

  /**
   * Calculate LDPM direction at a specific timestamp
   * @param {number} timestamp - Target timestamp
   * @returns {Object|null} Direction analysis or null if insufficient data
   */
  calculateDirection(timestamp) {
    const targetTime = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

    // Get historical snapshots for lookback period
    const relevantHistory = this.getHistoryForLookback(targetTime);
    if (relevantHistory.length < 2) {
      return null;
    }

    const oldest = relevantHistory[relevantHistory.length - 1];
    const newest = relevantHistory[0];
    const periodsElapsed = relevantHistory.length - 1;

    // Calculate COM change and slope
    const comChange = newest.centerOfMass - oldest.centerOfMass;
    const comSlope = periodsElapsed > 0 ? comChange / periodsElapsed : 0;

    // Calculate spread change
    const spreadChange = newest.spread - oldest.spread;

    // Classify direction based on slope threshold
    let direction;
    if (comSlope > this.params.slopeThreshold) {
      direction = 'rising';
    } else if (comSlope < -this.params.slopeThreshold) {
      direction = 'falling';
    } else {
      direction = 'flat';
    }

    // Calculate individual level slopes
    const levelSlopes = this.calculateLevelSlopes(relevantHistory);

    return {
      direction,
      slope: comSlope,
      comChange,
      spreadChange,
      spreadDirection: spreadChange > 5 ? 'expanding' : spreadChange < -5 ? 'contracting' : 'stable',
      periodsAnalyzed: relevantHistory.length,
      levelSlopes,
      currentCOM: newest.centerOfMass,
      currentSpread: newest.spread,
      sentiment: newest.sentiment
    };
  }

  /**
   * Get bias from direction
   * @param {string} direction - LDPM direction ('rising', 'falling', 'flat')
   * @returns {string} Trade bias ('short', 'long', 'either')
   */
  getBias(direction) {
    switch (direction) {
      case 'rising':
        return 'short';  // Rising LDPM = deteriorating liquidity = look for shorts
      case 'falling':
        return 'long';   // Falling LDPM = improving liquidity = look for longs
      case 'flat':
      default:
        return 'either';
    }
  }

  /**
   * Get historical snapshots for lookback period
   * @param {number} targetTime - Target timestamp
   * @returns {Object[]} Array of snapshots (newest first)
   */
  getHistoryForLookback(targetTime) {
    const lookbackMs = this.params.lookbackPeriods * this.params.intervalMs;
    const cutoffTime = targetTime - lookbackMs;

    // Get snapshots within lookback window, up to and including target time
    const relevant = this.history.filter(s =>
      s.timestamp <= targetTime && s.timestamp >= cutoffTime
    );

    // Sort newest first
    return relevant.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Calculate slope of each individual level over the lookback period
   * @param {Object[]} history - Historical snapshots (newest first)
   * @returns {Object[]} Array of level slope info
   */
  calculateLevelSlopes(history) {
    if (history.length < 2) return [];

    const oldest = history[history.length - 1];
    const newest = history[0];
    const periodsElapsed = history.length - 1;

    const slopes = [];
    const maxLevels = Math.min(newest.levels.length, oldest.levels.length);

    for (let i = 0; i < maxLevels; i++) {
      const change = newest.levels[i] - oldest.levels[i];
      const slope = periodsElapsed > 0 ? change / periodsElapsed : 0;

      let direction;
      if (slope > this.params.slopeThreshold) {
        direction = 'rising';
      } else if (slope < -this.params.slopeThreshold) {
        direction = 'falling';
      } else {
        direction = 'flat';
      }

      slopes.push({
        level: i + 1,
        change,
        slope,
        direction
      });
    }

    return slopes;
  }

  /**
   * Get the most recent direction info
   * @returns {Object|null} Direction analysis or null
   */
  getCurrentDirection() {
    if (this.history.length === 0) return null;

    const latestTime = this.history[this.history.length - 1].timestamp;
    return this.calculateDirection(latestTime);
  }

  /**
   * Clear history
   */
  reset() {
    this.history = [];
  }

  /**
   * Get debug info
   * @returns {Object} Debug information
   */
  getDebugInfo() {
    return {
      historyLength: this.history.length,
      params: this.params,
      latestSnapshot: this.history.length > 0 ? this.history[this.history.length - 1] : null
    };
  }
}

export default LdpmDirectionCalculator;
