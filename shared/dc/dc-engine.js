/**
 * Directional Changes (DC) Engine
 *
 * Stateful event-detection machine that processes price observations and detects
 * directional change (DC) and overshoot (OS) events based on a configurable threshold.
 *
 * Based on: "A genetic algorithm for the optimization of multi-threshold trading
 * strategies in the directional changes paradigm" (Salman et al., 2025)
 *
 * Key concepts:
 * - DC event: Price reverses by at least theta from the last extremum
 * - Upturn: Price rises theta above the lowest point (end of downtrend)
 * - Downturn: Price falls theta below the highest point (end of uptrend)
 * - Overshoot (OS): Price continues beyond the DC confirmation point
 * - Scaling law: OS magnitude statistically mirrors DC magnitude
 */

export class DCEngine {
  /**
   * @param {Object} options
   * @param {number} options.theta - DC threshold (fraction like 0.001 for 0.1%, or absolute points if usePoints=true)
   * @param {boolean} [options.usePoints=false] - If true, theta is in absolute price points instead of percentage
   */
  constructor({ theta, usePoints = false }) {
    if (!theta || theta <= 0) {
      throw new Error('theta must be a positive number');
    }

    this.theta = theta;
    this.usePoints = usePoints;

    // Core state
    this.trend = null;         // 'uptrend' or 'downtrend', null until first DC
    this.initialized = false;

    // Extremum tracking
    this.p_ext_h = null;       // High extremum price
    this.p_ext_l = null;       // Low extremum price
    this.t_ext_h = null;       // High extremum timestamp
    this.t_ext_l = null;       // Low extremum timestamp

    // DC confirmation tracking
    this.p_DCC = null;         // Last DC confirmation price
    this.t_DCC = null;         // Last DC confirmation timestamp

    // Duration tracking (in observations/candles)
    this.dcStartIdx = 0;       // Index when current DC event started
    this.osStartIdx = 0;       // Index when current OS started
    this.observationCount = 0; // Total observations processed

    // Event counts
    this.upturnCount = 0;
    this.downturnCount = 0;

    // Duration/count indicators for St2-St6
    this.T_DC = 0;             // Duration of last DC event (observations)
    this.T_OS = 0;             // Duration of last OS event (observations)
    this.N_DC = 0;             // Count of DC events
    this.N_OS = 0;             // Count of OS events

    // Best overshoot/total-move values for St3/St4
    this.OSV_best_DT = 0;     // Best overshoot value during downtrends
    this.OSV_best_UT = 0;     // Best overshoot value during uptrends
    this.TMV_best_DT = 0;     // Best total move value during downtrends
    this.TMV_best_UT = 0;     // Best total move value during uptrends

    // DC event history for St7/St8 pattern detection
    this.eventHistory = [];    // Array of { type, price, timestamp, extremum, osv }

    // Initial extremum for TMV calculation
    this.initialExtremum = null;
  }

  /**
   * Check if price has moved by theta from a reference price
   * @param {number} price - Current price
   * @param {number} reference - Reference price
   * @param {string} direction - 'up' or 'down'
   * @returns {boolean}
   */
  hasMovedByTheta(price, reference, direction) {
    if (this.usePoints) {
      if (direction === 'up') {
        return price >= reference + this.theta;
      } else {
        return price <= reference - this.theta;
      }
    } else {
      if (direction === 'up') {
        return price >= reference * (1 + this.theta);
      } else {
        return price <= reference * (1 - this.theta);
      }
    }
  }

  /**
   * Process one price observation
   * @param {number} price - Price value (typically candle close)
   * @param {number|string} timestamp - Timestamp of the observation
   * @returns {Object|null} DC event object if a directional change was detected, null otherwise
   */
  update(price, timestamp) {
    this.observationCount++;

    // Initialize on first observation
    if (!this.initialized) {
      this.p_ext_h = price;
      this.p_ext_l = price;
      this.t_ext_h = timestamp;
      this.t_ext_l = timestamp;
      this.initialExtremum = price;
      this.initialized = true;

      // Start in a neutral state - first significant move determines trend
      // We track both high and low until a DC threshold is crossed
      return null;
    }

    // Before first trend is established, track extremes and detect first DC
    if (this.trend === null) {
      // Update extrema
      if (price > this.p_ext_h) {
        this.p_ext_h = price;
        this.t_ext_h = timestamp;
      }
      if (price < this.p_ext_l) {
        this.p_ext_l = price;
        this.t_ext_l = timestamp;
      }

      // Check for first upturn (price rose theta from low)
      if (this.hasMovedByTheta(price, this.p_ext_l, 'up')) {
        this.trend = 'uptrend';
        this.p_DCC = price;
        this.t_DCC = timestamp;
        this.p_ext_h = price;
        this.t_ext_h = timestamp;
        this.dcStartIdx = this.observationCount;
        this.upturnCount++;
        this.N_DC++;
        this.initialExtremum = this.p_ext_l;

        const event = {
          type: 'upturn',
          price,
          timestamp,
          extremum: this.p_ext_l,
          extremumTime: this.t_ext_l,
          confirmationPrice: price,
          theta: this.theta
        };
        this.eventHistory.push(event);
        return event;
      }

      // Check for first downturn (price fell theta from high)
      if (this.hasMovedByTheta(price, this.p_ext_h, 'down')) {
        this.trend = 'downtrend';
        this.p_DCC = price;
        this.t_DCC = timestamp;
        this.p_ext_l = price;
        this.t_ext_l = timestamp;
        this.dcStartIdx = this.observationCount;
        this.downturnCount++;
        this.N_DC++;
        this.initialExtremum = this.p_ext_h;

        const event = {
          type: 'downturn',
          price,
          timestamp,
          extremum: this.p_ext_h,
          extremumTime: this.t_ext_h,
          confirmationPrice: price,
          theta: this.theta
        };
        this.eventHistory.push(event);
        return event;
      }

      return null;
    }

    // Main DC algorithm (Algorithm 1 from paper)
    if (this.trend === 'downtrend') {
      // Check for upturn: price rose theta from the low extremum
      if (this.hasMovedByTheta(price, this.p_ext_l, 'up')) {
        // Calculate OS duration/magnitude before switching
        this.T_OS = this.observationCount - this.dcStartIdx;
        this.osStartIdx = this.observationCount;
        this.N_OS++;

        // Update best OS/TMV values for downtrend
        const osv = this.getOSV();
        const tmv = this.getTMV();
        if (Math.abs(osv) > Math.abs(this.OSV_best_DT)) {
          this.OSV_best_DT = Math.abs(osv);
        }
        if (Math.abs(tmv) > Math.abs(this.TMV_best_DT)) {
          this.TMV_best_DT = Math.abs(tmv);
        }

        // Switch to uptrend
        this.trend = 'uptrend';
        this.T_DC = this.observationCount - this.osStartIdx || 1;
        this.p_DCC = price;
        this.t_DCC = timestamp;
        this.p_ext_h = price;
        this.t_ext_h = timestamp;
        this.dcStartIdx = this.observationCount;
        this.upturnCount++;
        this.N_DC++;
        this.initialExtremum = this.p_ext_l;

        const event = {
          type: 'upturn',
          price,
          timestamp,
          extremum: this.p_ext_l,
          extremumTime: this.t_ext_l,
          confirmationPrice: price,
          theta: this.theta,
          osv,
          tmv,
          T_DC: this.T_DC,
          T_OS: this.T_OS
        };
        this.eventHistory.push(event);
        return event;
      }

      // Update low extremum
      if (price < this.p_ext_l) {
        this.p_ext_l = price;
        this.t_ext_l = timestamp;
      }
    } else {
      // uptrend
      // Check for downturn: price fell theta from the high extremum
      if (this.hasMovedByTheta(price, this.p_ext_h, 'down')) {
        // Calculate OS duration/magnitude before switching
        this.T_OS = this.observationCount - this.dcStartIdx;
        this.osStartIdx = this.observationCount;
        this.N_OS++;

        // Update best OS/TMV values for uptrend
        const osv = this.getOSV();
        const tmv = this.getTMV();
        if (Math.abs(osv) > Math.abs(this.OSV_best_UT)) {
          this.OSV_best_UT = Math.abs(osv);
        }
        if (Math.abs(tmv) > Math.abs(this.TMV_best_UT)) {
          this.TMV_best_UT = Math.abs(tmv);
        }

        // Switch to downtrend
        this.trend = 'downtrend';
        this.T_DC = this.observationCount - this.osStartIdx || 1;
        this.p_DCC = price;
        this.t_DCC = timestamp;
        this.p_ext_l = price;
        this.t_ext_l = timestamp;
        this.dcStartIdx = this.observationCount;
        this.downturnCount++;
        this.N_DC++;
        this.initialExtremum = this.p_ext_h;

        const event = {
          type: 'downturn',
          price,
          timestamp,
          extremum: this.p_ext_h,
          extremumTime: this.t_ext_h,
          confirmationPrice: price,
          theta: this.theta,
          osv,
          tmv,
          T_DC: this.T_DC,
          T_OS: this.T_OS
        };
        this.eventHistory.push(event);
        return event;
      }

      // Update high extremum
      if (price > this.p_ext_h) {
        this.p_ext_h = price;
        this.t_ext_h = timestamp;
      }
    }

    return null;
  }

  /**
   * Get current overshoot value (how far price has moved beyond DC confirmation)
   * @returns {number} OSV as fraction or points depending on mode
   */
  getOSV() {
    if (!this.p_DCC || !this.initialized) return 0;

    if (this.trend === 'uptrend') {
      // In uptrend, OS is how much higher the high went beyond DCC
      if (this.usePoints) {
        return this.p_ext_h - this.p_DCC;
      }
      return (this.p_ext_h - this.p_DCC) / this.p_DCC;
    } else {
      // In downtrend, OS is how much lower the low went beyond DCC
      if (this.usePoints) {
        return this.p_DCC - this.p_ext_l;
      }
      return (this.p_DCC - this.p_ext_l) / this.p_DCC;
    }
  }

  /**
   * Get total move value from initial extremum to current extremum
   * @returns {number} TMV as fraction or points
   */
  getTMV() {
    if (this.initialExtremum === null || !this.initialized) return 0;

    if (this.trend === 'uptrend') {
      if (this.usePoints) {
        return this.p_ext_h - this.initialExtremum;
      }
      return (this.p_ext_h - this.initialExtremum) / this.initialExtremum;
    } else {
      if (this.usePoints) {
        return this.initialExtremum - this.p_ext_l;
      }
      return (this.initialExtremum - this.p_ext_l) / this.initialExtremum;
    }
  }

  /**
   * Get the duration ratio RD = T_OS / T_DC
   * @returns {number}
   */
  getRD() {
    if (this.T_DC === 0) return 0;
    return this.T_OS / this.T_DC;
  }

  /**
   * Get the event count ratio RN = N_OS / N_DC
   * @returns {number}
   */
  getRN() {
    if (this.N_DC === 0) return 0;
    return this.N_OS / this.N_DC;
  }

  /**
   * Get the theoretical DC confirmation price given current extremum
   * (i.e., where would the next DC be confirmed)
   * @returns {number|null}
   */
  getTheoreticalDCC() {
    if (!this.initialized || this.trend === null) return null;

    if (this.trend === 'uptrend') {
      // Downturn would be confirmed at p_ext_h * (1 - theta)
      if (this.usePoints) {
        return this.p_ext_h - this.theta;
      }
      return this.p_ext_h * (1 - this.theta);
    } else {
      // Upturn would be confirmed at p_ext_l * (1 + theta)
      if (this.usePoints) {
        return this.p_ext_l + this.theta;
      }
      return this.p_ext_l * (1 + this.theta);
    }
  }

  /**
   * Get recent OS events for pattern detection (St7/St8)
   * @param {number} count - Number of recent events to return
   * @returns {Object[]} Recent DC events
   */
  getRecentOSPattern(count) {
    return this.eventHistory.slice(-count);
  }

  /**
   * Get full engine state snapshot
   * @returns {Object}
   */
  getState() {
    return {
      theta: this.theta,
      usePoints: this.usePoints,
      trend: this.trend,
      initialized: this.initialized,
      p_ext_h: this.p_ext_h,
      p_ext_l: this.p_ext_l,
      t_ext_h: this.t_ext_h,
      t_ext_l: this.t_ext_l,
      p_DCC: this.p_DCC,
      t_DCC: this.t_DCC,
      observationCount: this.observationCount,
      upturnCount: this.upturnCount,
      downturnCount: this.downturnCount,
      T_DC: this.T_DC,
      T_OS: this.T_OS,
      RD: this.getRD(),
      N_DC: this.N_DC,
      N_OS: this.N_OS,
      RN: this.getRN(),
      OSV_CUR: this.getOSV(),
      TMV_CUR: this.getTMV(),
      OSV_best_DT: this.OSV_best_DT,
      OSV_best_UT: this.OSV_best_UT,
      TMV_best_DT: this.TMV_best_DT,
      TMV_best_UT: this.TMV_best_UT,
      theoreticalDCC: this.getTheoreticalDCC(),
      eventCount: this.eventHistory.length
    };
  }

  /**
   * Reset all state
   */
  reset() {
    this.trend = null;
    this.initialized = false;
    this.p_ext_h = null;
    this.p_ext_l = null;
    this.t_ext_h = null;
    this.t_ext_l = null;
    this.p_DCC = null;
    this.t_DCC = null;
    this.dcStartIdx = 0;
    this.osStartIdx = 0;
    this.observationCount = 0;
    this.upturnCount = 0;
    this.downturnCount = 0;
    this.T_DC = 0;
    this.T_OS = 0;
    this.N_DC = 0;
    this.N_OS = 0;
    this.OSV_best_DT = 0;
    this.OSV_best_UT = 0;
    this.TMV_best_DT = 0;
    this.TMV_best_UT = 0;
    this.eventHistory = [];
    this.initialExtremum = null;
  }
}


/**
 * Multi-Threshold DC Engine
 *
 * Runs N DCEngine instances in parallel (one per threshold).
 * Needed for the MSTGAM (GA optimizer) in Phase 4.
 */
export class MultiThresholdDCEngine {
  /**
   * @param {number[]} thresholds - Array of theta values
   * @param {Object} [options] - Options passed to each DCEngine
   * @param {boolean} [options.usePoints=false] - Points mode for all engines
   */
  constructor(thresholds, options = {}) {
    if (!Array.isArray(thresholds) || thresholds.length === 0) {
      throw new Error('thresholds must be a non-empty array');
    }

    this.thresholds = thresholds;
    this.engines = new Map();

    for (const theta of thresholds) {
      this.engines.set(theta, new DCEngine({ theta, usePoints: options.usePoints || false }));
    }
  }

  /**
   * Feed price to all engines
   * @param {number} price
   * @param {number|string} timestamp
   * @returns {Map<number, Object|null>} Map of theta -> DC event (null if no event)
   */
  update(price, timestamp) {
    const results = new Map();
    for (const [theta, engine] of this.engines) {
      results.set(theta, engine.update(price, timestamp));
    }
    return results;
  }

  /**
   * Get state of a specific engine
   * @param {number} theta
   * @returns {Object|null}
   */
  getState(theta) {
    const engine = this.engines.get(theta);
    return engine ? engine.getState() : null;
  }

  /**
   * Get all engines
   * @returns {Map<number, DCEngine>}
   */
  getEngines() {
    return this.engines;
  }

  /**
   * Reset all engines
   */
  reset() {
    for (const engine of this.engines.values()) {
      engine.reset();
    }
  }
}

export default DCEngine;
