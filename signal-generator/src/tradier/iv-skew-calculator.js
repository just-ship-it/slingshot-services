import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';

const logger = createLogger('iv-skew-calculator');

/**
 * IV Skew Calculator
 *
 * Calculates ATM implied volatility skew from options chain data.
 * Skew = putIV - callIV
 *
 * - Negative skew = calls expensive = bullish flow/positioning
 * - Positive skew = puts expensive = bearish hedging/fear
 *
 * Based on academic research:
 * - Kolm/Turiel/Westray 2023: Order flow imbalance shows 60-65% directional accuracy
 * - Muravyev et al: Options contribute ~25% of price discovery
 */
class IVSkewCalculator {
  constructor(options = {}) {
    this.symbol = options.symbol || 'QQQ';
    this.publishToRedis = options.publishToRedis !== false;

    // Minimum DTE filter - backtest data uses 7+ DTE exclusively
    // 0-DTE options have massively inflated IV that doesn't match backtest conditions
    this.minDTE = options.minDTE ?? 7;

    // Current IV skew data
    this.currentSkew = null;

    // History for smoothing (optional)
    this.skewHistory = [];
    this.maxHistoryLength = options.maxHistoryLength || 10;
  }

  /**
   * Calculate ATM IV skew from options chain data
   *
   * @param {number} spotPrice - Current underlying spot price
   * @param {Object} chainsData - Options chains data from Tradier
   * @returns {Object} IV skew data
   */
  calculateIVSkew(spotPrice, chainsData) {
    if (!spotPrice || !chainsData) {
      logger.warn('Missing spotPrice or chainsData for IV skew calculation');
      return null;
    }

    // Get chains for our symbol
    const chains = chainsData[this.symbol];
    if (!chains || chains.length === 0) {
      logger.warn(`No chains data found for ${this.symbol}`);
      return null;
    }

    // Find ATM strike (closest to spot price)
    const atmStrike = this.findATMStrike(spotPrice, chains);
    if (!atmStrike) {
      logger.warn(`Could not find ATM strike for ${this.symbol} at spot ${spotPrice}`);
      return null;
    }

    // Get call and put IV at ATM strike (use shortest expiration >= minDTE)
    const { callIV, putIV, expiration, callOI, putOI, dte } = this.getATMIVData(atmStrike, chains);

    if (callIV === null || putIV === null) {
      logger.warn(`Could not find ATM call/put IV for ${this.symbol} at strike ${atmStrike} (minDTE=${this.minDTE})`);
      return null;
    }

    // Calculate skew: putIV - callIV
    // Negative = calls expensive (bullish flow)
    // Positive = puts expensive (bearish hedging)
    const skew = putIV - callIV;

    // Calculate average IV (useful for minIV filter)
    const iv = (callIV + putIV) / 2;

    const skewData = {
      timestamp: new Date().toISOString(),
      symbol: this.symbol,
      spotPrice,
      atmStrike,
      expiration,
      dte,
      callIV,
      putIV,
      iv,
      skew,
      callOI,
      putOI,
      // Interpretation
      signal: this.interpretSkew(skew)
    };

    // Update current skew
    this.currentSkew = skewData;

    // Add to history
    this.skewHistory.push(skewData);
    if (this.skewHistory.length > this.maxHistoryLength) {
      this.skewHistory.shift();
    }

    logger.info(`📊 IV Skew: ${this.symbol} @ ${spotPrice.toFixed(2)} | ` +
      `ATM=${atmStrike} (${dte}DTE) | Call IV=${(callIV * 100).toFixed(2)}% | ` +
      `Put IV=${(putIV * 100).toFixed(2)}% | Skew=${(skew * 100).toFixed(3)}% | ` +
      `Signal=${skewData.signal}`);

    // Publish to Redis if enabled
    if (this.publishToRedis) {
      this.publishSkewUpdate(skewData);
    }

    return skewData;
  }

  /**
   * Find ATM strike closest to spot price
   */
  findATMStrike(spotPrice, chains) {
    const allStrikes = new Set();

    // Collect all unique strikes from all chains
    for (const chain of chains) {
      if (!chain.options) continue;
      for (const option of chain.options) {
        if (option.strike) {
          allStrikes.add(option.strike);
        }
      }
    }

    if (allStrikes.size === 0) {
      return null;
    }

    // Find closest strike to spot
    const strikes = Array.from(allStrikes).sort((a, b) => a - b);
    let closestStrike = strikes[0];
    let minDiff = Math.abs(strikes[0] - spotPrice);

    for (const strike of strikes) {
      const diff = Math.abs(strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closestStrike = strike;
      }
    }

    return closestStrike;
  }

  /**
   * Calculate days to expiration from expiration date string
   * @param {string} expirationDate - Date string in YYYY-MM-DD format
   * @returns {number} Days until expiration
   */
  calculateDTE(expirationDate) {
    const expDate = new Date(expirationDate + 'T16:00:00-05:00'); // 4 PM ET expiration
    const now = new Date();
    const diffMs = expDate - now;
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  /**
   * Get call and put IV for ATM strike
   * Uses the shortest expiration >= minDTE for consistency with backtest data
   */
  getATMIVData(atmStrike, chains) {
    // Group options by expiration to find shortest one with ATM data
    const byExpiration = new Map();

    for (const chain of chains) {
      if (!chain.options) continue;

      for (const option of chain.options) {
        if (option.strike !== atmStrike) continue;
        if (!option.greeks?.mid_iv) continue;

        const exp = option.expiration_date;
        if (!byExpiration.has(exp)) {
          byExpiration.set(exp, { call: null, put: null, callOI: 0, putOI: 0 });
        }

        const expData = byExpiration.get(exp);
        if (option.option_type === 'call') {
          expData.call = option.greeks.mid_iv;
          expData.callOI = option.open_interest || 0;
        } else if (option.option_type === 'put') {
          expData.put = option.greeks.mid_iv;
          expData.putOI = option.open_interest || 0;
        }
      }
    }

    // Find shortest expiration >= minDTE that has both call and put IV
    // This matches backtest data which uses 7+ DTE exclusively
    const expirations = Array.from(byExpiration.keys())
      .filter(exp => {
        const data = byExpiration.get(exp);
        if (data.call === null || data.put === null) return false;

        // Filter out expirations below minDTE threshold
        const dte = this.calculateDTE(exp);
        if (dte < this.minDTE) {
          logger.debug(`Skipping expiration ${exp} (DTE=${dte} < minDTE=${this.minDTE})`);
          return false;
        }
        return true;
      })
      .sort();

    if (expirations.length === 0) {
      logger.warn(`No expirations found with DTE >= ${this.minDTE} for ATM strike ${atmStrike}`);
      return { callIV: null, putIV: null, expiration: null, callOI: 0, putOI: 0, dte: null };
    }

    // Use shortest valid expiration
    const shortestExp = expirations[0];
    const data = byExpiration.get(shortestExp);
    const dte = this.calculateDTE(shortestExp);

    return {
      callIV: data.call,
      putIV: data.put,
      expiration: shortestExp,
      callOI: data.callOI,
      putOI: data.putOI,
      dte
    };
  }

  /**
   * Interpret the skew value
   */
  interpretSkew(skew) {
    // Thresholds based on backtesting optimization
    if (skew < -0.02) return 'strongly_bullish';
    if (skew < -0.01) return 'bullish';
    if (skew > 0.02) return 'strongly_bearish';
    if (skew > 0.01) return 'bearish';
    return 'neutral';
  }

  /**
   * Get current IV skew data
   */
  getCurrentIVSkew() {
    return this.currentSkew;
  }

  /**
   * Get IV data at a specific time (adapter for strategy's getIVAtTime method)
   * For live trading, this returns the current skew regardless of timestamp
   */
  getIVAtTime(timestamp) {
    // For live trading, always return current data
    return this.currentSkew;
  }

  /**
   * Get skew history
   */
  getSkewHistory() {
    return this.skewHistory;
  }

  /**
   * Get smoothed skew (average of recent values)
   */
  getSmoothedSkew(windowSize = 3) {
    if (this.skewHistory.length === 0) {
      return null;
    }

    const window = this.skewHistory.slice(-windowSize);
    const avgSkew = window.reduce((sum, d) => sum + d.skew, 0) / window.length;

    return {
      ...this.currentSkew,
      skew: avgSkew,
      smoothed: true,
      windowSize
    };
  }

  /**
   * Publish skew update to Redis
   */
  async publishSkewUpdate(skewData) {
    try {
      await messageBus.publish(CHANNELS.IV_SKEW, skewData);
      logger.debug('Published IV skew update to Redis');
    } catch (error) {
      logger.warn('Failed to publish IV skew update:', error.message);
    }
  }

  /**
   * Reset calculator state
   */
  reset() {
    this.currentSkew = null;
    this.skewHistory = [];
    logger.info('IV Skew Calculator reset');
  }
}

export default IVSkewCalculator;
