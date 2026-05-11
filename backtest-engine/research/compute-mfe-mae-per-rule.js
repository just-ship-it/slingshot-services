#!/usr/bin/env node
/**
 * Compute true (unclipped) MFE/MAE distributions per GEX-FLIP-IVPCT rule.
 *
 * Input: baseline trades JSON (output of gold-standard backtest, post-fix)
 * Output: per-rule MFE/MAE percentile table -> stdout, optional CSV via --csv
 *
 * For each trade, walks NQ raw 1m candles starting from entry timestamp
 * forward through min(maxHoldBars minutes, EOD cutoff 16:40 ET, end of day)
 * and computes the maximum favorable / adverse excursion in points.
 *
 * Uses the same filterPrimaryContract() routine the engine uses, so results
 * match what the engine sees during simulation.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const tradesPath = args[0] || '/tmp/gfi-baseline.json';
const csvOut = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : null;

// ---- helpers ----
function quantile(arr, q) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function median(arr) { return quantile(arr, 0.5); }
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ET hour-of-day for a timestamp (number, ms)
function getETMinutes(ts) {
  const d = new Date(ts);
  const parts = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // parts is "HH:MM"
  const [h, m] = parts.split(':').map(Number);
  return h * 60 + m;
}

// Day boundary for "16:40 ET cutoff" — return the timestamp at 16:40 ET on
// the same trading day that the entry belongs to.
function eodCutoffMs(entryTs) {
  // Find 16:40 ET on the same calendar day as entry. We do this by walking
  // minute-by-minute up to a max of 24h from entry. To avoid that being
  // expensive, just compute via calendar-aware string formatting.
  const entryDate = new Date(entryTs);
  const ymd = entryDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // "YYYY-MM-DD"
  const [y, mo, da] = ymd.split('-').map(Number);
  // Construct 16:40 ET on (y, mo, da). DST varies, so use formatToParts trick:
  // approximate by computing offset from a known noon-ET timestamp on that day.
  const noonEtMs = Date.UTC(y, mo - 1, da, 17, 0, 0); // 12:00 ET ~= 17:00 UTC (winter) or 16:00 UTC (DST)
  // Adjust by the offset between UTC representation and what 12:00 ET actually maps to.
  // Easier: walk: build ISO at 16:40 local-naive then offset to UTC by subtracting 4 or 5h.
  // We'll just iterate: try -4h first; if the hour of toLocaleString shows 16 ET, use it.
  for (const offsetH of [4, 5]) {
    const candidate = Date.UTC(y, mo - 1, da, 16 + offsetH, 40, 0);
    const probe = new Date(candidate).toLocaleString('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    if (probe === '16:40') return candidate;
  }
  // fallback
  return Date.UTC(y, mo - 1, da, 21, 40, 0);
}

// ---- load engine config + OHLCV ----
const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/default.json'), 'utf8'));
cfg.dataDir = path.join(REPO_ROOT, 'data');

const trades = JSON.parse(fs.readFileSync(tradesPath, 'utf8')).trades;
console.log(`Loaded ${trades.length} trades from ${tradesPath}`);

if (!trades.length) process.exit(0);

// figure out date range
const minTs = Math.min(...trades.map(t => new Date(t.entryTime || t.timestamp).getTime()));
const maxTs = Math.max(...trades.map(t => new Date(t.exitTime || t.entryTime || t.timestamp).getTime()));
const startDate = new Date(minTs - 24 * 3600 * 1000);
const endDate = new Date(maxTs + 24 * 3600 * 1000);
console.log(`Date range: ${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`);

const loader = new CSVLoader(cfg.dataDir, cfg, { noContinuous: true });
const { candles } = await loader.loadOHLCVData('NQ', startDate, endDate);
console.log(`Loaded ${candles.length} primary-contract 1m candles`);

// build a sorted index for fast lookup by timestamp
// candles already sorted ascending. binary search by timestamp.
function findFirstAt(ts) {
  let lo = 0, hi = candles.length - 1, found = candles.length;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (candles[m].timestamp >= ts) { found = m; hi = m - 1; }
    else lo = m + 1;
  }
  return found;
}

// ---- compute per-trade MFE/MAE ----
const enriched = [];
for (const t of trades) {
  const ruleId = t.signal?.ruleId || 'UNKNOWN';
  const side = t.side; // 'long' | 'short'
  const entryTime = new Date(t.entryTime || t.actualEntry || t.timestamp).getTime();
  const entryPrice = t.entryPrice || t.actualEntry?.price;
  const maxHoldBars = t.maxHoldBars || 600;
  if (!entryPrice || !entryTime) continue;

  // Window: [entryTime, entryTime + maxHoldBars*60s] ∩ [entryTime, eodCutoff]
  const eod = eodCutoffMs(entryTime);
  const windowEnd = Math.min(entryTime + maxHoldBars * 60_000, eod);

  // Walk candles from entry forward until windowEnd
  let i = findFirstAt(entryTime);
  // Track contract symbol; if it changes mid-trade, halt (engine would force-close)
  let entrySym = null;
  let mfe = 0, mae = 0;
  let bars = 0;

  for (; i < candles.length; i++) {
    const c = candles[i];
    if (c.timestamp > windowEnd) break;
    if (entrySym == null) entrySym = c.symbol;
    if (c.symbol !== entrySym) break; // contract rolled mid-trade

    if (side === 'long') {
      const fav = c.high - entryPrice;
      const adv = entryPrice - c.low;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
    } else {
      const fav = entryPrice - c.low;
      const adv = c.high - entryPrice;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
    }
    bars++;
  }

  enriched.push({
    ruleId,
    side,
    entryTime,
    entryPrice,
    pnlPoints: t.pointsPnL || ((t.netPnL || 0) / 20),
    maxHoldBars,
    bars,
    mfe: Math.round(mfe * 100) / 100,
    mae: Math.round(mae * 100) / 100,
    exitReason: t.exitReason,
    currentStop: t.signal?.stopPoints,
    currentTarget: t.signal?.targetPoints,
  });
}

console.log(`\nProcessed ${enriched.length} trades through MFE/MAE walk`);

// ---- aggregate per rule ----
const byRule = {};
for (const r of enriched) {
  if (!byRule[r.ruleId]) byRule[r.ruleId] = [];
  byRule[r.ruleId].push(r);
}

const ruleOrder = ['L1', 'L4', 'L3', 'S3', 'S1', 'S2'];

console.log('\n===== Per-rule MFE/MAE diagnostics =====\n');
console.log(
  ['rule', 'n', 'curStop', 'curTgt',
   'p50_MAE', 'p75_MAE', 'p80_MAE', 'p90_MAE',
   'p50_MFE', 'p60_MFE', 'p75_MFE',
   'med_winMFE', 'mean_MFE', 'mean_MAE'
  ].map(s => s.padStart(10)).join(' ')
);

const rows = {};
for (const id of ruleOrder.concat(Object.keys(byRule).filter(k => !ruleOrder.includes(k)))) {
  const arr = byRule[id] || [];
  if (arr.length === 0) continue;
  const maes = arr.map(t => t.mae);
  const mfes = arr.map(t => t.mfe);
  const winners = arr.filter(t => t.mfe > t.mae);
  const winMfes = winners.map(t => t.mfe);
  const cur = arr[0];

  const r = {
    rule: id,
    n: arr.length,
    curStop: cur.currentStop,
    curTgt: cur.currentTarget,
    p50_MAE: median(maes),
    p75_MAE: quantile(maes, 0.75),
    p80_MAE: quantile(maes, 0.80),
    p90_MAE: quantile(maes, 0.90),
    p50_MFE: median(mfes),
    p60_MFE: quantile(mfes, 0.60),
    p75_MFE: quantile(mfes, 0.75),
    med_winMFE: median(winMfes),
    mean_MFE: mean(mfes),
    mean_MAE: mean(maes),
  };
  rows[id] = r;

  console.log(
    [r.rule, r.n, r.curStop, r.curTgt,
     r.p50_MAE?.toFixed(1), r.p75_MAE?.toFixed(1), r.p80_MAE?.toFixed(1), r.p90_MAE?.toFixed(1),
     r.p50_MFE?.toFixed(1), r.p60_MFE?.toFixed(1), r.p75_MFE?.toFixed(1),
     r.med_winMFE?.toFixed(1) ?? '—', r.mean_MFE?.toFixed(1), r.mean_MAE?.toFixed(1)
    ].map(s => String(s).padStart(10)).join(' ')
  );
}

// ---- propose stops/targets ----
console.log('\n===== Proposed stops/targets (rounded to nearest 5pt) =====\n');
console.log(['rule', 'n', 'curStop', 'curTgt', 'newStop(p75 MAE)', 'newTgt(med winMFE)', 'cur R:R', 'new R:R', 'note'].map(s => s.padStart(18)).join(' '));

const round5 = x => x == null ? null : Math.round(x / 5) * 5;
for (const id of Object.keys(rows)) {
  const r = rows[id];
  let newStop = round5(r.p75_MAE);
  let newTgt = round5(r.med_winMFE ?? r.p60_MFE);
  let note = '';
  if (r.n < 15) { newStop = r.curStop; newTgt = r.curTgt; note = 'n<15 keep'; }
  if (newStop != null && newTgt != null && newStop >= newTgt) note = 'no positive R:R';
  const curRR = (r.curTgt / r.curStop).toFixed(2);
  const newRR = (newStop && newTgt) ? (newTgt / newStop).toFixed(2) : '—';
  console.log(
    [r.rule, r.n, r.curStop, r.curTgt, newStop, newTgt, curRR, newRR, note]
      .map(s => String(s ?? '—').padStart(18)).join(' ')
  );
}

// ---- write CSV if requested ----
if (csvOut) {
  const header = 'ruleId,side,entryTime,entryPrice,bars,mfe,mae,exitReason,curStop,curTgt,pnlPoints\n';
  const body = enriched.map(t =>
    [t.ruleId, t.side, new Date(t.entryTime).toISOString(), t.entryPrice,
     t.bars, t.mfe, t.mae, t.exitReason, t.currentStop, t.currentTarget, t.pnlPoints].join(',')
  ).join('\n');
  fs.writeFileSync(csvOut, header + body);
  console.log(`\nWrote ${enriched.length} rows to ${csvOut}`);
}
