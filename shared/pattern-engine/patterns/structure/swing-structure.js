/**
 * P6 breakout — swing structure (BOS / CHoCH) on two pivot tracks + Donchian N-bar breaks.
 *
 *  fractal track  = "internal structure" (LuxAlgo L = fractal k)     geometry.gen='fractal', structure='internal'
 *  zigzag  track  = "swing structure"    (ATR-zigzag θ)              geometry.gen='zigzag',  structure='swing'
 *
 * Per track: `pendingH` / `pendingL` = most recent confirmed major pivot of that kind not yet broken by a
 * CLOSE. On `close > pendingH.price` → `bos-up` if trend == +1 else `choch-up`; trend := +1 (LuxAlgo
 * smc_bos_choch, close-based). Mirror for lows. The break is emitted at the close of the breaking bar
 * (already beyond the level → the lifecycle confirms on the next close beyond by eps).
 *   levels: trigger = broken pivot price (triggerSide with the break), invalidation = the opposite pivot that
 *   started the leg, target = trigger ± |trigger − invalidation| (last impulse/leg range).
 * Donchian: `donchian-20-up|down`, `donchian-55-up|down` = first close beyond the highest high / lowest low
 * of the PRIOR N closed bars (fresh break only: previous bar was not beyond its own channel).
 *   levels: trigger = channel edge, invalidation = opposite M-bar extreme (M = 10 for 20, 20 for 55),
 *   target = trigger ± channel height.
 */
import { TICK, atrFloor, barAnchor, pivotAnchor, sortAnchors, extremes } from './_common.js';

export default {
  id: 'swing-structure', family: 'structure',
  params: { donchianN: [20, 55], donchianExit: { 20: 10, 55: 20 }, epsAtr: 0.0, minLegAtr: 0.5 },
  create({ params: P, tf }) {
    const tracks = {
      fractal: { pendingH: null, pendingL: null, lastH: null, lastL: null, prevH: null, prevL: null, trend: 0, legStartIdx: null },
      zigzag: { pendingH: null, pendingL: null, lastH: null, lastL: null, prevH: null, prevL: null, trend: 0, legStartIdx: null },
    };
    const dcState = {};                                    // N -> { above: bool, below: bool }
    for (const N of P.donchianN) dcState[N] = { above: false, below: false };

    function structureLabel(t) {
      const hh = t.lastH && t.prevH ? (t.lastH.price > t.prevH.price ? 'HH' : 'LH') : null;
      const hl = t.lastL && t.prevL ? (t.lastL.price > t.prevL.price ? 'HL' : 'LL') : null;
      return { hh, hl };
    }

    return {
      onPivot(p, gen, ctx) {
        const t = tracks[gen]; if (!t) return;
        if (p.kind === 'H') { t.prevH = t.lastH; t.lastH = p; t.pendingH = p; }
        else { t.prevL = t.lastL; t.lastL = p; t.pendingL = p; }
      },
      onBar(bar, f, ctx) {
        const atr = f.atr; if (!Number.isFinite(atr) || atr <= 0) return;
        const eps = P.epsAtr * atr;
        const bars = ctx.bars;
        // Donchian channels of the PRIOR N bars (exclude the current bar)
        const dc = {};
        for (const N of P.donchianN) {
          if (bars.length < N + 1) continue;
          const e = extremes(bars, N, 1);
          const M = P.donchianExit[N] || Math.round(N / 2);
          const ex = extremes(bars, M, 1);
          dc[N] = { hi: e.hi, lo: e.lo, hiBar: e.hiBar, loBar: e.loBar, exitLo: ex.lo, exitHi: ex.hi };
        }
        const dcUp = P.donchianN.filter((N) => dc[N] && bar.close > dc[N].hi);
        const dcDn = P.donchianN.filter((N) => dc[N] && bar.close < dc[N].lo);

        // --- swing structure per track
        for (const gen of ['fractal', 'zigzag']) {
          const t = tracks[gen];
          const structure = gen === 'fractal' ? 'internal' : 'swing';
          // up-break
          if (t.pendingH && bar.close > t.pendingH.price + eps) {
            const broken = t.pendingH; t.pendingH = null;
            const legStart = t.lastL && t.lastL.ts !== broken.ts ? t.lastL : null;
            const isBos = t.trend === 1;
            const prevTrend = t.trend; t.trend = 1;
            let inv = legStart ? legStart.price : NaN;
            if (!(broken.price - inv >= P.minLegAtr * atr)) inv = broken.price - Math.max(P.minLegAtr * atr, atrFloor(1, atr));
            const leg = broken.price - inv;
            const lbl = structureLabel(t);
            const anchors = sortAnchors([pivotAnchor('brokenSwing', broken), legStart ? pivotAnchor('legStart', legStart) : null, barAnchor('breakBar', bar)]);
            const legBars = legStart ? Math.round((bar.ts - legStart.ts) / (ctx.tfMin * 60000)) : null;
            const tags = ['smc_bos_choch', 'brk_breakout', isBos ? 'smc_bos' : 'smc_choch'];
            if (dcUp.length) tags.push('donchian');
            if (gen === 'zigzag') tags.push('smc_swing_structure'); else tags.push('smc_internal_structure');
            if (!isBos) tags.push('vic_123_point3', 'dow_trend_change');
            ctx.emit({
              patternId: isBos ? 'bos-up' : 'choch-up', family: 'structure', key: `${gen}:${broken.ts}`, state: 'forming', direction: 'up',
              levels: { trigger: broken.price, triggerSide: 'above', invalidation: inv, target: broken.price + leg, extra: { legRange: leg } },
              anchors,
              geometry: { gen, structure, prevTrend, impulseAtr: leg / atr, legBars, heightAtr: leg / atr, breakCloseAtr: (bar.close - broken.price) / atr,
                hh: lbl.hh, hl: lbl.hl, donchianN: dcUp.length ? dcUp : null, tags, params: { fractalK: gen === 'fractal' ? broken.k : undefined, theta: gen === 'zigzag' ? broken.theta : undefined } },
            });
          }
          // down-break
          if (t.pendingL && bar.close < t.pendingL.price - eps) {
            const broken = t.pendingL; t.pendingL = null;
            const legStart = t.lastH && t.lastH.ts !== broken.ts ? t.lastH : null;
            const isBos = t.trend === -1;
            const prevTrend = t.trend; t.trend = -1;
            let inv = legStart ? legStart.price : NaN;
            if (!(inv - broken.price >= P.minLegAtr * atr)) inv = broken.price + Math.max(P.minLegAtr * atr, atrFloor(1, atr));
            const leg = inv - broken.price;
            const lbl = structureLabel(t);
            const anchors = sortAnchors([pivotAnchor('brokenSwing', broken), legStart ? pivotAnchor('legStart', legStart) : null, barAnchor('breakBar', bar)]);
            const legBars = legStart ? Math.round((bar.ts - legStart.ts) / (ctx.tfMin * 60000)) : null;
            const tags = ['smc_bos_choch', 'brk_breakout', isBos ? 'smc_bos' : 'smc_choch'];
            if (dcDn.length) tags.push('donchian');
            if (gen === 'zigzag') tags.push('smc_swing_structure'); else tags.push('smc_internal_structure');
            if (!isBos) tags.push('vic_123_point3', 'dow_trend_change');
            ctx.emit({
              patternId: isBos ? 'bos-down' : 'choch-down', family: 'structure', key: `${gen}:${broken.ts}`, state: 'forming', direction: 'down',
              levels: { trigger: broken.price, triggerSide: 'below', invalidation: inv, target: broken.price - leg, extra: { legRange: leg } },
              anchors,
              geometry: { gen, structure, prevTrend, impulseAtr: leg / atr, legBars, heightAtr: leg / atr, breakCloseAtr: (broken.price - bar.close) / atr,
                hh: lbl.hh, hl: lbl.hl, donchianN: dcDn.length ? dcDn : null, tags, params: { fractalK: gen === 'fractal' ? broken.k : undefined, theta: gen === 'zigzag' ? broken.theta : undefined } },
            });
          }
        }

        // --- Donchian breaks (fresh only)
        for (const N of P.donchianN) {
          const d = dc[N]; const st = dcState[N]; if (!d) continue;
          const up = bar.close > d.hi, dn = bar.close < d.lo;
          const height = d.hi - d.lo;
          if (up && !st.above) {
            ctx.emit({
              patternId: `donchian-${N}-up`, family: 'structure', key: String(bar.ts), state: 'forming', direction: 'up',
              levels: { trigger: d.hi, triggerSide: 'above', invalidation: d.exitLo, target: d.hi + height, extra: { channelLow: d.lo, channelHigh: d.hi } },
              anchors: sortAnchors([barAnchor('channelHigh', d.hiBar, d.hiBar.high), barAnchor('breakBar', bar)]),
              geometry: { N, heightAtr: height / atr, breakCloseAtr: (bar.close - d.hi) / atr, channelAgeBars: Math.round((bar.ts - d.hiBar.ts) / (ctx.tfMin * 60000)),
                tags: ['donchian', 'brk_breakout', 'turtle_entry', N === 20 ? 'darvas_like' : 'donchian_55'], params: { N, exitM: P.donchianExit[N] } },
            });
          }
          if (dn && !st.below) {
            ctx.emit({
              patternId: `donchian-${N}-down`, family: 'structure', key: String(bar.ts), state: 'forming', direction: 'down',
              levels: { trigger: d.lo, triggerSide: 'below', invalidation: d.exitHi, target: d.lo - height, extra: { channelLow: d.lo, channelHigh: d.hi } },
              anchors: sortAnchors([barAnchor('channelLow', d.loBar, d.loBar.low), barAnchor('breakBar', bar)]),
              geometry: { N, heightAtr: height / atr, breakCloseAtr: (d.lo - bar.close) / atr, channelAgeBars: Math.round((bar.ts - d.loBar.ts) / (ctx.tfMin * 60000)),
                tags: ['donchian', 'brk_breakout', 'turtle_entry', N === 20 ? 'darvas_like' : 'donchian_55'], params: { N, exitM: P.donchianExit[N] } },
            });
          }
          st.above = up; st.below = dn;
        }
      },
    };
  },
};
