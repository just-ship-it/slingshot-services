/**
 * Phase G-6 — Trivariate stacking within the scalp base.
 *
 * Apply 2 primary filters: AGAINST + direction-aware wick Q5
 * Then jointly scan candle_body Q5/Q4/Q3 × {ATR Q5, session=open, mom_5m Q5, hour_et=9}
 *
 * Use FIXED cutoffs computed from the FULL cell (n=2537), not subset-Q5,
 * so the result is implementable live without lookahead.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENTRIES = path.join(__dirname, 'output', '10b-scalp-small.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '15-trivariate.txt');

const TF = '3m', LOOKBACK = 300, TARGET = 3, STOP_BUCKET = 18;
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

function loadCsv(p) {
  const text = fs.readFileSync(p, 'utf-8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = {}; header.forEach((h, i) => idx[h] = i);
  return { header, idx, rows: lines.slice(1).map(l => l.split(',')) };
}
const E = loadCsv(ENTRIES);
const F = loadCsv(FEATURES);
const featByKey = new Map();
for (const r of F.rows) featByKey.set(`${r[F.idx.tf]}_${r[F.idx.flip_ts_ms]}`, r);

const cellRows = E.rows.filter(r =>
  r[E.idx.tf] === TF && +r[E.idx.lookback_s] === LOOKBACK &&
  +r[E.idx.target_pt] === TARGET && +r[E.idx.stop_bucket_pt] === STOP_BUCKET &&
  ['target', 'stop', 'timeout'].includes(r[E.idx.outcome])
);
const merged = [];
for (const r of cellRows) {
  const fr = featByKey.get(`${r[E.idx.tf]}_${r[E.idx.flip_ts_ms]}`);
  if (fr) merged.push({ e: r, f: fr });
}

function getNum(m, col) { const i = F.idx[col]; if (i == null) return null; const v = +m.f[i]; return isFinite(v) ? v : null; }
function getCat(m, col) { const i = F.idx[col]; if (i == null) return null; const v = m.f[i]; return v === '' ? null : v; }

// Compute fixed cell-wide cutoffs
function cellCutoffs(col, qs) {
  const vals = merged.map(m => getNum(m, col)).filter(v => v != null).sort((a, b) => a - b);
  return qs.map(q => vals[Math.floor(vals.length * q)]);
}
const bodyQs = cellCutoffs('candle_body', [0.6, 0.7, 0.8, 0.9]);
const atrQs = cellCutoffs('atr_20', [0.6, 0.7, 0.8, 0.9]);
const mom5Qs = cellCutoffs('mom_5m', [0.6, 0.7, 0.8, 0.9]);

function summarize(arr) {
  let n = 0, tgt = 0, stp = 0, to = 0, sumPnl = 0, tgtSum = 0, stpSum = 0;
  for (const m of arr) {
    const o = m.e[E.idx.outcome]; const pnl = +m.e[E.idx.pnl_pts];
    if (!isFinite(pnl)) continue;
    n++; sumPnl += pnl;
    if (o === 'target') { tgt++; tgtSum += pnl; }
    else if (o === 'stop') { stp++; stpSum += pnl; }
    else to++;
  }
  return { n, tgt, stp, to, sumPnl, wr: n ? tgt / n * 100 : 0, pf: stpSum < 0 ? tgtSum / -stpSum : (tgtSum > 0 ? Infinity : 0), avg: n ? sumPnl / n : 0 };
}

function passDirAwareWick(m) {
  const ns = +m.e[E.idx.new_state];
  if (ns === 0) { const v = getNum(m, 'candle_wick_dn'); return v != null && v >= 3.75; }
  if (ns === 1) { const v = getNum(m, 'candle_wick_up'); return v != null && v >= 3.25; }
  return false;
}

// Primary subset: AGAINST + direction-aware wick Q5
const primary = merged.filter(passDirAwareWick);
console.log(`Primary subset (AGAINST + dir-aware wick Q5): ${primary.length}`);
console.log(`Cell-wide cutoffs: body Q4/Q5=${bodyQs[2].toFixed(2)}/${bodyQs[3].toFixed(2)}  atr Q4/Q5=${atrQs[2].toFixed(2)}/${atrQs[3].toFixed(2)}  mom_5m Q4/Q5=${mom5Qs[2].toFixed(2)}/${mom5Qs[3].toFixed(2)}`);

// Trivariate filter combinations
const TRIVARS = [
  { name: 'body Q5 (>=6.75)', fn: m => { const v = getNum(m, 'candle_body'); return v != null && v >= bodyQs[3]; } },
  { name: 'body Q4 (>=5)', fn: m => { const v = getNum(m, 'candle_body'); return v != null && v >= bodyQs[2]; } },
  { name: 'atr Q5 (>=12.86)', fn: m => { const v = getNum(m, 'atr_20'); return v != null && v >= atrQs[3]; } },
  { name: 'atr Q4', fn: m => { const v = getNum(m, 'atr_20'); return v != null && v >= atrQs[2]; } },
  { name: 'session=open', fn: m => getCat(m, 'session') === 'open' },
  { name: 'hour=9', fn: m => +getCat(m, 'hour_et') === 9 },
  { name: 'mom_5m Q5', fn: m => { const v = getNum(m, 'mom_5m'); return v != null && v >= mom5Qs[3]; } },
];

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }
emit(`\n=== Phase G-6 — Trivariate stacking (FIXED cell-wide cutoffs) ===`);
emit(`Base: ${TF}|lb${LOOKBACK}|t${TARGET}|s${STOP_BUCKET} + AGAINST + dir-aware wick Q5 (n=${primary.length})`);

// Single-filter on primary subset
emit(`\n--- Single second-filter on top of primary ---`);
emit(`  ${'filter'.padEnd(22)} ${'n'.padStart(4)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'sum'.padStart(6)} | tr_n  tr_WR | te_n  te_WR`);
const singles = [];
for (const tv of TRIVARS) {
  const sub = primary.filter(tv.fn);
  const trn = sub.filter(m => +m.e[E.idx.flip_ts_ms] < SPLIT_TS);
  const tst = sub.filter(m => +m.e[E.idx.flip_ts_ms] >= SPLIT_TS);
  const f = summarize(sub), ft = summarize(trn), fe = summarize(tst);
  if (f.n < 30 || ft.n < 15 || fe.n < 15) continue;
  singles.push({ name: tv.name, fn: tv.fn, f, ft, fe });
  emit(`  ${tv.name.padEnd(22)} ${f.n.toString().padStart(4)} ${f.wr.toFixed(1).padStart(5)} ${f.pf.toFixed(2).padStart(5)} ${f.sumPnl.toFixed(0).padStart(6)} | ${ft.n.toString().padStart(4)} ${ft.wr.toFixed(1).padStart(5)} | ${fe.n.toString().padStart(4)} ${fe.wr.toFixed(1).padStart(5)}`);
}

// Pairs (trivariate = primary × 2 single filters)
emit(`\n--- TOP pairs (primary + two filters stacked) ---`);
emit(`  ${'filterA'.padEnd(22)} ${'filterB'.padEnd(22)} ${'n'.padStart(4)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'sum'.padStart(6)} | tr_n  tr_WR | te_n  te_WR`);
const pairs = [];
for (let i = 0; i < singles.length; i++) {
  for (let j = i + 1; j < singles.length; j++) {
    const a = singles[i], b = singles[j];
    const sub = primary.filter(m => a.fn(m) && b.fn(m));
    const trn = sub.filter(m => +m.e[E.idx.flip_ts_ms] < SPLIT_TS);
    const tst = sub.filter(m => +m.e[E.idx.flip_ts_ms] >= SPLIT_TS);
    if (trn.length < 10 || tst.length < 10) continue;
    const f = summarize(sub), ft = summarize(trn), fe = summarize(tst);
    pairs.push({ a: a.name, b: b.name, f, ft, fe });
  }
}
pairs.sort((a, b) => b.f.wr - a.f.wr);
for (const p of pairs.slice(0, 20)) {
  emit(`  ${p.a.padEnd(22)} ${p.b.padEnd(22)} ${p.f.n.toString().padStart(4)} ${p.f.wr.toFixed(1).padStart(5)} ${p.f.pf.toFixed(2).padStart(5)} ${p.f.sumPnl.toFixed(0).padStart(6)} | ${p.ft.n.toString().padStart(4)} ${p.ft.wr.toFixed(1).padStart(5)} | ${p.fe.n.toString().padStart(4)} ${p.fe.wr.toFixed(1).padStart(5)}`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
