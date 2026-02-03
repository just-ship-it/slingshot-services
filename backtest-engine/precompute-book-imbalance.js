#!/usr/bin/env node
/**
 * Precompute Book Imbalance from MBP-1 Data
 *
 * Processes all MBP-1 files and saves aggregated imbalance metrics per 1-minute candle.
 * This converts ~333 files x 1GB each into a single ~50MB CSV for instant loading.
 *
 * Usage:
 *   node precompute-book-imbalance.js [options]
 *
 * Options:
 *   --symbol NQ         Symbol filter (default: NQ)
 *   --output FILE       Output CSV path (default: data/orderflow/book-imbalance-1m.csv)
 *   --start YYYY-MM-DD  Start date (default: earliest available)
 *   --end YYYY-MM-DD    End date (default: latest available)
 *   --workers N         Number of parallel workers (default: 4)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const DEFAULT_CONFIG = {
  mbpDir: path.join(__dirname, 'data/orderflow/nq/mbp-1'),
  outputFile: path.join(__dirname, 'data/orderflow/nq/book-imbalance-1m.csv'),
  symbol: 'NQ',
  excludeSpreads: true,
  candleDurationMs: 60000, // 1 minute
  workers: 4
};

/**
 * Generate minute-aligned timestamps for a full trading day
 * Futures trade nearly 24 hours (Sun 6pm - Fri 5pm ET with 1hr break)
 */
function generateDayMinutes(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  const minutes = [];

  // Generate all minutes for the day (UTC)
  for (let hour = 0; hour < 24; hour++) {
    for (let min = 0; min < 60; min++) {
      const timestamp = new Date(date);
      timestamp.setUTCHours(hour, min, 0, 0);
      minutes.push(timestamp.getTime());
    }
  }

  return minutes;
}

/**
 * Parse MBP-1 CSV line
 */
function parseLine(line, headers, symbolFilter, excludeSpreads) {
  const values = line.split(',');
  if (values.length !== headers.length) return null;

  const record = {};
  headers.forEach((header, i) => {
    record[header] = values[i];
  });

  const symbol = record.symbol?.trim();

  // Apply symbol filter
  if (symbolFilter && !symbol?.startsWith(symbolFilter)) {
    return null;
  }

  // Exclude calendar spreads
  if (excludeSpreads && symbol?.includes('-')) {
    return null;
  }

  const bidSize = parseInt(record.bid_sz_00, 10);
  const askSize = parseInt(record.ask_sz_00, 10);
  const bidCount = parseInt(record.bid_ct_00, 10);
  const askCount = parseInt(record.ask_ct_00, 10);

  if (isNaN(bidSize) || isNaN(askSize) || bidSize < 0 || askSize < 0) {
    return null;
  }

  return {
    timestamp: new Date(record.ts_event).getTime(),
    bidSize,
    askSize,
    bidCount,
    askCount
  };
}

/**
 * Binary search to find minute bucket for a timestamp
 */
function findMinuteBucket(minuteTimes, timestamp, durationMs) {
  let left = 0;
  let right = minuteTimes.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const bucketStart = minuteTimes[mid];
    const bucketEnd = bucketStart + durationMs;

    if (timestamp >= bucketStart && timestamp < bucketEnd) {
      return mid;
    } else if (timestamp < bucketStart) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return -1;
}

/**
 * Process a single MBP-1 file
 */
async function processFile(filepath, config) {
  return new Promise((resolve, reject) => {
    // Extract date from filename
    const dateMatch = path.basename(filepath).match(/glbx-mdp3-(\d{8})\.mbp-1\.csv/);
    if (!dateMatch) {
      resolve([]);
      return;
    }

    const dateStr = `${dateMatch[1].slice(0,4)}-${dateMatch[1].slice(4,6)}-${dateMatch[1].slice(6,8)}`;
    const minuteTimes = generateDayMinutes(dateStr);

    // Initialize buckets
    const buckets = new Map();
    for (const minTime of minuteTimes) {
      buckets.set(minTime, {
        timestamp: minTime,
        updates: 0,
        totalBidSize: 0,
        totalAskSize: 0,
        totalBidCount: 0,
        totalAskCount: 0,
        sumSizeImbalance: 0,
        sumCountImbalance: 0
      });
    }

    let headers = null;
    let lineCount = 0;

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

      const record = parseLine(line, headers, config.symbol, config.excludeSpreads);
      if (!record) return;

      const bucketIdx = findMinuteBucket(minuteTimes, record.timestamp, config.candleDurationMs);
      if (bucketIdx < 0) return;

      const bucket = buckets.get(minuteTimes[bucketIdx]);
      if (!bucket) return;

      // Accumulate
      bucket.updates++;
      bucket.totalBidSize += record.bidSize;
      bucket.totalAskSize += record.askSize;
      bucket.totalBidCount += record.bidCount;
      bucket.totalAskCount += record.askCount;

      // Instantaneous imbalances
      const totalSize = record.bidSize + record.askSize;
      const totalCount = record.bidCount + record.askCount;

      if (totalSize > 0) {
        bucket.sumSizeImbalance += (record.bidSize - record.askSize) / totalSize;
      }
      if (totalCount > 0) {
        bucket.sumCountImbalance += (record.bidCount - record.askCount) / totalCount;
      }
    });

    rl.on('close', () => {
      // Calculate final metrics and filter empty buckets
      const results = [];

      for (const [timestamp, data] of buckets) {
        if (data.updates === 0) continue;

        const totalSize = data.totalBidSize + data.totalAskSize;
        const totalCount = data.totalBidCount + data.totalAskCount;

        results.push({
          timestamp,
          updates: data.updates,
          totalBidSize: data.totalBidSize,
          totalAskSize: data.totalAskSize,
          totalBidCount: data.totalBidCount,
          totalAskCount: data.totalAskCount,
          sizeImbalance: totalSize > 0 ? (data.totalBidSize - data.totalAskSize) / totalSize : 0,
          countImbalance: totalCount > 0 ? (data.totalBidCount - data.totalAskCount) / totalCount : 0,
          avgSizeImbalance: data.sumSizeImbalance / data.updates,
          avgCountImbalance: data.sumCountImbalance / data.updates,
          bidAskRatio: data.totalAskSize > 0 ? data.totalBidSize / data.totalAskSize : 1
        });
      }

      resolve(results);
    });

    rl.on('error', reject);
  });
}

/**
 * Worker thread processing
 */
if (!isMainThread) {
  const { filepath, config } = workerData;

  processFile(filepath, config)
    .then(results => parentPort.postMessage({ success: true, results, filepath }))
    .catch(error => parentPort.postMessage({ success: false, error: error.message, filepath }));
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--symbol':
        config.symbol = args[++i];
        break;
      case '--output':
        config.outputFile = args[++i];
        break;
      case '--start':
        config.startDate = args[++i];
        break;
      case '--end':
        config.endDate = args[++i];
        break;
      case '--workers':
        config.workers = parseInt(args[++i], 10);
        break;
      case '--help':
        console.log(`
Precompute Book Imbalance from MBP-1 Data

Usage: node precompute-book-imbalance.js [options]

Options:
  --symbol NQ         Symbol filter (default: NQ)
  --output FILE       Output CSV path
  --start YYYY-MM-DD  Start date (default: earliest available)
  --end YYYY-MM-DD    End date (default: latest available)
  --workers N         Parallel workers (default: 4)
`);
        process.exit(0);
    }
  }

  console.log('=== Book Imbalance Precomputation ===\n');
  console.log(`Symbol: ${config.symbol}`);
  console.log(`MBP-1 Dir: ${config.mbpDir}`);
  console.log(`Output: ${config.outputFile}`);
  console.log(`Workers: ${config.workers}`);
  console.log('');

  // Get available files
  if (!fs.existsSync(config.mbpDir)) {
    console.error(`Error: MBP-1 directory not found: ${config.mbpDir}`);
    process.exit(1);
  }

  let files = fs.readdirSync(config.mbpDir)
    .filter(f => f.endsWith('.mbp-1.csv'))
    .map(f => path.join(config.mbpDir, f))
    .sort();

  // Filter by date range if specified
  if (config.startDate || config.endDate) {
    const datePattern = /glbx-mdp3-(\d{8})\.mbp-1\.csv/;
    files = files.filter(f => {
      const match = path.basename(f).match(datePattern);
      if (!match) return false;
      const dateStr = match[1];
      const fileDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
      if (config.startDate && fileDate < config.startDate) return false;
      if (config.endDate && fileDate > config.endDate) return false;
      return true;
    });
  }

  console.log(`Found ${files.length} MBP-1 files to process\n`);

  if (files.length === 0) {
    console.log('No files to process.');
    process.exit(0);
  }

  // Process files with worker pool
  const startTime = Date.now();
  const allResults = [];
  let completed = 0;
  let totalUpdates = 0;
  let activeWorkers = 0;
  let fileIndex = 0;

  const processNext = () => {
    while (activeWorkers < config.workers && fileIndex < files.length) {
      const filepath = files[fileIndex++];
      activeWorkers++;

      const worker = new Worker(__filename, {
        workerData: { filepath, config }
      });

      worker.on('message', (msg) => {
        activeWorkers--;
        completed++;

        if (msg.success) {
          allResults.push(...msg.results);
          const dayUpdates = msg.results.reduce((sum, r) => sum + r.updates, 0);
          totalUpdates += dayUpdates;

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rate = (completed / elapsed * 60).toFixed(1);
          const eta = ((files.length - completed) / (completed / elapsed)).toFixed(0);

          process.stdout.write(
            `\r[${completed}/${files.length}] ${path.basename(msg.filepath)} - ` +
            `${dayUpdates.toLocaleString()} updates | ` +
            `${rate} files/min | ETA: ${eta}s    `
          );
        } else {
          console.error(`\nError processing ${msg.filepath}: ${msg.error}`);
        }

        processNext();
      });

      worker.on('error', (err) => {
        activeWorkers--;
        completed++;
        console.error(`\nWorker error: ${err.message}`);
        processNext();
      });
    }

    // Check if done
    if (completed === files.length && activeWorkers === 0) {
      finalize();
    }
  };

  const finalize = () => {
    console.log('\n\nSorting results...');

    // Sort by timestamp
    allResults.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`Writing ${allResults.length.toLocaleString()} records to ${config.outputFile}...`);

    // Ensure output directory exists
    const outputDir = path.dirname(config.outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write CSV
    const header = 'timestamp,updates,totalBidSize,totalAskSize,totalBidCount,totalAskCount,sizeImbalance,countImbalance,avgSizeImbalance,avgCountImbalance,bidAskRatio';
    const lines = [header];

    for (const r of allResults) {
      lines.push([
        new Date(r.timestamp).toISOString(),
        r.updates,
        r.totalBidSize,
        r.totalAskSize,
        r.totalBidCount,
        r.totalAskCount,
        r.sizeImbalance.toFixed(6),
        r.countImbalance.toFixed(6),
        r.avgSizeImbalance.toFixed(6),
        r.avgCountImbalance.toFixed(6),
        r.bidAskRatio.toFixed(6)
      ].join(','));
    }

    fs.writeFileSync(config.outputFile, lines.join('\n'));

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const fileSizeMB = (fs.statSync(config.outputFile).size / 1024 / 1024).toFixed(1);

    console.log('\n=== Precomputation Complete ===');
    console.log(`Files processed: ${files.length}`);
    console.log(`Total updates: ${totalUpdates.toLocaleString()}`);
    console.log(`Output records: ${allResults.length.toLocaleString()}`);
    console.log(`Output size: ${fileSizeMB} MB`);
    console.log(`Time elapsed: ${elapsed} minutes`);
  };

  // Start processing
  processNext();
}

// Run if main thread
if (isMainThread) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
