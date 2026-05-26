#!/usr/bin/env node
/**
 * Test A: solo reproduction.
 * Run the meta-engine with one strategy enabled + FCFS rule + that strategy's
 * original cooldown re-applied. Compare the produced trade set against the
 * strategy's gold-standard JSON (filtered to the same date window).
 *
 * If they don't match, the meta-engine has a fill / cooldown / EOD bug.
 *
 * Usage:
 *   node research/meta-strategy-trader/run-test-a.js lstb
 *   node research/meta-strategy-trader/run-test-a.js gfi
 *   node research/meta-strategy-trader/run-test-a.js glx
 *   node research/meta-strategy-trader/run-test-a.js glf
 *   node research/meta-strategy-trader/run-test-a.js all
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SecondDataProvider } from '../../src/data/csv-loader.js';
import { MetaEngine, FCFS_RULE, DEFAULT_COOLDOWNS } from './meta-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// EOD configs MUST match the original gold-standard runs for Test A to
// reproduce trades exactly. Values pulled from STRATEGY-GOLD-STANDARDS.md.
const STRATEGIES = {
  lstb: {
    name: 'ls-flip-trigger-bar',
    signalsFile: 'research/meta-strategy-trader/output/signals/lstb-jan13-feb13.json',
    goldStandard: 'data/gold-standard/ls-flip-trigger-bar-v3.json',
    eodCutoffEt: '15:45',
    marketCloseEt: null,   // lstb gold uses ONLY eod-cutoff, no market close
  },
  gfi: {
    name: 'gex-flip-ivpct',
    signalsFile: 'research/meta-strategy-trader/output/signals/gfi-jan13-feb13.json',
    goldStandard: 'data/gold-standard/gex-flip-ivpct-v2.json',
    eodCutoffEt: '16:40',
    marketCloseEt: '15:55', // engine default; fires before 16:40
  },
  glx: {
    name: 'gex-lt-3m-crossover',
    signalsFile: 'research/meta-strategy-trader/output/signals/glx-jan13-feb13.json',
    goldStandard: 'data/gold-standard/gex-lt-3m-crossover-v3.json',
    eodCutoffEt: '16:40',
    marketCloseEt: '15:55',
  },
  glf: {
    name: 'gex-level-fade',
    signalsFile: 'research/meta-strategy-trader/output/signals/glf-jan13-feb13.json',
    goldStandard: 'data/gold-standard/gex-level-fade-v2.json',
    eodCutoffEt: '16:40',
    marketCloseEt: '15:55',
  },
};

const ONE_SEC_CSV = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv');

function fmtUsd(n) {
  if (!Number.isFinite(n)) return String(n);
  const s = Math.round(n).toLocaleString();
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}

async function runOne(stratKey, sdp, windowStart, windowEnd) {
  const def = STRATEGIES[stratKey];
  if (!def) throw new Error(`Unknown strategy key: ${stratKey}`);

  const signalsPath = path.join(ROOT, def.signalsFile);
  const signalJson = JSON.parse(fs.readFileSync(signalsPath, 'utf8'));
  const signals = signalJson.signals;

  console.log(`\n═══ ${def.name} ═══`);
  console.log(`  captured signals: ${signals.length}`);
  console.log(`  window: ${signalJson.startDate} → ${signalJson.endDate}`);

  // Filter gold-standard trades to the same window for comparison.
  const goldPath = path.join(ROOT, def.goldStandard);
  const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  const goldInWindow = gold.trades.filter(t =>
    t.status === 'completed' &&
    t.entryTime >= windowStart &&
    t.entryTime < windowEnd
  );
  const goldPnL = goldInWindow.reduce((s, t) => s + t.netPnL, 0);
  console.log(`  gold-in-window trades: ${goldInWindow.length}  pnl: ${fmtUsd(goldPnL)}`);

  const engine = new MetaEngine({
    signals,
    secondDataProvider: sdp,
    metaRule: FCFS_RULE,
    cooldownConfig: DEFAULT_COOLDOWNS,
    enabledStrategies: [def.name],
    eodCutoffEt: def.eodCutoffEt,
    marketCloseEt: def.marketCloseEt,
    commission: 5,
    contractFilter: 'NQH5', // Jan 13 - Feb 13 2025 is solidly NQH5
    verbose: false,
  });

  const t0 = Date.now();
  const result = await engine.run();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const s = result.summary;
  console.log(`  meta-engine: ${s.totalTrades} trades  pnl: ${fmtUsd(s.totalPnL)}  WR ${s.winRate.toFixed(1)}%  PF ${s.profitFactor.toFixed(2)}  DD ${fmtUsd(s.maxDD_usd)}  (${dt}s)`);

  // Diff
  const diffPnL = s.totalPnL - goldPnL;
  const diffTrades = s.totalTrades - goldInWindow.length;
  const matchPct = goldPnL ? ((s.totalPnL / goldPnL) * 100).toFixed(1) : 'n/a';
  console.log(`  Δ vs gold:   trades ${diffTrades >= 0 ? '+' : ''}${diffTrades}  pnl ${fmtUsd(diffPnL)}  (${matchPct}% of gold)`);

  // Reason breakdown for rejected signals
  const rejReasons = {};
  for (const r of result.rejections) rejReasons[r.reason] = (rejReasons[r.reason] || 0) + 1;
  console.log(`  rejections by reason:`, rejReasons);

  return { key: stratKey, name: def.name, result, gold: { trades: goldInWindow.length, pnl: goldPnL } };
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argv[0] || 'all';
  const keys = target === 'all' ? Object.keys(STRATEGIES) : [target];

  console.log('Loading 1s OHLCV index ...');
  const sdp = new SecondDataProvider(ONE_SEC_CSV);
  await sdp.initialize();

  // Window: Jan 13 - Feb 13 2025 (matches capture window)
  const windowStart = new Date('2025-01-13T00:00:00Z').getTime();
  const windowEnd   = new Date('2025-02-13T23:59:59Z').getTime();

  const results = [];
  for (const k of keys) {
    results.push(await runOne(k, sdp, windowStart, windowEnd));
  }

  console.log('\n═══ Summary ═══');
  for (const r of results) {
    const matchPct = r.gold.pnl ? ((r.result.summary.totalPnL / r.gold.pnl) * 100).toFixed(1) : 'n/a';
    console.log(`  ${r.name.padEnd(24)} trades ${r.result.summary.totalTrades}/${r.gold.trades}  pnl ${fmtUsd(r.result.summary.totalPnL)}/${fmtUsd(r.gold.pnl)}  match ${matchPct}%`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
