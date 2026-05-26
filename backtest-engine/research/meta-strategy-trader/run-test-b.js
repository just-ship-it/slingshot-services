#!/usr/bin/env node
/**
 * Test B: live-honest FCFS baseline.
 * Run all 4 strategies through the meta-engine with FCFS rule + single shared
 * 1-NQ slot. This number REPLACES the $614,730 JSON-only baseline since it's
 * computed from the live-honest signal stream (captured with cooldowns
 * disabled, includes signals that would have fired in rejection windows).
 *
 * This is the number Phase 2's AI ruleset must beat.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SecondDataProvider } from '../../src/data/csv-loader.js';
import { MetaEngine, FCFS_RULE, DEFAULT_COOLDOWNS } from './meta-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SIGNALS_DIR = path.join(ROOT, 'research/meta-strategy-trader/output/signals');
const STRATS = ['lstb', 'gfi', 'glx', 'glf'];

// Allow swapping signal files via --signal-set <suffix>. Default matches the
// initial 1-month research window. For the 6-month run use --signal-set jan13-jul13.
const argv = process.argv.slice(2);
const SIGNAL_SET = argv.includes('--signal-set') ? argv[argv.indexOf('--signal-set') + 1] : 'jan13-feb13';

function fmtUsd(n) {
  if (!Number.isFinite(n)) return String(n);
  const s = Math.round(Math.abs(n)).toLocaleString();
  return n < 0 ? `-$${s}` : `$${s}`;
}

async function main() {
  console.log('Loading signal streams...');
  const allSignals = [];
  const perStratCount = {};
  for (const k of STRATS) {
    const j = JSON.parse(fs.readFileSync(path.join(SIGNALS_DIR, `${k}-${SIGNAL_SET}.json`), 'utf8'));
    perStratCount[k] = j.signals.length;
    allSignals.push(...j.signals);
  }
  console.log(`Signal set: ${SIGNAL_SET}`);
  console.log(`Loaded signals: ${JSON.stringify(perStratCount)} total=${allSignals.length}`);

  console.log('Loading 1s OHLCV index...');
  const sdp = new SecondDataProvider(path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv'));
  await sdp.initialize();

  // EOD config: for the FCFS portfolio we go with 15:45 ET (production setting
  // per memory production-eod-cutoff). Different strategies' gold standards
  // used different cutoffs; for the portfolio we standardize to live-honest.
  const engine = new MetaEngine({
    signals: allSignals,
    secondDataProvider: sdp,
    metaRule: FCFS_RULE,
    cooldownConfig: DEFAULT_COOLDOWNS,
    enabledStrategies: null,  // null = all enabled
    eodCutoffEt: '15:45',
    marketCloseEt: null,      // 15:45 EOD comes first, no need for market close
    commission: 5,
    contractFilter: null,   // null lets the engine handle multi-contract data via per-position contract matching (needed across rollovers)
    verbose: true,
  });

  console.log('Running 4-strategy FCFS portfolio simulation...');
  const t0 = Date.now();
  const result = await engine.run();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const s = result.summary;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Test B: 4-Strategy FCFS Baseline (Jan 13 – Feb 13, 2025)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Period:        Jan 13 – Feb 13 2025 (~22 trading sessions)`);
  console.log(`  Total signals: ${allSignals.length}`);
  console.log(`  Slot:          single 1-NQ, FCFS (first signal accepted)`);
  console.log(`  EOD cutoff:    15:45 ET (live-honest)`);
  console.log();
  console.log(`  Trades:        ${s.totalTrades}`);
  console.log(`  Win rate:      ${s.winRate.toFixed(1)}%`);
  console.log(`  Total PnL:     ${fmtUsd(s.totalPnL)}`);
  console.log(`  Profit factor: ${s.profitFactor.toFixed(2)}`);
  console.log(`  Sharpe:        ${s.sharpe.toFixed(2)}`);
  console.log(`  Max DD:        ${fmtUsd(s.maxDD_usd)} (${s.maxDD_pct.toFixed(2)}%)`);
  console.log(`  Run time:      ${dt}s`);
  console.log();
  console.log('  Per-strategy contribution:');
  for (const [strat, info] of Object.entries(s.byStrategy)) {
    console.log(`    ${strat.padEnd(24)}  trades=${String(info.trades).padStart(4)}  pnl=${fmtUsd(info.pnl).padStart(10)}`);
  }
  console.log();
  console.log('  Rejection breakdown:');
  const rejReasons = {};
  for (const r of result.rejections) rejReasons[r.reason] = (rejReasons[r.reason] || 0) + 1;
  for (const [reason, count] of Object.entries(rejReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(28)} ${count}`);
  }
  console.log();

  // Write trades to JSON for downstream use (e.g., AI packet building, debug).
  const outPath = path.join(ROOT, `research/meta-strategy-trader/output/test-b-fcfs-baseline-${SIGNAL_SET}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    period: 'jan13-feb13-2025',
    rule: 'fcfs',
    summary: s,
    trades: result.trades,
    rejections: result.rejections,
  }, null, 2));
  console.log(`  Wrote: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
