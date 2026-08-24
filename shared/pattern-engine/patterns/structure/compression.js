/**
 * P10 compression_range — bilateral compression structures (the breakout side is the lifecycle's job).
 *  compression-box  : total range (max high − min low) of the last N=7 bars ≤ pctile (15th) of the trailing 200
 *                     N-bar window ranges (own causal ring; the current window is ranked BEFORE it is pushed).
 *                     Emitted on entry (previous window not compressed) and again every N bars while it persists
 *                     (each emission = a fresh box keyed by its first bar). upper/lower = box, targets = box ± height.
 *  nr-2bar          : the 2-bar range (bars[-2..-1]) is the narrowest of the last 20 two-bar windows (Crabel 2BNR).
 *                     targets = box ± max(height, minTargetAtr·ATR).
 *  squeeze-on       : Bollinger(20, 2σ) inside Keltner(20 SMA, 1.5·ATR) — emitted on the off→on transition;
 *                     upper/lower = KC bands (frozen), targets = ± KC width. Fire = lifecycle 'confirmed'.
 * ii / iii sequences are the candle detector's job (skipped here).
 */
import { barAnchor, sortAnchors } from './_common.js';
import { Ring } from '../../features.js';

export default {
  id: 'compression', family: 'structure',
  params: { boxN: 7, boxHist: 200, boxPctile: 0.15, boxMinHist: 50, nr2N: 20, bbLen: 20, bbMult: 2.0, kcMult: 1.5, minTargetAtr: 1.0 },
  create({ params: P }) {
    const boxRing = new Ring(P.boxHist);
    let inBox = false, lastBoxEmitIdx = -Infinity, wasSqueeze = false;
    const windowRange = (bars, n, off = 0) => {          // range of bars ending `off` bars before the latest
      let hi = -Infinity, lo = Infinity; const L = bars.length;
      for (let i = L - off - n; i < L - off; i++) { const b = bars.at(i); if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
      return { hi, lo, h: hi - lo };
    };
    return {
      onBar(bar, f, ctx) {
        const atr = f.atr; if (!Number.isFinite(atr) || atr <= 0) return;
        const bars = ctx.bars;
        // --- compression box
        if (bars.length >= P.boxN) {
          const w = windowRange(bars, P.boxN);
          const rank = boxRing.len >= P.boxMinHist ? boxRing.rank(w.h) : NaN;
          const compressed = Number.isFinite(rank) && rank <= P.boxPctile;
          if (compressed && (!inBox || ctx.barIdx - lastBoxEmitIdx >= P.boxN)) {
            const first = bars.at(-P.boxN);
            const hiBar = (() => { let b = first; for (let i = bars.length - P.boxN; i < bars.length; i++) if (bars.at(i).high >= b.high) b = bars.at(i); return b; })();
            const loBar = (() => { let b = first; for (let i = bars.length - P.boxN; i < bars.length; i++) if (bars.at(i).low <= b.low) b = bars.at(i); return b; })();
            ctx.emit({
              patternId: 'compression-box', family: 'structure', key: String(first.ts), state: 'forming', direction: 'bilateral',
              levels: { upper: w.hi, lower: w.lo, targetUp: w.hi + w.h, targetDown: w.lo - w.h, midline: (w.hi + w.lo) / 2, invalidationUp: w.lo, invalidationDown: w.hi },
              anchors: sortAnchors([barAnchor('boxStart', first, first.open), barAnchor('boxHigh', hiBar, hiBar.high), barAnchor('boxLow', loBar, loBar.low), barAnchor('boxEnd', bar)]),
              geometry: { durationBars: P.boxN, heightAtr: w.h / atr, rangePctile: rank, heightVsSqrtBars: w.h / (atr * Math.sqrt(P.boxN)), emaDist: f.emaDist, atrPctile: f.atrPctile,
                tags: ['brk_tight_trading_range', 'crabel_nr', 'ttm_squeeze-lite', 'volman_block', 'smc_accumulation', 'wy_phase_b'], params: { N: P.boxN, pctile: P.boxPctile, hist: P.boxHist } },
            });
            lastBoxEmitIdx = ctx.barIdx;
          }
          inBox = compressed;
          boxRing.push(w.h);
        }
        // --- 2-bar NR
        if (bars.length >= P.nr2N + 1) {
          const cur = windowRange(bars, 2);
          let nr = true;
          for (let off = 1; off < P.nr2N && nr; off++) if (windowRange(bars, 2, off).h <= cur.h) nr = false;
          if (nr) {
            const prev = bars.at(-2);
            const d = Math.max(cur.h, P.minTargetAtr * atr);
            ctx.emit({
              patternId: 'nr-2bar', family: 'structure', key: String(prev.ts), state: 'forming', direction: 'bilateral',
              levels: { upper: cur.hi, lower: cur.lo, targetUp: cur.hi + d, targetDown: cur.lo - d, midline: (cur.hi + cur.lo) / 2 },
              anchors: [barAnchor('bar1', prev), barAnchor('bar2', bar)],
              geometry: { durationBars: 2, heightAtr: cur.h / atr, insideBar: bar.high <= prev.high && bar.low >= prev.low, rangeRel: f.rangeRel, tags: ['crabel_nr', 'crabel_2bnr', 'brk_ii'], params: { N: P.nr2N } },
            });
          }
        }
        // --- Bollinger inside Keltner (TTM squeeze)
        if (bars.length >= P.bbLen) {
          let s = 0, s2 = 0;
          for (let i = bars.length - P.bbLen; i < bars.length; i++) { const c = bars.at(i).close; s += c; s2 += c * c; }
          const mean = s / P.bbLen, sd = Math.sqrt(Math.max(0, s2 / P.bbLen - mean * mean));
          const bbU = mean + P.bbMult * sd, bbL = mean - P.bbMult * sd;
          const kcU = mean + P.kcMult * atr, kcL = mean - P.kcMult * atr;
          const on = bbU < kcU && bbL > kcL;
          if (on && !wasSqueeze) {
            const kw = kcU - kcL;
            ctx.emit({
              patternId: 'squeeze-on', family: 'structure', key: String(bar.ts), state: 'forming', direction: 'bilateral',
              levels: { upper: kcU, lower: kcL, targetUp: kcU + kw, targetDown: kcL - kw, midline: mean, extra: { bbUpper: bbU, bbLower: bbL } },
              anchors: [barAnchor('squeezeStart', bar)],
              geometry: { durationBars: 1, heightAtr: kw / atr, bbWidthAtr: (bbU - bbL) / atr, bbOverKc: kw > 0 ? (bbU - bbL) / kw : null, emaDist: f.emaDist, atrPctile: f.atrPctile,
                tags: ['bb_squeeze', 'ttm_squeeze', 'brk_tight_trading_range', 'wy_phase_b'], params: { bbLen: P.bbLen, bbMult: P.bbMult, kcMult: P.kcMult } },
            });
          }
          wasSqueeze = on;
        }
      },
    };
  },
};
