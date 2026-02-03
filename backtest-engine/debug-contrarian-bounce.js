#!/usr/bin/env node
/**
 * Debug script to understand why signal frequency is low
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';

const config = {
  ticker: 'NQ',
  startDate: new Date('2025-10-01'),
  endDate: new Date('2025-10-31'), // Just October
  timeframe: '15m',
  strategy: 'contrarian-bounce',
  strategyParams: {
    tradingSymbol: 'NQ',
    defaultQuantity: 1,
    stopBuffer: 15.0,
    maxRisk: 50.0,
    useGexLevelStops: true,
    targetMode: 'gamma_flip',
    signalCooldownMs: 900000,
    requirePositiveGex: false,
    useTimeFilter: false,
    useSentimentFilter: false,
    useDistanceFilter: false,
    useIvFilter: false,
    allowLong: true,
    allowShort: false
  },
  commission: 5,
  initialCapital: 100000,
  dataDir: 'data',
  quiet: false,
  verbose: true,
  debugMode: true
};

async function debug() {
  console.log('Loading data to analyze GEX availability...\n');

  const engine = new BacktestEngine(config);

  // Access the loaded data
  const data = await engine.loadData();

  console.log('\n=== DATA SUMMARY ===');
  console.log(`Candles loaded: ${data.candles.length}`);
  console.log(`GEX snapshots: ${data.gexLevels?.size || 0}`);

  // Sample some candles and check GEX availability
  let candlesWithGex = 0;
  let candlesBelowGammaFlip = 0;
  let gexSamples = [];

  for (let i = 0; i < Math.min(data.candles.length, 1000); i++) {
    const candle = data.candles[i];
    const candleTime = new Date(candle.timestamp);

    // Get GEX for this candle time
    const gexKey = candleTime.toISOString().split('.')[0] + 'Z';
    const gex = data.gexLevels?.get(gexKey);

    if (gex && gex.gamma_flip) {
      candlesWithGex++;

      if (candle.close < gex.gamma_flip) {
        candlesBelowGammaFlip++;
      }

      if (gexSamples.length < 10) {
        gexSamples.push({
          time: candleTime.toISOString(),
          price: candle.close,
          gammaFlip: gex.gamma_flip,
          belowFlip: candle.close < gex.gamma_flip,
          distance: gex.gamma_flip - candle.close
        });
      }
    }
  }

  console.log(`\n=== GEX AVAILABILITY (first 1000 candles) ===`);
  console.log(`Candles with GEX data: ${candlesWithGex}`);
  console.log(`Candles below gamma flip: ${candlesBelowGammaFlip}`);
  console.log(`Percentage below flip: ${((candlesBelowGammaFlip / candlesWithGex) * 100).toFixed(1)}%`);

  console.log('\n=== SAMPLE GEX DATA ===');
  gexSamples.forEach(s => {
    console.log(`${s.time} | Price: ${s.price.toFixed(2)} | Flip: ${s.gammaFlip.toFixed(2)} | Below: ${s.belowFlip} | Dist: ${s.distance.toFixed(2)}`);
  });

  // Check GEX timestamp format
  console.log('\n=== GEX KEY FORMAT CHECK ===');
  const gexKeys = Array.from(data.gexLevels?.keys() || []).slice(0, 5);
  console.log('Sample GEX keys:', gexKeys);

  const candleTimes = data.candles.slice(0, 5).map(c => new Date(c.timestamp).toISOString().split('.')[0] + 'Z');
  console.log('Sample candle times:', candleTimes);

  // Run actual backtest
  console.log('\n=== RUNNING BACKTEST ===');
  const results = await engine.run();

  console.log(`\nTrades generated: ${results.trades?.length || 0}`);

  if (results.trades && results.trades.length > 0) {
    console.log('\n=== FIRST 5 TRADES ===');
    results.trades.slice(0, 5).forEach((t, i) => {
      console.log(`Trade ${i + 1}:`);
      console.log(`  Entry: ${t.entryTime} @ ${t.entryPrice}`);
      console.log(`  Exit: ${t.exitTime} @ ${t.exitPrice}`);
      console.log(`  P&L: $${t.pnl?.toFixed(2)}`);
      console.log(`  Reason: ${t.metadata?.entry_reason || 'N/A'}`);
    });
  }
}

debug().catch(console.error);
