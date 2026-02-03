#!/usr/bin/env node
/**
 * Fixed GEX Absorption Analysis
 *
 * Uses proper primary contract filtering to match backtest engine behavior.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  ohlcvFile: path.join(__dirname, 'data/ohlcv/nq/NQ_ohlcv_1m.csv'),
  precomputedImbalance: path.join(__dirname, 'data/orderflow/nq/book-imbalance-1m.csv'),
  gexDir: path.join(__dirname, 'data/gex/nq'),
};

/**
 * Filter candles to use only the primary (highest volume) contract per hour
 * This matches the backtest engine's filterPrimaryContract behavior
 */
function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;

  // Calculate volume per contract symbol per hour
  const contractVolumes = new Map();

  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000));
    const symbol = candle.symbol;

    if (!contractVolumes.has(hourKey)) {
      contractVolumes.set(hourKey, new Map());
    }

    const hourData = contractVolumes.get(hourKey);
    const currentVol = hourData.get(symbol) || 0;
    hourData.set(symbol, currentVol + (candle.volume || 0));
  });

  // Filter to keep only candles from the primary contract each hour
  const result = [];
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000));
    const hourData = contractVolumes.get(hourKey);

    if (!hourData) {
      result.push(candle);
      return;
    }

    // Find symbol with highest volume for this hour
    let primarySymbol = '';
    let maxVolume = 0;

    for (const [symbol, volume] of hourData.entries()) {
      if (volume > maxVolume) {
        maxVolume = volume;
        primarySymbol = symbol;
      }
    }

    // Only include candles from the primary contract
    if (candle.symbol === primarySymbol) {
      result.push(candle);
    }
  });

  return result;
}

async function loadOHLCV(startDate, endDate) {
  return new Promise((resolve, reject) => {
    const candles = [];
    let headers = null;
    const stream = fs.createReadStream(CONFIG.ohlcvFile);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!headers) { headers = line.split(','); return; }
      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);
      if (record.symbol?.includes('-')) return; // Skip calendar spreads
      const timestamp = new Date(record.ts_event).getTime();
      const date = new Date(timestamp);
      if (date < startDate || date > endDate) return;
      candles.push({
        timestamp,
        open: parseFloat(record.open),
        high: parseFloat(record.high),
        low: parseFloat(record.low),
        close: parseFloat(record.close),
        volume: parseInt(record.volume),
        symbol: record.symbol
      });
    });
    rl.on('close', () => {
      candles.sort((a, b) => a.timestamp - b.timestamp);

      // CRITICAL: Filter to primary contract like backtest engine does!
      const filtered = filterPrimaryContract(candles);
      console.log(`  Filtered ${candles.length} candles to ${filtered.length} (primary contract only)`);
      resolve(filtered);
    });
    rl.on('error', reject);
  });
}

async function loadBookImbalance() {
  return new Promise((resolve, reject) => {
    const map = new Map();
    let headers = null;
    const stream = fs.createReadStream(CONFIG.precomputedImbalance);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!headers) { headers = line.split(','); return; }
      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);
      const timestamp = new Date(record.timestamp).getTime();
      map.set(timestamp, {
        sizeImbalance: parseFloat(record.sizeImbalance),
        totalBidSize: parseInt(record.totalBidSize),
        totalAskSize: parseInt(record.totalAskSize),
        updates: parseInt(record.updates)
      });
    });
    rl.on('close', () => resolve(map));
    rl.on('error', reject);
  });
}

async function loadGexLevels(startDate, endDate) {
  const gexMap = new Map();
  const files = fs.readdirSync(CONFIG.gexDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const dateMatch = file.match(/nq_gex_(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const fileDate = new Date(dateMatch[1]);
    if (fileDate < startDate || fileDate > endDate) continue;

    const content = JSON.parse(fs.readFileSync(path.join(CONFIG.gexDir, file), 'utf-8'));
    const snapshots = content.data || content.snapshots || [content];

    for (const snapshot of snapshots) {
      const ts = new Date(snapshot.timestamp).getTime();
      gexMap.set(ts, {
        support: snapshot.support || [],
        resistance: snapshot.resistance || [],
        regime: snapshot.regime
      });
    }
  }
  return gexMap;
}

function getActiveGexLevels(gexMap, timestamp) {
  let bestTs = null;
  for (const ts of gexMap.keys()) {
    if (ts <= timestamp && (!bestTs || ts > bestTs)) bestTs = ts;
  }
  return bestTs ? gexMap.get(bestTs) : null;
}

function calculateSlope(values, lookback) {
  if (values.length < lookback) return null;
  const recent = values.slice(-lookback);
  const n = recent.length;
  const xMean = (n - 1) / 2;
  const yMean = recent.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (recent[i] - yMean);
    den += (i - xMean) * (i - xMean);
  }
  return den === 0 ? 0 : num / den;
}

function isRTH(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
  const [hourStr, minStr] = estString.split(':');
  const hour = parseInt(hourStr);
  const min = parseInt(minStr);
  const timeDecimal = hour + min / 60;
  return timeDecimal >= 9.5 && timeDecimal < 16;
}

function simulateTrade(candles, startIdx, side, stopPts, targetPts, maxBars = 120) {
  const entry = candles[startIdx].close;

  for (let j = startIdx + 1; j < Math.min(startIdx + maxBars, candles.length); j++) {
    const c = candles[j];

    if (side === 'long') {
      if (entry - c.low >= stopPts) return { result: 'stop', pnl: -stopPts, bars: j - startIdx };
      if (c.high - entry >= targetPts) return { result: 'target', pnl: targetPts, bars: j - startIdx };
    } else {
      if (c.high - entry >= stopPts) return { result: 'stop', pnl: -stopPts, bars: j - startIdx };
      if (entry - c.low >= targetPts) return { result: 'target', pnl: targetPts, bars: j - startIdx };
    }
  }

  const exitCandle = candles[Math.min(startIdx + maxBars, candles.length - 1)];
  const pnl = side === 'long' ? exitCandle.close - entry : entry - exitCandle.close;
  return { result: 'timeout', pnl, bars: maxBars };
}

async function main() {
  const args = process.argv.slice(2);
  let startDate = new Date('2025-01-01');
  let endDate = new Date('2025-03-31');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') startDate = new Date(args[++i]);
    if (args[i] === '--end') endDate = new Date(args[++i]);
  }

  console.log('=== Fixed GEX Absorption Analysis ===');
  console.log(`Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

  console.log('Loading data...');
  const candles = await loadOHLCV(startDate, endDate);
  const imbalanceMap = await loadBookImbalance();
  const gexMap = await loadGexLevels(startDate, endDate);

  console.log(`  ${candles.length.toLocaleString()} candles (primary contract), ${gexMap.size} GEX snapshots\n`);

  const priceHistory = [];
  let lastSignalTime = 0;
  const signals = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Add to price history FIRST (matches strategy behavior)
    priceHistory.push(candle.close);
    if (priceHistory.length > 50) priceHistory.shift();

    if (!isRTH(candle.timestamp)) continue;

    const imbData = imbalanceMap.get(candle.timestamp);
    const gex = getActiveGexLevels(gexMap, candle.timestamp);

    if (!gex || !imbData || priceHistory.length < 5) continue;
    if (candle.timestamp - lastSignalTime < 1800000) continue; // 30min cooldown

    // Calculate slope AFTER adding current candle (matches strategy)
    const priceSlope = calculateSlope(priceHistory, 5);
    const totalVolume = (imbData.totalBidSize || 0) + (imbData.totalAskSize || 0);
    const imbalance = imbData.sizeImbalance;

    // Check absorption criteria
    const isBalanced = Math.abs(imbalance) < 0.06;
    const hasVolume = totalVolume >= 40000;

    // Check support proximity (S2+) for LONG
    const support2 = gex.support?.[1];
    const support3 = gex.support?.[2];
    const support4 = gex.support?.[3];

    let nearSupport = null;
    if (support2 && Math.abs(candle.close - support2) < 20) {
      nearSupport = { level: support2, type: 'S2', dist: Math.abs(candle.close - support2) };
    }
    if (support3 && Math.abs(candle.close - support3) < 20 && (!nearSupport || Math.abs(candle.close - support3) < nearSupport.dist)) {
      nearSupport = { level: support3, type: 'S3', dist: Math.abs(candle.close - support3) };
    }
    if (support4 && Math.abs(candle.close - support4) < 20 && (!nearSupport || Math.abs(candle.close - support4) < nearSupport.dist)) {
      nearSupport = { level: support4, type: 'S4', dist: Math.abs(candle.close - support4) };
    }

    // Check resistance proximity (R2+) for SHORT
    const resistance2 = gex.resistance?.[1];
    const resistance3 = gex.resistance?.[2];
    const resistance4 = gex.resistance?.[3];

    let nearResistance = null;
    if (resistance2 && Math.abs(candle.close - resistance2) < 20) {
      nearResistance = { level: resistance2, type: 'R2', dist: Math.abs(candle.close - resistance2) };
    }
    if (resistance3 && Math.abs(candle.close - resistance3) < 20 && (!nearResistance || Math.abs(candle.close - resistance3) < nearResistance.dist)) {
      nearResistance = { level: resistance3, type: 'R3', dist: Math.abs(candle.close - resistance3) };
    }
    if (resistance4 && Math.abs(candle.close - resistance4) < 20 && (!nearResistance || Math.abs(candle.close - resistance4) < nearResistance.dist)) {
      nearResistance = { level: resistance4, type: 'R4', dist: Math.abs(candle.close - resistance4) };
    }

    // LONG signal: falling price near support with absorption
    if (nearSupport && priceSlope < -0.3 && isBalanced && hasVolume) {
      signals.push({
        idx: i, timestamp: candle.timestamp, price: candle.close,
        side: 'long', type: nearSupport.type, level: nearSupport.level,
        distance: nearSupport.dist, priceSlope, imbalance
      });
      lastSignalTime = candle.timestamp;
    }

    // SHORT signal: rising price near resistance with absorption
    if (nearResistance && priceSlope > 0.3 && isBalanced && hasVolume) {
      signals.push({
        idx: i, timestamp: candle.timestamp, price: candle.close,
        side: 'short', type: nearResistance.type, level: nearResistance.level,
        distance: nearResistance.dist, priceSlope, imbalance
      });
      lastSignalTime = candle.timestamp;
    }
  }

  console.log('='.repeat(80));
  console.log('FIXED ANALYSIS: Primary Contract + Proper Slope Calculation');
  console.log('='.repeat(80));
  console.log(`\nTotal signals: ${signals.length}`);
  console.log(`  Long (support): ${signals.filter(s => s.side === 'long').length}`);
  console.log(`  Short (resistance): ${signals.filter(s => s.side === 'short').length}`);

  // Test with 20pt stop / 40pt target (same as strategy)
  console.log('\n' + '-'.repeat(80));
  console.log('RESULTS: 20pt Stop / 40pt Target');
  console.log('-'.repeat(80));

  let wins = 0, losses = 0, totalPnl = 0;
  const sampleTrades = [];

  for (const sig of signals) {
    const result = simulateTrade(candles, sig.idx, sig.side, 20, 40);
    totalPnl += result.pnl;

    if (result.result === 'target') wins++;
    else if (result.result === 'stop') losses++;

    if (sampleTrades.length < 15) {
      const date = new Date(sig.timestamp);
      const timeStr = date.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      sampleTrades.push({
        time: timeStr, side: sig.side.toUpperCase(), type: sig.type,
        price: sig.price.toFixed(0), slope: sig.priceSlope.toFixed(3),
        result: result.result, pnl: result.pnl
      });
    }
  }

  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided * 100) : 0;
  const avgPnl = signals.length > 0 ? totalPnl / signals.length : 0;

  console.log(`Wins: ${wins} | Losses: ${losses} | Win Rate: ${winRate.toFixed(1)}%`);
  console.log(`Total P&L: ${totalPnl.toFixed(0)} pts | Avg/Trade: ${avgPnl.toFixed(2)} pts`);
  console.log(`Dollar P&L: $${(totalPnl * 20).toFixed(0)} | Avg: $${(avgPnl * 20).toFixed(2)}`);

  console.log('\n' + '-'.repeat(80));
  console.log('SAMPLE TRADES (First 15)');
  console.log('-'.repeat(80));

  for (const t of sampleTrades) {
    const resultIcon = t.result === 'target' ? '✅' : '❌';
    console.log(
      `${t.time.padEnd(18)} | ${t.side.padEnd(5)} | ${t.type.padEnd(4)} @ ${t.price} | ` +
      `Slope=${t.slope.padStart(7)} | ${resultIcon} ${t.result.padEnd(7)} | P&L=${String(t.pnl).padStart(3)}`
    );
  }

  // By level type
  console.log('\n' + '-'.repeat(80));
  console.log('BY LEVEL TYPE');
  console.log('-'.repeat(80));

  const byType = {};
  for (const sig of signals) {
    if (!byType[sig.type]) byType[sig.type] = [];
    byType[sig.type].push(sig);
  }

  for (const [type, sigs] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    let typeWins = 0, typeStops = 0, typePnl = 0;

    for (const sig of sigs) {
      const result = simulateTrade(candles, sig.idx, sig.side, 20, 40);
      typePnl += result.pnl;
      if (result.result === 'target') typeWins++;
      else if (result.result === 'stop') typeStops++;
    }

    const typeDecided = typeWins + typeStops;
    const typeWinRate = typeDecided > 0 ? (typeWins / typeDecided * 100) : 0;
    const typeAvg = sigs.length > 0 ? typePnl / sigs.length : 0;

    console.log(
      `${type.padEnd(4)} | n=${String(sigs.length).padStart(3)} | ` +
      `Win%=${typeWinRate.toFixed(1).padStart(5)}% | Avg=${typeAvg.toFixed(1).padStart(6)} pts`
    );
  }

  console.log('\n=== Analysis Complete ===');
}

main().catch(console.error);
