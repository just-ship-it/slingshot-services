/**
 * Parse a TradingView "List of Trades" export from the ls-dumper Pine
 * strategy and emit a clean sparse LS-state CSV that backtest consumers
 * can forward-fill at their own bar grid.
 *
 * INPUT
 *   - One or more TV exports (XLSX or CSV). When in XLSX, the "List of
 *     trades" sheet is read. CSV is assumed to be the same sheet exported
 *     as CSV.
 *   - The chart symbol used (e.g. NQ1!). LS is a boolean — no price-space
 *     translation is needed regardless of back-adjustment, but we stamp
 *     the source symbol in the output for provenance.
 *
 * COMMENT FORMAT (from ls-dumper.pine, "On flip only" mode)
 *   Entry comment: B=0|T=YYYYMMDDTHHMM  or  B=1|T=YYYYMMDDTHHMM
 *   Exit comment:  X
 *   We only keep entry rows.
 *
 * OUTPUT (sparse — one row per state flip)
 *   timestamp_iso, unix_ms, state, source_symbol
 *
 *   Each row marks the start of a state run. The state holds from this
 *   row's timestamp until (but not including) the next row's timestamp.
 *   Consumers forward-fill: state(bar_t) = state(last_row with ts <= bar_t).
 *
 * USAGE
 *   node research/lt-extraction/parse-ls-export.js \
 *     --in research/lt-extraction/exports/LS_Dumper_..._02f75.xlsx \
 *     --symbol "NQ1!" \
 *     --out research/lt-extraction/output/nq_ls_1m_raw.csv
 *
 *   --in can be repeated to merge multiple chunked exports.
 *   --sheet overrides the default "List of trades" sheet name (XLSX only).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import ExcelJS from 'exceljs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { ins: [], symbol: 'NQ1!', out: null, sheet: 'List of trades' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--in') out.ins.push(args[++i]);
    else if (args[i] === '--symbol') out.symbol = args[++i];
    else if (args[i] === '--out') out.out = args[++i];
    else if (args[i] === '--sheet') out.sheet = args[++i];
  }
  if (!out.ins.length || !out.out) {
    console.error('Usage: --in PATH (repeatable, .xlsx or .csv) --symbol "NQ1!" --out PATH [--sheet "List of trades"]');
    process.exit(1);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Comment + timestamp parsing
// ──────────────────────────────────────────────────────────────────────────
function parseLsComment(comment) {
  if (!comment || typeof comment !== 'string') return null;
  const kv = {};
  for (const part of comment.split('|')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    kv[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (kv.B == null || kv.T == null) return null;
  const b = kv.B === '1' ? 1 : kv.B === '0' ? 0 : null;
  if (b === null) return null;
  return { state: b, bar_ts_utc: kv.T };
}

function parseBarTs(tStr) {
  // YYYYMMDDTHHMM -> ms epoch (UTC). Length 13 with the 'T' at index 8.
  if (!tStr || tStr.length !== 13 || tStr[8] !== 'T') return null;
  const y = +tStr.slice(0, 4);
  const mo = +tStr.slice(4, 6) - 1;
  const d = +tStr.slice(6, 8);
  const h = +tStr.slice(9, 11);
  const mi = +tStr.slice(11, 13);
  if ([y, mo, d, h, mi].some(Number.isNaN)) return null;
  return Date.UTC(y, mo, d, h, mi, 0);
}

function isEntryType(type) {
  if (!type) return false;
  const lc = String(type).toLowerCase();
  return lc.includes('entry') || lc === 'buy' || lc === 'sell';
}

// ──────────────────────────────────────────────────────────────────────────
// XLSX reader (streaming via ExcelJS to handle large files)
// ──────────────────────────────────────────────────────────────────────────
async function readXlsx(filePath, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) {
    const names = wb.worksheets.map(w => w.name);
    throw new Error(`Sheet "${sheetName}" not found in ${filePath}. Available: ${names.join(', ')}`);
  }
  // Locate columns by header text on row 1
  const header = ws.getRow(1).values; // 1-indexed array
  let typeIdx = -1, signalIdx = -1;
  for (let i = 1; i < header.length; i++) {
    const v = header[i];
    if (v == null) continue;
    const lc = String(v).toLowerCase();
    if (lc === 'type') typeIdx = i;
    else if (lc.includes('signal') || lc.includes('comment')) {
      if (signalIdx === -1) signalIdx = i;
    }
  }
  if (typeIdx === -1 || signalIdx === -1) {
    throw new Error(`Could not locate Type/Signal columns in ${filePath}. Header: ${JSON.stringify(header)}`);
  }
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const type = row.getCell(typeIdx).value;
    const signal = row.getCell(signalIdx).value;
    rows.push({ type, signal });
  });
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// CSV reader (fallback if user exports CSV from TV instead of XLSX)
// ──────────────────────────────────────────────────────────────────────────
async function readCsv(filePath) {
  const headers = { typeCol: null, commentCol: null };
  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('headers', (h) => {
        for (const col of h) {
          const lc = col.toLowerCase();
          if (lc === 'type') headers.typeCol = col;
          else if ((lc.includes('signal') || lc.includes('comment')) && !headers.commentCol) {
            headers.commentCol = col;
          }
        }
      })
      .on('data', (row) => {
        rows.push({
          type: headers.typeCol ? row[headers.typeCol] : null,
          signal: headers.commentCol ? row[headers.commentCol] : null,
        });
      })
      .on('end', resolve).on('error', reject);
  });
  return rows;
}

async function readAny(filePath, sheetName) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx') return readXlsx(filePath, sheetName);
  if (ext === '.csv') return readCsv(filePath);
  throw new Error(`Unsupported input extension: ${ext} (${filePath})`);
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  console.log(`Inputs: ${args.ins.length} file(s)`);
  console.log(`Symbol: ${args.symbol}`);
  console.log(`Output: ${args.out}`);

  // Collect all (ts, state) emissions across all input files
  const emissions = [];
  for (const inPath of args.ins) {
    const tvRows = await readAny(inPath, args.sheet);
    let kept = 0, skipped = 0;
    for (const r of tvRows) {
      if (!isEntryType(r.type)) { skipped++; continue; }
      const parsed = parseLsComment(r.signal);
      if (!parsed) { skipped++; continue; }
      const ts = parseBarTs(parsed.bar_ts_utc);
      if (ts == null) { skipped++; continue; }
      emissions.push({ ts, state: parsed.state });
      kept++;
    }
    console.log(`  ${path.basename(inPath)}: ${kept} entries kept, ${skipped} non-entry/unparseable`);
  }
  console.log(`Total emissions: ${emissions.length}`);

  if (!emissions.length) {
    console.error('No entries parsed. Are the comments in the expected B=0|1|T=YYYYMMDDTHHMM format?');
    process.exit(1);
  }

  // Sort by timestamp, dedupe on (ts, state). When chunks overlap on a
  // boundary bar, both runs emit the same (ts, state) and we keep one.
  // If two emissions share a ts but disagree on state, that's a real
  // anomaly — keep the LAST one and log a warning (this should not happen
  // with deterministic Pine logic but we check anyway).
  emissions.sort((a, b) => a.ts - b.ts);
  const merged = [];
  let conflicts = 0;
  for (const e of emissions) {
    const last = merged[merged.length - 1];
    if (last && last.ts === e.ts) {
      if (last.state !== e.state) { conflicts++; last.state = e.state; }
      continue;
    }
    merged.push({ ts: e.ts, state: e.state });
  }
  if (conflicts) console.warn(`WARN: ${conflicts} same-timestamp state conflicts (kept later value)`);

  // Collapse runs: if two adjacent emissions have the same state, the
  // later one is redundant (no actual flip happened — likely a chunk
  // boundary on a non-flip bar from "Every bar" mode mixed in, or first
  // bar of a chunk where we didn't have prior context). Keep only true
  // state changes plus the very first emission as the seed.
  const flips = [];
  for (const e of merged) {
    if (!flips.length || flips[flips.length - 1].state !== e.state) {
      flips.push(e);
    }
  }
  const redundant = merged.length - flips.length;
  if (redundant) console.log(`Collapsed ${redundant} non-flip duplicate(s); ${flips.length} true flips kept`);

  // ── Write sparse output ────────────────────────────────────────────────
  const lines = ['timestamp_iso,unix_ms,state,source_symbol'];
  for (const f of flips) {
    lines.push([new Date(f.ts).toISOString(), f.ts, f.state, args.symbol].join(','));
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, lines.join('\n') + '\n');
  console.log(`\nWrote ${args.out} (${flips.length} rows)`);

  // ── Summary stats ──────────────────────────────────────────────────────
  const tsFirst = flips[0].ts;
  const tsLast = flips[flips.length - 1].ts;
  const spanDays = (tsLast - tsFirst) / 86400000;
  const bullCount = flips.filter(f => f.state === 1).length;
  const bearCount = flips.length - bullCount;

  // Run durations (time in each state between consecutive flips)
  const runDurs = [];
  for (let i = 1; i < flips.length; i++) runDurs.push((flips[i].ts - flips[i - 1].ts) / 60000);
  runDurs.sort((a, b) => a - b);
  const med = runDurs[Math.floor(runDurs.length / 2)] || 0;
  const avg = runDurs.reduce((s, x) => s + x, 0) / (runDurs.length || 1);
  const max = runDurs[runDurs.length - 1] || 0;
  const min = runDurs[0] || 0;

  console.log('\n=== Summary ===');
  console.log(`Range:       ${new Date(tsFirst).toISOString()}  →  ${new Date(tsLast).toISOString()}`);
  console.log(`Span:        ${spanDays.toFixed(1)} days`);
  console.log(`Flips:       ${flips.length}  (avg ${(flips.length / spanDays).toFixed(1)}/day)`);
  console.log(`Bull (B=1):  ${bullCount}  (${(100 * bullCount / flips.length).toFixed(1)}%)`);
  console.log(`Bear (B=0):  ${bearCount}  (${(100 * bearCount / flips.length).toFixed(1)}%)`);
  console.log(`Run minutes: min=${min.toFixed(1)}  median=${med.toFixed(1)}  avg=${avg.toFixed(1)}  max=${max.toFixed(1)}`);

  console.log('\nFirst 3 flips:');
  for (let i = 0; i < Math.min(3, flips.length); i++) {
    const f = flips[i];
    console.log(`  ${new Date(f.ts).toISOString()}  state=${f.state}`);
  }
  console.log('Last 3 flips:');
  for (let i = Math.max(0, flips.length - 3); i < flips.length; i++) {
    const f = flips[i];
    console.log(`  ${new Date(f.ts).toISOString()}  state=${f.state}`);
  }

  console.log('\n=== Consumer note ===');
  console.log('This file is SPARSE: one row per state flip. To get state at any');
  console.log('arbitrary bar timestamp T, take the row with the latest ts <= T.');
}

main().catch(e => { console.error(e); process.exit(1); });
