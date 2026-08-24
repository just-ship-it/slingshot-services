/**
 * Two-bar candlestick patterns (catalog 02 §4, §7.1, §5.19) + Brooks inside-bar sequences (ii/iii/ioi)
 * and hikkake (2-bar core + breakout bar; confirmation = lifecycle trigger within 3 bars).
 *
 * TA-Lib-style rules with the catalog §1.3 normalization (see _candle-lib.js). Gap-dependent rules use
 * the §7.10 adaptations: piercing / dark-cloud / on-neck family "-lite" replace `O < L1` by `O <= C1`;
 * kicking-lite replaces the shadow gap by real-body separation (or a no-gap V2). Classic and -lite
 * variants are separate patternIds; only the most specific match is emitted per pair (harami-cross over
 * harami, piercing over piercing-lite, ...). Key = ts of the first bar of the pattern.
 * Direction follows classical theory; `geometry.contextOk` reports the classical prior-trend requirement
 * without filtering on it.
 */
import { cs, Tiers, inside, outside, emitPattern } from './_candle-lib.js';

export default {
  id: 'two-bar', family: 'candle',
  params: {
    ctxAtr: 1.0, ctxBars: 10, extremeBars: 20,   // prior-move context (geometry only)
    engulfRatio: 1.2,                             // engulfing body ≥ 1.2 × engulfed body (intraday variant)
    penetrationDC: 0.5,                           // piercing / dark cloud must close past 50% of prior body
    tweezerN: 20,                                 // tweezer level must be the N-bar extreme (T5, catalog §2)
    matchingLongFirst: true,                      // matching low/high: 1st bar long (Morris)
    paramSet: 'v0',
  },
  create({ params: P, tfMin }) {
    return {
      onBar(bar, f, ctx) {
        const T = new Tiers(f, tfMin);
        if (!T.ok || ctx.bars.length < 3) return;
        const c = cs(bar), p = cs(ctx.bars.at(-2));
        const E = (spec) => emitPattern(ctx, f, T, P, spec);
        const pair = [p, c];

        // ---- engulfing (CDLENGULFING) — bodies only, intraday variant: engulfing bar long and ≥1.2× engulfed body
        if (T.bigEnough(c) && T.notDoji(p) && T.long(c) && c.body >= P.engulfRatio * p.body) {
          const covers = (c.bTop >= p.bTop && c.bBot < p.bBot) || (c.bTop > p.bTop && c.bBot <= p.bBot);
          if (covers && p.col === -1 && c.col === 1) {
            E({ id: 'engulfing-bull', dir: 'up', bars: pair, ctxDir: 'down',
              tags: ['CDLENGULFING', outside(c, p) ? 'outside-bar' : 'body-engulf', 'reversal-bar'],
              geo: { bodyRatio: c.body / p.body, engulfsRange: outside(c, p) } });
          } else if (covers && p.col === 1 && c.col === -1) {
            E({ id: 'engulfing-bear', dir: 'down', bars: pair, ctxDir: 'up',
              tags: ['CDLENGULFING', outside(c, p) ? 'outside-bar' : 'body-engulf', 'reversal-bar'],
              geo: { bodyRatio: c.body / p.body, engulfsRange: outside(c, p) } });
          }
        }

        // ---- harami / harami cross / homing pigeon / descending hawk (CDLHARAMI, CDLHARAMICROSS, CDLHOMINGPIGEON)
        if (T.bigEnough(p) && T.long(p) && T.short(c) && c.bTop < p.bTop && c.bBot > p.bBot) {
          const cross = T.doji(c);
          const geo = { bodyRatio: c.body / p.body, insideRange: inside(c, p), motherBodyRel: p.rng > 0 ? p.body / p.rng : 0 };
          if (p.col === -1 && c.col >= 0) {
            E({ id: cross ? 'harami-cross-bull' : 'harami-bull', dir: 'up', bars: pair, keyBar: 0, ctxDir: 'down',
              tags: cross ? ['CDLHARAMICROSS', 'CDLHARAMI', 'inside-bar'] : ['CDLHARAMI', 'inside-bar'], geo,
              extra: { tightTrigger: c.h, tightInvalidation: c.l } });
          } else if (p.col === 1 && c.col <= 0) {
            E({ id: cross ? 'harami-cross-bear' : 'harami-bear', dir: 'down', bars: pair, keyBar: 0, ctxDir: 'up',
              tags: cross ? ['CDLHARAMICROSS', 'CDLHARAMI', 'inside-bar'] : ['CDLHARAMI', 'inside-bar'], geo,
              extra: { tightTrigger: c.l, tightInvalidation: c.h } });
          } else if (p.col === -1 && c.col === -1) {
            E({ id: 'homing-pigeon', dir: 'up', bars: pair, keyBar: 0, ctxDir: 'down', tags: ['CDLHOMINGPIGEON', 'CDLHARAMI', 'inside-bar', 'same-colour-harami'], geo,
              extra: { tightTrigger: c.h, tightInvalidation: c.l } });
          } else if (p.col === 1 && c.col === 1) {
            E({ id: 'descending-hawk', dir: 'down', bars: pair, keyBar: 0, ctxDir: 'up', tags: ['CDLHARAMI', 'inside-bar', 'same-colour-harami'], geo,
              extra: { tightTrigger: c.l, tightInvalidation: c.h } });
          }
        }

        // ---- piercing line / dark cloud cover (+ -lite: O <= C1 / O >= C1 instead of the gap) ; on-neck / in-neck / thrusting
        if (T.bigEnough(p) && T.long(p)) {
          if (p.col === -1 && c.col === 1 && c.o <= p.c) {
            const pen = (c.c - p.c) / p.body;                       // penetration into prior black body (0 = at prior close, 1 = at prior open)
            const classic = c.o < p.l;
            const geo = { penetration: pen, gapRel: (p.c - c.o) / T.R, classicGap: classic };
            if (T.long(c) && c.c > p.mid && c.c < p.o && pen >= P.penetrationDC) {
              E({ id: classic ? 'piercing-line' : 'piercing-line-lite', dir: 'up', bars: pair, ctxDir: 'down', tags: ['CDLPIERCING'], geo });
            } else if (T.eq(c.c, p.l)) {
              E({ id: 'on-neck', dir: 'down', bars: pair, keyBar: 0, ctxDir: 'down', tags: ['CDLONNECK', classic ? 'classic-gap' : 'lite'], geo });
            } else if (c.c >= p.c && c.c <= p.c + T.equal) {
              E({ id: 'in-neck', dir: 'down', bars: pair, keyBar: 0, ctxDir: 'down', tags: ['CDLINNECK', classic ? 'classic-gap' : 'lite'], geo });
            } else if (c.c > p.c + T.equal && c.c < p.mid) {
              E({ id: 'thrusting', dir: 'down', bars: pair, keyBar: 0, ctxDir: 'down', tags: ['CDLTHRUSTING', classic ? 'classic-gap' : 'lite'], geo });
            }
          } else if (p.col === 1 && c.col === -1 && c.o >= p.c) {
            const pen = (p.c - c.c) / p.body;
            const classic = c.o > p.h;
            const geo = { penetration: pen, gapRel: (c.o - p.c) / T.R, classicGap: classic };
            if (T.long(c) && c.c < p.mid && c.c > p.o && pen >= P.penetrationDC) {
              E({ id: classic ? 'dark-cloud-cover' : 'dark-cloud-cover-lite', dir: 'down', bars: pair, ctxDir: 'up', tags: ['CDLDARKCLOUDCOVER'], geo });
            } else if (T.eq(c.c, p.h)) {
              E({ id: 'on-neck-bear', dir: 'up', bars: pair, keyBar: 0, ctxDir: 'up', tags: ['on-neck-mirror', classic ? 'classic-gap' : 'lite'], geo });
            } else if (c.c <= p.c && c.c >= p.c - T.equal) {
              E({ id: 'in-neck-bear', dir: 'up', bars: pair, keyBar: 0, ctxDir: 'up', tags: ['in-neck-mirror', classic ? 'classic-gap' : 'lite'], geo });
            } else if (c.c < p.c - T.equal && c.c > p.mid) {
              E({ id: 'thrusting-bear', dir: 'up', bars: pair, keyBar: 0, ctxDir: 'up', tags: ['thrusting-mirror', classic ? 'classic-gap' : 'lite'], geo });
            }
          }
        }

        // ---- tweezer top / bottom (equal extremes at an N-bar extreme; suppressed if the prior pair already qualified)
        if (T.bigEnough(c) || T.bigEnough(p)) {
          const pp = cs(ctx.bars.at(-3));
          const w = ctx.bars.last(P.tweezerN + 2);
          if (w.length >= P.tweezerN + 2) {
            if (T.eqTight(c.l, p.l) && !T.eqTight(p.l, pp.l)) {
              const lvl = Math.min(c.l, p.l); let ok = true;
              for (let i = 0; i < w.length - 2; i++) if (w[i].low < lvl) { ok = false; break; }
              if (ok) E({ id: 'tweezer-bottom', dir: 'up', bars: pair, ctxDir: 'down', tags: ['tweezers-bottom', 'equal-lows'], geo: { levelDiffTicks: Math.abs(c.l - p.l) / 0.25, colours: `${p.col}/${c.col}` }, extra: { level: lvl } });
            }
            if (T.eqTight(c.h, p.h) && !T.eqTight(p.h, pp.h)) {
              const lvl = Math.max(c.h, p.h); let ok = true;
              for (let i = 0; i < w.length - 2; i++) if (w[i].high > lvl) { ok = false; break; }
              if (ok) E({ id: 'tweezer-top', dir: 'down', bars: pair, ctxDir: 'up', tags: ['tweezers-top', 'equal-highs'], geo: { levelDiffTicks: Math.abs(c.h - p.h) / 0.25, colours: `${p.col}/${c.col}` }, extra: { level: lvl } });
            }
          }
        }

        // ---- matching low / high (CDLMATCHINGLOW): two same-colour bars with equal closes
        if (T.eqTight(c.c, p.c) && T.notDoji(p) && (!P.matchingLongFirst || T.long(p)) && T.bigEnough(p)) {
          if (p.col === -1 && c.col === -1) E({ id: 'matching-low', dir: 'up', bars: pair, keyBar: 0, ctxDir: 'down', tags: ['CDLMATCHINGLOW'], geo: { closeDiffTicks: Math.abs(c.c - p.c) / 0.25 } });
          else if (p.col === 1 && c.col === 1) E({ id: 'matching-high', dir: 'down', bars: pair, keyBar: 0, ctxDir: 'up', tags: ['matching-high', 'CDLMATCHINGLOW-mirror'], geo: { closeDiffTicks: Math.abs(c.c - p.c) / 0.25 } });
        }

        // ---- counterattack / meeting lines (CDLCOUNTERATTACK): opposite long bodies, 2nd opens away (≥ Near) and closes back at C1
        if (T.long(p) && T.long(c) && p.col === -c.col && c.col !== 0 && T.eq(c.c, p.c) && Math.abs(c.o - p.c) >= T.near) {
          const bull = c.col === 1;
          E({ id: bull ? 'counterattack-bull' : 'counterattack-bear', dir: bull ? 'up' : 'down', bars: pair, ctxDir: bull ? 'down' : 'up',
            tags: ['CDLCOUNTERATTACK', 'meeting-lines', 'session-gap-likely'], geo: { openAwayRel: Math.abs(c.o - p.c) / T.R } });
        }

        // ---- kicking (CDLKICKING) classic shadow gap; kicking-lite = two opposite marubozu without the shadow gap
        if (T.bigEnough(p) && T.bigEnough(c) && T.maru(p) && T.maru(c) && p.col === -c.col && c.col !== 0) {
          const bull = c.col === 1;
          const shadowGap = bull ? c.l > p.h : c.h < p.l;
          const gapBody = bull ? c.bBot - p.bTop : p.bBot - c.bTop;      // real-body separation in pattern direction
          const geo = { gapRel: gapBody / T.R, gapBodyTicks: gapBody / 0.25, longer: c.body >= p.body ? 'second' : 'first' };
          if (shadowGap) E({ id: bull ? 'kicking-bull' : 'kicking-bear', dir: bull ? 'up' : 'down', bars: pair, ctxDir: null, tags: ['CDLKICKING', 'CDLKICKINGBYLENGTH', 'shadow-gap'], geo });
          else E({ id: bull ? 'kicking-lite-bull' : 'kicking-lite-bear', dir: bull ? 'up' : 'down', bars: pair, ctxDir: null,
            tags: ['CDLKICKING-lite', gapBody >= T.near ? 'body-separation' : 'V2', 'two-bar-v-reversal'], geo });
        }

        // ---- Brooks inside-bar sequences: ii / iii (mother = outermost bar; bilateral) and ioi
        if (ctx.bars.length >= 4) {
          const b3 = cs(ctx.bars.at(-3)), b4 = cs(ctx.bars.at(-4));
          const in1 = inside(c, p), in2 = inside(p, b3), in3 = inside(b3, b4);
          const b5 = ctx.bars.length >= 5 ? cs(ctx.bars.at(-5)) : null;
          const in4 = b5 ? inside(b4, b5) : false;
          if (in1 && in2 && !in3) {
            E({ id: 'ii', dir: 'bilateral', bars: [b3, p, c], keyBar: 0, ctxDir: null, tags: ['inside-inside', 'compression', 'Brooks'],
              geo: { motherRangeAtr: b3.rng / T.atr, innerRangeRel: c.rng / (b3.rng || 1) },
              extra: { innerHigh: c.h, innerLow: c.l } });
          }
          if (in1 && in2 && in3 && !in4) {
            E({ id: 'iii', dir: 'bilateral', bars: [b4, b3, p, c], keyBar: 0, ctxDir: null, tags: ['inside-inside-inside', 'compression', 'Brooks'],
              geo: { motherRangeAtr: b4.rng / T.atr, innerRangeRel: c.rng / (b4.rng || 1) },
              extra: { innerHigh: c.h, innerLow: c.l } });
          }
          if (in1 && outside(p, b3) && inside(b3, b4)) {
            E({ id: 'ioi', dir: 'bilateral', bars: [b3, p, c], keyBar: 1, ctxDir: null, tags: ['inside-outside-inside', 'Brooks'],
              geo: { outsideRangeAtr: p.rng / T.atr, outsideClv: p.rng > 0 ? ((p.c - p.l) - (p.h - p.c)) / p.rng : 0, innerRangeRel: c.rng / (p.rng || 1) },
              extra: { innerHigh: c.h, innerLow: c.l } });
          }

          // ---- hikkake (CDLHIKKAKE / CDLHIKKAKEMOD): inside bar (strict) then a one-sided break; trigger = break of the
          //      inside bar's opposite extreme (confirmation expected within 3 bars: geometry.confirmWithinBars).
          if (p.h < b3.h && p.l > b3.l && T.bigEnough(b3)) {
            const upBreak = c.h > p.h && c.l >= p.l, dnBreak = c.l < p.l && c.h <= p.h;
            if (upBreak || dnBreak) {
              const modified = in3 && (upBreak ? b3.c >= b3.h - T.near : b3.c <= b3.l + T.near);
              const hi = Math.max(b3.h, p.h, c.h), lo = Math.min(b3.l, p.l, c.l), H = hi - lo;
              const geo = { breakDepthRel: (upBreak ? c.h - p.h : p.l - c.l) / T.R, insideRangeRel: p.rng / (b3.rng || 1), confirmWithinBars: 3, maxFormingBars: 3, modified };
              const tags = ['CDLHIKKAKE', 'failed-inside-bar-breakout', 'Brooks-failed-breakout'];
              if (modified) tags.push('CDLHIKKAKEMOD');
              if (upBreak) E({ id: 'hikkake-bear', dir: 'down', bars: [b3, p, c], keyBar: 2, ctxDir: null, tags, geo,
                levels: { trigger: p.l, triggerSide: 'below', invalidation: c.h, target: p.l - H, extra: { insideHigh: p.h, insideLow: p.l, motherHigh: b3.h, motherLow: b3.l } } });
              else E({ id: 'hikkake-bull', dir: 'up', bars: [b3, p, c], keyBar: 2, ctxDir: null, tags, geo,
                levels: { trigger: p.h, triggerSide: 'above', invalidation: c.l, target: p.h + H, extra: { insideHigh: p.h, insideLow: p.l, motherHigh: b3.h, motherLow: b3.l } } });
            }
          }
        }
      },
    };
  },
};
