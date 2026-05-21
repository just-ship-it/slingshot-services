/**
 * Phase 3 — Exit-policy grid sweep.
 *
 * Loads 01-trades-mfe-walk.json ONCE. For each combination in the grid,
 * runs the simulator and produces a row. Outputs CSV sorted by PnL.
 *
 * Grid axes:
 *   target  ∈ [original, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30]
 *   stop    ∈ [original, 2, 3, 4, 5, 6, 8]
 *   beTrig  ∈ [null, 2, 4, 6, 8]
 *   beOff   ∈ [null, 0, 1, 2]    (auto-paired with beTrig)
 *   trail   ∈ [null, (4,2), (6,3), (8,4), (10,5), (15,8)]
 *
 * Full cartesian is too large; we'll bound by (a) skip target<=stop, (b)
 * skip overlapping be+trail variants, (c) cap to first ~3000 combos and
 * dump top 100 by Sharpe and by PnL.
 *
 * Usage:
 *   node 03-sweep-exits.js --out output/03-sweep.csv
 *   node 03-sweep-exits.js --top 200
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
function flag(name) { return process.argv.includes(`--${name}`); }

const WALK_PATH = arg('walk', path.join(__dirname, 'output', '01-trades-walk.json'));
const OUT_PATH = arg('out', path.join(__dirname, 'output', '03-sweep.csv'));
const TOP = +arg('top', '200');
const POINT_VALUE = +arg('point-value', '20');
const COMMISSION = +arg('commission', '5');
const MAX_HOLD_MIN = +arg('max-hold', '60');
const SLIP_PTS = +arg('slip', '0.25');
const QUICK = flag('quick'); // smaller grid for smoke test

console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades: ${walks.length}\n`);
const maxHoldMs = MAX_HOLD_MIN * 60_000;

// Inline simulator — operates on per-bar OHLC walks [t_sec, hi, lo, c] favorable-positive.
function simulate(e, cfg) {
  const origTgt = e.side === 'buy' ? (e.tp - e.entry) : (e.entry - e.tp);
  const origStp = e.side === 'buy' ? (e.entry - e.sl) : (e.sl - e.entry);
  const tgt = cfg.target == null ? origTgt : cfg.target;
  const stp = cfg.stop == null ? origStp : cfg.stop;

  let mfePeak = 0, mae = 0;
  let beActive = false, trActive = false;
  const walk = e.walk;
  for (let i = 0; i < walk.length; i++) {
    const s = walk[i];
    const t = s[0] * 1000;
    const hi = s[1], lo = s[2], c = s[3];
    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;
    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;
    // Stop first (conservative on same-bar ambiguity)
    if (mae >= stp) return { exit: 'stop', pnlPts: -(stp + SLIP_PTS), durationMs: t, mfeAtExit: mfePeak };
    if (mfePeak >= tgt) return { exit: 'target', pnlPts: tgt, durationMs: t, mfeAtExit: mfePeak };
    if (beActive && lo <= cfg.beOff) return { exit: 'be', pnlPts: cfg.beOff, durationMs: t, mfeAtExit: mfePeak };
    if (trActive) {
      const trailLevel = mfePeak - cfg.trOff;
      if (lo <= trailLevel) return { exit: 'trail', pnlPts: trailLevel - SLIP_PTS, durationMs: t, mfeAtExit: mfePeak };
    }
    if (t > maxHoldMs) return { exit: 'maxhold', pnlPts: c, durationMs: maxHoldMs, mfeAtExit: mfePeak };
  }
  if (e.terminal === 'eod' && e.eodPrice != null) {
    const pnl = e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice);
    return { exit: 'eod', pnlPts: pnl, durationMs: e.finalTs - e.fillTs, mfeAtExit: mfePeak };
  }
  if (walk.length > 0) {
    const last = walk[walk.length - 1];
    return { exit: e.terminal || 'final', pnlPts: last[3], durationMs: last[0] * 1000, mfeAtExit: mfePeak };
  }
  return { exit: 'no_data', pnlPts: 0, durationMs: 0, mfeAtExit: 0 };
}

function statsFor(results) {
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
  const equity = []; let cum = 0;
  for (const r of results) {
    const d = r.pnlPts * POINT_VALUE - COMMISSION;
    pnl += d; cum += d; equity.push(cum);
    if (d > 0) { wins++; sumW += d; }
    else if (d < 0) { losses++; sumL += d; }
  }
  const wr = (wins + losses) ? wins / (wins + losses) * 100 : 0;
  const pf = sumL !== 0 ? Math.abs(sumW / sumL) : (sumW > 0 ? Infinity : 0);
  let peak = -Infinity, maxDD = 0;
  for (const v of equity) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
  const mean = pnl / results.length;
  let varSum = 0;
  for (const r of results) { const d = r.pnlPts * POINT_VALUE - COMMISSION; varSum += (d - mean) ** 2; }
  const sd = Math.sqrt(varSum / results.length);
  const perT = sd > 0 ? mean / sd : 0;
  const tradesPerYear = results.length / (16 / 12);
  return { pnl, wins, losses, wr, pf, maxDD, sharpe: perT * Math.sqrt(tradesPerYear), n: results.length };
}

// Build grid
const TARGETS = QUICK ? [null, 5, 8, 12] : [null, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
const STOPS = QUICK ? [null, 2, 4, 6] : [null, 2, 3, 4, 5, 6, 8];
const BE_OPTS = QUICK
  ? [{ trig: null, off: 0 }, { trig: 4, off: 1 }]
  : [
      { trig: null, off: 0 },
      { trig: 2, off: 0 },
      { trig: 3, off: 0 },
      { trig: 3, off: 1 },
      { trig: 4, off: 1 },
      { trig: 4, off: 2 },
      { trig: 6, off: 2 },
      { trig: 6, off: 3 },
      { trig: 8, off: 3 },
    ];
const TR_OPTS = QUICK
  ? [{ trig: null, off: null }, { trig: 6, off: 3 }]
  : [
      { trig: null, off: null },
      { trig: 4, off: 2 },
      { trig: 5, off: 2 },
      { trig: 6, off: 3 },
      { trig: 8, off: 3 },
      { trig: 8, off: 4 },
      { trig: 10, off: 4 },
      { trig: 12, off: 5 },
      { trig: 15, off: 7 },
    ];

console.log(`Grid: ${TARGETS.length} × ${STOPS.length} × ${BE_OPTS.length} × ${TR_OPTS.length} = ${TARGETS.length * STOPS.length * BE_OPTS.length * TR_OPTS.length} combos`);

const rows = [];
let n = 0;
const tStart = Date.now();
for (const target of TARGETS) {
  for (const stop of STOPS) {
    // Skip target < stop unless target is null (orig)
    if (target != null && stop != null && target < stop) continue;
    for (const be of BE_OPTS) {
      for (const tr of TR_OPTS) {
        // Skip be.trig > target (BE never activates) when target is fixed
        if (target != null && be.trig != null && be.trig >= target) continue;
        if (target != null && tr.trig != null && tr.trig >= target) continue;
        const cfg = {
          target, stop,
          beTrig: be.trig, beOff: be.off,
          trTrig: tr.trig, trOff: tr.off,
        };
        const results = walks.map(w => simulate(w, cfg));
        const st = statsFor(results);
        rows.push({
          cfg: `tgt=${target ?? 'orig'} stp=${stop ?? 'orig'} be=${be.trig ?? '-'}/${be.off} tr=${tr.trig ?? '-'}/${tr.off ?? '-'}`,
          target, stop,
          beTrig: be.trig, beOff: be.off,
          trTrig: tr.trig, trOff: tr.off,
          ...st,
        });
        n++;
        if (n % 200 === 0) process.stdout.write(`  ${n} combos done (${((Date.now()-tStart)/1000).toFixed(0)}s)\n`);
      }
    }
  }
}
const sec = ((Date.now() - tStart) / 1000).toFixed(1);
console.log(`\nDone ${n} combos in ${sec}s.\n`);

// Top by PnL
rows.sort((a, b) => b.pnl - a.pnl);
console.log(`Top ${Math.min(TOP, rows.length)} by PnL:`);
console.log(`  rank  PnL($)    PF   Sharpe   DD($)     WR%   n      | config`);
for (let i = 0; i < Math.min(TOP, rows.length); i++) {
  const r = rows[i];
  console.log(`  ${String(i+1).padStart(4)}  ${String(Math.round(r.pnl)).padStart(8)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(8)}  ${r.wr.toFixed(1).padStart(5)}  ${String(r.n).padStart(5)}  | ${r.cfg}`);
}

// Also top by Sharpe
console.log(`\nTop 20 by Sharpe:`);
const byShar = [...rows].sort((a, b) => b.sharpe - a.sharpe).slice(0, 20);
for (const r of byShar) {
  console.log(`  ${String(Math.round(r.pnl)).padStart(8)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(8)}  ${r.wr.toFixed(1).padStart(5)}  | ${r.cfg}`);
}

// Write CSV
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
const csv = ['pnl,pf,sharpe,maxDD,wr,n,target,stop,beTrig,beOff,trTrig,trOff,cfg'];
for (const r of rows) {
  csv.push(`${r.pnl.toFixed(0)},${r.pf.toFixed(3)},${r.sharpe.toFixed(3)},${r.maxDD.toFixed(0)},${r.wr.toFixed(2)},${r.n},${r.target ?? ''},${r.stop ?? ''},${r.beTrig ?? ''},${r.beOff ?? ''},${r.trTrig ?? ''},${r.trOff ?? ''},"${r.cfg}"`);
}
fs.writeFileSync(OUT_PATH, csv.join('\n'));
console.log(`\nWrote ${OUT_PATH} (${rows.length} rows)`);
