/** fvg-bear as a parameterized, reusable run (cache loaded once by the caller). */
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';

export const FVG_DEFAULTS = {
  maxOrders: 4, level: 'top',        // 'top' | 'ce' | 'bottom'
  slopeFilter: true, minGapAtr: 0.15, autoThr: true,
  stopAtr: 1.5, targetAtr: 0, timeCapMin: 240, workMin: 900,
  cancelOnCloseBeyond: true, replaceOldest: false, side: 'bear',
};

export function runFvg(C, cfg = {}, from = 0, to = C.n) {
  const p = { ...FVG_DEFAULTS, ...cfg };
  const tickValue = C.meta.product === 'NQ' ? 5.0 : 12.5;
  const core = new TickCore({ cache: C, timeframes: ['1m', '15m'], watchCapacity: 4 * p.maxOrders + 512 });
  const broker = new TickBroker({ core, tickValue, commissionRT: 5.0, slipStopTicks: 2, slipMktTicks: 1,
                                  maxConcurrentOrders: p.maxOrders });
  const tf15 = core.tf('15m'), tf1 = core.tf('1m');
  const H3 = [], gapHist = [], working = new Map();
  const bear = p.side === 'bear';
  let nSignals = 0;

  const onFifteen = () => {
    H3.push({ h: tf15.closedH, l: tf15.closedL }); if (H3.length > 3) H3.shift();
    if (H3.length < 3 || tf15.count < 20) return;
    const a = H3[0], c = H3[2];
    const isGap = bear ? a.l > c.h : a.h < c.l;
    if (!isGap) return;
    const gap = bear ? a.l - c.h : c.l - a.h;
    gapHist.push(gap); if (gapHist.length > 100) gapHist.shift();
    const atr = tf15.atr || 1;
    const auto = p.autoThr && gapHist.length >= 20 ? 0.5 * (gapHist.reduce((x, y) => x + y, 0) / gapHist.length) : 0;
    if (gap < Math.max(2, p.minGapAtr * atr, auto)) return;
    const slope = (tf15.ema - tf15.emaPrev) / atr;
    if (p.slopeFilter && (bear ? !(slope <= 0) : !(slope >= 0))) return;
    const top = bear ? a.l : c.l, bot = bear ? c.h : a.h;      // gap edges (top >= bot)
    const px = p.level === 'top' ? top : p.level === 'bottom' ? bot : Math.round((top + bot) / 2);
    const entryPx = bear ? px : px;                             // bear sells into the gap from below; bull buys into it
    const inval = bear ? top + Math.round(0.25 * atr) : bot - Math.round(0.25 * atr);
    const cancelBeyond = bear ? inval + Math.round(0.1 * atr) : inval - Math.round(0.1 * atr);
    nSignals++;
    if (p.replaceOldest && broker.orders.size >= p.maxOrders) {
      const oldest = broker.orders.keys().next().value; broker.cancel(oldest, 'replaced'); working.delete(oldest);
    }
    const id = broker.place({
      kind: 'limit', side: bear ? -1 : 1, price: entryPx, resting: true,
      stopTicks: Math.round(p.stopAtr * atr),
      targetTicks: p.targetAtr ? Math.round(p.targetAtr * atr) : undefined,
      maxHoldSec: p.timeCapMin * 60, expirySec: p.workMin * 60, group: 'fvg', tag: null,
    });
    if (id) working.set(id, cancelBeyond);
  };
  const onMinute = () => {
    if (!p.cancelOnCloseBeyond || !working.size) return;
    const cl = tf1.closedC;
    for (const [id, cb] of working) {
      if (!broker.orders.has(id)) { working.delete(id); continue; }
      if (bear ? cl > cb : cl < cb) { broker.cancel(id, 'gap-inversion'); working.delete(id); }
    }
  };
  core.run(from, to, {
    onBarClose: (f) => { if (f.tf === '15m') onFifteen(); else onMinute(); },
    onTick: () => broker.onTick(),
    onArm: (meta, lvl) => broker.onArm(meta, lvl),
    onRoll: () => { broker.cancelAll('roll'); working.clear(); },
  });
  return { summary: broker.summary(), trades: broker.trades, nSignals, cfg: p };
}
