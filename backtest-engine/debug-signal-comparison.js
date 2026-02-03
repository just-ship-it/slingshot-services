#!/usr/bin/env node
/**
 * Debug script to compare analysis signals vs strategy signals
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

async function main() {
  const startDate = new Date('2025-01-02');
  const endDate = new Date('2025-01-03');

  console.log('=== Signal Comparison Debug ===\n');

  const candles = await loadOHLCV(startDate, endDate);
  const imbalanceMap = await loadBookImbalance();
  const gexMap = await loadGexLevels(startDate, endDate);

  console.log(`Loaded ${candles.length} candles, ${imbalanceMap.size} imbalance, ${gexMap.size} GEX\n`);

  // Initialize strategy
  const strategy = new GexAbsorptionStrategy({
    tradeWalls: false,
    debug: false
  });
  strategy.loadBookImbalanceData(imbalanceMap);

  const priceHistory = [];
  let lastSignalTime = 0;
  let analysisSignals = [];
  let strategySignals = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const prevCandle = i > 0 ? candles[i - 1] : null;

    priceHistory.push(candle.close);
    if (priceHistory.length > 50) priceHistory.shift();

    if (!isRTH(candle.timestamp)) continue;

    const gex = getActiveGexLevels(gexMap, candle.timestamp);
    const bookData = imbalanceMap.get(candle.timestamp);

    // Analysis logic (same as analyze-best-confluence.js but without walls)
    if (gex && bookData && priceHistory.length >= 5) {
      if (candle.timestamp - lastSignalTime >= 1800000) { // 30min cooldown

        const priceSlope = calculateSlope(priceHistory.slice(-5), 5);
        const totalVolume = (bookData.totalBidSize || 0) + (bookData.totalAskSize || 0);
        const imbalance = bookData.sizeImbalance;

        // Check S2+ proximity
        let nearSupport = null;
        const support2 = gex.support?.[1];
        const support3 = gex.support?.[2];
        const support4 = gex.support?.[3];

        if (support2 && Math.abs(candle.close - support2) < 20) {
          nearSupport = { level: support2, type: 'S2', dist: Math.abs(candle.close - support2) };
        }
        if (support3 && Math.abs(candle.close - support3) < 20) {
          nearSupport = { level: support3, type: 'S3', dist: Math.abs(candle.close - support3) };
        }
        if (support4 && Math.abs(candle.close - support4) < 20) {
          nearSupport = { level: support4, type: 'S4', dist: Math.abs(candle.close - support4) };
        }

        // Check R2+ proximity
        let nearResistance = null;
        const resistance2 = gex.resistance?.[1];
        const resistance3 = gex.resistance?.[2];
        const resistance4 = gex.resistance?.[3];

        if (resistance2 && Math.abs(candle.close - resistance2) < 20) {
          nearResistance = { level: resistance2, type: 'R2', dist: Math.abs(candle.close - resistance2) };
        }
        if (resistance3 && Math.abs(candle.close - resistance3) < 20) {
          nearResistance = { level: resistance3, type: 'R3', dist: Math.abs(candle.close - resistance3) };
        }
        if (resistance4 && Math.abs(candle.close - resistance4) < 20) {
          nearResistance = { level: resistance4, type: 'R4', dist: Math.abs(candle.close - resistance4) };
        }

        const isBalanced = Math.abs(imbalance) < 0.06;
        const hasVolume = totalVolume >= 40000;

        // LONG signal
        if (nearSupport && priceSlope < -0.3 && isBalanced && hasVolume) {
          analysisSignals.push({
            timestamp: candle.timestamp,
            side: 'LONG',
            price: candle.close,
            type: nearSupport.type,
            level: nearSupport.level,
            distance: nearSupport.dist,
            priceSlope,
            imbalance,
            volume: totalVolume
          });
          lastSignalTime = candle.timestamp;
        }

        // SHORT signal
        if (nearResistance && priceSlope > 0.3 && isBalanced && hasVolume) {
          analysisSignals.push({
            timestamp: candle.timestamp,
            side: 'SHORT',
            price: candle.close,
            type: nearResistance.type,
            level: nearResistance.level,
            distance: nearResistance.dist,
            priceSlope,
            imbalance,
            volume: totalVolume
          });
          lastSignalTime = candle.timestamp;
        }
      }
    }

    // Strategy logic
    const marketData = {
      gexLevels: gex ? {
        support: gex.support,
        resistance: gex.resistance,
        callWall: gex.callWall,
        putWall: gex.putWall,
        regime: gex.regime
      } : null
    };

    const signal = strategy.evaluateSignal(candle, prevCandle, marketData, {});
    if (signal) {
      strategySignals.push({
        timestamp: candle.timestamp,
        side: signal.side.toUpperCase(),
        price: candle.close,
        type: signal.levelType,
        level: signal.levelPrice,
        distance: signal.levelDistance,
        imbalance: signal.bookImbalance,
        volume: signal.bookVolume
      });
    }
  }

  console.log('=== ANALYSIS SIGNALS ===');
  console.log(`Total: ${analysisSignals.length}`);
  for (const sig of analysisSignals) {
    const date = new Date(sig.timestamp);
    const timeStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    console.log(`${timeStr} | ${sig.side.padEnd(5)} | ${sig.type.padEnd(4)} @ ${sig.level.toFixed(0)} | Price=${sig.price.toFixed(0)} | Dist=${sig.distance.toFixed(1)} | Imb=${sig.imbalance.toFixed(4)} | Slope=${sig.priceSlope.toFixed(3)}`);
  }

  console.log('\n=== STRATEGY SIGNALS ===');
  console.log(`Total: ${strategySignals.length}`);
  for (const sig of strategySignals) {
    const date = new Date(sig.timestamp);
    const timeStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    console.log(`${timeStr} | ${sig.side.padEnd(5)} | ${sig.type.padEnd(4)} @ ${sig.level.toFixed(0)} | Price=${sig.price.toFixed(0)} | Dist=${sig.distance.toFixed(1)} | Imb=${sig.imbalance?.toFixed(4) || 'N/A'}`);
  }

  // Compare
  console.log('\n=== COMPARISON ===');
  console.log(`Analysis signals: ${analysisSignals.length}`);
  console.log(`Strategy signals: ${strategySignals.length}`);

  // Find matching and non-matching
  const analysisTs = new Set(analysisSignals.map(s => s.timestamp));
  const strategyTs = new Set(strategySignals.map(s => s.timestamp));

  const onlyAnalysis = analysisSignals.filter(s => !strategyTs.has(s.timestamp));
  const onlyStrategy = strategySignals.filter(s => !analysisTs.has(s.timestamp));
  const both = analysisSignals.filter(s => strategyTs.has(s.timestamp));

  console.log(`\nMatching signals: ${both.length}`);
  console.log(`Only in analysis: ${onlyAnalysis.length}`);
  console.log(`Only in strategy: ${onlyStrategy.length}`);

  if (onlyAnalysis.length > 0) {
    console.log('\n--- Analysis-only signals (first 5) ---');
    for (const sig of onlyAnalysis.slice(0, 5)) {
      const date = new Date(sig.timestamp);
      const timeStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      console.log(`${timeStr} | ${sig.side.padEnd(5)} | ${sig.type.padEnd(4)} | Price=${sig.price.toFixed(0)}`);
    }
  }

  if (onlyStrategy.length > 0) {
    console.log('\n--- Strategy-only signals (first 5) ---');
    for (const sig of onlyStrategy.slice(0, 5)) {
      const date = new Date(sig.timestamp);
      const timeStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      console.log(`${timeStr} | ${sig.side.padEnd(5)} | ${sig.type.padEnd(4)} | Price=${sig.price.toFixed(0)}`);
    }
  }

  console.log('\n=== Debug Complete ===');
}

main().catch(console.error);
