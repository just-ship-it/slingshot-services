#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SURVIVAL-FIRST judge for the real $1,500 laddered MNQ account.
//
// "Can't just rely on the overall PnL curve over 16 months." One historical
// ordering surviving doesn't prove the NEXT ordering will. This bootstraps the
// daily-PnL kernel (resample whole trading days with replacement — preserves
// intraday FCFS structure, breaks the lucky month-ordering) and replays each
// synthetic sequence through the SAME balance-tier ladder. Mirrors the
// methodology in research/no-trade-day/precompute-projection.py.
//
// For a set of trade JSONs (status quo OR a giveback-protective variant) it
// reports the distribution that actually matters for a small account:
//   P(ruin)        — fraction of resampled lives that hit the margin floor
//   final $ p10/50/90
//   maxDD%  p50/p90
//   microDD% p90   — drawdown while account is still small (< $25k)
//
// Selection rule (survival first):
//   1. reject if P(ruin) > ruinTol            (default 1%)
//   2. reject if microDD p90 > microDDCeiling (default 35%)
//   3. among survivors, maximize median final $ (growth, drawdown already capped)
//
// Usage:
//   node bootstrap-survival.js                       # status-quo gold JSONs
//   node bootstrap-survival.js --files a.json,b.json,c.json,d.json
//   node bootstrap-survival.js --n 5000 --days 330 --seed 7
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fmtETDate } from '../multi-strategy-rules/lib/et-time.js';
import { simulate, loadTrades, STRATEGIES, CFG, LADDER } from './run-real-account.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function argNum(f, d) { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; }
function argStr(f, d) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; }

const N      = argNum('--n', 3000);
const NDAYS  = argNum('--days', 330);   // ~16 months of trading days
let   SEED   = argNum('--seed', 12345);
const FILES  = argStr('--files', null); // comma list to override the 4 gold JSONs

// Deterministic PRNG (mulberry32) — reproducible without Date/Math.random.
function rng() { SEED |= 0; SEED = SEED + 0x6D2B79F5 | 0; let t = Math.imul(SEED ^ SEED >>> 15, 1 | SEED); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

// Ladder presets — the survival lever. All MNQ-only variants avoid the jump to
// full NQ (10× notional) that spikes per-trade risk. "current" = the dashboard
// ladder. Higher $/contract = more conservative = smaller drawdown, slower growth.
const LADDERS = {
  current: LADDER,                                  // dashboard model (1→8 MNQ, then 1–10 NQ)
  // half-aggressive: same shape, ~2× the balance required per size step.
  gentle: [
    [2000, 1, 0], [6000, 2, 0], [11000, 3, 0], [18000, 5, 0], [28000, 8, 0],
    [50000, 0, 1], [90000, 0, 2], [140000, 0, 3], [200000, 0, 4], [280000, 0, 5],
    [400000, 0, 7], [600000, 0, 10],
  ],
  // conservative MNQ-only: 1 MNQ per ~$2.5k of balance, capped at 20 MNQ (never NQ).
  mnq_linear: null, // computed below
  // very conservative: 1 MNQ per ~$5k, capped 12.
  mnq_slow: null,
};
const LADDER_NAME = argStr('--ladder', 'current');
const MNQ_PER  = argNum('--mnq-per', 1000);
const MNQ_CAP  = argNum('--mnq-cap', 20);
const FIXED_MNQ = argNum('--fixed-mnq', 1);

function ladderForBalance(balance) {
  // Parametric MNQ-only ladder: 1 MNQ per $MNQ_PER of balance, capped MNQ_CAP.
  // e.g. --mnq-per 500 → 2 MNQ at $1k, 4 at $2k. --mnq-per 1000 → 1 at $1k.
  if (LADDER_NAME === 'mnq_per') {
    const n = Math.min(MNQ_CAP, Math.max(1, Math.floor(balance / MNQ_PER)));
    return { n: Math.min(n, Math.floor(balance / CFG.marginMNQ)), pv: CFG.mnqPointValue, comm: CFG.commMNQ };
  }
  // Fixed contract count at all balances (margin-capped). --fixed-mnq 3
  if (LADDER_NAME === 'fixed_mnq') {
    return { n: Math.min(FIXED_MNQ, Math.floor(balance / CFG.marginMNQ)), pv: CFG.mnqPointValue, comm: CFG.commMNQ };
  }
  // Linear MNQ-only ladders.
  if (LADDER_NAME === 'mnq_linear') {
    const n = Math.min(20, Math.max(1, Math.floor(balance / 2500)));
    return { n: Math.min(n, Math.floor(balance / CFG.marginMNQ)), pv: CFG.mnqPointValue, comm: CFG.commMNQ };
  }
  if (LADDER_NAME === 'mnq_slow') {
    const n = Math.min(12, Math.max(1, Math.floor(balance / 5000)));
    return { n: Math.min(n, Math.floor(balance / CFG.marginMNQ)), pv: CFG.mnqPointValue, comm: CFG.commMNQ };
  }
  const L = LADDERS[LADDER_NAME] || LADDER;
  let nMnq = 1, nNq = 0;
  for (let i = L.length - 1; i >= 0; i--) {
    if (balance >= L[i][0]) { nMnq = L[i][1]; nNq = L[i][2]; break; }
  }
  if (nNq > 0) return { n: Math.min(nNq, Math.floor(balance / CFG.marginNQ)), pv: CFG.nqPointValue, comm: CFG.commNQ };
  return { n: Math.min(nMnq, Math.floor(balance / CFG.marginMNQ)), pv: CFG.mnqPointValue, comm: CFG.commMNQ };
}

// Build day kernels from a config's accepted trades: each day → ordered list of
// per-contract gross points. (Daily rules + FCFS already applied by simulate.)
function dayKernels(res) {
  const m = new Map();
  for (const t of res.realized) {
    const d = fmtETDate(t.exitTime);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(t.pointsPnL);
  }
  return [...m.values()]; // array of arrays (one per day)
}

// One bootstrapped life: NDAYS resampled days replayed through the ladder.
function oneLife(kernels) {
  let balance = CFG.startBalance, peak = balance, maxDD = 0, microDD = 0, ruined = false;
  for (let d = 0; d < NDAYS; d++) {
    const day = kernels[(rng() * kernels.length) | 0];
    for (const pts of day) {
      const lot = ladderForBalance(balance);
      if (lot.n < 1) { ruined = true; break; }
      balance += pts * lot.pv * lot.n - lot.comm * lot.n;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak;
      if (dd > maxDD) maxDD = dd;
      if (peak < 25000 && dd > microDD) microDD = dd;
      if (balance < CFG.marginMNQ) { ruined = true; break; }
    }
    if (ruined) break;
  }
  return { balance: ruined ? 0 : balance, maxDD, microDD, ruined };
}

function pct(arr, p) { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }

function evaluate(label, trades) {
  const res = simulate(trades, CFG);                 // historical ordering (rules off here)
  const kernels = dayKernels(res);
  const lives = [];
  for (let i = 0; i < N; i++) lives.push(oneLife(kernels));
  const ruinRate = lives.filter(l => l.ruined).length / N;
  const finals = lives.map(l => l.balance);
  const maxDDs = lives.map(l => l.maxDD);
  const micros = lives.map(l => l.microDD);
  return {
    label, histFinal: res.balance, histBlown: res.blown, nDays: kernels.length,
    ruinRate,
    finalP10: pct(finals, 0.10), finalP50: pct(finals, 0.50), finalP90: pct(finals, 0.90),
    maxDDp50: pct(maxDDs, 0.50), maxDDp90: pct(maxDDs, 0.90),
    microP90: pct(micros, 0.90),
  };
}

// Allow custom daily-rule config via env-ish flags reused from run-real-account CFG.
const RULES = {
  givebackLock: argNum('--giveback-lock', 0),
  givebackArm:  argNum('--giveback-arm', 0),
  dailyLossLimit: argNum('--daily-loss', 0),
};

function evaluateWithRules(label, trades) {
  const res = simulate(trades, { ...CFG, ...RULES });
  const kernels = dayKernels(res);
  const lives = [];
  for (let i = 0; i < N; i++) lives.push(oneLife(kernels));
  const ruinRate = lives.filter(l => l.ruined).length / N;
  const finals = lives.map(l => l.balance);
  const maxDDs = lives.map(l => l.maxDD);
  const micros = lives.map(l => l.microDD);
  return {
    label, histFinal: res.balance, histBlown: res.blown, nDays: kernels.length, ruinRate,
    finalP10: pct(finals, 0.10), finalP50: pct(finals, 0.50), finalP90: pct(finals, 0.90),
    maxDDp50: pct(maxDDs, 0.50), maxDDp90: pct(maxDDs, 0.90), microP90: pct(micros, 0.90),
  };
}

function fmt(r) {
  const usd = n => '$' + Math.round(n).toLocaleString();
  return [
    r.label.padEnd(26),
    ((100 * r.ruinRate).toFixed(1) + '%').padStart(7),
    usd(r.finalP10).padStart(11),
    usd(r.finalP50).padStart(12),
    usd(r.finalP90).padStart(13),
    ((100 * r.maxDDp50).toFixed(0) + '%').padStart(7),
    ((100 * r.maxDDp90).toFixed(0) + '%').padStart(7),
    ((100 * r.microP90).toFixed(0) + '%').padStart(8),
  ].join('  ');
}

function main() {
  let trades;
  if (FILES) {
    trades = [];
    for (const f of FILES.split(',')) {
      const raw = JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8'));
      const key = path.basename(f).replace('.json', '');
      for (const t of raw.trades) {
        if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null) continue;
        const side = String(t.side || '').toLowerCase();
        const sn = (side === 'long' || side === 'buy') ? 'long' : (side === 'short' || side === 'sell') ? 'short' : null;
        if (!sn) continue;
        const exitTime = (t.exitTime <= t.entryTime) ? t.entryTime + 1 : t.exitTime;
        trades.push({ strategyKey: key, side: sn, entryTime: t.entryTime, exitTime,
          pointsPnL: t.pointsPnL, mfePoints: t.mfePoints ?? 0, maePoints: t.maePoints ?? 0,
          stopPts: (t.entryPrice != null && t.stopLoss != null) ? Math.abs(t.entryPrice - t.stopLoss) : null });
      }
    }
  } else {
    trades = [];
    for (const def of STRATEGIES) trades.push(...loadTrades(def));
  }

  console.log(`\n══════ Bootstrap survival — $${CFG.startBalance} laddered MNQ account ══════`);
  console.log(`   ${N} resampled lives × ${NDAYS} trading days · day-kernel resample\n`);
  console.log([
    'config'.padEnd(26), 'P(ruin)'.padStart(7), 'final p10'.padStart(11),
    'final p50'.padStart(12), 'final p90'.padStart(13), 'DD p50'.padStart(7), 'DD p90'.padStart(7), 'microP90'.padStart(8),
  ].join('  '));
  console.log('─'.repeat(100));

  const hasRules = RULES.givebackLock > 0 || RULES.dailyLossLimit > 0;
  const label = FILES ? 'custom' : 'status-quo gold';
  console.log(fmt(hasRules ? evaluateWithRules(label + (hasRules ? ' +rules' : ''), trades) : evaluate(label, trades)));
  console.log();
}

main();

export { evaluate, evaluateWithRules, oneLife, dayKernels };
