#!/usr/bin/env node
/**
 * Portfolio-filter step 06 — finalize for a SMALL ACCOUNT objective (Drew, $2k):
 * maximize WIN RATE, minimize DRAWDOWN + loser count + max losing streak. PnL reduction OK.
 * More aggressive cuts are allowed than a PF/Sharpe-max would permit.
 *
 * True OOS: evaluate candidate filters on H1 (train), pick the best by the small-account
 * objective, then report its H2 (confirm) + full-window metrics. All through FCFS re-run.
 * Window 2025-01-13→2025-12-29 (gamma+LT covered).
 * node research/portfolio-filter/06-finalize-smallaccount.js
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
const gex = new Map();
{ const L = fs.readFileSync(path.join(ROOT, 'data/gex/nq/NQ_gex_levels.csv'), 'utf8').trim().split('\n'); const h = L[0].split(','); const di = h.indexOf('date'), ri = h.indexOf('regime'); for (let i = 1; i < L.length; i++) { const f = L[i].split(','); gex.set(f[di], f[ri]); } }
const lt = []; { const L = fs.readFileSync(path.join(ROOT, 'data/liquidity/nq/NQ_liquidity_levels.csv'), 'utf8').trim().split('\n'); for (let i = 1; i < L.length; i++) { const f = L[i].split(','); lt.push({ ts: +f[1], s: f[2] }); } lt.sort((a, b) => a.ts - b.ts); }
const ltTs = lt.map(x => x.ts); const ltAt = t => { let lo = 0, hi = ltTs.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ltTs[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? lt[a].s : null; };
const pool = [];
for (const def of STRATEGIES) { const j = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8')); for (const t of j.trades) { if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null || !normSide(t.side)) continue; if (t.entryTime < WSTART || t.entryTime > WEND) continue; const entryTime = t.entryTime; const exitTime = t.exitTime <= entryTime ? entryTime + 1 : t.exitTime; const et = fmtET(entryTime); pool.push({ id: `${def.key}:${t.id}`, nativeId: t.id, strategyKey: def.key, side: normSide(t.side), entryTime, exitTime, netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason, hourET: parseInt(et.slice(11, 13), 10), gamma: gex.get(et.slice(0, 10)) || null, lt: ltAt(entryTime) }); } }
pool.sort((a, b) => a.entryTime - b.entryTime);
const fiw = { name: 'fiw', onSignal(s, t) { if (s.position == null) open(s, t); else reject(s); }, onNativeExit(s, t) { if (s.position && s.position.trade.id === t.id) realizeNativeClose(s, t); } };
const med = pool[Math.floor(pool.length / 2)].entryTime;

function extra(trades) { // small-account metrics
  const losers = trades.filter(t => t.netPnL <= 0);
  let streak = 0, maxStreak = 0; const byTime = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of byTime) { if (t.netPnL <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  return { nLosers: losers.length, lossSum: losers.reduce((s, t) => s + t.netPnL, 0), maxLossStreak: maxStreak };
}
function evalF(drop, subset) {
  let kept = drop ? pool.filter(t => !drop(t)) : pool;
  const st = simulate(kept, fiw);
  let rt = st.realizedTrades;
  if (subset === 'h1') rt = rt.filter(t => t.entryTime < med); else if (subset === 'h2') rt = rt.filter(t => t.entryTime >= med);
  const m = calculateMetrics(rt); const e = extra(rt);
  return { ...m, ...e, accepted: rt.length, dropped: pool.length - kept.length };
}

const CANDIDATES = [
  ['baseline', null],
  ['R1 shorts in +gamma', t => t.side === 'short' && t.gamma === 'positive'],
  ['R6 level-fade 09-10ET', t => t.strategyKey === 'gex-level-fade' && (t.hourET === 9 || t.hourET === 10)],
  ['LF-neg-gamma', t => t.strategyKey === 'gex-level-fade' && t.gamma === 'negative'],
  ['DROP level-fade entirely', t => t.strategyKey === 'gex-level-fade'],
  ['R1 + LF-09-10', t => (t.side === 'short' && t.gamma === 'positive') || (t.strategyKey === 'gex-level-fade' && (t.hourET === 9 || t.hourET === 10))],
  ['R1 + DROP level-fade', t => (t.side === 'short' && t.gamma === 'positive') || t.strategyKey === 'gex-level-fade'],
  ['R1 + LF-neg-gamma', t => (t.side === 'short' && t.gamma === 'positive') || (t.strategyKey === 'gex-level-fade' && t.gamma === 'negative')],
  ['R1 + lstb-counter-LT', t => (t.side === 'short' && t.gamma === 'positive') || (t.strategyKey === 'lstb' && ((t.side === 'long' && t.lt === 'BEARISH') || (t.side === 'short' && t.lt === 'BULLISH')))],
  ['QUALITY: R1+LF-neg+LF-09-10', t => (t.side === 'short' && t.gamma === 'positive') || (t.strategyKey === 'gex-level-fade' && (t.gamma === 'negative' || t.hourET === 9 || t.hourET === 10))],
];

function show(tag, r, baseFull) {
  const dp = baseFull ? ` Δ$${r.totalPnL - baseFull >= 0 ? '+' : ''}${Math.round((r.totalPnL - baseFull) / 1000)}k` : '';
  console.log(`  ${tag.padEnd(34)} WR ${round(r.winRate,1).toString().padStart(5)}%  DD ${round(r.maxDD_pct,2).toString().padStart(5)}%  losers ${String(r.nLosers).padStart(4)}  streak ${String(r.maxLossStreak).padStart(2)}  PF ${round(r.profitFactor,2)}  trades ${String(r.accepted).padStart(4)}  PnL ${fmtUsd(r.totalPnL)}${dp}`);
}

console.log(`Window 2025, pool ${pool.length}. SMALL-ACCOUNT objective: max WR, min DD/losers. (PnL reduction OK.)\n`);
console.log('═══ FULL WINDOW ═══');
const baseFull = evalF(null, 'full'); show('baseline', baseFull);
const bP = baseFull.totalPnL;
for (const [n, fn] of CANDIDATES.slice(1)) show(n, evalF(fn, 'full'), bP);

console.log('\n═══ TRUE OOS: select on H1, confirm on H2 ═══');
const baseH1 = evalF(null, 'h1'), baseH2 = evalF(null, 'h2');
console.log('  baseline           H1: WR ' + round(baseH1.winRate,1) + '% DD ' + round(baseH1.maxDD_pct,2) + '% losers ' + baseH1.nLosers + ' | H2: WR ' + round(baseH2.winRate,1) + '% DD ' + round(baseH2.maxDD_pct,2) + '% losers ' + baseH2.nLosers);
// rank candidates by H1 objective: highest WR among those with DD <= baseline H1 DD
const ranked = CANDIDATES.slice(1).map(([n, fn]) => ({ n, fn, h1: evalF(fn, 'h1') }))
  .filter(c => c.h1.maxDD_pct <= baseH1.maxDD_pct + 0.01)
  .sort((a, b) => b.h1.winRate - a.h1.winRate);
console.log(`\n  candidates passing H1 DD<=baseline, ranked by H1 win-rate:`);
for (const c of ranked.slice(0, 5)) {
  const h2 = evalF(c.fn, 'h2');
  console.log(`  ${c.n.padEnd(30)} H1: WR ${round(c.h1.winRate,1)}% DD ${round(c.h1.maxDD_pct,2)}% losers ${c.h1.nLosers}  →  H2: WR ${round(h2.winRate,1)}% DD ${round(h2.maxDD_pct,2)}% losers ${h2.nLosers} PnL ${fmtUsd(h2.totalPnL)}`);
}
console.log('\nPick the H1-winner whose H2 ALSO shows higher WR + lower/equal DD than baseline H2 = OOS-confirmed small-account filter.');
