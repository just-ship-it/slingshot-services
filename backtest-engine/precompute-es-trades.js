#!/usr/bin/env node
/**
 * Precompute ES Trade Aggregates from Databento Trade Data
 *
 * Processes all ES trades CSV files and saves per-minute aggregated metrics.
 * Uses worker_threads for parallel processing (4 workers).
 *
 * Input:  data/orderflow/es/trades/glbx-mdp3-*.trades.csv
 * Output: data/orderflow/es/trade-ofi-1m.csv
 *
 * Columns per 1-minute bucket:
 *   timestamp, buyVolume, sellVolume, netVolume, totalVolume,
 *   buyTrades, sellTrades, totalTrades, volumeImbalance,
 *   avgTradeSize, maxTradeSize, largeTradeBuyVol, largeTradeSellVol,
 *   vwap, avgBuySize, avgSellSize, tradeImbalance
 *
 * Usage:
 *   node precompute-es-trades.js [options]
 *
 * Options:
 *   --symbol ES         Symbol filter (default: ES)
 *   --output FILE       Output CSV path
 *   --start YYYY-MM-DD  Start date
 *   --end YYYY-MM-DD    End date
 *   --workers N         Parallel workers (default: 4)
 *   --large-threshold N Large trade threshold in contracts (default: 10)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG = {
  tradesDir: path.join(__dirname, 'data/orderflow/es/trades'),
  outputFile: path.join(__dirname, 'data/orderflow/es/trade-ofi-1m.csv'),
  symbol: 'ES',
  excludeSpreads: true,
  candleDurationMs: 60000,
  workers: 4,
  largeThreshold: 10 // ES contracts - $50/pt multiplier, 10 contracts = significant
};

/**
 * Generate minute-aligned timestamps for a full trading day
 */
function generateDayMinutes(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  const minutes = [];
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
 * Process a single trades file — runs in worker thread
 */
async function processFile(filepath, config) {
  return new Promise((resolve, reject) => {
    const dateMatch = path.basename(filepath).match(/glbx-mdp3-(\d{8})\.trades\.csv/);
    if (!dateMatch) {
      resolve([]);
      return;
    }

    const dateStr = `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`;
    const minuteTimes = generateDayMinutes(dateStr);

    // Initialize buckets with extended fields
    const buckets = new Map();
    for (const minTime of minuteTimes) {
      buckets.set(minTime, {
        timestamp: minTime,
        buyVolume: 0,
        sellVolume: 0,
        buyTrades: 0,
        sellTrades: 0,
        maxTradeSize: 0,
        largeTradeBuyVol: 0,
        largeTradeSellVol: 0,
        priceVolumeSum: 0,  // for VWAP
        totalVolume: 0,
        buySizeSum: 0,
        sellSizeSum: 0
      });
    }

    // Track volume per symbol per hour for primary contract filtering
    const hourlySymbolVolume = new Map();

    let headers = null;
    let lineCount = 0;
    // Store raw trades per bucket temporarily for primary contract filtering
    const rawBucketTrades = new Map();

    const fileStream = fs.createReadStream(filepath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lineCount++;
      if (lineCount === 1) {
        headers = line.split(',');
        return;
      }

      const values = line.split(',');
      if (values.length !== headers.length) return;

      // Build record from headers
      const record = {};
      headers.forEach((header, i) => { record[header] = values[i]; });

      // Only trade records
      if (record.action !== 'T') return;

      const symbol = record.symbol?.trim();
      if (!symbol) return;

      // Exclude calendar spreads
      if (config.excludeSpreads && symbol.includes('-')) return;

      // Apply symbol filter
      if (config.symbol && !symbol.startsWith(config.symbol)) return;

      const timestamp = new Date(record.ts_event).getTime();
      const price = parseFloat(record.price);
      const size = parseInt(record.size, 10);
      const side = record.side; // 'A' = buy aggressor, 'B' = sell aggressor

      if (isNaN(price) || isNaN(size) || size <= 0) return;

      // Track hourly volume per symbol for primary contract selection
      const hourKey = Math.floor(timestamp / 3600000);
      if (!hourlySymbolVolume.has(hourKey)) {
        hourlySymbolVolume.set(hourKey, new Map());
      }
      const hourSymbols = hourlySymbolVolume.get(hourKey);
      hourSymbols.set(symbol, (hourSymbols.get(symbol) || 0) + size);

      // Store trade with bucket reference
      const bucketIdx = findMinuteBucket(minuteTimes, timestamp, config.candleDurationMs);
      if (bucketIdx < 0) return;

      const minTime = minuteTimes[bucketIdx];
      if (!rawBucketTrades.has(minTime)) {
        rawBucketTrades.set(minTime, []);
      }
      rawBucketTrades.get(minTime).push({ timestamp, price, size, side, symbol, hourKey });
    });

    rl.on('close', () => {
      // Determine primary contract per hour
      const primaryByHour = new Map();
      for (const [hourKey, symbolVols] of hourlySymbolVolume) {
        let maxVol = 0;
        let primary = '';
        for (const [sym, vol] of symbolVols) {
          if (vol > maxVol) {
            maxVol = vol;
            primary = sym;
          }
        }
        primaryByHour.set(hourKey, primary);
      }

      // Now aggregate only primary contract trades into buckets
      for (const [minTime, trades] of rawBucketTrades) {
        const bucket = buckets.get(minTime);
        if (!bucket) continue;

        for (const trade of trades) {
          // Filter to primary contract
          const primary = primaryByHour.get(trade.hourKey);
          if (primary && trade.symbol !== primary) continue;

          bucket.totalVolume += trade.size;
          bucket.priceVolumeSum += trade.price * trade.size;

          if (trade.size > bucket.maxTradeSize) {
            bucket.maxTradeSize = trade.size;
          }

          if (trade.side === 'A') {
            // Buy aggressor
            bucket.buyVolume += trade.size;
            bucket.buyTrades++;
            bucket.buySizeSum += trade.size;
            if (trade.size >= config.largeThreshold) {
              bucket.largeTradeBuyVol += trade.size;
            }
          } else if (trade.side === 'B') {
            // Sell aggressor
            bucket.sellVolume += trade.size;
            bucket.sellTrades++;
            bucket.sellSizeSum += trade.size;
            if (trade.size >= config.largeThreshold) {
              bucket.largeTradeSellVol += trade.size;
            }
          }
        }
      }

      // Calculate final metrics and filter empty buckets
      const results = [];
      for (const [timestamp, data] of buckets) {
        if (data.totalVolume === 0) continue;

        const netVolume = data.buyVolume - data.sellVolume;
        const totalTrades = data.buyTrades + data.sellTrades;
        const volumeImbalance = data.totalVolume > 0
          ? netVolume / data.totalVolume
          : 0;
        const tradeImbalance = totalTrades > 0
          ? (data.buyTrades - data.sellTrades) / totalTrades
          : 0;
        const avgTradeSize = totalTrades > 0
          ? data.totalVolume / totalTrades
          : 0;
        const vwap = data.totalVolume > 0
          ? data.priceVolumeSum / data.totalVolume
          : 0;
        const avgBuySize = data.buyTrades > 0
          ? data.buySizeSum / data.buyTrades
          : 0;
        const avgSellSize = data.sellTrades > 0
          ? data.sellSizeSum / data.sellTrades
          : 0;

        results.push({
          timestamp,
          buyVolume: data.buyVolume,
          sellVolume: data.sellVolume,
          netVolume,
          totalVolume: data.totalVolume,
          buyTrades: data.buyTrades,
          sellTrades: data.sellTrades,
          totalTrades,
          volumeImbalance,
          avgTradeSize,
          maxTradeSize: data.maxTradeSize,
          largeTradeBuyVol: data.largeTradeBuyVol,
          largeTradeSellVol: data.largeTradeSellVol,
          vwap,
          avgBuySize,
          avgSellSize,
          tradeImbalance
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
      case '--large-threshold':
        config.largeThreshold = parseInt(args[++i], 10);
        break;
      case '--help':
        console.log(`
Precompute ES Trade Aggregates

Usage: node precompute-es-trades.js [options]

Options:
  --symbol ES            Symbol filter (default: ES)
  --output FILE          Output CSV path
  --start YYYY-MM-DD     Start date
  --end YYYY-MM-DD       End date
  --workers N            Parallel workers (default: 4)
  --large-threshold N    Large trade threshold (default: 10)
`);
        process.exit(0);
    }
  }

  console.log('=== ES Trade Aggregate Precomputation ===\n');
  console.log(`Symbol: ${config.symbol}`);
  console.log(`Trades Dir: ${config.tradesDir}`);
  console.log(`Output: ${config.outputFile}`);
  console.log(`Workers: ${config.workers}`);
  console.log(`Large trade threshold: ${config.largeThreshold} contracts`);
  console.log('');

  if (!fs.existsSync(config.tradesDir)) {
    console.error(`Error: Trades directory not found: ${config.tradesDir}`);
    process.exit(1);
  }

  let files = fs.readdirSync(config.tradesDir)
    .filter(f => f.endsWith('.trades.csv'))
    .map(f => path.join(config.tradesDir, f))
    .sort();

  // Filter by date range
  if (config.startDate || config.endDate) {
    const datePattern = /glbx-mdp3-(\d{8})\.trades\.csv/;
    files = files.filter(f => {
      const match = path.basename(f).match(datePattern);
      if (!match) return false;
      const dateStr = match[1];
      const fileDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
      if (config.startDate && fileDate < config.startDate) return false;
      if (config.endDate && fileDate > config.endDate) return false;
      return true;
    });
  }

  console.log(`Found ${files.length} trade files to process\n`);

  if (files.length === 0) {
    console.log('No files to process.');
    process.exit(0);
  }

  // Process with worker pool
  const startTime = Date.now();
  const allResults = [];
  let completed = 0;
  let totalTrades = 0;
  let activeWorkers = 0;
  let fileIndex = 0;

  return new Promise((resolve) => {
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
            const dayTrades = msg.results.reduce((sum, r) => sum + r.totalTrades, 0);
            totalTrades += dayTrades;

            const elapsed = (Date.now() - startTime) / 1000;
            const rate = (completed / elapsed * 60).toFixed(1);
            const eta = ((files.length - completed) / (completed / elapsed)).toFixed(0);

            process.stdout.write(
              `\r[${completed}/${files.length}] ${path.basename(msg.filepath)} - ` +
              `${dayTrades.toLocaleString()} trades | ` +
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

      if (completed === files.length && activeWorkers === 0) {
        finalize();
      }
    };

    const finalize = () => {
      console.log('\n\nSorting results...');
      allResults.sort((a, b) => a.timestamp - b.timestamp);

      console.log(`Writing ${allResults.length.toLocaleString()} records to ${config.outputFile}...`);

      const outputDir = path.dirname(config.outputFile);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const header = 'timestamp,buyVolume,sellVolume,netVolume,totalVolume,buyTrades,sellTrades,totalTrades,volumeImbalance,avgTradeSize,maxTradeSize,largeTradeBuyVol,largeTradeSellVol,vwap,avgBuySize,avgSellSize,tradeImbalance';
      const lines = [header];

      for (const r of allResults) {
        lines.push([
          new Date(r.timestamp).toISOString(),
          r.buyVolume,
          r.sellVolume,
          r.netVolume,
          r.totalVolume,
          r.buyTrades,
          r.sellTrades,
          r.totalTrades,
          r.volumeImbalance.toFixed(6),
          r.avgTradeSize.toFixed(2),
          r.maxTradeSize,
          r.largeTradeBuyVol,
          r.largeTradeSellVol,
          r.vwap.toFixed(6),
          r.avgBuySize.toFixed(2),
          r.avgSellSize.toFixed(2),
          r.tradeImbalance.toFixed(6)
        ].join(','));
      }

      fs.writeFileSync(config.outputFile, lines.join('\n'));

      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const fileSizeMB = (fs.statSync(config.outputFile).size / 1024 / 1024).toFixed(1);

      console.log('\n=== Precomputation Complete ===');
      console.log(`Files processed: ${files.length}`);
      console.log(`Total trades: ${totalTrades.toLocaleString()}`);
      console.log(`Output records: ${allResults.length.toLocaleString()}`);
      console.log(`Output size: ${fileSizeMB} MB`);
      console.log(`Time elapsed: ${elapsed} minutes`);
      resolve();
    };

    processNext();
  });
}

if (isMainThread) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
