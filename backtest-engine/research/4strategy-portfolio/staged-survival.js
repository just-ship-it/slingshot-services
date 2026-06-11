#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// STAGED survival mode — the firm solution.
//
// While the account is SMALL it cannot survive the wide-stop fade strategies
// (level-fade 67% micro-DD / 2.2% ruin, lt-3m 47%). It CAN survive lstb alone
// (12-pt stop → 21% micro-DD, 0% ruin). So:
//
//   balance <  THRESHOLD  → SURVIVAL MODE: trade lstb only
//   balance >= THRESHOLD  → GROWTH MODE:   trade the full 4-strategy portfolio
//
// This finds the graduation THRESHOLD: low enough to capture portfolio growth
// early, high enough that the portfolio's drawdown can't drive the account back
// to ruin. Judged on the resampled-day bootstrap (sequence-safe), survival first.
//
// Usage: node staged-survival.js            (sweeps thresholds)
//        node staged-survival.js --n 5000
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';
import { fileURLToPath } from 'url';
import { fmtETDate } from '../multi-strategy-rules/lib/et-time.js';
import { simulate, loadTrades, STRATEGIES, CFG, LADDER } from './run-real-account.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function argNum(f, d) { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; }
const N = argNum('--n', 4000);
const NDAYS = argNum('--days', 330);
const BLOCK = argNum('--block', 1); // resample contiguous N-day blocks to preserve regime clustering
let SEED = argNum('--seed', 12345);
function rng() { SEED |= 0; SEED = SEED + 0x6D2B79F5 | 0; let t = Math.imul(SEED ^ SEED >>> 15, 1 | SEED); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

function ladderForBalance(balance) {
  let nMnq = 1, nNq = 0;
  for (let i = LADDER.length - 1; i >= 0; i--) {
    if (balance >= LADDER[i][0]) { nMnq = LADDER[i][1]; nNq = LADDER[i][2]; break; }
  }
  if (nNq > 0) return { n: Math.min(nNq, Math.floor(balance / CFG.marginNQ)), pv: CFG.nqPointValue, comm: CFG.commNQ };
  return { n: Math.min(nMnq, Math.floor(balance / CFG.marginMNQ)), pv: CFG.mnqPointValue, comm: CFG.commMNQ };
}

function dayMap(realized) {
  const m = new Map();
  for (const t of realized) {
    const d = fmtETDate(t.exitTime);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(t.pointsPnL);
  }
  return m;
}

// Date-aligned kernel pools so a BLOCK bootstrap resamples the SAME calendar
// stretch from both modes (preserves regime clustering — trend weeks bunch up).
const lstbTrades = loadTrades(STRATEGIES.find(s => s.key === 'lstb'));
const survMap = dayMap(simulate(lstbTrades, CFG).realized);
const allTrades = [];
for (const def of STRATEGIES) allTrades.push(...loadTrades(def));
const growMap = dayMap(simulate(allTrades, CFG).realized);

const allDates = [...new Set([...survMap.keys(), ...growMap.keys()])].sort();
const survivalKernels = allDates.map(d => survMap.get(d) || []);
const growthKernels   = allDates.map(d => growMap.get(d) || []);
const D = allDates.length;

// One staged life. Resample contiguous BLOCK-day stretches (wrapping). For each
// day, trade survival (lstb) or growth (full) kernel depending on balance vs
// threshold. BLOCK=1 → IID day resample.
function oneLife(threshold) {
  let balance = CFG.startBalance, peak = balance, maxDD = 0, microDD = 0, ruined = false;
  let daysToGraduate = null, dayCount = 0;
  outer:
  while (dayCount < NDAYS) {
    let idx = (rng() * D) | 0;
    for (let b = 0; b < BLOCK && dayCount < NDAYS; b++, idx = (idx + 1) % D, dayCount++) {
      const small = balance < threshold;
      if (!small && daysToGraduate == null) daysToGraduate = dayCount;
      const day = (small ? survivalKernels : growthKernels)[idx];
      for (const pts of day) {
        const lot = ladderForBalance(balance);
        if (lot.n < 1) { ruined = true; break outer; }
        balance += pts * lot.pv * lot.n - lot.comm * lot.n;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;
        if (peak < 25000 && dd > microDD) microDD = dd;
        if (balance < CFG.marginMNQ) { ruined = true; break outer; }
      }
    }
  }
  return { balance: ruined ? 0 : balance, maxDD, microDD, ruined, daysToGraduate };
}

function pct(arr, p) { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
const usd = n => '$' + Math.round(n).toLocaleString();

function evalThreshold(threshold) {
  const lives = [];
  for (let i = 0; i < N; i++) lives.push(oneLife(threshold));
  const finals = lives.map(l => l.balance);
  const micros = lives.map(l => l.microDD);
  const maxdds = lives.map(l => l.maxDD);
  const grad = lives.map(l => l.daysToGraduate).filter(x => x != null);
  return {
    threshold,
    ruin: lives.filter(l => l.ruined).length / N,
    p10: pct(finals, 0.10), p50: pct(finals, 0.50), p90: pct(finals, 0.90),
    microP90: pct(micros, 0.90), maxDDp90: pct(maxdds, 0.90),
    gradP50: grad.length ? pct(grad, 0.5) : null,
  };
}

function row(r) {
  return [
    (r.threshold === Infinity ? 'lstb-only (never)' : r.threshold === 0 ? 'full (always)' : '$' + r.threshold.toLocaleString()).padEnd(18),
    ((100 * r.ruin).toFixed(2) + '%').padStart(7),
    usd(r.p10).padStart(11), usd(r.p50).padStart(12), usd(r.p90).padStart(13),
    ((100 * r.microP90).toFixed(0) + '%').padStart(8),
    ((100 * r.maxDDp90).toFixed(0) + '%').padStart(7),
    (r.gradP50 == null ? '—' : r.gradP50 + 'd').padStart(8),
  ].join('  ');
}

console.log(`\n═════ Staged survival mode — $${CFG.startBalance} start, ${N} lives × ${NDAYS} days ═════`);
console.log(`   survival pool: lstb-only (${survivalKernels.length} days) · growth pool: 4-strat FCFS (${growthKernels.length} days)\n`);
console.log([
  'graduate at'.padEnd(18), 'P(ruin)'.padStart(7), 'final p10'.padStart(11), 'final p50'.padStart(12),
  'final p90'.padStart(13), 'microP90'.padStart(8), 'maxDDp90'.padStart(7), 'grad p50'.padStart(8),
].join('  '));
console.log('─'.repeat(96));

for (const th of [0, 5000, 10000, 15000, 25000, 40000, Infinity]) {
  console.log(row(evalThreshold(th)));
}
console.log('\n  (microP90 = drawdown while peak < $25k · maxDDp90 = 90th-pct worst drawdown over the whole life)');
console.log('  (grad p50 = median trading days spent in survival mode before crossing the threshold)\n');
