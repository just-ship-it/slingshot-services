/**
 * Order Block Detector
 *
 * Identifies Order Blocks (OB) - the last opposite candle before a strong
 * impulsive move. These represent areas where institutional orders were placed.
 *
 * Bullish Order Block: The last BEARISH candle before a strong UP move (demand zone)
 * Bearish Order Block: The last BULLISH candle before a strong DOWN move (supply zone)
 *
 * Order Blocks are significant because price often returns to these zones
 * before continuing in the direction of the original impulse.
 */

export class OrderBlockDetector {
  constructor(options = {}) {
    this.options = {
      minImpulseSize: options.minImpulseSize || 15,      // Min points for impulse move
      minImpulseCandles: options.minImpulseCandles || 1,  // Min candles for impulse
      maxImpulseCandles: options.maxImpulseCandles || 5,  // Max candles to consider as impulse
      maxOrderBlockAge: options.maxOrderBlockAge || 48,   // Hours before OB expires
      obValidationMethod: options.obValidationMethod || 'body', // 'body' or 'wick' for OB range
      mitigationThreshold: options.mitigationThreshold || 0.5, // % of OB that must be touched for mitigation
      timeInZoneFilterEnabled: options.timeInZoneFilterEnabled === true, // Default: disabled (must explicitly enable)
      timeInZoneThreshold: options.timeInZoneThreshold || 0.33, // If >33% of candles since formation traded inside zone, invalidate
      ...options
    };

    // State tracking
    this.activeOrderBlocks = [];
    this.mitigatedOrderBlocks = [];
  }

  /**
   * Reset detector state
   */
  reset() {
    this.activeOrderBlocks = [];
    this.mitigatedOrderBlocks = [];
  }

  /**
   * Check if a candle is bullish
   * @param {Object} candle
   * @returns {boolean}
   */
  isBullishCandle(candle) {
    return candle.close > candle.open;
  }

  /**
   * Check if a candle is bearish
   * @param {Object} candle
   * @returns {boolean}
   */
  isBearishCandle(candle) {
    return candle.close < candle.open;
  }

  /**
   * Calculate candle body size
   * @param {Object} candle
   * @returns {number}
   */
  getBodySize(candle) {
    return Math.abs(candle.close - candle.open);
  }

  /**
   * Calculate candle range (high - low)
   * @param {Object} candle
   * @returns {number}
   */
  getCandleRange(candle) {
    return candle.high - candle.low;
  }

  /**
   * Detect impulse moves and identify Order Blocks
   * @param {Object[]} candles - Historical candles
   * @param {number} currentTime - Current timestamp for age filtering
   * @returns {Object[]} Array of detected Order Blocks
   */
  detectOrderBlocks(candles, currentTime = null) {
    if (!candles || candles.length < 3) {
      return [];
    }

    const orderBlocks = [];

    // Scan for impulse moves
    for (let i = 1; i < candles.length - 1; i++) {
      const potentialOB = candles[i - 1];
      const impulseStart = candles[i];

      // Check for bullish impulse (look for bearish OB candidate before it)
      const bullishImpulse = this.detectBullishImpulse(candles, i);
      if (bullishImpulse && this.isBearishCandle(potentialOB)) {
        const ob = this.createOrderBlock(potentialOB, 'bullish', bullishImpulse, currentTime);
        if (ob) orderBlocks.push(ob);
      }

      // Check for bearish impulse (look for bullish OB candidate before it)
      const bearishImpulse = this.detectBearishImpulse(candles, i);
      if (bearishImpulse && this.isBullishCandle(potentialOB)) {
        const ob = this.createOrderBlock(potentialOB, 'bearish', bearishImpulse, currentTime);
        if (ob) orderBlocks.push(ob);
      }
    }

    // Filter by age
    let filteredOBs = orderBlocks;
    if (currentTime) {
      filteredOBs = orderBlocks.filter(ob => ob.ageHours <= this.options.maxOrderBlockAge);
    }

    // Remove duplicates (same candle might be detected multiple times)
    const uniqueOBs = this.removeDuplicates(filteredOBs);

    // Store active order blocks
    this.activeOrderBlocks = uniqueOBs.filter(ob => !ob.mitigated);

    return uniqueOBs;
  }

  /**
   * Detect a bullish impulse move starting at index
   * @param {Object[]} candles
   * @param {number} startIndex
   * @returns {Object|null} Impulse info or null
   */
  detectBullishImpulse(candles, startIndex) {
    let totalMove = 0;
    let impulseCandles = [];
    let consecutiveBullish = 0;

    for (let i = startIndex; i < Math.min(startIndex + this.options.maxImpulseCandles, candles.length); i++) {
      const candle = candles[i];

      if (this.isBullishCandle(candle)) {
        consecutiveBullish++;
        totalMove += candle.close - candle.open;
        impulseCandles.push(candle);
      } else {
        // Allow one small bearish candle in the impulse
        if (consecutiveBullish >= 1 && this.getBodySize(candle) < totalMove * 0.3) {
          impulseCandles.push(candle);
        } else {
          break;
        }
      }
    }

    if (impulseCandles.length >= this.options.minImpulseCandles && totalMove >= this.options.minImpulseSize) {
      return {
        type: 'bullish',
        startPrice: impulseCandles[0].open,
        endPrice: impulseCandles[impulseCandles.length - 1].close,
        size: totalMove,
        candles: impulseCandles,
        candleCount: impulseCandles.length
      };
    }

    return null;
  }

  /**
   * Detect a bearish impulse move starting at index
   * @param {Object[]} candles
   * @param {number} startIndex
   * @returns {Object|null} Impulse info or null
   */
  detectBearishImpulse(candles, startIndex) {
    let totalMove = 0;
    let impulseCandles = [];
    let consecutiveBearish = 0;

    for (let i = startIndex; i < Math.min(startIndex + this.options.maxImpulseCandles, candles.length); i++) {
      const candle = candles[i];

      if (this.isBearishCandle(candle)) {
        consecutiveBearish++;
        totalMove += candle.open - candle.close;
        impulseCandles.push(candle);
      } else {
        // Allow one small bullish candle in the impulse
        if (consecutiveBearish >= 1 && this.getBodySize(candle) < totalMove * 0.3) {
          impulseCandles.push(candle);
        } else {
          break;
        }
      }
    }

    if (impulseCandles.length >= this.options.minImpulseCandles && totalMove >= this.options.minImpulseSize) {
      return {
        type: 'bearish',
        startPrice: impulseCandles[0].open,
        endPrice: impulseCandles[impulseCandles.length - 1].close,
        size: totalMove,
        candles: impulseCandles,
        candleCount: impulseCandles.length
      };
    }

    return null;
  }

  /**
   * Create an Order Block object
   * @param {Object} obCandle - The order block candle
   * @param {string} type - 'bullish' | 'bearish'
   * @param {Object} impulse - The impulse move info
   * @param {number|null} currentTime
   * @returns {Object} Order Block object
   */
  createOrderBlock(obCandle, type, impulse, currentTime) {
    const useBody = this.options.obValidationMethod === 'body';

    let high, low;
    if (useBody) {
      high = Math.max(obCandle.open, obCandle.close);
      low = Math.min(obCandle.open, obCandle.close);
    } else {
      high = obCandle.high;
      low = obCandle.low;
    }

    const ageHours = currentTime
      ? (currentTime - obCandle.timestamp) / (1000 * 60 * 60)
      : 0;

    return {
      type: type,  // 'bullish' (demand) or 'bearish' (supply)
      high: high,
      low: low,
      midpoint: (high + low) / 2,
      size: high - low,
      timestamp: obCandle.timestamp,
      candle: obCandle,
      impulse: {
        size: impulse.size,
        candleCount: impulse.candleCount,
        startPrice: impulse.startPrice,
        endPrice: impulse.endPrice
      },
      ageHours: ageHours,
      mitigated: false,
      mitigationPercent: 0,
      mitigationReason: null,
      retestCount: 0,
      // Time-in-zone tracking
      candlesSinceFormation: 0,  // Total candles since OB formed
      candlesInZone: 0,          // Candles where price was inside OB
      timeInZonePercent: 0       // candlesInZone / candlesSinceFormation
    };
  }

  /**
   * Update mitigation status of order blocks based on recent price action
   * @param {Object[]} orderBlocks - Array of order blocks to check
   * @param {Object[]} recentCandles - Recent candle data
   * @returns {Object[]} Updated order blocks
   */
  updateMitigation(orderBlocks, recentCandles) {
    return orderBlocks.map(ob => {
      if (ob.mitigated) return ob;

      let maxPenetration = 0;
      let wasRetested = false;
      let candlesSinceFormation = 0;
      let candlesInZone = 0;

      for (const candle of recentCandles) {
        if (candle.timestamp <= ob.timestamp) continue;

        // Count candles since OB formation
        candlesSinceFormation++;

        // Check if candle traded inside OB zone (any overlap)
        const insideZone = candle.low <= ob.high && candle.high >= ob.low;
        if (insideZone) {
          candlesInZone++;
        }

        if (ob.type === 'bullish') {
          // Bullish OB (demand zone) - check if price came down into it
          if (candle.low <= ob.high) {
            wasRetested = true;
            const penetration = Math.min(ob.high - candle.low, ob.size);
            maxPenetration = Math.max(maxPenetration, penetration / ob.size);
          }
        } else {
          // Bearish OB (supply zone) - check if price came up into it
          if (candle.high >= ob.low) {
            wasRetested = true;
            const penetration = Math.min(candle.high - ob.low, ob.size);
            maxPenetration = Math.max(maxPenetration, penetration / ob.size);
          }
        }
      }

      // Calculate time-in-zone percentage
      const timeInZonePercent = candlesSinceFormation > 0
        ? candlesInZone / candlesSinceFormation
        : 0;

      // Check if OB should be mitigated
      let mitigated = false;
      let mitigationReason = null;

      if (maxPenetration >= this.options.mitigationThreshold) {
        mitigated = true;
        mitigationReason = 'price_penetration';
      } else if (this.options.timeInZoneFilterEnabled && timeInZonePercent >= this.options.timeInZoneThreshold) {
        mitigated = true;
        mitigationReason = 'time_in_zone';
      }

      return {
        ...ob,
        mitigated: mitigated,
        mitigationPercent: Math.min(maxPenetration, 1.0),
        mitigationReason: mitigationReason,
        retestCount: wasRetested ? ob.retestCount + 1 : ob.retestCount,
        candlesSinceFormation: candlesSinceFormation,
        candlesInZone: candlesInZone,
        timeInZonePercent: timeInZonePercent
      };
    });
  }

  /**
   * Remove duplicate order blocks (same timestamp)
   * @param {Object[]} orderBlocks
   * @returns {Object[]}
   */
  removeDuplicates(orderBlocks) {
    const seen = new Set();
    return orderBlocks.filter(ob => {
      const key = `${ob.timestamp}-${ob.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Get unmitigated order blocks relevant for a trade direction
   * @param {number} currentPrice
   * @param {string} side - 'buy' | 'sell'
   * @returns {Object[]} Relevant active order blocks
   */
  getRelevantOrderBlocks(currentPrice, side) {
    return this.activeOrderBlocks.filter(ob => {
      if (ob.mitigated) return false;

      if (side === 'buy') {
        // For longs, look for bullish OBs (demand zones) BELOW current price
        return ob.type === 'bullish' && ob.high < currentPrice;
      } else {
        // For shorts, look for bearish OBs (supply zones) ABOVE current price
        return ob.type === 'bearish' && ob.low > currentPrice;
      }
    });
  }

  /**
   * Get nearest order block to current price
   * @param {number} currentPrice
   * @param {string} type - 'bullish' | 'bearish' | 'any'
   * @returns {Object|null}
   */
  getNearestOrderBlock(currentPrice, type = 'any') {
    let relevantOBs = this.activeOrderBlocks.filter(ob => !ob.mitigated);

    if (type !== 'any') {
      relevantOBs = relevantOBs.filter(ob => ob.type === type);
    }

    if (relevantOBs.length === 0) return null;

    return relevantOBs.reduce((nearest, ob) => {
      const distance = Math.min(
        Math.abs(currentPrice - ob.high),
        Math.abs(currentPrice - ob.low)
      );
      const nearestDistance = nearest
        ? Math.min(Math.abs(currentPrice - nearest.high), Math.abs(currentPrice - nearest.low))
        : Infinity;

      return distance < nearestDistance ? ob : nearest;
    }, null);
  }

  /**
   * Check if price is currently inside an order block
   * @param {number} price
   * @returns {Object|null} The OB that price is inside, or null
   */
  isInsideOrderBlock(price) {
    for (const ob of this.activeOrderBlocks) {
      if (price >= ob.low && price <= ob.high) {
        return ob;
      }
    }
    return null;
  }

  /**
   * Get current state
   * @returns {Object}
   */
  getState() {
    return {
      activeOrderBlocks: this.activeOrderBlocks,
      mitigatedOrderBlocks: this.mitigatedOrderBlocks,
      bullishOBCount: this.activeOrderBlocks.filter(ob => ob.type === 'bullish').length,
      bearishOBCount: this.activeOrderBlocks.filter(ob => ob.type === 'bearish').length
    };
  }
}

export default OrderBlockDetector;
