/**
 * Fractal (k-window) pivots: bar i is a swing HIGH if high[i] > high[i-j] for j=1..k (strict left)
 * and high[i] >= high[i+j] for j=1..k (right, ties allowed) — mirrored for lows.
 * A pivot is CONFIRMED when bar i+k closes: confirmedAt = bars[i+k].closeTs. Zero repaint.
 */
export class FractalPivots {
  constructor({ k = 3, kLeft } = {}) {
    this.k = k; this.kL = kLeft ?? k;
    this.buf = [];               // recent bars (kL + k + 1)
    this.idx = -1;               // index of last bar pushed (global bar index)
  }
  reset() { this.buf = []; this.idx = -1; }
  /** push a closed tf bar; returns array of newly confirmed pivots (0..2) */
  push(bar) {
    this.idx++;
    this.buf.push({ ...bar, i: this.idx });
    const need = this.kL + this.k + 1;
    if (this.buf.length > need) this.buf.shift();
    if (this.buf.length < need) return [];
    const c = this.kL;                       // candidate position within buf
    const cand = this.buf[c];
    const out = [];
    let isH = true, isL = true;
    for (let j = 1; j <= this.kL && (isH || isL); j++) {
      const b = this.buf[c - j];
      if (!(cand.high > b.high)) isH = false;
      if (!(cand.low < b.low)) isL = false;
    }
    for (let j = 1; j <= this.k && (isH || isL); j++) {
      const b = this.buf[c + j];
      if (!(cand.high >= b.high)) isH = false;
      if (!(cand.low <= b.low)) isL = false;
    }
    const confirmedAt = bar.closeTs;
    if (isH) out.push({ kind: 'H', ts: cand.ts, price: cand.high, barIdx: cand.i, confirmedAt, gen: 'fractal', k: this.k });
    if (isL) out.push({ kind: 'L', ts: cand.ts, price: cand.low, barIdx: cand.i, confirmedAt, gen: 'fractal', k: this.k });
    return out;
  }
}
