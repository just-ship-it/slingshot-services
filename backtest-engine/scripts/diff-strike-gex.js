#!/usr/bin/env node
/**
 * Diagnostic: per-strike GEX comparison for a single snapshot timestamp.
 *
 * Loads one Schwab snapshot and computes exposuresByStrike via the live
 * ExposureCalculator. Loads the matching backtest GEX snapshot and dumps
 * the support/resistance arrays. Diffs each strike's GEX magnitude to
 * locate where the put_wall / gamma_flip divergence originates.
 *
 * Usage:
 *   node scripts/diff-strike-gex.js --date 2026-04-29 --time 14:30
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExposureCalculator from '../../signal-generator/src/tradier/exposure-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) out.date = args[++i];
    if (args[i] === '--time' && args[i + 1]) out.time = args[++i];
  }
  return out;
}

const { date, time } = parseArgs();
if (!date || !time) {
  console.error('Usage: --date YYYY-MM-DD --time HH:MM');
  process.exit(1);
}

// 1. Find nearest Schwab snapshot to the requested time
const snapDir = path.join(DATA, 'schwab-snapshots', date);
const targetMs = new Date(`${date}T${time}:00Z`).getTime();
const files = fs.readdirSync(snapDir).filter((f) => f.startsWith('snapshot_'));
let nearest = null, nearestDiff = Infinity;
for (const f of files) {
  const t = f.slice(9, 17).replace(/-/g, ':'); // "13-30-58" -> "13:30:58"
  const ms = new Date(`${date}T${t}Z`).getTime();
  const dt = Math.abs(ms - targetMs);
  if (dt < nearestDiff) { nearestDiff = dt; nearest = f; }
}
const snapPath = path.join(snapDir, nearest);
console.log(`Using snapshot: ${nearest} (${(nearestDiff / 60000).toFixed(1)} min from target)`);

const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const qqqChains = snap.chains?.QQQ || [];
console.log(`QQQ chains: ${qqqChains.length} expirations, ${qqqChains.reduce((s, c) => s + c.options.length, 0)} options`);

// 2. Estimate spot from put-call parity at near-money first expiration (matches calc-schwab-walls-day.js)
function estimateSpot(chain, asOfMs, riskFreeRate = 0.05) {
  const byStrike = new Map();
  for (const o of chain.options || []) {
    if (!o.strike || !o.option_type || !(o.bid > 0) || !(o.ask > 0)) continue;
    if (!byStrike.has(o.strike)) byStrike.set(o.strike, {});
    const slot = byStrike.get(o.strike);
    if (o.option_type === 'call') slot.call = o; else slot.put = o;
  }
  const expDate = chain.expiration || chain.options[0]?.expiration_date;
  if (!expDate) return null;
  const expMs = new Date(expDate + 'T16:00:00-05:00').getTime();
  const T = Math.max((expMs - asOfMs) / (365 * 86400000), 1 / 365);
  const dfInv = Math.exp(riskFreeRate * T);
  let best = null, bestDelta = Infinity;
  for (const [K, slot] of byStrike) {
    if (!slot.call || !slot.put) continue;
    const cMid = (slot.call.bid + slot.call.ask) / 2;
    const pMid = (slot.put.bid + slot.put.ask) / 2;
    if (!(cMid > 0) || !(pMid > 0)) continue;
    const s = K + dfInv * (cMid - pMid);
    const delta = Math.abs(s - K);
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }
  return best;
}

const asOfMs = new Date(snap.timestamp).getTime();
const qqqSpot = estimateSpot(qqqChains[0], asOfMs);
console.log(`QQQ spot (parity): ${qqqSpot.toFixed(2)}`);

// 3. Run ExposureCalculator on the Schwab chain
const calc = new ExposureCalculator();
const result = calc.calculateExposures({ QQQ: qqqChains }, { QQQ: qqqSpot });
const ebs = result.QQQ.exposuresByStrike;
console.log(`Live exposuresByStrike: ${Object.keys(ebs).length} strikes`);

// 4. Load matching backtest snapshot
const btFile = path.join(DATA, 'gex', 'nq-cbbo', `nq_gex_${date}.json`);
const bt = JSON.parse(fs.readFileSync(btFile, 'utf8'));
const btSnaps = bt.data;
let btNearest = null, btDiff = Infinity;
for (const s of btSnaps) {
  const dt = Math.abs(new Date(s.timestamp).getTime() - asOfMs);
  if (dt < btDiff) { btDiff = dt; btNearest = s; }
}
console.log(`\nBacktest snapshot at ${btNearest.timestamp.slice(11, 16)} (${(btDiff / 60000).toFixed(1)} min from Schwab snapshot)`);
console.log(`Backtest qqq_spot: ${btNearest.qqq_spot}`);
console.log(`Backtest multiplier: ${btNearest.multiplier?.toFixed(4)}`);

// 5. Compare key strikes around spot ± 10%
const lo = qqqSpot * 0.9, hi = qqqSpot * 1.1;
const liveStrikes = Object.keys(ebs).map(Number).filter((s) => s >= lo && s <= hi).sort((a, b) => a - b);

// Translate backtest support[]/resistance[] (NQ space) back to QQQ
const btMult = btNearest.multiplier;
const btSupportQ = (btNearest.support || []).map((s) => s / btMult);
const btResistanceQ = (btNearest.resistance || []).map((s) => s / btMult);
const btSupportGex = btNearest.support_gex || [];
const btResistanceGex = btNearest.resistance_gex || [];

// Build a QQQ-strike → backtest GEX map (positive for resistance, negative for support)
const btByStrike = new Map();
for (let i = 0; i < btSupportQ.length; i++) btByStrike.set(Math.round(btSupportQ[i] * 1000) / 1000, btSupportGex[i]);
for (let i = 0; i < btResistanceQ.length; i++) btByStrike.set(Math.round(btResistanceQ[i] * 1000) / 1000, btResistanceGex[i]);

console.log(`\nLive vs Backtest per-strike GEX (top-5 support + top-5 resistance, in QQQ space):`);
console.log(`${'strike'.padStart(7)}  ${'live_gex'.padStart(14)}  ${'bt_gex'.padStart(14)}  ${'diff'.padStart(14)}  ${'sign'.padStart(5)}`);
console.log('─'.repeat(70));

// List the strikes that backtest considers walls (top-5 each side)
const btKeyStrikes = [...btByStrike.keys()].sort((a, b) => a - b);
for (const k of btKeyStrikes) {
  const liveStrike = liveStrikes.find((s) => Math.abs(s - k) < 0.5);
  const liveGex = liveStrike != null ? ebs[liveStrike].gex : null;
  const btGex = btByStrike.get(k);
  const diff = liveGex != null ? liveGex - btGex : null;
  const sign = btGex > 0 ? 'R' : 'S';
  console.log(`${k.toFixed(2).padStart(7)}  ${liveGex != null ? (liveGex / 1e6).toFixed(2).padStart(11) + 'M' : '       —    '}  ${(btGex / 1e6).toFixed(2).padStart(11)}M  ${diff != null ? (diff / 1e6).toFixed(2).padStart(11) + 'M' : '       —    '}  ${sign.padStart(5)}`);
}

// Also list live's view of strikes that backtest DIDN'T put in top-5 but live considers significant
const liveTopNeg = liveStrikes
  .filter((s) => ebs[s].gex < 0 && s < qqqSpot)
  .sort((a, b) => ebs[a].gex - ebs[b].gex)  // most negative first
  .slice(0, 7);
const liveTopPos = liveStrikes
  .filter((s) => ebs[s].gex > 0 && s > qqqSpot)
  .sort((a, b) => ebs[b].gex - ebs[a].gex)  // most positive first
  .slice(0, 7);

console.log(`\nLive top-7 NEGATIVE GEX strikes below spot (live's putwall candidates):`);
for (const s of liveTopNeg) {
  console.log(`  ${s.toFixed(2)}  live_gex=${(ebs[s].gex / 1e6).toFixed(2)}M  callOI=${ebs[s].callOI}  putOI=${ebs[s].putOI}`);
}
console.log(`\nLive top-7 POSITIVE GEX strikes above spot (live's callwall candidates):`);
for (const s of liveTopPos) {
  console.log(`  ${s.toFixed(2)}  live_gex=${(ebs[s].gex / 1e6).toFixed(2)}M  callOI=${ebs[s].callOI}  putOI=${ebs[s].putOI}`);
}

console.log(`\nLive walls picked: putWall=${result.QQQ.keyLevels.putWall}, callWall=${result.QQQ.keyLevels.callWall}, gammaFlip=${result.QQQ.keyLevels.gammaFlip}`);
console.log(`Backtest walls (QQQ space): putWall=${(btNearest.put_wall / btMult).toFixed(2)}, callWall=${(btNearest.call_wall / btMult).toFixed(2)}, gammaFlip=${(btNearest.gamma_flip / btMult).toFixed(2)}`);
