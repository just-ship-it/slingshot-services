/**
 * Retest continuation — the atlas's most-replicated finding (fading a second test of a prior extreme
 * LOSES vs placebo on both NQ and ES ⇒ trade the continuation THROUGH the retested level).
 *
 * Tick formulation: when two highs form within tolerance (a "twin"), the completion condition is
 * purely a price condition, so we rest a STOP-LIMIT: trigger = the break above the twin, limit = the
 * twin level itself. The broker arms the limit at the break instant and fills on the retest — the
 * exact semantics the bar-close port could not express (it lost half the edge waiting for closes).
 */
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';

export const RT_DEFAULTS = {
  tf: '5m', pivotK: 3, maxOrders: 4, side: 'long',      // 'long' = twin highs, break up, buy the retest
  tolAtr: 0.5, minSepBars: 8, maxSepBars: 120, minDepthAtr: 1.5,
  breakPadAtr: 0.1, workMin: 120, stopAtr: 1.5, targetAtr: 2.0, timeCapMin: 480,
};

export function runRetest(C, cfg = {}, from = 0, to = C.n) {
  const p = { ...RT_DEFAULTS, ...cfg };
  const long = p.side === 'long', dir = long ? 1 : -1;
  const tickValue = C.meta.product === 'NQ' ? 5.0 : 12.5;
  const core = new TickCore({ cache: C, timeframes: ['1m', p.tf], watchCapacity: 4 * p.maxOrders + 512 });
  const broker = new TickBroker({ core, tickValue, commissionRT: 5.0, slipStopTicks: 2, slipMktTicks: 1,
                                  maxConcurrentOrders: p.maxOrders });
  const F = core.tf(p.tf);
  const bars = [], piv = [];
  let nTwin = 0, nOrders = 0;
  const pushPivot = (kind, px, i) => {
    const last = piv[piv.length - 1];
    if (last && last.kind === kind) { const better = kind === 'H' ? px >= last.px : px <= last.px; if (better) { last.px = px; last.i = i; } return false; }
    piv.push({ kind, px, i }); if (piv.length > 12) piv.shift(); return true;
  };
  const onClose = () => {
    bars.push({ h: F.closedH, l: F.closedL, i: F.count });
    if (bars.length > 300) bars.shift();
    const k = p.pivotK;
    if (bars.length < 2 * k + 1 || F.count < 25) return;
    const ci = bars.length - 1 - k, cand = bars[ci];
    let isH = true, isL = true;
    for (let j = 1; j <= k && (isH || isL); j++) {
      if (!(cand.h > bars[ci - j].h)) isH = false;
      if (!(cand.l < bars[ci - j].l)) isL = false;
      if (!(cand.h >= bars[ci + j].h)) isH = false;
      if (!(cand.l <= bars[ci + j].l)) isL = false;
    }
    let fresh = false;
    if (isH) fresh = pushPivot('H', cand.h, cand.i) || fresh;
    if (isL) fresh = pushPivot('L', cand.l, cand.i) || fresh;
    if (!fresh || piv.length < 3) return;
    const atr = F.atr || 1, n = piv.length;
    const w = piv.slice(n - 3);                                   // P1(twin) TROUGH P2(twin)
    const want = long ? ['H', 'L', 'H'] : ['L', 'H', 'L'];
    for (let i = 0; i < 3; i++) if (w[i].kind !== want[i]) return;
    const [P1, TR, P2] = w;
    if (Math.abs(P2.px - P1.px) > p.tolAtr * atr) return;          // the two extremes must be "equal"
    const sep = P2.i - P1.i;
    if (sep < p.minSepBars || sep > p.maxSepBars) return;
    const depth = long ? Math.min(P1.px, P2.px) - TR.px : TR.px - Math.max(P1.px, P2.px);
    if (depth < p.minDepthAtr * atr) return;
    const twin = long ? Math.max(P1.px, P2.px) : Math.min(P1.px, P2.px);
    const trigger = twin + dir * Math.round(p.breakPadAtr * atr);  // the break that arms the retest limit
    const mkt = C.c[core.row];
    if (long ? mkt >= trigger : mkt <= trigger) return;            // must still be below/above the break
    nTwin++;
    const id = broker.place({
      kind: 'stop_limit', side: dir, trigger, price: twin, resting: true,
      stopTicks: Math.round(p.stopAtr * atr), targetTicks: Math.round(p.targetAtr * atr),
      maxHoldSec: p.timeCapMin * 60, expirySec: p.workMin * 60, group: 'rt',
    });
    if (id) nOrders++;
  };
  core.run(from, to, {
    onBarClose: (f) => { if (f.tf === p.tf) onClose(); },
    onTick: () => broker.onTick(),
    onArm: (meta, lvl) => broker.onArm(meta, lvl),
    onRoll: () => { broker.cancelAll('roll'); piv.length = 0; bars.length = 0; },
  });
  return { summary: broker.summary(), trades: broker.trades, nTwin, nOrders, cfg: p };
}
