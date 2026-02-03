#!/usr/bin/env node

/**
 * Test Hybrid Trailing Stop on Specific Trade
 *
 * Validates the hybrid trailing stop implementation by running a backtest
 * on a known trade (Dec 16, 2025) that should have captured more profit.
 *
 * Expected behavior:
 * - Trade 11: Entry 25203.50 at 1:17 PM EST
 * - With 20pt target: Exited at 25223.50 (+20 pts)
 * - With hybrid trailing: Should capture ~100+ pts as price went to 25350+
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Test configurations
const tests = [
  {
    name: 'Baseline (20pt target, no trailing)',
    args: [
      '--ticker', 'NQ',
      '--start', '2025-12-15',
      '--end', '2025-12-17',
      '--strategy', 'gex-recoil-enhanced',
      '--timeframe', '15m',
      '--target-points', '20',
      '--verbose'
    ]
  },
  {
    name: 'Fixed Trailing (T=5, O=35, 20pt target)',
    args: [
      '--ticker', 'NQ',
      '--start', '2025-12-15',
      '--end', '2025-12-17',
      '--strategy', 'gex-recoil-enhanced',
      '--timeframe', '15m',
      '--target-points', '20',
      '--use-trailing-stop',
      '--trailing-trigger', '5',
      '--trailing-offset', '35',
      '--verbose'
    ]
  },
  {
    name: 'No Target + Fixed Trailing (T=20, O=5)',
    args: [
      '--ticker', 'NQ',
      '--start', '2025-12-15',
      '--end', '2025-12-17',
      '--strategy', 'gex-recoil-enhanced',
      '--timeframe', '15m',
      '--target-points', '1000',  // Effectively no target
      '--use-trailing-stop',
      '--trailing-trigger', '20',
      '--trailing-offset', '5',
      '--verbose'
    ]
  },
  {
    name: 'HYBRID Trailing (threshold=30, lookback=5, buffer=5)',
    args: [
      '--ticker', 'NQ',
      '--start', '2025-12-15',
      '--end', '2025-12-17',
      '--strategy', 'gex-recoil-enhanced',
      '--timeframe', '15m',
      '--target-points', '1000',  // No fixed target
      '--use-trailing-stop',
      '--trailing-trigger', '5',  // Initial trailing activation
      '--trailing-offset', '35',  // Initial trailing offset
      '--hybrid-trailing',
      '--structure-threshold', '30',
      '--swing-lookback', '5',
      '--swing-buffer', '5',
      '--verbose'
    ]
  },
  {
    name: 'HYBRID Trailing (threshold=20, lookback=10, buffer=8)',
    args: [
      '--ticker', 'NQ',
      '--start', '2025-12-15',
      '--end', '2025-12-17',
      '--strategy', 'gex-recoil-enhanced',
      '--timeframe', '15m',
      '--target-points', '1000',
      '--use-trailing-stop',
      '--trailing-trigger', '5',
      '--trailing-offset', '30',
      '--hybrid-trailing',
      '--structure-threshold', '20',
      '--swing-lookback', '10',
      '--swing-buffer', '8',
      '--verbose'
    ]
  }
];

function runTest(test) {
  return new Promise((resolve) => {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`TEST: ${test.name}`);
    console.log(`${'═'.repeat(70)}\n`);

    const args = ['index.js', ...test.args];
    const proc = spawn('node', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.log(`\n❌ Test failed with exit code ${code}`);
        if (stderr) console.log(`Error: ${stderr}`);
      }

      // Extract key metrics from output
      const pnlMatch = stdout.match(/Total P&L:\s*\$?([-\d,.]+)/);
      const tradesMatch = stdout.match(/Total Trades:\s*(\d+)/);
      const winRateMatch = stdout.match(/Win Rate:\s*([\d.]+)%/);

      resolve({
        name: test.name,
        success: code === 0,
        totalPnL: pnlMatch ? pnlMatch[1] : 'N/A',
        trades: tradesMatch ? tradesMatch[1] : 'N/A',
        winRate: winRateMatch ? winRateMatch[1] : 'N/A'
      });
    });
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║           HYBRID TRAILING STOP VALIDATION TEST                       ║');
  console.log('║           Date: Dec 16, 2025 (Known runner trade)                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('\nExpected: Trade entry at 25203.50, price went to 25350+ (potential 146+ pts)');
  console.log('With 20pt target, we only captured 20 pts. Hybrid should capture more.\n');

  const results = [];

  for (const test of tests) {
    const result = await runTest(test);
    results.push(result);
  }

  // Summary
  console.log('\n\n' + '═'.repeat(70));
  console.log('                         RESULTS SUMMARY');
  console.log('═'.repeat(70));
  console.log('\nConfiguration                                        | P&L      | Trades | Win%');
  console.log('─'.repeat(70));

  for (const r of results) {
    const name = r.name.substring(0, 50).padEnd(52);
    const pnl = ('$' + r.totalPnL).padStart(8);
    const trades = String(r.trades).padStart(6);
    const winRate = (r.winRate + '%').padStart(6);
    console.log(`${name} | ${pnl} | ${trades} | ${winRate}`);
  }

  console.log('─'.repeat(70));
  console.log('\nHybrid trailing should show higher P&L by capturing runner moves.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
