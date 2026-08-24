/**
 * P8 breakout_retest — after a close-based breakout of a level L in direction D (tracked internally: last confirmed
 * zigzag / fractal pivot of the opposite kind, Donchian-20 prior extreme, previous-session high/low, RTH OR30 /
 * IB extremes), the FIRST pullback within ≤ maxBars that touches back to within tolAtr·ATR of L WITHOUT closing
 * beyond it → `breakout-retest-up|down` at the close of the touch bar.
 *   trigger = high (up) / low (down) of the touch bar (resumption), invalidation = L ∓ 0.5·ATR (close through),
 *   target = L ± impulse (impulse = distance from L to the opposite extreme of the prior N=20 bars at breakout).
 * Breakouts whose levels lie within mergeAtr·ATR of a pending same-direction breakout are merged (levelTypes[]).
 * A close back through L before the touch (failed breakout) drops the pending breakout (that is P7's job).
 * Tags: brk_breakout_pullback, wy_lps, smc_ob_retest, ross_hook, grimes_simple_pullback (+ per level type).
 */
import { barAnchor, pivotAnchor, sortAnchors, extremes, SessionState } from './_common.js';

export default {
  id: 'breakout-retest', family: 'structure',
  params: { tolAtr: 0.25, invAtr: 0.5, maxBars: 20, minAwayBars: 1, dcN: 20, impulseN: 20, mergeAtr: 0.25, maxPending: 12 },
  create({ params: P, tfMin }) {
    const ss = new SessionState(tfMin);
    const pending = [];        // { L, dir, types:[], breakBar, breakIdx, impulse, anchor, maxExc, n }
    let lastClose = NaN;

    function candidateLevels(bar, ctx) {
      const out = [];
      const zz = ctx.pivots.zigzag.last(2), fr = ctx.pivots.fractal.last(2);
      for (const p of zz) if (p.ts < bar.ts) out.push({ type: p.kind === 'H' ? 'zzH' : 'zzL', side: p.kind, price: p.price, anchor: pivotAnchor('level', p) });
      for (const p of fr) if (p.ts < bar.ts) out.push({ type: p.kind === 'H' ? 'frH' : 'frL', side: p.kind, price: p.price, anchor: pivotAnchor('level', p) });
      if (ctx.bars.length > P.dcN) {
        const e = extremes(ctx.bars, P.dcN, 1);
        out.push({ type: 'dc20High', side: 'H', price: e.hi, anchor: barAnchor('level', e.hiBar, e.hi) });
        out.push({ type: 'dc20Low', side: 'L', price: e.lo, anchor: barAnchor('level', e.loBar, e.lo) });
      }
      if (ss.prev) {
        out.push({ type: 'pdh', side: 'H', price: ss.prev.high, anchor: barAnchor('level', ss.prev.hiBar, ss.prev.high) });
        out.push({ type: 'pdl', side: 'L', price: ss.prev.low, anchor: barAnchor('level', ss.prev.loBar, ss.prev.low) });
      }
      for (const [key, tname] of [['or30', 'or30'], ['ib', 'ib']]) {
        const r = ss[key];
        if (r && r.formed && bar.closeTs > r.formedAt) {
          out.push({ type: tname + 'High', side: 'H', price: r.high, anchor: barAnchor('level', r.hiBar, r.high) });
          out.push({ type: tname + 'Low', side: 'L', price: r.low, anchor: barAnchor('level', r.loBar, r.low) });
        }
      }
      return out;
    }

    return {
      onBar(bar, f, ctx) {
        ss.update(bar);
        const atr = f.atr; if (!Number.isFinite(atr) || atr <= 0) { lastClose = bar.close; return; }
        const tol = P.tolAtr * atr;
        // 1) advance pending breakouts (this bar is AFTER the breakout bar)
        for (let i = pending.length - 1; i >= 0; i--) {
          const b = pending[i]; b.n++;
          const up = b.dir === 'up';
          const exc = up ? bar.high - b.L : b.L - bar.low; if (exc > b.maxExc) b.maxExc = exc;
          const closedThrough = up ? bar.close < b.L : bar.close > b.L;
          if (closedThrough || b.n > P.maxBars) { pending.splice(i, 1); continue; }
          const touch = up ? bar.low <= b.L + tol : bar.high >= b.L - tol;
          if (touch && b.n >= P.minAwayBars) {
            const trigger = up ? bar.high : bar.low;
            const inv = up ? b.L - P.invAtr * atr : b.L + P.invAtr * atr;
            const target = up ? b.L + b.impulse : b.L - b.impulse;
            const depth = up ? b.L - bar.low : bar.high - b.L;      // + = pierced the level (≤ tol), − = held above
            const tags = ['brk_breakout_pullback', 'wy_lps', 'smc_ob_retest', 'ross_hook', 'grimes_simple_pullback', 'bulkowski_throwback', ...b.types.map((t) => 'lvl_' + t)];
            ctx.emit({
              patternId: up ? 'breakout-retest-up' : 'breakout-retest-down', family: 'structure', key: `${b.breakBar.ts}:${b.types[0]}`, state: 'forming', direction: b.dir,
              levels: { trigger, triggerSide: up ? 'above' : 'below', invalidation: inv, target, target2: up ? b.L + b.impulse * 0.5 : b.L - b.impulse * 0.5, extra: { level: b.L } },
              anchors: sortAnchors([b.anchor, barAnchor('breakBar', b.breakBar), barAnchor('touchBar', bar, up ? bar.low : bar.high)]),
              geometry: { levelType: b.types[0], levelTypes: b.types, barsSinceBreak: b.n, durationBars: b.n, impulseAtr: b.impulse / atr, heightAtr: b.impulse / atr,
                maxExcursionAtr: b.maxExc / atr, retraceDepthAtr: depth / atr, breakCloseAtr: b.breakCloseAtr, touchBarRangeAtr: (bar.high - bar.low) / atr,
                touchClosePos: (bar.high - bar.low) > 0 ? (bar.close - bar.low) / (bar.high - bar.low) : 0.5, relVol: f.relVol,
                tags, params: { tolAtr: P.tolAtr, invAtr: P.invAtr, maxBars: P.maxBars } },
            });
            pending.splice(i, 1);
          }
        }
        // 2) new breakouts on this bar's close (previous close was inside)
        if (Number.isFinite(lastClose)) {
          const cands = candidateLevels(bar, ctx);
          const rng = extremes(ctx.bars, P.impulseN, 1);
          for (const c of cands) {
            const up = c.side === 'H';
            const broke = up ? (bar.close > c.price && lastClose <= c.price) : (bar.close < c.price && lastClose >= c.price);
            if (!broke) continue;
            const dir = up ? 'up' : 'down';
            const dup = pending.find((b) => b.dir === dir && Math.abs(b.L - c.price) <= P.mergeAtr * atr);
            if (dup) { if (!dup.types.includes(c.type)) dup.types.push(c.type); continue; }
            const impulse = Math.max(up ? c.price - rng.lo : rng.hi - c.price, atr);
            pending.push({ L: c.price, dir, types: [c.type], breakBar: bar, n: 0, impulse, anchor: c.anchor, maxExc: up ? bar.high - c.price : c.price - bar.low,
              breakCloseAtr: (up ? bar.close - c.price : c.price - bar.close) / atr });
          }
          while (pending.length > P.maxPending) pending.shift();
        }
        lastClose = bar.close;
      },
    };
  },
};
