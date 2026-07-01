/**
 * 02-annotate-fib.js -- attach MTF-fib confluence to glf/gfi trades, dump a CSV, and print an
 * EARLY STANDALONE read (ignores FCFS slot contention): do confluent mean-reversion trades have
 * better raw WR / avg-$ / PF than non-confluent ones? This is directional only; 03 does the
 * honest FCFS-book test that respects slot occupancy.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBookWithFib, MR_KEYS } from './lib/book-with-fib.js';
import { confluenceCount } from './lib/fib-confluence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trades = loadBookWithFib();
const mr = trades.filter(t => MR_KEYS.has(t.strategyKey));

// ---- coverage diagnostics ----
const cov = { d15: 0, d60: 0, d240: 0, any: 0 };
for (const t of mr) { const f = t.fib; if (f.d15 != null) cov.d15++; if (f.d60 != null) cov.d60++; if (f.d240 != null) cov.d240++; if (f.dmin != null) cov.any++; }
console.log(`MR trades: ${mr.length} (glf+gfi).  Leg coverage: 15m ${cov.d15} | 1h ${cov.d60} | 4h ${cov.d240} | any ${cov.any}`);

// ---- CSV dump ----
const out = path.join(__dirname, 'output', 'glf-gfi-fib.csv');
const hdr = 'id,strategy,side,etDate,entry,levelType,netPnL,win,d15,r15,d60,r60,d240,r240,dmin';
const lines = [hdr];
for (const t of mr) { const f = t.fib; lines.push([t.id, t.strategyKey, t.side, t.etDate, t.actualEntry, t.levelType ?? '', t.netPnL, t.win, f.d15 ?? '', f.r15 ?? '', f.d60 ?? '', f.r60 ?? '', f.d240 ?? '', f.r240 ?? '', f.dmin ?? ''].join(',')); }
fs.writeFileSync(out, lines.join('\n'));
console.log(`Wrote ${out} (${mr.length} rows)`);

// ---- standalone EV by confluence ----
function stat(ts) {
  if (ts.length === 0) return { n: 0 };
  const wins = ts.filter(t => t.netPnL > 0), gp = wins.reduce((s, t) => s + t.netPnL, 0), gl = ts.filter(t => t.netPnL <= 0).reduce((s, t) => s + t.netPnL, 0);
  return { n: ts.length, wr: +(wins.length / ts.length * 100).toFixed(1), avg: +(ts.reduce((s, t) => s + t.netPnL, 0) / ts.length).toFixed(0), pf: gl === 0 ? Infinity : +(gp / -gl).toFixed(2), pnl: Math.round(ts.reduce((s, t) => s + t.netPnL, 0)) };
}
const fmt = s => s.n ? `n=${s.n} WR=${s.wr}% avg=$${s.avg} PF=${s.pf} PnL=$${s.pnl.toLocaleString()}` : 'n=0';

console.log('\n=== STANDALONE EV by confluence (NOT FCFS; directional only) ===');
for (const [label, keys] of [['glf+gfi', null], ['glf', ['gex-level-fade']], ['gfi', ['gex-flip-ivpct']]]) {
  const pool = keys ? mr.filter(t => keys.includes(t.strategyKey)) : mr;
  console.log(`\n-- ${label} (${pool.length}) --`);
  console.log(`  ALL:                 ${fmt(stat(pool))}`);
  for (const prox of [3, 5, 8, 12]) {
    for (const minTF of [1, 2]) {
      const conf = pool.filter(t => confluenceCount(t.fib, prox) >= minTF);
      const non = pool.filter(t => confluenceCount(t.fib, prox) < minTF);
      console.log(`  prox<=${prox} TFs>=${minTF}:  CONF ${fmt(stat(conf))}   ||  NON ${fmt(stat(non))}`);
    }
  }
  // OTE-only, prox 8, >=1
  const ote = pool.filter(t => confluenceCount(t.fib, 8, true) >= 1);
  console.log(`  prox<=8 OTE >=1:     CONF ${fmt(stat(ote))}   ||  NON ${fmt(stat(pool.filter(t => confluenceCount(t.fib, 8, true) < 1)))}`);
}
