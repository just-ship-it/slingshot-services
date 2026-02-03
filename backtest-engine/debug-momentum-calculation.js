#!/usr/bin/env node

// Debug momentum calculation for specific timestamp
// Compare with chart data to find discrepancy

import { BacktestEngine } from './src/backtest-engine.js';
import { SqueezeMomentumIndicator } from '../shared/indicators/squeeze-momentum.js';

console.log('🔍 Momentum Calculation Debug - December 10, 2025, 8:30 AM EST\n');

const targetTimestamp = 1765373400000; // Dec 10, 2025, 8:30 AM EST
const targetDate = new Date(targetTimestamp).toLocaleString('en-US', {timeZone: 'America/New_York'});
console.log(`Target: ${targetDate} (${targetTimestamp})\n`);

async function debugMomentumCalculation() {
  // Create backtest config
  const backtestConfig = {
    ticker: 'NQ',
    startDate: new Date('2025-12-08'),
    endDate: new Date('2025-12-12'),
    timeframe: '15m',
    strategy: 'gex-level-sweep',
    strategyParams: {},
    dataDir: './data',
    verbose: false,
    quiet: true
  };

  // Create the backtest engine
  const engine = new BacktestEngine(backtestConfig);

  // Load data
  const data = await engine.loadData();
  console.log(`📊 Loaded ${data.candles.length} 15m candles\n`);

  // Find the target candle and surrounding candles
  let targetCandleIndex = -1;
  for (let i = 0; i < data.candles.length; i++) {
    if (data.candles[i].timestamp === targetTimestamp) {
      targetCandleIndex = i;
      break;
    }
  }

  if (targetCandleIndex === -1) {
    console.log('❌ Target candle not found!');
    return;
  }

  console.log(`🎯 Found target candle at index ${targetCandleIndex}`);
  const targetCandle = data.candles[targetCandleIndex];
  console.log(`📊 Target Candle: O=${targetCandle.open} H=${targetCandle.high} L=${targetCandle.low} C=${targetCandle.close}\n`);

  // Get 50 candles leading up to target (more historical data)
  const startIndex = Math.max(0, targetCandleIndex - 49);
  const candlesForCalculation = data.candles.slice(startIndex, targetCandleIndex + 1);

  console.log(`📈 Using ${candlesForCalculation.length} candles for calculation (indices ${startIndex} to ${targetCandleIndex})`);
  console.log(`📅 Date range: ${new Date(candlesForCalculation[0].timestamp).toISOString()} → ${new Date(candlesForCalculation[candlesForCalculation.length-1].timestamp).toISOString()}\n`);

  // Create squeeze indicator with exact chart parameters
  const squeezeIndicator = new SqueezeMomentumIndicator({
    bbLength: 20,
    bbMultFactor: 2.0,
    kcLength: 20,
    kcMultFactor: 1.5,
    useTrueRange: true
  });

  // Calculate momentum step by step
  console.log('🔢 Step-by-step calculation:\n');

  // Calculate Bollinger Bands
  console.log('1️⃣ Bollinger Bands Calculation:');
  const bb = squeezeIndicator.calculateBollingerBands(candlesForCalculation);
  if (bb) {
    console.log(`   Upper BB: ${bb.upperBB.toFixed(4)}`);
    console.log(`   Lower BB: ${bb.lowerBB.toFixed(4)}`);
    console.log(`   Basis (SMA): ${bb.basis.toFixed(4)}`);
    console.log(`   StdDev: ${bb.stdev.toFixed(4)}\n`);
  } else {
    console.log('   ❌ BB calculation failed\n');
  }

  // Calculate Keltner Channels
  console.log('2️⃣ Keltner Channels Calculation:');
  const kc = squeezeIndicator.calculateKeltnerChannels(candlesForCalculation);
  if (kc) {
    console.log(`   Upper KC: ${kc.upperKC ? kc.upperKC.toFixed(4) : 'N/A'}`);
    console.log(`   Lower KC: ${kc.lowerKC ? kc.lowerKC.toFixed(4) : 'N/A'}`);
    console.log(`   Basis (EMA): ${kc.basis ? kc.basis.toFixed(4) : 'N/A'}`);
    console.log(`   ATR: ${kc.atr ? kc.atr.toFixed(4) : 'N/A'}`);
    console.log(`   KC Object:`, JSON.stringify(kc, null, 2));
  } else {
    console.log('   ❌ KC calculation failed\n');
  }

  console.log('\n3️⃣ Squeeze Detection:');
  // Check if BB is inside KC manually
  const bbInKC = bb.lowerBB > kc.lowerKC && bb.upperBB < kc.upperKC;
  console.log(`   BB in KC: ${bbInKC}`);
  console.log(`   BB Range: ${bb.lowerBB.toFixed(2)} - ${bb.upperBB.toFixed(2)}`);
  console.log(`   KC Range: ${kc.lowerKC.toFixed(2)} - ${kc.upperKC.toFixed(2)}`);
  console.log(`   State: ${bbInKC ? 'squeeze_on' : 'squeeze_off'}\n`);

  // Test momentum calculation directly
  console.log('4️⃣ Direct Momentum Calculation:');
  console.log(`   Using ${candlesForCalculation.length} candles for momentum calculation`);
  console.log(`   KC Length parameter: ${squeezeIndicator.params.kcLength}`);
  console.log(`   Required candles: ${squeezeIndicator.params.kcLength}`);

  try {
    const momentum = squeezeIndicator.calculateMomentum(candlesForCalculation, null);
    if (momentum) {
      console.log(`   ✅ Momentum Value: ${momentum.value}`);
      console.log(`   Direction: ${momentum.direction}`);
      console.log(`   Color: ${momentum.color}`);
    } else {
      console.log('   ❌ Momentum calculation returned null');

      // Debug the issue - let's check what the linearRegression method needs
      console.log('   🔍 Debugging momentum calculation...');
      console.log(`   Params: ${JSON.stringify(squeezeIndicator.params)}`);
    }
  } catch (error) {
    console.log(`   ❌ Momentum calculation error: ${error.message}`);
    console.log(`   Stack: ${error.stack}`);
  }

  // Complete squeeze calculation
  console.log('\\n5️⃣ Complete Squeeze Result:');
  try {
    const fullResult = squeezeIndicator.calculate(candlesForCalculation, null);
    if (fullResult) {
      console.log(`   ✅ Final Momentum: ${fullResult.momentum.value.toFixed(6)}`);
      console.log(`   Direction: ${fullResult.momentum.isPositive ? 'bullish' : 'bearish'}`);
      console.log(`   Color: ${fullResult.momentum.color}`);
      console.log(`   Squeeze State: ${fullResult.squeeze.state}`);
      console.log(`   BB Range: ${fullResult.bollingerBands.upperBB.toFixed(2)} - ${fullResult.bollingerBands.lowerBB.toFixed(2)}`);
      console.log(`   KC Range: ${fullResult.keltnerChannels.upperKC.toFixed(2)} - ${fullResult.keltnerChannels.lowerKC.toFixed(2)}`);
    } else {
      console.log('   ❌ Complete calculation returned null');
    }
  } catch (error) {
    console.log(`   ❌ Complete calculation error: ${error.message}`);
    console.log(`   Stack: ${error.stack}`);
  }

  // Show last 5 candles for debugging
  console.log('\n📊 Last 5 candles used in calculation:');
  const last5 = candlesForCalculation.slice(-5);
  last5.forEach((candle, i) => {
    const date = new Date(candle.timestamp).toLocaleString('en-US', {timeZone: 'America/New_York'});
    console.log(`   ${i+1}: ${date} | O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}`);
  });
}

// Run the debug analysis
debugMomentumCalculation().catch(console.error);