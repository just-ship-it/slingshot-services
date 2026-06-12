// Phase 3b — 1s-honest test of the OTHER exit hypotheses on the same 212 picks:
//   (a) fixed target sweep (own initial stop kept), no trail
//   (b) hold-to-EOD with own initial stop only (pure directional ride)
// Goal: confirm whether ANY simple exit beats the strategies' own (v2/v3-optimized) exits.
// Same 1s-honest engine as 06: limit target = no slippage; stop = 1.5pt; EOD market = 1.0pt.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { etParts, inRTHEntryWindow, EOD_CUTOFF_MIN } from './lib/et.js';
import { metrics, fmt } from './lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GS = path.resolve(__dirname, '../../data/gold-standard');
const CSV = path.resolve(__dirname, '../../data/ohlcv/nq/NQ_ohlcv_1s.csv');
const IDXF = path.resolve(__dirname, '../../data/ohlcv/nq/NQ_ohlcv_1s.index.json');
const STOP_SLIP = 1.5, MKT_SLIP = 1.0;

function loadTrades(file, strat) {
  const j = JSON.parse(fs.readFileSync(path.join(GS, file), 'utf8'));
  return (j.trades || []).map(t => {
    const sig = t.signal || {};
    const side = (t.side === 'buy' || t.side === 'long') ? 'long' : 'short';
    const entryTs = t.entryTime ?? sig.timestamp ?? t.timestamp;
    return { strat, side, entryTs, entryPrice: t.entryPrice ?? t.actualEntry ?? sig.price,
      initStop: t.stopLoss ?? sig.stopLoss, contract: t.signalContract ?? sig.signalContract,
      ownPnL: t.pointsPnL };
  }).filter(t => t.entryTs && t.contract && t.initStop != null && inRTHEntryWindow(t.entryTs));
}
const cands = [...loadTrades('gex-lt-3m-crossover-v3.json', 'glx'),
               ...loadTrades('gex-flip-ivpct-v2.json', 'gfi')].sort((a, b) => a.entryTs - b.entryTs);
const pickByDay = new Map();
for (const c of cands) { const d = etParts(c.entryTs).dateET; if (!pickByDay.has(d)) pickByDay.set(d, c); }
const picks = [...pickByDay.values()].sort((a, b) => a.entryTs - b.entryTs);

const idx = JSON.parse(fs.readFileSync(IDXF, 'utf8')).minutes;
const fd = fs.openSync(CSV, 'r');
function readBars(pick) {
  const startMin = Math.floor(pick.entryTs / 60000) * 60000;
  const dateET = etParts(pick.entryTs).dateET;
  const bars = [];
  for (let m = startMin, guard = 0; guard < 480; m += 60000, guard++) {
    const meta = idx[m]; if (!meta) continue;
    const et = etParts(m); if (et.minutesOfDay > EOD_CUTOFF_MIN || et.dateET !== dateET) break;
    const buf = Buffer.allocUnsafe(meta.length); fs.readSync(fd, buf, 0, meta.length, meta.offset);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue; const c = line.split(',');
      if (c[9] !== pick.contract) continue;
      const ts = Date.parse(c[0]); if (ts < pick.entryTs) continue;
      const high = +c[5], low = +c[6], open = +c[4];
      if (!isFinite(high) || !isFinite(low)) continue;
      bars.push({ ts, open, high, low });
    }
  }
  bars.sort((a, b) => a.ts - b.ts); return bars;
}
for (const p of picks) p._bars = readBars(p);
fs.closeSync(fd);

// (a) fixed target + own stop. Conservative same-bar tie: stop resolves before target.
function simFixed(p, targetPts) {
  const bars = p._bars; if (!bars.length) return p.ownPnL;
  const long = p.side === 'long', entry = p.entryPrice, stop = p.initStop;
  const target = long ? entry + targetPts : entry - targetPts;
  for (const b of bars) {
    if (long) {
      if (b.low <= stop) return (stop - STOP_SLIP) - entry;     // stop first (conservative)
      if (b.high >= target) return target - entry;              // limit, no slip
    } else {
      if (b.high >= stop) return entry - (stop + STOP_SLIP);
      if (b.low <= target) return entry - target;
    }
  }
  const last = bars[bars.length - 1];
  return long ? (last.open - MKT_SLIP) - entry : entry - (last.open + MKT_SLIP);
}

// (b) hold to EOD with own stop only
function simEOD(p) {
  const bars = p._bars; if (!bars.length) return p.ownPnL;
  const long = p.side === 'long', entry = p.entryPrice, stop = p.initStop;
  for (const b of bars) {
    if (long && b.low <= stop) return (stop - STOP_SLIP) - entry;
    if (!long && b.high >= stop) return entry - (stop + STOP_SLIP);
  }
  const last = bars[bars.length - 1];
  return long ? (last.open - MKT_SLIP) - entry : entry - (last.open + MKT_SLIP);
}

console.log('========== 1s-HONEST EXIT VARIANTS (212 picks, own initial stop kept) ==========');
console.log(`own exit (baseline):  ${fmt(metrics(picks.map(p => p.ownPnL)))}\n`);
console.log('(a) FIXED TARGET sweep:');
for (const T of [40, 60, 80, 100, 120, 150, 200, 260]) {
  console.log(`  target ${String(T).padStart(3)}pt:  ${fmt(metrics(picks.map(p => simFixed(p, T))))}`);
}
console.log('\n(b) HOLD TO EOD (own stop only):');
console.log(`  ${fmt(metrics(picks.map(p => simEOD(p))))}`);

// stability check for the standout fixed-target=150 and EOD variants
const mid = picks[Math.floor(picks.length/2)].entryTs;
const h1 = picks.filter(p=>p.entryTs<mid), h2 = picks.filter(p=>p.entryTs>=mid);
console.log('\n========== STABILITY (H1/H2) ==========');
console.log('target 150pt  H1:', fmt(metrics(h1.map(p=>simFixed(p,150)))));
console.log('target 150pt  H2:', fmt(metrics(h2.map(p=>simFixed(p,150)))));
console.log('own exit      H1:', fmt(metrics(h1.map(p=>p.ownPnL))));
console.log('own exit      H2:', fmt(metrics(h2.map(p=>p.ownPnL))));
console.log('hold-EOD      H1:', fmt(metrics(h1.map(p=>simEOD(p)))));
console.log('hold-EOD      H2:', fmt(metrics(h2.map(p=>simEOD(p)))));
