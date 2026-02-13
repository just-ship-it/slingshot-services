#!/usr/bin/env node

/**
 * Overnight GEX First-Touch Bounce Backtest
 *
 * Simulates actual trades entered on first touch of GEX levels during overnight.
 * Tests multiple stop/target combinations to find optimal risk/reward.
 *
 * Trade mechanics:
 * - Entry: Limit order at GEX level price on first touch (within proximity)
 * - Support levels → LONG, Resistance levels → SHORT
 * - Stop loss: Fixed points beyond the level
 * - Take profit: Fixed points from entry
 * - Max hold: Configurable (default: rest of overnight session until 8:30AM)
 *
 * Uses the overnight-analysis-results.json from analyze-overnight-moves.js
 * for pre-computed session data, plus re-reads OHLCV for tick-by-tick simulation.
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'backtest-engine/data');

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  startDate: '2023-03-28',
  endDate: '2026-01-28',
  touchProximity: 5, // points from level to trigger entry

  // Parameter grid to test
  stopLosses: [5, 7, 10, 15, 20, 25],
  targets: [5, 7, 10, 15, 20, 25, 30],

  // Which GEX levels to trade
  tradeLevels: ['S1', 'S2', 'R1', 'R2'],

  // Maximum hold time in minutes (0 = hold until session end)
  maxHoldMinutes: 0,

  // Entry type: 'touch' (enter at level price) or 'close' (enter at candle close)
  entryType: 'touch',

  // Only take first touch per level per night (no re-entry after stop out)
  firstTouchOnly: true,

  // Session filter: which sessions to accept first touches from
  // null = all overnight sessions
  allowedSessions: null, // or ['evening', 'dead_zone', 'european', 'premarket']
};

// ─── Timezone Helpers (same as analyze-overnight-moves.js) ───────────────────

function isDST(utcDate) {
  const year = utcDate.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchSecondSunday = new Date(Date.UTC(year, 2, 8 + (7 - marchFirst.getUTCDay()) % 7));
  marchSecondSunday.setUTCHours(7);
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstSunday = new Date(Date.UTC(year, 10, 1 + (7 - novFirst.getUTCDay()) % 7));
  novFirstSunday.setUTCHours(6);
  return utcDate >= marchSecondSunday && utcDate < novFirstSunday;
}

function getESTHour(utcTimestamp) {
  const d = new Date(utcTimestamp);
  const offset = isDST(d) ? -4 : -5;
  const estMs = utcTimestamp + offset * 3600000;
  const estDate = new Date(estMs);
  return estDate.getUTCHours() + estDate.getUTCMinutes() / 60;
}

function toESTDate(utcTimestamp) {
  const d = new Date(utcTimestamp);
  const offset = isDST(d) ? -4 : -5;
  return new Date(utcTimestamp + offset * 3600000);
}

function getSession(utcTimestamp) {
  const estHour = getESTHour(utcTimestamp);
  if (estHour >= 16 && estHour < 18) return 'afterhours';
  if (estHour >= 18 && estHour < 20) return 'evening';
  if (estHour >= 20 || estHour < 2) return 'dead_zone';
  if (estHour >= 2 && estHour < 5) return 'european';
  if (estHour >= 5 && estHour < 9.5) return 'premarket';
  if (estHour >= 9.5 && estHour < 16) return 'rth';
  return 'unknown';
}

// ─── Data Loading ────────────────────────────────────────────────────────────

/**
 * Load pre-computed overnight analysis results
 */
function loadAnalysisResults() {
  const filePath = path.join(PROJECT_ROOT, 'scripts/overnight-analysis-results.json');
  if (!fs.existsSync(filePath)) {
    console.error('ERROR: overnight-analysis-results.json not found. Run analyze-overnight-moves.js first.');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  console.log(`Loaded analysis results: ${data.nights.length} nights`);
  return data;
}

/**
 * Load OHLCV with proper contract rollover handling
 * Groups candles by trading date for efficient per-night access
 */
async function loadOHLCVByDate() {
  const filePath = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  console.log(`Loading OHLCV data...`);

  const startMs = new Date(CONFIG.startDate + 'T00:00:00Z').getTime() - 2 * 86400000;
  const endMs = new Date(CONFIG.endDate + 'T23:59:59Z').getTime() + 2 * 86400000;

  // Pass 1: Read all candles, track RTH volume per date per symbol
  const rawCandles = [];
  const rthVolumeByDate = new Map();

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let isHeader = true;
  let totalRead = 0;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    totalRead++;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9]?.trim();
    if (!symbol || symbol.includes('-')) continue;

    const timestamp = new Date(parts[0]).getTime();
    if (isNaN(timestamp) || timestamp < startMs || timestamp > endMs) continue;

    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseFloat(parts[8]);
    if (isNaN(open) || isNaN(close)) continue;
    if (open === high && high === low && low === close && volume <= 2) continue;

    rawCandles.push({ timestamp, open, high, low, close, volume, symbol });

    // Track RTH volume
    const estHour = getESTHour(timestamp);
    if (estHour >= 9.5 && estHour < 16) {
      const estDate = toESTDate(timestamp);
      const dateStr = estDate.toISOString().split('T')[0];
      if (!rthVolumeByDate.has(dateStr)) rthVolumeByDate.set(dateStr, new Map());
      const dv = rthVolumeByDate.get(dateStr);
      dv.set(symbol, (dv.get(symbol) || 0) + volume);
    }

    if (totalRead % 500000 === 0) process.stdout.write(`  ${(totalRead / 1e6).toFixed(1)}M lines...\r`);
  }
  console.log(`  Read ${rawCandles.length.toLocaleString()} candles`);

  // Build primary contract per date
  const primaryByDate = new Map();
  for (const [dateStr, symbolVols] of rthVolumeByDate) {
    let primary = '', maxVol = 0;
    for (const [sym, vol] of symbolVols) {
      if (vol > maxVol) { maxVol = vol; primary = sym; }
    }
    primaryByDate.set(dateStr, primary);
  }

  // Pass 2: Filter and group by trading date
  const overnightByDate = new Map(); // dateStr -> candle[]

  for (const candle of rawCandles) {
    const estHour = getESTHour(candle.timestamp);
    const session = getSession(candle.timestamp);

    // Only keep overnight candles (6PM-8:30AM)
    if (session !== 'evening' && session !== 'dead_zone' && session !== 'european' && session !== 'premarket') continue;

    // Determine trading date
    const estDate = toESTDate(candle.timestamp);
    let tradingDateStr;
    if (estHour >= 18) {
      tradingDateStr = estDate.toISOString().split('T')[0];
    } else {
      const prevDay = new Date(estDate.getTime() - 86400000);
      tradingDateStr = prevDay.toISOString().split('T')[0];
    }

    // Filter to primary contract
    const primary = primaryByDate.get(tradingDateStr);
    if (!primary) {
      for (let offset = 1; offset <= 3; offset++) {
        const lookback = new Date(new Date(tradingDateStr).getTime() - offset * 86400000).toISOString().split('T')[0];
        const fallback = primaryByDate.get(lookback);
        if (fallback && candle.symbol === fallback) {
          if (!overnightByDate.has(tradingDateStr)) overnightByDate.set(tradingDateStr, []);
          overnightByDate.get(tradingDateStr).push(candle);
          break;
        }
      }
      continue;
    }

    if (candle.symbol === primary) {
      if (!overnightByDate.has(tradingDateStr)) overnightByDate.set(tradingDateStr, []);
      overnightByDate.get(tradingDateStr).push(candle);
    }
  }

  // Sort each date's candles
  for (const candles of overnightByDate.values()) {
    candles.sort((a, b) => a.timestamp - b.timestamp);
  }

  console.log(`  Grouped overnight candles for ${overnightByDate.size} trading dates`);
  return overnightByDate;
}

// ─── Trade Simulation ────────────────────────────────────────────────────────

/**
 * Simulate trades for a single stop/target combination across all nights
 */
function simulateTrades(analysisNights, overnightByDate, stopLoss, target) {
  const trades = [];

  for (const night of analysisNights) {
    if (!night.gexTouches) continue;

    const candles = overnightByDate.get(night.date);
    if (!candles || candles.length === 0) continue;

    // Try each configured level
    for (const levelName of CONFIG.tradeLevels) {
      const touchInfo = night.gexTouches[levelName];
      if (!touchInfo || !touchInfo.touched) continue;

      // Session filter
      if (CONFIG.allowedSessions && !CONFIG.allowedSessions.includes(touchInfo.firstTouchSession)) continue;

      const levelPrice = touchInfo.price;
      const isLong = touchInfo.type === 'support';
      const isShort = touchInfo.type === 'resistance';
      if (!isLong && !isShort) continue; // skip gamma_flip

      // Find the first-touch candle in OHLCV
      const touchTime = new Date(touchInfo.firstTouchTime).getTime();
      let touchIdx = -1;
      for (let i = 0; i < candles.length; i++) {
        if (candles[i].timestamp >= touchTime - 60000 && candles[i].timestamp <= touchTime + 60000) {
          // Verify this candle actually touches the level
          if (candles[i].low <= levelPrice + CONFIG.touchProximity &&
              candles[i].high >= levelPrice - CONFIG.touchProximity) {
            touchIdx = i;
            break;
          }
        }
      }
      if (touchIdx === -1) continue;

      // Entry price: at the level price (limit order)
      const entryPrice = levelPrice;
      const entryTime = candles[touchIdx].timestamp;

      // Define stop and target
      let stopPrice, targetPrice;
      if (isLong) {
        stopPrice = entryPrice - stopLoss;
        targetPrice = entryPrice + target;
      } else {
        stopPrice = entryPrice + stopLoss;
        targetPrice = entryPrice - target;
      }

      // Walk forward through candles to find exit
      let exitPrice = null;
      let exitTime = null;
      let exitReason = null;
      let maxFavorable = 0;
      let maxAdverse = 0;

      for (let i = touchIdx; i < candles.length; i++) {
        const c = candles[i];

        // Check max hold time
        if (CONFIG.maxHoldMinutes > 0 && (c.timestamp - entryTime) > CONFIG.maxHoldMinutes * 60000) {
          exitPrice = c.open; // exit at open of next candle
          exitTime = c.timestamp;
          exitReason = 'max_hold';
          break;
        }

        if (isLong) {
          // Track excursions
          const favorable = c.high - entryPrice;
          const adverse = entryPrice - c.low;
          if (favorable > maxFavorable) maxFavorable = favorable;
          if (adverse > maxAdverse) maxAdverse = adverse;

          // Check stop first (conservative: assume stop hit before target on same candle)
          if (c.low <= stopPrice) {
            exitPrice = stopPrice;
            exitTime = c.timestamp;
            exitReason = 'stop_loss';
            break;
          }
          // Check target
          if (c.high >= targetPrice) {
            exitPrice = targetPrice;
            exitTime = c.timestamp;
            exitReason = 'take_profit';
            break;
          }
        } else {
          const favorable = entryPrice - c.low;
          const adverse = c.high - entryPrice;
          if (favorable > maxFavorable) maxFavorable = favorable;
          if (adverse > maxAdverse) maxAdverse = adverse;

          // Check stop first
          if (c.high >= stopPrice) {
            exitPrice = stopPrice;
            exitTime = c.timestamp;
            exitReason = 'stop_loss';
            break;
          }
          // Check target
          if (c.low <= targetPrice) {
            exitPrice = targetPrice;
            exitTime = c.timestamp;
            exitReason = 'take_profit';
            break;
          }
        }
      }

      // If no exit found, exit at session end
      if (exitPrice === null) {
        const lastCandle = candles[candles.length - 1];
        exitPrice = lastCandle.close;
        exitTime = lastCandle.timestamp;
        exitReason = 'session_end';
      }

      const pnl = isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      const holdMinutes = (exitTime - entryTime) / 60000;

      trades.push({
        date: night.date,
        level: levelName,
        type: isLong ? 'LONG' : 'SHORT',
        entryPrice,
        exitPrice,
        entryTime: new Date(entryTime).toISOString(),
        exitTime: new Date(exitTime).toISOString(),
        exitReason,
        pnl: Math.round(pnl * 100) / 100,
        holdMinutes: Math.round(holdMinutes),
        maxFavorable: Math.round(maxFavorable * 100) / 100,
        maxAdverse: Math.round(maxAdverse * 100) / 100,
        session: touchInfo.firstTouchSession,
        minutesIntoOvernight: touchInfo.minutesIntoSession,
        gexRegime: night.gex?.regime || 'unknown',
        ltSentiment: night.ltAtStart?.sentiment || 'unknown',
      });
    }
  }

  return trades;
}

// ─── Statistics ──────────────────────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function formatPts(n) { return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2); }
function formatPct(n) { return `${n.toFixed(1)}%`; }

function computeStats(trades) {
  if (trades.length === 0) return null;

  const pnls = trades.map(t => t.pnl);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const winRate = wins.length / trades.length * 100;
  const avgWin = wins.length ? mean(wins.map(t => t.pnl)) : 0;
  const avgLoss = losses.length ? mean(losses.map(t => t.pnl)) : 0;
  const profitFactor = losses.length && avgLoss !== 0 ? (avgWin * wins.length) / Math.abs(avgLoss * losses.length) : Infinity;

  // Per-week frequency
  const dates = [...new Set(trades.map(t => t.date))];
  const weekSpan = dates.length > 1
    ? (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / (7 * 86400000)
    : 1;
  const tradesPerWeek = trades.length / Math.max(weekSpan, 1);

  // Drawdown
  let peak = 0, maxDrawdown = 0, equity = 0;
  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round(mean(pnls) * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    tradesPerWeek: Math.round(tradesPerWeek * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    avgHoldMinutes: Math.round(mean(trades.map(t => t.holdMinutes))),
    avgMFE: Math.round(mean(trades.map(t => t.maxFavorable)) * 100) / 100,
    avgMAE: Math.round(mean(trades.map(t => t.maxAdverse)) * 100) / 100,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Overnight GEX First-Touch Bounce Backtest');
  console.log('='.repeat(50));

  // Load data
  const analysis = loadAnalysisResults();
  const overnightByDate = await loadOHLCVByDate();

  const nights = analysis.nights.filter(n =>
    n.date >= CONFIG.startDate && n.date <= CONFIG.endDate && n.gexTouches
  );
  console.log(`\n${nights.length} nights with GEX touch data`);

  // ── Grid Search: Test all stop/target combinations ──
  console.log('\n' + '═'.repeat(100));
  console.log('  PARAMETER GRID SEARCH: Stop Loss × Target');
  console.log('═'.repeat(100));

  const gridResults = [];

  for (const sl of CONFIG.stopLosses) {
    for (const tp of CONFIG.targets) {
      const trades = simulateTrades(nights, overnightByDate, sl, tp);
      const stats = computeStats(trades);
      if (stats && stats.trades >= 10) {
        gridResults.push({ sl, tp, ...stats });
      }
    }
  }

  // Sort by total P&L
  gridResults.sort((a, b) => b.totalPnl - a.totalPnl);

  // Print grid as table
  console.log('\n  Top 20 parameter combinations by total P&L (min 10 trades):');
  console.log('  ' + '-'.repeat(96));
  console.log('  SL   TP   | Trades | Win%   | Total P&L | Avg P&L | PF    | /Week | MaxDD  | AvgHold | MFE    | MAE');
  console.log('  ' + '-'.repeat(96));
  for (const r of gridResults.slice(0, 20)) {
    console.log(`  ${String(r.sl).padStart(3)}  ${String(r.tp).padStart(3)}  | ${String(r.trades).padStart(6)} | ${formatPct(r.winRate).padStart(6)} | ${formatPts(r.totalPnl).padStart(9)} | ${formatPts(r.avgPnl).padStart(7)} | ${r.profitFactor.toFixed(2).padStart(5)} | ${r.tradesPerWeek.toFixed(1).padStart(5)} | ${formatPts(-r.maxDrawdown).padStart(6)} | ${String(r.avgHoldMinutes).padStart(4)}min | ${formatPts(r.avgMFE).padStart(6)} | ${formatPts(r.avgMAE).padStart(5)}`);
  }

  // ── Best Win Rate combinations (65%+ threshold) ──
  console.log('\n  Combinations with 65%+ win rate (sorted by trades/week):');
  console.log('  ' + '-'.repeat(96));
  console.log('  SL   TP   | Trades | Win%   | Total P&L | Avg P&L | PF    | /Week | MaxDD  | AvgHold | MFE    | MAE');
  console.log('  ' + '-'.repeat(96));
  const highWR = gridResults.filter(r => r.winRate >= 65).sort((a, b) => b.tradesPerWeek - a.tradesPerWeek);
  for (const r of highWR.slice(0, 20)) {
    console.log(`  ${String(r.sl).padStart(3)}  ${String(r.tp).padStart(3)}  | ${String(r.trades).padStart(6)} | ${formatPct(r.winRate).padStart(6)} | ${formatPts(r.totalPnl).padStart(9)} | ${formatPts(r.avgPnl).padStart(7)} | ${r.profitFactor.toFixed(2).padStart(5)} | ${r.tradesPerWeek.toFixed(1).padStart(5)} | ${formatPts(-r.maxDrawdown).padStart(6)} | ${String(r.avgHoldMinutes).padStart(4)}min | ${formatPts(r.avgMFE).padStart(6)} | ${formatPts(r.avgMAE).padStart(5)}`);
  }

  // ── Analyze best combination in detail ──
  // Pick the best by total P&L with 65%+ win rate
  const best = highWR.length > 0
    ? highWR.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b)
    : gridResults[0];

  if (best) {
    console.log(`\n${'═'.repeat(100)}`);
    console.log(`  DETAILED ANALYSIS: Best combo SL=${best.sl} TP=${best.tp}`);
    console.log('═'.repeat(100));

    const bestTrades = simulateTrades(nights, overnightByDate, best.sl, best.tp);

    // By level
    console.log('\n  By GEX Level:');
    for (const level of CONFIG.tradeLevels) {
      const levelTrades = bestTrades.filter(t => t.level === level);
      if (levelTrades.length < 3) continue;
      const stats = computeStats(levelTrades);
      console.log(`    ${level}: ${stats.trades} trades | Win: ${formatPct(stats.winRate)} | P&L: ${formatPts(stats.totalPnl)} | Avg: ${formatPts(stats.avgPnl)} | PF: ${stats.profitFactor.toFixed(2)}`);
    }

    // By session
    console.log('\n  By First-Touch Session:');
    for (const sess of ['evening', 'dead_zone', 'european', 'premarket']) {
      const sessTrades = bestTrades.filter(t => t.session === sess);
      if (sessTrades.length < 3) continue;
      const stats = computeStats(sessTrades);
      console.log(`    ${sess}: ${stats.trades} trades | Win: ${formatPct(stats.winRate)} | P&L: ${formatPts(stats.totalPnl)} | Avg: ${formatPts(stats.avgPnl)} | PF: ${stats.profitFactor.toFixed(2)}`);
    }

    // By GEX regime
    console.log('\n  By GEX Regime:');
    for (const regime of ['positive', 'negative']) {
      const regimeTrades = bestTrades.filter(t => t.gexRegime === regime);
      if (regimeTrades.length < 3) continue;
      const stats = computeStats(regimeTrades);
      console.log(`    ${regime}: ${stats.trades} trades | Win: ${formatPct(stats.winRate)} | P&L: ${formatPts(stats.totalPnl)} | Avg: ${formatPts(stats.avgPnl)} | PF: ${stats.profitFactor.toFixed(2)}`);
    }

    // By LT sentiment
    console.log('\n  By LT Sentiment:');
    for (const sentiment of ['BULLISH', 'BEARISH']) {
      const sentTrades = bestTrades.filter(t => t.ltSentiment === sentiment);
      if (sentTrades.length < 3) continue;
      const stats = computeStats(sentTrades);
      console.log(`    ${sentiment}: ${stats.trades} trades | Win: ${formatPct(stats.winRate)} | P&L: ${formatPts(stats.totalPnl)} | Avg: ${formatPts(stats.avgPnl)} | PF: ${stats.profitFactor.toFixed(2)}`);
    }

    // By direction (LONG vs SHORT)
    console.log('\n  By Direction:');
    for (const dir of ['LONG', 'SHORT']) {
      const dirTrades = bestTrades.filter(t => t.type === dir);
      if (dirTrades.length < 3) continue;
      const stats = computeStats(dirTrades);
      console.log(`    ${dir}: ${stats.trades} trades | Win: ${formatPct(stats.winRate)} | P&L: ${formatPts(stats.totalPnl)} | Avg: ${formatPts(stats.avgPnl)} | PF: ${stats.profitFactor.toFixed(2)}`);
    }

    // By day of week
    console.log('\n  By Day of Week (RTH date):');
    const dayMap = {};
    for (const t of bestTrades) {
      const day = new Date(t.date).toLocaleDateString('en-US', { weekday: 'long' });
      if (!dayMap[day]) dayMap[day] = [];
      dayMap[day].push(t);
    }
    for (const [day, dayTrades] of Object.entries(dayMap).sort()) {
      if (dayTrades.length < 3) continue;
      const stats = computeStats(dayTrades);
      console.log(`    ${day}: ${stats.trades} trades | Win: ${formatPct(stats.winRate)} | P&L: ${formatPts(stats.totalPnl)} | Avg: ${formatPts(stats.avgPnl)}`);
    }

    // Exit reason breakdown
    console.log('\n  Exit Reasons:');
    const exitReasons = {};
    for (const t of bestTrades) {
      exitReasons[t.exitReason] = exitReasons[t.exitReason] || [];
      exitReasons[t.exitReason].push(t);
    }
    for (const [reason, reasonTrades] of Object.entries(exitReasons)) {
      const stats = computeStats(reasonTrades);
      console.log(`    ${reason}: ${stats.trades} (${formatPct(stats.trades / bestTrades.length * 100)}) | Avg P&L: ${formatPts(stats.avgPnl)}`);
    }

    // Monthly P&L
    console.log('\n  Monthly P&L:');
    const monthlyPnl = {};
    for (const t of bestTrades) {
      const month = t.date.substring(0, 7);
      monthlyPnl[month] = (monthlyPnl[month] || 0) + t.pnl;
    }
    const months = Object.keys(monthlyPnl).sort();
    let runningTotal = 0;
    for (const month of months) {
      runningTotal += monthlyPnl[month];
      const pnl = monthlyPnl[month];
      console.log(`    ${month}: ${formatPts(pnl).padStart(10)} | Cumulative: ${formatPts(runningTotal).padStart(10)}`);
    }

    // Save trade log
    const tradeLogPath = path.join(PROJECT_ROOT, 'scripts/overnight-first-touch-trades.json');
    fs.writeFileSync(tradeLogPath, JSON.stringify({
      config: { stopLoss: best.sl, target: best.tp, ...CONFIG },
      stats: best,
      trades: bestTrades,
    }, null, 2));
    console.log(`\nTrade log saved to: ${tradeLogPath}`);
  }

  console.log('\n' + '═'.repeat(100));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
