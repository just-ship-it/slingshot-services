#!/usr/bin/env node
/**
 * Frequency-optimized v2 tests — targeting 1-2 trades/day at 65%+ WR
 *
 * Knobs being turned:
 * - 1m timeframe (more signals)
 * - Wider distance ranges with more levels
 * - Wider tolerance (±4-5pt)
 * - Lower volume requirements
 * - Shorter cooldowns (60-120s)
 * - Smaller swing lookback (more swing points)
 * - Lower sweep depth
 * - Allow neutral + aligned trends
 */
import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, '..', 'data');

const configs = [
  // === LIQUIDITY SWEEP — progressively loosened ===

  // Baseline: the 85.7% winner for reference (3m)
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/3m/LSWEEP baseline',
    params: { fixedDistances: [10, 15, 20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 1.5, signalCooldownMs: 300000 }},

  // Wider distances + tolerance, lower cooldown
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/3m/LSWEEP wide+fast',
    params: { fixedDistances: [8, 10, 12, 15, 18, 20], distanceTolerance: 4, requireTrendAlignment: true, swingLookback: 6, minSweepDepth: 0.75, signalCooldownMs: 120000, volumeMultiplier: 1.2 }},

  // Same but allow neutral trend
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/3m/LSWEEP wide+neutral',
    params: { fixedDistances: [8, 10, 12, 15, 18, 20], distanceTolerance: 4, requireTrendAlignment: false, swingLookback: 6, minSweepDepth: 0.75, signalCooldownMs: 120000, volumeMultiplier: 1.2 }},

  // 1m timeframe — much more granular
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP trend+wide',
    params: { fixedDistances: [8, 10, 12, 15, 18, 20], distanceTolerance: 4, requireTrendAlignment: true, swingLookback: 10, minSweepDepth: 1.0, signalCooldownMs: 120000, volumeMultiplier: 1.2 }},

  // 1m with very loose filters
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP maxfreq',
    params: { fixedDistances: [5, 8, 10, 12, 15, 18, 20, 25], distanceTolerance: 5, requireTrendAlignment: false, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // 1m with trend but lower vol requirement
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP trend+noVol',
    params: { fixedDistances: [8, 10, 12, 15, 18, 20], distanceTolerance: 4, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // ES versions
  { ticker: 'ES', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'ES/1m/LSWEEP trend+wide',
    params: { fixedDistances: [3, 5, 8, 10, 12, 15], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 10, minSweepDepth: 0.5, signalCooldownMs: 120000, volumeMultiplier: 1.2 }},

  { ticker: 'ES', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'ES/1m/LSWEEP maxfreq',
    params: { fixedDistances: [3, 5, 8, 10, 12, 15], distanceTolerance: 4, requireTrendAlignment: false, swingLookback: 8, minSweepDepth: 0.25, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // === VPIN — already had good volume, optimize ===

  // VPIN baseline (93 trades / 6mo = ~0.7/day)
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-vpin', label: 'NQ/3m/VPIN baseline',
    params: { fixedDistances: [15, 20], distanceTolerance: 3, requireTrendAlignment: true, signalCooldownMs: 600000 }},

  // VPIN wider + faster cooldown
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-vpin', label: 'NQ/3m/VPIN wide+fast',
    params: { fixedDistances: [10, 12, 15, 18, 20], distanceTolerance: 4, requireTrendAlignment: true, signalCooldownMs: 180000, swingLookback: 6 }},

  // VPIN on 1m
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-vpin', label: 'NQ/1m/VPIN trend+wide',
    params: { fixedDistances: [8, 10, 12, 15, 18, 20], distanceTolerance: 4, requireTrendAlignment: true, signalCooldownMs: 120000, swingLookback: 10 }},

  // VPIN on 1m maxfreq
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-vpin', label: 'NQ/1m/VPIN maxfreq',
    params: { fixedDistances: [5, 8, 10, 12, 15, 18, 20, 25], distanceTolerance: 5, requireTrendAlignment: false, signalCooldownMs: 60000, swingLookback: 8 }},

  // === MTF REJECTION — test on 1m ===

  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'NQ/1m/MTFR trend+wide',
    params: { fixedDistances: [8, 10, 12, 15, 18, 20], distanceTolerance: 4, requireTrendAlignment: true, wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 120000 }},

  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'NQ/1m/MTFR maxfreq',
    params: { fixedDistances: [5, 8, 10, 12, 15, 18, 20], distanceTolerance: 5, requireTrendAlignment: false, wickToBodyRatio: 2.0, volumeMultiplier: 1.0, bodyRatioThreshold: 0.35, signalCooldownMs: 60000 }},

  // ES MTF Rejection
  { ticker: 'ES', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'ES/1m/MTFR trend+wide',
    params: { fixedDistances: [3, 5, 8, 10, 12, 15], distanceTolerance: 3, requireTrendAlignment: true, wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 120000 }},
];

// Use 3-month window for 1m tests (speed), 6-month for 3m/5m
function getDateRange(tf) {
  if (tf === '1m') return { start: '2025-01-01', end: '2025-04-01' };
  return { start: '2025-01-01', end: '2025-07-01' };
}

function getTradingDays(start, end) {
  const s = new Date(start), e = new Date(end);
  const days = (e - s) / (1000 * 60 * 60 * 24);
  return Math.round(days * 5 / 7); // Rough weekday estimate
}

async function run() {
  console.log('='.repeat(130));
  console.log('  Frequency-Optimized v2 Tests — Target: 1-2 trades/day at 65%+ WR');
  console.log('='.repeat(130));

  const results = [];

  for (const cfg of configs) {
    const { start, end } = getDateRange(cfg.tf);
    const tradingDays = getTradingDays(start, end);
    process.stdout.write(`  ${cfg.label}...`);
    const startTime = Date.now();
    try {
      const engine = new BacktestEngine({
        dataDir, ticker: cfg.ticker,
        startDate: new Date(start), endDate: new Date(end),
        timeframe: cfg.tf, strategy: cfg.strategy,
        strategyParams: {
          tradingSymbol: cfg.ticker,
          useSessionFilter: true, allowedSessions: ['rth'],
          forceCloseAtMarketClose: true,
          ...cfg.params
        },
        quiet: true, initialCapital: 100000, commission: 5.0, useSecondResolution: false
      });
      const res = await engine.run();
      const trades = res.trades || [];
      const wins = trades.filter(t => (t.netPnL || 0) > 0).length;
      const pnl = trades.reduce((s, t) => s + (t.netPnL || 0), 0);
      const wr = trades.length > 0 ? (wins / trades.length * 100) : 0;
      const pf = res.performance?.basic?.profitFactor || 0;
      const tradesPerDay = trades.length / tradingDays;

      // Distance breakdown
      const distB = {};
      const sideB = { buy: { t: 0, w: 0, pnl: 0 }, sell: { t: 0, w: 0, pnl: 0 } };
      for (const t of trades) {
        const d = t.metadata?.aligned_dist || t.metadata?.risk_points || '?';
        if (!distB[d]) distB[d] = { t: 0, w: 0, pnl: 0 };
        distB[d].t++; if ((t.netPnL||0) > 0) distB[d].w++; distB[d].pnl += t.netPnL || 0;
        const side = t.side === 'buy' ? sideB.buy : sideB.sell;
        side.t++; if ((t.netPnL||0) > 0) side.w++; side.pnl += t.netPnL || 0;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const distStr = Object.entries(distB).sort((a,b) => Number(a[0]) - Number(b[0]))
        .map(([d, v]) => `${d}:${v.t}/${(v.t>0?(v.w/v.t*100).toFixed(0):'0')}%`).join(' ');
      const longWR = sideB.buy.t > 0 ? (sideB.buy.w / sideB.buy.t * 100).toFixed(1) : 'N/A';
      const shortWR = sideB.sell.t > 0 ? (sideB.sell.w / sideB.sell.t * 100).toFixed(1) : 'N/A';

      process.stdout.write(`\r  ${cfg.label}: ${trades.length} trades (${tradesPerDay.toFixed(1)}/day), ${wr.toFixed(1)}% WR, PF=${pf.toFixed(2)}, $${pnl.toFixed(0)}, L=${longWR}% S=${shortWR}% [${distStr}] (${elapsed}s)\n`);

      results.push({ label: cfg.label, trades: trades.length, tradesPerDay, wr, pf, pnl, longWR, shortWR, distB, sideB, tradingDays, tf: cfg.tf });
    } catch (e) {
      process.stdout.write(`\r  ${cfg.label}: ERROR ${e.message}\n`);
    }
  }

  // Summary sorted by trades/day for configs meeting 65% WR
  console.log('\n' + '='.repeat(130));
  console.log('  MEETING 65%+ WR TARGET (sorted by trades/day):');
  console.log('='.repeat(130));
  const meeting = results.filter(r => r.wr >= 65 && r.trades >= 5).sort((a, b) => b.tradesPerDay - a.tradesPerDay);
  if (meeting.length > 0) {
    for (const r of meeting) {
      console.log(`  ${r.label.padEnd(35)} ${r.tradesPerDay.toFixed(1).padStart(4)}/day  ${String(r.trades).padStart(4)} trades  ${r.wr.toFixed(1).padStart(5)}% WR  PF=${r.pf.toFixed(2)}  $${r.pnl.toFixed(0).padStart(7)}  L=${r.longWR}% S=${r.shortWR}%`);
    }
  } else {
    console.log('  None met 65% WR with 5+ trades');
  }

  // All results sorted by frequency
  console.log('\n  ALL RESULTS (sorted by trades/day, min 5 trades):');
  console.log('-'.repeat(130));
  const all = results.filter(r => r.trades >= 5).sort((a, b) => b.tradesPerDay - a.tradesPerDay);
  for (const r of all) {
    const tag = r.wr >= 65 ? ' ***' : r.wr >= 60 ? ' **' : r.wr >= 55 ? ' *' : '';
    console.log(`  ${r.label.padEnd(35)} ${r.tradesPerDay.toFixed(1).padStart(4)}/day  ${String(r.trades).padStart(4)} trades  ${r.wr.toFixed(1).padStart(5)}% WR  PF=${r.pf.toFixed(2)}  $${r.pnl.toFixed(0).padStart(7)}${tag}`);
  }

  // Best distance analysis
  console.log('\n  DISTANCE ANALYSIS (across ALL configs):');
  const distAgg = {};
  for (const r of results) {
    for (const [d, v] of Object.entries(r.distB)) {
      if (!distAgg[d]) distAgg[d] = { t: 0, w: 0, pnl: 0 };
      distAgg[d].t += v.t; distAgg[d].w += v.w; distAgg[d].pnl += v.pnl;
    }
  }
  for (const [d, v] of Object.entries(distAgg).sort((a,b) => Number(a[0]) - Number(b[0]))) {
    const wr = v.t > 0 ? (v.w / v.t * 100).toFixed(1) : '0';
    console.log(`    ${String(d).padStart(3)}pt: ${String(v.t).padStart(5)} trades  ${wr.padStart(5)}% WR  $${v.pnl.toFixed(0).padStart(8)} P&L`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
