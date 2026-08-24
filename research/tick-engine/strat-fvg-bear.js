#!/usr/bin/env node
/**
 * fvg-bear on the tick engine — the strategy the bar-close engine could not hold.
 *
 * Frozen research config: 15m bear FVG, entry filter ema20Slope ≤ 0, resting SELL LIMIT at fvgTop
 * (the full gap-fill retrace), working until a 1m CLOSE above invalidation+eps or 900 minutes,
 * exit = stop 1.5×ATR / time cap 240 min / no target.
 *
 * What changes here vs the bar-close port: working orders are Watches, so we can hold MANY at once
 * (first fill cancels the siblings). The bar-close engine allowed one, and 100% of the edge lived in
 * the setups it therefore had to skip.
 *
 * usage: strat-fvg-bear.js [NQ] [--maxOrders N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json out]
 */
import { loadCache } from './cache.js';
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const P = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'NQ').toUpperCase();
const MAXORD = +arg('maxOrders', 64);
const C = loadCache(P);
const [from, to] = (() => { const r = C.range(arg('from'), arg('to')); return r ? [r[0], r[1]] : [0, C.n]; })();

const TICKVAL = P === 'NQ' ? 5.0 : 12.5;          // NQ 0.25pt×$20 ; ES 0.25pt×$50
const core = new TickCore({ cache: C, timeframes: ['1m', '15m'], watchCapacity: 4 * MAXORD + 256 });
const broker = new TickBroker({ core, tickValue: TICKVAL, commissionRT: 5.0, slipStopTicks: 2, slipMktTicks: 1,
                                maxConcurrentOrders: MAXORD });
const tf15 = core.tf('15m'), tf1 = core.tf('1m');

// rolling 3-bar history of closed 15m bars + gap-size history for the auto threshold
const H3 = [];
const gapHist = [];
const working = new Map();                        // orderId → { cancelBeyond }
let nSignals = 0, nBlocked = 0;

function onFifteen() {
  H3.push({ h: tf15.closedH, l: tf15.closedL, ts: tf15.closedTs });
  if (H3.length > 3) H3.shift();
  if (H3.length < 3 || tf15.count < 20) return;
  const a = H3[0], c = H3[2];
  if (!(a.l > c.h)) return;                                   // bear FVG: bar[-3].low > bar[-1].high
  const gap = a.l - c.h;
  gapHist.push(gap); if (gapHist.length > 100) gapHist.shift();
  const atr = tf15.atr;
  const auto = gapHist.length >= 20 ? 0.5 * (gapHist.reduce((x, y) => x + y, 0) / gapHist.length) : 0;
  if (gap < Math.max(2, 0.15 * atr, auto)) return;            // size gate (ticks)
  const slope = (tf15.ema - tf15.emaPrev) / (atr || 1);
  if (!(slope <= 0)) return;                                  // frozen entry filter
  const fvgTop = a.l;
  const inval = fvgTop + Math.round(0.25 * atr);
  const cancelBeyond = inval + Math.round(0.1 * atr);
  nSignals++;
  const id = broker.place({
    kind: 'limit', side: -1, price: fvgTop, resting: true,
    stopTicks: Math.round(1.5 * atr), targetPrice: null,
    maxHoldSec: 240 * 60, expirySec: 900 * 60, group: 'fvg', tag: { fvgTop, atr, slope },
  });
  if (id) working.set(id, { cancelBeyond }); else nBlocked++;
}

function onMinute() {                                          // the research's cancel rule, on 1m closes
  if (!working.size) return;
  const cl = tf1.closedC;
  for (const [id, w] of working) {
    if (!broker.orders.has(id)) { working.delete(id); continue; }
    if (cl > w.cancelBeyond) { broker.cancel(id, 'gap-inversion'); working.delete(id); }
  }
}

const t0 = Date.now();
core.run(from, to, {
  onBarClose: (f) => { if (f.tf === '15m') onFifteen(); else if (f.tf === '1m') onMinute(); },
  onTick: () => broker.onTick(),
  onArm: (meta, lvl) => { broker.onArm(meta, lvl); },
  onRoll: () => { broker.cancelAll('roll'); working.clear(); },
});
const secs = (Date.now() - t0) / 1000;
const s = broker.summary();
const yrs = (C.ts[to - 1] - C.ts[from]) / (365.25 * 86400);
console.log(`\n=== fvg-bear TICK · ${P} · maxConcurrentOrders=${MAXORD} ===`);
console.log(`${((to - from) / 1e6).toFixed(1)}M 1s bars in ${secs.toFixed(1)}s | signals ${nSignals} (blocked ${nBlocked}) | ${yrs.toFixed(2)} yrs`);
if (!s.n) { console.log('no trades'); process.exit(0); }
console.log(`trades ${s.n}  WR ${(s.wr * 100).toFixed(1)}%  PF ${s.pf.toFixed(3)}  $${s.usd.toLocaleString()} (=$${Math.round(s.usd / yrs).toLocaleString()}/yr)  maxDD $${s.maxDD.toLocaleString()}  medHold ${s.medHoldMin}m`);
console.log(`exits ${JSON.stringify(s.exits)}  rejected ${JSON.stringify(s.rejected)}`);
console.log(`per-year ${JSON.stringify(s.byYear)}`);
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ product: P, maxOrders: MAXORD, summary: s, trades: broker.trades }, null, 1));
