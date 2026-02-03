/**
 * Full Year 2025 Level Bounce Analysis
 *
 * Runs the level bounce strategy across all of 2025 to:
 * 1. Find which level+session combos have consistent edge
 * 2. Validate January findings hold across the year
 * 3. Identify any seasonal patterns
 */

import { BacktestEngine } from './src/backtest-engine.js';

const baseConfig = {
  ticker: 'NQ',
  timeframe: '1m',
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
    useSessionFilter: false,   // Trade all sessions
    useLimitOrders: true,
    orderTimeoutCandles: 3,
    maxRisk: 999,             // Disable maxRisk filter
    useConfirmation: false,
    useAdaptiveTracking: true,  // Enable adaptive tracking
    adaptiveMinTrades: 20,      // Need 20 trades before disabling
    adaptiveMinWinRate: 0.48,   // Disable if win rate below 48%
  }
};

// Run test for a specific month
async function runMonthTest(year, month, config) {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0); // Last day of month

  const monthConfig = {
    ...config,
    startDate,
    endDate,
  };

  try {
    const engine = new BacktestEngine(monthConfig);
    const results = await engine.run();

    // Group trades by level+session
    const levelSessionStats = new Map();

    for (const trade of results.trades) {
      const levelName = trade.metadata?.level_name || 'UNKNOWN';
      const session = getSessionFromTimestamp(trade.entryTime);
      const key = `${levelName}|${session}`;

      if (!levelSessionStats.has(key)) {
        levelSessionStats.set(key, {
          levelName,
          session,
          trades: 0,
          wins: 0,
          losses: 0,
          totalPnL: 0,
          grossProfit: 0,
          grossLoss: 0,
        });
      }

      const stats = levelSessionStats.get(key);
      stats.trades++;
      stats.totalPnL += trade.netPnL;

      if (trade.netPnL > 0) {
        stats.wins++;
        stats.grossProfit += trade.netPnL;
      } else {
        stats.losses++;
        stats.grossLoss += Math.abs(trade.netPnL);
      }
    }

    return {
      month: `${year}-${String(month).padStart(2, '0')}`,
      trades: results.trades.length,
      totalPnL: results.performance.basic.totalPnL,
      winRate: results.performance.basic.winRate,
      levelSessionStats: Object.fromEntries(levelSessionStats),
    };
  } catch (error) {
    console.error(`Error running ${year}-${month}: ${error.message}`);
    return null;
  }
}

function getSessionFromTimestamp(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const [hourStr, minStr] = estString.split(':');
  const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;

  if (timeDecimal >= 9.5 && timeDecimal < 16) {
    return 'rth';
  } else if (timeDecimal >= 4 && timeDecimal < 9.5) {
    return 'premarket';
  } else if (timeDecimal >= 16 && timeDecimal < 18) {
    return 'afterhours';
  } else {
    return 'overnight';
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('FULL YEAR 2025 LEVEL BOUNCE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('Testing all level+session combinations across 2025...\n');

  const monthlyResults = [];
  const aggregatedStats = new Map();

  // Test each month of 2025 (data available through end of year)
  for (let month = 1; month <= 12; month++) {
    process.stdout.write(`Testing 2025-${String(month).padStart(2, '0')}... `);

    const result = await runMonthTest(2025, month, baseConfig);

    if (result && result.trades > 0) {
      monthlyResults.push(result);
      console.log(`✓ ${result.trades} trades, ${result.winRate.toFixed(1)}% win, $${result.totalPnL.toFixed(0)} P&L`);

      // Aggregate level+session stats
      for (const [key, stats] of Object.entries(result.levelSessionStats)) {
        if (!aggregatedStats.has(key)) {
          aggregatedStats.set(key, {
            levelName: stats.levelName,
            session: stats.session,
            trades: 0,
            wins: 0,
            losses: 0,
            totalPnL: 0,
            grossProfit: 0,
            grossLoss: 0,
            monthsActive: 0,
          });
        }
        const agg = aggregatedStats.get(key);
        agg.trades += stats.trades;
        agg.wins += stats.wins;
        agg.losses += stats.losses;
        agg.totalPnL += stats.totalPnL;
        agg.grossProfit += stats.grossProfit;
        agg.grossLoss += stats.grossLoss;
        agg.monthsActive++;
      }
    } else {
      console.log('⏭️  No data or no trades');
    }
  }

  // Print monthly summary
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('MONTHLY SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('Month'.padEnd(12) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'P&L'.padStart(12));
  console.log('─'.repeat(40));

  for (const result of monthlyResults) {
    const pnlStr = result.totalPnL >= 0 ? `+$${result.totalPnL.toFixed(0)}` : `-$${Math.abs(result.totalPnL).toFixed(0)}`;
    console.log(
      result.month.padEnd(12) +
      String(result.trades).padStart(8) +
      `${result.winRate.toFixed(1)}%`.padStart(8) +
      pnlStr.padStart(12)
    );
  }

  // Print aggregated level+session analysis
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('LEVEL+SESSION PERFORMANCE (FULL YEAR)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('Level+Session'.padEnd(28) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'PF'.padStart(8) + 'P&L'.padStart(12) + 'Months'.padStart(8));
  console.log('─'.repeat(72));

  // Convert to array and sort by P&L
  const sortedStats = [...aggregatedStats.entries()]
    .map(([key, stats]) => ({
      key,
      ...stats,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) : 0,
      profitFactor: stats.grossLoss > 0 ? (stats.grossProfit / stats.grossLoss) : (stats.grossProfit > 0 ? Infinity : 0),
    }))
    .sort((a, b) => b.totalPnL - a.totalPnL);

  for (const stats of sortedStats) {
    const pnlStr = stats.totalPnL >= 0 ? `+$${stats.totalPnL.toFixed(0)}` : `-$${Math.abs(stats.totalPnL).toFixed(0)}`;
    const pfStr = stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
    console.log(
      `${stats.levelName}|${stats.session}`.padEnd(28) +
      String(stats.trades).padStart(8) +
      `${(stats.winRate * 100).toFixed(1)}%`.padStart(8) +
      pfStr.padStart(8) +
      pnlStr.padStart(12) +
      String(stats.monthsActive).padStart(8)
    );
  }

  // Find profitable combos
  const profitableCombos = sortedStats.filter(s => s.totalPnL > 0 && s.trades >= 20);
  const combosWithEdge = sortedStats.filter(s => s.winRate > 0.50 && s.trades >= 20);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  console.log(`\nProfitable Combos (P&L > 0, >= 20 trades): ${profitableCombos.length}`);
  for (const combo of profitableCombos) {
    console.log(`  ✅ ${combo.levelName}|${combo.session}: +$${combo.totalPnL.toFixed(0)} (${(combo.winRate * 100).toFixed(1)}% win, ${combo.trades} trades, ${combo.monthsActive} months)`);
  }

  console.log(`\nCombos with Edge (WR > 50%, >= 20 trades): ${combosWithEdge.length}`);
  for (const combo of combosWithEdge.sort((a, b) => b.winRate - a.winRate)) {
    const pnlSign = combo.totalPnL >= 0 ? '+' : '';
    console.log(`  📊 ${combo.levelName}|${combo.session}: ${(combo.winRate * 100).toFixed(1)}% win (${pnlSign}$${combo.totalPnL.toFixed(0)}, ${combo.trades} trades)`);
  }

  // Generate optimal configuration
  if (profitableCombos.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('RECOMMENDED CONFIGURATION');
    console.log('═══════════════════════════════════════════════════════════════════════════════');

    const levelSessionRules = {};
    for (const combo of profitableCombos) {
      if (!levelSessionRules[combo.levelName]) {
        levelSessionRules[combo.levelName] = [];
      }
      levelSessionRules[combo.levelName].push(combo.session);
    }

    console.log('\nlevelSessionRules: ' + JSON.stringify(levelSessionRules, null, 2));

    // Calculate potential performance with these rules
    const filteredTrades = profitableCombos.reduce((sum, c) => sum + c.trades, 0);
    const filteredPnL = profitableCombos.reduce((sum, c) => sum + c.totalPnL, 0);
    const filteredWins = profitableCombos.reduce((sum, c) => sum + c.wins, 0);

    console.log(`\nProjected with filtered rules:`);
    console.log(`  Trades: ${filteredTrades}`);
    console.log(`  Win Rate: ${(filteredWins / filteredTrades * 100).toFixed(1)}%`);
    console.log(`  Total P&L: +$${filteredPnL.toFixed(0)}`);
  }

  // Year totals
  const totalTrades = monthlyResults.reduce((sum, r) => sum + r.trades, 0);
  const totalPnL = monthlyResults.reduce((sum, r) => sum + r.totalPnL, 0);
  const avgMonthlyPnL = totalPnL / monthlyResults.length;

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('YEAR TOTALS');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Total P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`);
  console.log(`Avg Monthly P&L: ${avgMonthlyPnL >= 0 ? '+' : ''}$${avgMonthlyPnL.toFixed(0)}`);
  console.log(`Months with Data: ${monthlyResults.length}/12`);
}

main().catch(console.error);
