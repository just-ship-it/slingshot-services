#!/usr/bin/env node
// Post-lookahead-event clean book (2026-07-11): gfi is DEAD (causal PF 0.98)
// and removed. Book = lstb + gex-lt-3m + gex-level-fade (all clean golds),
// with lgpr v1-ES-CAUSAL (PF 2.08 standalone) as the 4th-slot candidate.
//
// Scenarios:
//   A) 3-strategy clean book
//   B) 3-strategy + lgpr v1-ES causal (trades filtered to the book window)
//
// Conventions identical to run-with-lgpr.js: first-in-wins by entryTime on
// the single 1-NQ slot; lgpr ties lose.

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
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const LGPR_ES_CAUSAL = { key: 'lgpr-v1es-causal',
  file: 'data/gold-standard/lt-gex-path-race-v1-es-causal.json' };

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
  const m = calculateMetrics(state.realizedTrades);
  const byOrigin = {};
  for (const t of state.realizedTrades) {
    (byOrigin[t.strategyKey] ??= { n: 0, pnl: 0 }).n++;
    byOrigin[t.strategyKey].pnl += t.netPnL;
  }
  console.log(`\n=== ${label} ===`);
  console.log(`trades=${m.n} pnl=${fmtUsd(m.totalPnL)} PF=${round(m.profitFactor, 2)} ` +
    `WR=${round(m.winRate, 1)}% Sharpe=${round(m.sharpe, 2)} maxDD=${fmtUsd(m.maxDrawdownUsd)} ` +
    `(${round(m.maxDrawdownPct, 2)}%)`);
  for (const [k, v] of Object.entries(byOrigin)) {
    console.log(`  ${k.padEnd(18)} n=${String(v.n).padStart(4)} pnl=${fmtUsd(v.pnl)}`);
  }
  return m;
}

const bookTrades = BOOK.flatMap(loadTrades);
const winStart = Math.min(...bookTrades.map(t => t.entryTime));
const winEnd = Math.max(...bookTrades.map(t => t.entryTime));
console.log(`book window: ${new Date(winStart).toISOString()} → ${new Date(winEnd).toISOString()}`);

const lgprAll = loadTrades(LGPR_ES_CAUSAL);
const lgprWin = lgprAll.filter(t => t.entryTime >= winStart && t.entryTime <= winEnd);
console.log(`lgpr v1-ES causal: ${lgprAll.length} total trades, ${lgprWin.length} in book window`);

runScenario(bookTrades, 'A) clean 3-strategy book (lstb + glx + glf)');
runScenario([...bookTrades, ...lgprWin], 'B) + lgpr v1-ES causal');
