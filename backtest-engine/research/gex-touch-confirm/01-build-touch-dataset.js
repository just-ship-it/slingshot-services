/**
 * Phase 1: Wide-net GEX-touch dataset
 *
 * For every RTH minute where NQ price comes within --touch-distance pts of any
 * GEX level (S1-S5, R1-R5, gamma_flip, call_wall, put_wall), emit BOTH bounce
 * and break candidate trades at multiple stop distances (--stop-distances), walk
 * forward up to --max-hold-min, and record win/loss/timeout outcomes for a
 * --target-points target. Same-bar stop+target hits are flagged as 'ambiguous'
 * for 1s resolution in a follow-up step (see 01b-resolve-ambiguity-1s.js).
 *
 * Setup direction mapping (per touch with approach in {from_above, from_below}):
 *   bounce: trade RETURNS the way price came
 *     - from_above + bounce -> LONG (price came down, rebounds up)
 *     - from_below + bounce -> SHORT (price came up, rebounds down)
 *   break: trade CONTINUES through the level
 *     - from_above + break -> SHORT (price came down, breaks through)
 *     - from_below + break -> LONG (price came up, breaks through)
 *
 * Output: backtest-engine/research/output/gex-touch-confirm-base-${ts}.touches.json
 *
 * Required data quality:
 *   - Raw contracts (NQ_ohlcv_1m.csv) + per-hour primary contract filter
 *   - GEX from data/gex/nq-cbbo/ (post-lookahead-fix)
 *   - Snapshot lookup uses snap_ts <= candle_ts - SNAP_LAG_MIN (default 16 min)
 *
 * Usage:
 *   node research/gex-touch-confirm/01-build-touch-dataset.js \
 *     --start 2025-01-13 --end 2026-04-23 \
 *     --touch-distance 10 --cooldown-min 0 \
 *     --gex-dir nq-cbbo
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'research', 'output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// --- CLI ---
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const START = arg('start', '2025-01-13');
const END = arg('end', '2026-04-23');
const TOUCH_DISTANCE = Number(arg('touch-distance', 10));
const COOLDOWN_MIN = Number(arg('cooldown-min', 0));
const PRODUCT = arg('product', 'NQ').toUpperCase();
const GEX_DIR = arg('gex-dir', 'nq-cbbo');
const TARGET_POINTS = Number(arg('target-points', 20));
const STOP_DISTANCES = String(arg('stop-distances', '8,10,12,15,20'))
  .split(',').map(Number).filter(n => n > 0);
const MAX_HOLD_MIN = Number(arg('max-hold-min', 120));
const SNAP_LAG_MIN = Number(arg('snap-lag-min', 16));
const HORIZONS = [5, 15, 30, 60, 120];

console.log(`\n=== GEX Touch Confirm Study — Phase 1 (wide-net) ===`);
console.log(`Range:           ${START} → ${END}`);
console.log(`Touch distance:  ${TOUCH_DISTANCE} pts`);
console.log(`Cooldown:        ${COOLDOWN_MIN} min`);
console.log(`Target:          ${TARGET_POINTS} pts`);
console.log(`Stop distances:  [${STOP_DISTANCES.join(', ')}] pts`);
console.log(`Max hold:        ${MAX_HOLD_MIN} min`);
console.log(`GEX dir:         data/gex/${GEX_DIR}`);
console.log(`Snap lag:        ${SNAP_LAG_MIN} min (lookahead correction)\n`);

// --- GEX snapshot loader ---
function loadIntradayGEXCustom(dateStr) {
  const filename = `${PRODUCT.toLowerCase()}_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', GEX_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return content.data || [];
}

// --- Raw OHLCV loader ---
async function loadRawNQ(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  if (!fs.existsSync(filePath)) throw new Error(`OHLCV not found: ${filePath}`);

  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime() + 24 * 3600000;

  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return; // skip calendar spreads
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const c = {
          timestamp: ts,
          open: +row.open, high: +row.high, low: +row.low, close: +row.close,
          volume: +row.volume || 0, symbol: row.symbol,
        };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${candles.length.toLocaleString()} raw candles`);
  return candles;
}

// --- Per-hour primary contract filter ---
// Returns { filtered, primaryByHour } so 1s resolution can reuse the contract map.
function filterPrimaryContract(candles) {
  if (!candles.length) return { filtered: candles, primaryByHour: new Map() };
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const primaryByHour = new Map();
  for (const [h, m] of hourVol.entries()) {
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    primaryByHour.set(h, bestSym);
  }
  const filtered = [];
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (c.symbol === primaryByHour.get(h)) filtered.push(c);
  }
  return { filtered, primaryByHour };
}

// --- GEX snapshot at-or-before lookup ---
function snapshotAtOrBefore(snapshots, targetTs) {
  if (!snapshots || !snapshots.length) return null;
  let best = null;
  let bestTs = -Infinity;
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).getTime();
    if (ts <= targetTs && ts > bestTs) {
      best = s;
      bestTs = ts;
    }
  }
  return best;
}

// --- Flatten snapshot into [{type, price, gex, isResistance}] ---
function extractLevels(snap) {
  const levels = [];
  if (!snap) return levels;
  if (snap.call_wall != null) {
    levels.push({ type: 'call_wall', price: snap.call_wall, gex: snap.call_wall_gex || 0, isResistance: true });
  }
  if (snap.put_wall != null) {
    levels.push({ type: 'put_wall', price: snap.put_wall, gex: snap.put_wall_gex || 0, isResistance: false });
  }
  if (snap.gamma_flip != null) {
    levels.push({ type: 'gamma_flip', price: snap.gamma_flip, gex: 0, isResistance: null });
  }
  if (Array.isArray(snap.resistance)) {
    for (let i = 0; i < snap.resistance.length; i++) {
      if (snap.resistance[i] != null) {
        levels.push({
          type: `R${i + 1}`,
          price: snap.resistance[i],
          gex: snap.resistance_gex?.[i] || 0,
          isResistance: true,
        });
      }
    }
  }
  if (Array.isArray(snap.support)) {
    for (let i = 0; i < snap.support.length; i++) {
      if (snap.support[i] != null) {
        levels.push({
          type: `S${i + 1}`,
          price: snap.support[i],
          gex: snap.support_gex?.[i] || 0,
          isResistance: false,
        });
      }
    }
  }
  return levels;
}

// --- Buckets ---
function todBucket(minutesET) {
  if (minutesET < 570) return 'pre_rth';
  if (minutesET < 600) return 'open_30';
  if (minutesET < 720) return 'morning';
  if (minutesET < 840) return 'lunch';
  if (minutesET < 930) return 'afternoon';
  if (minutesET < 960) return 'close_30';
  return 'post_rth';
}
function gexMagBucket(absGex) {
  if (absGex < 1e8) return '<100M';
  if (absGex < 5e8) return '100M-500M';
  if (absGex < 1e9) return '500M-1B';
  if (absGex < 5e9) return '1B-5B';
  return '5B+';
}

// --- Setup → direction map ---
// approach: 'from_above' or 'from_below'
function setupToDirection(setup, approach) {
  if (setup === 'bounce') {
    return approach === 'from_above' ? 'long' : 'short';
  }
  // break
  return approach === 'from_above' ? 'short' : 'long';
}

// --- Walk forward and resolve outcomes for all stop tiers in one pass ---
// Stops walking if the forward bar's symbol differs from the entry symbol
// (contract rollover); any unresolved stop tier is marked 'rollover'.
function walkForwardMulti(byTs, entryTs, entrySymbol, direction, entryPrice, target, stops, maxHoldMin) {
  const targetPrice = direction === 'long' ? entryPrice + target : entryPrice - target;
  const perStop = stops.map(s => ({
    stop: s,
    stopPrice: direction === 'long' ? entryPrice - s : entryPrice + s,
    resolved: false,
    outcome: null,
    exitMinutes: null,
    exitPrice: null,
    ambiguousBarTs: null,
    ambiguousBarHigh: null,
    ambiguousBarLow: null,
    ambiguousBarOpen: null,
    ambiguousBarClose: null,
  }));

  let mfe = 0, mae = 0;
  const horizonStats = {};
  let rolloverEncountered = false;
  let lastBarsWalked = 0;

  for (let k = 1; k <= maxHoldMin; k++) {
    const bar = byTs.get(entryTs + k * 60000);
    if (!bar) {
      if (HORIZONS.includes(k)) horizonStats[k] = { mfe, mae, close: null };
      continue;
    }

    // Contract rollover guard: if primary symbol changed, stop walking. Any
    // unresolved stop tier is marked 'rollover' to avoid spurious wins/losses
    // from the ~200-300pt raw-price spread at rollover.
    if (bar.symbol !== entrySymbol) {
      rolloverEncountered = true;
      break;
    }
    lastBarsWalked = k;

    const upMove = bar.high - entryPrice;
    const dnMove = entryPrice - bar.low;
    if (direction === 'long') {
      if (upMove > mfe) mfe = upMove;
      if (dnMove > mae) mae = dnMove;
    } else {
      if (dnMove > mfe) mfe = dnMove;
      if (upMove > mae) mae = upMove;
    }
    if (HORIZONS.includes(k)) horizonStats[k] = { mfe, mae, close: bar.close };

    for (const s of perStop) {
      if (s.resolved) continue;
      const targetHit = direction === 'long' ? bar.high >= targetPrice : bar.low <= targetPrice;
      const stopHit = direction === 'long' ? bar.low <= s.stopPrice : bar.high >= s.stopPrice;

      if (targetHit && stopHit) {
        s.resolved = true;
        s.outcome = 'ambiguous';
        s.exitMinutes = k;
        s.ambiguousBarTs = bar.timestamp;
        s.ambiguousBarHigh = bar.high;
        s.ambiguousBarLow = bar.low;
        s.ambiguousBarOpen = bar.open;
        s.ambiguousBarClose = bar.close;
      } else if (targetHit) {
        s.resolved = true;
        s.outcome = 'win';
        s.exitMinutes = k;
        s.exitPrice = targetPrice;
      } else if (stopHit) {
        s.resolved = true;
        s.outcome = 'loss';
        s.exitMinutes = k;
        s.exitPrice = s.stopPrice;
      }
    }
  }

  for (const h of HORIZONS) {
    if (!(h in horizonStats)) horizonStats[h] = { mfe, mae, close: null };
  }
  for (const s of perStop) {
    if (!s.resolved) {
      s.outcome = rolloverEncountered ? 'rollover' : 'timeout';
      s.exitMinutes = lastBarsWalked || maxHoldMin;
    }
  }

  return {
    targetPrice,
    horizonStats,
    perStop,
    finalMfe: mfe,
    finalMae: mae,
    rolloverEncountered,
  };
}

// --- Main ---
async function run() {
  const startedAt = Date.now();
  const allCandles = await loadRawNQ(START, END);
  const { filtered: candles, primaryByHour } = filterPrimaryContract(allCandles);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);
  console.log(`Primary-contract hours mapped: ${primaryByHour.size.toLocaleString()}\n`);

  // Indices
  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);

  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ candle: c, et });
  }
  const tradingDates = Array.from(byDate.keys()).sort();
  console.log(`Trading dates: ${tradingDates.length}`);

  const touches = [];
  let snapHits = 0, snapMisses = 0;
  let totalEvents = 0, ambiguousCount = 0;

  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEXCustom(dateStr);
    if (!snapshots || !snapshots.length) { snapMisses++; continue; }
    snapHits++;

    const dayCandles = byDate.get(dateStr) || [];
    const lastTouchTs = new Map(); // signature -> timestamp (cooldown)
    let prevClose = null;

    for (const { candle: c, et } of dayCandles) {
      // RTH only: 9:30 (570) — 16:00 (960)
      if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) { prevClose = c.close; continue; }

      const snap = snapshotAtOrBefore(snapshots, c.timestamp - SNAP_LAG_MIN * 60000);
      if (!snap) { prevClose = c.close; continue; }

      const levels = extractLevels(snap);

      for (const lvl of levels) {
        if (lvl.price == null || isNaN(lvl.price)) continue;

        // Cooldown by level signature
        if (COOLDOWN_MIN > 0) {
          const sig = `${lvl.type}@${lvl.price.toFixed(2)}`;
          const last = lastTouchTs.get(sig);
          if (last && (c.timestamp - last) < COOLDOWN_MIN * 60000) continue;
        }

        // Touch: candle high/low within TOUCH_DISTANCE of level
        const distLow = Math.abs(c.low - lvl.price);
        const distHigh = Math.abs(c.high - lvl.price);
        const minDist = Math.min(distLow, distHigh);
        if (minDist > TOUCH_DISTANCE) continue;

        if (prevClose == null) continue;
        let approach;
        if (prevClose > lvl.price) approach = 'from_above';
        else if (prevClose < lvl.price) approach = 'from_below';
        else continue; // exactly on level — skip

        // Touch metadata
        const entryPrice = lvl.price;
        const touch = {
          id: touches.length,
          ts: c.timestamp,
          date: dateStr,
          time_et: `${String(Math.floor(et.timeInMinutes / 60)).padStart(2, '0')}:${String(et.timeInMinutes % 60).padStart(2, '0')}`,
          tod: todBucket(et.timeInMinutes),
          level_type: lvl.type,
          level_price: lvl.price,
          level_gex: lvl.gex,
          level_is_resistance: lvl.isResistance,
          touch_low_dist: distLow,
          touch_high_dist: distHigh,
          approach,
          regime: snap.regime || 'unknown',
          total_gex: snap.total_gex || 0,
          gamma_imbalance: snap.gamma_imbalance || 0,
          nq_spot_in_snap: snap.nq_spot,
          gex_mag_bucket: gexMagBucket(Math.abs(lvl.gex)),
          snap_ts: snap.timestamp,
          entry_price: entryPrice,
          entry_symbol: c.symbol,
          outcomes: [],
        };

        // Both setups
        for (const setup of ['bounce', 'break']) {
          const direction = setupToDirection(setup, approach);
          const res = walkForwardMulti(byTs, c.timestamp, c.symbol, direction, entryPrice,
            TARGET_POINTS, STOP_DISTANCES, MAX_HOLD_MIN);

          const outcomeBlock = {
            setup,
            direction,
            target_price: res.targetPrice,
            mfe_at_5: res.horizonStats[5]?.mfe ?? null,
            mfe_at_15: res.horizonStats[15]?.mfe ?? null,
            mfe_at_30: res.horizonStats[30]?.mfe ?? null,
            mfe_at_60: res.horizonStats[60]?.mfe ?? null,
            mfe_at_120: res.horizonStats[120]?.mfe ?? null,
            mae_at_5: res.horizonStats[5]?.mae ?? null,
            mae_at_15: res.horizonStats[15]?.mae ?? null,
            mae_at_30: res.horizonStats[30]?.mae ?? null,
            mae_at_60: res.horizonStats[60]?.mae ?? null,
            mae_at_120: res.horizonStats[120]?.mae ?? null,
            close_at_5: res.horizonStats[5]?.close ?? null,
            close_at_15: res.horizonStats[15]?.close ?? null,
            close_at_30: res.horizonStats[30]?.close ?? null,
            close_at_60: res.horizonStats[60]?.close ?? null,
            close_at_120: res.horizonStats[120]?.close ?? null,
            final_mfe: res.finalMfe,
            final_mae: res.finalMae,
            stops: res.perStop.map(s => ({
              stop: s.stop,
              stop_price: s.stopPrice,
              outcome: s.outcome,
              exit_minutes: s.exitMinutes,
              exit_price: s.exitPrice,
              ambiguous_bar_ts: s.ambiguousBarTs,
              ambiguous_bar_high: s.ambiguousBarHigh,
              ambiguous_bar_low: s.ambiguousBarLow,
              ambiguous_bar_open: s.ambiguousBarOpen,
              ambiguous_bar_close: s.ambiguousBarClose,
            })),
          };
          for (const s of outcomeBlock.stops) {
            totalEvents++;
            if (s.outcome === 'ambiguous') ambiguousCount++;
          }
          touch.outcomes.push(outcomeBlock);
        }

        touches.push(touch);
        if (COOLDOWN_MIN > 0) {
          lastTouchTs.set(`${lvl.type}@${lvl.price.toFixed(2)}`, c.timestamp);
        }
      }
      prevClose = c.close;
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n--- Phase 1 walk complete (${elapsedSec}s) ---`);
  console.log(`Snapshot files hit: ${snapHits}  | missing: ${snapMisses}`);
  console.log(`Touches: ${touches.length.toLocaleString()}`);
  console.log(`Outcome rows: ${totalEvents.toLocaleString()} (touches × 2 setups × ${STOP_DISTANCES.length} stops)`);
  console.log(`Ambiguous (same-bar stop+target): ${ambiguousCount.toLocaleString()} (${(100 * ambiguousCount / totalEvents).toFixed(2)}%)\n`);

  // Quick baseline summary by setup × stop
  printBaselineSummary(touches);

  // Serialize primaryByHour as plain object for the 1s resolver
  const primaryByHourObj = {};
  for (const [h, sym] of primaryByHour.entries()) primaryByHourObj[h] = sym;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outBase = path.join(OUT_DIR, `gex-touch-confirm-base-${ts}`);
  const payload = {
    config: {
      START, END, TOUCH_DISTANCE, COOLDOWN_MIN, PRODUCT, GEX_DIR,
      TARGET_POINTS, STOP_DISTANCES, MAX_HOLD_MIN, SNAP_LAG_MIN, HORIZONS,
    },
    stats: {
      candles_loaded: allCandles.length,
      candles_after_primary_filter: candles.length,
      trading_dates: tradingDates.length,
      snap_hits: snapHits, snap_misses: snapMisses,
      touches: touches.length,
      outcome_rows: totalEvents,
      ambiguous_rows: ambiguousCount,
      ambiguous_pct: totalEvents ? ambiguousCount / totalEvents : 0,
      runtime_sec: Number(elapsedSec),
    },
    primary_by_hour: primaryByHourObj,
    touches,
  };
  fs.writeFileSync(`${outBase}.touches.json`, JSON.stringify(payload));
  console.log(`Written: ${outBase}.touches.json`);
  console.log(`File size: ${(fs.statSync(`${outBase}.touches.json`).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`\nNext step: resolve same-bar ambiguities with 1s data:`);
  console.log(`  node research/gex-touch-confirm/01b-resolve-ambiguity-1s.js --in ${path.relative(ROOT, outBase + '.touches.json')}\n`);
}

function printBaselineSummary(touches) {
  console.log('=== Baseline by setup × stop_distance (pre-1s-resolution) ===');
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
    'loss%'.padStart(8), 'amb%'.padStart(8), 'roll%'.padStart(8), 'time%'.padStart(8), 'rough_pf'.padStart(10));
  const rows = Array.from(buckets.entries()).sort();
  for (const [k, b] of rows) {
    const [setup, stop] = k.split('|');
    const winPct = 100 * b.wins / b.n;
    const lossPct = 100 * b.losses / b.n;
    const ambPct = 100 * b.ambiguous / b.n;
    const rollPct = 100 * b.rollover / b.n;
    const timePct = 100 * b.timeouts / b.n;
    const winsCount = b.wins + 0.5 * b.ambiguous;
    const lossesCount = b.losses + 0.5 * b.ambiguous;
    const stopN = Number(stop);
    const grossWin = winsCount * TARGET_POINTS;
    const grossLoss = lossesCount * stopN;
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    console.log(setup.padEnd(8), String(stop).padStart(5), String(b.n).padStart(8),
      winPct.toFixed(1).padStart(8), lossPct.toFixed(1).padStart(8),
      ambPct.toFixed(1).padStart(8), rollPct.toFixed(1).padStart(8),
      timePct.toFixed(1).padStart(8), pf.toFixed(2).padStart(10));
  }
  console.log('\n(rough_pf assumes ambiguous = 50/50; resolve with 1s for honest numbers)\n');
}

run().catch(e => { console.error(e); process.exit(1); });
