#!/usr/bin/env node

/**
 * Sweep Accuracy Analysis Script
 *
 * Analyzes sweep detection across multiple parameter combinations
 * to find optimal thresholds for achieving 90% accuracy.
 *
 * Usage:
 *   node analyze-sweep-accuracy.js --start 2024-01-01 --end 2024-12-31
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');

import { CSVLoader } from '../src/data/csv-loader.js';
import { GexLoader } from '../src/data-loaders/gex-loader.js';
import { LevelCalculator } from '../src/levels/level-calculator.js';
import { LevelSweepDetector } from '../src/analysis/level-sweep-detector.js';
import { SweepConfluenceScorer } from '../src/analysis/sweep-confluence-scorer.js';
import { SweepLabeler } from '../src/analysis/sweep-labeler.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    ticker: 'NQ',
    startDate: new Date('2024-06-01'),
    endDate: new Date('2024-12-31'),
    output: null
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--ticker':
        config.ticker = args[++i];
        break;
      case '--start':
        config.startDate = new Date(args[++i]);
        break;
      case '--end':
        config.endDate = new Date(args[++i]);
        config.endDate.setHours(23, 59, 59, 999);
        break;
      case '--output':
        config.output = args[++i];
        break;
    }
  }

  return config;
}

function getLoaderConfig() {
  return {
    dataFormat: {
      ohlcv: {
        timestampField: 'ts_event',
        symbolField: 'symbol',
        openField: 'open',
        highField: 'high',
        lowField: 'low',
        closeField: 'close',
        volumeField: 'volume'
      },
      gex: {
        dateField: 'date',
        gammaFlipField: 'nq_gamma_flip',
        putWallFields: ['nq_put_wall_1', 'nq_put_wall_2', 'nq_put_wall_3'],
        callWallFields: ['nq_call_wall_1', 'nq_call_wall_2', 'nq_call_wall_3'],
        regimeField: 'regime',
        totalGexField: 'total_gex'
      },
      liquidity: {
        timestampField: 'datetime',
        sentimentField: 'sentiment',
        levelFields: ['level_1', 'level_2', 'level_3', 'level_4', 'level_5']
      }
    }
  };
}

async function runAnalysis(config) {
  console.log('\n========================================');
  console.log('   Sweep Accuracy Parameter Analysis');
  console.log('========================================\n');

  // Load data
  console.log('Loading data...');
  const loaderConfig = getLoaderConfig();
  const csvLoader = new CSVLoader(DATA_DIR, loaderConfig);

  const { candles } = await csvLoader.loadOHLCVData(config.ticker, config.startDate, config.endDate);
  console.log(`Loaded ${candles.length.toLocaleString()} candles`);

  const gexDir = join(DATA_DIR, 'gex');
  const gexLoader = new GexLoader(gexDir, config.ticker.toLowerCase());
  await gexLoader.loadDateRange(config.startDate, config.endDate);
  console.log('GEX data loaded\n');

  // Parameter combinations to test
  const paramCombos = [];

  // Volume thresholds: 1.5, 2.0, 2.5, 3.0
  // Wick ratios: 0.5, 0.6, 0.7, 0.8
  // Level tolerances: 3, 5, 7, 10
  // Range thresholds: 1.0, 1.5, 2.0

  for (const volumeZ of [1.5, 2.0, 2.5, 3.0]) {
    for (const wickRatio of [0.5, 0.6, 0.7, 0.8]) {
      for (const levelTol of [3, 5, 7]) {
        for (const rangeZ of [1.0, 1.5, 2.0]) {
          paramCombos.push({ volumeZ, wickRatio, levelTol, rangeZ });
        }
      }
    }
  }

  console.log(`Testing ${paramCombos.length} parameter combinations...\n`);

  const results = [];
  let best = { accuracy: 0, params: null, stats: null };

  for (let i = 0; i < paramCombos.length; i++) {
    const params = paramCombos[i];

    // Initialize with current params
    const levelCalculator = new LevelCalculator({
      gexLoader,
      levelTolerance: params.levelTol
    });

    const sweepDetector = new LevelSweepDetector({
      levelCalculator,
      gexLoader,
      levelTolerance: params.levelTol,
      volumeZThreshold: params.volumeZ,
      rangeZThreshold: params.rangeZ,
      wickRatio: params.wickRatio,
      minRange: 3.0,
      cooldownSeconds: 30
    });

    const confluenceScorer = new SweepConfluenceScorer();
    const sweepLabeler = new SweepLabeler({ instrument: config.ticker });

    // Process
    const rawSweeps = sweepDetector.processCandles(candles);
    const scoredSweeps = confluenceScorer.scoreAll(rawSweeps);

    // Filter to tradeable tiers (A+ and A)
    const tradeableSweeps = scoredSweeps.filter(s =>
      s.scoring?.tier === 'A+' || s.scoring?.tier === 'A'
    );

    if (tradeableSweeps.length < 5) {
      // Not enough signals
      continue;
    }

    const labeledSweeps = sweepLabeler.labelAll(tradeableSweeps, candles);
    const accuracy = sweepLabeler.calculateAccuracy(labeledSweeps);

    const result = {
      params,
      total: accuracy.total,
      successes: accuracy.successes,
      failures: accuracy.failures,
      winRate: accuracy.winRate,
      resolvedAccuracy: accuracy.resolvedAccuracy,
      expectancy: accuracy.expectancy,
      profitFactor: accuracy.profitFactor
    };

    results.push(result);

    // Track best
    if (accuracy.resolvedAccuracy > best.accuracy && accuracy.total >= 10) {
      best = { accuracy: accuracy.resolvedAccuracy, params, stats: accuracy };
    }

    // Progress update
    if ((i + 1) % 20 === 0 || i === paramCombos.length - 1) {
      process.stdout.write(`\r  Progress: ${i + 1}/${paramCombos.length} tested, best accuracy: ${best.accuracy.toFixed(1)}%`);
    }

    // Reset for next iteration
    sweepDetector.reset();
    confluenceScorer.reset();
    sweepLabeler.resetStats();
  }

  console.log('\n\n========================================');
  console.log('   TOP 10 PARAMETER COMBINATIONS');
  console.log('========================================\n');

  // Sort by accuracy (descending)
  results.sort((a, b) => b.resolvedAccuracy - a.resolvedAccuracy);

  const top10 = results.slice(0, 10);

  console.log('Rank  VolZ   WickR  LevelT  RangeZ  Total  Success  Accuracy  Expectancy  PF');
  console.log('----  ----   -----  ------  ------  -----  -------  --------  ----------  ----');

  top10.forEach((r, idx) => {
    console.log(
      `${String(idx + 1).padStart(3)}   ` +
      `${r.params.volumeZ.toFixed(1).padStart(4)}   ` +
      `${r.params.wickRatio.toFixed(2).padStart(5)}  ` +
      `${String(r.params.levelTol).padStart(6)}  ` +
      `${r.params.rangeZ.toFixed(1).padStart(6)}  ` +
      `${String(r.total).padStart(5)}  ` +
      `${String(r.successes).padStart(7)}  ` +
      `${r.resolvedAccuracy.toFixed(1).padStart(7)}%  ` +
      `${r.expectancy.toFixed(2).padStart(10)}  ` +
      `${r.profitFactor.toFixed(2).padStart(4)}`
    );
  });

  console.log('\n========================================');
  console.log('   BEST CONFIGURATION');
  console.log('========================================\n');

  if (best.params) {
    console.log('Parameters:');
    console.log(`  Volume Z-Threshold:  ${best.params.volumeZ}`);
    console.log(`  Wick Ratio:          ${best.params.wickRatio}`);
    console.log(`  Level Tolerance:     ${best.params.levelTol} points`);
    console.log(`  Range Z-Threshold:   ${best.params.rangeZ}`);
    console.log('');
    console.log('Performance:');
    console.log(`  Total Sweeps:        ${best.stats.total}`);
    console.log(`  Win Rate:            ${best.stats.winRate.toFixed(2)}%`);
    console.log(`  Resolved Accuracy:   ${best.stats.resolvedAccuracy.toFixed(2)}%`);
    console.log(`  Expectancy:          ${best.stats.expectancy.toFixed(2)} pts/trade`);
    console.log(`  Profit Factor:       ${best.stats.profitFactor.toFixed(2)}`);
  }

  // Check if target met
  console.log('\n');
  if (best.accuracy >= 90) {
    console.log(`✅ TARGET MET: ${best.accuracy.toFixed(2)}% >= 90%`);
  } else {
    console.log(`❌ TARGET NOT MET: Best accuracy ${best.accuracy.toFixed(2)}% < 90%`);
    console.log('');
    console.log('Recommendations:');
    console.log('  1. Consider adding more confluence factors (order flow, book imbalance)');
    console.log('  2. Analyze which level types have highest accuracy');
    console.log('  3. Test stricter wick ratio requirements (0.75+)');
    console.log('  4. Consider session-specific parameter tuning');
  }

  // Save results if output specified
  if (config.output) {
    fs.writeFileSync(config.output, JSON.stringify({ top10, best, all: results }, null, 2));
    console.log(`\n✓ Results saved to ${config.output}`);
  }

  console.log('\n========================================\n');
}

const config = parseArgs();
runAnalysis(config).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
