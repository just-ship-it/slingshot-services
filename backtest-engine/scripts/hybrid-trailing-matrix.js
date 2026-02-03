#!/usr/bin/env node

/**
 * Hybrid Trailing Stop Parameter Matrix
 *
 * Tests combinations of:
 * - structureThreshold: Points profit before switching to swing-based trailing
 * - swingLookback: Bars on each side to confirm swing low
 * - swingBuffer: Points below swing low for stop placement
 *
 * Uses the GEX-Recoil-Enhanced strategy with 1-second resolution data.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Configuration
const config = {
  ticker: 'NQ',
  startDate: '2025-01-13',
  endDate: '2025-12-24',
  strategy: 'gex-recoil-enhanced',
  timeframe: '15m',
  targetPoints: 1000,  // Effectively no target - let trailing stop manage exits
  trailingTrigger: 5,  // Initial trailing trigger
  trailingOffset: 35,  // Initial trailing offset (wide to not interfere)
};

// Parameter ranges to test
const structureThresholds = [15, 20, 25, 30, 40, 50];  // Points before structure mode
const swingLookbacks = [3, 5, 7, 10];                   // Bars on each side for swing
const swingBuffers = [3, 5, 8, 10, 15];                 // Points below swing low

const outputDir = path.join(projectRoot, 'results', 'hybrid-trailing-matrix');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Generate all combinations
function generateCombinations() {
  const combinations = [];
  for (const threshold of structureThresholds) {
    for (const lookback of swingLookbacks) {
      for (const buffer of swingBuffers) {
        combinations.push({
          structureThreshold: threshold,
          swingLookback: lookback,
          swingBuffer: buffer,
          name: `th${threshold}_lb${lookback}_bf${buffer}`
        });
      }
    }
  }
  return combinations;
}

function runBacktest(params) {
  return new Promise((resolve) => {
    const args = [
      'index.js',
      '--ticker', config.ticker,
      '--start', config.startDate,
      '--end', config.endDate,
      '--strategy', config.strategy,
      '--timeframe', config.timeframe,
      '--target-points', String(config.targetPoints),
      '--use-trailing-stop',
      '--trailing-trigger', String(config.trailingTrigger),
      '--trailing-offset', String(config.trailingOffset),
      '--hybrid-trailing',
      '--structure-threshold', String(params.structureThreshold),
      '--swing-lookback', String(params.swingLookback),
      '--swing-buffer', String(params.swingBuffer),
      '--output-json', path.join(outputDir, `${params.name}.json`)
    ];

    const startTime = Date.now();
    const proc = spawn('node', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const duration = Math.round((Date.now() - startTime) / 1000);

      if (code !== 0) {
        console.log(`  ❌ FAILED (${duration}s): ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }

      // Parse results from JSON file
      try {
        const jsonPath = path.join(outputDir, `${params.name}.json`);
        const results = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        // Extract key metrics (results stored under performance.summary and performance.basic)
        const perf = results.performance || {};
        const summary = perf.summary || {};
        const basic = perf.basic || {};

        const metrics = {
          ...params,
          totalPnL: summary.totalPnL || basic.totalPnL || 0,
          totalTrades: summary.totalTrades || basic.totalTrades || 0,
          winRate: summary.winRate || basic.winRate || 0,
          profitFactor: basic.profitFactor || 0,
          avgWin: basic.avgWin || 0,
          avgLoss: basic.avgLoss || 0,
          largestWin: basic.largestWin || 0,
          maxDrawdown: summary.maxDrawdown || 0,
          sharpe: summary.sharpeRatio || 0,
          // Exit breakdown
          trailingStopExits: 0,
          trailingStopPnL: 0,
          avgTrailingPts: 0,
          maxTrailingPts: 0,
          duration
        };

        // Calculate trailing stop specific metrics
        if (results.trades) {
          const tsExits = results.trades.filter(t => t.exitReason === 'trailing_stop');
          metrics.trailingStopExits = tsExits.length;
          metrics.trailingStopPnL = tsExits.reduce((sum, t) => sum + (t.netPnL || t.pnl || 0), 0);

          const tsWinners = tsExits.filter(t => (t.netPnL || t.pnl || 0) > 0);
          if (tsWinners.length > 0) {
            // Use pointsPnL if available, otherwise calculate from prices
            const points = tsWinners.map(t => t.pointsPnL || Math.abs((t.actualExit || t.exitPrice) - (t.actualEntry || t.entryPrice)));
            metrics.avgTrailingPts = points.reduce((a, b) => a + b, 0) / points.length;
            metrics.maxTrailingPts = Math.max(...points);
          }
        }

        resolve(metrics);
      } catch (e) {
        console.log(`  ❌ Parse error: ${e.message}`);
        resolve(null);
      }
    });
  });
}

async function main() {
  const combinations = generateCombinations();
  const totalTests = combinations.length;

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║           HYBRID TRAILING STOP PARAMETER MATRIX                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nConfiguration:`);
  console.log(`  Strategy: ${config.strategy}`);
  console.log(`  Period: ${config.startDate} → ${config.endDate}`);
  console.log(`  Initial Trailing: Trigger=${config.trailingTrigger}, Offset=${config.trailingOffset}`);
  console.log(`\nParameters to test:`);
  console.log(`  Structure Thresholds: ${structureThresholds.join(', ')}`);
  console.log(`  Swing Lookbacks: ${swingLookbacks.join(', ')}`);
  console.log(`  Swing Buffers: ${swingBuffers.join(', ')}`);
  console.log(`\nTotal combinations: ${totalTests}`);
  console.log(`Output directory: ${outputDir}`);
  console.log('');

  // Check for already completed tests
  const existingResults = [];
  for (const combo of combinations) {
    const jsonPath = path.join(outputDir, `${combo.name}.json`);
    if (fs.existsSync(jsonPath)) {
      try {
        const results = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        existingResults.push({ ...combo, results });
      } catch (e) {
        // Invalid JSON, will re-run
      }
    }
  }

  const pendingCombos = combinations.filter(c =>
    !existingResults.some(e => e.name === c.name)
  );

  if (existingResults.length > 0) {
    console.log(`Resuming: ${existingResults.length} completed, ${pendingCombos.length} remaining\n`);
  }

  const results = [];
  let completed = existingResults.length;

  // Add existing results
  for (const existing of existingResults) {
    try {
      const jsonPath = path.join(outputDir, `${existing.name}.json`);
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const perf = data.performance || {};
      const summary = perf.summary || {};
      const basic = perf.basic || {};

      // Calculate trailing stop metrics from trades
      let trailingStopExits = 0, trailingStopPnL = 0, avgTrailingPts = 0, maxTrailingPts = 0;
      if (data.trades) {
        const tsExits = data.trades.filter(t => t.exitReason === 'trailing_stop');
        trailingStopExits = tsExits.length;
        trailingStopPnL = tsExits.reduce((sum, t) => sum + (t.netPnL || t.pnl || 0), 0);
        const tsWinners = tsExits.filter(t => (t.netPnL || t.pnl || 0) > 0);
        if (tsWinners.length > 0) {
          const points = tsWinners.map(t => t.pointsPnL || Math.abs((t.actualExit || t.exitPrice) - (t.actualEntry || t.entryPrice)));
          avgTrailingPts = points.reduce((a, b) => a + b, 0) / points.length;
          maxTrailingPts = Math.max(...points);
        }
      }

      results.push({
        ...existing,
        totalPnL: summary.totalPnL || basic.totalPnL || 0,
        totalTrades: summary.totalTrades || basic.totalTrades || 0,
        winRate: summary.winRate || basic.winRate || 0,
        profitFactor: basic.profitFactor || 0,
        largestWin: basic.largestWin || 0,
        maxDrawdown: summary.maxDrawdown || 0,
        sharpe: summary.sharpeRatio || 0,
        trailingStopExits,
        trailingStopPnL,
        avgTrailingPts,
        maxTrailingPts
      });
    } catch (e) {
      // Skip
    }
  }

  const startTime = Date.now();

  for (const combo of pendingCombos) {
    completed++;
    const pct = ((completed / totalTests) * 100).toFixed(1);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const avgPerTest = elapsed / (completed - existingResults.length) || 45;
    const remaining = Math.round(avgPerTest * (totalTests - completed) / 60);

    console.log(`[${completed}/${totalTests}] ${pct}% - Testing threshold=${combo.structureThreshold}, lookback=${combo.swingLookback}, buffer=${combo.swingBuffer} (ETA: ${remaining}m)`);

    const result = await runBacktest(combo);
    if (result) {
      results.push(result);
      console.log(`  ✅ P&L: $${result.totalPnL.toLocaleString()} | WR: ${result.winRate.toFixed(1)}% | TS Exits: ${result.trailingStopExits} | Max: ${result.maxTrailingPts.toFixed(1)} pts`);
    }
  }

  // Generate summary CSV
  const csvPath = path.join(outputDir, 'summary.csv');
  const headers = [
    'structureThreshold', 'swingLookback', 'swingBuffer',
    'totalPnL', 'totalTrades', 'winRate', 'profitFactor',
    'largestWin', 'maxDrawdown', 'sharpe',
    'trailingStopExits', 'trailingStopPnL', 'avgTrailingPts', 'maxTrailingPts'
  ];

  const csvContent = [
    headers.join(','),
    ...results.map(r => headers.map(h => r[h] ?? '').join(','))
  ].join('\n');

  fs.writeFileSync(csvPath, csvContent);
  console.log(`\n✅ Summary saved to ${csvPath}`);

  // Sort by P&L and show top 10
  results.sort((a, b) => (b.totalPnL || 0) - (a.totalPnL || 0));

  console.log('\n' + '═'.repeat(80));
  console.log('                           TOP 10 BY TOTAL P&L');
  console.log('═'.repeat(80));
  console.log('Threshold | Lookback | Buffer | Total P&L | Trades | Win% | Largest Win | Max Pts');
  console.log('─'.repeat(80));

  for (const r of results.slice(0, 10)) {
    const th = String(r.structureThreshold).padStart(9);
    const lb = String(r.swingLookback).padStart(8);
    const bf = String(r.swingBuffer).padStart(6);
    const pnl = ('$' + (r.totalPnL || 0).toLocaleString()).padStart(9);
    const trades = String(r.totalTrades || 0).padStart(6);
    const wr = ((r.winRate || 0).toFixed(1) + '%').padStart(5);
    const largest = ('$' + (r.largestWin || 0).toLocaleString()).padStart(11);
    const maxPts = ((r.maxTrailingPts || 0).toFixed(1)).padStart(7);
    console.log(`${th} | ${lb} | ${bf} | ${pnl} | ${trades} | ${wr} | ${largest} | ${maxPts}`);
  }

  // Also show top 10 by average trailing points (runner capture ability)
  results.sort((a, b) => (b.avgTrailingPts || 0) - (a.avgTrailingPts || 0));

  console.log('\n' + '═'.repeat(80));
  console.log('                    TOP 10 BY AVG TRAILING STOP POINTS');
  console.log('═'.repeat(80));
  console.log('Threshold | Lookback | Buffer | Avg Pts | Max Pts | TS Exits | TS P&L | Total P&L');
  console.log('─'.repeat(80));

  for (const r of results.slice(0, 10)) {
    const th = String(r.structureThreshold).padStart(9);
    const lb = String(r.swingLookback).padStart(8);
    const bf = String(r.swingBuffer).padStart(6);
    const avgPts = ((r.avgTrailingPts || 0).toFixed(1)).padStart(7);
    const maxPts = ((r.maxTrailingPts || 0).toFixed(1)).padStart(7);
    const tsExits = String(r.trailingStopExits || 0).padStart(8);
    const tsPnL = ('$' + (r.trailingStopPnL || 0).toLocaleString()).padStart(6);
    const pnl = ('$' + (r.totalPnL || 0).toLocaleString()).padStart(9);
    console.log(`${th} | ${lb} | ${bf} | ${avgPts} | ${maxPts} | ${tsExits} | ${tsPnL} | ${pnl}`);
  }

  // Generate analysis report
  const reportPath = path.join(outputDir, 'analysis-report.md');
  const bestByPnL = results.reduce((a, b) => (b.totalPnL || 0) > (a.totalPnL || 0) ? b : a, results[0]);
  const bestByPts = results.reduce((a, b) => (b.avgTrailingPts || 0) > (a.avgTrailingPts || 0) ? b : a, results[0]);

  const report = `# Hybrid Trailing Stop Parameter Matrix Analysis
## GEX-Recoil-Enhanced Strategy

**Generated**: ${new Date().toISOString()}
**Date Range**: ${config.startDate} to ${config.endDate}
**Combinations Tested**: ${results.length}

---

## Parameter Ranges Tested
- **Structure Threshold**: ${structureThresholds.join(', ')} points
- **Swing Lookback**: ${swingLookbacks.join(', ')} bars
- **Swing Buffer**: ${swingBuffers.join(', ')} points

---

## Best Configuration by Total P&L

| Parameter | Value |
|-----------|-------|
| Structure Threshold | ${bestByPnL?.structureThreshold} pts |
| Swing Lookback | ${bestByPnL?.swingLookback} bars |
| Swing Buffer | ${bestByPnL?.swingBuffer} pts |
| **Total P&L** | **$${(bestByPnL?.totalPnL || 0).toLocaleString()}** |
| Win Rate | ${(bestByPnL?.winRate || 0).toFixed(1)}% |
| Profit Factor | ${(bestByPnL?.profitFactor || 0).toFixed(2)} |
| Largest Win | $${(bestByPnL?.largestWin || 0).toLocaleString()} |
| Avg Trailing Pts | ${(bestByPnL?.avgTrailingPts || 0).toFixed(1)} |
| Max Trailing Pts | ${(bestByPnL?.maxTrailingPts || 0).toFixed(1)} |

---

## Best Configuration for Runner Capture (Avg Trailing Points)

| Parameter | Value |
|-----------|-------|
| Structure Threshold | ${bestByPts?.structureThreshold} pts |
| Swing Lookback | ${bestByPts?.swingLookback} bars |
| Swing Buffer | ${bestByPts?.swingBuffer} pts |
| Avg Trailing Pts | ${(bestByPts?.avgTrailingPts || 0).toFixed(1)} |
| Max Trailing Pts | ${(bestByPts?.maxTrailingPts || 0).toFixed(1)} |
| Total P&L | $${(bestByPts?.totalPnL || 0).toLocaleString()} |
| Win Rate | ${(bestByPts?.winRate || 0).toFixed(1)}% |

---

## Top 10 Configurations by Total P&L

| Threshold | Lookback | Buffer | P&L | Win Rate | Profit Factor | Largest Win |
|-----------|----------|--------|-----|----------|---------------|-------------|
${results.slice(0, 10).map(r =>
  `| ${r.structureThreshold} | ${r.swingLookback} | ${r.swingBuffer} | $${(r.totalPnL || 0).toLocaleString()} | ${(r.winRate || 0).toFixed(1)}% | ${(r.profitFactor || 0).toFixed(2)} | $${(r.largestWin || 0).toLocaleString()} |`
).join('\n')}

---

*Analysis generated by hybrid-trailing-matrix.js*
`;

  fs.writeFileSync(reportPath, report);
  console.log(`\n✅ Analysis report saved to ${reportPath}`);

  console.log('\n' + '═'.repeat(80));
  console.log('MATRIX COMPLETE');
  console.log('═'.repeat(80));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
