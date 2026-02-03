/**
 * CBBO (Consolidated Best Bid/Offer) Data Loader
 *
 * Loads and processes QQQ options CBBO data for volatility prediction.
 * Supports streaming large CSV files (~350MB/day) and precomputed aggregates.
 *
 * Key metrics computed per minute:
 *   - avgSpread: Mean bid-ask spread percentage across all options
 *   - avgCallSpread / avgPutSpread: Spread by option type
 *   - putCallSizeRatio: Put size / Call size
 *   - callSizeImbalance / putSizeImbalance: (bidSize - askSize) / total
 *   - spreadVolatility: Std deviation of spreads
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

export class CBBOLoader {
  constructor(dataDir = 'backtest-engine/data/cbbo-1m/qqq') {
    // Resolve to absolute path if relative
    this.dataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(dataDir);

    // Store aggregated metrics by minute timestamp
    this.metricsByMinute = new Map();
    this.sortedTimestamps = [];

    // Precomputed data cache
    this.precomputedLoaded = false;
  }

  /**
   * Parse QQQ option symbol from CBBO data
   * Format: "QQQ   YYMMDDCSSSSSSSS"
   * Example: "QQQ   250117C00500000" -> QQQ call, 2025-01-17, strike $500
   *
   * @param {string} symbol - Option symbol from CBBO file
   * @returns {Object|null} Parsed option details or null if invalid
   */
  parseOptionSymbol(symbol) {
    const trimmed = symbol.trim();
    const match = trimmed.match(/^([A-Z]+)\s+(\d{6})([CP])(\d{8})$/);
    if (!match) return null;

    const [, underlying, dateStr, type, strikeStr] = match;
    const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
    const month = parseInt(dateStr.slice(2, 4), 10) - 1;
    const day = parseInt(dateStr.slice(4, 6), 10);
    const expiry = new Date(year, month, day);
    const strike = parseInt(strikeStr, 10) / 1000;

    return {
      underlying,
      expiry,
      type: type === 'C' ? 'call' : 'put',
      strike,
    };
  }

  /**
   * Get file path for a specific date
   * @param {Date|string} date - Date to get file for
   * @returns {string|null} File path or null if not found
   */
  getFileForDate(date) {
    const d = typeof date === 'string' ? new Date(date) : date;
    const dateStr = d.toISOString().split('T')[0].replace(/-/g, '');
    const filename = `opra-pillar-${dateStr}.cbbo-1m.0000.csv`;
    const filepath = path.join(this.dataDir, filename);

    if (fs.existsSync(filepath)) {
      return filepath;
    }
    return null;
  }

  /**
   * Stream a CBBO file and compute minute-level metrics
   * Memory-efficient: processes line by line without loading entire file
   *
   * @param {string} filepath - Path to CSV file
   * @param {Function} onMinuteMetrics - Callback(minuteTs, metrics) for each minute
   * @returns {Promise<Object>} Processing stats
   */
  async streamFile(filepath, onMinuteMetrics) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(filepath)) {
        resolve({ rowCount: 0, minuteCount: 0 });
        return;
      }

      let headers = null;
      let rowCount = 0;
      let currentMinute = null;
      let minuteData = { calls: [], puts: [], quoteCount: 0 };
      let minuteCount = 0;

      const fileStream = fs.createReadStream(filepath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      const emitMinute = () => {
        if (minuteData.calls.length > 0 || minuteData.puts.length > 0) {
          const metrics = this.computeMinuteMetrics(minuteData);
          onMinuteMetrics(currentMinute, metrics);
          minuteCount++;
        }
      };

      rl.on('line', (line) => {
        rowCount++;
        if (rowCount === 1) {
          headers = line.split(',');
          return;
        }

        const values = line.split(',');
        if (values.length !== headers.length) return;

        const record = {};
        headers.forEach((h, i) => {
          record[h] = values[i]?.trim();
        });

        // Parse timestamp - round to minute
        const tsEvent = record.ts_event || record.ts_recv;
        if (!tsEvent) return;

        const timestamp = new Date(tsEvent);
        const minuteKey = Math.floor(timestamp.getTime() / 60000) * 60000;

        // Emit previous minute data when minute changes
        if (currentMinute !== null && minuteKey !== currentMinute) {
          emitMinute();
          minuteData = { calls: [], puts: [], quoteCount: 0 };
        }
        currentMinute = minuteKey;

        // Parse bid/ask prices and sizes
        const bidPx = parseFloat(record.bid_px_00);
        const askPx = parseFloat(record.ask_px_00);
        const bidSz = parseInt(record.bid_sz_00, 10) || 0;
        const askSz = parseInt(record.ask_sz_00, 10) || 0;

        // Skip invalid quotes
        if (isNaN(bidPx) || isNaN(askPx) || bidPx <= 0 || askPx <= 0) return;
        if (askPx <= bidPx) return; // Invalid spread

        // Parse option details
        const opt = this.parseOptionSymbol(record.symbol);
        if (!opt || opt.underlying !== 'QQQ') return;

        // Count quotes for volume intensity
        minuteData.quoteCount++;

        const spread = askPx - bidPx;
        const midPrice = (bidPx + askPx) / 2;
        const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : null;
        const sizeImbalance = (bidSz + askSz) > 0 ? (bidSz - askSz) / (bidSz + askSz) : 0;

        const item = {
          strike: opt.strike,
          expiry: opt.expiry.getTime(),
          spread,
          spreadPct,
          bidSz,
          askSz,
          sizeImbalance,
          midPrice,
        };

        if (opt.type === 'call') {
          minuteData.calls.push(item);
        } else {
          minuteData.puts.push(item);
        }
      });

      rl.on('close', () => {
        // Emit final minute
        if (currentMinute !== null) {
          emitMinute();
        }
        resolve({ rowCount, minuteCount });
      });

      rl.on('error', reject);
    });
  }

  /**
   * Compute aggregated metrics for a minute of CBBO data
   *
   * @param {Object} minuteData - { calls: [], puts: [], quoteCount }
   * @returns {Object} Aggregated metrics for the minute
   */
  computeMinuteMetrics(minuteData) {
    const { calls, puts, quoteCount } = minuteData;

    // Filter out extreme spreads (likely bad data)
    const validCalls = calls.filter(c => c.spreadPct !== null && c.spreadPct < 50);
    const validPuts = puts.filter(p => p.spreadPct !== null && p.spreadPct < 50);

    if (validCalls.length === 0 && validPuts.length === 0) {
      return null;
    }

    // Collect spread values
    const callSpreads = validCalls.map(c => c.spreadPct);
    const putSpreads = validPuts.map(p => p.spreadPct);
    const allSpreads = [...callSpreads, ...putSpreads];

    // Calculate average spreads
    const avgCallSpread = this.mean(callSpreads);
    const avgPutSpread = this.mean(putSpreads);
    const avgSpread = this.mean(allSpreads);

    // Size totals
    let totalCallBidSz = 0, totalCallAskSz = 0;
    let totalPutBidSz = 0, totalPutAskSz = 0;

    for (const c of validCalls) {
      totalCallBidSz += c.bidSz;
      totalCallAskSz += c.askSz;
    }

    for (const p of validPuts) {
      totalPutBidSz += p.bidSz;
      totalPutAskSz += p.askSz;
    }

    const totalCallSize = validCalls.reduce((sum, c) => sum + c.bidSz + c.askSz, 0);
    const totalPutSize = validPuts.reduce((sum, p) => sum + p.bidSz + p.askSz, 0);

    // Put/Call ratios
    const putCallSpreadRatio = avgCallSpread > 0 ? avgPutSpread / avgCallSpread : null;
    const putCallSizeRatio = totalCallSize > 0 ? totalPutSize / totalCallSize : null;

    // Size imbalances
    const callSizeImbalance = (totalCallBidSz + totalCallAskSz) > 0
      ? (totalCallBidSz - totalCallAskSz) / (totalCallBidSz + totalCallAskSz)
      : 0;
    const putSizeImbalance = (totalPutBidSz + totalPutAskSz) > 0
      ? (totalPutBidSz - totalPutAskSz) / (totalPutBidSz + totalPutAskSz)
      : 0;
    const overallSizeImbalance = (totalCallBidSz + totalPutBidSz + totalCallAskSz + totalPutAskSz) > 0
      ? ((totalCallBidSz + totalPutBidSz) - (totalCallAskSz + totalPutAskSz)) /
        (totalCallBidSz + totalPutBidSz + totalCallAskSz + totalPutAskSz)
      : 0;

    // Spread volatility (std deviation)
    const spreadVolatility = this.std(allSpreads);

    return {
      avgSpread,
      avgCallSpread,
      avgPutSpread,
      putCallSpreadRatio,
      putCallSizeRatio,
      callSizeImbalance,
      putSizeImbalance,
      overallSizeImbalance,
      spreadVolatility,
      quoteCount,
      callCount: validCalls.length,
      putCount: validPuts.length,
    };
  }

  /**
   * Load CBBO data for a date range
   *
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   * @param {Function} progressCallback - Optional progress callback
   * @returns {Promise<boolean>} Success status
   */
  async loadDateRange(startDate, endDate, progressCallback = null) {
    const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
    const end = typeof endDate === 'string' ? new Date(endDate) : endDate;

    console.log(`📊 Loading CBBO data from ${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`);

    // Check for precomputed data first
    const precomputedPath = this.getPrecomputedFilePath();
    if (precomputedPath) {
      console.log(`   Found precomputed data, loading from ${precomputedPath}...`);
      const loaded = await this.loadPrecomputedData(precomputedPath, start, end);
      if (loaded) {
        console.log(`✅ Loaded ${this.metricsByMinute.size.toLocaleString()} CBBO minute records from precomputed data`);
        return true;
      }
    }

    // Fall back to streaming raw files
    console.log(`   Processing raw CBBO files (this may take a while)...`);

    this.metricsByMinute.clear();
    let daysProcessed = 0;
    let totalMinutes = 0;
    let totalRows = 0;

    const current = new Date(start);
    while (current <= end) {
      const filepath = this.getFileForDate(current);

      if (filepath) {
        const result = await this.streamFile(filepath, (minuteTs, metrics) => {
          if (metrics) {
            this.metricsByMinute.set(minuteTs, metrics);
          }
        });

        totalMinutes += result.minuteCount;
        totalRows += result.rowCount;

        if (progressCallback) {
          progressCallback(daysProcessed + 1, totalMinutes);
        }
      }

      daysProcessed++;
      current.setDate(current.getDate() + 1);
    }

    // Sort timestamps for binary search
    this.sortedTimestamps = Array.from(this.metricsByMinute.keys()).sort((a, b) => a - b);

    console.log(`✅ Loaded CBBO data: ${totalMinutes.toLocaleString()} minute records from ${daysProcessed} days`);
    return this.sortedTimestamps.length > 0;
  }

  /**
   * Get precomputed file path if it exists
   * @returns {string|null} Path to precomputed file or null
   */
  getPrecomputedFilePath() {
    // Check for precomputed CSV in data directory
    const defaultPath = path.join(path.dirname(this.dataDir), 'cbbo-metrics-1m.csv');
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }

    // Check in same directory
    const sameDirPath = path.join(this.dataDir, 'cbbo-metrics-1m.csv');
    if (fs.existsSync(sameDirPath)) {
      return sameDirPath;
    }

    return null;
  }

  /**
   * Load precomputed CBBO metrics from CSV
   *
   * @param {string} filepath - Path to precomputed CSV
   * @param {Date} startDate - Start date filter
   * @param {Date} endDate - End date filter
   * @returns {Promise<boolean>} Success status
   */
  async loadPrecomputedData(filepath, startDate, endDate) {
    return new Promise((resolve, reject) => {
      const startMs = startDate.getTime();
      const endMs = endDate.getTime() + 86400000; // Include full end date

      let headers = null;
      let lineCount = 0;
      let loadedCount = 0;

      const fileStream = fs.createReadStream(filepath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      rl.on('line', (line) => {
        lineCount++;
        if (lineCount === 1) {
          headers = line.split(',');
          return;
        }

        const values = line.split(',');
        if (values.length !== headers.length) return;

        const record = {};
        headers.forEach((h, i) => {
          record[h] = values[i];
        });

        const timestamp = new Date(record.timestamp).getTime();

        // Filter by date range
        if (timestamp < startMs || timestamp >= endMs) return;

        this.metricsByMinute.set(timestamp, {
          avgSpread: parseFloat(record.avgSpread),
          avgCallSpread: parseFloat(record.avgCallSpread),
          avgPutSpread: parseFloat(record.avgPutSpread),
          putCallSpreadRatio: parseFloat(record.putCallSpreadRatio),
          putCallSizeRatio: parseFloat(record.putCallSizeRatio),
          callSizeImbalance: parseFloat(record.callSizeImbalance),
          putSizeImbalance: parseFloat(record.putSizeImbalance),
          overallSizeImbalance: parseFloat(record.overallSizeImbalance),
          spreadVolatility: parseFloat(record.spreadVolatility),
          quoteCount: parseInt(record.quoteCount, 10),
          callCount: parseInt(record.callCount, 10),
          putCount: parseInt(record.putCount, 10),
        });

        loadedCount++;
      });

      rl.on('close', () => {
        // Sort timestamps for binary search
        this.sortedTimestamps = Array.from(this.metricsByMinute.keys()).sort((a, b) => a - b);
        this.precomputedLoaded = true;
        resolve(loadedCount > 0);
      });

      rl.on('error', (err) => {
        console.error(`Error loading precomputed CBBO data: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * Get CBBO metrics at a specific timestamp
   * Uses binary search for efficient lookup
   *
   * @param {number|Date} timestamp - Target timestamp
   * @returns {Object|null} CBBO metrics or null if not found
   */
  getCBBOMetrics(timestamp) {
    const targetTime = typeof timestamp === 'number'
      ? timestamp
      : timestamp instanceof Date
        ? timestamp.getTime()
        : new Date(timestamp).getTime();

    // Round to minute
    const minuteKey = Math.floor(targetTime / 60000) * 60000;

    // Try exact match first
    if (this.metricsByMinute.has(minuteKey)) {
      return this.metricsByMinute.get(minuteKey);
    }

    // Find closest minute before target (use most recent data)
    const beforeTs = this.findClosestBefore(minuteKey);
    if (beforeTs !== null) {
      // Only return if within 5 minutes
      if (minuteKey - beforeTs <= 5 * 60 * 1000) {
        return this.metricsByMinute.get(beforeTs);
      }
    }

    return null;
  }

  /**
   * Get spread change over a lookback window
   *
   * @param {number|Date} timestamp - Target timestamp
   * @param {number} windowMinutes - Lookback window in minutes
   * @returns {Object|null} Spread change metrics or null
   */
  getSpreadChange(timestamp, windowMinutes = 30) {
    const targetTime = typeof timestamp === 'number'
      ? timestamp
      : timestamp instanceof Date
        ? timestamp.getTime()
        : new Date(timestamp).getTime();

    const windowMs = windowMinutes * 60 * 1000;
    const startTs = targetTime - windowMs;
    const midTs = targetTime - windowMs / 2;

    // Get all minutes in the window
    const windowMinuteKeys = this.sortedTimestamps.filter(
      ts => ts >= startTs && ts < targetTime
    );

    if (windowMinuteKeys.length < 4) {
      return null; // Not enough data
    }

    // Split into first and second half
    const midIdx = Math.floor(windowMinuteKeys.length / 2);
    const firstHalfKeys = windowMinuteKeys.slice(0, midIdx);
    const secondHalfKeys = windowMinuteKeys.slice(midIdx);

    // Calculate average spreads for each half
    const firstHalfSpreads = [];
    const secondHalfSpreads = [];

    for (const ts of firstHalfKeys) {
      const metrics = this.metricsByMinute.get(ts);
      if (metrics && metrics.avgSpread !== null && !isNaN(metrics.avgSpread)) {
        firstHalfSpreads.push(metrics.avgSpread);
      }
    }

    for (const ts of secondHalfKeys) {
      const metrics = this.metricsByMinute.get(ts);
      if (metrics && metrics.avgSpread !== null && !isNaN(metrics.avgSpread)) {
        secondHalfSpreads.push(metrics.avgSpread);
      }
    }

    if (firstHalfSpreads.length === 0 || secondHalfSpreads.length === 0) {
      return null;
    }

    const firstHalfAvg = this.mean(firstHalfSpreads);
    const secondHalfAvg = this.mean(secondHalfSpreads);
    const absoluteChange = secondHalfAvg - firstHalfAvg;
    const percentChange = firstHalfAvg > 0 ? absoluteChange / firstHalfAvg : 0;

    return {
      firstHalfAvg,
      secondHalfAvg,
      absoluteChange,
      percentChange,
      minuteCount: windowMinuteKeys.length,
      windowMinutes,
    };
  }

  /**
   * Get aggregated metrics for a time window
   *
   * @param {number|Date} timestamp - End timestamp
   * @param {number} windowMinutes - Lookback window in minutes
   * @returns {Object|null} Aggregated metrics or null
   */
  getWindowMetrics(timestamp, windowMinutes = 30) {
    const targetTime = typeof timestamp === 'number'
      ? timestamp
      : timestamp instanceof Date
        ? timestamp.getTime()
        : new Date(timestamp).getTime();

    const windowMs = windowMinutes * 60 * 1000;
    const startTs = targetTime - windowMs;

    const windowMinuteKeys = this.sortedTimestamps.filter(
      ts => ts >= startTs && ts < targetTime
    );

    if (windowMinuteKeys.length === 0) {
      return null;
    }

    // Aggregate all metrics
    const spreads = [];
    const callSpreads = [];
    const putSpreads = [];
    const spreadVolatilities = [];
    const putCallSizeRatios = [];
    const overallImbalances = [];
    let totalQuotes = 0;

    for (const ts of windowMinuteKeys) {
      const m = this.metricsByMinute.get(ts);
      if (!m) continue;

      if (m.avgSpread !== null && !isNaN(m.avgSpread)) spreads.push(m.avgSpread);
      if (m.avgCallSpread !== null && !isNaN(m.avgCallSpread)) callSpreads.push(m.avgCallSpread);
      if (m.avgPutSpread !== null && !isNaN(m.avgPutSpread)) putSpreads.push(m.avgPutSpread);
      if (m.spreadVolatility !== null && !isNaN(m.spreadVolatility)) spreadVolatilities.push(m.spreadVolatility);
      if (m.putCallSizeRatio !== null && !isNaN(m.putCallSizeRatio)) putCallSizeRatios.push(m.putCallSizeRatio);
      if (m.overallSizeImbalance !== null && !isNaN(m.overallSizeImbalance)) overallImbalances.push(m.overallSizeImbalance);
      totalQuotes += m.quoteCount || 0;
    }

    return {
      avgSpread: this.mean(spreads),
      avgCallSpread: this.mean(callSpreads),
      avgPutSpread: this.mean(putSpreads),
      spreadVolatility: this.mean(spreadVolatilities),
      putCallSizeRatio: this.mean(putCallSizeRatios),
      overallSizeImbalance: this.mean(overallImbalances),
      volumeIntensity: totalQuotes / windowMinuteKeys.length,
      minuteCount: windowMinuteKeys.length,
      windowMinutes,
    };
  }

  /**
   * Binary search to find closest timestamp before target
   *
   * @param {number} targetTime - Target timestamp
   * @returns {number|null} Closest timestamp before target or null
   */
  findClosestBefore(targetTime) {
    if (this.sortedTimestamps.length === 0) return null;

    let left = 0;
    let right = this.sortedTimestamps.length - 1;
    let result = null;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const ts = this.sortedTimestamps[mid];

      if (ts <= targetTime) {
        result = ts;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return result;
  }

  /**
   * Calculate mean of an array
   * @param {number[]} arr - Array of numbers
   * @returns {number|null} Mean value or null if empty
   */
  mean(arr) {
    if (!arr || arr.length === 0) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /**
   * Calculate standard deviation of an array
   * @param {number[]} arr - Array of numbers
   * @returns {number} Standard deviation or 0
   */
  std(arr) {
    if (!arr || arr.length < 2) return 0;
    const avg = this.mean(arr);
    const variance = arr.reduce((sum, v) => sum + (v - avg) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }

  /**
   * Get available date range from loaded data
   * @returns {Object} { startDate, endDate, minuteCount }
   */
  getDataRange() {
    if (this.sortedTimestamps.length === 0) {
      return { startDate: null, endDate: null, minuteCount: 0 };
    }

    return {
      startDate: new Date(this.sortedTimestamps[0]),
      endDate: new Date(this.sortedTimestamps[this.sortedTimestamps.length - 1]),
      minuteCount: this.sortedTimestamps.length,
    };
  }

  /**
   * Get list of available CBBO files
   * @returns {string[]} Array of file paths
   */
  getAvailableFiles() {
    if (!fs.existsSync(this.dataDir)) {
      return [];
    }

    return fs.readdirSync(this.dataDir)
      .filter(f => f.endsWith('.csv') && f.includes('opra-pillar'))
      .map(f => path.join(this.dataDir, f))
      .sort();
  }

  /**
   * Get available date range from files on disk
   * @returns {Object} { startDate, endDate, fileCount }
   */
  getAvailableDateRange() {
    const files = this.getAvailableFiles();
    if (files.length === 0) {
      return { startDate: null, endDate: null, fileCount: 0 };
    }

    const datePattern = /opra-pillar-(\d{8})/;
    const dates = files
      .map(f => {
        const match = path.basename(f).match(datePattern);
        return match ? match[1] : null;
      })
      .filter(d => d !== null)
      .sort();

    if (dates.length === 0) {
      return { startDate: null, endDate: null, fileCount: 0 };
    }

    const parseDate = (d) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);

    return {
      startDate: parseDate(dates[0]),
      endDate: parseDate(dates[dates.length - 1]),
      fileCount: files.length,
    };
  }

  /**
   * Clear loaded data
   */
  clear() {
    this.metricsByMinute.clear();
    this.sortedTimestamps = [];
    this.precomputedLoaded = false;
  }

  /**
   * Check if data is loaded
   * @returns {boolean}
   */
  hasData() {
    return this.sortedTimestamps.length > 0;
  }
}

export default CBBOLoader;
