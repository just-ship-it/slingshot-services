/**
 * TIME-PROFILE — how volume and price movement distribute across a candle's DURATION.
 *
 * Complementary to wick-anatomy.js: that one attributes by price zone (where price was), this one
 * attributes by time (when things happened). "A green candle whose body was built in the final 20
 * seconds" and "a green candle that rallied in the first minute then drifted" have identical OHLC
 * and identical wick anatomy — but they are different events, and only this measures the difference.
 *
 * Returns (all normalised, 0 = candle open … 1 = candle close):
 *   volCentroid     centre of mass of VOLUME in time — was trading front- or back-loaded?
 *   moveCentroid    centre of mass of |price movement| — when did the range actually get built?
 *   driveCentroid   centre of mass of SIGNED movement — when was the net direction established?
 *   bodyLast10/30   share of the body formed in the final 10 / 30 seconds  ← Drew's "closing push"
 *   bodyFirst30     share of the body formed in the first 30 seconds
 *   volLastQ/FirstQ volume share in the final / first quarter of the candle
 *   closingBurst    per-second volume in the final 10s ÷ per-second volume over the candle
 *   pathEff         |net move| ÷ sum of |per-slice moves| — 1 = a clean one-way drive, 0 = churn
 *   reversals       number of sign changes in slice-by-slice movement
 *   maxSliceVolPct  the single busiest slice's share of volume (burstiness)
 */
export function analyzeTimeProfile(lo, hi, vol, close, ts, i0, i1, openTs, durSec, o, c, nSlices = 8) {
  const n = i1 - i0;
  if (n < 2 || durSec <= 0) return null;
  const sv = new Float64Array(nSlices), sm = new Float64Array(nSlices);
  let prevC = o, totV = 0;
  // per-slice volume and signed movement
  for (let i = i0; i < i1; i++) {
    const p = (ts[i] - openTs) / durSec;
    let k = Math.floor(p * nSlices); if (k < 0) k = 0; if (k >= nSlices) k = nSlices - 1;
    sv[k] += vol[i];
    sm[k] += close[i] - prevC;
    prevC = close[i];
    totV += vol[i];
  }
  let cv = 0, cm = 0, cd = 0, absM = 0, sumM = 0, rev = 0, maxV = 0, lastSign = 0;
  for (let k = 0; k < nSlices; k++) {
    const mid = (k + 0.5) / nSlices;
    cv += mid * sv[k];
    absM += Math.abs(sm[k]); cm += mid * Math.abs(sm[k]);
    sumM += sm[k]; cd += mid * sm[k];
    if (sv[k] > maxV) maxV = sv[k];
    const s = Math.sign(sm[k]);
    if (s !== 0) { if (lastSign !== 0 && s !== lastSign) rev++; lastSign = s; }
  }
  // body built in the final / first slices of wall-clock time
  const body = c - o;
  const priceAt = (targetTs) => {                       // last close at or before targetTs
    let px = o;
    for (let i = i0; i < i1; i++) { if (ts[i] > targetTs) break; px = close[i]; }
    return px;
  };
  const endTs = openTs + durSec;
  const p10 = priceAt(endTs - 10), p30 = priceAt(endTs - 30), f30 = priceAt(openTs + 30);
  // normalise by ATR/range, never by body — a 1-tick body makes body-shares explode
  const share = (num) => (Math.abs(body) >= 4 ? +(num / body).toFixed(4) : null);
  let volLastQ = 0, volFirstQ = 0;
  for (let i = i0; i < i1; i++) {
    const p = (ts[i] - openTs) / durSec;
    if (p >= 0.75) volLastQ += vol[i]; else if (p < 0.25) volFirstQ += vol[i];
  }
  let vLast10 = 0;
  for (let i = i0; i < i1; i++) if (ts[i] >= endTs - 10) vLast10 += vol[i];
  // ---- "wild close" signatures: what happened in the final seconds, which is where fakeouts live
  let lateHi = -2e9, lateLo = 2e9, lateHi10 = -2e9, lateLo10 = 2e9;
  for (let i = i0; i < i1; i++) {
    if (ts[i] >= endTs - 30) { if (hi[i] > lateHi) lateHi = hi[i]; if (lo[i] < lateLo) lateLo = lo[i]; }
    if (ts[i] >= endTs - 10) { if (hi[i] > lateHi10) lateHi10 = hi[i]; if (lo[i] < lateLo10) lateLo10 = lo[i]; }
  }
  const rng = Math.max(1, (() => { let H = -2e9, L = 2e9; for (let i = i0; i < i1; i++) { if (hi[i] > H) H = hi[i]; if (lo[i] < L) L = lo[i]; } return H - L; })());
  const dir = Math.sign(body) || 1;
  const mv10 = c - p10, mv30 = c - p30;
  const r4 = (x) => +x.toFixed(4);
  const lateRange30 = lateHi > -2e9 ? lateHi - lateLo : 0;
  const lateRange10 = lateHi10 > -2e9 ? lateHi10 - lateLo10 : 0;
  return {
    // raw, stable versions of the closing-push measures (ticks) + range-normalised
    moveLast10Ticks: mv10, moveLast30Ticks: mv30,
    moveLast10Rel: r4(mv10 / rng), moveLast30Rel: r4(mv30 / rng),
    // "wild close": how much of the candle's whole range was traversed in its final seconds
    lateRange30Rel: r4(lateRange30 / rng), lateRange10Rel: r4(lateRange10 / rng),
    // did the last seconds fight the candle's own direction? (the classic fake-out shape)
    lateFightsBody: r4(-dir * mv30 / rng),
    // how far the close sits from the extreme printed in the final 30s (a late spike that got sold)
    closeOffLateHi: r4((lateHi > -2e9 ? lateHi - c : 0) / rng),
    closeOffLateLo: r4((lateLo < 2e9 ? c - lateLo : 0) / rng),
    volCentroid: totV > 0 ? r4(cv / totV) : null,
    moveCentroid: absM > 0 ? r4(cm / absM) : null,
    driveCentroid: Math.abs(sumM) > 1e-9 ? r4(cd / sumM) : null,
    bodyLast10: share(c - p10), bodyLast30: share(c - p30), bodyFirst30: share(f30 - o),
    volLastQ: totV > 0 ? r4(volLastQ / totV) : null,
    volFirstQ: totV > 0 ? r4(volFirstQ / totV) : null,
    closingBurst: totV > 0 && durSec > 0 ? r4((vLast10 / 10) / (totV / durSec)) : null,
    pathEff: absM > 0 ? r4(Math.abs(sumM) / absM) : null,
    reversals: rev,
    maxSliceVolPct: totV > 0 ? r4(maxV / totV) : null,
  };
}
