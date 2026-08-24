/**
 * Wick anatomy — for every completed candle, where in the candle (in TIME and in VOLUME) each wick
 * was actually made.
 *
 * Zones of a candle, defined by its FINAL body (so attribution can only run once the candle closes):
 *    top wick   price >  max(open, close)
 *    body       max(open,close) >= price >= min(open, close)
 *    bottom wick price <  min(open, close)
 *
 * Attribution: each constituent 1s bar is split across the zones in proportion to how much of its
 * [low, high] range lies in each — its 1 second of time and its volume are divided the same way.
 * A zero-range second is assigned wholly to the zone containing its price.
 *
 * ⚠️ Honesty note: 1s OHLCV does not say WHERE inside the second each contract traded. Range-overlap
 * is the best unbiased estimate available from this data; it will smear volume across a zone
 * boundary on wide seconds. Only tick/BBO data would make it exact. Reported `*VolPct` are therefore
 * estimates; `*TimePct` is exact up to 1-second granularity.
 *
 * Per wick we report:
 *   TimePct    fraction of the candle's seconds spent in that wick zone
 *   VolPct     fraction of the candle's volume transacted in that wick zone
 *   CentroidT  volume-agnostic centre of mass of that time, 0 = candle open … 1 = candle close
 *   CentroidV  volume-weighted centre of mass — "was the wick made early or late?"
 *   ExtremePct when the extreme itself first printed (high for the top wick, low for the bottom)
 *   FirstPct / LastPct   first and last second that traded in the zone
 *   Touches    how many distinct excursions into the zone (a re-probe count)
 */

/** Attribute one candle's 1s bars to zones. Arrays are (lo, hi, vol) columns over [i0, i1). */
export function analyzeCandle(lo, hi, vol, ts, i0, i1, o, h, l, c, openTs, durSec) {
  const bodyTop = Math.max(o, c), bodyBot = Math.min(o, c);
  const n = i1 - i0;
  let tUp = 0, tBody = 0, tDn = 0, vUp = 0, vBody = 0, vDn = 0;
  let ctUp = 0, ctDn = 0, cvUp = 0, cvDn = 0, ctBody = 0, cvBody = 0;
  let upFirst = -1, upLast = -1, dnFirst = -1, dnLast = -1;
  let upTouches = 0, dnTouches = 0, inUp = false, inDn = false;
  let hiIdx = -1, loIdx = -1;
  for (let i = i0; i < i1; i++) {
    const a = lo[i], b = hi[i], v = vol[i];
    if (hiIdx < 0 && b === h) hiIdx = i;
    if (loIdx < 0 && a === l) loIdx = i;
    const p = durSec > 0 ? (ts[i] - openTs + 0.5) / durSec : (i - i0 + 0.5) / n;   // 0..1 within the candle
    let wUp, wBody, wDn;
    if (b === a) {                                   // zero-range second → whole second in one zone
      wUp = a > bodyTop ? 1 : 0; wDn = a < bodyBot ? 1 : 0; wBody = 1 - wUp - wDn;
    } else {
      const span = b - a;
      const ovUp = Math.max(0, b - Math.max(a, bodyTop));
      const ovDn = Math.max(0, Math.min(b, bodyBot) - a);
      wUp = ovUp / span; wDn = ovDn / span; wBody = Math.max(0, 1 - wUp - wDn);
    }
    if (wUp > 0) { tUp += wUp; vUp += v * wUp; ctUp += p * wUp; cvUp += p * v * wUp;
                   if (upFirst < 0) upFirst = i; upLast = i; if (!inUp) { upTouches++; inUp = true; } } else inUp = false;
    if (wDn > 0) { tDn += wDn; vDn += v * wDn; ctDn += p * wDn; cvDn += p * v * wDn;
                   if (dnFirst < 0) dnFirst = i; dnLast = i; if (!inDn) { dnTouches++; inDn = true; } } else inDn = false;
    if (wBody > 0) { tBody += wBody; vBody += v * wBody; ctBody += p * wBody; cvBody += p * v * wBody; }
  }
  const tTot = tUp + tBody + tDn || 1, vTot = vUp + vBody + vDn || 1;
  const pos = (i) => (i < 0 ? null : durSec > 0 ? +((ts[i] - openTs + 0.5) / durSec).toFixed(4) : null);
  const r4 = (x) => +x.toFixed(4);
  return {
    n1s: n,
    upTimePct: r4(tUp / tTot), bodyTimePct: r4(tBody / tTot), dnTimePct: r4(tDn / tTot),
    upVolPct: r4(vUp / vTot), bodyVolPct: r4(vBody / vTot), dnVolPct: r4(vDn / vTot),
    upCentroidT: tUp > 0 ? r4(ctUp / tUp) : null, upCentroidV: vUp > 0 ? r4(cvUp / vUp) : null,
    dnCentroidT: tDn > 0 ? r4(ctDn / tDn) : null, dnCentroidV: vDn > 0 ? r4(cvDn / vDn) : null,
    bodyCentroidV: vBody > 0 ? r4(cvBody / vBody) : null,
    upExtremePct: pos(hiIdx), dnExtremePct: pos(loIdx),
    upFirstPct: pos(upFirst), upLastPct: pos(upLast), dnFirstPct: pos(dnFirst), dnLastPct: pos(dnLast),
    upTouches, dnTouches,
  };
}

/** Streaming wrapper: feed 1s bars, get a descriptor on each completed tf candle.
 *  Same code path is usable live (feed the 1s feed) — that is the point. */
export class WickAnatomy {
  constructor(tfSec) { this.tfSec = tfSec; this.reset(); }
  reset() { this.lo = []; this.hi = []; this.vol = []; this.ts = []; this.o = 0; this.h = -2e9; this.l = 2e9; this.c = 0; this.v = 0; this.openTs = 0; this.endTs = 0; this.n = 0; }
  /** @returns descriptor|null (non-null on the second that completes a candle) */
  push(bar, sessionOpenTs) {
    let out = null;
    if (bar.ts >= this.endTs) {
      if (this.n) out = this.finish();
      const k = Math.floor((bar.ts - sessionOpenTs) / this.tfSec);
      this.reset();
      this.openTs = sessionOpenTs + k * this.tfSec; this.endTs = this.openTs + this.tfSec;
      this.o = bar.o; this.h = bar.h; this.l = bar.l;
    }
    if (bar.h > this.h) this.h = bar.h;
    if (bar.l < this.l) this.l = bar.l;
    this.c = bar.c; this.v += bar.v; this.n++;
    this.lo.push(bar.l); this.hi.push(bar.h); this.vol.push(bar.v); this.ts.push(bar.ts);
    return out;
  }
  finish() {
    const d = analyzeCandle(this.lo, this.hi, this.vol, this.ts, 0, this.n,
                            this.o, this.h, this.l, this.c, this.openTs, this.tfSec);
    return { ts: this.openTs, o: this.o, h: this.h, l: this.l, c: this.c, v: this.v, ...d };
  }
}
