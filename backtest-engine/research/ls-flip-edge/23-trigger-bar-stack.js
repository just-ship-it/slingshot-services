/**
 * Phase I-3b — Stack multiple drop filters and measure compound effect.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRADES = path.join(__dirname, 'output', '20-trigger-bar.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '23-stack.txt');
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

function loadCsv(p) {
  const text = fs.readFileSync(p, 'utf-8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = {}; header.forEach((h, i) => idx[h] = i);
  return { header, idx, rows: lines.slice(1).map(l => l.split(',')) };
}
const T = loadCsv(TRADES);
const F = loadCsv(FEATURES);
const featByKey = new Map();
for (const r of F.rows) featByKey.set(`${r[F.idx.tf]}_${r[F.idx.flip_ts_ms]}`, r);

const resolved = ['win', 'win_same_bar', 'loss', 'loss_same_bar', 'timeout'];
const merged = [];
for (const t of T.rows) {
  if (!resolved.includes(t[T.idx.outcome])) continue;
  if (t[T.idx.tf] !== '1m') continue;
  const fr = featByKey.get(`${t[T.idx.tf]}_${t[T.idx.flip_ts]}`);
  if (!fr) continue;
  merged.push({ t, f: fr });
}
console.log(`Merged 1m trades: ${merged.length}`);

function getN(m, col) { const i = F.idx[col]; if (i == null) return null; const v = +m.f[i]; return isFinite(v) ? v : null; }
function cb_atr(m) { const cb = getN(m, 'candle_body'), atr = getN(m, 'atr_20'); if (!isFinite(cb) || !isFinite(atr) || atr === 0) return null; return cb / atr; }
function range(m) { return +m.t[T.idx.range]; }
function against(m) { return m.t[T.idx.against] === '1'; }
function direction(m) { return m.t[T.idx.direction]; }

function summarize(arr) {
  if (arr.length === 0) return { n: 0, wr: 0, pf: 0, avg: 0, sumPnl: 0, annSharpe: 0, ddPct: 0 };
  const sorted = arr.slice().sort((a, b) => +a.t[T.idx.flip_ts] - +b.t[T.idx.flip_ts]);
  let n = 0, w = 0, l = 0, pnl = 0, sumW = 0, sumL = 0;
  let cum = 0, peak = 0, maxDD = 0;
  const returns = [];
  for (const r of sorted) {
    const o = r.t[T.idx.outcome];
    const p = +r.t[T.idx.pnl_pts] || 0;
    n++; pnl += p;
    if (o === 'win' || o === 'win_same_bar') { w++; sumW += p; }
    else if (o === 'loss' || o === 'loss_same_bar') { l++; sumL += -p; }
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    returns.push(p);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
  const yrs = sorted.length > 1 ? (+sorted[sorted.length - 1].t[T.idx.flip_ts] - +sorted[0].t[T.idx.flip_ts]) / (365.25 * 24 * 3600 * 1000) : 0;
  const tpy = yrs > 0 ? n / yrs : 0;
  const annSharpe = std > 0 ? (mean / std) * Math.sqrt(tpy) : 0;
  return {
    n, w, l, pnl, sumW, sumL,
    wr: n ? w / n * 100 : 0,
    pf: sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : 0),
    avg: n ? pnl / n : 0,
    annSharpe, maxDD, ddPct: peak > 0 ? maxDD / peak * 100 : 0,
  };
}

// Build filter functions (KEEP = pass = include this trade)
// Top single drops we identified. Negate for keep.
const FILTERS = [
  { name: 'cb_atr<1.81', fn: m => { const v = cb_atr(m); return v != null && v < 1.81; } },
  { name: 'against=N', fn: m => !against(m) },
  { name: 'body>3.25', fn: m => { const v = getN(m, 'candle_body'); return v != null && v > 3.25; } },
  { name: 'range>=4', fn: m => range(m) >= 4 },
  { name: 'wick_dn>0.25', fn: m => { const v = getN(m, 'candle_wick_dn'); return v != null && v > 0.25; } },
  { name: 'align_bits!=1', fn: m => m.f[F.idx.align_bits] !== '1' },
  { name: 'atr_20>=3', fn: m => { const v = getN(m, 'atr_20'); return v != null && v >= 3; } },
];

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

const base = summarize(merged);
const baseTr = summarize(merged.filter(m => +m.t[T.idx.flip_ts] < SPLIT_TS));
const baseTe = summarize(merged.filter(m => +m.t[T.idx.flip_ts] >= SPLIT_TS));

emit(`\n=== Phase I-3b — Stacked filter trial (1m, with slippage) ===\n`);
emit(`BASELINE: n=${base.n} WR=${base.wr.toFixed(1)}% PF=${base.pf.toFixed(2)} Sharpe=${base.annSharpe.toFixed(2)} DD=${base.ddPct.toFixed(2)}% sum=${base.pnl.toFixed(0)}pt ($${(base.pnl * 20 / 1000).toFixed(1)}k)`);
emit(`  train: n=${baseTr.n} PF=${baseTr.pf.toFixed(2)} Sharpe=${baseTr.annSharpe.toFixed(2)} DD=${baseTr.ddPct.toFixed(2)}%`);
emit(`  test:  n=${baseTe.n} PF=${baseTe.pf.toFixed(2)} Sharpe=${baseTe.annSharpe.toFixed(2)} DD=${baseTe.ddPct.toFixed(2)}%`);

// Test stacks
const STACKS = [
  { name: 'Solo: cb_atr<1.81', filters: ['cb_atr<1.81'] },
  { name: 'Solo: against=N', filters: ['against=N'] },
  { name: 'Solo: body>3.25', filters: ['body>3.25'] },
  { name: 'Pair: cb_atr<1.81 + against=N', filters: ['cb_atr<1.81', 'against=N'] },
  { name: 'Pair: cb_atr<1.81 + body>3.25', filters: ['cb_atr<1.81', 'body>3.25'] },
  { name: 'Pair: cb_atr<1.81 + range>=4', filters: ['cb_atr<1.81', 'range>=4'] },
  { name: 'Triple: cb_atr<1.81 + against=N + body>3.25', filters: ['cb_atr<1.81', 'against=N', 'body>3.25'] },
  { name: 'Triple: cb_atr<1.81 + against=N + range>=4', filters: ['cb_atr<1.81', 'against=N', 'range>=4'] },
  { name: 'Quad: cb_atr<1.81 + against=N + body>3.25 + atr>=3', filters: ['cb_atr<1.81', 'against=N', 'body>3.25', 'atr_20>=3'] },
];

emit(`\n--- Stacked filter results ---`);
emit(`  ${'stack'.padEnd(60)} ${'n'.padStart(5)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'Sh'.padStart(5)} ${'DD%'.padStart(5)} ${'sum'.padStart(8)} ($k)  | tr_PF tr_Sh tr_DD% | te_PF te_Sh te_DD%`);
for (const s of STACKS) {
  const fns = s.filters.map(name => FILTERS.find(f => f.name === name).fn);
  const subset = merged.filter(m => fns.every(fn => fn(m)));
  const f = summarize(subset);
  const tr = summarize(subset.filter(m => +m.t[T.idx.flip_ts] < SPLIT_TS));
  const te = summarize(subset.filter(m => +m.t[T.idx.flip_ts] >= SPLIT_TS));
  emit(`  ${s.name.padEnd(60)} ${f.n.toString().padStart(5)} ${f.wr.toFixed(1).padStart(5)} ${f.pf.toFixed(2).padStart(5)} ${f.annSharpe.toFixed(1).padStart(5)} ${f.ddPct.toFixed(2).padStart(5)} ${f.pnl.toFixed(0).padStart(8)} ($${(f.pnl * 20 / 1000).toFixed(0).padStart(4)}k) | ${tr.pf.toFixed(2)}  ${tr.annSharpe.toFixed(1)}  ${tr.ddPct.toFixed(1)}% | ${te.pf.toFixed(2)}  ${te.annSharpe.toFixed(1)}  ${te.ddPct.toFixed(1)}%`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
