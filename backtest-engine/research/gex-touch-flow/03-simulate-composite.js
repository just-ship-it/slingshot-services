/**
 * GEX-Touch Flow — Phase 3: composite filter simulation with concurrency.
 *
 * Reads the Phase-1 dataset, applies a candidate filter rule, and simulates a
 * 1-position-at-a-time backtest using the per-touch forward-walk outcomes
 * already captured in Phase 1.
 *
 * Rule format (JSON file or inline string):
 *   {
 *     "direction": "bounce" | "break",
 *     "target_pts": 20,
 *     "stop_pts": 8,
 *     "max_hold_min": 15,
 *     "filters": [
 *       { "feature": "vol_ratio_5m", "op": ">=", "value": 1.5 },
 *       { "feature": "tod_bucket", "op": "in", "value": ["rth_morn", "rth_aft"] },
 *       { "feature": "s1_first_rejection_sec", "op": "!=", "value": null },
 *     ]
 *   }
 *
 * Slippage:
 *   - Entry market: 1pt + $5/side commission
 *   - Take profit (limit): 0pt slippage
 *   - Stop loss: 1.5pt slippage + $5/side commission
 *
 * Usage:
 *   node research/gex-touch-flow/03-simulate-composite.js \
 *     --in research/output/gex-touch-flow-<TS>.json \
 *     --rule '{"direction":"bounce","target_pts":20,"stop_pts":8,"max_hold_min":15,"filters":[...]}'
 *   OR
 *     --rule-file path/to/rule.json
 */

import fs from 'fs';
import path from 'path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN_PATH = arg('in', null);
if (!IN_PATH) { console.error('--in required'); process.exit(1); }
const RULE_STR = arg('rule', null);
const RULE_FILE = arg('rule-file', null);
const VERBOSE = process.argv.includes('--verbose');
let rule;
if (RULE_FILE) rule = JSON.parse(fs.readFileSync(RULE_FILE, 'utf-8'));
else if (RULE_STR) rule = JSON.parse(RULE_STR);
else { console.error('--rule or --rule-file required'); process.exit(1); }

const TARGET = rule.target_pts || 20;
const STOP = rule.stop_pts || 8;
const HOLD_MIN = rule.max_hold_min || 15;
const POINT_VALUE = 20;  // NQ $/pt
const ENTRY_SLIPPAGE = 1.0;
const STOP_SLIPPAGE = 1.5;
const COMMISSION = 5;  // per side

console.log(`\n=== GEX Touch Flow — Phase 3 (composite simulation) ===`);
console.log(`Input:    ${IN_PATH}`);
console.log(`Rule:     ${JSON.stringify(rule)}\n`);

const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;
console.log(`Loaded ${touches.length.toLocaleString()} touches\n`);

function flatten(t) {
  return {
    ...t.features,
    ...t.s1,
    s1_minute_vol_ratio: t.s1.s1_total_vol && t.features.vol_touch_bar ? t.s1.s1_total_vol / t.features.vol_touch_bar : null,
  };
}

function matchFilter(t, filt) {
  const f = flatten(t);
  for (const cond of (filt.filters || [])) {
    const v = f[cond.feature];
    switch (cond.op) {
      case '>': if (!(v != null && v > cond.value)) return false; break;
      case '>=': if (!(v != null && v >= cond.value)) return false; break;
      case '<': if (!(v != null && v < cond.value)) return false; break;
      case '<=': if (!(v != null && v <= cond.value)) return false; break;
      case '==': if (v !== cond.value) return false; break;
      case '!=': if (cond.value === null) { if (v == null) return false; } else { if (v === cond.value) return false; } break;
      case 'in': if (!Array.isArray(cond.value) || !cond.value.includes(v)) return false; break;
      case 'not_in': if (Array.isArray(cond.value) && cond.value.includes(v)) return false; break;
      default: throw new Error(`unknown op: ${cond.op}`);
    }
  }
  return true;
}

// Match
const matched = touches.filter(t => matchFilter(t, rule));
console.log(`Matched ${matched.length.toLocaleString()} of ${touches.length.toLocaleString()} touches (${(matched.length / touches.length * 100).toFixed(2)}%)`);

// Build candidate trades from matches, evaluate outcomes
const direction = rule.direction;  // 'bounce' or 'break'
const candidates = [];
for (const t of matched) {
  const walk = direction === 'bounce' ? t.bounce : t.brk;
  if (!walk) continue;
  const tTarget = walk.time_to_target_sec?.[TARGET];
  const tStop = walk.time_to_stop_sec?.[STOP];
  const holdSec = HOLD_MIN * 60;
  const tHitTarget = tTarget != null && tTarget <= holdSec ? tTarget : null;
  const tHitStop = tStop != null && tStop <= holdSec ? tStop : null;
  let outcome, exit_sec, exit_pts;
  if (tHitTarget != null && (tHitStop == null || tHitTarget < tHitStop)) {
    outcome = 'win'; exit_sec = tHitTarget; exit_pts = TARGET;
  } else if (tHitStop != null) {
    outcome = 'loss'; exit_sec = tHitStop; exit_pts = -STOP;
  } else {
    // Timeout — use the close at hold horizon as exit, or use MFE/MAE if available
    outcome = 'timeout';
    exit_sec = holdSec;
    // Use the close at the closest horizon
    const closes = walk.closes || {};
    const closeAt = closes[`close_${HOLD_MIN}m`];
    if (closeAt != null) {
      const pl = direction === 'bounce'
        ? (walk.direction === 'long' ? closeAt - walk.entry_price : walk.entry_price - closeAt)
        : (walk.direction === 'long' ? closeAt - walk.entry_price : walk.entry_price - closeAt);
      // Sanity: direction-correct
      exit_pts = walk.direction === 'long' ? (closeAt - walk.entry_price) : (walk.entry_price - closeAt);
    } else {
      exit_pts = 0;  // no data, mark as flat
    }
  }
  const entryTs = t.ts + 60_000;  // entry at touch bar close
  const exitTs = entryTs + exit_sec * 1000;
  // Slippage + commission
  let grossPts = exit_pts;
  // entry slippage: 1pt against (always)
  let netPts = grossPts - ENTRY_SLIPPAGE;
  if (outcome === 'loss') netPts -= STOP_SLIPPAGE;  // stop adds additional slippage
  if (outcome === 'timeout') netPts -= ENTRY_SLIPPAGE;  // exit market on timeout
  const grossDollar = grossPts * POINT_VALUE;
  const netDollar = netPts * POINT_VALUE - 2 * COMMISSION;  // entry + exit commission
  candidates.push({
    touch_id: t.touch_id, ts: t.ts, date: t.date, time_et: t.time_et,
    level_type: t.level_type, level_price: t.level_price, approach: t.approach,
    direction: walk.direction, entry_price: walk.entry_price,
    entryTs, exitTs, exit_sec, outcome, gross_pts: grossPts, net_pts: netPts,
    gross_dollar: grossDollar, net_dollar: netDollar,
  });
}
candidates.sort((a, b) => a.entryTs - b.entryTs);
console.log(`Candidate trades (matches with outcome data): ${candidates.length}\n`);

// Concurrency-aware serial sim: 1 position at a time
const trades = [];
let cursor = -Infinity;
let skipped = 0;
for (const c of candidates) {
  if (c.entryTs < cursor) { skipped++; continue; }
  trades.push(c);
  cursor = c.exitTs;
}
console.log(`After concurrency filter: ${trades.length} trades (${skipped} dropped overlapping)\n`);

// Performance summary
const n = trades.length;
const winCount = trades.filter(t => t.outcome === 'win').length;
const lossCount = trades.filter(t => t.outcome === 'loss').length;
const toCount = trades.filter(t => t.outcome === 'timeout').length;
const grossPnL = trades.reduce((s, t) => s + t.gross_dollar, 0);
const netPnL = trades.reduce((s, t) => s + t.net_dollar, 0);
const wins = trades.filter(t => t.net_dollar > 0);
const losses = trades.filter(t => t.net_dollar <= 0);
const grossWins = wins.reduce((s, t) => s + t.net_dollar, 0);
const grossLosses = -losses.reduce((s, t) => s + t.net_dollar, 0);
const pf = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);
const wr = n > 0 ? wins.length / n : 0;
const avgWin = wins.length > 0 ? grossWins / wins.length : 0;
const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;

// Drawdown
let equity = 0, peak = 0, dd = 0, maxDd = 0;
for (const t of trades) {
  equity += t.net_dollar;
  if (equity > peak) peak = equity;
  dd = peak - equity;
  if (dd > maxDd) maxDd = dd;
}
// Sharpe (daily aggregation)
const byDay = new Map();
for (const t of trades) {
  if (!byDay.has(t.date)) byDay.set(t.date, 0);
  byDay.set(t.date, byDay.get(t.date) + t.net_dollar);
}
const dayPnls = [...byDay.values()];
const meanDay = dayPnls.reduce((s, v) => s + v, 0) / Math.max(1, dayPnls.length);
const stdDay = Math.sqrt(dayPnls.reduce((s, v) => s + (v - meanDay) ** 2, 0) / Math.max(1, dayPnls.length));
const sharpe = stdDay > 0 ? (meanDay / stdDay) * Math.sqrt(252) : 0;

console.log(`=== Composite simulation results ===`);
console.log(`Trades:        ${n}`);
console.log(`Win:           ${winCount}  (${(winCount/n*100).toFixed(1)}%)`);
console.log(`Loss:          ${lossCount}  (${(lossCount/n*100).toFixed(1)}%)`);
console.log(`Timeout:       ${toCount}  (${(toCount/n*100).toFixed(1)}%)`);
console.log(`Net WR:        ${(wr * 100).toFixed(1)}%`);
console.log(`Gross PnL:     $${grossPnL.toFixed(0)}`);
console.log(`Net PnL:       $${netPnL.toFixed(0)}`);
console.log(`Avg win:       $${avgWin.toFixed(0)}`);
console.log(`Avg loss:      $${avgLoss.toFixed(0)}`);
console.log(`PF:            ${pf.toFixed(2)}`);
console.log(`Sharpe:        ${sharpe.toFixed(2)}`);
console.log(`Max DD:        $${maxDd.toFixed(0)}`);
console.log(`Trades/day:    ${(n / byDay.size).toFixed(2)} (over ${byDay.size} active days)`);

// H1/H2 stability
const mid = Math.floor(trades.length / 2);
const h1 = trades.slice(0, mid);
const h2 = trades.slice(mid);
function summary(arr) {
  const w = arr.filter(t => t.net_dollar > 0).length;
  const l = arr.filter(t => t.net_dollar <= 0);
  const pnl = arr.reduce((s, t) => s + t.net_dollar, 0);
  const gW = arr.filter(t => t.net_dollar > 0).reduce((s, t) => s + t.net_dollar, 0);
  const gL = -l.reduce((s, t) => s + t.net_dollar, 0);
  return { n: arr.length, wr: arr.length > 0 ? w / arr.length : 0, pnl, pf: gL > 0 ? gW / gL : Infinity };
}
const h1s = summary(h1), h2s = summary(h2);
console.log(`\nH1/H2 stability (split at trade ${mid}):`);
console.log(`  H1: n=${h1s.n}  WR=${(h1s.wr*100).toFixed(1)}%  PF=${h1s.pf.toFixed(2)}  PnL=$${h1s.pnl.toFixed(0)}`);
console.log(`  H2: n=${h2s.n}  WR=${(h2s.wr*100).toFixed(1)}%  PF=${h2s.pf.toFixed(2)}  PnL=$${h2s.pnl.toFixed(0)}`);

if (VERBOSE) {
  console.log(`\nFirst 10 trades:`);
  for (const t of trades.slice(0, 10)) {
    console.log(`  ${t.date} ${t.time_et}  ${t.direction.toUpperCase()} ${t.level_type}@${t.level_price.toFixed(2)}  entry=${t.entry_price.toFixed(2)} ${t.outcome.padEnd(7)} pts=${t.net_pts.toFixed(1)} $=${t.net_dollar.toFixed(0)}`);
  }
}

// Save
const outPath = IN_PATH.replace(/\.json$/, `.sim-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  rule,
  summary: { n, winCount, lossCount, toCount, wr, grossPnL, netPnL, pf, sharpe, maxDd, avgWin, avgLoss, h1: h1s, h2: h2s },
  trades,
}, null, 2));
console.log(`\nWritten: ${outPath}`);
