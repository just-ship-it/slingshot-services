/**
 * Phase H-3 — Analyze Variant A (LS flip → level touch → entry) output.
 *
 * Per (level type, ...) compute WR/PF on entered subset. Stable train/test.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IN = path.join(__dirname, 'output', '18-flip-then-level.csv');
const OUT = path.join(__dirname, 'output', '19-variant-a-analysis.txt');
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

const text = fs.readFileSync(IN, 'utf-8');
const lines = text.trim().split('\n');
const hdr = lines[0].split(',');
const idx = {}; hdr.forEach((h, i) => idx[h] = i);

const rows = [];
for (let i = 1; i < lines.length; i++) {
  const p = lines[i].split(',');
  rows.push({
    flip_ts: +p[idx.flip_ts],
    tf: p[idx.tf],
    direction: p[idx.direction],
    new_state: +p[idx.new_state],
    s15m: +p[idx.s15m],
    level_type: p[idx.level_type],
    level_value: +p[idx.level_value],
    spot_at_flip: +p[idx.spot_at_flip],
    outcome: p[idx.outcome],
    pnl: p[idx.pnl] === '' ? null : +p[idx.pnl],
    mfe: p[idx.mfe] === '' ? null : +p[idx.mfe],
    mae: p[idx.mae] === '' ? null : +p[idx.mae],
    hold_s: p[idx.hold_s] === '' ? null : +p[idx.hold_s],
  });
}
console.log(`Loaded ${rows.length} rows`);

const entered = rows.filter(r => ['win', 'loss', 'timeout'].includes(r.outcome));
console.log(`Entered: ${entered.length} (touch found, walked to outcome)`);
const noTouch = rows.filter(r => r.outcome === 'no_touch').length;
console.log(`No-touch within wait window: ${noTouch}`);

function summarize(arr) {
  let n = 0, w = 0, l = 0, to = 0, pnl = 0;
  for (const r of arr) {
    if (r.outcome === 'win') { n++; w++; pnl += r.pnl || 0; }
    else if (r.outcome === 'loss') { n++; l++; pnl += r.pnl || 0; }
    else if (r.outcome === 'timeout') { n++; to++; pnl += r.pnl || 0; }
  }
  return { n, w, l, to, pnl, wr: n ? w / n * 100 : 0, pf: l > 0 ? (w * 10) / (l * 10) : (w > 0 ? Infinity : 0) };
}

const train = entered.filter(r => r.flip_ts < SPLIT_TS);
const test = entered.filter(r => r.flip_ts >= SPLIT_TS);
const full = summarize(entered), trn = summarize(train), tst = summarize(test);

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }
emit(`\n=== Phase H-3 — Variant A analysis ===`);
emit(`File: ${IN}\n`);
emit(`Baseline: n=${full.n} WR=${full.wr.toFixed(1)}% PF=${full.pf.toFixed(2)} sum=${full.pnl.toFixed(0)}`);
emit(`  train: n=${trn.n} WR=${trn.wr.toFixed(1)}% PF=${trn.pf.toFixed(2)}  |  test: n=${tst.n} WR=${tst.wr.toFixed(1)}% PF=${tst.pf.toFixed(2)}\n`);

// By direction
for (const d of ['long', 'short']) {
  const sub = entered.filter(r => r.direction === d);
  const s = summarize(sub);
  const t = summarize(sub.filter(r => r.flip_ts < SPLIT_TS));
  const e = summarize(sub.filter(r => r.flip_ts >= SPLIT_TS));
  emit(`  ${d.toUpperCase()}: n=${s.n} WR=${s.wr.toFixed(1)}% PF=${s.pf.toFixed(2)} | tr ${t.n}/${t.wr.toFixed(1)}% | te ${e.n}/${e.wr.toFixed(1)}%`);
}

emit(`\n--- By level type ---`);
emit(`  ${'level'.padEnd(15)} ${'n'.padStart(5)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'sum'.padStart(7)} | ${'tr_n'.padStart(4)} ${'tr_WR'.padStart(5)} | ${'te_n'.padStart(4)} ${'te_WR'.padStart(5)}`);
const byLevel = new Map();
for (const r of entered) {
  if (!byLevel.has(r.level_type)) byLevel.set(r.level_type, []);
  byLevel.get(r.level_type).push(r);
}
const lvls = [...byLevel.entries()].map(([k, v]) => ({ k, f: summarize(v), t: summarize(v.filter(r => r.flip_ts < SPLIT_TS)), e: summarize(v.filter(r => r.flip_ts >= SPLIT_TS)) }))
  .filter(x => x.f.n >= 30)
  .sort((a, b) => b.f.wr - a.f.wr);
for (const x of lvls) {
  emit(`  ${x.k.padEnd(15)} ${x.f.n.toString().padStart(5)} ${x.f.wr.toFixed(1).padStart(5)} ${(isFinite(x.f.pf) ? x.f.pf.toFixed(2) : '∞').padStart(5)} ${x.f.pnl.toFixed(0).padStart(7)} | ${x.t.n.toString().padStart(4)} ${x.t.wr.toFixed(1).padStart(5)} | ${x.e.n.toString().padStart(4)} ${x.e.wr.toFixed(1).padStart(5)}`);
}

emit(`\n--- By level type x direction ---`);
const byLD = new Map();
for (const r of entered) {
  const k = `${r.level_type}|${r.direction}`;
  if (!byLD.has(k)) byLD.set(k, []);
  byLD.get(k).push(r);
}
const lds = [...byLD.entries()].map(([k, v]) => ({ k, f: summarize(v), t: summarize(v.filter(r => r.flip_ts < SPLIT_TS)), e: summarize(v.filter(r => r.flip_ts >= SPLIT_TS)) }))
  .filter(x => x.f.n >= 30 && x.t.n >= 15 && x.e.n >= 15)
  .sort((a, b) => b.f.wr - a.f.wr);
for (const x of lds) {
  emit(`  ${x.k.padEnd(20)} ${x.f.n.toString().padStart(5)} ${x.f.wr.toFixed(1).padStart(5)} ${(isFinite(x.f.pf) ? x.f.pf.toFixed(2) : '∞').padStart(5)} ${x.f.pnl.toFixed(0).padStart(7)} | tr ${x.t.n}/${x.t.wr.toFixed(1)}% | te ${x.e.n}/${x.e.wr.toFixed(1)}%`);
}

// By flip TF
emit(`\n--- By flip TF ---`);
for (const tf of ['1m', '3m']) {
  const sub = entered.filter(r => r.tf === tf);
  const s = summarize(sub);
  const t = summarize(sub.filter(r => r.flip_ts < SPLIT_TS));
  const e = summarize(sub.filter(r => r.flip_ts >= SPLIT_TS));
  emit(`  ${tf}: n=${s.n} WR=${s.wr.toFixed(1)}% PF=${s.pf.toFixed(2)} | tr ${t.n}/${t.wr.toFixed(1)}% | te ${e.n}/${e.wr.toFixed(1)}%`);
}

emit(`\n--- TOP stable cells (level x dir x tf, n>=80, both halves WR>52%) ---`);
const byLDT = new Map();
for (const r of entered) {
  const k = `${r.level_type}|${r.direction}|${r.tf}`;
  if (!byLDT.has(k)) byLDT.set(k, []);
  byLDT.get(k).push(r);
}
const ldts = [...byLDT.entries()].map(([k, v]) => ({ k, f: summarize(v), t: summarize(v.filter(r => r.flip_ts < SPLIT_TS)), e: summarize(v.filter(r => r.flip_ts >= SPLIT_TS)) }))
  .filter(x => x.f.n >= 80 && x.t.n >= 30 && x.e.n >= 30 && x.t.wr >= 52 && x.e.wr >= 52)
  .sort((a, b) => b.f.wr - a.f.wr);
for (const x of ldts) {
  emit(`  ${x.k.padEnd(20)} n=${x.f.n} WR=${x.f.wr.toFixed(1)}% PF=${x.f.pf.toFixed(2)} sum=${x.f.pnl.toFixed(0)} | tr ${x.t.n}/${x.t.wr.toFixed(1)}% | te ${x.e.n}/${x.e.wr.toFixed(1)}%`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
