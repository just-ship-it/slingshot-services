#!/usr/bin/env node
/**
 * GEX + Order Flow Pattern Analysis
 *
 * Explores relationships between:
 * - GEX level proximity (dealer hedging zones)
 * - Order flow imbalance (OFI - academically validated signal)
 * - IV levels and changes
 * - Price behavior and forward returns
 *
 * Based on research:
 * - Kolm/Turiel/Westray 2023: OFI shows 60-65% directional accuracy
 * - SqueezeMetrics: GEX outperforms VIX for variance prediction
 * - 0DTE effects create strong intraday pinning
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
  tradesDir: path.join(__dirname, 'data/orderflow/nq/trades'),
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

      // Skip calendar spreads
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
  // Group by hour and find highest volume contract
  const hourlyVolume = new Map();

  candles.forEach(c => {
    const hourKey = Math.floor(c.timestamp / (60 * 60 * 1000));
    if (!hourlyVolume.has(hourKey)) {
      hourlyVolume.set(hourKey, new Map());
    }
    const symbolVol = hourlyVolume.get(hourKey);
    symbolVol.set(c.symbol, (symbolVol.get(c.symbol) || 0) + c.volume);
  });

  // Find primary symbol per hour
  const hourlyPrimary = new Map();
  hourlyVolume.forEach((symbolVol, hourKey) => {
    let maxVol = 0, primary = null;
    symbolVol.forEach((vol, sym) => {
      if (vol > maxVol) { maxVol = vol; primary = sym; }
    });
    hourlyPrimary.set(hourKey, primary);
  });

  // Filter to primary contract only
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
        countImbalance: parseFloat(record.countImbalance),
        totalBidSize: parseInt(record.totalBidSize),
        totalAskSize: parseInt(record.totalAskSize),
        bidAskRatio: parseFloat(record.bidAskRatio),
        updates: parseInt(record.updates)
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

    rl.on('close', () => {
      data.sort((a, b) => a.timestamp - b.timestamp);
      resolve(data);
    });
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
  // Find IV record closest to but before timestamp
  let best = null;
  for (const iv of ivData) {
    if (iv.timestamp <= timestamp) best = iv;
    else break;
  }
  return best;
}

// ============= Analysis Functions =============

function isRTH(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const [hourStr, minStr] = estString.split(':');
  const hour = parseInt(hourStr);
  const min = parseInt(minStr);
  const timeDecimal = hour + min / 60;
  return timeDecimal >= 9.5 && timeDecimal < 16;
}

function getGexProximity(price, gexLevels) {
  if (!gexLevels) return null;

  const allLevels = [];

  // Add support levels
  (gexLevels.support || []).forEach((level, i) => {
    if (level) allLevels.push({ type: `S${i+1}`, level, category: 'support' });
  });

  // Add resistance levels
  (gexLevels.resistance || []).forEach((level, i) => {
    if (level) allLevels.push({ type: `R${i+1}`, level, category: 'resistance' });
  });

  // Add walls
  if (gexLevels.callWall) allLevels.push({ type: 'CallWall', level: gexLevels.callWall, category: 'resistance' });
  if (gexLevels.putWall) allLevels.push({ type: 'PutWall', level: gexLevels.putWall, category: 'support' });
  if (gexLevels.gammaFlip) allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'neutral' });

  // Find nearest level
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
      const exitPrice = candles[idx + p].close;
      returns[`ret_${p}m`] = (exitPrice - entryPrice) / entryPrice * 100;
      returns[`pts_${p}m`] = exitPrice - entryPrice;
    }
  }

  // Also calculate max favorable/adverse excursion
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

function calculatePriceSlope(history, lookback = 5) {
  if (history.length < lookback) return null;
  const prices = history.slice(-lookback);
  const n = prices.length;
  const xMean = (n - 1) / 2;
  const yMean = prices.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (prices[i] - yMean);
    den += (i - xMean) * (i - xMean);
  }
  return den === 0 ? 0 : num / den;
}

function categorizeOrderFlow(bookData) {
  if (!bookData) return null;

  const imb = bookData.sizeImbalance;
  const volume = (bookData.totalBidSize || 0) + (bookData.totalAskSize || 0);

  // Categorize imbalance
  let imbCategory;
  if (Math.abs(imb) < 0.1) imbCategory = 'balanced';
  else if (imb > 0.3) imbCategory = 'strong_bid';
  else if (imb > 0.1) imbCategory = 'weak_bid';
  else if (imb < -0.3) imbCategory = 'strong_ask';
  else imbCategory = 'weak_ask';

  // Categorize volume
  let volCategory;
  if (volume < 20000) volCategory = 'low';
  else if (volume < 50000) volCategory = 'medium';
  else volCategory = 'high';

  return {
    imbalance: imb,
    volume,
    imbCategory,
    volCategory,
    bidAskRatio: bookData.bidAskRatio
  };
}

// ============= Main Analysis =============

async function main() {
  // Analysis period - January 2025 where all data overlaps
  const startDate = new Date('2025-01-02');
  const endDate = new Date('2025-01-25');

  console.log('=== GEX + Order Flow Pattern Analysis ===\n');
  console.log(`Period: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)}\n`);

  // Load all data
  console.log('Loading data...');
  const [candles, bookImbalance, ivData, gexMap] = await Promise.all([
    loadOHLCV(startDate, endDate),
    loadBookImbalance(),
    loadIVData(),
    loadGexLevels(startDate, endDate)
  ]);

  console.log(`  Candles: ${candles.length}`);
  console.log(`  Book Imbalance: ${bookImbalance.size}`);
  console.log(`  IV Records: ${ivData.length}`);
  console.log(`  GEX Snapshots: ${gexMap.size}\n`);

  // Build price history for slope calculation
  const priceHistory = [];

  // Collect observations at GEX levels
  const observations = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    priceHistory.push(candle.close);
    if (priceHistory.length > 50) priceHistory.shift();

    // Only analyze RTH
    if (!isRTH(candle.timestamp)) continue;

    const gex = getActiveGexLevels(gexMap, candle.timestamp);
    if (!gex) continue;

    const proximity = getGexProximity(candle.close, gex);
    if (!proximity) continue;

    // Only analyze when near a level (within 25 points)
    if (proximity.distance > 25) continue;

    const bookData = bookImbalance.get(candle.timestamp);
    const orderFlow = categorizeOrderFlow(bookData);
    const iv = getIVAtTime(ivData, candle.timestamp);
    const priceSlope = calculatePriceSlope(priceHistory, 5);
    const forwardReturns = calculateForwardReturns(candles, i);

    observations.push({
      timestamp: candle.timestamp,
      price: candle.close,
      level: proximity,
      orderFlow,
      iv: iv ? { iv: iv.iv, skew: iv.skew, dte: iv.dte } : null,
      priceSlope,
      forwardReturns
    });
  }

  console.log(`Collected ${observations.length} observations near GEX levels\n`);

  // ============= Analysis 1: Order Flow at Different Level Types =============
  console.log('=== Analysis 1: Order Flow Patterns by GEX Level Type ===\n');

  const byLevelType = {};
  for (const obs of observations) {
    const key = obs.level.type;
    if (!byLevelType[key]) byLevelType[key] = [];
    byLevelType[key].push(obs);
  }

  console.log('Level    | Count | Avg Imb  | Avg 15m Pts | Win% (15m>0) | Avg MFE | Avg MAE');
  console.log('-'.repeat(80));

  for (const [level, obs] of Object.entries(byLevelType).sort((a, b) => b[1].length - a[1].length)) {
    const withOF = obs.filter(o => o.orderFlow);
    const withRet = obs.filter(o => o.forwardReturns.pts_15m !== undefined);

    const avgImb = withOF.length > 0
      ? withOF.reduce((s, o) => s + o.orderFlow.imbalance, 0) / withOF.length
      : 0;

    const avg15m = withRet.length > 0
      ? withRet.reduce((s, o) => s + o.forwardReturns.pts_15m, 0) / withRet.length
      : 0;

    const wins = withRet.filter(o => o.forwardReturns.pts_15m > 0).length;
    const winRate = withRet.length > 0 ? (wins / withRet.length * 100) : 0;

    const avgMFE = withRet.length > 0
      ? withRet.reduce((s, o) => s + o.forwardReturns.mfe_60m, 0) / withRet.length
      : 0;

    const avgMAE = withRet.length > 0
      ? withRet.reduce((s, o) => s + o.forwardReturns.mae_60m, 0) / withRet.length
      : 0;

    console.log(`${level.padEnd(8)} | ${obs.length.toString().padStart(5)} | ${avgImb.toFixed(4).padStart(8)} | ${avg15m.toFixed(2).padStart(11)} | ${winRate.toFixed(1).padStart(12)}% | ${avgMFE.toFixed(1).padStart(7)} | ${avgMAE.toFixed(1).padStart(7)}`);
  }

  // ============= Analysis 2: Order Flow Imbalance vs Forward Returns =============
  console.log('\n=== Analysis 2: Order Flow Imbalance vs Forward Returns ===\n');

  const imbBuckets = {
    'strong_bid (>0.3)': observations.filter(o => o.orderFlow?.imbalance > 0.3),
    'weak_bid (0.1-0.3)': observations.filter(o => o.orderFlow?.imbalance >= 0.1 && o.orderFlow?.imbalance <= 0.3),
    'balanced (-0.1 to 0.1)': observations.filter(o => o.orderFlow && Math.abs(o.orderFlow.imbalance) < 0.1),
    'weak_ask (-0.3 to -0.1)': observations.filter(o => o.orderFlow?.imbalance <= -0.1 && o.orderFlow?.imbalance >= -0.3),
    'strong_ask (<-0.3)': observations.filter(o => o.orderFlow?.imbalance < -0.3),
  };

  console.log('Imbalance Category   | Count | Avg 5m Pts | Avg 15m Pts | Win% 15m');
  console.log('-'.repeat(70));

  for (const [cat, obs] of Object.entries(imbBuckets)) {
    const withRet = obs.filter(o => o.forwardReturns.pts_15m !== undefined);
    if (withRet.length < 5) continue;

    const avg5m = withRet.reduce((s, o) => s + (o.forwardReturns.pts_5m || 0), 0) / withRet.length;
    const avg15m = withRet.reduce((s, o) => s + o.forwardReturns.pts_15m, 0) / withRet.length;
    const wins = withRet.filter(o => o.forwardReturns.pts_15m > 0).length;
    const winRate = wins / withRet.length * 100;

    console.log(`${cat.padEnd(20)} | ${withRet.length.toString().padStart(5)} | ${avg5m.toFixed(2).padStart(10)} | ${avg15m.toFixed(2).padStart(11)} | ${winRate.toFixed(1).padStart(8)}%`);
  }

  // ============= Analysis 3: Support Level - Falling Price + Order Flow =============
  console.log('\n=== Analysis 3: Support Levels - Price Direction + Order Flow ===\n');

  const supportObs = observations.filter(o =>
    o.level.category === 'support' &&
    o.priceSlope !== null &&
    o.orderFlow
  );

  console.log('Condition                        | Count | Avg 15m Pts | Win% | Avg MFE | Avg MAE');
  console.log('-'.repeat(85));

  // Falling price scenarios
  const fallingAtSupport = supportObs.filter(o => o.priceSlope < -0.3);
  const risingAtSupport = supportObs.filter(o => o.priceSlope > 0.3);

  const scenarios = [
    { name: 'Falling + Balanced', obs: fallingAtSupport.filter(o => Math.abs(o.orderFlow.imbalance) < 0.1) },
    { name: 'Falling + Bid Dominant', obs: fallingAtSupport.filter(o => o.orderFlow.imbalance > 0.1) },
    { name: 'Falling + Ask Dominant', obs: fallingAtSupport.filter(o => o.orderFlow.imbalance < -0.1) },
    { name: 'Rising + Balanced', obs: risingAtSupport.filter(o => Math.abs(o.orderFlow.imbalance) < 0.1) },
    { name: 'Rising + Bid Dominant', obs: risingAtSupport.filter(o => o.orderFlow.imbalance > 0.1) },
    { name: 'Rising + Ask Dominant', obs: risingAtSupport.filter(o => o.orderFlow.imbalance < -0.1) },
  ];

  for (const { name, obs } of scenarios) {
    const withRet = obs.filter(o => o.forwardReturns.pts_15m !== undefined);
    if (withRet.length < 3) continue;

    const avg15m = withRet.reduce((s, o) => s + o.forwardReturns.pts_15m, 0) / withRet.length;
    const wins = withRet.filter(o => o.forwardReturns.pts_15m > 0).length;
    const winRate = wins / withRet.length * 100;
    const avgMFE = withRet.reduce((s, o) => s + o.forwardReturns.mfe_60m, 0) / withRet.length;
    const avgMAE = withRet.reduce((s, o) => s + o.forwardReturns.mae_60m, 0) / withRet.length;

    console.log(`${name.padEnd(32)} | ${withRet.length.toString().padStart(5)} | ${avg15m.toFixed(2).padStart(11)} | ${winRate.toFixed(0).padStart(4)}% | ${avgMFE.toFixed(1).padStart(7)} | ${avgMAE.toFixed(1).padStart(7)}`);
  }

  // ============= Analysis 4: Resistance Level - Rising Price + Order Flow =============
  console.log('\n=== Analysis 4: Resistance Levels - Price Direction + Order Flow ===\n');

  const resistanceObs = observations.filter(o =>
    o.level.category === 'resistance' &&
    o.priceSlope !== null &&
    o.orderFlow
  );

  console.log('Condition                        | Count | Avg 15m Pts | Win% | Avg MFE | Avg MAE');
  console.log('-'.repeat(85));

  const risingAtResistance = resistanceObs.filter(o => o.priceSlope > 0.3);
  const fallingAtResistance = resistanceObs.filter(o => o.priceSlope < -0.3);

  const resistScenarios = [
    { name: 'Rising + Balanced (Short)', obs: risingAtResistance.filter(o => Math.abs(o.orderFlow.imbalance) < 0.1), short: true },
    { name: 'Rising + Ask Dominant (Short)', obs: risingAtResistance.filter(o => o.orderFlow.imbalance < -0.1), short: true },
    { name: 'Rising + Bid Dominant (Short)', obs: risingAtResistance.filter(o => o.orderFlow.imbalance > 0.1), short: true },
    { name: 'Falling + Balanced', obs: fallingAtResistance.filter(o => Math.abs(o.orderFlow.imbalance) < 0.1), short: false },
  ];

  for (const { name, obs, short } of resistScenarios) {
    const withRet = obs.filter(o => o.forwardReturns.pts_15m !== undefined);
    if (withRet.length < 3) continue;

    // For short scenarios, invert the returns
    const returns = withRet.map(o => short ? -o.forwardReturns.pts_15m : o.forwardReturns.pts_15m);
    const avg15m = returns.reduce((s, r) => s + r, 0) / returns.length;
    const wins = returns.filter(r => r > 0).length;
    const winRate = wins / returns.length * 100;

    const mfe = short
      ? withRet.reduce((s, o) => s + (-o.forwardReturns.mae_60m), 0) / withRet.length  // MAE becomes MFE for shorts
      : withRet.reduce((s, o) => s + o.forwardReturns.mfe_60m, 0) / withRet.length;

    const mae = short
      ? withRet.reduce((s, o) => s + (-o.forwardReturns.mfe_60m), 0) / withRet.length  // MFE becomes MAE for shorts
      : withRet.reduce((s, o) => s + o.forwardReturns.mae_60m, 0) / withRet.length;

    console.log(`${name.padEnd(32)} | ${withRet.length.toString().padStart(5)} | ${avg15m.toFixed(2).padStart(11)} | ${winRate.toFixed(0).padStart(4)}% | ${mfe.toFixed(1).padStart(7)} | ${mae.toFixed(1).padStart(7)}`);
  }

  // ============= Analysis 5: IV Levels and Forward Returns =============
  console.log('\n=== Analysis 5: IV Levels at GEX Levels ===\n');

  const withIV = observations.filter(o => o.iv);

  const ivBuckets = {
    'Low IV (<0.18)': withIV.filter(o => o.iv.iv < 0.18),
    'Medium IV (0.18-0.25)': withIV.filter(o => o.iv.iv >= 0.18 && o.iv.iv < 0.25),
    'High IV (>0.25)': withIV.filter(o => o.iv.iv >= 0.25),
  };

  console.log('IV Category        | Count | Avg 15m Pts | Avg MFE | Avg MAE | MFE/MAE');
  console.log('-'.repeat(75));

  for (const [cat, obs] of Object.entries(ivBuckets)) {
    const withRet = obs.filter(o => o.forwardReturns.pts_15m !== undefined);
    if (withRet.length < 5) continue;

    const avg15m = withRet.reduce((s, o) => s + o.forwardReturns.pts_15m, 0) / withRet.length;
    const avgMFE = withRet.reduce((s, o) => s + o.forwardReturns.mfe_60m, 0) / withRet.length;
    const avgMAE = withRet.reduce((s, o) => s + Math.abs(o.forwardReturns.mae_60m), 0) / withRet.length;
    const ratio = avgMFE / avgMAE;

    console.log(`${cat.padEnd(18)} | ${withRet.length.toString().padStart(5)} | ${avg15m.toFixed(2).padStart(11)} | ${avgMFE.toFixed(1).padStart(7)} | ${avgMAE.toFixed(1).padStart(7)} | ${ratio.toFixed(2).padStart(7)}`);
  }

  // ============= Analysis 6: IV Skew (Put-Call) at GEX Levels =============
  console.log('\n=== Analysis 6: Put-Call IV Skew at GEX Levels ===\n');

  const skewBuckets = {
    'Negative Skew (Put<Call)': withIV.filter(o => o.iv.skew < -0.01),
    'Neutral Skew': withIV.filter(o => Math.abs(o.iv.skew) <= 0.01),
    'Positive Skew (Put>Call)': withIV.filter(o => o.iv.skew > 0.01),
  };

  console.log('Skew Category          | Count | Avg 15m Pts | Win% 15m | Interpretation');
  console.log('-'.repeat(85));

  for (const [cat, obs] of Object.entries(skewBuckets)) {
    const withRet = obs.filter(o => o.forwardReturns.pts_15m !== undefined);
    if (withRet.length < 5) continue;

    const avg15m = withRet.reduce((s, o) => s + o.forwardReturns.pts_15m, 0) / withRet.length;
    const wins = withRet.filter(o => o.forwardReturns.pts_15m > 0).length;
    const winRate = wins / withRet.length * 100;

    const interp = cat.includes('Positive') ? 'Fear/hedging' : cat.includes('Negative') ? 'Complacency' : 'Balanced';

    console.log(`${cat.padEnd(22)} | ${withRet.length.toString().padStart(5)} | ${avg15m.toFixed(2).padStart(11)} | ${winRate.toFixed(1).padStart(8)}% | ${interp}`);
  }

  // ============= Analysis 7: Combined Best Conditions =============
  console.log('\n=== Analysis 7: Combined Condition Analysis ===\n');

  // Look for the best combinations
  const combos = [
    {
      name: 'LONG: Support + Falling + Balanced + Low IV',
      obs: observations.filter(o =>
        o.level.category === 'support' &&
        o.priceSlope < -0.2 &&
        o.orderFlow && Math.abs(o.orderFlow.imbalance) < 0.15 &&
        o.iv && o.iv.iv < 0.20
      ),
      short: false
    },
    {
      name: 'LONG: Support + Falling + Bid Dominant',
      obs: observations.filter(o =>
        o.level.category === 'support' &&
        o.priceSlope < -0.2 &&
        o.orderFlow && o.orderFlow.imbalance > 0.1
      ),
      short: false
    },
    {
      name: 'SHORT: Resistance + Rising + Balanced + High IV',
      obs: observations.filter(o =>
        o.level.category === 'resistance' &&
        o.priceSlope > 0.2 &&
        o.orderFlow && Math.abs(o.orderFlow.imbalance) < 0.15 &&
        o.iv && o.iv.iv > 0.22
      ),
      short: true
    },
    {
      name: 'LONG: S2+ + Falling + High Volume',
      obs: observations.filter(o =>
        ['S2', 'S3', 'S4', 'PutWall'].includes(o.level.type) &&
        o.priceSlope < -0.3 &&
        o.orderFlow && o.orderFlow.volume > 40000
      ),
      short: false
    },
    {
      name: 'LONG: Near GammaFlip + Balanced',
      obs: observations.filter(o =>
        o.level.type === 'GammaFlip' &&
        o.orderFlow && Math.abs(o.orderFlow.imbalance) < 0.1
      ),
      short: false
    },
  ];

  console.log('Condition                                      | Count | Avg Pts | Win% | MFE  | MAE');
  console.log('-'.repeat(95));

  for (const { name, obs, short } of combos) {
    const withRet = obs.filter(o => o.forwardReturns.pts_15m !== undefined);
    if (withRet.length < 2) {
      console.log(`${name.padEnd(46)} | ${withRet.length.toString().padStart(5)} | insufficient data`);
      continue;
    }

    const returns = withRet.map(o => short ? -o.forwardReturns.pts_15m : o.forwardReturns.pts_15m);
    const avgPts = returns.reduce((s, r) => s + r, 0) / returns.length;
    const wins = returns.filter(r => r > 0).length;
    const winRate = wins / returns.length * 100;

    const avgMFE = short
      ? withRet.reduce((s, o) => s + (-o.forwardReturns.mae_60m), 0) / withRet.length
      : withRet.reduce((s, o) => s + o.forwardReturns.mfe_60m, 0) / withRet.length;

    const avgMAE = short
      ? withRet.reduce((s, o) => s + (-o.forwardReturns.mfe_60m), 0) / withRet.length
      : withRet.reduce((s, o) => s + Math.abs(o.forwardReturns.mae_60m), 0) / withRet.length;

    console.log(`${name.padEnd(46)} | ${withRet.length.toString().padStart(5)} | ${avgPts.toFixed(1).padStart(7)} | ${winRate.toFixed(0).padStart(4)}% | ${avgMFE.toFixed(0).padStart(4)} | ${avgMAE.toFixed(0).padStart(4)}`);
  }

  // ============= Analysis 8: Time-of-Day Effects =============
  console.log('\n=== Analysis 8: Time-of-Day Effects at GEX Levels ===\n');

  const byHour = {};
  for (const obs of observations) {
    const date = new Date(obs.timestamp);
    const hour = parseInt(date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
    if (!byHour[hour]) byHour[hour] = [];
    byHour[hour].push(obs);
  }

  console.log('Hour (EST) | Count | Avg 15m Pts | Win% | Avg |Imb| | Interpretation');
  console.log('-'.repeat(80));

  for (const hour of [9, 10, 11, 12, 13, 14, 15]) {
    const obs = byHour[hour] || [];
    const withRet = obs.filter(o => o.forwardReturns.pts_15m !== undefined);
    if (withRet.length < 5) continue;

    const avg15m = withRet.reduce((s, o) => s + o.forwardReturns.pts_15m, 0) / withRet.length;
    const wins = withRet.filter(o => o.forwardReturns.pts_15m > 0).length;
    const winRate = wins / withRet.length * 100;

    const withOF = obs.filter(o => o.orderFlow);
    const avgAbsImb = withOF.length > 0
      ? withOF.reduce((s, o) => s + Math.abs(o.orderFlow.imbalance), 0) / withOF.length
      : 0;

    const interp = hour === 9 ? 'Opening range' :
                   hour === 10 ? '0DTE peak activity' :
                   hour === 11 ? 'Late morning' :
                   hour === 12 ? 'Lunch doldrums' :
                   hour === 15 ? 'Power hour' : '';

    console.log(`${hour.toString().padStart(2)}:00      | ${withRet.length.toString().padStart(5)} | ${avg15m.toFixed(2).padStart(11)} | ${winRate.toFixed(0).padStart(4)}% | ${avgAbsImb.toFixed(3).padStart(9)} | ${interp}`);
  }

  console.log('\n=== Analysis Complete ===\n');

  // Save detailed observations for further analysis
  const outputFile = path.join(__dirname, 'results/gex-orderflow-analysis.json');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify({
    period: { start: startDate.toISOString(), end: endDate.toISOString() },
    totalObservations: observations.length,
    observations: observations.slice(0, 1000) // Save first 1000 for inspection
  }, null, 2));

  console.log(`Detailed observations saved to: ${outputFile}`);
}

main().catch(console.error);
