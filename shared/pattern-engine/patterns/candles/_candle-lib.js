/**
 * Shared helpers for the multi-bar candlestick detectors (two-bar / three-bar / n-bar).
 * Implements the catalog 02 §1.3 normalization: body tiers vs medBody60, "Near/Far/Equal" as fractions
 * of scale = max(ATR, medRange60), doji = body ≤ 10% of own range, everything floored in ticks.
 * All values are computed from CLOSED bars; the current bar's f (BarFeatures.describe) supplies the
 * normalizers, which were built from bars strictly before the current bar.
 *
 * File is prefixed with '_' so the detector registry ignores it.
 */
export const TICK = 0.25;

/** tf-specific tick floors (catalog 02 §1.3): k_tf and minimum range in ticks for a shape label */
export function tfTicks(tfMin) {
  if (tfMin < 5) return { kTf: 4, minRangeTicks: 8 };
  if (tfMin < 15) return { kTf: 3, minRangeTicks: 6 };
  if (tfMin < 60) return { kTf: 2, minRangeTicks: 4 };
  return { kTf: 1, minRangeTicks: 4 };
}

/** Per-bar intrinsic candle struct (cached on the bar object; bars are shared across detectors of a tf). */
export function cs(bar) {
  if (bar._cs) return bar._cs;
  const o = bar.open, h = bar.high, l = bar.low, c = bar.close;
  const bTop = Math.max(o, c), bBot = Math.min(o, c);
  const s = {
    bar, ts: bar.ts, closeTs: bar.closeTs, o, h, l, c,
    rng: h - l, body: Math.abs(c - o), up: h - bTop, lo: bBot - l, bTop, bBot, mid: (o + c) / 2,
    col: c > o ? 1 : c < o ? -1 : 0,
    rz: bar.f && Number.isFinite(bar.f.rangeZ) ? bar.f.rangeZ : NaN,   // range vs same time-of-day median
  };
  bar._cs = s;
  return s;
}

/**
 * Scale-dependent tier tests for one evaluation instant (built from the current bar's features).
 * TA-Lib names re-based per catalog 02 §1.3.
 */
export class Tiers {
  constructor(f, tfMin) {
    const { kTf, minRangeTicks } = tfTicks(tfMin);
    this.ok = Number.isFinite(f.scale) && f.scale > 0 && Number.isFinite(f.medBody) && f.medBody > 0 && Number.isFinite(f.atr) && f.atr > 0;
    this.R = f.scale;                                   // range scale
    this.B = f.medBody;                                 // body scale
    this.S = Math.max((f.medRange - f.medBody) / 2, TICK); // shadow scale (approx: (medRange - medBody)/2)
    this.atr = f.atr;
    this.floorT = kTf * TICK;
    this.minRange = minRangeTicks * TICK;
    this.near = Math.max(0.20 * this.R, this.floorT);
    this.far = 0.60 * this.R;
    this.equal = Math.max(0.05 * this.R, this.floorT);
    this.equalTight = Math.max(0.05 * this.R, 2 * TICK);        // tweezers / matching closes (catalog 4.5, 4.7: floor 2 ticks)
  }
  doji(x) { return x.body <= Math.max(0.10 * x.rng, this.floorT); }
  notDoji(x) { return !this.doji(x); }
  short(x) { return x.body < 0.5 * this.B; }
  notShort(x) { return x.body >= 0.5 * this.B; }
  long(x) { const rz = Number.isFinite(x.rz) ? x.rz : x.rng / this.R; return x.body > 1.5 * this.B && rz > 0.8; }
  veryLong(x) { return x.body > 3.0 * this.B; }
  shVShort(x, s) { return s <= Math.max(0.10 * x.rng, this.floorT); }
  shShort(s) { return s < this.S; }
  shLong(x, s) { return s > Math.max(x.body, 0.5 * x.rng); }
  shVLong(x, s) { return s > Math.max(2 * x.body, 0.66 * x.rng); }
  maru(x) { return this.long(x) && this.shVShort(x, x.up) && this.shVShort(x, x.lo); }
  eq(a, b) { return Math.abs(a - b) <= this.equal; }
  eqTight(a, b) { return Math.abs(a - b) <= this.equalTight; }
  nearEq(a, b) { return Math.abs(a - b) <= this.near; }
  farApart(a, b) { return Math.abs(a - b) > this.far; }
  bigEnough(x) { return x.rng >= this.minRange; }
}

/** inside / outside relations (Brooks non-strict inside, but not identical; strict outside) */
export const inside = (x, m) => x.h <= m.h && x.l >= m.l && !(x.h === m.h && x.l === m.l);
export const outside = (x, m) => x.h > m.h && x.l < m.l;

/**
 * Prior-move context measured BEFORE the pattern's first bar:
 *   priorMoveAtr = (close of bar before pattern − close N bars earlier) / ATR
 *   atExtreme    = pattern low is ≤ min low of the prior K bars ('low') / high ≥ max high ('high')
 * @param ctx engine ctx; nBars = pattern length; N = ctxBars; K = extremeBars
 */
export function priorContext(ctx, nBars, N, K, patLo, patHi, atr) {
  const bars = ctx.bars;
  const avail = bars.length - nBars;          // bars strictly before the pattern
  let priorMoveAtr = NaN, priorMoveBars = 0;
  if (avail >= 2) {
    const n = Math.min(N, avail - 1);
    if (n >= 3) {
      const last = bars.at(-nBars - 1), base = bars.at(-nBars - 1 - n);
      priorMoveAtr = (last.close - base.close) / atr; priorMoveBars = n;
    }
  }
  let atLow = null, atHigh = null;
  if (avail >= 5) {
    const k = Math.min(K, avail);
    let mn = Infinity, mx = -Infinity;
    for (let i = 1; i <= k; i++) { const b = bars.at(-nBars - i); if (b.low < mn) mn = b.low; if (b.high > mx) mx = b.high; }
    atLow = patLo <= mn; atHigh = patHi >= mx;
  }
  return { priorMoveAtr, priorMoveBars, atLow, atHigh };
}

/**
 * Build levels/anchors/geometry and emit one 'forming' event for a completed multi-bar pattern.
 * spec = { id, dir:'up'|'down'|'bilateral', bars:[cs...] oldest→newest (last must be the current bar),
 *          keyBar (index into bars, default last), tags:[], ctxDir:'up'|'down'|null (classical prior-trend
 *          requirement), geo:{...extra}, levels?: override, key?: override, extra?: levels.extra }
 */
export function emitPattern(ctx, f, T, P, spec) {
  const bars = spec.bars;
  const n = bars.length;
  let hi = -Infinity, lo = Infinity;
  for (const x of bars) { if (x.h > hi) hi = x.h; if (x.l < lo) lo = x.l; }
  const H = hi - lo;
  if (H < T.minRange) return false;
  const dir = spec.dir;
  let levels = spec.levels;
  if (!levels) {
    levels = dir === 'up' ? { trigger: hi, triggerSide: 'above', invalidation: lo, target: hi + H }
      : dir === 'down' ? { trigger: lo, triggerSide: 'below', invalidation: hi, target: lo - H }
        : { upper: hi, lower: lo, targetUp: hi + H, targetDown: lo - H };
  }
  if (spec.extra) levels = { ...levels, extra: spec.extra };
  const anchors = bars.map((x, i) => ({ role: `bar${i}`, ts: x.ts, price: x.c, confirmedAt: x.closeTs }));
  const key = spec.key ?? String(bars[0].ts);
  const kb = bars[spec.keyBar ?? n - 1];
  const pc = priorContext(ctx, n, P.ctxBars, P.extremeBars, lo, hi, T.atr);
  const ctxDir = spec.ctxDir ?? null;
  const contextOk = ctxDir == null ? true
    : !Number.isFinite(pc.priorMoveAtr) ? null
      : ctxDir === 'down' ? pc.priorMoveAtr <= -P.ctxAtr : pc.priorMoveAtr >= P.ctxAtr;
  const geometry = {
    durationBars: n, heightAtr: H / T.atr, keyBar: spec.keyBar ?? n - 1,
    bodyRel: kb.rng > 0 ? kb.body / kb.rng : 0, bodyVsMed: kb.body / T.B, rangeRel: kb.rng / T.R,
    lastBodyRel: bars[n - 1].rng > 0 ? bars[n - 1].body / bars[n - 1].rng : 0, lastClv: bars[n - 1].rng > 0 ? ((bars[n - 1].c - bars[n - 1].l) - (bars[n - 1].h - bars[n - 1].c)) / bars[n - 1].rng : 0,
    relVol: f.relVol, emaDist: f.emaDist, emaSlope: f.emaSlope,
    priorMoveAtr: pc.priorMoveAtr, priorMoveBars: pc.priorMoveBars, ctxRequired: ctxDir, contextOk,
    atExtreme: dir === 'up' ? pc.atLow : dir === 'down' ? pc.atHigh : (pc.atLow || pc.atHigh),
    ...(spec.geo || {}), tags: spec.tags || [], params: P.paramSet || 'v0',
  };
  ctx.emit({ patternId: spec.id, family: 'candle', key, state: 'forming', direction: dir, levels, anchors, geometry, note: spec.note });
  return true;
}
