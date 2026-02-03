#!/usr/bin/env node
/**
 * Best Confluence Signal Analysis
 *
 * Based on deep analysis, the best patterns are:
 * 1. Support absorption at outer levels (S2, S3) - 92-97% win rate
 * 2. Resistance absorption at outer levels (R2, R3, R4) - 81-90% win rate
 * 3. Avoid resistance_1 (only 44% win rate)
 *
 * This script tests refined entry criteria.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { DatabentoTradeLoader } from './src/data/databento-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  ohlcvFile: path.join(__dirname, 'data/ohlcv/nq/NQ_ohlcv_1m.csv'),
  precomputedImbalance: path.join(__dirname, 'data/orderflow/nq/book-imbalance-1m.csv'),
  tradesDir: path.join(__dirname, 'data/orderflow/nq/trades'),
  gexDir: path.join(__dirname, 'data/gex/nq'),
};

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
      if (record.symbol?.includes('-')) return;
      const timestamp = new Date(record.ts_event).getTime();
      const date = new Date(timestamp);
      if (date < startDate || date > endDate) return;
      candles.push({
        timestamp, open: parseFloat(record.open), high: parseFloat(record.high),
        low: parseFloat(record.low), close: parseFloat(record.close),
        volume: parseInt(record.volume)
      });
    });
    rl.on('close', () => { candles.sort((a, b) => a.timestamp - b.timestamp); resolve(candles); });
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
        gammaFlip: snapshot.gamma_flip,
        callWall: snapshot.call_wall,
        putWall: snapshot.put_wall,
        support: snapshot.support || [],
        resistance: snapshot.resistance || [],
        regime: snapshot.regime
      });
    }
  }
  return gexMap;
}

async function loadRealCVD(startDate, endDate, candles) {
  const loader = new DatabentoTradeLoader({ dataDir: CONFIG.tradesDir, symbolFilter: 'NQ' });
  console.log('  Loading CVD...');
  const cvdMap = await loader.computeCVDForCandlesStreaming(startDate, endDate, candles, () => {});
  return cvdMap;
}

function getActiveGexLevels(gexMap, timestamp) {
  let bestTs = null;
  for (const ts of gexMap.keys()) {
    if (ts <= timestamp && (!bestTs || ts > bestTs)) bestTs = ts;
  }
  return bestTs ? gexMap.get(bestTs) : null;
}

function checkLevelProximity(price, gex) {
  if (!gex) return null;

  const result = { support: null, resistance: null };

  // Check support levels (S2+ only - skip S1)
  const supportLevels = [
    { level: gex.support?.[1], type: 'S2' },
    { level: gex.support?.[2], type: 'S3' },
    { level: gex.support?.[3], type: 'S4' },
    { level: gex.putWall, type: 'PUT_WALL' },
  ];

  for (const { level, type } of supportLevels) {
    if (!level) continue;
    const dist = Math.abs(price - level);
    if (dist < 20) {
      if (!result.support || dist < result.support.distance) {
        result.support = { level, type, distance: dist };
      }
    }
  }

  // Check resistance levels (R2+ only - skip R1)
  const resistanceLevels = [
    { level: gex.resistance?.[1], type: 'R2' },
    { level: gex.resistance?.[2], type: 'R3' },
    { level: gex.resistance?.[3], type: 'R4' },
    { level: gex.callWall, type: 'CALL_WALL' },
  ];

  for (const { level, type } of resistanceLevels) {
    if (!level) continue;
    const dist = Math.abs(price - level);
    if (dist < 20) {
      if (!result.resistance || dist < result.resistance.distance) {
        result.resistance = { level, type, distance: dist };
      }
    }
  }

  return result;
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

  // Timeout - close at market
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

  console.log('=== Best Confluence Signal Analysis ===\n');
  console.log(`Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

  console.log('Loading data...');
  const candles = await loadOHLCV(startDate, endDate);
  const imbalanceMap = await loadBookImbalance();
  const gexMap = await loadGexLevels(startDate, endDate);
  const cvdMap = await loadRealCVD(startDate, endDate, candles);

  console.log(`  ${candles.length.toLocaleString()} candles, ${gexMap.size} GEX, ${cvdMap.size} CVD\n`);

  const priceHistory = [];
  let lastSignalTime = 0;

  const signals = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!isRTH(candle.timestamp)) continue;

    const imbData = imbalanceMap.get(candle.timestamp);
    const gex = getActiveGexLevels(gexMap, candle.timestamp);
    const cvdData = cvdMap.get(candle.timestamp);

    priceHistory.push({ ts: candle.timestamp, close: candle.close });
    if (priceHistory.length > 30) priceHistory.shift();

    if (!gex || !imbData || priceHistory.length < 10) continue;
    if (candle.timestamp - lastSignalTime < 1800000) continue; // 30min cooldown

    const priceSlope = calculateSlope(priceHistory.map(h => h.close), 5);
    const totalVolume = imbData.totalBidSize + imbData.totalAskSize;
    const imbalance = imbData.sizeImbalance;

    const proximity = checkLevelProximity(candle.close, gex);

    // SUPPORT ABSORPTION at S2+
    if (proximity.support && priceSlope < -0.3 && Math.abs(imbalance) < 0.06 && totalVolume > 40000) {
      signals.push({
        idx: i,
        timestamp: candle.timestamp,
        price: candle.close,
        side: 'long',
        type: proximity.support.type,
        level: proximity.support.level,
        distance: proximity.support.distance,
        regime: gex.regime,
        imbalance,
        priceSlope
      });
      lastSignalTime = candle.timestamp;
    }

    // RESISTANCE ABSORPTION at R2+
    if (proximity.resistance && priceSlope > 0.3 && Math.abs(imbalance) < 0.06 && totalVolume > 40000) {
      signals.push({
        idx: i,
        timestamp: candle.timestamp,
        price: candle.close,
        side: 'short',
        type: proximity.resistance.type,
        level: proximity.resistance.level,
        distance: proximity.resistance.distance,
        regime: gex.regime,
        imbalance,
        priceSlope
      });
      lastSignalTime = candle.timestamp;
    }
  }

  console.log('='.repeat(80));
  console.log(`FILTERED SIGNALS: Outer Levels (S2+/R2+) + Absorption Only`);
  console.log('='.repeat(80));
  console.log(`\nTotal signals: ${signals.length}`);
  console.log(`  Long (support): ${signals.filter(s => s.side === 'long').length}`);
  console.log(`  Short (resistance): ${signals.filter(s => s.side === 'short').length}`);

  // Test various stop/target combinations
  const configs = [
    { stop: 15, target: 30 },
    { stop: 20, target: 40 },
    { stop: 25, target: 50 },
    { stop: 15, target: 45 },  // 1:3 R:R
    { stop: 20, target: 60 },  // 1:3 R:R
  ];

  console.log('\n' + '-'.repeat(80));
  console.log('CONFIGURATION TEST (All Signals)');
  console.log('-'.repeat(80));
  console.log('Stop | Target | R:R  | Wins | Stops | Timeout | Win% | Total P&L | Avg/Trade');
  console.log('-'.repeat(80));

  for (const cfg of configs) {
    let wins = 0, stops = 0, timeouts = 0, totalPnl = 0;

    for (const sig of signals) {
      const result = simulateTrade(candles, sig.idx, sig.side, cfg.stop, cfg.target);
      totalPnl += result.pnl;
      if (result.result === 'target') wins++;
      else if (result.result === 'stop') stops++;
      else timeouts++;
    }

    const decided = wins + stops;
    const winRate = decided > 0 ? (wins / decided * 100) : 0;
    const avgPnl = signals.length > 0 ? totalPnl / signals.length : 0;
    const rr = (cfg.target / cfg.stop).toFixed(1);

    console.log(
      `${String(cfg.stop).padStart(4)} | ${String(cfg.target).padStart(6)} | ${rr.padStart(4)} | ` +
      `${String(wins).padStart(4)} | ${String(stops).padStart(5)} | ${String(timeouts).padStart(7)} | ` +
      `${winRate.toFixed(1).padStart(5)}% | ${totalPnl.toFixed(0).padStart(9)} | ${avgPnl.toFixed(2).padStart(9)}`
    );
  }

  // Test LONG signals only
  const longSignals = signals.filter(s => s.side === 'long');

  console.log('\n' + '-'.repeat(80));
  console.log(`LONG SIGNALS ONLY (n=${longSignals.length})`);
  console.log('-'.repeat(80));
  console.log('Stop | Target | R:R  | Wins | Stops | Timeout | Win% | Total P&L | Avg/Trade');
  console.log('-'.repeat(80));

  for (const cfg of configs) {
    let wins = 0, stops = 0, timeouts = 0, totalPnl = 0;

    for (const sig of longSignals) {
      const result = simulateTrade(candles, sig.idx, 'long', cfg.stop, cfg.target);
      totalPnl += result.pnl;
      if (result.result === 'target') wins++;
      else if (result.result === 'stop') stops++;
      else timeouts++;
    }

    const decided = wins + stops;
    const winRate = decided > 0 ? (wins / decided * 100) : 0;
    const avgPnl = longSignals.length > 0 ? totalPnl / longSignals.length : 0;
    const rr = (cfg.target / cfg.stop).toFixed(1);

    console.log(
      `${String(cfg.stop).padStart(4)} | ${String(cfg.target).padStart(6)} | ${rr.padStart(4)} | ` +
      `${String(wins).padStart(4)} | ${String(stops).padStart(5)} | ${String(timeouts).padStart(7)} | ` +
      `${winRate.toFixed(1).padStart(5)}% | ${totalPnl.toFixed(0).padStart(9)} | ${avgPnl.toFixed(2).padStart(9)}`
    );
  }

  // By level type
  console.log('\n' + '-'.repeat(80));
  console.log('BY LEVEL TYPE (30pt stop, 60pt target)');
  console.log('-'.repeat(80));

  const byType = {};
  for (const sig of signals) {
    if (!byType[sig.type]) byType[sig.type] = [];
    byType[sig.type].push(sig);
  }

  for (const [type, sigs] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    let wins = 0, stops = 0, totalPnl = 0;

    for (const sig of sigs) {
      const result = simulateTrade(candles, sig.idx, sig.side, 30, 60);
      totalPnl += result.pnl;
      if (result.result === 'target') wins++;
      else if (result.result === 'stop') stops++;
    }

    const decided = wins + stops;
    const winRate = decided > 0 ? (wins / decided * 100) : 0;
    const avgPnl = sigs.length > 0 ? totalPnl / sigs.length : 0;

    console.log(
      `${type.padEnd(12)} | n=${String(sigs.length).padStart(3)} | ` +
      `Win%=${winRate.toFixed(1).padStart(5)}% | Avg=${avgPnl.toFixed(1).padStart(6)} pts`
    );
  }

  // Sample trades
  console.log('\n' + '-'.repeat(80));
  console.log('SAMPLE TRADES (First 10)');
  console.log('-'.repeat(80));

  for (const sig of signals.slice(0, 10)) {
    const result = simulateTrade(candles, sig.idx, sig.side, 20, 40);
    const date = new Date(sig.timestamp);
    const timeStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    console.log(
      `${timeStr} | ${sig.side.toUpperCase().padEnd(5)} | ${sig.type.padEnd(10)} | ` +
      `Entry=${sig.price.toFixed(0)} | Result=${result.result.padEnd(7)} | P&L=${result.pnl.toFixed(0).padStart(4)}`
    );
  }

  console.log('\n=== Analysis Complete ===');
}

main().catch(console.error);
