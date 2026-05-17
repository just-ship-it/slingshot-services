/**
 * Tight scalp angle: focus on the user's "quick hits" thesis.
 * Hypothesis: when 1s shows clear dealer defense (price loiters at level + rejects fast),
 * the immediate bounce is high-WR if we take a small target with tight stop.
 *
 * Two angles:
 *   (A) "Level held" bounce — wait for 1s to show defense, take 8-10pt against approach
 *   (B) "Big-boys volume burst" — touch bar shows top-quartile 1s vol burst, take 8-12pt
 *
 * Also: test the user's framing that smaller targets with tight stops = high WR.
 */
import fs from 'fs';
const IN_PATH = process.argv[process.argv.indexOf('--in') + 1];
const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;

function flat(t) { return { ...t.features, ...t.s1 }; }

function labelDir(t, dir, target, stop, hold) {
  const w = dir === 'bounce' ? t.bounce : t.brk;
  if (!w) return 'no_data';
  const tt = w.time_to_target_sec?.[target];
  const ts = w.time_to_stop_sec?.[stop];
  const hs = hold * 60;
  const tHit = tt != null && tt <= hs ? tt : null;
  const sHit = ts != null && ts <= hs ? ts : null;
  if (tHit != null && (sHit == null || tHit < sHit)) return 'win';
  if (sHit != null) return 'loss';
  return 'timeout';
}

function evalRule(predicate, dir, target, stop, hold) {
  const matched = touches.filter(predicate);
  const labels = matched.map(t => labelDir(t, dir, target, stop, hold));
  const w = labels.filter(l => l === 'win').length;
  const l = labels.filter(l => l === 'loss').length;
  const to = labels.filter(l => l === 'timeout').length;
  return { n: matched.length, w, l, to, wr: matched.length > 0 ? w / matched.length : 0, matched, labels };
}

// === Tight bounce scalp variants ===
const RULES = [
  // A: "Level held" bounces — 1s shows level rejection
  {
    name: 'A1: s1 rejection in first 30s + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: t => t.s1.s1_first_rejection_sec != null && t.s1.s1_first_rejection_sec <= 30,
  },
  {
    name: 'A2: s1 rejection in first 30s + bounce 8/5/10',
    dir: 'bounce', t: 12, s: 5, h: 10,
    p: t => t.s1.s1_first_rejection_sec != null && t.s1.s1_first_rejection_sec <= 30,
  },
  {
    name: 'A3: s1 wick past >= 2pt + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: t => t.s1.s1_max_wick_past_pts >= 2,
  },
  {
    name: 'A4: seconds_at_level >= 20 + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: t => t.s1.s1_seconds_at_level >= 20,
  },
  {
    name: 'A5: seconds_at_level >= 30 + wick past >= 1pt + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: t => t.s1.s1_seconds_at_level >= 30 && t.s1.s1_max_wick_past_pts >= 1,
  },
  // B: Volume burst signatures
  {
    name: 'B1: vol_ratio_15m >= 1.5 + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: t => t.features.vol_ratio_15m != null && t.features.vol_ratio_15m >= 1.5,
  },
  {
    name: 'B2: vol_ratio_15m >= 2 + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: t => t.features.vol_ratio_15m != null && t.features.vol_ratio_15m >= 2,
  },
  {
    name: 'B3: vol_zscore >= 1.5 + s1 wick + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: t => t.features.vol_zscore_15m != null && t.features.vol_zscore_15m >= 1.5 && t.s1.s1_max_wick_past_pts >= 1,
  },
  // C: Trending into level (acceptance plays / break plays)
  {
    name: 'C1: fast approach (speed_5m d9) + break 10/5/10',
    dir: 'break', t: 10, s: 5, h: 10,
    p: t => t.features.approach_speed_5m != null && Math.abs(t.features.approach_speed_5m) >= 1.5,
  },
  {
    name: 'C2: distance_traveled_5m >= 20pt + break 10/5/10',
    dir: 'break', t: 10, s: 5, h: 10,
    p: t => t.features.distance_traveled_5m != null && t.features.distance_traveled_5m >= 20,
  },
  // D: Bigger small-target test (no filter — baseline at scalp)
  {
    name: 'D1: ALL TOUCHES bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: t => true,
  },
  {
    name: 'D2: ALL TOUCHES bounce 10/8/10',
    dir: 'bounce', t: 10, s: 8, h: 10,
    p: t => true,
  },
  {
    name: 'D3: ALL TOUCHES break 10/5/10',
    dir: 'break', t: 10, s: 5, h: 10,
    p: t => true,
  },
  {
    name: 'D4: ALL TOUCHES break 10/8/10',
    dir: 'break', t: 10, s: 8, h: 10,
    p: t => true,
  },
  // E: Combined — what about gamma + level type combos at smaller targets?
  {
    name: 'E1: V2 with smaller target 10/5/10',
    dir: 'break', t: 10, s: 5, h: 10,
    p: t => {
      if (t.approach !== 'from_below') return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi > 0.036 && gi <= 0.264 && d != null && d > 207.1 && d <= 208.22;
    },
  },
  // F: target/stop sweep at NO filter to find baseline R:R cliffs
  ...[
    { t: 5, s: 3 }, { t: 8, s: 3 }, { t: 10, s: 3 }, { t: 12, s: 3 }, { t: 15, s: 3 },
    { t: 5, s: 5 }, { t: 8, s: 5 }, { t: 10, s: 5 }, { t: 15, s: 5 },
    { t: 8, s: 8 }, { t: 10, s: 8 }, { t: 12, s: 8 },
  ].map(c => ({
    name: `F_baseline: bounce T${c.t}/S${c.s}/H10`,
    dir: 'bounce', t: c.t, s: c.s, h: 10,
    p: t => true,
  })),
];

console.log(`Rule sweep — quick scalp variants:\n`);
console.log(`name`.padEnd(60) + `dir   T  S  H    n      W     L    TO   WR     EV_pts/trade`);
for (const r of RULES) {
  const res = evalRule(r.p, r.dir, r.t, r.s, r.h);
  const ev = res.n > 0 ? (res.w * r.t - res.l * r.s) / res.n : 0;
  console.log(
    r.name.padEnd(60),
    r.dir.padEnd(6),
    String(r.t).padStart(2),
    String(r.s).padStart(2),
    String(r.h).padStart(2),
    String(res.n).padStart(5),
    String(res.w).padStart(5),
    String(res.l).padStart(4),
    String(res.to).padStart(4),
    ((res.wr * 100).toFixed(1) + '%').padStart(7),
    `   ${ev.toFixed(2)}`,
  );
}
