#!/usr/bin/env node
/**
 * ES Algorithm Feature Extraction
 *
 * Extracts per 5-minute window features for algorithm fingerprinting:
 * - Trade size distribution (mean, median, std, skew, max)
 * - Buy/sell size ratio
 * - VWAP tracking error
 * - Volume participation rate vs historical average
 * - Large trade ratio
 * - Price impact features
 *
 * Input:  data/orderflow/es/trade-ofi-1m.csv + ES OHLCV 1m
 * Output: data/orderflow/es/algo-features-5m.csv
 *
 * Usage:
 *   node scripts/es-algo-features.js [options]
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
const outputPath = getArg('output', 'data/orderflow/es/algo-features-5m.csv');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

const WINDOW_MINUTES = 5;

console.log('='.repeat(80));
console.log('ES ALGORITHM FEATURE EXTRACTION');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Window: ${WINDOW_MINUTES} minutes`);
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
      buyVolume: parseInt(parts[1]),
      sellVolume: parseInt(parts[2]),
      netVolume: parseInt(parts[3]),
      totalVolume: parseInt(parts[4]),
      buyTrades: parseInt(parts[5]),
      sellTrades: parseInt(parts[6]),
      totalTrades: parseInt(parts[7]),
      volumeImbalance: parseFloat(parts[8]),
      avgTradeSize: parseFloat(parts[9]),
      maxTradeSize: parseInt(parts[10]),
      largeTradeBuyVol: parseInt(parts[11]),
      largeTradeSellVol: parseInt(parts[12]),
      vwap: parseFloat(parts[13]),
      avgBuySize: parseFloat(parts[14]),
      avgSellSize: parseFloat(parts[15]),
      tradeImbalance: parseFloat(parts[16])
    });
  }
  console.log(`  Loaded ${data.size} minute records`);
  return data;
}

// ============================================================================
// Historical Volume Profile (average % of daily volume by minute-of-day)
// ============================================================================

function buildVolumeProfile(candles, tradeOFI) {
  // Group volumes by day and by minute-of-day
  const dayVolumes = new Map(); // dayKey -> total volume
  const minuteOfDayVolumes = new Map(); // minuteOfDay -> [volumes]

  for (const candle of candles) {
    const dayKey = new Date(candle.timestamp).toISOString().split('T')[0];
    const d = new Date(candle.timestamp);
    const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();

    const ofi = tradeOFI.get(candle.timestamp);
    const vol = ofi ? ofi.totalVolume : candle.volume;

    dayVolumes.set(dayKey, (dayVolumes.get(dayKey) || 0) + vol);

    if (!minuteOfDayVolumes.has(minuteOfDay)) {
      minuteOfDayVolumes.set(minuteOfDay, []);
    }
    minuteOfDayVolumes.get(minuteOfDay).push(vol);
  }

  // Average volume percentage by minute of day
  const totalAvgDailyVol = [...dayVolumes.values()].reduce((a, b) => a + b, 0) / dayVolumes.size;
  const profile = new Map();

  for (const [minuteOfDay, volumes] of minuteOfDayVolumes) {
    const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    profile.set(minuteOfDay, avgVol / totalAvgDailyVol);
  }

  return { profile, totalAvgDailyVol };
}

// ============================================================================
// Feature Extraction
// ============================================================================

function getSession(timestamp) {
  const date = new Date(timestamp);
  const timeMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (timeMin >= 870 && timeMin < 1260) return 'rth';
  if (timeMin >= 780 && timeMin < 870) return 'premarket';
  if (timeMin >= 1260 && timeMin < 1380) return 'afterhours';
  return 'overnight';
}

function computeStdDev(values, mean) {
  if (values.length < 2) return 0;
  const sumSqDiff = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(sumSqDiff / (values.length - 1));
}

function computeSkewness(values, mean, std) {
  if (values.length < 3 || std === 0) return 0;
  const n = values.length;
  const sumCubed = values.reduce((s, v) => s + ((v - mean) / std) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sumCubed;
}

function computeMedian(sortedValues) {
  const n = sortedValues.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let numSum = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numSum += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : numSum / denom;
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
  const { profile: volumeProfile, totalAvgDailyVol } = buildVolumeProfile(candles, tradeOFI);
  console.log(`  Volume profile: ${volumeProfile.size} minute-of-day buckets, avg daily vol: ${totalAvgDailyVol.toFixed(0)}`);

  console.log('\nExtracting features per 5-minute window...\n');

  // Group candles into 5-minute windows
  const windowMs = WINDOW_MINUTES * 60000;
  const windowGroups = new Map();

  for (const candle of candles) {
    const windowKey = Math.floor(candle.timestamp / windowMs) * windowMs;
    if (!windowGroups.has(windowKey)) windowGroups.set(windowKey, []);
    windowGroups.get(windowKey).push(candle);
  }

  const features = [];
  const sortedWindowKeys = [...windowGroups.keys()].sort((a, b) => a - b);

  for (const windowKey of sortedWindowKeys) {
    const windowCandles = windowGroups.get(windowKey);
    if (windowCandles.length === 0) continue;

    // Collect minute-level OFI data for this window
    const minuteData = [];
    for (const candle of windowCandles) {
      const ofi = tradeOFI.get(candle.timestamp);
      if (ofi) minuteData.push({ ...ofi, candle });
    }

    if (minuteData.length === 0) continue;

    // --- Trade execution features ---
    const tradeSizes = minuteData.map(d => d.avgTradeSize).filter(v => v > 0);
    const tradeSizesSorted = [...tradeSizes].sort((a, b) => a - b);
    const meanTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
    const medianTradeSize = computeMedian(tradeSizesSorted);
    const stdTradeSize = computeStdDev(tradeSizes, meanTradeSize);
    const skewTradeSize = computeSkewness(tradeSizes, meanTradeSize, stdTradeSize);
    const maxTradeSize = Math.max(...minuteData.map(d => d.maxTradeSize), 0);

    // Buy/sell size ratio
    const totalBuySize = minuteData.reduce((s, d) => s + d.avgBuySize * d.buyTrades, 0);
    const totalSellSize = minuteData.reduce((s, d) => s + d.avgSellSize * d.sellTrades, 0);
    const buySellSizeRatio = totalSellSize > 0 ? totalBuySize / totalSellSize : 1;

    // Volume totals
    const totalVolume = minuteData.reduce((s, d) => s + d.totalVolume, 0);
    const totalTrades = minuteData.reduce((s, d) => s + d.totalTrades, 0);
    const netVolume = minuteData.reduce((s, d) => s + d.netVolume, 0);
    const volumeImbalance = totalVolume > 0 ? netVolume / totalVolume : 0;

    // VWAP tracking error
    const vwaps = minuteData.filter(d => d.vwap > 0).map(d => d.vwap);
    const closes = windowCandles.map(c => c.close);
    const windowVwap = vwaps.length > 0 ? vwaps.reduce((a, b) => a + b, 0) / vwaps.length : 0;
    const windowClose = closes[closes.length - 1];
    const vwapTrackingError = windowVwap > 0 ? Math.abs(windowClose - windowVwap) : 0;

    // Volume participation rate vs historical
    const expectedVolumes = [];
    const actualVolumes = [];
    for (const md of minuteData) {
      const d = new Date(md.candle.timestamp);
      const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
      const expected = volumeProfile.get(minuteOfDay) || 0;
      expectedVolumes.push(expected);
      actualVolumes.push(md.totalVolume);
    }
    const volumeProfileCorrelation = pearsonCorrelation(expectedVolumes, actualVolumes);

    // Large trade ratio
    const largeTradeBuyVol = minuteData.reduce((s, d) => s + d.largeTradeBuyVol, 0);
    const largeTradeSellVol = minuteData.reduce((s, d) => s + d.largeTradeSellVol, 0);
    const largeTradeRatio = totalVolume > 0 ? (largeTradeBuyVol + largeTradeSellVol) / totalVolume : 0;

    // Trade arrival uniformity (coefficient of variation of per-minute trade counts)
    const tradeCounts = minuteData.map(d => d.totalTrades);
    const meanTrades = tradeCounts.reduce((a, b) => a + b, 0) / tradeCounts.length;
    const stdTrades = computeStdDev(tradeCounts, meanTrades);
    const tradeArrivalCV = meanTrades > 0 ? stdTrades / meanTrades : 0;

    // Trade size uniformity (coefficient of variation of per-minute avg trade sizes)
    const tradeSizeCV = meanTradeSize > 0 ? stdTradeSize / meanTradeSize : 0;

    // --- Price impact features ---
    const windowOpen = windowCandles[0].open;
    const priceChange = windowClose - windowOpen;
    const windowHigh = Math.max(...windowCandles.map(c => c.high));
    const windowLow = Math.min(...windowCandles.map(c => c.low));
    const realizedVol = windowHigh - windowLow;

    // Price change vs net volume (temporary vs permanent impact)
    const pricePerVolume = totalVolume > 0 ? Math.abs(priceChange) / totalVolume : 0;

    // Volume-weighted price vs close (execution slippage proxy)
    const vwapSlippage = windowVwap > 0 ? (windowClose - windowVwap) / windowVwap : 0;

    const session = getSession(windowKey);

    features.push({
      timestamp: windowKey,
      session,
      // Trade size distribution
      meanTradeSize,
      medianTradeSize,
      stdTradeSize,
      skewTradeSize,
      maxTradeSize,
      buySellSizeRatio,
      // Volume
      totalVolume,
      totalTrades,
      netVolume,
      volumeImbalance,
      // VWAP
      vwap: windowVwap,
      vwapTrackingError,
      // Volume profile
      volumeProfileCorrelation,
      // Large trades
      largeTradeRatio,
      largeTradeBuyVol,
      largeTradeSellVol,
      // Trade arrival
      tradeArrivalCV,
      tradeSizeCV,
      // Price impact
      priceChange,
      realizedVol,
      pricePerVolume,
      vwapSlippage
    });
  }

  console.log(`Extracted ${features.length} 5-minute feature vectors\n`);

  // Write output CSV
  const outputFullPath = path.resolve(outputPath);
  const outDir = path.dirname(outputFullPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const header = 'timestamp,session,meanTradeSize,medianTradeSize,stdTradeSize,skewTradeSize,maxTradeSize,buySellSizeRatio,totalVolume,totalTrades,netVolume,volumeImbalance,vwap,vwapTrackingError,volumeProfileCorrelation,largeTradeRatio,largeTradeBuyVol,largeTradeSellVol,tradeArrivalCV,tradeSizeCV,priceChange,realizedVol,pricePerVolume,vwapSlippage';
  const lines = [header];

  for (const f of features) {
    lines.push([
      new Date(f.timestamp).toISOString(),
      f.session,
      f.meanTradeSize.toFixed(2),
      f.medianTradeSize.toFixed(2),
      f.stdTradeSize.toFixed(2),
      f.skewTradeSize.toFixed(4),
      f.maxTradeSize,
      f.buySellSizeRatio.toFixed(4),
      f.totalVolume,
      f.totalTrades,
      f.netVolume,
      f.volumeImbalance.toFixed(6),
      f.vwap.toFixed(4),
      f.vwapTrackingError.toFixed(4),
      f.volumeProfileCorrelation.toFixed(6),
      f.largeTradeRatio.toFixed(6),
      f.largeTradeBuyVol,
      f.largeTradeSellVol,
      f.tradeArrivalCV.toFixed(4),
      f.tradeSizeCV.toFixed(4),
      f.priceChange.toFixed(4),
      f.realizedVol.toFixed(4),
      f.pricePerVolume.toFixed(8),
      f.vwapSlippage.toFixed(8)
    ].join(','));
  }

  fs.writeFileSync(outputFullPath, lines.join('\n'));

  const fileSizeMB = (fs.statSync(outputFullPath).size / 1024 / 1024).toFixed(1);
  console.log(`Output: ${outputFullPath} (${fileSizeMB} MB)`);
  console.log(`Records: ${features.length}`);

  // Print summary stats
  const rthFeatures = features.filter(f => f.session === 'rth');
  console.log(`\nRTH windows: ${rthFeatures.length}`);
  if (rthFeatures.length > 0) {
    console.log(`  Avg trade size: ${(rthFeatures.reduce((s, f) => s + f.meanTradeSize, 0) / rthFeatures.length).toFixed(2)}`);
    console.log(`  Avg volume/5min: ${(rthFeatures.reduce((s, f) => s + f.totalVolume, 0) / rthFeatures.length).toFixed(0)}`);
    console.log(`  Avg large trade ratio: ${(rthFeatures.reduce((s, f) => s + f.largeTradeRatio, 0) / rthFeatures.length * 100).toFixed(1)}%`);
    console.log(`  Avg VWAP tracking error: ${(rthFeatures.reduce((s, f) => s + f.vwapTrackingError, 0) / rthFeatures.length).toFixed(2)} pts`);
    console.log(`  Avg vol profile correlation: ${(rthFeatures.reduce((s, f) => s + f.volumeProfileCorrelation, 0) / rthFeatures.length).toFixed(3)}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
