/**
 * Opening-range breakout — the latency experiment.
 *
 * ORB is the ideal instrument for measuring what being slow costs: the trigger level is known
 * exactly and in advance (the OR high/low at a fixed clock time), so the ONLY thing that varies
 * between arms is how the break is acted on:
 *
 *   entryMode 'resting'  — a broker-resting stop sits AT the level from the moment the OR closes.
 *                          Fill = level ± slip, no reaction latency. (What the tick engine enables.)
 *   entryMode 'close1m'  — wait for a 1m bar to CLOSE beyond the level, then market on the next
 *                          second's open. (A fast bar-close system.)
 *   entryMode 'close5m'  — same, on 5m closes. (What we run today.)
 *
 * Same structure, same exits, same costs — the spread between arms IS the latency cost, in dollars.
 */
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';

export const ORB_DEFAULTS = {
  orMin: 15, entryMode: 'resting', maxOrders: 4,
  stopAtr: 1.0, targetAtr: 0, timeCapMin: 240, sides: 'both',   // 'both' | 'long' | 'short'
  minRangeAtr: 0, maxRangeAtr: 99, workMin: 330,                 // order alive until ~15:00 ET
  atrTf: '15m',
};

/** UTC seconds of 09:30 ET on a trade date (computed once per session, never in the hot loop). */
function rthOpenSec(tradeDate) {
  const [y, m, d] = tradeDate.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 14, 30) / 1000;            // 09:30 EDT
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(guess * 1000));
  return +et === 9 ? guess : guess + 3600;                        // EST → one hour later in UTC
}

export function runORB(C, cfg = {}, from = 0, to = C.n) {
  const p = { ...ORB_DEFAULTS, ...cfg };
  const tickValue = C.meta.product === 'NQ' ? 5.0 : 12.5;
  const core = new TickCore({ cache: C, timeframes: ['1m', '5m', p.atrTf], watchCapacity: 512 });
  const broker = new TickBroker({ core, tickValue, commissionRT: 5.0, slipStopTicks: 2, slipMktTicks: 1,
                                  maxConcurrentOrders: p.maxOrders });
  const tfA = core.tf(p.atrTf), tf1 = core.tf('1m'), tf5 = core.tf('5m');
  let day = null, orOpen = 0, orEnd = 0, orHi = 0, orLo = 0, armed = false, done = false, atrAtOR = 0;
  let nDays = 0, nArm = 0;
  const pending = [];                                             // ids placed for this session

  const startSession = (td) => {
    day = td; orOpen = rthOpenSec(td); orEnd = orOpen + p.orMin * 60;
    orHi = -2e9; orLo = 2e9; armed = false; done = false; pending.length = 0;
  };

  const arm = () => {
    armed = true; nArm++;
    const atr = atrAtOR || tfA.atr || 1;
    const range = orHi - orLo;
    if (range < p.minRangeAtr * atr || range > p.maxRangeAtr * atr) { done = true; return; }
    const stopT = Math.round(p.stopAtr * atr), tgtT = p.targetAtr ? Math.round(p.targetAtr * atr) : undefined;
    const common = { maxHoldSec: p.timeCapMin * 60, expirySec: p.workMin * 60, group: 'orb', resting: true,
                     stopTicks: stopT, targetTicks: tgtT };
    if (p.entryMode === 'always') {                               // DRIFT TWIN: same clock, same exits,
      broker.place({ ...common, kind: 'market', side: p.sides === 'short' ? -1 : 1, resting: false });
      done = true; return;                                        // but NO breakout condition at all
    }
    if (p.entryMode === 'resting') {                              // pre-positioned: the broker holds both sides
      if (p.sides !== 'short') { const id = broker.place({ ...common, kind: 'stop', side: 1, price: orHi }); if (id) pending.push(id); }
      if (p.sides !== 'long') { const id = broker.place({ ...common, kind: 'stop', side: -1, price: orLo }); if (id) pending.push(id); }
    }
    // close1m / close5m arms wait for a bar close (below) and then send a market order
  };

  const onBarClose = (f) => {
    if (f.tf === p.atrTf) { if (!armed) atrAtOR = f.atr; return; }
    if (done || !armed || p.entryMode === 'resting') return;
    const want = p.entryMode === 'close1m' ? '1m' : '5m';
    if (f.tf !== want) return;
    const cl = f.closedC;
    if (p.sides !== 'short' && cl > orHi) { broker.place({ kind: 'market', side: 1, resting: false, stopTicks: Math.round(p.stopAtr * (atrAtOR || 1)), targetTicks: p.targetAtr ? Math.round(p.targetAtr * (atrAtOR || 1)) : undefined, maxHoldSec: p.timeCapMin * 60, group: 'orb' }); done = true; }
    else if (p.sides !== 'long' && cl < orLo) { broker.place({ kind: 'market', side: -1, resting: false, stopTicks: Math.round(p.stopAtr * (atrAtOR || 1)), targetTicks: p.targetAtr ? Math.round(p.targetAtr * (atrAtOR || 1)) : undefined, maxHoldSec: p.timeCapMin * 60, group: 'orb' }); done = true; }
  };

  core.run(from, to, {
    onBarClose,
    onTick: (c) => {
      const td = c.session.tradeDate;
      if (td !== day) { if (day) { broker.cancelAll('eod'); } startSession(td); nDays++; }
      const ts = c.ts, row = c.row;
      if (ts >= orOpen && ts < orEnd) {                            // build the opening range
        const h = C.h[row], l = C.l[row];
        if (h > orHi) orHi = h;
        if (l < orLo) orLo = l;
      } else if (!armed && ts >= orEnd && orHi > -2e9) arm();
      broker.onTick();
    },
    onArm: (meta, lvl) => broker.onArm(meta, lvl),
    onRoll: () => { broker.cancelAll('roll'); done = true; },
  });
  return { summary: broker.summary(), trades: broker.trades, nDays, nArm, cfg: p };
}
