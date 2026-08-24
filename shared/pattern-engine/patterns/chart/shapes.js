/**
 * SLOPE-SIGN SHAPE family (canonical primitives P4 + P5, catalog 00 §A; 01 §A.2/§A.3/§C1.1-1.5/
 * §C2.1-2.8/§D/§E(5)) — "one geometry, many labels".
 *
 * On every confirmed pivot (zigzag primary, fractal second generator, plus a detector-local k=1 fractal
 * track 'fractal1' used ONLY for flags/pennants; geometry.gen tags which) take the last n = 4..7
 * alternating major pivots, fit OUTER lines through the highs and through the lows
 * (envelope: no pivot beyond the line by > tol_line), require no CLOSE inside the span beyond a line
 * by > tol_line, then classify by (upperSlope_n, lowerSlope_n, Δwidth) with §D thresholds and EMIT
 * EVERY applicable label as a separate event (same anchors, different patternId):
 *
 *   flat/flat                          → rectangle                (bilateral)  tags ttr / darvas_box
 *   flat top / rising bottom, conv     → ascending-triangle       (bilateral)
 *   falling top / flat bottom, conv    → descending-triangle      (bilateral)
 *   falling top / rising bottom, conv  → symmetrical-triangle     (bilateral)  + pennant (directional) if pole & short
 *   up/up conv                         → rising-wedge             (reversal ↓; tag continuation if after a DOWN pole)
 *   down/down conv                     → falling-wedge            (reversal ↑; tag continuation if after an UP pole)
 *   up top / down bottom, div          → broadening-top|bottom    (bilateral, by prior trend)
 *   rising top / flat bottom, div      → right-angled-broadening-ascending  (bilateral)
 *   flat top / falling bottom, div     → right-angled-broadening-descending (bilateral)
 *   up/up div (upper steeper)          → ascending-broadening-wedge  (bilateral)
 *   down/down div (lower steeper)      → descending-broadening-wedge (bilateral)
 *   up/up | down/down parallel         → channel-up | channel-down  (bilateral, sloped)
 *   body ≤ flat after an UP pole (P5)  → bull-flag (directional ↑); mirrored bear-flag
 *   partial-rise / partial-decline     → inside a forming range shape, a leg that turns back at ≤ 65% of width
 *
 * Emission = FIRST moment a label qualifies (min pivots + min duration). Re-emission on extension is
 * suppressed by an active-instance record per (gen, label) (any later window overlapping a live
 * instance of the same label is treated as its extension for `activeBars` bars). Bounded: ≤ 7 pivots
 * per generator per event, lines over ≤ 4 points, containment scan ≤ maxBars (150) closed bars.
 */
import { fitOuterLine, lineValueAt, slopeAtr, widthAt, apexBars, priorImpulse } from '../../geometry/lines.js';

const TICK = 0.25;
const RANGE_LABELS = new Set(['rectangle', 'symmetrical-triangle', 'ascending-triangle', 'descending-triangle',
  'broadening-top', 'broadening-bottom', 'right-angled-broadening-ascending', 'right-angled-broadening-descending',
  'ascending-broadening-wedge', 'descending-broadening-wedge']);
const FAMILY = {
  'bull-flag': 'chart-continuation', 'bear-flag': 'chart-continuation', pennant: 'chart-continuation',
  'channel-up': 'chart-continuation', 'channel-down': 'chart-continuation',
  'rising-wedge': 'chart-reversal', 'falling-wedge': 'chart-reversal',
};
const famOf = (pid) => FAMILY[pid] || 'chart-bilateral';

export default {
  id: 'shapes', family: 'chart-bilateral',
  params: {
    tolLineAtr: 0.35, tolLineAtrHtf: 0.30,     // §D tol_line (≥15m uses the htf value)
    flatSlope: 0.02,                           // |slope_n| ≤ flat (ATR/bar)
    convDW: 0.75, wedgeDW: 0.70, triDW: 0.80,  // Δwidth thresholds: converging
    divDW: 1.33, raDW: 1.25,                   // diverging (right-angled variants a bit looser)
    parDW: [0.8, 1.25], rectDW: [0.7, 1.4], flagDW: [0.6, 1.5],
    minHeightAtr: 1.0, ttrHeightAtr: 1.5,
    minPivots: 4, maxPivots: 7,
    flagER: 0.6, flagRetraceMax: 0.5, pennantApexMult: 2.0,
    partialFrac: 0.65,
    activeBars: 60,                            // suppression lifetime of an emitted instance (≈ lifecycle maxFormingBars)
    darvasLookback: 60,
    gens: ['zigzag', 'fractal'],
    fineGen: true,                             // local k=1 fractal track for flags/pennants (gen 'fractal1')
  },
  create({ tf, tfMin, params: P }) {
    // durations in bars, §D (bar-counts ~constant across tfs; slightly shorter on ≥15m)
    const D = tfMin >= 1440 ? { flag: [3, 15], tri: [15, 65], rect: [15, 150], broad: [15, 90], chan: [20, 150] }
      : tfMin >= 15 ? { flag: [4, 15], tri: [15, 60], rect: [15, 150], broad: [15, 80], chan: [20, 150] }
        : { flag: [4, 20], tri: [15, 90], rect: [15, 150], broad: [15, 90], chan: [20, 150] };
    const FLAG = tfMin >= 1440 ? { K: 3, M: 8 } : tfMin >= 60 ? { K: 3, M: 10 } : tfMin >= 15 ? { K: 3.5, M: 12 } : { K: 4, M: 15 };
    const tolAtr = tfMin >= 15 ? P.tolLineAtrHtf : P.tolLineAtr;
    const MAXBARS = 150;
    const active = new Map();      // `${gen}:${pid}` -> { firstIdx, firstTs, lastIdx, emittedIdx, U, L, height, tol, anchors, pid, gen }
    const paramsId = { tolLineAtr: tolAtr, flatSlope: P.flatSlope, convDW: P.convDW, divDW: P.divDW, flagK: FLAG.K, flagM: FLAG.M, flagER: P.flagER };

    const barAt = (ctx, barIdx) => { const off = barIdx - ctx.barIdx; if (off > 0 || -off >= ctx.bars.length) return null; return ctx.bars.at(off - 1); };
    const posOf = (ctx, barIdx) => ctx.bars.length - 1 - (ctx.barIdx - barIdx);   // ring position for BarRing.at(pos)
    const inRange = (d, r) => d >= r[0] && d <= r[1];
    const cls = (s) => (s > P.flatSlope ? 1 : s < -P.flatSlope ? -1 : 0);
    const monotone = (pts, dir, tol) => { for (let i = 1; i < pts.length; i++) { const d = pts[i].y - pts[i - 1].y; if (dir > 0 ? d < -tol : d > tol) return false; } return true; };

    /** analyze a window of alternating pivots → geometry or null */
    function analyze(win, ctx, atr, tol, maxDur = MAXBARS) {
      const highs = [], lows = [];
      for (const p of win) (p.kind === 'H' ? highs : lows).push({ x: p.barIdx, y: p.price, p });
      if (highs.length < 2 || lows.length < 2) return null;
      const U = fitOuterLine(highs, 'H', tol), L = fitOuterLine(lows, 'L', tol);
      if (!U || !L) return null;
      const firstX = win[0].barIdx, lastX = win[win.length - 1].barIdx, nowX = ctx.barIdx;
      const duration = lastX - firstX;
      if (duration < 3 || duration > maxDur || nowX - firstX > MAXBARS) return null;
      const w0 = widthAt(U, L, firstX), w1 = widthAt(U, L, lastX), wNow = widthAt(U, L, nowX);
      if (!(w0 > 0) || !(w1 > 0) || !(wNow > 0)) return null;   // lines cross inside the pattern / apex already passed
      const height = Math.max(w0, w1);
      if (height < P.minHeightAtr * atr) return null;
      // containment: no close inside [firstX, nowX] beyond a line by > tol; also body stats
      let minLow = Infinity, maxHigh = -Infinity, sumVol = 0, nb = 0, closeViol = 0;
      const b0 = barAt(ctx, firstX); if (!b0) return null;
      const phase = (b) => (b.mos < 930 ? 0 : b.mos < 1320 ? 1 : 2);   // overnight/premarket | RTH | afterhours (session minutes from 18:00 ET)
      const ss0 = b0.ssUtc, ph0 = phase(b0);
      let spansSessionBreak = false;
      const atrStart = b0.f && Number.isFinite(b0.f.atr) ? b0.f.atr : atr;
      for (let x = firstX; x <= nowX; x++) {
        const b = barAt(ctx, x); if (!b) return null;
        if (!spansSessionBreak && (b.ssUtc !== ss0 || phase(b) !== ph0)) spansSessionBreak = true;
        const up = lineValueAt(U, x), lo = lineValueAt(L, x);
        const v = Math.max(b.close - up, lo - b.close);
        if (v > tol) return null;
        if (v > closeViol) closeViol = v;
        if (b.low < minLow) minLow = b.low; if (b.high > maxHigh) maxHigh = b.high;
        sumVol += b.volume || 0; nb++;
      }
      const uS = slopeAtr(U, atr), lS = slopeAtr(L, atr);
      return { win, highs, lows, U, L, firstX, lastX, nowX, duration, w0, w1, height, heightAtr: height / atr, dWidth: w1 / w0,
        uS, lS, cu: cls(uS), cl: cls(lS), apex: apexBars(U, L, nowX), touchesUpper: U.touches, touchesLower: L.touches,
        fitQuality: 1 - Math.max(U.maxViolation, L.maxViolation, closeViol) / tol, minLow, maxHigh, meanVol: nb ? sumVol / nb : NaN,
        upperNow: lineValueAt(U, nowX), lowerNow: lineValueAt(L, nowX), tol, spansSessionBreak, atrStart, heightAtrStart: height / atrStart,
        pctToApex: (() => { const a = apexBars(U, L, nowX); return a != null && a > 0 ? (nowX - firstX) / (nowX - firstX + a) : null; })() };
    }

    function priorTrendDir(ctx, g) {
      const b0 = barAt(ctx, g.firstX), bp = barAt(ctx, g.firstX - 20);
      if (b0 && bp) return Math.sign(b0.close - bp.close) || 0;
      if (b0 && b0.f && Number.isFinite(b0.f.emaSlope)) return Math.sign(b0.f.emaSlope) || 0;
      return 0;
    }

    /** classify → [{pid, dir, levels, tags, extraGeom}] */
    function classify(g, ctx, atr) {
      const out = [];
      const { cu, cl, dWidth: dw, duration: d } = g;
      const bil = (extraTags = [], extraGeom = {}) => ({
        dir: 'bilateral', tags: extraTags, extraGeom,
        levels: { upper: g.upperNow, lower: g.lowerNow, upperSlope: g.U.slope, lowerSlope: g.L.slope,
          targetUp: g.upperNow + g.height, targetDown: g.lowerNow - g.height, midline: (g.upperNow + g.lowerNow) / 2,
          extra: { apexBars: g.apex, heightPts: g.height, upperAtStart: lineValueAt(g.U, g.firstX), lowerAtStart: lineValueAt(g.L, g.firstX) } },
      });
      // ---- rectangle
      if (cu === 0 && cl === 0 && inRange(dw, P.rectDW) && inRange(d, D.rect)) {
        const tags = ['trading-range'];
        if (g.heightAtr <= P.ttrHeightAtr) tags.push('brk_tight_trading_range');
        const bp = barAt(ctx, g.firstX - P.darvasLookback);
        if (bp) { let mx = -Infinity; for (let x = g.firstX - P.darvasLookback; x < g.firstX; x++) { const b = barAt(ctx, x); if (b && b.high > mx) mx = b.high; } if (Number.isFinite(mx) && lineValueAt(g.U, g.firstX) >= mx - g.tol) tags.push('darvas_box'); }
        out.push({ pid: 'rectangle', ...bil(tags) });
      }
      // ---- triangles (converging)
      if (cu === 0 && cl > 0 && dw <= P.triDW && inRange(d, D.tri) && monotone(g.lows, 1, g.tol)) out.push({ pid: 'ascending-triangle', ...bil() });
      if (cu < 0 && cl === 0 && dw <= P.triDW && inRange(d, D.tri) && monotone(g.highs, -1, g.tol)) out.push({ pid: 'descending-triangle', ...bil() });
      const symGeom = cu < 0 && cl > 0 && monotone(g.highs, -1, g.tol) && monotone(g.lows, 1, g.tol);
      // ---- wedges (same sign, converging)
      if (cu > 0 && cl > 0 && dw <= P.wedgeDW && inRange(d, D.tri) && monotone(g.highs, 1, g.tol) && monotone(g.lows, 1, g.tol)) out.push({ pid: 'rising-wedge', ...wedge(g, ctx, atr, 'down') });
      if (cu < 0 && cl < 0 && dw <= P.wedgeDW && inRange(d, D.tri) && monotone(g.highs, -1, g.tol) && monotone(g.lows, -1, g.tol)) out.push({ pid: 'falling-wedge', ...wedge(g, ctx, atr, 'up') });
      // ---- broadening (diverging)
      if (cu > 0 && cl < 0 && dw >= P.divDW && inRange(d, D.broad) && monotone(g.highs, 1, g.tol) && monotone(g.lows, -1, g.tol)) {
        const t = priorTrendDir(ctx, g);
        out.push({ pid: t < 0 ? 'broadening-bottom' : 'broadening-top', ...bil(['megaphone'], { priorTrend: t }) });
      }
      if (cu > 0 && cl === 0 && dw >= P.raDW && inRange(d, D.broad) && monotone(g.highs, 1, g.tol)) out.push({ pid: 'right-angled-broadening-ascending', ...bil() });
      if (cu === 0 && cl < 0 && dw >= P.raDW && inRange(d, D.broad) && monotone(g.lows, -1, g.tol)) out.push({ pid: 'right-angled-broadening-descending', ...bil() });
      if (cu > 0 && cl > 0 && dw >= P.divDW && inRange(d, D.broad) && monotone(g.highs, 1, g.tol) && monotone(g.lows, 1, g.tol)) out.push({ pid: 'ascending-broadening-wedge', ...bil() });
      if (cu < 0 && cl < 0 && dw >= P.divDW && inRange(d, D.broad) && monotone(g.highs, -1, g.tol) && monotone(g.lows, -1, g.tol)) out.push({ pid: 'descending-broadening-wedge', ...bil() });
      // ---- channels (parallel, same sign, sloped)
      if (cu > 0 && cl > 0 && inRange(dw, P.parDW) && inRange(d, D.chan)) out.push({ pid: 'channel-up', ...bil(['trend-channel']) });
      if (cu < 0 && cl < 0 && inRange(dw, P.parDW) && inRange(d, D.chan)) out.push({ pid: 'channel-down', ...bil(['trend-channel']) });
      // ---- flags / pennants (need P5: pole ending at the first pivot)
      let imp = null;
      const first = g.win[0];
      const shortEnough = d <= Math.max(D.flag[1], 20) && d >= D.flag[0];
      if (shortEnough) {
        const endPos = posOf(ctx, first.barIdx);
        if (endPos >= 1) imp = priorImpulse(ctx.bars, atr, { K: FLAG.K, M: FLAG.M, minER: P.flagER, endIdx: endPos, endPrice: first.price, dir: first.kind === 'H' ? 'up' : 'down' });
      }
      if (imp && imp.qualifies) {
        const up = imp.dir === 'up';
        const poleLen = imp.move;
        const retrace = up ? (first.price - g.minLow) / poleLen : (g.maxHigh - first.price) / poleLen;
        const startBar = ctx.bars.at(imp.startIdx);
        const poleAnchor = { role: 'poleStart', ts: startBar.ts, price: imp.startPrice, confirmedAt: startBar.closeTs };
        const pg = { priorMoveAtr: imp.moveAtr, priorMoveBars: imp.bars, priorER: imp.efficiencyRatio, retracePct: retrace,
          volumeRatio: imp.meanVol > 0 ? g.meanVol / imp.meanVol : NaN, poleSpeedAtr: imp.speedAtr };
        const dirLevels = () => {
          const trig = up ? g.upperNow : g.lowerNow, tSlope = up ? g.U.slope : g.L.slope;
          const opp = up ? g.lowerNow : g.upperNow, oSlope = up ? g.L.slope : g.U.slope;
          const poleMid = imp.startPrice + (up ? poleLen / 2 : -poleLen / 2);
          const useOpp = up ? opp >= poleMid : opp <= poleMid;     // whichever is nearer to price
          const s = up ? 1 : -1;
          return { trigger: trig, triggerSlope: tSlope, triggerSide: up ? 'above' : 'below',
            invalidation: useOpp ? opp : poleMid, invalidationSlope: useOpp ? oSlope : 0,
            target: trig + s * poleLen, target2: trig + s * 0.62 * poleLen,
            upper: g.upperNow, lower: g.lowerNow, upperSlope: g.U.slope, lowerSlope: g.L.slope,
            extra: { poleStart: imp.startPrice, poleEnd: imp.endPrice, poleMid, bodyLow: g.minLow, bodyHigh: g.maxHigh, apexBars: g.apex } };
        };
        // flag: body tilts against the pole or flat, roughly parallel, retrace ≤ 50%
        const tiltOk = up ? (g.uS <= P.flatSlope && g.lS <= P.flatSlope) : (g.uS >= -P.flatSlope && g.lS >= -P.flatSlope);
        if (inRange(d, D.flag) && tiltOk && inRange(dw, P.flagDW) && retrace <= P.flagRetraceMax) {
          const tags = [];
          if (cu === 0 && cl === 0) tags.push('rectangle-flag');
          out.push({ pid: up ? 'bull-flag' : 'bear-flag', dir: imp.dir, levels: dirLevels(), tags, extraGeom: pg, extraAnchors: [poleAnchor] });
        }
        // pennant: tiny symmetrical triangle after the pole, apex within ≤ 2× body length ahead
        if (symGeom && dw <= P.triDW && d <= 20 && retrace <= P.flagRetraceMax && g.apex != null && g.apex > 0 && g.apex <= P.pennantApexMult * Math.max(d, 1)) {
          out.push({ pid: 'pennant', dir: imp.dir, levels: dirLevels(), tags: [], extraGeom: pg, extraAnchors: [poleAnchor] });
        }
      }
      // symmetrical triangle (after flags so the pennant tag can be attached)
      if (symGeom && dw <= P.convDW && inRange(d, D.tri)) {
        const tags = [];
        if (imp && imp.qualifies && d <= 20) tags.push('pennant');
        out.push({ pid: 'symmetrical-triangle', ...bil(tags, imp ? { priorMoveAtr: imp.moveAtr, priorMoveBars: imp.bars, priorER: imp.efficiencyRatio } : {}) });
      }
      // wedges: continuation tag when aligned with a prior impulse (rising wedge after a DOWN pole = bear-flag-like)
      for (const o of out) if (o.pid === 'rising-wedge' || o.pid === 'falling-wedge') {
        const endPos = posOf(ctx, first.barIdx);
        const wi = endPos >= 1 ? priorImpulse(ctx.bars, atr, { K: FLAG.K, M: FLAG.M, minER: P.flagER, endIdx: endPos, endPrice: first.price, dir: first.kind === 'H' ? 'up' : 'down' }) : null;
        if (wi && wi.qualifies) { o.extraGeom = { ...o.extraGeom, priorMoveAtr: wi.moveAtr, priorMoveBars: wi.bars, priorER: wi.efficiencyRatio }; if ((o.pid === 'rising-wedge' && wi.dir === 'down') || (o.pid === 'falling-wedge' && wi.dir === 'up')) o.tags.push('continuation'); }
      }
      return out;
    }

    function wedge(g, ctx, atr, dir) {
      const down = dir === 'down';
      const lastHigh = g.highs[g.highs.length - 1].y, lastLow = g.lows[g.lows.length - 1].y;
      const trig = down ? g.lowerNow : g.upperNow;
      const tags = ['brk_wedge'];
      if ((down ? g.touchesUpper : g.touchesLower) >= 3) tags.push('three-push');
      return {
        dir, tags, extraGeom: {},
        levels: { trigger: trig, triggerSlope: down ? g.L.slope : g.U.slope, triggerSide: down ? 'below' : 'above',
          invalidation: down ? lastHigh : lastLow, invalidationSlope: 0,
          target: down ? g.minLow : g.maxHigh, target2: down ? trig - g.height : trig + g.height,
          upper: g.upperNow, lower: g.lowerNow, upperSlope: g.U.slope, lowerSlope: g.L.slope,
          extra: { apexBars: g.apex, heightPts: g.height } },
      };
    }

    function anchorsOf(win) {
      let h = 0, l = 0;
      return win.map((p) => ({ role: p.kind === 'H' ? `H${++h}` : `L${++l}`, ts: p.ts, price: p.price, confirmedAt: p.confirmedAt }));
    }

    function geometryOf(g, gen, lab, atr) {
      return {
        durationBars: g.duration, heightAtr: g.heightAtr, upperSlopeAtr: g.uS, lowerSlopeAtr: g.lS, dWidth: g.dWidth,
        apexBars: g.apex, touchesUpper: g.touchesUpper, touchesLower: g.touchesLower, fitQuality: g.fitQuality,
        nPivots: g.win.length, heightRw: g.heightAtr / Math.sqrt(Math.max(g.duration, 1)), barsSinceLastPivot: g.nowX - g.lastX,
        heightAtrStart: g.heightAtrStart, atrRatio: atr / g.atrStart, spansSessionBreak: g.spansSessionBreak, pctToApex: g.pctToApex,
        gen, tags: [...(lab.tags || []), `gen:${gen}`], ...(lab.extraGeom || {}), params: paramsId,
      };
    }

    /** windows over the last ≤ maxPivots majors of one generator → classify → emit first-qualifying labels */
    function scan(gen, majors, ctx, atr, tol, allowed) {
      const nowX = ctx.barIdx;
      const handled = new Set();
      for (let n = majors.length; n >= P.minPivots; n--) {
        const win = majors.slice(-n);
        const g = analyze(win, ctx, atr, tol, allowed ? Math.max(D.flag[1], 20) : MAXBARS);
        if (!g) continue;
        const labels = classify(g, ctx, atr);
        for (const lab of labels) {
          if (allowed && !allowed.has(lab.pid)) continue;
          if (handled.has(lab.pid)) continue;
          handled.add(lab.pid);
          const ak = `${gen}:${lab.pid}`;
          const act = active.get(ak);
          if (act && g.firstX <= act.lastIdx) {
            // extension / nested / sliding window of a live instance → suppress; refresh geometry
            if (g.lastX > act.lastIdx) act.lastIdx = g.lastX;
            if (g.firstX === act.firstIdx) { act.U = g.U; act.L = g.L; act.height = g.height; act.anchors = anchorsOf(win); }
            continue;
          }
          const anchors = anchorsOf(win);
          if (lab.extraAnchors) anchors.unshift(...lab.extraAnchors);
          ctx.emit({ patternId: lab.pid, family: famOf(lab.pid), key: String(win[0].ts), state: 'forming', direction: lab.dir,
            levels: lab.levels, anchors, geometry: geometryOf(g, gen, lab, atr) });
          active.set(ak, { pid: lab.pid, gen, firstIdx: g.firstX, firstTs: win[0].ts, lastIdx: g.lastX, emittedIdx: nowX, U: g.U, L: g.L, height: g.height, tol, anchors: anchorsOf(win) });
        }
      }
    }

    // local k=1 fractal track ("fractal1") — flags/pennants need finer body pivots than the engine's k=3
    // (catalog 01 §C1.1: "fractal k=1–2 on the detection TF, since flags are short"). Bar i-1 is a k=1
    // high if high[i-1] > high[i-2] and >= high[i]; confirmed at the close of bar i (= now). Alternation
    // enforced like PivotTrack (same kind → keep the more extreme). Bounded to maxPivots+1 entries.
    const fine = [];
    function fineAdd(p) {
      const last = fine[fine.length - 1];
      if (last && last.kind === p.kind) {
        const better = p.kind === 'H' ? p.price >= last.price : p.price <= last.price;
        if (!better) return null;
        fine.pop();
      }
      fine.push(p);
      if (fine.length > P.maxPivots + 1) fine.shift();
      return p;
    }
    const FINE_LABELS = new Set(['bull-flag', 'bear-flag', 'pennant']);

    return {
      onBar(bar, f, ctx) {
        if (!P.fineGen || ctx.bars.length < 3) return;
        const c = ctx.bars.at(-2), l = ctx.bars.at(-3), r = bar;
        const out = [];
        if (c.high > l.high && c.high >= r.high) out.push(fineAdd({ kind: 'H', ts: c.ts, price: c.high, barIdx: c.i, confirmedAt: bar.closeTs, gen: 'fractal1' }));
        if (c.low < l.low && c.low <= r.low) out.push(fineAdd({ kind: 'L', ts: c.ts, price: c.low, barIdx: c.i, confirmedAt: bar.closeTs, gen: 'fractal1' }));
        if (!out.some(Boolean)) return;
        const atr = f.atr;
        if (!Number.isFinite(atr) || atr <= 0) return;
        const nowX = ctx.barIdx;
        for (const [k, a] of active) if (nowX - a.emittedIdx > P.activeBars || nowX - a.firstIdx > MAXBARS) active.delete(k);
        scan('fractal1', fine.slice(-P.maxPivots), ctx, atr, Math.max(tolAtr * atr, 2 * TICK), FINE_LABELS);
      },
      onPivot(pivot, gen, ctx) {
        if (!P.gens.includes(gen)) return;
        const atr = ctx.f.atr;
        if (!Number.isFinite(atr) || atr <= 0) return;
        const tol = Math.max(tolAtr * atr, 2 * TICK);
        const track = ctx.pivots[gen];
        const majors = track.last(P.maxPivots);
        const nowX = ctx.barIdx;
        // expire stale active records
        for (const [k, a] of active) if (nowX - a.emittedIdx > P.activeBars || nowX - a.firstIdx > MAXBARS) active.delete(k);
        scan(gen, majors, ctx, atr, tol, null);
        // partial rise / decline: a leg inside a live range shape that turns back at ≤ partialFrac of the width
        const last2 = track.last(2);
        if (last2.length === 2 && last2[1] === pivot) {
          const prev = last2[0];
          for (const act of active.values()) {
            if (act.gen !== gen || !RANGE_LABELS.has(act.pid) || nowX < act.emittedIdx) continue;
            if (prev.barIdx < act.firstIdx || prev.barIdx > act.lastIdx) continue;
            const w = widthAt(act.U, act.L, pivot.barIdx);
            if (!(w > 0)) continue;
            const upAt = (x) => lineValueAt(act.U, x), loAt = (x) => lineValueAt(act.L, x);
            // the leg must have started at (within tol of) the origin boundary and stalled with ≥ (1 − partialFrac)
            // of the CURRENT width still unreached on the far side (so a pivot that touches the far line never counts)
            let ok = false, dir = null, frac = NaN;
            if (pivot.kind === 'L' && Math.abs(prev.price - upAt(prev.barIdx)) <= act.tol) {   // down leg from the upper boundary stalled
              const remaining = (pivot.price - loAt(pivot.barIdx)) / w; frac = 1 - remaining;
              ok = remaining >= 1 - P.partialFrac && frac > 0 && pivot.price - loAt(pivot.barIdx) > act.tol; dir = 'up';
            } else if (pivot.kind === 'H' && Math.abs(prev.price - loAt(prev.barIdx)) <= act.tol) {
              const remaining = (upAt(pivot.barIdx) - pivot.price) / w; frac = 1 - remaining;
              ok = remaining >= 1 - P.partialFrac && frac > 0 && upAt(pivot.barIdx) - pivot.price > act.tol; dir = 'down';
            }
            if (!ok) continue;
            // pattern must still be intact (no close beyond either line since the leg origin)
            let intact = true;
            for (let x = prev.barIdx; x <= nowX; x++) { const b = barAt(ctx, x); if (!b || b.close > upAt(x) + act.tol || b.close < loAt(x) - act.tol) { intact = false; break; } }
            if (!intact) continue;
            const up = dir === 'up';
            const trig = up ? upAt(nowX) : loAt(nowX), inv = up ? loAt(nowX) : upAt(nowX);
            const s = up ? 1 : -1;
            ctx.emit({ patternId: up ? 'partial-decline' : 'partial-rise', family: 'chart-bilateral', key: `${act.firstTs}:${pivot.ts}`, state: 'forming', direction: dir,
              levels: { trigger: trig, triggerSlope: up ? act.U.slope : act.L.slope, triggerSide: up ? 'above' : 'below',
                invalidation: inv, invalidationSlope: up ? act.L.slope : act.U.slope, target: trig + s * act.height, target2: trig + s * 0.62 * act.height,
                upper: upAt(nowX), lower: loAt(nowX), upperSlope: act.U.slope, lowerSlope: act.L.slope, extra: { widthAtLeg: w } },
              anchors: [...act.anchors.filter((a) => a.ts < pivot.ts), { role: up ? 'partialLow' : 'partialHigh', ts: pivot.ts, price: pivot.price, confirmedAt: pivot.confirmedAt }],
              geometry: { parentPattern: act.pid, traversedFrac: frac, durationBars: nowX - act.firstIdx, heightAtr: act.height / atr, gen, tags: [`gen:${gen}`, `in:${act.pid}`], params: paramsId } });
          }
        }
      },
    };
  },
};
