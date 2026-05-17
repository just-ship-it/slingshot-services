/**
 * GEX-Touch Patterns — Phase 5: rulebook serial simulator.
 *
 * Define a rulebook = array of cells: { pattern, levelTypes, target, [tod, regime] }.
 * For each trigger, if it matches any cell, use that cell's target to look up
 * the outcome from `ladder_outcomes`. Walk in time order, enforce concurrency.
 *
 * Usage:
 *   node research/gex-touch-patterns/05-rulebook-sim.js \
 *     --in research/output/gex-touch-patterns-base-<TS>.json \
 *     [--rulebook best_v1 | high_wr | aggressive]
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
const RULEBOOK = arg('rulebook', 'best_v1');
// Engine slippage defaults: limit=0.25, market=1.0, stop=1.5
// We model stop_loss slippage as additional pts on the loss side.
const STOP_SLIPPAGE = Number(arg('stop-slippage', 1.5));   // pts
const MARKET_SLIPPAGE = Number(arg('market-slippage', 1.0));  // pts on entry
const COMMISSION_PER_TRADE = Number(arg('commission', 5));    // $ per side ($5/contract = $10 round trip)

const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { triggers } = data;
const LADDER = triggers[0]?.target_ladder || [20, 30, 40, 50, 60, 80, 100];

// Rulebooks: { pattern, levels: string[] | '*', target: number, [tods?, regimes?] }
const RULEBOOKS = {
  // best_v2: optimal per-cell with 4hr max-hold (built from Phase 4 stretch-240 analysis).
  // Each cell uses the target that maximizes $ for that (pattern, level) combo
  // while keeping PF ≥ 1.3.
  'best_v2': [
    // A1 (acceptance LONG of resistance break)
    { pattern: 'A1', levels: ['gamma_flip'], target: 40 },     // 45% WR, PF 2.71, +$40k
    { pattern: 'A1', levels: ['R2'], target: 30 },             // 53% WR, PF 2.49, +$24k
    { pattern: 'A1', levels: ['call_wall','R1'], target: 50 }, // 30% WR, PF 1.83, +$22k
    // A2 (acceptance SHORT of support break)
    { pattern: 'A2', levels: ['S5'], target: 100 },            // 30% WR, PF 2.60, +$32k
    { pattern: 'A2', levels: ['S4'], target: 100 },            // 23% WR, PF 1.93, +$23k
    { pattern: 'A2', levels: ['S3'], target: 40 },             // 39% WR, PF 1.39, +$14k
    { pattern: 'A2', levels: ['gamma_flip'], target: 50 },     // 28% WR, PF 1.32, +$11k
    { pattern: 'A2', levels: ['S2'], target: 30 },             // 51% WR, PF 1.63, +$11k
    // R1 (rejection LONG off support)
    { pattern: 'R1', levels: ['S2','S3'], target: 20 },        // 62-64% WR, PF 1.84-2.28, +$13k each
    { pattern: 'R1', levels: ['S4'], target: 80 },             // 27% WR, PF 1.58, +$9k
    { pattern: 'R1', levels: ['put_wall','S1'], target: 40 },  // 43% WR, PF 1.44, +$11k
    // R2 (rejection SHORT off resistance) — biggest hitters
    { pattern: 'R2', levels: ['call_wall','R1'], target: 150 },// 23% WR, PF 2.54, +$62k ⭐
    { pattern: 'R2', levels: ['gamma_flip'], target: 100 },    // 24% WR, PF 2.08, +$37k ⭐
    { pattern: 'R2', levels: ['R4'], target: 40 },             // 43% WR, PF 1.72, +$15k
    { pattern: 'R2', levels: ['R5'], target: 60 },             // 26% WR, PF 1.55, +$12k
    // R3 (pin + confirm)
    { pattern: 'R3', levels: ['R5'], target: 40 },             // 35% WR, PF 1.95, +$20k
    { pattern: 'R3', levels: ['S2'], target: 80 },             // 21% WR, PF 1.32, +$23k
    { pattern: 'R3', levels: ['R2'], target: 40 },             // 29% WR, PF 1.46, +$14k
    { pattern: 'R3', levels: ['put_wall','S1'], target: 30 },  // 39% WR, PF 1.25, +$14k
  ],

  // best_v2_high_wr: subset of best_v2 with WR >= 35%
  'best_v2_high_wr': [
    { pattern: 'A1', levels: ['gamma_flip'], target: 40 },     // 45% WR
    { pattern: 'A1', levels: ['R2'], target: 30 },             // 53% WR
    { pattern: 'A2', levels: ['S3'], target: 40 },             // 39% WR
    { pattern: 'A2', levels: ['S2'], target: 30 },             // 51% WR
    { pattern: 'R1', levels: ['S2','S3'], target: 20 },        // 62-64% WR
    { pattern: 'R1', levels: ['put_wall','S1'], target: 40 },  // 43% WR
    { pattern: 'R2', levels: ['R4'], target: 40 },             // 43% WR
    { pattern: 'R3', levels: ['put_wall','S1'], target: 30 },  // 39% WR
    { pattern: 'R3', levels: ['R5'], target: 40 },             // 35% WR
  ],

  // best_v3: per-cell optimal target capped at 50pt. Faster trade resolution,
  // less concurrency lockout, hopefully more total throughput.
  'best_v3_fast': [
    { pattern: 'A1', levels: ['gamma_flip'], target: 40 },
    { pattern: 'A1', levels: ['R2'], target: 30 },
    { pattern: 'A1', levels: ['call_wall','R1'], target: 50 },
    { pattern: 'A2', levels: ['S3'], target: 40 },
    { pattern: 'A2', levels: ['S2'], target: 30 },
    { pattern: 'A2', levels: ['gamma_flip'], target: 50 },
    { pattern: 'R1', levels: ['S2','S3'], target: 20 },
    { pattern: 'R1', levels: ['put_wall','S1'], target: 40 },
    { pattern: 'R2', levels: ['call_wall','R1'], target: 40 },  // smaller than the 150pt cell, faster
    { pattern: 'R2', levels: ['gamma_flip'], target: 30 },
    { pattern: 'R2', levels: ['R4'], target: 40 },
    { pattern: 'R3', levels: ['R5'], target: 40 },
    { pattern: 'R3', levels: ['put_wall','S1'], target: 30 },
    { pattern: 'R3', levels: ['R2'], target: 40 },
  ],

  // Mix of v2_big and v3_fast — prioritize fast rules first to fill the
  // concurrency window with rapid trades, fall back to big-target on remaining
  'best_v4_hybrid': [
    // Fast layer first (matched first)
    { pattern: 'R1', levels: ['S2','S3'], target: 20 },                 // 60+% WR fast
    { pattern: 'R2', levels: ['call_wall','R1'], target: 20 },          // 62% WR fast
    { pattern: 'A1', levels: ['R2'], target: 20 },                      // 62% WR fast
    { pattern: 'R1', levels: ['put_wall','S1'], target: 30 },           // 50% WR
    { pattern: 'A2', levels: ['S2','S5'], target: 30 },                 // 50%+ WR
    { pattern: 'R1', levels: ['S4'], target: 30 },                      // medium
    { pattern: 'A1', levels: ['gamma_flip'], target: 30 },              // 53% WR @ 30 target
    { pattern: 'R2', levels: ['gamma_flip'], target: 30 },              // medium
    { pattern: 'R2', levels: ['R4'], target: 40 },
    { pattern: 'R3', levels: ['R5'], target: 40 },
    { pattern: 'R3', levels: ['put_wall','S1'], target: 30 },
    { pattern: 'R3', levels: ['R2'], target: 40 },
    { pattern: 'A2', levels: ['S3'], target: 40 },
  ],

  // High-WR-first: prioritize 60%+ WR cells, fast targets, so concurrency
  // gets eaten by quick trades that leave room for more.
  'hi_wr_first': [
    { pattern: 'R1', levels: ['S2','S3'], target: 20 },          // 60-64% WR
    { pattern: 'R2', levels: ['call_wall','R1'], target: 20 },   // 62% WR
    { pattern: 'A1', levels: ['R2'], target: 20 },               // 62.7% WR
    { pattern: 'A1', levels: ['gamma_flip'], target: 30 },       // 53% WR
    { pattern: 'R1', levels: ['put_wall','S1'], target: 30 },    // 50% WR
    { pattern: 'A2', levels: ['S2'], target: 30 },               // 51% WR
    { pattern: 'A2', levels: ['S5'], target: 30 },               // 50% WR
    { pattern: 'R1', levels: ['S4'], target: 20 },               // 57% WR
    { pattern: 'R2', levels: ['R4'], target: 30 },               // 43% WR
    { pattern: 'A1', levels: ['call_wall','R1'], target: 30 },   // medium
    { pattern: 'R2', levels: ['gamma_flip'], target: 30 },       // 46% WR @ 30
    { pattern: 'A2', levels: ['S3'], target: 30 },               // 39% WR
    { pattern: 'R3', levels: ['R5'], target: 30 },               // medium
    { pattern: 'R3', levels: ['put_wall','S1'], target: 30 },    // 39% WR
  ],
  // High-WR only — strict 60%+ cells
  'hi_wr_strict': [
    { pattern: 'R1', levels: ['S2','S3'], target: 20 },
    { pattern: 'R2', levels: ['call_wall','R1'], target: 20 },
    { pattern: 'A1', levels: ['R2'], target: 20 },
  ],

  // best_v2_big_targets: include only big-target high-R:R cells
  'best_v2_big_targets': [
    { pattern: 'A1', levels: ['gamma_flip'], target: 40 },
    { pattern: 'A1', levels: ['call_wall','R1'], target: 50 },
    { pattern: 'A2', levels: ['S5'], target: 100 },
    { pattern: 'A2', levels: ['S4'], target: 100 },
    { pattern: 'R1', levels: ['S4'], target: 80 },
    { pattern: 'R2', levels: ['call_wall','R1'], target: 150 },
    { pattern: 'R2', levels: ['gamma_flip'], target: 100 },
    { pattern: 'R2', levels: ['R5'], target: 60 },
    { pattern: 'R3', levels: ['S2'], target: 80 },
  ],
  // v1: top per-cell (pattern, level) combos selected from Phase 4 analysis
  // — restricted to cells with PF ≥ 1.4 and n ≥ 80 at the chosen target.
  'best_v1': [
    { pattern: 'A1', levels: ['gamma_flip'], target: 40 },     // 40.5% WR, PF 2.21, +$27k
    { pattern: 'A1', levels: ['R2'], target: 20 },             // 62.7% WR, PF 2.57, +$19k
    { pattern: 'A1', levels: ['call_wall','R1'], target: 50 }, // 28.6% WR, PF 1.67, +$17k (R1 here == call_wall)
    { pattern: 'A2', levels: ['S2'], target: 30 },             // 51.1% WR, PF 1.63, +$11k
    { pattern: 'A2', levels: ['S5'], target: 30 },             // 50.6% WR, PF 1.91, +$13k
    { pattern: 'A2', levels: ['S3'], target: 40 },             // 39.1% WR, PF 1.39, +$14k
    { pattern: 'A2', levels: ['S4'], target: 100 },            // 23.5% WR, PF 1.97, +$24k  (occasional 100pt move)
    { pattern: 'R1', levels: ['S2','S3','S4'], target: 20 },   // R1 strong on numbered supports
    { pattern: 'R1', levels: ['put_wall','S1'], target: 30 },  // 50.5% WR, PF 1.47, +$10k
    { pattern: 'R2', levels: ['call_wall','R1'], target: 20 }, // 62% WR, PF 2.05, +$19k
    { pattern: 'R2', levels: ['gamma_flip'], target: 30 },     // 46.2% WR, PF 1.79, +$22k
    { pattern: 'R2', levels: ['R4'], target: 40 },             // 39.4% WR, PF 1.46, +$10k
    { pattern: 'R3', levels: ['R5'], target: 40 },             // 31.7% WR, PF 1.71, +$15k
  ],
  // High WR only — sacrifice volume for psychological consistency
  'high_wr': [
    { pattern: 'A1', levels: ['R2'], target: 20 },
    { pattern: 'A2', levels: ['S2','S5'], target: 30 },
    { pattern: 'R1', levels: ['S2','S3','S4','put_wall','S1'], target: 20 },
    { pattern: 'R2', levels: ['call_wall','R1'], target: 20 },
  ],
  // Aggressive — include modest-edge cells too
  'aggressive': [
    { pattern: 'A1', levels: '*', target: 40 },
    { pattern: 'A2', levels: '*', target: 40 },
    { pattern: 'R1', levels: '*', target: 20 },
    { pattern: 'R2', levels: '*', target: 20 },
  ],
  // R1+R2 only with sweet-spot levels
  'r1r2_tight': [
    { pattern: 'R1', levels: ['S2','S3','S4'], target: 20 },
    { pattern: 'R2', levels: ['call_wall','R1','gamma_flip','R4'], target: 20 },
  ],
  // Long-only
  'longs_only': [
    { pattern: 'A1', levels: ['gamma_flip'], target: 40 },
    { pattern: 'A1', levels: ['R2'], target: 20 },
    { pattern: 'R1', levels: ['S2','S3','S4'], target: 20 },
    { pattern: 'R1', levels: ['put_wall','S1'], target: 30 },
  ],
  // Short-only
  'shorts_only': [
    { pattern: 'A2', levels: ['S2','S5'], target: 30 },
    { pattern: 'A2', levels: ['S3'], target: 40 },
    { pattern: 'A2', levels: ['S4'], target: 100 },
    { pattern: 'R2', levels: ['call_wall','R1','gamma_flip','R4'], target: 20 },
  ],
};

if (!RULEBOOKS[RULEBOOK]) {
  console.error(`Unknown rulebook "${RULEBOOK}". Available: ${Object.keys(RULEBOOKS).join(', ')}`);
  process.exit(1);
}
const rules = RULEBOOKS[RULEBOOK];
console.log(`\n=== Phase 5: Rulebook serial sim — "${RULEBOOK}" ===`);
console.log(`Rules: ${rules.length}`);

// Match trigger to a rule. Returns { target, ruleIdx } or null.
function matchRule(t) {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.pattern !== t.pattern) continue;
    if (r.levels !== '*' && !r.levels.includes(t.level_type)) continue;
    if (r.tods && !r.tods.includes(t.tod)) continue;
    if (r.regimes && !r.regimes.includes(t.regime)) continue;
    return { target: r.target, ruleIdx: i };
  }
  return null;
}

// For each trigger, check rule match. Compute its outcome at the rule's target.
function evalTrigger(t) {
  const m = matchRule(t);
  if (!m) return null;
  const k = LADDER.indexOf(m.target);
  if (k < 0) return null;
  const out = t.ladder_outcomes[k];
  // Determine exit_ts for this target
  let exitTs;
  if (out === 'win') exitTs = t.ladder_hit_ts[k];
  else if (out === 'loss') exitTs = t.stopped_at;
  else exitTs = t.exit_ts;
  return { ...t, eff_target: m.target, eff_outcome: out, eff_exit_ts: exitTs, eff_pts: out === 'win' ? m.target : (out === 'loss' ? -t.stop_distance : 0), ruleIdx: m.ruleIdx };
}

// Two pass:
//  1. Per touch_ts, find FIRST matching trigger (earliest trigger_ts) — that's
//     what the engine would actually take per touch.
//  2. Then serialize globally — no concurrent positions across touches.
const byTouchTs = new Map();
for (const t of triggers) {
  const ev = evalTrigger(t);
  if (!ev) continue;
  const key = t.touch_ts;
  if (!byTouchTs.has(key)) byTouchTs.set(key, []);
  byTouchTs.get(key).push(ev);
}
const firstPerTouch = [];
for (const arr of byTouchTs.values()) {
  arr.sort((a, b) => a.trigger_ts - b.trigger_ts);
  firstPerTouch.push(arr[0]);
}
firstPerTouch.sort((a, b) => a.trigger_ts - b.trigger_ts);

console.log(`Touches with at least one matching trigger: ${firstPerTouch.length}`);

// Serial concurrency
let busyUntil = 0;
const accepted = [];
let concSkipped = 0;
for (const t of firstPerTouch) {
  if (t.trigger_ts < busyUntil) { concSkipped++; continue; }
  accepted.push(t);
  // strategy busy until exit_ts (or +60min default if missing)
  busyUntil = t.eff_exit_ts || (t.trigger_ts + 60 * 60 * 1000);
}

console.log(`Accepted after serial concurrency: ${accepted.length}`);
console.log(`Concurrency-skipped: ${concSkipped}\n`);

// Metrics — apply slippage model:
//   • Entry: subtract MARKET_SLIPPAGE pts on every trade (market entry)
//   • Loss: subtract STOP_SLIPPAGE pts (stop fills worse than stop_price)
//   • Win: limit at target, no slippage
//   • Commission: subtract per side
let w = 0, l = 0, other = 0;
let sumPts = 0, winsPts = 0, lossPts = 0;
const equity = [];
let cum = 0;
for (const t of accepted) {
  let net;
  if (t.eff_outcome === 'win') {
    w++;
    net = t.eff_target - MARKET_SLIPPAGE;          // win with entry slippage
    winsPts += t.eff_target;
  } else if (t.eff_outcome === 'loss') {
    l++;
    net = -(t.stop_distance + STOP_SLIPPAGE + MARKET_SLIPPAGE);   // loss + stop+entry slip
    lossPts += t.stop_distance + STOP_SLIPPAGE;
  } else {
    other++;
    net = -MARKET_SLIPPAGE;                         // timeout/eod = at-cost exit
  }
  sumPts += net;
  cum += net;
  equity.push({ ts: t.trigger_ts, pts: net, cum });
}
const decided = w + l;
const wr = decided ? w / decided : null;
const pf = lossPts ? winsPts / lossPts : (winsPts ? Infinity : 0);
const ev = accepted.length ? sumPts / accepted.length : 0;

let peak = 0, maxDD = 0;
for (const e of equity) {
  if (e.cum > peak) peak = e.cum;
  const dd = peak - e.cum;
  if (dd > maxDD) maxDD = dd;
}
// Sharpe (annualized)
let varSum = 0;
for (const e of equity) varSum += (e.pts - ev) ** 2;
const sd = equity.length ? Math.sqrt(varSum / equity.length) : 0;
const sharpe = sd > 0 ? ev / sd : 0;
const tradesPerYear = (accepted.length / 16) * 12;
const sharpeAnnual = sharpe * Math.sqrt(tradesPerYear);

const totalCommission = accepted.length * COMMISSION_PER_TRADE * 2;  // round-trip
const netDollars = sumPts * 20 - totalCommission;
console.log(`=== Rulebook "${RULEBOOK}" overall (slippage: stop=${STOP_SLIPPAGE}, market=${MARKET_SLIPPAGE}, commission=$${COMMISSION_PER_TRADE}/side) ===`);
console.log(`Trades:             ${accepted.length}`);
console.log(`WR (decided):       ${wr != null ? (wr * 100).toFixed(1) + '%' : '-'}`);
console.log(`Wins / Losses:      ${w} / ${l}`);
console.log(`Timeouts/EOD/Rov:   ${other}`);
console.log(`PF:                 ${isFinite(pf) ? pf.toFixed(2) : '∞'}`);
console.log(`EV / trade:         ${ev.toFixed(2)} pts = $${(ev*20).toFixed(0)}`);
console.log(`Per-trade Sharpe:   ${sharpe.toFixed(3)}`);
console.log(`Annualized Sh:      ${sharpeAnnual.toFixed(2)}`);
console.log(`Total points:       ${Math.round(sumPts).toLocaleString()}`);
console.log(`Gross $ (1 ctr):    $${(sumPts * 20).toLocaleString()}`);
console.log(`Commission ($5/sd): -$${totalCommission.toLocaleString()}`);
console.log(`Net $ (1 ctr):      $${netDollars.toLocaleString()}`);
console.log(`Max drawdown:       ${Math.round(maxDD)} pts = $${(maxDD * 20).toLocaleString()}`);

// Per-rule breakdown
console.log('\nPer-rule breakdown:');
console.log('rule  pattern  levels                       target  n     W   L  WR     PF     pts    $');
for (let i = 0; i < rules.length; i++) {
  const r = rules[i];
  const arr = accepted.filter(t => t.ruleIdx === i);
  if (arr.length === 0) continue;
  let ww = 0, ll = 0, wp = 0, lp = 0, pts = 0;
  for (const t of arr) {
    if (t.eff_outcome === 'win') { ww++; wp += t.eff_target; pts += t.eff_target; }
    else if (t.eff_outcome === 'loss') { ll++; lp += t.stop_distance; pts -= t.stop_distance; }
  }
  const dec = ww + ll;
  const lwr = dec ? ww / dec : null;
  const lpf = lp ? wp / lp : (wp ? Infinity : 0);
  const lev = r.levels === '*' ? '*' : r.levels.join(',');
  console.log(`${String(i+1).padStart(2)}    ${r.pattern.padEnd(8)} ${lev.padEnd(28)} ${String(r.target).padStart(6)}  ${String(arr.length).padStart(5)} ${String(ww).padStart(3)} ${String(ll).padStart(3)} ${(lwr != null ? (lwr*100).toFixed(1)+'%' : '-').padStart(6)} ${(isFinite(lpf) ? lpf.toFixed(2) : '∞').padStart(6)} ${String(Math.round(pts)).padStart(6)} $${String(Math.round(pts*20)).padStart(7)}`);
}

// Per-month
const byMonth = new Map();
for (const e of equity) {
  const d = new Date(e.ts);
  const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  byMonth.set(k, (byMonth.get(k) || 0) + e.pts);
}
console.log('\nMonthly P&L:');
for (const m of [...byMonth.keys()].sort()) {
  const p = byMonth.get(m);
  const sign = p < 0 ? '-' : '+';
  const bar = (p < 0 ? '-' : '|').repeat(Math.min(40, Math.floor(Math.abs(p) / 20)));
  console.log(`  ${m}  ${String(Math.round(p)).padStart(5)}pts  $${String(Math.round(p * 20)).padStart(6)}  ${sign} ${bar}`);
}

// Save
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(ROOT, 'research', 'output', `gex-touch-patterns-rulebook-${RULEBOOK}-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  rulebook: RULEBOOK, rules,
  metrics: { trades: accepted.length, wins: w, losses: l, other, wr, pf, ev, sumPts, sharpe, sharpeAnnual, maxDD, concSkipped },
  trades: accepted.map(t => ({ ts: t.trigger_ts, pattern: t.pattern, level_type: t.level_type, direction: t.direction, target: t.eff_target, outcome: t.eff_outcome, pts: t.eff_pts, stop_distance: t.stop_distance })),
}, null, 2));
console.log(`\nWritten: ${outPath}`);
