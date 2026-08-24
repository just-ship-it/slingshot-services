/**
 * Three-bar candlestick patterns (catalog 02 §5) with the §7.10 gap adaptations.
 * Bars: a = oldest (TA-Lib i-2), b = middle (i-1), c = current (i). Key = ts of `a`.
 * Star family precedence: abandoned-baby > (morning|evening)-doji-star > (morning|evening)-star; classic
 * (real-body gap) vs -lite (no gap: star body at the extreme of bar-1's close ± Near) are separate ids.
 * Only the most specific id is emitted per triple within a family.
 */
import { cs, Tiers, emitPattern } from './_candle-lib.js';

/** TA-Lib CDLENGULFING body rule (used by three-outside; same intraday extras as two-bar) */
function engulf(T, p, c, ratio) {
  if (!(T.notDoji(p) && T.long(c) && c.body >= ratio * p.body)) return 0;
  const covers = (c.bTop >= p.bTop && c.bBot < p.bBot) || (c.bTop > p.bTop && c.bBot <= p.bBot);
  if (!covers) return 0;
  if (p.col === -1 && c.col === 1) return 1;
  if (p.col === 1 && c.col === -1) return -1;
  return 0;
}

export default {
  id: 'three-bar', family: 'candle',
  params: { ctxAtr: 1.0, ctxBars: 10, extremeBars: 20, engulfRatio: 1.2, penetrationStar: 0.3, paramSet: 'v0' },
  create({ params: P, tfMin }) {
    return {
      onBar(bar, f, ctx) {
        const T = new Tiers(f, tfMin);
        if (!T.ok || ctx.bars.length < 4) return;
        const c = cs(bar), b = cs(ctx.bars.at(-2)), a = cs(ctx.bars.at(-3));
        const tri = [a, b, c];
        const E = (spec) => emitPattern(ctx, f, T, P, spec);

        // ---- morning / evening star family (CDLMORNINGSTAR, CDLEVENINGSTAR, CDL*DOJISTAR, CDLABANDONEDBABY)
        if (T.bigEnough(a) && T.long(a) && T.short(b) && T.notShort(c) && c.col !== 0 && T.bigEnough(c)) {
          if (a.col === -1 && c.col === 1 && c.c > a.c + a.body * P.penetrationStar) {
            const gapBody = a.bBot - b.bTop;                 // >0 = real-body gap down (classic star)
            const lite = !(gapBody > 0) && b.bTop <= a.c + T.near;
            if (gapBody > 0 || lite) {
              const doji = T.doji(b);
              const baby = doji && b.h < a.l && c.l > b.h;   // shadow gaps both sides (island)
              const geo = { penetration: (c.c - a.c) / a.body, gapRel: gapBody / T.R, gapRel2: (c.bBot - b.bTop) / T.R, starRangeRel: b.rng / T.R, starBodyRel: b.rng > 0 ? b.body / b.rng : 0, classicGap: gapBody > 0 };
              const id = baby ? 'abandoned-baby-bull' : doji ? (gapBody > 0 ? 'morning-doji-star' : 'morning-doji-star-lite') : (gapBody > 0 ? 'morning-star' : 'morning-star-lite');
              const tags = baby ? ['CDLABANDONEDBABY', 'CDLMORNINGDOJISTAR', 'island-reversal', 'rare'] : doji ? ['CDLMORNINGDOJISTAR', 'CDLMORNINGSTAR'] : ['CDLMORNINGSTAR', 'three-bar-V'];
              E({ id, dir: 'up', bars: tri, keyBar: 2, ctxDir: 'down', tags, geo });
            }
          } else if (a.col === 1 && c.col === -1 && c.c < a.c - a.body * P.penetrationStar) {
            const gapBody = b.bBot - a.bTop;                 // >0 = real-body gap up
            const lite = !(gapBody > 0) && b.bBot >= a.c - T.near;
            if (gapBody > 0 || lite) {
              const doji = T.doji(b);
              const baby = doji && b.l > a.h && c.h < b.l;
              const geo = { penetration: (a.c - c.c) / a.body, gapRel: gapBody / T.R, gapRel2: (b.bBot - c.bTop) / T.R, starRangeRel: b.rng / T.R, starBodyRel: b.rng > 0 ? b.body / b.rng : 0, classicGap: gapBody > 0 };
              const id = baby ? 'abandoned-baby-bear' : doji ? (gapBody > 0 ? 'evening-doji-star' : 'evening-doji-star-lite') : (gapBody > 0 ? 'evening-star' : 'evening-star-lite');
              const tags = baby ? ['CDLABANDONEDBABY', 'CDLEVENINGDOJISTAR', 'island-reversal', 'rare'] : doji ? ['CDLEVENINGDOJISTAR', 'CDLEVENINGSTAR'] : ['CDLEVENINGSTAR', 'three-bar-A'];
              E({ id, dir: 'down', bars: tri, keyBar: 2, ctxDir: 'up', tags, geo });
            }
          }
        }

        // ---- three inside up / down (CDL3INSIDE): strict body harami then confirmation close beyond bar-1 open
        if (T.bigEnough(a) && T.long(a) && T.short(b) && b.bTop < a.bTop && b.bBot > a.bBot) {
          if (a.col === -1 && c.col === 1 && c.c > a.o) E({ id: 'three-inside-up', dir: 'up', bars: tri, keyBar: 0, ctxDir: 'down', tags: ['CDL3INSIDE', 'harami-confirmed', 'ii-breakout'], geo: { confirmRel: (c.c - a.o) / T.R, motherBodyRel: a.rng > 0 ? a.body / a.rng : 0 } });
          else if (a.col === 1 && c.col === -1 && c.c < a.o) E({ id: 'three-inside-down', dir: 'down', bars: tri, keyBar: 0, ctxDir: 'up', tags: ['CDL3INSIDE', 'harami-confirmed', 'ii-breakout'], geo: { confirmRel: (a.o - c.c) / T.R, motherBodyRel: a.rng > 0 ? a.body / a.rng : 0 } });
        }

        // ---- three outside up / down (CDL3OUTSIDE): engulfing then confirmation close beyond the engulfing close
        if (T.bigEnough(b)) {
          const eg = engulf(T, a, b, P.engulfRatio);
          if (eg === 1 && c.c > b.c) E({ id: 'three-outside-up', dir: 'up', bars: tri, keyBar: 1, ctxDir: 'down', tags: ['CDL3OUTSIDE', 'engulfing-confirmed'], geo: { confirmRel: (c.c - b.c) / T.R, bodyRatio: b.body / a.body } });
          else if (eg === -1 && c.c < b.c) E({ id: 'three-outside-down', dir: 'down', bars: tri, keyBar: 1, ctxDir: 'up', tags: ['CDL3OUTSIDE', 'engulfing-confirmed'], geo: { confirmRel: (b.c - c.c) / T.R, bodyRatio: b.body / a.body } });
        }

        // ---- three white soldiers / advance block / deliberation (CDL3WHITESOLDIERS, CDLADVANCEBLOCK, CDLSTALLEDPATTERN)
        if (a.col === 1 && b.col === 1 && c.col === 1 && c.c > b.c && b.c > a.c && b.o > a.o && b.o <= a.c + T.near && c.o > b.o && c.o <= b.c + T.near) {
          const geo = { bodyTrend: (c.body - a.body) / T.B, upShadowLast: c.rng > 0 ? c.up / c.rng : 0, bodies: [a.body / T.B, b.body / T.B, c.body / T.B] };
          if (T.shVShort(a, a.up) && T.shVShort(b, b.up) && T.shVShort(c, c.up) && b.body > a.body - T.far && c.body > b.body - T.far && T.notShort(c) && T.bigEnough(c)) {
            E({ id: 'three-white-soldiers', dir: 'up', bars: tri, keyBar: 2, ctxDir: 'down', tags: ['CDL3WHITESOLDIERS', 'run-3'], geo });
          }
          if (T.long(a) && T.shShort(a.up) && (
            (b.body < a.body - T.far && c.body < b.body + T.near) || (c.body < b.body - T.far) ||
            (c.body < b.body && b.body < a.body && (T.shShort(c.up) === false || T.shShort(b.up) === false)) ||
            (c.body < b.body && T.shLong(c, c.up)))) {
            E({ id: 'advance-block', dir: 'down', bars: tri, keyBar: 2, ctxDir: 'up', tags: ['CDLADVANCEBLOCK', 'exhaustion', 'theory-bearish'], geo });
          }
          if (T.long(a) && T.long(b) && T.shVShort(b, b.up) && T.short(c) && c.o >= b.c - c.body - T.near) {
            E({ id: 'deliberation', dir: 'down', bars: tri, keyBar: 2, ctxDir: 'up', tags: ['CDLSTALLEDPATTERN', 'stalled', 'exhaustion', 'theory-bearish'], geo });
          }
        }
        // ---- three black crows / identical three crows (CDL3BLACKCROWS [3-bar core; 4th-bar white tagged], CDLIDENTICAL3CROWS)
        if (a.col === -1 && b.col === -1 && c.col === -1 && a.c > b.c && b.c > c.c && T.shVShort(a, a.lo) && T.shVShort(b, b.lo) && T.shVShort(c, c.lo) && T.bigEnough(c)) {
          const prior = ctx.bars.at(-4) ? cs(ctx.bars.at(-4)) : null;
          const geo = { bodyTrend: (c.body - a.body) / T.B, bodies: [a.body / T.B, b.body / T.B, c.body / T.B], priorWhite: !!(prior && prior.col === 1 && prior.h > a.c) };
          if (T.eq(b.o, a.c) && T.eq(c.o, b.c) && T.notShort(a) && T.notShort(b) && T.notShort(c)) {
            E({ id: 'identical-three-crows', dir: 'down', bars: tri, keyBar: 2, ctxDir: 'up', tags: ['CDLIDENTICAL3CROWS', 'run-3'], geo });
          } else if (b.o < a.o && b.o >= a.c - T.equal && c.o < b.o && c.o >= b.c - T.equal) {
            const tags = ['CDL3BLACKCROWS', 'run-3']; if (geo.priorWhite) tags.push('CDL3BLACKCROWS-strict');
            E({ id: 'three-black-crows', dir: 'down', bars: tri, keyBar: 2, ctxDir: 'up', tags, geo });
          }
        }

        // ---- three stars in the south (CDL3STARSINSOUTH)
        if (a.col === -1 && b.col === -1 && c.col === -1 && T.bigEnough(a) && T.long(a) && T.shLong(a, a.lo)
          && b.body < a.body && b.o > a.c && b.o <= a.h && b.l < a.c && b.l >= a.l && !T.shVShort(b, b.lo)
          && T.short(c) && T.shVShort(c, c.lo) && T.shVShort(c, c.up) && c.l > b.l && c.h < b.h) {
          E({ id: 'three-stars-in-the-south', dir: 'up', bars: tri, keyBar: 0, ctxDir: 'down', tags: ['CDL3STARSINSOUTH', 'rare'], geo: { bodies: [a.body / T.B, b.body / T.B, c.body / T.B] } });
        }

        // ---- tri-star (CDLTRISTAR, no gap needed): three dojis, middle one displaced (body mid above/below both neighbours)
        if (T.doji(a) && T.doji(b) && T.doji(c) && (a.rng + b.rng + c.rng) >= 2 * T.minRange) {
          if (b.mid > a.mid && b.mid > c.mid && b.bBot >= Math.max(a.bTop, c.bTop) - T.equal) E({ id: 'tri-star-bear', dir: 'down', bars: tri, keyBar: 1, ctxDir: 'up', tags: ['CDLTRISTAR', 'doji-cluster'], geo: { starLiftRel: (b.mid - Math.max(a.mid, c.mid)) / T.R } });
          else if (b.mid < a.mid && b.mid < c.mid && b.bTop <= Math.min(a.bBot, c.bBot) + T.equal) E({ id: 'tri-star-bull', dir: 'up', bars: tri, keyBar: 1, ctxDir: 'down', tags: ['CDLTRISTAR', 'doji-cluster'], geo: { starLiftRel: (Math.min(a.mid, c.mid) - b.mid) / T.R } });
        }

        // ---- unique three river bottom (CDLUNIQUE3RIVER)
        if (a.col === -1 && T.bigEnough(a) && T.long(a) && b.col === -1 && b.c > a.c && b.o <= a.o && b.l < a.l && c.col === 1 && T.short(c) && c.o > b.l) {
          E({ id: 'unique-three-river', dir: 'up', bars: tri, keyBar: 1, ctxDir: 'down', tags: ['CDLUNIQUE3RIVER', 'rare', 'theory-bullish'], geo: { hammerLoRel: b.rng > 0 ? b.lo / b.rng : 0 } });
        }

        // ---- two crows-lite / upside-gap-two-crows-lite (CDL2CROWS, CDLUPSIDEGAP2CROWS; body gap → black star at/above C1 − Equal)
        if (a.col === 1 && T.bigEnough(a) && T.long(a) && b.col === -1 && b.bBot >= a.c - T.equal && c.col === -1) {
          const geo = { gapRel: (b.bBot - a.bTop) / T.R, classicGap: b.bBot > a.bTop };
          if (c.o < b.o && c.o > b.c && c.c > a.o && c.c < a.c) E({ id: 'two-crows-lite', dir: 'down', bars: tri, keyBar: 2, ctxDir: 'up', tags: ['CDL2CROWS'], geo });
          else if (T.short(b) && c.o > b.o && c.c < b.c && c.c > a.c) E({ id: 'upside-gap-two-crows-lite', dir: 'down', bars: tri, keyBar: 2, ctxDir: 'up', tags: ['CDLUPSIDEGAP2CROWS'], geo });
        }
        // mirror: two doves (rare, not in TA-Lib) — omitted.

        // ---- stick sandwich (CDLSTICKSANDWICH; adapted: white body above prior close)
        if (a.col === -1 && b.col === 1 && c.col === -1 && b.bBot > a.c && T.eq(c.c, a.c) && T.bigEnough(a) && T.notDoji(a) && T.notDoji(c)) {
          E({ id: 'stick-sandwich', dir: 'up', bars: tri, keyBar: 2, ctxDir: 'down', tags: ['CDLSTICKSANDWICH', 'equal-closes'], geo: { closeDiffTicks: Math.abs(c.c - a.c) / 0.25, whiteLowAboveClose: b.l > a.c } });
        }

        // ---- upside / downside gap three methods-lite and tasuki-lite (CDLXSIDEGAP3METHODS, CDLTASUKIGAP)
        if (a.col !== 0 && b.col === a.col && c.col === -a.col && T.bigEnough(a) && T.notShort(a) && T.notShort(b)) {
          const up = a.col === 1;
          const gapBody = up ? b.bBot - a.bTop : a.bBot - b.bTop;    // real-body separation between bar1 and bar2 in trend direction
          const opensInB = c.o < b.bTop && c.o > b.bBot;
          const geo = { gapRel: gapBody / T.R, classicGap: gapBody > 0, bodySim: Math.abs(c.body - b.body) / T.R };
          if (gapBody >= -T.equal && opensInB && c.c < a.bTop && c.c > a.bBot) {
            E({ id: up ? 'upside-gap-three-methods-lite' : 'downside-gap-three-methods-lite', dir: up ? 'up' : 'down', bars: tri, keyBar: 2, ctxDir: up ? 'up' : 'down',
              tags: ['CDLXSIDEGAP3METHODS', 'pullback-into-thrust', 'theory-continuation'], geo });
          } else if (gapBody >= T.near && opensInB && Math.abs(c.body - b.body) < T.near && (up ? (c.c < b.bBot && c.c > a.bTop) : (c.c > b.bTop && c.c < a.bBot))) {
            E({ id: up ? 'upside-tasuki-lite' : 'downside-tasuki-lite', dir: up ? 'up' : 'down', bars: tri, keyBar: 2, ctxDir: up ? 'up' : 'down',
              tags: ['CDLTASUKIGAP', 'theory-continuation'], geo });
          }
        }
      },
    };
  },
};
