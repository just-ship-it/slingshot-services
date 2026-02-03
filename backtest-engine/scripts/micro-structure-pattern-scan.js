#!/usr/bin/env node

/**
 * Micro-Structure Pattern Analysis Script
 *
 * Scans historical NQ data to detect all pattern occurrences and analyze
 * their forward returns. This is the "wide net" phase to identify which
 * patterns have edge before building the final strategy.
 *
 * Usage:
 *   node micro-structure-pattern-scan.js [options]
 *
 * Options:
 *   --start       Start date (YYYY-MM-DD, default: 2025-01-01)
 *   --end         End date (YYYY-MM-DD, default: 2025-12-31)
 *   --timeframe   Target timeframe (default: 3m)
 *   --output      Output JSON file (default: pattern-analysis-results.json)
 *   --verbose     Show detailed pattern detections
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { CSVLoader } from '../src/data/csv-loader.js';
import { CandleAggregator } from '../src/data/candle-aggregator.js';
import { PATTERNS } from '../../shared/strategies/patterns/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');

/**
 * Parse command line arguments
 */
async function parseArgs() {
  return yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
    .option('start', {
      type: 'string',
      description: 'Start date (YYYY-MM-DD)',
      default: '2025-01-01'
    })
    .option('end', {
      type: 'string',
      description: 'End date (YYYY-MM-DD)',
      default: '2025-12-31'
    })
    .option('timeframe', {
      type: 'string',
      description: 'Target timeframe',
      default: '3m',
      choices: ['1m', '3m', '5m', '15m']
    })
    .option('output', {
      type: 'string',
      description: 'Output JSON file',
      default: 'pattern-analysis-results.json'
    })
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      description: 'Verbose output',
      default: false
    })
    .help()
    .parse();
}

/**
 * Calculate forward returns for a pattern occurrence
 */
function calculateForwardReturns(candles, patternIndex, side) {
  const entry = candles[patternIndex];
  const entryPrice = entry.close;
  const direction = side === 'long' ? 1 : -1;

  const returns = {
    entryPrice,
    forward_1bar: null,
    forward_2bar: null,
    forward_3bar: null,
    forward_5bar: null,
    forward_10bar: null,
    maxFavorable: 0,    // MFE
    maxAdverse: 0       // MAE
  };

  // Calculate forward returns at each interval
  const intervals = [1, 2, 3, 5, 10];

  for (const bars of intervals) {
    const targetIndex = patternIndex + bars;
    if (targetIndex < candles.length) {
      const futureCandle = candles[targetIndex];
      returns[`forward_${bars}bar`] = (futureCandle.close - entryPrice) * direction;
    }
  }

  // Calculate MFE and MAE over 10 bars
  for (let i = patternIndex + 1; i <= Math.min(patternIndex + 10, candles.length - 1); i++) {
    const candle = candles[i];

    // For long: MFE is high - entry, MAE is entry - low
    // For short: MFE is entry - low, MAE is high - entry
    if (side === 'long') {
      returns.maxFavorable = Math.max(returns.maxFavorable, candle.high - entryPrice);
      returns.maxAdverse = Math.min(returns.maxAdverse, candle.low - entryPrice);
    } else {
      returns.maxFavorable = Math.max(returns.maxFavorable, entryPrice - candle.low);
      returns.maxAdverse = Math.min(returns.maxAdverse, entryPrice - candle.high);
    }
  }

  return returns;
}

/**
 * Find swing points in candles
 */
function findSwingLows(candles, lookback = 3) {
  const swingLows = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    let isSwingLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low <= candle.low) {
        isSwingLow = false;
        break;
      }
    }

    if (isSwingLow) {
      swingLows.push({ price: candle.low, timestamp: candle.timestamp, index: i });
    }
  }

  return swingLows;
}

function findSwingHighs(candles, lookback = 3) {
  const swingHighs = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    let isSwingHigh = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candle.high) {
        isSwingHigh = false;
        break;
      }
    }

    if (isSwingHigh) {
      swingHighs.push({ price: candle.high, timestamp: candle.timestamp, index: i });
    }
  }

  return swingHighs;
}

/**
 * Calculate average volume over lookback period
 */
function calculateAvgVolume(candles, endIndex, lookback = 10) {
  const startIndex = Math.max(0, endIndex - lookback);
  let sum = 0;
  let count = 0;

  for (let i = startIndex; i < endIndex; i++) {
    sum += candles[i].volume;
    count++;
  }

  return count > 0 ? sum / count : 0;
}

/**
 * Get session from timestamp
 */
function getSession(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });

  const [hourStr, minStr] = estString.split(':');
  const hour = parseInt(hourStr);
  const min = parseInt(minStr);
  const timeDecimal = hour + min / 60;

  if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
  if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
  if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
  return 'afterhours';
}

/**
 * Scan candles for all pattern occurrences
 */
function scanPatterns(candles, verbose = false) {
  const patternOccurrences = [];
  const swingLookback = 5;

  console.log(`\n📊 Scanning ${candles.length} candles for patterns...`);

  // Precompute swing points in chunks for efficiency
  const allSwingLows = findSwingLows(candles, swingLookback);
  const allSwingHighs = findSwingHighs(candles, swingLookback);

  // Need at least 20 candles of context and 10 forward
  for (let i = 20; i < candles.length - 10; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    // Build context for this candle
    const recentCandles = candles.slice(i - 20, i + 1);
    const avgVolume = calculateAvgVolume(candles, i);

    // Get recent swing points (within last 30 candles)
    const recentSwingLows = allSwingLows.filter(s =>
      s.index < i && s.index >= i - 30
    );
    const recentSwingHighs = allSwingHighs.filter(s =>
      s.index < i && s.index >= i - 30
    );

    const context = {
      candles: recentCandles,
      oldest: candles[i - 2],
      avgVolume,
      swingLows: recentSwingLows,
      swingHighs: recentSwingHighs,
      minBodyRatio: 0.5,
      minWickRatio: 0.3,
      maxSweepBars: 2,
      minGapPoints: 0.5
    };

    // Check each pattern
    for (const [patternName, pattern] of Object.entries(PATTERNS)) {
      try {
        const detected = pattern.detect(current, previous, context);

        if (detected) {
          // Determine side
          let side = pattern.side;
          if (side === 'neutral' && typeof pattern.getDirection === 'function') {
            side = pattern.getDirection(current, previous, context);
          }
          if (!side || side === 'neutral') {
            side = current.close > current.open ? 'long' : 'short';
          }

          // Calculate forward returns
          const returns = calculateForwardReturns(candles, i, side);

          // Get pattern strength
          const strength = typeof pattern.getStrength === 'function'
            ? pattern.getStrength(current, previous, context)
            : 0.5;

          // Record occurrence
          const occurrence = {
            pattern: patternName,
            side,
            timestamp: new Date(current.timestamp).toISOString(),
            entryPrice: returns.entryPrice,
            strength,
            forward_1bar: returns.forward_1bar,
            forward_2bar: returns.forward_2bar,
            forward_3bar: returns.forward_3bar,
            forward_5bar: returns.forward_5bar,
            forward_10bar: returns.forward_10bar,
            maxFavorable: returns.maxFavorable,
            maxAdverse: returns.maxAdverse,
            volume: current.volume,
            avgVolume,
            volumeRatio: avgVolume > 0 ? current.volume / avgVolume : 0,
            hourOfDay: new Date(current.timestamp).getUTCHours(),
            dayOfWeek: new Date(current.timestamp).getUTCDay(),
            session: getSession(current.timestamp),

            // Context data for later analysis
            swept_level: context.sweptLevel,
            sweep_depth: context.sweepDepth,
            wick_ratio: context.wickRatio
          };

          patternOccurrences.push(occurrence);

          if (verbose) {
            console.log(`  [${occurrence.timestamp}] ${patternName} (${side}) @ ${returns.entryPrice} - 3bar: ${returns.forward_3bar?.toFixed(2) || 'N/A'}`);
          }
        }
      } catch (error) {
        // Pattern detection error - skip
      }
    }

    // Progress indicator
    if (i % 1000 === 0) {
      const progress = ((i / candles.length) * 100).toFixed(1);
      process.stdout.write(`\r  Progress: ${progress}% (${patternOccurrences.length} patterns found)`);
    }
  }

  console.log(`\n✅ Found ${patternOccurrences.length} total pattern occurrences`);

  return patternOccurrences;
}

/**
 * Generate summary statistics for each pattern
 */
function generateSummary(occurrences) {
  const summary = {};

  // Group by pattern
  const byPattern = {};
  for (const occ of occurrences) {
    if (!byPattern[occ.pattern]) {
      byPattern[occ.pattern] = [];
    }
    byPattern[occ.pattern].push(occ);
  }

  // Calculate stats for each pattern
  for (const [patternName, patternOccs] of Object.entries(byPattern)) {
    const stats = {
      count: patternOccs.length,
      longCount: patternOccs.filter(o => o.side === 'long').length,
      shortCount: patternOccs.filter(o => o.side === 'short').length,

      // Win rates at different targets
      winRate2pt: 0,
      winRate3pt: 0,

      // Average forward returns
      avgForward1: 0,
      avgForward2: 0,
      avgForward3: 0,
      avgForward5: 0,
      avgForward10: 0,

      // MFE/MAE
      avgMFE: 0,
      avgMAE: 0,

      // Best time/day
      byHour: {},
      byDay: {},
      bySession: {}
    };

    // Calculate averages
    let sumForward1 = 0, sumForward2 = 0, sumForward3 = 0, sumForward5 = 0, sumForward10 = 0;
    let sumMFE = 0, sumMAE = 0;
    let countForward1 = 0, countForward2 = 0, countForward3 = 0, countForward5 = 0, countForward10 = 0;
    let wins2pt = 0, wins3pt = 0;

    for (const occ of patternOccs) {
      if (occ.forward_1bar !== null) { sumForward1 += occ.forward_1bar; countForward1++; }
      if (occ.forward_2bar !== null) { sumForward2 += occ.forward_2bar; countForward2++; }
      if (occ.forward_3bar !== null) { sumForward3 += occ.forward_3bar; countForward3++; }
      if (occ.forward_5bar !== null) { sumForward5 += occ.forward_5bar; countForward5++; }
      if (occ.forward_10bar !== null) { sumForward10 += occ.forward_10bar; countForward10++; }

      sumMFE += occ.maxFavorable;
      sumMAE += occ.maxAdverse;

      // Win rate: reached target before stop (simplified: MFE >= target)
      if (occ.maxFavorable >= 2) wins2pt++;
      if (occ.maxFavorable >= 3) wins3pt++;

      // By hour
      const hour = occ.hourOfDay;
      if (!stats.byHour[hour]) {
        stats.byHour[hour] = { count: 0, avgReturn3: 0, wins: 0 };
      }
      stats.byHour[hour].count++;
      if (occ.forward_3bar !== null) {
        stats.byHour[hour].avgReturn3 = (stats.byHour[hour].avgReturn3 * (stats.byHour[hour].count - 1) + occ.forward_3bar) / stats.byHour[hour].count;
      }
      if (occ.maxFavorable >= 2) stats.byHour[hour].wins++;

      // By day
      const day = occ.dayOfWeek;
      if (!stats.byDay[day]) {
        stats.byDay[day] = { count: 0, avgReturn3: 0, wins: 0 };
      }
      stats.byDay[day].count++;
      if (occ.forward_3bar !== null) {
        stats.byDay[day].avgReturn3 = (stats.byDay[day].avgReturn3 * (stats.byDay[day].count - 1) + occ.forward_3bar) / stats.byDay[day].count;
      }
      if (occ.maxFavorable >= 2) stats.byDay[day].wins++;

      // By session
      const session = occ.session;
      if (!stats.bySession[session]) {
        stats.bySession[session] = { count: 0, avgReturn3: 0, wins: 0 };
      }
      stats.bySession[session].count++;
      if (occ.forward_3bar !== null) {
        stats.bySession[session].avgReturn3 = (stats.bySession[session].avgReturn3 * (stats.bySession[session].count - 1) + occ.forward_3bar) / stats.bySession[session].count;
      }
      if (occ.maxFavorable >= 2) stats.bySession[session].wins++;
    }

    stats.avgForward1 = countForward1 > 0 ? sumForward1 / countForward1 : 0;
    stats.avgForward2 = countForward2 > 0 ? sumForward2 / countForward2 : 0;
    stats.avgForward3 = countForward3 > 0 ? sumForward3 / countForward3 : 0;
    stats.avgForward5 = countForward5 > 0 ? sumForward5 / countForward5 : 0;
    stats.avgForward10 = countForward10 > 0 ? sumForward10 / countForward10 : 0;
    stats.avgMFE = patternOccs.length > 0 ? sumMFE / patternOccs.length : 0;
    stats.avgMAE = patternOccs.length > 0 ? sumMAE / patternOccs.length : 0;
    stats.winRate2pt = patternOccs.length > 0 ? (wins2pt / patternOccs.length) * 100 : 0;
    stats.winRate3pt = patternOccs.length > 0 ? (wins3pt / patternOccs.length) * 100 : 0;

    // Find best hour and day
    let bestHour = null, bestHourReturn = -Infinity;
    for (const [hour, data] of Object.entries(stats.byHour)) {
      if (data.count >= 10 && data.avgReturn3 > bestHourReturn) {
        bestHourReturn = data.avgReturn3;
        bestHour = parseInt(hour);
      }
    }
    stats.bestHour = bestHour;

    let bestDay = null, bestDayReturn = -Infinity;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const [day, data] of Object.entries(stats.byDay)) {
      if (data.count >= 10 && data.avgReturn3 > bestDayReturn) {
        bestDayReturn = data.avgReturn3;
        bestDay = dayNames[parseInt(day)];
      }
    }
    stats.bestDay = bestDay;

    summary[patternName] = stats;
  }

  return summary;
}

/**
 * Print summary table to console
 */
function printSummaryTable(summary) {
  console.log('\n' + '='.repeat(140));
  console.log('PATTERN ANALYSIS SUMMARY');
  console.log('='.repeat(140));

  // Sort by win rate
  const sorted = Object.entries(summary)
    .sort((a, b) => b[1].winRate2pt - a[1].winRate2pt);

  console.log(
    'Pattern'.padEnd(25) +
    'Count'.padStart(8) +
    'Win@2pt'.padStart(10) +
    'Win@3pt'.padStart(10) +
    'Avg 3bar'.padStart(10) +
    'Avg MFE'.padStart(10) +
    'Avg MAE'.padStart(10) +
    'Best Hr'.padStart(10) +
    'Best Day'.padStart(10) +
    'Best Session'.padStart(15)
  );
  console.log('-'.repeat(140));

  for (const [name, stats] of sorted) {
    // Find best session
    let bestSession = 'N/A';
    let bestSessionReturn = -Infinity;
    for (const [session, data] of Object.entries(stats.bySession)) {
      if (data.count >= 5 && data.avgReturn3 > bestSessionReturn) {
        bestSessionReturn = data.avgReturn3;
        bestSession = session;
      }
    }

    console.log(
      name.padEnd(25) +
      stats.count.toString().padStart(8) +
      `${stats.winRate2pt.toFixed(1)}%`.padStart(10) +
      `${stats.winRate3pt.toFixed(1)}%`.padStart(10) +
      stats.avgForward3.toFixed(2).padStart(10) +
      stats.avgMFE.toFixed(2).padStart(10) +
      stats.avgMAE.toFixed(2).padStart(10) +
      (stats.bestHour !== null ? `${stats.bestHour}:00` : 'N/A').padStart(10) +
      (stats.bestDay || 'N/A').padStart(10) +
      bestSession.padStart(15)
    );
  }

  console.log('='.repeat(140));
}

/**
 * Main execution
 */
async function main() {
  const args = await parseArgs();

  console.log('🔍 Micro-Structure Pattern Analysis');
  console.log('='.repeat(50));
  console.log(`📅 Date Range: ${args.start} → ${args.end}`);
  console.log(`⏱️  Timeframe: ${args.timeframe}`);
  console.log(`📁 Output: ${args.output}`);

  // Load configuration
  const configPath = path.join(__dirname, '..', 'src', 'config', 'default.json');
  const defaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Initialize loaders
  const csvLoader = new CSVLoader(dataDir, defaultConfig);
  const aggregator = new CandleAggregator();

  // Load 1-minute data
  console.log('\n📥 Loading OHLCV data...');
  const startDate = new Date(args.start);
  const endDate = new Date(args.end);

  const ohlcvResult = await csvLoader.loadOHLCVData('NQ', startDate, endDate);
  const candles1m = ohlcvResult.candles;
  console.log(`  Loaded ${candles1m.length} 1-minute candles`);

  // Aggregate to target timeframe
  console.log(`\n📊 Aggregating to ${args.timeframe}...`);
  const candles = aggregator.aggregate(candles1m, args.timeframe);
  console.log(`  Generated ${candles.length} ${args.timeframe} candles`);

  // Scan for patterns
  const occurrences = scanPatterns(candles, args.verbose);

  // Generate summary
  const summary = generateSummary(occurrences);

  // Print summary table
  printSummaryTable(summary);

  // Save results
  const results = {
    config: {
      startDate: args.start,
      endDate: args.end,
      timeframe: args.timeframe,
      totalCandles: candles.length
    },
    summary,
    occurrences
  };

  const outputPath = path.join(__dirname, args.output);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n📁 Results saved to ${outputPath}`);

  // Print actionable insights
  console.log('\n💡 ACTIONABLE INSIGHTS');
  console.log('-'.repeat(50));

  // Top patterns by win rate
  const topPatterns = Object.entries(summary)
    .filter(([_, stats]) => stats.count >= 50)  // Minimum sample size
    .sort((a, b) => b[1].winRate2pt - a[1].winRate2pt)
    .slice(0, 5);

  console.log('\nTop 5 patterns by win rate (min 50 occurrences):');
  for (const [name, stats] of topPatterns) {
    console.log(`  • ${name}: ${stats.winRate2pt.toFixed(1)}% win rate, ${stats.avgForward3.toFixed(2)} avg 3-bar return`);
  }

  // Best patterns by average return
  const bestByReturn = Object.entries(summary)
    .filter(([_, stats]) => stats.count >= 50)
    .sort((a, b) => b[1].avgForward3 - a[1].avgForward3)
    .slice(0, 5);

  console.log('\nTop 5 patterns by average 3-bar return:');
  for (const [name, stats] of bestByReturn) {
    console.log(`  • ${name}: ${stats.avgForward3.toFixed(2)} pts avg return, ${stats.winRate2pt.toFixed(1)}% win rate`);
  }
}

main().catch(console.error);
