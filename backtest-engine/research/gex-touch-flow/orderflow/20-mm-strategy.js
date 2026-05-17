/**
 * Unified MM-aware strategy test.
 *
 * Framework (per user):
 *   1. We trade WITH the dealer hedging flow, against retail stops
 *   2. Level holds (bounce) when: positive gamma + level has held N times
 *   3. Level breaks (continuation) when: negative gamma + level fails after compression
 *   4. Structural stops (10-15pt past level/swing), let winners RUN with trailing
 *
 * Uses the extended-walks dataset (180min hold, targets up to 150pt).
 */
import fs from 'fs';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

console.log('Loading extended walks + swing structure + GEX context...');
const extWalks = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-extended-walks.json`));
const swingData = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-with-swing.json`));

// Index swing data by touch_id
const swingById = new Map();
for (const s of swingData) swingById.set(s.touch_id, s);

// Load gex context per event by reloading the gex-touch-flow dataset
const baseData = JSON.parse(fs.readFileSync(`${ROOT}/research/output/gex-touch-flow-2026-05-14T05-52-19-372Z.json`));
const baseById = new Map();
for (const b of baseData.touches) baseById.set(b.touch_id, b);

// Merge into extWalks records
let merged = 0;
for (const t of extWalks) {
  const b = baseById.get(t.touch_id);
  const s = swingById.get(t.touch_id);
  if (b) {
    t.gamma_imbalance = b.features.gamma_imbalance;
    t.regime = b.features.regime;
    t.level_gex_mag = b.features.level_gex_mag;
    t.level_gex_rank = b.features.level_gex_rank;
    t.tod_bucket = b.features.tod_bucket;
    t.touch_distance_pts = b.features.touch_distance_pts;
  }
  if (s && s.swing) {
    t.swing = s.swing;
    t.rejections = s.swing.rejections;
    t.current_near_swing = s.swing.current_near_swing;
    t.structural_stop = s.swing.structural_stop;
  }
  if (b && s) merged++;
}
console.log(`Merged ${merged}/${extWalks.length} events with full context\n`);

const touches = extWalks.filter(t => t.walk && t.bounceDir);
console.log(`Trade-ready touches: ${touches.length.toLocaleString()}`);

// =========================================================================
// Outcome simulation with TRAILING STOP
// =========================================================================
// Walk format: time_to_target_sec[T], time_to_stop_sec[S], mfe_pts, mae_pts,
// closes[close_5/15/30/60/90/120m]
//
// Without full path data, approximate trailing stop as a CASCADE of fixed-target hits:
//   1. Initial stop: -S pt (structural)
//   2. If MFE >= R1 (trigger): stop moves to entry+O1 (lock in O1)
//   3. If MFE >= R2: stop moves to entry+O2
//   4. ...
// To simulate: use time_to_target_sec[R_k] as the "trigger time" and check whether
// the stop at the new level would be hit subsequently.
//
// This is approximate. With time_to_stop ladder we know when MAE reaches various
// levels. We can chain:
//   - At t=0: stop at -S
//   - At time_to_target[R1]: stop becomes -O1 (above entry if O1 > 0)
//   - If time_to_stop[abs(O1)] (relative to entry) is AFTER time_to_target[R1], stop hits next
//     but we need stop_at_entry+O1, which we don't have unless we re-walk.
//
// Simpler approach: compute outcome at fixed target/stop AND check what % of MFE was kept.

function evaluateFixed(arr, target, stop, holdMin) {
  let w = 0, l = 0, to = 0;
  let totalPts = 0;
  for (const t of arr) {
    const tt = t.walk.time_to_target_sec?.[target];
    const ts = t.walk.time_to_stop_sec?.[stop];
    const hs = holdMin * 60;
    if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) { w++; totalPts += target; }
    else if (ts != null && ts <= hs) { l++; totalPts -= stop; }
    else { to++; }
  }
  const n = w + l + to;
  return { n, w, l, to, wr: n > 0 ? w / n : 0, ev: n > 0 ? (w * target - l * stop) / n : 0, totalPts };
}

// Approximate trailing-stop sim: enter with stop S, when MFE reaches R, move stop to (entry+O).
// Look at "after trigger" data using time_to_target tiers as proxy for "where was price at time X".
// True simulation needs full path; this is an approximation.
function evaluateTrail(arr, stop, trigger, offset, holdMin, finalTarget = null) {
  // Pseudo-logic:
  //   - If mfe_pts < trigger: trade plays out with stop = -stop, target = (finalTarget or no target)
  //   - If mfe_pts >= trigger: stop moves up to -(stop - trigger - offset) = +offset
  //     i.e., once MFE reaches +trigger, stop locks profit at +offset
  //     After that, the trade continues with new tighter stop. Exit at MAE-from-MFE >= (trigger - offset).
  //
  // We don't have time-series MAE-from-MFE. We can only approximate.
  // Simpler: if MFE >= trigger AND (close_at_hold >= entry+offset OR exit by stop hit at -stop): win at offset
  //          else if stop hit before trigger: lose
  //          else: timeout at close
  let w = 0, l = 0, to = 0;
  let totalPts = 0;
  for (const t of arr) {
    const mfe = t.walk.mfe_pts;
    const ts = t.walk.time_to_stop_sec?.[stop];
    const tTrigger = t.walk.time_to_target_sec?.[trigger];
    const hs = holdMin * 60;

    // Case 1: stop hit before any trigger
    if (ts != null && ts <= hs && (tTrigger == null || ts < tTrigger)) {
      l++; totalPts -= stop;
      continue;
    }
    // Case 2: trigger never reached, no stop, just timeout
    if (tTrigger == null || tTrigger > hs) {
      to++;
      // Outcome = close at horizon. Use closes if available.
      const closeKey = holdMin >= 120 ? 'close_120m' : holdMin >= 90 ? 'close_90m' : holdMin >= 60 ? 'close_60m' : holdMin >= 30 ? 'close_30m' : 'close_15m';
      const closePx = t.walk.closes?.[closeKey];
      if (closePx != null) {
        const fav = t.bounceDir === 'long' ? closePx - t.entry_price : t.entry_price - closePx;
        totalPts += fav;
      }
      continue;
    }
    // Case 3: trigger reached, stop moves to entry+offset.
    // Now we want: of the remaining MFE→exit, did price retrace below entry+offset?
    // Without path data, assume trade exits at:
    //   - finalTarget if MFE >= finalTarget
    //   - else, +offset (the new trailing stop) if MFE - offset > offset (i.e., retraced significantly)
    //   - else, close_at_horizon
    if (finalTarget != null && mfe >= finalTarget) {
      // Trade hit final target before horizon — use final target
      w++; totalPts += finalTarget;
    } else {
      // Trailed out. Assume we get LOCKED IN at +offset (conservative).
      // True outcome could be higher if price kept running.
      // Use closes[horizon] vs offset to determine
      const closeKey = holdMin >= 120 ? 'close_120m' : holdMin >= 90 ? 'close_90m' : holdMin >= 60 ? 'close_60m' : holdMin >= 30 ? 'close_30m' : 'close_15m';
      const closePx = t.walk.closes?.[closeKey];
      if (closePx != null) {
        const closeFav = t.bounceDir === 'long' ? closePx - t.entry_price : t.entry_price - closePx;
        // Trade ends at: max(trailing_stop_locked, close_fav) approximately
        // If close above offset, we get close (still in trade up to horizon).
        // If close below offset, we got stopped out at offset.
        const exitPts = closeFav >= offset ? closeFav : offset;
        w++; totalPts += exitPts;
      } else {
        // No close data → take offset as outcome (conservative)
        w++; totalPts += offset;
      }
    }
  }
  const n = w + l + to;
  return { n, w, l, to, wr: n > 0 ? w / n : 0, ev: n > 0 ? totalPts / n : 0 };
}

function p(label, arr, params, hold) {
  if (arr.length < 30) return null;
  let r;
  if (params.trail) {
    r = evaluateTrail(arr, params.stop, params.trigger, params.offset, hold, params.finalTarget);
  } else {
    r = evaluateFixed(arr, params.target, params.stop, hold);
  }
  console.log(`  ${label.padEnd(80)} n=${String(r.n).padStart(4)} W=${String(r.w).padStart(3)} L=${String(r.l).padStart(3)} TO=${String(r.to).padStart(3)} WR=${(r.wr*100).toFixed(1).padStart(5)}% EV=${r.ev.toFixed(2).padStart(7)}pt`);
  return r;
}

// =========================================================================
// Test 1: WITH/AGAINST gamma regime at structural levels
// =========================================================================
console.log('\n=== RESISTANCE bounces (SHORT) by gamma regime ===');
const resists = touches.filter(t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below');

console.log('\nFixed target=20/stop=12/hold=30 (baseline):');
p('All resistance shorts', resists, { target: 20, stop: 12 }, 30);
p('  + Negative gamma regime', resists.filter(t => t.regime === 'negative' || t.regime === 'strong_negative'), { target: 20, stop: 12 }, 30);
p('  + Positive gamma regime', resists.filter(t => t.regime === 'positive' || t.regime === 'strong_positive'), { target: 20, stop: 12 }, 30);
p('  + Neutral regime', resists.filter(t => t.regime === 'neutral'), { target: 20, stop: 12 }, 30);

console.log('\nFixed target=50/stop=15/hold=120 (extended):');
p('All resistance shorts', resists, { target: 50, stop: 15 }, 120);
p('  + Positive gamma (MM defends → expect bounce)', resists.filter(t => t.regime === 'positive' || t.regime === 'strong_positive'), { target: 50, stop: 15 }, 120);
p('  + Negative gamma (MM gives up → break harder)', resists.filter(t => t.regime === 'negative' || t.regime === 'strong_negative'), { target: 50, stop: 15 }, 120);

console.log('\nStructural validation + Positive gamma (LEVEL HOLDS in pos gamma):');
const posGammaResists = resists.filter(t => (t.regime === 'positive' || t.regime === 'strong_positive') && t.rejections >= 2);
p('Resist + posGamma + rej>=2 + T20/S12/H30', posGammaResists, { target: 20, stop: 12 }, 30);
p('  T30/S15/H60', posGammaResists, { target: 30, stop: 15 }, 60);
p('  T50/S15/H120', posGammaResists, { target: 50, stop: 15 }, 120);
p('  T75/S15/H120', posGammaResists, { target: 75, stop: 15 }, 120);
p('  T100/S15/H180', posGammaResists, { target: 100, stop: 15 }, 180);

console.log('\nStructural validation + Negative gamma (BREAK):');
// For resistance break in negative gamma, we'd trade LONG (the break direction)
// But our walks here are SHORT direction. So actually for break we want LONG = brk in original dataset.
// Hmm, the bounceDir is set for "bounce" direction. We need the brk walks for break.
// Let me check what we have in ext walks — it's just one walk per touch, in bounceDir.

console.log(`\n  (Break tests need a re-walk in break direction. Skipping for now.)`);

// =========================================================================
// Test 2: Trailing stop simulation
// =========================================================================
console.log('\n=== TRAILING STOP simulation on best cells ===');
console.log('  Trail logic: enter at touch close, stop at -15. When MFE>=25, move stop to entry+10');
console.log('  (locked profit 10pt). Then exit at close of horizon.');

const cellPos = resists.filter(t => (t.regime === 'positive' || t.regime === 'strong_positive') && t.rejections >= 2 && t.current_near_swing);
console.log(`\nPos gamma + rej>=2 + at_swing:`);
p('Trail S15/Tr25/O10/H60', cellPos, { trail: true, stop: 15, trigger: 25, offset: 10 }, 60);
p('Trail S15/Tr30/O15/H60', cellPos, { trail: true, stop: 15, trigger: 30, offset: 15 }, 60);
p('Trail S15/Tr40/O20/H120', cellPos, { trail: true, stop: 15, trigger: 40, offset: 20 }, 120);
p('Trail S15/Tr50/O25/H120 (T75 final)', cellPos, { trail: true, stop: 15, trigger: 50, offset: 25, finalTarget: 75 }, 120);

const cellAll = resists.filter(t => t.rejections >= 2 && t.current_near_swing);
console.log(`\nAll resist + rej>=2 + at_swing (no regime filter):`);
p('Trail S15/Tr25/O10/H60', cellAll, { trail: true, stop: 15, trigger: 25, offset: 10 }, 60);
p('Trail S15/Tr30/O15/H60', cellAll, { trail: true, stop: 15, trigger: 30, offset: 15 }, 60);
p('Trail S15/Tr40/O20/H120', cellAll, { trail: true, stop: 15, trigger: 40, offset: 20 }, 120);
p('Trail S20/Tr40/O20/H120', cellAll, { trail: true, stop: 20, trigger: 40, offset: 20 }, 120);

// =========================================================================
// Test 3: MFE distribution at structural cells
// =========================================================================
console.log('\n=== MFE distribution at strongest cell (resist + rej>=2 + at_swing + pos gamma) ===');
const sample = cellPos;
const mfes = sample.map(t => t.walk.mfe_pts).sort((a, b) => a - b);
const maes = sample.map(t => t.walk.mae_pts).sort((a, b) => a - b);
console.log(`Sample: ${sample.length} events`);
console.log(`MFE distribution: min=${mfes[0]} p25=${mfes[Math.floor(mfes.length*0.25)]} p50=${mfes[Math.floor(mfes.length*0.5)]} p75=${mfes[Math.floor(mfes.length*0.75)]} p90=${mfes[Math.floor(mfes.length*0.9)]} p95=${mfes[Math.floor(mfes.length*0.95)]} max=${mfes[mfes.length-1]}`);
console.log(`MAE distribution: min=${maes[0]} p25=${maes[Math.floor(maes.length*0.25)]} p50=${maes[Math.floor(maes.length*0.5)]} p75=${maes[Math.floor(maes.length*0.75)]} p90=${maes[Math.floor(maes.length*0.9)]} p95=${maes[Math.floor(maes.length*0.95)]} max=${maes[maes.length-1]}`);
const got_to_30 = sample.filter(t => t.walk.mfe_pts >= 30).length;
const got_to_50 = sample.filter(t => t.walk.mfe_pts >= 50).length;
const got_to_100 = sample.filter(t => t.walk.mfe_pts >= 100).length;
console.log(`% reached +30pt: ${(got_to_30/sample.length*100).toFixed(1)}%`);
console.log(`% reached +50pt: ${(got_to_50/sample.length*100).toFixed(1)}%`);
console.log(`% reached +100pt: ${(got_to_100/sample.length*100).toFixed(1)}%`);
const got_stop_15 = sample.filter(t => t.walk.mae_pts >= 15).length;
const got_stop_20 = sample.filter(t => t.walk.mae_pts >= 20).length;
const got_stop_25 = sample.filter(t => t.walk.mae_pts >= 25).length;
console.log(`% hit -15pt MAE: ${(got_stop_15/sample.length*100).toFixed(1)}%`);
console.log(`% hit -20pt MAE: ${(got_stop_20/sample.length*100).toFixed(1)}%`);
console.log(`% hit -25pt MAE: ${(got_stop_25/sample.length*100).toFixed(1)}%`);

// Concurrency simulation
console.log('\n=== Concurrency-aware sim ===');
function simulate(events, params, holdMin) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const trades = [];
  let cursor = -Infinity;
  for (const t of sorted) {
    const entryTs = t.ts + 60_000;
    if (entryTs < cursor) continue;
    // Compute outcome
    let outcome, exit_sec, pts;
    if (params.trail) {
      const mfe = t.walk.mfe_pts;
      const tStop = t.walk.time_to_stop_sec?.[params.stop];
      const tTrigger = t.walk.time_to_target_sec?.[params.trigger];
      const hs = holdMin * 60;
      if (tStop != null && tStop <= hs && (tTrigger == null || tStop < tTrigger)) {
        outcome = 'loss'; pts = -params.stop; exit_sec = tStop;
      } else if (tTrigger == null || tTrigger > hs) {
        const closeKey = holdMin >= 120 ? 'close_120m' : holdMin >= 90 ? 'close_90m' : holdMin >= 60 ? 'close_60m' : 'close_30m';
        const closePx = t.walk.closes?.[closeKey];
        const fav = closePx != null ? (t.bounceDir === 'long' ? closePx - t.entry_price : t.entry_price - closePx) : 0;
        outcome = 'timeout'; pts = fav; exit_sec = hs;
      } else {
        // Trailed: take final target or close
        if (params.finalTarget && mfe >= params.finalTarget) {
          outcome = 'win'; pts = params.finalTarget;
          exit_sec = t.walk.time_to_target_sec?.[params.finalTarget] || hs;
        } else {
          const closeKey = holdMin >= 120 ? 'close_120m' : holdMin >= 90 ? 'close_90m' : holdMin >= 60 ? 'close_60m' : 'close_30m';
          const closePx = t.walk.closes?.[closeKey];
          const closeFav = closePx != null ? (t.bounceDir === 'long' ? closePx - t.entry_price : t.entry_price - closePx) : params.offset;
          outcome = 'trail_win'; pts = Math.max(closeFav, params.offset);
          exit_sec = hs;
        }
      }
    } else {
      const tt = t.walk.time_to_target_sec?.[params.target];
      const ts = t.walk.time_to_stop_sec?.[params.stop];
      const hs = holdMin * 60;
      if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) { outcome = 'win'; pts = params.target; exit_sec = tt; }
      else if (ts != null && ts <= hs) { outcome = 'loss'; pts = -params.stop; exit_sec = ts; }
      else { outcome = 'timeout'; pts = 0; exit_sec = hs; }
    }
    const exitTs = entryTs + exit_sec * 1000;
    trades.push({ outcome, pts });
    cursor = exitTs;
  }
  return trades;
}
const params1 = { trail: true, stop: 15, trigger: 30, offset: 15 };
const sim1 = simulate(cellAll, params1, 60);
const w = sim1.filter(t => t.pts > 0).length;
const l = sim1.filter(t => t.pts < 0).length;
const z = sim1.filter(t => t.pts === 0).length;
const total = sim1.reduce((s, t) => s + t.pts, 0);
const yrFrac = 12.5 / 12;
console.log(`Trail strategy (resist + rej>=2 + at_swing): n=${sim1.length} W=${w} L=${l} flat=${z}  WR=${(w/sim1.length*100).toFixed(1)}%  total=${total.toFixed(0)}pt  gross=$${(total*20).toFixed(0)}  ~${(sim1.length/yrFrac).toFixed(0)}/yr  $${((total*20)/yrFrac).toFixed(0)}/yr/contract`);

// Compare to fixed-target
const sim2 = simulate(cellAll, { target: 30, stop: 15 }, 60);
const w2 = sim2.filter(t => t.pts > 0).length;
const l2 = sim2.filter(t => t.pts < 0).length;
const total2 = sim2.reduce((s, t) => s + t.pts, 0);
console.log(`Fixed T30/S15/H60: n=${sim2.length} W=${w2} L=${l2}  WR=${(w2/sim2.length*100).toFixed(1)}%  total=${total2.toFixed(0)}pt  gross=$${(total2*20).toFixed(0)}  ~${(sim2.length/yrFrac).toFixed(0)}/yr  $${((total2*20)/yrFrac).toFixed(0)}/yr/contract`);

const sim3 = simulate(cellAll, { target: 50, stop: 15 }, 120);
const w3 = sim3.filter(t => t.pts > 0).length;
const l3 = sim3.filter(t => t.pts < 0).length;
const total3 = sim3.reduce((s, t) => s + t.pts, 0);
console.log(`Fixed T50/S15/H120: n=${sim3.length} W=${w3} L=${l3}  WR=${(w3/sim3.length*100).toFixed(1)}%  total=${total3.toFixed(0)}pt  gross=$${(total3*20).toFixed(0)}  ~${(sim3.length/yrFrac).toFixed(0)}/yr  $${((total3*20)/yrFrac).toFixed(0)}/yr/contract`);

console.log('\nDone.');
