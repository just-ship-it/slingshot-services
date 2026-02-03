/**
 * Unified Backtest Framework for GEX Level Strategies
 *
 * Tests multiple strategies with configurable parameters:
 * - R1 Resistance Short
 * - Call Wall Short
 * - S1 Support Long
 * - Put Wall Long (for comparison)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');

// Trading costs
const COMMISSION = 2.50;
const SLIPPAGE = 0.25;

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name, defaultVal) => {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
};

const STRATEGY = getArg('strategy', 'r1-resistance-short');
const START_DATE = getArg('start', '2024-01-01');
const END_DATE = getArg('end', '2024-12-31');
const EXIT_MODE = getArg('exit', 'trailing'); // 'fixed' or 'trailing'
const DEBUG = args.includes('--debug');

// Strategy configurations
const STRATEGIES = {
  'r1-resistance-short': {
    name: 'R1 Resistance Short',
    side: 'short',
    levelType: 'resistance',
    levelIndex: 0, // R1
    touchFromBelow: true,
    stopLossPoints: 10,
    takeProfitPoints: 30,
    levelProximity: 15,
    touchThreshold: 10
  },
  'call-wall-short': {
    name: 'Call Wall Short',
    side: 'short',
    levelType: 'call_wall',
    touchFromBelow: true,
    stopLossPoints: 12,
    takeProfitPoints: 35,
    levelProximity: 15,
    touchThreshold: 10
  },
  's1-support-long': {
    name: 'S1 Support Long',
    side: 'long',
    levelType: 'support',
    levelIndex: 0, // S1
    touchFromAbove: true,
    stopLossPoints: 10,
    takeProfitPoints: 30,
    levelProximity: 15,
    touchThreshold: 10
  },
  'put-wall-long': {
    name: 'Put Wall Long',
    side: 'long',
    levelType: 'put_wall',
    touchFromAbove: true,
    stopLossPoints: 10,
    takeProfitPoints: 30,
    levelProximity: 15,
    touchThreshold: 10
  }
};

// Data loading functions
function loadOHLCV(startDate, endDate) {
  const filepath = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');

  const data = [];
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate + 'T23:59:59Z').getTime();

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length < headers.length) continue;

    const ts = new Date(values[0]).getTime();
    if (ts < startMs) continue;
    if (ts > endMs) break;

    const symbol = values[9];
    if (symbol.includes('-')) continue;

    data.push({
      timestamp: ts,
      open: parseFloat(values[4]),
      high: parseFloat(values[5]),
      low: parseFloat(values[6]),
      close: parseFloat(values[7]),
      volume: parseFloat(values[8]),
      symbol: symbol
    });
  }

  return filterPrimaryContract(data);
}

function filterPrimaryContract(candles) {
  const byHour = {};
  candles.forEach(c => {
    const hourKey = Math.floor(c.timestamp / 3600000);
    if (!byHour[hourKey]) byHour[hourKey] = [];
    byHour[hourKey].push(c);
  });

  const hourlyPrimary = {};
  Object.entries(byHour).forEach(([hour, hourCandles]) => {
    const volumeBySymbol = {};
    hourCandles.forEach(c => {
      volumeBySymbol[c.symbol] = (volumeBySymbol[c.symbol] || 0) + c.volume;
    });

    let maxVol = 0;
    let primary = null;
    Object.entries(volumeBySymbol).forEach(([symbol, vol]) => {
      if (vol > maxVol) {
        maxVol = vol;
        primary = symbol;
      }
    });
    hourlyPrimary[hour] = primary;
  });

  return candles.filter(c => {
    const hourKey = Math.floor(c.timestamp / 3600000);
    return c.symbol === hourlyPrimary[hourKey];
  });
}

function loadIntradayGEX(date) {
  const filepath = path.join(DATA_DIR, `gex/nq/nq_gex_${date}.json`);
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function getGEXAtTime(gexData, timestamp) {
  if (!gexData || !gexData.data) return null;
  let closest = null;
  const ts = new Date(timestamp);
  for (const snapshot of gexData.data) {
    const snapTs = new Date(snapshot.timestamp);
    if (snapTs <= ts) closest = snapshot;
    else break;
  }
  return closest;
}

function getSession(timestamp) {
  const date = new Date(timestamp);
  const utcHour = date.getUTCHours();
  const estHour = (utcHour - 5 + 24) % 24;

  if (estHour >= 18 || estHour < 4) return 'overnight';
  if (estHour >= 4 && estHour < 9.5) return 'premarket';
  if (estHour >= 9.5 && estHour < 16) return 'rth';
  return 'afterhours';
}

// Get level from GEX data based on strategy config
function getLevel(gexLevels, config) {
  if (!gexLevels) return null;

  if (config.levelType === 'resistance') {
    return gexLevels.resistance?.[config.levelIndex];
  } else if (config.levelType === 'support') {
    return gexLevels.support?.[config.levelIndex];
  } else if (config.levelType === 'call_wall') {
    return gexLevels.call_wall;
  } else if (config.levelType === 'put_wall') {
    return gexLevels.put_wall;
  }
  return null;
}

// Check for valid entry signal
function checkEntry(candle, gexLevels, config, lastSignalTime, cooldownMs) {
  const level = getLevel(gexLevels, config);
  if (!level) return null;

  // Check cooldown
  if (candle.timestamp - lastSignalTime < cooldownMs) return null;

  // Check proximity
  const distance = config.side === 'long'
    ? candle.close - level
    : level - candle.close;

  if (distance < 0 || distance > config.levelProximity) return null;

  // Check touch condition
  const threshold = config.touchThreshold;
  let validTouch = false;

  if (config.touchFromAbove && config.side === 'long') {
    // Price touched from above (support test)
    validTouch = candle.low <= level + threshold && candle.close > level;
  } else if (config.touchFromBelow && config.side === 'short') {
    // Price touched from below (resistance test)
    validTouch = candle.high >= level - threshold && candle.close < level;
  }

  if (!validTouch) return null;

  // Calculate stop and target
  const entryPrice = candle.close;
  let stopLoss, takeProfit;

  if (config.side === 'long') {
    stopLoss = Math.min(level - config.stopLossPoints, candle.low - 2);
    takeProfit = entryPrice + config.takeProfitPoints;
  } else {
    stopLoss = Math.max(level + config.stopLossPoints, candle.high + 2);
    takeProfit = entryPrice - config.takeProfitPoints;
  }

  // Check risk
  const risk = Math.abs(entryPrice - stopLoss);
  if (risk > 30) return null; // Max risk constraint

  return {
    timestamp: candle.timestamp,
    side: config.side,
    price: entryPrice,
    stopLoss,
    takeProfit,
    level,
    risk,
    regime: gexLevels.regime,
    session: getSession(candle.timestamp)
  };
}

// Simulate trade with exit mode
function simulateTrade(entry, candles, startIdx, exitMode, maxHoldBars = 60) {
  const { price: entryPrice, stopLoss, takeProfit, side } = entry;
  const fillPrice = side === 'long'
    ? entryPrice + SLIPPAGE
    : entryPrice - SLIPPAGE;

  let exitPrice = null;
  let exitReason = null;
  let exitBar = 0;
  let highWaterMark = fillPrice;
  let lowWaterMark = fillPrice;

  // Trailing stop parameters
  const trailingTrigger = 15;
  const trailingOffset = 8;
  let trailingActive = false;
  let trailingStop = side === 'long' ? stopLoss : stopLoss;

  for (let i = startIdx + 1; i < candles.length && i <= startIdx + maxHoldBars; i++) {
    const candle = candles[i];
    exitBar = i - startIdx;

    if (side === 'long') {
      if (candle.high > highWaterMark) highWaterMark = candle.high;

      // Check trailing activation
      if (exitMode === 'trailing' && !trailingActive) {
        if (highWaterMark - fillPrice >= trailingTrigger) {
          trailingActive = true;
          trailingStop = highWaterMark - trailingOffset;
        }
      }

      // Update trailing stop
      if (trailingActive) {
        const newStop = highWaterMark - trailingOffset;
        if (newStop > trailingStop) trailingStop = newStop;
      }

      // Check stop
      const currentStop = trailingActive ? trailingStop : stopLoss;
      if (candle.low <= currentStop) {
        exitPrice = currentStop - SLIPPAGE;
        exitReason = trailingActive ? 'trailing_stop' : 'stop_loss';
        break;
      }

      // Check target (only in fixed mode)
      if (exitMode === 'fixed' && candle.high >= takeProfit) {
        exitPrice = takeProfit;
        exitReason = 'take_profit';
        break;
      }
    } else {
      // Short
      if (candle.low < lowWaterMark) lowWaterMark = candle.low;

      // Check trailing activation
      if (exitMode === 'trailing' && !trailingActive) {
        if (fillPrice - lowWaterMark >= trailingTrigger) {
          trailingActive = true;
          trailingStop = lowWaterMark + trailingOffset;
        }
      }

      // Update trailing stop
      if (trailingActive) {
        const newStop = lowWaterMark + trailingOffset;
        if (newStop < trailingStop) trailingStop = newStop;
      }

      // Check stop
      const currentStop = trailingActive ? trailingStop : stopLoss;
      if (candle.high >= currentStop) {
        exitPrice = currentStop + SLIPPAGE;
        exitReason = trailingActive ? 'trailing_stop' : 'stop_loss';
        break;
      }

      // Check target (only in fixed mode)
      if (exitMode === 'fixed' && candle.low <= takeProfit) {
        exitPrice = takeProfit;
        exitReason = 'take_profit';
        break;
      }
    }
  }

  // Max hold exit
  if (!exitPrice) {
    const lastIdx = Math.min(startIdx + maxHoldBars, candles.length - 1);
    exitPrice = candles[lastIdx].close;
    exitReason = 'max_hold';
  }

  const pnl = side === 'long'
    ? exitPrice - fillPrice - (COMMISSION / 20)
    : fillPrice - exitPrice - (COMMISSION / 20);

  return {
    entryTime: entry.timestamp,
    entryPrice: fillPrice,
    exitPrice,
    exitReason,
    pnl,
    barsHeld: exitBar,
    side,
    level: entry.level,
    regime: entry.regime,
    session: entry.session,
    risk: entry.risk
  };
}

// Calculate statistics
function calculateStats(trades) {
  if (trades.length === 0) return { totalTrades: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnL = trades.reduce((a, t) => a + t.pnl, 0);

  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let peak = 0, maxDD = 0, running = 0;
  trades.forEach(t => {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  });

  const exitReasons = {};
  trades.forEach(t => {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  });

  const bySession = {};
  trades.forEach(t => {
    if (!bySession[t.session]) bySession[t.session] = { pnl: 0, count: 0, wins: 0 };
    bySession[t.session].pnl += t.pnl;
    bySession[t.session].count++;
    if (t.pnl > 0) bySession[t.session].wins++;
  });

  const byRegime = {};
  trades.forEach(t => {
    const r = t.regime || 'unknown';
    if (!byRegime[r]) byRegime[r] = { pnl: 0, count: 0, wins: 0 };
    byRegime[r].pnl += t.pnl;
    byRegime[r].count++;
    if (t.pnl > 0) byRegime[r].wins++;
  });

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ((wins.length / trades.length) * 100).toFixed(1),
    totalPnL: totalPnL.toFixed(2),
    avgPnL: (totalPnL / trades.length).toFixed(2),
    avgWin: wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : '0.00',
    avgLoss: losses.length > 0 ? (grossLoss / losses.length * -1).toFixed(2) : '0.00',
    profitFactor: profitFactor.toFixed(2),
    maxDrawdown: maxDD.toFixed(2),
    exitReasons,
    bySession,
    byRegime
  };
}

// Main backtest function
async function runBacktest() {
  const config = STRATEGIES[STRATEGY];
  if (!config) {
    console.error(`Unknown strategy: ${STRATEGY}`);
    process.exit(1);
  }

  console.log(`\n=== ${config.name.toUpperCase()} BACKTEST ===`);
  console.log(`Date range: ${START_DATE} to ${END_DATE}`);
  console.log(`Exit mode: ${EXIT_MODE}`);

  console.log('Loading OHLCV data...');
  const candles = loadOHLCV(START_DATE, END_DATE);
  console.log(`Loaded ${candles.length} candles`);

  // Group by date
  const candlesByDate = {};
  candles.forEach(c => {
    const date = new Date(c.timestamp).toISOString().slice(0, 10);
    if (!candlesByDate[date]) candlesByDate[date] = [];
    candlesByDate[date].push(c);
  });

  const dates = Object.keys(candlesByDate).sort();
  console.log(`Processing ${dates.length} trading days...`);

  const trades = [];
  let lastSignalTime = 0;
  const cooldownMs = 900000; // 15 min
  let gexDaysFound = 0;

  for (const date of dates) {
    const gexData = loadIntradayGEX(date);
    if (!gexData) continue;
    gexDaysFound++;

    const dayCandles = candlesByDate[date];
    const dayStartIdx = candles.findIndex(c => c === dayCandles[0]);

    for (let i = 1; i < dayCandles.length; i++) {
      const candle = dayCandles[i];
      const gexLevels = getGEXAtTime(gexData, candle.timestamp);
      if (!gexLevels) continue;

      const entry = checkEntry(candle, gexLevels, config, lastSignalTime, cooldownMs);
      if (entry) {
        lastSignalTime = entry.timestamp;
        const globalIdx = dayStartIdx + i;
        const trade = simulateTrade(entry, candles, globalIdx, EXIT_MODE);
        trades.push(trade);

        if (DEBUG) {
          console.log(`Trade: ${trade.side} @ ${trade.entryPrice.toFixed(2)}, exit=${trade.exitPrice.toFixed(2)}, pnl=${trade.pnl.toFixed(2)}`);
        }
      }
    }
  }

  console.log(`\nGEX data available for ${gexDaysFound} days`);

  const stats = calculateStats(trades);

  console.log(`\n=== RESULTS ===`);
  console.log(`Total Trades: ${stats.totalTrades}`);

  if (stats.totalTrades > 0) {
    console.log(`Wins: ${stats.wins}, Losses: ${stats.losses}`);
    console.log(`Win Rate: ${stats.winRate}%`);
    console.log(`Total P&L: ${stats.totalPnL} pts`);
    console.log(`Avg P&L: ${stats.avgPnL} pts`);
    console.log(`Avg Win: ${stats.avgWin} pts, Avg Loss: ${stats.avgLoss} pts`);
    console.log(`Profit Factor: ${stats.profitFactor}`);
    console.log(`Max Drawdown: ${stats.maxDrawdown} pts`);

    console.log(`\nExit Reasons:`);
    Object.entries(stats.exitReasons).forEach(([r, c]) => {
      console.log(`  ${r}: ${c} (${(c/stats.totalTrades*100).toFixed(1)}%)`);
    });

    console.log(`\nBy Session:`);
    Object.entries(stats.bySession).forEach(([s, d]) => {
      console.log(`  ${s}: n=${d.count}, P&L=${d.pnl.toFixed(2)}, winRate=${(d.wins/d.count*100).toFixed(1)}%`);
    });

    console.log(`\nBy Regime:`);
    Object.entries(stats.byRegime).forEach(([r, d]) => {
      console.log(`  ${r}: n=${d.count}, P&L=${d.pnl.toFixed(2)}, winRate=${(d.wins/d.count*100).toFixed(1)}%`);
    });
  }

  // Save results
  const resultsDir = path.join(__dirname, `../../strategies/${STRATEGY}/results`);
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const filename = `${START_DATE}_${END_DATE}_${EXIT_MODE}`;
  fs.writeFileSync(
    path.join(resultsDir, `${filename}.json`),
    JSON.stringify({ config, stats, trades }, null, 2)
  );

  // Save CSV
  const csvHeader = 'entryTime,entryPrice,exitPrice,exitReason,pnl,barsHeld,side,level,regime,session,risk\n';
  const csvRows = trades.map(t =>
    `${new Date(t.entryTime).toISOString()},${t.entryPrice.toFixed(2)},${t.exitPrice.toFixed(2)},${t.exitReason},${t.pnl.toFixed(2)},${t.barsHeld},${t.side},${t.level.toFixed(2)},${t.regime},${t.session},${t.risk.toFixed(2)}`
  ).join('\n');
  fs.writeFileSync(path.join(resultsDir, `${filename}.csv`), csvHeader + csvRows);

  console.log(`\nResults saved to: strategies/${STRATEGY}/results/${filename}.*`);

  return { strategy: STRATEGY, exitMode: EXIT_MODE, stats };
}

runBacktest().catch(console.error);
