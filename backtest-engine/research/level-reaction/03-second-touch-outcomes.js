/**
 * Phase 3: Second-touch trade outcomes (1s-honest)
 *
 * For each episode T1, find the next episode T2 of the SAME level type within
 * --max-gap-min minutes. Simulate a limit order AT THE LEVEL on T2's entry
 * bar. Walk 1s OHLCV forward from the 1s instant where the limit fills.
 * Measure forward outcomes for BOTH directions (long/short) at multiple
 * (target, stop) combinations.
 *
 * Critical: 1s-honest fills per CLAUDE.md mandate.
 *   - Entry instant: first 1s bar within T2's entry minute whose range
 *     intersects the level price (low <= level <= high).
 *   - Entry price: exactly the level price (limit order, no slippage).
 *   - Forward walk: 1s bars in chronological order starting at entry_ts + 1s.
 *   - Stop/target: first side to hit wins. Same-1s-bar ambiguity → assume
 *     stop hits first (conservative).
 *   - Max hold: --max-hold-min from entry (default 60 min).
 *   - EOD cutoff: 16:40 ET (close any open trade by market price at 16:40).
 *
 * Output: aggregate table of (level_type, first_reaction, direction, target_pts, stop_pts)
 * with n / WR / avg_pts / PF / median_time_to_exit + sample size info.
 *
 * Usage:
 *   node research/level-reaction/03-second-touch-outcomes.js \
 *     --in research/output/level-reaction-classified-<TS>.json \
 *     --targets 5,10,15,20,30 --stops 10,15,20 --max-hold-min 60 --max-gap-min 120
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'research', 'output');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN_FILE = arg('in', null);
if (!IN_FILE) { console.error('Required: --in <phase2-classified.json>'); process.exit(1); }
const TARGETS = arg('targets', '5,10,15,20,30').split(',').map(Number);
const STOPS = arg('stops', '10,15,20').split(',').map(Number);
const MAX_HOLD_MIN = Number(arg('max-hold-min', 60));
const MAX_GAP_MIN = Number(arg('max-gap-min', 120));
const PRODUCT = arg('product', 'NQ').toUpperCase();
const EOD_CUTOFF_MIN = 16 * 60 + 40;  // 16:40 ET

const inPath = path.isAbsolute(IN_FILE) ? IN_FILE : path.join(ROOT, IN_FILE);
console.log(`\n=== Phase 3: Second-touch outcomes (1s-honest) ===`);
console.log(`Input: ${inPath}`);
console.log(`Targets: [${TARGETS.join(', ')}]pt  |  Stops: [${STOPS.join(', ')}]pt`);
console.log(`Max hold: ${MAX_HOLD_MIN}min | Max gap T1→T2: ${MAX_GAP_MIN}min | EOD cutoff: 16:40 ET\n`);

const inData = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
console.log(`Loaded ${inData.episodes.length.toLocaleString()} episodes`);

// --- 1. Build T1→T2 pairs ---
// Group by levelType, sort by entryTimestamp, find next same-level episode within MAX_GAP_MIN
const byLevelType = new Map();
for (const ep of inData.episodes) {
  if (!byLevelType.has(ep.levelType)) byLevelType.set(ep.levelType, []);
  byLevelType.get(ep.levelType).push(ep);
}
for (const arr of byLevelType.values()) arr.sort((a, b) => a.entryTimestamp - b.entryTimestamp);

const pairs = [];
for (const [levelType, eps] of byLevelType) {
  for (let i = 0; i < eps.length - 1; i++) {
    const t1 = eps[i];
    if (t1.reaction === 'no_data') continue;
    // Look forward for next episode of same level type whose ENTRY is after T1.exit
    for (let j = i + 1; j < eps.length; j++) {
      const t2 = eps[j];
      const gapMs = t2.entryTimestamp - t1.exitTimestamp;
      if (gapMs <= 0) continue;
      const gapMin = gapMs / 60000;
      if (gapMin > MAX_GAP_MIN) break;
      // Same trading day requirement (so we don't pair across EOD)
      if (t2.entryEtDate !== t1.entryEtDate) break;
      pairs.push({ t1, t2, gapMin: +gapMin.toFixed(1) });
      break;  // only nearest T2
    }
  }
}
console.log(`Built ${pairs.length.toLocaleString()} T1→T2 pairs (same level, same day, gap <= ${MAX_GAP_MIN}min)`);

// Distribution of pair characteristics
const byLevel = new Map();
for (const p of pairs) byLevel.set(p.t1.levelType, (byLevel.get(p.t1.levelType) || 0) + 1);
console.log('\nPair counts by level type:');
const sorted = [...byLevel.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) console.log(`  ${k.padEnd(12)} ${v.toString().padStart(7)}`);

// --- 2. Load 1m OHLCV for primary-contract map + T2 entry-bar lookups ---
async function loadRawNQ(startMs, endMs) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < startMs || ts > endMs) return;
        candles.push({ timestamp: ts, volume: +row.volume || 0, symbol: row.symbol });
      })
      .on('end', resolve).on('error', reject);
  });
  return candles;
}
function buildPrimaryByHour(candles) {
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    primary.set(h, bestSym);
  }
  return primary;
}

// Time bounds for 1s scan: we need [earliest T2 entry, latest T2 entry + max-hold]
let scanStartMs = Infinity, scanEndMs = -Infinity;
for (const p of pairs) {
  if (p.t2.entryTimestamp < scanStartMs) scanStartMs = p.t2.entryTimestamp;
  const endMs = p.t2.entryTimestamp + (MAX_HOLD_MIN + 1) * 60000;
  if (endMs > scanEndMs) scanEndMs = endMs;
}
console.log(`\nLoading 1m primary-contract map for [${new Date(scanStartMs).toISOString()}, ${new Date(scanEndMs).toISOString()}]`);
const oneMin = await loadRawNQ(scanStartMs - 3600000, scanEndMs + 3600000);
const primaryByHour = buildPrimaryByHour(oneMin);
console.log(`Primary-by-hour map: ${primaryByHour.size.toLocaleString()} hours`);

// --- 3. Build window index: for each pair, [t2_entry_minute_start, t2_entry_minute_start + (MAX_HOLD+1)min] ---
// We'll mark each minute timestamp that is part of ANY pair's needed window.
// During the 1s stream we keep 1s bars only if their minute is in the set.
const neededMinutes = new Set();
for (const p of pairs) {
  const entryMin = Math.floor(p.t2.entryTimestamp / 60000) * 60000;
  const endMin = entryMin + (MAX_HOLD_MIN + 1) * 60000;
  for (let m = entryMin; m <= endMin; m += 60000) neededMinutes.add(m);
}
console.log(`Need 1s data for ${neededMinutes.size.toLocaleString()} distinct minutes (≈${(neededMinutes.size / 60).toFixed(0)} trading hours)`);

// --- 4. Stream 1s OHLCV ---
// Capture per minute: an array of 1s bars (ts, low, high, close) in chronological order.
// Memory: ~neededMinutes × 60 bars × ~32 bytes = if 1M minutes, ~2GB. Should fit.
const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
if (!fs.existsSync(onesPath)) { console.error(`1s file not found: ${onesPath}`); process.exit(1); }

const minIso = new Date(scanStartMs).toISOString();
const maxIso = new Date(scanEndMs + 3600000).toISOString();
console.log(`\nStreaming 1s OHLCV (filter to ${neededMinutes.size.toLocaleString()} minutes)...`);
const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null;
let scanned = 0, kept = 0;
const tStart = Date.now();
const oneSecByMinute = new Map();   // minuteTs → [{ts, low, high, close}]

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 10000000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  kept ${kept.toLocaleString()}  (${sec}s)\n`);
  }
  const c0 = line.indexOf(',');
  if (c0 < 0) continue;
  const tsStr = line.slice(0, c0);
  if (tsStr < minIso) continue;
  if (tsStr > maxIso) break;

  const parts = line.split(',');
  if (parts.length < 10) continue;
  const symbol = parts[9];
  if (symbol.includes('-')) continue;

  const ts = new Date(tsStr).getTime();
  const minuteTs = Math.floor(ts / 60000) * 60000;
  if (!neededMinutes.has(minuteTs)) continue;
  const hourBucket = Math.floor(ts / 3600000);
  const primarySym = primaryByHour.get(hourBucket);
  if (primarySym && symbol !== primarySym) continue;

  const high = +parts[5], low = +parts[6], close = +parts[7];
  if (isNaN(close)) continue;
  if (!oneSecByMinute.has(minuteTs)) oneSecByMinute.set(minuteTs, []);
  oneSecByMinute.get(minuteTs).push({ ts, low, high, close });
  kept++;
}
rl.close(); stream.destroy();
console.log(`  Done: scanned ${scanned.toLocaleString()} 1s rows, kept ${kept.toLocaleString()}, indexed ${oneSecByMinute.size.toLocaleString()} minutes (${((Date.now() - tStart) / 1000).toFixed(0)}s)`);

// Sort per-minute 1s arrays for safety
for (const arr of oneSecByMinute.values()) arr.sort((a, b) => a.ts - b.ts);

// --- 5. For each pair, find 1s entry instant, walk forward, evaluate (direction × target × stop) ---
//
// Entry: limit order AT THE LEVEL on T2.entryTimestamp's minute.
//   - Use t2.entryLevelPrice as the limit price.
//   - First 1s bar at minute >= entryTimestamp where bar.low <= level <= bar.high → fill_ts.
//   - Entry price = level price (exact limit fill).
//
// Forward walk: from fill_ts + 1s, walk 1s bars until target/stop/eod/max-hold hit.
//   For each (direction, target, stop) combo: track exit independently.

const outcomeRows = [];
let processed = 0;
const tWalkStart = Date.now();

function walkPair(pair) {
  const { t1, t2 } = pair;
  const level = t2.entryLevelPrice;
  if (level == null) return null;

  // Find 1s fill instant
  const entryMin = Math.floor(t2.entryTimestamp / 60000) * 60000;
  const arr = oneSecByMinute.get(entryMin);
  if (!arr || arr.length === 0) return null;
  let fillTs = null;
  for (const s of arr) {
    if (s.ts < t2.entryTimestamp) continue;  // limit not yet active
    if (s.low <= level && level <= s.high) { fillTs = s.ts; break; }
  }
  if (fillTs == null) return null;  // 1s data doesn't actually intersect the level in T2's minute

  // EOD cutoff in ET
  const fillEt = toET(fillTs);
  const fillEtDate = fillEt.date;
  // Compute EOD cutoff ms for this trading day
  // EOD = the next instant where minutes-in-ET >= EOD_CUTOFF_MIN on fillEtDate
  // Simpler: max-hold + 1min after fillTs OR EOD cutoff, whichever first
  const eodMs = (() => {
    const [y, m, d] = fillEtDate.split('-').map(Number);
    const isDstEt = fillEt.offset === -4;
    return Date.UTC(y, m - 1, d, (isDstEt ? 4 : 5) + Math.floor(EOD_CUTOFF_MIN / 60), EOD_CUTOFF_MIN % 60);
  })();
  const maxHoldMs = fillTs + MAX_HOLD_MIN * 60000;
  const cutoffMs = Math.min(eodMs, maxHoldMs);

  // For each direction × target × stop, track exit independently
  // direction: 1=long, -1=short
  const combos = [];
  for (const dir of [1, -1]) {
    for (const tgt of TARGETS) {
      for (const stp of STOPS) {
        combos.push({
          direction: dir, target: tgt, stop: stp,
          tgtPrice: level + dir * tgt,
          stopPrice: level - dir * stp,
          done: false, exitTs: null, exitPrice: null, exitReason: null,
        });
      }
    }
  }

  // Walk minute by minute from fill minute onward
  for (let m = entryMin; m <= cutoffMs; m += 60000) {
    const bars = oneSecByMinute.get(m);
    if (!bars || bars.length === 0) continue;
    for (const s of bars) {
      if (s.ts <= fillTs) continue;        // strictly after fill
      if (s.ts > cutoffMs) break;
      let allDone = true;
      for (const combo of combos) {
        if (combo.done) continue;
        allDone = false;
        // Stop check first (conservative on ambiguous bars)
        if (combo.direction === 1) {
          // long
          const hitStop = s.low <= combo.stopPrice;
          const hitTgt = s.high >= combo.tgtPrice;
          if (hitStop) { combo.done = true; combo.exitTs = s.ts; combo.exitPrice = combo.stopPrice; combo.exitReason = 'stop'; }
          else if (hitTgt) { combo.done = true; combo.exitTs = s.ts; combo.exitPrice = combo.tgtPrice; combo.exitReason = 'target'; }
        } else {
          // short
          const hitStop = s.high >= combo.stopPrice;
          const hitTgt = s.low <= combo.tgtPrice;
          if (hitStop) { combo.done = true; combo.exitTs = s.ts; combo.exitPrice = combo.stopPrice; combo.exitReason = 'stop'; }
          else if (hitTgt) { combo.done = true; combo.exitTs = s.ts; combo.exitPrice = combo.tgtPrice; combo.exitReason = 'target'; }
        }
      }
      if (allDone) break;
    }
  }
  // For any combos still open at cutoff, exit at the last 1s bar before cutoff at its close (market-style)
  // Search back from cutoffMs minute for the last 1s bar
  let lastBar = null;
  for (let m = Math.floor(cutoffMs / 60000) * 60000; m >= entryMin; m -= 60000) {
    const bars = oneSecByMinute.get(m);
    if (!bars) continue;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].ts <= cutoffMs) { lastBar = bars[i]; break; }
    }
    if (lastBar) break;
  }
  for (const combo of combos) {
    if (combo.done) continue;
    if (lastBar) { combo.exitTs = lastBar.ts; combo.exitPrice = lastBar.close; combo.exitReason = 'timeout'; combo.done = true; }
  }

  // Emit a row per combo
  const out = [];
  for (const c of combos) {
    if (!c.done) continue;
    const pnlPts = c.direction === 1 ? (c.exitPrice - level) : (level - c.exitPrice);
    out.push({
      // identity
      levelType: t1.levelType,
      t1_reaction: t1.reaction,
      t1_etDate: t1.entryEtDate,
      t1_etTime: t1.entryEtTime,
      t1_rejectionScore: t1.rejectionScore || 0,
      t1_rejection15m: t1.rejectionWicks15m || 0,
      t1_rejection5m: t1.rejectionWicks5m || 0,
      gapMin: pair.gapMin,
      t2_etTime: t2.entryEtTime,
      t2_tod: t2.entryTod,
      t2_approach: t2.entryApproach,
      regime: t2.regime ?? null,
      // trade
      direction: c.direction,
      target: c.target,
      stop: c.stop,
      entryPrice: level,
      exitPrice: c.exitPrice,
      exitReason: c.exitReason,
      pnlPts: +pnlPts.toFixed(2),
      holdSec: Math.round((c.exitTs - fillTs) / 1000),
      win: pnlPts > 0 ? 1 : 0,
    });
  }
  return out;
}

console.log(`\nWalking ${pairs.length.toLocaleString()} pairs through 1s OHLCV...`);
for (const pair of pairs) {
  processed++;
  if (processed % 1000 === 0) {
    process.stdout.write(`\r  walked: ${processed.toLocaleString()} / ${pairs.length.toLocaleString()}`);
  }
  const rows = walkPair(pair);
  if (rows) for (const r of rows) outcomeRows.push(r);
}
process.stdout.write(`\r  walked: ${pairs.length.toLocaleString()} / ${pairs.length.toLocaleString()}  (${((Date.now() - tWalkStart) / 1000).toFixed(0)}s)\n`);
console.log(`\nGenerated ${outcomeRows.length.toLocaleString()} outcome rows`);

// --- 6. Aggregate by (level_type, t1_reaction, direction, target, stop) ---
const aggMap = new Map();
function key(r) { return `${r.levelType}|${r.t1_reaction}|${r.direction === 1 ? 'L' : 'S'}|${r.target}|${r.stop}`; }
for (const r of outcomeRows) {
  const k = key(r);
  if (!aggMap.has(k)) aggMap.set(k, { n: 0, wins: 0, sumPts: 0, sumWinPts: 0, sumLossPts: 0, sumHoldSec: 0 });
  const a = aggMap.get(k);
  a.n++;
  a.sumPts += r.pnlPts;
  a.sumHoldSec += r.holdSec;
  if (r.win) { a.wins++; a.sumWinPts += r.pnlPts; } else { a.sumLossPts += r.pnlPts; }
}

// Output the headline cells: for each level type × t1 reaction, the BEST (direction, target, stop) by PF (min n >= 30)
console.log(`\nAggregating ${aggMap.size.toLocaleString()} cells. Filtering to n >= 30, sorted by PF...`);
const rows = [];
for (const [k, a] of aggMap) {
  const [levelType, reaction, dir, tgt, stp] = k.split('|');
  const avgPts = a.sumPts / a.n;
  const pf = a.sumLossPts === 0 ? Infinity : Math.abs(a.sumWinPts / a.sumLossPts);
  const wr = (100 * a.wins / a.n);
  rows.push({ levelType, reaction, dir, target: +tgt, stop: +stp, n: a.n, wr: +wr.toFixed(1), avgPts: +avgPts.toFixed(2), pf: pf === Infinity ? 999 : +pf.toFixed(2), avgHoldMin: +(a.sumHoldSec / a.n / 60).toFixed(1) });
}
const big = rows.filter(r => r.n >= 30).sort((a, b) => b.pf - a.pf);
console.log(`\nTop 30 (level, T1_reaction, dir, target, stop) cells by PF (n>=30):`);
console.log(`  ${'level'.padEnd(11)} ${'T1_reaction'.padEnd(20)} ${'dir'} ${'tgt'.padStart(3)} ${'stp'.padStart(3)}  ${'n'.padStart(5)} ${'WR%'.padStart(5)} ${'avgPts'.padStart(7)} ${'PF'.padStart(6)} ${'holdM'.padStart(6)}`);
for (const r of big.slice(0, 30)) {
  console.log(`  ${r.levelType.padEnd(11)} ${r.reaction.padEnd(20)} ${r.dir}   ${String(r.target).padStart(3)} ${String(r.stop).padStart(3)}  ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(5)} ${r.avgPts.toFixed(2).padStart(7)} ${r.pf.toFixed(2).padStart(6)} ${r.avgHoldMin.toFixed(1).padStart(6)}`);
}

// Also show the highest-WR cells (irrespective of PF)
const byWr = rows.filter(r => r.n >= 30).sort((a, b) => b.wr - a.wr);
console.log(`\nTop 30 cells by WR (n>=30):`);
console.log(`  ${'level'.padEnd(11)} ${'T1_reaction'.padEnd(20)} ${'dir'} ${'tgt'.padStart(3)} ${'stp'.padStart(3)}  ${'n'.padStart(5)} ${'WR%'.padStart(5)} ${'avgPts'.padStart(7)} ${'PF'.padStart(6)} ${'holdM'.padStart(6)}`);
for (const r of byWr.slice(0, 30)) {
  console.log(`  ${r.levelType.padEnd(11)} ${r.reaction.padEnd(20)} ${r.dir}   ${String(r.target).padStart(3)} ${String(r.stop).padStart(3)}  ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(5)} ${r.avgPts.toFixed(2).padStart(7)} ${r.pf.toFixed(2).padStart(6)} ${r.avgHoldMin.toFixed(1).padStart(6)}`);
}

const outTs = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(OUT_DIR, `level-reaction-outcomes-${outTs}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  config: {
    input: IN_FILE,
    targets: TARGETS, stops: STOPS,
    maxHoldMin: MAX_HOLD_MIN, maxGapMin: MAX_GAP_MIN,
    eodCutoffMin: EOD_CUTOFF_MIN,
  },
  summary: {
    pairsBuilt: pairs.length,
    outcomesGenerated: outcomeRows.length,
    cellsAggregated: aggMap.size,
    cellsWithMin30: big.length,
  },
  cells: rows,
  outcomes: outcomeRows,
}, null, 2));
console.log(`\nWrote ${outPath}`);
