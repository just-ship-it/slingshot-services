#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Sweep daily give-back lock + daily loss limit on the REAL-ACCOUNT model.
//
// Question this answers: "Up to +$1,500 by late morning, then it gives it all
// back shorting the uptrend." A give-back lock stops the day once you've handed
// back X points from the day's peak; a loss limit stops the day at −Y points.
// We sweep both (in POINTS, size-agnostic so they hold as the ladder scales) and
// rank by survival-adjusted outcome on the $1,500 laddered MNQ account.
//
// Metrics per config:
//   final$        — ending balance ($1,500 start)
//   maxDD%        — worst peak→trough on the realized equity curve
//   microDD%      — worst drawdown WHILE peak < $25k (the fragile phase)
//   give$         — favorable excursion handed back (1-MNQ floor, comparable)
//   lock/loss days— how many days each rule fired
//
// Usage: node sweep-daily-rules.js
// ─────────────────────────────────────────────────────────────────────────────

import { simulate, loadTrades, summarize, STRATEGIES, CFG } from './run-real-account.js';
import { fmtUsd, round } from '../multi-strategy-rules/lib/metrics.js';
import { fmtETDate } from '../multi-strategy-rules/lib/et-time.js';

const all = [];
for (const def of STRATEGIES) all.push(...loadTrades(def));

// Re-derive micro-phase drawdown (peak < $25k) from a run's realized trades.
function microPhaseDD(res) {
  let peak = res.cfg.startBalance, worst = 0;
  for (const t of res.realized) {
    const b = t.balanceAfter;
    if (b > peak) peak = b;
    if (peak < 25000) { const ddp = (peak - b) / peak; if (ddp > worst) worst = ddp; }
  }
  return worst;
}

// Grid. givebackLock in points (retrace from day peak). dailyLoss in points.
// givebackArm = day must first be up this many points before the lock can fire.
const GIVEBACK_LOCKS = [0, 15, 25, 40, 60, 80, 120];   // 0 = disabled
const GIVEBACK_ARMS  = [20, 40, 60];
const DAILY_LOSSES   = [0, 40, 60, 100, 150];          // 0 = disabled

const rows = [];

// Baseline (no daily rules).
{
  const res = simulate(all, { ...CFG, givebackLock: 0, dailyLossLimit: 0 });
  const s = summarize(res);
  rows.push({ label: 'baseline (no rules)', gl: 0, ga: 0, dl: 0, res, s });
}

for (const gl of GIVEBACK_LOCKS) {
  for (const ga of (gl > 0 ? GIVEBACK_ARMS : [0])) {
    for (const dl of DAILY_LOSSES) {
      if (gl === 0 && dl === 0) continue; // == baseline
      const res = simulate(all, { ...CFG, givebackLock: gl, givebackArm: ga, dailyLossLimit: dl });
      const s = summarize(res);
      rows.push({ label: `gl=${gl}/arm${ga} dl=${dl}`, gl, ga, dl, res, s });
    }
  }
}

function fmtRow(r) {
  const blown = r.res.blown ? `☠${r.res.blown.date}` : 'ok';
  return [
    r.label.padEnd(22),
    blown.padEnd(12),
    fmtUsd(r.res.balance).padStart(12),
    (round(100 * r.res.maxDDpct, 1) + '%').padStart(8),
    (round(100 * microPhaseDD(r.res), 1) + '%').padStart(8),
    String(r.s.trades).padStart(6),
    String(round(r.s.pf, 2)).padStart(6),
    fmtUsd(r.res.givebackUsd).padStart(11),
    (r.res.lockedDays + '/' + r.res.lossLimitDays).padStart(9),
  ].join('  ');
}

console.log('\n════════════════════ Daily-rule sweep — REAL $1,500 account ════════════════════\n');
console.log([
  'config'.padEnd(22), 'survive'.padEnd(12), 'final$'.padStart(12), 'maxDD%'.padStart(8),
  'microDD'.padStart(8), 'trades'.padStart(6), 'PF'.padStart(6), 'giveback'.padStart(11), 'lk/ls dy'.padStart(9),
].join('  '));
console.log('─'.repeat(108));

// Print baseline first, then top configs by a survival-weighted score.
const baseline = rows[0];
console.log(fmtRow(baseline));
console.log('─'.repeat(108));

// Score: maximize final balance but penalize drawdown heavily (small account).
// score = log(final$) − 2·maxDD% − 1·microDD%   (only among survivors)
function score(r) {
  if (r.res.blown) return -Infinity;
  return Math.log(r.res.balance) - 2 * r.res.maxDDpct - 1 * microPhaseDD(r.res);
}
const ranked = rows.slice(1).filter(r => !r.res.blown).sort((a, b) => score(b) - score(a));

console.log('Top 15 by survival-weighted score (log final$ − 2·maxDD% − microDD%):\n');
for (const r of ranked.slice(0, 15)) console.log(fmtRow(r));

console.log('\nLowest max-drawdown survivors (any growth):\n');
for (const r of rows.slice(1).filter(r => !r.res.blown).sort((a, b) => a.res.maxDDpct - b.res.maxDDpct).slice(0, 8)) {
  console.log(fmtRow(r));
}

console.log('\nReference — baseline vs best-score:');
const best = ranked[0];
console.log(`  baseline : ${fmtUsd(baseline.res.balance)} · maxDD ${round(100 * baseline.res.maxDDpct, 1)}% · microDD ${round(100 * microPhaseDD(baseline.res), 1)}% · giveback ${fmtUsd(baseline.res.givebackUsd)}`);
console.log(`  best     : ${fmtUsd(best.res.balance)} · maxDD ${round(100 * best.res.maxDDpct, 1)}% · microDD ${round(100 * microPhaseDD(best.res), 1)}% · giveback ${fmtUsd(best.res.givebackUsd)}   [${best.label}]`);
console.log();
