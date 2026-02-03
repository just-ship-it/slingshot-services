/**
 * Test Level+Session Combinations
 *
 * Tests the profitable level+session combos identified from the breakdown:
 * - VWAP + Overnight: 76.9% win
 * - VWAP+1σ + Pre-Market: 80.0% win
 * - VWAP+1σ + Overnight: 63.6% win
 * - BB_Lower + RTH: 56.9% win
 * - EMA100 + RTH: 57.6% win
 */

import { BacktestEngine } from './src/backtest-engine.js';

const baseConfig = {
  ticker: 'NQ',
  timeframe: '1m',
  startDate: new Date('2025-01-01'),
  endDate: new Date('2025-01-31'),
  strategy: 'level-bounce',
  dataDir: './data',
  initialCapital: 100000,
  commission: 5,
  quiet: true,
  strategyParams: {
    proximityPoints: 4,
    minWickTouch: 1,
    minRejectionSize: 1,
    stopLossPoints: 10,       // Fixed 10pt stop
    targetPoints: 10,         // Fixed 10pt target
    trailingTrigger: 999,     // Disable trailing
    trailingOffset: 999,
    signalCooldownMs: 60000,
    useSessionFilter: false,   // We use levelSessionRules instead
    useLimitOrders: true,
    orderTimeoutCandles: 3,
    maxRisk: 999,             // Disable maxRisk filter
    useConfirmation: false,
  }
};

// Profitable combos from the level+session breakdown
const profitableLevelSessionRules = {
  'VWAP': ['overnight'],
  'VWAP+1σ': ['premarket', 'overnight'],
  'BB_Lower': ['rth'],
  'EMA100': ['rth'],
};

const testConfigs = [
  // Baseline: all levels, all sessions (24/7)
  {
    name: 'All Levels 24/7',
    params: {
      allowedLevels: null,
      levelSessionRules: null,
    }
  },

  // Filtered: only profitable combos
  {
    name: 'Profitable Combos Only',
    params: {
      levelSessionRules: profitableLevelSessionRules,
    }
  },

  // Individual profitable combos for validation
  {
    name: 'VWAP + Overnight',
    params: {
      allowedLevels: ['VWAP'],
      useSessionFilter: true,
      allowedHoursEST: [[18, 24], [0, 4]],  // Overnight
    }
  },
  {
    name: 'VWAP+1σ + PreMkt/Ovn',
    params: {
      allowedLevels: ['VWAP+1σ'],
      useSessionFilter: true,
      allowedHoursEST: [[0, 9.5], [18, 24]],  // Overnight + PreMarket
    }
  },
  {
    name: 'BB_Lower + RTH',
    params: {
      allowedLevels: ['BB_Lower'],
      useSessionFilter: true,
      allowedHoursEST: [[9.5, 16]],  // RTH
    }
  },
  {
    name: 'EMA100 + RTH',
    params: {
      allowedLevels: ['EMA100'],
      useSessionFilter: true,
      allowedHoursEST: [[9.5, 16]],  // RTH
    }
  },

  // Additional tests: expand to more levels in promising sessions
  {
    name: 'All VWAP levels + Overnight',
    params: {
      allowedLevels: ['VWAP', 'VWAP+1σ', 'VWAP-1σ', 'VWAP+2σ', 'VWAP-2σ', 'VWAP+3σ', 'VWAP-3σ'],
      useSessionFilter: true,
      allowedHoursEST: [[18, 24], [0, 4]],  // Overnight
    }
  },
  {
    name: 'All BB + RTH',
    params: {
      allowedLevels: ['BB_Upper', 'BB_Middle', 'BB_Lower'],
      useSessionFilter: true,
      allowedHoursEST: [[9.5, 16]],  // RTH
    }
  },
];

async function runTest(testConfig) {
  const config = {
    ...baseConfig,
    strategyParams: { ...baseConfig.strategyParams, ...testConfig.params }
  };

  const engine = new BacktestEngine(config);
  const results = await engine.run();

  return {
    name: testConfig.name,
    trades: results.performance.basic.totalTrades,
    winRate: results.performance.basic.winRate / 100,
    avgWin: results.performance.basic.avgWin,
    avgLoss: Math.abs(results.performance.basic.avgLoss),
    totalPnL: results.performance.basic.totalPnL,
    profitFactor: results.performance.basic.profitFactor,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('LEVEL+SESSION COMBO VALIDATION');
  console.log(`Period: ${baseConfig.startDate.toISOString().split('T')[0]} to ${baseConfig.endDate.toISOString().split('T')[0]}`);
  console.log(`Timeframe: ${baseConfig.timeframe} | Fixed Stop/Target: 10/10 pts`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const results = [];

  for (const test of testConfigs) {
    process.stdout.write(`Testing: ${test.name.padEnd(25)}`);
    try {
      const result = await runTest(test);
      results.push(result);
      const winPct = (result.winRate * 100).toFixed(1);
      const pnlSign = result.totalPnL >= 0 ? '+' : '';
      console.log(`✓ ${String(result.trades).padStart(4)} trades | ${winPct.padStart(5)}% win | ${pnlSign}$${result.totalPnL.toFixed(0)} P&L`);
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
      results.push({ name: test.name, error: error.message });
    }
  }

  // Summary table
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('Config'.padEnd(28) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'AvgWin'.padStart(10) + 'AvgLoss'.padStart(10) + 'P&L'.padStart(12) + 'PF'.padStart(8));
  console.log('─'.repeat(84));

  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(28)} ERROR: ${r.error}`);
    } else {
      const pnlStr = r.totalPnL >= 0 ? `+$${r.totalPnL.toFixed(0)}` : `-$${Math.abs(r.totalPnL).toFixed(0)}`;
      console.log(
        r.name.padEnd(28) +
        String(r.trades).padStart(8) +
        `${(r.winRate * 100).toFixed(1)}%`.padStart(8) +
        `$${r.avgWin.toFixed(0)}`.padStart(10) +
        `$${r.avgLoss.toFixed(0)}`.padStart(10) +
        pnlStr.padStart(12) +
        (r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)).padStart(8)
      );
    }
  }

  // Analysis
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  const validResults = results.filter(r => !r.error && r.trades > 0);
  const profitable = validResults.filter(r => r.totalPnL > 0);
  const withEdge = validResults.filter(r => r.winRate > 0.5);

  console.log(`\nCombos with positive P&L: ${profitable.length}/${validResults.length}`);
  for (const r of profitable.sort((a, b) => b.totalPnL - a.totalPnL)) {
    console.log(`  ✅ ${r.name}: +$${r.totalPnL.toFixed(0)} (${(r.winRate * 100).toFixed(1)}% win, ${r.trades} trades)`);
  }

  console.log(`\nCombos with edge (>50% win rate): ${withEdge.length}/${validResults.length}`);
  for (const r of withEdge.sort((a, b) => b.winRate - a.winRate)) {
    const pnlSign = r.totalPnL >= 0 ? '+' : '';
    console.log(`  📊 ${r.name}: ${(r.winRate * 100).toFixed(1)}% win (${pnlSign}$${r.totalPnL.toFixed(0)}, ${r.trades} trades)`);
  }
}

main().catch(console.error);
