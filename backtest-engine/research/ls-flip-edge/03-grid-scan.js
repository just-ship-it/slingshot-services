/**
 * Phase C-1 — Unconditional grid scan: PF / WR / avg / sum across all
 * (tf, direction, stop, target) combinations. Helps pick the most promising
 * "target cell" to focus the univariate feature scan on.
 *
 * Splits also into train (first half) vs test (second half) to flag
 * grid cells that aren't stable across time.
 *
 * Usage:
 *   node research/ls-flip-edge/03-grid-scan.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVENTS = path.join(__dirname, 'output', '01-events.csv');
const OUT = path.join(__dirname, 'output', '03-grid-scan.txt');

const STOP_PTS = [8, 15, 25, 40];
const TARGET_PTS = [15, 30, 60, 120];

// Train/test boundary — midpoint of LS data range
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

console.log(`Loading ${EVENTS} ...`);
const text = fs.readFileSync(EVENTS, 'utf-8');
const lines = text.trim().split('\n');
const header = lines[0].split(',');
const colIdx = {};
header.forEach((h, i) => { colIdx[h] = i; });

const cellColIdx = {};
for (const s of STOP_PTS) for (const t of TARGET_PTS) {
  cellColIdx[`s${s}_t${t}`] = {
    out: colIdx[`out_s${s}_t${t}`],
    pnl: colIdx[`pnl_s${s}_t${t}`],
  };
}

// rows[i] = { tf, dir, flip_ts, pnl_by_cell: { s_t: pnl }, outcome_by_cell }
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const p = lines[i].split(',');
  const r = {
    tf: p[colIdx.tf],
    flip_ts: +p[colIdx.flip_ts_ms],
    dir: p[colIdx.direction], // fade | momentum
    side: p[colIdx.side],
    new_state: +p[colIdx.new_state],
    pnls: {},
    outs: {},
  };
  for (const k in cellColIdx) {
    const o = p[cellColIdx[k].out];
    const v = p[cellColIdx[k].pnl];
    r.outs[k] = o;
    r.pnls[k] = v === '' ? null : +v;
  }
  rows.push(r);
}
console.log(`  rows: ${rows.length.toLocaleString()}`);

function summarize(subset, cellKey) {
  let n = 0, wins = 0, sumPnL = 0, gp = 0, gl = 0;
  let nTimeout = 0, nTarget = 0, nStop = 0;
  for (const r of subset) {
    const v = r.pnls[cellKey];
    if (v == null) continue;
    n++; sumPnL += v;
    if (v > 0) { wins++; gp += v; }
    else if (v < 0) { gl += -v; }
    const o = r.outs[cellKey];
    if (o === 'target') nTarget++;
    else if (o === 'stop') nStop++;
    else nTimeout++;
  }
  return {
    n, wins, sumPnL,
    wr: n ? (wins / n) * 100 : 0,
    avg: n ? sumPnL / n : 0,
    pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0),
    nTarget, nStop, nTimeout,
  };
}

const lines_out = [];
function emit(s) { console.log(s); lines_out.push(s); }

emit(`\n=== Phase C-1 unconditional grid scan ===`);
emit(`Train (flip_ts < ${new Date(SPLIT_TS).toISOString().slice(0, 10)}) | Test (>=)`);
emit('');

for (const tf of ['1m', '3m']) {
  for (const dir of ['fade', 'momentum']) {
    const all = rows.filter(r => r.tf === tf && r.dir === dir);
    const train = all.filter(r => r.flip_ts < SPLIT_TS);
    const test = all.filter(r => r.flip_ts >= SPLIT_TS);
    emit(`--- ${tf} ${dir.toUpperCase()} (full n=${all.length.toLocaleString()}, train=${train.length.toLocaleString()}, test=${test.length.toLocaleString()}) ---`);
    emit(`  ${'s/t'.padEnd(10)} ${'n'.padStart(6)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'avg'.padStart(7)} ${'sum'.padStart(9)} | ${'tr_PF'.padStart(6)} ${'tr_WR'.padStart(6)} ${'tr_sum'.padStart(8)} | ${'te_PF'.padStart(6)} ${'te_WR'.padStart(6)} ${'te_sum'.padStart(8)} | stable`);
    for (const s of STOP_PTS) for (const t of TARGET_PTS) {
      const key = `s${s}_t${t}`;
      const f = summarize(all, key);
      const a = summarize(train, key);
      const b = summarize(test, key);
      const stable = (a.pf >= 1.0 && b.pf >= 1.0 && Math.abs(a.pf - b.pf) < 0.5) ? '✓' :
                     (a.pf < 1.0 && b.pf < 1.0) ? 'L' : 'x';
      emit(`  s${s}/t${t}`.padEnd(11)
         + ` ${f.n.toString().padStart(6)}`
         + ` ${f.wr.toFixed(1).padStart(6)}`
         + ` ${(isFinite(f.pf) ? f.pf.toFixed(2) : '∞').padStart(6)}`
         + ` ${f.avg.toFixed(2).padStart(7)}`
         + ` ${f.sumPnL.toFixed(0).padStart(9)}`
         + ` | ${(isFinite(a.pf) ? a.pf.toFixed(2) : '∞').padStart(6)}`
         + ` ${a.wr.toFixed(1).padStart(6)}`
         + ` ${a.sumPnL.toFixed(0).padStart(8)}`
         + ` | ${(isFinite(b.pf) ? b.pf.toFixed(2) : '∞').padStart(6)}`
         + ` ${b.wr.toFixed(1).padStart(6)}`
         + ` ${b.sumPnL.toFixed(0).padStart(8)}`
         + ` | ${stable}`);
    }
    emit('');
  }
}

fs.writeFileSync(OUT, lines_out.join('\n'));
console.log(`\nWritten: ${OUT}`);
