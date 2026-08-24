/**
 * Four/five-bar candlestick patterns (catalog 02 §6) with §7.10 gap adaptations, plus run-length
 * climax features (§6.7 / §7.9): N consecutive same-colour bars with higher highs (lower lows).
 * Bars named oldest→newest: for 5-bar e = bar4 (TA-Lib i-4) … a = current (i); for 4-bar d..a.
 * Key = ts of the first bar of the pattern (run: first bar of the run).
 * three-line-strike (4 bars): direction = the strike bar's direction (Bulkowski; catalog 6.6), classical
 * TA-Lib name kept in tags.
 */
import { cs, Tiers, emitPattern } from './_candle-lib.js';

export default {
  id: 'n-bar', family: 'candle',
  params: { ctxAtr: 1.0, ctxBars: 10, extremeBars: 20, penetrationMat: 0.5, runNs: [5, 8], paramSet: 'v0' },
  create({ params: P, tfMin }) {
    // run-length state (same colour AND higher high / lower low chain)
    let runDir = 0, runLen = 0, runStart = null, prevH = NaN, prevL = NaN, runBars = [];
    return {
      onBar(bar, f, ctx) {
        const T = new Tiers(f, tfMin);
        const a = cs(bar);
        // ---- run-length update (always, even when tiers are not ready)
        const cont = a.col !== 0 && a.col === runDir && (runDir === 1 ? a.h > prevH : a.l < prevL);
        if (cont) { runLen++; runBars.push(a); if (runBars.length > 16) runBars.shift(); }
        else { runDir = a.col; runLen = a.col === 0 ? 0 : 1; runStart = bar.ts; runBars = a.col === 0 ? [] : [a]; }
        prevH = a.h; prevL = a.l;
        if (!T.ok) return;
        const E = (spec) => emitPattern(ctx, f, T, P, spec);

        if (runLen > 0 && P.runNs.includes(runLen) && runBars.length === runLen) {
          const up = runDir === 1;
          const first = runBars[0];
          const hi = Math.max(...runBars.map((x) => x.h)), lo = Math.min(...runBars.map((x) => x.l)), H = hi - lo;
          if (H >= T.minRange) {
            const bodies = runBars.map((x) => x.body / T.B);
            const tags = ['climax-run', `run-${runLen}`, 'consecutive-trend-bars', 'Brooks-climax-candidate'];
            if (runLen >= 8) tags.push(up ? 'eight-new-price-lines' : 'eight-new-price-lines-mirror');
            E({ id: `run-${runLen}`, dir: up ? 'down' : 'up', bars: runBars, keyBar: runLen - 1, ctxDir: null, key: String(first.ts), tags,
              levels: up ? { trigger: a.l, triggerSide: 'below', invalidation: hi, target: a.l - H, extra: { runHigh: hi, runLow: lo, runDir: 'up' } }
                : { trigger: a.h, triggerSide: 'above', invalidation: lo, target: a.h + H, extra: { runHigh: hi, runLow: lo, runDir: 'down' } },
              geo: { runLen, runDir: up ? 'up' : 'down', runHeightAtr: H / T.atr, meanBodyVsMed: bodies.reduce((s, x) => s + x, 0) / bodies.length,
                lastBodyVsMed: bodies[bodies.length - 1], bodyAccel: bodies[bodies.length - 1] - bodies[0], lastRangeRel: a.rng / T.R,
                lastRangeZ: Number.isFinite(f.rangeZ) ? f.rangeZ : null, netMoveAtr: (a.c - first.o) / T.atr, efficiency: H > 0 ? Math.abs(a.c - first.o) / runBars.reduce((s, x) => s + x.rng, 0) : 0 } });
          }
        }

        if (ctx.bars.length < 6) return;
        const b = cs(ctx.bars.at(-2)), c = cs(ctx.bars.at(-3)), d = cs(ctx.bars.at(-4)), e = cs(ctx.bars.at(-5));
        const four = [d, c, b, a], five = [e, d, c, b, a];

        // ---- three-line strike (CDL3LINESTRIKE): three same-colour lines with monotone closes and opens within prior body ± Near,
        //      4th opposite bar erases them: classic O beyond C1; -lite: O ≥ C1 − Equal (24h adaptation). dir = strike bar's direction.
        if (d.col !== 0 && c.col === d.col && b.col === d.col && a.col === -d.col && T.bigEnough(a)) {
          const up = d.col === 1;   // three white lines
          const mono = up ? (b.c > c.c && c.c > d.c) : (b.c < c.c && c.c < d.c);
          const opensOk = c.o >= d.bBot - T.near && c.o <= d.bTop + T.near && b.o >= c.bBot - T.near && b.o <= c.bTop + T.near;
          const erases = up ? a.c < d.o : a.c > d.o;
          const classic = up ? a.o > b.c : a.o < b.c;
          const lite = up ? a.o >= b.c - T.equal : a.o <= b.c + T.equal;
          if (mono && opensOk && erases && lite) {
            const runH = up ? b.c - d.o : d.o - b.c;
            E({ id: (up ? 'three-line-strike-down' : 'three-line-strike-up') + (classic ? '' : '-lite'), dir: up ? 'down' : 'up', bars: four, keyBar: 3, ctxDir: up ? 'up' : 'down',
              tags: ['CDL3LINESTRIKE', up ? 'bullish-three-line-strike(theory)' : 'bearish-three-line-strike(theory)', 'strike-direction', 'exhaustion-engulf'],
              geo: { strikeBodyVsMed: a.body / T.B, linesBodyVsMed: (d.body + c.body + b.body) / 3 / T.B, strikeOverRun: runH > 0 ? a.body / runH : null, classicGap: classic, gapRel: (up ? a.o - b.c : b.c - a.o) / T.R } });
          }
        }

        // ---- rising / falling three methods (CDLRISEFALL3METHODS): long bar, three small counter bars partly inside its range
        //      with monotone closes, long same-colour bar closing beyond the first close. 5th open: O ≥ C1 − Equal (adapted).
        if (e.col !== 0 && d.col === -e.col && c.col === d.col && b.col === d.col && a.col === e.col && T.bigEnough(e) && T.long(e) && T.long(a)
          && T.short(d) && T.short(c) && T.short(b)) {
          const up = e.col === 1;
          const partIn = (x) => x.bBot < e.h && x.bTop > e.l;
          const mono = up ? (c.c < d.c && b.c < c.c) : (c.c > d.c && b.c > c.c);
          const openOk = up ? a.o >= b.c - T.equal : a.o <= b.c + T.equal;
          const closeOk = up ? a.c > e.c : a.c < e.c;
          if (partIn(d) && partIn(c) && partIn(b) && mono && openOk && closeOk) {
            const strict = Math.max(d.h, c.h, b.h) <= e.h && Math.min(d.l, c.l, b.l) >= e.l;
            const tags = ['CDLRISEFALL3METHODS', 'three-bar-pullback', 'theory-continuation']; if (strict) tags.push('nison-strict');
            E({ id: up ? 'rising-three-methods' : 'falling-three-methods', dir: up ? 'up' : 'down', bars: five, keyBar: 4, ctxDir: up ? 'up' : 'down', tags,
              geo: { strictContainment: strict, pullbackDepth: (up ? e.c - Math.min(d.bBot, c.bBot, b.bBot) : Math.max(d.bTop, c.bTop, b.bTop) - e.c) / (e.body || 1), firstBodyVsMed: e.body / T.B, lastBodyVsMed: a.body / T.B } });
          }
        }

        // ---- mat hold-lite (CDLMATHOLD, penetration 0.5): body gap of bar 2 → bBot ≥ C4 − Near
        if (e.col === 1 && d.col === -1 && a.col === 1 && T.bigEnough(e) && T.long(e) && T.short(d) && T.short(c) && T.short(b)
          && d.bBot >= e.c - T.near && c.bBot < e.c && b.bBot < e.c && c.bBot > e.c - e.body * P.penetrationMat && b.bBot > e.c - e.body * P.penetrationMat
          && c.bTop < d.o && b.bTop < c.bTop && a.o >= b.c - T.equal && a.c > Math.max(d.h, c.h, b.h)) {
          E({ id: 'mat-hold-lite', dir: 'up', bars: five, keyBar: 4, ctxDir: 'up', tags: ['CDLMATHOLD', 'theory-continuation', 'rare'],
            geo: { gapRel: (d.bBot - e.bTop) / T.R, classicGap: d.bBot > e.bTop, firstBodyVsMed: e.body / T.B } });
        }
        if (e.col === -1 && d.col === 1 && a.col === -1 && T.bigEnough(e) && T.long(e) && T.short(d) && T.short(c) && T.short(b)
          && d.bTop <= e.c + T.near && c.bTop > e.c && b.bTop > e.c && c.bTop < e.c + e.body * P.penetrationMat && b.bTop < e.c + e.body * P.penetrationMat
          && c.bBot > d.o && b.bBot > c.bBot && a.o <= b.c + T.equal && a.c < Math.min(d.l, c.l, b.l)) {
          E({ id: 'mat-hold-lite-bear', dir: 'down', bars: five, keyBar: 4, ctxDir: 'down', tags: ['CDLMATHOLD-mirror', 'theory-continuation', 'rare'],
            geo: { gapRel: (e.bBot - d.bTop) / T.R, classicGap: d.bTop < e.bBot, firstBodyVsMed: e.body / T.B } });
        }

        // ---- ladder bottom (CDLLADDERBOTTOM; adapted: 5th closes above 4th's high) + mirror ladder top
        if (e.col === -1 && d.col === -1 && c.col === -1 && e.o > d.o && d.o > c.o && e.c > d.c && d.c > c.c && b.col === -1 && !T.shVShort(b, b.up)
          && a.col === 1 && a.c > b.h && T.bigEnough(a)) {
          E({ id: 'ladder-bottom', dir: 'up', bars: five, keyBar: 4, ctxDir: 'down', tags: ['CDLLADDERBOTTOM', a.o > b.o ? 'classic-open' : 'lite'],
            geo: { declineAtr: (e.o - c.c) / T.atr, upShadowRel4: b.rng > 0 ? b.up / b.rng : 0, reversalBodyVsMed: a.body / T.B } });
        }
        if (e.col === 1 && d.col === 1 && c.col === 1 && e.o < d.o && d.o < c.o && e.c < d.c && d.c < c.c && b.col === 1 && !T.shVShort(b, b.lo)
          && a.col === -1 && a.c < b.l && T.bigEnough(a)) {
          E({ id: 'ladder-top', dir: 'down', bars: five, keyBar: 4, ctxDir: 'up', tags: ['CDLLADDERBOTTOM-mirror', a.o < b.o ? 'classic-open' : 'lite'],
            geo: { advanceAtr: (c.c - e.o) / T.atr, loShadowRel4: b.rng > 0 ? b.lo / b.rng : 0, reversalBodyVsMed: a.body / T.B } });
        }

        // ---- concealing baby swallow (CDLCONCEALBABYSWALL; adapted: 3rd body at/below 2nd close instead of gap) — rare
        if (d.col === -1 && c.col === -1 && b.col === -1 && a.col === -1 && T.maru(d) && T.maru(c) && b.bTop <= c.c + T.equal && b.h > c.c && a.h > b.h && a.l < b.l && T.bigEnough(a)) {
          E({ id: 'concealing-baby-swallow', dir: 'up', bars: four, keyBar: 3, ctxDir: 'down', tags: ['CDLCONCEALBABYSWALL', 'rare', 'theory-bullish', b.bTop < c.bBot ? 'classic-gap' : 'lite'],
            geo: { gapRel: (c.bBot - b.bTop) / T.R, classicGap: b.bTop < c.bBot } });
        }

        // ---- breakaway-lite (CDLBREAKAWAY): long bar, three more bars in trend direction (bars 3,4 lower highs/lows), 5th
        //      opposite bar closes back beyond bar 2's body top (bull). Classic requires a body gap between bars 1-2 (tagged).
        if (e.col === -1 && d.col === -1 && b.col === -1 && a.col === 1 && T.bigEnough(e) && T.long(e) && d.bTop <= e.c + T.equal
          && c.h < d.h && c.l < d.l && b.h < c.h && b.l < c.l && a.c > d.o && T.bigEnough(a)) {
          const classic = d.bTop < e.bBot && a.c < e.c;
          E({ id: 'breakaway-bull' + (classic ? '' : '-lite'), dir: 'up', bars: five, keyBar: 4, ctxDir: 'down', tags: ['CDLBREAKAWAY', 'reversal-recovers-3-bars'],
            geo: { gapRel: (e.bBot - d.bTop) / T.R, classicGap: d.bTop < e.bBot, recoverRel: (a.c - d.o) / T.R, reversalBodyVsMed: a.body / T.B } });
        }
        if (e.col === 1 && d.col === 1 && b.col === 1 && a.col === -1 && T.bigEnough(e) && T.long(e) && d.bBot >= e.c - T.equal
          && c.h > d.h && c.l > d.l && b.h > c.h && b.l > c.l && a.c < d.o && T.bigEnough(a)) {
          const classic = d.bBot > e.bTop && a.c > e.c;
          E({ id: 'breakaway-bear' + (classic ? '' : '-lite'), dir: 'down', bars: five, keyBar: 4, ctxDir: 'up', tags: ['CDLBREAKAWAY', 'reversal-recovers-3-bars'],
            geo: { gapRel: (d.bBot - e.bTop) / T.R, classicGap: d.bBot > e.bTop, recoverRel: (d.o - a.c) / T.R, reversalBodyVsMed: a.body / T.B } });
        }
      },
    };
  },
};
