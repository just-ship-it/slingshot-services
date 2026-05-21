/**
 * Phase 6 — Evaluate candidate joint policies (per-rule exits × filters) in
 * the in-memory simulator. Produces a table comparing each candidate to gold,
 * with H1/H2 train/test split.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runJoint, statsAndSplit, fmt } from './05-joint-sim.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk.json');
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
const SPLIT_TS = new Date('2025-09-01T00:00:00Z').getTime();

const CANDIDATES = {
  GOLD: {
    L_S4:      { target: 120, stop: 50, maxHoldMin: 90 },
    S_GF_SOLO: { target: 60,  stop: 50, maxHoldMin: 90 },
    S_CW:      { target: 120, stop: 50, maxHoldMin: 90, blockedHours: [14, 15] },
    S_R4:      { target: 80,  stop: 50, maxHoldMin: 60 },
  },
  // CAND_A: Just the filter cuts on gold exits (lower bound).
  CAND_A_filter_only: {
    L_S4:      { target: 120, stop: 50, maxHoldMin: 90, blockedDows: ['Thu', 'Fri'], blockedLtIdx: [2, 4] },
    S_GF_SOLO: { target: 60,  stop: 50, maxHoldMin: 90, blockedHours: [11] },
    S_CW:      { target: 120, stop: 50, maxHoldMin: 90, blockedHours: [14, 15] },
    S_R4:      { target: 80,  stop: 50, maxHoldMin: 60, blockedDows: ['Fri'], blockedLtIdx: [2, 4], blockedHours: [11, 15] },
  },
  // CAND_B: Per-rule sweep best exit (PnL-priority) + same filters.
  CAND_B_max_pnl: {
    L_S4:      { target: 140, stop: 70, maxHoldMin: 120, blockedDows: ['Thu', 'Fri'], blockedLtIdx: [2, 4] },
    S_GF_SOLO: { target: 60,  stop: 50, maxHoldMin: 90,  blockedHours: [11] },
    S_CW:      { target: 200, stop: 70, maxHoldMin: 120, blockedHours: [14, 15] },
    S_R4:      { target: 80,  stop: 50, maxHoldMin: 60,  blockedDows: ['Fri'], blockedLtIdx: [2, 4], blockedHours: [11, 15] },
  },
  // CAND_C: max-PnL exits at mh=150 (sweep peak).
  CAND_C_max_pnl_mh150: {
    L_S4:      { target: 140, stop: 70, maxHoldMin: 150, blockedDows: ['Thu', 'Fri'], blockedLtIdx: [2, 4] },
    S_GF_SOLO: { target: 60,  stop: 50, maxHoldMin: 90,  blockedHours: [11] },
    S_CW:      { target: 200, stop: 70, maxHoldMin: 150, blockedHours: [14, 15] },
    S_R4:      { target: 80,  stop: 50, maxHoldMin: 60,  blockedDows: ['Fri'], blockedLtIdx: [2, 4], blockedHours: [11, 15] },
  },
  // CAND_D: balanced — tighter L_S4 target + BE.
  CAND_D_balanced: {
    L_S4:      { target: 100, stop: 70, maxHoldMin: 120, beTrig: 70, beOff: 20, blockedDows: ['Thu', 'Fri'], blockedLtIdx: [2, 4] },
    S_GF_SOLO: { target: 60,  stop: 50, maxHoldMin: 90,  beTrig: 35, beOff: 5,  blockedHours: [11] },
    S_CW:      { target: 200, stop: 70, maxHoldMin: 120, beTrig: 80, beOff: 20, blockedHours: [14, 15] },
    S_R4:      { target: 80,  stop: 50, maxHoldMin: 60,  beTrig: 45, beOff: 5,  blockedDows: ['Fri'], blockedLtIdx: [2, 4], blockedHours: [11, 15] },
  },
  // CAND_E: low DD — tighter stops + earlier BE.
  CAND_E_low_dd: {
    L_S4:      { target: 100, stop: 35, maxHoldMin: 90, beTrig: 35, beOff: 5,  blockedDows: ['Thu', 'Fri'], blockedLtIdx: [2, 4] },
    S_GF_SOLO: { target: 45,  stop: 30, maxHoldMin: 60, beTrig: 20, beOff: 5,  blockedHours: [11] },
    S_CW:      { target: 100, stop: 35, maxHoldMin: 90, beTrig: 40, beOff: 5,  blockedHours: [14, 15] },
    S_R4:      { target: 60,  stop: 30, maxHoldMin: 60, beTrig: 30, beOff: 5,  blockedDows: ['Fri'], blockedLtIdx: [2, 4], blockedHours: [11, 15] },
  },
};

console.log(`\n=== Candidate evaluation ===`);
console.log(`Walks: ${walks.length}   Split: ${new Date(SPLIT_TS).toISOString()}\n`);
console.log(`${'Candidate'.padEnd(25)} ${'Phase'.padEnd(4)} ${'fmt'.padEnd(80)}`);
console.log('-'.repeat(120));

for (const [name, policy] of Object.entries(CANDIDATES)) {
  // Extract per-rule filter into filterByRule
  const policyByRule = {};
  const filterByRule = {};
  for (const [rule, p] of Object.entries(policy)) {
    policyByRule[rule] = {
      target: p.target, stop: p.stop, maxHoldMin: p.maxHoldMin,
      beTrig: p.beTrig, beOff: p.beOff, trTrig: p.trTrig, trOff: p.trOff,
    };
    filterByRule[rule] = {
      blockedHours: p.blockedHours,
      blockedDows: p.blockedDows,
      blockedLtIdx: p.blockedLtIdx,
    };
  }
  const { results } = runJoint(walks, policyByRule, filterByRule);
  const { all, h1, h2 } = statsAndSplit(results, SPLIT_TS);
  console.log(`${name.padEnd(25)} ALL  ${fmt(all)}`);
  console.log(`${''.padEnd(25)} H1   ${fmt(h1)}`);
  console.log(`${''.padEnd(25)} H2   ${fmt(h2)}`);
  console.log();
}
