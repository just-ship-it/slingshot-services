/**
 * P9 three_bar_gap (FVG / imbalance / Brooks measuring gap).
 *   bull: bars[-3].high < bars[-1].low  → zone [bars[-3].high, bars[-1].low]
 *   bear: bars[-3].low  > bars[-1].high → zone [bars[-1].high, bars[-3].low]
 * size ≥ max(minTicks·tick, atrMult·ATR, autoMult·mean(|gap| of the last 100 three-bar gaps of any size))
 * (set atrMult or autoMult to 0 to disable that leg; both thresholds are reported in geometry).
 * Emitted at the close of the third bar as a continuation structure (ICT: retest into the gap, then continue):
 *   bull: trigger = high of bars[-1] (above), invalidation = fvgBottom − invAtr·ATR (full fill = inversion), target = trigger + 2·gap
 * levels.extra = { fvgTop, fvgBottom, ce }.  Optional `requireMidClose` (LuxAlgo: middle bar closes beyond bars[-3]).
 * Fill tracking (bounded list): first close through the far edge → `fvg-inverted-bull|bear` (iFVG: the zone flips;
 * direction = against the original gap, trigger = inverting bar's low/high, invalidation = far edge of the zone,
 * target = trigger ∓ 2·gap).
 */
import { TICK, barAnchor, sortAnchors } from './_common.js';
import { Ring } from '../../features.js';

export default {
  id: 'fvg', family: 'structure',
  params: { minTicks: 2, atrMult: 0.15, autoMult: 0.5, autoLen: 100, invAtr: 0.25, requireMidClose: false, trackFills: true, maxOpen: 24, maxOpenBars: 200 },
  create({ params: P }) {
    const gaps = new Ring(P.autoLen);     // |gap| of every three-bar gap (any size) — for the auto threshold
    const open = [];                      // open FVGs: { dir, top, bottom, ts, bars, key }
    return {
      onBar(bar, f, ctx) {
        const atr = f.atr; if (!Number.isFinite(atr) || atr <= 0) return;
        const bars = ctx.bars; if (bars.length < 3) return;
        const b1 = bars.at(-3), b2 = bars.at(-2), b3 = bar;
        // 1) fills / inversions of open FVGs (this bar)
        if (P.trackFills) {
          for (let i = open.length - 1; i >= 0; i--) {
            const g = open[i]; g.bars++;
            const inverted = g.dir === 'up' ? bar.close < g.bottom : bar.close > g.top;
            if (inverted) {
              const gap = g.top - g.bottom;
              const up = g.dir !== 'up';                                 // iFVG direction is against the original gap
              ctx.emit({
                patternId: g.dir === 'up' ? 'fvg-inverted-bull' : 'fvg-inverted-bear', family: 'structure', key: g.key, state: 'forming', direction: up ? 'up' : 'down',
                levels: { trigger: up ? bar.high : bar.low, triggerSide: up ? 'above' : 'below', invalidation: up ? g.bottom : g.top,
                  target: up ? bar.high + 2 * gap : bar.low - 2 * gap, extra: { fvgTop: g.top, fvgBottom: g.bottom, ce: (g.top + g.bottom) / 2 } },
                anchors: sortAnchors([g.a1, g.a3, barAnchor('inversionBar', bar)]),
                geometry: { gapAtr: gap / atr, heightAtr: gap / atr, barsToInvert: g.bars, durationBars: g.bars, tags: ['smc_ifvg', 'smc_fvg', 'gap_fill', 'brk_failed_breakout'], relVol: f.relVol },
              });
              open.splice(i, 1);
            } else if (g.bars > P.maxOpenBars) open.splice(i, 1);
          }
        }
        // 2) new FVG sealed by this bar
        let dir = null, top, bottom;
        if (b1.high < b3.low) { dir = 'up'; top = b3.low; bottom = b1.high; }
        else if (b1.low > b3.high) { dir = 'down'; top = b1.low; bottom = b3.high; }
        if (!dir) return;
        const gap = top - bottom;
        const autoMean = gaps.len >= 10 ? gaps.mean() : NaN;
        gaps.push(gap);
        const thrAtr = P.atrMult * atr, thrAuto = Number.isFinite(autoMean) ? P.autoMult * autoMean : 0;
        const thr = Math.max(P.minTicks * TICK, thrAtr, thrAuto);
        if (gap < thr) return;
        if (P.requireMidClose && (dir === 'up' ? !(b2.close > b1.high) : !(b2.close < b1.low))) return;
        const up = dir === 'up';
        const a1 = barAnchor('bar1', b1, up ? b1.high : b1.low), a2 = barAnchor('bar2', b2), a3 = barAnchor('bar3', b3, up ? b3.low : b3.high);
        const trigger = up ? b3.high : b3.low;      // high/low of the third (sealing) bar = bars[-1]
        const key = String(b1.ts);
        ctx.emit({
          patternId: up ? 'fvg-bull' : 'fvg-bear', family: 'structure', key, state: 'forming', direction: dir,
          levels: { trigger, triggerSide: up ? 'above' : 'below', invalidation: up ? bottom - P.invAtr * atr : top + P.invAtr * atr,
            target: up ? trigger + 2 * gap : trigger - 2 * gap, target2: up ? trigger + gap : trigger - gap, extra: { fvgTop: top, fvgBottom: bottom, ce: (top + bottom) / 2 } },
          anchors: [a1, a2, a3],
          geometry: { gapAtr: gap / atr, heightAtr: gap / atr, gapTicks: gap / TICK, displacementAtr: (b2.high - b2.low) / atr, displacementBodyRel: b2.f ? b2.f.bodyRel : null,
            midClosesBeyond: up ? b2.close > b1.high : b2.close < b1.low, relVol: b2.f ? b2.f.relVol : null, relVol3: f.relVol, thrAtr: thrAtr / atr, thrAutoAtr: thrAuto / atr,
            gapVsAuto: Number.isFinite(autoMean) && autoMean > 0 ? gap / autoMean : null, emaDist: f.emaDist, durationBars: 3,
            tags: ['smc_fvg', 'brk_measuring_gap', up ? 'smc_bisi' : 'smc_sibi', 'mp_single_prints'], params: { atrMult: P.atrMult, autoMult: P.autoMult, minTicks: P.minTicks } },
        });
        if (P.trackFills) { open.push({ dir, top, bottom, ts: b1.ts, bars: 0, key, a1, a3 }); while (open.length > P.maxOpen) open.shift(); }
      },
    };
  },
};
