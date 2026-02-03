/**
 * Debug script to examine LT data structure mismatch
 */

import { CSVLoader } from '../../src/data/csv-loader.js';
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

  console.log(`\nLoaded ${ltData.length} LT records`);

  if (ltData.length > 0) {
    console.log('\n=== Sample LT record ===');
    console.log(JSON.stringify(ltData[0], null, 2));

    console.log('\n=== LT record keys ===');
    console.log(Object.keys(ltData[0]));

    console.log('\n=== Level values from first record ===');
    const first = ltData[0];
    console.log('level_1:', first.level_1, typeof first.level_1);
    console.log('level_2:', first.level_2, typeof first.level_2);
    console.log('level_3:', first.level_3, typeof first.level_3);
    console.log('level_4:', first.level_4, typeof first.level_4);
    console.log('level_5:', first.level_5, typeof first.level_5);

    // Simulate getLevelsToCheck logic
    console.log('\n=== Simulating getLevelsToCheck ===');
    const tradeLevels = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
    const levels = [];
    const keys = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];

    for (const key of keys) {
      if (!tradeLevels.includes(key)) {
        console.log(`Skipping ${key} - not in tradeLevels`);
        continue;
      }

      const value = first[key];
      console.log(`Checking ${key}: value=${value}, isNaN=${isNaN(value)}`);
      if (value && !isNaN(value)) {
        levels.push({ key, value });
      }
    }

    console.log(`\nResulting levels array: ${levels.length} items`);
    console.log(levels);
  }
}

main().catch(console.error);
