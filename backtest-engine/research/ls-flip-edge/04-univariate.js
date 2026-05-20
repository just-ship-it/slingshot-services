/**
 * Phase C-2 — Univariate filter scan.
 *
 * For each (target cell, feature bin), compute PF/WR/sumPnL/n on train+test
 * halves. Report KEEP rules (include only this bin) that:
 *   - have n >= MIN_N in both halves
 *   - lift PF in both halves above baseline + EPS
 *   - and rank by combined sumPnL.
 *
 * Target cells (decided from Phase C-1 grid scan):
 *   - 3m fade @ s15/t30 — primary, balanced 2:1 RR
 *   - 3m fade @ s8/t15  — tight scalp
 *   - 1m fade @ s15/t30 — pure-scalp, hoping filter rescues weak baseline
 *   - 1m fade @ s8/t15  — pure-scalp tight
 *
 * Usage:
 *   node research/ls-flip-edge/04-univariate.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVENTS = path.join(__dirname, 'output', '01-events.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '04-univariate.txt');

const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();
const MIN_N_PER_HALF = 60;
const PF_EPS = 0.15;

const TARGET_CELLS = [
  { tf: '3m', dir: 'fade', s: 15, t: 30 },
  { tf: '3m', dir: 'fade', s: 8, t: 15 },
  { tf: '1m', dir: 'fade', s: 15, t: 30 },
  { tf: '1m', dir: 'fade', s: 8, t: 15 },
];

// ---------- helpers ----------
function loadCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    rows.push(lines[i].split(','));
  }
  return { header, idx, rows };
}

// ---------- load ----------
console.log('Loading events ...');
const A = loadCsv(EVENTS);
console.log(`  events rows: ${A.rows.length.toLocaleString()}`);

console.log('Loading features ...');
const B = loadCsv(FEATURES);
console.log(`  feature rows: ${B.rows.length.toLocaleString()}`);

// Build feature lookup: key = `${tf}_${flip_ts_ms}` → feature row idx
const featByKey = new Map();
for (let i = 0; i < B.rows.length; i++) {
  const r = B.rows[i];
  const key = `${r[B.idx.tf]}_${r[B.idx.flip_ts_ms]}`;
  featByKey.set(key, r);
}
console.log(`  feature keys: ${featByKey.size.toLocaleString()}`);

// Merge: for each event-row, attach feature row pointer
console.log('Joining ...');
const merged = [];
let unmatched = 0;
for (const r of A.rows) {
  const key = `${r[A.idx.tf]}_${r[A.idx.flip_ts_ms]}`;
  const fr = featByKey.get(key);
  if (!fr) { unmatched++; continue; }
  merged.push({ e: r, f: fr });
}
console.log(`  merged rows: ${merged.length.toLocaleString()}  (unmatched: ${unmatched})`);

// ---------- summarize helper ----------
function summarize(subset, cellPnlIdx) {
  let n = 0, wins = 0, sumPnL = 0, gp = 0, gl = 0;
  for (const m of subset) {
    const v = m.e[cellPnlIdx];
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

// ---------- feature definitions ----------
// Each feature: { name, kind: 'cat'|'num', getValue: (f) => raw value or null, bins?: optional pre-defined bins }
// For numeric, bins are computed as quintiles from the full data per cell.

const FEATURES_DEF = [
  // Categorical
  { name: 's3m_at_flip', kind: 'cat', col: 's3m_at_flip' },
  { name: 's1m_at_flip', kind: 'cat', col: 's1m_at_flip' },
  { name: 's15m_at_flip', kind: 'cat', col: 's15m_at_flip' },
  { name: 'align_bits', kind: 'cat', col: 'align_bits' },
  { name: 'all_tfs_agree', kind: 'cat', col: 'all_tfs_agree' },
  { name: 'other_tfs_agree_with_flip', kind: 'cat', col: 'other_tfs_agree_with_flip' },
  { name: 'new_state', kind: 'cat', col: 'new_state' }, // useful for fade-on-which-side
  { name: 'session', kind: 'cat', col: 'session' },
  { name: 'weekday', kind: 'cat', col: 'weekday' },
  { name: 'hour_et', kind: 'cat', col: 'hour_et' },
  { name: 'candle_dir', kind: 'cat', col: 'candle_dir' },
  { name: 'gex_regime', kind: 'cat', col: 'gex_regime' },
  { name: 'nearest_r_idx', kind: 'cat', col: 'nearest_r_idx' },
  { name: 'nearest_s_idx', kind: 'cat', col: 'nearest_s_idx' },
  // Numeric
  { name: 'prior_state_duration_min', kind: 'num', col: 'prior_state_duration_min' },
  { name: 'flips_prev_30m', kind: 'num', col: 'flips_prev_30m' },
  { name: 'flips_prev_60m', kind: 'num', col: 'flips_prev_60m' },
  { name: 'minutes_into_rth', kind: 'num', col: 'minutes_into_rth' },
  { name: 'candle_body', kind: 'num', col: 'candle_body' },
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

// Build quintile bins for numeric features given a subset
function quintiles(values) {
  const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (v.length < 20) return null;
  const q = i => v[Math.floor(v.length * i / 5)];
  return [q(1), q(2), q(3), q(4)]; // 4 breakpoints → 5 bins
}
function binNum(value, breaks) {
  if (value == null || !isFinite(value)) return null;
  for (let i = 0; i < breaks.length; i++) if (value <= breaks[i]) return `Q${i + 1}`;
  return `Q${breaks.length + 1}`;
}

function getVal(m, col) {
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

// ---------- main scan ----------
const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase C-2 univariate filter scan ===`);
emit(`Split: ${new Date(SPLIT_TS).toISOString().slice(0, 10)}  |  min n per half: ${MIN_N_PER_HALF}  |  PF lift threshold: +${PF_EPS}\n`);

for (const cell of TARGET_CELLS) {
  const cellKey = `s${cell.s}_t${cell.t}`;
  const pnlCol = `pnl_${cellKey}`;
  const pnlIdx = A.idx[pnlCol];
  if (pnlIdx == null) continue;

  // Filter merged to this cell's (tf, dir)
  const subset = merged.filter(m => m.e[A.idx.tf] === cell.tf && m.e[A.idx.direction] === cell.dir);
  const train = subset.filter(m => +m.e[A.idx.flip_ts_ms] < SPLIT_TS);
  const test = subset.filter(m => +m.e[A.idx.flip_ts_ms] >= SPLIT_TS);
  const baseFull = summarize(subset, pnlIdx);
  const baseTrain = summarize(train, pnlIdx);
  const baseTest = summarize(test, pnlIdx);

  emit(`\n--- ${cell.tf} ${cell.dir.toUpperCase()} @ ${cellKey} ---`);
  emit(`  baseline:  full n=${baseFull.n}  PF=${baseFull.pf.toFixed(2)}  WR=${baseFull.wr.toFixed(1)}%  avg=${baseFull.avg.toFixed(2)}  sum=${baseFull.sumPnL.toFixed(0)}`);
  emit(`  train: PF=${baseTrain.pf.toFixed(2)} WR=${baseTrain.wr.toFixed(1)}% sum=${baseTrain.sumPnL.toFixed(0)}  |  test: PF=${baseTest.pf.toFixed(2)} WR=${baseTest.wr.toFixed(1)}% sum=${baseTest.sumPnL.toFixed(0)}\n`);

  // Univariate scan
  const results = [];
  for (const feat of FEATURES_DEF) {
    // Build value lookup for this cell's subset
    const vals = subset.map(m => feat.kind === 'num' ? getNumVal(m, feat.col) : getVal(m, feat.col));
    const breaks = feat.kind === 'num' ? quintiles(vals) : null;
    if (feat.kind === 'num' && !breaks) continue;

    // Bin every row
    const labels = vals.map(v => feat.kind === 'num' ? (v == null ? null : binNum(v, breaks)) : v);
    const trainLabels = labels.slice(0, train.length);
    const testLabels = labels.slice(train.length);
    // ... wait, the split isn't by index; rebuild
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
      const meetsBoth = liftTrain >= PF_EPS && liftTest >= PF_EPS;
      results.push({
        feature: feat.name,
        bin: String(u),
        breaks: breaks,
        fAll, fTrain, fTest,
        liftTrain, liftTest,
        meetsBoth,
      });
    }
  }

  // Rank stable lifts by combined sumPnL improvement vs baseline-proportion
  const stable = results.filter(r => r.meetsBoth);
  // Improvement: sumPnL - (fraction * baseline sumPnL)  → "extra over what proportional baseline would give"
  for (const r of stable) {
    const frac = r.fAll.n / baseFull.n;
    r.improvement = r.fAll.sumPnL - (frac * baseFull.sumPnL);
  }
  stable.sort((a, b) => b.improvement - a.improvement);

  emit(`  ${stable.length} stable KEEP-rules (lift PF +${PF_EPS} on both halves, n>=${MIN_N_PER_HALF} both halves):`);
  emit(`  ${'feature'.padEnd(28)} ${'bin'.padEnd(10)} ${'n'.padStart(5)} ${'WR%'.padStart(5)} ${'PF'.padStart(5)} ${'sum'.padStart(7)} | ${'tr_n'.padStart(5)} ${'tr_PF'.padStart(5)} ${'tr_sum'.padStart(7)} | ${'te_n'.padStart(5)} ${'te_PF'.padStart(5)} ${'te_sum'.padStart(7)} | improv`);
  for (const r of stable.slice(0, 40)) {
    emit(`  ${r.feature.padEnd(28)} ${r.bin.padEnd(10)}`
      + ` ${r.fAll.n.toString().padStart(5)}`
      + ` ${r.fAll.wr.toFixed(1).padStart(5)}`
      + ` ${(isFinite(r.fAll.pf) ? r.fAll.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${r.fAll.sumPnL.toFixed(0).padStart(7)}`
      + ` | ${r.fTrain.n.toString().padStart(5)}`
      + ` ${(isFinite(r.fTrain.pf) ? r.fTrain.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${r.fTrain.sumPnL.toFixed(0).padStart(7)}`
      + ` | ${r.fTest.n.toString().padStart(5)}`
      + ` ${(isFinite(r.fTest.pf) ? r.fTest.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${r.fTest.sumPnL.toFixed(0).padStart(7)}`
      + ` | ${r.improvement.toFixed(0)}`);
  }
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
