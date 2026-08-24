/**
 * Level-relative anatomy — the wick-anatomy math generalised from "the candle's own body" to
 * "any external price level".
 *
 * Why this is the right instrument for the dealer-flow question: every previous level study in this
 * repo (C1 levels, A2 GEX/LT, R1 rejections) asked "does price BOUNCE at the level" and found
 * placebo-equivalence. None of them measured HOW price interacts with the level — how long it
 * lingers, how much volume transacts on each side, how fast that volume trades, how many times it
 * re-probes, how deep it penetrates. Those require 1s data. If dealer hedging leaves a footprint,
 * it is far more likely to be in the interaction microstructure than in a bounce/break coin flip.
 *
 * Mechanistic prediction being tested:
 *   long gamma  (dealers dampen)  → more TIME at the level, LOWER volume intensity, more re-probes,
 *                                   shallower penetration
 *   short gamma (dealers amplify) → less time, HIGHER intensity, deeper penetration
 *
 * Attribution is identical to wick-anatomy.js: each 1s bar's second and volume are split across
 * zones in proportion to how much of its [low, high] lies in each. Same caveat: 1s OHLCV cannot say
 * where inside the second a contract traded, so volume splits are estimates; time is exact to 1s.
 */

/**
 * @param band  half-width in ticks of the "at the level" zone
 * @returns anatomy of the window [i0,i1) around `level`, or null if the level was never approached
 */
export function analyzeAroundLevel(lo, hi, vol, ts, i0, i1, level, band, winStart, winSec) {
  const top = level + band, bot = level - band;
  let tA = 0, tAt = 0, tB = 0, vA = 0, vAt = 0, vB = 0;
  let cvAt = 0, ctAt = 0;
  let maxAbove = 0, maxBelow = 0;
  let crossings = 0, side = 0, atFirst = -1, atLast = -1, touched = false;
  for (let i = i0; i < i1; i++) {
    const a = lo[i], b = hi[i], v = vol[i];
    if (b > level && a < level) { /* straddles */ }
    if (b - level > maxAbove) maxAbove = b - level;
    if (level - a > maxBelow) maxBelow = level - a;
    const p = winSec > 0 ? (ts[i] - winStart + 0.5) / winSec : 0;
    let wA, wAt, wB;
    if (b === a) { wA = a > top ? 1 : 0; wB = a < bot ? 1 : 0; wAt = 1 - wA - wB; }
    else {
      const span = b - a;
      wA = Math.max(0, b - Math.max(a, top)) / span;
      wB = Math.max(0, Math.min(b, bot) - a) / span;
      wAt = Math.max(0, 1 - wA - wB);
    }
    if (wA > 0) { tA += wA; vA += v * wA; }
    if (wB > 0) { tB += wB; vB += v * wB; }
    if (wAt > 0) { tAt += wAt; vAt += v * wAt; ctAt += p * wAt; cvAt += p * v * wAt; touched = true;
                   if (atFirst < 0) atFirst = i; atLast = i; }
    const s = a > level ? 1 : b < level ? -1 : 0;      // which side is the whole second on
    if (s !== 0) { if (side !== 0 && s !== side) crossings++; side = s; }
  }
  if (!touched) return null;
  const tTot = tA + tAt + tB || 1, vTot = vA + vAt + vB || 1;
  const r = (x) => +x.toFixed(4);
  const pos = (i) => (i < 0 ? null : winSec > 0 ? +((ts[i] - winStart + 0.5) / winSec).toFixed(4) : null);
  return {
    n1s: i1 - i0,
    timeAbove: r(tA / tTot), timeAt: r(tAt / tTot), timeBelow: r(tB / tTot),
    volAbove: r(vA / vTot), volAt: r(vAt / vTot), volBelow: r(vB / vTot),
    // intensity = share of volume ÷ share of time. >1 means contracts changed hands faster there.
    intAt: tAt > 0 ? r((vAt / vTot) / (tAt / tTot)) : null,
    intAbove: tA > 0 ? r((vA / vTot) / (tA / tTot)) : null,
    intBelow: tB > 0 ? r((vB / vTot) / (tB / tTot)) : null,
    centroidAtT: tAt > 0 ? r(ctAt / tAt) : null, centroidAtV: vAt > 0 ? r(cvAt / vAt) : null,
    firstAtPct: pos(atFirst), lastAtPct: pos(atLast),
    crossings, penAboveTicks: Math.max(0, maxAbove), penBelowTicks: Math.max(0, maxBelow),
    volTotal: vTot,
  };
}
