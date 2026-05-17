/**
 * Last angle: explicit pin-bar rejection at level → bounce.
 * "Wicks below closes above" — user's specific scenario.
 *
 * The 1m bar should have a clear wick rejecting the level AND a body
 * that closes safely on the approach side. Combine with structural filters.
 */
import fs from 'fs';
const IN_PATH = process.argv[process.argv.indexOf('--in') + 1];
const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;

function labelDir(t, dir, target, stop, hold) {
  const w = dir === 'bounce' ? t.bounce : t.brk;
  if (!w) return 'no_data';
  const tt = w.time_to_target_sec?.[target];
  const ts = w.time_to_stop_sec?.[stop];
  const hs = hold * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}

function evalRule(pred, dir, t, s, h) {
  const matched = touches.filter(pred);
  const labels = matched.map(x => labelDir(x, dir, t, s, h));
  const w = labels.filter(l => l === 'win').length;
  const l = labels.filter(l => l === 'loss').length;
  const to = labels.filter(l => l === 'timeout').length;
  return { n: matched.length, w, l, to, wr: matched.length > 0 ? w / matched.length : 0, matched, labels };
}

// Pin-bar bounce variants
const RULES = [
  {
    name: 'P1: wick_at_level >= 3 + close_relative >= 2 + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: x => x.features.touch_wick_at_level >= 3 && x.features.touch_close_relative >= 2,
  },
  {
    name: 'P2: wick_at_level >= 5 + close_relative >= 3 + bounce 10/5/10',
    dir: 'bounce', t: 10, s: 5, h: 10,
    p: x => x.features.touch_wick_at_level >= 5 && x.features.touch_close_relative >= 3,
  },
  {
    name: 'P3: wick >= 5 + close_rel >= 3 + bounce 15/8/15',
    dir: 'bounce', t: 15, s: 8, h: 15,
    p: x => x.features.touch_wick_at_level >= 5 && x.features.touch_close_relative >= 3,
  },
  {
    name: 'P4: wick >= 5 + close_rel >= 3 + bounce 15/10/15',
    dir: 'bounce', t: 15, s: 10, h: 15,
    p: x => x.features.touch_wick_at_level >= 5 && x.features.touch_close_relative >= 3,
  },
  {
    name: 'P5: wick >= 8 (extreme pin) + bounce 15/10/15',
    dir: 'bounce', t: 15, s: 10, h: 15,
    p: x => x.features.touch_wick_at_level >= 8 && x.features.touch_close_relative >= 3,
  },
  {
    name: 'P6: P5 + s1 wick past level >= 2',
    dir: 'bounce', t: 15, s: 10, h: 15,
    p: x => x.features.touch_wick_at_level >= 8 && x.features.touch_close_relative >= 3 && x.s1.s1_max_wick_past_pts >= 2,
  },
  {
    name: 'P7: P5 + s1 wick past >= 2 + vol_ratio_15m >= 1.5',
    dir: 'bounce', t: 15, s: 10, h: 15,
    p: x => x.features.touch_wick_at_level >= 8 && x.features.touch_close_relative >= 3 && x.s1.s1_max_wick_past_pts >= 2 && x.features.vol_ratio_15m >= 1.5,
  },
  {
    name: 'P8: pin + s1 wick + level in strong S/R',
    dir: 'bounce', t: 15, s: 10, h: 15,
    p: x => x.features.touch_wick_at_level >= 5 && x.features.touch_close_relative >= 3 && x.s1.s1_max_wick_past_pts >= 2 && ['put_wall', 'call_wall', 'gamma_flip', 'S1', 'R1'].includes(x.level_type),
  },
  // Combine with the user's "level holds + wicks" thesis exactly
  {
    name: 'P9: from_above + wick_at_level >= 5 + close above level + bounce 15/8/15',
    dir: 'bounce', t: 15, s: 8, h: 15,
    p: x => x.approach === 'from_above' && x.features.touch_wick_at_level >= 5 && x.features.touch_close_relative >= 2,
  },
  {
    name: 'P10: from_below + wick_at_level >= 5 + close below level + bounce 15/8/15',
    dir: 'bounce', t: 15, s: 8, h: 15,
    p: x => x.approach === 'from_below' && x.features.touch_wick_at_level >= 5 && x.features.touch_close_relative >= 2,
  },
  // Engulfing patterns
  {
    name: 'P11: touch_engulfing + close back + bounce 15/10/15',
    dir: 'bounce', t: 15, s: 10, h: 15,
    p: x => x.features.touch_engulfing && x.features.touch_close_relative >= 2,
  },
];

console.log(`Pin-bounce variants (user's "wicks below closes above" scenario):\n`);
console.log(`name`.padEnd(70) + `dir   T  S  H    n     W    L   TO   WR     EV_pts/trade`);
for (const r of RULES) {
  const res = evalRule(r.p, r.dir, r.t, r.s, r.h);
  const ev = res.n > 0 ? (res.w * r.t - res.l * r.s) / res.n : 0;
  console.log(
    r.name.padEnd(70),
    r.dir.padEnd(6),
    String(r.t).padStart(2),
    String(r.s).padStart(2),
    String(r.h).padStart(2),
    String(res.n).padStart(5),
    String(res.w).padStart(4),
    String(res.l).padStart(4),
    String(res.to).padStart(4),
    ((res.wr * 100).toFixed(1) + '%').padStart(7),
    `   ${ev.toFixed(2)}`,
  );
}

// Pin scalp specifically — small targets
console.log(`\n--- Pin bounce with tight scalp targets ---`);
const PIN_BASE = x => x.features.touch_wick_at_level >= 5 && x.features.touch_close_relative >= 3;
for (const c of [[5, 3, 5], [5, 5, 5], [7, 5, 5], [8, 5, 5], [8, 5, 10], [10, 5, 10], [10, 8, 10], [12, 8, 10]]) {
  const [t, s, h] = c;
  const res = evalRule(PIN_BASE, 'bounce', t, s, h);
  const ev = res.n > 0 ? (res.w * t - res.l * s) / res.n : 0;
  console.log(`  PIN bounce T${t}/S${s}/H${h}min  n=${res.n} W=${res.w} L=${res.l} TO=${res.to}  WR=${(res.wr * 100).toFixed(1)}%  EV=${ev.toFixed(2)}pt`);
}
