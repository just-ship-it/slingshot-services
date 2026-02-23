#!/usr/bin/env node
import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, '..', 'data');

const configs = [
  // NQ with wider distances and trend alignment
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/3m/LSWEEP trend+wide',
    params: { fixedDistances: [10, 15, 20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 1.5 }},
  { ticker: 'NQ', tf: '5m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/5m/LSWEEP trend+wide',
    params: { fixedDistances: [10, 15, 20], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 8, minSweepDepth: 1.5 }},
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-mtf-rejection', label: 'NQ/3m/MTFR trend+wide',
    params: { fixedDistances: [10, 15, 20], distanceTolerance: 3, requireTrendAlignment: true, wickToBodyRatio: 3.0, volumeMultiplier: 1.5 }},
  { ticker: 'NQ', tf: '5m', strategy: 'ohlcv-mtf-rejection', label: 'NQ/5m/MTFR trend+wide',
    params: { fixedDistances: [10, 15, 20], distanceTolerance: 3, requireTrendAlignment: true, wickToBodyRatio: 3.0, volumeMultiplier: 1.5 }},
  // NQ with just 15pt focus
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/3m/LSWEEP 15pt-only',
    params: { fixedDistances: [15], distanceTolerance: 3, requireTrendAlignment: false }},
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-mtf-rejection', label: 'NQ/3m/MTFR 15pt-only',
    params: { fixedDistances: [15], distanceTolerance: 3, requireTrendAlignment: false }},
  // ES focused tests with trend alignment
  { ticker: 'ES', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'ES/3m/LSWEEP trend',
    params: { fixedDistances: [5, 10, 15], distanceTolerance: 2, requireTrendAlignment: true }},
  { ticker: 'ES', tf: '3m', strategy: 'ohlcv-mtf-rejection', label: 'ES/3m/MTFR 10+15 trend',
    params: { fixedDistances: [10, 15], distanceTolerance: 2, requireTrendAlignment: true, volumeMultiplier: 1.5 }},
  // VPIN with trend on best performer
  { ticker: 'ES', tf: '3m', strategy: 'ohlcv-vpin', label: 'ES/3m/VPIN 15pt trend',
    params: { fixedDistances: [15], distanceTolerance: 3, requireTrendAlignment: true }},
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-vpin', label: 'NQ/3m/VPIN 15+20 trend',
    params: { fixedDistances: [15, 20], distanceTolerance: 3, requireTrendAlignment: true }},
  // ES 5m test with tighter filters
  { ticker: 'ES', tf: '5m', strategy: 'ohlcv-liquidity-sweep', label: 'ES/5m/LSWEEP 10+15 trend',
    params: { fixedDistances: [10, 15], distanceTolerance: 2, requireTrendAlignment: true, volumeMultiplier: 1.8 }},
  { ticker: 'ES', tf: '5m', strategy: 'ohlcv-mtf-rejection', label: 'ES/5m/MTFR 10+15 trend',
    params: { fixedDistances: [10, 15], distanceTolerance: 2, requireTrendAlignment: true, volumeMultiplier: 1.5 }},
  // NQ with even wider distances (20, 25)
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/3m/LSWEEP 20+25',
    params: { fixedDistances: [20, 25], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 10 }},
  { ticker: 'NQ', tf: '5m', strategy: 'ohlcv-liquidity-sweep', label: 'NQ/5m/LSWEEP 20+25',
    params: { fixedDistances: [20, 25], distanceTolerance: 3, requireTrendAlignment: true, swingLookback: 10 }},
  { ticker: 'NQ', tf: '3m', strategy: 'ohlcv-mtf-rejection', label: 'NQ/3m/MTFR 20+25',
    params: { fixedDistances: [20, 25], distanceTolerance: 3, requireTrendAlignment: true }},
];

async function run() {
  console.log('='.repeat(120));
  console.log('  Targeted v2 Tests - Optimized Distances + Trend Filter');
  console.log('='.repeat(120));

  const results = [];

  for (const cfg of configs) {
    process.stdout.write(`  ${cfg.label}...`);
    const start = Date.now();
    try {
      const engine = new BacktestEngine({
        dataDir, ticker: cfg.ticker,
        startDate: new Date('2025-01-01'), endDate: new Date('2025-07-01'),
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

      // Distance breakdown
      const distB = {};
      const sideB = { buy: { t: 0, w: 0 }, sell: { t: 0, w: 0 } };
      for (const t of trades) {
        const d = t.metadata?.aligned_dist || t.metadata?.risk_points || '?';
        if (!distB[d]) distB[d] = { t: 0, w: 0, pnl: 0 };
        distB[d].t++; if ((t.netPnL||0) > 0) distB[d].w++; distB[d].pnl += t.netPnL || 0;
        const side = t.side === 'buy' ? sideB.buy : sideB.sell;
        side.t++; if ((t.netPnL||0) > 0) side.w++;
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const distStr = Object.entries(distB).map(([d, v]) => `${d}pt:${v.t}/${(v.w/v.t*100).toFixed(0)}%`).join(' ');
      const longWR = sideB.buy.t > 0 ? (sideB.buy.w / sideB.buy.t * 100).toFixed(1) : 'N/A';
      const shortWR = sideB.sell.t > 0 ? (sideB.sell.w / sideB.sell.t * 100).toFixed(1) : 'N/A';

      process.stdout.write(`\r  ${cfg.label}: ${trades.length} trades, ${wr.toFixed(1)}% WR, PF=${pf.toFixed(2)}, $${pnl.toFixed(0)}, L=${longWR}% S=${shortWR}% [${distStr}] (${elapsed}s)\n`);

      results.push({ label: cfg.label, trades: trades.length, wr, pf, pnl, longWR, shortWR, distB });
    } catch (e) {
      process.stdout.write(`\r  ${cfg.label}: ERROR ${e.message}\n`);
    }
  }

  // Summary sorted by WR
  console.log('\n' + '='.repeat(120));
  console.log('  SORTED BY WIN RATE (min 3 trades):');
  console.log('='.repeat(120));
  results.sort((a, b) => b.wr - a.wr);
  for (const r of results) {
    if (r.trades < 3) continue;
    const tag = r.wr >= 75 ? ' *** TARGET MET ***' : r.wr >= 60 ? ' ** PROMISING **' : r.wr >= 55 ? ' * ABOVE AVG *' : '';
    console.log(`  ${r.label.padEnd(35)} ${String(r.trades).padStart(4)} trades  ${r.wr.toFixed(1).padStart(5)}% WR  PF=${r.pf.toFixed(2)}  $${r.pnl.toFixed(0).padStart(7)}  L=${r.longWR}% S=${r.shortWR}%${tag}`);
  }

  // Summary sorted by P&L
  console.log('\n  SORTED BY P&L (min 3 trades):');
  console.log('-'.repeat(120));
  const byPnl = [...results].filter(r => r.trades >= 3).sort((a, b) => b.pnl - a.pnl);
  for (const r of byPnl.slice(0, 10)) {
    console.log(`  ${r.label.padEnd(35)} ${String(r.trades).padStart(4)} trades  ${r.wr.toFixed(1).padStart(5)}% WR  PF=${r.pf.toFixed(2)}  $${r.pnl.toFixed(0).padStart(7)}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
