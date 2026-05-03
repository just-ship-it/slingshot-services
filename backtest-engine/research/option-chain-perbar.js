#!/usr/bin/env node
/**
 * Per-bar option-chain evolution table.
 *
 * For each (trade, GEX-snapshot-during-trade), emit a row with:
 *   - trade context (id, side, entry/exit times, eventual outcome)
 *   - snapshot features at this moment (gamma_flip_dist, walls, regime, total_gex)
 *   - delta features vs entry-snapshot (wall strength % change, gamma flip drift)
 *   - position-time (bars elapsed since entry, bars remaining until exit)
 *   - eventual outcome (won, pnl_pts, mfe_pts, mae_pts)
 *
 * Use case: given trade is open at bar T with GEX state X, what's P(eventual win)?
 *
 * Usage:
 *   node research/option-chain-perbar.js
 *
 * Outputs:
 *   research/output/option-chain-perbar.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TRADES_PATH = path.join(ROOT, 'data/gold-standard/iv-skew-gex-cbbo-gold-standard.json');
const GEX_DIR = path.join(ROOT, 'data/gex/nq-cbbo');
const OUT_DIR = path.join(ROOT, 'research/output');
const OUT_CSV = path.join(OUT_DIR, 'option-chain-perbar.csv');

fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('Loading trades...');
const tradesFile = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'));
const trades = tradesFile.trades.filter((t) => t.status === 'completed' && t.exitTime);
console.log(`  ${trades.length} completed trades`);

console.log('Loading cbbo GEX snapshots...');
const dayFiles = fs.readdirSync(GEX_DIR).filter((f) => f.endsWith('.json')).sort();
const snaps = [];
for (const f of dayFiles) {
  const day = JSON.parse(fs.readFileSync(path.join(GEX_DIR, f), 'utf8'));
  for (const s of day.data) {
    snaps.push({ ts: new Date(s.timestamp).getTime(), ...s });
  }
}
snaps.sort((a, b) => a.ts - b.ts);
console.log(`  ${snaps.length} snapshots from ${dayFiles.length} days`);

function findSnapAtOrBefore(ts) {
  if (snaps.length === 0 || ts < snaps[0].ts) return null;
  let lo = 0, hi = snaps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (snaps[mid].ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  return snaps[lo];
}

function findSnapsBetween(t0, t1) {
  let lo = 0, hi = snaps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid].ts < t0) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < snaps.length && snaps[i].ts <= t1; i++) out.push(snaps[i]);
  return out;
}

function dirWalls(side, snap) {
  const isLong = side === 'long' || side === 'buy';
  return isLong
    ? {
        inDirWall: snap.put_wall,
        inDirWallGex: Math.abs(snap.put_wall_gex || 0),
        oppWall: snap.call_wall,
        oppWallGex: Math.abs(snap.call_wall_gex || 0),
      }
    : {
        inDirWall: snap.call_wall,
        inDirWallGex: Math.abs(snap.call_wall_gex || 0),
        oppWall: snap.put_wall,
        oppWallGex: Math.abs(snap.put_wall_gex || 0),
      };
}

function pctChange(a, b) {
  if (a == null || b == null || a === 0) return null;
  return (b - a) / Math.abs(a);
}

function fmt(v, digits = 4) {
  if (v == null || (typeof v === 'number' && !isFinite(v))) return '';
  if (typeof v === 'number') return v.toFixed(digits);
  return String(v);
}

const rows = [];
let skipped = 0;
let tradesEmitted = 0;
for (const trade of trades) {
  const entryTime = trade.entryTime;
  const exitTime = trade.exitTime;
  const entryPrice = trade.actualEntry || trade.entryPrice;
  const isLong = trade.side === 'long' || trade.side === 'buy';
  const dirSign = isLong ? 1 : -1;

  const entrySnap = findSnapAtOrBefore(entryTime);
  if (!entrySnap) {
    skipped++;
    continue;
  }
  const entryWalls = dirWalls(trade.side, entrySnap);

  // All snapshots strictly DURING the trade (after entry, at-or-before exit).
  // Include the entry snapshot itself if it landed within the trade window.
  const duringSnaps = findSnapsBetween(entryTime, exitTime);
  if (duringSnaps.length === 0) continue;

  tradesEmitted++;

  for (const snap of duringSnaps) {
    const w = dirWalls(trade.side, snap);
    const barsElapsed = Math.max(0, Math.floor((snap.ts - entryTime) / 60000));
    const barsRemaining = Math.max(0, Math.floor((exitTime - snap.ts) / 60000));
    const fracElapsed = (snap.ts - entryTime) / Math.max(1, exitTime - entryTime);

    rows.push({
      trade_id: trade.id,
      side: trade.side,
      levelType: trade.signal?.levelType ?? '',
      entryTime: new Date(entryTime).toISOString(),
      exitTime: new Date(exitTime).toISOString(),
      snap_ts: new Date(snap.ts).toISOString(),
      bars_elapsed: barsElapsed,
      bars_remaining: barsRemaining,
      frac_elapsed: fracElapsed,

      // Outcome (the label)
      won: (trade.netPnL || 0) > 0 ? 1 : 0,
      pnl_pts: trade.pointsPnL ?? '',
      mfe_pts: trade.mfePoints ?? '',
      mae_pts: trade.maePoints ?? '',
      exit_reason: trade.exitReason ?? '',

      // State at this snapshot
      regime: snap.regime,
      gamma_flip: snap.gamma_flip,
      gamma_flip_dist: snap.gamma_flip != null ? entryPrice - snap.gamma_flip : null, // + = entry above flip
      total_gex: snap.total_gex,
      gamma_imbalance: snap.gamma_imbalance,
      in_dir_wall: w.inDirWall,
      in_dir_wall_dist: w.inDirWall != null
        ? (isLong ? entryPrice - w.inDirWall : w.inDirWall - entryPrice)
        : null,
      in_dir_wall_strength: w.inDirWallGex,
      opp_wall: w.oppWall,
      opp_wall_dist: w.oppWall != null
        ? (isLong ? w.oppWall - entryPrice : entryPrice - w.oppWall)
        : null,
      opp_wall_strength: w.oppWallGex,

      // Deltas vs entry snapshot
      regime_changed_since_entry: snap.regime !== entrySnap.regime ? 1 : 0,
      in_dir_wall_strength_pct_change: pctChange(entryWalls.inDirWallGex, w.inDirWallGex),
      opp_wall_strength_pct_change: pctChange(entryWalls.oppWallGex, w.oppWallGex),
      total_gex_change_pct: pctChange(entrySnap.total_gex, snap.total_gex),
      gamma_imbalance_change: (snap.gamma_imbalance ?? 0) - (entrySnap.gamma_imbalance ?? 0),
      gamma_flip_drift_signed_dir:
        entrySnap.gamma_flip != null && snap.gamma_flip != null
          ? -dirSign * (snap.gamma_flip - entrySnap.gamma_flip)
          : null,
    });
  }
}

console.log(`  ${rows.length} per-bar rows from ${tradesEmitted} trades (${skipped} trades skipped)`);

const headers = Object.keys(rows[0]);
const lines = [headers.join(',')];
for (const r of rows) lines.push(headers.map((h) => fmt(r[h])).join(','));
fs.writeFileSync(OUT_CSV, lines.join('\n'));
console.log(`Wrote ${OUT_CSV}`);

// Quick analysis: bucket rows by bars_elapsed and show P(win)
console.log('\nP(eventual win) by snapshot timing:');
const byElapsed = new Map();
for (const r of rows) {
  // Bin into 15-minute buckets (snapshot resolution)
  const bin = Math.floor(r.bars_elapsed / 15) * 15;
  if (!byElapsed.has(bin)) byElapsed.set(bin, []);
  byElapsed.get(bin).push(r);
}
const bins = [...byElapsed.keys()].sort((a, b) => a - b);
console.log('  bars_elapsed_bin   n   P(win)');
for (const bin of bins) {
  const bk = byElapsed.get(bin);
  const wr = bk.filter((r) => r.won === 1).length / bk.length;
  console.log(`  [${String(bin).padStart(2)}, ${String(bin + 15).padStart(2)})    ${String(bk.length).padStart(5)}   ${(wr * 100).toFixed(1)}%`);
}

// Univariate: bin features within bars_elapsed >= 15 (mid-trade) and predict outcome
console.log('\nUnivariate (mid-trade snapshots, bars_elapsed >= 15, n=' +
  rows.filter((r) => r.bars_elapsed >= 15).length + '):');

const midRows = rows.filter((r) => r.bars_elapsed >= 15);

const FEATURES = [
  'in_dir_wall_strength_pct_change',
  'opp_wall_strength_pct_change',
  'total_gex_change_pct',
  'gamma_imbalance_change',
  'gamma_flip_drift_signed_dir',
];

function tercileEdges(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return [sorted[Math.floor(n / 3)], sorted[Math.floor(2 * n / 3)]];
}

console.log(`  ${'feature'.padEnd(40)}${'edges'.padStart(28)}  | low n/wr      | mid n/wr      | high n/wr     | spread`);
for (const f of FEATURES) {
  const valid = midRows.filter((r) => typeof r[f] === 'number' && isFinite(r[f]));
  if (valid.length < 100) continue;
  const edges = tercileEdges(valid.map((r) => r[f]));
  const buckets = [[], [], []];
  for (const r of valid) {
    if (r[f] <= edges[0]) buckets[0].push(r);
    else if (r[f] <= edges[1]) buckets[1].push(r);
    else buckets[2].push(r);
  }
  const wrs = buckets.map((b) => b.length ? b.filter((r) => r.won === 1).length / b.length : null);
  const e = `[${edges[0].toFixed(3)}, ${edges[1].toFixed(3)}]`;
  const fmtBk = (n, wr) => `${String(n).padStart(5)}/${(wr * 100).toFixed(1).padStart(5)}%`;
  const sp = `${(Math.max(...wrs.filter(v => v != null)) - Math.min(...wrs.filter(v => v != null))) * 100}`.slice(0, 4) + 'pp';
  console.log(`  ${f.padEnd(40)}${e.padStart(28)}  | ${fmtBk(buckets[0].length, wrs[0])} | ${fmtBk(buckets[1].length, wrs[1])} | ${fmtBk(buckets[2].length, wrs[2])} | ${sp}`);
}
