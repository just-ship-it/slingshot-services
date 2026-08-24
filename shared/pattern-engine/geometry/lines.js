/**
 * Line geometry helpers for slope-sign shapes (catalog 01 §A.2, §A.3; 04 §4.1).
 *
 * A line is { slope (points per bar), intercept (value at barIdx 0), i0, i1 (defining point
 * indices), touches, maxViolation, n }. x is always the tf bar index (bar.i / pivot.barIdx).
 * All fits are over ≤ ~8 points, so the pair-enumeration is O(n^3) with n ≤ 8 (trivial).
 */

/** value of line at bar index x */
export function lineValueAt(line, x) { return line.intercept + line.slope * x; }

/**
 * Outer (envelope) line through pivots such that no point violates it beyond `tol`.
 *   kind 'H' → upper envelope (no point above line + tol); 'L' → lower envelope.
 * Enumerates every pair of points, keeps pairs whose line is not violated beyond tol, and picks
 * the one with the most touches (|residual| ≤ tol), then the smallest max violation, then the
 * widest x-span, then the smallest sum |residual| (hugs the data). The upper/lower convex hull
 * guarantees at least one zero-violation pair exists, so a result is always returned for n ≥ 2.
 * @param {{x:number,y:number}[]} points
 * @param {'H'|'L'} kind
 * @param {number} tol   price tolerance (already ATR-scaled by the caller)
 */
export function fitOuterLine(points, kind, tol = 0) {
  const n = points.length;
  if (n < 2) return null;
  const sgn = kind === 'H' ? 1 : -1;
  let best = null;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = points[i], b = points[j];
      if (b.x === a.x) continue;
      const slope = (b.y - a.y) / (b.x - a.x);
      const intercept = a.y - slope * a.x;
      let maxViol = 0, touches = 0, sumRes = 0;
      for (let k = 0; k < n; k++) {
        const p = points[k];
        const v = sgn * (p.y - (intercept + slope * p.x));   // > 0 = beyond the envelope
        if (v > maxViol) maxViol = v;
        if (Math.abs(v) <= tol) touches++;
        sumRes += Math.abs(v);
      }
      if (maxViol > tol) continue;
      const span = Math.abs(b.x - a.x);
      const cand = { slope, intercept, i0: i, i1: j, touches, maxViolation: maxViol, span, sumRes, n };
      if (!best || cand.touches > best.touches ||
        (cand.touches === best.touches && (cand.maxViolation < best.maxViolation - 1e-9 ||
          (Math.abs(cand.maxViolation - best.maxViolation) <= 1e-9 && (cand.span > best.span ||
            (cand.span === best.span && cand.sumRes < best.sumRes)))))) best = cand;
    }
  }
  if (!best) return null;
  const { sumRes, span, ...line } = best;
  return line;
}

/** number of points within tol of the line */
export function touchesWithin(points, line, tol) {
  let c = 0;
  for (const p of points) if (Math.abs(p.y - lineValueAt(line, p.x)) <= tol) c++;
  return c;
}

/** slope in ATR per bar */
export function slopeAtr(line, atr) { return Number.isFinite(atr) && atr > 0 ? line.slope / atr : NaN; }

/** width between two lines at x (upper − lower) */
export function widthAt(upper, lower, x) { return lineValueAt(upper, x) - lineValueAt(lower, x); }

/**
 * Bars ahead (from `fromX`) until the two lines intersect. Positive = converging (apex ahead),
 * negative = diverging (lines met in the past), null = parallel.
 */
export function apexBars(upper, lower, fromX = 0) {
  const ds = upper.slope - lower.slope;
  if (Math.abs(ds) < 1e-12) return null;
  const xStar = (lower.intercept - upper.intercept) / ds;
  return xStar - fromX;
}

/**
 * Prior impulse (canonical primitive P5, catalog 01 §A.3): looking back from a pattern-start bar,
 * the largest move ≥ K·ATR completed within ≤ M bars ending at that bar (its high for an up-move,
 * its low for a down-move, or an explicit `endPrice`).
 *
 * @param {{length:number, at(i:number):object}} bars  array-like of closed tf bars (oldest first)
 * @param {number} atr
 * @param {object} o  { K=4, M=15, minER=0.6, endIdx=bars.length-1, endPrice, dir ('up'|'down'|undefined) }
 * @returns {null|{dir, move, moveAtr (signed), bars, efficiencyRatio, startIdx, startPrice, endIdx, endPrice, meanVol, qualifies, speedAtr}}
 *   `qualifies` = move ≥ K·ATR && ER ≥ minER; when nothing qualifies the best-by-move candidate is
 *   returned with qualifies=false (callers can still log it). null when < 2 bars are available.
 */
export function priorImpulse(bars, atr, o = {}) {
  const K = o.K ?? 4, M = o.M ?? 15, minER = o.minER ?? 0.6;
  const endIdx = o.endIdx ?? bars.length - 1;
  if (!Number.isFinite(atr) || atr <= 0 || endIdx < 1) return null;
  const end = bars.at(endIdx);
  if (!end) return null;
  const endHigh = o.endPrice ?? end.high, endLow = o.endPrice ?? end.low;
  const wantUp = o.dir !== 'down', wantDown = o.dir !== 'up';
  let path = 0, vol = end.volume || 0, cnt = 1;
  let prevClose = end.close;
  let best = null;
  const quals = [];
  for (let L = 1; L <= M; L++) {
    const j = endIdx - L;
    if (j < 0) break;
    const b = bars.at(j);
    if (!b) break;
    path += Math.abs(prevClose - b.close);
    prevClose = b.close;
    vol += b.volume || 0; cnt++;
    const net = Math.abs(end.close - b.close);
    const er = path > 0 ? Math.min(1, net / path) : 0;
    const cands = [];
    if (wantUp) cands.push({ dir: 'up', move: endHigh - b.low, startPrice: b.low, endPrice: endHigh });
    if (wantDown) cands.push({ dir: 'down', move: endLow - b.high, startPrice: b.high, endPrice: endLow });   // negative
    for (const c of cands) {
      const mag = Math.abs(c.move);
      if (!(mag > 0)) continue;
      const rec = { dir: c.dir, move: mag, moveAtr: c.move / atr, bars: L, efficiencyRatio: er, startIdx: j, startPrice: c.startPrice,
        endIdx, endPrice: c.endPrice, meanVol: vol / cnt, speedAtr: mag / atr / L, qualifies: mag >= K * atr && er >= minER };
      if (!best || rec.move > best.move) best = rec;
      if (rec.qualifies) quals.push(rec);
    }
  }
  if (!quals.length) return best;
  // among qualifying windows take the SHORTEST one that captures ≥ 90% of the largest qualifying
  // move — i.e. the impulse itself without a flat lead-in (Bulkowski: pole from where the steep move began)
  let top = quals[0];
  for (const q of quals) if (q.move > top.move) top = q;
  for (const q of quals) if (q.dir === top.dir && q.move >= 0.9 * top.move) return q;   // quals are in ascending L order
  return top;
}
