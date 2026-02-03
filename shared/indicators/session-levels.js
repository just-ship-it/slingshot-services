/**
 * Session Level Tracker
 *
 * Tracks key levels from different trading sessions:
 * - Previous day high/low/close
 * - Overnight high/low (4 PM - 9:30 AM ET)
 * - Premarket high/low (4 AM - 9:30 AM ET)
 * - Opening range levels
 *
 * These levels often act as key support/resistance and are ideal
 * for pullback entries in the two-tier system.
 */

export class SessionLevelTracker {
  constructor(options = {}) {
    this.options = {
      timezone: options.timezone || 'America/New_York', // ET timezone
      rthStart: options.rthStart || 9.5,    // 9:30 AM ET
      rthEnd: options.rthEnd || 16,         // 4:00 PM ET
      premarketStart: options.premarketStart || 4,     // 4:00 AM ET
      openingRangeMinutes: options.openingRangeMinutes || 30, // First 30 min of RTH
      levelTouchDistance: options.levelTouchDistance || 3,    // Points for level interaction
      maxLevelAge: options.maxLevelAge || 24,                 // Hours before level expires
      ...options
    };

    // Storage for session levels
    this.sessionLevels = {
      previousDay: {},
      overnight: {},
      premarket: {},
      openingRange: {},
      currentDay: {}
    };

    // Track current session state
    this.currentSession = null;
    this.sessionStartTime = null;
    this.sessionData = {};
  }

  /**
   * Process candle data and update session levels
   */
  processCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return this.sessionLevels;
    }

    // Scan historical data to find previous day's session levels
    this.scanForPreviousDayLevels(candles);

    // Process each candle to detect session changes and update levels
    candles.forEach(candle => {
      this.processCandle(candle);
    });

    // Update level metrics and clean up stale levels
    this.updateLevelMetrics(candles);
    this.cleanupStaleLevels();

    return this.getActiveLevels();
  }

  /**
   * Scan candle history to find previous day's session levels
   * This mimics the Pine Script logic that looks through previous trading session data
   */
  scanForPreviousDayLevels(candles) {
    if (candles.length < 50) return; // Need sufficient history

    // Get current day for comparison
    const currentCandle = candles[candles.length - 1];
    const currentDate = new Date(currentCandle.timestamp);
    currentDate.setHours(0, 0, 0, 0); // Start of current day

    // Find previous trading day's session
    let previousTradingDay = null;
    let dayOffset = 1;

    while (!previousTradingDay && dayOffset <= 7) { // Look back up to 7 days
      const testDate = new Date(currentDate);
      testDate.setDate(testDate.getDate() - dayOffset);

      // Check if this was a trading day (skip weekends)
      const dayOfWeek = testDate.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Not Sunday or Saturday
        const dayCandles = this.getCandlesForTradingDay(candles, testDate);
        if (dayCandles.length > 0) {
          previousTradingDay = {
            date: testDate,
            candles: dayCandles
          };
          break;
        }
      }
      dayOffset++;
    }

    if (previousTradingDay) {
      // Scan previous trading day's RTH session to find high/low
      const rthCandles = previousTradingDay.candles.filter(candle => {
        const hour = new Date(candle.timestamp).getHours() + new Date(candle.timestamp).getMinutes() / 60;
        return hour >= this.options.rthStart && hour < this.options.rthEnd;
      });

      if (rthCandles.length > 0) {
        const previousDayHigh = Math.max(...rthCandles.map(c => c.high));
        const previousDayLow = Math.min(...rthCandles.map(c => c.low));
        const previousDayOpen = rthCandles[0].open;
        const previousDayClose = rthCandles[rthCandles.length - 1].close;

        // Store previous day levels with high strength
        this.sessionLevels.previousDay = {
          high: {
            price: previousDayHigh,
            type: 'resistance',
            session: 'previousDay',
            startTime: previousTradingDay.date.getTime(),
            strength: 90, // High strength for previous day levels
            source: 'yesterday_high'
          },
          low: {
            price: previousDayLow,
            type: 'support',
            session: 'previousDay',
            startTime: previousTradingDay.date.getTime(),
            strength: 90, // High strength for previous day levels
            source: 'yesterday_low'
          },
          open: {
            price: previousDayOpen,
            type: 'pivot',
            session: 'previousDay',
            startTime: previousTradingDay.date.getTime(),
            strength: 70,
            source: 'yesterday_open'
          },
          close: {
            price: previousDayClose,
            type: 'pivot',
            session: 'previousDay',
            startTime: previousTradingDay.date.getTime(),
            strength: 85,
            source: 'yesterday_close'
          }
        };
      }
    }
  }

  /**
   * Get candles for a specific trading day
   */
  getCandlesForTradingDay(candles, targetDate) {
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    return candles.filter(candle => {
      const candleDate = new Date(candle.timestamp);
      return candleDate >= startOfDay && candleDate <= endOfDay;
    });
  }

  /**
   * Process individual candle
   */
  processCandle(candle) {
    const candleTime = new Date(candle.timestamp);
    const session = this.identifySession(candleTime);

    // Detect session changes
    if (session !== this.currentSession) {
      this.onSessionChange(session, candleTime, candle);
    }

    // Update current session data
    this.updateSessionData(session, candle);

    this.currentSession = session;
  }

  /**
   * Identify which session a candle belongs to
   */
  identifySession(date) {
    const hour = date.getHours() + date.getMinutes() / 60;

    if (hour >= this.options.rthStart && hour < this.options.rthEnd) {
      return 'rth';
    } else if (hour >= this.options.premarketStart && hour < this.options.rthStart) {
      return 'premarket';
    } else {
      return 'overnight';
    }
  }

  /**
   * Handle session change events
   */
  onSessionChange(newSession, time, candle) {
    // Finalize previous session levels
    if (this.currentSession && this.sessionData.high && this.sessionData.low) {
      this.finalizeSessionLevels(this.currentSession, this.sessionData, time);
    }

    // Initialize new session
    this.sessionStartTime = time;
    this.sessionData = {
      high: candle.high,
      low: candle.low,
      open: candle.open,
      close: candle.close,
      startTime: time.getTime(),
      candles: []
    };

    // console.log(`Session change: ${this.currentSession} -> ${newSession} at ${time.toISOString()}`);
  }

  /**
   * Update current session data
   */
  updateSessionData(session, candle) {
    if (!this.sessionData) return;

    this.sessionData.high = Math.max(this.sessionData.high, candle.high);
    this.sessionData.low = Math.min(this.sessionData.low, candle.low);
    this.sessionData.close = candle.close;
    this.sessionData.candles.push(candle);

    // Update opening range for RTH session
    if (session === 'rth') {
      const sessionDuration = (candle.timestamp - this.sessionData.startTime) / (1000 * 60);
      if (sessionDuration <= this.options.openingRangeMinutes) {
        if (!this.sessionLevels.openingRange.high || candle.high > this.sessionLevels.openingRange.high) {
          this.sessionLevels.openingRange.high = candle.high;
        }
        if (!this.sessionLevels.openingRange.low || candle.low < this.sessionLevels.openingRange.low) {
          this.sessionLevels.openingRange.low = candle.low;
        }
      }
    }
  }

  /**
   * Finalize session levels when session ends
   */
  finalizeSessionLevels(session, sessionData, endTime) {
    const levels = {
      high: {
        price: sessionData.high,
        type: 'resistance',
        session: session,
        startTime: sessionData.startTime,
        endTime: endTime.getTime(),
        touches: 1,
        lastTouch: sessionData.startTime,
        strength: this.calculateSessionLevelStrength(sessionData, 'high')
      },
      low: {
        price: sessionData.low,
        type: 'support',
        session: session,
        startTime: sessionData.startTime,
        endTime: endTime.getTime(),
        touches: 1,
        lastTouch: sessionData.startTime,
        strength: this.calculateSessionLevelStrength(sessionData, 'low')
      },
      open: {
        price: sessionData.open,
        type: 'pivot',
        session: session,
        startTime: sessionData.startTime,
        endTime: endTime.getTime(),
        touches: 1,
        lastTouch: sessionData.startTime,
        strength: 50 // Base strength for open levels
      },
      close: {
        price: sessionData.close,
        type: 'pivot',
        session: session,
        startTime: sessionData.startTime,
        endTime: endTime.getTime(),
        touches: 1,
        lastTouch: sessionData.startTime,
        strength: 75 // Higher strength for close levels
      }
    };

    // Store levels based on session type
    switch (session) {
      case 'overnight':
        this.sessionLevels.overnight = levels;
        break;
      case 'premarket':
        this.sessionLevels.premarket = levels;
        break;
      case 'rth':
        // RTH close becomes previous day levels for next day
        this.sessionLevels.previousDay = levels;
        // Reset opening range for next day
        this.sessionLevels.openingRange = {};
        break;
    }

    // console.log(`Finalized ${session} levels: H:${levels.high.price} L:${levels.low.price} O:${levels.open.price} C:${levels.close.price}`);
  }

  /**
   * Calculate strength of session level based on price action
   */
  calculateSessionLevelStrength(sessionData, levelType) {
    if (!sessionData.candles || sessionData.candles.length === 0) {
      return 50; // Default strength
    }

    const levelPrice = sessionData[levelType];
    let strength = 0;
    let touches = 0;

    sessionData.candles.forEach(candle => {
      const distance = Math.abs(levelPrice - (levelType === 'high' ? candle.high : candle.low));

      if (distance <= this.options.levelTouchDistance) {
        touches++;
        strength += 20; // Base points for each touch
      }

      // Add strength based on how much level was respected
      if (levelType === 'high') {
        strength += Math.max(0, levelPrice - candle.close) * 0.1;
      } else {
        strength += Math.max(0, candle.close - levelPrice) * 0.1;
      }
    });

    return Math.min(100, strength + touches * 15); // Cap at 100
  }

  /**
   * Update level metrics (touches, age, etc.)
   */
  updateLevelMetrics(recentCandles) {
    const recent = recentCandles.slice(-50); // Last 50 candles

    Object.keys(this.sessionLevels).forEach(sessionType => {
      const sessionLevels = this.sessionLevels[sessionType];

      Object.keys(sessionLevels).forEach(levelType => {
        const level = sessionLevels[levelType];
        if (!level || !level.price) return;

        // Count recent touches
        let touches = level.touches || 0;
        let lastTouch = level.lastTouch;

        recent.forEach(candle => {
          const priceToCheck = level.type === 'support' ? candle.low :
                               level.type === 'resistance' ? candle.high : candle.close;

          const distance = Math.abs(level.price - priceToCheck);

          if (distance <= this.options.levelTouchDistance) {
            touches++;
            lastTouch = Math.max(lastTouch, candle.timestamp);
          }
        });

        level.touches = touches;
        level.lastTouch = lastTouch;

        // Calculate age
        const ageHours = (Date.now() - level.lastTouch) / (1000 * 60 * 60);
        level.ageHours = ageHours;
        level.isFresh = ageHours <= this.options.maxLevelAge;
      });
    });
  }

  /**
   * Clean up stale levels
   */
  cleanupStaleLevels() {
    Object.keys(this.sessionLevels).forEach(sessionType => {
      const sessionLevels = this.sessionLevels[sessionType];

      Object.keys(sessionLevels).forEach(levelType => {
        const level = sessionLevels[levelType];
        if (level && level.ageHours > this.options.maxLevelAge) {
          delete sessionLevels[levelType];
        }
      });
    });
  }

  /**
   * Get all active session levels
   */
  getActiveLevels() {
    const activeLevels = [];

    Object.keys(this.sessionLevels).forEach(sessionType => {
      const sessionLevels = this.sessionLevels[sessionType];

      Object.keys(sessionLevels).forEach(levelType => {
        const level = sessionLevels[levelType];

        if (level && level.price && level.isFresh) {
          activeLevels.push({
            ...level,
            sessionType,
            levelType,
            relevanceScore: this.calculateRelevanceScore(level, sessionType, levelType)
          });
        }
      });
    });

    return activeLevels.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Calculate relevance score for level prioritization
   */
  calculateRelevanceScore(level, sessionType, levelType) {
    let score = 0;

    // Base strength
    score += level.strength * 0.5;

    // Touch count
    score += level.touches * 15;

    // Freshness (inverse of age)
    score += (this.options.maxLevelAge - level.ageHours) * 2;

    // Session importance weights
    const sessionWeights = {
      previousDay: 2.0,    // Previous day levels are very important
      overnight: 1.5,      // Overnight levels are important
      premarket: 1.2,      // Premarket levels are moderately important
      openingRange: 1.8,   // Opening range levels are very important
      currentDay: 1.0      // Current day levels baseline
    };

    score *= sessionWeights[sessionType] || 1.0;

    // Level type importance
    const levelTypeWeights = {
      high: 1.3,    // Highs are important resistance
      low: 1.3,     // Lows are important support
      close: 1.1,   // Close levels are important
      open: 0.9     // Open levels less important
    };

    score *= levelTypeWeights[levelType] || 1.0;

    return score;
  }

  /**
   * Get pullback levels for specific trade direction
   */
  getPullbackLevels(currentPrice, tradeDirection, maxDistance = 100) {
    const activeLevels = this.getActiveLevels();

    return activeLevels.filter(level => {
      // For pullback entries:
      // Buy signals look for support levels BELOW current price to pullback to
      // Sell signals look for resistance levels ABOVE current price to pullback to

      if (tradeDirection === 'buy') {
        // For buy signals, look for support levels below current price
        return level.type === 'support' && level.price < currentPrice;
      } else if (tradeDirection === 'sell') {
        // For sell signals, look for resistance levels above current price
        return level.type === 'resistance' && level.price > currentPrice;
      }

      return false;
    }).map(level => ({
      ...level,
      distance: Math.abs(level.price - currentPrice),
      pullbackDistance: Math.abs(currentPrice - level.price),
      description: `${level.sessionType} ${level.levelType} (${level.session || 'session'})`
    })).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Get levels near current price
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
      description: `${level.sessionType} ${level.levelType}`
    })).sort((a, b) => a.distance - b.distance);
  }

  /**
   * Check if a level has been swept recently
   */
  hasLevelBeenSwept(level, recentCandles, sweepBuffer = 2) {
    if (!recentCandles || recentCandles.length === 0) return false;

    return recentCandles.some(candle => {
      if (level.type === 'support' || level.levelType === 'low') {
        return candle.low <= level.price - sweepBuffer;
      } else if (level.type === 'resistance' || level.levelType === 'high') {
        return candle.high >= level.price + sweepBuffer;
      }
      return false;
    });
  }

  /**
   * Get current session info
   */
  getCurrentSessionInfo() {
    return {
      currentSession: this.currentSession,
      sessionStartTime: this.sessionStartTime?.toISOString(),
      sessionData: {
        high: this.sessionData?.high,
        low: this.sessionData?.low,
        open: this.sessionData?.open,
        close: this.sessionData?.close
      }
    };
  }

  /**
   * Get debug information
   */
  getDebugInfo() {
    return {
      currentSession: this.currentSession,
      totalLevels: this.getActiveLevels().length,
      sessionLevels: Object.keys(this.sessionLevels).map(sessionType => ({
        session: sessionType,
        levels: Object.keys(this.sessionLevels[sessionType]).map(levelType => ({
          type: levelType,
          price: this.sessionLevels[sessionType][levelType]?.price,
          strength: this.sessionLevels[sessionType][levelType]?.strength,
          touches: this.sessionLevels[sessionType][levelType]?.touches,
          ageHours: this.sessionLevels[sessionType][levelType]?.ageHours?.toFixed(1)
        }))
      })),
      activeLevels: this.getActiveLevels().length
    };
  }
}