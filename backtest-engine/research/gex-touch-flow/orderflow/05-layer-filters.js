/**
 * Take the winning 3m exhaustion config (K=2, threshold=150 per 3m bar)
 * and layer GEX/time/IV/structural filters. Goal: push WR from 41% to 60%+.
 */
import fs from 'fs';
import path from 'path';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const j = JSON.parse(fs.readFileSync(`${ROOT}/research/output/ofi-nq-joined.json`));
const rows1m = j.joined;

for (const r of rows1m) r.signedFlow = -r.netVolume;
let prevClose = null, prevTs = null;
for (const r of rows1m) {
  if (prevClose != null && r.ts - prevTs === 60_000) r.concurrentRet = r.close - prevClose;
  else r.concurrentRet = null;
  prevClose = r.close; prevTs = r.ts;
}

// Aggregate to 3-min
function aggregateTo(N) {
  const out = [];
  let bucket = null;
  for (const r of rows1m) {
    const bucketTs = Math.floor(r.ts / (N * 60_000)) * (N * 60_000);
    if (!bucket || bucket.ts !== bucketTs) {
      if (bucket) out.push(bucket);
      bucket = { ts: bucketTs, open: r.close, high: r.close, low: r.close, close: r.close,
                 volume: r.totalVolume, signedFlow: r.signedFlow, n: 1, lastTs: r.ts,
                 firstClose: r.close };
    } else {
      bucket.close = r.close;
      bucket.high = Math.max(bucket.high, r.close);
      bucket.low = Math.min(bucket.low, r.close);
      bucket.volume += r.totalVolume;
      bucket.signedFlow += r.signedFlow;
      bucket.n++;
      bucket.lastTs = r.ts;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

const TF = 3;
const SELL_THRESH = 50 * TF;  // 150 per bar
const K = 2;
const bars = aggregateTo(TF);
console.log(`${TF}m bars: ${bars.length.toLocaleString()}`);

// Detect exhaustion + capture rich context per event
function detect(bars) {
  const out = [];
  for (let i = K; i < bars.length; i++) {
    const cur = bars[i];
    const lookback = bars.slice(i - K, i);
    let consec = true;
    for (let j = 1; j < lookback.length; j++) {
      if (lookback[j].ts - lookback[j-1].ts !== TF * 60_000) { consec = false; break; }
    }
    if (!consec || cur.ts - lookback[lookback.length-1].ts !== TF * 60_000) continue;

    const allSell = lookback.every(b => b.signedFlow < -SELL_THRESH);
    const decl = lookback.every((b, k) => k === 0 || b.close <= lookback[k-1].close);
    const stillSell = cur.signedFlow < -SELL_THRESH;
    const heldOrUp = cur.close >= cur.open;
    const hammer = (cur.high - cur.low) > 0 && (cur.close - cur.low) / (cur.high - cur.low) >= 0.6;
    if (allSell && decl && stillSell && (heldOrUp || hammer)) {
      out.push({ type: 'bull', cur, lookback, idx: i });
    }

    const allBuy = lookback.every(b => b.signedFlow > SELL_THRESH);
    const rise = lookback.every((b, k) => k === 0 || b.close >= lookback[k-1].close);
    const stillBuy = cur.signedFlow > SELL_THRESH;
    const heldOrDown = cur.close <= cur.open;
    const invHam = (cur.high - cur.low) > 0 && (cur.high - cur.close) / (cur.high - cur.low) >= 0.6;
    if (allBuy && rise && stillBuy && (heldOrDown || invHam)) {
      out.push({ type: 'bear', cur, lookback, idx: i });
    }
  }
  return out;
}

const events = detect(bars);
console.log(`Detected ${events.length} exhaustion events`);

// Compute rich features per event
function toET(ms) {
  const d = new Date(ms);
  // approx EDT (UTC-4) for date in mid-year, EST (UTC-5) winter. Use simple offset table.
  // Simpler: use date.getUTC* and approximate
  // For features we just need time-of-day in ET — use a known anchor.
  // Use America/New_York via Date.toLocaleString (works in node):
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hours: et.getHours(), minutes: et.getMinutes(), date: et.toISOString().slice(0, 10), dow: et.getDay() };
}

const close1m = new Map();
for (const r of rows1m) close1m.set(r.ts, r.close);

// Build a structure for fast 1m row lookup
const rowsByTs = new Map();
for (const r of rows1m) rowsByTs.set(r.ts, r);

// Forward outcome (1m approximation)
function fwdOutcome(entryTs, entryPrice, dir, target, stop, holdMin) {
  for (let m = 1; m <= holdMin; m++) {
    const c = close1m.get(entryTs + (m - 1) * 60_000);
    if (c == null) continue;
    const fav = dir === 'long' ? c - entryPrice : entryPrice - c;
    const adv = dir === 'long' ? entryPrice - c : c - entryPrice;
    if (adv >= stop) return { outcome: 'loss', m, fav: -stop };
    if (fav >= target) return { outcome: 'win', m, fav: target };
  }
  return { outcome: 'timeout', m: holdMin, fav: null };
}

// Compute additional features per event
const enriched = events.map(e => {
  const et = toET(e.cur.lastTs);  // event "close time" approximately
  const entry_ts = e.cur.lastTs + 60_000;
  const entry_price = e.cur.close;
  const dir = e.type === 'bull' ? 'long' : 'short';
  // Outcome at T=10/S=5/H=15
  const r10 = fwdOutcome(entry_ts, entry_price, dir, 10, 5, 15);
  const r15 = fwdOutcome(entry_ts, entry_price, dir, 15, 8, 15);
  const r20 = fwdOutcome(entry_ts, entry_price, dir, 20, 10, 30);

  // 1m features at entry
  const entryRow = rowsByTs.get(entry_ts);

  // Context features
  // - total flow over the 3-bar (lookback + cur) window
  const allBars = [...e.lookback, e.cur];
  const totalFlow = allBars.reduce((s, b) => s + b.signedFlow, 0);
  const totalVol = allBars.reduce((s, b) => s + b.volume, 0);
  const moveExtent = e.type === 'bull'
    ? e.lookback[0].close - e.cur.low  // how far did price fall?
    : e.cur.high - e.lookback[0].close;
  const wickSize = e.type === 'bull'
    ? e.cur.low ? (Math.min(e.cur.open, e.cur.close) - e.cur.low) : 0
    : e.cur.high ? (e.cur.high - Math.max(e.cur.open, e.cur.close)) : 0;
  const barRange = e.cur.high - e.cur.low;

  // Time of day
  const todMin = et.hours * 60 + et.minutes;
  let todBucket;
  if (todMin < 540) todBucket = 'pre_rth_early';
  else if (todMin < 570) todBucket = 'pre_rth_late';
  else if (todMin < 600) todBucket = 'rth_open';
  else if (todMin < 720) todBucket = 'rth_morn';
  else if (todMin < 780) todBucket = 'rth_lunch';
  else if (todMin < 930) todBucket = 'rth_aft';
  else if (todMin < 960) todBucket = 'rth_close';
  else todBucket = 'after_rth';

  return {
    type: e.type, dir, entry_ts, entry_price,
    totalFlow, totalVol, moveExtent, wickSize, barRange,
    sellFlowCur: e.cur.signedFlow,
    sellFlowLB0: e.lookback[0].signedFlow,
    sellFlowLB1: e.lookback[1].signedFlow,
    barClosePos: barRange > 0 ? (e.cur.close - e.cur.low) / barRange : 0.5,
    bookSizeImb: entryRow?.sizeImbalance ?? null,
    bookCountImb: entryRow?.countImbalance ?? null,
    todMin, todBucket, dow: et.dow,
    date: et.date,
    r10, r15, r20,
  };
});

// === Outcome distributions ===
function rate(arr, field) {
  const w = arr.filter(e => e[field].outcome === 'win').length;
  const l = arr.filter(e => e[field].outcome === 'loss').length;
  const to = arr.filter(e => e[field].outcome === 'timeout').length;
  return { n: arr.length, w, l, to, wr: arr.length > 0 ? w / arr.length : 0 };
}

const bulls = enriched.filter(e => e.type === 'bull');
const bears = enriched.filter(e => e.type === 'bear');
console.log(`\nBulls (long exhaustion): ${bulls.length}  Bears (short exhaustion): ${bears.length}`);

function summary(label, arr) {
  const r10 = rate(arr, 'r10');
  const r15 = rate(arr, 'r15');
  const r20 = rate(arr, 'r20');
  console.log(`  ${label.padEnd(50)} n=${String(arr.length).padStart(4)}  T10/S5: ${String(r10.w).padStart(3)}/${String(r10.l).padStart(3)} WR=${(r10.wr*100).toFixed(1)}%   T15/S8: ${(r15.wr*100).toFixed(1)}%   T20/S10: ${(r20.wr*100).toFixed(1)}%`);
}

console.log(`\nBaseline by direction:`);
summary('All bulls', bulls);
summary('All bears', bears);
summary('All events', enriched);

// === Layer 1: TOD ===
console.log(`\n=== Layer: time of day ===`);
const TODS = ['pre_rth_early','pre_rth_late','rth_open','rth_morn','rth_lunch','rth_aft','rth_close','after_rth'];
for (const tod of TODS) {
  const arr = enriched.filter(e => e.todBucket === tod);
  if (arr.length >= 20) summary(tod, arr);
}

// === Layer: book imbalance ===
console.log(`\n=== Layer: book imbalance at entry (sign-corrected) ===`);
// Book sizeImbalance: positive = more bids, negative = more asks
// Note: do NOT sign-correct book imbalance — separate metric
for (const range of [
  ['sizeImb > +0.1 (lots more bids)', e => e.bookSizeImb != null && e.bookSizeImb > 0.1],
  ['sizeImb in (-0.1, +0.1)', e => e.bookSizeImb != null && e.bookSizeImb > -0.1 && e.bookSizeImb < 0.1],
  ['sizeImb < -0.1 (lots more asks)', e => e.bookSizeImb != null && e.bookSizeImb < -0.1],
]) {
  // For bulls (expecting up): want lots of bids supporting (positive size imb)
  const bullsArr = bulls.filter(range[1]);
  const bearsArr = bears.filter(range[1]);
  if (bullsArr.length >= 20) summary(`BULL + ${range[0]}`, bullsArr);
  if (bearsArr.length >= 20) summary(`BEAR + ${range[0]}`, bearsArr);
}

// === Layer: wick prominence (only "true hammers") ===
console.log(`\n=== Layer: wick prominence ===`);
for (const cond of [
  ['wickSize/range > 0.5 (strong hammer)', e => e.barRange > 0 && e.wickSize / e.barRange > 0.5],
  ['wickSize/range > 0.7 (very strong)', e => e.barRange > 0 && e.wickSize / e.barRange > 0.7],
  ['barRange > 5pt + strong hammer', e => e.barRange > 5 && e.wickSize / e.barRange > 0.5],
]) {
  const arr = enriched.filter(cond[1]);
  if (arr.length >= 20) summary(cond[0], arr);
}

// === Layer: move extent (deeper fall = more retail flush = bigger bounce?) ===
console.log(`\n=== Layer: move extent ===`);
for (const cond of [
  ['moveExtent < 10pt', e => e.moveExtent < 10],
  ['moveExtent 10-20pt', e => e.moveExtent >= 10 && e.moveExtent < 20],
  ['moveExtent 20-30pt', e => e.moveExtent >= 20 && e.moveExtent < 30],
  ['moveExtent >= 30pt (big flush)', e => e.moveExtent >= 30],
]) {
  const arr = enriched.filter(cond[1]);
  if (arr.length >= 20) summary(cond[0], arr);
}

// === Combine top filters ===
console.log(`\n=== Combinations ===`);
for (const cond of [
  ['strong hammer + rth_morn', e => e.barRange > 0 && e.wickSize / e.barRange > 0.5 && e.todBucket === 'rth_morn'],
  ['strong hammer + rth_morn or rth_aft', e => e.barRange > 0 && e.wickSize / e.barRange > 0.5 && (e.todBucket === 'rth_morn' || e.todBucket === 'rth_aft')],
  ['moveExtent 20-30pt + strong hammer', e => e.moveExtent >= 20 && e.moveExtent < 30 && e.barRange > 0 && e.wickSize / e.barRange > 0.5],
  ['moveExtent>=20pt + strong hammer + rth', e => e.moveExtent >= 20 && e.barRange > 0 && e.wickSize / e.barRange > 0.5 && e.todBucket.startsWith('rth')],
  ['BULL only + moveExtent>=15 + strong hammer', e => e.type === 'bull' && e.moveExtent >= 15 && e.barRange > 0 && e.wickSize / e.barRange > 0.5],
  ['BEAR only + moveExtent>=15 + strong hammer', e => e.type === 'bear' && e.moveExtent >= 15 && e.barRange > 0 && e.wickSize / e.barRange > 0.5],
]) {
  const arr = enriched.filter(cond[1]);
  if (arr.length >= 20) summary(cond[0], arr);
}

fs.writeFileSync(`${ROOT}/research/output/exhaustion-enriched.json`, JSON.stringify({ events: enriched }, null, 2));
console.log(`\nSaved: exhaustion-enriched.json (${enriched.length} events)`);
