/**
 * Phase 1b: Resolve same-bar stop+target ambiguities using 1s OHLCV.
 *
 * Phase 1 (01-build-touch-dataset.js) flags any outcome where the 1m candle
 * containing the exit shows BOTH target_price and stop_price within its range
 * — meaning we cannot tell from 1m data alone which side hit first. This
 * script:
 *   1. Reads the Phase 1 touches JSON.
 *   2. Collects every unique (ambiguous_bar_ts, primary_symbol) pair.
 *   3. Streams data/ohlcv/nq/NQ_ohlcv_1s.csv once, keeping only rows whose
 *      ts_event falls inside any ambiguous minute AND whose symbol matches
 *      the primary-by-hour map captured by Phase 1.
 *   4. For each ambiguous outcome, walks the 60 1s bars within that minute
 *      and records which side (stop or target) was hit first. Updates the
 *      outcome's `outcome` field from 'ambiguous' to 'win' or 'loss', and
 *      preserves the resolution details under `resolution_1s`.
 *   5. Writes a *.resolved.json next to the input.
 *
 * Usage:
 *   node research/gex-touch-confirm/01b-resolve-ambiguity-1s.js \
 *     --in research/output/gex-touch-confirm-base-<TS>.touches.json
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
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN = arg('in');
if (!IN) {
  console.error('Missing --in <touches.json path>');
  process.exit(1);
}
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
if (!fs.existsSync(inPath)) {
  console.error(`Input not found: ${inPath}`);
  process.exit(1);
}

console.log(`\n=== Phase 1b: 1s ambiguity resolver ===`);
console.log(`Input: ${inPath}\n`);

const payload = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { touches, primary_by_hour: primaryByHourObj, config, stats } = payload;
const outcomeRows = stats.outcome_rows ?? stats.outcome_cells ?? 0;
const ambiguousRows = stats.ambiguous_rows ?? (stats.outcomes && stats.outcomes.ambiguous) ?? 0;
console.log(`Touches: ${touches.length.toLocaleString()}, outcome rows: ${outcomeRows.toLocaleString()}, ambiguous: ${ambiguousRows.toLocaleString()}`);

// Collect all unique ambiguous bar timestamps and the references to update
// Map<barTs, [{touch, outcome, stopBlock}]>
const ambByBar = new Map();
const ambByMinute = new Map(); // for streaming: minute_ts -> [refs]
let totalAmb = 0;

for (const t of touches) {
  for (const o of t.outcomes) {
    for (const s of o.stops) {
      if (s.outcome !== 'ambiguous') continue;
      totalAmb++;
      const barTs = s.ambiguous_bar_ts;
      if (!ambByBar.has(barTs)) ambByBar.set(barTs, []);
      ambByBar.get(barTs).push({ touch: t, outcome: o, stop: s });
    }
  }
}
console.log(`Unique ambiguous bars: ${ambByBar.size.toLocaleString()} (covering ${totalAmb.toLocaleString()} outcome rows)`);

if (totalAmb === 0) {
  console.log(`Nothing to resolve. Writing copy.`);
  const out = inPath.replace(/\.touches\.json$/, '.resolved.json');
  fs.writeFileSync(out, JSON.stringify(payload));
  console.log(`Written: ${out}`);
  process.exit(0);
}

// Determine date window for 1s file scanning
const minBarTs = Math.min(...ambByBar.keys());
const maxBarTs = Math.max(...ambByBar.keys());
const scanStartTs = minBarTs;
const scanEndTs = maxBarTs + 60 * 1000;
console.log(`1s scan window: ${new Date(scanStartTs).toISOString()} → ${new Date(scanEndTs).toISOString()}`);

// Build allowed-symbol-per-hour set keyed by hour-bucket (timestamp/3600000 floor)
const primaryByHour = new Map();
for (const [k, v] of Object.entries(primaryByHourObj)) primaryByHour.set(Number(k), v);

// Build map: minuteTs -> [list of refs]; lookup is keyed by 1s row's minute (floor to 60s)
for (const [barTs, refs] of ambByBar.entries()) {
  ambByMinute.set(barTs, { refs, secondBars: [] });
}

// Stream 1s file
console.log(`\nStreaming NQ_ohlcv_1s.csv ...`);
const onesPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1s.csv');
if (!fs.existsSync(onesPath)) {
  console.error(`1s OHLCV not found: ${onesPath}`);
  process.exit(1);
}

// Readline + manual parse for speed. File is sorted by ts_event (ascending),
// so we can early-exit once we pass scanEndTs.
// Header: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
let rowsScanned = 0, rowsKept = 0;
const tStart = Date.now();
const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null;
let stopped = false;
const scanStartIso = new Date(scanStartTs).toISOString();
const scanEndIso = new Date(scanEndTs).toISOString();

for await (const line of rl) {
  if (!header) { header = line; continue; }
  rowsScanned++;
  if (rowsScanned % 5000000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(rowsScanned / 1e6).toFixed(1)}M  kept ${rowsKept.toLocaleString()}  (${sec}s)\n`);
  }

  // Fast field extract: comma-separated, no embedded commas in any field
  // We need: ts_event (0), open (4), high (5), low (6), close (7), volume (8), symbol (9)
  const f0End = line.indexOf(',');
  if (f0End < 0) continue;
  const tsStr = line.slice(0, f0End);
  // Cheap range pre-filter via lex compare on ISO string
  if (tsStr < scanStartIso) continue;
  if (tsStr > scanEndIso) { stopped = true; break; }

  // Split remainder; tolerate trailing newline removed by readline already
  const parts = line.split(',');
  if (parts.length < 10) continue;
  const symbol = parts[9];
  if (symbol.includes('-')) continue; // calendar spread

  const ts = new Date(tsStr).getTime();
  const minuteTs = Math.floor(ts / 60000) * 60000;
  const slot = ambByMinute.get(minuteTs);
  if (!slot) continue;

  const hourBucket = Math.floor(ts / 3600000);
  const primarySym = primaryByHour.get(hourBucket);
  if (primarySym && symbol !== primarySym) continue;

  slot.secondBars.push({
    ts,
    open: +parts[4], high: +parts[5], low: +parts[6], close: +parts[7],
    volume: +parts[8] || 0,
  });
  rowsKept++;
}
rl.close();
stream.destroy();
const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`  Done: scanned ${rowsScanned.toLocaleString()} rows, kept ${rowsKept.toLocaleString()} (${sec}s)${stopped ? ' [early-exit]' : ''}`);

// Resolve each ambiguous outcome
console.log(`\nResolving ${totalAmb.toLocaleString()} ambiguous outcomes ...`);
let resolvedWin = 0, resolvedLoss = 0, unresolved = 0;
const TARGET_POINTS = config.TARGET_POINTS;

for (const [barTs, slot] of ambByMinute.entries()) {
  const bars1s = slot.secondBars.sort((a, b) => a.ts - b.ts);
  for (const { touch, outcome, stop } of slot.refs) {
    const dir = outcome.direction;
    const entryPrice = touch.entry_price;
    const targetPrice = outcome.target_price;
    const stopPrice = stop.stop_price;

    if (bars1s.length === 0) {
      // No 1s data available — leave as ambiguous, mark unresolved
      stop.resolution_1s = { status: 'no_data' };
      unresolved++;
      continue;
    }

    let resolvedAs = null; let resolvedAtSec = null; let resolvedAtTs = null;
    for (const b of bars1s) {
      let targetHit, stopHit;
      if (dir === 'long') {
        targetHit = b.high >= targetPrice;
        stopHit = b.low <= stopPrice;
      } else {
        targetHit = b.low <= targetPrice;
        stopHit = b.high >= stopPrice;
      }
      if (targetHit && stopHit) {
        // Still tied even at 1s — fall back to using the opening direction:
        // whichever side was crossed by the open price relative to entry.
        // If even open is between target and stop, mark as 'tie' and assign loss
        // (conservative for win-rate honesty).
        const opensFavorable = dir === 'long' ? b.open >= targetPrice : b.open <= targetPrice;
        const opensAdverse = dir === 'long' ? b.open <= stopPrice : b.open >= stopPrice;
        if (opensFavorable && !opensAdverse) {
          resolvedAs = 'win';
        } else if (opensAdverse && !opensFavorable) {
          resolvedAs = 'loss';
        } else {
          resolvedAs = 'loss'; // conservative fallback
        }
        resolvedAtSec = Math.floor((b.ts - barTs) / 1000);
        resolvedAtTs = b.ts;
        break;
      } else if (targetHit) {
        resolvedAs = 'win';
        resolvedAtSec = Math.floor((b.ts - barTs) / 1000);
        resolvedAtTs = b.ts;
        break;
      } else if (stopHit) {
        resolvedAs = 'loss';
        resolvedAtSec = Math.floor((b.ts - barTs) / 1000);
        resolvedAtTs = b.ts;
        break;
      }
    }

    if (resolvedAs == null) {
      // 1s bars existed but neither hit was triggered within them — preserve ambiguous
      stop.resolution_1s = { status: 'no_hit_in_1s', n_bars: bars1s.length };
      unresolved++;
      continue;
    }

    stop.outcome = resolvedAs;
    stop.exit_price = resolvedAs === 'win' ? targetPrice : stopPrice;
    stop.resolution_1s = {
      status: 'resolved',
      n_bars: bars1s.length,
      resolved_at_sec: resolvedAtSec,
      resolved_at_ts: resolvedAtTs,
    };
    if (resolvedAs === 'win') resolvedWin++;
    else resolvedLoss++;
  }
}

console.log(`Resolved: ${resolvedWin.toLocaleString()} → win | ${resolvedLoss.toLocaleString()} → loss | ${unresolved.toLocaleString()} unresolved`);
console.log(`Win share among resolved: ${(100 * resolvedWin / Math.max(1, resolvedWin + resolvedLoss)).toFixed(1)}%`);

// Update stats
payload.stats.ambiguous_resolved_win = resolvedWin;
payload.stats.ambiguous_resolved_loss = resolvedLoss;
payload.stats.ambiguous_unresolved = unresolved;

// Print updated baseline
printBaselineSummary(touches, TARGET_POINTS);

const outPath = inPath.replace(/\.touches\.json$/, '.resolved.json');
fs.writeFileSync(outPath, JSON.stringify(payload));
console.log(`\nWritten: ${outPath}`);
console.log(`File size: ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB`);

function printBaselineSummary(touches, target) {
  console.log('\n=== Resolved baseline by setup × stop_distance ===');
  const buckets = new Map();
  for (const t of touches) {
    for (const o of t.outcomes) {
      for (const s of o.stops) {
        const k = `${o.setup}|${s.stop}`;
        if (!buckets.has(k)) buckets.set(k, { n: 0, wins: 0, losses: 0, timeouts: 0, ambiguous: 0, rollover: 0 });
        const b = buckets.get(k);
        b.n++;
        if (s.outcome === 'win') b.wins++;
        else if (s.outcome === 'loss') b.losses++;
        else if (s.outcome === 'timeout') b.timeouts++;
        else if (s.outcome === 'ambiguous') b.ambiguous++;
        else if (s.outcome === 'rollover') b.rollover++;
      }
    }
  }
  console.log('setup'.padEnd(8), 'stop'.padStart(5), 'n'.padStart(8), 'win%'.padStart(8),
    'loss%'.padStart(8), 'amb%'.padStart(8), 'roll%'.padStart(8), 'time%'.padStart(8), 'pf'.padStart(8));
  const rows = Array.from(buckets.entries()).sort();
  for (const [k, b] of rows) {
    const [setup, stop] = k.split('|');
    const stopN = Number(stop);
    const wPct = 100 * b.wins / b.n;
    const lPct = 100 * b.losses / b.n;
    const aPct = 100 * b.ambiguous / b.n;
    const rPct = 100 * b.rollover / b.n;
    const tPct = 100 * b.timeouts / b.n;
    const grossWin = b.wins * target;
    const grossLoss = b.losses * stopN;
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    console.log(setup.padEnd(8), String(stop).padStart(5), String(b.n).padStart(8),
      wPct.toFixed(1).padStart(8), lPct.toFixed(1).padStart(8),
      aPct.toFixed(1).padStart(8), rPct.toFixed(1).padStart(8),
      tPct.toFixed(1).padStart(8),
      pf.toFixed(2).padStart(8));
  }
}
