#!/usr/bin/env node
/**
 * Diagnose why analysis results differ from backtest results
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
        low: parseFloat(record.low), close: parseFloat(record.close)
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
        support: snapshot.support || [],
        resistance: snapshot.resistance || []
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
  const startDate = new Date('2025-01-01');
  const endDate = new Date('2025-01-31');

  console.log('=== Absorption Signal Diagnostic ===\n');

  const candles = await loadOHLCV(startDate, endDate);
  const imbalanceMap = await loadBookImbalance();
  const gexMap = await loadGexLevels(startDate, endDate);

  console.log(`Loaded ${candles.length} candles, ${imbalanceMap.size} imbalance, ${gexMap.size} GEX\n`);

  const priceHistory = [];
  let lastSignalTime = 0;

  const stats = {
    rthCandles: 0,
    passedCooldown: 0,
    hasPriceHistory: 0,
    hasGex: 0,
    hasBookData: 0,
    hasEnoughUpdates: 0,
    supportProximity: 0,
    resistanceProximity: 0,
    supportAbsorption: 0,
    resistanceAbsorption: 0,
    signalsSupportLong: 0,
    signalsResistanceShort: 0
  };

  const sampleSignals = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    priceHistory.push(candle.close);
    if (priceHistory.length > 50) priceHistory.shift();

    if (!isRTH(candle.timestamp)) continue;
    stats.rthCandles++;

    if (candle.timestamp - lastSignalTime < 1800000) continue;
    stats.passedCooldown++;

    if (priceHistory.length < 5) continue;
    stats.hasPriceHistory++;

    const gex = getActiveGexLevels(gexMap, candle.timestamp);
    if (!gex) continue;
    stats.hasGex++;

    const bookData = imbalanceMap.get(candle.timestamp);
    if (bookData) stats.hasBookData++;
    if (bookData && bookData.updates >= 100) stats.hasEnoughUpdates++;

    const priceSlope = calculateSlope(priceHistory, 5);

    // Check support proximity (S2, S3, S4)
    const support2 = gex.support[1];
    const support3 = gex.support[2];
    const support4 = gex.support[3];

    let nearSupport = null;
    if (support2 && Math.abs(candle.close - support2) < 20) nearSupport = { level: support2, type: 'S2', dist: Math.abs(candle.close - support2) };
    if (support3 && Math.abs(candle.close - support3) < 20) nearSupport = { level: support3, type: 'S3', dist: Math.abs(candle.close - support3) };
    if (support4 && Math.abs(candle.close - support4) < 20) nearSupport = { level: support4, type: 'S4', dist: Math.abs(candle.close - support4) };

    if (nearSupport) stats.supportProximity++;

    // Check resistance proximity (R2, R3, R4)
    const resistance2 = gex.resistance[1];
    const resistance3 = gex.resistance[2];
    const resistance4 = gex.resistance[3];

    let nearResistance = null;
    if (resistance2 && Math.abs(candle.close - resistance2) < 20) nearResistance = { level: resistance2, type: 'R2', dist: Math.abs(candle.close - resistance2) };
    if (resistance3 && Math.abs(candle.close - resistance3) < 20) nearResistance = { level: resistance3, type: 'R3', dist: Math.abs(candle.close - resistance3) };
    if (resistance4 && Math.abs(candle.close - resistance4) < 20) nearResistance = { level: resistance4, type: 'R4', dist: Math.abs(candle.close - resistance4) };

    if (nearResistance) stats.resistanceProximity++;

    // Check absorption conditions
    const imbalance = bookData?.sizeImbalance || 0;
    const totalVolume = (bookData?.totalBidSize || 0) + (bookData?.totalAskSize || 0);
    const isBalanced = Math.abs(imbalance) < 0.06;
    const hasVolume = totalVolume >= 40000;

    // LONG signal at support
    if (nearSupport && priceSlope < -0.3) {
      stats.supportAbsorption++;

      if (isBalanced && hasVolume) {
        stats.signalsSupportLong++;
        lastSignalTime = candle.timestamp;

        if (sampleSignals.length < 10) {
          sampleSignals.push({
            time: new Date(candle.timestamp).toISOString(),
            side: 'LONG',
            price: candle.close,
            level: nearSupport.type,
            levelPrice: nearSupport.level,
            distance: nearSupport.dist.toFixed(1),
            imbalance: imbalance.toFixed(4),
            volume: totalVolume,
            priceSlope: priceSlope.toFixed(3)
          });
        }
      }
    }

    // SHORT signal at resistance
    if (nearResistance && priceSlope > 0.3) {
      stats.resistanceAbsorption++;

      if (isBalanced && hasVolume) {
        stats.signalsResistanceShort++;
        lastSignalTime = candle.timestamp;

        if (sampleSignals.length < 10) {
          sampleSignals.push({
            time: new Date(candle.timestamp).toISOString(),
            side: 'SHORT',
            price: candle.close,
            level: nearResistance.type,
            levelPrice: nearResistance.level,
            distance: nearResistance.dist.toFixed(1),
            imbalance: imbalance.toFixed(4),
            volume: totalVolume,
            priceSlope: priceSlope.toFixed(3)
          });
        }
      }
    }
  }

  console.log('FILTER FUNNEL:');
  console.log('-'.repeat(50));
  console.log(`Total candles:        ${candles.length}`);
  console.log(`RTH candles:          ${stats.rthCandles}`);
  console.log(`Passed cooldown:      ${stats.passedCooldown}`);
  console.log(`Has price history:    ${stats.hasPriceHistory}`);
  console.log(`Has GEX data:         ${stats.hasGex}`);
  console.log(`Has book data:        ${stats.hasBookData}`);
  console.log(`Has enough updates:   ${stats.hasEnoughUpdates}`);
  console.log('-'.repeat(50));
  console.log(`Near support (S2+):   ${stats.supportProximity}`);
  console.log(`Near resistance (R2+):${stats.resistanceProximity}`);
  console.log('-'.repeat(50));
  console.log(`Support + falling:    ${stats.supportAbsorption}`);
  console.log(`Resistance + rising:  ${stats.resistanceAbsorption}`);
  console.log('-'.repeat(50));
  console.log(`LONG signals:         ${stats.signalsSupportLong}`);
  console.log(`SHORT signals:        ${stats.signalsResistanceShort}`);
  console.log(`TOTAL signals:        ${stats.signalsSupportLong + stats.signalsResistanceShort}`);

  console.log('\n\nSAMPLE SIGNALS:');
  console.log('-'.repeat(100));
  for (const sig of sampleSignals) {
    console.log(`${sig.time} | ${sig.side.padEnd(5)} | ${sig.level} @ ${sig.levelPrice.toFixed(0)} | Price=${sig.price.toFixed(0)} | Dist=${sig.distance} | Imb=${sig.imbalance} | Vol=${sig.volume}`);
  }

  console.log('\n=== Diagnostic Complete ===');
}

main().catch(console.error);
