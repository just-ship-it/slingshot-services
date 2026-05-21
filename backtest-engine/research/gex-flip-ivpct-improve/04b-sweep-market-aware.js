/**
 * Phase 4b — Market-aware mechanic sweep on the gfi gold trade walks.
 *
 * Tests three mechanics layered on the gold-baseline-exits + best-from-Phase-4
 * exits:
 *   1. Fib retrace (already in strategy)
 *   2. Double-rejection (DR)
 *   3. MFE-fraction-TP (MFT) — like dynamic BE scaled by target
 *
 * For each mechanic, sweep a small grid of configs ON TOP of:
 *   A. gold-baseline:  target=200 stop=60 BE=70/+5 maxhold=600
 *   B. no-BE:          target=200 stop=60 maxhold=600 (to test fib stand-alone)
 *
 * Writes to output/04b-sweep-ma.csv.
 */

import fs from 'fs';
import { simulateAll, stats } from './02-sim-exits.js';

const WALK = process.argv[2] || './output/01-trades-walk.json';
const OUT = './output/04b-sweep-ma.csv';
const walks = JSON.parse(fs.readFileSync(WALK, 'utf-8'));

const BASES = {
  gold:    { target: 200, stop: 60, beTrig: 70, beOff: 5, maxHoldMin: 600 },
  noBE:    { target: 200, stop: 60, maxHoldMin: 600 },
  wider:   { target: 240, stop: 60, beTrig: 100, beOff: 5, maxHoldMin: 600 },
};

const rows = [];

console.log('=== Fib retrace sweep ===');
// Fib retrace: act × pct grid
for (const baseName of Object.keys(BASES)) {
  for (const act of [null, 30, 40, 50, 60, 70, 80, 100, 120]) {
    for (const pct of [null, 0.382, 0.5, 0.618, 0.7, 0.786]) {
      if (act == null && pct != null) continue;
      if (act != null && pct == null) continue;
      const cfg = { ...BASES[baseName], fibActivationMFE: act, fibRetracePct: pct };
      const results = simulateAll(walks, cfg);
      const s = stats(results);
      rows.push({
        mechanic: 'fib', base: baseName,
        p1: act, p2: pct, p3: null,
        n: s.n, pnl: s.pnl, wr: s.wr, pf: s.pf, sharpe: s.sharpe,
        maxDD: s.maxDD, worstLoss: s.worstLoss,
        fibCt: s.exitReasons.fib || 0,
        beCt: s.exitReasons.be || 0,
        targetCt: s.exitReasons.target || 0,
        stopCt: s.exitReasons.stop || 0,
      });
    }
  }
}

console.log('=== DR sweep ===');
// Double-rejection: drFracTp × drPullbackMin × drTolPts × close-or-tighten
for (const baseName of ['gold', 'noBE']) {
  for (const drFracTp of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    for (const drPullbackMin of [5, 10, 15, 20]) {
      for (const drTolPts of [1, 2, 3, 5]) {
        // close action
        const cfg1 = { ...BASES[baseName], drFracTp, drPullbackMin, drTolPts, drClose: true };
        const r1 = simulateAll(walks, cfg1);
        const s1 = stats(r1);
        rows.push({
          mechanic: 'dr_close', base: baseName,
          p1: drFracTp, p2: drPullbackMin, p3: drTolPts,
          n: s1.n, pnl: s1.pnl, wr: s1.wr, pf: s1.pf, sharpe: s1.sharpe,
          maxDD: s1.maxDD, worstLoss: s1.worstLoss,
          drCt: s1.exitReasons.dr_close || 0,
          beCt: s1.exitReasons.be || 0,
          targetCt: s1.exitReasons.target || 0,
          stopCt: s1.exitReasons.stop || 0,
        });
        // tighten action (lock 30%/50% MFE)
        for (const lockFrac of [0.3, 0.5]) {
          const cfg2 = { ...BASES[baseName], drFracTp, drPullbackMin, drTolPts, drTightenLockFrac: lockFrac };
          const r2 = simulateAll(walks, cfg2);
          const s2 = stats(r2);
          rows.push({
            mechanic: `dr_tight_${lockFrac}`, base: baseName,
            p1: drFracTp, p2: drPullbackMin, p3: drTolPts,
            n: s2.n, pnl: s2.pnl, wr: s2.wr, pf: s2.pf, sharpe: s2.sharpe,
            maxDD: s2.maxDD, worstLoss: s2.worstLoss,
            drCt: s2.exitReasons.dr_close || 0,
            beCt: s2.exitReasons.be || 0,
            targetCt: s2.exitReasons.target || 0,
            stopCt: s2.exitReasons.stop || 0,
          });
        }
      }
    }
  }
}

console.log('=== MFT sweep ===');
// MFT: mftFracTp × mftLockFrac
for (const baseName of ['noBE']) { // MFT replaces BE
  for (const mftFracTp of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const mftLockFrac of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
      const cfg = { ...BASES[baseName], mftFracTp, mftLockFrac };
      const results = simulateAll(walks, cfg);
      const s = stats(results);
      rows.push({
        mechanic: 'mft', base: baseName,
        p1: mftFracTp, p2: mftLockFrac, p3: null,
        n: s.n, pnl: s.pnl, wr: s.wr, pf: s.pf, sharpe: s.sharpe,
        maxDD: s.maxDD, worstLoss: s.worstLoss,
        beCt: s.exitReasons.be || 0,
        targetCt: s.exitReasons.target || 0,
        stopCt: s.exitReasons.stop || 0,
      });
    }
  }
}

console.log(`Generated ${rows.length} rows`);

// Print top 10 per (mechanic, base)
const grouped = {};
for (const r of rows) {
  const k = `${r.mechanic}_${r.base}`;
  (grouped[k] = grouped[k] || []).push(r);
}
for (const k of Object.keys(grouped).sort()) {
  console.log(`\n--- TOP 8 by PnL: ${k} ---`);
  const sorted = grouped[k].slice().sort((a, b) => b.pnl - a.pnl);
  for (const r of sorted.slice(0, 8)) {
    console.log(`  p=${String(r.p1).padStart(5)},${String(r.p2).padStart(5)},${String(r.p3).padStart(5)}  n=${r.n} PnL=$${r.pnl.toFixed(0).padStart(7)} PF=${r.pf.toFixed(2)} Sh=${r.sharpe.toFixed(2)} DD=$${r.maxDD.toFixed(0)} worstL=$${r.worstLoss.toFixed(0)}  exits: T=${r.targetCt} S=${r.stopCt} BE=${r.beCt} fib=${r.fibCt||0} dr=${r.drCt||0}`);
  }
}

const header = 'mechanic,base,p1,p2,p3,n,pnl,wr,pf,sharpe,maxDD,worstLoss,targetCt,stopCt,beCt,fibCt,drCt';
const csv = [header];
for (const r of rows) {
  csv.push([r.mechanic, r.base, r.p1, r.p2, r.p3, r.n, r.pnl.toFixed(0), r.wr.toFixed(2), r.pf.toFixed(3), r.sharpe.toFixed(3), r.maxDD.toFixed(0), r.worstLoss.toFixed(0), r.targetCt, r.stopCt, r.beCt, r.fibCt || 0, r.drCt || 0].join(','));
}
fs.writeFileSync(OUT, csv.join('\n'));
console.log(`\nWrote ${OUT}`);
