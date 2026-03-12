/**
 * Short-DTE IV Data Loader
 *
 * Loads 0-2 DTE implied volatility data (15-minute resolution) from
 * precomputed CSV files. Provides binary-search lookups for strategy use.
 *
 * Data format: qqq_short_dte_iv_15m.csv
 *   timestamp, spot_price, dte0_atm_strike, dte0_call_iv, dte0_put_iv,
 *   dte0_avg_iv, dte0_skew, dte1_*, dte2_*, term_slope, quality
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

export class ShortDTEIVLoader {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.ivFile = path.join(dataDir, 'iv', 'qqq', 'qqq_short_dte_iv_15m.csv');
    this.ivData = [];  // Sorted array for binary search
  }

  /**
   * Load short-DTE IV data from CSV
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Array}
   */
  async load(startDate, endDate) {
    if (!fs.existsSync(this.ivFile)) {
      console.warn(`Short-DTE IV file not found: ${this.ivFile}`);
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
        const raw = {};
        headers.forEach((h, i) => raw[h] = values[i]);

        const timestamp = new Date(raw.timestamp).getTime();
        if (isNaN(timestamp)) return;
        if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) return;

        const parseNum = (v) => (v === '' || v === undefined) ? null : parseFloat(v);

        records.push({
          timestamp,
          spotPrice: parseNum(raw.spot_price),
          dte0_avg_iv: parseNum(raw.dte0_avg_iv),
          dte0_call_iv: parseNum(raw.dte0_call_iv),
          dte0_put_iv: parseNum(raw.dte0_put_iv),
          dte0_skew: parseNum(raw.dte0_skew),
          dte1_avg_iv: parseNum(raw.dte1_avg_iv),
          dte1_call_iv: parseNum(raw.dte1_call_iv),
          dte1_put_iv: parseNum(raw.dte1_put_iv),
          dte1_skew: parseNum(raw.dte1_skew),
          dte2_avg_iv: parseNum(raw.dte2_avg_iv),
          term_slope: parseNum(raw.term_slope),
          quality: parseInt(raw.quality) || 0
        });
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
   * Get the most recent IV record at or before `timestamp`.
   * @param {number} timestamp - ms since epoch
   * @returns {Object|null}
   */
  getIVAtTime(timestamp) {
    if (this.ivData.length === 0) return null;

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

    if (this.ivData[left].timestamp <= timestamp) {
      return this.ivData[left];
    }
    return null;
  }

  /**
   * Get two consecutive IV records: [previous, current] at the given timestamp.
   * Returns null if either is missing or they're from different trading days.
   * @param {number} timestamp - ms since epoch
   * @returns {{ prev: Object, curr: Object }|null}
   */
  getIVPair(timestamp) {
    if (this.ivData.length < 2) return null;

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

    if (left < 1 || this.ivData[left].timestamp > timestamp) return null;

    const curr = this.ivData[left];
    const prev = this.ivData[left - 1];

    // Ensure same trading day (gap < 2 hours between readings)
    if (curr.timestamp - prev.timestamp > 2 * 60 * 60 * 1000) return null;

    return { prev, curr };
  }

  /**
   * Get a window of the most recent N IV records up to `timestamp`.
   * @param {number} timestamp
   * @param {number} n - number of records
   * @returns {Array}
   */
  getIVWindow(timestamp, n) {
    if (this.ivData.length === 0) return [];

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

    if (this.ivData[left].timestamp > timestamp) return [];

    const startIdx = Math.max(0, left - n + 1);
    return this.ivData.slice(startIdx, left + 1);
  }

  getAllData() {
    return this.ivData;
  }

  getStats() {
    if (this.ivData.length === 0) {
      return { count: 0, startDate: null, endDate: null };
    }

    const dte0IVs = this.ivData.filter(r => r.dte0_avg_iv !== null).map(r => r.dte0_avg_iv);
    const dte1IVs = this.ivData.filter(r => r.dte1_avg_iv !== null).map(r => r.dte1_avg_iv);
    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

    return {
      count: this.ivData.length,
      startDate: new Date(this.ivData[0].timestamp).toISOString(),
      endDate: new Date(this.ivData[this.ivData.length - 1].timestamp).toISOString(),
      dte0Count: dte0IVs.length,
      dte1Count: dte1IVs.length,
      avgDTE0IV: avg(dte0IVs),
      avgDTE1IV: avg(dte1IVs)
    };
  }
}

export default ShortDTEIVLoader;
