/**
 * Phase E-2 — Compute Sharpe, Max DD, monthly distribution for the
 * top candidates. Filter the events file by the candidate's rule, then
 * build the chronological equity curve from per-trade PnL.
 *
 * Sharpe is on per-trade returns (industry-standard for backtest comparisons).
 * Annualized Sharpe = perTradeSharpe * sqrt(trades_per_year).
 *
 * Max DD is on cumulative pts (or $) — peak-to-trough.
 *
 * Saves filtered trades JSON for each candidate cell into output/winner-*.json
 * so we can do independence checks vs production trio in Phase F.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVENTS = path.join(__dirname, 'output', '01-events.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '08-sharpe-dd.txt');
const OUT_DIR = path.join(__dirname, 'output');

const STOP_PTS = [8, 15, 25, 40];
const TARGET_PTS = [15, 30, 60, 120];
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

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

function isAgainst(m, tf) {
  const ns = +m.e[A.idx.new_state];
  const s3 = +m.f[B.idx.s3m_at_flip];
  const s15 = +m.f[B.idx.s15m_at_flip];
  const s1 = +m.f[B.idx.s1m_at_flip];
  if (tf === '1m') return (ns !== s3) && (ns !== s15);
  return (ns !== s15) && (ns !== s1);
}

const CANDIDATES = [
  {
    name: 'B-s25-t30', desc: '3m AGAINST + body/ATR>=0.82, s=25 t=30',
    tf: '3m', dir: 'fade', s: 25, t: 30,
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      const cb = +m.f[B.idx.candle_body];
      const atr = +m.f[B.idx.atr_20];
      if (!isFinite(cb) || !isFinite(atr) || atr === 0) return false;
      return (cb / atr) >= 0.82;
    },
  },
  {
    name: 'B-s25-t60', desc: '3m AGAINST + body/ATR>=0.82, s=25 t=60',
    tf: '3m', dir: 'fade', s: 25, t: 60,
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      const cb = +m.f[B.idx.candle_body];
      const atr = +m.f[B.idx.atr_20];
      if (!isFinite(cb) || !isFinite(atr) || atr === 0) return false;
      return (cb / atr) >= 0.82;
    },
  },
  {
    name: 'B-s40-t60', desc: '3m AGAINST + body/ATR>=0.82, s=40 t=60',
    tf: '3m', dir: 'fade', s: 40, t: 60,
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      const cb = +m.f[B.idx.candle_body];
      const atr = +m.f[B.idx.atr_20];
      if (!isFinite(cb) || !isFinite(atr) || atr === 0) return false;
      return (cb / atr) >= 0.82;
    },
  },
  {
    name: 'B-s40-t120', desc: '3m AGAINST + body/ATR>=0.82, s=40 t=120',
    tf: '3m', dir: 'fade', s: 40, t: 120,
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      const cb = +m.f[B.idx.candle_body];
      const atr = +m.f[B.idx.atr_20];
      if (!isFinite(cb) || !isFinite(atr) || atr === 0) return false;
      return (cb / atr) >= 0.82;
    },
  },
  {
    name: 'C-s25-t30', desc: '3m AGAINST + qqq_iv 0.20-0.25, s=25 t=30',
    tf: '3m', dir: 'fade', s: 25, t: 30,
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      const iv = +m.f[B.idx.qqq_iv];
      return iv >= 0.20 && iv <= 0.25;
    },
  },
  {
    name: 'A-s25-t60', desc: '3m AGAINST + session=open, s=25 t=60',
    tf: '3m', dir: 'fade', s: 25, t: 60,
    filter: m => isAgainst(m, '3m') && m.f[B.idx.session] === 'open',
  },
  {
    name: 'F-s25-t60', desc: '1m AGAINST + nearest_s_idx=1, s=25 t=60',
    tf: '1m', dir: 'fade', s: 25, t: 60,
    filter: m => isAgainst(m, '1m') && m.f[B.idx.nearest_s_idx] === '1',
  },
];

function computeStats(trades, contractDollarMult = 20) {
  // trades = [{ts, pnl_pts, ...}], chronological
  if (trades.length === 0) return null;
  let n = 0, wins = 0, sumPnL = 0, gp = 0, gl = 0;
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const eqPts = [];
  let cum = 0, peak = 0, maxDD = 0;
  const returns = [];
  for (const t of sorted) {
    n++;
    sumPnL += t.pnl_pts;
    cum += t.pnl_pts;
    eqPts.push(cum);
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    if (t.pnl_pts > 0) { wins++; gp += t.pnl_pts; }
    else if (t.pnl_pts < 0) { gl += -t.pnl_pts; }
    returns.push(t.pnl_pts);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  const sharpePerTrade = std > 0 ? mean / std : 0;
  // Trades per year: span of dates → trades / years
  const firstTs = sorted[0].ts, lastTs = sorted[sorted.length - 1].ts;
  const years = (lastTs - firstTs) / (365.25 * 24 * 3600 * 1000);
  const tradesPerYear = years > 0 ? n / years : 0;
  const annualSharpe = sharpePerTrade * Math.sqrt(tradesPerYear);
  const ddPct = peak > 0 ? (maxDD / peak) * 100 : 0;
  // Dollar versions
  const sumDol = sumPnL * contractDollarMult;
  const maxDDdol = maxDD * contractDollarMult;
  return {
    n, wins, sumPnL,
    wr: (wins / n) * 100,
    pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0),
    avg: sumPnL / n,
    sharpePerTrade,
    annualSharpe,
    maxDD, maxDDdol, ddPct,
    tradesPerYear,
    years,
    sumDol,
  };
}

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase E-2 — Sharpe, Max DD, monthly distribution ===`);
emit(`Train: <2025-09-15  |  Test: >=2025-09-15`);
emit(`Sharpe is annualized: perTradeSharpe * sqrt(trades/yr).\n`);

for (const cand of CANDIDATES) {
  const pnlIdx = A.idx[`pnl_${`s${cand.s}_t${cand.t}`}`];
  const subset = merged.filter(m =>
    m.e[A.idx.tf] === cand.tf &&
    m.e[A.idx.direction] === cand.dir &&
    cand.filter(m)
  );
  const trades = subset.map(m => {
    const v = m.e[pnlIdx];
    if (v === '') return null;
    return {
      ts: +m.e[A.idx.flip_ts_ms],
      flip_iso: m.e[A.idx.flip_ts_iso],
      pnl_pts: +v,
      outcome: m.e[A.idx[`out_s${cand.s}_t${cand.t}`]],
      new_state: +m.e[A.idx.new_state],
      side: m.e[A.idx.side],
      tf: cand.tf,
      entry_price: +m.e[A.idx.entry_price],
    };
  }).filter(t => t != null);

  const train = trades.filter(t => t.ts < SPLIT_TS);
  const test = trades.filter(t => t.ts >= SPLIT_TS);
  const all = computeStats(trades);
  const trn = computeStats(train);
  const tst = computeStats(test);

  emit(`\n=== ${cand.name}: ${cand.desc} ===`);
  if (!all) { emit('  (no trades)'); continue; }
  emit(`  full: n=${all.n}  PF=${all.pf.toFixed(2)}  WR=${all.wr.toFixed(1)}%  sumPnL=${all.sumPnL.toFixed(0)}pts ($${(all.sumDol / 1000).toFixed(1)}k)`);
  emit(`        Sharpe(yr)=${all.annualSharpe.toFixed(2)}  perTradeSharpe=${all.sharpePerTrade.toFixed(3)}  trades/yr=${all.tradesPerYear.toFixed(0)}`);
  emit(`        MaxDD=${all.maxDD.toFixed(0)}pts ($${(all.maxDDdol / 1000).toFixed(1)}k)  DD%=${all.ddPct.toFixed(2)}%`);
  if (trn) emit(`  train (n=${trn.n}): PF=${trn.pf.toFixed(2)} Sharpe=${trn.annualSharpe.toFixed(2)} DD%=${trn.ddPct.toFixed(2)}% sum=${trn.sumPnL.toFixed(0)}pts`);
  if (tst) emit(`  test  (n=${tst.n}): PF=${tst.pf.toFixed(2)} Sharpe=${tst.annualSharpe.toFixed(2)} DD%=${tst.ddPct.toFixed(2)}% sum=${tst.sumPnL.toFixed(0)}pts`);

  // Monthly bucket distribution
  const byMonth = new Map();
  for (const t of trades) {
    const d = new Date(t.ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, { n: 0, sum: 0 });
    const m = byMonth.get(key);
    m.n++; m.sum += t.pnl_pts;
  }
  emit(`  monthly:`);
  for (const [k, v] of Array.from(byMonth.entries()).sort()) {
    emit(`    ${k}: n=${v.n.toString().padStart(3)}  sum=${v.sum.toFixed(0).padStart(6)}pts ($${(v.sum * 20 / 1000).toFixed(1)}k)`);
  }

  // Save trades JSON for Phase F
  const outJson = path.join(OUT_DIR, `candidate-${cand.name}.json`);
  fs.writeFileSync(outJson, JSON.stringify(trades, null, 2));
  emit(`  saved trades: ${outJson}`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
