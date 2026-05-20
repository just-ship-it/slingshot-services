/**
 * Phase I-5b — Apply best drop filter (cb_atr<1.81) to the 2-phase output.
 * Also test stack with against=N and range>=4.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRADES = path.join(__dirname, 'output', '24-2phase-50-786.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '25-2phase-filter.txt');
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

const merged = [];
for (const t of T.rows) {
  if (t[T.idx.tf] !== '1m') continue;
  const fr = featByKey.get(`${t[T.idx.tf]}_${t[T.idx.flip_ts]}`);
  if (!fr) continue;
  merged.push({ t, f: fr });
}
console.log(`Merged 1m 2-phase events: ${merged.length}`);

function getN(m, col) { const i = F.idx[col]; if (i == null) return null; const v = +m.f[i]; return isFinite(v) ? v : null; }
function cb_atr(m) { const cb = getN(m, 'candle_body'), atr = getN(m, 'atr_20'); if (!isFinite(cb) || !isFinite(atr) || atr === 0) return null; return cb / atr; }
function range(m) { return +m.t[T.idx.range]; }
function against(m) { return m.t[T.idx.against] === '1'; }

function summarize(arr) {
  if (arr.length === 0) return { n: 0, contracts: 0, wr: 0, pf: 0, avg: 0, sumPnl: 0, annSharpe: 0, ddPct: 0 };
  const sorted = arr.slice().sort((a, b) => +a.t[T.idx.flip_ts] - +b.t[T.idx.flip_ts]);
  let n = 0, contracts = 0, w = 0, l = 0, pnl = 0, sumW = 0, sumL = 0;
  let cum = 0, peak = 0, maxDD = 0;
  const returns = [];
  for (const r of sorted) {
    const c = +r.t[T.idx.contracts_filled];
    if (c === 0) continue;
    const p = +r.t[T.idx.combined_pnl];
    n++; contracts += c; pnl += p;
    if (p > 0) { w++; sumW += p; }
    else if (p < 0) { l++; sumL += -p; }
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
    n, contracts, w, l, pnl, sumW, sumL,
    wr: n ? w / n * 100 : 0,
    pf: sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : 0),
    avg: n ? pnl / n : 0,
    annSharpe, maxDD, ddPct: peak > 0 ? maxDD / peak * 100 : 0,
  };
}

const FILTERS = [
  { name: 'baseline (no filter)', fn: () => true },
  { name: 'cb_atr<1.81', fn: m => { const v = cb_atr(m); return v != null && v < 1.81; } },
  { name: 'against=N', fn: m => !against(m) },
  { name: 'range>=4', fn: m => range(m) >= 4 },
  { name: 'cb_atr<1.81 + against=N', fn: m => { const v = cb_atr(m); return v != null && v < 1.81 && !against(m); } },
  { name: 'cb_atr<1.81 + range>=4', fn: m => { const v = cb_atr(m); return v != null && v < 1.81 && range(m) >= 4; } },
  { name: 'cb_atr<1.81 + against=N + range>=4', fn: m => { const v = cb_atr(m); return v != null && v < 1.81 && !against(m) && range(m) >= 4; } },
];

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }
emit(`\n=== Phase I-5b — 2-phase + filter stacking (1m, fib=0.5+0.786) ===\n`);
emit(`  ${'filter'.padEnd(48)} ${'n'.padStart(5)} ${'ctr'.padStart(5)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'Sh'.padStart(5)} ${'DD%'.padStart(5)} ${'sum'.padStart(7)} ($k)  | tr_PF tr_Sh tr_DD | te_PF te_Sh te_DD`);

for (const F of FILTERS) {
  const subset = merged.filter(F.fn);
  const f = summarize(subset);
  const t = summarize(subset.filter(m => +m.t[T.idx.flip_ts] < SPLIT_TS));
  const e = summarize(subset.filter(m => +m.t[T.idx.flip_ts] >= SPLIT_TS));
  emit(`  ${F.name.padEnd(48)} ${f.n.toString().padStart(5)} ${f.contracts.toString().padStart(5)} ${f.wr.toFixed(1).padStart(5)} ${f.pf.toFixed(2).padStart(5)} ${f.annSharpe.toFixed(1).padStart(5)} ${f.ddPct.toFixed(2).padStart(5)} ${f.pnl.toFixed(0).padStart(7)} ($${(f.pnl * 20 / 1000).toFixed(0).padStart(4)}k) | ${t.pf.toFixed(2)}  ${t.annSharpe.toFixed(1)}  ${t.ddPct.toFixed(1)}% | ${e.pf.toFixed(2)}  ${e.annSharpe.toFixed(1)}  ${e.ddPct.toFixed(1)}%`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
