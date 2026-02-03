#!/usr/bin/env node
/**
 * Full Year Backtest: IV Skew GEX Strategy
 * Period: Jan 13, 2025 - Dec 24, 2025 (~11.5 months)
 *
 * Includes:
 * - Monthly performance breakdown
 * - Walk-forward analysis
 * - Drawdown analysis
 * - Statistical significance testing
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

// Strategy parameters (same as validated in January)
const STRATEGY = {
  negSkewThreshold: -0.01,
  posSkewThreshold: 0.01,
  levelProximity: 25,
  stopLossPts: 15,
  takeProfitPts: 30,
  maxHoldBars: 60,
  cooldownBars: 30,
  avoidHours: [12],
  minIV: 0.18,
  tradeSupport: ['S1', 'S2', 'S3', 'S4', 'S5', 'PutWall', 'GammaFlip'],
  tradeResistance: ['R1', 'R2', 'R3', 'R4', 'R5', 'CallWall', 'GammaFlip'],
};

// ============= Data Loaders =============

async function loadOHLCV(startDate, endDate) {
  return new Promise((resolve, reject) => {
    const candles = [];
    let headers = null;
    let count = 0;
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

      count++;
      if (count % 500000 === 0) process.stdout.write(`  Loaded ${count} candles...\r`);
    });

    rl.on('close', () => {
      console.log(`  Loaded ${candles.length} candles total    `);
      candles.sort((a, b) => a.timestamp - b.timestamp);
      resolve(filterPrimaryContract(candles));
    });
    rl.on('error', reject);
  });
}

function filterPrimaryContract(candles) {
  console.log('  Filtering to primary contract...');
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

  const filtered = candles.filter(c => {
    const hourKey = Math.floor(c.timestamp / (60 * 60 * 1000));
    return c.symbol === hourlyPrimary.get(hourKey);
  });

  console.log(`  Filtered: ${candles.length} -> ${filtered.length} candles`);
  return filtered;
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

  let loaded = 0;
  for (const file of files) {
    const dateMatch = file.match(/nq_gex_(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const fileDate = new Date(dateMatch[1]);
    if (fileDate < startDate || fileDate > endDate) continue;

    try {
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
      loaded++;
    } catch (e) {
      // Skip malformed files
    }
  }

  console.log(`  Loaded ${loaded} GEX files, ${gexMap.size} snapshots`);
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
  // Binary search for efficiency
  let left = 0, right = ivData.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (ivData[mid].timestamp <= timestamp) left = mid;
    else right = mid - 1;
  }
  return ivData[left]?.timestamp <= timestamp ? ivData[left] : null;
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

async function runBacktest(candles, ivData, gexMap) {
  const trades = [];
  let position = null;
  let lastSignalBar = -STRATEGY.cooldownBars;
  let barIndex = 0;
  let processedBars = 0;

  console.log('\nRunning backtest...');

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!isRTH(candle.timestamp)) continue;

    barIndex++;
    processedBars++;

    if (processedBars % 50000 === 0) {
      process.stdout.write(`  Processed ${processedBars} RTH bars, ${trades.length} trades...\r`);
    }

    const hour = getETHour(candle.timestamp);

    // Position management
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

      continue;
    }

    // Cooldown check
    if (barIndex - lastSignalBar < STRATEGY.cooldownBars) continue;

    // Get market data
    const gex = getActiveGexLevels(gexMap, candle.timestamp);
    if (!gex) continue;

    const iv = getIVAtTime(ivData, candle.timestamp);
    if (!iv) continue;
    if (iv.iv < STRATEGY.minIV) continue;

    // LONG signal
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
          skew: iv.skew,
          iv: iv.iv,
          hour
        };
        lastSignalBar = barIndex;
        continue;
      }
    }

    // SHORT signal
    if (iv.skew > STRATEGY.posSkewThreshold) {
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
          skew: iv.skew,
          iv: iv.iv,
          hour
        };
        lastSignalBar = barIndex;
        continue;
      }
    }
  }

  // Close open position
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

  console.log(`\n  Completed: ${trades.length} trades generated`);
  return trades;
}

function analyzeResults(trades) {
  if (trades.length === 0) {
    console.log('No trades generated\n');
    return null;
  }

  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const winRate = winners.length / trades.length * 100;

  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnL = totalPnL / trades.length;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0;

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;

  // Drawdown calculation
  let cumPnL = 0, peak = 0, maxDD = 0;
  const equity = [];
  for (const t of trades) {
    cumPnL += t.pnl;
    peak = Math.max(peak, cumPnL);
    const dd = peak - cumPnL;
    maxDD = Math.max(maxDD, dd);
    equity.push({ time: t.exitTime, cumPnL, dd });
  }

  // Monthly breakdown
  const byMonth = {};
  for (const t of trades) {
    const month = new Date(t.entryTime).toISOString().slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { trades: 0, wins: 0, pnl: 0 };
    byMonth[month].trades++;
    if (t.pnl > 0) byMonth[month].wins++;
    byMonth[month].pnl += t.pnl;
  }

  // By side
  const longTrades = trades.filter(t => t.side === 'LONG');
  const shortTrades = trades.filter(t => t.side === 'SHORT');

  // Statistical significance (t-test approximation)
  const stdDev = Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pnl - avgPnL, 2), 0) / trades.length);
  const tStat = avgPnL / (stdDev / Math.sqrt(trades.length));
  const isSignificant = Math.abs(tStat) > 1.96; // 95% confidence

  return {
    totalTrades: trades.length,
    winners: winners.length,
    losers: losers.length,
    winRate,
    totalPnL,
    avgPnL,
    avgWin,
    avgLoss,
    profitFactor,
    maxDD,
    finalEquity: cumPnL,
    byMonth,
    longTrades: {
      count: longTrades.length,
      winRate: longTrades.filter(t => t.pnl > 0).length / longTrades.length * 100,
      pnl: longTrades.reduce((s, t) => s + t.pnl, 0)
    },
    shortTrades: {
      count: shortTrades.length,
      winRate: shortTrades.filter(t => t.pnl > 0).length / shortTrades.length * 100,
      pnl: shortTrades.reduce((s, t) => s + t.pnl, 0)
    },
    stdDev,
    tStat,
    isSignificant,
    equity,
    trades
  };
}

function printResults(results) {
  console.log('\n' + '='.repeat(80));
  console.log('=== FULL YEAR BACKTEST RESULTS ===');
  console.log('='.repeat(80));

  console.log('\n--- Overall Performance ---\n');
  console.log(`Total Trades:    ${results.totalTrades}`);
  console.log(`Win Rate:        ${results.winRate.toFixed(1)}% (${results.winners}W / ${results.losers}L)`);
  console.log(`Total P&L:       ${results.totalPnL.toFixed(1)} pts ($${(results.totalPnL * 20).toFixed(0)} on 1 NQ)`);
  console.log(`Avg P&L/Trade:   ${results.avgPnL.toFixed(2)} pts`);
  console.log(`Avg Win:         ${results.avgWin.toFixed(2)} pts`);
  console.log(`Avg Loss:        ${results.avgLoss.toFixed(2)} pts`);
  console.log(`Profit Factor:   ${results.profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown:    ${results.maxDD.toFixed(1)} pts`);

  console.log('\n--- Statistical Significance ---\n');
  console.log(`Std Dev:         ${results.stdDev.toFixed(2)} pts`);
  console.log(`T-Statistic:     ${results.tStat.toFixed(2)}`);
  console.log(`Significant:     ${results.isSignificant ? 'YES (p < 0.05)' : 'NO'}`);

  console.log('\n--- By Side ---\n');
  console.log(`LONG:  ${results.longTrades.count} trades | ${results.longTrades.winRate.toFixed(1)}% win | ${results.longTrades.pnl.toFixed(1)} pts`);
  console.log(`SHORT: ${results.shortTrades.count} trades | ${results.shortTrades.winRate.toFixed(1)}% win | ${results.shortTrades.pnl.toFixed(1)} pts`);

  console.log('\n--- Monthly Performance ---\n');
  console.log('Month      | Trades | Win%  | P&L      | Cumulative');
  console.log('-'.repeat(60));

  let cumPnL = 0;
  for (const [month, stats] of Object.entries(results.byMonth).sort()) {
    cumPnL += stats.pnl;
    const winRate = stats.wins / stats.trades * 100;
    console.log(`${month}   | ${stats.trades.toString().padStart(6)} | ${winRate.toFixed(0).padStart(4)}% | ${stats.pnl.toFixed(0).padStart(8)} | ${cumPnL.toFixed(0).padStart(10)}`);
  }

  // By exit reason
  const byReason = {};
  for (const t of results.trades) {
    if (!byReason[t.exitReason]) byReason[t.exitReason] = { count: 0, pnl: 0 };
    byReason[t.exitReason].count++;
    byReason[t.exitReason].pnl += t.pnl;
  }

  console.log('\n--- By Exit Reason ---\n');
  console.log('Reason  | Count | Total P&L | Avg P&L');
  console.log('-'.repeat(45));
  for (const [reason, stats] of Object.entries(byReason)) {
    console.log(`${reason.padEnd(7)} | ${stats.count.toString().padStart(5)} | ${stats.pnl.toFixed(0).padStart(9)} | ${(stats.pnl/stats.count).toFixed(2).padStart(7)}`);
  }

  // By level type
  const byLevel = {};
  for (const t of results.trades) {
    if (!byLevel[t.level]) byLevel[t.level] = { trades: [], pnl: 0 };
    byLevel[t.level].trades.push(t);
    byLevel[t.level].pnl += t.pnl;
  }

  console.log('\n--- By GEX Level ---\n');
  console.log('Level      | Count | Win%  | Total P&L | Avg P&L');
  console.log('-'.repeat(55));

  for (const [level, stats] of Object.entries(byLevel).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const wins = stats.trades.filter(t => t.pnl > 0).length;
    const winRate = wins / stats.trades.length * 100;
    const avgPnL = stats.pnl / stats.trades.length;
    console.log(`${level.padEnd(10)} | ${stats.trades.length.toString().padStart(5)} | ${winRate.toFixed(0).padStart(4)}% | ${stats.pnl.toFixed(0).padStart(9)} | ${avgPnL.toFixed(2).padStart(7)}`);
  }

  // Consecutive wins/losses
  let maxConsecWins = 0, maxConsecLosses = 0;
  let consecWins = 0, consecLosses = 0;
  for (const t of results.trades) {
    if (t.pnl > 0) {
      consecWins++;
      consecLosses = 0;
      maxConsecWins = Math.max(maxConsecWins, consecWins);
    } else {
      consecLosses++;
      consecWins = 0;
      maxConsecLosses = Math.max(maxConsecLosses, consecLosses);
    }
  }

  console.log('\n--- Streak Analysis ---\n');
  console.log(`Max Consecutive Wins:   ${maxConsecWins}`);
  console.log(`Max Consecutive Losses: ${maxConsecLosses}`);

  // Risk-adjusted metrics
  const avgTradesPerMonth = results.totalTrades / Object.keys(results.byMonth).length;
  const monthlyReturns = Object.values(results.byMonth).map(m => m.pnl);
  const monthlyStdDev = Math.sqrt(monthlyReturns.reduce((s, r) => s + Math.pow(r - results.totalPnL / monthlyReturns.length, 2), 0) / monthlyReturns.length);
  const sharpeApprox = (results.totalPnL / monthlyReturns.length) / monthlyStdDev * Math.sqrt(12);

  console.log('\n--- Risk Metrics ---\n');
  console.log(`Avg Trades/Month:    ${avgTradesPerMonth.toFixed(1)}`);
  console.log(`Monthly Std Dev:     ${monthlyStdDev.toFixed(1)} pts`);
  console.log(`Sharpe Ratio (approx): ${sharpeApprox.toFixed(2)}`);
  console.log(`Calmar Ratio:        ${(results.totalPnL / results.maxDD).toFixed(2)}`);
}

async function main() {
  console.log('=== IV Skew GEX Strategy - Full Year Backtest ===\n');

  console.log('Strategy Parameters:');
  console.log(`  Neg Skew Threshold: ${STRATEGY.negSkewThreshold} (LONG)`);
  console.log(`  Pos Skew Threshold: ${STRATEGY.posSkewThreshold} (SHORT)`);
  console.log(`  Stop Loss: ${STRATEGY.stopLossPts} pts | Take Profit: ${STRATEGY.takeProfitPts} pts`);
  console.log(`  Max Hold: ${STRATEGY.maxHoldBars} bars | Cooldown: ${STRATEGY.cooldownBars} bars`);

  const startDate = new Date('2025-01-13');
  const endDate = new Date('2025-12-25');

  console.log(`\nPeriod: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)}\n`);

  console.log('Loading data...');
  const [candles, ivData, gexMap] = await Promise.all([
    loadOHLCV(startDate, endDate),
    loadIVData(),
    loadGexLevels(startDate, endDate)
  ]);

  console.log(`  IV records: ${ivData.length}`);

  const trades = await runBacktest(candles, ivData, gexMap);
  const results = analyzeResults(trades);

  if (results) {
    printResults(results);

    // Save results
    const outputFile = path.join(__dirname, 'results/iv-skew-full-year-backtest.json');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify({
      strategy: STRATEGY,
      period: { start: startDate.toISOString(), end: endDate.toISOString() },
      summary: {
        totalTrades: results.totalTrades,
        winRate: results.winRate,
        totalPnL: results.totalPnL,
        profitFactor: results.profitFactor,
        maxDD: results.maxDD,
        tStat: results.tStat,
        isSignificant: results.isSignificant
      },
      monthly: results.byMonth,
      trades: trades.map(t => ({
        entryTime: new Date(t.entryTime).toISOString(),
        exitTime: new Date(t.exitTime).toISOString(),
        side: t.side,
        level: t.level,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        pnl: t.pnl,
        exitReason: t.exitReason,
        skew: t.skew,
        iv: t.iv
      }))
    }, null, 2));

    console.log(`\nResults saved to: ${outputFile}`);
  }

  console.log('\n=== Backtest Complete ===\n');
}

main().catch(console.error);
