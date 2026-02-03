/**
 * Regime Identifier Test Harness
 *
 * Standalone testing framework for validating regime identification:
 * - Stability metrics (median duration, flapping rate)
 * - Predictive power validation (forward accuracy)
 * - Visual validation export (TradingView CSV)
 * - Regime distribution analysis
 */

import { RegimeIdentifier, REGIME_PRESETS } from '../shared/indicators/regime-identifier.js';
import { CSVLoader } from './src/data/csv-loader.js';
import { CandleAggregator } from './src/data/candle-aggregator.js';
import fs from 'fs';
import path from 'path';

// Default configuration
const DEFAULT_CONFIG = {
  dataFormat: {
    ohlcv: {
      timestampField: 'ts_event',
      openField: 'open',
      highField: 'high',
      lowField: 'low',
      closeField: 'close',
      volumeField: 'volume',
      symbolField: 'symbol'
    }
  }
};

/**
 * Main test function
 */
async function testRegimeIdentifier(options = {}) {
  const {
    ticker = 'NQ',
    startDate = '2024-01-01',
    endDate = '2024-12-31',
    resolution = '1m',  // '1s' or '1m'
    aggregateTo = '3m', // Target timeframe for regime detection
    outputDir = './results/regime-test-results',
    preset = null       // 'conservative', 'balanced', 'aggressive', 'ultraAggressive'
  } = options;

  // Get preset configuration if specified
  const presetConfig = preset && REGIME_PRESETS[preset] ? REGIME_PRESETS[preset] : {};
  const presetName = preset || 'aggressive (default)';

  console.log('\n🧪 Regime Identifier Test Harness\n');
  console.log('Configuration:');
  console.log(`  Ticker: ${ticker}`);
  console.log(`  Date Range: ${startDate} to ${endDate}`);
  console.log(`  Source Resolution: ${resolution}`);
  console.log(`  Aggregation Target: ${aggregateTo}`);
  console.log(`  Preset: ${presetName}`);
  if (preset && REGIME_PRESETS[preset]) {
    console.log('  Preset Parameters:');
    console.log(`    minRegimeDuration: ${presetConfig.minRegimeDuration}`);
    console.log(`    changeConfidenceThreshold: ${presetConfig.changeConfidenceThreshold}`);
    console.log(`    trendConfidenceThreshold: ${presetConfig.trendConfidenceThreshold}`);
    console.log(`    sessionOpeningMinutes: ${presetConfig.sessionOpeningMinutes}`);
  }
  console.log('');

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Step 1: Load data
  console.log('📊 Step 1: Loading OHLCV data...');
  const dataDir = path.join(process.cwd(), 'data');
  const loader = new CSVLoader(dataDir, DEFAULT_CONFIG);

  const start = new Date(startDate);
  const end = new Date(endDate);

  let candles;
  if (resolution === '1s') {
    const result = await loader.load1SecondOHLCVData(ticker, start, end);
    candles = result.candles;
  } else {
    const result = await loader.loadOHLCVData(ticker, start, end);
    candles = result.candles;
  }

  console.log(`✅ Loaded ${candles.length} candles\n`);

  // Step 2: Aggregate to target timeframe
  console.log(`📊 Step 2: Aggregating to ${aggregateTo}...`);
  const aggregator = new CandleAggregator();
  const aggregatedCandles = aggregator.aggregate(candles, aggregateTo);
  console.log(`✅ Aggregated to ${aggregatedCandles.length} candles\n`);

  // Step 3: Initialize regime identifier
  console.log('📊 Step 3: Initializing regime identifier...');
  const regimeId = new RegimeIdentifier({
    symbol: ticker,
    ...presetConfig  // Apply preset configuration
  });
  console.log('✅ Regime identifier ready\n');

  // Step 4: Process all candles
  console.log('📊 Step 4: Processing candles and identifying regimes...');
  const regimes = [];
  const lookback = 50; // Minimum historical candles needed

  for (let i = lookback; i < aggregatedCandles.length; i++) {
    const historical = aggregatedCandles.slice(Math.max(0, i - lookback), i + 1);
    const current = aggregatedCandles[i];

    const regime = regimeId.identify(current, historical);

    regimes.push({
      timestamp: new Date(current.timestamp).toISOString(),
      timestampMs: current.timestamp,
      regime: regime.regime,
      confidence: regime.confidence,
      transitionState: regime.transitionState,
      candlesInRegime: regime.candlesInRegime,
      price: current.close,
      open: current.open,
      high: current.high,
      low: current.low,
      volume: current.volume,
      // Metadata
      trend: regime.metadata?.structure?.trend,
      trendConfidence: regime.metadata?.structure?.confidence,
      squeeze: regime.metadata?.squeeze?.state,
      atr: regime.metadata?.atr,
      session: regime.metadata?.session
    });

    // Progress indicator
    if ((i - lookback) % 1000 === 0) {
      const pct = ((i - lookback) / (aggregatedCandles.length - lookback) * 100).toFixed(1);
      process.stdout.write(`  Progress: ${pct}%\r`);
    }
  }

  console.log(`✅ Processed ${regimes.length} regime identifications\n`);

  // Step 5: Calculate metrics
  console.log('📊 Step 5: Calculating metrics...\n');

  const stability = calculateStabilityMetrics(regimes, aggregateTo);
  const distribution = calculateRegimeDistribution(regimes);
  const accuracy = validatePredictivePower(regimes, aggregatedCandles, aggregateTo);

  // Step 6: Generate reports
  console.log('📊 Step 6: Generating reports...\n');

  printReport(stability, distribution, accuracy);

  // Step 7: Export results
  console.log('📊 Step 7: Exporting results...');

  const csvPath = path.join(outputDir, `regime-analysis-${ticker}-${startDate}-${endDate}.csv`);
  exportToCSV(regimes, csvPath);
  console.log(`✅ Exported regime data to: ${csvPath}`);

  const reportPath = path.join(outputDir, `regime-report-${ticker}-${startDate}-${endDate}.json`);
  exportReport({
    stability,
    distribution,
    accuracy,
    config: {
      ...options,
      preset: presetName,
      presetParams: presetConfig
    }
  }, reportPath);
  console.log(`✅ Exported report to: ${reportPath}`);

  console.log('\n✅ Test completed successfully!\n');

  return {
    regimes,
    metrics: { stability, distribution, accuracy }
  };
}

/**
 * Calculate stability metrics
 */
function calculateStabilityMetrics(regimes, timeframe) {
  const durations = [];
  let current = regimes[0];
  let count = 1;

  for (let i = 1; i < regimes.length; i++) {
    if (regimes[i].regime === current.regime) {
      count++;
    } else {
      durations.push({
        regime: current.regime,
        durationCandles: count,
        durationMinutes: count * parseTimeframe(timeframe)
      });
      current = regimes[i];
      count = 1;
    }
  }

  // Add final regime
  if (count > 0) {
    durations.push({
      regime: current.regime,
      durationCandles: count,
      durationMinutes: count * parseTimeframe(timeframe)
    });
  }

  // Calculate statistics
  const sorted = durations.map(d => d.durationCandles).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const flappingRate = durations.filter(d => d.durationCandles < 5).length / durations.length;

  return {
    totalRegimes: durations.length,
    medianDurationCandles: median,
    medianDurationMinutes: median * parseTimeframe(timeframe),
    meanDurationCandles: mean.toFixed(2),
    meanDurationMinutes: (mean * parseTimeframe(timeframe)).toFixed(1),
    flappingRate: (flappingRate * 100).toFixed(1) + '%',
    totalTransitions: durations.length,
    durationDistribution: {
      '<5 candles': durations.filter(d => d.durationCandles < 5).length,
      '5-10 candles': durations.filter(d => d.durationCandles >= 5 && d.durationCandles < 10).length,
      '10-20 candles': durations.filter(d => d.durationCandles >= 10 && d.durationCandles < 20).length,
      '20+ candles': durations.filter(d => d.durationCandles >= 20).length
    }
  };
}

/**
 * Calculate regime distribution
 */
function calculateRegimeDistribution(regimes) {
  const counts = {};
  const confidence = {};

  regimes.forEach(r => {
    counts[r.regime] = (counts[r.regime] || 0) + 1;
    if (!confidence[r.regime]) {
      confidence[r.regime] = [];
    }
    confidence[r.regime].push(r.confidence);
  });

  const distribution = {};
  Object.keys(counts).forEach(regime => {
    const avgConfidence = confidence[regime].reduce((a, b) => a + b, 0) / confidence[regime].length;
    distribution[regime] = {
      count: counts[regime],
      percentage: ((counts[regime] / regimes.length) * 100).toFixed(2) + '%',
      avgConfidence: avgConfidence.toFixed(3)
    };
  });

  return distribution;
}

/**
 * Validate predictive power
 */
function validatePredictivePower(regimes, candles, timeframe, lookforward = 10) {
  let correct = 0;
  let total = 0;
  const regimeAccuracy = {};

  const timeframeMinutes = parseTimeframe(timeframe);

  for (let i = 0; i < regimes.length - lookforward; i++) {
    const regime = regimes[i];
    const currentIdx = candles.findIndex(c => c.timestamp === regime.timestampMs);

    if (currentIdx === -1 || currentIdx + lookforward >= candles.length) continue;

    const currentPrice = candles[currentIdx].close;
    const futurePrice = candles[currentIdx + lookforward].close;
    const netMove = futurePrice - currentPrice;
    const atr = regime.atr || 10; // Fallback ATR

    let predicted = false;

    // Check if regime prediction matches future price action
    if (regime.regime === 'STRONG_TRENDING_UP' && netMove > 0) predicted = true;
    if (regime.regime === 'STRONG_TRENDING_DOWN' && netMove < 0) predicted = true;
    if (regime.regime === 'WEAK_TRENDING_UP' && netMove > 0) predicted = true;
    if (regime.regime === 'WEAK_TRENDING_DOWN' && netMove < 0) predicted = true;
    if (regime.regime.startsWith('RANGING') && Math.abs(netMove) < atr * 0.5) predicted = true;
    if (regime.regime === 'BOUNCING_SUPPORT' && netMove > 0) predicted = true;
    if (regime.regime === 'BOUNCING_RESISTANCE' && netMove < 0) predicted = true;

    if (predicted) correct++;
    total++;

    // Track per-regime accuracy
    if (!regimeAccuracy[regime.regime]) {
      regimeAccuracy[regime.regime] = { correct: 0, total: 0 };
    }
    regimeAccuracy[regime.regime].total++;
    if (predicted) regimeAccuracy[regime.regime].correct++;
  }

  // Calculate per-regime accuracy
  const regimeStats = {};
  Object.keys(regimeAccuracy).forEach(regime => {
    const stats = regimeAccuracy[regime];
    regimeStats[regime] = {
      accuracy: ((stats.correct / stats.total) * 100).toFixed(1) + '%',
      correct: stats.correct,
      total: stats.total
    };
  });

  return {
    overallAccuracy: ((correct / total) * 100).toFixed(1) + '%',
    correctPredictions: correct,
    totalPredictions: total,
    lookforwardCandles: lookforward,
    lookforwardMinutes: lookforward * timeframeMinutes,
    perRegime: regimeStats
  };
}

/**
 * Export regimes to CSV
 */
function exportToCSV(regimes, filepath) {
  const headers = [
    'timestamp',
    'regime',
    'confidence',
    'transition_state',
    'candles_in_regime',
    'price',
    'open',
    'high',
    'low',
    'volume',
    'trend',
    'trend_confidence',
    'squeeze',
    'atr',
    'session'
  ];

  const rows = regimes.map(r => [
    r.timestamp,
    r.regime,
    r.confidence,
    r.transitionState,
    r.candlesInRegime,
    r.price,
    r.open,
    r.high,
    r.low,
    r.volume,
    r.trend || '',
    r.trendConfidence || '',
    r.squeeze || '',
    r.atr || '',
    r.session || ''
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  fs.writeFileSync(filepath, csv);
}

/**
 * Export report to JSON
 */
function exportReport(report, filepath) {
  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
}

/**
 * Print report to console
 */
function printReport(stability, distribution, accuracy) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                   STABILITY METRICS                       ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total Regime Transitions:    ${stability.totalTransitions}`);
  console.log(`  Median Duration:             ${stability.medianDurationCandles} candles (${stability.medianDurationMinutes} minutes)`);
  console.log(`  Mean Duration:               ${stability.meanDurationCandles} candles (${stability.meanDurationMinutes} minutes)`);
  console.log(`  Flapping Rate:               ${stability.flappingRate}`);
  console.log('');
  console.log('  Duration Distribution:');
  Object.entries(stability.durationDistribution).forEach(([range, count]) => {
    console.log(`    ${range.padEnd(20)} ${count}`);
  });
  console.log('');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                   REGIME DISTRIBUTION                     ');
  console.log('═══════════════════════════════════════════════════════════');
  Object.entries(distribution).forEach(([regime, stats]) => {
    console.log(`  ${regime.padEnd(30)} ${stats.percentage.padStart(8)} (avg conf: ${stats.avgConfidence})`);
  });
  console.log('');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                   PREDICTIVE ACCURACY                     ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Overall Accuracy:            ${accuracy.overallAccuracy}`);
  console.log(`  Correct Predictions:         ${accuracy.correctPredictions} / ${accuracy.totalPredictions}`);
  console.log(`  Lookforward:                 ${accuracy.lookforwardCandles} candles (${accuracy.lookforwardMinutes} minutes)`);
  console.log('');
  console.log('  Per-Regime Accuracy:');
  Object.entries(accuracy.perRegime).forEach(([regime, stats]) => {
    console.log(`    ${regime.padEnd(30)} ${stats.accuracy.padStart(8)} (${stats.correct}/${stats.total})`);
  });
  console.log('═══════════════════════════════════════════════════════════\n');
}

/**
 * Parse timeframe string to minutes
 */
function parseTimeframe(timeframe) {
  const match = timeframe.match(/^(\d+)([smh])$/);
  if (!match) return 1; // Default to 1 minute

  const value = parseInt(match[1]);
  const unit = match[2];

  if (unit === 's') return value / 60;
  if (unit === 'm') return value;
  if (unit === 'h') return value * 60;

  return 1;
}

/**
 * CLI Entry Point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  // Check for help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Regime Identifier Test Harness

Usage:
  node test-regime-identifier.js [options]

Options:
  --ticker <symbol>       Ticker symbol (default: NQ)
  --startDate <date>      Start date YYYY-MM-DD (default: 2024-01-01)
  --endDate <date>        End date YYYY-MM-DD (default: 2024-12-31)
  --resolution <res>      Source resolution: 1s or 1m (default: 1m)
  --aggregateTo <tf>      Target timeframe: 1m, 3m, 5m (default: 3m)
  --preset <name>         Parameter preset (default: aggressive)
  --outputDir <path>      Output directory (default: ./results/regime-test-results)

Available Presets:
  conservative     - Long regime durations, high confidence required
  balanced         - Middle ground responsiveness
  aggressive       - Fast regime transitions for scalping (DEFAULT)
  ultraAggressive  - Maximum responsiveness (for testing only)

Examples:
  node test-regime-identifier.js --ticker NQ --startDate 2025-01-01 --endDate 2025-12-31
  node test-regime-identifier.js --preset conservative --ticker ES
  node test-regime-identifier.js --preset ultraAggressive --startDate 2025-06-01
`);
    process.exit(0);
  }

  const options = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    const value = args[i + 1];
    options[key] = value;
  }

  testRegimeIdentifier(options)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Test failed:', err);
      process.exit(1);
    });
}

export { testRegimeIdentifier };
