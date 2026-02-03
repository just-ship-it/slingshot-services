#!/usr/bin/env node
/**
 * Test script to compare backtest results with all filter combinations
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';

async function runBacktest(label, strategyParams) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${label}`);
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
      ...strategyParams
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

  const summary = results.performance?.summary || {};
  return {
    label,
    totalTrades: summary.totalTrades || 0,
    winRate: summary.winRate || 0,
    totalPnL: summary.totalPnL || 0,
    maxDrawdown: summary.maxDrawdown || 0,
    sharpeRatio: summary.sharpeRatio || 0,
    annualizedReturn: summary.annualizedReturn || 0
  };
}

async function main() {
  try {
    console.log('Filter Optimization Comparison');
    console.log('==============================\n');

    // Run all three scenarios
    const results = [];

    // 1. No filters (baseline)
    results.push(await runBacktest('No Filters (Baseline)', {
      useSessionFilter: false,
      maxBarsToEntry: 0  // 0 = disabled
    }));

    // 2. Session filter only
    results.push(await runBacktest('Session Filter Only', {
      useSessionFilter: true,
      blockedSessionStartUTC: 14,
      blockedSessionEndUTC: 17,
      maxBarsToEntry: 0
    }));

    // 3. Both filters
    results.push(await runBacktest('Session + MaxBars Filter', {
      useSessionFilter: true,
      blockedSessionStartUTC: 14,
      blockedSessionEndUTC: 17,
      maxBarsToEntry: 2
    }));

    // Display comparison
    console.log('\n' + '='.repeat(80));
    console.log('FILTER OPTIMIZATION COMPARISON');
    console.log('='.repeat(80) + '\n');

    console.log('Configuration'.padEnd(28) + 'Trades'.padEnd(10) + 'Win%'.padEnd(10) + 'Total P&L'.padEnd(14) + 'MaxDD'.padEnd(10) + 'Sharpe');
    console.log('-'.repeat(80));

    for (const r of results) {
      console.log(
        r.label.padEnd(28) +
        r.totalTrades.toString().padEnd(10) +
        (r.winRate.toFixed(1) + '%').padEnd(10) +
        ('$' + r.totalPnL.toLocaleString()).padEnd(14) +
        (r.maxDrawdown.toFixed(1) + '%').padEnd(10) +
        r.sharpeRatio.toFixed(2)
      );
    }

    // Calculate improvements
    const baseline = results[0];
    const sessionOnly = results[1];
    const bothFilters = results[2];

    console.log('\n' + '='.repeat(80));
    console.log('IMPROVEMENT SUMMARY');
    console.log('='.repeat(80));

    console.log(`\nSession Filter Impact:`);
    console.log(`  Trades: ${baseline.totalTrades} → ${sessionOnly.totalTrades} (${baseline.totalTrades - sessionOnly.totalTrades} blocked)`);
    console.log(`  P&L: $${baseline.totalPnL.toLocaleString()} → $${sessionOnly.totalPnL.toLocaleString()} ($${(sessionOnly.totalPnL - baseline.totalPnL).toLocaleString()} improvement)`);

    console.log(`\nMaxBarsToEntry Filter Impact (on top of session filter):`);
    console.log(`  Trades: ${sessionOnly.totalTrades} → ${bothFilters.totalTrades} (${sessionOnly.totalTrades - bothFilters.totalTrades} blocked)`);
    console.log(`  P&L: $${sessionOnly.totalPnL.toLocaleString()} → $${bothFilters.totalPnL.toLocaleString()} ($${(bothFilters.totalPnL - sessionOnly.totalPnL).toLocaleString()} improvement)`);

    console.log(`\nTotal Optimization Impact:`);
    console.log(`  Trades: ${baseline.totalTrades} → ${bothFilters.totalTrades} (${((1 - bothFilters.totalTrades/baseline.totalTrades) * 100).toFixed(0)}% reduction)`);
    console.log(`  P&L: $${baseline.totalPnL.toLocaleString()} → $${bothFilters.totalPnL.toLocaleString()} ($${(bothFilters.totalPnL - baseline.totalPnL).toLocaleString()} total improvement)`);
    console.log(`  Win Rate: ${baseline.winRate.toFixed(1)}% → ${bothFilters.winRate.toFixed(1)}% (+${(bothFilters.winRate - baseline.winRate).toFixed(1)}%)`);
    console.log(`  Max Drawdown: ${baseline.maxDrawdown.toFixed(1)}% → ${bothFilters.maxDrawdown.toFixed(1)}% (${(bothFilters.maxDrawdown - baseline.maxDrawdown).toFixed(1)}%)`);

    // Save results
    fs.writeFileSync('./results/filter-optimization-comparison.json', JSON.stringify(results, null, 2));
    console.log('\nResults saved to ./results/filter-optimization-comparison.json');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
