/**
 * The strongest pattern: SUPPORT touch + post1 minute shows BOTH positive OFI
 * AND price has recovered ABOVE the level (held).
 *
 * Enter at t+120s (after post1 minute closes) and trade long.
 * Test variations to find the sub-cell with highest WR + sufficient frequency.
 */
import fs from 'fs';
const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const data = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-with-ofi.json`));
const touches = data.touches;
const ofiJoined = JSON.parse(fs.readFileSync(`${ROOT}/research/output/ofi-nq-joined.json`)).joined;

// Build close-by-ts map for fast lookup of post1/post2 closes
const closeByTs = new Map();
for (const r of ofiJoined) closeByTs.set(r.ts, r.close);

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall','gamma_flip']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall','gamma_flip']);

console.log(`Loaded ${touches.length.toLocaleString()} touches`);

// Enrich each touch with post1 price info
for (const t of touches) {
  const minTs = Math.floor(t.ts / 60000) * 60000;
  t.post1_close = closeByTs.get(minTs + 60_000);
  t.post2_close = closeByTs.get(minTs + 2 * 60_000);
  t.touch_close = closeByTs.get(minTs);
  // delta vs level
  t.post1_above_level = t.post1_close != null && t.post1_close > t.level_price;
  t.post1_below_level = t.post1_close != null && t.post1_close < t.level_price;
  t.post1_dist_from_level = t.post1_close != null ? +(t.post1_close - t.level_price).toFixed(2) : null;
}

function labelAtDelayedEntry(t, dir, target, stop, holdMin, delaySec) {
  const w = dir === 'bounce' ? t.bounce : t.brk;
  if (!w) return { outcome: 'no_data' };
  const tt = w.time_to_target_sec?.[target];
  const ts = w.time_to_stop_sec?.[stop];
  if (tt != null && tt <= delaySec) return { outcome: 'skip_target_in_delay' };
  if (ts != null && ts <= delaySec) return { outcome: 'skip_stop_in_delay' };
  const remainHoldSec = holdMin * 60 - delaySec;
  const tHit = tt != null && tt > delaySec && (tt - delaySec) <= remainHoldSec ? tt - delaySec : null;
  const sHit = ts != null && ts > delaySec && (ts - delaySec) <= remainHoldSec ? ts - delaySec : null;
  if (tHit != null && (sHit == null || tHit < sHit)) return { outcome: 'win', exit_sec: tHit };
  if (sHit != null) return { outcome: 'loss', exit_sec: sHit };
  return { outcome: 'timeout', exit_sec: remainHoldSec };
}

function evalRule(name, predicate, dir, target, stop, hold, delaySec) {
  const matched = touches.filter(predicate);
  const labels = matched.map(t => labelAtDelayedEntry(t, dir, target, stop, hold, delaySec));
  const w = labels.filter(l => l.outcome === 'win').length;
  const l = labels.filter(l => l.outcome === 'loss').length;
  const to = labels.filter(l => l.outcome === 'timeout').length;
  const skipped = labels.filter(l => l.outcome.startsWith('skip')).length;
  const nActed = w + l + to;
  const wr = nActed > 0 ? w / nActed : 0;
  const ev = nActed > 0 ? (w * target - l * stop) / nActed : 0;
  console.log(`  ${name.padEnd(82)} n_matched=${String(matched.length).padStart(4)} n_acted=${String(nActed).padStart(4)} W=${String(w).padStart(3)} L=${String(l).padStart(3)} TO=${String(to).padStart(3)}  WR=${(wr*100).toFixed(1).padStart(5)}% EV=${ev.toFixed(2).padStart(6)}  skipped=${skipped}`);
  return { name, matched, labels, w, l, to, skipped, nActed, wr, ev };
}

console.log(`\n=== SUPPORT setups: post1 confirmed hold (delay 60s entry, T10/S5/H15) ===`);
// Base: support from_above, post1 OFI > 0, post1 close > level
evalRule('Support + post1 OFI>0 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 0 && t.post1_above_level,
  'bounce', 10, 5, 15, 60);

evalRule('Support + post1 OFI>50 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 50 && t.post1_above_level,
  'bounce', 10, 5, 15, 60);

evalRule('Support + post1 OFI>100 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 100 && t.post1_above_level,
  'bounce', 10, 5, 15, 60);

evalRule('Support + post1 OFI>0 + post1 dist >2pt above',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 0 && t.post1_dist_from_level > 2,
  'bounce', 10, 5, 15, 60);

evalRule('Support + post1 OFI>0 + post1 dist >5pt above',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 0 && t.post1_dist_from_level > 5,
  'bounce', 10, 5, 15, 60);

console.log(`\n=== Same but with prior sell-flow context (true reversal) ===`);
evalRule('Support + sum_5m_pre<-200 + post1 OFI>0 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -200 && t.ofi.post1?.signedFlow > 0 && t.post1_above_level,
  'bounce', 10, 5, 15, 60);

evalRule('Support + sum_5m_pre<-300 + post1 OFI>0 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -300 && t.ofi.post1?.signedFlow > 0 && t.post1_above_level,
  'bounce', 10, 5, 15, 60);

evalRule('Support + sum_5m_pre<-500 + post1 OFI>0 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -500 && t.ofi.post1?.signedFlow > 0 && t.post1_above_level,
  'bounce', 10, 5, 15, 60);

console.log(`\n=== RESISTANCE mirror: post1 confirmed rejection ===`);
evalRule('Resist + post1 OFI<0 + post1 close<level',
  t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below' && t.ofi.post1?.signedFlow < 0 && t.post1_below_level,
  'bounce', 10, 5, 15, 60);

evalRule('Resist + sum_5m_pre>200 + post1 OFI<0 + post1 close<level',
  t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below' && t.ofi.sum_5m_pre > 200 && t.ofi.post1?.signedFlow < 0 && t.post1_below_level,
  'bounce', 10, 5, 15, 60);

evalRule('Resist + sum_5m_pre>300 + post1 OFI<0 + post1 close<level',
  t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below' && t.ofi.sum_5m_pre > 300 && t.ofi.post1?.signedFlow < 0 && t.post1_below_level,
  'bounce', 10, 5, 15, 60);

console.log(`\n=== Tighter targets: T=7/S=5/H=10 ===`);
// We need the dataset to have target=7 — let me check what's available
// Available: TARGET_PTS = [5, 7, 8, 10, 12, 15, 18, 20, 22, 25]
evalRule('Support + post1 OFI>0 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 0 && t.post1_above_level,
  'bounce', 7, 5, 10, 60);

evalRule('Support + post1 OFI>0 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 0 && t.post1_above_level,
  'bounce', 5, 3, 10, 60);

console.log(`\n=== Bigger targets: T=15/S=8/H=15 ===`);
evalRule('Support + post1 OFI>0 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 0 && t.post1_above_level,
  'bounce', 15, 8, 15, 60);

evalRule('Support + sum_5m_pre<-300 + post1 OFI>0 + post1 close>level',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -300 && t.ofi.post1?.signedFlow > 0 && t.post1_above_level,
  'bounce', 15, 8, 15, 60);

console.log(`\n=== TOD filter on top of best rule ===`);
const BEST = t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.post1?.signedFlow > 0 && t.post1_above_level;
for (const tod of ['pre_rth_early','pre_rth_late','rth_open','rth_morn','rth_lunch','rth_aft','rth_close','after_rth']) {
  evalRule(`BEST + tod=${tod}`, t => BEST(t) && t.features.tod_bucket === tod, 'bounce', 10, 5, 15, 60);
}

console.log(`\n=== Level type drill on best rule ===`);
for (const lt of ['put_wall', 'S1', 'S2', 'S3', 'S4', 'S5', 'gamma_flip']) {
  evalRule(`BEST + level=${lt}`, t => BEST(t) && t.level_type === lt, 'bounce', 10, 5, 15, 60);
}

console.log(`\n=== Combined: by month stability for BEST rule ===`);
const bestMatched = touches.filter(BEST);
const byMonth = new Map();
for (const t of bestMatched) {
  const m = t.date.slice(0, 7);
  if (!byMonth.has(m)) byMonth.set(m, []);
  const r = labelAtDelayedEntry(t, 'bounce', 10, 5, 15, 60);
  byMonth.get(m).push(r.outcome);
}
console.log(`Month   n_matched  n_acted  W   L  TO  WR`);
for (const [m, outs] of [...byMonth.entries()].sort()) {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  const to = outs.filter(o => o === 'timeout').length;
  const skipped = outs.filter(o => o.startsWith('skip')).length;
  const acted = w + l + to;
  console.log(`${m}  ${String(outs.length).padStart(8)}  ${String(acted).padStart(7)}  ${String(w).padStart(3)} ${String(l).padStart(3)} ${String(to).padStart(3)}  ${acted > 0 ? (w/acted*100).toFixed(1)+'%' : '-'}`);
}
