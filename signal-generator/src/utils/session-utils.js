/**
 * Session detection utilities for trading hours
 *
 * RTH (Regular Trading Hours): Mon-Fri, 9:30 AM - 4:00 PM EST
 * Futures session: Sun 6PM - Fri 5PM EST (with daily breaks)
 *
 * Uses Tradier /markets/clock API for holiday-aware market status
 */

/**
 * Tradier Market Clock - caches market status for holiday-aware RTH detection
 */
class TradierMarketClock {
  constructor() {
    this.cache = {
      state: null,        // 'premarket', 'open', 'postmarket', 'closed'
      description: null,
      date: null,
      timestamp: null,
      fetchedAt: null
    };
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
    this.apiBaseUrl = process.env.TRADIER_BASE_URL || 'https://api.tradier.com/v1';
    this.accessToken = process.env.TRADIER_ACCESS_TOKEN;
  }

  /**
   * Check if a market transition (open or close) occurred between two times
   * Market opens at 9:30 AM EST, closes at 4:00 PM EST
   * @param {number} fetchedAt - Timestamp when cache was populated
   * @param {Date} now - Current time
   * @returns {boolean} - True if a market boundary was crossed
   */
  hasMarketTransitionOccurred(fetchedAt, now) {
    // Convert both times to EST
    const fetchedEST = new Date(new Date(fetchedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nowEST = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

    // Only check on weekdays
    const nowDay = nowEST.getDay();
    if (nowDay === 0 || nowDay === 6) return false;

    // Check if we're on the same date - if not, definitely crossed a boundary
    const fetchedDate = fetchedEST.toDateString();
    const nowDate = nowEST.toDateString();
    if (fetchedDate !== nowDate) return true;

    // Market boundaries in decimal time
    const MARKET_OPEN = 9.5;   // 9:30 AM
    const MARKET_CLOSE = 16;   // 4:00 PM

    const fetchedTime = fetchedEST.getHours() + fetchedEST.getMinutes() / 60;
    const nowTime = nowEST.getHours() + nowEST.getMinutes() / 60;

    // Check if we crossed 9:30 AM (fetched before, now at or after)
    if (fetchedTime < MARKET_OPEN && nowTime >= MARKET_OPEN) return true;

    // Check if we crossed 4:00 PM (fetched before, now at or after)
    if (fetchedTime < MARKET_CLOSE && nowTime >= MARKET_CLOSE) return true;

    return false;
  }

  /**
   * Check if cached state is still valid
   * Invalidates cache if a market transition (open/close) occurred since fetch
   */
  isCacheValid() {
    if (!this.cache.fetchedAt) return false;

    const now = Date.now();

    // Check if we've crossed a market boundary since the cache was populated
    if (this.hasMarketTransitionOccurred(this.cache.fetchedAt, new Date(now))) {
      return false;  // Force refresh after market transitions
    }

    return (now - this.cache.fetchedAt) < this.cacheTTL;
  }

  /**
   * Fetch market clock from Tradier API
   */
  async fetchMarketClock() {
    if (!this.accessToken) {
      return null;
    }

    try {
      const response = await fetch(`${this.apiBaseUrl}/markets/clock`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        console.error(`Tradier market clock API error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      if (data.clock) {
        this.cache = {
          state: data.clock.state,
          description: data.clock.description,
          date: data.clock.date,
          timestamp: data.clock.timestamp,
          fetchedAt: Date.now()
        };
        return this.cache;
      }
    } catch (error) {
      console.error('Error fetching Tradier market clock:', error.message);
    }
    return null;
  }

  /**
   * Get current market state (async - fetches if cache expired)
   * @returns {Promise<string|null>} - 'premarket', 'open', 'postmarket', 'closed', or null if unavailable
   */
  async getMarketState() {
    if (!this.isCacheValid()) {
      await this.fetchMarketClock();
    }
    return this.cache.state;
  }

  /**
   * Get cached market state (sync - returns cached value without fetching)
   * @returns {string|null} - Cached state or null if no cache
   */
  getCachedState() {
    return this.cache.state;
  }

  /**
   * Check if options market is currently open (async)
   * Uses Tradier API for holiday awareness
   * @returns {Promise<boolean>} - True if market state is 'open'
   */
  async isOptionsMarketOpen() {
    const state = await this.getMarketState();
    return state === 'open';
  }

  /**
   * Check if options market is open (sync - uses cache only)
   * Falls back to time-based check if no cache
   * @returns {boolean}
   */
  isOptionsMarketOpenCached() {
    if (this.isCacheValid() && this.cache.state) {
      return this.cache.state === 'open';
    }
    // Fallback to time-based check
    return null; // Indicates cache miss - caller should use time-based fallback
  }

  /**
   * Get market description (e.g., "Market is closed for Martin Luther King, Jr. Day")
   */
  getDescription() {
    return this.cache.description;
  }
}

// Singleton instance
export const tradierMarketClock = new TradierMarketClock();

/**
 * Check if the current time is during Regular Trading Hours (RTH)
 * RTH is when options markets are open: Mon-Fri, 9:30 AM - 4:00 PM EST
 * This is the basic time-based check (no holiday awareness)
 *
 * @param {Date} date - Optional date to check (defaults to now)
 * @returns {boolean} - True if within RTH
 */
export function isRTH(date = new Date()) {
  // Convert to EST/EDT (America/New_York handles DST automatically)
  const estString = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const est = new Date(estString);

  const day = est.getDay(); // 0=Sun, 6=Sat
  const hour = est.getHours();
  const min = est.getMinutes();
  const timeDecimal = hour + min / 60;

  // RTH: Mon-Fri (1-5), 9:30 AM (9.5) - 4:00 PM (16.0) EST
  const isWeekday = day >= 1 && day <= 5;
  const isRTHTime = timeDecimal >= 9.5 && timeDecimal < 16;

  return isWeekday && isRTHTime;
}

/**
 * Check if the futures market is open
 * Futures trade Sun 6PM - Fri 5PM EST (with daily breaks 5-6PM EST)
 *
 * @param {Date} date - Optional date to check (defaults to now)
 * @returns {boolean} - True if futures market is open
 */
export function isMarketOpen(date = new Date()) {
  const estString = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const est = new Date(estString);

  const day = est.getDay(); // 0=Sun, 6=Sat
  const hour = est.getHours();

  // Market closed periods:
  // - Saturday all day
  // - Sunday before 6PM
  // - Friday after 5PM
  // - Daily break 5-6PM EST (Mon-Thu)

  if (day === 6) return false; // Saturday - closed
  if (day === 0 && hour < 18) return false; // Sunday before 6PM - closed
  if (day === 5 && hour >= 17) return false; // Friday after 5PM - closed

  // Daily maintenance break 5-6PM EST (Mon-Thu)
  if (day >= 1 && day <= 4 && hour >= 17 && hour < 18) return false;

  return true;
}

/**
 * Get the current session name for logging/display
 *
 * @param {Date} date - Optional date to check (defaults to now)
 * @returns {string} - Session name: 'rth', 'overnight', 'premarket', 'afterhours', or 'closed'
 */
export function getCurrentSession(date = new Date()) {
  const estString = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const est = new Date(estString);

  const day = est.getDay();
  const hour = est.getHours();
  const min = est.getMinutes();
  const timeDecimal = hour + min / 60;

  // Check if market is closed first
  if (!isMarketOpen(date)) {
    return 'closed';
  }

  const isWeekday = day >= 1 && day <= 5;

  if (!isWeekday) {
    return 'overnight'; // Sunday evening
  }

  // Weekday sessions
  if (timeDecimal >= 9.5 && timeDecimal < 16) {
    return 'rth';
  } else if (timeDecimal >= 4 && timeDecimal < 9.5) {
    return 'premarket';
  } else if (timeDecimal >= 16 && timeDecimal < 17) {
    return 'afterhours';
  } else {
    return 'overnight';
  }
}

/**
 * Get time until next RTH open
 *
 * @param {Date} date - Optional date to check (defaults to now)
 * @returns {number} - Milliseconds until RTH opens (0 if currently in RTH)
 */
export function getTimeUntilRTH(date = new Date()) {
  if (isRTH(date)) {
    return 0;
  }

  const estString = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const est = new Date(estString);

  const day = est.getDay();
  const hour = est.getHours();
  const min = est.getMinutes();

  // Calculate days until next weekday 9:30 AM
  let daysToAdd = 0;

  if (day === 0) {
    // Sunday - next RTH is Monday
    daysToAdd = 1;
  } else if (day === 6) {
    // Saturday - next RTH is Monday
    daysToAdd = 2;
  } else if (day === 5 && (hour > 16 || (hour === 16 && min > 0))) {
    // Friday after 4PM - next RTH is Monday
    daysToAdd = 3;
  } else if (hour >= 16) {
    // After 4PM on weekday - next RTH is tomorrow
    daysToAdd = 1;
  }

  // Create target date at 9:30 AM EST
  const target = new Date(est);
  target.setDate(target.getDate() + daysToAdd);
  target.setHours(9, 30, 0, 0);

  return target.getTime() - est.getTime();
}

/**
 * Check if the current time is within GEX calculation hours
 * GEX calculations should run from 9:30 AM to 4:30 PM EST
 * (Options close at 4:15 PM + 15 min CBOE delay = 4:30 PM cutoff)
 *
 * @param {Date} date - Optional date to check (defaults to now)
 * @returns {boolean} - True if within GEX calculation hours
 */
export function isGexCalculationHours(date = new Date()) {
  // Convert to EST/EDT (America/New_York handles DST automatically)
  const estString = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const est = new Date(estString);

  const day = est.getDay(); // 0=Sun, 6=Sat
  const hour = est.getHours();
  const min = est.getMinutes();
  const timeDecimal = hour + min / 60;

  // GEX calculation hours: Mon-Fri, 9:30 AM (9.5) - 4:30 PM (16.5) EST
  const isWeekday = day >= 1 && day <= 5;
  const isGexTime = timeDecimal >= 9.5 && timeDecimal < 16.5;

  return isWeekday && isGexTime;
}

/**
 * Holiday-aware GEX calculation hours check
 * Uses Tradier market clock for holiday awareness, extends RTH by 30 min for CBOE delay
 *
 * @returns {Promise<boolean>} - True if GEX calculations should run
 */
export async function isGexCalculationHoursAsync() {
  // First check Tradier market clock for holiday awareness
  const tradierState = await tradierMarketClock.getMarketState();

  if (tradierState !== null) {
    // During market hours ('open'), always calculate
    if (tradierState === 'open') {
      return true;
    }

    // During 'postmarket' state, check if we're within the 30-min CBOE delay window
    if (tradierState === 'postmarket') {
      return isGexCalculationHours();
    }

    // Other states (premarket, closed) - no GEX calculations
    return false;
  }

  // Fallback to time-based check if Tradier unavailable
  return isGexCalculationHours();
}

/**
 * Holiday-aware RTH check using Tradier market clock
 * This is the preferred method for determining if options are trading
 *
 * @returns {Promise<boolean>} - True if options market is open (RTH and not a holiday)
 */
export async function isOptionsRTH() {
  // First check Tradier market clock for holiday awareness
  const tradierState = await tradierMarketClock.getMarketState();

  if (tradierState !== null) {
    // Tradier API is available - use its authoritative state
    const isOpen = tradierState === 'open';
    if (!isOpen) {
      const desc = tradierMarketClock.getDescription();
      if (desc && desc.includes('holiday')) {
        console.log(`Options market closed: ${desc}`);
      }
    }
    return isOpen;
  }

  // Fallback to time-based check if Tradier unavailable
  console.warn('Tradier market clock unavailable, using time-based RTH check');
  return isRTH();
}

/**
 * Synchronous holiday-aware RTH check using cached Tradier state
 * Use this when you can't await, but call isOptionsRTH() periodically to refresh cache
 *
 * @returns {boolean} - True if options market is open based on cached state
 */
export function isOptionsRTHCached() {
  const cachedState = tradierMarketClock.isOptionsMarketOpenCached();

  if (cachedState !== null) {
    return cachedState;
  }

  // Fallback to time-based check if no cache
  return isRTH();
}

export default {
  isRTH,
  isMarketOpen,
  getCurrentSession,
  getTimeUntilRTH,
  isOptionsRTH,
  isOptionsRTHCached,
  isGexCalculationHours,
  isGexCalculationHoursAsync,
  tradierMarketClock
};
