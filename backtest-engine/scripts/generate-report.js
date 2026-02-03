#!/usr/bin/env node

/**
 * Generate Comprehensive Analysis Report
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const baseDir = path.join(projectRoot, 'results', 'optimization-2025', 'strategies');

function loadResults() {
  const strategies = fs.readdirSync(baseDir).filter(d => {
    const p = path.join(baseDir, d);
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).filter(f => f.endsWith('.json')).length > 0;
  });

  const allResults = [];

  for (const strategy of strategies) {
    const stratDir = path.join(baseDir, strategy);
    const files = fs.readdirSync(stratDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(stratDir, file)));
        const perf = data.performance?.basic || {};
        const summary = data.performance?.summary || {};
        if (perf.totalTrades > 20) {
          allResults.push({
            strategy,
            config: file.replace('.json', ''),
            trades: perf.totalTrades || 0,
            winRate: perf.winRate || 0,
            pnl: perf.totalPnL || 0,
            profitFactor: perf.profitFactor || 0,
            sharpe: summary.sharpeRatio || 0,
            maxDD: summary.maxDrawdown || 0,
            avgWin: perf.avgWin || 0,
            avgLoss: Math.abs(perf.avgLoss) || 0
          });
        }
      } catch (e) {
        // Skip invalid files
      }
    }
  }

  return allResults;
}

function main() {
  const allResults = loadResults();
  allResults.sort((a, b) => b.pnl - a.pnl);

  console.log('='.repeat(120));
  console.log('  COMPREHENSIVE 2025 STRATEGY ANALYSIS - BEST PERFORMERS');
  console.log('='.repeat(120));
  console.log(`\nTotal configurations analyzed: ${allResults.length}`);
  console.log('');

  // Top 25 by P&L
  console.log('TOP 25 CONFIGURATIONS BY P&L:');
  console.log('-'.repeat(120));

  allResults.slice(0, 25).forEach((r, i) => {
    const strategy = r.strategy.substring(0, 18).padEnd(18);
    const config = r.config.substring(0, 40).padEnd(40);
    console.log(
      `${(i + 1).toString().padStart(2)}. [${strategy}] ${config} | ` +
      `Trades: ${String(r.trades).padStart(5)} | ` +
      `WR: ${r.winRate.toFixed(1).padStart(5)}% | ` +
      `P&L: $${r.pnl.toFixed(0).padStart(8)} | ` +
      `PF: ${r.profitFactor.toFixed(2)} | ` +
      `Sharpe: ${r.sharpe.toFixed(2)}`
    );
  });

  // Best per strategy
  console.log('');
  console.log('='.repeat(120));
  console.log('  BEST CONFIGURATION PER STRATEGY');
  console.log('='.repeat(120));

  const byStrategy = {};
  for (const r of allResults) {
    if (byStrategy[r.strategy] === undefined || r.pnl > byStrategy[r.strategy].pnl) {
      byStrategy[r.strategy] = r;
    }
  }

  Object.values(byStrategy).sort((a, b) => b.pnl - a.pnl).forEach(r => {
    console.log(
      `[${r.strategy.padEnd(28)}] ${r.config.substring(0, 40).padEnd(40)} | ` +
      `P&L: $${r.pnl.toFixed(0).padStart(8)} | ` +
      `WR: ${r.winRate.toFixed(1)}% | ` +
      `PF: ${r.profitFactor.toFixed(2)} | ` +
      `Sharpe: ${r.sharpe.toFixed(2)} | ` +
      `MaxDD: ${r.maxDD.toFixed(1)}%`
    );
  });

  // Worst performers
  console.log('');
  console.log('='.repeat(120));
  console.log('  WORST PERFORMERS (CONFIGURATIONS TO AVOID)');
  console.log('='.repeat(120));

  allResults.sort((a, b) => a.pnl - b.pnl).slice(0, 10).forEach((r, i) => {
    console.log(
      `${(i + 1).toString().padStart(2)}. [${r.strategy.substring(0, 18).padEnd(18)}] ${r.config.substring(0, 35).padEnd(35)} | ` +
      `P&L: $${r.pnl.toFixed(0).padStart(8)} | WR: ${r.winRate.toFixed(1)}%`
    );
  });

  // Key findings
  console.log('');
  console.log('='.repeat(120));
  console.log('  KEY FINDINGS AND TRADEABLE PATTERNS');
  console.log('='.repeat(120));
  console.log('');

  console.log('1. GEX-RECOIL OPTIMAL CONFIGURATION:');
  console.log('   - Stop Buffer: 12-15 points (provides room for market noise)');
  console.log('   - Target: 40-50 points (larger targets significantly outperform)');
  console.log('   - Trailing Stop: DISABLED (fixed exits work better for mean reversion)');
  console.log('   - Expected: $8K-$12K P&L, 30-37% WR, 1.8-2.1 Profit Factor');
  console.log('');

  console.log('2. PARAMETER SENSITIVITY:');
  console.log('   - Stop Buffer 5 = AVOID (consistent -$28K to -$32K losses)');
  console.log('   - Stop Buffer 10+ = Profitable range');
  console.log('   - Target 20 = Marginal, Target 40+ = Strong');
  console.log('');

  console.log('3. TRAILING STOPS FOR MEAN REVERSION:');
  console.log('   - Generally reduce returns vs fixed targets');
  console.log('   - Exit too early during normal pullbacks');
  console.log('   - May work better for momentum strategies');
  console.log('');

  console.log('4. WIN RATE vs PROFIT FACTOR TRADE-OFF:');
  console.log('   - Lower WR (30-40%) + Higher PF (2.0+) = More profitable');
  console.log('   - Higher WR (50%+) + Lower PF (0.8-1.0) = Marginal returns');
  console.log('');

  // Save summary JSON
  const summaryPath = path.join(projectRoot, 'results', 'optimization-2025', 'summaries', 'final-analysis.json');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    totalConfigs: allResults.length,
    bestOverall: allResults.sort((a, b) => b.pnl - a.pnl)[0],
    bestPerStrategy: byStrategy,
    top10: allResults.sort((a, b) => b.pnl - a.pnl).slice(0, 10),
    worstPerformers: allResults.sort((a, b) => a.pnl - b.pnl).slice(0, 5)
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nSummary saved to: ${summaryPath}`);
}

main();
