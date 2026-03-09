#!/usr/bin/env node
/**
 * Impulse FVG - Combined Best Parameters Sweep
 *
 * Takes the best values from each dimension and tests combinations.
 * Focus: No-FVG Fade (the clear winner from Phase 1 sweep)
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
const START = getArg('start', '2023-06-01');
const END = getArg('end', '2025-12-25');

const COMMISSION = 5.0;
const POINT_VALUE = 20.0;
const SLIPPAGE = 1.0;

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
  return m >= 16 * 60 || m < 4 * 60;
}

function detectFVG(c0, c1, c2, minGap) {
  if (!c0 || !c1 || !c2) return null;
  const bullGap = c2.low - c0.high;
  const bearGap = c0.low - c2.high;
  if (bullGap >= minGap) return { type: 'bullish' };
  if (bearGap >= minGap) return { type: 'bearish' };
  return null;
}

function round(v, d = 2) { return Math.round(v * 10 ** d) / 10 ** d; }

function runFadeSimulation(candles, params) {
  const {
    minBodyPoints, noFvgStopBuffer, noFvgTargetPoints, noFvgMaxRisk,
    trailingTrigger, trailingOffset, useTrailingStop,
    maxHoldBars, cooldownMs
  } = params;

  let lastSignalTime = 0;
  let trade = null;
  let trades = [];
  let equity = 100000;
  let maxEquity = equity;
  let maxDrawdown = 0;
  let peakEquity = equity;
  let equityCurve = [];

  for (let i = 2; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const prev2 = candles[i - 2];

    if (trade) {
      trade.barsHeld++;

      if (trade.side === 'buy') {
        if (c.low <= trade.stop) {
          const exitPrice = trade.stop - SLIPPAGE;
          const pnl = (exitPrice - trade.entry) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'stop' });
          equity += pnl;
          trade = null;
        } else if (c.high >= trade.target) {
          const pnl = (trade.target - trade.entry) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: trade.target, exitTime: c.timestamp, pnl, reason: 'target' });
          equity += pnl;
          trade = null;
        } else {
          if (useTrailingStop && trailingTrigger > 0) {
            const profit = c.high - trade.entry;
            if (profit > trade.highWater) trade.highWater = profit;
            if (trade.highWater >= trailingTrigger) {
              const trailStop = trade.entry + trade.highWater - trailingOffset;
              if (trailStop > trade.stop) trade.stop = trailStop;
            }
          }
          if (maxHoldBars > 0 && trade.barsHeld >= maxHoldBars) {
            const pnl = (c.close - trade.entry) * POINT_VALUE - COMMISSION;
            trades.push({ ...trade, exit: c.close, exitTime: c.timestamp, pnl, reason: 'maxhold' });
            equity += pnl;
            trade = null;
          } else if (isMarketClose(c.timestamp) && !isMarketClose(prev.timestamp)) {
            const pnl = (c.close - trade.entry) * POINT_VALUE - COMMISSION;
            trades.push({ ...trade, exit: c.close, exitTime: c.timestamp, pnl, reason: 'close' });
            equity += pnl;
            trade = null;
          }
        }
      } else {
        if (c.high >= trade.stop) {
          const exitPrice = trade.stop + SLIPPAGE;
          const pnl = (trade.entry - exitPrice) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: exitPrice, exitTime: c.timestamp, pnl, reason: 'stop' });
          equity += pnl;
          trade = null;
        } else if (c.low <= trade.target) {
          const pnl = (trade.entry - trade.target) * POINT_VALUE - COMMISSION;
          trades.push({ ...trade, exit: trade.target, exitTime: c.timestamp, pnl, reason: 'target' });
          equity += pnl;
          trade = null;
        } else {
          if (useTrailingStop && trailingTrigger > 0) {
            const profit = trade.entry - c.low;
            if (profit > trade.highWater) trade.highWater = profit;
            if (trade.highWater >= trailingTrigger) {
              const trailStop = trade.entry - trade.highWater + trailingOffset;
              if (trailStop < trade.stop) trade.stop = trailStop;
            }
          }
          if (maxHoldBars > 0 && trade.barsHeld >= maxHoldBars) {
            const pnl = (trade.entry - c.close) * POINT_VALUE - COMMISSION;
            trades.push({ ...trade, exit: c.close, exitTime: c.timestamp, pnl, reason: 'maxhold' });
            equity += pnl;
            trade = null;
          } else if (isMarketClose(c.timestamp) && !isMarketClose(prev.timestamp)) {
            const pnl = (trade.entry - c.close) * POINT_VALUE - COMMISSION;
            trades.push({ ...trade, exit: c.close, exitTime: c.timestamp, pnl, reason: 'close' });
            equity += pnl;
            trade = null;
          }
        }
      }

      if (equity > maxEquity) maxEquity = equity;
      const dd = (maxEquity - equity) / maxEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;
      continue;
    }

    if (!isRTH(c.timestamp)) continue;
    if (isInEventWindow(c.timestamp)) continue;
    if (c.timestamp - lastSignalTime < cooldownMs) continue;

    const impulse = prev;
    const bodySize = Math.abs(impulse.close - impulse.open);
    if (bodySize < minBodyPoints) continue;
    if (isInEventWindow(impulse.timestamp)) continue;

    const isBullish = impulse.close > impulse.open;
    const fvg = detectFVG(prev2, impulse, c, 2);
    if (fvg) continue; // Only no-FVG fades

    let entryPrice, stopPrice, targetPrice, side;
    if (isBullish) {
      side = 'sell';
      entryPrice = c.close + SLIPPAGE;
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
      entryTime: c.timestamp, barsHeld: 0, highWater: 0,
      impulseBody: round(bodySize)
    };
  }

  if (trade) {
    const last = candles[candles.length - 1];
    const pnl = trade.side === 'buy'
      ? (last.close - trade.entry) * POINT_VALUE - COMMISSION
      : (trade.entry - last.close) * POINT_VALUE - COMMISSION;
    trades.push({ ...trade, exit: last.close, exitTime: last.timestamp, pnl, reason: 'end' });
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
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: round(wr, 1), profitFactor: round(pf, 2),
    totalPnl: round(totalPnl, 0), maxDrawdownPct: round(maxDrawdown * 100, 2),
    avgTrade: round(avgTrade, 0), avgWin: round(avgWin, 0), avgLoss: round(avgLoss, 0),
    tradeList: trades
  };
}

async function main() {
  console.log('============================================');
  console.log('  Impulse FVG - Best Combo Sweep (Fade)');
  console.log(`  Period: ${START} to ${END}`);
  console.log('============================================\n');

  const configPath = path.join(__dirname, '..', 'src', 'config', 'default.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const loader = new CSVLoader(DATA_DIR, config);
  const { candles: rawCandles } = await loader.loadOHLCVData('NQ', new Date(START).getTime(), new Date(END).getTime());
  const candles = loader.filterPrimaryContract(rawCandles);
  console.log(`Loaded ${candles.length} candles\n`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const results = [];

  function sweep(label, params) {
    const result = runFadeSimulation(candles, params);
    results.push({ label, ...params, ...result });
    const pnlStr = result.totalPnl >= 0 ? `+$${result.totalPnl}` : `-$${Math.abs(result.totalPnl)}`;
    console.log(`  ${label.padEnd(40)} | ${String(result.trades).padStart(4)} | WR=${String(result.winRate).padStart(5)}% | PF=${String(result.profitFactor).padStart(5)} | ${pnlStr.padStart(9)} | DD=${result.maxDrawdownPct}% | avg=$${result.avgTrade}`);
  }

  // Best individual values from full sweep:
  // trail: (6,3) PF=2.31, (8,3) PF=2.02
  // body: 20 (PF=1.52, most trades), 25 (PF=1.54, fewer trades)
  // target: 30-35 (PF=1.61-1.64)
  // cooldown: 5m ($97K P&L), 3m ($106K P&L), 20m (PF=1.50)
  // stop buffer: 0-2 (PF=1.59-1.60)
  // max risk: 35-40 (PF=1.52-1.56)

  console.log('=== Combined Best: Tight trail + optimal targets ===');
  for (const trail of [[6, 3], [8, 3], [8, 5], [10, 3]]) {
    for (const target of [25, 30, 35]) {
      for (const cd of [5, 10, 20, 30]) {
        sweep(
          `trail${trail[0]}-${trail[1]}_tgt${target}_cd${cd}m`,
          {
            minBodyPoints: 20, noFvgStopBuffer: 2, noFvgTargetPoints: target,
            noFvgMaxRisk: 40, trailingTrigger: trail[0], trailingOffset: trail[1],
            useTrailingStop: true, maxHoldBars: 60, cooldownMs: cd * 60 * 1000
          }
        );
      }
    }
  }

  console.log('\n=== Body size + best trailing ===');
  for (const body of [18, 20, 22, 25]) {
    for (const trail of [[6, 3], [8, 3]]) {
      sweep(
        `body${body}_trail${trail[0]}-${trail[1]}_tgt30`,
        {
          minBodyPoints: body, noFvgStopBuffer: 2, noFvgTargetPoints: 30,
          noFvgMaxRisk: 40, trailingTrigger: trail[0], trailingOffset: trail[1],
          useTrailingStop: true, maxHoldBars: 60, cooldownMs: 20 * 60 * 1000
        }
      );
    }
  }

  console.log('\n=== Top 20 Overall (by PF, min 200 trades) ===');
  const qualified = results.filter(r => r.trades >= 200);
  const topByPF = [...qualified].sort((a, b) => b.profitFactor - a.profitFactor).slice(0, 20);
  console.log('  Rank | Label                                     | Trades | WR     | PF    | P&L       | DD     | AvgW   | AvgL');
  topByPF.forEach((r, i) => {
    const pnl = r.totalPnl >= 0 ? `+$${r.totalPnl}` : `-$${Math.abs(r.totalPnl)}`;
    console.log(`  ${String(i + 1).padStart(4)} | ${r.label.padEnd(45)} | ${String(r.trades).padStart(6)} | ${String(r.winRate).padStart(5)}% | ${String(r.profitFactor).padStart(5)} | ${pnl.padStart(9)} | ${String(r.maxDrawdownPct).padStart(5)}% | $${String(r.avgWin).padStart(4)} | $${String(r.avgLoss).padStart(5)}`);
  });

  console.log('\n=== Top 10 by P&L (min 200 trades) ===');
  const topByPnl = [...qualified].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 10);
  topByPnl.forEach((r, i) => {
    const pnl = r.totalPnl >= 0 ? `+$${r.totalPnl}` : `-$${Math.abs(r.totalPnl)}`;
    console.log(`  ${String(i + 1).padStart(4)} | ${r.label.padEnd(45)} | ${String(r.trades).padStart(6)} | ${String(r.winRate).padStart(5)}% | ${String(r.profitFactor).padStart(5)} | ${pnl.padStart(9)} | ${String(r.maxDrawdownPct).padStart(5)}%`);
  });

  // Save CSV
  const csvHeader = 'label,body,stopBuf,target,maxRisk,trailTrig,trailOff,cooldownMin,trades,wins,losses,winRate,pf,totalPnl,maxDD,avgTrade,avgWin,avgLoss';
  const csvRows = results.map(r => [
    r.label, r.minBodyPoints, r.noFvgStopBuffer, r.noFvgTargetPoints,
    r.noFvgMaxRisk, r.trailingTrigger, r.trailingOffset,
    Math.round(r.cooldownMs / 60000),
    r.trades, r.wins, r.losses, r.winRate, r.profitFactor,
    r.totalPnl, r.maxDrawdownPct, r.avgTrade, r.avgWin, r.avgLoss
  ].join(','));
  const csv = [csvHeader, ...csvRows].join('\n');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'best-combo-results.csv'), csv);

  // Save the absolute best config's trade list for equity curve analysis
  const best = topByPF[0];
  if (best && best.tradeList) {
    const tradeCSV = ['timestamp,side,entry,exit,pnl,reason,impulseBody']
      .concat(best.tradeList.map(t => [
        new Date(t.entryTime).toISOString(),
        t.side, round(t.entry), round(t.exit), round(t.pnl),
        t.reason, t.impulseBody
      ].join(',')))
      .join('\n');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'best-trades.csv'), tradeCSV);
    console.log(`\n  Best config trade log saved to: output/sweeps/impulse-fvg/best-trades.csv`);
  }

  console.log(`\n  Results CSV saved to: output/sweeps/impulse-fvg/best-combo-results.csv`);
}

main().catch(console.error);
