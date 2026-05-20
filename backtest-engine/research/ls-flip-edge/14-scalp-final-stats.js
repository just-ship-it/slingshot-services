/**
 * Phase G-5 — Final strategy stats for the 93%+ WR scalp candidate.
 *
 * Filter chain:
 *   1. 3m LS flip
 *   2. AGAINST higher TFs (state != s1m AND state != s15m)
 *   3. Direction-aware appropriate wick Q5 on 1st 1m bar of 3m bar:
 *      - new_state=0 (bearish flip → fade LONG): candle_wick_dn >= 3.75 pt
 *      - new_state=1 (bullish flip → fade SHORT): candle_wick_up >= 3.25 pt
 *   4. candle_body Q5 (top 20% in this cell — compute and report cutoff)
 *
 * Entry mechanic: 1s bar close where stop_dist (to swing low/high over
 * last 300s) is within 18pt. Stop = swing point ± 1pt buffer.
 * Target = entry + 3 pts (LONG) / entry - 3 pts (SHORT).
 *
 * Report: WR, PF, Sharpe, MaxDD, monthly distribution, train/test split.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENTRIES = path.join(__dirname, 'output', '10b-scalp-small.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '14-final-stats.txt');
const TRADES_JSON = path.join(__dirname, 'output', 'candidate-scalp-93wr.json');

const TF = '3m';
const LOOKBACK = 300;
const TARGET = 3;
const STOP_BUCKET = 18;
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

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

function getNum(m, col) { const i = F.idx[col]; if (i == null) return null; const v = +m.f[i]; return isFinite(v) ? v : null; }

// Compute cell-wide candle_body Q5 cutoff (top 20%)
const bodyVals = merged.map(m => getNum(m, 'candle_body')).filter(v => v != null).sort((a, b) => a - b);
const bodyCutoff = bodyVals[Math.floor(bodyVals.length * 4 / 5)];
console.log(`  cell n=${merged.length}, candle_body Q5 cutoff: ${bodyCutoff.toFixed(2)} pts`);

function passDirectionAwareWick(m) {
  const ns = +m.e[E.idx.new_state];
  if (ns === 0) { const v = getNum(m, 'candle_wick_dn'); return v != null && v >= 3.75; }
  if (ns === 1) { const v = getNum(m, 'candle_wick_up'); return v != null && v >= 3.25; }
  return false;
}
function passCandleBodyQ5(m) {
  const v = getNum(m, 'candle_body');
  return v != null && v >= bodyCutoff;
}

const final = merged.filter(m => passDirectionAwareWick(m) && passCandleBodyQ5(m));
console.log(`Final filtered: ${final.length} trades`);

const trades = final.map(m => ({
  flip_ts_ms: +m.e[E.idx.flip_ts_ms],
  flip_ts_iso: m.e[E.idx.flip_ts_iso],
  entry_ts_ms: +m.e[E.idx.entry_ts_ms],
  tf: m.e[E.idx.tf],
  direction: m.e[E.idx.direction],
  new_state: +m.e[E.idx.new_state],
  s1m: +m.e[E.idx.s1m_at_flip],
  s3m: +m.e[E.idx.s3m_at_flip],
  s15m: +m.e[E.idx.s15m_at_flip],
  entry_price: +m.e[E.idx.entry_price],
  stop_price: +m.e[E.idx.stop_price],
  target_price: +m.e[E.idx.target_price],
  stop_dist: +m.e[E.idx.stop_dist],
  exit_ts_ms: +m.e[E.idx.exit_ts_ms],
  exit_price: +m.e[E.idx.exit_price],
  outcome: m.e[E.idx.outcome],
  pnl_pts: +m.e[E.idx.pnl_pts],
  wait_to_entry_s: +m.e[E.idx.wait_to_entry_s],
  hold_s: +m.e[E.idx.hold_s],
  candle_wick_up: getNum(m, 'candle_wick_up'),
  candle_wick_dn: getNum(m, 'candle_wick_dn'),
  candle_body: getNum(m, 'candle_body'),
  atr_20: getNum(m, 'atr_20'),
  session: m.f[F.idx.session],
  hour_et: +m.f[F.idx.hour_et],
}));

fs.writeFileSync(TRADES_JSON, JSON.stringify(trades, null, 2));

function computeStats(arr, contractDollar = 20) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a.flip_ts_ms - b.flip_ts_ms);
  let n = 0, wins = 0, sumPnl = 0, gp = 0, gl = 0;
  let cum = 0, peak = 0, maxDD = 0;
  const returns = [];
  for (const t of sorted) {
    n++; sumPnl += t.pnl_pts; cum += t.pnl_pts;
    if (cum > peak) peak = cum;
    const dd = peak - cum; if (dd > maxDD) maxDD = dd;
    if (t.pnl_pts > 0) { wins++; gp += t.pnl_pts; }
    else if (t.pnl_pts < 0) gl += -t.pnl_pts;
    returns.push(t.pnl_pts);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const perTradeSharpe = std > 0 ? mean / std : 0;
  const firstTs = sorted[0].flip_ts_ms, lastTs = sorted[sorted.length - 1].flip_ts_ms;
  const years = (lastTs - firstTs) / (365.25 * 24 * 3600 * 1000);
  const tradesPerYear = years > 0 ? n / years : 0;
  const annualSharpe = perTradeSharpe * Math.sqrt(tradesPerYear);
  const ddPct = peak > 0 ? maxDD / peak * 100 : 0;
  return {
    n, wins, sumPnl, sumDol: sumPnl * contractDollar,
    wr: wins / n * 100, pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0),
    avg: sumPnl / n, perTradeSharpe, annualSharpe,
    maxDD, ddPct, maxDDdol: maxDD * contractDollar,
    tradesPerYear, years,
  };
}

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase G-5 — Final strategy stats ===`);
emit(`Filter chain:`);
emit(`  1. 3m LS flip (AGAINST higher TFs)`);
emit(`  2. Direction-aware wick Q5 (wick_dn>=3.75 for LONG, wick_up>=3.25 for SHORT, on 1st 1m of 3m bar)`);
emit(`  3. candle_body >= ${bodyCutoff.toFixed(2)}pt (cell Q5 cutoff)`);
emit(`  Entry: 1s bar close where stop_dist (to 300s rolling swing) <= 18pt`);
emit(`  Stop: swing ± 1pt buffer | Target: ${TARGET}pt | Max wait: 15min | Max hold: 30min\n`);

const full = computeStats(trades);
const train = computeStats(trades.filter(t => t.flip_ts_ms < SPLIT_TS));
const test = computeStats(trades.filter(t => t.flip_ts_ms >= SPLIT_TS));

emit(`Trades JSON: ${TRADES_JSON}\n`);
emit(`FULL (${full.years.toFixed(2)}yr):`);
emit(`  n=${full.n}  WR=${full.wr.toFixed(1)}%  PF=${full.pf.toFixed(2)}  avg=${full.avg.toFixed(2)}pt  sum=${full.sumPnl.toFixed(0)}pt ($${(full.sumDol / 1000).toFixed(1)}k @1NQ)`);
emit(`  Sharpe(yr)=${full.annualSharpe.toFixed(2)}  perTrade=${full.perTradeSharpe.toFixed(3)}  trades/yr=${full.tradesPerYear.toFixed(0)}`);
emit(`  MaxDD=${full.maxDD.toFixed(0)}pt ($${(full.maxDDdol / 1000).toFixed(1)}k)  DD%=${full.ddPct.toFixed(2)}%`);
emit('');
if (train) emit(`TRAIN (<2025-09-15): n=${train.n}  WR=${train.wr.toFixed(1)}%  PF=${train.pf.toFixed(2)}  Sharpe=${train.annualSharpe.toFixed(2)}  DD%=${train.ddPct.toFixed(2)}%  sum=${train.sumPnl.toFixed(0)}`);
if (test) emit(`TEST  (>=2025-09-15): n=${test.n}  WR=${test.wr.toFixed(1)}%  PF=${test.pf.toFixed(2)}  Sharpe=${test.annualSharpe.toFixed(2)}  DD%=${test.ddPct.toFixed(2)}%  sum=${test.sumPnl.toFixed(0)}`);

// Outcome distribution
let nt = 0, ns = 0, nto = 0, sumWin = 0, sumLoss = 0;
for (const t of trades) {
  if (t.outcome === 'target') { nt++; sumWin += t.pnl_pts; }
  else if (t.outcome === 'stop') { ns++; sumLoss += t.pnl_pts; }
  else { nto++; }
}
emit(`\nOutcomes: target=${nt} (${(nt / trades.length * 100).toFixed(1)}%)  stop=${ns} (${(ns / trades.length * 100).toFixed(1)}%)  timeout=${nto}`);
if (ns > 0) emit(`  avg win=${(sumWin / nt).toFixed(2)}pt  avg loss=${(sumLoss / ns).toFixed(2)}pt  effective RR=${(Math.abs(sumLoss / ns) / (sumWin / nt)).toFixed(2)}`);

// Hold time distribution
const holds = trades.map(t => t.hold_s).filter(x => isFinite(x));
holds.sort((a, b) => a - b);
const med = holds[Math.floor(holds.length / 2)];
const p25 = holds[Math.floor(holds.length / 4)];
const p75 = holds[Math.floor(holds.length * 3 / 4)];
const max = holds[holds.length - 1];
emit(`\nHold time: p25=${p25}s  median=${med}s  p75=${p75}s  max=${max}s`);

// Wait-to-entry distribution
const waits = trades.map(t => t.wait_to_entry_s).filter(x => isFinite(x));
waits.sort((a, b) => a - b);
const wmed = waits[Math.floor(waits.length / 2)];
const wp25 = waits[Math.floor(waits.length / 4)];
const wp75 = waits[Math.floor(waits.length * 3 / 4)];
emit(`Wait to entry: p25=${wp25}s  median=${wmed}s  p75=${wp75}s`);

// Monthly distribution
const byMonth = new Map();
for (const t of trades) {
  const d = new Date(t.flip_ts_ms);
  const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  if (!byMonth.has(k)) byMonth.set(k, { n: 0, w: 0, sum: 0 });
  const m = byMonth.get(k);
  m.n++; m.sum += t.pnl_pts; if (t.pnl_pts > 0) m.w++;
}
emit(`\nMonthly:`);
for (const [k, v] of Array.from(byMonth.entries()).sort()) {
  emit(`  ${k}: n=${v.n.toString().padStart(3)} wins=${v.w.toString().padStart(3)} WR=${(v.w / v.n * 100).toFixed(0)}% sum=${v.sum.toFixed(1).padStart(6)}pt ($${(v.sum * 20 / 1000).toFixed(2)}k)`);
}

// New-state side distribution
const byNs = { 0: [], 1: [] };
for (const t of trades) byNs[t.new_state].push(t);
emit(`\nBy direction:`);
for (const ns of [0, 1]) {
  const s = computeStats(byNs[ns]);
  if (!s) continue;
  const dir = ns === 0 ? 'LONG (bear flip)' : 'SHORT (bull flip)';
  emit(`  ${dir}: n=${s.n}  WR=${s.wr.toFixed(1)}%  PF=${s.pf.toFixed(2)}  sum=${s.sumPnl.toFixed(0)}pt`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
