#!/usr/bin/env node
/**
 * Separation analysis: for trades that reached MFE >= 100, what features
 * separate the ones that ran to TP from the ones that got BE-clipped?
 *
 * Walks 1m OHLCV bars between entry and exit for each MFE>=100 trade and
 * computes velocity / time-to-MFE / wave-back depth / IV-shift features.
 *
 * Buckets trades by outcome:
 *   - tp_runner: pointsPnL >= 150 (essentially reached TP)
 *   - captured: 60 <= pointsPnL < 150
 *   - be_clipped: 0 < pointsPnL < 60
 *   - mfe_to_sl: pointsPnL <= 0
 *
 * For each bucket, reports per-feature mean/median to spot signal.
 *
 * Run:
 *   node scripts/separation-analysis.js
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const GOLD_PATH = path.join(REPO_ROOT, 'data', 'gold-standard', 'gex-flip-ivpct-tight-s60t200be70.json');
const OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');

const MFE_THRESHOLD = 100;

const gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8'));
const candidates = gold.trades.filter(t => t.mfePoints >= MFE_THRESHOLD);
console.log(`Trades with MFE >= ${MFE_THRESHOLD}: ${candidates.length} of ${gold.trades.length}`);

const tMin = Math.min(...candidates.map(t => t.entryTime));
const tMax = Math.max(...candidates.map(t => t.exitTime));
const lowerMs = tMin - 60_000;
const upperMs = tMax + 60_000;

console.log(`Loading primary 1m OHLCV from ${new Date(lowerMs).toISOString()} → ${new Date(upperMs).toISOString()}…`);

async function loadPrimaryBars() {
  const hourVolumes = new Map();
  const allBars = [];
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(OHLCV_PATH), crlfDelay: Infinity });
    let header = null;
    rl.on('line', (line) => {
      if (!header) { header = line.split(','); return; }
      const parts = line.split(',');
      if (parts.length < 10) return;
      const symbol = parts[9];
      if (symbol.includes('-')) return;
      const ts = Date.parse(parts[0]);
      if (Number.isNaN(ts) || ts < lowerMs || ts > upperMs) return;
      allBars.push({
        ts,
        open: +parts[4], high: +parts[5], low: +parts[6], close: +parts[7],
        volume: +parts[8], symbol,
      });
      const hk = Math.floor(ts / 3_600_000);
      if (!hourVolumes.has(hk)) hourVolumes.set(hk, new Map());
      const m = hourVolumes.get(hk);
      m.set(symbol, (m.get(symbol) || 0) + (+parts[8] || 0));
    });
    rl.on('error', reject);
    rl.on('close', resolve);
  });

  const primary = new Map();
  for (const [hk, m] of hourVolumes.entries()) {
    let best = '', bv = -1;
    for (const [s, v] of m.entries()) if (v > bv) { bv = v; best = s; }
    primary.set(hk, best);
  }
  return allBars
    .filter(b => primary.get(Math.floor(b.ts / 3_600_000)) === b.symbol)
    .sort((a, b) => a.ts - b.ts);
}

function classifyTrade(trade, bars) {
  const entry = trade.actualEntry;
  const isShort = trade.side === 'short';
  const barFavPeak = (b) => isShort ? entry - b.low : b.high - entry;
  const barFavMin = (b) => isShort ? entry - b.high : b.low - entry;

  const tradeBars = bars.filter(b => b.ts >= trade.entryTime && b.ts <= trade.exitTime + 60_000);
  if (tradeBars.length === 0) return null;

  // Find time-to-MFE thresholds
  let timeTo50 = null, timeTo100 = null, peakMFE = 0, peakBarIdx = -1;
  for (let i = 0; i < tradeBars.length; i++) {
    const m = barFavPeak(tradeBars[i]);
    if (timeTo50 === null && m >= 50) timeTo50 = i;
    if (timeTo100 === null && m >= 100) timeTo100 = i;
    if (m > peakMFE) { peakMFE = m; peakBarIdx = i; }
  }

  // After peak, deepest retrace
  let postRetraceMin = peakMFE;
  let postRetraceMinBarIdx = peakBarIdx;
  for (let i = peakBarIdx + 1; i < tradeBars.length; i++) {
    const m = barFavMin(tradeBars[i]);
    if (m < postRetraceMin) {
      postRetraceMin = m;
      postRetraceMinBarIdx = i;
    }
  }

  // IV trajectory: max IV during trade vs entry IV
  const entryIV = trade._entryIV?.iv ?? trade.entryIV?.iv ?? null;
  let maxIVduringTrade = entryIV, minIVduringTrade = entryIV;
  for (const h of trade.ivHistory || []) {
    if (h.iv > maxIVduringTrade) maxIVduringTrade = h.iv;
    if (h.iv < minIVduringTrade) minIVduringTrade = h.iv;
  }
  const ivRangeDuringTrade = entryIV ? (maxIVduringTrade - minIVduringTrade) : null;
  const ivLiftFromEntry = entryIV ? (maxIVduringTrade - entryIV) : null;

  // Velocity
  const peakVelocityPtsPerMin = peakBarIdx > 0 ? (peakMFE / peakBarIdx) : null;
  const to100VelocityPtsPerMin = timeTo100 != null && timeTo100 > 0 ? (100 / timeTo100) : null;

  return {
    timeTo50,                 // bars from entry to MFE>=50
    timeTo100,                // bars from entry to MFE>=100
    peakMFE,                  // actual peak MFE
    peakBarIdx,               // bar index of peak
    barsToReversal: postRetraceMinBarIdx - peakBarIdx,
    deepestRetraceFromPeak: peakMFE - postRetraceMin,
    postRetraceMin,           // worst favorable P&L after peak (closest to entry)
    durationBars: tradeBars.length,
    peakVelocityPtsPerMin,
    to100VelocityPtsPerMin,
    entryIV,
    maxIVduringTrade,
    minIVduringTrade,
    ivRangeDuringTrade,
    ivLiftFromEntry,
  };
}

function bucketOutcome(pointsPnL) {
  if (pointsPnL <= 0) return 'mfe_to_sl';
  if (pointsPnL < 60) return 'be_clipped';
  if (pointsPnL < 150) return 'captured';
  return 'tp_runner';
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].filter(v => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  return s.length % 2 === 0 ? (s[s.length/2-1] + s[s.length/2])/2 : s[Math.floor(s.length/2)];
}
function mean(arr) {
  const v = arr.filter(v => v != null && !Number.isNaN(v));
  if (v.length === 0) return null;
  return v.reduce((a,b)=>a+b,0)/v.length;
}

(async () => {
  const bars = await loadPrimaryBars();
  console.log(`Loaded ${bars.length} primary 1m bars\n`);

  const enriched = [];
  for (const t of candidates) {
    const c = classifyTrade(t, bars);
    if (!c) continue;
    enriched.push({
      trade: t,
      outcome: bucketOutcome(t.pointsPnL),
      pnL: t.pointsPnL,
      mfe: t.mfePoints,
      mae: t.maePoints,
      duration_min: Math.round((t.exitTime - t.entryTime) / 60_000),
      ruleId: t.signal?.ruleId,
      side: t.side,
      gexRegime: t.signal?.gexRegime,
      ivPercentile: t.signal?.ivPercentile,
      ivSkew: t.signal?.ivSkew,
      ...c,
    });
  }
  console.log(`Enriched ${enriched.length} trades with intra-trade features\n`);

  const buckets = {
    tp_runner: enriched.filter(e => e.outcome === 'tp_runner'),
    captured:  enriched.filter(e => e.outcome === 'captured'),
    be_clipped: enriched.filter(e => e.outcome === 'be_clipped'),
    mfe_to_sl: enriched.filter(e => e.outcome === 'mfe_to_sl'),
  };

  console.log('=== Outcome distribution (trades with MFE >= 100) ===');
  for (const [k, v] of Object.entries(buckets)) {
    const avgPnL = mean(v.map(e => e.pnL));
    const avgMFE = mean(v.map(e => e.mfe));
    console.log(`  ${k.padEnd(11)} n=${String(v.length).padStart(3)} avgPnL=${(avgPnL||0).toFixed(0).padStart(5)} avgMFE=${(avgMFE||0).toFixed(0)}`);
  }

  function reportFeature(label, key, fmt = '.1f') {
    console.log(`\n=== ${label} (key: ${key}) ===`);
    console.log('bucket        n   mean   median  min    max');
    console.log('-'.repeat(55));
    for (const [bn, items] of Object.entries(buckets)) {
      const vals = items.map(e => e[key]).filter(v => v != null && !Number.isNaN(v));
      if (vals.length === 0) { console.log(`  ${bn.padEnd(12)} n=${items.length} [no data]`); continue; }
      const fmtFn = (v) => fmt === '.3f' ? v.toFixed(3) : v.toFixed(1);
      console.log(
        `${bn.padEnd(12)} ${String(vals.length).padStart(3)}  ` +
        `${fmtFn(mean(vals)).padStart(6)}  ${fmtFn(median(vals)).padStart(6)}  ` +
        `${fmtFn(Math.min(...vals)).padStart(5)}  ${fmtFn(Math.max(...vals)).padStart(5)}`
      );
    }
  }

  reportFeature('Time-to-MFE-100 (1m bars)', 'timeTo100');
  reportFeature('Time-to-MFE-50 (1m bars)', 'timeTo50');
  reportFeature('Velocity to MFE-100 (pts/min)', 'to100VelocityPtsPerMin');
  reportFeature('Peak velocity (pts/min)', 'peakVelocityPtsPerMin');
  reportFeature('MAE pts (depth of adverse before MFE)', 'mae');
  reportFeature('Bars to first reversal after peak', 'barsToReversal');
  reportFeature('IV range during trade', 'ivRangeDuringTrade', '.3f');
  reportFeature('IV lift from entry to max', 'ivLiftFromEntry', '.3f');
  reportFeature('Trade duration (min)', 'duration_min');

  // Categorical: ruleId distribution per bucket
  console.log('\n=== ruleId distribution per outcome ===');
  const allRules = [...new Set(enriched.map(e => e.ruleId))].sort();
  console.log('rule     ' + Object.keys(buckets).map(k => k.padEnd(11)).join(''));
  for (const r of allRules) {
    const row = Object.values(buckets).map(items => {
      const n = items.filter(e => e.ruleId === r).length;
      return `${n}/${items.length}`.padEnd(11);
    }).join('');
    console.log(`${r.padEnd(9)}${row}`);
  }

  console.log('\n=== ivPercentile distribution per outcome ===');
  function classifyIVPct(p) {
    if (p == null) return 'unknown';
    if (p < 0.33) return 'low';
    if (p < 0.67) return 'mid';
    return 'high';
  }
  console.log('ivPct    ' + Object.keys(buckets).map(k => k.padEnd(11)).join(''));
  for (const ivBucket of ['low', 'mid', 'high']) {
    const row = Object.values(buckets).map(items => {
      const n = items.filter(e => classifyIVPct(e.ivPercentile) === ivBucket).length;
      return `${n}/${items.length}`.padEnd(11);
    }).join('');
    console.log(`${ivBucket.padEnd(9)}${row}`);
  }

  console.log('\n=== gexRegime distribution per outcome ===');
  const allRegimes = [...new Set(enriched.map(e => e.gexRegime))].sort();
  console.log('regime           ' + Object.keys(buckets).map(k => k.padEnd(11)).join(''));
  for (const r of allRegimes) {
    const row = Object.values(buckets).map(items => {
      const n = items.filter(e => e.gexRegime === r).length;
      return `${n}/${items.length}`.padEnd(11);
    }).join('');
    console.log(`${(r||'-').padEnd(17)}${row}`);
  }

  // Output enriched data as JSON for further analysis
  fs.writeFileSync(
    path.join(REPO_ROOT, 'research', 'mfe-ratchet-gfi', 'separation-enriched.json'),
    JSON.stringify(enriched.map(({trade, ...rest}) => ({tradeId: trade.id, ...rest})), null, 2)
  );
  console.log(`\nEnriched data: research/mfe-ratchet-gfi/separation-enriched.json`);
})().catch(e => { console.error(e); process.exit(1); });
