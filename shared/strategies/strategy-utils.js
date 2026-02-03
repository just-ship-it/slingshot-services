/**
 * Strategy Utilities
 *
 * Common utility functions used across trading strategies
 */

/**
 * Check if price crossed below a level between two candles
 *
 * @param {Object} prevCandle - Previous candle
 * @param {Object} currentCandle - Current candle
 * @param {number} level - Price level to check
 * @returns {boolean} True if price crossed below the level
 */
export function didCrossBelowLevel(prevCandle, currentCandle, level) {
  if (!prevCandle || !currentCandle || level === null || level === undefined) {
    return false;
  }

  return prevCandle.close >= level && currentCandle.close < level;
}

/**
 * Check if price crossed above a level between two candles
 *
 * @param {Object} prevCandle - Previous candle
 * @param {Object} currentCandle - Current candle
 * @param {number} level - Price level to check
 * @returns {boolean} True if price crossed above the level
 */
export function didCrossAboveLevel(prevCandle, currentCandle, level) {
  if (!prevCandle || !currentCandle || level === null || level === undefined) {
    return false;
  }

  return prevCandle.close <= level && currentCandle.close > level;
}

/**
 * Count how many levels in an array are below a given price
 *
 * @param {number[]} levels - Array of price levels
 * @param {number} price - Price to compare against
 * @returns {number} Count of levels below the price
 */
export function countLevelsBelow(levels, price) {
  if (!Array.isArray(levels) || price === null || price === undefined) {
    return 0;
  }

  return levels.filter(level => level !== null && level !== undefined && level < price).length;
}

/**
 * Count how many levels in an array are above a given price
 *
 * @param {number[]} levels - Array of price levels
 * @param {number} price - Price to compare against
 * @returns {number} Count of levels above the price
 */
export function countLevelsAbove(levels, price) {
  if (!Array.isArray(levels) || price === null || price === undefined) {
    return 0;
  }

  return levels.filter(level => level !== null && level !== undefined && level > price).length;
}

/**
 * Find the closest level to a given price
 *
 * @param {number[]} levels - Array of price levels
 * @param {number} price - Reference price
 * @returns {number|null} Closest level or null if no valid levels
 */
export function findClosestLevel(levels, price) {
  if (!Array.isArray(levels) || price === null || price === undefined) {
    return null;
  }

  const validLevels = levels.filter(level => level !== null && level !== undefined);
  if (validLevels.length === 0) {
    return null;
  }

  return validLevels.reduce((closest, level) => {
    const currentDistance = Math.abs(level - price);
    const closestDistance = Math.abs(closest - price);
    return currentDistance < closestDistance ? level : closest;
  });
}

/**
 * Check if current time is within trading session
 *
 * @param {number} timestamp - Current timestamp (Unix milliseconds)
 * @param {number} startHour - Session start hour (24-hour format, EST)
 * @param {number} endHour - Session end hour (24-hour format, EST)
 * @returns {boolean} True if within session hours
 */
export function isWithinSession(timestamp, startHour, endHour) {
  const date = new Date(timestamp);
  const hour = date.getUTCHours() - 5; // Convert to EST (approximate)

  // Handle session that crosses midnight (e.g., 18:00 to 16:00 next day)
  if (startHour > endHour) {
    return hour >= startHour || hour < endHour;
  }

  return hour >= startHour && hour < endHour;
}

/**
 * Convert timestamp to readable string
 *
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted date string
 */
export function formatTimestamp(timestamp) {
  return new Date(timestamp).toISOString();
}

/**
 * Calculate percentage change between two prices
 *
 * @param {number} oldPrice - Previous price
 * @param {number} newPrice - Current price
 * @returns {number} Percentage change
 */
export function calculatePercentChange(oldPrice, newPrice) {
  if (!oldPrice || oldPrice === 0) return 0;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

/**
 * Round to specified decimal places
 *
 * @param {number} number - Number to round
 * @param {number} decimals - Number of decimal places
 * @returns {number} Rounded number
 */
export function roundTo(number, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(number * factor) / factor;
}

/**
 * Round price to NQ tick size (0.25 increments)
 *
 * @param {number} price - Price to round
 * @returns {number} Price rounded to nearest 0.25 tick
 */
export function roundToNQTick(price) {
  return Math.round(price * 4) / 4;
}

/**
 * Validate candle data structure
 *
 * @param {Object} candle - Candle object to validate
 * @returns {boolean} True if valid candle
 */
export function isValidCandle(candle) {
  if (!candle || typeof candle !== 'object') return false;

  // Check numeric fields
  const numericFields = ['open', 'high', 'low', 'close', 'volume'];
  const numericValid = numericFields.every(field => {
    const value = candle[field];
    return value !== null && value !== undefined && !isNaN(value);
  });

  // Check timestamp separately - can be number or valid date string
  const timestamp = candle.timestamp;
  const timestampValid = timestamp !== null && timestamp !== undefined &&
    (typeof timestamp === 'number' || !isNaN(new Date(timestamp).getTime()));

  return numericValid && timestampValid;
}

/**
 * Calculate distance between two price levels
 *
 * @param {number} price1 - First price
 * @param {number} price2 - Second price
 * @returns {number} Absolute distance between prices
 */
export function calculateDistance(price1, price2) {
  if (price1 === null || price1 === undefined || price2 === null || price2 === undefined) {
    return Infinity;
  }
  return Math.abs(price1 - price2);
}

/**
 * Check if timestamp is within a specific time window
 *
 * @param {number} timestamp - Timestamp to check
 * @param {number} startHour - Start hour (0-23, UTC)
 * @param {number} endHour - End hour (0-23, UTC)
 * @param {number} startMinute - Start minute (0-59)
 * @param {number} endMinute - End minute (0-59)
 * @returns {boolean} True if within time window
 */
export function isWithinTimeWindow(timestamp, startHour, endHour, startMinute = 0, endMinute = 0) {
  const date = new Date(timestamp);
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();

  const currentTime = hours * 60 + minutes;
  const startTime = startHour * 60 + startMinute;
  const endTime = endHour * 60 + endMinute;

  // Handle time window that crosses midnight
  if (startTime > endTime) {
    return currentTime >= startTime || currentTime <= endTime;
  }

  return currentTime >= startTime && currentTime <= endTime;
}