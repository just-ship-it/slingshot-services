/**
 * Test LT Failed Breakdown Strategy
 * Quick debug script to verify data loading and signal generation
 */

import fs from 'fs';
import readline from 'readline';

const LT_FILE = '/home/drew/projects/slingshot-services/backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv';
const OHLCV_FILE = '/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv';

async function loadLT(start, end) {
  const data = [];
  const startTs = new Date(start).getTime();
  const endTs = new Date(end).getTime();

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(LT_FILE);
    const rl = readline.createInterface({ input: fileStream });
    let lineCount = 0;

    rl.on('line', (line) => {
      lineCount++;
      if (lineCount === 1) return;

      const values = line.split(',');
      const ts = parseInt(values[1], 10);
      if (ts < startTs || ts > endTs) return;

      data.push({
        datetime: values[0],
        timestamp: ts,
        sentiment: values[2],
        level_1: parseFloat(values[3]),
        level_2: parseFloat(values[4]),
        level_3: parseFloat(values[5]),
        level_4: parseFloat(values[6]),
        level_5: parseFloat(values[7])
      });
    });

    rl.on('close', () => resolve(data));
    rl.on('error', reject);
  });
}

async function loadOHLCV(start, end) {
  const data = [];
  const startTs = new Date(start).getTime();
  const endTs = new Date(end).getTime();

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(OHLCV_FILE);
    const rl = readline.createInterface({ input: fileStream });
    let lineCount = 0;

    rl.on('line', (line) => {
      lineCount++;
      if (lineCount === 1) return;

      const values = line.split(',');
      const ts = new Date(values[0]).getTime();
      if (ts < startTs || ts > endTs) return;

      const symbol = values[values.length - 1];
      if (symbol?.includes('-')) return;

      data.push({
        timestamp: ts,
        close: parseFloat(values[7]),
        symbol
      });
    });

    rl.on('close', () => resolve(data));
    rl.on('error', reject);
  });
}

async function main() {
  const start = '2025-01-02';
  const end = '2025-01-10';

  console.log(`Loading data from ${start} to ${end}...\n`);

  const ltData = await loadLT(start, end);
  const ohlcvData = await loadOHLCV(start, end);

  console.log(`LT records: ${ltData.length}`);
  console.log(`OHLCV records: ${ohlcvData.length}`);

  // Show sample LT data
  console.log('\n=== Sample LT Data ===');
  for (let i = 0; i < Math.min(5, ltData.length); i++) {
    const lt = ltData[i];
    console.log(`${lt.datetime} | ${lt.sentiment} | L1: ${lt.level_1?.toFixed(2)} L2: ${lt.level_2?.toFixed(2)} L3: ${lt.level_3?.toFixed(2)}`);
  }

  // Find price near an LT level
  console.log('\n=== Checking for Level Crossings ===');

  // Create price map
  const priceMap = new Map();
  for (const c of ohlcvData) {
    priceMap.set(c.timestamp, c.close);
  }

  let crossings = 0;
  const crossingEvents = [];

  for (let i = 1; i < ltData.length && i < 500; i++) {
    const prev = ltData[i - 1];
    const curr = ltData[i];

    // Find prices at both times
    const prevPrice = priceMap.get(prev.timestamp);
    const currPrice = priceMap.get(curr.timestamp);

    if (!prevPrice || !currPrice) continue;

    // Check each level
    const levels = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];

    for (const levelKey of levels) {
      const levelValue = curr[levelKey];
      if (!levelValue) continue;

      // Downward crossing: was above, now below
      if (prevPrice > levelValue + 2 && currPrice < levelValue - 2) {
        crossings++;
        crossingEvents.push({
          time: curr.datetime,
          level: levelKey,
          value: levelValue,
          direction: 'down',
          prevPrice,
          currPrice
        });
      }
    }
  }

  console.log(`Found ${crossings} downward crossings in first 500 LT snapshots`);

  if (crossingEvents.length > 0) {
    console.log('\n=== Sample Crossings ===');
    for (let i = 0; i < Math.min(5, crossingEvents.length); i++) {
      const c = crossingEvents[i];
      console.log(`${c.time} | ${c.level} @ ${c.value.toFixed(2)} | price: ${c.prevPrice.toFixed(2)} → ${c.currPrice.toFixed(2)}`);
    }
  }

  // Check for failed breakdowns
  console.log('\n=== Checking for Failed Breakdowns ===');

  let failedBreakdowns = 0;

  for (const crossing of crossingEvents.slice(0, 50)) {
    const crossTime = new Date(crossing.time).getTime();
    const levelValue = crossing.value;

    // Look for return above level in next 10 LT snapshots
    for (let i = 0; i < ltData.length; i++) {
      if (ltData[i].timestamp <= crossTime) continue;
      if (ltData[i].timestamp > crossTime + 15 * 60 * 1000 * 10) break; // Max 10 15-min bars

      const returnPrice = priceMap.get(ltData[i].timestamp);
      if (returnPrice && returnPrice > levelValue + 2) {
        failedBreakdowns++;
        console.log(`  Failed breakdown at ${crossing.time}: ${levelValue.toFixed(2)} → returned at ${ltData[i].datetime}`);
        break;
      }
    }
  }

  console.log(`\nFound ${failedBreakdowns} failed breakdowns from ${Math.min(50, crossingEvents.length)} crossings`);
}

main().catch(console.error);
