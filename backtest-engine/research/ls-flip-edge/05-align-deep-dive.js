/**
 * Phase C-3 — Deep dive on align_bits feature.
 *
 * Goal: explicitly characterize the 8 align_bits values (0-7) for each
 * target cell, then test composite "flip-against-higher-tfs" feature.
 *
 * align_bits bit0=s1m, bit1=s3m, bit2=s15m  (1=bullish, 0=bearish)
 *
 * For each cell × align_bits value:
 *   - n_train, n_test, PF_train, PF_test, sum_train, sum_test
 *   - new_state of flip (for 1m flips, =s1m at flip; for 3m, =s3m at flip)
 *
 * Then build composite features:
 *   - "fade_against_higher": for 1m, new_state != s3m AND new_state != s15m
 *                            for 3m, new_state != s15m
 *   - "all_three_aligned_after_flip": all three TFs same direction after flip
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVENTS = path.join(__dirname, 'output', '01-events.csv');
const FEATURES = path.join(__dirname, 'output', '02-features.csv');
const OUT = path.join(__dirname, 'output', '05-align-deep-dive.txt');

const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

const TARGET_CELLS = [
  { tf: '3m', dir: 'fade', s: 15, t: 30 },
  { tf: '3m', dir: 'fade', s: 8, t: 15 },
  { tf: '3m', dir: 'fade', s: 25, t: 60 },
  { tf: '1m', dir: 'fade', s: 15, t: 30 },
  { tf: '1m', dir: 'fade', s: 8, t: 15 },
  { tf: '1m', dir: 'fade', s: 25, t: 60 },
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

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase C-3 — align_bits deep-dive ===`);
emit(`bit0=s1m, bit1=s3m, bit2=s15m  (1=bullish, 0=bearish)\n`);

function decodeAlign(bits) {
  const b = +bits;
  return `s1m=${b & 1 ? 1 : 0} s3m=${(b >> 1) & 1 ? 1 : 0} s15m=${(b >> 2) & 1 ? 1 : 0}`;
}

for (const cell of TARGET_CELLS) {
  const cellKey = `s${cell.s}_t${cell.t}`;
  const pnlIdx = A.idx[`pnl_${cellKey}`];
  if (pnlIdx == null) continue;

  const subset = merged.filter(m => m.e[A.idx.tf] === cell.tf && m.e[A.idx.direction] === cell.dir);
  const train = subset.filter(m => +m.e[A.idx.flip_ts_ms] < SPLIT_TS);
  const test = subset.filter(m => +m.e[A.idx.flip_ts_ms] >= SPLIT_TS);
  const baseFull = summarize(subset, pnlIdx);
  const baseTrain = summarize(train, pnlIdx);
  const baseTest = summarize(test, pnlIdx);

  emit(`\n--- ${cell.tf} ${cell.dir.toUpperCase()} @ ${cellKey} ---`);
  emit(`  baseline: full n=${baseFull.n}  PF=${baseFull.pf.toFixed(2)}  WR=${baseFull.wr.toFixed(1)}%  sum=${baseFull.sumPnL.toFixed(0)}`);
  emit(`  train PF=${baseTrain.pf.toFixed(2)}/sum=${baseTrain.sumPnL.toFixed(0)}  test PF=${baseTest.pf.toFixed(2)}/sum=${baseTest.sumPnL.toFixed(0)}\n`);

  emit(`  bits  decoded                       n   WR%    PF     sum | tr_n tr_PF tr_sum | te_n te_PF te_sum | new_state_dist`);
  for (let b = 0; b < 8; b++) {
    const matches = subset.filter(m => +m.f[B.idx.align_bits] === b);
    if (matches.length === 0) continue;
    const mTrain = matches.filter(m => +m.e[A.idx.flip_ts_ms] < SPLIT_TS);
    const mTest = matches.filter(m => +m.e[A.idx.flip_ts_ms] >= SPLIT_TS);
    const f = summarize(matches, pnlIdx);
    const ft = summarize(mTrain, pnlIdx);
    const fe = summarize(mTest, pnlIdx);
    const ns0 = matches.filter(m => +m.e[A.idx.new_state] === 0).length;
    const ns1 = matches.filter(m => +m.e[A.idx.new_state] === 1).length;
    emit(`  ${b.toString().padStart(4)}  ${decodeAlign(b).padEnd(28)}`
      + ` ${f.n.toString().padStart(5)}`
      + ` ${f.wr.toFixed(1).padStart(5)}`
      + ` ${(isFinite(f.pf) ? f.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${f.sumPnL.toFixed(0).padStart(7)}`
      + ` | ${ft.n.toString().padStart(4)}`
      + ` ${(isFinite(ft.pf) ? ft.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${ft.sumPnL.toFixed(0).padStart(6)}`
      + ` | ${fe.n.toString().padStart(4)}`
      + ` ${(isFinite(fe.pf) ? fe.pf.toFixed(2) : '∞').padStart(5)}`
      + ` ${fe.sumPnL.toFixed(0).padStart(6)}`
      + ` | new=0:${ns0} new=1:${ns1}`);
  }

  // Composite: fade_against_higher
  // For 1m TF: new_state != s3m AND new_state != s15m
  // For 3m TF: new_state != s15m (and optionally != s1m, but s1m is usually flipping too)
  const composite = subset.map(m => {
    const ns = +m.e[A.idx.new_state];
    const s3 = +m.f[B.idx.s3m_at_flip];
    const s15 = +m.f[B.idx.s15m_at_flip];
    const s1 = +m.f[B.idx.s1m_at_flip];
    let against;
    if (cell.tf === '1m') against = (ns !== s3) && (ns !== s15);
    else against = (ns !== s15) && (ns !== s1);
    return { m, against };
  });
  const grpAgainst = composite.filter(x => x.against).map(x => x.m);
  const grpWith = composite.filter(x => !x.against).map(x => x.m);
  const gA = summarize(grpAgainst, pnlIdx);
  const gW = summarize(grpWith, pnlIdx);
  const gATrain = summarize(grpAgainst.filter(m => +m.e[A.idx.flip_ts_ms] < SPLIT_TS), pnlIdx);
  const gATest = summarize(grpAgainst.filter(m => +m.e[A.idx.flip_ts_ms] >= SPLIT_TS), pnlIdx);
  const gWTrain = summarize(grpWith.filter(m => +m.e[A.idx.flip_ts_ms] < SPLIT_TS), pnlIdx);
  const gWTest = summarize(grpWith.filter(m => +m.e[A.idx.flip_ts_ms] >= SPLIT_TS), pnlIdx);
  emit(`\n  COMPOSITE: fade_against_higher_tfs (${cell.tf === '1m' ? 'new_state != s3m AND != s15m' : 'new_state != s15m AND != s1m'})`);
  emit(`    AGAINST=true:  full n=${gA.n} PF=${gA.pf.toFixed(2)} WR=${gA.wr.toFixed(1)}% sum=${gA.sumPnL.toFixed(0)}  |  train n=${gATrain.n} PF=${gATrain.pf.toFixed(2)} sum=${gATrain.sumPnL.toFixed(0)}  |  test n=${gATest.n} PF=${gATest.pf.toFixed(2)} sum=${gATest.sumPnL.toFixed(0)}`);
  emit(`    AGAINST=false: full n=${gW.n} PF=${gW.pf.toFixed(2)} WR=${gW.wr.toFixed(1)}% sum=${gW.sumPnL.toFixed(0)}  |  train n=${gWTrain.n} PF=${gWTrain.pf.toFixed(2)} sum=${gWTrain.sumPnL.toFixed(0)}  |  test n=${gWTest.n} PF=${gWTest.pf.toFixed(2)} sum=${gWTest.sumPnL.toFixed(0)}`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
