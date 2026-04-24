#!/usr/bin/env node
/**
 * Compare live (Schwab snapshot) vs backtest GEX walls and IV skew
 * for overlapping timestamps.
 *
 * For each Schwab snapshot:
 *   - Computes GEX walls using the fixed exposure-calculator (GEX magnitude)
 *   - Looks up backtest GEX at the same timestamp (15m JSON files)
 *   - Computes IV skew from the Schwab chain (live calculator)
 *   - Looks up backtest IV at the same timestamp (1m CSV)
 *   - Reports the diff
 *
 * Usage:
 *   node scripts/verify-live-vs-backtest.js [--date 2026-03-13] [--sample 10]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExposureCalculator from '../../signal-generator/src/tradier/exposure-calculator.js';
import { GexLoader } from '../src/data-loaders/gex-loader.js';
import { IVLoader } from '../src/data-loaders/iv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT_ROOT = path.join(DATA_DIR, 'schwab-snapshots');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { date: null, sample: 20 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) out.date = args[++i];
    if (args[i] === '--sample' && args[i + 1]) out.sample = parseInt(args[++i]);
  }
  return out;
}

function estimateSpot(chains) {
  // Use put-call parity at the shortest expiration
  const chain = chains[0];
  if (!chain?.options?.length) return null;
  const byStrike = new Map();
  for (const o of chain.options) {
    if (!o.strike || !o.bid || !o.ask || o.bid <= 0) continue;
    if (!byStrike.has(o.strike)) byStrike.set(o.strike, {});
    if (o.option_type === 'call') byStrike.get(o.strike).call = o;
    else byStrike.get(o.strike).put = o;
  }
  let best = null, bestDelta = Infinity;
  for (const [K, slot] of byStrike) {
    if (!slot.call || !slot.put) continue;
    const cMid = (slot.call.bid + slot.call.ask) / 2;
    const pMid = (slot.put.bid + slot.put.ask) / 2;
    const s = K + Math.exp(0.05 / 365) * (cMid - pMid);
    const delta = Math.abs(s - K);
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }
  return best;
}

function computeLiveGEX(chains, spotPrice) {
  const calc = new ExposureCalculator({ riskFreeRate: 0.05 });
  const results = calc.calculateExposures({ QQQ: chains }, { QQQ: spotPrice });
  return results.QQQ;
}

async function main() {
  const { calculateATMIVFromQuotes } = await import('../../shared/utils/black-scholes.js');

  const args = parseArgs();

  // Find available dates
  const dates = args.date
    ? [args.date]
    : fs.readdirSync(SNAPSHOT_ROOT).filter(d => d.startsWith('2026')).sort();

  // Load backtest GEX
  const gexLoader = new GexLoader(path.join(DATA_DIR, 'gex'), 'nq');
  const startDate = new Date(dates[0] + 'T00:00:00Z');
  const endDate = new Date(dates[dates.length - 1] + 'T23:59:59Z');
  await gexLoader.loadDateRange(startDate, endDate);

  // Load backtest IV
  const ivLoader = new IVLoader(DATA_DIR, { resolution: '1m' });
  await ivLoader.load();

  console.log(`\nLive (Schwab) vs Backtest Comparison`);
  console.log(`Dates: ${dates.join(', ')}`);
  console.log(`Backtest GEX snapshots: ${gexLoader.sortedTimestamps.length}`);
  console.log(`Backtest IV records: ${ivLoader.ivData?.length || 'loaded'}`);
  console.log(`Sampling every ${Math.ceil(975 / args.sample)}th snapshot (~${args.sample} total)\n`);

  console.log('Time (UTC)       | Spot  |  BT CallWall | Live CallWall |  BT PutWall | Live PutWall |  BT GFlip | Live GFlip | BT Skew  | Live Skew');
  console.log('─'.repeat(145));

  let totalSnapshots = 0;
  let compared = 0;
  const wallDiffs = [];

  for (const dateStr of dates) {
    const dir = path.join(SNAPSHOT_ROOT, dateStr);
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f.startsWith('snapshot_'))
      .sort();

    const step = Math.max(1, Math.ceil(files.length / (args.sample / dates.length)));

    for (let i = 0; i < files.length; i += step) {
      const file = files[i];
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const chains = data.chains?.QQQ;
      if (!chains?.length) continue;

      const asOf = new Date(data.timestamp);
      const spotPrice = estimateSpot(chains);
      if (!spotPrice) continue;

      totalSnapshots++;

      // Live GEX (from Schwab snapshot, using fixed logic)
      const liveGEX = computeLiveGEX(chains, spotPrice);
      if (!liveGEX) continue;

      // Backtest GEX at same timestamp
      const btGEX = gexLoader.getGexLevels(asOf);

      // Live IV skew (from Schwab snapshot)
      const flat = [];
      for (const chain of chains) {
        if (!chain?.options) continue;
        for (const o of chain.options) {
          if (!o?.strike || !o?.option_type || !o?.expiration_date) continue;
          flat.push({
            strike: o.strike,
            optionType: o.option_type === 'call' ? 'C' : 'P',
            expiration: new Date(o.expiration_date + 'T16:00:00-05:00'),
            bid: o.bid, ask: o.ask
          });
        }
      }
      const liveIV = calculateATMIVFromQuotes(flat, spotPrice, asOf, { minDTE: 7, maxDTE: 45, maxMoneyness: 0.02 });

      // Backtest IV at same timestamp
      const btIV = ivLoader.getIVAtTime(asOf.getTime());

      // NQ/QQQ multiplier for converting backtest NQ levels to QQQ space (or vice versa)
      const btSpot = btGEX?.futures_spot || btGEX?.nq_spot;
      const mult = btSpot && spotPrice ? btSpot / spotPrice : 41.3;

      const liveCallWall = liveGEX.levels?.callWall ? Math.round(liveGEX.levels.callWall * mult) : null;
      const livePutWall = liveGEX.levels?.putWall ? Math.round(liveGEX.levels.putWall * mult) : null;
      const liveGammaFlip = liveGEX.levels?.gammaFlip ? Math.round(liveGEX.levels.gammaFlip * mult) : null;

      const btCallWall = btGEX?.call_wall || null;
      const btPutWall = btGEX?.put_wall || null;
      const btGammaFlip = btGEX?.gamma_flip || null;

      const btSkew = btIV ? ((btIV.putIV || btIV.put_iv || 0) - (btIV.callIV || btIV.call_iv || 0)) : null;
      const liveSkew = liveIV ? (liveIV.putIV - liveIV.callIV) : null;

      const ts = asOf.toISOString().slice(0, 16);
      const fmt = (v) => v != null ? String(Math.round(v)).padStart(12) : '         n/a';
      const fmtS = (v) => v != null ? ((v * 100).toFixed(2) + '%').padStart(9) : '      n/a';

      console.log(
        `${ts} | ${spotPrice.toFixed(0).padStart(5)} | ${fmt(btCallWall)} | ${fmt(liveCallWall)} | ${fmt(btPutWall)} | ${fmt(livePutWall)} | ${fmt(btGammaFlip)} | ${fmt(liveGammaFlip)} | ${fmtS(btSkew)} | ${fmtS(liveSkew)}`
      );

      if (btCallWall && liveCallWall) {
        wallDiffs.push({
          callDiff: Math.abs(btCallWall - liveCallWall),
          putDiff: btPutWall && livePutWall ? Math.abs(btPutWall - livePutWall) : null,
          flipDiff: btGammaFlip && liveGammaFlip ? Math.abs(btGammaFlip - liveGammaFlip) : null,
          skewDiff: btSkew != null && liveSkew != null ? Math.abs(btSkew - liveSkew) : null
        });
      }
      compared++;
    }
  }

  if (wallDiffs.length > 0) {
    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const callDiffs = wallDiffs.map(d => d.callDiff);
    const putDiffs = wallDiffs.filter(d => d.putDiff != null).map(d => d.putDiff);
    const flipDiffs = wallDiffs.filter(d => d.flipDiff != null).map(d => d.flipDiff);
    const skewDiffs = wallDiffs.filter(d => d.skewDiff != null).map(d => d.skewDiff);

    console.log(`\n═══ SUMMARY (${compared} snapshots compared) ═══`);
    console.log(`Mean |Call Wall diff|:   ${avg(callDiffs).toFixed(0)} NQ pts`);
    if (putDiffs.length) console.log(`Mean |Put Wall diff|:    ${avg(putDiffs).toFixed(0)} NQ pts`);
    if (flipDiffs.length) console.log(`Mean |Gamma Flip diff|:  ${avg(flipDiffs).toFixed(0)} NQ pts`);
    if (skewDiffs.length) console.log(`Mean |IV Skew diff|:     ${(avg(skewDiffs) * 100).toFixed(3)}%`);
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
