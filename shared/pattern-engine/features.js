/**
 * Per-timeframe rolling bar features. Everything is computed from CLOSED bars only and updated
 * AFTER the bar closes, so a bar's own values never enter the normalizers used to describe it
 * (call `describe(bar)` BEFORE `update(bar)`; the engine does this).
 */

class Ring {
  constructor(n) { this.n = n; this.buf = new Float64Array(n); this.i = 0; this.len = 0; }
  push(x) { this.buf[this.i] = x; this.i = (this.i + 1) % this.n; if (this.len < this.n) this.len++; }
  toArray() { const out = new Array(this.len); for (let k = 0; k < this.len; k++) out[k] = this.buf[(this.i - this.len + k + this.n) % this.n]; return out; }
  last(k = 0) { return this.len > k ? this.buf[(this.i - 1 - k + this.n) % this.n] : NaN; }
  median() {
    if (!this.len) return NaN;
    const a = this.toArray().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  mean() { if (!this.len) return NaN; let s = 0; for (let k = 0; k < this.len; k++) s += this.buf[k]; return s / this.len; }
  /** percentile rank (0..1) of x among stored values */
  rank(x) { if (!this.len) return NaN; let c = 0; for (let k = 0; k < this.len; k++) if (this.buf[k] <= x) c++; return c / this.len; }
}

export class BarFeatures {
  /**
   * @param {object} p  { atrLen=14, medLen=60, todSessions=20, todBucketMin=<tf minutes>, emaLen=20 }
   */
  constructor(p = {}) {
    this.atrLen = p.atrLen ?? 14;
    this.medLen = p.medLen ?? 60;
    this.todSessions = p.todSessions ?? 20;
    this.emaLen = p.emaLen ?? 20;
    this.tfMin = p.tfMin ?? 1;
    this.reset();
  }

  reset() {
    this.count = 0;
    this.prevClose = NaN;
    this.atr = NaN;              // Wilder ATR over closed bars
    this._trSum = 0;
    this.body = new Ring(this.medLen);
    this.range = new Ring(this.medLen);
    this.vol = new Ring(this.medLen);
    this.atrHist = new Ring(60 * 26);   // long history for ATR percentile (≈60 sessions of 15m)
    this.ema = NaN; this.emaPrev = NaN;
    this.tod = new Map();        // bucket (period start mos) -> Ring(todSessions) of range; and volume
    this.todVol = new Map();
    this.closes = new Ring(5);
  }

  _todRing(map, mos) {
    let r = map.get(mos);
    if (!r) { r = new Ring(this.todSessions); map.set(mos, r); }
    return r;
  }

  /** Feature snapshot describing `bar` using ONLY prior closed bars as normalizers. */
  describe(bar) {
    const rng = bar.high - bar.low;
    const body = Math.abs(bar.close - bar.open);
    const upSh = bar.high - Math.max(bar.open, bar.close);
    const loSh = Math.min(bar.open, bar.close) - bar.low;
    const medRange = this.range.median();
    const medBody = this.body.median();
    const todR = this.tod.get(bar.mos);
    const todV = this.todVol.get(bar.mos);
    const scale = Math.max(this.atr || 0, medRange || 0) || NaN;   // catalog 02 §1.3 range scale
    return {
      atr: this.atr,
      atrPctile: Number.isFinite(this.atr) ? this.atrHist.rank(this.atr) : NaN,
      medRange, medBody, scale,
      todMedRange: todR ? todR.median() : NaN,
      todMedVol: todV ? todV.median() : NaN,
      relVol: todV && todV.len >= 5 ? bar.volume / todV.median() : NaN,
      rangeRel: scale ? rng / scale : NaN,           // range vs scale
      rangeZ: todR && todR.len >= 5 ? rng / todR.median() : NaN, // range vs same-time-of-day median
      bodyRel: rng > 0 ? body / rng : 0,             // body / own range
      bodyVsMed: medBody ? body / medBody : NaN,
      upRel: rng > 0 ? upSh / rng : 0,
      loRel: rng > 0 ? loSh / rng : 0,
      clv: rng > 0 ? ((bar.close - bar.low) - (bar.high - bar.close)) / rng : 0,   // -1..+1
      dir: bar.close > bar.open ? 1 : bar.close < bar.open ? -1 : 0,
      gapVsPrev: Number.isFinite(this.prevClose) ? (bar.open - this.prevClose) : NaN,
      emaSlope: Number.isFinite(this.ema) && Number.isFinite(this.emaPrev) && this.atr ? (this.ema - this.emaPrev) / this.atr : NaN,
      emaDist: Number.isFinite(this.ema) && this.atr ? (bar.close - this.ema) / this.atr : NaN,
      warm: this.count >= Math.max(this.atrLen, 20),
    };
  }

  /** Incorporate the closed bar into the rolling state (call after describe). */
  update(bar) {
    const rng = bar.high - bar.low;
    const tr = Number.isFinite(this.prevClose)
      ? Math.max(rng, Math.abs(bar.high - this.prevClose), Math.abs(bar.low - this.prevClose)) : rng;
    this.count++;
    if (this.count <= this.atrLen) { this._trSum += tr; if (this.count === this.atrLen) this.atr = this._trSum / this.atrLen; }
    else this.atr = (this.atr * (this.atrLen - 1) + tr) / this.atrLen;
    if (Number.isFinite(this.atr)) this.atrHist.push(this.atr);
    this.body.push(Math.abs(bar.close - bar.open));
    this.range.push(rng);
    this.vol.push(bar.volume);
    this._todRing(this.tod, bar.mos).push(rng);
    this._todRing(this.todVol, bar.mos).push(bar.volume);
    this.emaPrev = this.ema;
    const a = 2 / (this.emaLen + 1);
    this.ema = Number.isFinite(this.ema) ? this.ema + a * (bar.close - this.ema) : bar.close;
    this.prevClose = bar.close;
    this.closes.push(bar.close);
  }
}

export { Ring };
