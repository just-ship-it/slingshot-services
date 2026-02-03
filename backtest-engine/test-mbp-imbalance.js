/**
 * Quick test for MBP-1 book imbalance data
 */

import { MBPLoader } from './src/data/mbp-loader.js';
import { CSVLoader } from './src/data/csv-loader.js';
import fs from 'fs';
import path from 'path';

// Load config
const defaultConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'src/config/default.json');
const config = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

async function main() {
  console.log('=== MBP-1 Book Imbalance Test ===\n');

  // Check available data
  const mbpLoader = new MBPLoader({
    dataDir: 'data/orderflow/nq/mbp-1',
    symbolFilter: 'NQ'
  });

  const dateRange = mbpLoader.getAvailableDateRange();
  console.log('Available MBP-1 data:');
  console.log(`  Start: ${dateRange.startDate?.toISOString().split('T')[0]}`);
  console.log(`  End: ${dateRange.endDate?.toISOString().split('T')[0]}`);
  console.log(`  Files: ${dateRange.fileCount}`);
  console.log('');

  // Load a single day of candles
  console.log('Loading candles for Jan 2, 2025...');
  const csvLoader = new CSVLoader('./data', config);
  const ohlcvData = await csvLoader.loadOHLCVData('NQ', new Date('2025-01-02'), new Date('2025-01-03'));
  // Filter to just Jan 2
  const candles = ohlcvData.candles.filter(c => {
    const d = new Date(c.timestamp);
    return d >= new Date('2025-01-02T00:00:00Z') && d < new Date('2025-01-03T00:00:00Z');
  });
  console.log(`  Loaded ${candles.length} candles`);
  console.log('');

  // Compute imbalance for that day
  console.log('Computing book imbalance (this may take a minute for large files)...');
  const startTime = Date.now();

  const imbalanceMap = await mbpLoader.computeImbalanceForDateRange(
    '2025-01-02',
    '2025-01-02',
    candles,
    (days, updates) => {
      process.stdout.write(`\r  Processing day ${days}, ${updates.toLocaleString()} updates...`);
    }
  );

  console.log(`\n  Completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`  Candles with data: ${[...imbalanceMap.values()].filter(d => d.updates > 0).length}`);
  console.log('');

  // Show sample results
  console.log('Sample imbalance data (first 10 candles with data):');
  console.log('-'.repeat(100));
  console.log('Time                  | Updates |  Bid Size  |  Ask Size  | Size Imbal | Count Imbal | Ratio');
  console.log('-'.repeat(100));

  let count = 0;
  for (const [timestamp, data] of imbalanceMap) {
    if (data.updates > 0 && count < 10) {
      const time = new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19);
      console.log(
        `${time} | ${String(data.updates).padStart(7)} | ` +
        `${String(data.totalBidSize).padStart(10)} | ${String(data.totalAskSize).padStart(10)} | ` +
        `${data.sizeImbalance.toFixed(4).padStart(10)} | ${data.avgCountImbalance.toFixed(4).padStart(11)} | ` +
        `${data.bidAskRatio.toFixed(2).padStart(5)}`
      );
      count++;
    }
  }
  console.log('-'.repeat(100));

  // Distribution analysis
  const withData = [...imbalanceMap.values()].filter(d => d.updates > 0);
  if (withData.length > 0) {
    console.log('\nImbalance Distribution:');

    const imbalances = withData.map(d => d.sizeImbalance);
    const sorted = [...imbalances].sort((a, b) => a - b);

    console.log(`  Min:    ${sorted[0].toFixed(4)}`);
    console.log(`  25th:   ${sorted[Math.floor(sorted.length * 0.25)].toFixed(4)}`);
    console.log(`  Median: ${sorted[Math.floor(sorted.length * 0.5)].toFixed(4)}`);
    console.log(`  75th:   ${sorted[Math.floor(sorted.length * 0.75)].toFixed(4)}`);
    console.log(`  Max:    ${sorted[sorted.length - 1].toFixed(4)}`);

    // Count by category
    const strongBullish = imbalances.filter(i => i > 0.3).length;
    const bullish = imbalances.filter(i => i > 0.1 && i <= 0.3).length;
    const neutral = imbalances.filter(i => i >= -0.1 && i <= 0.1).length;
    const bearish = imbalances.filter(i => i < -0.1 && i >= -0.3).length;
    const strongBearish = imbalances.filter(i => i < -0.3).length;

    console.log('\n  Distribution:');
    console.log(`    Strong Bullish (>0.3):  ${strongBullish} (${(strongBullish/imbalances.length*100).toFixed(1)}%)`);
    console.log(`    Bullish (0.1 to 0.3):   ${bullish} (${(bullish/imbalances.length*100).toFixed(1)}%)`);
    console.log(`    Neutral (-0.1 to 0.1):  ${neutral} (${(neutral/imbalances.length*100).toFixed(1)}%)`);
    console.log(`    Bearish (-0.3 to -0.1): ${bearish} (${(bearish/imbalances.length*100).toFixed(1)}%)`);
    console.log(`    Strong Bearish (<-0.3): ${strongBearish} (${(strongBearish/imbalances.length*100).toFixed(1)}%)`);
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
