/**
 * Phase 3 — Per-rule Cartesian sweep over exit policies.
 *
 * For each of the 4 active rules (L_S4, S_GF_SOLO, S_CW, S_R4), sweep:
 *   target × stop × (BE: trigger+offset) × (trail: trigger+offset) × maxHoldMin
 * and find the per-rule optimum.
 *
 * The total config space is too large for a single-key Cartesian; we
 * decompose: for each rule, sweep its own combos against ONLY that rule's
 * 1s walks. Then combine the per-rule optima to compute the joint stats.
 *
 * Output: output/03-per-rule-sweep-{ruleId}.csv (top 50 per rule).
 *         output/03-per-rule-best.json (chosen optimum per rule).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, stats as simStats, simulateAll } from './02-sim-exits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk.json');
console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades: ${walks.length}`);

// Group walks by rule
const byRule = {};
for (const w of walks) (byRule[w.ruleId || 'NONE'] = byRule[w.ruleId || 'NONE'] || []).push(w);
console.log(`\nRule counts:`);
for (const k of Object.keys(byRule).sort()) console.log(`  ${k}: ${byRule[k].length}`);

// Sweep grids
const TARGETS = [40, 50, 60, 70, 80, 90, 100, 120, 140, 160, 180, 200];
const STOPS   = [20, 25, 30, 35, 40, 45, 50, 60, 70];
// BE configs: 0 = no BE; else "trig:off" (lock-in)
const BE_CFGS = [
  [null, 0], [15, 0], [20, 5], [20, 10], [25, 5], [25, 10], [30, 5], [30, 10],
  [35, 10], [40, 10], [40, 15], [50, 10], [50, 15], [50, 20], [60, 15], [60, 20], [70, 20], [80, 20],
];
// Trail configs: 0 = no trail; else "trig/off"
const TRAIL_CFGS = [
  [null, null],
  [30, 12], [40, 15], [50, 15], [50, 20], [60, 20], [70, 25], [80, 30],
];
// Per-rule max-hold candidates (minutes)
const MH_CFGS = [60, 90, 120, 150];

function evalCfg(walksRule, cfg) {
  const results = [];
  for (const w of walksRule) {
    const r = simulate(w, cfg);
    results.push({ pointsPnL: r.pnl, exit: r.exit, mfe: r.mfe, durationMs: r.durationMs, dropped: false });
  }
  return simStats(results);
}

function sweepRule(walksRule, ruleId) {
  const results = [];
  let cfgCount = 0;
  for (const target of TARGETS) {
    for (const stop of STOPS) {
      for (const [beTrig, beOff] of BE_CFGS) {
        // Only consider BE configs where trigger > offset (avoids "BE on entry")
        if (beTrig != null && beTrig <= beOff) continue;
        for (const [trTrig, trOff] of TRAIL_CFGS) {
          // Only consider trails where trigger > offset
          if (trTrig != null && trOff != null && trTrig <= trOff) continue;
          for (const mh of MH_CFGS) {
            const cfg = { target, stop, beTrig, beOff, trTrig, trOff, maxHoldMin: mh };
            const st = evalCfg(walksRule, cfg);
            cfgCount++;
            results.push({
              ruleId, target, stop, beTrig, beOff, trTrig, trOff, maxHold: mh,
              n: st.n, pnl: st.pnl, wr: st.wr, pf: st.pf, maxDD: st.maxDD,
              sharpe: st.sharpe, sharpePerTrade: st.sharpePerTrade,
              avgWin: st.avgWin, avgLoss: st.avgLoss, avgMFE: st.avgMFE,
            });
          }
        }
      }
    }
  }
  console.log(`  ${ruleId}: evaluated ${cfgCount} configs`);
  return results;
}

const allResults = [];
const bestByRule = {};

for (const ruleId of ['L_S4', 'S_CW', 'S_GF_SOLO', 'S_R4']) {
  console.log(`\n--- Sweeping ${ruleId} (${byRule[ruleId].length} trades) ---`);
  const tStart = Date.now();
  const results = sweepRule(byRule[ruleId] || [], ruleId);
  console.log(`  done in ${((Date.now() - tStart)/1000).toFixed(1)}s`);
  // Sort by PnL desc, by Sharpe, by PF
  const byPnL = [...results].sort((a, b) => b.pnl - a.pnl);
  const bySharpe = [...results].sort((a, b) => b.sharpe - a.sharpe);
  const byPF = [...results].sort((a, b) => b.pf - a.pf);

  console.log(`\nTop 5 by PnL for ${ruleId}:`);
  for (const r of byPnL.slice(0, 5)) {
    console.log(`  tgt=${r.target} stp=${r.stop} BE=${r.beTrig}/+${r.beOff} tr=${r.trTrig}/${r.trOff} mh=${r.maxHold} → PnL=$${r.pnl.toFixed(0)} WR=${r.wr.toFixed(0)}% PF=${r.pf.toFixed(2)} Sh=${r.sharpe.toFixed(2)} DD=$${r.maxDD.toFixed(0)}`);
  }
  console.log(`\nTop 5 by Sharpe for ${ruleId}:`);
  for (const r of bySharpe.slice(0, 5)) {
    console.log(`  tgt=${r.target} stp=${r.stop} BE=${r.beTrig}/+${r.beOff} tr=${r.trTrig}/${r.trOff} mh=${r.maxHold} → PnL=$${r.pnl.toFixed(0)} WR=${r.wr.toFixed(0)}% PF=${r.pf.toFixed(2)} Sh=${r.sharpe.toFixed(2)} DD=$${r.maxDD.toFixed(0)}`);
  }
  bestByRule[ruleId] = {
    byPnL: byPnL[0],
    bySharpe: bySharpe[0],
    byPF: byPF[0],
  };
  allResults.push(...results);

  // Save top 200 per rule by PnL
  const top = byPnL.slice(0, 200);
  const csvOut = path.join(__dirname, 'output', `03-sweep-${ruleId}.csv`);
  const cols = ['target','stop','beTrig','beOff','trTrig','trOff','maxHold','n','pnl','wr','pf','sharpe','sharpePerTrade','maxDD','avgWin','avgLoss','avgMFE'];
  let csv = cols.join(',') + '\n';
  for (const r of top) csv += cols.map(c => r[c] == null ? '' : r[c]).join(',') + '\n';
  fs.writeFileSync(csvOut, csv);
  console.log(`  wrote ${csvOut} (top 200 by PnL)`);
}

console.log('\n=== Best per rule (by PnL × shape) ===');
for (const ruleId of Object.keys(bestByRule)) {
  console.log(`\n${ruleId}:`);
  for (const [k, r] of Object.entries(bestByRule[ruleId])) {
    console.log(`  ${k.padEnd(10)} tgt=${r.target} stp=${r.stop} BE=${r.beTrig}/+${r.beOff} tr=${r.trTrig}/${r.trOff} mh=${r.maxHold} → $${r.pnl.toFixed(0)} WR=${r.wr.toFixed(0)}% PF=${r.pf.toFixed(2)} Sh=${r.sharpe.toFixed(2)} DD=$${r.maxDD.toFixed(0)}`);
  }
}

const bestPath = path.join(__dirname, 'output', '03-per-rule-best.json');
fs.writeFileSync(bestPath, JSON.stringify(bestByRule, null, 2));
console.log(`\nWrote ${bestPath}`);

console.log('\nNote: Run 04 (per-rule joint validation) to compose these into a full policy.');
