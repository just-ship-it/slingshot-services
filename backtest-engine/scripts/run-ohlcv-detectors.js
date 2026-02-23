#!/usr/bin/env node
/**
 * OHLCV Institutional Pattern Detectors v2 - Symmetric R:R Comparison Runner
 *
 * Runs all 4 OHLCV detectors across ES and NQ data at multiple timeframes
 * with fixed symmetric stop:target (1:1 R:R at 5/10/15pt distances).
 *
 * Usage:
 *   node scripts/run-ohlcv-detectors.js [options]
 *
 * Options:
 *   --tickers    Comma-separated tickers (default: ES,NQ)
 *   --timeframes Comma-separated timeframes (default: 1m,3m,5m)
 *   --start      Start date (default: 2025-01-01)
 *   --end        End date (default: 2025-07-01)
 *   --output     Output JSON file (default: ohlcv-detector-results-v2.json)
 */

import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.findIndex(a => a === `--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}

const tickers = getArg('tickers', 'ES,NQ').split(',').map(s => s.trim());
const timeframes = getArg('timeframes', '1m,3m,5m').split(',').map(s => s.trim());
const startDate = getArg('start', '2025-01-01');
const endDate = getArg('end', '2025-07-01');
const outputFile = getArg('output', 'ohlcv-detector-results-v2.json');

const detectors = [
  { name: 'ohlcv-absorption', shortName: 'ABS', label: 'Absorption Detector' },
  { name: 'ohlcv-liquidity-sweep', shortName: 'LSWEEP', label: 'Liquidity Sweep Detector' },
  { name: 'ohlcv-vpin', shortName: 'VPIN', label: 'VPIN Regime Detector' },
  { name: 'ohlcv-mtf-rejection', shortName: 'MTFR', label: 'MTF Rejection Detector' }
];

const dataDir = join(__dirname, '..', 'data');

async function runSingleBacktest(ticker, timeframe, detector) {
  try {
    const engine = new BacktestEngine({
      dataDir,
      ticker,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      timeframe,
      strategy: detector.name,
      strategyParams: {
        tradingSymbol: ticker,
        useSessionFilter: true,
        allowedSessions: ['rth'],
        forceCloseAtMarketClose: true
      },
      quiet: true,
      initialCapital: 100000,
      commission: 5.0,
      useSecondResolution: false
    });

    const results = await engine.run();
    return results;
  } catch (error) {
    console.error(`  ERROR: ${ticker}/${timeframe}/${detector.shortName}: ${error.message}`);
    return null;
  }
}

function extractMetrics(results) {
  if (!results || !results.performance) return null;

  const perf = results.performance;
  const summary = perf.summary || {};
  const basic = perf.basic || {};
  const trades = results.trades || [];

  // Session breakdown
  const sessionBreakdown = { rth: { trades: 0, wins: 0, pnl: 0 }, eth: { trades: 0, wins: 0, pnl: 0 } };
  const sideBreakdown = { long: { trades: 0, wins: 0, pnl: 0 }, short: { trades: 0, wins: 0, pnl: 0 } };

  // Distance breakdown for symmetric R:R analysis
  const distBreakdown = {};

  for (const trade of trades) {
    const isRTH = isRTHEntry(trade.entryTime || trade.signalTime);
    const bucket = isRTH ? sessionBreakdown.rth : sessionBreakdown.eth;
    bucket.trades++;
    if ((trade.netPnL || 0) > 0) bucket.wins++;
    bucket.pnl += trade.netPnL || 0;

    const sideBucket = (trade.side === 'buy') ? sideBreakdown.long : sideBreakdown.short;
    sideBucket.trades++;
    if ((trade.netPnL || 0) > 0) sideBucket.wins++;
    sideBucket.pnl += trade.netPnL || 0;

    // Track by aligned distance
    const dist = trade.metadata?.aligned_dist || trade.metadata?.risk_points || 'unknown';
    if (!distBreakdown[dist]) {
      distBreakdown[dist] = { trades: 0, wins: 0, pnl: 0 };
    }
    distBreakdown[dist].trades++;
    if ((trade.netPnL || 0) > 0) distBreakdown[dist].wins++;
    distBreakdown[dist].pnl += trade.netPnL || 0;
  }

  // Exit type analysis
  const exitTypes = {};
  for (const trade of trades) {
    const exit = trade.exitReason || trade.metadata?.exitReason || 'unknown';
    if (!exitTypes[exit]) exitTypes[exit] = { count: 0, wins: 0, pnl: 0 };
    exitTypes[exit].count++;
    if ((trade.netPnL || 0) > 0) exitTypes[exit].wins++;
    exitTypes[exit].pnl += trade.netPnL || 0;
  }

  return {
    totalTrades: summary.totalTrades || basic.totalTrades || trades.length,
    winRate: (summary.winRate || basic.winRate || 0) / 100,
    profitFactor: basic.profitFactor || 0,
    netPnL: summary.totalPnL || basic.totalPnL || 0,
    avgTrade: basic.avgTrade || 0,
    maxDrawdown: summary.maxDrawdown || 0,
    maxDrawdownPct: (summary.maxDrawdown || 0) / 100,
    sharpeRatio: summary.sharpeRatio || 0,
    avgWin: basic.avgWin || 0,
    avgLoss: basic.avgLoss || 0,
    sessionBreakdown,
    sideBreakdown,
    distBreakdown,
    exitTypes
  };
}

function isRTHEntry(timestamp) {
  if (!timestamp) return true;
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const [hourStr, minStr] = estString.split(':');
  const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;
  return timeDecimal >= 9.5 && timeDecimal < 16;
}

async function main() {
  console.log('='.repeat(80));
  console.log('  OHLCV Detectors v2 - Symmetric R:R Comparison Backtest');
  console.log('='.repeat(80));
  console.log(`  Tickers:      ${tickers.join(', ')}`);
  console.log(`  Timeframes:   ${timeframes.join(', ')}`);
  console.log(`  Period:       ${startDate} -> ${endDate}`);
  console.log(`  Detectors:    ${detectors.map(d => d.shortName).join(', ')}`);
  console.log(`  R:R Mode:     Symmetric 1:1 (fixed distances: 5/10/15pt)`);
  console.log('='.repeat(80));
  console.log();

  const allResults = {};
  const summaryRows = [];

  for (const ticker of tickers) {
    allResults[ticker] = {};

    for (const tf of timeframes) {
      allResults[ticker][tf] = {};

      for (const detector of detectors) {
        const label = `${ticker}/${tf}/${detector.shortName}`;
        process.stdout.write(`  Running ${label}...`);

        const startTime = Date.now();
        const results = await runSingleBacktest(ticker, tf, detector);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        const metrics = extractMetrics(results);
        allResults[ticker][tf][detector.name] = { metrics, trades: results?.trades || [] };

        if (metrics && metrics.totalTrades > 0) {
          process.stdout.write(`\r  ${label}: ${metrics.totalTrades} trades, ${(metrics.winRate * 100).toFixed(1)}% win, PF=${metrics.profitFactor.toFixed(2)}, $${metrics.netPnL.toFixed(0)} P&L (${elapsed}s)\n`);

          summaryRows.push({
            ticker, timeframe: tf, detector: detector.shortName,
            ...metrics
          });
        } else {
          process.stdout.write(`\r  ${label}: No trades (${elapsed}s)\n`);
        }
      }
    }
  }

  // Print summary comparison table
  console.log('\n' + '='.repeat(130));
  console.log('  SUMMARY COMPARISON - Symmetric 1:1 R:R');
  console.log('='.repeat(130));

  console.log(
    'Ticker'.padEnd(6),
    'TF'.padEnd(4),
    'Detector'.padEnd(8),
    'Trades'.padStart(7),
    'Win%'.padStart(7),
    'PF'.padStart(7),
    'Net P&L'.padStart(10),
    'MaxDD%'.padStart(8),
    'Sharpe'.padStart(8),
    'Longs'.padStart(7),
    'Shorts'.padStart(7),
    'L Win%'.padStart(8),
    'S Win%'.padStart(8),
    '5pt'.padStart(8),
    '10pt'.padStart(8),
    '15pt'.padStart(8)
  );
  console.log('-'.repeat(130));

  // Sort by win rate descending (targeting 75%+ WR)
  summaryRows.sort((a, b) => (b.winRate || 0) - (a.winRate || 0));

  for (const row of summaryRows) {
    const lWinRate = row.sideBreakdown.long.trades > 0
      ? ((row.sideBreakdown.long.wins / row.sideBreakdown.long.trades) * 100).toFixed(1)
      : 'N/A';
    const sWinRate = row.sideBreakdown.short.trades > 0
      ? ((row.sideBreakdown.short.wins / row.sideBreakdown.short.trades) * 100).toFixed(1)
      : 'N/A';

    // Distance breakdown summary
    const dist5 = row.distBreakdown[5];
    const dist10 = row.distBreakdown[10];
    const dist15 = row.distBreakdown[15];
    const fmt = (d) => d ? `${d.trades}/${((d.wins / d.trades) * 100).toFixed(0)}%` : '-';

    console.log(
      row.ticker.padEnd(6),
      row.timeframe.padEnd(4),
      row.detector.padEnd(8),
      String(row.totalTrades).padStart(7),
      (row.winRate * 100).toFixed(1).padStart(6) + '%',
      row.profitFactor.toFixed(2).padStart(7),
      ('$' + row.netPnL.toFixed(0)).padStart(10),
      (row.maxDrawdownPct * 100).toFixed(1).padStart(7) + '%',
      row.sharpeRatio.toFixed(2).padStart(8),
      String(row.sideBreakdown.long.trades).padStart(7),
      String(row.sideBreakdown.short.trades).padStart(7),
      (lWinRate + '%').padStart(8),
      (sWinRate + '%').padStart(8),
      fmt(dist5).padStart(8),
      fmt(dist10).padStart(8),
      fmt(dist15).padStart(8)
    );
  }

  console.log('-'.repeat(130));

  // Highlight combos meeting 75% WR target
  const highWR = summaryRows.filter(r => r.winRate >= 0.75 && r.totalTrades >= 5);
  if (highWR.length > 0) {
    console.log('\n  COMBOS MEETING 75%+ WIN RATE TARGET (min 5 trades):');
    for (const r of highWR) {
      console.log(`    ${r.ticker}/${r.timeframe}/${r.detector}: ${(r.winRate * 100).toFixed(1)}% WR, ${r.totalTrades} trades, PF=${r.profitFactor.toFixed(2)}, $${r.netPnL.toFixed(0)}`);
    }
  } else {
    console.log('\n  No combos met 75%+ win rate target with 5+ trades.');
  }

  // Best by profit factor
  const profitable = [...summaryRows].filter(r => r.totalTrades >= 5 && r.profitFactor > 1).sort((a, b) => b.profitFactor - a.profitFactor);
  if (profitable.length > 0) {
    console.log('\n  PROFITABLE COMBOS (PF > 1.0, min 5 trades):');
    for (const r of profitable.slice(0, 10)) {
      console.log(`    ${r.ticker}/${r.timeframe}/${r.detector}: PF=${r.profitFactor.toFixed(2)}, ${(r.winRate * 100).toFixed(1)}% WR, ${r.totalTrades} trades, $${r.netPnL.toFixed(0)}`);
    }
  }

  // Distance analysis across all combos
  console.log('\n  DISTANCE ANALYSIS (across all combos):');
  const distAgg = {};
  for (const row of summaryRows) {
    for (const [dist, data] of Object.entries(row.distBreakdown)) {
      if (!distAgg[dist]) distAgg[dist] = { trades: 0, wins: 0, pnl: 0 };
      distAgg[dist].trades += data.trades;
      distAgg[dist].wins += data.wins;
      distAgg[dist].pnl += data.pnl;
    }
  }
  for (const [dist, data] of Object.entries(distAgg).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(1) : '0';
    console.log(`    ${dist}pt: ${data.trades} trades, ${wr}% win rate, $${data.pnl.toFixed(0)} P&L`);
  }

  // Save results
  const outputPath = join(__dirname, '..', outputFile);
  fs.writeFileSync(outputPath, JSON.stringify({
    config: { tickers, timeframes, startDate, endDate, mode: 'symmetric_1to1_rr' },
    results: allResults,
    summary: summaryRows
  }, null, 2));
  console.log(`\n  Results saved to: ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
