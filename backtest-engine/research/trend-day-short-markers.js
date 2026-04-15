/**
 * Trend Day Short Markers Research
 *
 * Investigates forward-looking features (IV, GEX, LT) that distinguish
 * winning shorts from losing shorts. Goal: find markers that predict
 * "don't short this" trend days without sacrificing good short trades.
 *
 * Usage: node research/trend-day-short-markers.js [--json /path/to/results.json]
 *
 * If no --json flag, runs the gold standard IV-SKEW-GEX backtest first.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GexLoader } from '../src/data-loaders/gex-loader.js';
import { IVLoader } from '../src/data-loaders/iv-loader.js';
import { ShortDTEIVLoader } from '../src/data-loaders/short-dte-iv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// ─── Config ───────────────────────────────────────────────────────────
const BACKTEST_JSON = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : '/tmp/ivskew-results.json';

const START_DATE = new Date('2025-01-13');
const END_DATE = new Date('2026-01-23');

// ─── LT Loader (simple CSV, no class needed) ─────────────────────────
function loadLTData() {
  const ltFile = path.join(DATA_DIR, 'liquidity', 'nq', 'NQ_liquidity_levels.csv');
  const lines = fs.readFileSync(ltFile, 'utf8').trim().split('\n');
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const ts = parseInt(cols[1]);
    if (ts < START_DATE.getTime() || ts > END_DATE.getTime()) continue;
    records.push({
      timestamp: ts,
      sentiment: cols[2],
      levels: [parseFloat(cols[3]), parseFloat(cols[4]), parseFloat(cols[5]), parseFloat(cols[6]), parseFloat(cols[7])]
    });
  }

  // Sort for binary search
  records.sort((a, b) => a.timestamp - b.timestamp);
  return records;
}

function getLTAtTime(ltData, timestamp) {
  let left = 0, right = ltData.length - 1;
  while (left < right) {
    const mid = Math.ceil((left + right) / 2);
    if (ltData[mid].timestamp <= timestamp) left = mid;
    else right = mid - 1;
  }
  if (ltData[left].timestamp <= timestamp) return ltData[left];
  return null;
}

// ─── Feature Extraction ──────────────────────────────────────────────
function extractFeatures(trade, gexLoader, ivLoader, sdivLoader, ltData) {
  const ts = trade.entryTime;
  const price = trade.actualEntry || trade.entryPrice;
  const features = {};

  // --- GEX features ---
  const gex = gexLoader.getGexLevels(new Date(ts));
  if (gex) {
    features.gex_regime = gex.regime;
    features.gex_total = gex.total_gex;
    features.gex_magnitude = gex.gexMagnitude;
    features.gex_is_positive = gex.isPositiveGEX;

    if (gex.gamma_flip != null && price) {
      features.gamma_flip_distance = price - gex.gamma_flip; // positive = price above flip (positive regime)
      features.gamma_flip_pct = (price - gex.gamma_flip) / price * 100;
    }
    if (gex.call_wall != null && price) {
      features.call_wall_distance = gex.call_wall - price; // positive = call wall above price
    }
    if (gex.put_wall != null && price) {
      features.put_wall_distance = price - gex.put_wall; // positive = put wall below price (bullish)
    }
    if (gex.call_wall != null && gex.put_wall != null) {
      features.wall_spread = gex.call_wall - gex.put_wall;
      if (price) {
        // Where is price within the call/put wall range? 0=at put wall, 1=at call wall
        features.price_in_wall_range = (price - gex.put_wall) / (gex.call_wall - gex.put_wall);
      }
    }
  }

  // --- LT features ---
  const lt = getLTAtTime(ltData, ts);
  if (lt && price) {
    features.lt_sentiment = lt.sentiment;
    features.lt_is_bullish = lt.sentiment === 'BULLISH' ? 1 : 0;

    // How many levels are above vs below price
    const above = lt.levels.filter(l => l > price).length;
    const below = lt.levels.filter(l => l <= price).length;
    features.lt_levels_above = above;
    features.lt_levels_below = below;
    features.lt_level_bias = below - above; // positive = more support below = bullish

    // Level spread (tightness)
    const sorted = [...lt.levels].sort((a, b) => a - b);
    features.lt_level_spread = sorted[4] - sorted[0];

    // Avg distance of levels from price
    features.lt_avg_distance = lt.levels.reduce((s, l) => s + Math.abs(l - price), 0) / 5;
  }

  // --- IV features (standard ATM) ---
  const iv = ivLoader.getIVAtTime(ts);
  if (iv) {
    features.iv_value = iv.iv;
    features.iv_skew = iv.skew; // putIV - callIV
    features.iv_call = iv.callIV;
    features.iv_put = iv.putIV;
  }

  // --- Short-DTE IV features (fields use underscore naming) ---
  const sdiv = sdivLoader.getIVAtTime(ts);
  if (sdiv) {
    features.dte0_avg_iv = sdiv.dte0_avg_iv;
    features.dte0_skew = sdiv.dte0_skew;
    features.dte0_call_iv = sdiv.dte0_call_iv;
    features.dte0_put_iv = sdiv.dte0_put_iv;
    features.dte1_avg_iv = sdiv.dte1_avg_iv;
    features.dte1_skew = sdiv.dte1_skew;
    features.term_slope = sdiv.term_slope; // dte0 - dte1 (positive = inverted)
  }

  // --- IV change rate (look back 2 snapshots = 30min) ---
  const ivWindow = sdivLoader.getIVWindow(ts, 3);
  if (ivWindow.length >= 2) {
    const latest = ivWindow[ivWindow.length - 1];
    const earliest = ivWindow[0];
    if (latest.dte0_avg_iv != null && earliest.dte0_avg_iv != null) {
      features.dte0_iv_change = latest.dte0_avg_iv - earliest.dte0_avg_iv;
    }
    if (latest.dte0_skew != null && earliest.dte0_skew != null) {
      features.dte0_skew_change = latest.dte0_skew - earliest.dte0_skew;
    }
  }

  // --- Composite: regime agreement ---
  // How many signals agree on "bullish"?
  let bullishVotes = 0, totalVotes = 0;
  if (features.gex_regime != null) {
    totalVotes++;
    if (features.gex_regime === 'positive') bullishVotes++;
  }
  if (features.lt_sentiment != null) {
    totalVotes++;
    if (features.lt_sentiment === 'BULLISH') bullishVotes++;
  }
  if (features.iv_skew != null) {
    totalVotes++;
    if (features.iv_skew < 0) bullishVotes++; // negative skew = calls expensive = bullish
  }
  if (totalVotes > 0) {
    features.bullish_agreement = bullishVotes / totalVotes;
    features.bullish_votes = bullishVotes;
    features.total_votes = totalVotes;
  }

  return features;
}

// ─── Statistics Helpers ──────────────────────────────────────────────
function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function stdev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function cohensD(group1, group2) {
  const m1 = mean(group1), m2 = mean(group2);
  const s1 = stdev(group1), s2 = stdev(group2);
  const pooled = Math.sqrt((s1 * s1 + s2 * s2) / 2);
  return pooled === 0 ? 0 : (m1 - m2) / pooled;
}

// ─── Filter Impact Analysis ─────────────────────────────────────────
function analyzeFilter(label, shorts, filterFn) {
  const kept = shorts.filter(t => !filterFn(t));
  const removed = shorts.filter(filterFn);
  if (removed.length === 0) return null;

  const winsRemoved = removed.filter(t => t.netPnL > 0);
  const lossesRemoved = removed.filter(t => t.netPnL <= 0);
  const winPnLRemoved = winsRemoved.reduce((s, t) => s + t.netPnL, 0);
  const lossPnLRemoved = lossesRemoved.reduce((s, t) => s + t.netPnL, 0);
  const netRemoved = removed.reduce((s, t) => s + t.netPnL, 0);

  const keptWins = kept.filter(t => t.netPnL > 0);
  const keptLosses = kept.filter(t => t.netPnL <= 0);
  const keptWinPnL = keptWins.reduce((s, t) => s + t.netPnL, 0);
  const keptLossPnL = Math.abs(keptLosses.reduce((s, t) => s + t.netPnL, 0));

  return {
    label,
    removed: removed.length,
    total: shorts.length,
    winsRemoved: winsRemoved.length,
    lossesRemoved: lossesRemoved.length,
    winPnLSacrificed: winPnLRemoved,
    lossPnLAvoided: lossPnLRemoved,
    netPnLImpact: -netRemoved, // positive = improvement
    newWR: kept.length > 0 ? (keptWins.length / kept.length * 100) : 0,
    newPF: keptLossPnL > 0 ? (keptWinPnL / keptLossPnL) : Infinity
  };
}

function printFilter(f) {
  if (!f) return;
  console.log(`  Filter: ${f.label}`);
  console.log(`    Shorts removed: ${f.removed} of ${f.total} (${(f.removed / f.total * 100).toFixed(0)}%)`);
  console.log(`    Wins sacrificed: ${f.winsRemoved} ($${f.winPnLSacrificed.toFixed(0)})`);
  console.log(`    Losses avoided:  ${f.lossesRemoved} ($${f.lossPnLAvoided.toFixed(0)})`);
  console.log(`    Net P&L impact:  $${f.netPnLImpact.toFixed(0)} (${f.netPnLImpact > 0 ? 'IMPROVES' : 'HURTS'})`);
  console.log(`    New short WR:    ${f.newWR.toFixed(1)}%  |  New PF: ${f.newPF.toFixed(2)}`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   TREND DAY SHORT MARKERS — Feature Correlation Study      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // 1. Load trade results
  console.log(`Loading trades from ${BACKTEST_JSON}...`);
  const results = JSON.parse(fs.readFileSync(BACKTEST_JSON, 'utf8'));
  const allTrades = results.trades;
  const shorts = allTrades.filter(t => t.side === 'sell' || t.side === 'short');
  console.log(`Total trades: ${allTrades.length}, Shorts: ${shorts.length}\n`);

  // 2. Initialize data loaders
  console.log('Loading data sources...');
  const gexLoader = new GexLoader(path.join(DATA_DIR, 'gex'), 'nq');
  await gexLoader.loadDateRange(START_DATE, END_DATE);
  console.log(`  GEX: ${gexLoader.sortedTimestamps.length} snapshots`);

  const ivLoader = new IVLoader(DATA_DIR, { resolution: '1m' });
  await ivLoader.load(START_DATE, END_DATE);
  console.log(`  IV: ${ivLoader.ivData.length} records (${ivLoader.resolution})`);

  const sdivLoader = new ShortDTEIVLoader(DATA_DIR);
  await sdivLoader.load(START_DATE, END_DATE);
  console.log(`  Short-DTE IV: ${sdivLoader.ivData.length} records`);

  const ltData = loadLTData();
  console.log(`  LT: ${ltData.length} records\n`);

  // 3. Tag every short trade with features
  console.log('Extracting features for each short trade...');
  const taggedShorts = shorts.map(t => ({
    ...t,
    _features: extractFeatures(t, gexLoader, ivLoader, sdivLoader, ltData)
  }));

  // Check data coverage
  const featureNames = [
    'gex_regime', 'gamma_flip_distance', 'call_wall_distance', 'put_wall_distance',
    'wall_spread', 'price_in_wall_range', 'gex_magnitude',
    'lt_sentiment', 'lt_levels_above', 'lt_level_bias', 'lt_level_spread',
    'iv_value', 'iv_skew',
    'dte0_avg_iv', 'dte0_skew', 'term_slope', 'dte0_iv_change',
    'bullish_agreement'
  ];

  console.log('\n── DATA COVERAGE ──────────────────────────────────────────');
  for (const f of featureNames) {
    const count = taggedShorts.filter(t => t._features[f] != null).length;
    const pct = (count / taggedShorts.length * 100).toFixed(0);
    console.log(`  ${f.padEnd(25)} ${count}/${taggedShorts.length} (${pct}%)`);
  }

  // 4. Split into winners and losers
  const winners = taggedShorts.filter(t => t.netPnL > 0);
  const losers = taggedShorts.filter(t => t.netPnL <= 0);
  const baseWR = (winners.length / taggedShorts.length * 100).toFixed(1);
  const basePnL = taggedShorts.reduce((s, t) => s + t.netPnL, 0);
  const winPnL = winners.reduce((s, t) => s + t.netPnL, 0);
  const lossPnL = Math.abs(losers.reduce((s, t) => s + t.netPnL, 0));

  console.log(`\n── BASELINE ───────────────────────────────────────────────`);
  console.log(`  Shorts: ${taggedShorts.length} | WR: ${baseWR}% | P&L: $${basePnL.toFixed(0)} | PF: ${(winPnL / lossPnL).toFixed(2)}`);

  // 5. Analyze numeric features
  console.log(`\n══ FEATURE ANALYSIS (Numeric) ═════════════════════════════`);
  console.log(`${'Feature'.padEnd(25)} | ${'Win Mean'.padStart(10)} | ${'Loss Mean'.padStart(10)} | ${'Cohen d'.padStart(8)} | Effect`);
  console.log(`${'─'.repeat(25)}-+-${'─'.repeat(10)}-+-${'─'.repeat(10)}-+-${'─'.repeat(8)}-+--------`);

  const numericFeatures = [
    'gamma_flip_distance', 'gamma_flip_pct', 'call_wall_distance', 'put_wall_distance',
    'wall_spread', 'price_in_wall_range', 'gex_magnitude',
    'lt_levels_above', 'lt_level_bias', 'lt_level_spread', 'lt_avg_distance',
    'iv_value', 'iv_skew',
    'dte0_avg_iv', 'dte0_skew', 'term_slope', 'dte0_iv_change', 'dte0_skew_change',
    'bullish_agreement'
  ];

  const featureResults = [];

  for (const feat of numericFeatures) {
    const winVals = winners.map(t => t._features[feat]).filter(v => v != null);
    const lossVals = losers.map(t => t._features[feat]).filter(v => v != null);
    if (winVals.length < 5 || lossVals.length < 5) continue;

    const d = cohensD(winVals, lossVals);
    const absD = Math.abs(d);
    let effect = 'negligible';
    if (absD >= 0.8) effect = 'LARGE';
    else if (absD >= 0.5) effect = 'MEDIUM';
    else if (absD >= 0.2) effect = 'small';

    featureResults.push({ feat, winMean: mean(winVals), lossMean: mean(lossVals), d, absD, effect, winVals, lossVals });
  }

  // Sort by effect size
  featureResults.sort((a, b) => b.absD - a.absD);

  for (const r of featureResults) {
    const fmt = (v) => {
      if (Math.abs(v) > 1e6) return (v / 1e9).toFixed(2) + 'B';
      if (Math.abs(v) > 100) return v.toFixed(0);
      return v.toFixed(4);
    };
    console.log(`${r.feat.padEnd(25)} | ${fmt(r.winMean).padStart(10)} | ${fmt(r.lossMean).padStart(10)} | ${r.d.toFixed(3).padStart(8)} | ${r.effect}`);
  }

  // 6. Analyze categorical features
  console.log(`\n══ FEATURE ANALYSIS (Categorical) ═════════════════════════`);

  // LT Sentiment
  const winBullish = winners.filter(t => t._features.lt_sentiment === 'BULLISH').length;
  const lossBullish = losers.filter(t => t._features.lt_sentiment === 'BULLISH').length;
  const winWithLT = winners.filter(t => t._features.lt_sentiment != null).length;
  const lossWithLT = losers.filter(t => t._features.lt_sentiment != null).length;

  console.log(`\n  LT Sentiment:`);
  console.log(`    Winners: ${winWithLT > 0 ? (winBullish / winWithLT * 100).toFixed(0) : '?'}% BULLISH (${winBullish}/${winWithLT})`);
  console.log(`    Losers:  ${lossWithLT > 0 ? (lossBullish / lossWithLT * 100).toFixed(0) : '?'}% BULLISH (${lossBullish}/${lossWithLT})`);

  // GEX Regime
  const winPosGEX = winners.filter(t => t._features.gex_regime === 'positive').length;
  const lossPosGEX = losers.filter(t => t._features.gex_regime === 'positive').length;
  const winWithGEX = winners.filter(t => t._features.gex_regime != null).length;
  const lossWithGEX = losers.filter(t => t._features.gex_regime != null).length;

  console.log(`\n  GEX Regime:`);
  console.log(`    Winners: ${winWithGEX > 0 ? (winPosGEX / winWithGEX * 100).toFixed(0) : '?'}% positive (${winPosGEX}/${winWithGEX})`);
  console.log(`    Losers:  ${lossWithGEX > 0 ? (lossPosGEX / lossWithGEX * 100).toFixed(0) : '?'}% positive (${lossPosGEX}/${lossWithGEX})`);

  // 7. Test candidate filters
  console.log(`\n══ CANDIDATE FILTERS ══════════════════════════════════════`);
  console.log(`  (Positive net P&L impact = filter helps)\n`);

  const filters = [
    // LT-based
    ['Suppress short when LT=BULLISH', t => t._features.lt_sentiment === 'BULLISH'],
    ['Suppress short when LT bias >= 3 (3+ levels below)', t => t._features.lt_level_bias >= 3],
    ['Suppress short when LT bias >= 1 (more levels below)', t => t._features.lt_level_bias >= 1],

    // GEX-based
    ['Suppress short when GEX positive', t => t._features.gex_regime === 'positive'],
    ['Suppress short when gamma flip > 200pts below', t => t._features.gamma_flip_distance > 200],
    ['Suppress short when put wall > 300pts below', t => t._features.put_wall_distance > 300],
    ['Suppress short when price in upper 75% of wall range', t => t._features.price_in_wall_range > 0.75],
    ['Suppress short when price in upper 50% of wall range', t => t._features.price_in_wall_range > 0.5],

    // IV-based
    ['Suppress short when IV skew < -0.01 (calls expensive)', t => t._features.iv_skew < -0.01],
    ['Suppress short when IV skew < 0 (calls >= puts)', t => t._features.iv_skew < 0],
    ['Suppress short when 0-DTE skew < -0.005', t => t._features.dte0_skew != null && t._features.dte0_skew < -0.005],
    ['Suppress short when term slope < -0.05 (normal curve)', t => t._features.term_slope != null && t._features.term_slope < -0.05],
    ['Suppress short when 0-DTE IV dropping (change < -0.005)', t => t._features.dte0_iv_change != null && t._features.dte0_iv_change < -0.005],

    // Composite
    ['Suppress short when bullish agreement >= 67%', t => t._features.bullish_agreement >= 0.67],
    ['Suppress short when bullish agreement = 100%', t => t._features.bullish_agreement >= 1.0],
    ['Suppress short when LT=BULLISH + GEX positive', t => t._features.lt_sentiment === 'BULLISH' && t._features.gex_regime === 'positive'],
    ['Suppress short when LT=BULLISH + GEX pos + skew<0', t =>
      t._features.lt_sentiment === 'BULLISH' && t._features.gex_regime === 'positive' && t._features.iv_skew < 0],
  ];

  const filterResults = [];
  for (const [label, fn] of filters) {
    const result = analyzeFilter(label, taggedShorts, fn);
    if (result) filterResults.push(result);
  }

  // Sort by net P&L impact
  filterResults.sort((a, b) => b.netPnLImpact - a.netPnLImpact);

  for (const f of filterResults) {
    printFilter(f);
    console.log('');
  }

  // 8. Summary: top 5 filters
  console.log(`\n══ TOP FILTERS (by net P&L improvement) ══════════════════`);
  const positive = filterResults.filter(f => f.netPnLImpact > 0);
  if (positive.length === 0) {
    console.log('  No filter improves net P&L — shorts are well-calibrated across all markers.');
  } else {
    for (const f of positive.slice(0, 5)) {
      console.log(`  +$${f.netPnLImpact.toFixed(0).padStart(6)}  ${f.label}`);
      console.log(`           (removes ${f.removed} trades, WR: ${f.newWR.toFixed(1)}%, PF: ${f.newPF.toFixed(2)})`);
    }
  }

  const negative = filterResults.filter(f => f.netPnLImpact < 0);
  if (negative.length > 0) {
    console.log(`\n  Filters that HURT (avoid these):`);
    for (const f of negative.slice(-3)) {
      console.log(`  -$${Math.abs(f.netPnLImpact).toFixed(0).padStart(6)}  ${f.label}`);
    }
  }

  // 9. Day-level analysis: find the all-short-loss days and show their features
  console.log(`\n══ ALL-SHORT-LOSS DAYS — FEATURE PROFILES ════════════════`);

  const byDate = new Map();
  for (const t of taggedShorts) {
    const date = new Date(t.entryTime).toISOString().split('T')[0];
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(t);
  }

  for (const [date, dayTrades] of byDate) {
    if (dayTrades.length < 2 || dayTrades.some(t => t.netPnL > 0)) continue;
    // All shorts, all losses
    const totalPnL = dayTrades.reduce((s, t) => s + t.netPnL, 0);
    console.log(`\n  ${date}: ${dayTrades.length} shorts, all losses, P&L $${totalPnL.toFixed(0)}`);
    for (const t of dayTrades) {
      const f = t._features;
      const time = new Date(t.entryTime).toISOString().substring(11, 16);
      console.log(`    ${time} | P&L $${t.netPnL.toFixed(0)} | GEX: ${f.gex_regime || '?'} | LT: ${f.lt_sentiment || '?'} | IV skew: ${f.iv_skew?.toFixed(4) || '?'} | 0DTE: ${f.dte0_avg_iv?.toFixed(3) || '?'} | Bullish: ${f.bullish_agreement?.toFixed(0) != null ? (f.bullish_agreement * 100).toFixed(0) + '%' : '?'}`);
    }
  }
}

main().catch(console.error);
