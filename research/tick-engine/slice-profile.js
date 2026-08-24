/**
 * SLICE PROFILE — the full time distribution inside a candle, not a summary of it.
 *
 * A candle is cut into N equal time slices; for each slice we keep:
 *    v[k]  share of the candle's VOLUME transacted in that slice
 *    m[k]  signed PRICE MOVEMENT in that slice, as a share of the candle's total absolute movement
 *    r[k]  share of the candle's RANGE traversed in that slice
 *
 * Summary statistics (centroids) cannot distinguish "volume early, price late" from "both mid" —
 * the vectors can. Keeping the distribution lets the SHAPE be the feature.
 */
export function sliceProfile(lo, hi, vol, close, ts, i0, i1, openTs, durSec, o, N = 6) {
  if (i1 - i0 < 2 || durSec <= 0) return null;
  const v = new Float64Array(N), m = new Float64Array(N);
  const sh = new Float64Array(N).fill(-2e9), sl = new Float64Array(N).fill(2e9);
  let prev = o, totV = 0;
  for (let i = i0; i < i1; i++) {
    let k = Math.floor(((ts[i] - openTs) / durSec) * N);
    if (k < 0) k = 0; if (k >= N) k = N - 1;
    v[k] += vol[i];
    m[k] += close[i] - prev; prev = close[i];
    if (hi[i] > sh[k]) sh[k] = hi[i];
    if (lo[i] < sl[k]) sl[k] = lo[i];
    totV += vol[i];
  }
  let absM = 0, totR = 0;
  const r = new Float64Array(N);
  for (let k = 0; k < N; k++) { absM += Math.abs(m[k]); r[k] = sh[k] > -2e9 ? sh[k] - sl[k] : 0; totR += r[k]; }
  const q = (x) => +x.toFixed(4);
  return {
    v: Array.from(v, (x) => q(totV > 0 ? x / totV : 0)),
    m: Array.from(m, (x) => q(absM > 0 ? x / absM : 0)),
    r: Array.from(r, (x) => q(totR > 0 ? x / totR : 0)),
    mTicks: Array.from(m, (x) => Math.round(x)),
    totVol: totV, absMoveTicks: Math.round(absM),
  };
}
