#!/usr/bin/env node
/**
 * Test script to compare backtest results with/without session filter
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';

async function runBacktest(useSessionFilter) {
  const filterLabel = useSessionFilter ? 'WITH' : 'WITHOUT';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running backtest ${filterLabel} session filter...`);
  console.log(`${'='.repeat(60)}\n`);

  const config = {
    ticker: 'NQ',
    startDate: new Date('2023-03-28'),
    endDate: new Date('2025-12-24'),
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      confluenceThreshold: 5,
      entryDistance: 10,
      maxReclaimBars: 3,
      stopLossBuffer: 3,
      tradingSymbol: 'NQ',
      maxRisk: 50,
      minRiskReward: 1,
      // Session filter control
      useSessionFilter: useSessionFilter,
      blockedSessionStartUTC: 14,
      blockedSessionEndUTC: 17
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: './data',
    verbose: false,
    quiet: true,
    showTrades: false
  };

  const engine = new BacktestEngine(config);
  const results = await engine.run();

  return {
    filterLabel,
    totalTrades: results.performance?.summary?.totalTrades || 0,
    winRate: results.performance?.summary?.winRate || 0,
    totalPnL: results.performance?.summary?.totalPnL || 0,
    profitFactor: results.performance?.tradingStats?.profitFactor || 0,
    maxDrawdown: results.performance?.summary?.maxDrawdown || 0,
    sharpeRatio: results.performance?.summary?.sharpeRatio || 0,
    results
  };
}

async function main() {
  try {
    console.log('Session Filter Impact Analysis');
    console.log('==============================\n');
    console.log('This test compares backtest results:');
    console.log('- WITHOUT session filter (baseline - all trades)');
    console.log('- WITH session filter (blocking UTC 14-17 / 9 AM-12 PM EST)\n');

    // Run without session filter first (baseline)
    const baseline = await runBacktest(false);

    // Run with session filter enabled
    const filtered = await runBacktest(true);

    // Calculate impact
    const tradesFiltered = baseline.totalTrades - filtered.totalTrades;
    const pnlImpact = filtered.totalPnL - baseline.totalPnL;

    console.log('\n' + '='.repeat(60));
    console.log('COMPARISON RESULTS');
    console.log('='.repeat(60) + '\n');

    console.log('Metric                    | WITHOUT Filter | WITH Filter | Change');
    console.log('-'.repeat(75));
    console.log(`Total Trades              | ${baseline.totalTrades.toString().padEnd(14)} | ${filtered.totalTrades.toString().padEnd(11)} | ${tradesFiltered > 0 ? '-' : '+'}${Math.abs(tradesFiltered)}`);
    console.log(`Win Rate                  | ${baseline.winRate.toFixed(1).padEnd(13)}% | ${filtered.winRate.toFixed(1).padEnd(10)}% | ${(filtered.winRate - baseline.winRate).toFixed(1)}%`);
    console.log(`Total P&L                 | $${baseline.totalPnL.toFixed(0).padEnd(12)} | $${filtered.totalPnL.toFixed(0).padEnd(9)} | $${pnlImpact >= 0 ? '+' : ''}${pnlImpact.toFixed(0)}`);
    console.log(`Sharpe Ratio              | ${baseline.sharpeRatio.toFixed(2).padEnd(14)} | ${filtered.sharpeRatio.toFixed(2).padEnd(11)} | ${(filtered.sharpeRatio - baseline.sharpeRatio).toFixed(2)}`);
    console.log(`Max Drawdown              | ${baseline.maxDrawdown.toFixed(1).padEnd(13)}% | ${filtered.maxDrawdown.toFixed(1).padEnd(10)}% | ${(filtered.maxDrawdown - baseline.maxDrawdown).toFixed(1)}%`);

    console.log('\n' + '='.repeat(60));
    console.log('IMPACT SUMMARY');
    console.log('='.repeat(60));
    console.log(`\n- Trades Blocked: ${tradesFiltered} (${(tradesFiltered / baseline.totalTrades * 100).toFixed(1)}% of total)`);
    console.log(`- P&L Impact: $${pnlImpact >= 0 ? '+' : ''}${pnlImpact.toFixed(0)}`);
    console.log(`- This filter ${pnlImpact > 0 ? 'IMPROVES' : 'REDUCES'} results by eliminating ${tradesFiltered} trades during US market open rush\n`);

    // Save detailed results
    const comparison = {
      baseline,
      filtered,
      impact: {
        tradesFiltered,
        percentFiltered: (tradesFiltered / baseline.totalTrades * 100).toFixed(1),
        pnlImpact,
        winRateChange: ((filtered.winRate - baseline.winRate) * 100).toFixed(1)
      }
    };

    fs.writeFileSync('./results/session-filter-comparison.json', JSON.stringify(comparison, null, 2));
    console.log('Detailed results saved to ./results/session-filter-comparison.json');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
