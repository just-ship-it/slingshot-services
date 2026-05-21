/**
 * Phase 3b — COARSE per-rule sweep (no BE/trail, just target × stop × maxHold).
 * Quick exploration to identify the R:R sweet spot for each rule.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, stats as simStats } from './02-sim-exits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk.json');
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));

const byRule = {};
for (const w of walks) (byRule[w.ruleId || 'NONE'] = byRule[w.ruleId || 'NONE'] || []).push(w);

const TARGETS = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 140, 160, 180];
const STOPS   = [15, 20, 25, 30, 35, 40, 45, 50, 60];
const MHS     = [45, 60, 90, 120];

function evalCfg(walksRule, cfg) {
  const results = [];
  for (const w of walksRule) {
    const r = simulate(w, cfg);
    results.push({ pointsPnL: r.pnl, exit: r.exit, mfe: r.mfe, durationMs: r.durationMs, dropped: false });
  }
  return simStats(results);
}

for (const ruleId of ['L_S4', 'S_CW', 'S_GF_SOLO', 'S_R4']) {
  const tr = byRule[ruleId] || [];
  console.log(`\n=== ${ruleId} (n=${tr.length}) — Coarse target × stop × maxHold ===`);
  const results = [];
  for (const target of TARGETS) {
    for (const stop of STOPS) {
      for (const mh of MHS) {
        const cfg = { target, stop, beTrig: null, beOff: 0, trTrig: null, trOff: 0, maxHoldMin: mh };
        const st = evalCfg(tr, cfg);
        results.push({ target, stop, mh, ...st });
      }
    }
  }
  // Best by PnL
  const byPnL = [...results].sort((a, b) => b.pnl - a.pnl);
  const bySharpe = [...results].sort((a, b) => b.sharpe - a.sharpe);
  const byPF = [...results].sort((a, b) => b.pf - a.pf);
  console.log(`  Top 10 by PnL:`);
  for (const r of byPnL.slice(0, 10)) {
    console.log(`    tgt=${String(r.target).padStart(3)} stp=${String(r.stop).padStart(2)} mh=${String(r.mh).padStart(3)} | $${r.pnl.toFixed(0).padStart(6)} WR=${r.wr.toFixed(0)}% PF=${r.pf.toFixed(2)} Sh=${r.sharpe.toFixed(2)} DD=$${r.maxDD.toFixed(0)}`);
  }
  console.log(`  Top 5 by Sharpe:`);
  for (const r of bySharpe.slice(0, 5)) {
    console.log(`    tgt=${String(r.target).padStart(3)} stp=${String(r.stop).padStart(2)} mh=${String(r.mh).padStart(3)} | $${r.pnl.toFixed(0).padStart(6)} WR=${r.wr.toFixed(0)}% PF=${r.pf.toFixed(2)} Sh=${r.sharpe.toFixed(2)} DD=$${r.maxDD.toFixed(0)}`);
  }
  console.log(`  Top 3 by PF (n>=trade count threshold):`);
  for (const r of byPF.filter(r => r.n >= tr.length * 0.5).slice(0, 3)) {
    console.log(`    tgt=${String(r.target).padStart(3)} stp=${String(r.stop).padStart(2)} mh=${String(r.mh).padStart(3)} | $${r.pnl.toFixed(0).padStart(6)} WR=${r.wr.toFixed(0)}% PF=${r.pf.toFixed(2)} Sh=${r.sharpe.toFixed(2)} DD=$${r.maxDD.toFixed(0)}`);
  }
}
