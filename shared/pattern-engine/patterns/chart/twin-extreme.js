/**
 * TWIN-EXTREME family (canonical primitive P3, catalog 00 master index; catalog 01 §C3.1 / §C3.2 / §D).
 *
 * Emits (family 'chart-reversal'):
 *   double-top / double-bottom      when the SECOND same-kind pivot CONFIRMS on the pivot track
 *   triple-top / triple-bottom      when the THIRD same-kind pivot confirms (two intervening opposite pivots)
 *   double-top-test / double-bottom-test
 *                                   the moment a closed bar first TOUCHES the twin level (within tol_eq) after a
 *                                   ≥ depth retrace from a confirmed extreme and BEFORE the second pivot confirms
 *                                   ("second test of a prior extreme"; Bulkowski's swing/aggressive entry).
 *
 * Generators: runs on the zigzag track (primary) and the fractal track (secondary) — same logic, tagged
 * `geometry.gen`; instances are keyed `${firstAnchorTs}:${gen}` so the engine dedups per generator.
 *
 * Geometry (all pivots CONFIRMED, i.e. `confirmedAt <= ctx.now`, majors alternate H/L by construction):
 *   tops:  P1 (H) … P2 (L, the "neckline" trough) … P3 (H) with |P1−P3| ≤ tol_eq, minSep ≤ (P3−P1 bars) ≤ maxSep,
 *          depth = min(P1,P3) − P2 ≥ depthAtr·ATR AND ≥ minDepthPctPriorLeg × (P1 − P0) when P0 (prior L) is known.
 *   levels: trigger = P2 (close below); invalidation = max(P1,P3) + eps; target = P2 − H, target2 = P2 − 0.62·H,
 *           H = max(P1,P3) − P2.  Bottoms mirrored.
 *   triple: P1..P5, all three extremes within tol_eq of each other, both troughs ≥ depth; trigger = the deeper
 *           trough (lowest valley for tops / highest peak for bottoms); anchors 5.
 * Adam/Eve: width of each extreme at (extreme ∓ shapeTolAtr·ATR): contiguous bars around the pivot bar whose
 *   high (low) is within that band. Adam = width ≤ adamMaxWidth (narrow spike), else Eve (wide/rounded).
 * Tags: 'adam-adam' | 'adam-eve' | 'eve-adam' | 'eve-eve', 'eqh'/'eql' (SMC equal highs/lows, twinDiff ≤ 0.1 ATR),
 *   'eqh-sweep'/'eql-sweep' (second extreme beyond the first — a 1-tick sweep flavour, Bulkowski allows it within tol),
 *   'big-m'/'big-w' (tall straight run into P1: priorMove ≥ bigMoveAtr with efficiency ratio ≥ bigEr),
 *   'part-of-triple' on a double that also completes a triple at the same emission.
 *
 * All thresholds ATR-scaled at detection time (f.atr of the emitting bar), floored in ticks. Loops are bounded:
 * ≤ maxPivots majors per event, ≤ maxSep bars per scan, ≤ maxArmed armed extremes per (gen, kind) per bar.
 */
const TICK = 0.25;

/** §D defaults by timeframe (minutes) */
function tfDefaults(tfMin) {
  if (tfMin <= 5) return { tolEqAtr: 0.5, depthAtr: 2.5, minSep: 10, maxSep: 150, id: 'd:tol.5:dep2.5:sep10-150' };
  if (tfMin <= 30) return { tolEqAtr: 0.4, depthAtr: 2.0, minSep: 8, maxSep: 120, id: 'd:tol.4:dep2:sep8-120' };
  if (tfMin < 1440) return { tolEqAtr: 0.4, depthAtr: 2.0, minSep: 8, maxSep: 100, id: 'd:tol.4:dep2:sep8-100' };
  return { tolEqAtr: 0.3, depthAtr: 2.0, minSep: 10, maxSep: 100, id: 'd:tol.3:dep2:sep10-100' };
}

/** bar with engine index `idx` from the ring (null if evicted / future) */
function barAt(ctx, idx) {
  const off = idx - ctx.barIdx - 1;          // at(-1) is barIdx
  if (off >= 0 || -off > ctx.bars.length) return null;
  return ctx.bars.at(off);
}

/** extreme (max high for s>0, min low for s<0) over bars [a, b] inclusive; null if any bar is missing */
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

/** most extreme OPPOSITE-side value (min low for tops) over bars [a,b]; returns {price, idx, ts, closeTs} or null */
function troughBetween(ctx, a, b, s) {
  let best = null;
  for (let i = a; i <= b; i++) {
    const bar = barAt(ctx, i);
    if (!bar) continue;
    const x = s > 0 ? bar.low : bar.high;
    if (!best || (s > 0 ? x < best.price : x > best.price)) best = { price: x, idx: i, ts: bar.ts, closeTs: bar.closeTs };
  }
  return best;
}

/**
 * Adam/Eve width of an extreme: contiguous bars around pivot bar `idx` whose extreme is within `band` of `price`.
 * Only bars available in the ring and already closed (idx <= ctx.barIdx) are inspected (bounded ±maxW).
 */
function shapeWidth(ctx, idx, price, s, band, maxW = 12) {
  const c = barAt(ctx, idx);
  if (!c) return { width: null, shape: null, pivotRangeRel: null };
  const within = (bar) => (s > 0 ? price - bar.high : bar.low - price) <= band;
  let w = 1;
  for (let j = 1; j <= maxW; j++) { const b = barAt(ctx, idx - j); if (!b || !within(b)) break; w++; }
  for (let j = 1; j <= maxW; j++) { if (idx + j > ctx.barIdx) break; const b = barAt(ctx, idx + j); if (!b || !within(b)) break; w++; }
  const med = c.f?.medRange;
  return { width: w, pivotRangeRel: med ? (c.high - c.low) / med : null };
}

/** true when the bar at `idx` belongs to a different session (18:00 ET roll) than the current bar; null if evicted */
function spansSession(ctx, idx) {
  const b = barAt(ctx, idx);
  return b ? b.ssUtc !== ctx.bar.ssUtc : null;
}

/** Kaufman efficiency ratio of closes over bars [a,b]; null if bars missing */
function efficiency(ctx, a, b) {
  if (b - a < 2) return null;
  let sum = 0, prev = null;
  for (let i = a; i <= b; i++) {
    const bar = barAt(ctx, i);
    if (!bar) return null;
    if (prev != null) sum += Math.abs(bar.close - prev);
    prev = bar.close;
  }
  const first = barAt(ctx, a).close;
  return sum > 0 ? Math.abs(prev - first) / sum : null;
}

export default {
  id: 'twin-extreme', family: 'chart-reversal', tfs: null,
  params: {
    gens: ['zigzag', 'fractal'],
    tolEqAtr: null, depthAtr: null, minSep: null, maxSep: null,   // null → §D per-tf defaults
    minDepthPctPriorLeg: 0.35,   // depth must also be ≥ 35% of the leg into P1 (when P0 is known)
    tripleMaxSpanMult: 1.5,      // triple total span ≤ maxSep × this
    shapeTolAtr: 0.5, adamMaxWidth: 3,   // catalog §C3.1: width at extreme ∓ 0.5·ATR; Adam ≤ 3 bars
    eqAtr: 0.1,                  // SMC EQH/EQL tag when |P1−P3| ≤ 0.1 ATR
    invEpsTicks: 2,              // invalidation = twin extreme + 2 ticks (lifecycle adds its own close-eps)
    bigMoveAtr: 5, bigEr: 0.6,   // Big M / Big W tag
    maxPivots: 12, maxArmed: 6, emitTest: true,
  },
  create({ tf, tfMin, params: P }) {
    const D = tfDefaults(tfMin);
    const tolEqAtr = P.tolEqAtr ?? D.tolEqAtr, depthAtrMin = P.depthAtr ?? D.depthAtr;
    const minSep = P.minSep ?? D.minSep, maxSep = P.maxSep ?? D.maxSep;
    const paramsId = `twin:${tf}:${P.tolEqAtr == null ? D.id : `tol${tolEqAtr}:dep${depthAtrMin}:sep${minSep}-${maxSep}`}`;
    const gens = new Set(P.gens || ['zigzag', 'fractal']);
    // armed extremes for the "test" event: gen -> kind -> [{piv, prev, minSince, done}]
    const armed = { zigzag: { H: [], L: [] }, fractal: { H: [], L: [] } };

    const thresholds = (atr) => ({
      tolEq: Math.max(tolEqAtr * atr, 2 * TICK),
      depth: Math.max(depthAtrMin * atr, 4 * TICK),
      eps: Math.max(P.invEpsTicks * TICK, TICK),
      band: Math.max(P.shapeTolAtr * atr, TICK),
    });

    function shapeOf(ctx, piv, s, band) {
      const r = shapeWidth(ctx, piv.barIdx, piv.price, s, band);
      const shape = r.width == null ? null : (r.width <= P.adamMaxWidth ? 'adam' : 'eve');
      return { ...r, shape };
    }

    /** prior leg into P1: from the opposite pivot P0 (if known) */
    function priorLeg(ctx, P0, P1, s, atr) {
      if (!P0) return { priorMoveAtr: null, priorMoveBars: null, priorEr: null, priorMove: null };
      const priorMove = s * (P1.price - P0.price);
      return { priorMove, priorMoveAtr: priorMove / atr, priorMoveBars: P1.barIdx - P0.barIdx, priorEr: efficiency(ctx, P0.barIdx, P1.barIdx) };
    }

    /** try double + triple at the confirmation of same-kind pivot majors[-1] */
    function onExtreme(piv, gen, ctx) {
      const f = ctx.f, atr = f.atr;
      if (!Number.isFinite(atr) || atr <= 0) return;
      const s = piv.kind === 'H' ? 1 : -1;
      const M = ctx.pivots[gen].majors;
      const n = M.length;
      if (n < 3 || (M[n - 1] !== piv && M[n - 1].ts !== piv.ts)) return;
      const T = thresholds(atr);
      const P3 = M[n - 1], P2 = M[n - 2], P1 = M[n - 3];
      if (P2.kind === piv.kind || P1.kind !== piv.kind) return;
      const sep = P3.barIdx - P1.barIdx;
      if (sep < minSep || sep > maxSep) return;
      const twinDiff = Math.abs(P1.price - P3.price);
      if (twinDiff > T.tolEq) return;
      const shallowPeak = s > 0 ? Math.min(P1.price, P3.price) : Math.max(P1.price, P3.price);
      const twinLevel = s > 0 ? Math.max(P1.price, P3.price) : Math.min(P1.price, P3.price);
      const depth = s * (shallowPeak - P2.price);
      if (depth < T.depth) return;
      // no bar between P1 and now may exceed the twin level (fractal track does not guarantee this)
      const ext = extremeBetween(ctx, P1.barIdx, ctx.barIdx, s);
      if (ext != null && s * (ext - twinLevel) > T.tolEq) return;
      const P0 = n >= 4 && M[n - 4].kind !== piv.kind ? M[n - 4] : null;
      const pl = priorLeg(ctx, P0, P1, s, atr);
      const depthPctPriorLeg = pl.priorMove > 0 ? depth / pl.priorMove : null;
      if (depthPctPriorLeg != null && depthPctPriorLeg < P.minDepthPctPriorLeg) return;
      const height = s * (twinLevel - P2.price);
      const dir = s > 0 ? 'down' : 'up', side = s > 0 ? 'below' : 'above';
      const sh1 = shapeOf(ctx, P1, s, T.band), sh2 = shapeOf(ctx, P3, s, T.band);
      const secondBeyond = s * (P3.price - P1.price) > 0;
      const tags = [];
      if (sh1.shape && sh2.shape) tags.push(`${sh1.shape}-${sh2.shape}`);
      if (twinDiff <= P.eqAtr * atr) tags.push(s > 0 ? 'eqh' : 'eql');
      if (secondBeyond) tags.push(s > 0 ? 'eqh-sweep' : 'eql-sweep');
      if (pl.priorMoveAtr != null && pl.priorMoveAtr >= P.bigMoveAtr && pl.priorEr != null && pl.priorEr >= P.bigEr) tags.push(s > 0 ? 'big-m' : 'big-w');
      const kindName = s > 0 ? 'top' : 'bottom';
      const roles = s > 0 ? ['peak1', 'trough', 'peak2'] : ['trough1', 'peak', 'trough2'];
      const anch = (p, role) => ({ role, ts: p.ts, price: p.price, confirmedAt: p.confirmedAt });

      // ---- triple (P1..P5) — checked first so the double can be tagged
      let tripleEmitted = false;
      if (n >= 5) {
        const Q5 = P3, Q4 = P2, Q3 = P1, Q2 = M[n - 4], Q1 = M[n - 5];
        if (Q1.kind === piv.kind && Q2.kind !== piv.kind) {
          const peaks = [Q1.price, Q3.price, Q5.price];
          const pMax = Math.max(...peaks), pMin = Math.min(...peaks);
          const span = Q5.barIdx - Q1.barIdx;
          const sep12 = Q3.barIdx - Q1.barIdx, sep23 = Q5.barIdx - Q3.barIdx;
          const tLevel = s > 0 ? pMax : pMin, tShallow = s > 0 ? pMin : pMax;
          const d1 = s * (tShallow - Q2.price), d2 = s * (tShallow - Q4.price);
          const extT = extremeBetween(ctx, Q1.barIdx, ctx.barIdx, s);
          if (pMax - pMin <= T.tolEq && sep12 >= minSep && sep23 >= minSep && span <= maxSep * P.tripleMaxSpanMult
            && d1 >= T.depth && d2 >= T.depth && !(extT != null && s * (extT - tLevel) > T.tolEq)) {
            const Q0 = n >= 6 && M[n - 6].kind !== piv.kind ? M[n - 6] : null;
            const tpl = priorLeg(ctx, Q0, Q1, s, atr);
            const trigT = s > 0 ? Math.min(Q2.price, Q4.price) : Math.max(Q2.price, Q4.price);
            const hT = s * (tLevel - trigT);
            const lowerFinal = s * (tLevel - Q5.price) > T.tolEq / 2;
            const trRoles = s > 0 ? ['peak1', 'trough1', 'peak2', 'trough2', 'peak3'] : ['trough1', 'peak1', 'trough2', 'peak2', 'trough3'];
            const ttags = [];
            if (pMax - pMin <= P.eqAtr * atr) ttags.push(s > 0 ? 'eqh' : 'eql');
            if (lowerFinal) ttags.push('lower-final-extreme');
            ctx.emit({
              patternId: `triple-${kindName}`, family: 'chart-reversal', key: `${Q1.ts}:${gen}`, state: 'forming', direction: dir,
              levels: { trigger: trigT, triggerSide: side, invalidation: tLevel + s * T.eps, target: trigT - s * hT, target2: trigT - s * 0.62 * hT,
                extra: { twinLevel: tLevel, trough1: Q2.price, trough2: Q4.price, extremes: peaks } },
              anchors: [anch(Q1, trRoles[0]), anch(Q2, trRoles[1]), anch(Q3, trRoles[2]), anch(Q4, trRoles[3]), anch(Q5, trRoles[4])],
              geometry: {
                gen, params: paramsId, durationBars: span, sepBars: span, sep12, sep23, heightAtr: hT / atr,
                twinDiffAtr: (pMax - pMin) / atr, depth1Atr: d1 / atr, depth2Atr: d2 / atr,
                priorMoveAtr: tpl.priorMoveAtr, priorMoveBars: tpl.priorMoveBars, priorEr: tpl.priorEr,
                depthPctPriorLeg: tpl.priorMove > 0 ? Math.min(d1, d2) / tpl.priorMove : null,
                lowerFinalExtreme: lowerFinal, spansSession: spansSession(ctx, Q1.barIdx), tags: ttags,
              },
            });
            tripleEmitted = true;
          }
        }
      }
      if (tripleEmitted) tags.push('part-of-triple');

      ctx.emit({
        patternId: `double-${kindName}`, family: 'chart-reversal', key: `${P1.ts}:${gen}`, state: 'forming', direction: dir,
        levels: { trigger: P2.price, triggerSide: side, invalidation: twinLevel + s * T.eps, target: P2.price - s * height, target2: P2.price - s * 0.62 * height,
          extra: { twinLevel, trough: P2.price, peak1: P1.price, peak2: P3.price } },
        anchors: [anch(P1, roles[0]), anch(P2, roles[1]), anch(P3, roles[2])],
        geometry: {
          gen, params: paramsId, durationBars: sep, sepBars: sep, heightAtr: height / atr, depthAtr: depth / atr, twinDiffAtr: twinDiff / atr,
          secondHigher: s > 0 ? P3.price > P1.price : P3.price < P1.price, secondBeyond,
          shape1: sh1.shape, shape2: sh2.shape, width1: sh1.width, width2: sh2.width, pivotRangeRel1: sh1.pivotRangeRel, pivotRangeRel2: sh2.pivotRangeRel,
          priorMoveAtr: pl.priorMoveAtr, priorMoveBars: pl.priorMoveBars, priorEr: pl.priorEr, depthPctPriorLeg,
          confirmLagBars: ctx.barIdx - P3.barIdx, spansSession: spansSession(ctx, P1.barIdx), tags,
        },
      });
    }

    /** arm a freshly confirmed extreme for the "test" event */
    function arm(piv, gen, ctx) {
      const M = ctx.pivots[gen].majors;
      const n = M.length;
      const prev = n >= 2 && M[n - 2].kind !== piv.kind ? M[n - 2] : null;
      const list = armed[gen][piv.kind];
      // a new same-kind major supersedes an armed one it displaced (same barIdx) or that it exceeds
      const s = piv.kind === 'H' ? 1 : -1;
      for (const a of list) if (a.piv.barIdx === piv.barIdx || s * (piv.price - a.piv.price) > 0) a.done = true;
      list.push({ piv, prev, done: false });
      while (list.length > P.maxArmed) list.shift();
    }

    function checkTests(bar, f, ctx) {
      const atr = f.atr;
      if (!Number.isFinite(atr) || atr <= 0) return;
      const T = thresholds(atr);
      for (const gen of gens) {
        for (const kind of ['H', 'L']) {
          const s = kind === 'H' ? 1 : -1;
          const list = armed[gen][kind];
          for (let i = list.length - 1; i >= 0; i--) {
            const a = list[i];
            const sep = ctx.barIdx - a.piv.barIdx;
            if (a.done || sep > maxSep) { list.splice(i, 1); continue; }
            const P1 = a.piv;
            const touch = s * ((s > 0 ? bar.high : bar.low) - P1.price);   // signed distance of the bar extreme beyond P1 (>0 = swept)
            if (touch > T.tolEq) { list.splice(i, 1); continue; }              // blown through: not a test
            if (sep < minSep || touch < -T.tolEq) continue;                    // not yet touching
            // touching: need a ≥ depth retrace between P1 and this bar (bars strictly between)
            const tr = troughBetween(ctx, P1.barIdx + 1, ctx.barIdx - 1, s);
            if (!tr) { list.splice(i, 1); continue; }
            const depth = s * (P1.price - tr.price);
            if (depth < T.depth) { list.splice(i, 1); continue; }              // touching without a real retrace: not a twin test
            const pl = priorLeg(ctx, a.prev, P1, s, atr);
            const depthPctPriorLeg = pl.priorMove > 0 ? depth / pl.priorMove : null;
            list.splice(i, 1);                                                  // at most once per P1
            if (depthPctPriorLeg != null && depthPctPriorLeg < P.minDepthPctPriorLeg) continue;
            const kindName = s > 0 ? 'top' : 'bottom';
            const trig = s > 0 ? bar.low : bar.high;
            const tags = [s > 0 ? 'eqh-test' : 'eql-test'];
            if (touch > 0) tags.push('sweep');
            if (s * (bar.close - P1.price) <= 0 && touch > 0) tags.push('sweep-close-back');
            ctx.emit({
              patternId: `double-${kindName}-test`, family: 'chart-reversal', key: `${bar.ts}:${gen}`, state: 'forming', direction: s > 0 ? 'down' : 'up',
              levels: { trigger: trig, triggerSide: s > 0 ? 'below' : 'above', invalidation: P1.price + s * T.tolEq, target: tr.price, target2: tr.price + s * 0.38 * depth,
                extra: { twinLevel: P1.price, trough: tr.price, testExtreme: s > 0 ? bar.high : bar.low } },
              anchors: [
                { role: s > 0 ? 'peak1' : 'trough1', ts: P1.ts, price: P1.price, confirmedAt: P1.confirmedAt },
                { role: s > 0 ? 'trough' : 'peak', ts: tr.ts, price: tr.price, confirmedAt: tr.closeTs },
                { role: 'test', ts: bar.ts, price: s > 0 ? bar.high : bar.low, confirmedAt: bar.closeTs },
              ],
              geometry: {
                gen, params: paramsId, durationBars: sep, sepBars: sep, heightAtr: depth / atr, depthAtr: depth / atr,
                touchDiffAtr: touch / atr, swept: touch > 0, closeVsTwinAtr: (bar.close - P1.price) / atr,
                testBarRangeAtr: (bar.high - bar.low) / atr, testBarClv: f.clv,
                priorMoveAtr: pl.priorMoveAtr, priorMoveBars: pl.priorMoveBars, priorEr: pl.priorEr, depthPctPriorLeg,
                spansSession: spansSession(ctx, P1.barIdx), tags,
              },
            });
          }
        }
      }
    }

    return {
      onPivot(piv, gen, ctx) {
        if (!gens.has(gen)) return;
        onExtreme(piv, gen, ctx);
        if (P.emitTest) arm(piv, gen, ctx);
      },
      onBar(bar, f, ctx) {
        if (P.emitTest) checkTests(bar, f, ctx);
      },
    };
  },
};
