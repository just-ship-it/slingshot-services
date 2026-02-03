/**
 * IV (Implied Volatility) Data Loader
 *
 * Loads ATM IV data including put-call skew for the IV Skew GEX strategy.
 * Data format: timestamp, iv, spot_price, atm_strike, call_iv, put_iv, dte
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

export class IVLoader {
  constructor(dataDir) {
    this.dataDir = dataDir;
    // Check both new (ticker subdirectory) and old (flat) locations
    const newPath = path.join(dataDir, 'iv', 'qqq', 'qqq_atm_iv_15m.csv');
    const oldPath = path.join(dataDir, 'iv', 'qqq_atm_iv_15m.csv');
    this.ivFile = fs.existsSync(newPath) ? newPath : oldPath;
    this.ivData = [];
    this.ivMap = new Map(); // Keyed by timestamp for fast lookup
  }

  /**
   * Load IV data from CSV file
   * @param {Date} startDate - Start date filter
   * @param {Date} endDate - End date filter
   * @returns {Array} Array of IV records
   */
  async load(startDate, endDate) {
    if (!fs.existsSync(this.ivFile)) {
      console.warn(`IV data file not found: ${this.ivFile}`);
      return [];
    }

    return new Promise((resolve, reject) => {
      const records = [];
      let headers = null;

      const stream = fs.createReadStream(this.ivFile);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        if (!headers) {
          headers = line.split(',');
          return;
        }

        const values = line.split(',');
        const record = {};
        headers.forEach((h, i) => record[h] = values[i]);

        const timestamp = new Date(record.timestamp).getTime();
        const date = new Date(timestamp);

        // Filter by date range
        if (date < startDate || date > endDate) return;

        const ivRecord = {
          timestamp,
          iv: parseFloat(record.iv),
          spotPrice: parseFloat(record.spot_price),
          atmStrike: parseFloat(record.atm_strike),
          callIV: parseFloat(record.call_iv),
          putIV: parseFloat(record.put_iv),
          dte: parseInt(record.dte),
          // Put - Call: Positive = fear (puts expensive), Negative = complacency
          skew: parseFloat(record.put_iv) - parseFloat(record.call_iv)
        };

        records.push(ivRecord);
        this.ivMap.set(timestamp, ivRecord);
      });

      rl.on('close', () => {
        records.sort((a, b) => a.timestamp - b.timestamp);
        this.ivData = records;
        resolve(records);
      });

      rl.on('error', reject);
    });
  }

  /**
   * Get IV data at a specific timestamp (or most recent before)
   * Uses binary search for efficiency
   * @param {number} timestamp - Timestamp in milliseconds
   * @returns {Object|null} IV record or null if not found
   */
  getIVAtTime(timestamp) {
    if (this.ivData.length === 0) return null;

    // Binary search for the most recent IV record at or before timestamp
    let left = 0;
    let right = this.ivData.length - 1;

    while (left < right) {
      const mid = Math.floor((left + right + 1) / 2);
      if (this.ivData[mid].timestamp <= timestamp) {
        left = mid;
      } else {
        right = mid - 1;
      }
    }

    // Verify the found record is at or before the timestamp
    if (this.ivData[left].timestamp <= timestamp) {
      return this.ivData[left];
    }

    return null;
  }

  /**
   * Get all IV data
   * @returns {Array} All loaded IV records
   */
  getAllData() {
    return this.ivData;
  }

  /**
   * Get IV data availability statistics
   * @returns {Object} Statistics about loaded data
   */
  getStats() {
    if (this.ivData.length === 0) {
      return { count: 0, startDate: null, endDate: null };
    }

    return {
      count: this.ivData.length,
      startDate: new Date(this.ivData[0].timestamp).toISOString(),
      endDate: new Date(this.ivData[this.ivData.length - 1].timestamp).toISOString(),
      avgIV: this.ivData.reduce((s, r) => s + r.iv, 0) / this.ivData.length,
      avgSkew: this.ivData.reduce((s, r) => s + r.skew, 0) / this.ivData.length
    };
  }
}

export default IVLoader;
