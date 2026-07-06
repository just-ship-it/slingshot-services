/**
 * Phase 4a — Extract mbp-1 (top-of-book + trade prints) windows around the
 * tradeable-type releases (CPI/PCE/PPI/NFP) that have NQ book coverage.
 *
 * mbp-1 gives, at every update: prevailing best bid/ask + sizes (for market-order
 * slippage) AND trade prints (action='T', price/size/aggressor — for limit-order
 * fill modeling). Book coverage = 2025-01-01 → 2026-01-23 → 47 tradeable releases.
 *
 * For each event we open that day's 1.5GB mbp-1 file, stream to the window
 * [release-60s, release+360s] on ts_recv (sorted col, early-exit), keep only the
 * event's primary contract (from window-manifest.csv), and emit a compact row.
 *
 * Timestamps: rel_ms = ts_event(exchange time) - release_ts_ms. Entry latency is
 * modeled explicitly in the sim (Phase 4b), not here.
 *
 * Output: output/book-windows-mbp1.csv
 *   event_id,type,rel_ms,action,side,price,size,bid_px,ask_px,bid_sz,ask_sz
 *
 * Usage: node research/event-reaction/05-extract-book-windows.js [--pre 60] [--post 360]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const MBP_DIR = path.join(ROOT, 'data/orderflow/nq/mbp-1');
const MANIFEST = path.join(__dirname, 'output', 'window-manifest.csv');
const OUT = path.join(__dirname, 'output', 'book-windows-mbp1.csv');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const PRE_S = parseInt(arg('pre', '60'), 10);
const POST_S = parseInt(arg('post', '360'), 10);
const TRADE_TYPES = new Set(['CPI', 'PCE', 'PPI', 'NFP']);

// available mbp-1 dates
const mbpDates = new Set(
  fs.readdirSync(MBP_DIR).map((f) => (f.match(/(\d{8})/) || [])[1]).filter(Boolean)
);

// load manifest → tradeable events with book coverage
const man = fs.readFileSync(MANIFEST, 'utf8').trim().split('\n');
const mcol = {}; man[0].split(',').forEach((h, i) => (mcol[h] = i));
const events = [];
for (let k = 1; k < man.length; k++) {
  const c = man[k].split(',');
  const type = c[mcol.event_type];
  if (!TRADE_TYPES.has(type)) continue;
  const date = c[mcol.date];          // YYYY-MM-DD
  const yyyymmdd = date.replace(/-/g, '');
  if (!mbpDates.has(yyyymmdd)) continue;
  events.push({
    id: c[mcol.event_id], type, date, yyyymmdd,
    releaseMs: parseInt(c[mcol.release_ts_ms], 10),
    symbol: c[mcol.primary_symbol],
  });
}
console.log(`Tradeable events with book coverage: ${events.length}`);
const byType = events.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
console.log('by type:', JSON.stringify(byType));

const out = fs.createWriteStream(OUT);
out.write('event_id,type,rel_ms,action,side,price,size,bid_px,ask_px,bid_sz,ask_sz\n');

async function extractEvent(ev) {
  const file = path.join(MBP_DIR, `glbx-mdp3-${ev.yyyymmdd}.mbp-1.csv`);
  const startStr = new Date(ev.releaseMs - PRE_S * 1000).toISOString().slice(0, 19);
  const endStr = new Date(ev.releaseMs + POST_S * 1000).toISOString().slice(0, 19);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0, header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const tsRecv = line.slice(0, 19);        // sorted column → cheap gate
    if (tsRecv < startStr) continue;
    if (tsRecv > endStr) break;              // past window, file sorted → done
    const c = line.split(',');
    if (c[19] !== ev.symbol) continue;       // primary contract only
    const relMs = Date.parse(c[1].slice(0, 23) + 'Z') - ev.releaseMs; // ts_event(UTC) rel to release
    // event_id,type,rel_ms,action,side,price,size,bid_px,ask_px,bid_sz,ask_sz
    out.write(`${ev.id},${ev.type},${relMs},${c[5]},${c[6]},${c[8]},${c[9]},${c[13]},${c[14]},${c[15]},${c[16]}\n`);
    n++;
  }
  rl.close();
  return n;
}

let total = 0, done = 0;
for (const ev of events) {
  const n = await extractEvent(ev);
  total += n; done++;
  console.log(`[${done}/${events.length}] ${ev.id} (${ev.symbol}) → ${n} rows`);
}
out.end();
console.log(`\nDone. ${total} book rows across ${events.length} events → ${OUT}`);
