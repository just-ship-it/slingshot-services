/**
 * GEX-Touch Flow — Phase 2c: "Early confirmation predicts continuation" hypothesis.
 *
 * If price tags the level and within X seconds gets Y pts in some direction,
 * does that predict continuation? This tests the user's hypothesis that flow
 * confirms FAST or doesn't confirm at all.
 *
 * Strategy: wait for first N pts of confirmation in the first M seconds,
 * then enter in that direction targeting another N pts with tight stop.
 */
import fs from 'fs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN_PATH = arg('in', null);
if (!IN_PATH) { console.error('--in required'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;
console.log(`Loaded ${touches.length} touches\n`);

// For each touch, compute:
//   - direction of first significant move (>= 5pt) within first 60s
//   - whether subsequent move continues in same direction
//
// Key question: of the touches where price moves +5pt in direction X within Y seconds,
// what % of them then hit +15pt or +20pt before retracing by 8pt?

function classifyEarlySignal(touch, confirmPts, confirmSec) {
  const b = touch.bounce, k = touch.brk;
  if (!b || !k) return null;
  // First direction to hit `confirmPts` within `confirmSec`
  const bTime = b.time_to_target_sec?.[confirmPts];  // bounce direction reaches target in N sec
  const kTime = k.time_to_target_sec?.[confirmPts];  // break direction reaches target in N sec
  const bHit = bTime != null && bTime <= confirmSec ? bTime : null;
  const kHit = kTime != null && kTime <= confirmSec ? kTime : null;
  if (bHit == null && kHit == null) return null;  // no early move either way
  // Direction that got there first
  if (bHit != null && (kHit == null || bHit <= kHit)) return { direction: 'bounce', confirm_sec: bHit, walk: b };
  return { direction: 'break', confirm_sec: kHit, walk: k };
}

const SCENARIOS = [
  // confirmPts, confirmSec, targetPts, stopPts, holdMin
  { cp: 5, cs: 60, tp: 15, sp: 5, hm: 10 },
  { cp: 5, cs: 60, tp: 15, sp: 8, hm: 10 },
  { cp: 5, cs: 60, tp: 20, sp: 8, hm: 15 },
  { cp: 5, cs: 120, tp: 15, sp: 5, hm: 10 },
  { cp: 5, cs: 120, tp: 20, sp: 8, hm: 15 },
  { cp: 7, cs: 60, tp: 15, sp: 5, hm: 10 },
  { cp: 7, cs: 60, tp: 20, sp: 8, hm: 15 },
  { cp: 7, cs: 120, tp: 20, sp: 8, hm: 15 },
  { cp: 8, cs: 60, tp: 15, sp: 5, hm: 10 },
  { cp: 8, cs: 60, tp: 20, sp: 8, hm: 15 },
  { cp: 8, cs: 120, tp: 20, sp: 8, hm: 15 },
  { cp: 10, cs: 120, tp: 20, sp: 8, hm: 15 },
  { cp: 10, cs: 180, tp: 20, sp: 8, hm: 30 },
  { cp: 12, cs: 180, tp: 20, sp: 8, hm: 30 },
];

console.log(`Hypothesis: of touches where price moves +N pts within S sec in some direction,`);
console.log(`what % continue to hit target T before stop S?\n`);
console.log(`confirm  conf_sec  target  stop  hold     n_signaled  W   L   TO  WR    avg_pts_after_conf`);

const results = [];
for (const sc of SCENARIOS) {
  const { cp, cs, tp, sp, hm } = sc;
  let nSig = 0, w = 0, l = 0, to = 0;
  let totalPts = 0;
  const trades = [];
  for (const t of touches) {
    const sig = classifyEarlySignal(t, cp, cs);
    if (!sig) continue;
    nSig++;
    // After confirmation, simulate: from confirm_sec onward, did walk hit target before stop?
    const walk = sig.walk;
    const tt = walk.time_to_target_sec?.[tp];
    const ts = walk.time_to_stop_sec?.[sp];
    const holdSec = hm * 60;
    // Note: target and stop are measured FROM ENTRY (touch ts + 60s walk start), not from confirm
    // For "post-confirmation" we want: target hit after confirm_sec, before stop and within hold
    const hitTarget = tt != null && tt > sig.confirm_sec && tt <= holdSec ? tt : null;
    const hitStop = ts != null && ts > sig.confirm_sec && ts <= holdSec ? ts : null;
    if (hitTarget != null && (hitStop == null || hitTarget < hitStop)) {
      w++; totalPts += tp;
      trades.push({ touch_id: t.touch_id, direction: sig.direction, outcome: 'win', confirm_sec: sig.confirm_sec, exit_sec: hitTarget });
    } else if (hitStop != null) {
      l++; totalPts -= sp;
      trades.push({ touch_id: t.touch_id, direction: sig.direction, outcome: 'loss', confirm_sec: sig.confirm_sec, exit_sec: hitStop });
    } else {
      to++;
      trades.push({ touch_id: t.touch_id, direction: sig.direction, outcome: 'timeout', confirm_sec: sig.confirm_sec });
    }
  }
  const wr = nSig > 0 ? w / nSig : 0;
  const decided = w + l;
  const wrDec = decided > 0 ? w / decided : 0;
  console.log(
    `+${String(cp).padStart(2)}pt`.padEnd(8),
    `≤${String(cs).padStart(3)}s`.padEnd(9),
    `${String(tp).padStart(3)}pt`.padEnd(7),
    `${String(sp).padStart(2)}pt`.padEnd(6),
    `${String(hm).padStart(2)}min`.padEnd(8),
    String(nSig).padStart(6),
    String(w).padStart(5), String(l).padStart(4), String(to).padStart(4),
    ((wr * 100).toFixed(1) + '%').padStart(7),
    `(decided: ${(wrDec * 100).toFixed(1)}%)`
  );
  results.push({ ...sc, n: nSig, w, l, to, wr, wr_decided: wrDec, total_pts: totalPts, trades });
}

const outPath = IN_PATH.replace(/\.json$/, '.early-confirm.json');
fs.writeFileSync(outPath, JSON.stringify({ results }, null, 2));
console.log(`\nWritten: ${outPath}`);
