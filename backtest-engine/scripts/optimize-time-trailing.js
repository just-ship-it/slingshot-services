/**
 * Time-Based Trailing Stop Parameter Optimization
 * Tests various rule combinations to find optimal settings
 */

import { execSync } from 'child_process';
import fs from 'fs';

const START_DATE = '2025-01-13';
const END_DATE = '2026-01-23';

// Base parameters from original backtest (matching iv_skew_gex_1m.json config)
const BASE_PARAMS = '--stop-loss-points 70 --target-points 70';

// Rule configurations to test
const configs = [
  // Baseline - no time-based trailing
  { name: 'Baseline (no trailing)', rules: [] },

  // Conservative - only protect big winners
  { name: 'Conservative: 30/40/50 MFE, wide trails', rules: [
    '20,30,trail:25',
    '30,40,trail:20',
    '40,50,trail:15'
  ]},

  // Moderate - balanced protection
  { name: 'Moderate: 30/40/50 MFE, medium trails', rules: [
    '15,30,trail:20',
    '25,40,trail:15',
    '35,50,trail:10'
  ]},

  // Aggressive step-up
  { name: 'Aggressive: 25/35/45 MFE, tight trails', rules: [
    '15,25,trail:15',
    '25,35,trail:10',
    '35,45,trail:5'
  ]},

  // Lock in profits early
  { name: 'Early lock: 30 MFE only, trail:20', rules: [
    '15,30,trail:20'
  ]},

  // Two-stage protection
  { name: 'Two-stage: 35/50 MFE', rules: [
    '20,35,trail:20',
    '35,50,trail:10'
  ]},

  // High MFE only (protect runners)
  { name: 'Runners only: 40/60 MFE', rules: [
    '25,40,trail:20',
    '40,60,trail:10'
  ]},

  // Time-focused (tighten as time passes)
  { name: 'Time-focused: same MFE, tighten over time', rules: [
    '20,30,trail:25',
    '35,30,trail:15',
    '50,30,trail:10'
  ]},

  // Wide breathing room
  { name: 'Wide room: 35/45/55 MFE, wide trails', rules: [
    '20,35,trail:25',
    '30,45,trail:20',
    '40,55,trail:15'
  ]},

  // Quick lock then let run
  { name: 'Lock +15 @ 35 MFE only', rules: [
    '20,35,trail:20'
  ]},

  // Progressive tightening from 30
  { name: 'Progressive from 30: trail tightens', rules: [
    '15,30,trail:25',
    '25,40,trail:20',
    '35,50,trail:15'
  ]},

  // Very conservative - 40+ MFE only
  { name: 'Very conservative: 40/50/60 MFE', rules: [
    '20,40,trail:25',
    '30,50,trail:20',
    '40,60,trail:15'
  ]},
];

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('  TIME-BASED TRAILING STOP PARAMETER OPTIMIZATION');
console.log('  Period: ' + START_DATE + ' to ' + END_DATE);
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');

const results = [];

for (let i = 0; i < configs.length; i++) {
  const config = configs[i];
  console.log('[' + (i+1) + '/' + configs.length + '] Testing: ' + config.name);

  // Build command with base parameters matching original backtest
  let cmd = 'node index.js --ticker NQ --start ' + START_DATE + ' --end ' + END_DATE + ' --strategy iv-skew-gex --timeframe 1m ' + BASE_PARAMS + ' --quiet';

  if (config.rules.length > 0) {
    cmd += ' --time-based-trailing';
    for (let j = 0; j < config.rules.length; j++) {
      cmd += ' --tb-rule-' + (j + 1) + ' "' + config.rules[j] + '"';
    }
  }

  cmd += ' --output-json /tmp/tb-test-result.json';

  try {
    execSync(cmd, { cwd: '/home/drew/projects/slingshot-services/backtest-engine', stdio: 'pipe' });

    const data = JSON.parse(fs.readFileSync('/tmp/tb-test-result.json', 'utf8'));
    const trades = data.trades;

    const winners = trades.filter(t => t.netPnL > 0).length;
    const losers = trades.filter(t => t.netPnL <= 0).length;
    const totalPnL = trades.reduce((s, t) => s + t.netPnL, 0);
    const winRate = (winners / trades.length * 100);
    const avgWin = trades.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0) / winners;
    const avgLoss = losers > 0 ? trades.filter(t => t.netPnL <= 0).reduce((s, t) => s + t.netPnL, 0) / losers : 0;
    const profitFactor = avgLoss !== 0 ? Math.abs(avgWin * winners) / Math.abs(avgLoss * losers) : 999;

    // Count exit reasons
    const trailingExits = trades.filter(t => t.exitReason === 'trailing_stop').length;
    const stopLossExits = trades.filter(t => t.exitReason === 'stop_loss').length;
    const takeProfitExits = trades.filter(t => t.exitReason === 'take_profit').length;

    results.push({
      name: config.name,
      rules: config.rules.join(' | ') || 'None',
      trades: trades.length,
      winners,
      losers,
      winRate,
      totalPnL,
      avgWin,
      avgLoss,
      profitFactor,
      trailingExits,
      stopLossExits,
      takeProfitExits
    });

    console.log('    ✓ P&L: $' + totalPnL.toLocaleString() + ' | Win Rate: ' + winRate.toFixed(1) + '% | PF: ' + profitFactor.toFixed(2));

  } catch (err) {
    console.log('    ✗ Error: ' + err.message);
    results.push({
      name: config.name,
      rules: config.rules.join(' | ') || 'None',
      error: err.message
    });
  }
}

// Sort by total P&L
results.sort((a, b) => (b.totalPnL || 0) - (a.totalPnL || 0));

console.log('');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('  RESULTS RANKED BY TOTAL P&L');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');

console.log('Rank | Configuration                              |   Total P&L | Win Rate |   PF | TP/SL/Trail');
console.log('-----+--------------------------------------------+-------------+----------+------+-------------');

for (let idx = 0; idx < results.length; idx++) {
  const r = results[idx];
  if (r.error) {
    console.log(String(idx+1).padStart(4) + ' | ' + r.name.padEnd(42) + ' | ERROR');
  } else {
    const pnlStr = '$' + r.totalPnL.toLocaleString();
    const wrStr = r.winRate.toFixed(1) + '%';
    const pfStr = r.profitFactor.toFixed(2);
    const exitsStr = r.takeProfitExits + '/' + r.stopLossExits + '/' + r.trailingExits;
    console.log(String(idx+1).padStart(4) + ' | ' + r.name.slice(0,42).padEnd(42) + ' | ' + pnlStr.padStart(11) + ' | ' + wrStr.padStart(8) + ' | ' + pfStr.padStart(4) + ' | ' + exitsStr);
  }
}

// Save detailed results
fs.writeFileSync('/home/drew/projects/slingshot-services/backtest-engine/results/tb-optimization-results.json',
  JSON.stringify(results, null, 2));

console.log('');
console.log('Detailed results saved to: results/tb-optimization-results.json');

// Show baseline comparison
const baseline = results.find(r => r.name.includes('Baseline'));
if (baseline) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  COMPARISON VS BASELINE');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.error || r.name.includes('Baseline')) continue;
    const pnlDiff = r.totalPnL - baseline.totalPnL;
    const wrDiff = r.winRate - baseline.winRate;
    const marker = pnlDiff > 0 ? '✓' : '✗';
    const pnlSign = pnlDiff >= 0 ? '+' : '';
    const wrSign = wrDiff >= 0 ? '+' : '';
    console.log(marker + ' ' + r.name.slice(0,40).padEnd(40) + ' | P&L: ' + pnlSign + '$' + pnlDiff.toLocaleString().padStart(8) + ' | WR: ' + wrSign + wrDiff.toFixed(1) + '%');
  }
}
