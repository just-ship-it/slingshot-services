#!/usr/bin/env node
/**
 * For every Schwab snapshot in a day-directory, run the live
 * ExposureCalculator wall-finding and emit a JSON of per-snapshot walls in
 * QQQ price space. Output mirrors the structure of nq_gex_YYYY-MM-DD.json
 * for direct minute-by-minute comparison against the backtest GEX.
 *
 * Usage:
 *   node scripts/calc-schwab-walls-day.js --date 2026-04-27 [--symbol QQQ]
 *
 * Output: data/schwab-walls/qqq_walls_YYYY-MM-DD.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExposureCalculator from '../../signal-generator/src/tradier/exposure-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_ROOT = path.join(__dirname, '..', 'data', 'schwab-snapshots');
const OUTPUT_ROOT = path.join(__dirname, '..', 'data', 'schwab-walls');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { symbol: 'QQQ' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) out.date = args[++i];
    if (args[i] === '--symbol' && args[i + 1]) out.symbol = args[++i];
  }
  return out;
}

/**
 * Estimate spot from put-call parity at the nearest-to-money strike of
 * the shortest expiration (matches verify-iv-parity.js).
 */
function estimateSpot(chain, asOf, riskFreeRate = 0.05) {
  const byStrike = new Map();
  for (const o of chain.options || []) {
    if (!o.strike || !o.option_type) continue;
    if (!(o.bid > 0) || !(o.ask > 0)) continue;
    if (!byStrike.has(o.strike)) byStrike.set(o.strike, {});
    const slot = byStrike.get(o.strike);
    if (o.option_type === 'call') slot.call = o;
    else slot.put = o;
  }

  const expDate = chain.expiration || (chain.options[0] && chain.options[0].expiration_date);
  if (!expDate) return null;
  const expMs = new Date(expDate + 'T16:00:00-05:00').getTime();
  const nowMs = asOf instanceof Date ? asOf.getTime() : (asOf ?? Date.now());
  const T = Math.max((expMs - nowMs) / (365 * 86400000), 1 / 365);
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

async function main() {
  const { date, symbol } = parseArgs();
  if (!date) {
    console.error('Usage: node calc-schwab-walls-day.js --date YYYY-MM-DD [--symbol QQQ]');
    process.exit(1);
  }

  const snapDir = path.join(SNAPSHOT_ROOT, date);
  if (!fs.existsSync(snapDir)) {
    console.error(`No snapshot dir: ${snapDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(snapDir)
    .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error(`No snapshots in ${snapDir}`);
    process.exit(1);
  }

  console.log(`Processing ${files.length} ${symbol} snapshots from ${date}`);

  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

  const calc = new ExposureCalculator({ riskFreeRate: 0.05 });
  const snapshots = [];
  let processed = 0, skipped = 0;

  for (const file of files) {
    const fullPath = path.join(snapDir, file);
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const chains = data.chains?.[symbol];
    if (!chains || chains.length === 0) { skipped++; continue; }

    const asOf = data.timestamp ? new Date(data.timestamp) : new Date();
    const spot = estimateSpot(chains[0], asOf);
    if (!spot) { skipped++; continue; }

    let result;
    try {
      const out = calc.calculateExposures({ [symbol]: chains }, { [symbol]: spot }, { asOf });
      result = out[symbol];
    } catch (err) {
      console.error(`  ${file}: calc error ${err.message}`);
      skipped++;
      continue;
    }
    if (!result || !result.levels) { skipped++; continue; }

    const lvls = result.levels;
    snapshots.push({
      timestamp: data.timestamp,
      qqq_spot: Number(spot.toFixed(2)),
      call_wall: lvls.callWall ?? null,
      put_wall: lvls.putWall ?? null,
      gamma_flip: lvls.gammaFlip ?? null,
      resistance: lvls.resistance ?? [],
      support: lvls.support ?? [],
      total_gex: result.totals?.gex ?? null,
      total_vex: result.totals?.vex ?? null,
      total_cex: result.totals?.cex ?? null,
      regime: result.regime?.gex ?? null,
      options_count: result.optionCount ?? null,
      // Provenance: which expiration the IV/atm was effectively driven by.
      // ExposureCalculator currently aggregates across all expirations, so
      // there's no single dte to record here — the comparison script handles
      // that by looking at the option_count and total_gex for sanity.
    });

    processed++;
    if (processed % 25 === 0) process.stdout.write(`  ${processed}/${files.length}\r`);
  }

  const outPath = path.join(OUTPUT_ROOT, `${symbol.toLowerCase()}_walls_${date}.json`);
  const output = {
    metadata: {
      symbol,
      date,
      generated: new Date().toISOString(),
      snapshots: snapshots.length,
      source: 'schwab-snapshots + live-ExposureCalculator'
    },
    data: snapshots
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nProcessed: ${processed}   Skipped: ${skipped}`);
  console.log(`Output: ${outPath}`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
