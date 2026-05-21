/**
 * Phase 4b — Filter sweep (under gold exit policy).
 *
 * Quickly evaluates the impact of:
 *   - blocking specific hours per rule
 *   - blocking specific DOWs per rule
 *   - blocking specific ltIdx values per rule
 *
 * Compares to gold baseline. Identifies subtraction-only filters (drop
 * losing buckets, keep everything else) for each rule.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, stats as simStats } from './02-sim-exits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk.json');
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));

const GOLD_POLICY = {
  L_S4:      { target: 120, stop: 50, maxHoldMin: 90 },
  S_GF_SOLO: { target: 60,  stop: 50, maxHoldMin: 90 },
  S_CW:      { target: 120, stop: 50, maxHoldMin: 90, blockedHours: [14, 15] },
  S_R4:      { target: 80,  stop: 50, maxHoldMin: 60 },
};

function simWithFilters(walks, filterByRule = {}) {
  const taken = [];
  for (const w of walks) {
    const policy = GOLD_POLICY[w.ruleId];
    if (!policy) continue;
    const f = filterByRule[w.ruleId] || {};
    if (policy.blockedHours && policy.blockedHours.includes(w.hourEt)) continue;
    if (f.blockedHours && f.blockedHours.includes(w.hourEt)) continue;
    if (f.blockedDows && f.blockedDows.includes(w.dow)) continue;
    if (f.blockedLtIdx && f.blockedLtIdx.includes(w.ltIdx)) continue;
    const r = simulate(w, policy);
    taken.push({ ruleId: w.ruleId, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow, ltIdx: w.ltIdx, exit: r.exit, pointsPnL: r.pnl, durationMs: r.durationMs, mfe: r.mfe });
  }
  return taken;
}

const baselineResults = simWithFilters(walks, {});
const baselineSt = simStats(baselineResults);
console.log(`=== Baseline (gold policy, no extra filters) ===`);
console.log(`n=${baselineSt.n} PnL=$${baselineSt.pnl.toFixed(0)} WR=${baselineSt.wr.toFixed(0)}% PF=${baselineSt.pf.toFixed(2)} Sh=${baselineSt.sharpe.toFixed(2)} DD=$${baselineSt.maxDD.toFixed(0)}`);

// Leave-one-out analysis: for each (rule, hour|dow|ltIdx), test what happens
// if we block JUST that bucket.
function testFilter(label, filterByRule) {
  const res = simWithFilters(walks, filterByRule);
  const st = simStats(res);
  const dPnL = st.pnl - baselineSt.pnl;
  const dPF = st.pf - baselineSt.pf;
  const dSh = st.sharpe - baselineSt.sharpe;
  const dDD = st.maxDD - baselineSt.maxDD;
  console.log(`  ${label.padEnd(50)} n=${String(st.n).padStart(4)} PnL=$${String(st.pnl.toFixed(0)).padStart(7)} (${dPnL>=0?'+':''}${dPnL.toFixed(0).padStart(6)}) PF=${st.pf.toFixed(2)} (${dPF>=0?'+':''}${dPF.toFixed(2)}) Sh=${st.sharpe.toFixed(2)} (${dSh>=0?'+':''}${dSh.toFixed(2)}) DD=$${String(st.maxDD.toFixed(0)).padStart(6)} (${dDD>=0?'+':''}${dDD.toFixed(0)})`);
  return { label, st, dPnL, dPF, dSh, dDD };
}

console.log(`\n--- Single-bucket exclusion (per rule × per dim) ---\n`);

for (const rule of ['L_S4', 'S_CW', 'S_GF_SOLO', 'S_R4']) {
  console.log(`\n# Block hour for ${rule}:`);
  const hrs = [...new Set(walks.filter(w => w.ruleId === rule).map(w => w.hourEt))].sort((a,b)=>a-b);
  for (const h of hrs) testFilter(`${rule} block hour ${h}`, { [rule]: { blockedHours: [h] } });

  console.log(`# Block DOW for ${rule}:`);
  for (const dow of ['Sun','Mon','Tue','Wed','Thu','Fri']) {
    if (!walks.some(w => w.ruleId === rule && w.dow === dow)) continue;
    testFilter(`${rule} block ${dow}`, { [rule]: { blockedDows: [dow] } });
  }

  console.log(`# Block ltIdx for ${rule}:`);
  const lts = [...new Set(walks.filter(w => w.ruleId === rule).map(w => w.ltIdx))].sort((a,b)=>a-b);
  for (const li of lts) testFilter(`${rule} block L${li + 1}`, { [rule]: { blockedLtIdx: [li] } });
}

// Stacked filter test — manually-chosen
console.log(`\n\n=== STACKED FILTER CANDIDATES ===`);
const candidates = {
  'A: drop loser ltIdx everywhere': {
    L_S4: { blockedLtIdx: [2, 4] },  // L3, L5
    S_R4: { blockedLtIdx: [2, 4] },  // L3, L5
    S_GF_SOLO: {},
    S_CW: {},
  },
  'B: A + block 11am for GF_SOLO': {
    L_S4: { blockedLtIdx: [2, 4] },
    S_R4: { blockedLtIdx: [2, 4] },
    S_GF_SOLO: { blockedHours: [11] },
    S_CW: {},
  },
  'C: B + block Fri for S_R4': {
    L_S4: { blockedLtIdx: [2, 4] },
    S_R4: { blockedLtIdx: [2, 4], blockedDows: ['Fri'] },
    S_GF_SOLO: { blockedHours: [11] },
    S_CW: {},
  },
  'D: C + block 11+15 for S_R4': {
    L_S4: { blockedLtIdx: [2, 4] },
    S_R4: { blockedLtIdx: [2, 4], blockedDows: ['Fri'], blockedHours: [11, 15] },
    S_GF_SOLO: { blockedHours: [11] },
    S_CW: {},
  },
  'E: D + block L_S4 Thu/Fri': {
    L_S4: { blockedLtIdx: [2, 4], blockedDows: ['Thu', 'Fri'] },
    S_R4: { blockedLtIdx: [2, 4], blockedDows: ['Fri'], blockedHours: [11, 15] },
    S_GF_SOLO: { blockedHours: [11] },
    S_CW: {},
  },
};
for (const [label, f] of Object.entries(candidates)) {
  testFilter(label, f);
}
