#!/usr/bin/env node
// 04: Model B — single shared 1-NQ position. Drive the merged trade timeline through
// each candidate rule and compute portfolio metrics. Output a head-to-head comparison
// CSV and per-rule trade audit logs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll, STRATEGIES } from './lib/load-trades.js';
import { calculateMetrics, fmtUsd, round } from './lib/metrics.js';
import { writeCsv } from './lib/csv.js';
import { fmtET } from './lib/et-time.js';

import { simulate } from './rules/_base.js';
import { firstInWins } from './rules/first-in-wins.js';
import { flipOnConflict } from './rules/flip-on-conflict.js';
import { confluenceFirstExit, confluenceLastExit } from './rules/confluence-only.js';
import { priorityWeighted } from './rules/priority-weighted.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function pad(s, n) { return String(s).padEnd(n); }

const RULES = [firstInWins, flipOnConflict, confluenceFirstExit, confluenceLastExit, priorityWeighted];

// Per-strategy reconstruction info — surfaces how many trades each strategy loses to
// its OWN internal overlap under a single-slot model. (gex-flip-ivpct's long-hold
// trades overlap each other heavily; the engine simulates each in isolation, so the
// gold-standard JSON's totalPnL assumes stacking even within strategy.)
function reportIntraStrategySlotCost(byKey) {
  console.log('Intra-strategy slot cost (under single-position semantics, before cross-strategy interaction):');
  console.log('  Each strategy is run alone through first-in-wins. Trades rejected = trades that');
  console.log('  would have overlapped one of its OWN earlier trades and competed for the slot.');
  console.log();
  console.log('  ' + pad('strategy', 18) + pad('reported PnL', 16) + pad('single-slot PnL', 18) + pad('intra-overlap loss', 24));
  for (const def of STRATEGIES) {
    const trades = byKey.get(def.key).trades;
    const state = simulate(trades, firstInWins);
    const reconstructedPnL = state.realizedTrades.reduce((s, r) => s + r.netPnL, 0);
    const reported = byKey.get(def.key).meta.reportedTotalPnL;
    const lossPct = reported === 0 ? 0 : ((reported - reconstructedPnL) / reported) * 100;
    console.log('  ' +
      pad(def.key, 18) +
      pad(fmtUsd(reported), 16) +
      pad(fmtUsd(reconstructedPnL) + ` (${state.accepted}/${trades.length})`, 18) +
      pad(fmtUsd(reported - reconstructedPnL) + ` (${lossPct.toFixed(0)}%)`, 24));
  }
  console.log();
}

export function main() {
  const { byKey, allFlat } = loadAll();

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Step 04: Model B — Single Shared Position, Candidate Rule Compare');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();

  reportIntraStrategySlotCost(byKey);

  const summaryRows = [];
  const ruleResults = {};

  for (const rule of RULES) {
    const state = simulate(allFlat, rule);
    const metrics = calculateMetrics(state.realizedTrades);
    ruleResults[rule.name] = { state, metrics };

    const totalSignals = state.accepted + state.rejected;
    summaryRows.push({
      rule: rule.name,
      trades: metrics.trades,
      winRate_pct: round(metrics.winRate, 1),
      profitFactor: round(metrics.profitFactor, 2),
      sharpe: round(metrics.sharpe, 2),
      maxDD_usd: round(metrics.maxDD_usd),
      maxDD_pct: round(metrics.maxDD_pct, 2),
      totalPnL: round(metrics.totalPnL),
      avgPnL: round(metrics.avgPnL),
      avgHoldMin: round(metrics.avgHoldMin, 1),
      signalsConsidered: totalSignals,
      accepted: state.accepted,
      rejected: state.rejected,
      acceptedFraction: round(state.accepted / Math.max(1, totalSignals), 3),
      syntheticExits: state.syntheticExits,
      syntheticFraction: round(state.syntheticExits / Math.max(1, metrics.trades), 3),
    });

    // Per-rule trade audit log.
    const rows = state.realizedTrades.map(r => ({
      portfolioId: r.portfolioId,
      strategyKey: r.strategyKey,
      nativeId: r.nativeId,
      side: r.side,
      entryTime_et: fmtET(r.entryTime),
      exitTime_et: fmtET(r.exitTime),
      actualEntry: r.actualEntry,
      actualExit: round(r.actualExit, 2),
      netPnL: round(r.netPnL),
      pointsPnL: round(r.pointsPnL, 2),
      exitReason: r.exitReason,
      durationMin: round(r.duration / 60000, 1),
      synthetic: r.synthetic ? 1 : 0,
    }));
    const HDR = ['portfolioId','strategyKey','nativeId','side','entryTime_et','exitTime_et','actualEntry','actualExit','netPnL','pointsPnL','exitReason','durationMin','synthetic'];
    writeCsv(path.join(OUT_DIR, `model-b-${rule.name}-trades.csv`), HDR, rows);
  }

  // ── Console summary ────────────────────────────────────────────────────
  console.log('Rule comparison (Model B, single shared 1-NQ position):');
  console.log();
  console.log('  ' + pad('rule', 28) + pad('trades', 8) + pad('WR%', 7) + pad('PF', 7) + pad('Sharpe', 8) + pad('DD%', 8) + pad('totalPnL', 12) + pad('synth%', 8) + pad('accept%', 8));
  for (const r of summaryRows) {
    console.log('  ' + pad(r.rule, 28) + pad(r.trades, 8) + pad(r.winRate_pct, 7) + pad(r.profitFactor, 7) + pad(r.sharpe, 8) + pad(r.maxDD_pct, 8) + pad(fmtUsd(r.totalPnL), 12) + pad((r.syntheticFraction * 100).toFixed(0) + '%', 8) + pad((r.acceptedFraction * 100).toFixed(0) + '%', 8));
  }

  // Strategy-of-origin attribution (for each rule, how is the portfolio P&L split?).
  console.log();
  console.log('Strategy-of-origin PnL contribution by rule:');
  console.log('  ' + pad('rule', 28) + pad('flip', 14) + pad('lt-3m', 14) + pad('level-fade', 14));
  for (const rule of RULES) {
    const trades = ruleResults[rule.name].state.realizedTrades;
    const byOrigin = { 'gex-flip-ivpct': 0, 'gex-lt-3m': 0, 'gex-level-fade': 0 };
    for (const t of trades) byOrigin[t.strategyKey] = (byOrigin[t.strategyKey] || 0) + t.netPnL;
    console.log('  ' + pad(rule.name, 28) +
      pad(fmtUsd(byOrigin['gex-flip-ivpct']), 14) +
      pad(fmtUsd(byOrigin['gex-lt-3m']), 14) +
      pad(fmtUsd(byOrigin['gex-level-fade']), 14));
  }

  // ── Write rule-comparison CSV ──────────────────────────────────────────
  const CHDR = ['rule','trades','winRate_pct','profitFactor','sharpe','maxDD_usd','maxDD_pct','totalPnL','avgPnL','avgHoldMin','signalsConsidered','accepted','rejected','acceptedFraction','syntheticExits','syntheticFraction'];
  writeCsv(path.join(OUT_DIR, 'model-b-rule-comparison.csv'), CHDR, summaryRows);
  console.log();
  console.log('✓ Wrote output/model-b-rule-comparison.csv');
  console.log(`✓ Wrote per-rule audit logs (output/model-b-<rule>-trades.csv)`);

  return { summaryRows, ruleResults };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
