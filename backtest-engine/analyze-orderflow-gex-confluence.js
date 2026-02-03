#!/usr/bin/env node
/**
 * Order Flow + GEX Confluence Analysis
 *
 * Combines:
 * - Real CVD from Databento trades
 * - Book imbalance from MBP-1
 * - GEX support/resistance levels
 *
 * Looks for signals where order flow confirms or diverges from GEX level behavior.
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
  proximityThreshold: 15, // Points from GEX level to consider "at level"
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

    // Handle both formats: content.data (new) and content.snapshots (old)
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

  console.log(`  Loaded GEX from ${files.filter(f => {
    const m = f.match(/nq_gex_(\d{4}-\d{2}-\d{2})/);
    if (!m) return false;
    const d = new Date(m[1]);
    return d >= startDate && d <= endDate;
  }).length} files`);

  return gexMap;
}

async function loadRealCVD(startDate, endDate, candles) {
  const loader = new DatabentoTradeLoader({ dataDir: CONFIG.tradesDir, symbolFilter: 'NQ' });
  console.log('  Loading CVD from Databento trades...');
  const cvdMap = await loader.computeCVDForCandlesStreaming(startDate, endDate, candles, (days, trades) => {
    if (days % 20 === 0) process.stdout.write(`\r    Day ${days}: ${trades.toLocaleString()} trades`);
  });
  process.stdout.write('\r' + ' '.repeat(50) + '\r');
  return cvdMap;
}

function getActiveGexLevels(gexMap, timestamp) {
  // Find most recent GEX snapshot (they're 15-min intervals)
  let bestTs = null;
  for (const ts of gexMap.keys()) {
    if (ts <= timestamp && (!bestTs || ts > bestTs)) bestTs = ts;
  }
  return bestTs ? gexMap.get(bestTs) : null;
}

function isNearLevel(price, level, threshold) {
  return Math.abs(price - level) <= threshold;
}

function classifyGexProximity(price, gex, threshold) {
  if (!gex) return null;

  // Check all support levels
  const allSupports = [gex.putWall, ...(gex.support || [])].filter(Boolean);
  const allResistance = [gex.callWall, ...(gex.resistance || [])].filter(Boolean);

  for (const level of allSupports) {
    if (isNearLevel(price, level, threshold)) {
      return { type: 'support', level, distance: price - level };
    }
  }

  for (const level of allResistance) {
    if (isNearLevel(price, level, threshold)) {
      return { type: 'resistance', level, distance: price - level };
    }
  }

  if (gex.gammaFlip && isNearLevel(price, gex.gammaFlip, threshold)) {
    return { type: 'gamma_flip', level: gex.gammaFlip, distance: price - gex.gammaFlip };
  }

  return null;
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

function measureOutcome(candles, startIdx, side, targets) {
  const entry = candles[startIdx].close;
  const results = {};

  for (const target of targets) {
    let hit = null;
    for (let j = startIdx + 1; j < Math.min(startIdx + 240, candles.length); j++) {
      const c = candles[j];
      if (side === 'long') {
        if (c.high - entry >= target) { hit = 'target'; break; }
        if (entry - c.low >= target) { hit = 'stop'; break; }
      } else {
        if (entry - c.low >= target) { hit = 'target'; break; }
        if (c.high - entry >= target) { hit = 'stop'; break; }
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

  console.log('=== Order Flow + GEX Confluence Analysis ===\n');
  console.log(`Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

  console.log('Loading data...');
  const candles = await loadOHLCV(startDate, endDate);
  const candleMap = new Map();
  candles.forEach((c, i) => candleMap.set(c.timestamp, i));
  console.log(`  ${candles.length.toLocaleString()} candles`);

  const imbalanceMap = await loadBookImbalance();
  console.log(`  ${imbalanceMap.size.toLocaleString()} book imbalance records`);

  const gexMap = await loadGexLevels(startDate, endDate);
  console.log(`  ${gexMap.size.toLocaleString()} GEX snapshots`);

  const cvdMap = await loadRealCVD(startDate, endDate, candles);
  console.log(`  ${cvdMap.size.toLocaleString()} CVD records`);

  // Track signals
  const signals = {
    // At GEX Support with bullish order flow
    supportBullishOF: [],
    // At GEX Support with bearish order flow (divergence)
    supportBearishOF: [],
    // At GEX Resistance with bearish order flow
    resistanceBearishOF: [],
    // At GEX Resistance with bullish order flow (divergence)
    resistanceBullishOF: [],
    // Absorption at support (bearish pressure but price holding)
    supportAbsorption: [],
    // Absorption at resistance (bullish pressure but price holding)
    resistanceAbsorption: [],
  };

  const cvdHistory = [];
  const priceHistory = [];
  let lastSignalTime = 0;

  console.log('\nScanning for confluence signals...');

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!isRTH(candle.timestamp)) continue;

    const cvdData = cvdMap.get(candle.timestamp);
    const imbData = imbalanceMap.get(candle.timestamp);
    const gex = getActiveGexLevels(gexMap, candle.timestamp);

    if (cvdData) {
      cvdHistory.push({ ts: candle.timestamp, cvd: cvdData.cumulativeDelta });
      if (cvdHistory.length > 30) cvdHistory.shift();
    }
    priceHistory.push({ ts: candle.timestamp, close: candle.close });
    if (priceHistory.length > 30) priceHistory.shift();

    if (cvdHistory.length < 10 || !gex) continue;
    if (candle.timestamp - lastSignalTime < 900000) continue; // 15min cooldown

    const proximity = classifyGexProximity(candle.close, gex, CONFIG.proximityThreshold);
    if (!proximity) continue;

    const cvdSlope = calculateSlope(cvdHistory.map(h => h.cvd), 5);
    const priceSlope = calculateSlope(priceHistory.map(h => h.close), 5);
    const totalVolume = (imbData?.totalBidSize || 0) + (imbData?.totalAskSize || 0);
    const imbalance = imbData?.sizeImbalance || 0;

    const signal = { idx: i, timestamp: candle.timestamp, price: candle.close, ...proximity, cvdSlope, priceSlope, imbalance };

    // Classify signal type
    if (proximity.type === 'support' || proximity.type === 'gamma_flip') {
      // At support - look for bullish or bearish order flow

      // Absorption: price fell to support, book is balanced (bids absorbing sells)
      if (priceSlope < -0.3 && Math.abs(imbalance) < 0.05 && totalVolume > 50000) {
        signals.supportAbsorption.push({ ...signal, side: 'long' });
        lastSignalTime = candle.timestamp;
      }
      // Bullish order flow at support (CVD rising)
      else if (cvdSlope > 30) {
        signals.supportBullishOF.push({ ...signal, side: 'long' });
        lastSignalTime = candle.timestamp;
      }
      // Bearish order flow at support (divergence - bearish OF but price at support)
      else if (cvdSlope < -50) {
        signals.supportBearishOF.push({ ...signal, side: 'short' });
        lastSignalTime = candle.timestamp;
      }
    }
    else if (proximity.type === 'resistance') {
      // At resistance - look for bearish or bullish order flow

      // Absorption: price rose to resistance, book is balanced (asks absorbing buys)
      if (priceSlope > 0.3 && Math.abs(imbalance) < 0.05 && totalVolume > 50000) {
        signals.resistanceAbsorption.push({ ...signal, side: 'short' });
        lastSignalTime = candle.timestamp;
      }
      // Bearish order flow at resistance (CVD falling)
      else if (cvdSlope < -30) {
        signals.resistanceBearishOF.push({ ...signal, side: 'short' });
        lastSignalTime = candle.timestamp;
      }
      // Bullish order flow at resistance (divergence)
      else if (cvdSlope > 50) {
        signals.resistanceBullishOF.push({ ...signal, side: 'long' });
        lastSignalTime = candle.timestamp;
      }
    }
  }

  // Analyze each signal type
  console.log('\n' + '='.repeat(80));
  console.log('CONFLUENCE SIGNAL ANALYSIS');
  console.log('='.repeat(80) + '\n');

  const targets = [20, 30, 40, 50];

  for (const [name, signalList] of Object.entries(signals)) {
    if (signalList.length < 5) continue;

    console.log(`\n${name.toUpperCase()} (n=${signalList.length}):`);
    console.log('-'.repeat(60));

    const side = signalList[0]?.side || 'long';
    const results = { };
    for (const t of targets) results[t] = { target: 0, stop: 0, neither: 0 };

    for (const sig of signalList) {
      const outcomes = measureOutcome(candles, sig.idx, side, targets);
      for (const t of targets) {
        if (outcomes[t] === 'target') results[t].target++;
        else if (outcomes[t] === 'stop') results[t].stop++;
        else results[t].neither++;
      }
    }

    console.log('Symmetric Stop/Target Analysis:');
    console.log('Target | Wins | Losses | Win% | Expectancy');
    console.log('-'.repeat(50));

    for (const t of targets) {
      const r = results[t];
      const total = r.target + r.stop;
      const winRate = total > 0 ? (r.target / total * 100) : 0;
      const expectancy = total > 0 ? ((r.target * t - r.stop * t) / signalList.length) : 0;
      const edge = winRate > 55 ? '✅' : winRate > 52 ? '⚠️' : '❌';

      console.log(
        `${String(t).padStart(6)} pts | ${String(r.target).padStart(4)} | ${String(r.stop).padStart(6)} | ${winRate.toFixed(1).padStart(5)}% | ${expectancy.toFixed(2).padStart(8)} pts ${edge}`
      );
    }
  }

  // Summary statistics
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY: Best Confluence Patterns');
  console.log('='.repeat(80) + '\n');

  const summary = [];
  for (const [name, signalList] of Object.entries(signals)) {
    if (signalList.length < 10) continue;

    const side = signalList[0]?.side || 'long';
    let wins = 0, losses = 0;

    for (const sig of signalList) {
      const outcomes = measureOutcome(candles, sig.idx, side, [30]);
      if (outcomes[30] === 'target') wins++;
      else if (outcomes[30] === 'stop') losses++;
    }

    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100) : 0;

    summary.push({ name, signals: signalList.length, side, wins, losses, winRate });
  }

  summary.sort((a, b) => b.winRate - a.winRate);

  console.log('Pattern                    | Signals | Side  | Win Rate | Edge');
  console.log('-'.repeat(70));

  for (const s of summary) {
    const edge = s.winRate > 55 ? '✅ STRONG' : s.winRate > 52 ? '⚠️ WEAK' : '❌ NONE';
    console.log(
      `${s.name.padEnd(26)} | ${String(s.signals).padStart(7)} | ${s.side.padEnd(5)} | ${s.winRate.toFixed(1).padStart(7)}% | ${edge}`
    );
  }

  console.log('\n=== Analysis Complete ===');
}

main().catch(console.error);
