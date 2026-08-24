/**
 * P7 sweep_reversal — price violates a reference level by depth d ∈ [1 tick, maxDepthAtr·ATR] and CLOSES back
 * inside within k ≤ 3 bars (turtle-soup spec; catalog 03 §5 smc_liquidity_sweep, §7 equivalence row 1).
 *
 * Reference levels (each is a separate "arm" → one event per level type, geometry.levelType):
 *   pdh/pdl        previous-session high/low (tf-bar based, ts-anchored)
 *   sessHigh/Low   current-session extreme EXCLUDING the current bar, only ≥ minSessionMin minutes into the session
 *   orHigh/orLow   RTH opening-range (first 30 min) extremes once formed (tf ≤ 30m)
 *   dc20High/Low   highest high / lowest low of the prior N=20 bars, extreme ≥ minAgeBars old (Raschke "old low")
 *   zzH/zzL        last confirmed zigzag pivot of the same kind
 *   eqh/eql        two consecutive zigzag majors of one kind within eqTolAtr·ATR (level = the more extreme)
 *   pdc            prior RTH close (Williams Oops! reading; falls back to prior session close)
 * State machine per level: excursion starts on the first bar whose extreme violates the level after ≥ minInsideBars
 * consecutive closes inside (approach from the inside — a reclaim from the far side is not a sweep); ends on the first bar closing back inside (emit) or after k bars / depth > max (abort = real
 * breakout, no event). Levels are frozen at excursion start.
 * Emission (sweep-high → direction down): trigger = lowest low of the excursion bars (Brooks / turtle-soup entry),
 * invalidation = sweep extreme, target = opposite side of the last N=20 range (floored at 2× risk).
 */
import { TICK, barAnchor, pivotAnchor, sortAnchors, extremes, SessionState } from './_common.js';

const LEVEL_TAGS = {
  pdh: ['smc_session_raid', 'smc_pdh_pdl'], pdl: ['smc_session_raid', 'smc_pdh_pdl'],
  sessHigh: ['smc_session_raid'], sessLow: ['smc_session_raid'],
  orHigh: ['orb_failed', 'brk_opening_reversal', 'volman_false_break'], orLow: ['orb_failed', 'brk_opening_reversal', 'volman_false_break'],
  dc20High: ['raschke_turtle_soup', 'donchian_fade'], dc20Low: ['raschke_turtle_soup', 'donchian_fade'],
  zzH: ['smc_swing_sweep', 'vic_2b'], zzL: ['smc_swing_sweep', 'vic_2b'],
  eqh: ['smc_liquidity_pools', 'eqh'], eql: ['smc_liquidity_pools', 'eql'],
  pdc: ['lw_oops', 'gap_reclaim'],
};

export default {
  id: 'sweep-reversal', family: 'structure',
  params: { k: 3, maxDepthAtr: 1.0, minDepthTicks: 1, dcN: 20, minAgeBars: 4, minSessionMin: 60, eqTolAtr: 0.1, rangeN: 20, minSessAgeBars: 3, minInsideBars: 3 },
  create({ params: P, tfMin }) {
    const ss = new SessionState(tfMin);
    // per level id: { inside: bool|null, exc: null | { level, startBar, startIdx, extreme, extBar, lo, hi, n, anchor, ageBars, type } }
    const st = new Map();
    const getSt = (id) => { let s = st.get(id); if (!s) { s = { inside: null, insideN: 0, exc: null }; st.set(id, s); } return s; };

    /** enumerate reference levels as of the bar BEFORE `bar` (all frozen at excursion start) */
    function levels(bar, f, ctx) {
      const out = [];
      const tfMs = ctx.tfMin * 60000;
      const age = (b) => b ? Math.round((bar.ts - b.ts) / tfMs) : null;
      if (ss.prev) {
        out.push({ id: 'pdh', side: 'H', type: 'pdh', price: ss.prev.high, anchor: barAnchor('level', ss.prev.hiBar, ss.prev.high), ageBars: age(ss.prev.hiBar) });
        out.push({ id: 'pdl', side: 'L', type: 'pdl', price: ss.prev.low, anchor: barAnchor('level', ss.prev.loBar, ss.prev.low), ageBars: age(ss.prev.loBar) });
      }
      const cb = ss.curBefore;
      if (cb && (bar.mos ?? 0) >= P.minSessionMin && cb.n >= P.minSessAgeBars) {
        out.push({ id: 'sessHigh', side: 'H', type: 'sessHigh', price: cb.high, anchor: barAnchor('level', cb.hiBar, cb.high), ageBars: age(cb.hiBar) });
        out.push({ id: 'sessLow', side: 'L', type: 'sessLow', price: cb.low, anchor: barAnchor('level', cb.loBar, cb.low), ageBars: age(cb.loBar) });
      }
      const or = ss.or30;
      if (or && or.formed && bar.closeTs > or.formedAt) {
        out.push({ id: 'orHigh', side: 'H', type: 'orHigh', price: or.high, anchor: barAnchor('level', or.hiBar, or.high), ageBars: age(or.hiBar) });
        out.push({ id: 'orLow', side: 'L', type: 'orLow', price: or.low, anchor: barAnchor('level', or.loBar, or.low), ageBars: age(or.loBar) });
      }
      if (ctx.bars.length > P.dcN) {
        const e = extremes(ctx.bars, P.dcN, 1);
        const ah = age(e.hiBar), al = age(e.loBar);
        if (ah >= P.minAgeBars) out.push({ id: 'dc20High', side: 'H', type: 'dc20High', price: e.hi, anchor: barAnchor('level', e.hiBar, e.hi), ageBars: ah });
        if (al >= P.minAgeBars) out.push({ id: 'dc20Low', side: 'L', type: 'dc20Low', price: e.lo, anchor: barAnchor('level', e.loBar, e.lo), ageBars: al });
      }
      const zz = ctx.pivots.zigzag.last(3);      // ≤ 3 majors, alternating
      let lastH = null, lastL = null, prevH = null, prevL = null;
      for (let i = zz.length - 1; i >= 0; i--) { const p = zz[i]; if (p.kind === 'H') { if (!lastH) lastH = p; else if (!prevH) prevH = p; } else { if (!lastL) lastL = p; else if (!prevL) prevL = p; } }
      if (lastH && lastH.ts < bar.ts) out.push({ id: 'zzH', side: 'H', type: 'zzH', price: lastH.price, anchor: pivotAnchor('level', lastH), ageBars: age(lastH) });
      if (lastL && lastL.ts < bar.ts) out.push({ id: 'zzL', side: 'L', type: 'zzL', price: lastL.price, anchor: pivotAnchor('level', lastL), ageBars: age(lastL) });
      const eqTol = P.eqTolAtr * f.atr;
      if (lastH && prevH && Math.abs(lastH.price - prevH.price) <= eqTol) out.push({ id: 'eqh', side: 'H', type: 'eqh', price: Math.max(lastH.price, prevH.price), anchor: pivotAnchor('level', lastH.price >= prevH.price ? lastH : prevH), anchor2: pivotAnchor('level2', lastH.price >= prevH.price ? prevH : lastH), ageBars: age(lastH) });
      if (lastL && prevL && Math.abs(lastL.price - prevL.price) <= eqTol) out.push({ id: 'eql', side: 'L', type: 'eql', price: Math.min(lastL.price, prevL.price), anchor: pivotAnchor('level', lastL.price <= prevL.price ? lastL : prevL), anchor2: pivotAnchor('level2', lastL.price <= prevL.price ? prevL : lastL), ageBars: age(lastL) });
      const pcb = ss.prevRthCloseBar || ss.prevSessionCloseBar;
      if (pcb) {
        out.push({ id: 'pdcH', side: 'H', type: 'pdc', price: pcb.close, anchor: barAnchor('level', pcb, pcb.close), ageBars: age(pcb) });
        out.push({ id: 'pdcL', side: 'L', type: 'pdc', price: pcb.close, anchor: barAnchor('level', pcb, pcb.close), ageBars: age(pcb) });
      }
      return out;
    }

    return {
      onBar(bar, f, ctx) {
        ss.update(bar);
        const atr = f.atr; if (!Number.isFinite(atr) || atr <= 0) return;
        const lv = levels(bar, f, ctx);
        const seen = new Set();
        const emitted = { H: [], L: [] };
        for (const L of lv) {
          seen.add(L.id);
          const s = getSt(L.id);
          const isH = L.side === 'H';
          const violates = isH ? bar.high > L.price : bar.low < L.price;
          const closeInside = isH ? bar.close <= L.price : bar.close >= L.price;
          if (s.exc) {
            // ongoing excursion against the frozen level
            const e = s.exc; e.n++;
            if (isH) { if (bar.high > e.extreme) { e.extreme = bar.high; e.extBar = bar; } if (bar.low < e.lo) e.lo = bar.low; }
            else { if (bar.low < e.extreme) { e.extreme = bar.low; e.extBar = bar; } if (bar.high > e.hi) e.hi = bar.high; }
            const depth = isH ? e.extreme - e.level : e.level - e.extreme;
            const back = isH ? bar.close <= e.level : bar.close >= e.level;
            if (depth > P.maxDepthAtr * atr || e.n > P.k) { s.exc = null; }           // real breakout / too deep → not a sweep
            else if (back) { emitted[L.side].push({ e, L }); s.exc = null; }
          } else if (violates && s.inside === true && s.insideN >= P.minInsideBars) {
            const e = { level: L.price, type: L.type, anchor: L.anchor, anchor2: L.anchor2, ageBars: L.ageBars, startBar: bar, n: 1,
              extreme: isH ? bar.high : bar.low, extBar: bar, lo: bar.low, hi: bar.high };
            const depth = isH ? e.extreme - e.level : e.level - e.extreme;
            if (depth >= P.minDepthTicks * TICK && depth <= P.maxDepthAtr * atr) {
              if (closeInside) emitted[L.side].push({ e, L });                        // single-bar sweep
              else s.exc = e;
            }
          }
          // inside/outside state vs the CURRENT level (level may have moved); insideN = consecutive inside closes
          s.inside = closeInside; s.insideN = closeInside ? s.insideN + 1 : 0;
        }
        for (const id of st.keys()) if (!seen.has(id)) st.delete(id);               // level vanished (session roll etc.)
        // emit
        for (const side of ['H', 'L']) {
          const list = emitted[side]; if (!list.length) continue;
          const isH = side === 'H';
          const rng = extremes(ctx.bars, P.rangeN, 0);
          for (const { e, L } of list) {
            const depth = isH ? e.extreme - e.level : e.level - e.extreme;
            const trigger = isH ? e.lo : e.hi;
            const inv = e.extreme;
            const risk = Math.abs(inv - trigger);
            let target = isH ? rng.lo : rng.hi;
            if (isH ? target > trigger - 2 * risk : target < trigger + 2 * risk) target = isH ? trigger - 2 * risk : trigger + 2 * risk;
            const priorMove = isH ? (e.extreme - rng.lo) / atr : (rng.hi - e.extreme) / atr;
            const tags = [...new Set(['smc_liquidity_sweep', 'raschke_turtle_soup', isH ? 'wy_upthrust' : 'wy_spring', 'brk_failed_breakout', 'vic_2b', 'grimes_failure_test', isH ? 'bull_trap' : 'bear_trap', ...(LEVEL_TAGS[e.type] || [])])];
            const anchors = sortAnchors([e.anchor, e.anchor2, barAnchor('sweepBar', e.startBar, isH ? e.startBar.high : e.startBar.low),
              e.extBar !== e.startBar ? barAnchor('sweepExtreme', e.extBar, e.extreme) : null, barAnchor('reclaim', bar)]);
            ctx.emit({
              patternId: isH ? 'sweep-reversal-high' : 'sweep-reversal-low', family: 'structure', key: `${e.startBar.ts}:${e.type}`, state: 'forming', direction: isH ? 'down' : 'up',
              levels: { trigger, triggerSide: isH ? 'below' : 'above', invalidation: inv, target, target2: isH ? trigger - risk : trigger + risk, extra: { level: e.level, sweepExtreme: e.extreme } },
              anchors,
              geometry: { levelType: e.type, depthAtr: depth / atr, depthTicks: depth / TICK, barsOutside: e.n, levelAgeBars: e.ageBars, priorMoveAtr: priorMove,
                riskAtr: risk / atr, heightAtr: risk / atr, durationBars: e.n, nLevelsSwept: list.length, reclaimCloseAtr: (isH ? e.level - bar.close : bar.close - e.level) / atr,
                relVol: f.relVol, rangeRel: f.rangeRel, tags, params: { k: P.k, maxDepthAtr: P.maxDepthAtr, dcN: P.dcN, eqTolAtr: P.eqTolAtr, minInsideBars: P.minInsideBars } },
            });
          }
        }
      },
    };
  },
};
