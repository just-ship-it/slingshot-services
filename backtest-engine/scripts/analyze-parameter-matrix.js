#!/usr/bin/env node

/**
 * Analyze Parameter Matrix Results
 *
 * Reads backtest results from results/parameter-matrix/ and generates
 * a summary table showing performance metrics at each symmetric point level.
 *
 * Usage:
 *   node scripts/analyze-parameter-matrix.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const RESULTS_DIR = path.join(projectRoot, 'results', 'parameter-matrix');
const POINT_LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

// Contract specifications (NQ = $20/point)
const POINT_VALUE = 20;

function loadResults() {
  const results = [];

  for (const points of POINT_LEVELS) {
    const filePath = path.join(RESULTS_DIR, `symmetric-${points}pts.json`);

    if (!fs.existsSync(filePath)) {
      console.warn(`Warning: Missing results file for ${points} points`);
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const perf = data.performance;

      results.push({
        points,
        trades: perf.basic.totalTrades || 0,
        wins: perf.basic.winningTrades || 0,
        losses: perf.basic.losingTrades || 0,
        winRate: perf.basic.winRate || 0,
        totalPnL: perf.basic.totalPnL || 0,
        avgWin: perf.basic.avgWin || 0,
        avgLoss: Math.abs(perf.basic.avgLoss) || 0,
        profitFactor: perf.basic.profitFactor || 0,
        maxDrawdown: perf.summary?.maxDrawdown || 0,
        sharpe: perf.summary?.sharpeRatio || 0,
        // Exit analysis
        stopLossExits: perf.exitAnalysis?.stopLoss || 0,
        takeProfitExits: perf.exitAnalysis?.takeProfit || 0,
        trailingStopExits: perf.exitAnalysis?.trailingStop || 0,
        timeoutExits: perf.exitAnalysis?.timeout || 0,
        // Calculate theoretical breakeven win rate for this level
        breakevenWinRate: 50.0  // Symmetric stop/target always has 50% breakeven
      });
    } catch (err) {
      console.error(`Error loading ${points}pts: ${err.message}`);
    }
  }

  return results;
}

function formatNumber(num, decimals = 0) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  return num.toFixed(decimals);
}

function formatMoney(num) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  const prefix = num >= 0 ? '$' : '-$';
  return prefix + Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPercent(num) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  return num.toFixed(1) + '%';
}

function printSummaryTable(results) {
  console.log('');
  console.log('='.repeat(110));
  console.log(' SYMMETRIC STOP/TARGET PARAMETER MATRIX RESULTS');
  console.log('='.repeat(110));
  console.log('');
  console.log('Strategy: iv-skew-gex | Timeframe: 15m | Date Range: 2025-01-13 to 2025-12-24');
  console.log('Question: What percentage of trades reach X points profit before hitting X points loss?');
  console.log('');
  console.log('-'.repeat(110));
  console.log(
    'Points'.padEnd(8) +
    'Trades'.padStart(8) +
    'Win Rate'.padStart(10) +
    'Edge'.padStart(8) +
    'Total P&L'.padStart(12) +
    'Avg Win'.padStart(10) +
    'Avg Loss'.padStart(10) +
    'PF'.padStart(6) +
    'Max DD'.padStart(10) +
    'Sharpe'.padStart(8) +
    'TP Exits'.padStart(10) +
    'SL Exits'.padStart(10)
  );
  console.log('-'.repeat(110));

  for (const r of results) {
    // Edge = Win Rate - Breakeven Win Rate (50% for symmetric)
    const edge = r.winRate - 50.0;

    console.log(
      String(r.points).padEnd(8) +
      String(r.trades).padStart(8) +
      formatPercent(r.winRate).padStart(10) +
      (edge >= 0 ? '+' : '') + formatPercent(edge).padStart(7) +
      formatMoney(r.totalPnL).padStart(12) +
      formatMoney(r.avgWin).padStart(10) +
      formatMoney(r.avgLoss).padStart(10) +
      formatNumber(r.profitFactor, 2).padStart(6) +
      formatMoney(r.maxDrawdown).padStart(10) +
      formatNumber(r.sharpe, 2).padStart(8) +
      String(r.takeProfitExits).padStart(10) +
      String(r.stopLossExits).padStart(10)
    );
  }

  console.log('-'.repeat(110));
  console.log('');
}

function printInsights(results) {
  console.log('KEY INSIGHTS:');
  console.log('='.repeat(60));
  console.log('');

  // Find best performers
  const byWinRate = [...results].sort((a, b) => b.winRate - a.winRate);
  const byPnL = [...results].sort((a, b) => b.totalPnL - a.totalPnL);
  const byPF = [...results].sort((a, b) => b.profitFactor - a.profitFactor);
  const bySharpe = [...results].sort((a, b) => b.sharpe - a.sharpe);

  // Best win rate
  if (byWinRate.length > 0) {
    const best = byWinRate[0];
    console.log(`1. HIGHEST WIN RATE: ${best.points} points`);
    console.log(`   Win Rate: ${formatPercent(best.winRate)} (${formatPercent(best.winRate - 50)} edge over breakeven)`);
    console.log(`   This means ${formatPercent(best.winRate)} of trades reach ${best.points}pt profit before ${best.points}pt loss`);
    console.log('');
  }

  // Best P&L
  if (byPnL.length > 0) {
    const best = byPnL[0];
    console.log(`2. HIGHEST TOTAL P&L: ${best.points} points`);
    console.log(`   Total P&L: ${formatMoney(best.totalPnL)} from ${best.trades} trades`);
    console.log(`   Average P&L per trade: ${formatMoney(best.totalPnL / best.trades)}`);
    console.log('');
  }

  // Best Profit Factor
  if (byPF.length > 0) {
    const best = byPF[0];
    console.log(`3. BEST PROFIT FACTOR: ${best.points} points`);
    console.log(`   Profit Factor: ${formatNumber(best.profitFactor, 2)}`);
    console.log(`   Gross profit / Gross loss ratio`);
    console.log('');
  }

  // Find where win rate drops below 50%
  const belowBreakeven = results.filter(r => r.winRate < 50);
  if (belowBreakeven.length > 0) {
    const firstBelow = belowBreakeven.sort((a, b) => a.points - b.points)[0];
    console.log(`4. WIN RATE DROPS BELOW 50%: Starting at ${firstBelow.points} points`);
    console.log(`   At this level, win rate is ${formatPercent(firstBelow.winRate)}`);
    console.log(`   The market moves against you more often before reaching target`);
    console.log('');
  } else {
    console.log(`4. WIN RATE ABOVE 50%: All tested levels maintain >50% win rate`);
    console.log(`   The strategy has positive edge across all tested point levels`);
    console.log('');
  }

  // Trades reaching higher levels
  console.log('5. TRADE REACHABILITY ANALYSIS:');
  for (const r of results) {
    if (r.trades > 0) {
      const reachPercent = (r.takeProfitExits / r.trades * 100);
      console.log(`   ${r.points} points: ${formatPercent(reachPercent)} of trades reached target`);
    }
  }
  console.log('');

  // Sweet spot recommendation
  const profitableWithGoodWinRate = results.filter(r => r.totalPnL > 0 && r.winRate >= 45);
  if (profitableWithGoodWinRate.length > 0) {
    // Sort by Sharpe to find risk-adjusted sweet spot
    const sweetSpot = profitableWithGoodWinRate.sort((a, b) => b.sharpe - a.sharpe)[0];
    console.log('6. RECOMMENDED SWEET SPOT:');
    console.log(`   ${sweetSpot.points} points symmetric stop/target`);
    console.log(`   Win Rate: ${formatPercent(sweetSpot.winRate)}, Sharpe: ${formatNumber(sweetSpot.sharpe, 2)}, PF: ${formatNumber(sweetSpot.profitFactor, 2)}`);
    console.log('');
  }
}

function writeSummaryFile(results) {
  const summaryPath = path.join(RESULTS_DIR, 'summary.txt');

  let output = '';
  output += 'SYMMETRIC STOP/TARGET PARAMETER MATRIX SUMMARY\n';
  output += '='.repeat(60) + '\n\n';
  output += 'Strategy: iv-skew-gex\n';
  output += 'Timeframe: 15m\n';
  output += 'Date Range: 2025-01-13 to 2025-12-24\n\n';

  output += 'Points,Trades,WinRate,Edge,TotalPnL,AvgWin,AvgLoss,PF,MaxDD,Sharpe,TPExits,SLExits\n';

  for (const r of results) {
    const edge = r.winRate - 50.0;
    output += `${r.points},${r.trades},${r.winRate.toFixed(1)},${edge.toFixed(1)},${r.totalPnL.toFixed(0)},${r.avgWin.toFixed(0)},${r.avgLoss.toFixed(0)},${r.profitFactor.toFixed(2)},${r.maxDrawdown.toFixed(0)},${r.sharpe.toFixed(2)},${r.takeProfitExits},${r.stopLossExits}\n`;
  }

  fs.writeFileSync(summaryPath, output);
  console.log(`Summary saved to: ${summaryPath}`);
}

function writeCSVFile(results) {
  const csvPath = path.join(RESULTS_DIR, 'summary.csv');

  let output = 'points,trades,win_rate,edge,total_pnl,avg_win,avg_loss,profit_factor,max_drawdown,sharpe,tp_exits,sl_exits,timeout_exits,trailing_exits\n';

  for (const r of results) {
    const edge = r.winRate - 50.0;
    output += `${r.points},${r.trades},${r.winRate.toFixed(2)},${edge.toFixed(2)},${r.totalPnL.toFixed(2)},${r.avgWin.toFixed(2)},${r.avgLoss.toFixed(2)},${r.profitFactor.toFixed(2)},${r.maxDrawdown.toFixed(2)},${r.sharpe.toFixed(2)},${r.takeProfitExits},${r.stopLossExits},${r.timeoutExits},${r.trailingStopExits}\n`;
  }

  fs.writeFileSync(csvPath, output);
  console.log(`CSV saved to: ${csvPath}`);
}

// Main execution
function main() {
  console.log('Loading results from:', RESULTS_DIR);

  const results = loadResults();

  if (results.length === 0) {
    console.error('No results found! Run the backtests first with:');
    console.error('  ./scripts/run-parameter-matrix.sh');
    process.exit(1);
  }

  console.log(`Found ${results.length} result files`);

  printSummaryTable(results);
  printInsights(results);
  writeSummaryFile(results);
  writeCSVFile(results);

  console.log('');
  console.log('Analysis complete!');
}

main();
