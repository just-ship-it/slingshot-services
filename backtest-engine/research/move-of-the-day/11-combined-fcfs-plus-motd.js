// Phase 7 — Run the standalone MotD book (first glx/gfi RTH → 150pt target, own stop)
// ALONGSIDE the 4x FCFS portfolio as a SEPARATE account/slot. Question: is the MotD book
// just leverage on trades FCFS already holds, or does it add net-new exposure?
//
// Decompose each MotD pick:
//   OVERLAP   — the same strategy:nativeId is in the FCFS accepted book (FCFS slot was free
//               → both hold the same entry → it's a 2nd contract = leverage, but with a
//               different (150pt) exit on the added contract).
//   ADDITIVE  — FCFS rejected that signal (shared slot busy with lstb/glf or a sibling) →
//               MotD captures a glx/gfi trade FCFS missed = net-new exposure.
//
// Then merge both books into one account (2 independent slots) and measure combined metrics.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics } from '../multi-strategy-rules/lib/metrics.js';
import { etParts, inRTHEntryWindow, EOD_CUTOFF_MIN } from './lib/et.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CSV = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv');
const IDXF = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.index.json');
const PV = 20, COMM = 5, STOP_SLIP = 1.5, MKT_SLIP = 1.0, TARGET = 150;

const STRATEGIES = [
  { key: 'lstb',           file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m',      file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const FAMILY = new Set(['gex-lt-3m', 'gex-flip-ivpct']);
const normSide = s => { const l = String(s).toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : (l === 'short' || l === 'sell') ? 'short' : null; };

// load all trades (for FCFS) + keep raw fields for MotD sim
const all = [], rawById = new Map();
for (const def of STRATEGIES) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  for (const t of raw.trades) {
    if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null) continue;
    const side = normSide(t.side); if (!side) continue;
    const entryTime = t.entryTime, exitTime = t.exitTime <= entryTime ? entryTime + 1 : t.exitTime;
    const tr = { id: `${def.key}:${t.id}`, nativeId: t.id, strategyKey: def.key, side, entryTime, exitTime,
      duration: t.duration ?? (exitTime - entryTime), actualEntry: t.actualEntry ?? t.entryPrice,
      actualExit: t.actualExit, netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason };
    all.push(tr);
    rawById.set(tr.id, { entryTs: entryTime, entryPrice: tr.actualEntry, side, initStop: t.stopLoss ?? t.signal?.stopLoss,
      contract: t.signalContract ?? t.signal?.signalContract, ownPnL: t.pointsPnL, ownExitTs: t.exitTime });
  }
}
all.sort((a, b) => a.entryTime - b.entryTime);

// FCFS accepted book
const fcfs = {
  name: 'fcfs',
  onSignal(s, t) { if (s.position == null) open(s, t); else reject(s); },
  onNativeExit(s, t) { if (s.position && s.position.trade.id === t.id) realizeNativeClose(s, t); },
};
const fcfsBook = simulate(all, fcfs).realizedTrades;
const fcfsAcceptedIds = new Set(fcfsBook.map(t => `${t.strategyKey}:${t.nativeId}`));
const fcfsTrades = fcfsBook.map(t => ({ netPnL: t.netPnL, exitTime: t.exitTime, duration: t.duration }));

// MotD picks: first glx/gfi RTH signal per day
const fam = all.filter(t => FAMILY.has(t.strategyKey) && inRTHEntryWindow(t.entryTime)).sort((a, b) => a.entryTime - b.entryTime);
const pickByDay = new Map();
for (const t of fam) { const d = etParts(t.entryTime).dateET; if (!pickByDay.has(d)) pickByDay.set(d, t); }
const picks = [...pickByDay.values()];

// 1s reader for the 150pt exit
const idx = JSON.parse(fs.readFileSync(IDXF, 'utf8')).minutes;
const fd = fs.openSync(CSV, 'r');
function sim150(p) {
  const r = rawById.get(p.id);
  const startMin = Math.floor(r.entryTs / 60000) * 60000, dateET = etParts(r.entryTs).dateET;
  const long = r.side === 'long', e = r.entryPrice, stop = r.initStop, tgt = long ? e + TARGET : e - TARGET;
  for (let m = startMin, g = 0; g < 480; m += 60000, g++) {
    const meta = idx[m]; if (!meta) continue;
    const et = etParts(m); if (et.minutesOfDay > EOD_CUTOFF_MIN || et.dateET !== dateET) break;
    const buf = Buffer.allocUnsafe(meta.length); fs.readSync(fd, buf, 0, meta.length, meta.offset);
    const rows = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue; const c = line.split(',');
      if (c[9] !== r.contract) continue; const ts = Date.parse(c[0]); if (ts < r.entryTs) continue;
      const high = +c[5], low = +c[6], open = +c[4]; if (isFinite(high) && isFinite(low)) rows.push({ ts, open, high, low });
    }
    rows.sort((a, b) => a.ts - b.ts);
    for (const b of rows) {
      if (long) { if (b.low <= stop) return { pts: stop - STOP_SLIP - e, exitTs: b.ts }; if (b.high >= tgt) return { pts: tgt - e, exitTs: b.ts }; }
      else { if (b.high >= stop) return { pts: e - stop - STOP_SLIP, exitTs: b.ts }; if (b.low <= tgt) return { pts: e - tgt, exitTs: b.ts }; }
    }
  }
  return { pts: r.ownPnL, exitTs: r.ownExitTs }; // fallback
}

let overlap = 0, additive = 0, ovlPnL = 0, addPnL = 0;
const motdTrades = picks.map(p => {
  const r = sim150(p);
  const isOverlap = fcfsAcceptedIds.has(p.id);
  if (isOverlap) { overlap++; ovlPnL += r.pts * PV - COMM; } else { additive++; addPnL += r.pts * PV - COMM; }
  return { netPnL: r.pts * PV - COMM, exitTime: r.exitTs, duration: r.exitTs - rawById.get(p.id).entryTs, _overlap: isOverlap };
});
fs.closeSync(fd);

const fM = calculateMetrics(fcfsTrades);
const mM = calculateMetrics(motdTrades);
const cM = calculateMetrics([...fcfsTrades, ...motdTrades]);
const addOnly = calculateMetrics(motdTrades.filter(t => !t._overlap));
const ovlOnly = calculateMetrics(motdTrades.filter(t => t._overlap));

const r = (lbl, m) => `${lbl.padEnd(34)} ${('$' + Math.round(m.totalPnL).toLocaleString()).padStart(11)}  PF ${m.profitFactor.toFixed(2).padStart(5)}  Sh ${m.sharpe.toFixed(2).padStart(6)}  DD ${(m.maxDD_pct.toFixed(2) + '%').padStart(7)} ($${Math.round(m.maxDD_usd).toLocaleString()})  n=${m.trades}`;

console.log('═══════════════════════════════════════════════════════════════════════════════════════');
console.log('  4x FCFS  +  standalone MotD book (first glx/gfi RTH → 150pt), run as separate slots');
console.log('═══════════════════════════════════════════════════════════════════════════════════════\n');
console.log(' ', r('FCFS alone (1 slot)', fM));
console.log(' ', r('MotD book alone (1 slot)', mM));
console.log(' ', r('COMBINED account (both slots)', cM));
console.log('\n  MotD book decomposition:');
console.log(`    OVERLAP  (FCFS already holds same entry → leverage): ${overlap} trades, $${Math.round(ovlPnL).toLocaleString()}`);
console.log(`    ADDITIVE (FCFS slot was busy → net-new exposure):    ${additive} trades, $${Math.round(addPnL).toLocaleString()}`);
console.log('   ', r('  MotD ADDITIVE-only', addOnly));
console.log('   ', r('  MotD OVERLAP-only', ovlOnly));
console.log('\n  vs FCFS alone:  ΔPnL +$' + Math.round(cM.totalPnL - fM.totalPnL).toLocaleString() +
  `   Sharpe ${fM.sharpe.toFixed(2)}→${cM.sharpe.toFixed(2)}   DD ${fM.maxDD_pct.toFixed(2)}%→${cM.maxDD_pct.toFixed(2)}%`);
