/**
 * Portfolio simulation: combine multiple high-conviction rule cells into one
 * strategy and simulate with realistic concurrency + slippage.
 *
 * Slippage model (mirroring engine):
 *   Entry market: 1pt against
 *   Stop loss:    1.5pt slippage on stop trigger (market on stop)
 *   Take profit:  0pt (limit fills exact, per CLAUDE.md fix)
 *   Commission:   $5/side (round trip $10)
 */
import fs from 'fs';

const IN_PATH = process.argv[process.argv.indexOf('--in') + 1];
const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;

const ENTRY_SLIPPAGE = 1.0;
const STOP_SLIPPAGE = 1.5;
const COMMISSION = 5;
const POINT_VALUE = 20;

function labelDir(t, dir, target, stop, hold) {
  const w = dir === 'bounce' ? t.bounce : t.brk;
  if (!w) return { outcome: 'no_data' };
  const tt = w.time_to_target_sec?.[target];
  const ts = w.time_to_stop_sec?.[stop];
  const hs = hold * 60;
  const tHit = tt != null && tt <= hs ? tt : null;
  const sHit = ts != null && ts <= hs ? ts : null;
  if (tHit != null && (sHit == null || tHit < sHit)) {
    return { outcome: 'win', exit_sec: tHit, pts_gross: target, pts_net: target - ENTRY_SLIPPAGE };
  }
  if (sHit != null) {
    return { outcome: 'loss', exit_sec: sHit, pts_gross: -stop, pts_net: -stop - ENTRY_SLIPPAGE - STOP_SLIPPAGE };
  }
  // Timeout — use close at horizon (market exit)
  const closeAt = w.closes?.[`close_${hold}m`];
  let pts_gross = 0;
  if (closeAt != null) {
    pts_gross = w.direction === 'long' ? closeAt - w.entry_price : w.entry_price - closeAt;
  }
  return { outcome: 'timeout', exit_sec: hs, pts_gross, pts_net: pts_gross - ENTRY_SLIPPAGE - ENTRY_SLIPPAGE };
}

// === Rule definitions ===
// Each rule produces matched touches → trades

const RULES = [
  {
    name: 'UP_BREAK (from_below + put_wall/S1/S2 + gi mid + dist≥100)',
    direction: 'break',
    target: 15, stop: 10, hold: 15,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      if (!['put_wall', 'S1', 'S2', 'R3'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= 0 && gi <= 0.4 && d != null && d >= 100;
    },
  },
  {
    name: 'DN_BREAK (from_above + call_wall/R1/R2 + gi mid neg + dist≥100)',
    direction: 'break',
    target: 15, stop: 10, hold: 15,
    predicate: t => {
      if (t.approach !== 'from_above') return false;
      if (!['call_wall', 'R1', 'R2', 'S3'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= -0.4 && gi <= 0 && d != null && d >= 100;
    },
  },
  {
    name: 'BOUNCE_HIGH_GAMMA (gi>0.5 + dist_next_break≥250)',
    direction: 'bounce',
    target: 15, stop: 10, hold: 30,
    predicate: t => {
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= 0.5 && d != null && d >= 250;
    },
  },
];

function simulateRule(rule) {
  const matched = touches.filter(rule.predicate);
  const trades = matched.map(t => {
    const r = labelDir(t, rule.direction, rule.target, rule.stop, rule.hold);
    const entryTs = t.ts + 60_000;
    const exitTs = entryTs + (r.exit_sec || rule.hold * 60) * 1000;
    return { ...t, ...r, entryTs, exitTs, rule: rule.name };
  });
  return trades;
}

// Run each rule
let all = [];
for (const r of RULES) {
  const trades = simulateRule(r);
  console.log(`\n${r.name}:`);
  console.log(`  target=${r.target} stop=${r.stop} hold=${r.hold}min`);
  const w = trades.filter(t => t.outcome === 'win').length;
  const l = trades.filter(t => t.outcome === 'loss').length;
  const to = trades.filter(t => t.outcome === 'timeout').length;
  const totalNet = trades.reduce((s, t) => s + (t.pts_net || 0), 0);
  console.log(`  n=${trades.length} W=${w} L=${l} TO=${to}  WR=${(w / trades.length * 100).toFixed(1)}%  total_net=${totalNet.toFixed(0)}pts ($${(totalNet * POINT_VALUE - trades.length * 2 * COMMISSION).toFixed(0)})`);
  all = all.concat(trades);
}

// Combined portfolio with concurrency
all.sort((a, b) => a.entryTs - b.entryTs);
console.log(`\n=== Portfolio sim (combined ${all.length} candidates, 1 position at a time) ===`);

const trades = [];
let cursor = -Infinity;
let skipped = 0;
for (const t of all) {
  if (t.entryTs < cursor) { skipped++; continue; }
  trades.push(t);
  cursor = t.exitTs;
}
console.log(`Accepted: ${trades.length}  Skipped (overlap): ${skipped}\n`);

// Stats
const n = trades.length;
const w = trades.filter(t => t.outcome === 'win').length;
const l = trades.filter(t => t.outcome === 'loss').length;
const to = trades.filter(t => t.outcome === 'timeout').length;
const grossPts = trades.reduce((s, t) => s + (t.pts_gross || 0), 0);
const netPts = trades.reduce((s, t) => s + (t.pts_net || 0), 0);
const grossPnL = grossPts * POINT_VALUE;
const netPnL = netPts * POINT_VALUE - n * 2 * COMMISSION;
const wins = trades.filter(t => t.pts_net > 0);
const losses = trades.filter(t => t.pts_net <= 0);
const gW = wins.reduce((s, t) => s + t.pts_net, 0);
const gL = -losses.reduce((s, t) => s + t.pts_net, 0);
const pf = gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0);

// DD
let eq = 0, peak = 0, maxDd = 0;
for (const t of trades) {
  const trade_net_dollar = (t.pts_net || 0) * POINT_VALUE - 2 * COMMISSION;
  eq += trade_net_dollar;
  if (eq > peak) peak = eq;
  if (peak - eq > maxDd) maxDd = peak - eq;
}

// Sharpe via daily PnL
const byDay = new Map();
for (const t of trades) {
  const trade_net_dollar = (t.pts_net || 0) * POINT_VALUE - 2 * COMMISSION;
  if (!byDay.has(t.date)) byDay.set(t.date, 0);
  byDay.set(t.date, byDay.get(t.date) + trade_net_dollar);
}
const dayPnls = [...byDay.values()];
const meanDay = dayPnls.reduce((s, v) => s + v, 0) / Math.max(1, dayPnls.length);
const stdDay = Math.sqrt(dayPnls.reduce((s, v) => s + (v - meanDay) ** 2, 0) / Math.max(1, dayPnls.length));
const sharpe = stdDay > 0 ? (meanDay / stdDay) * Math.sqrt(252) : 0;

console.log(`Trades:    ${n}`);
console.log(`W/L/TO:    ${w}/${l}/${to}`);
console.log(`WR:        ${(w / n * 100).toFixed(1)}%`);
console.log(`Gross PnL: $${grossPnL.toFixed(0)} (${grossPts.toFixed(0)}pt)`);
console.log(`Net PnL:   $${netPnL.toFixed(0)}`);
console.log(`PF:        ${pf.toFixed(2)}`);
console.log(`Sharpe:    ${sharpe.toFixed(2)}`);
console.log(`Max DD:    $${maxDd.toFixed(0)}`);
console.log(`Trades/day: ${(n / byDay.size).toFixed(2)} (over ${byDay.size} active days)`);

// H1/H2 stability
const mid = Math.floor(trades.length / 2);
const h1 = trades.slice(0, mid);
const h2 = trades.slice(mid);
function sumPart(arr) {
  const w_ = arr.filter(t => t.pts_net > 0).length;
  const net = arr.reduce((s, t) => s + (t.pts_net || 0) * POINT_VALUE - 2 * COMMISSION, 0);
  return { n: arr.length, wr: arr.length > 0 ? w_ / arr.length : 0, net };
}
const s1 = sumPart(h1), s2 = sumPart(h2);
console.log(`\nH1: n=${s1.n}  WR=${(s1.wr*100).toFixed(1)}%  net=$${s1.net.toFixed(0)}`);
console.log(`H2: n=${s2.n}  WR=${(s2.wr*100).toFixed(1)}%  net=$${s2.net.toFixed(0)}`);

// By month
console.log(`\nBy month:`);
const byMonth = new Map();
for (const t of trades) {
  const m = t.date.slice(0, 7);
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(t);
}
for (const [m, arr] of [...byMonth.entries()].sort()) {
  const w_ = arr.filter(t => t.pts_net > 0).length;
  const net = arr.reduce((s, t) => s + (t.pts_net || 0) * POINT_VALUE - 2 * COMMISSION, 0);
  console.log(`  ${m}: n=${String(arr.length).padStart(3)}  WR=${(w_ / arr.length * 100).toFixed(0)}%  $${net.toFixed(0).padStart(7)}`);
}

const outPath = IN_PATH.replace(/\.json$/, '.portfolio-sim.json');
fs.writeFileSync(outPath, JSON.stringify({ rules: RULES.map(r => ({ name: r.name, direction: r.direction, target: r.target, stop: r.stop, hold: r.hold, predicate: r.predicate.toString() })), trades }, null, 2));
console.log(`\nWritten: ${outPath}`);
