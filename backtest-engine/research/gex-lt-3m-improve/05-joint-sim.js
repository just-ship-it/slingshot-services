/**
 * Phase 5 — Joint simulator: compose per-rule exit policies and per-rule
 * filters (hours / DOW / ltIdx) into a single config, simulate the joint
 * portfolio, report combined stats + train/test split.
 *
 * Goal: take the best per-rule exit cfg from 03 + filter knobs from 04,
 * compose, and compare to gold.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, stats as simStats, statsByRule, statsByHour } from './02-sim-exits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk.json');
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));

const POINT_VALUE = 20;
const COMMISSION = 5;

// Default gold policy (mirrors current strategy defaults baked into walks).
const GOLD = {
  L_S4:      { target: 120, stop: 50, maxHoldMin: 90 },
  S_GF_SOLO: { target: 60,  stop: 50, maxHoldMin: 90 },
  S_CW:      { target: 120, stop: 50, maxHoldMin: 90, blockedHours: [14, 15] },
  S_R4:      { target: 80,  stop: 50, maxHoldMin: 60 },
};

/**
 * Run joint simulation. policyByRule: { ruleId: cfg }.
 * filterByRule: { ruleId: { blockedHours, blockedDows, blockedLtIdx } }.
 * globalFilter: same shape as a per-rule filter, applied to all rules.
 */
export function runJoint(walks, policyByRule, filterByRule = {}, globalFilter = {}) {
  const taken = [];
  const dropped = { hour: 0, dow: 0, ltIdx: 0, noRule: 0 };
  for (const w of walks) {
    const rule = w.ruleId;
    if (!policyByRule[rule]) { dropped.noRule++; continue; }
    const f = { ...globalFilter, ...(filterByRule[rule] || {}) };
    if (f.blockedHours && f.blockedHours.includes(w.hourEt)) { dropped.hour++; continue; }
    if (f.blockedDows && f.blockedDows.includes(w.dow)) { dropped.dow++; continue; }
    if (f.blockedLtIdx && f.blockedLtIdx.includes(w.ltIdx)) { dropped.ltIdx++; continue; }

    const r = simulate(w, policyByRule[rule]);
    taken.push({
      id: w.id, tradeId: w.tradeId, ruleId: rule, side: w.side, fillTs: w.fillTs,
      hourEt: w.hourEt, dow: w.dow, ltIdx: w.ltIdx,
      exit: r.exit, pointsPnL: r.pnl, durationMs: r.durationMs, mfe: r.mfe, dropped: false,
    });
  }
  return { results: taken, dropped };
}

export function statsAndSplit(results, splitTs) {
  const all = simStats(results);
  const h1 = simStats(results.filter(r => r.fillTs < splitTs));
  const h2 = simStats(results.filter(r => r.fillTs >= splitTs));
  return { all, h1, h2 };
}

export function fmt(s) {
  return `n=${String(s.n).padStart(4)} PnL=$${s.pnl.toFixed(0).padStart(7)} WR=${s.wr.toFixed(0).padStart(2)}% PF=${s.pf.toFixed(2)} Sh=${s.sharpe.toFixed(2)} DD=$${s.maxDD.toFixed(0)} avgMFE=${s.avgMFE.toFixed(0)}pt`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Quick demo: replay gold
  const { results, dropped } = runJoint(walks, GOLD);
  const SPLIT_TS = new Date('2025-09-01T00:00:00Z').getTime();
  const { all, h1, h2 } = statsAndSplit(results, SPLIT_TS);
  console.log(`=== GOLD POLICY (joint) ===`);
  console.log(`dropped: ${JSON.stringify(dropped)}`);
  console.log(`ALL: ${fmt(all)}`);
  console.log(`H1:  ${fmt(h1)}`);
  console.log(`H2:  ${fmt(h2)}`);
  console.log(`\nBy rule:`);
  const byR = statsByRule(results);
  for (const k of Object.keys(byR).sort()) console.log(`  ${k.padEnd(12)} ${fmt(byR[k])}`);
}
