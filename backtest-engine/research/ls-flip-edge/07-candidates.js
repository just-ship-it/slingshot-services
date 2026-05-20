/**
 * Phase E-1 — Extract stop/target grid surface for filter candidates.
 *
 * Uses Phase A's existing 1s-honest grid (4 stops × 4 targets, 60min maxhold).
 * For each candidate filter rule, prints the full surface so we can pick
 * the (s, t) pair with the best PF and sumPnL on both train and test.
 *
 * Phase E-2 (separate) will do finer-grid + BE + maxhold sweep on the winner.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVENTS = path.join(__dirname, 'output', '01-events.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '07-candidates.txt');

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
    name: 'A. 3m AGAINST + session=open (09:30-11 ET)',
    tf: '3m', dir: 'fade',
    filter: m => isAgainst(m, '3m') && m.f[B.idx.session] === 'open',
  },
  {
    name: 'B. 3m AGAINST + candle_body/ATR >= Q5 cutoff (0.82)',
    tf: '3m', dir: 'fade',
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      const cb = +m.f[B.idx.candle_body];
      const atr = +m.f[B.idx.atr_20];
      if (!isFinite(cb) || !isFinite(atr) || atr === 0) return false;
      return (cb / atr) >= 0.82;
    },
  },
  {
    name: 'C. 3m AGAINST + qqq_iv in Q4 (0.20-0.25)',
    tf: '3m', dir: 'fade',
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      const iv = +m.f[B.idx.qqq_iv];
      return iv >= 0.20 && iv <= 0.25;
    },
  },
  {
    name: 'D. 3m AGAINST + mom_30m Q1 (<= -4.25 pts)',
    tf: '3m', dir: 'fade',
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      const ns = +m.e[A.idx.new_state];
      const mom30 = +m.f[B.idx.mom_30m];
      if (!isFinite(mom30)) return false;
      // For LONG fade (ns=0, bearish flip), fade after DOWN move (mom30 negative)
      // For SHORT fade (ns=1, bullish flip), fade after UP move (mom30 positive)
      return ns === 0 ? mom30 <= -4.25 : mom30 >= 4.25;
    },
  },
  {
    name: 'E. 3m AGAINST (no 2nd filter — baseline)',
    tf: '3m', dir: 'fade',
    filter: m => isAgainst(m, '3m'),
  },
  {
    name: 'F. 1m AGAINST + nearest_s_idx=1',
    tf: '1m', dir: 'fade',
    filter: m => isAgainst(m, '1m') && m.f[B.idx.nearest_s_idx] === '1',
  },
  {
    name: 'G. 1m AGAINST + dist_pw Q1 (close to put_wall, dist <= 129)',
    tf: '1m', dir: 'fade',
    filter: m => {
      if (!isAgainst(m, '1m')) return false;
      const d = +m.f[B.idx.dist_pw];
      return isFinite(d) && d <= 129.8;
    },
  },
  {
    name: 'H. 1m AGAINST (baseline, no 2nd filter)',
    tf: '1m', dir: 'fade',
    filter: m => isAgainst(m, '1m'),
  },
  // Composite candidates: AGAINST + 2 second-filters
  {
    name: 'I. 3m AGAINST + session=open + candle_body/ATR >= 0.82',
    tf: '3m', dir: 'fade',
    filter: m => {
      if (!isAgainst(m, '3m')) return false;
      if (m.f[B.idx.session] !== 'open') return false;
      const cb = +m.f[B.idx.candle_body];
      const atr = +m.f[B.idx.atr_20];
      if (!isFinite(cb) || !isFinite(atr) || atr === 0) return false;
      return (cb / atr) >= 0.82;
    },
  },
];

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase E-1 — Grid surface for filter candidates ===`);
emit(`(uses Phase A 1s-honest fills with 60min maxhold, no BE)\n`);

for (const cand of CANDIDATES) {
  const subset = merged.filter(m => m.e[A.idx.tf] === cand.tf && m.e[A.idx.direction] === cand.dir && cand.filter(m));
  const trainSet = subset.filter(m => +m.e[A.idx.flip_ts_ms] < SPLIT_TS);
  const testSet = subset.filter(m => +m.e[A.idx.flip_ts_ms] >= SPLIT_TS);

  emit(`\n=== ${cand.name} (${cand.tf} fade) ===`);
  emit(`  n_full=${subset.length}  train=${trainSet.length}  test=${testSet.length}`);
  emit(`  s/t          n   WR%    PF    avg     sum (pts)  | tr_PF  tr_sum | te_PF  te_sum | RR  $@$20/pt`);

  let bestPF_full = 0, bestKey = '';
  for (const s of STOP_PTS) for (const t of TARGET_PTS) {
    const key = `s${s}_t${t}`;
    const pnlIdx = A.idx[`pnl_${key}`];
    const f = summarize(subset, pnlIdx);
    const ft = summarize(trainSet, pnlIdx);
    const fe = summarize(testSet, pnlIdx);
    if (f.n === 0) continue;
    const stable = (isFinite(ft.pf) && isFinite(fe.pf) && ft.pf >= 1.20 && fe.pf >= 1.20);
    if (f.pf > bestPF_full && stable) { bestPF_full = f.pf; bestKey = key; }
    const dollars = f.sumPnL * 20; // 1 NQ contract
    emit(`  s${s.toString().padEnd(2)}/t${t.toString().padEnd(3)}`
      + ` ${f.n.toString().padStart(4)}`
      + ` ${f.wr.toFixed(1).padStart(5)}`
      + ` ${(isFinite(f.pf) ? f.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${f.avg.toFixed(2).padStart(6)}`
      + ` ${f.sumPnL.toFixed(0).padStart(9)} `
      + ` | ${(isFinite(ft.pf) ? ft.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${ft.sumPnL.toFixed(0).padStart(7)}`
      + ` | ${(isFinite(fe.pf) ? fe.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${fe.sumPnL.toFixed(0).padStart(7)}`
      + ` | ${(t / s).toFixed(2).padStart(4)}`
      + ` $${(dollars / 1000).toFixed(1)}k`
      + (key === bestKey ? '  <-- best stable' : '')
      + (stable ? '' : '  (unstable)')
    );
  }
}
fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
