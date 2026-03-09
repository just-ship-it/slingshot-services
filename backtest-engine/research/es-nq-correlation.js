#!/usr/bin/env node
/**
 * ES-NQ Correlation & Lead-Lag Analysis
 *
 * Analyzes the relationship between ES and NQ continuous 1-minute data:
 * 1. Return correlation at multiple timeframes (1m, 5m, 15m, 1h, daily)
 * 2. Lead-lag cross-correlation (who leads whom, and when?)
 * 3. Divergence detection and outcome analysis
 * 4. NQ/ES ratio behavior and mean reversion
 * 5. Session-based correlation differences
 * 6. SMT divergence signals (swing high/low non-confirmation)
 * 7. Volume-based lead-lag
 *
 * Uses continuous (back-adjusted) OHLCV files.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadContinuousOHLCV,
  toET,
  fromET,
  extractTradingDates,
  getRTHCandlesFromArray,
  getOvernightCandlesFromArray
} from './utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, 'output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Configuration ───────────────────────────────────────────────────────────

const START_DATE = '2021-01-26';  // ES data start
const END_DATE = '2026-01-25';    // ES data end
const LEAD_LAG_MAX = 5;           // ±5 minutes for cross-correlation

// ─── Utility Functions ───────────────────────────────────────────────────────

function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n < 10) return { r: null, pValue: 1, n };

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return { r: 0, pValue: 1, n };
  const r = num / denom;

  // t-test for significance
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  // Approximate p-value (normal approximation for large n)
  const pValue = n > 30 ? 2 * (1 - normalCDF(Math.abs(t))) : 1;

  return { r, pValue, n };
}

function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327; // 1/sqrt(2*pi)
  const p = d * Math.exp(-x * x / 2) * (t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))));
  return x > 0 ? 1 - p : p;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length);
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p / 100 * (sorted.length - 1));
  return sorted[idx];
}

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadData() {
  console.log('Loading continuous 1m data for NQ and ES...\n');

  const [nqCandles, esCandles] = await Promise.all([
    loadContinuousOHLCV('NQ', '1m', START_DATE, END_DATE),
    loadContinuousOHLCV('ES', '1m', START_DATE, END_DATE)
  ]);

  // Build timestamp-indexed maps for fast lookup
  const nqMap = new Map();
  for (const c of nqCandles) nqMap.set(c.timestamp, c);

  const esMap = new Map();
  for (const c of esCandles) esMap.set(c.timestamp, c);

  // Find overlapping timestamps
  const commonTimestamps = [];
  for (const ts of nqMap.keys()) {
    if (esMap.has(ts)) commonTimestamps.push(ts);
  }
  commonTimestamps.sort((a, b) => a - b);

  console.log(`\nOverlapping 1-minute bars: ${commonTimestamps.length.toLocaleString()}`);
  console.log(`Date range: ${new Date(commonTimestamps[0]).toISOString().split('T')[0]} to ${new Date(commonTimestamps[commonTimestamps.length - 1]).toISOString().split('T')[0]}\n`);

  return { nqCandles, esCandles, nqMap, esMap, commonTimestamps };
}

// ─── Analysis 1: Return Correlation at Multiple Timeframes ───────────────────

function analyzeReturnCorrelation(nqMap, esMap, commonTimestamps) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  1. Return Correlation at Multiple Timeframes');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const timeframes = [
    { name: '1m', bars: 1 },
    { name: '5m', bars: 5 },
    { name: '15m', bars: 15 },
    { name: '30m', bars: 30 },
    { name: '1h', bars: 60 },
  ];

  const results = {};

  for (const tf of timeframes) {
    const nqReturns = [];
    const esReturns = [];

    for (let i = tf.bars; i < commonTimestamps.length; i++) {
      const ts = commonTimestamps[i];
      const tsPrev = commonTimestamps[i - tf.bars];

      const nqNow = nqMap.get(ts);
      const nqPrev = nqMap.get(tsPrev);
      const esNow = esMap.get(ts);
      const esPrev = esMap.get(tsPrev);

      if (!nqNow || !nqPrev || !esNow || !esPrev) continue;
      if (nqPrev.close === 0 || esPrev.close === 0) continue;

      // Check timestamps are actually tf.bars apart (no session gaps)
      const timeDiff = (ts - tsPrev) / 60000;
      if (timeDiff > tf.bars * 2) continue;

      const nqReturn = (nqNow.close - nqPrev.close) / nqPrev.close;
      const esReturn = (esNow.close - esPrev.close) / esPrev.close;

      nqReturns.push(nqReturn);
      esReturns.push(esReturn);
    }

    const corr = pearsonCorrelation(nqReturns, esReturns);

    // Directional agreement
    let sameDir = 0, total = 0;
    for (let i = 0; i < nqReturns.length; i++) {
      if (nqReturns[i] === 0 || esReturns[i] === 0) continue;
      total++;
      if ((nqReturns[i] > 0) === (esReturns[i] > 0)) sameDir++;
    }

    results[tf.name] = {
      correlation: corr.r,
      n: corr.n,
      directionalAgreement: total > 0 ? sameDir / total : 0,
      avgNqReturn: mean(nqReturns),
      avgEsReturn: mean(esReturns),
      nqStddev: stddev(nqReturns),
      esStddev: stddev(esReturns),
      nqVolRatio: stddev(nqReturns) / stddev(esReturns)
    };

    console.log(`  ${tf.name.padEnd(4)} | r=${corr.r?.toFixed(4)} | dir_agree=${(sameDir / total * 100).toFixed(1)}% | NQ_vol/ES_vol=${(stddev(nqReturns) / stddev(esReturns)).toFixed(3)} | n=${corr.n.toLocaleString()}`);
  }

  // Daily correlation
  const nqArr = Array.from(nqMap.values());
  const esArr = Array.from(esMap.values());
  const tradingDates = extractTradingDates(nqArr);
  const nqDailyReturns = [], esDailyReturns = [], dailyDates = [];

  for (let i = 1; i < tradingDates.length; i++) {
    const todayNQ = getRTHCandlesFromArray(nqArr, tradingDates[i]);
    const todayES = getRTHCandlesFromArray(esArr, tradingDates[i]);
    const prevNQ = getRTHCandlesFromArray(nqArr, tradingDates[i - 1]);
    const prevES = getRTHCandlesFromArray(esArr, tradingDates[i - 1]);

    if (todayNQ.length === 0 || todayES.length === 0 || prevNQ.length === 0 || prevES.length === 0) continue;

    const nqClose = todayNQ[todayNQ.length - 1].close;
    const nqPrevClose = prevNQ[prevNQ.length - 1].close;
    const esClose = todayES[todayES.length - 1].close;
    const esPrevClose = prevES[prevES.length - 1].close;

    if (nqPrevClose === 0 || esPrevClose === 0) continue;

    nqDailyReturns.push((nqClose - nqPrevClose) / nqPrevClose);
    esDailyReturns.push((esClose - esPrevClose) / esPrevClose);
    dailyDates.push(tradingDates[i]);
  }

  const dailyCorr = pearsonCorrelation(nqDailyReturns, esDailyReturns);
  let dailySameDir = 0, dailyTotal = 0;
  for (let i = 0; i < nqDailyReturns.length; i++) {
    if (nqDailyReturns[i] === 0 || esDailyReturns[i] === 0) continue;
    dailyTotal++;
    if ((nqDailyReturns[i] > 0) === (esDailyReturns[i] > 0)) dailySameDir++;
  }

  results['daily'] = {
    correlation: dailyCorr.r,
    n: dailyCorr.n,
    directionalAgreement: dailyTotal > 0 ? dailySameDir / dailyTotal : 0,
    nqVolRatio: stddev(nqDailyReturns) / stddev(esDailyReturns)
  };

  console.log(`  daily | r=${dailyCorr.r?.toFixed(4)} | dir_agree=${(dailySameDir / dailyTotal * 100).toFixed(1)}% | NQ_vol/ES_vol=${(stddev(nqDailyReturns) / stddev(esDailyReturns)).toFixed(3)} | n=${dailyCorr.n.toLocaleString()}`);

  return { results, nqDailyReturns, esDailyReturns, dailyDates, tradingDates };
}

// ─── Analysis 2: Lead-Lag Cross-Correlation ──────────────────────────────────

function analyzeLeadLag(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  2. Lead-Lag Cross-Correlation (±5 minutes)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Compute 1-minute returns for both
  const nqReturns = [];
  const esReturns = [];
  const timestamps = [];

  for (let i = 1; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const tsPrev = commonTimestamps[i - 1];

    // Skip session gaps
    if ((ts - tsPrev) > 120000) continue;

    const nqNow = nqMap.get(ts);
    const nqPrev = nqMap.get(tsPrev);
    const esNow = esMap.get(ts);
    const esPrev = esMap.get(tsPrev);

    if (!nqNow || !nqPrev || !esNow || !esPrev) continue;
    if (nqPrev.close === 0 || esPrev.close === 0) continue;

    nqReturns.push((nqNow.close - nqPrev.close) / nqPrev.close);
    esReturns.push((esNow.close - esPrev.close) / esPrev.close);
    timestamps.push(ts);
  }

  console.log(`  Computed ${nqReturns.length.toLocaleString()} return pairs\n`);

  const results = [];

  // Cross-correlations: positive lag = NQ leads ES, negative lag = ES leads NQ
  console.log('  Lag  | Corr(NQ_t, ES_t+lag) | Interpretation');
  console.log('  ─────|──────────────────────|──────────────────────────');

  for (let lag = -LEAD_LAG_MAX; lag <= LEAD_LAG_MAX; lag++) {
    const x = []; // NQ returns
    const y = []; // ES returns at lag

    if (lag >= 0) {
      for (let i = 0; i < nqReturns.length - lag; i++) {
        x.push(nqReturns[i]);
        y.push(esReturns[i + lag]);
      }
    } else {
      for (let i = -lag; i < nqReturns.length; i++) {
        x.push(nqReturns[i]);
        y.push(esReturns[i + lag]);
      }
    }

    const corr = pearsonCorrelation(x, y);
    const interp = lag === 0 ? 'Contemporaneous'
      : lag > 0 ? `NQ leads ES by ${lag}m`
      : `ES leads NQ by ${-lag}m`;
    const marker = lag === 0 ? ' ◄── ' : '     ';

    results.push({ lag, correlation: corr.r, n: corr.n, interpretation: interp });
    console.log(`  ${String(lag).padStart(3)}  | ${corr.r?.toFixed(6).padStart(10)}           |${marker}${interp}`);
  }

  // Find peak lag (excluding lag=0)
  const nonZero = results.filter(r => r.lag !== 0 && r.correlation !== null);
  if (nonZero.length > 0) {
    const peak = nonZero.reduce((a, b) => Math.abs(b.correlation) > Math.abs(a.correlation) ? b : a);
    console.log(`\n  Peak non-zero lag: ${peak.lag}m (r=${peak.correlation?.toFixed(6)}) → ${peak.interpretation}`);
  }

  return { results, nqReturns, esReturns, timestamps };
}

// ─── Analysis 3: Divergence Detection ────────────────────────────────────────

function analyzeDivergences(nqMap, esMap, commonTimestamps, tradingDates, nqCandles, esCandles) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  3. Divergence Analysis');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Compute rolling NQ/ES ratio and 5-minute returns
  const ratios = [];
  const divergences = [];

  // Use 5-minute returns to detect meaningful divergences
  const LOOKBACK = 5;

  for (let i = LOOKBACK; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const tsPrev = commonTimestamps[i - LOOKBACK];

    if ((ts - tsPrev) > LOOKBACK * 120000) continue;

    const nqNow = nqMap.get(ts);
    const nqPrev = nqMap.get(tsPrev);
    const esNow = esMap.get(ts);
    const esPrev = esMap.get(tsPrev);

    if (!nqNow || !nqPrev || !esNow || !esPrev) continue;
    if (nqPrev.close === 0 || esPrev.close === 0) continue;

    const nqReturn = (nqNow.close - nqPrev.close) / nqPrev.close;
    const esReturn = (esNow.close - esPrev.close) / esPrev.close;
    const ratio = nqNow.close / esNow.close;

    ratios.push({ ts, ratio, nqReturn, esReturn });

    // Divergence: opposite directions with meaningful magnitude
    if (Math.abs(nqReturn) > 0.001 && Math.abs(esReturn) > 0.001) {
      if ((nqReturn > 0 && esReturn < 0) || (nqReturn < 0 && esReturn > 0)) {
        divergences.push({
          timestamp: ts,
          nqReturn,
          esReturn,
          nqPrice: nqNow.close,
          esPrice: esNow.close,
          ratio,
          nqLeads: Math.abs(nqReturn) > Math.abs(esReturn)
        });
      }
    }
  }

  console.log(`  Total 5-min return pairs: ${ratios.length.toLocaleString()}`);
  console.log(`  Divergence events (opposite dirs, >0.1% each): ${divergences.length.toLocaleString()}`);
  console.log(`  Divergence rate: ${(divergences.length / ratios.length * 100).toFixed(2)}%`);

  // What happens after divergences? Look forward 5, 15, 30, 60 minutes
  const lookforwardPeriods = [5, 15, 30, 60];
  const divergenceOutcomes = {};

  for (const fwd of lookforwardPeriods) {
    const outcomes = { nqReverts: 0, esReverts: 0, bothRevert: 0, neitherReverts: 0, total: 0 };

    for (const div of divergences) {
      // Find the timestamp fwd minutes later
      const targetTs = div.timestamp + fwd * 60000;
      const nqFwd = nqMap.get(targetTs);
      const esFwd = esMap.get(targetTs);

      if (!nqFwd || !esFwd) continue;

      const nqFwdReturn = (nqFwd.close - nqMap.get(div.timestamp).close) / nqMap.get(div.timestamp).close;
      const esFwdReturn = (esFwd.close - esMap.get(div.timestamp).close) / esMap.get(div.timestamp).close;

      outcomes.total++;

      // Does the "leader" (stronger move) revert? Or does the "lagger" catch up?
      const nqReverted = (div.nqReturn > 0 && nqFwdReturn < 0) || (div.nqReturn < 0 && nqFwdReturn > 0);
      const esReverted = (div.esReturn > 0 && esFwdReturn < 0) || (div.esReturn < 0 && esFwdReturn > 0);

      if (nqReverted && esReverted) outcomes.bothRevert++;
      else if (nqReverted) outcomes.nqReverts++;
      else if (esReverted) outcomes.esReverts++;
      else outcomes.neitherReverts++;
    }

    divergenceOutcomes[`${fwd}m`] = outcomes;
  }

  console.log('\n  After divergence, who reverts?');
  console.log('  Period | NQ reverts | ES reverts | Both revert | Neither | n');
  console.log('  ───────|────────────|────────────|─────────────|─────────|──────');

  for (const [period, o] of Object.entries(divergenceOutcomes)) {
    if (o.total === 0) continue;
    console.log(`  ${period.padEnd(6)} | ${(o.nqReverts / o.total * 100).toFixed(1).padStart(8)}%  | ${(o.esReverts / o.total * 100).toFixed(1).padStart(8)}%  | ${(o.bothRevert / o.total * 100).toFixed(1).padStart(9)}%  | ${(o.neitherReverts / o.total * 100).toFixed(1).padStart(6)}% | ${o.total.toLocaleString()}`);
  }

  // Stronger divergences (>0.3% each side)
  const strongDivs = divergences.filter(d => Math.abs(d.nqReturn) > 0.003 && Math.abs(d.esReturn) > 0.003);
  console.log(`\n  Strong divergences (>0.3% each): ${strongDivs.length}`);

  if (strongDivs.length > 0) {
    const strongOutcomes = { nqCatchesUp: 0, esCatchesUp: 0, total: 0 };

    for (const div of strongDivs) {
      const targetTs = div.timestamp + 30 * 60000;
      const nqFwd = nqMap.get(targetTs);
      const esFwd = esMap.get(targetTs);
      if (!nqFwd || !esFwd) continue;

      const nqFwdReturn = (nqFwd.close - nqMap.get(div.timestamp).close) / nqMap.get(div.timestamp).close;
      const esFwdReturn = (esFwd.close - esMap.get(div.timestamp).close) / esMap.get(div.timestamp).close;

      strongOutcomes.total++;

      // The one with the weaker initial move - does it catch up to the leader's direction?
      if (div.nqLeads) {
        // NQ moved more - does ES catch up to NQ's direction?
        if ((div.nqReturn > 0 && esFwdReturn > 0) || (div.nqReturn < 0 && esFwdReturn < 0)) {
          strongOutcomes.esCatchesUp++;
        }
      } else {
        // ES moved more - does NQ catch up?
        if ((div.esReturn > 0 && nqFwdReturn > 0) || (div.esReturn < 0 && nqFwdReturn < 0)) {
          strongOutcomes.nqCatchesUp++;
        }
      }
    }

    if (strongOutcomes.total > 0) {
      console.log(`  30m after strong divergence:`);
      console.log(`    NQ catches up to ES's direction: ${(strongOutcomes.nqCatchesUp / strongOutcomes.total * 100).toFixed(1)}%`);
      console.log(`    ES catches up to NQ's direction: ${(strongOutcomes.esCatchesUp / strongOutcomes.total * 100).toFixed(1)}%`);
      console.log(`    n=${strongOutcomes.total}`);
    }
  }

  return { divergences, divergenceOutcomes, ratios };
}

// ─── Analysis 4: NQ/ES Ratio Analysis ────────────────────────────────────────

function analyzeRatio(nqMap, esMap, commonTimestamps, tradingDates, nqCandles, esCandles) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  4. NQ/ES Ratio Analysis');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Compute daily close ratios
  const dailyRatios = [];
  const nqArr = Array.from(nqMap.values());
  const esArr = Array.from(esMap.values());

  for (const date of tradingDates) {
    const nqRTH = getRTHCandlesFromArray(nqArr, date);
    const esRTH = getRTHCandlesFromArray(esArr, date);

    if (nqRTH.length === 0 || esRTH.length === 0) continue;

    const nqClose = nqRTH[nqRTH.length - 1].close;
    const esClose = esRTH[esRTH.length - 1].close;

    if (esClose === 0) continue;

    dailyRatios.push({
      date,
      ratio: nqClose / esClose,
      nqClose,
      esClose
    });
  }

  const ratioValues = dailyRatios.map(r => r.ratio);

  console.log(`  Daily NQ/ES ratio statistics:`);
  console.log(`    Mean:    ${mean(ratioValues).toFixed(4)}`);
  console.log(`    Median:  ${median(ratioValues).toFixed(4)}`);
  console.log(`    StdDev:  ${stddev(ratioValues).toFixed(4)}`);
  console.log(`    Min:     ${Math.min(...ratioValues).toFixed(4)} (${dailyRatios[ratioValues.indexOf(Math.min(...ratioValues))]?.date})`);
  console.log(`    Max:     ${Math.max(...ratioValues).toFixed(4)} (${dailyRatios[ratioValues.indexOf(Math.max(...ratioValues))]?.date})`);
  console.log(`    Range:   ${(Math.max(...ratioValues) - Math.min(...ratioValues)).toFixed(4)}`);

  // Rolling 20-day ratio z-score and mean reversion analysis
  const LOOKBACK = 20;
  const zScores = [];
  const meanReversionEvents = [];

  for (let i = LOOKBACK; i < dailyRatios.length; i++) {
    const window = ratioValues.slice(i - LOOKBACK, i);
    const windowMean = mean(window);
    const windowStd = stddev(window);

    if (windowStd === 0) continue;

    const z = (ratioValues[i] - windowMean) / windowStd;
    zScores.push({ date: dailyRatios[i].date, z, ratio: ratioValues[i] });

    // Extreme z-scores (> 2 or < -2) as potential mean reversion signals
    if (Math.abs(z) > 2) {
      // Look forward 5 days for reversion
      if (i + 5 < dailyRatios.length) {
        const futureZ = [];
        for (let j = 1; j <= 5; j++) {
          const fWindow = ratioValues.slice(i - LOOKBACK + j, i + j);
          const fMean = mean(fWindow);
          const fStd = stddev(fWindow);
          if (fStd > 0) {
            futureZ.push((ratioValues[i + j] - fMean) / fStd);
          }
        }

        const reverted = futureZ.length > 0 && Math.abs(futureZ[futureZ.length - 1]) < Math.abs(z);
        meanReversionEvents.push({
          date: dailyRatios[i].date,
          z,
          direction: z > 0 ? 'NQ_outperforming' : 'ES_outperforming',
          reverted,
          futureZ
        });
      }
    }
  }

  console.log(`\n  Ratio Z-Score Analysis (20-day rolling):`);
  console.log(`    Z > 2 events:  ${meanReversionEvents.filter(e => e.z > 2).length}`);
  console.log(`    Z < -2 events: ${meanReversionEvents.filter(e => e.z < -2).length}`);

  if (meanReversionEvents.length > 0) {
    const reversionRate = meanReversionEvents.filter(e => e.reverted).length / meanReversionEvents.length;
    console.log(`    5-day mean reversion rate: ${(reversionRate * 100).toFixed(1)}% (n=${meanReversionEvents.length})`);

    const nqOutperf = meanReversionEvents.filter(e => e.z > 2);
    const esOutperf = meanReversionEvents.filter(e => e.z < -2);

    if (nqOutperf.length > 0) {
      const nqRevRate = nqOutperf.filter(e => e.reverted).length / nqOutperf.length;
      console.log(`    When NQ outperforms (z>2): ${(nqRevRate * 100).toFixed(1)}% revert within 5 days (n=${nqOutperf.length})`);
    }
    if (esOutperf.length > 0) {
      const esRevRate = esOutperf.filter(e => e.reverted).length / esOutperf.length;
      console.log(`    When ES outperforms (z<-2): ${(esRevRate * 100).toFixed(1)}% revert within 5 days (n=${esOutperf.length})`);
    }
  }

  return { dailyRatios, zScores, meanReversionEvents };
}

// ─── Analysis 5: Session-Based Correlation ───────────────────────────────────

function analyzeSessionCorrelation(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  5. Session-Based Correlation');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Classify each minute into sessions based on ET time
  const sessions = {
    overnight: { nq: [], es: [], times: [] },  // 6PM - 9:30AM ET
    rth_open: { nq: [], es: [], times: [] },    // 9:30AM - 10:30AM ET
    rth_mid: { nq: [], es: [], times: [] },     // 10:30AM - 3:00PM ET
    rth_close: { nq: [], es: [], times: [] },   // 3:00PM - 4:00PM ET
  };

  for (let i = 1; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const tsPrev = commonTimestamps[i - 1];

    if ((ts - tsPrev) > 120000) continue;

    const nqNow = nqMap.get(ts);
    const nqPrev = nqMap.get(tsPrev);
    const esNow = esMap.get(ts);
    const esPrev = esMap.get(tsPrev);

    if (!nqNow || !nqPrev || !esNow || !esPrev) continue;
    if (nqPrev.close === 0 || esPrev.close === 0) continue;

    const nqReturn = (nqNow.close - nqPrev.close) / nqPrev.close;
    const esReturn = (esNow.close - esPrev.close) / esPrev.close;

    const et = toET(ts);
    const timeMin = et.timeInMinutes;

    let session;
    if (timeMin >= 570 && timeMin < 630) session = 'rth_open';        // 9:30-10:30
    else if (timeMin >= 630 && timeMin < 900) session = 'rth_mid';    // 10:30-3:00
    else if (timeMin >= 900 && timeMin < 960) session = 'rth_close';  // 3:00-4:00
    else session = 'overnight';

    sessions[session].nq.push(nqReturn);
    sessions[session].es.push(esReturn);
    sessions[session].times.push(ts);
  }

  console.log('  Session      | Correlation | Dir. Agree | NQ_vol/ES_vol | n');
  console.log('  ─────────────|─────────────|────────────|───────────────|──────────');

  const sessionResults = {};

  for (const [name, data] of Object.entries(sessions)) {
    if (data.nq.length < 100) continue;

    const corr = pearsonCorrelation(data.nq, data.es);

    let sameDir = 0, total = 0;
    for (let i = 0; i < data.nq.length; i++) {
      if (data.nq[i] === 0 || data.es[i] === 0) continue;
      total++;
      if ((data.nq[i] > 0) === (data.es[i] > 0)) sameDir++;
    }

    const volRatio = stddev(data.nq) / stddev(data.es);

    sessionResults[name] = {
      correlation: corr.r,
      directionalAgreement: total > 0 ? sameDir / total : 0,
      volRatio,
      n: corr.n
    };

    console.log(`  ${name.padEnd(13)} | ${corr.r?.toFixed(4).padStart(8)}    | ${(sameDir / total * 100).toFixed(1).padStart(8)}%  | ${volRatio.toFixed(3).padStart(10)}    | ${corr.n.toLocaleString()}`);
  }

  return sessionResults;
}

// ─── Analysis 6: Volume-Based Lead-Lag ───────────────────────────────────────

function analyzeVolumeLead(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  6. Volume-Based Lead-Lag Analysis');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // When one instrument has a volume spike, does the other follow?
  const VOLUME_WINDOW = 20;

  const nqVolumes = [];
  const esVolumes = [];

  for (const ts of commonTimestamps) {
    nqVolumes.push(nqMap.get(ts)?.volume || 0);
    esVolumes.push(esMap.get(ts)?.volume || 0);
  }

  // Compute volume z-scores
  const volumeSpikeOutcomes = {
    nqSpike: { esFollows: 0, esDoesnt: 0, total: 0 },
    esSpike: { nqFollows: 0, nqDoesnt: 0, total: 0 },
    bothSpike: 0
  };

  for (let i = VOLUME_WINDOW; i < commonTimestamps.length - 5; i++) {
    const nqVolWindow = nqVolumes.slice(i - VOLUME_WINDOW, i);
    const esVolWindow = esVolumes.slice(i - VOLUME_WINDOW, i);

    const nqVolMean = mean(nqVolWindow);
    const esVolMean = mean(esVolWindow);
    const nqVolStd = stddev(nqVolWindow);
    const esVolStd = stddev(esVolWindow);

    if (nqVolStd === 0 || esVolStd === 0) continue;

    const nqVolZ = (nqVolumes[i] - nqVolMean) / nqVolStd;
    const esVolZ = (esVolumes[i] - esVolMean) / esVolStd;

    const nqSpike = nqVolZ > 2;
    const esSpike = esVolZ > 2;

    if (nqSpike && esSpike) {
      volumeSpikeOutcomes.bothSpike++;
      continue;
    }

    // NQ has volume spike - does ES follow within 3 bars?
    if (nqSpike) {
      volumeSpikeOutcomes.nqSpike.total++;
      let esFollowed = false;
      for (let j = 1; j <= 3; j++) {
        if (i + j >= esVolumes.length) break;
        const fwdZ = (esVolumes[i + j] - esVolMean) / esVolStd;
        if (fwdZ > 1.5) { esFollowed = true; break; }
      }
      if (esFollowed) volumeSpikeOutcomes.nqSpike.esFollows++;
      else volumeSpikeOutcomes.nqSpike.esDoesnt++;
    }

    // ES has volume spike - does NQ follow within 3 bars?
    if (esSpike) {
      volumeSpikeOutcomes.esSpike.total++;
      let nqFollowed = false;
      for (let j = 1; j <= 3; j++) {
        if (i + j >= nqVolumes.length) break;
        const fwdZ = (nqVolumes[i + j] - nqVolMean) / nqVolStd;
        if (fwdZ > 1.5) { nqFollowed = true; break; }
      }
      if (nqFollowed) volumeSpikeOutcomes.esSpike.nqFollows++;
      else volumeSpikeOutcomes.esSpike.nqDoesnt++;
    }
  }

  console.log(`  Volume spike analysis (z > 2 relative to 20-bar mean):`);
  console.log(`    Simultaneous spikes: ${volumeSpikeOutcomes.bothSpike.toLocaleString()}`);
  console.log(`    NQ spike alone: ${volumeSpikeOutcomes.nqSpike.total.toLocaleString()}`);
  if (volumeSpikeOutcomes.nqSpike.total > 0) {
    console.log(`      ES follows within 3 bars: ${(volumeSpikeOutcomes.nqSpike.esFollows / volumeSpikeOutcomes.nqSpike.total * 100).toFixed(1)}%`);
  }
  console.log(`    ES spike alone: ${volumeSpikeOutcomes.esSpike.total.toLocaleString()}`);
  if (volumeSpikeOutcomes.esSpike.total > 0) {
    console.log(`      NQ follows within 3 bars: ${(volumeSpikeOutcomes.esSpike.nqFollows / volumeSpikeOutcomes.esSpike.total * 100).toFixed(1)}%`);
  }

  // Volume spike + price divergence
  console.log('\n  Volume spike + price direction:');

  const volPriceLeading = { nqLeads: 0, esLeads: 0, total: 0 };

  for (let i = VOLUME_WINDOW; i < commonTimestamps.length - 5; i++) {
    const nqVolWindow = nqVolumes.slice(i - VOLUME_WINDOW, i);
    const esVolWindow = esVolumes.slice(i - VOLUME_WINDOW, i);

    const nqVolMean = mean(nqVolWindow);
    const esVolMean = mean(esVolWindow);
    const nqVolStd = stddev(nqVolWindow);
    const esVolStd = stddev(esVolWindow);

    if (nqVolStd === 0 || esVolStd === 0) continue;

    const nqVolZ = (nqVolumes[i] - nqVolMean) / nqVolStd;
    const esVolZ = (esVolumes[i] - esVolMean) / esVolStd;

    // One has spike, the other doesn't
    if (nqVolZ > 2 && esVolZ < 1) {
      const ts = commonTimestamps[i];
      const nqNow = nqMap.get(ts);
      const tsPrev = commonTimestamps[i - 1];
      const nqPrev = nqMap.get(tsPrev);

      if (!nqNow || !nqPrev || nqPrev.close === 0) continue;

      const nqDir = nqNow.close > nqPrev.close ? 1 : -1;

      // Does ES follow NQ's direction in next 5 bars?
      let esFollowedDir = false;
      for (let j = 1; j <= 5; j++) {
        if (i + j >= commonTimestamps.length) break;
        const fwdTs = commonTimestamps[i + j];
        const esFwd = esMap.get(fwdTs);
        const esNow = esMap.get(ts);
        if (!esFwd || !esNow || esNow.close === 0) continue;
        const esChange = (esFwd.close - esNow.close) / esNow.close;
        if (nqDir > 0 && esChange > 0.0005) { esFollowedDir = true; break; }
        if (nqDir < 0 && esChange < -0.0005) { esFollowedDir = true; break; }
      }

      if (esFollowedDir) volPriceLeading.nqLeads++;
      volPriceLeading.total++;

    } else if (esVolZ > 2 && nqVolZ < 1) {
      const ts = commonTimestamps[i];
      const esNow = esMap.get(ts);
      const tsPrev = commonTimestamps[i - 1];
      const esPrev = esMap.get(tsPrev);

      if (!esNow || !esPrev || esPrev.close === 0) continue;

      const esDir = esNow.close > esPrev.close ? 1 : -1;

      let nqFollowedDir = false;
      for (let j = 1; j <= 5; j++) {
        if (i + j >= commonTimestamps.length) break;
        const fwdTs = commonTimestamps[i + j];
        const nqFwd = nqMap.get(fwdTs);
        const nqNow = nqMap.get(ts);
        if (!nqFwd || !nqNow || nqNow.close === 0) continue;
        const nqChange = (nqFwd.close - nqNow.close) / nqNow.close;
        if (esDir > 0 && nqChange > 0.0005) { nqFollowedDir = true; break; }
        if (esDir < 0 && nqChange < -0.0005) { nqFollowedDir = true; break; }
      }

      if (nqFollowedDir) volPriceLeading.esLeads++;
      volPriceLeading.total++;
    }
  }

  if (volPriceLeading.total > 0) {
    console.log(`    When NQ has vol spike (ES quiet): ES follows NQ's direction ${(volPriceLeading.nqLeads / (volPriceLeading.nqLeads + (volPriceLeading.total - volPriceLeading.nqLeads - volPriceLeading.esLeads) / 2) * 100).toFixed(1)}% of the time`);
    console.log(`    When ES has vol spike (NQ quiet): NQ follows ES's direction ${(volPriceLeading.esLeads / (volPriceLeading.esLeads + (volPriceLeading.total - volPriceLeading.nqLeads - volPriceLeading.esLeads) / 2) * 100).toFixed(1)}% of the time`);
    console.log(`    Total isolated spike events: ${volPriceLeading.total.toLocaleString()}`);
  }

  return volumeSpikeOutcomes;
}

// ─── Analysis 7: SMT Divergence (Swing High/Low Non-Confirmation) ────────────

function analyzeSMTDivergence(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  7. SMT Divergence (Swing High/Low Non-Confirmation)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Detect swing highs and lows using 5-bar lookback/lookforward
  const SWING_BARS = 5;

  function findSwings(map, timestamps) {
    const swingHighs = [];
    const swingLows = [];

    for (let i = SWING_BARS; i < timestamps.length - SWING_BARS; i++) {
      const ts = timestamps[i];
      const candle = map.get(ts);
      if (!candle) continue;

      // Check for swing high
      let isSwingHigh = true;
      let isSwingLow = true;

      for (let j = 1; j <= SWING_BARS; j++) {
        const before = map.get(timestamps[i - j]);
        const after = map.get(timestamps[i + j]);
        if (!before || !after) { isSwingHigh = false; isSwingLow = false; break; }

        if (candle.high <= before.high || candle.high <= after.high) isSwingHigh = false;
        if (candle.low >= before.low || candle.low >= after.low) isSwingLow = false;
      }

      if (isSwingHigh) swingHighs.push({ timestamp: ts, price: candle.high, idx: i });
      if (isSwingLow) swingLows.push({ timestamp: ts, price: candle.low, idx: i });
    }

    return { swingHighs, swingLows };
  }

  const nqSwings = findSwings(nqMap, commonTimestamps);
  const esSwings = findSwings(esMap, commonTimestamps);

  console.log(`  NQ swing highs: ${nqSwings.swingHighs.length.toLocaleString()}, swing lows: ${nqSwings.swingLows.length.toLocaleString()}`);
  console.log(`  ES swing highs: ${esSwings.swingHighs.length.toLocaleString()}, swing lows: ${esSwings.swingLows.length.toLocaleString()}`);

  // Find SMT divergences: NQ makes new high but ES doesn't (or vice versa)
  const WINDOW_MINUTES = 10;

  const smtBearish = []; // NQ makes higher high, ES makes lower high (or vice versa)
  const smtBullish = []; // NQ makes lower low, ES makes higher low (or vice versa)

  // Compare consecutive swing highs - look for non-confirmation
  for (let i = 1; i < nqSwings.swingHighs.length; i++) {
    const nqCurr = nqSwings.swingHighs[i];
    const nqPrev = nqSwings.swingHighs[i - 1];

    // NQ made a higher high
    if (nqCurr.price > nqPrev.price) {
      // Find ES swing highs near both timestamps
      const esNearCurr = esSwings.swingHighs.filter(s =>
        Math.abs(s.timestamp - nqCurr.timestamp) < WINDOW_MINUTES * 60000
      );
      const esNearPrev = esSwings.swingHighs.filter(s =>
        Math.abs(s.timestamp - nqPrev.timestamp) < WINDOW_MINUTES * 60000
      );

      if (esNearCurr.length > 0 && esNearPrev.length > 0) {
        const esCurrHigh = Math.max(...esNearCurr.map(s => s.price));
        const esPrevHigh = Math.max(...esNearPrev.map(s => s.price));

        // ES made a lower high = bearish SMT divergence
        if (esCurrHigh < esPrevHigh) {
          smtBearish.push({
            timestamp: nqCurr.timestamp,
            nqHighCurr: nqCurr.price,
            nqHighPrev: nqPrev.price,
            esHighCurr: esCurrHigh,
            esHighPrev: esPrevHigh,
            leader: 'NQ_higher_ES_lower'
          });
        }
      }
    }
  }

  // Compare consecutive swing lows
  for (let i = 1; i < nqSwings.swingLows.length; i++) {
    const nqCurr = nqSwings.swingLows[i];
    const nqPrev = nqSwings.swingLows[i - 1];

    // NQ made a lower low
    if (nqCurr.price < nqPrev.price) {
      const esNearCurr = esSwings.swingLows.filter(s =>
        Math.abs(s.timestamp - nqCurr.timestamp) < WINDOW_MINUTES * 60000
      );
      const esNearPrev = esSwings.swingLows.filter(s =>
        Math.abs(s.timestamp - nqPrev.timestamp) < WINDOW_MINUTES * 60000
      );

      if (esNearCurr.length > 0 && esNearPrev.length > 0) {
        const esCurrLow = Math.min(...esNearCurr.map(s => s.price));
        const esPrevLow = Math.min(...esNearPrev.map(s => s.price));

        // ES made a higher low = bullish SMT divergence
        if (esCurrLow > esPrevLow) {
          smtBullish.push({
            timestamp: nqCurr.timestamp,
            nqLowCurr: nqCurr.price,
            nqLowPrev: nqPrev.price,
            esLowCurr: esCurrLow,
            esLowPrev: esPrevLow,
            leader: 'NQ_lower_ES_higher'
          });
        }
      }
    }
  }

  console.log(`\n  SMT Bearish divergences (higher high NQ / lower high ES): ${smtBearish.length}`);
  console.log(`  SMT Bullish divergences (lower low NQ / higher low ES): ${smtBullish.length}`);

  // Evaluate SMT signal outcomes
  const lookforwards = [5, 15, 30, 60];

  for (const type of ['bearish', 'bullish']) {
    const signals = type === 'bearish' ? smtBearish : smtBullish;
    if (signals.length === 0) continue;

    console.log(`\n  ${type.toUpperCase()} SMT Outcomes (NQ points):`);
    console.log('  Fwd  | Win Rate | Avg P&L | Avg Win | Avg Loss | n');
    console.log('  ─────|──────────|─────────|─────────|──────────|─────');

    for (const fwd of lookforwards) {
      let wins = 0, losses = 0;
      const pnls = [];

      for (const sig of signals) {
        const entryTs = sig.timestamp;
        const exitTs = entryTs + fwd * 60000;

        const nqEntry = nqMap.get(entryTs);
        const nqExit = nqMap.get(exitTs);

        if (!nqEntry || !nqExit) continue;

        // Bearish = short NQ, Bullish = long NQ
        const pnl = type === 'bearish'
          ? nqEntry.close - nqExit.close
          : nqExit.close - nqEntry.close;

        pnls.push(pnl);
        if (pnl > 0) wins++;
        else losses++;
      }

      if (pnls.length === 0) continue;

      const winRate = wins / pnls.length;
      const avgPnl = mean(pnls);
      const avgWin = mean(pnls.filter(p => p > 0));
      const avgLoss = mean(pnls.filter(p => p <= 0));

      console.log(`  ${String(fwd).padStart(3)}m | ${(winRate * 100).toFixed(1).padStart(6)}%  | ${avgPnl.toFixed(1).padStart(7)} | ${avgWin.toFixed(1).padStart(7)} | ${avgLoss.toFixed(1).padStart(8)} | ${pnls.length}`);
    }
  }

  // Also check ES-leads-NQ SMT divergences
  const smtBearishES = [];
  const smtBullishES = [];

  for (let i = 1; i < esSwings.swingHighs.length; i++) {
    const esCurr = esSwings.swingHighs[i];
    const esPrev = esSwings.swingHighs[i - 1];

    if (esCurr.price > esPrev.price) {
      const nqNearCurr = nqSwings.swingHighs.filter(s =>
        Math.abs(s.timestamp - esCurr.timestamp) < WINDOW_MINUTES * 60000
      );
      const nqNearPrev = nqSwings.swingHighs.filter(s =>
        Math.abs(s.timestamp - esPrev.timestamp) < WINDOW_MINUTES * 60000
      );

      if (nqNearCurr.length > 0 && nqNearPrev.length > 0) {
        const nqCurrHigh = Math.max(...nqNearCurr.map(s => s.price));
        const nqPrevHigh = Math.max(...nqNearPrev.map(s => s.price));

        if (nqCurrHigh < nqPrevHigh) {
          smtBearishES.push({ timestamp: esCurr.timestamp, leader: 'ES_higher_NQ_lower' });
        }
      }
    }
  }

  for (let i = 1; i < esSwings.swingLows.length; i++) {
    const esCurr = esSwings.swingLows[i];
    const esPrev = esSwings.swingLows[i - 1];

    if (esCurr.price < esPrev.price) {
      const nqNearCurr = nqSwings.swingLows.filter(s =>
        Math.abs(s.timestamp - esCurr.timestamp) < WINDOW_MINUTES * 60000
      );
      const nqNearPrev = nqSwings.swingLows.filter(s =>
        Math.abs(s.timestamp - esPrev.timestamp) < WINDOW_MINUTES * 60000
      );

      if (nqNearCurr.length > 0 && nqNearPrev.length > 0) {
        const nqCurrLow = Math.min(...nqNearCurr.map(s => s.price));
        const nqPrevLow = Math.min(...nqNearPrev.map(s => s.price));

        if (nqCurrLow > nqPrevLow) {
          smtBullishES.push({ timestamp: esCurr.timestamp, leader: 'ES_lower_NQ_higher' });
        }
      }
    }
  }

  console.log(`\n  Reverse SMT (ES leads):`);
  console.log(`    Bearish (ES higher high / NQ lower high): ${smtBearishES.length}`);
  console.log(`    Bullish (ES lower low / NQ higher low): ${smtBullishES.length}`);

  return { smtBearish, smtBullish, smtBearishES, smtBullishES, nqSwings, esSwings };
}

// ─── Analysis 8: Relative Strength Momentum ─────────────────────────────────

function analyzeRelativeStrength(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  8. Relative Strength Momentum');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Does recent relative strength predict future relative strength (momentum)?
  // Or does it mean-revert?
  const FORMATION_PERIODS = [5, 15, 30, 60];
  const HOLDING_PERIODS = [5, 15, 30, 60];

  console.log('  Formation → Holding: r(relative_return_formation, relative_return_holding)');
  console.log('  Positive r = momentum (outperformance continues)');
  console.log('  Negative r = mean reversion (outperformance reverses)\n');

  const header = '  Form\\Hold | ' + HOLDING_PERIODS.map(h => `${h}m`.padStart(8)).join(' | ') + ' |';
  console.log(header);
  console.log('  ' + '─'.repeat(header.length - 2));

  for (const form of FORMATION_PERIODS) {
    const row = [`  ${String(form).padStart(4)}m   |`];

    for (const hold of HOLDING_PERIODS) {
      const formReturns = [];
      const holdReturns = [];

      for (let i = form; i < commonTimestamps.length - hold; i++) {
        const tsNow = commonTimestamps[i];
        const tsFormStart = commonTimestamps[i - form];
        const tsHoldEnd = commonTimestamps[i + hold];

        // Check for session gaps
        if ((tsNow - tsFormStart) > form * 120000) continue;
        if ((tsHoldEnd - tsNow) > hold * 120000) continue;

        const nqNow = nqMap.get(tsNow);
        const nqForm = nqMap.get(tsFormStart);
        const nqHold = nqMap.get(tsHoldEnd);
        const esNow = esMap.get(tsNow);
        const esForm = esMap.get(tsFormStart);
        const esHold = esMap.get(tsHoldEnd);

        if (!nqNow || !nqForm || !nqHold || !esNow || !esForm || !esHold) continue;
        if (nqForm.close === 0 || esForm.close === 0 || nqNow.close === 0 || esNow.close === 0) continue;

        const nqFormReturn = (nqNow.close - nqForm.close) / nqForm.close;
        const esFormReturn = (esNow.close - esForm.close) / esForm.close;
        const relFormReturn = nqFormReturn - esFormReturn;

        const nqHoldReturn = (nqHold.close - nqNow.close) / nqNow.close;
        const esHoldReturn = (esHold.close - esNow.close) / esNow.close;
        const relHoldReturn = nqHoldReturn - esHoldReturn;

        formReturns.push(relFormReturn);
        holdReturns.push(relHoldReturn);
      }

      const corr = pearsonCorrelation(formReturns, holdReturns);
      const marker = corr.r !== null && Math.abs(corr.r) > 0.02 ? (corr.r > 0 ? '+ ' : '- ') : '  ';
      row.push(` ${marker}${corr.r?.toFixed(4) || 'N/A  '} |`);
    }

    console.log(row.join(''));
  }

  // Quintile analysis for 15m formation → 30m holding
  console.log('\n  Quintile analysis: 15m relative strength formation → 30m holding');

  const quintileData = [];
  const form = 15, hold = 30;

  for (let i = form; i < commonTimestamps.length - hold; i++) {
    const tsNow = commonTimestamps[i];
    const tsFormStart = commonTimestamps[i - form];
    const tsHoldEnd = commonTimestamps[i + hold];

    if ((tsNow - tsFormStart) > form * 120000) continue;
    if ((tsHoldEnd - tsNow) > hold * 120000) continue;

    const nqNow = nqMap.get(tsNow);
    const nqForm = nqMap.get(tsFormStart);
    const nqHold = nqMap.get(tsHoldEnd);
    const esNow = esMap.get(tsNow);
    const esForm = esMap.get(tsFormStart);
    const esHold = esMap.get(tsHoldEnd);

    if (!nqNow || !nqForm || !nqHold || !esNow || !esForm || !esHold) continue;
    if (nqForm.close === 0 || esForm.close === 0 || nqNow.close === 0 || esNow.close === 0) continue;

    const relForm = (nqNow.close - nqForm.close) / nqForm.close - (esNow.close - esForm.close) / esForm.close;
    const relHold = (nqHold.close - nqNow.close) / nqNow.close - (esHold.close - esNow.close) / esNow.close;

    quintileData.push({ relForm, relHold });
  }

  if (quintileData.length > 100) {
    quintileData.sort((a, b) => a.relForm - b.relForm);
    const quintileSize = Math.floor(quintileData.length / 5);

    console.log('  Quintile | Avg Formation | Avg Holding | Interpretation');
    console.log('  ─────────|───────────────|─────────────|──────────────────────');

    for (let q = 0; q < 5; q++) {
      const slice = quintileData.slice(q * quintileSize, (q + 1) * quintileSize);
      const avgForm = mean(slice.map(s => s.relForm));
      const avgHold = mean(slice.map(s => s.relHold));

      const label = q === 0 ? 'ES strongest' : q === 4 ? 'NQ strongest' : `Q${q + 1}`;
      const interp = avgHold > 0 ? 'NQ outperforms next' : 'ES outperforms next';

      console.log(`  ${label.padEnd(9)} | ${(avgForm * 10000).toFixed(2).padStart(10)} bps | ${(avgHold * 10000).toFixed(2).padStart(8)} bps | ${interp}`);
    }
  }
}

// ─── Analysis 9: Correlation Regime Changes ──────────────────────────────────

function analyzeCorrelationRegimes(nqMap, esMap, commonTimestamps) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  9. Rolling Correlation & Regime Analysis');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Compute rolling 60-minute correlation
  const ROLLING_WINDOW = 60;
  const rollingCorrs = [];

  // Pre-compute 1m returns
  const returns = [];
  for (let i = 1; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const tsPrev = commonTimestamps[i - 1];

    if ((ts - tsPrev) > 120000) {
      returns.push(null);
      continue;
    }

    const nqNow = nqMap.get(ts);
    const nqPrev = nqMap.get(tsPrev);
    const esNow = esMap.get(ts);
    const esPrev = esMap.get(tsPrev);

    if (!nqNow || !nqPrev || !esNow || !esPrev || nqPrev.close === 0 || esPrev.close === 0) {
      returns.push(null);
      continue;
    }

    returns.push({
      nq: (nqNow.close - nqPrev.close) / nqPrev.close,
      es: (esNow.close - esPrev.close) / esPrev.close,
      ts
    });
  }

  for (let i = ROLLING_WINDOW; i < returns.length; i++) {
    const window = returns.slice(i - ROLLING_WINDOW, i).filter(r => r !== null);
    if (window.length < 30) continue;

    const corr = pearsonCorrelation(window.map(w => w.nq), window.map(w => w.es));
    if (corr.r !== null) {
      rollingCorrs.push({ ts: returns[i]?.ts || 0, r: corr.r });
    }
  }

  const corrValues = rollingCorrs.map(r => r.r);
  // Sort once for all percentile/min/max queries (avoids stack overflow with spread on huge arrays)
  const corrSorted = [...corrValues].sort((a, b) => a - b);

  console.log(`  Rolling ${ROLLING_WINDOW}-minute correlation statistics:`);
  console.log(`    Mean:   ${mean(corrValues).toFixed(4)}`);
  console.log(`    Median: ${corrSorted[Math.floor(corrSorted.length / 2)].toFixed(4)}`);
  console.log(`    StdDev: ${stddev(corrValues).toFixed(4)}`);
  console.log(`    Min:    ${corrSorted[0].toFixed(4)}`);
  console.log(`    Max:    ${corrSorted[corrSorted.length - 1].toFixed(4)}`);
  console.log(`    P5:     ${corrSorted[Math.floor(corrSorted.length * 0.05)].toFixed(4)}`);
  console.log(`    P25:    ${corrSorted[Math.floor(corrSorted.length * 0.25)].toFixed(4)}`);
  console.log(`    P75:    ${corrSorted[Math.floor(corrSorted.length * 0.75)].toFixed(4)}`);
  console.log(`    P95:    ${corrSorted[Math.floor(corrSorted.length * 0.95)].toFixed(4)}`);

  // Distribution
  const bins = [
    { label: 'r < 0 (negative)', min: -1, max: 0 },
    { label: '0 < r < 0.3 (weak)', min: 0, max: 0.3 },
    { label: '0.3 < r < 0.6 (moderate)', min: 0.3, max: 0.6 },
    { label: '0.6 < r < 0.8 (strong)', min: 0.6, max: 0.8 },
    { label: 'r > 0.8 (very strong)', min: 0.8, max: 1.01 },
  ];

  console.log(`\n  Correlation distribution:`);
  for (const bin of bins) {
    const count = corrValues.filter(r => r >= bin.min && r < bin.max).length;
    const pct = (count / corrValues.length * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(pct / 2));
    console.log(`    ${bin.label.padEnd(30)} ${pct.padStart(5)}% ${bar}`);
  }

  // What predicts low correlation periods?
  const lowCorrEvents = rollingCorrs.filter(r => r.r < 0);
  console.log(`\n  Negative correlation events: ${lowCorrEvents.length.toLocaleString()} (${(lowCorrEvents.length / rollingCorrs.length * 100).toFixed(2)}% of time)`);

  // Build a timestamp→index map for fast lookups
  const tsToIdx = new Map();
  for (let i = 0; i < commonTimestamps.length; i++) {
    tsToIdx.set(commonTimestamps[i], i);
  }

  // Are low-correlation periods predictive of anything?
  if (lowCorrEvents.length > 100) {
    const nqVolAfterLowCorr = [];
    const nqVolAfterHighCorr = [];
    const highCorrEvents = rollingCorrs.filter(r => r.r > 0.8);

    for (const event of lowCorrEvents.slice(0, 2000)) {
      const idx = tsToIdx.get(event.ts);
      if (idx === undefined || idx + 30 >= commonTimestamps.length) continue;

      const fwdReturns = [];
      for (let j = 1; j <= 30; j++) {
        const nq1 = nqMap.get(commonTimestamps[idx + j]);
        const nq0 = nqMap.get(commonTimestamps[idx + j - 1]);
        if (nq1 && nq0 && nq0.close > 0) {
          fwdReturns.push((nq1.close - nq0.close) / nq0.close);
        }
      }
      if (fwdReturns.length > 10) nqVolAfterLowCorr.push(stddev(fwdReturns));
    }

    for (const event of highCorrEvents.slice(0, 2000)) {
      const idx = tsToIdx.get(event.ts);
      if (idx === undefined || idx + 30 >= commonTimestamps.length) continue;

      const fwdReturns = [];
      for (let j = 1; j <= 30; j++) {
        const nq1 = nqMap.get(commonTimestamps[idx + j]);
        const nq0 = nqMap.get(commonTimestamps[idx + j - 1]);
        if (nq1 && nq0 && nq0.close > 0) {
          fwdReturns.push((nq1.close - nq0.close) / nq0.close);
        }
      }
      if (fwdReturns.length > 10) nqVolAfterHighCorr.push(stddev(fwdReturns));
    }

    if (nqVolAfterLowCorr.length > 0 && nqVolAfterHighCorr.length > 0) {
      console.log(`  Forward 30m NQ volatility after correlation regime:`);
      console.log(`    After low corr (r<0):   ${(mean(nqVolAfterLowCorr) * 10000).toFixed(2)} bps`);
      console.log(`    After high corr (r>0.8): ${(mean(nqVolAfterHighCorr) * 10000).toFixed(2)} bps`);
      console.log(`    Ratio: ${(mean(nqVolAfterLowCorr) / mean(nqVolAfterHighCorr)).toFixed(2)}x`);
    }
  }

  return { rollingCorrs };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ES-NQ Correlation & Lead-Lag Analysis');
  console.log(`  Date Range: ${START_DATE} to ${END_DATE}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { nqCandles, esCandles, nqMap, esMap, commonTimestamps } = await loadData();

  // Run all analyses
  const { results: corrResults, tradingDates } = analyzeReturnCorrelation(nqMap, esMap, commonTimestamps);
  const leadLagResults = analyzeLeadLag(nqMap, esMap, commonTimestamps);
  analyzeDivergences(nqMap, esMap, commonTimestamps, tradingDates, nqCandles, esCandles);
  analyzeRatio(nqMap, esMap, commonTimestamps, tradingDates, nqCandles, esCandles);
  analyzeSessionCorrelation(nqMap, esMap, commonTimestamps);
  analyzeVolumeLead(nqMap, esMap, commonTimestamps);
  analyzeSMTDivergence(nqMap, esMap, commonTimestamps);
  analyzeRelativeStrength(nqMap, esMap, commonTimestamps);
  analyzeCorrelationRegimes(nqMap, esMap, commonTimestamps);

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY & TRADING IMPLICATIONS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('  Key Findings:');
  console.log(`  1. 1-minute return correlation: ${corrResults['1m']?.correlation?.toFixed(4)}`);
  console.log(`  2. Daily return correlation: ${corrResults['daily']?.correlation?.toFixed(4)}`);
  console.log(`  3. NQ volatility is ${corrResults['1m']?.nqVolRatio?.toFixed(2)}x ES volatility (1m returns)`);

  const peakLag = leadLagResults.results
    .filter(r => r.lag !== 0 && r.correlation !== null)
    .reduce((a, b) => Math.abs(b.correlation) > Math.abs(a.correlation) ? b : a, { correlation: 0 });

  console.log(`  4. Strongest lead-lag: ${peakLag.interpretation} (r=${peakLag.correlation?.toFixed(6)})`);

  console.log('\n  Potential Strategy Ideas:');
  console.log('  - SMT divergence: Trade reversals when NQ/ES swing highs/lows diverge');
  console.log('  - Ratio mean reversion: Fade extreme NQ/ES ratio z-scores');
  console.log('  - Volume lead: Follow the direction of the instrument with volume spike');
  console.log('  - Correlation breakdown: Trade increased volatility when correlation drops');
  console.log('  - Relative strength momentum/reversion: Based on quintile analysis');

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nError:', err.message);
  console.error(err.stack);
  process.exit(1);
});
