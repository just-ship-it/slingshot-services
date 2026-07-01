#!/usr/bin/env node
/**
 * gamma-clock thread, Phase 2 — does a gamma-sign gate help the FCFS PORTFOLIO?
 *
 * Phase 1 found the one clean, train/test-stable signal: gex-level-fade SHORTS in
 * NEGATIVE gamma have ~zero edge (PF ~0.9-1.1), while glf shorts in POSITIVE gamma
 * are healthy (PF ~1.4-2.1). This matches the article's mechanism: a fade strategy
 * needs positive-gamma dampening. The afternoon "run-over" thesis was NOT supported.
 *
 * Here we test candidate per-trade gates on the actual single-slot FCFS book. The
 * benefit (if any) is slot LIBERATION — dropping ~zero-expectancy trades frees the
 * 1-NQ slot for better signals. Judge on PF / Sharpe / DD (not PnL). Train/test split.
 *
 * Reuses the same gold-standard JSONs and first-in-wins simulator as
 * research/4strategy-portfolio/run.js, and the gammaSign annotation from
 * research/deck-filters/lib/annotate.js (keyed by `${strat}:${nativeId}`).
 *
 * Usage: node 02-fcfs-gate-test.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics, round } from '../multi-strategy-rules/lib/metrics.js';
import { loadAnnotated, etDate, TRAIN_END } from '../deck-filters/lib/annotate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const STRATEGIES = [
  { key: 'lstb',           file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m',      file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const normSide = s => { const l = String(s ?? '').toLowerCase(); return (l==='long'||l==='buy')?'long':(l==='short'||l==='sell')?'short':null; };

function loadOne(def) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  return raw.trades
    .filter(t => t.status === 'completed' && t.entryTime != null && t.exitTime != null && normSide(t.side))
    .map(t => {
      const exitTime = (t.exitTime ?? 0) <= t.entryTime ? t.entryTime + 1 : t.exitTime;
      return { id: `${def.key}:${t.id}`, nativeId: t.id, strategyKey: def.key, side: normSide(t.side),
        entryTime: t.entryTime, exitTime, duration: t.duration ?? (exitTime - t.entryTime),
        actualEntry: t.actualEntry ?? t.entryPrice, actualExit: t.actualExit,
        netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason,
        commission: t.commission ?? 5, pointValue: t.pointValue ?? 20, status: t.status };
    });
}

const firstInWins = {
  name: 'first-in-wins',
  onSignal(state, trade) { if (state.position == null) open(state, trade); else reject(state); },
  onNativeExit(state, trade) { if (state.position && state.position.trade.id === trade.id) realizeNativeClose(state, trade); },
};

// gammaSign + side per trade id, from the annotation layer.
const ann = loadAnnotated();
const annById = new Map(ann.map(t => [t.id, t]));   // id = `${strat}:${nativeId}`

// ── Candidate gates: predicate true => DROP the trade ──────────────────────
const GATES = {
  'baseline':                 () => false,
  'C1 glf short & g=neg':      t => t.strategyKey==='gex-level-fade' && t.side==='short' && annById.get(t.id)?.gammaSign === -1,
  'C2 glf any & g=neg':        t => t.strategyKey==='gex-level-fade' && annById.get(t.id)?.gammaSign === -1,
  'C3 glf short g=neg + lstb short g=pos':
                               t => (t.strategyKey==='gex-level-fade' && t.side==='short' && annById.get(t.id)?.gammaSign===-1)
                                 || (t.strategyKey==='lstb' && t.side==='short' && annById.get(t.id)?.gammaSign===1),
  'C4 glf short g=neg + glf long g=pos(drop)':
                               t => t.strategyKey==='gex-level-fade' && annById.get(t.id)?.gammaSign != null
                                    && ((t.side==='short' && annById.get(t.id).gammaSign===-1)),
};

const allTrades = [];
for (const def of STRATEGIES) allTrades.push(...loadOne(def));
allTrades.sort((a,b)=>a.entryTime-b.entryTime);
console.log(`Loaded ${allTrades.length} trades. Annotated: ${annById.size}. GEX-null trades excluded from gamma gates (treated as keep).`);

function metricsFor(realized, lo, hi){
  const sub = realized.filter(t => { const d = etDate(t.entryTime); return (!lo || d > lo) && (!hi || d <= hi); });
  return calculateMetrics(sub);
}
function row(label, m){
  return '  ' + label.padEnd(40) +
    `tr=${String(m.trades).padStart(4)}  WR=${round(m.winRate,1).toString().padStart(5)}  PF=${round(m.profitFactor,2).toString().padStart(5)}  ` +
    `Sh=${round(m.sharpe,2).toString().padStart(6)}  DD%=${round(m.maxDD_pct,2).toString().padStart(5)}  DD$=${String(Math.round(m.maxDD_usd)).padStart(6)}  $=${String(Math.round(m.totalPnL)).padStart(8)}`;
}

const out = [];
for (const [name, pred] of Object.entries(GATES)){
  const pool = allTrades.filter(t => !pred(t));
  const dropped = allTrades.length - pool.length;
  const state = simulate(pool, firstInWins);
  const realized = state.realizedTrades;
  out.push(`\n### GATE: ${name}   (dropped ${dropped} signals, accepted ${state.accepted}, rejected ${state.rejected})`);
  out.push(row('  ALL  ', metricsFor(realized, null, null)));
  out.push(row('  TRAIN(≤'+TRAIN_END+')', metricsFor(realized, null, TRAIN_END)));
  out.push(row('  TEST (>'+TRAIN_END+')', metricsFor(realized, TRAIN_END, null)));
}
const text = out.join('\n');
console.log(text);
fs.writeFileSync(path.join(__dirname,'output','02-fcfs-gate-test.txt'), text);
console.log(`\n✓ wrote output/02-fcfs-gate-test.txt`);
