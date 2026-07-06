/**
 * Phase 0 — Extract 1s OHLCV windows around scheduled economic events.
 *
 * Reuses the FRED event calendar built by the concluded event-positioning audit
 * (research/event-positioning/output/event-calendar.csv).
 *
 * For every event whose release instant falls inside the 1s data span, pulls the
 * primary-contract 1s bars in [release - PRE_MIN, release + POST_MIN] in a single
 * streaming pass over the 8.3GB NQ_ohlcv_1s.csv (sorted by ts_event).
 *
 * Primary contract = highest total-volume symbol within each event window
 * (calendar-spread rows, symbol containing '-', are dropped). Windows are short
 * (~2h) so intra-window rollover is a non-issue except on roll days; picking the
 * single highest-volume front month per window is sufficient and keeps every bar
 * in one raw-contract price space (see CLAUDE.md price-space rules).
 *
 * Output: output/event-windows-1s.csv with columns:
 *   event_id,event_type,release_ts_ms,symbol,ts,rel_sec,open,high,low,close,volume
 * where rel_sec = signed seconds from the release instant (negative = pre-event).
 * Plus output/window-manifest.csv (one row per event: bar count, symbol, span).
 *
 * Usage:
 *   node research/event-reaction/01-extract-event-windows.js \
 *     [--pre 30] [--post 90] [--product NQ]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const PRE_MIN = parseInt(arg('pre', '30'), 10);
const POST_MIN = parseInt(arg('post', '90'), 10);
const PRODUCT = arg('product', 'NQ').toUpperCase();

const OHLCV_1S = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
const CAL_ARG = arg('calendar', null);
const CALENDAR = CAL_ARG
  ? (path.isAbsolute(CAL_ARG) ? CAL_ARG : path.join(ROOT, CAL_ARG))
  : path.join(__dirname, '..', 'event-positioning', 'output', 'event-calendar.csv');
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT_BARS = path.join(OUT_DIR, `event-windows-1s-${PRODUCT}.csv`);
const OUT_MANIFEST = path.join(OUT_DIR, `window-manifest-${PRODUCT}.csv`);

// --- Determine 1s data span from first/last line (sorted file) ---
function firstLastTs(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4096);
  fs.readSync(fd, head, 0, 4096, 0);
  const firstTs = head.toString('utf8').split('\n')[1].slice(0, 19);
  const tailBuf = Buffer.alloc(4096);
  fs.readSync(fd, tailBuf, 0, 4096, size - 4096);
  fs.closeSync(fd);
  const tail = tailBuf.toString('utf8').trim().split('\n');
  const lastTs = tail[tail.length - 1].slice(0, 19);
  return { firstTs, lastTs };
}

// --- Load + prep events ---
function loadEvents() {
  const lines = fs.readFileSync(CALENDAR, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const idx = (n) => header.indexOf(n);
  const iDate = idx('date'), iType = idx('event_type'), iTs = idx('release_ts_ms');
  const { firstTs, lastTs } = firstLastTs(OHLCV_1S);
  const events = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const releaseMs = parseInt(c[iTs], 10);
    const startMs = releaseMs - PRE_MIN * 60000;
    const endMs = releaseMs + POST_MIN * 60000;
    const startStr = new Date(startMs).toISOString().slice(0, 19);
    const endStr = new Date(endMs).toISOString().slice(0, 19);
    // keep only events whose full window overlaps the 1s span
    if (endStr < firstTs || startStr > lastTs) continue;
    events.push({
      id: `${c[iDate]}_${c[iType]}`,
      date: c[iDate],
      type: c[iType],
      releaseMs,
      releaseStr: new Date(releaseMs).toISOString().slice(0, 19),
      startStr,
      endStr,
      bars: [], // {ts, rel, o,h,l,c,v, symbol}
    });
  }
  events.sort((a, b) => (a.startStr < b.startStr ? -1 : a.startStr > b.startStr ? 1 : 0));
  return events;
}

async function main() {
  console.log(`\n=== Phase 0: extract event windows (${PRODUCT}) ===`);
  console.log(`Window: [release - ${PRE_MIN}m, release + ${POST_MIN}m]`);
  const events = loadEvents();
  console.log(`Events in 1s span: ${events.length}`);
  console.log(`Streaming ${OHLCV_1S} ...`);

  const rl = readline.createInterface({ input: fs.createReadStream(OHLCV_1S), crlfDelay: Infinity });
  let startIdx = 0; // first event whose window might still contain the current ts
  let lineNo = 0;
  let matched = 0;

  for await (const line of rl) {
    lineNo++;
    if (lineNo === 1) continue; // header
    const ts19 = line.slice(0, 19);

    // advance startIdx past events whose window ended before this ts
    while (startIdx < events.length && events[startIdx].endStr < ts19) startIdx++;
    if (startIdx >= events.length) break; // past all event windows
    if (ts19 < events[startIdx].startStr) continue; // in a gap before next window

    // parse only when the row is a candidate for at least one active window
    const c = line.split(',');
    const symbol = c[9];
    if (!symbol || symbol.includes('-')) continue; // drop calendar spreads
    const o = +c[4], h = +c[5], l = +c[6], cl = +c[7], v = +c[8];

    // assign to every active window containing ts (handles rare same-day overlaps)
    for (let j = startIdx; j < events.length && events[j].startStr <= ts19; j++) {
      const ev = events[j];
      if (ts19 > ev.endStr) continue;
      const relSec = Math.round((Date.parse(line.slice(0, 30)) - ev.releaseMs) / 1000);
      ev.bars.push({ ts: line.slice(0, 30), rel: relSec, o, h, l, c: cl, v, symbol });
      matched++;
    }

    if (lineNo % 50_000_000 === 0) {
      console.log(`  ...${(lineNo / 1e6).toFixed(0)}M lines, matched ${matched} bars, at ${ts19}`);
    }
  }
  console.log(`Done streaming. ${matched} candidate bars across ${events.length} windows.`);

  // --- pick primary symbol per event, write outputs ---
  const barOut = fs.createWriteStream(OUT_BARS);
  barOut.write('event_id,event_type,release_ts_ms,symbol,ts,rel_sec,open,high,low,close,volume\n');
  const manOut = fs.createWriteStream(OUT_MANIFEST);
  manOut.write('event_id,event_type,date,release_ts_ms,primary_symbol,n_bars,first_rel_sec,last_rel_sec,n_symbols\n');

  let kept = 0, emptyEvents = 0;
  for (const ev of events) {
    if (ev.bars.length === 0) { emptyEvents++; continue; }
    const volBySym = {};
    for (const b of ev.bars) volBySym[b.symbol] = (volBySym[b.symbol] || 0) + b.v;
    const primary = Object.entries(volBySym).sort((a, b) => b[1] - a[1])[0][0];
    const nSymbols = Object.keys(volBySym).length;
    const pbars = ev.bars.filter((b) => b.symbol === primary).sort((a, b) => a.rel - b.rel);
    for (const b of pbars) {
      barOut.write(`${ev.id},${ev.type},${ev.releaseMs},${primary},${b.ts},${b.rel},${b.o},${b.h},${b.l},${b.c},${b.v}\n`);
      kept++;
    }
    manOut.write(`${ev.id},${ev.type},${ev.date},${ev.releaseMs},${primary},${pbars.length},${pbars[0].rel},${pbars[pbars.length - 1].rel},${nSymbols}\n`);
  }
  barOut.end();
  manOut.end();
  console.log(`Kept ${kept} primary-contract bars. Empty windows: ${emptyEvents}.`);
  console.log(`Wrote ${OUT_BARS}`);
  console.log(`Wrote ${OUT_MANIFEST}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
