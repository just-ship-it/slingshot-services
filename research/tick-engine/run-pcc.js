#!/usr/bin/env node
/**
 * Cross-validation: pre-close continuation (PCC) — a strategy validated on a COMPLETELY different
 * harness (greenfield book-harness.py / B12_sim), reimplemented on the tick engine.
 *
 * Rule: at 15:00 ET take day_move = price(15:00) − RTH open(09:30). Enter 1 contract MARKET in that
 * direction, no stop, no target, exit MARKET 30 minutes later (15:30 ET).
 * Reference (book-pcc-daily.csv): 709 trades, $77,635 total ≈ $12,939/yr, PF 1.45, WR 57.1%.
 * Agreement here means the tick engine's clock, fills, slippage and costs are right.
 */
import { loadCache } from './cache.js';
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';
const P = (process.argv[2] || 'NQ').toUpperCase();
const C = loadCache(P);
const core = new TickCore({ cache: C, timeframes: ['1m'], watchCapacity: 64 });
const broker = new TickBroker({ core, tickValue: P === 'NQ' ? 5.0 : 12.5, commissionRT: 5.0, slipStopTicks: 2, slipMktTicks: 1, maxConcurrentOrders: 2 });
function etHour(sec) { return +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(sec * 1000)); }
function rthSec(td, hh, mm) {
  const [y, m, d] = td.split('-').map(Number);
  const g = Date.UTC(y, m - 1, d, hh + 5, mm) / 1000;            // assume EST then correct
  return etHour(g) === hh ? g : g - 3600;
}
let day = null, t0930 = 0, t1500 = 0, open0930 = 0, fired = false, n = 0;
core.run(0, C.n, {
  onTick: (c) => {
    const td = c.session.tradeDate;
    if (td !== day) { day = td; t0930 = rthSec(td, 9, 30); t1500 = rthSec(td, 15, 0); open0930 = 0; fired = false; }
    const ts = c.ts;
    if (!open0930 && ts >= t0930) open0930 = C.o[c.row];
    if (!fired && open0930 && ts >= t1500) {
      fired = true; n++;
      const move = C.c[c.row] - open0930;
      if (move !== 0) broker.place({ kind: 'market', side: move > 0 ? 1 : -1, resting: false, maxHoldSec: 30 * 60, group: 'pcc' });
    }
    broker.onTick();
  },
  onArm: (m, l) => broker.onArm(m, l),
  onRoll: () => broker.cancelAll('roll'),
});
const s = broker.summary();
const yrs = (C.ts[C.n - 1] - C.ts[0]) / (365.25 * 86400);
console.log(`PCC on the tick engine (${P}, ${yrs.toFixed(2)} yrs, ${n} decision days)`);
console.log(`  trades ${s.n}  WR ${(s.wr * 100).toFixed(1)}%  PF ${s.pf.toFixed(3)}  $${s.usd.toLocaleString()}  =$${Math.round(s.usd / yrs).toLocaleString()}/yr  maxDD $${s.maxDD.toLocaleString()}`);
console.log(`  reference (greenfield harness, 2021-04→2026-06): 709 trades, $77,635 total, $12,939/yr, PF 1.45, WR 57.1%`);
console.log(`  per-year ${JSON.stringify(s.byYear)}`);
