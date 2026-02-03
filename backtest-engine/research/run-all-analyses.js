#!/usr/bin/env node
/**
 * Run All ICT-SMT Research Analyses
 *
 * Executes all 10 individual analyses sequentially, then runs the
 * cross-correlation analysis to generate the final summary.
 *
 * Usage:
 *   node run-all-analyses.js [--parallel] [--skip-existing]
 *
 * Options:
 *   --parallel       Run analyses in parallel (faster but more memory)
 *   --skip-existing  Skip analyses that already have output files
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESULTS_DIR = path.join(__dirname, '..', 'results', 'research');

const ANALYSES = [
  { script: '01_volume_analysis.js', output: '01_volume_analysis.json', name: 'Volume Confirmation' },
  { script: '02_vwap_analysis.js', output: '02_vwap_analysis.json', name: 'VWAP Analysis' },
  { script: '03_prior_day_levels.js', output: '03_prior_day_levels.json', name: 'Prior Day Levels' },
  { script: '04_opening_range.js', output: '04_opening_range.json', name: 'Opening Range' },
  { script: '05_momentum_analysis.js', output: '05_momentum_analysis.json', name: 'Momentum Confirmation' },
  { script: '06_gap_analysis.js', output: '06_gap_analysis.json', name: 'Gap Analysis' },
  { script: '07_session_context.js', output: '07_session_context.json', name: 'Session Context' },
  { script: '08_price_momentum.js', output: '08_price_momentum.json', name: 'Price Momentum' },
  { script: '09_nq_qqq_correlation.js', output: '09_nq_qqq_correlation.json', name: 'NQ/QQQ Correlation' },
  { script: '10_time_momentum.js', output: '10_time_momentum.json', name: 'Time-Based Momentum' }
];

const CROSS_CORRELATION = {
  script: '11_cross_correlation.js',
  output: '11_cross_correlation.json',
  name: 'Cross-Correlation Summary'
};

function runScript(scriptPath, name) {
  return new Promise((resolve, reject) => {
    console.log(`\nRunning: ${name}`);
    console.log('-'.repeat(50));

    const proc = spawn('node', [scriptPath], {
      cwd: __dirname,
      stdio: 'inherit'
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`\n[OK] ${name} completed successfully`);
        resolve();
      } else {
        console.log(`\n[FAIL] ${name} exited with code ${code}`);
        reject(new Error(`${name} failed`));
      }
    });

    proc.on('error', (err) => {
      console.log(`\n[ERROR] ${name}: ${err.message}`);
      reject(err);
    });
  });
}

function outputExists(outputFile) {
  const outputPath = path.join(RESULTS_DIR, outputFile);
  return fs.existsSync(outputPath);
}

async function runSequential(skipExisting) {
  console.log('Running analyses sequentially...\n');

  const startTime = Date.now();
  let completed = 0;
  let skipped = 0;

  for (const analysis of ANALYSES) {
    if (skipExisting && outputExists(analysis.output)) {
      console.log(`[SKIP] ${analysis.name} - output already exists`);
      skipped++;
      continue;
    }

    try {
      await runScript(path.join(__dirname, analysis.script), analysis.name);
      completed++;
    } catch (err) {
      console.error(`Failed to run ${analysis.name}: ${err.message}`);
      // Continue with next analysis
    }
  }

  // Run cross-correlation
  console.log('\n' + '='.repeat(70));
  console.log('Running final cross-correlation analysis...');
  console.log('='.repeat(70));

  try {
    await runScript(path.join(__dirname, CROSS_CORRELATION.script), CROSS_CORRELATION.name);
    completed++;
  } catch (err) {
    console.error(`Failed to run cross-correlation: ${err.message}`);
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n' + '='.repeat(70));
  console.log('  ALL ANALYSES COMPLETE');
  console.log('='.repeat(70));
  console.log(`  Completed: ${completed}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Duration:  ${duration} minutes`);
  console.log();
  console.log('  Results saved to: backtest-engine/results/research/');
  console.log('  Summary report:   backtest-engine/results/research/RESEARCH_SUMMARY.md');
  console.log('='.repeat(70));
}

async function runParallel(skipExisting) {
  console.log('Running analyses in parallel...\n');

  const startTime = Date.now();

  // Filter analyses based on skipExisting
  const toRun = ANALYSES.filter(a => {
    if (skipExisting && outputExists(a.output)) {
      console.log(`[SKIP] ${a.name} - output already exists`);
      return false;
    }
    return true;
  });

  // Run all analyses in parallel
  const promises = toRun.map(analysis =>
    runScript(path.join(__dirname, analysis.script), analysis.name)
      .catch(err => {
        console.error(`Failed: ${analysis.name}: ${err.message}`);
        return null; // Don't fail entire batch
      })
  );

  await Promise.all(promises);

  // Run cross-correlation (must be after all others)
  console.log('\n' + '='.repeat(70));
  console.log('Running final cross-correlation analysis...');
  console.log('='.repeat(70));

  try {
    await runScript(path.join(__dirname, CROSS_CORRELATION.script), CROSS_CORRELATION.name);
  } catch (err) {
    console.error(`Failed to run cross-correlation: ${err.message}`);
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n' + '='.repeat(70));
  console.log('  ALL ANALYSES COMPLETE');
  console.log('='.repeat(70));
  console.log(`  Duration: ${duration} minutes`);
  console.log();
  console.log('  Results saved to: backtest-engine/results/research/');
  console.log('  Summary report:   backtest-engine/results/research/RESEARCH_SUMMARY.md');
  console.log('='.repeat(70));
}

// Parse command line args
const args = process.argv.slice(2);
const parallel = args.includes('--parallel');
const skipExisting = args.includes('--skip-existing');

console.log('='.repeat(70));
console.log('  ICT-SMT Research Analysis Runner');
console.log('='.repeat(70));
console.log(`  Mode: ${parallel ? 'Parallel' : 'Sequential'}`);
console.log(`  Skip existing: ${skipExisting}`);
console.log('='.repeat(70));

if (parallel) {
  runParallel(skipExisting).catch(console.error);
} else {
  runSequential(skipExisting).catch(console.error);
}
