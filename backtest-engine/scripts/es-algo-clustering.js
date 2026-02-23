#!/usr/bin/env node
/**
 * ES Algorithm Clustering
 *
 * Classifies 5-minute feature vectors into algorithm types using threshold-based
 * classification (matching codebase conventions — no ML dependencies).
 *
 * Algorithm Types:
 * - VWAP: high volume-profile correlation + small uniform sizes
 * - Momentum: high directional imbalance + increasing trade sizes
 * - Mean Reversion: post-move, trade flow reverses + small regular sizes
 * - Institutional Execution: large trades + spread over time + low market impact
 * - HFT Activity: very high trade count + small sizes + low inter-arrival variance
 *
 * Input:  data/orderflow/es/algo-features-5m.csv
 * Output: results/es-orderflow/algo-clustering-results.json
 *
 * Usage:
 *   node scripts/es-algo-clustering.js [options]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const startDateStr = getArg('start', '2025-01-01');
const endDateStr = getArg('end', '2026-01-31');
const outputPath = getArg('output', 'results/es-orderflow/algo-clustering-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// Forward return windows
const FORWARD_WINDOWS = [1, 3, 6, 12]; // In 5-minute multiples (5m, 15m, 30m, 60m)

console.log('='.repeat(80));
console.log('ES ALGORITHM CLUSTERING');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log();

// ============================================================================
// Data Loading
// ============================================================================

async function loadAlgoFeatures() {
  const filePath = path.join(dataDir, 'orderflow/es/algo-features-5m.csv');
  console.log(`Loading algo features from ${filePath}...`);

  if (!fs.existsSync(filePath)) {
    console.error('algo-features-5m.csv not found. Run es-algo-features.js first.');
    process.exit(1);
  }

  const features = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headers = null;

  for await (const line of rl) {
    if (!headers) {
      headers = line.split(',');
      continue;
    }

    const parts = line.split(',');
    if (parts.length !== headers.length) continue;

    const row = {};
    headers.forEach((h, i) => { row[h] = parts[i]; });

    const timestamp = new Date(row.timestamp).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;

    features.push({
      timestamp,
      session: row.session,
      meanTradeSize: parseFloat(row.meanTradeSize),
      medianTradeSize: parseFloat(row.medianTradeSize),
      stdTradeSize: parseFloat(row.stdTradeSize),
      skewTradeSize: parseFloat(row.skewTradeSize),
      maxTradeSize: parseInt(row.maxTradeSize),
      buySellSizeRatio: parseFloat(row.buySellSizeRatio),
      totalVolume: parseInt(row.totalVolume),
      totalTrades: parseInt(row.totalTrades),
      netVolume: parseInt(row.netVolume),
      volumeImbalance: parseFloat(row.volumeImbalance),
      vwap: parseFloat(row.vwap),
      vwapTrackingError: parseFloat(row.vwapTrackingError),
      volumeProfileCorrelation: parseFloat(row.volumeProfileCorrelation),
      largeTradeRatio: parseFloat(row.largeTradeRatio),
      largeTradeBuyVol: parseInt(row.largeTradeBuyVol),
      largeTradeSellVol: parseInt(row.largeTradeSellVol),
      tradeArrivalCV: parseFloat(row.tradeArrivalCV),
      tradeSizeCV: parseFloat(row.tradeSizeCV),
      priceChange: parseFloat(row.priceChange),
      realizedVol: parseFloat(row.realizedVol),
      pricePerVolume: parseFloat(row.pricePerVolume),
      vwapSlippage: parseFloat(row.vwapSlippage)
    });
  }

  features.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Loaded ${features.length} feature vectors`);
  return features;
}

function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;
  const contractVolumes = new Map();
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    if (!contractVolumes.has(hourKey)) contractVolumes.set(hourKey, new Map());
    const hourData = contractVolumes.get(hourKey);
    hourData.set(candle.symbol, (hourData.get(candle.symbol) || 0) + (candle.volume || 0));
  });
  return candles.filter(candle => {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    const hourData = contractVolumes.get(hourKey);
    if (!hourData) return true;
    let primarySymbol = '', maxVolume = 0;
    for (const [symbol, volume] of hourData) {
      if (volume > maxVolume) { maxVolume = volume; primarySymbol = symbol; }
    }
    return candle.symbol === primarySymbol;
  });
}

async function loadOHLCVData() {
  const filePath = path.join(dataDir, 'ohlcv/es/ES_ohlcv_1m.csv');
  console.log(`Loading OHLCV data for forward returns...`);
  const candles = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    const symbol = parts[9]?.trim();
    if (symbol && symbol.includes('-')) continue;
    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseInt(parts[8]);
    if (open === high && high === low && low === close) continue;
    candles.push({ timestamp, open, high, low, close, volume, symbol });
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  const filtered = filterPrimaryContract(candles);
  console.log(`  Loaded ${filtered.length} candles`);
  return filtered;
}

// ============================================================================
// Classification
// ============================================================================

function classifyAlgoType(feature, stats) {
  const scores = {
    vwap: 0,
    momentum: 0,
    mean_reversion: 0,
    institutional: 0,
    hft: 0,
    mixed: 0
  };

  // --- VWAP ---
  // High volume profile correlation + small uniform sizes
  if (feature.volumeProfileCorrelation > 0.7) scores.vwap += 2;
  else if (feature.volumeProfileCorrelation > 0.5) scores.vwap += 1;
  if (feature.tradeSizeCV < 0.5) scores.vwap += 2;
  else if (feature.tradeSizeCV < 0.8) scores.vwap += 1;
  if (feature.meanTradeSize < stats.medianTradeSize) scores.vwap += 1;
  if (feature.vwapTrackingError < stats.medianVwapError) scores.vwap += 1;

  // --- Momentum ---
  // High directional imbalance + large trade sizes
  if (Math.abs(feature.volumeImbalance) > 0.4) scores.momentum += 2;
  else if (Math.abs(feature.volumeImbalance) > 0.2) scores.momentum += 1;
  if (Math.abs(feature.priceChange) > stats.p75PriceChange) scores.momentum += 2;
  if (feature.skewTradeSize > 1.0) scores.momentum += 1; // Right-skewed = increasing sizes
  if (feature.largeTradeRatio > stats.p75LargeRatio) scores.momentum += 1;

  // --- Mean Reversion ---
  // Post-move, trade flow reverses + small regular sizes
  if (Math.abs(feature.priceChange) < stats.p25PriceChange) scores.mean_reversion += 1;
  if (feature.tradeSizeCV < 0.6) scores.mean_reversion += 1;
  // Volume imbalance opposing recent price direction
  if (feature.priceChange > 0 && feature.volumeImbalance < -0.1) scores.mean_reversion += 2;
  if (feature.priceChange < 0 && feature.volumeImbalance > 0.1) scores.mean_reversion += 2;
  if (feature.realizedVol < stats.medianRealizedVol) scores.mean_reversion += 1;

  // --- Institutional Execution ---
  // Large trades + low market impact + spread over time
  if (feature.largeTradeRatio > 0.3) scores.institutional += 2;
  else if (feature.largeTradeRatio > 0.15) scores.institutional += 1;
  if (feature.maxTradeSize > stats.p90MaxTradeSize) scores.institutional += 2;
  if (feature.pricePerVolume < stats.medianPricePerVolume) scores.institutional += 1;
  // Moderate trade frequency (not too many, not too few)
  if (feature.totalTrades > stats.medianTrades * 0.5 && feature.totalTrades < stats.medianTrades * 1.5) {
    scores.institutional += 1;
  }

  // --- HFT ---
  // Very high trade count + small sizes + low inter-arrival variance
  if (feature.totalTrades > stats.p90Trades) scores.hft += 2;
  else if (feature.totalTrades > stats.p75Trades) scores.hft += 1;
  if (feature.meanTradeSize < stats.p25TradeSize) scores.hft += 2;
  if (feature.tradeArrivalCV < 0.3) scores.hft += 2; // Very uniform arrival
  else if (feature.tradeArrivalCV < 0.5) scores.hft += 1;

  // Find winner
  let maxScore = 0;
  let algoType = 'mixed';
  for (const [type, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      algoType = type;
    }
  }

  // Require minimum score for classification
  if (maxScore < 3) algoType = 'mixed';

  return { algoType, scores, confidence: maxScore };
}

function computeStats(features) {
  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const percentile = (sortedArr, p) => {
    const idx = Math.floor(sortedArr.length * p);
    return sortedArr[Math.min(idx, sortedArr.length - 1)];
  };

  const tradeSizes = sorted(features.map(f => f.meanTradeSize));
  const priceChanges = sorted(features.map(f => Math.abs(f.priceChange)));
  const largeRatios = sorted(features.map(f => f.largeTradeRatio));
  const trades = sorted(features.map(f => f.totalTrades));
  const maxTradeSizes = sorted(features.map(f => f.maxTradeSize));
  const realizedVols = sorted(features.map(f => f.realizedVol));
  const pricePerVolumes = sorted(features.map(f => f.pricePerVolume).filter(v => v > 0));
  const vwapErrors = sorted(features.map(f => f.vwapTrackingError));

  return {
    medianTradeSize: percentile(tradeSizes, 0.5),
    p25TradeSize: percentile(tradeSizes, 0.25),
    p25PriceChange: percentile(priceChanges, 0.25),
    p75PriceChange: percentile(priceChanges, 0.75),
    p75LargeRatio: percentile(largeRatios, 0.75),
    medianTrades: percentile(trades, 0.5),
    p75Trades: percentile(trades, 0.75),
    p90Trades: percentile(trades, 0.90),
    p90MaxTradeSize: percentile(maxTradeSizes, 0.90),
    medianRealizedVol: percentile(realizedVols, 0.5),
    medianPricePerVolume: percentile(pricePerVolumes, 0.5),
    medianVwapError: percentile(vwapErrors, 0.5)
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const [features, candles] = await Promise.all([
    loadAlgoFeatures(),
    loadOHLCVData()
  ]);

  // Build candle lookup for forward returns
  const candleMap = new Map();
  candles.forEach(c => candleMap.set(c.timestamp, c));

  console.log('\nComputing classification thresholds...');
  const stats = computeStats(features);
  console.log('  Thresholds:', JSON.stringify(stats, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v));

  console.log('\nClassifying feature vectors...\n');

  const classified = [];

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const { algoType, scores, confidence } = classifyAlgoType(f, stats);

    // Compute forward returns (from 5-min window end)
    const forwardReturns = {};
    for (const mult of FORWARD_WINDOWS) {
      const futureTs = f.timestamp + mult * 5 * 60000;
      const futureCandle = candleMap.get(futureTs);
      if (futureCandle) {
        // Get candle at feature timestamp
        const currentCandle = candleMap.get(f.timestamp);
        if (currentCandle) {
          const ret = futureCandle.close - currentCandle.close;
          forwardReturns[`${mult * 5}m`] = { points: ret, magnitude: Math.abs(ret) };
        }
      }
    }

    classified.push({
      timestamp: f.timestamp,
      session: f.session,
      algoType,
      confidence,
      scores,
      // Key features for this classification
      volumeImbalance: f.volumeImbalance,
      totalVolume: f.totalVolume,
      totalTrades: f.totalTrades,
      meanTradeSize: f.meanTradeSize,
      tradeSizeCV: f.tradeSizeCV,
      largeTradeRatio: f.largeTradeRatio,
      volumeProfileCorrelation: f.volumeProfileCorrelation,
      priceChange: f.priceChange,
      realizedVol: f.realizedVol,
      forwardReturns
    });
  }

  // Count by type
  const typeCounts = {};
  for (const c of classified) {
    typeCounts[c.algoType] = (typeCounts[c.algoType] || 0) + 1;
  }

  console.log('Classification distribution:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count} (${(count / classified.length * 100).toFixed(1)}%)`);
  }

  // ============================================================================
  // Analysis per Algorithm Type
  // ============================================================================

  const analyzeGroup = (group, label) => {
    if (group.length === 0) return null;
    const result = { label, count: group.length, pct: (group.length / classified.length * 100).toFixed(1) + '%' };

    // Average features
    result.avgVolume = (group.reduce((s, c) => s + c.totalVolume, 0) / group.length).toFixed(0);
    result.avgTrades = (group.reduce((s, c) => s + c.totalTrades, 0) / group.length).toFixed(0);
    result.avgTradeSize = (group.reduce((s, c) => s + c.meanTradeSize, 0) / group.length).toFixed(2);
    result.avgImbalance = (group.reduce((s, c) => s + c.volumeImbalance, 0) / group.length).toFixed(4);
    result.avgLargeRatio = (group.reduce((s, c) => s + c.largeTradeRatio, 0) / group.length).toFixed(4);
    result.avgRealizedVol = (group.reduce((s, c) => s + c.realizedVol, 0) / group.length).toFixed(2);
    result.avgConfidence = (group.reduce((s, c) => s + c.confidence, 0) / group.length).toFixed(1);

    // Forward returns
    for (const mult of FORWARD_WINDOWS) {
      const key = `${mult * 5}m`;
      const withData = group.filter(c => c.forwardReturns[key]);
      if (withData.length === 0) continue;
      const avgReturn = withData.reduce((s, c) => s + c.forwardReturns[key].points, 0) / withData.length;
      const avgMagnitude = withData.reduce((s, c) => s + c.forwardReturns[key].magnitude, 0) / withData.length;
      const upPct = (withData.filter(c => c.forwardReturns[key].points > 0).length / withData.length * 100).toFixed(1);
      result[key] = {
        avgReturn: avgReturn.toFixed(2),
        avgMagnitude: avgMagnitude.toFixed(2),
        upPct: upPct + '%',
        count: withData.length
      };
    }

    // Session distribution
    const sessionDist = {};
    for (const c of group) {
      sessionDist[c.session] = (sessionDist[c.session] || 0) + 1;
    }
    result.sessionDistribution = {};
    for (const [s, count] of Object.entries(sessionDist)) {
      result.sessionDistribution[s] = (count / group.length * 100).toFixed(1) + '%';
    }

    return result;
  };

  const results = {
    metadata: {
      startDate: startDateStr, endDate: endDateStr,
      totalClassified: classified.length,
      classificationStats: stats
    },
    distribution: typeCounts,
    byAlgoType: {},
    // High confidence only
    highConfidence: {},
    samplesByType: {}
  };

  const algoTypes = ['vwap', 'momentum', 'mean_reversion', 'institutional', 'hft', 'mixed'];
  for (const type of algoTypes) {
    const group = classified.filter(c => c.algoType === type);
    results.byAlgoType[type] = analyzeGroup(group, type);

    const highConf = group.filter(c => c.confidence >= 5);
    results.highConfidence[type] = analyzeGroup(highConf, `${type}_high_conf`);

    // Sample events
    results.samplesByType[type] = group.slice(0, 5).map(c => ({
      timestamp: new Date(c.timestamp).toISOString(),
      confidence: c.confidence,
      scores: c.scores,
      meanTradeSize: c.meanTradeSize,
      totalTrades: c.totalTrades,
      volumeImbalance: c.volumeImbalance,
      largeTradeRatio: c.largeTradeRatio
    }));
  }

  // Print summary
  console.log('\n=== ALGO CLUSTERING RESULTS ===\n');
  for (const type of algoTypes) {
    const g = results.byAlgoType[type];
    if (!g) continue;
    const parts = [`${type} (n=${g.count}, ${g.pct})`];
    parts.push(`vol: ${g.avgVolume}, trades: ${g.avgTrades}, size: ${g.avgTradeSize}`);
    parts.push(`imb: ${g.avgImbalance}, large: ${g.avgLargeRatio}`);
    for (const mult of FORWARD_WINDOWS) {
      const k = `${mult * 5}m`;
      if (g[k]) parts.push(`${k}: ${g[k].avgReturn}pts (${g[k].upPct} up)`);
    }
    console.log(parts.join(' | '));
  }

  // Write output
  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
