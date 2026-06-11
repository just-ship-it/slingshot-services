#!/usr/bin/env node
// Quick lookup: "at balance $X, what should be enabled and how many contracts?"
// Source of truth: account-growth-plan.json (aggressive phase-in plan).
//
// Usage:  node account-plan.js 1500
//         node account-plan.js 4000 12000 25000 50000     (multiple)
//         node account-plan.js                            (prints the whole table)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, 'account-growth-plan.json'), 'utf8'));

function ladderAt(bal) {
  let pick = PLAN.contractLadder.tiers[0];
  for (const t of PLAN.contractLadder.tiers) if (bal >= t.minBalance) pick = t;
  return pick;
}
function enabledAt(bal) {
  return PLAN.strategyPhaseIn.strategies.filter(s => bal >= s.onBalance);
}
function usd(n) { return '$' + Number(n).toLocaleString(); }

function reportOne(bal) {
  const lot = ladderAt(bal);
  const on = enabledAt(bal);
  console.log(`\n  Balance ${usd(bal)}  →  ${lot.qty} ${lot.contract}`);
  console.log(`  Enabled: ${on.map(s => s.alias).join(', ')}`);
  const off = PLAN.strategyPhaseIn.strategies.filter(s => bal < s.onBalance);
  if (off.length) console.log(`  Off (until): ${off.map(s => `${s.alias} @${usd(s.onBalance)}`).join(', ')}`);
}

function table() {
  console.log(`\n  ${PLAN.preset.toUpperCase()} account-growth plan (updated ${PLAN.updated})`);
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  balance band          size      strategies enabled');
  console.log('  ─────────────────────────────────────────────────────────────');
  // Build the union of breakpoints from ladder + phase-in.
  const bps = new Set([0]);
  for (const t of PLAN.contractLadder.tiers) bps.add(t.minBalance);
  for (const s of PLAN.strategyPhaseIn.strategies) bps.add(s.onBalance);
  const sorted = [...bps].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i], hi = sorted[i + 1];
    const lot = ladderAt(lo);
    const on = enabledAt(lo).map(s => s.alias).join(', ');
    const band = hi ? `${usd(lo)}–${usd(hi)}` : `${usd(lo)}+`;
    console.log(`  ${band.padEnd(20)}  ${(lot.qty + ' ' + lot.contract).padEnd(8)}  ${on}`);
  }
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  Hysteresis (protective auto-off if you wire it later):`);
  for (const s of PLAN.strategyPhaseIn.strategies.filter(s => s.offBalance > 0)) {
    console.log(`    ${s.alias.padEnd(12)} on ≥ ${usd(s.onBalance)}, OFF if < ${usd(s.offBalance)}`);
  }
  console.log(`\n  Expectations (16mo block-bootstrap from $1.5k): 0% ruin · ~${(100*PLAN.expectations.worstDrawdownP90).toFixed(0)}% worst DD · median ${usd(PLAN.expectations.medianFinal)}`);
  console.log(`  ${PLAN.expectations.drawdownFloorNote}\n`);
}

const args = process.argv.slice(2).map(Number).filter(n => Number.isFinite(n));
if (args.length === 0) table();
else args.forEach(reportOne);
console.log();
