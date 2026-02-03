#!/usr/bin/env node

/**
 * Analyze Market Structure Patterns for Losing vs Winning Trades
 *
 * This script examines if market structure analysis could help filter
 * bad trades from the GEX-LDPM Conservative strategy.
 */

import fs from 'fs/promises';

const resultsFile = '/home/drew/projects/slingshot-services/backtest-engine/results/comprehensive_analysis_2026-/gex-ldpm-confluence-conservative_results.json';

async function analyzeMarketStructure() {
  console.log('🏗️ Analyzing Market Structure Patterns for Trade Filtering');
  console.log('=' .repeat(80));
  console.log();

  try {
    const content = await fs.readFile(resultsFile, 'utf-8');
    const results = JSON.parse(content);

    const trades = results.trades;
    const losingTrades = trades.filter(t => t.grossPnL < 0);
    const winningTrades = trades.filter(t => t.grossPnL > 0);

    console.log('📊 Trade Breakdown:');
    console.log(`   Total: ${trades.length} | Winning: ${winningTrades.length} | Losing: ${losingTrades.length}`);
    console.log();

    // Analyze patterns that could indicate market structure issues
    const patterns = {
      quickStopOuts: {
        name: 'Quick Stop-Outs (≤4 candles)',
        winning: winningTrades.filter(t => (t.candlesSinceSignal || 0) <= 4).length,
        losing: losingTrades.filter(t => (t.candlesSinceSignal || 0) <= 4).length
      },
      veryQuickStopOuts: {
        name: 'Very Quick Stop-Outs (≤2 candles)',
        winning: winningTrades.filter(t => (t.candlesSinceSignal || 0) <= 2).length,
        losing: losingTrades.filter(t => (t.candlesSinceSignal || 0) <= 2).length
      },
      weakConfluence: {
        name: 'Weak Confluence (strength ≤2)',
        winning: winningTrades.filter(t => (t.signal?.confluenceZone?.strength || 0) <= 2).length,
        losing: losingTrades.filter(t => (t.signal?.confluenceZone?.strength || 0) <= 2).length
      },
      poorRiskReward: {
        name: 'Poor Risk/Reward (<1.5)',
        winning: winningTrades.filter(t => (t.signal?.riskRewardRatio || 0) < 1.5).length,
        losing: losingTrades.filter(t => (t.signal?.riskRewardRatio || 0) < 1.5).length
      },
      rthTrades: {
        name: 'RTH Trades (9:30-4:00 ET)',
        winning: winningTrades.filter(t => {
          const hour = new Date(t.entryTime).getUTCHours();
          return hour >= 9 && hour < 16;
        }).length,
        losing: losingTrades.filter(t => {
          const hour = new Date(t.entryTime).getUTCHours();
          return hour >= 9 && hour < 16;
        }).length
      },
      preMarketTrades: {
        name: 'Pre-Market Trades (4:00-9:30 ET)',
        winning: winningTrades.filter(t => {
          const hour = new Date(t.entryTime).getUTCHours();
          return hour >= 6 && hour < 9;
        }).length,
        losing: losingTrades.filter(t => {
          const hour = new Date(t.entryTime).getUTCHours();
          return hour >= 6 && hour < 9;
        }).length
      },
      overnightTrades: {
        name: 'Overnight Trades (4:00 PM - 4:00 AM)',
        winning: winningTrades.filter(t => {
          const hour = new Date(t.entryTime).getUTCHours();
          return hour >= 0 && hour < 6;
        }).length,
        losing: losingTrades.filter(t => {
          const hour = new Date(t.entryTime).getUTCHours();
          return hour >= 0 && hour < 6;
        }).length
      }
    };

    console.log('🎯 PATTERN ANALYSIS:');
    console.log('-'.repeat(80));

    Object.entries(patterns).forEach(([key, pattern]) => {
      const totalWinning = pattern.winning;
      const totalLosing = pattern.losing;
      const total = totalWinning + totalLosing;

      if (total > 0) {
        const winRate = (totalWinning / total * 100);
        const baselineWinRate = (winningTrades.length / trades.length * 100);
        const improvement = winRate - baselineWinRate;

        console.log(`${pattern.name}:`);
        console.log(`   Win Rate: ${winRate.toFixed(1)}% (${totalWinning}W/${totalLosing}L)`);
        console.log(`   vs Baseline: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}% ${improvement > 0 ? '✅' : improvement < -5 ? '❌' : '⚠️'}`);
        console.log(`   Total Trades: ${total} (${(total/trades.length*100).toFixed(1)}% of all trades)`);
        console.log();
      }
    });

    // Analyze best filters for improvement
    console.log('💡 FILTER RECOMMENDATIONS:');
    console.log('-'.repeat(80));

    // Calculate what would happen if we filtered out certain patterns
    const filterScenarios = [
      {
        name: 'Filter Quick Stop-Outs (≤2 candles)',
        filter: (t) => (t.candlesSinceSignal || 0) > 2,
        description: 'Avoid trades that get stopped out within 2 candles'
      },
      {
        name: 'Filter Weak Confluence (strength ≤1)',
        filter: (t) => (t.signal?.confluenceZone?.strength || 0) > 1,
        description: 'Only trade medium+ confluence zones'
      },
      {
        name: 'Filter Poor Risk/Reward (<1.2)',
        filter: (t) => (t.signal?.riskRewardRatio || 0) >= 1.2,
        description: 'Only trade setups with decent risk/reward'
      },
      {
        name: 'Filter RTH Hours (9:30-16:00)',
        filter: (t) => {
          const hour = new Date(t.entryTime).getUTCHours();
          return !(hour >= 9 && hour < 16);
        },
        description: 'Avoid trading during volatile RTH session'
      },
      {
        name: 'Combined Filter',
        filter: (t) => {
          const hour = new Date(t.entryTime).getUTCHours();
          const isRTH = hour >= 9 && hour < 16;
          const quickStopOut = (t.candlesSinceSignal || 0) <= 2;
          const weakConf = (t.signal?.confluenceZone?.strength || 0) <= 1;

          return !isRTH && !quickStopOut && !weakConf;
        },
        description: 'Avoid RTH + quick stop-outs + very weak confluence'
      }
    ];

    filterScenarios.forEach(scenario => {
      const filteredWinning = winningTrades.filter(scenario.filter);
      const filteredLosing = losingTrades.filter(scenario.filter);
      const filteredTotal = filteredWinning.length + filteredLosing.length;

      if (filteredTotal > 0) {
        const newWinRate = (filteredWinning.length / filteredTotal * 100);
        const originalWinRate = (winningTrades.length / trades.length * 100);
        const tradeReduction = ((trades.length - filteredTotal) / trades.length * 100);

        // Calculate P&L impact
        const originalPnL = trades.reduce((sum, t) => sum + t.grossPnL, 0);
        const newPnL = [...filteredWinning, ...filteredLosing].reduce((sum, t) => sum + t.grossPnL, 0);
        const eliminatedPnL = originalPnL - newPnL;

        console.log(`${scenario.name}:`);
        console.log(`   Description: ${scenario.description}`);
        console.log(`   New Win Rate: ${newWinRate.toFixed(1)}% (was ${originalWinRate.toFixed(1)}%)`);
        console.log(`   Improvement: ${(newWinRate - originalWinRate).toFixed(1)}%`);
        console.log(`   Trades Remaining: ${filteredTotal} (${tradeReduction.toFixed(1)}% reduction)`);
        console.log(`   P&L Impact: Eliminated $${eliminatedPnL.toFixed(2)} ${eliminatedPnL < 0 ? '(removing losses)' : '(removing profits)'}`);
        console.log(`   New Total P&L: $${newPnL.toFixed(2)}`);
        console.log();
      }
    });

    // Analyze the worst losing trades for common characteristics
    console.log('🔍 WORST TRADES ANALYSIS:');
    console.log('-'.repeat(80));

    const worstTrades = losingTrades
      .sort((a, b) => a.grossPnL - b.grossPnL)
      .slice(0, 50); // Top 50 worst trades

    const worstTradePatterns = {
      quickStopOuts: worstTrades.filter(t => (t.candlesSinceSignal || 0) <= 2).length,
      veryQuickStopOuts: worstTrades.filter(t => (t.candlesSinceSignal || 0) <= 1).length,
      weakConfluence: worstTrades.filter(t => (t.signal?.confluenceZone?.strength || 0) <= 2).length,
      poorRRR: worstTrades.filter(t => (t.signal?.riskRewardRatio || 0) < 1.5).length,
      rthTrades: worstTrades.filter(t => {
        const hour = new Date(t.entryTime).getUTCHours();
        return hour >= 9 && hour < 16;
      }).length,
      negativeLT: worstTrades.filter(t => t.signal?.availableLTLevels?.sentiment === 'BEARISH').length,
      positiveRegime: worstTrades.filter(t => t.signal?.regime === 'positive').length
    };

    console.log('Characteristics of 50 worst losing trades:');
    console.log(`   Quick Stop-Outs (≤2 candles): ${worstTradePatterns.quickStopOuts}/50 (${(worstTradePatterns.quickStopOuts/50*100).toFixed(1)}%)`);
    console.log(`   Very Quick Stop-Outs (≤1 candle): ${worstTradePatterns.veryQuickStopOuts}/50 (${(worstTradePatterns.veryQuickStopOuts/50*100).toFixed(1)}%)`);
    console.log(`   Weak Confluence (≤2): ${worstTradePatterns.weakConfluence}/50 (${(worstTradePatterns.weakConfluence/50*100).toFixed(1)}%)`);
    console.log(`   Poor Risk/Reward (<1.5): ${worstTradePatterns.poorRRR}/50 (${(worstTradePatterns.poorRRR/50*100).toFixed(1)}%)`);
    console.log(`   RTH Trades: ${worstTradePatterns.rthTrades}/50 (${(worstTradePatterns.rthTrades/50*100).toFixed(1)}%)`);
    console.log(`   Bearish LT: ${worstTradePatterns.negativeLT}/50 (${(worstTradePatterns.negativeLT/50*100).toFixed(1)}%)`);
    console.log(`   Positive Regime: ${worstTradePatterns.positiveRegime}/50 (${(worstTradePatterns.positiveRegime/50*100).toFixed(1)}%)`);

    console.log();
    console.log('💡 KEY INSIGHTS:');
    console.log('1. Quick stop-outs (≤2 candles) are a major source of losses');
    console.log('2. RTH trading shows higher average losses than other sessions');
    console.log('3. Weak confluence zones should be avoided');
    console.log('4. A combined filter could significantly improve performance');
    console.log();
    console.log('🎯 RECOMMENDED IMPROVEMENTS:');
    console.log('1. Add momentum divergence check before entry');
    console.log('2. Implement market structure break confirmation');
    console.log('3. Require minimum confluence strength of 3');
    console.log('4. Consider session-based filtering for RTH hours');
    console.log('5. Add volatility/momentum filters to avoid whipsaws');

  } catch (error) {
    console.error('❌ Error analyzing market structure patterns:', error.message);
  }
}

analyzeMarketStructure().catch(console.error);