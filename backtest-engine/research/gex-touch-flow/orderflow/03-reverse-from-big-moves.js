/**
 * Reverse-engineer: find every historical run where NQ moved >= MIN_MOVE pts
 * in WINDOW minutes. For each such episode, characterize the LEAD-IN — the
 * 3-10 minutes BEFORE the run started.
 *
 * Looking for signatures we can use to enter EARLY in such moves.
 * sign-corrected OFI: actual_buy_aggression = -netVolume (per concurrent r=-0.6)
 */
import fs from 'fs';
const j = JSON.parse(fs.readFileSync('/home/drew/projects/slingshot-services/backtest-engine/research/output/ofi-nq-joined.json'));
const rows = j.joined;
console.log(`Loaded ${rows.length.toLocaleString()} joined 1m rows`);

// Apply sign correction implicit in concurrent r=-0.6
for (const r of rows) {
  r.signedFlow = -r.netVolume;  // positive = real buy aggression
  r.signedImb = -r.volumeImbalance;
}
// Compute concurrent return (need rows sorted by ts — they are)
let prevClose = null, prevTs = null;
for (const r of rows) {
  if (prevClose != null && r.ts - prevTs === 60_000) r.concurrentRet = r.close - prevClose;
  else r.concurrentRet = null;
  prevClose = r.close; prevTs = r.ts;
}

// Validate sign correction
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}
const conc = rows.filter(r => Number.isFinite(r.concurrentRet) && Number.isFinite(r.signedFlow));
console.log(`Sign-corrected concurrent r (signedFlow vs ret): ${pearson(conc.map(r=>r.signedFlow), conc.map(r=>r.concurrentRet)).toFixed(3)}`);

// === Find big moves ===
// For each starting minute, look at price 15 min later. If +100pt or more in <=15min, mark as big run-up.
const WINDOW = 15;
const MIN_MOVE = 80;

// Build close lookup
const closeBy = new Map();
for (const r of rows) closeBy.set(r.ts, r.close);

const bigUps = [];
const bigDowns = [];
for (const r of rows) {
  let bestMfeUp = 0, bestMfeDn = 0, tMfeUp = null, tMfeDn = null;
  for (let m = 1; m <= WINDOW; m++) {
    const c = closeBy.get(r.ts + m * 60_000);
    if (c == null) continue;
    const moveUp = c - r.close;
    const moveDn = r.close - c;
    if (moveUp > bestMfeUp) { bestMfeUp = moveUp; tMfeUp = m; }
    if (moveDn > bestMfeDn) { bestMfeDn = moveDn; tMfeDn = m; }
  }
  if (bestMfeUp >= MIN_MOVE) bigUps.push({ startTs: r.ts, startClose: r.close, mfe: bestMfeUp, minToMfe: tMfeUp });
  if (bestMfeDn >= MIN_MOVE) bigDowns.push({ startTs: r.ts, startClose: r.close, mfe: bestMfeDn, minToMfe: tMfeDn });
}

console.log(`\nBig up-moves (>= ${MIN_MOVE}pt in <=${WINDOW}min): ${bigUps.length}`);
console.log(`Big down-moves: ${bigDowns.length}`);

// De-duplicate overlapping starts: keep one per ~10min episode
function dedupe(arr) {
  arr.sort((a, b) => a.startTs - b.startTs);
  const kept = [];
  let lastTs = -Infinity;
  for (const e of arr) {
    if (e.startTs - lastTs < 10 * 60_000) continue;
    kept.push(e);
    lastTs = e.startTs;
  }
  return kept;
}
const ups = dedupe(bigUps);
const downs = dedupe(bigDowns);
console.log(`After de-dup: ups=${ups.length}, downs=${downs.length}`);

// For each big-up episode, capture LEAD-IN: minutes -10 .. -1 before startTs
function buildLead(episodes, dir, label) {
  const lead = [];
  for (const e of episodes) {
    const slots = [];
    let ok = true;
    for (let m = -10; m < 0; m++) {
      const tts = e.startTs + m * 60_000;
      const r = rows.find(rr => rr.ts === tts);
      if (!r) { ok = false; break; }
      slots.push(r);
    }
    if (!ok) continue;
    lead.push({ episode: e, slots });
  }
  console.log(`\n=== LEAD-IN for ${label} (n=${lead.length}) ===`);
  // Aggregate stats per slot offset
  console.log(`offset signedFlow_avg  vol_avg   signedFlow>0_pct  concurrentRet_avg`);
  for (let m = -10; m < 0; m++) {
    const idx = m + 10;
    const vals = lead.map(l => l.slots[idx]);
    const sf = vals.map(v => v.signedFlow);
    const vol = vals.map(v => v.totalVolume);
    const ret = vals.map(v => v.concurrentRet).filter(Number.isFinite);
    const sfMean = sf.reduce((s, v) => s + v, 0) / sf.length;
    const sfPosPct = sf.filter(v => (dir === 'up' ? v > 0 : v < 0)).length / sf.length;
    const volMean = vol.reduce((s, v) => s + v, 0) / vol.length;
    const retMean = ret.reduce((s, v) => s + v, 0) / ret.length;
    console.log(`  t${m.toString().padStart(3)} ${sfMean.toFixed(1).padStart(13)} ${volMean.toFixed(0).padStart(8)}  ${(sfPosPct*100).toFixed(1).padStart(13)}%   ${retMean.toFixed(2).padStart(15)}`);
  }
  return lead;
}

const upsLead = buildLead(ups, 'up', 'BIG UP-MOVES');
const downsLead = buildLead(downs, 'down', 'BIG DOWN-MOVES');

// Now compare to RANDOM minutes (control group) - what does typical 10min look like?
console.log(`\n=== CONTROL: random 10-min windows ===`);
const sample = [];
for (let i = 0; i < 1000; i++) {
  const idx = Math.floor(Math.random() * (rows.length - 10));
  const slots = [];
  let ok = true;
  for (let m = 0; m < 10; m++) {
    if (rows[idx + m].ts - rows[idx].ts !== m * 60_000) { ok = false; break; }
    slots.push(rows[idx + m]);
  }
  if (ok) sample.push(slots);
}
const sfAll = sample.flatMap(s => s.map(r => r.signedFlow));
const sfMean = sfAll.reduce((s, v) => s + v, 0) / sfAll.length;
const sfPosPct = sfAll.filter(v => v > 0).length / sfAll.length;
const volAll = sample.flatMap(s => s.map(r => r.totalVolume));
const volMean = volAll.reduce((s, v) => s + v, 0) / volAll.length;
console.log(`Random 10-min slots: signedFlow_avg=${sfMean.toFixed(1)} vol_avg=${volMean.toFixed(0)} %positiveSF=${(sfPosPct*100).toFixed(1)}%`);

// Save the episodes for later use
fs.writeFileSync('/home/drew/projects/slingshot-services/backtest-engine/research/output/big-moves-leadin.json', JSON.stringify({
  config: { WINDOW, MIN_MOVE },
  ups: ups.slice(0, 50),
  downs: downs.slice(0, 50),
  upsLeadStats: upsLead.length,
  downsLeadStats: downsLead.length,
}, null, 2));
console.log('\nSaved sample episodes to big-moves-leadin.json');
