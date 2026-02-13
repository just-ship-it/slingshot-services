/**
 * Charm/Vanna Data Loader
 *
 * Loads precomputed charm/vanna data for the ES overnight strategy.
 * Two modes:
 *   1. Daily CSV (fast) — for overnight strategy
 *   2. Intraday JSON (15-min snapshots) — for future RTH strategies
 *
 * Data format matches output of scripts/precompute-charm-vanna.py
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

export class CharmVannaLoader {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.charmVannaDir = path.join(dataDir, 'charm-vanna', 'es');
    this.dailyCsvFile = path.join(this.charmVannaDir, 'es_charm_vanna_daily.csv');
    this.dailyData = [];       // Sorted array of daily records
    this.intradayData = [];    // Sorted array of intraday snapshots (from JSON)
  }

  // ─── Mode 1: Daily CSV ──────────────────────────────────────────────

  /**
   * Load daily CSV data for overnight strategy
   * @param {Date} startDate - Start date filter
   * @param {Date} endDate - End date filter
   * @returns {Array} Array of daily records
   */
  async loadDaily(startDate, endDate) {
    if (!fs.existsSync(this.dailyCsvFile)) {
      console.warn(`Charm/Vanna daily CSV not found: ${this.dailyCsvFile}`);
      return [];
    }

    return new Promise((resolve, reject) => {
      const records = [];
      let headers = null;

      const stream = fs.createReadStream(this.dailyCsvFile);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        if (!headers) {
          headers = line.split(',');
          return;
        }

        const values = line.split(',');
        const record = {};
        headers.forEach((h, i) => record[h.trim()] = values[i]);

        const dateStr = record.date;
        const date = new Date(dateStr + 'T16:00:00-05:00'); // 4pm ET = EOD

        if (date < startDate || date > endDate) return;

        const dailyRecord = {
          date: dateStr,
          timestamp: date.getTime(),
          spySpot: parseFloat(record.spy_spot),
          esSpot: parseFloat(record.es_spot),
          multiplier: parseFloat(record.multiplier),
          vixClose: record.vix_close ? parseFloat(record.vix_close) : null,
          netCex: parseFloat(record.net_cex),
          netVex: parseFloat(record.net_vex),
          shortTermCex: parseFloat(record.short_term_cex),
          mediumTermCex: parseFloat(record.medium_term_cex),
          longTermCex: parseFloat(record.long_term_cex),
          putCex: parseFloat(record.put_cex),
          callCex: parseFloat(record.call_cex),
          putVex: parseFloat(record.put_vex),
          callVex: parseFloat(record.call_vex),
          netGex: parseFloat(record.net_gex),
          totalOi: parseInt(record.total_oi),
          putOi: parseInt(record.put_oi),
          callOi: parseInt(record.call_oi),
          optionsCount: parseInt(record.options_count),
          regime: record.regime,
          gammaFlip: record.gamma_flip ? parseFloat(record.gamma_flip) : null,
          putWall: record.put_wall ? parseFloat(record.put_wall) : null,
          callWall: record.call_wall ? parseFloat(record.call_wall) : null
        };

        records.push(dailyRecord);
      });

      rl.on('close', () => {
        records.sort((a, b) => a.timestamp - b.timestamp);
        this.dailyData = records;
        resolve(records);
      });

      rl.on('error', reject);
    });
  }

  /**
   * Get charm/vanna data for a specific date (most recent at or before timestamp)
   * Uses binary search for efficiency
   * @param {number} timestamp - Timestamp in milliseconds
   * @returns {Object|null} Daily record or null
   */
  getDataForDate(timestamp) {
    if (this.dailyData.length === 0) return null;

    let left = 0;
    let right = this.dailyData.length - 1;

    while (left < right) {
      const mid = Math.floor((left + right + 1) / 2);
      if (this.dailyData[mid].timestamp <= timestamp) {
        left = mid;
      } else {
        right = mid - 1;
      }
    }

    if (this.dailyData[left].timestamp <= timestamp) {
      return this.dailyData[left];
    }

    return null;
  }

  // ─── Mode 2: Intraday JSON ──────────────────────────────────────────

  /**
   * Load intraday 15-min JSON snapshots
   * @param {Date} startDate - Start date filter
   * @param {Date} endDate - End date filter
   * @returns {Array} Array of intraday snapshots
   */
  async loadIntraday(startDate, endDate) {
    if (!fs.existsSync(this.charmVannaDir)) {
      console.warn(`Charm/Vanna directory not found: ${this.charmVannaDir}`);
      return [];
    }

    const allSnapshots = [];
    const current = new Date(startDate);

    while (current <= endDate) {
      const dateStr = current.toISOString().split('T')[0];
      const jsonPath = path.join(this.charmVannaDir, `es_charm_vanna_${dateStr}.json`);

      if (fs.existsSync(jsonPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          if (raw.data && Array.isArray(raw.data)) {
            for (const snap of raw.data) {
              allSnapshots.push({
                timestamp: new Date(snap.timestamp).getTime(),
                spySpot: snap.spy_spot,
                esSpot: snap.es_spot,
                multiplier: snap.multiplier,
                gammaFlip: snap.gamma_flip,
                callWall: snap.call_wall,
                putWall: snap.put_wall,
                resistance: snap.resistance || [],
                support: snap.support || [],
                totalGex: snap.total_gex,
                totalCex: snap.total_cex,
                totalVex: snap.total_vex,
                putCex: snap.put_cex,
                callCex: snap.call_cex,
                putVex: snap.put_vex,
                callVex: snap.call_vex,
                shortTermCex: snap.short_term_cex,
                mediumTermCex: snap.medium_term_cex,
                longTermCex: snap.long_term_cex,
                regime: snap.regime,
                optionsCount: snap.options_count,
                totalOi: snap.total_oi,
                putOi: snap.put_oi,
                callOi: snap.call_oi
              });
            }
          }
        } catch (err) {
          console.warn(`Failed to load ${jsonPath}: ${err.message}`);
        }
      }

      current.setDate(current.getDate() + 1);
    }

    allSnapshots.sort((a, b) => a.timestamp - b.timestamp);
    this.intradayData = allSnapshots;
    return allSnapshots;
  }

  /**
   * Get intraday data at a specific timestamp (most recent at or before)
   * Uses binary search for efficiency
   * @param {number} timestamp - Timestamp in milliseconds
   * @returns {Object|null} Intraday snapshot or null
   */
  getDataAtTime(timestamp) {
    if (this.intradayData.length === 0) return null;

    let left = 0;
    let right = this.intradayData.length - 1;

    while (left < right) {
      const mid = Math.floor((left + right + 1) / 2);
      if (this.intradayData[mid].timestamp <= timestamp) {
        left = mid;
      } else {
        right = mid - 1;
      }
    }

    if (this.intradayData[left].timestamp <= timestamp) {
      return this.intradayData[left];
    }

    return null;
  }

  // ─── Shared ──────────────────────────────────────────────────────────

  /**
   * Get all daily data
   * @returns {Array} All loaded daily records
   */
  getAllDailyData() {
    return this.dailyData;
  }

  /**
   * Get data availability statistics
   * @returns {Object} Statistics about loaded data
   */
  getStats() {
    const daily = this.dailyData;
    const intraday = this.intradayData;

    const stats = {
      dailyCount: daily.length,
      intradayCount: intraday.length,
      startDate: null,
      endDate: null,
      avgCex: 0,
      avgVex: 0
    };

    if (daily.length > 0) {
      stats.startDate = daily[0].date;
      stats.endDate = daily[daily.length - 1].date;
      stats.avgCex = daily.reduce((s, r) => s + r.netCex, 0) / daily.length;
      stats.avgVex = daily.reduce((s, r) => s + r.netVex, 0) / daily.length;
    }

    return stats;
  }
}

export default CharmVannaLoader;
