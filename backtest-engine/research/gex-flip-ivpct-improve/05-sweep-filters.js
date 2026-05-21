/**
 * Phase 5 — Filter sweep, run on top of the best exit-only winners from Phase 4.
 *
 * Tests both single-filter and stacked-filter combinations against:
 *   1. The original tight-stop gold exits (baseline subtraction effect)
 *   2. The best-PnL exit from Phase 4 (compounding effect)
 *   3. The best-Sharpe exit from Phase 4
 *
 * Usage: node 05-sweep-filters.js [exitsCsv] [walkJson]
 */
import fs from 'fs';
import { simulateAll, stats } from './02-sim-exits.js';

const EXITS_CSV = process.argv[2] || './output/04-sweep-exits.csv';
const WALK = process.argv[3] || './output/01-trades-walk.json';
const walks = JSON.parse(fs.readFileSync(WALK, 'utf-8'));
console.log(`Loaded ${walks.length} trades`);

// Parse top exits CSV (already sorted by PnL desc)
const lines = fs.readFileSync(EXITS_CSV, 'utf-8').split('\n');
const headers = lines[0].split(',');
const rows = lines.slice(1).filter(l => l.trim().length > 0).map(l => {
  const cells = l.split(',');
  const obj = {};
  headers.forEach((h, i) => { obj[h] = cells[i]; });
  return obj;
});
console.log(`Loaded ${rows.length} exit configs from sweep`);

// Get the top valid configs (worstLoss must be >= -1300)
const valid = rows.filter(r => +r.worstLoss >= -1300);
console.log(`Valid configs: ${valid.length}`);

// Pick:
// 1. Best PnL with PF>=2 + DD<=15k
// 2. Best Sharpe with PnL>=140k
// 3. Best DD with PnL>=140k
const candidates = {
  'gold-baseline': { target: 200, stop: 60, beTrig: 70, beOff: 5, maxHoldMin: 600 },
};
const topPnl = valid.filter(r => +r.pf >= 2 && +r.maxDD <= 15000).sort((a,b) => +b.pnl - +a.pnl)[0];
const topSharpe = valid.filter(r => +r.pnl >= 140000).sort((a,b) => +b.sharpe - +a.sharpe)[0];
const topDD = valid.filter(r => +r.pnl >= 140000).sort((a,b) => +a.maxDD - +b.maxDD)[0];

function parseConfig(r) {
  return {
    target: +r.target,
    stop: 60,
    beTrig: r.beTrig === '-' ? null : +r.beTrig,
    beOff: r.beOff === '-' ? 0 : +r.beOff,
    trTrig: r.trTrig === '-' ? null : +r.trTrig,
    trOff: r.trOff === '-' ? null : +r.trOff,
    fibActivationMFE: r.fibAct === '-' ? null : +r.fibAct,
    fibRetracePct: r.fibPct === '-' ? null : +r.fibPct,
    maxHoldMin: +r.maxHoldMin,
  };
}
if (topPnl) candidates['best-pnl-exits'] = parseConfig(topPnl);
if (topSharpe) candidates['best-sharpe-exits'] = parseConfig(topSharpe);
if (topDD) candidates['best-dd-exits'] = parseConfig(topDD);

console.log('\nCandidate exit policies:');
for (const [k, v] of Object.entries(candidates)) {
  console.log(`  ${k}:`, JSON.stringify(v));
}

// Filter dimensions
const FILTERS = {
  none: {},
  no_h11: { blockedHours: [11] },
  no_h13: { blockedHours: [13] },
  no_h11_13: { blockedHours: [11, 13] },
  no_fri: { blockedDows: ['Fri'] },
  no_mon_fri: { blockedDows: ['Mon', 'Fri'] }, // ablation - Mon is BEST so this should hurt
  no_h11_fri: { blockedHours: [11], blockedDows: ['Fri'] },
  no_L4: { blockedRules: ['L4'] },
  no_S1: { blockedRules: ['S1'] },
  no_S2: { blockedRules: ['S2'] },
  no_L4_S1: { blockedRules: ['L4', 'S1'] },
  no_neg_regime: { blockedRegimes: ['negative', 'strong_negative'] },
  no_strong_neg: { blockedRegimes: ['strong_negative'] },
  no_strong_pos: { blockedRegimes: ['strong_positive'] },
  // Combined stacks
  stack_h11_fri_L4: { blockedHours: [11], blockedDows: ['Fri'], blockedRules: ['L4'] },
  stack_h11_fri_S1: { blockedHours: [11], blockedDows: ['Fri'], blockedRules: ['S1'] },
  stack_h11_fri_L4S1: { blockedHours: [11], blockedDows: ['Fri'], blockedRules: ['L4', 'S1'] },
  stack_h11_L4S1: { blockedHours: [11], blockedRules: ['L4', 'S1'] },
  stack_h11_strong_neg_S1: { blockedHours: [11], blockedRegimes: ['strong_negative'], blockedRules: ['S1'] },
  stack_fri_S1_neg: { blockedDows: ['Fri'], blockedRules: ['S1'], blockedRegimes: ['negative'] },
};

const allResults = [];
for (const [exitName, cfg] of Object.entries(candidates)) {
  for (const [filterName, fopts] of Object.entries(FILTERS)) {
    const results = simulateAll(walks, cfg, fopts);
    const s = stats(results);
    allResults.push({
      exit: exitName,
      filter: filterName,
      n: s.n, dropped: s.dropped,
      pnl: s.pnl, wr: s.wr, pf: s.pf, sharpe: s.sharpe,
      maxDD: s.maxDD, worstLoss: s.worstLoss,
    });
  }
}

// Print per-exit-policy table
console.log('\n\n=================== Filter × Exit Policy Matrix ===================');
const grouped = {};
for (const r of allResults) {
  (grouped[r.exit] = grouped[r.exit] || []).push(r);
}
for (const exitName of Object.keys(grouped)) {
  console.log(`\n--- ${exitName} (exits: ${JSON.stringify(candidates[exitName])}) ---`);
  console.log('  filter                  n   drop  PnL     WR   PF    Sharpe DD     worstL');
  const baseline = grouped[exitName].find(r => r.filter === 'none');
  for (const r of grouped[exitName].sort((a, b) => b.pnl - a.pnl)) {
    const delta = r.pnl - baseline.pnl;
    console.log(`  ${r.filter.padEnd(22)} ${String(r.n).padStart(3)} ${String(r.dropped).padStart(3)}  $${r.pnl.toFixed(0).padStart(7)} ${r.wr.toFixed(0).padStart(3)}% ${r.pf.toFixed(2).padStart(5)} ${r.sharpe.toFixed(2).padStart(5)}  ${r.maxDD.toFixed(0).padStart(5)} ${r.worstLoss.toFixed(0).padStart(6)}  (Δ ${delta > 0 ? '+' : ''}${delta.toFixed(0)})`);
  }
}

// CSV
const out = './output/05-sweep-filters.csv';
const header = 'exit,filter,n,dropped,pnl,wr,pf,sharpe,maxDD,worstLoss';
const csvLines = [header];
for (const r of allResults) {
  csvLines.push([r.exit, r.filter, r.n, r.dropped, r.pnl.toFixed(0), r.wr.toFixed(2), r.pf.toFixed(3), r.sharpe.toFixed(3), r.maxDD.toFixed(0), r.worstLoss.toFixed(0)].join(','));
}
fs.writeFileSync(out, csvLines.join('\n'));
console.log(`\nWrote ${out}`);
