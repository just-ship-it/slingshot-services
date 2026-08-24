/**
 * ATR-threshold directional-change zigzag. Tracks the running extreme of the current leg; when
 * price reverses by >= theta*ATR from it, the extreme is emitted as a pivot with
 * confirmedAt = closeTs of the bar that crossed the threshold. The provisional (unconfirmed)
 * extreme is available via `provisional()` but is never emitted.
 * ATR is supplied per bar by the caller (from BarFeatures, closed bars only).
 */
export class ZigZagPivots {
  constructor({ theta = 2.0 } = {}) {
    this.theta = theta;
    this.reset();
  }
  reset() {
    this.dir = 0;            // +1 leg up (tracking a high), -1 leg down
    this.ext = null;         // {price, ts, barIdx}
    this.idx = -1;
    this.lastPivotPrice = NaN;
  }
  provisional() { return this.ext ? { ...this.ext, kind: this.dir > 0 ? 'H' : 'L', provisional: true } : null; }
  push(bar, atr) {
    this.idx++;
    const out = [];
    if (!Number.isFinite(atr) || atr <= 0) {
      if (!this.ext) this.ext = { price: bar.close, ts: bar.ts, barIdx: this.idx, hi: bar.high, lo: bar.low };
      return out;
    }
    const th = this.theta * atr;
    if (this.dir === 0) {
      // seed: pick direction once price has moved th from the seed close
      if (!this.ext) { this.ext = { price: bar.close, ts: bar.ts, barIdx: this.idx }; return out; }
      if (bar.high - this.ext.price >= th) { this.dir = 1; this.ext = { price: bar.high, ts: bar.ts, barIdx: this.idx }; }
      else if (this.ext.price - bar.low >= th) { this.dir = -1; this.ext = { price: bar.low, ts: bar.ts, barIdx: this.idx }; }
      return out;
    }
    if (this.dir > 0) {
      if (bar.high >= this.ext.price) { this.ext = { price: bar.high, ts: bar.ts, barIdx: this.idx }; }
      if (this.ext.price - bar.low >= th && bar.ts !== this.ext.ts) {
        out.push({ kind: 'H', ts: this.ext.ts, price: this.ext.price, barIdx: this.ext.barIdx, confirmedAt: bar.closeTs, gen: 'zigzag', theta: this.theta });
        this.dir = -1; this.ext = { price: bar.low, ts: bar.ts, barIdx: this.idx };
      } else if (this.ext.price - bar.low >= th && bar.ts === this.ext.ts) {
        // same-bar reversal (new high then big drop within the bar): confirm high, start down leg from this bar's low
        out.push({ kind: 'H', ts: this.ext.ts, price: this.ext.price, barIdx: this.ext.barIdx, confirmedAt: bar.closeTs, gen: 'zigzag', theta: this.theta });
        this.dir = -1; this.ext = { price: bar.low, ts: bar.ts, barIdx: this.idx };
      }
    } else {
      if (bar.low <= this.ext.price) { this.ext = { price: bar.low, ts: bar.ts, barIdx: this.idx }; }
      if (bar.high - this.ext.price >= th) {
        out.push({ kind: 'L', ts: this.ext.ts, price: this.ext.price, barIdx: this.ext.barIdx, confirmedAt: bar.closeTs, gen: 'zigzag', theta: this.theta });
        this.dir = 1; this.ext = { price: bar.high, ts: bar.ts, barIdx: this.idx };
      }
    }
    return out;
  }
}
