/**
 * Phase I-3 — Filter scan on trigger-bar trades.
 *
 * Merges 20-trigger-bar.csv (trade outcomes) with 02-features.csv (per-flip
 * features). For each feature × bin, computes:
 *   - DROP n / WR / PF / sumPnL / Sharpe / MaxDD  (i.e., trade list MINUS this bin)
 *   - Improvement in sumPnL vs proportional baseline
 *
 * Reports top DROP rules that reduce drawdown and lift PF.
 *
 * Also reports added range-based filters (range bucket KEEP rules) for the
 * existing 1m and 3m subsets.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const TRADES = arg('trades', path.join(__dirname, 'output', '20-trigger-bar.csv'));
const FEATURES = arg('features', path.join(__dirname, 'output', '02-features.csv'));
const OUT = arg('out', path.join(__dirname, 'output', '22-trigger-bar-filter.txt'));
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();
const SCOPE_TF = arg('tf', '1m'); // '1m', '3m', or 'both'

function loadCsv(p) {
  const text = fs.readFileSync(p, 'utf-8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = {}; header.forEach((h, i) => idx[h] = i);
  return { header, idx, rows: lines.slice(1).map(l => l.split(',')) };
}

console.log('Loading trades + features...');
const T = loadCsv(TRADES);
const F = loadCsv(FEATURES);
console.log(`  trades: ${T.rows.length}  features: ${F.rows.length}`);

const featByKey = new Map();
for (const r of F.rows) featByKey.set(`${r[F.idx.tf]}_${r[F.idx.flip_ts_ms]}`, r);

const resolved = ['win', 'win_same_bar', 'loss', 'loss_same_bar', 'timeout'];
const merged = [];
for (const t of T.rows) {
  if (!resolved.includes(t[T.idx.outcome])) continue;
  if (SCOPE_TF !== 'both' && t[T.idx.tf] !== SCOPE_TF) continue;
  const fr = featByKey.get(`${t[T.idx.tf]}_${t[T.idx.flip_ts]}`);
  if (!fr) continue;
  merged.push({ t, f: fr });
}
console.log(`  merged resolved trades (scope tf=${SCOPE_TF}): ${merged.length}`);

function getNum(m, col) {
  if (col === '_cb_atr') { const cb = +m.f[F.idx.candle_body], atr = +m.f[F.idx.atr_20]; if (!isFinite(cb) || !isFinite(atr) || atr === 0) return null; return cb / atr; }
  if (col === '_range') return +m.t[T.idx.range];
  if (col === '_mid_to_close_dist') {
    const mid = +m.t[T.idx.mid], close = +m.t[T.idx.flip_close];
    if (!isFinite(mid) || !isFinite(close)) return null;
    return Math.abs(close - mid);
  }
  if (col === '_mid_pos') {
    // where in the bar did close land relative to mid (0=at low, 1=at high)
    const low = +m.t[T.idx.flip_low], high = +m.t[T.idx.flip_high], close = +m.t[T.idx.flip_close];
    if (!isFinite(low) || !isFinite(high) || high === low) return null;
    return (close - low) / (high - low);
  }
  const i = F.idx[col]; if (i == null) return null;
  const v = +m.f[i]; return isFinite(v) ? v : null;
}
function getCat(m, col) {
  if (col === '_direction') return m.t[T.idx.direction];
  if (col === '_against') return m.t[T.idx.against];
  const i = F.idx[col]; if (i == null) return null;
  const v = m.f[i]; return v === '' ? null : v;
}

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

const baseFull = summarize(merged);
const baseTrain = summarize(merged.filter(m => +m.t[T.idx.flip_ts] < SPLIT_TS));
const baseTest = summarize(merged.filter(m => +m.t[T.idx.flip_ts] >= SPLIT_TS));

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }
emit(`\n=== Phase I-3 — Trigger-bar trade filter scan ===`);
emit(`Scope tf=${SCOPE_TF}  |  n=${merged.length}\n`);
emit(`BASELINE: n=${baseFull.n} WR=${baseFull.wr.toFixed(1)}% PF=${baseFull.pf.toFixed(2)} avg=${baseFull.avg.toFixed(2)}pt Sharpe=${baseFull.annSharpe.toFixed(2)} DD%=${baseFull.ddPct.toFixed(2)} sum=${baseFull.pnl.toFixed(0)}pt`);
emit(`  train: n=${baseTrain.n} WR=${baseTrain.wr.toFixed(1)}% PF=${baseTrain.pf.toFixed(2)} Sharpe=${baseTrain.annSharpe.toFixed(2)} DD%=${baseTrain.ddPct.toFixed(2)} sum=${baseTrain.pnl.toFixed(0)}`);
emit(`  test:  n=${baseTest.n} WR=${baseTest.wr.toFixed(1)}% PF=${baseTest.pf.toFixed(2)} Sharpe=${baseTest.annSharpe.toFixed(2)} DD%=${baseTest.ddPct.toFixed(2)} sum=${baseTest.pnl.toFixed(0)}\n`);

const FEATURES_DEF = [
  // Composite from trade row
  { name: '_direction', kind: 'cat' },
  { name: '_against', kind: 'cat' },
  { name: '_range', kind: 'num' },
  { name: '_mid_pos', kind: 'num' }, // close position within bar
  // From feature row
  { name: 'session', kind: 'cat' },
  { name: 'hour_et', kind: 'cat' },
  { name: 'weekday', kind: 'cat' },
  { name: 'gex_regime', kind: 'cat' },
  { name: 'nearest_r_idx', kind: 'cat' },
  { name: 'nearest_s_idx', kind: 'cat' },
  { name: 'candle_dir', kind: 'cat' },
  { name: 'new_state', kind: 'cat' },
  { name: 'align_bits', kind: 'cat' },
  { name: 'prior_state_duration_min', kind: 'num' },
  { name: 'flips_prev_30m', kind: 'num' },
  { name: 'flips_prev_60m', kind: 'num' },
  { name: 'minutes_into_rth', kind: 'num' },
  { name: '_cb_atr', kind: 'num' },
  { name: 'candle_body', kind: 'num' },
  { name: 'candle_wick_up', kind: 'num' },
  { name: 'candle_wick_dn', kind: 'num' },
  { name: 'mom_5m', kind: 'num' },
  { name: 'mom_15m', kind: 'num' },
  { name: 'mom_30m', kind: 'num' },
  { name: 'atr_20', kind: 'num' },
  { name: 'gex_multiplier', kind: 'num' },
  { name: 'gex_gi', kind: 'num' },
  { name: 'gex_total', kind: 'num' },
  { name: 'dist_cw', kind: 'num' },
  { name: 'dist_pw', kind: 'num' },
  { name: 'dist_gflip', kind: 'num' },
  { name: 'nearest_r_dist', kind: 'num' },
  { name: 'nearest_s_dist', kind: 'num' },
  { name: 'qqq_iv', kind: 'num' },
  { name: 'qqq_iv_chg_15m', kind: 'num' },
];

function quintiles(values) {
  const v = values.filter(x => x != null).sort((a, b) => a - b);
  if (v.length < 20) return null;
  return [v[Math.floor(v.length / 5)], v[Math.floor(v.length * 2 / 5)], v[Math.floor(v.length * 3 / 5)], v[Math.floor(v.length * 4 / 5)]];
}
function binNum(value, breaks) {
  if (value == null) return null;
  for (let i = 0; i < breaks.length; i++) if (value <= breaks[i]) return `Q${i + 1}`;
  return `Q${breaks.length + 1}`;
}

// For each feature × bin, compute DROP-this-bin stats (i.e., keep everything except this bin)
const drops = [];
for (const feat of FEATURES_DEF) {
  const vals = merged.map(m => feat.kind === 'num' ? getNum(m, feat.name) : getCat(m, feat.name));
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
    const keep = [];
    const drop = [];
    for (let i = 0; i < merged.length; i++) {
      if (labels[i] === u) drop.push(merged[i]);
      else keep.push(merged[i]);
    }
    if (drop.length < 30 || keep.length < 100) continue;

    // KEEP-after-drop stats
    const ka = summarize(keep);
    const kt = summarize(keep.filter(m => +m.t[T.idx.flip_ts] < SPLIT_TS));
    const ke = summarize(keep.filter(m => +m.t[T.idx.flip_ts] >= SPLIT_TS));
    const da = summarize(drop);

    drops.push({
      feat: feat.name, bin: u, breaks,
      drop_n: drop.length, drop_wr: da.wr, drop_pf: da.pf, drop_sum: da.pnl,
      keep_n: ka.n, keep_wr: ka.wr, keep_pf: ka.pf, keep_sum: ka.pnl, keep_sharpe: ka.annSharpe, keep_dd: ka.ddPct,
      kt_pf: kt.pf, kt_wr: kt.wr, kt_sum: kt.pnl,
      ke_pf: ke.pf, ke_wr: ke.wr, ke_sum: ke.pnl,
      // Improvement in sumPnL vs baseline
      improvement: ka.pnl - baseFull.pnl,
      pf_lift: ka.pf - baseFull.pf,
      sharpe_lift: ka.annSharpe - baseFull.annSharpe,
      dd_change: ka.ddPct - baseFull.ddPct,
    });
  }
}

// Rank by combined criteria: PF lift + DD reduction + sharpe lift, with train/test stable
const STABLE = drops.filter(d => d.kt_pf >= baseTrain.pf - 0.05 && d.ke_pf >= baseTest.pf - 0.05);
emit(`\n--- TOP DROP rules (filter improves PF, lowers DD, stable train/test, n_drop>=30) ---`);
emit(`  Sorted by PF lift × Sharpe lift (best 30):`);
emit(`  ${'feature'.padEnd(28)} ${'bin'.padEnd(10)} ${'drop_n'.padStart(6)} ${'drop_WR'.padStart(7)} ${'drop_PF'.padStart(7)} | ${'keep_n'.padStart(6)} ${'kPF'.padStart(5)} ${'kSh'.padStart(5)} ${'kDD%'.padStart(5)} ${'kPnL'.padStart(6)} | ${'PF↑'.padStart(5)} ${'Sh↑'.padStart(5)} ${'DD↓'.padStart(5)}`);
const ranked = STABLE.slice().sort((a, b) => (b.pf_lift + b.sharpe_lift / 5) - (a.pf_lift + a.sharpe_lift / 5));
for (const d of ranked.slice(0, 30)) {
  const dropPfStr = isFinite(d.drop_pf) ? d.drop_pf.toFixed(2) : '∞';
  emit(`  ${d.feat.padEnd(28)} ${String(d.bin).padEnd(10)} ${d.drop_n.toString().padStart(6)} ${d.drop_wr.toFixed(1).padStart(7)} ${dropPfStr.padStart(7)} | ${d.keep_n.toString().padStart(6)} ${d.keep_pf.toFixed(2).padStart(5)} ${d.keep_sharpe.toFixed(1).padStart(5)} ${d.keep_dd.toFixed(1).padStart(5)} ${d.keep_sum.toFixed(0).padStart(6)} | ${d.pf_lift.toFixed(2).padStart(5)} ${d.sharpe_lift.toFixed(1).padStart(5)} ${d.dd_change.toFixed(1).padStart(5)}`);
}

// Also report DROP rules ranked by DD reduction
emit(`\n--- TOP DROP rules by DD% reduction (n_drop>=30) ---`);
const ddRanked = STABLE.slice().sort((a, b) => a.dd_change - b.dd_change);
for (const d of ddRanked.slice(0, 20)) {
  emit(`  ${d.feat.padEnd(28)} ${String(d.bin).padEnd(10)} drop_n=${d.drop_n} drop_WR=${d.drop_wr.toFixed(1)}% drop_PF=${(isFinite(d.drop_pf) ? d.drop_pf.toFixed(2) : '∞')} | keep PF=${d.keep_pf.toFixed(2)} Sh=${d.keep_sharpe.toFixed(2)} DD%=${d.keep_dd.toFixed(2)} sum=${d.keep_sum.toFixed(0)} | DD change=${d.dd_change.toFixed(2)} PF change=${d.pf_lift.toFixed(2)}`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
