#!/usr/bin/env node
/**
 * Option chain evolution study — per-trade summary table.
 *
 * For each gold-standard iv-skew-gex trade, joins entry/exit GEX snapshots
 * from cbbo-1m and emits a CSV row with:
 *   - entry option-chain state (gamma flip dist, wall distances, regime, IV)
 *   - mid-trade evolution (wall strength % change, gamma flip drift,
 *     wall distance change, total GEX change, regime change, IV/skew change)
 *   - outcome (won, pnl_pts, mfe_pts, mae_pts, exit_reason)
 *
 * Sign convention for "_signed_dir" fields: positive = favorable to trade
 * direction (e.g. for a long, gamma_flip drifting DOWN is signed positive).
 *
 * Usage:
 *   node research/option-chain-evolution.js
 *
 * Outputs:
 *   research/output/option-chain-evolution-trades.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TRADES_PATH = path.join(ROOT, 'data/gold-standard/iv-skew-gex-cbbo-gold-standard.json');
const GEX_DIR = path.join(ROOT, 'data/gex/nq-cbbo');
const OUT_DIR = path.join(ROOT, 'research/output');
const OUT_CSV = path.join(OUT_DIR, 'option-chain-evolution-trades.csv');

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
  // returns all snapshots with t0 <= ts <= t1
  const out = [];
  // crude linear scan after binary-search lower bound — fast enough for 7800 snapshots × 762 trades
  let lo = 0, hi = snaps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid].ts < t0) lo = mid + 1;
    else hi = mid;
  }
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
for (const trade of trades) {
  const entryTime = trade.entryTime;
  const exitTime = trade.exitTime;
  const entryPrice = trade.actualEntry || trade.entryPrice;
  const isLong = trade.side === 'long' || trade.side === 'buy';
  const dirSign = isLong ? 1 : -1;

  const entrySnap = findSnapAtOrBefore(entryTime);
  const exitSnap = findSnapAtOrBefore(exitTime);

  if (!entrySnap || !exitSnap) {
    skipped++;
    continue;
  }

  const ew = dirWalls(trade.side, entrySnap);
  const xw = dirWalls(trade.side, exitSnap);

  // Gamma flip distance: signed positive when price is ABOVE the flip
  const entryFlipDistRaw = entrySnap.gamma_flip != null ? entryPrice - entrySnap.gamma_flip : null;
  // Gamma flip drift: signed-by-trade-direction. Positive = drifted favorably.
  // For longs, "favorable" means flip moved DOWN (more positive-gamma cushion above).
  // For shorts, "favorable" means flip moved UP (more negative-gamma below).
  const flipDriftRaw = (entrySnap.gamma_flip != null && exitSnap.gamma_flip != null)
    ? exitSnap.gamma_flip - entrySnap.gamma_flip
    : null;
  const flipDriftSignedDir = flipDriftRaw != null ? -dirSign * flipDriftRaw : null;

  // In-dir wall distance from entry price (positive = wall is on the support-of-trade side)
  // For long at put_wall: positive when entry > put_wall (entry above the support)
  // For short at call_wall: positive when call_wall > entry (entry below the resistance)
  const entryInDirWallDist = ew.inDirWall != null
    ? (isLong ? entryPrice - ew.inDirWall : ew.inDirWall - entryPrice)
    : null;
  const entryOppWallDist = ew.oppWall != null
    ? (isLong ? ew.oppWall - entryPrice : entryPrice - ew.oppWall)
    : null;

  // Wall drift during trade (in-dir wall moving toward/away from the trade level)
  const inDirWallMove = (ew.inDirWall != null && xw.inDirWall != null) ? xw.inDirWall - ew.inDirWall : null;
  const oppWallMove = (ew.oppWall != null && xw.oppWall != null) ? xw.oppWall - ew.oppWall : null;

  const snapsDuring = findSnapsBetween(entryTime, exitTime).length;

  rows.push({
    id: trade.id,
    entryTime: new Date(entryTime).toISOString(),
    exitTime: new Date(exitTime).toISOString(),
    side: trade.side,
    levelType: trade.signal?.levelType ?? '',
    levelPrice: trade.signal?.levelPrice ?? '',
    entryPrice,
    barsHeld: trade.barsSinceEntry ?? '',
    exitReason: trade.exitReason ?? '',
    pnl_pts: trade.pointsPnL ?? '',
    mfe_pts: trade.mfePoints ?? '',
    mae_pts: trade.maePoints ?? '',
    won: (trade.netPnL || 0) > 0 ? 1 : 0,

    // Entry state
    entry_gamma_flip: entrySnap.gamma_flip,
    entry_gamma_flip_dist_raw: entryFlipDistRaw,         // + = price above flip
    entry_total_gex: entrySnap.total_gex,
    entry_gamma_imbalance: entrySnap.gamma_imbalance,
    entry_regime: entrySnap.regime,
    entry_in_dir_wall: ew.inDirWall,
    entry_in_dir_wall_dist: entryInDirWallDist,          // + = price on supportive side
    entry_in_dir_wall_strength: ew.inDirWallGex,
    entry_opp_wall: ew.oppWall,
    entry_opp_wall_dist: entryOppWallDist,               // + = wall is in front of price
    entry_opp_wall_strength: ew.oppWallGex,
    entry_iv: trade.entryIV ?? '',
    entry_skew: trade.signal?.ivSkew ?? '',

    // Mid-trade evolution
    snapshots_during_trade: snapsDuring,
    gamma_flip_drift_raw: flipDriftRaw,                  // raw price delta (+ = flip moved up)
    gamma_flip_drift_signed_dir: flipDriftSignedDir,     // + = favorable for trade
    in_dir_wall_strength_pct_change: pctChange(ew.inDirWallGex, xw.inDirWallGex),
    opp_wall_strength_pct_change: pctChange(ew.oppWallGex, xw.oppWallGex),
    in_dir_wall_move_raw: inDirWallMove,                 // + = wall moved up
    opp_wall_move_raw: oppWallMove,
    total_gex_change_pct: pctChange(entrySnap.total_gex, exitSnap.total_gex),
    gamma_imbalance_change: (exitSnap.gamma_imbalance ?? 0) - (entrySnap.gamma_imbalance ?? 0),
    regime_changed: entrySnap.regime !== exitSnap.regime ? 1 : 0,
    exit_regime: exitSnap.regime,
    iv_change: trade.ivChange ?? '',
    skew_change: trade.skewChange ?? '',
  });
}

console.log(`  ${rows.length} rows built (${skipped} skipped — missing snapshot)`);

// Write CSV
const headers = Object.keys(rows[0]);
const lines = [headers.join(',')];
for (const r of rows) {
  lines.push(headers.map((h) => fmt(r[h])).join(','));
}
fs.writeFileSync(OUT_CSV, lines.join('\n'));
console.log(`Wrote ${OUT_CSV}`);

// Quick sanity stats
const winners = rows.filter((r) => r.won === 1);
const losers = rows.filter((r) => r.won === 0);
console.log('\nQuick sanity stats:');
console.log(`  Winners: ${winners.length} (${(winners.length / rows.length * 100).toFixed(1)}%)`);
console.log(`  Losers:  ${losers.length}`);

function meanOf(arr, key) {
  const vals = arr.map((r) => r[key]).filter((v) => v != null && v !== '' && isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

const cols = [
  'entry_gamma_flip_dist_raw',
  'entry_in_dir_wall_dist',
  'entry_in_dir_wall_strength',
  'entry_opp_wall_strength',
  'entry_total_gex',
  'gamma_flip_drift_signed_dir',
  'in_dir_wall_strength_pct_change',
  'opp_wall_strength_pct_change',
  'total_gex_change_pct',
  'iv_change',
  'skew_change',
];

console.log('\nMean comparison: winners vs losers');
console.log('  ' + 'feature'.padEnd(40) + 'winners'.padStart(12) + 'losers'.padStart(12) + '   delta');
for (const c of cols) {
  const w = meanOf(winners, c);
  const l = meanOf(losers, c);
  if (w == null || l == null) continue;
  const delta = w - l;
  console.log(`  ${c.padEnd(40)}${w.toFixed(4).padStart(12)}${l.toFixed(4).padStart(12)}   ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`);
}
