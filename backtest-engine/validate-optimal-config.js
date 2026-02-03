#!/usr/bin/env node
/**
 * Validation Backtest - Optimal Scalping Configuration
 *
 * Tests the optimal parameters found from grid search:
 * D35_S12_T8/3 - 688 trades, 78.5% WR, $22,180 P&L
 */

import { BacktestEngine } from './src/backtest-engine.js';

const config = {
  ticker: 'NQ',
  startDate: new Date('2025-01-13'),
  endDate: new Date('2025-12-24'),
  timeframe: '15m',
  strategy: 'contrarian-bounce',
  strategyParams: {
    tradingSymbol: 'NQ',
    defaultQuantity: 1,
    stopBuffer: 12,
    maxRisk: 200.0,
    useGexLevelStops: false,
    targetMode: 'gamma_flip',
    useTrailingStop: true,
    trailingTrigger: 8,
    trailingOffset: 3,
    signalCooldownMs: 0,
    requirePositiveGex: false,
    useTimeFilter: false,
    useSentimentFilter: false,
    useDistanceFilter: true,
    minDistanceBelowFlip: 0,
    maxDistanceBelowFlip: 35,
    useIvFilter: false,
    allowLong: true,
    allowShort: false
  },
  commission: 5,
  initialCapital: 100000,
  dataDir: 'data',
  quiet: false,
  showTrades: false
};

console.log('='.repeat(100));
console.log('VALIDATION BACKTEST - OPTIMAL SCALPING CONFIGURATION');
console.log('='.repeat(100));
console.log('\nConfiguration: D35_S12_T8/3 (maxDist=35, stop=12, trail=8/3, no GEX filter)');
console.log('Expected: 688 trades, 78.5% WR, $22,180 P&L, 12.5% DD\n');

const engine = new BacktestEngine(config);
const results = await engine.run();

// Exit reason breakdown
console.log('\n' + '='.repeat(100));
console.log('EXIT REASON BREAKDOWN');
console.log('='.repeat(100));

const exits = {};
for (const trade of results.trades || []) {
  const reason = trade.exitReason || 'unknown';
  if (!exits[reason]) exits[reason] = { count: 0, pnl: 0 };
  exits[reason].count++;
  exits[reason].pnl += trade.netPnL || 0;
}

console.log('\nExit Reason      | Trades |      P&L     |   Avg P&L');
console.log('-'.repeat(60));
for (const [reason, data] of Object.entries(exits).sort((a, b) => b[1].count - a[1].count)) {
  const avgPnl = data.count > 0 ? data.pnl / data.count : 0;
  console.log(`${reason.padEnd(16)} | ${String(data.count).padStart(6)} | $${data.pnl.toFixed(0).padStart(10)} | $${avgPnl.toFixed(0).padStart(8)}`);
}

// Monthly breakdown
console.log('\n' + '='.repeat(100));
console.log('MONTHLY PERFORMANCE');
console.log('='.repeat(100));

const monthlyStats = {};
for (const trade of results.trades || []) {
  const month = new Date(trade.entryTime).toISOString().slice(0, 7);
  if (!monthlyStats[month]) monthlyStats[month] = { trades: 0, wins: 0, pnl: 0 };
  monthlyStats[month].trades++;
  monthlyStats[month].pnl += trade.netPnL || 0;
  if ((trade.netPnL || 0) > 0) monthlyStats[month].wins++;
}

console.log('\nMonth      | Trades | Win%  |      P&L');
console.log('-'.repeat(50));
for (const [month, stats] of Object.entries(monthlyStats).sort()) {
  const winRate = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0.0';
  console.log(`${month}   | ${String(stats.trades).padStart(6)} | ${winRate.padStart(5)}% | $${stats.pnl.toFixed(0).padStart(9)}`);
}

console.log('\n' + '='.repeat(100));
console.log('VALIDATION COMPLETE');
console.log('='.repeat(100));
