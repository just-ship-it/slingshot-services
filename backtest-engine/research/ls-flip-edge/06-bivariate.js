/**
 * Phase D — Bivariate confluence scan within the AGAINST=true subset.
 *
 * Pre-filter: fade_against_higher_tfs = true
 *   - For 1m: new_state != s3m AND new_state != s15m
 *   - For 3m: new_state != s15m AND new_state != s1m
 *
 * Then scan: which SECOND feature × bin lifts PF further beyond the AGAINST
 * baseline (1.14–1.24)? Stable on train+test, n>=MIN per half.
 *
 * Run on multiple target cells; report top features per cell.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVENTS = path.join(__dirname, 'output', '01-events.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '06-bivariate.txt');

const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();
const MIN_N_PER_HALF = 40;
const PF_LIFT_MIN = 0.10; // beyond AGAINST baseline

const TARGET_CELLS = [
  { tf: '3m', dir: 'fade', s: 25, t: 60 },
  { tf: '3m', dir: 'fade', s: 15, t: 30 },
  { tf: '3m', dir: 'fade', s: 8, t: 15 },
  { tf: '1m', dir: 'fade', s: 25, t: 60 },
  { tf: '1m', dir: 'fade', s: 15, t: 30 },
  { tf: '1m', dir: 'fade', s: 8, t: 15 },
];

const FEATURES_DEF = [
  { name: 'session', kind: 'cat', col: 'session' },
  { name: 'weekday', kind: 'cat', col: 'weekday' },
  { name: 'hour_et', kind: 'cat', col: 'hour_et' },
  { name: 'candle_dir', kind: 'cat', col: 'candle_dir' },
  { name: 'gex_regime', kind: 'cat', col: 'gex_regime' },
  { name: 'nearest_r_idx', kind: 'cat', col: 'nearest_r_idx' },
  { name: 'nearest_s_idx', kind: 'cat', col: 'nearest_s_idx' },
  { name: 'new_state', kind: 'cat', col: 'new_state' },
  { name: 'prior_state_duration_min', kind: 'num', col: 'prior_state_duration_min' },
  { name: 'flips_prev_30m', kind: 'num', col: 'flips_prev_30m' },
  { name: 'flips_prev_60m', kind: 'num', col: 'flips_prev_60m' },
  { name: 'minutes_into_rth', kind: 'num', col: 'minutes_into_rth' },
  { name: 'candle_body', kind: 'num', col: 'candle_body' },
  { name: 'candle_body_to_atr', kind: 'num', col: '_derived_candle_body_to_atr' },
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

function loadCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const rows = [];
  for (let i = 1; i < lines.length; i++) rows.push(lines[i].split(','));
  return { header, idx, rows };
}

const A = loadCsv(EVENTS);
const B = loadCsv(FEATURES);
const featByKey = new Map();
for (const r of B.rows) featByKey.set(`${r[B.idx.tf]}_${r[B.idx.flip_ts_ms]}`, r);

const merged = [];
for (const r of A.rows) {
  const fr = featByKey.get(`${r[A.idx.tf]}_${r[A.idx.flip_ts_ms]}`);
  if (!fr) continue;
  merged.push({ e: r, f: fr });
}

function getVal(m, col) {
  if (col === '_derived_candle_body_to_atr') {
    const cb = +m.f[B.idx.candle_body];
    const atr = +m.f[B.idx.atr_20];
    if (!isFinite(cb) || !isFinite(atr) || atr === 0) return null;
    return cb / atr;
  }
  const idx = B.idx[col];
  if (idx == null) return null;
  const raw = m.f[idx];
  if (raw === '' || raw === 'null' || raw == null) return null;
  return raw;
}
function getNumVal(m, col) {
  const v = getVal(m, col);
  if (v == null) return null;
  const n = +v;
  return isFinite(n) ? n : null;
}

function summarize(subset, pnlIdx) {
  let n = 0, wins = 0, sumPnL = 0, gp = 0, gl = 0;
  for (const m of subset) {
    const v = m.e[pnlIdx];
    if (v === '') continue;
    const pnl = +v;
    n++; sumPnL += pnl;
    if (pnl > 0) { wins++; gp += pnl; }
    else if (pnl < 0) { gl += -pnl; }
  }
  return {
    n, wins, sumPnL,
    wr: n ? (wins / n) * 100 : 0,
    avg: n ? sumPnL / n : 0,
    pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0),
  };
}

function quintiles(values) {
  const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (v.length < 20) return null;
  return [v[Math.floor(v.length * 1/5)], v[Math.floor(v.length * 2/5)], v[Math.floor(v.length * 3/5)], v[Math.floor(v.length * 4/5)]];
}
function binNum(value, breaks) {
  if (value == null || !isFinite(value)) return null;
  for (let i = 0; i < breaks.length; i++) if (value <= breaks[i]) return `Q${i + 1}`;
  return `Q${breaks.length + 1}`;
}

function isAgainst(m, tf) {
  const ns = +m.e[A.idx.new_state];
  const s3 = +m.f[B.idx.s3m_at_flip];
  const s15 = +m.f[B.idx.s15m_at_flip];
  const s1 = +m.f[B.idx.s1m_at_flip];
  if (tf === '1m') return (ns !== s3) && (ns !== s15);
  return (ns !== s15) && (ns !== s1);
}

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase D — Bivariate confluence within AGAINST=true ===`);
emit(`min n per half: ${MIN_N_PER_HALF} | PF lift over AGAINST baseline: +${PF_LIFT_MIN}\n`);

for (const cell of TARGET_CELLS) {
  const cellKey = `s${cell.s}_t${cell.t}`;
  const pnlIdx = A.idx[`pnl_${cellKey}`];
  if (pnlIdx == null) continue;

  const subset = merged
    .filter(m => m.e[A.idx.tf] === cell.tf && m.e[A.idx.direction] === cell.dir)
    .filter(m => isAgainst(m, cell.tf));
  const train = subset.filter(m => +m.e[A.idx.flip_ts_ms] < SPLIT_TS);
  const test = subset.filter(m => +m.e[A.idx.flip_ts_ms] >= SPLIT_TS);
  const baseFull = summarize(subset, pnlIdx);
  const baseTrain = summarize(train, pnlIdx);
  const baseTest = summarize(test, pnlIdx);

  emit(`\n--- ${cell.tf} ${cell.dir.toUpperCase()} @ ${cellKey}, AGAINST=true ---`);
  emit(`  baseline: full n=${baseFull.n} PF=${baseFull.pf.toFixed(2)} WR=${baseFull.wr.toFixed(1)}% sum=${baseFull.sumPnL.toFixed(0)}`);
  emit(`  train PF=${baseTrain.pf.toFixed(2)} sum=${baseTrain.sumPnL.toFixed(0)}  |  test PF=${baseTest.pf.toFixed(2)} sum=${baseTest.sumPnL.toFixed(0)}\n`);

  const results = [];
  for (const feat of FEATURES_DEF) {
    const vals = subset.map(m => feat.kind === 'num' ? getNumVal(m, feat.col) : getVal(m, feat.col));
    const breaks = feat.kind === 'num' ? quintiles(vals) : null;
    if (feat.kind === 'num' && !breaks) continue;
    const labels = vals.map(v => feat.kind === 'num' ? (v == null ? null : binNum(v, breaks)) : v);
    const subsetLabels = subset.map((m, i) => ({ m, label: labels[i], inTrain: +m.e[A.idx.flip_ts_ms] < SPLIT_TS }));
    const unique = Array.from(new Set(subsetLabels.map(x => x.label).filter(x => x != null)));

    for (const u of unique) {
      const sf = subsetLabels.filter(x => x.label === u);
      const fAll = summarize(sf.map(x => x.m), pnlIdx);
      const fTrain = summarize(sf.filter(x => x.inTrain).map(x => x.m), pnlIdx);
      const fTest = summarize(sf.filter(x => !x.inTrain).map(x => x.m), pnlIdx);
      if (fTrain.n < MIN_N_PER_HALF || fTest.n < MIN_N_PER_HALF) continue;
      const liftTrain = fTrain.pf - baseTrain.pf;
      const liftTest = fTest.pf - baseTest.pf;
      const meetsBoth = liftTrain >= PF_LIFT_MIN && liftTest >= PF_LIFT_MIN;
      if (!meetsBoth) continue;
      const frac = fAll.n / baseFull.n;
      const improvement = fAll.sumPnL - (frac * baseFull.sumPnL);
      results.push({
        feature: feat.name, bin: String(u),
        fAll, fTrain, fTest, liftTrain, liftTest, improvement,
        breaks,
      });
    }
  }

  results.sort((a, b) => b.improvement - a.improvement);
  emit(`  ${results.length} stable filter rules (both halves PF +${PF_LIFT_MIN} over AGAINST baseline):`);
  emit(`  ${'feature'.padEnd(28)} ${'bin'.padEnd(10)} ${'n'.padStart(4)} ${'WR%'.padStart(5)} ${'PF'.padStart(5)} ${'sum'.padStart(6)} | ${'tr_n'.padStart(4)} ${'tr_PF'.padStart(5)} | ${'te_n'.padStart(4)} ${'te_PF'.padStart(5)} | improv | bins`);
  for (const r of results.slice(0, 20)) {
    const binsStr = r.breaks ? `[${r.breaks.map(b => +b.toFixed(2)).join(',')}]` : '';
    emit(`  ${r.feature.padEnd(28)} ${r.bin.padEnd(10)}`
      + ` ${r.fAll.n.toString().padStart(4)}`
      + ` ${r.fAll.wr.toFixed(1).padStart(5)}`
      + ` ${(isFinite(r.fAll.pf) ? r.fAll.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${r.fAll.sumPnL.toFixed(0).padStart(6)}`
      + ` | ${r.fTrain.n.toString().padStart(4)}`
      + ` ${(isFinite(r.fTrain.pf) ? r.fTrain.pf.toFixed(2) : '∞').padStart(5)}`
      + ` | ${r.fTest.n.toString().padStart(4)}`
      + ` ${(isFinite(r.fTest.pf) ? r.fTest.pf.toFixed(2) : '∞').padStart(5)}`
      + ` | ${r.improvement.toFixed(0).padStart(6)} | ${binsStr}`);
  }
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
