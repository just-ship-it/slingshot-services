/**
 * Check concurrent correlation (does OFI reflect what just happened?)
 * and test the ABSORPTION hypothesis:
 *   high OFI + small price move during minute = "big money accumulating, ready to push"
 */
import fs from 'fs';
const j = JSON.parse(fs.readFileSync('/home/drew/projects/slingshot-services/backtest-engine/research/output/ofi-nq-joined.json'));
const rows = j.joined;
console.log(`Loaded ${rows.length.toLocaleString()} joined 1m rows`);

// Compute concurrent 1m return: close[t] - close[t-1]
// Need to walk through rows in order. We don't have explicit close[t-1] but rows are sorted by ts.
let prevClose = null;
let prevTs = null;
for (const r of rows) {
  if (prevClose != null && r.ts - prevTs === 60_000) {
    r.concurrentRet = r.close - prevClose;
  } else {
    r.concurrentRet = null;
  }
  prevClose = r.close;
  prevTs = r.ts;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

const conc = rows.filter(r => Number.isFinite(r.concurrentRet) && Number.isFinite(r.netVolume));
console.log(`\nConcurrent correlations (n=${conc.length.toLocaleString()}):`);
const METRICS = ['netVolume', 'volumeImbalance', 'tradeImbalance', 'buyRatio',
                 'sizeImbalance', 'countImbalance', 'avgSizeImbalance', 'avgCountImbalance', 'bidAskRatio'];
for (const m of METRICS) {
  const xs = conc.map(r => r[m]);
  const ys = conc.map(r => r.concurrentRet);
  console.log(`  ${m.padEnd(20)} r = ${pearson(xs, ys).toFixed(3)}`);
}

// ABSORPTION TEST: high OFI + small price move during minute → forward continuation
// Bucket by absolute concurrent return × netVolume direction
console.log(`\n=== ABSORPTION HYPOTHESIS ===`);
console.log(`Premise: when OFI shows aggression but price barely moves, big money is`);
console.log(`absorbing — they'll push afterward. Test: filter for |1m_ret| <= X AND OFI sign Y.`);

const subset = rows.filter(r => Number.isFinite(r.concurrentRet) && Number.isFinite(r.netVolume) && Number.isFinite(r.fwd?.[5]));
console.log(`Working set: n=${subset.length.toLocaleString()}\n`);

function summarize(arr, retField = 'fwd', horizon = 5) {
  if (arr.length === 0) return null;
  const rets = arr.map(r => r[retField]?.[horizon]).filter(v => Number.isFinite(v));
  if (rets.length === 0) return null;
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  rets.sort((a, b) => a - b);
  const median = rets[Math.floor(rets.length / 2)];
  const pPos = rets.filter(r => r > 0).length / rets.length;
  const pBig = rets.filter(r => r > 10).length / rets.length;
  const pBigNeg = rets.filter(r => r < -10).length / rets.length;
  return { n: rets.length, mean, median, pPos, pBig, pBigNeg };
}

// Absorption: positive OFI (buying pressure) but small concurrent move (price absorbed)
console.log(`Absorption (positive OFI, small move) vs Confirmation (positive OFI + big move) for fwd 5min:`);
console.log(`Cell                                          n      mean   median  P(>0)  P(>10) P(<-10)`);

const cells = [
  { name: 'BIG_BUY_FLOW_SMALL_MOVE: nv>50, |ret|<3pt', pred: r => r.netVolume > 50 && Math.abs(r.concurrentRet) < 3 },
  { name: 'BIG_BUY_FLOW_MED_MOVE:   nv>50, |ret|in[3,8]',  pred: r => r.netVolume > 50 && Math.abs(r.concurrentRet) >= 3 && Math.abs(r.concurrentRet) < 8 },
  { name: 'BIG_BUY_FLOW_BIG_MOVE:   nv>50, ret>8',         pred: r => r.netVolume > 50 && r.concurrentRet >= 8 },
  { name: 'BIG_BUY_FLOW_DOWN_MOVE:  nv>50, ret<-3 (fade?)', pred: r => r.netVolume > 50 && r.concurrentRet <= -3 },
  { name: 'BIG_SELL_FLOW_SMALL_MOVE: nv<-50, |ret|<3pt',   pred: r => r.netVolume < -50 && Math.abs(r.concurrentRet) < 3 },
  { name: 'BIG_SELL_FLOW_MED_MOVE:   nv<-50, |ret|in[3,8]', pred: r => r.netVolume < -50 && Math.abs(r.concurrentRet) >= 3 && Math.abs(r.concurrentRet) < 8 },
  { name: 'BIG_SELL_FLOW_BIG_MOVE:   nv<-50, ret<-8',      pred: r => r.netVolume < -50 && r.concurrentRet <= -8 },
  { name: 'BIG_SELL_FLOW_UP_MOVE:    nv<-50, ret>3 (fade?)', pred: r => r.netVolume < -50 && r.concurrentRet >= 3 },
  // Extreme buckets
  { name: 'EXT_BUY_ABSORPTION:       nv>200, |ret|<5pt',   pred: r => r.netVolume > 200 && Math.abs(r.concurrentRet) < 5 },
  { name: 'EXT_BUY_CONFIRMED:        nv>200, ret>10',      pred: r => r.netVolume > 200 && r.concurrentRet >= 10 },
  { name: 'EXT_SELL_ABSORPTION:      nv<-200, |ret|<5pt',  pred: r => r.netVolume < -200 && Math.abs(r.concurrentRet) < 5 },
  { name: 'EXT_SELL_CONFIRMED:       nv<-200, ret<-10',    pred: r => r.netVolume < -200 && r.concurrentRet <= -10 },
];

for (const c of cells) {
  const arr = subset.filter(c.pred);
  const s5 = summarize(arr, 'fwd', 5);
  const s15 = summarize(arr, 'fwd', 15);
  if (!s5) { console.log(`  ${c.name.padEnd(46)} no data`); continue; }
  console.log(`  ${c.name.padEnd(46)} ${String(s5.n).padStart(5)}  ${s5.mean.toFixed(2).padStart(6)}  ${s5.median.toFixed(2).padStart(6)}  ${(s5.pPos*100).toFixed(1)}%  ${(s5.pBig*100).toFixed(1)}%   ${(s5.pBigNeg*100).toFixed(1)}%`);
  if (s15) console.log(`     fwd15: n=${s15.n} mean=${s15.mean.toFixed(2)} P(>20)=${(s15.pBig*100).toFixed(1)}% P(<-20)=${(s15.pBigNeg*100).toFixed(1)}%`);
}

// Sustained flow test: K consecutive minutes of same-sign OFI
console.log(`\n=== SUSTAINED FLOW TEST ===`);
console.log(`Is K consecutive minutes of positive OFI predictive of forward return?\n`);

for (const K of [2, 3, 5, 8]) {
  // For each row, check if previous K rows had positive netVolume
  let posStreaks = 0, negStreaks = 0;
  const posFwd = [], negFwd = [];
  for (let i = K; i < rows.length; i++) {
    const r = rows[i];
    if (!Number.isFinite(r.fwd?.[15])) continue;
    let allPos = true, allNeg = true;
    for (let j = i - K; j < i; j++) {
      const r2 = rows[j];
      if (!Number.isFinite(r2.netVolume)) { allPos = allNeg = false; break; }
      // Require consecutive minutes (no gaps > 60s)
      if (j > i - K && rows[j].ts - rows[j-1].ts !== 60_000) { allPos = allNeg = false; break; }
      if (r2.netVolume < 30) allPos = false;
      if (r2.netVolume > -30) allNeg = false;
    }
    if (allPos) { posStreaks++; posFwd.push(r.fwd[15]); }
    if (allNeg) { negStreaks++; negFwd.push(r.fwd[15]); }
  }
  function summarize(arr) {
    if (arr.length === 0) return 'n=0';
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    arr.sort((a, b) => a - b);
    const median = arr[Math.floor(arr.length / 2)];
    const pPos = arr.filter(r => r > 0).length / arr.length;
    const pBig = arr.filter(r => Math.abs(r) > 15).length / arr.length;
    return `n=${arr.length} mean=${mean.toFixed(2)} med=${median.toFixed(2)} P(>0)=${(pPos*100).toFixed(1)}% P(|x|>15)=${(pBig*100).toFixed(1)}%`;
  }
  console.log(`K=${K} positive streak (each minute nv>30): ${summarize(posFwd)}`);
  console.log(`K=${K} negative streak (each minute nv<-30): ${summarize(negFwd)}`);
  console.log();
}

// Test specific scenario: large positive flow streak then look for 15-30min forward continuation
console.log(`=== Streak with stronger threshold ===`);
for (const [K, thresh] of [[3, 100], [3, 200], [5, 100], [5, 200], [8, 50], [8, 100]]) {
  const posFwd5 = [], posFwd15 = [], posFwd30 = [];
  const negFwd5 = [], negFwd15 = [], negFwd30 = [];
  for (let i = K; i < rows.length; i++) {
    let allPos = true, allNeg = true;
    let gap = false;
    for (let j = i - K; j < i; j++) {
      if (!Number.isFinite(rows[j].netVolume)) { allPos = allNeg = false; break; }
      if (j > i - K && rows[j].ts - rows[j-1].ts !== 60_000) { gap = true; break; }
      if (rows[j].netVolume < thresh) allPos = false;
      if (rows[j].netVolume > -thresh) allNeg = false;
    }
    if (gap) continue;
    const r = rows[i];
    if (allPos && Number.isFinite(r.fwd?.[15])) {
      posFwd5.push(r.fwd[5]); posFwd15.push(r.fwd[15]);
      if (Number.isFinite(r.fwd[30])) posFwd30.push(r.fwd[30]);
    }
    if (allNeg && Number.isFinite(r.fwd?.[15])) {
      negFwd5.push(r.fwd[5]); negFwd15.push(r.fwd[15]);
      if (Number.isFinite(r.fwd[30])) negFwd30.push(r.fwd[30]);
    }
  }
  const ps = (arr) => {
    if (arr.length === 0) return 'n=0';
    arr.sort((a, b) => a - b);
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    return `n=${arr.length} mean=${mean.toFixed(2)} med=${arr[Math.floor(arr.length/2)].toFixed(2)} P(>0)=${(arr.filter(r=>r>0).length/arr.length*100).toFixed(1)}%`;
  };
  console.log(`K=${K} threshold=${thresh}:`);
  console.log(`  POS streak fwd5:  ${ps(posFwd5)}`);
  console.log(`  POS streak fwd15: ${ps(posFwd15)}`);
  console.log(`  POS streak fwd30: ${ps(posFwd30)}`);
  console.log(`  NEG streak fwd5:  ${ps(negFwd5)}`);
  console.log(`  NEG streak fwd15: ${ps(negFwd15)}`);
  console.log(`  NEG streak fwd30: ${ps(negFwd30)}`);
}
