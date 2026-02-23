#!/usr/bin/env node
/**
 * Momentum Microstructure Strategy - Standalone Streaming Backtest Runner
 *
 * Runs the MomentumMicrostructureStrategy on 1-second candle data with
 * realistic order execution via TradeSimulator, then reports comprehensive
 * performance metrics via PerformanceCalculator and ConsoleReporter.
 *
 * Why standalone (not via the main engine)?
 * The backtest engine evaluates strategies on aggregated candles (1m/15m) at
 * candle close. This strategy evaluates on EVERY 1-second tick within a rolling
 * window — a fundamentally different loop. Modifying the engine's main loop
 * would be invasive. Instead, we reuse TradeSimulator + PerformanceCalculator
 * as components.
 *
 * Usage:
 *   cd backtest-engine
 *   node scripts/run-momentum-microstructure-backtest.js [options]
 *
 * Options:
 *   --ticker ES|NQ              Ticker (default: ES)
 *   --start YYYY-MM-DD          Start date (default: 2021-01-01)
 *   --end YYYY-MM-DD            End date (default: 2026-01-31)
 *   --velocity-threshold N      Min pts/sec for velocity
 *   --volume-ratio N            Volume surge vs baseline (default: 2.0)
 *   --efficiency-threshold N    Min move efficiency 0-1 (default: 0.6)
 *   --cooldown N                Seconds between signals (default: 30)
 *   --windows N,N,N             Window sizes in seconds (default: 15,30,60)
 *   --target N                  Target profit in points
 *   --stop N                    Stop loss in points
 *   --trailing-trigger N        Trailing stop trigger in points
 *   --trailing-offset N         Trailing stop offset in points
 *   --max-hold N                Max hold time in 1s bars (default: 300)
 *   --require-multi-window      Only take multi-window signals
 *   --long-only                 Only take long signals
 *   --short-only                Only take short signals
 *   --sessions S,S              Allowed sessions (rth,premarket,overnight,afterhours)
 *   --no-session-filter         Disable session filtering
 *   --commission N              Round-trip commission (default: 5.0)
 *   --slippage N                Market order slippage (default: 1.0)
 *   --initial-capital N         Starting capital (default: 100000)
 *   --output FILE               Output JSON path
 *   --output-csv FILE           Trade-by-trade CSV output
 *   --verbose                   Print each trade as it completes
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { TradeSimulator } from '../src/execution/trade-simulator.js';
import { PerformanceCalculator } from '../src/analytics/performance-calculator.js';
import { MomentumMicrostructureStrategy } from '../../shared/strategies/momentum-microstructure.js';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};
const hasFlag = (name) => args.includes(`--${name}`);

if (hasFlag('help') || hasFlag('h')) {
  console.log(`
Momentum Microstructure Strategy - Backtest Runner

Usage: node scripts/run-momentum-microstructure-backtest.js [options]

Detection Parameters:
  --ticker ES|NQ              Ticker symbol (default: ES)
  --start YYYY-MM-DD          Start date (default: 2021-01-01)
  --end YYYY-MM-DD            End date (default: 2026-01-31)
  --velocity-threshold N      Min pts/sec velocity
  --volume-ratio N            Volume surge vs 300s baseline (default: 2.0)
  --efficiency-threshold N    Min move efficiency 0-1 (default: 0.6)
  --cooldown N                Seconds between signals (default: 30)
  --windows N,N,N             Window sizes in seconds (default: 15,30,60)

Exit Parameters:
  --target N                  Target profit points
  --stop N                    Stop loss points
  --trailing-trigger N        Trailing trigger points
  --trailing-offset N         Trailing offset points
  --max-hold N                Max hold in 1s bars (default: 300)

Filters:
  --require-multi-window      Only multi-window signals (higher quality)
  --long-only                 Long signals only
  --short-only                Short signals only
  --sessions S,S              Allowed sessions (default: rth)
  --no-session-filter         Trade all sessions

Execution:
  --commission N              Round-trip commission (default: 5.0)
  --slippage N                Market order slippage (default: 1.0)
  --initial-capital N         Starting capital (default: 100000)

Output:
  --output FILE               JSON results path
  --output-csv FILE           Trade-by-trade CSV
  --verbose                   Print each trade
  `);
  process.exit(0);
}

const ticker = (getArg('ticker', 'ES')).toUpperCase();
const startDateStr = getArg('start', '2021-01-01');
const endDateStr = getArg('end', '2026-01-31');

const VELOCITY_DEFAULTS = { ES: 0.5, NQ: 2.0 };
const TARGET_DEFAULTS = { ES: 8, NQ: 30 };
const STOP_DEFAULTS = { ES: 6, NQ: 20 };
const TRAIL_TRIGGER_DEFAULTS = { ES: 4, NQ: 15 };
const TRAIL_OFFSET_DEFAULTS = { ES: 2, NQ: 8 };

const velocityThreshold = parseFloat(getArg('velocity-threshold', VELOCITY_DEFAULTS[ticker] || 0.5));
const volumeRatioThreshold = parseFloat(getArg('volume-ratio', '2.0'));
const efficiencyThreshold = parseFloat(getArg('efficiency-threshold', '0.6'));
const cooldownSeconds = parseInt(getArg('cooldown', '30'));
const windowSizes = getArg('windows', '15,30,60').split(',').map(Number);

const targetPoints = parseFloat(getArg('target', TARGET_DEFAULTS[ticker] || 8));
const stopPoints = parseFloat(getArg('stop', STOP_DEFAULTS[ticker] || 6));
const trailingTrigger = parseFloat(getArg('trailing-trigger', TRAIL_TRIGGER_DEFAULTS[ticker] || 4));
const trailingOffset = parseFloat(getArg('trailing-offset', TRAIL_OFFSET_DEFAULTS[ticker] || 2));
const maxHoldBars = parseInt(getArg('max-hold', '300'));

const requireMultiWindow = hasFlag('require-multi-window');
const longOnly = hasFlag('long-only');
const shortOnly = hasFlag('short-only');
const noSessionFilter = hasFlag('no-session-filter');
const allowedSessions = noSessionFilter ? [] : (getArg('sessions', 'rth')).split(',');

const commission = parseFloat(getArg('commission', '5.0'));
const slippage = parseFloat(getArg('slippage', '1.0'));
const initialCapital = parseFloat(getArg('initial-capital', '100000'));
const verbose = hasFlag('verbose');

const defaultOutput = `results/momentum-microstructure/${ticker}-backtest.json`;
const outputPath = getArg('output', defaultOutput);
const outputCsvPath = getArg('output-csv', null);

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// ============================================================================
// Print Configuration
// ============================================================================

console.log('='.repeat(80));
console.log('MOMENTUM MICROSTRUCTURE STRATEGY - STREAMING BACKTEST');
console.log('='.repeat(80));
console.log(`Ticker: ${ticker}`);
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Windows: ${windowSizes.join('s, ')}s`);
console.log(`Velocity threshold: ${velocityThreshold} pts/s`);
console.log(`Volume ratio threshold: ${volumeRatioThreshold}x`);
console.log(`Efficiency threshold: ${efficiencyThreshold}`);
console.log(`Cooldown: ${cooldownSeconds}s`);
console.log(`Target: ${targetPoints}pts | Stop: ${stopPoints}pts | Trail: ${trailingTrigger}/${trailingOffset}pts`);
console.log(`Max hold: ${maxHoldBars} bars (${(maxHoldBars / 60).toFixed(1)} min)`);
console.log(`Multi-window required: ${requireMultiWindow ? 'YES' : 'no'}`);
console.log(`Direction filter: ${longOnly ? 'LONG ONLY' : shortOnly ? 'SHORT ONLY' : 'both'}`);
console.log(`Session filter: ${noSessionFilter ? 'disabled' : allowedSessions.join(', ')}`);
console.log(`Commission: $${commission} | Slippage: ${slippage}pts | Capital: $${initialCapital.toLocaleString()}`);
console.log();

// ============================================================================
// Data File Resolution
// ============================================================================

function getDataFilePath() {
  if (ticker === 'ES') {
    return path.join(dataDir, 'ohlcv/es/ES_ohlcv_1s_continuous.csv');
  }
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
    contractIdx: idx['contract'],
    minCols: Math.max(idx['open'], idx['high'], idx['low'], idx['close'], idx['volume'], idx['symbol']) + 1
  };
}

// ============================================================================
// NQ Primary Contract Tracker
// ============================================================================

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
// Streaming Backtest Pipeline
// ============================================================================

async function runBacktest() {
  const filePath = getDataFilePath();
  if (!fs.existsSync(filePath)) {
    console.error(`Data file not found: ${filePath}`);
    process.exit(1);
  }
  console.log(`Loading from: ${filePath}`);
  const fileSize = fs.statSync(filePath).size;
  console.log(`File size: ${(fileSize / 1e9).toFixed(2)} GB`);
  console.log();

  // Initialize strategy
  const strategy = new MomentumMicrostructureStrategy({
    velocityThreshold,
    volumeRatioThreshold,
    efficiencyThreshold,
    cooldownSeconds,
    windowSizes,
    requireMultiWindow,
    longOnly,
    shortOnly,
    targetPoints,
    stopPoints,
    trailingTrigger,
    trailingOffset,
    maxHoldBars,
    useSessionFilter: !noSessionFilter,
    allowedSessions,
    tradingSymbol: ticker,
    debug: false
  });

  // Initialize trade simulator
  const tradeSimulator = new TradeSimulator({
    commission,
    slippage: {
      limitOrderSlippage: 0,
      marketOrderSlippage: slippage,
      stopOrderSlippage: slippage * 1.5
    },
    contractSpecs: {},
    forceCloseAtMarketClose: true,
    marketCloseTimeUTC: 21
  });

  // Initialize performance calculator
  const perfCalc = new PerformanceCalculator(initialCapital);

  // Streaming state
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let colParser = null;
  const isES = ticker === 'ES';
  const contractTracker = isES ? null : new PrimaryContractTracker();

  // Stats
  let totalLines = 0;
  let parsedCandles = 0;
  let skippedCalendarSpread = 0;
  let skippedNonPrimary = 0;
  let skippedDateRange = 0;
  let skippedInvalid = 0;
  let lastProgressTime = Date.now();
  let lastProgressLines = 0;
  const runStartTime = Date.now();

  let totalSignals = 0;
  let rejectedSignals = 0;
  let equity = initialCapital;
  const equityCurve = [];
  const tradeDays = new Set();

  for await (const line of rl) {
    if (!colParser) {
      colParser = getColumnParser(line);
      continue;
    }

    totalLines++;

    // Progress every 10 seconds
    if (Date.now() - lastProgressTime > 10000) {
      const elapsed = (Date.now() - runStartTime) / 1000;
      const lps = ((totalLines - lastProgressLines) / ((Date.now() - lastProgressTime) / 1000)).toFixed(0);
      const pct = fileStream.bytesRead ? ((fileStream.bytesRead / fileSize) * 100).toFixed(1) : '?';
      const trades = tradeSimulator.getCompletedTrades().length;
      const active = tradeSimulator.hasActiveTrades() ? 1 : 0;
      console.log(`  ${pct}% | ${(totalLines / 1e6).toFixed(1)}M lines | ${lps} lines/s | signals: ${totalSignals} | trades: ${trades} (${active} active) | ${elapsed.toFixed(0)}s`);
      lastProgressTime = Date.now();
      lastProgressLines = totalLines;
    }

    // Parse line
    const parts = line.split(',');
    if (parts.length < colParser.minCols) { skippedInvalid++; continue; }

    const timestamp = new Date(parts[colParser.tsIdx]).getTime();
    if (isNaN(timestamp)) { skippedInvalid++; continue; }

    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) {
      skippedDateRange++;
      continue;
    }

    const symbol = parts[colParser.symbolIdx]?.trim();
    if (!isES && symbol && symbol.includes('-')) { skippedCalendarSpread++; continue; }

    const open = parseFloat(parts[colParser.openIdx]);
    const high = parseFloat(parts[colParser.highIdx]);
    const low = parseFloat(parts[colParser.lowIdx]);
    const close = parseFloat(parts[colParser.closeIdx]);
    const volume = parseInt(parts[colParser.volumeIdx]) || 0;

    if (isNaN(open) || isNaN(close)) { skippedInvalid++; continue; }
    if (open === high && high === low && low === close) { skippedInvalid++; continue; }

    const candle = { timestamp, open, high, low, close, volume, symbol };

    if (!isES) {
      if (!contractTracker.processCandle(candle)) { skippedNonPrimary++; continue; }
    }

    parsedCandles++;

    // 1) Update active trades with current candle (check exits FIRST)
    const tradeUpdates = tradeSimulator.updateActiveTrades(candle);
    for (const update of tradeUpdates) {
      if (update.status === 'completed') {
        equity += update.netPnL;
        equityCurve.push({
          timestamp: update.exitTime,
          equity,
          tradeId: update.id,
          pnl: update.netPnL
        });
        const dayKey = new Date(update.exitTime).toISOString().slice(0, 10);
        tradeDays.add(dayKey);

        if (verbose) {
          const pnlSign = update.netPnL >= 0 ? '+' : '';
          console.log(`  [TRADE] ${update.side.toUpperCase()} @ ${update.actualEntry} → ${update.actualExit} | ${update.exitReason} | ${pnlSign}$${update.netPnL.toFixed(2)} (${pnlSign}${update.pointsPnL.toFixed(2)}pts) | equity: $${equity.toFixed(2)}`);
        }
      }
    }

    // 2) Evaluate strategy for new signal (only if no active trade)
    if (!tradeSimulator.hasActiveTrades()) {
      const signal = strategy.evaluateSignal(candle, null, null);

      if (signal) {
        totalSignals++;
        const order = tradeSimulator.processSignal(signal, timestamp);

        if (!order) {
          rejectedSignals++;
        }
      }
    } else {
      // Still feed candle to strategy so its internal buffer stays current
      strategy.evaluateSignal(candle, null, null);
    }
  }

  // Force close any remaining active trades at last price
  const activeTrades = tradeSimulator.getActiveTrades();
  if (activeTrades.length > 0) {
    console.log(`\nForce-closing ${activeTrades.length} active trade(s) at end of data...`);
    // We can't call updateActiveTrades without a candle, so just note them
    for (const trade of activeTrades) {
      console.log(`  Trade ${trade.id}: ${trade.side} @ ${trade.actualEntry || trade.entryPrice} (status: ${trade.status})`);
    }
  }

  const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(1);
  const completedTrades = tradeSimulator.getCompletedTrades();

  console.log();
  console.log(`Streaming complete in ${elapsed}s`);
  console.log(`  Total lines: ${(totalLines / 1e6).toFixed(2)}M`);
  console.log(`  Parsed candles: ${(parsedCandles / 1e6).toFixed(2)}M`);
  if (!isES) {
    console.log(`  Skipped calendar spreads: ${(skippedCalendarSpread / 1e6).toFixed(2)}M`);
    console.log(`  Skipped non-primary: ${(skippedNonPrimary / 1e6).toFixed(2)}M`);
  }
  console.log(`  Skipped date range: ${(skippedDateRange / 1e6).toFixed(2)}M`);
  console.log(`  Skipped invalid: ${skippedInvalid}`);
  console.log(`  Total signals: ${totalSignals}`);
  console.log(`  Rejected signals: ${rejectedSignals}`);
  console.log(`  Completed trades: ${completedTrades.length}`);
  console.log(`  Trading days: ${tradeDays.size}`);

  return {
    completedTrades,
    equityCurve,
    totalSignals,
    rejectedSignals,
    stats: {
      totalLines,
      parsedCandles,
      skippedCalendarSpread,
      skippedNonPrimary,
      skippedDateRange,
      skippedInvalid,
      tradeDays: tradeDays.size,
      elapsedSeconds: parseFloat(elapsed)
    }
  };
}

// ============================================================================
// Results Reporting
// ============================================================================

function printResults(completedTrades, equityCurve, stats) {
  const perfCalc = new PerformanceCalculator(initialCapital);

  if (completedTrades.length === 0) {
    console.log('\nNo trades completed. Try adjusting thresholds or date range.');
    return perfCalc.getEmptyMetrics();
  }

  const metrics = perfCalc.calculateMetrics(completedTrades, equityCurve, startDate, endDate);

  console.log('\n' + '='.repeat(80));
  console.log('PERFORMANCE RESULTS');
  console.log('='.repeat(80));

  const s = metrics.summary;
  const b = metrics.basic;

  console.log(`\n--- Summary ---`);
  console.log(`  Total Trades: ${s.totalTrades}`);
  console.log(`  Win Rate: ${s.winRate.toFixed(1)}%`);
  console.log(`  Total P&L: $${s.totalPnL.toLocaleString()}`);
  console.log(`  Total Return: ${s.totalReturn.toFixed(2)}%`);
  console.log(`  Sharpe Ratio: ${s.sharpeRatio.toFixed(2)}`);
  console.log(`  Max Drawdown: ${s.maxDrawdown.toFixed(2)}%`);

  console.log(`\n--- Trading Statistics ---`);
  console.log(`  Winning: ${b.winningTrades} | Losing: ${b.losingTrades}`);
  console.log(`  Avg Win: $${b.avgWin.toFixed(2)} | Avg Loss: $${b.avgLoss.toFixed(2)}`);
  console.log(`  Largest Win: $${b.largestWin.toFixed(2)} | Largest Loss: $${b.largestLoss.toFixed(2)}`);
  console.log(`  Profit Factor: ${b.profitFactor === Infinity ? 'Inf' : b.profitFactor.toFixed(2)}`);
  console.log(`  Payoff Ratio: ${b.payoffRatio === Infinity ? 'Inf' : b.payoffRatio.toFixed(2)}`);
  console.log(`  Expectancy: $${b.expectancy.toFixed(2)}`);
  console.log(`  Total Commission: $${b.totalCommission.toFixed(2)}`);

  // Exit reason breakdown
  const breakdown = {};
  for (const trade of completedTrades) {
    const reason = trade.exitReason || 'unknown';
    if (!breakdown[reason]) breakdown[reason] = { count: 0, totalPnL: 0, wins: 0 };
    breakdown[reason].count++;
    breakdown[reason].totalPnL += trade.netPnL;
    if (trade.netPnL > 0) breakdown[reason].wins++;
  }

  console.log(`\n--- Exit Breakdown ---`);
  for (const [reason, data] of Object.entries(breakdown)) {
    const winRate = ((data.wins / data.count) * 100).toFixed(1);
    console.log(`  ${reason.padEnd(15)} ${String(data.count).padStart(5)} trades | $${data.totalPnL.toFixed(2).padStart(10)} | ${winRate}% win`);
  }

  // Direction breakdown
  const longs = completedTrades.filter(t => t.side === 'buy');
  const shorts = completedTrades.filter(t => t.side === 'sell');
  if (longs.length > 0 || shorts.length > 0) {
    console.log(`\n--- Direction Breakdown ---`);
    if (longs.length > 0) {
      const longWins = longs.filter(t => t.netPnL > 0).length;
      const longPnL = longs.reduce((s, t) => s + t.netPnL, 0);
      console.log(`  Long:  ${longs.length} trades | ${((longWins / longs.length) * 100).toFixed(1)}% win | $${longPnL.toFixed(2)}`);
    }
    if (shorts.length > 0) {
      const shortWins = shorts.filter(t => t.netPnL > 0).length;
      const shortPnL = shorts.reduce((s, t) => s + t.netPnL, 0);
      console.log(`  Short: ${shorts.length} trades | ${((shortWins / shorts.length) * 100).toFixed(1)}% win | $${shortPnL.toFixed(2)}`);
    }
  }

  // Multi-window analysis
  const multiTrades = completedTrades.filter(t => t.metadata?.multiWindow);
  const singleTrades = completedTrades.filter(t => !t.metadata?.multiWindow);
  if (multiTrades.length > 0 && singleTrades.length > 0) {
    console.log(`\n--- Multi-Window Analysis ---`);
    const mWins = multiTrades.filter(t => t.netPnL > 0).length;
    const mPnL = multiTrades.reduce((s, t) => s + t.netPnL, 0);
    console.log(`  Multi-window:  ${multiTrades.length} trades | ${((mWins / multiTrades.length) * 100).toFixed(1)}% win | $${mPnL.toFixed(2)}`);
    const sWins = singleTrades.filter(t => t.netPnL > 0).length;
    const sPnL = singleTrades.reduce((s, t) => s + t.netPnL, 0);
    console.log(`  Single-window: ${singleTrades.length} trades | ${((sWins / singleTrades.length) * 100).toFixed(1)}% win | $${sPnL.toFixed(2)}`);
  }

  // Risk metrics
  if (metrics.risk) {
    console.log(`\n--- Risk Metrics ---`);
    console.log(`  Annualized Volatility: ${metrics.risk.annualizedVolatility.toFixed(2)}%`);
    console.log(`  Sharpe Ratio: ${metrics.risk.sharpeRatio.toFixed(2)}`);
    console.log(`  Sortino Ratio: ${metrics.risk.sortinoRatio.toFixed(2)}`);
    console.log(`  Recovery Factor: ${metrics.drawdown.recoveryFactor.toFixed(2)}`);
  }

  // Advanced metrics
  if (metrics.advanced) {
    console.log(`\n--- Advanced Metrics ---`);
    console.log(`  Calmar Ratio: ${metrics.advanced.calmarRatio.toFixed(2)}`);
    console.log(`  Information Ratio: ${metrics.advanced.informationRatio.toFixed(2)}`);
  }

  console.log('\n' + '='.repeat(80));

  return metrics;
}

// ============================================================================
// Output
// ============================================================================

function writeResults(completedTrades, equityCurve, stats, metrics) {
  const results = {
    metadata: {
      strategy: 'MOMENTUM_MICROSTRUCTURE',
      ticker,
      startDate: startDateStr,
      endDate: endDateStr,
      parameters: {
        velocityThreshold,
        volumeRatioThreshold,
        efficiencyThreshold,
        cooldownSeconds,
        windowSizes,
        targetPoints,
        stopPoints,
        trailingTrigger,
        trailingOffset,
        maxHoldBars,
        requireMultiWindow,
        longOnly,
        shortOnly,
        useSessionFilter: !noSessionFilter,
        allowedSessions,
        commission,
        slippage,
        initialCapital
      },
      stats,
      generatedAt: new Date().toISOString()
    },
    performance: metrics,
    trades: completedTrades.map(t => ({
      id: t.id,
      side: t.side,
      entryTime: new Date(t.entryTime).toISOString(),
      exitTime: new Date(t.exitTime).toISOString(),
      entryPrice: t.actualEntry,
      exitPrice: t.actualExit,
      exitReason: t.exitReason,
      pointsPnL: t.pointsPnL,
      netPnL: t.netPnL,
      grossPnL: t.grossPnL,
      commission: t.commission,
      duration: t.duration,
      barsSinceEntry: t.barsSinceEntry,
      metadata: t.metadata || {}
    })),
    equityCurve: equityCurve.map(p => ({
      timestamp: new Date(p.timestamp).toISOString(),
      equity: p.equity,
      pnl: p.pnl
    }))
  };

  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);

  // Optional CSV output
  if (outputCsvPath) {
    const csvHeader = 'id,side,entryTime,exitTime,entryPrice,exitPrice,exitReason,pointsPnL,netPnL,direction,windowCount,velocity,efficiency,volumeRatio';
    const csvLines = completedTrades.map(t => {
      const m = t.metadata || {};
      return [
        t.id, t.side,
        new Date(t.entryTime).toISOString(),
        new Date(t.exitTime).toISOString(),
        t.actualEntry, t.actualExit, t.exitReason,
        t.pointsPnL, t.netPnL,
        m.direction || '', m.windowCount || '',
        m.velocity || '', m.efficiency || '', m.volumeRatio || ''
      ].join(',');
    });

    const csvContent = [csvHeader, ...csvLines].join('\n');
    const csvDir = path.dirname(path.resolve(outputCsvPath));
    if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });
    fs.writeFileSync(path.resolve(outputCsvPath), csvContent);
    console.log(`Trades CSV written to ${outputCsvPath}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { completedTrades, equityCurve, totalSignals, rejectedSignals, stats } = await runBacktest();

  const metrics = printResults(completedTrades, equityCurve, stats);

  writeResults(completedTrades, equityCurve, stats, metrics);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
