#!/usr/bin/env node
/**
 * Momentum Microstructure Strategy — Single-Pass Parameter Matrix
 *
 * Architecture: Signal generators are expensive (rolling buffer + metrics).
 * Exit management is cheap. So we run only N_DETECTION signal generators
 * and fan each signal out to many TradeSimulator instances with different
 * exit params. This keeps the cost at O(N_detect) not O(N_total) per candle.
 *
 * Usage:
 *   cd backtest-engine
 *   node scripts/run-mm-matrix.js [--ticker ES|NQ] [--start DATE] [--end DATE]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { TradeSimulator } from '../src/execution/trade-simulator.js';
import { MomentumMicrostructureStrategy } from '../../shared/strategies/momentum-microstructure.js';

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const ticker = (getArg('ticker', 'ES')).toUpperCase();
const startDateStr = getArg('start', '2021-01-01');
const endDateStr = getArg('end', '2026-01-31');
const outputPath = getArg('output', `results/momentum-microstructure/${ticker}-matrix.json`);

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// ============================================================================
// Matrix Definition — Separates Detection (expensive) from Exits (cheap)
// ============================================================================

function buildMatrix() {
  const isNQ = ticker === 'NQ';

  // Signal generators (expensive — rolling buffer + metrics per candle)
  // Only 4 of these, each run independently
  const detectionProfiles = [
    { label: 'default',    vel: isNQ ? 2.0 : 0.5, vol: 2.0, eff: 0.6, multiWin: false, longOnly: false },
    { label: 'defaultLO',  vel: isNQ ? 2.0 : 0.5, vol: 2.0, eff: 0.6, multiWin: false, longOnly: true },
    { label: 'loose',      vel: isNQ ? 1.2 : 0.3, vol: 1.5, eff: 0.5, multiWin: false, longOnly: false },
    { label: 'looseLO',    vel: isNQ ? 1.2 : 0.3, vol: 1.5, eff: 0.5, multiWin: false, longOnly: true },
  ];

  // Exit configurations (cheap — just TradeSimulator instances)
  // Each detection profile fans out to all of these
  const exitProfiles = isNQ ? [
    { label: 't15s12',       target: 15, stop: 12, trailTrig: null, trailOff: null, maxHold: 300 },
    { label: 't20s15',       target: 20, stop: 15, trailTrig: null, trailOff: null, maxHold: 300 },
    { label: 't20s15tr10o5', target: 20, stop: 15, trailTrig: 10,  trailOff: 5,    maxHold: 300 },
    { label: 't30s20tr15o8', target: 30, stop: 20, trailTrig: 15,  trailOff: 8,    maxHold: 300 },
    { label: 'noTP_s15tr8o4',target: null,stop: 15,trailTrig: 8,   trailOff: 4,    maxHold: 300 },
    { label: 'noTP_s20tr10o5',target:null,stop: 20,trailTrig: 10,  trailOff: 5,    maxHold: 300 },
  ] : [
    // Pure target/stop (no trailing)
    { label: 't3s3',         target: 3,  stop: 3,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't3s4',         target: 3,  stop: 4,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't4s3',         target: 4,  stop: 3,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't4s4',         target: 4,  stop: 4,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't4s5',         target: 4,  stop: 5,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't5s4',         target: 5,  stop: 4,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't5s5',         target: 5,  stop: 5,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't5s6',         target: 5,  stop: 6,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't6s4',         target: 6,  stop: 4,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't6s6',         target: 6,  stop: 6,  trailTrig: null, trailOff: null, maxHold: 120 },
    { label: 't8s6',         target: 8,  stop: 6,  trailTrig: null, trailOff: null, maxHold: 300 },

    // With trailing stop
    { label: 't4s4tr2o1',    target: 4,  stop: 4,  trailTrig: 2,   trailOff: 1,    maxHold: 120 },
    { label: 't5s4tr2o1',    target: 5,  stop: 4,  trailTrig: 2,   trailOff: 1,    maxHold: 120 },
    { label: 't5s5tr3o1',    target: 5,  stop: 5,  trailTrig: 3,   trailOff: 1,    maxHold: 120 },
    { label: 't5s6tr3o1',    target: 5,  stop: 6,  trailTrig: 3,   trailOff: 1,    maxHold: 120 },
    { label: 't6s4tr3o1',    target: 6,  stop: 4,  trailTrig: 3,   trailOff: 1,    maxHold: 120 },
    { label: 't6s5tr3o2',    target: 6,  stop: 5,  trailTrig: 3,   trailOff: 2,    maxHold: 120 },
    { label: 't8s6tr4o2',    target: 8,  stop: 6,  trailTrig: 4,   trailOff: 2,    maxHold: 300 },

    // Trailing-only (no fixed target)
    { label: 'noTP_s3tr2o1', target: null, stop: 3, trailTrig: 2,  trailOff: 1,    maxHold: 120 },
    { label: 'noTP_s4tr2o1', target: null, stop: 4, trailTrig: 2,  trailOff: 1,    maxHold: 120 },
    { label: 'noTP_s4tr3o1', target: null, stop: 4, trailTrig: 3,  trailOff: 1,    maxHold: 120 },
    { label: 'noTP_s5tr3o1', target: null, stop: 5, trailTrig: 3,  trailOff: 1,    maxHold: 120 },
    { label: 'noTP_s6tr3o1', target: null, stop: 6, trailTrig: 3,  trailOff: 1,    maxHold: 300 },
    { label: 'noTP_s6tr4o2', target: null, stop: 6, trailTrig: 4,  trailOff: 2,    maxHold: 300 },
    { label: 'noTP_s8tr4o2', target: null, stop: 8, trailTrig: 4,  trailOff: 2,    maxHold: 300 },

    // Longer hold variants of best-looking configs
    { label: 't4s4_h300',    target: 4,  stop: 4,  trailTrig: null, trailOff: null, maxHold: 300 },
    { label: 't5s4_h300',    target: 5,  stop: 4,  trailTrig: null, trailOff: null, maxHold: 300 },
    { label: 't5s4tr2o1_h300', target: 5, stop: 4, trailTrig: 2,   trailOff: 1,    maxHold: 300 },
    { label: 'noTP_s4tr2o1_h300', target: null, stop: 4, trailTrig: 2, trailOff: 1, maxHold: 300 },
  ];

  // Also add multi-window filtered variants (post-filter signals, not separate detector)
  // These use the same signals from default/loose but only take multi-window ones
  const multiWindowFilter = [false, true]; // true = require windowCount >= 2

  return { detectionProfiles, exitProfiles, multiWindowFilter };
}

// ============================================================================
// Data File / Parsing
// ============================================================================

function getDataFilePath() {
  if (ticker === 'ES') return path.join(dataDir, 'ohlcv/es/ES_ohlcv_1s_continuous.csv');
  return path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1s.csv');
}

function getColumnParser(headerLine) {
  const cols = headerLine.split(',').map(c => c.trim());
  const idx = {};
  cols.forEach((name, i) => { idx[name] = i; });
  return {
    tsIdx: idx['ts_event'] ?? 0,
    openIdx: idx['open'],
    highIdx: idx['high'],
    lowIdx: idx['low'],
    closeIdx: idx['close'],
    volumeIdx: idx['volume'],
    symbolIdx: idx['symbol'],
    minCols: Math.max(idx['open'], idx['high'], idx['low'], idx['close'], idx['volume'], idx['symbol']) + 1
  };
}

class PrimaryContractTracker {
  constructor() {
    this.currentHour = null;
    this.hourVolumes = new Map();
    this.primarySymbol = null;
  }
  processCandle(candle) {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    if (hourKey !== this.currentHour) {
      if (this.currentHour !== null && this.hourVolumes.size > 0) {
        let maxVol = 0;
        for (const [sym, vol] of this.hourVolumes) {
          if (vol > maxVol) { maxVol = vol; this.primarySymbol = sym; }
        }
      }
      this.currentHour = hourKey;
      this.hourVolumes = new Map();
    }
    this.hourVolumes.set(candle.symbol, (this.hourVolumes.get(candle.symbol) || 0) + candle.volume);
    if (!this.primarySymbol) {
      let maxVol = 0;
      for (const [s, v] of this.hourVolumes) {
        if (v > maxVol) { maxVol = v; this.primarySymbol = s; }
      }
    }
    return candle.symbol === this.primarySymbol;
  }
}

// ============================================================================
// Single-Pass Matrix Runner
// ============================================================================

async function runMatrix() {
  const { detectionProfiles, exitProfiles, multiWindowFilter } = buildMatrix();

  // Build configs: detectionProfile x exitProfile x multiWindowFilter
  // But only N_detect strategies run (expensive). The rest is just TradeSimulator (cheap).
  const totalConfigs = detectionProfiles.length * exitProfiles.length * multiWindowFilter.length;
  console.log('='.repeat(80));
  console.log('MOMENTUM MICROSTRUCTURE — PARAMETER MATRIX');
  console.log('='.repeat(80));
  console.log(`Ticker: ${ticker} | ${startDateStr} to ${endDateStr}`);
  console.log(`Detection profiles: ${detectionProfiles.length}`);
  console.log(`Exit profiles: ${exitProfiles.length}`);
  console.log(`Multi-window filter: ${multiWindowFilter.length} variants`);
  console.log(`Total configurations: ${totalConfigs}`);
  console.log();

  const filePath = getDataFilePath();
  if (!fs.existsSync(filePath)) {
    console.error(`Data file not found: ${filePath}`);
    process.exit(1);
  }
  const fileSize = fs.statSync(filePath).size;
  console.log(`File: ${filePath} (${(fileSize / 1e9).toFixed(2)} GB)`);

  const slippageVal = ticker === 'NQ' ? 1.5 : 1.0;

  // Create strategy instances (only N_detect — the expensive part)
  const detectors = detectionProfiles.map(dp => {
    const strategy = new MomentumMicrostructureStrategy({
      velocityThreshold: dp.vel,
      volumeRatioThreshold: dp.vol,
      efficiencyThreshold: dp.eff,
      cooldownSeconds: 30,
      windowSizes: [15, 30, 60],
      requireMultiWindow: dp.multiWin,
      longOnly: dp.longOnly,
      shortOnly: false,
      // Exit params don't matter here — we override per-simulator
      targetPoints: 999, stopPoints: 999,
      trailingTrigger: null, trailingOffset: null,
      maxHoldBars: 9999,
      useSessionFilter: true,
      allowedSessions: ['rth'],
      tradingSymbol: ticker,
      debug: false
    });
    return { label: dp.label, strategy };
  });

  // Create simulator instances: one per (detector x exit x multiWindowFilter)
  const sims = [];
  for (const det of detectors) {
    for (const exit of exitProfiles) {
      for (const mwf of multiWindowFilter) {
        const name = `${det.label}_${exit.label}${mwf ? '_MW' : ''}`;
        const sim = new TradeSimulator({
          commission: 5.0,
          slippage: {
            limitOrderSlippage: 0,
            marketOrderSlippage: slippageVal,
            stopOrderSlippage: slippageVal * 1.5
          },
          contractSpecs: {},
          forceCloseAtMarketClose: true,
          marketCloseTimeUTC: 21
        });
        sims.push({
          name,
          detectorLabel: det.label,
          exitProfile: exit,
          requireMultiWindow: mwf,
          sim,
          equity: 100000,
          equityCurve: [],
          totalSignals: 0,
          rejectedSignals: 0
        });
      }
    }
  }

  // Group sims by detector for efficient signal dispatch
  const simsByDetector = new Map();
  for (const det of detectors) {
    simsByDetector.set(det.label, sims.filter(s => s.detectorLabel === det.label));
  }

  // Stream data
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let colParser = null;
  const isES = ticker === 'ES';
  const contractTracker = isES ? null : new PrimaryContractTracker();

  let totalLines = 0;
  let parsedCandles = 0;
  let skippedInvalid = 0;
  let lastProgressTime = Date.now();
  let lastProgressLines = 0;
  const runStartTime = Date.now();

  for await (const line of rl) {
    if (!colParser) {
      colParser = getColumnParser(line);
      continue;
    }
    totalLines++;

    // Progress
    if (Date.now() - lastProgressTime > 10000) {
      const elapsed = (Date.now() - runStartTime) / 1000;
      const lps = ((totalLines - lastProgressLines) / ((Date.now() - lastProgressTime) / 1000)).toFixed(0);
      const pct = fileStream.bytesRead ? ((fileStream.bytesRead / fileSize) * 100).toFixed(1) : '?';
      const sampleTrades = sims.slice(0, 3).map(s => s.sim.getCompletedTrades().length);
      console.log(`  ${pct}% | ${(totalLines / 1e6).toFixed(1)}M lines | ${lps} l/s | ${elapsed.toFixed(0)}s | sample: [${sampleTrades.join(',')}]`);
      lastProgressTime = Date.now();
      lastProgressLines = totalLines;
    }

    // Parse
    const parts = line.split(',');
    if (parts.length < colParser.minCols) { skippedInvalid++; continue; }

    const timestamp = new Date(parts[colParser.tsIdx]).getTime();
    if (isNaN(timestamp)) { skippedInvalid++; continue; }
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;

    const symbol = parts[colParser.symbolIdx]?.trim();
    if (!isES && symbol && symbol.includes('-')) continue;

    const open = parseFloat(parts[colParser.openIdx]);
    const high = parseFloat(parts[colParser.highIdx]);
    const low = parseFloat(parts[colParser.lowIdx]);
    const close = parseFloat(parts[colParser.closeIdx]);
    const volume = parseInt(parts[colParser.volumeIdx]) || 0;

    if (isNaN(open) || isNaN(close)) { skippedInvalid++; continue; }
    if (open === high && high === low && low === close) { skippedInvalid++; continue; }

    const candle = { timestamp, open, high, low, close, volume, symbol };
    if (!isES && !contractTracker.processCandle(candle)) continue;
    parsedCandles++;

    // 1) Update ALL simulators with current candle (check exits)
    for (const s of sims) {
      if (!s.sim.hasActiveTrades()) continue;
      const updates = s.sim.updateActiveTrades(candle);
      for (const update of updates) {
        if (update.status === 'completed') {
          s.equity += update.netPnL;
          s.equityCurve.push({
            timestamp: update.exitTime,
            equity: s.equity,
            pnl: update.netPnL
          });
        }
      }
    }

    // 2) Run each detector (expensive — but only N_detect times)
    for (const det of detectors) {
      const signal = det.strategy.evaluateSignal(candle, null, null);
      if (!signal) continue;

      // Fan signal out to all simulators for this detector
      const detSims = simsByDetector.get(det.label);
      for (const s of detSims) {
        // Multi-window filter
        if (s.requireMultiWindow && (!signal.metadata?.multiWindow || signal.metadata.windowCount < 2)) {
          continue;
        }

        s.totalSignals++;

        if (s.sim.hasActiveTrades()) {
          s.rejectedSignals++;
          continue;
        }

        // Override exit params from signal to match this sim's config
        const ep = s.exitProfile;
        const customSignal = {
          ...signal,
          stop_loss: signal.side === 'buy'
            ? signal.price - ep.stop
            : signal.price + ep.stop,
          take_profit: ep.target != null
            ? (signal.side === 'buy' ? signal.price + ep.target : signal.price - ep.target)
            : null,
          trailing_trigger: ep.trailTrig,
          trailing_offset: ep.trailOff,
          maxHoldBars: ep.maxHold,
        };

        const order = s.sim.processSignal(customSignal, timestamp);
        if (!order) s.rejectedSignals++;
      }
    }
  }

  const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(1);
  console.log(`\nStreaming complete in ${elapsed}s | ${(parsedCandles / 1e6).toFixed(2)}M candles`);
  console.log(`Detectors: ${detectors.length} | Simulators: ${sims.length}`);

  return { sims, elapsed };
}

// ============================================================================
// Results Compilation & Ranking
// ============================================================================

function compileResults(sims) {
  const results = [];

  for (const s of sims) {
    const trades = s.sim.getCompletedTrades();
    const n = trades.length;

    if (n === 0) {
      results.push({ name: s.name, trades: 0, winRate: 0, totalPnL: 0, profitFactor: 0, avgTrade: 0, avgWin: 0, avgLoss: 0, payoffRatio: 0, maxDD: 0, sharpe: 0, signals: s.totalSignals, longs: 0, shorts: 0, longPnL: 0, shortPnL: 0, longWinRate: 0, shortWinRate: 0, exitBreakdown: {} });
      continue;
    }

    const winners = trades.filter(t => t.netPnL > 0);
    const losers = trades.filter(t => t.netPnL < 0);
    const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
    const grossProfit = winners.reduce((sum, t) => sum + t.netPnL, 0);
    const grossLoss = Math.abs(losers.reduce((sum, t) => sum + t.netPnL, 0));
    const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
    const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    let peak = 100000, maxDD = 0;
    for (const pt of s.equityCurve) {
      if (pt.equity > peak) peak = pt.equity;
      const dd = ((peak - pt.equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    const mean = totalPnL / n;
    const variance = n > 1 ? trades.reduce((sum, t) => sum + (t.netPnL - mean) ** 2, 0) / (n - 1) : 0;
    const stddev = Math.sqrt(variance);
    // Annualize: approximate trading days from trade span
    const firstTs = trades[0].entryTime;
    const lastTs = trades[n - 1].exitTime;
    const spanDays = Math.max(1, (lastTs - firstTs) / (1000 * 60 * 60 * 24));
    const tradesPerDay = n / spanDays;
    const sharpeApprox = stddev > 0 ? (mean / stddev) * Math.sqrt(252 * tradesPerDay) : 0;

    const exitBreakdown = {};
    for (const t of trades) {
      const r = t.exitReason || 'unknown';
      if (!exitBreakdown[r]) exitBreakdown[r] = { count: 0, pnl: 0 };
      exitBreakdown[r].count++;
      exitBreakdown[r].pnl += t.netPnL;
    }

    const longs = trades.filter(t => t.side === 'buy');
    const shorts = trades.filter(t => t.side === 'sell');

    results.push({
      name: s.name,
      trades: n,
      winRate: +((winners.length / n) * 100).toFixed(1),
      totalPnL: +totalPnL.toFixed(2),
      profitFactor: +pf.toFixed(2),
      avgTrade: +(totalPnL / n).toFixed(2),
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      payoffRatio: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : 0,
      maxDD: +maxDD.toFixed(2),
      sharpe: +sharpeApprox.toFixed(2),
      signals: s.totalSignals,
      longs: longs.length,
      shorts: shorts.length,
      longPnL: +longs.reduce((sum, t) => sum + t.netPnL, 0).toFixed(2),
      shortPnL: +shorts.reduce((sum, t) => sum + t.netPnL, 0).toFixed(2),
      longWinRate: longs.length > 0 ? +(longs.filter(t => t.netPnL > 0).length / longs.length * 100).toFixed(1) : 0,
      shortWinRate: shorts.length > 0 ? +(shorts.filter(t => t.netPnL > 0).length / shorts.length * 100).toFixed(1) : 0,
      exitBreakdown
    });
  }

  results.sort((a, b) => b.totalPnL - a.totalPnL);
  return results;
}

function printResults(results) {
  console.log('\n' + '='.repeat(130));
  console.log('PARAMETER MATRIX RESULTS — Sorted by Total P&L');
  console.log('='.repeat(130));

  const hdr = [
    '#'.padStart(3),
    'Config'.padEnd(35),
    'N'.padStart(5),
    'Win%'.padStart(5),
    'PF'.padStart(5),
    'Avg$'.padStart(7),
    'AvgW'.padStart(7),
    'AvgL'.padStart(7),
    'Pay'.padStart(5),
    'Total$'.padStart(10),
    'DD%'.padStart(5),
    'Shrp'.padStart(5),
    'L/S'.padStart(9),
  ].join(' | ');
  console.log(hdr);
  console.log('-'.repeat(130));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.trades === 0) continue;
    const row = [
      String(i + 1).padStart(3),
      r.name.slice(0, 35).padEnd(35),
      String(r.trades).padStart(5),
      r.winRate.toFixed(1).padStart(5),
      (r.profitFactor >= 999 ? 'Inf' : r.profitFactor.toFixed(2)).padStart(5),
      r.avgTrade.toFixed(0).padStart(7),
      r.avgWin.toFixed(0).padStart(7),
      r.avgLoss.toFixed(0).padStart(7),
      r.payoffRatio.toFixed(2).padStart(5),
      r.totalPnL.toFixed(0).padStart(10),
      r.maxDD.toFixed(1).padStart(5),
      r.sharpe.toFixed(2).padStart(5),
      `${r.longs}/${r.shorts}`.padStart(9),
    ].join(' | ');
    console.log(row);
  }

  // Top 10 detailed
  console.log('\n' + '='.repeat(80));
  console.log('TOP 10 DETAILED');
  console.log('='.repeat(80));

  const withTrades = results.filter(r => r.trades > 0);
  for (let i = 0; i < Math.min(10, withTrades.length); i++) {
    const r = withTrades[i];
    console.log(`\n#${i + 1}: ${r.name}`);
    console.log(`  Trades: ${r.trades} | Win: ${r.winRate}% | PF: ${r.profitFactor} | Payoff: ${r.payoffRatio}`);
    console.log(`  Total P&L: $${r.totalPnL.toLocaleString()} | Avg: $${r.avgTrade} | MaxDD: ${r.maxDD}%`);
    console.log(`  Avg Win: $${r.avgWin} | Avg Loss: $${r.avgLoss}`);
    console.log(`  Long: ${r.longs} trades, ${r.longWinRate}% win, $${r.longPnL.toLocaleString()}`);
    console.log(`  Short: ${r.shorts} trades, ${r.shortWinRate}% win, $${r.shortPnL.toLocaleString()}`);
    const exits = Object.entries(r.exitBreakdown)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([reason, data]) => `${reason}: ${data.count} ($${data.pnl.toFixed(0)})`)
      .join(' | ');
    console.log(`  Exits: ${exits}`);
  }

  const profitable = withTrades.filter(r => r.totalPnL > 0);
  console.log(`\n--- Summary ---`);
  console.log(`  Total configs tested: ${results.length}`);
  console.log(`  With trades: ${withTrades.length}`);
  console.log(`  Profitable: ${profitable.length} (${(profitable.length / Math.max(withTrades.length, 1) * 100).toFixed(1)}%)`);
  if (profitable.length > 0) {
    console.log(`  Best: $${profitable[0].totalPnL.toLocaleString()} (${profitable[0].name})`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { sims, elapsed } = await runMatrix();
  const results = compileResults(sims);
  printResults(results);

  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), JSON.stringify({
    metadata: { ticker, startDate: startDateStr, endDate: endDateStr, totalConfigs: results.length, elapsedSeconds: parseFloat(elapsed), generatedAt: new Date().toISOString() },
    results
  }, null, 2));
  console.log(`\nResults written to ${outputPath}`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
