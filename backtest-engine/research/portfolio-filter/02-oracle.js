#!/usr/bin/env node
/**
 * Portfolio-filter step 02 — Oracle / "optimal day" study (HINDSIGHT — discovery only).
 *
 *  (a) Reproduce the FCFS baseline through the union (sanity vs $614,730).
 *  (b) Ceilings: stacked-no-slot; perfect single-slot selection via weighted interval
 *      scheduling (max-PnL non-overlapping trades) = the theoretical "optimal" the slot
 *      could achieve with perfect foresight. Headroom = ceiling − FCFS.
 *  (c) Where do the FCFS-ACCEPTED losers concentrate? (these are what a filter can remove)
 *      grouped by strategy, hour, dow, side, gexRegime, ruleId, R:R bucket, etc.
 *
 * Hindsight is used ONLY to locate filterable structure; step 03 builds the causal filter.
 * node research/portfolio-filter/02-oracle.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate } from '../multi-strategy-rules/rules/_base.js';
import { open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics, fmtUsd, round } from '../multi-strategy-rules/lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'output');

const STRATEGIES = [
  { key: 'lstb',           file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m',      file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const normSide = s => { const l = String(s ?? '').toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : (l === 'short' || l === 'sell') ? 'short' : null; };
function normalize(t, k) { const entryTime = t.entryTime; const rawExit = t.exitTime ?? (entryTime + (t.duration ?? 0)); const exitTime = rawExit <= entryTime ? entryTime + 1 : rawExit; return { id: `${k}:${t.id}`, nativeId: t.id, strategyKey: k, side: normSide(t.side), entryTime, exitTime, duration: t.duration ?? (exitTime - entryTime), netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason }; }

const allTrades = [];
for (const def of STRATEGIES) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  for (const t of j.trades) { if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null || !normSide(t.side)) continue; allTrades.push(normalize(t, def.key)); }
}
allTrades.sort((a, b) => a.entryTime - b.entryTime);

const firstInWins = { name: 'first-in-wins', onSignal(s, t) { if (s.position == null) open(s, t); else reject(s); }, onNativeExit(s, t) { if (s.position && s.position.trade.id === t.id) realizeNativeClose(s, t); } };

// (a) FCFS baseline
const state = simulate(allTrades, firstInWins);
const m = calculateMetrics(state.realizedTrades);
console.log('═══ (a) FCFS baseline (sanity) ═══');
console.log(`  accepted ${state.realizedTrades.length}  WR ${round(m.winRate,1)}%  PF ${round(m.profitFactor,2)}  Sharpe ${round(m.sharpe,2)}  DD ${round(m.maxDD_pct,2)}%  PnL ${fmtUsd(m.totalPnL)}`);

// (b) ceilings
const stacked = allTrades.reduce((s, t) => s + t.netPnL, 0);
// perfect single-slot: weighted interval scheduling on [entryTime, exitTime], max sum netPnL (only positive picks help)
const iv = allTrades.map(t => ({ s: t.entryTime, e: t.exitTime, p: t.netPnL, t })).sort((a, b) => a.e - b.e);
const ends = iv.map(x => x.e);
function lastEndBefore(s) { let lo = 0, hi = ends.length - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (ends[mid] <= s) { ans = mid; lo = mid + 1; } else hi = mid - 1; } return ans; }
const dp = new Float64Array(iv.length), take = new Uint8Array(iv.length);
for (let i = 0; i < iv.length; i++) { const incl = iv[i].p + (lastEndBefore(iv[i].s) >= 0 ? dp[lastEndBefore(iv[i].s)] : 0); const excl = i > 0 ? dp[i - 1] : 0; if (incl > excl) { dp[i] = incl; take[i] = 1; } else { dp[i] = excl; take[i] = 0; } }
// reconstruct chosen set
const chosen = []; { let i = iv.length - 1; while (i >= 0) { const incl = iv[i].p + (lastEndBefore(iv[i].s) >= 0 ? dp[lastEndBefore(iv[i].s)] : 0); const excl = i > 0 ? dp[i - 1] : 0; if (i === 0 ? iv[i].p > 0 : incl >= excl) { chosen.push(iv[i].t); i = lastEndBefore(iv[i].s); } else i--; } }
const chosenPnL = chosen.reduce((s, t) => s + t.netPnL, 0);
console.log('\n═══ (b) ceilings ═══');
console.log(`  stacked (no slot, all ${allTrades.length}):           ${fmtUsd(stacked)}`);
console.log(`  perfect single-slot selection (oracle):    ${fmtUsd(chosenPnL)}  (${chosen.length} trades)`);
console.log(`  FCFS actual:                               ${fmtUsd(m.totalPnL)}`);
console.log(`  → headroom FCFS→oracle: ${fmtUsd(chosenPnL - m.totalPnL)}  (${(100*(chosenPnL-m.totalPnL)/m.totalPnL).toFixed(0)}% over FCFS)`);
const oracleByStrat = {}; for (const t of chosen) oracleByStrat[t.strategyKey] = (oracleByStrat[t.strategyKey]||0)+1;
console.log(`  oracle picks by strategy: ${Object.entries(oracleByStrat).map(([k,n])=>`${k}=${n}`).join('  ')}`);

// (c) characterize FCFS-ACCEPTED losers — join to signals.csv features
const sig = {};
{ const lines = fs.readFileSync(path.join(OUT, 'signals.csv'), 'utf8').trim().split('\n'); const H = lines[0].split(','); for (let i = 1; i < lines.length; i++) { const f = lines[i].split(','); const o = {}; H.forEach((h, j) => o[h] = f[j]); sig[`${o.strategy}:${o.id}`] = o; } }
const accepted = state.realizedTrades.map(r => ({ ...r, f: sig[`${r.strategyKey}:${r.nativeId}`] || {} }));
function grp(label, keyFn) {
  const g = new Map();
  for (const t of accepted) { const k = keyFn(t); if (k == null || k === '') continue; if (!g.has(k)) g.set(k, { n: 0, w: 0, pnl: 0, loss: 0 }); const e = g.get(k); e.n++; if (t.netPnL > 0) e.w++; else e.loss += t.netPnL; e.pnl += t.netPnL; }
  const rows = [...g.entries()].map(([k, e]) => ({ k, ...e, wr: 100 * e.w / e.n })).sort((a, b) => a.pnl - b.pnl);
  console.log(`\n── accepted trades by ${label} (sorted worst PnL first) ──`);
  console.log('  ' + 'key'.padEnd(26) + 'n'.padStart(6) + 'WR%'.padStart(8) + 'totalPnL'.padStart(13) + 'lossPnL'.padStart(13) + 'avg$'.padStart(9));
  for (const r of rows) console.log('  ' + String(r.k).padEnd(26) + String(r.n).padStart(6) + r.wr.toFixed(1).padStart(8) + fmtUsd(r.pnl).padStart(13) + fmtUsd(r.loss).padStart(13) + fmtUsd(r.pnl / r.n).padStart(9));
}
console.log('\n═══ (c) where do FCFS-ACCEPTED losers concentrate? ═══');
grp('strategy', t => t.strategyKey);
grp('strategy × side', t => `${t.strategyKey}/${t.f.side}`);
grp('hourET', t => String(t.f.hourET).padStart(2, '0'));
grp('day-of-week', t => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][+t.f.dow]);
grp('gexRegime', t => t.f.gexRegime);
grp('strategy × ruleId', t => t.f.ruleId ? `${t.strategyKey}/${t.f.ruleId}` : '');
console.log('\n(hindsight discovery only — step 03 builds the causal, OOS-validated filter)');
