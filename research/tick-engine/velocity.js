/**
 * VELOCITY / SWEEP signatures — how FAST a range was covered, and what happened after.
 *
 * Motivated by the classic liquidity-sweep shape: price rips through a range in a few seconds,
 * then closes back at the other end of the candle, and the next candle runs the other way.
 * Every feature built so far scores "30 points over 3 minutes" identically to "30 points in 4
 * seconds then chop" — this separates them.
 *
 *   maxVelN     largest range (ticks) covered by any rolling N-second window inside the candle
 *   velShareN   that window's range ÷ the candle's whole range (1.0 = the entire candle happened
 *               inside N seconds)
 *   velDir      direction of the fastest window (+1 up, −1 down)
 *   sweepUp     fastest window went UP and the candle closed in its lower third  → up-sweep rejected
 *   sweepDn     mirror
 *   postVelDrift  where price ended relative to the fastest window's extreme (how much was given back)
 *   timeAtVel   how many seconds into the candle the fastest window started (0..1)
 */
export function velocityProfile(lo, hi, close, ts, i0, i1, openTs, durSec, o, c) {
  const n = i1 - i0;
  if (n < 3) return null;
  let H = -2e9, L = 2e9;
  for (let i = i0; i < i1; i++) { if (hi[i] > H) H = hi[i]; if (lo[i] < L) L = lo[i]; }
  const rng = Math.max(1, H - L);
  const out = {};
  for (const W of [5, 10, 30]) {
    let best = 0, bestDir = 0, bestStart = 0, bestHi = 0, bestLo = 0;
    let s = i0;
    for (let e = i0; e < i1; e++) {
      while (ts[e] - ts[s] > W && s < e) s++;
      let wh = -2e9, wl = 2e9, first = close[s], last = close[e];
      for (let k = s; k <= e; k++) { if (hi[k] > wh) wh = hi[k]; if (lo[k] < wl) wl = lo[k]; }
      const span = wh - wl;
      if (span > best) { best = span; bestDir = last >= first ? 1 : -1; bestStart = ts[s] - openTs; bestHi = wh; bestLo = wl; }
    }
    out[`maxVel${W}`] = best;
    out[`velShare${W}`] = +(best / rng).toFixed(4);
    if (W === 10) {
      out.velDir = bestDir;
      out.timeAtVel = durSec > 0 ? +(bestStart / durSec).toFixed(4) : null;
      // how much of the fastest window's move was given back by the close
      out.giveBack = bestDir > 0 ? +((bestHi - c) / Math.max(1, best)).toFixed(4)
                                 : +((c - bestLo) / Math.max(1, best)).toFixed(4);
    }
  }
  const clv = (c - L) / rng;
  out.clv = +clv.toFixed(4);
  // the sweep composite: a fast directional burst that the candle then closed AGAINST
  out.sweepUp = (out.velShare10 >= 0.5 && out.velDir > 0 && clv <= 0.34) ? 1 : 0;
  out.sweepDn = (out.velShare10 >= 0.5 && out.velDir < 0 && clv >= 0.66) ? 1 : 0;
  return out;
}
