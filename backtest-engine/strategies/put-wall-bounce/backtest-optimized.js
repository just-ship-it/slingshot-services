/**
 * Optimized Backtest for Put Wall Bounce Strategy
 *
 * Tests with regime filter based on analysis findings.
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

const START_DATE = getArg('start', '2023-04-01');
const END_DATE = getArg('end', '2025-01-20');
const DEBUG = args.includes('--debug');

// Trading costs
const COMMISSION = 2.50;
const SLIPPAGE = 0.25;

console.log(`\n=== PUT WALL BOUNCE - OPTIMIZED BACKTEST ===`);
console.log(`Date range: ${START_DATE} to ${END_DATE}`);

// Helper functions (same as original)
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
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content);
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
    if (snapTs <= ts) {
      closest = snapshot;
    } else {
      break;
    }
  }
  return closest;
}

function simulateTrade(entry, candles, startIdx) {
  const { price: entryPrice, stopLoss, takeProfit, maxHoldBars } = entry;
  const fillPrice = entryPrice + SLIPPAGE;

  let exitPrice = null;
  let exitReason = null;
  let exitBar = 0;
  let highWaterMark = fillPrice;

  const useTrailing = entry.trailing_trigger !== undefined;
  let trailingStopActive = false;
  let trailingStopPrice = stopLoss;

  for (let i = startIdx + 1; i < candles.length && i <= startIdx + maxHoldBars; i++) {
    const candle = candles[i];
    exitBar = i - startIdx;

    if (candle.high > highWaterMark) {
      highWaterMark = candle.high;
    }

    if (useTrailing && !trailingStopActive) {
      const profit = highWaterMark - fillPrice;
      if (profit >= entry.trailing_trigger) {
        trailingStopActive = true;
        trailingStopPrice = highWaterMark - entry.trailing_offset;
      }
    }

    if (trailingStopActive) {
      const newTrailStop = highWaterMark - entry.trailing_offset;
      if (newTrailStop > trailingStopPrice) {
        trailingStopPrice = newTrailStop;
      }
    }

    const currentStop = trailingStopActive ? trailingStopPrice : stopLoss;
    if (candle.low <= currentStop) {
      exitPrice = currentStop - SLIPPAGE;
      exitReason = trailingStopActive ? 'trailing_stop' : 'stop_loss';
      break;
    }

    if (candle.high >= takeProfit) {
      exitPrice = takeProfit;
      exitReason = 'take_profit';
      break;
    }
  }

  if (!exitPrice) {
    const lastIdx = Math.min(startIdx + maxHoldBars, candles.length - 1);
    exitPrice = candles[lastIdx].close;
    exitReason = 'max_hold';
  }

  const pnl = exitPrice - fillPrice - (COMMISSION / 20);

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

  let peak = 0;
  let maxDrawdown = 0;
  let runningPnL = 0;
  trades.forEach(t => {
    runningPnL += t.pnl;
    if (runningPnL > peak) peak = runningPnL;
    const drawdown = peak - runningPnL;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  });

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

// Test different configurations
async function runBacktest(config) {
  const candles = loadOHLCV(START_DATE, END_DATE);

  const strategy = new PutWallBounceStrategy({
    debug: DEBUG,
    useSessionFilter: config.useSessionFilter || false,
    allowedSessions: config.allowedSessions || ['rth'],
    useRegimeFilter: config.useRegimeFilter || false,
    allowedRegimes: config.allowedRegimes || ['strong_negative'],
    stopLossPoints: config.stopLossPoints || 10,
    takeProfitPoints: config.takeProfitPoints || 30,
    maxRisk: config.maxRisk || 15,
    useTrailingStop: config.useTrailingStop !== false,
    trailingTrigger: config.trailingTrigger || 15,
    trailingOffset: config.trailingOffset || 8
  });

  const candlesByDate = {};
  candles.forEach(c => {
    const date = new Date(c.timestamp).toISOString().slice(0, 10);
    if (!candlesByDate[date]) candlesByDate[date] = [];
    candlesByDate[date].push(c);
  });

  const dates = Object.keys(candlesByDate).sort();
  const trades = [];

  for (const date of dates) {
    const gexData = loadIntradayGEX(date);
    if (!gexData) continue;

    const dayCandles = candlesByDate[date];
    const dayStartIdx = candles.findIndex(c => c === dayCandles[0]);

    for (let i = 1; i < dayCandles.length; i++) {
      const candle = dayCandles[i];
      const prevCandle = dayCandles[i - 1];
      const gexLevels = getGEXAtTime(gexData, candle.timestamp);
      if (!gexLevels) continue;

      const signal = strategy.evaluateSignal(candle, prevCandle, { gexLevels });

      if (signal) {
        const globalIdx = dayStartIdx + i;
        const trade = simulateTrade(signal, candles, globalIdx);
        trades.push(trade);
      }
    }
  }

  return { config, stats: calculateStats(trades), trades };
}

async function main() {
  const candles = loadOHLCV(START_DATE, END_DATE);
  console.log(`Loaded ${candles.length} candles`);

  // Test configurations
  const configs = [
    { name: 'Baseline (no filters)', useRegimeFilter: false, useSessionFilter: false },
    { name: 'Strong Negative Only', useRegimeFilter: true, allowedRegimes: ['strong_negative'] },
    { name: 'RTH Session Only', useSessionFilter: true, allowedSessions: ['rth'] },
    { name: 'Strong Neg + RTH', useRegimeFilter: true, allowedRegimes: ['strong_negative'], useSessionFilter: true, allowedSessions: ['rth'] },
    { name: 'Negative Regimes + RTH', useRegimeFilter: true, allowedRegimes: ['strong_negative', 'negative'], useSessionFilter: true, allowedSessions: ['rth'] },
    { name: 'Tighter Stop (8pts)', stopLossPoints: 8, takeProfitPoints: 25 },
    { name: 'Wider Target (40pts)', takeProfitPoints: 40, trailingTrigger: 20 },
  ];

  console.log(`\nTesting ${configs.length} configurations...`);
  console.log(`${'Configuration'.padEnd(30)} | Trades | Win% | Total P&L | Avg P&L | PF`);
  console.log('-'.repeat(85));

  for (const config of configs) {
    const result = await runBacktest(config);
    const s = result.stats;

    if (s.totalTrades > 0) {
      console.log(
        `${config.name.padEnd(30)} | ${String(s.totalTrades).padStart(6)} | ${s.winRate.padStart(5)} | ${s.totalPnL.padStart(10)} | ${s.avgPnL.padStart(8)} | ${s.profitFactor}`
      );
    } else {
      console.log(`${config.name.padEnd(30)} | ${String(0).padStart(6)} | N/A`);
    }
  }

  // Save best config results
  const bestConfig = { name: 'Strong Neg + RTH', useRegimeFilter: true, allowedRegimes: ['strong_negative'], useSessionFilter: true, allowedSessions: ['rth'] };
  const bestResult = await runBacktest(bestConfig);

  const resultsFile = path.join(RESULTS_DIR, `optimized_${START_DATE}_${END_DATE}.json`);
  fs.writeFileSync(resultsFile, JSON.stringify(bestResult, null, 2));
  console.log(`\nBest config results saved to: ${resultsFile}`);
}

main().catch(console.error);
