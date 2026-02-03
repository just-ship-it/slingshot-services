#!/usr/bin/env node

/**
 * Full Backtest of Pullback Strategy
 *
 * Runs the enhanced pullback strategy on the same Q4 2025 dataset
 * to compare with the original conservative strategy results.
 */

import { BacktestEngine } from './src/backtest-engine.js';

async function testPullbackStrategy() {
  console.log('🎯 Running Full Pullback Strategy Backtest');
  console.log('=' .repeat(80));
  console.log();

  // Same timeframe as the conservative strategy we analyzed
  const config = {
    ticker: 'NQ',
    startDate: new Date('2023-04-04'),
    endDate: new Date('2025-12-19'),
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      // Base parameters (same as conservative)
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,
      tradingSymbol: 'NQ',

      // Pullback system parameters
      enablePullbackSystem: true,
      maxPullbackWait: 12,           // 12 hours to wait for pullback
      maxPullbackDistance: 50,       // Max 50 points from signal
      minPullbackDistance: 10,       // Min 10 points for valid pullback
      requireMomentumAlignment: false, // Start without momentum requirement for more trades
      requireLevelRespect: false,     // Start without level respect requirement

      // Level detector weights
      structuralLevelWeight: 1.0,
      sessionLevelWeight: 1.5,       // Prioritize session levels (previous day, overnight)
      fibonacciLevelWeight: 0.8
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: false,
    quiet: false,
    showTrades: false,
    outputJson: 'results/gex-ldpm-pullback_results.json'
  };

  console.log('📅 Test Period: 2023-04-04 to 2025-12-19 (Same as conservative)');
  console.log('📊 Strategy: GEX-LDPM Confluence with Pullback Entry System');
  console.log('⚙️  Configuration:');
  console.log(`   • Confluence Threshold: ${config.strategyParams.confluenceThreshold} points`);
  console.log(`   • Entry Distance: ${config.strategyParams.entryDistance} points`);
  console.log(`   • Stop Loss: ${config.strategyParams.stopLossPoints} points`);
  console.log(`   • Pullback Wait: ${config.strategyParams.maxPullbackWait} hours`);
  console.log(`   • Pullback Range: ${config.strategyParams.minPullbackDistance}-${config.strategyParams.maxPullbackDistance} points`);
  console.log(`   • Momentum Filter: ${config.strategyParams.requireMomentumAlignment ? 'ON' : 'OFF'}`);
  console.log();

  try {
    const engine = new BacktestEngine(config);
    const results = await engine.run();

    console.log();
    console.log('=' .repeat(80));
    console.log('📊 PULLBACK STRATEGY RESULTS vs CONSERVATIVE BASELINE');
    console.log('=' .repeat(80));
    console.log();

    // Display key metrics
    const perf = results?.performance?.summary || {};
    const basic = results?.performance?.basic || {};
    const advanced = results?.performance?.advanced || {};

    // Conservative baseline (from our analysis)
    const conservativeBaseline = {
      trades: 1343,
      winRate: 47.8,
      netPnL: 116760,
      maxDrawdown: 12.3,
      sharpe: 1.85
    };

    console.log('                     CONSERVATIVE        PULLBACK          CHANGE');
    console.log('-'.repeat(70));

    const trades = perf.totalTrades || basic.totalTrades || 0;
    const tradeChange = trades - conservativeBaseline.trades;
    console.log(`Total Trades:        ${conservativeBaseline.trades.toString().padEnd(18)} ${trades.toString().padEnd(18)} ${tradeChange >= 0 ? '+' : ''}${tradeChange} (${(tradeChange/conservativeBaseline.trades*100).toFixed(1)}%)`);

    const winRate = perf.winRate || basic.winRate || 0;
    const winRateChange = winRate - conservativeBaseline.winRate;
    console.log(`Win Rate:            ${conservativeBaseline.winRate.toFixed(1)}%`.padEnd(19) + ` ${winRate.toFixed(1)}%`.padEnd(19) + ` ${winRateChange >= 0 ? '+' : ''}${winRateChange.toFixed(1)}%`);

    const netPnL = perf.totalPnL || basic.netPnL || 0;
    const pnlChange = netPnL - conservativeBaseline.netPnL;
    const pnlChangePct = (pnlChange / conservativeBaseline.netPnL * 100);
    console.log(`Net P&L:             $${conservativeBaseline.netPnL.toFixed(0).padEnd(17)} $${netPnL.toFixed(0).padEnd(17)} ${pnlChange >= 0 ? '+' : ''}$${pnlChange.toFixed(0)} (${pnlChange >= 0 ? '+' : ''}${pnlChangePct.toFixed(1)}%)`);

    const maxDD = perf.maxDrawdown || advanced.maxDrawdown || 0;
    const ddChange = maxDD - conservativeBaseline.maxDrawdown;
    console.log(`Max Drawdown:        ${conservativeBaseline.maxDrawdown.toFixed(1)}%`.padEnd(19) + ` ${maxDD.toFixed(1)}%`.padEnd(19) + ` ${ddChange >= 0 ? '+' : ''}${ddChange.toFixed(1)}%`);

    const sharpe = perf.sharpeRatio || advanced.sharpeRatio || 0;
    const sharpeChange = sharpe - conservativeBaseline.sharpe;
    console.log(`Sharpe Ratio:        ${conservativeBaseline.sharpe.toFixed(2).padEnd(18)} ${sharpe.toFixed(2).padEnd(18)} ${sharpeChange >= 0 ? '+' : ''}${sharpeChange.toFixed(2)}`);

    console.log();

    // Assessment
    console.log('🎯 PERFORMANCE ASSESSMENT:');
    console.log('-'.repeat(70));

    if (trades === 0) {
      console.log('❌ No trades generated - pullback parameters may be too strict');
      console.log();
      console.log('💡 Suggested adjustments:');
      console.log('   • Increase maxPullbackDistance to 75-100 points');
      console.log('   • Reduce minPullbackDistance to 5 points');
      console.log('   • Increase maxPullbackWait to 24 hours');
    } else {
      const improvements = [];
      const issues = [];

      if (winRateChange > 2) improvements.push(`Win rate improved by ${winRateChange.toFixed(1)}%`);
      else if (winRateChange < -2) issues.push(`Win rate decreased by ${Math.abs(winRateChange).toFixed(1)}%`);

      if (pnlChange > 0) improvements.push(`P&L increased by $${pnlChange.toFixed(0)} (${pnlChangePct.toFixed(1)}%)`);
      else if (pnlChange < 0) issues.push(`P&L decreased by $${Math.abs(pnlChange).toFixed(0)}`);

      if (ddChange < -1) improvements.push(`Drawdown reduced by ${Math.abs(ddChange).toFixed(1)}%`);
      else if (ddChange > 1) issues.push(`Drawdown increased by ${ddChange.toFixed(1)}%`);

      if (sharpeChange > 0.1) improvements.push(`Sharpe ratio improved by ${sharpeChange.toFixed(2)}`);
      else if (sharpeChange < -0.1) issues.push(`Sharpe ratio decreased by ${Math.abs(sharpeChange).toFixed(2)}`);

      if (improvements.length > 0) {
        console.log('✅ Improvements:');
        improvements.forEach(imp => console.log(`   • ${imp}`));
      }

      if (issues.length > 0) {
        console.log();
        console.log('⚠️  Issues to address:');
        issues.forEach(issue => console.log(`   • ${issue}`));
      }

      // Overall verdict
      console.log();
      const score = (winRateChange > 0 ? 1 : 0) +
                   (pnlChange > 0 ? 2 : 0) +
                   (ddChange < 0 ? 2 : 0) +
                   (sharpeChange > 0 ? 1 : 0);

      if (score >= 4) {
        console.log('🏆 EXCELLENT - Pullback strategy shows significant improvement!');
      } else if (score >= 2) {
        console.log('👍 POSITIVE - Pullback strategy shows improvement in key areas.');
      } else {
        console.log('🔧 NEEDS TUNING - Adjust pullback parameters for better results.');
      }
    }

    // Sample trades for inspection
    if (results.trades && results.trades.length > 0) {
      console.log();
      console.log('📋 SAMPLE PULLBACK TRADES:');
      console.log('-'.repeat(70));

      const sampleTrades = results.trades.slice(0, 5);
      sampleTrades.forEach((trade, i) => {
        const entryDate = new Date(trade.entryTime);
        console.log(`${i + 1}. ${trade.side?.toUpperCase()} at ${entryDate.toISOString().slice(0, 19)}`);
        console.log(`   Entry: $${trade.entryPrice || trade.signal?.price} | Exit: $${trade.exitPrice || trade.actualExit}`);
        console.log(`   P&L: $${trade.grossPnL || trade.pnl} | ${trade.exitReason}`);
        if (trade.signal?.pullbackLevel) {
          console.log(`   Pullback: ${trade.signal.pullbackLevel.source} level at $${trade.signal.pullbackLevel.price}`);
        }
      });
    }

    console.log();
    console.log('✅ Backtest complete!');
    console.log(`📄 Full results saved to: ${config.outputJson}`);

  } catch (error) {
    console.error('❌ Error running pullback strategy:', error.message);
    console.error(error.stack);
  }
}

// Run test
testPullbackStrategy().catch(console.error);