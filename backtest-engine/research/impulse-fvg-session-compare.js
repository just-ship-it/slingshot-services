#!/usr/bin/env node
/**
 * Impulse FVG Session Comparison
 *
 * Compares the sweep-optimized No-FVG Fade strategy across different sessions:
 * RTH only, overnight only, premarket only, and all sessions combined.
 *
 * Usage:
 *   node research/impulse-fvg-session-compare.js
 */

import fs from 'fs';
import path from 'path';
import { CSVLoader } from '../src/data/csv-loader.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, 'output', 'sweeps', 'impulse-fvg');

const START = '2023-06-01';
const END = '2025-12-25';
const TICKER = 'NQ';
const COMMISSION = 5.0;
const POINT_VALUE = 20.0;
const SLIPPAGE = 1.0;

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

function getSession(ts) {
  const m = getETMinutes(ts);
  if (m >= 18 * 60 || m < 4 * 60) return 'overnight';
  if (m >= 4 * 60 && m < 9 * 60 + 30) return 'premarket';
  if (m >= 9 * 60 + 30 && m < 16 * 60) return 'rth';
  return 'afterhours';
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

// ── Trade Simulation (with session filter param) ─────────────
function runSimulation(candles, params) {
  const {
    minBodyPoints, noFvgStopBuffer, noFvgTargetPoints, noFvgMaxRisk,
    trailingTrigger, trailingOffset, maxHoldBars, cooldownMs,
    fvgMinGapSize, allowedSessions
  } = params;

  let lastSignalTime = 0;
  let trade = null;
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

      if (trade.side === 'buy') {
        if (c.low <= trade.stop) {
          const exitPrice = trade.stop - SLIPPAGE;
          const pnl = (exitPrice - trade.entry) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'stop', session: trade.session });
          equity += pnl;
          trade = null;
          if (equity > maxEquity) maxEquity = equity;
          const dd = (maxEquity - equity) / maxEquity;
          if (dd > maxDrawdown) maxDrawdown = dd;
          continue;
        }
        if (c.high >= trade.target) {
          const pnl = (trade.target - trade.entry) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: trade.target, exitTime: c.timestamp, pnl, reason: 'target', session: trade.session });
          equity += pnl;
          trade = null;
          if (equity > maxEquity) maxEquity = equity;
          const dd = (maxEquity - equity) / maxEquity;
          if (dd > maxDrawdown) maxDrawdown = dd;
          continue;
        }
        if (trailingTrigger > 0) {
          const profit = c.high - trade.entry;
          if (profit > trade.highWater) trade.highWater = profit;
          if (trade.highWater >= trailingTrigger) {
            const trailStop = trade.entry + trade.highWater - trailingOffset;
            if (trailStop > trade.stop) trade.stop = trailStop;
          }
        }
      } else {
        if (c.high >= trade.stop) {
          const exitPrice = trade.stop + SLIPPAGE;
          const pnl = (trade.entry - exitPrice) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'stop', session: trade.session });
          equity += pnl;
          trade = null;
          if (equity > maxEquity) maxEquity = equity;
          const dd = (maxEquity - equity) / maxEquity;
          if (dd > maxDrawdown) maxDrawdown = dd;
          continue;
        }
        if (c.low <= trade.target) {
          const pnl = (trade.entry - trade.target) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: trade.target, exitTime: c.timestamp, pnl, reason: 'target', session: trade.session });
          equity += pnl;
          trade = null;
          if (equity > maxEquity) maxEquity = equity;
          const dd = (maxEquity - equity) / maxEquity;
          if (dd > maxDrawdown) maxDrawdown = dd;
          continue;
        }
        if (trailingTrigger > 0) {
          const profit = trade.entry - c.low;
          if (profit > trade.highWater) trade.highWater = profit;
          if (trade.highWater >= trailingTrigger) {
            const trailStop = trade.entry - trade.highWater + trailingOffset;
            if (trailStop < trade.stop) trade.stop = trailStop;
          }
        }
      }

      if (maxHoldBars > 0 && trade.barsHeld >= maxHoldBars) {
        const exitPrice = c.close;
        const pnl = trade.side === 'buy'
          ? (exitPrice - trade.entry) * POINT_VALUE - COMMISSION
          : (trade.entry - exitPrice) * POINT_VALUE - COMMISSION;
        trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'maxhold', session: trade.session });
        equity += pnl;
        trade = null;
      }

      if (equity > maxEquity) maxEquity = equity;
      const dd = (maxEquity - equity) / maxEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;

      continue;
    }

    // ── Signal generation ──
    const session = getSession(c.timestamp);
    if (!allowedSessions.includes(session)) continue;
    if (isInEventWindow(c.timestamp)) continue;
    if (c.timestamp - lastSignalTime < cooldownMs) continue;

    const impulse = prev;
    const bodySize = Math.abs(impulse.close - impulse.open);
    if (bodySize < minBodyPoints) continue;
    if (isInEventWindow(impulse.timestamp)) continue;

    const isBullish = impulse.close > impulse.open;
    const fvg = detectFVG(prev2, impulse, c, fvgMinGapSize);

    // No-FVG Fade only
    if (fvg) continue;

    let entryPrice, stopPrice, targetPrice, side;
    if (isBullish) {
      side = 'sell';
      entryPrice = c.close + SLIPPAGE;
      if (entryPrice >= impulse.high) continue; // Impulse continuing, not failing
      stopPrice = round(impulse.high + noFvgStopBuffer);
      targetPrice = round(entryPrice - noFvgTargetPoints);
    } else {
      side = 'buy';
      entryPrice = c.close - SLIPPAGE;
      if (entryPrice <= impulse.low) continue; // Impulse continuing, not failing
      stopPrice = round(impulse.low - noFvgStopBuffer);
      targetPrice = round(entryPrice + noFvgTargetPoints);
    }

    const risk = Math.abs(entryPrice - stopPrice);
    if (risk <= 0 || risk > noFvgMaxRisk) continue;

    lastSignalTime = c.timestamp;
    trade = {
      side, entry: entryPrice, stop: stopPrice, target: targetPrice,
      entryTime: c.timestamp, barsHeld: 0, highWater: 0,
      impulseBody: round(bodySize), session
    };
  }

  // Close any open trade
  if (trade) {
    const last = candles[candles.length - 1];
    const pnl = trade.side === 'buy'
      ? (last.close - trade.entry) * POINT_VALUE - COMMISSION
      : (trade.entry - last.close) * POINT_VALUE - COMMISSION;
    trades.push({ ...trade, exit: last.close, exitTime: last.timestamp, pnl, reason: 'end', session: trade.session });
    equity += pnl;
  }

  if (equity > maxEquity) maxEquity = equity;
  const dd = (maxEquity - equity) / maxEquity;
  if (dd > maxDrawdown) maxDrawdown = dd;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const wr = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const avgTrade = trades.length > 0 ? totalPnl / trades.length : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? -grossLoss / losses.length : 0;

  // Session breakdown
  const sessionBreakdown = {};
  for (const t of trades) {
    const s = t.session || 'unknown';
    if (!sessionBreakdown[s]) sessionBreakdown[s] = { trades: 0, wins: 0, pnl: 0 };
    sessionBreakdown[s].trades++;
    if (t.pnl > 0) sessionBreakdown[s].wins++;
    sessionBreakdown[s].pnl += t.pnl;
  }

  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: round(wr, 1), profitFactor: round(pf, 2),
    totalPnl: round(totalPnl, 0), maxDrawdownPct: round(maxDrawdown * 100, 2),
    avgTrade: round(avgTrade, 0), avgWin: round(avgWin, 0), avgLoss: round(avgLoss, 0),
    exitBreakdown: {
      stop: trades.filter(t => t.reason === 'stop').length,
      target: trades.filter(t => t.reason === 'target').length,
      maxhold: trades.filter(t => t.reason === 'maxhold').length,
    },
    sessionBreakdown
  };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('============================================');
  console.log('  Impulse FVG Session Comparison');
  console.log(`  Period: ${START} to ${END}`);
  console.log(`  Ticker: ${TICKER}`);
  console.log('============================================\n');

  console.log('Loading data...');
  const configPath = path.join(__dirname, '..', 'src', 'config', 'default.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const loader = new CSVLoader(DATA_DIR, config);
  const startMs = new Date(START).getTime();
  const endMs = new Date(END).getTime();

  const { candles: rawCandles } = await loader.loadOHLCVData(TICKER, startMs, endMs);
  const candles = loader.filterPrimaryContract(rawCandles);
  console.log(`Loaded ${candles.length} candles\n`);

  const optimized = {
    minBodyPoints: 20, noFvgStopBuffer: 2, noFvgTargetPoints: 30, noFvgMaxRisk: 40,
    trailingTrigger: 6, trailingOffset: 3, maxHoldBars: 60,
    cooldownMs: 20 * 60 * 1000, fvgMinGapSize: 2,
  };

  const sessionConfigs = [
    { label: 'RTH only',                sessions: ['rth'] },
    { label: 'Overnight only',          sessions: ['overnight'] },
    { label: 'Premarket only',          sessions: ['premarket'] },
    { label: 'Afterhours only',         sessions: ['afterhours'] },
    { label: 'Overnight + Premarket',   sessions: ['overnight', 'premarket'] },
    { label: 'RTH + Premarket',         sessions: ['rth', 'premarket'] },
    { label: 'All sessions',            sessions: ['overnight', 'premarket', 'rth', 'afterhours'] },
  ];

  console.log('=== Session Comparison (optimized fade params: trail 6/3, target 30, stopBuf 2, cd 20m) ===\n');
  console.log('  ' + 'Session'.padEnd(25) + 'Trades   WR%     PF     P&L        MaxDD    Avg     AvgW   AvgL');
  console.log('  ' + '-'.repeat(95));

  const results = [];

  for (const sc of sessionConfigs) {
    const params = { ...optimized, allowedSessions: sc.sessions };
    const result = runSimulation(candles, params);
    results.push({ label: sc.label, sessions: sc.sessions.join('+'), ...result });

    const pnlStr = result.totalPnl >= 0 ? `+$${result.totalPnl.toLocaleString()}` : `-$${Math.abs(result.totalPnl).toLocaleString()}`;
    console.log(
      '  ' + sc.label.padEnd(25) +
      String(result.trades).padStart(5) +
      (result.winRate + '%').padStart(8) +
      String(result.profitFactor).padStart(7) +
      pnlStr.padStart(12) +
      (result.maxDrawdownPct + '%').padStart(9) +
      ('$' + result.avgTrade).padStart(7) +
      ('$' + result.avgWin).padStart(7) +
      ('$' + result.avgLoss).padStart(7)
    );
  }

  // Detailed session breakdown for the "all sessions" run
  console.log('\n=== Per-Session Breakdown (All Sessions run) ===\n');
  const allResult = results.find(r => r.label === 'All sessions');
  if (allResult?.sessionBreakdown) {
    for (const [session, data] of Object.entries(allResult.sessionBreakdown)) {
      const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0.0';
      const avg = data.trades > 0 ? Math.round(data.pnl / data.trades) : 0;
      const pnlStr = data.pnl >= 0 ? `+$${Math.round(data.pnl).toLocaleString()}` : `-$${Math.abs(Math.round(data.pnl)).toLocaleString()}`;
      console.log(`  ${session.padEnd(15)} ${String(data.trades).padStart(5)} trades   WR=${wr}%   P&L=${pnlStr}   Avg=$${avg}`);
    }
  }

  // Cooldown sweep for overnight
  console.log('\n=== Overnight Cooldown Sweep ===\n');
  console.log('  ' + 'Cooldown'.padEnd(15) + 'Trades   WR%     PF     P&L        MaxDD    Avg');
  console.log('  ' + '-'.repeat(75));

  for (const cd of [5, 10, 15, 20, 30, 45, 60]) {
    const params = { ...optimized, allowedSessions: ['overnight'], cooldownMs: cd * 60 * 1000 };
    const result = runSimulation(candles, params);
    const pnlStr = result.totalPnl >= 0 ? `+$${result.totalPnl.toLocaleString()}` : `-$${Math.abs(result.totalPnl).toLocaleString()}`;
    console.log(
      '  ' + `${cd}m`.padEnd(15) +
      String(result.trades).padStart(5) +
      (result.winRate + '%').padStart(8) +
      String(result.profitFactor).padStart(7) +
      pnlStr.padStart(12) +
      (result.maxDrawdownPct + '%').padStart(9) +
      ('$' + result.avgTrade).padStart(7)
    );
  }

  // Trailing stop sweep for overnight
  console.log('\n=== Overnight Trailing Stop Sweep ===\n');
  console.log('  ' + 'Trail'.padEnd(15) + 'Trades   WR%     PF     P&L        MaxDD    Avg');
  console.log('  ' + '-'.repeat(75));

  for (const [trig, off] of [[6,3],[8,3],[8,5],[10,3],[10,5],[12,5],[15,8],[0,0]]) {
    const label = trig === 0 ? 'No trail' : `${trig}/${off}`;
    const params = {
      ...optimized, allowedSessions: ['overnight'],
      trailingTrigger: trig, trailingOffset: off
    };
    const result = runSimulation(candles, params);
    const pnlStr = result.totalPnl >= 0 ? `+$${result.totalPnl.toLocaleString()}` : `-$${Math.abs(result.totalPnl).toLocaleString()}`;
    console.log(
      '  ' + label.padEnd(15) +
      String(result.trades).padStart(5) +
      (result.winRate + '%').padStart(8) +
      String(result.profitFactor).padStart(7) +
      pnlStr.padStart(12) +
      (result.maxDrawdownPct + '%').padStart(9) +
      ('$' + result.avgTrade).padStart(7)
    );
  }

  // Body size sweep for overnight
  console.log('\n=== Overnight Min Body Size Sweep ===\n');
  console.log('  ' + 'Body'.padEnd(15) + 'Trades   WR%     PF     P&L        MaxDD    Avg');
  console.log('  ' + '-'.repeat(75));

  for (const body of [10, 15, 18, 20, 25, 30]) {
    const params = { ...optimized, allowedSessions: ['overnight'], minBodyPoints: body };
    const result = runSimulation(candles, params);
    const pnlStr = result.totalPnl >= 0 ? `+$${result.totalPnl.toLocaleString()}` : `-$${Math.abs(result.totalPnl).toLocaleString()}`;
    console.log(
      '  ' + `>=${body}pt`.padEnd(15) +
      String(result.trades).padStart(5) +
      (result.winRate + '%').padStart(8) +
      String(result.profitFactor).padStart(7) +
      pnlStr.padStart(12) +
      (result.maxDrawdownPct + '%').padStart(9) +
      ('$' + result.avgTrade).padStart(7)
    );
  }

  console.log('\n============================================');
  console.log('  Session comparison complete!');
  console.log('============================================');
}

main().catch(console.error);
