#!/usr/bin/env node
/**
 * Profile clean-MAE vs ugly-MAE trades for gex-flip-ivpct.
 *
 * Goal: identify entry-time features that distinguish trades whose MAE stays
 * under a threshold (e.g. 10pt — survivable under a tight stop) from trades
 * that draw down further before resolving. The hope is that some combination
 * of IV / GEX / regime / time-of-day flags the noisy entries before we take
 * them.
 *
 * Usage:
 *   node research/gfi-mae-analysis/profile.js [maeThresholdPt]
 *
 * Default threshold is 10pt.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const MAE_THRESHOLD = parseFloat(process.argv[2] || '10');
const SOURCE = path.join(ROOT, 'data/gold-standard/gex-flip-ivpct-postfix-baseline.json');

const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const trades = raw.trades.filter(t => t.status === 'completed');

// Extract features for every trade
function getETHourMinute(timestamp) {
  const d = new Date(timestamp);
  const fmt = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short'
  });
  // e.g. "Mon 09:30" or "Mon, 09:30"
  const cleaned = fmt.replace(',', '');
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const dow = parts[0];
  const [hRaw, mRaw] = parts[1].split(':');
  const h = parseInt(hRaw, 10) % 24;
  const m = parseInt(mRaw, 10);
  return { hour: h, minute: m, dow, minutesOfDay: h * 60 + m };
}

const enriched = trades.map(t => {
  const sig = t.signal;
  const et = getETHourMinute(t.timestamp);
  const close = sig.price;
  const callWallDist = sig.callWall != null ? Math.abs(close - sig.callWall) : null;
  const putWallDist  = sig.putWall  != null ? Math.abs(close - sig.putWall)  : null;
  const gammaFlipDist= sig.gammaFlip!= null ? Math.abs(close - sig.gammaFlip): null;
  const aboveFlip    = sig.gammaFlip!= null ? (close - sig.gammaFlip) > 0    : null;

  // IV features (entry)
  const iv = sig.ivValue;
  const ivPct = sig.ivPercentile;
  const skew = sig.ivSkew;
  const regime = sig.gexRegime;
  const ruleId = sig.ruleId;
  const side = t.side;

  // Outcome features
  const mae = t.maePoints;
  const mfe = t.mfePoints;
  const pointsPnL = t.pointsPnL;
  const isWinner = pointsPnL > 0;
  const isClean = mae <= MAE_THRESHOLD;

  return {
    id: t.id,
    timestamp: t.timestamp,
    ruleId, side,
    iv, ivPct, skew, regime,
    callWallDist, putWallDist, gammaFlipDist, aboveFlip,
    hour: et.hour, minute: et.minute, dow: et.dow, minutesOfDay: et.minutesOfDay,
    mae, mfe, pointsPnL, isWinner, isClean,
    entryPrice: close,
    stopPts: sig.stopPoints,
    targetPts: sig.targetPoints,
  };
});

const clean = enriched.filter(e => e.isClean);
const ugly = enriched.filter(e => !e.isClean);

console.log(`\n=== MAE threshold: ${MAE_THRESHOLD}pt ===`);
console.log(`Clean trades (MAE <= ${MAE_THRESHOLD}pt): ${clean.length}/${enriched.length} (${(100*clean.length/enriched.length).toFixed(1)}%)`);
console.log(`Ugly trades  (MAE > ${MAE_THRESHOLD}pt):  ${ugly.length}/${enriched.length} (${(100*ugly.length/enriched.length).toFixed(1)}%)`);
console.log();
console.log(`Clean: WR=${pct(clean.filter(e=>e.isWinner).length/clean.length)}, avgMFE=${avg(clean.map(e=>e.mfe)).toFixed(1)}pt, avgMAE=${avg(clean.map(e=>e.mae)).toFixed(1)}pt`);
console.log(`Ugly:  WR=${pct(ugly.filter(e=>e.isWinner).length/ugly.length)}, avgMFE=${avg(ugly.map(e=>e.mfe)).toFixed(1)}pt, avgMAE=${avg(ugly.map(e=>e.mae)).toFixed(1)}pt`);

// Categorical comparisons
function categoricalCompare(name, getter) {
  console.log(`\n=== ${name} ===`);
  const cleanCounts = {}, uglyCounts = {};
  for (const e of clean) { const k = getter(e); cleanCounts[k] = (cleanCounts[k]||0)+1; }
  for (const e of ugly)  { const k = getter(e); uglyCounts[k]  = (uglyCounts[k] ||0)+1; }
  const keys = [...new Set([...Object.keys(cleanCounts), ...Object.keys(uglyCounts)])].sort();
  console.log(`  ${pad('key', 18)} ${pad('clean', 8)} ${pad('clean%', 8)} ${pad('ugly', 8)} ${pad('ugly%', 8)} ${pad('cleanRate', 12)}`);
  for (const k of keys) {
    const c = cleanCounts[k] || 0;
    const u = uglyCounts[k]  || 0;
    const total = c + u;
    const cleanRate = total > 0 ? c / total : 0;
    console.log(`  ${pad(k, 18)} ${pad(c, 8)} ${pad(pct(c/clean.length), 8)} ${pad(u, 8)} ${pad(pct(u/ugly.length), 8)} ${pad(pct(cleanRate), 12)}`);
  }
}

// Numeric comparisons: percentile table
function numericCompare(name, getter, options = {}) {
  console.log(`\n=== ${name} ===`);
  const cleanVals = clean.map(getter).filter(v => v != null && !isNaN(v)).sort((a,b)=>a-b);
  const uglyVals  = ugly.map(getter).filter(v => v != null && !isNaN(v)).sort((a,b)=>a-b);
  if (cleanVals.length === 0 && uglyVals.length === 0) { console.log('  (no data)'); return; }

  const pcts = [0, 10, 25, 50, 75, 90, 100];
  console.log(`  ${pad('pct', 6)} ${pad('clean', 12)} ${pad('ugly', 12)} ${pad('Δ(ugly-clean)', 14)}`);
  for (const p of pcts) {
    const cv = percentile(cleanVals, p);
    const uv = percentile(uglyVals, p);
    const fmt = options.fmt || (v => v?.toFixed(3) ?? 'NaN');
    console.log(`  ${pad('p' + p, 6)} ${pad(fmt(cv), 12)} ${pad(fmt(uv), 12)} ${pad(fmt(uv - cv), 14)}`);
  }
  const cleanMean = avg(cleanVals);
  const uglyMean = avg(uglyVals);
  console.log(`  ${pad('mean', 6)} ${pad((options.fmt || (v=>v.toFixed(3)))(cleanMean), 12)} ${pad((options.fmt || (v=>v.toFixed(3)))(uglyMean), 12)}`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const idx = (sorted.length - 1) * p / 100;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : NaN; }
function pct(v) { return (100*v).toFixed(1) + '%'; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

// Run comparisons
categoricalCompare('Rule ID', e => e.ruleId);
categoricalCompare('Side', e => e.side);
categoricalCompare('Regime', e => e.regime || '(none)');
categoricalCompare('Above gamma flip', e => e.aboveFlip == null ? '(none)' : (e.aboveFlip ? 'above' : 'below'));
categoricalCompare('ET hour', e => String(e.hour).padStart(2, '0'));
categoricalCompare('Day of week', e => e.dow);

console.log('\n--- Numeric features ---');
numericCompare('IV value', e => e.iv, { fmt: v => (v*100).toFixed(2) + '%' });
numericCompare('IV percentile', e => e.ivPct, { fmt: v => v.toFixed(3) });
numericCompare('IV skew', e => e.skew, { fmt: v => v.toFixed(4) });
numericCompare('Call wall distance (pt)', e => e.callWallDist, { fmt: v => v?.toFixed(1) ?? 'NaN' });
numericCompare('Put wall distance (pt)', e => e.putWallDist,   { fmt: v => v?.toFixed(1) ?? 'NaN' });
numericCompare('Gamma flip distance (pt)', e => e.gammaFlipDist, { fmt: v => v?.toFixed(1) ?? 'NaN' });

// Save enriched table for downstream filter testing
const outPath = path.join(__dirname, 'enriched-trades.json');
fs.writeFileSync(outPath, JSON.stringify({
  source: path.basename(SOURCE),
  maeThreshold: MAE_THRESHOLD,
  totalTrades: enriched.length,
  cleanCount: clean.length,
  uglyCount: ugly.length,
  trades: enriched,
}, null, 2));
console.log(`\nEnriched table written to ${path.relative(ROOT, outPath)}`);
