#!/usr/bin/env node

/**
 * Liquidity Sweep Strategy Backtester
 *
 * Backtests a limit-order based strategy on detected liquidity sweeps:
 * - Wait for sweep detection
 * - Place limit order at wick level (or offset from close)
 * - Target X points beyond original close
 * - Stop beyond wick extreme (capped at max risk)
 * - Cancel if timeout or target hit before fill
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { LiquiditySweepDetector } from './src/analysis/liquidity-sweep-detector.js';
import { LiquiditySweepStrategy } from './src/analysis/liquidity-sweep-strategy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DATA_PATH = path.join(__dirname, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1s.csv');

function parseArgs(args) {
  const options = {
    startDate: null,
    endDate: null,
    dataPath: DEFAULT_DATA_PATH,
    // Detector params
    volumeThreshold: 2.0,
    rangeThreshold: 1.5,
    wickRatio: 0.6,
    lookback: 60,
    minRange: 2.0,
    // Strategy params
    entryMode: 'wick_50',      // 'wick_extreme' | 'wick_50' | 'offset_from_close'
    entryOffset: 10,           // Points from close (if offset_from_close)
    targetPoints: 10,          // Target beyond original close
    maxRisk: 25,               // Max stop distance
    stopBuffer: 2,             // Buffer beyond wick for stop
    orderTimeout: 180,         // Seconds to wait for fill
    // Filtering
    sessions: null,            // Array of sessions: 'overnight', 'premarket', 'rth', 'afterhours'
    direction: 'both',         // 'long', 'short', 'both'
    // Output
    outputJson: null,
    outputCsv: null,
    verbose: false,
    sampleSize: null,
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
      // Detector params
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
      // Strategy params
      case '--entry-mode':
        options.entryMode = nextArg;
        i++;
        break;
      case '--entry-offset':
        options.entryOffset = parseFloat(nextArg);
        i++;
        break;
      case '--target':
        options.targetPoints = parseFloat(nextArg);
        i++;
        break;
      case '--max-risk':
        options.maxRisk = parseFloat(nextArg);
        i++;
        break;
      case '--stop-buffer':
        options.stopBuffer = parseFloat(nextArg);
        i++;
        break;
      case '--timeout':
        options.orderTimeout = parseInt(nextArg, 10);
        i++;
        break;
      // Filtering
      case '--session':
      case '--sessions':
        if (!options.sessions) options.sessions = [];
        options.sessions.push(...nextArg.split(',').map(s => s.trim().toLowerCase()));
        i++;
        break;
      case '--direction':
        options.direction = nextArg.toLowerCase();
        i++;
        break;
      // Output
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
 * Identify which trading session a timestamp belongs to
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} - 'overnight', 'premarket', 'rth', or 'afterhours'
 */
function identifySession(timestamp) {
  const date = new Date(timestamp);

  // Convert to ET timezone (UTC-5 or UTC-4 for DST)
  // For simplicity, we'll use hour of day in UTC and adjust
  // This is approximate - real implementation should use timezone library
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  const hourDecimal = utcHour + utcMinute / 60;

  // Approximate ET times (assuming EST = UTC-5):
  // RTH: 9:30 AM - 4:00 PM ET = 14:30 - 21:00 UTC
  // Premarket: 4:00 AM - 9:30 AM ET = 9:00 - 14:30 UTC
  // Afterhours: 4:00 PM - 8:00 PM ET = 21:00 - 01:00 UTC (next day)
  // Overnight: 8:00 PM - 4:00 AM ET = 01:00 - 09:00 UTC

  const etOffset = 5; // EST offset from UTC
  let etHour = (hourDecimal - etOffset + 24) % 24;

  if (etHour >= 9.5 && etHour < 16) {
    return 'rth';
  } else if (etHour >= 4 && etHour < 9.5) {
    return 'premarket';
  } else if (etHour >= 16 && etHour < 20) {
    return 'afterhours';
  } else {
    return 'overnight';
  }
}

function printHelp() {
  console.log(`
Liquidity Sweep Strategy Backtester

Backtests a limit-order strategy on detected liquidity sweeps.

USAGE:
  node backtest-sweep-strategy.js --start <date> --end <date> [options]

REQUIRED:
  --start <date>          Start date (YYYY-MM-DD)
  --end <date>            End date (YYYY-MM-DD)

DETECTOR OPTIONS:
  --volume-threshold <n>  Volume z-score threshold (default: 2.0)
  --range-threshold <n>   Range z-score threshold (default: 1.5)
  --wick-ratio <n>        Minimum wick ratio (default: 0.6)
  --lookback <n>          Rolling window seconds (default: 60)

STRATEGY OPTIONS:
  --entry-mode <mode>     Entry mode: wick_extreme, wick_50, offset_from_close (default: wick_50)
  --entry-offset <n>      Points from close for offset_from_close mode (default: 10)
  --target <n>            Target points beyond candle close (default: 10)
  --max-risk <n>          Maximum stop distance in points (default: 25)
  --stop-buffer <n>       Extra points beyond wick for stop (default: 2)
  --timeout <n>           Order timeout in seconds (default: 180)

FILTERING OPTIONS:
  --session <sessions>    Filter by session(s): overnight, premarket, rth, afterhours (comma-separated)
  --direction <dir>       Filter by direction: long, short, both (default: both)

OUTPUT OPTIONS:
  --output <file>         JSON output file
  --output-csv <file>     CSV output file
  --sample <n>            Limit to first N sweeps
  -v, --verbose           Verbose output
  -h, --help              Show this help

EXAMPLES:
  # Default settings
  node backtest-sweep-strategy.js --start 2025-01-01 --end 2025-01-20

  # Aggressive entry at wick extreme, 5pt target
  node backtest-sweep-strategy.js --start 2025-01-01 --end 2025-01-20 \\
    --entry-mode wick_extreme --target 5 --max-risk 20

  # RTH only, shorts only
  node backtest-sweep-strategy.js --start 2025-01-01 --end 2025-01-20 \\
    --entry-mode wick_extreme --target 7 --max-risk 15 \\
    --session rth --direction short

  # Overnight and premarket sessions
  node backtest-sweep-strategy.js --start 2025-01-01 --end 2025-01-20 \\
    --entry-mode wick_extreme --target 7 --max-risk 15 \\
    --session overnight,premarket
`);
}

async function processFile(options, detector, strategy) {
  const { dataPath, startDate, endDate, verbose, sampleSize } = options;
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  const tradeResults = [];
  let totalLines = 0;
  let validCandles = 0;
  let detectedSweepsCount = 0;
  let reachedSampleLimit = false;

  // Need enough future data for order timeout + potential hold time
  const maxFutureMs = (options.orderTimeout + 7200) * 1000; // timeout + 2 hours
  let candleBuffer = [];
  let pendingSweeps = [];

  // Primary contract tracking
  const hourlyVolumes = new Map();
  let currentHourCandles = [];

  let lastProgressTime = Date.now();
  let lastProgressLines = 0;

  console.log('\n' + '='.repeat(60));
  console.log('LIQUIDITY SWEEP STRATEGY BACKTEST');
  console.log('='.repeat(60));
  console.log(`\nDetector Config:`);
  console.log(`  Volume Threshold: ${options.volumeThreshold} std devs`);
  console.log(`  Range Threshold: ${options.rangeThreshold} std devs`);
  console.log(`  Wick Ratio: ${options.wickRatio}`);
  console.log(`\nStrategy Config:`);
  console.log(`  Entry Mode: ${options.entryMode}`);
  if (options.entryMode === 'offset_from_close') {
    console.log(`  Entry Offset: ${options.entryOffset} pts`);
  }
  console.log(`  Target: ${options.targetPoints} pts beyond close`);
  console.log(`  Max Risk: ${options.maxRisk} pts`);
  console.log(`  Stop Buffer: ${options.stopBuffer} pts`);
  console.log(`  Order Timeout: ${options.orderTimeout}s`);

  console.log(`\nFilters:`);
  console.log(`  Sessions: ${options.sessions ? options.sessions.join(', ') : 'all'}`);
  console.log(`  Direction: ${options.direction}`);

  console.log(`\nDate Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  if (sampleSize) console.log(`Sample Size: ${sampleSize} sweeps`);
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

      if (Date.now() - lastProgressTime > 10000) {
        const linesPerSec = Math.round((totalLines - lastProgressLines) / 10);
        console.log(`  Processed ${(totalLines / 1000000).toFixed(1)}M lines (${linesPerSec.toLocaleString()}/sec), ${tradeResults.length} trades completed...`);
        lastProgressTime = Date.now();
        lastProgressLines = totalLines;
      }

      if (sampleSize && reachedSampleLimit) {
        return;
      }

      const parts = line.split(',');
      if (parts.length < 10) return;

      const symbol = parts[9];
      if (symbol && symbol.includes('-')) return;

      const timestamp = new Date(parts[0]).getTime();
      if (isNaN(timestamp) || timestamp < startMs || timestamp > endMs) return;

      const candle = {
        timestamp,
        symbol,
        open: parseFloat(parts[4]),
        high: parseFloat(parts[5]),
        low: parseFloat(parts[6]),
        close: parseFloat(parts[7]),
        volume: parseFloat(parts[8])
      };

      if (isNaN(candle.open) || isNaN(candle.volume)) return;

      validCandles++;

      const hourKey = Math.floor(timestamp / (60 * 60 * 1000));
      if (!hourlyVolumes.has(hourKey)) {
        if (currentHourCandles.length > 0) {
          processPrimaryContractCandles(currentHourCandles, hourlyVolumes);
        }
        hourlyVolumes.set(hourKey, new Map());
        currentHourCandles = [];
      }

      const hourData = hourlyVolumes.get(hourKey);
      const currentVol = hourData.get(symbol) || 0;
      hourData.set(symbol, currentVol + candle.volume);

      currentHourCandles.push(candle);
    });

    function processPrimaryContractCandles(candles, hourlyVolumes) {
      if (candles.length === 0) return;

      const hourKey = Math.floor(candles[0].timestamp / (60 * 60 * 1000));
      const hourData = hourlyVolumes.get(hourKey);
      if (!hourData) return;

      let primarySymbol = '';
      let maxVolume = 0;
      for (const [symbol, volume] of hourData.entries()) {
        if (volume > maxVolume) {
          maxVolume = volume;
          primarySymbol = symbol;
        }
      }

      for (const candle of candles) {
        if (candle.symbol !== primarySymbol) continue;
        processCandle(candle);
      }
    }

    function processCandle(candle) {
      candleBuffer.push(candle);

      const oldestNeeded = candle.timestamp - maxFutureMs - 60000;
      while (candleBuffer.length > 0 && candleBuffer[0].timestamp < oldestNeeded) {
        candleBuffer.shift();
      }

      // Detect sweeps
      if (!reachedSampleLimit) {
        const sweep = detector.detectSweep(candle);

        if (sweep) {
          // Apply session filter
          const session = identifySession(sweep.timestamp);
          if (options.sessions && !options.sessions.includes(session)) {
            return; // Skip this sweep - not in allowed sessions
          }

          // Apply direction filter
          // Map sweep type to direction: 'bullish' -> 'long', 'bearish' -> 'short'
          const sweepDirection = sweep.type === 'bullish' ? 'long' : 'short';
          if (options.direction !== 'both' && sweepDirection !== options.direction) {
            return; // Skip this sweep - not matching direction filter
          }

          if (sampleSize && detectedSweepsCount >= sampleSize) {
            reachedSampleLimit = true;
          } else {
            detectedSweepsCount++;
            const setup = strategy.calculateSetup(sweep);
            pendingSweeps.push({
              setup,
              sweepTime: sweep.timestamp,
              session
            });

            if (verbose) {
              console.log(`  [${new Date(sweep.timestamp).toISOString()}] ${session.toUpperCase()} ${sweep.type.toUpperCase()} @ ${sweep.entryPrice} -> Limit: ${setup.limitEntry}, Stop: ${setup.stopLoss}, Target: ${setup.takeProfit} (R:R ${setup.rrRatio})`);
            }
          }
        }
      }

      // Check if any pending sweeps have enough future data
      const cutoffTime = candle.timestamp - maxFutureMs;
      const stillPending = [];

      for (const pending of pendingSweeps) {
        if (pending.sweepTime <= cutoffTime) {
          const subsequentCandles = candleBuffer.filter(c => c.timestamp > pending.sweepTime);
          const result = strategy.simulateTrade(pending.setup, subsequentCandles);
          result.session = pending.session; // Add session to result
          tradeResults.push(result);

          if (verbose && result.execution.filled) {
            const outcome = result.execution.outcome;
            const pnl = result.execution.pnl;
            console.log(`    -> ${outcome.toUpperCase()}: ${pnl >= 0 ? '+' : ''}${pnl} pts`);
          }
        } else {
          stillPending.push(pending);
        }
      }

      pendingSweeps = stillPending;
    }

    function finalizePendingSweeps() {
      if (currentHourCandles.length > 0) {
        processPrimaryContractCandles(currentHourCandles, hourlyVolumes);
      }

      for (const pending of pendingSweeps) {
        const subsequentCandles = candleBuffer.filter(c => c.timestamp > pending.sweepTime);
        if (subsequentCandles.length > 0) {
          const result = strategy.simulateTrade(pending.setup, subsequentCandles);
          result.session = pending.session; // Add session to result
          tradeResults.push(result);
        }
      }
    }

    rl.on('close', () => {
      finalizePendingSweeps();
      console.log(`\n  Finished processing.`);
      console.log(`  Total lines: ${totalLines.toLocaleString()}`);
      console.log(`  Sweeps detected: ${detectedSweepsCount}`);
      console.log(`  Trades simulated: ${tradeResults.length}`);
      resolve(tradeResults);
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

function writeJsonOutput(outputPath, results, statistics, config) {
  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      config
    },
    statistics,
    trades: results
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`  JSON output written to: ${outputPath}`);
}

function writeCsvOutput(outputPath, results) {
  const headers = [
    'sweep_timestamp', 'sweep_type', 'direction', 'session',
    'limit_entry', 'stop_loss', 'take_profit', 'risk', 'reward', 'rr_ratio',
    'filled', 'fill_time', 'fill_price', 'time_to_fill_sec',
    'outcome', 'exit_time', 'exit_price', 'pnl', 'mae', 'mfe', 'hold_time_sec'
  ];

  const rows = [headers.join(',')];

  for (const r of results) {
    const row = [
      r.sweepTimestamp,
      r.sweepType,
      r.direction,
      r.session || 'unknown',
      r.setup.limitEntry,
      r.setup.stopLoss,
      r.setup.takeProfit,
      r.setup.risk,
      r.setup.reward,
      r.setup.rrRatio,
      r.execution.filled ? 1 : 0,
      r.execution.fillTime || '',
      r.execution.fillPrice || '',
      r.execution.timeToFill || '',
      r.execution.outcome,
      r.execution.exitTime || '',
      r.execution.exitPrice || '',
      r.execution.pnl,
      r.execution.mae,
      r.execution.mfe,
      r.execution.holdTime || ''
    ];
    rows.push(row.join(','));
  }

  fs.writeFileSync(outputPath, rows.join('\n'));
  console.log(`  CSV output written to: ${outputPath}`);
}

function printStatistics(stats) {
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(60));

  console.log(`\nTotal Sweeps: ${stats.total}`);
  console.log(`\nOutcomes:`);
  console.log(`  Filled: ${stats.outcomes.filled} (${stats.rates.fillRate}%)`);
  console.log(`  Wins: ${stats.outcomes.wins}`);
  console.log(`  Losses: ${stats.outcomes.losses}`);
  console.log(`  Timeouts: ${stats.outcomes.timeouts} (${stats.rates.timeoutRate}%)`);
  console.log(`  Canceled (target hit first): ${stats.outcomes.canceledTargetFirst} (${stats.rates.canceledRate}%)`);

  console.log(`\nPerformance (filled trades):`);
  console.log(`  Win Rate: ${stats.rates.winRate}%`);
  console.log(`  Total P&L: ${stats.pnl.totalPnL} pts`);
  console.log(`  Avg P&L: ${stats.pnl.avgPnL} pts`);
  console.log(`  Avg Win: ${stats.pnl.avgWinPnL} pts`);
  console.log(`  Avg Loss: ${stats.pnl.avgLossPnL} pts`);
  console.log(`  Expectancy: ${stats.pnl.expectancy} pts/trade`);
  console.log(`  Profit Factor: ${stats.pnl.profitFactor}`);

  console.log(`\nTiming:`);
  console.log(`  Avg Time to Fill: ${stats.timing.avgTimeToFillSeconds}s`);
  console.log(`  Avg Hold Time: ${stats.timing.avgHoldTimeSeconds}s`);

  console.log(`\nRisk:`);
  console.log(`  Avg R:R Ratio: ${stats.risk.avgRR}`);
  console.log(`  Avg MAE: ${stats.risk.avgMAE} pts`);
  console.log(`  Avg MFE: ${stats.risk.avgMFE} pts`);

  console.log(`\nBy Direction:`);
  console.log(`  LONG:  ${stats.byDirection.long.total} setups, ${stats.byDirection.long.fillRate}% fill rate, ${stats.byDirection.long.winRate}% win rate, ${stats.byDirection.long.avgPnL} pts avg`);
  console.log(`  SHORT: ${stats.byDirection.short.total} setups, ${stats.byDirection.short.fillRate}% fill rate, ${stats.byDirection.short.winRate}% win rate, ${stats.byDirection.short.avgPnL} pts avg`);

  // Add session breakdown if available
  if (stats.bySession) {
    console.log(`\nBy Session:`);
    const sessions = ['overnight', 'premarket', 'rth', 'afterhours'];
    sessions.forEach(session => {
      if (stats.bySession[session] && stats.bySession[session].total > 0) {
        const s = stats.bySession[session];
        console.log(`  ${session.toUpperCase()}: ${s.total} setups, ${s.fillRate}% fill rate, ${s.winRate}% win rate, ${s.avgPnL} pts avg`);
      }
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.startDate || !options.endDate) {
    console.error('Error: --start and --end dates are required');
    process.exit(1);
  }

  if (isNaN(options.startDate.getTime()) || isNaN(options.endDate.getTime())) {
    console.error('Error: Invalid date format. Use YYYY-MM-DD');
    process.exit(1);
  }

  options.endDate.setHours(23, 59, 59, 999);

  if (!fs.existsSync(options.dataPath)) {
    console.error(`Error: Data file not found: ${options.dataPath}`);
    process.exit(1);
  }

  const detector = new LiquiditySweepDetector({
    volumeStdDev: options.volumeThreshold,
    rangeStdDev: options.rangeThreshold,
    wickRatio: options.wickRatio,
    lookback: options.lookback,
    minRange: options.minRange
  });

  const strategy = new LiquiditySweepStrategy({
    entryMode: options.entryMode,
    entryOffset: options.entryOffset,
    targetPoints: options.targetPoints,
    maxRisk: options.maxRisk,
    stopBuffer: options.stopBuffer,
    orderTimeout: options.orderTimeout,
    cancelIfTargetHitFirst: true
  });

  console.log('Starting strategy backtest...');
  const startTime = Date.now();

  try {
    const results = await processFile(options, detector, strategy);
    const statistics = strategy.computeStatistics(results);

    printStatistics(statistics);

    if (options.outputJson) {
      writeJsonOutput(options.outputJson, results, statistics, {
        startDate: options.startDate.toISOString(),
        endDate: options.endDate.toISOString(),
        detector: detector.getConfig(),
        strategy: strategy.getConfig()
      });
    }

    if (options.outputCsv) {
      writeCsvOutput(options.outputCsv, results);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nBacktest completed in ${elapsed}s`);

  } catch (error) {
    console.error('Backtest failed:', error.message);
    if (options.verbose) console.error(error.stack);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

main();
