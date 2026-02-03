/**
 * Level Tracker
 *
 * Tracks price levels from multiple sources:
 * - GEX levels (Support 1-3, Resistance 1-3, Gamma Flip)
 * - Session levels (PDH, PDL, PDC, ONH, ONL)
 *
 * Used by the LDPM Level Sweep strategy for sweep detection.
 */

export class LevelTracker {
  constructor(params = {}) {
    this.params = {
      rthStartHour: params.rthStartHour || 14.5,      // 9:30 AM EST in UTC
      rthEndHour: params.rthEndHour || 21,            // 4:00 PM EST in UTC
      overnightStartHour: params.overnightStartHour || 21, // 4:00 PM EST in UTC
      levelAgeLimit: params.levelAgeLimit || 2,       // Days before level expires
      ...params
    };

    // Store all tracked levels
    this.levels = new Map();

    // Session tracking
    this.previousDayData = null;
    this.currentDayData = null;
    this.overnightData = null;
    this.lastProcessedDate = null;
  }

  /**
   * Update all tracked levels
   * @param {Object} gexLevels - GEX levels from gexLoader
   * @param {Object[]} ohlcvHistory - Recent OHLCV candles for session level calculation
   * @param {number} timestamp - Current timestamp
   * @returns {Object[]} Array of tracked levels sorted by price
   */
  updateLevels(gexLevels, ohlcvHistory, timestamp) {
    const currentTime = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

    // Clear and rebuild
    this.levels.clear();

    // Add GEX levels
    if (gexLevels) {
      this.addGexLevels(gexLevels, currentTime);
    }

    // Calculate and add session levels from OHLCV history
    if (ohlcvHistory && ohlcvHistory.length > 0) {
      this.updateSessionLevels(ohlcvHistory, currentTime);
    }

    return this.getAllLevels();
  }

  /**
   * Add GEX levels to tracker
   * @param {Object} gexLevels - GEX levels data
   * @param {number} timestamp - Current timestamp
   */
  addGexLevels(gexLevels, timestamp) {
    // Support levels
    if (gexLevels.support && Array.isArray(gexLevels.support)) {
      gexLevels.support.forEach((price, idx) => {
        if (price !== null && price !== undefined && !isNaN(price)) {
          this.addLevel({
            id: `gex_support_${idx + 1}`,
            price,
            type: 'support',
            source: 'gex',
            name: `GEX S${idx + 1}`,
            strength: 90 - (idx * 10),
            timestamp
          });
        }
      });
    }

    // Resistance levels
    if (gexLevels.resistance && Array.isArray(gexLevels.resistance)) {
      gexLevels.resistance.forEach((price, idx) => {
        if (price !== null && price !== undefined && !isNaN(price)) {
          this.addLevel({
            id: `gex_resistance_${idx + 1}`,
            price,
            type: 'resistance',
            source: 'gex',
            name: `GEX R${idx + 1}`,
            strength: 90 - (idx * 10),
            timestamp
          });
        }
      });
    }

    // Gamma flip - neutral level
    if (gexLevels.gamma_flip !== null && gexLevels.gamma_flip !== undefined) {
      this.addLevel({
        id: 'gex_gamma_flip',
        price: gexLevels.gamma_flip,
        type: 'neutral',
        source: 'gex',
        name: 'Gamma Flip',
        strength: 95,
        timestamp
      });
    }

    // Put wall (if different from support[0])
    if (gexLevels.put_wall !== null && gexLevels.put_wall !== undefined) {
      const s1 = gexLevels.support?.[0];
      if (!s1 || Math.abs(gexLevels.put_wall - s1) > 1) {
        this.addLevel({
          id: 'gex_put_wall',
          price: gexLevels.put_wall,
          type: 'support',
          source: 'gex',
          name: 'Put Wall',
          strength: 92,
          timestamp
        });
      }
    }

    // Call wall (if different from resistance[0])
    if (gexLevels.call_wall !== null && gexLevels.call_wall !== undefined) {
      const r1 = gexLevels.resistance?.[0];
      if (!r1 || Math.abs(gexLevels.call_wall - r1) > 1) {
        this.addLevel({
          id: 'gex_call_wall',
          price: gexLevels.call_wall,
          type: 'resistance',
          source: 'gex',
          name: 'Call Wall',
          strength: 92,
          timestamp
        });
      }
    }
  }

  /**
   * Update session-based levels from OHLCV data
   * @param {Object[]} candles - OHLCV candles
   * @param {number} currentTime - Current timestamp
   */
  updateSessionLevels(candles, currentTime) {
    const currentDate = new Date(currentTime);
    const currentDateStr = currentDate.toISOString().split('T')[0];

    // Check if we need to recalculate session levels
    if (this.lastProcessedDate !== currentDateStr) {
      this.calculateSessionLevels(candles, currentTime);
      this.lastProcessedDate = currentDateStr;
    }

    // Add session levels
    if (this.previousDayData) {
      if (this.previousDayData.high !== null) {
        this.addLevel({
          id: 'session_pdh',
          price: this.previousDayData.high,
          type: 'resistance',
          source: 'session',
          name: 'PDH',
          strength: 85,
          timestamp: currentTime
        });
      }

      if (this.previousDayData.low !== null) {
        this.addLevel({
          id: 'session_pdl',
          price: this.previousDayData.low,
          type: 'support',
          source: 'session',
          name: 'PDL',
          strength: 85,
          timestamp: currentTime
        });
      }

      if (this.previousDayData.close !== null) {
        this.addLevel({
          id: 'session_pdc',
          price: this.previousDayData.close,
          type: 'neutral',
          source: 'session',
          name: 'PDC',
          strength: 80,
          timestamp: currentTime
        });
      }
    }

    if (this.overnightData) {
      if (this.overnightData.high !== null) {
        this.addLevel({
          id: 'session_onh',
          price: this.overnightData.high,
          type: 'resistance',
          source: 'session',
          name: 'ONH',
          strength: 75,
          timestamp: currentTime
        });
      }

      if (this.overnightData.low !== null) {
        this.addLevel({
          id: 'session_onl',
          price: this.overnightData.low,
          type: 'support',
          source: 'session',
          name: 'ONL',
          strength: 75,
          timestamp: currentTime
        });
      }
    }
  }

  /**
   * Calculate session levels from OHLCV history
   * @param {Object[]} candles - OHLCV candles sorted by timestamp
   * @param {number} currentTime - Current timestamp
   */
  calculateSessionLevels(candles, currentTime) {
    if (!candles || candles.length === 0) return;

    const currentDate = new Date(currentTime);
    currentDate.setUTCHours(0, 0, 0, 0);
    const todayStart = currentDate.getTime();

    // Find previous trading day
    const previousDayStart = todayStart - (24 * 60 * 60 * 1000);
    const twoDaysAgo = previousDayStart - (24 * 60 * 60 * 1000);

    // Get previous day RTH candles (9:30 AM - 4:00 PM EST)
    const prevDayRTHCandles = candles.filter(c => {
      const candleTime = typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime();
      const candleDate = new Date(candleTime);
      const hour = candleDate.getUTCHours() + candleDate.getUTCMinutes() / 60;

      return candleTime >= previousDayStart &&
             candleTime < todayStart &&
             hour >= this.params.rthStartHour &&
             hour < this.params.rthEndHour;
    });

    if (prevDayRTHCandles.length > 0) {
      this.previousDayData = {
        high: Math.max(...prevDayRTHCandles.map(c => c.high)),
        low: Math.min(...prevDayRTHCandles.map(c => c.low)),
        open: prevDayRTHCandles[0].open,
        close: prevDayRTHCandles[prevDayRTHCandles.length - 1].close
      };
    }

    // Get overnight candles (4:00 PM previous day - 9:30 AM today)
    const overnightCandles = candles.filter(c => {
      const candleTime = typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime();
      const candleDate = new Date(candleTime);
      const hour = candleDate.getUTCHours() + candleDate.getUTCMinutes() / 60;

      // Previous day after RTH close
      const prevDayAfterClose = candleTime >= previousDayStart &&
                                 candleTime < todayStart &&
                                 hour >= this.params.overnightStartHour;

      // Today before RTH open
      const todayBeforeOpen = candleTime >= todayStart &&
                               candleTime <= currentTime &&
                               hour < this.params.rthStartHour;

      return prevDayAfterClose || todayBeforeOpen;
    });

    if (overnightCandles.length > 0) {
      this.overnightData = {
        high: Math.max(...overnightCandles.map(c => c.high)),
        low: Math.min(...overnightCandles.map(c => c.low))
      };
    }
  }

  /**
   * Add a level to the tracker
   * @param {Object} level - Level object
   */
  addLevel(level) {
    // Avoid duplicate levels at same price
    for (const [id, existing] of this.levels) {
      if (Math.abs(existing.price - level.price) < 0.5) {
        // Keep the one with higher strength
        if (level.strength > existing.strength) {
          this.levels.delete(id);
        } else {
          return; // Keep existing
        }
      }
    }

    this.levels.set(level.id, level);
  }

  /**
   * Get all tracked levels sorted by price
   * @returns {Object[]} Array of level objects
   */
  getAllLevels() {
    return Array.from(this.levels.values())
      .sort((a, b) => a.price - b.price);
  }

  /**
   * Get levels by type
   * @param {string} type - Level type ('support', 'resistance', 'neutral')
   * @returns {Object[]} Array of matching levels
   */
  getLevelsByType(type) {
    return this.getAllLevels().filter(l => l.type === type);
  }

  /**
   * Get levels by source
   * @param {string} source - Level source ('gex', 'session')
   * @returns {Object[]} Array of matching levels
   */
  getLevelsBySource(source) {
    return this.getAllLevels().filter(l => l.source === source);
  }

  /**
   * Get levels near a price
   * @param {number} price - Reference price
   * @param {number} distance - Maximum distance in points
   * @returns {Object[]} Array of nearby levels
   */
  getLevelsNear(price, distance = 10) {
    return this.getAllLevels()
      .filter(l => Math.abs(l.price - price) <= distance)
      .map(l => ({
        ...l,
        distance: Math.abs(l.price - price),
        direction: l.price > price ? 'above' : 'below'
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * Get support levels below a price
   * @param {number} price - Reference price
   * @returns {Object[]} Array of support levels below price
   */
  getSupportLevelsBelow(price) {
    return this.getAllLevels()
      .filter(l => (l.type === 'support' || l.type === 'neutral') && l.price < price)
      .sort((a, b) => b.price - a.price); // Highest first
  }

  /**
   * Get resistance levels above a price
   * @param {number} price - Reference price
   * @returns {Object[]} Array of resistance levels above price
   */
  getResistanceLevelsAbove(price) {
    return this.getAllLevels()
      .filter(l => (l.type === 'resistance' || l.type === 'neutral') && l.price > price)
      .sort((a, b) => a.price - b.price); // Lowest first
  }

  /**
   * Clear all levels
   */
  reset() {
    this.levels.clear();
    this.previousDayData = null;
    this.currentDayData = null;
    this.overnightData = null;
    this.lastProcessedDate = null;
  }

  /**
   * Get debug info
   * @returns {Object} Debug information
   */
  getDebugInfo() {
    return {
      totalLevels: this.levels.size,
      gexLevels: this.getLevelsBySource('gex').length,
      sessionLevels: this.getLevelsBySource('session').length,
      supportLevels: this.getLevelsByType('support').length,
      resistanceLevels: this.getLevelsByType('resistance').length,
      previousDayData: this.previousDayData,
      overnightData: this.overnightData
    };
  }
}

export default LevelTracker;
