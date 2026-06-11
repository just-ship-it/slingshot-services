#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// PHASE-IN MODEL — per-strategy balance-gated activation with hysteresis.
//
// lstb always trades from $1,500. Each of the other three strategies has an
// ON threshold (activate when balance ≥ on) and an OFF threshold (deactivate
// when balance < off, off < on) — so a strategy that was switched on gets
// switched back OFF for protection if the account draws down past `off`.
//
// We model the FCFS slot honestly: for every possible ACTIVE SUBSET we
// pre-resolve that subset's day-by-day trades (FCFS), then in each bootstrapped
// life we pick the day-kernel from whichever subset is active at that day's
// balance. Sequence-safe (resampled days; optional block for clustering).
//
// Sweeps activation thresholds and ranks by growth SUBJECT TO survival:
//   reject if P(ruin) > 0  OR  worstDD p90 > --dd-ceiling (default 0.32)
//   among survivors → maximize median final balance.
//
// Usage:
//   node phase-in-model.js                      # sweep + best schedule
//   node phase-in-model.js --n 2000 --dd-ceiling 0.30
//   node phase-in-model.js --validate "lt3m=8000,gexflip=8000,levelfade=25000"
// ─────────────────────────────────────────────────────────────────────────────

import { fmtETDate } from '../multi-strategy-rules/lib/et-time.js';
import { simulate, loadTrades, STRATEGIES, CFG, LADDER } from './run-real-account.js';

function argNum(f, d) { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; }
function argStr(f, d) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; }
const N        = argNum('--n', 2000);
const NDAYS    = argNum('--days', 330);
const BLOCK    = argNum('--block', 1);
const DD_CEIL  = argNum('--dd-ceiling', 0.32);
const HYST     = argNum('--hyst', 0.80);   // off threshold = on × HYST
let   SEED     = argNum('--seed', 12345);
const VALIDATE = argStr('--validate', null);

function rng() { SEED |= 0; SEED = SEED + 0x6D2B79F5 | 0; let t = Math.imul(SEED ^ SEED >>> 15, 1 | SEED); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

function ladderForBalance(balance) {
  let nMnq = 1, nNq = 0;
  for (let i = LADDER.length - 1; i >= 0; i--) {
    if (balance >= LADDER[i][0]) { nMnq = LADDER[i][1]; nNq = LADDER[i][2]; break; }
  }
  if (nNq > 0) return { n: Math.min(nNq, Math.floor(balance / CFG.marginNQ)), pv: CFG.nqPointValue, comm: CFG.commNQ };
  return { n: Math.min(nMnq, Math.floor(balance / CFG.marginMNQ)), pv: CFG.mnqPointValue, comm: CFG.commMNQ };
}

// The three gateable strategies (lstb is always on). bit index → key.
const GATED = ['gex-lt-3m', 'gex-flip-ivpct', 'gex-level-fade'];
const NAME  = { 'gex-lt-3m': 'lt3m', 'gex-flip-ivpct': 'gexflip', 'gex-level-fade': 'levelfade' };
const tradesByKey = {};
for (const def of STRATEGIES) tradesByKey[def.key] = loadTrades(def);

// Pre-resolve day-kernels for all 8 active subsets (lstb ∪ subset of GATED).
// pools[mask] = { dates:[...], kernels:[[pts,...], ...] } aligned by date.
const pools = [];
for (let mask = 0; mask < 8; mask++) {
  const trades = [...tradesByKey['lstb']];
  for (let b = 0; b < 3; b++) if (mask & (1 << b)) trades.push(...tradesByKey[GATED[b]]);
  const res = simulate(trades, CFG);
  const m = new Map();
  for (const t of res.realized) {
    const d = fmtETDate(t.exitTime);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(t.pointsPnL);
  }
  const dates = [...m.keys()].sort();
  pools[mask] = { dates, kernels: dates.map(d => m.get(d)), byDate: m };
}
// Union date axis (for block-aligned sampling across subsets).
const ALL_DATES = [...new Set(pools[7].dates)].sort();
const DIDX = ALL_DATES.length;
// Precompute, per subset, a kernel for every union-date (empty if none that day).
const subsetByDate = pools.map(p => ALL_DATES.map(d => p.byDate.get(d) || []));

// One life. thresholds = {lt3m, gexflip, levelfade} ON levels.
function oneLife(thr) {
  let balance = CFG.startBalance, peak = balance, maxDD = 0, microDD = 0, ruined = false;
  const on = [false, false, false];                 // hysteresis state per gated strat
  const onLvl = [thr.lt3m, thr.gexflip, thr.levelfade];
  let dayCount = 0;
  outer:
  while (dayCount < NDAYS) {
    let idx = (rng() * DIDX) | 0;
    for (let bk = 0; bk < BLOCK && dayCount < NDAYS; bk++, idx = (idx + 1) % DIDX, dayCount++) {
      // Resolve active mask with hysteresis at current balance.
      let mask = 0;
      for (let b = 0; b < 3; b++) {
        if (!on[b] && balance >= onLvl[b]) on[b] = true;
        else if (on[b] && balance < onLvl[b] * HYST) on[b] = false;
        if (on[b]) mask |= (1 << b);
      }
      const day = subsetByDate[mask][idx];
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
  return { balance: ruined ? 0 : balance, maxDD, microDD, ruined };
}

function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
const usd = n => '$' + Math.round(n).toLocaleString();

function evaluate(thr) {
  SEED = 12345; // reset per config for fair comparison
  const finals = [], micros = [], maxdds = [];
  let ruins = 0;
  for (let i = 0; i < N; i++) {
    const l = oneLife(thr);
    finals.push(l.balance); micros.push(l.microDD); maxdds.push(l.maxDD);
    if (l.ruined) ruins++;
  }
  return {
    thr, ruin: ruins / N,
    p10: pct(finals, 0.10), p50: pct(finals, 0.50), p90: pct(finals, 0.90),
    microP90: pct(micros, 0.90), maxDDp90: pct(maxdds, 0.90),
  };
}

function label(thr) {
  return `lt3m@${thr.lt3m >= 1e6 ? 'never' : '$' + (thr.lt3m / 1000) + 'k'} gexflip@${thr.gexflip >= 1e6 ? 'never' : '$' + (thr.gexflip / 1000) + 'k'} levelfade@${thr.levelfade >= 1e6 ? 'never' : '$' + (thr.levelfade / 1000) + 'k'}`;
}
function row(r) {
  return [label(r.thr).padEnd(46), ((100 * r.ruin).toFixed(2) + '%').padStart(7),
    usd(r.p10).padStart(11), usd(r.p50).padStart(12), usd(r.p90).padStart(13),
    ((100 * r.microP90).toFixed(0) + '%').padStart(8), ((100 * r.maxDDp90).toFixed(0) + '%').padStart(8)].join('  ');
}
const HDR = ['schedule'.padEnd(46), 'P(ruin)'.padStart(7), 'final p10'.padStart(11),
  'final p50'.padStart(12), 'final p90'.padStart(13), 'microP90'.padStart(8), 'maxDDp90'.padStart(8)].join('  ');

if (VALIDATE) {
  const t = {}; for (const kv of VALIDATE.split(',')) { const [k, v] = kv.split('='); t[k] = Number(v); }
  console.log(`\nValidate (block=${BLOCK}, seed sweep, n=${N}):\n`);
  console.log(HDR); console.log('─'.repeat(110)); console.log(row(evaluate(t)));
  console.log();
} else {
  const GRID = [4000, 8000, 15000, 25000, 1e9]; // 1e9 = never
  const results = [];
  for (const lt3m of GRID) for (const gexflip of GRID) for (const levelfade of GRID) {
    results.push(evaluate({ lt3m, gexflip, levelfade }));
  }
  const survivors = results.filter(r => r.ruin === 0 && r.maxDDp90 <= DD_CEIL);
  survivors.sort((a, b) => b.p50 - a.p50);

  console.log(`\n═════ Phase-in sweep — $${CFG.startBalance} start · ${N} lives × ${NDAYS}d · block ${BLOCK} ═════`);
  console.log(`   ${results.length} schedules · survival filter: P(ruin)=0 AND maxDDp90 ≤ ${(100 * DD_CEIL).toFixed(0)}%   (${survivors.length} pass)\n`);
  console.log(HDR); console.log('─'.repeat(110));
  console.log('TOP 12 BY GROWTH (within drawdown ceiling):');
  for (const r of survivors.slice(0, 12)) console.log(row(r));
  console.log('\nLOWEST-DRAWDOWN SURVIVORS:');
  for (const r of [...survivors].sort((a, b) => a.maxDDp90 - b.maxDDp90).slice(0, 6)) console.log(row(r));
  console.log('\nReference points:');
  for (const t of [{ lt3m: 1e9, gexflip: 1e9, levelfade: 1e9 }, { lt3m: 0, gexflip: 0, levelfade: 0 }]) {
    console.log(row(evaluate(t)));
  }
  console.log();
}
