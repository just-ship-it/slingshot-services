/**
 * Debug backtest engine LT data flow
 */

import { BacktestEngine } from '../../src/backtest-engine.js';

const config = {
  ticker: 'NQ',
  startDate: new Date('2025-01-02'),
  endDate: new Date('2025-01-05'),
  strategy: 'lt-failed-breakdown',
  timeframe: '1m',
  commission: 5,
  initialCapital: 100000,
  quiet: true,
  verbose: false,
  dataDir: '/home/drew/projects/slingshot-services/backtest-engine/data',
  strategyParams: {
    debug: true,
    signalCooldownMs: 300000
  }
};

async function main() {
  console.log('Creating BacktestEngine...');

  const engine = new BacktestEngine(config);

  // Intercept the loadData call to see what data is loaded
  const originalLoadData = engine.loadData.bind(engine);
  engine.loadData = async function() {
    const data = await originalLoadData();

    console.log('\n=== Data loaded by engine ===');
    console.log('candles:', data.candles?.length);
    console.log('originalCandles:', data.originalCandles?.length);
    console.log('liquidityLevels:', data.liquidityLevels?.length);

    if (data.liquidityLevels?.length > 0) {
      console.log('\nFirst LT record:');
      console.log(data.liquidityLevels[0]);
    }

    return data;
  };

  // Patch evaluateSignal to see what's happening
  const strategy = engine.strategy;
  const originalEvaluateSignal = strategy.evaluateSignal.bind(strategy);
  let evalCount = 0;

  strategy.evaluateSignal = function(candle, prevCandle, marketData, options) {
    evalCount++;

    // Log first 5 calls
    if (evalCount <= 5) {
      console.log(`\n=== evaluateSignal call #${evalCount} ===`);
      console.log('candle.timestamp:', candle.timestamp, typeof candle.timestamp);
      console.log('candle.timestamp ISO:', new Date(candle.timestamp).toISOString());
      console.log('candle.close:', candle.close);
      console.log('marketData.gexLevels:', marketData.gexLevels ? 'present' : 'null');
      console.log('marketData.liquidityLevels:', marketData.liquidityLevels ? 'present' : 'null');

      // Check what getLTAtTime returns
      const ltData = this.getLTAtTime(this.toMs(candle.timestamp));
      console.log('getLTAtTime result:', ltData ? 'found' : 'null');
      if (ltData) {
        console.log('ltData keys:', Object.keys(ltData));
        console.log('ltData.level_1:', ltData.level_1);
      }

      // Check getLevelsToCheck
      if (ltData) {
        const levels = this.getLevelsToCheck(ltData);
        console.log('getLevelsToCheck result:', levels.length, 'levels');
        if (levels.length > 0) {
          console.log('First level:', levels[0]);
        }
      }
    }

    return originalEvaluateSignal(candle, prevCandle, marketData, options);
  };

  console.log('\nRunning backtest...');
  const results = await engine.run();

  console.log('\n=== RESULTS ===');
  console.log(`Total evaluateSignal calls: ${evalCount}`);
  console.log(`Signals: ${results.simulation.totalSignals}`);
  console.log(`Trades: ${results.simulation.executedTrades}`);
}

main().catch(console.error);
