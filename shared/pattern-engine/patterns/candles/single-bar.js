/**
 * Single-bar candle classifier → emits one 'forming' event per bar per matched shape with
 * trigger = break of the bar's extreme in the pattern direction, invalidation = opposite extreme.
 * Shapes (catalog 02 §3, §7): doji family, hammer family, pin bar, marubozu/WRB/climax, inside/outside, NR7/WRB.
 * All thresholds relative to own range / rolling medians (catalog 02 §1.3). No shape when range < minTicks*tick.
 */
const TICK = 0.25;
export default {
  id: 'single-bar', family: 'candle',
  params: { minTicks: 8, dojiBody: 0.10, pinTail: 0.66, pinBodyMax: 0.34, maruBody: 0.85, wrbRel: 2.0, longBodyVsMed: 1.5, nrN: 7 },
  create({ params: P, tfMin }) {
    const minRange = Math.max(P.minTicks, tfMin >= 60 ? 16 : P.minTicks) * TICK;
    return {
      onBar(bar, f, ctx) {
        const rng = bar.high - bar.low;
        if (rng < minRange || !Number.isFinite(f.scale)) return;
        const shapes = [];
        const closeUp = f.dir >= 0;
        // doji family
        if (f.bodyRel <= P.dojiBody) {
          if (f.loRel >= 0.66 && f.upRel <= 0.1) shapes.push(['dragonfly-doji', 'up']);
          else if (f.upRel >= 0.66 && f.loRel <= 0.1) shapes.push(['gravestone-doji', 'down']);
          else if (f.upRel >= 0.3 && f.loRel >= 0.3 && f.rangeRel >= 1.0) shapes.push(['long-legged-doji', 'bilateral']);
          else shapes.push(['doji', 'bilateral']);
        }
        // pin / hammer family (tail ≥ 2/3 range, body ≤ 1/3, opposite shadow small)
        if (f.loRel >= P.pinTail && f.bodyRel <= P.pinBodyMax) shapes.push([f.emaDist < 0 ? 'hammer' : 'hanging-man', 'up', 'pin-bar-bull']);
        if (f.upRel >= P.pinTail && f.bodyRel <= P.pinBodyMax) shapes.push([f.emaDist > 0 ? 'shooting-star' : 'inverted-hammer', 'down', 'pin-bar-bear']);
        // marubozu / WRB / climax
        if (f.bodyRel >= P.maruBody && f.bodyVsMed >= P.longBodyVsMed) shapes.push([closeUp ? 'marubozu-bull' : 'marubozu-bear', closeUp ? 'up' : 'down']);
        if (f.rangeRel >= P.wrbRel && f.bodyRel >= 0.5) shapes.push([closeUp ? 'wrb-bull' : 'wrb-bear', closeUp ? 'up' : 'down']);
        // inside / outside vs previous bar
        const prev = ctx.bars.at(-2);
        if (prev) {
          if (bar.high <= prev.high && bar.low >= prev.low) shapes.push(['inside-bar', 'bilateral']);
          if (bar.high > prev.high && bar.low < prev.low) shapes.push([closeUp ? 'outside-bar-bull' : 'outside-bar-bear', closeUp ? 'up' : 'down']);
        }
        // NR7 (narrowest of last 7)
        if (ctx.bars.length >= P.nrN) {
          const w = ctx.bars.last(P.nrN); let nr = true;
          for (let i = 0; i < w.length - 1; i++) if ((w[i].high - w[i].low) <= rng) { nr = false; break; }
          if (nr) shapes.push([`nr${P.nrN}`, 'bilateral']);
        }
        if (!shapes.length) return;
        const anchors = [{ role: 'bar0', ts: bar.ts, price: bar.close, confirmedAt: bar.closeTs }];
        const geometry = { durationBars: 1, heightAtr: rng / f.atr, bodyRel: f.bodyRel, upRel: f.upRel, loRel: f.loRel, clv: f.clv, rangeRel: f.rangeRel, rangeZ: f.rangeZ, bodyVsMed: f.bodyVsMed, relVol: f.relVol, emaDist: f.emaDist };
        for (const [pid, dir, alias] of shapes) {
          const levels = dir === 'up' ? { trigger: bar.high, triggerSide: 'above', invalidation: bar.low, target: bar.high + rng }
            : dir === 'down' ? { trigger: bar.low, triggerSide: 'below', invalidation: bar.high, target: bar.low - rng }
            : { upper: bar.high, lower: bar.low, targetUp: bar.high + rng, targetDown: bar.low - rng };
          ctx.emit({ patternId: pid, family: 'candle', key: String(bar.ts), state: 'forming', direction: dir, levels, anchors, geometry: { ...geometry, alias } });
        }
      },
    };
  },
};
