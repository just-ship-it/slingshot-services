/**
 * Multi-timeframe exhaustion detection.
 *
 * Pattern: K consecutive Nm-bars of dominant one-side flow + price drift,
 * then an exhaustion bar where flow continues but price doesn't follow
 * (or reverses on a wick).
 *
 * Test for each timeframe TF ∈ {3, 5, 15}:
 *   - Aggregate 1m OFI + 1m close into TF-min bars
 *   - For each TF-bar, label exhaustion pattern
 *   - Walk forward to measure: did price reverse within next TF minutes?
 *   - Compute WR on small targets with tight stops
 */
import fs from 'fs';
const j = JSON.parse(fs.readFileSync('/home/drew/projects/slingshot-services/backtest-engine/research/output/ofi-nq-joined.json'));
const rows1m = j.joined;

// Sign correction
for (const r of rows1m) {
  r.signedFlow = -r.netVolume;  // positive = buy aggression
}
// Compute concurrent return (1m)
let prevClose = null, prevTs = null;
for (const r of rows1m) {
  if (prevClose != null && r.ts - prevTs === 60_000) r.concurrentRet = r.close - prevClose;
  else r.concurrentRet = null;
  prevClose = r.close; prevTs = r.ts;
}
console.log(`Loaded ${rows1m.length.toLocaleString()} 1m rows`);

// Aggregate to N-min bars
function aggregateTo(N) {
  const out = [];
  let bucket = null;
  for (const r of rows1m) {
    const bucketTs = Math.floor(r.ts / (N * 60_000)) * (N * 60_000);
    if (!bucket || bucket.ts !== bucketTs) {
      if (bucket) out.push(bucket);
      bucket = {
        ts: bucketTs,
        open: r.close, high: r.close, low: r.close, close: r.close,
        volume: r.totalVolume, signedFlow: r.signedFlow,
        signedFlowAbs: Math.abs(r.signedFlow),
        n: 1, lastTs: r.ts,
      };
      bucket.open = r.close;  // approximation: first 1m close as bar open
    } else {
      bucket.close = r.close;
      bucket.high = Math.max(bucket.high, r.close);
      bucket.low = Math.min(bucket.low, r.close);
      bucket.volume += r.totalVolume;
      bucket.signedFlow += r.signedFlow;
      bucket.signedFlowAbs += Math.abs(r.signedFlow);
      bucket.n++;
      bucket.lastTs = r.ts;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

const TIMEFRAMES = [3, 5, 15];
const tfBars = {};
for (const tf of TIMEFRAMES) tfBars[tf] = aggregateTo(tf);

console.log(`\nBar counts per timeframe:`);
for (const tf of TIMEFRAMES) {
  console.log(`  ${tf}m: ${tfBars[tf].length.toLocaleString()} bars`);
}

// === Build close-by-ts lookup from 1m (for fine-grained forward returns) ===
const close1m = new Map();
for (const r of rows1m) close1m.set(r.ts, r.close);

// === Exhaustion pattern detection ===
// Bullish exhaustion (sellers fading, expected up reversal):
//   - Bar at idx-2, idx-1: signedFlow < -SELL_THRESH (sell aggression)
//   - Bar at idx-2 close, idx-1 close declining (price falling)
//   - Bar at idx (the candidate exhaustion bar): signedFlow < -SELL_THRESH (still selling)
//     BUT bar.close >= bar.open (price didn't drop — absorbing)
//     OR bar.low < prior_low but close back near high (wick rejection / hammer)
//
// Mirror for bearish exhaustion.

function detectExhaustion(bars, tf, SELL_THRESH, K) {
  const events = [];
  for (let i = K; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const lookback = bars.slice(i - K, i);

    // Check consecutive bar timestamps
    let consecutive = true;
    for (let j = 1; j < lookback.length; j++) {
      if (lookback[j].ts - lookback[j-1].ts !== tf * 60_000) { consecutive = false; break; }
    }
    if (!consecutive || cur.ts - lookback[lookback.length - 1].ts !== tf * 60_000) continue;

    // === BULLISH exhaustion (expected up reversal) ===
    const allSellers = lookback.every(b => b.signedFlow < -SELL_THRESH);
    const declining = lookback.every((b, k) => k === 0 || b.close <= lookback[k-1].close);
    const stillSelling = cur.signedFlow < -SELL_THRESH;
    const heldOrUp = cur.close >= cur.open;  // closed at or above open
    const hammerLike = (cur.high - cur.low) > 0 && (cur.close - cur.low) / (cur.high - cur.low) >= 0.6;
    const newLow = cur.low < Math.min(...lookback.map(b => b.low));

    if (allSellers && declining && stillSelling && (heldOrUp || hammerLike)) {
      events.push({
        type: 'bull_exhaustion',
        ts: cur.ts,
        entry_ts: cur.lastTs + 60_000,  // entry at first 1m after exhaustion bar close
        entry_price: cur.close,
        bar_low: cur.low,
        bar_high: cur.high,
        cur, lookback,
        newLow,
      });
    }

    // === BEARISH exhaustion (expected down reversal) ===
    const allBuyers = lookback.every(b => b.signedFlow > SELL_THRESH);
    const rising = lookback.every((b, k) => k === 0 || b.close >= lookback[k-1].close);
    const stillBuying = cur.signedFlow > SELL_THRESH;
    const heldOrDown = cur.close <= cur.open;
    const invHammer = (cur.high - cur.low) > 0 && (cur.high - cur.close) / (cur.high - cur.low) >= 0.6;
    const newHigh = cur.high > Math.max(...lookback.map(b => b.high));

    if (allBuyers && rising && stillBuying && (heldOrDown || invHammer)) {
      events.push({
        type: 'bear_exhaustion',
        ts: cur.ts,
        entry_ts: cur.lastTs + 60_000,
        entry_price: cur.close,
        bar_low: cur.low, bar_high: cur.high,
        cur, lookback,
        newHigh,
      });
    }
  }
  return events;
}

// === Forward outcome from 1m closes (subsequent N minutes) ===
function forwardOutcome(entryTs, entryPrice, direction, targetPts, stopPts, holdMin) {
  // Walk 1m closes from entry_ts onward up to holdMin minutes
  // Win if target hit before stop; loss if stop hit; timeout otherwise.
  // NOTE: this uses 1m closes — for 1s-honest we'd need to load the 1s file; we approximate here.
  for (let m = 1; m <= holdMin; m++) {
    const c = close1m.get(entryTs + (m - 1) * 60_000);
    if (c == null) continue;
    const moveFav = direction === 'long' ? c - entryPrice : entryPrice - c;
    const moveAdv = direction === 'long' ? entryPrice - c : c - entryPrice;
    if (moveAdv >= stopPts) return { outcome: 'loss', exit_min: m, exit_price: entryPrice - (direction === 'long' ? stopPts : -stopPts) };
    if (moveFav >= targetPts) return { outcome: 'win', exit_min: m, exit_price: entryPrice + (direction === 'long' ? targetPts : -targetPts) };
  }
  return { outcome: 'timeout', exit_min: holdMin, exit_price: null };
}

// === Sweep across timeframes, thresholds, K (lookback bars) ===
console.log(`\nExhaustion sweep across (TF, K, SELL_THRESH, target, stop, hold):`);
console.log(`label                                  n      W    L   TO   WR     EV_pts`);

const sweeps = [];
for (const tf of TIMEFRAMES) {
  for (const K of [2, 3, 4]) {
    for (const sellT of [50, 100, 200, 400]) {
      // Scale threshold by timeframe (sellT per 1m, so for N-min bar use sellT*N)
      const tfThresh = sellT * tf;
      const events = detectExhaustion(tfBars[tf], tf, tfThresh, K);
      if (events.length < 20) continue;
      const cfgs = tf === 3 ? [[10,5,10],[10,5,15],[15,8,15],[15,8,30]] : tf === 5 ? [[15,8,15],[15,8,30],[20,10,30]] : [[20,10,30],[25,12,45],[25,15,60]];
      for (const [tgt, stp, hld] of cfgs) {
        const results = events.map(e => {
          const dir = e.type === 'bull_exhaustion' ? 'long' : 'short';
          const r = forwardOutcome(e.entry_ts, e.entry_price, dir, tgt, stp, hld);
          return { ...e, dir, ...r };
        });
        const w = results.filter(r => r.outcome === 'win').length;
        const l = results.filter(r => r.outcome === 'loss').length;
        const to = results.filter(r => r.outcome === 'timeout').length;
        const ev = (w * tgt - l * stp) / results.length;
        sweeps.push({ tf, K, sellT, tgt, stp, hld, n: results.length, w, l, to, wr: w / results.length, ev });
        const label = `tf=${tf}m K=${K} thr=${sellT}*tf T=${tgt}/S=${stp}/H=${hld}`;
        console.log(`${label.padEnd(38)} ${String(results.length).padStart(5)} ${String(w).padStart(5)} ${String(l).padStart(4)} ${String(to).padStart(4)}  ${(w/results.length*100).toFixed(1).padStart(5)}%   ${ev.toFixed(2)}`);
      }
    }
  }
}

// Top configs by WR (filtered by n>=50)
console.log(`\n=== Top 15 by WR (n>=50) ===`);
const top = sweeps.filter(s => s.n >= 50).sort((a, b) => b.wr - a.wr).slice(0, 15);
console.log(`label                                                n     WR     EV    %events/yr`);
for (const s of top) {
  const yrs = (rows1m[rows1m.length-1].ts - rows1m[0].ts) / (365.25 * 86400_000);
  console.log(`tf=${s.tf}m K=${s.K} thr=${s.sellT}*tf T=${s.tgt}/S=${s.stp}/H=${s.hld}m  n=${String(s.n).padStart(4)}  WR=${(s.wr*100).toFixed(1)}%  EV=${s.ev.toFixed(2)}  ${(s.n/yrs).toFixed(0)}/yr`);
}

// Top configs by EV (n>=50)
console.log(`\n=== Top 15 by EV (n>=50) ===`);
const topEv = sweeps.filter(s => s.n >= 50).sort((a, b) => b.ev - a.ev).slice(0, 15);
for (const s of topEv) {
  const yrs = (rows1m[rows1m.length-1].ts - rows1m[0].ts) / (365.25 * 86400_000);
  console.log(`tf=${s.tf}m K=${s.K} thr=${s.sellT}*tf T=${s.tgt}/S=${s.stp}/H=${s.hld}m  n=${String(s.n).padStart(4)}  WR=${(s.wr*100).toFixed(1)}%  EV=${s.ev.toFixed(2)}  ${(s.n/yrs).toFixed(0)}/yr`);
}

fs.writeFileSync('/home/drew/projects/slingshot-services/backtest-engine/research/output/exhaustion-sweep.json', JSON.stringify({ sweeps, top, topEv }, null, 2));
console.log(`\nSaved: exhaustion-sweep.json`);
