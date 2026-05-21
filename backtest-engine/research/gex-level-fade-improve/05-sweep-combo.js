/**
 * Phase 5 — Fine-grained sweep around the t=110-150 / s=20-25 + BE + filter combos.
 *
 * Top-line from phase 4: target/stop expansion is the dominant lever.
 *   t=110 s=25:  $144,840 / Sharpe 3.66 / DD $11,330 (best risk-adj)
 *   t=110 s=22:  $137,515 / Sharpe 3.65 / DD $9,670  (lower DD)
 *   t=150 s=25:  $145,874 / Sharpe 3.21 / DD $17,460 (max PnL, worse DD)
 *
 * BE alone added marginal lift on tight stop (only sub-2k); we now test
 * BE/MFT on wider stop where mid-MFE protection should pay more.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulateAll, stats } from './02-sim-exits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = path.join(__dirname, 'output', '01-trades-walk.json');
console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades: ${walks.length}\n`);

const records = [];
function run(label, cfg) {
  const r = simulateAll(walks, cfg);
  const st = stats(r);
  records.push({ label, cfg, st });
  return st;
}

function fmt(st) {
  return `n=${String(st.n).padStart(3)} $${st.pnl.toFixed(0).padStart(6)} WR=${st.wr.toFixed(0).padStart(2)}% PF=${st.pf.toFixed(2)} Sh=${st.sharpe.toFixed(2)} DD=$${st.maxDD.toFixed(0).padStart(5)}`;
}

// ── Phase 5A — focused target × stop × BE 3D sweep ──
console.log('=== 5A. FOCUSED TARGET × STOP × BE ===');
const tgts = [100, 110, 120, 130, 140, 150];
const stops = [18, 20, 22, 25, 28, 30];
const beTrigs = [null, 50, 60, 70, 80, 90, 100];
const beOffs  = [0, 10, 20];
const surfA = [];
for (const tgt of tgts) {
  for (const stp of stops) {
    for (const trig of beTrigs) {
      const beOffsToTry = trig == null ? [null] : beOffs;
      for (const off of beOffsToTry) {
        const cfg = { target: tgt, stop: stp, maxHoldMin: 180 };
        if (trig != null) { cfg.beTrig = trig; cfg.beOff = off; }
        const st = run(`5A_t${tgt}_s${stp}_be${trig ?? 'X'}_${off ?? 'X'}`, cfg);
        surfA.push({ tgt, stp, trig, off, ...st });
      }
    }
  }
}
console.log(`Tested ${surfA.length} configs.\n`);

surfA.sort((a, b) => b.pnl - a.pnl);
console.log('Top 20 by PnL:');
surfA.slice(0, 20).forEach(r => console.log(`  t=${r.tgt} s=${r.stp} be=${r.trig ?? '-'}/${r.off ?? '-'}: ${fmt(r)}`));

surfA.sort((a, b) => b.sharpe - a.sharpe);
console.log('Top 20 by Sharpe:');
surfA.slice(0, 20).forEach(r => console.log(`  t=${r.tgt} s=${r.stp} be=${r.trig ?? '-'}/${r.off ?? '-'}: ${fmt(r)}`));

surfA.sort((a, b) => a.maxDD - b.maxDD);
console.log('Top 20 by Lowest DD (PnL ≥ $120k filter):');
surfA.filter(r => r.pnl >= 120000).slice(0, 20).forEach(r => console.log(`  t=${r.tgt} s=${r.stp} be=${r.trig ?? '-'}/${r.off ?? '-'}: ${fmt(r)}`));

// ── Phase 5B — explore maxHold (currently 180, can we go shorter or longer?) ──
console.log('\n=== 5B. MAX-HOLD SWEEP (t=110, s=25) ===');
for (const mh of [60, 90, 120, 150, 180, 200, 220]) {
  const st = run(`5B_mh${mh}`, { target: 110, stop: 25, maxHoldMin: mh });
  console.log(`  maxHold=${mh}min: ${fmt(st)}`);
}

console.log('\n=== 5B. MAX-HOLD SWEEP (t=120, s=22) ===');
for (const mh of [60, 90, 120, 150, 180, 200, 220]) {
  const st = run(`5B_t120s22_mh${mh}`, { target: 120, stop: 22, maxHoldMin: mh });
  console.log(`  maxHold=${mh}min: ${fmt(st)}`);
}

// ── Phase 5C — trail with wider stop+target ──
console.log('\n=== 5C. TRAIL on WIDER (t=120, s=25) ===');
for (const trig of [60, 70, 80, 90]) {
  for (const off of [20, 25, 30, 40]) {
    const st = run(`5C_tr${trig}_${off}`, { target: 120, stop: 25, maxHoldMin: 180, trTrig: trig, trOff: off });
    console.log(`  trTrig=${trig} trOff=${off}: ${fmt(st)}`);
  }
}

// ── Phase 5D — MFT with wider stop ──
console.log('\n=== 5D. MFT on WIDER (t=110, s=25) ===');
for (const f of [0.5, 0.6, 0.7, 0.8]) {
  for (const l of [0.2, 0.3, 0.5, 0.7]) {
    const st = run(`5D_mft${f}_${l}`, { target: 110, stop: 25, maxHoldMin: 180, mftEnabled: true, mftFracTp: f, mftLockFrac: l });
    console.log(`  mft fracTp=${f} lock=${l}: ${fmt(st)}`);
  }
}

fs.writeFileSync(path.join(__dirname, 'output', '05-sweep-combo.json'), JSON.stringify(records, null, 2));
console.log(`\nDone. ${records.length} configs. Wrote output/05-sweep-combo.json`);
