/**
 * P11 session_range — opening ranges / initial balance, emitted ONLY on tf === params.emitTf (default '1m'; the
 * engine passes no tf list to detectors, so the same session event on 8 tfs would be 8 duplicates — set
 * `emitTf` to the smallest tf you run).
 *  orb-5 / orb-15 / orb-30 / orb-60 (= Market Profile IB) from 09:30 ET; globex-orb-30 from 18:00 ET.
 *  Emitted bilateral at the close of the last bar of the window (or, if that bar is missing, at the close of the
 *  first bar after the window): upper/lower = range, targetUp/Down = ± height (extra: 2× targets), midline.
 *  ib-extension-up|down: first close beyond the IB after 10:30 (directional; trigger = IB boundary, invalidation =
 *  IB midpoint, target = boundary ± IB height); once per side per session.
 * geometry: rangeAtr, rangeVsMedian (vs trailing 20 sessions, same window), orDir (sign of window close − open),
 * tags: orb, mp_initial_balance, crabel_stretch, brk_trend_from_open (+ smc_po3_accumulation).
 */
import { RTH_OPEN_MIN, GLOBEX_OPEN_MIN, barAnchor, sortAnchors } from './_common.js';
import { etMinuteOfDay } from '../../time.js';
import { Ring } from '../../features.js';

const WINDOWS = [
  { id: 'orb-5', startMin: RTH_OPEN_MIN, W: 5, tags: ['orb', 'orb_5', 'zarattini_orb', 'crabel_stretch'] },
  { id: 'orb-15', startMin: RTH_OPEN_MIN, W: 15, tags: ['orb', 'orb_15', 'crabel_stretch', 'brk_trend_from_open'] },
  { id: 'orb-30', startMin: RTH_OPEN_MIN, W: 30, tags: ['orb', 'orb_30', 'brk_trend_from_open'] },
  { id: 'orb-60', startMin: RTH_OPEN_MIN, W: 60, tags: ['orb', 'orb_60', 'mp_initial_balance', 'brk_trend_from_open'] },
  { id: 'globex-orb-30', startMin: GLOBEX_OPEN_MIN, W: 30, tags: ['orb', 'globex_orb_30', 'smc_po3_accumulation'] },
];

export default {
  id: 'session-range', family: 'event',
  params: { emitTf: '1m', medianSessions: 20 },
  create({ params: P, tf, tfMin }) {
    const active = tf === P.emitTf;
    const hist = new Map(WINDOWS.map((w) => [w.id, new Ring(P.medianSessions)]));
    let ss = null;                       // current session ssUtc
    let ranges = null;                   // id -> { high, low, hiBar, loBar, openBar, lastBar, n, done }
    let ib = null, ibExt = { up: false, down: false };
    return {
      onBar(bar, f, ctx) {
        if (!active) return;
        if (bar.ssUtc !== ss) { ss = bar.ssUtc; ranges = new Map(); ib = null; ibExt = { up: false, down: false }; }
        const atr = f.atr; if (!Number.isFinite(atr) || atr <= 0) return;
        const m = etMinuteOfDay(bar.ts), endM = m + tfMin;
        for (const w of WINDOWS) {
          const inWin = m >= w.startMin && m < w.startMin + w.W;
          let r = ranges.get(w.id);
          if (inWin) {
            if (!r) { r = { high: bar.high, low: bar.low, hiBar: bar, loBar: bar, openBar: bar, lastBar: bar, n: 1, done: false }; ranges.set(w.id, r); }
            else { if (bar.high > r.high) { r.high = bar.high; r.hiBar = bar; } if (bar.low < r.low) { r.low = bar.low; r.loBar = bar; } r.n++; r.lastBar = bar; }
          }
          const complete = r && !r.done && ((inWin && endM >= w.startMin + w.W) || (!inWin && m >= w.startMin + w.W && m < w.startMin + w.W + 120));
          if (!complete) continue;
          r.done = true;
          const h = r.high - r.low;
          const ring = hist.get(w.id);
          const med = ring.len >= 5 ? ring.median() : NaN;
          ring.push(h);
          const orDir = Math.sign(r.lastBar.close - r.openBar.open);
          const anchors = sortAnchors([barAnchor('open', r.openBar, r.openBar.open), barAnchor('rangeHigh', r.hiBar, r.hiBar.high), barAnchor('rangeLow', r.loBar, r.loBar.low), barAnchor('rangeEnd', r.lastBar)]);
          ctx.emit({
            patternId: w.id, family: 'event', key: String(bar.ssUtc), state: 'forming', direction: 'bilateral',
            levels: { upper: r.high, lower: r.low, targetUp: r.high + h, targetDown: r.low - h, midline: (r.high + r.low) / 2,
              extra: { target2Up: r.high + 2 * h, target2Down: r.low - 2 * h, open: r.openBar.open } },
            anchors,
            geometry: { durationBars: r.n, heightAtr: h / atr, rangeAtr: h / atr, rangeVsMedian: Number.isFinite(med) && med > 0 ? h / med : null, orDir,
              closePos: h > 0 ? (r.lastBar.close - r.low) / h : 0.5, windowMin: w.W, tags: w.tags, params: { W: w.W, startMin: w.startMin } },
          });
          if (w.id === 'orb-60') ib = r;
        }
        // IB extension (after 10:30, RTH only)
        if (ib && ib.done && m >= RTH_OPEN_MIN + 60 && m < 16 * 60) {
          const h = ib.high - ib.low;
          if (!ibExt.up && bar.close > ib.high) {
            ibExt.up = true;
            ctx.emit({
              patternId: 'ib-extension-up', family: 'event', key: String(bar.ssUtc), state: 'forming', direction: 'up',
              levels: { trigger: ib.high, triggerSide: 'above', invalidation: (ib.high + ib.low) / 2, target: ib.high + h, target2: ib.high + 2 * h, extra: { ibHigh: ib.high, ibLow: ib.low } },
              anchors: sortAnchors([barAnchor('ibHigh', ib.hiBar, ib.high), barAnchor('ibLow', ib.loBar, ib.low), barAnchor('breakBar', bar)]),
              geometry: { heightAtr: h / atr, ibAtr: h / atr, minutesAfterIb: m - (RTH_OPEN_MIN + 60), breakCloseAtr: (bar.close - ib.high) / atr,
                tags: ['mp_initial_balance', 'mp_range_extension', 'orb', 'brk_breakout', 'brk_trend_from_open'], params: { W: 60 } },
            });
          }
          if (!ibExt.down && bar.close < ib.low) {
            ibExt.down = true;
            ctx.emit({
              patternId: 'ib-extension-down', family: 'event', key: String(bar.ssUtc), state: 'forming', direction: 'down',
              levels: { trigger: ib.low, triggerSide: 'below', invalidation: (ib.high + ib.low) / 2, target: ib.low - h, target2: ib.low - 2 * h, extra: { ibHigh: ib.high, ibLow: ib.low } },
              anchors: sortAnchors([barAnchor('ibHigh', ib.hiBar, ib.high), barAnchor('ibLow', ib.loBar, ib.low), barAnchor('breakBar', bar)]),
              geometry: { heightAtr: h / atr, ibAtr: h / atr, minutesAfterIb: m - (RTH_OPEN_MIN + 60), breakCloseAtr: (ib.low - bar.close) / atr,
                tags: ['mp_initial_balance', 'mp_range_extension', 'orb', 'brk_breakout', 'brk_trend_from_open'], params: { W: 60 } },
            });
          }
        }
      },
    };
  },
};
