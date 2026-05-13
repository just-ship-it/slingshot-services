/**
 * Phase 1 v2: Wide-net GEX-touch dataset with LIMIT-at-level entry model.
 *
 * v1 used "entry = level price + walk forward from next bar," which combined
 * with features computed over the full touch minute (e.g., 1s VWAP close)
 * produced lookahead bias: the filter could see end-of-minute 1s data that
 * arrived after the moment of presumed entry.
 *
 * v2 fixes this with a realistic limit-order fill model:
 *   - Touch detected on 1m bar M's close (1m high/low within --touch-distance
 *     of any GEX level).
 *   - Signal moment = end of bar M. Confirmation features are observable here.
 *   - A LIMIT order at the level price is placed for bars M+1..M+LIMIT_TIMEOUT.
 *   - Fill occurs on the first subsequent bar that revisits the level:
 *       LONG  limit (bounce from_above, break from_below): bar.low  <= level
 *       SHORT limit (bounce from_below, break from_above): bar.high >= level
 *   - If no fill within timeout, outcome = 'no_fill' for all stop tiers.
 *   - On fill, target/stop are checked starting on the FILL BAR itself (since
 *     a long wick can take us past target or stop after touching level), and
 *     then forward until --max-hold-min minutes after M.
 *
 * Setup direction map:
 *   bounce: trade RETURNS (LONG from_above, SHORT from_below)
 *   break:  trade CONTINUES (SHORT from_above, LONG from_below)
 *
 * Stops/targets are anchored at the LEVEL (structural S/R), not entry:
 *   LONG:  target = level + 20, stop = level - stop_distance
 *   SHORT: target = level - 20, stop = level + stop_distance
 *
 * Output: backtest-engine/research/output/gex-touch-confirm-v2-base-${ts}.touches.json
 *
 * Usage:
 *   node research/gex-touch-confirm/01v2-build-touch-dataset.js \
 *     --start 2025-01-13 --end 2026-04-23 \
 *     --touch-distance 10 --cooldown-min 0 \
 *     --limit-timeout-min 5
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
const LIMIT_TIMEOUT_MIN = Number(arg('limit-timeout-min', 5));
const SNAP_LAG_MIN = Number(arg('snap-lag-min', 16));
const HORIZONS = [5, 15, 30, 60, 120];

console.log(`\n=== GEX Touch Confirm Study — Phase 1 v2 (limit-fill) ===`);
console.log(`Range:            ${START} → ${END}`);
console.log(`Touch distance:   ${TOUCH_DISTANCE} pts`);
console.log(`Cooldown:         ${COOLDOWN_MIN} min`);
console.log(`Target:           ${TARGET_POINTS} pts (anchored at level)`);
console.log(`Stop distances:   [${STOP_DISTANCES.join(', ')}] pts (anchored at level)`);
console.log(`Limit timeout:    ${LIMIT_TIMEOUT_MIN} min`);
console.log(`Max hold:         ${MAX_HOLD_MIN} min after touch (M)`);
console.log(`GEX dir:          data/gex/${GEX_DIR}`);
console.log(`Snap lag:         ${SNAP_LAG_MIN} min\n`);

function loadIntradayGEXCustom(dateStr) {
  const filename = `${PRODUCT.toLowerCase()}_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', GEX_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return content.data || [];
}
async function loadRawNQ(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime() + 24 * 3600000;
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const c = { timestamp: ts, open: +row.open, high: +row.high, low: +row.low,
          close: +row.close, volume: +row.volume || 0, symbol: row.symbol };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${candles.length.toLocaleString()} raw candles`);
  return candles;
}
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
  const filtered = candles.filter(c => c.symbol === primaryByHour.get(Math.floor(c.timestamp / 3600000)));
  return { filtered, primaryByHour };
}
function snapshotAtOrBefore(snapshots, targetTs) {
  if (!snapshots || !snapshots.length) return null;
  let best = null, bestTs = -Infinity;
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).getTime();
    if (ts <= targetTs && ts > bestTs) { best = s; bestTs = ts; }
  }
  return best;
}
function extractLevels(snap) {
  const levels = [];
  if (!snap) return levels;
  if (snap.call_wall != null) levels.push({ type: 'call_wall', price: snap.call_wall, gex: snap.call_wall_gex || 0, isResistance: true });
  if (snap.put_wall != null) levels.push({ type: 'put_wall', price: snap.put_wall, gex: snap.put_wall_gex || 0, isResistance: false });
  if (snap.gamma_flip != null) levels.push({ type: 'gamma_flip', price: snap.gamma_flip, gex: 0, isResistance: null });
  if (Array.isArray(snap.resistance)) snap.resistance.forEach((p, i) => {
    if (p != null) levels.push({ type: `R${i + 1}`, price: p, gex: snap.resistance_gex?.[i] || 0, isResistance: true });
  });
  if (Array.isArray(snap.support)) snap.support.forEach((p, i) => {
    if (p != null) levels.push({ type: `S${i + 1}`, price: p, gex: snap.support_gex?.[i] || 0, isResistance: false });
  });
  return levels;
}
function todBucket(m) {
  if (m < 570) return 'pre_rth';
  if (m < 600) return 'open_30';
  if (m < 720) return 'morning';
  if (m < 840) return 'lunch';
  if (m < 930) return 'afternoon';
  if (m < 960) return 'close_30';
  return 'post_rth';
}
function gexMagBucket(absGex) {
  if (absGex < 1e8) return '<100M';
  if (absGex < 5e8) return '100M-500M';
  if (absGex < 1e9) return '500M-1B';
  if (absGex < 5e9) return '1B-5B';
  return '5B+';
}
function setupToDirection(setup, approach) {
  if (setup === 'bounce') return approach === 'from_above' ? 'long' : 'short';
  return approach === 'from_above' ? 'short' : 'long';
}

/**
 * Resolve a single (setup × stop) outcome under the limit-fill model.
 *
 * @param byTs Map<ts, candle>
 * @param signalTs touch minute M's timestamp
 * @param signalSymbol primary contract symbol at touch
 * @param level structural level price
 * @param direction 'long' | 'short'
 * @param stopDistance pts (relative to level)
 * @param limitTimeoutMin minutes to wait for fill starting M+1
 * @param maxHoldMin minutes after fill within which to resolve (capped from signal too)
 */
function resolveLimitFill(byTs, signalTs, signalSymbol, level, direction, stopDistance,
                          limitTimeoutMin, maxHoldMin) {
  const targetPrice = direction === 'long' ? level + TARGET_POINTS : level - TARGET_POINTS;
  const stopPrice = direction === 'long' ? level - stopDistance : level + stopDistance;

  // 1. Search for fill bar in M+1..M+limitTimeoutMin
  let fillBar = null;
  let fillIndex = null;
  for (let k = 1; k <= limitTimeoutMin; k++) {
    const bar = byTs.get(signalTs + k * 60000);
    if (!bar) continue;
    if (bar.symbol !== signalSymbol) {
      return {
        outcome: 'no_fill',
        no_fill_reason: 'rollover_in_window',
        fill_minute: null, fill_price: null,
        exit_minutes: null, exit_price: null,
        ambiguous_bar_ts: null,
      };
    }
    const filled = direction === 'long' ? bar.low <= level : bar.high >= level;
    if (filled) { fillBar = bar; fillIndex = k; break; }
  }

  if (!fillBar) {
    return {
      outcome: 'no_fill',
      no_fill_reason: 'timeout',
      fill_minute: null, fill_price: null,
      exit_minutes: null, exit_price: null,
      ambiguous_bar_ts: null,
    };
  }

  // 2. Resolve outcome starting from fill bar itself.
  //    The fill bar already touched level (long: low<=level). Check if it
  //    ALSO hit target or stop within the same bar.
  const out = {
    outcome: null,
    no_fill_reason: null,
    fill_minute: fillIndex,                       // minutes after M
    fill_price: level,
    fill_bar_ts: fillBar.timestamp,
    exit_minutes: null,
    exit_price: null,
    ambiguous_bar_ts: null,
    ambiguous_bar_high: null,
    ambiguous_bar_low: null,
    ambiguous_bar_open: null,
    ambiguous_bar_close: null,
    mfe: 0, mae: 0,
  };

  let mfe = 0, mae = 0;
  function updateExcursion(bar) {
    if (direction === 'long') {
      const up = bar.high - level;
      const dn = level - bar.low;
      if (up > mfe) mfe = up;
      if (dn > mae) mae = dn;
    } else {
      const up = bar.high - level;
      const dn = level - bar.low;
      if (dn > mfe) mfe = dn;
      if (up > mae) mae = up;
    }
  }
  function checkBar(bar, mins) {
    const targetHit = direction === 'long' ? bar.high >= targetPrice : bar.low <= targetPrice;
    const stopHit = direction === 'long' ? bar.low <= stopPrice : bar.high >= stopPrice;
    if (targetHit && stopHit) {
      out.outcome = 'ambiguous';
      out.exit_minutes = mins;
      out.ambiguous_bar_ts = bar.timestamp;
      out.ambiguous_bar_high = bar.high;
      out.ambiguous_bar_low = bar.low;
      out.ambiguous_bar_open = bar.open;
      out.ambiguous_bar_close = bar.close;
      return true;
    }
    if (targetHit) {
      out.outcome = 'win';
      out.exit_minutes = mins;
      out.exit_price = targetPrice;
      return true;
    }
    if (stopHit) {
      out.outcome = 'loss';
      out.exit_minutes = mins;
      out.exit_price = stopPrice;
      return true;
    }
    return false;
  }

  // Check fill bar (track excursion from fill)
  updateExcursion(fillBar);
  if (checkBar(fillBar, fillIndex)) {
    out.mfe = mfe; out.mae = mae;
    return out;
  }

  // Walk forward from fillBar's NEXT minute up to (signalTs + maxHoldMin)
  for (let k = fillIndex + 1; k <= maxHoldMin; k++) {
    const bar = byTs.get(signalTs + k * 60000);
    if (!bar) continue;
    if (bar.symbol !== signalSymbol) {
      out.outcome = 'rollover';
      out.exit_minutes = k - 1;
      out.mfe = mfe; out.mae = mae;
      return out;
    }
    updateExcursion(bar);
    if (checkBar(bar, k)) {
      out.mfe = mfe; out.mae = mae;
      return out;
    }
  }

  out.outcome = 'timeout';
  out.exit_minutes = maxHoldMin;
  out.mfe = mfe; out.mae = mae;
  return out;
}

async function run() {
  const tStart = Date.now();
  const allCandles = await loadRawNQ(START, END);
  const { filtered: candles, primaryByHour } = filterPrimaryContract(allCandles);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

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
  let totalCells = 0;
  const outcomeStats = { win: 0, loss: 0, timeout: 0, ambiguous: 0, no_fill: 0, rollover: 0 };

  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEXCustom(dateStr);
    if (!snapshots || !snapshots.length) { snapMisses++; continue; }
    snapHits++;

    const dayCandles = byDate.get(dateStr) || [];
    const lastTouchTs = new Map();
    let prevClose = null;

    for (const { candle: c, et } of dayCandles) {
      if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) { prevClose = c.close; continue; }
      const snap = snapshotAtOrBefore(snapshots, c.timestamp - SNAP_LAG_MIN * 60000);
      if (!snap) { prevClose = c.close; continue; }
      const levels = extractLevels(snap);

      for (const lvl of levels) {
        if (lvl.price == null || isNaN(lvl.price)) continue;
        if (COOLDOWN_MIN > 0) {
          const sig = `${lvl.type}@${lvl.price.toFixed(2)}`;
          const last = lastTouchTs.get(sig);
          if (last && (c.timestamp - last) < COOLDOWN_MIN * 60000) continue;
        }
        const distLow = Math.abs(c.low - lvl.price);
        const distHigh = Math.abs(c.high - lvl.price);
        const minDist = Math.min(distLow, distHigh);
        if (minDist > TOUCH_DISTANCE) continue;
        if (prevClose == null) continue;
        let approach;
        if (prevClose > lvl.price) approach = 'from_above';
        else if (prevClose < lvl.price) approach = 'from_below';
        else continue;

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
          entry_price: lvl.price,        // limit at level
          entry_symbol: c.symbol,
          prev_close: prevClose,
          outcomes: [],
        };

        for (const setup of ['bounce', 'break']) {
          const direction = setupToDirection(setup, approach);
          const stops = [];
          for (const stopDistance of STOP_DISTANCES) {
            const r = resolveLimitFill(byTs, c.timestamp, c.symbol, lvl.price, direction,
              stopDistance, LIMIT_TIMEOUT_MIN, MAX_HOLD_MIN);
            stops.push({
              stop: stopDistance,
              stop_price: direction === 'long' ? lvl.price - stopDistance : lvl.price + stopDistance,
              target_price: direction === 'long' ? lvl.price + TARGET_POINTS : lvl.price - TARGET_POINTS,
              ...r,
            });
            totalCells++;
            outcomeStats[r.outcome]++;
          }
          touch.outcomes.push({ setup, direction, stops });
        }

        touches.push(touch);
        if (COOLDOWN_MIN > 0) {
          lastTouchTs.set(`${lvl.type}@${lvl.price.toFixed(2)}`, c.timestamp);
        }
      }
      prevClose = c.close;
    }
  }

  const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`\n--- Phase 1 v2 walk complete (${elapsedSec}s) ---`);
  console.log(`Snapshot files hit: ${snapHits} | missing: ${snapMisses}`);
  console.log(`Touches: ${touches.length.toLocaleString()}`);
  console.log(`Outcome cells: ${totalCells.toLocaleString()} (touches × 2 setups × ${STOP_DISTANCES.length} stops)`);
  console.log(`Outcomes: ${JSON.stringify(outcomeStats)}\n`);

  // --- Baseline summary ---
  printBaselineSummary(touches);

  const primaryByHourObj = {};
  for (const [h, sym] of primaryByHour.entries()) primaryByHourObj[h] = sym;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outBase = path.join(OUT_DIR, `gex-touch-confirm-v2-base-${ts}`);
  const payload = {
    config: {
      START, END, TOUCH_DISTANCE, COOLDOWN_MIN, PRODUCT, GEX_DIR,
      TARGET_POINTS, STOP_DISTANCES, MAX_HOLD_MIN, LIMIT_TIMEOUT_MIN,
      SNAP_LAG_MIN, HORIZONS,
      ENTRY_MODEL: 'limit_at_level_v2',
    },
    stats: {
      candles_loaded: allCandles.length,
      candles_after_primary_filter: candles.length,
      trading_dates: tradingDates.length,
      snap_hits: snapHits, snap_misses: snapMisses,
      touches: touches.length,
      outcome_cells: totalCells,
      outcomes: outcomeStats,
      runtime_sec: Number(elapsedSec),
    },
    primary_by_hour: primaryByHourObj,
    touches,
  };
  fs.writeFileSync(`${outBase}.touches.json`, JSON.stringify(payload));
  console.log(`Written: ${outBase}.touches.json`);
  console.log(`File size: ${(fs.statSync(`${outBase}.touches.json`).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`\nNext: resolve same-bar ambiguities with 1s data:`);
  console.log(`  node research/gex-touch-confirm/01b-resolve-ambiguity-1s.js --in ${path.relative(ROOT, outBase + '.touches.json')}\n`);
}

function printBaselineSummary(touches) {
  console.log('=== Baseline by setup × stop_distance ===');
  const buckets = new Map();
  for (const t of touches) {
    for (const o of t.outcomes) {
      for (const s of o.stops) {
        const k = `${o.setup}|${s.stop}`;
        if (!buckets.has(k)) buckets.set(k, { n: 0, win: 0, loss: 0, timeout: 0, ambiguous: 0, no_fill: 0, rollover: 0 });
        const b = buckets.get(k);
        b.n++;
        if (b[s.outcome] != null) b[s.outcome]++;
      }
    }
  }
  console.log('setup'.padEnd(8), 'stop'.padStart(5), 'n'.padStart(8), 'fill%'.padStart(8),
    'win%'.padStart(8), 'loss%'.padStart(8), 'amb%'.padStart(7), 'time%'.padStart(7), 'no_fill%'.padStart(9), 'rough_pf'.padStart(10));
  const rows = Array.from(buckets.entries()).sort();
  for (const [k, b] of rows) {
    const [setup, stop] = k.split('|');
    const stopN = Number(stop);
    const filled = b.win + b.loss + b.timeout + b.ambiguous + b.rollover;
    const fillPct = 100 * filled / b.n;
    const wPct = filled > 0 ? 100 * b.win / filled : 0;
    const lPct = filled > 0 ? 100 * b.loss / filled : 0;
    const aPct = filled > 0 ? 100 * b.ambiguous / filled : 0;
    const tPct = filled > 0 ? 100 * b.timeout / filled : 0;
    const nfPct = 100 * b.no_fill / b.n;
    const winsCount = b.win + 0.5 * b.ambiguous;
    const lossesCount = b.loss + 0.5 * b.ambiguous;
    const grossWin = winsCount * TARGET_POINTS;
    const grossLoss = lossesCount * stopN;
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    console.log(setup.padEnd(8), String(stop).padStart(5), String(b.n).padStart(8),
      fillPct.toFixed(1).padStart(8),
      wPct.toFixed(1).padStart(8), lPct.toFixed(1).padStart(8),
      aPct.toFixed(1).padStart(7), tPct.toFixed(1).padStart(7),
      nfPct.toFixed(1).padStart(9), pf.toFixed(2).padStart(10));
  }
  console.log('\n(win%/loss%/etc are conditional on FILL; fill% is share of touches that filled)\n');
}

run().catch(e => { console.error(e); process.exit(1); });
