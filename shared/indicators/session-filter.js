/**
 * SessionFilter
 *
 * Filters trading sessions and manages indicator resets at session boundaries.
 * Properly handles daylight saving time by converting to Eastern Time.
 *
 * Allowed Sessions (all times in ET, handles EST/EDT automatically):
 * - RTH (Regular Trading Hours): 9:30 AM - 4:00 PM ET
 * - Premarket: 4:00 AM - 9:30 AM ET
 * - Aftermarket/Transition: 4:00 PM - 6:00 PM ET (low liquidity)
 * - Overnight: 6:00 PM - 4:00 AM ET next day
 */

export class SessionFilter {
  constructor(params = {}) {
    this.params = {
      allowRTH: params.allowRTH !== undefined ? params.allowRTH : true,
      allowOvernight: params.allowOvernight !== undefined ? params.allowOvernight : true,
      allowPremarket: params.allowPremarket || false,
      allowAftermarket: params.allowAftermarket || false,
      ...params
    };

    this.lastSession = null;
  }

  /**
   * Get Eastern Time (ET) hours and minutes from a timestamp
   * Handles EST/EDT automatically via toLocaleString
   *
   * @param {Date} date - Date object
   * @returns {Object} { hour: number, minute: number, timeInMinutes: number }
   */
  getEasternTime(date) {
    const etString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = etString.split(':');
    const hour = parseInt(hourStr);
    const minute = parseInt(minStr);
    return {
      hour,
      minute,
      timeInMinutes: hour * 60 + minute
    };
  }

  /**
   * Determine if timestamp is in an allowed trading session
   *
   * @param {string|Date|number} timestamp - Timestamp to check
   * @returns {Object} { allowed: boolean, session: string }
   */
  isAllowedSession(timestamp) {
    const date = new Date(timestamp);
    const { hour, minute, timeInMinutes } = this.getEasternTime(date);

    // Session boundaries in Eastern Time (minutes from midnight)
    const rthStart = 9 * 60 + 30;    // 9:30 AM ET = 570 minutes
    const rthEnd = 16 * 60;          // 4:00 PM ET = 960 minutes
    const overnightStart = 18 * 60;  // 6:00 PM ET = 1080 minutes
    const premarketStart = 4 * 60;   // 4:00 AM ET = 240 minutes

    // RTH: 9:30 AM - 4:00 PM ET
    if (timeInMinutes >= rthStart && timeInMinutes < rthEnd) {
      return {
        allowed: this.params.allowRTH,
        session: 'rth',
        sessionStart: rthStart,
        sessionEnd: rthEnd
      };
    }

    // Premarket: 4:00 AM - 9:30 AM ET
    if (timeInMinutes >= premarketStart && timeInMinutes < rthStart) {
      return {
        allowed: this.params.allowPremarket,
        session: 'premarket',
        sessionStart: premarketStart,
        sessionEnd: rthStart
      };
    }

    // Overnight: 6:00 PM - 4:00 AM ET (wraps around midnight)
    if (timeInMinutes >= overnightStart || timeInMinutes < premarketStart) {
      return {
        allowed: this.params.allowOvernight,
        session: 'overnight',
        sessionStart: overnightStart,
        sessionEnd: premarketStart
      };
    }

    // Aftermarket / Transition: 4:00 PM - 6:00 PM ET
    if (timeInMinutes >= rthEnd && timeInMinutes < overnightStart) {
      return {
        allowed: this.params.allowAftermarket,
        session: 'transition',
        sessionStart: rthEnd,
        sessionEnd: overnightStart
      };
    }

    // Fallback (should not reach here)
    return {
      allowed: false,
      session: 'unknown',
      sessionStart: null,
      sessionEnd: null
    };
  }

  /**
   * Check if indicators should be reset due to session change
   *
   * @param {string|Date|number} currentTimestamp - Current candle timestamp
   * @param {string|Date|number} lastTimestamp - Previous candle timestamp
   * @returns {boolean} True if session changed and reset needed
   */
  shouldResetIndicators(currentTimestamp, lastTimestamp) {
    if (!lastTimestamp) return false;

    const current = this.isAllowedSession(currentTimestamp);
    const last = this.isAllowedSession(lastTimestamp);

    // Reset when session changes
    return current.session !== last.session;
  }

  /**
   * Get session information for a timestamp
   *
   * @param {string|Date|number} timestamp - Timestamp to check
   * @returns {Object} Session details
   */
  getSessionInfo(timestamp) {
    const sessionData = this.isAllowedSession(timestamp);
    const date = new Date(timestamp);
    const { hour, minute } = this.getEasternTime(date);

    return {
      ...sessionData,
      timestamp: date.toISOString(),
      hour,     // Eastern Time hour
      minute    // Eastern Time minute
    };
  }

  /**
   * Check if current timestamp represents start of new session
   *
   * @param {string|Date|number} currentTimestamp
   * @returns {boolean}
   */
  isSessionStart(currentTimestamp) {
    const current = this.isAllowedSession(currentTimestamp);

    if (this.lastSession === null) {
      this.lastSession = current.session;
      return true;
    }

    const isNewSession = current.session !== this.lastSession;
    this.lastSession = current.session;

    return isNewSession;
  }

  /**
   * Get minutes into current session
   *
   * @param {string|Date|number} timestamp
   * @returns {number} Minutes since session start
   */
  getMinutesIntoSession(timestamp) {
    const date = new Date(timestamp);
    const { timeInMinutes } = this.getEasternTime(date);
    const session = this.isAllowedSession(timestamp);

    if (!session.sessionStart) return 0;

    // Handle overnight session wrapping around midnight
    if (session.session === 'overnight' && timeInMinutes < session.sessionStart) {
      // Past midnight - add 24 hours worth of minutes
      return (1440 - session.sessionStart) + timeInMinutes;
    }

    return timeInMinutes - session.sessionStart;
  }

  /**
   * Reset internal state
   */
  reset() {
    this.lastSession = null;
  }
}
