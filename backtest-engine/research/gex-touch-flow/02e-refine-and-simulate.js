/**
 * Refine the top filter and test variants. Two clear sub-patterns surfaced:
 *
 * Pattern UP-BREAK (the big winner):
 *   - approach = from_below
 *   - gamma_imbalance in (0.036, 0.264] — slightly positive gamma
 *   - level_type in {put_wall, S1, S2, R3} (the "weak" levels in bull regime)
 *   - dist_next_break_level >= 100 (room above for continuation)
 *
 * Hypothesis: In mild positive gamma, price rising into a put-wall/support
 * area breaks through and continues up (no dealer defense, lots of room).
 */
import fs from 'fs';
const IN_PATH = process.argv[process.argv.indexOf('--in') + 1];
const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;

function labelBreak(t, target, stop, hold) {
  const w = t.brk;
  const tt = w.time_to_target_sec?.[target];
  const ts = w.time_to_stop_sec?.[stop];
  const hs = hold * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}
function labelBounce(t, target, stop, hold) {
  const w = t.bounce;
  const tt = w.time_to_target_sec?.[target];
  const ts = w.time_to_stop_sec?.[stop];
  const hs = hold * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}

function evalRule(rule) {
  const matched = touches.filter(t => rule.predicate(t));
  const labels = matched.map(t => rule.direction === 'break' ? labelBreak(t, rule.target, rule.stop, rule.hold) : labelBounce(t, rule.target, rule.stop, rule.hold));
  const w = labels.filter(l => l === 'win').length;
  const l = labels.filter(l => l === 'loss').length;
  const to = labels.filter(l => l === 'timeout').length;
  return { n: matched.length, w, l, to, wr: matched.length > 0 ? w / matched.length : 0, matched };
}

const TARGET = 15, STOP = 12, HOLD = 15;

const rules = [
  {
    name: 'V1: Original pair (gi d4, dist d6)',
    direction: 'break',
    target: TARGET, stop: STOP, hold: HOLD,
    predicate: t => {
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi > 0.036 && gi <= 0.264 && d != null && d > 207.1 && d <= 208.22;
    }
  },
  {
    name: 'V2: + from_below only',
    direction: 'break',
    target: TARGET, stop: STOP, hold: HOLD,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi > 0.036 && gi <= 0.264 && d != null && d > 207.1 && d <= 208.22;
    }
  },
  {
    name: 'V3: from_below + good level types + gi positive + dist >= 100',
    direction: 'break',
    target: TARGET, stop: STOP, hold: HOLD,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      if (!['put_wall', 'S1', 'S2', 'R3'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= 0 && gi <= 0.4 && d != null && d >= 100;
    }
  },
  {
    name: 'V4: V3 but only put_wall/S1/S2 (strongest sub-cells)',
    direction: 'break',
    target: TARGET, stop: STOP, hold: HOLD,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      if (!['put_wall', 'S1', 'S2'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= 0 && gi <= 0.4 && d != null && d >= 100;
    }
  },
  {
    name: 'V5: V4 + exclude rth_aft (worst TOD)',
    direction: 'break',
    target: TARGET, stop: STOP, hold: HOLD,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      if (!['put_wall', 'S1', 'S2'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      if (t.features.tod_bucket === 'rth_aft' || t.features.tod_bucket === 'rth_close') return false;
      return gi != null && gi >= 0 && gi <= 0.4 && d != null && d >= 100;
    }
  },
  // Now relax target and try smaller targets / tighter stops
  {
    name: 'V6: V4 with T=12/S=10/H=15',
    direction: 'break',
    target: 12, stop: 10, hold: 15,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      if (!['put_wall', 'S1', 'S2'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= 0 && gi <= 0.4 && d != null && d >= 100;
    }
  },
  {
    name: 'V7: V4 with T=15/S=10/H=10',
    direction: 'break',
    target: 15, stop: 10, hold: 10,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      if (!['put_wall', 'S1', 'S2'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= 0 && gi <= 0.4 && d != null && d >= 100;
    }
  },
  {
    name: 'V8: V4 with T=15/S=8/H=10',
    direction: 'break',
    target: 15, stop: 8, hold: 10,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      if (!['put_wall', 'S1', 'S2'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= 0 && gi <= 0.4 && d != null && d >= 100;
    }
  },
  {
    name: 'V9: V4 with T=10/S=5/H=10 (true scalp)',
    direction: 'break',
    target: 10, stop: 5, hold: 10,
    predicate: t => {
      if (t.approach !== 'from_below') return false;
      if (!['put_wall', 'S1', 'S2'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= 0 && gi <= 0.4 && d != null && d >= 100;
    }
  },
  // Mirror image: from_above + negative gamma → down break
  {
    name: 'V10 mirror: from_above + good types + gi neg + dist >= 100',
    direction: 'break',
    target: TARGET, stop: STOP, hold: HOLD,
    predicate: t => {
      if (t.approach !== 'from_above') return false;
      if (!['call_wall', 'R1', 'R2', 'S3'].includes(t.level_type)) return false;
      const gi = t.features.gamma_imbalance;
      const d = t.features.dist_next_break_level;
      return gi != null && gi >= -0.4 && gi <= 0 && d != null && d >= 100;
    }
  },
];

console.log(`Refinement & sensitivity (target/stop/hold per rule):\n`);
console.log(`name`.padEnd(60) + 't  s  h    n     W    L   TO   WR     pts_gross');
const allResults = [];
for (const r of rules) {
  const res = evalRule(r);
  // gross pts: wins * target - losses * stop (ignoring slip)
  const gross = res.w * r.target - res.l * r.stop;
  console.log(
    r.name.padEnd(60),
    String(r.target).padStart(2),
    String(r.stop).padStart(2),
    String(r.hold).padStart(3),
    String(res.n).padStart(5),
    String(res.w).padStart(5),
    String(res.l).padStart(4),
    String(res.to).padStart(4),
    ((res.wr * 100).toFixed(1) + '%').padStart(7),
    String(gross).padStart(7),
  );
  allResults.push({ rule: r.name, ...res, target: r.target, stop: r.stop, hold: r.hold, gross });
}

// Stability checks for V4 (the proposed gold rule)
console.log(`\n--- Stability for V4 (from_below × put_wall/S1/S2 × gi∈[0,0.4] × dist≥100, T15/S12/H15) ---`);
const v4Rule = rules[3];
const v4res = evalRule(v4Rule);
console.log(`Total: ${v4res.n} matches, WR ${(v4res.wr * 100).toFixed(1)}%`);
// By month
const byMonth = new Map();
v4res.matched.forEach((t, i) => {
  const m = t.date.slice(0, 7);
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(i);
});
console.log(`By month (n / WR):`);
for (const [m, idxs] of [...byMonth.entries()].sort()) {
  const w = idxs.filter(i => labelBreak(v4res.matched[i], v4Rule.target, v4Rule.stop, v4Rule.hold) === 'win').length;
  console.log(`  ${m}: n=${idxs.length}  WR=${(w / idxs.length * 100).toFixed(1)}%`);
}

// Save
const outPath = IN_PATH.replace(/\.json$/, '.refine.json');
fs.writeFileSync(outPath, JSON.stringify({ rules: rules.map(r => ({ ...r, predicate: r.predicate.toString() })), results: allResults }, null, 2));
console.log(`\nWritten: ${outPath}`);
