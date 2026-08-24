/**
 * LT-absorption short — the one candidate from the level-anatomy screen.
 *
 * Thesis (mechanistic): when price is AT an LT resistance level and contracts are changing hands at
 * unusually HIGH intensity (volume share ÷ time share > threshold), that is absorption — a seller
 * working size into buyers at the level — and price is lower 60 minutes later.
 * Screen result (NQ): top-vs-bottom intensity quintile spread −0.120 ATR dev, −0.099 val, −0.057
 * after controlling for where price sat in the window. Does NOT replicate on ES.
 *
 * Everything here is knowable at decision time: the LT level is taken at-or-before the window open,
 * the anatomy covers the window, and the order is placed at the window CLOSE.
 */
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';
import { loadLT, asOf } from './levels.js';
import { analyzeAroundLevel } from './zone-anatomy.js';

export const ABS_DEFAULTS = {
  band: 8, maxDistTicks: 40, winSec: 900,
  intMin: 1.196,   // dev top-quintile threshold (frozen)
  minTimeAt: 0.05,          // price must actually have been at the level
  side: 'short',            // short at resistance; 'long' mirrors at support
  mode: 'high',             // 'high' = trade the absorption tail; 'low' = trade the HOLLOW tail
  intMax: 0.828,            // dev BOTTOM-quintile threshold (frozen) — used when mode='low'
  entry: 'market',          // 'market' at the window close | 'limit' back at the level
  stopAtr: 1.0, targetAtr: 0, timeCapMin: 60, maxOrders: 2,
};

export function runAbsorb(C, cfg = {}, from = 0, to = C.n) {
  const p = { ...ABS_DEFAULTS, ...cfg };
  const short = p.side === 'short', dir = short ? -1 : 1;
  const TICK = C.meta.tickSize;
  const tickValue = C.meta.product === 'NQ' ? 5.0 : 12.5;
  const LT = loadLT(C.meta.product);
  const core = new TickCore({ cache: C, timeframes: ['15m'], watchCapacity: 256 });
  const broker = new TickBroker({ core, tickValue, commissionRT: 5.0, slipStopTicks: 2, slipMktTicks: 1,
                                  maxConcurrentOrders: p.maxOrders });
  const tf = core.tf('15m');
  let winStartRow = -1, winOpenTs = 0, nSig = 0, nEval = 0;
  const days = C.meta.days;

  core.run(from, to, {
    onTick: (c) => {
      if (winStartRow < 0) { winStartRow = c.row; winOpenTs = c.ts - (c.ts % p.winSec); }
      broker.onTick();
    },
    onBarClose: (f, c) => {
      if (f.tf !== '15m') return;
      const i0 = winStartRow, i1 = c.row + 1;
      winStartRow = c.row + 1;
      if (i0 < 0 || i1 - i0 < 60) return;
      const spot = C.o[i0], atr = f.atr || 1;
      const snap = asOf(LT, C.ts[i0], 3600);
      if (!snap) return;
      for (const px of snap.levels) {
        const L = Math.round(px / TICK);
        const dist = L - spot;
        if (short ? !(dist > 0 && dist <= p.maxDistTicks) : !(dist < 0 && -dist <= p.maxDistTicks)) continue;
        nEval++;
        const an = analyzeAroundLevel(C.l, C.h, C.v, C.ts, i0, i1, L, p.band, C.ts[i0], p.winSec);
        if (!an || an.intAt == null) continue;
        if (an.timeAt < p.minTimeAt) continue;
        if (p.mode === 'low' ? an.intAt > p.intMax : an.intAt < p.intMin) continue;
        nSig++;
        broker.place({
          kind: p.entry === 'limit' ? 'limit' : 'market', side: dir, resting: p.entry === 'limit',
          price: p.entry === 'limit' ? L : undefined,
          stopTicks: Math.round(p.stopAtr * atr),
          targetTicks: p.targetAtr ? Math.round(p.targetAtr * atr) : undefined,
          maxHoldSec: p.timeCapMin * 60, expirySec: 2 * p.winSec, group: 'abs',
        });
        break;                                             // one signal per window
      }
    },
    onArm: (m, l) => broker.onArm(m, l),
    onRoll: () => broker.cancelAll('roll'),
  });
  return { summary: broker.summary(), trades: broker.trades, nSig, nEval, cfg: p };
}
