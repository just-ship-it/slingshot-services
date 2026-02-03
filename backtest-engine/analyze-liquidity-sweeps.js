#!/usr/bin/env node

/**
 * Liquidity Sweep Analysis Tool
 *
 * Analyzes 1-second NQ OHLCV data to detect liquidity sweeps and
 * measure their predictive value for subsequent price movement.
 *
 * Usage:
 *   node analyze-liquidity-sweeps.js --start 2024-01-01 --end 2024-12-31
 *   node analyze-liquidity-sweeps.js --start 2024-01-01 --end 2024-12-31 \
 *     --volume-threshold 2.5 --wick-ratio 0.65 --output sweeps.json
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { LiquiditySweepDetector } from './src/analysis/liquidity-sweep-detector.js';
import { LiquiditySweepAnalyzer } from './src/analysis/liquidity-sweep-analyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default data path
const DEFAULT_DATA_PATH = path.join(__dirname, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1s.csv');

/**
 * Parse command line arguments
 */
function parseArgs(args) {
  const options = {
    startDate: null,
    endDate: null,
    dataPath: DEFAULT_DATA_PATH,
    volumeThreshold: 2.0,
    rangeThreshold: 1.5,
    wickRatio: 0.6,
    lookback: 60,
    minRange: 2.0,
    targets: [5, 10, 20, 50],
    timeWindows: [15, 30, 60, 120],
    outputJson: null,
    outputCsv: null,
    verbose: false,
    sampleSize: null, // For quick testing
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--start':
        options.startDate = new Date(nextArg);
        i++;
        break;
      case '--end':
        options.endDate = new Date(nextArg);
        i++;
        break;
      case '--data':
        options.dataPath = nextArg;
        i++;
        break;
      case '--volume-threshold':
        options.volumeThreshold = parseFloat(nextArg);
        i++;
        break;
      case '--range-threshold':
        options.rangeThreshold = parseFloat(nextArg);
        i++;
        break;
      case '--wick-ratio':
        options.wickRatio = parseFloat(nextArg);
        i++;
        break;
      case '--lookback':
        options.lookback = parseInt(nextArg, 10);
        i++;
        break;
      case '--min-range':
        options.minRange = parseFloat(nextArg);
        i++;
        break;
      case '--targets':
        options.targets = nextArg.split(',').map(t => parseInt(t, 10));
        i++;
        break;
      case '--time-windows':
        options.timeWindows = nextArg.split(',').map(t => parseInt(t, 10));
        i++;
        break;
      case '--output':
      case '--output-json':
        options.outputJson = nextArg;
        i++;
        break;
      case '--output-csv':
        options.outputCsv = nextArg;
        i++;
        break;
      case '--sample':
        options.sampleSize = parseInt(nextArg, 10);
        i++;
        break;
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
    }
  }

  return options;
}

/**
 * Print usage information
 */
function printHelp() {
  console.log(`
Liquidity Sweep Analysis Tool

Detects liquidity sweeps in 1-second NQ data and analyzes their
predictive value for subsequent price movement.

USAGE:
  node analyze-liquidity-sweeps.js --start <date> --end <date> [options]

REQUIRED:
  --start <date>          Start date (YYYY-MM-DD)
  --end <date>            End date (YYYY-MM-DD)

OPTIONS:
  --data <path>           Path to 1-second CSV file (default: data/ohlcv/nq/NQ_ohlcv_1s.csv)
  --volume-threshold <n>  Volume z-score threshold (default: 2.0)
  --range-threshold <n>   Range z-score threshold (default: 1.5)
  --wick-ratio <n>        Minimum wick ratio (default: 0.6)
  --lookback <n>          Rolling window in seconds (default: 60)
  --min-range <n>         Minimum candle range in points (default: 2.0)
  --targets <list>        Comma-separated target points (default: 5,10,20,50)
  --time-windows <list>   Comma-separated time windows in minutes (default: 15,30,60,120)
  --output <file>         JSON output file
  --output-csv <file>     CSV output file
  --sample <n>            Limit to first N sweeps (for testing)
  -v, --verbose           Verbose output
  -h, --help              Show this help

EXAMPLES:
  # Analyze all of 2024
  node analyze-liquidity-sweeps.js --start 2024-01-01 --end 2024-12-31

  # Custom thresholds with output
  node analyze-liquidity-sweeps.js --start 2024-01-01 --end 2024-06-30 \\
    --volume-threshold 2.5 --wick-ratio 0.65 \\
    --output results.json --output-csv trades.csv

  # Quick test with first 100 sweeps
  node analyze-liquidity-sweeps.js --start 2024-01-01 --end 2024-12-31 --sample 100
`);
}

/**
 * Stream-process the 1-second CSV file
 * Groups candles by day, detects sweeps, and analyzes outcomes
 */
async function processFile(options, detector, analyzer) {
  const {
    dataPath,
    startDate,
    endDate,
    verbose,
    sampleSize
  } = options;

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  // Results storage
  const sweepOutcomes = [];
  let totalLines = 0;
  let validCandles = 0;
  let filteredByDate = 0;
  let filteredByCalendarSpread = 0;
  let detectedSweepsCount = 0;
  let reachedSampleLimit = false;

  // Buffer for outcome analysis (need future candles)
  const maxWindowMs = Math.max(...options.timeWindows) * 60 * 1000;
  let candleBuffer = [];
  let pendingSweeps = []; // Sweeps waiting for future candles

  // Primary contract tracking per hour
  const hourlyVolumes = new Map(); // hourKey -> Map<symbol, volume>
  let currentHourCandles = []; // Buffer to reprocess after determining primary

  // Progress tracking
  let lastProgressTime = Date.now();
  let lastProgressLines = 0;

  console.log('\n' + '='.repeat(60));
  console.log('LIQUIDITY SWEEP ANALYSIS');
  console.log('='.repeat(60));
  console.log(`\nConfiguration:`);
  console.log(`  Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`  Volume Threshold: ${options.volumeThreshold} std devs`);
  console.log(`  Range Threshold: ${options.rangeThreshold} std devs`);
  console.log(`  Wick Ratio: ${options.wickRatio}`);
  console.log(`  Lookback Period: ${options.lookback} seconds`);
  console.log(`  Targets: ${options.targets.join(', ')} points`);
  console.log(`  Time Windows: ${options.timeWindows.join(', ')} minutes`);
  if (sampleSize) console.log(`  Sample Size: ${sampleSize} sweeps`);
  console.log('');

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(dataPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let isHeader = true;

    rl.on('line', (line) => {
      if (isHeader) {
        isHeader = false;
        return;
      }

      totalLines++;

      // Progress report every 10 seconds
      if (Date.now() - lastProgressTime > 10000) {
        const linesPerSec = Math.round((totalLines - lastProgressLines) / 10);
        console.log(`  Processed ${(totalLines / 1000000).toFixed(1)}M lines (${linesPerSec.toLocaleString()}/sec), ${sweepOutcomes.length} sweeps found...`);
        lastProgressTime = Date.now();
        lastProgressLines = totalLines;
      }

      // Check sample limit (based on detected sweeps, not outcomes)
      if (sampleSize && reachedSampleLimit) {
        return; // Continue processing to gather outcome data for detected sweeps
      }

      // Parse CSV line
      // Format: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
      const parts = line.split(',');
      if (parts.length < 10) return;

      const symbol = parts[9];

      // Filter calendar spreads (symbols with dash)
      if (symbol && symbol.includes('-')) {
        filteredByCalendarSpread++;
        return;
      }

      const timestamp = new Date(parts[0]).getTime();

      // Filter by date range
      if (isNaN(timestamp) || timestamp < startMs || timestamp > endMs) {
        if (!isNaN(timestamp)) filteredByDate++;
        return;
      }

      const candle = {
        timestamp,
        symbol,
        open: parseFloat(parts[4]),
        high: parseFloat(parts[5]),
        low: parseFloat(parts[6]),
        close: parseFloat(parts[7]),
        volume: parseFloat(parts[8])
      };

      // Skip invalid candles
      if (isNaN(candle.open) || isNaN(candle.volume)) return;

      validCandles++;

      // Track hourly volumes for primary contract filtering
      const hourKey = Math.floor(timestamp / (60 * 60 * 1000));
      if (!hourlyVolumes.has(hourKey)) {
        // New hour - process previous hour's candles
        if (currentHourCandles.length > 0) {
          processPrimaryContractCandles(currentHourCandles, hourlyVolumes);
        }
        hourlyVolumes.set(hourKey, new Map());
        currentHourCandles = [];
      }

      // Accumulate volume for this symbol in this hour
      const hourData = hourlyVolumes.get(hourKey);
      const currentVol = hourData.get(symbol) || 0;
      hourData.set(symbol, currentVol + candle.volume);

      currentHourCandles.push(candle);
    });

    /**
     * Process candles for an hour after determining primary contract
     */
    function processPrimaryContractCandles(candles, hourlyVolumes) {
      if (candles.length === 0) return;

      const hourKey = Math.floor(candles[0].timestamp / (60 * 60 * 1000));
      const hourData = hourlyVolumes.get(hourKey);

      if (!hourData) return;

      // Find primary contract (highest volume)
      let primarySymbol = '';
      let maxVolume = 0;
      for (const [symbol, volume] of hourData.entries()) {
        if (volume > maxVolume) {
          maxVolume = volume;
          primarySymbol = symbol;
        }
      }

      // Process only primary contract candles
      for (const candle of candles) {
        if (candle.symbol !== primarySymbol) continue;

        processCandle(candle);
      }
    }

    /**
     * Process a single candle through detection and outcome tracking
     */
    function processCandle(candle) {
      // Add to buffer for outcome analysis
      candleBuffer.push(candle);

      // Keep buffer size manageable
      const oldestNeeded = candle.timestamp - maxWindowMs - 60000;
      while (candleBuffer.length > 0 && candleBuffer[0].timestamp < oldestNeeded) {
        candleBuffer.shift();
      }

      // Try to detect a sweep
      const sweep = detector.detectSweep(candle);

      if (sweep) {
        // Check sample limit before adding more sweeps
        if (sampleSize && detectedSweepsCount >= sampleSize) {
          reachedSampleLimit = true;
        } else {
          detectedSweepsCount++;
          pendingSweeps.push({
            sweep,
            startIndex: candleBuffer.length - 1
          });

          if (verbose) {
            console.log(`  [${new Date(sweep.timestamp).toISOString()}] ${sweep.type.toUpperCase()} sweep @ ${sweep.entryPrice} (conf: ${sweep.confidence})`);
          }
        }
      }

      // Check if any pending sweeps have enough future data
      const cutoffTime = candle.timestamp - maxWindowMs;
      const completedSweeps = [];
      const stillPending = [];

      for (const pending of pendingSweeps) {
        if (pending.sweep.timestamp <= cutoffTime) {
          // This sweep has enough future data, analyze it
          const subsequentCandles = candleBuffer.filter(c => c.timestamp > pending.sweep.timestamp);
          const outcome = analyzer.analyzeOutcome(pending.sweep, subsequentCandles);
          sweepOutcomes.push(outcome);
          completedSweeps.push(pending);
        } else {
          stillPending.push(pending);
        }
      }

      pendingSweeps = stillPending;
    }

    /**
     * Finalize remaining pending sweeps
     */
    function finalizePendingSweeps() {
      // Process remaining hour
      if (currentHourCandles.length > 0) {
        processPrimaryContractCandles(currentHourCandles, hourlyVolumes);
      }

      // Analyze remaining pending sweeps with available data
      for (const pending of pendingSweeps) {
        const subsequentCandles = candleBuffer.filter(c => c.timestamp > pending.sweep.timestamp);
        if (subsequentCandles.length > 0) {
          const outcome = analyzer.analyzeOutcome(pending.sweep, subsequentCandles);
          sweepOutcomes.push(outcome);
        }
      }
    }

    rl.on('close', () => {
      finalizePendingSweeps();

      console.log(`\n  Finished processing.`);
      console.log(`  Total lines: ${totalLines.toLocaleString()}`);
      console.log(`  Valid candles: ${validCandles.toLocaleString()}`);
      console.log(`  Filtered (date): ${filteredByDate.toLocaleString()}`);
      console.log(`  Filtered (calendar spread): ${filteredByCalendarSpread.toLocaleString()}`);

      resolve(sweepOutcomes);
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

/**
 * Write results to JSON file
 */
function writeJsonOutput(outputPath, sweepOutcomes, statistics, config) {
  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      config
    },
    statistics,
    sweeps: sweepOutcomes
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`  JSON output written to: ${outputPath}`);
}

/**
 * Write results to CSV file
 */
function writeCsvOutput(outputPath, sweepOutcomes, targets, timeWindows) {
  // Build header
  const baseHeaders = [
    'timestamp', 'type', 'direction', 'symbol', 'entry_price',
    'session', 'day_of_week', 'confidence',
    'volume', 'volume_zscore', 'range', 'range_zscore', 'wick_ratio',
    'overall_mae', 'overall_mfe'
  ];

  // Add outcome headers for each time window
  const outcomeHeaders = [];
  for (const window of timeWindows) {
    outcomeHeaders.push(
      `${window}min_mae`,
      `${window}min_mfe`,
      `${window}min_pnl`
    );
    for (const target of targets) {
      outcomeHeaders.push(`${window}min_hit_${target}pt`);
    }
  }

  const headers = [...baseHeaders, ...outcomeHeaders];

  // Build rows
  const rows = [headers.join(',')];

  for (const outcome of sweepOutcomes) {
    const row = [
      outcome.timestamp,
      outcome.type,
      outcome.direction,
      outcome.symbol,
      outcome.entryPrice,
      outcome.session,
      outcome.dayOfWeek,
      outcome.confidence,
      outcome.metrics.volume,
      outcome.metrics.volumeZScore,
      outcome.metrics.range,
      outcome.metrics.rangeZScore,
      outcome.metrics.wickRatio,
      outcome.summary.overallMAE,
      outcome.summary.overallMFE
    ];

    // Add outcome data for each time window
    for (const window of timeWindows) {
      const windowKey = `${window}min`;
      const windowOutcome = outcome.outcomes[windowKey];

      if (windowOutcome) {
        row.push(windowOutcome.mae);
        row.push(windowOutcome.mfe);
        row.push(windowOutcome.finalPnL);

        for (const target of targets) {
          row.push(windowOutcome.targetHits[target]?.hit ? 1 : 0);
        }
      } else {
        // Fill with empty values
        row.push('', '', '');
        for (const target of targets) {
          row.push('');
        }
      }
    }

    rows.push(row.join(','));
  }

  fs.writeFileSync(outputPath, rows.join('\n'));
  console.log(`  CSV output written to: ${outputPath}`);
}

/**
 * Print statistics summary to console
 */
function printStatistics(statistics, detectorStats) {
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(60));

  console.log(`\nDetection Statistics:`);
  console.log(`  Candles Processed: ${detectorStats.candlesProcessed.toLocaleString()}`);
  console.log(`  Sweeps Detected: ${statistics.totalSweeps}`);
  console.log(`  Bullish Sweeps: ${statistics.bullishSweeps}`);
  console.log(`  Bearish Sweeps: ${statistics.bearishSweeps}`);

  console.log(`\nBy Sweep Type:`);
  for (const [type, data] of Object.entries(statistics.byType)) {
    console.log(`  ${type.toUpperCase()}:`);
    console.log(`    Count: ${data.count}`);
    console.log(`    Avg P&L (30min): ${data.avgPnL} pts`);
    console.log(`    Avg MAE: ${data.avgMAE} pts`);
    console.log(`    Avg MFE: ${data.avgMFE} pts`);
  }

  console.log(`\nBy Target:`);
  for (const [targetKey, data] of Object.entries(statistics.byTarget)) {
    console.log(`  ${targetKey}:`);
    console.log(`    Win Rate: ${data.winRate}%`);
    console.log(`    Avg Time to Target: ${data.avgTimeToTarget}`);
    console.log(`    Avg MAE Before Hit: ${data.avgMAEBeforeHit} pts`);
  }

  console.log(`\nBy Time Window:`);
  for (const [windowKey, data] of Object.entries(statistics.byTimeWindow)) {
    console.log(`  ${windowKey}:`);
    console.log(`    Win Rate: ${data.winRate}%`);
    console.log(`    Avg P&L: ${data.avgPnL} pts`);
    console.log(`    Avg MAE: ${data.avgMAE} pts`);
    console.log(`    Avg MFE: ${data.avgMFE} pts`);
  }

  console.log(`\nBy Session:`);
  for (const [session, data] of Object.entries(statistics.bySession)) {
    if (data.count > 0) {
      console.log(`  ${session}:`);
      console.log(`    Count: ${data.count}`);
      console.log(`    Win Rate: ${data.winRate}%`);
      console.log(`    Avg P&L: ${data.avgPnL} pts`);
      console.log(`    Avg MAE: ${data.avgMAE} pts`);
    }
  }

  console.log(`\nBy Day of Week:`);
  for (const [day, data] of Object.entries(statistics.byDayOfWeek)) {
    if (data.count > 0) {
      console.log(`  ${day}: ${data.count} sweeps, ${data.winRate}% win rate, ${data.avgPnL} pts avg P&L`);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  // Validate required arguments
  if (!options.startDate || !options.endDate) {
    console.error('Error: --start and --end dates are required');
    console.error('Use --help for usage information');
    process.exit(1);
  }

  if (isNaN(options.startDate.getTime()) || isNaN(options.endDate.getTime())) {
    console.error('Error: Invalid date format. Use YYYY-MM-DD');
    process.exit(1);
  }

  // Make endDate inclusive by setting it to end of day
  options.endDate.setHours(23, 59, 59, 999);

  // Verify data file exists
  if (!fs.existsSync(options.dataPath)) {
    console.error(`Error: Data file not found: ${options.dataPath}`);
    process.exit(1);
  }

  // Initialize detector and analyzer
  const detector = new LiquiditySweepDetector({
    volumeStdDev: options.volumeThreshold,
    rangeStdDev: options.rangeThreshold,
    wickRatio: options.wickRatio,
    lookback: options.lookback,
    minRange: options.minRange
  });

  const analyzer = new LiquiditySweepAnalyzer({
    targets: options.targets,
    timeWindows: options.timeWindows
  });

  console.log('Starting liquidity sweep analysis...');
  const startTime = Date.now();

  try {
    // Process the file
    const sweepOutcomes = await processFile(options, detector, analyzer);

    // Compute statistics
    const statistics = analyzer.computeStatistics(sweepOutcomes);
    const detectorStats = detector.getStats();

    // Print summary
    printStatistics(statistics, detectorStats);

    // Write output files
    if (options.outputJson) {
      writeJsonOutput(options.outputJson, sweepOutcomes, statistics, {
        startDate: options.startDate.toISOString(),
        endDate: options.endDate.toISOString(),
        detector: detector.getConfig(),
        analyzer: analyzer.getConfig()
      });
    }

    if (options.outputCsv) {
      writeCsvOutput(options.outputCsv, sweepOutcomes, options.targets, options.timeWindows);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nAnalysis completed in ${elapsed}s`);

  } catch (error) {
    console.error('Analysis failed:', error.message);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Handle process errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

main();
