/**
 * P12 gap_event — session gaps on futures (emitted ONLY on tf === params.emitTf, default '1m'):
 *  (a) Globex open (first bar of the 18:00 ET session) vs the prior session's last close (17:00) → `gap-open-up|down`
 *  (b) RTH open (09:30 bar) vs the prior RTH close (last bar < 16:00 of the previous session) → `gap-up|down`
 * Emitted at the close of the open bar when |gap| ≥ max(minTicks·tick, minGapAtr·ATR).
 * direction = FILL direction (mean-reversion reading; the continuation reading is the 'gap_and_go' tag):
 *   gap-up: trigger = open bar low (below), invalidation = open + 0.5·gap (above), target = prior close (full fill),
 *   target2 = open − 0.5·gap (half fill).  Mirrored for gap-down.
 * geometry: gapPts, gapAtr, gapVsPrevRange (gap / prior-session range), openBarRangeAtr, openBarDir,
 * tags: gap_fill, lw_oops, smc_ndog (RTH: also 'rth_gap'; Globex: 'globex_gap', 'weekend_gap' on Sunday), gap_and_go.
 */
import { TICK, RTH_OPEN_MIN, barAnchor, sortAnchors, SessionState } from './_common.js';
import { etMinuteOfDay, tradeDow } from '../../time.js';

export default {
  id: 'gap-event', family: 'event',
  params: { emitTf: '1m', minGapAtr: 0.25, minTicks: 4, invGapFrac: 0.5 },
  create({ params: P, tf, tfMin }) {
    const active = tf === P.emitTf;
    const ss = new SessionState(tfMin);
    let lastSs = null, rthDone = null;
    function emitGap(kind, bar, prevBar, refClose, f, ctx, atr, extraTags) {
      const gap = bar.open - refClose;
      const thr = Math.max(P.minTicks * TICK, P.minGapAtr * atr);
      if (!(Math.abs(gap) >= thr)) return;
      const up = gap > 0;                                        // gap-up → fill direction is DOWN
      const pid = kind === 'rth' ? (up ? 'gap-up' : 'gap-down') : (up ? 'gap-open-up' : 'gap-open-down');
      const trigger = up ? bar.low : bar.high;
      const inv = bar.open + P.invGapFrac * gap;   // gap is signed → beyond the open (in the gap direction) by half the gap
      const prevRange = ss.prev ? ss.prev.high - ss.prev.low : NaN;
      ctx.emit({
        patternId: pid, family: 'event', key: String(bar.ts), state: 'forming', direction: up ? 'down' : 'up',
        levels: { trigger, triggerSide: up ? 'below' : 'above', invalidation: inv, target: refClose, target2: bar.open - 0.5 * gap,
          extra: { open: bar.open, prevClose: refClose, halfFill: bar.open - 0.5 * gap } },
        anchors: sortAnchors([barAnchor('prevClose', prevBar, refClose), barAnchor('open', bar, bar.open)]),
        geometry: { gapPts: gap, gapAtr: gap / atr, absGapAtr: Math.abs(gap) / atr, gapVsPrevRange: Number.isFinite(prevRange) && prevRange > 0 ? Math.abs(gap) / prevRange : null,
          openBarRangeAtr: (bar.high - bar.low) / atr, openBarDir: f.dir, openBarClv: f.clv, relVol: f.relVol, heightAtr: Math.abs(gap) / atr,
          tags: ['gap_fill', 'lw_oops', 'smc_ndog', 'gap_and_go', ...extraTags], params: { minGapAtr: P.minGapAtr, invGapFrac: P.invGapFrac } },
      });
    }
    return {
      onBar(bar, f, ctx) {
        ss.update(bar);
        if (!active) return;
        const atr = f.atr; if (!Number.isFinite(atr) || atr <= 0) return;
        // (a) Globex open: first bar of a new session
        if (bar.ssUtc !== lastSs) {
          const wasFirst = lastSs != null;
          lastSs = bar.ssUtc; rthDone = null;
          const pb = ss.prevSessionCloseBar;
          if (wasFirst && pb) {
            const dow = tradeDow(bar.ts);
            const gapHours = (bar.ts - pb.ts) / 3600000;
            emitGap('globex', bar, pb, pb.close, f, ctx, atr, ['globex_gap', ...(gapHours > 20 ? ['weekend_gap'] : []), 'dow_' + dow]);
          }
          return;
        }
        // (b) RTH open: first bar at/after 09:30 of this session
        const m = etMinuteOfDay(bar.ts);
        if (rthDone !== bar.ssUtc && m >= RTH_OPEN_MIN && m < RTH_OPEN_MIN + 5) {
          rthDone = bar.ssUtc;
          const pb = ss.prevRthCloseBar;
          if (pb) emitGap('rth', bar, pb, pb.close, f, ctx, atr, ['rth_gap', 'dow_' + tradeDow(bar.ts)]);
        }
      },
    };
  },
};
