/**
 * Level Calculator
 *
 * Calculates and tracks all significant price levels for sweep detection:
 * - Daily Open, Yesterday H/L
 * - Overnight H/L, Premarket H/L
 * - Weekly Open
 * - GEX Levels (gamma flip, put/call walls, support/resistance)
 *
 * These levels are the foundation for high-accuracy sweep detection.
 */

import { SessionTracker, getSession, toEasternTime } from './session-tracker.js';

/**
 * Level types for classification
 */
export const LEVEL_TYPES = {
  // Session-based levels
  DAILY_OPEN: 'daily_open',
  YESTERDAY_HIGH: 'yesterday_high',
  YESTERDAY_LOW: 'yesterday_low',
  OVERNIGHT_HIGH: 'overnight_high',
  OVERNIGHT_LOW: 'overnight_low',
  PREMARKET_HIGH: 'premarket_high',
  PREMARKET_LOW: 'premarket_low',
  WEEKLY_OPEN: 'weekly_open',

  // GEX levels
  GEX_GAMMA_FLIP: 'gex_gamma_flip',
  GEX_PUT_WALL: 'gex_put_wall',
  GEX_CALL_WALL: 'gex_call_wall',
  GEX_SUPPORT_1: 'gex_support_1',
  GEX_SUPPORT_2: 'gex_support_2',
  GEX_SUPPORT_3: 'gex_support_3',
  GEX_RESISTANCE_1: 'gex_resistance_1',
  GEX_RESISTANCE_2: 'gex_resistance_2',
  GEX_RESISTANCE_3: 'gex_resistance_3'
};

/**
 * Level strength rankings (higher = stronger)
 * Based on historical reactivity analysis
 */
export const LEVEL_STRENGTHS = {
  [LEVEL_TYPES.GEX_GAMMA_FLIP]: 100,
  [LEVEL_TYPES.GEX_PUT_WALL]: 95,
  [LEVEL_TYPES.GEX_CALL_WALL]: 95,
  [LEVEL_TYPES.DAILY_OPEN]: 90,
  [LEVEL_TYPES.YESTERDAY_HIGH]: 88,
  [LEVEL_TYPES.YESTERDAY_LOW]: 88,
  [LEVEL_TYPES.WEEKLY_OPEN]: 85,
  [LEVEL_TYPES.OVERNIGHT_HIGH]: 80,
  [LEVEL_TYPES.OVERNIGHT_LOW]: 80,
  [LEVEL_TYPES.PREMARKET_HIGH]: 75,
  [LEVEL_TYPES.PREMARKET_LOW]: 75,
  [LEVEL_TYPES.GEX_SUPPORT_1]: 85,
  [LEVEL_TYPES.GEX_SUPPORT_2]: 70,
  [LEVEL_TYPES.GEX_SUPPORT_3]: 55,
  [LEVEL_TYPES.GEX_RESISTANCE_1]: 85,
  [LEVEL_TYPES.GEX_RESISTANCE_2]: 70,
  [LEVEL_TYPES.GEX_RESISTANCE_3]: 55
};

export class LevelCalculator {
  /**
   * @param {Object} config - Configuration
   * @param {Object} config.gexLoader - GexLoader instance for GEX levels
   * @param {number} config.levelTolerance - Default tolerance for level proximity (default: 5)
   */
  constructor(config = {}) {
    this.sessionTracker = new SessionTracker();
    this.gexLoader = config.gexLoader || null;
    this.levelTolerance = config.levelTolerance ?? 5;

    // Cache for current levels
    this.currentLevels = new Map();
    this.lastGexTimestamp = null;
    this.gexLevels = null;

    // Statistics
    this.stats = {
      candlesProcessed: 0,
      levelsHit: 0,
      hitsByType: {}
    };
  }

  /**
   * Process a candle and update all levels
   * @param {Object} candle - Candle with { timestamp, open, high, low, close }
   * @returns {Object} Updated level state
   */
  processCandle(candle) {
    this.stats.candlesProcessed++;

    // Update session-based levels
    const sessionLevels = this.sessionTracker.processCandle(candle);

    // Update GEX levels if loader is available
    if (this.gexLoader) {
      const timestamp = new Date(candle.timestamp);
      // GEX data updates every 15 minutes, cache to avoid repeated lookups
      const gexTimestamp = Math.floor(candle.timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

      if (gexTimestamp !== this.lastGexTimestamp) {
        this.gexLevels = this.gexLoader.getGexLevels(timestamp);
        this.lastGexTimestamp = gexTimestamp;
      }
    }

    // Build current level map
    this.buildLevelMap(sessionLevels);

    return {
      sessionLevels,
      gexLevels: this.gexLevels,
      allLevels: this.getAllLevels()
    };
  }

  /**
   * Build the level map from session and GEX data
   * @param {Object} sessionLevels - Session-based levels
   */
  buildLevelMap(sessionLevels) {
    this.currentLevels.clear();

    // Add session levels
    if (sessionLevels.dailyOpen !== null) {
      this.currentLevels.set(LEVEL_TYPES.DAILY_OPEN, {
        price: sessionLevels.dailyOpen,
        type: LEVEL_TYPES.DAILY_OPEN,
        strength: LEVEL_STRENGTHS[LEVEL_TYPES.DAILY_OPEN],
        description: 'Daily Open (RTH)'
      });
    }

    if (sessionLevels.yesterdayHigh !== null) {
      this.currentLevels.set(LEVEL_TYPES.YESTERDAY_HIGH, {
        price: sessionLevels.yesterdayHigh,
        type: LEVEL_TYPES.YESTERDAY_HIGH,
        strength: LEVEL_STRENGTHS[LEVEL_TYPES.YESTERDAY_HIGH],
        description: 'Yesterday High'
      });
    }

    if (sessionLevels.yesterdayLow !== null) {
      this.currentLevels.set(LEVEL_TYPES.YESTERDAY_LOW, {
        price: sessionLevels.yesterdayLow,
        type: LEVEL_TYPES.YESTERDAY_LOW,
        strength: LEVEL_STRENGTHS[LEVEL_TYPES.YESTERDAY_LOW],
        description: 'Yesterday Low'
      });
    }

    if (sessionLevels.overnightHigh !== null) {
      this.currentLevels.set(LEVEL_TYPES.OVERNIGHT_HIGH, {
        price: sessionLevels.overnightHigh,
        type: LEVEL_TYPES.OVERNIGHT_HIGH,
        strength: LEVEL_STRENGTHS[LEVEL_TYPES.OVERNIGHT_HIGH],
        description: 'Overnight High'
      });
    }

    if (sessionLevels.overnightLow !== null) {
      this.currentLevels.set(LEVEL_TYPES.OVERNIGHT_LOW, {
        price: sessionLevels.overnightLow,
        type: LEVEL_TYPES.OVERNIGHT_LOW,
        strength: LEVEL_STRENGTHS[LEVEL_TYPES.OVERNIGHT_LOW],
        description: 'Overnight Low'
      });
    }

    if (sessionLevels.premarketHigh !== null) {
      this.currentLevels.set(LEVEL_TYPES.PREMARKET_HIGH, {
        price: sessionLevels.premarketHigh,
        type: LEVEL_TYPES.PREMARKET_HIGH,
        strength: LEVEL_STRENGTHS[LEVEL_TYPES.PREMARKET_HIGH],
        description: 'Premarket High'
      });
    }

    if (sessionLevels.premarketLow !== null) {
      this.currentLevels.set(LEVEL_TYPES.PREMARKET_LOW, {
        price: sessionLevels.premarketLow,
        type: LEVEL_TYPES.PREMARKET_LOW,
        strength: LEVEL_STRENGTHS[LEVEL_TYPES.PREMARKET_LOW],
        description: 'Premarket Low'
      });
    }

    if (sessionLevels.weeklyOpen !== null) {
      this.currentLevels.set(LEVEL_TYPES.WEEKLY_OPEN, {
        price: sessionLevels.weeklyOpen,
        type: LEVEL_TYPES.WEEKLY_OPEN,
        strength: LEVEL_STRENGTHS[LEVEL_TYPES.WEEKLY_OPEN],
        description: 'Weekly Open'
      });
    }

    // Add GEX levels
    if (this.gexLevels) {
      if (this.gexLevels.gamma_flip !== null && this.gexLevels.gamma_flip !== undefined) {
        this.currentLevels.set(LEVEL_TYPES.GEX_GAMMA_FLIP, {
          price: this.gexLevels.gamma_flip,
          type: LEVEL_TYPES.GEX_GAMMA_FLIP,
          strength: LEVEL_STRENGTHS[LEVEL_TYPES.GEX_GAMMA_FLIP],
          description: 'GEX Gamma Flip'
        });
      }

      if (this.gexLevels.put_wall !== null && this.gexLevels.put_wall !== undefined) {
        this.currentLevels.set(LEVEL_TYPES.GEX_PUT_WALL, {
          price: this.gexLevels.put_wall,
          type: LEVEL_TYPES.GEX_PUT_WALL,
          strength: LEVEL_STRENGTHS[LEVEL_TYPES.GEX_PUT_WALL],
          description: 'GEX Put Wall'
        });
      }

      if (this.gexLevels.call_wall !== null && this.gexLevels.call_wall !== undefined) {
        this.currentLevels.set(LEVEL_TYPES.GEX_CALL_WALL, {
          price: this.gexLevels.call_wall,
          type: LEVEL_TYPES.GEX_CALL_WALL,
          strength: LEVEL_STRENGTHS[LEVEL_TYPES.GEX_CALL_WALL],
          description: 'GEX Call Wall'
        });
      }

      // Add support levels
      if (this.gexLevels.support && Array.isArray(this.gexLevels.support)) {
        const supportTypes = [LEVEL_TYPES.GEX_SUPPORT_1, LEVEL_TYPES.GEX_SUPPORT_2, LEVEL_TYPES.GEX_SUPPORT_3];
        this.gexLevels.support.slice(0, 3).forEach((price, idx) => {
          if (price !== null && price !== undefined) {
            this.currentLevels.set(supportTypes[idx], {
              price,
              type: supportTypes[idx],
              strength: LEVEL_STRENGTHS[supportTypes[idx]],
              description: `GEX Support ${idx + 1}`
            });
          }
        });
      }

      // Add resistance levels
      if (this.gexLevels.resistance && Array.isArray(this.gexLevels.resistance)) {
        const resistanceTypes = [LEVEL_TYPES.GEX_RESISTANCE_1, LEVEL_TYPES.GEX_RESISTANCE_2, LEVEL_TYPES.GEX_RESISTANCE_3];
        this.gexLevels.resistance.slice(0, 3).forEach((price, idx) => {
          if (price !== null && price !== undefined) {
            this.currentLevels.set(resistanceTypes[idx], {
              price,
              type: resistanceTypes[idx],
              strength: LEVEL_STRENGTHS[resistanceTypes[idx]],
              description: `GEX Resistance ${idx + 1}`
            });
          }
        });
      }
    }
  }

  /**
   * Get all current levels as an array sorted by price
   * @returns {Array} Array of level objects
   */
  getAllLevels() {
    return Array.from(this.currentLevels.values())
      .sort((a, b) => a.price - b.price);
  }

  /**
   * Get levels sorted by strength (strongest first)
   * @returns {Array} Array of level objects
   */
  getLevelsByStrength() {
    return Array.from(this.currentLevels.values())
      .sort((a, b) => b.strength - a.strength);
  }

  /**
   * Find the nearest level to a given price
   * @param {number} price - Current price
   * @param {number} tolerance - Maximum distance to consider (default: this.levelTolerance)
   * @returns {Object|null} Nearest level or null if none within tolerance
   */
  getNearestLevel(price, tolerance = null) {
    const tol = tolerance ?? this.levelTolerance;
    let nearest = null;
    let minDistance = Infinity;

    for (const level of this.currentLevels.values()) {
      const distance = Math.abs(price - level.price);
      if (distance <= tol && distance < minDistance) {
        minDistance = distance;
        nearest = { ...level, distance };
      }
    }

    return nearest;
  }

  /**
   * Find all levels within tolerance of a price
   * @param {number} price - Current price
   * @param {number} tolerance - Maximum distance
   * @returns {Array} Array of nearby levels with distances
   */
  getLevelsNearPrice(price, tolerance = null) {
    const tol = tolerance ?? this.levelTolerance;
    const nearbyLevels = [];

    for (const level of this.currentLevels.values()) {
      const distance = Math.abs(price - level.price);
      if (distance <= tol) {
        nearbyLevels.push({ ...level, distance });
      }
    }

    // Sort by distance (closest first)
    return nearbyLevels.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Check if a candle swept through a level
   * A sweep occurs when price extends beyond a level then closes back inside
   *
   * @param {Object} candle - Candle to check
   * @param {number} tolerance - Tolerance for level proximity
   * @returns {Array} Array of swept levels with sweep details
   */
  detectLevelSweeps(candle, tolerance = null) {
    const tol = tolerance ?? this.levelTolerance;
    const sweptLevels = [];

    for (const level of this.currentLevels.values()) {
      const levelPrice = level.price;

      // Bearish sweep: price spiked above level, closed below
      // (upper wick swept the level)
      if (candle.high >= levelPrice - tol &&
          candle.high >= levelPrice &&
          candle.close < levelPrice &&
          candle.open < levelPrice) {

        const wickAbove = candle.high - Math.max(candle.open, candle.close);
        const penetration = candle.high - levelPrice;

        sweptLevels.push({
          ...level,
          sweepType: 'bearish',
          direction: 'SHORT',
          penetration: Math.round(penetration * 100) / 100,
          wickSize: Math.round(wickAbove * 100) / 100,
          sweepCandle: candle
        });
      }

      // Bullish sweep: price spiked below level, closed above
      // (lower wick swept the level)
      if (candle.low <= levelPrice + tol &&
          candle.low <= levelPrice &&
          candle.close > levelPrice &&
          candle.open > levelPrice) {

        const wickBelow = Math.min(candle.open, candle.close) - candle.low;
        const penetration = levelPrice - candle.low;

        sweptLevels.push({
          ...level,
          sweepType: 'bullish',
          direction: 'LONG',
          penetration: Math.round(penetration * 100) / 100,
          wickSize: Math.round(wickBelow * 100) / 100,
          sweepCandle: candle
        });
      }
    }

    // Sort by strength (highest first)
    return sweptLevels.sort((a, b) => b.strength - a.strength);
  }

  /**
   * Get support levels (levels below price)
   * @param {number} price - Current price
   * @returns {Array} Array of support levels sorted by price (highest first)
   */
  getSupportLevels(price) {
    return Array.from(this.currentLevels.values())
      .filter(level => level.price < price)
      .sort((a, b) => b.price - a.price);
  }

  /**
   * Get resistance levels (levels above price)
   * @param {number} price - Current price
   * @returns {Array} Array of resistance levels sorted by price (lowest first)
   */
  getResistanceLevels(price) {
    return Array.from(this.currentLevels.values())
      .filter(level => level.price > price)
      .sort((a, b) => a.price - b.price);
  }

  /**
   * Count how many levels are near a price (confluence check)
   * @param {number} price - Price to check
   * @param {number} tolerance - Distance tolerance
   * @returns {Object} { count, levels }
   */
  countLevelsNearPrice(price, tolerance = 10) {
    const nearbyLevels = this.getLevelsNearPrice(price, tolerance);
    return {
      count: nearbyLevels.length,
      levels: nearbyLevels,
      combinedStrength: nearbyLevels.reduce((sum, l) => sum + l.strength, 0)
    };
  }

  /**
   * Get levels at a specific timestamp (for backtesting)
   * Requires that candles have been processed up to this timestamp
   * @param {number} timestamp - Timestamp
   * @returns {Object} Level state at timestamp
   */
  getLevelsAt(timestamp) {
    // This returns current state - for backtesting, process candles sequentially
    return {
      sessionLevels: this.sessionTracker.getLevels(),
      gexLevels: this.gexLevels,
      allLevels: this.getAllLevels(),
      timestamp
    };
  }

  /**
   * Get current session
   * @returns {string} Current session name
   */
  getCurrentSession() {
    return this.sessionTracker.getLevels().currentSession;
  }

  /**
   * Reset all state
   */
  reset() {
    this.sessionTracker.reset();
    this.currentLevels.clear();
    this.lastGexTimestamp = null;
    this.gexLevels = null;
    this.stats = {
      candlesProcessed: 0,
      levelsHit: 0,
      hitsByType: {}
    };
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Get configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      levelTolerance: this.levelTolerance,
      hasGexLoader: this.gexLoader !== null
    };
  }
}

export default LevelCalculator;
