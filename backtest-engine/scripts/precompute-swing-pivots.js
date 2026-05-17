#!/usr/bin/env node
/**
 * Precompute 1m 9/9 swing pivots (Bill Williams Fractals with N=9) for NQ.
 *
 * A swing high at bar i is confirmed if bar[i].high is strictly greater than
 * the high of all bars in i-N..i-1 AND i+1..i+N. Confirmation happens at bar
 * i+N (we know it's a pivot only after seeing N bars on the right). Symmetric
 * for swing lows.
 *
 * Pre-filters:
 *   1. Drop calendar spread rows (symbol contains '-')
 *   2. Per-hour primary contract filter (highest-volume contract per hour)
 *
 * Default range: 2024-10-01 → 2026-04-23 (covers gold-standard window + buffer
 * for 4h pre-signal lookback at the start).
 *
 * Output CSV columns:
 *   ts_event       — pivot bar's timestamp (when the pivot actually occurred)
 *   type           — 'high' or 'low'
 *   price          — pivot price (the high or low of the pivot bar)
 *   confirmed_at   — timestamp of bar i+N (when this becomes detectable live)
 *   symbol         — contract symbol of the pivot bar
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const IN_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const OUT_DIR = path.join(REPO_ROOT, 'research', 'swing-pivots');
const OUT_PATH = path.join(OUT_DIR, 'NQ_swings_1m_9_9.csv');

const N = parseInt(process.env.SWING_N || '9', 10);
const START_TS = process.env.START_DATE
  ? new Date(process.env.START_DATE + 'T00:00:00Z').getTime()
  : new Date('2024-10-01T00:00:00Z').getTime();
const END_TS = process.env.END_DATE
  ? new Date(process.env.END_DATE + 'T23:59:59Z').getTime()
  : new Date('2026-04-30T23:59:59Z').getTime();

fs.mkdirSync(OUT_DIR, { recursive: true });

// --- Pass 1: stream the CSV, build per-hour contract-volume map, also collect
// all rows in range (filtering spreads). ----------------------------------

async function pass1Collect() {
  return new Promise((resolve, reject) => {
    const rows = [];
    const hourVolumes = new Map(); // hourKey -> Map(symbol -> total volume)
    const rl = readline.createInterface({
      input: fs.createReadStream(IN_PATH),
      crlfDelay: Infinity,
    });

    let header = null;
    let dropSpread = 0, dropRange = 0, kept = 0;

    rl.on('line', (line) => {
      if (!header) {
        header = line.split(',');
        return;
      }
      // CSV column layout: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
      const parts = line.split(',');
      if (parts.length < 10) return;
      const symbol = parts[9];
      if (symbol.includes('-')) { dropSpread++; return; }

      const ts = Date.parse(parts[0]);
      if (Number.isNaN(ts) || ts < START_TS || ts > END_TS) { dropRange++; return; }

      const open = +parts[4], high = +parts[5], low = +parts[6], close = +parts[7], volume = +parts[8];
      rows.push({ ts, open, high, low, close, volume, symbol });

      const hourKey = Math.floor(ts / 3_600_000);
      if (!hourVolumes.has(hourKey)) hourVolumes.set(hourKey, new Map());
      const m = hourVolumes.get(hourKey);
      m.set(symbol, (m.get(symbol) || 0) + (volume || 0));
      kept++;
    });

    rl.on('error', reject);
    rl.on('close', () => {
      console.log(`Pass 1: kept=${kept} dropSpread=${dropSpread} dropOutOfRange=${dropRange}`);
      resolve({ rows, hourVolumes });
    });
  });
}

// --- Resolve primary contract per hour ----------------------------------------

function buildPrimaryMap(hourVolumes) {
  const primary = new Map(); // hourKey -> symbol
  for (const [hourKey, m] of hourVolumes.entries()) {
    let bestSym = '', bestVol = -1;
    for (const [sym, vol] of m.entries()) {
      if (vol > bestVol) { bestVol = vol; bestSym = sym; }
    }
    primary.set(hourKey, bestSym);
  }
  return primary;
}

// --- Pass 2: filter to primary-contract candles, run 9/9 pivot detection -----

function detectPivots(primaryCandles, N) {
  const pivots = [];
  const cnt = primaryCandles.length;
  for (let i = N; i < cnt - N; i++) {
    const c = primaryCandles[i];

    // Swing high: c.high strictly > all neighbors on each side
    let isHigh = true;
    for (let k = 1; k <= N; k++) {
      if (primaryCandles[i - k].high >= c.high || primaryCandles[i + k].high >= c.high) {
        isHigh = false; break;
      }
    }
    if (isHigh) {
      pivots.push({
        ts: c.ts, type: 'high', price: c.high,
        confirmedAt: primaryCandles[i + N].ts, symbol: c.symbol,
      });
      continue;
    }

    // Swing low
    let isLow = true;
    for (let k = 1; k <= N; k++) {
      if (primaryCandles[i - k].low <= c.low || primaryCandles[i + k].low <= c.low) {
        isLow = false; break;
      }
    }
    if (isLow) {
      pivots.push({
        ts: c.ts, type: 'low', price: c.low,
        confirmedAt: primaryCandles[i + N].ts, symbol: c.symbol,
      });
    }
  }
  return pivots;
}

// --- Main ---------------------------------------------------------------------

(async () => {
  const t0 = Date.now();
  console.log(`Range: ${new Date(START_TS).toISOString()} → ${new Date(END_TS).toISOString()}, N=${N}`);
  const { rows, hourVolumes } = await pass1Collect();
  const primary = buildPrimaryMap(hourVolumes);

  // Filter rows to primary-contract-only and sort by ts ascending
  const primaryRows = rows.filter(r => {
    const hourKey = Math.floor(r.ts / 3_600_000);
    return primary.get(hourKey) === r.symbol;
  });
  primaryRows.sort((a, b) => a.ts - b.ts);
  console.log(`Primary-contract candles: ${primaryRows.length}`);

  const pivots = detectPivots(primaryRows, N);
  console.log(`Pivots detected: ${pivots.length} (highs=${pivots.filter(p => p.type === 'high').length} lows=${pivots.filter(p => p.type === 'low').length})`);

  const headerLine = 'ts_event,type,price,confirmed_at,symbol';
  const lines = [headerLine];
  for (const p of pivots) {
    lines.push([
      new Date(p.ts).toISOString(),
      p.type,
      p.price,
      new Date(p.confirmedAt).toISOString(),
      p.symbol,
    ].join(','));
  }
  fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n');

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Wrote ${OUT_PATH} in ${elapsed}s`);
})().catch(e => { console.error(e); process.exit(1); });
