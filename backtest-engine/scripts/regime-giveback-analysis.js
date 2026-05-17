#!/usr/bin/env node
/**
 * Regime-conditional giveback analysis for gex-flip-ivpct baseline.
 *
 * Buckets the 172 baseline (BE 70/+5) gold-standard trades by:
 *   - gexRegime (positive/negative/strong_positive/strong_negative)
 *   - ivPercentile (low <0.33, mid, high >0.66)
 *   - ivSkew (negative <-0.005, neutral, positive >+0.005)
 *   - side (long/short)
 *   - ruleId (L1-L4, S1-S4 etc)
 *   - time-of-day (premarket / RTH-open / RTH-mid / RTH-close)
 *
 * Computes per bucket:
 *   - n
 *   - winRate
 *   - avgPnLpts
 *   - avgMFE (winners only)
 *   - avgGiveback (winners only, mfe - pnl)
 *   - bigGivebackRate (% with mfe>=100 and pnl<30)
 *   - mfeToSLRate (% with mfe>=50 and pnl<-50)
 *   - captureRatio (sum pnl / sum mfe for winners)
 *
 * If a bucket's giveback or bigGivebackRate diverges materially from the
 * grand mean, that's signal for a regime-conditional fib config.
 *
 * Run:
 *   node scripts/regime-giveback-analysis.js
 */

import fs from 'fs';
import path from 'path';

const GOLD = '/home/drew/projects/slingshot-services/backtest-engine/data/gold-standard/gex-flip-ivpct-tight-s60t200be70.json';
const trades = JSON.parse(fs.readFileSync(GOLD, 'utf8')).trades;

const PT_DOLLARS = 20;
const BIG_GIVEBACK_MFE = 100;
const BIG_GIVEBACK_EXIT = 30;
const MFE_SL_MFE = 50;
const MFE_SL_EXIT = -50;

function classifyTime(ts) {
  const d = new Date(ts);
  // Convert UTC to ET (UTC-4 for now, but ET data is already in ms)
  // Use UTC hour and shift by 4 to approximate ET (we don't need precision)
  const etH = (d.getUTCHours() - 4 + 24) % 24;
  if (etH >= 4 && etH < 9) return 'premarket';
  if (etH >= 9 && etH < 11) return 'rth-open';
  if (etH >= 11 && etH < 14) return 'rth-mid';
  if (etH >= 14 && etH < 17) return 'rth-close';
  return 'overnight';
}

function classifyIVPct(p) {
  if (p == null) return 'unknown';
  if (p < 0.33) return 'low';
  if (p < 0.67) return 'mid';
  return 'high';
}

function classifyIVSkew(s) {
  if (s == null) return 'unknown';
  if (s < -0.005) return 'neg';
  if (s > 0.005) return 'pos';
  return 'neutral';
}

function bucketStats(label, items) {
  const n = items.length;
  if (n === 0) return null;
  const wins = items.filter(t => t.pointsPnL > 0);
  const losses = items.filter(t => t.pointsPnL <= 0);
  const sumPnL = items.reduce((a, t) => a + t.pointsPnL, 0);
  const sumWinMFE = wins.reduce((a, t) => a + (t.mfePoints || 0), 0);
  const sumWinPnL = wins.reduce((a, t) => a + t.pointsPnL, 0);
  const sumGiveback = wins.reduce((a, t) => a + ((t.mfePoints || 0) - t.pointsPnL), 0);
  const bigGB = items.filter(t => (t.mfePoints || 0) >= BIG_GIVEBACK_MFE && t.pointsPnL < BIG_GIVEBACK_EXIT).length;
  const mfeSL = items.filter(t => (t.mfePoints || 0) >= MFE_SL_MFE && t.pointsPnL < MFE_SL_EXIT).length;
  return {
    label,
    n,
    winRate: (wins.length / n * 100).toFixed(1),
    avgPnL: (sumPnL / n).toFixed(1),
    avgWinPnL: wins.length ? (sumWinPnL / wins.length).toFixed(1) : '-',
    avgWinMFE: wins.length ? (sumWinMFE / wins.length).toFixed(1) : '-',
    avgGiveback: wins.length ? (sumGiveback / wins.length).toFixed(1) : '-',
    captureRatio: sumWinMFE > 0 ? (sumWinPnL / sumWinMFE * 100).toFixed(1) : '-',
    bigGBcount: bigGB,
    bigGBpct: (bigGB / n * 100).toFixed(1),
    mfeSLcount: mfeSL,
    mfeSLpct: (mfeSL / n * 100).toFixed(1),
    totalDollars: (sumPnL * PT_DOLLARS).toFixed(0),
  };
}

function tabulate(title, buckets) {
  console.log('\n=== ' + title + ' ===');
  console.log('bucket           n   win%   avgPnL  avgWin  avgMFE  avgGB  cap%  bigGB#  bigGB%  mfeSL#  mfeSL%  total$');
  console.log('-'.repeat(110));
  for (const b of buckets) {
    if (!b) continue;
    console.log(
      String(b.label).padEnd(15) +
      String(b.n).padStart(5) +
      String(b.winRate).padStart(7) +
      String(b.avgPnL).padStart(8) +
      String(b.avgWinPnL).padStart(8) +
      String(b.avgWinMFE).padStart(8) +
      String(b.avgGiveback).padStart(7) +
      String(b.captureRatio).padStart(6) +
      String(b.bigGBcount).padStart(7) +
      String(b.bigGBpct).padStart(7) +
      String(b.mfeSLcount).padStart(7) +
      String(b.mfeSLpct).padStart(7) +
      String(b.totalDollars).padStart(9)
    );
  }
}

// Grand mean
const all = bucketStats('ALL', trades);
console.log('Baseline (172 trades) grand mean:');
console.log(`  winRate=${all.winRate}% avgPnL=${all.avgPnL}pts avgWinMFE=${all.avgWinMFE} avgGiveback=${all.avgGiveback}pts capture=${all.captureRatio}% bigGB%=${all.bigGBpct} mfeSL%=${all.mfeSLpct} total$=${all.totalDollars}`);

// By gexRegime
const regimes = {};
for (const t of trades) {
  const r = t.signal?.gexRegime || 'unknown';
  (regimes[r] = regimes[r] || []).push(t);
}
tabulate('by gexRegime', Object.entries(regimes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => bucketStats(k, v)));

// By ivPercentile
const ivp = { low: [], mid: [], high: [], unknown: [] };
for (const t of trades) ivp[classifyIVPct(t.signal?.ivPercentile)].push(t);
tabulate('by ivPercentile', ['low', 'mid', 'high', 'unknown'].map(k => bucketStats(k, ivp[k])));

// By ivSkew (use absolute value of skew, not the raw value; the strategy already filters on skew direction)
const ivs = { neg: [], neutral: [], pos: [], unknown: [] };
for (const t of trades) ivs[classifyIVSkew(t.signal?.ivSkew)].push(t);
tabulate('by ivSkew', ['neg', 'neutral', 'pos', 'unknown'].map(k => bucketStats(k, ivs[k])));

// By side
const sides = { long: [], short: [] };
for (const t of trades) (sides[t.side] = sides[t.side] || []).push(t);
tabulate('by side', Object.entries(sides).map(([k, v]) => bucketStats(k, v)));

// By ruleId
const rules = {};
for (const t of trades) {
  const r = t.signal?.ruleId || 'unknown';
  (rules[r] = rules[r] || []).push(t);
}
tabulate('by ruleId', Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => bucketStats(k, v)));

// By time-of-day
const tod = {};
for (const t of trades) {
  const k = classifyTime(t.entryTime);
  (tod[k] = tod[k] || []).push(t);
}
tabulate('by time-of-day (ET-ish)', ['premarket', 'rth-open', 'rth-mid', 'rth-close', 'overnight'].map(k => bucketStats(k, tod[k] || [])));

// Cross: gexRegime × ivPercentile
console.log('\n=== Cross: gexRegime × ivPercentile ===');
const cross = {};
for (const t of trades) {
  const r = t.signal?.gexRegime || 'unknown';
  const p = classifyIVPct(t.signal?.ivPercentile);
  const k = `${r}/${p}`;
  (cross[k] = cross[k] || []).push(t);
}
tabulate('cross', Object.entries(cross).sort().filter(([k, v]) => v.length >= 5).map(([k, v]) => bucketStats(k, v)));

// Spread diagnostic
console.log('\n=== Divergence diagnostics ===');
function divergence(label, buckets, key) {
  const vals = buckets.filter(b => b && b[key] !== '-').map(b => parseFloat(b[key]));
  if (vals.length < 2) return;
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const spread = mx - mn;
  const grand = parseFloat(all[key]);
  console.log(`  ${label} ${key}: range [${mn.toFixed(1)}, ${mx.toFixed(1)}], spread=${spread.toFixed(1)}, grandMean=${grand.toFixed(1)}`);
}

const allRegime = Object.entries(regimes).map(([k, v]) => bucketStats(k, v));
const allIVP = ['low', 'mid', 'high'].map(k => bucketStats(k, ivp[k])).filter(b => b);
const allSide = Object.entries(sides).map(([k, v]) => bucketStats(k, v));

for (const key of ['avgGiveback', 'bigGBpct', 'mfeSLpct', 'captureRatio']) {
  divergence('gexRegime', allRegime, key);
  divergence('ivPercentile', allIVP, key);
  divergence('side', allSide, key);
  console.log('');
}
