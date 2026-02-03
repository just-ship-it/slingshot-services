/**
 * Session Tracker
 *
 * Tracks trading session boundaries and classifies timestamps.
 * Handles DST transitions correctly for US Eastern Time.
 *
 * Sessions (all times in EST/EDT):
 * - Overnight: 6:00 PM - 8:00 AM
 * - Premarket: 8:00 AM - 9:30 AM
 * - RTH (Regular Trading Hours): 9:30 AM - 4:00 PM
 * - Afterhours: 4:00 PM - 6:00 PM
 */

/**
 * Check if a date is in US Daylight Saving Time
 * DST starts second Sunday of March at 2 AM
 * DST ends first Sunday of November at 2 AM
 * @param {Date} date - Date to check
 * @returns {boolean} True if in DST
 */
function isUSEasternDST(date) {
  const year = date.getUTCFullYear();

  // Find second Sunday of March
  let marchSecondSunday = new Date(Date.UTC(year, 2, 1)); // March 1
  let sundayCount = 0;
  while (sundayCount < 2) {
    if (marchSecondSunday.getUTCDay() === 0) sundayCount++;
    if (sundayCount < 2) marchSecondSunday.setUTCDate(marchSecondSunday.getUTCDate() + 1);
  }
  // DST starts at 2 AM EST = 7 AM UTC
  const dstStart = new Date(Date.UTC(year, 2, marchSecondSunday.getUTCDate(), 7));

  // Find first Sunday of November
  let novFirstSunday = new Date(Date.UTC(year, 10, 1)); // November 1
  while (novFirstSunday.getUTCDay() !== 0) {
    novFirstSunday.setUTCDate(novFirstSunday.getUTCDate() + 1);
  }
  // DST ends at 2 AM EDT = 6 AM UTC
  const dstEnd = new Date(Date.UTC(year, 10, novFirstSunday.getUTCDate(), 6));

  return date >= dstStart && date < dstEnd;
}

/**
 * Convert UTC timestamp to Eastern time components
 * @param {number|Date} timestamp - UTC timestamp or Date
 * @returns {Object} { hour, minute, timeInMinutes, isDST, estOffset }
 */
export function toEasternTime(timestamp) {
  const date = new Date(timestamp);
  const isDST = isUSEasternDST(date);
  const estOffset = isDST ? 4 : 5; // EDT = UTC-4, EST = UTC-5

  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();

  let estHour = utcHour - estOffset;
  let estDay = date.getUTCDay();

  if (estHour < 0) {
    estHour += 24;
    estDay = (estDay - 1 + 7) % 7;
  }

  return {
    hour: estHour,
    minute: utcMinute,
    timeInMinutes: estHour * 60 + utcMinute,
    day: estDay,
    isDST,
    estOffset,
    date: date
  };
}

/**
 * Session definitions in Eastern Time minutes from midnight
 */
const SESSION_BOUNDARIES = {
  overnight: { start: 18 * 60, end: 8 * 60 },      // 6:00 PM - 8:00 AM (wraps midnight)
  premarket: { start: 8 * 60, end: 9 * 60 + 30 },  // 8:00 AM - 9:30 AM
  rth: { start: 9 * 60 + 30, end: 16 * 60 },       // 9:30 AM - 4:00 PM
  afterhours: { start: 16 * 60, end: 18 * 60 }     // 4:00 PM - 6:00 PM
};

/**
 * Get the session for a given timestamp
 * @param {number|Date} timestamp - Timestamp to classify
 * @returns {string} Session name: 'overnight', 'premarket', 'rth', 'afterhours'
 */
export function getSession(timestamp) {
  const et = toEasternTime(timestamp);
  const time = et.timeInMinutes;

  if (time >= SESSION_BOUNDARIES.rth.start && time < SESSION_BOUNDARIES.rth.end) {
    return 'rth';
  } else if (time >= SESSION_BOUNDARIES.premarket.start && time < SESSION_BOUNDARIES.premarket.end) {
    return 'premarket';
  } else if (time >= SESSION_BOUNDARIES.afterhours.start && time < SESSION_BOUNDARIES.afterhours.end) {
    return 'afterhours';
  } else {
    return 'overnight';
  }
}

/**
 * Get day of week name
 * @param {number|Date} timestamp - Timestamp
 * @returns {string} Day name
 */
export function getDayOfWeek(timestamp) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const date = new Date(timestamp);
  return days[date.getUTCDay()];
}

/**
 * Check if timestamp is during weekend (closed market)
 * Futures close Friday 5 PM ET, reopen Sunday 6 PM ET
 * @param {number|Date} timestamp - Timestamp to check
 * @returns {boolean} True if market is closed for weekend
 */
export function isWeekend(timestamp) {
  const et = toEasternTime(timestamp);
  const day = et.day;
  const time = et.timeInMinutes;

  // Saturday all day
  if (day === 6) return true;

  // Friday after 5 PM
  if (day === 5 && time >= 17 * 60) return true;

  // Sunday before 6 PM
  if (day === 0 && time < 18 * 60) return true;

  return false;
}

/**
 * Session Tracker Class
 * Tracks session-based high/low/open levels
 */
export class SessionTracker {
  constructor() {
    this.currentSession = null;
    this.currentDate = null;

    // Current session tracking
    this.sessionHigh = null;
    this.sessionLow = null;
    this.sessionOpen = null;

    // Overnight tracking
    this.overnightHigh = null;
    this.overnightLow = null;
    this.overnightOpen = null;

    // Premarket tracking
    this.premarketHigh = null;
    this.premarketLow = null;
    this.premarketOpen = null;

    // RTH tracking (current day)
    this.rthOpen = null;
    this.rthHigh = null;
    this.rthLow = null;

    // Yesterday's RTH levels
    this.yesterdayHigh = null;
    this.yesterdayLow = null;
    this.yesterdayClose = null;

    // Weekly tracking
    this.weeklyOpen = null;
    this.weeklyHigh = null;
    this.weeklyLow = null;

    // Daily open (first price of RTH)
    this.dailyOpen = null;

    // Track if this is first data point
    this.initialized = false;
    this.lastTimestamp = null;
  }

  /**
   * Process a candle and update tracked levels
   * @param {Object} candle - Candle with { timestamp, open, high, low, close }
   * @returns {Object} Current level state
   */
  processCandle(candle) {
    const { timestamp, open, high, low, close } = candle;
    const session = getSession(timestamp);
    const et = toEasternTime(timestamp);
    const dateStr = this.getDateString(timestamp);

    // Check for session transition
    if (this.currentSession !== session) {
      this.onSessionChange(this.currentSession, session, timestamp);
      this.currentSession = session;
    }

    // Check for date transition (RTH day boundary)
    if (this.currentDate !== dateStr && session === 'rth') {
      this.onDateChange(dateStr, timestamp);
      this.currentDate = dateStr;
    }

    // Check for week transition (Monday RTH open)
    if (session === 'rth' && et.day === 1 && this.weeklyOpen === null) {
      this.weeklyOpen = open;
      this.weeklyHigh = high;
      this.weeklyLow = low;
    }

    // Update session-specific levels
    this.updateSessionLevels(session, candle);

    // Track first data point
    if (!this.initialized) {
      this.initialized = true;
      this.sessionOpen = open;
    }

    this.lastTimestamp = timestamp;

    return this.getLevels();
  }

  /**
   * Handle session transition
   * @param {string} fromSession - Previous session
   * @param {string} toSession - New session
   * @param {number} timestamp - Transition timestamp
   */
  onSessionChange(fromSession, toSession, timestamp) {
    // Transitioning into overnight - reset overnight tracking
    if (toSession === 'overnight') {
      this.overnightHigh = null;
      this.overnightLow = null;
      this.overnightOpen = null;
    }

    // Transitioning into premarket - reset premarket tracking
    if (toSession === 'premarket') {
      this.premarketHigh = null;
      this.premarketLow = null;
      this.premarketOpen = null;
    }

    // Transitioning into RTH - save yesterday's levels if we have them
    if (toSession === 'rth') {
      if (this.rthHigh !== null && this.rthLow !== null) {
        this.yesterdayHigh = this.rthHigh;
        this.yesterdayLow = this.rthLow;
        this.yesterdayClose = this.rthClose;
      }

      // Reset RTH tracking for new day
      this.rthOpen = null;
      this.rthHigh = null;
      this.rthLow = null;
      this.rthClose = null;
      this.dailyOpen = null;
    }

    // Transitioning out of RTH - capture closing price
    if (fromSession === 'rth') {
      // rthClose is already set by updateSessionLevels
    }
  }

  /**
   * Handle date transition
   * @param {string} newDate - New date string
   * @param {number} timestamp - Transition timestamp
   */
  onDateChange(newDate, timestamp) {
    const et = toEasternTime(timestamp);

    // Check for week transition (new week starts Monday RTH)
    if (et.day === 1) {
      this.weeklyOpen = null;
      this.weeklyHigh = null;
      this.weeklyLow = null;
    }
  }

  /**
   * Update levels for the current session
   * @param {string} session - Current session
   * @param {Object} candle - Current candle
   */
  updateSessionLevels(session, candle) {
    const { open, high, low, close } = candle;

    switch (session) {
      case 'overnight':
        if (this.overnightOpen === null) this.overnightOpen = open;
        if (this.overnightHigh === null || high > this.overnightHigh) this.overnightHigh = high;
        if (this.overnightLow === null || low < this.overnightLow) this.overnightLow = low;
        break;

      case 'premarket':
        if (this.premarketOpen === null) this.premarketOpen = open;
        if (this.premarketHigh === null || high > this.premarketHigh) this.premarketHigh = high;
        if (this.premarketLow === null || low < this.premarketLow) this.premarketLow = low;
        break;

      case 'rth':
        if (this.rthOpen === null) {
          this.rthOpen = open;
          this.dailyOpen = open;
        }
        if (this.rthHigh === null || high > this.rthHigh) this.rthHigh = high;
        if (this.rthLow === null || low < this.rthLow) this.rthLow = low;
        this.rthClose = close; // Always update to latest close
        break;

      case 'afterhours':
        // Afterhours doesn't have separate tracking in this implementation
        break;
    }

    // Update weekly levels if set
    if (this.weeklyOpen !== null) {
      if (high > this.weeklyHigh) this.weeklyHigh = high;
      if (low < this.weeklyLow) this.weeklyLow = low;
    }

    // Update general session tracking
    if (this.sessionOpen === null) this.sessionOpen = open;
    if (this.sessionHigh === null || high > this.sessionHigh) this.sessionHigh = high;
    if (this.sessionLow === null || low < this.sessionLow) this.sessionLow = low;
  }

  /**
   * Get date string for a timestamp (EST date)
   * @param {number} timestamp - Timestamp
   * @returns {string} YYYY-MM-DD format
   */
  getDateString(timestamp) {
    const et = toEasternTime(timestamp);
    const date = new Date(timestamp);

    // Adjust for EST/EDT
    const estDate = new Date(date.getTime() - (et.estOffset * 60 * 60 * 1000));

    const year = estDate.getUTCFullYear();
    const month = String(estDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(estDate.getUTCDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  /**
   * Get all current levels
   * @returns {Object} All tracked levels
   */
  getLevels() {
    return {
      // Daily levels
      dailyOpen: this.dailyOpen,

      // Yesterday's levels
      yesterdayHigh: this.yesterdayHigh,
      yesterdayLow: this.yesterdayLow,
      yesterdayClose: this.yesterdayClose,

      // Overnight levels
      overnightHigh: this.overnightHigh,
      overnightLow: this.overnightLow,
      overnightOpen: this.overnightOpen,

      // Premarket levels
      premarketHigh: this.premarketHigh,
      premarketLow: this.premarketLow,
      premarketOpen: this.premarketOpen,

      // RTH levels
      rthOpen: this.rthOpen,
      rthHigh: this.rthHigh,
      rthLow: this.rthLow,

      // Weekly levels
      weeklyOpen: this.weeklyOpen,
      weeklyHigh: this.weeklyHigh,
      weeklyLow: this.weeklyLow,

      // Current session
      currentSession: this.currentSession
    };
  }

  /**
   * Reset all tracking state
   */
  reset() {
    this.currentSession = null;
    this.currentDate = null;
    this.sessionHigh = null;
    this.sessionLow = null;
    this.sessionOpen = null;
    this.overnightHigh = null;
    this.overnightLow = null;
    this.overnightOpen = null;
    this.premarketHigh = null;
    this.premarketLow = null;
    this.premarketOpen = null;
    this.rthOpen = null;
    this.rthHigh = null;
    this.rthLow = null;
    this.yesterdayHigh = null;
    this.yesterdayLow = null;
    this.yesterdayClose = null;
    this.weeklyOpen = null;
    this.weeklyHigh = null;
    this.weeklyLow = null;
    this.dailyOpen = null;
    this.initialized = false;
    this.lastTimestamp = null;
  }
}

export default SessionTracker;
