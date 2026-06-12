// Phase 5 — Two portfolio overlays on the FCFS gold-standard:
//   Q1 SIZING:     model the move-of-the-day trade at 2 contracts (everything else 1, FCFS).
//   Q2 PREEMPTION: let the FIRST glx/gfi signal of the day take the slot from a foreign
//                  holder (lstb/glf) during the morning session.
//
// Run through the REAL event-driven FCFS engine (research/multi-strategy-rules/rules/_base.js)
// so slot cascades from preemption are honest. Preempting a holder closes it at its price
// at the preempt instant — looked up from 1s OHLCV (≤1 preemption/day).
//
// MotD trade (the one we size 2x) = first glx-or-gfi ACCEPTED trade each RTH day.
// Scenarios: S0 baseline | S1 +2x size | S2 +preempt(1x) | S3 +preempt+2x size.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose, realizeSyntheticClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics } from '../multi-strategy-rules/lib/metrics.js';
import { etParts, RTH_OPEN_MIN, EOD_CUTOFF_MIN } from './lib/et.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CSV = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv');
const IDXF = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.index.json');
const POINT_VALUE = 20, COMMISSION = 5;
const MORNING_END_MIN = 12 * 60; // 12:00 ET — "morning session" cutoff for preemption

const STRATEGIES = [
  { key: 'lstb',           file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m',      file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const MOTD_FAMILY = new Set(['gex-lt-3m', 'gex-flip-ivpct']); // glx + gfi
const normSide = s => { const l = String(s).toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : (l === 'short' || l === 'sell') ? 'short' : null; };

function loadAll() {
  const all = [];
  for (const def of STRATEGIES) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
    for (const t of raw.trades) {
      if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null) continue;
      const side = normSide(t.side); if (!side) continue;
      const entryTime = t.entryTime;
      const exitTime = (t.exitTime <= entryTime) ? entryTime + 1 : t.exitTime;
      all.push({
        id: `${def.key}:${t.id}`, nativeId: t.id, strategyKey: def.key, side,
        entryTime, exitTime, duration: t.duration ?? (exitTime - entryTime),
        actualEntry: t.actualEntry ?? t.entryPrice, actualExit: t.actualExit,
        netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason,
        contract: t.signalContract ?? t.signal?.signalContract,
      });
    }
  }
  return all.sort((a, b) => a.entryTime - b.entryTime);
}

// ---- 1s price lookup for synthetic (preemption) closes ----
const idx = JSON.parse(fs.readFileSync(IDXF, 'utf8')).minutes;
const fd = fs.openSync(CSV, 'r');
function priceAt(contract, ts) {
  for (const mk of [Math.floor(ts / 60000) * 60000, Math.floor(ts / 60000) * 60000 - 60000, Math.floor(ts / 60000) * 60000 + 60000]) {
    const meta = idx[mk]; if (!meta) continue;
    const buf = Buffer.allocUnsafe(meta.length); fs.readSync(fd, buf, 0, meta.length, meta.offset);
    let best = null, bestD = Infinity;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue; const c = line.split(',');
      if (c[9] !== contract) continue;
      const bts = Date.parse(c[0]); const d = Math.abs(bts - ts);
      if (d < bestD) { bestD = d; best = +c[7]; } // close
    }
    if (best != null) return best;
  }
  return null; // caller falls back
}

const dayKey = ts => etParts(ts).dateET;
const inMorning = ts => { const e = etParts(ts); return e.minutesOfDay >= RTH_OPEN_MIN && e.minutesOfDay < MORNING_END_MIN; };
const inRTH = ts => { const e = etParts(ts); return e.minutesOfDay >= RTH_OPEN_MIN && e.minutesOfDay < EOD_CUTOFF_MIN; };

// ---- rule handlers ----
const firstInWins = {
  name: 'first-in-wins',
  onSignal(state, trade) { if (state.position == null) open(state, trade); else reject(state); },
  onNativeExit(state, trade) { if (state.position && state.position.trade.id === trade.id) realizeNativeClose(state, trade); },
};

// preemption: first glx/gfi RTH signal of the day, if morning + slot held by lstb/glf → take slot
function makePreemptHandler() {
  const usedDay = new Set(); // days where the MotD slot decision already happened
  let preempts = 0;
  const tally = { free: 0, heldByFamily: 0, foreignMorning: 0, foreignLate: 0 };
  const h = {
    name: 'first-in-wins+preempt',
    onSignal(state, trade) {
      const isMotD = MOTD_FAMILY.has(trade.strategyKey) && inRTH(trade.entryTime);
      const day = dayKey(trade.entryTime);
      if (isMotD && !usedDay.has(day)) {
        // this is the day's first glx/gfi RTH signal — it gets the slot
        usedDay.add(day);
        if (state.position == null) { tally.free++; open(state, trade); return; }
        const holder = state.position.trade;
        const foreign = !MOTD_FAMILY.has(holder.strategyKey);
        if (!foreign) tally.heldByFamily++;
        else if (inMorning(trade.entryTime)) tally.foreignMorning++;
        else tally.foreignLate++;
        if (foreign && inMorning(trade.entryTime)) {
          // preempt: close holder at its price at this instant, then open MotD
          let px = priceAt(holder.contract, trade.entryTime);
          if (px == null) px = holder.actualEntry; // fallback: flat on holder
          realizeSyntheticClose(state, trade.entryTime, px, 'preempted_by_motd');
          preempts++;
          open(state, trade);
          return;
        }
        // foreign holder but not morning, or holder is glx/gfi → normal FCFS reject
        reject(state); return;
      }
      // normal FCFS for everything else
      if (state.position == null) open(state, trade); else reject(state);
    },
    onNativeExit(state, trade) { if (state.position && state.position.trade.id === trade.id) realizeNativeClose(state, trade); },
  };
  h.getPreempts = () => preempts;
  h.getTally = () => tally;
  return h;
}

// ---- apply 2x sizing to the day's first glx/gfi accepted trade ----
function sizeUpMotD(realizedTrades, mult = 2) {
  const sorted = [...realizedTrades].sort((a, b) => a.entryTime - b.entryTime);
  const doneDay = new Set();
  const out = realizedTrades.map(t => ({ ...t }));
  const idById = new Map(out.map(t => [t.portfolioId, t]));
  let sized = 0, sizedPnL = 0;
  for (const t of sorted) {
    if (!MOTD_FAMILY.has(t.strategyKey)) continue;
    if (!inRTH(t.entryTime)) continue;
    const d = dayKey(t.entryTime);
    if (doneDay.has(d)) continue;
    doneDay.add(d);
    const ref = idById.get(t.portfolioId);
    ref.netPnL = t.netPnL * mult;   // 2 contracts: gross & commission both scale → exactly 2x net
    sized++; sizedPnL += t.netPnL;
  }
  return { trades: out, sized, sizedPnLOrig: sizedPnL };
}

const all = loadAll();

function fmtRow(label, m, extra = '') {
  return `${label.padEnd(30)} ${String(m.trades).padStart(5)}  ${('$' + Math.round(m.totalPnL).toLocaleString()).padStart(11)}  PF ${String(m.profitFactor.toFixed(2)).padStart(5)}  Sh ${String(m.sharpe.toFixed(2)).padStart(6)}  DD ${String(m.maxDD_pct.toFixed(2) + '%').padStart(7)} ($${Math.round(m.maxDD_usd).toLocaleString()})  WR ${m.winRate.toFixed(1)}%  ${extra}`;
}

// S0 baseline
const s0 = simulate(all, firstInWins);
const m0 = calculateMetrics(s0.realizedTrades);
// S1 sizing only
const sz1 = sizeUpMotD(s0.realizedTrades, 2);
const m1 = calculateMetrics(sz1.trades);
// S2 preemption 1x
const ph = makePreemptHandler();
const s2 = simulate(all, ph);
const m2 = calculateMetrics(s2.realizedTrades);
// S3 preemption + 2x sizing
const sz3 = sizeUpMotD(s2.realizedTrades, 2);
const m3 = calculateMetrics(sz3.trades);

fs.closeSync(fd);

console.log('═══════════════════════════════════════════════════════════════════════════════════════');
console.log('  MOVE-OF-THE-DAY SIZING & PREEMPTION OVERLAYS ON FCFS (4-strat, single slot)');
console.log(`  MotD = first glx/gfi accepted RTH trade/day | preempt window = morning (09:30–12:00 ET)`);
console.log('═══════════════════════════════════════════════════════════════════════════════════════\n');
console.log(fmtRow('S0  baseline FCFS', m0));
console.log(fmtRow('S1  +2x size MotD', m1, `[sized ${sz1.sized} trades]`));
console.log(fmtRow('S2  +preempt (1x)', m2, `[${ph.getPreempts()} preemptions]`));
console.log(fmtRow('S3  +preempt +2x size', m3, `[${ph.getPreempts()} preempt, ${sz3.sized} sized]`));

console.log('\nDeltas vs S0 baseline:');
for (const [lbl, m] of [['S1 sizing', m1], ['S2 preempt', m2], ['S3 both', m3]]) {
  const dP = Math.round(m.totalPnL - m0.totalPnL);
  console.log(`  ${lbl.padEnd(12)} ΔPnL ${(dP >= 0 ? '+$' : '-$') + Math.abs(dP).toLocaleString()}   ΔPF ${(m.profitFactor - m0.profitFactor).toFixed(2)}   ΔSharpe ${(m.sharpe - m0.sharpe).toFixed(2)}   ΔDD% ${(m.maxDD_pct - m0.maxDD_pct).toFixed(2)}`);
}

const ty = ph.getTally();
const totDays = ty.free + ty.heldByFamily + ty.foreignMorning + ty.foreignLate;
console.log(`\nSlot state when the day's first glx/gfi RTH signal fires (${totDays} days):`);
console.log(`  slot FREE (opens normally):           ${ty.free}`);
console.log(`  held by glx/gfi already (our family): ${ty.heldByFamily}`);
console.log(`  held by lstb/glf in MORNING → PREEMPT:${ty.foreignMorning}`);
console.log(`  held by lstb/glf after noon (no act): ${ty.foreignLate}`);
