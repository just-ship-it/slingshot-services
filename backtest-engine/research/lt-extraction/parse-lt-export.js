/**
 * Parse a TradingView "List of Trades" CSV export from the lt-dumper Pine
 * strategy and produce a clean LT-levels CSV in raw-contract price space.
 *
 * INPUT
 *   - One or more TV exports (CSV from Strategy Tester → List of Trades →
 *     Export → CSV). Schema varies a bit between TV revisions but we look
 *     for the columns we need: Date/Time, Type, Signal/Comment, Price.
 *   - The chart symbol used (e.g. NQ1!, NQM5). Drives whether we translate
 *     for back-adjustment or not.
 *   - The rollover log at data/ohlcv/nq/NQ_rollover_log.csv (used to
 *     translate continuous-back-adjusted prices to raw-contract prices).
 *
 * BACK-ADJUSTMENT MATH
 *   TradingView's NQ1! shifts HISTORICAL prices UP by the spread at every
 *   contract roll, so the chart looks gapless going forward. Therefore:
 *     continuous(historical_T) = raw(historical_T) + Σ(spreads of rolls AFTER T)
 *     raw(historical_T) = continuous(historical_T) - Σ(spreads of rolls AFTER T)
 *   We SUBTRACT the cumulative-spread-after-T to recover the raw contract price.
 *
 * OUTPUT
 *   A single CSV with columns:
 *     timestamp_iso, unix_ms, sentiment_raw, level_1, level_2, level_3,
 *     level_4, level_5, source_symbol, was_backadjusted, raw_contract
 *
 *   Each row is one bar's LT snapshot, in raw-contract NQ price space.
 *   `raw_contract` is the inferred front contract (NQH5, NQM5, …) at that
 *   timestamp based on the rollover log.
 *
 * USAGE
 *   node research/lt-extraction/parse-lt-export.js \
 *     --in research/lt-extraction/exports/tv-NQ1!-5m-2025-Q1.csv \
 *     --in research/lt-extraction/exports/tv-NQ1!-5m-2025-Q2.csv \
 *     --symbol "NQ1!" \
 *     --out research/lt-extraction/output/nq_lt_5m_raw.csv
 *
 *   --in can be repeated to merge multiple chunked exports
 *   --symbol controls back-adjustment translation:
 *       NQ1! / continuous symbol → translate via rollover log
 *       NQM5 / specific contract → no translation (already raw)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const ROLLOVER_LOG = path.join(ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { ins: [], symbol: 'NQ1!', out: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--in') out.ins.push(args[++i]);
    else if (args[i] === '--symbol') out.symbol = args[++i];
    else if (args[i] === '--out') out.out = args[++i];
  }
  if (!out.ins.length || !out.out) {
    console.error('Usage: --in PATH (repeatable) --symbol "NQ1!" --out PATH');
    process.exit(1);
  }
  return out;
}

function isContinuous(symbol) {
  return /^NQ\d*!/.test(symbol) || symbol.toUpperCase().endsWith('1!');
}

// ──────────────────────────────────────────────────────────────────────────
// Rollover log → cumulative back-adjustment per timestamp
//
// TradingView's continuous front-month back-adjusts historical prices UP
// by the spread at each rollover (the most recent contract is the anchor;
// older bars get shifted up to align with current prices). So:
//   continuous_price(T) = raw_price(T) + sum(spreads of rolls AFTER T)
// To recover raw price from continuous:
//   raw_price(T) = continuous_price(T) - sum(spreads of rolls AFTER T)
// ──────────────────────────────────────────────────────────────────────────
async function loadRollovers() {
  if (!fs.existsSync(ROLLOVER_LOG)) {
    throw new Error(`Rollover log not found: ${ROLLOVER_LOG}`);
  }
  const rolls = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(ROLLOVER_LOG).pipe(csv())
      .on('data', (row) => {
        const date = row.date;
        const spread = parseFloat(row.spread);
        const fromSym = row.from_symbol;
        const toSym = row.to_symbol;
        if (!date || isNaN(spread)) return;
        // Use the date at end-of-day UTC as the rollover instant.
        // Bars on the rollover date BEFORE end-of-day are still on the old
        // contract; bars after roll to the new contract. We treat the
        // rollover as effective at 21:00 UTC (16:00 ET, after RTH close).
        const ts = new Date(date + 'T21:00:00.000Z').getTime();
        rolls.push({ ts, date, fromSym, toSym, spread });
      })
      .on('end', resolve).on('error', reject);
  });
  rolls.sort((a, b) => a.ts - b.ts);
  return rolls;
}

function makeBackAdjuster(rolls) {
  // For a given timestamp, sum spreads of rolls strictly AFTER ts.
  // Implementation: precompute reverse-cumulative spread array.
  const cumAfter = new Array(rolls.length + 1).fill(0);
  for (let i = rolls.length - 1; i >= 0; i--) {
    cumAfter[i] = cumAfter[i + 1] + rolls[i].spread;
  }
  return (ts) => {
    // Find first roll with ts > target via binary search
    let lo = 0, hi = rolls.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rolls[mid].ts <= ts) lo = mid + 1; else hi = mid;
    }
    return cumAfter[lo];
  };
}

function frontContractAt(ts, rolls) {
  // Walks forward to find the contract name in effect at ts.
  // The first contract is rolls[0].fromSym; after roll i, contract is rolls[i].toSym.
  if (!rolls.length) return null;
  if (ts < rolls[0].ts) return rolls[0].fromSym;
  let cur = rolls[0].fromSym;
  for (const r of rolls) {
    if (r.ts <= ts) cur = r.toSym;
    else break;
  }
  return cur;
}

// ──────────────────────────────────────────────────────────────────────────
// TV export parsing
//
// Each bar produced 2 orders (close + entry). The entry comment carries the
// LT levels. We collect ENTRY rows (Type contains "Entry long" or "Buy").
//
// Comment format (from lt-dumper.pine):
//   1=PRICE|2=PRICE|3=PRICE|4=PRICE|5=PRICE|S=SENTIMENT[|T=YYYYMMDDTHHMM]
// ──────────────────────────────────────────────────────────────────────────
function parseLtComment(comment) {
  if (!comment) return null;
  const out = {};
  for (const part of comment.split('|')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = v;
  }
  // Validate required keys
  if (out['1'] == null || out['2'] == null || out['3'] == null ||
      out['4'] == null || out['5'] == null) return null;
  return {
    level_1: parseFloat(out['1']),
    level_2: parseFloat(out['2']),
    level_3: parseFloat(out['3']),
    level_4: parseFloat(out['4']),
    level_5: parseFloat(out['5']),
    sentiment: out['S'] != null ? parseFloat(out['S']) : null,
    bar_ts_utc: out['T'] || null,  // YYYYMMDDTHHMM
  };
}

function parseBarTs(tStr) {
  // YYYYMMDDTHHMM -> ms epoch (UTC)
  if (!tStr || tStr.length !== 13) return null;
  const y = +tStr.slice(0, 4);
  const mo = +tStr.slice(4, 6) - 1;
  const d = +tStr.slice(6, 8);
  const h = +tStr.slice(9, 11);
  const mi = +tStr.slice(11, 13);
  return Date.UTC(y, mo, d, h, mi, 0);
}

function parseTvDateTime(s) {
  // TV exports vary: "2025-01-13 09:30:00" or "01/13/2025 09:30" (with TZ).
  // Try ISO first, then a few common patterns. All assumed UTC.
  // (The bar_ts in the comment is more reliable; fall back to this only.)
  if (!s) return null;
  const iso = Date.parse(s + (s.includes('T') ? '' : 'Z').replace(' ', 'T'));
  if (!isNaN(iso)) return iso;
  // mm/dd/yyyy hh:mm
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], 0);
  return null;
}

async function parseTvCsv(filePath) {
  const rows = [];
  const headers = { dateCol: null, typeCol: null, commentCol: null };
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('headers', (h) => {
        // First pass: pick the most specific match for each role.
        for (const col of h) {
          const lc = col.toLowerCase();
          if (lc === 'type') headers.typeCol = col;
          else if (lc.includes('date') && lc.includes('time')) headers.dateCol = col;
        }
        // Second pass: assign Signal to commentCol (TV uses Signal for both
        // entry comments and exit markers like "X").
        for (const col of h) {
          const lc = col.toLowerCase();
          if (lc.includes('signal') && col !== headers.typeCol) {
            headers.commentCol ??= col;
          }
          if (lc.includes('comment') || lc.includes('note')) {
            headers.commentCol ??= col;
          }
        }
      })
      .on('data', (row) => {
        // Final fallback: if commentCol still unset, find the first column
        // whose value matches the LT pipe-pattern. Re-evaluated per row
        // until found (TV's first row is always an Exit, no LT pattern).
        if (!headers.commentCol) {
          for (const k of Object.keys(row)) {
            const v = row[k];
            if (typeof v === 'string' && v.includes('1=') && v.includes('2=') && v.includes('|')) {
              headers.commentCol = k;
              break;
            }
          }
        }
        const type = headers.typeCol ? (row[headers.typeCol] || '').toLowerCase() : '';
        const comment = headers.commentCol ? row[headers.commentCol] : null;
        // Only keep ENTRY rows. Exit rows have comment "X" (no levels).
        const isEntry = type.includes('entry') || type === 'buy' || type.includes('open');
        if (!isEntry && type) return;
        const lt = parseLtComment(comment);
        if (!lt) return;
        const tvDate = headers.dateCol ? row[headers.dateCol] : null;
        rows.push({ tvDate, lt });
      })
      .on('end', resolve).on('error', reject);
  });
  return rows;
}

async function main() {
  const args = parseArgs();
  console.log(`Inputs:  ${args.ins.length} file(s)`);
  console.log(`Symbol:  ${args.symbol}`);
  console.log(`Output:  ${args.out}`);

  const continuous = isContinuous(args.symbol);
  console.log(`Translation: ${continuous ? 'YES — continuous symbol, applying rollover back-adjustment' : 'no — specific contract'}`);

  const rolls = await loadRollovers();
  console.log(`Rollover log: ${rolls.length} rollovers loaded`);
  const cumBackAdjAfter = makeBackAdjuster(rolls);

  // Parse all input CSVs
  const allRows = [];
  for (const inPath of args.ins) {
    const rows = await parseTvCsv(inPath);
    console.log(`  ${path.basename(inPath)}: ${rows.length} bar entries`);
    // Avoid spread (arguments-length limit ~100k on V8) — push in a loop.
    for (const r of rows) allRows.push(r);
  }
  console.log(`Total entries: ${allRows.length}`);

  // Resolve each row's timestamp; prefer the bar_ts embedded in the comment.
  const records = [];
  let dropped = 0;
  for (const r of allRows) {
    let ts = parseBarTs(r.lt.bar_ts_utc);
    if (ts == null) ts = parseTvDateTime(r.tvDate);
    if (ts == null) { dropped++; continue; }
    records.push({ ts, lt: r.lt });
  }
  if (dropped) console.warn(`Dropped ${dropped} rows with unresolvable timestamps`);

  // Dedupe (TV chunks may overlap on the boundary bar)
  records.sort((a, b) => a.ts - b.ts);
  const unique = [];
  let lastTs = -1;
  for (const r of records) {
    if (r.ts === lastTs) continue;
    unique.push(r);
    lastTs = r.ts;
  }
  console.log(`After dedupe: ${unique.length}`);

  // Translate to raw-contract space if needed.
  // raw = continuous - cum_spread_after_T  (TV back-adjusts historical UP)
  const lines = ['timestamp_iso,unix_ms,sentiment_raw,level_1,level_2,level_3,level_4,level_5,source_symbol,was_backadjusted,raw_contract'];
  for (const { ts, lt } of unique) {
    const adj = continuous ? cumBackAdjAfter(ts) : 0;
    const rawContract = frontContractAt(ts, rolls) ?? '';
    const iso = new Date(ts).toISOString();
    const raw = (lvl) => isNaN(lvl) ? 'NaN' : (lvl - adj).toFixed(2);
    lines.push([
      iso, ts,
      lt.sentiment != null && !isNaN(lt.sentiment) ? lt.sentiment : '',
      raw(lt.level_1), raw(lt.level_2), raw(lt.level_3), raw(lt.level_4), raw(lt.level_5),
      args.symbol,
      continuous ? 'true' : 'false',
      rawContract,
    ].join(','));
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, lines.join('\n') + '\n');
  console.log(`\nWrote ${args.out} (${unique.length} rows)`);

  // Summary: print first 3 and last 3 rows for visual sanity
  if (unique.length) {
    console.log('\nFirst 3 rows:');
    for (let i = 0; i < Math.min(3, unique.length); i++) {
      const r = unique[i];
      console.log(`  ${new Date(r.ts).toISOString()}  L1=${r.lt.level_1.toFixed(2)} L5=${r.lt.level_5.toFixed(2)}  ${continuous ? '−' + cumBackAdjAfter(r.ts).toFixed(2) + '→raw' : ''}`);
    }
    if (unique.length > 6) console.log('  …');
    console.log('Last 3 rows:');
    for (let i = Math.max(0, unique.length - 3); i < unique.length; i++) {
      const r = unique[i];
      console.log(`  ${new Date(r.ts).toISOString()}  L1=${r.lt.level_1.toFixed(2)} L5=${r.lt.level_5.toFixed(2)}  ${continuous ? '−' + cumBackAdjAfter(r.ts).toFixed(2) + '→raw' : ''}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
