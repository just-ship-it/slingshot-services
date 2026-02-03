#!/usr/bin/env node
/**
 * Backtest: IV Skew GEX Strategy
 *
 * Proper backtest simulation with:
 * - Realistic entry/exit execution
 * - Stop loss and take profit
 * - Signal cooldown
 * - Proper position tracking
 * - Trade-by-trade accounting
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  ohlcvFile: path.join(__dirname, 'data/ohlcv/nq/NQ_ohlcv_1m.csv'),
  ivFile: path.join(__dirname, 'data/iv/qqq/qqq_atm_iv_15m.csv'),
  gexDir: path.join(__dirname, 'data/gex/nq'),
};

// Strategy parameters
const STRATEGY = {
  // Entry conditions
  negSkewThreshold: -0.01,    // For LONG
  posSkewThreshold: 0.01,     // For SHORT
  levelProximity: 25,         // Points from GEX level

  // Risk management
  stopLossPts: 15,
  takeProfitPts: 30,
  maxHoldBars: 60,            // 60 minutes

  // Signal management
  cooldownBars: 30,           // 30 minutes between signals
  avoidHours: [12],           // Skip noon for SHORT (20% win rate)

  // Filters
  minIV: 0.18,                // Skip low IV environment
  tradeSupport: ['S1', 'S2', 'S3', 'S4', 'S5', 'PutWall', 'GammaFlip'],
  tradeResistance: ['R1', 'R2', 'R3', 'R4', 'R5', 'CallWall', 'GammaFlip'],
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
        callIV: parseFloat(record.call_iv),
        putIV: parseFloat(record.put_iv),
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
        support: snapshot.support || [],
        resistance: snapshot.resistance || [],
        callWall: snapshot.call_wall,
        putWall: snapshot.put_wall,
        gammaFlip: snapshot.gamma_flip,
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

function getGexProximity(price, gexLevels, category) {
  if (!gexLevels) return null;

  const allLevels = [];

  if (category === 'support' || category === 'all') {
    (gexLevels.support || []).forEach((level, i) => {
      if (level && STRATEGY.tradeSupport.includes(`S${i+1}`))
        allLevels.push({ type: `S${i+1}`, level, category: 'support' });
    });
    if (gexLevels.putWall && STRATEGY.tradeSupport.includes('PutWall'))
      allLevels.push({ type: 'PutWall', level: gexLevels.putWall, category: 'support' });
    if (gexLevels.gammaFlip && STRATEGY.tradeSupport.includes('GammaFlip'))
      allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'support' });
  }

  if (category === 'resistance' || category === 'all') {
    (gexLevels.resistance || []).forEach((level, i) => {
      if (level && STRATEGY.tradeResistance.includes(`R${i+1}`))
        allLevels.push({ type: `R${i+1}`, level, category: 'resistance' });
    });
    if (gexLevels.callWall && STRATEGY.tradeResistance.includes('CallWall'))
      allLevels.push({ type: 'CallWall', level: gexLevels.callWall, category: 'resistance' });
    if (gexLevels.gammaFlip && STRATEGY.tradeResistance.includes('GammaFlip'))
      allLevels.push({ type: 'GammaFlip', level: gexLevels.gammaFlip, category: 'resistance' });
  }

  let nearest = null;
  let nearestDist = Infinity;

  for (const lvl of allLevels) {
    const dist = Math.abs(price - lvl.level);
    if (dist < nearestDist && dist <= STRATEGY.levelProximity) {
      nearestDist = dist;
      nearest = { ...lvl, distance: dist };
    }
  }

  return nearest;
}

// ============= Backtest Engine =============

async function runBacktest(startDate, endDate) {
  const candles = await loadOHLCV(startDate, endDate);
  const ivData = await loadIVData();
  const gexMap = await loadGexLevels(startDate, endDate);

  console.log(`Loaded: ${candles.length} candles, ${ivData.length} IV records, ${gexMap.size} GEX snapshots\n`);

  const trades = [];
  let position = null;
  let lastSignalBar = -STRATEGY.cooldownBars;
  let barIndex = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Only trade RTH
    if (!isRTH(candle.timestamp)) continue;

    barIndex++;
    const hour = getETHour(candle.timestamp);

    // If in position, check for exit
    if (position) {
      const pnl = position.side === 'LONG'
        ? candle.close - position.entryPrice
        : position.entryPrice - candle.close;

      const highPnl = position.side === 'LONG'
        ? candle.high - position.entryPrice
        : position.entryPrice - candle.low;

      const lowPnl = position.side === 'LONG'
        ? candle.low - position.entryPrice
        : position.entryPrice - candle.high;

      // Check stop loss (worst case first)
      if (lowPnl <= -STRATEGY.stopLossPts) {
        position.exitPrice = position.side === 'LONG'
          ? position.entryPrice - STRATEGY.stopLossPts
          : position.entryPrice + STRATEGY.stopLossPts;
        position.exitTime = candle.timestamp;
        position.exitReason = 'STOP';
        position.pnl = -STRATEGY.stopLossPts;
        position.barsHeld = barIndex - position.entryBar;
        trades.push({ ...position });
        position = null;
        continue;
      }

      // Check take profit
      if (highPnl >= STRATEGY.takeProfitPts) {
        position.exitPrice = position.side === 'LONG'
          ? position.entryPrice + STRATEGY.takeProfitPts
          : position.entryPrice - STRATEGY.takeProfitPts;
        position.exitTime = candle.timestamp;
        position.exitReason = 'TARGET';
        position.pnl = STRATEGY.takeProfitPts;
        position.barsHeld = barIndex - position.entryBar;
        trades.push({ ...position });
        position = null;
        continue;
      }

      // Check max hold time
      if (barIndex - position.entryBar >= STRATEGY.maxHoldBars) {
        position.exitPrice = candle.close;
        position.exitTime = candle.timestamp;
        position.exitReason = 'TIME';
        position.pnl = pnl;
        position.barsHeld = STRATEGY.maxHoldBars;
        trades.push({ ...position });
        position = null;
        continue;
      }

      continue; // Still in position, don't look for new signals
    }

    // Check cooldown
    if (barIndex - lastSignalBar < STRATEGY.cooldownBars) continue;

    // Get market data
    const gex = getActiveGexLevels(gexMap, candle.timestamp);
    if (!gex) continue;

    const iv = getIVAtTime(ivData, candle.timestamp);
    if (!iv) continue;

    // Skip low IV
    if (iv.iv < STRATEGY.minIV) continue;

    // Check for LONG signal: Support + Negative Skew
    if (iv.skew < STRATEGY.negSkewThreshold) {
      const level = getGexProximity(candle.close, gex, 'support');
      if (level) {
        position = {
          side: 'LONG',
          entryPrice: candle.close,
          entryTime: candle.timestamp,
          entryBar: barIndex,
          level: level.type,
          levelPrice: level.level,
          levelDistance: level.distance,
          skew: iv.skew,
          iv: iv.iv,
          hour
        };
        lastSignalBar = barIndex;
        continue;
      }
    }

    // Check for SHORT signal: Resistance + Positive Skew
    if (iv.skew > STRATEGY.posSkewThreshold) {
      // Skip noon for shorts
      if (STRATEGY.avoidHours.includes(hour)) continue;

      const level = getGexProximity(candle.close, gex, 'resistance');
      if (level) {
        position = {
          side: 'SHORT',
          entryPrice: candle.close,
          entryTime: candle.timestamp,
          entryBar: barIndex,
          level: level.type,
          levelPrice: level.level,
          levelDistance: level.distance,
          skew: iv.skew,
          iv: iv.iv,
          hour
        };
        lastSignalBar = barIndex;
        continue;
      }
    }
  }

  // Close any open position at end
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const pnl = position.side === 'LONG'
      ? lastCandle.close - position.entryPrice
      : position.entryPrice - lastCandle.close;
    position.exitPrice = lastCandle.close;
    position.exitTime = lastCandle.timestamp;
    position.exitReason = 'EOD';
    position.pnl = pnl;
    position.barsHeld = barIndex - position.entryBar;
    trades.push({ ...position });
  }

  return trades;
}

function analyzeResults(trades) {
  if (trades.length === 0) {
    console.log('No trades generated\n');
    return;
  }

  const totalTrades = trades.length;
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const winRate = winners.length / totalTrades * 100;

  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnL = totalPnL / totalTrades;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0;

  const maxWin = Math.max(...trades.map(t => t.pnl));
  const maxLoss = Math.min(...trades.map(t => t.pnl));

  // Profit factor
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;

  // By exit reason
  const byReason = {};
  trades.forEach(t => {
    if (!byReason[t.exitReason]) byReason[t.exitReason] = { count: 0, pnl: 0 };
    byReason[t.exitReason].count++;
    byReason[t.exitReason].pnl += t.pnl;
  });

  // By side
  const longTrades = trades.filter(t => t.side === 'LONG');
  const shortTrades = trades.filter(t => t.side === 'SHORT');

  console.log('=== OVERALL RESULTS ===\n');
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`  LONG:  ${longTrades.length}`);
  console.log(`  SHORT: ${shortTrades.length}`);
  console.log(`\nWin Rate: ${winRate.toFixed(1)}%`);
  console.log(`  Winners: ${winners.length}`);
  console.log(`  Losers:  ${losers.length}`);
  console.log(`\nTotal P&L: ${totalPnL.toFixed(1)} pts`);
  console.log(`Avg P&L:   ${avgPnL.toFixed(2)} pts/trade`);
  console.log(`Avg Win:   ${avgWin.toFixed(2)} pts`);
  console.log(`Avg Loss:  ${avgLoss.toFixed(2)} pts`);
  console.log(`Max Win:   ${maxWin.toFixed(2)} pts`);
  console.log(`Max Loss:  ${maxLoss.toFixed(2)} pts`);
  console.log(`\nProfit Factor: ${profitFactor.toFixed(2)}`);

  console.log('\n=== BY EXIT REASON ===\n');
  console.log('Reason  | Count | Total P&L | Avg P&L');
  console.log('-'.repeat(45));
  for (const [reason, stats] of Object.entries(byReason)) {
    console.log(`${reason.padEnd(7)} | ${stats.count.toString().padStart(5)} | ${stats.pnl.toFixed(1).padStart(9)} | ${(stats.pnl/stats.count).toFixed(2).padStart(7)}`);
  }

  console.log('\n=== BY SIDE ===\n');

  if (longTrades.length > 0) {
    const longWinners = longTrades.filter(t => t.pnl > 0);
    const longPnL = longTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`LONG: ${longTrades.length} trades | ${(longWinners.length/longTrades.length*100).toFixed(1)}% win | ${longPnL.toFixed(1)} pts total | ${(longPnL/longTrades.length).toFixed(2)} avg`);
  }

  if (shortTrades.length > 0) {
    const shortWinners = shortTrades.filter(t => t.pnl > 0);
    const shortPnL = shortTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`SHORT: ${shortTrades.length} trades | ${(shortWinners.length/shortTrades.length*100).toFixed(1)}% win | ${shortPnL.toFixed(1)} pts total | ${(shortPnL/shortTrades.length).toFixed(2)} avg`);
  }

  // By level type
  console.log('\n=== BY LEVEL TYPE ===\n');
  console.log('Level      | Count | Win%  | Total P&L | Avg P&L');
  console.log('-'.repeat(55));

  const byLevel = {};
  trades.forEach(t => {
    if (!byLevel[t.level]) byLevel[t.level] = { trades: [], pnl: 0 };
    byLevel[t.level].trades.push(t);
    byLevel[t.level].pnl += t.pnl;
  });

  for (const [level, stats] of Object.entries(byLevel).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const wins = stats.trades.filter(t => t.pnl > 0).length;
    const winRate = wins / stats.trades.length * 100;
    const avgPnL = stats.pnl / stats.trades.length;
    console.log(`${level.padEnd(10)} | ${stats.trades.length.toString().padStart(5)} | ${winRate.toFixed(1).padStart(5)}% | ${stats.pnl.toFixed(1).padStart(9)} | ${avgPnL.toFixed(2).padStart(7)}`);
  }

  // Equity curve
  console.log('\n=== EQUITY CURVE (Cumulative P&L) ===\n');
  let cumPnL = 0;
  let maxDD = 0;
  let peak = 0;

  const equityPoints = [];
  for (const t of trades) {
    cumPnL += t.pnl;
    peak = Math.max(peak, cumPnL);
    const dd = peak - cumPnL;
    maxDD = Math.max(maxDD, dd);
    equityPoints.push({ time: t.exitTime, cumPnL, dd });
  }

  console.log(`Starting: 0 pts`);
  console.log(`Final:    ${cumPnL.toFixed(1)} pts`);
  console.log(`Peak:     ${peak.toFixed(1)} pts`);
  console.log(`Max DD:   ${maxDD.toFixed(1)} pts`);

  // Sample trades
  console.log('\n=== SAMPLE TRADES (First 10) ===\n');
  console.log('Time              | Side  | Level    | Entry   | Exit    | P&L   | Reason');
  console.log('-'.repeat(85));

  for (const t of trades.slice(0, 10)) {
    const timeStr = new Date(t.entryTime).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    console.log(`${timeStr.padEnd(17)} | ${t.side.padEnd(5)} | ${t.level.padEnd(8)} | ${t.entryPrice.toFixed(1).padStart(7)} | ${t.exitPrice.toFixed(1).padStart(7)} | ${t.pnl.toFixed(1).padStart(5)} | ${t.exitReason}`);
  }

  return {
    totalTrades,
    winRate,
    totalPnL,
    avgPnL,
    profitFactor,
    maxDD,
    trades
  };
}

async function main() {
  console.log('=== IV Skew GEX Strategy Backtest ===\n');

  console.log('Strategy Parameters:');
  console.log(`  Negative Skew Threshold: ${STRATEGY.negSkewThreshold} (LONG)`);
  console.log(`  Positive Skew Threshold: ${STRATEGY.posSkewThreshold} (SHORT)`);
  console.log(`  Level Proximity: ${STRATEGY.levelProximity} pts`);
  console.log(`  Stop Loss: ${STRATEGY.stopLossPts} pts`);
  console.log(`  Take Profit: ${STRATEGY.takeProfitPts} pts`);
  console.log(`  Max Hold: ${STRATEGY.maxHoldBars} bars`);
  console.log(`  Cooldown: ${STRATEGY.cooldownBars} bars`);
  console.log(`  Min IV: ${STRATEGY.minIV}`);
  console.log(`  Avoid Hours (SHORT): ${STRATEGY.avoidHours.join(', ')}\n`);

  // Run backtest
  const startDate = new Date('2025-01-02');
  const endDate = new Date('2025-01-25');

  console.log(`Period: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)}\n`);

  const trades = await runBacktest(startDate, endDate);
  const results = analyzeResults(trades);

  // Save trades
  const outputFile = path.join(__dirname, 'results/iv-skew-backtest-trades.json');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify({
    strategy: STRATEGY,
    period: { start: startDate.toISOString(), end: endDate.toISOString() },
    results: results ? { totalTrades: results.totalTrades, winRate: results.winRate, totalPnL: results.totalPnL, profitFactor: results.profitFactor } : null,
    trades
  }, null, 2));

  console.log(`\nTrades saved to: ${outputFile}`);
}

main().catch(console.error);
