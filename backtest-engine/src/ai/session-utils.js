/**
 * Session time helpers for futures trading.
 * All times in Eastern Time (ET). Handles EST/EDT automatically.
 */

// ET offset helpers — we compute from UTC using Intl to handle DST
const ET_TZ = 'America/New_York';

function toET(timestamp) {
  const d = new Date(timestamp);
  // Get the ET date parts
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find(p => p.type === type)?.value;
  return {
    year: parseInt(get('year')),
    month: parseInt(get('month')),
    day: parseInt(get('day')),
    hour: parseInt(get('hour') === '24' ? '0' : get('hour')),
    minute: parseInt(get('minute')),
    second: parseInt(get('second')),
  };
}

function etToUTC(year, month, day, hour, minute = 0, second = 0) {
  // Build a date string and parse it in ET
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  // Use a temp date to find the UTC offset for this ET time
  // Intl trick: format a known UTC date in ET to find offset
  const tempUTC = new Date(`${dateStr}Z`);
  const etFormatted = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(tempUTC);

  const getNum = (type) => parseInt(etFormatted.find(p => p.type === type)?.value || '0');
  const etHour = getNum('hour') === 24 ? 0 : getNum('hour');
  const etMinute = getNum('minute');

  // Offset = ET_time - UTC_time (in minutes)
  const utcMinutes = tempUTC.getUTCHours() * 60 + tempUTC.getUTCMinutes();
  const etMinutes = etHour * 60 + etMinute;
  let offsetMinutes = etMinutes - utcMinutes;
  // Handle day boundary wrapping
  if (offsetMinutes > 720) offsetMinutes -= 1440;
  if (offsetMinutes < -720) offsetMinutes += 1440;

  // Target UTC = desired ET - offset
  const targetMs = tempUTC.getTime() - (offsetMinutes * 60000);
  // Verify by round-tripping
  return targetMs;
}

/**
 * Session boundaries (all in ET):
 * - Overnight: 18:00 (prev day) - 08:29
 * - Premarket: 08:30 - 09:29
 * - RTH:       09:30 - 16:00
 * - Afterhours: 16:01 - 17:59
 */

export function getSessionInfo(timestamp) {
  const et = toET(timestamp);
  const totalMinutes = et.hour * 60 + et.minute;

  if (totalMinutes >= 570 && totalMinutes < 960) {
    // 09:30 - 16:00
    return { session: 'rth', et };
  } else if (totalMinutes >= 510 && totalMinutes < 570) {
    // 08:30 - 09:29
    return { session: 'premarket', et };
  } else if (totalMinutes >= 960 && totalMinutes < 1080) {
    // 16:00 - 17:59
    return { session: 'afterhours', et };
  } else {
    // 18:00 - 08:29 (overnight)
    return { session: 'overnight', et };
  }
}

export function isRTH(timestamp) {
  return getSessionInfo(timestamp).session === 'rth';
}

export function isPremarket(timestamp) {
  return getSessionInfo(timestamp).session === 'premarket';
}

export function isOvernight(timestamp) {
  return getSessionInfo(timestamp).session === 'overnight';
}

/**
 * Get RTH open time (09:30 ET) for a given date.
 * @param {string|Date} date - Date string (YYYY-MM-DD) or Date object
 * @returns {number} Millisecond timestamp
 */
export function getRTHOpenTime(date) {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00Z') : new Date(date);
  const et = toET(d.getTime());
  return etToUTC(et.year, et.month, et.day, 9, 30);
}

/**
 * Get RTH close time (16:00 ET) for a given date.
 * @param {string|Date} date - Date string (YYYY-MM-DD) or Date object
 * @returns {number} Millisecond timestamp
 */
export function getRTHCloseTime(date) {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00Z') : new Date(date);
  const et = toET(d.getTime());
  return etToUTC(et.year, et.month, et.day, 16, 0);
}

/**
 * Get overnight start time (18:00 ET prior day).
 * @param {string|Date} date - The trading day date
 * @returns {number} Millisecond timestamp for 18:00 ET the day before
 */
export function getOvernightStartTime(date) {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00Z') : new Date(date);
  const et = toET(d.getTime());
  // Go back one day
  const prevDay = new Date(Date.UTC(et.year, et.month - 1, et.day - 1, 12));
  const prevET = toET(prevDay.getTime());
  return etToUTC(prevET.year, prevET.month, prevET.day, 18, 0);
}

/**
 * Check if a date is a weekday (Mon-Fri). Does not check market holidays.
 * @param {string|Date} date - Date to check
 * @returns {boolean}
 */
export function isTradingDay(date) {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00Z') : new Date(date);
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * Format a timestamp as ET string for display.
 * @param {number} timestamp - Millisecond timestamp
 * @returns {string} e.g. "09:30:00 ET"
 */
export function formatET(timestamp) {
  const et = toET(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(et.hour)}:${pad(et.minute)}:${pad(et.second)} ET`;
}

/**
 * Format a timestamp as ET date + time.
 * @param {number} timestamp - Millisecond timestamp
 * @returns {string} e.g. "2025-06-12 09:30 ET"
 */
export function formatETDateTime(timestamp) {
  const et = toET(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${et.year}-${pad(et.month)}-${pad(et.day)} ${pad(et.hour)}:${pad(et.minute)} ET`;
}

/**
 * Get trading dates between start and end (inclusive), weekdays only.
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {string[]} Array of YYYY-MM-DD date strings
 */
export function getTradingDays(startDate, endDate) {
  const days = [];
  const current = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');

  while (current <= end) {
    if (isTradingDay(current)) {
      days.push(current.toISOString().slice(0, 10));
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

/**
 * Get morning session end (11:00 ET) for a given date.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {number} Millisecond timestamp
 */
export function getMorningSessionEnd(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const et = toET(d.getTime());
  return etToUTC(et.year, et.month, et.day, 11, 0);
}

/**
 * Get afternoon session start (13:00 ET) for a given date.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {number} Millisecond timestamp
 */
export function getAfternoonSessionStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const et = toET(d.getTime());
  return etToUTC(et.year, et.month, et.day, 13, 0);
}

/**
 * Check if timestamp falls within active trading windows (08:30-11:00 or 13:00-16:00 ET).
 * @param {number} timestamp - Millisecond timestamp
 * @returns {boolean}
 */
export function isInTradingWindow(timestamp) {
  const et = toET(timestamp);
  const totalMinutes = et.hour * 60 + et.minute;
  // Morning: 08:30 (510) - 11:00 (660)
  // Afternoon: 13:00 (780) - 15:30 (930) — no new entries after 3:30 PM (positions close at 4 PM)
  return (totalMinutes >= 510 && totalMinutes < 660) ||
         (totalMinutes >= 780 && totalMinutes < 930);
}

/**
 * Get the trading window name for a timestamp.
 * @param {number} timestamp - Millisecond timestamp
 * @returns {'morning'|'afternoon'|'midday_break'|'outside'}
 */
export function getTradingWindowName(timestamp) {
  const et = toET(timestamp);
  const totalMinutes = et.hour * 60 + et.minute;
  if (totalMinutes >= 510 && totalMinutes < 660) return 'morning';
  if (totalMinutes >= 660 && totalMinutes < 780) return 'midday_break';
  if (totalMinutes >= 780 && totalMinutes < 930) return 'afternoon';
  return 'outside';
}

export { toET, etToUTC };
