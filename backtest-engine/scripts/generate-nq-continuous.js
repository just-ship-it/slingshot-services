#!/usr/bin/env node
/**
 * Generate NQ Continuous Back-Adjusted Dataset
 *
 * Reads the raw NQ_ohlcv_1m.csv (and optionally NQ_ohlcv_1s.csv), detects
 * quarterly contract rollovers, computes spreads from overlapping bars,
 * and writes back-adjusted continuous data.
 *
 * Output:
 *   - NQ_ohlcv_1m_continuous.csv  (back-adjusted 1m series)
 *   - NQ_ohlcv_1s_continuous.csv  (back-adjusted 1s series, stream-processed)
 *   - NQ_rollover_log.csv         (rollover metadata)
 *
 * Usage:
 *   node scripts/generate-nq-continuous.js [--skip-1s] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data', 'ohlcv', 'nq');
const INPUT_1M = path.join(DATA_DIR, 'NQ_ohlcv_1m.csv');
const INPUT_1S = path.join(DATA_DIR, 'NQ_ohlcv_1s.csv');
const OUTPUT_1M = path.join(DATA_DIR, 'NQ_ohlcv_1m_continuous.csv');
const OUTPUT_1S = path.join(DATA_DIR, 'NQ_ohlcv_1s_continuous.csv');
const ROLLOVER_LOG = path.join(DATA_DIR, 'NQ_rollover_log.csv');

// Parse CLI args
const args = process.argv.slice(2);
const skip1s = args.includes('--skip-1s');
let startDate = null;
let endDate = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--start' && args[i + 1]) startDate = args[i + 1];
  if (args[i] === '--end' && args[i + 1]) endDate = args[i + 1];
}

// ─── Phase 1: Load and process 1-minute data ─────────────────────────────────

console.log('Loading raw NQ 1m OHLCV...');
const raw1m = fs.readFileSync(INPUT_1M, 'utf-8');
const lines = raw1m.split('\n');
const header = lines[0];

// Parse all candles, filtering calendar spreads
const candles = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  // CSV: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
  const parts = line.split(',');
  const symbol = parts[9];

  // Skip calendar spreads (contain a dash)
  if (symbol.includes('-')) continue;

  const ts = parts[0];
  const open = parseFloat(parts[4]);
  const high = parseFloat(parts[5]);
  const low = parseFloat(parts[6]);
  const close = parseFloat(parts[7]);
  const volume = parseFloat(parts[8]);

  // Apply date filters
  if (startDate && ts < startDate) continue;
  if (endDate && ts > endDate) continue;

  candles.push({ ts, open, high, low, close, volume, symbol });
}

console.log(`  Loaded ${candles.length.toLocaleString()} raw candles`);

// Count unique symbols
const uniqueSymbols = new Set(candles.map(c => c.symbol));
console.log(`  Contracts: ${uniqueSymbols.size} (${[...uniqueSymbols].join(', ')})`);

// ─── Detect rollovers ────────────────────────────────────────────────────────

console.log('\nDetecting true rollovers...');

// Group candles by date and find primary contract per day (by total volume)
const dailyVolume = new Map(); // date -> Map<symbol, totalVolume>
for (const c of candles) {
  const date = c.ts.slice(0, 10); // YYYY-MM-DD
  if (!dailyVolume.has(date)) dailyVolume.set(date, new Map());
  const dv = dailyVolume.get(date);
  dv.set(c.symbol, (dv.get(c.symbol) || 0) + c.volume);
}

// Find primary contract per day
const dailyPrimary = []; // [{date, symbol}]
for (const [date, volumes] of [...dailyVolume].sort((a, b) => a[0].localeCompare(b[0]))) {
  let maxVol = -1;
  let maxSym = null;
  for (const [sym, vol] of volumes) {
    if (vol > maxVol) {
      maxVol = vol;
      maxSym = sym;
    }
  }
  dailyPrimary.push({ date, symbol: maxSym });
}

// Detect rollovers with persistence check (new contract must stay dominant for 2+ days)
const rollovers = [];
let prevSymbol = dailyPrimary[0].symbol;

for (let i = 1; i < dailyPrimary.length; i++) {
  const currSymbol = dailyPrimary[i].symbol;
  if (currSymbol !== prevSymbol) {
    // Check persistence: does new contract stay dominant?
    const futureSlice = dailyPrimary.slice(i, i + 5);
    const dominantCount = futureSlice.filter(d => d.symbol === currSymbol).length;
    if (futureSlice.length >= 2 && dominantCount >= 2) {
      rollovers.push({
        date: dailyPrimary[i].date,
        from_symbol: prevSymbol,
        to_symbol: currSymbol,
        spread: 0,
        overlap_bars: 0,
        spread_min: 0,
        spread_max: 0,
      });
      prevSymbol = currSymbol;
    }
    // else: volume flicker, ignore
  }
}

console.log(`  Found ${rollovers.length} true rollovers (flicker filtered)`);

// ─── Compute rollover spreads ────────────────────────────────────────────────

console.log('\nComputing rollover spreads from overlapping bars...');

// Index candles by timestamp for overlap lookup
// Build per-symbol timestamp -> close maps for the overlap windows
for (const r of rollovers) {
  const rollDate = new Date(r.date + 'T00:00:00Z');
  const windowStart = new Date(rollDate.getTime() - 12 * 60 * 60 * 1000);
  const windowEnd = new Date(rollDate.getTime() + 12 * 60 * 60 * 1000);
  const wsStr = windowStart.toISOString();
  const weStr = windowEnd.toISOString();

  // Collect close prices by timestamp for both contracts in the window
  const fromCloses = new Map(); // ts -> close
  const toCloses = new Map();   // ts -> close

  for (const c of candles) {
    if (c.ts < wsStr || c.ts > weStr) continue;
    if (c.symbol === r.from_symbol) fromCloses.set(c.ts, c.close);
    if (c.symbol === r.to_symbol) toCloses.set(c.ts, c.close);
  }

  // Find overlapping timestamps
  const overlapTs = [];
  for (const ts of fromCloses.keys()) {
    if (toCloses.has(ts)) overlapTs.push(ts);
  }

  if (overlapTs.length > 0) {
    // Compute spreads: new - old
    const spreads = overlapTs.map(ts => toCloses.get(ts) - fromCloses.get(ts));
    spreads.sort((a, b) => a - b);

    // Median
    const mid = Math.floor(spreads.length / 2);
    const median = spreads.length % 2 === 0
      ? (spreads[mid - 1] + spreads[mid]) / 2
      : spreads[mid];

    r.spread = median;
    r.overlap_bars = overlapTs.length;
    r.spread_min = spreads[0];
    r.spread_max = spreads[spreads.length - 1];

    console.log(`  ${r.date}  ${r.from_symbol} -> ${r.to_symbol}  spread: ${median >= 0 ? '+' : ''}${median.toFixed(2)} pts  (overlap: ${overlapTs.length} bars, range: [${spreads[0].toFixed(2)}, ${spreads[spreads.length - 1].toFixed(2)}])`);
  } else {
    // No overlap - use last close of old contract and first close of new
    let lastOld = null;
    let firstNew = null;
    for (const c of candles) {
      if (c.symbol === r.from_symbol && c.ts < r.date + 'T00:00:00') lastOld = c.close;
      if (c.symbol === r.to_symbol && c.ts >= r.date + 'T00:00:00' && firstNew === null) firstNew = c.close;
    }

    const spread = (firstNew != null && lastOld != null) ? firstNew - lastOld : 0;
    r.spread = spread;
    r.overlap_bars = 0;
    r.spread_min = spread;
    r.spread_max = spread;
    console.log(`  ${r.date}  ${r.from_symbol} -> ${r.to_symbol}  spread: ${spread >= 0 ? '+' : ''}${spread.toFixed(2)} pts  (NO overlap, using last/first)`);
  }
}

// ─── Build continuous 1m series ──────────────────────────────────────────────

console.log('\nBuilding continuous 1m series...');

// Create contract assignment periods
const firstContract = rollovers.length > 0 ? rollovers[0].from_symbol : dailyPrimary[0].symbol;
const periods = [];
let prevStart = candles[0].ts;
let prevSym = firstContract;

for (const r of rollovers) {
  const switchTs = r.date + 'T00:00:00'; // Switch at midnight UTC of rollover date
  periods.push({ start: prevStart, end: switchTs, symbol: prevSym });
  prevStart = switchTs;
  prevSym = r.to_symbol;
}
// Last period
periods.push({ start: prevStart, end: '9999-12-31T23:59:59', symbol: prevSym });

console.log(`  Contract periods: ${periods.length}`);
for (const p of periods) {
  console.log(`    ${p.start.slice(0, 10)} -> ${p.end.slice(0, 10)}  ${p.symbol}`);
}

// Filter: keep only bars from the active contract in each period
// Build a map: contract -> adjustment (to be computed)
const contractAdjustment = new Map(); // contract symbol -> cumulative back-adjustment

// Compute cumulative adjustment: walk backwards from most recent
// Most recent contract (NQH6) has 0 adjustment — its prices are actual market prices.
// For each prior period, ADD the rollover spread to connect old bars to new bars.
// spread = new_close - old_close (positive when new contract trades higher)
// To make old bars meet new bars: adjusted_old = raw_old + spread
const periodAdjustments = new Array(periods.length).fill(0);
for (let i = periods.length - 2; i >= 0; i--) {
  // The rollover at index i transitions from periods[i] to periods[i+1]
  periodAdjustments[i] = periodAdjustments[i + 1] + rollovers[i].spread;
}

for (let i = 0; i < periods.length; i++) {
  contractAdjustment.set(periods[i].symbol + '|' + i, periodAdjustments[i]);
  if (periodAdjustments[i] !== 0) {
    console.log(`  ${periods[i].symbol} (period ${i}): adjustment ${periodAdjustments[i] >= 0 ? '+' : ''}${periodAdjustments[i].toFixed(2)} pts`);
  }
}

// Filter candles to only keep primary contract per period, and apply back-adjustment
const continuous1m = [];
let periodIdx = 0;

for (const c of candles) {
  // Advance period if needed
  while (periodIdx < periods.length - 1 && c.ts >= periods[periodIdx].end) {
    periodIdx++;
  }

  // Only keep candles from this period's active contract
  if (c.symbol !== periods[periodIdx].symbol) continue;

  const adj = periodAdjustments[periodIdx];
  continuous1m.push({
    ts: c.ts,
    open: c.open + adj,
    high: c.high + adj,
    low: c.low + adj,
    close: c.close + adj,
    volume: c.volume,
    contract: c.symbol,
  });
}

// De-duplicate by timestamp (keep last)
const deduped = new Map();
for (const c of continuous1m) {
  deduped.set(c.ts, c);
}
const finalCandles = [...deduped.values()];

console.log(`  Bars after filtering: ${finalCandles.length.toLocaleString()}`);

// Verify continuity - check for large jumps at rollover boundaries
console.log('\nVerifying continuity...');
let bigMoves = 0;
for (let i = 1; i < finalCandles.length; i++) {
  const diff = Math.abs(finalCandles[i].close - finalCandles[i - 1].close);
  if (diff > 100) {
    bigMoves++;
    if (bigMoves <= 10) {
      console.log(`  WARNING: ${finalCandles[i].ts}  delta=${diff.toFixed(2)}  ${finalCandles[i - 1].contract} -> ${finalCandles[i].contract}`);
    }
  }
}
if (bigMoves === 0) {
  console.log('  No discontinuities > 100 pts detected');
} else {
  console.log(`  ${bigMoves} bars with > 100 pt moves (may include real volatility events)`);
}

// ─── Write 1m continuous CSV ─────────────────────────────────────────────────

console.log(`\nWriting 1m continuous to ${OUTPUT_1M}...`);

// Format timestamp to match ES continuous format: "2020-12-27 23:00:00+00:00"
function formatTs(ts) {
  // Input: "2020-12-27T23:00:00.000000000Z"
  // Output: "2020-12-27 23:00:00+00:00"
  return ts.replace('T', ' ').replace(/\.0+Z$/, '+00:00').replace('Z', '+00:00');
}

const writeStream1m = fs.createWriteStream(OUTPUT_1M);
writeStream1m.write('ts_event,open,high,low,close,volume,symbol,contract\n');

for (const c of finalCandles) {
  writeStream1m.write(`${formatTs(c.ts)},${c.open},${c.high},${c.low},${c.close},${c.volume},NQ_continuous,${c.contract}\n`);
}

writeStream1m.end();
await new Promise(resolve => writeStream1m.on('finish', resolve));
console.log(`  Written ${finalCandles.length.toLocaleString()} bars`);

// ─── Write rollover log ──────────────────────────────────────────────────────

console.log(`\nWriting rollover log to ${ROLLOVER_LOG}...`);
const logLines = ['date,from_symbol,to_symbol,spread,overlap_bars,spread_min,spread_max'];
for (const r of rollovers) {
  logLines.push(`${r.date},${r.from_symbol},${r.to_symbol},${r.spread},${r.overlap_bars},${r.spread_min},${r.spread_max}`);
}
fs.writeFileSync(ROLLOVER_LOG, logLines.join('\n') + '\n');
console.log(`  ${rollovers.length} rollovers logged`);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log('SUMMARY');
console.log('='.repeat(60));
console.log(`  Date range: ${finalCandles[0].ts.slice(0, 10)} -> ${finalCandles[finalCandles.length - 1].ts.slice(0, 10)}`);
console.log(`  Total 1m bars: ${finalCandles.length.toLocaleString()}`);
console.log(`  Rollovers: ${rollovers.length}`);
const totalAdj = rollovers.reduce((sum, r) => sum + r.spread, 0);
console.log(`  Total back-adjustment: ${totalAdj >= 0 ? '+' : ''}${totalAdj.toFixed(2)} pts`);
console.log(`  Most recent contract: ${finalCandles[finalCandles.length - 1].contract} (unadjusted prices)`);
console.log(`  Earliest contract: ${finalCandles[0].contract} (adjusted by ${totalAdj >= 0 ? '+' : ''}${totalAdj.toFixed(2)} pts)`);

// ─── Phase 2: Stream-process 1-second data ───────────────────────────────────

if (skip1s) {
  console.log('\n--skip-1s flag set, skipping 1s processing');
  process.exit(0);
}

if (!fs.existsSync(INPUT_1S)) {
  console.log(`\n1s data file not found: ${INPUT_1S}`);
  console.log('Skipping 1s processing. Run without --skip-1s when file is available.');
  process.exit(0);
}

console.log(`\n${'='.repeat(60)}`);
console.log('Processing 1-second data (stream mode)...');
console.log('='.repeat(60));

// Build contract -> adjustment lookup from rollovers
// For each contract, determine the adjustment based on which period it falls in
// We need: for a given symbol + timestamp, what adjustment applies?
// Approach: build sorted list of (switchTimestamp, contractSymbol, adjustment)
const switchPoints = []; // [{ts, symbol, adjustment}]
switchPoints.push({
  ts: '0000-00-00T00:00:00',
  symbol: periods[0].symbol,
  adjustment: periodAdjustments[0],
});
for (let i = 0; i < rollovers.length; i++) {
  switchPoints.push({
    ts: rollovers[i].date + 'T00:00:00',
    symbol: periods[i + 1].symbol,
    adjustment: periodAdjustments[i + 1],
  });
}

// Build a per-contract adjustment map (simple: contract -> adjustment)
// Each contract only appears in one period
const contractAdj = new Map();
for (let i = 0; i < periods.length; i++) {
  contractAdj.set(periods[i].symbol, periodAdjustments[i]);
}

// Also need to know which contract is primary at each point
// For 1s data, we filter by the same contract periods
console.log(`  Contract adjustments: ${[...contractAdj].map(([k, v]) => `${k}=${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join(', ')}`);

// Stream-process the 1s file
const input1s = fs.createReadStream(INPUT_1S, { encoding: 'utf-8' });
const rl = readline.createInterface({ input: input1s, crlfDelay: Infinity });

const writeStream1s = fs.createWriteStream(OUTPUT_1S);
writeStream1s.write('ts_event,open,high,low,close,volume,symbol,contract\n');

let linesRead = 0;
let linesWritten = 0;
let skippedSpread = 0;
let skippedNonPrimary = 0;
let currentPeriodIdx = 0;
let isHeader = true;

const startTime = Date.now();

for await (const line of rl) {
  if (isHeader) {
    isHeader = false;
    continue;
  }

  linesRead++;
  if (linesRead % 10_000_000 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Processed ${(linesRead / 1_000_000).toFixed(1)}M lines, written ${(linesWritten / 1_000_000).toFixed(1)}M (${elapsed}s)`);
  }

  // CSV: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
  const parts = line.split(',');
  if (parts.length < 10) continue;

  const symbol = parts[9];
  // Skip calendar spreads
  if (symbol.includes('-')) {
    skippedSpread++;
    continue;
  }

  const ts = parts[0];

  // Apply date filters
  if (startDate && ts < startDate) continue;
  if (endDate && ts > endDate) continue;

  // Advance period if needed
  while (currentPeriodIdx < periods.length - 1 && ts >= periods[currentPeriodIdx].end) {
    currentPeriodIdx++;
  }

  // Only keep candles from this period's active contract
  if (symbol !== periods[currentPeriodIdx].symbol) {
    skippedNonPrimary++;
    continue;
  }

  const adj = periodAdjustments[currentPeriodIdx];
  const open = parseFloat(parts[4]) + adj;
  const high = parseFloat(parts[5]) + adj;
  const low = parseFloat(parts[6]) + adj;
  const close = parseFloat(parts[7]) + adj;
  const volume = parts[8];

  writeStream1s.write(`${formatTs(ts)},${open},${high},${low},${close},${volume},NQ_continuous,${symbol}\n`);
  linesWritten++;
}

writeStream1s.end();
await new Promise(resolve => writeStream1s.on('finish', resolve));

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n  1s processing complete:`);
console.log(`    Lines read: ${linesRead.toLocaleString()}`);
console.log(`    Lines written: ${linesWritten.toLocaleString()}`);
console.log(`    Skipped (calendar spreads): ${skippedSpread.toLocaleString()}`);
console.log(`    Skipped (non-primary): ${skippedNonPrimary.toLocaleString()}`);
console.log(`    Time: ${totalTime}s`);
console.log(`    Output: ${OUTPUT_1S}`);
