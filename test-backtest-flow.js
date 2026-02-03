// Test the full backtest flow with regime-scalp
import { BacktestEngine } from './backtest-engine/src/backtest-engine.js';

const config = {
  ticker: 'NQ',
  startDate: new Date('2025-01-02'),
  endDate: new Date('2025-12-31'),
  timeframe: '1m',
  strategy: 'regime-scalp',
  strategyParams: {
    debug: false,
    liveMode: false,
    symbol: 'NQ',
    tradingSymbol: 'NQ',
    // Disable session filtering to see full strategy performance
    useSessionFilter: false,
    // Also disable session blocking in regime identifier
    allowedSessions: ['rth', 'premarket', 'afterhours', 'overnight']
  },
  commission: 5,
  initialCapital: 100000,
  dataDir: './backtest-engine/data',
  verbose: true,
  quiet: false,
  showTrades: true,
  useSecondResolution: false  // Disable for faster test
};

console.log('Creating backtest engine...');
const engine = new BacktestEngine(config);

console.log('Running backtest...');
engine.run().then(results => {
  console.log('\n=== RESULTS ===');
  console.log('Signals generated:', results.simulation.totalSignals);
  console.log('Trades executed:', results.trades.length);
}).catch(err => {
  console.error('Error:', err);
});
