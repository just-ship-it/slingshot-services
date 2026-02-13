#!/usr/bin/env node

/**
 * Quick test to verify strategy timing - when exactly are trades triggered?
 */

import { CSVLoader } from './src/data/csv-loader.js';
import { CandleAggregator } from '../shared/utils/candle-aggregator.js';
import { GexRecoilStrategy } from '../shared/strategies/gex-recoil.js';
import fs from 'fs';
import path from 'path';

// Load config
const defaultConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'src/config/default.json');
const config = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

async function testTiming() {
  const csvLoader = new CSVLoader('./data', config);
  const aggregator = new CandleAggregator();
  const strategy = new GexRecoilStrategy();

  console.log('🔍 Testing Strategy Timing - When Do Trades Trigger?');
  console.log('═'.repeat(60));

  // Load small amount of data
  const startDate = new Date('2023-03-28');
  const endDate = new Date('2023-03-29');

  const [ohlcvData, gexData] = await Promise.all([
    csvLoader.loadOHLCVData('NQ', startDate, endDate),
    csvLoader.loadGEXData('NQ', startDate, endDate)
  ]);

  // Aggregate to 15m
  const candles15m = aggregator.aggregate(ohlcvData, '15m');

  console.log(`📊 Sample of 15-minute candle timestamps:`);
  candles15m.slice(0, 10).forEach(candle => {
    const date = new Date(candle.timestamp);
    console.log(`   ${date.toISOString()} (${date.getUTCHours()}:${date.getUTCMinutes().toString().padStart(2, '0')} UTC)`);
  });

  console.log(`\n🎯 Checking for trade signals...`);

  // Create market data lookup
  const gexMap = new Map();
  gexData.forEach(gex => {
    const dateKey = new Date(gex.date).toDateString();
    gexMap.set(dateKey, gex);
  });

  let prevCandle = null;
  let signalCount = 0;

  for (const candle of candles15m.slice(0, 20)) { // Check first 20 candles
    if (prevCandle) {
      const dateKey = new Date(candle.timestamp).toDateString();
      const gexLevels = gexMap.get(dateKey);

      if (gexLevels) {
        const marketData = { gexLevels, ltLevels: null };
        const signal = strategy.evaluateSignal(candle, prevCandle, marketData);

        if (signal) {
          signalCount++;
          const date = new Date(candle.timestamp);
          console.log(`\n📊 SIGNAL #${signalCount}:`);
          console.log(`   Timestamp: ${date.toISOString()}`);
          console.log(`   Time: ${date.getUTCHours()}:${date.getUTCMinutes().toString().padStart(2, '0')} UTC`);
          console.log(`   Entry Price: ${signal.entryPrice}`);
          console.log(`   GEX Level: ${signal.metadata.gex_level} (${signal.metadata.gex_level_type})`);
          console.log(`   Previous Close: ${prevCandle.close}`);
          console.log(`   Current Close: ${candle.close}`);

          // Show the 15-minute candle period this represents
          console.log(`   15m Period: ${date.toISOString()} (candle close time)`);
        }
      }
    }
    prevCandle = candle;
  }

  console.log(`\n✅ Analysis Complete`);
  console.log(`   Signals found: ${signalCount}`);
  console.log(`   ⏰ Key Point: Trades trigger when 15-minute candles CLOSE below GEX levels`);
  console.log(`   📅 This happens at: :00, :15, :30, :45 minutes past the hour`);
}

testTiming().catch(console.error);