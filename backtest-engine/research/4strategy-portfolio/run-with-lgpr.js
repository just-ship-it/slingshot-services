#!/usr/bin/env node
// 5-strategy FCFS check: layer lt-gex-path-race (v1 / v1-ES) over the
// 4-strategy gold-standard book on the single 1-NQ slot.
//
// Scenarios:
//   A) 4-strategy baseline (current book)
//   B) 5-strategy with lgpr v1        (172 window trades, holds up to 8h)
//   C) 5-strategy with lgpr v1-ES     (38 window trades; ES data walls 2026-01)
//   D) 2-slot alternative: baseline book on its own slot + lgpr independent
//
// Same conventions as run.js: standalone gold trade lists, first-in-wins by
// entryTime, slot occupied [entryTime, exitTime). lgpr priority = 5 (ties only).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics, fmtUsd, round } from '../multi-strategy-rules/lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const BOOK = [
  { key: 'lstb',           file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m',      file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const LGPR    = { key: 'lgpr-v1',    file: 'data/gold-standard/lt-gex-path-race-v1-window.json' };
const LGPR_ES = { key: 'lgpr-v1es',  file: 'data/gold-standard/lt-gex-path-race-v1-es-window.json' };

function normSide(s) {
  const l = String(s || '').toLowerCase();
  return l === 'long' || l === 'buy' ? 'long' : l === 'short' || l === 'sell' ? 'short' : null;
}

function loadTrades(def) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  return raw.trades
    .filter(t => t.status === 'completed' && t.entryTime != null && t.exitTime != null && normSide(t.side))
    .map(t => ({
      id: `${def.key}:${t.id}`,
      nativeId: t.id,
      strategyKey: def.key,
      side: normSide(t.side),
      entryTime: t.entryTime,
      exitTime: t.exitTime <= t.entryTime ? t.entryTime + 1 : t.exitTime,
      duration: t.duration ?? (t.exitTime - t.entryTime),
      actualEntry: t.actualEntry ?? t.entryPrice,
      actualExit: t.actualExit,
      netPnL: t.netPnL,
      pointsPnL: t.pointsPnL,
      exitReason: t.exitReason,
      commission: t.commission ?? 5,
      pointValue: t.pointValue ?? 20,
      status: t.status,
    }));
}

const firstInWins = {
  name: 'first-in-wins',
  onSignal(state, trade) {
    if (state.position == null) open(state, trade);
    else reject(state);
  },
  onNativeExit(state, trade) {
    if (state.position && state.position.trade.id === trade.id) realizeNativeClose(state, trade);
  },
};

function runScenario(pool, label) {
  const trades = [...pool].sort((a, b) => a.entryTime - b.entryTime);
  const state = simulate(trades, firstInWins);
  const metrics = calculateMetrics(state.realizedTrades);
  const byOrigin = {};
  for (const t of state.realizedTrades) {
    (byOrigin[t.strategyKey] ??= { n: 0, pnl: 0 }).n++;
    byOrigin[t.strategyKey].pnl += t.netPnL;
  }
  return { label, state, metrics, byOrigin, totalSignals: trades.length };
}

function pad(s, n) { return String(s).padEnd(n); }

function report(r) {
  const m = r.metrics;
  console.log('  ' + pad(r.label, 30) + pad(r.totalSignals, 9) + pad(m.trades, 8) +
    pad(round(m.winRate, 1), 7) + pad(round(m.profitFactor, 2), 7) +
    pad(round(m.sharpe, 2), 8) + pad(round(m.maxDD_pct, 2), 7) + fmtUsd(m.totalPnL));
}

// Optional book subset: --book gex-flip-ivpct,gex-lt-3m
const bookArg = process.argv.find(a => a.startsWith('--book='));
const bookKeys = bookArg ? bookArg.slice(7).split(',') : BOOK.map(b => b.key);
const activeBook = BOOK.filter(b => bookKeys.includes(b.key));
console.log(`book: ${activeBook.map(b => b.key).join(', ')}`);
const book = activeBook.flatMap(loadTrades);
const v1 = loadTrades(LGPR);
const v1es = loadTrades(LGPR_ES);

console.log('scenario                        signals  trades  WR%    PF     Sharpe  DD%    totalPnL');
const A = runScenario(book, `A: ${activeBook.length}-strategy baseline`);
report(A);
const B = runScenario([...book, ...v1], 'B: book + lgpr v1');
report(B);
const C = runScenario([...book, ...v1es], 'C: book + lgpr v1-ES');
report(C);
const Dv1 = runScenario(v1, 'D1: lgpr v1 alone (own slot)');
report(Dv1);
const Dv1es = runScenario(v1es, 'D2: lgpr v1-ES alone (own slot)');
report(Dv1es);

console.log();
console.log('2-slot alternatives (book slot + independent lgpr slot, PnL additive):');
const mergedV1 = calculateMetrics([...A.state.realizedTrades, ...Dv1.state.realizedTrades]);
const mergedES = calculateMetrics([...A.state.realizedTrades, ...Dv1es.state.realizedTrades]);
console.log(`  baseline + v1 independent    = ${fmtUsd(mergedV1.totalPnL)}  PF ${round(mergedV1.profitFactor,2)} Sharpe ${round(mergedV1.sharpe,2)} DD ${round(mergedV1.maxDD_pct,2)}%`);
console.log(`  baseline + v1-ES independent = ${fmtUsd(mergedES.totalPnL)}  PF ${round(mergedES.profitFactor,2)} Sharpe ${round(mergedES.sharpe,2)} DD ${round(mergedES.maxDD_pct,2)}%`);

console.log();
console.log('Origin attribution (accepted trades / PnL):');
for (const r of [A, B, C]) {
  console.log(`  ${r.label}`);
  for (const [k, v] of Object.entries(r.byOrigin)) {
    console.log(`    ${pad(k, 16)} n=${pad(v.n, 6)} ${fmtUsd(v.pnl)}`);
  }
}

// Displacement detail: baseline-accepted trades lost in B and C.
function displaced(base, alt, label) {
  const altIds = new Set(alt.state.realizedTrades.map(t => `${t.strategyKey}:${t.nativeId}`));
  const lost = base.state.realizedTrades.filter(t => !altIds.has(`${t.strategyKey}:${t.nativeId}`));
  const lostPnl = lost.sum ?? lost.reduce((s, t) => s + t.netPnL, 0);
  const byStrat = {};
  for (const t of lost) {
    (byStrat[t.strategyKey] ??= { n: 0, pnl: 0 }).n++;
    byStrat[t.strategyKey].pnl += t.netPnL;
  }
  console.log(`  ${label}: ${lost.length} baseline trades displaced, ${fmtUsd(lostPnl)} of baseline PnL`);
  for (const [k, v] of Object.entries(byStrat)) {
    console.log(`    ${pad(k, 16)} n=${pad(v.n, 6)} ${fmtUsd(v.pnl)}`);
  }
}
console.log();
console.log('Displacement vs baseline:');
displaced(A, B, 'B (v1)');
displaced(A, C, 'C (v1-ES)');
