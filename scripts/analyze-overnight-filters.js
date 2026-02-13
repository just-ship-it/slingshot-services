#!/usr/bin/env node

/**
 * Overnight First-Touch Filter Analysis
 *
 * Re-simulates trades from backtest-overnight-first-touch.js with various
 * filter combinations to find optimal conditions.
 *
 * Filters tested:
 * - LT Sentiment (Bearish only, Bullish only)
 * - Day of week exclusions
 * - Level selection (S1+R2 strongest)
 * - Session window
 * - GEX regime
 * - Combined filters
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'backtest-engine/data');

// ─── Timezone Helpers ─────────────────────────────────────────────────────────

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

function getDayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

function loadAnalysisResults() {
  const filePath = path.join(PROJECT_ROOT, 'scripts/overnight-analysis-results.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return data;
}

async function loadOHLCVByDate(startDate, endDate) {
  const filePath = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  process.stdout.write('Loading OHLCV data...');

  const startMs = new Date(startDate + 'T00:00:00Z').getTime() - 2 * 86400000;
  const endMs = new Date(endDate + 'T23:59:59Z').getTime() + 2 * 86400000;

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

    const estHour = getESTHour(timestamp);
    if (estHour >= 9.5 && estHour < 16) {
      const estDate = toESTDate(timestamp);
      const dateStr = estDate.toISOString().split('T')[0];
      if (!rthVolumeByDate.has(dateStr)) rthVolumeByDate.set(dateStr, new Map());
      const dv = rthVolumeByDate.get(dateStr);
      dv.set(symbol, (dv.get(symbol) || 0) + volume);
    }
  }
  process.stdout.write(` ${rawCandles.length.toLocaleString()} candles\n`);

  const primaryByDate = new Map();
  for (const [dateStr, symbolVols] of rthVolumeByDate) {
    let primary = '', maxVol = 0;
    for (const [sym, vol] of symbolVols) {
      if (vol > maxVol) { maxVol = vol; primary = sym; }
    }
    primaryByDate.set(dateStr, primary);
  }

  const overnightByDate = new Map();
  for (const candle of rawCandles) {
    const estHour = getESTHour(candle.timestamp);
    const session = getSession(candle.timestamp);
    if (session !== 'evening' && session !== 'dead_zone' && session !== 'european' && session !== 'premarket') continue;

    const estDate = toESTDate(candle.timestamp);
    let tradingDateStr;
    if (estHour >= 18) {
      tradingDateStr = estDate.toISOString().split('T')[0];
    } else {
      const prevDay = new Date(estDate.getTime() - 86400000);
      tradingDateStr = prevDay.toISOString().split('T')[0];
    }

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

  for (const candles of overnightByDate.values()) {
    candles.sort((a, b) => a.timestamp - b.timestamp);
  }

  return overnightByDate;
}

// ─── Trade Simulation ─────────────────────────────────────────────────────────

function simulateTrades(nights, overnightByDate, stopLoss, target, levelFilter) {
  const trades = [];
  const tradeLevels = levelFilter || ['S1', 'S2', 'R1', 'R2'];
  const touchProximity = 5;

  for (const night of nights) {
    if (!night.gexTouches) continue;
    const candles = overnightByDate.get(night.date);
    if (!candles || candles.length === 0) continue;

    for (const levelName of tradeLevels) {
      const touchInfo = night.gexTouches[levelName];
      if (!touchInfo || !touchInfo.touched) continue;

      const levelPrice = touchInfo.price;
      const isLong = touchInfo.type === 'support';
      const isShort = touchInfo.type === 'resistance';
      if (!isLong && !isShort) continue;

      const touchTime = new Date(touchInfo.firstTouchTime).getTime();
      let touchIdx = -1;
      for (let i = 0; i < candles.length; i++) {
        if (candles[i].timestamp >= touchTime - 60000 && candles[i].timestamp <= touchTime + 60000) {
          if (candles[i].low <= levelPrice + touchProximity &&
              candles[i].high >= levelPrice - touchProximity) {
            touchIdx = i;
            break;
          }
        }
      }
      if (touchIdx === -1) continue;

      const entryPrice = levelPrice;
      const entryTime = candles[touchIdx].timestamp;

      let stopPrice, targetPrice;
      if (isLong) {
        stopPrice = entryPrice - stopLoss;
        targetPrice = entryPrice + target;
      } else {
        stopPrice = entryPrice + stopLoss;
        targetPrice = entryPrice - target;
      }

      let exitPrice = null, exitTime = null, exitReason = null;
      let maxFavorable = 0, maxAdverse = 0;

      for (let i = touchIdx; i < candles.length; i++) {
        const c = candles[i];
        if (isLong) {
          const favorable = c.high - entryPrice;
          const adverse = entryPrice - c.low;
          if (favorable > maxFavorable) maxFavorable = favorable;
          if (adverse > maxAdverse) maxAdverse = adverse;
          if (c.low <= stopPrice) { exitPrice = stopPrice; exitTime = c.timestamp; exitReason = 'stop_loss'; break; }
          if (c.high >= targetPrice) { exitPrice = targetPrice; exitTime = c.timestamp; exitReason = 'take_profit'; break; }
        } else {
          const favorable = entryPrice - c.low;
          const adverse = c.high - entryPrice;
          if (favorable > maxFavorable) maxFavorable = favorable;
          if (adverse > maxAdverse) maxAdverse = adverse;
          if (c.high >= stopPrice) { exitPrice = stopPrice; exitTime = c.timestamp; exitReason = 'stop_loss'; break; }
          if (c.low <= targetPrice) { exitPrice = targetPrice; exitTime = c.timestamp; exitReason = 'take_profit'; break; }
        }
      }

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
        pnl: Math.round(pnl * 100) / 100,
        holdMinutes: Math.round(holdMinutes),
        maxFavorable: Math.round(maxFavorable * 100) / 100,
        maxAdverse: Math.round(maxAdverse * 100) / 100,
        session: touchInfo.firstTouchSession,
        gexRegime: night.gex?.regime || 'unknown',
        ltSentiment: night.ltAtStart?.sentiment || 'unknown',
        exitReason,
      });
    }
  }

  return trades;
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

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

  const dates = [...new Set(trades.map(t => t.date))];
  const weekSpan = dates.length > 1
    ? (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / (7 * 86400000)
    : 1;
  const tradesPerWeek = trades.length / Math.max(weekSpan, 1);

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
    winRate: Math.round(winRate * 10) / 10,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round(mean(pnls) * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    tradesPerWeek: Math.round(tradesPerWeek * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    avgHoldMin: Math.round(mean(trades.map(t => t.holdMinutes))),
  };
}

// ─── Filter Definitions ───────────────────────────────────────────────────────

function defineFilters() {
  return [
    {
      name: 'Baseline (all trades)',
      nightFilter: () => true,
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Bearish LT only',
      nightFilter: (n) => n.ltAtStart?.sentiment === 'BEARISH',
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Bullish LT only',
      nightFilter: (n) => n.ltAtStart?.sentiment === 'BULLISH',
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'No Mon/Sun',
      nightFilter: (n) => {
        const day = getDayOfWeek(n.date);
        return day !== 'Monday' && day !== 'Sunday';
      },
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Wed only',
      nightFilter: (n) => getDayOfWeek(n.date) === 'Wednesday',
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Tue+Wed+Thu',
      nightFilter: (n) => {
        const day = getDayOfWeek(n.date);
        return day === 'Tuesday' || day === 'Wednesday' || day === 'Thursday';
      },
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'S1+R2 only',
      nightFilter: () => true,
      tradeFilter: () => true,
      levels: ['S1', 'R2'],
    },
    {
      name: 'S1 only',
      nightFilter: () => true,
      tradeFilter: () => true,
      levels: ['S1'],
    },
    {
      name: 'Negative GEX',
      nightFilter: (n) => n.gex?.regime === 'negative',
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Positive GEX',
      nightFilter: (n) => n.gex?.regime === 'positive',
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Evening+DeadZone only',
      nightFilter: () => true,
      tradeFilter: (t) => t.session === 'evening' || t.session === 'dead_zone',
      levels: null,
    },
    {
      name: 'European+Premarket only',
      nightFilter: () => true,
      tradeFilter: (t) => t.session === 'european' || t.session === 'premarket',
      levels: null,
    },
    // ── Combined Filters ──
    {
      name: 'Bearish LT + No Mon/Sun',
      nightFilter: (n) => {
        const day = getDayOfWeek(n.date);
        return n.ltAtStart?.sentiment === 'BEARISH' && day !== 'Monday' && day !== 'Sunday';
      },
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Bearish LT + Tue/Wed/Thu',
      nightFilter: (n) => {
        const day = getDayOfWeek(n.date);
        return n.ltAtStart?.sentiment === 'BEARISH' &&
          (day === 'Tuesday' || day === 'Wednesday' || day === 'Thursday');
      },
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Bearish LT + S1+R2',
      nightFilter: (n) => n.ltAtStart?.sentiment === 'BEARISH',
      tradeFilter: () => true,
      levels: ['S1', 'R2'],
    },
    {
      name: 'Bearish LT + S1 only',
      nightFilter: (n) => n.ltAtStart?.sentiment === 'BEARISH',
      tradeFilter: () => true,
      levels: ['S1'],
    },
    {
      name: 'Bearish LT + Negative GEX',
      nightFilter: (n) => n.ltAtStart?.sentiment === 'BEARISH' && n.gex?.regime === 'negative',
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Bearish LT + Positive GEX',
      nightFilter: (n) => n.ltAtStart?.sentiment === 'BEARISH' && n.gex?.regime === 'positive',
      tradeFilter: () => true,
      levels: null,
    },
    {
      name: 'Bearish LT + Tue/Wed/Thu + S1+R2',
      nightFilter: (n) => {
        const day = getDayOfWeek(n.date);
        return n.ltAtStart?.sentiment === 'BEARISH' &&
          (day === 'Tuesday' || day === 'Wednesday' || day === 'Thursday');
      },
      tradeFilter: () => true,
      levels: ['S1', 'R2'],
    },
    {
      name: 'Bearish LT + No Mon/Sun + S1+R2',
      nightFilter: (n) => {
        const day = getDayOfWeek(n.date);
        return n.ltAtStart?.sentiment === 'BEARISH' && day !== 'Monday' && day !== 'Sunday';
      },
      tradeFilter: () => true,
      levels: ['S1', 'R2'],
    },
    {
      name: 'Bearish LT + Wed + S1',
      nightFilter: (n) => {
        const day = getDayOfWeek(n.date);
        return n.ltAtStart?.sentiment === 'BEARISH' && day === 'Wednesday';
      },
      tradeFilter: () => true,
      levels: ['S1'],
    },
    {
      name: 'No Mon/Sun + S1+R2',
      nightFilter: (n) => {
        const day = getDayOfWeek(n.date);
        return day !== 'Monday' && day !== 'Sunday';
      },
      tradeFilter: () => true,
      levels: ['S1', 'R2'],
    },
    {
      name: 'Negative GEX + S1+R2',
      nightFilter: (n) => n.gex?.regime === 'negative',
      tradeFilter: () => true,
      levels: ['S1', 'R2'],
    },
    {
      name: 'Bearish LT + Evening/DeadZone',
      nightFilter: (n) => n.ltAtStart?.sentiment === 'BEARISH',
      tradeFilter: (t) => t.session === 'evening' || t.session === 'dead_zone',
      levels: null,
    },
    {
      name: 'Bearish LT + European/Premarket',
      nightFilter: (n) => n.ltAtStart?.sentiment === 'BEARISH',
      tradeFilter: (t) => t.session === 'european' || t.session === 'premarket',
      levels: null,
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Overnight First-Touch Filter Analysis');
  console.log('═'.repeat(120));

  const analysis = loadAnalysisResults();
  const overnightByDate = await loadOHLCVByDate('2023-03-28', '2026-01-28');

  const allNights = analysis.nights.filter(n =>
    n.date >= '2023-03-28' && n.date <= '2026-01-28' && n.gexTouches
  );
  console.log(`${allNights.length} nights with GEX touch data\n`);

  const filters = defineFilters();

  // Key SL/TP combos to test (from initial grid search)
  const slTpCombos = [
    { sl: 5, tp: 10, label: 'SL5/TP10' },
    { sl: 7, tp: 10, label: 'SL7/TP10' },
    { sl: 10, tp: 10, label: 'SL10/TP10' },
    { sl: 10, tp: 15, label: 'SL10/TP15' },
    { sl: 10, tp: 20, label: 'SL10/TP20' },
    { sl: 15, tp: 10, label: 'SL15/TP10' },
    { sl: 25, tp: 7, label: 'SL25/TP7' },
    { sl: 25, tp: 10, label: 'SL25/TP10' },
    { sl: 25, tp: 20, label: 'SL25/TP20' },
  ];

  // ── Run each filter × SL/TP combination ──

  const allResults = [];

  for (const filter of filters) {
    const filteredNights = allNights.filter(filter.nightFilter);

    for (const combo of slTpCombos) {
      let trades = simulateTrades(filteredNights, overnightByDate, combo.sl, combo.tp, filter.levels);

      // Apply trade-level filter (e.g., session filter)
      trades = trades.filter(filter.tradeFilter);

      const stats = computeStats(trades);
      if (stats && stats.trades >= 5) {
        allResults.push({
          filter: filter.name,
          sltp: combo.label,
          sl: combo.sl,
          tp: combo.tp,
          ...stats,
        });
      }
    }
  }

  // ── Print results by SL/TP combo ──
  for (const combo of slTpCombos) {
    const comboResults = allResults
      .filter(r => r.sltp === combo.label)
      .sort((a, b) => b.winRate - a.winRate);

    console.log(`\n${'═'.repeat(120)}`);
    console.log(`  ${combo.label} (SL=${combo.sl} TP=${combo.tp})`);
    console.log(`${'─'.repeat(120)}`);
    console.log(`  ${'Filter'.padEnd(38)} | Trades | /Week | Win%   | Total P&L | Avg P&L | PF    | MaxDD   | Hold`);
    console.log(`  ${'─'.repeat(37)} | ${'─'.repeat(6)} | ${'─'.repeat(5)} | ${'─'.repeat(6)} | ${'─'.repeat(9)} | ${'─'.repeat(7)} | ${'─'.repeat(5)} | ${'─'.repeat(7)} | ${'─'.repeat(4)}`);

    for (const r of comboResults) {
      const winStr = `${r.winRate.toFixed(1)}%`.padStart(6);
      const pnlStr = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(0);
      const avgStr = (r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2);
      const pfStr = r.profitFactor === Infinity ? '  Inf' : r.profitFactor.toFixed(2).padStart(5);
      const ddStr = `-${r.maxDrawdown.toFixed(0)}`.padStart(7);
      const marker = r.winRate >= 65 && r.tradesPerWeek >= 0.5 ? ' ★' : '';

      console.log(`  ${(r.filter + marker).padEnd(38)} | ${String(r.trades).padStart(6)} | ${r.tradesPerWeek.toFixed(1).padStart(5)} | ${winStr} | ${pnlStr.padStart(9)} | ${avgStr.padStart(7)} | ${pfStr} | ${ddStr} | ${String(r.avgHoldMin).padStart(3)}m`);
    }
  }

  // ── Summary: Best filter combos meeting criteria (65% WR, 0.5+ trades/week) ──
  console.log(`\n\n${'═'.repeat(120)}`);
  console.log('  TOP CONFIGURATIONS: Win Rate ≥65%, Trades/Week ≥0.5');
  console.log(`${'═'.repeat(120)}`);

  const qualifying = allResults
    .filter(r => r.winRate >= 65 && r.tradesPerWeek >= 0.5)
    .sort((a, b) => {
      // Sort by win rate, then total P&L
      if (Math.abs(a.winRate - b.winRate) > 2) return b.winRate - a.winRate;
      return b.totalPnl - a.totalPnl;
    });

  console.log(`  ${'Filter'.padEnd(38)} | ${'SL/TP'.padEnd(10)} | Trades | /Week | Win%   | Total P&L | Avg P&L | PF    | MaxDD`);
  console.log(`  ${'─'.repeat(37)} | ${'─'.repeat(10)} | ${'─'.repeat(6)} | ${'─'.repeat(5)} | ${'─'.repeat(6)} | ${'─'.repeat(9)} | ${'─'.repeat(7)} | ${'─'.repeat(5)} | ${'─'.repeat(7)}`);

  for (const r of qualifying.slice(0, 40)) {
    const winStr = `${r.winRate.toFixed(1)}%`.padStart(6);
    const pnlStr = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(0);
    const avgStr = (r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2);
    const pfStr = r.profitFactor === Infinity ? '  Inf' : r.profitFactor.toFixed(2).padStart(5);
    const ddStr = `-${r.maxDrawdown.toFixed(0)}`.padStart(7);

    console.log(`  ${r.filter.padEnd(38)} | ${r.sltp.padEnd(10)} | ${String(r.trades).padStart(6)} | ${r.tradesPerWeek.toFixed(1).padStart(5)} | ${winStr} | ${pnlStr.padStart(9)} | ${avgStr.padStart(7)} | ${pfStr} | ${ddStr}`);
  }

  // ── Best "practical" configs: balance win rate, frequency, and total P&L ──
  console.log(`\n\n${'═'.repeat(120)}`);
  console.log('  PRACTICAL PICKS: Best balance of win rate, frequency, and profitability');
  console.log(`${'═'.repeat(120)}`);

  // Score: winRate * log(trades) * totalPnl / maxDrawdown
  const scored = qualifying.map(r => ({
    ...r,
    score: r.winRate * Math.log(r.trades + 1) * (r.totalPnl / Math.max(r.maxDrawdown, 1)),
  })).sort((a, b) => b.score - a.score);

  console.log(`  ${'Filter'.padEnd(38)} | ${'SL/TP'.padEnd(10)} | Trades | /Week | Win%   | Total P&L | PF    | MaxDD   | Score`);
  console.log(`  ${'─'.repeat(37)} | ${'─'.repeat(10)} | ${'─'.repeat(6)} | ${'─'.repeat(5)} | ${'─'.repeat(6)} | ${'─'.repeat(9)} | ${'─'.repeat(5)} | ${'─'.repeat(7)} | ${'─'.repeat(7)}`);

  for (const r of scored.slice(0, 20)) {
    const winStr = `${r.winRate.toFixed(1)}%`.padStart(6);
    const pnlStr = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(0);
    const pfStr = r.profitFactor === Infinity ? '  Inf' : r.profitFactor.toFixed(2).padStart(5);
    const ddStr = `-${r.maxDrawdown.toFixed(0)}`.padStart(7);

    console.log(`  ${r.filter.padEnd(38)} | ${r.sltp.padEnd(10)} | ${String(r.trades).padStart(6)} | ${r.tradesPerWeek.toFixed(1).padStart(5)} | ${winStr} | ${pnlStr.padStart(9)} | ${pfStr} | ${ddStr} | ${r.score.toFixed(0).padStart(7)}`);
  }

  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  Total configurations tested: ${allResults.length}`);
  console.log(`  Qualifying (65% WR, 0.5/wk): ${qualifying.length}`);
  console.log(`${'═'.repeat(120)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
