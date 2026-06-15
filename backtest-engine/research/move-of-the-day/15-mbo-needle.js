// Phase 10b — MBO microstructure NEEDLE HUNT.
// For each trade at decision points M, engineer position-aligned order-book/tape features from
// the reconstructed book, then screen each for LEADING power: does it predict the FUTURE move
// [M→exit] controlling for the price already seen (unrl@M)? The whole-conversation lesson:
// only a signal orthogonal to price and predictive of the *future* is actionable.
//
// Observations = (trade, M) for M in DECISION_MINS where the trade is still open. Features are
// trailing-window averages ending at M (no lookahead). Reports partial association (within price
// bucket) ranked; flags any needle. Small n (102 trades) ⇒ effect sizes + honest power caveats.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANELS = path.resolve(__dirname, 'output/mbo-panels');
const DECISION_MINS = [10, 15, 20, 30, 45];
const TRAIL = 30; // seconds trailing window for feature averaging

// load all panels
const trades = [];
for (const f of fs.readdirSync(PANELS).filter(f => f.endsWith('.json'))) {
  for (const t of JSON.parse(fs.readFileSync(path.join(PANELS, f), 'utf8'))) if (t.snaps && t.snaps.length) trades.push(t);
}
console.log(`Loaded ${trades.length} trades with panels.`);

const aligned = (side, x) => side === 'long' ? x : -x;
const ratio = (a, b) => (a + b) > 0 ? (a - b) / (a + b) : 0;
function trailAvg(snaps, sEnd, fn) {
  let s = 0, n = 0;
  for (let i = snaps.length - 1; i >= 0; i--) { const sn = snaps[i]; if (sn.t > sEnd) continue; if (sn.t < sEnd - TRAIL) break; const v = fn(sn); if (isFinite(v)) { s += v; n++; } }
  return n ? s / n : null;
}
const snapAt = (snaps, sEnd) => { let best = null; for (const sn of snaps) { if (sn.t <= sEnd) best = sn; else break; } return best; };

// build observations
const obs = [];
for (const t of trades) {
  const entrySec = Math.floor(t.entryTs / 1000), exitSec = Math.floor(t.exitTs / 1000);
  for (const M of DECISION_MINS) {
    const S = entrySec + M * 60;
    if (S >= exitSec - 30) continue;          // need future room
    const cur = snapAt(t.snaps, S); if (!cur) continue;
    const prev = snapAt(t.snaps, S - TRAIL);
    const unrl = aligned(t.side, cur.mid - t.entry);
    const future = t.finalPts - unrl;          // remaining P/L from M to exit
    const recentMove = prev ? aligned(t.side, cur.mid - prev.mid) : 0; // price drift over trailing window, aligned
    // position-aligned microstructure features (trailing-avg ending at M)
    const fav = (fn) => { const v = trailAvg(t.snaps, S, fn); return v == null ? null : aligned(t.side, v); };
    const F = {
      favImb1:  fav(s => s.imb1),
      favImb5:  fav(s => s.imb5),
      favImb10: fav(s => s.imb10),
      favFlow:  fav(s => ratio(s.buy5, s.sell5)),
      favCancel: fav(s => ratio(s.cxA5, s.cxB5)),   // asks pulling (good for long) vs bids pulling
      favAdd:    fav(s => ratio(s.adB5, s.adA5)),    // bids building (good for long) vs asks
      favWall:   fav(s => ratio(s.maxB5, s.maxA5)),  // support wall vs resistance wall
      favDepth:  fav(s => ratio(s.b10, s.a10)),
      spread:    trailAvg(t.snaps, S, s => s.spr),
      recentMove,
    };
    if (Object.values(F).some(v => v == null)) continue;
    // ABSORPTION: strong aggressor flow toward us but price WON'T follow ⇒ other side absorbing ⇒ adverse.
    F.absorb = (F.favFlow > 0.1 && recentMove <= 0) ? F.favFlow : 0;
    obs.push({ id: t.id, k: t.k, side: t.side, M, unrl, future, win: t.finalPts > 0, ...F });
  }
}
console.log(`Observations (trade×M, still-open): ${obs.length}\n`);

// price buckets to control for what's already in the price
const bucket = o => o.unrl < -10 ? 'under' : o.unrl <= 10 ? 'flat' : 'green';
const FEATS = ['favImb1', 'favImb5', 'favImb10', 'favFlow', 'favCancel', 'favAdd', 'favWall', 'favDepth', 'spread', 'recentMove', 'absorb'];

// Spearman-ish: within each price bucket, correlation of feature rank with future move.
function rankCorr(rows, key) {
  const xs = rows.map(r => r[key]), ys = rows.map(r => r.future);
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = Array(a.length); idx.forEach(([_, i], j) => r[i] = j); return r; };
  const rx = rank(xs), ry = rank(ys), n = rows.length;
  const mx = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - mx; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

console.log('PARTIAL ASSOCIATION of each feature with FUTURE move, within price bucket (Spearman ρ):');
console.log('feature      under(n)        flat(n)         green(n)        |  pooled-within ρ');
const pooledScore = {};
for (const feat of FEATS) {
  let line = feat.padEnd(11), wsum = 0, wn = 0;
  for (const b of ['under', 'flat', 'green']) {
    const rows = obs.filter(o => bucket(o) === b);
    const rho = rows.length >= 15 ? rankCorr(rows, feat) : null;
    line += '  ' + (rho == null ? `--(${rows.length})`.padEnd(14) : `${rho >= 0 ? '+' : ''}${rho.toFixed(3)}(${rows.length})`.padEnd(14));
    if (rho != null) { wsum += rho * rows.length; wn += rows.length; }
  }
  pooledScore[feat] = wn ? wsum / wn : 0;
  console.log(`${line}  |  ${pooledScore[feat] >= 0 ? '+' : ''}${pooledScore[feat].toFixed(3)}`);
}

// Highlight: actionable = predictive within UNDER/FLAT buckets (where cut/hold decision lives)
console.log('\nRanked by |association| in the ACTIONABLE (under+flat) buckets:');
const act = obs.filter(o => bucket(o) !== 'green');
const ranked = FEATS.map(f => ({ f, rho: act.length >= 20 ? rankCorr(act, f) : 0 })).sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
for (const { f, rho } of ranked) console.log(`   ${f.padEnd(11)} ρ=${rho >= 0 ? '+' : ''}${rho.toFixed(3)}  (n=${act.length})`);

// For the top feature, show tercile separation of future move (under+flat only)
const top = ranked[0].f;
console.log(`\nTop feature "${top}" — future move by tercile (actionable buckets, n=${act.length}):`);
const sorted = [...act].sort((a, b) => a[top] - b[top]);
const T = Math.floor(sorted.length / 3);
for (const [lbl, rows] of [['low', sorted.slice(0, T)], ['mid', sorted.slice(T, 2 * T)], ['high', sorted.slice(2 * T)]]) {
  const fa = rows.reduce((s, r) => s + r.future, 0) / rows.length;
  const wr = rows.filter(r => r.win).length / rows.length * 100;
  console.log(`   ${top} ${lbl.padEnd(4)} n=${rows.length}  avgFuture ${fa.toFixed(1).padStart(7)}pt  finalWR ${wr.toFixed(0)}%`);
}
