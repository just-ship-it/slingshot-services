#!/usr/bin/env node
/**
 * Portfolio-filter step 05 — CAUSAL filter rules, validated THROUGH FCFS, stability-checked.
 * Each rule uses only signal-time-knowable features (strategy, side, ET hour, daily gamma
 * regime, higher-TF LT sentiment). We apply a rule (drop matching signals from the pool),
 * RE-RUN first-in-wins FCFS (a drop frees the slot for other signals), and compare portfolio
 * PF/Sharpe/DD/PnL vs baseline — on the full window AND split H1/H2 for stability (rules are
 * theory-motivated from steps 02-04, not fit, so split = robustness check not tuning).
 *
 * Window = 2025-01-13 → 2025-12-29 (both gamma+LT context fully covered).
 * node research/portfolio-filter/05-filter-fcfs.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics, fmtUsd, round } from '../multi-strategy-rules/lib/metrics.js';
import { fmtET } from '../multi-strategy-rules/lib/et-time.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const WSTART = new Date('2025-01-13').getTime(), WEND = new Date('2025-12-30').getTime();
const STRATEGIES = [
  { key: 'lstb', file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m', file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const normSide = s => { const l = String(s ?? '').toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : (l === 'short' || l === 'sell') ? 'short' : null; };

// context
const gex = new Map();
{ const L = fs.readFileSync(path.join(ROOT, 'data/gex/nq/NQ_gex_levels.csv'), 'utf8').trim().split('\n'); const h = L[0].split(','); const di = h.indexOf('date'), ri = h.indexOf('regime'); for (let i = 1; i < L.length; i++) { const f = L[i].split(','); gex.set(f[di], f[ri]); } }
const lt = []; { const L = fs.readFileSync(path.join(ROOT, 'data/liquidity/nq/NQ_liquidity_levels.csv'), 'utf8').trim().split('\n'); for (let i = 1; i < L.length; i++) { const f = L[i].split(','); lt.push({ ts: +f[1], s: f[2] }); } lt.sort((a, b) => a.ts - b.ts); }
const ltTs = lt.map(x => x.ts);
const ltAt = t => { let lo = 0, hi = ltTs.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ltTs[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? lt[a].s : null; };

const pool = [];
for (const def of STRATEGIES) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  for (const t of j.trades) {
    if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null || !normSide(t.side)) continue;
    if (t.entryTime < WSTART || t.entryTime > WEND) continue;
    const entryTime = t.entryTime; const rawExit = t.exitTime; const exitTime = rawExit <= entryTime ? entryTime + 1 : rawExit;
    const et = fmtET(entryTime);
    pool.push({ id: `${def.key}:${t.id}`, nativeId: t.id, strategyKey: def.key, side: normSide(t.side), entryTime, exitTime, duration: exitTime - entryTime, netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason,
      hourET: parseInt(et.slice(11, 13), 10), gamma: gex.get(et.slice(0, 10)) || null, lt: ltAt(entryTime) });
  }
}
pool.sort((a, b) => a.entryTime - b.entryTime);
const firstInWins = { name: 'fiw', onSignal(s, t) { if (s.position == null) open(s, t); else reject(s); }, onNativeExit(s, t) { if (s.position && s.position.trade.id === t.id) realizeNativeClose(s, t); } };
const med = pool[Math.floor(pool.length / 2)].entryTime;

function evalFilter(name, drop) {
  const kept = drop ? pool.filter(t => !drop(t)) : pool;
  const st = simulate(kept, firstInWins);
  const all = calculateMetrics(st.realizedTrades);
  const h1 = calculateMetrics(st.realizedTrades.filter(t => t.entryTime < med));
  const h2 = calculateMetrics(st.realizedTrades.filter(t => t.entryTime >= med));
  const nDropped = pool.length - kept.length;
  return { name, nDropped, all, h1, h2 };
}
function line(r, base) {
  const d = base ? ` (${r.all.totalPnL>=base?'+':''}${fmtUsd(r.all.totalPnL-base)})` : '';
  console.log(`  ${r.name.padEnd(40)} drop ${String(r.nDropped).padStart(4)}  acc ${String(r.all.trades).padStart(4)}  PF ${round(r.all.profitFactor,2)}  Sh ${round(r.all.sharpe,2)}  DD ${round(r.all.maxDD_pct,2)}%  PnL ${fmtUsd(r.all.totalPnL)}${d}`);
  console.log(`      ${''.padEnd(38)} H1 PF ${round(r.h1.profitFactor,2)}/Sh ${round(r.h1.sharpe,2)}/${fmtUsd(r.h1.totalPnL)}   H2 PF ${round(r.h2.profitFactor,2)}/Sh ${round(r.h2.sharpe,2)}/${fmtUsd(r.h2.totalPnL)}`);
}

console.log(`Window 2025-01-13 → 2025-12-29, pool ${pool.length} signals (context-covered). FCFS first-in-wins.\n`);
const base = evalFilter('BASELINE (no filter)', null);
line(base);
const baseP = base.all.totalPnL;
console.log('\n── single rules (drop = remove matching signals, re-run FCFS) ──');
const rules = [
  ['R1 drop ALL shorts in positive gamma',        t => t.side === 'short' && t.gamma === 'positive'],
  ['R2 drop level-fade in negative gamma',        t => t.strategyKey === 'gex-level-fade' && t.gamma === 'negative'],
  ['R3 drop lstb short when LT bullish',           t => t.strategyKey === 'lstb' && t.side === 'short' && t.lt === 'BULLISH'],
  ['R4 drop lstb counter-LT (long&bear/short&bull)', t => t.strategyKey === 'lstb' && ((t.side==='long'&&t.lt==='BEARISH')||(t.side==='short'&&t.lt==='BULLISH'))],
  ['R5 drop lt-3m counter-LT',                     t => t.strategyKey === 'gex-lt-3m' && ((t.side==='long'&&t.lt==='BEARISH')||(t.side==='short'&&t.lt==='BULLISH'))],
  ['R6 drop level-fade hour 09-10 ET',             t => t.strategyKey === 'gex-level-fade' && (t.hourET===9||t.hourET===10)],
  ['R7 drop lstb short in positive gamma',         t => t.strategyKey === 'lstb' && t.side === 'short' && t.gamma === 'positive'],
];
for (const [n, fn] of rules) line(evalFilter(n, fn), baseP);

console.log('\n── combined sets ──');
const R = Object.fromEntries(rules.map(([n, fn]) => [n.split(' ')[0], fn]));
line(evalFilter('COMBO-A R1+R2 (shorts-in-posγ + fade-in-negγ)', t => R.R1(t) || R.R2(t)), baseP);
line(evalFilter('COMBO-B R2+R4 (fade-negγ + lstb-counter-LT)', t => R.R2(t) || R.R4(t)), baseP);
line(evalFilter('COMBO-C R1+R2+R4', t => R.R1(t) || R.R2(t) || R.R4(t)), baseP);
line(evalFilter('COMBO-D R2+R4+R6', t => R.R2(t) || R.R4(t) || R.R6(t)), baseP);
console.log('\nKeep a rule/combo only if PF & Sharpe rise, DD falls, and it HOLDS in BOTH H1 and H2.');
