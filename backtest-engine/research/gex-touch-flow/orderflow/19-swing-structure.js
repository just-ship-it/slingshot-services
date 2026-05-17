/**
 * Swing-structure validation:
 *
 *   For each touch at a GEX RESISTANCE level:
 *     - Look back K minutes
 *     - Find the highest high in that window (call it the swing high SH)
 *     - Count how many times in that window price touched within 3pt of SH
 *       AND failed to close above SH
 *     - If count >= 2: SH is a validated structural top
 *     - The current bar is at/near SH (it's the latest test)
 *     - Trade: SHORT, stop above SH + buffer, target = extended
 *
 *   Mirror for SUPPORT levels (swing low validated bottom).
 *
 *   This is much tighter than just "level touched N times" — it uses the
 *   ACTUAL price structure formed at the level, which gives us a precise
 *   stop location.
 *
 * Reuses the existing touches dataset (with bounce/brk walks up to 30min hold,
 * targets up to 25pt). Once 18-extended-walks finishes we can re-test with
 * extended targets.
 */
import fs from 'fs';
import readline from 'readline';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const DATA_DIR = `${ROOT}/data`;

console.log('Loading 1m candles + touches...');
async function loadPrimaryNQ() {
  const rl = readline.createInterface({ input: fs.createReadStream(`${DATA_DIR}/ohlcv/nq/NQ_ohlcv_1m.csv`), crlfDelay: Infinity });
  const hourVol = new Map();
  const rows = [];
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const parts = line.split(',');
    const symbol = parts[9];
    if (!symbol || symbol.includes('-')) continue;
    const ts = parts[0];
    const tsMs = Date.parse(ts);
    if (isNaN(tsMs)) continue;
    if (ts.slice(0, 10) < '2025-01-13' || ts.slice(0, 10) > '2026-01-28') continue;
    const open = +parts[4], high = +parts[5], low = +parts[6], close = +parts[7];
    if (isNaN(open) || isNaN(close)) continue;
    const volume = +parts[8] || 0;
    const hour = Math.floor(tsMs / 3600000);
    if (!hourVol.has(hour)) hourVol.set(hour, new Map());
    hourVol.get(hour).set(symbol, (hourVol.get(hour).get(symbol) || 0) + volume);
    rows.push({ ts: tsMs, open, high, low, close, volume, symbol });
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let best = '', bestV = -1;
    for (const [s, v] of m.entries()) if (v > bestV) { bestV = v; best = s; }
    primary.set(h, best);
  }
  return rows.filter(r => r.symbol === primary.get(Math.floor(r.ts / 3600000)));
}
const candles = await loadPrimaryNQ();
console.log(`Loaded ${candles.length.toLocaleString()} primary candles`);

// Index by ts and by date
const candleByTs = new Map();
const candlesByDate = new Map();
for (const c of candles) {
  candleByTs.set(c.ts, c);
  const date = new Date(c.ts).toISOString().slice(0, 10);
  // Note: this uses UTC date; we use ET-based dates in touches. Should be OK for most.
  if (!candlesByDate.has(date)) candlesByDate.set(date, []);
  candlesByDate.get(date).push(c);
}

const touches = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-with-structural.json`));
console.log(`Touches: ${touches.length.toLocaleString()}`);

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

// === Compute swing-structure features per touch ===
// For each touch, look back LOOKBACK_MIN minutes of 1m candles.
// Find the relevant swing extreme (high for resistance, low for support).
// Count rejections of that extreme.

const LOOKBACK_MIN = 30;

console.log(`\nComputing swing-structure features (lookback ${LOOKBACK_MIN}min)...`);
let countResolved = 0;
for (const t of touches) {
  const tsMs = t.ts;
  const isResist = RESIST_TYPES.has(t.level_type);
  const isSupp = SUPPORT_TYPES.has(t.level_type);
  const isFlip = t.level_type === 'gamma_flip';
  // Treat gamma_flip from_below as resistance setup, from_above as support
  let kind;
  if (isResist || (isFlip && t.approach === 'from_below')) kind = 'resistance';
  else if (isSupp || (isFlip && t.approach === 'from_above')) kind = 'support';
  else continue;

  // Pull last LOOKBACK_MIN minutes of 1m candles (excluding the current minute)
  const startTs = tsMs - LOOKBACK_MIN * 60_000;
  const priorCandles = [];
  let scanTs = tsMs - 60_000;
  while (scanTs >= startTs) {
    const c = candleByTs.get(scanTs);
    if (c) priorCandles.push(c);
    scanTs -= 60_000;
  }
  priorCandles.reverse();  // oldest first
  if (priorCandles.length < 5) continue;

  // Find swing high/low
  if (kind === 'resistance') {
    // Highest high in the lookback window
    const swingHigh = Math.max(...priorCandles.map(c => c.high));
    // Find how many bars touched within X pt of swingHigh AND closed below
    const REJ_RADIUS = 3;
    let rejections = 0;
    let lastRejTs = null;
    let testBars = 0;
    for (const c of priorCandles) {
      if (c.high >= swingHigh - REJ_RADIUS) {
        testBars++;
        if (c.close < swingHigh - 1) {
          rejections++;
          lastRejTs = c.ts;
        }
      }
    }
    // Is the current touch ALSO near the swing high?
    const currentCandle = candleByTs.get(tsMs);
    const currentNearSwing = currentCandle && currentCandle.high >= swingHigh - REJ_RADIUS;
    t.swing = {
      kind: 'resistance', swing_high: +swingHigh.toFixed(2),
      rejections, test_bars: testBars,
      current_near_swing: currentNearSwing,
      dist_to_swing: currentCandle ? +(swingHigh - currentCandle.high).toFixed(2) : null,
      structural_stop: +(swingHigh + 2).toFixed(2),  // stop 2pt above swing high (we'll tune)
      level_above_swing: t.level_price >= swingHigh - REJ_RADIUS,  // is the GEX level near/at the swing high?
    };
    countResolved++;
  } else {
    const swingLow = Math.min(...priorCandles.map(c => c.low));
    const REJ_RADIUS = 3;
    let rejections = 0;
    let lastRejTs = null;
    let testBars = 0;
    for (const c of priorCandles) {
      if (c.low <= swingLow + REJ_RADIUS) {
        testBars++;
        if (c.close > swingLow + 1) {
          rejections++;
          lastRejTs = c.ts;
        }
      }
    }
    const currentCandle = candleByTs.get(tsMs);
    const currentNearSwing = currentCandle && currentCandle.low <= swingLow + REJ_RADIUS;
    t.swing = {
      kind: 'support', swing_low: +swingLow.toFixed(2),
      rejections, test_bars: testBars,
      current_near_swing: currentNearSwing,
      dist_to_swing: currentCandle ? +(currentCandle.low - swingLow).toFixed(2) : null,
      structural_stop: +(swingLow - 2).toFixed(2),
      level_near_swing: t.level_price <= swingLow + REJ_RADIUS,
    };
    countResolved++;
  }
}
console.log(`Resolved swing features for ${countResolved.toLocaleString()} touches\n`);

// === Test: WR conditional on swing structure ===
function labelWalk(walk, target, stop, holdMin) {
  if (!walk) return 'no_data';
  const tt = walk.time_to_target_sec?.[target];
  const ts = walk.time_to_stop_sec?.[stop];
  const hs = holdMin * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}
function evalSet(arr, dirField, target, stop, holdMin) {
  let w = 0, l = 0, to = 0;
  for (const t of arr) {
    const o = labelWalk(t[dirField], target, stop, holdMin);
    if (o === 'win') w++;
    else if (o === 'loss') l++;
    else if (o === 'timeout') to++;
  }
  const n = w + l + to;
  return { n, w, l, to, wr: n > 0 ? w / n : 0, ev: n > 0 ? (w * target - l * stop) / n : 0 };
}
function p(label, arr, dirField, t, s, h) {
  if (arr.length < 30) return null;
  const r = evalSet(arr, dirField, t, s, h);
  console.log(`  ${label.padEnd(70)} n=${String(r.n).padStart(5)} W=${String(r.w).padStart(4)} L=${String(r.l).padStart(4)} TO=${String(r.to).padStart(3)} WR=${(r.wr*100).toFixed(1).padStart(5)}% EV=${r.ev.toFixed(2).padStart(6)}`);
  return r;
}

const resists = touches.filter(t => t.swing?.kind === 'resistance');
const supps = touches.filter(t => t.swing?.kind === 'support');

console.log(`Resistance setups with swing data: ${resists.length}`);
console.log(`Support setups with swing data: ${supps.length}\n`);

console.log('=== RESISTANCE (bounce SHORT) by rejections count of swing high in prior 30min ===');
for (const r of [0, 1, 2, 3, 4, 5]) {
  const arr = resists.filter(t => t.swing.rejections === r && t.swing.current_near_swing);
  if (arr.length < 30) continue;
  const e1 = evalSet(arr, 'bounce', 10, 5, 15);
  const e2 = evalSet(arr, 'bounce', 15, 10, 30);
  const e3 = evalSet(arr, 'bounce', 20, 12, 30);
  const e4 = evalSet(arr, 'bounce', 25, 15, 30);
  console.log(`  rejections=${r}: n=${String(arr.length).padStart(4)}  T10/S5/H15: WR=${(e1.wr*100).toFixed(1)}% EV=${e1.ev.toFixed(2)}  T15/S10/H30: WR=${(e2.wr*100).toFixed(1)}% EV=${e2.ev.toFixed(2)}  T20/S12/H30: WR=${(e3.wr*100).toFixed(1)}% EV=${e3.ev.toFixed(2)}  T25/S15/H30: WR=${(e4.wr*100).toFixed(1)}% EV=${e4.ev.toFixed(2)}`);
}

console.log('\n=== RESISTANCE (bounce SHORT) — rejections >= K AND current_near_swing ===');
for (const k of [1, 2, 3, 4]) {
  const arr = resists.filter(t => t.swing.rejections >= k && t.swing.current_near_swing);
  if (arr.length < 30) continue;
  const e1 = evalSet(arr, 'bounce', 10, 5, 15);
  const e2 = evalSet(arr, 'bounce', 15, 10, 30);
  const e3 = evalSet(arr, 'bounce', 20, 12, 30);
  const e4 = evalSet(arr, 'bounce', 25, 15, 30);
  console.log(`  rej>=${k}+at_swing: n=${String(arr.length).padStart(4)}  T10/S5/H15: WR=${(e1.wr*100).toFixed(1)}% EV=${e1.ev.toFixed(2)}  T15/S10/H30: WR=${(e2.wr*100).toFixed(1)}% EV=${e2.ev.toFixed(2)}  T20/S12/H30: WR=${(e3.wr*100).toFixed(1)}% EV=${e3.ev.toFixed(2)}  T25/S15/H30: WR=${(e4.wr*100).toFixed(1)}% EV=${e4.ev.toFixed(2)}`);
}

console.log('\n=== SUPPORT (bounce LONG) — rejections >= K AND current_near_swing ===');
for (const k of [1, 2, 3, 4]) {
  const arr = supps.filter(t => t.swing.rejections >= k && t.swing.current_near_swing);
  if (arr.length < 30) continue;
  const e1 = evalSet(arr, 'bounce', 10, 5, 15);
  const e2 = evalSet(arr, 'bounce', 15, 10, 30);
  const e3 = evalSet(arr, 'bounce', 20, 12, 30);
  const e4 = evalSet(arr, 'bounce', 25, 15, 30);
  console.log(`  rej>=${k}+at_swing: n=${String(arr.length).padStart(4)}  T10/S5/H15: WR=${(e1.wr*100).toFixed(1)}% EV=${e1.ev.toFixed(2)}  T15/S10/H30: WR=${(e2.wr*100).toFixed(1)}% EV=${e2.ev.toFixed(2)}  T20/S12/H30: WR=${(e3.wr*100).toFixed(1)}% EV=${e3.ev.toFixed(2)}  T25/S15/H30: WR=${(e4.wr*100).toFixed(1)}% EV=${e4.ev.toFixed(2)}`);
}

// === Also test: GEX level aligned with swing (the IDEAL setup) ===
console.log('\n=== RESISTANCE — swing high aligned with GEX level (level_above_swing) ===');
for (const k of [1, 2, 3]) {
  const arr = resists.filter(t => t.swing.rejections >= k && t.swing.current_near_swing && t.swing.level_above_swing);
  if (arr.length < 30) continue;
  const e2 = evalSet(arr, 'bounce', 15, 10, 30);
  const e3 = evalSet(arr, 'bounce', 20, 12, 30);
  const e4 = evalSet(arr, 'bounce', 25, 15, 30);
  console.log(`  rej>=${k}+at_swing+GEX_at_swing: n=${String(arr.length).padStart(4)}  T15/S10/H30: WR=${(e2.wr*100).toFixed(1)}% EV=${e2.ev.toFixed(2)}  T20/S12/H30: WR=${(e3.wr*100).toFixed(1)}% EV=${e3.ev.toFixed(2)}  T25/S15/H30: WR=${(e4.wr*100).toFixed(1)}% EV=${e4.ev.toFixed(2)}`);
}

// Save enriched
fs.writeFileSync(`${ROOT}/research/output/touches-with-swing.json`, JSON.stringify(touches.filter(t => t.swing)));
console.log(`\nSaved touches-with-swing.json`);
