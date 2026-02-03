/**
 * Backtest script for Put Wall Bounce Strategy
 *
 * Tests the strategy on historical data and outputs performance metrics.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PutWallBounceStrategy } from './strategy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const RESULTS_DIR = path.join(__dirname, 'results');

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name, defaultVal) => {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
};

const START_DATE = getArg('start', '2024-10-01');
const END_DATE = getArg('end', '2025-01-31');
const DEBUG = args.includes('--debug');

// Trading costs
const COMMISSION = 2.50;  // Round-trip per contract
const SLIPPAGE = 0.25;    // 1 tick

console.log(`\n=== PUT WALL BOUNCE STRATEGY BACKTEST ===`);
console.log(`Date range: ${START_DATE} to ${END_DATE}`);
console.log(`Debug mode: ${DEBUG}`);

// Parse CSV helper
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length >= headers.length) {
      const row = {};
      headers.forEach((h, idx) => {
        row[h.trim()] = values[idx]?.trim() || '';
      });
      data.push(row);
    }
  }
  return data;
}

// Load OHLCV data
function loadOHLCV(startDate, endDate) {
  console.log('Loading OHLCV data...');
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
    if (symbol.includes('-')) continue;  // Skip calendar spreads

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

// Filter to primary contract per hour
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

// Load intraday GEX data for a specific date
function loadIntradayGEX(date) {
  const filepath = path.join(DATA_DIR, `gex/nq/nq_gex_${date}.json`);
  if (!fs.existsSync(filepath)) return null;

  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// Get GEX levels at a specific time
function getGEXAtTime(gexData, timestamp) {
  if (!gexData || !gexData.data) return null;

  let closest = null;
  const ts = new Date(timestamp);

  for (const snapshot of gexData.data) {
    const snapTs = new Date(snapshot.timestamp);
    if (snapTs <= ts) {
      closest = snapshot;
    } else {
      break;
    }
  }

  return closest;
}

// Simulate trade execution
function simulateTrade(entry, candles, startIdx) {
  const { price: entryPrice, stopLoss, takeProfit, maxHoldBars } = entry;

  // Apply slippage to entry (market order or limit hit)
  const fillPrice = entryPrice + SLIPPAGE;

  let exitPrice = null;
  let exitReason = null;
  let exitBar = 0;
  let highWaterMark = fillPrice;

  // Trailing stop state
  const useTrailing = entry.trailing_trigger !== undefined;
  let trailingStopActive = false;
  let trailingStopPrice = stopLoss;

  for (let i = startIdx + 1; i < candles.length && i <= startIdx + maxHoldBars; i++) {
    const candle = candles[i];
    exitBar = i - startIdx;

    // Update high water mark
    if (candle.high > highWaterMark) {
      highWaterMark = candle.high;
    }

    // Check trailing stop activation
    if (useTrailing && !trailingStopActive) {
      const profit = highWaterMark - fillPrice;
      if (profit >= entry.trailing_trigger) {
        trailingStopActive = true;
        trailingStopPrice = highWaterMark - entry.trailing_offset;
      }
    }

    // Update trailing stop if active
    if (trailingStopActive) {
      const newTrailStop = highWaterMark - entry.trailing_offset;
      if (newTrailStop > trailingStopPrice) {
        trailingStopPrice = newTrailStop;
      }
    }

    // Check stop loss (use trailing if active)
    const currentStop = trailingStopActive ? trailingStopPrice : stopLoss;
    if (candle.low <= currentStop) {
      exitPrice = currentStop - SLIPPAGE;
      exitReason = trailingStopActive ? 'trailing_stop' : 'stop_loss';
      break;
    }

    // Check take profit
    if (candle.high >= takeProfit) {
      exitPrice = takeProfit;  // Limit fill at exact price
      exitReason = 'take_profit';
      break;
    }
  }

  // If no exit, use last candle close (max hold)
  if (!exitPrice) {
    const lastIdx = Math.min(startIdx + maxHoldBars, candles.length - 1);
    exitPrice = candles[lastIdx].close;
    exitReason = 'max_hold';
  }

  const pnl = exitPrice - fillPrice - (COMMISSION / 20);  // Commission in points (~$50/pt)

  return {
    entryTime: entry.timestamp,
    entryPrice: fillPrice,
    exitPrice,
    exitReason,
    pnl,
    barsHeld: exitBar,
    highWaterMark,
    metadata: {
      putWall: entry.levelPrice,
      regime: entry.regime,
      risk: entry.risk
    }
  };
}

// Calculate performance statistics
function calculateStats(trades) {
  if (trades.length === 0) {
    return { totalTrades: 0 };
  }

  const pnls = trades.map(t => t.pnl);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const totalPnL = pnls.reduce((a, b) => a + b, 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;

  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Calculate max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let runningPnL = 0;
  trades.forEach(t => {
    runningPnL += t.pnl;
    if (runningPnL > peak) peak = runningPnL;
    const drawdown = peak - runningPnL;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  });

  // Exit reason breakdown
  const exitReasons = {};
  trades.forEach(t => {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  });

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (winRate * 100).toFixed(1) + '%',
    totalPnL: totalPnL.toFixed(2),
    avgPnL: (totalPnL / trades.length).toFixed(2),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    profitFactor: profitFactor.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(2),
    exitReasons
  };
}

// Main backtest function
async function runBacktest() {
  // Load OHLCV data
  const candles = loadOHLCV(START_DATE, END_DATE);
  console.log(`Loaded ${candles.length} candles`);

  // Initialize strategy
  const strategy = new PutWallBounceStrategy({
    debug: DEBUG,
    useSessionFilter: false,  // Test without session filter first
    useRegimeFilter: false,   // Test without regime filter first
    stopLossPoints: 10,
    takeProfitPoints: 30,
    maxRisk: 15,
    useTrailingStop: true,
    trailingTrigger: 15,
    trailingOffset: 8
  });

  // Group candles by date for GEX loading
  const candlesByDate = {};
  candles.forEach(c => {
    const date = new Date(c.timestamp).toISOString().slice(0, 10);
    if (!candlesByDate[date]) candlesByDate[date] = [];
    candlesByDate[date].push(c);
  });

  const dates = Object.keys(candlesByDate).sort();
  console.log(`Processing ${dates.length} trading days...`);

  const trades = [];
  let signalsGenerated = 0;
  let gexDaysFound = 0;

  // Process each day
  for (const date of dates) {
    const gexData = loadIntradayGEX(date);
    if (!gexData) continue;

    gexDaysFound++;
    const dayCandles = candlesByDate[date];

    // Find index in full candle array for this day's start
    const dayStartIdx = candles.findIndex(c => c === dayCandles[0]);

    for (let i = 1; i < dayCandles.length; i++) {
      const candle = dayCandles[i];
      const prevCandle = dayCandles[i - 1];

      // Get GEX levels at this time
      const gexLevels = getGEXAtTime(gexData, candle.timestamp);
      if (!gexLevels) continue;

      // Evaluate signal
      const signal = strategy.evaluateSignal(candle, prevCandle, { gexLevels });

      if (signal) {
        signalsGenerated++;

        // Simulate trade
        const globalIdx = dayStartIdx + i;
        const trade = simulateTrade(signal, candles, globalIdx);
        trades.push(trade);

        if (DEBUG) {
          console.log(`Trade: entry=${trade.entryPrice.toFixed(2)}, exit=${trade.exitPrice.toFixed(2)}, ` +
            `pnl=${trade.pnl.toFixed(2)}, reason=${trade.exitReason}`);
        }
      }
    }
  }

  console.log(`\nGEX data available for ${gexDaysFound} days`);
  console.log(`Signals generated: ${signalsGenerated}`);

  // Calculate and display statistics
  const stats = calculateStats(trades);

  console.log(`\n=== BACKTEST RESULTS ===`);
  console.log(`Total Trades: ${stats.totalTrades}`);
  if (stats.totalTrades > 0) {
    console.log(`Wins: ${stats.wins}, Losses: ${stats.losses}`);
    console.log(`Win Rate: ${stats.winRate}`);
    console.log(`Total P&L: ${stats.totalPnL} pts`);
    console.log(`Avg P&L per Trade: ${stats.avgPnL} pts`);
    console.log(`Avg Win: ${stats.avgWin} pts`);
    console.log(`Avg Loss: ${stats.avgLoss} pts`);
    console.log(`Profit Factor: ${stats.profitFactor}`);
    console.log(`Max Drawdown: ${stats.maxDrawdown} pts`);
    console.log(`\nExit Reasons:`);
    Object.entries(stats.exitReasons).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count} (${(count / stats.totalTrades * 100).toFixed(1)}%)`);
    });
  }

  // Save results
  const resultsFile = path.join(RESULTS_DIR, `backtest_${START_DATE}_${END_DATE}.json`);
  fs.writeFileSync(resultsFile, JSON.stringify({
    config: {
      startDate: START_DATE,
      endDate: END_DATE,
      strategy: 'PUT_WALL_BOUNCE',
      params: strategy.params
    },
    stats,
    trades
  }, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);

  // Also save CSV for easier analysis
  const csvFile = path.join(RESULTS_DIR, `trades_${START_DATE}_${END_DATE}.csv`);
  const csvHeader = 'entryTime,entryPrice,exitPrice,exitReason,pnl,barsHeld,putWall,regime,risk\n';
  const csvRows = trades.map(t =>
    `${new Date(t.entryTime).toISOString()},${t.entryPrice},${t.exitPrice},${t.exitReason},${t.pnl.toFixed(2)},${t.barsHeld},${t.metadata.putWall},${t.metadata.regime},${t.metadata.risk}`
  ).join('\n');
  fs.writeFileSync(csvFile, csvHeader + csvRows);
  console.log(`Trades CSV saved to: ${csvFile}`);

  return stats;
}

runBacktest().catch(console.error);
