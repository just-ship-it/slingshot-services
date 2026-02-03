#!/usr/bin/env node
/**
 * Verify data filtering is correctly handling:
 * 1. Calendar spreads (symbol with -)
 * 2. Primary contract selection
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  ohlcvFile: path.join(__dirname, 'data/ohlcv/nq/NQ_ohlcv_1m.csv'),
};

async function loadRawOHLCV(startDate, endDate) {
  return new Promise((resolve, reject) => {
    const candles = [];
    const calendarSpreads = [];
    let headers = null;
    const stream = fs.createReadStream(CONFIG.ohlcvFile);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headers) { headers = line.split(','); return; }
      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);

      const timestamp = new Date(record.ts_event).getTime();
      const date = new Date(timestamp);
      if (date < startDate || date > endDate) return;

      const candle = {
        timestamp,
        open: parseFloat(record.open),
        high: parseFloat(record.high),
        low: parseFloat(record.low),
        close: parseFloat(record.close),
        volume: parseInt(record.volume),
        symbol: record.symbol
      };

      // Track calendar spreads separately
      if (record.symbol?.includes('-')) {
        calendarSpreads.push(candle);
      } else {
        candles.push(candle);
      }
    });

    rl.on('close', () => {
      candles.sort((a, b) => a.timestamp - b.timestamp);
      resolve({ candles, calendarSpreads });
    });
    rl.on('error', reject);
  });
}

function filterPrimaryContract(candles) {
  const hourlyVolume = new Map();
  candles.forEach(c => {
    const hourKey = Math.floor(c.timestamp / (60 * 60 * 1000));
    if (!hourlyVolume.has(hourKey)) hourlyVolume.set(hourKey, new Map());
    const symbolVol = hourlyVolume.get(hourKey);
    symbolVol.set(c.symbol, (symbolVol.get(c.symbol) || 0) + c.volume);
  });

  const hourlyPrimary = new Map();
  hourlyVolume.forEach((symbolVol, hourKey) => {
    let maxVol = 0, primary = null;
    symbolVol.forEach((vol, sym) => {
      if (vol > maxVol) { maxVol = vol; primary = sym; }
    });
    hourlyPrimary.set(hourKey, primary);
  });

  return candles.filter(c => {
    const hourKey = Math.floor(c.timestamp / (60 * 60 * 1000));
    return c.symbol === hourlyPrimary.get(hourKey);
  });
}

async function main() {
  const startDate = new Date('2025-01-02');
  const endDate = new Date('2025-01-25');

  console.log('=== Data Filtering Verification ===\n');
  console.log(`Period: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)}\n`);

  const { candles, calendarSpreads } = await loadRawOHLCV(startDate, endDate);

  console.log('=== Raw Data Loaded ===');
  console.log(`Regular candles: ${candles.length}`);
  console.log(`Calendar spreads filtered out: ${calendarSpreads.length}`);

  // Check unique symbols
  const symbols = new Set(candles.map(c => c.symbol));
  console.log(`\nUnique symbols in regular candles: ${[...symbols].join(', ')}`);

  // Verify no calendar spreads snuck through
  const spreadsInCandles = candles.filter(c => c.symbol.includes('-'));
  console.log(`Calendar spreads in candle data: ${spreadsInCandles.length} (should be 0)`);

  // Sample calendar spreads
  if (calendarSpreads.length > 0) {
    console.log('\n=== Sample Calendar Spreads (filtered out) ===');
    for (const cs of calendarSpreads.slice(0, 5)) {
      const timeStr = new Date(cs.timestamp).toISOString();
      console.log(`${timeStr} | ${cs.symbol} | Close: ${cs.close.toFixed(2)}`);
    }
  }

  // Apply primary contract filter
  const primaryCandles = filterPrimaryContract(candles);
  console.log(`\n=== After Primary Contract Filter ===`);
  console.log(`Candles before filter: ${candles.length}`);
  console.log(`Candles after filter: ${primaryCandles.length}`);
  console.log(`Removed: ${candles.length - primaryCandles.length} (${((candles.length - primaryCandles.length) / candles.length * 100).toFixed(1)}%)`);

  // Check for duplicate timestamps
  const timestampCounts = new Map();
  primaryCandles.forEach(c => {
    timestampCounts.set(c.timestamp, (timestampCounts.get(c.timestamp) || 0) + 1);
  });

  const duplicates = [...timestampCounts.entries()].filter(([_, count]) => count > 1);
  console.log(`\nDuplicate timestamps after filter: ${duplicates.length} (should be 0)`);

  if (duplicates.length > 0) {
    console.log('\n!!! WARNING: Duplicate timestamps found !!!');
    for (const [ts, count] of duplicates.slice(0, 5)) {
      const candles = primaryCandles.filter(c => c.timestamp === ts);
      console.log(`${new Date(ts).toISOString()}: ${count} candles`);
      for (const c of candles) {
        console.log(`  ${c.symbol} Close: ${c.close.toFixed(2)}`);
      }
    }
  }

  // Check price consistency over time
  console.log('\n=== Price Continuity Check ===');

  let maxJump = 0;
  let maxJumpIdx = 0;

  for (let i = 1; i < primaryCandles.length; i++) {
    const prev = primaryCandles[i - 1];
    const curr = primaryCandles[i];

    // Skip if different days (overnight gap expected)
    const prevDate = new Date(prev.timestamp).toDateString();
    const currDate = new Date(curr.timestamp).toDateString();
    if (prevDate !== currDate) continue;

    const jump = Math.abs(curr.close - prev.close);
    if (jump > maxJump) {
      maxJump = jump;
      maxJumpIdx = i;
    }
  }

  const jumpCandle = primaryCandles[maxJumpIdx];
  const prevCandle = primaryCandles[maxJumpIdx - 1];

  console.log(`Max intraday price jump: ${maxJump.toFixed(2)} pts`);
  console.log(`  From: ${new Date(prevCandle.timestamp).toISOString()} | ${prevCandle.symbol} | ${prevCandle.close.toFixed(2)}`);
  console.log(`  To:   ${new Date(jumpCandle.timestamp).toISOString()} | ${jumpCandle.symbol} | ${jumpCandle.close.toFixed(2)}`);

  if (maxJump > 100) {
    console.log(`\n!!! WARNING: Large price jump (${maxJump.toFixed(2)} pts) detected !!!`);
    console.log('This might indicate a contract switch issue.');
  } else {
    console.log('\nPrice continuity looks reasonable (no jumps > 100 pts)');
  }

  // Check contract transitions
  console.log('\n=== Contract Transitions ===');

  let lastSymbol = null;
  const transitions = [];

  for (const c of primaryCandles) {
    if (lastSymbol && c.symbol !== lastSymbol) {
      transitions.push({
        time: c.timestamp,
        from: lastSymbol,
        to: c.symbol,
        price: c.close
      });
    }
    lastSymbol = c.symbol;
  }

  console.log(`Total contract transitions: ${transitions.length}`);
  for (const t of transitions.slice(0, 10)) {
    console.log(`${new Date(t.time).toISOString()} | ${t.from} -> ${t.to} | Price: ${t.price.toFixed(2)}`);
  }

  // Verify specific timestamps have single candle
  console.log('\n=== Spot Check Specific Timestamps ===');

  const testTimes = [
    new Date('2025-01-13T15:00:00.000Z').getTime(),
    new Date('2025-01-14T15:00:00.000Z').getTime(),
    new Date('2025-01-15T15:00:00.000Z').getTime(),
  ];

  for (const ts of testTimes) {
    const matchingCandles = primaryCandles.filter(c => c.timestamp === ts);
    console.log(`${new Date(ts).toISOString()}:`);
    if (matchingCandles.length === 0) {
      console.log('  No candle found');
    } else if (matchingCandles.length === 1) {
      const c = matchingCandles[0];
      console.log(`  OK - Single candle: ${c.symbol} | Close: ${c.close.toFixed(2)}`);
    } else {
      console.log(`  !!! ${matchingCandles.length} candles found !!!`);
      for (const c of matchingCandles) {
        console.log(`    ${c.symbol} | Close: ${c.close.toFixed(2)}`);
      }
    }
  }

  console.log('\n=== Verification Complete ===');
}

main().catch(console.error);
