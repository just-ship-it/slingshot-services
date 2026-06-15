// Phase 8 — IN-TRADE trajectory diagnostic. For each big-3 trade (glx/gfi/glf), reconstruct
// the minute-by-minute path from 1s OHLCV (entry → native exit) and ask: does the trade's
// STATE at time-checkpoints predict its eventual outcome — well enough to cut losers early
// while keeping runners? The key honesty test is the RECOVERY RATE: among trades that look
// bad at checkpoint M, how many still finish green (cutting them would be a mistake).
//
// Diagnostic only (full-sample, descriptive). If separation exists, a causal cut-rule +
// train/test follows. No trade is cut here — we just observe where winners vs losers sit.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { etParts } from './lib/et.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CSV = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv');
const IDXF = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.index.json');

const FILES = { glx: 'gex-lt-3m-crossover-v3.json', gfi: 'gex-flip-ivpct-v2.json', glf: 'gex-level-fade-v2.json' };
const normSide = s => { const l = String(s).toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : 'short'; };
const CHECKPOINTS = [10, 20, 30, 45, 60, 90]; // minutes into the trade

const trades = [];
for (const [k, f] of Object.entries(FILES)) {
  for (const t of JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gold-standard', f), 'utf8')).trades) {
    if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null) continue;
    const entry = t.actualEntry ?? t.entryPrice; if (entry == null) continue;
    trades.push({ k, side: normSide(t.side), entryTs: t.entryTime, exitTs: t.exitTime,
      entry, finalPts: t.pointsPnL, contract: t.signalContract ?? t.signal?.signalContract,
      mfe: t.mfePoints, mae: t.maePoints });
  }
}

const idx = JSON.parse(fs.readFileSync(IDXF, 'utf8')).minutes;
const fd = fs.openSync(CSV, 'r');

// Walk 1s bars entry→exit; snapshot {unrl, runMFE, runMAE} at each checkpoint minute.
function trajectory(t) {
  const long = t.side === 'long';
  let runMFE = 0, runMAE = 0;
  const snaps = {}; // minute -> {unrl, runMFE, runMAE}  (only while trade still open)
  let ci = 0;
  const startMin = Math.floor(t.entryTs / 60000) * 60000;
  for (let m = startMin, g = 0; g < 200; m += 60000, g++) {
    if (m > t.exitTs) break;
    const meta = idx[m]; if (!meta) continue;
    const buf = Buffer.allocUnsafe(meta.length); fs.readSync(fd, buf, 0, meta.length, meta.offset);
    let lastClose = null, hi = -Infinity, lo = Infinity;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue; const c = line.split(',');
      if (c[9] !== t.contract) continue;
      const ts = Date.parse(c[0]); if (ts < t.entryTs || ts > t.exitTs) continue;
      const high = +c[5], low = +c[6], close = +c[7];
      if (!isFinite(high)) continue;
      if (high > hi) hi = high; if (low < lo) lo = low; lastClose = close;
    }
    if (lastClose == null) continue;
    // update running excursions using this minute's extremes
    const favHi = long ? hi - t.entry : t.entry - lo;
    const advLo = long ? t.entry - lo : hi - t.entry;
    if (favHi > runMFE) runMFE = favHi;
    if (advLo > runMAE) runMAE = advLo;
    const elapsed = Math.round((m - startMin) / 60000);
    const unrl = long ? lastClose - t.entry : t.entry - lastClose;
    // record snapshot if we just passed a checkpoint
    while (ci < CHECKPOINTS.length && elapsed >= CHECKPOINTS[ci]) {
      snaps[CHECKPOINTS[ci]] = { unrl, runMFE, runMAE };
      ci++;
    }
  }
  return snaps;
}

let processed = 0;
for (const t of trades) { t.snaps = trajectory(t); if (++processed % 300 === 0) process.stderr.write(`  ${processed}/${trades.length}\n`); }
fs.closeSync(fd);

const win = t => t.finalPts > 0;
const fmtPct = x => (x * 100).toFixed(0) + '%';

console.log(`Reconstructed ${trades.length} big-3 trade trajectories (1s).`);
console.log(`Overall win rate: ${fmtPct(trades.filter(win).length / trades.length)}, avg final ${(trades.reduce((s, t) => s + t.finalPts, 0) / trades.length).toFixed(1)}pt\n`);

// For each checkpoint, condition on in-trade state and measure eventual outcome.
for (const M of CHECKPOINTS) {
  const open = trades.filter(t => t.snaps[M]); // still open at M
  if (open.length < 30) continue;
  console.log(`══ checkpoint ${M}min  (${open.length} trades still open) ══`);
  // (a) underwater buckets by current unrealized
  const buckets = [
    ['unrl <= -30', t => t.snaps[M].unrl <= -30],
    ['-30 < unrl <= -15', t => t.snaps[M].unrl > -30 && t.snaps[M].unrl <= -15],
    ['-15 < unrl <= 0', t => t.snaps[M].unrl > -15 && t.snaps[M].unrl <= 0],
    ['0 < unrl <= 20', t => t.snaps[M].unrl > 0 && t.snaps[M].unrl <= 20],
    ['unrl > 20', t => t.snaps[M].unrl > 20],
  ];
  for (const [lbl, fn] of buckets) {
    const g = open.filter(fn); if (!g.length) continue;
    const wr = g.filter(win).length / g.length;
    const avgFinal = g.reduce((s, t) => s + t.finalPts, 0) / g.length;
    const avgUnrl = g.reduce((s, t) => s + t.snaps[M].unrl, 0) / g.length;
    const cutEdge = avgUnrl - avgFinal; // >0 ⇒ cutting now beats holding
    console.log(`   ${lbl.padEnd(20)} n=${String(g.length).padStart(4)}  WR ${fmtPct(wr).padStart(4)}  nowUnrl ${avgUnrl.toFixed(1).padStart(6)}  avgFinal ${avgFinal.toFixed(1).padStart(7)}  cut-vs-hold ${(cutEdge >= 0 ? '+' : '') + cutEdge.toFixed(1)}pt`);
  }
  // (b) "dead money": hasn't reached +15 favorable by M
  const dead = open.filter(t => t.snaps[M].runMFE < 15);
  if (dead.length >= 10) {
    const wr = dead.filter(win).length / dead.length;
    console.log(`   never reached +15 fav  n=${String(dead.length).padStart(4)}  WR ${fmtPct(wr).padStart(4)}  avgFinal ${(dead.reduce((s, t) => s + t.finalPts, 0) / dead.length).toFixed(1)}pt`);
  }
  console.log();
}

// ── CUT-RULE backtest: exit at first checkpoint ≥ Mmin where unrl ≤ −T (market, 1pt slip) ──
const baseTotal = trades.reduce((s, t) => s + t.finalPts, 0);
const baseWR = trades.filter(win).length / trades.length;
console.log('══════════ CUT-LOSER RULE SWEEP (per-strategy big-3 trades, in-sample) ══════════');
console.log(`baseline: total ${baseTotal.toFixed(0)}pt  ($${(baseTotal * 20).toLocaleString()})  WR ${fmtPct(baseWR)}  avgFinal ${(baseTotal / trades.length).toFixed(1)}pt  n=${trades.length}\n`);
console.log('  rule (cut if unrl≤−T at ≥Mmin)      cut#   Δtotal pts     new total     newWR   avgFinal');
for (const T of [20, 25, 30, 40]) {
  for (const Mmin of [20, 30, 45]) {
    let cut = 0;
    const finals = trades.map(t => {
      for (const M of CHECKPOINTS) {
        if (M < Mmin) continue;
        const s = t.snaps[M];
        if (s && s.unrl <= -T) { cut++; return s.unrl - 1; } // exit at current unrl, 1pt slip
      }
      return t.finalPts;
    });
    const newTotal = finals.reduce((a, b) => a + b, 0);
    const newWR = finals.filter(x => x > 0).length / finals.length;
    const d = newTotal - baseTotal;
    console.log(`  T=${String(T).padStart(2)}  Mmin=${String(Mmin).padStart(2)}                    ${String(cut).padStart(4)}   ${(d >= 0 ? '+' : '') + d.toFixed(0).padStart(6)}pt ($${Math.round(d * 20).toLocaleString()})   ${newTotal.toFixed(0).padStart(6)}pt   ${fmtPct(newWR)}   ${(newTotal / trades.length).toFixed(1)}`);
  }
}
