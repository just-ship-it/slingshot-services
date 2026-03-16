/**
 * Overnight LT Level Dynamics Research
 *
 * Tests whether LT Fibonacci lookback level movement between 6-8 PM EST
 * predicts NQ price direction between 8 PM and 2 AM EST.
 *
 * LT Levels (from TradingView Liquidity Data Exporter):
 *   level_1 = Fib 34 lookback (short-term)
 *   level_2 = Fib 55 lookback (short-term)
 *   level_3 = Fib 144 lookback (medium-term)
 *   level_4 = Fib 377 lookback (long-term)
 *   level_5 = Fib 610 lookback (long-term)
 *
 * Features to test:
 *   - Direction of each level (rising vs falling 6-8pm)
 *   - Speed of level movement (pts/hr)
 *   - Convergence/divergence of levels toward/away from price
 *   - Level crossings through price
 *   - Net level direction (how many levels rising vs falling)
 *   - Level spread (widening vs narrowing)
 *   - Price position relative to levels
 *
 * Usage: cd backtest-engine && node research/overnight-lt-dynamics.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));

const START = '2023-03-28';
const END = '2025-12-25';

// ============================================================================
// TIMEZONE
// ============================================================================
function isDST(ms) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m >= 3 && m <= 9) return true;
  if (m === 0 || m === 1 || m === 11) return false;
  if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ms >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); }
  if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ms < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); }
  return false;
}
function getESTHour(ts) { const d = new Date(ts + (isDST(ts) ? -4 : -5) * 3600000); return d.getUTCHours() + d.getUTCMinutes() / 60; }
function getESTDateStr(ts) { const d = new Date(ts + (isDST(ts) ? -4 : -5) * 3600000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
function getDayOfWeek(ds) { return new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' }); }

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  console.log('Loading data...\n');

  // OHLCV continuous
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG);
  const { candles: rawCandles } = await csvLoader.loadOHLCVData('NQ', new Date(START), new Date(END));
  const candles = csvLoader.filterPrimaryContract ? csvLoader.filterPrimaryContract(rawCandles) : rawCandles;
  console.log(`  OHLCV: ${candles.length} candles`);

  // LT levels (full 15-min resolution)
  const ltRecords = await csvLoader.loadLiquidityData('NQ', new Date(START), new Date(END));
  console.log(`  LT: ${ltRecords.length} records`);

  return { candles, ltRecords };
}

// ============================================================================
// SESSION BUILDER
// ============================================================================
function buildSessions(candles, ltRecords) {
  console.log('\nBuilding overnight sessions...');

  // Index candles by EST date+hour
  const byDate = {};
  for (const c of candles) {
    const d = getESTDateStr(c.timestamp);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ ...c, estHour: getESTHour(c.timestamp) });
  }

  // Index LT by timestamp for fast lookup
  const ltByTs = new Map();
  for (const lt of ltRecords) ltByTs.set(lt.timestamp, lt);
  const ltTimestamps = [...ltByTs.keys()].sort((a, b) => a - b);

  // Find LT snapshots in a time range
  function getLTInRange(startTs, endTs) {
    const results = [];
    // Binary search for start
    let lo = 0, hi = ltTimestamps.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ltTimestamps[mid] < startTs) lo = mid + 1; else hi = mid - 1; }
    for (let i = lo; i < ltTimestamps.length && ltTimestamps[i] <= endTs; i++) {
      results.push(ltByTs.get(ltTimestamps[i]));
    }
    return results;
  }

  const dates = Object.keys(byDate).sort();
  const sessions = [];

  for (let i = 0; i < dates.length - 1; i++) {
    const today = dates[i], tomorrow = dates[i + 1];
    const tc = byDate[today] || [], nc = byDate[tomorrow] || [];
    const dayOfWeek = getDayOfWeek(today);
    if (dayOfWeek === 'Friday' || dayOfWeek === 'Saturday') continue;

    // Observation window: 6-8 PM EST today
    const obs = tc.filter(c => c.estHour >= 18 && c.estHour < 20);
    if (obs.length < 10) continue;

    // Trading window: 8 PM today - 2 AM tomorrow
    const trading = [...tc.filter(c => c.estHour >= 20), ...nc.filter(c => c.estHour < 2)];
    if (trading.length < 30) continue;

    // Price at key timestamps
    const price6pm = obs[0].open;
    const price8pm = trading[0].open;
    const price2am = trading[trading.length - 1].close;

    // Get LT snapshots in observation window (6-8pm)
    const obsStart = obs[0].timestamp;
    const obsEnd = obs[obs.length - 1].timestamp;
    const ltObs = getLTInRange(obsStart - 60000, obsEnd + 60000);
    if (ltObs.length < 3) continue;

    // Get LT at 8pm (start of trading window)
    const lt8pmCandidates = getLTInRange(trading[0].timestamp - 15 * 60000, trading[0].timestamp + 15 * 60000);
    const lt8pm = lt8pmCandidates.length > 0 ? lt8pmCandidates[lt8pmCandidates.length - 1] : null;

    sessions.push({
      date: today, dayOfWeek,
      price6pm, price8pm, price2am,
      tradingReturn: price2am - price8pm,
      tradingReturnPct: (price2am - price8pm) / price8pm * 100,
      obsCandles: obs,
      tradingCandles: trading,
      ltObs,   // LT snapshots during 6-8pm
      lt8pm,   // LT snapshot at 8pm
    });
  }

  console.log(`  ${sessions.length} sessions built (with LT observation + trading windows)`);
  return sessions;
}

// ============================================================================
// FEATURE EXTRACTION
// ============================================================================
function extractFeatures(session) {
  const { ltObs, lt8pm, price6pm, price8pm } = session;
  if (ltObs.length < 3 || !lt8pm) return null;

  const first = ltObs[0];
  const last = ltObs[ltObs.length - 1];
  const levels = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
  const fibNames = ['fib34', 'fib55', 'fib144', 'fib377', 'fib610'];

  const features = {};

  // Per-level features
  let levelsRising = 0, levelsFalling = 0;
  let levelsMovingTowardPrice = 0, levelsMovingAwayFromPrice = 0;
  let totalLevelMove = 0;

  for (let l = 0; l < 5; l++) {
    const key = levels[l];
    const name = fibNames[l];
    const firstVal = first[key];
    const lastVal = last[key];
    const val8pm = lt8pm[key];

    if (firstVal == null || lastVal == null || val8pm == null) continue;

    // Direction and magnitude
    const move = lastVal - firstVal;
    const movePerHour = move / 2; // 2 hour window
    features[`${name}_move`] = move;
    features[`${name}_movePerHour`] = movePerHour;
    features[`${name}_rising`] = move > 0 ? 1 : 0;

    if (move > 1) levelsRising++;
    else if (move < -1) levelsFalling++;

    totalLevelMove += move;

    // Distance from price at 8pm
    features[`${name}_dist_from_price`] = val8pm - price8pm;
    features[`${name}_above_price`] = val8pm > price8pm ? 1 : 0;

    // Moving toward or away from price
    const distStart = Math.abs(firstVal - price6pm);
    const distEnd = Math.abs(lastVal - price8pm);
    if (distEnd < distStart) levelsMovingTowardPrice++;
    else levelsMovingAwayFromPrice++;
    features[`${name}_converging`] = distEnd < distStart ? 1 : 0;
  }

  // Aggregate features
  features.levelsRising = levelsRising;
  features.levelsFalling = levelsFalling;
  features.netLevelDirection = levelsRising - levelsFalling;
  features.avgLevelMove = totalLevelMove / 5;
  features.levelsConverging = levelsMovingTowardPrice;
  features.levelsDiverging = levelsMovingAwayFromPrice;
  features.netConvergence = levelsMovingTowardPrice - levelsMovingAwayFromPrice;

  // Level spread (range of all levels)
  const vals8pm = levels.map(k => lt8pm[k]).filter(v => v != null).sort((a, b) => a - b);
  if (vals8pm.length >= 2) {
    features.levelSpread = vals8pm[vals8pm.length - 1] - vals8pm[0];
    // Spread change during observation
    const valsFirst = levels.map(k => first[k]).filter(v => v != null).sort((a, b) => a - b);
    const spreadFirst = valsFirst[valsFirst.length - 1] - valsFirst[0];
    features.spreadChange = features.levelSpread - spreadFirst;
    features.spreadWidening = features.spreadChange > 0 ? 1 : 0;
  }

  // Price position: how many levels are above vs below price
  const levelsAbove = vals8pm.filter(v => v > price8pm).length;
  features.levelsAbovePrice = levelsAbove;
  features.levelsBelowPrice = 5 - levelsAbove;
  features.pricePositionInLevels = levelsAbove / 5; // 0 = price above all, 1 = price below all

  // Short-term vs long-term level direction divergence
  const shortTermMove = ((first.level_1 != null && last.level_1 != null) ? last.level_1 - first.level_1 : 0)
    + ((first.level_2 != null && last.level_2 != null) ? last.level_2 - first.level_2 : 0);
  const longTermMove = ((first.level_4 != null && last.level_4 != null) ? last.level_4 - first.level_4 : 0)
    + ((first.level_5 != null && last.level_5 != null) ? last.level_5 - first.level_5 : 0);
  features.shortTermMove = shortTermMove / 2;
  features.longTermMove = longTermMove / 2;
  features.shortLongDivergence = features.shortTermMove - features.longTermMove;

  // Level crossings through price during observation
  let crossings = 0;
  for (let l = 0; l < 5; l++) {
    const key = levels[l];
    for (let j = 1; j < ltObs.length; j++) {
      const prev = ltObs[j - 1][key];
      const curr = ltObs[j][key];
      if (prev == null || curr == null) continue;
      // Approximate price at this LT timestamp using candle data
      const approxPrice = (price6pm + price8pm) / 2; // rough midpoint
      if ((prev < approxPrice && curr >= approxPrice) || (prev > approxPrice && curr <= approxPrice)) {
        crossings++;
      }
    }
  }
  features.levelCrossings = crossings;

  return features;
}

// ============================================================================
// ANALYSIS
// ============================================================================
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 10) return { r: NaN, t: NaN, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let ssxy = 0, ssxx = 0, ssyy = 0;
  for (let i = 0; i < n; i++) {
    ssxy += (xs[i] - mx) * (ys[i] - my);
    ssxx += (xs[i] - mx) ** 2;
    ssyy += (ys[i] - my) ** 2;
  }
  const r = ssxy / Math.sqrt(ssxx * ssyy);
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  return { r, t, n };
}

function bucketAnalysis(data, featureFn, returnFn, name, buckets = 5) {
  const valid = data.map(d => ({ f: featureFn(d), r: returnFn(d) })).filter(d => d.f != null && !isNaN(d.f) && !isNaN(d.r));
  if (valid.length < 30) return;
  valid.sort((a, b) => a.f - b.f);
  const corr = correlation(valid.map(d => d.f), valid.map(d => d.r));
  const sig = Math.abs(corr.t) > 2.58 ? '***' : Math.abs(corr.t) > 1.96 ? '**' : Math.abs(corr.t) > 1.65 ? '*' : '';

  console.log(`\n  ═══ ${name} (n=${valid.length}, r=${corr.r.toFixed(4)}, t=${corr.t.toFixed(2)}) ${sig} ═══`);
  const bSize = Math.ceil(valid.length / buckets);
  console.log('  ┌──────────┬───────┬──────────────────────────┬───────────┬──────────┐');
  console.log('  │ Quintile │   N   │ Feature Range            │ Avg Ret   │ WR Long  │');
  console.log('  ├──────────┼───────┼──────────────────────────┼───────────┼──────────┤');
  for (let b = 0; b < buckets; b++) {
    const s = valid.slice(b * bSize, Math.min((b + 1) * bSize, valid.length));
    const avgRet = s.reduce((a, d) => a + d.r, 0) / s.length;
    const wr = s.filter(d => d.r > 0).length / s.length * 100;
    console.log(`  │   Q${b + 1}     │ ${String(s.length).padStart(4)}  │ ${s[0].f.toFixed(2).padStart(10)} to ${s[s.length - 1].f.toFixed(2).padStart(10)} │ ${avgRet.toFixed(2).padStart(9)} │ ${wr.toFixed(1).padStart(6)}%  │`);
  }
  console.log('  └──────────┴───────┴──────────────────────────┴───────────┴──────────┘');
}

function simpleStrategy(sessions, signalFn, name) {
  let pnl = 0, trades = 0, wins = 0;
  const pnls = [];
  for (const s of sessions) {
    const sig = signalFn(s);
    if (sig === 0) continue;
    trades++;
    const ret = sig * s.tradingReturn;
    pnl += ret;
    pnls.push(ret);
    if (ret > 0) wins++;
  }
  if (trades < 20) return;
  const avg = pnl / trades;
  const std = Math.sqrt(pnls.reduce((a, v) => a + Math.pow(v - avg, 2), 0) / trades);
  const sharpe = std > 0 ? avg / std : 0;
  console.log(`  ${name.padEnd(55)} ${String(trades).padStart(4)} ${(wins / trades * 100).toFixed(1).padStart(6)}% ${avg.toFixed(1).padStart(7)} ${pnl.toFixed(0).padStart(8)} ${sharpe.toFixed(3).padStart(7)}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT LT DYNAMICS RESEARCH — NQ');
  console.log('  Observation: 6-8 PM EST | Trading: 8 PM - 2 AM EST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { candles, ltRecords } = await loadData();
  const sessions = buildSessions(candles, ltRecords);

  // Extract features
  const enriched = [];
  for (const s of sessions) {
    const f = extractFeatures(s);
    if (f) enriched.push({ ...s, features: f });
  }
  console.log(`  ${enriched.length} sessions with features extracted`);

  // Baseline
  const returns = enriched.map(s => s.tradingReturn);
  const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
  const wrLong = returns.filter(r => r > 0).length / returns.length * 100;
  console.log(`\n  Baseline (8pm-2am): avg=${avgRet.toFixed(2)} pts, WR long=${wrLong.toFixed(1)}%, n=${returns.length}`);

  // ════════════════════════════════════════════════════════════
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  FEATURE CORRELATIONS WITH 8PM-2AM RETURN                     ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const featureList = [
    ['netLevelDirection', 'Net Level Direction (rising - falling)'],
    ['avgLevelMove', 'Avg Level Move (pts, 6-8pm)'],
    ['levelsRising', 'Count of Rising Levels'],
    ['levelsFalling', 'Count of Falling Levels'],
    ['netConvergence', 'Net Convergence (toward - away from price)'],
    ['levelsConverging', 'Count Converging Toward Price'],
    ['levelSpread', 'Level Spread (range of all 5 levels)'],
    ['spreadChange', 'Spread Change (6pm to 8pm)'],
    ['pricePositionInLevels', 'Price Position in Levels (0=above all, 1=below all)'],
    ['levelsAbovePrice', 'Levels Above Price'],
    ['shortTermMove', 'Short-Term Move (fib34+55)'],
    ['longTermMove', 'Long-Term Move (fib377+610)'],
    ['shortLongDivergence', 'Short-Long Divergence'],
    ['levelCrossings', 'Level Crossings Through Price'],
    ['fib34_move', 'Fib34 Move (shortest lookback)'],
    ['fib55_move', 'Fib55 Move'],
    ['fib144_move', 'Fib144 Move (medium)'],
    ['fib377_move', 'Fib377 Move'],
    ['fib610_move', 'Fib610 Move (longest lookback)'],
    ['fib34_converging', 'Fib34 Converging Toward Price'],
    ['fib610_converging', 'Fib610 Converging Toward Price'],
    ['fib34_dist_from_price', 'Fib34 Distance From Price @8pm'],
    ['fib610_dist_from_price', 'Fib610 Distance From Price @8pm'],
  ];

  for (const [key, name] of featureList) {
    bucketAnalysis(enriched, d => d.features[key], d => d.tradingReturn, name);
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  FEATURE IMPORTANCE RANKING                                   ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const rankings = [];
  for (const [key, name] of featureList) {
    const valid = enriched.filter(d => d.features[key] != null && !isNaN(d.features[key]));
    if (valid.length < 30) continue;
    const corr = correlation(valid.map(d => d.features[key]), valid.map(d => d.tradingReturn));
    rankings.push({ name, key, ...corr });
  }
  rankings.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  console.log('  Rank  Feature                                          r        t-stat    n');
  console.log('  ────  ──────────────────────────────────────────────── ──────── ──────── ────');
  for (let i = 0; i < rankings.length; i++) {
    const f = rankings[i];
    const sig = Math.abs(f.t) > 2.58 ? '***' : Math.abs(f.t) > 1.96 ? '**' : Math.abs(f.t) > 1.65 ? '*' : '';
    console.log(`  ${String(i + 1).padStart(4)}  ${f.name.padEnd(48)} ${f.r.toFixed(4).padStart(7)}  ${f.t.toFixed(2).padStart(7)}  ${String(f.n).padStart(4)} ${sig}`);
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  SIMPLE STRATEGY TESTS (8pm entry, 2am exit)                  ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log(`  ${'Strategy'.padEnd(55)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)}`);
  console.log(`  ${'─'.repeat(55)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)}`);

  // Always long
  simpleStrategy(enriched, () => 1, 'Always Long');

  // Net level direction
  simpleStrategy(enriched, s => s.features.netLevelDirection > 0 ? 1 : s.features.netLevelDirection < 0 ? -1 : 0, 'Net Level Direction (>0 long, <0 short)');
  simpleStrategy(enriched, s => s.features.netLevelDirection >= 2 ? 1 : s.features.netLevelDirection <= -2 ? -1 : 0, 'Strong Net Direction (>=2 long, <=-2 short)');
  simpleStrategy(enriched, s => s.features.netLevelDirection >= 3 ? 1 : s.features.netLevelDirection <= -3 ? -1 : 0, 'Very Strong Net Direction (>=3/-3)');

  // Avg level move
  simpleStrategy(enriched, s => s.features.avgLevelMove > 5 ? 1 : s.features.avgLevelMove < -5 ? -1 : 0, 'Avg Level Move > 5pts');
  simpleStrategy(enriched, s => s.features.avgLevelMove > 10 ? 1 : s.features.avgLevelMove < -10 ? -1 : 0, 'Avg Level Move > 10pts');
  simpleStrategy(enriched, s => s.features.avgLevelMove > 20 ? 1 : s.features.avgLevelMove < -20 ? -1 : 0, 'Avg Level Move > 20pts');

  // Convergence
  simpleStrategy(enriched, s => s.features.netConvergence >= 3 ? 1 : s.features.netConvergence <= -3 ? -1 : 0, 'Strong Convergence (>=3 toward price → long)');
  simpleStrategy(enriched, s => s.features.netConvergence >= 3 ? -1 : s.features.netConvergence <= -3 ? 1 : 0, 'Strong Convergence (>=3 toward price → short/fade)');

  // Short-term fib direction
  simpleStrategy(enriched, s => s.features.fib34_move > 10 ? 1 : s.features.fib34_move < -10 ? -1 : 0, 'Fib34 Move > 10pts (follow short-term)');
  simpleStrategy(enriched, s => s.features.fib55_move > 10 ? 1 : s.features.fib55_move < -10 ? -1 : 0, 'Fib55 Move > 10pts (follow short-term)');

  // Long-term fib direction
  simpleStrategy(enriched, s => s.features.fib377_move > 5 ? 1 : s.features.fib377_move < -5 ? -1 : 0, 'Fib377 Move > 5pts (follow long-term)');
  simpleStrategy(enriched, s => s.features.fib610_move > 5 ? 1 : s.features.fib610_move < -5 ? -1 : 0, 'Fib610 Move > 5pts (follow long-term)');

  // Short-long divergence
  simpleStrategy(enriched, s => s.features.shortLongDivergence > 20 ? 1 : s.features.shortLongDivergence < -20 ? -1 : 0, 'Short>Long divergence > 20pts → long');
  simpleStrategy(enriched, s => s.features.shortLongDivergence > 20 ? -1 : s.features.shortLongDivergence < -20 ? 1 : 0, 'Short>Long divergence > 20pts → short (fade)');

  // Price position
  simpleStrategy(enriched, s => s.features.levelsAbovePrice >= 4 ? 1 : s.features.levelsAbovePrice <= 1 ? -1 : 0, 'Price below most levels → long, above → short');
  simpleStrategy(enriched, s => s.features.levelsAbovePrice >= 4 ? -1 : s.features.levelsAbovePrice <= 1 ? 1 : 0, 'Price below most levels → short, above → long (fade)');

  // Level crossings
  simpleStrategy(enriched, s => s.features.levelCrossings >= 2 ? 1 : 0, 'Level crossings >=2 → long');
  simpleStrategy(enriched, s => s.features.levelCrossings >= 2 ? -1 : 0, 'Level crossings >=2 → short');

  // Spread
  simpleStrategy(enriched, s => s.features.spreadWidening ? 1 : -1, 'Spread widening → long, narrowing → short');
  simpleStrategy(enriched, s => s.features.spreadWidening ? -1 : 1, 'Spread widening → short, narrowing → long');

  // Combos
  simpleStrategy(enriched, s => {
    const f = s.features;
    if (f.netLevelDirection >= 2 && f.avgLevelMove > 5) return 1;
    if (f.netLevelDirection <= -2 && f.avgLevelMove < -5) return -1;
    return 0;
  }, 'Combo: netDir>=2 + avgMove>5');

  simpleStrategy(enriched, s => {
    const f = s.features;
    if (f.netLevelDirection >= 2 && f.levelsConverging >= 3) return 1;
    if (f.netLevelDirection <= -2 && f.levelsConverging >= 3) return -1;
    return 0;
  }, 'Combo: netDir>=2 + convergence>=3');

  simpleStrategy(enriched, s => {
    const f = s.features;
    if (f.fib34_move > 10 && f.fib610_move > 3) return 1;
    if (f.fib34_move < -10 && f.fib610_move < -3) return -1;
    return 0;
  }, 'Combo: fib34>10 + fib610>3 (all fibs agree)');

  simpleStrategy(enriched, s => {
    const f = s.features;
    if (f.avgLevelMove > 10 && f.netConvergence >= 2) return 1;
    if (f.avgLevelMove < -10 && f.netConvergence >= 2) return -1;
    return 0;
  }, 'Combo: avgMove>10 + convergence>=2');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  LT DYNAMICS RESEARCH COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
