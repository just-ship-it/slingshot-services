#!/usr/bin/env node

/**
 * Analyze specific trades from recent period to find unrealistic behavior
 */

import { BacktestEngine } from './src/backtest-engine.js';

console.log('🔍 ANALYZING SPECIFIC TRADES FROM 2024-2025');
console.log('═'.repeat(60));

// Create backtest configuration for recent period with detailed logging
const backtestConfig = {
  ticker: 'NQ',
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-01-15'), // Two weeks where we should find signals
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

// Override runSimulation to capture detailed trade analysis
const originalRunSimulation = engine.runSimulation.bind(engine);
engine.runSimulation = async function(data) {
  console.log(`📊 Analyzing ${data.candles.length} 15m candles and ${data.originalCandles.length} 1m candles`);

  const signals = [];
  const trades = [];
  let prevCandle = null;
  let tradeCount = 0;

  // Process each 15-minute candle looking for signals
  for (let i = 0; i < data.candles.length && tradeCount < 5; i++) {
    const candle = data.candles[i];

    if (prevCandle) {
      const marketData = this.getMarketDataForTimestamp(candle.timestamp, data.marketDataLookup);

      if (marketData.gexLevels) {
        const signal = this.strategy.evaluateSignal(candle, prevCandle, marketData);

        if (signal) {
          tradeCount++;
          console.log(`\n🎯 TRADE #${tradeCount} ANALYSIS:`);
          console.log(`   Signal Time: ${new Date(candle.timestamp).toISOString()}`);
          console.log(`   Entry Setup:`);
          console.log(`     Previous Candle: O:${prevCandle.open} H:${prevCandle.high} L:${prevCandle.low} C:${prevCandle.close}`);
          console.log(`     Current Candle:  O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);
          console.log(`     GEX Level: ${signal.metadata.gex_level} (${signal.metadata.gex_level_type})`);
          console.log(`     Entry Price: ${signal.entryPrice}`);
          console.log(`     Stop Loss: ${signal.stopLoss}`);
          console.log(`     Take Profit: ${signal.takeProfit}`);

          // Validate crossover logic
          const gexLevel = signal.metadata.gex_level;
          const prevAbove = prevCandle.close > gexLevel;
          const currentBelow = candle.close < gexLevel;
          console.log(`   Crossover Check:`);
          console.log(`     Prev close ${prevCandle.close} > GEX ${gexLevel}? ${prevAbove}`);
          console.log(`     Current close ${candle.close} < GEX ${gexLevel}? ${currentBelow}`);
          console.log(`     Valid crossover: ${prevAbove && currentBelow}`);

          // Process trade
          const order = this.tradeSimulator.processSignal(signal, candle.timestamp);

          if (order) {
            console.log(`   Trade Created: ${order.id}`);

            // Track this trade through execution
            const signalTime = candle.timestamp;
            let minuteIndex = 0;

            // Find starting point in 1-minute data
            while (minuteIndex < data.originalCandles.length &&
                   data.originalCandles[minuteIndex].timestamp <= signalTime) {
              minuteIndex++;
            }

            console.log(`   Following execution from minute ${minuteIndex}:`);

            // Process up to 100 minutes
            for (let j = 0; j < 100 && minuteIndex + j < data.originalCandles.length; j++) {
              const candle1m = data.originalCandles[minuteIndex + j];
              const updates = this.tradeSimulator.updateActiveTrades(candle1m);

              if (updates.length > 0) {
                const update = updates[0];

                if (update.status === 'active' && update.event === 'entry_filled') {
                  console.log(`     ${new Date(candle1m.timestamp).toISOString()}: ENTRY FILLED at ${update.actualEntry}`);
                  console.log(`       Entry Candle: O:${candle1m.open} H:${candle1m.high} L:${candle1m.low} C:${candle1m.close}`);
                }

                if (update.status === 'completed') {
                  console.log(`     ${new Date(candle1m.timestamp).toISOString()}: EXIT - ${update.exitReason}`);
                  console.log(`       Exit Candle: O:${candle1m.open} H:${candle1m.high} L:${candle1m.low} C:${candle1m.close}`);
                  console.log(`       Exit Price: ${update.actualExit}`);
                  console.log(`       Duration: ${Math.round((update.exitTime - update.entryTime) / 60000)} minutes`);

                  // Detailed P&L breakdown
                  console.log(`   P&L Breakdown:`);
                  console.log(`     Entry: ${update.actualEntry || update.entryPrice}`);
                  console.log(`     Exit: ${update.actualExit}`);
                  console.log(`     Points: ${update.pointsPnL}`);
                  console.log(`     Expected Stop Points: ~-${signal.metadata.stop_buffer || 12}`);
                  console.log(`     Expected Target Points: ~+${signal.metadata.target_points || 25}`);
                  console.log(`     Gross P&L: $${update.grossPnL}`);
                  console.log(`     Net P&L: $${update.netPnL}`);

                  // Reality check
                  if (update.exitReason === 'take_profit' && Math.abs(update.pointsPnL - 25) > 5) {
                    console.log(`     ⚠️  SUSPICIOUS: Take profit should be ~25 points, got ${update.pointsPnL}`);
                  }
                  if (update.exitReason === 'stop_loss' && (update.pointsPnL > -5 || update.pointsPnL < -20)) {
                    console.log(`     ⚠️  SUSPICIOUS: Stop loss should be ~-12 points, got ${update.pointsPnL}`);
                  }

                  trades.push(update);
                  break;
                }
              }
            }

            console.log('\n' + '─'.repeat(60));
          }
        }
      }
    }

    prevCandle = candle;
  }

  console.log(`\n📊 SUMMARY: Analyzed ${tradeCount} trades`);
  console.log('Looking for patterns of unrealistic behavior...');

  return {
    signals: signals,
    rejectedSignals: [],
    trades: trades,
    activeTrades: [],
    equityCurve: [],
    finalEquity: 100000,
    processingStats: {}
  };
};

// Run analysis
try {
  await engine.run();
} catch (error) {
  console.error('❌ Analysis failed:', error.message);
  console.error(error.stack);
}