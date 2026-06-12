// Phase 3 — 1s-VALIDATED trailing-exit sim on the move-of-the-day picks.
//
// Picks = first RTH glx-or-gfi signal per day (the deployable core rule from Phase 2).
// We KEEP each trade's own initial stop (downside risk unchanged) and REPLACE its exit
// with a trailing stop, simulated honestly on 1s OHLCV from the fill instant forward
// (CLAUDE.md mandate). Compare to each pick's own realized PnL.
//
// Trailing rule (long; short symmetric):
//   - stop starts at initStop (the strategy's own stop).
//   - once high-water - entry >= trigger, trail activates: stop = max(initStop, highWater - offset).
//   - exit when a 1s bar's low <= stop  → fill at stop - stopSlippage (stop->market).
//   - force-flat at EOD 15:45 ET at that bar's open - marketSlippage.
// First 1s bar used is the first with ts >= fill_ts. Exits walk 1s bars chronologically.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { etParts, inRTHEntryWindow, EOD_CUTOFF_MIN } from './lib/et.js';
import { metrics, fmt } from './lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GS = path.resolve(__dirname, '../../data/gold-standard');
const OUT = path.resolve(__dirname, 'output');
const CSV = path.resolve(__dirname, '../../data/ohlcv/nq/NQ_ohlcv_1s.csv');
const IDXF = path.resolve(__dirname, '../../data/ohlcv/nq/NQ_ohlcv_1s.index.json');

const STOP_SLIP = 1.5, MKT_SLIP = 1.0;

// ---------- build picks: first RTH glx|gfi signal per day ----------
function loadTrades(file, strat) {
  const j = JSON.parse(fs.readFileSync(path.join(GS, file), 'utf8'));
  return (j.trades || []).map(t => {
    const sig = t.signal || {};
    const side = (t.side === 'buy' || t.side === 'long') ? 'long' : 'short';
    const entryTs = t.entryTime ?? sig.timestamp ?? t.timestamp;
    return {
      strat, side, entryTs,
      entryPrice: t.entryPrice ?? t.actualEntry ?? sig.price,
      initStop: t.stopLoss ?? sig.stopLoss,
      contract: t.signalContract ?? sig.signalContract,
      ownPnL: t.pointsPnL, ownMfe: t.mfePoints, ownExit: t.exitReason,
    };
  }).filter(t => t.entryTs && t.contract && t.initStop != null && inRTHEntryWindow(t.entryTs));
}

const cands = [...loadTrades('gex-lt-3m-crossover-v3.json', 'glx'),
               ...loadTrades('gex-flip-ivpct-v2.json', 'gfi')]
  .sort((a, b) => a.entryTs - b.entryTs);

const pickByDay = new Map();
for (const c of cands) {
  const d = etParts(c.entryTs).dateET;
  if (!pickByDay.has(d)) pickByDay.set(d, c); // earliest entry that day
}
const picks = [...pickByDay.values()].sort((a, b) => a.entryTs - b.entryTs);
console.log(`Picks (first glx|gfi RTH signal/day): ${picks.length}`);
console.log(`  own realized: ${fmt(metrics(picks.map(p => p.ownPnL)))}`);

// ---------- 1s reader via minute index ----------
console.log('Loading 1s minute index...');
const idx = JSON.parse(fs.readFileSync(IDXF, 'utf8')).minutes;
const fd = fs.openSync(CSV, 'r');

// read all 1s bars for [fillTs, EOD] for a pick's contract; returns sorted bars
function readBars(pick) {
  const startMin = Math.floor(pick.entryTs / 60000) * 60000;
  const bars = [];
  for (let m = startMin, guard = 0; guard < 480; m += 60000, guard++) {
    const meta = idx[m];
    if (!meta) continue;
    // stop once this minute is past EOD cutoff
    const et = etParts(m);
    if (et.minutesOfDay > EOD_CUTOFF_MIN || et.dateET !== etParts(pick.entryTs).dateET) break;
    const buf = Buffer.allocUnsafe(meta.length);
    fs.readSync(fd, buf, 0, meta.length, meta.offset);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue;
      const c = line.split(',');
      if (c[9] !== pick.contract) continue;
      const ts = Date.parse(c[0]);
      if (ts < pick.entryTs) continue;
      const high = +c[5], low = +c[6], open = +c[4];
      if (!isFinite(high) || !isFinite(low)) continue;
      bars.push({ ts, open, high, low });
    }
  }
  bars.sort((a, b) => a.ts - b.ts);
  return bars;
}

// ---------- trailing exit sim ----------
function simTrail(pick, bars, trigger, offset) {
  if (!bars.length) return { pts: pick.ownPnL, exit: 'fallback_no_1s' };
  const long = pick.side === 'long';
  const entry = pick.entryPrice;
  let stop = pick.initStop;
  let hw = long ? -Infinity : Infinity; // high/low water mark
  let activated = false;
  for (const b of bars) {
    // update water mark
    if (long) hw = Math.max(hw, b.high); else hw = Math.min(hw, b.low);
    // activate + trail
    if (!activated) {
      const fav = long ? (hw - entry) : (entry - hw);
      if (fav >= trigger) activated = true;
    }
    if (activated) {
      const trail = long ? hw - offset : hw + offset;
      stop = long ? Math.max(stop, trail) : Math.min(stop, trail);
    }
    // check stop hit (intrabar)
    if (long && b.low <= stop) { const px = stop - STOP_SLIP; return { pts: px - entry, exit: activated ? 'trail' : 'stop' }; }
    if (!long && b.high >= stop) { const px = stop + STOP_SLIP; return { pts: entry - px, exit: activated ? 'trail' : 'stop' }; }
  }
  // EOD force-flat at last bar's close-ish (use last bar open as market proxy)
  const last = bars[bars.length - 1];
  const px = long ? last.open - MKT_SLIP : last.open + MKT_SLIP;
  return { pts: long ? px - entry : entry - px, exit: 'eod' };
}

// preload bars once per pick (reused across sweeps)
console.log('Reading 1s windows for each pick...');
let missing = 0;
for (const p of picks) { p._bars = readBars(p); if (!p._bars.length) missing++; }
fs.closeSync(fd);
console.log(`  loaded; picks with no 1s data: ${missing}/${picks.length}`);

// ---------- sweep ----------
const combos = [];
for (const trigger of [20, 30, 40, 50, 60]) for (const offset of [10, 15, 20, 30, 40]) combos.push([trigger, offset]);

console.log('\n========== 1s-VALIDATED TRAILING EXIT (own initial stop kept) ==========');
console.log(`baseline own exit:        ${fmt(metrics(picks.map(p => p.ownPnL)))}\n`);
const results = [];
for (const [trigger, offset] of combos) {
  const series = picks.map(p => simTrail(p, p._bars, trigger, offset).pts);
  const m = metrics(series);
  results.push({ trigger, offset, m });
}
// sort by Sharpe, then PnL
results.sort((a, b) => b.m.sharpe - a.m.sharpe);
console.log('Top by Sharpe:');
for (const r of results.slice(0, 8)) {
  console.log(`  trig ${String(r.trigger).padStart(2)} / off ${String(r.offset).padStart(2)}:  ${fmt(r.m)}`);
}
const byPnL = [...results].sort((a, b) => b.m.totalPnL - a.m.totalPnL);
console.log('Top by PnL:');
for (const r of byPnL.slice(0, 4)) {
  console.log(`  trig ${String(r.trigger).padStart(2)} / off ${String(r.offset).padStart(2)}:  ${fmt(r.m)}`);
}

// exit-reason breakdown for the best-Sharpe combo
const best = results[0];
const breakdown = {};
for (const p of picks) { const e = simTrail(p, p._bars, best.trigger, best.offset).exit; breakdown[e] = (breakdown[e] || 0) + 1; }
console.log(`\nBest-Sharpe combo trig ${best.trigger}/off ${best.offset} exit reasons:`, breakdown);

// train/test stability for best combo
const mid = picks[Math.floor(picks.length / 2)].entryTs;
const h1 = picks.filter(p => p.entryTs < mid), h2 = picks.filter(p => p.entryTs >= mid);
console.log(`\nStability of trig ${best.trigger}/off ${best.offset}:`);
console.log(`  H1: ${fmt(metrics(h1.map(p => simTrail(p, p._bars, best.trigger, best.offset).pts)))}`);
console.log(`  H2: ${fmt(metrics(h2.map(p => simTrail(p, p._bars, best.trigger, best.offset).pts)))}`);
console.log(`  H1 own: ${fmt(metrics(h1.map(p => p.ownPnL)))}`);
console.log(`  H2 own: ${fmt(metrics(h2.map(p => p.ownPnL)))}`);
