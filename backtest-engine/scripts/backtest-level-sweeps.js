#!/usr/bin/env node

/**
 * Level Sweep Backtest Script
 *
 * Runs the level-aware liquidity sweep detection system against historical data
 * and measures accuracy across different confidence tiers.
 *
 * Usage:
 *   node backtest-level-sweeps.js --start 2024-01-01 --end 2024-12-31
 *   node backtest-level-sweeps.js --start 2025-01-01 --end 2025-01-31 --tier A+
 *
 * Options:
 *   --ticker    Ticker symbol (default: NQ)
 *   --start     Start date (YYYY-MM-DD)
 *   --end       End date (YYYY-MM-DD)
 *   --tier      Filter to specific tier (A+, A, B, C)
 *   --session   Filter to specific session (overnight, premarket, rth, afterhours)
 *   --output    Output file for results (JSON)
 *   --csv       Output CSV file for trades
 *   --verbose   Show detailed output
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');

// Import components
import { CSVLoader } from '../src/data/csv-loader.js';
import { GexLoader } from '../src/data-loaders/gex-loader.js';
import { LevelCalculator } from '../src/levels/level-calculator.js';
import { LevelSweepDetector } from '../src/analysis/level-sweep-detector.js';
import { SweepConfluenceScorer, CONFIDENCE_TIERS } from '../src/analysis/sweep-confluence-scorer.js';
import { SweepLabeler, OUTCOME_LABELS } from '../src/analysis/sweep-labeler.js';

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    ticker: 'NQ',
    startDate: null,
    endDate: null,
    tier: null,
    session: null,
    output: null,
    csv: null,
    verbose: false
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
      case '--tier':
        config.tier = args[++i];
        break;
      case '--session':
        config.session = args[++i];
        break;
      case '--output':
        config.output = args[++i];
        break;
      case '--csv':
        config.csv = args[++i];
        break;
      case '--verbose':
      case '-v':
        config.verbose = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }

  // Default date range: last 30 days
  if (!config.startDate) {
    config.startDate = new Date();
    config.startDate.setDate(config.startDate.getDate() - 30);
  }
  if (!config.endDate) {
    config.endDate = new Date();
  }

  return config;
}

function printUsage() {
  console.log(`
Level Sweep Backtest Script

Usage:
  node backtest-level-sweeps.js [options]

Options:
  --ticker    Ticker symbol (default: NQ)
  --start     Start date YYYY-MM-DD (default: 30 days ago)
  --end       End date YYYY-MM-DD (default: today)
  --tier      Filter to tier: A+, A, B, C
  --session   Filter to session: overnight, premarket, rth, afterhours
  --output    Output JSON file path
  --csv       Output CSV file path
  --verbose   Show detailed progress
  --help      Show this help message

Examples:
  node backtest-level-sweeps.js --start 2024-06-01 --end 2024-12-31
  node backtest-level-sweeps.js --start 2025-01-01 --tier A+ --verbose
  `);
}

/**
 * Load configuration for CSV loader
 */
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

/**
 * Format number with commas
 */
function formatNumber(num) {
  return num.toLocaleString('en-US');
}

/**
 * Format percentage
 */
function formatPct(num) {
  return `${num.toFixed(2)}%`;
}

/**
 * Main backtest function
 */
async function runBacktest(config) {
  console.log('\n========================================');
  console.log('   Level Sweep Backtest');
  console.log('========================================\n');

  console.log(`Ticker: ${config.ticker}`);
  console.log(`Date Range: ${config.startDate.toISOString().split('T')[0]} to ${config.endDate.toISOString().split('T')[0]}`);
  if (config.tier) console.log(`Tier Filter: ${config.tier}`);
  if (config.session) console.log(`Session Filter: ${config.session}`);
  console.log('');

  // Initialize loaders
  console.log('Loading data...');

  const loaderConfig = getLoaderConfig();
  const csvLoader = new CSVLoader(DATA_DIR, loaderConfig);

  // Load OHLCV data
  console.log('  Loading OHLCV data...');
  const { candles } = await csvLoader.loadOHLCVData(config.ticker, config.startDate, config.endDate);
  console.log(`  ✓ Loaded ${formatNumber(candles.length)} candles`);

  if (candles.length === 0) {
    console.error('No candle data found for the specified date range');
    process.exit(1);
  }

  // Load GEX data
  console.log('  Loading GEX data...');
  const gexDir = join(DATA_DIR, 'gex');
  const gexLoader = new GexLoader(gexDir, config.ticker.toLowerCase());
  await gexLoader.loadDateRange(config.startDate, config.endDate);
  const gexStats = gexLoader.getStatistics();
  console.log(`  ✓ Loaded ${formatNumber(gexStats.count)} GEX snapshots`);

  // Initialize detection components
  console.log('\nInitializing detection system...');

  const levelCalculator = new LevelCalculator({
    gexLoader,
    levelTolerance: 5
  });

  const sweepDetector = new LevelSweepDetector({
    levelCalculator,
    gexLoader,
    levelTolerance: 5,
    volumeZThreshold: 2.0,
    rangeZThreshold: 1.5,
    wickRatio: 0.6,
    minRange: 3.0,
    cooldownSeconds: 30,
    sessionFilter: config.session ? [config.session] : ['premarket', 'overnight']
  });

  const confluenceScorer = new SweepConfluenceScorer();

  const sweepLabeler = new SweepLabeler({
    instrument: config.ticker,
    targetPoints: 3,      // Even tighter target
    stopPoints: 5,
    maxLookforwardBars: 60
  });

  console.log('✓ System initialized\n');

  // Process candles and detect sweeps
  console.log('Processing candles...');
  const startTime = Date.now();

  const rawSweeps = sweepDetector.processCandles(candles);
  console.log(`  ✓ Detected ${formatNumber(rawSweeps.length)} raw sweeps`);

  // Score sweeps
  console.log('  Scoring sweeps...');
  const scoredSweeps = confluenceScorer.scoreAll(rawSweeps);

  // Filter by tier if specified
  let filteredSweeps = scoredSweeps;
  if (config.tier) {
    filteredSweeps = scoredSweeps.filter(s => s.scoring.tier === config.tier);
    console.log(`  ✓ Filtered to ${formatNumber(filteredSweeps.length)} ${config.tier}-tier sweeps`);
  }

  // Label sweeps
  console.log('  Labeling outcomes...');
  const labeledSweeps = sweepLabeler.labelAll(filteredSweeps, candles);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n✓ Processing complete in ${elapsed}s\n`);

  // Calculate accuracy metrics
  console.log('========================================');
  console.log('   RESULTS');
  console.log('========================================\n');

  const overallAccuracy = sweepLabeler.calculateAccuracy(labeledSweeps);
  const byTier = sweepLabeler.calculateAccuracyByTier(labeledSweeps);
  const bySession = sweepLabeler.calculateAccuracyBySession(labeledSweeps);
  const byType = sweepLabeler.calculateAccuracyByType(labeledSweeps);
  const byLevel = sweepLabeler.calculateAccuracyByLevelType(labeledSweeps);

  // Overall Results
  console.log('OVERALL PERFORMANCE');
  console.log('-------------------');
  console.log(`Total Sweeps:      ${formatNumber(overallAccuracy.total)}`);
  console.log(`Successes:         ${formatNumber(overallAccuracy.successes)} (hit ${overallAccuracy.targetPoints}pt target)`);
  console.log(`Failures:          ${formatNumber(overallAccuracy.failures)} (hit ${overallAccuracy.stopPoints}pt stop)`);
  console.log(`Timeouts:          ${formatNumber(overallAccuracy.timeouts)}`);
  console.log(`Partials:          ${formatNumber(overallAccuracy.partials)}`);
  console.log('');
  console.log(`Win Rate:          ${formatPct(overallAccuracy.winRate)}`);
  console.log(`Resolved Accuracy: ${formatPct(overallAccuracy.resolvedAccuracy)}`);
  console.log(`Expectancy:        ${overallAccuracy.expectancy.toFixed(2)} pts/trade`);
  console.log(`Profit Factor:     ${overallAccuracy.profitFactor.toFixed(2)}`);
  console.log('');
  console.log(`Avg MAE:           ${overallAccuracy.avgMAE.toFixed(2)} pts`);
  console.log(`Avg MFE:           ${overallAccuracy.avgMFE.toFixed(2)} pts`);
  console.log(`Avg Time to Out:   ${overallAccuracy.avgTimeToOutcomeSeconds}s`);
  console.log('');

  // By Tier
  console.log('ACCURACY BY CONFIDENCE TIER');
  console.log('---------------------------');
  console.log('Tier    Total   Success  Failure   Win Rate   Accuracy');
  console.log('----    -----   -------  -------   --------   --------');

  for (const tier of ['A+', 'A', 'B', 'C']) {
    const t = byTier[tier];
    if (t && t.total > 0) {
      console.log(
        `${tier.padEnd(4)}    ${String(t.total).padStart(5)}   ${String(t.successes).padStart(7)}  ` +
        `${String(t.failures).padStart(7)}   ${formatPct(t.winRate).padStart(8)}   ${formatPct(t.resolvedAccuracy).padStart(8)}`
      );
    }
  }
  console.log('');

  // By Session
  console.log('ACCURACY BY SESSION');
  console.log('-------------------');
  console.log('Session       Total   Success  Failure   Win Rate   Accuracy');
  console.log('-------       -----   -------  -------   --------   --------');

  for (const session of ['overnight', 'premarket', 'rth', 'afterhours']) {
    const s = bySession[session];
    if (s && s.total > 0) {
      console.log(
        `${session.padEnd(12)}  ${String(s.total).padStart(5)}   ${String(s.successes).padStart(7)}  ` +
        `${String(s.failures).padStart(7)}   ${formatPct(s.winRate).padStart(8)}   ${formatPct(s.resolvedAccuracy).padStart(8)}`
      );
    }
  }
  console.log('');

  // By Type
  console.log('ACCURACY BY SWEEP TYPE');
  console.log('----------------------');
  console.log('Type      Total   Success  Failure   Win Rate   Accuracy');
  console.log('----      -----   -------  -------   --------   --------');

  for (const type of ['bullish', 'bearish']) {
    const t = byType[type];
    if (t && t.total > 0) {
      console.log(
        `${type.padEnd(8)}  ${String(t.total).padStart(5)}   ${String(t.successes).padStart(7)}  ` +
        `${String(t.failures).padStart(7)}   ${formatPct(t.winRate).padStart(8)}   ${formatPct(t.resolvedAccuracy).padStart(8)}`
      );
    }
  }
  console.log('');

  // By Level Type (top 5)
  console.log('ACCURACY BY LEVEL TYPE (Top 5)');
  console.log('------------------------------');
  const sortedLevels = Object.entries(byLevel)
    .filter(([_, v]) => v.total >= 5)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5);

  if (sortedLevels.length > 0) {
    console.log('Level Type            Total   Success   Win Rate   Accuracy');
    console.log('----------            -----   -------   --------   --------');

    for (const [levelType, stats] of sortedLevels) {
      console.log(
        `${levelType.padEnd(20)}  ${String(stats.total).padStart(5)}   ${String(stats.successes).padStart(7)}   ` +
        `${formatPct(stats.winRate).padStart(8)}   ${formatPct(stats.resolvedAccuracy).padStart(8)}`
      );
    }
  }
  console.log('');

  // Tier distribution
  const tierDist = confluenceScorer.getTierDistribution();
  console.log('TIER DISTRIBUTION');
  console.log('-----------------');
  for (const tier of ['A+', 'A', 'B', 'C']) {
    const pct = tierDist[tier] || 0;
    const count = byTier[tier]?.total || 0;
    console.log(`${tier}: ${formatPct(pct)} (${count} sweeps)`);
  }
  console.log('');

  // Tradeable sweeps summary
  const tradeableSweeps = labeledSweeps.filter(s =>
    s.scoring?.tier === 'A+' || s.scoring?.tier === 'A'
  );
  const tradeableAccuracy = sweepLabeler.calculateAccuracy(tradeableSweeps);

  console.log('========================================');
  console.log('   TRADEABLE SIGNALS (A+ and A only)');
  console.log('========================================');
  console.log(`Total:       ${formatNumber(tradeableAccuracy.total)}`);
  console.log(`Win Rate:    ${formatPct(tradeableAccuracy.winRate)}`);
  console.log(`Accuracy:    ${formatPct(tradeableAccuracy.resolvedAccuracy)}`);
  console.log(`Expectancy:  ${tradeableAccuracy.expectancy.toFixed(2)} pts/trade`);
  console.log(`PF:          ${tradeableAccuracy.profitFactor.toFixed(2)}`);
  console.log('');

  // Target check
  const TARGET_ACCURACY = 90;
  if (tradeableAccuracy.resolvedAccuracy >= TARGET_ACCURACY) {
    console.log(`✅ TARGET MET: ${formatPct(tradeableAccuracy.resolvedAccuracy)} >= ${TARGET_ACCURACY}%`);
  } else {
    console.log(`❌ TARGET NOT MET: ${formatPct(tradeableAccuracy.resolvedAccuracy)} < ${TARGET_ACCURACY}%`);
    console.log(`   Gap: ${(TARGET_ACCURACY - tradeableAccuracy.resolvedAccuracy).toFixed(2)}%`);
  }
  console.log('');

  // Detection stats
  const detectorStats = sweepDetector.getStats();
  console.log('DETECTION STATISTICS');
  console.log('--------------------');
  console.log(`Candles Processed:  ${formatNumber(detectorStats.candlesProcessed)}`);
  console.log(`Filtered by Volume: ${formatNumber(detectorStats.filteredByVolume)}`);
  console.log(`Filtered by Level:  ${formatNumber(detectorStats.filteredByLevel)}`);
  console.log(`Filtered by Wick:   ${formatNumber(detectorStats.filteredByWick)}`);
  console.log(`Filtered by Session:${formatNumber(detectorStats.filteredBySession)}`);
  console.log(`Filtered by Cooldown:${formatNumber(detectorStats.filteredByCooldown)}`);
  console.log('');

  // Save output if requested
  if (config.output) {
    const results = {
      config: {
        ticker: config.ticker,
        startDate: config.startDate.toISOString(),
        endDate: config.endDate.toISOString(),
        tier: config.tier,
        session: config.session
      },
      summary: {
        overall: overallAccuracy,
        byTier,
        bySession,
        byType,
        byLevel,
        tradeable: tradeableAccuracy
      },
      detectorStats,
      sweeps: labeledSweeps.map(s => ({
        timestamp: s.datetime,
        type: s.type,
        direction: s.direction,
        entry: s.entry,
        tier: s.scoring?.tier,
        confidence: s.scoring?.finalConfidence,
        confluenceCount: s.scoring?.confluenceCount,
        level: s.level?.type,
        outcome: s.labeling.outcome,
        mae: s.labeling.mae,
        mfe: s.labeling.mfe,
        pnl: s.labeling.realizedPnL
      }))
    };

    fs.writeFileSync(config.output, JSON.stringify(results, null, 2));
    console.log(`✓ Results saved to ${config.output}`);
  }

  // Save CSV if requested
  if (config.csv) {
    const headers = [
      'timestamp', 'type', 'direction', 'entry', 'tier', 'confidence',
      'confluence_count', 'level_type', 'session', 'outcome',
      'target_level', 'stop_level', 'mae', 'mfe', 'realized_pnl'
    ];

    const rows = labeledSweeps.map(s => [
      s.datetime,
      s.type,
      s.direction,
      s.entry,
      s.scoring?.tier || '',
      s.scoring?.finalConfidence || '',
      s.scoring?.confluenceCount || 0,
      s.level?.type || '',
      s.session,
      s.labeling.outcome,
      s.labeling.targetLevel,
      s.labeling.stopLevel,
      s.labeling.mae,
      s.labeling.mfe,
      s.labeling.realizedPnL
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    fs.writeFileSync(config.csv, csvContent);
    console.log(`✓ Trades saved to ${config.csv}`);
  }

  // Verbose output - show sample trades
  if (config.verbose && labeledSweeps.length > 0) {
    console.log('\nSAMPLE TRADES (first 10)');
    console.log('------------------------');

    const sample = labeledSweeps.slice(0, 10);
    for (const sweep of sample) {
      const outcome = sweep.labeling.outcome;
      const emoji = outcome === 'success' ? '✅' : outcome === 'failure' ? '❌' : '⏱️';

      console.log(
        `${emoji} ${sweep.datetime.substring(0, 16)} | ` +
        `${sweep.type.padEnd(7)} | ${sweep.direction.padEnd(5)} @ ${sweep.entry.toFixed(2)} | ` +
        `Tier ${sweep.scoring?.tier || '?'} | Level: ${(sweep.level?.type || 'none').substring(0, 15)} | ` +
        `${outcome} (PnL: ${sweep.labeling.realizedPnL.toFixed(2)})`
      );
    }
  }

  console.log('\n========================================');
  console.log('   Backtest Complete');
  console.log('========================================\n');
}

// Run the backtest
const config = parseArgs();
runBacktest(config).catch(err => {
  console.error('Error running backtest:', err);
  process.exit(1);
});
