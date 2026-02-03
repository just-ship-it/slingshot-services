#!/usr/bin/env node
/**
 * Bidirectional IV Skew Analysis - LONG and SHORT
 *
 * Key insight: IV skew predicts direction
 * - Negative skew (Put < Call) = Complacency → LONG
 * - Positive skew (Put > Call) = Fear → SHORT
 *
 * This explores both sides systematically.
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

// ============= Data Loaders (same as before) =============

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
        volume: parseInt(record.volume), symbol: record.symbol
      });
    });
    rl.on('close', () => { candles.sort((a, b) => a.timestamp - b.timestamp); resolve(filterPrimaryContract(candles)); });
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
    symbolVol.forEach((vol, sym) => { if (vol > maxVol) { maxVol = vol; primary = sym; } });
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
        gammaFlip: snapshot.gamma_flip, callWall: snapshot.call_wall, putWall: snapshot.put_wall,
        support: snapshot.support || [], resistance: snapshot.resistance || [], regime: snapshot.regime
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

function getGexProximity(price, gexLevels) {
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

  let nearest = null;
  let nearestDist = Infinity;
  for (const lvl of allLevels) {
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
      returns[`pts_${p}m`] = candles[idx + p].close - entryPrice;
    }
  }

  let maxFav = 0, maxAdv = 0;
  const lookforward = Math.min(60, candles.length - idx - 1);
  for (let i = 1; i <= lookforward; i++) {
    maxFav = Math.max(maxFav, candles[idx + i].high - entryPrice);
    maxAdv = Math.min(maxAdv, candles[idx + i].low - entryPrice);
  }

  returns.mfe_60m = maxFav;
  returns.mae_60m = maxAdv;
  return returns;
}

function analyzeCondition(observations, short = false) {
  const withRet = observations.filter(o => o.forwardReturns.pts_15m !== undefined);
  if (withRet.length < 5) return null;

  const getReturn = (o, period) => {
    const ret = o.forwardReturns[`pts_${period}m`] || 0;
    return short ? -ret : ret;
  };

  const returns15 = withRet.map(o => getReturn(o, 15));
  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const winRate = arr => arr.filter(v => v > 0).length / arr.length * 100;

  const mfe = short
    ? withRet.map(o => -o.forwardReturns.mae_60m)
    : withRet.map(o => o.forwardReturns.mfe_60m);
  const mae = short
    ? withRet.map(o => Math.abs(o.forwardReturns.mfe_60m))
    : withRet.map(o => Math.abs(o.forwardReturns.mae_60m));

  return {
    count: withRet.length,
    avg5m: avg(withRet.map(o => getReturn(o, 5))),
    avg10m: avg(withRet.map(o => getReturn(o, 10))),
    avg15m: avg(returns15),
    avg30m: avg(withRet.map(o => getReturn(o, 30))),
    winRate5m: winRate(withRet.map(o => getReturn(o, 5))),
    winRate10m: winRate(withRet.map(o => getReturn(o, 10))),
    winRate15m: winRate(returns15),
    winRate30m: winRate(withRet.map(o => getReturn(o, 30))),
    avgMFE: avg(mfe),
    avgMAE: avg(mae),
    observations: withRet
  };
}

function simulatePnL(observations, stopPts, targetPts, short = false) {
  let wins = 0, losses = 0, totalPnL = 0;

  for (const obs of observations) {
    const mfe = short ? -obs.forwardReturns.mae_60m : obs.forwardReturns.mfe_60m;
    const mae = short ? -obs.forwardReturns.mfe_60m : obs.forwardReturns.mae_60m;

    // Simplified: check if stop or target hit first based on excursion
    if (Math.abs(mae) >= stopPts) {
      losses++;
      totalPnL -= stopPts;
    } else if (mfe >= targetPts) {
      wins++;
      totalPnL += targetPts;
    } else {
      // Neither hit, close at 15m
      const ret = short ? -obs.forwardReturns.pts_15m : obs.forwardReturns.pts_15m;
      if (ret > 0) wins++;
      else losses++;
      totalPnL += Math.max(-stopPts, Math.min(targetPts, ret));
    }
  }

  return { wins, losses, totalPnL, avgPnL: totalPnL / observations.length };
}

async function main() {
  const startDate = new Date('2025-01-02');
  const endDate = new Date('2025-01-25');

  console.log('=== Bidirectional IV Skew Analysis: LONG and SHORT ===\n');
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

  // Collect all observations
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

  // ============= Analysis 1: LONG Signals (Negative Skew) =============
  console.log('=' .repeat(80));
  console.log('=== LONG SIGNALS: Negative IV Skew (Put < Call) = Complacency ===');
  console.log('=' .repeat(80));

  console.log('\n--- By Skew Threshold (at Support Levels) ---\n');
  console.log('Max Skew | Count | Avg 15m | Win% | MFE  | MAE  | Edge');
  console.log('-'.repeat(65));

  const longThresholds = [-0.03, -0.02, -0.015, -0.01, -0.005, 0];
  for (const thresh of longThresholds) {
    const filtered = observations.filter(o => o.iv.skew < thresh && o.level.category === 'support');
    const result = analyzeCondition(filtered, false);
    if (result && result.count >= 10) {
      const edge = result.avgMFE / result.avgMAE;
      console.log(`${thresh.toFixed(3).padStart(8)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)} | ${edge.toFixed(2).padStart(5)}`);
    }
  }

  console.log('\n--- LONG: By Level Type + Negative Skew (<-0.01) ---\n');
  console.log('Level Type     | Count | Avg 15m | Win% | MFE  | MAE');
  console.log('-'.repeat(60));

  const levelTypes = ['S1', 'S2', 'S3', 'S4', 'PutWall', 'GammaFlip'];
  for (const lt of levelTypes) {
    const filtered = observations.filter(o => o.level.type === lt && o.iv.skew < -0.01);
    const result = analyzeCondition(filtered, false);
    if (result && result.count >= 5) {
      console.log(`${lt.padEnd(14)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)}`);
    }
  }

  // ============= Analysis 2: SHORT Signals (Positive Skew) =============
  console.log('\n' + '=' .repeat(80));
  console.log('=== SHORT SIGNALS: Positive IV Skew (Put > Call) = Fear/Hedging ===');
  console.log('=' .repeat(80));

  console.log('\n--- By Skew Threshold (at Resistance Levels) ---\n');
  console.log('Min Skew | Count | Avg 15m | Win% | MFE  | MAE  | Edge');
  console.log('-'.repeat(65));

  const shortThresholds = [0.03, 0.02, 0.015, 0.01, 0.005, 0];
  for (const thresh of shortThresholds) {
    const filtered = observations.filter(o => o.iv.skew > thresh && o.level.category === 'resistance');
    const result = analyzeCondition(filtered, true);  // SHORT
    if (result && result.count >= 10) {
      const edge = result.avgMFE / result.avgMAE;
      console.log(`${thresh.toFixed(3).padStart(8)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)} | ${edge.toFixed(2).padStart(5)}`);
    }
  }

  console.log('\n--- SHORT: By Level Type + Positive Skew (>0.01) ---\n');
  console.log('Level Type     | Count | Avg 15m | Win% | MFE  | MAE');
  console.log('-'.repeat(60));

  const resistTypes = ['R1', 'R2', 'R3', 'R4', 'CallWall', 'GammaFlip'];
  for (const lt of resistTypes) {
    const filtered = observations.filter(o => o.level.type === lt && o.iv.skew > 0.01);
    const result = analyzeCondition(filtered, true);  // SHORT
    if (result && result.count >= 5) {
      console.log(`${lt.padEnd(14)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)}`);
    }
  }

  // ============= Analysis 3: SHORT at ANY Level with Positive Skew =============
  console.log('\n--- SHORT: At ANY GEX Level + Positive Skew ---\n');
  console.log('Min Skew | Count | Avg 15m | Win% | MFE  | MAE  | Edge');
  console.log('-'.repeat(65));

  for (const thresh of shortThresholds) {
    const filtered = observations.filter(o => o.iv.skew > thresh);  // Any level
    const result = analyzeCondition(filtered, true);  // SHORT
    if (result && result.count >= 10) {
      const edge = result.avgMFE / result.avgMAE;
      console.log(`${thresh.toFixed(3).padStart(8)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)} | ${edge.toFixed(2).padStart(5)}`);
    }
  }

  // ============= Analysis 4: Time-of-Day Effects for Both Sides =============
  console.log('\n' + '=' .repeat(80));
  console.log('=== TIME-OF-DAY EFFECTS ===');
  console.log('=' .repeat(80));

  console.log('\n--- LONG (Support + Neg Skew) by Hour ---\n');
  console.log('Hour | Count | Avg 15m | Win%');
  console.log('-'.repeat(35));

  for (const hour of [9, 10, 11, 12, 13, 14, 15]) {
    const filtered = observations.filter(o =>
      o.hour === hour && o.level.category === 'support' && o.iv.skew < -0.01
    );
    const result = analyzeCondition(filtered, false);
    if (result && result.count >= 5) {
      console.log(`${hour.toString().padStart(2)}:00 | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}%`);
    }
  }

  console.log('\n--- SHORT (Resistance + Pos Skew) by Hour ---\n');
  console.log('Hour | Count | Avg 15m | Win%');
  console.log('-'.repeat(35));

  for (const hour of [9, 10, 11, 12, 13, 14, 15]) {
    const filtered = observations.filter(o =>
      o.hour === hour && o.level.category === 'resistance' && o.iv.skew > 0.01
    );
    const result = analyzeCondition(filtered, true);
    if (result && result.count >= 5) {
      console.log(`${hour.toString().padStart(2)}:00 | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}%`);
    }
  }

  // ============= Analysis 5: IV Level Combined with Skew =============
  console.log('\n' + '=' .repeat(80));
  console.log('=== IV LEVEL + SKEW COMBINATIONS ===');
  console.log('=' .repeat(80));

  console.log('\n--- LONG Signals ---\n');
  console.log('Condition                      | Count | Avg 15m | Win% | MFE  | MAE');
  console.log('-'.repeat(75));

  const longCombos = [
    { name: 'Low IV + Neg Skew', filter: o => o.iv.iv < 0.18 && o.iv.skew < -0.01 && o.level.category === 'support' },
    { name: 'Med IV + Neg Skew', filter: o => o.iv.iv >= 0.18 && o.iv.iv < 0.22 && o.iv.skew < -0.01 && o.level.category === 'support' },
    { name: 'High IV + Neg Skew', filter: o => o.iv.iv >= 0.22 && o.iv.skew < -0.01 && o.level.category === 'support' },
    { name: 'Very High IV + Any Neg Skew', filter: o => o.iv.iv >= 0.25 && o.iv.skew < 0 && o.level.category === 'support' },
  ];

  for (const { name, filter } of longCombos) {
    const filtered = observations.filter(filter);
    const result = analyzeCondition(filtered, false);
    if (result && result.count >= 5) {
      console.log(`${name.padEnd(30)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)}`);
    }
  }

  console.log('\n--- SHORT Signals ---\n');
  console.log('Condition                      | Count | Avg 15m | Win% | MFE  | MAE');
  console.log('-'.repeat(75));

  const shortCombos = [
    { name: 'Low IV + Pos Skew', filter: o => o.iv.iv < 0.18 && o.iv.skew > 0.01 && o.level.category === 'resistance' },
    { name: 'Med IV + Pos Skew', filter: o => o.iv.iv >= 0.18 && o.iv.iv < 0.22 && o.iv.skew > 0.01 && o.level.category === 'resistance' },
    { name: 'High IV + Pos Skew', filter: o => o.iv.iv >= 0.22 && o.iv.skew > 0.01 && o.level.category === 'resistance' },
    { name: 'Any IV + Strong Pos Skew', filter: o => o.iv.skew > 0.02 && o.level.category === 'resistance' },
  ];

  for (const { name, filter } of shortCombos) {
    const filtered = observations.filter(filter);
    const result = analyzeCondition(filtered, true);
    if (result && result.count >= 5) {
      console.log(`${name.padEnd(30)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}% | ${result.avgMFE.toFixed(0).padStart(4)} | ${result.avgMAE.toFixed(0).padStart(4)}`);
    }
  }

  // ============= Analysis 6: Walk-Forward Validation =============
  console.log('\n' + '=' .repeat(80));
  console.log('=== WALK-FORWARD VALIDATION ===');
  console.log('=' .repeat(80));

  const weeks = [
    { name: 'Week 1 (Jan 2-8)', start: new Date('2025-01-02'), end: new Date('2025-01-09') },
    { name: 'Week 2 (Jan 9-15)', start: new Date('2025-01-09'), end: new Date('2025-01-16') },
    { name: 'Week 3 (Jan 16-22)', start: new Date('2025-01-16'), end: new Date('2025-01-23') },
    { name: 'Week 4 (Jan 23-25)', start: new Date('2025-01-23'), end: new Date('2025-01-26') },
  ];

  console.log('\n--- LONG: Support + Neg Skew ---\n');
  console.log('Week                | Count | Avg 15m | Win%');
  console.log('-'.repeat(50));

  for (const week of weeks) {
    const weekObs = observations.filter(o => {
      const date = new Date(o.timestamp);
      return date >= week.start && date < week.end &&
             o.level.category === 'support' && o.iv.skew < -0.01;
    });
    const result = analyzeCondition(weekObs, false);
    if (result) {
      console.log(`${week.name.padEnd(19)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}%`);
    } else {
      console.log(`${week.name.padEnd(19)} | insufficient data`);
    }
  }

  console.log('\n--- SHORT: Resistance + Pos Skew ---\n');
  console.log('Week                | Count | Avg 15m | Win%');
  console.log('-'.repeat(50));

  for (const week of weeks) {
    const weekObs = observations.filter(o => {
      const date = new Date(o.timestamp);
      return date >= week.start && date < week.end &&
             o.level.category === 'resistance' && o.iv.skew > 0.01;
    });
    const result = analyzeCondition(weekObs, true);
    if (result) {
      console.log(`${week.name.padEnd(19)} | ${result.count.toString().padStart(5)} | ${result.avg15m.toFixed(1).padStart(7)} | ${result.winRate15m.toFixed(0).padStart(4)}%`);
    } else {
      console.log(`${week.name.padEnd(19)} | insufficient data`);
    }
  }

  // ============= Summary: Best Patterns =============
  console.log('\n' + '=' .repeat(80));
  console.log('=== SUMMARY: BEST IDENTIFIED PATTERNS ===');
  console.log('=' .repeat(80));

  // Best LONG
  const bestLong = observations.filter(o =>
    o.level.category === 'support' && o.iv.skew < -0.01 && o.hour >= 11
  );
  const longResult = analyzeCondition(bestLong, false);

  // Best SHORT
  const bestShort = observations.filter(o =>
    o.level.category === 'resistance' && o.iv.skew > 0.01
  );
  const shortResult = analyzeCondition(bestShort, true);

  console.log('\n--- LONG Pattern ---');
  console.log('Conditions: Support Level + Negative Skew (<-0.01) + After 11 AM');
  if (longResult) {
    console.log(`Observations: ${longResult.count}`);
    console.log(`Avg 15m Return: ${longResult.avg15m.toFixed(1)} pts`);
    console.log(`Win Rate: ${longResult.winRate15m.toFixed(1)}%`);
    console.log(`MFE/MAE Edge: ${(longResult.avgMFE / longResult.avgMAE).toFixed(2)}`);

    const sim = simulatePnL(longResult.observations, 10, 20, false);
    console.log(`\nSimulated (10pt stop, 20pt target):`);
    console.log(`  W/L: ${sim.wins}/${sim.losses} | Total: ${sim.totalPnL.toFixed(0)} pts | Avg: ${sim.avgPnL.toFixed(2)} pts/trade`);
  }

  console.log('\n--- SHORT Pattern ---');
  console.log('Conditions: Resistance Level + Positive Skew (>0.01)');
  if (shortResult) {
    console.log(`Observations: ${shortResult.count}`);
    console.log(`Avg 15m Return: ${shortResult.avg15m.toFixed(1)} pts`);
    console.log(`Win Rate: ${shortResult.winRate15m.toFixed(1)}%`);
    console.log(`MFE/MAE Edge: ${(shortResult.avgMFE / shortResult.avgMAE).toFixed(2)}`);

    const sim = simulatePnL(shortResult.observations, 10, 20, true);
    console.log(`\nSimulated (10pt stop, 20pt target):`);
    console.log(`  W/L: ${sim.wins}/${sim.losses} | Total: ${sim.totalPnL.toFixed(0)} pts | Avg: ${sim.avgPnL.toFixed(2)} pts/trade`);
  }

  // Combined strategy
  console.log('\n--- COMBINED BIDIRECTIONAL Strategy ---');
  const combinedObs = [
    ...bestLong.map(o => ({ ...o, side: 'LONG' })),
    ...observations.filter(o => o.level.category === 'resistance' && o.iv.skew > 0.01).map(o => ({ ...o, side: 'SHORT' }))
  ];

  let totalPnL = 0;
  let totalTrades = 0;
  let wins = 0;

  for (const obs of combinedObs) {
    const isShort = obs.side === 'SHORT';
    const ret = isShort ? -obs.forwardReturns.pts_15m : obs.forwardReturns.pts_15m;
    if (ret !== undefined) {
      totalTrades++;
      totalPnL += ret;
      if (ret > 0) wins++;
    }
  }

  console.log(`Total Trades: ${totalTrades}`);
  console.log(`  LONG: ${bestLong.length}`);
  console.log(`  SHORT: ${observations.filter(o => o.level.category === 'resistance' && o.iv.skew > 0.01).length}`);
  console.log(`Combined Win Rate: ${(wins/totalTrades*100).toFixed(1)}%`);
  console.log(`Total 15m P&L: ${totalPnL.toFixed(0)} pts`);
  console.log(`Avg per trade: ${(totalPnL/totalTrades).toFixed(2)} pts`);

  console.log('\n=== Analysis Complete ===\n');

  // Save results
  const outputFile = path.join(__dirname, 'results/iv-skew-bidirectional.json');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify({
    period: { start: startDate.toISOString(), end: endDate.toISOString() },
    longPattern: longResult,
    shortPattern: shortResult,
    combinedStats: { totalTrades, wins, totalPnL, avgPnL: totalPnL/totalTrades }
  }, null, 2));

  console.log(`Results saved to: ${outputFile}`);
}

main().catch(console.error);
