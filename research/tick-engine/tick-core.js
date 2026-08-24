/**
 * TickCore — the tick engine's cursor and hot loop.
 *
 * Contract: state after processing bar i is a pure function of bars ≤ i. Nothing reads ahead.
 * Per 1s bar it (1) updates session stats, (2) advances each timeframe's forming bar and closes it
 * on the boundary, (3) exposes the forming (provisional) bar to strategies, (4) evaluates the
 * WatchIndex against [low, high] — which is where decisions actually fire, on price, not on a clock.
 *
 * Everything in INTEGER TICKS. Timeframe boundaries are integer offsets from the session open
 * (18:00 ET), taken from the cache's day index, so the hot loop never calls a timezone routine.
 */
import { WatchIndex } from './watch-index.js';

const TF_SEC = { '1s': 1, '5s': 5, '15s': 15, '30s': 30, '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };

class TfState {
  constructor(tf, sec) {
    this.tf = tf; this.sec = sec;
    this.openTs = 0; this.endTs = 0;
    this.o = 0; this.h = -2147483648; this.l = 2147483647; this.c = 0; this.v = 0; this.n = 0;
    this.count = 0;              // closed bars seen
    this.prevClose = 0;
    this.atr = 0; this._trSum = 0; this.atrLen = 14;
    this.ema = 0; this.emaPrev = 0; this.emaLen = 20;
    this.closedO = 0; this.closedH = 0; this.closedL = 0; this.closedC = 0; this.closedV = 0; this.closedTs = 0;
  }
  reset() { this.o = 0; this.h = -2147483648; this.l = 2147483647; this.c = 0; this.v = 0; this.n = 0; }
  get forming() { return this.n > 0; }
}

export class TickCore {
  constructor({ cache, timeframes = ['1m', '5m', '15m'], watchCapacity = 8192, bucketTicks = 64 } = {}) {
    this.cache = cache;
    this.tfs = timeframes.map((tf) => new TfState(tf, TF_SEC[tf] ?? (() => { throw new Error(`bad tf ${tf}`); })()));
    this.watches = new WatchIndex({ capacity: watchCapacity, bucketTicks });
    this.session = { openTs: 0, endTs: 0, hi: -2147483648, lo: 2147483647, open: 0, tradeDate: null };
    this.row = -1; this.ts = 0; this.sym = -1;
    this.stats = { bars: 0, closes: 0, arms: 0, voids: 0, rolls: 0 };
  }

  /**
   * Run over [from, to) rows. Handlers:
   *   onBarClose(tf, core)     — a timeframe bar just closed (closedO/H/L/C on the TfState)
   *   onTick(core)             — every 1s bar, AFTER aggregation, BEFORE watch evaluation
   *   onArm(meta, level, core) / onVoid(meta, reason, core)
   *   onRoll(core)             — primary contract changed (levels from the old contract are invalid)
   */
  run(from, to, h = {}) {
    const C = this.cache, { ts, o, hi: _hi } = C;
    const O = C.o, H = C.h, L = C.l, CL = C.c, V = C.v, SY = C.sym, TS = C.ts;
    const tfs = this.tfs, nTf = tfs.length, W = this.watches, S = this.session;
    const onArm = h.onArm ? (slot, meta, lvl) => { this.stats.arms++; h.onArm(meta, lvl, this); } : null;
    const onVoid = h.onVoid ? (slot, meta, reason) => { this.stats.voids++; h.onVoid(meta, reason, this); } : null;
    // seed session bounds from the day index
    const days = C.meta.days, dayKeys = this._dayKeysFor(from, to);
    let dk = 0;
    for (let i = from; i < to; i++) {
      const t = TS[i];
      // ---- session / day advance (cheap: only when we cross the precomputed row range)
      while (dk < dayKeys.length && i >= days[dayKeys[dk]][1]) dk++;
      if (dk < dayKeys.length && S.tradeDate !== dayKeys[dk] && i >= days[dayKeys[dk]][0]) {
        S.tradeDate = dayKeys[dk];
        S.openTs = TS[days[dayKeys[dk]][0]];
        S.endTs = S.openTs + 86400;
        S.hi = -2147483648; S.lo = 2147483647; S.open = O[i];
        for (let k = 0; k < nTf; k++) { const f = tfs[k]; f.reset(); f.openTs = 0; f.endTs = 0; }
      }
      // ---- contract roll: every price level from the previous contract is meaningless
      if (SY[i] !== this.sym) {
        if (this.sym !== -1) { this.stats.rolls++; if (h.onRoll) h.onRoll(this); }
        this.sym = SY[i];
      }
      this.row = i; this.ts = t;
      const bo = O[i], bh = H[i], bl = L[i], bc = CL[i], bv = V[i];
      if (bh > S.hi) S.hi = bh;
      if (bl < S.lo) S.lo = bl;
      // ---- timeframe aggregation (integer boundaries from the session open)
      for (let k = 0; k < nTf; k++) {
        const f = tfs[k];
        if (t >= f.endTs) {
          if (f.n > 0) { this._closeBar(f); this.stats.closes++; if (h.onBarClose) h.onBarClose(f, this); }
          const off = t - S.openTs;
          const idx = Math.floor(off / f.sec);
          f.openTs = S.openTs + idx * f.sec;
          f.endTs = f.openTs + f.sec;
          f.reset();
        }
        if (f.n === 0) { f.o = bo; f.h = bh; f.l = bl; }
        else { if (bh > f.h) f.h = bh; if (bl < f.l) f.l = bl; }
        f.c = bc; f.v += bv; f.n++;
      }
      if (h.onTick) h.onTick(this);
      // ---- the decision point: conditional triggers against THIS second's range
      if (W.live) W.step(bl, bh, t, onArm, onVoid);
      this.stats.bars++;
    }
    return this.stats;
  }

  _closeBar(f) {
    f.closedO = f.o; f.closedH = f.h; f.closedL = f.l; f.closedC = f.c; f.closedV = f.v; f.closedTs = f.openTs;
    const tr = f.count ? Math.max(f.h - f.l, Math.abs(f.h - f.prevClose), Math.abs(f.l - f.prevClose)) : (f.h - f.l);
    f.count++;
    if (f.count <= f.atrLen) { f._trSum += tr; if (f.count === f.atrLen) f.atr = f._trSum / f.atrLen; }
    else f.atr = (f.atr * (f.atrLen - 1) + tr) / f.atrLen;
    f.emaPrev = f.ema;
    f.ema = f.count === 1 ? f.c : f.ema + (f.c - f.ema) * (2 / (f.emaLen + 1));
    f.prevClose = f.c;
  }

  _dayKeysFor(from, to) {
    const days = this.cache.meta.days;
    return Object.keys(days).sort().filter((k) => days[k][1] > from && days[k][0] < to);
  }

  tf(name) { return this.tfs.find((f) => f.tf === name); }
}
