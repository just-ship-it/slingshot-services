/**
 * Fibonacci Retracement Level Calculator
 *
 * Calculates Fibonacci retracement levels from recent price moves to identify
 * potential pullback entry points for the two-tier entry system.
 *
 * Key Features:
 * - Automatic swing detection for Fibonacci calculation
 * - Multiple Fibonacci ratios (23.6%, 38.2%, 50%, 61.8%, 78.6%)
 * - Dynamic level updates based on new price action
 * - Level strength scoring based on touches and reactions
 */

export class FibonacciLevelCalculator {
  constructor(options = {}) {
    this.options = {
      // Fibonacci ratios to calculate (with 70.5% as primary golden ratio)
      fibRatios: options.fibRatios || [0.236, 0.382, 0.5, 0.618, 0.705, 0.786],

      // Rolling window parameters (like Pine script ta.highest/ta.lowest)
      windowLength: options.windowLength || 100,      // Look back 100 candles for highs/lows
      minSwingSize: options.minSwingSize || 25,       // Minimum points for valid swing
      maxSwingAge: options.maxSwingAge || 48,         // Hours before swing becomes stale

      // Level interaction parameters
      levelTouchDistance: options.levelTouchDistance || 3, // Points for level interaction
      maxLevelAge: options.maxLevelAge || 24,             // Hours before level expires

      // Minimum number of touches to consider level valid
      minTouches: options.minTouches || 1,

      ...options
    };

    // Storage for fibonacci levels
    this.fibLevels = [];
    this.recentSwings = [];
    this.candleHistory = [];
  }

  /**
   * Process candle data and calculate fibonacci levels
   */
  processCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return this.fibLevels;
    }

    // Update candle history
    this.candleHistory = candles;

    // Detect new swings
    this.detectSwings(candles);

    // Calculate fibonacci levels from recent swings
    this.calculateFibonacciLevels();

    // Update level metrics
    this.updateLevelMetrics(candles);

    // Clean up stale levels
    this.cleanupStaleLevels();

    return this.getActiveLevels();
  }

  /**
   * Detect swings using rolling window approach (like Pine script ta.highest/ta.lowest)
   */
  detectSwings(candles) {
    // Use all available candles if we don't have enough for full window
    const requiredCandles = Math.min(100, this.options.windowLength);  // Minimum 100 candles for meaningful detection
    if (candles.length < requiredCandles) {
      return;
    }

    // Use a simple approach: find the most recent significant swing
    // by looking at the rolling highest/lowest in the available window
    const windowLength = Math.min(this.options.windowLength, candles.length);
    const recentCandles = candles.slice(-windowLength);

    // Find the highest high and lowest low in the window
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    let highCandle = null;
    let lowCandle = null;

    for (const candle of recentCandles) {
      if (candle.high > highestHigh) {
        highestHigh = candle.high;
        highCandle = candle;
      }
      if (candle.low < lowestLow) {
        lowestLow = candle.low;
        lowCandle = candle;
      }
    }

    // Create swing if we have both high and low and sufficient size
    const swingSize = highestHigh - lowestLow;
    if (highCandle && lowCandle && swingSize >= this.options.minSwingSize) {
      // Determine direction based on chronological order
      const isUpSwing = lowCandle.timestamp < highCandle.timestamp;

      const swing = {
        id: `${lowCandle.timestamp}-${highCandle.timestamp}`,
        start: isUpSwing ? lowCandle : highCandle,
        end: isUpSwing ? highCandle : lowCandle,
        size: swingSize,
        direction: isUpSwing ? 'up' : 'down',
        timestamp: Math.max(highCandle.timestamp, lowCandle.timestamp),
        high: highestHigh,
        low: lowestLow,
        age: 0
      };

      // Store as the most recent swing
      this.recentSwings = [swing];
      // console.log(`Rolling window swing detected: High=${highestHigh.toFixed(2)}, Low=${lowestLow.toFixed(2)}, Size=${swingSize.toFixed(1)} pts, Direction=${swing.direction}`);
    }
  }

  // Removed old pivot detection method - using rolling window approach instead

  /**
   * Calculate fibonacci retracement levels from recent swings
   */
  calculateFibonacciLevels() {
    this.fibLevels = [];

    this.recentSwings.forEach(swing => {
      const fibLevels = this.calculateFibLevelsForSwing(swing);
      this.fibLevels.push(...fibLevels);
    });

    // Remove duplicate levels (within 2 points of each other)
    this.fibLevels = this.removeDuplicateLevels(this.fibLevels);

    //console.log(`Calculated ${this.fibLevels.length} fibonacci levels from ${this.recentSwings.length} swings`);
  }

  /**
   * Calculate fibonacci levels with enhanced logic for trade direction and confluence target
   */
  calculateFibonacciLevelsForTrade(tradeDirection, confluenceTarget) {
    this.fibLevels = [];

    this.recentSwings.forEach(swing => {
      const fibLevels = this.calculateFibLevelsForSwing(swing, tradeDirection, confluenceTarget);
      this.fibLevels.push(...fibLevels);
    });

    // Remove duplicate levels (within 2 points of each other)
    this.fibLevels = this.removeDuplicateLevels(this.fibLevels);

    console.log(`Calculated ${this.fibLevels.length} fibonacci levels from ${this.recentSwings.length} swings for ${tradeDirection} trade to ${confluenceTarget}`);
  }

  /**
   * Calculate fibonacci levels for a specific swing
   */
  calculateFibLevelsForSwing(swing, tradeDirection = null, confluenceTarget = null) {
    const levels = [];
    const swingHigh = swing.high;
    const swingLow = swing.low;
    const swingRange = swingHigh - swingLow;

    // Extract timestamps from swing ID to check sequence
    const swingIdParts = swing.id.split('-');
    const lowTimestamp = parseInt(swingIdParts[0]);
    const highTimestamp = parseInt(swingIdParts[1]);

    let fibHigh = swingHigh;
    let fibLow = swingLow;
    let useConfluenceTarget = false;

    // Check swing sequence for trade direction validity
    if (tradeDirection && confluenceTarget) {
      if (tradeDirection === 'buy') {
        // For longs: need low to occur before high (low → high sequence)
        const correctSequence = lowTimestamp < highTimestamp;
        if (!correctSequence) {
          // Use confluence target as high, keep swing low
          fibHigh = confluenceTarget;
          fibLow = swingLow;
          useConfluenceTarget = true;
        }
      } else if (tradeDirection === 'sell') {
        // For shorts: need high to occur before low (high → low sequence)
        const correctSequence = highTimestamp < lowTimestamp;
        if (!correctSequence) {
          // Use confluence target as low, keep swing high
          fibHigh = swingHigh;
          fibLow = confluenceTarget;
          useConfluenceTarget = true;
        }
      }
    }

    const adjustedRange = fibHigh - fibLow;

    // Calculate each fibonacci level
    this.options.fibRatios.forEach(ratio => {
      const price = fibHigh - (adjustedRange * ratio); // Retracement from high toward low
      const fibLevel = {
        price: price,
        ratio: ratio,
        ratioPercent: (ratio * 100).toFixed(1),
        swingId: swing.id,
        swingDirection: swing.direction,
        swingHigh: fibHigh,
        swingLow: fibLow,
        swingSize: adjustedRange,
        type: this.getFibLevelType(ratio),
        timestamp: swing.timestamp,
        touches: 0,
        lastTouch: swing.timestamp,
        strength: this.calculateInitialStrength(swing, ratio),
        age: 0,
        usesConfluenceTarget: useConfluenceTarget,
        originalSwingHigh: swingHigh,
        originalSwingLow: swingLow
      };

      levels.push(fibLevel);
    });

    return levels;
  }

  /**
   * Get fibonacci level type based on ratio
   */
  getFibLevelType(ratio) {
    if (ratio <= 0.382) return 'shallow_retracement';
    if (ratio <= 0.5) return 'half_retracement';
    if (ratio <= 0.618) return 'standard_golden';
    if (ratio <= 0.705) return 'prime_golden';  // 70.5% - primary golden ratio
    return 'deep_retracement';
  }

  /**
   * Calculate initial strength for fibonacci level
   */
  calculateInitialStrength(swing, ratio) {
    let strength = 50; // Base strength

    // Swing size contributes to strength
    strength += Math.min(50, swing.size * 0.5);

    // Primary golden ratio (70.5%) gets highest bonus strength
    if (Math.abs(ratio - 0.705) < 0.01) {
      strength += 35;
    }

    // 50% retracement gets high bonus strength
    if (Math.abs(ratio - 0.5) < 0.01) {
      strength += 25;
    }

    // Standard golden ratio (61.8%) gets moderate bonus strength
    if (Math.abs(ratio - 0.618) < 0.01) {
      strength += 20;
    }

    // Recent swings get higher strength
    const ageHours = (Date.now() - swing.timestamp) / (1000 * 60 * 60);
    strength += Math.max(0, 24 - ageHours); // Up to 24 bonus points for freshness

    return Math.min(100, strength);
  }

  /**
   * Remove duplicate levels that are too close together
   */
  removeDuplicateLevels(levels) {
    const filtered = [];
    const tolerance = 2; // Points

    levels.sort((a, b) => a.price - b.price);

    levels.forEach(level => {
      const isDuplicate = filtered.some(existing =>
        Math.abs(existing.price - level.price) <= tolerance
      );

      if (!isDuplicate) {
        filtered.push(level);
      }
    });

    return filtered;
  }

  /**
   * Update level metrics based on recent price action
   */
  updateLevelMetrics(candles) {
    const recentCandles = candles.slice(-50); // Last 50 candles

    // Use the most recent candle's timestamp for age calculations during backtesting
    const currentTime = recentCandles.length > 0 ? recentCandles[recentCandles.length - 1].timestamp : Date.now();

    this.fibLevels.forEach(level => {
      let touches = 0;
      let lastTouch = level.lastTouch;

      // Count touches
      recentCandles.forEach(candle => {
        const distance = Math.min(
          Math.abs(level.price - candle.high),
          Math.abs(level.price - candle.low)
        );

        if (distance <= this.options.levelTouchDistance) {
          touches++;
          lastTouch = Math.max(lastTouch, candle.timestamp);
        }
      });

      level.touches = Math.max(level.touches, touches);
      level.lastTouch = lastTouch;

      // Calculate age using current candle timestamp, not wall clock time
      const ageHours = (currentTime - level.lastTouch) / (1000 * 60 * 60);
      level.age = ageHours;
      level.isFresh = ageHours <= this.options.maxLevelAge;

      // Update strength based on touches
      level.strength = level.strength + (touches * 10);
      level.strength = Math.min(100, level.strength);
    });
  }

  /**
   * Clean up stale levels
   */
  cleanupStaleLevels() {
    // Don't clean up fibonacci levels - keep all levels for confluence analysis

    // Don't clean up swings based on wall clock time in backtesting
    // The swings are already filtered by recency during detection
    // Only remove if we have too many swings
    if (this.recentSwings.length > 5) {
      this.recentSwings = this.recentSwings.slice(0, 5);
    }
  }

  /**
   * Get active fibonacci levels sorted by relevance
   */
  getActiveLevels() {
    // Return all fibonacci levels for confluence analysis (no freshness filter)
    return this.fibLevels
      .map(level => ({
        ...level,
        relevanceScore: this.calculateRelevanceScore(level)
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Calculate relevance score for level prioritization
   */
  calculateRelevanceScore(level) {
    let score = 0;

    // Base strength
    score += level.strength * 0.5;

    // Touch count
    score += level.touches * 15;

    // Fibonacci ratio importance (70.5% primary golden ratio gets highest score)
    const ratioScores = {
      0.236: 0.7,
      0.382: 0.9,
      0.5: 1.1,   // Strong half retracement
      0.618: 1.0, // Standard golden ratio
      0.705: 1.3, // Primary golden ratio - highest score
      0.786: 0.8
    };
    score *= ratioScores[level.ratio] || 1.0;

    // Swing size (larger swings = more important levels)
    score += Math.min(50, level.swingSize * 0.3);

    // Freshness bonus
    score += Math.max(0, (this.options.maxLevelAge - level.age) * 2);

    return score;
  }

  /**
   * Get pullback levels for specific trade direction
   */
  getPullbackLevels(currentPrice, tradeDirection, maxDistance = 50) {
    const activeLevels = this.getActiveLevels();

    return activeLevels.filter(level => {
      // For long trades, look for levels below current price
      if (tradeDirection === 'buy') {
        return level.price < currentPrice;
      }

      // For short trades, look for levels above current price
      if (tradeDirection === 'sell') {
        return level.price > currentPrice;
      }

      return false;
    }).map(level => ({
      ...level,
      distance: Math.abs(level.price - currentPrice),
      pullbackDistance: Math.abs(currentPrice - level.price),
      description: `${level.ratioPercent}% Fib (${level.type})`
    })).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Get fibonacci levels near current price
   */
  getNearbyLevels(currentPrice, maxDistance = 20) {
    const activeLevels = this.getActiveLevels();

    return activeLevels.filter(level => {
      const distance = Math.abs(level.price - currentPrice);
      return distance <= maxDistance;
    }).map(level => ({
      ...level,
      distance: Math.abs(level.price - currentPrice),
      direction: currentPrice > level.price ? 'above' : 'below',
      description: `${level.ratioPercent}% Fib`
    })).sort((a, b) => a.distance - b.distance);
  }

  /**
   * Check if price has respected a fibonacci level (bounced off it)
   */
  hasLevelBeenRespected(level, recentCandles, respectDistance = 5) {
    if (!recentCandles || recentCandles.length === 0) return false;

    // Look for candles that came close to the level and then moved away
    for (let i = 1; i < recentCandles.length; i++) {
      const prevCandle = recentCandles[i - 1];
      const candle = recentCandles[i];

      const prevDistance = Math.min(
        Math.abs(level.price - prevCandle.low),
        Math.abs(level.price - prevCandle.high)
      );

      if (prevDistance <= this.options.levelTouchDistance) {
        // Price was at the level, check if it moved away respectfully
        const currentDistance = Math.abs(level.price - candle.close);

        if (currentDistance >= respectDistance) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get the most relevant fibonacci level for pullback entry
   */
  getBestPullbackLevel(currentPrice, tradeDirection, maxDistance = 30) {
    const pullbackLevels = this.getPullbackLevels(currentPrice, tradeDirection, maxDistance);

    if (pullbackLevels.length === 0) return null;

    // Prefer golden ratio and 50% levels
    const preferredLevels = pullbackLevels.filter(level =>
      level.ratio === 0.618 || level.ratio === 0.5
    );

    if (preferredLevels.length > 0) {
      return preferredLevels[0]; // Highest relevance score
    }

    return pullbackLevels[0]; // Best available level
  }

  /**
   * Get debug information
   */
  getDebugInfo() {
    return {
      totalFibLevels: this.fibLevels.length,
      activeLevels: this.getActiveLevels().length,
      recentSwings: this.recentSwings.length,
      swingInfo: this.recentSwings.map(swing => ({
        id: swing.id,
        direction: swing.direction,
        size: swing.size.toFixed(1),
        ageHours: ((Date.now() - swing.timestamp) / (1000 * 60 * 60)).toFixed(1)
      })),
      levelBreakdown: this.getActiveLevels().map(level => ({
        price: level.price.toFixed(2),
        ratio: level.ratioPercent + '%',
        touches: level.touches,
        strength: level.strength.toFixed(1),
        ageHours: level.age.toFixed(1)
      }))
    };
  }
}