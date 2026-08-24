/**
 * P13 climax_bar — outsized bar after an extended move (reversal reading; ICT displacement = the opposite reading,
 * tagged 'smc_displacement(cont)').
 *  climax-bar-up   : extended UP move (≥ moveAtr·ATR from the lowest low of the last moveBars bars, efficiency ratio of
 *                    closes over that leg ≥ minEr) AND this bar has range ≥ rangeZMult × same-time-of-day median range
 *                    (f.rangeZ) OR ≥ rangeRelMult × scale (f.rangeRel) — and ≥ minRangeRel × scale in any case —, relVol ≥ minRelVol when available, and closes in
 *                    the top third (clv ≥ 1/3).  direction = down; trigger = bar low, invalidation = bar high,
 *                    target = midpoint of the extended move.  Mirrored: climax-bar-down.
 *  extension-bar-up|down : |f.emaDist| ≥ extAtr (close ≥ 2.5 ATR from EMA20), emitted on the transition into the
 *                    extended zone (or every extCooldown bars while it persists); same levels (target = move midpoint if a
 *                    qualifying move exists, else the EMA20 value).
 * geometry: moveAtr, moveBars, er, rangeZ, rangeRel, relVol, clv, emaDist, tags per catalog 03 §7 climax_bar row.
 */
import { barAnchor, sortAnchors, efficiencyRatio } from './_common.js';

export default {
  id: 'climax', family: 'structure',
  params: { moveAtr: 3.0, moveBars: 20, minEr: 0.6, rangeZMult: 2.0, rangeRelMult: 2.5, minRelVol: 2.0, closeThird: 1 / 3, minRangeRel: 1.0, extAtr: 2.5, extCooldown: 10, minMoveBars: 3 },
  create({ params: P }) {
    let lastExtIdx = { up: -Infinity, down: -Infinity }, wasExt = { up: false, down: false };
    /** extended move ending at this bar in direction dir: from the opposite extreme within the last moveBars bars */
    function extendedMove(bars, bar, atr, dir) {
      const L = bars.length; const n = Math.min(P.moveBars, L - 1);
      let extB = null, ext = dir === 'up' ? Infinity : -Infinity, extI = -1;
      for (let i = L - 1 - n; i < L; i++) {
        const b = bars.at(i);
        if (dir === 'up' ? b.low < ext : b.high > ext) { ext = dir === 'up' ? b.low : b.high; extB = b; extI = i; }
      }
      if (!extB) return null;
      const move = dir === 'up' ? bar.high - ext : ext - bar.low;
      const legBars = L - 1 - extI;
      if (legBars < P.minMoveBars) return null;
      const er = efficiencyRatio(bars, legBars);
      return { move, moveAtr: move / atr, legBars, er, startBar: extB, startPrice: ext, mid: (ext + (dir === 'up' ? bar.high : bar.low)) / 2 };
    }
    return {
      onBar(bar, f, ctx) {
        const atr = f.atr; if (!Number.isFinite(atr) || atr <= 0) return;
        const bars = ctx.bars; if (bars.length < P.minMoveBars + 2) return;
        const rng = bar.high - bar.low; if (rng <= 0) return;
        const bigBar = ((Number.isFinite(f.rangeZ) && f.rangeZ >= P.rangeZMult) || (Number.isFinite(f.rangeRel) && f.rangeRel >= P.rangeRelMult)) && f.rangeRel >= P.minRangeRel;
        const volOk = !Number.isFinite(f.relVol) || f.relVol >= P.minRelVol;
        const closePos = (bar.close - bar.low) / rng;
        for (const dir of ['up', 'down']) {
          const closeExtreme = dir === 'up' ? closePos >= 1 - P.closeThird : closePos <= P.closeThird;
          const mv = extendedMove(bars, bar, atr, dir);
          const extended = mv && mv.moveAtr >= P.moveAtr && mv.er >= P.minEr;
          const revDir = dir === 'up' ? 'down' : 'up';
          const levels = dir === 'up'
            ? { trigger: bar.low, triggerSide: 'below', invalidation: bar.high, target: null }
            : { trigger: bar.high, triggerSide: 'above', invalidation: bar.low, target: null };
          const baseGeo = { rangeZ: f.rangeZ, rangeRel: f.rangeRel, relVol: f.relVol, clv: f.clv, closePos, bodyRel: f.bodyRel, emaDist: f.emaDist, atrPctile: f.atrPctile,
            heightAtr: rng / atr, moveAtr: mv ? mv.moveAtr : null, moveBars: mv ? mv.legBars : null, er: mv ? mv.er : null };
          // climax bar
          if (extended && bigBar && volOk && closeExtreme) {
            ctx.emit({
              patternId: `climax-bar-${dir}`, family: 'structure', key: String(bar.ts), state: 'forming', direction: revDir,
              levels: { ...levels, target: mv.mid, target2: dir === 'up' ? bar.low - rng : bar.high + rng, extra: { moveStart: mv.startPrice, moveMid: mv.mid } },
              anchors: sortAnchors([barAnchor('moveStart', mv.startBar, mv.startPrice), barAnchor('climaxBar', bar)]),
              geometry: { ...baseGeo, durationBars: mv.legBars, priorMoveAtr: (dir === 'up' ? 1 : -1) * mv.moveAtr, priorMoveBars: mv.legBars,
                tags: ['brk_climax_bar', 'vsa_climactic_action', 'extension_bar', 'smc_displacement(cont)', dir === 'up' ? 'wy_buying_climax' : 'wy_selling_climax', 'lw_smash_day', 'key_reversal_seed'],
                params: { moveAtr: P.moveAtr, moveBars: P.moveBars, minEr: P.minEr, rangeZMult: P.rangeZMult, rangeRelMult: P.rangeRelMult, minRelVol: P.minRelVol } },
            });
          }
          // extension bar (distance from EMA20)
          const ext = Number.isFinite(f.emaDist) && (dir === 'up' ? f.emaDist >= P.extAtr : f.emaDist <= -P.extAtr);
          if (ext && (!wasExt[dir] || ctx.barIdx - lastExtIdx[dir] >= P.extCooldown)) {
            const emaVal = bar.close - f.emaDist * atr;
            const target = extended ? mv.mid : emaVal;
            ctx.emit({
              patternId: `extension-bar-${dir}`, family: 'structure', key: String(bar.ts), state: 'forming', direction: revDir,
              levels: { ...levels, target, target2: emaVal, extra: { ema20: emaVal, moveMid: mv ? mv.mid : null } },
              anchors: sortAnchors([mv ? barAnchor('moveStart', mv.startBar, mv.startPrice) : null, barAnchor('extensionBar', bar)]),
              geometry: { ...baseGeo, durationBars: mv ? mv.legBars : 1, priorMoveAtr: mv ? (dir === 'up' ? 1 : -1) * mv.moveAtr : null, extendedMove: !!extended, bigBar, closeExtreme,
                tags: ['extension_bar', 'vwap_extension', 'brk_climax_bar', 'raschke_anti_seed', 'mean_reversion'], params: { extAtr: P.extAtr } },
            });
            lastExtIdx[dir] = ctx.barIdx;
          }
          wasExt[dir] = ext;
        }
      },
    };
  },
};
