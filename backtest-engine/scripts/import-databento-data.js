#!/usr/bin/env node
/**
 * Import Databento data to extend backtest coverage.
 *
 * Handles three datasets:
 *   --glbx <path>   NQ futures OHLCV 1-second CSV → aggregate to 1m, append
 *   --xnas <path>   QQQ OHLCV 1-minute CSV → deduplicate, append
 *   --opra <dir>    OPRA statistics daily CSVs → copy new files to statistics/qqq/
 *
 * Usage:
 *   node scripts/import-databento-data.js \
 *     --glbx /mnt/c/temp/data/GLBX-.../glbx-mdp3-...ohlcv-1s.csv \
 *     --xnas /mnt/c/temp/data/XNAS-.../xnas-itch-...ohlcv-1m.csv \
 *     --opra /mnt/c/temp/data/OPRA-.../
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--glbx' && args[i + 1]) { out.glbx = args[++i]; continue; }
    if (args[i] === '--xnas' && args[i + 1]) { out.xnas = args[++i]; continue; }
    if (args[i] === '--opra' && args[i + 1]) { out.opra = args[++i]; continue; }
  }
  return out;
}

/**
 * Get the last timestamp from an existing OHLCV CSV.
 */
function getLastTimestamp(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trimEnd().split('\n');
  const lastLine = lines[lines.length - 1];
  return lastLine.split(',')[0]; // ts_event is first column
}

/**
 * Floor a nanosecond ISO timestamp to the minute.
 * "2026-01-23T00:00:04.000000000Z" → "2026-01-23T00:00:00.000000000Z"
 */
function floorToMinute(ts) {
  return ts.slice(0, 17) + '00.000000000Z';
}

// ========================================================================
// Step 1: GLBX NQ 1s → 1m aggregation
// ========================================================================
async function importGLBX(csvPath) {
  const destPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
  const existingLastTs = getLastTimestamp(destPath);
  console.log(`\n=== GLBX NQ 1s → 1m ===`);
  console.log(`Source: ${csvPath}`);
  console.log(`Dest:   ${destPath}`);
  console.log(`Existing data ends: ${existingLastTs}`);
  console.log(`Will append rows with minute > ${floorToMinute(existingLastTs)}`);

  const cutoffMinute = floorToMinute(existingLastTs);

  // Track per-symbol per-minute buckets.
  // Key: "minuteTs|symbol" → accumulator
  //
  // We can't use a single "current bucket" because Databento delivers rows
  // sorted by (ts, sym) — when two symbols interleave within the same minute,
  // a current-bucket scheme flushes prematurely and creates fragmented duplicates.
  // Solution: hold all open buckets for the current minute in a Map; flush
  // them once the input ts moves to the next minute.
  const openBuckets = new Map(); // "minuteTs|sym" → bucket
  let currentMinute = null;
  const aggregated = []; // emitted in (minuteTs asc, sym asc) order

  function flushMinute(minute) {
    const keys = [];
    for (const k of openBuckets.keys()) {
      if (k.startsWith(minute + '|')) keys.push(k);
    }
    keys.sort();
    for (const k of keys) {
      aggregated.push(openBuckets.get(k));
      openBuckets.delete(k);
    }
  }

  // Rollover tracking: per-hour volume by symbol
  const hourlyVolume = new Map(); // "YYYY-MM-DDTHH|symbol" → volume

  let lineCount = 0;
  let skippedSpreads = 0;
  let skippedOld = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity
  });

  let header = null;
  let tsIdx, rtypeIdx, pubIdx, instIdx, openIdx, highIdx, lowIdx, closeIdx, volIdx, symIdx;

  for await (const line of rl) {
    if (!header) {
      header = line.split(',');
      tsIdx = header.indexOf('ts_event');
      rtypeIdx = header.indexOf('rtype');
      pubIdx = header.indexOf('publisher_id');
      instIdx = header.indexOf('instrument_id');
      openIdx = header.indexOf('open');
      highIdx = header.indexOf('high');
      lowIdx = header.indexOf('low');
      closeIdx = header.indexOf('close');
      volIdx = header.indexOf('volume');
      symIdx = header.indexOf('symbol');
      continue;
    }

    lineCount++;
    if (lineCount % 500000 === 0) process.stdout.write(`  ${(lineCount / 1e6).toFixed(1)}M rows read...\r`);

    const cols = line.split(',');
    const sym = cols[symIdx];

    // Filter calendar spreads
    if (sym.includes('-')) { skippedSpreads++; continue; }

    const ts = cols[tsIdx];
    const minuteTs = floorToMinute(ts);

    // Skip data that overlaps with existing
    if (minuteTs <= cutoffMinute) { skippedOld++; continue; }

    // When the minute changes, finalize all open buckets for the previous minute
    if (currentMinute !== null && minuteTs !== currentMinute) {
      flushMinute(currentMinute);
    }
    currentMinute = minuteTs;

    const bucketKey = `${minuteTs}|${sym}`;
    const high = parseFloat(cols[highIdx]);
    const low = parseFloat(cols[lowIdx]);
    const close = parseFloat(cols[closeIdx]);
    const volume = parseInt(cols[volIdx]) || 0;

    // Track hourly volume for rollover detection
    const hourKey = `${ts.slice(0, 13)}|${sym}`;
    hourlyVolume.set(hourKey, (hourlyVolume.get(hourKey) || 0) + volume);

    let bucket = openBuckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        ts: minuteTs,
        rtype: cols[rtypeIdx],
        pub: cols[pubIdx],
        inst: cols[instIdx],
        open: cols[openIdx],
        high: high,
        low: low,
        close: close,
        volume: volume,
        sym: sym
      };
      openBuckets.set(bucketKey, bucket);
    } else {
      if (high > bucket.high) bucket.high = high;
      if (low < bucket.low) bucket.low = low;
      bucket.close = close;
      bucket.volume += volume;
    }
  }
  // Flush any remaining buckets at EOF
  if (currentMinute !== null) flushMinute(currentMinute);

  console.log(`\n  Read ${lineCount.toLocaleString()} 1s rows`);
  console.log(`  Skipped ${skippedSpreads.toLocaleString()} calendar spread rows`);
  console.log(`  Skipped ${skippedOld.toLocaleString()} rows before cutoff`);
  console.log(`  Aggregated to ${aggregated.length.toLocaleString()} 1m bars`);

  // Sort by timestamp then symbol for consistent output
  aggregated.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.sym.localeCompare(b.sym));

  // Format and append — match existing format with 9-decimal prices
  const lines = aggregated.map(r =>
    `${r.ts},${r.rtype},${r.pub},${r.inst},${parseFloat(r.open).toFixed(9)},${r.high.toFixed(9)},${r.low.toFixed(9)},${r.close.toFixed(9)},${r.volume},${r.sym}`
  );

  fs.appendFileSync(destPath, '\n' + lines.join('\n'));

  const lastBar = aggregated[aggregated.length - 1];
  const firstBar = aggregated[0];
  const uniqueSyms = [...new Set(aggregated.map(r => r.sym))];
  console.log(`  Appended ${lines.length.toLocaleString()} rows`);
  console.log(`  Date range: ${firstBar.ts} → ${lastBar.ts}`);
  console.log(`  Symbols: ${uniqueSyms.join(', ')}`);

  // Detect rollover
  const rolloverInfo = detectRollover(hourlyVolume, 'NQH6', 'NQM6', aggregated);
  return rolloverInfo;
}

/**
 * Detect when NQM6 volume exceeds NQH6 volume per hour.
 */
function detectRollover(hourlyVolume, fromSym, toSym, aggregated) {
  // Find hours where both contracts traded
  const hours = new Set();
  for (const key of hourlyVolume.keys()) {
    const hour = key.split('|')[0];
    hours.add(hour);
  }

  let rolloverHour = null;
  const sortedHours = [...hours].sort();

  for (const hour of sortedHours) {
    const fromVol = hourlyVolume.get(`${hour}|${fromSym}`) || 0;
    const toVol = hourlyVolume.get(`${hour}|${toSym}`) || 0;
    if (toVol > fromVol && fromVol > 0 && toVol > 100) {
      rolloverHour = hour;
      break;
    }
  }

  if (!rolloverHour) {
    console.log(`\n  Rollover: Could not detect ${fromSym} → ${toSym} rollover`);
    return null;
  }

  const rolloverDate = rolloverHour.slice(0, 10);
  console.log(`\n  Rollover detected: ${fromSym} → ${toSym} at ${rolloverHour}`);

  // Find the spread at rollover: both contracts' close price at the rollover hour
  const rolloverMinutePrefix = rolloverHour; // "2026-03-18T14"
  const fromBars = aggregated.filter(r => r.sym === fromSym && r.ts.startsWith(rolloverMinutePrefix));
  const toBars = aggregated.filter(r => r.sym === toSym && r.ts.startsWith(rolloverMinutePrefix));

  if (fromBars.length > 0 && toBars.length > 0) {
    const fromClose = fromBars[fromBars.length - 1].close;
    const toClose = toBars[toBars.length - 1].close;
    const spread = toClose - fromClose;

    // Compute min/max spread across all overlapping bars on rollover date
    const datePrefix = rolloverDate;
    const fromDayBars = aggregated.filter(r => r.sym === fromSym && r.ts.startsWith(datePrefix));
    const toDayBars = aggregated.filter(r => r.sym === toSym && r.ts.startsWith(datePrefix));

    // Match by timestamp to compute spread range
    const fromByTs = new Map(fromDayBars.map(r => [r.ts, r]));
    let spreadMin = Infinity, spreadMax = -Infinity, overlapBars = 0;
    for (const to of toDayBars) {
      const from = fromByTs.get(to.ts);
      if (from) {
        const s = to.close - from.close;
        if (s < spreadMin) spreadMin = s;
        if (s > spreadMax) spreadMax = s;
        overlapBars++;
      }
    }

    console.log(`  Spread: ${spread.toFixed(2)} (range: ${spreadMin.toFixed(2)} - ${spreadMax.toFixed(2)}, ${overlapBars} overlap bars)`);
    return { date: rolloverDate, from: fromSym, to: toSym, spread, overlapBars, spreadMin, spreadMax };
  }

  console.log(`  Could not compute spread at rollover hour`);
  return { date: rolloverDate, from: fromSym, to: toSym, spread: null };
}

// ========================================================================
// Step 2: Update rollover log
// ========================================================================
function updateRolloverLog(rolloverInfo) {
  if (!rolloverInfo || rolloverInfo.spread === null) {
    console.log(`\n=== Rollover Log: SKIPPED (no rollover data) ===`);
    return;
  }

  const logPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_rollover_log.csv');
  const existing = fs.readFileSync(logPath, 'utf8');

  // Check if this rollover is already logged
  if (existing.includes(rolloverInfo.date)) {
    console.log(`\n=== Rollover Log: already contains ${rolloverInfo.date}, skipping ===`);
    return;
  }

  const row = `${rolloverInfo.date},${rolloverInfo.from},${rolloverInfo.to},${rolloverInfo.spread.toFixed(2)},${rolloverInfo.overlapBars},${rolloverInfo.spreadMin.toFixed(2)},${rolloverInfo.spreadMax.toFixed(2)}`;
  fs.appendFileSync(logPath, '\n' + row);
  console.log(`\n=== Rollover Log ===`);
  console.log(`  Appended: ${row}`);
}

// ========================================================================
// Step 3: XNAS QQQ 1m append
// ========================================================================
async function importXNAS(csvPath) {
  const destPath = path.join(DATA_DIR, 'ohlcv', 'qqq', 'QQQ_ohlcv_1m.csv');
  const existingLastTs = getLastTimestamp(destPath);
  console.log(`\n=== XNAS QQQ 1m ===`);
  console.log(`Source: ${csvPath}`);
  console.log(`Dest:   ${destPath}`);
  console.log(`Existing data ends: ${existingLastTs}`);

  const cutoff = existingLastTs;
  let lineCount = 0, appended = 0, skipped = 0;
  let firstTs = null, lastTs = null;
  const output = fs.createWriteStream(destPath, { flags: 'a' });
  let wroteFirst = false;

  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity
  });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    lineCount++;

    const ts = line.split(',')[0];
    if (ts <= cutoff) { skipped++; continue; }

    if (!wroteFirst) {
      output.write('\n' + line);
      wroteFirst = true;
    } else {
      output.write('\n' + line);
    }
    appended++;
    if (!firstTs) firstTs = ts;
    lastTs = ts;
  }

  output.end();
  await new Promise(resolve => output.on('finish', resolve));

  console.log(`  Read ${lineCount.toLocaleString()} rows`);
  console.log(`  Skipped ${skipped.toLocaleString()} rows before cutoff`);
  console.log(`  Appended ${appended.toLocaleString()} rows`);
  if (firstTs) console.log(`  Date range: ${firstTs} → ${lastTs}`);
}

// ========================================================================
// Step 4: OPRA statistics copy
// ========================================================================
function importOPRA(sourceDir) {
  const destDir = path.join(DATA_DIR, 'statistics', 'qqq');
  console.log(`\n=== OPRA Statistics ===`);
  console.log(`Source: ${sourceDir}`);
  console.log(`Dest:   ${destDir}`);

  const sourceFiles = fs.readdirSync(sourceDir)
    .filter(f => f.endsWith('.statistics.csv'))
    .sort();

  let copied = 0, skipped = 0;

  for (const file of sourceFiles) {
    const destFile = path.join(destDir, file);
    if (fs.existsSync(destFile)) {
      skipped++;
      continue;
    }
    fs.copyFileSync(path.join(sourceDir, file), destFile);
    copied++;
  }

  console.log(`  Found ${sourceFiles.length} statistics files`);
  console.log(`  Copied ${copied} new files, skipped ${skipped} existing`);

  if (copied > 0) {
    const allFiles = fs.readdirSync(destDir).filter(f => f.endsWith('.statistics.csv')).sort();
    console.log(`  Total statistics files: ${allFiles.length}`);
    console.log(`  Latest: ${allFiles[allFiles.length - 1]}`);
  }
}

// ========================================================================
// Main
// ========================================================================
async function main() {
  const args = parseArgs();

  if (!args.glbx && !args.xnas && !args.opra) {
    console.log('Usage: node import-databento-data.js --glbx <path> --xnas <path> --opra <dir>');
    console.log('  All flags are optional; provide any combination.');
    process.exit(1);
  }

  let rolloverInfo = null;

  if (args.glbx) {
    rolloverInfo = await importGLBX(args.glbx);
    updateRolloverLog(rolloverInfo);
  }

  if (args.xnas) {
    await importXNAS(args.xnas);
  }

  if (args.opra) {
    importOPRA(args.opra);
  }

  console.log('\n=== Done ===\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
