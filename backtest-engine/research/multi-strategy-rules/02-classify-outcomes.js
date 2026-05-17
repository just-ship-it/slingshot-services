#!/usr/bin/env node
// 02: Classify conflict + confluence overlap outcomes.
//   - Conflict: opposite-direction overlap. Build 2x2 win/loss matrix per pair.
//     A trade is "right" if its own netPnL > 0 (per its own gold-standard rules).
//     LONG and SHORT can BOTH be right when both took profit.
//   - Confluence: same-direction overlap. Compare confluence-leg avg PnL vs the
//     strategy's overall baseline avg PnL (z-test on win rates).
// Writes conflict-outcomes.json and confluence-outcomes.json.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll } from './lib/load-trades.js';
import { findPairwiseOverlaps } from './lib/interval-tree.js';
import { proportionZTest, round } from './lib/metrics.js';
import { fmtETMonth } from './lib/et-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function pad(s, n) { return String(s).padEnd(n); }
function isWin(t) { return t.netPnL > 0; }

function classifyConflictPair(pairOverlaps) {
  // 2x2 matrix: rows = A win/loss, cols = B win/loss.
  const matrix = { A_win_B_win: 0, A_win_B_loss: 0, A_loss_B_win: 0, A_loss_B_loss: 0 };
  let totalA = 0, totalB = 0, totalJoint = 0;
  let nA = 0, nB = 0;

  // Track de-duplicated trade-level outcomes for win-rate computation.
  // A single trade may appear in many overlap rows; for the win-rate matrix we count
  // PAIR EVENTS (each overlap row independently), since the question is "in this conflict,
  // who was right".
  const byMonth = new Map();
  const byDirection = { longA_shortB: { ...matrix }, shortA_longB: { ...matrix } };

  for (const ov of pairOverlaps) {
    const aWin = isWin(ov.tradeA_ref);
    const bWin = isWin(ov.tradeB_ref);
    const cell = (aWin ? 'A_win_' : 'A_loss_') + (bWin ? 'B_win' : 'B_loss');
    matrix[cell] += 1;
    totalA += ov.pnlA; totalB += ov.pnlB; totalJoint += ov.joint_pnl;
    nA += 1; nB += 1;

    const monthKey = fmtETMonth(ov.overlap_start);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, { n: 0, joint_pnl: 0, A_wins: 0, B_wins: 0 });
    const m = byMonth.get(monthKey);
    m.n += 1;
    m.joint_pnl += ov.joint_pnl;
    if (aWin) m.A_wins += 1;
    if (bWin) m.B_wins += 1;

    const dirKey = ov.sideA === 'long' ? 'longA_shortB' : 'shortA_longB';
    byDirection[dirKey][cell] += 1;
  }

  return {
    total: pairOverlaps.length,
    matrix,
    avgPnlA: round(totalA / Math.max(1, nA)),
    avgPnlB: round(totalB / Math.max(1, nB)),
    avgJoint: round(totalJoint / Math.max(1, pairOverlaps.length)),
    totalJoint: round(totalJoint),
    A_winRate: round((matrix.A_win_B_win + matrix.A_win_B_loss) / Math.max(1, pairOverlaps.length) * 100, 1),
    B_winRate: round((matrix.A_win_B_win + matrix.A_loss_B_win) / Math.max(1, pairOverlaps.length) * 100, 1),
    bothRightPct: round(matrix.A_win_B_win / Math.max(1, pairOverlaps.length) * 100, 1),
    bothWrongPct: round(matrix.A_loss_B_loss / Math.max(1, pairOverlaps.length) * 100, 1),
    byDirection,
    byMonth: Object.fromEntries([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, {
      n: v.n,
      joint_pnl: round(v.joint_pnl),
      A_winRate: round(v.A_wins / v.n * 100, 1),
      B_winRate: round(v.B_wins / v.n * 100, 1),
    }])),
  };
}

function classifyConfluencePair(pairOverlaps, baselineA, baselineB) {
  let totalA = 0, totalB = 0, totalJoint = 0;
  let winsA = 0, winsB = 0;
  const byMonth = new Map();
  const sideSplits = { both_long: { n: 0, A_wins: 0, B_wins: 0, joint_pnl: 0 },
                       both_short: { n: 0, A_wins: 0, B_wins: 0, joint_pnl: 0 } };

  for (const ov of pairOverlaps) {
    const aWin = isWin(ov.tradeA_ref);
    const bWin = isWin(ov.tradeB_ref);
    totalA += ov.pnlA; totalB += ov.pnlB; totalJoint += ov.joint_pnl;
    if (aWin) winsA += 1;
    if (bWin) winsB += 1;

    const monthKey = fmtETMonth(ov.overlap_start);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, { n: 0, joint_pnl: 0, A_wins: 0, B_wins: 0 });
    const m = byMonth.get(monthKey);
    m.n += 1; m.joint_pnl += ov.joint_pnl;
    if (aWin) m.A_wins += 1;
    if (bWin) m.B_wins += 1;

    const dirKey = ov.sideA === 'long' ? 'both_long' : 'both_short';
    const split = sideSplits[dirKey];
    split.n += 1; split.joint_pnl += ov.joint_pnl;
    if (aWin) split.A_wins += 1;
    if (bWin) split.B_wins += 1;
  }

  const n = pairOverlaps.length;
  // Z-tests: confluence-leg win rate vs strategy baseline win rate.
  const zA = proportionZTest(winsA, n, baselineA.winners, baselineA.trades);
  const zB = proportionZTest(winsB, n, baselineB.winners, baselineB.trades);

  return {
    total: n,
    avgPnlA: round(totalA / Math.max(1, n)),
    avgPnlB: round(totalB / Math.max(1, n)),
    avgJoint: round(totalJoint / Math.max(1, n)),
    totalJoint: round(totalJoint),
    A_winRate: round(winsA / Math.max(1, n) * 100, 1),
    A_baselineWinRate: round(baselineA.winners / baselineA.trades * 100, 1),
    A_uplift_z: round(zA.z, 2),
    A_uplift_p: round(zA.p, 4),
    B_winRate: round(winsB / Math.max(1, n) * 100, 1),
    B_baselineWinRate: round(baselineB.winners / baselineB.trades * 100, 1),
    B_uplift_z: round(zB.z, 2),
    B_uplift_p: round(zB.p, 4),
    sideSplits: Object.fromEntries(Object.entries(sideSplits).map(([k, v]) => [k, {
      n: v.n,
      joint_pnl: round(v.joint_pnl),
      A_winRate: v.n ? round(v.A_wins / v.n * 100, 1) : 0,
      B_winRate: v.n ? round(v.B_wins / v.n * 100, 1) : 0,
    }])),
    byMonth: Object.fromEntries([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, {
      n: v.n, joint_pnl: round(v.joint_pnl),
      A_winRate: round(v.A_wins / v.n * 100, 1),
      B_winRate: round(v.B_wins / v.n * 100, 1),
    }])),
  };
}

export function main() {
  const { byKey, allFlat } = loadAll();
  const overlaps = findPairwiseOverlaps(allFlat);

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Step 02: Conflict + Confluence Outcome Classification');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();

  // Group overlaps by alphabetically-ordered pair key.
  const byPair = new Map();
  for (const ov of overlaps) {
    const key = `${ov.strategyA}__${ov.strategyB}`;
    if (!byPair.has(key)) byPair.set(key, { conflict: [], confluence: [] });
    byPair.get(key)[ov.type].push(ov);
  }

  // Per-strategy baselines for confluence z-tests.
  const baselines = new Map();
  for (const [k, v] of byKey) {
    const winners = v.trades.filter(isWin).length;
    baselines.set(k, { trades: v.trades.length, winners });
  }

  const conflict = {};
  const confluence = {};
  for (const [pairKey, buckets] of byPair) {
    const [aKey, bKey] = pairKey.split('__');
    conflict[pairKey] = classifyConflictPair(buckets.conflict);
    confluence[pairKey] = classifyConfluencePair(buckets.confluence, baselines.get(aKey), baselines.get(bKey));
  }

  // ── Console summary ────────────────────────────────────────────────────
  console.log('CONFLICTS (opposite-direction overlaps):');
  console.log('  Each row = pair, "right" = trade closed profitable per its own exit rules');
  console.log();
  console.log('  ' + pad('pair', 38) + pad('events', 8) + pad('A win%', 9) + pad('B win%', 9) + pad('both win%', 11) + pad('both lose%', 12) + pad('avg joint $', 13));
  for (const [k, c] of Object.entries(conflict)) {
    console.log('  ' + pad(k, 38) + pad(c.total, 8) + pad(c.A_winRate, 9) + pad(c.B_winRate, 9) + pad(c.bothRightPct, 11) + pad(c.bothWrongPct, 12) + pad('$' + c.avgJoint, 13));
  }
  console.log();
  console.log('CONFLUENCE (same-direction overlaps) — does confluence predict better legs?');
  console.log('  ' + pad('pair', 38) + pad('events', 8) + pad('A WR', 8) + pad('A base', 9) + pad('A z', 7) + pad('B WR', 8) + pad('B base', 9) + pad('B z', 7) + pad('avg joint', 11));
  for (const [k, c] of Object.entries(confluence)) {
    console.log('  ' + pad(k, 38) + pad(c.total, 8) + pad(c.A_winRate, 8) + pad(c.A_baselineWinRate, 9) + pad(c.A_uplift_z, 7) + pad(c.B_winRate, 8) + pad(c.B_baselineWinRate, 9) + pad(c.B_uplift_z, 7) + pad('$' + c.avgJoint, 11));
  }

  // ── Triple-overlap summary (small bonus) ───────────────────────────────
  const tripleStats = { 'all-long': 0, 'all-short': 0, 'mixed': 0 };
  // Already done in step 01; we just compute joint-PnL here per type.

  // Write JSONs.
  fs.writeFileSync(path.join(OUT_DIR, 'conflict-outcomes.json'),
    JSON.stringify({ pairs: conflict }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'confluence-outcomes.json'),
    JSON.stringify({ pairs: confluence, baselines: Object.fromEntries(baselines) }, null, 2));

  console.log();
  console.log('✓ Wrote output/conflict-outcomes.json');
  console.log('✓ Wrote output/confluence-outcomes.json');

  return { conflict, confluence };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
