/**
 * LT Level Crossing Analysis
 *
 * Analyzes liquidity trigger level crossings through price to test
 * the 74% directional accuracy claim from CLAUDE.md.
 *
 * Key insight from documentation:
 * - Level crossings through price predict post-volatility-event direction at ~74% accuracy
 * - Which Fibonacci lookback crossed matters
 * - Migration direction provides additional signal
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const DATA_DIR = '/home/drew/projects/slingshot-services/backtest-engine/data';
const LT_FILE = path.join(DATA_DIR, 'liquidity/nq/NQ_liquidity_levels.csv');
const OHLCV_FILE = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');

async function loadLTLevels() {
  console.log('Loading LT levels...');
  const data = [];

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(LT_FILE);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let lineCount = 0;

    rl.on('line', (line) => {
      lineCount++;
      if (lineCount === 1) return; // Skip header

      const values = line.split(',');
      data.push({
        datetime: values[0],
        timestamp: parseInt(values[1], 10),
        sentiment: values[2],
        level_1: parseFloat(values[3]), // Fib 34
        level_2: parseFloat(values[4]), // Fib 55
        level_3: parseFloat(values[5]), // Fib 144
        level_4: parseFloat(values[6]), // Fib 377
        level_5: parseFloat(values[7])  // Fib 610
      });
    });

    rl.on('close', () => {
      console.log(`Loaded ${data.length.toLocaleString()} LT level records`);
      resolve(data);
    });
    rl.on('error', reject);
  });
}

async function loadOHLCV(startDate, endDate) {
  console.log(`Loading OHLCV data from ${startDate} to ${endDate}...`);
  const data = [];
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(OHLCV_FILE);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let headers = null;
    let lineCount = 0;

    rl.on('line', (line) => {
      lineCount++;
      if (lineCount === 1) {
        headers = line.split(',');
        return;
      }

      const values = line.split(',');
      const timestamp = new Date(values[0]).getTime();

      if (timestamp < start || timestamp > end) return;

      const symbol = values[values.length - 1];
      if (symbol?.includes('-')) return;

      data.push({
        timestamp,
        open: parseFloat(values[4]),
        high: parseFloat(values[5]),
        low: parseFloat(values[6]),
        close: parseFloat(values[7]),
        volume: parseInt(values[8], 10),
        symbol
      });
    });

    rl.on('close', () => {
      const primaryFiltered = filterPrimaryContract(data);
      console.log(`Loaded ${primaryFiltered.length.toLocaleString()} OHLCV records`);
      resolve(primaryFiltered);
    });
    rl.on('error', reject);
  });
}

function filterPrimaryContract(candles) {
  const byHour = new Map();

  for (const c of candles) {
    const hourKey = Math.floor(c.timestamp / 3600000);
    if (!byHour.has(hourKey)) byHour.set(hourKey, new Map());
    const hourSymbols = byHour.get(hourKey);
    if (!hourSymbols.has(c.symbol)) hourSymbols.set(c.symbol, { volume: 0 });
    hourSymbols.get(c.symbol).volume += c.volume;
  }

  const primaryByHour = new Map();
  for (const [hourKey, symbols] of byHour) {
    let maxVol = -1, primary = null;
    for (const [symbol, data] of symbols) {
      if (data.volume > maxVol) { maxVol = data.volume; primary = symbol; }
    }
    primaryByHour.set(hourKey, primary);
  }

  return candles.filter(c => {
    const hourKey = Math.floor(c.timestamp / 3600000);
    return c.symbol === primaryByHour.get(hourKey);
  });
}

function getPriceAtTime(ohlcvMap, timestamp) {
  const candle = ohlcvMap.get(timestamp);
  if (candle) return candle.close;

  // Find nearest candle within 1 minute
  for (let offset = 60000; offset <= 900000; offset += 60000) {
    const before = ohlcvMap.get(timestamp - offset);
    if (before) return before.close;
    const after = ohlcvMap.get(timestamp + offset);
    if (after) return after.close;
  }
  return null;
}

function detectLevelCrossings(ltData, ohlcvMap) {
  console.log('\n=== DETECTING LEVEL CROSSINGS ===');

  const crossings = [];

  for (let i = 1; i < ltData.length; i++) {
    const prev = ltData[i - 1];
    const curr = ltData[i];

    const prevPrice = getPriceAtTime(ohlcvMap, prev.timestamp);
    const currPrice = getPriceAtTime(ohlcvMap, curr.timestamp);

    if (!prevPrice || !currPrice) continue;

    // Check each level for crossings
    const levels = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
    const fibLookbacks = { level_1: 34, level_2: 55, level_3: 144, level_4: 377, level_5: 610 };

    for (const levelKey of levels) {
      const levelValue = curr[levelKey];

      // Level crossed from below to above (price was below, now above)
      if (prevPrice < levelValue && currPrice >= levelValue) {
        crossings.push({
          timestamp: curr.timestamp,
          datetime: curr.datetime,
          levelKey,
          fibLookback: fibLookbacks[levelKey],
          levelValue,
          crossDirection: 'upward', // Price crossed UP through level
          priceAtCross: currPrice,
          sentiment: curr.sentiment
        });
      }

      // Level crossed from above to below (price was above, now below)
      if (prevPrice > levelValue && currPrice <= levelValue) {
        crossings.push({
          timestamp: curr.timestamp,
          datetime: curr.datetime,
          levelKey,
          fibLookback: fibLookbacks[levelKey],
          levelValue,
          crossDirection: 'downward', // Price crossed DOWN through level
          priceAtCross: currPrice,
          sentiment: curr.sentiment
        });
      }
    }
  }

  console.log(`Found ${crossings.length.toLocaleString()} level crossings`);
  return crossings;
}

function analyzeCrossingPrediction(crossings, ohlcvMap, lookforwardMinutes = 5) {
  console.log(`\n=== CROSSING PREDICTION ANALYSIS (${lookforwardMinutes} min forward) ===`);

  const results = {
    upward: { total: 0, priceUp: 0, priceDown: 0, pnl: 0 },
    downward: { total: 0, priceUp: 0, priceDown: 0, pnl: 0 }
  };

  const byFib = {};
  const bySentiment = { BULLISH: { correct: 0, total: 0 }, BEARISH: { correct: 0, total: 0 } };

  for (const cross of crossings) {
    const futureTimestamp = cross.timestamp + (lookforwardMinutes * 60000);
    const futurePrice = getPriceAtTime(ohlcvMap, futureTimestamp);

    if (!futurePrice) continue;

    const priceChange = futurePrice - cross.priceAtCross;

    // Initialize fib tracking
    const fibKey = cross.fibLookback;
    if (!byFib[fibKey]) {
      byFib[fibKey] = {
        upward: { total: 0, correct: 0, pnl: 0 },
        downward: { total: 0, correct: 0, pnl: 0 }
      };
    }

    if (cross.crossDirection === 'upward') {
      results.upward.total++;
      byFib[fibKey].upward.total++;

      if (priceChange > 0) {
        results.upward.priceUp++;
        byFib[fibKey].upward.correct++;
      } else {
        results.upward.priceDown++;
      }
      results.upward.pnl += priceChange;
      byFib[fibKey].upward.pnl += priceChange;

      // Sentiment tracking - upward cross = expect price to continue up
      if (cross.sentiment === 'BULLISH') {
        bySentiment.BULLISH.total++;
        if (priceChange > 0) bySentiment.BULLISH.correct++;
      } else {
        bySentiment.BEARISH.total++;
        if (priceChange > 0) bySentiment.BEARISH.correct++;
      }
    } else {
      results.downward.total++;
      byFib[fibKey].downward.total++;

      if (priceChange < 0) {
        results.downward.priceDown++;
        byFib[fibKey].downward.correct++;
      } else {
        results.downward.priceUp++;
      }
      results.downward.pnl -= priceChange; // Short trade
      byFib[fibKey].downward.pnl -= priceChange;
    }
  }

  // Print overall results
  console.log('\n=== OVERALL CROSSING RESULTS ===');

  const upwardWR = results.upward.total > 0 ?
    (100 * results.upward.priceUp / results.upward.total).toFixed(1) : 'N/A';
  const downwardWR = results.downward.total > 0 ?
    (100 * results.downward.priceDown / results.downward.total).toFixed(1) : 'N/A';

  console.log(`\nUPWARD crossings (price breaks above level) → LONG:`);
  console.log(`  Total: ${results.upward.total}, Price continued up: ${results.upward.priceUp} (${upwardWR}%)`);
  console.log(`  Avg P&L if traded LONG: ${(results.upward.pnl / results.upward.total).toFixed(2)} pts`);

  console.log(`\nDOWNWARD crossings (price breaks below level) → SHORT:`);
  console.log(`  Total: ${results.downward.total}, Price continued down: ${results.downward.priceDown} (${downwardWR}%)`);
  console.log(`  Avg P&L if traded SHORT: ${(results.downward.pnl / results.downward.total).toFixed(2)} pts`);

  // By Fibonacci lookback
  console.log('\n=== BY FIBONACCI LOOKBACK ===');
  for (const fibKey of Object.keys(byFib).sort((a, b) => parseInt(a) - parseInt(b))) {
    const fib = byFib[fibKey];

    const upWR = fib.upward.total > 0 ?
      (100 * fib.upward.correct / fib.upward.total).toFixed(1) : 'N/A';
    const dnWR = fib.downward.total > 0 ?
      (100 * fib.downward.correct / fib.downward.total).toFixed(1) : 'N/A';

    console.log(`\nFib ${fibKey}:`);
    console.log(`  Upward: ${fib.upward.total} crossings, ${upWR}% continue up, avg P&L: ${(fib.upward.pnl / fib.upward.total || 0).toFixed(2)} pts`);
    console.log(`  Downward: ${fib.downward.total} crossings, ${dnWR}% continue down, avg P&L: ${(fib.downward.pnl / fib.downward.total || 0).toFixed(2)} pts`);
  }

  // By sentiment
  console.log('\n=== BY SENTIMENT (for upward crossings) ===');
  for (const sentiment of ['BULLISH', 'BEARISH']) {
    const s = bySentiment[sentiment];
    const wr = s.total > 0 ? (100 * s.correct / s.total).toFixed(1) : 'N/A';
    console.log(`${sentiment}: ${s.total} signals, ${wr}% correct (price went up)`);
  }

  return results;
}

function analyzeReversalCrossings(crossings, ohlcvMap) {
  console.log('\n=== REVERSAL STRATEGY (fade the crossing) ===');
  console.log('Theory: If price briefly crosses a level then reverses, we can fade the move.');

  const lookback = 15; // Minutes to wait for reversal
  const lookforward = 30; // Minutes to measure outcome

  let fadeUpward = { total: 0, correct: 0, pnl: 0 };
  let fadeDownward = { total: 0, correct: 0, pnl: 0 };

  for (const cross of crossings) {
    // Check if price returned to level after crossing
    let returned = false;
    let returnPrice = null;
    let returnTime = null;

    for (let i = 1; i <= lookback; i++) {
      const checkTime = cross.timestamp + (i * 60000);
      const checkPrice = getPriceAtTime(ohlcvMap, checkTime);
      if (!checkPrice) continue;

      // Upward cross: returned means price went back below level
      if (cross.crossDirection === 'upward' && checkPrice < cross.levelValue) {
        returned = true;
        returnPrice = checkPrice;
        returnTime = checkTime;
        break;
      }

      // Downward cross: returned means price went back above level
      if (cross.crossDirection === 'downward' && checkPrice > cross.levelValue) {
        returned = true;
        returnPrice = checkPrice;
        returnTime = checkTime;
        break;
      }
    }

    if (!returned || !returnTime) continue;

    // Now measure outcome from the return point
    const outcomeTime = returnTime + (lookforward * 60000);
    const outcomePrice = getPriceAtTime(ohlcvMap, outcomeTime);
    if (!outcomePrice) continue;

    const pnl = outcomePrice - returnPrice;

    if (cross.crossDirection === 'upward') {
      // Fade upward cross = go SHORT when price returns below level
      fadeUpward.total++;
      if (pnl < 0) {
        fadeUpward.correct++;
        fadeUpward.pnl -= pnl; // Negative pnl = profit for short
      } else {
        fadeUpward.pnl -= pnl; // Track actual P&L
      }
    } else {
      // Fade downward cross = go LONG when price returns above level
      fadeDownward.total++;
      if (pnl > 0) {
        fadeDownward.correct++;
        fadeDownward.pnl += pnl;
      } else {
        fadeDownward.pnl += pnl;
      }
    }
  }

  console.log(`\nFade UPWARD crossing (SHORT when price returns below level):`);
  console.log(`  Signals: ${fadeUpward.total}`);
  console.log(`  Win Rate: ${(100 * fadeUpward.correct / fadeUpward.total).toFixed(1)}%`);
  console.log(`  Avg P&L: ${(fadeUpward.pnl / fadeUpward.total).toFixed(2)} pts`);

  console.log(`\nFade DOWNWARD crossing (LONG when price returns above level):`);
  console.log(`  Signals: ${fadeDownward.total}`);
  console.log(`  Win Rate: ${(100 * fadeDownward.correct / fadeDownward.total).toFixed(1)}%`);
  console.log(`  Avg P&L: ${(fadeDownward.pnl / fadeDownward.total).toFixed(2)} pts`);
}

async function main() {
  try {
    const ltData = await loadLTLevels();

    // Get date range
    const sortedTimestamps = ltData.map(d => d.timestamp).sort((a, b) => a - b);
    const startDate = new Date(sortedTimestamps[0]).toISOString().split('T')[0];
    const endDate = new Date(sortedTimestamps[sortedTimestamps.length - 1]).toISOString().split('T')[0];

    console.log(`\nLT Level Date Range: ${startDate} to ${endDate}`);

    // Load OHLCV for recent period (2025 for faster processing)
    const ohlcvData = await loadOHLCV('2025-01-01', '2025-12-31');

    // Create lookup map
    const ohlcvMap = new Map();
    for (const c of ohlcvData) {
      ohlcvMap.set(c.timestamp, c);
    }

    // Filter LT data to match OHLCV range
    const filteredLT = ltData.filter(lt =>
      lt.timestamp >= new Date('2025-01-01').getTime() &&
      lt.timestamp <= new Date('2025-12-31').getTime()
    );
    console.log(`Filtered LT data to 2025: ${filteredLT.length.toLocaleString()} records`);

    // Detect crossings
    const crossings = detectLevelCrossings(filteredLT, ohlcvMap);

    // Analyze prediction accuracy
    analyzeCrossingPrediction(crossings, ohlcvMap, 5);  // 5 min forward
    analyzeCrossingPrediction(crossings, ohlcvMap, 15); // 15 min forward
    analyzeCrossingPrediction(crossings, ohlcvMap, 30); // 30 min forward

    // Analyze reversal strategy
    analyzeReversalCrossings(crossings, ohlcvMap);

    console.log('\n=== ANALYSIS COMPLETE ===');

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
