#!/usr/bin/env node
/**
 * Detailed per-trade diff for one strategy: align meta-engine output against
 * gold-standard trades by entry time and report exact divergences.
 *
 * Usage: node research/meta-strategy-trader/debug-strategy.js gfi
 *        node research/meta-strategy-trader/debug-strategy.js glx
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SecondDataProvider } from '../../src/data/csv-loader.js';
import { MetaEngine, FCFS_RULE, DEFAULT_COOLDOWNS } from './meta-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const STRATEGIES = {
  lstb: { name: 'ls-flip-trigger-bar', signalsFile: 'research/meta-strategy-trader/output/signals/lstb-jan13-feb13.json', goldStandard: 'data/gold-standard/ls-flip-trigger-bar-v3.json', eodCutoffEt: '15:45', marketCloseEt: null },
  gfi:  { name: 'gex-flip-ivpct',      signalsFile: 'research/meta-strategy-trader/output/signals/gfi-jan13-feb13.json',  goldStandard: 'data/gold-standard/gex-flip-ivpct-v2.json', eodCutoffEt: '16:40', marketCloseEt: '15:55' },
  glx:  { name: 'gex-lt-3m-crossover', signalsFile: 'research/meta-strategy-trader/output/signals/glx-jan13-feb13.json',  goldStandard: 'data/gold-standard/gex-lt-3m-crossover-v3.json', eodCutoffEt: '16:40', marketCloseEt: '15:55' },
  glf:  { name: 'gex-level-fade',      signalsFile: 'research/meta-strategy-trader/output/signals/glf-jan13-feb13.json',  goldStandard: 'data/gold-standard/gex-level-fade-v2.json', eodCutoffEt: '16:40', marketCloseEt: '15:55' },
};

const fmt = (n, pad=8) => (Number.isFinite(n) ? n.toFixed(2).padStart(pad) : 'n/a'.padStart(pad));
const fmtDt = (ts) => new Date(ts).toISOString().slice(0,19).replace('T',' ');

async function main() {
  const key = process.argv[2];
  const def = STRATEGIES[key];
  if (!def) { console.error('usage: debug-strategy.js [lstb|gfi|glx|glf]'); process.exit(1); }

  const sdp = new SecondDataProvider(path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv'));
  await sdp.initialize();

  const signals = JSON.parse(fs.readFileSync(path.join(ROOT, def.signalsFile), 'utf8')).signals;
  const engine = new MetaEngine({
    signals, secondDataProvider: sdp, metaRule: FCFS_RULE, cooldownConfig: DEFAULT_COOLDOWNS,
    enabledStrategies: [def.name], eodCutoffEt: def.eodCutoffEt, marketCloseEt: def.marketCloseEt,
    commission: 5, contractFilter: 'NQH5',
  });
  const result = await engine.run();

  const gold = JSON.parse(fs.readFileSync(path.join(ROOT, def.goldStandard), 'utf8'));
  const start = new Date('2025-01-13T00:00:00Z').getTime();
  const end = new Date('2025-02-13T23:59:59Z').getTime();
  const goldIn = gold.trades
    .filter(t => t.status === 'completed' && t.entryTime >= start && t.entryTime < end)
    .sort((a,b) => a.entryTime - b.entryTime);
  const meta = [...result.trades].sort((a,b) => a.entryTs - b.entryTs);

  console.log(`\n${def.name}  gold=${goldIn.length}  meta=${meta.length}`);
  console.log(`  PnL gold=$${goldIn.reduce((s,t)=>s+t.netPnL,0).toFixed(0)}  meta=$${meta.reduce((s,t)=>s+t.netPnL,0).toFixed(0)}`);

  // Greedy match each meta trade to closest unmatched gold trade by entry ts.
  // Then list any unmatched gold or meta trades.
  const used = new Set();
  const pairs = [];
  for (const m of meta) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < goldIn.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(goldIn[i].entryTime - m.entryTs);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD <= 30 * 60_000) { used.add(best); pairs.push({ meta: m, gold: goldIn[best], dtMs: m.entryTs - goldIn[best].entryTime }); }
    else                                    { pairs.push({ meta: m, gold: null, dtMs: null }); }
  }
  const unmatchedGold = goldIn.filter((_, i) => !used.has(i));

  console.log('\nMATCHED PAIRS (sorted by gold entry):');
  console.log('  GOLD entry            side  e      ex     reason         pnl   | META entry            side  e      ex     reason         pnl   | dt(s)  dPnL');
  const sorted = pairs.filter(p => p.gold).sort((a,b) => a.gold.entryTime - b.gold.entryTime);
  let totalDpnl = 0;
  for (const p of sorted) {
    const g = p.gold, m = p.meta;
    const dpnl = m.netPnL - g.netPnL;
    totalDpnl += dpnl;
    const flag = Math.abs(dpnl) > 100 ? ' ⚠' : '';
    console.log(`  ${fmtDt(g.entryTime)}  ${g.side.padEnd(5)} ${fmt(g.actualEntry)} ${fmt(g.actualExit)} ${g.exitReason.padEnd(14)} ${fmt(g.netPnL,7)} | ${fmtDt(m.entryTs)}  ${m.side.padEnd(5)} ${fmt(m.entryPrice)} ${fmt(m.exitPrice)} ${m.exitReason.padEnd(14)} ${fmt(m.netPnL,7)} | ${String(p.dtMs/1000).padStart(5)}  ${fmt(dpnl,7)}${flag}`);
  }
  console.log(`  TOTAL Δ on matched pairs: $${totalDpnl.toFixed(0)}`);

  if (unmatchedGold.length) {
    console.log(`\nUNMATCHED GOLD TRADES (${unmatchedGold.length}, missing $${unmatchedGold.reduce((s,t)=>s+t.netPnL,0).toFixed(0)}):`);
    for (const g of unmatchedGold) {
      console.log(`  ${fmtDt(g.entryTime)}  ${g.side.padEnd(5)} e=${g.actualEntry}  ex=${g.actualExit}  reason=${g.exitReason}  pnl=${g.netPnL}`);
    }
  }
  const unmatchedMeta = pairs.filter(p => !p.gold).map(p => p.meta);
  if (unmatchedMeta.length) {
    console.log(`\nUNMATCHED META TRADES (${unmatchedMeta.length}, extra $${unmatchedMeta.reduce((s,t)=>s+t.netPnL,0).toFixed(0)}):`);
    for (const m of unmatchedMeta) {
      console.log(`  ${fmtDt(m.entryTs)}  ${m.side.padEnd(5)} e=${m.entryPrice}  ex=${m.exitPrice}  reason=${m.exitReason}  pnl=${m.netPnL}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
