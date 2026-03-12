#!/usr/bin/env node
/**
 * 0-2 DTE IV Correlation Analysis
 *
 * Analyzes whether short-dated IV dynamics (skew changes, IV crush, term structure)
 * are predictive of NQ/ES price direction and GEX-level pinning.
 *
 * Analyses:
 *   1. IV Change → Price Direction (intraday, requires TCBBO 15m data)
 *   2. IV Crush → GEX Pinning (daily, requires intraday or daily IV + GEX)
 *   3. Skew Dynamics → Direction (intraday)
 *   4. Term Structure → Realized Volatility (intraday)
 *
 * Usage:
 *   node scripts/analyze-short-dte-iv-correlations.js [--product nq|es] [--analyses 1,2,3,4]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadContinuousOHLCV,
  loadIntradayGEX,
  extractTradingDates,
  getRTHCandlesFromArray,
  toET,
  fromET,
  isDST
} from '../research/utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, '..', 'research', 'output');

// ============================================================================
// Statistical Functions (from analyze-iv-skew-gex-correlations.js)
// ============================================================================

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function lnGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betaCF(x, a, b) {
  const maxIter = 100, eps = 1e-10;
  let am = 1, bm = 1, az = 1;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let bz = 1 - qab * x / qap;
  for (let m = 1; m <= maxIter; m++) {
    const em = m, tem = em + em;
    let d = em * (b - m) * x / ((qam + tem) * (a + tem));
    const ap = az + d * am, bp = bz + d * bm;
    d = -(a + em) * (qab + em) * x / ((a + tem) * (qap + tem));
    const app = ap + d * az, bpp = bp + d * bz;
    am = ap / bpp; bm = bp / bpp; az = app / bpp; bz = 1;
    if (Math.abs(az - (app / bpp - az + az)) < eps * Math.abs(az)) return az;
  }
  return az;
}

function incompleteBeta(x, a, b) {
  if (x === 0) return 0;
  if (x === 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betaCF(x, a, b) / a;
  return 1 - bt * betaCF(1 - x, b, a) / b;
}

function tDistributionPValue(t, df) {
  if (df > 100) return 2 * (1 - normalCDF(Math.abs(t)));
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

function incompleteGamma(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 100; n++) {
      term *= x / (a + n); sum += term;
      if (Math.abs(term) < 1e-10 * Math.abs(sum)) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  } else {
    let d = 1 / (x - a + 1), h = d;
    for (let i = 1; i < 100; i++) {
      const an = -i * (i - a), bn = x - a + 1 + 2 * i;
      d = an * d + bn; if (Math.abs(d) < 1e-30) d = 1e-30;
      let c = bn + an / (bn + an / 1e30 || 1e-30);
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-10) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  }
}

function welchTTest(arr1, arr2) {
  if (arr1.length < 2 || arr2.length < 2) return { t: NaN, p: NaN, significant: false };
  const mean1 = arr1.reduce((s, v) => s + v, 0) / arr1.length;
  const mean2 = arr2.reduce((s, v) => s + v, 0) / arr2.length;
  const var1 = arr1.reduce((s, v) => s + (v - mean1) ** 2, 0) / (arr1.length - 1);
  const var2 = arr2.reduce((s, v) => s + (v - mean2) ** 2, 0) / (arr2.length - 1);
  const se1 = var1 / arr1.length, se2 = var2 / arr2.length;
  const se = Math.sqrt(se1 + se2);
  if (se === 0) return { t: 0, p: 1, significant: false };
  const t = (mean1 - mean2) / se;
  const df = (se1 + se2) ** 2 / ((se1 ** 2) / (arr1.length - 1) + (se2 ** 2) / (arr2.length - 1));
  const p = tDistributionPValue(Math.abs(t), df);
  return { t, p, significant: p < 0.05, highlySignificant: p < 0.01 };
}

function cohensD(arr1, arr2) {
  if (arr1.length < 2 || arr2.length < 2) return NaN;
  const mean1 = arr1.reduce((s, v) => s + v, 0) / arr1.length;
  const mean2 = arr2.reduce((s, v) => s + v, 0) / arr2.length;
  const var1 = arr1.reduce((s, v) => s + (v - mean1) ** 2, 0) / (arr1.length - 1);
  const var2 = arr2.reduce((s, v) => s + (v - mean2) ** 2, 0) / (arr2.length - 1);
  const pooledSD = Math.sqrt(((arr1.length - 1) * var1 + (arr2.length - 1) * var2) / (arr1.length + arr2.length - 2));
  if (pooledSD === 0) return 0;
  return (mean1 - mean2) / pooledSD;
}

function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { r: NaN, p: NaN };
  const meanX = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanY = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX, dy = y[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }
  if (sumX2 === 0 || sumY2 === 0) return { r: 0, p: 1 };
  const r = sumXY / Math.sqrt(sumX2 * sumY2);
  // t-test for significance
  const t = r * Math.sqrt((n - 2) / (1 - r * r + 1e-15));
  const p = tDistributionPValue(Math.abs(t), n - 2);
  return { r, p, significant: p < 0.05, n };
}

function spearmanCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { rho: NaN, p: NaN };
  const rankX = getRanks(x.slice(0, n));
  const rankY = getRanks(y.slice(0, n));
  const result = pearsonCorrelation(rankX, rankY);
  return { rho: result.r, p: result.p, significant: result.significant, n };
}

function getRanks(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

function calcStats(arr) {
  if (!arr || arr.length === 0) return { mean: NaN, std: NaN, min: NaN, max: NaN, median: NaN, count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length || 1);
  const std = Math.sqrt(variance);
  const median = arr.length % 2 === 0
    ? (sorted[arr.length / 2 - 1] + sorted[arr.length / 2]) / 2
    : sorted[Math.floor(arr.length / 2)];
  return { mean, std, min: sorted[0], max: sorted[sorted.length - 1], median, count: arr.length };
}

function getSignificance(p) {
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return '';
}

function quintileBuckets(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const boundaries = [
    sorted[Math.floor(n * 0.2)],
    sorted[Math.floor(n * 0.4)],
    sorted[Math.floor(n * 0.6)],
    sorted[Math.floor(n * 0.8)]
  ];
  return (v) => {
    if (v <= boundaries[0]) return 0;
    if (v <= boundaries[1]) return 1;
    if (v <= boundaries[2]) return 2;
    if (v <= boundaries[3]) return 3;
    return 4;
  };
}

// ============================================================================
// Data Loading
// ============================================================================

function loadShortDTEIV(product, resolution) {
  const filename = resolution === '15m'
    ? `${product}_short_dte_iv_15m.csv`
    : `${product}_short_dte_iv_daily.csv`;
  const filePath = path.join(DATA_DIR, 'iv', product, filename);

  if (!fs.existsSync(filePath)) {
    console.error(`IV file not found: ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const record = {};
    header.forEach((h, idx) => record[h] = cols[idx]);

    const parseNum = (v) => (v === '' || v === undefined) ? null : parseFloat(v);

    records.push({
      timestamp: record.timestamp,
      timestampMs: new Date(record.timestamp).getTime(),
      spotPrice: parseNum(record.spot_price),
      dte0_atm_strike: parseNum(record.dte0_atm_strike),
      dte0_call_iv: parseNum(record.dte0_call_iv),
      dte0_put_iv: parseNum(record.dte0_put_iv),
      dte0_avg_iv: parseNum(record.dte0_avg_iv),
      dte0_skew: parseNum(record.dte0_skew),
      dte1_atm_strike: parseNum(record.dte1_atm_strike),
      dte1_call_iv: parseNum(record.dte1_call_iv),
      dte1_put_iv: parseNum(record.dte1_put_iv),
      dte1_avg_iv: parseNum(record.dte1_avg_iv),
      dte1_skew: parseNum(record.dte1_skew),
      dte2_atm_strike: parseNum(record.dte2_atm_strike),
      dte2_call_iv: parseNum(record.dte2_call_iv),
      dte2_put_iv: parseNum(record.dte2_put_iv),
      dte2_avg_iv: parseNum(record.dte2_avg_iv),
      dte2_skew: parseNum(record.dte2_skew),
      term_slope: parseNum(record.term_slope),
      quality: parseInt(record.quality) || 0
    });
  }

  console.log(`Loaded ${records.length} short-DTE IV records (${resolution})`);
  return records;
}

// ============================================================================
// Helper: Build sorted candle array for binary search
// ============================================================================

function buildCandleTimeline(candles) {
  // candles is an array sorted by timestamp
  const timestamps = candles.map(c => c.timestamp);
  return {
    candles,
    timestamps,
    getForwardReturn(fromTs, minutesForward) {
      // Find index of candle at or after fromTs
      let lo = 0, hi = timestamps.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (timestamps[mid] < fromTs) lo = mid + 1;
        else hi = mid;
      }
      const startIdx = lo;
      if (startIdx >= timestamps.length) return null;

      const targetTs = fromTs + minutesForward * 60000;
      // Find candle closest to targetTs
      let endIdx = startIdx;
      while (endIdx < timestamps.length - 1 && timestamps[endIdx] < targetTs) endIdx++;

      const startPrice = candles[startIdx].close;
      const endPrice = candles[endIdx].close;
      return endPrice - startPrice; // Points
    },
    getRealizedVol(fromTs, windowMinutes) {
      // Std dev of 1-min returns over window
      let lo = 0, hi = timestamps.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (timestamps[mid] < fromTs) lo = mid + 1;
        else hi = mid;
      }
      const startIdx = lo;
      const endTs = fromTs + windowMinutes * 60000;
      const returns = [];
      for (let i = startIdx; i < timestamps.length - 1 && timestamps[i] < endTs; i++) {
        const ret = (candles[i + 1].close - candles[i].close) / candles[i].close;
        returns.push(ret);
      }
      if (returns.length < 5) return null;
      const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
      const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
      // Annualize: multiply by sqrt(minutes per year)
      const minutesPerYear = 252 * 6.5 * 60;
      return Math.sqrt(variance * minutesPerYear);
    },
    getCandlesBetween(fromTs, toTs) {
      let lo = 0, hi = timestamps.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (timestamps[mid] < fromTs) lo = mid + 1;
        else hi = mid;
      }
      const result = [];
      for (let i = lo; i < timestamps.length && timestamps[i] <= toTs; i++) {
        result.push(candles[i]);
      }
      return result;
    }
  };
}

// ============================================================================
// Analysis 1: IV Change → Price Direction
// ============================================================================

function analysis1_IVChangeDirection(ivRecords, timeline) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 1: IV Change → Price Direction');
  console.log('═'.repeat(80));

  const results = {};
  const forwardWindows = [5, 15, 30, 60]; // minutes
  const ivFields = ['dte0_avg_iv', 'dte1_avg_iv', 'dte0_skew', 'dte1_skew'];

  for (const field of ivFields) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`IV Field: ${field}`);
    console.log('─'.repeat(60));

    // Compute IV changes (15-min and 30-min)
    const changes15 = [];
    const changes30 = [];

    for (let i = 1; i < ivRecords.length; i++) {
      const curr = ivRecords[i];
      const prev1 = ivRecords[i - 1];
      if (curr[field] === null || prev1[field] === null) continue;

      // Check same trading day (allow gaps within day but not across days)
      const currDate = curr.timestamp.split('T')[0];
      const prevDate = prev1.timestamp.split('T')[0];

      const change15 = curr[field] - prev1[field];
      changes15.push({ ts: curr.timestampMs, change: change15 });

      if (i >= 2 && currDate === prevDate) {
        const prev2 = ivRecords[i - 2];
        if (prev2[field] !== null) {
          changes30.push({ ts: curr.timestampMs, change: curr[field] - prev2[field] });
        }
      }
    }

    console.log(`  15-min IV changes: ${changes15.length}, 30-min: ${changes30.length}`);

    for (const [label, changes] of [['15m_change', changes15], ['30m_change', changes30]]) {
      if (changes.length < 50) continue;

      const changeValues = changes.map(c => c.change);
      const getBucket = quintileBuckets(changeValues);

      for (const fwdMin of forwardWindows) {
        const quintileReturns = [[], [], [], [], []];

        for (const c of changes) {
          const ret = timeline.getForwardReturn(c.ts, fwdMin);
          if (ret === null) continue;
          const q = getBucket(c.change);
          quintileReturns[q].push(ret);
        }

        const q1Returns = quintileReturns[0];
        const q5Returns = quintileReturns[4];

        if (q1Returns.length < 10 || q5Returns.length < 10) continue;

        const q1Stats = calcStats(q1Returns);
        const q5Stats = calcStats(q5Returns);
        const tTest = welchTTest(q1Returns, q5Returns);
        const d = cohensD(q1Returns, q5Returns);

        // Correlations
        const allChanges = [], allReturns = [];
        for (const c of changes) {
          const ret = timeline.getForwardReturn(c.ts, fwdMin);
          if (ret === null) continue;
          allChanges.push(c.change);
          allReturns.push(ret);
        }

        const pearson = pearsonCorrelation(allChanges, allReturns);
        const spearman = spearmanCorrelation(allChanges, allReturns);

        console.log(`\n  ${label} → ${fwdMin}m forward return:`);
        console.log(`    Q1 (lowest IV change): mean=${q1Stats.mean.toFixed(2)}pts, n=${q1Stats.count}`);
        console.log(`    Q5 (highest IV change): mean=${q5Stats.mean.toFixed(2)}pts, n=${q5Stats.count}`);
        console.log(`    Welch t=${tTest.t.toFixed(3)}, p=${tTest.p.toFixed(4)} ${getSignificance(tTest.p)}`);
        console.log(`    Cohen's d=${d.toFixed(3)}`);
        console.log(`    Pearson r=${pearson.r.toFixed(4)}, p=${pearson.p.toFixed(4)} ${getSignificance(pearson.p)}`);
        console.log(`    Spearman rho=${spearman.rho.toFixed(4)}, p=${spearman.p.toFixed(4)} ${getSignificance(spearman.p)}`);

        // Per-quintile mean returns
        const qMeans = quintileReturns.map((qr, qi) => {
          const s = calcStats(qr);
          return `Q${qi + 1}:${s.mean.toFixed(2)}(n=${s.count})`;
        });
        console.log(`    Quintiles: ${qMeans.join(' ')}`);

        if (!results[field]) results[field] = {};
        results[field][`${label}_${fwdMin}m`] = {
          pearsonR: pearson.r, pearsonP: pearson.p,
          spearmanRho: spearman.rho, spearmanP: spearman.p,
          tStat: tTest.t, tP: tTest.p, cohenD: d,
          q1Mean: q1Stats.mean, q5Mean: q5Stats.mean,
          n: allChanges.length
        };
      }
    }
  }

  return results;
}

// ============================================================================
// Analysis 2: IV Crush → GEX Pinning
// ============================================================================

function analysis2_IVCrushPinning(ivRecords, timeline, product) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 2: IV Crush → GEX Pinning');
  console.log('═'.repeat(80));

  // Group IV records by date
  const byDate = new Map();
  for (const r of ivRecords) {
    const date = r.timestamp.split('T')[0];
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }

  const dailyMetrics = [];

  for (const [date, dayRecords] of byDate) {
    if (dayRecords.length < 4) continue; // Need enough intraday data

    // Sort by timestamp
    dayRecords.sort((a, b) => a.timestampMs - b.timestampMs);

    // Get open and close 0-DTE IV
    const withDTE0 = dayRecords.filter(r => r.dte0_avg_iv !== null);
    if (withDTE0.length < 2) continue;

    const openIV = withDTE0[0].dte0_avg_iv;
    const closeIV = withDTE0[withDTE0.length - 1].dte0_avg_iv;
    if (openIV <= 0) continue;

    const crushRate = (openIV - closeIV) / openIV;

    // Load GEX for this date
    const gexData = loadIntradayGEX(product.toUpperCase(), date);
    if (!gexData || gexData.length === 0) continue;

    // Get gamma flip level (use last available snapshot)
    const lastGEX = gexData[gexData.length - 1];
    const gammaFlip = lastGEX.gamma_flip;
    const regime = lastGEX.regime;
    if (!gammaFlip) continue;

    // Measure price pinning: average |price - gamma_flip| in last 2 hours of RTH
    const [year, month, day] = date.split('-').map(Number);
    const rthEnd = fromET(year, month - 1, day, 16, 0);
    const last2hStart = fromET(year, month - 1, day, 14, 0);

    const last2hCandles = timeline.getCandlesBetween(last2hStart, rthEnd);
    if (last2hCandles.length < 10) continue;

    const avgDistFromGamma = last2hCandles.reduce((s, c) =>
      s + Math.abs(c.close - gammaFlip), 0) / last2hCandles.length;

    // Realized range ratio: actual range / expected range
    const rthStart = fromET(year, month - 1, day, 9, 30);
    const rthCandles = timeline.getCandlesBetween(rthStart, rthEnd);
    if (rthCandles.length < 30) continue;

    const actualRange = Math.max(...rthCandles.map(c => c.high)) - Math.min(...rthCandles.map(c => c.low));
    // Expected range from morning IV: S * IV * sqrt(T_day)
    const spotPrice = dayRecords[0].spotPrice || rthCandles[0].close;
    const expectedRange = spotPrice * openIV * Math.sqrt(1 / 252);
    const rangeRatio = expectedRange > 0 ? actualRange / expectedRange : null;

    dailyMetrics.push({
      date, crushRate, openIV, closeIV,
      avgDistFromGamma, gammaFlip, regime,
      actualRange, expectedRange, rangeRatio,
      spotPrice
    });
  }

  console.log(`\nDays with complete data: ${dailyMetrics.length}`);

  if (dailyMetrics.length < 20) {
    console.log('  Insufficient data for analysis');
    return {};
  }

  // Correlate crush rate with pinning metrics
  const crushRates = dailyMetrics.map(m => m.crushRate);
  const distFromGamma = dailyMetrics.map(m => m.avgDistFromGamma);
  const rangeRatios = dailyMetrics.filter(m => m.rangeRatio !== null).map(m => m.rangeRatio);
  const crushForRange = dailyMetrics.filter(m => m.rangeRatio !== null).map(m => m.crushRate);

  console.log('\n  Crush Rate Stats:');
  const crushStats = calcStats(crushRates);
  console.log(`    Mean=${(crushStats.mean * 100).toFixed(1)}%, Median=${(crushStats.median * 100).toFixed(1)}%, Std=${(crushStats.std * 100).toFixed(1)}%`);

  console.log('\n  Avg Distance from Gamma Flip (last 2h):');
  const distStats = calcStats(distFromGamma);
  console.log(`    Mean=${distStats.mean.toFixed(1)}pts, Median=${distStats.median.toFixed(1)}pts`);

  // Crush ↔ Pinning correlation
  const crushPinCorr = pearsonCorrelation(crushRates, distFromGamma);
  const crushPinSpear = spearmanCorrelation(crushRates, distFromGamma);
  console.log(`\n  Crush Rate → Distance from Gamma Flip:`);
  console.log(`    Pearson r=${crushPinCorr.r.toFixed(4)}, p=${crushPinCorr.p.toFixed(4)} ${getSignificance(crushPinCorr.p)}`);
  console.log(`    Spearman rho=${crushPinSpear.rho.toFixed(4)}, p=${crushPinSpear.p.toFixed(4)} ${getSignificance(crushPinSpear.p)}`);
  console.log(`    Interpretation: negative r = more crush → closer to gamma flip (more pinning)`);

  // Crush ↔ Range ratio
  if (crushForRange.length >= 20) {
    const crushRangeCorr = pearsonCorrelation(crushForRange, rangeRatios);
    const crushRangeSpear = spearmanCorrelation(crushForRange, rangeRatios);
    console.log(`\n  Crush Rate → Range Ratio (actual/expected):`);
    console.log(`    Pearson r=${crushRangeCorr.r.toFixed(4)}, p=${crushRangeCorr.p.toFixed(4)} ${getSignificance(crushRangeCorr.p)}`);
    console.log(`    Spearman rho=${crushRangeSpear.rho.toFixed(4)}, p=${crushRangeSpear.p.toFixed(4)} ${getSignificance(crushRangeSpear.p)}`);
    console.log(`    Range Ratio stats: mean=${calcStats(rangeRatios).mean.toFixed(3)}, median=${calcStats(rangeRatios).median.toFixed(3)}`);
  }

  // Split by GEX regime
  console.log('\n  By GEX Regime:');
  const regimeGroups = {};
  for (const m of dailyMetrics) {
    const r = m.regime || 'unknown';
    if (!regimeGroups[r]) regimeGroups[r] = [];
    regimeGroups[r].push(m);
  }

  for (const [regime, metrics] of Object.entries(regimeGroups)) {
    const crushVals = metrics.map(m => m.crushRate);
    const distVals = metrics.map(m => m.avgDistFromGamma);
    const stats = calcStats(crushVals);
    const distS = calcStats(distVals);

    console.log(`    ${regime}: n=${metrics.length}, crush=${(stats.mean * 100).toFixed(1)}%±${(stats.std * 100).toFixed(1)}%, dist=${distS.mean.toFixed(1)}pts`);

    if (metrics.length >= 10) {
      const corr = pearsonCorrelation(crushVals, distVals);
      console.log(`      crush↔dist: r=${corr.r.toFixed(3)}, p=${corr.p.toFixed(4)} ${getSignificance(corr.p)}`);
    }
  }

  // Quintile analysis: high crush days vs low crush days
  if (dailyMetrics.length >= 25) {
    const getBucket = quintileBuckets(crushRates);
    const q1Dist = [], q5Dist = [];
    const q1Range = [], q5Range = [];

    for (const m of dailyMetrics) {
      const q = getBucket(m.crushRate);
      if (q === 0) {
        q1Dist.push(m.avgDistFromGamma);
        if (m.rangeRatio !== null) q1Range.push(m.rangeRatio);
      } else if (q === 4) {
        q5Dist.push(m.avgDistFromGamma);
        if (m.rangeRatio !== null) q5Range.push(m.rangeRatio);
      }
    }

    console.log('\n  Quintile Comparison (Q1=lowest crush, Q5=highest crush):');
    if (q1Dist.length >= 5 && q5Dist.length >= 5) {
      const t1 = welchTTest(q1Dist, q5Dist);
      console.log(`    Distance from gamma: Q1=${calcStats(q1Dist).mean.toFixed(1)}pts, Q5=${calcStats(q5Dist).mean.toFixed(1)}pts, p=${t1.p.toFixed(4)} ${getSignificance(t1.p)}`);
    }
    if (q1Range.length >= 5 && q5Range.length >= 5) {
      const t2 = welchTTest(q1Range, q5Range);
      console.log(`    Range ratio: Q1=${calcStats(q1Range).mean.toFixed(3)}, Q5=${calcStats(q5Range).mean.toFixed(3)}, p=${t2.p.toFixed(4)} ${getSignificance(t2.p)}`);
    }
  }

  return {
    n: dailyMetrics.length,
    crushPinCorr: crushPinCorr.r,
    crushPinP: crushPinCorr.p
  };
}

// ============================================================================
// Analysis 3: Skew Dynamics → Direction
// ============================================================================

function analysis3_SkewDynamics(ivRecords, timeline) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 3: Skew Dynamics → Direction');
  console.log('═'.repeat(80));

  const forwardWindows = [5, 15, 30, 60];

  // 3a: Absolute skew levels vs forward returns
  console.log('\n3a: Skew Level vs Forward Returns');
  console.log('─'.repeat(60));

  for (const dteField of ['dte0_skew', 'dte1_skew']) {
    const records = ivRecords.filter(r => r[dteField] !== null);
    if (records.length < 50) {
      console.log(`  ${dteField}: insufficient data (${records.length})`);
      continue;
    }

    console.log(`\n  ${dteField} (n=${records.length}):`);
    const skewValues = records.map(r => r[dteField]);
    const skewStats = calcStats(skewValues);
    console.log(`    Level: mean=${(skewStats.mean * 100).toFixed(2)}%, std=${(skewStats.std * 100).toFixed(2)}%`);

    for (const fwdMin of forwardWindows) {
      const x = [], y = [];
      for (const r of records) {
        const ret = timeline.getForwardReturn(r.timestampMs, fwdMin);
        if (ret === null) continue;
        x.push(r[dteField]);
        y.push(ret);
      }

      if (x.length < 30) continue;

      const pearson = pearsonCorrelation(x, y);
      const spearman = spearmanCorrelation(x, y);
      console.log(`    → ${fwdMin}m: Pearson r=${pearson.r.toFixed(4)} ${getSignificance(pearson.p)}, Spearman rho=${spearman.rho.toFixed(4)} ${getSignificance(spearman.p)}, n=${x.length}`);
    }
  }

  // 3b: Skew divergence (dte0_skew - dte1_skew)
  console.log('\n3b: Skew Divergence (DTE0 - DTE1) vs Forward Returns');
  console.log('─'.repeat(60));

  const divRecords = ivRecords.filter(r => r.dte0_skew !== null && r.dte1_skew !== null);
  if (divRecords.length >= 50) {
    for (const fwdMin of forwardWindows) {
      const x = [], y = [];
      for (const r of divRecords) {
        const ret = timeline.getForwardReturn(r.timestampMs, fwdMin);
        if (ret === null) continue;
        const divergence = r.dte0_skew - r.dte1_skew;
        x.push(divergence);
        y.push(ret);
      }

      if (x.length < 30) continue;

      const pearson = pearsonCorrelation(x, y);
      const spearman = spearmanCorrelation(x, y);

      // Also test: when 0-DTE puts expensive vs 1-DTE (positive divergence), does NQ sell off?
      const posDiv = [], negDiv = [];
      for (let i = 0; i < x.length; i++) {
        if (x[i] > 0) posDiv.push(y[i]);
        else negDiv.push(y[i]);
      }

      console.log(`  → ${fwdMin}m: r=${pearson.r.toFixed(4)} ${getSignificance(pearson.p)}, rho=${spearman.rho.toFixed(4)} ${getSignificance(spearman.p)}, n=${x.length}`);

      if (posDiv.length >= 10 && negDiv.length >= 10) {
        const t = welchTTest(posDiv, negDiv);
        console.log(`    Pos divergence (0DTE puts rich): mean_ret=${calcStats(posDiv).mean.toFixed(2)}pts (n=${posDiv.length})`);
        console.log(`    Neg divergence (0DTE puts cheap): mean_ret=${calcStats(negDiv).mean.toFixed(2)}pts (n=${negDiv.length})`);
        console.log(`    t=${t.t.toFixed(3)}, p=${t.p.toFixed(4)} ${getSignificance(t.p)}`);
      }
    }
  } else {
    console.log(`  Insufficient data: ${divRecords.length} records with both DTE0 and DTE1 skew`);
  }

  // 3c: Skew reversal events (sign change)
  console.log('\n3c: Skew Reversal Events');
  console.log('─'.repeat(60));

  for (const dteField of ['dte0_skew', 'dte1_skew']) {
    const reversals = [];

    for (let i = 1; i < ivRecords.length; i++) {
      const prev = ivRecords[i - 1][dteField];
      const curr = ivRecords[i][dteField];
      if (prev === null || curr === null) continue;

      // Sign change
      if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) {
        reversals.push({
          ts: ivRecords[i].timestampMs,
          direction: curr > 0 ? 'to_positive' : 'to_negative',
          magnitude: Math.abs(curr - prev)
        });
      }
    }

    console.log(`\n  ${dteField} reversals: ${reversals.length} events`);

    if (reversals.length < 10) continue;

    for (const fwdMin of [5, 15, 30]) {
      const toPosReturns = [], toNegReturns = [];

      for (const rev of reversals) {
        const ret = timeline.getForwardReturn(rev.ts, fwdMin);
        if (ret === null) continue;
        if (rev.direction === 'to_positive') toPosReturns.push(ret);
        else toNegReturns.push(ret);
      }

      if (toPosReturns.length >= 5 && toNegReturns.length >= 5) {
        const t = welchTTest(toPosReturns, toNegReturns);
        console.log(`    → ${fwdMin}m: to_pos mean=${calcStats(toPosReturns).mean.toFixed(2)}pts(n=${toPosReturns.length}), to_neg mean=${calcStats(toNegReturns).mean.toFixed(2)}pts(n=${toNegReturns.length}), p=${t.p.toFixed(4)} ${getSignificance(t.p)}`);
      }
    }
  }

  return { divergenceRecords: divRecords.length, reversalCount: 'computed' };
}

// ============================================================================
// Analysis 4: Term Structure → Realized Volatility
// ============================================================================

function analysis4_TermStructure(ivRecords, timeline) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 4: Term Structure → Realized Volatility');
  console.log('═'.repeat(80));

  // Compute term slopes and curvature
  const termRecords = ivRecords.filter(r =>
    r.dte0_avg_iv !== null && r.dte1_avg_iv !== null
  );

  console.log(`Records with DTE0+DTE1 IV: ${termRecords.length}`);

  if (termRecords.length < 50) {
    console.log('Insufficient data for term structure analysis');
    return {};
  }

  // 4a: Term slope (dte1 - dte0) vs forward realized vol
  console.log('\n4a: Term Slope (DTE1 - DTE0) → Forward Realized Vol');
  console.log('─'.repeat(60));

  const realVolWindows = [30, 60, 120];

  for (const volWindow of realVolWindows) {
    const slopes = [], realVols = [];

    for (const r of termRecords) {
      const slope = r.dte1_avg_iv - r.dte0_avg_iv;
      const realVol = timeline.getRealizedVol(r.timestampMs, volWindow);
      if (realVol === null) continue;
      slopes.push(slope);
      realVols.push(realVol);
    }

    if (slopes.length < 30) continue;

    const pearson = pearsonCorrelation(slopes, realVols);
    const spearman = spearmanCorrelation(slopes, realVols);

    console.log(`  → ${volWindow}m realized vol:`);
    console.log(`    Pearson r=${pearson.r.toFixed(4)}, p=${pearson.p.toFixed(4)} ${getSignificance(pearson.p)}`);
    console.log(`    Spearman rho=${spearman.rho.toFixed(4)}, p=${spearman.p.toFixed(4)} ${getSignificance(spearman.p)}`);
  }

  // 4b: Inverted term structure (0-DTE > 1-DTE) vs normal
  console.log('\n4b: Inverted vs Normal Term Structure');
  console.log('─'.repeat(60));

  const invertedRecords = termRecords.filter(r => r.dte0_avg_iv > r.dte1_avg_iv);
  const normalRecords = termRecords.filter(r => r.dte0_avg_iv <= r.dte1_avg_iv);
  const pctInverted = (invertedRecords.length / termRecords.length * 100).toFixed(1);

  console.log(`  Inverted: ${invertedRecords.length} (${pctInverted}%), Normal: ${normalRecords.length}`);

  for (const volWindow of realVolWindows) {
    const invertedVols = [], normalVols = [];

    for (const r of invertedRecords) {
      const rv = timeline.getRealizedVol(r.timestampMs, volWindow);
      if (rv !== null) invertedVols.push(rv);
    }
    for (const r of normalRecords) {
      const rv = timeline.getRealizedVol(r.timestampMs, volWindow);
      if (rv !== null) normalVols.push(rv);
    }

    if (invertedVols.length < 10 || normalVols.length < 10) continue;

    const t = welchTTest(invertedVols, normalVols);
    const d = cohensD(invertedVols, normalVols);

    console.log(`  → ${volWindow}m: inverted=${(calcStats(invertedVols).mean * 100).toFixed(1)}% (n=${invertedVols.length}), normal=${(calcStats(normalVols).mean * 100).toFixed(1)}% (n=${normalVols.length}), p=${t.p.toFixed(4)} ${getSignificance(t.p)}, d=${d.toFixed(3)}`);
  }

  // 4c: Curvature (if DTE2 available)
  const curveRecords = ivRecords.filter(r =>
    r.dte0_avg_iv !== null && r.dte1_avg_iv !== null && r.dte2_avg_iv !== null
  );

  if (curveRecords.length >= 30) {
    console.log('\n4c: Term Structure Curvature (DTE2 - 2*DTE1 + DTE0)');
    console.log('─'.repeat(60));

    for (const volWindow of realVolWindows) {
      const curvatures = [], realVols = [];

      for (const r of curveRecords) {
        const curvature = r.dte2_avg_iv - 2 * r.dte1_avg_iv + r.dte0_avg_iv;
        const rv = timeline.getRealizedVol(r.timestampMs, volWindow);
        if (rv === null) continue;
        curvatures.push(curvature);
        realVols.push(rv);
      }

      if (curvatures.length < 20) continue;

      const pearson = pearsonCorrelation(curvatures, realVols);
      console.log(`  → ${volWindow}m: r=${pearson.r.toFixed(4)}, p=${pearson.p.toFixed(4)} ${getSignificance(pearson.p)}, n=${curvatures.length}`);
    }
  } else {
    console.log(`\n4c: Skipped — only ${curveRecords.length} records with all 3 DTE buckets`);
  }

  // 4d: Term slope vs forward price direction
  console.log('\n4d: Term Slope → Forward Price Direction');
  console.log('─'.repeat(60));

  const forwardWindows = [5, 15, 30, 60];
  for (const fwdMin of forwardWindows) {
    const slopes = [], returns = [];

    for (const r of termRecords) {
      const slope = r.dte1_avg_iv - r.dte0_avg_iv;
      const ret = timeline.getForwardReturn(r.timestampMs, fwdMin);
      if (ret === null) continue;
      slopes.push(slope);
      returns.push(ret);
    }

    if (slopes.length < 30) continue;

    const pearson = pearsonCorrelation(slopes, returns);
    const spearman = spearmanCorrelation(slopes, returns);

    // Quintile analysis
    const getBucket = quintileBuckets(slopes);
    const qReturns = [[], [], [], [], []];
    for (let i = 0; i < slopes.length; i++) {
      qReturns[getBucket(slopes[i])].push(returns[i]);
    }

    const qStr = qReturns.map((qr, qi) => `Q${qi + 1}:${calcStats(qr).mean.toFixed(2)}`).join(' ');
    console.log(`  → ${fwdMin}m: r=${pearson.r.toFixed(4)} ${getSignificance(pearson.p)}, rho=${spearman.rho.toFixed(4)} ${getSignificance(spearman.p)}, n=${slopes.length}`);
    console.log(`    Quintiles: ${qStr}`);
  }

  return { termRecords: termRecords.length, curveRecords: curveRecords.length };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  let product = 'nq'; // nq or es
  let analyses = [1, 2, 3, 4];
  let resolution = '15m'; // 15m (TCBBO) or daily (statistics)

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--product': product = args[++i].toLowerCase(); break;
      case '--analyses': analyses = args[++i].split(',').map(Number); break;
      case '--resolution': resolution = args[++i]; break;
      case '--help':
        console.log('Usage: node analyze-short-dte-iv-correlations.js [--product nq|es] [--analyses 1,2,3,4] [--resolution 15m|daily]');
        process.exit(0);
    }
  }

  // Map product to IV source
  const ivProduct = product === 'nq' ? 'qqq' : 'spy';

  console.log('═'.repeat(80));
  console.log('0-2 DTE IV CORRELATION ANALYSIS');
  console.log('═'.repeat(80));
  console.log(`Product: ${product.toUpperCase()} (IV from ${ivProduct.toUpperCase()})`);
  console.log(`Resolution: ${resolution}`);
  console.log(`Analyses: ${analyses.join(', ')}`);

  // Load IV data
  const ivRecords = loadShortDTEIV(ivProduct, resolution);
  if (ivRecords.length === 0) {
    console.error(`\nNo IV data found. Run precompute-short-dte-iv.js first.`);
    process.exit(1);
  }

  // Determine date range from IV data
  const firstDate = ivRecords[0].timestamp.split('T')[0];
  const lastDate = ivRecords[ivRecords.length - 1].timestamp.split('T')[0];
  console.log(`IV data range: ${firstDate} to ${lastDate}`);

  // Load NQ/ES OHLCV
  console.log(`\nLoading ${product.toUpperCase()} OHLCV...`);
  const candles = await loadContinuousOHLCV(product.toUpperCase(), '1m', firstDate, lastDate);
  const timeline = buildCandleTimeline(candles);

  const results = {};

  if (analyses.includes(1) && resolution === '15m') {
    results.analysis1 = analysis1_IVChangeDirection(ivRecords, timeline);
  } else if (analyses.includes(1) && resolution === 'daily') {
    console.log('\nSkipping Analysis 1 (requires intraday data, use --resolution 15m)');
  }

  if (analyses.includes(2)) {
    results.analysis2 = analysis2_IVCrushPinning(ivRecords, timeline, product);
  }

  if (analyses.includes(3) && resolution === '15m') {
    results.analysis3 = analysis3_SkewDynamics(ivRecords, timeline);
  } else if (analyses.includes(3) && resolution === 'daily') {
    console.log('\nSkipping Analysis 3 (requires intraday data)');
  }

  if (analyses.includes(4) && resolution === '15m') {
    results.analysis4 = analysis4_TermStructure(ivRecords, timeline);
  } else if (analyses.includes(4) && resolution === 'daily') {
    console.log('\nSkipping Analysis 4 (requires intraday data)');
  }

  // Save results
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `short-dte-iv-correlations-${product}-${resolution}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outputPath}`);

  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('SUMMARY');
  console.log('═'.repeat(80));

  if (results.analysis1) {
    console.log('\nAnalysis 1 (IV Change → Direction):');
    for (const [field, fieldResults] of Object.entries(results.analysis1)) {
      const significant = Object.entries(fieldResults)
        .filter(([, v]) => v.tP < 0.05)
        .map(([k, v]) => `${k}: r=${v.pearsonR.toFixed(3)} ${getSignificance(v.tP)}`);
      if (significant.length > 0) {
        console.log(`  ${field}: ${significant.join(', ')}`);
      }
    }
  }

  if (results.analysis2 && results.analysis2.crushPinP < 0.05) {
    console.log(`\nAnalysis 2: Significant crush↔pinning correlation (r=${results.analysis2.crushPinCorr.toFixed(3)}, p=${results.analysis2.crushPinP.toFixed(4)})`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
