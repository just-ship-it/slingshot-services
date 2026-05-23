#!/usr/bin/env node
// 4-strategy portfolio simulation — first-come-first-serve, single 1-NQ slot.
//
// Compares:
//   A) "WITH lstb"     — all 4 strategies competing for the slot.
//   B) "WITHOUT lstb"  — 3-strategy baseline (gex-flip-ivpct, gex-lt-3m, gex-level-fade).
//
// Uses the current gold-standard JSONs (v2/v3) for each strategy. Reuses the
// existing event-driven simulator at research/multi-strategy-rules/rules/_base.js
// and its first-in-wins rule. No synthetic exits — once a position is held, we
// wait for its native exit to free the slot.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics, fmtUsd, round } from '../multi-strategy-rules/lib/metrics.js';
import { fmtET, fmtETDate, fmtETMonth } from '../multi-strategy-rules/lib/et-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const OUT_DIR   = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Strategy registry ─────────────────────────────────────────────────────
// Priority is consulted only when two strategies signal at the SAME ms (rare).
// Higher live Sharpe → wins ties. Reverse-priority numerically: lower = better.
// `--strict-fill` swaps the JSON paths to the strict-fill backtest variants
// (low<entry / high>entry trade-through model — FIFO-conservative).
const STRICT = process.argv.includes('--strict-fill');
const suf = STRICT ? '-strict-fill' : '';
const STRATEGIES = [
  { key: 'lstb',           label: 'LS_FLIP_TRIGGER_BAR', priority: 1, file: `data/gold-standard/ls-flip-trigger-bar-v3${suf}.json` },
  { key: 'gex-lt-3m',      label: 'GEX_LT_3M_CROSSOVER', priority: 2, file: `data/gold-standard/gex-lt-3m-crossover-v3${suf}.json` },
  { key: 'gex-flip-ivpct', label: 'GEX_FLIP_IVPCT',      priority: 3, file: `data/gold-standard/gex-flip-ivpct-v2${suf}.json` },
  { key: 'gex-level-fade', label: 'GEX_LEVEL_FADE',      priority: 4, file: `data/gold-standard/gex-level-fade-v2${suf}.json` },
];

const POINT_VALUE_NQ = 20;
const COMMISSION_NQ  = 5;

function normSide(s) {
  if (!s) return null;
  const l = String(s).toLowerCase();
  if (l === 'long' || l === 'buy') return 'long';
  if (l === 'short' || l === 'sell') return 'short';
  return null;
}

function normalize(trade, strategyKey) {
  const entryTime = trade.entryTime;
  // Defensive: a handful of lstb trades have exitTime <= entryTime (EOD liquidations
  // timestamped at the EOD cutoff even though the entry fired slightly after). If we
  // don't clamp, the event-driven sort consumes the exit BEFORE the entry, leaving
  // the slot held forever. Push exit to entry+1ms; PnL is unaffected.
  const rawExit   = trade.exitTime ?? (entryTime + (trade.duration ?? 0));
  const exitTime  = rawExit <= entryTime ? entryTime + 1 : rawExit;
  return {
    id: `${strategyKey}:${trade.id}`,
    nativeId: trade.id,
    strategyKey,
    side: normSide(trade.side),
    entryTime,
    exitTime,
    duration: trade.duration ?? (exitTime - entryTime),
    actualEntry: trade.actualEntry ?? trade.entryPrice,
    actualExit: trade.actualExit,
    netPnL: trade.netPnL,
    pointsPnL: trade.pointsPnL,
    exitReason: trade.exitReason,
    commission: trade.commission ?? COMMISSION_NQ,
    pointValue: trade.pointValue ?? POINT_VALUE_NQ,
    status: trade.status,
  };
}

function loadOne(def) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  const filtered = raw.trades
    .filter(t => t.status === 'completed')
    .filter(t => t.entryTime != null && t.exitTime != null)
    .filter(t => normSide(t.side) != null);
  const clamped = filtered.filter(t => (t.exitTime ?? 0) <= t.entryTime).length;
  if (clamped > 0) console.log(`  ⚠ ${def.key}: clamped ${clamped} trade(s) with exitTime ≤ entryTime → exitTime = entryTime+1ms`);
  const trades = filtered.map(t => normalize(t, def.key));
  const perf = raw.performance?.summary || raw.performance?.basic || {};
  return {
    def,
    trades,
    reported: {
      totalPnL: perf.totalPnL,
      trades: perf.totalTrades,
      // `profitFactor` lives in `performance.basic`, others in `performance.summary`.
      profitFactor: raw.performance?.basic?.profitFactor ?? perf.profitFactor,
      sharpe: perf.sharpeRatio,
      maxDD_pct: perf.maxDrawdown,
      winRate: perf.winRate,
    },
  };
}

// `_base.js` reads priority via `priorityFor()` imported from `multi-strategy-rules/lib/load-trades.js`,
// which only knows the 3 original strategies. Override the trade ordering ourselves
// by writing a custom event sort, or pass priority through directly. The simplest
// approach: prefix trade `id` with priority so the existing default ordering at
// equal ts still works. But that hits the priorityFor() lookup inside _base.js,
// which returns 999 for unknown keys → ties broken arbitrarily.
//
// In practice: identical-ms entry signals across these 4 strategies are vanishingly
// rare on real data; we accept the default tiebreak. The slot mechanic is unaffected.

// First-in-wins rule, copied locally (no need to import — keeps this file self-contained).
const firstInWins = {
  name: 'first-in-wins',
  onSignal(state, trade) {
    if (state.position == null) open(state, trade);
    else reject(state);
  },
  onNativeExit(state, trade) {
    if (state.position && state.position.trade.id === trade.id) {
      realizeNativeClose(state, trade);
    }
  },
};

// ── Simulator wrapper ─────────────────────────────────────────────────────
function runScenario(allTrades, label) {
  const state = simulate(allTrades, firstInWins);
  const metrics = calculateMetrics(state.realizedTrades);

  // Per-strategy origin attribution.
  const byOrigin = {};
  const byOriginAccepted = {};
  for (const def of STRATEGIES) {
    byOrigin[def.key] = 0;
    byOriginAccepted[def.key] = 0;
  }
  for (const t of state.realizedTrades) {
    byOrigin[t.strategyKey] = (byOrigin[t.strategyKey] || 0) + t.netPnL;
    byOriginAccepted[t.strategyKey] = (byOriginAccepted[t.strategyKey] || 0) + 1;
  }

  return { label, state, metrics, byOrigin, byOriginAccepted, totalSignals: allTrades.length };
}

// ── Main ──────────────────────────────────────────────────────────────────
function pad(s, n) { return String(s).padEnd(n); }

function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  4-Strategy Portfolio (FCFS, single 1-NQ slot)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();

  const loaded = STRATEGIES.map(loadOne);

  // ── Per-strategy summary table ──────────────────────────────────────────
  console.log('Per-strategy gold-standard (standalone):');
  console.log('  ' + pad('strategy', 22) + pad('trades', 9) + pad('PF', 7) + pad('Sharpe', 9) + pad('DD%', 8) + pad('totalPnL', 14) + pad('span', 22));
  let standaloneSum = 0;
  for (const l of loaded) {
    const first = new Date(Math.min(...l.trades.map(t => t.entryTime)));
    const last  = new Date(Math.max(...l.trades.map(t => t.exitTime)));
    standaloneSum += l.reported.totalPnL || 0;
    console.log('  ' +
      pad(l.def.key, 22) +
      pad(l.trades.length, 9) +
      pad(round(l.reported.profitFactor, 2), 7) +
      pad(round(l.reported.sharpe, 2), 9) +
      pad(round(l.reported.maxDD_pct, 2), 8) +
      pad(fmtUsd(l.reported.totalPnL), 14) +
      pad(`${fmtETDate(first.getTime())} → ${fmtETDate(last.getTime())}`, 22));
  }
  console.log('  ' + pad('SUM standalone (stacked, no slot)', 38) + pad('', 9 + 7 + 9 + 8) + fmtUsd(standaloneSum));
  console.log();

  // ── Build trade pools ───────────────────────────────────────────────────
  const allFourTrades = [];
  for (const l of loaded) allFourTrades.push(...l.trades);
  allFourTrades.sort((a, b) => a.entryTime - b.entryTime);

  const threeWithoutLstb = allFourTrades.filter(t => t.strategyKey !== 'lstb');

  // ── Run both scenarios ─────────────────────────────────────────────────
  const A = runScenario(allFourTrades,    '4-strategy (WITH lstb)');
  const B = runScenario(threeWithoutLstb, '3-strategy (WITHOUT lstb)');

  console.log('Portfolio comparison (single shared 1-NQ slot, first-in-wins):');
  console.log();
  const header = '  ' + pad('scenario', 28) + pad('signals', 10) + pad('accepted', 10) + pad('rejected', 10) + pad('trades', 9) + pad('WR%', 7) + pad('PF', 7) + pad('Sharpe', 9) + pad('DD%', 8) + pad('totalPnL', 14);
  console.log(header);
  for (const r of [B, A]) {
    console.log('  ' +
      pad(r.label, 28) +
      pad(r.totalSignals, 10) +
      pad(r.state.accepted, 10) +
      pad(r.state.rejected, 10) +
      pad(r.metrics.trades, 9) +
      pad(round(r.metrics.winRate, 1), 7) +
      pad(round(r.metrics.profitFactor, 2), 7) +
      pad(round(r.metrics.sharpe, 2), 9) +
      pad(round(r.metrics.maxDD_pct, 2), 8) +
      pad(fmtUsd(r.metrics.totalPnL), 14));
  }
  console.log();
  const deltaPnL = A.metrics.totalPnL - B.metrics.totalPnL;
  console.log(`  Δ (A − B) PnL: ${fmtUsd(deltaPnL)}   (positive → lstb is additive; negative → lstb is net-harmful in portfolio)`);
  console.log();

  // ── Per-strategy origin attribution ────────────────────────────────────
  console.log('Per-strategy origin contribution (accepted trades × their native PnL):');
  console.log();
  console.log('  ' + pad('strategy', 22) + pad('standalone PnL', 16) + pad('B accepted', 12) + pad('B PnL', 14) + pad('A accepted', 12) + pad('A PnL', 14));
  for (const def of STRATEGIES) {
    const standaloneTrades = loaded.find(l => l.def.key === def.key).trades.length;
    const standalonePnL    = loaded.find(l => l.def.key === def.key).reported.totalPnL || 0;
    console.log('  ' +
      pad(def.key, 22) +
      pad(`${fmtUsd(standalonePnL)} (${standaloneTrades})`, 16) +
      pad(B.byOriginAccepted[def.key] || 0, 12) +
      pad(fmtUsd(B.byOrigin[def.key] || 0), 14) +
      pad(A.byOriginAccepted[def.key] || 0, 12) +
      pad(fmtUsd(A.byOrigin[def.key] || 0), 14));
  }
  console.log();

  // ── Displacement attribution: which non-lstb signals does lstb block? ──
  // Trades accepted in B (3-strategy) for non-lstb keys that DON'T appear
  // among A's accepted set are the ones displaced by lstb.
  const acceptedA = new Set(A.state.realizedTrades.map(r => `${r.strategyKey}:${r.nativeId}`));
  const acceptedB = B.state.realizedTrades;

  const displacedFromB = acceptedB.filter(r => !acceptedA.has(`${r.strategyKey}:${r.nativeId}`));
  const displacedPnL   = displacedFromB.reduce((s, r) => s + r.netPnL, 0);
  const displacedByKey = {};
  for (const r of displacedFromB) {
    if (!displacedByKey[r.strategyKey]) displacedByKey[r.strategyKey] = { n: 0, pnl: 0 };
    displacedByKey[r.strategyKey].n += 1;
    displacedByKey[r.strategyKey].pnl += r.netPnL;
  }
  console.log('Displacement attribution (non-lstb trades accepted in B but NOT in A):');
  console.log('  ' + pad('strategy', 22) + pad('# displaced', 14) + pad('PnL lost', 14));
  for (const def of STRATEGIES.filter(d => d.key !== 'lstb')) {
    const d = displacedByKey[def.key] || { n: 0, pnl: 0 };
    console.log('  ' + pad(def.key, 22) + pad(d.n, 14) + pad(fmtUsd(d.pnl), 14));
  }
  console.log('  ' + pad('TOTAL displaced from B', 22) + pad(displacedFromB.length, 14) + pad(fmtUsd(displacedPnL), 14));
  console.log();

  // Conversely, A-accepted lstb trades and their PnL.
  const acceptedB_set = new Set(B.state.realizedTrades.map(r => `${r.strategyKey}:${r.nativeId}`));
  const newInA = A.state.realizedTrades.filter(r => !acceptedB_set.has(`${r.strategyKey}:${r.nativeId}`));
  const newInA_byKey = {};
  for (const r of newInA) {
    if (!newInA_byKey[r.strategyKey]) newInA_byKey[r.strategyKey] = { n: 0, pnl: 0 };
    newInA_byKey[r.strategyKey].n += 1;
    newInA_byKey[r.strategyKey].pnl += r.netPnL;
  }
  console.log('New-in-A vs B (mostly lstb adds; some non-lstb may shift):');
  console.log('  ' + pad('strategy', 22) + pad('# new', 14) + pad('PnL added', 14));
  for (const def of STRATEGIES) {
    const d = newInA_byKey[def.key] || { n: 0, pnl: 0 };
    if (d.n === 0) continue;
    console.log('  ' + pad(def.key, 22) + pad(d.n, 14) + pad(fmtUsd(d.pnl), 14));
  }
  const netAddedPnL = newInA.reduce((s, r) => s + r.netPnL, 0);
  console.log('  ' + pad('TOTAL new in A', 22) + pad(newInA.length, 14) + pad(fmtUsd(netAddedPnL), 14));
  console.log();
  console.log(`  Sanity: ΔPnL = new-in-A PnL − displaced-from-B PnL = ${fmtUsd(netAddedPnL - displacedPnL)} (matches Δ above)`);
  console.log();

  // ── Write CSV trade logs ───────────────────────────────────────────────
  writeTradeCsv(path.join(OUT_DIR, 'A-with-lstb-trades.csv'), A.state.realizedTrades);
  writeTradeCsv(path.join(OUT_DIR, 'B-without-lstb-trades.csv'), B.state.realizedTrades);
  writeTradeCsv(path.join(OUT_DIR, 'A-displaced-from-B.csv'), displacedFromB);
  console.log(`✓ Wrote ${OUT_DIR}/A-with-lstb-trades.csv (${A.state.realizedTrades.length} rows)`);
  console.log(`✓ Wrote ${OUT_DIR}/B-without-lstb-trades.csv (${B.state.realizedTrades.length} rows)`);
  console.log(`✓ Wrote ${OUT_DIR}/A-displaced-from-B.csv (${displacedFromB.length} rows)`);

  // Monthly PnL breakdowns for both scenarios — useful for spotting when lstb hurts.
  writeMonthlyCsv(path.join(OUT_DIR, 'monthly-pnl-by-scenario.csv'), A.state.realizedTrades, B.state.realizedTrades);
  console.log(`✓ Wrote ${OUT_DIR}/monthly-pnl-by-scenario.csv`);

  return { A, B };
}

function writeTradeCsv(filePath, rows) {
  const HDR = ['portfolioId','strategyKey','nativeId','side','entryTime_et','exitTime_et','actualEntry','actualExit','netPnL','pointsPnL','exitReason','durationMin'];
  const lines = [HDR.join(',')];
  for (const r of rows) {
    lines.push([
      r.portfolioId,
      r.strategyKey,
      r.nativeId,
      r.side,
      fmtET(r.entryTime),
      fmtET(r.exitTime),
      r.actualEntry,
      round(r.actualExit, 2),
      round(r.netPnL),
      round(r.pointsPnL, 2),
      r.exitReason,
      round((r.duration || 0) / 60000, 1),
    ].join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function writeMonthlyCsv(filePath, aTrades, bTrades) {
  const ym = new Set();
  const byMonthA = new Map();
  const byMonthB = new Map();
  for (const t of aTrades) {
    const m = fmtETMonth(t.exitTime);
    ym.add(m);
    byMonthA.set(m, (byMonthA.get(m) || 0) + t.netPnL);
  }
  for (const t of bTrades) {
    const m = fmtETMonth(t.exitTime);
    ym.add(m);
    byMonthB.set(m, (byMonthB.get(m) || 0) + t.netPnL);
  }
  const months = [...ym].sort();
  const lines = ['month,B_no_lstb_pnl,A_with_lstb_pnl,delta_A_minus_B'];
  for (const m of months) {
    const a = byMonthA.get(m) || 0;
    const b = byMonthB.get(m) || 0;
    lines.push([m, round(b), round(a), round(a - b)].join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
