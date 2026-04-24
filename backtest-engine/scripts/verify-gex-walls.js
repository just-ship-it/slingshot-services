#!/usr/bin/env node
/**
 * Compare GEX wall-finding before/after the fix using saved Schwab snapshots.
 *
 * Runs the exposure-calculator's calculateExposures → findKeyLevels on a
 * snapshot and reports call_wall, put_wall, support, resistance.
 *
 * Usage:
 *   node scripts/verify-gex-walls.js [--snapshot <path>] [--symbol QQQ]
 *
 * Default: uses the most recent snapshot in data/schwab-snapshots/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExposureCalculator from '../../signal-generator/src/tradier/exposure-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_ROOT = path.join(__dirname, '..', 'data', 'schwab-snapshots');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { symbol: 'QQQ' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && args[i + 1]) out.snapshot = args[++i];
    if (args[i] === '--symbol' && args[i + 1]) out.symbol = args[++i];
  }
  return out;
}

function findLatestSnapshot() {
  const dirs = fs.readdirSync(SNAPSHOT_ROOT)
    .filter(d => d.startsWith('2026'))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const files = fs.readdirSync(path.join(SNAPSHOT_ROOT, dir))
      .filter(f => f.endsWith('.json') && f.startsWith('snapshot_'))
      .sort()
      .reverse();
    if (files.length > 0) return path.join(SNAPSHOT_ROOT, dir, files[0]);
  }
  return null;
}

function estimateSpot(chains) {
  // Simple: find option with smallest |bid - ask| near ATM as spot proxy
  const chain = chains[0];
  if (!chain?.options?.length) return null;
  let bestStrike = null, bestDelta = Infinity;
  for (const o of chain.options) {
    if (o.option_type !== 'call' || !o.bid || !o.ask) continue;
    const mid = (o.bid + o.ask) / 2;
    // Near ATM: intrinsic ≈ 0, so mid ≈ time value. ATM has highest time value.
    if (mid > 0 && o.strike > 0) {
      // Use put-call parity proxy: for closest-to-ATM, |delta| ≈ 0.5
      const delta = o.greeks?.delta;
      if (delta != null) {
        const d = Math.abs(Math.abs(delta) - 0.5);
        if (d < bestDelta) { bestDelta = d; bestStrike = o.strike; }
      }
    }
  }
  return bestStrike;
}

// OLD logic (highest OI) for comparison
function findKeyLevelsOLD(exposuresByStrike, spotPrice) {
  let callWall = null, putWall = null, maxCallOI = 0, maxPutOI = 0;
  for (const [strike, data] of exposuresByStrike) {
    if (data.callOI > maxCallOI) { maxCallOI = data.callOI; callWall = strike; }
    if (data.putOI > maxPutOI) { maxPutOI = data.putOI; putWall = strike; }
  }

  const resistance = Array.from(exposuresByStrike.keys())
    .filter(s => s > spotPrice)
    .map(s => ({ strike: s, score: exposuresByStrike.get(s).callOI + Math.abs(exposuresByStrike.get(s).gex) / 1e6 }))
    .sort((a, b) => b.score - a.score).slice(0, 5)
    .map(x => Math.round(x.strike)).sort((a, b) => a - b);

  const support = Array.from(exposuresByStrike.keys())
    .filter(s => s < spotPrice)
    .map(s => ({ strike: s, score: exposuresByStrike.get(s).putOI + Math.abs(exposuresByStrike.get(s).gex) / 1e6 }))
    .sort((a, b) => b.score - a.score).slice(0, 5)
    .map(x => Math.round(x.strike)).sort((a, b) => b - a);

  return { callWall, putWall, resistance, support };
}

async function main() {
  const args = parseArgs();
  const snapshotPath = args.snapshot || findLatestSnapshot();
  if (!snapshotPath) { console.error('No snapshot found'); process.exit(1); }

  console.log(`\nGEX Wall Comparison: OLD (highest OI) vs NEW (highest GEX magnitude)`);
  console.log(`Snapshot: ${snapshotPath}\n`);

  const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const chains = data.chains?.[args.symbol];
  if (!chains?.length) { console.error(`No ${args.symbol} chains in snapshot`); process.exit(1); }

  // Build chainsData in the format exposure calculator expects
  const chainsData = { [args.symbol]: chains };

  // Get spot price
  const spotPrice = estimateSpot(chains);
  console.log(`Spot estimate: ${spotPrice}\n`);

  // Run the exposure calculator (NEW logic — GEX magnitude walls)
  const calc = new ExposureCalculator({ riskFreeRate: 0.05 });
  const results = calc.calculateExposures(chainsData, { [args.symbol]: spotPrice });
  const qqqResult = results[args.symbol];

  if (!qqqResult) { console.error('Exposure calculation returned no results'); process.exit(1); }

  // Extract exposuresByStrike for OLD comparison
  const exposuresByStrike = new Map(Object.entries(qqqResult.exposuresByStrike).map(([k, v]) => [parseFloat(k), v]));

  const newLevels = qqqResult.levels;
  const oldLevels = findKeyLevelsOLD(exposuresByStrike, spotPrice);

  console.log('═══ WALL COMPARISON ═══');
  console.log(`                    OLD (highest OI)    NEW (highest GEX)    Δ from spot`);
  console.log(`Call Wall:          ${String(oldLevels.callWall).padStart(8)}            ${String(newLevels.callWall).padStart(8)}            OLD: ${oldLevels.callWall ? (oldLevels.callWall - spotPrice).toFixed(0) : 'n/a'}  NEW: ${newLevels.callWall ? (newLevels.callWall - spotPrice).toFixed(0) : 'n/a'}`);
  console.log(`Put Wall:           ${String(oldLevels.putWall).padStart(8)}            ${String(newLevels.putWall).padStart(8)}            OLD: ${oldLevels.putWall ? (oldLevels.putWall - spotPrice).toFixed(0) : 'n/a'}  NEW: ${newLevels.putWall ? (newLevels.putWall - spotPrice).toFixed(0) : 'n/a'}`);

  console.log(`\n═══ RESISTANCE LEVELS ═══`);
  console.log(`OLD (OI+GEX scored): ${oldLevels.resistance.join(', ')}`);
  console.log(`NEW (GEX magnitude): ${newLevels.resistance.join(', ')}`);

  console.log(`\n═══ SUPPORT LEVELS ═══`);
  console.log(`OLD (OI+GEX scored): ${oldLevels.support.join(', ')}`);
  console.log(`NEW (GEX magnitude): ${newLevels.support.join(', ')}`);

  console.log(`\n═══ AGGREGATE ═══`);
  console.log(`Total GEX: ${(qqqResult.totals.gex / 1e9).toFixed(2)}B`);
  console.log(`Regime: ${qqqResult.regime.gex}`);
  console.log(`Options processed: ${qqqResult.optionCount}`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
