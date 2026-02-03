/**
 * Historical GEX Data Loader
 * Loads and provides access to historical GEX/VEX/CEX levels from processed OPRA data
 * Supports both legacy QQQ format and new NQ 15-minute interval JSON format
 */

import fs from 'fs';
import path from 'path';

export class GexLoader {
  constructor(dataDirectory, ticker = 'nq') {
    // dataDirectory should be an absolute path when instantiated
    // Check for ticker subdirectory (new structure) or flat (old structure)
    const tickerSubdir = path.join(dataDirectory, ticker.toLowerCase());
    this.dataDirectory = fs.existsSync(tickerSubdir) ? tickerSubdir : dataDirectory;
    this.loadedData = new Map();
    this.sortedTimestamps = [];
    this.intervalMs = 15 * 60 * 1000; // 15-minute intervals
  }

  /**
   * Load GEX data for a specific date range (legacy QQQ format)
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<boolean>} Success status
   */
  async loadDateRange(startDate, endDate) {
    console.log(`Loading GEX data from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

    const loadedFiles = [];
    const current = new Date(startDate);

    while (current <= endDate) {
      const dateStr = current.toISOString().split('T')[0];

      // Try new NQ format first, then legacy QQQ format
      const nqFilename = `nq_gex_${dateStr}.json`;
      const nqFilepath = path.join(this.dataDirectory, nqFilename);
      const qqFilename = `qqq_gex_${dateStr}.json`;
      const qqFilepath = path.join(this.dataDirectory, qqFilename);

      try {
        if (fs.existsSync(nqFilepath)) {
          const fileData = JSON.parse(fs.readFileSync(nqFilepath, 'utf8'));
          this.processNQFileData(fileData);
          loadedFiles.push(nqFilename);
        } else if (fs.existsSync(qqFilepath)) {
          const fileData = JSON.parse(fs.readFileSync(qqFilepath, 'utf8'));
          this.processFileData(fileData);
          loadedFiles.push(qqFilename);
        }
      } catch (error) {
        console.warn(`Failed to load GEX data for ${dateStr}:`, error.message);
      }

      current.setDate(current.getDate() + 1);
    }

    // Sort timestamps for efficient lookups
    this.sortedTimestamps = Array.from(this.loadedData.keys()).sort((a, b) => a - b);

    console.log(`Loaded GEX data from ${loadedFiles.length} files, ${this.sortedTimestamps.length} total 15-min snapshots`);
    return loadedFiles.length > 0;
  }

  /**
   * Process data from new NQ JSON format (15-minute intervals)
   * @param {Object} fileData - JSON file content
   */
  processNQFileData(fileData) {
    if (!fileData.data || !Array.isArray(fileData.data)) {
      console.warn('Invalid NQ GEX file format - no data array found');
      return;
    }

    for (const record of fileData.data) {
      const timestamp = new Date(record.timestamp);
      const timestampKey = timestamp.getTime();

      this.loadedData.set(timestampKey, {
        timestamp,
        nq_spot: record.nq_spot,
        qqq_spot: record.qqq_spot,
        multiplier: record.multiplier,
        gamma_flip: record.gamma_flip,
        call_wall: record.call_wall,
        put_wall: record.put_wall,
        total_gex: record.total_gex,
        total_vex: record.total_vex,
        total_cex: record.total_cex,
        resistance: record.resistance || [],  // All 5 resistance levels
        support: record.support || [],        // All 5 support levels
        regime: record.regime,
        options_count: record.options_count || 0,
        // Computed fields for backtesting
        isPositiveGEX: record.total_gex > 1e9,
        isNegativeGEX: record.total_gex < -1e9,
        gexMagnitude: Math.abs(record.total_gex),
        // Compatibility aliases for strategies expecting legacy field names
        spot_price: record.nq_spot,
        nq_gamma_flip: record.gamma_flip,
        nq_put_wall_1: record.put_wall,
        nq_put_wall_2: record.support?.[1] || null,
        nq_put_wall_3: record.support?.[2] || null,
        nq_call_wall_1: record.call_wall,
        nq_call_wall_2: record.resistance?.[1] || null,
        nq_call_wall_3: record.resistance?.[2] || null
      });
    }
  }

  /**
   * Process data from a single JSON file
   * @param {Object} fileData - JSON file content
   */
  processFileData(fileData) {
    if (!fileData.data || !Array.isArray(fileData.data)) {
      console.warn('Invalid GEX file format - no data array found');
      return;
    }

    for (const record of fileData.data) {
      const timestamp = new Date(record.timestamp);
      const timestampKey = timestamp.getTime();

      this.loadedData.set(timestampKey, {
        timestamp,
        spot_price: record.spot_price,
        gamma_flip: record.gamma_flip,
        call_wall: record.call_wall,
        put_wall: record.put_wall,
        total_gex: record.total_gex,
        total_vex: record.total_vex,
        total_cex: record.total_cex,
        resistance: record.resistance || [],
        support: record.support || [],
        regime: record.regime,
        dte_range: record.dte_range || [0, 30],
        options_count: record.options_count || 0,
        // Additional computed fields for backtesting
        isPositiveGEX: record.total_gex > 1e9,
        isNegativeGEX: record.total_gex < -1e9,
        gexMagnitude: Math.abs(record.total_gex)
      });
    }
  }

  /**
   * Get GEX levels at a specific timestamp
   * Uses the most recent 15-minute snapshot (no interpolation by default for accuracy)
   * @param {Date} timestamp - Timestamp to query
   * @param {boolean} allowInterpolation - Whether to interpolate between data points
   * @returns {Object|null} GEX levels or null if not found
   */
  getGexLevels(timestamp, allowInterpolation = false) {
    const targetTime = timestamp.getTime();

    // Try exact match first
    if (this.loadedData.has(targetTime)) {
      return this.loadedData.get(targetTime);
    }

    // For 15-min data, find the most recent snapshot before this timestamp
    // (This is more accurate than interpolating since GEX levels are discrete)
    const { before } = this.findSurroundingTimestamps(targetTime);

    if (before) {
      return this.loadedData.get(before);
    }

    if (this.sortedTimestamps.length === 0) {
      return null;
    }

    // If no snapshot before, try interpolation if allowed
    if (allowInterpolation) {
      const { after } = this.findSurroundingTimestamps(targetTime);
      if (after) {
        return this.loadedData.get(after);
      }
    }

    return null;
  }

  /**
   * Get all GEX entry levels for a given side (buy or sell)
   * Returns all relevant levels sorted by strength
   * @param {Date} timestamp - Timestamp to query
   * @param {string} side - 'buy' or 'sell'
   * @param {number} currentPrice - Current price to filter levels
   * @returns {Array} Array of level objects with price, type, and strength
   */
  getEntryLevels(timestamp, side, currentPrice) {
    const gexData = this.getGexLevels(timestamp);
    if (!gexData) return [];

    const levels = [];

    if (side === 'buy') {
      // For longs: support levels, put_wall, gamma_flip below price
      (gexData.support || []).forEach((price, idx) => {
        if (price < currentPrice) {
          levels.push({
            price,
            type: `support_${idx + 1}`,
            description: `GEX Support ${idx + 1}`,
            strength: 90 - (idx * 5)
          });
        }
      });

      if (gexData.put_wall && gexData.put_wall < currentPrice) {
        // Check if put_wall is not already in support array
        const notInSupport = !gexData.support.some(s => Math.abs(s - gexData.put_wall) < 1);
        if (notInSupport) {
          levels.push({
            price: gexData.put_wall,
            type: 'put_wall',
            description: 'Put Wall',
            strength: 95
          });
        }
      }

      if (gexData.gamma_flip && gexData.gamma_flip < currentPrice) {
        levels.push({
          price: gexData.gamma_flip,
          type: 'gamma_flip',
          description: 'Gamma Flip',
          strength: 100
        });
      }
    } else if (side === 'sell') {
      // For shorts: resistance levels, call_wall, gamma_flip above price
      (gexData.resistance || []).forEach((price, idx) => {
        if (price > currentPrice) {
          levels.push({
            price,
            type: `resistance_${idx + 1}`,
            description: `GEX Resistance ${idx + 1}`,
            strength: 90 - (idx * 5)
          });
        }
      });

      if (gexData.call_wall && gexData.call_wall > currentPrice) {
        // Check if call_wall is not already in resistance array
        const notInResistance = !gexData.resistance.some(r => Math.abs(r - gexData.call_wall) < 1);
        if (notInResistance) {
          levels.push({
            price: gexData.call_wall,
            type: 'call_wall',
            description: 'Call Wall',
            strength: 95
          });
        }
      }

      if (gexData.gamma_flip && gexData.gamma_flip > currentPrice) {
        levels.push({
          price: gexData.gamma_flip,
          type: 'gamma_flip',
          description: 'Gamma Flip',
          strength: 100
        });
      }
    }

    // Sort by strength (highest first)
    return levels.sort((a, b) => b.strength - a.strength);
  }

  /**
   * Check if a level still exists in the current GEX snapshot
   * Used for validating multi-bar reclaims
   * @param {Date} timestamp - Current timestamp
   * @param {number} levelPrice - Price level to validate
   * @param {number} tolerance - Price tolerance (default 1 point)
   * @returns {boolean} True if level still exists
   */
  isLevelValid(timestamp, levelPrice, tolerance = 1.0) {
    const gexData = this.getGexLevels(timestamp);
    if (!gexData) return false;

    // Check all level types
    const allLevels = [
      ...(gexData.support || []),
      ...(gexData.resistance || []),
      gexData.gamma_flip,
      gexData.call_wall,
      gexData.put_wall
    ].filter(l => l != null);

    return allLevels.some(l => Math.abs(l - levelPrice) <= tolerance);
  }

  /**
   * Find timestamps surrounding a target time
   * @param {number} targetTime - Target timestamp in milliseconds
   * @returns {Object} Object with before and after timestamps
   */
  findSurroundingTimestamps(targetTime) {
    let before = null;
    let after = null;

    for (let i = 0; i < this.sortedTimestamps.length; i++) {
      const timestamp = this.sortedTimestamps[i];

      if (timestamp <= targetTime) {
        before = timestamp;
      } else {
        after = timestamp;
        break;
      }
    }

    return { before, after };
  }

  /**
   * Interpolate GEX levels between two data points
   * @param {Object} beforeData - Earlier data point
   * @param {Object} afterData - Later data point
   * @param {number} targetTime - Target time in milliseconds
   * @returns {Object} Interpolated GEX levels
   */
  interpolateGexLevels(beforeData, afterData, targetTime) {
    const beforeTime = beforeData.timestamp.getTime();
    const afterTime = afterData.timestamp.getTime();
    const ratio = (targetTime - beforeTime) / (afterTime - beforeTime);

    // Linear interpolation for numeric values
    const interpolate = (before, after) => before + (after - before) * ratio;

    return {
      timestamp: new Date(targetTime),
      spot_price: interpolate(beforeData.spot_price, afterData.spot_price),
      gamma_flip: interpolate(beforeData.gamma_flip, afterData.gamma_flip),
      call_wall: interpolate(beforeData.call_wall, afterData.call_wall),
      put_wall: interpolate(beforeData.put_wall, afterData.put_wall),
      total_gex: interpolate(beforeData.total_gex, afterData.total_gex),
      total_vex: interpolate(beforeData.total_vex, afterData.total_vex),
      total_cex: interpolate(beforeData.total_cex, afterData.total_cex),
      // Use closest non-numeric values
      resistance: ratio < 0.5 ? beforeData.resistance : afterData.resistance,
      support: ratio < 0.5 ? beforeData.support : afterData.support,
      regime: ratio < 0.5 ? beforeData.regime : afterData.regime,
      dte_range: beforeData.dte_range,
      options_count: Math.round(interpolate(beforeData.options_count, afterData.options_count)),
      // Computed fields
      isPositiveGEX: interpolate(beforeData.total_gex, afterData.total_gex) > 1e9,
      isNegativeGEX: interpolate(beforeData.total_gex, afterData.total_gex) < -1e9,
      gexMagnitude: Math.abs(interpolate(beforeData.total_gex, afterData.total_gex)),
      interpolated: true
    };
  }

  /**
   * Get GEX regime at a specific timestamp
   * @param {Date} timestamp - Timestamp to query
   * @returns {string} GEX regime ('positive', 'negative', 'neutral', etc.)
   */
  getGexRegime(timestamp) {
    const levels = this.getGexLevels(timestamp);
    return levels ? levels.regime : 'unknown';
  }

  /**
   * Check if price is near a significant GEX level
   * @param {Date} timestamp - Timestamp to query
   * @param {number} price - Current price
   * @param {number} threshold - Threshold in points (default: 5)
   * @returns {Object} Information about nearby levels
   */
  getNearbyLevels(timestamp, price, threshold = 5) {
    const levels = this.getGexLevels(timestamp);
    if (!levels) return { nearGammaFlip: false, nearWalls: false, levels: null };

    const nearGammaFlip = Math.abs(price - levels.gamma_flip) <= threshold;
    const nearCallWall = Math.abs(price - levels.call_wall) <= threshold;
    const nearPutWall = Math.abs(price - levels.put_wall) <= threshold;

    return {
      nearGammaFlip,
      nearWalls: nearCallWall || nearPutWall,
      nearCallWall,
      nearPutWall,
      levels,
      distances: {
        toGammaFlip: price - levels.gamma_flip,
        toCallWall: price - levels.call_wall,
        toPutWall: price - levels.put_wall
      }
    };
  }

  /**
   * Get available data range
   * @returns {Object} Start and end dates of available data
   */
  getDataRange() {
    if (this.sortedTimestamps.length === 0) {
      return { start: null, end: null };
    }

    return {
      start: new Date(this.sortedTimestamps[0]),
      end: new Date(this.sortedTimestamps[this.sortedTimestamps.length - 1]),
      totalRecords: this.sortedTimestamps.length
    };
  }

  /**
   * Get statistics about loaded GEX data
   * @returns {Object} Data statistics
   */
  getStatistics() {
    if (this.sortedTimestamps.length === 0) {
      return { count: 0 };
    }

    const values = Array.from(this.loadedData.values());

    const gexValues = values.map(d => d.total_gex);
    const vexValues = values.map(d => d.total_vex);
    const cexValues = values.map(d => d.total_cex);

    return {
      count: values.length,
      gex: {
        min: Math.min(...gexValues),
        max: Math.max(...gexValues),
        avg: gexValues.reduce((a, b) => a + b, 0) / gexValues.length
      },
      vex: {
        min: Math.min(...vexValues),
        max: Math.max(...vexValues),
        avg: vexValues.reduce((a, b) => a + b, 0) / vexValues.length
      },
      cex: {
        min: Math.min(...cexValues),
        max: Math.max(...cexValues),
        avg: cexValues.reduce((a, b) => a + b, 0) / cexValues.length
      },
      regimes: this.getRegimeDistribution(values)
    };
  }

  /**
   * Get distribution of GEX regimes
   * @param {Array} values - Array of GEX data points
   * @returns {Object} Regime distribution
   */
  getRegimeDistribution(values) {
    const distribution = {};

    for (const value of values) {
      const regime = value.regime;
      distribution[regime] = (distribution[regime] || 0) + 1;
    }

    return distribution;
  }

  /**
   * Clear all loaded data
   */
  clear() {
    this.loadedData.clear();
    this.sortedTimestamps = [];
    console.log('Cleared all GEX data from memory');
  }
}