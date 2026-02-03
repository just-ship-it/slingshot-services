#!/usr/bin/env node

/**
 * Precompute CBBO Metrics
 *
 * Processes raw CBBO files (~350MB/day) and outputs a single CSV with
 * minute-level aggregated metrics. This speeds up backtest loading from
 * minutes to seconds.
 *
 * Usage:
 *   node scripts/precompute-cbbo-metrics.js [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 *
 * Output:
 *   data/cbbo-1m/cbbo-metrics-1m.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CBBOLoader } from '../src/data-loaders/cbbo-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let startDate = null;
  let endDate = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) {
      startDate = new Date(args[++i]);
    } else if (args[i] === '--end' && args[i + 1]) {
      endDate = new Date(args[++i]);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Precompute CBBO Metrics

Usage:
  node scripts/precompute-cbbo-metrics.js [options]

Options:
  --start YYYY-MM-DD   Start date (default: earliest available)
  --end YYYY-MM-DD     End date (default: latest available)
  --help, -h           Show this help

Output:
  data/cbbo-1m/cbbo-metrics-1m.csv
      `);
      process.exit(0);
    }
  }

  const dataDir = path.join(__dirname, '..', 'data', 'cbbo-1m', 'qqq');
  const outputPath = path.join(__dirname, '..', 'data', 'cbbo-1m', 'cbbo-metrics-1m.csv');

  console.log('🔄 CBBO Metrics Precomputation');
  console.log('─'.repeat(50));

  // Initialize loader
  const loader = new CBBOLoader(dataDir);

  // Get available date range
  const availableRange = loader.getAvailableDateRange();
  if (!availableRange.startDate) {
    console.error('❌ No CBBO files found in', dataDir);
    process.exit(1);
  }

  console.log(`📁 Data directory: ${dataDir}`);
  console.log(`📊 Available files: ${availableRange.fileCount}`);
  console.log(`📅 Available range: ${availableRange.startDate.toISOString().split('T')[0]} to ${availableRange.endDate.toISOString().split('T')[0]}`);

  // Use provided dates or defaults
  const start = startDate || availableRange.startDate;
  const end = endDate || availableRange.endDate;

  console.log(`\n🎯 Processing range: ${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`);
  console.log('─'.repeat(50));

  // Collect all metrics
  const allMetrics = new Map();
  let filesProcessed = 0;
  let totalRows = 0;

  // Get files to process
  const files = loader.getAvailableFiles();
  const datePattern = /opra-pillar-(\d{8})/;

  const filesToProcess = files.filter(filepath => {
    const match = path.basename(filepath).match(datePattern);
    if (!match) return false;

    const dateStr = match[1];
    const fileDate = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`);
    return fileDate >= start && fileDate <= end;
  });

  console.log(`📂 Files to process: ${filesToProcess.length}\n`);

  const startTime = Date.now();

  for (const filepath of filesToProcess) {
    const filename = path.basename(filepath);
    const match = filename.match(datePattern);
    const dateStr = match ? match[1] : 'unknown';

    process.stdout.write(`\r   Processing ${dateStr} (${filesProcessed + 1}/${filesToProcess.length})...`);

    const result = await loader.streamFile(filepath, (minuteTs, metrics) => {
      if (metrics) {
        allMetrics.set(minuteTs, metrics);
      }
    });

    totalRows += result.rowCount;
    filesProcessed++;

    // Clear the loader's internal map to save memory
    loader.metricsByMinute.clear();
  }

  const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n\n✅ Processing complete!`);
  console.log(`   Files processed: ${filesProcessed}`);
  console.log(`   Total rows read: ${totalRows.toLocaleString()}`);
  console.log(`   Minute records: ${allMetrics.size.toLocaleString()}`);
  console.log(`   Processing time: ${processingTime}s`);

  // Write output CSV
  console.log(`\n📝 Writing output to ${outputPath}...`);

  const sortedTimestamps = Array.from(allMetrics.keys()).sort((a, b) => a - b);

  const headers = [
    'timestamp',
    'avgSpread',
    'avgCallSpread',
    'avgPutSpread',
    'putCallSpreadRatio',
    'putCallSizeRatio',
    'callSizeImbalance',
    'putSizeImbalance',
    'overallSizeImbalance',
    'spreadVolatility',
    'quoteCount',
    'callCount',
    'putCount'
  ];

  const writeStream = fs.createWriteStream(outputPath);
  writeStream.write(headers.join(',') + '\n');

  for (const ts of sortedTimestamps) {
    const m = allMetrics.get(ts);
    const row = [
      new Date(ts).toISOString(),
      m.avgSpread?.toFixed(6) ?? '',
      m.avgCallSpread?.toFixed(6) ?? '',
      m.avgPutSpread?.toFixed(6) ?? '',
      m.putCallSpreadRatio?.toFixed(6) ?? '',
      m.putCallSizeRatio?.toFixed(6) ?? '',
      m.callSizeImbalance?.toFixed(6) ?? '',
      m.putSizeImbalance?.toFixed(6) ?? '',
      m.overallSizeImbalance?.toFixed(6) ?? '',
      m.spreadVolatility?.toFixed(6) ?? '',
      m.quoteCount ?? 0,
      m.callCount ?? 0,
      m.putCount ?? 0
    ];
    writeStream.write(row.join(',') + '\n');
  }

  writeStream.end();

  // Get file size
  await new Promise(resolve => writeStream.on('finish', resolve));
  const stats = fs.statSync(outputPath);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(`✅ Output written: ${outputPath}`);
  console.log(`   File size: ${fileSizeMB} MB`);
  console.log(`   Records: ${sortedTimestamps.length.toLocaleString()}`);

  // Date range in output
  if (sortedTimestamps.length > 0) {
    const firstDate = new Date(sortedTimestamps[0]).toISOString().split('T')[0];
    const lastDate = new Date(sortedTimestamps[sortedTimestamps.length - 1]).toISOString().split('T')[0];
    console.log(`   Date range: ${firstDate} to ${lastDate}`);
  }

  console.log('\n🎉 Precomputation complete! Backtests will now load CBBO data much faster.');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
