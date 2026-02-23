#!/usr/bin/env node
/**
 * Focused 20pt distance tests — the sweet spot from frequency analysis
 * 20pt trades showed 54-71% WR across configs, ~1/day frequency
 */
import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, '..', 'data');

const configs = [
  // NQ 1m LSWEEP — 20pt only, various filter combos
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP 20pt trend noVol',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP 18-20 trend noVol',
    params: { fixedDistances: [18, 20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP 15-20 trend noVol',
    params: { fixedDistances: [15, 18, 20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // With volume filter (1.2x)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP 18-20 trend vol1.2',
    params: { fixedDistances: [18, 20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.2 }},

  // Wider tolerance (±5pt around 20)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP 20pt tol5 trend',
    params: { fixedDistances: [20], distanceTolerance: 5, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // Shorter cooldown (30s)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP 18-20 trend cd30s',
    params: { fixedDistances: [18, 20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 30000, volumeMultiplier: 1.0 }},

  // Aggressive entry mode (no confirmation bar)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP 18-20 aggr trend',
    params: { fixedDistances: [18, 20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0, entryMode: 'aggressive' }},

  // NQ 1m MTFR — 18pt showed 73% WR
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'NQ/1m/MTFR 18-20 trend',
    params: { fixedDistances: [18, 20], distanceTolerance: 3, requireTrendAlignment: true, wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},

  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'NQ/1m/MTFR 15-20 trend',
    params: { fixedDistances: [15, 18, 20], distanceTolerance: 3, requireTrendAlignment: true, wickToBodyRatio: 2.5, volumeMultiplier: 1.0, signalCooldownMs: 60000 }},

  // Combine LSWEEP + MTFR range for overall picture
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/1m/LSWEEP 15-25 trend noVol',
    params: { fixedDistances: [15, 18, 20, 25], distanceTolerance: 4, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // 6-month runs on best combos (3m for speed)
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/3m/LSWEEP 18-20 trend 6mo',
    params: { fixedDistances: [18, 20], distanceTolerance: 4, requireTrendAlignment: true, swingLookback: 6, minSweepDepth: 0.75, signalCooldownMs: 60000, volumeMultiplier: 1.0 },
    start: '2025-01-01', end: '2025-07-01' },

  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/3m/LSWEEP 15-25 trend 6mo',
    params: { fixedDistances: [15, 18, 20, 25], distanceTolerance: 4, requireTrendAlignment: true, swingLookback: 6, minSweepDepth: 0.75, signalCooldownMs: 60000, volumeMultiplier: 1.0 },
    start: '2025-01-01', end: '2025-07-01' },

  // ES at its own scale (8-12pt is its 20pt equivalent)
  { ticker: 'ES', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'ES/1m/LSWEEP 8-12 trend',
    params: { fixedDistances: [8, 10, 12], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 10, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  { ticker: 'ES', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'ES/1m/LSWEEP 10-15 trend',
    params: { fixedDistances: [10, 12, 15], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 10, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},
];

function getTradingDays(start, end) {
  const s = new Date(start), e = new Date(end);
  return Math.round((e - s) / (1000 * 60 * 60 * 24) * 5 / 7);
}

async function run() {
  console.log('='.repeat(130));
  console.log('  Focused 20pt Distance Tests — Finding 1-2/day at 65%+ WR');
  console.log('='.repeat(130));

  const results = [];

  for (const cfg of configs) {
    const start = cfg.start || '2025-01-01';
    const end = cfg.end || '2025-04-01';
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
          maxHoldBars: cfg.tf === '1m' ? 60 : 30,
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
      const tpd = trades.length / tradingDays;

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
        .map(([d, v]) => `${d}:${v.t}/${(v.t>0?(v.w/v.t*100).toFixed(0):'0')}%/$${v.pnl.toFixed(0)}`).join(' ');
      const longWR = sideB.buy.t > 0 ? (sideB.buy.w / sideB.buy.t * 100).toFixed(1) : 'N/A';
      const shortWR = sideB.sell.t > 0 ? (sideB.sell.w / sideB.sell.t * 100).toFixed(1) : 'N/A';

      process.stdout.write(`\r  ${cfg.label}: ${trades.length} (${tpd.toFixed(1)}/day), ${wr.toFixed(1)}% WR, PF=${pf.toFixed(2)}, $${pnl.toFixed(0)}, L=${sideB.buy.t}@${longWR}% S=${sideB.sell.t}@${shortWR}% [${distStr}] (${elapsed}s)\n`);

      results.push({ label: cfg.label, trades: trades.length, tpd, wr, pf, pnl, longWR, shortWR, distB, sideB });
    } catch (e) {
      process.stdout.write(`\r  ${cfg.label}: ERROR ${e.message}\n`);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(130));
  console.log('  RESULTS SORTED BY WIN RATE (min 5 trades):');
  console.log('='.repeat(130));
  results.filter(r => r.trades >= 5).sort((a, b) => b.wr - a.wr).forEach(r => {
    const tag = r.wr >= 65 ? (r.tpd >= 1 ? ' *** GOAL ***' : ' ** HIGH WR **') : r.wr >= 55 ? ' *' : '';
    console.log(`  ${r.label.padEnd(40)} ${r.tpd.toFixed(1).padStart(4)}/day  ${String(r.trades).padStart(4)} trades  ${r.wr.toFixed(1).padStart(5)}% WR  PF=${r.pf.toFixed(2)}  $${r.pnl.toFixed(0).padStart(7)}  L=${r.longWR}% S=${r.shortWR}%${tag}`);
  });

  // Best frequency at 55%+ WR
  console.log('\n  BEST FREQUENCY AT 55%+ WR:');
  results.filter(r => r.trades >= 5 && r.wr >= 55).sort((a, b) => b.tpd - a.tpd).forEach(r => {
    console.log(`  ${r.label.padEnd(40)} ${r.tpd.toFixed(1).padStart(4)}/day  ${r.wr.toFixed(1)}% WR  PF=${r.pf.toFixed(2)}  $${r.pnl.toFixed(0)}`);
  });
}

run().catch(e => { console.error(e); process.exit(1); });
