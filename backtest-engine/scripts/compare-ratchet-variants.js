#!/usr/bin/env node
/**
 * Print a side-by-side comparison of baseline, best pure-MFE ratchet, and
 * structural-magnet ratchet on the headline metrics. Reads:
 *   - baseline-be70-5.json
 *   - runs/s1-m70l40.json   (best pure-MFE by composite ranking)
 *   - runs/s1-m100l40.json  (best pure-MFE by winnerCaptureRatio)
 *   - runs/structural-magnet-default.json (structural 75% lock)
 *
 * Writes a Markdown table to research/mfe-ratchet-gfi/comparison.md.
 */

import fs from 'fs';
import path from 'path';

const OUT_DIR = path.resolve(new URL('.', import.meta.url).pathname, '..', 'research', 'mfe-ratchet-gfi');
const RUNS = path.join(OUT_DIR, 'runs');

function loadBaseline() {
  const b = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'baseline-be70-5.json'), 'utf8'));
  return {
    label: 'Baseline (BE 70/+5)',
    totalTrades: b.metrics.totalTrades,
    winRate: b.metrics.winRate,
    profitFactor: b.metrics.profitFactor,
    sharpeRatio: b.metrics.sharpeRatio,
    maxDrawdownPct: b.metrics.maxDrawdownPct,
    totalPnL: b.metrics.totalPnL,
    avgWinnerMFE: b.metrics.totalWinnerMFE_pts / b.metrics.winners,
    winnerCaptureRatio: b.metrics.winnerCaptureRatio,
    beClipCount: b.metrics.beClipCount_MFE70_exit_under30,
    bigBeClipCount: b.metrics.bigBeClipCount_MFE100_exit_under50,
    mfeToSLCount: b.metrics.mfeToSLCount_MFE50_exit_full_SL,
    givebackDollars: b.metrics.givebackDollars,
  };
}

function loadRun(filename, label) {
  const fp = path.join(RUNS, filename);
  if (!fs.existsSync(fp)) {
    console.warn(`Skipping ${filename} — not present`);
    return null;
  }
  const r = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const b = r.performance.basic;
  const risk = r.performance.risk;
  const dd = r.performance.drawdown;
  return {
    label,
    totalTrades: b.totalTrades,
    winRate: b.winRate,
    profitFactor: b.profitFactor,
    sharpeRatio: risk.sharpeRatio,
    maxDrawdownPct: dd.maxDrawdown,
    totalPnL: b.totalPnL,
    avgWinnerMFE: b.avgWinnerMFE,
    winnerCaptureRatio: b.winnerCaptureRatio,
    beClipCount: b.beClipCount,
    bigBeClipCount: b.bigBeClipCount,
    mfeToSLCount: b.mfeToSLCount,
    givebackDollars: b.givebackDollarsWinners,
  };
}

function fmt(n, d = 2) { return typeof n === 'number' ? n.toFixed(d) : 'n/a'; }
function dollar(n) { return '$' + Math.round(n).toLocaleString(); }

const rows = [
  loadBaseline(),
  loadRun('s1-m70l40.json',                   'Pure ratchet s1-m70l40 (best pure PnL)'),
  loadRun('s1-m100l40.json',                  'Pure ratchet s1-m100l40 (best pure capture)'),
  loadRun('struct-l95-r2h.json',              'Structural 95% / 2h (running-mode winner)'),
  loadRun('fixed-l40-r2h.json',               'Fixed-per-tier 40% / 2h (fixed winner)'),
  loadRun('fixed-l40-r4h.json',               'Fixed-per-tier 40% / 4h (lowest DD)'),
  loadRun('fixed-l50-r2h.json',               'Fixed-per-tier 50% / 2h'),
  loadRun('fixed-l60-r2h.json',               'Fixed-per-tier 60% / 2h'),
].filter(Boolean);

const cols = [
  ['Trades', r => r.totalTrades],
  ['Win Rate', r => fmt(r.winRate) + '%'],
  ['Profit Factor', r => fmt(r.profitFactor)],
  ['Sharpe', r => fmt(r.sharpeRatio)],
  ['MaxDD %', r => fmt(r.maxDrawdownPct) + '%'],
  ['Total PnL', r => dollar(r.totalPnL)],
  ['Avg Winner MFE', r => fmt(r.avgWinnerMFE)],
  ['Winner Capture %', r => fmt(r.winnerCaptureRatio) + '%'],
  ['BE-Clip', r => r.beClipCount],
  ['Big-BE-Clip', r => r.bigBeClipCount],
  ['MFE→SL', r => r.mfeToSLCount],
  ['Giveback $', r => dollar(r.givebackDollars)],
];

const lines = [
  '# Ratchet Variant Comparison',
  '',
  '16-month gex-flip-ivpct backtest (2025-01-13 → 2026-04-20)',
  '',
  '| Metric | ' + rows.map(r => r.label).join(' | ') + ' |',
  '|---|' + rows.map(() => '---:').join('|') + '|',
  ...cols.map(([name, get]) => `| ${name} | ${rows.map(r => get(r)).join(' | ')} |`),
  '',
];

fs.writeFileSync(path.join(OUT_DIR, 'comparison.md'), lines.join('\n'));
console.log(`Wrote ${path.join(OUT_DIR, 'comparison.md')}`);
console.log(lines.join('\n'));
