/**
 * head-and-shoulders top on the tick engine — PREDICTIVE formulation.
 *
 * The bar-close version died of latency: 44% of its signals arrived after price had already traded
 * through the neckline, and the research sim papered over that by filling at a price that was gone.
 *
 * Reformulated as a Watch: as soon as the trough AFTER the head confirms (LS, T1, HEAD, T2), the
 * structure's completion is a *price condition*, not a bar event —
 *      "sell if price trades down to the neckline, VOID if price first exceeds the head"
 * — so we rest a SELL STOP at the neckline immediately. The right shoulder no longer has to be
 * detected at all: it is simply what happens when price fails to exceed the head and returns.
 * The order sits at the broker, so the fill happens AT the level with no reaction latency.
 *
 * mode: 'predictive' (rest at T2) | 'classic' (wait for the RS pivot to confirm, then rest)
 */
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';

export const HS_DEFAULTS = {
  mode: 'predictive', tf: '5m', pivotK: 3, maxOrders: 4,
  tolAtr: 1.0,          // |T2−T1| tolerance (neckline flatness) and shoulder tolerance
  minHeadAtr: 1.5,      // head prominence above the higher shoulder/neckline
  maxHeadAtr: 12,       // sanity ceiling
  workBars: 24,         // how long the resting stop stays alive, in tf bars
  stopAtr: 1.0, targetAtr: 0, timeCapMin: 30,
  voidPadAtr: 0.05,     // price above head+pad voids the structure
  slopeNeckline: false, // frozen neckline (the sloped variant cost ~4% in earlier testing)
  side: 'top',          // 'top' (short) | 'bottom' (long, inverse H&S)
};

export function runHS(C, cfg = {}, from = 0, to = C.n) {
  const p = { ...HS_DEFAULTS, ...cfg };
  const top = p.side === 'top', dir = top ? -1 : 1;
  const tickValue = C.meta.product === 'NQ' ? 5.0 : 12.5;
  const core = new TickCore({ cache: C, timeframes: ['1m', p.tf], watchCapacity: 4 * p.maxOrders + 512 });
  const broker = new TickBroker({ core, tickValue, commissionRT: 5.0, slipStopTicks: 2, slipMktTicks: 1,
                                  maxConcurrentOrders: p.maxOrders });
  const F = core.tf(p.tf);
  const bars = [];                  // closed tf bars
  const piv = [];                   // confirmed alternating pivots {kind:'H'|'L', px, i}
  const working = new Map();        // orderId → { voidPx }
  let nStruct = 0, nOrders = 0;

  const pushPivot = (kind, px, i) => {
    const last = piv[piv.length - 1];
    if (last && last.kind === kind) {                       // enforce alternation: keep the extreme
      const better = kind === 'H' ? px >= last.px : px <= last.px;
      if (better) { last.px = px; last.i = i; }
      return false;
    }
    piv.push({ kind, px, i });
    if (piv.length > 12) piv.shift();
    return true;
  };

  const onClose = () => {
    bars.push({ h: F.closedH, l: F.closedL, c: F.closedC, i: F.count });
    if (bars.length > 200) bars.shift();
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
    if (!fresh) return;
    const atr = F.atr || 1;
    const n = piv.length;
    // predictive: ... LS(H) T1(L) HEAD(H) T2(L)   ← T2 is the newest pivot
    // classic:    ... LS(H) T1(L) HEAD(H) T2(L) RS(H) ← RS is the newest pivot
    const need = p.mode === 'classic' ? 5 : 4;
    if (n < need) return;
    const w = piv.slice(n - need);
    const wantKinds = top
      ? (p.mode === 'classic' ? ['H', 'L', 'H', 'L', 'H'] : ['H', 'L', 'H', 'L'])
      : (p.mode === 'classic' ? ['L', 'H', 'L', 'H', 'L'] : ['L', 'H', 'L', 'H']);
    for (let i = 0; i < need; i++) if (w[i].kind !== wantKinds[i]) return;
    const [LS, T1, HEAD, T2] = w;
    const RS = p.mode === 'classic' ? w[4] : null;
    // geometry (mirrored for the inverse)
    const headEx = top ? HEAD.px - LS.px : LS.px - HEAD.px;
    if (headEx <= 0) return;                                        // head must exceed the left shoulder
    const neckline = p.slopeNeckline ? T2.px : Math.round((T1.px + T2.px) / 2);
    const headHeight = top ? HEAD.px - neckline : neckline - HEAD.px;
    if (headHeight < p.minHeadAtr * atr || headHeight > p.maxHeadAtr * atr) return;
    if (Math.abs(T2.px - T1.px) > p.tolAtr * atr) return;           // neckline must be roughly level
    if (RS) { const asym = Math.abs(RS.px - LS.px); if (asym > p.tolAtr * atr) return;
              if (top ? RS.px > HEAD.px : RS.px < HEAD.px) return; }
    // must still be on the correct side of the neckline for a STOP order to be real
    const mkt = C.c[core.row];
    if (top ? mkt <= neckline : mkt >= neckline) return;
    nStruct++;
    const voidPx = top ? HEAD.px + Math.round(p.voidPadAtr * atr) : HEAD.px - Math.round(p.voidPadAtr * atr);
    const id = broker.place({
      kind: 'stop', side: dir, price: neckline, resting: true,
      voidLevel: voidPx, voidSide: top ? 1 : -1,                    // structure invalidated → order dies
      stopTicks: Math.round(p.stopAtr * atr),
      targetTicks: p.targetAtr ? Math.round(p.targetAtr * atr) : undefined,
      maxHoldSec: p.timeCapMin * 60,
      expirySec: p.workBars * (p.tf === '5m' ? 300 : 900),
      group: 'hs', tag: { headHeight, atr },
    });
    if (id) { nOrders++; working.set(id, voidPx); }
  };

  core.run(from, to, {
    onBarClose: (f) => { if (f.tf === p.tf) onClose(); },
    onTick: () => broker.onTick(),
    onArm: (meta, lvl) => broker.onArm(meta, lvl),
    onVoid: (meta) => { const id = meta && meta._ord; if (id) { broker.cancel(id, 'structure-void'); working.delete(id); } },
    onRoll: () => { broker.cancelAll('roll'); working.clear(); piv.length = 0; bars.length = 0; },
  });
  return { summary: broker.summary(), trades: broker.trades, nStruct, nOrders, cfg: p };
}
