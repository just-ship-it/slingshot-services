// Phase 9 — IN-TRADE IV dynamics as a LEADING signal (not price points).
// Question: as a trade unfolds, does ATM IV (QQQ 1m, the NQ proxy) moving toward/against the
// position predict the eventual outcome — AND does it add information BEYOND current price?
//
// The script-12 lesson: a signal is only actionable if it LEADS price, not coincides. So we
// CONTROL FOR current unrealized P/L at the checkpoint and ask whether IV direction still
// separates eventual winners from losers WITHIN the same price bucket. If yes → IV leads.
//
// IV-favorable convention: rising IV is bearish (good for shorts, bad for longs).
//   favIV = (side==='short' ? +ΔIV : −ΔIV).  favIV>0 ⇒ vol moved in the position's favor.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { etParts } from './lib/et.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CSV = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv');
const IDXF = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.index.json');
const IVF = path.resolve(ROOT, 'data/iv/qqq/qqq_atm_iv_1m.csv');
const CHECK = 20; // minutes into trade

// ---- load 1m IV series ----
const ivLines = fs.readFileSync(IVF, 'utf8').trim().split('\n');
const ivTs = [], ivVal = [], skewVal = []; // skew = put_iv - call_iv (cols 5,4)
for (let i = 1; i < ivLines.length; i++) {
  const c = ivLines[i].split(','); const t = Date.parse(c[0]); const v = +c[1];
  if (isFinite(t) && isFinite(v)) { ivTs.push(t); ivVal.push(v); skewVal.push((+c[5]) - (+c[4])); }
}
console.log(`IV 1m series: ${ivTs.length} pts, ${new Date(ivTs[0]).toISOString().slice(0,10)} → ${new Date(ivTs[ivTs.length-1]).toISOString().slice(0,10)}`);
// forward-fill lookup: latest IV at or before ts, within 10min staleness
function ivAt(ts) {
  let lo = 0, hi = ivTs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ivTs[m] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans < 0) return null;
  if (ts - ivTs[ans] > 10 * 60000) return null; // stale (outside options hours)
  return ivVal[ans];
}
function skewAt(ts) {
  let lo = 0, hi = ivTs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ivTs[m] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans < 0 || ts - ivTs[ans] > 10 * 60000 || !isFinite(skewVal[ans])) return null;
  return skewVal[ans];
}

// ---- load big-3 trades ----
const FILES = { glx: 'gex-lt-3m-crossover-v3.json', gfi: 'gex-flip-ivpct-v2.json', glf: 'gex-level-fade-v2.json' };
const normSide = s => { const l = String(s).toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : 'short'; };
const trades = [];
for (const [k, f] of Object.entries(FILES)) {
  for (const t of JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gold-standard', f), 'utf8')).trades) {
    if (t.status !== 'completed' || t.entryTime == null) continue;
    const entry = t.actualEntry ?? t.entryPrice; if (entry == null) continue;
    trades.push({ k, side: normSide(t.side), entryTs: t.entryTime, exitTs: t.exitTime, entry,
      finalPts: t.pointsPnL, contract: t.signalContract ?? t.signal?.signalContract });
  }
}

// ---- price unrealized at checkpoint (1s) ----
const idx = JSON.parse(fs.readFileSync(IDXF, 'utf8')).minutes;
const fd = fs.openSync(CSV, 'r');
function unrlAt(t, minute) {
  const target = t.entryTs + minute * 60000;
  if (target > t.exitTs) return null; // already closed
  const mk = Math.floor(target / 60000) * 60000;
  for (const m of [mk, mk - 60000, mk + 60000]) {
    const meta = idx[m]; if (!meta) continue;
    const buf = Buffer.allocUnsafe(meta.length); fs.readSync(fd, buf, 0, meta.length, meta.offset);
    let best = null, bestD = Infinity;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue; const c = line.split(',');
      if (c[9] !== t.contract) continue; const bts = Date.parse(c[0]); const d = Math.abs(bts - target);
      if (d < bestD) { bestD = d; best = +c[7]; }
    }
    if (best != null) return t.side === 'long' ? best - t.entry : t.entry - best;
  }
  return null;
}

let kept = 0;
for (const t of trades) {
  const iv0 = ivAt(t.entryTs), ivM = ivAt(t.entryTs + CHECK * 60000);
  t.unrl = unrlAt(t, CHECK);
  t._u15 = unrlAt(t, 15); // for the lead-lag test
  if (iv0 == null || ivM == null || t.unrl == null) { t.skip = true; continue; }
  t.dIV = ivM - iv0;                                   // raw IV change (vol points)
  t.favIV = (t.side === 'short' ? t.dIV : -t.dIV);     // >0 ⇒ vol moved in position's favor
  kept++;
}
fs.closeSync(fd);

const open = trades.filter(t => !t.skip);
const win = t => t.finalPts > 0;
const pct = x => (x * 100).toFixed(0) + '%';
const wr = a => a.length ? a.filter(win).length / a.length : 0;
const avg = a => a.length ? a.reduce((s, t) => s + t.finalPts, 0) / a.length : 0;

console.log(`\nUsable trades (IV+price at ${CHECK}min): ${open.length}/${trades.length}`);
console.log(`Baseline WR ${pct(wr(open))}  avgFinal ${avg(open).toFixed(1)}pt\n`);

// (1) raw: does favIV alone correlate with outcome?
console.log('(1) RAW — split by IV direction at checkpoint (uncontrolled):');
for (const [lbl, fn] of [['favIV > 0 (vol toward us)', t => t.favIV > 0.002], ['|favIV| ~ 0', t => Math.abs(t.favIV) <= 0.002], ['favIV < 0 (vol against us)', t => t.favIV < -0.002]]) {
  const g = open.filter(fn); console.log(`   ${lbl.padEnd(26)} n=${String(g.length).padStart(4)}  WR ${pct(wr(g)).padStart(4)}  avgFinal ${avg(g).toFixed(1).padStart(7)}pt`);
}

// (2) CONTROLLED — within each price bucket, does favIV add separation? (coincident check)
console.log('\n(2) CONTROLLED for current price (COINCIDENT window) — IV split within price bucket:');
const priceBuckets = [['underwater (unrl<-10)', t => t.unrl < -10], ['flat (-10..+10)', t => t.unrl >= -10 && t.unrl <= 10], ['green (unrl>+10)', t => t.unrl > 10]];
for (const [plbl, pfn] of priceBuckets) {
  const pg = open.filter(pfn);
  const ivUp = pg.filter(t => t.favIV > 0.002), ivDn = pg.filter(t => t.favIV < -0.002);
  console.log(`   ${plbl.padEnd(22)} (n=${pg.length}, WR ${pct(wr(pg))}):`);
  console.log(`       IV toward us  n=${String(ivUp.length).padStart(3)}  WR ${pct(wr(ivUp)).padStart(4)}  avgFinal ${avg(ivUp).toFixed(1).padStart(7)}`);
  console.log(`       IV against us n=${String(ivDn.length).padStart(3)}  WR ${pct(wr(ivDn)).padStart(4)}  avgFinal ${avg(ivDn).toFixed(1).padStart(7)}`);
}

// (3) LEAD-LAG (the real test): IV change over [entry→+15] vs FUTURE price move [+15→exit],
//     controlling for the price move already seen by +15. If early IV predicts the LATER move
//     beyond early price → IV LEADS → actionable at minute 15.
console.log('\n(3) LEAD-LAG — early IV [entry→15min] predicting FUTURE move [15min→exit]:');
const fav = t => t._favIV15, futureMove = t => t.finalPts - t._unrl15;
const futPos = a => a.length ? a.filter(t => futureMove(t) > 0).length / a.length : 0;
const futAvg = a => a.length ? a.reduce((s, t) => s + futureMove(t), 0) / a.length : 0;
const ll = trades.filter(t => {
  if (t.exitTs == null || (t.entryTs + 15 * 60000) > t.exitTs) return false;
  const i0 = ivAt(t.entryTs), i15 = ivAt(t.entryTs + 15 * 60000), u15 = t._u15;
  if (i0 == null || i15 == null || u15 == null) return false;
  t._favIV15 = (t.side === 'short' ? (i15 - i0) : -(i15 - i0));
  t._unrl15 = u15; return true;
});
console.log(`   lead-lag sample: ${ll.length} trades (open ≥15min, IV+price available)`);
for (const [plbl, pfn] of [['price@15 underwater (<-10)', t => t._unrl15 < -10], ['price@15 flat (-10..10)', t => t._unrl15 >= -10 && t._unrl15 <= 10], ['price@15 green (>+10)', t => t._unrl15 > 10]]) {
  const pg = ll.filter(pfn); if (pg.length < 10) { console.log(`   ${plbl}: n=${pg.length} (too few)`); continue; }
  const up = pg.filter(t => fav(t) > 0.002), dn = pg.filter(t => fav(t) < -0.002);
  console.log(`   ${plbl.padEnd(26)} (n=${pg.length}): future move avg ${futAvg(pg).toFixed(1)}pt`);
  console.log(`       early IV toward us  n=${String(up.length).padStart(3)}  P(future>0) ${pct(futPos(up)).padStart(4)}  avgFuture ${futAvg(up).toFixed(1).padStart(7)}pt`);
  console.log(`       early IV against us n=${String(dn.length).padStart(3)}  P(future>0) ${pct(futPos(dn)).padStart(4)}  avgFuture ${futAvg(dn).toFixed(1).padStart(7)}pt`);
}

// (4) SKEW LEAD-LAG: early put-skew change [entry→15] predicting FUTURE move [15→exit].
//     Rising put-skew (put_iv>call_iv growing) is bearish → favorable for shorts.
console.log('\n(4) LEAD-LAG — early IV-SKEW [entry→15min] predicting FUTURE move [15min→exit]:');
const sll = ll.filter(t => {
  const s0 = skewAt(t.entryTs), s15 = skewAt(t.entryTs + 15*60000);
  if (s0 == null || s15 == null) return false;
  t._favSk = (t.side === 'short' ? (s15 - s0) : -(s15 - s0)); // >0 ⇒ skew moved toward position
  return true;
});
const fm = t => t.finalPts - t._unrl15;
const fpos = a => a.length ? a.filter(t => fm(t) > 0).length / a.length : 0;
const favg = a => a.length ? a.reduce((s,t)=>s+fm(t),0)/a.length : 0;
console.log(`   skew lead-lag sample: ${sll.length} trades`);
for (const [plbl, pfn] of [['price@15 underwater (<-10)', t=>t._unrl15<-10], ['price@15 flat (-10..10)', t=>t._unrl15>=-10&&t._unrl15<=10], ['price@15 green (>+10)', t=>t._unrl15>10]]) {
  const pg = sll.filter(pfn); if (pg.length<10){console.log(`   ${plbl}: n=${pg.length} (too few)`);continue;}
  const up = pg.filter(t=>t._favSk>0.003), dn = pg.filter(t=>t._favSk<-0.003);
  console.log(`   ${plbl.padEnd(26)} (n=${pg.length}):`);
  console.log(`       skew toward us  n=${String(up.length).padStart(3)}  P(future>0) ${(fpos(up)*100).toFixed(0).padStart(3)}%  avgFuture ${favg(up).toFixed(1).padStart(7)}pt`);
  console.log(`       skew against us n=${String(dn.length).padStart(3)}  P(future>0) ${(fpos(dn)*100).toFixed(0).padStart(3)}%  avgFuture ${favg(dn).toFixed(1).padStart(7)}pt`);
}
