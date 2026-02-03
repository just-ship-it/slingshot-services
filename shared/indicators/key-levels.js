/**
 * Key Levels Indicator - JavaScript Implementation
 *
 * Identifies high-probability support/resistance levels based on:
 * - Previous day/week/month highs and lows
 * - Overnight and premarket highs/lows
 * - Opening range levels
 * - Session-based highs/lows
 *
 * These levels are critical for identifying liquidity sweep points
 * where stops tend to cluster and reversals often occur.
 */

export class KeyLevelsIndicator {
  constructor(params = {}) {
    this.params = {
      // Time zone settings
      timezone: params.timezone || 'America/New_York',
      marketStart: params.marketStart || '09:30',
      marketEnd: params.marketEnd || '16:00',

      // Level toggles
      enableTodayHL: params.enableTodayHL !== false,
      enableYesterdayHL: params.enableYesterdayHL !== false,
      enablePremarketHL: params.enablePremarketHL !== false,
      enableOvernightHL: params.enableOvernightHL !== false,
      enableOpeningRange: params.enableOpeningRange !== false,
      enableWeekHL: params.enableWeekHL || false,
      enableMonthHL: params.enableMonthHL || false,
      enablePreviousClose: params.enablePreviousClose !== false,

      // Opening range settings
      openingRangeMinutes: params.openingRangeMinutes || 15,

      // Near open settings (minutes before open to track)
      nearOpenMinutes: params.nearOpenMinutes || 60,

      // Lookback periods
      lookbackDays: params.lookbackDays || 5,

      // Level proximity settings (for liquidity sweep detection)
      proximityThreshold: params.proximityThreshold || 5, // Points from level
      minLevelSpacing: params.minLevelSpacing || 10,      // Min points between levels

      ...params
    };

    // State tracking
    this.levels = new Map();
    this.sessions = [];
    this.currentSession = null;
    this.cachedLevels = null;
    this.lastUpdate = null;
  }

  /**
   * Parse time string to minutes since midnight
   */
  timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Check if timestamp is within market hours
   */
  isMarketHours(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const currentMinutes = hours * 60 + minutes;

    // Convert market hours to minutes (EST to UTC adjustment)
    const marketStartMinutes = this.timeToMinutes(this.params.marketStart) + 240; // +4 hours for UTC
    const marketEndMinutes = this.timeToMinutes(this.params.marketEnd) + 240;

    return currentMinutes >= marketStartMinutes && currentMinutes < marketEndMinutes;
  }

  /**
   * Get session type for a timestamp
   */
  getSessionType(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const currentMinutes = hours * 60 + minutes;

    // Define sessions in UTC (EST + 4/5 hours depending on DST)
    const sessions = {
      overnight: { start: 0, end: 360 },      // 00:00-06:00 UTC
      premarket: { start: 360, end: 870 },    // 06:00-14:30 UTC
      market: { start: 870, end: 1260 },      // 14:30-21:00 UTC
      afterhours: { start: 1260, end: 1440 }  // 21:00-24:00 UTC
    };

    for (const [type, range] of Object.entries(sessions)) {
      if (currentMinutes >= range.start && currentMinutes < range.end) {
        return type;
      }
    }

    return 'overnight';
  }

  /**
   * Process candle data to extract key levels
   */
  processCandles(candles) {
    if (!candles || candles.length === 0) return;

    // Group candles by session
    const sessions = this.groupBySession(candles);

    // Calculate levels for each session type
    this.levels.clear();

    // Today's levels
    const todaySession = this.getCurrentDaySession(sessions);
    if (todaySession && this.params.enableTodayHL) {
      this.addLevel('today_high', this.getSessionHigh(todaySession), 'Today High');
      this.addLevel('today_low', this.getSessionLow(todaySession), 'Today Low');
    }

    // Yesterday's levels
    const yesterdaySession = this.getPreviousDaySession(sessions);
    if (yesterdaySession && this.params.enableYesterdayHL) {
      this.addLevel('yesterday_high', this.getSessionHigh(yesterdaySession), 'Yesterday High');
      this.addLevel('yesterday_low', this.getSessionLow(yesterdaySession), 'Yesterday Low');

      if (this.params.enablePreviousClose) {
        this.addLevel('yesterday_close', yesterdaySession.candles[yesterdaySession.candles.length - 1].close, 'Yesterday Close');
      }
    }

    // Premarket levels
    if (this.params.enablePremarketHL) {
      const premarketCandles = this.getSessionTypeCandles(todaySession, 'premarket');
      if (premarketCandles.length > 0) {
        this.addLevel('premarket_high', Math.max(...premarketCandles.map(c => c.high)), 'Premarket High');
        this.addLevel('premarket_low', Math.min(...premarketCandles.map(c => c.low)), 'Premarket Low');
      }
    }

    // Overnight levels
    if (this.params.enableOvernightHL) {
      const overnightCandles = this.getOvernightCandles(sessions);
      if (overnightCandles.length > 0) {
        this.addLevel('overnight_high', Math.max(...overnightCandles.map(c => c.high)), 'Overnight High');
        this.addLevel('overnight_low', Math.min(...overnightCandles.map(c => c.low)), 'Overnight Low');
      }
    }

    // Opening range
    if (this.params.enableOpeningRange && todaySession) {
      const openingCandles = this.getOpeningRangeCandles(todaySession);
      if (openingCandles.length > 0) {
        this.addLevel('opening_range_high', Math.max(...openingCandles.map(c => c.high)), 'Opening Range High');
        this.addLevel('opening_range_low', Math.min(...openingCandles.map(c => c.low)), 'Opening Range Low');
      }
    }

    // Weekly levels
    if (this.params.enableWeekHL) {
      const weekLevels = this.getWeeklyLevels(candles);
      if (weekLevels) {
        this.addLevel('week_high', weekLevels.high, 'Week High');
        this.addLevel('week_low', weekLevels.low, 'Week Low');
      }
    }

    // Monthly levels
    if (this.params.enableMonthHL) {
      const monthLevels = this.getMonthlyLevels(candles);
      if (monthLevels) {
        this.addLevel('month_high', monthLevels.high, 'Month High');
        this.addLevel('month_low', monthLevels.low, 'Month Low');
      }
    }

    this.lastUpdate = Date.now();
  }

  /**
   * Group candles by trading session/day
   */
  groupBySession(candles) {
    const sessions = [];
    let currentSession = null;
    let currentDate = null;

    for (const candle of candles) {
      const date = new Date(candle.timestamp);
      const dateStr = date.toISOString().split('T')[0];

      if (dateStr !== currentDate) {
        if (currentSession) {
          sessions.push(currentSession);
        }
        currentSession = {
          date: dateStr,
          candles: [],
          marketCandles: [],
          premarketCandles: [],
          overnightCandles: []
        };
        currentDate = dateStr;
      }

      if (currentSession) {
        currentSession.candles.push(candle);

        const sessionType = this.getSessionType(candle.timestamp);
        switch (sessionType) {
          case 'market':
            currentSession.marketCandles.push(candle);
            break;
          case 'premarket':
            currentSession.premarketCandles.push(candle);
            break;
          case 'overnight':
            currentSession.overnightCandles.push(candle);
            break;
        }
      }
    }

    if (currentSession) {
      sessions.push(currentSession);
    }

    return sessions;
  }

  /**
   * Get current day's session
   */
  getCurrentDaySession(sessions) {
    return sessions[sessions.length - 1];
  }

  /**
   * Get previous day's session
   */
  getPreviousDaySession(sessions) {
    return sessions[sessions.length - 2];
  }

  /**
   * Get session high
   */
  getSessionHigh(session) {
    if (!session || !session.marketCandles || session.marketCandles.length === 0) {
      return null;
    }
    return Math.max(...session.marketCandles.map(c => c.high));
  }

  /**
   * Get session low
   */
  getSessionLow(session) {
    if (!session || !session.marketCandles || session.marketCandles.length === 0) {
      return null;
    }
    return Math.min(...session.marketCandles.map(c => c.low));
  }

  /**
   * Get candles for specific session type
   */
  getSessionTypeCandles(session, type) {
    if (!session) return [];

    switch (type) {
      case 'market':
        return session.marketCandles || [];
      case 'premarket':
        return session.premarketCandles || [];
      case 'overnight':
        return session.overnightCandles || [];
      default:
        return [];
    }
  }

  /**
   * Get overnight candles (from previous close to current open)
   */
  getOvernightCandles(sessions) {
    if (sessions.length < 2) return [];

    const todaySession = sessions[sessions.length - 1];
    const yesterdaySession = sessions[sessions.length - 2];

    // Combine yesterday's after-hours with today's overnight/premarket
    const overnightCandles = [];

    // Get candles after yesterday's market close
    if (yesterdaySession) {
      const lastMarketTime = yesterdaySession.marketCandles[yesterdaySession.marketCandles.length - 1]?.timestamp;
      if (lastMarketTime) {
        overnightCandles.push(...yesterdaySession.candles.filter(c => c.timestamp > lastMarketTime));
      }
    }

    // Add today's overnight candles
    if (todaySession) {
      overnightCandles.push(...todaySession.overnightCandles);
    }

    return overnightCandles;
  }

  /**
   * Get opening range candles
   */
  getOpeningRangeCandles(session) {
    if (!session || !session.marketCandles || session.marketCandles.length === 0) {
      return [];
    }

    const firstMarketCandle = session.marketCandles[0];
    const openingEndTime = firstMarketCandle.timestamp + this.params.openingRangeMinutes * 60000;

    return session.marketCandles.filter(c => c.timestamp <= openingEndTime);
  }

  /**
   * Get weekly high/low
   */
  getWeeklyLevels(candles) {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
    weekStart.setHours(0, 0, 0, 0);

    const weekCandles = candles.filter(c => c.timestamp >= weekStart.getTime());

    if (weekCandles.length === 0) return null;

    return {
      high: Math.max(...weekCandles.map(c => c.high)),
      low: Math.min(...weekCandles.map(c => c.low))
    };
  }

  /**
   * Get monthly high/low
   */
  getMonthlyLevels(candles) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthCandles = candles.filter(c => c.timestamp >= monthStart.getTime());

    if (monthCandles.length === 0) return null;

    return {
      high: Math.max(...monthCandles.map(c => c.high)),
      low: Math.min(...monthCandles.map(c => c.low))
    };
  }

  /**
   * Add a level to the collection
   */
  addLevel(id, price, description) {
    if (price === null || price === undefined || isNaN(price)) return;

    this.levels.set(id, {
      id,
      price: Math.round(price * 4) / 4, // Round to nearest 0.25
      description,
      timestamp: Date.now(),
      touches: 0,
      lastTouch: null
    });
  }

  /**
   * Get all current levels
   */
  getLevels() {
    return Array.from(this.levels.values()).sort((a, b) => b.price - a.price);
  }

  /**
   * Get levels within proximity of a price
   */
  getNearbyLevels(price, threshold = null) {
    const proximityThreshold = threshold || this.params.proximityThreshold;
    return this.getLevels().filter(level =>
      Math.abs(level.price - price) <= proximityThreshold
    );
  }

  /**
   * Check if price is near a key level (potential liquidity sweep)
   */
  checkLiquiditySweep(candle) {
    const sweeps = [];

    for (const level of this.levels.values()) {
      const distance = Math.min(
        Math.abs(candle.high - level.price),
        Math.abs(candle.low - level.price)
      );

      // Check if candle swept through level
      if (candle.high > level.price && candle.low < level.price) {
        sweeps.push({
          level: level,
          type: 'pierce',
          distance: 0,
          candle: candle
        });
        level.touches++;
        level.lastTouch = candle.timestamp;
      }
      // Check if candle touched level from above
      else if (candle.low <= level.price + this.params.proximityThreshold &&
               candle.low >= level.price - this.params.proximityThreshold) {
        sweeps.push({
          level: level,
          type: 'touch_from_above',
          distance: distance,
          candle: candle
        });
        level.touches++;
        level.lastTouch = candle.timestamp;
      }
      // Check if candle touched level from below
      else if (candle.high >= level.price - this.params.proximityThreshold &&
               candle.high <= level.price + this.params.proximityThreshold) {
        sweeps.push({
          level: level,
          type: 'touch_from_below',
          distance: distance,
          candle: candle
        });
        level.touches++;
        level.lastTouch = candle.timestamp;
      }
    }

    return sweeps;
  }

  /**
   * Identify potential reversal levels based on liquidity clustering
   */
  getReversalLevels(currentPrice) {
    const levels = this.getLevels();
    const reversalLevels = [];

    for (const level of levels) {
      // Calculate score based on multiple factors
      let score = 0;

      // Level importance (type of level)
      if (level.id.includes('yesterday')) score += 30;
      if (level.id.includes('week')) score += 20;
      if (level.id.includes('month')) score += 15;
      if (level.id.includes('overnight')) score += 25;
      if (level.id.includes('premarket')) score += 25;
      if (level.id.includes('opening_range')) score += 20;

      // Number of recent touches (level defense)
      score += Math.min(level.touches * 10, 30);

      // Distance from current price (prefer nearby levels)
      const distance = Math.abs(currentPrice - level.price);
      if (distance <= 50) {
        score += (50 - distance) / 2;
      }

      // Check for level clustering (multiple levels near each other)
      const nearbyLevels = levels.filter(l =>
        l.id !== level.id &&
        Math.abs(l.price - level.price) <= this.params.minLevelSpacing
      );
      score += nearbyLevels.length * 15;

      reversalLevels.push({
        ...level,
        score,
        distance,
        clusterSize: nearbyLevels.length + 1,
        nearbyLevels
      });
    }

    // Sort by score descending
    return reversalLevels.sort((a, b) => b.score - a.score);
  }

  /**
   * Get summary of current key levels for logging/display
   */
  getSummary() {
    const levels = this.getLevels();

    return {
      timestamp: this.lastUpdate,
      levelCount: levels.length,
      levels: levels.map(l => ({
        id: l.id,
        price: l.price,
        description: l.description,
        touches: l.touches
      }))
    };
  }
}

export default KeyLevelsIndicator;