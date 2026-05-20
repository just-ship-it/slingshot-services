/**
 * Phase G-4 — Bivariate confluence within a chosen scalp cell.
 *
 * Apply a primary filter (e.g. candle_wick_dn Q5), then scan all other
 * features for a second filter that lifts WR further.
 *
 * Also tests a direction-aware "appropriate-wick" composite:
 *   LONG fade (new_state=0): use candle_wick_dn (lower wick)
 *   SHORT fade (new_state=1): use candle_wick_up (upper wick)
 *
 * Usage:
 *   node research/ls-flip-edge/13-scalp-bivariate.js \
 *     --in output/10b-scalp-small.csv --tf 3m --lookback 300 --target 3 --stop_bucket 18
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const ENTRIES = arg('in', path.join(__dirname, 'output', '10b-scalp-small.csv'));
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const TF = arg('tf', '3m');
const LOOKBACK = +arg('lookback', '300');
const TARGET = +arg('target', '3');
const STOP_BUCKET = +arg('stop_bucket', '18');
const MIN_N = +arg('min_n', '30');
const WR_LIFT = +arg('wr_lift', '5');
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();
const OUT = path.join(__dirname, 'output', `13-bivariate-${TF}-lb${LOOKBACK}-t${TARGET}-s${STOP_BUCKET}.txt`);

function loadCsv(p) {
  const text = fs.readFileSync(p, 'utf-8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = {}; header.forEach((h, i) => idx[h] = i);
  return { header, idx, rows: lines.slice(1).map(l => l.split(',')) };
}

console.log('Loading ...');
const E = loadCsv(ENTRIES);
const F = loadCsv(FEATURES);
const featByKey = new Map();
for (const r of F.rows) featByKey.set(`${r[F.idx.tf]}_${r[F.idx.flip_ts_ms]}`, r);

const cellRows = E.rows.filter(r =>
  r[E.idx.tf] === TF &&
  +r[E.idx.lookback_s] === LOOKBACK &&
  +r[E.idx.target_pt] === TARGET &&
  +r[E.idx.stop_bucket_pt] === STOP_BUCKET &&
  (r[E.idx.outcome] === 'target' || r[E.idx.outcome] === 'stop' || r[E.idx.outcome] === 'timeout')
);
const merged = [];
for (const r of cellRows) {
  const fkey = `${r[E.idx.tf]}_${r[E.idx.flip_ts_ms]}`;
  const fr = featByKey.get(fkey);
  if (fr) merged.push({ e: r, f: fr });
}
console.log(`Cell ${TF}|lb${LOOKBACK}|t${TARGET}|s${STOP_BUCKET}: ${merged.length} merged rows`);

function summarize(subset) {
  let n = 0, tgt = 0, stp = 0, to = 0, sumPnl = 0, tgtSum = 0, stpSum = 0;
  for (const m of subset) {
    const o = m.e[E.idx.outcome];
    const pnl = +m.e[E.idx.pnl_pts];
    if (!isFinite(pnl)) continue;
    n++; sumPnl += pnl;
    if (o === 'target') { tgt++; tgtSum += pnl; }
    else if (o === 'stop') { stp++; stpSum += pnl; }
    else if (o === 'timeout') to++;
  }
  return {
    n, tgt, stp, to, sumPnl,
    wr: n ? tgt / n * 100 : 0,
    pf: stpSum < 0 ? tgtSum / -stpSum : (tgtSum > 0 ? Infinity : 0),
    avg: n ? sumPnl / n : 0,
  };
}

function quintiles(vals) {
  const v = vals.filter(x => x != null).sort((a, b) => a - b);
  if (v.length < 20) return null;
  return [v[Math.floor(v.length / 5)], v[Math.floor(v.length * 2 / 5)], v[Math.floor(v.length * 3 / 5)], v[Math.floor(v.length * 4 / 5)]];
}
function binNum(value, breaks) {
  if (value == null) return null;
  for (let i = 0; i < breaks.length; i++) if (value <= breaks[i]) return `Q${i + 1}`;
  return `Q${breaks.length + 1}`;
}
function getNum(m, col) {
  const i = F.idx[col]; if (i == null) return null;
  const v = +m.f[i];
  return isFinite(v) ? v : null;
}
function getCat(m, col) {
  const i = F.idx[col]; if (i == null) return null;
  const v = m.f[i];
  return v === '' ? null : v;
}

// --- Define primary filters to test (we'll iterate over them) ---
const PRIMARY_FILTERS = [
  {
    name: 'candle_wick_dn Q5 (>=3.75)',
    apply: (m) => { const v = getNum(m, 'candle_wick_dn'); return v != null && v >= 3.75; },
  },
  {
    name: 'candle_wick_up Q5 (>=3.25)',
    apply: (m) => { const v = getNum(m, 'candle_wick_up'); return v != null && v >= 3.25; },
  },
  {
    name: 'session=open',
    apply: (m) => getCat(m, 'session') === 'open',
  },
  {
    name: 'atr_20 Q5 (>=12.86)',
    apply: (m) => { const v = getNum(m, 'atr_20'); return v != null && v >= 12.86; },
  },
  {
    name: 'direction-aware appropriate wick Q5',
    apply: (m) => {
      const ns = +m.e[E.idx.new_state];
      if (ns === 0) { const v = getNum(m, 'candle_wick_dn'); return v != null && v >= 3.75; }
      if (ns === 1) { const v = getNum(m, 'candle_wick_up'); return v != null && v >= 3.25; }
      return false;
    },
  },
  {
    name: 'opposing-wick Q5 (counter-intuitive)',
    apply: (m) => {
      const ns = +m.e[E.idx.new_state];
      if (ns === 0) { const v = getNum(m, 'candle_wick_up'); return v != null && v >= 3.25; }
      if (ns === 1) { const v = getNum(m, 'candle_wick_dn'); return v != null && v >= 3.75; }
      return false;
    },
  },
];

const FEATURES_DEF = [
  { name: 'session', kind: 'cat', col: 'session' },
  { name: 'hour_et', kind: 'cat', col: 'hour_et' },
  { name: 'weekday', kind: 'cat', col: 'weekday' },
  { name: 'gex_regime', kind: 'cat', col: 'gex_regime' },
  { name: 'nearest_r_idx', kind: 'cat', col: 'nearest_r_idx' },
  { name: 'nearest_s_idx', kind: 'cat', col: 'nearest_s_idx' },
  { name: 'candle_dir', kind: 'cat', col: 'candle_dir' },
  { name: 'new_state', kind: 'cat', col: 'new_state' },
  { name: 'align_bits', kind: 'cat', col: 'align_bits' },
  { name: 'prior_state_duration_min', kind: 'num', col: 'prior_state_duration_min' },
  { name: 'flips_prev_30m', kind: 'num', col: 'flips_prev_30m' },
  { name: 'flips_prev_60m', kind: 'num', col: 'flips_prev_60m' },
  { name: 'candle_body', kind: 'num', col: 'candle_body' },
  { name: 'mom_5m', kind: 'num', col: 'mom_5m' },
  { name: 'mom_15m', kind: 'num', col: 'mom_15m' },
  { name: 'mom_30m', kind: 'num', col: 'mom_30m' },
  { name: 'atr_20', kind: 'num', col: 'atr_20' },
  { name: 'gex_multiplier', kind: 'num', col: 'gex_multiplier' },
  { name: 'gex_gi', kind: 'num', col: 'gex_gi' },
  { name: 'gex_total', kind: 'num', col: 'gex_total' },
  { name: 'dist_cw', kind: 'num', col: 'dist_cw' },
  { name: 'dist_pw', kind: 'num', col: 'dist_pw' },
  { name: 'dist_gflip', kind: 'num', col: 'dist_gflip' },
  { name: 'nearest_r_dist', kind: 'num', col: 'nearest_r_dist' },
  { name: 'nearest_s_dist', kind: 'num', col: 'nearest_s_dist' },
  { name: 'qqq_iv', kind: 'num', col: 'qqq_iv' },
  { name: 'qqq_iv_chg_15m', kind: 'num', col: 'qqq_iv_chg_15m' },
];

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase G-4 bivariate within ${TF}|lb${LOOKBACK}|t${TARGET}|s${STOP_BUCKET} ===`);

for (const pf of PRIMARY_FILTERS) {
  const subset = merged.filter(m => pf.apply(m));
  const train = subset.filter(m => +m.e[E.idx.flip_ts_ms] < SPLIT_TS);
  const test = subset.filter(m => +m.e[E.idx.flip_ts_ms] >= SPLIT_TS);
  const baseFull = summarize(subset);
  const baseTrain = summarize(train);
  const baseTest = summarize(test);

  emit(`\n--- PRIMARY: ${pf.name} ---`);
  emit(`  baseline: full n=${baseFull.n} WR=${baseFull.wr.toFixed(1)}% PF=${baseFull.pf.toFixed(2)} avg=${baseFull.avg.toFixed(2)} sum=${baseFull.sumPnl.toFixed(0)}`);
  emit(`  train: n=${baseTrain.n} WR=${baseTrain.wr.toFixed(1)}% PF=${baseTrain.pf.toFixed(2)}  test: n=${baseTest.n} WR=${baseTest.wr.toFixed(1)}% PF=${baseTest.pf.toFixed(2)}`);
  if (baseFull.n < 50) continue;

  const results = [];
  for (const feat of FEATURES_DEF) {
    const vals = subset.map(m => feat.kind === 'num' ? getNum(m, feat.col) : getCat(m, feat.col));
    let labels;
    let breaks = null;
    if (feat.kind === 'num') {
      breaks = quintiles(vals);
      if (!breaks) continue;
      labels = vals.map(v => v == null ? null : binNum(v, breaks));
    } else {
      labels = vals.map(v => v == null ? null : String(v));
    }
    const unique = [...new Set(labels.filter(x => x != null))];
    for (const u of unique) {
      const sf = subset.filter((m, i) => labels[i] === u);
      const sfT = sf.filter(m => +m.e[E.idx.flip_ts_ms] < SPLIT_TS);
      const sfE = sf.filter(m => +m.e[E.idx.flip_ts_ms] >= SPLIT_TS);
      if (sfT.length < MIN_N || sfE.length < MIN_N) continue;
      const f = summarize(sf), ft = summarize(sfT), fe = summarize(sfE);
      const liftT = ft.wr - baseTrain.wr;
      const liftE = fe.wr - baseTest.wr;
      if (liftT < WR_LIFT || liftE < WR_LIFT) continue;
      results.push({ feat: feat.name, bin: u, breaks, f, ft, fe, liftT, liftE });
    }
  }
  results.sort((a, b) => (b.ft.wr + b.fe.wr) - (a.ft.wr + a.fe.wr));
  emit(`  ${results.length} stable second-filters lifting WR by +${WR_LIFT}pp on both halves (n>=${MIN_N} both):`);
  for (const r of results.slice(0, 12)) {
    emit(`    ${r.feat.padEnd(28)} ${String(r.bin).padEnd(10)} n=${r.f.n.toString().padStart(4)} WR=${r.f.wr.toFixed(1).padStart(5)} PF=${(isFinite(r.f.pf) ? r.f.pf.toFixed(2) : '∞').padStart(5)} | tr=${r.ft.n}/${r.ft.wr.toFixed(1)}% | te=${r.fe.n}/${r.fe.wr.toFixed(1)}%`);
  }
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
