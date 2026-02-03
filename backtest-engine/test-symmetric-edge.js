#!/usr/bin/env node
/**
 * Test symmetric edge at different stop/target levels
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

async function loadRealCVD(startDate, endDate, candles) {
  const loader = new DatabentoTradeLoader({ dataDir: CONFIG.tradesDir, symbolFilter: 'NQ' });
  console.log('  Loading CVD...');
  const cvdMap = await loader.computeCVDForCandlesStreaming(startDate, endDate, candles, () => {});
  return cvdMap;
}

function calculateSlope(values, lookback) {
  if (values.length < lookback) return null;
  const recent = values.slice(-lookback);
  const n = recent.length;
  const xMean = (n - 1) / 2;
  const yMean = recent.reduce((a, b) => a + b, 0) / n;
  let numerator = 0, denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (recent[i] - yMean);
    denominator += (i - xMean) * (i - xMean);
  }
  return denominator === 0 ? 0 : numerator / denominator;
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
  const endDate = new Date('2025-03-31');
  
  console.log('=== Symmetric Edge Analysis ===\n');
  console.log('Loading data...');
  
  const candles = await loadOHLCV(startDate, endDate);
  const candleMap = new Map();
  candles.forEach((c, i) => candleMap.set(c.timestamp, i));
  
  const imbalanceMap = await loadBookImbalance();
  const cvdMap = await loadRealCVD(startDate, endDate, candles);
  
  console.log(`  ${candles.length} candles, ${cvdMap.size} CVD, ${imbalanceMap.size} imbalance\n`);
  
  // Find signals
  const signals = [];
  const priceHistory = [];
  const cvdHistory = [];
  let lastSignalTime = 0;
  
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!isRTH(candle.timestamp)) continue;
    
    const cvdData = cvdMap.get(candle.timestamp);
    const imbData = imbalanceMap.get(candle.timestamp);
    
    if (cvdData) {
      cvdHistory.push({ timestamp: candle.timestamp, cvd: cvdData.cumulativeDelta });
      if (cvdHistory.length > 30) cvdHistory.shift();
    }
    priceHistory.push({ timestamp: candle.timestamp, close: candle.close });
    if (priceHistory.length > 30) priceHistory.shift();
    
    if (priceHistory.length < 10 || cvdHistory.length < 10) continue;
    if (candle.timestamp - lastSignalTime < 1800000) continue; // 30min cooldown
    
    const cvdSlope = calculateSlope(cvdHistory.map(h => h.cvd), 5);
    const priceSlope = calculateSlope(priceHistory.map(h => h.close), 5);
    
    // Ask Absorption: price rising but balanced book
    const totalVolume = (imbData?.totalBidSize || 0) + (imbData?.totalAskSize || 0);
    const currentImbalance = imbData?.sizeImbalance || 0;
    const isAbsorption = Math.abs(currentImbalance) < 0.03 && totalVolume > 100000;
    const isPriceRising = priceSlope > 0.6;
    
    // Bearish Divergence: price up, CVD down
    const isCVDFalling = cvdSlope < -50;
    
    if ((isAbsorption && isPriceRising) || (isPriceRising && isCVDFalling)) {
      signals.push({ idx: i, timestamp: candle.timestamp, price: candle.close, side: 'sell' });
      lastSignalTime = candle.timestamp;
    }
  }
  
  console.log(`Found ${signals.length} SELL signals\n`);
  
  // Test different symmetric levels
  console.log('Testing symmetric edge (% of time target hit before stop):');
  console.log('Target/Stop | Targets | Stops  | Win%  | Edge?');
  console.log('-'.repeat(55));
  
  for (const pts of [20, 30, 40, 50, 60, 70, 80, 90, 100]) {
    let targets = 0, stops = 0, neither = 0;
    
    for (const signal of signals) {
      const startIdx = signal.idx;
      const entryPrice = signal.price;
      let hit = null;
      
      for (let j = startIdx + 1; j < Math.min(startIdx + 240, candles.length); j++) { // 4 hours max
        const c = candles[j];
        const moveDown = entryPrice - c.low;  // For SELL, want price to fall
        const moveUp = c.high - entryPrice;   // For SELL, this is adverse
        
        if (moveDown >= pts) { hit = 'target'; break; }
        if (moveUp >= pts) { hit = 'stop'; break; }
      }
      
      if (hit === 'target') targets++;
      else if (hit === 'stop') stops++;
      else neither++;
    }
    
    const total = targets + stops;
    const winRate = total > 0 ? (targets / total * 100).toFixed(1) : 'N/A';
    const edge = parseFloat(winRate) > 52 ? '✅ YES' : parseFloat(winRate) > 50 ? '⚠️ MAYBE' : '❌ NO';
    
    console.log(`${String(pts).padStart(11)} pts | ${String(targets).padStart(7)} | ${String(stops).padStart(6)} | ${String(winRate).padStart(5)}% | ${edge}`);
  }
}

main().catch(console.error);
