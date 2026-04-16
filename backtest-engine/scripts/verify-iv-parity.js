#!/usr/bin/env node
/**
 * IV Parity Harness
 *
 * Replays saved Schwab options-chain snapshots through both the backtest
 * IV calculator (calculateATMIVFromQuotes from shared/utils/black-scholes)
 * and the live IVSkewCalculator wrapper, then asserts the outputs match
 * within numerical tolerance.
 *
 * Why this exists: on 2026-04-15 the live iv-skew-gex strategy diverged
 * from its backtest twin because the live calculator and the backtest
 * precompute were quietly using different chain selection logic AND the
 * Schwab chain fetch was returning a degenerate subset of expirations.
 * Both code paths now share calculateATMIVFromQuotes, but this harness is
 * the only thing that proves they actually emit identical IV/skew on
 * identical input chains. Run it after any change to chain plumbing or
 * IV calculation before re-enabling live trading.
 *
 * Usage:
 *   node scripts/verify-iv-parity.js [--symbol QQQ] [--snapshots <dir-or-glob>]
 *
 * Default: walks backtest-engine/data/schwab-snapshots/ and tests every
 * snapshot it finds for the requested symbol. Exits non-zero on any
 * mismatch beyond tolerance.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { calculateATMIVFromQuotes } from '../../shared/utils/black-scholes.js';
import IVSkewCalculator from '../../signal-generator/src/tradier/iv-skew-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_ROOT = path.join(__dirname, '..', 'data', 'schwab-snapshots');

const TOLERANCE = 1e-6;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { symbol: 'QQQ', snapshotDir: SNAPSHOT_ROOT };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbol' && args[i + 1]) { out.symbol = args[++i]; continue; }
    if (args[i] === '--snapshots' && args[i + 1]) { out.snapshotDir = args[++i]; continue; }
  }
  return out;
}

function findSnapshotFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile() && root.endsWith('.json')) return [root];
  if (!stat.isDirectory()) return out;

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(p); continue; }
      if (entry.isFile() && entry.name.endsWith('.json') && entry.name.startsWith('snapshot_')) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

/**
 * Estimate spot from put-call parity at the nearest-to-money strike of the
 * shortest expiration. Avoids needing a separate quote feed in the harness.
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
    // S ≈ K + e^(rT) * (C - P)
    const s = K + dfInv * (cMid - pMid);
    const delta = Math.abs(s - K);
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }
  return best;
}

function runBacktest(chains, spotPrice, asOf) {
  const flat = [];
  for (const chain of chains) {
    if (!chain.options) continue;
    for (const o of chain.options) {
      if (!o || !o.strike || !o.option_type || !o.expiration_date) continue;
      flat.push({
        symbol: o.symbol,
        strike: o.strike,
        optionType: o.option_type === 'call' ? 'C' : 'P',
        expiration: new Date(o.expiration_date + 'T16:00:00-05:00'),
        bid: o.bid,
        ask: o.ask
      });
    }
  }
  return calculateATMIVFromQuotes(flat, spotPrice, asOf);
}

function runLive(chains, spotPrice, symbol, asOf) {
  // Adapt chain shape: live calculator reads chainsData[symbol] = [chains].
  // Snapshots store chains under .chains[symbol], where each chain's options
  // already carry option.expiration_date — that's what _flattenChains needs.
  const calc = new IVSkewCalculator({ symbol, publishToRedis: false });
  return calc.calculateIVSkew(spotPrice, { [symbol]: chains }, asOf);
}

function compare(label, bt, live) {
  if (!bt || !live) {
    return { ok: false, reason: `null result (backtest=${!!bt}, live=${!!live})` };
  }
  const fields = ['callIV', 'putIV', 'iv', 'atmStrike', 'dte', 'callDTE', 'putDTE'];
  const skewBt = bt.putIV - bt.callIV;
  const skewLive = live.skew;
  const diffs = [];
  for (const f of fields) {
    const a = bt[f], b = live[f];
    if (a == null && b == null) continue;
    if (a == null || b == null) { diffs.push(`${f}: backtest=${a}, live=${b}`); continue; }
    const d = Math.abs(a - b);
    if (d > TOLERANCE) diffs.push(`${f}: backtest=${a}, live=${b}, diff=${d}`);
  }
  const skewDiff = Math.abs(skewBt - skewLive);
  if (skewDiff > TOLERANCE) diffs.push(`skew: backtest=${skewBt}, live=${skewLive}, diff=${skewDiff}`);
  return diffs.length === 0
    ? { ok: true, summary: `callIV=${(bt.callIV * 100).toFixed(3)}% putIV=${(bt.putIV * 100).toFixed(3)}% skew=${(skewBt * 100).toFixed(3)}% DTE=${bt.dte}` }
    : { ok: false, reason: diffs.join(' | ') };
}

async function main() {
  const { symbol, snapshotDir } = parseArgs();
  const files = findSnapshotFiles(snapshotDir);
  if (files.length === 0) {
    console.error(`No snapshots found under ${snapshotDir}`);
    process.exit(2);
  }

  console.log(`Verifying IV parity for ${symbol} on ${files.length} snapshot(s)`);
  console.log(`Tolerance: ${TOLERANCE}\n`);

  let pass = 0, fail = 0, skipped = 0;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const chains = data.chains?.[symbol];
    if (!chains || chains.length === 0) {
      skipped++;
      continue;
    }

    // Use the snapshot's own timestamp as the "as-of" time so DTE math
    // reflects what the snapshot saw, not what wall-clock now would say.
    // Both backtest and live calculators accept this override.
    const asOf = data.timestamp ? new Date(data.timestamp) : new Date();
    const spot = estimateSpot(chains[0], asOf);
    if (!spot) { skipped++; continue; }

    const bt = runBacktest(chains, spot, asOf);
    const live = runLive(chains, spot, symbol, asOf);

    const cmp = compare(file, bt, live);
    const tag = path.relative(SNAPSHOT_ROOT, file);
    if (cmp.ok) {
      console.log(`✅ ${tag}  ${cmp.summary}`);
      pass++;
    } else {
      console.error(`❌ ${tag}  ${cmp.reason}`);
      fail++;
    }
  }

  console.log(`\nPass: ${pass}   Fail: ${fail}   Skipped: ${skipped}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Harness error:', err);
  process.exit(2);
});
