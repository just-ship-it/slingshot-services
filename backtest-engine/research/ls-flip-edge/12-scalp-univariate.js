/**
 * Phase G-3 — Univariate filter scan WITHIN a chosen scalp cell.
 *
 * Take a (tf, lookback, target, stop_bucket) cell from Phase G entries,
 * join with Phase B features by (tf, flip_ts_ms), and scan which feature ×
 * bin combinations lift WR (toward "near 100%"). Stable on train+test halves.
 *
 * Usage:
 *   node research/ls-flip-edge/12-scalp-univariate.js --tf 3m --lookback 300 --target 10 --stop_bucket 12
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const ENTRIES = arg('in', path.join(__dirname, 'output', '10-scalp-entries.csv'));
const FEATURES = path.join(__dirname, 'output', '02-features.csv');

const TF = arg('tf', '3m');
const LOOKBACK = +arg('lookback', '300');
const TARGET = +arg('target', '10');
const STOP_BUCKET = +arg('stop_bucket', '12');
const MIN_N = +arg('min_n', '40');
const WR_LIFT = +arg('wr_lift', '10'); // pct points lift

const OUT = path.join(__dirname, 'output', `12-scalp-univ-${TF}-lb${LOOKBACK}-t${TARGET}-s${STOP_BUCKET}.txt`);
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

function loadCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = {}; header.forEach((h, i) => idx[h] = i);
  const rows = [];
  for (let i = 1; i < lines.length; i++) rows.push(lines[i].split(','));
  return { header, idx, rows };
}

console.log(`Loading ${ENTRIES} ...`);
const E = loadCsv(ENTRIES);
console.log(`  ${E.rows.length.toLocaleString()} entry rows`);
console.log(`Loading ${FEATURES} ...`);
const F = loadCsv(FEATURES);
console.log(`  ${F.rows.length.toLocaleString()} feature rows`);
const featByKey = new Map();
for (const r of F.rows) featByKey.set(`${r[F.idx.tf]}_${r[F.idx.flip_ts_ms]}`, r);

// Filter entry rows to chosen cell + outcome != no_entry
const cellRows = E.rows.filter(r =>
  r[E.idx.tf] === TF &&
  +r[E.idx.lookback_s] === LOOKBACK &&
  +r[E.idx.target_pt] === TARGET &&
  +r[E.idx.stop_bucket_pt] === STOP_BUCKET &&
  (r[E.idx.outcome] === 'target' || r[E.idx.outcome] === 'stop' || r[E.idx.outcome] === 'timeout')
);
console.log(`Cell ${TF} | lb${LOOKBACK} | t${TARGET} | s${STOP_BUCKET}: ${cellRows.length} entered rows\n`);

// Join with features
const merged = [];
let unmatched = 0;
for (const r of cellRows) {
  const fkey = `${r[E.idx.tf]}_${r[E.idx.flip_ts_ms]}`;
  const fr = featByKey.get(fkey);
  if (!fr) { unmatched++; continue; }
  merged.push({ e: r, f: fr });
}
console.log(`  merged: ${merged.length}  (unmatched: ${unmatched})`);

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

const FEATURES_DEF = [
  { name: 'session', kind: 'cat', col: 'session' },
  { name: 'weekday', kind: 'cat', col: 'weekday' },
  { name: 'hour_et', kind: 'cat', col: 'hour_et' },
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
  { name: 'candle_body_to_atr', kind: 'derived', col: '_cb_atr' },
  { name: 'candle_wick_up', kind: 'num', col: 'candle_wick_up' },
  { name: 'candle_wick_dn', kind: 'num', col: 'candle_wick_dn' },
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
  { name: 'dte0_avg', kind: 'num', col: 'dte0_avg' },
  { name: 'dte0_skew', kind: 'num', col: 'dte0_skew' },
];

function getVal(m, feat) {
  if (feat.kind === 'derived' && feat.col === '_cb_atr') {
    const cb = +m.f[F.idx.candle_body], atr = +m.f[F.idx.atr_20];
    if (!isFinite(cb) || !isFinite(atr) || atr === 0) return null;
    return cb / atr;
  }
  const i = F.idx[feat.col];
  if (i == null) return null;
  const raw = m.f[i];
  if (raw === '' || raw == null) return null;
  if (feat.kind === 'num' || feat.kind === 'derived') {
    const n = +raw;
    return isFinite(n) ? n : null;
  }
  return raw;
}
function quintiles(vals) {
  const v = vals.filter(x => x != null).sort((a, b) => a - b);
  if (v.length < 20) return null;
  return [v[Math.floor(v.length * 1/5)], v[Math.floor(v.length * 2/5)], v[Math.floor(v.length * 3/5)], v[Math.floor(v.length * 4/5)]];
}
function binNum(value, breaks) {
  if (value == null) return null;
  for (let i = 0; i < breaks.length; i++) if (value <= breaks[i]) return `Q${i + 1}`;
  return `Q${breaks.length + 1}`;
}

const train = merged.filter(m => +m.e[E.idx.flip_ts_ms] < SPLIT_TS);
const test = merged.filter(m => +m.e[E.idx.flip_ts_ms] >= SPLIT_TS);
const baseFull = summarize(merged);
const baseTrain = summarize(train);
const baseTest = summarize(test);

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }
emit(`\n=== Phase G-3 univariate scan — ${TF} | lb${LOOKBACK} | t${TARGET} | s${STOP_BUCKET} ===`);
emit(`Baseline: full n=${baseFull.n} WR=${baseFull.wr.toFixed(1)}% PF=${baseFull.pf.toFixed(2)} avg=${baseFull.avg.toFixed(2)} sum=${baseFull.sumPnl.toFixed(0)}`);
emit(`  train: n=${baseTrain.n} WR=${baseTrain.wr.toFixed(1)}% PF=${baseTrain.pf.toFixed(2)}  test: n=${baseTest.n} WR=${baseTest.wr.toFixed(1)}% PF=${baseTest.pf.toFixed(2)}\n`);

const results = [];
for (const feat of FEATURES_DEF) {
  const vals = merged.map(m => getVal(m, feat));
  let labels;
  let breaks = null;
  if (feat.kind === 'cat') {
    labels = vals.map(v => v == null ? null : String(v));
  } else {
    breaks = quintiles(vals);
    if (!breaks) continue;
    labels = vals.map(v => v == null ? null : binNum(v, breaks));
  }
  const unique = [...new Set(labels.filter(x => x != null))];
  for (const u of unique) {
    const sf = merged.filter((m, i) => labels[i] === u);
    const sfTrain = sf.filter(m => +m.e[E.idx.flip_ts_ms] < SPLIT_TS);
    const sfTest = sf.filter(m => +m.e[E.idx.flip_ts_ms] >= SPLIT_TS);
    if (sfTrain.length < MIN_N || sfTest.length < MIN_N) continue;
    const f = summarize(sf);
    const ft = summarize(sfTrain);
    const fe = summarize(sfTest);
    const liftTrain = ft.wr - baseTrain.wr;
    const liftTest = fe.wr - baseTest.wr;
    if (liftTrain < WR_LIFT || liftTest < WR_LIFT) continue;
    results.push({ feat: feat.name, bin: u, breaks, f, ft, fe, liftTrain, liftTest });
  }
}
results.sort((a, b) => (b.ft.wr + b.fe.wr) - (a.ft.wr + a.fe.wr));

emit(`${results.length} stable filters that lift WR by +${WR_LIFT}pp on BOTH halves (n>=${MIN_N} both):`);
emit(`${'feature'.padEnd(28)} ${'bin'.padEnd(10)} ${'n'.padStart(4)} ${'WR%'.padStart(5)} ${'PF'.padStart(5)} ${'avg'.padStart(6)} ${'sum'.padStart(7)} | ${'tr_n'.padStart(4)} ${'tr_WR'.padStart(5)} | ${'te_n'.padStart(4)} ${'te_WR'.padStart(5)} | bins`);
for (const r of results.slice(0, 50)) {
  emit(`${r.feat.padEnd(28)} ${String(r.bin).padEnd(10)} ${r.f.n.toString().padStart(4)} ${r.f.wr.toFixed(1).padStart(5)} ${(isFinite(r.f.pf) ? r.f.pf.toFixed(2) : '∞').padStart(5)} ${r.f.avg.toFixed(2).padStart(6)} ${r.f.sumPnl.toFixed(0).padStart(7)} | ${r.ft.n.toString().padStart(4)} ${r.ft.wr.toFixed(1).padStart(5)} | ${r.fe.n.toString().padStart(4)} ${r.fe.wr.toFixed(1).padStart(5)} | ${r.breaks ? '[' + r.breaks.map(b => +b.toFixed(2)).join(',') + ']' : ''}`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
