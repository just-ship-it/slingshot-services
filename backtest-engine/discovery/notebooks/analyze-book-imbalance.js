/**
 * Book Imbalance Data Analysis
 *
 * Explores the NQ order book imbalance dataset to find patterns
 * that predict subsequent price movement.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const DATA_DIR = '/home/drew/projects/slingshot-services/backtest-engine/data';
const BOOK_IMBALANCE_FILE = path.join(DATA_DIR, 'orderflow/nq/book-imbalance-1m.csv');
const OHLCV_FILE = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');

async function loadBookImbalance() {
  console.log('Loading book imbalance data...');
  const data = [];

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(BOOK_IMBALANCE_FILE);
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
      const record = {};
      headers.forEach((h, i) => { record[h] = values[i]; });

      data.push({
        timestamp: new Date(record.timestamp).getTime(),
        sizeImbalance: parseFloat(record.sizeImbalance),
        countImbalance: parseFloat(record.countImbalance),
        avgSizeImbalance: parseFloat(record.avgSizeImbalance),
        bidAskRatio: parseFloat(record.bidAskRatio),
        totalBidSize: parseInt(record.totalBidSize, 10),
        totalAskSize: parseInt(record.totalAskSize, 10)
      });
    });

    rl.on('close', () => {
      console.log(`Loaded ${data.length.toLocaleString()} book imbalance records`);
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

      // Filter by date range
      if (timestamp < start || timestamp > end) return;

      // Filter out calendar spreads
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
      // Filter to primary contract (highest volume per hour)
      const primaryFiltered = filterPrimaryContract(data);
      console.log(`Loaded ${primaryFiltered.length.toLocaleString()} OHLCV records (primary contract)`);
      resolve(primaryFiltered);
    });
    rl.on('error', reject);
  });
}

function filterPrimaryContract(candles) {
  // Group by hour and find highest volume contract
  const byHour = new Map();

  for (const c of candles) {
    const hourKey = Math.floor(c.timestamp / 3600000);
    if (!byHour.has(hourKey)) {
      byHour.set(hourKey, new Map());
    }
    const hourSymbols = byHour.get(hourKey);
    if (!hourSymbols.has(c.symbol)) {
      hourSymbols.set(c.symbol, { volume: 0, count: 0 });
    }
    const symbolData = hourSymbols.get(c.symbol);
    symbolData.volume += c.volume;
    symbolData.count++;
  }

  // Determine primary contract per hour
  const primaryByHour = new Map();
  for (const [hourKey, symbols] of byHour) {
    let maxVol = -1;
    let primary = null;
    for (const [symbol, data] of symbols) {
      if (data.volume > maxVol) {
        maxVol = data.volume;
        primary = symbol;
      }
    }
    primaryByHour.set(hourKey, primary);
  }

  // Filter candles
  return candles.filter(c => {
    const hourKey = Math.floor(c.timestamp / 3600000);
    return c.symbol === primaryByHour.get(hourKey);
  });
}

function analyzeImbalanceDistribution(imbalanceData) {
  console.log('\n=== BOOK IMBALANCE DISTRIBUTION ===');

  const sizeImbalances = imbalanceData.map(d => d.sizeImbalance).filter(v => !isNaN(v));

  // Basic statistics
  const sorted = [...sizeImbalances].sort((a, b) => a - b);
  const mean = sizeImbalances.reduce((a, b) => a + b, 0) / sizeImbalances.length;
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  console.log(`Count: ${sizeImbalances.length.toLocaleString()}`);
  console.log(`Min: ${min.toFixed(4)}, Max: ${max.toFixed(4)}`);
  console.log(`Mean: ${mean.toFixed(4)}`);
  console.log(`P10: ${p10.toFixed(4)}, P25: ${p25.toFixed(4)}, P50 (median): ${p50.toFixed(4)}`);
  console.log(`P75: ${p75.toFixed(4)}, P90: ${p90.toFixed(4)}`);

  // Count extreme values
  const strongBullish = sizeImbalances.filter(v => v > 0.3).length;
  const bullish = sizeImbalances.filter(v => v > 0.1 && v <= 0.3).length;
  const neutral = sizeImbalances.filter(v => v >= -0.1 && v <= 0.1).length;
  const bearish = sizeImbalances.filter(v => v < -0.1 && v >= -0.3).length;
  const strongBearish = sizeImbalances.filter(v => v < -0.3).length;

  console.log('\nImbalance Distribution:');
  console.log(`Strong Bullish (>0.3): ${strongBullish.toLocaleString()} (${(100*strongBullish/sizeImbalances.length).toFixed(1)}%)`);
  console.log(`Bullish (0.1-0.3): ${bullish.toLocaleString()} (${(100*bullish/sizeImbalances.length).toFixed(1)}%)`);
  console.log(`Neutral (-0.1 to 0.1): ${neutral.toLocaleString()} (${(100*neutral/sizeImbalances.length).toFixed(1)}%)`);
  console.log(`Bearish (-0.3 to -0.1): ${bearish.toLocaleString()} (${(100*bearish/sizeImbalances.length).toFixed(1)}%)`);
  console.log(`Strong Bearish (<-0.3): ${strongBearish.toLocaleString()} (${(100*strongBearish/sizeImbalances.length).toFixed(1)}%)`);

  return { mean, p10, p25, p50, p75, p90 };
}

function analyzeImbalancePricePrediction(imbalanceData, ohlcvData, lookforward = 5) {
  console.log(`\n=== IMBALANCE → PRICE PREDICTION (${lookforward} bars forward) ===`);

  // Create OHLCV lookup
  const ohlcvMap = new Map();
  for (const c of ohlcvData) {
    ohlcvMap.set(c.timestamp, c);
  }

  // Analyze imbalance thresholds
  const thresholds = [0.1, 0.2, 0.3, 0.4, 0.5];

  for (const threshold of thresholds) {
    let bullishSignals = 0, bullishCorrect = 0, bullishPnL = 0;
    let bearishSignals = 0, bearishCorrect = 0, bearishPnL = 0;

    for (let i = 0; i < imbalanceData.length; i++) {
      const imb = imbalanceData[i];
      const currentCandle = ohlcvMap.get(imb.timestamp);

      if (!currentCandle) continue;

      // Look forward
      const futureTimestamp = imb.timestamp + (lookforward * 60000);
      const futureCandle = ohlcvMap.get(futureTimestamp);

      if (!futureCandle) continue;

      const priceChange = futureCandle.close - currentCandle.close;

      // Bullish signal: strong positive imbalance
      if (imb.sizeImbalance > threshold) {
        bullishSignals++;
        if (priceChange > 0) {
          bullishCorrect++;
        }
        bullishPnL += priceChange;
      }

      // Bearish signal: strong negative imbalance
      if (imb.sizeImbalance < -threshold) {
        bearishSignals++;
        if (priceChange < 0) {
          bearishCorrect++;
        }
        bearishPnL -= priceChange; // Negative change = profit for short
      }
    }

    const bullishWR = bullishSignals > 0 ? (100 * bullishCorrect / bullishSignals).toFixed(1) : 'N/A';
    const bearishWR = bearishSignals > 0 ? (100 * bearishCorrect / bearishSignals).toFixed(1) : 'N/A';
    const bullishAvg = bullishSignals > 0 ? (bullishPnL / bullishSignals).toFixed(2) : 'N/A';
    const bearishAvg = bearishSignals > 0 ? (bearishPnL / bearishSignals).toFixed(2) : 'N/A';

    console.log(`\nThreshold: ±${threshold}`);
    console.log(`  LONG when imb > ${threshold}: ${bullishSignals} signals, ${bullishWR}% WR, avg P&L: ${bullishAvg} pts`);
    console.log(`  SHORT when imb < -${threshold}: ${bearishSignals} signals, ${bearishWR}% WR, avg P&L: ${bearishAvg} pts`);
  }
}

function analyzeImbalanceMomentum(imbalanceData, ohlcvData, lookback = 3) {
  console.log(`\n=== IMBALANCE MOMENTUM (${lookback} bar trend) ===`);

  // Create OHLCV lookup
  const ohlcvMap = new Map();
  for (const c of ohlcvData) {
    ohlcvMap.set(c.timestamp, c);
  }

  // Sort imbalance data by timestamp
  const sorted = [...imbalanceData].sort((a, b) => a.timestamp - b.timestamp);

  let risingImbalanceLong = 0, risingImbalanceLongCorrect = 0, risingPnL = 0;
  let fallingImbalanceShort = 0, fallingImbalanceShortCorrect = 0, fallingPnL = 0;

  for (let i = lookback; i < sorted.length - 5; i++) {
    const current = sorted[i];

    // Check if we have lookback data
    const prev = [];
    for (let j = 1; j <= lookback; j++) {
      prev.push(sorted[i - j]);
    }

    // Calculate imbalance momentum
    const imbalanceSlope = (current.sizeImbalance - prev[lookback - 1].sizeImbalance) / lookback;

    const currentCandle = ohlcvMap.get(current.timestamp);
    if (!currentCandle) continue;

    const futureCandle = ohlcvMap.get(current.timestamp + 5 * 60000);
    if (!futureCandle) continue;

    const priceChange = futureCandle.close - currentCandle.close;

    // Rising imbalance momentum (turning bullish) → LONG
    if (imbalanceSlope > 0.05 && current.sizeImbalance > 0) {
      risingImbalanceLong++;
      if (priceChange > 0) risingImbalanceLongCorrect++;
      risingPnL += priceChange;
    }

    // Falling imbalance momentum (turning bearish) → SHORT
    if (imbalanceSlope < -0.05 && current.sizeImbalance < 0) {
      fallingImbalanceShort++;
      if (priceChange < 0) fallingImbalanceShortCorrect++;
      fallingPnL -= priceChange;
    }
  }

  console.log(`\nRising Imbalance Momentum (slope > 0.05, imb > 0) → LONG:`);
  console.log(`  Signals: ${risingImbalanceLong}, Win Rate: ${(100*risingImbalanceLongCorrect/risingImbalanceLong).toFixed(1)}%`);
  console.log(`  Total P&L: ${risingPnL.toFixed(2)} pts, Avg: ${(risingPnL/risingImbalanceLong).toFixed(2)} pts`);

  console.log(`\nFalling Imbalance Momentum (slope < -0.05, imb < 0) → SHORT:`);
  console.log(`  Signals: ${fallingImbalanceShort}, Win Rate: ${(100*fallingImbalanceShortCorrect/fallingImbalanceShort).toFixed(1)}%`);
  console.log(`  Total P&L: ${fallingPnL.toFixed(2)} pts, Avg: ${(fallingPnL/fallingImbalanceShort).toFixed(2)} pts`);
}

async function main() {
  try {
    // Load data
    const imbalanceData = await loadBookImbalance();

    // Get date range of imbalance data
    const sortedTimestamps = imbalanceData.map(d => d.timestamp).sort((a, b) => a - b);
    const startDate = new Date(sortedTimestamps[0]).toISOString().split('T')[0];
    const endDate = new Date(sortedTimestamps[sortedTimestamps.length - 1]).toISOString().split('T')[0];

    console.log(`\nBook Imbalance Date Range: ${startDate} to ${endDate}`);

    const ohlcvData = await loadOHLCV(startDate, endDate);

    // Analysis
    analyzeImbalanceDistribution(imbalanceData);
    analyzeImbalancePricePrediction(imbalanceData, ohlcvData, 5);
    analyzeImbalancePricePrediction(imbalanceData, ohlcvData, 15);
    analyzeImbalanceMomentum(imbalanceData, ohlcvData, 3);

    console.log('\n=== ANALYSIS COMPLETE ===');

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
