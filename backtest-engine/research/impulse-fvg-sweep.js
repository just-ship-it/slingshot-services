#!/usr/bin/env node
/**
 * Impulse FVG Parameter Sweep - Fast In-Process Version
 *
 * Loads OHLCV data once, then iterates parameter combinations with a lightweight
 * trade simulation loop. Much faster than spawning CLI processes per config.
 *
 * Usage:
 *   node research/impulse-fvg-sweep.js                    # Full sweep
 *   node research/impulse-fvg-sweep.js --quick             # Quick sweep
 *   node research/impulse-fvg-sweep.js --start 2024-01-01  # Custom dates
 */

import fs from 'fs';
import path from 'path';
import { CSVLoader } from '../src/data/csv-loader.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, 'output', 'sweeps', 'impulse-fvg');

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const QUICK = args.includes('--quick');
const START = getArg('start', '2023-06-01');
const END = getArg('end', '2025-12-25');
const TICKER = getArg('ticker', 'NQ');
const COMMISSION = 5.0;     // Round-trip commission per contract
const POINT_VALUE = 20.0;   // NQ $20/point
const SLIPPAGE = 1.0;       // Market order slippage in points

// ── Time helpers ───────────────────────────────────────────────
function getETMinutes(ts) {
  const d = new Date(ts);
  const month = d.getUTCMonth();
  const offset = (month >= 2 && month <= 10) ? 4 : 5;
  return ((d.getUTCHours() - offset + 24) % 24) * 60 + d.getUTCMinutes();
}

const EVENT_WINDOWS = [
  { start: 8 * 60 + 25, end: 8 * 60 + 40 },
  { start: 9 * 60 + 28, end: 9 * 60 + 37 },
  { start: 9 * 60 + 58, end: 10 * 60 + 7 },
  { start: 13 * 60 + 58, end: 14 * 60 + 15 },
  { start: 14 * 60 + 28, end: 14 * 60 + 42 },
];

function isInEventWindow(ts) {
  const m = getETMinutes(ts);
  return EVENT_WINDOWS.some(w => m >= w.start && m <= w.end);
}

function isRTH(ts) {
  const m = getETMinutes(ts);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

function isMarketClose(ts) {
  const m = getETMinutes(ts);
  return m >= 16 * 60 || m < 4 * 60; // After 4pm or before 4am = closed for RTH
}

function detectFVG(c0, c1, c2, minGap) {
  if (!c0 || !c1 || !c2) return null;
  const bullGap = c2.low - c0.high;
  const bearGap = c0.low - c2.high;
  if (bullGap >= minGap) return { type: 'bullish', gapSize: bullGap, top: c2.low, bottom: c0.high };
  if (bearGap >= minGap) return { type: 'bearish', gapSize: bearGap, top: c0.low, bottom: c2.high };
  return null;
}

function round(v, d = 2) { return Math.round(v * 10 ** d) / 10 ** d; }

// ── Trade Simulation ──────────────────────────────────────────
function runSimulation(candles, params) {
  const {
    minBodyPoints, mode,
    fvgPullbackBuffer, fvgStopBuffer, fvgTargetPoints, fvgMinGapSize,
    noFvgStopBuffer, noFvgTargetPoints, noFvgMaxRisk,
    trailingTrigger, trailingOffset, useTrailingStop,
    maxHoldBars, limitOrderTimeout,
    cooldownMs
  } = params;

  const fvgEnabled = mode === 'both' || mode === 'fvg-pullback';
  const fadeEnabled = mode === 'both' || mode === 'no-fvg-fade';

  let lastSignalTime = 0;
  let trade = null;         // Active trade: { side, entry, stop, target, entryTime, barsHeld, highWater, trailingActive }
  let pendingOrder = null;  // Unfilled limit order: { side, price, stop, target, signalTime, barsWaited }
  let trades = [];
  let equity = 100000;
  let maxEquity = equity;
  let maxDrawdown = 0;

  for (let i = 2; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const prev2 = candles[i - 2];

    // ── Update active trade ──
    if (trade) {
      trade.barsHeld++;

      // Check stop loss
      if (trade.side === 'buy') {
        if (c.low <= trade.stop) {
          // Stop hit
          const exitPrice = trade.stop - SLIPPAGE;
          const pnl = (exitPrice - trade.entry) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'stop' });
          equity += pnl;
          trade = null;
          continue;
        }
        // Check take profit
        if (c.high >= trade.target) {
          const pnl = (trade.target - trade.entry) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: trade.target, exitTime: c.timestamp, pnl, reason: 'target' });
          equity += pnl;
          trade = null;
          continue;
        }
        // Trailing stop update
        if (useTrailingStop && trailingTrigger > 0) {
          const profit = c.high - trade.entry;
          if (profit > trade.highWater) trade.highWater = profit;
          if (trade.highWater >= trailingTrigger) {
            trade.trailingActive = true;
            const trailStop = trade.entry + trade.highWater - trailingOffset;
            if (trailStop > trade.stop) trade.stop = trailStop;
          }
        }
      } else {
        // Short
        if (c.high >= trade.stop) {
          const exitPrice = trade.stop + SLIPPAGE;
          const pnl = (trade.entry - exitPrice) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'stop' });
          equity += pnl;
          trade = null;
          continue;
        }
        if (c.low <= trade.target) {
          const pnl = (trade.entry - trade.target) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: trade.target, exitTime: c.timestamp, pnl, reason: 'target' });
          equity += pnl;
          trade = null;
          continue;
        }
        if (useTrailingStop && trailingTrigger > 0) {
          const profit = trade.entry - c.low;
          if (profit > trade.highWater) trade.highWater = profit;
          if (trade.highWater >= trailingTrigger) {
            trade.trailingActive = true;
            const trailStop = trade.entry - trade.highWater + trailingOffset;
            if (trailStop < trade.stop) trade.stop = trailStop;
          }
        }
      }

      // Max hold bars exit
      if (maxHoldBars > 0 && trade.barsHeld >= maxHoldBars) {
        const exitPrice = c.close;
        const pnl = trade.side === 'buy'
          ? (exitPrice - trade.entry) * POINT_VALUE - COMMISSION
          : (trade.entry - exitPrice) * POINT_VALUE - COMMISSION;
        trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'maxhold' });
        equity += pnl;
        trade = null;
        continue;
      }

      // Market close force exit (4pm EST)
      if (isMarketClose(c.timestamp) && !isMarketClose(prev.timestamp)) {
        const exitPrice = c.close;
        const pnl = trade.side === 'buy'
          ? (exitPrice - trade.entry) * POINT_VALUE - COMMISSION
          : (trade.entry - exitPrice) * POINT_VALUE - COMMISSION;
        trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'close' });
        equity += pnl;
        trade = null;
      }

      // Track drawdown
      if (equity > maxEquity) maxEquity = equity;
      const dd = (maxEquity - equity) / maxEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;

      continue; // Can't enter new trade while in one
    }

    // ── Check pending limit order fill ──
    if (pendingOrder) {
      pendingOrder.barsWaited++;

      // Check fill
      let filled = false;
      if (pendingOrder.side === 'buy' && c.low <= pendingOrder.price) {
        trade = {
          side: 'buy',
          entry: pendingOrder.price,
          stop: pendingOrder.stop,
          target: pendingOrder.target,
          entryTime: c.timestamp,
          barsHeld: 0,
          highWater: 0,
          trailingActive: false,
          setup: pendingOrder.setup,
          impulseBody: pendingOrder.impulseBody
        };
        filled = true;
      } else if (pendingOrder.side === 'sell' && c.high >= pendingOrder.price) {
        trade = {
          side: 'sell',
          entry: pendingOrder.price,
          stop: pendingOrder.stop,
          target: pendingOrder.target,
          entryTime: c.timestamp,
          barsHeld: 0,
          highWater: 0,
          trailingActive: false,
          setup: pendingOrder.setup,
          impulseBody: pendingOrder.impulseBody
        };
        filled = true;
      }

      if (filled) {
        pendingOrder = null;
        continue;
      }

      // Timeout
      if (limitOrderTimeout > 0 && pendingOrder.barsWaited >= limitOrderTimeout) {
        pendingOrder = null;
      }
      continue;
    }

    // ── Signal generation ──
    // RTH filter
    if (!isRTH(c.timestamp)) continue;
    if (isInEventWindow(c.timestamp)) continue;

    // Cooldown
    if (c.timestamp - lastSignalTime < cooldownMs) continue;

    // Previous candle is the impulse candidate
    const impulse = prev;
    const bodySize = Math.abs(impulse.close - impulse.open);
    if (bodySize < minBodyPoints) continue;
    if (isInEventWindow(impulse.timestamp)) continue;

    const isBullish = impulse.close > impulse.open;

    // FVG detection: prev2, impulse (prev), current (c)
    const fvg = detectFVG(prev2, impulse, c, fvgMinGapSize);

    if (fvg && fvgEnabled) {
      // FVG Pullback Continuation
      let entryPrice, stopPrice, targetPrice, side;

      if (isBullish && fvg.type === 'bullish') {
        side = 'buy';
        entryPrice = round(fvg.top + fvgPullbackBuffer);
        stopPrice = round(fvg.bottom - fvgStopBuffer);
        targetPrice = round(entryPrice + fvgTargetPoints);
      } else if (!isBullish && fvg.type === 'bearish') {
        side = 'sell';
        entryPrice = round(fvg.bottom - fvgPullbackBuffer);
        stopPrice = round(fvg.top + fvgStopBuffer);
        targetPrice = round(entryPrice - fvgTargetPoints);
      } else {
        continue; // FVG direction mismatch
      }

      const risk = Math.abs(entryPrice - stopPrice);
      if (risk <= 0 || risk > noFvgMaxRisk) continue;

      lastSignalTime = c.timestamp;
      pendingOrder = {
        side, price: entryPrice, stop: stopPrice, target: targetPrice,
        signalTime: c.timestamp, barsWaited: 0,
        setup: 'fvg_pullback', impulseBody: round(bodySize)
      };

    } else if (!fvg && fadeEnabled) {
      // No-FVG Structural Fade
      let entryPrice, stopPrice, targetPrice, side;

      if (isBullish) {
        side = 'sell';
        entryPrice = c.close + SLIPPAGE; // Market sell with slippage
        stopPrice = round(impulse.high + noFvgStopBuffer);
        targetPrice = round(entryPrice - noFvgTargetPoints);
      } else {
        side = 'buy';
        entryPrice = c.close - SLIPPAGE;
        stopPrice = round(impulse.low - noFvgStopBuffer);
        targetPrice = round(entryPrice + noFvgTargetPoints);
      }

      const risk = Math.abs(entryPrice - stopPrice);
      if (risk <= 0 || risk > noFvgMaxRisk) continue;

      lastSignalTime = c.timestamp;
      trade = {
        side, entry: entryPrice, stop: stopPrice, target: targetPrice,
        entryTime: c.timestamp, barsHeld: 0, highWater: 0, trailingActive: false,
        setup: 'no_fvg_fade', impulseBody: round(bodySize)
      };
    }
  }

  // Close any open trade at end
  if (trade) {
    const last = candles[candles.length - 1];
    const pnl = trade.side === 'buy'
      ? (last.close - trade.entry) * POINT_VALUE - COMMISSION
      : (trade.entry - last.close) * POINT_VALUE - COMMISSION;
    trades.push({ ...trade, exit: last.close, exitTime: last.timestamp, pnl, reason: 'end' });
    equity += pnl;
  }

  // Track final drawdown
  if (equity > maxEquity) maxEquity = equity;
  const dd = (maxEquity - equity) / maxEquity;
  if (dd > maxDrawdown) maxDrawdown = dd;

  // Calculate stats
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const wr = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const avgTrade = trades.length > 0 ? totalPnl / trades.length : 0;

  // Setup breakdown
  const fvgTrades = trades.filter(t => t.setup === 'fvg_pullback');
  const fadeTrades = trades.filter(t => t.setup === 'no_fvg_fade');

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(wr, 1),
    profitFactor: round(pf, 2),
    totalPnl: round(totalPnl, 0),
    maxDrawdownPct: round(maxDrawdown * 100, 2),
    avgTrade: round(avgTrade, 0),
    fvgTrades: fvgTrades.length,
    fvgPnl: round(fvgTrades.reduce((s, t) => s + t.pnl, 0), 0),
    fadeTrades: fadeTrades.length,
    fadePnl: round(fadeTrades.reduce((s, t) => s + t.pnl, 0), 0),
    exitBreakdown: {
      stop: trades.filter(t => t.reason === 'stop').length,
      target: trades.filter(t => t.reason === 'target').length,
      maxhold: trades.filter(t => t.reason === 'maxhold').length,
      close: trades.filter(t => t.reason === 'close').length,
    }
  };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('============================================');
  console.log('  Impulse FVG Parameter Sweep');
  console.log(`  Period: ${START} to ${END}`);
  console.log(`  Ticker: ${TICKER}`);
  console.log(`  Mode: ${QUICK ? 'QUICK' : 'FULL'}`);
  console.log('============================================\n');

  // Load data once
  console.log('Loading data...');
  const configPath = path.join(__dirname, '..', 'src', 'config', 'default.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const loader = new CSVLoader(DATA_DIR, config);
  const startMs = new Date(START).getTime();
  const endMs = new Date(END).getTime();

  const { candles: rawCandles } = await loader.loadOHLCVData(TICKER, startMs, endMs);
  const candles = loader.filterPrimaryContract(rawCandles);
  console.log(`Loaded ${candles.length} candles\n`);

  // Ensure output dir
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const results = [];

  function sweep(label, params) {
    const t0 = Date.now();
    const result = runSimulation(candles, params);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const row = { label, ...params, ...result, elapsed };
    results.push(row);

    const pnlStr = result.totalPnl >= 0 ? `+$${result.totalPnl}` : `-$${Math.abs(result.totalPnl)}`;
    console.log(`  ${label.padEnd(35)} | ${String(result.trades).padStart(4)} trades | WR=${String(result.winRate).padStart(5)}% | PF=${String(result.profitFactor).padStart(5)} | ${pnlStr.padStart(8)} | DD=${result.maxDrawdownPct}% | ${elapsed}s`);
  }

  const defaults = {
    minBodyPoints: 20, mode: 'both',
    fvgPullbackBuffer: 2, fvgStopBuffer: 3, fvgTargetPoints: 30, fvgMinGapSize: 2,
    noFvgStopBuffer: 3, noFvgTargetPoints: 20, noFvgMaxRisk: 35,
    trailingTrigger: 15, trailingOffset: 8, useTrailingStop: true,
    maxHoldBars: 60, limitOrderTimeout: 10,
    cooldownMs: 30 * 60 * 1000
  };

  // ── Phase 1: Mode comparison ──
  console.log('=== Phase 1: Mode Comparison ===');
  sweep('both-defaults', { ...defaults, mode: 'both' });
  sweep('fvg-only-defaults', { ...defaults, mode: 'fvg-pullback' });
  sweep('fade-only-defaults', { ...defaults, mode: 'no-fvg-fade' });

  // ── Phase 2: Min body size ──
  console.log('\n=== Phase 2: Min Body Size ===');
  const bodyValues = QUICK ? [15, 20, 30] : [10, 15, 18, 20, 22, 25, 30, 35];
  for (const body of bodyValues) {
    sweep(`fvg-body${body}`, { ...defaults, mode: 'fvg-pullback', minBodyPoints: body });
    sweep(`fade-body${body}`, { ...defaults, mode: 'no-fvg-fade', minBodyPoints: body });
  }

  // ── Phase 3: FVG target points ──
  console.log('\n=== Phase 3: FVG Target Points ===');
  const fvgTargets = QUICK ? [15, 20, 30, 40, 50] : [10, 15, 20, 25, 30, 35, 40, 50, 60];
  for (const tgt of fvgTargets) {
    sweep(`fvg-tgt${tgt}`, { ...defaults, mode: 'fvg-pullback', fvgTargetPoints: tgt });
  }

  // ── Phase 4: No-FVG target points ──
  console.log('\n=== Phase 4: No-FVG Fade Target Points ===');
  const nofvgTargets = QUICK ? [10, 15, 20, 25, 30] : [8, 10, 12, 15, 18, 20, 25, 30, 35];
  for (const tgt of nofvgTargets) {
    sweep(`fade-tgt${tgt}`, { ...defaults, mode: 'no-fvg-fade', noFvgTargetPoints: tgt });
  }

  // ── Phase 5: Trailing stop ──
  console.log('\n=== Phase 5: Trailing Stop ===');
  const triggers = QUICK ? [10, 15, 20] : [8, 10, 12, 15, 20, 25];
  const offsets = QUICK ? [3, 5, 8, 12] : [3, 5, 8, 10, 12, 15];
  for (const trigger of triggers) {
    for (const offset of offsets) {
      if (offset >= trigger) continue;
      sweep(`fvg-trail${trigger}-${offset}`, { ...defaults, mode: 'fvg-pullback', trailingTrigger: trigger, trailingOffset: offset });
    }
  }
  // No trailing comparison
  sweep('fvg-notrail', { ...defaults, mode: 'fvg-pullback', useTrailingStop: false });
  sweep('fade-notrail', { ...defaults, mode: 'no-fvg-fade', useTrailingStop: false });

  // ── Phase 6: Trailing for fade ──
  console.log('\n=== Phase 6: Fade Trailing Stop ===');
  for (const trigger of (QUICK ? [8, 12, 15] : [6, 8, 10, 12, 15, 20])) {
    for (const offset of (QUICK ? [3, 5, 8] : [3, 5, 8, 10])) {
      if (offset >= trigger) continue;
      sweep(`fade-trail${trigger}-${offset}`, { ...defaults, mode: 'no-fvg-fade', trailingTrigger: trigger, trailingOffset: offset });
    }
  }

  // ── Phase 7: Cooldown ──
  console.log('\n=== Phase 7: Cooldown ===');
  const cooldowns = QUICK
    ? [5, 15, 30, 60]
    : [3, 5, 10, 15, 20, 30, 45, 60, 90];
  for (const cd of cooldowns) {
    sweep(`fvg-cd${cd}m`, { ...defaults, mode: 'fvg-pullback', cooldownMs: cd * 60 * 1000 });
    sweep(`fade-cd${cd}m`, { ...defaults, mode: 'no-fvg-fade', cooldownMs: cd * 60 * 1000 });
  }

  // ── Phase 8: Max hold bars ──
  console.log('\n=== Phase 8: Max Hold Bars ===');
  const holdValues = QUICK ? [30, 60, 120] : [15, 30, 45, 60, 90, 120, 180, 0];
  for (const hold of holdValues) {
    sweep(`fvg-hold${hold || 'inf'}`, { ...defaults, mode: 'fvg-pullback', maxHoldBars: hold });
    sweep(`fade-hold${hold || 'inf'}`, { ...defaults, mode: 'no-fvg-fade', maxHoldBars: hold });
  }

  // ── Phase 9: FVG stop buffer / pullback buffer ──
  console.log('\n=== Phase 9: FVG Entry/Stop Buffers ===');
  const stopBuffers = QUICK ? [1, 3, 5] : [0, 1, 2, 3, 5, 8];
  const entryBuffers = QUICK ? [0, 2, 5] : [0, 1, 2, 3, 5, 8];
  for (const sb of stopBuffers) {
    for (const eb of entryBuffers) {
      sweep(`fvg-sb${sb}-eb${eb}`, { ...defaults, mode: 'fvg-pullback', fvgStopBuffer: sb, fvgPullbackBuffer: eb });
    }
  }

  // ── Phase 10: No-FVG stop buffer ──
  console.log('\n=== Phase 10: No-FVG Stop Buffer ===');
  const fadeStopBuffers = QUICK ? [1, 3, 5, 8] : [0, 1, 2, 3, 5, 8, 10, 15];
  for (const sb of fadeStopBuffers) {
    sweep(`fade-sb${sb}`, { ...defaults, mode: 'no-fvg-fade', noFvgStopBuffer: sb });
  }

  // ── Phase 11: No-FVG max risk filter ──
  console.log('\n=== Phase 11: No-FVG Max Risk ===');
  const maxRisks = QUICK ? [20, 25, 30, 35, 50] : [15, 20, 25, 30, 35, 40, 50, 75];
  for (const mr of maxRisks) {
    sweep(`fade-mr${mr}`, { ...defaults, mode: 'no-fvg-fade', noFvgMaxRisk: mr });
  }

  // ── Phase 12: Best combos from each dimension ──
  console.log('\n=== Phase 12: Combined Best Parameters ===');

  // Find best per-dimension
  const fvgResults = results.filter(r => r.mode === 'fvg-pullback' && r.trades >= 50);
  const fadeResults = results.filter(r => r.mode === 'no-fvg-fade' && r.trades >= 50);

  // Sort by PF for candidates
  const bestFvgByPF = [...fvgResults].sort((a, b) => b.profitFactor - a.profitFactor).slice(0, 5);
  const bestFadeByPF = [...fadeResults].sort((a, b) => b.profitFactor - a.profitFactor).slice(0, 5);
  const bestFvgByPnl = [...fvgResults].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 5);
  const bestFadeByPnl = [...fadeResults].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 5);

  console.log('\n  -- Top 5 FVG by PF --');
  for (const r of bestFvgByPF) {
    console.log(`     ${r.label}: PF=${r.profitFactor} WR=${r.winRate}% Trades=${r.trades} P&L=$${r.totalPnl}`);
  }
  console.log('\n  -- Top 5 Fade by PF --');
  for (const r of bestFadeByPF) {
    console.log(`     ${r.label}: PF=${r.profitFactor} WR=${r.winRate}% Trades=${r.trades} P&L=$${r.totalPnl}`);
  }
  console.log('\n  -- Top 5 FVG by P&L --');
  for (const r of bestFvgByPnl) {
    console.log(`     ${r.label}: P&L=$${r.totalPnl} PF=${r.profitFactor} WR=${r.winRate}% Trades=${r.trades}`);
  }
  console.log('\n  -- Top 5 Fade by P&L --');
  for (const r of bestFadeByPnl) {
    console.log(`     ${r.label}: P&L=$${r.totalPnl} PF=${r.profitFactor} WR=${r.winRate}% Trades=${r.trades}`);
  }

  // ── Save CSV ──
  const csvHeader = 'label,mode,minBody,fvgTarget,noFvgTarget,trailTrigger,trailOffset,cooldownMin,maxHold,fvgStopBuf,fvgEntryBuf,noFvgStopBuf,noFvgMaxRisk,trades,wins,losses,winRate,profitFactor,totalPnl,maxDD,avgTrade,fvgTrades,fvgPnl,fadeTrades,fadePnl,stopExits,targetExits,maxholdExits,closeExits';
  const csvRows = results.map(r => [
    r.label, r.mode, r.minBodyPoints,
    r.fvgTargetPoints, r.noFvgTargetPoints,
    r.trailingTrigger, r.trailingOffset,
    Math.round(r.cooldownMs / 60000), r.maxHoldBars,
    r.fvgStopBuffer, r.fvgPullbackBuffer,
    r.noFvgStopBuffer, r.noFvgMaxRisk,
    r.trades, r.wins, r.losses, r.winRate, r.profitFactor,
    r.totalPnl, r.maxDrawdownPct, r.avgTrade,
    r.fvgTrades, r.fvgPnl, r.fadeTrades, r.fadePnl,
    r.exitBreakdown?.stop || 0, r.exitBreakdown?.target || 0,
    r.exitBreakdown?.maxhold || 0, r.exitBreakdown?.close || 0
  ].join(','));

  const csvContent = [csvHeader, ...csvRows].join('\n');
  const csvPath = path.join(OUTPUT_DIR, 'sweep-results.csv');
  fs.writeFileSync(csvPath, csvContent);

  console.log(`\n============================================`);
  console.log(`  Sweep complete! ${results.length} configurations tested`);
  console.log(`  Results saved to: ${csvPath}`);
  console.log(`============================================`);
}

main().catch(console.error);
