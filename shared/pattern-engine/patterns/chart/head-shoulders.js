/**
 * HEAD-AND-SHOULDERS top / bottom — simple version (catalog 01 §C3.3, primitive P3+P16; §D defaults).
 *
 * Emits (family 'chart-reversal'):
 *   head-shoulders-top     LS(H) T1(L) H(H) T2(L) RS(H) — emitted 'forming' when the RS pivot CONFIRMS
 *   head-shoulders-bottom  mirrored (inverse H&S; tag 'inverse-hs')
 *
 * Geometry (5 alternating CONFIRMED majors on the pivot track; zigzag primary, fractal secondary, tagged geometry.gen):
 *   head is the highest: H > LS + tolHead and H > RS + tolHead (tolHead = tol_eq of the tf: 0.5 ATR ≤5m, 0.4 above)
 *   head prominence: (H − max(LS,RS)) ≥ minHeadProm × headHeight (headHeight = H − neckline value under the head)
 *   shoulders equal-ish: |LS − RS| ≤ min(shoulderTolAtr·ATR, shoulderTolPct × headHeight)
 *   time symmetry: (tH − tLS)/(tRS − tH) within [symMin, symMax]
 *   neckline = line through T1,T2 (sloped): |slope|/ATR ≤ maxNeckSlopeAtrPerBar; headHeight ≥ minHeadHeightAtr·ATR
 *   duration LS→RS within [minDur, maxDur] bars; no bar between LS and now exceeds the head (fractal track guard)
 * Levels (top): trigger = neckline value at the emission bar with triggerSlope (points/bar) so the lifecycle extends
 *   the sloped line; triggerSide 'below'; invalidation = head + eps (close beyond the head voids the pattern);
 *   target = trigger − headHeight, target2 = trigger − 0.62·headHeight; extra = { neck1, neck2, neckAtHead, neckSlope,
 *   ls, head, rs }. Bottoms mirrored.
 * Geometry: headHeightAtr, shoulderAsymAtr, shoulderAsymPct, timeSymmetry, necklineSlopeAtrPerBar, headPromPct,
 *   durationBars, priorMoveAtr/Bars/Er (leg into LS from the prior opposite pivot), tags.
 * Key = `${LS.ts}:${gen}` (engine dedups per generator).
 */
const TICK = 0.25;

function tolEqAtrFor(tfMin) { return tfMin <= 5 ? 0.5 : tfMin < 1440 ? 0.4 : 0.3; }

function barAt(ctx, idx) {
  const off = idx - ctx.barIdx - 1;
  if (off >= 0 || -off > ctx.bars.length) return null;
  return ctx.bars.at(off);
}
function extremeBetween(ctx, a, b, s) {
  if (b < a) return null;
  let v = s > 0 ? -Infinity : Infinity;
  for (let i = a; i <= b; i++) {
    const bar = barAt(ctx, i);
    if (!bar) return null;
    const x = s > 0 ? bar.high : bar.low;
    if (s > 0 ? x > v : x < v) v = x;
  }
  return v;
}
function spansSession(ctx, idx) { const b = barAt(ctx, idx); return b ? b.ssUtc !== ctx.bar.ssUtc : null; }
function efficiency(ctx, a, b) {
  if (b - a < 2) return null;
  let sum = 0, prev = null;
  for (let i = a; i <= b; i++) {
    const bar = barAt(ctx, i);
    if (!bar) return null;
    if (prev != null) sum += Math.abs(bar.close - prev);
    prev = bar.close;
  }
  return sum > 0 ? Math.abs(prev - barAt(ctx, a).close) / sum : null;
}

export default {
  id: 'head-shoulders', family: 'chart-reversal', tfs: null,
  params: {
    gens: ['zigzag', 'fractal'],
    tolHeadAtr: null,            // null → tol_eq of the tf (0.5 ATR ≤5m, 0.4 intraday, 0.3 daily)
    shoulderTolAtr: 1.0, shoulderTolPct: 0.35, shoulderTolPctDaily: 0.15,
    symMin: 0.5, symMax: 2.0,
    minHeadProm: 0.2,            // (head − max shoulder) / headHeight
    maxNeckSlopeAtrPerBar: 0.15,
    minHeadHeightAtr: 2.0,
    minDur: 12, maxDur: 200,
    flatSlopeAtrPerBar: 0.02,
    invEpsTicks: 2,
    minPriorMoveAtr: 0,          // record only by default (Bulkowski: prior move ≥ pattern height preferred)
  },
  create({ tf, tfMin, params: P }) {
    const tolHeadAtr = P.tolHeadAtr ?? tolEqAtrFor(tfMin);
    const shPct = tfMin >= 1440 ? P.shoulderTolPctDaily : P.shoulderTolPct;
    const gens = new Set(P.gens || ['zigzag', 'fractal']);
    const paramsId = `hs:${tf}:tolH${tolHeadAtr}:sh${P.shoulderTolAtr}/${shPct}:sym${P.symMin}-${P.symMax}:neck${P.maxNeckSlopeAtrPerBar}`;

    function detect(piv, gen, ctx) {
      const f = ctx.f, atr = f.atr;
      if (!Number.isFinite(atr) || atr <= 0) return;
      const M = ctx.pivots[gen].majors;
      const n = M.length;
      if (n < 5 || (M[n - 1] !== piv && M[n - 1].ts !== piv.ts)) return;
      const s = piv.kind === 'H' ? 1 : -1;
      const RS = M[n - 1], T2 = M[n - 2], H = M[n - 3], T1 = M[n - 4], LS = M[n - 5];
      if (LS.kind !== piv.kind || H.kind !== piv.kind || T1.kind === piv.kind || T2.kind === piv.kind) return;
      const dur = RS.barIdx - LS.barIdx;
      if (dur < P.minDur || dur > P.maxDur) return;
      const tolHead = Math.max(tolHeadAtr * atr, 2 * TICK);
      // head strictly the most extreme
      if (s * (H.price - LS.price) <= tolHead || s * (H.price - RS.price) <= tolHead) return;
      // neckline through T1, T2
      const dt = T2.barIdx - T1.barIdx;
      if (dt <= 0) return;
      const slope = (T2.price - T1.price) / dt;                       // points per bar
      const slopeN = slope / atr;
      if (Math.abs(slopeN) > P.maxNeckSlopeAtrPerBar) return;
      const neckAt = (idx) => T1.price + slope * (idx - T1.barIdx);
      const neckHead = neckAt(H.barIdx);
      const headHeight = s * (H.price - neckHead);
      if (headHeight < Math.max(P.minHeadHeightAtr * atr, 4 * TICK)) return;
      // shoulders
      const shDiff = Math.abs(LS.price - RS.price);
      if (shDiff > Math.min(P.shoulderTolAtr * atr, shPct * headHeight)) return;
      const shTop = s > 0 ? Math.max(LS.price, RS.price) : Math.min(LS.price, RS.price);
      const headProm = s * (H.price - shTop) / headHeight;
      if (headProm < P.minHeadProm) return;
      // shoulders must sit above the neckline (top) — armpits define the neck, shoulders are peaks above it
      if (s * (LS.price - neckAt(LS.barIdx)) <= 0 || s * (RS.price - neckAt(RS.barIdx)) <= 0) return;
      // time symmetry
      const tl = H.barIdx - LS.barIdx, tr = RS.barIdx - H.barIdx;
      if (tl <= 0 || tr <= 0) return;
      const sym = tl / tr;
      if (sym < P.symMin || sym > P.symMax) return;
      // no bar from LS to now beyond the head (fractal guard; zigzag guarantees it)
      const ext = extremeBetween(ctx, LS.barIdx, ctx.barIdx, s);
      if (ext != null && s * (ext - H.price) > 0) return;
      // prior move into LS
      const P0 = n >= 6 && M[n - 6].kind !== piv.kind ? M[n - 6] : null;
      const priorMove = P0 ? s * (LS.price - P0.price) : null;
      const priorMoveAtr = priorMove != null ? priorMove / atr : null;
      if (priorMoveAtr != null && priorMoveAtr < P.minPriorMoveAtr) return;
      const priorEr = P0 ? efficiency(ctx, P0.barIdx, LS.barIdx) : null;

      const eps = Math.max(P.invEpsTicks * TICK, TICK);
      const trig = neckAt(ctx.barIdx);
      const dir = s > 0 ? 'down' : 'up', side = s > 0 ? 'below' : 'above';
      const tags = [];
      if (s < 0) tags.push('inverse-hs');
      tags.push(Math.abs(slopeN) <= P.flatSlopeAtrPerBar ? 'neck-flat' : (slope > 0 ? 'neck-up' : 'neck-down'));
      if (s * (RS.price - LS.price) > 0) tags.push(s > 0 ? 'higher-right-shoulder' : 'lower-right-shoulder');
      if (priorMoveAtr != null && priorMoveAtr >= headHeight / atr) tags.push('prior-move-ge-height');
      const roles = s > 0 ? ['ls', 't1', 'head', 't2', 'rs'] : ['ls', 'p1', 'head', 'p2', 'rs'];
      const anch = (p, role) => ({ role, ts: p.ts, price: p.price, confirmedAt: p.confirmedAt });
      ctx.emit({
        patternId: s > 0 ? 'head-shoulders-top' : 'head-shoulders-bottom', family: 'chart-reversal', key: `${LS.ts}:${gen}`, state: 'forming', direction: dir,
        levels: {
          trigger: trig, triggerSlope: slope, triggerSide: side, invalidation: H.price + s * eps,
          target: trig - s * headHeight, target2: trig - s * 0.62 * headHeight,
          extra: { neck1: T1.price, neck2: T2.price, neckAtHead: neckHead, neckSlope: slope, ls: LS.price, head: H.price, rs: RS.price },
        },
        anchors: [anch(LS, roles[0]), anch(T1, roles[1]), anch(H, roles[2]), anch(T2, roles[3]), anch(RS, roles[4])],
        geometry: {
          gen, params: paramsId, durationBars: dur, heightAtr: headHeight / atr, headHeightAtr: headHeight / atr,
          shoulderAsymAtr: shDiff / atr, shoulderAsymPct: shDiff / headHeight, timeSymmetry: sym, leftBars: tl, rightBars: tr,
          necklineSlopeAtrPerBar: slopeN, headPromPct: headProm,
          lsHeightAtr: s * (LS.price - neckAt(LS.barIdx)) / atr, rsHeightAtr: s * (RS.price - neckAt(RS.barIdx)) / atr,
          priorMoveAtr, priorMoveBars: P0 ? LS.barIdx - P0.barIdx : null, priorEr,
          confirmLagBars: ctx.barIdx - RS.barIdx, spansSession: spansSession(ctx, LS.barIdx), tags,
        },
      });
    }

    return {
      onPivot(piv, gen, ctx) { if (gens.has(gen)) detect(piv, gen, ctx); },
      onBar() {},
    };
  },
};
