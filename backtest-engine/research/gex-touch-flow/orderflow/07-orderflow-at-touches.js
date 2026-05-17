/**
 * Join the existing 27k GEX-touch dataset with the 1m OFI data and look
 * for two patterns at each touch:
 *
 *   A. EXHAUSTION-AT-LEVEL (reversal): N minutes of dominant one-side flow
 *      INTO the touch, where price hits the level. Trade against the flow
 *      (bounce). E.g. heavy sell flow → S1 touch → bounce long.
 *
 *   B. CONFIRMED-BREAK (continuation): heavy one-side flow + price PUSHES
 *      THROUGH the level in the same direction. Trade with the flow.
 *      E.g. heavy buy flow → push above R1 → long continuation.
 *
 * For each touch, compute OFI features in a configurable window leading up
 * to the touch, then condition WR on those features.
 *
 * Reuses Phase-1 touch dataset which has:
 *   - touch_id, ts, date, time_et, level_type, level_price, approach
 *   - features (1m): approach speed, volume, structural context
 *   - s1: 1s flow during touch minute
 *   - bounce / brk: forward walk MFE/MAE/time-to-target per direction
 */
import fs from 'fs';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const TOUCHES_PATH = `${ROOT}/research/output/gex-touch-flow-2026-05-14T05-52-19-372Z.json`;
const j = JSON.parse(fs.readFileSync(TOUCHES_PATH));
const touches = j.touches;
console.log(`Loaded ${touches.length.toLocaleString()} touches`);

const ofiJoined = JSON.parse(fs.readFileSync(`${ROOT}/research/output/ofi-nq-joined.json`)).joined;
console.log(`Loaded ${ofiJoined.length.toLocaleString()} OFI 1m rows`);

// Build minute -> ofi map (with sign correction)
const ofiByTs = new Map();
for (const r of ofiJoined) {
  ofiByTs.set(r.ts, {
    signedFlow: -r.netVolume,
    volImb: -r.volumeImbalance,
    tradeImb: -r.tradeImbalance,
    bookSizeImb: r.sizeImbalance,
    bookCountImb: r.countImbalance,
    totalVolume: r.totalVolume,
    close: r.close,
  });
}
console.log(`OFI minutes indexed: ${ofiByTs.size.toLocaleString()}`);

// Enrich each touch with OFI features
let touchesWithOFI = 0;
for (const t of touches) {
  const minuteTs = Math.floor(t.ts / 60000) * 60000;
  const o0 = ofiByTs.get(minuteTs);  // OFI at touch minute
  if (!o0) continue;
  touchesWithOFI++;

  t.ofi = {
    touch: o0,
    // lead-in windows
    sum_5m_pre: 0,
    sum_10m_pre: 0,
    sum_15m_pre: 0,
    minutes_5m: 0,
    minutes_10m: 0,
    minutes_15m: 0,
    pre1: ofiByTs.get(minuteTs - 60_000) || null,
    pre3: ofiByTs.get(minuteTs - 3 * 60_000) || null,
    pre5: ofiByTs.get(minuteTs - 5 * 60_000) || null,
    // post (in case we want to see what happens immediately after)
    post1: ofiByTs.get(minuteTs + 60_000) || null,
  };

  // Sum prior signedFlow across windows
  for (let m = 1; m <= 15; m++) {
    const o = ofiByTs.get(minuteTs - m * 60_000);
    if (!o) continue;
    if (m <= 5) { t.ofi.sum_5m_pre += o.signedFlow; t.ofi.minutes_5m++; }
    if (m <= 10) { t.ofi.sum_10m_pre += o.signedFlow; t.ofi.minutes_10m++; }
    if (m <= 15) { t.ofi.sum_15m_pre += o.signedFlow; t.ofi.minutes_15m++; }
  }

  // Persistence: count of consecutive same-sign signedFlow bars BEFORE touch
  let posStreak = 0, negStreak = 0;
  for (let m = 1; m <= 15; m++) {
    const o = ofiByTs.get(minuteTs - m * 60_000);
    if (!o) break;
    if (o.signedFlow > 30 && negStreak === 0) posStreak++;
    else if (o.signedFlow < -30 && posStreak === 0) negStreak++;
    else break;
  }
  t.ofi.consec_buy_streak = posStreak;
  t.ofi.consec_sell_streak = negStreak;

  // Volume regime: was total volume elevated in last 5 min?
  let vol5 = 0, n5 = 0;
  for (let m = 1; m <= 5; m++) {
    const o = ofiByTs.get(minuteTs - m * 60_000);
    if (o) { vol5 += o.totalVolume; n5++; }
  }
  t.ofi.avg_vol_5m_pre = n5 > 0 ? vol5 / n5 : 0;
}
console.log(`Touches enriched with OFI: ${touchesWithOFI.toLocaleString()}`);

// === Outcome labeling helpers ===
function label(t, dir, target, stop, holdMin) {
  const w = dir === 'bounce' ? t.bounce : t.brk;
  if (!w) return 'no_data';
  const tt = w.time_to_target_sec?.[target];
  const ts = w.time_to_stop_sec?.[stop];
  const hs = holdMin * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}

function summarize(arr, dir, target, stop, hold) {
  const lbls = arr.map(t => label(t, dir, target, stop, hold));
  const w = lbls.filter(l => l === 'win').length;
  const l = lbls.filter(l => l === 'loss').length;
  const to = lbls.filter(l => l === 'timeout').length;
  const wr = arr.length > 0 ? w / arr.length : 0;
  const ev = (w * target - l * stop) / Math.max(1, arr.length);
  return { n: arr.length, w, l, to, wr, ev };
}

function p(label, arr, dir, t, s, h) {
  const r = summarize(arr, dir, t, s, h);
  if (r.n < 20) return false;
  console.log(`  ${label.padEnd(70)} n=${String(r.n).padStart(4)}  T${t}/S${s}: ${String(r.w).padStart(3)}/${String(r.l).padStart(3)} WR=${(r.wr*100).toFixed(1).padStart(5)}% EV=${r.ev.toFixed(2).padStart(6)}`);
  return true;
}

// Filter to touches WITH OFI data
const validTouches = touches.filter(t => t.ofi);
console.log(`\nValid touches with OFI: ${validTouches.length.toLocaleString()}\n`);

// ===========================================================================
// PATTERN A: SELL-EXHAUSTION INTO SUPPORT (bull setup)
// ===========================================================================
console.log(`=== PATTERN A: Sell flow into SUPPORT → bounce long (T10/S5/H15) ===`);
const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall','gamma_flip']);
const supportFromAbove = validTouches.filter(t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above');
p('All support touches from_above (baseline)', supportFromAbove, 'bounce', 10, 5, 15);

console.log(`\n  Lead-in OFI conditions:`);
for (const cond of [
  ['sum_5m_pre < -100 (sustained sell 5m)', e => e.ofi.sum_5m_pre < -100],
  ['sum_5m_pre < -200', e => e.ofi.sum_5m_pre < -200],
  ['sum_5m_pre < -400', e => e.ofi.sum_5m_pre < -400],
  ['sum_5m_pre < -800', e => e.ofi.sum_5m_pre < -800],
  ['sum_10m_pre < -500', e => e.ofi.sum_10m_pre < -500],
  ['sum_10m_pre < -1000', e => e.ofi.sum_10m_pre < -1000],
  ['consec_sell_streak >= 3', e => e.ofi.consec_sell_streak >= 3],
  ['consec_sell_streak >= 5', e => e.ofi.consec_sell_streak >= 5],
  ['touch_minute signedFlow < -100 (still selling)', e => e.ofi.touch.signedFlow < -100],
  ['touch_minute signedFlow < -200', e => e.ofi.touch.signedFlow < -200],
  ['touch_minute signedFlow > 0 (REVERSED)', e => e.ofi.touch.signedFlow > 0],
  ['touch + post1 both positive (reversal confirmed)', e => e.ofi.touch.signedFlow > 0 && e.ofi.post1 && e.ofi.post1.signedFlow > 0],
]) {
  const arr = supportFromAbove.filter(cond[1]);
  p(cond[0], arr, 'bounce', 10, 5, 15);
}

console.log(`\n  Combined conditions (sell flow into support, then reversal hint):`);
for (const cond of [
  ['5m_pre<-200 + touch>=0 (sell into level, then flat/buy)', e => e.ofi.sum_5m_pre < -200 && e.ofi.touch.signedFlow >= 0],
  ['5m_pre<-400 + touch>=0', e => e.ofi.sum_5m_pre < -400 && e.ofi.touch.signedFlow >= 0],
  ['5m_pre<-200 + touch>=0 + post1>0', e => e.ofi.sum_5m_pre < -200 && e.ofi.touch.signedFlow >= 0 && e.ofi.post1?.signedFlow > 0],
  ['5m_pre<-200 + touch>0', e => e.ofi.sum_5m_pre < -200 && e.ofi.touch.signedFlow > 0],
  ['consec_sell>=3 + touch>=0', e => e.ofi.consec_sell_streak >= 3 && e.ofi.touch.signedFlow >= 0],
  ['consec_sell>=3 + touch>0', e => e.ofi.consec_sell_streak >= 3 && e.ofi.touch.signedFlow > 0],
]) {
  const arr = supportFromAbove.filter(cond[1]);
  p(cond[0], arr, 'bounce', 10, 5, 15);
}

// ===========================================================================
// PATTERN B: BUY-EXHAUSTION INTO RESISTANCE (bear setup)
// ===========================================================================
console.log(`\n=== PATTERN B: Buy flow into RESISTANCE → fade short (T10/S5/H15) ===`);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall','gamma_flip']);
const resistFromBelow = validTouches.filter(t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below');
p('All resistance touches from_below (baseline)', resistFromBelow, 'bounce', 10, 5, 15);
for (const cond of [
  ['sum_5m_pre > 200', e => e.ofi.sum_5m_pre > 200],
  ['sum_5m_pre > 400', e => e.ofi.sum_5m_pre > 400],
  ['sum_5m_pre > 800', e => e.ofi.sum_5m_pre > 800],
  ['consec_buy_streak >= 3', e => e.ofi.consec_buy_streak >= 3],
  ['touch_minute signedFlow > 100', e => e.ofi.touch.signedFlow > 100],
  ['touch_minute < 0 (reversed)', e => e.ofi.touch.signedFlow < 0],
  ['5m_pre>200 + touch<=0', e => e.ofi.sum_5m_pre > 200 && e.ofi.touch.signedFlow <= 0],
  ['5m_pre>400 + touch<=0', e => e.ofi.sum_5m_pre > 400 && e.ofi.touch.signedFlow <= 0],
  ['consec_buy>=3 + touch<=0', e => e.ofi.consec_buy_streak >= 3 && e.ofi.touch.signedFlow <= 0],
]) {
  const arr = resistFromBelow.filter(cond[1]);
  p(cond[0], arr, 'bounce', 10, 5, 15);
}

// ===========================================================================
// PATTERN C: CONFIRMED BREAK THROUGH RESISTANCE (long continuation)
// ===========================================================================
console.log(`\n=== PATTERN C: Buy flow + break through RESISTANCE → long continuation ===`);
// For break direction: long entry when touch is from_below at resistance and price BROKE through
// Approach=from_below + level=resistance → BREAK trade is the SAME direction as approach = LONG
const resistBreakable = validTouches.filter(t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below');
p('All resistance touches from_below (break/long baseline)', resistBreakable, 'break', 10, 5, 15);

for (const cond of [
  ['sum_5m_pre > 200 (buying into break)', e => e.ofi.sum_5m_pre > 200],
  ['sum_5m_pre > 400', e => e.ofi.sum_5m_pre > 400],
  ['sum_5m_pre > 600', e => e.ofi.sum_5m_pre > 600],
  ['sum_5m_pre > 800', e => e.ofi.sum_5m_pre > 800],
  ['touch_minute signedFlow > 100', e => e.ofi.touch.signedFlow > 100],
  ['touch_minute signedFlow > 200', e => e.ofi.touch.signedFlow > 200],
  ['consec_buy_streak >= 3', e => e.ofi.consec_buy_streak >= 3],
  ['consec_buy_streak >= 5', e => e.ofi.consec_buy_streak >= 5],
  ['5m_pre>200 + touch>100 (sustained buying)', e => e.ofi.sum_5m_pre > 200 && e.ofi.touch.signedFlow > 100],
  ['5m_pre>400 + touch>200', e => e.ofi.sum_5m_pre > 400 && e.ofi.touch.signedFlow > 200],
  ['consec_buy>=3 + touch>100', e => e.ofi.consec_buy_streak >= 3 && e.ofi.touch.signedFlow > 100],
]) {
  const arr = resistBreakable.filter(cond[1]);
  p(cond[0], arr, 'break', 10, 5, 15);
}

// ===========================================================================
// PATTERN D: CONFIRMED BREAK THROUGH SUPPORT (short continuation)
// ===========================================================================
console.log(`\n=== PATTERN D: Sell flow + break through SUPPORT → short continuation ===`);
const supportBreakable = validTouches.filter(t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above');
p('All support touches from_above (break/short baseline)', supportBreakable, 'break', 10, 5, 15);

for (const cond of [
  ['sum_5m_pre < -200', e => e.ofi.sum_5m_pre < -200],
  ['sum_5m_pre < -400', e => e.ofi.sum_5m_pre < -400],
  ['sum_5m_pre < -800', e => e.ofi.sum_5m_pre < -800],
  ['touch_minute signedFlow < -100', e => e.ofi.touch.signedFlow < -100],
  ['touch_minute signedFlow < -200', e => e.ofi.touch.signedFlow < -200],
  ['consec_sell_streak >= 3', e => e.ofi.consec_sell_streak >= 3],
  ['5m_pre<-200 + touch<-100', e => e.ofi.sum_5m_pre < -200 && e.ofi.touch.signedFlow < -100],
  ['5m_pre<-400 + touch<-200', e => e.ofi.sum_5m_pre < -400 && e.ofi.touch.signedFlow < -200],
]) {
  const arr = supportBreakable.filter(cond[1]);
  p(cond[0], arr, 'break', 10, 5, 15);
}

// ===========================================================================
// PATTERN E: ABSORPTION (high volume, no price move, then break)
// ===========================================================================
console.log(`\n=== PATTERN E: ABSORPTION at level — high flow + small concurrent move + reversal ===`);
// At support: lots of selling but price holds at level, then reverses up
const ALL_SUPPORTS = validTouches.filter(t => SUPPORT_TYPES.has(t.level_type));
const ALL_RESISTS = validTouches.filter(t => RESIST_TYPES.has(t.level_type));

console.log(`\n  Support absorption (long bounce):`);
for (const cond of [
  ['touch signedFlow < -200 + close_dist_from_level small', e => e.ofi.touch.signedFlow < -200 && Math.abs(e.features.close_dist_from_level) <= 3],
  ['touch signedFlow < -400 + close_dist_from_level small', e => e.ofi.touch.signedFlow < -400 && Math.abs(e.features.close_dist_from_level) <= 3],
  ['post1 signedFlow flipped to positive', e => e.ofi.touch.signedFlow < -100 && e.ofi.post1?.signedFlow > 50],
]) {
  const arr = ALL_SUPPORTS.filter(cond[1]);
  p(cond[0], arr, 'bounce', 10, 5, 15);
}

console.log(`\n  Resistance absorption (short rejection):`);
for (const cond of [
  ['touch signedFlow > 200 + close_dist_from_level small', e => e.ofi.touch.signedFlow > 200 && Math.abs(e.features.close_dist_from_level) <= 3],
  ['touch signedFlow > 400 + close_dist_from_level small', e => e.ofi.touch.signedFlow > 400 && Math.abs(e.features.close_dist_from_level) <= 3],
  ['post1 signedFlow flipped to negative', e => e.ofi.touch.signedFlow > 100 && e.ofi.post1?.signedFlow < -50],
]) {
  const arr = ALL_RESISTS.filter(cond[1]);
  p(cond[0], arr, 'bounce', 10, 5, 15);
}

// ===========================================================================
// PATTERN F: Reverse trend — high prior volume into level then flow flips
// ===========================================================================
console.log(`\n=== PATTERN F: Flow REVERSAL at level (high WR setup hopefully) ===`);
for (const cond of [
  ['SUPPORT: 5m_pre<-300 + touch>=0 (clear flush + hold)', e => SUPPORT_TYPES.has(e.level_type) && e.ofi.sum_5m_pre < -300 && e.ofi.touch.signedFlow >= 0],
  ['SUPPORT: 5m_pre<-300 + touch>0', e => SUPPORT_TYPES.has(e.level_type) && e.ofi.sum_5m_pre < -300 && e.ofi.touch.signedFlow > 0],
  ['SUPPORT: 5m_pre<-300 + touch>0 + post1>0', e => SUPPORT_TYPES.has(e.level_type) && e.ofi.sum_5m_pre < -300 && e.ofi.touch.signedFlow > 0 && e.ofi.post1?.signedFlow > 0],
  ['SUPPORT: consec_sell>=5 + touch>=0', e => SUPPORT_TYPES.has(e.level_type) && e.ofi.consec_sell_streak >= 5 && e.ofi.touch.signedFlow >= 0],
  ['RESIST: 5m_pre>300 + touch<=0', e => RESIST_TYPES.has(e.level_type) && e.ofi.sum_5m_pre > 300 && e.ofi.touch.signedFlow <= 0],
  ['RESIST: consec_buy>=5 + touch<=0', e => RESIST_TYPES.has(e.level_type) && e.ofi.consec_buy_streak >= 5 && e.ofi.touch.signedFlow <= 0],
]) {
  // bounce direction at support = long; at resist = short = also "bounce" in our model
  const arr = validTouches.filter(cond[1]);
  p(cond[0], arr, 'bounce', 10, 5, 15);
}

// Save enriched touches
fs.writeFileSync(`${ROOT}/research/output/touches-with-ofi.json`, JSON.stringify({
  touches: validTouches.map(t => ({
    touch_id: t.touch_id, ts: t.ts, date: t.date, time_et: t.time_et,
    level_type: t.level_type, level_price: t.level_price, approach: t.approach,
    features: t.features, ofi: t.ofi, bounce: t.bounce, brk: t.brk,
  })),
}));
console.log(`\nSaved: touches-with-ofi.json`);
