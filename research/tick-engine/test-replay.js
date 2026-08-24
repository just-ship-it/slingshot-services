#!/usr/bin/env node
/**
 * Knowability replay gate for the tick engine (generalizes the pattern-engine gate).
 * A truncated run must produce a byte-identical PREFIX of the full run's event stream.
 * Any dependence on future bars — a feature peeking, a watch armed early, an aggregation that
 * borrows the next bar — breaks this. usage: test-replay.js [NQ] [nCuts]
 */
import { loadCache } from './cache.js';
import { TickCore } from './tick-core.js';

const P = (process.argv[2] || 'NQ').toUpperCase();
const CUTS = +(process.argv[3] || 5);
const C = loadCache(P);
const from = 0, to = Math.min(C.n, 3_000_000);
console.log(`${P}: replay gate over rows [${from}, ${to})`);

function run(limit) {
  const core = new TickCore({ cache: C, timeframes: ['1m', '5m', '15m'], watchCapacity: 4096 });
  const ev = [];
  const p0 = C.c[from];
  for (let i = 0; i < 24; i++) core.watches.add({ armLevel: p0 + (i % 2 ? 1 : -1) * (40 + i * 11), armSide: i % 2 ? 1 : -1, voidLevel: p0 + (i % 2 ? -1 : 1) * (60 + i * 13), voidSide: i % 2 ? -1 : 1, meta: i });
  core.run(from, limit, {
    onBarClose: (f, c) => ev.push(`C|${f.tf}|${f.closedTs}|${f.closedO}|${f.closedH}|${f.closedL}|${f.closedC}|${f.closedV}|${f.atr.toFixed(6)}|${f.ema.toFixed(6)}`),
    onArm: (meta, lvl, c) => { ev.push(`A|${c.ts}|${meta}|${lvl}`); c.watches.add({ armLevel: C.c[c.row] + 50 + (meta % 31) * 7, armSide: 1, voidLevel: C.c[c.row] - 50 - (meta % 29) * 7, voidSide: -1, meta }); },
    onVoid: (meta, r, c) => { ev.push(`V|${c.ts}|${meta}|${r}`); c.watches.add({ armLevel: C.c[c.row] - 50 - (meta % 31) * 7, armSide: -1, voidLevel: C.c[c.row] + 50 + (meta % 29) * 7, voidSide: 1, meta }); },
    onRoll: (c) => ev.push(`R|${c.ts}|${c.sym}`),
  });
  return ev;
}
const t0 = Date.now();
const full = run(to);
console.log(`full run: ${full.length.toLocaleString()} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
let fails = 0;
for (let k = 1; k <= CUTS; k++) {
  const cut = from + Math.floor((to - from) * k / (CUTS + 1));
  const evc = run(cut);
  // the truncated stream must be an exact prefix of the full stream
  let ok = evc.length <= full.length, bad = -1;
  if (ok) for (let i = 0; i < evc.length; i++) if (evc[i] !== full[i]) { ok = false; bad = i; break; }
  console.log(`cut@row ${cut.toString().padStart(9)}  ${evc.length.toString().padStart(8)} events  ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) { fails++; if (bad >= 0) { console.log('  cut :', evc[bad]); console.log('  full:', full[bad]); } else console.log(`  cut has MORE events than full (${evc.length} > ${full.length})`); }
}
console.log(fails === 0 ? 'TICK KNOWABILITY: PASS' : `TICK KNOWABILITY: FAIL (${fails}/${CUTS})`);
process.exit(fails ? 1 : 0);
