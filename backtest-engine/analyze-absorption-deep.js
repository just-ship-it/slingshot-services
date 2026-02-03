#!/usr/bin/env node
/**
 * Deep Absorption Pattern Analysis
 *
 * The initial analysis showed absorption at GEX levels has strong edge:
 * - Support absorption: 79% win rate
 * - Resistance absorption: 64% win rate
 *
 * This script analyzes the pattern in more detail to understand:
 * 1. What makes a good absorption signal?
 * 2. How does GEX regime affect outcomes?
 * 3. What's the optimal stop/target?
 * 4. Can we filter for even higher win rates?
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
        regime: snapshot.regime,
        totalGex: snapshot.total_gex
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

function findNearestLevel(price, gex, side) {
  if (!gex) return null;

  const allLevels = [];

  if (side === 'support') {
    allLevels.push({ level: gex.putWall, type: 'put_wall' });
    allLevels.push({ level: gex.gammaFlip, type: 'gamma_flip' });
    (gex.support || []).forEach((l, i) => allLevels.push({ level: l, type: `support_${i+1}` }));
  } else {
    allLevels.push({ level: gex.callWall, type: 'call_wall' });
    (gex.resistance || []).forEach((l, i) => allLevels.push({ level: l, type: `resistance_${i+1}` }));
  }

  let nearest = null;
  let minDist = Infinity;

  for (const { level, type } of allLevels) {
    if (!level) continue;
    const dist = Math.abs(price - level);
    if (dist < minDist) {
      minDist = dist;
      nearest = { level, type, distance: dist };
    }
  }

  return nearest;
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

function measureMFEMAE(candles, startIdx, side, maxBars = 60) {
  const entry = candles[startIdx].close;
  let mfe = 0, mae = 0;

  for (let j = startIdx + 1; j < Math.min(startIdx + maxBars, candles.length); j++) {
    const c = candles[j];
    if (side === 'long') {
      mfe = Math.max(mfe, c.high - entry);
      mae = Math.max(mae, entry - c.low);
    } else {
      mfe = Math.max(mfe, entry - c.low);
      mae = Math.max(mae, c.high - entry);
    }
  }

  return { mfe, mae };
}

function testSymmetricTargets(candles, startIdx, side, targets) {
  const entry = candles[startIdx].close;
  const results = {};

  for (const target of targets) {
    let hit = null;
    for (let j = startIdx + 1; j < Math.min(startIdx + 240, candles.length); j++) {
      const c = candles[j];
      if (side === 'long') {
        if (c.high - entry >= target) { hit = 'win'; break; }
        if (entry - c.low >= target) { hit = 'loss'; break; }
      } else {
        if (entry - c.low >= target) { hit = 'win'; break; }
        if (c.high - entry >= target) { hit = 'loss'; break; }
      }
    }
    results[target] = hit;
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  let startDate = new Date('2025-01-01');
  let endDate = new Date('2025-03-31');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') startDate = new Date(args[++i]);
    if (args[i] === '--end') endDate = new Date(args[++i]);
  }

  console.log('=== Deep Absorption Pattern Analysis ===\n');
  console.log(`Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

  console.log('Loading data...');
  const candles = await loadOHLCV(startDate, endDate);
  const candleMap = new Map();
  candles.forEach((c, i) => candleMap.set(c.timestamp, i));

  const imbalanceMap = await loadBookImbalance();
  const gexMap = await loadGexLevels(startDate, endDate);
  const cvdMap = await loadRealCVD(startDate, endDate, candles);

  console.log(`  ${candles.length.toLocaleString()} candles, ${gexMap.size} GEX, ${cvdMap.size} CVD\n`);

  // Collect absorption signals with detailed attributes
  const supportSignals = [];
  const resistanceSignals = [];

  const priceHistory = [];
  let lastSignalTime = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!isRTH(candle.timestamp)) continue;

    const imbData = imbalanceMap.get(candle.timestamp);
    const gex = getActiveGexLevels(gexMap, candle.timestamp);
    const cvdData = cvdMap.get(candle.timestamp);

    priceHistory.push({ ts: candle.timestamp, close: candle.close });
    if (priceHistory.length > 30) priceHistory.shift();

    if (!gex || !imbData || priceHistory.length < 10) continue;
    if (candle.timestamp - lastSignalTime < 900000) continue; // 15min cooldown

    const priceSlope = calculateSlope(priceHistory.map(h => h.close), 5);
    const totalVolume = imbData.totalBidSize + imbData.totalAskSize;
    const imbalance = imbData.sizeImbalance;

    // Support absorption: price falling, book balanced
    if (priceSlope < -0.3 && Math.abs(imbalance) < 0.08 && totalVolume > 30000) {
      const nearest = findNearestLevel(candle.close, gex, 'support');
      if (nearest && nearest.distance < 25) {
        const mfemae = measureMFEMAE(candles, i, 'long', 60);
        const outcomes = testSymmetricTargets(candles, i, 'long', [10, 15, 20, 25, 30, 40, 50]);

        supportSignals.push({
          idx: i,
          timestamp: candle.timestamp,
          price: candle.close,
          levelType: nearest.type,
          levelDistance: nearest.distance,
          imbalance: imbalance,
          volume: totalVolume,
          priceSlope: priceSlope,
          regime: gex.regime,
          mfe: mfemae.mfe,
          mae: mfemae.mae,
          outcomes
        });
        lastSignalTime = candle.timestamp;
      }
    }

    // Resistance absorption: price rising, book balanced
    if (priceSlope > 0.3 && Math.abs(imbalance) < 0.08 && totalVolume > 30000) {
      const nearest = findNearestLevel(candle.close, gex, 'resistance');
      if (nearest && nearest.distance < 25) {
        const mfemae = measureMFEMAE(candles, i, 'short', 60);
        const outcomes = testSymmetricTargets(candles, i, 'short', [10, 15, 20, 25, 30, 40, 50]);

        resistanceSignals.push({
          idx: i,
          timestamp: candle.timestamp,
          price: candle.close,
          levelType: nearest.type,
          levelDistance: nearest.distance,
          imbalance: imbalance,
          volume: totalVolume,
          priceSlope: priceSlope,
          regime: gex.regime,
          mfe: mfemae.mfe,
          mae: mfemae.mae,
          outcomes
        });
        lastSignalTime = candle.timestamp;
      }
    }
  }

  console.log('='.repeat(80));
  console.log('SUPPORT ABSORPTION ANALYSIS (LONG)');
  console.log('='.repeat(80));
  console.log(`\nTotal signals: ${supportSignals.length}\n`);

  // Analyze by level type
  console.log('BY LEVEL TYPE:');
  console.log('-'.repeat(60));
  const supportByType = {};
  for (const s of supportSignals) {
    if (!supportByType[s.levelType]) supportByType[s.levelType] = [];
    supportByType[s.levelType].push(s);
  }

  for (const [type, signals] of Object.entries(supportByType)) {
    const wins30 = signals.filter(s => s.outcomes[30] === 'win').length;
    const losses30 = signals.filter(s => s.outcomes[30] === 'loss').length;
    const total = wins30 + losses30;
    const winRate = total > 0 ? (wins30 / total * 100) : 0;
    const avgMfe = signals.reduce((s, x) => s + x.mfe, 0) / signals.length;
    const avgMae = signals.reduce((s, x) => s + x.mae, 0) / signals.length;

    console.log(`${type.padEnd(15)} | n=${String(signals.length).padStart(3)} | Win%=${winRate.toFixed(1).padStart(5)}% | MFE=${avgMfe.toFixed(0).padStart(3)} | MAE=${avgMae.toFixed(0).padStart(3)}`);
  }

  // Analyze by GEX regime
  console.log('\nBY GEX REGIME:');
  console.log('-'.repeat(60));
  const supportByRegime = {};
  for (const s of supportSignals) {
    const regime = s.regime || 'unknown';
    if (!supportByRegime[regime]) supportByRegime[regime] = [];
    supportByRegime[regime].push(s);
  }

  for (const [regime, signals] of Object.entries(supportByRegime)) {
    const wins30 = signals.filter(s => s.outcomes[30] === 'win').length;
    const losses30 = signals.filter(s => s.outcomes[30] === 'loss').length;
    const total = wins30 + losses30;
    const winRate = total > 0 ? (wins30 / total * 100) : 0;

    console.log(`${regime.padEnd(20)} | n=${String(signals.length).padStart(3)} | Win%=${winRate.toFixed(1).padStart(5)}%`);
  }

  // Analyze by proximity
  console.log('\nBY LEVEL PROXIMITY:');
  console.log('-'.repeat(60));
  const buckets = [[0, 5], [5, 10], [10, 15], [15, 20], [20, 25]];
  for (const [min, max] of buckets) {
    const signals = supportSignals.filter(s => s.levelDistance >= min && s.levelDistance < max);
    if (signals.length < 5) continue;
    const wins30 = signals.filter(s => s.outcomes[30] === 'win').length;
    const losses30 = signals.filter(s => s.outcomes[30] === 'loss').length;
    const total = wins30 + losses30;
    const winRate = total > 0 ? (wins30 / total * 100) : 0;

    console.log(`${min}-${max} pts from level | n=${String(signals.length).padStart(3)} | Win%=${winRate.toFixed(1).padStart(5)}%`);
  }

  // Optimal target analysis
  console.log('\nOPTIMAL TARGET ANALYSIS:');
  console.log('-'.repeat(60));
  console.log('Target | Wins | Losses | Win% | Expectancy');

  for (const target of [10, 15, 20, 25, 30, 40, 50]) {
    const wins = supportSignals.filter(s => s.outcomes[target] === 'win').length;
    const losses = supportSignals.filter(s => s.outcomes[target] === 'loss').length;
    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100) : 0;
    const expectancy = total > 0 ? ((wins * target - losses * target) / supportSignals.length) : 0;

    console.log(`${String(target).padStart(6)} | ${String(wins).padStart(4)} | ${String(losses).padStart(6)} | ${winRate.toFixed(1).padStart(5)}% | ${expectancy.toFixed(2).padStart(8)} pts`);
  }

  // MFE/MAE distribution
  console.log('\nMFE/MAE DISTRIBUTION:');
  console.log('-'.repeat(60));
  const avgMfe = supportSignals.reduce((s, x) => s + x.mfe, 0) / supportSignals.length;
  const avgMae = supportSignals.reduce((s, x) => s + x.mae, 0) / supportSignals.length;
  const medianMfe = supportSignals.map(s => s.mfe).sort((a,b) => a-b)[Math.floor(supportSignals.length/2)];
  const medianMae = supportSignals.map(s => s.mae).sort((a,b) => a-b)[Math.floor(supportSignals.length/2)];

  console.log(`Average MFE: ${avgMfe.toFixed(1)} pts | Median MFE: ${medianMfe.toFixed(1)} pts`);
  console.log(`Average MAE: ${avgMae.toFixed(1)} pts | Median MAE: ${medianMae.toFixed(1)} pts`);

  // =======================================================================
  console.log('\n' + '='.repeat(80));
  console.log('RESISTANCE ABSORPTION ANALYSIS (SHORT)');
  console.log('='.repeat(80));
  console.log(`\nTotal signals: ${resistanceSignals.length}\n`);

  // By level type
  console.log('BY LEVEL TYPE:');
  console.log('-'.repeat(60));
  const resByType = {};
  for (const s of resistanceSignals) {
    if (!resByType[s.levelType]) resByType[s.levelType] = [];
    resByType[s.levelType].push(s);
  }

  for (const [type, signals] of Object.entries(resByType)) {
    const wins30 = signals.filter(s => s.outcomes[30] === 'win').length;
    const losses30 = signals.filter(s => s.outcomes[30] === 'loss').length;
    const total = wins30 + losses30;
    const winRate = total > 0 ? (wins30 / total * 100) : 0;
    const avgMfe = signals.reduce((s, x) => s + x.mfe, 0) / signals.length;
    const avgMae = signals.reduce((s, x) => s + x.mae, 0) / signals.length;

    console.log(`${type.padEnd(15)} | n=${String(signals.length).padStart(3)} | Win%=${winRate.toFixed(1).padStart(5)}% | MFE=${avgMfe.toFixed(0).padStart(3)} | MAE=${avgMae.toFixed(0).padStart(3)}`);
  }

  // By regime
  console.log('\nBY GEX REGIME:');
  console.log('-'.repeat(60));
  const resByRegime = {};
  for (const s of resistanceSignals) {
    const regime = s.regime || 'unknown';
    if (!resByRegime[regime]) resByRegime[regime] = [];
    resByRegime[regime].push(s);
  }

  for (const [regime, signals] of Object.entries(resByRegime)) {
    const wins30 = signals.filter(s => s.outcomes[30] === 'win').length;
    const losses30 = signals.filter(s => s.outcomes[30] === 'loss').length;
    const total = wins30 + losses30;
    const winRate = total > 0 ? (wins30 / total * 100) : 0;

    console.log(`${regime.padEnd(20)} | n=${String(signals.length).padStart(3)} | Win%=${winRate.toFixed(1).padStart(5)}%`);
  }

  // Optimal targets
  console.log('\nOPTIMAL TARGET ANALYSIS:');
  console.log('-'.repeat(60));
  console.log('Target | Wins | Losses | Win% | Expectancy');

  for (const target of [10, 15, 20, 25, 30, 40, 50]) {
    const wins = resistanceSignals.filter(s => s.outcomes[target] === 'win').length;
    const losses = resistanceSignals.filter(s => s.outcomes[target] === 'loss').length;
    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100) : 0;
    const expectancy = total > 0 ? ((wins * target - losses * target) / resistanceSignals.length) : 0;

    console.log(`${String(target).padStart(6)} | ${String(wins).padStart(4)} | ${String(losses).padStart(6)} | ${winRate.toFixed(1).padStart(5)}% | ${expectancy.toFixed(2).padStart(8)} pts`);
  }

  // COMBINED FILTERS
  console.log('\n' + '='.repeat(80));
  console.log('FILTERED SIGNAL ANALYSIS');
  console.log('='.repeat(80));

  // Best support filter: close to level + positive regime
  const filteredSupport = supportSignals.filter(s =>
    s.levelDistance < 15 &&
    (s.regime === 'positive' || s.regime === 'strong_positive')
  );

  console.log(`\nSupport + Close (<15pts) + Positive Regime (n=${filteredSupport.length}):`);
  if (filteredSupport.length >= 5) {
    for (const target of [20, 30, 40]) {
      const wins = filteredSupport.filter(s => s.outcomes[target] === 'win').length;
      const losses = filteredSupport.filter(s => s.outcomes[target] === 'loss').length;
      const total = wins + losses;
      const winRate = total > 0 ? (wins / total * 100) : 0;
      console.log(`  ${target}pt target: ${winRate.toFixed(1)}% win rate (${wins}W/${losses}L)`);
    }
  }

  // Best resistance filter: close to level + negative regime
  const filteredResistance = resistanceSignals.filter(s =>
    s.levelDistance < 15 &&
    (s.regime === 'negative' || s.regime === 'strong_negative')
  );

  console.log(`\nResistance + Close (<15pts) + Negative Regime (n=${filteredResistance.length}):`);
  if (filteredResistance.length >= 5) {
    for (const target of [20, 30, 40]) {
      const wins = filteredResistance.filter(s => s.outcomes[target] === 'win').length;
      const losses = filteredResistance.filter(s => s.outcomes[target] === 'loss').length;
      const total = wins + losses;
      const winRate = total > 0 ? (wins / total * 100) : 0;
      console.log(`  ${target}pt target: ${winRate.toFixed(1)}% win rate (${wins}W/${losses}L)`);
    }
  }

  console.log('\n=== Analysis Complete ===');
}

main().catch(console.error);
