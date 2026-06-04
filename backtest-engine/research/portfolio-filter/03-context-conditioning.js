#!/usr/bin/env node
/**
 * Portfolio-filter step 03 — does each strategy perform better in specific CONTEXTS?
 * Joins (causal, knowable at signal time) to every signal in the union:
 *   • daily GAMMA regime (NQ_gex_levels.csv: positive/negative, via total_gex sign)
 *   • higher-TF LT SENTIMENT (NQ_liquidity_levels.csv, 15-min BULLISH/BEARISH — most recent <= entry)
 * Then per-strategy conditional performance by regime, sentiment, and side-vs-context
 * alignment. Reveals "strategy X shines in negative gamma / against bullish LT" → filter rules.
 *
 * Coverage: GEX→2026-01-28, LT→2025-12-29 (signals after that = n/a). Discovery; 04 validates causal+OOS.
 * node research/portfolio-filter/03-context-conditioning.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'output');

// signals
const lines = fs.readFileSync(path.join(OUT, 'signals.csv'), 'utf8').trim().split('\n');
const H = lines[0].split(','); const sig = lines.slice(1).map(l => { const f = l.split(','); const o = {}; H.forEach((h, j) => o[h] = f[j]); o.entryTime = +o.entryTime; o.netPnL = +o.netPnL; o.win = +o.win; return o; });

// daily gamma regime
const gex = new Map();
{ const L = fs.readFileSync(path.join(ROOT, 'data/gex/nq/NQ_gex_levels.csv'), 'utf8').trim().split('\n'); const h = L[0].split(','); const di = h.indexOf('date'), ri = h.indexOf('regime'); for (let i = 1; i < L.length; i++) { const f = L[i].split(','); gex.set(f[di], f[ri]); } }
// LT sentiment (sorted by ts)
const lt = [];
{ const L = fs.readFileSync(path.join(ROOT, 'data/liquidity/nq/NQ_liquidity_levels.csv'), 'utf8').trim().split('\n'); for (let i = 1; i < L.length; i++) { const f = L[i].split(','); lt.push({ ts: +f[1], s: f[2] }); } lt.sort((a, b) => a.ts - b.ts); }
const ltTs = lt.map(x => x.ts);
function ltAt(t) { let lo = 0, hi = ltTs.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ltTs[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? lt[a].s : null; }

let cov = 0;
for (const r of sig) { r.gamma = gex.get(r.etDate) || null; r.lt = ltAt(r.entryTime); if (r.gamma && r.lt) cov++; }
console.log(`context coverage: ${cov}/${sig.length} signals have both gamma+LT (rest after data cutoff)\n`);

function stats(arr) { if (!arr.length) return null; let w = 0, gp = 0, gl = 0, pnl = 0; for (const t of arr) { if (t.netPnL > 0) { w++; gp += t.netPnL; } else gl += -t.netPnL; pnl += t.netPnL; } return { n: arr.length, wr: 100 * w / arr.length, pf: gl > 0 ? gp / gl : Infinity, pnl, avg: pnl / arr.length }; }
function row(label, arr) { const s = stats(arr); if (!s || s.n < 15) { console.log('  ' + label.padEnd(30) + (s ? `n=${s.n} (few)` : 'n=0')); return; } console.log('  ' + label.padEnd(30) + `n=${String(s.n).padStart(5)}  WR ${s.wr.toFixed(1).padStart(5)}%  PF ${(s.pf===Infinity?'inf':s.pf.toFixed(2)).padStart(5)}  avg $${String(Math.round(s.avg)).padStart(5)}  PnL $${Math.round(s.pnl).toLocaleString()}`); }

for (const strat of ['lstb', 'gex-lt-3m', 'gex-flip-ivpct', 'gex-level-fade']) {
  const S = sig.filter(r => r.strategy === strat && r.gamma && r.lt);
  console.log(`\n═══ ${strat}  (n with context = ${S.length}) ═══`);
  row('ALL (with context)', S);
  console.log('  -- by gamma regime --');
  row('negative gamma', S.filter(r => r.gamma === 'negative'));
  row('positive gamma', S.filter(r => r.gamma === 'positive'));
  console.log('  -- by higher-TF LT sentiment --');
  row('LT bullish', S.filter(r => r.lt === 'BULLISH'));
  row('LT bearish', S.filter(r => r.lt === 'BEARISH'));
  console.log('  -- side vs LT (with = trade agrees with LT trend) --');
  row('long & LT bullish (with)', S.filter(r => r.side === 'long' && r.lt === 'BULLISH'));
  row('short & LT bearish (with)', S.filter(r => r.side === 'short' && r.lt === 'BEARISH'));
  row('long & LT bearish (against)', S.filter(r => r.side === 'long' && r.lt === 'BEARISH'));
  row('short & LT bullish (against)', S.filter(r => r.side === 'short' && r.lt === 'BULLISH'));
  console.log('  -- side vs gamma --');
  row('long & negative gamma', S.filter(r => r.side === 'long' && r.gamma === 'negative'));
  row('short & negative gamma', S.filter(r => r.side === 'short' && r.gamma === 'negative'));
  row('long & positive gamma', S.filter(r => r.side === 'long' && r.gamma === 'positive'));
  row('short & positive gamma', S.filter(r => r.side === 'short' && r.gamma === 'positive'));
}
console.log('\n(STACKED per-strategy view — NOT through FCFS. Cells where a strategy is strong/weak');
console.log(' become candidate filter rules, validated causally + OOS + through FCFS in step 04.)');
