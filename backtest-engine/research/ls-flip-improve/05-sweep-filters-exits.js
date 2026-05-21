/**
 * Phase 5 — Combined filter × exit sweep.
 *
 * For each (filter_set × exit_cfg) combo, compute stats. Filters subtract
 * trades from the dataset (rejected entries). Exits change PnL on surviving
 * trades.
 *
 * Filter sets:
 *   - hours: list of allowed ET hours (negative-expectancy hours dropped)
 *   - minRange: skip trades with triggerBarRange < N
 *   - rangeRatioMin / rangeRatioMax: keep trades within range
 *   - cbAtrMin / cbAtrMax: secondary cb_atr filter
 *
 * Compares to baseline (no filter), reports lift in PnL / Sharpe / PF.
 *
 * Usage:
 *   node 05-sweep-filters-exits.js
 *   node 05-sweep-filters-exits.js --top 30
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
function flag(name) { return process.argv.includes(`--${name}`); }

const WALK_PATH = arg('walk', path.join(__dirname, 'output', '01-trades-walk.json'));
const TOP = +arg('top', '30');
const OUT_PATH = arg('out', path.join(__dirname, 'output', '05-sweep-filters-exits.csv'));
const MAX_HOLD_MIN = +arg('max-hold', '60');
const SLIP_PTS = +arg('slip', '0.25');
const POINT_VALUE = +arg('point-value', '20');
const COMMISSION = +arg('commission', '5');

console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades total: ${walks.length}`);
const maxHoldMs = MAX_HOLD_MIN * 60_000;

function simulate(e, cfg) {
  const origTgt = e.side === 'buy' ? (e.tp - e.entry) : (e.entry - e.tp);
  const origStp = e.side === 'buy' ? (e.entry - e.sl) : (e.sl - e.entry);
  const tgt = cfg.target == null ? origTgt : cfg.target;
  const stp = cfg.stop == null ? origStp : cfg.stop;
  let mfePeak = 0, mae = 0, beActive = false, trActive = false;
  const walk = e.walk;
  for (let i = 0; i < walk.length; i++) {
    const s = walk[i]; const t = s[0] * 1000;
    const hi = s[1], lo = s[2], c = s[3];
    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;
    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;
    if (mae >= stp) return { exit: 'stop', pnl: -(stp + SLIP_PTS), durationMs: t, mfe: mfePeak };
    if (mfePeak >= tgt) return { exit: 'target', pnl: tgt, durationMs: t, mfe: mfePeak };
    if (beActive && lo <= cfg.beOff) return { exit: 'be', pnl: cfg.beOff, durationMs: t, mfe: mfePeak };
    if (trActive) {
      const lvl = mfePeak - cfg.trOff;
      if (lo <= lvl) return { exit: 'trail', pnl: lvl - SLIP_PTS, durationMs: t, mfe: mfePeak };
    }
    if (t > maxHoldMs) return { exit: 'maxhold', pnl: c, durationMs: maxHoldMs, mfe: mfePeak };
  }
  if (e.terminal === 'eod' && e.eodPrice != null) {
    const pnl = e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice);
    return { exit: 'eod', pnl, durationMs: e.finalTs - e.fillTs, mfe: mfePeak };
  }
  const last = walk[walk.length - 1];
  return { exit: e.terminal || 'final', pnl: last ? last[3] : 0, durationMs: last ? last[0]*1000 : 0, mfe: mfePeak };
}

function statsFor(results) {
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
  const equity = []; let cum = 0;
  for (const r of results) {
    const d = r.pnl * POINT_VALUE - COMMISSION;
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
  for (const r of results) { const d = r.pnl * POINT_VALUE - COMMISSION; varSum += (d - mean) ** 2; }
  const sd = Math.sqrt(varSum / results.length);
  const perT = sd > 0 ? mean / sd : 0;
  const tradesPerYear = results.length / (16 / 12);
  return { pnl, wins, losses, wr, pf, maxDD, sharpe: perT * Math.sqrt(tradesPerYear), n: results.length };
}

// Pre-simulate ALL trades with each exit config, then filter+aggregate
const EXIT_CFGS = [
  // (label, target, stop, beTrig, beOff, trTrig, trOff)
  // Original
  { label: 'orig',                         target: null, stop: null, beTrig: null, beOff: 0,  trTrig: null, trOff: null },
  // High-PnL configs from sweep
  { label: 'tgt30_orig_be0_trN',           target: 30,   stop: null, beTrig: null, beOff: 0,  trTrig: null, trOff: null },
  { label: 'tgt15_stp8_be0_trN',           target: 15,   stop: 8,    beTrig: null, beOff: 0,  trTrig: null, trOff: null },
  { label: 'tgt20_stp8_be0_trN',           target: 20,   stop: 8,    beTrig: null, beOff: 0,  trTrig: null, trOff: null },
  { label: 'tgt15_stp8_be6off2',           target: 15,   stop: 8,    beTrig: 6,    beOff: 2,  trTrig: null, trOff: null },
  { label: 'tgt15_stp8_be8off3',           target: 15,   stop: 8,    beTrig: 8,    beOff: 3,  trTrig: null, trOff: null },
  { label: 'tgt12_stp8_be8off3',           target: 12,   stop: 8,    beTrig: 8,    beOff: 3,  trTrig: null, trOff: null },
  { label: 'tgt30_stp8_be6off2',           target: 30,   stop: 8,    beTrig: 6,    beOff: 2,  trTrig: null, trOff: null },
  { label: 'tgt30_stp8_be8off3',           target: 30,   stop: 8,    beTrig: 8,    beOff: 3,  trTrig: null, trOff: null },
  // Wider with trail
  { label: 'tgt30_stp8_be0_tr10off4',      target: 30,   stop: 8,    beTrig: null, beOff: 0,  trTrig: 10,   trOff: 4 },
  { label: 'tgt30_stp8_be0_tr15off7',      target: 30,   stop: 8,    beTrig: null, beOff: 0,  trTrig: 15,   trOff: 7 },
  { label: 'tgt30_orig_be0_tr10off4',      target: 30,   stop: null, beTrig: null, beOff: 0,  trTrig: 10,   trOff: 4 },
  // Tight + BE
  { label: 'orig_stp8_be4off2_tr12off5',   target: null, stop: 8,    beTrig: 4,    beOff: 2,  trTrig: 12,   trOff: 5 },
  { label: 'orig_stp8_be0_tr12off5',       target: null, stop: 8,    beTrig: null, beOff: 0,  trTrig: 12,   trOff: 5 },
  // High WR balanced
  { label: 'tgt10_stp8_be8off3',           target: 10,   stop: 8,    beTrig: 8,    beOff: 3,  trTrig: null, trOff: null },
  { label: 'tgt12_stp6_be6off3',           target: 12,   stop: 6,    beTrig: 6,    beOff: 3,  trTrig: null, trOff: null },
];

const FILTER_SETS = [
  { label: 'none',                     hours: null, minRange: null, rrMin: null, rrMax: null },
  // Time filters
  { label: 'hours06_15',               hours: [6,7,8,9,10,11,12,13,14,15],  minRange: null, rrMin: null, rrMax: null },
  { label: 'hours07_15',               hours: [7,8,9,10,11,12,13,14,15],    minRange: null, rrMin: null, rrMax: null },
  { label: 'hours08_15',               hours: [8,9,10,11,12,13,14,15],      minRange: null, rrMin: null, rrMax: null },
  { label: 'hours09_15',               hours: [9,10,11,12,13,14,15],        minRange: null, rrMin: null, rrMax: null },
  { label: 'hours09_14',               hours: [9,10,11,12,13,14],           minRange: null, rrMin: null, rrMax: null },
  { label: 'noAsia',                   hours: [0,1,2,3,4,6,7,8,9,10,11,12,13,14,15], minRange: null, rrMin: null, rrMax: null }, // drops 16-23 + 5
  // Range filters
  { label: 'range_ge3',                hours: null, minRange: 3,  rrMin: null, rrMax: null },
  { label: 'range_ge5',                hours: null, minRange: 5,  rrMin: null, rrMax: null },
  { label: 'range_ge7',                hours: null, minRange: 7,  rrMin: null, rrMax: null },
  // RangeRatio sweet spot
  { label: 'rr_05_15',                 hours: null, minRange: null, rrMin: 0.5, rrMax: 1.5 },
  { label: 'rr_05_20',                 hours: null, minRange: null, rrMin: 0.5, rrMax: 2.0 },
  // Combined
  { label: 'noAsia+range_ge3',         hours: [0,1,2,3,4,6,7,8,9,10,11,12,13,14,15], minRange: 3,  rrMin: null, rrMax: null },
  { label: 'noAsia+range_ge5',         hours: [0,1,2,3,4,6,7,8,9,10,11,12,13,14,15], minRange: 5,  rrMin: null, rrMax: null },
  { label: 'noAsia+rr_05_15',          hours: [0,1,2,3,4,6,7,8,9,10,11,12,13,14,15], minRange: null, rrMin: 0.5, rrMax: 1.5 },
  { label: 'hours09_15+range_ge5',     hours: [9,10,11,12,13,14,15],        minRange: 5,  rrMin: null, rrMax: null },
  { label: 'hours09_15+range_ge3',     hours: [9,10,11,12,13,14,15],        minRange: 3,  rrMin: null, rrMax: null },
  { label: 'hours09_15+rr_05_15',      hours: [9,10,11,12,13,14,15],        minRange: null, rrMin: 0.5, rrMax: 1.5 },
  { label: 'hours07_15+range_ge3',     hours: [7,8,9,10,11,12,13,14,15],    minRange: 3,  rrMin: null, rrMax: null },
  { label: 'hours07_15+range_ge5',     hours: [7,8,9,10,11,12,13,14,15],    minRange: 5,  rrMin: null, rrMax: null },
  { label: 'hours07_15+rr_05_15',     hours: [7,8,9,10,11,12,13,14,15],    minRange: null, rrMin: 0.5, rrMax: 1.5 },
  { label: 'hours06_15+range_ge5+rr_05_15', hours: [6,7,8,9,10,11,12,13,14,15], minRange: 5, rrMin: 0.5, rrMax: 1.5 },
];

function passesFilter(w, f) {
  if (f.hours && !f.hours.includes(w.hourEt)) return false;
  if (f.minRange != null && w.triggerBarRange != null && w.triggerBarRange < f.minRange) return false;
  if (f.rrMin != null && w.rangeRatio != null && w.rangeRatio < f.rrMin) return false;
  if (f.rrMax != null && w.rangeRatio != null && w.rangeRatio > f.rrMax) return false;
  return true;
}

console.log(`Exit cfgs: ${EXIT_CFGS.length}  Filters: ${FILTER_SETS.length}  Combos: ${EXIT_CFGS.length * FILTER_SETS.length}`);

// Pre-compute simulator results per exit cfg for ALL trades
const resultsByCfg = new Map();
const tStart = Date.now();
for (const cfg of EXIT_CFGS) {
  const arr = walks.map(w => ({ pnl: simulate(w, cfg).pnl, w }));
  resultsByCfg.set(cfg.label, { cfg, arr });
}
console.log(`Simulated ${EXIT_CFGS.length} cfgs in ${((Date.now()-tStart)/1000).toFixed(1)}s`);

// For each (filter, cfg) compute stats
const rows = [];
for (const f of FILTER_SETS) {
  for (const cfg of EXIT_CFGS) {
    const { arr } = resultsByCfg.get(cfg.label);
    const filtered = arr.filter(r => passesFilter(r.w, f)).map(r => ({ pnl: r.pnl }));
    if (filtered.length === 0) continue;
    const st = statsFor(filtered);
    rows.push({ filter: f.label, exit: cfg.label, n: st.n, pnl: st.pnl, pf: st.pf, sharpe: st.sharpe, maxDD: st.maxDD, wr: st.wr });
  }
}

// Sort by PnL
rows.sort((a, b) => b.pnl - a.pnl);
console.log(`\nTop ${TOP} by PnL:`);
console.log(`  rank  PnL($)    PF   Sharpe  DD($)    WR%   n       | filter / exit`);
for (let i = 0; i < Math.min(TOP, rows.length); i++) {
  const r = rows[i];
  console.log(`  ${String(i+1).padStart(4)}  ${String(Math.round(r.pnl)).padStart(8)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(6)}  ${r.wr.toFixed(1).padStart(5)}  ${String(r.n).padStart(6)}  | ${r.filter} / ${r.exit}`);
}

console.log(`\nTop 15 by Sharpe (min n=200):`);
const byShar = [...rows].filter(r => r.n >= 200).sort((a, b) => b.sharpe - a.sharpe).slice(0, 15);
for (const r of byShar) {
  console.log(`  ${String(Math.round(r.pnl)).padStart(8)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(6)}  ${r.wr.toFixed(1).padStart(5)}  ${String(r.n).padStart(6)}  | ${r.filter} / ${r.exit}`);
}

fs.writeFileSync(OUT_PATH, 'pnl,pf,sharpe,maxDD,wr,n,filter,exit\n' +
  rows.map(r => `${r.pnl.toFixed(0)},${r.pf.toFixed(3)},${r.sharpe.toFixed(3)},${r.maxDD.toFixed(0)},${r.wr.toFixed(2)},${r.n},${r.filter},${r.exit}`).join('\n'));
console.log(`\nWrote ${OUT_PATH}`);
