/**
 * Phase 4 — Cartesian sweep of exit policies (no filters, just exits).
 *
 * Sweeps:
 *   A. Target/stop surface refinement (target 90/100/110/120 × stop 15/18/20/22/25)
 *      with no BE/trail. Confirms current 100/18 vs alternatives.
 *   B. Structural BE sweep (target 100, stop 18, BE trig × offset).
 *   C. MFT sweep (target 100, stop 18, mftFracTp × mftLockFrac).
 *   D. Trailing-stop sweep (target 100, stop 18, trTrig × trOff).
 *   E. Combined BE + trail.
 *   F. DR (double rejection) sweep.
 *   G. VR (velocity reversal) sweep.
 *   H. Wider target with BE (test the "wide target + BE protects mid-MFE" thesis).
 *
 * Reports top-N per family by PnL × Sharpe × DD trade-off.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulateAll, stats, GOLD_POLICY } from './02-sim-exits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk.json');
console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades: ${walks.length}\n`);

const results = [];

function run(label, cfg) {
  const r = simulateAll(walks, cfg);
  const st = stats(r);
  results.push({ label, cfg: { ...cfg, filterFn: undefined }, st });
  return st;
}

function fmt(st) {
  return `n=${String(st.n).padStart(3)} $${st.pnl.toFixed(0).padStart(6)} WR=${st.wr.toFixed(0).padStart(2)}% PF=${st.pf.toFixed(2)} Sh=${st.sharpe.toFixed(2)} DD=$${st.maxDD.toFixed(0).padStart(5)}`;
}

// Baseline
console.log('=== BASELINE (gold policy) ===');
const baseline = run('GOLD', { ...GOLD_POLICY });
console.log(`GOLD: ${fmt(baseline)}\n`);

// ── A. Target/stop surface ──
console.log('=== A. TARGET/STOP SURFACE ===');
const tgts = [80, 90, 100, 110, 120, 130, 150, 180, 200];
const stops = [10, 12, 15, 18, 20, 22, 25, 30];
const surfaceA = [];
for (const tgt of tgts) {
  for (const stp of stops) {
    const st = run(`A_t${tgt}_s${stp}`, { target: tgt, stop: stp, maxHoldMin: 180 });
    surfaceA.push({ tgt, stp, ...st });
  }
}
surfaceA.sort((a, b) => b.pnl - a.pnl);
console.log('Top 15 by PnL:');
surfaceA.slice(0, 15).forEach(r => console.log(`  t=${r.tgt} s=${r.stp}: ${fmt(r)}`));
surfaceA.sort((a, b) => b.sharpe - a.sharpe);
console.log('Top 10 by Sharpe:');
surfaceA.slice(0, 10).forEach(r => console.log(`  t=${r.tgt} s=${r.stp}: ${fmt(r)}`));
surfaceA.sort((a, b) => b.pf - a.pf);
console.log('Top 10 by PF:');
surfaceA.slice(0, 10).forEach(r => console.log(`  t=${r.tgt} s=${r.stp}: ${fmt(r)}`));
console.log('');

// ── B. Structural BE sweep (t=100, s=18) ──
console.log('=== B. STRUCTURAL BE (target=100, stop=18) ===');
const beTrigs  = [20, 30, 40, 50, 60, 70, 80, 90];
const beOffs   = [0, 5, 10, 15, 20];
const surfaceB = [];
for (const trig of beTrigs) {
  for (const off of beOffs) {
    const st = run(`B_be${trig}_${off}`, { target: 100, stop: 18, maxHoldMin: 180, beTrig: trig, beOff: off });
    surfaceB.push({ trig, off, ...st });
  }
}
surfaceB.sort((a, b) => b.pnl - a.pnl);
console.log('Top 15 by PnL:');
surfaceB.slice(0, 15).forEach(r => console.log(`  beTrig=${r.trig} beOff=${r.off}: ${fmt(r)}`));
surfaceB.sort((a, b) => b.sharpe - a.sharpe);
console.log('Top 10 by Sharpe:');
surfaceB.slice(0, 10).forEach(r => console.log(`  beTrig=${r.trig} beOff=${r.off}: ${fmt(r)}`));
console.log('');

// ── C. MFT sweep ──
console.log('=== C. MFT (target=100, stop=18) ===');
const fracTps = [0.4, 0.5, 0.6, 0.7, 0.8];
const lockFracs = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
const surfaceC = [];
for (const f of fracTps) {
  for (const l of lockFracs) {
    const st = run(`C_mft${f}_${l}`, { target: 100, stop: 18, maxHoldMin: 180, mftEnabled: true, mftFracTp: f, mftLockFrac: l });
    surfaceC.push({ f, l, ...st });
  }
}
surfaceC.sort((a, b) => b.pnl - a.pnl);
console.log('Top 10 by PnL:');
surfaceC.slice(0, 10).forEach(r => console.log(`  mft fracTp=${r.f} lock=${r.l}: ${fmt(r)}`));
surfaceC.sort((a, b) => b.sharpe - a.sharpe);
console.log('Top 10 by Sharpe:');
surfaceC.slice(0, 10).forEach(r => console.log(`  mft fracTp=${r.f} lock=${r.l}: ${fmt(r)}`));
console.log('');

// ── D. Trailing stop ──
console.log('=== D. TRAILING STOP (target=100, stop=18) ===');
const trTrigs = [30, 40, 50, 60, 70, 80];
const trOffs  = [10, 15, 20, 25, 30];
const surfaceD = [];
for (const tt of trTrigs) {
  for (const to of trOffs) {
    const st = run(`D_tr${tt}_${to}`, { target: 100, stop: 18, maxHoldMin: 180, trTrig: tt, trOff: to });
    surfaceD.push({ tt, to, ...st });
  }
}
surfaceD.sort((a, b) => b.pnl - a.pnl);
console.log('Top 10 by PnL:');
surfaceD.slice(0, 10).forEach(r => console.log(`  trTrig=${r.tt} trOff=${r.to}: ${fmt(r)}`));
surfaceD.sort((a, b) => b.sharpe - a.sharpe);
console.log('Top 10 by Sharpe:');
surfaceD.slice(0, 10).forEach(r => console.log(`  trTrig=${r.tt} trOff=${r.to}: ${fmt(r)}`));
console.log('');

// ── E. BE + Trail combined ──
console.log('=== E. BE + TRAIL COMBINED (target=100, stop=18) ===');
const eCombos = [
  { beTrig: 40, beOff: 5,  trTrig: 70, trOff: 25 },
  { beTrig: 40, beOff: 10, trTrig: 70, trOff: 25 },
  { beTrig: 50, beOff: 10, trTrig: 70, trOff: 20 },
  { beTrig: 50, beOff: 15, trTrig: 70, trOff: 20 },
  { beTrig: 60, beOff: 15, trTrig: 80, trOff: 20 },
  { beTrig: 40, beOff: 5,  trTrig: 80, trOff: 30 },
];
for (const cfg of eCombos) {
  const st = run(`E_${JSON.stringify(cfg).replace(/[\W]/g,'')}`, { target: 100, stop: 18, maxHoldMin: 180, ...cfg });
  console.log(`  BE ${cfg.beTrig}/+${cfg.beOff} + Trail ${cfg.trTrig}/${cfg.trOff}: ${fmt(st)}`);
}
console.log('');

// ── F. Double rejection ──
console.log('=== F. DOUBLE REJECTION (target=100, stop=18) ===');
const drCombos = [];
for (const fracTp of [0.4, 0.5, 0.6, 0.7]) {
  for (const tol of [1, 2, 3]) {
    for (const pull of [3, 5, 8]) {
      for (const action of ['close', 'tighten']) {
        drCombos.push({ drEnabled: true, drMfeFracTp: fracTp, drTolPts: tol, drPullbackMin: pull, drAction: action, drLockFrac: 0.5 });
      }
    }
  }
}
const surfaceF = [];
for (const cfg of drCombos) {
  const st = run(`F_${cfg.drMfeFracTp}_${cfg.drTolPts}_${cfg.drPullbackMin}_${cfg.drAction}`, { target: 100, stop: 18, maxHoldMin: 180, ...cfg });
  surfaceF.push({ cfg, ...st });
}
surfaceF.sort((a, b) => b.pnl - a.pnl);
console.log('Top 10 by PnL:');
surfaceF.slice(0, 10).forEach(r => console.log(`  dr fracTp=${r.cfg.drMfeFracTp} tol=${r.cfg.drTolPts} pull=${r.cfg.drPullbackMin} act=${r.cfg.drAction}: ${fmt(r)}`));
console.log('');

// ── G. Velocity reversal ──
console.log('=== G. VELOCITY REVERSAL (target=100, stop=18) ===');
const vrCombos = [];
for (const mfeMin of [20, 30, 40, 50]) {
  for (const plat of [30, 60, 120, 180]) {
    for (const adv of [3, 5, 8, 12]) {
      vrCombos.push({ vrEnabled: true, vrMfeMin: mfeMin, vrPlateauSec: plat, vrAdversePts: adv });
    }
  }
}
const surfaceG = [];
for (const cfg of vrCombos) {
  const st = run(`G_${cfg.vrMfeMin}_${cfg.vrPlateauSec}_${cfg.vrAdversePts}`, { target: 100, stop: 18, maxHoldMin: 180, ...cfg });
  surfaceG.push({ cfg, ...st });
}
surfaceG.sort((a, b) => b.pnl - a.pnl);
console.log('Top 10 by PnL:');
surfaceG.slice(0, 10).forEach(r => console.log(`  vr mfeMin=${r.cfg.vrMfeMin} plat=${r.cfg.vrPlateauSec}s adv=${r.cfg.vrAdversePts}: ${fmt(r)}`));
console.log('');

// ── H. Wider target with BE (the "fat tail" + structural BE thesis) ──
console.log('=== H. WIDER TARGET + BE (stop=18, maxHold=180) ===');
const hCombos = [];
for (const tgt of [120, 140, 160, 180, 200]) {
  for (const trig of [40, 50, 60, 70, 80]) {
    for (const off of [0, 10, 20]) {
      hCombos.push({ target: tgt, stop: 18, maxHoldMin: 180, beTrig: trig, beOff: off });
    }
  }
}
const surfaceH = [];
for (const cfg of hCombos) {
  const st = run(`H_t${cfg.target}_be${cfg.beTrig}_${cfg.beOff}`, cfg);
  surfaceH.push({ cfg, ...st });
}
surfaceH.sort((a, b) => b.pnl - a.pnl);
console.log('Top 15 by PnL:');
surfaceH.slice(0, 15).forEach(r => console.log(`  t=${r.cfg.target} be ${r.cfg.beTrig}/+${r.cfg.beOff}: ${fmt(r)}`));
surfaceH.sort((a, b) => b.sharpe - a.sharpe);
console.log('Top 10 by Sharpe:');
surfaceH.slice(0, 10).forEach(r => console.log(`  t=${r.cfg.target} be ${r.cfg.beTrig}/+${r.cfg.beOff}: ${fmt(r)}`));
console.log('');

// Save all results
fs.writeFileSync(path.join(__dirname, 'output', '04-sweep-exits.json'), JSON.stringify(results, null, 2));
console.log(`\nSwept ${results.length} configs. Wrote output/04-sweep-exits.json`);
