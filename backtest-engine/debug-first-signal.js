#!/usr/bin/env node
/**
 * Debug script to trace exactly what happens at the first signal time
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { GexAbsorptionStrategy } from '../shared/strategies/gex-absorption.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  ohlcvFile: path.join(__dirname, 'data/ohlcv/nq/NQ_ohlcv_1m.csv'),
  precomputedImbalance: path.join(__dirname, 'data/orderflow/nq/book-imbalance-1m.csv'),
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

function getActiveGexLevels(gexMap, timestamp) {
  let bestTs = null;
  for (const ts of gexMap.keys()) {
    if (ts <= timestamp && (!bestTs || ts > bestTs)) bestTs = ts;
  }
  return bestTs ? gexMap.get(bestTs) : null;
}

async function main() {
  const startDate = new Date('2025-01-02');
  const endDate = new Date('2025-01-03');

  // Target time: 10:00 AM EST = 15:00 UTC
  const targetTime = new Date('2025-01-02T15:00:00.000Z').getTime();

  console.log('=== First Signal Debug ===\n');
  console.log(`Target time: ${new Date(targetTime).toISOString()} (10:00 AM EST)\n`);

  const candles = await loadOHLCV(startDate, endDate);
  const imbalanceMap = await loadBookImbalance();
  const gexMap = await loadGexLevels(startDate, endDate);

  console.log(`Loaded ${candles.length} candles, ${imbalanceMap.size} imbalance, ${gexMap.size} GEX\n`);

  // Find candles around target time
  const windowStart = targetTime - 30 * 60 * 1000; // 30 min before
  const windowEnd = targetTime + 30 * 60 * 1000;   // 30 min after

  const windowCandles = candles.filter(c => c.timestamp >= windowStart && c.timestamp <= windowEnd);

  console.log('=== Candles around 10:00 AM EST ===');
  console.log(`Found ${windowCandles.length} candles in window\n`);

  // Find the exact target candle
  const targetCandle = candles.find(c => c.timestamp === targetTime);
  if (targetCandle) {
    console.log('Target candle (15:00:00 UTC):');
    console.log(`  Timestamp: ${new Date(targetCandle.timestamp).toISOString()}`);
    console.log(`  Symbol: ${targetCandle.symbol}`);
    console.log(`  OHLC: ${targetCandle.open} / ${targetCandle.high} / ${targetCandle.low} / ${targetCandle.close}`);
  } else {
    console.log('Target candle NOT FOUND at 15:00:00 UTC');

    // Find nearest candle
    const sortedByDist = candles
      .map(c => ({ ...c, dist: Math.abs(c.timestamp - targetTime) }))
      .sort((a, b) => a.dist - b.dist);

    const nearest = sortedByDist[0];
    console.log(`\nNearest candle:`);
    console.log(`  Timestamp: ${new Date(nearest.timestamp).toISOString()}`);
    console.log(`  Distance: ${nearest.dist / 1000}s`);
    console.log(`  Symbol: ${nearest.symbol}`);
    console.log(`  OHLC: ${nearest.open} / ${nearest.high} / ${nearest.low} / ${nearest.close}`);
  }

  // Check book imbalance at target time
  console.log('\n=== Book Imbalance at Target Time ===');
  const bookData = imbalanceMap.get(targetTime);
  if (bookData) {
    console.log(`  sizeImbalance: ${bookData.sizeImbalance}`);
    console.log(`  totalVolume: ${(bookData.totalBidSize || 0) + (bookData.totalAskSize || 0)}`);
    console.log(`  updates: ${bookData.updates}`);
  } else {
    console.log('  NOT FOUND');

    // Find nearest
    let nearest = null;
    let nearestDist = Infinity;
    for (const [ts, data] of imbalanceMap.entries()) {
      const dist = Math.abs(ts - targetTime);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = { ts, data };
      }
    }
    if (nearest) {
      console.log(`\n  Nearest at: ${new Date(nearest.ts).toISOString()} (${nearestDist/1000}s away)`);
    }
  }

  // Check GEX levels
  console.log('\n=== GEX Levels at Target Time ===');
  const gex = getActiveGexLevels(gexMap, targetTime);
  if (gex) {
    console.log(`  Support: ${gex.support.slice(0,4).map(s => s?.toFixed(0)).join(', ')}`);
    console.log(`  Resistance: ${gex.resistance.slice(0,4).map(r => r?.toFixed(0)).join(', ')}`);
    console.log(`  S2: ${gex.support[1]}`);
  } else {
    console.log('  NOT FOUND');
  }

  // Now test the strategy
  console.log('\n=== Strategy Test ===');
  const strategy = new GexAbsorptionStrategy({ tradeWalls: false, debug: true });
  strategy.loadBookImbalanceData(imbalanceMap);

  // Build up price history like the strategy would
  const priceHistoryCandles = candles.filter(c => c.timestamp < targetTime);
  const recentHistory = priceHistoryCandles.slice(-50);

  console.log(`\nBuilding price history with ${recentHistory.length} candles...`);

  // Reset and process candles up to target
  strategy.reset();
  for (const candle of recentHistory) {
    strategy.evaluateSignal(candle, null, { gexLevels: getActiveGexLevels(gexMap, candle.timestamp) }, {});
  }

  // Now test the target candle
  console.log('\nEvaluating target candle...');
  const prevCandle = recentHistory[recentHistory.length - 1];
  const marketData = {
    gexLevels: gex ? {
      support: gex.support,
      resistance: gex.resistance,
      callWall: gex.callWall,
      putWall: gex.putWall,
      regime: gex.regime
    } : null
  };

  if (targetCandle) {
    const signal = strategy.evaluateSignal(targetCandle, prevCandle, marketData, { debug: true });

    if (signal) {
      console.log(`\nSIGNAL GENERATED!`);
      console.log(`  Side: ${signal.side}`);
      console.log(`  Price: ${signal.price}`);
      console.log(`  Level: ${signal.levelType} @ ${signal.levelPrice}`);
    } else {
      console.log(`\nNO SIGNAL generated`);

      // Debug why
      console.log('\n=== Debug: Checking conditions ===');

      const priceSlope = strategy.calculatePriceSlope(5);
      console.log(`  Price slope: ${priceSlope?.toFixed(4)}`);
      console.log(`  Need: < -0.3 for support, > 0.3 for resistance`);

      const bookCheck = strategy.getBookImbalance(targetCandle.timestamp);
      if (bookCheck) {
        const absorption = strategy.checkAbsorption(bookCheck);
        console.log(`  Book imbalance: ${bookCheck.sizeImbalance?.toFixed(4)}`);
        console.log(`  Absorption: ${absorption.isAbsorption}`);
      } else {
        console.log(`  Book data: NOT FOUND`);
      }

      const nearestS = strategy.findNearestLevel(targetCandle.close, marketData.gexLevels, 'support');
      const nearestR = strategy.findNearestLevel(targetCandle.close, marketData.gexLevels, 'resistance');
      console.log(`  Nearest support: ${nearestS ? `${nearestS.type} @ ${nearestS.level} (dist=${nearestS.distance.toFixed(1)})` : 'none'}`);
      console.log(`  Nearest resistance: ${nearestR ? `${nearestR.type} @ ${nearestR.level} (dist=${nearestR.distance.toFixed(1)})` : 'none'}`);

      console.log(`  Session check: ${strategy.isInAllowedSession(targetCandle.timestamp) ? 'PASS' : 'FAIL'}`);
    }
  } else {
    console.log('Cannot test - target candle not found');
  }

  console.log('\n=== Debug Complete ===');
}

main().catch(console.error);
