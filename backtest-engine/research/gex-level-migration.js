/**
 * Track 2: GEX Level Migration Analysis
 *
 * Walks each day's 15-min GEX snapshots. For each transition (t -> t+1) computes:
 *   - ΔCallWall, ΔPutWall, ΔFlip (in points)
 *   - ΔWallRange = (callWall - putWall) at t+1 minus at t
 *   - ΔGammaImbalance
 *   - Compression direction: did flip migrate toward or away from current price?
 *
 * Then maps the forward NQ price return at t+1 over 15 / 45 / 90 min and computes:
 *   - Pearson correlations between ΔLevel features and forward returns
 *   - Conditional means by regime (positive / neutral / negative)
 *   - Conditional means by ΔLevel magnitude bins
 *
 * Run on raw 1m contract data (filterPrimaryContract).
 *
 * Usage:
 *   node research/gex-level-migration.js --start 2025-01-13 --end 2026-01-23
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
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const START = arg('start', '2025-01-13');
const END = arg('end', '2026-01-23');
const PRODUCT = arg('product', 'NQ').toUpperCase();
const GEX_DIR = arg('gex-dir', 'nq-cbbo');
const FORWARD_HORIZONS = [15, 45, 90]; // minutes
// CRITICAL: snapshot bucketing floors timestamps to 15-min boundary and keeps
// LAST close in [T, T+15) — so a snapshot labeled T actually reflects market
// state at ~T+14:59. Entry at-or-after `snapshot_ts + ENTRY_OFFSET_MIN` is
// required for honest backtesting. Default 16 min: gets past the bucket end
// and one extra minute of safety.
const ENTRY_OFFSET_MIN = Number(arg('entry-offset-min', 16));
const RTH_START = 570; // 9:30 ET
const RTH_END = 960;   // 16:00 ET

console.log(`\n=== GEX Level Migration Study: ${PRODUCT} ===`);
console.log(`Date range: ${START} -> ${END}`);
console.log(`GEX dir: data/gex/${GEX_DIR}`);
console.log(`Forward horizons: ${FORWARD_HORIZONS.join(', ')} min`);
console.log(`Entry offset (lookahead correction): +${ENTRY_OFFSET_MIN} min after snapshot ts\n`);

function loadIntradayGEXCustom(dateStr) {
  const filename = `${PRODUCT.toLowerCase()}_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', GEX_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return content.data || [];
}

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
        if (row.symbol && row.symbol.includes('-')) return;
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

// --- Stats helpers ---
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx, ay = ys[i] - my;
    num += ax * ay; dx += ax * ax; dy += ay * ay;
  }
  const denom = Math.sqrt(dx * dy);
  if (denom === 0) return 0;
  return num / denom;
}

function statBlock(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((s, v) => s + v, 0);
  const mean = sum / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  const stddev = Math.sqrt(variance);
  return {
    n: arr.length, mean, stddev,
    median: sorted[Math.floor(sorted.length / 2)],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
  };
}

function bin(value, edges) {
  for (let i = 0; i < edges.length; i++) {
    if (value < edges[i]) return i === 0 ? `<${edges[i]}` : `${edges[i - 1]}..${edges[i]}`;
  }
  return `${edges[edges.length - 1]}+`;
}

// --- Snapshot lookup by exact timestamp (snapshots are at fixed 15-min boundaries) ---
function snapshotAtOrBefore(snapshots, targetTs) {
  if (!snapshots || !snapshots.length) return null;
  let best = null;
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).getTime();
    if (ts <= targetTs && (!best || ts > new Date(best.timestamp).getTime())) {
      best = s;
    }
  }
  return best;
}

// --- Find candle at-or-after a timestamp ---
function findCandleAtOrAfter(byTs, sortedTs, target) {
  // Binary search for first ts >= target
  let lo = 0, hi = sortedTs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedTs[mid] < target) lo = mid + 1; else hi = mid;
  }
  if (lo >= sortedTs.length) return null;
  return byTs.get(sortedTs[lo]);
}

async function run() {
  const all = await loadRawNQ(START, END);
  const candles = filterPrimaryContract(all);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);
  const sortedTs = candles.map(c => c.timestamp);

  // Group dates
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
  }
  const tradingDates = Array.from(byDate.keys()).sort();
  console.log(`Trading dates: ${tradingDates.length}`);

  // Per-transition records
  const transitions = [];
  let snapHits = 0, snapMisses = 0;

  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEXCustom(dateStr);
    if (!snapshots || snapshots.length < 2) { snapMisses++; continue; }
    snapHits++;

    // Restrict to RTH snapshots (use ET timeInMinutes)
    const rth = [];
    for (const s of snapshots) {
      const ts = new Date(s.timestamp).getTime();
      const et = toET(ts);
      if (et.timeInMinutes >= RTH_START && et.timeInMinutes <= RTH_END) {
        rth.push({ ...s, _ts: ts, _et: et });
      }
    }
    if (rth.length < 2) continue;
    rth.sort((a, b) => a._ts - b._ts);

    // Walk transitions
    for (let i = 1; i < rth.length; i++) {
      const prev = rth[i - 1];
      const curr = rth[i];

      const dCallWall = (curr.call_wall != null && prev.call_wall != null) ? curr.call_wall - prev.call_wall : null;
      const dPutWall = (curr.put_wall != null && prev.put_wall != null) ? curr.put_wall - prev.put_wall : null;
      const dFlip = (curr.gamma_flip != null && prev.gamma_flip != null) ? curr.gamma_flip - prev.gamma_flip : null;
      const wallRangePrev = (prev.call_wall != null && prev.put_wall != null) ? prev.call_wall - prev.put_wall : null;
      const wallRangeCurr = (curr.call_wall != null && curr.put_wall != null) ? curr.call_wall - curr.put_wall : null;
      const dWallRange = (wallRangePrev != null && wallRangeCurr != null) ? wallRangeCurr - wallRangePrev : null;
      const dGammaImbalance = (curr.gamma_imbalance != null && prev.gamma_imbalance != null) ? curr.gamma_imbalance - prev.gamma_imbalance : null;

      // Reference price = NQ candle at-or-after (curr_ts + ENTRY_OFFSET_MIN).
      // Snapshot bucketing means snap-T contains data through ~T+14:59, so
      // entering at T+16 ensures all snapshot info is genuinely in the past.
      const entryTargetTs = curr._ts + ENTRY_OFFSET_MIN * 60000;
      const entryCandle = findCandleAtOrAfter(byTs, sortedTs, entryTargetTs);
      if (!entryCandle) continue;
      const entryEt = toET(entryCandle.timestamp);
      if (entryEt.date !== dateStr) continue;

      const entryPrice = entryCandle.open;
      const refSpot = curr.nq_spot ?? entryPrice;

      // Compute distance-from-flip-toward-spot delta:
      //   prevFlipDist = |spot_prev - flip_prev|
      //   currFlipDist = |spot_curr - flip_curr|
      //   convergence = prevFlipDist - currFlipDist (positive = flip migrating toward price)
      let flipConvergence = null;
      if (prev.gamma_flip != null && curr.gamma_flip != null && prev.nq_spot != null && curr.nq_spot != null) {
        const prevDist = Math.abs(prev.nq_spot - prev.gamma_flip);
        const currDist = Math.abs(curr.nq_spot - curr.gamma_flip);
        flipConvergence = prevDist - currDist;
      }

      // Forward returns from entryPrice (next candle open at curr snapshot time)
      const forwards = {};
      for (const horizon of FORWARD_HORIZONS) {
        const fwd = findCandleAtOrAfter(byTs, sortedTs, entryCandle.timestamp + horizon * 60000);
        if (!fwd) { forwards[`fwd_${horizon}m`] = null; continue; }
        const fwdEt = toET(fwd.timestamp);
        if (fwdEt.date !== dateStr) { forwards[`fwd_${horizon}m`] = null; continue; }
        forwards[`fwd_${horizon}m`] = fwd.close - entryPrice; // signed point return
      }

      // Backward return: how much did price move between prev and curr snapshot?
      // Use NQ candle close at-or-before each snapshot timestamp for fair measurement
      let backwardReturn = null;
      if (prev.nq_spot != null && curr.nq_spot != null) {
        backwardReturn = curr.nq_spot - prev.nq_spot;
      }

      transitions.push({
        date: dateStr,
        prev_ts: prev.timestamp,
        curr_ts: curr.timestamp,
        time_et: `${String(Math.floor(curr._et.timeInMinutes / 60)).padStart(2, '0')}:${String(curr._et.timeInMinutes % 60).padStart(2, '0')}`,
        regime_prev: prev.regime || 'unknown',
        regime_curr: curr.regime || 'unknown',
        d_call_wall: dCallWall,
        d_put_wall: dPutWall,
        d_flip: dFlip,
        d_wall_range: dWallRange,
        d_gamma_imbalance: dGammaImbalance,
        flip_convergence: flipConvergence,
        backward_return: backwardReturn,
        spot_prev: prev.nq_spot ?? null,
        spot_curr: refSpot,
        flip_curr: curr.gamma_flip,
        flip_dist_curr: curr.gamma_flip != null ? curr.nq_spot - curr.gamma_flip : null,
        total_gex_curr: curr.total_gex || 0,
        wall_range_curr: wallRangeCurr,
        forwards,
      });
    }
  }

  console.log(`Snapshot files hit: ${snapHits} | missing: ${snapMisses}`);
  console.log(`Total transitions: ${transitions.length.toLocaleString()}\n`);

  // --- Correlations ---
  const features = ['d_call_wall', 'd_put_wall', 'd_flip', 'd_wall_range', 'd_gamma_imbalance', 'flip_convergence', 'flip_dist_curr', 'backward_return'];
  const correlations = {};
  for (const h of FORWARD_HORIZONS) {
    correlations[`fwd_${h}m`] = {};
    const ys = transitions.map(t => t.forwards[`fwd_${h}m`]).filter(v => v != null);
    for (const f of features) {
      const xs = [], yy = [];
      for (const t of transitions) {
        const x = t[f]; const y = t.forwards[`fwd_${h}m`];
        if (x == null || y == null || isNaN(x) || isNaN(y)) continue;
        xs.push(x); yy.push(y);
      }
      correlations[`fwd_${h}m`][f] = { r: pearson(xs, yy), n: xs.length };
    }
  }

  // --- Regime conditional means ---
  const regimeBreakdown = {};
  const regimes = ['positive', 'neutral', 'negative', 'strong_positive', 'strong_negative'];
  for (const r of regimes) {
    const subset = transitions.filter(t => t.regime_curr === r);
    if (!subset.length) continue;
    regimeBreakdown[r] = { count: subset.length };
    for (const h of FORWARD_HORIZONS) {
      const rets = subset.map(t => t.forwards[`fwd_${h}m`]).filter(v => v != null);
      regimeBreakdown[r][`fwd_${h}m`] = statBlock(rets);
    }
    // Per-feature corr within regime
    regimeBreakdown[r].corr = {};
    for (const h of FORWARD_HORIZONS) {
      regimeBreakdown[r].corr[`fwd_${h}m`] = {};
      for (const f of features) {
        const xs = [], yy = [];
        for (const t of subset) {
          const x = t[f]; const y = t.forwards[`fwd_${h}m`];
          if (x == null || y == null || isNaN(x) || isNaN(y)) continue;
          xs.push(x); yy.push(y);
        }
        regimeBreakdown[r].corr[`fwd_${h}m`][f] = { r: pearson(xs, yy), n: xs.length };
      }
    }
  }

  // --- Magnitude-binned conditional means ---
  // For each feature, bin by quantile and report forward-15m mean/median/winrate
  const magBuckets = {};
  for (const f of features) {
    // Bin by quintile
    const vals = transitions.map(t => t[f]).filter(v => v != null && !isNaN(v));
    if (!vals.length) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const q = (p) => sorted[Math.floor(sorted.length * p)];
    const edges = [q(0.2), q(0.4), q(0.6), q(0.8)];
    const bins = { 'q1(low)': [], 'q2': [], 'q3': [], 'q4': [], 'q5(high)': [] };
    for (const t of transitions) {
      const v = t[f];
      if (v == null || isNaN(v)) continue;
      const ret = t.forwards.fwd_15m;
      if (ret == null) continue;
      let key;
      if (v < edges[0]) key = 'q1(low)';
      else if (v < edges[1]) key = 'q2';
      else if (v < edges[2]) key = 'q3';
      else if (v < edges[3]) key = 'q4';
      else key = 'q5(high)';
      bins[key].push(ret);
    }
    magBuckets[f] = {};
    for (const [k, arr] of Object.entries(bins)) {
      if (!arr.length) continue;
      const positives = arr.filter(v => v > 0).length;
      magBuckets[f][k] = {
        ...statBlock(arr),
        win_rate: positives / arr.length,
      };
    }
  }

  // --- Lookahead control: residualize d_gamma_imbalance against backward_return ---
  // Hypothesis: d_gamma_imbalance shifts mechanically when spot moves (because
  // gamma_above/below_spot redistributes). If the forward-return correlation
  // disappears after we control for backward_return, the signal is mechanical
  // (just mean reversion of the prior 15-min move).
  const lookaheadCheck = {};
  for (const h of FORWARD_HORIZONS) {
    const xs_imb = [], xs_back = [], ys = [];
    for (const t of transitions) {
      if (t.d_gamma_imbalance == null || t.backward_return == null || t.forwards[`fwd_${h}m`] == null) continue;
      xs_imb.push(t.d_gamma_imbalance);
      xs_back.push(t.backward_return);
      ys.push(t.forwards[`fwd_${h}m`]);
    }
    const n = xs_imb.length;
    const r_imb_back = pearson(xs_imb, xs_back);
    const r_back_fwd = pearson(xs_back, ys);
    const r_imb_fwd = pearson(xs_imb, ys);

    // OLS: predict imb from back, residual = imb - (a + b*back)
    const meanX = xs_back.reduce((s, v) => s + v, 0) / n;
    const meanY = xs_imb.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs_back[i] - meanX) * (xs_imb[i] - meanY);
      den += (xs_back[i] - meanX) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanY - slope * meanX;
    const residuals = xs_imb.map((v, i) => v - (intercept + slope * xs_back[i]));
    const r_resid_fwd = pearson(residuals, ys);

    lookaheadCheck[`fwd_${h}m`] = {
      n,
      r_imb_back,
      r_back_fwd,
      r_imb_fwd,
      r_resid_fwd, // correlation of residualized imbalance vs forward return
    };
  }

  printSummary(correlations, regimeBreakdown, magBuckets, lookaheadCheck);

  // Persist
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outBase = path.join(OUT_DIR, `gex-level-migration-${ts}`);
  fs.writeFileSync(`${outBase}.json`, JSON.stringify({
    config: { START, END, PRODUCT, GEX_DIR, FORWARD_HORIZONS },
    transition_count: transitions.length,
    correlations,
    regime_breakdown: regimeBreakdown,
    magnitude_buckets: magBuckets,
    lookahead_check: lookaheadCheck,
  }, null, 2));
  fs.writeFileSync(`${outBase}.transitions.json`, JSON.stringify(transitions));
  console.log(`\nWritten: ${outBase}.json`);
  console.log(`Raw transitions: ${outBase}.transitions.json`);
}

function printSummary(correlations, regimeBreakdown, magBuckets, lookaheadCheck) {
  console.log('=== Pearson correlations: ΔLevel features vs forward NQ return ===');
  const features = ['d_call_wall', 'd_put_wall', 'd_flip', 'd_wall_range', 'd_gamma_imbalance', 'flip_convergence', 'flip_dist_curr', 'backward_return'];
  console.log('feature'.padEnd(20), '15m'.padStart(10), '45m'.padStart(10), '90m'.padStart(10), 'n@15m'.padStart(10));
  for (const f of features) {
    const r15 = correlations.fwd_15m[f];
    const r45 = correlations.fwd_45m[f];
    const r90 = correlations.fwd_90m[f];
    console.log(
      f.padEnd(20),
      (r15?.r?.toFixed(4) ?? 'n/a').padStart(10),
      (r45?.r?.toFixed(4) ?? 'n/a').padStart(10),
      (r90?.r?.toFixed(4) ?? 'n/a').padStart(10),
      String(r15?.n ?? 0).padStart(10),
    );
  }

  console.log('\n=== Regime-conditional forward returns ===');
  console.log('regime'.padEnd(20), 'n'.padStart(8), 'mean_15m'.padStart(12), 'mean_45m'.padStart(12), 'mean_90m'.padStart(12));
  for (const [r, v] of Object.entries(regimeBreakdown)) {
    console.log(
      r.padEnd(20),
      String(v.count).padStart(8),
      (v.fwd_15m?.mean?.toFixed(2) ?? 'n/a').padStart(12),
      (v.fwd_45m?.mean?.toFixed(2) ?? 'n/a').padStart(12),
      (v.fwd_90m?.mean?.toFixed(2) ?? 'n/a').padStart(12),
    );
  }

  console.log('\n=== Quintile-binned forward 15m return by feature ===');
  for (const f of features) {
    if (!magBuckets[f]) continue;
    console.log(`\n--- ${f} ---`);
    console.log('bucket'.padEnd(12), 'n'.padStart(8), 'mean_ret'.padStart(12), 'median'.padStart(12), 'win_rate'.padStart(12));
    for (const k of ['q1(low)', 'q2', 'q3', 'q4', 'q5(high)']) {
      const b = magBuckets[f][k];
      if (!b) continue;
      console.log(
        k.padEnd(12),
        String(b.n).padStart(8),
        b.mean.toFixed(2).padStart(12),
        b.median.toFixed(2).padStart(12),
        (100 * b.win_rate).toFixed(1).padStart(12),
      );
    }
  }

  if (lookaheadCheck) {
    console.log('\n=== Lookahead control: residualize d_gamma_imbalance against backward_return ===');
    console.log('horizon'.padEnd(10), 'n'.padStart(8), 'r(imb,back)'.padStart(14), 'r(back,fwd)'.padStart(14), 'r(imb,fwd)'.padStart(14), 'r(resid,fwd)'.padStart(14));
    for (const [k, v] of Object.entries(lookaheadCheck)) {
      console.log(
        k.padEnd(10),
        String(v.n).padStart(8),
        v.r_imb_back.toFixed(4).padStart(14),
        v.r_back_fwd.toFixed(4).padStart(14),
        v.r_imb_fwd.toFixed(4).padStart(14),
        v.r_resid_fwd.toFixed(4).padStart(14),
      );
    }
    console.log('\nIf r(resid,fwd) is much smaller than r(imb,fwd), the gamma_imbalance');
    console.log('signal is largely mechanical (mean reversion of the prior 15-min move).');
    console.log('If r(resid,fwd) stays sizeable, options-chain shifts add real predictive info.');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
