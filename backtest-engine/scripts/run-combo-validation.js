#!/usr/bin/env node
/**
 * Validation run — best directional combos on 6-month period
 * Tests robustness of the LSWEEP SHORT + MTFR LONG edge
 */
import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, '..', 'data');

const configs = [
  // === 6-month validation of best combos ===

  // LSWEEP SHORT 20pt trend (0.8/day, 68.6% WR in 3mo)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 20pt trend 6mo',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // LSWEEP SHORT 18-20 trend (1.0/day, 66.1% WR in 3mo)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 18-20 trend 6mo',
    params: { fixedDistances: [18, 20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // LSWEEP SHORT 20pt deep1.5 (0.8/day, 68.8% WR in 3mo)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 20pt deep 6mo',
    params: { fixedDistances: [20], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 1.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},

  // MTFR LONG 18pt noTrend (0.8/day, 68.0% WR in 3mo)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR LONG 18pt noTrend 6mo',
    params: { fixedDistances: [18], distanceTolerance: 3, requireTrendAlignment: false, sideFilter: 'buy',
      wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},

  // MTFR LONG 18pt trend (0.3/day, 72.7% WR in 3mo)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR LONG 18pt trend 6mo',
    params: { fixedDistances: [18], distanceTolerance: 3, requireTrendAlignment: true, sideFilter: 'buy',
      wickToBodyRatio: 2.5, volumeMultiplier: 1.2, signalCooldownMs: 60000 }},

  // MTFR LONG 18pt wick2.0 noTrend (more freq)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-mtf-rejection', label: 'MTFR LONG 18pt wick2 6mo',
    params: { fixedDistances: [18], distanceTolerance: 3, requireTrendAlignment: false, sideFilter: 'buy',
      wickToBodyRatio: 2.0, volumeMultiplier: 1.0, signalCooldownMs: 60000, bodyRatioThreshold: 0.35 }},

  // LSWEEP SHORT tol5 (1.1/day, 63.9% WR — just below 65% target)
  { ticker: 'NQ', tf: '1m', strategy: 'ohlcv-liquidity-sweep', label: 'LSWEEP SHORT 20pt tol5 6mo',
    params: { fixedDistances: [20], distanceTolerance: 5, requireTrendAlignment: true, sideFilter: 'sell',
      swingLookback: 8, minSweepDepth: 0.5, signalCooldownMs: 60000, volumeMultiplier: 1.0 }},
];

function getTradingDays(start, end) {
  const s = new Date(start), e = new Date(end);
  return Math.round((e - s) / (1000 * 60 * 60 * 24) * 5 / 7);
}

async function run() {
  const start = '2025-01-01', end = '2025-07-01';
  const tradingDays = getTradingDays(start, end);

  console.log('='.repeat(130));
  console.log('  6-Month Validation — Best Directional Combos');
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
      const maxDD = res.performance?.basic?.maxDrawdownPercent || res.performance?.risk?.maxDrawdownPercent || 0;

      // Monthly breakdown
      const monthly = {};
      for (const t of trades) {
        const m = new Date(t.entryTime || t.timestamp).toISOString().slice(0, 7);
        if (!monthly[m]) monthly[m] = { t: 0, w: 0, pnl: 0 };
        monthly[m].t++;
        if ((t.netPnL || 0) > 0) monthly[m].w++;
        monthly[m].pnl += t.netPnL || 0;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const tag = wr >= 65 ? ' *** TARGET ***' : wr >= 60 ? ' ** CLOSE **' : '';
      const monthStr = Object.entries(monthly).sort()
        .map(([m, v]) => `${m.slice(5)}:${v.t}/${(v.w/v.t*100).toFixed(0)}%/$${v.pnl.toFixed(0)}`)
        .join(' ');

      process.stdout.write(`\r  ${cfg.label}: ${trades.length} (${tpd.toFixed(1)}/day), ${wr.toFixed(1)}% WR, PF=${pf.toFixed(2)}, $${pnl.toFixed(0)}, DD=${maxDD.toFixed(1)}% [${monthStr}] (${elapsed}s)${tag}\n`);

      results.push({ label: cfg.label, trades: trades.length, tpd, wr, pf, pnl, maxDD, monthly, elapsed });
    } catch (e) {
      process.stdout.write(`\r  ${cfg.label}: ERROR ${e.message}\n`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(130));
  console.log('  6-MONTH RESULTS SORTED BY WIN RATE:');
  console.log('='.repeat(130));
  const valid = results.filter(r => r.trades >= 10).sort((a, b) => b.wr - a.wr);
  for (const r of valid) {
    const tag = r.wr >= 65 ? ' *** TARGET ***' : r.wr >= 60 ? ' ** CLOSE **' : '';
    console.log(`  ${r.label.padEnd(40)} ${r.tpd.toFixed(1).padStart(4)}/day  ${String(r.trades).padStart(4)} trades  ${r.wr.toFixed(1).padStart(5)}% WR  PF=${r.pf.toFixed(2)}  $${r.pnl.toFixed(0).padStart(7)}  DD=${r.maxDD.toFixed(1)}%${tag}`);
  }

  // Combo analysis
  console.log('\n' + '='.repeat(130));
  console.log('  6-MONTH COMBO ANALYSIS:');
  console.log('='.repeat(130));

  const shortResults = results.filter(r => r.label.includes('SHORT') && r.trades >= 10);
  const longResults = results.filter(r => r.label.includes('LONG') && r.trades >= 10);

  for (const s of shortResults.sort((a,b) => b.wr - a.wr)) {
    for (const l of longResults.sort((a,b) => b.wr - a.wr)) {
      const comboTrades = s.trades + l.trades;
      const comboWins = Math.round(s.trades * s.wr / 100) + Math.round(l.trades * l.wr / 100);
      const comboWR = comboTrades > 0 ? (comboWins / comboTrades * 100) : 0;
      const comboPnL = s.pnl + l.pnl;
      const comboTPD = s.tpd + l.tpd;
      const tag = comboWR >= 65 && comboTPD >= 1.0 ? ' *** GOAL ***' : comboWR >= 65 ? ' ** HIGH WR **' : '';

      // Monthly combo
      const mCombo = {};
      for (const [m, v] of Object.entries(s.monthly)) {
        mCombo[m] = { t: v.t, w: v.w, pnl: v.pnl };
      }
      for (const [m, v] of Object.entries(l.monthly)) {
        if (!mCombo[m]) mCombo[m] = { t: 0, w: 0, pnl: 0 };
        mCombo[m].t += v.t; mCombo[m].w += v.w; mCombo[m].pnl += v.pnl;
      }
      const monthStr = Object.entries(mCombo).sort()
        .map(([m, v]) => `${m.slice(5)}:${v.t}t/${(v.w/v.t*100).toFixed(0)}%/$${v.pnl.toFixed(0)}`)
        .join(' ');

      console.log(`  ${s.label.slice(0,28).padEnd(30)} + ${l.label.slice(0,28).padEnd(30)}`);
      console.log(`    ${comboTrades} trades (${comboTPD.toFixed(1)}/day), ${comboWR.toFixed(1)}% WR, $${comboPnL.toFixed(0)}${tag}`);
      console.log(`    Monthly: ${monthStr}`);
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
