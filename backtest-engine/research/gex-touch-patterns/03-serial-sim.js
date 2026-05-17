/**
 * GEX-Touch Patterns — Phase 3: serial simulator (engine-equivalent).
 *
 * Phase 2 counts every trigger as if concurrent — that overstates PnL because
 * a real strategy can only hold one position at a time. This script enforces
 * the same constraints the backtest engine + live strategy will:
 *   • One position at a time
 *   • Limit timeout / market entry timeout: 1 min from trigger (market entries
 *     are assumed to fill at trigger_ts immediately)
 *   • EOD cutoff already enforced in Phase 1 outcomes
 *
 * It takes a "ruleset" — list of (pattern, [optional level_type, regime, tod])
 * predicates — and walks triggers in time order, accepting only those that
 * pass the rules AND for which the strategy is currently idle.
 *
 * Usage:
 *   node research/gex-touch-patterns/03-serial-sim.js \
 *     --in research/output/gex-touch-patterns-base-<TS>.json \
 *     [--ruleset all-positive | r1r2 | wide]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}

const IN = arg('in');
if (!IN) { console.error('Missing --in'); process.exit(1); }
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
const RULESET = arg('ruleset', 'r1r2');

const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { triggers, config } = data;
const TARGET = config.TARGET_POINTS;

console.log(`\n=== Phase 3: Serial sim (input ${path.basename(inPath)}) ===`);
console.log(`Triggers: ${triggers.length.toLocaleString()}`);
console.log(`Ruleset: ${RULESET}\n`);

// Predicates. Each is a function (t) => boolean.
const RULESETS = {
  // All 4 positive-PF patterns, no filters
  'wide': (t) => ['R1', 'R2', 'A1', 'A2'].includes(t.pattern),
  // Only R1 + R2 (rejection setups)
  'r1r2': (t) => ['R1', 'R2'].includes(t.pattern),
  // Only A1 + A2 (acceptance setups)
  'a1a2': (t) => ['A1', 'A2'].includes(t.pattern),

  // Best-segment-only versions
  'r1_best': (t) => t.pattern === 'R1' && ['S2','S3','S4','S5'].includes(t.level_type),
  'r2_best': (t) => t.pattern === 'R2' && ['R1','R4','call_wall','gamma_flip'].includes(t.level_type),
  'a1_best': (t) => t.pattern === 'A1' && ['gamma_flip','R2'].includes(t.level_type),
  'a2_best': (t) => t.pattern === 'A2' && ['S3','S4','S5'].includes(t.level_type),

  // Combination of best segments across patterns
  'best_segments': (t) => {
    if (t.pattern === 'R1' && ['S2','S3','S4','S5'].includes(t.level_type)) return true;
    if (t.pattern === 'R2' && ['R1','R4','call_wall','gamma_flip'].includes(t.level_type)) return true;
    if (t.pattern === 'A1' && ['gamma_flip','R2'].includes(t.level_type)) return true;
    if (t.pattern === 'A2' && ['S3','S4','S5'].includes(t.level_type)) return true;
    return false;
  },

  // Morning-only restriction (best TOD across patterns)
  'morning_only': (t) => ['R1','R2','A1','A2'].includes(t.pattern) && t.tod === 'morning',

  // Avoid close_30 (consistently bad across patterns)
  'no_close30': (t) => ['R1','R2','A1','A2'].includes(t.pattern) && t.tod !== 'close_30',

  // Long-only and Short-only
  'longs': (t) => t.direction === 'long' && ['R1','A1'].includes(t.pattern),
  'shorts': (t) => t.direction === 'short' && ['R2','A2'].includes(t.pattern),

  // All 7 patterns
  'all': () => true,
};

if (!RULESETS[RULESET]) {
  console.error(`Unknown ruleset "${RULESET}". Available: ${Object.keys(RULESETS).join(', ')}`);
  process.exit(1);
}
const predicate = RULESETS[RULESET];

// Sort triggers by trigger_ts
const sorted = [...triggers].filter(predicate).sort((a, b) => a.trigger_ts - b.trigger_ts);
console.log(`Triggers passing predicate: ${sorted.length.toLocaleString()}\n`);

// Serial simulator
let busyUntil = 0;
const accepted = [];
let skipped = 0;

for (const t of sorted) {
  if (t.trigger_ts < busyUntil) { skipped++; continue; }
  accepted.push(t);

  // Determine when strategy becomes free again.
  // For win/loss/eod/timeout/rollover, use exit_ts. If missing, default to trigger_ts + max_hold.
  let busy;
  if (t.exit_ts) busy = t.exit_ts;
  else busy = t.trigger_ts + 60 * 60 * 1000;
  busyUntil = busy;
}

console.log(`Accepted: ${accepted.length.toLocaleString()}`);
console.log(`Skipped due to concurrency: ${skipped.toLocaleString()}\n`);

// Compute metrics on accepted
let wins = 0, losses = 0, timeouts = 0, eod = 0, rollover = 0;
let sumPts = 0;
let winsPts = 0, lossPts = 0;
const equity = [];
let cum = 0;
for (const t of accepted) {
  let pts = 0;
  if (t.outcome === 'win') { wins++; pts = TARGET; winsPts += TARGET; }
  else if (t.outcome === 'loss') { losses++; pts = -t.stop_distance; lossPts += t.stop_distance; }
  else if (t.outcome === 'timeout') timeouts++;
  else if (t.outcome === 'eod') eod++;
  else if (t.outcome === 'rollover') rollover++;
  cum += pts;
  equity.push({ ts: t.trigger_ts, pts, cum });
  sumPts += pts;
}

const decided = wins + losses;
const wr = decided ? wins / decided : null;
const pf = lossPts ? winsPts / lossPts : (wins ? Infinity : 0);
const ev = accepted.length ? sumPts / accepted.length : 0;

// DD
let peak = 0, maxDD = 0, ddStart = 0, maxDDStart = null, maxDDEnd = null;
for (const e of equity) {
  if (e.cum > peak) { peak = e.cum; ddStart = e.ts; }
  const dd = peak - e.cum;
  if (dd > maxDD) {
    maxDD = dd;
    maxDDStart = ddStart;
    maxDDEnd = e.ts;
  }
}

// Sharpe (per-trade pts)
let varSum = 0;
for (const e of equity) varSum += (e.pts - ev) ** 2;
const sd = equity.length ? Math.sqrt(varSum / equity.length) : 0;
const sharpe = sd > 0 ? ev / sd : 0;
// Annualized: assume 16 mo trade window
const tradesPerYear = (accepted.length / 16) * 12;
const annualReturn = sumPts * 20 * 12 / 16;  // $ at $20/pt over 12 mo from 16-mo total
// More honest annualized Sharpe: per-trade Sharpe × sqrt(tradesPerYear)
const sharpeAnnual = sharpe * Math.sqrt(tradesPerYear);

console.log(`=== Ruleset "${RULESET}" results ===`);
console.log(`Trades:           ${accepted.length}`);
console.log(`WR (decided):     ${wr != null ? (wr * 100).toFixed(1) + '%' : '-'}`);
console.log(`Wins / Losses:    ${wins} / ${losses}`);
console.log(`Timeouts:         ${timeouts}`);
console.log(`EOD:              ${eod}`);
console.log(`Rollovers:        ${rollover}`);
console.log(`PF:               ${isFinite(pf) ? pf.toFixed(2) : '∞'}`);
console.log(`EV / trade:       ${ev.toFixed(2)} pts`);
console.log(`Per-trade Sharpe: ${sharpe.toFixed(3)}`);
console.log(`Annualized Sh:    ${sharpeAnnual.toFixed(2)}`);
console.log(`Total points:     ${Math.round(sumPts).toLocaleString()}`);
console.log(`Total $ (1 ctr):  $${(sumPts * 20).toLocaleString()}`);
console.log(`Max drawdown:     ${Math.round(maxDD)} pts = $${(maxDD * 20).toLocaleString()}`);
if (maxDDStart) {
  console.log(`MaxDD period:     ${new Date(maxDDStart).toISOString()} → ${new Date(maxDDEnd).toISOString()}`);
}

// Per-pattern breakdown of accepted
const byPat = new Map();
for (const t of accepted) {
  if (!byPat.has(t.pattern)) byPat.set(t.pattern, []);
  byPat.get(t.pattern).push(t);
}
console.log('\nPer-pattern of accepted trades:');
console.log('pattern    n     W   L  WR     PF    pts    $');
for (const p of [...byPat.keys()].sort()) {
  const arr = byPat.get(p);
  let w = 0, l = 0, wp = 0, lp = 0, pts = 0;
  for (const t of arr) {
    if (t.outcome === 'win') { w++; wp += TARGET; pts += TARGET; }
    else if (t.outcome === 'loss') { l++; lp += t.stop_distance; pts -= t.stop_distance; }
  }
  const dec = w + l;
  const wr2 = dec ? w / dec : null;
  const pf2 = lp ? wp / lp : (wp ? Infinity : 0);
  console.log(`${p.padEnd(8)} ${String(arr.length).padStart(5)} ${String(w).padStart(4)} ${String(l).padStart(3)} ${(wr2 != null ? (wr2*100).toFixed(1)+'%' : '-').padStart(6)} ${(isFinite(pf2) ? pf2.toFixed(2) : '∞').padStart(5)} ${String(Math.round(pts)).padStart(6)} $${String(Math.round(pts*20)).padStart(6)}`);
}

// Per-month equity
const byMonth = new Map();
for (const e of equity) {
  const d = new Date(e.ts);
  const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  byMonth.set(k, (byMonth.get(k) || 0) + e.pts);
}
console.log('\nMonthly P&L:');
const months = [...byMonth.keys()].sort();
for (const m of months) {
  const p = byMonth.get(m);
  const bar = '|'.repeat(Math.min(20, Math.floor(Math.abs(p) / 20)));
  console.log(`  ${m}  ${String(Math.round(p)).padStart(5)}pts  $${String(Math.round(p * 20)).padStart(6)}  ${p < 0 ? '-' : '+'}${bar}`);
}

// Save accepted trades
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(ROOT, 'research', 'output', `gex-touch-patterns-serial-${RULESET}-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  ruleset: RULESET, config,
  metrics: { trades: accepted.length, wins, losses, timeouts, eod, rollover, wr, pf, ev, sumPts, sharpe, sharpeAnnual, maxDD, maxDDStart, maxDDEnd, skipped },
  trades: accepted.map(t => ({ ts: t.trigger_ts, pattern: t.pattern, level_type: t.level_type, direction: t.direction, outcome: t.outcome, pts: t.outcome === 'win' ? TARGET : (t.outcome === 'loss' ? -t.stop_distance : 0), stop_distance: t.stop_distance })),
}, null, 2));
console.log(`\nWritten: ${outPath}`);
