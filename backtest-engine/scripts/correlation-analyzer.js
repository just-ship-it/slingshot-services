#!/usr/bin/env node

/**
 * Correlation Analyzer
 *
 * Analyzes backtest trade results and correlates with contextual data
 * (IV, LT patterns, GEX regimes, time patterns) to find tradeable patterns.
 *
 * Usage:
 *   node scripts/correlation-analyzer.js [options]
 *
 * Options:
 *   --results-dir <path>  Directory with optimization results
 *   --data-dir <path>     Directory with contextual data
 *   --output <path>       Output file for analysis
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// ========================================
// CONFIGURATION
// ========================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    resultsDir: path.join(projectRoot, 'results', 'optimization-2025'),
    dataDir: path.join(projectRoot, 'data'),
    outputDir: path.join(projectRoot, 'results', 'optimization-2025', 'analysis'),
    topN: 20 // Analyze top N configurations per strategy
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--results-dir':
        config.resultsDir = args[++i];
        break;
      case '--data-dir':
        config.dataDir = args[++i];
        break;
      case '--output':
        config.outputDir = args[++i];
        break;
      case '--top-n':
        config.topN = parseInt(args[++i], 10);
        break;
    }
  }

  return config;
}

// ========================================
// DATA LOADERS
// ========================================

function loadGexLevels(dataDir) {
  const gexPath = path.join(dataDir, 'gex', 'NQ_gex_levels.csv');
  if (!fs.existsSync(gexPath)) {
    console.log('Warning: GEX levels file not found');
    return new Map();
  }

  const data = fs.readFileSync(gexPath, 'utf-8');
  const lines = data.trim().split('\n');
  const gexByDate = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const date = parts[0];
    gexByDate.set(date, {
      gammaFlip: parseFloat(parts[1]) || 0,
      putWall1: parseFloat(parts[2]) || 0,
      putWall2: parseFloat(parts[3]) || 0,
      putWall3: parseFloat(parts[4]) || 0,
      callWall1: parseFloat(parts[5]) || 0,
      callWall2: parseFloat(parts[6]) || 0,
      callWall3: parseFloat(parts[7]) || 0,
      totalGex: parseFloat(parts[9]) || 0,
      regime: parts[10]?.trim() || 'unknown'
    });
  }

  return gexByDate;
}

function loadLiquidityLevels(dataDir) {
  const ltPath = path.join(dataDir, 'liquidity', 'NQ_liquidity_levels.csv');
  if (!fs.existsSync(ltPath)) {
    console.log('Warning: Liquidity levels file not found');
    return new Map();
  }

  const data = fs.readFileSync(ltPath, 'utf-8');
  const lines = data.trim().split('\n');
  const ltByTimestamp = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const datetime = parts[0];
    const sentiment = parts[2]?.trim();
    const levels = [
      parseFloat(parts[3]) || 0,
      parseFloat(parts[4]) || 0,
      parseFloat(parts[5]) || 0,
      parseFloat(parts[6]) || 0,
      parseFloat(parts[7]) || 0
    ];

    // Calculate ordering
    let ordering = 'MIXED';
    const ascending = levels.every((v, i, a) => i === 0 || v >= a[i-1]);
    const descending = levels.every((v, i, a) => i === 0 || v <= a[i-1]);
    if (ascending && !descending) ordering = 'ASCENDING';
    else if (descending && !ascending) ordering = 'DESCENDING';

    // Calculate spacing
    const diffs = [];
    for (let j = 1; j < levels.length; j++) {
      diffs.push(Math.abs(levels[j] - levels[j-1]));
    }
    const avgSpacing = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    let spacing = 'MEDIUM';
    if (avgSpacing < 50) spacing = 'TIGHT';
    else if (avgSpacing > 150) spacing = 'WIDE';

    ltByTimestamp.set(datetime, {
      sentiment,
      levels,
      ordering,
      spacing,
      avgSpacing
    });
  }

  return ltByTimestamp;
}

function loadIvData(dataDir) {
  const ivPath = path.join(dataDir, 'iv', 'qqq_atm_iv_15m.csv');
  if (!fs.existsSync(ivPath)) {
    console.log('Warning: IV data file not found');
    return new Map();
  }

  const data = fs.readFileSync(ivPath, 'utf-8');
  const lines = data.trim().split('\n');
  const ivByTimestamp = new Map();

  // Calculate percentiles
  const allIvs = [];
  const rawData = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const timestamp = parts[0];
    const iv = parseFloat(parts[1]) || 0;
    const spotPrice = parseFloat(parts[2]) || 0;
    const callIv = parseFloat(parts[4]) || 0;
    const putIv = parseFloat(parts[5]) || 0;

    allIvs.push(iv);
    rawData.push({ timestamp, iv, spotPrice, callIv, putIv });
  }

  // Sort IVs for percentile calculation
  const sortedIvs = [...allIvs].sort((a, b) => a - b);

  for (const { timestamp, iv, spotPrice, callIv, putIv } of rawData) {
    const rank = sortedIvs.findIndex(v => v >= iv);
    const percentile = (rank / sortedIvs.length) * 100;

    let bucket = '25-50';
    if (percentile < 25) bucket = '0-25';
    else if (percentile >= 75) bucket = '75-100';
    else if (percentile >= 50) bucket = '50-75';

    ivByTimestamp.set(timestamp, {
      iv,
      percentile,
      bucket,
      spotPrice,
      callIv,
      putIv,
      skew: putIv - callIv
    });
  }

  return ivByTimestamp;
}

function loadTradeResults(resultsDir, topN) {
  const strategiesDir = path.join(resultsDir, 'strategies');
  if (!fs.existsSync(strategiesDir)) {
    console.log('Error: Strategies directory not found');
    return [];
  }

  const allTrades = [];
  const strategyDirs = fs.readdirSync(strategiesDir);

  for (const strategyDir of strategyDirs) {
    const strategyPath = path.join(strategiesDir, strategyDir);
    if (!fs.statSync(strategyPath).isDirectory()) continue;

    const files = fs.readdirSync(strategyPath).filter(f => f.endsWith('.json'));

    // Load all results and sort by performance
    const results = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(strategyPath, file), 'utf-8'));
        const perf = data.performance?.basic;
        if (perf && data.trades?.length > 0) {
          results.push({
            file,
            strategy: strategyDir,
            config: data.config,
            trades: data.trades,
            performance: perf
          });
        }
      } catch (e) {
        // Skip invalid files
      }
    }

    // Sort by P&L and take top N
    results.sort((a, b) => (b.performance?.totalPnL || 0) - (a.performance?.totalPnL || 0));
    const topResults = results.slice(0, topN);

    for (const result of topResults) {
      for (const trade of result.trades) {
        allTrades.push({
          ...trade,
          strategy: result.strategy,
          configFile: result.file
        });
      }
    }
  }

  console.log(`Loaded ${allTrades.length} trades from top ${topN} configs per strategy`);
  return allTrades;
}

// ========================================
// ANALYSIS FUNCTIONS
// ========================================

function getTimestampDate(timestamp) {
  if (typeof timestamp === 'number') {
    return new Date(timestamp).toISOString().split('T')[0];
  }
  if (typeof timestamp === 'string') {
    return timestamp.split('T')[0];
  }
  return null;
}

function getTimestampHour(timestamp) {
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  return date.getUTCHours();
}

function getDayOfWeek(timestamp) {
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[date.getUTCDay()];
}

function getSession(hourUTC) {
  if (hourUTC >= 0 && hourUTC < 6) return 'overnight';
  if (hourUTC >= 6 && hourUTC < 14.5) return 'premarket';
  if (hourUTC >= 14.5 && hourUTC < 21) return 'rth';
  return 'afterhours';
}

function findNearestData(timestamp, dataMap, toleranceMinutes = 15) {
  const ts = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  const tsTime = ts.getTime();

  // Try exact match first
  const isoKey = ts.toISOString().replace('.000Z', 'Z');
  if (dataMap.has(isoKey)) return dataMap.get(isoKey);

  // Try without milliseconds
  const shortKey = ts.toISOString().split('.')[0] + 'Z';
  if (dataMap.has(shortKey)) return dataMap.get(shortKey);

  // Find nearest within tolerance
  let nearest = null;
  let minDiff = toleranceMinutes * 60 * 1000;

  for (const [key, value] of dataMap.entries()) {
    const keyTime = new Date(key).getTime();
    const diff = Math.abs(keyTime - tsTime);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = value;
    }
  }

  return nearest;
}

function analyzeByDimension(trades, getDimensionValue, dimensionName) {
  const buckets = new Map();

  for (const trade of trades) {
    const dimValue = getDimensionValue(trade);
    if (dimValue === null || dimValue === undefined) continue;

    if (!buckets.has(dimValue)) {
      buckets.set(dimValue, {
        trades: [],
        wins: 0,
        losses: 0,
        totalPnL: 0,
        totalPoints: 0
      });
    }

    const bucket = buckets.get(dimValue);
    bucket.trades.push(trade);

    const isWin = (trade.netPnL || trade.pointsPnL || 0) > 0;
    if (isWin) bucket.wins++;
    else bucket.losses++;

    bucket.totalPnL += trade.netPnL || 0;
    bucket.totalPoints += trade.pointsPnL || 0;
  }

  // Calculate statistics
  const results = [];
  for (const [dimValue, bucket] of buckets.entries()) {
    const total = bucket.wins + bucket.losses;
    if (total < 10) continue; // Minimum sample size

    results.push({
      [dimensionName]: dimValue,
      trades: total,
      winRate: (bucket.wins / total * 100).toFixed(2),
      avgPnL: (bucket.totalPnL / total).toFixed(2),
      avgPoints: (bucket.totalPoints / total).toFixed(2),
      totalPnL: bucket.totalPnL.toFixed(2),
      wins: bucket.wins,
      losses: bucket.losses
    });
  }

  // Sort by win rate descending
  results.sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate));

  return results;
}

function calculateStatisticalSignificance(observed, expected, n) {
  // Chi-squared test approximation
  if (expected === 0 || n < 30) return 1.0;

  const chiSquared = Math.pow(observed - expected, 2) / expected;
  // Simple approximation for p-value
  const pValue = Math.exp(-chiSquared / 2);
  return pValue;
}

function findPatterns(trades, gexData, ltData, ivData) {
  const patterns = [];

  // Pattern 1: GEX Regime + Side combinations
  const regimeSideAnalysis = new Map();
  for (const trade of trades) {
    const date = getTimestampDate(trade.entryTime || trade.signalTime);
    const gex = gexData.get(date);
    if (!gex) continue;

    const key = `${gex.regime}_${trade.side}`;
    if (!regimeSideAnalysis.has(key)) {
      regimeSideAnalysis.set(key, { wins: 0, total: 0, pnl: 0 });
    }
    const bucket = regimeSideAnalysis.get(key);
    bucket.total++;
    bucket.pnl += trade.netPnL || 0;
    if ((trade.netPnL || trade.pointsPnL || 0) > 0) bucket.wins++;
  }

  for (const [key, stats] of regimeSideAnalysis.entries()) {
    if (stats.total < 20) continue;
    const [regime, side] = key.split('_');
    const winRate = stats.wins / stats.total;
    const avgPnL = stats.pnl / stats.total;

    // Check if significantly different from baseline (50%)
    const pValue = calculateStatisticalSignificance(stats.wins, stats.total * 0.5, stats.total);

    if (winRate > 0.55 && pValue < 0.05) {
      patterns.push({
        type: 'GEX_REGIME_SIDE',
        conditions: { gex_regime: regime, side },
        performance: {
          winRate: (winRate * 100).toFixed(1),
          avgPnL: avgPnL.toFixed(2),
          sampleSize: stats.total,
          pValue: pValue.toFixed(4)
        },
        description: `${side.toUpperCase()} trades in ${regime} GEX regime`
      });
    }
  }

  // Pattern 2: LT Sentiment + Ordering combinations
  const ltPatternAnalysis = new Map();
  for (const trade of trades) {
    const lt = findNearestData(trade.entryTime || trade.signalTime, ltData);
    if (!lt) continue;

    const key = `${lt.sentiment}_${lt.ordering}_${lt.spacing}`;
    if (!ltPatternAnalysis.has(key)) {
      ltPatternAnalysis.set(key, { wins: 0, total: 0, pnl: 0 });
    }
    const bucket = ltPatternAnalysis.get(key);
    bucket.total++;
    bucket.pnl += trade.netPnL || 0;
    if ((trade.netPnL || trade.pointsPnL || 0) > 0) bucket.wins++;
  }

  for (const [key, stats] of ltPatternAnalysis.entries()) {
    if (stats.total < 20) continue;
    const [sentiment, ordering, spacing] = key.split('_');
    const winRate = stats.wins / stats.total;
    const avgPnL = stats.pnl / stats.total;
    const pValue = calculateStatisticalSignificance(stats.wins, stats.total * 0.5, stats.total);

    if (winRate > 0.55 && pValue < 0.1) {
      patterns.push({
        type: 'LT_CONFIGURATION',
        conditions: { lt_sentiment: sentiment, lt_ordering: ordering, lt_spacing: spacing },
        performance: {
          winRate: (winRate * 100).toFixed(1),
          avgPnL: avgPnL.toFixed(2),
          sampleSize: stats.total,
          pValue: pValue.toFixed(4)
        },
        description: `${sentiment} sentiment with ${ordering} ordering and ${spacing} spacing`
      });
    }
  }

  // Pattern 3: IV Bucket + GEX Regime combinations
  const ivGexAnalysis = new Map();
  for (const trade of trades) {
    const date = getTimestampDate(trade.entryTime || trade.signalTime);
    const gex = gexData.get(date);
    const iv = findNearestData(trade.entryTime || trade.signalTime, ivData);
    if (!gex || !iv) continue;

    const key = `${iv.bucket}_${gex.regime}`;
    if (!ivGexAnalysis.has(key)) {
      ivGexAnalysis.set(key, { wins: 0, total: 0, pnl: 0 });
    }
    const bucket = ivGexAnalysis.get(key);
    bucket.total++;
    bucket.pnl += trade.netPnL || 0;
    if ((trade.netPnL || trade.pointsPnL || 0) > 0) bucket.wins++;
  }

  for (const [key, stats] of ivGexAnalysis.entries()) {
    if (stats.total < 15) continue;
    const [ivBucket, regime] = key.split('_');
    const winRate = stats.wins / stats.total;
    const avgPnL = stats.pnl / stats.total;
    const pValue = calculateStatisticalSignificance(stats.wins, stats.total * 0.5, stats.total);

    if (winRate > 0.55 && pValue < 0.15) {
      patterns.push({
        type: 'IV_GEX_CONFLUENCE',
        conditions: { iv_bucket: ivBucket, gex_regime: regime },
        performance: {
          winRate: (winRate * 100).toFixed(1),
          avgPnL: avgPnL.toFixed(2),
          sampleSize: stats.total,
          pValue: pValue.toFixed(4)
        },
        description: `IV percentile ${ivBucket} with ${regime} GEX regime`
      });
    }
  }

  // Pattern 4: Time-based patterns (Session + Day of Week)
  const timeAnalysis = new Map();
  for (const trade of trades) {
    const hour = getTimestampHour(trade.entryTime || trade.signalTime);
    const session = getSession(hour);
    const dow = getDayOfWeek(trade.entryTime || trade.signalTime);

    const key = `${session}_${dow}`;
    if (!timeAnalysis.has(key)) {
      timeAnalysis.set(key, { wins: 0, total: 0, pnl: 0 });
    }
    const bucket = timeAnalysis.get(key);
    bucket.total++;
    bucket.pnl += trade.netPnL || 0;
    if ((trade.netPnL || trade.pointsPnL || 0) > 0) bucket.wins++;
  }

  for (const [key, stats] of timeAnalysis.entries()) {
    if (stats.total < 15) continue;
    const [session, dow] = key.split('_');
    const winRate = stats.wins / stats.total;
    const avgPnL = stats.pnl / stats.total;
    const pValue = calculateStatisticalSignificance(stats.wins, stats.total * 0.5, stats.total);

    if (winRate > 0.55 && pValue < 0.15) {
      patterns.push({
        type: 'TIME_PATTERN',
        conditions: { session, dayOfWeek: dow },
        performance: {
          winRate: (winRate * 100).toFixed(1),
          avgPnL: avgPnL.toFixed(2),
          sampleSize: stats.total,
          pValue: pValue.toFixed(4)
        },
        description: `${session} session on ${dow}`
      });
    }
  }

  // Sort patterns by win rate
  patterns.sort((a, b) => parseFloat(b.performance.winRate) - parseFloat(a.performance.winRate));

  return patterns;
}

// ========================================
// MAIN EXECUTION
// ========================================

async function main() {
  const config = parseArgs();

  console.log('========================================');
  console.log(' CORRELATION ANALYZER');
  console.log('========================================\n');

  console.log(`Results Dir: ${config.resultsDir}`);
  console.log(`Data Dir:    ${config.dataDir}`);
  console.log(`Output:      ${config.outputDir}`);
  console.log(`Top N:       ${config.topN} configs per strategy\n`);

  // Create output directory
  fs.mkdirSync(config.outputDir, { recursive: true });

  // Load contextual data
  console.log('Loading contextual data...');
  const gexData = loadGexLevels(config.dataDir);
  console.log(`  GEX levels: ${gexData.size} dates`);

  const ltData = loadLiquidityLevels(config.dataDir);
  console.log(`  LT levels: ${ltData.size} timestamps`);

  const ivData = loadIvData(config.dataDir);
  console.log(`  IV data: ${ivData.size} timestamps`);

  // Load trade results
  console.log('\nLoading trade results...');
  const trades = loadTradeResults(config.resultsDir, config.topN);

  if (trades.length === 0) {
    console.log('No trades found. Run master-optimizer.js first.');
    return;
  }

  // Analyze by dimensions
  console.log('\n========================================');
  console.log(' DIMENSION ANALYSIS');
  console.log('========================================\n');

  // By Strategy
  const byStrategy = analyzeByDimension(trades, t => t.strategy, 'strategy');
  console.log('BY STRATEGY:');
  console.log('Strategy                    | Trades | Win%  | Avg P&L');
  console.log('─'.repeat(60));
  for (const row of byStrategy.slice(0, 10)) {
    console.log(`${row.strategy.padEnd(27)} | ${String(row.trades).padStart(6)} | ${row.winRate.padStart(5)}% | $${row.avgPnL.padStart(8)}`);
  }

  // By Side
  console.log('\nBY SIDE:');
  const bySide = analyzeByDimension(trades, t => t.side, 'side');
  for (const row of bySide) {
    console.log(`${row.side.padEnd(10)} | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // By Exit Reason
  console.log('\nBY EXIT REASON:');
  const byExit = analyzeByDimension(trades, t => t.exitReason, 'exitReason');
  for (const row of byExit.slice(0, 8)) {
    console.log(`${(row.exitReason || 'unknown').padEnd(20)} | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // By Hour (UTC)
  console.log('\nBY HOUR (UTC):');
  const byHour = analyzeByDimension(trades, t => getTimestampHour(t.entryTime || t.signalTime), 'hour');
  byHour.sort((a, b) => parseInt(a.hour) - parseInt(b.hour));
  for (const row of byHour) {
    console.log(`${String(row.hour).padStart(2)}:00 UTC | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // By Day of Week
  console.log('\nBY DAY OF WEEK:');
  const byDow = analyzeByDimension(trades, t => getDayOfWeek(t.entryTime || t.signalTime), 'dayOfWeek');
  for (const row of byDow) {
    console.log(`${row.dayOfWeek.padEnd(10)} | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // By Session
  console.log('\nBY SESSION:');
  const bySession = analyzeByDimension(trades, t => {
    const hour = getTimestampHour(t.entryTime || t.signalTime);
    return getSession(hour);
  }, 'session');
  for (const row of bySession) {
    console.log(`${row.session.padEnd(12)} | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // By GEX Regime
  console.log('\nBY GEX REGIME:');
  const byRegime = analyzeByDimension(trades, t => {
    const date = getTimestampDate(t.entryTime || t.signalTime);
    return gexData.get(date)?.regime || 'unknown';
  }, 'gexRegime');
  for (const row of byRegime) {
    console.log(`${row.gexRegime.padEnd(18)} | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // By LT Sentiment
  console.log('\nBY LT SENTIMENT:');
  const bySentiment = analyzeByDimension(trades, t => {
    const lt = findNearestData(t.entryTime || t.signalTime, ltData);
    return lt?.sentiment || 'unknown';
  }, 'ltSentiment');
  for (const row of bySentiment) {
    console.log(`${row.ltSentiment.padEnd(10)} | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // By LT Ordering
  console.log('\nBY LT ORDERING:');
  const byOrdering = analyzeByDimension(trades, t => {
    const lt = findNearestData(t.entryTime || t.signalTime, ltData);
    return lt?.ordering || 'unknown';
  }, 'ltOrdering');
  for (const row of byOrdering) {
    console.log(`${row.ltOrdering.padEnd(12)} | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // By IV Bucket
  console.log('\nBY IV PERCENTILE BUCKET:');
  const byIv = analyzeByDimension(trades, t => {
    const iv = findNearestData(t.entryTime || t.signalTime, ivData);
    return iv?.bucket || 'unknown';
  }, 'ivBucket');
  for (const row of byIv) {
    console.log(`${row.ivBucket.padEnd(10)} | ${row.trades} trades | ${row.winRate}% WR | $${row.avgPnL} avg`);
  }

  // Find patterns
  console.log('\n========================================');
  console.log(' PATTERN DISCOVERY');
  console.log('========================================\n');

  const patterns = findPatterns(trades, gexData, ltData, ivData);

  console.log(`Found ${patterns.length} significant patterns (p < 0.15, WR > 55%):\n`);

  for (let i = 0; i < Math.min(patterns.length, 20); i++) {
    const p = patterns[i];
    console.log(`${i + 1}. [${p.type}] ${p.description}`);
    console.log(`   Win Rate: ${p.performance.winRate}% | Avg P&L: $${p.performance.avgPnL} | n=${p.performance.sampleSize} | p=${p.performance.pValue}`);
    console.log('');
  }

  // Save results
  const analysis = {
    generatedAt: new Date().toISOString(),
    tradeCount: trades.length,
    dimensions: {
      byStrategy,
      bySide,
      byExit,
      byHour,
      byDow,
      bySession,
      byRegime,
      bySentiment,
      byOrdering,
      byIv
    },
    patterns
  };

  const analysisPath = path.join(config.outputDir, 'correlation-analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
  console.log(`\nAnalysis saved to: ${analysisPath}`);

  // Save patterns as tradeable rules
  const tradeablePatterns = patterns.filter(p =>
    parseFloat(p.performance.winRate) > 55 &&
    parseFloat(p.performance.pValue) < 0.10 &&
    parseInt(p.performance.sampleSize) >= 30
  );

  const patternsPath = path.join(config.outputDir, 'tradeable-patterns.json');
  fs.writeFileSync(patternsPath, JSON.stringify(tradeablePatterns, null, 2));
  console.log(`Tradeable patterns saved to: ${patternsPath}`);

  console.log('\n========================================');
  console.log('        ANALYSIS COMPLETE');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
