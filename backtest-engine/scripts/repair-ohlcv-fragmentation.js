#!/usr/bin/env node
/**
 * Repair OHLCV minute fragmentation.
 *
 * The bucket-fragmentation bug in import-databento-data.js created multiple
 * rows per (minute_ts, symbol) when 1s rows for different symbols interleaved
 * within the same minute. This script re-aggregates those fragmented rows
 * into one row per (minute_ts, symbol).
 *
 * Aggregation rule per group of (ts, sym):
 *   open   = first row's open  (input file preserves time order)
 *   close  = last row's close
 *   high   = max(high)
 *   low    = min(low)
 *   volume = sum(volume)
 *   rtype/publisher_id/instrument_id = first row's value
 *
 * Reads input streamed line-by-line. Emits one row per (ts, sym) group.
 * Calendar spreads (sym contains '-') pass through unchanged — they're
 * already filtered downstream by filterPrimaryContract.
 *
 * Usage:
 *   node scripts/repair-ohlcv-fragmentation.js <input.csv> <output.csv>
 */
import fs from 'fs';
import readline from 'readline';

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node repair-ohlcv-fragmentation.js <input.csv> <output.csv>');
    process.exit(1);
  }
  if (inputPath === outputPath) {
    console.error('Refusing to overwrite input in place — provide distinct paths.');
    process.exit(1);
  }

  console.log(`Input:  ${inputPath}`);
  console.log(`Output: ${outputPath}`);

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath),
    crlfDelay: Infinity,
  });
  const out = fs.createWriteStream(outputPath);

  let header = null;
  let tsIdx, rtypeIdx, pubIdx, instIdx, openIdx, highIdx, lowIdx, closeIdx, volIdx, symIdx;

  // Streaming aggregation: keep groups in a Map keyed by (ts, sym).
  // Flush a group when we move past its minute (no more rows can join).
  // To do this safely we wait until the input ts strictly exceeds a group's ts.
  //
  // The stream processes rows in input order. We track the latest ts seen.
  // Once latestTs > group.ts, the group is final → emit and remove.
  const groups = new Map(); // key: `${ts}|${sym}`, val: row accumulator
  let latestTs = null;
  let inputRows = 0;
  let outputRows = 0;
  let spreadRows = 0;

  // Maintain emit order: groups are emitted in (ts asc, sym asc)
  // We sort the keys to emit, but only emit groups where ts < latestTs (finalized).
  // For efficiency, also maintain a sorted set of timestamps with active groups.
  const tsToKeys = new Map(); // ts -> Set of bucketKeys
  const tsOrder = []; // sorted array of ts values currently in tsToKeys

  function emitFinalized(currentTs) {
    // Emit all groups whose ts < currentTs (or all if currentTs === null at EOF)
    while (tsOrder.length > 0) {
      const ts = tsOrder[0];
      if (currentTs !== null && ts >= currentTs) break;
      const keys = [...(tsToKeys.get(ts) || [])].sort();
      for (const key of keys) {
        const g = groups.get(key);
        if (!g) continue;
        out.write(formatRow(g) + '\n');
        outputRows++;
        groups.delete(key);
      }
      tsToKeys.delete(ts);
      tsOrder.shift();
    }
  }

  function formatRow(g) {
    return [
      g.ts,
      g.rtype,
      g.pub,
      g.inst,
      g.open,                    // already a string from input — preserve formatting
      g.high.toFixed(9),
      g.low.toFixed(9),
      g.close,                   // already a string from input
      g.volume,
      g.sym,
    ].join(',');
  }

  for await (const line of rl) {
    if (!line) continue;
    if (header === null) {
      header = line;
      tsIdx = 0;
      rtypeIdx = 1;
      pubIdx = 2;
      instIdx = 3;
      openIdx = 4;
      highIdx = 5;
      lowIdx = 6;
      closeIdx = 7;
      volIdx = 8;
      symIdx = 9;
      out.write(header + '\n');
      continue;
    }

    inputRows++;
    if (inputRows % 500000 === 0) {
      process.stdout.write(`  ${(inputRows / 1e6).toFixed(1)}M rows read, ${outputRows.toLocaleString()} written\r`);
    }

    const cols = line.split(',');
    const ts = cols[tsIdx];
    const sym = cols[symIdx];

    // Calendar spreads pass through with no aggregation (they have unique-ish keys
    // but downstream filterPrimaryContract drops them anyway).
    if (sym.includes('-')) {
      // Still respect tsOrder so they emit at the right time.
      // Insert into a per-row group (one row → one output).
      spreadRows++;
      // Use a sentinel sym that includes the row index so it never merges.
      const key = `${ts}|${sym}|spread${inputRows}`;
      groups.set(key, {
        ts,
        rtype: cols[rtypeIdx],
        pub: cols[pubIdx],
        inst: cols[instIdx],
        open: cols[openIdx],
        high: parseFloat(cols[highIdx]),
        low: parseFloat(cols[lowIdx]),
        close: cols[closeIdx],
        volume: parseInt(cols[volIdx]) || 0,
        sym,
      });
      if (!tsToKeys.has(ts)) {
        tsToKeys.set(ts, new Set());
        tsOrder.push(ts);
      }
      tsToKeys.get(ts).add(key);
    } else {
      const key = `${ts}|${sym}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          ts,
          rtype: cols[rtypeIdx],
          pub: cols[pubIdx],
          inst: cols[instIdx],
          open: cols[openIdx],
          high: parseFloat(cols[highIdx]),
          low: parseFloat(cols[lowIdx]),
          close: cols[closeIdx],
          volume: parseInt(cols[volIdx]) || 0,
          sym,
        };
        groups.set(key, g);
        if (!tsToKeys.has(ts)) {
          tsToKeys.set(ts, new Set());
          tsOrder.push(ts);
        }
        tsToKeys.get(ts).add(key);
      } else {
        const high = parseFloat(cols[highIdx]);
        const low = parseFloat(cols[lowIdx]);
        if (high > g.high) g.high = high;
        if (low < g.low) g.low = low;
        // close = last row's close (input is in time order within same ts,sym)
        g.close = cols[closeIdx];
        g.volume += parseInt(cols[volIdx]) || 0;
      }
    }

    // Update latestTs and flush groups whose ts is strictly less.
    // CSVs from importer are mostly ts-sorted but we cannot assume strict order,
    // so we use latestTs (the maximum ts seen so far) as the conservative cutoff.
    if (latestTs === null || ts > latestTs) {
      latestTs = ts;
      // Flush any groups with ts < latestTs
      emitFinalized(latestTs);
    }
  }

  // EOF — emit everything remaining
  emitFinalized(null);
  out.end();
  await new Promise((resolve) => out.on('finish', resolve));

  console.log(`\nDone.`);
  console.log(`  Input rows:  ${inputRows.toLocaleString()}`);
  console.log(`  Output rows: ${outputRows.toLocaleString()}`);
  console.log(`  Reduction:   ${(inputRows - outputRows).toLocaleString()} rows merged (${((1 - outputRows / inputRows) * 100).toFixed(2)}%)`);
  console.log(`  Spread rows passed through: ${spreadRows.toLocaleString()}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
