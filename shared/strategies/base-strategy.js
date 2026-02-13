/**
 * Base Strategy Class
 *
 * Abstract base class that defines the interface for all trading strategies.
 * Ensures consistent implementation between backtesting and live trading.
 */

export class BaseStrategy {
  /**
   * Declare which data sources this strategy requires.
   * Subclasses override; null = use config defaults (backward compatible).
   * Called before instantiation to drive conditional service initialization.
   *
   * @returns {Object|null} Data requirements manifest or null for defaults
   */
  static getDataRequirements() {
    return null;
  }

  constructor(params = {}) {
    this.params = params;
    this.lastSignalTime = 0;
    this.prevCandle = null;
  }

  /**
   * Evaluate if a trading signal should be generated
   *
   * @param {Object} candle - Current candle data { timestamp, open, high, low, close, volume, symbol }
   * @param {Object} prevCandle - Previous candle data (same structure)
   * @param {Object} marketData - Market data including GEX levels, LT levels, etc.
   * @param {Object} options - Additional options like cooldown overrides
   * @returns {Object|null} Signal object or null if no signal
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    throw new Error('evaluateSignal must be implemented by strategy subclass');
  }

  /**
   * Reset strategy state (useful for backtesting)
   */
  reset() {
    this.lastSignalTime = 0;
    this.prevCandle = null;
  }

  /**
   * Convert timestamp to numeric milliseconds
   * @param {number|string} timestamp - Timestamp (number or ISO string)
   * @returns {number} Milliseconds since epoch
   */
  toMs(timestamp) {
    if (typeof timestamp === 'number') return timestamp;
    return new Date(timestamp).getTime();
  }

  /**
   * Check if enough time has passed since last signal (cooldown)
   *
   * @param {number|string} currentTime - Current timestamp (number or ISO string)
   * @param {number} cooldownMs - Cooldown period in milliseconds
   * @returns {boolean} True if cooldown has passed
   */
  checkCooldown(currentTime, cooldownMs) {
    const currentMs = this.toMs(currentTime);
    return (currentMs - this.lastSignalTime) >= cooldownMs;
  }

  /**
   * Update the last signal time
   *
   * @param {number|string} timestamp - Signal timestamp (number or ISO string)
   */
  updateLastSignalTime(timestamp) {
    this.lastSignalTime = this.toMs(timestamp);
  }

  /**
   * Validate required market data fields
   *
   * @param {Object} marketData - Market data object
   * @param {string[]} requiredFields - Array of required field names
   * @returns {boolean} True if all required fields are present
   */
  validateMarketData(marketData, requiredFields) {
    if (!marketData) return false;

    return requiredFields.every(field => {
      const value = this.getNestedProperty(marketData, field);
      return value !== null && value !== undefined;
    });
  }

  /**
   * Get nested property from object using dot notation
   *
   * @param {Object} obj - Object to search
   * @param {string} path - Dot-separated path (e.g., 'gex.putWall')
   * @returns {*} Property value or undefined
   */
  getNestedProperty(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Calculate risk in points between entry and stop price
   *
   * @param {number} entryPrice - Entry price
   * @param {number} stopPrice - Stop loss price
   * @returns {number} Risk in points
   */
  calculateRisk(entryPrice, stopPrice) {
    return Math.abs(entryPrice - stopPrice);
  }
}

export default BaseStrategy;