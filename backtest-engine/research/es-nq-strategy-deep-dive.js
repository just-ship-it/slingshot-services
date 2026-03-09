#!/usr/bin/env node
/**
 * ES-NQ Strategy Deep Dive
 *
 * Based on findings from es-nq-correlation.js, this script digs deeper into
 * the most promising tradeable signals:
 *
 * 1. NQ-Leads-ES (1-min lag r=0.242): Can we trade ES based on NQ's prior bar?
 * 2. SMT Divergence (rigorous): Fix look-ahead bias by using confirmed swings only
 * 3. Relative Strength Mean Reversion: Intraday pair trade strategy
 * 4. Ratio Z-Score Daily Strategy: Daily mean reversion on NQ/ES ratio
 *
 * Each strategy is evaluated with realistic entry/exit rules and P&L tracking.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadContinuousOHLCV,
  toET,
  fromET,
  extractTradingDates,
  getRTHCandlesFromArray,
} from './utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, 'output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const START_DATE = '2021-01-26';
const END_DATE = '2026-01-25';

// ─── Utility Functions ───────────────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

function printTradeStats(label, trades) {
  if (trades.length === 0) { console.log(`  ${label}: No trades`); return; }
  const pnls = trades.map(t => t.pnl);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const winRate = wins.length / pnls.length;
  const avgPnl = mean(pnls);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? mean(losses) : 0;
  const profitFactor = losses.length && mean(losses) !== 0 ? (wins.reduce((a, b) => a + b, 0)) / Math.abs(losses.reduce((a, b) => a + b, 0)) : Infinity;
  const maxDD = computeMaxDrawdown(pnls);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  console.log(`  ${label}:`);
  console.log(`    Trades: ${trades.length} | Win Rate: ${(winRate * 100).toFixed(1)}%`);
  console.log(`    Total P&L: ${totalPnl.toFixed(1)} pts | Avg: ${avgPnl.toFixed(2)} pts`);
  console.log(`    Avg Win: ${avgWin.toFixed(2)} | Avg Loss: ${avgLoss.toFixed(2)} | PF: ${profitFactor.toFixed(2)}`);
  console.log(`    Median: ${median(pnls).toFixed(2)} | StdDev: ${stddev(pnls).toFixed(2)}`);
  console.log(`    Max Drawdown: ${maxDD.toFixed(1)} pts`);
}

function computeMaxDrawdown(pnls) {
  let cumPnl = 0, peak = 0, maxDD = 0;
  for (const p of pnls) {
    cumPnl += p;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function printYearlyBreakdown(trades) {
  const byYear = {};
  for (const t of trades) {
    const year = new Date(t.entryTime).getFullYear();
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(t);
  }

  console.log('    Year  | Trades | Win%  | Total P&L | Avg P&L');
  console.log('    ──────|────────|───────|───────────|────────');
  for (const [year, yearTrades] of Object.entries(byYear).sort()) {
    const pnls = yearTrades.map(t => t.pnl);
    const wins = pnls.filter(p => p > 0).length;
    console.log(`    ${year}  | ${String(yearTrades.length).padStart(6)} | ${(wins / pnls.length * 100).toFixed(1).padStart(5)}% | ${pnls.reduce((a, b) => a + b, 0).toFixed(1).padStart(9)} | ${mean(pnls).toFixed(2).padStart(7)}`);
  }
}

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadData() {
  console.log('Loading continuous 1m data...\n');

  const [nqCandles, esCandles] = await Promise.all([
    loadContinuousOHLCV('NQ', '1m', START_DATE, END_DATE),
    loadContinuousOHLCV('ES', '1m', START_DATE, END_DATE)
  ]);

  const nqMap = new Map();
  for (const c of nqCandles) nqMap.set(c.timestamp, c);

  const esMap = new Map();
  for (const c of esCandles) esMap.set(c.timestamp, c);

  const commonTimestamps = [];
  for (const ts of nqMap.keys()) {
    if (esMap.has(ts)) commonTimestamps.push(ts);
  }
  commonTimestamps.sort((a, b) => a - b);

  console.log(`Overlapping bars: ${commonTimestamps.length.toLocaleString()}\n`);

  return { nqCandles, esCandles, nqMap, esMap, commonTimestamps };
}

// ─── Strategy 1: NQ-Leads-ES ────────────────────────────────────────────────
// If NQ moves significantly in bar T, trade ES in the same direction at bar T+1

function strategyNQLeadsES(nqMap, esMap, commonTimestamps) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Strategy 1: NQ-Leads-ES (Trade ES based on NQ prior bar)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Test various NQ return thresholds for triggering ES entry
  const thresholds = [0.0003, 0.0005, 0.001, 0.0015, 0.002];
  // Test various holding periods
  const holdPeriods = [1, 2, 3, 5];

  console.log('  Threshold | Hold | Trades | Win%   | Avg P&L (ES pts) | Total P&L | PF');
  console.log('  ──────────|──────|────────|────────|──────────────────|───────────|─────');

  const allResults = [];

  for (const threshold of thresholds) {
    for (const hold of holdPeriods) {
      const trades = [];

      for (let i = 1; i < commonTimestamps.length - hold; i++) {
        const ts = commonTimestamps[i];
        const tsPrev = commonTimestamps[i - 1];

        // Skip session gaps
        if ((ts - tsPrev) > 120000) continue;

        const nqPrev = nqMap.get(tsPrev);
        const nqNow = nqMap.get(ts);
        if (!nqPrev || !nqNow || nqPrev.close === 0) continue;

        const nqReturn = (nqNow.close - nqPrev.close) / nqPrev.close;

        if (Math.abs(nqReturn) < threshold) continue;

        // Only trade during RTH
        const et = toET(ts);
        if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) continue;

        const direction = nqReturn > 0 ? 1 : -1;  // Follow NQ direction

        // Entry at next bar's open (approximated by current bar's close)
        const entryTs = commonTimestamps[i + 1];
        if (!entryTs || (entryTs - ts) > 120000) continue;

        const esEntry = esMap.get(entryTs);
        if (!esEntry) continue;

        const exitIdx = i + 1 + hold;
        if (exitIdx >= commonTimestamps.length) continue;

        const exitTs = commonTimestamps[exitIdx];
        if ((exitTs - entryTs) > hold * 120000) continue;

        const esExit = esMap.get(exitTs);
        if (!esExit) continue;

        const pnl = direction * (esExit.close - esEntry.close);

        trades.push({
          entryTime: entryTs,
          pnl,
          direction,
          nqReturn
        });
      }

      if (trades.length > 0) {
        const pnls = trades.map(t => t.pnl);
        const wins = pnls.filter(p => p > 0).length;
        const totalPnl = pnls.reduce((a, b) => a + b, 0);
        const avgPnl = mean(pnls);
        const winLoss = pnls.filter(p => p <= 0);
        const pf = winLoss.length && winLoss.reduce((a, b) => a + b, 0) !== 0
          ? pnls.filter(p => p > 0).reduce((a, b) => a + b, 0) / Math.abs(winLoss.reduce((a, b) => a + b, 0))
          : 0;

        allResults.push({ threshold, hold, trades, winRate: wins / trades.length, avgPnl, totalPnl, pf });

        console.log(`  ${(threshold * 100).toFixed(2).padStart(7)}%  | ${String(hold).padStart(4)} | ${String(trades.length).padStart(6)} | ${(wins / trades.length * 100).toFixed(1).padStart(5)}% | ${avgPnl.toFixed(3).padStart(16)} | ${totalPnl.toFixed(1).padStart(9)} | ${pf.toFixed(2)}`);
      }
    }
  }

  // Show best configuration details
  const best = allResults.sort((a, b) => b.totalPnl - a.totalPnl)[0];
  if (best) {
    console.log(`\n  Best config: threshold=${(best.threshold * 100).toFixed(2)}%, hold=${best.hold}m`);
    printTradeStats('Best Config', best.trades);
    printYearlyBreakdown(best.trades);
  }

  return allResults;
}

// ─── Strategy 2: Rigorous SMT Divergence ─────────────────────────────────────
// Uses ONLY confirmed swings (lookback only, no future bars) to avoid look-ahead bias

function strategySMTDivergence(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Strategy 2: SMT Divergence (Confirmed Swings Only)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const SWING_CONFIRM = 3;  // Bars to confirm swing (lookback only)
  const SWING_MEMORY = 20;  // Remember last N swing highs/lows

  // Track confirmed swings using lookback-only detection
  // A swing high is confirmed when we see SWING_CONFIRM consecutive lower highs after it
  // A swing low is confirmed when we see SWING_CONFIRM consecutive higher lows after it

  function trackSwings(map, timestamps) {
    const confirmedHighs = [];
    const confirmedLows = [];

    let pendingHigh = null;  // { price, ts, idx, confirmCount }
    let pendingLow = null;
    let lastHigh = -Infinity;
    let lastLow = Infinity;

    for (let i = 1; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const candle = map.get(ts);
      if (!candle) continue;

      // Track potential swing high
      if (candle.high > lastHigh) {
        pendingHigh = { price: candle.high, ts, idx: i, confirmCount: 0 };
        lastHigh = candle.high;
      } else if (pendingHigh && candle.high < pendingHigh.price) {
        pendingHigh.confirmCount++;
        if (pendingHigh.confirmCount >= SWING_CONFIRM) {
          confirmedHighs.push({ ...pendingHigh, confirmedAt: i });
          // Reset - start looking for next swing from this level
          lastHigh = candle.high;
          pendingHigh = null;
        }
      }

      // Track potential swing low
      if (candle.low < lastLow) {
        pendingLow = { price: candle.low, ts, idx: i, confirmCount: 0 };
        lastLow = candle.low;
      } else if (pendingLow && candle.low > pendingLow.price) {
        pendingLow.confirmCount++;
        if (pendingLow.confirmCount >= SWING_CONFIRM) {
          confirmedLows.push({ ...pendingLow, confirmedAt: i });
          lastLow = candle.low;
          pendingLow = null;
        }
      }
    }

    return { confirmedHighs, confirmedLows };
  }

  const nqSwings = trackSwings(nqMap, commonTimestamps);
  const esSwings = trackSwings(esMap, commonTimestamps);

  console.log(`  NQ confirmed swing highs: ${nqSwings.confirmedHighs.length}, lows: ${nqSwings.confirmedLows.length}`);
  console.log(`  ES confirmed swing highs: ${esSwings.confirmedHighs.length}, lows: ${esSwings.confirmedLows.length}`);

  // Index swings by confirmation bar for efficient lookup
  const esHighsByConfirm = new Map();
  for (const s of esSwings.confirmedHighs) {
    if (!esHighsByConfirm.has(s.confirmedAt)) esHighsByConfirm.set(s.confirmedAt, []);
    esHighsByConfirm.get(s.confirmedAt).push(s);
  }
  const esLowsByConfirm = new Map();
  for (const s of esSwings.confirmedLows) {
    if (!esLowsByConfirm.has(s.confirmedAt)) esLowsByConfirm.set(s.confirmedAt, []);
    esLowsByConfirm.get(s.confirmedAt).push(s);
  }

  // Walk through time, maintaining recent swing memory for each instrument
  const recentNQHighs = [];
  const recentNQLows = [];
  const recentESHighs = [];
  const recentESLows = [];

  let nqHighIdx = 0;
  let nqLowIdx = 0;
  let esHighIdx = 0;
  let esLowIdx = 0;

  const WINDOW_BARS = 30;  // Swings must be within N bars of each other

  const bearishSMT = [];  // Short signals
  const bullishSMT = [];  // Long signals

  // Process each bar
  for (let i = 0; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];

    // Add newly confirmed swings
    while (nqHighIdx < nqSwings.confirmedHighs.length && nqSwings.confirmedHighs[nqHighIdx].confirmedAt <= i) {
      recentNQHighs.push(nqSwings.confirmedHighs[nqHighIdx]);
      if (recentNQHighs.length > SWING_MEMORY) recentNQHighs.shift();
      nqHighIdx++;
    }
    while (nqLowIdx < nqSwings.confirmedLows.length && nqSwings.confirmedLows[nqLowIdx].confirmedAt <= i) {
      recentNQLows.push(nqSwings.confirmedLows[nqLowIdx]);
      if (recentNQLows.length > SWING_MEMORY) recentNQLows.shift();
      nqLowIdx++;
    }
    while (esHighIdx < esSwings.confirmedHighs.length && esSwings.confirmedHighs[esHighIdx].confirmedAt <= i) {
      recentESHighs.push(esSwings.confirmedHighs[esHighIdx]);
      if (recentESHighs.length > SWING_MEMORY) recentESHighs.shift();
      esHighIdx++;
    }
    while (esLowIdx < esSwings.confirmedLows.length && esSwings.confirmedLows[esLowIdx].confirmedAt <= i) {
      recentESLows.push(esSwings.confirmedLows[esLowIdx]);
      if (recentESLows.length > SWING_MEMORY) recentESLows.shift();
      esLowIdx++;
    }

    // Only check for new divergences when a new swing is confirmed at this bar
    const newNQHigh = nqHighIdx > 0 && nqSwings.confirmedHighs[nqHighIdx - 1]?.confirmedAt === i;
    const newNQLow = nqLowIdx > 0 && nqSwings.confirmedLows[nqLowIdx - 1]?.confirmedAt === i;
    const newESHigh = esHighIdx > 0 && esSwings.confirmedHighs[esHighIdx - 1]?.confirmedAt === i;
    const newESLow = esLowIdx > 0 && esSwings.confirmedLows[esLowIdx - 1]?.confirmedAt === i;

    // Only trade during RTH
    const et = toET(ts);
    if (et.timeInMinutes < 570 || et.timeInMinutes >= 945) continue;  // 9:30 AM - 3:45 PM

    // Bearish SMT: NQ makes higher high, but most recent ES high is lower than its prior high
    if (newNQHigh && recentNQHighs.length >= 2 && recentESHighs.length >= 2) {
      const nqLatest = recentNQHighs[recentNQHighs.length - 1];
      const nqPrior = recentNQHighs[recentNQHighs.length - 2];
      const esLatest = recentESHighs[recentESHighs.length - 1];
      const esPrior = recentESHighs[recentESHighs.length - 2];

      // Swings should be within reasonable time of each other
      if (Math.abs(nqLatest.idx - esLatest.idx) > WINDOW_BARS) continue;

      if (nqLatest.price > nqPrior.price && esLatest.price < esPrior.price) {
        bearishSMT.push({
          signalBar: i,
          signalTime: ts,
          nqHigh: nqLatest.price,
          nqPriorHigh: nqPrior.price,
          esHigh: esLatest.price,
          esPriorHigh: esPrior.price,
        });
      }
    }

    // Also check when new ES high is confirmed
    if (newESHigh && recentNQHighs.length >= 2 && recentESHighs.length >= 2) {
      const nqLatest = recentNQHighs[recentNQHighs.length - 1];
      const nqPrior = recentNQHighs[recentNQHighs.length - 2];
      const esLatest = recentESHighs[recentESHighs.length - 1];
      const esPrior = recentESHighs[recentESHighs.length - 2];

      if (Math.abs(nqLatest.idx - esLatest.idx) > WINDOW_BARS) continue;

      if (nqLatest.price > nqPrior.price && esLatest.price < esPrior.price) {
        // Deduplicate - don't double-count if we already captured this divergence
        const lastSig = bearishSMT[bearishSMT.length - 1];
        if (!lastSig || Math.abs(lastSig.signalBar - i) > 3) {
          bearishSMT.push({
            signalBar: i,
            signalTime: ts,
            nqHigh: nqLatest.price,
            nqPriorHigh: nqPrior.price,
            esHigh: esLatest.price,
            esPriorHigh: esPrior.price,
          });
        }
      }
    }

    // Bullish SMT: NQ makes lower low, but most recent ES low is higher than its prior low
    if (newNQLow && recentNQLows.length >= 2 && recentESLows.length >= 2) {
      const nqLatest = recentNQLows[recentNQLows.length - 1];
      const nqPrior = recentNQLows[recentNQLows.length - 2];
      const esLatest = recentESLows[recentESLows.length - 1];
      const esPrior = recentESLows[recentESLows.length - 2];

      if (Math.abs(nqLatest.idx - esLatest.idx) > WINDOW_BARS) continue;

      if (nqLatest.price < nqPrior.price && esLatest.price > esPrior.price) {
        bullishSMT.push({
          signalBar: i,
          signalTime: ts,
          nqLow: nqLatest.price,
          nqPriorLow: nqPrior.price,
          esLow: esLatest.price,
          esPriorLow: esPrior.price,
        });
      }
    }

    if (newESLow && recentNQLows.length >= 2 && recentESLows.length >= 2) {
      const nqLatest = recentNQLows[recentNQLows.length - 1];
      const nqPrior = recentNQLows[recentNQLows.length - 2];
      const esLatest = recentESLows[recentESLows.length - 1];
      const esPrior = recentESLows[recentESLows.length - 2];

      if (Math.abs(nqLatest.idx - esLatest.idx) > WINDOW_BARS) continue;

      if (nqLatest.price < nqPrior.price && esLatest.price > esPrior.price) {
        const lastSig = bullishSMT[bullishSMT.length - 1];
        if (!lastSig || Math.abs(lastSig.signalBar - i) > 3) {
          bullishSMT.push({
            signalBar: i,
            signalTime: ts,
            nqLow: nqLatest.price,
            nqPriorLow: nqPrior.price,
            esLow: esLatest.price,
            esPriorLow: esPrior.price,
          });
        }
      }
    }
  }

  console.log(`\n  Bearish SMT signals (confirmed): ${bearishSMT.length}`);
  console.log(`  Bullish SMT signals (confirmed): ${bullishSMT.length}`);

  // Evaluate signals with proper trade management
  const holdPeriods = [5, 10, 15, 30, 60];

  for (const type of ['bearish', 'bullish']) {
    const signals = type === 'bearish' ? bearishSMT : bullishSMT;
    if (signals.length === 0) continue;

    console.log(`\n  ${type.toUpperCase()} SMT — Fixed hold periods (NQ points):`);
    console.log('  Hold | Trades | Win%  | Avg P&L | Total P&L | PF');
    console.log('  ─────|────────|───────|─────────|───────────|─────');

    for (const hold of holdPeriods) {
      const trades = [];

      for (const sig of signals) {
        const entryIdx = sig.signalBar + 1;  // Enter next bar after signal
        if (entryIdx >= commonTimestamps.length) continue;

        const entryTs = commonTimestamps[entryIdx];
        const nqEntry = nqMap.get(entryTs);
        if (!nqEntry) continue;

        const exitIdx = entryIdx + hold;
        if (exitIdx >= commonTimestamps.length) continue;

        const exitTs = commonTimestamps[exitIdx];
        // Ensure no session gap
        if ((exitTs - entryTs) > hold * 120000) continue;

        const nqExit = nqMap.get(exitTs);
        if (!nqExit) continue;

        const direction = type === 'bearish' ? -1 : 1;
        const pnl = direction * (nqExit.close - nqEntry.close);

        trades.push({ entryTime: entryTs, pnl, direction });
      }

      if (trades.length === 0) continue;
      const pnls = trades.map(t => t.pnl);
      const wins = pnls.filter(p => p > 0).length;
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const lossPnl = pnls.filter(p => p <= 0).reduce((a, b) => a + b, 0);
      const winPnl = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const pf = lossPnl !== 0 ? winPnl / Math.abs(lossPnl) : Infinity;

      console.log(`  ${String(hold).padStart(4)} | ${String(trades.length).padStart(6)} | ${(wins / trades.length * 100).toFixed(1).padStart(5)}% | ${mean(pnls).toFixed(2).padStart(7)} | ${totalPnl.toFixed(1).padStart(9)} | ${pf.toFixed(2)}`);
    }

    // Best hold period with stop/target management
    console.log(`\n  ${type.toUpperCase()} SMT — With stop loss and target (NQ points):`);
    console.log('  Stop | Target | Trades | Win%  | Avg P&L | Total P&L | PF');
    console.log('  ─────|────────|────────|───────|─────────|───────────|─────');

    const stopTargetCombos = [
      { stop: 10, target: 20 },
      { stop: 15, target: 30 },
      { stop: 20, target: 40 },
      { stop: 25, target: 50 },
      { stop: 15, target: 15 },
      { stop: 10, target: 30 },
    ];

    for (const { stop, target } of stopTargetCombos) {
      const trades = [];
      const MAX_HOLD = 60;  // Maximum bars to hold

      for (const sig of signals) {
        const entryIdx = sig.signalBar + 1;
        if (entryIdx >= commonTimestamps.length) continue;

        const entryTs = commonTimestamps[entryIdx];
        const nqEntry = nqMap.get(entryTs);
        if (!nqEntry) continue;

        const direction = type === 'bearish' ? -1 : 1;
        const entryPrice = nqEntry.close;
        let exitPnl = null;

        for (let j = 1; j <= MAX_HOLD; j++) {
          const barIdx = entryIdx + j;
          if (barIdx >= commonTimestamps.length) break;

          const barTs = commonTimestamps[barIdx];
          if ((barTs - entryTs) > MAX_HOLD * 120000) break;

          const bar = nqMap.get(barTs);
          if (!bar) continue;

          // Check stop
          const adverseExcursion = direction === 1
            ? entryPrice - bar.low
            : bar.high - entryPrice;

          if (adverseExcursion >= stop) {
            exitPnl = -stop;
            break;
          }

          // Check target
          const favorableExcursion = direction === 1
            ? bar.high - entryPrice
            : entryPrice - bar.low;

          if (favorableExcursion >= target) {
            exitPnl = target;
            break;
          }
        }

        // Time exit if no stop/target hit
        if (exitPnl === null) {
          const exitIdx = Math.min(entryIdx + MAX_HOLD, commonTimestamps.length - 1);
          const nqExit = nqMap.get(commonTimestamps[exitIdx]);
          if (nqExit) {
            exitPnl = direction * (nqExit.close - entryPrice);
          }
        }

        if (exitPnl !== null) {
          trades.push({ entryTime: entryTs, pnl: exitPnl, direction });
        }
      }

      if (trades.length === 0) continue;
      const pnls = trades.map(t => t.pnl);
      const wins = pnls.filter(p => p > 0).length;
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const lossPnl = pnls.filter(p => p <= 0).reduce((a, b) => a + b, 0);
      const winPnl = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const pf = lossPnl !== 0 ? winPnl / Math.abs(lossPnl) : Infinity;

      console.log(`  ${String(stop).padStart(4)} | ${String(target).padStart(6)} | ${String(trades.length).padStart(6)} | ${(wins / trades.length * 100).toFixed(1).padStart(5)}% | ${mean(pnls).toFixed(2).padStart(7)} | ${totalPnl.toFixed(1).padStart(9)} | ${pf.toFixed(2)}`);
    }
  }

  // Yearly breakdown for best bearish config
  if (bearishSMT.length > 0) {
    const trades = [];
    const stop = 15, target = 30;
    for (const sig of bearishSMT) {
      const entryIdx = sig.signalBar + 1;
      if (entryIdx >= commonTimestamps.length) continue;
      const entryTs = commonTimestamps[entryIdx];
      const nqEntry = nqMap.get(entryTs);
      if (!nqEntry) continue;
      const entryPrice = nqEntry.close;
      let exitPnl = null;

      for (let j = 1; j <= 60; j++) {
        const barIdx = entryIdx + j;
        if (barIdx >= commonTimestamps.length) break;
        const barTs = commonTimestamps[barIdx];
        if ((barTs - entryTs) > 7200000) break;
        const bar = nqMap.get(barTs);
        if (!bar) continue;
        if (bar.high - entryPrice >= stop) { exitPnl = -stop; break; }
        if (entryPrice - bar.low >= target) { exitPnl = target; break; }
      }
      if (exitPnl === null) {
        const exitIdx = Math.min(entryIdx + 60, commonTimestamps.length - 1);
        const nqExit = nqMap.get(commonTimestamps[exitIdx]);
        if (nqExit) exitPnl = -(nqExit.close - entryPrice);
      }
      if (exitPnl !== null) trades.push({ entryTime: entryTs, pnl: exitPnl });
    }
    if (trades.length > 0) {
      console.log('\n  BEARISH SMT yearly breakdown (15pt stop / 30pt target):');
      printYearlyBreakdown(trades);
    }
  }

  if (bullishSMT.length > 0) {
    const trades = [];
    const stop = 15, target = 30;
    for (const sig of bullishSMT) {
      const entryIdx = sig.signalBar + 1;
      if (entryIdx >= commonTimestamps.length) continue;
      const entryTs = commonTimestamps[entryIdx];
      const nqEntry = nqMap.get(entryTs);
      if (!nqEntry) continue;
      const entryPrice = nqEntry.close;
      let exitPnl = null;

      for (let j = 1; j <= 60; j++) {
        const barIdx = entryIdx + j;
        if (barIdx >= commonTimestamps.length) break;
        const barTs = commonTimestamps[barIdx];
        if ((barTs - entryTs) > 7200000) break;
        const bar = nqMap.get(barTs);
        if (!bar) continue;
        if (entryPrice - bar.low >= stop) { exitPnl = -stop; break; }
        if (bar.high - entryPrice >= target) { exitPnl = target; break; }
      }
      if (exitPnl === null) {
        const exitIdx = Math.min(entryIdx + 60, commonTimestamps.length - 1);
        const nqExit = nqMap.get(commonTimestamps[exitIdx]);
        if (nqExit) exitPnl = nqExit.close - entryPrice;
      }
      if (exitPnl !== null) trades.push({ entryTime: entryTs, pnl: exitPnl });
    }
    if (trades.length > 0) {
      console.log('\n  BULLISH SMT yearly breakdown (15pt stop / 30pt target):');
      printYearlyBreakdown(trades);
    }
  }

  return { bearishSMT, bullishSMT };
}

// ─── Strategy 3: Intraday Relative Strength Mean Reversion ───────────────────
// When NQ outperforms ES over 15 minutes by >X bps, fade the relative move

function strategyRelStrengthReversion(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Strategy 3: Relative Strength Mean Reversion');
  console.log('  (When NQ outperforms/underperforms ES by threshold, fade it)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const FORMATION = 15;  // bars to measure relative strength
  const THRESHOLDS = [3, 5, 7, 10, 15];  // bps threshold for signal
  const HOLDING_PERIODS = [5, 10, 15, 30];

  console.log('  Threshold | Hold | Trades | Win%  | Avg P&L (NQ pts) | Total P&L | PF');
  console.log('  ──────────|──────|────────|───────|──────────────────|───────────|─────');

  for (const threshBps of THRESHOLDS) {
    for (const hold of HOLDING_PERIODS) {
      const trades = [];
      let cooldown = 0;

      for (let i = FORMATION; i < commonTimestamps.length - hold; i++) {
        if (cooldown > 0) { cooldown--; continue; }

        const ts = commonTimestamps[i];
        const tsPrev = commonTimestamps[i - FORMATION];

        // Skip session gaps
        if ((ts - tsPrev) > FORMATION * 120000) continue;

        // Only RTH
        const et = toET(ts);
        if (et.timeInMinutes < 570 || et.timeInMinutes >= 945) continue;

        const nqNow = nqMap.get(ts);
        const nqPrev = nqMap.get(tsPrev);
        const esNow = esMap.get(ts);
        const esPrev = esMap.get(tsPrev);

        if (!nqNow || !nqPrev || !esNow || !esPrev) continue;
        if (nqPrev.close === 0 || esPrev.close === 0) continue;

        const nqReturn = (nqNow.close - nqPrev.close) / nqPrev.close;
        const esReturn = (esNow.close - esPrev.close) / esPrev.close;
        const relReturn = (nqReturn - esReturn) * 10000;  // in bps

        if (Math.abs(relReturn) < threshBps) continue;

        // NQ outperformed → short NQ (expect mean reversion)
        // NQ underperformed → long NQ
        const direction = relReturn > 0 ? -1 : 1;

        const exitIdx = i + hold;
        if (exitIdx >= commonTimestamps.length) continue;
        const exitTs = commonTimestamps[exitIdx];
        if ((exitTs - ts) > hold * 120000) continue;

        const nqExit = nqMap.get(exitTs);
        if (!nqExit) continue;

        const pnl = direction * (nqExit.close - nqNow.close);
        trades.push({ entryTime: ts, pnl, direction, relReturn });
        cooldown = hold;  // Don't re-enter until current trade would have exited
      }

      if (trades.length === 0) continue;
      const pnls = trades.map(t => t.pnl);
      const wins = pnls.filter(p => p > 0).length;
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const lossPnl = pnls.filter(p => p <= 0).reduce((a, b) => a + b, 0);
      const winPnl = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const pf = lossPnl !== 0 ? winPnl / Math.abs(lossPnl) : Infinity;

      console.log(`  ${String(threshBps).padStart(6)} bps | ${String(hold).padStart(4)} | ${String(trades.length).padStart(6)} | ${(wins / trades.length * 100).toFixed(1).padStart(5)}% | ${mean(pnls).toFixed(2).padStart(16)} | ${totalPnl.toFixed(1).padStart(9)} | ${pf.toFixed(2)}`);
    }
  }
}

// ─── Strategy 4: Combined NQ-Lead + Relative Strength Filter ─────────────────

function strategyCombined(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Strategy 4: NQ-Lead with Relative Strength Confirmation');
  console.log('  (NQ moves + NQ was recently underperforming = stronger signal)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const NQ_THRESHOLD = 0.001;  // 0.1% NQ move
  const REL_LOOKBACK = 15;     // 15-bar relative strength
  const HOLD = 3;

  // Split into: NQ-lead-only vs NQ-lead + relative strength confirmation
  const tradesNoFilter = [];
  const tradesWithFilter = [];
  const tradesCounterFilter = [];

  for (let i = Math.max(1, REL_LOOKBACK); i < commonTimestamps.length - HOLD - 1; i++) {
    const ts = commonTimestamps[i];
    const tsPrev = commonTimestamps[i - 1];

    if ((ts - tsPrev) > 120000) continue;

    const et = toET(ts);
    if (et.timeInMinutes < 570 || et.timeInMinutes >= 945) continue;

    const nqPrev = nqMap.get(tsPrev);
    const nqNow = nqMap.get(ts);
    if (!nqPrev || !nqNow || nqPrev.close === 0) continue;

    const nqReturn = (nqNow.close - nqPrev.close) / nqPrev.close;
    if (Math.abs(nqReturn) < NQ_THRESHOLD) continue;

    const direction = nqReturn > 0 ? 1 : -1;

    // Calculate relative strength
    const relLookbackTs = commonTimestamps[i - REL_LOOKBACK];
    if (!relLookbackTs || (ts - relLookbackTs) > REL_LOOKBACK * 120000) continue;

    const nqRelBase = nqMap.get(relLookbackTs);
    const esNow = esMap.get(ts);
    const esRelBase = esMap.get(relLookbackTs);

    if (!nqRelBase || !esNow || !esRelBase || nqRelBase.close === 0 || esRelBase.close === 0) continue;

    const nqRelReturn = (nqNow.close - nqRelBase.close) / nqRelBase.close;
    const esRelReturn = (esNow.close - esRelBase.close) / esRelBase.close;
    const relStrength = (nqRelReturn - esRelReturn) * 10000;

    // Entry on ES at next bar
    const entryTs = commonTimestamps[i + 1];
    if (!entryTs || (entryTs - ts) > 120000) continue;
    const esEntry = esMap.get(entryTs);
    if (!esEntry) continue;

    const exitIdx = i + 1 + HOLD;
    if (exitIdx >= commonTimestamps.length) continue;
    const exitTs = commonTimestamps[exitIdx];
    if ((exitTs - entryTs) > HOLD * 120000) continue;
    const esExit = esMap.get(exitTs);
    if (!esExit) continue;

    const pnl = direction * (esExit.close - esEntry.close);
    const trade = { entryTime: entryTs, pnl, direction, relStrength };

    tradesNoFilter.push(trade);

    // Confirmation filter: NQ move aligns with NQ being the "catching up" instrument
    // If NQ goes up AND NQ was recently underperforming → NQ catching up, ES should follow
    // If NQ goes up AND NQ was recently outperforming → NQ extending lead, maybe ES won't follow
    const catching = (direction === 1 && relStrength < -2) || (direction === -1 && relStrength > 2);
    const extending = (direction === 1 && relStrength > 2) || (direction === -1 && relStrength < -2);

    if (catching) tradesWithFilter.push(trade);
    if (extending) tradesCounterFilter.push(trade);
  }

  console.log('  Comparison:');
  printTradeStats('All NQ-Lead signals (no filter)', tradesNoFilter);
  console.log('');
  printTradeStats('NQ catching up (should be stronger)', tradesWithFilter);
  console.log('');
  printTradeStats('NQ extending lead (should be weaker)', tradesCounterFilter);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ES-NQ Strategy Deep Dive');
  console.log(`  Date Range: ${START_DATE} to ${END_DATE}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { nqCandles, esCandles, nqMap, esMap, commonTimestamps } = await loadData();

  strategyNQLeadsES(nqMap, esMap, commonTimestamps);
  strategySMTDivergence(nqMap, esMap, commonTimestamps);
  strategyRelStrengthReversion(nqMap, esMap, commonTimestamps);
  strategyCombined(nqMap, esMap, commonTimestamps);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Analysis Complete');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\nError:', err.message);
  console.error(err.stack);
  process.exit(1);
});
