#!/usr/bin/env node
/**
 * Rank the MFE ratchet sweep results under a composite objective:
 *   Filter: PF >= MIN_PF (default 1.40)
 *   Primary rank: winnerCaptureRatio desc
 *   Secondary rank: Sharpe desc
 *   Tertiary view: totalPnL - 0.5 * |givebackDollars|
 *
 * Also computes simple Pareto frontier on (PF, totalPnL, winnerCaptureRatio).
 * Writes top-candidates.md to research/mfe-ratchet-gfi/.
 */

import fs from 'fs';
import path from 'path';

const OUT_DIR = path.resolve(new URL('.', import.meta.url).pathname, '..', 'research', 'mfe-ratchet-gfi');
const SUMMARY_PATH = path.join(OUT_DIR, 'sweep-summary.json');
const BASELINE_PATH = path.join(OUT_DIR, 'baseline-be70-5.json');
const OUT_PATH = path.join(OUT_DIR, 'top-candidates.md');

const MIN_PF = parseFloat(process.env.MIN_PF || '1.40');
const TOP_N = parseInt(process.env.TOP_N || '3', 10);

if (!fs.existsSync(SUMMARY_PATH)) {
  console.error(`Missing ${SUMMARY_PATH} — run sweep first.`);
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8')).filter(r => r.ok);
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const B = baseline.metrics;

const survivors = rows.filter(r => r.profitFactor >= MIN_PF);
const failed = rows.length - survivors.length;

const byCapture = survivors.slice().sort((a, b) => {
  if (b.winnerCaptureRatio !== a.winnerCaptureRatio) return b.winnerCaptureRatio - a.winnerCaptureRatio;
  return b.sharpeRatio - a.sharpeRatio;
});

const byCompositePnL = survivors.slice().sort((a, b) => {
  const aS = a.totalPnL - 0.5 * Math.abs(a.givebackDollarsWinners);
  const bS = b.totalPnL - 0.5 * Math.abs(b.givebackDollarsWinners);
  return bS - aS;
});

function paretoFrontier(rows, dims) {
  return rows.filter(r =>
    !rows.some(o => o !== r && dims.every(d => o[d] >= r[d]) && dims.some(d => o[d] > r[d]))
  );
}
const pareto = paretoFrontier(survivors, ['profitFactor', 'totalPnL', 'winnerCaptureRatio']);

const fmt = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : 'n/a');
const dollarFmt = (n) => '$' + Math.round(n).toLocaleString();

function metricRow(label, baselineVal, candidateVal, isPercent = false, isDollar = false) {
  const delta = candidateVal - baselineVal;
  const sign = delta >= 0 ? '+' : '';
  const f = isPercent ? `${fmt(candidateVal)}%` : isDollar ? dollarFmt(candidateVal) : fmt(candidateVal);
  const d = isPercent ? `${sign}${fmt(delta)}pp` : isDollar ? `${sign}${dollarFmt(delta)}` : `${sign}${fmt(delta)}`;
  return `| ${label} | ${isPercent ? fmt(baselineVal) + '%' : isDollar ? dollarFmt(baselineVal) : fmt(baselineVal)} | ${f} | ${d} |`;
}

function renderCandidate(r, label) {
  return `### ${label}: \`${r.id}\` (tiers: ${r.tiers})

| Metric | Baseline (BE 70/+5) | Candidate | Δ |
|---|---:|---:|---:|
${metricRow('Trades', B.totalTrades, r.totalTrades)}
${metricRow('Win Rate', B.winRate, r.winRate, true)}
${metricRow('Profit Factor', B.profitFactor, r.profitFactor)}
${metricRow('Sharpe', B.sharpeRatio, r.sharpeRatio)}
${metricRow('Max DD %', B.maxDrawdownPct, r.maxDrawdownPct, true)}
${metricRow('Total PnL', B.totalPnL, r.totalPnL, false, true)}
${metricRow('Avg Winner MFE', B.totalWinnerMFE_pts / B.winners, r.avgWinnerMFE)}
${metricRow('Avg Giveback', B.totalGiveback_pts / B.totalTrades, r.avgProfitGiveBack)}
${metricRow('Winner Capture %', B.winnerCaptureRatio, r.winnerCaptureRatio, true)}
${metricRow('BE-Clip count', B.beClipCount_MFE70_exit_under30, r.beClipCount)}
${metricRow('Big-BE-Clip', B.bigBeClipCount_MFE100_exit_under50, r.bigBeClipCount)}
${metricRow('MFE→SL count', B.mfeToSLCount_MFE50_exit_full_SL, r.mfeToSLCount)}
${metricRow('Giveback $', B.givebackDollars, r.givebackDollarsWinners, false, true)}
`;
}

const lines = [
  `# MFE Ratchet Sweep — Top Candidates`,
  '',
  `Sweep window: ${baseline.period}`,
  `PF floor: ${MIN_PF}`,
  `Configs tested: ${rows.length} | Passed PF floor: ${survivors.length} | Failed: ${failed}`,
  '',
  `Objective ordering:`,
  `1. **Primary**: winnerCaptureRatio (% of favorable MFE on winners that we monetized)`,
  `2. **Tiebreaker**: Sharpe ratio (smoothness)`,
  `3. **Secondary view**: composite PnL = totalPnL − 0.5 × |giveback $|`,
  '',
  `## Baseline reference (current live BE 70/+5)`,
  '',
  '```json',
  JSON.stringify(B, null, 2),
  '```',
  '',
  `## Top ${TOP_N} by Winner Capture Ratio`,
  '',
  ...byCapture.slice(0, TOP_N).map((r, i) => renderCandidate(r, `#${i + 1}`)),
  '',
  `## Top ${TOP_N} by composite PnL (PnL − 0.5 × |giveback|)`,
  '',
  ...byCompositePnL.slice(0, TOP_N).map((r, i) => renderCandidate(r, `#${i + 1}`)),
  '',
  `## Pareto frontier (PF × PnL × Capture)`,
  '',
  pareto.length
    ? '| id | tiers | trades | PF | Sharpe | DD% | PnL | Capture% | BE-clip | MFE→SL |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n' +
      pareto.map(r => `| ${r.id} | ${r.tiers} | ${r.totalTrades} | ${fmt(r.profitFactor)} | ${fmt(r.sharpeRatio)} | ${fmt(r.maxDrawdownPct)} | ${dollarFmt(r.totalPnL)} | ${fmt(r.winnerCaptureRatio)} | ${r.beClipCount} | ${r.mfeToSLCount} |`).join('\n')
    : '_no survivors_',
  '',
  `## All survivors (sorted by capture ratio)`,
  '',
  '| id | tiers | trades | PF | Sharpe | DD% | PnL | Capture% | Giveback$ | BE-clip | MFE→SL |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...byCapture.map(r => `| ${r.id} | ${r.tiers} | ${r.totalTrades} | ${fmt(r.profitFactor)} | ${fmt(r.sharpeRatio)} | ${fmt(r.maxDrawdownPct)} | ${dollarFmt(r.totalPnL)} | ${fmt(r.winnerCaptureRatio)} | ${dollarFmt(r.givebackDollarsWinners)} | ${r.beClipCount} | ${r.mfeToSLCount} |`),
  '',
];

if (failed > 0) {
  lines.push(`## Configs that failed PF floor (PF < ${MIN_PF})`);
  lines.push('');
  lines.push('| id | tiers | trades | PF | PnL |');
  lines.push('|---|---|---:|---:|---:|');
  for (const r of rows.filter(r => r.profitFactor < MIN_PF).sort((a, b) => b.profitFactor - a.profitFactor)) {
    lines.push(`| ${r.id} | ${r.tiers} | ${r.totalTrades} | ${fmt(r.profitFactor)} | ${dollarFmt(r.totalPnL)} |`);
  }
  lines.push('');
}

fs.writeFileSync(OUT_PATH, lines.join('\n'));
console.log(`Wrote ${OUT_PATH}`);

// Also emit the top-3 by capture as a machine-readable file for M5 today-replay
const topForReplay = byCapture.slice(0, TOP_N).map(r => ({ id: r.id, tiers: r.tiers, source: 'capture' }));
const topByCompositeForReplay = byCompositePnL.slice(0, TOP_N).map(r => ({ id: r.id, tiers: r.tiers, source: 'composite' }));
const seen = new Set();
const merged = [];
for (const item of [...topForReplay, ...topByCompositeForReplay]) {
  if (!seen.has(item.id)) {
    seen.add(item.id);
    merged.push(item);
  }
}
fs.writeFileSync(path.join(OUT_DIR, 'top-candidates-for-replay.json'), JSON.stringify(merged, null, 2));
console.log(`Wrote top-candidates-for-replay.json (${merged.length} configs)`);
