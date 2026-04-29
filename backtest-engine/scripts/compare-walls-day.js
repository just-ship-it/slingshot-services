#!/usr/bin/env node
/**
 * Side-by-side comparison of Schwab-derived walls (live ExposureCalculator)
 * vs backtest-derived walls (generate-intraday-gex.py) for a given day.
 *
 * For each backtest 15-min snapshot, finds the nearest Schwab snapshot
 * (within a 4-min window) and reports the diff in QQQ strike space.
 *
 * Usage:
 *   node scripts/compare-walls-day.js --date 2026-04-27
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) out.date = args[++i];
  }
  return out;
}

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }
function fmt(v, d = 2) { return v == null ? rpad('—', 8) : rpad(v.toFixed(d), 8); }

async function main() {
  const { date } = parseArgs();
  if (!date) { console.error('Usage: --date YYYY-MM-DD'); process.exit(1); }

  const btPath = path.join(DATA, 'gex', 'nq', `nq_gex_${date}.json`);
  const swPath = path.join(DATA, 'schwab-walls', `qqq_walls_${date}.json`);
  const bt = JSON.parse(fs.readFileSync(btPath, 'utf8'));
  const sw = JSON.parse(fs.readFileSync(swPath, 'utf8'));

  // Index Schwab snapshots by ms
  const swByMs = sw.data.map(r => ({ ...r, ms: new Date(r.timestamp).getTime() }));

  // Restrict to RTH window (13:30 → 20:00 UTC)
  const RTH_START = `${date}T13:30:00`;
  const RTH_END = `${date}T20:00:00`;

  console.log(`\nDay: ${date}`);
  console.log(`Backtest snapshots: ${bt.data.length} (15-min, NQ-space)`);
  console.log(`Schwab snapshots:   ${sw.data.length} (~2-min, QQQ-space)`);
  console.log(`\nWalls compared in QQQ strike space. Backtest walls divided by multiplier to recover QQQ strike.`);
  console.log(`Match window: backtest-time ± 4 minutes.\n`);

  // Header
  console.log(`time(UTC) | spot_bt  spot_sw  | call_bt  call_sw  Δ      | put_bt   put_sw   Δ      | flip_bt  flip_sw  | gex_bt(B) gex_sw(B) | regime_bt        regime_sw`);
  console.log('─'.repeat(155));

  let n = 0;
  const callDiffs = [], putDiffs = [], flipDiffs = [];
  const regimeMismatch = [];

  for (const b of bt.data) {
    if (b.timestamp < RTH_START || b.timestamp > RTH_END) continue;
    const bMs = new Date(b.timestamp).getTime();
    // Find nearest Schwab snapshot within ±4 min
    let nearest = null, nearestDiff = Infinity;
    for (const s of swByMs) {
      const dt = Math.abs(s.ms - bMs);
      if (dt < nearestDiff && dt <= 4 * 60 * 1000) {
        nearestDiff = dt;
        nearest = s;
      }
    }
    if (!nearest) continue;

    // Translate backtest walls back to QQQ space
    const mult = b.multiplier;
    const bCallQ = b.call_wall != null ? b.call_wall / mult : null;
    const bPutQ = b.put_wall != null ? b.put_wall / mult : null;
    const bFlipQ = b.gamma_flip != null ? b.gamma_flip / mult : null;

    // Schwab walls already in QQQ space
    const sCallQ = nearest.call_wall;
    const sPutQ = nearest.put_wall;
    const sFlipQ = nearest.gamma_flip;

    const dCall = (bCallQ != null && sCallQ != null) ? sCallQ - bCallQ : null;
    const dPut = (bPutQ != null && sPutQ != null) ? sPutQ - bPutQ : null;
    const dFlip = (bFlipQ != null && sFlipQ != null) ? sFlipQ - bFlipQ : null;

    if (dCall != null) callDiffs.push(dCall);
    if (dPut != null) putDiffs.push(dPut);
    if (dFlip != null) flipDiffs.push(dFlip);

    if (b.regime !== nearest.regime) {
      regimeMismatch.push({ time: b.timestamp.slice(11, 16), bt: b.regime, sw: nearest.regime });
    }

    const time = b.timestamp.slice(11, 16);
    console.log(
      `${time}     | ${fmt(b.qqq_spot)} ${fmt(nearest.qqq_spot)} | ${fmt(bCallQ)} ${fmt(sCallQ)} ${rpad(dCall != null ? dCall.toFixed(2) : '—', 6)} | ${fmt(bPutQ)} ${fmt(sPutQ)} ${rpad(dPut != null ? dPut.toFixed(2) : '—', 6)} | ${fmt(bFlipQ)} ${fmt(sFlipQ)} | ${fmt(b.total_gex / 1e9)} ${fmt(nearest.total_gex / 1e9)} | ${pad(b.regime, 16)} ${nearest.regime}`
    );
    n++;
  }

  // Aggregate stats
  function stats(arr, label) {
    if (arr.length === 0) return;
    const abs = arr.map(Math.abs).sort((a, b) => a - b);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
    const median = abs[Math.floor(abs.length / 2)];
    const max = abs[abs.length - 1];
    console.log(`  ${label.padEnd(16)} n=${arr.length}  mean=${mean.toFixed(2)}  mean|Δ|=${meanAbs.toFixed(2)}  median|Δ|=${median.toFixed(2)}  max|Δ|=${max.toFixed(2)}  (QQQ pts)`);
  }

  console.log(`\n═══ Summary (over ${n} matched RTH windows) ═══`);
  stats(callDiffs, 'Call wall Δ');
  stats(putDiffs, 'Put wall Δ');
  stats(flipDiffs, 'Gamma flip Δ');

  console.log(`\nRegime mismatches: ${regimeMismatch.length}/${n}`);
  for (const m of regimeMismatch.slice(0, 10)) {
    console.log(`  ${m.time}  bt=${m.bt}  sw=${m.sw}`);
  }

  // Convert QQQ deltas to NQ space using a representative multiplier
  const sampleMult = bt.data.find(d => d.multiplier)?.multiplier ?? 41.3;
  console.log(`\n(For NQ-space context, multiply Δ by ~${sampleMult.toFixed(1)})`);
  if (callDiffs.length > 0) {
    const mAbs = callDiffs.map(Math.abs).reduce((a, b) => a + b, 0) / callDiffs.length;
    console.log(`  Mean |call wall Δ| in NQ space: ~${(mAbs * sampleMult).toFixed(0)} NQ pts`);
  }
  if (putDiffs.length > 0) {
    const mAbs = putDiffs.map(Math.abs).reduce((a, b) => a + b, 0) / putDiffs.length;
    console.log(`  Mean |put wall Δ| in NQ space: ~${(mAbs * sampleMult).toFixed(0)} NQ pts`);
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
