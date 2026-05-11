/**
 * Track E3 — Lead/Lag analysis of GEX × LT crossovers across 1m / 3m / 15m.
 *
 * Question 1 (LEAD): does a same-direction crossover on a lower timeframe
 *   precede the equivalent crossover on the higher timeframe? By how many
 *   minutes? For which (gex_type | direction) setups does the relationship
 *   hold?
 *
 * Question 2 (CONFLUENCE): for events on a given timeframe, classify them as
 *   "confirmed by higher TF within ±W minutes" vs "solo". Compare forward
 *   returns. If confirmed events have stronger forward returns, confluence
 *   is a useful filter.
 *
 * Inputs are the saved event JSONs from Track E and Track E2:
 *   --f15m  output/track-e-gex-lt-interactions-*.crossovers.json
 *   --f3m   output/track-e2-1m-lt-crossovers-*.events.json (3m LT)
 *   --f1m   output/track-e2-1m-lt-crossovers-*.events.json (1m LT)
 *
 * Schema notes:
 *   - Track E (15m) uses `snap_ts` as the event timestamp.
 *   - Track E2 (1m/3m) uses `ts`.
 *   - Both have `gex_type`, `direction`, `forwards.fwd_{N}m`.
 *
 * Run:
 *   node research/track-e3-lead-lag.js \
 *     --f15m path/to/15m-crossovers.json \
 *     --f3m  path/to/3m-events.json \
 *     --f1m  path/to/1m-events.json \
 *     --lookback-min 30 --confirm-window-min 30
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'research', 'output');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const F1M = arg('f1m', null);
const F3M = arg('f3m', null);
const F15M = arg('f15m', null);
const LOOKBACK_MIN = Number(arg('lookback-min', 30));
const CONFIRM_WINDOW_MIN = Number(arg('confirm-window-min', 30));

if (!F1M || !F3M || !F15M) {
  console.error('Required: --f1m PATH --f3m PATH --f15m PATH');
  process.exit(1);
}

console.log('=== Track E3: Lead/Lag across LT timeframes ===');
console.log(`1m:  ${F1M}`);
console.log(`3m:  ${F3M}`);
console.log(`15m: ${F15M}`);
console.log(`Lookback (lead detection): ${LOOKBACK_MIN} min`);
console.log(`Confirm window: ±${CONFIRM_WINDOW_MIN} min\n`);

function normalize(events, tsField) {
  return events.map(e => ({
    ts: e[tsField],
    gex_type: e.gex_type,
    direction: e.direction,
    lt_idx: e.lt_idx,
    forwards: e.forwards,
  })).filter(e => e.ts != null && e.gex_type && e.direction)
    .sort((a, b) => a.ts - b.ts);
}

const e1m = normalize(JSON.parse(fs.readFileSync(F1M, 'utf-8')), 'ts');
const e3m = normalize(JSON.parse(fs.readFileSync(F3M, 'utf-8')), 'ts');
const e15m_raw = JSON.parse(fs.readFileSync(F15M, 'utf-8'));
// Track E used snap_ts for 15m
const e15m = normalize(e15m_raw, 'snap_ts');

console.log(`Loaded: 1m=${e1m.length.toLocaleString()}  3m=${e3m.length.toLocaleString()}  15m=${e15m.length.toLocaleString()}\n`);

function bucketByKey(events) {
  const out = new Map();
  for (const e of events) {
    const k = `${e.gex_type}|${e.direction}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(e);
  }
  // events were already sorted by ts on input
  return out;
}

function findPrecursor(byKey, target, maxLookbackMin) {
  const k = `${target.gex_type}|${target.direction}`;
  const arr = byKey.get(k);
  if (!arr || !arr.length) return null;
  // Binary search for largest index where ts < target.ts
  let lo = 0, hi = arr.length - 1;
  if (arr[0].ts >= target.ts) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (arr[mid].ts < target.ts) lo = mid;
    else hi = mid - 1;
  }
  const e = arr[lo];
  const lagMs = target.ts - e.ts;
  if (lagMs > maxLookbackMin * 60000) return null;
  return { event: e, lagMs };
}

// Returns true if ANY event in `byKey` for the target's key falls within
// [target.ts - W ms, target.ts + W ms].
function hasWithinWindow(byKey, target, windowMin) {
  const k = `${target.gex_type}|${target.direction}`;
  const arr = byKey.get(k);
  if (!arr || !arr.length) return false;
  const W = windowMin * 60000;
  // Binary search for first arr[i].ts >= target.ts - W
  const minTs = target.ts - W, maxTs = target.ts + W;
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].ts < minTs) lo = mid + 1; else hi = mid;
  }
  if (lo >= arr.length) return false;
  return arr[lo].ts <= maxTs;
}

const byKey1m = bucketByKey(e1m);
const byKey3m = bucketByKey(e3m);
const byKey15m = bucketByKey(e15m);

// ──────────────────────────────────────────────────────────────────────────
// Question 1 — LEAD/LAG: For each 15m event, how often is there a precursor
// in 1m or 3m within LOOKBACK_MIN before? When yes, what's the lag?
// ──────────────────────────────────────────────────────────────────────────
function leadAnalysis(targetEvents, sourceByKey, sourceLabel) {
  const lagsByKey = new Map();
  let total = 0, matched = 0;
  const allLags = [];
  for (const t of targetEvents) {
    total++;
    const p = findPrecursor(sourceByKey, t, LOOKBACK_MIN);
    if (!p) continue;
    matched++;
    const lagMin = p.lagMs / 60000;
    allLags.push(lagMin);
    const k = `${t.gex_type}|${t.direction}`;
    if (!lagsByKey.has(k)) lagsByKey.set(k, []);
    lagsByKey.get(k).push(lagMin);
  }
  return { total, matched, allLags, lagsByKey };
}

function statsOf(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((s, v) => s + v, 0);
  return {
    n: arr.length,
    mean: sum / arr.length,
    median: sorted[Math.floor(arr.length / 2)],
    p10: sorted[Math.floor(arr.length * 0.10)],
    p25: sorted[Math.floor(arr.length * 0.25)],
    p75: sorted[Math.floor(arr.length * 0.75)],
    p90: sorted[Math.floor(arr.length * 0.90)],
  };
}

console.log('─'.repeat(78));
console.log('LEAD/LAG: For each 15m crossover, is there a same-direction precursor');
console.log(`in 1m or 3m within ${LOOKBACK_MIN} min before? lag = t(15m) − t(precursor) in MINUTES.`);
console.log('─'.repeat(78));

const lead15from3 = leadAnalysis(e15m, byKey3m, '3m→15m');
console.log(`\n3m→15m precursor coverage: ${lead15from3.matched.toLocaleString()} / ${lead15from3.total.toLocaleString()} = ${(100 * lead15from3.matched / lead15from3.total).toFixed(1)}%`);
const s3to15 = statsOf(lead15from3.allLags);
if (s3to15) console.log(`  Lag distribution (min): mean=${s3to15.mean.toFixed(1)} median=${s3to15.median.toFixed(1)} p10=${s3to15.p10.toFixed(1)} p90=${s3to15.p90.toFixed(1)}`);

const lead15from1 = leadAnalysis(e15m, byKey1m, '1m→15m');
console.log(`\n1m→15m precursor coverage: ${lead15from1.matched.toLocaleString()} / ${lead15from1.total.toLocaleString()} = ${(100 * lead15from1.matched / lead15from1.total).toFixed(1)}%`);
const s1to15 = statsOf(lead15from1.allLags);
if (s1to15) console.log(`  Lag distribution (min): mean=${s1to15.mean.toFixed(1)} median=${s1to15.median.toFixed(1)} p10=${s1to15.p10.toFixed(1)} p90=${s1to15.p90.toFixed(1)}`);

const lead3from1 = leadAnalysis(e3m, byKey1m, '1m→3m');
console.log(`\n1m→3m precursor coverage: ${lead3from1.matched.toLocaleString()} / ${lead3from1.total.toLocaleString()} = ${(100 * lead3from1.matched / lead3from1.total).toFixed(1)}%`);
const s1to3 = statsOf(lead3from1.allLags);
if (s1to3) console.log(`  Lag distribution (min): mean=${s1to3.mean.toFixed(1)} median=${s1to3.median.toFixed(1)} p10=${s1to3.p10.toFixed(1)} p90=${s1to3.p90.toFixed(1)}`);

// Per-setup breakdown for 3m→15m (where signal is strongest)
console.log('\n─'.repeat(78));
console.log('Per-setup lag (3m → 15m), n>=30:');
console.log('─'.repeat(78));
console.log('setup'.padEnd(36), 'n_15m'.padStart(7), 'matched'.padStart(8),
  'cov%'.padStart(6), 'mean_lag'.padStart(9), 'median'.padStart(8), 'p10'.padStart(7), 'p90'.padStart(7));
const totalsByKey = new Map();
for (const t of e15m) {
  const k = `${t.gex_type}|${t.direction}`;
  totalsByKey.set(k, (totalsByKey.get(k) || 0) + 1);
}
const lagsRows = [];
for (const [k, lags] of lead15from3.lagsByKey) {
  if (lags.length < 30) continue;
  const s = statsOf(lags);
  const total = totalsByKey.get(k) || lags.length;
  lagsRows.push({ k, n_total: total, matched: lags.length, cov: lags.length / total, ...s });
}
lagsRows.sort((a, b) => b.matched - a.matched);
for (const r of lagsRows.slice(0, 25)) {
  console.log(r.k.padEnd(36),
    String(r.n_total).padStart(7),
    String(r.matched).padStart(8),
    (100 * r.cov).toFixed(0).padStart(5) + '%',
    r.mean.toFixed(1).padStart(9),
    r.median.toFixed(1).padStart(8),
    r.p10.toFixed(1).padStart(7),
    r.p90.toFixed(1).padStart(7));
}

// ──────────────────────────────────────────────────────────────────────────
// Question 2 — CONFLUENCE: classify 1m events as "confirmed by 3m within
// ±W min" vs "solo". Compare forward returns.
// ──────────────────────────────────────────────────────────────────────────
console.log('\n─'.repeat(78));
console.log(`CONFLUENCE: 1m events classified by whether a same-direction event`);
console.log(`fires in 3m within ±${CONFIRM_WINDOW_MIN} min, and similarly for 15m.`);
console.log('─'.repeat(78));

function partitionByConfirm(events, confirmByKey, windowMin) {
  const confirmed = [];
  const solo = [];
  for (const e of events) {
    if (hasWithinWindow(confirmByKey, e, windowMin)) confirmed.push(e);
    else solo.push(e);
  }
  return { confirmed, solo };
}

function meanFwd(events, h) {
  const arr = events.map(e => e.forwards?.[`fwd_${h}m`]).filter(v => v != null);
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function reportPartition(label, parts) {
  const c = parts.confirmed, s = parts.solo;
  const lines = [];
  for (const grp of [['confirmed', c], ['solo', s], ['all', [...c, ...s]]]) {
    const [name, arr] = grp;
    if (!arr.length) continue;
    const m5 = meanFwd(arr, 5), m15 = meanFwd(arr, 15), m30 = meanFwd(arr, 30), m60 = meanFwd(arr, 60);
    lines.push([
      `${label}/${name}`.padEnd(28),
      String(arr.length).padStart(7),
      (m5 == null ? '-' : m5.toFixed(2)).padStart(9),
      (m15 == null ? '-' : m15.toFixed(2)).padStart(9),
      (m30 == null ? '-' : m30.toFixed(2)).padStart(9),
      (m60 == null ? '-' : m60.toFixed(2)).padStart(9),
    ].join(' '));
  }
  return lines.join('\n');
}

const part_1m_by3m = partitionByConfirm(e1m, byKey3m, CONFIRM_WINDOW_MIN);
const part_1m_by15m = partitionByConfirm(e1m, byKey15m, CONFIRM_WINDOW_MIN);
const part_3m_by15m = partitionByConfirm(e3m, byKey15m, CONFIRM_WINDOW_MIN);
const part_1m_byBoth = partitionByConfirm(part_1m_by3m.confirmed, byKey15m, CONFIRM_WINDOW_MIN);

console.log('\nbucket'.padEnd(28), 'n'.padStart(7), 'mean_5m'.padStart(9), 'mean_15m'.padStart(9),
  'mean_30m'.padStart(9), 'mean_60m'.padStart(9));
console.log(reportPartition('1m by 3m', part_1m_by3m));
console.log(reportPartition('1m by 15m', part_1m_by15m));
console.log(reportPartition('3m by 15m', part_3m_by15m));
console.log(reportPartition('1m by 3m+15m', { confirmed: part_1m_byBoth.confirmed, solo: part_1m_byBoth.solo }));

// Per-setup confluence on 3m (since 3m had strongest base signal)
console.log('\n─'.repeat(78));
console.log(`Per-setup (3m crossovers, confirmed-by-15m within ±${CONFIRM_WINDOW_MIN}min vs solo) — n>=50:`);
console.log('─'.repeat(78));
console.log('setup'.padEnd(36), 'n_conf'.padStart(7), 'm15_conf'.padStart(9),
  'n_solo'.padStart(7), 'm15_solo'.padStart(9), 'Δm15'.padStart(8));

const groups3m = new Map();
for (const e of e3m) {
  const k = `${e.gex_type}|${e.direction}`;
  if (!groups3m.has(k)) groups3m.set(k, []);
  groups3m.get(k).push(e);
}
const confluenceRows = [];
for (const [k, arr] of groups3m) {
  const conf = arr.filter(e => hasWithinWindow(byKey15m, e, CONFIRM_WINDOW_MIN));
  const solo = arr.filter(e => !hasWithinWindow(byKey15m, e, CONFIRM_WINDOW_MIN));
  if (conf.length < 50 && solo.length < 50) continue;
  const m_conf = meanFwd(conf, 15);
  const m_solo = meanFwd(solo, 15);
  if (m_conf == null || m_solo == null) continue;
  confluenceRows.push({
    k, n_conf: conf.length, m_conf,
    n_solo: solo.length, m_solo,
    delta: m_conf - m_solo,
  });
}
confluenceRows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
for (const r of confluenceRows.slice(0, 25)) {
  console.log(r.k.padEnd(36),
    String(r.n_conf).padStart(7),
    r.m_conf.toFixed(2).padStart(9),
    String(r.n_solo).padStart(7),
    r.m_solo.toFixed(2).padStart(9),
    r.delta.toFixed(2).padStart(8));
}

// Persist summary
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(OUT_DIR, `track-e3-lead-lag-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  inputs: { f1m: F1M, f3m: F3M, f15m: F15M },
  params: { lookback_min: LOOKBACK_MIN, confirm_window_min: CONFIRM_WINDOW_MIN },
  counts: { e1m: e1m.length, e3m: e3m.length, e15m: e15m.length },
  lead: {
    '3m_to_15m': { matched: lead15from3.matched, total: lead15from3.total, stats: s3to15 },
    '1m_to_15m': { matched: lead15from1.matched, total: lead15from1.total, stats: s1to15 },
    '1m_to_3m':  { matched: lead3from1.matched,  total: lead3from1.total,  stats: s1to3 },
  },
  perSetup3to15: lagsRows,
  confluence3mby15m: confluenceRows,
}, null, 2));
console.log(`\nWrote ${outPath}`);
