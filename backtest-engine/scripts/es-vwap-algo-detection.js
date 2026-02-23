#!/usr/bin/env node
/**
 * ES VWAP Algorithm Detection
 *
 * Detects VWAP execution algorithms by:
 * - Building historical ES volume profile (average % of daily volume by minute)
 * - For each 30-minute rolling window, computing correlation between actual trade arrival
 *   and historical volume profile
 * - Flagging periods where correlation > 0.8 AND trade sizes are small and uniform
 *
 * Output: periods where VWAP execution is likely active, with confidence scores
 *
 * Usage:
 *   node scripts/es-vwap-algo-detection.js [options]
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
const outputPath = getArg('output', 'results/es-orderflow/vwap-algo-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// VWAP detection parameters
const ROLLING_WINDOW = 30;           // Minutes for rolling window
const CORRELATION_THRESHOLD = 0.7;   // Min correlation with volume profile
const HIGH_CORRELATION = 0.85;       // High confidence threshold
const SIZE_UNIFORMITY_THRESHOLD = 0.5; // Max coefficient of variation for trade sizes
const MAX_AVG_TRADE_SIZE = 5;        // VWAP algos use small trades
const FORWARD_WINDOWS = [5, 15, 30, 60];

console.log('='.repeat(80));
console.log('ES VWAP ALGORITHM DETECTION');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log();

// ============================================================================
// Data Loading
// ============================================================================

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
  console.log(`Loading OHLCV data...`);
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

async function loadTradeOFI() {
  const filePath = path.join(dataDir, 'orderflow/es/trade-ofi-1m.csv');
  console.log(`Loading trade OFI...`);
  const data = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 17) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    data.set(timestamp, {
      totalVolume: parseInt(parts[4]),
      totalTrades: parseInt(parts[7]),
      volumeImbalance: parseFloat(parts[8]),
      avgTradeSize: parseFloat(parts[9]),
      maxTradeSize: parseInt(parts[10]),
      avgBuySize: parseFloat(parts[14]),
      avgSellSize: parseFloat(parts[15])
    });
  }
  console.log(`  Loaded ${data.size} minute records`);
  return data;
}

// ============================================================================
// Volume Profile & Correlation
// ============================================================================

function buildVolumeProfile(candles, tradeOFI) {
  const minuteOfDayVolumes = new Map();
  for (const candle of candles) {
    const d = new Date(candle.timestamp);
    const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
    const ofi = tradeOFI.get(candle.timestamp);
    const vol = ofi ? ofi.totalVolume : candle.volume;
    if (!minuteOfDayVolumes.has(minuteOfDay)) minuteOfDayVolumes.set(minuteOfDay, []);
    minuteOfDayVolumes.get(minuteOfDay).push(vol);
  }

  const profile = new Map();
  for (const [minuteOfDay, volumes] of minuteOfDayVolumes) {
    profile.set(minuteOfDay, volumes.reduce((a, b) => a + b, 0) / volumes.length);
  }
  return profile;
}

function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : num / denom;
}

function coefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
  return std / mean;
}

function getSession(timestamp) {
  const date = new Date(timestamp);
  const timeMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (timeMin >= 870 && timeMin < 1260) return 'rth';
  if (timeMin >= 780 && timeMin < 870) return 'premarket';
  if (timeMin >= 1260 && timeMin < 1380) return 'afterhours';
  return 'overnight';
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const [candles, tradeOFI] = await Promise.all([
    loadOHLCVData(),
    loadTradeOFI()
  ]);

  console.log('\nBuilding volume profile...');
  const volumeProfile = buildVolumeProfile(candles, tradeOFI);
  console.log(`  ${volumeProfile.size} minute-of-day buckets`);

  console.log(`\nScanning ${ROLLING_WINDOW}-minute rolling windows...\n`);

  const detections = [];

  for (let i = ROLLING_WINDOW; i < candles.length - Math.max(...FORWARD_WINDOWS); i++) {
    // Collect window data
    const windowCandles = candles.slice(i - ROLLING_WINDOW, i);
    const windowOFI = [];
    const expectedVolumes = [];
    const actualVolumes = [];
    const tradeSizes = [];

    for (const c of windowCandles) {
      const ofi = tradeOFI.get(c.timestamp);
      if (!ofi) continue;
      windowOFI.push(ofi);

      const d = new Date(c.timestamp);
      const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
      const expected = volumeProfile.get(minuteOfDay) || 0;
      expectedVolumes.push(expected);
      actualVolumes.push(ofi.totalVolume);
      tradeSizes.push(ofi.avgTradeSize);
    }

    if (windowOFI.length < ROLLING_WINDOW * 0.8) continue; // Need most of the window

    // Correlation with volume profile
    const correlation = pearsonCorrelation(expectedVolumes, actualVolumes);
    if (correlation < CORRELATION_THRESHOLD) continue;

    // Trade size uniformity
    const sizeCV = coefficientOfVariation(tradeSizes);
    const avgSize = tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length;

    // VWAP algos: high correlation + small uniform trades
    const isSmallSize = avgSize <= MAX_AVG_TRADE_SIZE;
    const isUniform = sizeCV <= SIZE_UNIFORMITY_THRESHOLD;

    // Confidence scoring
    let confidence = 0;
    if (correlation >= HIGH_CORRELATION) confidence += 0.4;
    else confidence += 0.2 * (correlation - CORRELATION_THRESHOLD) / (HIGH_CORRELATION - CORRELATION_THRESHOLD);

    if (isUniform) confidence += 0.3;
    else confidence += 0.1;

    if (isSmallSize) confidence += 0.3;
    else confidence += 0.1;

    const candle = candles[i];
    const session = getSession(candle.timestamp);

    // Forward returns
    const forwardReturns = {};
    for (const window of FORWARD_WINDOWS) {
      if (i + window < candles.length) {
        const futureCandle = candles[i + window];
        const ret = futureCandle.close - candle.close;
        forwardReturns[`${window}m`] = {
          points: ret,
          magnitude: Math.abs(ret)
        };
      }
    }

    // Volume imbalance during VWAP period
    const totalImbalance = windowOFI.reduce((s, o) => s + o.volumeImbalance, 0) / windowOFI.length;

    detections.push({
      timestamp: new Date(candle.timestamp).toISOString(),
      windowStart: new Date(windowCandles[0].timestamp).toISOString(),
      price: candle.close,
      correlation,
      sizeCV,
      avgTradeSize: avgSize,
      maxTradeSize: Math.max(...windowOFI.map(o => o.maxTradeSize)),
      isSmallSize,
      isUniform,
      confidence,
      session,
      volumeImbalance: totalImbalance,
      totalVolume: windowOFI.reduce((s, o) => s + o.totalVolume, 0),
      totalTrades: windowOFI.reduce((s, o) => s + o.totalTrades, 0),
      forwardReturns
    });
  }

  console.log(`Found ${detections.length} VWAP-like periods\n`);

  // Deduplicate overlapping detections (keep highest confidence within 30-min windows)
  detections.sort((a, b) => b.confidence - a.confidence);
  const used = new Set();
  const uniqueDetections = [];
  for (const d of detections) {
    const ts = new Date(d.timestamp).getTime();
    const windowKey = Math.floor(ts / (ROLLING_WINDOW * 60000));
    if (used.has(windowKey)) continue;
    used.add(windowKey);
    uniqueDetections.push(d);
  }
  uniqueDetections.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  console.log(`Unique periods (after dedup): ${uniqueDetections.length}\n`);

  // ============================================================================
  // Analysis
  // ============================================================================

  const analyzeGroup = (group, label) => {
    if (group.length === 0) return null;
    const result = { label, count: group.length };

    result.avgConfidence = (group.reduce((s, d) => s + d.confidence, 0) / group.length).toFixed(3);
    result.avgCorrelation = (group.reduce((s, d) => s + d.correlation, 0) / group.length).toFixed(3);
    result.avgTradeSize = (group.reduce((s, d) => s + d.avgTradeSize, 0) / group.length).toFixed(2);
    result.avgSizeCV = (group.reduce((s, d) => s + d.sizeCV, 0) / group.length).toFixed(3);
    result.avgVolumeImbalance = (group.reduce((s, d) => s + d.volumeImbalance, 0) / group.length).toFixed(4);

    for (const window of FORWARD_WINDOWS) {
      const key = `${window}m`;
      const withData = group.filter(d => d.forwardReturns[key]);
      if (withData.length === 0) continue;
      const avgReturn = withData.reduce((s, d) => s + d.forwardReturns[key].points, 0) / withData.length;
      const avgMagnitude = withData.reduce((s, d) => s + d.forwardReturns[key].magnitude, 0) / withData.length;
      result[key] = {
        avgReturn: avgReturn.toFixed(2),
        avgMagnitude: avgMagnitude.toFixed(2),
        count: withData.length
      };
    }

    return result;
  };

  const highConfidence = uniqueDetections.filter(d => d.confidence >= 0.7);
  const medConfidence = uniqueDetections.filter(d => d.confidence >= 0.5 && d.confidence < 0.7);

  const results = {
    metadata: {
      startDate: startDateStr, endDate: endDateStr,
      totalDetections: uniqueDetections.length,
      parameters: { ROLLING_WINDOW, CORRELATION_THRESHOLD, HIGH_CORRELATION, SIZE_UNIFORMITY_THRESHOLD, MAX_AVG_TRADE_SIZE }
    },
    overall: analyzeGroup(uniqueDetections, 'all'),
    highConfidence: analyzeGroup(highConfidence, 'high_confidence'),
    mediumConfidence: analyzeGroup(medConfidence, 'medium_confidence'),
    bySession: {},
    // Imbalance during VWAP: does direction predict forward move?
    buyBiased: analyzeGroup(uniqueDetections.filter(d => d.volumeImbalance > 0.05), 'buy_biased'),
    sellBiased: analyzeGroup(uniqueDetections.filter(d => d.volumeImbalance < -0.05), 'sell_biased'),
    neutral: analyzeGroup(uniqueDetections.filter(d => Math.abs(d.volumeImbalance) <= 0.05), 'neutral'),
    sampleDetections: uniqueDetections.slice(0, 20)
  };

  for (const session of [...new Set(uniqueDetections.map(d => d.session))]) {
    results.bySession[session] = analyzeGroup(uniqueDetections.filter(d => d.session === session), session);
  }

  // Print summary
  console.log('=== VWAP ALGO DETECTION RESULTS ===\n');
  console.log(`Total unique detections: ${uniqueDetections.length}`);
  console.log(`  High confidence (>=0.7): ${highConfidence.length}`);
  console.log(`  Medium confidence (0.5-0.7): ${medConfidence.length}`);
  console.log();

  const printGroup = (g) => {
    if (!g) return;
    const parts = [`  ${g.label} (n=${g.count})`];
    parts.push(`corr: ${g.avgCorrelation}, conf: ${g.avgConfidence}`);
    parts.push(`size: ${g.avgTradeSize}, cv: ${g.avgSizeCV}`);
    for (const w of FORWARD_WINDOWS) {
      const k = `${w}m`;
      if (g[k]) parts.push(`${w}m: avg ${g[k].avgReturn}pts`);
    }
    console.log(parts.join(' | '));
  };

  printGroup(results.overall);
  printGroup(results.highConfidence);
  console.log('\nBy Session:');
  for (const g of Object.values(results.bySession)) printGroup(g);
  console.log('\nBy Volume Bias:');
  printGroup(results.buyBiased);
  printGroup(results.sellBiased);
  printGroup(results.neutral);

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
