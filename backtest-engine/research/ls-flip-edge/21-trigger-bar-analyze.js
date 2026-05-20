/**
 * Phase I-2 — Analyze trigger-bar trade output.
 *
 * Reports:
 *   - Outcome distribution (won/lost/cancel reasons)
 *   - WR / PF / sumPnL by (tf, direction, against)
 *   - WR by flip-bar range bucket
 *   - Sharpe / MaxDD on best cells
 *   - Train/test split (2025-09-15)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const IN = arg('in', path.join(__dirname, 'output', '20-trigger-bar.csv'));
const OUT = arg('out', path.join(__dirname, 'output', '21-trigger-bar-analysis.txt'));
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

const text = fs.readFileSync(IN, 'utf-8');
const lines = text.trim().split('\n');
const hdr = lines[0].split(',');
const idx = {}; hdr.forEach((h, i) => idx[h] = i);

const rows = [];
for (let i = 1; i < lines.length; i++) {
  const p = lines[i].split(',');
  rows.push({
    event_id: +p[idx.event_id],
    tf: p[idx.tf],
    flip_ts: +p[idx.flip_ts],
    direction: p[idx.direction],
    against: p[idx.against] === '1',
    prior_state: +p[idx.prior_state],
    new_state: +p[idx.new_state],
    flip_open: +p[idx.flip_open],
    flip_high: +p[idx.flip_high],
    flip_low: +p[idx.flip_low],
    flip_close: +p[idx.flip_close],
    mid: +p[idx.mid],
    range: +p[idx.range],
    s1m: +p[idx.s1m], s3m: +p[idx.s3m], s15m: +p[idx.s15m],
    outcome: p[idx.outcome],
    actual_fill_ts: p[idx.actual_fill_ts] === '' ? null : +p[idx.actual_fill_ts],
    entry_price: p[idx.entry_price] === '' ? null : +p[idx.entry_price],
    exit_ts: p[idx.exit_ts] === '' ? null : +p[idx.exit_ts],
    pnl_pts: p[idx.pnl_pts] === '' ? null : +p[idx.pnl_pts],
  });
}
console.log(`Loaded ${rows.length} rows`);

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }
emit(`\n=== Phase I-2 — Trigger-bar trade analysis ===`);
emit(`File: ${IN}\n`);

// Outcome distribution
const oc = new Map();
for (const r of rows) oc.set(r.outcome, (oc.get(r.outcome) || 0) + 1);
emit(`Outcome distribution:`);
for (const [k, v] of [...oc.entries()].sort()) emit(`  ${k.padEnd(24)} ${v}`);
emit('');

function summarize(arr) {
  let n = 0, w = 0, l = 0, to = 0, pnl = 0, sumWin = 0, sumLoss = 0;
  let sumRange = 0;
  const sorted = arr.slice().sort((a, b) => a.flip_ts - b.flip_ts);
  let cum = 0, peak = 0, maxDD = 0;
  const returns = [];
  for (const r of sorted) {
    const isWin = r.outcome === 'win' || r.outcome === 'win_same_bar';
    const isLoss = r.outcome === 'loss' || r.outcome === 'loss_same_bar';
    const isTimeout = r.outcome === 'timeout';
    if (isWin || isLoss || isTimeout) {
      n++;
      const p = r.pnl_pts || 0;
      pnl += p;
      sumRange += r.range;
      if (isWin) { w++; sumWin += p; }
      else if (isLoss) { l++; sumLoss += -p; }
      else { to++; }
      cum += p;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
      returns.push(p);
    }
  }
  const wr = n ? w / n * 100 : 0;
  const pf = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0);
  const avg = n ? pnl / n : 0;
  const avgRange = n ? sumRange / n : 0;
  let mean = 0, std = 0, annSharpe = 0;
  if (returns.length) {
    mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const v = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    std = Math.sqrt(v);
    if (std > 0 && sorted.length > 1) {
      const yrs = (sorted[sorted.length - 1].flip_ts - sorted[0].flip_ts) / (365.25 * 24 * 3600 * 1000);
      const tpy = yrs > 0 ? n / yrs : 0;
      annSharpe = (mean / std) * Math.sqrt(tpy);
    }
  }
  const ddPct = peak > 0 ? (maxDD / peak) * 100 : 0;
  return { n, w, l, to, pnl, wr, pf, avg, avgRange, annSharpe, maxDD, ddPct };
}

// By (tf, direction, against) with train/test
emit(`Filled-trade WR by (tf, direction, against):`);
emit(`  ${'cell'.padEnd(28)} ${'n'.padStart(4)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'avg'.padStart(5)} ${'rng'.padStart(5)} ${'Shrp'.padStart(5)} ${'DD%'.padStart(5)} ${'sum'.padStart(7)} | tr_n tr_WR tr_PF | te_n te_WR te_PF`);
const grp = new Map();
for (const r of rows) {
  const k = `${r.tf}|${r.direction}|against=${r.against ? 'Y' : 'N'}`;
  if (!grp.has(k)) grp.set(k, []);
  grp.get(k).push(r);
}
const grpList = [...grp.entries()].sort();
for (const [k, arr] of grpList) {
  const f = summarize(arr);
  const t = summarize(arr.filter(r => r.flip_ts < SPLIT_TS));
  const e = summarize(arr.filter(r => r.flip_ts >= SPLIT_TS));
  emit(`  ${k.padEnd(28)} ${f.n.toString().padStart(4)} ${f.wr.toFixed(1).padStart(5)} ${f.pf.toFixed(2).padStart(5)} ${f.avg.toFixed(2).padStart(5)} ${f.avgRange.toFixed(1).padStart(5)} ${f.annSharpe.toFixed(2).padStart(5)} ${f.ddPct.toFixed(1).padStart(5)} ${f.pnl.toFixed(0).padStart(7)} | ${t.n.toString().padStart(4)} ${t.wr.toFixed(1).padStart(5)} ${t.pf.toFixed(2).padStart(5)} | ${e.n.toString().padStart(4)} ${e.wr.toFixed(1).padStart(5)} ${e.pf.toFixed(2).padStart(5)}`);
}

// By range bucket within best cells
emit(`\nBy flip-bar range bucket (1m, against=Y, both directions combined):`);
const bestCells = ['1m|long|against=Y', '1m|short|against=Y', '1m|long|against=N', '1m|short|against=N'];
for (const cell of bestCells) {
  const arr = grp.get(cell) || [];
  emit(`\n  ${cell}:`);
  // Quartile breaks
  const ranges = arr.map(r => r.range).filter(x => isFinite(x)).sort((a, b) => a - b);
  if (ranges.length < 12) { emit(`    (only ${ranges.length} entries, skip)`); continue; }
  const q = [ranges[Math.floor(ranges.length / 4)], ranges[Math.floor(ranges.length / 2)], ranges[Math.floor(ranges.length * 3 / 4)]];
  emit(`    range quartile breakpoints: Q1=${q[0].toFixed(1)} Q2=${q[1].toFixed(1)} Q3=${q[2].toFixed(1)}`);
  for (let b = 0; b < 4; b++) {
    const lo = b === 0 ? -Infinity : q[b - 1];
    const hi = b === 3 ? Infinity : q[b];
    const sub = arr.filter(r => r.range > lo && r.range <= hi);
    const s = summarize(sub);
    if (s.n < 5) continue;
    emit(`    Q${b + 1} range (${lo === -Infinity ? '..' : lo.toFixed(1)} .. ${hi === Infinity ? '..' : hi.toFixed(1)}): n=${s.n} WR=${s.wr.toFixed(1)}% PF=${s.pf.toFixed(2)} avg=${s.avg.toFixed(2)} sum=${s.pnl.toFixed(0)}`);
  }
}

// Overall stats for combined: 1m, any direction, against=Y
emit(`\n--- COMBINED: 1m + against=Y (both directions) ---`);
const combined = rows.filter(r => r.tf === '1m' && r.against);
const c = summarize(combined);
const ct = summarize(combined.filter(r => r.flip_ts < SPLIT_TS));
const ce = summarize(combined.filter(r => r.flip_ts >= SPLIT_TS));
emit(`  FULL: n=${c.n} WR=${c.wr.toFixed(1)}% PF=${c.pf.toFixed(2)} avg=${c.avg.toFixed(2)}pt avg_range=${c.avgRange.toFixed(1)}pt Sharpe=${c.annSharpe.toFixed(2)} MaxDD=${c.ddPct.toFixed(1)}% sumPnL=${c.pnl.toFixed(0)}pt ($${(c.pnl * 20 / 1000).toFixed(1)}k @1NQ)`);
emit(`  TRAIN: n=${ct.n} WR=${ct.wr.toFixed(1)}% PF=${ct.pf.toFixed(2)} Sharpe=${ct.annSharpe.toFixed(2)} sumPnL=${ct.pnl.toFixed(0)}`);
emit(`  TEST:  n=${ce.n} WR=${ce.wr.toFixed(1)}% PF=${ce.pf.toFixed(2)} Sharpe=${ce.annSharpe.toFixed(2)} sumPnL=${ce.pnl.toFixed(0)}`);

emit(`\n--- COMBINED: 1m, any against, both directions ---`);
const all1m = rows.filter(r => r.tf === '1m');
const a = summarize(all1m);
const at = summarize(all1m.filter(r => r.flip_ts < SPLIT_TS));
const ae = summarize(all1m.filter(r => r.flip_ts >= SPLIT_TS));
emit(`  FULL: n=${a.n} WR=${a.wr.toFixed(1)}% PF=${a.pf.toFixed(2)} avg=${a.avg.toFixed(2)}pt avg_range=${a.avgRange.toFixed(1)}pt Sharpe=${a.annSharpe.toFixed(2)} MaxDD=${a.ddPct.toFixed(1)}% sumPnL=${a.pnl.toFixed(0)}pt ($${(a.pnl * 20 / 1000).toFixed(1)}k @1NQ)`);
emit(`  TRAIN: n=${at.n} WR=${at.wr.toFixed(1)}% PF=${at.pf.toFixed(2)} Sharpe=${at.annSharpe.toFixed(2)} sumPnL=${at.pnl.toFixed(0)}`);
emit(`  TEST:  n=${ae.n} WR=${ae.wr.toFixed(1)}% PF=${ae.pf.toFixed(2)} Sharpe=${ae.annSharpe.toFixed(2)} sumPnL=${ae.pnl.toFixed(0)}`);

emit(`\n--- COMBINED: 3m, any against, both directions ---`);
const all3m = rows.filter(r => r.tf === '3m');
const a3 = summarize(all3m);
const at3 = summarize(all3m.filter(r => r.flip_ts < SPLIT_TS));
const ae3 = summarize(all3m.filter(r => r.flip_ts >= SPLIT_TS));
emit(`  FULL: n=${a3.n} WR=${a3.wr.toFixed(1)}% PF=${a3.pf.toFixed(2)} avg=${a3.avg.toFixed(2)}pt avg_range=${a3.avgRange.toFixed(1)}pt Sharpe=${a3.annSharpe.toFixed(2)} MaxDD=${a3.ddPct.toFixed(1)}% sumPnL=${a3.pnl.toFixed(0)}pt ($${(a3.pnl * 20 / 1000).toFixed(1)}k @1NQ)`);
emit(`  TRAIN: n=${at3.n} WR=${at3.wr.toFixed(1)}% PF=${at3.pf.toFixed(2)} Sharpe=${at3.annSharpe.toFixed(2)} sumPnL=${at3.pnl.toFixed(0)}`);
emit(`  TEST:  n=${ae3.n} WR=${ae3.wr.toFixed(1)}% PF=${ae3.pf.toFixed(2)} Sharpe=${ae3.annSharpe.toFixed(2)} sumPnL=${ae3.pnl.toFixed(0)}`);

// Monthly distribution for 1m + against=Y
emit(`\nMonthly (1m + against=Y, filled trades):`);
const byMonth = new Map();
for (const r of combined) {
  if (!(r.outcome === 'win' || r.outcome === 'win_same_bar' || r.outcome === 'loss' || r.outcome === 'loss_same_bar' || r.outcome === 'timeout')) continue;
  const d = new Date(r.flip_ts);
  const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  if (!byMonth.has(k)) byMonth.set(k, { n: 0, w: 0, sum: 0 });
  const m = byMonth.get(k);
  m.n++; m.sum += r.pnl_pts || 0;
  if (r.outcome === 'win' || r.outcome === 'win_same_bar') m.w++;
}
for (const [k, v] of [...byMonth.entries()].sort()) {
  emit(`  ${k}: n=${v.n.toString().padStart(3)} wins=${v.w.toString().padStart(3)} WR=${(v.w / v.n * 100).toFixed(0).padStart(3)}% sumPnL=${v.sum.toFixed(1).padStart(7)}pt ($${(v.sum * 20 / 1000).toFixed(2)}k)`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
