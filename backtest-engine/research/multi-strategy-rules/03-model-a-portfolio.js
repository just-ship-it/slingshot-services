#!/usr/bin/env node
// 03: Model A — stacking baseline. Each strategy is its own independent book; broker
// carries up to 3 NQ contracts at peak. Portfolio PnL = sum of independent netPnLs.
// Writes model-a-portfolio.json.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll, STRATEGIES } from './lib/load-trades.js';
import { calculateMetrics, sampleCurve, fmtUsd, round } from './lib/metrics.js';
import { concurrencyHistogram } from './lib/interval-tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function pad(s, n) { return String(s).padEnd(n); }

export function main() {
  const { byKey, allFlat } = loadAll();

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Step 03: Model A — Stacking Portfolio Baseline');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();
  console.log('Treats each strategy as its own book. Broker may hold up to 3 NQ contracts');
  console.log('simultaneously. Portfolio PnL = simple sum of all 1-ct strategy PnLs.');
  console.log();

  const portfolio = calculateMetrics(allFlat);
  const byStrategy = {};
  for (const def of STRATEGIES) {
    const m = calculateMetrics(byKey.get(def.key).trades);
    byStrategy[def.key] = {
      trades: m.trades, winRate: round(m.winRate, 1), totalPnL: round(m.totalPnL),
      profitFactor: round(m.profitFactor, 2), sharpe: round(m.sharpe, 2),
      maxDD_usd: round(m.maxDD_usd), maxDD_pct: round(m.maxDD_pct, 2),
      avgPnL: round(m.avgPnL), avgHoldMin: round(m.avgHoldMin, 1),
    };
  }

  // Per-strategy reconstruction sanity check vs reported headlines.
  console.log('Per-strategy reconstruction (vs reported):');
  console.log('  ' + pad('strategy', 18) + pad('trades', 8) + pad('PnL', 12) + pad('PF', 8) + pad('DD%', 8) + pad('Sharpe', 10));
  for (const def of STRATEGIES) {
    const s = byStrategy[def.key];
    const meta = byKey.get(def.key).meta;
    console.log('  ' + pad(def.key, 18) + pad(s.trades + '/' + meta.reportedTrades, 8) +
      pad(fmtUsd(s.totalPnL) + '/' + fmtUsd(meta.reportedTotalPnL), 22) +
      pad(s.profitFactor + '/' + meta.reportedPF, 11));
    console.log('  ' + ' '.repeat(18) + 'DD% ' + s.maxDD_pct + '/' + meta.reportedDD + '  Sharpe ' + s.sharpe + '/' + meta.reportedSharpe);
  }

  // Concurrency histogram: how often does Model A actually use 2 or 3 contracts?
  const concur = concurrencyHistogram(allFlat);
  const totalMs = concur.reduce((s, c) => s + c.totalMs, 0);
  console.log();
  console.log('Concurrency dwell (fraction of total wall time at each open-position count):');
  for (const c of concur) {
    const frac = (c.totalMs / totalMs) * 100;
    console.log(`  ${c.concurrency} open: ${frac.toFixed(1)}% (${c.totalHours.toFixed(1)}h)`);
  }

  // Headline
  console.log();
  console.log('PORTFOLIO HEADLINE:');
  console.log('  trades:', portfolio.trades);
  console.log('  total PnL:', fmtUsd(portfolio.totalPnL));
  console.log('  win rate:', portfolio.winRate.toFixed(1) + '%');
  console.log('  profit factor:', portfolio.profitFactor.toFixed(2));
  console.log('  Sharpe (daily-PnL annualized):', portfolio.sharpe.toFixed(2));
  console.log('  Max DD (engine convention):', portfolio.maxDD_pct.toFixed(2) + '%', '(' + fmtUsd(portfolio.maxDD_usd) + ')');
  console.log('  avg hold:', portfolio.avgHoldMin.toFixed(1) + ' min');

  const sumOfBooks = Object.values(byStrategy).reduce((s, x) => s + x.totalPnL, 0);
  console.log();
  console.log(`  Sum of independent books: ${fmtUsd(sumOfBooks)}`);
  console.log(`  Sanity check: portfolio totalPnL = sum of books? ${Math.abs(portfolio.totalPnL - sumOfBooks) < 1 ? '✓' : '✗'}`);

  const out = {
    description: 'Model A: stacking baseline. Each strategy runs as an independent 1-NQ book.',
    headline: {
      trades: portfolio.trades,
      totalPnL: round(portfolio.totalPnL),
      winRate: round(portfolio.winRate, 2),
      profitFactor: round(portfolio.profitFactor, 2),
      sharpe: round(portfolio.sharpe, 2),
      maxDD_usd: round(portfolio.maxDD_usd),
      maxDD_pct: round(portfolio.maxDD_pct, 2),
      avgHoldMin: round(portfolio.avgHoldMin, 1),
    },
    byStrategy,
    concurrencyDwell: concur.map(c => ({
      concurrency: c.concurrency,
      totalHours: round(c.totalHours, 1),
      fractionPct: round((c.totalMs / totalMs) * 100, 2),
    })),
    equityCurveSampled: sampleCurve(portfolio.equityCurve, 1000).map(p => ({ t: p.t, equity: round(p.equity) })),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'model-a-portfolio.json'), JSON.stringify(out, null, 2));
  console.log();
  console.log('✓ Wrote output/model-a-portfolio.json');

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
