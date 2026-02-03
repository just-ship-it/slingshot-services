/**
 * Structural Level Detection System
 *
 * Detects key structural levels on higher timeframes (1H, 4H) that can be used
 * as pullback entry points for the two-tier entry system.
 *
 * Key Features:
 * - Swing high/low detection with configurable lookback
 * - Multi-timeframe level tracking
 * - Level strength scoring based on touches/reactions
 * - Fresh vs stale level classification
 */

export class StructuralLevelDetector {
  constructor(options = {}) {
    this.options = {
      swingLookback: options.swingLookback || 20,        // Candles to look back for swing detection
      swingStrengthLeft: options.swingStrengthLeft || 15, // 15 candles on left side for swing (matching Pine script)
      swingStrengthRight: options.swingStrengthRight || 15, // 15 candles on right side for swing
      levelTouchDistance: options.levelTouchDistance || 3, // Points within level to consider a "touch"
      maxLevelAge: options.maxLevelAge || 48,            // Hours before level becomes stale
      minLevelStrength: options.minLevelStrength || 1,   // Minimum touches to consider level valid
      ...options
    };

    // Storage for detected levels
    this.structuralLevels = {
      '1H': [],
      '4H': [],
      'daily': []
    };

    // Track candle data for different timeframes
    this.candleData = {
      '15m': [],
      '1H': [],
      '4H': []
    };
  }

  /**
   * Process new candle data and detect structural levels
   */
  processCandles(candles, timeframe = '15m') {
    if (!Array.isArray(candles) || candles.length === 0) {
      return this.structuralLevels;
    }

    // Update candle storage
    this.candleData[timeframe] = candles;

    // Build higher timeframe data if processing 15m candles
    if (timeframe === '15m') {
      this.buildHigherTimeframeData(candles);
    }

    // Detect structural levels on higher timeframes
    this.detectSwingLevels('1H');
    this.detectSwingLevels('4H');

    // Update level strength and freshness
    this.updateLevelMetrics();

    // Clean up stale levels
    this.cleanupStaleLevels();

    return this.getActiveLevels();
  }

  /**
   * Build 1H and 4H candle data from 15m candles
   */
  buildHigherTimeframeData(candles15m) {
    // Build 1H candles (4 x 15m candles)
    this.candleData['1H'] = this.aggregateCandles(candles15m, 4);

    // Build 4H candles (16 x 15m candles)
    this.candleData['4H'] = this.aggregateCandles(candles15m, 16);
  }

  /**
   * Aggregate lower timeframe candles into higher timeframe
   */
  aggregateCandles(candles, ratio) {
    const aggregated = [];

    for (let i = 0; i < candles.length; i += ratio) {
      const group = candles.slice(i, i + ratio);
      if (group.length === ratio) {
        aggregated.push({
          timestamp: group[0].timestamp,
          open: group[0].open,
          high: Math.max(...group.map(c => c.high)),
          low: Math.min(...group.map(c => c.low)),
          close: group[group.length - 1].close,
          volume: group.reduce((sum, c) => sum + (c.volume || 0), 0)
        });
      }
    }

    return aggregated;
  }

  /**
   * Detect swing highs and lows on specified timeframe
   */
  detectSwingLevels(timeframe) {
    const candles = this.candleData[timeframe];
    if (!candles || candles.length < this.options.swingLookback * 2) {
      return;
    }

    const swingHighs = this.findSwingHighs(candles);
    const swingLows = this.findSwingLows(candles);

    // Update structural levels
    this.structuralLevels[timeframe] = [
      ...swingHighs.map(swing => ({
        ...swing,
        type: 'resistance',
        timeframe,
        detectedAt: Date.now()
      })),
      ...swingLows.map(swing => ({
        ...swing,
        type: 'support',
        timeframe,
        detectedAt: Date.now()
      }))
    ];
  }

  /**
   * Find swing highs using pivot analysis with configurable left/right strength
   */
  findSwingHighs(candles) {
    const swings = [];
    const leftStrength = this.options.swingStrengthLeft;
    const rightStrength = this.options.swingStrengthRight;

    // Need enough candles on both sides for proper swing detection
    for (let i = leftStrength; i < candles.length - rightStrength; i++) {
      const currentHigh = candles[i].high;
      let isSwingHigh = true;

      // Check left side - all must be lower than current high
      for (let j = i - leftStrength; j < i; j++) {
        if (candles[j].high >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }

      if (!isSwingHigh) continue;

      // Check right side - all must be lower than current high
      for (let j = i + 1; j <= i + rightStrength; j++) {
        if (candles[j].high >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }

      if (isSwingHigh) {
        swings.push({
          price: currentHigh,
          timestamp: candles[i].timestamp,
          index: i,
          strength: this.calculateSwingStrength(candles, i, 'high'),
          touches: 1,
          lastTouch: candles[i].timestamp
        });
      }
    }

    return swings.sort((a, b) => b.strength - a.strength).slice(0, 10); // Keep top 10
  }

  /**
   * Find swing lows using pivot analysis with configurable left/right strength
   */
  findSwingLows(candles) {
    const swings = [];
    const leftStrength = this.options.swingStrengthLeft;
    const rightStrength = this.options.swingStrengthRight;

    // Need enough candles on both sides for proper swing detection
    for (let i = leftStrength; i < candles.length - rightStrength; i++) {
      const currentLow = candles[i].low;
      let isSwingLow = true;

      // Check left side - all must be higher than current low
      for (let j = i - leftStrength; j < i; j++) {
        if (candles[j].low <= currentLow) {
          isSwingLow = false;
          break;
        }
      }

      if (!isSwingLow) continue;

      // Check right side - all must be higher than current low
      for (let j = i + 1; j <= i + rightStrength; j++) {
        if (candles[j].low <= currentLow) {
          isSwingLow = false;
          break;
        }
      }

      if (isSwingLow) {
        swings.push({
          price: currentLow,
          timestamp: candles[i].timestamp,
          index: i,
          strength: this.calculateSwingStrength(candles, i, 'low'),
          touches: 1,
          lastTouch: candles[i].timestamp
        });
      }
    }

    return swings.sort((a, b) => b.strength - a.strength).slice(0, 10); // Keep top 10
  }

  /**
   * Calculate strength of swing based on surrounding price action
   */
  calculateSwingStrength(candles, index, type) {
    const lookback = this.options.swingLookback;
    const start = Math.max(0, index - lookback);
    const end = Math.min(candles.length - 1, index + lookback);

    let strength = 0;
    const pivotPrice = type === 'high' ? candles[index].high : candles[index].low;

    for (let i = start; i <= end; i++) {
      if (i === index) continue;

      const comparePrice = type === 'high' ? candles[i].high : candles[i].low;
      const distance = Math.abs(pivotPrice - comparePrice);

      if (type === 'high') {
        strength += pivotPrice > comparePrice ? distance : 0;
      } else {
        strength += pivotPrice < comparePrice ? distance : 0;
      }
    }

    return strength;
  }

  /**
   * Update level metrics (touches, freshness, etc.)
   */
  updateLevelMetrics() {
    const currentCandles = this.candleData['15m'];
    if (!currentCandles || currentCandles.length === 0) return;

    const recentCandles = currentCandles.slice(-100); // Last 100 candles for touch detection

    Object.keys(this.structuralLevels).forEach(timeframe => {
      this.structuralLevels[timeframe].forEach(level => {
        // Count touches
        let touches = 0;
        let lastTouch = level.lastTouch;

        recentCandles.forEach(candle => {
          const distance = Math.abs(level.price - (level.type === 'support' ? candle.low : candle.high));

          if (distance <= this.options.levelTouchDistance) {
            touches++;
            lastTouch = Math.max(lastTouch, candle.timestamp);
          }
        });

        level.touches = Math.max(level.touches, touches);
        level.lastTouch = lastTouch;

        // Calculate freshness
        const ageHours = (Date.now() - level.lastTouch) / (1000 * 60 * 60);
        level.ageHours = ageHours;
        level.isFresh = ageHours <= this.options.maxLevelAge;
      });
    });
  }

  /**
   * Remove stale levels
   */
  cleanupStaleLevels() {
    Object.keys(this.structuralLevels).forEach(timeframe => {
      this.structuralLevels[timeframe] = this.structuralLevels[timeframe].filter(level => {
        return level.isFresh && level.touches >= this.options.minLevelStrength;
      });
    });
  }

  /**
   * Get currently active levels sorted by relevance
   */
  getActiveLevels() {
    const allLevels = [];

    Object.keys(this.structuralLevels).forEach(timeframe => {
      this.structuralLevels[timeframe].forEach(level => {
        if (level.isFresh && level.touches >= this.options.minLevelStrength) {
          allLevels.push({
            ...level,
            relevanceScore: this.calculateRelevanceScore(level)
          });
        }
      });
    });

    return allLevels.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Calculate relevance score for level prioritization
   */
  calculateRelevanceScore(level) {
    let score = 0;

    // Base strength
    score += level.strength * 0.3;

    // Touch count
    score += level.touches * 20;

    // Freshness (inverse of age)
    score += (this.options.maxLevelAge - level.ageHours) * 2;

    // Timeframe weight (higher timeframes = higher relevance)
    const timeframeWeights = { '1H': 1.0, '4H': 1.5, 'daily': 2.0 };
    score *= timeframeWeights[level.timeframe] || 1.0;

    return score;
  }

  /**
   * Check if current price is near any structural level
   */
  getNearbyLevels(currentPrice, maxDistance = 20) {
    const activeLevels = this.getActiveLevels();

    return activeLevels.filter(level => {
      const distance = Math.abs(level.price - currentPrice);
      return distance <= maxDistance;
    }).map(level => ({
      ...level,
      distance: Math.abs(level.price - currentPrice),
      direction: currentPrice > level.price ? 'above' : 'below'
    }));
  }

  /**
   * Get potential pullback levels for a given trade direction
   */
  getPullbackLevels(currentPrice, tradeDirection, maxDistance = 50) {
    const activeLevels = this.getActiveLevels();

    return activeLevels.filter(level => {
      // For long trades, look for support levels below current price
      if (tradeDirection === 'buy') {
        return level.type === 'support' && level.price < currentPrice;
      }

      // For short trades, look for resistance levels above current price
      if (tradeDirection === 'sell') {
        return level.type === 'resistance' && level.price > currentPrice;
      }

      return false;
    }).map(level => ({
      ...level,
      distance: Math.abs(level.price - currentPrice),
      pullbackDistance: currentPrice - level.price // Positive = pullback down, Negative = pullback up
    })).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Check if price has swept/touched a specific level
   */
  hasLevelBeenSwept(level, recentCandles, sweepBuffer = 2) {
    if (!recentCandles || recentCandles.length === 0) return false;

    return recentCandles.some(candle => {
      if (level.type === 'support') {
        // Support swept if low goes below level
        return candle.low <= level.price - sweepBuffer;
      } else {
        // Resistance swept if high goes above level
        return candle.high >= level.price + sweepBuffer;
      }
    });
  }

  /**
   * Get debug information about current levels
   */
  getDebugInfo() {
    return {
      totalLevels: Object.values(this.structuralLevels).reduce((sum, levels) => sum + levels.length, 0),
      levelsByTimeframe: Object.keys(this.structuralLevels).map(tf => ({
        timeframe: tf,
        count: this.structuralLevels[tf].length,
        levels: this.structuralLevels[tf].map(l => ({
          price: l.price,
          type: l.type,
          strength: l.strength,
          touches: l.touches,
          ageHours: l.ageHours?.toFixed(1)
        }))
      })),
      activeLevels: this.getActiveLevels().length,
      candleDataSizes: Object.keys(this.candleData).map(tf => ({
        timeframe: tf,
        count: this.candleData[tf]?.length || 0
      }))
    };
  }
}