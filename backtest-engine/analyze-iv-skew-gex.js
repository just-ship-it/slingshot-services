#!/usr/bin/env node
/**
 * Deep Dive: IV Skew + GEX Level Analysis
 *
 * The initial analysis showed IV skew (put-call) is highly predictive:
 * - Negative skew (complacency): 71.5% win rate
 * - Positive skew (fear): 30.7% win rate
 *
 * This script explores:
 * 1. IV skew thresholds for optimal signal filtering
 * 2. Combining IV skew with outer GEX levels (S3+, R3+)
 * 3. Time-of-day filtering
 * 4. Forward return horizons (which works best?)
 * 5. Walk-forward validation
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  ohlcvFile: path.join(__dirname, 'data/ohlcv/nq/NQ_ohlcv_1m.csv'),
  bookImbalanceFile: path.join(__dirname, 'data/orderflow/nq/book-imbalance-1m.csv'),
  ivFile: path.join(__dirname, 'data/iv/qqq/qqq_atm_iv_15m.csv'),
  gexDir: path.join(__dirname, 'data/gex/nq'),
};

// ============= Data Loaders =============

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
      resolve(filterPrimaryContract(candles));
    });
    rl.on('error', reject);
  });
}

function filterPrimaryContract(candles) {
  const hourlyVolume = new Map();
  candles.forEach(c => {
    const hourKey = Math.floor(c.timestamp / (60 * 60 * 1000));
    if (!hourlyVolume.has(hourKey)) hourlyVolume.set(hourKey, new Map());
    const symbolVol = hourlyVolume.get(hourKey);
    symbolVol.set(c.symbol, (symbolVol.get(c.symbol) || 0) + c.volume);
  });

  const hourlyPrimary = new Map();
  hourlyVolume.forEach((symbolVol, hourKey) => {
    let maxVol = 0, primary = null;
    symbolVol.forEach((vol, sym) => {
      if (vol > maxVol) { maxVol = vol; primary = sym; }
    });
    hourlyPrimary.set(hourKey, primary);
  });

  return candles.filter(c => {
    const hourKey = Math.floor(c.timestamp / (60 * 60 * 1000));
    return c.symbol === hourlyPrimary.get(hourKey);
  });
}

async function loadBookImbalance() {
  return new Promise((resolve, reject) => {
    const map = new Map();
    let headers = null;
    const stream = fs.createReadStream(CONFIG.bookImbalanceFile);
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
      });
    });
    rl.on('close', () => resolve(map));
    rl.on('error', reject);
  });
}

async function loadIVData() {
  return new Promise((resolve, reject) => {
    const data = [];
    let headers = null;
    const stream = fs.createReadStream(CONFIG.ivFile);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!headers) { headers = line.split(','); return; }
      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);
      data.push({
        timestamp: new Date(record.timestamp).getTime(),
        iv: parseFloat(record.iv),
        spotPrice: parseFloat(record.spot_price),
        callIV: parseFloat(record.call_iv),
        putIV: parseFloat(record.put_iv),
        dte: parseInt(record.dte),
        skew: parseFloat(record.put_iv) - parseFloat(record.call_iv)
      });
    });
    rl.on('close', () => { data.sort((a, b) => a.timestamp - b.timestamp); resolve(data); });
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

function getIVAtTime(ivData, timestamp) {
  let best = null;
  for (const iv of ivData) {
    if (iv.timestamp <= timestamp) best = iv;
    else break;
  }
  return best;
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

function getETHour(timestamp) {
  const date = new Date(timestamp);
  return parseInt(date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
}

function getGexProximity(price, gexLevels, levelFilter = null) {
  if (!gexLevels) return null;

  const allLevels = [];

  (gexLevels.support || []).forEach((level, i) => {
    if (level) allLevels.push({ type: `S${i+1}`, level, category: 'support', index: i+1 });
  });

  (gexLevels.resistance || []).forEach((level, i) => {
    if (level) allLevels.push({ type: `R${i+1}`, level, category: 'resistance', index: i+1 });
  });

  if (gexLevels.callWall) allLevels.push({ type: 'CallWall', level: gexLevels.callWall, category: 'resistance', index: 99 });
  if (gexLevels.putWall) allLevels.push({ type: 'PutWall', level: gexLevels.putWall, category: 'support', index: 99 });
  if (gexLevels.gammaFlip) allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'neutral', index: 0 });

  // Apply filter if specified
  const filteredLevels = levelFilter
    ? allLevels.filter(l => levelFilter.includes(l.type))
    : allLevels;

  let nearest = null;
  let nearestDist = Infinity;

  for (const lvl of filteredLevels) {
    const dist = Math.abs(price - lvl.level);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = { ...lvl, distance: dist, direction: price > lvl.level ? 'above' : 'below' };
    }
  }

  return nearest;
}

function calculateForwardReturns(candles, idx, periods = [5, 10, 15, 30, 60]) {
  const returns = {};
  const entryPrice = candles[idx].close;

  for (const p of periods) {
    if (idx + p < candles.length) {
      const exitPrice = candles[idx + p].close;
      returns[`pts_${p}m`] = exitPrice - entryPrice;
    }
  }

  let maxFav = 0, maxAdv = 0;
  const lookforward = Math.min(60, candles.length - idx - 1);
  for (let i = 1; i <= lookforward; i++) {
    const high = candles[idx + i].high;
    const low = candles[idx + i].low;
    maxFav = Math.max(maxFav, high - entryPrice);
    maxAdv = Math.min(maxAdv, low - entryPrice);
  }

  returns.mfe_60m = maxFav;
  returns.mae_60m = maxAdv;

  return returns;
}

// ============= Analysis Functions =============

function analyzeCondition(observations, name, short = false) {
  const withRet = observations.filter(o => o.forwardReturns.pts_15m !== undefined);
  if (withRet.length < 5) return null;

  const returns5 = withRet.map(o => short ? -o.forwardReturns.pts_5m : o.forwardReturns.pts_5m);
  const returns10 = withRet.map(o => short ? -o.forwardReturns.pts_10m : o.forwardReturns.pts_10m);
  const returns15 = withRet.map(o => short ? -o.forwardReturns.pts_15m : o.forwardReturns.pts_15m);
  const returns30 = withRet.map(o => short ? -(o.forwardReturns.pts_30m || 0) : (o.forwardReturns.pts_30m || 0));

  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const winRate = arr => arr.filter(v => v > 0).length / arr.length * 100;

  const mfe = short
    ? withRet.map(o => -o.forwardReturns.mae_60m)
    : withRet.map(o => o.forwardReturns.mfe_60m);

  const mae = short
    ? withRet.map(o => -o.forwardReturns.mfe_60m)
    : withRet.map(o => Math.abs(o.forwardReturns.mae_60m));

  return {
    name,
    count: withRet.length,
    avg5m: avg(returns5),
    avg10m: avg(returns10),
    avg15m: avg(returns15),
    avg30m: avg(returns30),
    winRate5m: winRate(returns5),
    winRate10m: winRate(returns10),
    winRate15m: winRate(returns15),
    winRate30m: winRate(returns30),
    avgMFE: avg(mfe),
    avgMAE: avg(mae),
    observations: withRet
  };
}

// ============= Main Analysis =============

async function main() {
  const startDate = new Date('2025-01-02');
  const endDate = new Date('2025-01-25');

  console.log('=== IV Skew + GEX Level Deep Analysis ===\n');
  console.log(`Period: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)}\n`);

  console.log('Loading data...');
  const [candles, bookImbalance, ivData, gexMap] = await Promise.all([
    loadOHLCV(startDate, endDate),
    loadBookImbalance(),
    loadIVData(),
    loadGexLevels(startDate, endDate)
  ]);

  console.log(`  Candles: ${candles.length}`);
  console.log(`  IV Records: ${ivData.length}`);
  console.log(`  GEX Snapshots: ${gexMap.size}\n`);

  // Collect all observations with IV data
  const observations = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!isRTH(candle.timestamp)) continue;

    const gex = getActiveGexLevels(gexMap, candle.timestamp);
    if (!gex) continue;

    const proximity = getGexProximity(candle.close, gex);
    if (!proximity || proximity.distance > 25) continue;

    const iv = getIVAtTime(ivData, candle.timestamp);
    if (!iv) continue;

    const bookData = bookImbalance.get(candle.timestamp);
    const forwardReturns = calculateForwardReturns(candles, i);
    const hour = getETHour(candle.timestamp);

    observations.push({
      timestamp: candle.timestamp,
      price: candle.close,
      level: proximity,
      iv,
      bookData,
      forwardReturns,
      hour
    });
  }

  console.log(`Collected ${observations.length} observations with IV data\n`);

  // ============= Analysis 1: IV Skew Threshold Optimization =============
  console.log('=== Analysis 1: IV Skew Threshold Optimization ===\n');
  console.log('Finding optimal skew thresholds for LONG signals...\n');

  const skewThresholds = [-0.03, -0.02, -0.015, -0.01, -0.005, 0, 0.005, 0.01, 0.015, 0.02, 0.03];

  console.log('Max Skew Thresh | Count | Avg 15m | Win% 15m | Avg MFE | Avg MAE');
  console.log('-'.repeat(70));

  for (const thresh of skewThresholds) {
    const filtered = observations.filter(o => o.iv.skew < thresh && o.level.category === 'support');
    const result = analyzeCondition(filtered, `skew < ${thresh}`, false);
    if (result && result.count >= 10) {
      console.log(`${thresh.toFixed(3).padStart(14)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(1).padStart(8)}% | ${result.avgMFE.toFixed(0).padStart(7)} | ${result.avgMAE.toFixed(0).padStart(7)}`);
    }
  }

  // ============= Analysis 2: Outer Levels + IV Skew =============
  console.log('\n=== Analysis 2: Outer GEX Levels + IV Skew ===\n');

  const outerSupportLevels = ['S3', 'S4', 'S5', 'PutWall'];
  const outerResistLevels = ['R3', 'R4', 'R5', 'CallWall'];

  const scenarios = [
    {
      name: 'LONG: S3+ + Negative Skew (<-0.01)',
      filter: o => outerSupportLevels.includes(o.level.type) && o.iv.skew < -0.01,
      short: false
    },
    {
      name: 'LONG: S3+ + Very Neg Skew (<-0.02)',
      filter: o => outerSupportLevels.includes(o.level.type) && o.iv.skew < -0.02,
      short: false
    },
    {
      name: 'LONG: S2+ + Negative Skew (<-0.01)',
      filter: o => ['S2', 'S3', 'S4', 'S5', 'PutWall'].includes(o.level.type) && o.iv.skew < -0.01,
      short: false
    },
    {
      name: 'LONG: Any Support + Neg Skew (<-0.01)',
      filter: o => o.level.category === 'support' && o.iv.skew < -0.01,
      short: false
    },
    {
      name: 'SHORT: R3+ + Positive Skew (>0.01)',
      filter: o => outerResistLevels.includes(o.level.type) && o.iv.skew > 0.01,
      short: true
    },
    {
      name: 'SHORT: Any Resist + Pos Skew (>0.01)',
      filter: o => o.level.category === 'resistance' && o.iv.skew > 0.01,
      short: true
    },
  ];

  console.log('Condition                                | Count | Avg Pts | Win% | MFE  | MAE  | Edge');
  console.log('-'.repeat(95));

  for (const { name, filter, short } of scenarios) {
    const filtered = observations.filter(filter);
    const result = analyzeCondition(filtered, name, short);
    if (result) {
      const edge = result.avgMFE / result.avgMAE;
      console.log(`${name.padEnd(40)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)} | ${edge.toFixed(2).padStart(5)}`);
    }
  }

  // ============= Analysis 3: Time-of-Day + IV Skew =============
  console.log('\n=== Analysis 3: Time-of-Day + IV Skew Filtering ===\n');

  const timeFilters = [
    { name: 'All RTH (9:30-16:00)', filter: o => true },
    { name: 'Avoid Open (11:00-16:00)', filter: o => o.hour >= 11 },
    { name: 'Mid-day Only (11:00-14:00)', filter: o => o.hour >= 11 && o.hour < 14 },
    { name: 'Late Session (13:00-16:00)', filter: o => o.hour >= 13 },
  ];

  console.log('LONG at Support + Negative Skew (<-0.01), by Time Filter:\n');
  console.log('Time Filter              | Count | Avg 15m | Win% | MFE  | MAE');
  console.log('-'.repeat(70));

  const baseFilter = o => o.level.category === 'support' && o.iv.skew < -0.01;

  for (const { name, filter } of timeFilters) {
    const filtered = observations.filter(o => baseFilter(o) && filter(o));
    const result = analyzeCondition(filtered, name, false);
    if (result && result.count >= 5) {
      console.log(`${name.padEnd(24)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)}`);
    }
  }

  // ============= Analysis 4: Forward Return Horizon Comparison =============
  console.log('\n=== Analysis 4: Optimal Holding Period ===\n');

  const bestCondition = o => o.level.category === 'support' && o.iv.skew < -0.01 && o.hour >= 11;
  const bestFiltered = observations.filter(bestCondition);
  const bestResult = analyzeCondition(bestFiltered, 'Best Condition', false);

  if (bestResult) {
    console.log('Support + Negative Skew + After 11 AM:\n');
    console.log('Horizon | Avg Pts | Win Rate');
    console.log('-'.repeat(35));
    console.log(`5 min   | ${bestResult.avg5m.toFixed(1).padStart(7)} | ${bestResult.winRate5m.toFixed(1)}%`);
    console.log(`10 min  | ${bestResult.avg10m.toFixed(1).padStart(7)} | ${bestResult.winRate10m.toFixed(1)}%`);
    console.log(`15 min  | ${bestResult.avg15m.toFixed(1).padStart(7)} | ${bestResult.winRate15m.toFixed(1)}%`);
    console.log(`30 min  | ${bestResult.avg30m.toFixed(1).padStart(7)} | ${bestResult.winRate30m.toFixed(1)}%`);
    console.log(`\nMFE (60m): ${bestResult.avgMFE.toFixed(1)} pts`);
    console.log(`MAE (60m): ${bestResult.avgMAE.toFixed(1)} pts`);
  }

  // ============= Analysis 5: Walk-Forward Validation =============
  console.log('\n=== Analysis 5: Walk-Forward Validation ===\n');

  // Split into weeks
  const weeks = [
    { name: 'Week 1 (Jan 2-8)', start: new Date('2025-01-02'), end: new Date('2025-01-08') },
    { name: 'Week 2 (Jan 9-15)', start: new Date('2025-01-09'), end: new Date('2025-01-15') },
    { name: 'Week 3 (Jan 16-22)', start: new Date('2025-01-16'), end: new Date('2025-01-22') },
    { name: 'Week 4 (Jan 23-25)', start: new Date('2025-01-23'), end: new Date('2025-01-25') },
  ];

  console.log('LONG at Support + Negative Skew (<-0.01) + After 11 AM:\n');
  console.log('Week                | Count | Avg 15m | Win% | MFE  | MAE');
  console.log('-'.repeat(65));

  for (const week of weeks) {
    const weekObs = observations.filter(o => {
      const date = new Date(o.timestamp);
      return date >= week.start && date < week.end &&
             o.level.category === 'support' &&
             o.iv.skew < -0.01 &&
             o.hour >= 11;
    });

    const result = analyzeCondition(weekObs, week.name, false);
    if (result) {
      console.log(`${week.name.padEnd(19)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)}`);
    } else {
      console.log(`${week.name.padEnd(19)} | insufficient data`);
    }
  }

  // ============= Analysis 6: Order Flow Combined with IV Skew =============
  console.log('\n=== Analysis 6: Order Flow + IV Skew Combinations ===\n');

  const ofCombos = [
    {
      name: 'Support + NegSkew + Balanced OF',
      filter: o => o.level.category === 'support' && o.iv.skew < -0.01 && o.bookData && Math.abs(o.bookData.sizeImbalance) < 0.1
    },
    {
      name: 'Support + NegSkew + Bid Dominant',
      filter: o => o.level.category === 'support' && o.iv.skew < -0.01 && o.bookData && o.bookData.sizeImbalance > 0.1
    },
    {
      name: 'Support + NegSkew + Ask Dominant',
      filter: o => o.level.category === 'support' && o.iv.skew < -0.01 && o.bookData && o.bookData.sizeImbalance < -0.1
    },
    {
      name: 'Support + NegSkew + High Volume',
      filter: o => o.level.category === 'support' && o.iv.skew < -0.01 && o.bookData && (o.bookData.totalBidSize + o.bookData.totalAskSize) > 40000
    },
  ];

  console.log('Condition                           | Count | Avg 15m | Win% | MFE  | MAE');
  console.log('-'.repeat(80));

  for (const { name, filter } of ofCombos) {
    const filtered = observations.filter(filter);
    const result = analyzeCondition(filtered, name, false);
    if (result) {
      console.log(`${name.padEnd(35)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)}`);
    }
  }

  // ============= Analysis 7: IV Level (not just skew) =============
  console.log('\n=== Analysis 7: Absolute IV Level Effects ===\n');

  const ivLevelCombos = [
    { name: 'Low IV (<0.18) + Neg Skew', filter: o => o.iv.iv < 0.18 && o.iv.skew < -0.01 },
    { name: 'Med IV (0.18-0.22) + Neg Skew', filter: o => o.iv.iv >= 0.18 && o.iv.iv < 0.22 && o.iv.skew < -0.01 },
    { name: 'High IV (>0.22) + Neg Skew', filter: o => o.iv.iv >= 0.22 && o.iv.skew < -0.01 },
    { name: 'Low IV (<0.18) + Pos Skew', filter: o => o.iv.iv < 0.18 && o.iv.skew > 0.01 },
    { name: 'Med IV (0.18-0.22) + Pos Skew', filter: o => o.iv.iv >= 0.18 && o.iv.iv < 0.22 && o.iv.skew > 0.01 },
    { name: 'High IV (>0.22) + Pos Skew', filter: o => o.iv.iv >= 0.22 && o.iv.skew > 0.01 },
  ];

  console.log('At Support Levels:\n');
  console.log('Condition                      | Count | Avg 15m | Win% | MFE  | MAE');
  console.log('-'.repeat(75));

  for (const { name, filter } of ivLevelCombos) {
    const filtered = observations.filter(o => o.level.category === 'support' && filter(o));
    const result = analyzeCondition(filtered, name, false);
    if (result && result.count >= 5) {
      console.log(`${name.padEnd(30)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)}`);
    }
  }

  // ============= Summary: Best Identified Pattern =============
  console.log('\n=== SUMMARY: Best Identified Pattern ===\n');

  const bestPattern = observations.filter(o =>
    o.level.category === 'support' &&
    o.iv.skew < -0.01 &&
    o.hour >= 11
  );

  const summary = analyzeCondition(bestPattern, 'Best Pattern', false);
  if (summary) {
    console.log('Pattern: LONG at Support + Negative IV Skew (<-0.01) + After 11 AM EST\n');
    console.log(`Observations: ${summary.count}`);
    console.log(`Average 15m Return: ${summary.avg15m.toFixed(1)} pts`);
    console.log(`Win Rate (15m): ${summary.winRate15m.toFixed(1)}%`);
    console.log(`Average MFE (60m): ${summary.avgMFE.toFixed(1)} pts`);
    console.log(`Average MAE (60m): ${summary.avgMAE.toFixed(1)} pts`);
    console.log(`Edge Ratio (MFE/MAE): ${(summary.avgMFE / summary.avgMAE).toFixed(2)}`);

    // Calculate expected value with realistic stops/targets
    console.log('\n--- Simulated P&L with 10pt Stop / 20pt Target ---');
    let wins = 0, losses = 0, totalPnL = 0;
    for (const obs of summary.observations) {
      const mfe = obs.forwardReturns.mfe_60m;
      const mae = obs.forwardReturns.mae_60m;

      if (mae <= -10) {
        // Stop hit first
        losses++;
        totalPnL -= 10;
      } else if (mfe >= 20) {
        // Target hit
        wins++;
        totalPnL += 20;
      } else {
        // Neither hit, use 15m close
        const ret = obs.forwardReturns.pts_15m;
        if (ret > 0) wins++;
        else losses++;
        totalPnL += Math.max(-10, Math.min(20, ret));
      }
    }

    console.log(`Wins: ${wins} | Losses: ${losses} | Win Rate: ${(wins/(wins+losses)*100).toFixed(1)}%`);
    console.log(`Total P&L (pts): ${totalPnL.toFixed(1)}`);
    console.log(`Avg P&L per trade: ${(totalPnL / summary.count).toFixed(2)} pts`);
  }

  console.log('\n=== Analysis Complete ===\n');

  // Save results
  const outputFile = path.join(__dirname, 'results/iv-skew-gex-analysis.json');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify({
    period: { start: startDate.toISOString(), end: endDate.toISOString() },
    totalObservations: observations.length,
    bestPattern: summary,
    sampleObservations: bestPattern.slice(0, 50)
  }, null, 2));

  console.log(`Results saved to: ${outputFile}`);
}

main().catch(console.error);
