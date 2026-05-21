/**
 * Phase 3 — Sweep each market-aware mechanic on v3 trades.
 *
 * Goal: find mechanic + params that beat v3 baseline (sim $225,900 / PF 1.98 /
 * MaxDD $10,435 on the 553-trade set). All sweeps layer on top of v3's
 * per-rule baseline policy.
 *
 * Three mechanics from market-aware-exits-idea.md:
 *   (1) DOUBLE_REJECTION — touch MFE peak twice → close or tighten
 *   (2) MFE_FRAC_TP      — when MFE ≥ X% of TP, lock Y% of MFE
 *   (3) VELOCITY_REVERSAL — MFE plateau + adverse-bar spike → close
 *
 * Output: output/03-sweep-{dr, mft, vr}.csv (top configs per mechanic).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, simulateAll, stats, V3_POLICY } from './02-sim-market-aware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk-v3.json');
console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades: ${walks.length}`);

// Baseline (no mechanic)
const baseRes = simulateAll(walks, V3_POLICY, {});
const baseSt = stats(baseRes);
console.log(`\nBaseline: n=${baseSt.n} $${baseSt.pnl.toFixed(0)} WR=${baseSt.wr.toFixed(0)}% PF=${baseSt.pf.toFixed(2)} Sh=${baseSt.sharpe.toFixed(2)} DD=$${baseSt.maxDD.toFixed(0)}`);
console.log();

function evalCfg(cfg) {
  const res = simulateAll(walks, V3_POLICY, cfg);
  return stats(res);
}

function fmtRow(label, s) {
  const dPnL = s.pnl - baseSt.pnl;
  const dPF = s.pf - baseSt.pf;
  const dSh = s.sharpe - baseSt.sharpe;
  const dDD = s.maxDD - baseSt.maxDD;
  return `${label.padEnd(60)} n=${String(s.n).padStart(4)} $${s.pnl.toFixed(0).padStart(7)} (${(dPnL>=0?'+':'')+dPnL.toFixed(0).padStart(6)})  WR=${s.wr.toFixed(0)}%  PF=${s.pf.toFixed(2)} (${(dPF>=0?'+':'')+dPF.toFixed(2)})  Sh=${s.sharpe.toFixed(2)} (${(dSh>=0?'+':'')+dSh.toFixed(2)})  DD=$${s.maxDD.toFixed(0).padStart(6)} (${(dDD>=0?'+':'')+dDD.toFixed(0)})`;
}

// ─────────────────────────────────────────────────────────────────────
// Mechanic 1: DOUBLE_REJECTION
// ─────────────────────────────────────────────────────────────────────
console.log(`\n=== MECHANIC 1: DOUBLE_REJECTION ===`);
console.log(`Track MFE peak, detect 2nd touch after retrace, action = close or tighten.\n`);

const drResults = [];
const DR_FRAC_TP = [0.4, 0.5, 0.6, 0.7, 0.8];      // gate: arm when MFE ≥ X% of TP
const DR_TOL    = [1, 2, 3, 5];                     // pts within MFE peak = "touch"
const DR_PULL   = [3, 5, 8, 12, 18];                // pullback required before next touch counts
const DR_ACTIONS = ['close', 'tighten'];
const DR_LOCK_FRAC = [0.0, 0.3, 0.5, 0.7];          // for tighten: fraction of MFE locked

for (const fracTp of DR_FRAC_TP) {
  for (const tol of DR_TOL) {
    for (const pull of DR_PULL) {
      for (const action of DR_ACTIONS) {
        if (action === 'close') {
          const cfg = { drEnabled: true, drMfeFracTp: fracTp, drTolPts: tol, drPullbackMin: pull, drAction: 'close' };
          const st = evalCfg(cfg);
          drResults.push({ mech: 'DR', fracTp, tol, pull, action, lockFrac: null, ...st });
        } else {
          for (const lockFrac of DR_LOCK_FRAC) {
            const cfg = { drEnabled: true, drMfeFracTp: fracTp, drTolPts: tol, drPullbackMin: pull, drAction: 'tighten', drLockFrac: lockFrac };
            const st = evalCfg(cfg);
            drResults.push({ mech: 'DR', fracTp, tol, pull, action, lockFrac, ...st });
          }
        }
      }
    }
  }
}

const drByPnL = [...drResults].sort((a, b) => b.pnl - a.pnl);
const drBySh = [...drResults].sort((a, b) => b.sharpe - a.sharpe);
const drByPF = [...drResults].sort((a, b) => b.pf - a.pf);

console.log(`Sweep: ${drResults.length} configs\n`);
console.log(`Top 10 by PnL:`);
for (const r of drByPnL.slice(0, 10)) {
  console.log(fmtRow(`fracTp=${r.fracTp} tol=${r.tol} pull=${r.pull} act=${r.action}${r.lockFrac != null ? ` lock=${r.lockFrac}` : ''}`, r));
}
console.log(`\nTop 5 by Sharpe:`);
for (const r of drBySh.slice(0, 5)) {
  console.log(fmtRow(`fracTp=${r.fracTp} tol=${r.tol} pull=${r.pull} act=${r.action}${r.lockFrac != null ? ` lock=${r.lockFrac}` : ''}`, r));
}
console.log(`\nTop 5 by PF (n ≥ 400):`);
for (const r of drByPF.filter(r => r.n >= 400).slice(0, 5)) {
  console.log(fmtRow(`fracTp=${r.fracTp} tol=${r.tol} pull=${r.pull} act=${r.action}${r.lockFrac != null ? ` lock=${r.lockFrac}` : ''}`, r));
}

// CSV
{
  const cols = ['fracTp','tol','pull','action','lockFrac','n','pnl','wr','pf','sharpe','maxDD'];
  let csv = cols.join(',') + '\n';
  for (const r of drByPnL.slice(0, 200)) {
    csv += [r.fracTp, r.tol, r.pull, r.action, r.lockFrac ?? '', r.n, r.pnl.toFixed(0), r.wr.toFixed(2), r.pf.toFixed(3), r.sharpe.toFixed(3), r.maxDD.toFixed(0)].join(',') + '\n';
  }
  fs.writeFileSync(path.join(__dirname, 'output', '03-sweep-dr.csv'), csv);
}

// ─────────────────────────────────────────────────────────────────────
// Mechanic 2: MFE_FRAC_TP
// ─────────────────────────────────────────────────────────────────────
console.log(`\n\n=== MECHANIC 2: MFE_FRAC_TP (BE-style scaled by TP) ===`);
console.log(`When MFE ≥ fracTp × TP, set floor at lockFrac × MFE. Floor exits on retrace.\n`);

const mftResults = [];
const MFT_FRAC = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
const MFT_LOCK = [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];

for (const f of MFT_FRAC) {
  for (const l of MFT_LOCK) {
    const cfg = { mftEnabled: true, mftFracTp: f, mftLockFrac: l };
    const st = evalCfg(cfg);
    mftResults.push({ mech: 'MFT', fracTp: f, lockFrac: l, ...st });
  }
}

const mftByPnL = [...mftResults].sort((a, b) => b.pnl - a.pnl);
const mftBySh = [...mftResults].sort((a, b) => b.sharpe - a.sharpe);
const mftByPF = [...mftResults].sort((a, b) => b.pf - a.pf);

console.log(`Sweep: ${mftResults.length} configs\n`);
console.log(`Top 10 by PnL:`);
for (const r of mftByPnL.slice(0, 10)) {
  console.log(fmtRow(`fracTp=${r.fracTp} lock=${r.lockFrac}`, r));
}
console.log(`\nTop 5 by Sharpe:`);
for (const r of mftBySh.slice(0, 5)) {
  console.log(fmtRow(`fracTp=${r.fracTp} lock=${r.lockFrac}`, r));
}
console.log(`\nTop 5 by PF:`);
for (const r of mftByPF.slice(0, 5)) {
  console.log(fmtRow(`fracTp=${r.fracTp} lock=${r.lockFrac}`, r));
}

{
  const cols = ['fracTp','lockFrac','n','pnl','wr','pf','sharpe','maxDD'];
  let csv = cols.join(',') + '\n';
  for (const r of mftByPnL.slice(0, 100)) {
    csv += [r.fracTp, r.lockFrac, r.n, r.pnl.toFixed(0), r.wr.toFixed(2), r.pf.toFixed(3), r.sharpe.toFixed(3), r.maxDD.toFixed(0)].join(',') + '\n';
  }
  fs.writeFileSync(path.join(__dirname, 'output', '03-sweep-mft.csv'), csv);
}

// ─────────────────────────────────────────────────────────────────────
// Mechanic 3: VELOCITY_REVERSAL
// ─────────────────────────────────────────────────────────────────────
console.log(`\n\n=== MECHANIC 3: VELOCITY_REVERSAL (price-proxy, no volume) ===`);
console.log(`MFE plateau ≥ plateauSec + single-bar adverse move ≥ advPts → close.\n`);

const vrResults = [];
const VR_MFE  = [10, 15, 20, 25, 30, 40, 50];
const VR_PLAT = [15, 30, 60, 120, 300];   // seconds since last MFE peak
const VR_ADV  = [3, 5, 8, 12, 20];

for (const m of VR_MFE) {
  for (const p of VR_PLAT) {
    for (const a of VR_ADV) {
      const cfg = { vrEnabled: true, vrMfeMin: m, vrPlateauSec: p, vrAdversePts: a };
      const st = evalCfg(cfg);
      vrResults.push({ mech: 'VR', mfeMin: m, plateauSec: p, advPts: a, ...st });
    }
  }
}

const vrByPnL = [...vrResults].sort((a, b) => b.pnl - a.pnl);
const vrBySh = [...vrResults].sort((a, b) => b.sharpe - a.sharpe);

console.log(`Sweep: ${vrResults.length} configs\n`);
console.log(`Top 10 by PnL:`);
for (const r of vrByPnL.slice(0, 10)) {
  console.log(fmtRow(`mfe=${r.mfeMin} plat=${r.plateauSec}s adv=${r.advPts}`, r));
}
console.log(`\nTop 5 by Sharpe:`);
for (const r of vrBySh.slice(0, 5)) {
  console.log(fmtRow(`mfe=${r.mfeMin} plat=${r.plateauSec}s adv=${r.advPts}`, r));
}

{
  const cols = ['mfeMin','plateauSec','advPts','n','pnl','wr','pf','sharpe','maxDD'];
  let csv = cols.join(',') + '\n';
  for (const r of vrByPnL.slice(0, 100)) {
    csv += [r.mfeMin, r.plateauSec, r.advPts, r.n, r.pnl.toFixed(0), r.wr.toFixed(2), r.pf.toFixed(3), r.sharpe.toFixed(3), r.maxDD.toFixed(0)].join(',') + '\n';
  }
  fs.writeFileSync(path.join(__dirname, 'output', '03-sweep-vr.csv'), csv);
}

console.log(`\n\n=== SUMMARY ===`);
console.log(`Baseline v3:          ${fmtRow('', baseSt).trim()}`);
console.log(`DR best PnL:          ${fmtRow('', drByPnL[0]).trim()}`);
console.log(`DR best Sharpe:       ${fmtRow('', drBySh[0]).trim()}`);
console.log(`MFT best PnL:         ${fmtRow('', mftByPnL[0]).trim()}`);
console.log(`MFT best Sharpe:      ${fmtRow('', mftBySh[0]).trim()}`);
console.log(`VR best PnL:          ${fmtRow('', vrByPnL[0]).trim()}`);
console.log(`VR best Sharpe:       ${fmtRow('', vrBySh[0]).trim()}`);
