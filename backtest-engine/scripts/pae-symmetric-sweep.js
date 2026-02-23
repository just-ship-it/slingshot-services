#!/usr/bin/env node
/**
 * PAE Symmetric Stop/Target Parameter Sweep
 *
 * Tests symmetric stop/target configurations for the Price Action Exhaustion strategy.
 * Runs multiple backtests in sequence and compares results.
 * Skips configs that already have output files.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(__dirname, '..');

// Symmetric configurations to test (stop = target)
const configs = [3, 5, 7, 10, 12, 15, 20, 25, 30];

function extractResults(outputFile) {
  const data = JSON.parse(readFileSync(outputFile, 'utf8'));
  const summary = data.performance?.summary || {};
  const basic = data.performance?.basic || {};
  const drawdown = data.performance?.drawdown || {};
  return {
    trades: summary.totalTrades || basic.totalTrades || 0,
    winRate: summary.winRate || basic.winRate || 0,
    totalPnL: summary.totalPnL || basic.totalPnL || 0,
    avgPnL: basic.avgTrade || basic.expectancy || 0,
    profitFactor: basic.profitFactor || 0,
    avgWin: basic.avgWin || 0,
    avgLoss: basic.avgLoss || 0,
    maxDrawdown: drawdown.maxDrawdown || summary.maxDrawdown || 0
  };
}

const results = [];

for (const pts of configs) {
  const label = `${pts}/${pts}`;
  const outputFile = path.join(engineDir, `pae-sweep-${pts}-${pts}.json`);

  // Skip if already computed
  if (existsSync(outputFile)) {
    console.log(`\n[SKIP] ${label} — output file exists, reading cached result`);
    try {
      const r = extractResults(outputFile);
      results.push({ config: label, stop: pts, target: pts, ...r });
      console.log(`  Trades: ${r.trades}, Win%: ${r.winRate.toFixed(1)}%, PnL: $${r.totalPnL.toFixed(0)}, PF: ${r.profitFactor.toFixed(2)}`);
    } catch (e) {
      console.log(`  Failed to read cached: ${e.message}`);
      results.push({ config: label, stop: pts, target: pts, error: true });
    }
    continue;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running ${label} (stop=${pts}, target=${pts})...`);
  console.log('='.repeat(60));

  try {
    const cmd = [
      'node', path.join(engineDir, 'index.js'),
      '--ticker', 'NQ',
      '--start', '2024-01-01',
      '--end', '2025-12-31',
      '--strategy', 'pae',
      '--timeframe', '1m',
      '--stop-buffer', String(pts),
      '--target-points', String(pts),
      '--output', outputFile
    ].join(' ');

    execSync(cmd, { stdio: 'pipe', timeout: 1200000, cwd: engineDir });

    const r = extractResults(outputFile);
    results.push({ config: label, stop: pts, target: pts, ...r });
    console.log(`  Trades: ${r.trades}, Win%: ${r.winRate.toFixed(1)}%, PnL: $${r.totalPnL.toFixed(0)}, PF: ${r.profitFactor.toFixed(2)}`);
  } catch (err) {
    console.error(`  FAILED: ${err.message?.substring(0, 200)}`);
    results.push({ config: label, stop: pts, target: pts, error: true });
  }
}

// Summary table
console.log('\n\n' + '='.repeat(96));
console.log('PARAMETER SWEEP RESULTS — PAE Symmetric Stop/Target (2024-2025)');
console.log('='.repeat(96));
console.log(
  'Config'.padEnd(8) +
  'Trades'.padStart(8) +
  'Win%'.padStart(8) +
  'Total P&L'.padStart(12) +
  'Avg P&L'.padStart(10) +
  'PF'.padStart(8) +
  'Avg Win'.padStart(10) +
  'Avg Loss'.padStart(10) +
  'MaxDD'.padStart(12) +
  '  Notes'
);
console.log('-'.repeat(96));

for (const r of results) {
  if (r.error) {
    console.log(`${r.config.padEnd(8)}  ERROR`);
    continue;
  }
  const profitable = r.totalPnL > 0;
  const note = profitable ? ' *** PROFITABLE ***' : '';
  console.log(
    r.config.padEnd(8) +
    String(r.trades).padStart(8) +
    `${r.winRate.toFixed(1)}%`.padStart(8) +
    `$${r.totalPnL.toFixed(0)}`.padStart(12) +
    `$${r.avgPnL.toFixed(1)}`.padStart(10) +
    r.profitFactor.toFixed(2).padStart(8) +
    `$${r.avgWin.toFixed(0)}`.padStart(10) +
    `$${r.avgLoss.toFixed(0)}`.padStart(10) +
    `$${r.maxDrawdown.toFixed(0)}`.padStart(12) +
    `  ${note}`
  );
}
console.log('='.repeat(96));

// Highlight best config
const valid = results.filter(r => !r.error);
if (valid.length > 0) {
  const best = valid.reduce((a, b) => a.totalPnL > b.totalPnL ? a : b);
  console.log(`\nBest config: ${best.config} — $${best.totalPnL.toFixed(0)} total P&L, ${best.winRate.toFixed(1)}% win rate, PF ${best.profitFactor.toFixed(2)}`);
}
