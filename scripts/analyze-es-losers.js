#!/usr/bin/env node
/**
 * Analyze ES Cross-Signal 10t-10s losers vs winners.
 *
 * Enriches trades with:
 * - MFE/MAE from 1-minute OHLCV data
 * - GEX regime + levels from intraday JSON
 * - LT levels from 15m CSV
 * - Time-of-day, day-of-week, side breakdowns
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, '..', 'backtest-engine');

// ─── CSV Parsing ────────────────────────────────────────────────────────────

function parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, 'utf-8');
  const lines = raw.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = vals[i]?.trim() || '');
    return obj;
  });
}

// ─── Load 1-minute ES OHLCV with primary contract filtering (streaming) ─────

async function loadOHLCV(filepath, tradeTimeRanges) {
  console.log('Loading ES 1-minute OHLCV (continuous, streaming)...');

  // Build a set of needed minutes (trade start to end + buffer)
  const neededMinutes = new Set();
  for (const { startMs, endMs } of tradeTimeRanges) {
    for (let ms = startMs; ms <= endMs + 60000; ms += 60000) {
      neededMinutes.add(Math.floor(ms / 60000) * 60000);
    }
  }
  console.log(`  Need ${neededMinutes.size} unique minutes of data`);

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filepath),
      crlfDelay: Infinity,
    });

    let headers = null;
    let tsIdx, openIdx, highIdx, lowIdx, closeIdx, volIdx;
    let lineCount = 0;
    const byMinute = new Map();

    rl.on('line', (line) => {
      if (!headers) {
        headers = line.split(',');
        tsIdx = headers.indexOf('ts_event');
        openIdx = headers.indexOf('open');
        highIdx = headers.indexOf('high');
        lowIdx = headers.indexOf('low');
        closeIdx = headers.indexOf('close');
        volIdx = headers.indexOf('volume');
        return;
      }

      lineCount++;
      if (lineCount % 1000000 === 0) process.stdout.write(`  ${(lineCount / 1000000).toFixed(1)}M lines...\r`);

      const cols = line.split(',');
      const ts = cols[tsIdx];
      // Continuous file format: "2023-03-28 14:09:00+00:00"
      const tsMs = new Date(ts).getTime();
      if (isNaN(tsMs)) return;

      const minKey = Math.floor(tsMs / 60000) * 60000;
      if (!neededMinutes.has(minKey)) return;

      byMinute.set(minKey, {
        tsMs,
        open: parseFloat(cols[openIdx]),
        high: parseFloat(cols[highIdx]),
        low: parseFloat(cols[lowIdx]),
        close: parseFloat(cols[closeIdx]),
        volume: parseFloat(cols[volIdx]),
      });
    });

    rl.on('close', () => {
      console.log(`  Streamed ${lineCount} lines, indexed ${byMinute.size} minutes`);
      resolve(byMinute);
    });

    rl.on('error', reject);
  });
}

// ─── Load GEX intraday JSONs ────────────────────────────────────────────────

function loadGEXData(gexDir) {
  console.log('Loading ES GEX intraday data...');
  const files = fs.readdirSync(gexDir).filter(f => f.endsWith('.json')).sort();

  // Build sorted array of snapshots: { tsMs, data }
  const snapshots = [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf-8'));
    // JSON structure: { metadata: {...}, data: [...] }
    const dataArr = Array.isArray(raw) ? raw : (raw.data || []);
    for (const snap of dataArr) {
      if (snap.timestamp) {
        const support = snap.support || [];
        const resistance = snap.resistance || [];
        snapshots.push({
          tsMs: new Date(snap.timestamp).getTime(),
          regime: snap.regime,
          gamma_flip: snap.gamma_flip,
          call_wall: snap.call_wall,
          put_wall: snap.put_wall,
          support: Array.isArray(support) ? support : [snap.support0, snap.support1, snap.support2, snap.support3, snap.support4],
          resistance: Array.isArray(resistance) ? resistance : [snap.resistance0, snap.resistance1, snap.resistance2, snap.resistance3, snap.resistance4],
          total_gex: snap.total_gex,
          es_spot: snap.es_spot || snap.futures_spot,
        });
      }
    }
  }

  snapshots.sort((a, b) => a.tsMs - b.tsMs);
  console.log(`  Loaded ${snapshots.length} GEX snapshots from ${files.length} files`);
  return snapshots;
}

function findNearestGEX(gexSnapshots, tsMs) {
  // Binary search for the latest snapshot <= tsMs
  let lo = 0, hi = gexSnapshots.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (gexSnapshots[mid].tsMs <= tsMs) {
      best = gexSnapshots[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Only use if within 30 minutes
  if (best && (tsMs - best.tsMs) < 30 * 60 * 1000) return best;
  return null;
}

// ─── Load LT levels (15m CSV) ──────────────────────────────────────────────

function loadLTLevels(filepath) {
  console.log('Loading ES LT levels (15m)...');
  const raw = fs.readFileSync(filepath, 'utf-8');
  const lines = raw.trim().split('\n');
  const headers = lines[0].split(',');

  const snapshots = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dt = cols[0]; // datetime
    const tsMs = new Date(dt).getTime() || parseInt(cols[1]) * 1000;

    snapshots.push({
      tsMs,
      sentiment: cols[2],
      levels: [parseFloat(cols[3]), parseFloat(cols[4]), parseFloat(cols[5]), parseFloat(cols[6]), parseFloat(cols[7])],
    });
  }

  snapshots.sort((a, b) => a.tsMs - b.tsMs);
  console.log(`  Loaded ${snapshots.length} LT snapshots`);
  return snapshots;
}

function findNearestLT(ltSnapshots, tsMs) {
  let lo = 0, hi = ltSnapshots.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ltSnapshots[mid].tsMs <= tsMs) {
      best = ltSnapshots[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best && (tsMs - best.tsMs) < 30 * 60 * 1000) return best;
  return null;
}

// ─── MFE/MAE Calculation ────────────────────────────────────────────────────

function calcMFE_MAE(trade, ohlcvByMinute) {
  const entryMs = new Date(trade.EntryTime).getTime();
  const exitMs = new Date(trade.ExitTime).getTime();
  const entryPrice = parseFloat(trade.EntryPrice);
  const side = trade.Side;

  let mfe = 0; // Max favorable excursion (points)
  let mae = 0; // Max adverse excursion (points, always positive = bad)
  let mfeTime = 0; // ms after entry when MFE occurred
  let maeTime = 0;
  let candleCount = 0;

  // Walk through every minute of the trade
  for (let ms = entryMs; ms <= exitMs; ms += 60000) {
    const minKey = Math.floor(ms / 60000) * 60000;
    const candle = ohlcvByMinute.get(minKey);
    if (!candle) continue;

    candleCount++;

    if (side === 'buy') {
      const favorable = candle.high - entryPrice;
      const adverse = entryPrice - candle.low;
      if (favorable > mfe) { mfe = favorable; mfeTime = ms - entryMs; }
      if (adverse > mae) { mae = adverse; maeTime = ms - entryMs; }
    } else {
      const favorable = entryPrice - candle.low;
      const adverse = candle.high - entryPrice;
      if (favorable > mfe) { mfe = favorable; mfeTime = ms - entryMs; }
      if (adverse > mae) { mae = adverse; maeTime = ms - entryMs; }
    }
  }

  return {
    mfe: Math.round(mfe * 100) / 100,
    mae: Math.round(mae * 100) / 100,
    mfeTimeMs: mfeTime,
    maeTimeMs: maeTime,
    mfeMinutes: Math.round(mfeTime / 60000),
    maeMinutes: Math.round(maeTime / 60000),
    candlesInTrade: candleCount,
  };
}

// ─── Helper: EST time extraction ────────────────────────────────────────────

function getESTHour(isoTime) {
  const d = new Date(isoTime);
  const est = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
  const [h, m] = est.split(':').map(Number);
  return { hour: h, minute: m, decimal: h + m / 60 };
}

function getDayOfWeek(isoTime) {
  const d = new Date(isoTime);
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
}

function getYearMonth(isoTime) {
  const d = new Date(isoTime);
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).split('/').reverse().join('-');
}

// ─── Statistics helpers ─────────────────────────────────────────────────────

function stats(arr) {
  if (arr.length === 0) return { count: 0, mean: 0, median: 0, std: 0, min: 0, max: 0, p25: 0, p75: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return {
    count: arr.length,
    mean: Math.round(mean * 100) / 100,
    median: sorted[Math.floor(sorted.length / 2)],
    std: Math.round(Math.sqrt(variance) * 100) / 100,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
  };
}

function pctOf(count, total) {
  return total > 0 ? (count / total * 100).toFixed(1) + '%' : '0%';
}

// ─── Main Analysis ──────────────────────────────────────────────────────────

async function main() {
  // Load trade data
  const trades = parseCSV(path.join(BASE, 'results/es-sweep/10t-10s.csv'));
  console.log(`Loaded ${trades.length} trades\n`);

  // Build trade time ranges for selective OHLCV loading
  const tradeTimeRanges = trades.map(t => ({
    startMs: new Date(t.EntryTime).getTime(),
    endMs: new Date(t.ExitTime).getTime(),
  }));

  // Load supporting data
  const ohlcv = await loadOHLCV(path.join(BASE, 'data/ohlcv/es/ES_ohlcv_1m_continuous.csv'), tradeTimeRanges);
  const gexSnapshots = loadGEXData(path.join(BASE, 'data/gex/es'));
  const ltSnapshots = loadLTLevels(path.join(BASE, 'data/liquidity/es/ES_liquidity_levels_15m.csv'));

  console.log('\n========== ENRICHING TRADES ==========\n');

  // Enrich each trade
  let gexFound = 0, gexMissing = 0, ltFound = 0, ltMissing = 0, mfeComputed = 0;

  for (const trade of trades) {
    const entryMs = new Date(trade.EntryTime).getTime();
    const entryPrice = parseFloat(trade.EntryPrice);

    // GEX enrichment
    const gex = findNearestGEX(gexSnapshots, entryMs);
    if (gex) {
      gexFound++;
      trade._gexRegime = gex.regime;
      trade._totalGex = gex.total_gex;
      trade._gammaFlip = gex.gamma_flip;
      trade._callWall = gex.call_wall;
      trade._putWall = gex.put_wall;
      trade._esSpot = gex.es_spot;

      // Distance to nearest support and resistance
      const allSupport = gex.support.filter(v => v != null && !isNaN(v));
      const allResist = gex.resistance.filter(v => v != null && !isNaN(v));

      trade._nearestSupport = allSupport.length > 0
        ? Math.min(...allSupport.map(s => Math.abs(entryPrice - s)))
        : null;
      trade._nearestResistance = allResist.length > 0
        ? Math.min(...allResist.map(r => Math.abs(entryPrice - r)))
        : null;
      trade._distToGammaFlip = gex.gamma_flip ? entryPrice - gex.gamma_flip : null;
    } else {
      gexMissing++;
      trade._gexRegime = 'unknown';
    }

    // LT enrichment
    const lt = findNearestLT(ltSnapshots, entryMs);
    if (lt) {
      ltFound++;
      trade._ltSentiment = lt.sentiment;
      trade._ltLevels = lt.levels;

      // Count levels below price, compute spacing
      const below = lt.levels.filter(l => l < entryPrice).length;
      const above = lt.levels.filter(l => l >= entryPrice).length;
      trade._ltLevelsBelow = below;
      trade._ltLevelsAbove = above;

      // Average spacing between levels
      const sortedLevels = [...lt.levels].sort((a, b) => a - b);
      const spacings = [];
      for (let i = 1; i < sortedLevels.length; i++) {
        spacings.push(sortedLevels[i] - sortedLevels[i - 1]);
      }
      trade._ltAvgSpacing = spacings.length > 0 ? spacings.reduce((s, v) => s + v, 0) / spacings.length : 0;

      // Distance to nearest LT level
      trade._nearestLtLevel = Math.min(...lt.levels.map(l => Math.abs(entryPrice - l)));
    } else {
      ltMissing++;
    }

    // MFE/MAE enrichment
    const mfeMae = calcMFE_MAE(trade, ohlcv);
    trade._mfe = mfeMae.mfe;
    trade._mae = mfeMae.mae;
    trade._mfeMinutes = mfeMae.mfeMinutes;
    trade._maeMinutes = mfeMae.maeMinutes;
    trade._candlesInTrade = mfeMae.candlesInTrade;
    if (mfeMae.candlesInTrade > 0) mfeComputed++;
  }

  console.log(`GEX enrichment: ${gexFound} found, ${gexMissing} missing`);
  console.log(`LT enrichment: ${ltFound} found, ${ltMissing} missing`);
  console.log(`MFE computed for ${mfeComputed} trades`);

  // ─── Classify trades ─────────────────────────────────────────────────────

  const winners = trades.filter(t => parseFloat(t.GrossPnL) > 0);
  const losers = trades.filter(t => parseFloat(t.GrossPnL) < 0);
  const breakeven = trades.filter(t => parseFloat(t.GrossPnL) === 0);

  console.log(`\n========== TRADE CLASSIFICATION ==========\n`);
  console.log(`Total: ${trades.length}, Winners: ${winners.length} (${pctOf(winners.length, trades.length)}), Losers: ${losers.length} (${pctOf(losers.length, trades.length)}), Breakeven: ${breakeven.length}`);

  // ─── Exit Reason Breakdown ────────────────────────────────────────────────

  console.log(`\n========== EXIT REASON BREAKDOWN ==========\n`);
  const exitReasons = {};
  for (const t of trades) {
    const key = t.ExitReason;
    if (!exitReasons[key]) exitReasons[key] = { total: 0, win: 0, lose: 0, pnls: [] };
    exitReasons[key].total++;
    exitReasons[key].pnls.push(parseFloat(t.GrossPnL));
    if (parseFloat(t.GrossPnL) > 0) exitReasons[key].win++;
    else if (parseFloat(t.GrossPnL) < 0) exitReasons[key].lose++;
  }
  for (const [reason, data] of Object.entries(exitReasons)) {
    const s = stats(data.pnls);
    console.log(`${reason}: ${data.total} trades, ${pctOf(data.win, data.total)} win, avg P&L: $${s.mean}, total: $${data.pnls.reduce((a, b) => a + b, 0).toFixed(0)}`);
  }

  // ─── MFE Analysis ────────────────────────────────────────────────────────

  console.log(`\n========== MFE / MAE ANALYSIS ==========\n`);

  const winMFE = stats(winners.map(t => t._mfe));
  const loseMFE = stats(losers.map(t => t._mfe));
  const winMAE = stats(winners.map(t => t._mae));
  const loseMAE = stats(losers.map(t => t._mae));

  console.log('--- MFE (Max Favorable Excursion, points) ---');
  console.log(`Winners:  mean=${winMFE.mean}, median=${winMFE.median}, p25=${winMFE.p25}, p75=${winMFE.p75}`);
  console.log(`Losers:   mean=${loseMFE.mean}, median=${loseMFE.median}, p25=${loseMFE.p25}, p75=${loseMFE.p75}`);

  console.log('\n--- MAE (Max Adverse Excursion, points) ---');
  console.log(`Winners:  mean=${winMAE.mean}, median=${winMAE.median}, p25=${winMAE.p25}, p75=${winMAE.p75}`);
  console.log(`Losers:   mean=${loseMAE.mean}, median=${loseMAE.median}, p25=${loseMAE.p25}, p75=${loseMAE.p75}`);

  // MFE for stop_loss exits specifically
  const stopLossTrades = trades.filter(t => t.ExitReason === 'stop_loss');
  const slMFE = stats(stopLossTrades.map(t => t._mfe));
  console.log(`\n--- Stop-loss trades MFE (were they ever in profit?) ---`);
  console.log(`Mean MFE: ${slMFE.mean} pts, Median: ${slMFE.median}, p75: ${slMFE.p75}`);

  const slEverInProfit = stopLossTrades.filter(t => t._mfe >= 2).length;
  const slEver5pts = stopLossTrades.filter(t => t._mfe >= 5).length;
  const slNeverPositive = stopLossTrades.filter(t => t._mfe < 1).length;
  console.log(`SL trades that reached 2+ pts profit: ${slEverInProfit} (${pctOf(slEverInProfit, stopLossTrades.length)})`);
  console.log(`SL trades that reached 5+ pts profit: ${slEver5pts} (${pctOf(slEver5pts, stopLossTrades.length)})`);
  console.log(`SL trades that never reached 1pt profit: ${slNeverPositive} (${pctOf(slNeverPositive, stopLossTrades.length)})`);

  // Time to MFE for stop loss trades
  const slMFETime = stats(stopLossTrades.map(t => t._mfeMinutes));
  console.log(`Time to MFE (stop-loss trades): mean=${slMFETime.mean}min, median=${slMFETime.median}min`);

  // MFE distribution for losers (all losers, not just SL)
  console.log(`\n--- Loser MFE Distribution (all losers) ---`);
  const mfeBuckets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10];
  for (let i = 0; i < mfeBuckets.length; i++) {
    const lo = mfeBuckets[i];
    const hi = i < mfeBuckets.length - 1 ? mfeBuckets[i + 1] : Infinity;
    const count = losers.filter(t => t._mfe >= lo && t._mfe < hi).length;
    console.log(`  MFE ${lo}-${hi === Infinity ? '∞' : hi} pts: ${count} (${pctOf(count, losers.length)})`);
  }

  // ─── Time-in-Trade Analysis ───────────────────────────────────────────────

  console.log(`\n========== TIME IN TRADE ==========\n`);
  const winDuration = stats(winners.map(t => parseInt(t.Duration) / 60000));
  const loseDuration = stats(losers.map(t => parseInt(t.Duration) / 60000));
  console.log(`Winners:  mean=${winDuration.mean}min, median=${winDuration.median}min`);
  console.log(`Losers:   mean=${loseDuration.mean}min, median=${loseDuration.median}min`);

  // Duration of losers that had MFE >= 3pts (could have been saved with trailing)
  const losersWithMFE3 = losers.filter(t => t._mfe >= 3);
  if (losersWithMFE3.length > 0) {
    const lwmDuration = stats(losersWithMFE3.map(t => parseInt(t.Duration) / 60000));
    const lwmMFETime = stats(losersWithMFE3.map(t => t._mfeMinutes));
    console.log(`\nLosers with MFE >= 3pts (${losersWithMFE3.length} trades):`);
    console.log(`  Duration: mean=${lwmDuration.mean}min, MFE reached at: mean=${lwmMFETime.mean}min`);
    console.log(`  These could have been saved with a tighter trailing stop or breakeven stop`);
  }

  // ─── Time of Day Analysis ─────────────────────────────────────────────────

  console.log(`\n========== TIME OF DAY (EST) ==========\n`);
  const hourBuckets = {};
  for (let h = 9; h <= 16; h++) {
    hourBuckets[h] = { total: 0, win: 0, lose: 0, pnl: 0 };
  }

  for (const t of trades) {
    const { hour } = getESTHour(t.EntryTime);
    if (!hourBuckets[hour]) hourBuckets[hour] = { total: 0, win: 0, lose: 0, pnl: 0 };
    hourBuckets[hour].total++;
    hourBuckets[hour].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) hourBuckets[hour].win++;
    else if (parseFloat(t.GrossPnL) < 0) hourBuckets[hour].lose++;
  }

  console.log('Hour | Trades | Win% | Total P&L | Avg P&L');
  console.log('-----|--------|------|-----------|--------');
  for (const [hour, data] of Object.entries(hourBuckets).sort((a, b) => a[0] - b[0])) {
    if (data.total === 0) continue;
    console.log(`${String(hour).padStart(4)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  // 30-minute buckets for more granularity
  console.log('\n--- 30-Minute Buckets ---');
  const halfHourBuckets = {};
  for (const t of trades) {
    const { hour, minute } = getESTHour(t.EntryTime);
    const bucket = `${String(hour).padStart(2, '0')}:${minute < 30 ? '00' : '30'}`;
    if (!halfHourBuckets[bucket]) halfHourBuckets[bucket] = { total: 0, win: 0, lose: 0, pnl: 0 };
    halfHourBuckets[bucket].total++;
    halfHourBuckets[bucket].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) halfHourBuckets[bucket].win++;
    else if (parseFloat(t.GrossPnL) < 0) halfHourBuckets[bucket].lose++;
  }

  console.log('Time  | Trades | Win% | Total P&L | Avg P&L');
  console.log('------|--------|------|-----------|--------');
  for (const [bucket, data] of Object.entries(halfHourBuckets).sort()) {
    if (data.total === 0) continue;
    console.log(`${bucket} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  // ─── Day of Week Analysis ─────────────────────────────────────────────────

  console.log(`\n========== DAY OF WEEK ==========\n`);
  const dowBuckets = {};
  for (const t of trades) {
    const dow = getDayOfWeek(t.EntryTime);
    if (!dowBuckets[dow]) dowBuckets[dow] = { total: 0, win: 0, lose: 0, pnl: 0 };
    dowBuckets[dow].total++;
    dowBuckets[dow].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) dowBuckets[dow].win++;
    else if (parseFloat(t.GrossPnL) < 0) dowBuckets[dow].lose++;
  }

  const dowOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  console.log('Day       | Trades | Win% | Total P&L | Avg P&L');
  console.log('----------|--------|------|-----------|--------');
  for (const dow of dowOrder) {
    const data = dowBuckets[dow] || { total: 0, win: 0, lose: 0, pnl: 0 };
    if (data.total === 0) continue;
    console.log(`${dow.padEnd(9)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  // ─── Side Analysis ────────────────────────────────────────────────────────

  console.log(`\n========== SIDE (Buy vs Sell) ==========\n`);
  for (const side of ['buy', 'sell']) {
    const sideTrades = trades.filter(t => t.Side === side);
    const sideWin = sideTrades.filter(t => parseFloat(t.GrossPnL) > 0).length;
    const sideLose = sideTrades.filter(t => parseFloat(t.GrossPnL) < 0).length;
    const sidePnL = sideTrades.reduce((s, t) => s + parseFloat(t.GrossPnL), 0);
    const sideMFE = stats(sideTrades.map(t => t._mfe));
    const sideMAE = stats(sideTrades.map(t => t._mae));
    console.log(`${side.toUpperCase()}: ${sideTrades.length} trades, ${pctOf(sideWin, sideTrades.length)} win, P&L: $${sidePnL.toFixed(0)}, avg: $${(sidePnL / sideTrades.length).toFixed(2)}`);
    console.log(`  MFE: mean=${sideMFE.mean}, MAE: mean=${sideMAE.mean}`);
  }

  // ─── GEX Regime Analysis ──────────────────────────────────────────────────

  console.log(`\n========== GEX REGIME AT ENTRY ==========\n`);
  const regimeBuckets = {};
  for (const t of trades) {
    const regime = t._gexRegime || 'unknown';
    if (!regimeBuckets[regime]) regimeBuckets[regime] = { total: 0, win: 0, lose: 0, pnl: 0, mfes: [], maes: [] };
    regimeBuckets[regime].total++;
    regimeBuckets[regime].pnl += parseFloat(t.GrossPnL);
    regimeBuckets[regime].mfes.push(t._mfe);
    regimeBuckets[regime].maes.push(t._mae);
    if (parseFloat(t.GrossPnL) > 0) regimeBuckets[regime].win++;
    else if (parseFloat(t.GrossPnL) < 0) regimeBuckets[regime].lose++;
  }

  console.log('Regime           | Trades | Win% | Total P&L | Avg P&L | Avg MFE | Avg MAE');
  console.log('-----------------|--------|------|-----------|---------|---------|--------');
  for (const [regime, data] of Object.entries(regimeBuckets).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const mfe = stats(data.mfes);
    const mae = stats(data.maes);
    console.log(`${regime.padEnd(16)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2).padStart(7)} | ${String(mfe.mean).padStart(7)} | ${String(mae.mean).padStart(7)}`);
  }

  // ─── GEX Regime × Side ────────────────────────────────────────────────────

  console.log(`\n========== GEX REGIME × SIDE ==========\n`);
  const regimeSide = {};
  for (const t of trades) {
    const key = `${t._gexRegime || 'unknown'}_${t.Side}`;
    if (!regimeSide[key]) regimeSide[key] = { total: 0, win: 0, lose: 0, pnl: 0 };
    regimeSide[key].total++;
    regimeSide[key].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) regimeSide[key].win++;
    else if (parseFloat(t.GrossPnL) < 0) regimeSide[key].lose++;
  }

  console.log('Regime × Side         | Trades | Win% | Total P&L | Avg P&L');
  console.log('----------------------|--------|------|-----------|--------');
  for (const [key, data] of Object.entries(regimeSide).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`${key.padEnd(21)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  // ─── LT Sentiment Analysis ────────────────────────────────────────────────

  console.log(`\n========== LT SENTIMENT AT ENTRY ==========\n`);
  const ltSentBuckets = {};
  for (const t of trades) {
    const sent = t._ltSentiment || t.LTSentiment || 'unknown';
    if (!ltSentBuckets[sent]) ltSentBuckets[sent] = { total: 0, win: 0, lose: 0, pnl: 0 };
    ltSentBuckets[sent].total++;
    ltSentBuckets[sent].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) ltSentBuckets[sent].win++;
    else if (parseFloat(t.GrossPnL) < 0) ltSentBuckets[sent].lose++;
  }

  for (const [sent, data] of Object.entries(ltSentBuckets)) {
    console.log(`${sent}: ${data.total} trades, ${pctOf(data.win, data.total)} win, P&L: $${data.pnl.toFixed(0)}, avg: $${(data.pnl / data.total).toFixed(2)}`);
  }

  // ─── LT Sentiment × Side ─────────────────────────────────────────────────

  console.log(`\n========== LT SENTIMENT × SIDE ==========\n`);
  const ltSentSide = {};
  for (const t of trades) {
    const sent = t._ltSentiment || t.LTSentiment || 'unknown';
    const key = `${sent}_${t.Side}`;
    if (!ltSentSide[key]) ltSentSide[key] = { total: 0, win: 0, lose: 0, pnl: 0 };
    ltSentSide[key].total++;
    ltSentSide[key].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) ltSentSide[key].win++;
    else if (parseFloat(t.GrossPnL) < 0) ltSentSide[key].lose++;
  }

  console.log('LT Sentiment × Side   | Trades | Win% | Total P&L | Avg P&L');
  console.log('-----------------------|--------|------|-----------|--------');
  for (const [key, data] of Object.entries(ltSentSide).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`${key.padEnd(22)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  // ─── LT Levels Below Entry ────────────────────────────────────────────────

  console.log(`\n========== LT LEVELS BELOW ENTRY ==========\n`);
  const ltBelowBuckets = {};
  for (const t of trades) {
    if (t._ltLevelsBelow === undefined) continue;
    const key = t._ltLevelsBelow;
    if (!ltBelowBuckets[key]) ltBelowBuckets[key] = { total: 0, win: 0, lose: 0, pnl: 0 };
    ltBelowBuckets[key].total++;
    ltBelowBuckets[key].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) ltBelowBuckets[key].win++;
    else if (parseFloat(t.GrossPnL) < 0) ltBelowBuckets[key].lose++;
  }

  console.log('Levels Below | Trades | Win% | Total P&L | Avg P&L');
  console.log('-------------|--------|------|-----------|--------');
  for (const [key, data] of Object.entries(ltBelowBuckets).sort((a, b) => a[0] - b[0])) {
    console.log(`${String(key).padStart(12)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  // ─── Distance to GEX Levels ───────────────────────────────────────────────

  console.log(`\n========== DISTANCE TO GEX GAMMA FLIP ==========\n`);
  const distBuckets = { 'below_50+': { w: 0, l: 0, wpnl: 0, lpnl: 0 }, 'below_20-50': { w: 0, l: 0, wpnl: 0, lpnl: 0 }, 'below_0-20': { w: 0, l: 0, wpnl: 0, lpnl: 0 }, 'above_0-20': { w: 0, l: 0, wpnl: 0, lpnl: 0 }, 'above_20-50': { w: 0, l: 0, wpnl: 0, lpnl: 0 }, 'above_50+': { w: 0, l: 0, wpnl: 0, lpnl: 0 } };

  for (const t of trades) {
    if (t._distToGammaFlip == null) continue;
    const dist = t._distToGammaFlip; // positive = above GF, negative = below
    const pnl = parseFloat(t.GrossPnL);
    const isWin = pnl > 0;

    let bucket;
    if (dist < -50) bucket = 'below_50+';
    else if (dist < -20) bucket = 'below_20-50';
    else if (dist < 0) bucket = 'below_0-20';
    else if (dist < 20) bucket = 'above_0-20';
    else if (dist < 50) bucket = 'above_20-50';
    else bucket = 'above_50+';

    if (isWin) { distBuckets[bucket].w++; distBuckets[bucket].wpnl += pnl; }
    else { distBuckets[bucket].l++; distBuckets[bucket].lpnl += pnl; }
  }

  console.log('Dist to GF     | Wins | Losses | Win% | Win P&L | Loss P&L | Net P&L');
  console.log('---------------|------|--------|------|---------|----------|--------');
  for (const [bucket, data] of Object.entries(distBuckets)) {
    const total = data.w + data.l;
    if (total === 0) continue;
    console.log(`${bucket.padEnd(14)} | ${String(data.w).padStart(4)} | ${String(data.l).padStart(6)} | ${pctOf(data.w, total).padStart(5)} | $${data.wpnl.toFixed(0).padStart(7)} | $${data.lpnl.toFixed(0).padStart(8)} | $${(data.wpnl + data.lpnl).toFixed(0)}`);
  }

  // ─── LT Average Spacing Analysis ──────────────────────────────────────────

  console.log(`\n========== LT AVERAGE SPACING ==========\n`);
  const spacingBuckets = {};
  for (const t of trades) {
    if (!t._ltAvgSpacing) continue;
    const spacing = t._ltAvgSpacing;
    let bucket;
    if (spacing < 10) bucket = '<10';
    else if (spacing < 20) bucket = '10-20';
    else if (spacing < 40) bucket = '20-40';
    else if (spacing < 80) bucket = '40-80';
    else if (spacing < 150) bucket = '80-150';
    else bucket = '150+';

    if (!spacingBuckets[bucket]) spacingBuckets[bucket] = { total: 0, win: 0, lose: 0, pnl: 0 };
    spacingBuckets[bucket].total++;
    spacingBuckets[bucket].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) spacingBuckets[bucket].win++;
    else if (parseFloat(t.GrossPnL) < 0) spacingBuckets[bucket].lose++;
  }

  console.log('LT Spacing | Trades | Win% | Total P&L | Avg P&L');
  console.log('-----------|--------|------|-----------|--------');
  for (const bucket of ['<10', '10-20', '20-40', '40-80', '80-150', '150+']) {
    const data = spacingBuckets[bucket];
    if (!data || data.total === 0) continue;
    console.log(`${bucket.padEnd(10)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  // ─── Potential Improvement: Breakeven Stop at N points ────────────────────

  console.log(`\n========== SIMULATED BREAKEVEN STOP ==========\n`);
  console.log('What if we moved stop to breakeven after reaching N points of profit?');
  console.log('(Shows how many current losers would become breakeven, and impact on winners)\n');

  for (const threshold of [2, 3, 4, 5]) {
    // Losers that reached this MFE threshold (would become breakeven)
    const savedLosers = losers.filter(t => t._mfe >= threshold);
    const savedPnL = savedLosers.reduce((s, t) => s + parseFloat(t.GrossPnL), 0);

    // Winners that had MAE > their final profit but MFE >= threshold
    // These winners might get stopped at breakeven if their path was: entry -> profit -> pullback -> profit
    // We need to check: did price go to +threshold, then pull back to entry, before reaching target?
    // With 1-min data we can approximate: if MAE > 0 AND MFE was reached before MAE

    // Simpler: winners where MFE < target (10pts) might lose some profit
    // Actually breakeven stop doesn't hurt winners that reach target - they'd still hit TP
    // It only hurts winners that hit +threshold, pulled back to entry (stopped at BE), then rallied
    // Those trades become breakeven instead of winners
    const winnersAtRisk = winners.filter(t => t._mfe >= threshold && t._mae >= threshold);

    console.log(`Breakeven at +${threshold}pts:`);
    console.log(`  Losers saved: ${savedLosers.length}/${losers.length} (${pctOf(savedLosers.length, losers.length)}), recovering $${Math.abs(savedPnL).toFixed(0)} in losses`);
    console.log(`  Winners at risk (had both MFE>=${threshold} AND MAE>=${threshold}): ${winnersAtRisk.length}`);
    console.log(`  Net saved losers P&L: $${Math.abs(savedPnL).toFixed(0)} vs max risk of losing ${winnersAtRisk.length} winning trades`);
  }

  // ─── Potential Improvement: Time-based Exit ───────────────────────────────

  console.log(`\n========== SIMULATED EARLY EXIT BY TIME ==========\n`);
  console.log('What if we closed losers after N minutes instead of waiting for stop?');

  for (const maxMin of [5, 10, 15, 20]) {
    const earlyExitTrades = losers.filter(t => parseInt(t.Duration) / 60000 > maxMin);
    // These trades would exit at whatever price was at maxMin minutes
    // We can't precisely calculate but we can check: how many losers last longer than maxMin?
    const laterLosers = losers.filter(t => parseInt(t.Duration) / 60000 > maxMin);
    const earlyLosers = losers.filter(t => parseInt(t.Duration) / 60000 <= maxMin);

    // Also check winners that would be prematurely exited
    const prematureWinners = winners.filter(t => parseInt(t.Duration) / 60000 > maxMin);

    console.log(`Exit at ${maxMin}min: ${laterLosers.length} losers last longer (would exit earlier), BUT ${prematureWinners.length} winners also take longer than ${maxMin}min`);
  }

  // ─── Monthly Performance ──────────────────────────────────────────────────

  console.log(`\n========== MONTHLY PERFORMANCE ==========\n`);
  const monthBuckets = {};
  for (const t of trades) {
    const d = new Date(t.EntryTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!monthBuckets[key]) monthBuckets[key] = { total: 0, win: 0, lose: 0, pnl: 0 };
    monthBuckets[key].total++;
    monthBuckets[key].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) monthBuckets[key].win++;
    else if (parseFloat(t.GrossPnL) < 0) monthBuckets[key].lose++;
  }

  console.log('Month    | Trades | Win% | Total P&L | Avg P&L');
  console.log('---------|--------|------|-----------|--------');
  let consecutiveLosing = 0;
  let maxConsecutiveLosing = 0;
  for (const [month, data] of Object.entries(monthBuckets).sort()) {
    console.log(`${month} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
    if (data.pnl < 0) { consecutiveLosing++; maxConsecutiveLosing = Math.max(maxConsecutiveLosing, consecutiveLosing); }
    else consecutiveLosing = 0;
  }
  console.log(`\nMax consecutive losing months: ${maxConsecutiveLosing}`);

  // ─── Losing Streak Analysis ───────────────────────────────────────────────

  console.log(`\n========== LOSING STREAK ANALYSIS ==========\n`);
  let currentStreak = 0, maxLoseStreak = 0, maxWinStreak = 0, currentWinStreak = 0;
  const loseStreaks = [];
  const winStreaks = [];

  for (const t of trades) {
    if (parseFloat(t.GrossPnL) < 0) {
      currentStreak++;
      if (currentWinStreak > 0) winStreaks.push(currentWinStreak);
      currentWinStreak = 0;
    } else {
      if (currentStreak > 0) loseStreaks.push(currentStreak);
      currentStreak = 0;
      currentWinStreak++;
    }
    maxLoseStreak = Math.max(maxLoseStreak, currentStreak);
    maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
  }
  if (currentStreak > 0) loseStreaks.push(currentStreak);
  if (currentWinStreak > 0) winStreaks.push(currentWinStreak);

  console.log(`Max losing streak: ${maxLoseStreak}`);
  console.log(`Max winning streak: ${maxWinStreak}`);
  console.log(`Avg losing streak: ${stats(loseStreaks).mean}`);
  console.log(`Avg winning streak: ${stats(winStreaks).mean}`);

  // ─── COMPOSITE: Multi-factor loser profile ────────────────────────────────

  console.log(`\n========== COMPOSITE LOSER PROFILE ==========\n`);
  console.log('Looking for factor combinations that disproportionately produce losers...\n');

  // GEX regime × Time of Day × Side
  const compositeMap = {};
  for (const t of trades) {
    const { hour } = getESTHour(t.EntryTime);
    const timeBlock = hour < 11 ? 'morning(9-11)' : hour < 13 ? 'midday(11-13)' : hour < 15 ? 'afternoon(13-15)' : 'close(15-16)';
    const regime = t._gexRegime || 'unknown';
    const key = `${regime} | ${timeBlock} | ${t.Side}`;

    if (!compositeMap[key]) compositeMap[key] = { total: 0, win: 0, lose: 0, pnl: 0 };
    compositeMap[key].total++;
    compositeMap[key].pnl += parseFloat(t.GrossPnL);
    if (parseFloat(t.GrossPnL) > 0) compositeMap[key].win++;
    else if (parseFloat(t.GrossPnL) < 0) compositeMap[key].lose++;
  }

  // Sort by avg P&L to find worst combinations
  const compositeArr = Object.entries(compositeMap)
    .filter(([, d]) => d.total >= 20) // Minimum sample size
    .sort((a, b) => (a[1].pnl / a[1].total) - (b[1].pnl / b[1].total));

  console.log('WORST combinations (min 20 trades):');
  console.log('Regime | Time | Side          | Trades | Win% | Total P&L | Avg P&L');
  console.log('------------------------------|--------|------|-----------|--------');
  for (const [key, data] of compositeArr.slice(0, 15)) {
    console.log(`${key.padEnd(29)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  console.log('\nBEST combinations (min 20 trades):');
  for (const [key, data] of compositeArr.slice(-10).reverse()) {
    console.log(`${key.padEnd(29)} | ${String(data.total).padStart(6)} | ${pctOf(data.win, data.total).padStart(5)} | $${data.pnl.toFixed(0).padStart(9)} | $${(data.pnl / data.total).toFixed(2)}`);
  }

  console.log(`\n========== ANALYSIS COMPLETE ==========`);
}

main().catch(console.error);
