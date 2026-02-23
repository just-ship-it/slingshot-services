#!/usr/bin/env node
/**
 * Directional Combo Tests — exploiting the directional edge
 *
 * Key findings from 20pt focused tests:
 * - LSWEEP shorts: 68.6% WR at 20pt (sweep above swing highs → sell reversal)
 * - MTFR longs:  68-74% WR at 18pt (pin bar rejection at lows → buy)
 * - MTFR 18pt:   74% WR on NQ/1m (23 trades in 3mo)
 *
 * This script tests:
 * 1. Short-only LSWEEP at 20pt
 * 2. Long-only MTFR at 18pt
 * 3. Various filter combos to maximize frequency while maintaining 65%+ WR
 * 4. Combined counts to see if we hit 1-2 trades/day
 */
import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, '..', 'data');

const configs = [
  // === LSWEEP SHORT-ONLY at 20pt ===

  // Base: short-only, 20pt, trend, no vol filter
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 20pt trend',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // Short-only, wider tolerance (captures more setups)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 20pt tol5',
    params: { fixedDistances: [20], distanceTolerance: 5, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // Short-only, no trend filter (test if trend filter helps shorts)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 20pt noTrend',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: false, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // Short-only, 18-20pt (add 18pt if it helps on short side)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 18-20 trend',
    params: { fixedDistances: [18, 20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // Short-only, deeper sweep required (more conviction)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 20pt deep1.5',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 1.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // Short-only with vol confirmation
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 20pt vol1.2',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.2 }},

  // === MTFR LONG-ONLY at 18pt ===

  // Base: long-only, 18pt, trend
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR LONG 18pt trend',
    params: { fixedDistances: [18], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'buy',
      wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},

  // Long-only, 15-18pt (add 15pt for more volume)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR LONG 15-18 trend',
    params: { fixedDistances: [15, 18], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'buy',
      wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},

  // Long-only, wider tolerance
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR LONG 18pt tol5',
    params: { fixedDistances: [18], distanceTolerance: 5, requireTrendAlignment: true, sideFilter: 'buy',
      wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},

  // Long-only, lower wick requirement (more setups)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR LONG 18pt wick2.0',
    params: { fixedDistances: [18], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'buy',
      wickToBodyRatio: 2.0, volumeMultiplier: 1.0, signalCooldownMs: 60000, bodyRatioThreshold: 0.35 }},

  // Long-only, no trend (test if trend helps longs)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR LONG 18pt noTrend',
    params: { fixedDistances: [18], distanceTolerance: 3, requireTrendAlignment: false, sideFilter: 'buy',
      wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},

  // === REFERENCE: BOTH sides for comparison ===

  // LSWEEP both sides 20pt (reference)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP BOTH 20pt trend (ref)',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'both',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // MTFR both sides 18pt (reference)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR BOTH 18pt trend (ref)',
    params: { fixedDistances: [18], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'both',
      wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},

  // === LSWEEP LONG-ONLY for comparison ===
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP LONG 20pt trend',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'buy',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // === MTFR SHORT-ONLY for comparison ===
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR SHORT 18pt trend',
    params: { fixedDistances: [18], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'sell',
      wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},
];

function getTradingDays(start, end) {
  const s = new Date(start), e = new Date(end);
  return Math.round((e - s) / (1000 * 60 * 60 * 24) * 5 / 7);
}

async function run() {
  const start = '2025-01-01', end = '2025-04-01';
  const tradingDays = getTradingDays(start, end);

  console.log('='.repeat(130));
  console.log('  Directional Combo Tests — Exploiting Short LSWEEP + Long MTFR Edge');
  console.log(`  Period: ${start} to ${end} (${tradingDays} trading days)`);
  console.log('='.repeat(130));

  const results = [];

  for (const cfg of configs) {
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
          maxHoldBars: 60,
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

      const avgWin = trades.filter(t => (t.netPnL||0) > 0).reduce((s, t) => s + t.netPnL, 0) / (wins || 1);
      const losses = trades.filter(t => (t.netPnL||0) <= 0);
      const avgLoss = losses.reduce((s, t) => s + t.netPnL, 0) / (losses.length || 1);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const tag = wr >= 65 ? ' *** TARGET ***' : wr >= 60 ? ' ** CLOSE **' : '';

      process.stdout.write(`\r  ${cfg.label}: ${trades.length} (${tpd.toFixed(1)}/day), ${wr.toFixed(1)}% WR, PF=${pf.toFixed(2)}, $${pnl.toFixed(0)}, avgW=$${avgWin.toFixed(0)} avgL=$${avgLoss.toFixed(0)} (${elapsed}s)${tag}\n`);

      results.push({ label: cfg.label, trades: trades.length, tpd, wr, pf, pnl, avgWin, avgLoss, elapsed });
    } catch (e) {
      process.stdout.write(`\r  ${cfg.label}: ERROR ${e.message}\n`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(130));
  console.log('  RESULTS SORTED BY WIN RATE (min 5 trades):');
  console.log('='.repeat(130));
  const valid = results.filter(r => r.trades >= 5).sort((a, b) => b.wr - a.wr);
  for (const r of valid) {
    const tag = r.wr >= 65 ? ' *** TARGET ***' : r.wr >= 60 ? ' ** CLOSE **' : r.wr >= 55 ? ' *' : '';
    console.log(`  ${r.label.padEnd(40)} ${r.tpd.toFixed(1).padStart(4)}/day  ${String(r.trades).padStart(4)} trades  ${r.wr.toFixed(1).padStart(5)}% WR  PF=${r.pf.toFixed(2)}  $${r.pnl.toFixed(0).padStart(7)}${tag}`);
  }

  // Combo analysis
  console.log('\n' + '='.repeat(130));
  console.log('  COMBO ANALYSIS — Best Short-Only + Best Long-Only:');
  console.log('='.repeat(130));

  const shortResults = results.filter(r => r.label.includes('SHORT') && r.trades >= 5);
  const longResults = results.filter(r => r.label.includes('LONG') && r.trades >= 5);

  if (shortResults.length > 0 && longResults.length > 0) {
    // Find best short by WR, then best long by WR
    const bestShorts = shortResults.sort((a, b) => b.wr - a.wr).slice(0, 3);
    const bestLongs = longResults.sort((a, b) => b.wr - a.wr).slice(0, 3);

    for (const s of bestShorts) {
      for (const l of bestLongs) {
        const comboTrades = s.trades + l.trades;
        const comboWins = Math.round(s.trades * s.wr / 100) + Math.round(l.trades * l.wr / 100);
        const comboWR = comboTrades > 0 ? (comboWins / comboTrades * 100) : 0;
        const comboPnL = s.pnl + l.pnl;
        const comboTPD = s.tpd + l.tpd;
        const tag = comboWR >= 65 && comboTPD >= 1.0 ? ' *** GOAL ***' : comboWR >= 65 ? ' ** HIGH WR **' : '';

        console.log(`  ${s.label.padEnd(28)} + ${l.label.padEnd(28)}`);
        console.log(`    ${comboTrades} trades (${comboTPD.toFixed(1)}/day), ${comboWR.toFixed(1)}% WR, $${comboPnL.toFixed(0)}${tag}`);
      }
    }
  } else {
    console.log('  Not enough short/long results for combo analysis');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
