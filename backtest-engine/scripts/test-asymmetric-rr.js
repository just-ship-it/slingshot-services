#!/usr/bin/env node

/**
 * Test Asymmetric R/R Matrix
 *
 * Systematically tests multiple stop/target combinations to identify
 * optimal risk/reward ratios for the CBBO-LT Volatility strategy.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backtestDir = join(__dirname, '..');

// Test matrix: stops vs targets
const stops = [10, 15, 20, 25, 30, 40, 50];
const targets = [20, 30, 40, 50, 60, 80, 100];

// Results storage
const results = [];

/**
 * Run a single backtest configuration
 */
function runBacktest(stopPoints, targetPoints) {
  return new Promise((resolve, reject) => {
    const args = [
      'index.js',
      '--ticker', 'NQ',
      '--start', '2025-01-13',
      '--end', '2025-01-31',
      '--strategy', 'cbbo-lt-volatility',
      '--timeframe', '5m',
      '--stop-buffer', stopPoints.toString(),
      '--target-points', targetPoints.toString()
    ];

    console.log(`\n🧪 Testing: Stop=${stopPoints}pts, Target=${targetPoints}pts (R/R=${(targetPoints/stopPoints).toFixed(2)})`);

    const proc = spawn('node', args, { cwd: backtestDir });
    let output = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Backtest failed with code ${code}`));
        return;
      }

      // Parse results from output
      const result = parseBacktestOutput(output, stopPoints, targetPoints);
      resolve(result);
    });
  });
}

/**
 * Parse backtest output to extract key metrics
 */
function parseBacktestOutput(output, stopPoints, targetPoints) {
  const result = {
    stop: stopPoints,
    target: targetPoints,
    rr: (targetPoints / stopPoints).toFixed(2),
    trades: 0,
    winRate: 0,
    profitFactor: 0,
    totalPnl: 0,
    totalReturn: 0,
    maxDrawdown: 0,
    expectancy: 0,
    avgWin: 0,
    avgLoss: 0,
    winningTrades: 0,
    losingTrades: 0
  };

  // Extract metrics using regex
  const tradesMatch = output.match(/Total Trades\s+│\s+(\d+)/);
  const winRateMatch = output.match(/Win Rate\s+│\s+([\d.]+)%/);
  const pfMatch = output.match(/Profit Factor\s+│\s+([\d.]+)/);
  const pnlMatch = output.match(/Total P&L\s+│\s+\$(-?[\d,]+)/);
  const returnMatch = output.match(/Total Return\s+│\s+(-?[\d.]+)%/);
  const ddMatch = output.match(/Max Drawdown\s+│\s+([\d.]+)%/);
  const expectancyMatch = output.match(/Expectancy\s+│\s+\$(-?[\d.]+)/);
  const avgWinMatch = output.match(/Average Win\s+│\s+\$(-?[\d.,]+)/);
  const avgLossMatch = output.match(/Average Loss\s+│\s+\$(-?[\d.,]+)/);
  const winningTradesMatch = output.match(/Winning Trades\s+│\s+(\d+)/);
  const losingTradesMatch = output.match(/Losing Trades\s+│\s+(\d+)/);

  if (tradesMatch) result.trades = parseInt(tradesMatch[1]);
  if (winRateMatch) result.winRate = parseFloat(winRateMatch[1]);
  if (pfMatch) result.profitFactor = parseFloat(pfMatch[1]);
  if (pnlMatch) result.totalPnl = parseInt(pnlMatch[1].replace(/,/g, ''));
  if (returnMatch) result.totalReturn = parseFloat(returnMatch[1]);
  if (ddMatch) result.maxDrawdown = parseFloat(ddMatch[1]);
  if (expectancyMatch) result.expectancy = parseFloat(expectancyMatch[1]);
  if (avgWinMatch) result.avgWin = parseFloat(avgWinMatch[1].replace(/,/g, ''));
  if (avgLossMatch) result.avgLoss = parseFloat(avgLossMatch[1].replace(/,/g, ''));
  if (winningTradesMatch) result.winningTrades = parseInt(winningTradesMatch[1]);
  if (losingTradesMatch) result.losingTrades = parseInt(losingTradesMatch[1]);

  return result;
}

/**
 * Generate console table output
 */
function generateTable(results) {
  console.log('\n\n');
  console.log('═'.repeat(120));
  console.log('📊 ASYMMETRIC R/R PROBABILITY MATRIX - CBBO-LT VOLATILITY STRATEGY');
  console.log('═'.repeat(120));
  console.log('\n📈 WIN RATE MATRIX (%)');
  console.log('─'.repeat(120));

  // Win Rate Matrix
  const header = 'Stop/Target │ ' + targets.map(t => `${t}pts`.padStart(8)).join(' │ ');
  console.log(header);
  console.log('─'.repeat(120));

  for (const stop of stops) {
    const row = results.filter(r => r.stop === stop);
    const values = targets.map(target => {
      const result = row.find(r => r.target === target);
      if (!result) return '  -     ';
      const winRate = result.winRate.toFixed(1);
      // Color code: green if > 50%, yellow if > 40%, red otherwise
      if (result.winRate >= 50) return `\x1b[32m${winRate.padStart(6)}%\x1b[0m`;
      if (result.winRate >= 40) return `\x1b[33m${winRate.padStart(6)}%\x1b[0m`;
      return `\x1b[31m${winRate.padStart(6)}%\x1b[0m`;
    });
    console.log(`${stop.toString().padStart(5)}pts    │ ${values.join(' │ ')}`);
  }

  console.log('\n💰 TOTAL P&L MATRIX ($)');
  console.log('─'.repeat(120));
  console.log(header);
  console.log('─'.repeat(120));

  for (const stop of stops) {
    const row = results.filter(r => r.stop === stop);
    const values = targets.map(target => {
      const result = row.find(r => r.target === target);
      if (!result) return '  -     ';
      const pnl = result.totalPnl;
      const formatted = (pnl >= 0 ? '+' : '') + (pnl / 1000).toFixed(1) + 'K';
      // Color code: green if positive, red if negative
      if (pnl >= 0) return `\x1b[32m${formatted.padStart(8)}\x1b[0m`;
      return `\x1b[31m${formatted.padStart(8)}\x1b[0m`;
    });
    console.log(`${stop.toString().padStart(5)}pts    │ ${values.join(' │ ')}`);
  }

  console.log('\n📊 PROFIT FACTOR MATRIX');
  console.log('─'.repeat(120));
  console.log(header);
  console.log('─'.repeat(120));

  for (const stop of stops) {
    const row = results.filter(r => r.stop === stop);
    const values = targets.map(target => {
      const result = row.find(r => r.target === target);
      if (!result) return '  -     ';
      const pf = result.profitFactor.toFixed(2);
      // Color code: green if > 1.5, yellow if > 1.0, red otherwise
      if (result.profitFactor >= 1.5) return `\x1b[32m${pf.padStart(8)}\x1b[0m`;
      if (result.profitFactor >= 1.0) return `\x1b[33m${pf.padStart(8)}\x1b[0m`;
      return `\x1b[31m${pf.padStart(8)}\x1b[0m`;
    });
    console.log(`${stop.toString().padStart(5)}pts    │ ${values.join(' │ ')}`);
  }

  console.log('\n💵 EXPECTANCY MATRIX ($/trade)');
  console.log('─'.repeat(120));
  console.log(header);
  console.log('─'.repeat(120));

  for (const stop of stops) {
    const row = results.filter(r => r.stop === stop);
    const values = targets.map(target => {
      const result = row.find(r => r.target === target);
      if (!result) return '  -     ';
      const exp = result.expectancy.toFixed(0);
      const formatted = (result.expectancy >= 0 ? '+' : '') + exp;
      // Color code: green if positive, red if negative
      if (result.expectancy >= 0) return `\x1b[32m${formatted.padStart(8)}\x1b[0m`;
      return `\x1b[31m${formatted.padStart(8)}\x1b[0m`;
    });
    console.log(`${stop.toString().padStart(5)}pts    │ ${values.join(' │ ')}`);
  }

  console.log('\n🎯 R/R RATIO REFERENCE');
  console.log('─'.repeat(120));
  console.log(header);
  console.log('─'.repeat(120));

  for (const stop of stops) {
    const values = targets.map(target => {
      const rr = (target / stop).toFixed(2);
      return rr.padStart(8);
    });
    console.log(`${stop.toString().padStart(5)}pts    │ ${values.join(' │ ')}`);
  }

  console.log('\n📋 TOP 10 CONFIGURATIONS BY TOTAL P&L');
  console.log('─'.repeat(120));
  console.log('Rank │ Stop  │ Target │  R/R  │ Trades │ Win% │   P&L   │  PF   │ Exp/Trade │ Avg Win │ Avg Loss');
  console.log('─'.repeat(120));

  const sorted = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
  sorted.slice(0, 10).forEach((r, i) => {
    const profitable = r.totalPnl >= 0;
    const color = profitable ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(
      ` ${(i + 1).toString().padStart(2)}  │ ` +
      `${r.stop.toString().padStart(4)}pt │ ` +
      `${r.target.toString().padStart(5)}pt │ ` +
      `${r.rr.padStart(5)} │ ` +
      `${r.trades.toString().padStart(6)} │ ` +
      `${r.winRate.toFixed(1).padStart(4)}% │ ` +
      `${color}${(r.totalPnl >= 0 ? '+' : '')}${r.totalPnl.toLocaleString().padStart(7)}${reset} │ ` +
      `${r.profitFactor.toFixed(2).padStart(5)} │ ` +
      `${color}${(r.expectancy >= 0 ? '+' : '')}$${r.expectancy.toFixed(0).padStart(6)}${reset} │ ` +
      `$${r.avgWin.toFixed(0).padStart(6)} │ ` +
      `$${r.avgLoss.toFixed(0).padStart(7)}`
    );
  });

  console.log('\n📋 BOTTOM 10 CONFIGURATIONS BY TOTAL P&L');
  console.log('─'.repeat(120));
  console.log('Rank │ Stop  │ Target │  R/R  │ Trades │ Win% │   P&L   │  PF   │ Exp/Trade │ Avg Win │ Avg Loss');
  console.log('─'.repeat(120));

  sorted.slice(-10).reverse().forEach((r, i) => {
    const color = '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(
      ` ${(sorted.length - i).toString().padStart(2)}  │ ` +
      `${r.stop.toString().padStart(4)}pt │ ` +
      `${r.target.toString().padStart(5)}pt │ ` +
      `${r.rr.padStart(5)} │ ` +
      `${r.trades.toString().padStart(6)} │ ` +
      `${r.winRate.toFixed(1).padStart(4)}% │ ` +
      `${color}${(r.totalPnl >= 0 ? '+' : '')}${r.totalPnl.toLocaleString().padStart(7)}${reset} │ ` +
      `${r.profitFactor.toFixed(2).padStart(5)} │ ` +
      `${color}${(r.expectancy >= 0 ? '+' : '')}$${r.expectancy.toFixed(0).padStart(6)}${reset} │ ` +
      `$${r.avgWin.toFixed(0).padStart(6)} │ ` +
      `$${r.avgLoss.toFixed(0).padStart(7)}`
    );
  });
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Starting Asymmetric R/R Matrix Analysis');
  console.log(`📊 Testing ${stops.length} stops × ${targets.length} targets = ${stops.length * targets.length} configurations`);
  console.log('⏱️  Estimated time: ~' + Math.ceil((stops.length * targets.length * 30) / 60) + ' minutes\n');

  let completed = 0;
  const total = stops.length * targets.length;

  for (const stop of stops) {
    for (const target of targets) {
      try {
        const result = await runBacktest(stop, target);
        results.push(result);
        completed++;

        const progress = ((completed / total) * 100).toFixed(1);
        console.log(`✅ Complete: ${result.trades} trades, ${result.winRate.toFixed(1)}% win rate, ${result.totalPnl >= 0 ? '+' : ''}$${result.totalPnl.toLocaleString()} P&L`);
        console.log(`📈 Progress: ${completed}/${total} (${progress}%)\n`);
      } catch (error) {
        console.error(`❌ Failed: Stop=${stop}pts, Target=${target}pts`, error.message);
      }
    }
  }

  // Generate summary tables
  generateTable(results);

  // Save results to JSON
  const fs = await import('fs');
  const outputPath = join(backtestDir, 'results', 'asymmetric-rr-matrix.json');
  await fs.promises.mkdir(join(backtestDir, 'results'), { recursive: true });
  await fs.promises.writeFile(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to: ${outputPath}`);

  console.log('\n✅ Analysis complete!');
}

main().catch(console.error);
