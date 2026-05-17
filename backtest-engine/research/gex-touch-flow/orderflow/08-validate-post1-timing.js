/**
 * The "touch + post1 both positive" filter requires seeing the minute AFTER
 * the touch. That means we can only enter 60s after the dataset's reference
 * entry time (touch.ts + 60s). Validate: does the strategy survive that delay?
 *
 * Method: among matched events, check the distribution of time_to_target_sec[10].
 * If most have time_to_target >= 60s, the entry delay is fine. If many trades
 * have target hit in <60s, they're lost to delayed entry.
 *
 * Then estimate WR with delayed entry by checking which trades would still
 * have stopped/hit within the remaining hold window starting from t+120s.
 *
 * Also test alternative timings: what if we use t+30s instead of t+60s
 * (use only PARTIAL post1 info)?
 */
import fs from 'fs';
const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const data = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-with-ofi.json`));
const touches = data.touches;
console.log(`Loaded ${touches.length.toLocaleString()} touches with OFI`);

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall','gamma_flip']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall','gamma_flip']);

// Match the "touch + post1 both positive" filter at supports from_above
const matched = touches.filter(t =>
  SUPPORT_TYPES.has(t.level_type) &&
  t.approach === 'from_above' &&
  t.ofi.touch.signedFlow > 0 &&
  t.ofi.post1?.signedFlow > 0
);
console.log(`Match (support from_above + touch+post1 positive): ${matched.length}`);

// For each, examine time_to_target[10] and time_to_stop[5] distributions
const tToTarget = matched.map(t => t.bounce.time_to_target_sec?.[10]).filter(v => v != null);
const tToStop = matched.map(t => t.bounce.time_to_stop_sec?.[5]).filter(v => v != null);

function distribution(label, arr, cutoff) {
  arr.sort((a, b) => a - b);
  const n = arr.length;
  const lt60 = arr.filter(v => v <= 60).length;
  const lt120 = arr.filter(v => v <= 120).length;
  const lt300 = arr.filter(v => v <= 300).length;
  console.log(`${label}: n=${n}`);
  console.log(`  ≤60s:  ${lt60} (${(lt60/n*100).toFixed(1)}%)`);
  console.log(`  ≤120s: ${lt120} (${(lt120/n*100).toFixed(1)}%)`);
  console.log(`  ≤300s: ${lt300} (${(lt300/n*100).toFixed(1)}%)`);
  console.log(`  median: ${arr[Math.floor(n/2)]}s`);
}
distribution('Time to target +10pt', tToTarget);
distribution('Time to stop -5pt', tToStop);

// ===== Simulate DELAYED entry (t+120s instead of t+60s) =====
// Approach: a target hit at time T (from t+60s) is lost if T <= 60s (target hit during delay)
// Similarly for stop: stop hit at T <= 60s is lost (stop hit during delay).
// After delay, the entry price has CHANGED — we don't have that price tracked exactly,
// but we can approximate: assume the trader "gives up" the trade if the level was already broken
// during the delay window.
//
// More important: among trades that did NOT hit target or stop within the first 60s,
// what's the conditional outcome from t+120s onward?

function evaluateDelayedEntry(matched, target, stop, holdMin, delaySec) {
  let win = 0, loss = 0, timeout = 0;
  let skippedAlreadyDone = 0;
  let entryWouldFailReversal = 0;

  for (const t of matched) {
    const tt = t.bounce.time_to_target_sec?.[target];
    const ts = t.bounce.time_to_stop_sec?.[stop];
    const holdSec = holdMin * 60;

    // If target or stop hit during delay, we never entered → skip
    const tHitInDelay = tt != null && tt <= delaySec;
    const sHitInDelay = ts != null && ts <= delaySec;
    if (tHitInDelay || sHitInDelay) {
      skippedAlreadyDone++;
      continue;
    }

    // After delay, what was the new entry price relative to original entry?
    // The "concurrent return" in the delay window changes our entry baseline.
    // Approximation: we use the original target/stop hits, but penalize them by
    // the magnitude of any drift during the delay.
    //
    // Simpler: assume the trade is still valid from the delayed entry. Target hit
    // at time T means price reached entry+10 at time T (from t+60s). From delayed
    // perspective, that's reached at time T - delaySec from the new entry, IF the
    // new entry price is the same as old. If price moved against us during delay,
    // target is now further away.
    //
    // We have time_to_target[8] available in the dataset. If the entry price during
    // the delay drifted up by 2pt, our new target needs +12pt from old entry =
    // time_to_target[12].
    //
    // Without exact intra-minute prices, we'll make a conservative assumption:
    // delay reduces effective hold by 60s, but otherwise the trade is unchanged.
    const remainHoldSec = holdSec - delaySec;
    const tHit = tt != null && tt > delaySec && (tt - delaySec) <= remainHoldSec ? tt : null;
    const sHit = ts != null && ts > delaySec && (ts - delaySec) <= remainHoldSec ? ts : null;

    if (tHit != null && (sHit == null || tHit < sHit)) win++;
    else if (sHit != null) loss++;
    else timeout++;
  }

  const total = win + loss + timeout;
  return { win, loss, timeout, skipped: skippedAlreadyDone, total, wr: total > 0 ? win / total : 0 };
}

console.log(`\n=== Effect of delayed entry on WR ===`);
for (const delay of [0, 60, 90, 120]) {
  const r = evaluateDelayedEntry(matched, 10, 5, 15, delay);
  console.log(`Delay=${delay}s  total=${r.total}  W=${r.win} L=${r.loss} TO=${r.timeout}  WR=${(r.wr*100).toFixed(1)}%  skipped(target/stop in delay)=${r.skipped}`);
}

// ============================================================================
// Important: with delay, we lose trades that hit target/stop in delay window.
// Those that hit TARGET in delay → we wouldn't have caught them (missed wins)
// Those that hit STOP in delay → great, we avoided them (saved losses)
// Let's quantify:
// ============================================================================
console.log(`\n=== Counterfactual: would we be better/worse than always-enter strategy? ===`);
function compareStrategies(matched, target, stop, holdMin, delaySec) {
  let always_win = 0, always_loss = 0, always_to = 0;
  let delayed_win = 0, delayed_loss = 0, delayed_to = 0, delayed_skipped = 0;
  const holdSec = holdMin * 60;
  for (const t of matched) {
    const tt = t.bounce.time_to_target_sec?.[target];
    const ts = t.bounce.time_to_stop_sec?.[stop];
    // Always-enter (no delay)
    const tHitA = tt != null && tt <= holdSec ? tt : null;
    const sHitA = ts != null && ts <= holdSec ? ts : null;
    if (tHitA != null && (sHitA == null || tHitA < sHitA)) always_win++;
    else if (sHitA != null) always_loss++;
    else always_to++;
    // Delayed
    if ((tt != null && tt <= delaySec) || (ts != null && ts <= delaySec)) {
      delayed_skipped++;
      continue;
    }
    const remainHoldSec = holdSec - delaySec;
    const tHitD = tt != null && tt > delaySec && (tt - delaySec) <= remainHoldSec ? tt : null;
    const sHitD = ts != null && ts > delaySec && (ts - delaySec) <= remainHoldSec ? ts : null;
    if (tHitD != null && (sHitD == null || tHitD < sHitD)) delayed_win++;
    else if (sHitD != null) delayed_loss++;
    else delayed_to++;
  }
  const tot_a = always_win + always_loss + always_to;
  const tot_d = delayed_win + delayed_loss + delayed_to;
  console.log(`ALWAYS-enter strategy (no post1 filter, no delay):  n=${matched.length}  W=${always_win} L=${always_loss} TO=${always_to}  WR=${(always_win/matched.length*100).toFixed(1)}%  EV/trade=${(always_win*target - always_loss*stop)/matched.length}pt`);
  console.log(`DELAYED-enter strategy (uses post1 info, ${delaySec}s delay):  n_acted=${tot_d}  W=${delayed_win} L=${delayed_loss} TO=${delayed_to}  WR=${(delayed_win/tot_d*100).toFixed(1)}%  EV/acted=${(delayed_win*target - delayed_loss*stop)/tot_d}pt`);
  console.log(`Net trades after delay: ${tot_d} (skipped ${delayed_skipped} that resolved during delay)`);
}
compareStrategies(matched, 10, 5, 15, 60);

// Test more setups: PATTERN C/D variations and absorption patterns
// ============================================================================
console.log(`\n=== Other promising flow filters at touches (no lookahead) ===`);

function makeAndEval(name, predicate, dir, target, stop, hold) {
  const arr = touches.filter(predicate);
  let win = 0, loss = 0, to = 0;
  for (const t of arr) {
    const w = dir === 'bounce' ? t.bounce : t.brk;
    const tt = w?.time_to_target_sec?.[target];
    const ts = w?.time_to_stop_sec?.[stop];
    const hs = hold * 60;
    if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) win++;
    else if (ts != null && ts <= hs) loss++;
    else to++;
  }
  const n = arr.length;
  const wr = n > 0 ? win / n : 0;
  const ev = n > 0 ? (win * target - loss * stop) / n : 0;
  console.log(`  ${name.padEnd(70)} n=${String(n).padStart(4)} W=${String(win).padStart(4)} L=${String(loss).padStart(4)} TO=${String(to).padStart(3)} WR=${(wr*100).toFixed(1).padStart(5)}% EV=${ev.toFixed(2).padStart(6)}`);
  return { name, n, win, loss, to, wr, ev, trades: arr };
}

// Tests using only PRE-TOUCH-MINUTE info (no lookahead)
console.log(`\nNo-lookahead variants (using only signal info available at touch close):`);
makeAndEval('PRE-LOOKAHEAD: SUPPORT from_above, sum_5m_pre < -300, touch_minute > 0',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -300 && t.ofi.touch.signedFlow > 0,
  'bounce', 10, 5, 15);
makeAndEval('SUPPORT from_above, sum_5m_pre < -500, touch > 0',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -500 && t.ofi.touch.signedFlow > 0,
  'bounce', 10, 5, 15);
makeAndEval('SUPPORT from_above, sum_10m_pre < -500, touch > 0',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_10m_pre < -500 && t.ofi.touch.signedFlow > 0,
  'bounce', 10, 5, 15);
makeAndEval('SUPPORT, consec_sell>=3, touch>0',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.consec_sell_streak >= 3 && t.ofi.touch.signedFlow > 0,
  'bounce', 10, 5, 15);
makeAndEval('SUPPORT, consec_sell>=2, touch>0',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.consec_sell_streak >= 2 && t.ofi.touch.signedFlow > 0,
  'bounce', 10, 5, 15);

// Now do RESISTANCE side
console.log(`\nMirror at RESISTANCE:`);
makeAndEval('RESIST from_below, sum_5m_pre > 300, touch < 0',
  t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below' && t.ofi.sum_5m_pre > 300 && t.ofi.touch.signedFlow < 0,
  'bounce', 10, 5, 15);
makeAndEval('RESIST from_below, sum_5m_pre > 500, touch < 0',
  t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below' && t.ofi.sum_5m_pre > 500 && t.ofi.touch.signedFlow < 0,
  'bounce', 10, 5, 15);
makeAndEval('RESIST, consec_buy>=3, touch<0',
  t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below' && t.ofi.consec_buy_streak >= 3 && t.ofi.touch.signedFlow < 0,
  'bounce', 10, 5, 15);

// Try larger target
console.log(`\nWith T=15/S=8/H=15:`);
makeAndEval('SUPPORT, sum_5m_pre<-300, touch>0',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -300 && t.ofi.touch.signedFlow > 0,
  'bounce', 15, 8, 15);
makeAndEval('RESIST, sum_5m_pre>300, touch<0',
  t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below' && t.ofi.sum_5m_pre > 300 && t.ofi.touch.signedFlow < 0,
  'bounce', 15, 8, 15);

// Combined signals: layer level type, TOD, etc on top
console.log(`\nLayered (no lookahead):`);
makeAndEval('SUPPORT from_above, sum_5m_pre<-300, touch>0, rth_open/aft',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -300 && t.ofi.touch.signedFlow > 0 && (t.features.tod_bucket === 'rth_open' || t.features.tod_bucket === 'rth_aft'),
  'bounce', 10, 5, 15);
makeAndEval('SUPPORT from_above, sum_5m_pre<-300, touch>0, NOT rth_lunch',
  t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above' && t.ofi.sum_5m_pre < -300 && t.ofi.touch.signedFlow > 0 && t.features.tod_bucket !== 'rth_lunch' && t.features.tod_bucket !== 'after_rth',
  'bounce', 10, 5, 15);
