/**
 * Track E4 — MFE/MAE measurement + TP/SL grid sweep for GEX × LT crossovers
 *
 * For every crossover event in the 1m/3m/15m feeds, walk NQ raw 1m candles
 * forward from the entry candle and capture, per horizon:
 *   - MFE  (max favorable excursion, in the predicted direction)
 *   - MAE  (max adverse excursion)
 *   - tMFE (minutes to reach MFE)
 *   - tMAE (minutes to reach MAE)
 *
 * "Predicted direction" comes from the crossover sign:
 *   gex_above_lt → bullish (favorable = up from entry_open)
 *   gex_below_lt → bearish (favorable = down from entry_open)
 *
 * Then for each (timeframe, gex_type, direction, solo|confirmed) setup that
 * meets a min-sample threshold, run a TP/SL grid sweep simulating
 * "first-to-hit wins" execution:
 *   - Walk minute-by-minute. If MFE_so_far >= TP first, exit at +TP. If
 *     MAE_so_far >= SL first, exit at -SL. If neither in window, exit at
 *     close of last bar (signed by direction).
 *
 * Output per setup:
 *   - MFE/MAE percentile distribution
 *   - Best (TP, SL) by expectancy in the grid
 *   - Win rate, profit factor, expectancy at the best params
 *
 * Run:
 *   node research/track-e4-mfe-mae.js \
 *     --f1m  output/track-e2-1m-lt-crossovers-{1m}.events.json \
 *     --f3m  output/track-e2-1m-lt-crossovers-{3m}.events.json \
 *     --f15m output/track-e-gex-lt-interactions-{15m}.crossovers.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET } from './utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'research', 'output');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const F1M = arg('f1m', null);
const F3M = arg('f3m', null);
const F15M = arg('f15m', null);
const PRODUCT = arg('product', 'NQ').toUpperCase();
const HORIZON_MIN = Number(arg('horizon-min', 60));
const CONFIRM_WINDOW_MIN = Number(arg('confirm-window-min', 30));
const MIN_SAMPLE = Number(arg('min-sample', 200));

if (!F1M || !F3M || !F15M) {
  console.error('Required: --f1m PATH --f3m PATH --f15m PATH');
  process.exit(1);
}

console.log('=== Track E4: MFE/MAE + TP/SL sweep ===');
console.log(`Horizon: ${HORIZON_MIN} min | Confirm window: ±${CONFIRM_WINDOW_MIN} min | Min sample: ${MIN_SAMPLE}\n`);

// ──────────────────────────────────────────────────────────────────────────
// Load NQ raw candles, filter primary contract
// ──────────────────────────────────────────────────────────────────────────
async function loadRawNQ() {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts)) return;
        const c = { timestamp: ts, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume || 0, symbol: row.symbol };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

function filterPrimaryContract(candles) {
  if (!candles.length) return candles;
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const out = [];
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    const m = hourVol.get(h);
    if (!m) { out.push(c); continue; }
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    if (c.symbol === bestSym) out.push(c);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Normalize event schemas (1m/3m use `ts`, 15m uses `snap_ts`)
// ──────────────────────────────────────────────────────────────────────────
function normalize(events, tsField, tfLabel) {
  return events.map(e => ({
    tf: tfLabel,
    ts: e[tsField],
    gex_type: e.gex_type,
    direction: e.direction,
    lt_idx: e.lt_idx,
  })).filter(e => e.ts != null && e.gex_type && e.direction)
    .sort((a, b) => a.ts - b.ts);
}

function bucketByKey(events) {
  const out = new Map();
  for (const e of events) {
    const k = `${e.gex_type}|${e.direction}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(e);
  }
  return out;
}

function hasWithinWindow(byKey, target, windowMin) {
  const k = `${target.gex_type}|${target.direction}`;
  const arr = byKey.get(k);
  if (!arr || !arr.length) return false;
  const W = windowMin * 60000;
  const minTs = target.ts - W, maxTs = target.ts + W;
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].ts < minTs) lo = mid + 1; else hi = mid;
  }
  if (lo >= arr.length) return false;
  return arr[lo].ts <= maxTs;
}

// ──────────────────────────────────────────────────────────────────────────
// Walk a single event's intra-window NQ candles. Returns a per-minute
// trajectory and the overall MFE/MAE at the full horizon.
// ──────────────────────────────────────────────────────────────────────────
function walkEvent(byTs, event, horizonMin) {
  const entry = byTs.get(event.ts);
  if (!entry) return null;
  const entryEt = toET(entry.timestamp);
  const entryDate = entryEt.date;
  const direction = event.direction; // gex_above_lt or gex_below_lt
  const isBullish = direction === 'gex_above_lt';
  const entryOpen = entry.open;

  // Per-minute running MFE/MAE
  // mfeAt[t] = max favorable excursion in minutes [1..t]
  // maeAt[t] = max adverse excursion in minutes [1..t]
  const mfeAt = new Float32Array(horizonMin + 1);
  const maeAt = new Float32Array(horizonMin + 1);
  let mfe = 0, mae = 0;
  let tMFE = 0, tMAE = 0;
  let lastClose = null;
  let bars = 0;

  for (let k = 1; k <= horizonMin; k++) {
    const c = byTs.get(entry.timestamp + k * 60000);
    if (!c) {
      // Gap or end; carry forward last MFE/MAE
      mfeAt[k] = mfe;
      maeAt[k] = mae;
      continue;
    }
    const cEt = toET(c.timestamp);
    if (cEt.date !== entryDate) {
      // Don't cross day boundary in MFE/MAE accounting (overnight gap risk)
      mfeAt[k] = mfe;
      maeAt[k] = mae;
      continue;
    }
    bars++;
    const upMove = c.high - entryOpen;
    const dnMove = entryOpen - c.low;
    const fav = isBullish ? upMove : dnMove;
    const adv = isBullish ? dnMove : upMove;
    if (fav > mfe) { mfe = fav; tMFE = k; }
    if (adv > mae) { mae = adv; tMAE = k; }
    mfeAt[k] = mfe;
    maeAt[k] = mae;
    lastClose = c.close;
  }

  // Signed return at horizon (in direction's favor)
  let signedReturn = null;
  if (lastClose != null) {
    const raw = lastClose - entryOpen;
    signedReturn = isBullish ? raw : -raw;
  }

  return { mfe, mae, tMFE, tMAE, mfeAt, maeAt, bars, signedReturn };
}

// ──────────────────────────────────────────────────────────────────────────
// Simulate "first to hit wins" execution given (tp, sl) and a walk.
//   Returns { outcome: 'tp'|'sl'|'time', pnl }
// At each minute, check MFE_so_far ≥ tp AND MAE_so_far ≥ sl. If both crossed
// in the same bar, we conservatively assume SL hit first (the bar's high+low
// span includes both, but the order is unknown). This biases reported
// expectancy slightly downward, which is the safer side for backtest claims.
// ──────────────────────────────────────────────────────────────────────────
function simulate(walk, tp, sl, horizonMin) {
  const { mfeAt, maeAt, signedReturn } = walk;
  for (let k = 1; k <= horizonMin; k++) {
    const tpHit = mfeAt[k] >= tp;
    const slHit = maeAt[k] >= sl;
    if (tpHit && slHit) return { outcome: 'sl', pnl: -sl }; // conservative
    if (tpHit) return { outcome: 'tp', pnl: tp };
    if (slHit) return { outcome: 'sl', pnl: -sl };
  }
  // Time exit
  return { outcome: 'time', pnl: signedReturn ?? 0 };
}

// ──────────────────────────────────────────────────────────────────────────
// Stats helpers
// ──────────────────────────────────────────────────────────────────────────
function percentiles(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: arr.length,
    mean: arr.reduce((s, v) => s + v, 0) / arr.length,
    p25: s[Math.floor(arr.length * 0.25)],
    p50: s[Math.floor(arr.length * 0.50)],
    p75: s[Math.floor(arr.length * 0.75)],
    p90: s[Math.floor(arr.length * 0.90)],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Loading raw NQ candles…');
  const allCandles = await loadRawNQ();
  const candles = filterPrimaryContract(allCandles);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);
  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);

  console.log('Loading event files…');
  const e1m = normalize(JSON.parse(fs.readFileSync(F1M, 'utf-8')), 'ts', '1m');
  const e3m = normalize(JSON.parse(fs.readFileSync(F3M, 'utf-8')), 'ts', '3m');
  const e15m = normalize(JSON.parse(fs.readFileSync(F15M, 'utf-8')), 'snap_ts', '15m');
  console.log(`Events: 1m=${e1m.length}  3m=${e3m.length}  15m=${e15m.length}`);

  const byKey15m = bucketByKey(e15m);

  // ──────────────────────────────────────────────────────────────────────
  // Walk every event and collect MFE/MAE
  // ──────────────────────────────────────────────────────────────────────
  function walkAll(events) {
    const out = [];
    let dropped = 0;
    for (const e of events) {
      const w = walkEvent(byTs, e, HORIZON_MIN);
      if (!w) { dropped++; continue; }
      out.push({ ...e, walk: w });
    }
    return { walked: out, dropped };
  }
  console.log('Walking 1m events…');
  const w1 = walkAll(e1m);
  console.log(`  walked=${w1.walked.length.toLocaleString()}  dropped=${w1.dropped}`);
  console.log('Walking 3m events…');
  const w3 = walkAll(e3m);
  console.log(`  walked=${w3.walked.length.toLocaleString()}  dropped=${w3.dropped}`);
  console.log('Walking 15m events…');
  const w15 = walkAll(e15m);
  console.log(`  walked=${w15.walked.length.toLocaleString()}  dropped=${w15.dropped}\n`);

  // Tag each event with solo/confirmed status (via 15m presence in ±W)
  function tagSoloConfirmed(events) {
    for (const e of events) {
      e.confirmed_15m = hasWithinWindow(byKey15m, e, CONFIRM_WINDOW_MIN);
    }
  }
  tagSoloConfirmed(w1.walked);
  tagSoloConfirmed(w3.walked);
  // For 15m events themselves, "confirmed" is N/A — leave as null

  // ──────────────────────────────────────────────────────────────────────
  // Per-setup MFE/MAE percentile tables
  // ──────────────────────────────────────────────────────────────────────
  function makeBuckets(walked) {
    // Group by gex_type | direction | solo/confirmed
    const groups = new Map();
    for (const e of walked) {
      const status = e.confirmed_15m === true ? 'confirmed'
                   : e.confirmed_15m === false ? 'solo'
                   : 'all';
      const k = `${e.gex_type}|${e.direction}|${status}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    return groups;
  }

  // Print MFE/MAE percentiles for the strongest 3m setups (where the action is)
  console.log('═'.repeat(112));
  console.log('MFE/MAE percentiles per setup (3m timeframe, n>=' + MIN_SAMPLE + ')');
  console.log('═'.repeat(112));
  console.log('setup'.padEnd(46), 'n'.padStart(6),
    'MFE p25/p50/p75/p90'.padStart(24),
    'MAE p25/p50/p75/p90'.padStart(24),
    'avg tMFE'.padStart(8), 'avg tMAE'.padStart(8));

  const groups3m = makeBuckets(w3.walked);
  const sortedKeys = Array.from(groups3m.keys())
    .filter(k => groups3m.get(k).length >= MIN_SAMPLE)
    .sort();
  for (const k of sortedKeys) {
    const arr = groups3m.get(k);
    const mfe = percentiles(arr.map(e => e.walk.mfe));
    const mae = percentiles(arr.map(e => e.walk.mae));
    const tMfe = arr.reduce((s, e) => s + e.walk.tMFE, 0) / arr.length;
    const tMae = arr.reduce((s, e) => s + e.walk.tMAE, 0) / arr.length;
    console.log(k.padEnd(46), String(arr.length).padStart(6),
      `${mfe.p25.toFixed(0)}/${mfe.p50.toFixed(0)}/${mfe.p75.toFixed(0)}/${mfe.p90.toFixed(0)}`.padStart(24),
      `${mae.p25.toFixed(0)}/${mae.p50.toFixed(0)}/${mae.p75.toFixed(0)}/${mae.p90.toFixed(0)}`.padStart(24),
      tMfe.toFixed(1).padStart(8), tMae.toFixed(1).padStart(8));
  }

  // ──────────────────────────────────────────────────────────────────────
  // TP/SL grid sweep — only on the most promising 3m setups
  // ──────────────────────────────────────────────────────────────────────
  const TP_GRID = [10, 15, 20, 25, 30, 40, 50, 60, 80];
  const SL_GRID = [10, 15, 20, 25, 30, 40, 50];

  console.log('\n' + '═'.repeat(112));
  console.log(`TP/SL grid sweep on 3m setups with n>=${MIN_SAMPLE}. Per setup, top 5 (TP, SL) combos by expectancy.`);
  console.log('═'.repeat(112));

  const allBest = [];
  for (const k of sortedKeys) {
    const arr = groups3m.get(k);
    const combos = [];
    for (const tp of TP_GRID) {
      for (const sl of SL_GRID) {
        let tpHits = 0, slHits = 0, timeouts = 0, posOutcomes = 0;
        let sumPnl = 0, sumWinPnl = 0, sumLossPnl = 0;
        for (const e of arr) {
          const r = simulate(e.walk, tp, sl, HORIZON_MIN);
          sumPnl += r.pnl;
          if (r.outcome === 'tp') { tpHits++; sumWinPnl += r.pnl; posOutcomes++; }
          else if (r.outcome === 'sl') { slHits++; sumLossPnl += r.pnl; }
          else {
            timeouts++;
            if (r.pnl > 0) { sumWinPnl += r.pnl; posOutcomes++; }
            else if (r.pnl < 0) { sumLossPnl += r.pnl; }
          }
        }
        const n = arr.length;
        const exp = sumPnl / n;
        const winRate = posOutcomes / n;
        const pf = sumLossPnl < 0 ? sumWinPnl / Math.abs(sumLossPnl) : Infinity;
        combos.push({ tp, sl, n, tpHits, slHits, timeouts, exp, winRate, pf });
      }
    }
    combos.sort((a, b) => b.exp - a.exp);
    const top = combos.slice(0, 5);

    console.log(`\n${k}  (n=${arr.length})`);
    console.log('  TP/SL'.padEnd(8), 'tp_hit'.padStart(7), 'sl_hit'.padStart(7),
      'time'.padStart(6), 'exp_pt'.padStart(8), 'pf'.padStart(6), 'winRate'.padStart(8));
    for (const c of top) {
      console.log(`  ${c.tp}/${c.sl}`.padEnd(8),
        String(c.tpHits).padStart(7),
        String(c.slHits).padStart(7),
        String(c.timeouts).padStart(6),
        c.exp.toFixed(2).padStart(8),
        (isFinite(c.pf) ? c.pf.toFixed(2) : '∞').padStart(6),
        (c.winRate * 100).toFixed(1).padStart(7) + '%');
    }
    allBest.push({ setup: k, n: arr.length, best: top[0] });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Summary: best (TP, SL) per setup, sorted by expectancy × n
  // ──────────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(112));
  console.log('Summary — best (TP, SL) per 3m setup, sorted by total expected pts (exp × n)');
  console.log('═'.repeat(112));
  console.log('setup'.padEnd(46), 'n'.padStart(6),
    'TP/SL'.padStart(8), 'exp_pt'.padStart(8), 'pf'.padStart(6),
    'winRate'.padStart(8), 'totalPts'.padStart(10));
  allBest.sort((a, b) => b.best.exp * b.n - a.best.exp * a.n);
  for (const r of allBest) {
    console.log(r.setup.padEnd(46), String(r.n).padStart(6),
      `${r.best.tp}/${r.best.sl}`.padStart(8),
      r.best.exp.toFixed(2).padStart(8),
      (isFinite(r.best.pf) ? r.best.pf.toFixed(2) : '∞').padStart(6),
      (r.best.winRate * 100).toFixed(1).padStart(7) + '%',
      (r.best.exp * r.n).toFixed(0).padStart(10));
  }

  // Persist
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `track-e4-mfe-mae-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    inputs: { F1M, F3M, F15M },
    params: { HORIZON_MIN, CONFIRM_WINDOW_MIN, MIN_SAMPLE, TP_GRID, SL_GRID },
    counts: { e1m: e1m.length, e3m: e3m.length, e15m: e15m.length,
              walked_1m: w1.walked.length, walked_3m: w3.walked.length, walked_15m: w15.walked.length },
    setups_3m: allBest,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
