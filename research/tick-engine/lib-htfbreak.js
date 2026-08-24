/**
 * HTF-break continuation — trade the break of the previous higher-timeframe candle, with the R/R
 * falling straight out of the geometry: target = that candle's far extreme, stop = its near extreme.
 *
 * Decision at each LTF close, using only what is known then:
 *   pos      = where price sits in the previous HTF candle's range (0 = its low, 1 = its high)
 *   netMove  = net move over the last `seqBars` LTF candles (the multi-candle signature)
 * Long when pos ≥ posHi (and netMove confirms); short when pos ≤ 1−posHi.
 *
 * entryMode 'market' = take it at the LTF close.
 * entryMode 'limit'  = nest the order `edgeTicks` BETTER than the close (Drew's R/R improvement):
 *                      if it fills, the R/R is better; if the break happens first, we simply miss it.
 */
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';

export const HB_DEFAULTS = {
  htf: '15m', ltf: '3m', posHi: 0.70, seqBars: 5, netMoveMinTicks: 0,
  entryMode: 'market', edgeTicks: 0, maxOrders: 2, mode: 'extreme',  // 'extreme' | 'mid'
  midLo: 0.35, midHi: 0.65, cooldownSec: 0,
  minRangeTicks: 20, maxRangeTicks: 400, timeCapMin: 60, requireBoth: true,
};

export function runHtfBreak(C, cfg = {}, from = 0, to = C.n) {
  const p = { ...HB_DEFAULTS, ...cfg };
  const tickValue = C.meta.product === 'NQ' ? 5.0 : 12.5;
  const core = new TickCore({ cache: C, timeframes: [p.ltf, p.htf], watchCapacity: 256 });
  const broker = new TickBroker({ core, tickValue, commissionRT: 5.0, slipStopTicks: 2, slipMktTicks: 1,
                                  maxConcurrentOrders: p.maxOrders });
  const L = core.tf(p.ltf), H = core.tf(p.htf);
  let Hh = 0, Hl = 0, hasH = false;
  const closes = [];
  let nSig = 0, nEval = 0, lastEntryTs = -1e12;

  core.run(from, to, {
    onBarClose: (f, c) => {
      if (f.tf === p.htf) { Hh = f.closedH; Hl = f.closedL; hasH = true; return; }
      if (f.tf !== p.ltf) return;
      closes.push(f.closedC); if (closes.length > 40) closes.shift();
      if (!hasH || closes.length <= p.seqBars) return;
      const rng = Hh - Hl;
      if (rng < p.minRangeTicks || rng > p.maxRangeTicks) return;
      const px = f.closedC;
      if (px >= Hh || px <= Hl) return;                       // already broken — no trade left
      nEval++;
      const pos = (px - Hl) / rng;
      const net = px - closes[closes.length - 1 - p.seqBars];
      let dir = 0;
      if (p.mode === 'mid') {
        // symmetric-payoff zone: direction comes from the multi-candle signature, not from position
        if (pos < p.midLo || pos > p.midHi) return;
        if (net >= p.netMoveMinTicks) dir = 1; else if (net <= -p.netMoveMinTicks) dir = -1;
      } else {
        if (pos >= p.posHi && (!p.requireBoth || net >= p.netMoveMinTicks)) dir = 1;
        else if (pos <= 1 - p.posHi && (!p.requireBoth || net <= -p.netMoveMinTicks)) dir = -1;
      }
      if (!dir) return;
      if (p.cooldownSec && c.ts - lastEntryTs < p.cooldownSec) return;
      lastEntryTs = c.ts;
      nSig++;
      const entryPx = p.entryMode === 'limit' ? px - dir * p.edgeTicks : undefined;
      broker.place({
        kind: p.entryMode === 'limit' ? 'limit' : 'market', side: dir,
        resting: p.entryMode === 'limit', price: entryPx,
        stopPrice: dir > 0 ? Hl : Hh, targetPrice: dir > 0 ? Hh : Hl,
        maxHoldSec: p.timeCapMin * 60, expirySec: 900, group: 'hb',
      });
    },
    onTick: () => broker.onTick(),
    onArm: (m, l) => broker.onArm(m, l),
    onRoll: () => { broker.cancelAll('roll'); hasH = false; },
  });
  return { summary: broker.summary(), trades: broker.trades, nSig, nEval, cfg: p };
}
