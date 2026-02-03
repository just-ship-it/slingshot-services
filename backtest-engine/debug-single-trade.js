#!/usr/bin/env node

/**
 * Debug single trade execution minute by minute
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';
import path from 'path';

console.log('🔍 DEBUGGING SINGLE TRADE EXECUTION');
console.log('═'.repeat(60));

// Create backtest configuration for a period where we know there are signals
const backtestConfig = {
  ticker: 'NQ',
  startDate: new Date('2023-03-27'),
  endDate: new Date('2023-03-29'),
  timeframe: '15m',
  strategy: 'gex-recoil',
  strategyParams: {
    targetPoints: 25.0,
    stopBuffer: 10.0,
    maxRisk: 30.0,
    useTrailingStop: false,
    useLiquidityFilter: false,
    tradingSymbol: 'NQ'
  },
  commission: 5.0,
  initialCapital: 100000,
  dataDir: './data',
  verbose: false,
  quiet: true,
  showTrades: false
};

const engine = new BacktestEngine(backtestConfig);

// Override the runSimulation method to capture detailed trade data
const originalRunSimulation = engine.runSimulation.bind(engine);
engine.runSimulation = async function(data) {
  console.log(`📊 Found ${data.candles.length} 15m candles and ${data.originalCandles.length} 1m candles`);

  const signals = [];
  let prevCandle = null;

  // Look for the first signal
  for (let i = 0; i < Math.min(data.candles.length, 50); i++) {
    const candle = data.candles[i];

    if (prevCandle) {
      const marketData = this.getMarketDataForTimestamp(candle.timestamp, data.marketDataLookup);

      if (marketData.gexLevels) {
        const signal = this.strategy.evaluateSignal(candle, prevCandle, marketData);

        if (signal) {
          console.log('\n🎯 FOUND FIRST SIGNAL:');
          console.log(`   Time: ${new Date(candle.timestamp).toISOString()}`);
          console.log(`   Entry Price: ${signal.entryPrice}`);
          console.log(`   Stop Loss: ${signal.stopLoss}`);
          console.log(`   Take Profit: ${signal.takeProfit}`);
          console.log(`   Candle: O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);
          console.log(`   Prev Candle: O:${prevCandle.open} H:${prevCandle.high} L:${prevCandle.low} C:${prevCandle.close}`);
          console.log(`   GEX Level: ${signal.metadata.gex_level} (${signal.metadata.gex_level_type})`);

          // Process this signal through trade simulator
          const order = this.tradeSimulator.processSignal(signal, candle.timestamp);

          if (order) {
            console.log('\n📋 TRADE CREATED:');
            console.log(`   Trade ID: ${order.id}`);
            console.log(`   Entry Price: ${order.entryPrice}`);
            console.log(`   Stop: ${order.stopLoss}`);
            console.log(`   Target: ${order.takeProfit}`);

            // Now follow this trade through minute candles
            console.log('\n🔍 MINUTE-BY-MINUTE EXECUTION:');

            const signalStartTime = candle.timestamp;
            let tradeActive = true;
            let minuteCount = 0;

            for (const candle1m of data.originalCandles) {
              // Only process 1m candles after the signal time
              if (candle1m.timestamp <= signalStartTime) continue;

              minuteCount++;
              if (minuteCount > 100) break; // Limit to 100 minutes for debugging

              const updates = this.tradeSimulator.updateActiveTrades(candle1m);

              if (updates.length > 0) {
                const update = updates[0];
                console.log(`   ${new Date(candle1m.timestamp).toISOString()}: ${update.event || 'update'}`);
                console.log(`     Candle: O:${candle1m.open} H:${candle1m.high} L:${candle1m.low} C:${candle1m.close}`);

                if (update.status === 'completed') {
                  console.log(`     EXIT: ${update.exitReason} at ${update.actualExit}`);
                  console.log(`     P&L: ${update.netPnL}`);
                  console.log(`     Points: ${update.pointsPnL}`);
                  console.log(`     Duration: ${Math.round((update.exitTime - update.entryTime) / 60000)} minutes`);

                  // Validate the P&L calculation step by step
                  console.log('\n🧮 P&L VALIDATION:');
                  console.log(`   Entry: ${update.actualEntry || update.entryPrice}`);
                  console.log(`   Exit: ${update.actualExit}`);
                  console.log(`   Points: ${update.pointsPnL}`);
                  console.log(`   Point Value: $${update.pointValue}`);
                  console.log(`   Gross P&L: ${update.pointsPnL} × $${update.pointValue} = $${update.grossPnL}`);
                  console.log(`   Commission: $${update.commission}`);
                  console.log(`   Net P&L: $${update.grossPnL} - $${update.commission} = $${update.netPnL}`);

                  // Check if this is realistic
                  const expectedPoints = update.exitReason === 'take_profit' ? 25 : -12;
                  const actualPoints = update.pointsPnL;
                  console.log(`\n✅ REALITY CHECK:`);
                  console.log(`   Expected Points: ~${expectedPoints}`);
                  console.log(`   Actual Points: ${actualPoints}`);
                  console.log(`   Difference: ${Math.abs(actualPoints - expectedPoints)}`);

                  if (Math.abs(actualPoints - expectedPoints) > 5) {
                    console.log('   ⚠️  UNREALISTIC RESULT DETECTED!');
                  }

                  tradeActive = false;
                  break;
                }
              }
            }

            break; // Exit after analyzing first trade
          }
        }
      }
    }

    prevCandle = candle;
  }

  // Return minimal results
  return {
    signals: signals,
    rejectedSignals: [],
    trades: [],
    activeTrades: [],
    equityCurve: [],
    finalEquity: 100000,
    processingStats: {}
  };
};

// Run the analysis
try {
  await engine.run();
} catch (error) {
  console.error('❌ Debug failed:', error.message);
  console.error(error.stack);
}