/**
 * Debug getLTAtTime method behavior
 */

import { CSVLoader } from '../../src/data/csv-loader.js';
import { LTFailedBreakdownStrategy } from '../../../shared/strategies/lt-failed-breakdown.js';
import fs from 'fs';

const dataDir = '/home/drew/projects/slingshot-services/backtest-engine/data';
const configPath = '/home/drew/projects/slingshot-services/backtest-engine/src/config/default.json';

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const loader = new CSVLoader(dataDir, config);

  const startDate = new Date('2025-01-02');
  const endDate = new Date('2025-01-05');

  console.log('Loading LT data...');
  const ltData = await loader.loadLiquidityData('NQ', startDate, endDate);
  console.log(`Loaded ${ltData.length} records`);
  console.log(`First record timestamp: ${ltData[0].timestamp} = ${new Date(ltData[0].timestamp).toISOString()}`);
  console.log(`Last record timestamp: ${ltData[ltData.length-1].timestamp} = ${new Date(ltData[ltData.length-1].timestamp).toISOString()}`);

  // Create strategy and load LT data
  const strategy = new LTFailedBreakdownStrategy({ debug: true });
  strategy.loadLTData(ltData);

  console.log('\n=== Testing getLTAtTime ===');

  // Test with a timestamp in our date range
  const testTimestamps = [
    new Date('2025-01-02T15:00:00Z').getTime(),
    new Date('2025-01-02T18:00:00Z').getTime(),
    new Date('2025-01-03T00:00:00Z').getTime(),
    new Date('2025-01-03T14:30:00Z').getTime(),
  ];

  for (const ts of testTimestamps) {
    console.log(`\nTimestamp: ${new Date(ts).toISOString()}`);
    const result = strategy.getLTAtTime(ts);
    if (result) {
      console.log('  Found LT data:', {
        timestamp: new Date(result.timestamp).toISOString(),
        level_1: result.level_1,
        level_2: result.level_2,
        level_5: result.level_5
      });

      // Test getLevelsToCheck
      const levels = strategy.getLevelsToCheck(result);
      console.log(`  getLevelsToCheck returned: ${levels.length} levels`);
    } else {
      console.log('  No LT data found!');
    }
  }

  // Debug: check the actual LT levels array
  console.log('\n=== Strategy internal state ===');
  console.log('ltLevels length:', strategy.ltLevels?.length);
  console.log('ltIndex:', strategy.ltIndex);
  if (strategy.ltLevels?.length > 0) {
    console.log('First ltLevel keys:', Object.keys(strategy.ltLevels[0]));
    console.log('First ltLevel:', strategy.ltLevels[0]);
  }
}

main().catch(console.error);
