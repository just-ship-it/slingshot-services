/**
 * Phase 8 — Train/test split stability check.
 *
 * Splits walks at SEP_TS (2025-09-01 00:00 ET) and re-runs simulator on H1
 * and H2 separately. Validates each candidate doesn't overfit.
 */
import fs from 'fs';
import { simulateAll, stats } from './02-sim-exits.js';

const WALK = process.argv[2] || './output/01-trades-walk.json';
const walks = JSON.parse(fs.readFileSync(WALK, 'utf-8'));

const SEP_ISO = '2025-09-01T04:00:00Z'; // 00:00 ET = 04:00 UTC
const SEP_TS = new Date(SEP_ISO).getTime();
const H1 = walks.filter(w => w.fillTs < SEP_TS);
const H2 = walks.filter(w => w.fillTs >= SEP_TS);

console.log(`H1 (Jan-Aug 2025): ${H1.length} trades`);
console.log(`H2 (Sep 2025-Apr 2026): ${H2.length} trades`);
console.log(`Total: ${walks.length}`);

const candidatesFile = process.argv[3] || './output/candidates.json';
let candidates;
if (fs.existsSync(candidatesFile)) {
  candidates = JSON.parse(fs.readFileSync(candidatesFile, 'utf-8'));
} else {
  // Default: just compare the gold against a few preset hypotheses (will be replaced by phase 4 output)
  candidates = {
    'gold': { target: 200, stop: 60, beTrig: 70, beOff: 5, maxHoldMin: 600 },
  };
}

function row(name, st, halfTradesPerYear) {
  return {
    name,
    n: st.n, pnl: st.pnl, wr: st.wr, pf: st.pf, sharpe: st.sharpe,
    maxDD: st.maxDD, worstLoss: st.worstLoss,
  };
}

console.log('\n=================== Train/Test stability ===================');
console.log('Candidate              | Period | n   PnL ($)   WR%   PF    Sharpe  MaxDD ($)  WorstLoss');
console.log('-----------------------+--------+----+---------+----+-------+--------+----------+----------');
for (const [name, cfg] of Object.entries(candidates)) {
  const rAll = simulateAll(walks, cfg, cfg.filterOpts || {});
  const rH1 = simulateAll(H1, cfg, cfg.filterOpts || {});
  const rH2 = simulateAll(H2, cfg, cfg.filterOpts || {});
  const sAll = stats(rAll);
  const sH1 = stats(rH1, { tradesPerYearDenom: 8 / 12 });
  const sH2 = stats(rH2, { tradesPerYearDenom: 8 / 12 });
  for (const [label, s] of [['ALL', sAll], ['H1', sH1], ['H2', sH2]]) {
    console.log(`${name.padEnd(22)} | ${label.padEnd(6)} | ${String(s.n).padStart(3)} ${s.pnl.toFixed(0).padStart(8)}  ${s.wr.toFixed(0).padStart(2)}% ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(5)}  ${s.maxDD.toFixed(0).padStart(8)}  ${s.worstLoss.toFixed(0).padStart(8)}`);
  }
}
