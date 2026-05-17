#!/usr/bin/env node
// 01: Build pairwise + 3-way overlap tables across all 3 strategies' gold-standard trades.
// Writes overlap-tables.csv and overlap-three-way.csv to output/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll, dateRange, STRATEGIES } from './lib/load-trades.js';
import { findPairwiseOverlaps, findThreeWayOverlaps } from './lib/interval-tree.js';
import { fmtET, fmtETDate } from './lib/et-time.js';
import { writeCsv } from './lib/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function pad(s, n) { return String(s).padEnd(n); }

export function main() {
  const { byKey, allFlat } = loadAll();

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Multi-Strategy Overlap Analysis — Step 01: Overlap Tables');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();

  // ── Per-strategy census ────────────────────────────────────────────────
  console.log('Per-strategy baseline (loaded from gold-standard JSONs):');
  console.log('  ' + pad('strategy', 18) + pad('trades', 8) + pad('reported $PnL', 16) + pad('date range', 26));
  const ranges = new Map();
  for (const def of STRATEGIES) {
    const v = byKey.get(def.key);
    const dr = dateRange(v.trades);
    ranges.set(def.key, dr);
    console.log('  ' +
      pad(def.key, 18) +
      pad(v.trades.length, 8) +
      pad('$' + (v.meta.reportedTotalPnL || 0).toLocaleString(), 16) +
      pad(`${fmtETDate(dr.first)} → ${fmtETDate(dr.last)}`, 26));
  }

  // Warn if date ranges materially differ.
  const lasts = [...ranges.values()].map(r => r.last);
  const spread = Math.max(...lasts) - Math.min(...lasts);
  if (spread > 2 * 24 * 60 * 60 * 1000) {
    console.log();
    console.log(`⚠️  Date-range spread is ${(spread / 86400000).toFixed(0)} days — strategies do NOT cover identical windows.`);
    console.log('   Overlap counts after the earliest-finishing strategy\'s last trade will be zero by construction.');
  }

  // ── Pairwise overlap detection ─────────────────────────────────────────
  console.log();
  console.log('Running sweep-line overlap detection across all 3 strategies...');
  const pairwise = findPairwiseOverlaps(allFlat);

  console.log(`  Total pairwise overlap events: ${pairwise.length}`);
  // Alphabetic order: gex-flip-ivpct < gex-level-fade < gex-lt-3m.
  const pairs = ['gex-flip-ivpct__gex-level-fade', 'gex-flip-ivpct__gex-lt-3m', 'gex-level-fade__gex-lt-3m'];
  const byPair = new Map(pairs.map(p => [p, { confluence: 0, conflict: 0, joint_pnl: 0 }]));
  for (const ov of pairwise) {
    const key = `${ov.strategyA}__${ov.strategyB}`;
    const bucket = byPair.get(key);
    if (!bucket) continue;
    bucket[ov.type] += 1;
    bucket.joint_pnl += ov.joint_pnl;
  }

  console.log();
  console.log('  Per-pair breakdown:');
  console.log('  ' + pad('pair', 38) + pad('total', 8) + pad('confluence', 12) + pad('conflict', 10) + pad('joint PnL', 14));
  for (const [k, v] of byPair) {
    const total = v.confluence + v.conflict;
    const display = k.padEnd(38);
    console.log('  ' + display +
      pad(total, 8) +
      pad(`${v.confluence} (${pct(v.confluence, total)})`, 12) +
      pad(`${v.conflict} (${pct(v.conflict, total)})`, 10) +
      pad('$' + v.joint_pnl.toFixed(0), 14));
  }

  // ── 3-way overlap detection ────────────────────────────────────────────
  const triples = findThreeWayOverlaps(allFlat);
  console.log();
  console.log(`  3-way overlap events: ${triples.length}`);
  const tripleSideDist = new Map();
  for (const t of triples) {
    tripleSideDist.set(t.type, (tripleSideDist.get(t.type) || 0) + 1);
  }
  console.log('  3-way side combos:', JSON.stringify(Object.fromEntries(tripleSideDist)));

  // ── Symmetry sanity check ──────────────────────────────────────────────
  let pairSum = 0;
  for (const def1 of STRATEGIES) {
    for (const def2 of STRATEGIES) {
      if (def1.key >= def2.key) continue;
      const subset = [...byKey.get(def1.key).trades, ...byKey.get(def2.key).trades];
      const ovs = findPairwiseOverlaps(subset);
      pairSum += ovs.length;
    }
  }
  if (pairSum !== pairwise.length) {
    throw new Error(`Overlap-symmetry check failed: full=${pairwise.length}, pair-sum=${pairSum}`);
  }
  console.log();
  console.log(`✓ Overlap-symmetry assertion passed (${pairwise.length} = ${pairSum})`);

  // ── Write CSVs ─────────────────────────────────────────────────────────
  const overlapRows = pairwise.map(ov => ({
    strategyA: ov.strategyA,
    strategyB: ov.strategyB,
    sideA: ov.sideA,
    sideB: ov.sideB,
    type: ov.type,
    entryA_ts: ov.entryA_ts,
    entryB_ts: ov.entryB_ts,
    exitA_ts: ov.exitA_ts,
    exitB_ts: ov.exitB_ts,
    exit_first_ts: Math.min(ov.exitA_ts, ov.exitB_ts),
    overlap_start_et: fmtET(ov.overlap_start),
    overlap_end_et: fmtET(ov.overlap_end),
    overlap_minutes: ov.overlap_minutes.toFixed(2),
    pnlA: ov.pnlA,
    pnlB: ov.pnlB,
    joint_pnl: ov.joint_pnl,
    tradeA_id: ov.tradeA_id,
    tradeB_id: ov.tradeB_id,
  }));
  const HEADER = ['strategyA','strategyB','sideA','sideB','type','entryA_ts','entryB_ts','exitA_ts','exitB_ts','exit_first_ts','overlap_start_et','overlap_end_et','overlap_minutes','pnlA','pnlB','joint_pnl','tradeA_id','tradeB_id'];
  writeCsv(path.join(OUT_DIR, 'overlap-tables.csv'), HEADER, overlapRows);
  console.log(`✓ Wrote output/overlap-tables.csv (${overlapRows.length} rows)`);

  const tripleRows = triples.map(t => ({
    strategies: t.strategies.join('|'),
    sides: t.sides.join('|'),
    type: t.type,
    overlap_start_et: fmtET(t.overlap_start),
    overlap_end_et: fmtET(t.overlap_end),
    overlap_minutes: t.overlap_minutes.toFixed(2),
    joint_pnl: t.joint_pnl,
    pnl_each: t.tradeRefs.map(r => r.netPnL.toFixed(0)).join('|'),
    ids: t.ids.join('|'),
  }));
  const THDR = ['strategies','sides','type','overlap_start_et','overlap_end_et','overlap_minutes','joint_pnl','pnl_each','ids'];
  writeCsv(path.join(OUT_DIR, 'overlap-three-way.csv'), THDR, tripleRows);
  console.log(`✓ Wrote output/overlap-three-way.csv (${tripleRows.length} rows)`);

  return { pairwise, triples, byPair, ranges };
}

function pct(n, total) {
  return total === 0 ? '0%' : `${((n / total) * 100).toFixed(0)}%`;
}

// Run if invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
