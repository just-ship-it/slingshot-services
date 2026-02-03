#!/usr/bin/env node
/**
 * Debug script to trace exactly what the backtest sees at signal time
 */

import { BacktestEngine } from './src/backtest-engine.js';

async function main() {
  console.log('=== Backtest Trace Debug ===\n');

  // Create a minimal backtest config
  const config = {
    ticker: 'NQ',
    startDate: new Date('2025-01-02'),
    endDate: new Date('2025-01-03'),
    timeframe: '1m',
    strategy: 'gex-absorption',
    strategyParams: {},
    commission: 5,
    initialCapital: 100000,
    dataDir: './data',
    verbose: false,
    quiet: true,
    useSecondResolution: false
  };

  const engine = new BacktestEngine(config);
  const data = await engine.loadData();

  console.log(`Loaded ${data.candles.length} candles\n`);

  // Find candles around 15:00 UTC on Jan 2
  const targetTime = new Date('2025-01-02T15:00:00.000Z').getTime();
  const windowCandles = data.candles.filter(c =>
    c.timestamp >= targetTime - 30 * 60 * 1000 &&
    c.timestamp <= targetTime + 30 * 60 * 1000
  );

  console.log('=== Candles around 15:00 UTC ===');
  for (const c of windowCandles) {
    const time = new Date(c.timestamp).toISOString();
    const estTime = new Date(c.timestamp).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit'
    });
    console.log(`${time} (${estTime}) | ${c.symbol} | Close=${c.close.toFixed(2)} | Vol=${c.volume}`);
  }

  // Check the specific 15:00 candle
  const candle1500 = data.candles.find(c => c.timestamp === targetTime);
  console.log('\n=== Target 15:00 Candle ===');
  if (candle1500) {
    console.log(`Found: ${candle1500.symbol} Close=${candle1500.close}`);
  } else {
    console.log('NOT FOUND - checking nearby...');
    const sorted = [...data.candles]
      .map(c => ({ ...c, dist: Math.abs(c.timestamp - targetTime) }))
      .sort((a, b) => a.dist - b.dist);
    console.log(`Nearest: ${new Date(sorted[0].timestamp).toISOString()} (${sorted[0].dist / 1000}s away)`);
  }

  // Check book imbalance at 15:00
  console.log('\n=== Book Imbalance at 15:00 ===');
  const bookData = data.bookImbalanceMap?.get(targetTime);
  if (bookData) {
    console.log(`  imbalance: ${bookData.sizeImbalance}`);
    console.log(`  totalVolume: ${(bookData.totalBidSize || 0) + (bookData.totalAskSize || 0)}`);
  } else {
    console.log('  NOT FOUND');
  }

  // Check GEX levels
  console.log('\n=== GEX Levels at 15:00 ===');
  const gexLevels = data.gexLoader.getGexLevels(new Date(targetTime));
  if (gexLevels) {
    console.log(`  Support: S1=${gexLevels.support?.[0]?.toFixed(0)}, S2=${gexLevels.support?.[1]?.toFixed(0)}, S3=${gexLevels.support?.[2]?.toFixed(0)}`);
    console.log(`  Resistance: R1=${gexLevels.resistance?.[0]?.toFixed(0)}, R2=${gexLevels.resistance?.[1]?.toFixed(0)}`);
  } else {
    console.log('  NOT FOUND');
  }

  // Now manually run the strategy on the first few candles to trace signals
  console.log('\n=== Manual Strategy Trace ===');

  // Get strategy with debug enabled
  const strategy = engine.strategy;
  strategy.params.debug = true;

  // Load book imbalance data
  if (data.bookImbalanceMap) {
    strategy.loadBookImbalanceData(data.bookImbalanceMap);
  }

  // Process candles starting from 30 minutes before target
  const startIdx = data.candles.findIndex(c => c.timestamp >= targetTime - 30 * 60 * 1000);
  const endIdx = data.candles.findIndex(c => c.timestamp > targetTime + 30 * 60 * 1000);

  console.log(`\nProcessing candles ${startIdx} to ${endIdx}...\n`);

  let signalCount = 0;
  for (let i = Math.max(0, startIdx); i < Math.min(endIdx, data.candles.length); i++) {
    const candle = data.candles[i];
    const prevCandle = i > 0 ? data.candles[i - 1] : null;

    const marketData = {
      gexLevels: data.gexLoader.getGexLevels(new Date(candle.timestamp))
    };

    const time = new Date(candle.timestamp).toISOString().slice(11, 19);
    const estTime = new Date(candle.timestamp).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit'
    });

    // Get slope before evaluating
    const slopeBefore = strategy.calculatePriceSlope(strategy.params.priceSlopeLookback);

    const signal = strategy.evaluateSignal(candle, prevCandle, marketData, {});

    if (signal) {
      signalCount++;
      console.log(`\n🎯 SIGNAL #${signalCount} at ${time} (${estTime})`);
      console.log(`   Candle: ${candle.symbol} Close=${candle.close.toFixed(2)}`);
      console.log(`   Side: ${signal.side}`);
      console.log(`   Level: ${signal.levelType} @ ${signal.levelPrice?.toFixed(2)}`);
      console.log(`   Distance: ${signal.levelDistance?.toFixed(2)}`);
      console.log(`   Price Slope: ${slopeBefore?.toFixed(4)}`);
      console.log(`   Book Imbalance: ${signal.bookImbalance?.toFixed(4)}`);

      if (signalCount >= 3) {
        console.log('\n(Stopping after 3 signals)');
        break;
      }
    }
  }

  if (signalCount === 0) {
    console.log('No signals generated in the window!');

    // Debug why no signal at 15:00
    const candle1500Idx = data.candles.findIndex(c => c.timestamp === targetTime);
    if (candle1500Idx >= 0) {
      console.log('\n=== Debug: Why no signal at 15:00? ===');

      // Reset strategy and process up to target
      strategy.reset();
      for (let i = Math.max(0, candle1500Idx - 50); i < candle1500Idx; i++) {
        const c = data.candles[i];
        const mc = { gexLevels: data.gexLoader.getGexLevels(new Date(c.timestamp)) };
        strategy.evaluateSignal(c, i > 0 ? data.candles[i - 1] : null, mc, {});
      }

      // Now check target candle
      const targetCandle = data.candles[candle1500Idx];
      const targetMarketData = { gexLevels: data.gexLoader.getGexLevels(new Date(targetCandle.timestamp)) };

      console.log(`Target candle: ${targetCandle.symbol} @ ${targetCandle.close}`);
      console.log(`Price history length: ${strategy.priceHistory.length}`);
      console.log(`Price slope: ${strategy.calculatePriceSlope(5)?.toFixed(4)}`);
      console.log(`Session check: ${strategy.isInAllowedSession(targetCandle.timestamp)}`);

      const nearestS = strategy.findNearestLevel(targetCandle.close, targetMarketData.gexLevels, 'support');
      const nearestR = strategy.findNearestLevel(targetCandle.close, targetMarketData.gexLevels, 'resistance');
      console.log(`Nearest support: ${nearestS ? `${nearestS.type} @ ${nearestS.level} (dist=${nearestS.distance.toFixed(1)})` : 'none within threshold'}`);
      console.log(`Nearest resistance: ${nearestR ? `${nearestR.type} @ ${nearestR.level} (dist=${nearestR.distance.toFixed(1)})` : 'none within threshold'}`);

      const bookData = strategy.getBookImbalance(targetCandle.timestamp);
      if (bookData) {
        const absorption = strategy.checkAbsorption(bookData);
        console.log(`Book imbalance: ${bookData.sizeImbalance?.toFixed(4)}`);
        console.log(`Absorption: ${absorption.isAbsorption} (balanced=${absorption.isBalanced}, hasVolume=${absorption.hasVolume})`);
      } else {
        console.log('Book data: NOT FOUND');
      }
    }
  }

  console.log('\n=== Debug Complete ===');
}

main().catch(console.error);
