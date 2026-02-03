/**
 * Debug LT timestamp loading
 */

import { CSVLoader } from '../../src/data/csv-loader.js';
import fs from 'fs';
import path from 'path';

const dataDir = '/home/drew/projects/slingshot-services/backtest-engine/data';
const configPath = '/home/drew/projects/slingshot-services/backtest-engine/src/config/default.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const loader = new CSVLoader(dataDir, config);

async function main() {
  const start = new Date('2025-01-02');
  const end = new Date('2025-01-05');

  console.log('Loading LT data...');
  const ltData = await loader.loadLiquidityData('nq', start, end);

  console.log(`Loaded ${ltData.length} records`);

  if (ltData.length > 0) {
    console.log('\nFirst 5 LT records:');
    for (let i = 0; i < Math.min(5, ltData.length); i++) {
      const lt = ltData[i];
      console.log(`  ${lt.datetime} -> timestamp: ${lt.timestamp} -> ${new Date(lt.timestamp).toISOString()}`);
    }
  }

  console.log('\nLoading OHLCV data...');
  const ohlcv = await loader.loadOHLCVData('nq', start, end);

  console.log(`Loaded ${ohlcv.candles.length} OHLCV candles`);

  if (ohlcv.candles.length > 0) {
    console.log('\nFirst 5 OHLCV records:');
    for (let i = 0; i < Math.min(5, ohlcv.candles.length); i++) {
      const c = ohlcv.candles[i];
      console.log(`  timestamp: ${c.timestamp} -> ${new Date(c.timestamp).toISOString()} | close: ${c.close}`);
    }
  }

  // Check timestamp overlap
  const ltTsSet = new Set(ltData.map(lt => lt.timestamp));
  const ohlcvTsSet = new Set(ohlcv.candles.map(c => c.timestamp));

  let overlapping = 0;
  for (const ts of ohlcvTsSet) {
    if (ltTsSet.has(ts)) overlapping++;
  }

  console.log(`\nTimestamp overlap: ${overlapping} of ${ohlcvTsSet.size} OHLCV timestamps have matching LT`);

  // Check if LT timestamp is offset from candle
  if (ltData.length > 0 && ohlcv.candles.length > 0) {
    console.log('\nChecking timestamp alignment:');
    const ltTs = ltData[0].timestamp;
    const ohlcvTs = ohlcv.candles[0].timestamp;
    console.log(`  First LT: ${ltTs} (${new Date(ltTs).toISOString()})`);
    console.log(`  First OHLCV: ${ohlcvTs} (${new Date(ohlcvTs).toISOString()})`);
    console.log(`  Diff: ${ltTs - ohlcvTs} ms = ${(ltTs - ohlcvTs) / 3600000} hours`);
  }
}

main().catch(console.error);
