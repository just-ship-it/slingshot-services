/**
 * Layer GEX levels onto exhaustion events.
 * - Pull GEX snap (with snap_lag=16min) at each event
 * - Find nearest level
 * - Check if exhaustion happened at/near a structural level
 * - Test if confluence boosts WR
 */
import fs from 'fs';
import path from 'path';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const ev = JSON.parse(fs.readFileSync(`${ROOT}/research/output/exhaustion-enriched.json`)).events;
console.log(`Loaded ${ev.length} exhaustion events`);

// Helper to load GEX snapshot per date (memoized)
const gexCache = new Map();
function loadGexDay(dateStr) {
  if (gexCache.has(dateStr)) return gexCache.get(dateStr);
  const filePath = `${ROOT}/data/gex/nq-cbbo/nq_gex_${dateStr}.json`;
  if (!fs.existsSync(filePath)) { gexCache.set(dateStr, null); return null; }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  gexCache.set(dateStr, data.data || []);
  return data.data;
}
function snapAtOrBefore(snaps, ts) {
  if (!snaps) return null;
  let best = null, bestTs = -Infinity;
  for (const s of snaps) {
    const t = Date.parse(s.timestamp);
    if (t <= ts && t > bestTs) { best = s; bestTs = t; }
  }
  return best;
}
function extractLevels(snap) {
  if (!snap) return [];
  const out = [];
  if (snap.call_wall != null) out.push({ type: 'call_wall', price: snap.call_wall });
  if (snap.put_wall != null) out.push({ type: 'put_wall', price: snap.put_wall });
  if (snap.gamma_flip != null) out.push({ type: 'gamma_flip', price: snap.gamma_flip });
  if (Array.isArray(snap.resistance)) snap.resistance.forEach((p, i) => p != null && out.push({ type: `R${i+1}`, price: p }));
  if (Array.isArray(snap.support)) snap.support.forEach((p, i) => p != null && out.push({ type: `S${i+1}`, price: p }));
  return out;
}

const SNAP_LAG = 16 * 60_000;

// Enrich each event with GEX context
for (const e of ev) {
  const snaps = loadGexDay(e.date);
  const snap = snapAtOrBefore(snaps, e.entry_ts - SNAP_LAG);
  e.regime = snap?.regime ?? null;
  e.gamma_imbalance = snap?.gamma_imbalance ?? null;
  const levels = extractLevels(snap);
  // Nearest level to ENTRY price
  let nearest = null, nearestDist = Infinity;
  for (const lvl of levels) {
    if (lvl.price == null) continue;
    const d = Math.abs(e.entry_price - lvl.price);
    if (d < nearestDist) { nearestDist = d; nearest = lvl; }
  }
  e.nearest_level_type = nearest?.type ?? null;
  e.nearest_level_price = nearest?.price ?? null;
  e.nearest_level_dist = nearestDist === Infinity ? null : +nearestDist.toFixed(2);
  // Bullish exhaustion: did the wick touch a support level?
  if (e.type === 'bull' && levels.length) {
    const supports = levels.filter(l => /^S[1-5]$|put_wall|gamma_flip/.test(l.type));
    let touched = null;
    for (const lvl of supports) {
      if (lvl.price != null && Math.abs(lvl.price - e.entry_price) <= 15) {
        touched = lvl; break;
      }
    }
    e.bull_at_support = touched?.type ?? null;
  }
  if (e.type === 'bear' && levels.length) {
    const resists = levels.filter(l => /^R[1-5]$|call_wall|gamma_flip/.test(l.type));
    let touched = null;
    for (const lvl of resists) {
      if (lvl.price != null && Math.abs(lvl.price - e.entry_price) <= 15) {
        touched = lvl; break;
      }
    }
    e.bear_at_resist = touched?.type ?? null;
  }
}

function rate(arr, field) {
  const w = arr.filter(e => e[field].outcome === 'win').length;
  const l = arr.filter(e => e[field].outcome === 'loss').length;
  const to = arr.filter(e => e[field].outcome === 'timeout').length;
  return { n: arr.length, w, l, to, wr: arr.length > 0 ? w / arr.length : 0 };
}
function summary(label, arr) {
  if (arr.length === 0) { console.log(`  ${label.padEnd(60)} n=0`); return; }
  const r10 = rate(arr, 'r10');
  const r15 = rate(arr, 'r15');
  const r20 = rate(arr, 'r20');
  const ev10 = r10.w * 10 - r10.l * 5;
  const ev15 = r15.w * 15 - r15.l * 8;
  const ev20 = r20.w * 20 - r20.l * 10;
  console.log(`  ${label.padEnd(60)} n=${String(arr.length).padStart(3)}  T10/S5: ${(r10.wr*100).toFixed(0).padStart(2)}% EV=${(ev10/arr.length).toFixed(1).padStart(5)}  T15/S8: ${(r15.wr*100).toFixed(0).padStart(2)}% EV=${(ev15/arr.length).toFixed(1).padStart(5)}  T20/S10: ${(r20.wr*100).toFixed(0).padStart(2)}% EV=${(ev20/arr.length).toFixed(1).padStart(5)}`);
}

// === Run various filter combinations ===
const bulls = ev.filter(e => e.type === 'bull');
const bears = ev.filter(e => e.type === 'bear');

console.log(`\nBaselines:`);
summary('All bulls', bulls);
summary('All bears', bears);

console.log(`\n=== GEX confluence ===`);
summary('Bull at support level (S1-5/put_wall/gamma_flip <=15pt)', bulls.filter(e => e.bull_at_support));
summary('Bear at resist level (R1-5/call_wall/gamma_flip <=15pt)', bears.filter(e => e.bear_at_resist));

for (const t of ['put_wall', 'S1', 'S2', 'S3', 'S4', 'S5', 'gamma_flip']) {
  const arr = bulls.filter(e => e.bull_at_support === t);
  if (arr.length >= 10) summary(`Bull at ${t}`, arr);
}
for (const t of ['call_wall', 'R1', 'R2', 'R3', 'R4', 'R5', 'gamma_flip']) {
  const arr = bears.filter(e => e.bear_at_resist === t);
  if (arr.length >= 10) summary(`Bear at ${t}`, arr);
}

console.log(`\n=== Regime filtering ===`);
for (const reg of ['negative', 'strong_negative', 'neutral', 'positive', 'strong_positive']) {
  summary(`Bull in regime=${reg}`, bulls.filter(e => e.regime === reg));
  summary(`Bear in regime=${reg}`, bears.filter(e => e.regime === reg));
}

console.log(`\n=== Combined: bull at support + regime + TOD ===`);
summary('Bull at support + rth_aft', bulls.filter(e => e.bull_at_support && e.todBucket === 'rth_aft'));
summary('Bull at support + rth_open or rth_aft', bulls.filter(e => e.bull_at_support && (e.todBucket === 'rth_open' || e.todBucket === 'rth_aft')));
summary('Bull at support + regime=positive', bulls.filter(e => e.bull_at_support && e.regime === 'positive'));
summary('Bull at support + regime=negative', bulls.filter(e => e.bull_at_support && e.regime === 'negative'));
summary('Bull at support + strong hammer (wickRatio>0.5)', bulls.filter(e => e.bull_at_support && e.barRange > 0 && e.wickSize / e.barRange > 0.5));

console.log(`\n=== Bear combinations ===`);
summary('Bear at resist + rth_aft', bears.filter(e => e.bear_at_resist && e.todBucket === 'rth_aft'));
summary('Bear at resist + regime=positive', bears.filter(e => e.bear_at_resist && e.regime === 'positive'));
summary('Bear at resist + regime=negative', bears.filter(e => e.bear_at_resist && e.regime === 'negative'));

// === Cross-tab: bull_at_support × wick prominence × TOD (heat-map) ===
console.log(`\n=== Cross-tab: bull at support × wick (T10/S5 only) ===`);
const bullsAtS = bulls.filter(e => e.bull_at_support);
for (const wickCond of [
  ['any', () => true],
  ['wick>=0.4', e => e.barRange > 0 && e.wickSize / e.barRange >= 0.4],
  ['wick>=0.5', e => e.barRange > 0 && e.wickSize / e.barRange >= 0.5],
  ['wick>=0.6', e => e.barRange > 0 && e.wickSize / e.barRange >= 0.6],
]) {
  summary(`bull@support + wick ${wickCond[0]}`, bullsAtS.filter(wickCond[1]));
}

console.log(`\n=== TRIPLE filter ===`);
const tripleA = bulls.filter(e => e.bull_at_support && e.todBucket === 'rth_aft' && e.barRange > 0 && e.wickSize / e.barRange >= 0.5);
summary('Bull at support + rth_aft + strong hammer', tripleA);
const tripleB = bulls.filter(e => e.bull_at_support && (e.todBucket === 'rth_aft' || e.todBucket === 'rth_open' || e.todBucket === 'rth_morn') && e.barRange > 0 && e.wickSize / e.barRange >= 0.5);
summary('Bull at support + rth (open|morn|aft) + strong hammer', tripleB);
const tripleC = bulls.filter(e => e.bull_at_support && e.moveExtent >= 15 && e.barRange > 0 && e.wickSize / e.barRange >= 0.5);
summary('Bull at support + moveExtent>=15 + strong hammer', tripleC);

// Save
fs.writeFileSync(`${ROOT}/research/output/exhaustion-gex-enriched.json`, JSON.stringify({ events: ev }, null, 2));
console.log(`\nSaved`);
