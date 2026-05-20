/**
 * Phase G-2 — Analyze the entry-quality surface.
 *
 * Aggregate Phase G entries by (tf, lookback, target, stop_bucket):
 *   - n entries, WR, PF (with proper PnL using stop_dist), avg PnL
 *   - n no_entry / no_entry_eod / no_entry_rollover / timeouts
 *
 * Then split by train (<2025-09-15) vs test (>=) for stability check.
 *
 * Identify highest-WR cells with n>=100 in BOTH halves.
 *
 * Output: leaderboard sorted by WR (with stability filter).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const ENTRIES = arg('in', path.join(__dirname, 'output', '10-scalp-entries.csv'));
const OUT = arg('out', path.join(__dirname, 'output', '11-scalp-surface.txt'));

const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

if (!fs.existsSync(ENTRIES)) { console.error(`missing ${ENTRIES}`); process.exit(1); }

const text = fs.readFileSync(ENTRIES, 'utf-8');
const lines = text.trim().split('\n');
const hdr = lines[0].split(',');
const idx = {}; hdr.forEach((h, i) => idx[h] = i);

const buckets = new Map();
const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase G-2 — Entry-quality surface aggregation ===`);
emit(`Split: <${new Date(SPLIT_TS).toISOString().slice(0, 10)} (train) | >= (test)`);
emit(`Path: ${ENTRIES}\n`);

for (let i = 1; i < lines.length; i++) {
  const r = lines[i].split(',');
  const key = `${r[idx.tf]}|lb${r[idx.lookback_s]}|t${r[idx.target_pt]}|s${r[idx.stop_bucket_pt]}`;
  if (!buckets.has(key)) buckets.set(key, {
    full: { n_entry: 0, n_target: 0, n_stop: 0, n_timeout: 0, n_no_entry: 0, sum_pnl: 0, sum_target: 0, sum_stop: 0, sum_stop_dist: 0, target_pt: +r[idx.target_pt] },
    train: { n_entry: 0, n_target: 0, n_stop: 0, n_timeout: 0, n_no_entry: 0, sum_pnl: 0, sum_target: 0, sum_stop: 0 },
    test: { n_entry: 0, n_target: 0, n_stop: 0, n_timeout: 0, n_no_entry: 0, sum_pnl: 0, sum_target: 0, sum_stop: 0 },
  });
  const b = buckets.get(key);
  const outcome = r[idx.outcome];
  const pnl = r[idx.pnl_pts] === '' ? null : +r[idx.pnl_pts];
  const stopDist = r[idx.stop_dist] === '' ? null : +r[idx.stop_dist];
  const flipTs = +r[idx.flip_ts_ms];
  const halfKey = flipTs < SPLIT_TS ? 'train' : 'test';
  const isEntry = (outcome === 'target' || outcome === 'stop' || outcome === 'timeout');
  if (isEntry) {
    b.full.n_entry++; b[halfKey].n_entry++;
    if (pnl != null) { b.full.sum_pnl += pnl; b[halfKey].sum_pnl += pnl; }
    if (stopDist != null) b.full.sum_stop_dist += stopDist;
    if (outcome === 'target') { b.full.n_target++; b[halfKey].n_target++; if (pnl) { b.full.sum_target += pnl; b[halfKey].sum_target += pnl; } }
    else if (outcome === 'stop') { b.full.n_stop++; b[halfKey].n_stop++; if (pnl) { b.full.sum_stop += pnl; b[halfKey].sum_stop += pnl; } }
    else if (outcome === 'timeout') { b.full.n_timeout++; b[halfKey].n_timeout++; }
  } else {
    b.full.n_no_entry++; b[halfKey].n_no_entry++;
  }
}

function fmt(b) {
  const n = b.n_entry;
  const wr = n ? b.n_target / n * 100 : 0;
  // PF: gross profits (sum_target) / gross losses (|sum_stop|).
  // Note timeouts contribute to sum_pnl but not target/stop — for cleaner PF, treat them by sign.
  const losses = Math.abs(b.sum_stop) + (b.sum_pnl < 0 ? Math.abs(Math.min(0, b.sum_pnl - b.sum_target - b.sum_stop)) : 0);
  const wins = b.sum_target + (b.sum_pnl > 0 ? Math.max(0, b.sum_pnl - b.sum_target - b.sum_stop) : 0);
  // Simpler: PF on outcome-only entries (target vs stop, ignoring timeouts)
  const tgtVal = b.sum_target;
  const stpVal = Math.abs(b.sum_stop);
  const pf = stpVal > 0 ? tgtVal / stpVal : (tgtVal > 0 ? Infinity : 0);
  const avg = n ? b.sum_pnl / n : 0;
  return { n, wr, pf, avg, sumPnl: b.sum_pnl };
}

const rows = [];
for (const [key, b] of buckets.entries()) {
  const f = fmt(b.full);
  const tr = fmt(b.train);
  const te = fmt(b.test);
  rows.push({ key, b, f, tr, te });
}

// Sort by full WR descending (with stability filter)
const stable = rows.filter(r =>
  r.tr.n >= 80 && r.te.n >= 80 &&
  Math.abs(r.tr.wr - r.te.wr) < 12 &&
  r.f.n >= 200
);
stable.sort((a, b) => b.f.wr - a.f.wr);

emit(`\n--- TOP 30 BY WR (stable: train>=80, test>=80, |Δ|<12pp, full>=200) ---`);
emit(`  ${'key'.padEnd(22)} ${'n'.padStart(5)} ${'WR%'.padStart(5)} ${'PF'.padStart(5)} ${'avg'.padStart(6)} ${'sum'.padStart(7)} | ${'tr_n'.padStart(4)} ${'tr_WR'.padStart(5)} ${'tr_PF'.padStart(5)} | ${'te_n'.padStart(4)} ${'te_WR'.padStart(5)} ${'te_PF'.padStart(5)} | ${'no_entry'.padStart(8)}`);
for (const r of stable.slice(0, 30)) {
  emit(`  ${r.key.padEnd(22)} ${r.f.n.toString().padStart(5)} ${r.f.wr.toFixed(1).padStart(5)} ${(isFinite(r.f.pf) ? r.f.pf.toFixed(2) : '∞').padStart(5)} ${r.f.avg.toFixed(2).padStart(6)} ${r.f.sumPnl.toFixed(0).padStart(7)} | ${r.tr.n.toString().padStart(4)} ${r.tr.wr.toFixed(1).padStart(5)} ${(isFinite(r.tr.pf) ? r.tr.pf.toFixed(2) : '∞').padStart(5)} | ${r.te.n.toString().padStart(4)} ${r.te.wr.toFixed(1).padStart(5)} ${(isFinite(r.te.pf) ? r.te.pf.toFixed(2) : '∞').padStart(5)} | ${r.b.full.n_no_entry.toString().padStart(8)}`);
}

emit(`\n--- TOP 20 BY PF ---`);
stable.sort((a, b) => (isFinite(b.f.pf) ? b.f.pf : 99) - (isFinite(a.f.pf) ? a.f.pf : 99));
for (const r of stable.slice(0, 20)) {
  emit(`  ${r.key.padEnd(22)} ${r.f.n.toString().padStart(5)} ${r.f.wr.toFixed(1).padStart(5)} ${(isFinite(r.f.pf) ? r.f.pf.toFixed(2) : '∞').padStart(5)} ${r.f.avg.toFixed(2).padStart(6)} ${r.f.sumPnl.toFixed(0).padStart(7)} | ${r.tr.n.toString().padStart(4)} ${r.tr.wr.toFixed(1).padStart(5)} ${(isFinite(r.tr.pf) ? r.tr.pf.toFixed(2) : '∞').padStart(5)} | ${r.te.n.toString().padStart(4)} ${r.te.wr.toFixed(1).padStart(5)} ${(isFinite(r.te.pf) ? r.te.pf.toFixed(2) : '∞').padStart(5)}`);
}

emit(`\n--- TOP 20 BY sum PnL ---`);
stable.sort((a, b) => b.f.sumPnl - a.f.sumPnl);
for (const r of stable.slice(0, 20)) {
  emit(`  ${r.key.padEnd(22)} ${r.f.n.toString().padStart(5)} ${r.f.wr.toFixed(1).padStart(5)} ${(isFinite(r.f.pf) ? r.f.pf.toFixed(2) : '∞').padStart(5)} ${r.f.avg.toFixed(2).padStart(6)} ${r.f.sumPnl.toFixed(0).padStart(7)} | ${r.tr.n.toString().padStart(4)} ${r.tr.wr.toFixed(1).padStart(5)} ${(isFinite(r.tr.pf) ? r.tr.pf.toFixed(2) : '∞').padStart(5)} | ${r.te.n.toString().padStart(4)} ${r.te.wr.toFixed(1).padStart(5)} ${(isFinite(r.te.pf) ? r.te.pf.toFixed(2) : '∞').padStart(5)}`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
