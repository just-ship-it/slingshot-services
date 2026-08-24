#!/usr/bin/env node
/**
 * Stream the primary-contract 1m cache through the PatternEngine and write PatternEvents as JSONL
 * per trade date:  research/price-structures/events/<product>/<yyyy-mm-dd>.jsonl
 *
 *   node run-historical.js --product NQ --start 2024-01-02 --end 2024-01-31 \
 *        --tfs 1m,3m,5m,15m,30m,1h,4h,1d [--detectors all|single-bar,...] [--out DIR] [--stats]
 *
 * Cache: backtest-engine/greenfield/explore/cache/<PRODUCT>_1m_primary.csv
 * (ts_utc,et_date,et_hhmm,dow,o,h,l,c,v,symbol,roll — raw front-month, rollover-aware).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { PatternEngine } from '../../../shared/pattern-engine/engine.js';
import { loadDetectors } from '../../../shared/pattern-engine/patterns/index.js';
import { tradeDate } from '../../../shared/pattern-engine/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));

const product = (args.product || 'NQ').toUpperCase();
const start = args.start || '2021-01-01', end = args.end || '2099-01-01';
const tfs = (args.tfs || '1m,3m,5m,15m,30m,1h,4h,1d').split(',');
const outDir = args.out || path.join(ROOT, 'research/price-structures/events', product);
const detectors = await loadDetectors(args.detectors || 'all');
fs.mkdirSync(outDir, { recursive: true });

const eng = new PatternEngine({ product, timeframes: tfs, detectors });
const csv = path.join(ROOT, `backtest-engine/greenfield/explore/cache/${product}_1m_primary.csv`);
const rl = readline.createInterface({ input: fs.createReadStream(csv), crlfDelay: Infinity });
let header = true, curDate = null, ws = null, n = 0, nEv = 0, t0 = Date.now();
const startTs = Date.parse(start + 'T00:00:00Z') - 86400000, endTs = Date.parse(end + 'T23:59:59Z') + 86400000;
// warm-up: feed bars from `warmDays` before start but don't write their events
const warmDays = +(args.warm || 5);
const writeFrom = Date.parse(start + 'T00:00:00Z');
const gz = args.gz !== 'false';
let prevFile = null;
async function openDay(d) {
  if (ws) { ws.end(); if (prevFile) await once(prevFile, 'finish'); }   // finalize the previous day before moving on
  const file = fs.createWriteStream(path.join(outDir, `${d}.jsonl` + (gz ? '.gz' : '')));
  prevFile = file;
  if (gz) { const z = zlib.createGzip({ level: 4 }); z.pipe(file); ws = z; } else ws = file;
}
async function writeLine(s) {
  if (!ws.write(s)) await once(ws, 'drain');   // respect backpressure (otherwise the gzip stream starves in memory)
}
for await (const line of rl) {
  if (header) { header = false; continue; }
  if (!line) continue;
  const c = line.indexOf(','); const ts = Date.parse(line.slice(0, c));
  if (ts < startTs - warmDays * 86400000) continue;
  if (ts > endTs) break;
  const f = line.split(',');
  const bar = { ts, open: +f[4], high: +f[5], low: +f[6], close: +f[7], volume: +f[8], symbol: f[9] };
  const events = eng.onBar1m(bar);
  n++;
  if (!events.length) continue;
  const td = events[0].context.tradeDate;
  if (Date.parse(td + 'T00:00:00Z') < writeFrom) continue;
  if (td !== curDate) { curDate = td; await openDay(td); }
  for (const e of events) { await writeLine(JSON.stringify(e) + '\n'); nEv++; }
  if (n % 200000 === 0) process.stderr.write(`  ${n} bars, ${nEv} events, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
if (ws) { ws.end(); if (prevFile) await once(prevFile, 'finish'); }
const secs = (Date.now() - t0) / 1000;
process.stderr.write(`done: ${n} 1m bars, ${nEv} events written to ${outDir} in ${secs.toFixed(1)}s (${(n / secs).toFixed(0)} bars/s)\n`);
if (args.stats) console.log(JSON.stringify(eng.stats, null, 1));
